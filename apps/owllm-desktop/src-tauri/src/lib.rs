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

use tauri::Manager;

mod accounts;
mod agents;
mod bridges;
mod code;
mod dialog;
mod directives;
mod fleet;
mod hardware;
mod models;
mod paths;
mod projects;
mod server;
mod skill_library;
mod telegram;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Module-local state lives where the module lives; lib.rs
            // just kicks off the install.
            server::install(app);
            // White-flash fix (Tauri 2.1 API, PR #11486 / issue #1564).
            // WebView2's default fill color is opaque white; for the
            // ~600-800ms while it spawns and reaches first paint, the
            // user sees white through the otherwise-transparent Tauri
            // window. Setting the webview's background color with
            // alpha=0 tells WebView2 "draw transparent" from frame
            // zero — the desktop wallpaper shows through briefly
            // instead of opaque white, and the dark splash inlined
            // into index.html covers it the instant HTML parses.
            // Keeps tauri.conf.json's transparent:true intact, so the
            // HybridFrame rounded-corner cutaway still works.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_background_color(Some(tauri::webview::Color(0, 0, 0, 0)));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            accounts::accounts_status,
            accounts::accounts_save_api_key,
            accounts::accounts_delete_secret,
            accounts::accounts_get_secret,
            accounts::accounts_test_probe,
            accounts::claude_cli_complete,
            accounts::claude_cli_stream,
            agents::list_team_templates,
            agents::list_agent_roles,
            agents::list_skill_packs,
            bridges::load_bridge_configs,
            bridges::save_telegram_config,
            bridges::save_whatsapp_config,
            code::launch_external_editor,
            dialog::pick_folder,
            dialog::pick_file,
            directives::directives_list,
            directives::directives_add,
            directives::directives_update,
            directives::directives_delete,
            directives::project_set_director_mode,
            directives::project_get_director_mode,
            fleet::fleet_worktree_create,
            fleet::fleet_worktree_finalize,
            fleet::fleet_worktree_diff,
            fleet::fleet_worktree_merge,
            fleet::fleet_worktree_remove,
            fleet::fleet_head_files,
            hardware::hardware_info,
            hardware::vram_status,
            hardware::set_gpu_selection,
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
            telegram::telegram_get_updates,
            telegram::telegram_send_message,
            telegram::telegram_download_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while building OwLLM Desktop")
        .run(|_app, event| {
            // Reap every spawned llama-server when the app is asked
            // to exit OR is actually exiting. ExitRequested fires
            // before windows are torn down; Exit fires when the
            // process is about to leave. Calling on both is
            // idempotent (sysinfo + kill_by_name) and covers
            // user-close, force-close, panic-on-shutdown, and OS
            // signal paths. Tokio's kill_on_drop is NOT enough — it
            // doesn't run if the runtime is force-killed before the
            // Child is dropped.
            match event {
                tauri::RunEvent::ExitRequested { .. } => {
                    server::kill_all_llama_servers("exit-requested");
                }
                tauri::RunEvent::Exit => {
                    server::kill_all_llama_servers("exit");
                }
                _ => {}
            }
        });
}

// All custom Win32 window-style manipulation removed. tauri.conf.json
// drives the window directly: decorations:false + transparent:true
// gives a fully invisible OS chrome with the desktop showing through
// the HybridFrame corner gaps. Drag, resize, and min/max/close are
// handled by JS handlers in AppShell.tsx talking to Tauri's window
// APIs (startDragging, startResizeDragging, toggleMaximize).
