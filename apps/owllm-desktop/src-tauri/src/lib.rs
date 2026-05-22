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

use tauri::Emitter;

mod accounts;
mod agent_tools;
mod agents;
mod bridges;
mod code;
mod dialog;
mod directives;
mod env_manager;
mod finetuning;
mod fleet;
mod hardware;
mod huggingface;
mod models;
mod paths;
mod projects;
mod recommendations;
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
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && payload.event() == tauri::webview::PageLoadEvent::Finished
            {
                let window = webview.window();
                let _ = window.maximize();
                let show_window = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(120));
                    let dispatch_window = show_window.clone();
                    let _ = show_window.run_on_main_thread(move || {
                        let _ = dispatch_window.show();
                        let _ = dispatch_window.emit("owllm:shown", ());
                    });
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            accounts::accounts_status,
            accounts::accounts_save_api_key,
            accounts::accounts_delete_secret,
            accounts::accounts_get_secret,
            accounts::accounts_test_probe,
            accounts::claude_cli_complete,
            accounts::claude_cli_stream,
            accounts::kimi_cli_complete,
            accounts::subscription_cli_login,
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
            huggingface::hf_search,
            huggingface::hf_model_files,
            huggingface::hf_download,
            huggingface::list_tuned_adapters,
            huggingface::delete_tuned_adapter,
            huggingface::hf_cache_list,
            huggingface::hf_cache_delete,
            huggingface::models_list_downloaded,
            recommendations::models_recommended,
            paths::shell_open_url,
            env_manager::env_profiles_list,
            env_manager::env_profile_status,
            env_manager::env_profile_install,
            env_manager::env_profile_uninstall,
            finetuning::train_start,
            finetuning::train_stop,
            finetuning::train_status,
            finetuning::dataset_check,
            finetuning::abliterate_start,
            finetuning::export_gguf,
            agent_tools::tool_read_file,
            agent_tools::tool_write_file,
            agent_tools::tool_list_dir,
            agent_tools::tool_create_dir,
            agent_tools::tool_shell_exec,
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
