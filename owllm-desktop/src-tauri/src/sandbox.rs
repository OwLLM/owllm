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

/// Sub-directory of the sandbox user's home that holds isolated projects
/// (~/owllm/<name>). Matches the WSL backend layout so the concept is uniform.
pub const ISO_SUBDIR: &str = "owllm";

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

#[cfg(test)]
mod tests {
    use super::*;

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
