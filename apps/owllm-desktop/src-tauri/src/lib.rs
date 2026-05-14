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

mod hardware;
mod models;
mod paths;
mod server;

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
            hardware::hardware_info,
            models::list_models,
            server::server_status,
            server::server_start,
            server::server_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OwLLM Desktop");
}
