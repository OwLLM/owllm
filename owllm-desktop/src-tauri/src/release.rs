// Host-side release publisher — the capability a sandboxed/CLI agent CANNOT have
// (build toolchain + signing key + gh all live on the host). The Publisher agent
// invokes `publish_release`; this runs the vetted scripts/publish-release.sh on
// the host via bash and returns its output. It runs ONLY that one script — not
// arbitrary commands — so it's a controlled escape hatch, gated to the Publisher
// role's tool_allowlist. Model-agnostic (one native tool call → all CLI) and the
// script branches per-OS (all OS).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

const MIN_HOST_RELEASE_FREE_BYTES: u64 = 20 * 1024 * 1024 * 1024;

/// Publishing mutates version files, Git refs, the shared Cargo target, and the
/// same dist artifacts. Two Code/Agentic cards publishing one repo at once can
/// duplicate an entire build and race those files. Hold a process-wide,
/// per-repository lease for every publish entry point.
static ACTIVE_PUBLISHES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

struct PublishLease {
    key: String,
}

impl Drop for PublishLease {
    fn drop(&mut self) {
        let active = ACTIVE_PUBLISHES.get_or_init(|| Mutex::new(HashSet::new()));
        active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.key);
    }
}

fn publish_key(repo_dir: &str) -> String {
    let host = crate::agent_tools::host_cwd(repo_dir);
    let canonical = std::fs::canonicalize(&host).unwrap_or_else(|_| PathBuf::from(host));
    let mut key = canonical.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    key.make_ascii_lowercase();
    key
}

fn acquire_publish_lease(repo_dir: &str) -> Result<PublishLease, String> {
    let key = publish_key(repo_dir);
    let active = ACTIVE_PUBLISHES.get_or_init(|| Mutex::new(HashSet::new()));
    let mut guard = active
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !guard.insert(key.clone()) {
        return Err(
            "A publish is already running for this repository. The app remains usable; follow the existing Publisher card instead of starting another build."
                .to_string(),
        );
    }
    Ok(PublishLease { key })
}

/// Code-signing certificate selection for a release. Mirrors the Publisher card's
/// code-signing fields and maps 1:1 onto publish-release.sh's OWLLM_SIGN_* env.
#[derive(serde::Deserialize, serde::Serialize, Clone, Default)]
pub struct SignCfg {
    pub thumbprint: Option<String>,
    pub subject: Option<String>,
    pub tsa: Option<String>,
}

impl SignCfg {
    /// True if any selector that would trigger Authenticode signing is present.
    pub fn has_signing(&self) -> bool {
        self.thumbprint
            .as_ref()
            .is_some_and(|s| !s.trim().is_empty())
            || self.subject.as_ref().is_some_and(|s| !s.trim().is_empty())
    }

    /// Apply the config to a Command as environment variables consumed by the
    /// publish scripts. Empty values are still exported (scripts treat empty as
    /// "not configured"), and TSA falls back to Certum's RFC3161 server.
    pub fn apply_to(&self, cmd: &mut Command) {
        cmd.env(
            "OWLLM_SIGN_THUMBPRINT",
            self.thumbprint.clone().unwrap_or_default(),
        );
        cmd.env(
            "OWLLM_SIGN_SUBJECT",
            self.subject.clone().unwrap_or_default(),
        );
        cmd.env(
            "OWLLM_SIGN_TSA",
            self.tsa
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "http://time.certum.pl".into()),
        );
    }
}

/// One readiness probe result for the Publisher card's READY / NOT READY tag.
#[derive(serde::Serialize, Clone)]
pub struct ReadyCheck {
    pub id: String,
    pub label: String,
    pub ok: bool,
    pub detail: String,
}

/// Run one git command against the repo on the HOST (native path, native git,
/// native credentials — the exact environment the sandboxed agents lack).
/// GIT_TERMINAL_PROMPT=0 makes a missing credential FAIL FAST instead of
/// hanging the UI waiting for a username prompt that can never be answered.
fn run_git(host_dir: &str, args: &[&str]) -> (bool, String) {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(host_dir).args(args);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    match cmd.output() {
        Ok(out) => {
            let combined = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            (out.status.success(), combined.trim().to_string())
        }
        Err(e) => (false, format!("spawn git: {e}")),
    }
}

/// Convert any project-path shape the agent might pass — Windows `C:\…`, WSL
/// `/mnt/c/…`, or a `\\wsl.localhost\<distro>\mnt\c\…` UNC — into a git-bash
/// POSIX path (`/c/…`) so the script runs correctly under bash.exe on the host.
fn to_gitbash_path(p: &str) -> String {
    let s = p.trim().replace('\\', "/");
    // \\wsl.localhost/<distro>/mnt/<d>/… or //wsl$/… → take from /mnt/<d>/…
    let s = match s.to_lowercase().find("/mnt/") {
        Some(i) if s.to_lowercase().contains("wsl") => s[i..].to_string(),
        _ => s,
    };
    if let Some(rest) = s.strip_prefix("/mnt/") {
        let mut it = rest.splitn(2, '/');
        let drive = it.next().unwrap_or("");
        let tail = it.next().unwrap_or("");
        if drive.len() == 1 {
            return format!("/{}/{}", drive.to_lowercase(), tail);
        }
    }
    if s.len() >= 2 && s.as_bytes()[1] == b':' {
        return format!("/{}{}", s[..1].to_lowercase(), &s[2..]);
    }
    s
}

/// Locate bash: PATH first (Linux/macOS/`bash` on PATH), then the standard Git
/// for Windows install so the host doesn't need bash on PATH.
fn which_bash() -> String {
    #[cfg(windows)]
    for c in [
        "C:/Program Files/Git/bin/bash.exe",
        "C:/Program Files (x86)/Git/bin/bash.exe",
    ] {
        if std::path::Path::new(c).exists() {
            return c.to_string();
        }
    }
    "bash".to_string()
}

/// Build → sign → latest.json → gh release → verify, by running the canonical
/// publish script on the host. `repo_dir` is the project root (the agent's cwd).
/// Returns the script's combined output; errors if it didn't reach a success
/// marker so the agent can't report a phantom release.
#[tauri::command]
pub async fn publish_release(
    repo_dir: String,
    notes: Option<String>,
    dry_run: Option<bool>,
    draft: Option<bool>,
    sign: Option<SignCfg>,
) -> Result<String, String> {
    let _publish_lease = acquire_publish_lease(&repo_dir)?;
    let posix = to_gitbash_path(&repo_dir);
    let script = format!("{posix}/owllm-desktop/scripts/publish-release.sh");
    let mut args: Vec<String> = vec![script, "--notes".into(), notes.unwrap_or_default()];
    if dry_run.unwrap_or(false) {
        args.push("--dry-run".into());
    }
    if draft.unwrap_or(false) {
        args.push("--draft".into());
    }

    let out = tokio::task::spawn_blocking(move || {
        let bash = which_bash();
        let mut cmd = Command::new(&bash);
        if let Some(s) = sign {
            s.apply_to(&mut cmd);
        }
        cmd.args(&args);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        cmd.output()
            .map_err(|e| format!("spawn bash ({bash}): {e}"))
    })
    .await
    .map_err(|e| format!("join error: {e}"))??;

    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let ok = out.status.success()
        && (combined.contains("PUBLISH_OK")
            || combined.contains("PUBLISH_DRYRUN_OK")
            || combined.contains("PUBLISH_DRAFT_OK"));
    if ok {
        Ok(combined)
    } else {
        // Tail so the agent sees the real failure, not a truncated head.
        let tail: String = combined
            .chars()
            .rev()
            .take(2000)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        Err(format!("publish did not complete:\n{tail}"))
    }
}

/// Rule-based "finish & publish" — the deterministic host release the SOLO path
/// fires when the goal says publish. Bumps the version, commits ONLY the app dir,
/// pushes, tags, then runs the canonical publish-release.sh — none of it dependent
/// on the model committing/tagging/not-lying. Same host-only requirements +
/// success markers as publish_release.
///
/// `mode` controls whether the build happens on this host (`host`) or is deferred
/// to CI (`ci`). Host mode requires the local build toolchain + signing cert;
/// CI mode only bumps/commits/tags/pushes and lets the repo's GitHub Actions
/// workflow finish the release.
/// Resolve which finish-and-publish.sh runs for `repo_dir`, and whether it
/// needs the repo passed explicitly (--repo-dir):
///   1. `<repo>/owllm-desktop/scripts/…` — OwLLM's own layout; the script
///      derives the repo from its location, and OLD copies don't know
///      --repo-dir, so none is passed (backward compatible).
///   2. `<repo>/scripts/…` — a repo carrying its own copy (new convention).
///   3. the app's BUNDLED copy — what makes publishing work for any repo.
/// Returns (script path for bash, pass --repo-dir?).
fn resolve_finish_script(repo_dir: &str, posix: &str) -> Option<(String, bool)> {
    let host = crate::agent_tools::host_cwd(repo_dir);
    let own = "owllm-desktop/scripts/finish-and-publish.sh";
    if std::path::Path::new(&host).join(own).is_file() {
        return Some((format!("{posix}/{own}"), false));
    }
    let generic = "scripts/finish-and-publish.sh";
    if std::path::Path::new(&host).join(generic).is_file() {
        return Some((format!("{posix}/{generic}"), true));
    }
    crate::paths::publish_finish_script().map(|p| (to_gitbash_path(&p.to_string_lossy()), true))
}

#[tauri::command]
pub async fn finish_and_publish(
    repo_dir: String,
    notes: Option<String>,
    mode: Option<String>,
    sign: Option<SignCfg>,
) -> Result<String, String> {
    let _publish_lease = acquire_publish_lease(&repo_dir)?;
    let posix = to_gitbash_path(&repo_dir);
    // Script resolution — this is what makes publishing work for ANY repo:
    // a repo-local copy wins (OwLLM itself / power users), else the app's
    // BUNDLED copy runs against the repo via --repo-dir.
    let (script, needs_repo_arg) = resolve_finish_script(&repo_dir, &posix)
        .ok_or_else(|| "finish-and-publish.sh not found (repo-local or bundled)".to_string())?;
    let mut args: Vec<String> = vec![script, "--notes".into(), notes.unwrap_or_default()];
    if needs_repo_arg {
        args.push("--repo-dir".into());
        args.push(posix.clone());
    }
    // Forward --mode whenever the CALLER made a choice — including "host".
    // The old code dropped "host", making an explicit host pick identical to
    // "unset"; now that the script falls back to the Project Card's
    // release.mode when no --mode is given, that distinction is load-bearing
    // (explicit arg > committed card > host default).
    if let Some(m) = mode.as_deref().filter(|m| !m.trim().is_empty()) {
        args.push("--mode".into());
        args.push(m.trim().to_string());
    }

    let script_for_diag = args.first().cloned().unwrap_or_else(|| "<unknown>".into());
    let mode_for_diag = mode
        .as_deref()
        .filter(|m| !m.trim().is_empty())
        .unwrap_or("<project-card/default>")
        .to_string();
    let bash = which_bash();
    let bash_for_diag = bash.clone();

    let out = tokio::task::spawn_blocking(move || {
        let mut cmd = Command::new(&bash);
        if let Some(s) = sign {
            s.apply_to(&mut cmd);
        }
        cmd.args(&args);
        // NO current_dir: repo_dir can be a WSL/posix path Windows can't cd into
        // (os error 267). finish-and-publish.sh cd's to the repo itself (from its
        // own BASH_SOURCE path), exactly like publish_release does.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        cmd.output()
            .map_err(|e| format!("spawn bash ({bash}): {e}"))
    })
    .await
    .map_err(|e| format!("join error: {e}"))??;

    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let ok = out.status.success()
        && (combined.contains("PUBLISH_OK")
            || combined.contains("PUBLISH_DRYRUN_OK")
            || combined.contains("PUBLISH_DRAFT_OK"));
    if ok {
        Ok(combined)
    } else {
        let trimmed = combined.trim();
        let tail: String = if trimmed.is_empty() {
            let status = out
                .status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "terminated by signal".into());
            format!(
                "release command exited {status} without stdout/stderr\nrepo_dir: {repo_dir}\nscript: {script_for_diag}\nmode: {mode_for_diag}\nbash: {bash_for_diag}"
            )
        } else {
            combined
                .chars()
                .rev()
                .take(2000)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect()
        };
        Err(format!("finish_and_publish did not complete:\n{tail}"))
    }
}

/// Run an arbitrary host command and return (success, combined output).
/// Used by readiness probes for node/cargo/gh/signtool.
fn run_probe(name: &str, args: &[&str]) -> (bool, String) {
    let mut cmd = Command::new(name);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    match cmd.output() {
        Ok(out) => {
            let combined = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            (out.status.success(), combined.trim().to_string())
        }
        Err(e) => (false, format!("spawn {name}: {e}")),
    }
}

fn fmt_gb(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / 1024.0 / 1024.0 / 1024.0)
}

#[cfg(windows)]
fn disk_free_bytes_for_path(path: &str) -> Option<(String, u64)> {
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Component, Prefix};
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let full = std::fs::canonicalize(path).ok()?;
    let label = match full.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => {
                format!("{}:", letter as char)
            }
            Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
                format!(
                    r"\\{}\{}",
                    server.to_string_lossy(),
                    share.to_string_lossy()
                )
            }
            _ => full.display().to_string(),
        },
        _ => full.display().to_string(),
    };
    let wide: Vec<u16> = full.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available = 0u64;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return None;
    }
    Some((label, available))
}

#[cfg(not(windows))]
fn disk_free_bytes_for_path(path: &str) -> Option<(String, u64)> {
    let out = Command::new("df").args(["-Pk", path]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let txt = String::from_utf8_lossy(&out.stdout);
    let line = txt.lines().last()?;
    let cols: Vec<&str> = line.split_whitespace().collect();
    let avail_kb = cols.get(3)?.parse::<u64>().ok()?;
    Some((
        cols.first().unwrap_or(&"filesystem").to_string(),
        avail_kb * 1024,
    ))
}
/// Locate signtool.exe the same way the publish script does:
/// first via PATH, then the standard Windows SDK install layout.
/// Returns the newest x64 signtool when multiple SDK versions are present.
#[cfg(windows)]
fn find_signtool() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(';') {
            let candidate = Path::new(dir).join("signtool.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    let mut candidates: Vec<(String, PathBuf)> = Vec::new();
    for base in [
        r"C:\Program Files (x86)\Windows Kits\10\bin",
        r"C:\Program Files\Windows Kits\10\bin",
        r"C:\Program Files (x86)\Windows Kits\11\bin",
        r"C:\Program Files\Windows Kits\11\bin",
    ] {
        if let Ok(entries) = std::fs::read_dir(base) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let signtool = path.join("x64").join("signtool.exe");
                    if signtool.is_file() {
                        candidates
                            .push((entry.file_name().to_string_lossy().into_owned(), signtool));
                    }
                }
            }
        }
    }
    // Newest SDK version first (directory names sort lexicographically descending).
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    candidates.into_iter().next().map(|(_, p)| p)
}

#[cfg(not(windows))]
fn find_signtool() -> Option<PathBuf> {
    None
}

/// Attempt to install the Windows SDK automatically so the user is never told
/// to "install BS". Uses winget when available; otherwise falls back to the
/// web installer bootstrapper.
#[cfg(windows)]
fn auto_install_signtool() -> Result<PathBuf, String> {
    // 1. Try winget (Windows 10/11 with App Installer).
    let mut winget = Command::new("winget.exe");
    winget.args([
        "install",
        "--id",
        "Microsoft.WindowsSDK",
        "--silent",
        "--accept-source-agreements",
        "--accept-package-agreements",
        "--disable-interactivity",
    ]);
    {
        use std::os::windows::process::CommandExt;
        winget.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    match winget.output() {
        Ok(out) => {
            let combined = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            if out.status.success() || combined.to_lowercase().contains("already installed") {
                return find_signtool().ok_or_else(|| {
                    "Windows SDK installed, but signtool.exe was not found in the expected location. Restarting the app may refresh PATH.".into()
                });
            }
            // Winget failed but maybe it is not installed; continue to fallback.
            eprintln!("winget install failed: {combined}");
        }
        Err(e) => eprintln!("winget not available: {e}"),
    }

    // 2. Fallback: download the tiny Windows SDK installer bootstrapper and run it.
    let temp = std::env::temp_dir();
    let installer = temp.join("winsdksetup.exe");
    let url = "https://go.microsoft.com/fwlink/?linkid=2327008"; // Windows SDK for Windows 11 (10.0.26100.x)
    let mut curl = Command::new("curl.exe");
    curl.args([
        "-L",
        "-o",
        installer.to_str().unwrap_or("winsdksetup.exe"),
        url,
        "--fail",
    ]);
    {
        use std::os::windows::process::CommandExt;
        curl.creation_flags(0x0800_0000);
    }
    let (dl_ok, dl_out) = match curl.output() {
        Ok(out) => {
            let combined = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            (out.status.success(), combined)
        }
        Err(e) => (false, format!("spawn curl: {e}")),
    };
    if !dl_ok {
        return Err(format!(
            "could not download Windows SDK installer:\n{dl_out}"
        ));
    }
    let mut setup = Command::new(&installer);
    setup.args([
        "/q",                    // quiet
        "/norestart",            // do not restart
        "/features",             // install selected features only
        "OptionId.SigningTools", // signtool + certs
    ]);
    {
        use std::os::windows::process::CommandExt;
        setup.creation_flags(0x0800_0000);
    }
    match setup.output() {
        Ok(out) => {
            let combined = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            if out.status.success() {
                find_signtool().ok_or_else(|| {
                    "Windows SDK installed, but signtool.exe still not found. Try restarting the app.".into()
                })
            } else {
                Err(format!("Windows SDK installer failed:\n{combined}"))
            }
        }
        Err(e) => Err(format!("spawn Windows SDK installer: {e}")),
    }
}

#[cfg(not(windows))]
fn auto_install_signtool() -> Result<PathBuf, String> {
    Err("Authenticode signing requires Windows; cannot install signtool automatically.".into())
}

/// True if a configured Authenticode cert is currently mounted in the Windows
/// certificate store. On non-Windows this always returns false when signing is
/// requested, because Authenticode signing is Windows-only.
fn cert_mounted(sign: &SignCfg) -> (bool, String) {
    if !sign.has_signing() {
        return (true, "no signing config — unsigned release".into());
    }
    #[cfg(not(windows))]
    {
        return (
            false,
            "Authenticode signing is Windows-only; run Publish on the Windows host".into(),
        );
    }
    #[cfg(windows)]
    {
        let (script, matcher_desc) = if let Some(tp) =
            sign.thumbprint.as_ref().filter(|s| !s.trim().is_empty())
        {
            let tp = tp.trim().to_uppercase();
            (
                format!(
                    "$tp = '{}'; Get-ChildItem Cert:\\CurrentUser\\My -ErrorAction SilentlyContinue | Where-Object {{ $_.Thumbprint -eq $tp }} | Select-Object -First 1 Thumbprint,Subject",
                    tp.replace('\'', "''")
                ),
                format!("thumbprint {tp}"),
            )
        } else if let Some(subj) = sign.subject.as_ref().filter(|s| !s.trim().is_empty()) {
            let subj = subj.trim();
            (
                format!(
                    "$subj = '{}'; Get-ChildItem Cert:\\CurrentUser\\My -ErrorAction SilentlyContinue | Where-Object {{ $_.Subject -like \"*${{subj}}*\" }} | Select-Object -First 1 Thumbprint,Subject",
                    subj.replace('\\', "\\\\").replace('\'', "''")
                ),
                format!("subject {subj}"),
            )
        } else {
            return (
                false,
                "signing config present but neither thumbprint nor subject set".into(),
            );
        };
        let (ok, out) = run_probe(
            "powershell.exe",
            &[
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ],
        );
        if ok && !out.is_empty() && out.contains("Thumbprint") {
            (
                true,
                format!("cert mounted in CurrentUser\\My ({matcher_desc})"),
            )
        } else {
            (false, format!("cert NOT mounted ({matcher_desc}) — log into SimplySign Desktop or insert your signing key"))
        }
    }
}

/// Compute the Publisher card's READY / NOT READY tag. Each check is a real
/// probe, not decoration — in particular `ls-remote` proves push credentials
/// actually work on THIS machine (the failure mode sandboxed agents hit with
/// "could not read Username"). Returns every check so the setup popup can show
/// pass/fail per line.
#[tauri::command]
pub async fn publish_readiness(
    repo_dir: String,
    mode: Option<String>,
    sign: Option<SignCfg>,
) -> Result<Vec<ReadyCheck>, String> {
    let host = crate::agent_tools::host_cwd(&repo_dir);
    tokio::task::spawn_blocking(move || {
        let mut checks: Vec<ReadyCheck> = Vec::new();
        let host_mode = mode
            .as_deref()
            .unwrap_or("host")
            .eq_ignore_ascii_case("host");
        let sign_cfg = sign.unwrap_or_default();
        let wants_sign = host_mode && sign_cfg.has_signing();

        let (repo_ok, repo_out) = run_git(&host, &["rev-parse", "--is-inside-work-tree"]);
        checks.push(ReadyCheck {
            id: "repo".into(),
            label: "Git repository".into(),
            ok: repo_ok,
            detail: if repo_ok { host.clone() } else { repo_out },
        });
        let (rem_ok, rem_out) = if repo_ok {
            run_git(&host, &["remote", "get-url", "origin"])
        } else {
            (false, "skipped — not a git repo".into())
        };
        checks.push(ReadyCheck {
            id: "remote".into(),
            label: "Remote 'origin' configured".into(),
            ok: rem_ok,
            detail: rem_out.clone(),
        });
        let (auth_ok, auth_out) = if rem_ok {
            run_git(&host, &["ls-remote", "--heads", "origin"])
        } else {
            (false, "skipped — no remote".into())
        };
        checks.push(ReadyCheck {
            id: "auth".into(),
            label: "Remote reachable (credentials work)".into(),
            ok: auth_ok,
            detail: if auth_ok {
                "authenticated OK".into()
            } else {
                auth_out
                    .chars()
                    .rev()
                    .take(300)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect()
            },
        });
        // Target-repo probe: releases go to the Project Card's release.repo (or
        // the publish script's default), which is usually NOT origin — OwLLM's
        // origin is the private source repo while releases go to OwLLM/owllm.
        // Probing only origin let a green READY lie about the actual gh target.
        let card_repo = std::fs::read_to_string(std::path::Path::new(&host).join(".owllm/project.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v.pointer("/release/repo").and_then(|r| r.as_str().map(String::from)))
            .filter(|r| !r.trim().is_empty());
        if let Some(target) = &card_repo {
            let (tgt_ok, tgt_out) = run_probe("gh", &["repo", "view", target, "--json", "name"]);
            checks.push(ReadyCheck {
                id: "target".into(),
                label: "Release target repo reachable".into(),
                ok: tgt_ok,
                detail: if tgt_ok {
                    format!("{target} OK")
                } else {
                    format!("{target}: {tgt_out} — check release.repo on the Project Card + gh auth")
                },
            });
        }
        // Version file: the card's release.versionFile wins (any layout), then
        // the conventional candidates — previously only the hardcoded list was
        // probed, so a correctly-configured card still showed "not found".
        let card_version_file = std::fs::read_to_string(std::path::Path::new(&host).join(".owllm/project.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v.pointer("/release/versionFile").and_then(|r| r.as_str().map(String::from)))
            .filter(|r| !r.trim().is_empty());
        let ver: Option<String> = card_version_file
            .clone()
            .filter(|p| std::path::Path::new(&host).join(p).is_file())
            .or_else(|| {
                [
                    "owllm-desktop/src-tauri/tauri.conf.json",
                    "src-tauri/tauri.conf.json",
                    "tauri.conf.json",
                    "package.json",
                ]
                .iter()
                .find(|p| std::path::Path::new(&host).join(p).is_file())
                .map(|p| p.to_string())
            });
        checks.push(ReadyCheck {
            id: "version".into(),
            label: "Version file found".into(),
            ok: ver.is_some(),
            detail: ver.unwrap_or_else(|| match card_version_file {
                Some(cf) => format!("card release.versionFile \"{cf}\" does not exist"),
                None => "no tauri.conf.json / package.json — set release.versionFile on the Project Card".into(),
            }),
        });
        // Publish script: same resolution order finish_and_publish uses —
        // repo-local copy (OwLLM layout, then scripts/), else the app's BUNDLED
        // copy (which works for ANY repo). The old repo-local-only probe greyed
        // out Publish for every non-OwLLM project.
        let script_detail = if std::path::Path::new(&host)
            .join("owllm-desktop/scripts/finish-and-publish.sh")
            .is_file()
        {
            Some("owllm-desktop/scripts/finish-and-publish.sh".to_string())
        } else if std::path::Path::new(&host)
            .join("scripts/finish-and-publish.sh")
            .is_file()
        {
            Some("scripts/finish-and-publish.sh".to_string())
        } else if crate::paths::publish_finish_script().is_some() {
            Some("app-bundled finish-and-publish.sh (runs against this repo)".to_string())
        } else {
            None
        };
        checks.push(ReadyCheck {
            id: "script".into(),
            label: "Publish script available".into(),
            ok: script_detail.is_some(),
            detail: script_detail.unwrap_or_else(|| {
                "finish-and-publish.sh not found (repo or bundle) — Publish disabled (Commit/Merge still work)"
                    .into()
            }),
        });

        // Host-mode specific build / publish tooling probes.
        if host_mode {
            let disk = disk_free_bytes_for_path(&host);
            checks.push(ReadyCheck {
                id: "disk".into(),
                label: "Disk headroom (host release)".into(),
                ok: disk
                    .as_ref()
                    .is_some_and(|(_, free)| *free >= MIN_HOST_RELEASE_FREE_BYTES),
                detail: match disk {
                    Some((where_, free)) if free >= MIN_HOST_RELEASE_FREE_BYTES => {
                        format!("{} free on {where_} (minimum {})", fmt_gb(free), fmt_gb(MIN_HOST_RELEASE_FREE_BYTES))
                    }
                    Some((where_, free)) => {
                        format!(
                            "{} free on {where_}; host release requires at least {} before building",
                            fmt_gb(free),
                            fmt_gb(MIN_HOST_RELEASE_FREE_BYTES)
                        )
                    }
                    None => format!(
                        "could not measure free disk space; host release requires at least {} free",
                        fmt_gb(MIN_HOST_RELEASE_FREE_BYTES)
                    ),
                },
            });
            let (node_ok, node_out) = run_probe("node", &["--version"]);
            checks.push(ReadyCheck {
                id: "node".into(),
                label: "Node.js (build + smoke)".into(),
                ok: node_ok,
                detail: if node_ok {
                    node_out
                } else {
                    format!("{node_out} — install Node and put it on PATH")
                },
            });
            let (cargo_ok, cargo_out) = run_probe("cargo", &["--version"]);
            checks.push(ReadyCheck {
                id: "cargo".into(),
                label: "Rust / cargo (Tauri build)".into(),
                ok: cargo_ok,
                detail: if cargo_ok {
                    cargo_out
                } else {
                    format!("{cargo_out} — install Rust and put cargo on PATH")
                },
            });
            let (gh_ok, gh_out) = run_probe("gh", &["auth", "status"]);
            checks.push(ReadyCheck {
                id: "gh".into(),
                label: "GitHub CLI authenticated".into(),
                ok: gh_ok,
                detail: if gh_ok {
                    "gh auth OK".into()
                } else {
                    format!("{gh_out} — run 'gh auth login' on this host")
                },
            });
            if wants_sign {
                // Prefer an existing SDK, but if it's missing try to install it
                // automatically instead of asking the user to "install BS".
                let signtool_result = find_signtool()
                    .map(Ok)
                    .unwrap_or_else(auto_install_signtool);
                let (signtool_ok, signtool_out, signtool_path) = match signtool_result {
                    Ok(path) => {
                        let (ok, out) =
                            run_probe(path.to_str().unwrap_or("signtool.exe"), &["/?"]);
                        (ok, out, Some(path))
                    }
                    Err(e) => (false, e, None),
                };
                checks.push(ReadyCheck {
                    id: "signtool".into(),
                    label: "Windows SDK signtool".into(),
                    ok: signtool_ok,
                    detail: if signtool_ok {
                        signtool_path
                            .map(|p| format!("signtool.exe at {}", p.display()))
                            .unwrap_or_else(|| "signtool.exe ready".into())
                    } else {
                        signtool_out
                    },
                });
                let (cert_ok, cert_out) = cert_mounted(&sign_cfg);
                checks.push(ReadyCheck {
                    id: "cert".into(),
                    label: "Signing cert mounted".into(),
                    ok: cert_ok,
                    detail: cert_out,
                });
            }
        }

        Ok(checks)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Deterministic host-side commit for the Publisher card. Stages `scope` (a
/// pathspec; empty = whole tree) and commits. "Nothing to commit" is a clean
/// no-op result, not an error.
#[tauri::command]
pub async fn repo_commit(
    repo_dir: String,
    message: String,
    scope: Option<String>,
) -> Result<String, String> {
    let host = crate::agent_tools::host_cwd(&repo_dir);
    tokio::task::spawn_blocking(move || {
        let scope = scope.unwrap_or_default();
        let (add_ok, add_out) = if scope.trim().is_empty() {
            run_git(&host, &["add", "-A"])
        } else {
            run_git(&host, &["add", "-A", "--", scope.trim()])
        };
        if !add_ok {
            return Err(format!("git add failed:\n{add_out}"));
        }
        crate::fleet::unstage_app_scratch(Path::new(&host))?;
        let msg = if message.trim().is_empty() {
            "Checkpoint from Publisher card".to_string()
        } else {
            message.trim().to_string()
        };
        let (c_ok, c_out) = run_git(&host, &["commit", "-m", &msg]);
        if c_ok {
            Ok(c_out)
        } else if c_out.contains("nothing to commit") || c_out.contains("nothing added to commit") {
            Ok("Nothing to commit — working tree clean.".into())
        } else {
            Err(format!("git commit failed:\n{c_out}"))
        }
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Turn a sync_core outcome into the user-facing rail message. Conflict and
/// verify failures are Err so the card shows them as actionable failures, but
/// their text states explicitly that nothing was lost.
fn format_sync_result(
    r: Result<crate::sync_core::SyncReport, crate::sync_core::SyncError>,
) -> Result<String, String> {
    use crate::sync_core::SyncError;
    match r {
        Ok(rep) => Ok(match rep.action {
            "up-to-date" => format!("Up to date. {}", rep.detail),
            "pushed" => format!("Pushed. {}", rep.detail),
            "fast-forwarded" => format!("Updated local checkout. {}", rep.detail),
            _ => format!("Synchronized. {}", rep.detail),
        }),
        Err(SyncError::Conflict {
            files,
            recovery_ref,
        }) => Err(format!(
            "Sync stopped on a real content conflict — the same lines changed here and on origin. \
             Nothing was lost: local commits are untouched (recovery ref {recovery_ref}) and origin \
             was not modified. Resolve these files, commit, then sync again:\n{}",
            files
                .iter()
                .map(|f| format!("  - {f}"))
                .collect::<Vec<_>>()
                .join("\n")
        )),
        Err(SyncError::VerifyFailed { output }) => Err(format!(
            "The integrated commit failed verification, so it was NOT pushed:\n{output}"
        )),
        Err(SyncError::Git(msg)) => Err(msg),
    }
}

fn sync_blocking(
    host: String,
    target: Option<String>,
    verify: Option<String>,
) -> Result<String, String> {
    let path = std::path::PathBuf::from(&host);
    let lock = crate::fleet::repo_git_lock(&path);
    let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
    let target = target
        .filter(|t| !t.trim().is_empty())
        .map(|t| t.trim().to_string())
        .unwrap_or_else(|| "main".to_string());
    let verify = verify.filter(|v| !v.trim().is_empty());
    format_sync_result(crate::sync_core::sync_repo(
        &path,
        &target,
        verify.as_deref(),
    ))
}

/// The cross-PC synchronization transaction: fetch → classify → integrate
/// diverged histories on a temporary worktree (plain three-way merge, no side
/// preference) → optional verify → push with moved-remote retry → fast-forward
/// the local checkout. Never force-pushes, never resolves a source conflict
/// automatically. `↑N ↓M` divergence is a normal input here, not an error.
#[tauri::command]
pub async fn repo_sync(
    repo_dir: String,
    target: Option<String>,
    verify: Option<String>,
) -> Result<String, String> {
    let host = crate::agent_tools::host_cwd(&repo_dir);
    tokio::task::spawn_blocking(move || sync_blocking(host, target, verify))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

/// Push = synchronize the CURRENT branch with its origin counterpart. Delegates
/// to the sync transaction so a diverged remote integrates instead of dead-ending.
#[tauri::command]
pub async fn repo_push(repo_dir: String) -> Result<String, String> {
    let host = crate::agent_tools::host_cwd(&repo_dir);
    tokio::task::spawn_blocking(move || {
        let (cur_ok, cur) = run_git(&host, &["symbolic-ref", "--short", "-q", "HEAD"]);
        if !cur_ok || cur.trim().is_empty() {
            return Err(format!("not on a branch:\n{cur}"));
        }
        let branch = cur.trim().to_string();
        sync_blocking(host, Some(branch), None)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Merge-to-target = the same sync transaction against `target` (default main).
/// Kept under its historical name for existing callers; behavior is the full
/// coordinator, not the old fast-forward-only push.
#[tauri::command]
pub async fn repo_merge(repo_dir: String, target: Option<String>) -> Result<String, String> {
    let host = crate::agent_tools::host_cwd(&repo_dir);
    tokio::task::spawn_blocking(move || sync_blocking(host, target, None))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[cfg(all(test, windows))]
mod tests {
    use super::format_sync_result;
    use super::{acquire_publish_lease, disk_free_bytes_for_path};
    use crate::sync_core::{SyncError, SyncReport};

    #[test]
    fn conflict_result_names_files_and_recovery_ref() {
        let err = format_sync_result(Err(SyncError::Conflict {
            files: vec!["src/app.ts".into(), "src/lib.rs".into()],
            recovery_ref: "refs/owllm/recovery/sync-1-abc12345".into(),
        }))
        .unwrap_err();
        assert!(err.contains("Nothing was lost"));
        assert!(err.contains("refs/owllm/recovery/sync-1-abc12345"));
        assert!(err.contains("src/app.ts"));
        assert!(err.contains("src/lib.rs"));
    }

    #[test]
    fn verify_failure_states_push_was_withheld() {
        let err = format_sync_result(Err(SyncError::VerifyFailed {
            output: "1 test failed".into(),
        }))
        .unwrap_err();
        assert!(err.contains("NOT pushed"));
        assert!(err.contains("1 test failed"));
    }

    #[test]
    fn integrated_result_reads_as_synchronized() {
        let ok = format_sync_result(Ok(SyncReport {
            action: "integrated",
            detail: "Histories had diverged; merged both sides.".into(),
        }))
        .unwrap();
        assert!(ok.starts_with("Synchronized."));
    }

    #[test]
    fn disk_probe_accepts_windows_canonical_paths() {
        let (volume, available) = disk_free_bytes_for_path(".")
            .expect("the native disk probe should accept a canonical Windows path");
        assert!(!volume.trim().is_empty());
        assert!(available > 0);
    }

    #[test]
    fn publish_lease_is_single_flight_per_repository() {
        let repo = tempfile::tempdir().expect("temporary repository path");
        let path = repo.path().to_string_lossy().to_string();
        let first = acquire_publish_lease(&path).expect("first publish acquires the lease");
        assert!(acquire_publish_lease(&path).is_err());
        drop(first);
        assert!(acquire_publish_lease(&path).is_ok());
    }
}
