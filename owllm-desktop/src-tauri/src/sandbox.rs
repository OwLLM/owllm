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
// ⚠ BETA: the macOS (lima) command shape is compile-checked on its CI leg but
// has NOT yet been runtime-verified on real hardware. The Linux (bwrap) prefix
// HAS now been run on real aarch64 Ubuntu 24.04 — the production argv shape
// exits 0 and git works inside the jail — but only once the machine-wide
// AppArmor profile exists (see BWRAP_APPARMOR_PROFILE); without it every spawn
// dies at `setting up uid map`. Both engines are still surfaced to the user as
// "beta". The pure helpers below ARE unit-tested (and compile on every OS leg).

use serde::Serialize;

/// Sub-directory of the sandbox user's home that holds isolated projects
/// (~/owllm/<name>). Matches the WSL backend layout so the concept is uniform.
pub const ISO_SUBDIR: &str = "owllm";

/// Sub-directory of the user's home holding OWLLM-managed worktrees
/// (~/.owllm/fleet/<project>/<page>/<agent>). Must track `fleet::fleet_root()`
/// — every agent run gets a worktree there, so it is an isolation root too.
pub const FLEET_SUBDIR: &str = ".owllm/fleet";

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
    /// Why the engine is unavailable, when we know something actionable (e.g.
    /// bubblewrap installed but the kernel blocks unprivileged user namespaces).
    /// None when available, or when the reason is just "not installed".
    pub detail: Option<String>,
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
            detail: None,
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
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

// ---- pure helpers (unit-tested; compiled on every OS) ---------------------

/// True if `path` is `root` itself or sits underneath it. Segment-aware, so
/// `/home/me/owllmx` does NOT match the root `/home/me/owllm`.
fn is_under(path: &str, root: &str) -> bool {
    let root = root.trim_end_matches('/');
    let p = path.trim_end_matches('/');
    p == root || p.starts_with(&format!("{root}/"))
}

/// True if `path` is inside EITHER OWLLM-managed root on Linux/macOS:
///   `<home>/owllm`        — isolated project copies (ISO_SUBDIR)
///   `<home>/.owllm/fleet` — per-page/per-agent worktrees (FLEET_SUBDIR)
/// Used where an isolated project is an ordinary host path under one of those
/// roots (unlike WSL, where the UNC prefix is the marker).
///
/// The fleet arm is load-bearing: every agent run is handed a worktree under
/// FLEET_SUBDIR, so matching only ISO_SUBDIR meant that cutting a worktree
/// moved the run OUT of the isolation root and silently onto the bare host
/// while the UI still reported "isolated". Confirmed on real aarch64 Linux —
/// `~/.owllm/fleet/…` was rejected while `~/owllm/…` was accepted.
pub fn is_under_iso_root(path: &str, home: &str) -> bool {
    let home = home.trim_end_matches('/');
    is_under(path, &format!("{home}/{ISO_SUBDIR}"))
        || is_under(path, &format!("{home}/{FLEET_SUBDIR}"))
}

/// Given the contents of a worktree's `.git` FILE
/// (`gitdir: /path/to/repo/.git/worktrees/<name>`), the main repository's git
/// directory — the parent of `worktrees/<name>`. That single path covers BOTH
/// the worktree's own metadata and the shared object store, so binding it is
/// enough to make git work inside the jail.
///
/// A worktree's `.git` lives OUTSIDE the worktree, so a jail that binds only
/// the project directory leaves it invisible and every `git` call inside fails.
/// Returns None for a normal checkout, where `.git` is a directory already
/// inside the project bind, and for anything that isn't a gitdir pointer.
pub fn worktree_git_common_dir(dot_git_file: &str) -> Option<String> {
    let raw = dot_git_file
        .lines()
        .find_map(|l| l.trim().strip_prefix("gitdir:"))?
        .trim()
        .replace('\\', "/");
    let trimmed = raw.trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    // `<git-dir>/worktrees/<name>` → `<git-dir>`; any other pointer as-is.
    Some(match trimmed.rfind("/worktrees/") {
        Some(i) => trimmed[..i].to_string(),
        None => trimmed.to_string(),
    })
}

/// The bubblewrap argv PREFIX (everything before the trailing `bash -lc …`):
/// system dirs read-only, a private /tmp and /dev, a dedicated writable home
/// bound as $HOME (so CLI logins persist but the real home is invisible), the
/// project bound read-write and made cwd, and namespaces unshared. `allow_net`
/// keeps networking (needed for git + cloud CLIs); false fully isolates the net.
///
/// `extra_rw` are additional paths bound read-write — used for the main repo's
/// git directory when the project is a worktree (see `worktree_git_common_dir`),
/// without which git is broken inside the jail. Bound with `--bind-try` so a
/// path that has since vanished degrades instead of killing the run.
pub fn bwrap_prefix_argv(
    project_dir: &str,
    sandbox_home: &str,
    allow_net: bool,
    extra_rw: &[String],
) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    let mut ro = |p: &str| {
        // --ro-bind-try tolerates paths that don't exist on a given distro.
        a.push("--ro-bind-try".into());
        a.push(p.into());
        a.push(p.into());
    };
    for p in [
        "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc", "/opt",
    ] {
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
    // Anything the project needs from outside its own tree (worktree gitdir).
    for p in extra_rw {
        a.push("--bind-try".into());
        a.push(p.into());
        a.push(p.into());
    }
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
# WSL makes /etc/resolv.conf a symlink into /mnt/wsl (or /run) — directories the
# jail does NOT bind. Inside the sandbox the symlink then dangles and EVERY DNS
# lookup fails ("failed to lookup address information"), so cloud-CLI agents
# (Codex/Claude/Gemini) can't reach their API and the whole run dies. Build a
# resolv.conf for the jail and bind it to the symlink's real target so
# /etc/resolv.conf resolves inside the jail. We list the HOST's resolvers FIRST
# (so corporate / split-DNS still wins for the names it answers — the resolver
# only falls through on an UNREACHABLE server, not on NXDOMAIN), then append
# public resolvers as a fallback for when the host nameserver is unreachable
# (common behind a VPN). Opt out of the public fallback (strict corporate DNS):
#   touch ~/.owllm/no-dns-fallback
# Best-effort; a no-op when resolv.conf is already a plain file (native Linux).
RESOLV_BIND=()
RT="$(readlink -f /etc/resolv.conf 2>/dev/null)"
if [ -n "$RT" ] && [ "$RT" != "/etc/resolv.conf" ]; then
  SBR="$SB/.owllm/jail-resolv.conf"
  { [ -e "$RT" ] && cat "$RT" 2>/dev/null
    [ -f "$HOME/.owllm/no-dns-fallback" ] || printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n'
  } > "$SBR" 2>/dev/null
  [ -s "$SBR" ] && RESOLV_BIND=(--ro-bind-try "$SBR" "$RT")
fi
# A fleet worktree's .git is a POINTER FILE (`gitdir: <repo>/.git/worktrees/<n>`)
# to metadata + the object store, both of which live OUTSIDE the worktree. Bind
# that git dir too or every git call inside the jail fails with "not a git
# repository". Mirrors sandbox::worktree_git_common_dir — keep the two in step.
GIT_BIND=()
if [ -f "$CWD/.git" ]; then
  GD="$(sed -n 's/^[[:space:]]*gitdir:[[:space:]]*//p' "$CWD/.git" | head -n1)"
  GD="${GD%/}"; GD="${GD%/worktrees/*}"
  [ -n "$GD" ] && [ -d "$GD" ] && GIT_BIND=(--bind-try "$GD" "$GD")
fi
exec bwrap \
  --ro-bind-try /usr /usr --ro-bind-try /bin /bin --ro-bind-try /sbin /sbin \
  --ro-bind-try /lib /lib --ro-bind-try /lib32 /lib32 --ro-bind-try /lib64 /lib64 \
  --ro-bind-try /etc /etc --ro-bind-try /opt /opt --ro-bind-try /snap /snap \
  "${RESOLV_BIND[@]}" \
  --proc /proc --dev /dev --tmpfs /tmp \
  --bind "$SB" "$SB" --setenv HOME "$SB" \
  --bind-try "$HOME/.codex" "$SB/.codex" \
  --bind-try "$HOME/.claude" "$SB/.claude" \
  --bind-try "$HOME/.claude.json" "$SB/.claude.json" \
  --bind-try "$HOME/.gemini" "$SB/.gemini" \
  --bind-try "$HOME/.kimi" "$SB/.kimi" \
  --bind-try "$HOME/.gitconfig" "$SB/.gitconfig" \
  --bind-try "$HOME/.git-credentials" "$SB/.git-credentials" \
  --bind-try "$HOME/.config/gh" "$SB/.config/gh" \
  --bind-try "$HOME/.owllm/agent_env.sh" "$SB/.owllm/agent_env.sh" \
  --bind "$CWD" "$CWD" "${GIT_BIND[@]}" --chdir "$CWD" \
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
            sandbox_cache()
                .lock()
                .unwrap()
                .insert(distro.to_string(), true);
            true
        }
        Ok(o) if o.contains("OWLLM_BWRAP=no") => {
            sandbox_cache()
                .lock()
                .unwrap()
                .insert(distro.to_string(), false);
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
        vec![
            "-d".into(),
            distro.into(),
            "--".into(),
            "bash".into(),
            "-lc".into(),
            script,
        ],
    )
}

#[cfg(windows)]
pub fn is_isolated(cwd: Option<&str>) -> bool {
    cwd.and_then(crate::wsl::parse_wsl_unc).is_some()
}

// ---- per-project "full host access" (explicit opt-out of the sandbox) -------
// A project the user has deliberately marked TRUSTED runs OUTSIDE the jail —
// plain WSL routing on Windows, no bwrap/Lima wrapper on Linux/macOS — so the
// agent can read and write beyond the project folder and reach host tools:
// "more power" when the user knowingly wants it (bug #19). OFF by default; the
// UI gates the ON path behind an explicit confirmation. Keyed by the project
// cwd (the same value the CLIs run with) so the decision lives in ONE place —
// program_argv/shell_argv — without threading a flag through every agent-CLI
// call. This is the "always allow everything, unsandboxed" end of the
// graduated-trust scale; per-action approval is a planned follow-up.
//
// Cross-platform since the isolation audit: it used to be Windows-only, which
// left Linux/macOS users with no way to opt out of a sandbox they could not
// turn off, contradicting the graduated-trust promise in FEATURES.md.
fn full_access_path() -> Option<std::path::PathBuf> {
    // Shared resolver — honors portable mode (USB-portable Block 1).
    Some(crate::paths::owllm_config_home()?.join("full-access.json"))
}
/// Normalise a cwd into a stable set key. Case is folded on Windows only —
/// Linux/macOS agent paths are case-sensitive, so folding there could match a
/// DIFFERENT directory and hand it full access.
fn norm_cwd(cwd: &str) -> String {
    let t = cwd.trim().trim_end_matches(|c| c == '/' || c == '\\');
    if cfg!(windows) {
        t.to_lowercase()
    } else {
        t.to_string()
    }
}
fn full_access_set() -> std::collections::BTreeSet<String> {
    full_access_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .map(|v| v.iter().map(|s| norm_cwd(s)).collect())
        .unwrap_or_default()
}
/// True when the user has marked this project's folder full-access (trusted):
/// agents run OUTSIDE the jail. Checked in program_argv/shell_argv.
pub fn is_full_access(cwd: Option<&str>) -> bool {
    matches!(cwd, Some(c) if !c.trim().is_empty() && full_access_set().contains(&norm_cwd(c)))
}

/// True when the CLI agent will run INSIDE a bubblewrap jail for this cwd.
/// A jailed agent has no interop access (no /mnt, no curl.exe), so the MCP
/// relay cannot reach the host gateway — used to gate browser-tool wiring.
/// False for: host runs, full-access WSL (no jail), WSL without bwrap installed.
#[cfg(windows)]
pub fn is_bwrap_jailed(cwd: Option<&str>) -> bool {
    if is_full_access(cwd) {
        return false;
    }
    if let Some((distro, _)) = cwd.and_then(|c| crate::wsl::parse_wsl_unc(c)) {
        return ensure_sandbox(&distro.to_string());
    }
    false
}
#[cfg(not(windows))]
pub fn is_bwrap_jailed(_cwd: Option<&str>) -> bool {
    false
}

fn full_access_get_impl(cwd: String) -> bool {
    is_full_access(Some(&cwd))
}

fn full_access_set_impl(cwd: String, enabled: bool) -> Result<(), String> {
    let p = full_access_path().ok_or_else(|| "no home directory".to_string())?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let mut set = full_access_set();
    if enabled {
        set.insert(norm_cwd(&cwd));
    } else {
        set.remove(&norm_cwd(&cwd));
    }
    let list: Vec<String> = set.into_iter().collect();
    std::fs::write(
        &p,
        serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("write {}: {e}", p.display()))?;
    Ok(())
}

// ---- image inbox: let a subscription/CLI agent SEE pasted images -----------
// The cloud-CLI agents (Claude Code, Codex, Gemini) are text-only on stdin, but
// they can READ image files with their own file/vision tool — that's how Claude
// Code handles images without an API key ("file path reference"). So we drop the
// pasted images into the agent's working directory and reference the paths in
// the prompt; the agent opens them itself. Returns the agent-visible absolute
// Linux paths. The inbox is cleared each call so stale images don't pile up.
#[derive(serde::Deserialize)]
pub struct InboxImage {
    pub data_b64: String,
    pub mime: Option<String>,
}

// True when `dir` is a Windows UNC path through the WSL 9P redirector
// (`\\wsl.localhost\...`, `\\wsl$\...`, `\\?\UNC\...` — case-insensitive). The
// agent cwd is frequently such a path, and the 9P redirector intermittently
// returns PermissionDenied on directory create even though no real ACL is
// involved. We only relax create_dir_all for these paths.
#[cfg(windows)]
fn is_wsl_redirector_path(dir: &std::path::Path) -> bool {
    let s = dir.to_string_lossy().to_ascii_lowercase();
    s.starts_with(r"\\wsl.localhost\") || s.starts_with(r"\\wsl$\") || s.starts_with(r"\\?\unc\")
}

// create_dir_all for the inbox dir, with a SMALL bounded retry that is scoped
// (Windows-only) to WSL 9P redirector paths. On those paths create_dir_all can
// transiently fail with PermissionDenied as a redirector race, not a genuine
// permission denial, which randomly broke image paste. Retry at most a handful
// of times with a short backoff, then return the original error so real
// failures still surface clearly. On normal paths (and on non-Windows) this is
// a single create_dir_all call — real permission errors stay immediate.
fn create_inbox_dir(dir: &std::path::Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        if is_wsl_redirector_path(dir) {
            // up to 5 attempts total (1 + 4 retries) with a short backoff
            for attempt in 0..5 {
                match std::fs::create_dir_all(dir) {
                    Ok(()) => return Ok(()),
                    Err(e) => {
                        // Only the redirector race manifests as PermissionDenied;
                        // anything else (or the last attempt) surfaces the real error.
                        if attempt == 4 || e.kind() != std::io::ErrorKind::PermissionDenied {
                            return Err(e);
                        }
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                }
            }
        }
    }
    std::fs::create_dir_all(dir)
}

// Convert a WSL 9P redirector UNC path that points at a Windows drive mount
// (`\\wsl.localhost\<distro>\mnt\<drive>\...`, also `\\wsl$\...` and the verbatim
// `\\?\UNC\wsl.localhost\...` form, case-insensitive prefixes) into the native
// Windows drive path it actually refers to, e.g.
//   \\wsl.localhost\Ubuntu\mnt\c\1_Git\LocaLLM  ->  C:\1_Git\LocaLLM
// Writing through the drive path sidesteps the flaky 9P redirector create.
// Returns None for any UNC path that is NOT a `/mnt/<drive>/` drvfs mount (e.g.
// `\\wsl.localhost\Ubuntu\home\user` has no Windows drive) and for non-UNC paths
// — it never fabricates a drive. Pure string/path logic: no `#[cfg(windows)]`, so
// it compiles and is unit-tested on every platform.
#[cfg_attr(not(windows), allow(dead_code))]
fn wsl_unc_to_win_drive(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let norm = dir.to_string_lossy().replace('\\', "/");
    // ASCII-lowercase preserves byte length, so offsets into `lower` are valid
    // offsets into `norm` — we match on `lower` but slice the case-preserving
    // `norm` for the distro/tail components.
    let lower = norm.to_ascii_lowercase();
    let mut s = lower.as_str();
    s = s.strip_prefix("//?/unc/").unwrap_or(s); // optional verbatim UNC prefix
    s = s.trim_start_matches('/'); // tolerate the leading `//` of a plain UNC path
    let rest = s
        .strip_prefix("wsl.localhost/")
        .or_else(|| s.strip_prefix("wsl$/"))?;
    let off = lower.len() - rest.len(); // bytes consumed from the front of `norm`
    let orig = &norm[off..]; // `<distro>/mnt/<drive>/<tail...>` with original case
                             // Match `mnt` + a single drive letter on the lowercased view.
    let mut lparts = rest.splitn(4, '/');
    let _distro = lparts.next()?;
    if lparts.next()? != "mnt" {
        return None; // not a /mnt/<drive>/ drvfs mount → no Windows drive
    }
    let drive = lparts.next()?;
    if drive.len() != 1 || !drive.as_bytes()[0].is_ascii_alphabetic() {
        return None; // e.g. /mnt/wsl/... is a real mount but not a drive letter
    }
    // Take the tail from the original-case string so path casing is preserved.
    let tail = orig.splitn(4, '/').nth(3).unwrap_or("");
    let win_tail = tail.replace('/', "\\");
    let win_tail = win_tail.trim_end_matches('\\');
    let drive_up = drive.to_ascii_uppercase();
    let win = if win_tail.is_empty() {
        format!("{drive_up}:\\")
    } else {
        format!("{drive_up}:\\{win_tail}")
    };
    Some(std::path::PathBuf::from(win))
}

// Cross-platform: this is plain base64-decode + std::fs file writes, so it works
// identically on Windows, Linux and macOS. (It used to be `#[cfg(windows)]` with a
// non-Windows stub that errored "image inbox is a WSL feature" — pure laziness;
// nothing here is WSL-specific, so image paste now works on every OS.)
fn save_inbox_impl(cwd: String, images: Vec<InboxImage>) -> Result<Vec<String>, String> {
    use base64::Engine as _;
    if cwd.trim().is_empty() {
        return Err("no working directory to save images into".into());
    }
    let raw = std::path::Path::new(&cwd);
    // On Windows, when the cwd is a WSL 9P redirector path that maps to a real
    // Windows drive, write through the native drive path (C:\…) instead of the
    // flaky redirector. Only substitute when the conversion yields a sane,
    // absolute, drive-rooted base AND the joined inbox stays under that base
    // (starts_with guards against a path-escape regression). Anything else falls
    // back to the raw cwd, where create_inbox_dir's bounded retry still applies.
    #[cfg(windows)]
    let dir = {
        let fallback = || raw.join(".owllm-inbox");
        if is_wsl_redirector_path(raw) {
            match wsl_unc_to_win_drive(raw) {
                Some(base)
                    if base.is_absolute()
                        && base.to_string_lossy().contains(":\\")
                        && !base.as_os_str().is_empty() =>
                {
                    let candidate = base.join(".owllm-inbox");
                    if !candidate.starts_with(&base) {
                        return Err(format!(
                            "refusing inbox path outside its base: {} is not under {}",
                            candidate.display(),
                            base.display()
                        ));
                    }
                    candidate
                }
                _ => fallback(),
            }
        } else {
            fallback()
        }
    };
    #[cfg(not(windows))]
    let dir = raw.join(".owllm-inbox");
    // Ensure the dir exists FIRST, then clear only stale image_* files inside.
    // The previous `remove_dir_all` + immediate `create_dir_all` deadlocked on
    // Windows: NTFS posts the directory delete asynchronously (delete-pending),
    // so recreating it on the next line raced and returned "Access is denied" —
    // which broke every paste AFTER the first into the same folder. Creating the
    // dir idempotently and deleting individual old files avoids the race.
    create_inbox_dir(&dir).map_err(|e| format!("create inbox dir {}: {e}", dir.display()))?;
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for ent in rd.flatten() {
            let p = ent.path();
            let is_stale_image = p
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("image_"))
                .unwrap_or(false);
            if is_stale_image {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    let mut paths = Vec::new();
    for (i, img) in images.iter().enumerate() {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(img.data_b64.trim())
            .map_err(|e| format!("decode image {}: {e}", i + 1))?;
        let ext = match img.mime.as_deref().unwrap_or("") {
            m if m.contains("jpeg") || m.contains("jpg") => "jpg",
            m if m.contains("webp") => "webp",
            m if m.contains("gif") => "gif",
            _ => "png",
        };
        let name = format!("image_{}.{ext}", i + 1);
        let target = dir.join(&name);
        std::fs::write(&target, &bytes)
            .map_err(|e| format!("write image {} to {}: {e}", i + 1, target.display()))?;
        // RELATIVE to the agent's cwd — works for codex `-i` AND claude's Read
        // tool, whether the agent runs sandboxed (cwd bound) or on the host.
        paths.push(format!(".owllm-inbox/{name}"));
    }
    Ok(paths)
}

/// Save pasted images into the agent's working directory (.owllm-inbox/) so a
/// subscription/CLI agent can read them. Returns the paths RELATIVE to the cwd
/// (".owllm-inbox/image_N.ext"): codex passes them via `-i`, claude reads them
/// with its Read tool. Both verified end-to-end.
#[tauri::command]
pub fn agent_save_inbox_images(
    cwd: String,
    images: Vec<InboxImage>,
) -> Result<Vec<String>, String> {
    save_inbox_impl(cwd, images)
}

/// Read whether a project folder is marked full-access (agents run unsandboxed).
#[tauri::command]
pub fn agent_full_access_get(cwd: String) -> bool {
    full_access_get_impl(cwd)
}

/// Mark/unmark a project folder full-access. When ON, that project's agents run
/// OUTSIDE the bwrap sandbox (full host access). OFF by default; the UI gates the
/// ON path behind an explicit confirmation.
#[tauri::command]
pub fn agent_full_access_set(cwd: String, enabled: bool) -> Result<(), String> {
    full_access_set_impl(cwd, enabled)
}

/// Argv that aborts the run at once because the distro has no outbound
/// network. Returned INSTEAD of the CLI so a wedged WSL network costs seconds
/// and names itself, rather than leaving the CLI blocked in `connect()` until
/// the run times out with no output. See [`crate::wsl::NET_DOWN_MARKER`].
#[cfg(windows)]
fn net_down_argv(distro: String) -> (String, Vec<String>) {
    let msg = format!(
        "{}: the WSL sandbox cannot reach the network — outbound connections \
from inside the distro time out, so the agent CLI would hang instead of \
answering. This is a Windows-side WSL networking failure, not the model, your \
login, or this project.",
        crate::wsl::NET_DOWN_MARKER
    );
    (
        "wsl.exe".to_string(),
        vec![
            "-d".into(),
            distro,
            "--".into(),
            "bash".into(),
            "-lc".into(),
            format!("printf '%s\\n' {} >&2; exit 78", crate::wsl::sh_quote(&msg)),
        ],
    )
}

#[cfg(windows)]
pub fn program_argv(
    cwd: Option<&str>,
    program: &str,
    args: &[String],
) -> Option<(String, Vec<String>)> {
    let (distro, linux_cwd) = cwd.and_then(crate::wsl::parse_wsl_unc)?;
    // Preflight the sandbox's outbound network before handing over to the CLI.
    // Runs on the program_argv path only, which never applies --unshare-net, so
    // a deliberately offline run can't be mistaken for a broken one.
    if !crate::wsl::sandbox_net_ok(&distro) {
        return Some(net_down_argv(distro));
    }
    // A full-access (trusted) project opts OUT of the bwrap jail entirely — plain
    // WSL routing below, which can reach the Windows drives + interop. Otherwise
    // confine to the project folder when bubblewrap is available.
    if !is_full_access(cwd) && ensure_sandbox(&distro) {
        return Some(runner_argv(
            &distro,
            &linux_cwd,
            &exec_script(program, args),
        ));
    }
    // Fallback: bubblewrap not present — plain WSL routing (Linux process, but
    // not folder-confined). The Harden action installs bwrap to seal it.
    let script = format!(
        "cd {} && {}",
        crate::wsl::sh_quote(&linux_cwd),
        exec_script(program, args)
    );
    Some((
        "wsl.exe".to_string(),
        vec![
            "-d".into(),
            distro,
            "--".into(),
            "bash".into(),
            "-lc".into(),
            script,
        ],
    ))
}

/// Like [`program_argv`] but NEVER applies the bwrap jail: a WSL project runs
/// via plain WSL routing even when bubblewrap is installed and the project is
/// not full-access. This is the BROWSER-ROLE EXCEPTION (accounts.rs
/// claude_cli_stream): that one role must keep WSL interop (curl.exe) alive so
/// the MCP stdio relay can reach the host browser gateway. Deliberate
/// tradeoff, scoped to that role only: the run gains /mnt + interop access
/// like a full-access run, while every other agent in the team stays jailed.
#[cfg(windows)]
pub fn program_argv_unjailed(
    cwd: Option<&str>,
    program: &str,
    args: &[String],
) -> Option<(String, Vec<String>)> {
    let (distro, linux_cwd) = cwd.and_then(crate::wsl::parse_wsl_unc)?;
    if !crate::wsl::sandbox_net_ok(&distro) {
        return Some(net_down_argv(distro));
    }
    let script = format!(
        "cd {} && {}",
        crate::wsl::sh_quote(&linux_cwd),
        exec_script(program, args)
    );
    Some((
        "wsl.exe".to_string(),
        vec![
            "-d".into(),
            distro,
            "--".into(),
            "bash".into(),
            "-lc".into(),
            script,
        ],
    ))
}
/// Non-Windows Browser/Solo exception: return `None` so the caller launches the
/// host CLI directly. Linux bwrap hides the real home/config and Lima has its
/// own loopback, so routing these roles through the isolated engine would make
/// the authenticated host MCP gateway disappear. Ordinary roles still use
/// [`program_argv`] and remain isolated.
#[cfg(not(windows))]
pub fn program_argv_unjailed(
    _cwd: Option<&str>,
    _program: &str,
    _args: &[String],
) -> Option<(String, Vec<String>)> {
    None
}

#[cfg(windows)]
pub fn shell_argv(cwd: Option<&str>, command: &str) -> Option<(String, Vec<String>)> {
    let (distro, linux_cwd) = cwd.and_then(crate::wsl::parse_wsl_unc)?;
    // Full-access (trusted) project → skip the jail (plain routing below).
    if !is_full_access(cwd) && ensure_sandbox(&distro) {
        return Some(runner_argv(&distro, &linux_cwd, command));
    }
    let script = crate::wsl::build_wsl_bash_script(&linux_cwd, command);
    Some((
        "wsl.exe".to_string(),
        vec![
            "-d".into(),
            distro,
            "--".into(),
            "bash".into(),
            "-lc".into(),
            script,
        ],
    ))
}

// ---- extra read/write scope for subscription CLIs -------------------------
//
// The tool allowlist (--allowedTools) and the CLI's filesystem SCOPE are two
// INDEPENDENT axes: granting every tool still leaves Claude Code's own
// "allowed working directories" guard blocking a Read/`cat` of any file
// OUTSIDE cwd (e.g. ~/Downloads/BRIEF.md → "may only concatenate files from
// the allowed working directories"). `--add-dir` widens that scope. We grant
// the user's home profile (Downloads/Desktop/Documents/…) so an agent can open
// a file the user explicitly points it at.

/// Extra directories a subscription CLI (Claude Code, …) may read/write beyond
/// the project folder, returned already in the namespace the CLI runs in and
/// meant to be passed as `--add-dir <dir>`. Grants the user's home profile so an
/// agent can open a file the user points it at outside the project.
///
/// Returns EMPTY when the run is bwrap-jailed: the jail bind-mounts ONLY the
/// project, so a broader --add-dir would both name a path that doesn't exist
/// inside the jail AND defeat the confinement the jail exists to provide.
#[cfg(windows)]
pub fn extra_allowed_dirs(cwd: Option<&str>) -> Vec<String> {
    let home = match std::env::var("USERPROFILE") {
        Ok(h) if !h.trim().is_empty() => h,
        _ => return Vec::new(),
    };
    match cwd.and_then(crate::wsl::parse_wsl_unc) {
        // WSL project. Only widen when NOT confined by bwrap — full-access
        // (trusted) or bwrap-absent runs use plain WSL routing, which mounts
        // /mnt/c and so genuinely reaches the Windows profile. Express the
        // profile as its /mnt path for the in-distro CLI.
        Some((distro, _linux_cwd)) => {
            if !is_full_access(cwd) && ensure_sandbox(&distro) {
                return Vec::new();
            }
            // Reuse the login-sync translator (C:\Users\mc → /mnt/c/Users/mc).
            win_to_mnt(&home).ok().into_iter().collect()
        }
        // Native Windows run — grant the profile path directly.
        None => vec![home],
    }
}

/// Non-Windows host: grant $HOME unless the project is sandbox-isolated (where
/// the jail intentionally hides the rest of home).
#[cfg(not(windows))]
pub fn extra_allowed_dirs(cwd: Option<&str>) -> Vec<String> {
    if is_isolated(cwd) {
        return Vec::new();
    }
    std::env::var("HOME")
        .ok()
        .filter(|h| !h.trim().is_empty())
        .into_iter()
        .collect()
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

// ---- engine liveness (Linux/macOS) ----------------------------------------
//
// `<engine> --version` is NOT evidence that the engine can isolate anything. It
// answers "is the binary here?", and both engines fail LATER for reasons a
// version print cannot see — so the app reported "isolated" while every run was
// unsandboxed. We spawn a real, throwaway jail instead, and cache the verdict.

/// How long an engine verdict is trusted before re-probing. Short enough that a
/// user who installs the AppArmor profile (or bubblewrap, or the Lima instance)
/// mid-session is picked up without a restart; long enough that the probe never
/// runs in the hot path of a busy agent.
#[cfg(any(target_os = "linux", target_os = "macos"))]
const PROBE_TTL: std::time::Duration = std::time::Duration::from_secs(30);

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[allow(clippy::type_complexity)]
fn probe_cache(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, bool)>> {
    static C: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, bool)>>,
    > = std::sync::OnceLock::new();
    C.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Run `probe` at most once per PROBE_TTL per `key`.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn cached_probe(key: &str, probe: impl FnOnce() -> bool) -> bool {
    if let Ok(c) = probe_cache().lock() {
        if let Some((at, v)) = c.get(key) {
            if at.elapsed() < PROBE_TTL {
                return *v;
            }
        }
    }
    let v = probe();
    if let Ok(mut c) = probe_cache().lock() {
        c.insert(key.to_string(), (std::time::Instant::now(), v));
    }
    v
}

/// Drop cached verdicts so the next call re-probes immediately — called after
/// we install bubblewrap or the AppArmor profile.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn invalidate_probe_cache() {
    if let Ok(mut c) = probe_cache().lock() {
        c.clear();
    }
}

// ---- Linux: bubblewrap ----------------------------------------------------

#[cfg(target_os = "linux")]
fn sandbox_home() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let sb = format!("{home}/.owllm/sbhome");
    std::fs::create_dir_all(&sb).ok()?;
    Some(sb)
}

/// True when bubblewrap is not merely INSTALLED but can actually build a jail.
///
/// On Ubuntu 24.04+ (`kernel.apparmor_restrict_unprivileged_userns=1`) an
/// unprofiled, non-setuid `bwrap` prints its version happily and then dies with
/// `setting up uid map: Permission denied` on every real run. Measured on
/// aarch64 Ubuntu 24.04 with identical argv: exit 0 with an AppArmor `userns`
/// profile attached, exit 1 without, while `--version` returned 0 in both.
/// So the probe spawns the SAME prefix production uses, over a throwaway dir.
#[cfg(target_os = "linux")]
fn bwrap_runnable() -> bool {
    cached_probe("bwrap", || {
        let Some(sb) = sandbox_home() else {
            return false;
        };
        let probe_dir = format!("{sb}/.probe");
        if std::fs::create_dir_all(&probe_dir).is_err() {
            return false;
        }
        let mut argv = bwrap_prefix_argv(&probe_dir, &sb, true, &[]);
        argv.push("/bin/true".into());
        std::process::Command::new("bwrap")
            .args(&argv)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    })
}

/// True when the kernel is blocking unprivileged user namespaces — the reason a
/// present `bwrap` still can't run. Drives the actionable remedy in `harden`.
#[cfg(target_os = "linux")]
fn userns_restricted() -> bool {
    std::fs::read_to_string("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
        .map(|s| s.trim() == "1")
        .unwrap_or(false)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn isolated_dir(cwd: Option<&str>) -> Option<String> {
    let p = cwd?;
    if !crate::wsl::wsl_isolation_get_blocking().enabled {
        return None;
    }
    // Explicit per-project trust — the user opted this folder OUT of the jail.
    if is_full_access(Some(p)) {
        return None;
    }
    let home = std::env::var("HOME").ok()?;
    if is_under_iso_root(p, &home) {
        Some(p.to_string())
    } else {
        None
    }
}

/// Paths outside the project that must still be bound into the jail: the main
/// repository's git dir when the project is an OWLLM fleet worktree.
#[cfg(target_os = "linux")]
fn extra_binds_for(project_dir: &str) -> Vec<String> {
    let dot_git = std::path::Path::new(project_dir).join(".git");
    if !dot_git.is_file() {
        return Vec::new(); // ordinary checkout — .git is inside the project bind
    }
    std::fs::read_to_string(&dot_git)
        .ok()
        .and_then(|s| worktree_git_common_dir(&s))
        .into_iter()
        .collect()
}

#[cfg(target_os = "linux")]
pub fn is_isolated(cwd: Option<&str>) -> bool {
    isolated_dir(cwd).is_some() && bwrap_runnable()
}

#[cfg(target_os = "linux")]
pub fn program_argv(
    cwd: Option<&str>,
    program: &str,
    args: &[String],
) -> Option<(String, Vec<String>)> {
    let dir = isolated_dir(cwd)?;
    if !bwrap_runnable() {
        return None;
    }
    let sb = sandbox_home()?;
    let mut v = bwrap_prefix_argv(&dir, &sb, true, &extra_binds_for(&dir));
    v.push("bash".into());
    v.push("-lc".into());
    v.push(exec_script(program, args));
    Some(("bwrap".to_string(), v))
}

#[cfg(target_os = "linux")]
pub fn shell_argv(cwd: Option<&str>, command: &str) -> Option<(String, Vec<String>)> {
    let dir = isolated_dir(cwd)?;
    if !bwrap_runnable() {
        return None;
    }
    let sb = sandbox_home()?;
    let mut v = bwrap_prefix_argv(&dir, &sb, true, &extra_binds_for(&dir));
    v.push("bash".into());
    v.push("-lc".into());
    v.push(command.to_string());
    Some(("bwrap".to_string(), v))
}

// ---- macOS: Lima ----------------------------------------------------------

#[cfg(target_os = "macos")]
const LIMA_INSTANCE: &str = "owllm";

/// True when the Lima VM can actually run a command — not merely that
/// `limactl` is installed. `limactl --version` succeeds even when the `owllm`
/// instance was never created or is stopped, in which case every isolated run
/// fails; same false-positive class as bubblewrap's version check on Linux.
///
/// NOT yet runtime-verified: no Mac in reach has Lima installed, so this shape
/// is reasoned from `limactl shell` semantics, unlike the Linux probe which was
/// measured. It is strictly stricter than the check it replaces.
#[cfg(target_os = "macos")]
fn lima_runnable() -> bool {
    cached_probe("lima", || {
        std::process::Command::new("limactl")
            .args(["shell", LIMA_INSTANCE, "true"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    })
}

#[cfg(target_os = "macos")]
pub fn is_isolated(cwd: Option<&str>) -> bool {
    isolated_dir(cwd).is_some() && lima_runnable()
}

#[cfg(target_os = "macos")]
pub fn program_argv(
    cwd: Option<&str>,
    program: &str,
    args: &[String],
) -> Option<(String, Vec<String>)> {
    let dir = isolated_dir(cwd)?;
    if !lima_runnable() {
        return None;
    }
    Some((
        "limactl".to_string(),
        lima_argv(LIMA_INSTANCE, &dir, program, args),
    ))
}

#[cfg(target_os = "macos")]
pub fn shell_argv(cwd: Option<&str>, command: &str) -> Option<(String, Vec<String>)> {
    let dir = isolated_dir(cwd)?;
    if !lima_runnable() {
        return None;
    }
    let bash_args = vec!["-lc".to_string(), command.to_string()];
    Some((
        "limactl".to_string(),
        lima_argv(LIMA_INSTANCE, &dir, "bash", &bash_args),
    ))
}

// ---- other OSes: never isolated (host fallback) ---------------------------

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub fn is_isolated(_cwd: Option<&str>) -> bool {
    false
}
#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub fn program_argv(
    _cwd: Option<&str>,
    _program: &str,
    _args: &[String],
) -> Option<(String, Vec<String>)> {
    None
}
#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub fn shell_argv(_cwd: Option<&str>, _command: &str) -> Option<(String, Vec<String>)> {
    None
}

// ---- Tauri commands (cross-platform) --------------------------------------

#[cfg(windows)]
fn status_impl() -> SandboxStatus {
    let w = crate::wsl::wsl_status_blocking();
    // Report the distro the sandbox will actually use (best_linux_distro —
    // never docker-desktop); fall back to the raw default for display when
    // only system distros exist.
    let default_target = crate::wsl::best_linux_distro().or(w.default_distro);
    // Folder-confinement is ready when the target distro has bubblewrap (+ the
    // runner, installed idempotently by ensure_sandbox). Probed once per distro
    // then cached, so polling status is cheap.
    let confined = default_target
        .as_deref()
        .and_then(|distro| {
            sandbox_cache()
                .lock()
                .ok()
                .and_then(|c| c.get(distro).copied())
        })
        .unwrap_or(false);
    SandboxStatus {
        available: w.available,
        kind: "wsl".into(),
        strong: true,
        beta: false,
        confined,
        targets: w.distros,
        default_target,
        detail: None,
    }
}

#[cfg(target_os = "linux")]
fn status_impl() -> SandboxStatus {
    let ok = bwrap_runnable();
    // Distinguish "not installed" from "installed but the kernel won't let it
    // build a namespace" — the second is invisible to a version check and is
    // what made the app claim isolation it did not have.
    let detail = if ok {
        None
    } else if !which("bwrap") {
        Some("bubblewrap is not installed — use Harden to install it.".into())
    } else if userns_restricted() {
        Some(BWRAP_USERNS_HELP.into())
    } else {
        Some("bubblewrap is installed but could not create a sandbox.".into())
    };
    SandboxStatus {
        available: ok,
        kind: if ok {
            "bubblewrap".into()
        } else {
            "none".into()
        },
        strong: false,
        beta: true,
        confined: ok, // bubblewrap IS the folder-confinement on Linux
        targets: Vec::new(),
        default_target: None,
        detail,
    }
}

#[cfg(target_os = "macos")]
fn status_impl() -> SandboxStatus {
    let ok = lima_runnable();
    let detail = if ok {
        None
    } else if which("limactl") {
        Some(format!(
            "Lima is installed but the `{LIMA_INSTANCE}` VM isn't running — start it with `limactl start --name {LIMA_INSTANCE}`."
        ))
    } else {
        Some(MAC_PROVISION_HELP.into())
    };
    SandboxStatus {
        available: ok,
        kind: if ok { "lima".into() } else { "none".into() },
        strong: true,
        beta: true,
        confined: ok, // Lima is a VM — confinement comes with availability
        targets: Vec::new(),
        default_target: None,
        detail,
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
        .ok_or_else(|| {
            "No Ubuntu/Linux distro in WSL — set it up on the Home page first.".to_string()
        })?;
    install_bwrap(&distro)?;
    if !ensure_sandbox(&distro) {
        return Err("bubblewrap installed but isn't runnable in this distro — folder-confinement unavailable.".to_string());
    }
    Ok(status_impl())
}

#[cfg(target_os = "linux")]
fn harden_impl(_distro: Option<String>) -> Result<SandboxStatus, String> {
    if bwrap_runnable() {
        return Ok(status_impl());
    }
    if !which("bwrap") {
        linux_provision()?;
        invalidate_probe_cache();
        if bwrap_runnable() {
            return Ok(status_impl());
        }
    }
    // Installed but still can't build a namespace: on Ubuntu 24.04+ that is the
    // unprivileged-userns restriction, cured ONCE PER MACHINE by giving bwrap
    // an AppArmor profile (see linux_install_userns_profile).
    if userns_restricted() {
        linux_install_userns_profile()?;
        invalidate_probe_cache();
    }
    let st = status_impl();
    if !st.available {
        return Err(st
            .detail
            .unwrap_or_else(|| "bubblewrap could not create a sandbox.".into()));
    }
    Ok(st)
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

// ---- sandbox disk management ----------------------------------------------
//
// The agent sandbox lives inside the WSL distro's ext4.vhdx. That file GROWS as
// caches (uv/npm/pip) and project copies accumulate, but never shrinks on its
// own. Three actions, escalating in cost:
//   1. sandbox_disk_usage  — read-only: vhdx file size + reclaimable caches + copies.
//   2. sandbox_clear_caches — safe, no restart: drop regenerable build caches
//      (uv/npm/pip). Frees space INSIDE the vhdx (logical) — the file stays big.
//   3. sandbox_reclaim_disk — the only way to physically SHRINK the .vhdx file:
//      fstrim, then `wsl --shutdown` + `diskpart compact vdisk`. Needs admin
//      (UAC) and restarts WSL, so it is ALWAYS explicit + warned, never automatic.

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SandboxDisk {
    /// The WSL virtual-disk file size on Windows — what the user sees on C:. 0 if unknown.
    pub vhdx_bytes: u64,
    pub vhdx_path: Option<String>,
    /// Reclaimable regenerable caches inside the distro (uv/npm/pip + sandbox home).
    pub cache_bytes: u64,
    /// Total size of OwLLM sandbox project COPIES (~/owllm/*).
    pub copies_bytes: u64,
    /// Linux-release build workspace (~/owllm-build) — cargo targets from WSL
    /// builds, the single biggest silent grower (30 GB measured). Stale targets
    /// are pruned by the janitor after a week idle.
    pub build_bytes: u64,
    /// Meaningful only where there's a managed VM disk (Windows/WSL today).
    pub available: bool,
    /// `.wslconfig` has `sparseVhd=true`, so freed space auto-returns to Windows
    /// and the disk never balloons (the preventive fix — see sandbox_enable_sparse).
    pub sparse_config: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReclaimResult {
    pub before_bytes: u64,
    pub after_bytes: u64,
    pub freed_bytes: u64,
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Resolve a real Linux distro (skip docker-desktop etc.), like the other commands.
#[cfg(windows)]
fn resolve_linux_distro(distro: Option<String>) -> Result<String, String> {
    distro
        .filter(|d| !d.trim().is_empty())
        .or_else(crate::wsl::best_linux_distro)
        .ok_or_else(|| {
            "No Ubuntu/Linux distro in WSL — set it up on the Home page first.".to_string()
        })
}

/// Run a PowerShell snippet (with optional env vars) and return its stdout.
#[cfg(windows)]
fn run_powershell(script: &str, env: &[(&str, &str)]) -> Option<String> {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Locate the distro's ext4.vhdx via the Lxss registry (DistributionName → BasePath)
/// and return (path, size_bytes). The distro name is passed via env to avoid any
/// quoting in the PowerShell body.
#[cfg(windows)]
fn wsl_vhdx(distro: &str) -> Option<(String, u64)> {
    const PS: &str = r#"
$d = $env:OWLLM_DISTRO
Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' -ErrorAction SilentlyContinue | ForEach-Object {
  $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
  if ($p.DistributionName -eq $d -and $p.BasePath) {
    $v = Join-Path $p.BasePath 'ext4.vhdx'
    if (Test-Path $v) { Write-Output ('{0}|{1}' -f $v, (Get-Item $v).Length) }
  }
}
"#;
    let out = run_powershell(PS, &[("OWLLM_DISTRO", distro)])?;
    let line = out.lines().find(|l| l.contains('|'))?;
    let mut parts = line.trim().splitn(2, '|');
    let path = parts.next()?.to_string();
    let bytes = parts.next()?.trim().parse().ok()?;
    Some((path, bytes))
}

/// Measure reclaimable caches + sandbox copies inside the distro (bytes), behind
/// sentinels so login-shell noise can't corrupt the numbers.
#[cfg(windows)]
const DISK_DU_SCRIPT: &str = r#"c=0
for d in "$HOME/.cache/uv" "$HOME/.npm/_cacache" "$HOME/.cache/pip" "$HOME/.cache/huggingface/hub/.locks" "$HOME/.owllm/sbhome/.cache" "$HOME/.owllm/sbhome/.npm"; do
  if [ -e "$d" ]; then s=$(du -sb "$d" 2>/dev/null | cut -f1); c=$((c + ${s:-0})); fi
done
echo "OWLLM_CACHE=$c"
if [ -d "$HOME/owllm" ]; then echo "OWLLM_COPIES=$(du -sb "$HOME/owllm" 2>/dev/null | cut -f1)"; else echo "OWLLM_COPIES=0"; fi
if [ -d "$HOME/owllm-build" ]; then echo "OWLLM_BUILD=$(du -sb "$HOME/owllm-build" 2>/dev/null | cut -f1)"; else echo "OWLLM_BUILD=0"; fi
"#;

#[cfg(windows)]
fn parse_sentinel(out: &str, key: &str) -> u64 {
    out.lines()
        .find_map(|l| l.trim().strip_prefix(key))
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0)
}

#[cfg(windows)]
fn disk_usage_impl(distro: Option<String>) -> SandboxDisk {
    let Ok(distro) = resolve_linux_distro(distro) else {
        return SandboxDisk::default();
    };
    let (vhdx_path, vhdx_bytes) = match wsl_vhdx(&distro) {
        Some((p, b)) => (Some(p), b),
        None => (None, 0),
    };
    let (cache_bytes, copies_bytes, build_bytes) =
        match crate::wsl::run_in_distro_script(&distro, DISK_DU_SCRIPT) {
            Ok(out) => (
                parse_sentinel(&out, "OWLLM_CACHE="),
                parse_sentinel(&out, "OWLLM_COPIES="),
                parse_sentinel(&out, "OWLLM_BUILD="),
            ),
            Err(_) => (0, 0, 0),
        };
    SandboxDisk {
        vhdx_bytes,
        vhdx_path,
        cache_bytes,
        copies_bytes,
        build_bytes,
        available: true,
        sparse_config: wslconfig_has_sparse(),
    }
}

#[cfg(not(windows))]
fn disk_usage_impl(_distro: Option<String>) -> SandboxDisk {
    SandboxDisk::default()
}

// ---- prevent inflation: sparse WSL disk (the OPTIMAL fix) ------------------
//
// The reactive commands above shrink the .vhdx AFTER it has already ballooned.
// The real cure is to stop it ballooning at all: a SPARSE virtual disk hands
// freed blocks back to Windows automatically, so deleting caches/builds inside
// the distro immediately reclaims host space — no manual compaction, no UAC, no
// restart. Two levers, applied together:
//   1. `%USERPROFILE%\.wslconfig` → `[experimental] sparseVhd=true`. Zero-
//      disruption global default: EVERY WSL disk (existing on next start + all
//      future ones) becomes sparse. This is the "never happens again" fix.
//   2. `wsl --manage <distro> --set-sparse true` converts an ALREADY-inflated
//      distro in place (needs it stopped, so we terminate it first — brief).
// Cross-platform: Linux runs agents via bubblewrap on the host filesystem and
// macOS via Lima (which manages its own disk), so neither has this managed,
// ever-growing vhdx — the command is a reported no-op there.

/// Merge `sparseVhd=true` into a `.wslconfig`'s `[experimental]` section.
/// Returns the new file text, or `None` when it is ALREADY `true` (so the
/// caller skips the write). Preserves every other setting/section. Pure +
/// unit-tested (compiled on every OS).
#[cfg_attr(not(windows), allow(dead_code))]
fn merge_sparse_into_wslconfig(existing: &str) -> Option<String> {
    let is_sparse_line = |l: &str| l.trim_start().to_ascii_lowercase().starts_with("sparsevhd");
    // Already enabled? (value is case/space-insensitive)
    for l in existing.lines() {
        if is_sparse_line(l) {
            if let Some((_, v)) = l.split_once('=') {
                if v.trim().eq_ignore_ascii_case("true") {
                    return None;
                }
            }
        }
    }
    let mut lines: Vec<String> = existing.lines().map(|s| s.to_string()).collect();
    // A non-true sparseVhd line already exists → flip it in place.
    for l in lines.iter_mut() {
        if is_sparse_line(l) && l.contains('=') {
            *l = "sparseVhd=true".to_string();
            let mut out = lines.join("\n");
            out.push('\n');
            return Some(out);
        }
    }
    // An [experimental] section exists → add the key just under its header.
    if let Some(i) = lines
        .iter()
        .position(|l| l.trim().eq_ignore_ascii_case("[experimental]"))
    {
        lines.insert(i + 1, "sparseVhd=true".to_string());
        let mut out = lines.join("\n");
        out.push('\n');
        return Some(out);
    }
    // No section at all → append a fresh one, keeping any existing content.
    let mut out = existing.trim_end().to_string();
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str("[experimental]\nsparseVhd=true\n");
    Some(out)
}

#[cfg(windows)]
fn wslconfig_path() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE").map(|h| std::path::PathBuf::from(h).join(".wslconfig"))
}

/// True when `%USERPROFILE%\.wslconfig` already enables sparse disks — read
/// cheaply by reusing the pure merge helper (it returns None iff already `true`).
#[cfg(windows)]
fn wslconfig_has_sparse() -> bool {
    wslconfig_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| merge_sparse_into_wslconfig(&s).is_none())
        .unwrap_or(false)
}

/// Ensure the `.wslconfig` global default has `sparseVhd=true`. No WSL restart —
/// it takes effect on the next natural start. Ok(true) if it wrote a change.
#[cfg(windows)]
pub(crate) fn ensure_sparse_config() -> Result<bool, String> {
    let p = wslconfig_path().ok_or_else(|| "no USERPROFILE".to_string())?;
    let existing = std::fs::read_to_string(&p).unwrap_or_default();
    match merge_sparse_into_wslconfig(&existing) {
        None => Ok(false),
        Some(updated) => {
            std::fs::write(&p, updated).map_err(|e| format!("write {}: {e}", p.display()))?;
            Ok(true)
        }
    }
}

// ---- WSL MEMORY: the OOM-killer that reads as "CLI exited 1, no output" -----
// A WSL-isolated project runs the agent CLI INSIDE the distro, and WSL2's
// default memory cap is 50% of host RAM. A context-heavy run (minified bundles,
// large greps) can pass that cap, at which point the Linux OOM killer SIGKILLs
// the biggest process on the box — usually the CLI itself. It dies without
// flushing, so the app only sees a non-zero exit with empty stdout/stderr while
// the real cause sits in the distro's kernel log. Host runs never hit this:
// Windows pages to disk instead of killing.
//
// Two halves, both here: raise the cap (`ensure_memory_config`) and, when it
// still happens, READ the kernel log and say so (`wsl_oom_report`).

/// Recommended WSL2 `[wsl2] memory` / `swap` for this host, in GB.
/// 75% of physical RAM (vs WSL's 50% default) leaves Windows headroom while
/// giving a context-heavy agent room to finish; swap = half of that, capped, so
/// a spike pages instead of being killed. Floors keep tiny hosts usable.
/// Pure given `host_ram_gb` so it is unit-testable on every OS.
fn recommended_wsl_memory_gb(host_ram_gb: u32) -> (u32, u32) {
    let mem = ((host_ram_gb as u64 * 3) / 4).clamp(4, 64) as u32;
    let swap = (mem / 2).clamp(2, 16);
    (mem, swap)
}

/// Merge `memory=`/`swap=` into a `.wslconfig`'s `[wsl2]` section, mirroring
/// `merge_sparse_into_wslconfig`. Returns the new file text, or `None` when the
/// file ALREADY grants at least this much (never lowers a user's own higher
/// limit). Preserves every other setting/section. Pure + unit-tested.
#[cfg_attr(not(windows), allow(dead_code))]
fn merge_memory_into_wslconfig(existing: &str, memory_gb: u32, swap_gb: u32) -> Option<String> {
    let cur_mem = wslconfig_key_gb(existing, "memory");
    let cur_swap = wslconfig_key_gb(existing, "swap");
    if cur_mem.is_some_and(|m| m >= memory_gb) && cur_swap.is_some_and(|s| s >= swap_gb) {
        return None;
    }
    let want_mem = cur_mem.unwrap_or(0).max(memory_gb);
    let want_swap = cur_swap.unwrap_or(0).max(swap_gb);
    let is_key = |l: &str, k: &str| {
        l.trim_start()
            .to_ascii_lowercase()
            .starts_with(&format!("{k}="))
            || l.trim_start()
                .to_ascii_lowercase()
                .starts_with(&format!("{k} ="))
    };
    let mut lines: Vec<String> = existing.lines().map(|s| s.to_string()).collect();
    let mut wrote_mem = false;
    let mut wrote_swap = false;
    for l in lines.iter_mut() {
        if is_key(l, "memory") {
            *l = format!("memory={want_mem}GB");
            wrote_mem = true;
        } else if is_key(l, "swap") {
            *l = format!("swap={want_swap}GB");
            wrote_swap = true;
        }
    }
    if !wrote_mem || !wrote_swap {
        let mut pending: Vec<String> = Vec::new();
        if !wrote_mem {
            pending.push(format!("memory={want_mem}GB"));
        }
        if !wrote_swap {
            pending.push(format!("swap={want_swap}GB"));
        }
        match lines
            .iter()
            .position(|l| l.trim().eq_ignore_ascii_case("[wsl2]"))
        {
            // A [wsl2] section exists → add the missing keys just under it.
            Some(i) => {
                for (n, k) in pending.into_iter().enumerate() {
                    lines.insert(i + 1 + n, k);
                }
            }
            // No section at all → append a fresh one, keeping existing content.
            None => {
                if !lines.is_empty() {
                    lines.push(String::new());
                }
                lines.push("[wsl2]".to_string());
                lines.extend(pending);
            }
        }
    }
    let mut out = lines.join("\n");
    out.push('\n');
    Some(out)
}

/// Read a `.wslconfig` size value ("24GB", "16384MB", "8") as whole GB.
/// Anything unparsable reads as absent, so we then treat it as "not granted".
#[cfg_attr(not(windows), allow(dead_code))]
fn wslconfig_key_gb(text: &str, key: &str) -> Option<u32> {
    for l in text.lines() {
        let Some((k, v)) = l.trim().split_once('=') else {
            continue;
        };
        if !k.trim().eq_ignore_ascii_case(key) {
            continue;
        }
        let v = v.trim().to_ascii_lowercase();
        let digits: String = v.chars().take_while(|c| c.is_ascii_digit()).collect();
        let Ok(n) = digits.parse::<u64>() else {
            continue;
        };
        return Some(if v.ends_with("mb") {
            (n / 1024) as u32
        } else if v.ends_with("kb") {
            (n / 1024 / 1024) as u32
        } else {
            n as u32
        });
    }
    None
}

// ---- WSL MEMORY GIVE-BACK: idle vmmem must shrink, not hoard ----------------
//
// WSL2 keeps every byte the VM ever touched (page cache from builds, greps,
// npm installs) until `wsl --shutdown` — which we deliberately never run. So a
// day of agent runs leaves a multi-GB `vmmem` sitting on the host with the
// distro internally idle, and the user can't even attribute it to this app.
// `[experimental] autoMemoryReclaim=gradual` (WSL >= 1.3.10) makes the VM hand
// idle cached memory back to Windows; older WSL ignores unknown keys, so the
// setting is safe to write unconditionally.

/// Merge `autoMemoryReclaim=gradual` into a `.wslconfig`'s `[experimental]`
/// section. Returns the new file text, or `None` when the key is ALREADY set to
/// any value — a user's own choice (`dropcache`, `disabled`) is never
/// overridden. Preserves every other setting/section. Pure + unit-tested.
#[cfg_attr(not(windows), allow(dead_code))]
fn merge_reclaim_into_wslconfig(existing: &str) -> Option<String> {
    let is_reclaim_line = |l: &str| {
        l.trim_start()
            .to_ascii_lowercase()
            .starts_with("automemoryreclaim")
    };
    if existing.lines().any(|l| is_reclaim_line(l) && l.contains('=')) {
        return None;
    }
    let mut lines: Vec<String> = existing.lines().map(|s| s.to_string()).collect();
    // An [experimental] section exists → add the key just under its header.
    if let Some(i) = lines
        .iter()
        .position(|l| l.trim().eq_ignore_ascii_case("[experimental]"))
    {
        lines.insert(i + 1, "autoMemoryReclaim=gradual".to_string());
        let mut out = lines.join("\n");
        out.push('\n');
        return Some(out);
    }
    // No section at all → append a fresh one, keeping any existing content.
    let mut out = existing.trim_end().to_string();
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str("[experimental]\nautoMemoryReclaim=gradual\n");
    Some(out)
}

/// Ensure the `.wslconfig` global default has `autoMemoryReclaim=gradual`.
/// No WSL restart — it takes effect on the next VM start, and the warm-check
/// pre-flight calls this BEFORE starting a cold distro, so every VM this app
/// boots runs with give-back on. Ok(true) if it wrote a change.
#[cfg(windows)]
pub(crate) fn ensure_reclaim_config() -> Result<bool, String> {
    let p = wslconfig_path().ok_or_else(|| "no USERPROFILE".to_string())?;
    let existing = std::fs::read_to_string(&p).unwrap_or_default();
    match merge_reclaim_into_wslconfig(&existing) {
        None => Ok(false),
        Some(updated) => {
            std::fs::write(&p, updated).map_err(|e| format!("write {}: {e}", p.display()))?;
            Ok(true)
        }
    }
}

/// What the OOM killer recorded, in units the user can act on.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct OomHit {
    /// Process the kernel killed, e.g. "claude.exe".
    pub task: String,
    /// Resident memory it held when killed.
    pub used_gb: f32,
    /// The distro's total RAM (its WSL cap), when readable.
    pub limit_gb: Option<f32>,
}

/// Parse the kernel's OOM verdict out of a `/var/log/kern.log` + `dmesg` dump.
///
/// Only accepts a kill whose ISO timestamp is at or after `cutoff_iso` — an OOM
/// from last week must never be blamed for today's exit. ISO-8601 sorts
/// lexicographically, so a string compare of the leading 19 chars IS the time
/// compare. Lines with no parsable timestamp are ignored for the same reason.
/// Pure + unit-tested against a real captured log line.
pub(crate) fn parse_oom_report(text: &str, cutoff_iso: &str) -> Option<OomHit> {
    const MARK: &str = "Out of memory: Killed process";
    let limit_gb = text.lines().find_map(|l| {
        let rest = l.trim().strip_prefix("MemTotal:")?;
        let kb: u64 = rest.split_whitespace().next()?.parse().ok()?;
        Some(kb as f32 / 1024.0 / 1024.0)
    });
    // Last matching kill wins — it is the most recent.
    let mut hit: Option<OomHit> = None;
    for line in text.lines() {
        let Some(at) = line.find(MARK) else { continue };
        // Leading ISO stamp (kern.log, and `dmesg --time-format=iso`).
        let stamp: String = line.chars().take(19).collect();
        let dated = stamp.len() == 19
            && stamp.as_bytes()[4] == b'-'
            && (stamp.as_bytes()[10] == b'T' || stamp.as_bytes()[10] == b' ');
        if !dated || stamp.as_str() < cutoff_iso {
            continue;
        }
        let tail = &line[at + MARK.len()..];
        // "… 26855 (claude.exe) total-vm:…kB, anon-rss:12863744kB, …"
        let task = tail
            .split_once('(')
            .and_then(|(_, r)| r.split_once(')'))
            .map(|(n, _)| n.to_string())
            .unwrap_or_default();
        if task.is_empty() {
            continue;
        }
        let used_gb = tail
            .split("anon-rss:")
            .nth(1)
            .and_then(|r| {
                let d: String = r.chars().take_while(|c| c.is_ascii_digit()).collect();
                d.parse::<u64>().ok()
            })
            .map(|kb| kb as f32 / 1024.0 / 1024.0)
            .unwrap_or(0.0);
        hit = Some(OomHit {
            task,
            used_gb,
            limit_gb,
        });
    }
    hit
}

/// Human sentence for an OOM hit, naming the cause AND the one action that
/// fixes it. Pure so the wording is gate-assertable.
pub(crate) fn oom_message(cli: &str, hit: &OomHit) -> String {
    let limit = match hit.limit_gb {
        Some(g) => format!(" of a {g:.1} GB WSL limit"),
        None => String::new(),
    };
    format!(
        "{cli} CLI was killed by Linux out-of-memory — this project runs in WSL, \
         and {} was using {:.1} GB{limit}. Nothing is wrong with your account, the \
         model or the task. Raise the WSL memory limit (Settings → Sandbox → \
         \"Raise WSL memory\"), then run it again.",
        hit.task, hit.used_gb
    )
}

/// Ask the distro's kernel whether it killed this CLI in the last 10 minutes.
/// Windows-only: a WSL-isolated run is the only shape with a hard memory cap —
/// Linux agents run on the host and macOS uses Lima, neither of which produces
/// this failure mode. Best-effort; any probe failure reads as "no evidence".
#[cfg(windows)]
pub(crate) fn wsl_oom_report(cli: &str, cwd: Option<&str>) -> Option<String> {
    use std::os::windows::process::CommandExt;
    if !is_isolated(cwd) {
        return None;
    }
    let distro = resolve_linux_distro(None).ok()?;
    // One round trip: the cutoff is computed INSIDE the distro so it is in the
    // same clock/zone as the log stamps we compare it against.
    const PROBE: &str = "date -d '-10 minutes' '+OWLLM_CUTOFF=%Y-%m-%dT%H:%M:%S' 2>/dev/null; \
         grep MemTotal /proc/meminfo 2>/dev/null; \
         { cat /var/log/kern.log 2>/dev/null; dmesg --time-format=iso 2>/dev/null; } \
         | grep -F 'Out of memory: Killed process' | tail -n 20";
    let out = std::process::Command::new("wsl.exe")
        .args(["-d", &distro, "--", "sh", "-lc", PROBE])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let cutoff = text
        .lines()
        .find_map(|l| l.trim().strip_prefix("OWLLM_CUTOFF="))?
        .to_string();
    let hit = parse_oom_report(&text, &cutoff)?;
    Some(oom_message(cli, &hit))
}

#[cfg(not(windows))]
pub(crate) fn wsl_oom_report(_cli: &str, _cwd: Option<&str>) -> Option<String> {
    None
}

/// Raise `%USERPROFILE%\.wslconfig`'s `[wsl2] memory`/`swap` to this host's
/// recommendation. Never lowers an existing higher value. Takes effect on the
/// next WSL start — deliberately does NOT run `wsl --shutdown`, which would kill
/// every running agent and any other distro work the user has open.
/// Returns the (memory_gb, swap_gb) now configured, and whether it wrote.
#[cfg(windows)]
pub(crate) fn ensure_memory_config() -> Result<(u32, u32, bool), String> {
    let host_gb = {
        use sysinfo::System;
        let mut s = System::new();
        s.refresh_memory();
        ((s.total_memory() as f64) / 1024.0 / 1024.0 / 1024.0).round() as u32
    };
    let (mem, swap) = recommended_wsl_memory_gb(host_gb);
    let p = wslconfig_path().ok_or_else(|| "no USERPROFILE".to_string())?;
    let existing = std::fs::read_to_string(&p).unwrap_or_default();
    match merge_memory_into_wslconfig(&existing, mem, swap) {
        None => Ok((
            wslconfig_key_gb(&existing, "memory").unwrap_or(mem),
            wslconfig_key_gb(&existing, "swap").unwrap_or(swap),
            false,
        )),
        Some(updated) => {
            std::fs::write(&p, &updated).map_err(|e| format!("write {}: {e}", p.display()))?;
            Ok((
                wslconfig_key_gb(&updated, "memory").unwrap_or(mem),
                wslconfig_key_gb(&updated, "swap").unwrap_or(swap),
                true,
            ))
        }
    }
}

/// Result of the "Raise WSL memory" action, for the UI.
#[derive(Debug, Clone, serde::Serialize)]
pub struct WslMemoryPlan {
    pub memory_gb: u32,
    pub swap_gb: u32,
    /// True when the config file was changed by this call.
    pub changed: bool,
    /// True when a WSL restart is still needed for it to take effect.
    pub restart_required: bool,
}

/// User-triggered: raise the WSL memory cap so a context-heavy agent stops
/// being OOM-killed. No-op (reported, not failed) off Windows, where agents do
/// not run inside a memory-capped VM.
#[tauri::command]
pub async fn sandbox_raise_memory() -> Result<WslMemoryPlan, String> {
    #[cfg(windows)]
    {
        // Raising the cap without give-back would let vmmem hoard even more —
        // the two settings only make sense together.
        if let Err(e) = ensure_reclaim_config() {
            eprintln!("wslconfig autoMemoryReclaim not ensured: {e}");
        }
        let (memory_gb, swap_gb, changed) = ensure_memory_config()?;
        let restart_required = changed && !running_distros().is_empty();
        Ok(WslMemoryPlan {
            memory_gb,
            swap_gb,
            changed,
            restart_required,
        })
    }
    #[cfg(not(windows))]
    {
        Ok(WslMemoryPlan {
            memory_gb: 0,
            swap_gb: 0,
            changed: false,
            restart_required: false,
        })
    }
}

/// Convert an existing distro's disk to sparse in place. `--set-sparse` needs the
/// distro stopped, so terminate it first (brief — same trick ensure_user uses).
///
/// ⚠ Modern WSL DISABLES sparse by default "due to potential data corruption" and
/// rejects the plain command, so this passes `--allow-unsafe` — which is why the
/// whole sparse path is an EXPLICIT, warned opt-in (never auto-applied). Idempotent;
/// surfaces wsl.exe's (UTF-16LE) error text on failure.
#[cfg(windows)]
fn set_distro_sparse(distro: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("wsl.exe")
        .args(["--terminate", distro])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
    let out = std::process::Command::new("wsl.exe")
        .args(["--manage", distro, "--set-sparse", "true", "--allow-unsafe"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("run wsl --manage: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let raw: Vec<u8> = out
        .stderr
        .into_iter()
        .chain(out.stdout)
        .filter(|&b| b != 0)
        .collect();
    Err(format!(
        "wsl --manage --set-sparse failed: {}",
        String::from_utf8_lossy(&raw).trim()
    ))
}

/// Outcome of enabling sparse — mirrored to the UI so the result is self-explaining.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SparseResult {
    /// `.wslconfig` now has sparseVhd=true (written this call or already present).
    pub config_enabled: bool,
    /// The existing distro's disk was converted to sparse this call.
    pub distro_converted: bool,
    /// Whether this OS has a managed vhdx to make sparse (Windows/WSL only).
    pub applicable: bool,
    /// Human-readable outcome for the card.
    pub detail: String,
}

#[cfg(windows)]
fn enable_sparse_impl(
    distro: Option<String>,
    convert_existing: bool,
) -> Result<SparseResult, String> {
    // ADVANCED opt-in only (the UI gates this behind an explicit data-corruption
    // warning) — Microsoft disables sparse by default for safety, so we never
    // auto-apply it. Set the global default first (covers future distros, no restart).
    let wrote = ensure_sparse_config()?;
    let mut r = SparseResult {
        config_enabled: true,
        distro_converted: false,
        applicable: true,
        detail: if wrote {
            "Sparse disks enabled — freed space now returns to Windows automatically (advanced; Microsoft flags a small data-corruption risk).".to_string()
        } else {
            "Sparse disks were already enabled.".to_string()
        },
    };
    if convert_existing {
        // Convert the disk they ALREADY have. If this can't run (old WSL without
        // --set-sparse, or no distro), don't fail — the `.wslconfig` default above
        // still makes every disk sparse on the next WSL restart / after a WSL update.
        match resolve_linux_distro(distro) {
            Ok(distro) => match set_distro_sparse(&distro) {
                Ok(()) => {
                    r.distro_converted = true;
                    r.detail = format!(
                        "Auto-shrink is on and the existing sandbox disk ({distro}) was converted — freed space now returns to Windows automatically, so it won't balloon again."
                    );
                }
                Err(e) => {
                    r.detail = format!(
                        "Auto-shrink is set as the default (it applies on the next WSL restart). Converting the current disk now didn't run — likely an older WSL: {e}"
                    );
                }
            },
            Err(e) => {
                r.detail = format!(
                    "Auto-shrink default is set, but no Linux distro was found to convert: {e}"
                );
            }
        }
    }
    Ok(r)
}

#[cfg(not(windows))]
fn enable_sparse_impl(
    _distro: Option<String>,
    _convert_existing: bool,
) -> Result<SparseResult, String> {
    // No managed, ever-growing vhdx off Windows: bubblewrap (Linux) runs on the
    // host filesystem and Lima (macOS) manages its own disk. Report not-applicable
    // so the UI can hide the control rather than offer a no-op button.
    Ok(SparseResult {
        applicable: false,
        detail: "The sandbox on this OS uses the host filesystem (no virtual disk), so there's nothing to make sparse.".to_string(),
        ..Default::default()
    })
}

/// Make the WSL sandbox disk sparse so freed space auto-returns to Windows and
/// it never inflates. Always writes the `.wslconfig` default (no restart); when
/// `convertExisting` is true it also converts the current distro's disk (brief
/// WSL restart). No-op (reported) on Linux/macOS.
#[tauri::command]
pub async fn sandbox_enable_sparse(
    distro: Option<String>,
    convert_existing: bool,
) -> Result<SparseResult, String> {
    tokio::task::spawn_blocking(move || enable_sparse_impl(distro, convert_existing))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

// ---- SAFE default: automatic cache-trim (no sparse, no admin, no risk) ------
//
// Sparse is off by default (unsafe), so the DEFAULT anti-inflation measure is
// plain housekeeping: when the regenerable caches (uv/npm/pip) inside the distro
// have grown large, clear them, then `fstrim` so the freed blocks are ready for
// the next compaction. Caches are the main thing that balloons a build sandbox;
// dropping them keeps logical usage — and thus the .vhdx's growth — in check
// without ever touching project files, credentials, or models. Nothing here can
// corrupt data or needs elevation.

/// Caches above this get cleared by the automatic pass. Below it we leave them —
/// clearing forces a re-download on the next run, not worth it for a small cache.
#[cfg(windows)]
const AUTOTRIM_CACHE_THRESHOLD: u64 = 8 * 1024 * 1024 * 1024; // 8 GiB

/// Distros currently RUNNING (`wsl -l --running -q`, UTF-16LE) — checked so the
/// startup pass never cold-starts WSL just to housekeep.
#[cfg(windows)]
fn running_distros() -> Vec<String> {
    use std::os::windows::process::CommandExt;
    match std::process::Command::new("wsl.exe")
        .args(["-l", "--running", "-q"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        Ok(o) => {
            let raw: Vec<u8> = o.stdout.into_iter().filter(|&b| b != 0).collect();
            String::from_utf8_lossy(&raw)
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        }
        Err(_) => Vec::new(),
    }
}

/// Stale Linux-build workspaces: any `target/` under the app-owned
/// `~/owllm-build` with no file touched for a week is deleted. The warm cargo
/// cache of an active release week survives (mtime-fresh); an abandoned one
/// stops costing tens of GB forever. Rooted at `$HOME/owllm-build` only —
/// never a user directory. Reports bytes freed via before/after `du`.
#[cfg(windows)]
const PRUNE_BUILD_WORKSPACE_SCRIPT: &str = r#"b=0; a=0
if [ -d "$HOME/owllm-build" ]; then
  b=$(du -sb "$HOME/owllm-build" 2>/dev/null | cut -f1)
  find "$HOME/owllm-build" -mindepth 2 -maxdepth 6 -type d -name target 2>/dev/null | while IFS= read -r t; do
    if [ -z "$(find "$t" -newermt "7 days ago" -print -quit 2>/dev/null)" ]; then rm -rf "$t"; fi
  done
  a=$(du -sb "$HOME/owllm-build" 2>/dev/null | cut -f1)
fi
echo "OWLLM_BUILD_FREED=$(( ${b:-0} - ${a:-0} ))"
"#;

/// Clear caches when large (or `force`d by the manual button), prune stale
/// linux-build targets, then fstrim. Returns bytes freed. Safe: regenerable
/// caches and app-owned build output only, no admin.
#[cfg(windows)]
fn trim_impl(distro: Option<String>, force: bool) -> Result<u64, String> {
    let distro = resolve_linux_distro(distro)?;
    let cache = crate::wsl::run_in_distro_script(&distro, DISK_DU_SCRIPT)
        .ok()
        .map(|o| parse_sentinel(&o, "OWLLM_CACHE="))
        .unwrap_or(0);
    let mut freed = 0;
    if force || cache >= AUTOTRIM_CACHE_THRESHOLD {
        if let Ok(out) = crate::wsl::run_in_distro_script(&distro, CLEAR_CACHE_SCRIPT) {
            freed = parse_sentinel(&out, "OWLLM_FREED=");
        }
    }
    // Week-stale cargo targets in the linux-build workspace — the 30 GB class
    // of growth no cache-clean ever saw.
    if let Ok(out) = crate::wsl::run_in_distro_script(&distro, PRUNE_BUILD_WORKSPACE_SCRIPT) {
        freed += parse_sentinel(&out, "OWLLM_BUILD_FREED=");
    }
    // fstrim (root — no password in WSL) marks the freed blocks reclaimable. Safe
    // on any WSL and a no-op when there's nothing to trim.
    let _ = crate::wsl::run_in_distro_script_user(
        &distro,
        Some("root"),
        "fstrim -a 2>/dev/null || true",
    );
    Ok(freed)
}

#[cfg(not(windows))]
fn trim_impl(_distro: Option<String>, _force: bool) -> Result<u64, String> {
    // Linux/macOS sandboxes run on the host FS — no vhdx cache to reclaim.
    Ok(0)
}

/// Periodic housekeeping (called by the global disk janitor on its schedule):
/// if a real Linux distro is ALREADY running, clear oversized caches and prune
/// stale build targets. Best-effort, background, never cold-starts WSL just to
/// housekeep. Keeps a long-lived session's sandbox from ballooning unattended.
#[cfg(windows)]
pub(crate) fn auto_housekeep() {
    let Some(distro) = crate::wsl::best_linux_distro() else {
        return;
    };
    if !running_distros().iter().any(|d| d == &distro) {
        return;
    }
    let _ = trim_impl(Some(distro), false);
}

#[cfg(not(windows))]
pub(crate) fn auto_housekeep() {}

/// Trim the sandbox now — clear regenerable caches + fstrim. Safe (no restart,
/// no admin, no data risk). `force` clears caches regardless of size. Returns
/// bytes freed.
#[tauri::command]
pub async fn sandbox_trim(distro: Option<String>, force: bool) -> Result<u64, String> {
    tokio::task::spawn_blocking(move || trim_impl(distro, force))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[tauri::command]
pub async fn sandbox_disk_usage(distro: Option<String>) -> SandboxDisk {
    tokio::task::spawn_blocking(move || disk_usage_impl(distro))
        .await
        .unwrap_or_default()
}

/// Drop regenerable build caches inside the distro. Uses each tool's own cache-
/// clean (so its bookkeeping stays consistent) with an rm fallback. NEVER touches
/// project files, credentials, or downloaded models. Returns bytes freed.
#[cfg(windows)]
const CLEAR_CACHE_SCRIPT: &str = r#"before=$(du -sbc "$HOME/.cache/uv" "$HOME/.npm/_cacache" "$HOME/.cache/pip" "$HOME/.owllm/sbhome/.cache" "$HOME/.owllm/sbhome/.npm" 2>/dev/null | awk 'END{print $1+0}')
command -v uv  >/dev/null 2>&1 && uv cache clean  >/dev/null 2>&1 || rm -rf "$HOME/.cache/uv"
command -v npm >/dev/null 2>&1 && npm cache clean --force >/dev/null 2>&1 || rm -rf "$HOME/.npm/_cacache"
rm -rf "$HOME/.cache/pip" "$HOME/.owllm/sbhome/.cache" "$HOME/.owllm/sbhome/.npm"
echo "OWLLM_FREED=$before"
"#;

#[cfg(windows)]
fn clear_caches_impl(distro: Option<String>) -> Result<u64, String> {
    let distro = resolve_linux_distro(distro)?;
    let out = crate::wsl::run_in_distro_script(&distro, CLEAR_CACHE_SCRIPT)?;
    Ok(parse_sentinel(&out, "OWLLM_FREED="))
}

#[cfg(not(windows))]
fn clear_caches_impl(_distro: Option<String>) -> Result<u64, String> {
    Err("cache cleanup is implemented for WSL (Windows) today".into())
}

/// Clear regenerable caches. Returns bytes freed. Safe — no restart.
#[tauri::command]
pub async fn sandbox_clear_caches(distro: Option<String>) -> Result<u64, String> {
    tokio::task::spawn_blocking(move || clear_caches_impl(distro))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

/// Physically shrink the .vhdx: fstrim (mark free blocks) → `wsl --shutdown` →
/// `diskpart compact vdisk`. The compaction needs admin, so it runs through a
/// one-shot elevated PowerShell (UAC). DISRUPTIVE — stops all running WSL. The
/// result is SELF-VERIFYING: we report the real file size before and after.
#[cfg(windows)]
fn reclaim_disk_impl(distro: Option<String>) -> Result<ReclaimResult, String> {
    let distro = resolve_linux_distro(distro)?;
    let (vhdx, before) = wsl_vhdx(&distro)
        .ok_or_else(|| "Could not locate the WSL virtual disk (ext4.vhdx).".to_string())?;

    // 1) Discard free blocks inside the distro so compaction can reclaim them
    //    (a non-sparse vhdx only gives back blocks that have been trimmed).
    let _ = crate::wsl::run_in_distro_script_user(
        &distro,
        Some("root"),
        "fstrim -av 2>/dev/null || true",
    );

    // 2) Write the diskpart + wrapper scripts to temp, run the wrapper ELEVATED.
    let tmp = std::env::temp_dir();
    let dp = tmp.join("owllm_compact.txt");
    let res = tmp.join("owllm_reclaim_result.txt");
    let wrap = tmp.join("owllm_reclaim.ps1");
    let _ = std::fs::remove_file(&res);
    std::fs::write(
        &dp,
        format!(
            "select vdisk file=\"{vhdx}\"\nattach vdisk readonly\ncompact vdisk\ndetach vdisk\n"
        ),
    )
    .map_err(|e| format!("write diskpart script: {e}"))?;
    // Bake the paths straight into the wrapper FILE (single-quoted → backslashes
    // and the {guid} in the path are literal). A file sidesteps ALL command-line
    // quoting, so the elevated launch below needs only the wrapper's own path.
    let wrap_body = format!(
        "$ErrorActionPreference = 'SilentlyContinue'\n\
         $vhdx = '{vhdx}'\n\
         $dp   = '{dp}'\n\
         $res  = '{res}'\n\
         wsl.exe --shutdown\n\
         Start-Sleep -Seconds 8\n\
         $b = (Get-Item -LiteralPath $vhdx).Length\n\
         diskpart /s \"$dp\" | Out-Null\n\
         $a = (Get-Item -LiteralPath $vhdx).Length\n\
         Set-Content -Path $res -Value \"$b`n$a\"\n",
        vhdx = vhdx,
        dp = dp.display(),
        res = res.display(),
    );
    std::fs::write(&wrap, wrap_body).map_err(|e| format!("write wrapper: {e}"))?;

    // 3) Elevate: a non-elevated PowerShell launches the wrapper elevated (UAC)
    //    and waits. Only the wrapper's path crosses the command line (as its own
    //    -ArgumentList element, so spaces are safe).
    let launch = format!(
        "Start-Process powershell -Verb RunAs -Wait -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','{}')",
        wrap.display(),
    );
    use std::os::windows::process::CommandExt;
    let status = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &launch])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| format!("launch elevated compaction: {e}"))?;
    if !status.success() {
        return Err("The disk-reclaim helper exited with an error.".into());
    }

    // 4) Read the self-verifying before/after the elevated run wrote.
    let txt = std::fs::read_to_string(&res).map_err(|_| {
        "Compaction was cancelled or could not run (it needs the admin prompt). Nothing was changed.".to_string()
    })?;
    let nums: Vec<u64> = txt.lines().filter_map(|l| l.trim().parse().ok()).collect();
    let after = nums.get(1).copied().unwrap_or(before);
    let before = nums.first().copied().unwrap_or(before);
    let _ = std::fs::remove_file(&res);
    Ok(ReclaimResult {
        before_bytes: before,
        after_bytes: after,
        freed_bytes: before.saturating_sub(after),
    })
}

#[cfg(not(windows))]
fn reclaim_disk_impl(_distro: Option<String>) -> Result<ReclaimResult, String> {
    Err("disk reclaim is implemented for WSL (Windows) today".into())
}

/// Compact the WSL virtual disk. Needs admin (UAC) + restarts WSL. Returns the
/// real file size before/after so the UI can show what was reclaimed.
#[tauri::command]
pub async fn sandbox_reclaim_disk(distro: Option<String>) -> Result<ReclaimResult, String> {
    tokio::task::spawn_blocking(move || reclaim_disk_impl(distro))
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

#[cfg(any(target_os = "linux", target_os = "macos"))]
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
            if se.trim().is_empty() {
                so.trim()
            } else {
                se.trim()
            }
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
    // Same npm ENOTEMPTY self-heal as the WSL paths (accounts::NPM_CLEAN_STALE_SNIPPET):
    // an interrupted global install leaves a hidden `.<pkg>-<rand>` staging dir that
    // makes every later `npm install -g` fail permanently. Clear it first — Linux hits
    // this exactly like WSL does. DPKG_REPAIR_SNIPPET covers the apt twin: an
    // interrupted dpkg makes the `apt-get install` below refuse with exit 100.
    let script = format!(
        "set -e; {repair} {inst}; export UV_INSTALL_DIR=/usr/local/bin; \
         (curl -LsSf https://astral.sh/uv/install.sh | sh) || true; \
         {clean} \
         npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli || true; \
         echo PROVISION_DONE",
        clean = crate::accounts::NPM_CLEAN_STALE_SNIPPET,
        repair = crate::accounts::DPKG_REPAIR_SNIPPET,
    );
    if which("pkexec") {
        run_capture("pkexec", &["bash", "-lc", &script])
    } else {
        Err(format!(
            "Root required and pkexec not found. Run in a terminal:\n  sudo bash -lc '{script}'"
        ))
    }
}

// ---- Linux: unprivileged user namespaces ----------------------------------
//
// Ubuntu 24.04 turned on `kernel.apparmor_restrict_unprivileged_userns=1`,
// which denies unprivileged user namespaces to any binary without an AppArmor
// profile granting `userns`. bubblewrap ships without one, so a non-setuid
// `bwrap` dies with `setting up uid map: Permission denied` on every run while
// `bwrap --version` still succeeds. The remedy is the same 4-line profile
// Ubuntu already ships for ch-run, crun, chrome and a dozen others.
//
// This is installed ONCE PER MACHINE, not per project and not per agent: the
// profile attaches to the binary path /usr/bin/bwrap, so it covers every user,
// every project, every worktree and every agent on that host, and it persists
// across reboots (apparmor.service loads /etc/apparmor.d at boot).

/// The profile path — attaches to the bwrap BINARY, hence machine-wide.
#[cfg(target_os = "linux")]
const BWRAP_APPARMOR_PATH: &str = "/etc/apparmor.d/bwrap";

#[cfg(target_os = "linux")]
const BWRAP_APPARMOR_PROFILE: &str = "abi <abi/4.0>,\n\
include <tunables/global>\n\
\n\
profile bwrap /usr/bin/bwrap flags=(unconfined) {\n\
\x20 userns,\n\
\x20 include if exists <local/bwrap>\n\
}\n";

#[cfg(target_os = "linux")]
const BWRAP_USERNS_HELP: &str = "bubblewrap is installed but this kernel blocks \
unprivileged user namespaces (apparmor_restrict_unprivileged_userns), so it \
cannot create a sandbox. Use Harden to install the one-time AppArmor profile \
at /etc/apparmor.d/bwrap (needs your password once, machine-wide).";

/// Install the machine-wide AppArmor profile that lets bwrap use user
/// namespaces, then reload it. Needs root exactly once; idempotent.
#[cfg(target_os = "linux")]
fn linux_install_userns_profile() -> Result<String, String> {
    // Written via a quoted heredoc so the profile lands byte-for-byte.
    let script = format!(
        "set -e; cat > {path} <<'OWLLM_AA_EOF'\n{profile}OWLLM_AA_EOF\n\
         chmod 0644 {path}; \
         (apparmor_parser -r {path} || systemctl reload apparmor || true); \
         echo AA_PROFILE_DONE",
        path = BWRAP_APPARMOR_PATH,
        profile = BWRAP_APPARMOR_PROFILE,
    );
    if which("pkexec") {
        run_capture("pkexec", &["bash", "-lc", &script])
    } else {
        Err(format!(
            "Root required and pkexec not found. Run this ONCE in a terminal, \
             then retry Harden:\n  sudo bash -lc '{script}'"
        ))
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
pub(crate) fn win_to_mnt(p: &str) -> Result<String, String> {
    let p = p.replace('\\', "/");
    let b = p.as_bytes();
    if b.len() >= 2 && b[1] == b':' {
        Ok(format!(
            "/mnt/{}{}",
            (b[0] as char).to_ascii_lowercase(),
            &p[2..]
        ))
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
    /// codex | claude | gemini | kimi | keys | ssh
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
    const PROVIDERS: [&str; 6] = ["codex", "claude", "gemini", "kimi", "keys", "ssh"];
    PROVIDERS
        .iter()
        .map(|p| {
            let on_host = found_on_host.iter().any(|s| s == p);
            let in_sandbox = synced.iter().any(|s| s == p);
            let what = match *p {
                "keys" => "API keys",
                "ssh" => "SSH keys",
                _ => "login",
            };
            let detail = match (on_host, in_sandbox) {
                (true, true) => "mirrored into the sandbox".to_string(),
                (true, false) => format!(
                    "{what} found on Windows but did NOT land in the sandbox — check the WSL distro (Set up WSL on Home), then Sync logins again"
                ),
                (false, true) => "present in the sandbox (no Windows copy — synced earlier or logged in inside the distro)".to_string(),
                // SSH keys are not a "login" you can perform elsewhere, so the
                // generic wording would be misleading here.
                (false, false) if *p == "ssh" => {
                    "no SSH keys in the Windows ~/.ssh — nothing to mirror".to_string()
                }
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
        .ok_or_else(|| {
            "no Ubuntu/Linux distro in WSL — isolation needs Ubuntu (set it up on the Home page)."
                .to_string()
        })?;
    let home = std::env::var("USERPROFILE").map_err(|_| "no USERPROFILE".to_string())?;

    // Build the API-key env file: every saved provider key becomes an
    // `export` so any CLI/agent in the distro can reach it (covers key-authed
    // CLIs + the OpenAI-compatible providers that have no OAuth login file).
    let secrets = crate::accounts::all_secrets();
    let mut env_lines = String::new();
    for k in [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "MOONSHOT_API_KEY",
        "DEEPSEEK_API_KEY",
        "XAI_API_KEY",
        "GROQ_API_KEY",
        "PERPLEXITY_API_KEY",
        "MISTRAL_API_KEY",
        "TOGETHER_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "HF_TOKEN",
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
         mkdir -p ~/.codex ~/.claude ~/.gemini ~/.kimi ~/.owllm ~/.ssh; \
         chmod 700 ~/.ssh 2>/dev/null; \
         found=''; \
         [ -f \"$WH/.codex/auth.json\" ] && found=\"$found codex\"; \
         [ -f \"$WH/.claude/.credentials.json\" ] && found=\"$found claude\"; \
         {{ [ -s \"$WH/.gemini/oauth_creds.json\" ] || [ -s \"$WH/.gemini/credentials.json\" ]; }} && found=\"$found gemini\"; \
         {{ [ -f \"$WH/.kimi/credentials/kimi-code.json\" ] || [ -f \"$WH/.kimi/config.toml\" ]; }} && found=\"$found kimi\"; \
         ls \"$WH\"/.ssh/id_* >/dev/null 2>&1 && found=\"$found ssh\"; \
         cp -f \"$WH/.codex/auth.json\" ~/.codex/ 2>/dev/null; cp -f \"$WH/.codex/config.toml\" ~/.codex/ 2>/dev/null; \
         cp -f \"$WH/.claude/.credentials.json\" ~/.claude/.credentials.json 2>/dev/null; cp -f \"$WH/.claude.json\" ~/.claude.json 2>/dev/null; \
         cp -rf \"$WH/.gemini/.\" ~/.gemini/ 2>/dev/null; \
         cp -rf \"$WH/.kimi/.\" ~/.kimi/ 2>/dev/null; \
         for k in \"$WH\"/.ssh/id_*; do [ -f \"$k\" ] && cp -f \"$k\" ~/.ssh/ 2>/dev/null; done; \
         [ -f \"$WH/.ssh/config\" ] && sed 's/\\r$//' \"$WH/.ssh/config\" > ~/.ssh/config 2>/dev/null; \
         cat \"$WH/.ssh/known_hosts\" ~/.ssh/known_hosts 2>/dev/null | tr -d '\\r' | sort -u > ~/.ssh/known_hosts.merged 2>/dev/null && mv ~/.ssh/known_hosts.merged ~/.ssh/known_hosts 2>/dev/null; \
         chmod 600 ~/.ssh/config ~/.ssh/known_hosts 2>/dev/null; chmod 600 ~/.ssh/id_* 2>/dev/null; chmod 644 ~/.ssh/*.pub 2>/dev/null; \
         printf '%s' {env_quoted} > ~/.owllm/agent_env.sh; chmod 600 ~/.owllm/agent_env.sh 2>/dev/null; \
         chmod 600 ~/.codex/auth.json ~/.claude/.credentials.json ~/.kimi/config.toml ~/.kimi/credentials/kimi-code.json 2>/dev/null; \
         syn=''; \
         [ -f ~/.codex/auth.json ] && syn=\"$syn codex\"; \
         [ -f ~/.claude/.credentials.json ] && syn=\"$syn claude\"; \
         {{ [ -s ~/.gemini/oauth_creds.json ] || [ -s ~/.gemini/credentials.json ]; }} && syn=\"$syn gemini\"; \
         {{ [ -f ~/.kimi/credentials/kimi-code.json ] || [ -f ~/.kimi/config.toml ]; }} && syn=\"$syn kimi\"; \
         [ -s ~/.owllm/agent_env.sh ] && syn=\"$syn keys\"; \
         ls ~/.ssh/id_* >/dev/null 2>&1 && syn=\"$syn ssh\"; \
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
    Ok(SyncResult {
        synced,
        found_on_host,
        report,
    })
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
        { [ -s ~/.gemini/oauth_creds.json ] || [ -s ~/.gemini/credentials.json ]; } && s=\"$s gemini\"; \
        { [ -f ~/.kimi/credentials/kimi-code.json ] || [ -f ~/.kimi/config.toml ]; } && s=\"$s kimi\"; \
        [ -s ~/.owllm/agent_env.sh ] && s=\"$s keys\"; \
        echo \"LOGINS:$s\"";
    crate::wsl::run_in_distro(&distro, script)
        .ok()
        .and_then(|o| {
            o.lines()
                .find_map(|l| l.strip_prefix("LOGINS:"))
                .map(|s| s.to_string())
        })
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
        let name = linux
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("project")
            .to_string();
        let home = std::env::var("USERPROFILE").map_err(|_| "no USERPROFILE".to_string())?;
        let dest_win = format!("{home}\\OwLLM-Projects\\{name}");
        let dest_mnt = win_to_mnt(&dest_win)?;
        let script = format!(
            "mkdir -p {dst} && cp -rf {src}/. {dst}/ && echo OWLLM_COPIED=1",
            src = q(linux.trim_end_matches('/')),
            dst = q(&dest_mnt)
        );
        let out = crate::wsl::run_in_distro(&d, &script)?;
        assert_copied(&out)?;
        Ok(SandboxProject {
            name,
            path: dest_win.clone(),
            inner_path: dest_win,
            kind: "none".into(),
        })
    } else {
        // host → isolated
        let base = current
            .trim_end_matches(['\\', '/'])
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or("project");
        // create_impl on Windows delegates to wsl_create_project, which both
        // sanitizes the name and resolves a REAL Linux distro. Run the copy in
        // the distro the project was actually created in (parsed back from its
        // UNC path) — resolving the raw default here used to copy in a
        // DIFFERENT distro (docker-desktop) than the one holding the project.
        let p = create_impl(base.to_string())?;
        let (distro, _) = crate::wsl::parse_wsl_unc(&p.path)
            .ok_or_else(|| format!("created project has a non-WSL path: {}", p.path))?;
        let src_mnt = win_to_mnt(&current)?;
        let script = format!(
            "cp -rf {src}/. {dst}/ && echo OWLLM_COPIED=1",
            src = q(src_mnt.trim_end_matches('/')),
            dst = q(&p.inner_path)
        );
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

/// Blocking mirror of host logins into the sandbox, for callers that are ALREADY
/// on a blocking thread (spawn_blocking) and must not build a nested runtime.
///
/// This exists because `sandbox_sync_logins` is `async`: calling it from a
/// blocking closure as `let _ = sandbox_sync_logins(None);` compiles cleanly
/// (`let _` suppresses the `#[must_use]` future warning) but only CONSTRUCTS a
/// future and drops it — the credential re-mirror never runs. That silent no-op
/// is what made the agentic-team 401 recur after it was "fixed". Blocking
/// callers must use THIS function; the gate enforces it.
pub(crate) fn sandbox_sync_logins_blocking(distro: Option<String>) -> Result<SyncResult, String> {
    sync_logins_impl(distro)
}

/// Mirror host logins into the sandbox. Returns what synced AND what was
/// found on the Windows host, so the UI can explain the outcome precisely.
#[tauri::command]
pub async fn sandbox_sync_logins(distro: Option<String>) -> Result<SyncResult, String> {
    // Starting a cold WSL distro can take tens of seconds. This command is
    // called from Accounts and must never occupy Tauri's UI/event loop while
    // WSL starts or copies credentials.
    tokio::task::spawn_blocking(move || sync_logins_impl(distro))
        .await
        .map_err(|e| format!("sandbox login sync task failed: {e}"))?
}

/// Result of the pre-flight reachability check. The UI uses `reachable` to decide
/// whether to proceed, `host_fallback` to degrade gracefully from a broken WSL
/// isolation path back to the real Windows folder, and `reason` to explain a
/// failure instead of the generic "WSL is still starting up" message.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WarmCheckResult {
    pub reachable: bool,
    /// When a WSL UNC path is not reachable but the corresponding host folder
    /// exists, this contains that host path so the UI can run un-isolated rather
    /// than failing completely.
    pub host_fallback: Option<String>,
    /// Human-readable explanation when `reachable` is false.
    pub reason: Option<String>,
}

/// Off Windows there is no WSL UNC form, so there is never a host twin to fall
/// back to. Defined so the callers below need no `cfg` fork.
#[cfg(not(windows))]
fn wsl_unc_to_host_path(_unc: &str) -> Option<String> {
    None
}

#[cfg(windows)]
fn wsl_unc_to_host_path(unc: &str) -> Option<String> {
    let norm = unc.replace('\\', "/");
    let rest = norm
        .strip_prefix("//wsl.localhost/")
        .or_else(|| norm.strip_prefix("//wsl$/"))?;
    let mut parts = rest.splitn(3, '/');
    let _distro = parts.next()?;
    let mnt = parts.next()?;
    let tail = parts.next()?;
    if mnt != "mnt" {
        return None;
    }
    let mut drive_tail = tail.splitn(2, '/');
    let drive = drive_tail.next()?;
    let path_tail = drive_tail.next().unwrap_or("");
    Some(format!("{}:\\{}", drive.to_uppercase(), path_tail.replace('/', "\\")))
}

/// Pre-flight for an isolated run: make sure WSL is warm and the project folder is
/// actually reachable BEFORE dispatching. After a PC reboot WSL comes back COLD —
/// the distro isn't started and /mnt isn't mounted yet — so a project reached
/// through WSL (`\\wsl.localhost\<distro>\mnt\c\...`) is temporarily unreachable.
/// Without this guard the run silently falls into an empty scratch dir and agents
/// report "can't find the code" (the post-reboot regression). For a WSL path this
/// STARTS the distro (which mounts /mnt) and tests the folder — both warming AND
/// verifying in one round-trip. For a plain host path it just stats it. Returns
/// a `WarmCheckResult` so the UI can fall back to the host folder or surface a
/// precise reason.
#[tauri::command]
pub async fn sandbox_warm_and_check(cwd: Option<String>) -> Result<WarmCheckResult, String> {
    let Some(cwd) = cwd.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) else {
        return Ok(WarmCheckResult {
            reachable: false,
            host_fallback: None,
            reason: Some("No project folder is set.".into()),
        });
    };
    // Kept for the timeout arm below: a WEDGED WSL must degrade to the host
    // folder exactly like a failed one, otherwise a stuck distro is the one
    // remaining way for isolation to block a run outright.
    let cwd_for_timeout = cwd.clone();
    let fut = tokio::task::spawn_blocking(move || -> WarmCheckResult {
        #[cfg(windows)]
        {
            if let Some((distro, linux_cwd)) = crate::wsl::parse_wsl_unc(&cwd) {
                // `.wslconfig` is read at VM creation, and this pre-flight is the
                // moment a cold distro gets started — so ensure memory give-back
                // is configured NOW, or an agent-heavy day leaves vmmem holding
                // gigabytes of dead page cache until a manual `wsl --shutdown`.
                // Best-effort: a config-write failure must never block a run.
                if let Err(e) = ensure_reclaim_config() {
                    eprintln!("wslconfig autoMemoryReclaim not ensured: {e}");
                }
                // Running ANY command starts the distro + mounts /mnt; `test -d`
                // then verifies the project folder is present. This both warms and
                // checks in a single trip (run_in_distro_script is mangle-proof).
                let script = format!(
                    "test -d {} && echo OWLLM_REACH_OK || echo OWLLM_REACH_NO",
                    crate::wsl::sh_quote(&linux_cwd)
                );
                return match crate::wsl::run_in_distro_script(&distro, &script) {
                    Ok(o) if o.contains("OWLLM_REACH_OK") => WarmCheckResult {
                        reachable: true,
                        host_fallback: None,
                        reason: None,
                    },
                    Ok(_) => {
                        let host_fallback = wsl_unc_to_host_path(&cwd)
                            .filter(|p| std::path::Path::new(p).is_dir());
                        WarmCheckResult {
                            reachable: false,
                            host_fallback,
                            reason: Some(format!(
                                "Folder not reachable through WSL distro '{}'.",
                                distro
                            )),
                        }
                    }
                    Err(e) => {
                        let host_fallback = wsl_unc_to_host_path(&cwd)
                            .filter(|p| std::path::Path::new(p).is_dir());
                        WarmCheckResult {
                            reachable: false,
                            host_fallback,
                            reason: Some(format!("WSL command failed: {e}")),
                        }
                    }
                };
            }
        }
        // Plain host path (or non-Windows): stat it directly.
        let reachable = std::path::Path::new(&cwd).is_dir();
        WarmCheckResult {
            reachable,
            host_fallback: None,
            reason: if reachable {
                None
            } else {
                Some(format!("Project folder not found: {cwd}"))
            },
        }
    });
    // BOUND IT: starting a cold distro can take a bit, but a stuck WSL must never
    // hang the pre-flight forever. 45 s is generous for a cold-start; past that we
    // report not-reachable so the run surfaces a clear message instead of blocking.
    match tokio::time::timeout(std::time::Duration::from_secs(45), fut).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(_)) | Err(_) => Ok(WarmCheckResult {
            reachable: false,
            host_fallback: wsl_unc_to_host_path(&cwd_for_timeout)
                .filter(|p| std::path::Path::new(p).is_dir()),
            reason: Some("WSL warm/check timed out — the distro may be starting.".into()),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn wsl_unc_to_host_path_round_trips_windows_paths() {
        assert_eq!(
            wsl_unc_to_host_path(r"\\wsl.localhost\Ubuntu\mnt\c\Users\me\proj"),
            Some(r"C:\Users\me\proj".to_string()),
        );
        assert_eq!(
            wsl_unc_to_host_path(r"\\wsl$\Ubuntu\mnt\d\code\repo"),
            Some(r"D:\code\repo".to_string()),
        );
        assert_eq!(
            wsl_unc_to_host_path(r"\\wsl.localhost\Ubuntu\mnt\c"),
            Some(r"C:\".to_string()),
        );
        // Non-mnt paths and plain Windows paths return None.
        assert_eq!(wsl_unc_to_host_path(r"\\wsl.localhost\Ubuntu\home\me\proj"), None);
        assert_eq!(wsl_unc_to_host_path(r"C:\Users\me\proj"), None);
    }

    #[test]
    fn mirror_report_covers_every_state() {
        let found = vec![
            "codex".to_string(),
            "claude".to_string(),
            "keys".to_string(),
        ];
        let synced = vec![
            "claude".to_string(),
            "gemini".to_string(),
            "keys".to_string(),
        ];
        let r = build_mirror_report(&found, &synced);
        assert_eq!(r.len(), 6, "one row per provider");
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
        assert!(
            get("kimi").detail.contains("log in"),
            "{}",
            get("kimi").detail
        );
        // SSH keys are not a login — the "log in there first" wording would be
        // nonsense, so that row gets its own message.
        let ssh = get("ssh");
        assert!(!ssh.on_host && !ssh.in_sandbox);
        assert!(!ssh.detail.contains("log in"), "{}", ssh.detail);
        assert!(ssh.detail.contains("nothing to mirror"), "{}", ssh.detail);
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
            eprintln!(
                "{:>7}: host={} sandbox={} — {}",
                m.provider, m.on_host, m.in_sandbox, m.detail
            );
        }
        assert_eq!(r.report.len(), 5);
        for m in &r.report {
            assert_eq!(
                m.on_host,
                r.found_on_host.contains(&m.provider),
                "{} host flag",
                m.provider
            );
            assert_eq!(
                m.in_sandbox,
                r.synced.contains(&m.provider),
                "{} sandbox flag",
                m.provider
            );
        }
    }

    // Pure path logic — runs on every platform (NOT gated to Windows) so CI on
    // Linux exercises the redirector→drive conversion.
    #[test]
    fn wsl_unc_to_drive_maps_mnt_paths() {
        use std::path::PathBuf;
        let f = wsl_unc_to_win_drive;
        assert_eq!(
            f(std::path::Path::new(
                r"\\wsl.localhost\Ubuntu\mnt\c\1_Git\LocaLLM"
            )),
            Some(PathBuf::from(r"C:\1_Git\LocaLLM"))
        );
        assert_eq!(
            f(std::path::Path::new(r"\\wsl$\Ubuntu\mnt\d\x")),
            Some(PathBuf::from(r"D:\x"))
        );
        assert_eq!(
            f(std::path::Path::new(
                r"\\?\UNC\wsl.localhost\Ubuntu\mnt\c\1_Git\LocaLLM"
            )),
            Some(PathBuf::from(r"C:\1_Git\LocaLLM"))
        );
        // Prefixes are case-insensitive.
        assert_eq!(
            f(std::path::Path::new(r"\\WSL.LOCALHOST\Ubuntu\mnt\e\Proj")),
            Some(PathBuf::from(r"E:\Proj"))
        );
        // A WSL path that is NOT a /mnt/<drive>/ mount has no Windows drive.
        assert_eq!(
            f(std::path::Path::new(r"\\wsl.localhost\Ubuntu\home\user")),
            None
        );
        // /mnt/<non-drive> (a real mount, but not a drive letter) → None.
        assert_eq!(
            f(std::path::Path::new(r"\\wsl.localhost\Ubuntu\mnt\wsl\x")),
            None
        );
        // An ordinary Windows path is not a redirector path → None.
        assert_eq!(f(std::path::Path::new(r"C:\Users\mc\proj")), None);
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
        let out = std::process::Command::new(&exe)
            .args(&argv)
            .output()
            .expect("spawn wsl.exe");
        let so = String::from_utf8_lossy(&out.stdout);
        eprintln!(
            "--- real bwrap transport probe ---\n{so}\n--- stderr ---\n{}",
            String::from_utf8_lossy(&out.stderr)
        );

        assert!(
            so.contains(&format!("PWD={mnt}")),
            "must chdir INTO the project, got: {so}"
        );
        assert!(
            so.contains("CDRIVE=HIDDEN"),
            "the rest of C: must be hidden, got: {so}"
        );
        assert!(
            so.contains("LS=seed.txt,"),
            "only the project's files are visible, got: {so}"
        );
        assert!(so.contains("WROTE"), "agent could write, got: {so}");
        assert!(
            win_dir.join("out.txt").exists(),
            "the write must land in the REAL Windows folder"
        );
        assert_eq!(
            std::fs::read_to_string(win_dir.join("out.txt"))
                .unwrap()
                .trim(),
            "wrote-from-agent"
        );
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
        assert!(
            !script.contains('\''),
            "script must be quote-free: {script}"
        );
        assert!(!script.contains('"'), "script must be quote-free: {script}");
        assert!(script.starts_with("exec $HOME/.owllm/run-sandboxed.sh "));
        // the command is recoverable by decoding the last token
        let b64cmd = base64::engine::general_purpose::STANDARD.encode(nasty.as_bytes());
        assert!(
            script.ends_with(&b64cmd),
            "command must be the final base64 token"
        );
        let decoded = String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(b64cmd.as_bytes())
                .unwrap(),
        )
        .unwrap();
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

    // ---- WSL memory cap + OOM forensics ------------------------------------
    // The captured kernel verdict that made "claude CLI exited 1 — no stdout or
    // stderr" explicable. Kept VERBATIM so the parser is tested against reality,
    // not against a shape I invented.
    const REAL_OOM_LOG: &str = "\
2026-08-10T11:54:37.041233+09:00 owllm kernel: systemd invoked oom-killer: gfp_mask=0x1100cca, order=0, global_oom
2026-08-10T11:54:37.041301+09:00 owllm kernel: oom-kill:constraint=CONSTRAINT_NONE,task=claude.exe,pid=26855,uid=1000
2026-08-10T11:54:37.041400+09:00 owllm kernel: Out of memory: Killed process 26855 (claude.exe) total-vm:17026816kB, anon-rss:12863744kB, file-rss:0kB, shmem-rss:0kB, UID:1000 pgtables:29184kB oom_score_adj:0
";

    #[test]
    fn oom_parser_reads_the_real_kernel_verdict() {
        let text = format!("MemTotal:       16385236 kB\n{REAL_OOM_LOG}");
        let hit = parse_oom_report(&text, "2026-08-10T11:44:37").expect("recent OOM is reported");
        assert_eq!(hit.task, "claude.exe");
        // 12863744 kB ≈ 12.3 GB resident, inside a ~15.6 GB VM.
        assert!(
            (hit.used_gb - 12.27).abs() < 0.1,
            "used_gb was {}",
            hit.used_gb
        );
        assert!(hit.limit_gb.is_some_and(|g| (g - 15.63).abs() < 0.1));
        // The sentence must name the cause AND the one action.
        let msg = oom_message("claude", &hit);
        assert!(msg.contains("out-of-memory"), "{msg}");
        assert!(msg.contains("claude.exe"), "{msg}");
        assert!(msg.contains("Raise the WSL memory limit"), "{msg}");
    }

    #[test]
    fn oom_parser_never_blames_a_stale_kill() {
        // Same log, but the failure we are explaining happened days later.
        // An old OOM must NOT be reported as today's cause.
        assert!(parse_oom_report(REAL_OOM_LOG, "2026-08-14T00:00:00").is_none());
        // …and a line with no timestamp is equally untrustworthy.
        let undated = "kernel: Out of memory: Killed process 1 (claude.exe) anon-rss:100kB";
        assert!(parse_oom_report(undated, "2026-08-10T11:44:37").is_none());
        // No OOM at all → nothing to report.
        assert!(parse_oom_report("MemTotal: 16385236 kB\n", "2026-01-01T00:00:00").is_none());
    }

    #[test]
    fn wsl_memory_recommendation_beats_the_50pct_default() {
        // A 32 GB host: WSL's default cap is 16 GB — exactly what got killed.
        let (mem, swap) = recommended_wsl_memory_gb(32);
        assert_eq!((mem, swap), (24, 12));
        assert!(mem > 16, "must exceed WSL's 50% default");
        // Floors/ceilings keep tiny and huge hosts sane.
        assert_eq!(recommended_wsl_memory_gb(4), (4, 2));
        assert_eq!(recommended_wsl_memory_gb(256), (64, 16));
    }

    #[test]
    fn memory_merge_adds_section_and_is_idempotent() {
        let out = merge_memory_into_wslconfig("", 24, 12).unwrap();
        assert!(out.contains("[wsl2]"), "{out}");
        assert!(out.contains("memory=24GB"), "{out}");
        assert!(out.contains("swap=12GB"), "{out}");
        assert!(merge_memory_into_wslconfig(&out, 24, 12).is_none(), "{out}");
    }

    #[test]
    fn memory_merge_never_lowers_a_users_own_higher_limit() {
        let existing = "[wsl2]\nmemory=48GB\nswap=32GB\nprocessors=8\n";
        assert!(merge_memory_into_wslconfig(existing, 24, 12).is_none());
        // A LOWER existing value is raised, and siblings survive.
        let out = merge_memory_into_wslconfig("[wsl2]\nmemory=8GB\nprocessors=8\n", 24, 12).unwrap();
        assert!(out.contains("memory=24GB"), "{out}");
        assert!(out.contains("swap=12GB"), "{out}");
        assert!(out.contains("processors=8"), "{out}");
        assert_eq!(out.matches("[wsl2]").count(), 1, "{out}");
    }

    #[test]
    fn memory_merge_coexists_with_the_sparse_setting() {
        // Both writers touch the same file; neither may clobber the other.
        let sparse = merge_sparse_into_wslconfig("").unwrap();
        let both = merge_memory_into_wslconfig(&sparse, 24, 12).unwrap();
        assert!(both.contains("sparseVhd=true"), "{both}");
        assert!(both.contains("memory=24GB"), "{both}");
        assert!(merge_sparse_into_wslconfig(&both).is_none(), "{both}");
    }

    #[test]
    fn wslconfig_key_gb_reads_the_documented_unit_suffixes() {
        assert_eq!(wslconfig_key_gb("[wsl2]\nmemory=24GB\n", "memory"), Some(24));
        assert_eq!(
            wslconfig_key_gb("[wsl2]\nmemory=16384MB\n", "memory"),
            Some(16)
        );
        assert_eq!(wslconfig_key_gb("[wsl2]\nmemory = 12 \n", "memory"), Some(12));
        assert_eq!(wslconfig_key_gb("[wsl2]\nswap=0\n", "swap"), Some(0));
        assert_eq!(wslconfig_key_gb("[wsl2]\nprocessors=8\n", "memory"), None);
    }

    #[test]
    fn sparse_merge_adds_section_to_empty_or_missing() {
        // Missing/empty file → a fresh [experimental] section.
        let out = merge_sparse_into_wslconfig("").unwrap();
        assert!(out.contains("[experimental]"));
        assert!(out.contains("sparseVhd=true"));
        // Idempotent: feeding the result back is a no-op.
        assert!(merge_sparse_into_wslconfig(&out).is_none());
    }

    #[test]
    fn sparse_merge_preserves_existing_settings() {
        let existing = "[wsl2]\nmemory=8GB\nprocessors=4\n";
        let out = merge_sparse_into_wslconfig(existing).unwrap();
        // Every prior setting survives …
        assert!(out.contains("memory=8GB"));
        assert!(out.contains("processors=4"));
        assert!(out.contains("[wsl2]"));
        // … and sparse is added under a new [experimental] section.
        assert!(out.contains("[experimental]"));
        assert!(out.contains("sparseVhd=true"));
    }

    #[test]
    fn sparse_merge_uses_existing_experimental_section() {
        let existing = "[experimental]\nautoMemoryReclaim=gradual\n";
        let out = merge_sparse_into_wslconfig(existing).unwrap();
        assert!(
            out.contains("autoMemoryReclaim=gradual"),
            "kept sibling key"
        );
        assert!(out.contains("sparseVhd=true"));
        // Only ONE [experimental] header — we didn't append a duplicate section.
        assert_eq!(out.matches("[experimental]").count(), 1, "{out}");
    }

    #[test]
    fn sparse_merge_flips_false_to_true_and_is_idempotent() {
        let out = merge_sparse_into_wslconfig("[experimental]\nsparseVhd=false\n").unwrap();
        assert!(out.contains("sparseVhd=true"));
        assert!(!out.contains("sparseVhd=false"));
        // Already-true in any casing/spacing → no rewrite.
        assert!(merge_sparse_into_wslconfig("[experimental]\nsparseVhd = TRUE\n").is_none());
        assert!(merge_sparse_into_wslconfig("[experimental]\nsparseVhd=true\n").is_none());
    }

    #[test]
    fn reclaim_merge_adds_section_and_is_idempotent() {
        // Missing/empty file → a fresh [experimental] section with give-back on.
        let out = merge_reclaim_into_wslconfig("").unwrap();
        assert!(out.contains("[experimental]"));
        assert!(out.contains("autoMemoryReclaim=gradual"));
        // Idempotent: feeding the result back is a no-op.
        assert!(merge_reclaim_into_wslconfig(&out).is_none());
    }

    #[test]
    fn reclaim_merge_never_overrides_a_users_own_choice() {
        // ANY existing value — including a deliberate opt-out — is respected.
        assert!(merge_reclaim_into_wslconfig("[experimental]\nautoMemoryReclaim=dropcache\n")
            .is_none());
        assert!(merge_reclaim_into_wslconfig("[experimental]\nautoMemoryReclaim=disabled\n")
            .is_none());
        assert!(merge_reclaim_into_wslconfig("[experimental]\nAutoMemoryReclaim = Gradual\n")
            .is_none());
    }

    #[test]
    fn reclaim_merge_coexists_with_sparse_and_memory_settings() {
        // All three writers touch the same file; none may clobber another.
        let sparse = merge_sparse_into_wslconfig("").unwrap();
        let mem = merge_memory_into_wslconfig(&sparse, 24, 12).unwrap();
        let all = merge_reclaim_into_wslconfig(&mem).unwrap();
        assert!(all.contains("sparseVhd=true"), "{all}");
        assert!(all.contains("memory=24GB"), "{all}");
        assert!(all.contains("autoMemoryReclaim=gradual"), "{all}");
        // Reclaim joined the EXISTING [experimental] section, no duplicate header.
        assert_eq!(all.matches("[experimental]").count(), 1, "{all}");
        assert!(merge_sparse_into_wslconfig(&all).is_none(), "{all}");
        assert!(merge_reclaim_into_wslconfig(&all).is_none(), "{all}");
    }

    #[test]
    fn reclaim_merge_preserves_existing_settings() {
        let existing = "[wsl2]\nmemory=8GB\nprocessors=4\n";
        let out = merge_reclaim_into_wslconfig(existing).unwrap();
        assert!(out.contains("memory=8GB"));
        assert!(out.contains("processors=4"));
        assert!(out.contains("[experimental]"));
        assert!(out.contains("autoMemoryReclaim=gradual"));
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

    /// D1: a fleet worktree IS an isolation root. Before this, cutting a
    /// worktree moved the run out of `~/owllm` and silently un-sandboxed it —
    /// reproduced on real aarch64 Linux with the shipping function.
    #[test]
    fn fleet_worktree_is_an_iso_root() {
        assert!(is_under_iso_root(
            "/home/farisland/.owllm/fleet/LLM-Studio/main/code",
            "/home/farisland"
        ));
        assert!(is_under_iso_root("/home/me/.owllm/fleet", "/home/me"));
        // Trailing slash and a redundant home slash both normalise.
        assert!(is_under_iso_root("/home/me/.owllm/fleet/p/", "/home/me/"));
        // Siblings of the fleet root stay OUTSIDE — `.owllm` holds the sandbox
        // home and credentials, which must never count as a project root.
        assert!(!is_under_iso_root("/home/me/.owllm", "/home/me"));
        assert!(!is_under_iso_root("/home/me/.owllm/sbhome", "/home/me"));
        assert!(!is_under_iso_root("/home/me/.owllm/fleetx", "/home/me"));
        // A DIFFERENT user's fleet is not ours.
        assert!(!is_under_iso_root("/home/you/.owllm/fleet/p", "/home/me"));
    }

    /// FLEET_SUBDIR must track fleet::fleet_root(), which builds
    /// `$HOME/.owllm/fleet` from two joined components.
    #[test]
    fn fleet_subdir_matches_fleet_root_layout() {
        assert_eq!(FLEET_SUBDIR, ".owllm/fleet");
    }

    #[test]
    fn bwrap_prefix_binds_project_and_home_not_real_home() {
        let a = bwrap_prefix_argv("/home/me/owllm/p", "/home/me/.owllm/sbhome", true, &[]);
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
        let a = bwrap_prefix_argv("/p", "/sb", false, &[]);
        assert!(a.join(" ").contains("--unshare-net"));
    }

    /// The worktree gitdir is bound read-write, and BEFORE --chdir so the jail
    /// is fully assembled when it enters the project.
    #[test]
    fn bwrap_prefix_binds_extra_rw_paths() {
        let extra = vec!["/repo/.git".to_string()];
        let a = bwrap_prefix_argv("/home/me/.owllm/fleet/p/code", "/sb", true, &extra);
        let joined = a.join(" ");
        assert!(
            joined.contains("--bind-try /repo/.git /repo/.git"),
            "{joined}"
        );
        let bind_at = joined.find("--bind-try /repo/.git").unwrap();
        let chdir_at = joined.find("--chdir").unwrap();
        assert!(bind_at < chdir_at, "gitdir must be bound before --chdir");
        // Nothing extra leaks in when there is none.
        assert!(!bwrap_prefix_argv("/p", "/sb", true, &[])
            .join(" ")
            .contains("--bind-try /repo"));
    }

    /// A worktree's `.git` is a POINTER to metadata + objects living in the
    /// main repo. Binding only the worktree breaks every git call in the jail.
    #[test]
    fn worktree_gitdir_resolves_to_main_repo_git_dir() {
        // Real shapes observed on both machines during the audit.
        assert_eq!(
            worktree_git_common_dir("gitdir: /home/farisland/Documents/1_Git/LLM-Studio/.git/worktrees/code\n").as_deref(),
            Some("/home/farisland/Documents/1_Git/LLM-Studio/.git"),
        );
        assert_eq!(
            worktree_git_common_dir("gitdir: D:/1_GitHome/LLM-Studio/.git/worktrees/code7")
                .as_deref(),
            Some("D:/1_GitHome/LLM-Studio/.git"),
        );
        // Windows-style separators normalise to the forward-slash form bwrap wants.
        assert_eq!(
            worktree_git_common_dir(r"gitdir: D:\repo\.git\worktrees\w").as_deref(),
            Some("D:/repo/.git"),
        );
        // A repo whose own path contains "worktrees" must strip only the LAST one.
        assert_eq!(
            worktree_git_common_dir("gitdir: /srv/worktrees/repo/.git/worktrees/a").as_deref(),
            Some("/srv/worktrees/repo/.git"),
        );
        // A plain gitdir pointer (submodule) is passed through, not mangled.
        assert_eq!(
            worktree_git_common_dir("gitdir: /repo/.git/modules/sub").as_deref(),
            Some("/repo/.git/modules/sub"),
        );
        // Non-pointer content yields nothing to bind.
        assert_eq!(worktree_git_common_dir(""), None);
        assert_eq!(worktree_git_common_dir("ref: refs/heads/main"), None);
        assert_eq!(worktree_git_common_dir("gitdir:   "), None);
    }

    /// D2: the trust key must NOT case-fold on Linux/macOS, where `/Repo` and
    /// `/repo` are different directories — folding would grant full host access
    /// to a folder the user never approved.
    #[test]
    fn full_access_key_case_sensitivity_is_per_os() {
        let a = norm_cwd("/home/me/Repo/");
        let b = norm_cwd("/home/me/repo");
        if cfg!(windows) {
            assert_eq!(a, b, "Windows paths are case-insensitive");
        } else {
            assert_ne!(a, b, "POSIX paths are case-sensitive");
        }
        // Trailing separators normalise on every OS.
        assert_eq!(norm_cwd("/home/me/repo/"), norm_cwd("/home/me/repo"));
        assert_eq!(norm_cwd("  /home/me/repo  "), norm_cwd("/home/me/repo"));
    }

    /// The exact profile that made bwrap runnable on Thor. It must attach to
    /// the BINARY path (that is what makes it machine-wide — one install covers
    /// every user, project, worktree and agent) and grant `userns`.
    #[cfg(target_os = "linux")]
    #[test]
    fn bwrap_apparmor_profile_grants_userns_machine_wide() {
        let p = BWRAP_APPARMOR_PROFILE;
        assert!(p.contains("profile bwrap /usr/bin/bwrap"), "{p}");
        assert!(p.lines().any(|l| l.trim() == "userns,"), "{p}");
        assert!(p.contains("abi <abi/4.0>"), "{p}");
        assert!(p.trim_end().ends_with('}'), "{p}");
        // Machine-wide by construction: the path is under /etc, not a home dir.
        assert_eq!(BWRAP_APPARMOR_PATH, "/etc/apparmor.d/bwrap");
        assert!(!BWRAP_APPARMOR_PATH.contains("$HOME"));
    }

    #[test]
    fn lima_argv_shape() {
        let a = lima_argv(
            "owllm",
            "/Users/me/owllm/p",
            "claude",
            &["-p".into(), "hi".into()],
        );
        assert_eq!(
            a,
            vec![
                "shell",
                "--workdir",
                "/Users/me/owllm/p",
                "owllm",
                "claude",
                "-p",
                "hi"
            ]
        );
    }
}
