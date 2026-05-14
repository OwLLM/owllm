// OwLLM Desktop — Tauri + React. NO Python at runtime.
//
// Architecture (2026-05-14):
//   * Rust owns the runtime — model registry, server lifecycle,
//     hardware probe, MCP, bridges, agents. Modules below.
//   * React owns the UI — talks to Rust via `invoke()` only.
//   * Python is invited on-demand only for fine-tuning + per-model
//     venv bootstrap. NEVER auto-started; one-shot subprocesses
//     when invoked. (Future slot: `python_jobs.rs`.)
//
// Each command lives in its own module so this file stays a wiring
// manifest and nothing more.

mod accounts;
mod agents;
mod bridges;
mod code;
mod dialog;
mod hardware;
mod models;
mod paths;
mod projects;
mod server;
mod skill_library;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Module-local state lives where the module lives; lib.rs
            // just kicks off the install.
            server::install(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            accounts::accounts_status,
            accounts::accounts_save_api_key,
            accounts::accounts_delete_secret,
            accounts::accounts_get_secret,
            accounts::accounts_test_probe,
            agents::list_team_templates,
            agents::list_agent_roles,
            agents::list_skill_packs,
            bridges::load_bridge_configs,
            bridges::save_telegram_config,
            bridges::save_whatsapp_config,
            code::launch_external_editor,
            dialog::pick_folder,
            dialog::pick_file,
            hardware::hardware_info,
            hardware::vram_status,
            models::list_models,
            projects::list_projects,
            projects::create_project,
            projects::update_project,
            projects::delete_project,
            server::server_status,
            server::server_start,
            server::server_stop,
            skill_library::list_skill_sources,
            skill_library::fetch_skill_source,
            skill_library::discover_skills,
            skill_library::install_skill,
            skill_library::uninstall_skill,
            skill_library::list_installed_skill_folders,
            skill_library::read_skill_md,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OwLLM Desktop");
}

// All custom Win32 window-style manipulation removed. tauri.conf.json
// drives the window directly: decorations:false + transparent:true
// gives a fully invisible OS chrome with the desktop showing through
// the HybridFrame corner gaps. Drag, resize, and min/max/close are
// handled by JS handlers in AppShell.tsx talking to Tauri's window
// APIs (startDragging, startResizeDragging, toggleMaximize).
