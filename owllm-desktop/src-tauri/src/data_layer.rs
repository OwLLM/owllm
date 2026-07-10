//! Data layer — hot-reloadable JSON/YAML from the repo.
//!
//! Per the design in `data/modules/SCHEMA.md`, files under `data/` in the
//! repo (team templates, role prompts, model sampling profiles, MCP
//! server recommendations, abliteration prompt corpora, etc.) are pulled
//! at runtime from `raw.githubusercontent.com` and cached on disk. They
//! update by pushing to `main` — no release cycle, no shell rebuild.
//!
//! The memory note "Model-handling layer MUST be post-ship updatable"
//! is what this enables: sampling configs, tool protocols, prompts,
//! retry budgets live as data here and refresh on every launch.

use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};

const RAW_BASE: &str = "https://raw.githubusercontent.com/OwLLM/owllm/main/data/";
const FETCH_TIMEOUT: Duration = Duration::from_secs(8);

fn cache_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("data-cache");
    fs::create_dir_all(&dir).map_err(|e| format!("create cache dir: {e}"))?;
    Ok(dir)
}

fn safe_rel_path(rel: &str) -> Result<PathBuf, String> {
    // No leading slash, no `..`, no absolute paths — keep us within
    // the data/ subtree on the server AND under cache_dir on disk.
    if rel.starts_with('/') || rel.contains("..") || rel.contains('\\') {
        return Err(format!("unsafe data path: {rel}"));
    }
    Ok(PathBuf::from(rel))
}

/// Fetch a data file from raw.githubusercontent.com/ruigro/LocaLLM/main/data/<rel>.
/// On network failure, returns the disk cache if present. Always writes to
/// cache on successful fetch.
async fn fetch_text<R: Runtime>(app: &AppHandle<R>, rel: &str) -> Result<String, String> {
    let rel_path = safe_rel_path(rel)?;
    let cache = cache_dir(app)?.join(&rel_path);
    let url = format!("{RAW_BASE}{rel}");
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
            let text = resp.text().await.map_err(|e| format!("read body: {e}"))?;
            if let Some(parent) = cache.parent() {
                fs::create_dir_all(parent).ok();
            }
            let _ = fs::write(&cache, &text);
            Ok(text)
        }
        _ => fs::read_to_string(&cache)
            .map_err(|e| format!("network failed and cache miss for {rel}: {e}")),
    }
}

/// Tauri command: fetch a JSON data file from the repo's `data/` tree.
/// Returns the parsed JSON value. The React side can hold it in state
/// and re-fetch on a timer / on user action for hot updates.
#[tauri::command]
pub async fn data_fetch_json<R: Runtime>(app: AppHandle<R>, path: String) -> Result<Value, String> {
    let text = fetch_text(&app, &path).await?;
    serde_json::from_str(&text).map_err(|e| format!("parse JSON {path}: {e}"))
}

/// Tauri command: fetch a YAML data file (e.g. role definitions). Parses
/// to JSON value for uniformity with the JSON path.
#[tauri::command]
pub async fn data_fetch_yaml<R: Runtime>(app: AppHandle<R>, path: String) -> Result<Value, String> {
    let text = fetch_text(&app, &path).await?;
    serde_yaml::from_str(&text).map_err(|e| format!("parse YAML {path}: {e}"))
}

/// Tauri command: fetch raw text (e.g. abliteration corpus markdown).
#[tauri::command]
pub async fn data_fetch_text<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<String, String> {
    fetch_text(&app, &path).await
}

/// Tauri command: list the local on-disk data cache. Useful for debugging
/// "did the update actually reach me?" without network.
#[tauri::command]
pub async fn data_cache_list<R: Runtime>(app: AppHandle<R>) -> Result<Vec<String>, String> {
    let root = cache_dir(&app)?;
    let mut out = Vec::new();
    fn walk(dir: &std::path::Path, root: &std::path::Path, out: &mut Vec<String>) {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    walk(&p, root, out);
                } else if let Ok(rel) = p.strip_prefix(root) {
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
    walk(&root, &root, &mut out);
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::safe_rel_path;

    #[test]
    fn rejects_path_traversal() {
        assert!(safe_rel_path("../etc/passwd").is_err());
        assert!(safe_rel_path("/etc/passwd").is_err());
        assert!(safe_rel_path("teams\\..\\evil.json").is_err());
    }

    #[test]
    fn accepts_normal_path() {
        assert!(safe_rel_path("teams/code_artisan.json").is_ok());
        assert!(safe_rel_path("roles/orchestrator.yaml").is_ok());
    }
}
