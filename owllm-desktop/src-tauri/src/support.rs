// The Watcher — app-context snapshot for the in-app support assistant.
//
// COMPOSES existing probes only (readiness, hardware, server supervisor,
// WSL setup stage, module manager) — no parallel diagnostics system.
// Everything returned here is non-secret by construction: no API keys,
// no prompt/file contents, no auth material; paths are limited to none.
// The frontend Watcher merges in UI-side context (current page, project)
// before showing it to the user.

use serde::Serialize;
use tauri::Manager;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SupportSnapshot {
    pub app_version: String,
    pub os: String,
    pub arch: String,
    pub cpu: String,
    pub gpus: Vec<String>,
    pub ram_total_gb: f64,
    /// The Home page's real readiness rows (WSL / GPU / env / runtime).
    pub readiness: crate::readiness::AppReadiness,
    /// Local model-server supervisor state (running / model / crash cause).
    pub server: crate::server::ServerStatus,
    /// Guided-WSL-setup stage + detail ("ready", "needsUser", …).
    pub wsl_stage: String,
    pub wsl_detail: String,
    /// Installed module ids (e.g. local-inference, python-runtime).
    pub modules: Vec<String>,
}

#[tauri::command]
pub async fn support_snapshot(app: tauri::AppHandle) -> Result<SupportSnapshot, String> {
    let readiness = crate::readiness::app_readiness().await.unwrap_or_default();
    let hw = crate::hardware::hardware_info().await.unwrap_or_default();
    let server = {
        let st = app.state::<crate::server::ServerState>();
        crate::server::server_status(st).await.unwrap_or_default()
    };
    let wsl = crate::wsl_setup::wsl_setup_status();
    let modules = crate::modules::module_list(app.clone())
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|m| matches!(m.state, crate::modules::ModuleState::Installed | crate::modules::ModuleState::UpdateAvailable))
        .map(|m| m.id)
        .collect();
    Ok(SupportSnapshot {
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        cpu: hw.cpu_name.clone(),
        gpus: hw.gpus.iter().map(|g| g.name.clone()).collect(),
        ram_total_gb: hw.ram_total_gb,
        readiness,
        server,
        wsl_stage: wsl.stage,
        wsl_detail: wsl.detail,
        modules,
    })
}
