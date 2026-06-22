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
mod audio;
mod bootstrap;
mod bridges;
mod code;
mod crypt;
mod data_layer;
mod dialog;
mod directives;
mod discord;
mod email;
mod env_manager;
mod finetuning;
mod fleet;
mod git;
mod hardware;
mod huggingface;
mod mcp;
mod models;
mod modules;
mod overlay_frame;
mod paths;
mod projects;
mod pty;
mod readiness;
mod recommendations;
mod server;
mod skill_library;
mod support;
mod github;
mod sandbox;
mod slack;
mod telegram;
mod vault;
mod webhook;
mod wsl;
mod wsl_setup;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Kill Windows' "ghost window" so a brief main-thread stall never
            // pops a stray "(Not Responding)" frame over the overlay chrome.
            overlay_frame::disable_window_ghosting();
            // One-time copy of LLM/data/* into %APPDATA%\OwLLM Desktop\
            // for users coming from the pre-restructure layout. Idempotent —
            // gated by a sentinel file inside the new root, so subsequent
            // launches no-op. Runs synchronously before any module that
            // touches the SQLite state so we don't end up with two parallel
            // DBs on first launch.
            bootstrap::migrate_user_state_if_needed();
            // Seed OWLLM's built-in skill packs (e.g. parallel-dispatch) into the
            // user skills dir if absent, so they're visible + editable in Studio
            // and equippable. Never clobbers a user-edited copy.
            bootstrap::seed_builtin_skills();
            // Diagnostic: log the resolved paths on startup so missing
            // models / disappeared user state can be triaged from the
            // log file without F12 console acrobatics. Tries three
            // candidate locations so even a stripped-env Tauri context
            // gets ONE that succeeds.
            let dbg = paths::paths_debug();
            if let Ok(s) = serde_json::to_string_pretty(&dbg) {
                let mut targets: Vec<std::path::PathBuf> = Vec::new();
                if let Some(t) = std::env::var_os("TEMP") {
                    targets.push(std::path::PathBuf::from(&t).join("owllm-paths.log"));
                }
                if let Some(t) = std::env::var_os("USERPROFILE") {
                    targets.push(std::path::PathBuf::from(&t).join("owllm-paths.log"));
                }
                if let Ok(exe) = std::env::current_exe() {
                    if let Some(p) = exe.parent() {
                        targets.push(p.join("owllm-paths.log"));
                    }
                }
                for t in &targets {
                    if std::fs::write(t, &s).is_ok() {
                        eprintln!("[owllm] paths_debug written to {}", t.display());
                        break;
                    }
                }
            }
            // Module-local state lives where the module lives; lib.rs
            // just kicks off the install.
            server::install(app);
            overlay_frame::install(app);
            // Module system (registry + per-user installed.json under
            // app_data_dir/modules/). Wizard reads from this; Server /
            // Train pages resolve binaries through it.
            match modules::ModuleManager::new(&app.handle()) {
                Ok(mgr) => {
                    use tauri::Manager;
                    app.handle().manage(mgr);
                }
                Err(e) => eprintln!("[owllm] ModuleManager init failed: {e}"),
            }
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if webview.label() == overlay_frame::label()
                && payload.event() == tauri::webview::PageLoadEvent::Finished
            {
                overlay_frame::mark_ready();
            }
            if webview.label() == "main"
                && payload.event() == tauri::webview::PageLoadEvent::Finished
            {
                let window = webview.window();
                // Don't force-maximize on first paint — tauri.conf.json
                // sets width/height (1400x960) which is what the user
                // expects. The previous unconditional .maximize() call
                // overrode that and made the window open full-screen
                // every launch.
                let show_window = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(120));
                    overlay_frame::wait_until_ready(std::time::Duration::from_millis(700));
                    let dispatch_window = show_window.clone();
                    let _ = show_window.run_on_main_thread(move || {
                        let _ = overlay_frame::prepare_and_show_for_main(&dispatch_window);
                        let _ = dispatch_window.show();
                        let _ = dispatch_window.emit("owllm:shown", ());
                    });
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            modules::module_list,
            modules::module_hardware_snapshot,
            modules::module_install,
            modules::module_uninstall,
            modules::module_set_channel,
            modules::module_variant_path,
            data_layer::data_fetch_json,
            data_layer::data_fetch_yaml,
            data_layer::data_fetch_text,
            data_layer::data_cache_list,
            accounts::accounts_status,
            accounts::accounts_save_api_key,
            accounts::accounts_delete_secret,
            accounts::accounts_get_secret,
            accounts::accounts_test_probe,
            accounts::accounts_test_probe_wsl,
            accounts::claude_cli_complete,
            accounts::codex_cli_complete,
            accounts::codex_cli_stream,
            accounts::claude_cli_stream,
            accounts::kimi_cli_complete,
            accounts::gemini_cli_complete,
            accounts::subscription_cli_login,
            accounts::subscription_cli_logout,
            accounts::cli_install,
            accounts::cli_install_stream,
            accounts::accounts_test_probe_live,
            audio::audio_transcribe_local,
            audio::whisper_runtime_status,
            audio::whisper_runtime_install,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            agents::list_team_templates,
            agents::list_agent_roles,
            agents::save_agent_definition,
            agents::save_team_template,
            agents::delete_team_template,
            agents::create_agent_definition,
            agents::delete_agent_definition,
            agents::list_skill_packs,
            bridges::load_bridge_configs,
            bridges::bridge_route_get,
            bridges::bridge_route_set,
            bridges::bridge_routes_clear_prefix,
            bridges::save_telegram_config,
            bridges::save_whatsapp_config,
            bridges::save_discord_config,
            bridges::save_slack_config,
            bridges::save_email_config,
            bridges::save_line_config,
            email::email_poll,
            email::email_send,
            webhook::webhook_start,
            webhook::webhook_stop,
            webhook::whatsapp_send,
            webhook::line_push,
            discord::discord_send_message,
            discord::discord_download_file,
            slack::slack_open_connection,
            slack::slack_send_message,
            slack::slack_download_file,
            git::git_status,
            git::git_branches,
            git::git_checkout,
            git::git_commit,
            git::git_diff,
            code::launch_external_editor,
            dialog::pick_folder,
            dialog::pick_file,
            directives::directives_list,
            directives::directives_add,
            directives::directives_update,
            directives::directives_delete,
            directives::project_set_director_mode,
            directives::project_get_director_mode,
            fleet::path_is_dir,
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
            overlay_frame::overlay_frame_enabled,
            overlay_frame::overlay_frame_capture_geometry,
            projects::list_projects,
            projects::create_project,
            projects::update_project,
            projects::delete_project,
            server::server_status,
            server::server_start,
            server::server_stop,
            server::inference_expose_get,
            server::inference_expose_set,
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
            huggingface::model_weight_files,
            huggingface::delete_model_weight,
            recommendations::models_recommended,
            paths::shell_open_url,
            paths::paths_debug,
            paths::llama_server_path,
            readiness::app_readiness,
            support::support_snapshot,
            support::support_capture_window,
            support::support_export_report,
            support::support_send_report,
            env_manager::env_profiles_list,
            env_manager::env_profile_status,
            env_manager::env_profile_install,
            env_manager::env_profile_uninstall,
            env_manager::env_profile_doctor,
            finetuning::train_start,
            finetuning::train_stop,
            finetuning::train_status,
            finetuning::dataset_check,
            finetuning::dataset_ingest,
            finetuning::dataset_save,
            finetuning::dataset_default_dir,
            finetuning::abliterate_start,
            finetuning::export_gguf,
            finetuning::hf_dir_weight_bytes,
            agent_tools::chat_scratch_dir,
            agent_tools::fetch_remote_text,
            agent_tools::tool_read_file,
            agent_tools::tool_write_file,
            agent_tools::tool_list_dir,
            agent_tools::tool_create_dir,
            agent_tools::tool_shell_exec,
            agent_tools::tool_ssh_exec,
            agent_tools::tool_ssh_upload,
            agent_tools::tool_ssh_download,
            agent_tools::tool_grep,
            agent_tools::tool_glob,
            agent_tools::tool_web_search,
            agent_tools::tool_web_fetch,
            agent_tools::tool_screenshot_url,
            wsl::wsl_status,
            wsl::wsl_restart,
            wsl::wsl_isolation_get,
            wsl::wsl_isolation_set,
            wsl::wsl_create_project,
            wsl::wsl_list_projects,
            wsl::wsl_toolchain_status,
            wsl::wsl_provision,
            wsl::wsl_install,
            wsl_setup::wsl_setup_status,
            wsl_setup::wsl_setup_install,
            wsl_setup::wsl_setup_provision_python,
            wsl_setup::wsl_setup_ensure_user,
            wsl_setup::wsl_setup_get_account,
            wsl_setup::wsl_setup_reveal_password,
            wsl_setup::wsl_reboot,
            github::github_status,
            github::github_connect,
            github::github_disconnect,
            github::github_device_start,
            github::github_device_poll,
            vault::vault_status,
            vault::vault_ensure,
            vault::vault_read_remote_state,
            vault::vault_write_state,
            vault::vault_align,
            vault::vault_publish_server,
            vault::vault_unpublish_server,
            vault::vault_read_server,
            vault::vault_sync_teams,
            vault::vault_sync_projects,
            sandbox::sandbox_status,
            sandbox::agent_save_inbox_images,
            sandbox::agent_full_access_get,
            sandbox::agent_full_access_set,
            sandbox::sandbox_harden,
            sandbox::sandbox_disk_usage,
            sandbox::sandbox_clear_caches,
            sandbox::sandbox_reclaim_disk,
            sandbox::sandbox_create_project,
            sandbox::sandbox_list_projects,
            sandbox::sandbox_provision,
            sandbox::sandbox_sync_logins,
            sandbox::sandbox_login_status,
            sandbox::sandbox_convert_project,
            mcp::mcp_load_config,
            mcp::mcp_save_config,
            mcp::mcp_start_server,
            mcp::mcp_stop_server,
            mcp::mcp_list_servers,
            mcp::mcp_list_all_tools,
            mcp::mcp_call_tool,
            mcp::mcp_autostart_all,
            mcp::mcp_install_pack,
            mcp::install_uv,
            mcp::runtime_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building OwLLM Desktop")
        .run(|app, event| {
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
                // Keep the decorative overlay frame glued to the main window
                // as it moves/resizes — event-driven so it tracks drags
                // precisely instead of trailing the 33ms poll (which could
                // also leave it visibly stuck after a transient hiccup).
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_),
                    ..
                } if label == "main" => {
                    overlay_frame::sync_now(app);
                }
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::CloseRequested { .. },
                    ..
                } if label == "main" => {
                    overlay_frame::close_if_present(app);
                    // Reap llama-server HERE too, not only on ExitRequested —
                    // Tauri 2 doesn't guarantee ExitRequested fires on the X.
                    // BUT only when THIS is the last OwLLM window: other windows
                    // may be sharing the server (multi-instance), and killing it
                    // out from under them is what split/broke their sessions.
                    // Deregister ourselves, then reap by name only if no other
                    // window is live ("stop on last close").
                    server::deregister_window();
                    if server::other_live_windows() == 0 {
                        server::kill_all_llama_servers("last-window-close");
                    }
                }
                tauri::RunEvent::ExitRequested { .. } => {
                    overlay_frame::close_if_present(app);
                    server::deregister_window();
                    if server::other_live_windows() == 0 {
                        server::kill_all_llama_servers("last-window-exit-requested");
                    }
                }
                tauri::RunEvent::Exit => {
                    overlay_frame::close_if_present(app);
                    server::deregister_window();
                    if server::other_live_windows() == 0 {
                        server::kill_all_llama_servers("last-window-exit");
                    }
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
