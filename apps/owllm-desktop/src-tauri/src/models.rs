// Model registry — reads LLM/configs/llm_backends.yaml.
//
// Schema (matches the legacy PySide6 app):
//
//   models:
//     <model_id>:
//       base_model: <path-to-model-dir>
//       adapter_dir: <path-or-null>
//       model_type: instruct | base
//       port: <int>
//       system_prompt: <string>
//       use_4bit: <bool>
//
// The React UI cares about model_id + port + base_model. The other
// fields are kept available for future native commands (e.g. when
// the React Server-config row exposes 4-bit toggle).

use crate::paths;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct ModelInfo {
    pub model_id: String,
    pub port: Option<u16>,
    pub base_model: Option<String>,
}

#[derive(Debug, Deserialize)]
struct YamlRoot {
    #[serde(default)]
    models: BTreeMap<String, YamlEntry>,
}

#[derive(Debug, Deserialize)]
struct YamlEntry {
    #[serde(default)]
    base_model: Option<String>,
    #[serde(default)]
    port: Option<u16>,
}

#[tauri::command]
pub async fn list_models() -> Result<Vec<ModelInfo>, String> {
    let path = match paths::config_file() {
        Some(p) => p,
        None => return Ok(Vec::new()), // config not found -> empty registry
    };
    let raw = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let root: YamlRoot = serde_yaml::from_str(&raw)
        .map_err(|e| format!("parse {}: {e}", path.display()))?;

    // BTreeMap gives stable alphabetical order; React displays them
    // sorted by model_id which is what the user expects.
    let out = root
        .models
        .into_iter()
        .map(|(id, entry)| ModelInfo {
            model_id: id,
            port: entry.port,
            base_model: entry.base_model,
        })
        .collect();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_yaml() {
        let yaml = r#"
models:
  default:
    base_model: C:/models/phi-4
    port: 10505
  phi4_assistant:
    base_model: C:/models/phi-4
    port: 10501
"#;
        let root: YamlRoot = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(root.models.len(), 2);
        assert_eq!(root.models["default"].port, Some(10505));
        assert_eq!(
            root.models["phi4_assistant"].base_model.as_deref(),
            Some("C:/models/phi-4")
        );
    }

    #[test]
    fn parses_real_world_entry_with_extra_fields() {
        // Mirrors a representative entry from
        // LLM/configs/llm_backends.yaml — the extras must be ignored.
        let yaml = r#"
models:
  nvidia_Llama-3.1-Nemotron-Nano-8B-v1:
    adapter_dir: null
    base_model: C:\\models\\nvidia_Llama-3.1
    model_type: base
    port: 10502
    system_prompt: ''
    use_4bit: true
"#;
        let root: YamlRoot = serde_yaml::from_str(yaml).unwrap();
        let e = &root.models["nvidia_Llama-3.1-Nemotron-Nano-8B-v1"];
        assert_eq!(e.port, Some(10502));
        assert!(e.base_model.as_deref().unwrap().contains("nvidia_Llama"));
    }
}
