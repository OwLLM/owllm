// Agent-callable tool surface for the local llama-server path.
//
// The legacy Python app exposes tools to every local model via the
// XML-tag protocol defined in LLM/core/agents/tools/parser.py — the
// system prompt teaches the model the format, the agent loop parses
// <tool_call> blocks out of each turn and runs them. Without this the
// model can only describe what it would do.
//
// This module is the Rust executor for that protocol. The TS dispatch
// loop in apps/owllm-desktop/ui/src/pages/agentic/dispatch.ts parses
// tool_call blocks out of model output, invokes each command here,
// and folds the result back into the conversation. One round-trip per
// call; the loop keeps going until the model emits no more calls.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub kind: String, // "file" or "dir"
    pub size: Option<u64>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// Resolve a tool path against an optional project CWD. If the path
/// is absolute we accept it as-is; if it's relative the CWD is the
/// anchor (matches the Python tool runtime's behavior).
/// A project on a Windows drive accessed through WSL isolation arrives as a
/// `\\wsl.localhost\<distro>\mnt\<drive>\...` (or `\\wsl$\...`) UNC — the SANDBOX's
/// view (host → WSL → /mnt/<drive> → back to the host drive). The HOST file tools
/// (list_dir / read_file / write_file) must read the drive DIRECTLY: that round-trip
/// UNC is slow and routinely returns "access denied", which is exactly why an
/// isolated project's agents couldn't list or read their own files. Unwrap e.g.
/// `\\wsl.localhost\Ubuntu\mnt\c\1_Git\RED` → `C:\1_Git\RED`. Returns None when the
/// path is NOT a WSL-mount-of-a-drive UNC (e.g. a genuine in-WSL `…\home\…` path),
/// so real WSL-side projects keep using the UNC.
fn wsl_mnt_unc_to_windows(p: &str) -> Option<String> {
    // Normalise to backslashes so a `//wsl.localhost/...` form parses too.
    let norm = p.replace('/', "\\");
    let rest = norm
        .strip_prefix(r"\\wsl.localhost\")
        .or_else(|| norm.strip_prefix(r"\\wsl$\"))?;
    let after_distro = rest.split_once('\\')?.1; // drop "<distro>\"
    let mnt = after_distro.strip_prefix(r"mnt\")?; // must be a /mnt mount
    let (drive, tail) = mnt.split_once('\\').unwrap_or((mnt, ""));
    let d = drive.chars().next()?;
    if drive.len() != 1 || !d.is_ascii_alphabetic() {
        return None;
    }
    Some(if tail.is_empty() {
        format!("{}:\\", d.to_ascii_uppercase())
    } else {
        format!("{}:\\{}", d.to_ascii_uppercase(), tail)
    })
}

/// The host-fs base for a cwd: a WSL-mount UNC of a Windows drive is unwrapped to
/// the native drive path (direct + reliable); anything else is used as-is.
fn host_cwd(cwd: &str) -> String {
    wsl_mnt_unc_to_windows(cwd).unwrap_or_else(|| cwd.to_string())
}

fn resolve(path: &str, cwd: &Option<String>) -> PathBuf {
    // An absolute path may itself be a WSL-mount UNC — unwrap to the native drive.
    if let Some(win) = wsl_mnt_unc_to_windows(path) {
        return PathBuf::from(win);
    }
    let p = Path::new(path);
    if p.is_absolute() {
        return p.to_path_buf();
    }
    match cwd.as_deref() {
        Some(c) if !c.is_empty() => Path::new(&host_cwd(c)).join(p),
        _ => p.to_path_buf(),
    }
}

// ----- Safety guard rails -----
//
// These are guard rails, NOT a hard security boundary — the shell is
// Turing-complete, so only OS-level isolation (restricted token / job
// object / container) is bulletproof. What these DO catch is the common
// "the model did something dumb and clobbered something outside the
// workspace" case that matters most for non-expert users:
//   * write_jail()            — file writes / dir-creates must land inside
//     the agent's workspace (cwd / worktree), the OS temp dir, or ~/OwLLM.
//     A write to C:\Windows\... or the user's Documents is refused.
//   * dangerous_shell_command — refuses a short list of catastrophic,
//     never-legitimate commands (wipe root/home, format/partition a disk,
//     fork bomb, HKLM registry delete, shutdown, remote-download piped
//     into a shell). Scoped work inside the workspace is untouched.

/// Resolve `.`/`..` lexically WITHOUT touching the filesystem, so it works
/// for not-yet-existing write targets (canonicalize() can't).
fn normalize_lexical(p: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::ParentDir => { out.pop(); }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Component key for prefix comparison — case-insensitive on Windows.
fn comp_key(c: std::path::Component) -> String {
    let s = c.as_os_str().to_string_lossy().to_string();
    if cfg!(windows) { s.to_lowercase() } else { s }
}

/// Is `path` the same as, or nested inside, `root`? Compared component-wise
/// so a sibling like `C:\foobar` is NOT treated as inside `C:\foo`.
fn is_within(root: &Path, path: &Path) -> bool {
    let root_c: Vec<String> = normalize_lexical(root).components().map(comp_key).collect();
    let path_c: Vec<String> = normalize_lexical(path).components().map(comp_key).collect();
    if root_c.is_empty() { return false; }
    path_c.len() >= root_c.len() && root_c.iter().zip(path_c.iter()).all(|(a, b)| a == b)
}

/// Roots a tool may write under: the agent cwd (worktree / project / scratch),
/// the OS temp dir, and ~/OwLLM (covers the chat scratch dir; fleet worktrees
/// already live under the cwd).
fn write_allowed_roots(cwd: &Option<String>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(c) = cwd.as_deref().filter(|s| !s.is_empty()) {
        // Unwrap a WSL-mount UNC to the native drive so the allowed root matches the
        // (also-unwrapped) resolved write target — otherwise every write would be
        // wrongly blocked as "outside the workspace".
        roots.push(normalize_lexical(Path::new(&host_cwd(c))));
    }
    roots.push(normalize_lexical(&std::env::temp_dir()));
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        roots.push(normalize_lexical(&PathBuf::from(home).join("OwLLM")));
    }
    roots
}

/// Resolve a write/create target and refuse it if it escapes the allowed
/// roots. Error text is model-readable so the agent self-corrects.
fn write_jail(path: &str, cwd: &Option<String>) -> Result<PathBuf, String> {
    let resolved = normalize_lexical(&resolve(path, cwd));
    if write_allowed_roots(cwd).iter().any(|r| is_within(r, &resolved)) {
        Ok(resolved)
    } else {
        Err(format!(
            "blocked: '{}' is outside the agent workspace. Writes are limited to the project/worktree, the temp dir, and ~/OwLLM — use a path inside the project.",
            resolved.display()
        ))
    }
}

/// Refuse a narrow set of catastrophic, never-legitimate shell commands.
/// Returns Some(reason) when the command must be blocked. Intentionally
/// conservative: scoped deletes inside the workspace (e.g. `rm -rf
/// node_modules`) are allowed — only whole-disk / system-level destruction
/// is stopped.
fn dangerous_shell_command(cmd: &str) -> Option<&'static str> {
    let c = cmd.to_lowercase();
    let flat = c.replace(['\t', '\n', '\r'], " ");
    // Whole-root / home recursive wipes.
    let trimmed = flat.trim_start();
    if trimmed.starts_with("rm -rf /") || trimmed.starts_with("rm -fr /")
        || trimmed.starts_with("rm -rf ~") || flat.contains(" rm -rf /") || flat.contains(" rm -rf ~") {
        return Some("recursive delete of filesystem root or home");
    }
    // Disk format / partition / raw-device write.
    for pat in ["mkfs", "diskpart", "format c:", "format /", "dd if=", "cipher /w", "> /dev/sd", "of=/dev/"] {
        if c.contains(pat) { return Some("disk format / partition / raw-device write"); }
    }
    // System control.
    if c.contains("shutdown") || c.contains("reg delete hklm") || c.contains("reg delete \"hklm") {
        return Some("system shutdown or HKLM registry delete");
    }
    // Fork bomb.
    if flat.replace(' ', "").contains(":(){:|:&};:") { return Some("fork bomb"); }
    // Remote download piped straight into a shell / eval.
    let dl = c.contains("curl ") || c.contains("wget ") || c.contains("iwr ") || c.contains("invoke-webrequest");
    let exec = flat.contains("| sh") || flat.contains("|sh") || flat.contains("| bash") || flat.contains("|bash")
        || flat.contains("| iex") || flat.contains("|iex") || c.contains("invoke-expression");
    if dl && exec { return Some("remote download piped directly into a shell"); }
    None
}

/// Dedicated scratch directory for the fine-tuning chat playground's
/// tools. Both the local tool runtime and the Claude CLI subscription
/// path operate here, so test file writes / shell commands land in a
/// safe sandbox under the user's home instead of the app install dir or
/// the source tree. Created on first request.
#[tauri::command]
pub async fn chat_scratch_dir() -> Result<String, String> {
    // ISOLATION: the fine-tuning chat has tools too, so when WSL isolation is
    // on its scratch dir is a WSL project — writes + shell run inside the
    // distro (off the Windows disk), exactly like the Code page and agents.
    // wsl_create_project spawns wsl.exe (blocking), so run it off the async
    // executor; fall back to the host scratch dir if WSL provisioning fails.
    let iso = crate::wsl::wsl_isolation_get();
    if iso.enabled {
        let distro = iso.distro.clone();
        let provisioned = tokio::task::spawn_blocking(move || {
            crate::wsl::wsl_create_project("chat-scratch".to_string(), distro)
        })
        .await
        .ok()
        .and_then(|r| r.ok());
        if let Some(p) = provisioned {
            return Ok(p.unc_path);
        }
        // else: WSL unavailable/failed — fall through to the host scratch dir.
    }
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or_else(|| "no home directory (USERPROFILE/HOME unset)".to_string())?;
    let dir = PathBuf::from(home).join("OwLLM").join("chat-scratch");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn tool_read_file(path: String, cwd: Option<String>) -> Result<String, String> {
    let p = resolve(&path, &cwd);
    std::fs::read_to_string(&p).map_err(|e| format!("read {}: {e}", p.display()))
}

#[tauri::command]
pub async fn tool_write_file(
    path: String,
    content: String,
    cwd: Option<String>,
) -> Result<(), String> {
    let p = write_jail(&path, &cwd)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir parent of {}: {e}", p.display()))?;
    }
    std::fs::write(&p, content).map_err(|e| format!("write {}: {e}", p.display()))
}

#[tauri::command]
pub async fn tool_list_dir(path: String, cwd: Option<String>) -> Result<Vec<DirEntry>, String> {
    let p = resolve(&path, &cwd);
    let read = std::fs::read_dir(&p).map_err(|e| format!("read dir {}: {e}", p.display()))?;
    let mut out: Vec<DirEntry> = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let meta = entry.metadata().ok();
        let (kind, size) = match meta {
            Some(m) if m.is_dir() => ("dir", None),
            Some(m) => ("file", Some(m.len())),
            None => ("file", None),
        };
        out.push(DirEntry { name, kind: kind.to_string(), size });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[tauri::command]
pub async fn tool_create_dir(path: String, cwd: Option<String>) -> Result<(), String> {
    let p = write_jail(&path, &cwd)?;
    std::fs::create_dir_all(&p).map_err(|e| format!("mkdir {}: {e}", p.display()))
}

/// Run a shell command. On Windows we go through cmd.exe /c so models
/// can use familiar pipes/redirects without us writing a parser.
/// CREATE_NO_WINDOW keeps the popup invisible (saved memory constraint:
/// All Windows subprocesses MUST use CREATE_NO_WINDOW 0x08000000).
/// Directories to PREPEND to PATH when running an agent shell command on
/// the Windows host (i.e. NOT inside a WSL sandbox). Without this, the
/// agent's `python …` runs against the Microsoft Store alias stub that
/// Windows seeds into `%LOCALAPPDATA%\Microsoft\WindowsApps` — which exits
/// 9009 with "Python was not found", even when Python IS installed. We put
/// a real interpreter first so `python` / `python3` / `pip` resolve.
///
/// Priority: the app's bundled runtime / python-3.11 module first (always
/// correct, ships with OwLLM), then any per-user or system Python install
/// the user added themselves. Each dir that holds python.exe also gets a
/// best-effort `python3.exe` alias copied in-place (same folder ⇒ the
/// required DLLs/Lib are present) so agents that call `python3` work too.
#[cfg(windows)]
fn host_python_path_dirs() -> Vec<std::path::PathBuf> {
    use std::path::PathBuf;
    let mut out: Vec<PathBuf> = Vec::new();

    fn add_python_dir(out: &mut Vec<PathBuf>, python_exe: PathBuf) {
        let Some(dir) = python_exe.parent().map(|p| p.to_path_buf()) else { return };
        if !dir.join("python.exe").is_file() || out.contains(&dir) {
            return;
        }
        // Best-effort `python3.exe` alias next to python.exe (writable dirs
        // only — Program Files copies just fail silently, leaving `python`
        // working). Skip if it already exists.
        let py3 = dir.join("python3.exe");
        if !py3.exists() {
            let _ = std::fs::copy(dir.join("python.exe"), &py3);
        }
        let scripts = dir.join("Scripts");
        out.push(dir);
        if scripts.is_dir() {
            out.push(scripts);
        }
    }

    // 1. App-controlled interpreters (OWLLM_PYTHON override is honoured
    //    inside bundled_python_exe()).
    if let Some(p) = crate::paths::bundled_python_exe() {
        add_python_dir(&mut out, p);
    }
    if let Some(p) = crate::paths::module_python_exe() {
        add_python_dir(&mut out, p);
    }

    // 2. Per-user installs (python.org "for me", no admin / no PATH).
    if let Ok(lad) = std::env::var("LOCALAPPDATA") {
        let root = PathBuf::from(&lad).join("Programs").join("Python");
        if let Ok(entries) = std::fs::read_dir(&root) {
            for e in entries.flatten() {
                add_python_dir(&mut out, e.path().join("python.exe"));
            }
        }
    }

    // 3. System-wide installs — C:\Python3NN and Program Files\Python3NN.
    let mut system_roots: Vec<PathBuf> = vec![PathBuf::from("C:\\")];
    for pf in ["C:\\Program Files", "C:\\Program Files (x86)"] {
        system_roots.push(PathBuf::from(pf));
    }
    for root in system_roots {
        if let Ok(entries) = std::fs::read_dir(&root) {
            for e in entries.flatten() {
                if let Some(s) = e.file_name().to_str() {
                    if s.starts_with("Python3") {
                        add_python_dir(&mut out, e.path().join("python.exe"));
                    }
                }
            }
        }
    }

    out
}

#[tauri::command]
pub async fn tool_shell_exec(
    command: String,
    cwd: Option<String>,
) -> Result<ShellResult, String> {
    use tokio::process::Command;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // Guard rail: refuse catastrophic, never-legitimate commands before
    // they ever reach the shell. Scoped work inside the workspace is fine.
    if let Some(reason) = dangerous_shell_command(&command) {
        return Err(format!(
            "blocked dangerous command ({reason}). If you truly need this, run it yourself outside the agent."
        ));
    }

    // ISOLATION: route the command into the sandbox — WSL on Windows,
    // bubblewrap on Linux, Lima on macOS — when the project lives in an
    // isolated workspace, so it runs as a process that cannot touch the host
    // home/system. On Windows this is also required for correctness: cmd.exe
    // cannot `cd` into a \\wsl.localhost UNC path. Every surface (Code page,
    // agentic teams, fine-tuning chat) inherits this the moment its project is
    // isolated. None → the command falls through to the native host path below.
    if let Some((exe, sargs)) = crate::sandbox::shell_argv(cwd.as_deref(), &command) {
        let mut wcmd = Command::new(exe);
        wcmd.args(sargs);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            wcmd.creation_flags(CREATE_NO_WINDOW);
        }
        let output = wcmd
            .output()
            .await
            .map_err(|e| format!("spawn sandbox shell: {e}"))?;
        return Ok(ShellResult {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            exit_code: output.status.code().unwrap_or(-1),
        });
    }

    let cwd_path = cwd
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);

    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/c", &command]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", &command]);
        c
    };
    if let Some(d) = cwd_path {
        cmd.current_dir(d);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);

        // Make `python` actually resolve on the Windows host — prepend a
        // real interpreter ahead of the Microsoft Store alias stub (which
        // otherwise wins and exits 9009 "Python was not found"). No WSL
        // needed; WSL-isolated projects already returned above.
        let prefix = host_python_path_dirs();
        if !prefix.is_empty() {
            let existing = std::env::var("PATH").unwrap_or_default();
            let prefix_str = prefix
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join(";");
            let new_path = if existing.is_empty() {
                prefix_str
            } else {
                format!("{prefix_str};{existing}")
            };
            cmd.env("PATH", new_path);
        }
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("spawn shell: {e}"))?;
    Ok(ShellResult {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

// ----- Remote machines over SSH (agents that operate other devices) -----
//
// These let an agent run commands + move files on a REMOTE host (a server, a
// Raspberry Pi, another PC). Auth is the user's EXISTING SSH setup: we pass
// `BatchMode=yes`, so ssh/scp NEVER prompt for a password — the agent can only
// reach hosts the user's keys/agent already authenticate to (same blast radius
// as the user's own `ssh`). We never store credentials. `StrictHostKeyChecking
// =accept-new` trusts a brand-new host on first contact but still flags a
// CHANGED key (MITM). Remote commands pass the SAME dangerous-command guard as
// the local shell, so an agent can't `rm -rf /` a remote box.

/// Common ssh/scp hardening options.
fn ssh_base_opts(cmd: &mut tokio::process::Command) {
    cmd.arg("-o").arg("BatchMode=yes")
        .arg("-o").arg("StrictHostKeyChecking=accept-new")
        .arg("-o").arg("ConnectTimeout=15");
}

fn ssh_target(host: &str, user: &Option<String>) -> String {
    match user.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(u) => format!("{u}@{}", host.trim()),
        None => host.trim().to_string(),
    }
}

#[tauri::command]
pub async fn tool_ssh_exec(
    host: String,
    command: String,
    user: Option<String>,
    port: Option<u16>,
    // Optional explicit private-key path; omit to use the ssh agent / config.
    identity: Option<String>,
) -> Result<ShellResult, String> {
    use tokio::process::Command;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    if host.trim().is_empty() { return Err("ssh_exec: host is required".to_string()); }
    if command.trim().is_empty() { return Err("ssh_exec: command is required".to_string()); }
    if let Some(reason) = dangerous_shell_command(&command) {
        return Err(format!(
            "blocked dangerous remote command ({reason}). Run it yourself over ssh if you truly need it."
        ));
    }
    let mut cmd = Command::new("ssh");
    ssh_base_opts(&mut cmd);
    if let Some(p) = port { cmd.arg("-p").arg(p.to_string()); }
    if let Some(id) = identity.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        cmd.arg("-i").arg(id);
    }
    cmd.arg(ssh_target(&host, &user));
    cmd.arg(&command); // ssh runs it through the remote login shell
    cmd.stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("spawn ssh (is the OpenSSH client installed + on PATH?): {e}"))?;
    Ok(ShellResult {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

/// Build an scp command shared by upload/download (scp uses -P for the port,
/// not ssh's -p). `a`/`b` are the source then destination, already in scp's
/// `[target:]path` form.
fn scp_command(a: &str, b: &str, port: Option<u16>, identity: &Option<String>) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("scp");
    ssh_base_opts(&mut cmd);
    if let Some(p) = port { cmd.arg("-P").arg(p.to_string()); }
    if let Some(id) = identity.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        cmd.arg("-i").arg(id);
    }
    cmd.arg(a).arg(b);
    cmd.stdin(std::process::Stdio::null());
    cmd
}

#[tauri::command]
pub async fn tool_ssh_upload(
    host: String,
    local_path: String,
    remote_path: String,
    user: Option<String>,
    port: Option<u16>,
    identity: Option<String>,
) -> Result<ShellResult, String> {
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    if host.trim().is_empty() || local_path.trim().is_empty() || remote_path.trim().is_empty() {
        return Err("ssh_upload: host, local_path and remote_path are required".to_string());
    }
    let dest = format!("{}:{}", ssh_target(&host, &user), remote_path.trim());
    let mut cmd = scp_command(local_path.trim(), &dest, port, &identity);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().await.map_err(|e| format!("spawn scp: {e}"))?;
    Ok(ShellResult {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

#[tauri::command]
pub async fn tool_ssh_download(
    host: String,
    remote_path: String,
    local_path: String,
    user: Option<String>,
    port: Option<u16>,
    identity: Option<String>,
) -> Result<ShellResult, String> {
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    if host.trim().is_empty() || remote_path.trim().is_empty() || local_path.trim().is_empty() {
        return Err("ssh_download: host, remote_path and local_path are required".to_string());
    }
    let src = format!("{}:{}", ssh_target(&host, &user), remote_path.trim());
    let mut cmd = scp_command(&src, local_path.trim(), port, &identity);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().await.map_err(|e| format!("spawn scp: {e}"))?;
    Ok(ShellResult {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

// ----- Filesystem search (Claude Code parity: Grep + Glob) -----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepHit {
    pub path: String,
    pub line: usize,
    pub text: String,
}

/// Regex content search across files under a directory (Claude Code's
/// Grep tool). Skips binary files, .git, node_modules, target, dist,
/// __pycache__ — the usual noise. Hard cap of 500 hits returned so a
/// pathological pattern doesn't blow context. `pattern` is a Rust
/// regex; `glob` filters by filename pattern (e.g. "*.rs") and is
/// optional.
#[tauri::command]
pub async fn tool_grep(
    pattern: String,
    path: Option<String>,
    glob: Option<String>,
    cwd: Option<String>,
) -> Result<Vec<GrepHit>, String> {
    const MAX_HITS: usize = 500;
    const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024; // 4 MB per file
    let re = regex::Regex::new(&pattern).map_err(|e| format!("bad pattern: {e}"))?;
    let root = resolve(path.as_deref().unwrap_or("."), &cwd);
    let glob_re: Option<regex::Regex> = match glob.as_deref() {
        None | Some("") => None,
        Some(g) => Some(regex::Regex::new(&glob_to_regex(g))
            .map_err(|e| format!("bad glob: {e}"))?),
    };
    let mut out: Vec<GrepHit> = Vec::new();
    walk_grep(&root, &re, glob_re.as_ref(), MAX_FILE_BYTES, MAX_HITS, &mut out);
    Ok(out)
}

fn walk_grep(
    dir: &Path,
    re: &regex::Regex,
    glob_re: Option<&regex::Regex>,
    max_file_bytes: u64,
    max_hits: usize,
    out: &mut Vec<GrepHit>,
) {
    if out.len() >= max_hits { return; }
    let Ok(read) = std::fs::read_dir(dir) else { return };
    for entry in read.flatten() {
        if out.len() >= max_hits { return; }
        let p = entry.path();
        let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
        // Skip the usual noise so the agent isn't drowned in vendor code.
        if matches!(name, ".git" | "node_modules" | "target" | "dist"
            | "__pycache__" | ".venv" | "venv" | ".envs" | "python_runtime") {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            walk_grep(&p, re, glob_re, max_file_bytes, max_hits, out);
            continue;
        }
        if meta.len() > max_file_bytes { continue; }
        if let Some(g) = glob_re {
            if !g.is_match(name) { continue; }
        }
        let Ok(content) = std::fs::read_to_string(&p) else { continue }; // skip binaries / non-utf8
        for (i, line) in content.lines().enumerate() {
            if out.len() >= max_hits { return; }
            if re.is_match(line) {
                out.push(GrepHit {
                    path: p.to_string_lossy().into_owned(),
                    line: i + 1,
                    text: line.chars().take(400).collect(),
                });
            }
        }
    }
}

/// Filename pattern search (Claude Code's Glob). Walks the tree under
/// `path` and returns every file whose name matches `pattern`. Pattern
/// uses `*` and `?` wildcards plus `**` for "any depth". Same skip
/// list as grep. Caps at 1000 results.
#[tauri::command]
pub async fn tool_glob(
    pattern: String,
    path: Option<String>,
    cwd: Option<String>,
) -> Result<Vec<String>, String> {
    const MAX_RESULTS: usize = 1000;
    let root = resolve(path.as_deref().unwrap_or("."), &cwd);
    // Glob is matched against the path RELATIVE TO `root`, normalised
    // with forward slashes so patterns work cross-platform.
    let re = regex::Regex::new(&glob_to_regex(&pattern))
        .map_err(|e| format!("bad pattern: {e}"))?;
    let mut out: Vec<String> = Vec::new();
    walk_glob(&root, &root, &re, MAX_RESULTS, &mut out);
    out.sort();
    Ok(out)
}

fn walk_glob(
    root: &Path,
    dir: &Path,
    re: &regex::Regex,
    max_results: usize,
    out: &mut Vec<String>,
) {
    if out.len() >= max_results { return; }
    let Ok(read) = std::fs::read_dir(dir) else { return };
    for entry in read.flatten() {
        if out.len() >= max_results { return; }
        let p = entry.path();
        let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if matches!(name, ".git" | "node_modules" | "target" | "dist"
            | "__pycache__" | ".venv" | "venv" | ".envs" | "python_runtime") {
            continue;
        }
        let rel = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().replace('\\', "/");
        let meta = match entry.metadata() { Ok(m) => m, Err(_) => continue };
        if meta.is_dir() {
            walk_glob(root, &p, re, max_results, out);
            continue;
        }
        if re.is_match(&rel) {
            out.push(p.to_string_lossy().into_owned());
        }
    }
}

/// Translate a glob pattern into a Rust regex anchored at start+end.
/// Supports: `*` (any non-slash), `**` (any depth incl. slash), `?`
/// (single non-slash), literal `/`. Other regex metachars are escaped.
fn glob_to_regex(glob: &str) -> String {
    let mut re = String::from("^");
    let mut chars = glob.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next(); // consume second *
                    re.push_str(".*");
                } else {
                    re.push_str("[^/]*");
                }
            }
            '?' => re.push_str("[^/]"),
            '.' | '+' | '(' | ')' | '|' | '^' | '$' | '{' | '}' | '[' | ']' | '\\' => {
                re.push('\\');
                re.push(c);
            }
            _ => re.push(c),
        }
    }
    re.push('$');
    re
}

// ----- Web tools (for the brainstormer agent + any web-aware agent) -----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub description: String,
}

/// Web search via Brave Search API. Requires BRAVE_API_KEY saved via
/// accounts_save_api_key (free tier: 2000 queries/month, sign up at
/// brave.com/search/api). Falls back with a clear error if missing —
/// the agent can then explain to the user what to do.
#[tauri::command]
pub async fn tool_web_search(
    query: String,
    max_results: Option<usize>,
) -> Result<Vec<SearchHit>, String> {
    let key = crate::accounts::accounts_get_secret("BRAVE_API_KEY".to_string())
        .ok_or_else(|| "BRAVE_API_KEY not saved — open Accounts page and add your Brave Search key first (free tier at brave.com/search/api).".to_string())?;

    let count = max_results.unwrap_or(5).clamp(1, 20);
    let cli = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let resp = cli
        .get("https://api.search.brave.com/res/v1/web/search")
        .header("X-Subscription-Token", key)
        .header("Accept", "application/json")
        .query(&[("q", query.as_str()), ("count", &count.to_string())])
        .send()
        .await
        .map_err(|e| format!("brave search: {e}"))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("brave body: {e}"))?;
    if !status.is_success() {
        return Err(format!("brave search HTTP {status}: {body}"));
    }
    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("brave parse: {e}"))?;
    let results = parsed
        .get("web")
        .and_then(|w| w.get("results"))
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();
    let hits: Vec<SearchHit> = results
        .into_iter()
        .filter_map(|item| {
            let title = item.get("title")?.as_str()?.to_string();
            let url = item.get("url")?.as_str()?.to_string();
            let description = item
                .get("description")
                .and_then(|d| d.as_str())
                .unwrap_or("")
                .to_string();
            Some(SearchHit { title, url, description })
        })
        .collect();
    Ok(hits)
}

/// Fetch a URL and return readable text. v1 strips <script> / <style>
/// blocks and collapses to plain text — no full Readability port. Cap
/// at 60 KB returned to keep token budgets sane; the model can paginate
/// via re-fetches if it really needs more.
/// Fetch a URL and return its RAW body verbatim (no HTML stripping).
/// Used to pull the remote model catalogue / profile JSON so new models
/// can land post-ship without an .exe rebuild. Capped at 512 KB; 10 s
/// timeout so a slow/unreachable host never blocks startup for long.
#[tauri::command]
pub async fn fetch_remote_text(url: String) -> Result<String, String> {
    const MAX_BYTES: usize = 512 * 1024;
    let cli = reqwest::Client::builder()
        .user_agent("OwLLM-Desktop/1.0")
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = cli.get(&url).send().await.map_err(|e| format!("fetch: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("fetch HTTP {status}"));
    }
    let body = resp.text().await.map_err(|e| format!("body: {e}"))?;
    if body.len() > MAX_BYTES {
        return Err(format!("catalogue too large ({} bytes)", body.len()));
    }
    Ok(body)
}

#[tauri::command]
pub async fn tool_web_fetch(url: String) -> Result<String, String> {
    const MAX_BYTES: usize = 60 * 1024;
    let cli = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; OwLLM-Brainstormer/1.0)")
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = cli.get(&url).send().await.map_err(|e| format!("fetch: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("fetch HTTP {status}"));
    }
    let html = resp.text().await.map_err(|e| format!("body: {e}"))?;
    let cleaned = strip_html(&html);
    let truncated = if cleaned.len() > MAX_BYTES {
        let mut s = cleaned[..MAX_BYTES].to_string();
        s.push_str(&format!("\n…[truncated, {} more chars]", cleaned.len() - MAX_BYTES));
        s
    } else {
        cleaned
    };
    Ok(truncated)
}

/// Crude HTML → text: strip script/style blocks, then drop remaining
/// tags, then collapse whitespace. Good enough to feed competitor
/// landing pages into a model for feature extraction — not a full DOM
/// parser, and intentionally so.
fn strip_html(html: &str) -> String {
    let mut s = html.to_string();
    // Drop script and style blocks wholesale (contents + tags).
    for tag in ["script", "style", "noscript"] {
        let open = format!("<{tag}");
        let close = format!("</{tag}>");
        loop {
            let Some(start) = s.to_lowercase().find(&open) else { break };
            let Some(end_rel) = s[start..].to_lowercase().find(&close) else { break };
            let end = start + end_rel + close.len();
            s.replace_range(start..end, " ");
        }
    }
    // Drop remaining tags.
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    // Collapse whitespace.
    let collapsed: String = out.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed
}

/// Screenshot a URL using TwinForge's web_adapter via the bundled
/// Python runtime. The brainstormer uses this to capture competitor
/// landing pages for the GUI direction synthesis. Output PNG path is
/// returned on success; spawn errors propagate as Err.
#[tauri::command]
pub async fn tool_screenshot_url(
    url: String,
    out_png: String,
) -> Result<String, String> {
    use tokio::process::Command;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // Bundled Python lives under the legacy LLM/ tree (will move to
    // %LocalAppData%\OwLLM Desktop\runtime\ in the installer phase).
    // The screenshot_url.py wrapper script ships in the app's resources
    // (apps/owllm-desktop/resources/tools/), with the legacy LLM/tools/
    // path as the fallback.
    let python = crate::paths::bundled_python_exe()
        .ok_or_else(|| "bundled Python not found (expected LLM/python_runtime/python3.11/python.exe). Run the installer to bootstrap the runtime.".to_string())?;
    let script = crate::paths::tools_dir()
        .map(|d| d.join("screenshot_url.py"))
        .filter(|p| p.is_file())
        .ok_or_else(|| "screenshot_url.py not found in resources/tools/ or LLM/tools/ — TwinForge dependency missing".to_string())?;

    // Ensure parent dir for the output PNG exists.
    if let Some(parent) = Path::new(&out_png).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir parent of {out_png}: {e}"))?;
    }

    let mut cmd = Command::new(&python);
    cmd.arg(&script)
        .arg("--url").arg(&url)
        .arg("--out-png").arg(&out_png);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().await.map_err(|e| format!("spawn python: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("screenshot failed (exit {}): {stderr}", output.status.code().unwrap_or(-1)));
    }
    Ok(out_png)
}
