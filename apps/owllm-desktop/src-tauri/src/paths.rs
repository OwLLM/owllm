// Filesystem layout resolution.
//
// Two roots:
//   * resources_root()  — shippable immutable assets that travel with
//                         the app (built-in roles, teams, configs,
//                         profiles, Python scripts, finetune.py). On
//                         a dev checkout this is
//                         `<repo>/apps/owllm-desktop/resources/`; on
//                         an installed build the same folder sits
//                         next to the exe.
//   * llm_root()        — the legacy / user-state tree (`models/`,
//                         `runtime/`, `data/owllm_state.db`, `.envs/`,
//                         `fine_tuned/`). Still walks up looking for
//                         an `LLM/` folder so existing dev installs
//                         keep working.
//
// Lookup priority for each path is:
//   1. Explicit env-var override (OWLLM_RESOURCES, OWLLM_LLM_ROOT,
//      OWLLM_LLAMA_SERVER).
//   2. Walk up from the running exe / CARGO_MANIFEST_DIR until we hit
//      the marker (resources/agents/roles for resources_root;
//      LLM/runtime/llama.cpp/llama-server.exe or LLM/models for
//      llm_root).
//
// Category helpers (roles_dir, teams_dir, configs_dir, profiles_dir,
// tools_dir, finetune_script) prefer the new resources tree but fall
// back to the old `LLM/` location so a half-migrated tree still works.

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
    // Phase 3: prefer %LOCALAPPDATA%\OwLLM Desktop\runtime\llama.cpp\.
    if let Some(rt) = runtime_root() {
        let exe = rt.join("llama.cpp").join("llama-server.exe");
        if exe.is_file() { return Some(exe); }
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

/// Path to `llama-quantize.exe` — used by the GGUF export pipeline to
/// turn an f16 intermediate into K-quants (Q4_K_M etc) that the
/// convert script can't produce directly.
pub fn llama_quantize_exe() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("OWLLM_LLAMA_QUANTIZE") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    if let Some(rt) = runtime_root() {
        let exe = rt.join("llama.cpp").join("llama-quantize.exe");
        if exe.is_file() { return Some(exe); }
    }
    let exe = llm_root()?
        .join("runtime")
        .join("llama.cpp")
        .join("llama-quantize.exe");
    if exe.is_file() {
        Some(exe)
    } else {
        None
    }
}

/// Path to the bundled Python interpreter shipped under
/// `%LOCALAPPDATA%\OwLLM Desktop\runtime\python_runtime\python3.11\
/// python.exe` after the Phase-3 installer runs, falling back to the
/// legacy LLM/python_runtime/python3.11/python.exe. Used as the SOURCE
/// for every per-profile venv that env_manager spawns. OWLLM_PYTHON
/// env var overrides for users who want a system interpreter.
#[allow(dead_code)]
pub fn bundled_python_exe() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("OWLLM_PYTHON") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    if let Some(rt) = runtime_root() {
        let candidate = rt.join("python_runtime").join("python3.11").join("python.exe");
        if candidate.is_file() { return Some(candidate); }
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
    // Prefer the in-app resources copy; fall back to the legacy LLM/ root.
    if let Some(root) = resources_root() {
        let p = root.join("finetune.py");
        if p.is_file() { return Some(p); }
    }
    let p = llm_root()?.join("finetune.py");
    if p.is_file() { Some(p) } else { None }
}

/// Path to the abliterate.py CLI — the FailSpy-recipe refusal-direction
/// stripper invoked by the Train page's '🚫 Abliterate' action.
pub fn abliterate_script() -> Option<PathBuf> {
    if let Some(root) = resources_root() {
        let p = root.join("tools").join("abliterate.py");
        if p.is_file() { return Some(p); }
    }
    let p = llm_root()?.join("tools").join("abliterate.py");
    if p.is_file() { Some(p) } else { None }
}

// =====================================================================
// New: resources_root + category helpers
//
// Shippable, immutable assets that travel with the app live under
// `apps/owllm-desktop/resources/` in the repo (and `<exe-dir>/resources/`
// in an installed build). The legacy `LLM/` tree is still the home for
// user state (models, fine_tuned, .envs, data/owllm_state.db).
// =====================================================================

/// Root of the shippable resources tree. Located by:
///   1. OWLLM_RESOURCES env override
///   2. Walking up from the running exe (or CARGO_MANIFEST_DIR) looking
///      for `apps/owllm-desktop/resources/agents/roles/` (the marker
///      file we know exists post-migration).
///   3. Sibling-of-exe lookup for installed builds: `<exe dir>/resources/`.
pub fn resources_root() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("OWLLM_RESOURCES") {
        let pb = PathBuf::from(p);
        if pb.is_dir() {
            return Some(pb);
        }
    }
    // Installed-app layout: resources/ sits next to the exe.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let cand = parent.join("resources");
            if cand.join("agents").join("roles").is_dir() {
                return Some(cand);
            }
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
            let candidate = dir
                .join("apps")
                .join("owllm-desktop")
                .join("resources");
            if candidate.join("agents").join("roles").is_dir() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Built-in agent role YAMLs.
pub fn roles_dir() -> Option<PathBuf> {
    if let Some(r) = resources_root() {
        let p = r.join("agents").join("roles");
        if p.is_dir() { return Some(p); }
    }
    let p = llm_root()?.join("core").join("agents").join("roles");
    if p.is_dir() { Some(p) } else { None }
}

/// Built-in team template JSONs.
pub fn teams_dir() -> Option<PathBuf> {
    if let Some(r) = resources_root() {
        let p = r.join("agents").join("teams");
        if p.is_dir() { return Some(p); }
    }
    let p = llm_root()?.join("core").join("agents").join("teams");
    if p.is_dir() { Some(p) } else { None }
}

/// Backend / inference config YAMLs (`llm_backends.yaml`, etc.).
#[allow(dead_code)]
pub fn configs_dir() -> Option<PathBuf> {
    if let Some(r) = resources_root() {
        let p = r.join("configs");
        if p.is_dir() { return Some(p); }
    }
    let p = llm_root()?.join("configs");
    if p.is_dir() { Some(p) } else { None }
}

/// Per-GPU environment profile bundle (`env_profiles.yaml` + the
/// arch-specific JSONs).
pub fn profiles_dir() -> Option<PathBuf> {
    if let Some(r) = resources_root() {
        let p = r.join("profiles");
        if p.is_dir() { return Some(p); }
    }
    let p = llm_root()?.join("profiles");
    if p.is_dir() { Some(p) } else { None }
}

/// Python helper scripts shipped with the app (`screenshot_url.py`,
/// `abliterate.py`).
#[allow(dead_code)]
pub fn tools_dir() -> Option<PathBuf> {
    if let Some(r) = resources_root() {
        let p = r.join("tools");
        if p.is_dir() { return Some(p); }
    }
    let p = llm_root()?.join("tools");
    if p.is_dir() { Some(p) } else { None }
}

// =====================================================================
// User-data root (Phase 2)
//
// Per-user MUTABLE state — SQLite, custom agents/teams, installed
// skills, GPU selection. Lives in the OS-canonical app-data dir:
//   * Windows: %APPDATA%\OwLLM Desktop\
//   * macOS:   ~/Library/Application Support/OwLLM Desktop/
//   * Linux:   $XDG_DATA_HOME/OwLLM Desktop/ (or ~/.local/share/...)
//
// One-time migration (in lib.rs setup) copies LLM/data/* here on first
// launch, so existing users don't lose state.
//
// Every helper here returns the NEW location; callers also try the
// legacy LLM/data/ path as a read-only fallback during the migration
// window so a half-migrated install still works.
// =====================================================================

const APP_DIR_NAME: &str = "OwLLM Desktop";

/// Root of the per-user mutable state tree.
pub fn user_data_root() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("OWLLM_USER_DATA") {
        let pb = PathBuf::from(p);
        if !pb.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(&pb);
            return Some(pb);
        }
    }
    #[cfg(windows)]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let pb = PathBuf::from(appdata).join(APP_DIR_NAME);
            let _ = std::fs::create_dir_all(&pb);
            return Some(pb);
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            let pb = PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join(APP_DIR_NAME);
            let _ = std::fs::create_dir_all(&pb);
            return Some(pb);
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
            let pb = PathBuf::from(xdg).join(APP_DIR_NAME);
            let _ = std::fs::create_dir_all(&pb);
            return Some(pb);
        }
        if let Ok(home) = std::env::var("HOME") {
            let pb = PathBuf::from(home).join(".local").join("share").join(APP_DIR_NAME);
            let _ = std::fs::create_dir_all(&pb);
            return Some(pb);
        }
    }
    None
}

/// Legacy user-data root — `<llm_root>/data/`. Read-only fallback that
/// lets the app find existing user state from before the move to
/// `%APPDATA%`. The one-time migration (lib.rs setup) copies these
/// files into the new home so this fallback only matters once.
pub fn legacy_user_data_root() -> Option<PathBuf> {
    let p = llm_root()?.join("data");
    if p.is_dir() { Some(p) } else { None }
}

/// SQLite state DB (`owllm_state.db`). Tries the new user-data root
/// first, then the legacy LLM/data/ location.
pub fn state_db_path() -> Option<PathBuf> {
    if let Some(root) = user_data_root() {
        let p = root.join("owllm_state.db");
        if p.is_file() { return Some(p); }
    }
    if let Some(root) = legacy_user_data_root() {
        let p = root.join("owllm_state.db");
        if p.is_file() { return Some(p); }
    }
    // Neither exists yet — return the WRITE target (new root) so the
    // SQLite connection creates the file there.
    user_data_root().map(|r| r.join("owllm_state.db"))
}

/// Where save_agent_definition / Studio writes its custom agent JSONs.
pub fn custom_agents_dir() -> Option<PathBuf> {
    user_data_root().map(|r| r.join("agent_definitions"))
}

/// Read-side: list custom agents from EITHER the new dir or the legacy
/// LLM/data/agent_definitions/ during the migration window.
pub fn custom_agents_dirs_read() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(p) = custom_agents_dir() {
        if p.is_dir() { out.push(p); }
    }
    if let Some(legacy) = legacy_user_data_root() {
        let p = legacy.join("agent_definitions");
        if p.is_dir() && !out.contains(&p) { out.push(p); }
    }
    out
}

/// Where Studio's saved team templates live.
pub fn custom_teams_dir() -> Option<PathBuf> {
    user_data_root().map(|r| r.join("teams"))
}

pub fn custom_teams_dirs_read() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(p) = custom_teams_dir() {
        if p.is_dir() { out.push(p); }
    }
    if let Some(legacy) = legacy_user_data_root() {
        let p = legacy.join("teams");
        if p.is_dir() && !out.contains(&p) { out.push(p); }
    }
    out
}

/// Where installed skill packs live (one folder per pack, each with
/// SKILL.md inside). The `_remote/` subdir under here holds shallow
/// clones of the curated git sources.
pub fn skills_dir() -> Option<PathBuf> {
    user_data_root().map(|r| r.join("skills"))
}

pub fn skills_dirs_read() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(p) = skills_dir() {
        if p.is_dir() { out.push(p); }
    }
    if let Some(legacy) = legacy_user_data_root() {
        let p = legacy.join("skills");
        if p.is_dir() && !out.contains(&p) { out.push(p); }
    }
    out
}

/// GPU selection JSON (`gpu_config.json`). New canonical location is
/// the user-data root; legacy reads come from LLM/data/ then the even-
/// older LLM/desktop_app/config/.
pub fn user_gpu_config_path() -> Option<PathBuf> {
    user_data_root().map(|r| r.join("gpu_config.json"))
}

/// Sentinel file marking that the one-time migration ran. Located in
/// the user-data root so a wipe of that dir is "start over" without
/// the migration getting skipped.
pub fn migration_sentinel_path() -> Option<PathBuf> {
    user_data_root().map(|r| r.join(".migrated_from_legacy"))
}

// =====================================================================
// Runtime root + models root (Phase 3)
//
// Heavy artifacts that the app downloads on demand. Split from user
// state (Phase 2) because:
//   * Models + venvs can hit tens of GB — they don't belong under
//     %APPDATA% (roaming-profile sync would explode).
//   * They're regenerable: a fresh install can re-fetch them via the
//     installer's first-launch bootstrap.
//
//   Windows: %LOCALAPPDATA%\OwLLM Desktop\runtime\   (and \models\)
//   macOS:   ~/Library/Application Support/OwLLM Desktop/runtime/
//   Linux:   $XDG_CACHE_HOME/OwLLM Desktop/runtime/  (or ~/.cache/...)
//
// NO migration runs for these. Models are gigabytes — copying would be
// wasteful and risky. Path helpers prefer the new location and fall
// back to the existing LLM/{python_runtime, runtime, .envs, models,
// fine_tuned} paths, so an existing install keeps working as-is. New
// downloads land in the new location; the installer bootstrap fills
// the new tree on a fresh machine.
// =====================================================================

/// Root for heavy runtime + cache. On Windows this is %LOCALAPPDATA%
/// (NOT %APPDATA%) so gigabytes of weights don't roam between user
/// profiles. Created if missing.
pub fn runtime_cache_root() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("OWLLM_RUNTIME_ROOT") {
        let pb = PathBuf::from(p);
        if !pb.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(&pb);
            return Some(pb);
        }
    }
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let pb = PathBuf::from(local).join(APP_DIR_NAME);
            let _ = std::fs::create_dir_all(&pb);
            return Some(pb);
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            let pb = PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join(APP_DIR_NAME);
            let _ = std::fs::create_dir_all(&pb);
            return Some(pb);
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Ok(xdg) = std::env::var("XDG_CACHE_HOME") {
            let pb = PathBuf::from(xdg).join(APP_DIR_NAME);
            let _ = std::fs::create_dir_all(&pb);
            return Some(pb);
        }
        if let Ok(home) = std::env::var("HOME") {
            let pb = PathBuf::from(home).join(".cache").join(APP_DIR_NAME);
            let _ = std::fs::create_dir_all(&pb);
            return Some(pb);
        }
    }
    None
}

/// Where the bundled Python interpreter + runtime binaries (llama.cpp,
/// uv, node) end up after the Phase-3 installer fetches them. Returns
/// `<runtime_cache_root>/runtime/`.
pub fn runtime_root() -> Option<PathBuf> {
    let pb = runtime_cache_root()?.join("runtime");
    Some(pb)
}

/// Where downloaded model weights live. Returns
/// `<runtime_cache_root>/models/`. Falls back via models_dirs_read().
pub fn models_root_new() -> Option<PathBuf> {
    Some(runtime_cache_root()?.join("models"))
}

/// All readable model-tree roots, in priority order. Lets list_models /
/// huggingface scans surface weights regardless of whether they live
/// in the new %LOCALAPPDATA% tree or the legacy LLM/models/ tree.
pub fn models_dirs_read() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(p) = models_root_new() {
        if p.is_dir() { out.push(p); }
    }
    if let Some(r) = llm_root() {
        let legacy = r.join("models");
        if legacy.is_dir() && !out.contains(&legacy) { out.push(legacy); }
    }
    out
}

/// All readable fine-tuned-output roots. Phase-3 home is
/// `<runtime_cache_root>/fine_tuned/`; falls back to LLM/fine_tuned/.
pub fn fine_tuned_dirs_read() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(r) = runtime_cache_root() {
        let p = r.join("fine_tuned");
        if p.is_dir() { out.push(p); }
    }
    if let Some(r) = llm_root() {
        let legacy = r.join("fine_tuned");
        if legacy.is_dir() && !out.contains(&legacy) { out.push(legacy); }
    }
    out
}

/// Default write target for new fine-tuned outputs. Returns the
/// %LOCALAPPDATA% path when available; callers create the dir lazily.
#[allow(dead_code)]
pub fn fine_tuned_dir_write() -> Option<PathBuf> {
    if let Some(r) = runtime_cache_root() {
        return Some(r.join("fine_tuned"));
    }
    llm_root().map(|r| r.join("fine_tuned"))
}
