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
        let opener = if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        std::process::Command::new(opener)
            .arg(&url)
            .spawn()
            .map_err(|e| format!("spawn: {e}"))?;
    }
    Ok(())
}

/// Root of the legacy runtime-data tree (the dir formerly known as
/// `LLM/`, renamed in Phase 5 to `runtime-data/`). Contains
/// `models/`, `runtime/`, `python_runtime/`, `.envs/`, etc. Returns
/// None when the tree cannot be located — callers must degrade
/// gracefully.
///
/// Lookup tries the new name first, falls back to the old `LLM/` name
/// so a half-renamed checkout still works.
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
    // Names checked at every ancestor level, in priority order.
    const NAMES: &[&str] = &["runtime-data", "LLM"];
    let exe_name = llama_server_filename();
    for seed in seeds {
        for dir in seed.ancestors() {
            for name in NAMES {
                let candidate = dir.join(name);
                // Anchor on the llama-server.exe shipping under
                // <root>/runtime/llama.cpp — the marker that distinguishes
                // the real tree from a half-init scratch dir.
                if candidate
                    .join("runtime")
                    .join("llama.cpp")
                    .join(exe_name)
                    .is_file()
                {
                    return Some(candidate);
                }
                // Fallback marker: a `models/` directory means the user
                // has at least a partial install — list_models will
                // still find any GGUFs there even before runtime is
                // bootstrapped.
                if candidate.join("models").is_dir() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// Filename of the llama.cpp HTTP server binary on the current host.
/// Cross-platform: `.exe` on Windows, bare on macOS/Linux. Used wherever
/// we anchor a directory probe on "is there a llama-server binary here".
pub const fn llama_server_filename() -> &'static str {
    if cfg!(target_os = "windows") {
        "llama-server.exe"
    } else {
        "llama-server"
    }
}

/// Path to the llama.cpp HTTP server binary. Allows direct override via
/// OWLLM_LLAMA_SERVER for custom builds.
///
/// Resolution order:
///   1. `OWLLM_LLAMA_SERVER` env var (manual override)
///   2. **Module install dir** — `app_data_dir/modules/local-inference-*/llama-server.exe`
///      (new path; populated by the wizard's module installer)
///   3. Legacy `%LOCALAPPDATA%\OwLLM Desktop\runtime\llama.cpp\`
///   4. Repo `runtime-data\runtime\llama.cpp\` (dev fallback)
pub fn llama_server_exe() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("OWLLM_LLAMA_SERVER") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    let exe_name = llama_server_filename();
    if let Some(p) = module_binary("local-inference-", exe_name) {
        return Some(p);
    }
    // Phase 3: prefer %LOCALAPPDATA%\OwLLM Desktop\runtime\llama.cpp\.
    if let Some(rt) = runtime_root() {
        let exe = rt.join("llama.cpp").join(exe_name);
        if exe.is_file() {
            return Some(exe);
        }
    }
    let exe = llm_root()?.join("runtime").join("llama.cpp").join(exe_name);
    if exe.is_file() {
        Some(exe)
    } else {
        None
    }
}

/// Look for `<binary>` under `app_data_dir/modules/<variant-prefix>*\`.
/// Used by the module system to point legacy paths::* helpers at the
/// new install location without coupling them to the ModuleManager type.
///
/// Returns the first matching binary across all installed variants of
/// a module family (e.g. `local-inference-cuda-bXXX`, `local-inference-cpu-bXXX`).
/// Picks the lexicographically latest variant if multiple exist.
pub fn module_binary(variant_prefix: &str, binary_name: &str) -> Option<PathBuf> {
    let modules_root = appdata_root()?.join("modules");
    let entries = std::fs::read_dir(&modules_root).ok()?;
    let mut candidates: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_str()
                .map(|n| n.starts_with(variant_prefix))
                .unwrap_or(false)
        })
        .map(|e| e.path())
        .collect();
    candidates.sort();
    candidates.reverse();
    for dir in candidates {
        let direct = dir.join(binary_name);
        if direct.is_file() {
            return Some(direct);
        }
        // Allow one level of nesting (some upstream zips wrap their
        // payload in a top-level folder).
        if let Ok(sub) = std::fs::read_dir(&dir) {
            for entry in sub.flatten() {
                let nested = entry.path().join(binary_name);
                if nested.is_file() {
                    return Some(nested);
                }
            }
        }
    }
    None
}

/// Repointed for fine-tuning: returns `app_data_dir/modules/python-3.11-embed-win-*/python.exe`
/// when the python-runtime module is installed. Used by env_manager to
/// build venvs without depending on a system Python.
pub fn module_python_exe() -> Option<PathBuf> {
    let name = if cfg!(target_os = "windows") {
        "python.exe"
    } else {
        "python3"
    };
    module_binary("python-3.11-embed-", name)
}

/// Repointed for MCP toolchain: returns `app_data_dir/modules/mcp-toolchain-*/uv/uv.exe`.
pub fn module_uv_exe() -> Option<PathBuf> {
    let name = if cfg!(target_os = "windows") {
        "uv.exe"
    } else {
        "uv"
    };
    module_binary("mcp-toolchain-", name)
}

/// Returns the bundled `node.exe` from any installed Node.js module.
/// Tries the dedicated `nodejs-runtime-` family first (cli_install,
/// MCP runtime, etc. all use this); falls back to the legacy
/// `mcp-toolchain-` family for users who still have that module.
pub fn module_node_exe() -> Option<PathBuf> {
    let name = if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    };
    module_binary("nodejs-runtime-", name).or_else(|| module_binary("mcp-toolchain-", name))
}

/// Directory containing the bundled Node.js binaries. Used by the CLI
/// installer's PATH augmentation so `npm.cmd` / `npx.cmd` / `node.exe`
/// resolve via the bundled runtime even when the host doesn't have
/// Node installed system-wide.
pub fn module_node_dir() -> Option<PathBuf> {
    module_node_exe().and_then(|p| p.parent().map(PathBuf::from))
}

fn appdata_root() -> Option<PathBuf> {
    // Mirrors Tauri's app_data_dir() for our identifier without needing
    // the AppHandle (paths.rs is called from places that don't have one).
    // Must match per-OS, or module lookups miss what ModuleManager
    // installed: %APPDATA% only exists on Windows, so resolving it
    // unconditionally made every installed module invisible on Linux.
    const IDENTIFIER: &str = "com.localllm.owllm-desktop";
    #[cfg(windows)]
    {
        let appdata = std::env::var_os("APPDATA")?;
        Some(PathBuf::from(appdata).join(IDENTIFIER))
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")?;
        Some(
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join(IDENTIFIER),
        )
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
            if !xdg.is_empty() {
                return Some(PathBuf::from(xdg).join(IDENTIFIER));
            }
        }
        let home = std::env::var_os("HOME")?;
        Some(
            PathBuf::from(home)
                .join(".local")
                .join("share")
                .join(IDENTIFIER),
        )
    }
}

/// The OwLLM config + credentials home ON THE HOST. Normally
/// `%USERPROFILE%\.owllm` (or `$HOME/.owllm`), but when `OWLLM_PORTABLE_ROOT`
/// is set (USB / portable mode) it redirects to `<root>/.owllm` so secrets,
/// configs, and bridges live on the stick and leave no trace on the host.
///
/// This is the SINGLE source of truth for every host-side `.owllm` path
/// (agent_secrets.json, mcp_config.json, bridge_config.json, full-access.json,
/// …). USB-portable Block 1 — see docs/USB_PORTABLE_OWLLM.md.
///
/// IMPORTANT: this is the HOST config home. Paths that live INSIDE WSL — the
/// sandbox runner's `$HOME/.owllm/sbhome`, `agent_env.sh`, fine-tuning venvs —
/// reference the WSL home and are NOT redirected by this (a USB stick can't
/// carry WSL). Don't route those through here.
pub fn owllm_config_home() -> Option<PathBuf> {
    if let Some(root) = std::env::var_os("OWLLM_PORTABLE_ROOT") {
        if !root.is_empty() {
            return Some(PathBuf::from(root).join(".owllm"));
        }
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(home).join(".owllm"))
}

/// USB-portable Block 2 — one-shot portable-mode bootstrap, called from
/// lib::run() BEFORE the webview or any path helper runs.
///
/// Detection (either is enough):
///   1. `OWLLM_PORTABLE_ROOT` already set (the portable launcher .bat does this).
///   2. A `portable.json` marker file sitting NEXT TO the exe → the exe's
///      folder becomes the root (drop the app on a stick, no launcher needed).
///
/// When portable, seed the EXISTING env-override family so every data root
/// lands under the stick with zero changes to the path helpers themselves:
///   OWLLM_PORTABLE_ROOT        → <root>            (config + secrets home)
///   OWLLM_USER_DATA            → <root>\.owllm\user-data   (state DB, consent, …)
///   OWLLM_LLM_ROOT             → <root>\runtime-data       (models / llama-server)
///   WEBVIEW2_USER_DATA_FOLDER  → <root>\.owllm\webview2    (webview cache/cookies)
/// Vars the user already set explicitly are left untouched.
pub fn init_portable_mode() {
    let root: Option<PathBuf> = match std::env::var_os("OWLLM_PORTABLE_ROOT") {
        Some(r) if !r.is_empty() => Some(PathBuf::from(r)),
        _ => std::env::current_exe().ok().and_then(|exe| {
            let dir = exe.parent()?.to_path_buf();
            dir.join("portable.json").is_file().then_some(dir)
        }),
    };
    let Some(root) = root else { return };
    let seed = |key: &str, val: PathBuf| {
        if std::env::var_os(key)
            .map(|v| !v.is_empty())
            .unwrap_or(false)
        {
            return; // explicit user override wins
        }
        let _ = std::fs::create_dir_all(&val);
        std::env::set_var(key, &val);
    };
    // Also (re)export the root itself so child processes (subscription CLIs,
    // spawned tools) inherit portable mode.
    std::env::set_var("OWLLM_PORTABLE_ROOT", &root);
    seed("OWLLM_USER_DATA", root.join(".owllm").join("user-data"));
    seed("OWLLM_LLM_ROOT", root.join("runtime-data"));
    seed(
        "WEBVIEW2_USER_DATA_FOLDER",
        root.join(".owllm").join("webview2"),
    );
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
    if let Some(p) = module_binary("local-inference-", "llama-quantize.exe") {
        return Some(p);
    }
    if let Some(rt) = runtime_root() {
        let exe = rt.join("llama.cpp").join("llama-quantize.exe");
        if exe.is_file() {
            return Some(exe);
        }
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
    // The bundled runtime's interpreter layout differs per OS: the Windows
    // embeddable build ships python.exe at the top, a Linux/macOS runtime
    // ships bin/python3. Probing only python.exe made this None on every
    // non-Windows install, which killed venv creation (finetuning env
    // Install/Repair) and the screenshot tool there.
    let rel_candidates: &[&[&str]] = if cfg!(windows) {
        &[&["python3.11", "python.exe"]]
    } else {
        &[
            &["python3.11", "bin", "python3"],
            &["python3.11", "bin", "python3.11"],
            &["bin", "python3"],
        ]
    };
    let roots = [
        runtime_root().map(|r| r.join("python_runtime")),
        llm_root().map(|r| r.join("python_runtime")),
    ];
    for root in roots.iter().flatten() {
        for rel in rel_candidates {
            let mut candidate = root.clone();
            for part in *rel {
                candidate = candidate.join(part);
            }
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    // No bundled runtime → fall back to a system interpreter (Unix only;
    // on Windows the bundled runtime is the supported path). `python3` on
    // PATH is the norm on Linux and covers the ARM64 builds, where no
    // python-runtime module exists yet.
    #[cfg(not(windows))]
    {
        for name in ["python3", "python"] {
            if let Ok(out) = std::process::Command::new("which").arg(name).output() {
                if out.status.success() {
                    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !p.is_empty() {
                        let pb = PathBuf::from(p);
                        if pb.is_file() {
                            return Some(pb);
                        }
                    }
                }
            }
        }
    }
    None
}

/// Path to the finetune.py training entrypoint. Lives at the legacy
/// location so we don't move user-edited scripts around during the
/// Rust port.
#[allow(dead_code)]
pub fn finetune_script() -> Option<PathBuf> {
    // Prefer the in-app resources copy; fall back to the legacy LLM/ root.
    if let Some(root) = resources_root() {
        let p = root.join("finetune.py");
        if p.is_file() {
            return Some(p);
        }
    }
    let p = llm_root()?.join("finetune.py");
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

/// Bundled copy of finish-and-publish.sh — the rule-based release pipeline the
/// app runs against ANY open repo (with --repo-dir), so publishing doesn't
/// require the target repo to carry the script itself. Bundled from
/// `../scripts/` (tauri.conf.json), which the installer lands at `_up_/scripts/`
/// next to the exe; the dev fallback is the source checkout's scripts dir.
pub fn publish_finish_script() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            for cand in [
                parent.join("_up_").join("scripts").join("finish-and-publish.sh"),
                parent.join("scripts").join("finish-and-publish.sh"),
            ] {
                if cand.is_file() {
                    return Some(cand);
                }
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("scripts")
        .join("finish-and-publish.sh");
    if dev.is_file() {
        Some(dev)
    } else {
        None
    }
}

/// Path to the abliterate.py CLI — the FailSpy-recipe refusal-direction
/// stripper invoked by the Train page's '🚫 Abliterate' action.
pub fn abliterate_script() -> Option<PathBuf> {
    if let Some(root) = resources_root() {
        let p = root.join("tools").join("abliterate.py");
        if p.is_file() {
            return Some(p);
        }
    }
    let p = llm_root()?.join("tools").join("abliterate.py");
    if p.is_file() {
        Some(p)
    } else {
        None
    }
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
///      for `owllm-desktop/resources/agents/roles/` (the marker
///      directory we know exists post-restructure).
///   3. Sibling-of-exe lookup for installed builds: `<exe dir>/resources/`.
///
/// Post Phase-5 the app lives at `<repo>/owllm-desktop/` (no apps/
/// wrapper). The walk-up checks both the new direct layout AND the
/// legacy `apps/owllm-desktop/` location so older clones still work.
pub fn resources_root() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("OWLLM_RESOURCES") {
        let pb = PathBuf::from(p);
        if pb.is_dir() {
            return Some(pb);
        }
    }
    // Installed-app layout: resources/ sits next to the exe…
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let cand = parent.join("resources");
            if cand.join("agents").join("roles").is_dir() {
                return Some(cand);
            }
            // …but Tauri's bundler appends `_up_/` to any resource path
            // that contains `..` in tauri.conf.json (`../resources/...`
            // gets installed as `$INSTDIR\_up_\resources\...`). The
            // alternative is to move resources/ inside src-tauri/ which
            // would churn every other path the app relies on. Checking
            // both locations is the smaller fix.
            let up_cand = parent.join("_up_").join("resources");
            if up_cand.join("agents").join("roles").is_dir() {
                return Some(up_cand);
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
            // New (post-Phase 5) direct layout.
            let direct = dir.join("owllm-desktop").join("resources");
            if direct.join("agents").join("roles").is_dir() {
                return Some(direct);
            }
            // Legacy apps/ wrapper layout — kept as a fallback so an
            // older checkout still resolves until it's restructured.
            let legacy = dir.join("apps").join("owllm-desktop").join("resources");
            if legacy.join("agents").join("roles").is_dir() {
                return Some(legacy);
            }
        }
    }
    None
}

/// Built-in agent role YAMLs.
pub fn roles_dir() -> Option<PathBuf> {
    if let Some(r) = resources_root() {
        let p = r.join("agents").join("roles");
        if p.is_dir() {
            return Some(p);
        }
    }
    let p = llm_root()?.join("core").join("agents").join("roles");
    if p.is_dir() {
        Some(p)
    } else {
        None
    }
}

/// Built-in team template JSONs.
pub fn teams_dir() -> Option<PathBuf> {
    if let Some(r) = resources_root() {
        let p = r.join("agents").join("teams");
        if p.is_dir() {
            return Some(p);
        }
    }
    let p = llm_root()?.join("core").join("agents").join("teams");
    if p.is_dir() {
        Some(p)
    } else {
        None
    }
}

/// Backend / inference config YAMLs (`llm_backends.yaml`, etc.).
#[allow(dead_code)]
pub fn configs_dir() -> Option<PathBuf> {
    if let Some(r) = resources_root() {
        let p = r.join("configs");
        if p.is_dir() {
            return Some(p);
        }
    }
    let p = llm_root()?.join("configs");
    if p.is_dir() {
        Some(p)
    } else {
        None
    }
}

/// Per-GPU environment profile bundle (`env_profiles.yaml` + the
/// arch-specific JSONs).
pub fn profiles_dir() -> Option<PathBuf> {
    if let Some(r) = resources_root() {
        let p = r.join("profiles");
        if p.is_dir() {
            return Some(p);
        }
    }
    let p = llm_root()?.join("profiles");
    if p.is_dir() {
        Some(p)
    } else {
        None
    }
}

/// Python helper scripts shipped with the app (`screenshot_url.py`,
/// `abliterate.py`).
#[allow(dead_code)]
pub fn tools_dir() -> Option<PathBuf> {
    if let Some(r) = resources_root() {
        let p = r.join("tools");
        if p.is_dir() {
            return Some(p);
        }
    }
    let p = llm_root()?.join("tools");
    if p.is_dir() {
        Some(p)
    } else {
        None
    }
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
            let pb = PathBuf::from(home)
                .join(".local")
                .join("share")
                .join(APP_DIR_NAME);
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
    if p.is_dir() {
        Some(p)
    } else {
        None
    }
}

/// SQLite state DB (`owllm_state.db`). Tries the new user-data root
/// first, then the legacy LLM/data/ location.
pub fn state_db_path() -> Option<PathBuf> {
    if let Some(root) = user_data_root() {
        let p = root.join("owllm_state.db");
        if p.is_file() {
            return Some(p);
        }
    }
    if let Some(root) = legacy_user_data_root() {
        let p = root.join("owllm_state.db");
        if p.is_file() {
            return Some(p);
        }
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
        if p.is_dir() {
            out.push(p);
        }
    }
    if let Some(legacy) = legacy_user_data_root() {
        let p = legacy.join("agent_definitions");
        if p.is_dir() && !out.contains(&p) {
            out.push(p);
        }
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
        if p.is_dir() {
            out.push(p);
        }
    }
    if let Some(legacy) = legacy_user_data_root() {
        let p = legacy.join("teams");
        if p.is_dir() && !out.contains(&p) {
            out.push(p);
        }
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
    // Bundled, OwLLM-authored skill packs that ship with the app (read-only).
    // Listing them here makes list_skill_packs discover them like installed packs,
    // so roles can auto-equip them by id out of the box.
    if let Some(root) = resources_root() {
        let p = root.join("agents").join("skills");
        if p.is_dir() {
            out.push(p);
        }
    }
    if let Some(p) = skills_dir() {
        if p.is_dir() && !out.contains(&p) {
            out.push(p);
        }
    }
    if let Some(legacy) = legacy_user_data_root() {
        let p = legacy.join("skills");
        if p.is_dir() && !out.contains(&p) {
            out.push(p);
        }
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

// Diagnostic command — exposed to JS as `invoke('paths_debug')`. Lets us
// see exactly which roots the resolver is finding from the running exe,
// for cases like "downloaded models disappeared after the LLM →
// runtime-data rename".
#[derive(serde::Serialize)]
pub struct PathsDebug {
    pub current_exe: String,
    pub cargo_manifest_dir: String,
    pub resources_root: Option<String>,
    pub llm_root: Option<String>,
    pub user_data_root: Option<String>,
    pub legacy_user_data_root: Option<String>,
    pub runtime_cache_root: Option<String>,
    pub runtime_root: Option<String>,
    pub models_root_new: Option<String>,
    pub models_dirs_read: Vec<String>,
    pub fine_tuned_dirs_read: Vec<String>,
    pub roles_dir: Option<String>,
    pub teams_dir: Option<String>,
}

#[tauri::command]
pub fn paths_debug() -> PathsDebug {
    let s = |o: Option<PathBuf>| o.map(|p| p.to_string_lossy().into_owned());
    PathsDebug {
        current_exe: std::env::current_exe()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|e| format!("err: {e}")),
        cargo_manifest_dir: env!("CARGO_MANIFEST_DIR").into(),
        resources_root: s(resources_root()),
        llm_root: s(llm_root()),
        user_data_root: s(user_data_root()),
        legacy_user_data_root: s(legacy_user_data_root()),
        runtime_cache_root: s(runtime_cache_root()),
        runtime_root: s(runtime_root()),
        models_root_new: s(models_root_new()),
        models_dirs_read: models_dirs_read()
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        fine_tuned_dirs_read: fine_tuned_dirs_read()
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        roles_dir: s(roles_dir()),
        teams_dir: s(teams_dir()),
    }
}

/// Resolved path to llama-server.exe (or the OS-equivalent). None when
/// the local-inference module hasn't been installed yet. Used by the
/// Info page so the user can see exactly which binary the app will run.
#[tauri::command]
pub fn llama_server_path() -> Option<String> {
    llama_server_exe().map(|p| p.to_string_lossy().into_owned())
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

/// Shared, machine-wide models root at `C:\ProgramData\OwLLM Desktop\models\`.
/// Created opt-in via the Settings → Storage toggle (the UI fires the
/// one-time elevated setup that ACLs this directory for everyone).
/// Returns `Some(...)` only when the folder already exists *and* the
/// current user can write to it — otherwise downloads must land in the
/// per-user location.
pub fn shared_models_root() -> Option<PathBuf> {
    if !cfg!(target_os = "windows") {
        return None;
    }
    let programdata = std::env::var_os("PROGRAMDATA")?;
    let dir = PathBuf::from(programdata)
        .join("OwLLM Desktop")
        .join("models");
    if !dir.is_dir() {
        return None;
    }
    // Write-probe: create + remove a marker. Avoids returning a path
    // that's read-only for this user (which would surface as a
    // confusing "download failed" later).
    let probe = dir.join(".owllm-write-probe");
    if std::fs::write(&probe, b"").is_ok() {
        let _ = std::fs::remove_file(&probe);
        Some(dir)
    } else {
        None
    }
}

/// Where downloaded model weights live. Prefers the shared
/// `C:\ProgramData\OwLLM Desktop\models\` when it's been set up (multi-user
/// PC scenario — every account on the box reads from the same store);
/// falls back to per-user `<runtime_cache_root>/models/`.
pub fn models_root_new() -> Option<PathBuf> {
    if let Some(shared) = shared_models_root() {
        return Some(shared);
    }
    Some(runtime_cache_root()?.join("models"))
}

/// All readable model-tree roots, in priority order. Surfaces weights
/// whether they live in the shared ProgramData store, the per-user
/// LOCALAPPDATA tree, or the legacy LLM/models/ tree.
pub fn models_dirs_read() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(p) = shared_models_root() {
        out.push(p);
    }
    if let Some(r) = runtime_cache_root() {
        let p = r.join("models");
        if p.is_dir() && !out.contains(&p) {
            out.push(p);
        }
    }
    if let Some(r) = llm_root() {
        let legacy = r.join("models");
        if legacy.is_dir() && !out.contains(&legacy) {
            out.push(legacy);
        }
    }
    out
}

/// All readable fine-tuned-output roots. Phase-3 home is
/// `<runtime_cache_root>/fine_tuned/`; falls back to LLM/fine_tuned/.
pub fn fine_tuned_dirs_read() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(r) = runtime_cache_root() {
        let p = r.join("fine_tuned");
        if p.is_dir() {
            out.push(p);
        }
    }
    if let Some(r) = llm_root() {
        let legacy = r.join("fine_tuned");
        if legacy.is_dir() && !out.contains(&legacy) {
            out.push(legacy);
        }
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
