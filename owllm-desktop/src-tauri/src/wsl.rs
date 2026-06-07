// WSL/Ubuntu isolation backend.
//
// THE SAFETY MODEL: every tool that can touch the disk or run a command —
// from the Code page, the agentic teams, AND the fine-tuning chat (all of them
// expose tools) — should execute inside a Linux distro, never on Windows
// directly. A local model that decides to `rm -rf` or write outside the
// project then can't reach the Windows C: drive at all.
//
// HOW (strong isolation): an isolated project lives INSIDE the distro's
// filesystem at `~/owllm/<project>`. The Windows UI browses/edits those files
// over the `\\wsl.localhost\<distro>\...` UNC path — plain std::fs works there,
// so the file tools (read/write/list/grep/glob/create_dir) isolate for FREE:
// their target paths are UNC paths into the distro FS, off the C: drive. The
// ONLY tool that must actively cross into Linux is `shell`, because cmd.exe
// can't even `cd` into a UNC path — it runs via `wsl -d <distro> -- bash -lc`.
//
// Fallback: when WSL is unavailable (locked-down PC, virtualization off) the
// app keeps working on the Windows host with the existing write-jail +
// dangerous-command guard, and the UI shows a loud "NOT isolated" warning.
//
// All the cross-into-WSL command shapes here were validated live against a
// real Ubuntu distro before being written (the `--cd` flag is intentionally
// NOT used — it errored; `bash -lc 'cd … && (…)'` is the portable form).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WslStatus {
    /// At least one distro is installed and runnable.
    pub available: bool,
    /// Installed distro names (e.g. ["Ubuntu", "docker-desktop"]).
    pub distros: Vec<String>,
    /// The default distro (what bare `wsl` uses), if resolvable.
    pub default_distro: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WslProject {
    pub name: String,
    pub distro: String,
    /// Linux path inside the distro, e.g. /home/mc/owllm/myproj.
    pub linux_path: String,
    /// Windows UNC path the UI uses as the workspace / cwd, e.g.
    /// \\wsl.localhost\Ubuntu\home\mc\owllm\myproj.
    pub unc_path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WslIsolation {
    /// When true, new projects are created inside WSL and tool execution is
    /// isolated. The actual routing keys off whether a cwd is a WSL UNC path,
    /// so this flag drives DEFAULTS + UI, not the per-call routing decision.
    pub enabled: bool,
    /// Preferred distro for new projects. None → use the default.
    pub distro: Option<String>,
}

/// Which agent-toolchain programs are installed INSIDE the distro (real Linux
/// installs — Windows binaries leaking through /mnt/c are NOT counted).
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WslToolchain {
    pub node: bool,
    pub uv: bool,
    pub git: bool,
    pub claude: bool,
    pub codex: bool,
    pub gemini: bool,
}

// ---- pure helpers (unit-tested; used by agent_tools shell routing) --------

/// Parse a Windows path and, if it points inside a WSL distro, return
/// (distro, linux_path). Handles both `\\wsl.localhost\<d>\...` (modern) and
/// `\\wsl$\<d>\...` (legacy), with either slash direction. Returns None for
/// ordinary Windows paths (C:\…), which must NOT be routed into WSL.
pub fn parse_wsl_unc(path: &str) -> Option<(String, String)> {
    let norm = path.replace('\\', "/");
    let rest = norm
        .strip_prefix("//wsl.localhost/")
        .or_else(|| norm.strip_prefix("//wsl$/"))?;
    let mut parts = rest.splitn(2, '/');
    let distro = parts.next()?.to_string();
    if distro.is_empty() {
        return None;
    }
    let tail = parts.next().unwrap_or("");
    let linux_path = format!("/{}", tail.trim_end_matches('/'));
    Some((distro, linux_path))
}

/// Build the bash script run inside the distro: cd into the project, then run
/// the model's command in a subshell so chained/`&&`/piped commands behave.
/// The cwd is single-quoted (paths never legitimately contain a quote); the
/// command is embedded raw so the model gets normal bash semantics.
pub fn build_wsl_bash_script(linux_cwd: &str, command: &str) -> String {
    let quoted_cwd = format!("'{}'", linux_cwd.replace('\'', "'\\''"));
    format!("cd {quoted_cwd} && ({command})")
}

/// Single-quote a string for bash (`'` → `'\''`). Safe for arbitrary content
/// including newlines and quotes.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Build a `wsl.exe` Command that runs `program args...` INSIDE the distro at
/// `linux_cwd`, each arg shell-quoted for bash. This is how the subscription
/// CLIs (claude/codex/gemini/kimi) get routed into the sandbox when a project
/// lives in WSL — the CLI runs as a Linux process that can't touch Windows.
/// `exec` replaces bash so the CLI's stdin/stdout flow straight through (the
/// caller writes the prompt to stdin and parses stdout exactly as before).
/// The CLI must be installed + logged-in inside the distro (Phase-2 provision
/// installs it; the user logs in once with `wsl -d <distro> -- <cli> login`).
/// Caller still configures stdin/stdout/stderr + creation_flags.
pub fn wsl_program_command(
    distro: &str,
    linux_cwd: &str,
    program: &str,
    args: &[String],
) -> std::process::Command {
    let mut script = format!("cd {} && exec {}", sh_quote(linux_cwd), sh_quote(program));
    for a in args {
        script.push(' ');
        script.push_str(&sh_quote(a));
    }
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.arg("-d").arg(distro).arg("--").arg("bash").arg("-lc").arg(script);
    cmd
}

// ---- internal command runners --------------------------------------------

/// Run a bash script in the given distro (optionally as a specific user, e.g.
/// "root" for passwordless apt) and capture stdout+stderr. Errors on a nonzero
/// exit. Synchronous; callers are commands or run on a blocking context. Always
/// uses CREATE_NO_WINDOW so no console flashes.
fn run_wsl_user(distro: &str, user: Option<&str>, script: &str) -> Result<String, String> {
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.arg("-d").arg(distro);
    if let Some(u) = user {
        cmd.arg("-u").arg(u);
    }
    cmd.arg("--").arg("bash").arg("-lc").arg(script);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|e| format!("spawn wsl: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    if !out.status.success() {
        return Err(format!(
            "wsl exited {}: {}",
            out.status.code().unwrap_or(-1),
            if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() }
        ));
    }
    Ok(if stderr.trim().is_empty() { stdout } else { format!("{stdout}\n{stderr}") })
}

fn run_wsl_capture(distro: &str, script: &str) -> Result<String, String> {
    run_wsl_user(distro, None, script)
}

/// Public wrapper: run a bash script in the distro as the normal user and
/// capture output. Used by sibling modules (e.g. `github` credential setup)
/// that need to configure things inside the sandbox without duplicating the
/// wsl.exe plumbing. Errors on a nonzero exit.
pub fn run_in_distro(distro: &str, script: &str) -> Result<String, String> {
    run_wsl_capture(distro, script)
}

/// List installed distros. `wsl.exe -l -q` emits UTF-16LE; we strip null
/// bytes to recover the ASCII names rather than pulling in a UTF-16 decoder.
fn list_distros() -> Vec<String> {
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.arg("-l").arg("-q");
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let Ok(out) = cmd.output() else { return Vec::new() };
    let raw: Vec<u8> = out.stdout.into_iter().filter(|&b| b != 0).collect();
    String::from_utf8_lossy(&raw)
        .lines()
        .map(|l| l.trim().trim_end_matches('\r').to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// The default distro's name, read from inside it ($WSL_DISTRO_NAME) so it's
/// always correct regardless of `-l` ordering quirks.
fn default_distro_name() -> Option<String> {
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.arg("--").arg("bash").arg("-lc").arg("printf %s \"$WSL_DISTRO_NAME\"");
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if name.is_empty() { None } else { Some(name) }
}

fn isolation_path() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(home).join(".owllm").join("wsl_isolation.json"))
}

fn sanitize_project_name(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    s.trim_matches('_').to_string()
}

// ---- Tauri commands -------------------------------------------------------

#[tauri::command]
pub fn wsl_status() -> WslStatus {
    let distros = list_distros();
    let default_distro = default_distro_name().or_else(|| distros.first().cloned());
    WslStatus {
        available: !distros.is_empty(),
        distros,
        default_distro,
    }
}

#[tauri::command]
pub fn wsl_isolation_get() -> WslIsolation {
    isolation_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn wsl_isolation_set(enabled: bool, distro: Option<String>) -> Result<WslIsolation, String> {
    let cfg = WslIsolation { enabled, distro };
    let p = isolation_path().ok_or_else(|| "no home directory".to_string())?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(&p, json).map_err(|e| format!("write {}: {e}", p.display()))?;
    Ok(cfg)
}

/// Create (idempotently) an isolated project inside the distro and return both
/// its Linux path and the Windows UNC path the UI uses as the workspace.
#[tauri::command]
pub fn wsl_create_project(name: String, distro: Option<String>) -> Result<WslProject, String> {
    let distro = distro
        .or_else(|| wsl_status().default_distro)
        .ok_or_else(|| "no WSL distro available — install Ubuntu first".to_string())?;
    let safe = sanitize_project_name(&name);
    if safe.is_empty() {
        return Err("invalid project name".to_string());
    }
    // mkdir, then print the resolved Linux path and the Windows UNC path.
    let script = format!(
        "mkdir -p ~/owllm/{n} && realpath ~/owllm/{n} && wslpath -w ~/owllm/{n}",
        n = safe
    );
    let out = run_wsl_capture(&distro, &script)?;
    let mut lines = out.lines().map(str::trim).filter(|l| !l.is_empty());
    let linux_path = lines.next().ok_or_else(|| "wsl returned no path".to_string())?.to_string();
    let unc_path = lines
        .next()
        .ok_or_else(|| "wsl returned no UNC path".to_string())?
        .trim_end_matches('\\')
        .to_string();
    Ok(WslProject { name: safe, distro, linux_path, unc_path })
}

/// List existing isolated projects under ~/owllm in the distro.
#[tauri::command]
pub fn wsl_list_projects(distro: Option<String>) -> Result<Vec<WslProject>, String> {
    let distro = match distro.or_else(|| wsl_status().default_distro) {
        Some(d) => d,
        None => return Ok(Vec::new()),
    };
    let script = "shopt -s nullglob; for d in ~/owllm/*/; do n=$(basename \"$d\"); \
                  printf '%s\\t%s\\t%s\\n' \"$n\" \"$(realpath \"$d\")\" \"$(wslpath -w \"$d\")\"; done";
    let out = run_wsl_capture(&distro, script).unwrap_or_default();
    let mut v = Vec::new();
    for line in out.lines() {
        let mut it = line.split('\t');
        if let (Some(n), Some(lp), Some(up)) = (it.next(), it.next(), it.next()) {
            let n = n.trim();
            if !n.is_empty() {
                v.push(WslProject {
                    name: n.to_string(),
                    distro: distro.clone(),
                    linux_path: lp.trim().to_string(),
                    unc_path: up.trim().trim_end_matches('\\').to_string(),
                });
            }
        }
    }
    Ok(v)
}

/// Report which toolchain programs are really installed inside the distro.
/// A binary that resolves under /mnt/ is a Windows leak via PATH interop — it
/// would NOT run correctly in the distro, so it doesn't count as installed.
#[tauri::command]
pub fn wsl_toolchain_status(distro: Option<String>) -> WslToolchain {
    let Some(distro) = distro.or_else(|| wsl_status().default_distro) else {
        return WslToolchain::default();
    };
    let script = "for c in node uv git claude codex gemini; do \
                  p=$(command -v \"$c\" 2>/dev/null); \
                  if [ -n \"$p\" ] && [ \"${p#/mnt/}\" = \"$p\" ]; then echo \"$c=1\"; else echo \"$c=0\"; fi; \
                  done";
    let out = run_wsl_capture(&distro, script).unwrap_or_default();
    let mut t = WslToolchain::default();
    for line in out.lines() {
        match line.trim() {
            "node=1" => t.node = true,
            "uv=1" => t.uv = true,
            "git=1" => t.git = true,
            "claude=1" => t.claude = true,
            "codex=1" => t.codex = true,
            "gemini=1" => t.gemini = true,
            _ => {}
        }
    }
    t
}

/// Install the agent toolchain inside the distro: node/npm, git, curl, uv, and
/// the subscription CLIs (Claude/Codex/Gemini). Runs as root — WSL allows
/// `-u root` with no password, so apt needs no sudo prompt. Idempotent: apt
/// install / npm -g are safe to re-run. Long-running (downloads); run off the
/// async executor. Returns the install log. The CLIs still need a one-time
/// login INSIDE the distro (`wsl -d <distro> -- claude /login`, etc.) — paid
/// credentials can't be copied from the Windows install.
#[tauri::command]
pub async fn wsl_provision(distro: Option<String>) -> Result<String, String> {
    let distro = distro
        .or_else(|| wsl_status().default_distro)
        .ok_or_else(|| "no WSL distro available — install WSL first".to_string())?;
    // Heredoc-free script (single bash -lc arg). `|| true` on the optional
    // pieces so a CLI npm hiccup doesn't fail the whole provision.
    let script = "set -e; export DEBIAN_FRONTEND=noninteractive; \
                  apt-get update -y; \
                  apt-get install -y nodejs npm git curl ca-certificates; \
                  export UV_INSTALL_DIR=/usr/local/bin; \
                  (curl -LsSf https://astral.sh/uv/install.sh | sh) || true; \
                  npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli || true; \
                  (command -v gh >/dev/null 2>&1 || ( \
                     curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
                     chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
                     echo \"deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\" > /etc/apt/sources.list.d/github-cli.list && \
                     apt-get update -y && apt-get install -y gh )) || true; \
                  echo PROVISION_DONE";
    tokio::task::spawn_blocking(move || run_wsl_user(&distro, Some("root"), script))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

/// Install WSL itself on a PC that doesn't have it. `wsl --install` needs admin
/// elevation and a reboot, so we launch it elevated via PowerShell
/// (Start-Process -Verb RunAs → UAC prompt). Returns once launched; the actual
/// install + reboot is user-driven.
#[tauri::command]
pub fn wsl_install() -> Result<String, String> {
    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-Command",
        "Start-Process wsl -ArgumentList '--install' -Verb RunAs",
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().map_err(|e| format!("launch `wsl --install`: {e}"))?;
    Ok("Launching WSL install — accept the UAC prompt, then reboot when it finishes. Reopen OwLLM afterwards.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn parses_modern_unc() {
        let (d, p) = parse_wsl_unc("\\\\wsl.localhost\\Ubuntu\\home\\mc\\owllm\\proj").unwrap();
        assert_eq!(d, "Ubuntu");
        assert_eq!(p, "/home/mc/owllm/proj");
    }

    #[test]
    fn parses_legacy_unc_forward_slashes() {
        let (d, p) = parse_wsl_unc("//wsl$/Ubuntu/home/mc/x").unwrap();
        assert_eq!(d, "Ubuntu");
        assert_eq!(p, "/home/mc/x");
    }

    #[test]
    fn rejects_windows_path() {
        assert!(parse_wsl_unc("C:\\Users\\mc\\proj").is_none());
        assert!(parse_wsl_unc("/home/mc").is_none());
    }

    #[test]
    fn builds_script_with_cd() {
        assert_eq!(
            build_wsl_bash_script("/home/mc/owllm/p", "echo hi | tr a-z A-Z"),
            "cd '/home/mc/owllm/p' && (echo hi | tr a-z A-Z)"
        );
    }
}
