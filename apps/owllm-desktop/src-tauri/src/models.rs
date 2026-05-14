// Model registry — scans LLM/models/**/*.gguf and returns one
// ModelInfo per discovered GGUF.
//
// Why disk-scan instead of reading llm_backends.yaml?
// The legacy yaml's `base_model` field points to TRANSFORMERS-style
// model directories (bnb-4bit, BF16 transformers shards) — that's
// what the Python serving path consumed via vLLM/transformers. The
// new Rust runtime calls llama-server.exe, which loads *.gguf files
// only. Reading the yaml would hand llama-server invalid paths and
// every Start would silently fail.
//
// model_id   = the gguf filename without extension (stable, sortable)
// base_model = absolute path to the .gguf (what llama-server --model wants)
// port       = deterministic 10500 + sorted index, so the same set of
//              files always assigns the same ports across runs.

use crate::paths;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct ModelInfo {
    pub model_id: String,
    pub port: Option<u16>,
    pub base_model: Option<String>,
    /// Size of the GGUF in MiB. Useful for the Models page so the
    /// user can sort by disk footprint without a separate stat call.
    pub size_mib: Option<u64>,
    /// Which backend serves this model. "local" → llama-server.exe
    /// on the assigned port; "anthropic" → api.anthropic.com (needs
    /// ANTHROPIC_API_KEY); "openai" → api.openai.com (needs
    /// OPENAI_API_KEY). The React dispatch loop branches on this to
    /// choose the right endpoint + request shape.
    #[serde(default)]
    pub provider: String,
}

#[tauri::command]
pub async fn list_models() -> Result<Vec<ModelInfo>, String> {
    let mut out: Vec<ModelInfo> = Vec::new();

    // Local GGUFs first — these are what the running server actually
    // ships today. The Server tab can start any of them.
    if let Some(root) = paths::llm_root() {
        let models_dir = root.join("models");
        if models_dir.is_dir() {
            let mut found: Vec<PathBuf> = Vec::new();
            walk_gguf(&models_dir, &mut found, 0);
            found.sort();
            let base_port: u16 = 10500;
            for (i, path) in found.into_iter().enumerate() {
                let id = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("unknown")
                    .to_string();
                let size_mib = std::fs::metadata(&path)
                    .ok()
                    .map(|m| m.len() / 1024 / 1024);
                out.push(ModelInfo {
                    model_id: id,
                    port: Some(base_port.saturating_add(i as u16)),
                    base_model: Some(path.to_string_lossy().into_owned()),
                    size_mib,
                    provider: "local".to_string(),
                });
            }
        }
    }

    // Cloud models — ALWAYS surfaced so the user can see Claude / GPT
    // options in the agent dropdowns even before saving a key. If they
    // pick one without the matching credentials saved, the dispatch
    // loop will surface a clear error pointing them at the Accounts
    // page. Hiding the options behind a credentials check (the prior
    // behaviour) made it look like the feature was missing.
    for id in [
        "claude-opus-4-7",
        "claude-sonnet-4-6",
        "claude-haiku-4-5-20251001",
    ] {
        out.push(ModelInfo {
            model_id: id.to_string(),
            port: None,
            base_model: None,
            size_mib: None,
            provider: "anthropic".to_string(),
        });
    }
    for id in [
        "gpt-5",
        "gpt-5-mini",
        "gpt-4.1",
        "gpt-4o",
        "gpt-4o-mini",
    ] {
        out.push(ModelInfo {
            model_id: id.to_string(),
            port: None,
            base_model: None,
            size_mib: None,
            provider: "openai".to_string(),
        });
    }

    Ok(out)
}

/// Recursive directory walk, bounded so a misconfigured symlink loop
/// can't hang the UI. 6 levels matches the legacy
/// `<vendor>/<repo>/<quant>/<shard>/file.gguf` layout with headroom.
fn walk_gguf(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 6 {
        return;
    }
    let Ok(read) = std::fs::read_dir(dir) else { return };
    for entry in read.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_gguf(&path, out, depth + 1);
        } else if path.extension().and_then(|s| s.to_str()) == Some("gguf") {
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase();
            // Skip companion files that llama-server.exe can't serve
            // standalone: mmproj-* (vision projectors) and *-lora-*
            // (adapter weights — need a base --model to merge into).
            if stem.starts_with("mmproj") || stem.contains("-lora-") {
                continue;
            }
            out.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn walk_skips_mmproj_and_finds_gguf() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("vendorA/repo/model.gguf");
        let b = tmp.path().join("vendorB/repo/main-Q4.gguf");
        let mmproj = tmp.path().join("vendorB/repo/mmproj-F16.gguf");
        for f in [&a, &b, &mmproj] {
            fs::create_dir_all(f.parent().unwrap()).unwrap();
            fs::write(f, b"x").unwrap();
        }
        let mut found = Vec::new();
        walk_gguf(tmp.path(), &mut found, 0);
        found.sort();
        assert_eq!(found.len(), 2);
        assert!(found.iter().any(|p| p == &a));
        assert!(found.iter().any(|p| p == &b));
        assert!(!found.contains(&mmproj));
    }

    #[test]
    fn walk_respects_depth_cap() {
        let tmp = tempfile::tempdir().unwrap();
        // 8 levels deep — past the cap of 6.
        let deep = tmp.path().join("a/b/c/d/e/f/g/h/leaf.gguf");
        fs::create_dir_all(deep.parent().unwrap()).unwrap();
        fs::write(&deep, b"x").unwrap();
        let mut found = Vec::new();
        walk_gguf(tmp.path(), &mut found, 0);
        // The file IS at depth 9 from tmp; our cap of 6 stops the walk
        // before reaching it. (A regression that removed the cap would
        // find it.)
        assert!(!found.contains(&deep));
    }
}
