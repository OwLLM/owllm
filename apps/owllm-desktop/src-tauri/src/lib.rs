// OwLLM Desktop — Rust + React. NO Python at runtime.
//
// History note (2026-05-14): an earlier draft of this shell spawned a
// long-running Python HTTP server (`python_engine`) at startup and
// proxied every Tauri command to it. That drifted from the
// agreed-upon architecture — Rust+React is the runtime, Python is
// invited ONLY as an on-demand guest for fine-tuning and per-model
// venv bootstrap. The supervisor + engine_client modules have been
// deleted; this file now defines the small Rust-native command
// surface the React UI talks to directly.
//
// What lives here today:
//   * list_models / server_status / server_start / server_stop —
//     stubs returning empty/default state. These will be implemented
//     as native Rust (file scan, subprocess spawn with
//     CREATE_NO_WINDOW, NVML/wmic probes) without ever touching
//     Python.
//   * hardware_info — placeholder, same plan.
//
// What does NOT live here:
//   * Any code that spawns Python at startup.
//   * Any HTTP client talking to localhost:18765.
//   * Any embed of the LLM/ tree.

use serde::{Deserialize, Serialize};

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct ModelInfo {
    pub model_id: String,
    pub port: Option<u16>,
    pub base_model: Option<String>,
}

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct ServerStatus {
    pub running: bool,
    pub model_id: Option<String>,
    pub port: Option<u16>,
    pub message: String,
}

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct HardwareInfo {
    pub cpu_name: String,
    pub cpu_cores: u32,
    pub ram_gb: f64,
    pub gpus: Vec<GpuInfo>,
}

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct GpuInfo {
    pub index: u32,
    pub name: String,
    pub vram_gb: f64,
}

/// List configured models. Currently a stub returning an empty list;
/// next pass will scan a known models directory and return real
/// metadata. Native Rust — no Python.
#[tauri::command]
async fn list_models() -> Result<Vec<ModelInfo>, String> {
    Ok(Vec::new())
}

/// Current model-server status. Stub; next pass tracks the spawned
/// llama.cpp/Ollama child PID natively.
#[tauri::command]
async fn server_status() -> Result<ServerStatus, String> {
    Ok(ServerStatus {
        running: false,
        model_id: None,
        port: None,
        message: "Not running (server spawn is not yet implemented in Rust)".to_string(),
    })
}

/// Start the model server for the given model id. Stub; next pass
/// spawns the llama.cpp binary with CREATE_NO_WINDOW so no console
/// pops on Windows.
#[tauri::command]
async fn server_start(_model_id: String) -> Result<(), String> {
    Err("server_start: native Rust implementation pending. Will spawn llama.cpp with CREATE_NO_WINDOW.".to_string())
}

/// Stop the running model server. Stub — no spawned child to kill yet.
#[tauri::command]
async fn server_stop() -> Result<(), String> {
    Ok(())
}

/// Hardware probe. Stub; next pass uses sysinfo crate + NVML for GPU.
#[tauri::command]
async fn hardware_info() -> Result<HardwareInfo, String> {
    Ok(HardwareInfo::default())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_models,
            server_status,
            server_start,
            server_stop,
            hardware_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OwLLM Desktop");
}
