// Filesystem layout resolution — figures out where the legacy
// `LLM/` tree lives relative to the running app. Used by
// `models::list_models` (scan LLM/models for *.gguf) and `server`
// (find llama-server.exe).
//
// Lookup priority for each path is:
//   1. Explicit env-var override (OWLLM_LLM_ROOT, OWLLM_LLAMA_SERVER).
//   2. Walk up from the running exe until we find a directory
//      containing `LLM/runtime/llama.cpp/llama-server.exe`. Works for
//      both `apps/owllm-desktop/OwLLM Desktop.exe` (repo root is two
//      levels up) and the cargo dev build under `target/.../debug/`.
//   3. Walk up from `CARGO_MANIFEST_DIR` as a fallback during cargo
//      tests / cargo run from inside src-tauri/.

use std::path::PathBuf;

/// Open a URL in the user's default browser. Used by the AccessTokens
/// pane to launch huggingface.co/settings/tokens and the HF model page.
/// Refuses anything that isn't http(s) so a compromised React side
/// can't pass `file://...` and read local files.
#[tauri::command]
pub fn shell_open_url(url: String) -> Result<(), String> {
    let lower = url.to_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err("only http(s) urls allowed".into());
    }
    #[cfg(windows)]
    {
        // `cmd /c start "" "<url>"` is the canonical Windows way to
        // launch the registered handler without inheriting our window.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("spawn: {e}"))?;
    }
    #[cfg(not(windows))]
    {
        // Best-effort cross-platform fallback.
        let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        std::process::Command::new(opener)
            .arg(&url)
            .spawn()
            .map_err(|e| format!("spawn: {e}"))?;
    }
    Ok(())
}

/// Root of the legacy LLM/ tree (contains `models/`, `runtime/`,
/// etc.). Returns None when the tree cannot be located — callers
/// must degrade gracefully.
pub fn llm_root() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("OWLLM_LLM_ROOT") {
        let pb = PathBuf::from(p);
        if pb.is_dir() {
            return Some(pb);
        }
    }
    let seeds: Vec<PathBuf> = [
        std::env::current_exe().ok(),
        Some(PathBuf::from(env!("CARGO_MANIFEST_DIR"))),
    ]
    .into_iter()
    .flatten()
    .collect();
    for seed in seeds {
        for dir in seed.ancestors() {
            let candidate = dir.join("LLM");
            // Anchor on the llama-server.exe shipping under LLM/runtime/llama.cpp
            // — that's the marker that distinguishes the real legacy tree
            // from a half-init scratch dir.
            if candidate
                .join("runtime")
                .join("llama.cpp")
                .join("llama-server.exe")
                .is_file()
            {
                return Some(candidate);
            }
            // Fallback marker: a `models/` directory means the user has
            // at least a partial install — list_models will still find
            // any GGUFs there even before runtime is bootstrapped.
            if candidate.join("models").is_dir() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Path to `llama-server.exe` (the llama.cpp HTTP server binary).
/// Allows direct override via OWLLM_LLAMA_SERVER for custom builds.
pub fn llama_server_exe() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("OWLLM_LLAMA_SERVER") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    let exe = llm_root()?
        .join("runtime")
        .join("llama.cpp")
        .join("llama-server.exe");
    if exe.is_file() {
        Some(exe)
    } else {
        None
    }
}

/// Path to the bundled Python interpreter shipped under
/// `LLM/python_runtime/python3.11/python.exe`. Used as the SOURCE
/// for every per-profile venv that env_manager spawns — this way
/// users don't need a system Python install. OWLLM_PYTHON env var
/// overrides for users who want to point at their own interpreter
/// (e.g. a system Anaconda).
#[allow(dead_code)]
pub fn bundled_python_exe() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("OWLLM_PYTHON") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    let candidate = llm_root()?
        .join("python_runtime")
        .join("python3.11")
        .join("python.exe");
    if candidate.is_file() {
        Some(candidate)
    } else {
        None
    }
}

/// Path to the finetune.py training entrypoint. Lives at the legacy
/// location so we don't move user-edited scripts around during the
/// Rust port.
#[allow(dead_code)]
pub fn finetune_script() -> Option<PathBuf> {
    let p = llm_root()?.join("finetune.py");
    if p.is_file() { Some(p) } else { None }
}

/// Path to the abliterate.py CLI — the FailSpy-recipe refusal-direction
/// stripper invoked by the Train page's '🚫 Abliterate' action.
pub fn abliterate_script() -> Option<PathBuf> {
    let p = llm_root()?.join("tools").join("abliterate.py");
    if p.is_file() { Some(p) } else { None }
}
