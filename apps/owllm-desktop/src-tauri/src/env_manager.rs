// env_manager — declarative Python-environment profiles for the fine-
// tuning pages. Replaces the legacy "pip-install-into-the-bundled-
// python-and-hope" approach with explicit per-scenario manifests,
// atomic installs, manifest-hash drift detection, and a verification
// probe that fails fast with an actionable error.
//
// LIFECYCLE
//
//   1. App boot reads `LLM/profiles/env_profiles.yaml` (bundled
//      fallback) OR fetches the same file from GitHub Raw (preferred,
//      cached 24 h). One YAML, one profile per dict entry.
//   2. The React UI calls `env_profiles_list()` to render available
//      envs + `env_profile_status(name)` to render per-profile state
//      ("not installed" / "installing" / "ready" / "stale" / "broken").
//   3. When the user picks a profile to install, the React UI opens a
//      Channel and calls `env_profile_install(name, channel)`. We:
//        a. Create a fresh venv under LLM/.envs/<name>.tmp.<rand>/.
//        b. pip-install each package, streaming pip stdout/stderr on
//           the channel as InstallEvent::Log lines.
//        c. Write the manifest hash to <venv>/.owllm_manifest.sha256.
//        d. Run the probe script — if it exits non-zero, delete the
//           tmp dir and emit InstallEvent::Failed with the probe
//           output. Atomic: a failed install leaves no venv behind.
//        e. Rename the tmp dir to its final name + emit Finished.
//   4. Subsequent calls to env_profile_status verify the manifest
//      hash AND re-run the probe (the probe is cheap; pip's wheel
//      state can drift if the user upgrades the bundled Python).
//
// This module ONLY shapes the schema + status checks for now. The
// actual install + probe + GitHub fetch are stubs that return
// "not installed" — wiring them up is the next slice. Shipping the
// schema first lets the React UI and the train spawn talk to it.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// One package entry inside a profile. Either a plain `package==X.Y`
/// or a package routed through a custom wheel index (e.g. PyTorch
/// CUDA wheels live on pytorch.org, not PyPI).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PackageSpec {
    pub name: String,
    pub version: String,
    /// Optional --index-url override for this single package. None →
    /// use PyPI. Set to "https://download.pytorch.org/whl/cu121" for
    /// the CUDA-12.1 wheel build of torch.
    #[serde(default)]
    pub index_url: Option<String>,
}

/// One declarative environment profile. Lives in env_profiles.yaml
/// as a top-level dict entry keyed by `name`.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct EnvProfile {
    /// Unique slug. Used as the venv folder name.
    pub name: String,
    /// Human-readable label for the UI ("Gemma fine-tuning · CUDA 12.1").
    pub display: String,
    /// One-line description shown under the label.
    #[serde(default)]
    pub description: String,
    /// Python version to install the venv on top of. The bundled
    /// runtime currently provides 3.11 only; later we can add 3.10
    /// / 3.12 alongside it.
    pub python: String,
    /// Pinned packages, in install order. We DO respect order so the
    /// torch index-url install happens before transformers (which
    /// would otherwise pull a CPU torch as a transitive dep).
    pub packages: Vec<PackageSpec>,
    /// Short Python snippet executed after install to verify the env
    /// is working. Must `print("OK")` on success, anything else on
    /// failure. The probe stdout is captured and shown verbatim to
    /// the user when it fails — write helpful error messages here.
    pub probe: String,
}

/// State of one profile on the user's machine. Returned by
/// env_profile_status(). The React UI maps this to a coloured pill.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EnvProfileState {
    /// No venv exists for this profile. Show "Install" button.
    NotInstalled,
    /// Install is in progress. The UI keeps the Channel open to read
    /// streaming progress. (Currently we don't track concurrent
    /// installs at the Rust level — the UI is responsible.)
    Installing,
    /// venv exists, manifest hash matches, probe passed. Green pill.
    Ready { python_exe: String },
    /// venv exists but the manifest hash on disk differs from the
    /// current profile's hash → user upgraded the profile and the
    /// installed packages are now stale. Show "Reinstall" button.
    Stale {
        python_exe: String,
        installed_hash: String,
        current_hash: String,
    },
    /// venv exists, hash matches, but the probe failed. Something
    /// rotted (DLL missing, CUDA driver downgraded, etc.). Show
    /// "Repair" button + the probe error so the user knows why.
    Broken { python_exe: String, probe_error: String },
}

/// Best-effort SHA-256 of a profile's authoritative content. Used
/// to detect drift between "what's installed" and "what the manifest
/// currently says". We hash the serialized packages list — the probe
/// + display fields don't affect the actual environment.
fn profile_hash(p: &EnvProfile) -> String {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    h.update(p.name.as_bytes());
    h.update(p.python.as_bytes());
    for pkg in &p.packages {
        h.update(pkg.name.as_bytes());
        h.update(b"\0");
        h.update(pkg.version.as_bytes());
        h.update(b"\0");
        if let Some(idx) = &pkg.index_url {
            h.update(idx.as_bytes());
        }
        h.update(b"\n");
    }
    format!("{:x}", h.finalize())
}

/// Resolve `env_profiles.yaml`. Looks in the shippable resources tree
/// first (apps/owllm-desktop/resources/profiles/env_profiles.yaml) and
/// falls back to the legacy LLM/profiles/ location.
fn local_profiles_path() -> Option<PathBuf> {
    crate::paths::profiles_dir().map(|d| d.join("env_profiles.yaml"))
}

/// Where venvs live. Phase 3 puts new installs under
/// `<runtime_cache_root>/envs/<profile-name>/`; legacy LLM/.envs/ is
/// still recognised so users coming from the Python app find their
/// envs in the same place.
fn envs_root() -> Option<PathBuf> {
    // Prefer the legacy LLM/.envs/ when it already has populated
    // profiles — otherwise new installs go straight into the
    // %LOCALAPPDATA% tree.
    if let Some(r) = crate::paths::llm_root() {
        let legacy = r.join(".envs");
        if legacy.is_dir() {
            // Has the user installed any profile here? If yes, keep
            // using it so we don't strand existing venvs.
            if let Ok(read) = std::fs::read_dir(&legacy) {
                if read.flatten().any(|e| e.path().is_dir()) {
                    return Some(legacy);
                }
            }
        }
    }
    if let Some(rt) = crate::paths::runtime_cache_root() {
        return Some(rt.join("envs"));
    }
    crate::paths::llm_root().map(|r| r.join(".envs"))
}

/// Read + parse the manifest file. Returns an empty Vec when the
/// file doesn't exist yet (fresh install) so the UI shows an empty
/// list rather than an error.
fn read_profiles_yaml() -> Result<Vec<EnvProfile>, String> {
    let path = match local_profiles_path() {
        Some(p) => p,
        None => return Ok(Vec::new()),
    };
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let txt = std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let profiles: Vec<EnvProfile> = serde_yaml::from_str(&txt)
        .map_err(|e| format!("parse {}: {e}", path.display()))?;
    Ok(profiles)
}

/// List every env profile the app knows about. The React UI calls
/// this on the TrainPage / Train modal to populate the "which env
/// to use" dropdown.
#[tauri::command]
pub async fn env_profiles_list() -> Result<Vec<EnvProfile>, String> {
    tokio::task::spawn_blocking(read_profiles_yaml)
        .await
        .map_err(|e| format!("join error: {e}"))?
}

/// Per-profile install state. The python_exe in the Ready / Stale /
/// Broken variants is the path the train spawner uses when launching
/// finetune.py.
#[tauri::command]
pub async fn env_profile_status(name: String) -> Result<EnvProfileState, String> {
    tokio::task::spawn_blocking(move || -> Result<EnvProfileState, String> {
        let profiles = read_profiles_yaml()?;
        let profile = profiles
            .iter()
            .find(|p| p.name == name)
            .ok_or_else(|| format!("no env profile named {name}"))?;
        let venv = match envs_root() {
            Some(r) => r.join(&profile.name),
            None => return Ok(EnvProfileState::NotInstalled),
        };
        let python_exe = if cfg!(windows) {
            venv.join("Scripts").join("python.exe")
        } else {
            venv.join("bin").join("python")
        };
        if !python_exe.is_file() {
            return Ok(EnvProfileState::NotInstalled);
        }
        let hash_file = venv.join(".owllm_manifest.sha256");
        let current_hash = profile_hash(profile);
        let installed_hash = std::fs::read_to_string(&hash_file)
            .unwrap_or_default()
            .trim()
            .to_string();
        if installed_hash != current_hash {
            return Ok(EnvProfileState::Stale {
                python_exe: python_exe.to_string_lossy().into_owned(),
                installed_hash,
                current_hash,
            });
        }
        // Probe scripts are the next slice — for now if the hash
        // matches we trust the install. Wiring the probe through is
        // a one-liner once the install command exists, because the
        // install path already runs the probe and stamps the hash.
        Ok(EnvProfileState::Ready {
            python_exe: python_exe.to_string_lossy().into_owned(),
        })
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Streaming progress event emitted while a profile installs. The
/// React UI wires a Tauri Channel and renders a live log + progress
/// indicator. (Skeleton — actual venv + pip wiring is the next slice.)
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InstallEvent {
    Started { profile: String, hash: String },
    Step { label: String },
    Log { stream: String, line: String },
    Finished { python_exe: String },
    Failed { error: String },
}

/// Install (or reinstall) a profile. Atomic: writes into a temp dir
/// first, swaps on success. A failed install leaves no half-broken
/// venv behind.
///
/// Pipeline:
///   1. Resolve bundled python.exe (the SOURCE python for the venv).
///   2. Create venv in `<envs_root>/<name>.tmp.<rand>/` via
///      `<python> -m venv <tmp>` — captures stderr for diagnostics.
///   3. For each package: `<tmp_venv_python> -m pip install
///      "<name>==<version>"` (+ optional --index-url). pip stdout/
///      stderr is line-buffered and re-emitted as InstallEvent::Log.
///   4. Run the probe script via `<tmp_venv_python> -c <probe>`.
///      The probe MUST print "OK" — otherwise its stdout is shown
///      to the user verbatim as the failure reason.
///   5. Write the manifest hash file + atomically rename
///      `<tmp>/` → `<envs_root>/<name>/`.
///   6. On ANY failure: rm the tmp dir + emit Failed with detail.
#[tauri::command]
pub async fn env_profile_install(
    name: String,
    channel: tauri::ipc::Channel<InstallEvent>,
) -> Result<(), String> {
    let profile = {
        let profiles = tokio::task::spawn_blocking(read_profiles_yaml)
            .await
            .map_err(|e| format!("join error: {e}"))??;
        profiles
            .into_iter()
            .find(|p| p.name == name)
            .ok_or_else(|| format!("no env profile named {name}"))?
    };
    let hash = profile_hash(&profile);
    let _ = channel.send(InstallEvent::Started {
        profile: profile.name.clone(),
        hash: hash.clone(),
    });

    let outcome = run_install(&profile, &hash, &channel).await;
    match outcome {
        Ok(python_exe) => {
            let _ = channel.send(InstallEvent::Finished {
                python_exe: python_exe.clone(),
            });
            Ok(())
        }
        Err(error) => {
            let _ = channel.send(InstallEvent::Failed { error: error.clone() });
            Err(error)
        }
    }
}

/// Core install logic. Returns the final python.exe path on success
/// (after the atomic rename). Held in its own helper so `?` can
/// short-circuit on any step without losing the channel-emit pattern.
async fn run_install(
    profile: &EnvProfile,
    hash: &str,
    channel: &tauri::ipc::Channel<InstallEvent>,
) -> Result<String, String> {
    // 1) Find the bundled Python.
    let bundled = crate::paths::bundled_python_exe()
        .ok_or_else(|| "bundled Python not found (expected LLM/python_runtime/python3.11/python.exe). Run the installer to bootstrap the runtime.".to_string())?;
    let envs_dir = envs_root().ok_or_else(|| "LLM/ root not found".to_string())?;
    std::fs::create_dir_all(&envs_dir).map_err(|e| format!("mkdir envs root: {e}"))?;
    let final_dir = envs_dir.join(&profile.name);
    let tmp_dir = envs_dir.join(format!("{}.tmp.{}", profile.name, std::process::id()));
    // If a previous attempt left a stale tmp dir, sweep it first.
    if tmp_dir.exists() {
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }
    // 2) Create the venv.
    let _ = channel.send(InstallEvent::Step {
        label: format!("Creating venv at {}", tmp_dir.display()),
    });
    run_subprocess(
        channel,
        &bundled,
        &[
            "-m".to_string(),
            "venv".to_string(),
            tmp_dir.to_string_lossy().into_owned(),
        ],
        None,
    )
    .await
    .map_err(|e| {
        // Tmp dir may be partially created — clean up so the next
        // attempt starts from scratch.
        let _ = std::fs::remove_dir_all(&tmp_dir);
        format!("venv creation failed: {e}")
    })?;

    let venv_python = if cfg!(windows) {
        tmp_dir.join("Scripts").join("python.exe")
    } else {
        tmp_dir.join("bin").join("python")
    };
    if !venv_python.is_file() {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err(format!(
            "venv Python missing after `-m venv` — expected {}",
            venv_python.display()
        ));
    }

    // 3) Upgrade pip first — old pip versions choke on modern wheels
    //    (especially the PyTorch +cu wheels). One-time cost; small.
    let _ = channel.send(InstallEvent::Step {
        label: "Upgrading pip / setuptools / wheel".to_string(),
    });
    run_subprocess(
        channel,
        &venv_python,
        &[
            "-m".into(),
            "pip".into(),
            "install".into(),
            "--upgrade".into(),
            "--disable-pip-version-check".into(),
            "pip".into(),
            "setuptools".into(),
            "wheel".into(),
        ],
        None,
    )
    .await
    .map_err(|e| {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        format!("pip self-upgrade failed: {e}")
    })?;

    // 4) Install every package, in declared order. We pass --no-deps
    //    OFF deliberately — transitive resolution is what makes the
    //    profile usable. Each package install is its own subprocess
    //    so failure messages stay attributed to the right package.
    for pkg in &profile.packages {
        let spec = format!("{}=={}", pkg.name, pkg.version);
        let _ = channel.send(InstallEvent::Step {
            label: format!("Installing {spec}{}",
                pkg.index_url.as_ref().map(|u| format!(" (index {u})")).unwrap_or_default()),
        });
        let mut args: Vec<String> = vec![
            "-m".into(),
            "pip".into(),
            "install".into(),
            "--disable-pip-version-check".into(),
            "--no-input".into(),
        ];
        if let Some(idx) = &pkg.index_url {
            args.push("--index-url".into());
            args.push(idx.clone());
        }
        args.push(spec.clone());
        run_subprocess(channel, &venv_python, &args, None)
            .await
            .map_err(|e| {
                let _ = std::fs::remove_dir_all(&tmp_dir);
                format!("pip install {spec} failed: {e}")
            })?;
    }

    // 5) Probe — must print "OK" on the last line. The probe script
    //    is passed via -c so we don't have to materialise a temp .py
    //    file.
    let _ = channel.send(InstallEvent::Step {
        label: "Running verification probe".to_string(),
    });
    let probe_output = run_subprocess_capture(&venv_python, &["-c".into(), profile.probe.clone()])
        .await
        .map_err(|e| {
            let _ = std::fs::remove_dir_all(&tmp_dir);
            format!("probe spawn failed: {e}")
        })?;
    // Stream the probe stdout to the user even on success — gives them
    // visibility of `torch X · transformers Y · cuda Z`.
    for line in probe_output.stdout.lines() {
        let _ = channel.send(InstallEvent::Log {
            stream: "probe".into(),
            line: line.to_string(),
        });
    }
    for line in probe_output.stderr.lines() {
        let _ = channel.send(InstallEvent::Log {
            stream: "probe-err".into(),
            line: line.to_string(),
        });
    }
    if !probe_output.success || !probe_output.stdout.contains("OK") {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err(format!(
            "probe failed (exit {}). stderr: {}",
            probe_output.code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
            probe_output.stderr.lines().last().unwrap_or("(empty)")
        ));
    }

    // 6) Stamp the manifest hash + atomically swap tmp → final.
    std::fs::write(tmp_dir.join(".owllm_manifest.sha256"), hash)
        .map_err(|e| format!("write hash: {e}"))?;
    if final_dir.exists() {
        // Reinstall path — replace the previous env. Move the old one
        // aside so the swap is still atomic if rename fails.
        let stash = envs_dir.join(format!("{}.old.{}", profile.name, std::process::id()));
        if let Err(e) = std::fs::rename(&final_dir, &stash) {
            let _ = std::fs::remove_dir_all(&tmp_dir);
            return Err(format!("could not move existing env aside: {e}"));
        }
        let _ = std::fs::remove_dir_all(&stash);
    }
    std::fs::rename(&tmp_dir, &final_dir)
        .map_err(|e| format!("atomic rename failed: {e}"))?;
    let final_python = if cfg!(windows) {
        final_dir.join("Scripts").join("python.exe")
    } else {
        final_dir.join("bin").join("python")
    };
    Ok(final_python.to_string_lossy().into_owned())
}

/// Captured output of a subprocess. Used by the probe runner so the
/// caller can inspect stdout + stderr after the process exits.
struct CapturedOutput {
    success: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Spawn a subprocess and capture stdout/stderr to strings. No
/// streaming — for the probe we want the FULL output as a chunk so
/// we can grep for "OK" and surface the error message verbatim.
async fn run_subprocess_capture(
    exe: &std::path::Path,
    args: &[String],
) -> Result<CapturedOutput, String> {
    use tokio::process::Command;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut cmd = Command::new(exe);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().await.map_err(|e| format!("spawn: {e}"))?;
    Ok(CapturedOutput {
        success: output.status.success(),
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// Spawn a subprocess + stream its stdout AND stderr line-by-line
/// as InstallEvent::Log messages on the channel. Returns Ok on
/// exit-0, Err on any non-zero exit code (carrying the captured
/// stderr tail). Used for `pip install` so the user sees every wheel
/// download + extraction line live, not a wall of text at the end.
async fn run_subprocess(
    channel: &tauri::ipc::Channel<InstallEvent>,
    exe: &std::path::Path,
    args: &[String],
    cwd: Option<&std::path::Path>,
) -> Result<(), String> {
    use tokio::io::AsyncBufReadExt;
    use tokio::process::Command;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("spawn: {e}"))?;
    let stdout = child.stdout.take().ok_or_else(|| "no stdout".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "no stderr".to_string())?;
    let ch_out = channel.clone();
    let ch_err = channel.clone();
    let out_task = tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = ch_out.send(InstallEvent::Log {
                stream: "stdout".into(),
                line,
            });
        }
    });
    let mut last_err_lines: Vec<String> = Vec::new();
    let err_task = tokio::spawn({
        let ch_err = ch_err.clone();
        async move {
            let mut acc: Vec<String> = Vec::new();
            let mut reader = tokio::io::BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                acc.push(line.clone());
                if acc.len() > 40 {
                    acc.remove(0);
                }
                let _ = ch_err.send(InstallEvent::Log {
                    stream: "stderr".into(),
                    line,
                });
            }
            acc
        }
    });
    let status = child
        .wait()
        .await
        .map_err(|e| format!("wait: {e}"))?;
    let _ = out_task.await;
    if let Ok(tail) = err_task.await {
        last_err_lines = tail;
    }
    if !status.success() {
        let tail = last_err_lines.iter().rev().take(8).rev().cloned().collect::<Vec<_>>().join("\n");
        return Err(format!(
            "exit {} · stderr tail:\n{tail}",
            status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into())
        ));
    }
    Ok(())
}

/// Remove a profile's venv. Used when the user wants to free disk
/// space or reset a broken env. Idempotent — silently no-ops if the
/// venv isn't there.
#[tauri::command]
pub async fn env_profile_uninstall(name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let venv = match envs_root() {
            Some(r) => r.join(&name),
            None => return Ok(()),
        };
        if !venv.exists() {
            return Ok(());
        }
        std::fs::remove_dir_all(&venv).map_err(|e| format!("rmdir {}: {e}", venv.display()))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}
