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
    /// When true, `index_url` is computed at install time from the
    /// machine's detected CUDA (driver) version rather than hardcoded —
    /// e.g. torch resolves to .../whl/cu118|cu121|cu124 to match the
    /// user's GPU instead of shipping one fixed build. The package
    /// `version` should then carry NO `+cuXXX` local tag (just "2.5.1");
    /// pip picks the right build from the resolved index. Ignored on a
    /// machine with no detectable NVIDIA CUDA (falls back to cu121).
    #[serde(default)]
    pub cuda_wheel: bool,
    /// Version to install INSTEAD of `version` when a Blackwell-class GPU
    /// (compute capability ≥ 12.0 — the RTX 50xx generation) is detected.
    /// The default pins predate Blackwell support for some packages (torch
    /// < 2.7, bitsandbytes < 0.45), so newer silicon needs a newer build.
    /// None → use `version` on every GPU. Lives in env_profiles.yaml so the
    /// coverage table is hot-updatable — a new GPU generation is one row,
    /// not an app rebuild. (Companion `index_blackwell` overrides the wheel
    /// index for that build, e.g. the cu128 torch index.)
    #[serde(default)]
    pub version_blackwell: Option<String>,
    /// `--index-url` to use for the Blackwell build of this package (e.g.
    /// the cu128 torch wheel index). Applied only when a Blackwell GPU is
    /// detected AND this is set; otherwise normal index/cuda_wheel rules.
    #[serde(default)]
    pub index_blackwell: Option<String>,
    /// When true, a failed install of THIS package is non-fatal: the env
    /// install logs a warning and continues instead of aborting. For
    /// best-effort accelerators like flash-attn, whose prebuilt wheel only
    /// exists for exact torch×CUDA×python combos and otherwise tries a slow
    /// source build that often fails — we never want that to block the
    /// whole environment. The probe should treat such packages as optional.
    #[serde(default)]
    pub optional: bool,
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
    /// When set (e.g. "auto"), packages are installed in ONE
    /// `uv pip install --torch-backend=<value> <names>` command and uv
    /// resolves a coherent, GPU-matched stack itself — instead of our
    /// per-package pinned loop. This is Unsloth's official recommended
    /// install: uv detects the driver and picks the right torch CUDA wheel
    /// (cu124 on Ada/Ampere, cu128 on Blackwell, …) plus matching
    /// unsloth/unsloth-zoo/transformers/triton, avoiding the version-skew
    /// breakage that comes from forcing an off-matrix torch under a pinned
    /// unsloth. `version` fields are ignored for these profiles (names
    /// only). Requires uv. None → use the normal pinned per-package loop.
    #[serde(default)]
    pub torch_backend: Option<String>,
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
        h.update(b"\0");
        if pkg.cuda_wheel {
            h.update(b"cuda");
        }
        h.update(b"\0");
        if let Some(v) = &pkg.version_blackwell {
            h.update(v.as_bytes());
        }
        h.update(b"\0");
        if let Some(i) = &pkg.index_blackwell {
            h.update(i.as_bytes());
        }
        h.update(b"\0");
        if pkg.optional {
            h.update(b"opt");
        }
        h.update(b"\n");
    }
    if let Some(b) = &p.torch_backend {
        h.update(b"torch_backend:");
        h.update(b.as_bytes());
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
#[cfg_attr(windows, allow(dead_code))] // host path only; Windows envs live in WSL
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
    let profile = {
        let n = name.clone();
        tokio::task::spawn_blocking(move || -> Result<EnvProfile, String> {
            read_profiles_yaml()?
                .into_iter()
                .find(|p| p.name == n)
                .ok_or_else(|| format!("no env profile named {n}"))
        })
        .await
        .map_err(|e| format!("join error: {e}"))??
    };
    status_impl(profile).await
}

/// Host (native Linux / fallback) status: the venv lives on the local
/// filesystem under `envs_root()`. On native Linux this IS the Linux env;
/// on Windows the WSL impl below shadows it.
#[cfg(not(windows))]
async fn status_impl(profile: EnvProfile) -> Result<EnvProfileState, String> {
    tokio::task::spawn_blocking(move || -> Result<EnvProfileState, String> {
        let venv = match envs_root() {
            Some(r) => r.join(&profile.name),
            None => return Ok(EnvProfileState::NotInstalled),
        };
        let python_exe = venv.join("bin").join("python");
        if !python_exe.is_file() {
            return Ok(EnvProfileState::NotInstalled);
        }
        let installed_hash = std::fs::read_to_string(venv.join(".owllm_manifest.sha256"))
            .unwrap_or_default()
            .trim()
            .to_string();
        let current_hash = profile_hash(&profile);
        let python_exe = python_exe.to_string_lossy().into_owned();
        if installed_hash != current_hash {
            return Ok(EnvProfileState::Stale { python_exe, installed_hash, current_hash });
        }
        Ok(EnvProfileState::Ready { python_exe })
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Windows status: the env lives INSIDE the default WSL distro
/// (`$HOME/.owllm/envs/<name>`), because fine-tuning runs in WSL. The
/// returned `python_exe` is a POSIX path; consumers (finetuning.rs) run
/// it in-distro. Returns NotInstalled (not an error) when WSL is absent
/// so the UI shows an Install button rather than a red error.
#[cfg(windows)]
async fn status_impl(profile: EnvProfile) -> Result<EnvProfileState, String> {
    tokio::task::spawn_blocking(move || -> Result<EnvProfileState, String> {
        // Resolve the SAME real-Linux distro the installer uses, so status
        // reflects where the env actually lives (not a Docker/system distro).
        let Some(distro) = crate::wsl::best_linux_distro() else {
            return Ok(EnvProfileState::NotInstalled);
        };
        let Ok(home) = wsl_backend::wsl_home(&distro) else {
            return Ok(EnvProfileState::NotInstalled);
        };
        let env = wsl_backend::env_dir(&home, &profile.name);
        let python_exe = format!("{env}/bin/python");
        // One round-trip: report the python's existence + the stamped hash.
        let q = crate::wsl::sh_quote;
        let script = format!(
            "if [ -x {py} ]; then printf 'OK\\n'; cat {hf} 2>/dev/null; else printf 'NONE\\n'; fi",
            py = q(&python_exe),
            hf = q(&format!("{env}/.owllm_manifest.sha256")),
        );
        let out = crate::wsl::run_in_distro(&distro, &script).unwrap_or_default();
        let mut lines = out.lines().map(str::trim);
        if lines.next() != Some("OK") {
            return Ok(EnvProfileState::NotInstalled);
        }
        let installed_hash = lines.next().unwrap_or("").trim().to_string();
        let current_hash = profile_hash(&profile);
        if installed_hash != current_hash {
            return Ok(EnvProfileState::Stale { python_exe, installed_hash, current_hash });
        }
        Ok(EnvProfileState::Ready { python_exe })
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

// ---- Windows: the fine-tuning env lives INSIDE WSL --------------------------

#[cfg(windows)]
mod wsl_backend {
    /// Best general-purpose distro, or an actionable error. Resolves through
    /// `best_linux_distro` so a Docker/system distro that happens to be the
    /// WSL default (no bash → exit 127) is skipped in favour of a real Ubuntu.
    pub fn default_distro() -> Result<String, String> {
        crate::wsl::best_linux_distro().ok_or_else(|| {
            "Fine-tuning needs a real Linux distro in WSL (e.g. Ubuntu). Only a Docker/system WSL distro was found. Open “Set up WSL” on the Home page to install Ubuntu.".to_string()
        })
    }
    /// Absolute `$HOME` inside the distro (e.g. /home/mc) — so the env
    /// paths we hand back are absolute, not `$HOME`-relative.
    pub fn wsl_home(distro: &str) -> Result<String, String> {
        let out = crate::wsl::run_in_distro(distro, "printf %s \"$HOME\"")?;
        let h = out.lines().next().unwrap_or("").trim().to_string();
        if h.is_empty() {
            return Err("could not resolve $HOME inside WSL".into());
        }
        Ok(h)
    }
    pub fn env_dir(home: &str, name: &str) -> String {
        format!("{home}/.owllm/envs/{name}")
    }
    /// Detect the driver's CUDA version (via `nvidia-smi` in the distro)
    /// and map it to a torch wheel index. None → no NVIDIA GPU visible.
    pub fn resolve_cuda_index(distro: &str) -> Option<String> {
        let out = crate::wsl::run_in_distro(
            distro,
            "nvidia-smi 2>/dev/null | grep -oE 'CUDA Version: [0-9]+\\.[0-9]+' | head -1",
        )
        .ok()?;
        let ver = out
            .lines()
            .find_map(|l| l.trim().strip_prefix("CUDA Version:").map(|s| s.trim().to_string()))?;
        let mut it = ver.split('.');
        let maj: u32 = it.next()?.parse().ok()?;
        let min: u32 = it.next().unwrap_or("0").parse().unwrap_or(0);
        let n = maj * 100 + min;
        let cu = if n >= 1204 {
            "cu124"
        } else if n >= 1201 {
            "cu121"
        } else if n >= 1108 {
            "cu118"
        } else {
            return None;
        };
        Some(format!("https://download.pytorch.org/whl/{cu}"))
    }

    /// Highest GPU compute capability visible in the distro, as
    /// major*10+minor (e.g. 89 for a 4090, 86 for an A2000, 120 for a
    /// Blackwell RTX 50xx). None when no NVIDIA GPU is visible. We take the
    /// MAX across cards because a newer torch supports older arches too, so
    /// the most-capable card decides the build — that way a mixed rig still
    /// gets one env that runs on every installed GPU. Drives the
    /// Blackwell-aware package selection in run_install.
    pub fn max_compute_cap(distro: &str) -> Option<u32> {
        let out = crate::wsl::run_in_distro(
            distro,
            "nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null",
        )
        .ok()?;
        let mut best: Option<u32> = None;
        for line in out.lines() {
            let l = line.trim();
            if l.is_empty() {
                continue;
            }
            let mut it = l.split('.');
            if let (Some(maj), Some(min)) = (it.next(), it.next()) {
                if let (Ok(a), Ok(b)) = (maj.trim().parse::<u32>(), min.trim().parse::<u32>()) {
                    let v = a * 10 + b;
                    best = Some(best.map_or(v, |c| c.max(v)));
                }
            }
        }
        best
    }
}

/// Compute capability at/above which we treat a GPU as "Blackwell-class"
/// (RTX 50xx, sm_120) and prefer each package's `version_blackwell` build.
#[cfg(windows)]
const BLACKWELL_MIN_CC: u32 = 120;

/// `wsl.exe` argv to run a bash login-shell script in `distro`.
#[cfg(windows)]
fn wsl_invocation(distro: &str, script: &str) -> Vec<String> {
    vec![
        "-d".into(), distro.into(), "--".into(),
        "bash".into(), "-lc".into(), script.into(),
    ]
}

/// Core install logic (Windows → inside WSL). Mirrors the host pipeline,
/// but every step runs in the distro via `wsl.exe -- bash -lc`. Uses `uv`
/// (provisioned with the sandbox) to build the venv on the requested
/// Python — uv fetches the interpreter if the distro lacks it, sidestepping
/// the python3-venv/ensurepip dance. pip/uv output streams to the channel;
/// the install is atomic (tmp dir → mv on success).
#[cfg(windows)]
async fn run_install(
    profile: &EnvProfile,
    hash: &str,
    channel: &tauri::ipc::Channel<InstallEvent>,
) -> Result<String, String> {
    use std::path::Path;
    let wsl = Path::new("wsl.exe");
    let q = crate::wsl::sh_quote;

    let distro = wsl_backend::default_distro()?;
    let home = {
        let d = distro.clone();
        tokio::task::spawn_blocking(move || wsl_backend::wsl_home(&d))
            .await
            .map_err(|e| format!("join: {e}"))??
    };
    let env = wsl_backend::env_dir(&home, &profile.name);
    let tmp = format!("{env}.tmp.{}", std::process::id());
    let venv_py = format!("{tmp}/bin/python");

    // Resolve the CUDA wheel index once, if any package needs it.
    let cuda_index = if profile.packages.iter().any(|p| p.cuda_wheel) {
        let d = distro.clone();
        let idx = tokio::task::spawn_blocking(move || wsl_backend::resolve_cuda_index(&d))
            .await
            .map_err(|e| format!("join: {e}"))?;
        match &idx {
            Some(u) => {
                let _ = channel.send(InstallEvent::Log { stream: "info".into(), line: format!("Detected CUDA → torch index {u}") });
            }
            None => {
                let _ = channel.send(InstallEvent::Log { stream: "info".into(), line: "No NVIDIA CUDA visible in WSL — defaulting torch to cu121. Update the NVIDIA Windows driver for GPU training.".into() });
            }
        }
        idx.or_else(|| Some("https://download.pytorch.org/whl/cu121".to_string()))
    } else {
        None
    };

    // Architecture-aware coverage: a Blackwell-class card (RTX 50xx,
    // compute ≥ 12.0) can't run the default torch 2.5.1 / older bitsandbytes,
    // so we prefer each package's `version_blackwell` (+ `index_blackwell`)
    // build when one's visible. Older arches are untouched. The version table
    // lives in env_profiles.yaml → hot-updatable for future GPU generations.
    let is_blackwell = {
        let d = distro.clone();
        let cc = tokio::task::spawn_blocking(move || wsl_backend::max_compute_cap(&d))
            .await
            .map_err(|e| format!("join: {e}"))?;
        let bw = cc.map(|c| c >= BLACKWELL_MIN_CC).unwrap_or(false);
        if bw {
            if let Some(c) = cc {
                let _ = channel.send(InstallEvent::Log {
                    stream: "info".into(),
                    line: format!(
                        "Detected Blackwell-class GPU (compute {}.{}) — using Blackwell package builds.",
                        c / 10,
                        c % 10
                    ),
                });
            }
        }
        bw
    };

    // 0) Make sure `uv` exists in the distro — and gate on UV SPECIFICALLY,
    //    not "is python3 present". uv is the load-bearing tool: it fetches
    //    its OWN managed CPython ({profile.python}, e.g. 3.11), so it works
    //    even when the distro's system python is a bleeding-edge 3.14 with no
    //    `python3-venv`/ensurepip (Ubuntu 25.x ships exactly that — the
    //    `python3 -m venv` fallback then dies with "ensurepip is not
    //    available"). If uv is missing we apt-install the basics + uv AS ROOT,
    //    streamed, so the env install is self-sufficient.
    let have_uv = {
        let d = distro.clone();
        tokio::task::spawn_blocking(move || {
            crate::wsl::run_in_distro(
                &d,
                "command -v uv >/dev/null 2>&1 && echo HAVE || echo MISSING",
            )
        })
        .await
        .map_err(|e| format!("join: {e}"))?
        .map(|o| o.contains("HAVE"))
        .unwrap_or(false)
    };
    if !have_uv {
        let _ = channel.send(InstallEvent::Step {
            label: "Preparing toolchain in WSL (installing uv — it brings its own Python, no system conflicts)".into(),
        });
        // Install uv to /usr/local/bin (on every user's PATH). Also pull
        // python3-venv/pip so the rare uv-less fallback still has a chance,
        // but uv is what we rely on. Verify uv landed or fail loudly.
        let provision = "set -e; export DEBIAN_FRONTEND=noninteractive; \
             apt-get update -y || true; \
             apt-get install -y python3 python3-pip python3-venv curl ca-certificates || true; \
             export UV_INSTALL_DIR=/usr/local/bin; \
             curl -LsSf https://astral.sh/uv/install.sh | sh; \
             command -v uv >/dev/null 2>&1 || { echo 'uv did not install (no internet?)'; exit 1; }; \
             uv --version"
            .to_string();
        let argv = vec![
            "-d".into(), distro.clone(), "-u".into(), "root".into(), "--".into(),
            "bash".into(), "-lc".into(), provision,
        ];
        run_subprocess(channel, wsl, &argv, None)
            .await
            .map_err(|e| format!("preparing the WSL toolchain failed: {e}. Check the WSL has internet, then retry."))?;
    }

    // 1) Create the venv with uv (which fetches managed CPython {pyv} if the
    //    distro lacks it). We DON'T fall back to `python3 -m venv` anymore:
    //    on Ubuntu 25.x that picks system 3.14 and fails on missing ensurepip.
    //    uv is guaranteed present by step 0.
    let _ = channel.send(InstallEvent::Step { label: format!("Creating venv in WSL: {env}") });
    let mk = format!(
        "set -e; mkdir -p {root}; rm -rf {t}; \
         command -v uv >/dev/null 2>&1 || {{ echo 'uv missing after provisioning'; exit 1; }}; \
         uv venv --python {pyv} {t}",
        root = q(&format!("{home}/.owllm/envs")),
        t = q(&tmp),
        pyv = q(&profile.python),
    );
    run_subprocess(channel, wsl, &wsl_invocation(&distro, &mk), None)
        .await
        .map_err(|e| {
            let _ = crate::wsl::run_in_distro(&distro, &format!("rm -rf {}", q(&tmp)));
            format!("venv creation failed in WSL: {e}")
        })?;

    // 1b) Seed setuptools + wheel. `uv venv` builds a MINIMAL venv with no
    //     setuptools, but runtime deps pulled in by torch (triton) do
    //     `import setuptools` at import time — without it the probe dies with
    //     "No module named 'setuptools'" and the whole env is discarded. The
    //     native-Linux path already seeds these; the WSL path was missing it.
    let _ = channel.send(InstallEvent::Step { label: "Seeding setuptools + wheel".into() });
    let seed = format!(
        "if command -v uv >/dev/null 2>&1; then uv pip install --python {py} setuptools wheel; \
         else {py} -m pip install --upgrade setuptools wheel; fi",
        py = q(&venv_py),
    );
    run_subprocess(channel, wsl, &wsl_invocation(&distro, &seed), None)
        .await
        .map_err(|e| {
            let _ = crate::wsl::run_in_distro(&distro, &format!("rm -rf {}", q(&tmp)));
            format!("seeding setuptools/wheel failed: {e}")
        })?;

    // 2) Install packages. Two strategies:
    //    (a) torch_backend set → ONE `uv pip install --torch-backend=<b> <names>`
    //        and let uv resolve a coherent, GPU-matched stack (Unsloth's path:
    //        uv picks the right torch CUDA wheel + matching unsloth/zoo/etc.,
    //        cu124 on Ada/Ampere, cu128 on Blackwell, …).
    //    (b) else → the pinned per-package loop (CUDA/Blackwell resolution +
    //        optional-package tolerance).
    if let Some(backend) = &profile.torch_backend {
        let names = profile.packages.iter().map(|p| q(&p.name)).collect::<Vec<_>>().join(" ");
        let pretty = profile.packages.iter().map(|p| p.name.clone()).collect::<Vec<_>>().join(" ");
        let _ = channel.send(InstallEvent::Step {
            label: format!("Installing {pretty} via uv --torch-backend={backend} (GPU-matched stack)"),
        });
        let install = format!(
            "command -v uv >/dev/null 2>&1 || {{ echo 'uv is required for this environment'; exit 1; }}; \
             uv pip install --python {py} --torch-backend={b} {names}",
            py = q(&venv_py),
            b = q(backend),
            names = names,
        );
        run_subprocess(channel, wsl, &wsl_invocation(&distro, &install), None)
            .await
            .map_err(|e| {
                let _ = crate::wsl::run_in_distro(&distro, &format!("rm -rf {}", q(&tmp)));
                format!("uv --torch-backend install failed: {e}")
            })?;
    } else {
    for pkg in &profile.packages {
        // Pick the Blackwell build when present and a Blackwell GPU is here;
        // otherwise the normal pinned version. Same for the wheel index.
        let version = if is_blackwell {
            pkg.version_blackwell.clone().unwrap_or_else(|| pkg.version.clone())
        } else {
            pkg.version.clone()
        };
        let spec = format!("{}=={}", pkg.name, version);
        let index = if is_blackwell && pkg.index_blackwell.is_some() {
            pkg.index_blackwell.clone()
        } else if pkg.cuda_wheel {
            cuda_index.clone()
        } else {
            pkg.index_url.clone()
        };
        let _ = channel.send(InstallEvent::Step {
            label: format!("Installing {spec}{}", index.as_ref().map(|u| format!(" (index {u})")).unwrap_or_default()),
        });
        let idx_arg = index.as_ref().map(|u| format!(" --index-url {}", q(u))).unwrap_or_default();
        let install = format!(
            "if command -v uv >/dev/null 2>&1; then uv pip install --python {py}{idx} {spec}; \
             else {py} -m pip install --disable-pip-version-check --no-input{idx} {spec}; fi",
            py = q(&venv_py),
            idx = idx_arg,
            spec = q(&spec),
        );
        let install_res =
            run_subprocess(channel, wsl, &wsl_invocation(&distro, &install), None).await;
        if let Err(e) = install_res {
            if pkg.optional {
                // Best-effort package (e.g. flash-attn): don't abort the
                // whole env — warn and keep going. The probe treats it as
                // optional, so the env is still usable without it.
                let _ = channel.send(InstallEvent::Log {
                    stream: "warn".into(),
                    line: format!(
                        "Optional package {spec} didn't install ({e}) — skipping it; the environment still works without it."
                    ),
                });
            } else {
                let _ = crate::wsl::run_in_distro(&distro, &format!("rm -rf {}", q(&tmp)));
                return Err(format!("pip install {spec} failed: {e}"));
            }
        }
    }
    } // end else (pinned per-package loop)

    // 3) Probe (must print "OK").
    let _ = channel.send(InstallEvent::Step { label: "Running verification probe".into() });
    let probe = format!("{py} -c {code}", py = q(&venv_py), code = q(&profile.probe));
    let probe_out = run_subprocess_capture(wsl, &wsl_invocation(&distro, &probe))
        .await
        .map_err(|e| format!("probe spawn failed: {e}"))?;
    for line in probe_out.stdout.lines() {
        let _ = channel.send(InstallEvent::Log { stream: "probe".into(), line: line.to_string() });
    }
    for line in probe_out.stderr.lines() {
        let _ = channel.send(InstallEvent::Log { stream: "probe-err".into(), line: line.to_string() });
    }
    if !probe_out.success || !probe_out.stdout.contains("OK") {
        let _ = crate::wsl::run_in_distro(&distro, &format!("rm -rf {}", q(&tmp)));
        return Err(format!(
            "probe failed (exit {}). stderr: {}",
            probe_out.code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
            probe_out.stderr.lines().last().unwrap_or("(empty)")
        ));
    }

    // 4) Stamp the manifest hash + atomically swap tmp → final, in-distro.
    let swap = format!(
        "set -e; printf '%s' {h} > {t}/.owllm_manifest.sha256; rm -rf {f}; mv {t} {f}",
        h = q(hash),
        t = q(&tmp),
        f = q(&env),
    );
    crate::wsl::run_in_distro(&distro, &swap).map_err(|e| format!("atomic swap failed: {e}"))?;

    Ok(format!("{env}/bin/python"))
}

/// Core install logic (host / native Linux). Returns the final
/// python path on success (after the atomic rename). On Windows the
/// WSL impl above shadows this.
#[cfg(not(windows))]
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
        let install_res = run_subprocess(channel, &venv_python, &args, None).await;
        if let Err(e) = install_res {
            if pkg.optional {
                let _ = channel.send(InstallEvent::Log {
                    stream: "warn".into(),
                    line: format!(
                        "Optional package {spec} didn't install ({e}) — skipping it; the environment still works without it."
                    ),
                });
            } else {
                let _ = std::fs::remove_dir_all(&tmp_dir);
                return Err(format!("pip install {spec} failed: {e}"));
            }
        }
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
    uninstall_impl(name).await
}

#[cfg(not(windows))]
async fn uninstall_impl(name: String) -> Result<(), String> {
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

/// Windows: the env is in WSL — remove it there. No-ops if WSL is gone.
#[cfg(windows)]
async fn uninstall_impl(name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let Some(distro) = crate::wsl::best_linux_distro() else {
            return Ok(());
        };
        let home = wsl_backend::wsl_home(&distro)?;
        let env = wsl_backend::env_dir(&home, &name);
        crate::wsl::run_in_distro(&distro, &format!("rm -rf {}", crate::wsl::sh_quote(&env)))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}
