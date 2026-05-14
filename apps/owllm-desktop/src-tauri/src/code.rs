// Code page — launches an external editor against the chosen
// workspace folder. The legacy Qt page bundled a portable VSCodium
// install + Win32 HWND reparenting; that's not viable from a Tauri
// webview (no embedding API) and the user almost always already has
// VS Code / Cursor installed system-wide. This first cut just locates
// a known editor and spawns it with the workspace.
//
// Editor discovery, in priority order:
//   1. OWLLM_EXTERNAL_EDITOR env var (explicit override)
//   2. VSCodium       (codium / codium.cmd on PATH)
//   3. Cursor         (cursor / cursor.cmd on PATH)
//   4. VS Code        (code / code.cmd on PATH)
//
// Spawn uses CREATE_NO_WINDOW so we don't inherit a popup console
// on Windows.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone)]
pub struct EditorLaunch {
    pub editor: String,        // user-facing name, e.g. "VSCodium"
    pub command: String,       // executable that was actually spawned
    pub workspace: String,
    pub message: String,       // human-readable status
}

#[tauri::command]
pub async fn launch_external_editor(workspace: String) -> Result<EditorLaunch, String> {
    let ws = Path::new(&workspace);
    if !ws.is_dir() {
        return Err(format!("workspace path is not a directory: {workspace}"));
    }
    let (name, exe) = pick_editor()
        .ok_or_else(|| "No editor found — install VSCodium, Cursor, or VS Code and add it to PATH (or set OWLLM_EXTERNAL_EDITOR).".to_string())?;

    use tokio::process::Command;
    let mut cmd = Command::new(&exe);
    cmd.arg(ws);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    // Detach: we don't keep the child handle; the user closes the
    // editor themselves. spawn() returns immediately.
    cmd.spawn()
        .map_err(|e| format!("spawn {}: {e}", exe.display()))?;

    Ok(EditorLaunch {
        editor: name,
        command: exe.to_string_lossy().into_owned(),
        workspace,
        message: "Editor launched. It opens in its own window.".to_string(),
    })
}

fn pick_editor() -> Option<(String, PathBuf)> {
    if let Ok(path) = std::env::var("OWLLM_EXTERNAL_EDITOR") {
        let pb = PathBuf::from(&path);
        if pb.is_file() {
            let name = pb.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Editor")
                .to_string();
            return Some((name, pb));
        }
    }
    // Common Windows installs ship .cmd shims on PATH.
    let candidates: &[(&str, &[&str])] = &[
        ("VSCodium", &["codium", "codium.cmd"]),
        ("Cursor",   &["cursor", "cursor.cmd"]),
        ("VS Code",  &["code", "code.cmd"]),
    ];
    for (name, exes) in candidates {
        for exe_name in *exes {
            if let Some(p) = which(exe_name) {
                return Some((name.to_string(), p));
            }
        }
    }
    None
}

/// Look up `name` on PATH, mirroring `where` (Windows) / `which`
/// (POSIX) — minimal implementation since we don't want a dep.
fn which(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&paths) {
        let full = dir.join(name);
        if full.is_file() {
            return Some(full);
        }
    }
    None
}
