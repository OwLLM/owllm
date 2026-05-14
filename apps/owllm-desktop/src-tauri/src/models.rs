// Model registry — native Rust. Stub today (empty list); next pass
// will scan a known models directory (a path that lives in user
// config) and emit a `ModelInfo` per JSON entry it finds.
//
// Shape matches what ServerPage.tsx already reads: { model_id, port,
// base_model }. Renaming the React side later is fine; renaming now
// would churn the page for no gain.

use serde::{Deserialize, Serialize};

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct ModelInfo {
    pub model_id: String,
    pub port: Option<u16>,
    pub base_model: Option<String>,
}

#[tauri::command]
pub async fn list_models() -> Result<Vec<ModelInfo>, String> {
    Ok(Vec::new())
}
