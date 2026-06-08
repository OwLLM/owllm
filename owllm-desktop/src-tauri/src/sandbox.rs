// Cross-platform agent sandbox — one isolation model, three engines.
//
//   Windows → WSL2 (Linux VM)              see wsl.rs — the original, LIVE backend
//   macOS   → Lima (Virtualization.fwk)    a lightweight Linux VM, WSL's twin   [BETA]
//   Linux   → bubblewrap namespaces        private FS view + non-root uid        [BETA]
//
// The job is identical everywhere: any tool that runs a command — the local
// model's `shell`, and the subscription CLIs (claude/codex/gemini/kimi) — must
// execute INSIDE the sandbox so it can reach the project directory but NOT the
// rest of the user's home (~/.ssh, ~/.aws, browser profiles) or the wider
// system. File tools stay confined to the project by the existing write-jail;
// only command/CLI execution needs active routing, which is what this module
// provides via three functions used at every call site:
//
//   is_isolated(cwd)                  → is this workspace a sandbox project we can isolate?
//   program_argv(cwd, prog, args)     → (exe, argv) to run prog inside the sandbox (or None)
//   shell_argv(cwd, command)          → (exe, argv) to run a shell line inside the sandbox (or None)
//
// They return ARGV TUPLES rather than a std/tokio Command so each caller can
// build the Command type it already uses (accounts.rs = std, agent_tools.rs =
// tokio) and keep setting its own stdio + creation flags. On every OS the
// contract is the same: return Some when the path is isolated AND the engine is
// present; None otherwise, so the caller runs its existing native path (host,
// with the dangerous-command guard). The Windows/WSL bytes are preserved — the
// Windows impls reuse wsl.rs's exact script builders.
//
// STRENGTH TIERS: WSL and Lima are real VMs (separate kernel + filesystem) —
// the strong tier. bubblewrap shares the host kernel but gives a private
// filesystem view and drops the rest of $HOME, with a dedicated sandbox-home so
// the agent CLIs' logins persist without exposing the real one.
//
// ⚠ BETA: the Linux (bwrap) and macOS (lima) command shapes are compile-checked
// on their CI legs but have NOT yet been runtime-verified on real hardware. They
// are surfaced to the user as "beta — not yet hardware-verified". The pure
// helpers below ARE unit-tested (and compile on every OS leg).

use serde::Serialize;

/// Sub-directory of the sandbox user's home that holds isolated projects
/// (~/owllm/<name>). Matches the WSL backend layout so the concept is uniform.
pub const ISO_SUBDIR: &str = "owllm";

/// Cross-platform sandbox availability, surfaced to the UI so it can show the
/// right engine + honest strength/beta labelling on every OS.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SandboxStatus {
    /// An isolation engine is installed and runnable.
    pub available: bool,
    /// "wsl" | "lima" | "bubblewrap" | "none".
    pub kind: String,
    /// VM-grade boundary (separate kernel + FS): WSL, Lima. False for bwrap.
    pub strong: bool,
    /// Engine not yet runtime-verified on real hardware (Lima/bwrap).
    pub beta: bool,
    /// WSL distros / Lima instances (empty for bubblewrap).
    pub targets: Vec<String>,
    /// Preferred target (default distro / instance).
    pub default_target: Option<String>,
}

impl Default for SandboxStatus {
    fn default() -> Self {
        SandboxStatus {
            available: false,
            kind: "none".into(),
            strong: false,
            beta: false,
            targets: Vec::new(),
            default_target: None,
        }
    }
}

/// An isolated project. On Windows `path` is the `\\wsl.localhost\…` UNC the UI
/// uses as the workspace and `inner_path` the Linux path; on Linux/macOS both
/// are the same host path under `~/owllm`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SandboxProject {
    pub name: String,
    pub path: String,
    pub inner_path: String,
    pub kind: String,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn sanitize_name(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

// ---- pure helpers (unit-tested; compiled on every OS) ---------------------

/// True if `path` is inside `<home>/owllm` (the managed isolated-project root).
/// Used on Linux/macOS where an isolated project is an ordinary host path under
/// that root (unlike WSL, where the UNC prefix is the marker).
pub fn is_under_iso_root(path: &str, home: &str) -> bool {
    let root = format!("{}/{}", home.trim_end_matches('/'), ISO_SUBDIR);
    let p = path.trim_end_matches('/');
    p == root || p.starts_with(&format!("{root}/"))
}

/// The bubblewrap argv PREFIX (everything before the trailing `bash -lc …`):
/// system dirs read-only, a private /tmp and /dev, a dedicated writable home
/// bound as $HOME (so CLI logins persist but the real home is invisible), the
/// project bound read-write and made cwd, and namespaces unshared. `allow_net`
/// keeps networking (needed for git + cloud CLIs); false fully isolates the net.
pub fn bwrap_prefix_argv(project_dir: &str, sandbox_home: &str, allow_net: bool) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    let mut ro = |p: &str| {
        // --ro-bind-try tolerates paths that don't exist on a given distro.
        a.push("--ro-bind-try".into());
        a.push(p.into());
        a.push(p.into());
    };
    for p in ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc", "/opt"] {
        ro(p);
    }
    a.push("--proc".into());
    a.push("/proc".into());
    a.push("--dev".into());
    a.push("/dev".into());
    a.push("--tmpfs".into());
    a.push("/tmp".into());
    // Dedicated sandbox home — NOT the user's real home.
    a.push("--bind".into());
    a.push(sandbox_home.into());
    a.push(sandbox_home.into());
    a.push("--setenv".into());
    a.push("HOME".into());
    a.push(sandbox_home.into());
    // The project, read-write, as cwd.
    a.push("--bind".into());
    a.push(project_dir.into());
    a.push(project_dir.into());
    a.push("--chdir".into());
    a.push(project_dir.into());
    // Isolate namespaces; drop into a fresh session. (User namespace remaps to
    // an unprivileged uid inside — defense in depth on top of the FS jail.)
    a.push("--unshare-user-try".into());
    a.push("--unshare-ipc".into());
    a.push("--unshare-pid".into());
    a.push("--unshare-uts".into());
    a.push("--unshare-cgroup-try".into());
    if !allow_net {
        a.push("--unshare-net".into());
    }
    a.push("--die-with-parent".into());
    a.push("--new-session".into());
    a
}

/// The `limactl` argv to run `program args…` inside the Lima VM `instance` at
/// `cwd`. Lima mounts host paths at identical locations, so `cwd` is the host
/// project path. Used on macOS.
pub fn lima_argv(instance: &str, cwd: &str, program: &str, args: &[String]) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "shell".into(),
        "--workdir".into(),
        cwd.into(),
        instance.into(),
        program.into(),
    ];
    a.extend(args.iter().cloned());
    a
}

/// Build the bash script that runs `program args…` (mirrors wsl::wsl_program_command).
fn exec_script(program: &str, args: &[String]) -> String {
    let mut script = format!("exec {}", crate::wsl::sh_quote(program));
    for a in args {
        script.push(' ');
        script.push_str(&crate::wsl::sh_quote(a));
    }
    script
}

// ---- Windows: delegate to the live WSL backend ----------------------------

#[cfg(windows)]
pub fn is_isolated(cwd: Option<&str>) -> bool {
    cwd.and_then(crate::wsl::parse_wsl_unc).is_some()
}

#[cfg(windows)]
pub fn program_argv(cwd: Option<&str>, program: &str, args: &[String]) -> Option<(String, Vec<String>)> {
    let (distro, linux_cwd) = cwd.and_then(crate::wsl::parse_wsl_unc)?;
    let script = format!("cd {} && {}", crate::wsl::sh_quote(&linux_cwd), exec_script(program, args));
    Some((
        "wsl.exe".to_string(),
        vec!["-d".into(), distro, "--".into(), "bash".into(), "-lc".into(), script],
    ))
}

#[cfg(windows)]
pub fn shell_argv(cwd: Option<&str>, command: &str) -> Option<(String, Vec<String>)> {
    let (distro, linux_cwd) = cwd.and_then(crate::wsl::parse_wsl_unc)?;
    let script = crate::wsl::build_wsl_bash_script(&linux_cwd, command);
    Some((
        "wsl.exe".to_string(),
        vec!["-d".into(), distro, "--".into(), "bash".into(), "-lc".into(), script],
    ))
}

// ---- Linux: bubblewrap ----------------------------------------------------

#[cfg(target_os = "linux")]
fn engine_available(exe: &str) -> bool {
    std::process::Command::new(exe)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn sandbox_home() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let sb = format!("{home}/.owllm/sbhome");
    std::fs::create_dir_all(&sb).ok()?;
    Some(sb)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn isolated_dir(cwd: Option<&str>) -> Option<String> {
    let p = cwd?;
    if !crate::wsl::wsl_isolation_get().enabled {
        return None;
    }
    let home = std::env::var("HOME").ok()?;
    if is_under_iso_root(p, &home) {
        Some(p.to_string())
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
pub fn is_isolated(cwd: Option<&str>) -> bool {
    isolated_dir(cwd).is_some() && engine_available("bwrap")
}

#[cfg(target_os = "linux")]
pub fn program_argv(cwd: Option<&str>, program: &str, args: &[String]) -> Option<(String, Vec<String>)> {
    let dir = isolated_dir(cwd)?;
    if !engine_available("bwrap") {
        return None;
    }
    let sb = sandbox_home()?;
    let mut v = bwrap_prefix_argv(&dir, &sb, true);
    v.push("bash".into());
    v.push("-lc".into());
    v.push(exec_script(program, args));
    Some(("bwrap".to_string(), v))
}

#[cfg(target_os = "linux")]
pub fn shell_argv(cwd: Option<&str>, command: &str) -> Option<(String, Vec<String>)> {
    let dir = isolated_dir(cwd)?;
    if !engine_available("bwrap") {
        return None;
    }
    let sb = sandbox_home()?;
    let mut v = bwrap_prefix_argv(&dir, &sb, true);
    v.push("bash".into());
    v.push("-lc".into());
    v.push(command.to_string());
    Some(("bwrap".to_string(), v))
}

// ---- macOS: Lima ----------------------------------------------------------

#[cfg(target_os = "macos")]
const LIMA_INSTANCE: &str = "owllm";

#[cfg(target_os = "macos")]
fn engine_available(exe: &str) -> bool {
    std::process::Command::new(exe)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
pub fn is_isolated(cwd: Option<&str>) -> bool {
    isolated_dir(cwd).is_some() && engine_available("limactl")
}

#[cfg(target_os = "macos")]
pub fn program_argv(cwd: Option<&str>, program: &str, args: &[String]) -> Option<(String, Vec<String>)> {
    let dir = isolated_dir(cwd)?;
    if !engine_available("limactl") {
        return None;
    }
    Some(("limactl".to_string(), lima_argv(LIMA_INSTANCE, &dir, program, args)))
}

#[cfg(target_os = "macos")]
pub fn shell_argv(cwd: Option<&str>, command: &str) -> Option<(String, Vec<String>)> {
    let dir = isolated_dir(cwd)?;
    if !engine_available("limactl") {
        return None;
    }
    let bash_args = vec!["-lc".to_string(), command.to_string()];
    Some(("limactl".to_string(), lima_argv(LIMA_INSTANCE, &dir, "bash", &bash_args)))
}

// ---- other OSes: never isolated (host fallback) ---------------------------

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub fn is_isolated(_cwd: Option<&str>) -> bool {
    false
}
#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub fn program_argv(_cwd: Option<&str>, _program: &str, _args: &[String]) -> Option<(String, Vec<String>)> {
    None
}
#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub fn shell_argv(_cwd: Option<&str>, _command: &str) -> Option<(String, Vec<String>)> {
    None
}

// ---- Tauri commands (cross-platform) --------------------------------------

#[cfg(windows)]
fn status_impl() -> SandboxStatus {
    let w = crate::wsl::wsl_status();
    SandboxStatus {
        available: w.available,
        kind: "wsl".into(),
        strong: true,
        beta: false,
        targets: w.distros,
        default_target: w.default_distro,
    }
}

#[cfg(target_os = "linux")]
fn status_impl() -> SandboxStatus {
    let ok = engine_available("bwrap");
    SandboxStatus {
        available: ok,
        kind: if ok { "bubblewrap".into() } else { "none".into() },
        strong: false,
        beta: true,
        targets: Vec::new(),
        default_target: None,
    }
}

#[cfg(target_os = "macos")]
fn status_impl() -> SandboxStatus {
    let ok = engine_available("limactl");
    SandboxStatus {
        available: ok,
        kind: if ok { "lima".into() } else { "none".into() },
        strong: true,
        beta: true,
        targets: Vec::new(),
        default_target: None,
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn status_impl() -> SandboxStatus {
    SandboxStatus::default()
}

#[tauri::command]
pub fn sandbox_status() -> SandboxStatus {
    status_impl()
}

#[cfg(windows)]
fn create_impl(name: String) -> Result<SandboxProject, String> {
    let p = crate::wsl::wsl_create_project(name, None)?;
    Ok(SandboxProject {
        name: p.name,
        path: p.unc_path,
        inner_path: p.linux_path,
        kind: "wsl".into(),
    })
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn create_impl(name: String) -> Result<SandboxProject, String> {
    let safe = sanitize_name(&name);
    if safe.is_empty() {
        return Err("invalid project name".into());
    }
    let home = std::env::var("HOME").map_err(|_| "no HOME directory".to_string())?;
    let path = format!("{home}/{ISO_SUBDIR}/{safe}");
    std::fs::create_dir_all(&path).map_err(|e| format!("mkdir {path}: {e}"))?;
    Ok(SandboxProject {
        name: safe,
        path: path.clone(),
        inner_path: path,
        kind: status_impl().kind,
    })
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn create_impl(_name: String) -> Result<SandboxProject, String> {
    Err("isolation is not supported on this platform".into())
}

#[tauri::command]
pub fn sandbox_create_project(name: String) -> Result<SandboxProject, String> {
    create_impl(name)
}

#[cfg(windows)]
fn list_impl() -> Vec<SandboxProject> {
    crate::wsl::wsl_list_projects(None)
        .unwrap_or_default()
        .into_iter()
        .map(|p| SandboxProject {
            name: p.name,
            path: p.unc_path,
            inner_path: p.linux_path,
            kind: "wsl".into(),
        })
        .collect()
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn list_impl() -> Vec<SandboxProject> {
    let Ok(home) = std::env::var("HOME") else {
        return Vec::new();
    };
    let root = format!("{home}/{ISO_SUBDIR}");
    let kind = status_impl().kind;
    let mut v = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&root) {
        for e in rd.flatten() {
            if e.path().is_dir() {
                let path = e.path().to_string_lossy().to_string();
                v.push(SandboxProject {
                    name: e.file_name().to_string_lossy().to_string(),
                    path: path.clone(),
                    inner_path: path,
                    kind: kind.clone(),
                });
            }
        }
    }
    v
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn list_impl() -> Vec<SandboxProject> {
    Vec::new()
}

#[tauri::command]
pub fn sandbox_list_projects() -> Vec<SandboxProject> {
    list_impl()
}

// ---- provisioning ---------------------------------------------------------

#[cfg(target_os = "linux")]
fn which(p: &str) -> bool {
    std::process::Command::new("sh")
        .arg("-c")
        .arg(format!("command -v {p}"))
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn run_capture(exe: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new(exe)
        .args(args)
        .output()
        .map_err(|e| format!("{exe}: {e}"))?;
    let so = String::from_utf8_lossy(&out.stdout);
    let se = String::from_utf8_lossy(&out.stderr);
    if out.status.success() {
        Ok(format!("{so}{se}"))
    } else {
        Err(format!(
            "{exe} exited {}: {}",
            out.status.code().unwrap_or(-1),
            if se.trim().is_empty() { so.trim() } else { se.trim() }
        ))
    }
}

/// Install the bubblewrap engine + agent toolchain on Linux. Elevation via
/// pkexec (the desktop sudo prompt); falls back to printable instructions when
/// pkexec is absent. BETA — not yet runtime-verified on real hardware.
#[cfg(target_os = "linux")]
fn linux_provision() -> Result<String, String> {
    let inst = if which("apt-get") {
        "apt-get update -y && apt-get install -y bubblewrap nodejs npm git curl ca-certificates"
    } else if which("dnf") {
        "dnf install -y bubblewrap nodejs npm git curl"
    } else if which("pacman") {
        "pacman -Sy --noconfirm bubblewrap nodejs npm git curl"
    } else {
        return Err("No supported package manager (apt/dnf/pacman). Install bubblewrap, node, git manually.".into());
    };
    let script = format!(
        "set -e; {inst}; export UV_INSTALL_DIR=/usr/local/bin; \
         (curl -LsSf https://astral.sh/uv/install.sh | sh) || true; \
         npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli || true; \
         echo PROVISION_DONE"
    );
    if which("pkexec") {
        run_capture("pkexec", &["bash", "-lc", &script])
    } else {
        Err(format!("Root required and pkexec not found. Run in a terminal:\n  sudo bash -lc '{script}'"))
    }
}

#[cfg(target_os = "macos")]
const MAC_PROVISION_HELP: &str = "macOS isolation (beta) uses a Lima Linux VM. One-time setup:\n\
    1) brew install lima\n\
    2) limactl start --name owllm\n\
    3) (inside) install node, git and the agent CLIs\n\
Once `limactl` is present, OwLLM routes isolated projects through it automatically.\n\
Note: harden the Lima mounts to expose only ~/owllm before trusting isolation.";

/// Install/repair the isolation engine + toolchain. Windows delegates to the
/// live WSL provisioner; Linux attempts bubblewrap + toolchain via pkexec;
/// macOS returns Lima setup instructions (beta).
#[tauri::command]
pub async fn sandbox_provision() -> Result<String, String> {
    #[cfg(windows)]
    {
        crate::wsl::wsl_provision(None).await
    }
    #[cfg(target_os = "linux")]
    {
        tokio::task::spawn_blocking(linux_provision)
            .await
            .map_err(|e| format!("join error: {e}"))?
    }
    #[cfg(target_os = "macos")]
    {
        Ok(MAC_PROVISION_HELP.to_string())
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        Err("isolation is not supported on this platform".to_string())
    }
}

// ---- login sync (host CLI creds → sandbox) --------------------------------

#[cfg(windows)]
fn win_to_mnt(p: &str) -> Result<String, String> {
    let p = p.replace('\\', "/");
    let b = p.as_bytes();
    if b.len() >= 2 && b[1] == b':' {
        Ok(format!("/mnt/{}{}", (b[0] as char).to_ascii_lowercase(), &p[2..]))
    } else {
        Err(format!("not a Windows path: {p}"))
    }
}

/// Mirror the user's host CLI logins (codex/claude/gemini) into the sandbox so
/// isolated agents are authenticated without a separate in-sandbox login —
/// the same consented host→sandbox bridge as GitHub connect. Windows copies
/// the auth files from the Windows home (reached via /mnt) into the distro home.
#[cfg(windows)]
fn sync_logins_impl(distro: Option<String>) -> Result<Vec<String>, String> {
    let distro = distro
        .or_else(|| crate::wsl::wsl_status().default_distro)
        .ok_or_else(|| "no WSL distro".to_string())?;
    let home = std::env::var("USERPROFILE").map_err(|_| "no USERPROFILE".to_string())?;

    // Build the API-key env file: every saved provider key becomes an
    // `export` so any CLI/agent in the distro can reach it (covers key-authed
    // CLIs + the OpenAI-compatible providers that have no OAuth login file).
    let secrets = crate::accounts::all_secrets();
    let mut env_lines = String::new();
    for k in [
        "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "MOONSHOT_API_KEY", "DEEPSEEK_API_KEY",
        "XAI_API_KEY", "GROQ_API_KEY", "PERPLEXITY_API_KEY", "MISTRAL_API_KEY",
        "TOGETHER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "HF_TOKEN",
    ] {
        if let Some(v) = secrets.get(k) {
            if !v.trim().is_empty() {
                env_lines.push_str(&format!("export {k}={}\n", crate::wsl::sh_quote(v.trim())));
            }
        }
    }
    let env_quoted = crate::wsl::sh_quote(&env_lines);
    // Convert the Windows home to /mnt via wslpath INSIDE the distro — canonical,
    // avoids any hand-rolled path quirk. Copy unconditionally (best-effort), then
    // report `syn` from what actually LANDED in the distro home, so the status is
    // always truthful (never claims a sync that didn't copy).
    let up = crate::wsl::sh_quote(&home);
    let script = format!(
        "WH=$(wslpath -u {up} 2>/dev/null); \
         mkdir -p ~/.codex ~/.claude ~/.gemini ~/.kimi ~/.owllm; \
         cp -f \"$WH/.codex/auth.json\" ~/.codex/ 2>/dev/null; cp -f \"$WH/.codex/config.toml\" ~/.codex/ 2>/dev/null; \
         cp -f \"$WH/.claude/.credentials.json\" ~/.claude/.credentials.json 2>/dev/null; cp -f \"$WH/.claude.json\" ~/.claude.json 2>/dev/null; \
         cp -rf \"$WH/.gemini/.\" ~/.gemini/ 2>/dev/null; \
         cp -rf \"$WH/.kimi/.\" ~/.kimi/ 2>/dev/null; \
         printf '%s' {env_quoted} > ~/.owllm/agent_env.sh; chmod 600 ~/.owllm/agent_env.sh 2>/dev/null; \
         chmod 600 ~/.codex/auth.json ~/.claude/.credentials.json ~/.kimi/config.toml 2>/dev/null; \
         syn=''; \
         [ -f ~/.codex/auth.json ] && syn=\"$syn codex\"; \
         [ -f ~/.claude/.credentials.json ] && syn=\"$syn claude\"; \
         [ -d ~/.gemini ] && [ -n \"$(ls -A ~/.gemini 2>/dev/null)\" ] && syn=\"$syn gemini\"; \
         [ -f ~/.kimi/config.toml ] && syn=\"$syn kimi\"; \
         [ -s ~/.owllm/agent_env.sh ] && syn=\"$syn keys\"; \
         grep -q 'owllm/agent_env.sh' ~/.profile 2>/dev/null || echo '[ -f \"$HOME/.owllm/agent_env.sh\" ] && . \"$HOME/.owllm/agent_env.sh\"' >> ~/.profile; \
         echo \"SYNCED:$syn\""
    );
    let out = crate::wsl::run_in_distro(&distro, &script)?;
    Ok(out
        .lines()
        .find_map(|l| l.strip_prefix("SYNCED:"))
        .unwrap_or("")
        .split_whitespace()
        .map(|s| s.to_string())
        .collect())
}

/// Which provider logins are present INSIDE the sandbox right now (codex/claude/
/// gemini/kimi files + "keys" if the API-key env file is non-empty). Used by the
/// New-project dialog to show account status, and to confirm a sync landed.
#[cfg(windows)]
fn login_status_impl(distro: Option<String>) -> Vec<String> {
    let Some(distro) = distro.or_else(|| crate::wsl::wsl_status().default_distro) else {
        return Vec::new();
    };
    let script = "s=''; \
        [ -f ~/.codex/auth.json ] && s=\"$s codex\"; \
        [ -f ~/.claude/.credentials.json ] && s=\"$s claude\"; \
        [ -d ~/.gemini ] && [ -n \"$(ls -A ~/.gemini 2>/dev/null)\" ] && s=\"$s gemini\"; \
        [ -f ~/.kimi/config.toml ] && s=\"$s kimi\"; \
        [ -s ~/.owllm/agent_env.sh ] && s=\"$s keys\"; \
        echo \"LOGINS:$s\"";
    crate::wsl::run_in_distro(&distro, script)
        .ok()
        .and_then(|o| o.lines().find_map(|l| l.strip_prefix("LOGINS:")).map(|s| s.to_string()))
        .unwrap_or_default()
        .split_whitespace()
        .map(|s| s.to_string())
        .collect()
}

#[cfg(not(windows))]
fn login_status_impl(_distro: Option<String>) -> Vec<String> {
    Vec::new()
}

#[tauri::command]
pub fn sandbox_login_status(distro: Option<String>) -> Vec<String> {
    login_status_impl(distro)
}

/// Convert a project between isolated and host. COPIES (never moves) the files
/// across the boundary and returns the new project to open; the original is left
/// intact for the user to remove. Isolated→host copies into
/// %USERPROFILE%\OwLLM-Projects\<name>; host→isolated copies into ~/owllm/<name>
/// in the distro. WSL (Windows) only for now.
#[cfg(windows)]
fn convert_impl(current: String) -> Result<SandboxProject, String> {
    let q = crate::wsl::sh_quote;
    if let Some((d, linux)) = crate::wsl::parse_wsl_unc(&current) {
        // isolated → host
        let name = linux.trim_end_matches('/').rsplit('/').next().unwrap_or("project").to_string();
        let home = std::env::var("USERPROFILE").map_err(|_| "no USERPROFILE".to_string())?;
        let dest_win = format!("{home}\\OwLLM-Projects\\{name}");
        let dest_mnt = win_to_mnt(&dest_win)?;
        let script = format!("mkdir -p {dst} && cp -rf {src}/. {dst}/ && echo OK",
            src = q(linux.trim_end_matches('/')), dst = q(&dest_mnt));
        crate::wsl::run_in_distro(&d, &script)?;
        Ok(SandboxProject { name, path: dest_win.clone(), inner_path: dest_win, kind: "none".into() })
    } else {
        // host → isolated
        let distro = crate::wsl::wsl_status().default_distro
            .ok_or_else(|| "no WSL distro".to_string())?;
        let base = current.trim_end_matches(['\\', '/']).rsplit(['\\', '/']).next().unwrap_or("project");
        // create_impl on Windows delegates to wsl_create_project, which sanitizes.
        let p = create_impl(base.to_string())?;
        let src_mnt = win_to_mnt(&current)?;
        let script = format!("cp -rf {src}/. {dst}/ && echo OK",
            src = q(src_mnt.trim_end_matches('/')), dst = q(&p.inner_path));
        crate::wsl::run_in_distro(&distro, &script)?;
        Ok(p)
    }
}

#[cfg(not(windows))]
fn convert_impl(_current: String) -> Result<SandboxProject, String> {
    Err("project conversion is currently implemented for WSL (Windows) only".to_string())
}

#[tauri::command]
pub fn sandbox_convert_project(current: String) -> Result<SandboxProject, String> {
    convert_impl(current)
}

#[cfg(not(windows))]
fn sync_logins_impl(_distro: Option<String>) -> Result<Vec<String>, String> {
    Err("login sync is currently implemented for WSL (Windows) only".to_string())
}

/// Returns the list of providers whose login was mirrored (e.g. ["codex","claude"]).
#[tauri::command]
pub fn sandbox_sync_logins(distro: Option<String>) -> Result<Vec<String>, String> {
    sync_logins_impl(distro)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn win_path_to_mnt() {
        assert_eq!(win_to_mnt("C:\\Users\\mc").unwrap(), "/mnt/c/Users/mc");
        assert_eq!(win_to_mnt("D:\\a\\b").unwrap(), "/mnt/d/a/b");
    }

    #[test]
    fn iso_root_matching() {
        assert!(is_under_iso_root("/home/me/owllm/proj", "/home/me"));
        assert!(is_under_iso_root("/home/me/owllm", "/home/me"));
        assert!(is_under_iso_root("/home/me/owllm/proj/sub", "/home/me"));
        assert!(!is_under_iso_root("/home/me/other", "/home/me"));
        assert!(!is_under_iso_root("/home/me/owllmx", "/home/me")); // not a prefix dir
        assert!(!is_under_iso_root("/etc/passwd", "/home/me"));
    }

    #[test]
    fn bwrap_prefix_binds_project_and_home_not_real_home() {
        let a = bwrap_prefix_argv("/home/me/owllm/p", "/home/me/.owllm/sbhome", true);
        let joined = a.join(" ");
        assert!(joined.contains("--bind /home/me/owllm/p /home/me/owllm/p"));
        assert!(joined.contains("--chdir /home/me/owllm/p"));
        assert!(joined.contains("--setenv HOME /home/me/.owllm/sbhome"));
        // real home is never bound wholesale
        assert!(!joined.contains("--bind /home/me /home/me"));
        // net shared when allowed
        assert!(!joined.contains("--unshare-net"));
    }

    #[test]
    fn bwrap_prefix_can_isolate_net() {
        let a = bwrap_prefix_argv("/p", "/sb", false);
        assert!(a.join(" ").contains("--unshare-net"));
    }

    #[test]
    fn lima_argv_shape() {
        let a = lima_argv("owllm", "/Users/me/owllm/p", "claude", &["-p".into(), "hi".into()]);
        assert_eq!(
            a,
            vec!["shell", "--workdir", "/Users/me/owllm/p", "owllm", "claude", "-p", "hi"]
        );
    }
}
