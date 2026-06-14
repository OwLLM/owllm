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
    /// Folder-confinement is active: agents see ONLY the project folder, not the
    /// rest of the C: drive / distro home. On Windows this needs bubblewrap in
    /// the distro (install via Harden); without it the agent still runs in WSL
    /// but can see all of /mnt. On Linux this IS bubblewrap; on macOS, Lima.
    pub confined: bool,
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
            confined: false,
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
//
// Plain WSL routing (`bash -lc "cd /mnt/c/proj && cmd"`) makes the agent a
// Linux process, but it can still see the WHOLE distro home AND all of /mnt
// (the entire C: drive — every other project, ~/.ssh on /mnt, etc.). To truly
// confine an agent to ONLY the project folder we run the command through
// bubblewrap INSIDE the distro: bind ONLY the project (the user's REAL Windows
// folder, live via /mnt — no copy), a dedicated sandbox HOME, and the agent's
// own credential files; hide the rest of /mnt and the rest of $HOME; unshare
// namespaces. Validated on real WSL2 (kernel 6.18, unprivileged userns): the
// agent sees its project + toolchain (/usr) + its logins and nothing else, and
// its writes land in the real Windows folder. When bubblewrap isn't installed
// we fall back to the plain routing below — no regression, just less sealed.

/// The sandbox runner installed once inside the distro at
/// `~/.owllm/run-sandboxed.sh`. Invoked as `run-sandboxed.sh <cwd> <command>`.
/// Authored as a FILE so its dense nested quoting never crosses the
/// Windows→wsl.exe command-line handoff (which mangles complex `-lc` strings —
/// see wsl.rs): only a short bootstrap + two CLEAN argv elements (cwd, command)
/// make that trip, so the command's own quotes/spaces/`&&` stay intact.
#[cfg(windows)]
const SANDBOX_RUNNER: &str = r#"#!/bin/bash
# OwLLM agent sandbox — confine the agent to ONLY this project folder.
# args are base64 so NO shell metacharacter ever crosses the Windows→wsl.exe
# command-line handoff (which mangles nested quotes — verified). Decode here.
CWD="$(printf %s "$1" | base64 -d)"; CMD="$(printf %s "$2" | base64 -d)"
SB="$HOME/.owllm/sbhome"
mkdir -p "$SB" "$SB/.owllm" 2>/dev/null
exec bwrap \
  --ro-bind-try /usr /usr --ro-bind-try /bin /bin --ro-bind-try /sbin /sbin \
  --ro-bind-try /lib /lib --ro-bind-try /lib32 /lib32 --ro-bind-try /lib64 /lib64 \
  --ro-bind-try /etc /etc --ro-bind-try /opt /opt --ro-bind-try /snap /snap \
  --proc /proc --dev /dev --tmpfs /tmp \
  --bind "$SB" "$SB" --setenv HOME "$SB" \
  --bind-try "$HOME/.codex" "$SB/.codex" \
  --bind-try "$HOME/.claude" "$SB/.claude" \
  --bind-try "$HOME/.claude.json" "$SB/.claude.json" \
  --bind-try "$HOME/.gemini" "$SB/.gemini" \
  --bind-try "$HOME/.kimi" "$SB/.kimi" \
  --bind-try "$HOME/.owllm/agent_env.sh" "$SB/.owllm/agent_env.sh" \
  --bind "$CWD" "$CWD" --chdir "$CWD" \
  --unshare-user-try --unshare-ipc --unshare-pid --unshare-uts --unshare-cgroup-try \
  --die-with-parent --new-session \
  bash -lc '[ -f "$HOME/.owllm/agent_env.sh" ] && . "$HOME/.owllm/agent_env.sh" 2>/dev/null; '"$CMD"
"#;

#[cfg(windows)]
fn sandbox_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, bool>> {
    static C: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, bool>>> =
        std::sync::OnceLock::new();
    C.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Ensure the runner is installed in `distro` and report whether bubblewrap is
/// available there (i.e. folder-confinement is ready). Cached per distro for the
/// process lifetime: the FIRST isolated command per distro pays one ~150ms probe
/// + idempotent runner write; every later command is free. Installs only the
/// lightweight runner (user-level, fast) — bubblewrap itself is installed by
/// provisioning or the explicit Harden action, never lazily in the hot path.
#[cfg(windows)]
fn ensure_sandbox(distro: &str) -> bool {
    if let Some(v) = sandbox_cache().lock().unwrap().get(distro).copied() {
        return v;
    }
    // Heredoc with a quoted delimiter keeps the runner body byte-for-byte; piped
    // over stdin by run_in_distro_script (mangle-proof). Always (re)writes the
    // runner so an upgraded body lands, then reports bwrap presence.
    let script = format!(
        "mkdir -p \"$HOME/.owllm\"; cat > \"$HOME/.owllm/run-sandboxed.sh\" <<'OWLLM_RUNNER_EOF'\n{SANDBOX_RUNNER}OWLLM_RUNNER_EOF\nchmod +x \"$HOME/.owllm/run-sandboxed.sh\"; command -v bwrap >/dev/null 2>&1 && echo OWLLM_BWRAP=yes || echo OWLLM_BWRAP=no"
    );
    // Cache only DEFINITIVE answers. A cold/transient WSL hiccup must NOT poison
    // the cache with `false` — that would silently un-confine agents for the
    // whole session (the cold-start trap that has bitten WSL probes before).
    // On an ambiguous/errored probe, return false for THIS call (safe fallback
    // to plain routing) but don't cache, so the next command re-probes.
    match crate::wsl::run_in_distro_script(distro, &script) {
        Ok(o) if o.contains("OWLLM_BWRAP=yes") => {
            sandbox_cache().lock().unwrap().insert(distro.to_string(), true);
            true
        }
        Ok(o) if o.contains("OWLLM_BWRAP=no") => {
            sandbox_cache().lock().unwrap().insert(distro.to_string(), false);
            false
        }
        _ => false, // probe failed / ambiguous — fall back once, re-probe next time
    }
}

/// Install bubblewrap in `distro` as root (wsl `-u root` — no sudo password,
/// per wsl.rs) and bust the readiness cache so the next command picks up the
/// new confinement. Idempotent.
#[cfg(windows)]
fn install_bwrap(distro: &str) -> Result<(), String> {
    crate::wsl::run_in_distro_script_user(
        distro,
        Some("root"),
        "export DEBIAN_FRONTEND=noninteractive; \
         (apt-get install -y bubblewrap >/dev/null 2>&1 || (apt-get update -y && apt-get install -y bubblewrap)); \
         command -v bwrap >/dev/null 2>&1 && echo OWLLM_BWRAP_OK || { echo OWLLM_BWRAP_FAIL; exit 1; }",
    )?;
    sandbox_cache().lock().unwrap().remove(distro);
    Ok(())
}

/// Run `command` through the sandbox runner inside `distro`. The cwd + command
/// are passed BASE64-ENCODED to the runner, so the `-lc` script is entirely
/// quote-free (`exec $HOME/.owllm/run-sandboxed.sh <b64> <b64>`). This is the one
/// transport robust to ANY command: trailing args don't survive wsl.exe, and an
/// sh-quoted script with mixed `'`/`"`/`$()` gets mangled by Rust's arg-escaping
/// colliding with wsl.exe's re-parsing — base64 has no metacharacters, so
/// nothing can be re-split (same trick wsl_setup.rs uses to pass the WSL
/// password in). The runner decodes both before use.
#[cfg(windows)]
fn runner_argv(distro: &str, linux_cwd: &str, command: &str) -> (String, Vec<String>) {
    use base64::Engine as _;
    let b64 = |s: &str| base64::engine::general_purpose::STANDARD.encode(s.as_bytes());
    let script = format!(
        "exec $HOME/.owllm/run-sandboxed.sh {} {}",
        b64(linux_cwd),
        b64(command),
    );
    (
        "wsl.exe".to_string(),
        vec!["-d".into(), distro.into(), "--".into(), "bash".into(), "-lc".into(), script],
    )
}

#[cfg(windows)]
pub fn is_isolated(cwd: Option<&str>) -> bool {
    cwd.and_then(crate::wsl::parse_wsl_unc).is_some()
}

#[cfg(windows)]
pub fn program_argv(cwd: Option<&str>, program: &str, args: &[String]) -> Option<(String, Vec<String>)> {
    let (distro, linux_cwd) = cwd.and_then(crate::wsl::parse_wsl_unc)?;
    if ensure_sandbox(&distro) {
        return Some(runner_argv(&distro, &linux_cwd, &exec_script(program, args)));
    }
    // Fallback: bubblewrap not present — plain WSL routing (Linux process, but
    // not folder-confined). The Harden action installs bwrap to seal it.
    let script = format!("cd {} && {}", crate::wsl::sh_quote(&linux_cwd), exec_script(program, args));
    Some((
        "wsl.exe".to_string(),
        vec!["-d".into(), distro, "--".into(), "bash".into(), "-lc".into(), script],
    ))
}

#[cfg(windows)]
pub fn shell_argv(cwd: Option<&str>, command: &str) -> Option<(String, Vec<String>)> {
    let (distro, linux_cwd) = cwd.and_then(crate::wsl::parse_wsl_unc)?;
    if ensure_sandbox(&distro) {
        return Some(runner_argv(&distro, &linux_cwd, command));
    }
    let script = crate::wsl::build_wsl_bash_script(&linux_cwd, command);
    Some((
        "wsl.exe".to_string(),
        vec!["-d".into(), distro, "--".into(), "bash".into(), "-lc".into(), script],
    ))
}

// ---- auto-clean a deleted project's sandbox footprint ---------------------
//
// SAFETY: only ever removes a sandbox COPY that OwLLM itself created under the
// managed `~/owllm/<name>` root. A `/mnt/...` location is the user's REAL
// Windows folder (isolate-in-place) and is NEVER touched — deleting an OwLLM
// project must not delete the user's source. Frees the LOGICAL space inside the
// distro; the .vhdx file shrinks only on an explicit compaction (which needs a
// `wsl --shutdown`), so that stays a deliberate manual action, never automatic.

/// True only for an OwLLM-managed sandbox copy path `…/owllm/<name>` (exactly one
/// level under the managed root) — never `/mnt/*` (the user's drive) or the root
/// itself. Pure + unit-tested.
pub fn is_managed_sandbox_copy(linux_path: &str) -> bool {
    if linux_path.starts_with("/mnt/") {
        return false;
    }
    match linux_path.split(&format!("/{ISO_SUBDIR}/")).nth(1) {
        Some(rest) => {
            let name = rest.trim_matches('/');
            !name.is_empty() && !name.contains('/')
        }
        None => false,
    }
}

/// Remove a deleted project's sandbox copy (if any). No-op for the user's own
/// Windows/host folders. Best-effort: a cleanup failure must not block the
/// delete, so errors are swallowed.
#[cfg(windows)]
pub fn cleanup_deleted_project(location: &str) {
    if let Some((distro, linux)) = crate::wsl::parse_wsl_unc(location) {
        let dir = linux.trim_end_matches('/');
        if is_managed_sandbox_copy(dir) {
            let script = format!("rm -rf {}", crate::wsl::sh_quote(dir));
            let _ = crate::wsl::run_in_distro_script(&distro, &script);
        }
    }
}

#[cfg(not(windows))]
pub fn cleanup_deleted_project(location: &str) {
    let dir = location.trim_end_matches('/');
    if is_managed_sandbox_copy(dir) {
        let _ = std::fs::remove_dir_all(dir);
    }
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
    // Report the distro the sandbox will actually use (best_linux_distro —
    // never docker-desktop); fall back to the raw default for display when
    // only system distros exist.
    let default_target = crate::wsl::best_linux_distro().or(w.default_distro);
    // Folder-confinement is ready when the target distro has bubblewrap (+ the
    // runner, installed idempotently by ensure_sandbox). Probed once per distro
    // then cached, so polling status is cheap.
    let confined = default_target.as_deref().map(ensure_sandbox).unwrap_or(false);
    SandboxStatus {
        available: w.available,
        kind: "wsl".into(),
        strong: true,
        beta: false,
        confined,
        targets: w.distros,
        default_target,
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
        confined: ok, // bubblewrap IS the folder-confinement on Linux
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
        confined: ok, // Lima is a VM — confinement comes with availability
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

/// Turn ON folder-confinement: install the isolation engine in the sandbox so
/// agents see ONLY the project folder (not the rest of the C: drive / distro
/// home). Windows installs bubblewrap in the distro (apt as root — no password)
/// and re-probes; Linux installs bubblewrap via the provisioner; macOS reports
/// Lima setup. Returns the refreshed status so the UI can confirm `confined`.
/// Idempotent — safe to call when already sealed.
#[cfg(windows)]
fn harden_impl(distro: Option<String>) -> Result<SandboxStatus, String> {
    let distro = distro
        .filter(|d| !d.trim().is_empty())
        .or_else(crate::wsl::best_linux_distro)
        .ok_or_else(|| "No Ubuntu/Linux distro in WSL — set it up on the Home page first.".to_string())?;
    install_bwrap(&distro)?;
    if !ensure_sandbox(&distro) {
        return Err("bubblewrap installed but isn't runnable in this distro — folder-confinement unavailable.".to_string());
    }
    Ok(status_impl())
}

#[cfg(target_os = "linux")]
fn harden_impl(_distro: Option<String>) -> Result<SandboxStatus, String> {
    if engine_available("bwrap") {
        return Ok(status_impl());
    }
    linux_provision()?;
    Ok(status_impl())
}

#[cfg(target_os = "macos")]
fn harden_impl(_distro: Option<String>) -> Result<SandboxStatus, String> {
    Err(MAC_PROVISION_HELP.to_string())
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn harden_impl(_distro: Option<String>) -> Result<SandboxStatus, String> {
    Err("isolation is not supported on this platform".to_string())
}

#[tauri::command]
pub async fn sandbox_harden(distro: Option<String>) -> Result<SandboxStatus, String> {
    // apt / provisioning is blocking — keep the UI responsive.
    tokio::task::spawn_blocking(move || harden_impl(distro))
        .await
        .map_err(|e| format!("join error: {e}"))?
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
/// Result of a login sync: what was synced INTO the sandbox, and what was
/// FOUND on the Windows host (the source). Reporting both makes the outcome
/// self-explaining instead of a silent "nothing happened".
#[derive(serde::Serialize, Clone, Debug)]
pub struct SyncResult {
    pub synced: Vec<String>,
    pub found_on_host: Vec<String>,
    /// Per-credential mirror status — one row per provider (P1-2): what
    /// mirrored, what didn't, and why, instead of two bare lists the user
    /// has to diff mentally.
    pub report: Vec<MirrorStatus>,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MirrorStatus {
    /// codex | claude | gemini | kimi | keys
    pub provider: String,
    pub on_host: bool,
    pub in_sandbox: bool,
    /// Human-readable outcome ("mirrored", "did NOT land — …", "not logged in …").
    pub detail: String,
}

/// Pure mapping: (found-on-host set, landed-in-sandbox set) → one status row
/// per provider. Unit-tested; shared wording for every sync surface.
#[cfg_attr(not(windows), allow(dead_code))] // sync is WSL/Windows-only today
fn build_mirror_report(found_on_host: &[String], synced: &[String]) -> Vec<MirrorStatus> {
    const PROVIDERS: [&str; 5] = ["codex", "claude", "gemini", "kimi", "keys"];
    PROVIDERS
        .iter()
        .map(|p| {
            let on_host = found_on_host.iter().any(|s| s == p);
            let in_sandbox = synced.iter().any(|s| s == p);
            let what = if *p == "keys" { "API keys" } else { "login" };
            let detail = match (on_host, in_sandbox) {
                (true, true) => "mirrored into the sandbox".to_string(),
                (true, false) => format!(
                    "{what} found on Windows but did NOT land in the sandbox — check the WSL distro (Set up WSL on Home), then Sync logins again"
                ),
                (false, true) => "present in the sandbox (no Windows copy — synced earlier or logged in inside the distro)".to_string(),
                (false, false) => format!("no {what} on Windows — log in there first, then sync"),
            };
            MirrorStatus { provider: p.to_string(), on_host, in_sandbox, detail }
        })
        .collect()
}

#[cfg(windows)]
fn sync_logins_impl(distro: Option<String>) -> Result<SyncResult, String> {
    // Resolve a REAL Linux distro (skip docker-desktop etc.) so the logins
    // land in the SAME distro projects and envs run in — syncing into the raw
    // default on a Docker-default machine puts the creds where nothing reads
    // them (and busybox has no bash to run the script anyway).
    let distro = distro
        .filter(|d| !d.trim().is_empty())
        .or_else(crate::wsl::best_linux_distro)
        .ok_or_else(|| "no Ubuntu/Linux distro in WSL — isolation needs Ubuntu (set it up on the Home page).".to_string())?;
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
    // Convert the Windows home to /mnt in Rust via win_to_mnt (same helper
    // convert_impl uses, unit-tested). The previous in-bash `wslpath -u
    // 'C:\Users\..'` returned EMPTY for a backslash Windows path, so WH was ""
    // and every cp failed silently — the sync "did nothing". Copy
    // unconditionally (best-effort), then report `syn` from what actually
    // LANDED in the distro home, so the status is always truthful.
    let wh = crate::wsl::sh_quote(&win_to_mnt(&home)?);
    // FOUND = what exists on the Windows side (the source, via /mnt); SYNCED =
    // what actually landed in the distro home. Reporting both makes the result
    // self-explaining: "Windows has codex but nothing synced" vs "nothing on
    // Windows to sync" are now distinguishable instead of a silent no-op.
    let script = format!(
        "WH={wh}; \
         mkdir -p ~/.codex ~/.claude ~/.gemini ~/.kimi ~/.owllm; \
         found=''; \
         [ -f \"$WH/.codex/auth.json\" ] && found=\"$found codex\"; \
         [ -f \"$WH/.claude/.credentials.json\" ] && found=\"$found claude\"; \
         [ -d \"$WH/.gemini\" ] && [ -n \"$(ls -A \"$WH/.gemini\" 2>/dev/null)\" ] && found=\"$found gemini\"; \
         [ -f \"$WH/.kimi/config.toml\" ] && found=\"$found kimi\"; \
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
         echo \"FOUND:$found\"; echo \"SYNCED:$syn\""
    );
    // Pipe via STDIN (run_in_distro_script), NOT as a `-lc "<script>"` arg —
    // this complex nested-quote script was getting mangled by the Windows
    // command-line handoff, which is why the copy "did nothing" even though the
    // bash logic + the /mnt source are both correct (proven by hand).
    let out = crate::wsl::run_in_distro_script(&distro, &script)?;
    let parse = |key: &str| -> Vec<String> {
        out.lines()
            .find_map(|l| l.strip_prefix(key))
            .unwrap_or("")
            .split_whitespace()
            .map(|s| s.to_string())
            .collect()
    };
    let mut found_on_host = parse("FOUND:");
    // Host API keys live in agent_secrets (not on the /mnt path the script
    // sees), so add "keys" to the host-found set when any are saved.
    if !env_lines.trim().is_empty() {
        found_on_host.push("keys".into());
    }
    let synced = parse("SYNCED:");
    let report = build_mirror_report(&found_on_host, &synced);
    Ok(SyncResult { synced, found_on_host, report })
}

/// Which provider logins are present INSIDE the sandbox right now (codex/claude/
/// gemini/kimi files + "keys" if the API-key env file is non-empty). Used by the
/// New-project dialog to show account status, and to confirm a sync landed.
#[cfg(windows)]
fn login_status_impl(distro: Option<String>) -> Vec<String> {
    // Same distro resolution as sync_logins_impl — status must be read from
    // the distro the sync writes into, not the raw default.
    let Some(distro) = distro
        .filter(|d| !d.trim().is_empty())
        .or_else(crate::wsl::best_linux_distro)
    else {
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
    // Verify the copy via a SENTINEL in the output, not the exit code alone —
    // login-shell noise can't fake `OWLLM_COPIED=1`, and a mangled/empty
    // script that "succeeds" without copying anything is caught (§0.5).
    let assert_copied = |out: &str| -> Result<(), String> {
        if out.lines().any(|l| l.trim() == "OWLLM_COPIED=1") {
            Ok(())
        } else {
            Err(format!(
                "project copy did not complete. Output: {}",
                out.trim().chars().take(240).collect::<String>()
            ))
        }
    };
    if let Some((d, linux)) = crate::wsl::parse_wsl_unc(&current) {
        // isolated → host
        let name = linux.trim_end_matches('/').rsplit('/').next().unwrap_or("project").to_string();
        let home = std::env::var("USERPROFILE").map_err(|_| "no USERPROFILE".to_string())?;
        let dest_win = format!("{home}\\OwLLM-Projects\\{name}");
        let dest_mnt = win_to_mnt(&dest_win)?;
        let script = format!("mkdir -p {dst} && cp -rf {src}/. {dst}/ && echo OWLLM_COPIED=1",
            src = q(linux.trim_end_matches('/')), dst = q(&dest_mnt));
        let out = crate::wsl::run_in_distro(&d, &script)?;
        assert_copied(&out)?;
        Ok(SandboxProject { name, path: dest_win.clone(), inner_path: dest_win, kind: "none".into() })
    } else {
        // host → isolated
        let base = current.trim_end_matches(['\\', '/']).rsplit(['\\', '/']).next().unwrap_or("project");
        // create_impl on Windows delegates to wsl_create_project, which both
        // sanitizes the name and resolves a REAL Linux distro. Run the copy in
        // the distro the project was actually created in (parsed back from its
        // UNC path) — resolving the raw default here used to copy in a
        // DIFFERENT distro (docker-desktop) than the one holding the project.
        let p = create_impl(base.to_string())?;
        let (distro, _) = crate::wsl::parse_wsl_unc(&p.path)
            .ok_or_else(|| format!("created project has a non-WSL path: {}", p.path))?;
        let src_mnt = win_to_mnt(&current)?;
        let script = format!("cp -rf {src}/. {dst}/ && echo OWLLM_COPIED=1",
            src = q(src_mnt.trim_end_matches('/')), dst = q(&p.inner_path));
        let out = crate::wsl::run_in_distro(&distro, &script)?;
        assert_copied(&out)?;
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
fn sync_logins_impl(_distro: Option<String>) -> Result<SyncResult, String> {
    Err("login sync is currently implemented for WSL (Windows) only".to_string())
}


/// Mirror host logins into the sandbox. Returns what synced AND what was
/// found on the Windows host, so the UI can explain the outcome precisely.
#[tauri::command]
pub fn sandbox_sync_logins(distro: Option<String>) -> Result<SyncResult, String> {
    sync_logins_impl(distro)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mirror_report_covers_every_state() {
        let found = vec!["codex".to_string(), "claude".to_string(), "keys".to_string()];
        let synced = vec!["claude".to_string(), "gemini".to_string(), "keys".to_string()];
        let r = build_mirror_report(&found, &synced);
        assert_eq!(r.len(), 5, "one row per provider");
        let get = |p: &str| r.iter().find(|m| m.provider == p).unwrap();
        // found + synced → mirrored
        assert!(get("claude").detail.contains("mirrored"));
        assert!(get("keys").detail.contains("mirrored"));
        // found + NOT synced → loud failure with a next step
        let codex = get("codex");
        assert!(codex.on_host && !codex.in_sandbox);
        assert!(codex.detail.contains("did NOT land"), "{}", codex.detail);
        // not found + synced → present from an earlier sync
        assert!(get("gemini").detail.contains("present in the sandbox"));
        // not found + not synced → actionable "log in first"
        assert!(get("kimi").detail.contains("log in"), "{}", get("kimi").detail);
    }

    /// Live probe (real WSL + whatever logins exist on this machine):
    ///   cargo test --lib -- --ignored --nocapture probe_sync_logins_report
    /// Runs the real sync and asserts the report is complete + consistent.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn probe_sync_logins_report() {
        let r = sync_logins_impl(None).expect("sync runs");
        eprintln!("== live sync report ==");
        for m in &r.report {
            eprintln!("{:>7}: host={} sandbox={} — {}", m.provider, m.on_host, m.in_sandbox, m.detail);
        }
        assert_eq!(r.report.len(), 5);
        for m in &r.report {
            assert_eq!(m.on_host, r.found_on_host.contains(&m.provider), "{} host flag", m.provider);
            assert_eq!(m.in_sandbox, r.synced.contains(&m.provider), "{} sandbox flag", m.provider);
        }
    }

    #[cfg(windows)]
    #[test]
    fn win_path_to_mnt() {
        assert_eq!(win_to_mnt("C:\\Users\\mc").unwrap(), "/mnt/c/Users/mc");
        assert_eq!(win_to_mnt("D:\\a\\b").unwrap(), "/mnt/d/a/b");
    }

    /// Definitive end-to-end probe of the REAL Rust transport on real WSL
    /// (installs bubblewrap, then spawns wsl.exe exactly as the app does):
    ///   cargo test --lib -- --ignored --nocapture probe_bwrap_confinement_real
    /// Asserts the agent's command runs chdir'd into the project, can NOT see the
    /// rest of the C: drive, and its write lands in the real Windows folder.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn probe_bwrap_confinement_real() {
        let distro = crate::wsl::best_linux_distro().expect("a Linux distro in WSL");
        install_bwrap(&distro).expect("install bubblewrap");
        assert!(ensure_sandbox(&distro), "sandbox runner + bwrap ready");

        let win_dir = std::env::temp_dir().join("owllm_iso_probe");
        let _ = std::fs::remove_dir_all(&win_dir);
        std::fs::create_dir_all(&win_dir).unwrap();
        std::fs::write(win_dir.join("seed.txt"), "seed").unwrap();
        let mnt = win_to_mnt(&win_dir.to_string_lossy()).unwrap();

        let probe = r#"echo "PWD=$(pwd)"; echo "CDRIVE=$(ls /mnt/c/Windows >/dev/null 2>&1 && echo VISIBLE || echo HIDDEN)"; echo "LS=$(ls | tr '\n' ',')"; echo "NODE=$(node --version 2>&1)"; echo wrote-from-agent > out.txt && echo WROTE"#;
        let (exe, argv) = runner_argv(&distro, &mnt, probe);
        let out = std::process::Command::new(&exe).args(&argv).output().expect("spawn wsl.exe");
        let so = String::from_utf8_lossy(&out.stdout);
        eprintln!("--- real bwrap transport probe ---\n{so}\n--- stderr ---\n{}", String::from_utf8_lossy(&out.stderr));

        assert!(so.contains(&format!("PWD={mnt}")), "must chdir INTO the project, got: {so}");
        assert!(so.contains("CDRIVE=HIDDEN"), "the rest of C: must be hidden, got: {so}");
        assert!(so.contains("LS=seed.txt,"), "only the project's files are visible, got: {so}");
        assert!(so.contains("WROTE"), "agent could write, got: {so}");
        assert!(win_dir.join("out.txt").exists(), "the write must land in the REAL Windows folder");
        assert_eq!(std::fs::read_to_string(win_dir.join("out.txt")).unwrap().trim(), "wrote-from-agent");
        let _ = std::fs::remove_dir_all(&win_dir);
    }

    /// The runner invocation is QUOTE-FREE: cwd + command are base64, so a
    /// command full of quotes/`&&`/`$()`/spaces can't be re-split by the
    /// Windows→wsl.exe handoff. The `-lc` script must contain no `'` or `"`.
    #[cfg(windows)]
    #[test]
    fn runner_argv_is_quote_free_base64() {
        use base64::Engine as _;
        let nasty = r#"echo "a & b" && ls 'x y' | head -1; echo $(pwd)"#;
        let (exe, argv) = runner_argv("Ubuntu", "/mnt/c/proj", nasty);
        assert_eq!(exe, "wsl.exe");
        assert_eq!(&argv[0..5], &["-d", "Ubuntu", "--", "bash", "-lc"]);
        let script = &argv[5];
        // NO shell metacharacters that wsl.exe could mangle
        assert!(!script.contains('\''), "script must be quote-free: {script}");
        assert!(!script.contains('"'), "script must be quote-free: {script}");
        assert!(script.starts_with("exec $HOME/.owllm/run-sandboxed.sh "));
        // the command is recoverable by decoding the last token
        let b64cmd = base64::engine::general_purpose::STANDARD.encode(nasty.as_bytes());
        assert!(script.ends_with(&b64cmd), "command must be the final base64 token");
        let decoded = String::from_utf8(
            base64::engine::general_purpose::STANDARD.decode(b64cmd.as_bytes()).unwrap(),
        ).unwrap();
        assert_eq!(decoded, nasty);
    }

    /// The runner body binds ONLY the project + sandbox home + the agent's own
    /// creds, sets HOME to the sandbox home, and unshares namespaces — it must
    /// never bind the whole real home or /mnt wholesale.
    #[cfg(windows)]
    #[test]
    fn sandbox_runner_seals_correctly() {
        assert!(SANDBOX_RUNNER.contains("--bind \"$CWD\" \"$CWD\""));
        assert!(SANDBOX_RUNNER.contains("--chdir \"$CWD\""));
        assert!(SANDBOX_RUNNER.contains("--setenv HOME \"$SB\""));
        assert!(SANDBOX_RUNNER.contains("--bind-try \"$HOME/.codex\" \"$SB/.codex\""));
        assert!(SANDBOX_RUNNER.contains("--unshare-pid"));
        // never expose the whole real home or all of /mnt
        assert!(!SANDBOX_RUNNER.contains("--bind \"$HOME\" \"$HOME\""));
        assert!(!SANDBOX_RUNNER.contains("/mnt /mnt"));
    }

    #[test]
    fn managed_copy_guard_never_deletes_user_folders() {
        // managed sandbox copies → cleanable
        assert!(is_managed_sandbox_copy("/home/mc/owllm/myproj"));
        assert!(is_managed_sandbox_copy("/home/me/owllm/proj-1"));
        // the user's real drive folder (isolate-in-place) → NEVER
        assert!(!is_managed_sandbox_copy("/mnt/c/Users/mc/repo"));
        assert!(!is_managed_sandbox_copy("/mnt/d/owllm/repo")); // even with 'owllm' in it
        // the managed root itself → NEVER (no project name)
        assert!(!is_managed_sandbox_copy("/home/mc/owllm"));
        assert!(!is_managed_sandbox_copy("/home/mc/owllm/"));
        // arbitrary distro paths → NEVER
        assert!(!is_managed_sandbox_copy("/home/mc"));
        assert!(!is_managed_sandbox_copy("/etc"));
        // deeper than one level under owllm → NEVER (only the project dir matches)
        assert!(!is_managed_sandbox_copy("/home/mc/owllm/proj/sub"));
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
