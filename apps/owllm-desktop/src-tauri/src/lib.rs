mod engine_client;
mod supervisor;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct EngineSupervisor {
    inner: Mutex<supervisor::Supervisor>,
}

#[derive(Clone, Serialize)]
pub(crate) struct EngineLogEvent {
    stream: String,
    line: String,
}

#[tauri::command]
async fn engine_start(app: AppHandle, sup: tauri::State<'_, EngineSupervisor>) -> Result<(), String> {
    sup.inner.lock().await.start(app).await
}

#[tauri::command]
async fn engine_stop(sup: tauri::State<'_, EngineSupervisor>) -> Result<(), String> {
    sup.inner.lock().await.stop().await
}

#[tauri::command]
async fn engine_get(
    app: AppHandle,
    path: String,
    sup: tauri::State<'_, EngineSupervisor>,
) -> Result<String, String> {
    sup.inner.lock().await.ensure_or_start(app).await?;
    engine_client::engine_get(&path).await
}

#[tauri::command]
async fn engine_post(
    app: AppHandle,
    path: String,
    body: String,
    sup: tauri::State<'_, EngineSupervisor>,
) -> Result<String, String> {
    sup.inner.lock().await.ensure_or_start(app).await?;
    engine_client::engine_post(&path, &body).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(EngineSupervisor::default())
        .invoke_handler(tauri::generate_handler![engine_start, engine_stop, engine_get, engine_post])
        .setup(|app| {
            // Convenience: auto-start engine in dev unless explicitly disabled.
            let disable = std::env::var("OWLLM_DISABLE_ENGINE_AUTOSTART").unwrap_or_default() == "1";
            if !disable {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let app_for_start = app_handle.clone();
                    let result = {
                        let sup = app_handle.state::<EngineSupervisor>();
                        let x = sup.inner.lock().await.start(app_for_start).await;
                        x
                    };
                    if let Err(e) = result {
                        eprintln!("[owllm-desktop] engine autostart failed: {e}");
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running OwLLM Desktop");
}
