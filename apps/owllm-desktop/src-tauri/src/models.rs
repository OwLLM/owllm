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
    /// Which backend serves this model. "local" → base GGUFs in
    /// LLM/models/ served by llama-server.exe; "tuned" → user-tuned
    /// or abliterated models in LLM/fine_tuned/ (also local, but
    /// kept distinct so the picker can group them under a "TUNED
    /// (LOCAL)" header); "anthropic" → api.anthropic.com (needs
    /// ANTHROPIC_API_KEY); "openai" → api.openai.com (needs
    /// OPENAI_API_KEY); "moonshot" → api.moonshot.ai/v1 (needs
    /// MOONSHOT_API_KEY). The React dispatch loop branches on this
    /// to choose the right endpoint + request shape.
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
            let mut gguf_parent_dirs: std::collections::HashSet<PathBuf> =
                std::collections::HashSet::new();
            for (i, path) in found.into_iter().enumerate() {
                let id = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("unknown")
                    .to_string();
                let size_mib = std::fs::metadata(&path)
                    .ok()
                    .map(|m| m.len() / 1024 / 1024);
                if let Some(parent) = path.parent() {
                    gguf_parent_dirs.insert(parent.to_path_buf());
                }
                out.push(ModelInfo {
                    model_id: id,
                    port: Some(base_port.saturating_add(i as u16)),
                    base_model: Some(path.to_string_lossy().into_owned()),
                    size_mib,
                    provider: "local".to_string(),
                });
            }

            // Transformers / safetensors directories — onboarded models
            // that are NOT GGUF. Surfacing them here so the Chat picker
            // matches the Models page row count. They have no port
            // because llama-server.exe can't serve them; the Chat send
            // path will error clearly if the user picks one without a
            // vLLM/transformers backend.
            let mut hf_dirs: Vec<PathBuf> = Vec::new();
            walk_transformers_dirs(&models_dir, &mut hf_dirs, 0, &gguf_parent_dirs);
            hf_dirs.sort();
            for path in hf_dirs {
                let id = path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("unknown")
                    .to_string();
                let size_mib = dir_weight_size_mib(&path);
                out.push(ModelInfo {
                    model_id: id,
                    port: None,
                    base_model: Some(path.to_string_lossy().into_owned()),
                    size_mib,
                    provider: "local".to_string(),
                });
            }
        }
    }

    // Tuned / abliterated local weights live in LLM/fine_tuned/ and
    // are surfaced under their own "TUNED (LOCAL)" group in the
    // picker — same llama-server path, separate label so the user
    // doesn't confuse a 14B abliterated dir with a downloaded base.
    // Tuned .gguf files get their own port range (10600+) so
    // server_start can launch them like any other local model — the
    // previous (port: None) version failed with "no port in config".
    if let Some(root) = paths::llm_root() {
        let tuned_root = root.join("fine_tuned");
        if tuned_root.is_dir() {
            let tuned_base_port: u16 = 10600;
            let mut tuned_gguf_idx: u16 = 0;
            if let Ok(read) = std::fs::read_dir(&tuned_root) {
                let mut tuned_entries: Vec<PathBuf> = read.flatten().map(|e| e.path()).collect();
                tuned_entries.sort();
                for p in tuned_entries {
                    let name = match p.file_name().and_then(|s| s.to_str()) {
                        Some(n) => n.to_string(),
                        None => continue,
                    };
                    if name.starts_with('.') || name.starts_with("checkpoint-") || name == "_crash_logs" {
                        continue;
                    }
                    if p.is_dir() {
                        // The directory itself (transformers format).
                        // No port — llama-server can't serve a
                        // transformers dir; the user has to GGUF-export
                        // first. The picker's hint already encodes that
                        // by leaving the port field blank.
                        let size_mib = dir_weight_size_mib(&p);
                        out.push(ModelInfo {
                            model_id: name.clone(),
                            port: None,
                            base_model: Some(p.to_string_lossy().into_owned()),
                            size_mib,
                            provider: "tuned".to_string(),
                        });
                        // Any .gguf one level deep is its own pickable
                        // entry with an assigned port so the Server
                        // tab can launch it directly.
                        let mut inner_files: Vec<PathBuf> = Vec::new();
                        if let Ok(inner) = std::fs::read_dir(&p) {
                            for f in inner.flatten() {
                                let fp = f.path();
                                if fp.is_file() {
                                    inner_files.push(fp);
                                }
                            }
                        }
                        inner_files.sort();
                        for fp in inner_files {
                            let ext = fp.extension().and_then(|s| s.to_str()).unwrap_or("");
                            if !ext.eq_ignore_ascii_case("gguf") { continue; }
                            let fname = fp
                                .file_stem()
                                .and_then(|s| s.to_str())
                                .unwrap_or("model")
                                .to_string();
                            let fsize = std::fs::metadata(&fp).ok().map(|m| m.len() / 1024 / 1024);
                            let port = tuned_base_port.saturating_add(tuned_gguf_idx);
                            tuned_gguf_idx = tuned_gguf_idx.saturating_add(1);
                            out.push(ModelInfo {
                                model_id: fname,
                                port: Some(port),
                                base_model: Some(fp.to_string_lossy().into_owned()),
                                size_mib: fsize,
                                provider: "tuned".to_string(),
                            });
                        }
                    }
                }
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
    // GPT-5.4 family replaces the previous gpt-5 entries (gpt-5 retired
    // when 5.4 + 5.5 went GA in 2026). 5.5 / 5.5-codex stay below for
    // the new Codex CLI subscription line.
    for id in [
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5.4-nano",
        "gpt-5.5-codex",
        "gpt-5.5",
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
    // Moonshot AI / Kimi — OpenAI-compatible API. The older
    // kimi-k2-* preview ids are being discontinued 2026-05-25 by
    // Moonshot; we ship only the current K2.5 + K2.6 line plus the
    // stable Moonshot V1 128K context fallback.
    for id in [
        "kimi-k2.6",
        "kimi-k2.5",
        "moonshot-v1-128k",
    ] {
        out.push(ModelInfo {
            model_id: id.to_string(),
            port: None,
            base_model: None,
            size_mib: None,
            provider: "moonshot".to_string(),
        });
    }
    // DeepSeek API (api.deepseek.com).
    for id in ["deepseek-v4-pro", "deepseek-v4-flash"] {
        out.push(ModelInfo { model_id: id.into(), port: None, base_model: None, size_mib: None, provider: "deepseek".into() });
    }
    // xAI Grok (api.x.ai). grok-4.3 is the May 2026 flagship; older
    // ids redirect to it server-side.
    for id in ["grok-4.3", "grok-4.20", "grok-4.1-fast"] {
        out.push(ModelInfo { model_id: id.into(), port: None, base_model: None, size_mib: None, provider: "xai".into() });
    }
    // Groq LPU (api.groq.com) — fastest inference for open models.
    for id in [
        "llama-3.3-70b-versatile",
        "llama-4-scout",
        "qwen3-32b",
        "deepseek-r1-distill-llama-70b",
        "gpt-oss-120b",
    ] {
        out.push(ModelInfo { model_id: id.into(), port: None, base_model: None, size_mib: None, provider: "groq".into() });
    }
    // Perplexity Sonar (api.perplexity.ai) — built-in web search.
    for id in ["sonar-pro", "sonar", "sonar-reasoning"] {
        out.push(ModelInfo { model_id: id.into(), port: None, base_model: None, size_mib: None, provider: "perplexity".into() });
    }
    // Mistral (api.mistral.ai).
    for id in ["mistral-large-latest", "magistral-medium-latest", "codestral-latest", "mistral-small-latest"] {
        out.push(ModelInfo { model_id: id.into(), port: None, base_model: None, size_mib: None, provider: "mistral".into() });
    }
    // Together AI (api.together.xyz) — open-source model host. Top 5
    // popular options; users can plug exact IDs later.
    for id in [
        "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        "Qwen/Qwen2.5-72B-Instruct-Turbo",
        "deepseek-ai/DeepSeek-V3",
        "mistralai/Mixtral-8x22B-Instruct-v0.1",
    ] {
        out.push(ModelInfo { model_id: id.into(), port: None, base_model: None, size_mib: None, provider: "together".into() });
    }
    // Google Gemini (generativelanguage.googleapis.com).
    for id in ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"] {
        out.push(ModelInfo { model_id: id.into(), port: None, base_model: None, size_mib: None, provider: "gemini".into() });
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

/// Walk for transformers-style model directories — any dir containing
/// a `config.json` AND at least one .safetensors / .bin shard, that
/// isn't already represented by a GGUF entry. Bounded depth like
/// walk_gguf to keep the UI responsive.
fn walk_transformers_dirs(
    dir: &Path,
    out: &mut Vec<PathBuf>,
    depth: usize,
    skip: &std::collections::HashSet<PathBuf>,
) {
    if depth > 6 {
        return;
    }
    let Ok(read) = std::fs::read_dir(dir) else { return };
    let mut has_config = false;
    let mut has_weights = false;
    for entry in read.flatten() {
        let path = entry.path();
        if path.is_file() {
            let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if name == "config.json" {
                has_config = true;
            } else {
                let lower = name.to_lowercase();
                if lower.ends_with(".safetensors") || lower.ends_with(".bin") {
                    has_weights = true;
                }
            }
        }
    }
    if has_config && has_weights && !skip.contains(dir) {
        out.push(dir.to_path_buf());
        return;
    }
    let Ok(read2) = std::fs::read_dir(dir) else { return };
    for entry in read2.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_transformers_dirs(&path, out, depth + 1, skip);
        }
    }
}

/// Sum the *.safetensors / *.bin sizes in a directory (one level
/// deep) so the picker can show a meaningful "GiB" hint.
fn dir_weight_size_mib(dir: &Path) -> Option<u64> {
    let read = std::fs::read_dir(dir).ok()?;
    let mut total: u64 = 0;
    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        if name.ends_with(".safetensors") || name.ends_with(".bin") {
            if let Ok(m) = std::fs::metadata(&path) {
                total += m.len() / 1024 / 1024;
            }
        }
    }
    if total > 0 { Some(total) } else { None }
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
