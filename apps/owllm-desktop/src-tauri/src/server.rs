// Model-server lifecycle — native Rust. Stub today; next pass spawns
// llama.cpp (or Ollama) from `tokio::process::Command` with
// `creation_flags(CREATE_NO_WINDOW)` on Windows so the child never
// pops a console. State (child PID, port, status) lives in a Tauri
// `tauri::State` Mutex so the four commands share one source of
// truth.

use serde::Serialize;

#[derive(Default, Serialize, Clone)]
pub struct ServerStatus {
    pub running: bool,
    pub model_id: Option<String>,
    pub port: Option<u16>,
    pub message: String,
}

#[tauri::command]
pub async fn server_status() -> Result<ServerStatus, String> {
    Ok(ServerStatus {
        running: false,
        model_id: None,
        port: None,
        message: "Not running (server spawn pending Rust impl).".to_string(),
    })
}

#[tauri::command]
pub async fn server_start(_model_id: String) -> Result<(), String> {
    Err(
        "server_start: native Rust impl pending. Will spawn llama.cpp with CREATE_NO_WINDOW."
            .to_string(),
    )
}

#[tauri::command]
pub async fn server_stop() -> Result<(), String> {
    Ok(())
}
