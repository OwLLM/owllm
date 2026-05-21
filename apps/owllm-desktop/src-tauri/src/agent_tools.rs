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
fn resolve(path: &str, cwd: &Option<String>) -> PathBuf {
    let p = Path::new(path);
    if p.is_absolute() {
        return p.to_path_buf();
    }
    match cwd.as_deref() {
        Some(c) if !c.is_empty() => Path::new(c).join(p),
        _ => p.to_path_buf(),
    }
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
    let p = resolve(&path, &cwd);
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
    let p = resolve(&path, &cwd);
    std::fs::create_dir_all(&p).map_err(|e| format!("mkdir {}: {e}", p.display()))
}

/// Run a shell command. On Windows we go through cmd.exe /c so models
/// can use familiar pipes/redirects without us writing a parser.
/// CREATE_NO_WINDOW keeps the popup invisible (saved memory constraint:
/// All Windows subprocesses MUST use CREATE_NO_WINDOW 0x08000000).
#[tauri::command]
pub async fn tool_shell_exec(
    command: String,
    cwd: Option<String>,
) -> Result<ShellResult, String> {
    use tokio::process::Command;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x08000000;

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
