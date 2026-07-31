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

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

/// Distinguish a deliberate close of the main window from a native engine
/// tearing down an auxiliary browser window. On Linux, WebKitGTK can emit an
/// application-level exit request after a failing top-level browser WebView is
/// destroyed even though the main OwLLM window is still alive.
static MAIN_WINDOW_CLOSE_REQUESTED: AtomicBool = AtomicBool::new(false);

/// The app's REAL version. Releases bump tauri.conf.json only (Cargo.toml sat
/// at 0.4.7 for ~40 releases), so anything user-visible must read the config —
/// env!("CARGO_PKG_VERSION") is the stale fallback.
pub static APP_VERSION: once_cell::sync::Lazy<String> = once_cell::sync::Lazy::new(|| {
    serde_json::from_str::<serde_json::Value>(include_str!("../tauri.conf.json"))
        .ok()
        .and_then(|v| {
            v.get("version")
                .and_then(|s| s.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
});

mod accounts;
mod agent_tools;
mod agents;
mod audio;
mod autostart;
mod bootstrap;
mod bridges;
mod browser;
mod browser_import;
mod browser_vault;
mod code;
mod crypt;
mod data_layer;
mod dialog;
mod directives;
mod discord;
mod documents;
mod email;
mod env_manager;
mod finetuning;
mod fleet;
mod gguf;
mod git;
mod github;
mod hardware;
mod huggingface;
mod kvm;
mod linux_updater;
mod mcp;
mod mcp_gateway;
mod media_assets;
mod memory;
mod models;
mod modules;
mod overlay_frame;
mod paths;
mod personal_agent_teams;
mod personal_agents;
mod projects;
mod pty;
mod readiness;
mod recommendations;
mod release;
mod remote_devices;
mod sandbox;
mod server;
mod signing;
mod skill_library;
mod slack;
mod state_mirror;
mod support;
mod sync_core;
mod telegram;
mod vault;
mod webhook;
mod wsl;
mod wsl_setup;

/// Log every panic to a crash file before it takes the process down. In a
/// windows-subsystem app stderr is invisible and a panic that unwinds out of
/// the event loop leaves NO trace (no WER entry, no dialog) — the window just
/// disappears. That exact "silent crash" was reported and was undiagnosable.
/// Mirrors the paths_debug fallback chain: %TEMP%, then %USERPROFILE%
/// (with $HOME and /tmp so the chain also resolves on Linux/macOS,
/// where TEMP and USERPROFILE don't exist and panics logged nothing).
fn install_crash_log_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let entry = format!(
            "[{}] panic on thread '{}': {}\nbacktrace:\n{}\n\n",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
            std::thread::current().name().unwrap_or("<unnamed>"),
            info,
            std::backtrace::Backtrace::force_capture(),
        );
        for base in [
            std::env::var_os("TEMP"),
            std::env::var_os("USERPROFILE"),
            std::env::var_os("HOME"),
            Some(std::ffi::OsString::from("/tmp")),
        ]
        .into_iter()
        .flatten()
        {
            let path = std::path::PathBuf::from(base).join("owllm-crash.log");
            use std::io::Write;
            let ok = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .and_then(|mut f| f.write_all(entry.as_bytes()));
            if ok.is_ok() {
                break;
            }
        }
        default(info);
    }));
}

/// WebKitGTK's DMA-BUF renderer has recurring failures with proprietary NVIDIA
/// drivers, including SIGBUS exits on Jetson/arm64. Disable only that renderer
/// before the GTK/WebKit process tree starts. WebKit's compositing mode must
/// stay enabled: forcing software compositing makes a small CSS animation
/// continuously repaint the whole window and saturate a CPU core.
#[cfg(target_os = "linux")]
fn configure_linux_webkit_renderer() {
    let has_nvidia_driver = std::path::Path::new("/proc/driver/nvidia/version").is_file()
        || std::path::Path::new("/sys/module/nvidia/version").exists();
    if !has_nvidia_driver {
        return;
    }
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    eprintln!("[owllm] NVIDIA Linux detected; WebKitGTK DMA-BUF renderer disabled");
}

#[cfg(not(target_os = "linux"))]
fn configure_linux_webkit_renderer() {}

/// WebKitGTK runs the page in a separate process. If that process is killed by
/// the renderer or its memory limit, keeping the native Tauri process alive
/// with a dead webview looks exactly like a random app crash. Record the native
/// reason and reload the page process; durable state is restored by main.tsx.
#[cfg(target_os = "linux")]
fn install_linux_webview_recovery(app: &tauri::App) {
    use tauri::Manager;
    use webkit2gtk::WebViewExt;

    let Some(main) = app.get_webview("main") else {
        eprintln!("[owllm] main WebKit view is unavailable; crash recovery was not installed");
        return;
    };
    if let Err(error) = main.with_webview(|platform| {
        platform
            .inner()
            .connect_web_process_terminated(|webview, reason| {
                let entry = format!(
                    "[{}] main WebKit process terminated: {reason:?}; reloading\n",
                    chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
                );
                let mut targets = paths::user_data_root()
                    .map(|root| vec![root.join("linux-webkit.log")])
                    .unwrap_or_default();
                targets.push(std::env::temp_dir().join("owllm-linux-webkit.log"));
                for target in targets {
                    use std::io::Write;
                    if std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&target)
                        .and_then(|mut file| file.write_all(entry.as_bytes()))
                        .is_ok()
                    {
                        break;
                    }
                }
                eprint!("[owllm] {entry}");
                if matches!(
                    reason,
                    webkit2gtk::WebProcessTerminationReason::Crashed
                        | webkit2gtk::WebProcessTerminationReason::ExceededMemoryLimit
                ) {
                    webview.reload();
                }
            });
    }) {
        eprintln!("[owllm] could not install WebKit process recovery: {error}");
    }
}

#[cfg(not(target_os = "linux"))]
fn install_linux_webview_recovery(_app: &tauri::App) {}

/// Fit the initial macOS window inside the usable laptop desktop. The default
/// 1400x960 window is taller than several Retina workspaces, so a centered,
/// undecorated window starts under both the menu bar and Dock. Keep it windowed
/// (the user explicitly did not want forced maximize), but reserve predictable
/// menu/Dock space and leave manual resizes alone after this one startup fit.
#[cfg(target_os = "macos")]
fn fit_macos_main_window(window: &tauri::Window) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static FIT_ONCE: AtomicBool = AtomicBool::new(false);
    if FIT_ONCE.swap(true, Ordering::SeqCst) {
        return;
    }

    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let scale = monitor.scale_factor();
    if !scale.is_finite() || scale <= 0.0 {
        return;
    }
    let monitor_size = monitor.size();
    let monitor_position = monitor.position();
    let screen_w = monitor_size.width as f64 / scale;
    let screen_h = monitor_size.height as f64 / scale;
    let screen_x = monitor_position.x as f64 / scale;
    let screen_y = monitor_position.y as f64 / scale;

    // 30px horizontal breathing room per side. Vertically, reserve the menu bar
    // plus a normal visible Dock; 40px from the top keeps custom chrome clear.
    let target_w = 1400.0_f64.min((screen_w - 60.0).max(1024.0));
    let target_h = 840.0_f64.min((screen_h - 170.0).max(640.0));
    let target_x = screen_x + ((screen_w - target_w) / 2.0).max(0.0);
    let target_y = screen_y + 40.0;

    let _ = window.set_size(tauri::LogicalSize::new(target_w, target_h));
    let _ = window.set_position(tauri::LogicalPosition::new(target_x, target_y));
}

#[cfg(not(target_os = "macos"))]
fn fit_macos_main_window(_window: &tauri::Window) {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if linux_updater::handle_startup_mode() {
        return;
    }
    install_crash_log_hook();
    configure_linux_webkit_renderer();
    // USB-portable Block 2: detect portable mode (env var or a portable.json
    // marker next to the exe) BEFORE the webview or any path helper runs, and
    // seed the whole env-override family so every data root lands on the stick.
    paths::init_portable_mode();
    // Both migrations must happen BEFORE WebView2 starts. In particular, the
    // legacy localStorage importer needs to copy/open old LevelDB stores while
    // no browser process holds their LOCK file. Keeping this inside setup()
    // made recovery work only when a developer repaired a machine manually.
    bootstrap::migrate_user_state_if_needed();
    state_mirror::import_legacy_webview_state_once();
    // WebView2 groups processes by profile rather than executable. A copied
    // local build must not join (and inherit a hang from) the installed app or
    // another checkout. Installed and portable profiles remain unchanged.
    paths::init_isolated_webview_profile();
    // SECURITY: neutralize a transplanted `.owllm` on launch. If the local
    // vault clone belongs to a different GitHub account than the one signed in,
    // this data folder was copied from someone else (portable stick, cloned
    // disk image, shared build) and carries THEIR API keys + synced vault.
    // Quarantine the inherited credentials and drop the foreign clone before any
    // window or sync runs — so an app UPDATE fixes an already-leaked install.
    vault::enforce_account_ownership_on_startup();
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            install_linux_webview_recovery(app);
            // Kill Windows' "ghost window" so a brief main-thread stall never
            // pops a stray "(Not Responding)" frame over the overlay chrome.
            overlay_frame::disable_window_ghosting();
            // One-time copy of LLM/data/* into %APPDATA%\OwLLM Desktop\
            // for users coming from the pre-restructure layout. Idempotent —
            // gated by a sentinel file inside the new root, so subsequent
            // launches no-op. Runs synchronously before any module that
            // touches the SQLite state so we don't end up with two parallel
            // DBs on first launch.
            // Seed OWLLM's built-in skill packs (e.g. parallel-dispatch) into the
            // user skills dir if absent, so they're visible + editable in Studio
            // and equippable. Never clobbers a user-edited copy.
            bootstrap::seed_builtin_skills();
            // A fresh install must always have somewhere to put a project, even
            // if the user closes onboarding without answering. Idempotent.
            projects::ensure_projects_root();
            // First run only: auto-download the curated skill libraries
            // (Anthropic + obra/superpowers) in the background so a fresh
            // install ships with a rich, equippable skill set. Gated by a
            // sentinel; retries on a later launch if git/network is unavailable.
            bootstrap::provision_curated_skills_first_run();
            personal_agent_teams::resume_pending(app.handle().clone());
            // Safe, no-risk disk housekeeping: if a WSL sandbox is already running
            // with large regenerable caches, trim them so the .vhdx doesn't balloon
            // unattended. Background + best-effort — never cold-starts WSL, never
            // blocks startup, no admin, no sparse (which modern WSL flags unsafe).
            std::thread::spawn(sandbox::auto_housekeep_startup);
            // Diagnostic: log the resolved paths on startup so missing
            // models / disappeared user state can be triaged without
            // F12 console acrobatics. Never write beside the executable:
            // on macOS that mutates the signed .app bundle and invalidates
            // its code signature after the first launch.
            let dbg = paths::paths_debug();
            if let Ok(s) = serde_json::to_string_pretty(&dbg) {
                let mut targets = paths::user_data_root()
                    .map(|root| vec![root.join("owllm-paths.log")])
                    .unwrap_or_default();
                targets.push(std::env::temp_dir().join("owllm-paths.log"));
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
            // Remote Devices: bring the LAN listener up now (if enabled) so the
            // launch-time vault sync publishes this device's record WITH its
            // dialable endpoints — lazy start left peers endpoint-less records.
            remote_devices::init(&app.handle());
            // Launch-at-login: self-register on first run (idempotent, per-user,
            // honors a prior explicit opt-out) so OwLLM comes back after a reboot
            // without the user re-launching it. Failures are logged and swallowed.
            autostart::ensure_default_enabled();
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
                linux_updater::confirm_successful_boot();
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
                        fit_macos_main_window(&dispatch_window);
                        // Main FIRST, overlay second: the frame arriving a
                        // beat late is invisible; the overlay arriving early
                        // (or unpainted) is the startup white flash.
                        let _ = dispatch_window.show();
                        let _ = overlay_frame::prepare_and_show_for_main(&dispatch_window);
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
            accounts::account_usage,
            accounts::usage_record,
            accounts::accounts_save_api_key,
            accounts::accounts_delete_secret,
            accounts::accounts_get_secret,
            accounts::accounts_test_probe,
            accounts::accounts_test_probe_wsl,
            accounts::claude_cli_complete,
            accounts::codex_cli_complete,
            accounts::accounts_prepare_cli_for_cwd,
            accounts::codex_cli_upgrade_for_cwd,
            accounts::codex_cli_stream,
            accounts::claude_cli_stream,
            accounts::kimi_cli_complete,
            accounts::kimi_cli_stream,
            accounts::gemini_cli_complete,
            accounts::grok_cli_complete,
            accounts::cli_cancel_all,
            accounts::subscription_cli_login,
            accounts::subscription_cli_logout,
            accounts::cli_install,
            accounts::cli_install_stream,
            accounts::accounts_test_probe_live,
            accounts::accounts_refresh_sandbox_creds,
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
            agents::sync_project_skills,
            personal_agents::personal_agent_list_profiles,
            personal_agents::personal_agent_get_profile,
            personal_agents::personal_agent_save_profile,
            personal_agents::personal_agent_list_skills,
            personal_agents::personal_agent_get_skill,
            personal_agents::personal_agent_validate_skill,
            personal_agents::personal_agent_save_skill,
            personal_agents::personal_agent_list_rule_cards,
            personal_agents::personal_agent_get_rule_card,
            personal_agents::personal_agent_save_rule_card,
            personal_agents::personal_agent_get_project_config,
            personal_agents::personal_agent_save_project_config,
            personal_agents::personal_agent_resolve,
            personal_agents::personal_agent_export,
            personal_agents::personal_agent_import,
            personal_agent_teams::personal_agent_team_list,
            personal_agent_teams::personal_agent_team_get,
            personal_agent_teams::personal_agent_team_save,
            personal_agent_teams::personal_agent_team_clone,
            personal_agent_teams::personal_agent_team_archive,
            personal_agent_teams::personal_agent_team_run_create,
            personal_agent_teams::personal_agent_team_run_get,
            personal_agent_teams::personal_agent_team_run_list,
            personal_agent_teams::personal_agent_team_run_events,
            personal_agent_teams::personal_agent_team_run_cancel,
            personal_agent_teams::personal_agent_team_run_recover,
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
            kvm::kvm_node_exec,
            kvm::kvm_node_consent,
            kvm::kvm_node_status,
            kvm::kvm_node_set_enabled,
            kvm::kvm_node_save,
            kvm::kvm_node_list,
            kvm::kvm_node_delete,
            remote_devices::device_get_identity,
            remote_devices::device_get_id,
            remote_devices::device_set_name,
            remote_devices::device_remote_enabled_get,
            remote_devices::device_remote_enabled_set,
            remote_devices::device_listener_status,
            remote_devices::devices_list,
            remote_devices::device_forget,
            remote_devices::device_trust_list,
            remote_devices::device_request_pairing,
            remote_devices::device_pair_by_address,
            remote_devices::device_pairing_approve,
            remote_devices::device_pairing_deny,
            remote_devices::device_trust_revoke,
            remote_devices::device_trust_remove,
            remote_devices::device_trust_set_policy,
            remote_devices::device_send,
            remote_devices::device_session_open,
            remote_devices::device_session_write,
            remote_devices::device_session_read,
            remote_devices::device_session_resize,
            remote_devices::device_session_close,
            remote_devices::device_agents_allowed_get,
            remote_devices::device_set_agents_allowed,
            remote_devices::device_save_screenshot,
            remote_devices::device_pending_approvals,
            remote_devices::device_approve_action,
            remote_devices::device_deny_action,
            remote_devices::device_sync_discovery,
            remote_devices::device_set_public_endpoint,
            remote_devices::device_set_relay,
            remote_devices::device_relay_serve,
            remote_devices::device_relay_stop,
            remote_devices::device_relay_status,
            remote_devices::device_cancel,
            remote_devices::device_control_state,
            remote_devices::device_stop_remote_control,
            remote_devices::device_audit_tail,
            remote_devices::device_selftest,
            vault::vault_sync_devices,
            browser::browser_ensure,
            browser::browser_start,
            browser::browser_open_url,
            browser::browser_open_tab,
            browser::browser_open_auth_tab,
            browser::browser_list_tabs,
            browser::browser_session_bind,
            browser::browser_session_reopen,
            browser::browser_reopen_closed,
            browser::browser_select_tab,
            browser::browser_close_tab,
            browser::browser_cmd,
            browser::browser_stop,
            browser::browser_status,
            browser::browser_view,
            browser::browser_focus,
            browser::browser_arrange,
            browser::browser_set_device,
            browser::browser_set_chrome,
            browser_vault::browser_vault_list,
            browser_vault::browser_vault_add,
            browser_vault::browser_vault_delete,
            browser_vault::browser_vault_autofill,
            browser_import::browser_import_scan,
            browser_import::browser_import_run,
            browser_import::browser_import_csv,
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
            directives::directives_restore_defaults,
            directives::project_set_director_mode,
            directives::project_get_director_mode,
            state_mirror::state_mirror_load,
            state_mirror::state_mirror_save,
            state_mirror::state_mirror_ack_recovery,
            fleet::path_is_dir,
            fleet::fleet_worktree_create,
            fleet::fleet_worktree_finalize,
            fleet::fleet_worktree_diff,
            fleet::fleet_worktree_merge,
            fleet::fleet_worktree_remove,
            fleet::fleet_cleanup_orphans,
            fleet::fleet_repo_init,
            fleet::fleet_head_files,
            hardware::hardware_info,
            hardware::vram_status,
            hardware::set_gpu_selection,
            models::list_models,
            overlay_frame::overlay_frame_enabled,
            overlay_frame::overlay_frame_set_visible,
            overlay_frame::overlay_frame_set_accent,
            overlay_frame::overlay_frame_capture_geometry,
            projects::list_projects,
            projects::projects_root_get,
            projects::projects_root_set,
            projects::create_project,
            projects::resolve_project_for_location,
            projects::update_project,
            projects::delete_project,
            memory::agent_memory_get,
            memory::agent_memory_append,
            memory::agent_memory_clear,
            memory::team_memory_write,
            memory::team_memory_log,
            memory::team_memory_search,
            release::publish_release,
            release::finish_and_publish,
            release::publish_readiness,
            release::repo_commit,
            release::repo_push,
            release::repo_merge,
            release::repo_sync,
            memory::team_memory_read,
            memory::team_memory_delete,
            memory::team_memory_promote,
            server::server_status,
            server::server_start,
            server::server_stop,
            autostart::autostart_get,
            autostart::autostart_set,
            server::inference_expose_get,
            server::inference_expose_set,
            skill_library::list_skill_sources,
            skill_library::fetch_skill_source,
            skill_library::discover_skills,
            skill_library::install_skill,
            skill_library::uninstall_skill,
            skill_library::list_installed_skill_folders,
            skill_library::read_skill_md,
            media_assets::media_assets_list,
            media_assets::media_assets_get,
            media_assets::media_assets_update,
            media_assets::media_assets_import,
            media_assets::media_assets_delete,
            media_assets::media_assets_ensure_dir,
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
            huggingface::models_partial_files,
            huggingface::models_interrupted_downloads,
            huggingface::delete_model_weight,
            recommendations::models_recommended,
            paths::shell_open_url,
            paths::update_install_mode,
            linux_updater::linux_appimage_update_install,
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
            documents::document_extract,
            documents::document_open,
            documents::document_save_text,
            documents::document_copy,
            documents::document_export_text,
            finetuning::dataset_save,
            finetuning::dataset_default_dir,
            finetuning::abliterate_start,
            finetuning::export_gguf,
            finetuning::hf_dir_weight_bytes,
            agent_tools::chat_scratch_dir,
            agent_tools::fetch_remote_text,
            agent_tools::tool_read_file,
            agent_tools::tool_write_file,
            agent_tools::copy_into_workspace,
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
            github::github_create_repo,
            github::github_repo_url,
            github::github_list_repositories,
            github::github_clone_project,
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
            vault::vault_sync_signing,
            signing::signing_status,
            signing::signing_apple_save,
            signing::signing_apple_import_p12,
            signing::signing_apple_import_cert,
            signing::signing_apple_gen_csr,
            signing::signing_windows_save,
            signing::signing_clear,
            signing::signing_export_env,
            signing::signing_push_github,
            signing::signing_agent_get,
            signing::signing_hub_status,
            signing::signing_portal_open,
            sandbox::sandbox_status,
            sandbox::agent_save_inbox_images,
            sandbox::agent_full_access_get,
            sandbox::agent_full_access_set,
            sandbox::sandbox_harden,
            sandbox::sandbox_disk_usage,
            sandbox::sandbox_clear_caches,
            sandbox::sandbox_reclaim_disk,
            sandbox::sandbox_enable_sparse,
            sandbox::sandbox_trim,
            sandbox::sandbox_create_project,
            sandbox::sandbox_list_projects,
            sandbox::sandbox_provision,
            sandbox::sandbox_sync_logins,
            sandbox::sandbox_warm_and_check,
            sandbox::sandbox_login_status,
            sandbox::sandbox_convert_project,
            mcp::mcp_load_config,
            mcp::mcp_save_config,
            mcp::mcp_start_server,
            mcp::mcp_stop_server,
            mcp::mcp_list_servers,
            mcp::mcp_list_all_tools,
            mcp::mcp_search_capabilities,
            mcp::mcp_install_curated,
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
                    MAIN_WINDOW_CLOSE_REQUESTED.store(true, Ordering::SeqCst);
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
                tauri::RunEvent::ExitRequested { code, api, .. }
                    if code.is_none()
                        && !MAIN_WINDOW_CLOSE_REQUESTED.load(Ordering::SeqCst)
                        && app.get_window("main").is_some() =>
                {
                    // An auxiliary window or its renderer disappeared. The
                    // main window is still registered and the user did not
                    // close it, so accepting this request would turn a tab
                    // failure into a clean whole-app exit.
                    eprintln!("[owllm] prevented auxiliary-window failure from exiting the app");
                    api.prevent_exit();
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
