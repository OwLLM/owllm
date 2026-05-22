// huggingface — read-only browser + downloader for models on the
// HuggingFace Hub. Hits the public REST API directly via reqwest
// (no `hf-hub` crate — keeps the dep footprint small and gives us
// full control over the auth header / cancellation).
//
// Token resolution: reads HF_TOKEN from the accounts secret store
// (same one that holds Anthropic / OpenAI keys). When set, every
// request includes `Authorization: Bearer <token>` — lifts anon
// rate-limits and unlocks private/gated repos.
//
// Endpoints used:
//   GET https://huggingface.co/api/models?search=<q>&full=true&limit=N
//   GET https://huggingface.co/api/models/<id>
//   GET https://huggingface.co/api/models/<id>/tree/<branch>
//   GET https://huggingface.co/<id>/resolve/<branch>/<file>
// The /tree/ endpoint returns directory listings recursively; the
// /resolve/ endpoint is the actual file download with redirects.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::ipc::Channel;

/// Per-model summary returned by the search endpoint. We only
/// surface fields the React UI actually renders — the API returns
/// dozens more but we keep the wire payload small.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HfModelHit {
    pub id: String,
    pub author: Option<String>,
    pub downloads: u64,
    pub likes: u64,
    pub pipeline_tag: Option<String>,
    pub tags: Vec<String>,
    /// ISO-8601 timestamp of the latest commit on `main`.
    pub last_modified: Option<String>,
    /// True when access requires accepting the model's terms / EULA
    /// before downloading (gated). We surface this in the UI so the
    /// user knows they need to visit HF first.
    pub gated: bool,
    /// True when the repo is marked private (only visible with an
    /// authed token). For an anon caller this never appears, but
    /// when the user has saved HF_TOKEN we surface it.
    pub private: bool,
}

/// One file inside a model repo. Returned by hf_model_files() and
/// used by the React UI to populate the "pick file to download"
/// row (e.g. user picks Q4_K_M.gguf out of 8 quantisation variants).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HfFile {
    pub path: String,
    pub size: Option<u64>,
    /// Git-LFS pointer? GGUFs are always LFS; small files (README,
    /// tokenizer.json) are not. The UI shows a 📦 icon for LFS files.
    pub lfs: bool,
}

#[derive(Deserialize)]
struct ApiModel {
    // HF returns BOTH `modelId` and `id` for the same repo string on
    // /api/models. Serde's `rename + alias` combo errors on
    // "duplicate field" when both appear, so we lock to `id` (always
    // present) and ignore the duplicate via `deny_unknown_fields=false`
    // which is serde's default for unrecognised keys.
    #[serde(rename = "id")]
    model_id: String,
    author: Option<String>,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    likes: u64,
    pipeline_tag: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    last_modified: Option<String>,
    #[serde(default)]
    gated: serde_json::Value, // "auto" | "manual" | false | true
    #[serde(default)]
    private: bool,
}

impl From<ApiModel> for HfModelHit {
    fn from(m: ApiModel) -> Self {
        let gated = match m.gated {
            serde_json::Value::Bool(b) => b,
            serde_json::Value::String(s) => !s.eq_ignore_ascii_case("false"),
            _ => false,
        };
        HfModelHit {
            id: m.model_id,
            author: m.author,
            downloads: m.downloads,
            likes: m.likes,
            pipeline_tag: m.pipeline_tag,
            tags: m.tags,
            last_modified: m.last_modified,
            gated,
            private: m.private,
        }
    }
}

#[derive(Deserialize)]
struct ApiTreeEntry {
    #[serde(rename = "type")]
    kind: String,
    path: String,
    size: Option<u64>,
    #[serde(default)]
    lfs: Option<serde_json::Value>,
}

/// Pull the HF token from the accounts secret store. Returns None
/// when not set — every endpoint here works anonymously, the token
/// just unlocks gated repos and lifts rate-limits.
fn hf_token() -> Option<String> {
    crate::accounts::accounts_get_secret("HF_TOKEN".to_string())
        .filter(|s| !s.trim().is_empty())
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("OwLLM-Desktop/1.0")
        .build()
        .expect("reqwest client")
}

/// Search HuggingFace for models matching `query`. The Hub's
/// /api/models endpoint accepts free-text + optional filters; we
/// expose only the common ones (`pipeline_tag`, `author`) and let
/// the UI build the rest as URL query params later if needed.
#[tauri::command]
pub async fn hf_search(
    query: String,
    pipeline_tag: Option<String>,
    limit: Option<u32>,
    sort: Option<String>,
) -> Result<Vec<HfModelHit>, String> {
    let lim = limit.unwrap_or(40).min(100);
    let mut url = reqwest::Url::parse("https://huggingface.co/api/models")
        .map_err(|e| format!("bad url: {e}"))?;
    {
        let mut q = url.query_pairs_mut();
        if !query.trim().is_empty() {
            q.append_pair("search", query.trim());
        }
        if let Some(tag) = pipeline_tag.as_deref() {
            if !tag.trim().is_empty() {
                q.append_pair("pipeline_tag", tag.trim());
            }
        }
        // HF sort keys: "downloads", "likes", "lastModified", "createdAt", "trendingScore".
        // direction=-1 puts highest first.
        if let Some(s) = sort.as_deref() {
            let s = s.trim();
            if !s.is_empty() {
                q.append_pair("sort", s);
                q.append_pair("direction", "-1");
            }
        }
        q.append_pair("full", "true");
        q.append_pair("limit", &lim.to_string());
    }
    let mut req = client().get(url);
    if let Some(tok) = hf_token() {
        req = req.bearer_auth(tok);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("hf request: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("hf body: {e}"))?;
    if !status.is_success() {
        return Err(format!("HuggingFace returned {status}: {body}"));
    }
    let parsed: Vec<ApiModel> = serde_json::from_str(&body)
        .map_err(|e| format!("hf json: {e}"))?;
    Ok(parsed.into_iter().map(HfModelHit::from).collect())
}

/// List every file in a model repo at the given branch (default `main`).
/// One call: HF returns the full tree recursively. Used by the UI to
/// show the GGUF variant picker.
#[tauri::command]
pub async fn hf_model_files(
    model_id: String,
    branch: Option<String>,
) -> Result<Vec<HfFile>, String> {
    let branch = branch.unwrap_or_else(|| "main".to_string());
    let url = format!(
        "https://huggingface.co/api/models/{}/tree/{}?recursive=true",
        urlencoding::encode(&model_id),
        urlencoding::encode(&branch),
    );
    let mut req = client().get(&url);
    if let Some(tok) = hf_token() {
        req = req.bearer_auth(tok);
    }
    let resp = req.send().await.map_err(|e| format!("hf request: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("hf body: {e}"))?;
    if !status.is_success() {
        return Err(format!("HuggingFace returned {status}: {body}"));
    }
    let entries: Vec<ApiTreeEntry> = serde_json::from_str(&body)
        .map_err(|e| format!("hf json: {e}"))?;
    Ok(entries
        .into_iter()
        .filter(|e| e.kind == "file")
        .map(|e| HfFile {
            path: e.path,
            size: e.size,
            lfs: e.lfs.is_some(),
        })
        .collect())
}

/// Streaming progress event emitted while a file downloads. The
/// React caller wires a Tauri Channel and renders a progress bar.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DownloadEvent {
    /// Total size known (some servers don't send Content-Length;
    /// when that's the case we emit Started with total=None and the
    /// UI shows an indeterminate spinner instead of a bar).
    Started { total: Option<u64> },
    Progress { received: u64, total: Option<u64> },
    /// Final fired exactly once on success. `path` is where the
    /// file was actually written (the destination dir + filename).
    Finished { path: String, bytes: u64 },
    Failed { error: String },
}

/// Download one file from a HuggingFace repo to the local
/// `LLM/models/` tree. Progress events stream via the Channel so the
/// UI can show a live progress bar; the final Finished/Failed event
/// is emitted exactly once.
///
/// Cancellation is cooperative: the caller can drop the Channel on
/// the JS side, but the download will keep going until the next
/// chunk write. A proper cancel command is a follow-up slice.
#[tauri::command]
pub async fn hf_download(
    model_id: String,
    file: String,
    branch: Option<String>,
    channel: Channel<DownloadEvent>,
) -> Result<(), String> {
    let branch = branch.unwrap_or_else(|| "main".to_string());
    let url = format!(
        "https://huggingface.co/{}/resolve/{}/{}",
        model_id, branch, file,
    );
    // Destination: LLM/models/<author>/<model>/<file> — mirrors the
    // HF repo layout so the local tree stays interpretable.
    let llm_root = crate::paths::llm_root()
        .ok_or_else(|| "LLM/ root not found".to_string())?;
    let models_dir = llm_root.join("models");
    let dest_dir = models_dir.join(model_id.replace('/', std::path::MAIN_SEPARATOR_STR));
    let dest_file = dest_dir.join(&file);
    if let Some(parent) = dest_file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    // Always write to a `.partial` first and rename on success — so
    // a half-done download never leaves a file that scanners might
    // mistake for a complete GGUF. Same atomicity pattern the env
    // installer uses.
    let partial = with_suffix(&dest_file, ".partial");

    let mut req = client().get(&url);
    if let Some(tok) = hf_token() {
        req = req.bearer_auth(tok);
    }
    let resp = req.send().await.map_err(|e| {
        let msg = format!("hf request: {e}");
        let _ = channel.send(DownloadEvent::Failed { error: msg.clone() });
        msg
    })?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let msg = format!("HuggingFace returned {status}: {body}");
        let _ = channel.send(DownloadEvent::Failed { error: msg.clone() });
        return Err(msg);
    }
    let total = resp.content_length();
    let _ = channel.send(DownloadEvent::Started { total });

    let mut out = std::fs::File::create(&partial)
        .map_err(|e| format!("create {}: {e}", partial.display()))?;
    let mut stream = resp.bytes_stream();
    let mut received: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => {
                let msg = format!("download chunk: {e}");
                let _ = channel.send(DownloadEvent::Failed { error: msg.clone() });
                return Err(msg);
            }
        };
        std::io::Write::write_all(&mut out, &bytes)
            .map_err(|e| format!("write {}: {e}", partial.display()))?;
        received += bytes.len() as u64;
        // Throttle emit to ~5/s — the UI doesn't benefit from
        // 1000 progress events per second and the IPC chatter
        // becomes the bottleneck for fast disks.
        if last_emit.elapsed() >= std::time::Duration::from_millis(200) {
            let _ = channel.send(DownloadEvent::Progress { received, total });
            last_emit = std::time::Instant::now();
        }
    }
    drop(out);
    std::fs::rename(&partial, &dest_file)
        .map_err(|e| format!("rename {} → {}: {e}", partial.display(), dest_file.display()))?;
    let _ = channel.send(DownloadEvent::Finished {
        path: dest_file.to_string_lossy().into_owned(),
        bytes: received,
    });
    Ok(())
}

/// Append a suffix string to a path (preserving the filename). Used
/// to derive the `.partial` sibling of the final destination.
fn with_suffix(p: &PathBuf, suffix: &str) -> PathBuf {
    let mut s = p.clone().into_os_string();
    s.push(suffix);
    PathBuf::from(s)
}

/// List every fine-tuned adapter (PEFT LoRA output) under LLM/fine_tuned/.
/// One row per top-level directory. The UI renders these in the
/// ModelsPage "Tuned" sub-tab so the user can see what's been
/// produced by past training runs.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TunedAdapter {
    pub name: String,
    pub path: String,
    /// Size in MiB summed across all files (rounded).
    pub size_mib: u64,
    /// ISO-8601 timestamp of the most recent file inside the dir.
    pub modified: Option<String>,
    /// Best-effort base-model hint extracted from the directory name
    /// (the legacy naming convention is "<YYMMDD>_<base>_<dataset>_…").
    /// Returns None when the convention isn't followed.
    pub base_hint: Option<String>,
}

/// Delete a tuned adapter directory (or .gguf file) from disk. Used
/// by the Models page Tuned tab's 🗑️ button. We only allow paths
/// strictly under <llm_root>/fine_tuned/ so a stray call can't
/// rm-rf an arbitrary system dir.
#[tauri::command]
pub async fn delete_tuned_adapter(path: String) -> Result<(), String> {
    let target = std::path::PathBuf::from(&path);
    let root = crate::paths::llm_root().ok_or_else(|| "no LLM root".to_string())?;
    let fine_tuned_root = root.join("fine_tuned");
    // Canonicalize both so a path like "fine_tuned/../models/x" can't
    // escape the guard via .. traversal.
    let canon_target = std::fs::canonicalize(&target)
        .map_err(|e| format!("canonicalize {path}: {e}"))?;
    let canon_root = std::fs::canonicalize(&fine_tuned_root)
        .map_err(|e| format!("canonicalize {}: {e}", fine_tuned_root.display()))?;
    if !canon_target.starts_with(&canon_root) {
        return Err(format!(
            "refused: {} is not under {} (Tuned tab can only delete its own entries)",
            canon_target.display(), canon_root.display()
        ));
    }
    if canon_target.is_dir() {
        std::fs::remove_dir_all(&canon_target)
            .map_err(|e| format!("remove_dir_all {}: {e}", canon_target.display()))?;
    } else if canon_target.is_file() {
        std::fs::remove_file(&canon_target)
            .map_err(|e| format!("remove_file {}: {e}", canon_target.display()))?;
    } else {
        return Err(format!("not a file or directory: {}", canon_target.display()));
    }
    Ok(())
}

#[tauri::command]
pub async fn list_tuned_adapters() -> Result<Vec<TunedAdapter>, String> {
    tokio::task::spawn_blocking(|| -> Result<Vec<TunedAdapter>, String> {
        let root = match crate::paths::llm_root() {
            Some(r) => r.join("fine_tuned"),
            None => return Ok(Vec::new()),
        };
        if !root.is_dir() {
            return Ok(Vec::new());
        }
        let mut out: Vec<TunedAdapter> = Vec::new();
        for entry in std::fs::read_dir(&root).map_err(|e| format!("readdir: {e}"))? {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = match entry.file_name().to_str() {
                Some(s) => s.to_string(),
                None => continue,
            };
            // Skip transient checkpoint dirs and crash logs.
            if name.starts_with('.')
                || name.starts_with("checkpoint-")
                || name == "_crash_logs"
            {
                continue;
            }
            let (total, modified) = dir_summary(&path);
            let base_hint = parse_base_from_name(&name);
            out.push(TunedAdapter {
                name,
                path: path.to_string_lossy().into_owned(),
                size_mib: total / 1024 / 1024,
                modified,
                base_hint,
            });
        }
        out.sort_by(|a, b| b.modified.cmp(&a.modified));
        Ok(out)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Sum file sizes + find the most-recent mtime under `dir`. Used by
/// list_tuned_adapters to summarise each adapter in one walk.
fn dir_summary(dir: &std::path::Path) -> (u64, Option<String>) {
    let mut total: u64 = 0;
    let mut latest: Option<std::time::SystemTime> = None;
    fn walk(p: &std::path::Path, total: &mut u64, latest: &mut Option<std::time::SystemTime>) {
        let entries = match std::fs::read_dir(p) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.is_dir() {
                walk(&path, total, latest);
            } else {
                *total += meta.len();
                if let Ok(m) = meta.modified() {
                    match latest {
                        Some(prev) if *prev >= m => {}
                        _ => *latest = Some(m),
                    }
                }
            }
        }
    }
    walk(dir, &mut total, &mut latest);
    let iso = latest.and_then(|t| {
        let secs = t.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
        // Compact UTC ISO without sub-second precision — that's all
        // the UI displays anyway.
        let datetime = chrono::DateTime::<chrono::Utc>::from_timestamp(secs as i64, 0)?;
        Some(datetime.format("%Y-%m-%dT%H:%M:%SZ").to_string())
    });
    (total, iso)
}

/// Local-disk view of a model folder under LLM/models/. Mirrors the
/// shape DownloadedModelCard expects in React: name + path + size +
/// onboarding state. We treat "READY" as any dir that contains a
/// config.json (huggingface format) OR ends in .gguf; "NEW" otherwise
/// (the user hasn't run the onboarding env-build yet).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedModel {
    pub name: String,
    pub path: String,
    /// Human-readable size like "16.0 GB".
    pub size: String,
    /// Best-effort tag icons derived from the dir name.
    pub icons: String,
    pub env_key: Option<String>,
    pub is_incomplete: bool,
    /// "READY" / "BUILDING" / "BROKEN" / "NEW" — matches the React enum.
    pub onboarding: String,
    pub compat: Option<CompatTag>,
}

#[derive(Serialize, Clone)]
pub struct CompatTag {
    pub color: String, // "green" | "orange" | "red" | "gray"
    pub text: String,
}

/// Scan LLM/models/ for downloaded model directories. Returns one row
/// per top-level dir + one row per top-level .gguf file. Used by the
/// React Models page → Downloaded sub-tab.
#[tauri::command]
pub async fn models_list_downloaded() -> Result<Vec<DownloadedModel>, String> {
    tokio::task::spawn_blocking(|| -> Result<Vec<DownloadedModel>, String> {
        let root = match crate::paths::llm_root() {
            Some(r) => r.join("models"),
            None => return Ok(Vec::new()),
        };
        if !root.is_dir() {
            return Ok(Vec::new());
        }
        let mut out: Vec<DownloadedModel> = Vec::new();
        for entry in std::fs::read_dir(&root).map_err(|e| format!("readdir: {e}"))? {
            let entry = match entry { Ok(e) => e, Err(_) => continue };
            let path = entry.path();
            let name = match entry.file_name().to_str() {
                Some(s) if !s.starts_with('.') => s.to_string(),
                _ => continue,
            };
            if path.is_dir() {
                let (total, _) = dir_summary(&path);
                let has_config = path.join("config.json").is_file();
                // Three weight-format probes — a model is "usable" if
                // it has *any* of these on disk:
                //   safetensors  : HF transformers format (preferred)
                //   bin          : legacy pytorch_model.bin / shards
                //   gguf         : llama.cpp single-file format
                // The previous heuristic only checked the first two,
                // so GGUF-only directories (very common — e.g. any
                // "<repo>-GGUF" mirror) fell through to NEW and
                // surfaced as "⏬ Incomplete" even though they were
                // actually ready to run.
                let mut has_safetensors = false;
                let mut has_gguf = false;
                if let Ok(it) = std::fs::read_dir(&path) {
                    for e in it.flatten() {
                        let p = e.path();
                        if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                            match ext.to_ascii_lowercase().as_str() {
                                "safetensors" | "bin" => has_safetensors = true,
                                "gguf" => has_gguf = true,
                                _ => {}
                            }
                        }
                    }
                }
                let has_weights = has_safetensors || has_gguf;
                let has_marker = path.join(".download").is_file()
                              || path.join(".incomplete").is_file();
                // GGUF mirrors typically have no config.json — that
                // alone shouldn't flag them as incomplete. The
                // incomplete heuristic now requires config.json + no
                // weights (a real "stalled download" signature).
                let is_incomplete = has_marker
                    || (has_config && !has_weights && total < 100 * 1024 * 1024);
                let onboarding = if is_incomplete {
                    "BROKEN"
                } else if has_weights {
                    // Any usable weight format = READY.
                    "READY"
                } else {
                    // No weights yet — still in flight or a partial
                    // clone. Show as NEW so the user can decide.
                    "NEW"
                };
                out.push(DownloadedModel {
                    name: name.clone(),
                    path: path.to_string_lossy().into_owned(),
                    size: fmt_size(total),
                    icons: icons_for_name(&name),
                    env_key: None,
                    is_incomplete,
                    onboarding: onboarding.to_string(),
                    compat: None,
                });
            } else if path.extension().map(|e| e == "gguf").unwrap_or(false) {
                let meta = entry.metadata().ok();
                let sz = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                out.push(DownloadedModel {
                    name: name.clone(),
                    path: path.to_string_lossy().into_owned(),
                    size: fmt_size(sz),
                    icons: "📦".to_string(),
                    env_key: Some("llama.cpp".to_string()),
                    is_incomplete: false,
                    onboarding: "READY".to_string(),
                    compat: None,
                });
            }
        }
        // Most recent first.
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(out)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

fn fmt_size(bytes: u64) -> String {
    let b = bytes as f64;
    if b >= 1024.0 * 1024.0 * 1024.0 {
        format!("{:.1} GB", b / (1024.0 * 1024.0 * 1024.0))
    } else if b >= 1024.0 * 1024.0 {
        format!("{:.1} MB", b / (1024.0 * 1024.0))
    } else if b >= 1024.0 {
        format!("{:.1} KB", b / 1024.0)
    } else {
        format!("{} B", bytes)
    }
}

fn icons_for_name(name: &str) -> String {
    let n = name.to_lowercase();
    let mut out: Vec<&str> = Vec::new();
    if n.contains("instruct") || n.contains("-it") { out.push("💡"); }
    if n.contains("chat") || n.contains("dialog")  { out.push("💬"); }
    if n.contains("vl") || n.contains("vision") || n.contains("llava") { out.push("👁"); }
    if n.contains("r1") || n.contains("reasoning") || n.contains("thinking") { out.push("🧠"); }
    if n.ends_with(".gguf") || n.contains("gguf") { out.push("📦"); }
    if n.contains("lora") || n.contains("adapter") || n.contains("peft") { out.push("🧩"); }
    out.join(" ")
}

/// Extract a probable base-model name from a fine_tuned directory
/// name. The legacy convention is `<YYMMDD>_<base>_<dataset>_…`; we
/// take the second underscore-separated token. Returns None when the
/// dir name doesn't follow the convention.
fn parse_base_from_name(name: &str) -> Option<String> {
    let parts: Vec<&str> = name.splitn(3, '_').collect();
    if parts.len() < 2 {
        return None;
    }
    // Token 0 must look like a date prefix; otherwise the convention
    // doesn't apply and we leave the hint empty.
    let date = parts[0];
    if date.len() != 6 || !date.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(parts[1].to_string())
}

// ---------------------------------------------------------------------
// HF cache audit — abliterate / GGUF export / Train flows all rely on
// transformers/huggingface_hub, which silently stash downloads in
// $HF_HOME, $TRANSFORMERS_CACHE, $HF_HUB_CACHE, or
// ~/.cache/huggingface/hub. A 7B bnb-4bit model is ~5GB; a 70B is
// ~37GB. The "Tuned" tab's delete button only touches LLM/fine_tuned/,
// so without explicit cache management the disk balloons forever.
// These two commands surface the cache to the UI and allow safe
// deletion of individual model dirs (path-gated to known cache roots).
// ---------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HfCacheEntry {
    /// "owner/name" reconstructed from the dir name "models--owner--name".
    pub repo_id: String,
    /// Full disk path to the models--*/ directory.
    pub path: String,
    /// Which cache root this lives under (display label like "transformers"
    /// or "hub" — derived from the parent dir name).
    pub cache_root: String,
    /// Total disk usage in bytes (recursive).
    pub size_bytes: u64,
    /// Unix seconds of the most recent file mtime inside the dir, so the
    /// UI can sort by "oldest unused".
    pub modified_at: Option<i64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HfCacheSummary {
    pub roots: Vec<String>,
    pub total_bytes: u64,
    pub entries: Vec<HfCacheEntry>,
}

/// Enumerate every cache root we know about. We probe each env var +
/// the standard ~/.cache fallback. The same physical dir can be
/// referenced by multiple env vars; dedupe by canonicalized path.
fn cache_roots() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    let push_if = |v: &mut Vec<PathBuf>, p: PathBuf| {
        if p.is_dir() && !v.iter().any(|x| x == &p) {
            v.push(p);
        }
    };
    // Explicit env vars take priority — match what transformers /
    // huggingface_hub read at runtime.
    for var in &["TRANSFORMERS_CACHE", "HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE"] {
        if let Ok(v) = std::env::var(var) {
            push_if(&mut candidates, PathBuf::from(v));
        }
    }
    if let Ok(home) = std::env::var("HF_HOME") {
        let h = PathBuf::from(&home);
        push_if(&mut candidates, h.join("hub"));
        push_if(&mut candidates, h.join("transformers"));
        push_if(&mut candidates, h); // some bnb / datasets dirs sit at root
    }
    // Standard fallback locations.
    if let Some(home) = dirs_home() {
        push_if(&mut candidates, home.join(".cache").join("huggingface").join("hub"));
        push_if(&mut candidates, home.join(".cache").join("huggingface").join("transformers"));
    }
    // Common Windows convention we've seen in this codebase: C:\hf\*.
    #[cfg(windows)]
    {
        for sub in &["hub", "transformers", "datasets", "xet"] {
            push_if(&mut candidates, PathBuf::from(format!("C:\\hf\\{sub}")));
        }
    }
    // Canonicalize so we don't double-count via different relative
    // forms. Fall back to the original path if canonicalize fails.
    candidates
        .into_iter()
        .map(|p| std::fs::canonicalize(&p).unwrap_or(p))
        .fold(Vec::new(), |mut acc, p| {
            if !acc.iter().any(|x| x == &p) {
                acc.push(p);
            }
            acc
        })
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())
        .map(PathBuf::from)
}

fn dir_size_recursive(path: &std::path::Path) -> (u64, Option<i64>) {
    let mut total: u64 = 0;
    let mut newest: Option<i64> = None;
    let mut stack: Vec<PathBuf> = vec![path.to_path_buf()];
    while let Some(p) = stack.pop() {
        let entries = match std::fs::read_dir(&p) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if metadata.is_dir() {
                stack.push(entry.path());
            } else if metadata.is_file() {
                total = total.saturating_add(metadata.len());
                if let Ok(mtime) = metadata.modified() {
                    if let Ok(d) = mtime.duration_since(std::time::UNIX_EPOCH) {
                        let secs = d.as_secs() as i64;
                        if newest.map(|n| secs > n).unwrap_or(true) {
                            newest = Some(secs);
                        }
                    }
                }
            }
        }
    }
    (total, newest)
}

#[tauri::command]
pub async fn hf_cache_list() -> Result<HfCacheSummary, String> {
    tokio::task::spawn_blocking(|| -> Result<HfCacheSummary, String> {
        let roots = cache_roots();
        let mut entries: Vec<HfCacheEntry> = Vec::new();
        let mut total: u64 = 0;
        for root in &roots {
            // The HF cache convention: each cached repo lives at
            // <root>/models--<owner>--<name>/. Walk one level deep.
            let read = match std::fs::read_dir(root) {
                Ok(r) => r,
                Err(_) => continue,
            };
            let label = root
                .file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| root.display().to_string());
            for entry in read.flatten() {
                let p = entry.path();
                let name = match p.file_name().and_then(|s| s.to_str()) {
                    Some(n) => n.to_string(),
                    None => continue,
                };
                if !name.starts_with("models--") {
                    continue;
                }
                // models--owner--name → owner/name. The HF layout uses
                // -- as the separator and inside owner / name can't
                // contain --, so splitn(3,"--") gives [_, owner, name].
                let parts: Vec<&str> = name.splitn(3, "--").collect();
                let repo_id = if parts.len() == 3 {
                    format!("{}/{}", parts[1], parts[2])
                } else {
                    name.clone()
                };
                let (size, modified) = dir_size_recursive(&p);
                total = total.saturating_add(size);
                entries.push(HfCacheEntry {
                    repo_id,
                    path: p.to_string_lossy().into_owned(),
                    cache_root: label.clone(),
                    size_bytes: size,
                    modified_at: modified,
                });
            }
        }
        // Biggest first — that's what the user wants to clean.
        entries.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
        Ok(HfCacheSummary {
            roots: roots.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
            total_bytes: total,
            entries,
        })
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Delete a single cached model dir. Path-gated: must be under one of
/// the cache_roots() we just enumerated, AND must be a "models--*"
/// dir (no nuking the cache root itself).
#[tauri::command]
pub async fn hf_cache_delete(path: String) -> Result<u64, String> {
    let target = PathBuf::from(&path);
    let canon_target = std::fs::canonicalize(&target)
        .map_err(|e| format!("canonicalize {path}: {e}"))?;
    let name = canon_target
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if !name.starts_with("models--") {
        return Err(format!(
            "refused: {} is not a models--*/ cache entry",
            canon_target.display()
        ));
    }
    let roots = cache_roots();
    let under_a_root = roots.iter().any(|r| canon_target.starts_with(r));
    if !under_a_root {
        return Err(format!(
            "refused: {} is not under any known HF cache root ({})",
            canon_target.display(),
            roots
                .iter()
                .map(|r| r.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    let (size, _) = dir_size_recursive(&canon_target);
    std::fs::remove_dir_all(&canon_target)
        .map_err(|e| format!("remove_dir_all {}: {e}", canon_target.display()))?;
    Ok(size)
}
