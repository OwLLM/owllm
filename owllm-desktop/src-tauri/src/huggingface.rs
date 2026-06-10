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

/// URL-encode a path-shaped string, preserving slashes as route
/// separators. `urlencoding::encode` percent-encodes EVERY non-alnum
/// byte including '/', which breaks HF API routes like
/// `/api/models/<org>/<model>/tree/<branch>` — the server rejects
/// `<org>%2F<model>` with "Invalid repo name: repo name includes an
/// url-encoded slash". Splitting on '/' and encoding each segment
/// individually keeps the route intact while still escaping any
/// other special chars in either segment (rare but possible).
fn encode_path_preserve_slashes(s: &str) -> String {
    s.split('/')
        .map(|seg| urlencoding::encode(seg).into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

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
    // HF model ids are namespaced as `<org>/<model>` and the slash is a
    // ROUTE separator, not part of the org name. Encoding it as %2F
    // makes HF return: 400 "Invalid repo name: ... - repo name includes
    // an url-encoded slash". urlencoding::encode encodes EVERYTHING
    // including '/', so we split on '/' and encode each segment
    // individually, then re-join. Branch names can in principle
    // contain slashes too (git lets you), so same treatment.
    let url = format!(
        "https://huggingface.co/api/models/{}/tree/{}?recursive=true",
        encode_path_preserve_slashes(&model_id),
        encode_path_preserve_slashes(&branch),
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
    // Destination: <models-root>/<author>/<model>/<file>. Phase 3 puts
    // the models root in %LOCALAPPDATA%\OwLLM Desktop\models\, with the
    // legacy LLM/models/ still recognised by list_models. Downloads
    // always target the new location so we don't keep filling up the
    // repo dir on dev machines.
    let models_dir = crate::paths::models_root_new()
        .or_else(|| crate::paths::llm_root().map(|r| r.join("models")))
        .ok_or_else(|| "models root not resolvable (no %LOCALAPPDATA% AND no LLM/ tree)".to_string())?;
    let dest_dir = models_dir.join(model_id.replace('/', std::path::MAIN_SEPARATOR_STR));
    let dest_file = dest_dir.join(&file);
    if let Some(parent) = dest_file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    // Idempotency guard. If the file is already on disk at a sane
    // size, treat the request as a no-op success — no re-download.
    // Cures the user's "rename .gguf.partial → .gguf: cannot find
    // file (os error 2)": confirmDownload loops once per file, and
    // when a previous attempt already finished (or a concurrent call
    // won the race), the second invocation found nothing to rename
    // and exploded. With this guard we instead emit Finished and
    // return.
    if let Ok(meta) = std::fs::metadata(&dest_file) {
        if meta.is_file() && meta.len() > 0 {
            let _ = channel.send(DownloadEvent::Started { total: Some(meta.len()) });
            let _ = channel.send(DownloadEvent::Finished {
                path: dest_file.to_string_lossy().into_owned(),
                bytes: meta.len(),
            });
            return Ok(());
        }
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
    if let Err(e) = std::fs::rename(&partial, &dest_file) {
        // Race-safe fallback: if a concurrent caller finished the same
        // file while we were streaming, rename fails (either the
        // partial vanished or the dest already exists on Windows
        // where rename refuses to clobber). In both cases the final
        // file IS on disk at a sane size — treat as success and drop
        // our redundant partial.
        if let Ok(meta) = std::fs::metadata(&dest_file) {
            if meta.is_file() && meta.len() > 0 {
                let _ = std::fs::remove_file(&partial);
                let _ = channel.send(DownloadEvent::Finished {
                    path: dest_file.to_string_lossy().into_owned(),
                    bytes: meta.len(),
                });
                return Ok(());
            }
        }
        let msg = format!("rename {} → {}: {e}", partial.display(), dest_file.display());
        let _ = channel.send(DownloadEvent::Failed { error: msg.clone() });
        return Err(msg);
    }
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
    /// GPU-fit badge derived from base_hint's params count + the user's
    /// detected VRAM. Same Browse-card formula so the three card families
    /// colour identically for the same underlying base model.
    pub compat: Option<crate::recommendations::CompatTag>,
}

/// Delete a tuned adapter directory (or .gguf file) from disk. Used
/// by the Models page Tuned tab's 🗑️ button. We only allow paths
/// strictly under <llm_root>/fine_tuned/ so a stray call can't
/// rm-rf an arbitrary system dir.
#[tauri::command]
pub async fn delete_tuned_adapter(path: String) -> Result<(), String> {
    let target = std::path::PathBuf::from(&path);
    // Phase 3: tuned adapters can live in EITHER the new
    // %LOCALAPPDATA%\OwLLM Desktop\fine_tuned\ tree OR the legacy
    // LLM/fine_tuned/. The delete is allowed as long as the canonical
    // target is rooted in one of those.
    let allowed_roots = crate::paths::fine_tuned_dirs_read();
    if allowed_roots.is_empty() {
        return Err("no fine_tuned root found (neither %LOCALAPPDATA% nor legacy LLM/ tree)".to_string());
    }
    let canon_target = std::fs::canonicalize(&target)
        .map_err(|e| format!("canonicalize {path}: {e}"))?;
    let mut ok = false;
    for r in &allowed_roots {
        if let Ok(canon_root) = std::fs::canonicalize(r) {
            if canon_target.starts_with(&canon_root) { ok = true; break; }
        }
    }
    if !ok {
        return Err(format!(
            "refused: {} is not under any allowed fine_tuned root (Tuned tab can only delete its own entries)",
            canon_target.display(),
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
    // Detect VRAM up-front so every row's compat tag uses the same
    // value (same approach as models_list_downloaded).
    let vram_gb = crate::recommendations::detect_vram_gb().await;
    tokio::task::spawn_blocking(move || -> Result<Vec<TunedAdapter>, String> {
        let roots = crate::paths::fine_tuned_dirs_read();
        if roots.is_empty() {
            return Ok(Vec::new());
        }
        let mut out: Vec<TunedAdapter> = Vec::new();
        for root in roots {
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
            // GPU-fit badge: try the base hint first (the actual model
            // the adapter rides on top of), fall back to the raw adapter
            // dir name so things like "260504_gemma-7b-finetune" still
            // colour correctly when the legacy "_base_" convention is
            // missing.
            let params = base_hint
                .as_deref()
                .and_then(crate::recommendations::parse_params_b)
                .or_else(|| crate::recommendations::parse_params_b(&name));
            let compat = params
                .and_then(|p| crate::recommendations::compat_for_params(p, vram_gb));
            out.push(TunedAdapter {
                name: name.clone(),
                path: path.to_string_lossy().into_owned(),
                size_mib: total / 1024 / 1024,
                modified,
                base_hint: base_hint.clone(),
                compat: compat.clone(),
            });
            // GGUFs that the user exported via the 📦 button land
            // INSIDE the transformers dir (default output = <dir>/<dir>-f16.gguf).
            // Surface them as separate rows so the user can Test the
            // .gguf directly (server_start handles .gguf paths) and
            // delete it without nuking the source transformers weights.
            if let Ok(inner) = std::fs::read_dir(&path) {
                for f in inner.flatten() {
                    let fp = f.path();
                    if !fp.is_file() {
                        continue;
                    }
                    let ext = fp.extension().and_then(|s| s.to_str()).unwrap_or("");
                    if !ext.eq_ignore_ascii_case("gguf") {
                        continue;
                    }
                    let fsize = f.metadata().map(|m| m.len()).unwrap_or(0);
                    let fmtime = f.metadata().ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| format_unix_seconds(d.as_secs() as i64));
                    let fname = fp.file_name().and_then(|s| s.to_str()).unwrap_or("model.gguf").to_string();
                    out.push(TunedAdapter {
                        name: fname,
                        path: fp.to_string_lossy().into_owned(),
                        size_mib: fsize / 1024 / 1024,
                        modified: fmtime,
                        base_hint: base_hint.clone(),
                        compat: compat.clone(),
                    });
                }
            }
        }
        }
        out.sort_by(|a, b| b.modified.cmp(&a.modified));
        Ok(out)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

fn format_unix_seconds(secs: i64) -> String {
    // ISO-8601-ish "YYYY-MM-DD HH:MM" in UTC. Good enough for the
    // "createdAt" hint on the card without pulling chrono.
    let days = secs / 86400;
    let secs_of_day = secs % 86400;
    let h = secs_of_day / 3600;
    let m = (secs_of_day % 3600) / 60;
    // Civil from days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = if z >= 0 { z / 146_097 } else { (z - 146_096) / 146_097 };
    let doe = (z - era * 146_097) as i64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02} {:02}:{:02}", year, month, d, h, m)
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
    pub compat: Option<crate::recommendations::CompatTag>,
}

/// Scan LLM/models/ for downloaded model directories. Returns one row
/// per top-level dir + one row per top-level .gguf file. Used by the
/// React Models page → Downloaded sub-tab.
#[tauri::command]
pub async fn models_list_downloaded() -> Result<Vec<DownloadedModel>, String> {
    // GPU-fit badge needs total VRAM; detect once before we spawn the
    // blocking scan so every row reuses the same value. Detection is
    // async (shells out to nvidia-smi); the scan itself is sync.
    let vram_gb = crate::recommendations::detect_vram_gb().await;
    tokio::task::spawn_blocking(move || -> Result<Vec<DownloadedModel>, String> {
        let roots = crate::paths::models_dirs_read();
        if roots.is_empty() {
            return Ok(Vec::new());
        }
        let mut out: Vec<DownloadedModel> = Vec::new();
        // Recursive helper. Walks the level under `dir`; for each subdir
        // either (a) emits a DownloadedModel if it looks like a real
        // model dir (config.json or weight files at this level), or
        // (b) RECURSES one level deeper when the subdir is a namespace
        // (no weights here, only further dirs). hf_download now writes
        // to <models-root>/<org>/<model>/, so the user's Qwen3.6 lives
        // at `unsloth/Qwen3.6-35B-A3B-GGUF/...gguf` — invisible to the
        // old depth-1 scanner. Display name becomes `<org>/<model>` so
        // the user sees the same id HF shows.
        fn scan_level(
            dir: &std::path::Path,
            prefix: &str,
            out: &mut Vec<DownloadedModel>,
            vram_gb: Option<f32>,
            depth: usize,
        ) -> std::io::Result<()> {
            if depth > 3 { return Ok(()); }
            for entry in std::fs::read_dir(dir)? {
                let entry = match entry { Ok(e) => e, Err(_) => continue };
                let path = entry.path();
                let raw_name = match entry.file_name().to_str() {
                    Some(s) if !s.starts_with('.') => s.to_string(),
                    _ => continue,
                };
                let display_name = if prefix.is_empty() {
                    raw_name.clone()
                } else {
                    format!("{prefix}/{raw_name}")
                };
                if path.is_dir() {
                    // Probe for weights / config at THIS level.
                    let has_config = path.join("config.json").is_file();
                    let mut has_safetensors = false;
                    let mut has_gguf = false;
                    let mut has_any_file = false;
                    let mut has_subdir = false;
                    if let Ok(it) = std::fs::read_dir(&path) {
                        for e in it.flatten() {
                            let p = e.path();
                            if p.is_dir() {
                                has_subdir = true;
                                continue;
                            }
                            has_any_file = true;
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
                    // Namespace dir: no weights here, only subdirs.
                    // Recurse and surface each child as
                    // `<this>/<child>` so the user sees the full id.
                    if !has_weights && !has_config && !has_any_file && has_subdir {
                        let _ = scan_level(&path, &display_name, out, vram_gb, depth + 1);
                        continue;
                    }
                    let (total, _) = dir_summary(&path);
                    let has_marker = path.join(".download").is_file()
                                  || path.join(".incomplete").is_file();
                    let is_incomplete = has_marker
                        || (has_config && !has_weights && total < 100 * 1024 * 1024);
                    let onboarding = if is_incomplete {
                        "BROKEN"
                    } else if has_gguf {
                        "READY"
                    } else if has_safetensors {
                        "RAW"
                    } else {
                        "NEW"
                    };
                    // Prefer ACTUAL on-disk size for ANY downloaded
                    // model — GGUF or HF safetensors. The file IS the
                    // memory footprint at runtime (or close to it for
                    // pre-quantised formats like bnb-4bit). The
                    // params-based estimate assumes FP16 and was
                    // flagging Qwen2.5-32B-Instruct-bnb-4bit (17.9 GB
                    // on disk) as 'Too large' on a 22.5 GB GPU because
                    // 32B × 2 = 64 GB. Real footprint of the 4-bit
                    // checkpoint is what's already on disk.
                    let compat = if has_weights && total > 0 {
                        crate::recommendations::compat_for_gguf_size(total, vram_gb)
                    } else {
                        crate::recommendations::parse_params_b(&display_name)
                            .and_then(|p| crate::recommendations::compat_for_params(p, vram_gb))
                    };
                    out.push(DownloadedModel {
                        name: display_name.clone(),
                        path: path.to_string_lossy().into_owned(),
                        size: fmt_size(total),
                        icons: icons_for_name(&display_name),
                        env_key: None,
                        is_incomplete,
                        onboarding: onboarding.to_string(),
                        compat,
                    });
                } else if path.extension().map(|e| e == "gguf").unwrap_or(false) {
                    let meta = entry.metadata().ok();
                    let sz = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                    let compat = crate::recommendations::compat_for_gguf_size(sz, vram_gb);
                    out.push(DownloadedModel {
                        name: display_name.clone(),
                        path: path.to_string_lossy().into_owned(),
                        size: fmt_size(sz),
                        icons: "📦".to_string(),
                        env_key: Some("llama.cpp".to_string()),
                        is_incomplete: false,
                        onboarding: "READY".to_string(),
                        compat,
                    });
                }
            }
            Ok(())
        }
        for root in &roots {
            let _ = scan_level(root, "", &mut out, vram_gb, 0);
        }
        // Dedup by name — same model present in both new and legacy
        // roots would otherwise show twice. Keep the first seen.
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        out.retain(|m| seen.insert(m.name.clone()));
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
fn hf_cache_roots() -> Vec<PathBuf> {
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
    // WSL HuggingFace cache. Fine-tuning runs INSIDE the distro now, so
    // transformers downloads base models into the distro's
    // ~/.cache/huggingface — which the Windows-side scan above can't see.
    // The result: the Train "Downloaded (ready to train)" list stayed empty
    // even after a base had been fetched. Reach the distro cache over the
    // \\wsl.localhost UNC path (std::fs reads it directly — no need to shell
    // into WSL) so downloaded bases actually show as downloaded.
    #[cfg(windows)]
    {
        if let Some(distro) = crate::wsl::wsl_status().default_distro {
            if let Ok(out) = crate::wsl::run_in_distro(&distro, "printf %s \"$HOME\"") {
                // run_in_distro may prepend login-shell chatter; take the
                // first line that looks like an absolute POSIX path.
                if let Some(home) = out
                    .lines()
                    .map(|l| l.trim())
                    .find(|l| l.starts_with('/') && !l.is_empty())
                {
                    let win_home = home.trim_start_matches('/').replace('/', "\\");
                    let base = format!("\\\\wsl.localhost\\{distro}\\{win_home}");
                    for sub in &[
                        ".cache\\huggingface\\hub",
                        ".cache\\huggingface\\transformers",
                    ] {
                        push_if(&mut candidates, PathBuf::from(format!("{base}\\{sub}")));
                    }
                }
            }
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

fn push_dir_unique(out: &mut Vec<PathBuf>, path: PathBuf) {
    if !path.is_dir() {
        return;
    }
    let p = std::fs::canonicalize(&path).unwrap_or(path);
    if !out.iter().any(|x| x == &p) {
        out.push(p);
    }
}

fn app_cache_roots() -> Vec<(String, PathBuf)> {
    let mut roots: Vec<(String, PathBuf)> = Vec::new();
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut push_labeled = |label: &str, path: PathBuf| {
        if !path.is_dir() {
            return;
        }
        let canon = std::fs::canonicalize(&path).unwrap_or(path);
        if !seen.iter().any(|x| x == &canon) {
            seen.push(canon.clone());
            roots.push((label.to_string(), canon));
        }
    };

    for root in crate::paths::models_dirs_read() {
        push_labeled("owllm-models", root);
    }
    for root in crate::paths::fine_tuned_dirs_read() {
        push_labeled("owllm-fine-tuned", root);
    }
    if let Some(root) = crate::paths::llm_root() {
        push_labeled("owllm-envs", root.join(".envs"));
        push_labeled("owllm-wheelhouse", root.join("wheelhouse"));
        push_labeled("owllm-runtime", root.join("runtime"));
        push_labeled("owllm-python-runtime", root.join("python_runtime"));
        push_labeled("owllm-vendor", root.join("vendor"));
    }
    if let Some(root) = crate::paths::runtime_cache_root() {
        push_labeled("owllm-envs", root.join("envs"));
        push_labeled("owllm-runtime", root.join("runtime"));
        push_labeled("owllm-models", root.join("models"));
        push_labeled("owllm-fine-tuned", root.join("fine_tuned"));
    }
    if let Some(home) = dirs_home() {
        push_labeled("pip-cache", home.join("AppData").join("Local").join("pip").join("Cache"));
        push_labeled("npm-cache", home.join("AppData").join("Local").join("npm-cache"));
        push_labeled("hf-user-cache", home.join(".cache").join("huggingface"));
    }

    roots
}

fn known_delete_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for p in hf_cache_roots() {
        push_dir_unique(&mut roots, p);
    }
    for (_, p) in app_cache_roots() {
        push_dir_unique(&mut roots, p);
    }
    roots
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
        let roots = hf_cache_roots();
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
                    cache_root: format!("hf-{label}"),
                    size_bytes: size,
                    modified_at: modified,
                });
            }
        }
        for (label, root) in app_cache_roots() {
            let read = match std::fs::read_dir(&root) {
                Ok(r) => r,
                Err(_) => continue,
            };
            for entry in read.flatten() {
                let p = entry.path();
                if !p.is_dir() {
                    continue;
                }
                let name = match p.file_name().and_then(|s| s.to_str()) {
                    Some(n) => n.to_string(),
                    None => continue,
                };
                if name == ".tmp" || name == ".pytest_cache" || name == "__pycache__" {
                    continue;
                }
                let (size, modified) = dir_size_recursive(&p);
                if size == 0 {
                    continue;
                }
                total = total.saturating_add(size);
                entries.push(HfCacheEntry {
                    repo_id: name.replace("__", "/"),
                    path: p.to_string_lossy().into_owned(),
                    cache_root: label.clone(),
                    size_bytes: size,
                    modified_at: modified,
                });
            }
        }

        // Biggest first — that's what the user wants to clean.
        entries.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
        let mut all_roots = roots;
        for (_, p) in app_cache_roots() {
            push_dir_unique(&mut all_roots, p);
        }
        Ok(HfCacheSummary {
            roots: all_roots.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
            total_bytes: total,
            entries,
        })
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Delete a single cache entry dir. Path-gated: must be strictly under
/// one of the discovered cache roots, so roots themselves cannot be nuked.
#[tauri::command]
pub async fn hf_cache_delete(path: String) -> Result<u64, String> {
    let target = PathBuf::from(&path);
    let canon_target = std::fs::canonicalize(&target)
        .map_err(|e| format!("canonicalize {path}: {e}"))?;
    let roots = known_delete_roots();
    let under_a_root = roots.iter().any(|r| {
        let canon_root = std::fs::canonicalize(r).unwrap_or_else(|_| r.clone());
        canon_target.starts_with(&canon_root) && canon_target != canon_root
    });
    if !under_a_root {
        return Err(format!(
            "refused: {} is not under any known cache root ({})",
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
