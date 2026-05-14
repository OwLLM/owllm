// Filesystem layout resolution — figures out where the legacy
// `LLM/` tree lives relative to the running app. Used by `models`
// (find llm_backends.yaml) and `server` (find llama-server.exe).
//
// Lookup priority for each path is:
//   1. Explicit env-var override (OWLLM_LLM_ROOT, OWLLM_LLAMA_SERVER,
//      OWLLM_CONFIG_FILE, OWLLM_MODELS_DIR).
//   2. Walk up from the running exe until we find a directory
//      containing `LLM/configs/llm_backends.yaml`. Works for both
//      `apps/owllm-desktop/OwLLM Desktop.exe` (repo root is two
//      levels up) and the cargo dev build under `target/.../debug/`.
//   3. Walk up from `CARGO_MANIFEST_DIR` as a fallback during cargo
//      tests / cargo run from inside src-tauri/.

use std::path::PathBuf;

/// Root of the legacy LLM/ tree (contains `configs/`, `runtime/`,
/// `models/`, etc.). Returns None when the tree cannot be located —
/// callers must degrade gracefully (e.g. `list_models` returns an
/// empty Vec).
pub fn llm_root() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("OWLLM_LLM_ROOT") {
        let pb = PathBuf::from(p);
        if pb.is_dir() {
            return Some(pb);
        }
    }
    // Walk up from the running exe, then from CARGO_MANIFEST_DIR.
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
            if candidate.join("configs").join("llm_backends.yaml").is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Path to `LLM/configs/llm_backends.yaml`. Allows full override via
/// OWLLM_CONFIG_FILE so tests/CI can point at a fixture.
pub fn config_file() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("OWLLM_CONFIG_FILE") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    Some(llm_root()?.join("configs").join("llm_backends.yaml"))
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
