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
