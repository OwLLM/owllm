// Media asset library — per-project storage for generated images/videos.
//
// Each asset is a media file on disk plus a sibling JSON sidecar
// (`<filename>.asset.json`) that holds prompt/brief, target platform,
// campaign, post status, tags, and notes. Assets live inside the project
// folder when a location is set (`<location>/.owllm/assets/`), otherwise
// in the app user-data dir (`<user_data_root>/project-assets/<id>/`).

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const ASSET_DIR_NAME: &str = ".owllm";
const ASSET_SUBDIR_NAME: &str = "assets";
const FALLBACK_ASSETS_DIR: &str = "project-assets";
const SIDECAR_EXT: &str = ".asset.json";

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
const VIDEO_EXTS: &[&str] = &["mp4", "mov", "webm", "avi", "mkv", "m4v"];

#[derive(Default, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AssetMeta {
    pub id: String,
    pub file_name: String,
    pub prompt: String,
    pub target_platform: String,
    pub campaign: String,
    pub status: String, // draft | approved | rejected | posted
    pub tags: Vec<String>,
    pub notes: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    #[serde(flatten)]
    pub meta: AssetMeta,
    pub kind: String, // image | video | unknown
    pub path: String, // full filesystem path to the media file
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAssetDetail {
    #[serde(flatten)]
    pub asset: MediaAsset,
    pub data_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetPatch {
    pub prompt: Option<String>,
    pub target_platform: Option<String>,
    pub campaign: Option<String>,
    pub status: Option<String>,
    pub tags: Option<Vec<String>>,
    pub notes: Option<String>,
}

fn now_iso() -> String {
    // Reuse the same lightweight ISO formatter from projects.rs.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    httpdate_like(secs)
}

fn httpdate_like(epoch_secs: u64) -> String {
    use std::convert::TryInto;
    let days_since_epoch: i64 = (epoch_secs / 86400).try_into().unwrap_or(0);
    let secs_today = epoch_secs % 86400;
    let hour = secs_today / 3600;
    let minute = (secs_today % 3600) / 60;
    let sec = secs_today % 60;
    let mut year = 1970i64;
    let mut day = days_since_epoch;
    loop {
        let yr_days = if is_leap(year) { 366 } else { 365 };
        if day < yr_days {
            break;
        }
        day -= yr_days;
        year += 1;
    }
    let mdays: [i64; 12] = if is_leap(year) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut month = 0;
    for (i, md) in mdays.iter().enumerate() {
        if day < *md {
            month = i;
            break;
        }
        day -= *md;
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year,
        month + 1,
        day + 1,
        hour,
        minute,
        sec
    )
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn new_id() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut rand_bytes = [0u8; 8];
    getrand_unsafe(&mut rand_bytes);
    let rand_hex = rand_bytes
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>();
    format!("{:x}_{}", ms, rand_hex)
}

fn getrand_unsafe(buf: &mut [u8]) {
    use std::time::Instant;
    let mut seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    seed ^= Instant::now().elapsed().as_nanos();
    for b in buf.iter_mut() {
        seed = seed
            .wrapping_mul(6364136223846793005u128)
            .wrapping_add(1442695040888963407u128);
        *b = (seed >> 96) as u8;
    }
}

/// Resolve the asset directory for a project.
/// Primary: `<project.location>/.owllm/assets/`
/// Fallback: `<user_data_root>/project-assets/<project_id>/`
fn asset_dir_for(project_id: &str) -> Result<PathBuf, String> {
    let location = project_location(project_id)?;
    if !location.is_empty() {
        let p = PathBuf::from(location)
            .join(ASSET_DIR_NAME)
            .join(ASSET_SUBDIR_NAME);
        return Ok(p);
    }
    let root =
        crate::paths::user_data_root().ok_or_else(|| "user data root not found".to_string())?;
    Ok(root.join(FALLBACK_ASSETS_DIR).join(project_id))
}

fn project_location(project_id: &str) -> Result<String, String> {
    let Some(path) = crate::projects::project_db_path() else {
        return Err("project database not found".into());
    };
    let project_id = project_id.to_string();
    let loc: String = std::thread::spawn(move || -> Result<String, String> {
        let conn = crate::projects::open_state_db(&path)?;
        crate::projects::ensure_schema(&conn).map_err(|e| format!("schema: {e}"))?;
        let loc: Option<String> = conn
            .query_row(
                "SELECT location FROM agent_projects WHERE id = ?",
                rusqlite::params![project_id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("query location: {e}"))?;
        Ok(loc.unwrap_or_default())
    })
    .join()
    .map_err(|e| format!("join error: {e:?}"))??;
    Ok(loc)
}

fn ensure_asset_dir(project_id: &str) -> Result<PathBuf, String> {
    let dir = asset_dir_for(project_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    Ok(dir)
}

fn is_media_ext(ext: &str) -> bool {
    let e = ext.to_lowercase();
    IMAGE_EXTS.iter().chain(VIDEO_EXTS.iter()).any(|x| x == &e)
}

fn media_kind(ext: &str) -> String {
    let e = ext.to_lowercase();
    if IMAGE_EXTS.iter().any(|x| x == &e) {
        "image".to_string()
    } else if VIDEO_EXTS.iter().any(|x| x == &e) {
        "video".to_string()
    } else {
        "unknown".to_string()
    }
}

fn sidecar_path(media_path: &Path) -> PathBuf {
    let name = media_path.file_name().unwrap_or_default().to_string_lossy();
    media_path.with_file_name(format!("{}{}", name, SIDECAR_EXT))
}

fn load_sidecar(path: &Path) -> Option<AssetMeta> {
    let raw = std::fs::read_to_string(path).ok()?;
    let mut meta: AssetMeta = serde_json::from_str(&raw).ok()?;
    // Ensure id always matches the filename stem so the UI can request it.
    if meta.id.is_empty() {
        meta.id = path.file_stem()?.to_string_lossy().into_owned();
    }
    Some(meta)
}

fn save_sidecar(path: &Path, meta: &AssetMeta) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(meta).map_err(|e| format!("serialize sidecar: {e}"))?;
    std::fs::write(path, raw).map_err(|e| format!("write sidecar {}: {e}", path.display()))
}

fn default_meta_for(file_name: &str, id: &str) -> AssetMeta {
    let now = now_iso();
    AssetMeta {
        id: id.to_string(),
        file_name: file_name.to_string(),
        prompt: String::new(),
        target_platform: String::new(),
        campaign: String::new(),
        status: "draft".to_string(),
        tags: Vec::new(),
        notes: String::new(),
        created_at: now.clone(),
        updated_at: now,
    }
}

fn normalize_status(s: &str) -> String {
    match s.to_lowercase().as_str() {
        "approved" => "approved".to_string(),
        "rejected" => "rejected".to_string(),
        "posted" => "posted".to_string(),
        _ => "draft".to_string(),
    }
}

fn safe_filename(name: &str) -> String {
    // Keep alphanumeric, dot, dash, underscore, space; replace others with '_'.
    let mut out = String::new();
    for c in name.chars() {
        if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' || c == ' ' {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    out.trim().to_string()
}

fn list_assets_impl(project_id: String) -> Result<Vec<MediaAsset>, String> {
    let dir = ensure_asset_dir(&project_id)?;
    let read = std::fs::read_dir(&dir).map_err(|e| format!("read dir {}: {e}", dir.display()))?;
    let mut out = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
        if !is_media_ext(ext) {
            continue;
        }
        // Skip sidecars themselves (they end with .asset.json and may be mistaken if ext parsing drifts).
        if path.to_string_lossy().ends_with(SIDECAR_EXT) {
            continue;
        }

        let id = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(new_id);
        let sidecar = sidecar_path(&path);
        let mut meta = load_sidecar(&sidecar).unwrap_or_else(|| {
            default_meta_for(&path.file_name().unwrap_or_default().to_string_lossy(), &id)
        });
        meta.id = id;
        meta.file_name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        meta.status = normalize_status(&meta.status);
        out.push(MediaAsset {
            kind: media_kind(ext),
            path: path.to_string_lossy().into_owned(),
            meta,
        });
    }
    out.sort_by(|a, b| b.meta.created_at.cmp(&a.meta.created_at));
    Ok(out)
}

#[tauri::command]
pub async fn media_assets_list(project_id: String) -> Result<Vec<MediaAsset>, String> {
    tokio::task::spawn_blocking(move || list_assets_impl(project_id))
        .await
        .map_err(|e| format!("join error: {e:?}"))?
}

fn read_asset_impl(
    project_id: String,
    asset_id: String,
    include_data: bool,
) -> Result<MediaAssetDetail, String> {
    let dir = ensure_asset_dir(&project_id)?;
    let assets = list_assets_impl(project_id)?;
    let asset = assets
        .into_iter()
        .find(|a| a.meta.id == asset_id)
        .ok_or_else(|| format!("asset not found: {asset_id}"))?;

    let media_path = dir.join(&asset.meta.file_name);
    let data_url = if include_data && asset.kind == "image" {
        let bytes = std::fs::read(&media_path)
            .map_err(|e| format!("read {}: {e}", media_path.display()))?;
        let mime = match media_path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase()
            .as_str()
        {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            "svg" => "image/svg+xml",
            _ => "application/octet-stream",
        };
        Some(format!("data:{};base64,{}", mime, base64::encode(&bytes)))
    } else {
        None
    };

    let mut detail = MediaAssetDetail { asset, data_url };
    detail.asset.path = media_path.to_string_lossy().into_owned();
    Ok(detail)
}

#[tauri::command]
pub async fn media_assets_get(
    project_id: String,
    asset_id: String,
    include_data: bool,
) -> Result<MediaAssetDetail, String> {
    tokio::task::spawn_blocking(move || read_asset_impl(project_id, asset_id, include_data))
        .await
        .map_err(|e| format!("join error: {e:?}"))?
}

fn update_asset_impl(
    project_id: String,
    asset_id: String,
    patch: AssetPatch,
) -> Result<(), String> {
    let dir = ensure_asset_dir(&project_id)?;
    let assets = list_assets_impl(project_id)?;
    let asset = assets
        .into_iter()
        .find(|a| a.meta.id == asset_id)
        .ok_or_else(|| format!("asset not found: {asset_id}"))?;

    let media_path = dir.join(&asset.meta.file_name);
    let sidecar = sidecar_path(&media_path);
    let mut meta = load_sidecar(&sidecar)
        .unwrap_or_else(|| default_meta_for(&asset.meta.file_name, &asset_id));

    if let Some(v) = patch.prompt {
        meta.prompt = v;
    }
    if let Some(v) = patch.target_platform {
        meta.target_platform = v;
    }
    if let Some(v) = patch.campaign {
        meta.campaign = v;
    }
    if let Some(v) = patch.status {
        meta.status = normalize_status(&v);
    }
    if let Some(v) = patch.tags {
        meta.tags = v;
    }
    if let Some(v) = patch.notes {
        meta.notes = v;
    }
    meta.updated_at = now_iso();
    save_sidecar(&sidecar, &meta)
}

#[tauri::command]
pub async fn media_assets_update(
    project_id: String,
    asset_id: String,
    patch: AssetPatch,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || update_asset_impl(project_id, asset_id, patch))
        .await
        .map_err(|e| format!("join error: {e:?}"))?
}

fn import_asset_impl(
    project_id: String,
    source_path: String,
    meta: Option<AssetMeta>,
) -> Result<MediaAsset, String> {
    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err(format!("not a file: {source_path}"));
    }
    let ext = source
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !is_media_ext(&ext) {
        return Err(format!("unsupported media extension: {ext}"));
    }

    let dir = ensure_asset_dir(&project_id)?;
    let original_name = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| format!("asset.{}", ext));
    let safe_name = safe_filename(&original_name);
    let safe_name = if safe_name.is_empty() {
        format!("asset.{}", ext)
    } else {
        safe_name
    };

    let id = new_id();
    let unique_name = format!("{}_{}", id, safe_name);
    let dest = dir.join(&unique_name);
    std::fs::copy(&source, &dest)
        .map_err(|e| format!("copy {} -> {}: {e}", source.display(), dest.display()))?;

    let mut new_meta = meta.unwrap_or_else(|| default_meta_for(&unique_name, &id));
    new_meta.id = id;
    new_meta.file_name = unique_name.clone();
    new_meta.status = normalize_status(&new_meta.status);
    let now = now_iso();
    if new_meta.created_at.is_empty() {
        new_meta.created_at = now.clone();
    }
    if new_meta.updated_at.is_empty() {
        new_meta.updated_at = now;
    }

    let sidecar = sidecar_path(&dest);
    save_sidecar(&sidecar, &new_meta)?;

    Ok(MediaAsset {
        kind: media_kind(&ext),
        path: dest.to_string_lossy().into_owned(),
        meta: new_meta,
    })
}

#[tauri::command]
pub async fn media_assets_import(
    project_id: String,
    source_path: String,
    meta: Option<AssetMeta>,
) -> Result<MediaAsset, String> {
    tokio::task::spawn_blocking(move || import_asset_impl(project_id, source_path, meta))
        .await
        .map_err(|e| format!("join error: {e:?}"))?
}

fn delete_asset_impl(project_id: String, asset_id: String) -> Result<(), String> {
    let dir = ensure_asset_dir(&project_id)?;
    let assets = list_assets_impl(project_id)?;
    let asset = assets
        .into_iter()
        .find(|a| a.meta.id == asset_id)
        .ok_or_else(|| format!("asset not found: {asset_id}"))?;

    let media_path = dir.join(&asset.meta.file_name);
    let sidecar = sidecar_path(&media_path);
    let _ = std::fs::remove_file(&media_path);
    let _ = std::fs::remove_file(&sidecar);
    Ok(())
}

#[tauri::command]
pub async fn media_assets_delete(project_id: String, asset_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || delete_asset_impl(project_id, asset_id))
        .await
        .map_err(|e| format!("join error: {e:?}"))?
}

#[tauri::command]
pub async fn media_assets_ensure_dir(project_id: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let dir = ensure_asset_dir(&project_id)?;
        Ok(dir.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("join error: {e:?}"))?
}

// base64 helper (no external crate needed).
mod base64 {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    pub fn encode(input: &[u8]) -> String {
        let mut out = String::with_capacity((input.len() * 4 + 2) / 3);
        let mut chunks = input.chunks_exact(3);
        for chunk in &mut chunks {
            let n = ((chunk[0] as u32) << 16) | ((chunk[1] as u32) << 8) | (chunk[2] as u32);
            out.push(ALPHABET[((n >> 18) & 0x3F) as usize] as char);
            out.push(ALPHABET[((n >> 12) & 0x3F) as usize] as char);
            out.push(ALPHABET[((n >> 6) & 0x3F) as usize] as char);
            out.push(ALPHABET[(n & 0x3F) as usize] as char);
        }
        let rem = chunks.remainder();
        match rem.len() {
            1 => {
                let n = (rem[0] as u32) << 16;
                out.push(ALPHABET[((n >> 18) & 0x3F) as usize] as char);
                out.push(ALPHABET[((n >> 12) & 0x3F) as usize] as char);
                out.push('=');
                out.push('=');
            }
            2 => {
                let n = ((rem[0] as u32) << 16) | ((rem[1] as u32) << 8);
                out.push(ALPHABET[((n >> 18) & 0x3F) as usize] as char);
                out.push(ALPHABET[((n >> 12) & 0x3F) as usize] as char);
                out.push(ALPHABET[((n >> 6) & 0x3F) as usize] as char);
                out.push('=');
            }
            _ => {}
        }
        out
    }
}
