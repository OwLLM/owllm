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

// ---- internal command runners --------------------------------------------

/// Run a bash script in the given distro and capture stdout. Errors on a
/// nonzero exit (with stderr). Synchronous; callers are commands or run on a
/// blocking context. Always uses CREATE_NO_WINDOW so no console flashes.
fn run_wsl_capture(distro: &str, script: &str) -> Result<String, String> {
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.arg("-d").arg(distro).arg("--").arg("bash").arg("-lc").arg(script);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|e| format!("spawn wsl: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "wsl exited {}: {}",
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
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
