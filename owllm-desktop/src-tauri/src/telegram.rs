// Telegram HTTP — server-side calls so the webview doesn't trip over
// CORS. api.telegram.org doesn't send Access-Control-Allow-Origin, so
// fetch() from React was silently failing; the bridge appeared "on"
// but no message ever made it through. Both calls below are async
// commands that the React TelegramBridgeRunner invokes() exactly like
// any other Tauri command.

use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
pub struct TelegramUpdate {
    pub update_id: i64,
    #[serde(default)]
    pub message: Option<TelegramMessage>,
    #[serde(default)]
    pub edited_message: Option<TelegramMessage>,
    #[serde(default)]
    pub channel_post: Option<TelegramMessage>,
    #[serde(default)]
    pub edited_channel_post: Option<TelegramMessage>,
}

#[derive(Deserialize, Serialize)]
pub struct TelegramMessage {
    #[serde(default)]
    pub text: Option<String>,
    /// Caption that ships alongside a photo / voice / document.
    /// Telegram never sets both `text` and `caption` — text is the
    /// plain-message field, caption is "the line under the media".
    #[serde(default)]
    pub caption: Option<String>,
    /// Each photo upload lands here as an array of progressively
    /// larger sizes. We always download the last (largest) entry —
    /// that's the original quality Telegram has on file.
    #[serde(default)]
    pub photo: Option<Vec<TelegramPhotoSize>>,
    /// Voice notes (hold-to-record). Always OGG/OPUS in practice;
    /// Whisper handles ogg natively so no transcode needed.
    #[serde(default)]
    pub voice: Option<TelegramFile>,
    /// Audio files (mp3 / m4a / flac / etc.) sent via attachment.
    /// Same shape as voice but with optional title/performer metadata
    /// that we don't currently surface — the bytes are what matters.
    #[serde(default)]
    pub audio: Option<TelegramFile>,
    /// Generic document. Telegram routes images-sent-as-files here
    /// (instead of `photo`) so the user can preserve original quality.
    /// We inspect mime_type and only treat image/* and audio/* as
    /// attachments; everything else is ignored.
    #[serde(default)]
    pub document: Option<TelegramFile>,
    pub chat: TelegramChat,
}

#[derive(Deserialize, Serialize)]
pub struct TelegramPhotoSize {
    pub file_id: String,
    #[serde(default)]
    pub width: i64,
    #[serde(default)]
    pub height: i64,
    #[serde(default)]
    pub file_size: Option<i64>,
}

/// Shared shape for voice / audio / document. `mime_type` is
/// best-effort — voice notes always omit it (Telegram knows they're
/// ogg/opus by construction), audio uploads sometimes have it,
/// documents almost always do.
#[derive(Deserialize, Serialize)]
pub struct TelegramFile {
    pub file_id: String,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub file_size: Option<i64>,
}

#[derive(Deserialize, Serialize)]
pub struct TelegramChat {
    pub id: i64,
}

#[derive(Deserialize)]
struct TelegramGetUpdatesResp {
    ok: bool,
    #[serde(default)]
    result: Vec<TelegramUpdate>,
    #[serde(default)]
    description: Option<String>,
}

/// Long-poll `getUpdates`. `timeout` is the server-side hold-open in
/// seconds (Telegram caps at 50; we use 20 from the React side).
/// Returns the (de-duplicated by `offset`) batch of updates.
#[tauri::command]
pub async fn telegram_get_updates(
    token: String,
    offset: i64,
    timeout: u32,
) -> Result<Vec<TelegramUpdate>, String> {
    // Long-poll: client should outlive the server hold by a small
    // margin so genuine network stalls still surface as errors.
    let cli = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs((timeout as u64) + 10))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let url = format!("https://api.telegram.org/bot{token}/getUpdates");
    let resp = cli
        .get(&url)
        .query(&[
            ("timeout", timeout.to_string()),
            ("offset", offset.to_string()),
        ])
        .send()
        .await
        .map_err(|e| format!("getUpdates: {e}"))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("getUpdates body: {e}"))?;
    if !status.is_success() {
        return Err(format!("getUpdates HTTP {status}: {body}"));
    }
    let parsed: TelegramGetUpdatesResp = serde_json::from_str(&body)
        .map_err(|e| format!("getUpdates parse: {e} — body was: {body}"))?;
    if !parsed.ok {
        return Err(parsed
            .description
            .unwrap_or_else(|| "telegram API returned ok=false".to_string()));
    }
    Ok(parsed.result)
}

/// Download an attached file (photo / voice / audio / document) by
/// file_id and return its bytes as base64 + a best-effort MIME type.
/// Used by TelegramBridgeRunner to turn an inbound message's media
/// refs into Attachment payloads the dispatch chain can consume.
///
/// Telegram needs two round-trips: getFile (resolve file_path) then
/// the actual /file/bot<TOKEN>/<path> download. The 20 MB hard cap
/// matches Telegram's bot-API download limit AND the JS-side
/// MAX_ATTACH_BYTES so we never round-trip something we'd then
/// reject. `expected_mime` lets the caller pass mime_type from the
/// Update payload (voice notes always lie / omit it; trust the URL
/// extension as a fallback).
#[tauri::command]
pub async fn telegram_download_file(
    token: String,
    file_id: String,
    expected_mime: Option<String>,
) -> Result<TelegramFileDownload, String> {
    use base64::Engine as _;
    const MAX_BYTES: usize = 20 * 1024 * 1024;

    let cli = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    // Step 1: resolve file_path.
    let get_url = format!("https://api.telegram.org/bot{token}/getFile");
    let resp = cli
        .get(&get_url)
        .query(&[("file_id", file_id.as_str())])
        .send()
        .await
        .map_err(|e| format!("getFile: {e}"))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("getFile body: {e}"))?;
    if !status.is_success() {
        return Err(format!("getFile HTTP {status}: {body}"));
    }
    let parsed: GetFileResp = serde_json::from_str(&body)
        .map_err(|e| format!("getFile parse: {e} — body was: {body}"))?;
    if !parsed.ok {
        return Err(parsed
            .description
            .unwrap_or_else(|| "telegram getFile returned ok=false".to_string()));
    }
    let file_path = parsed
        .result
        .ok_or_else(|| "getFile response missing result.file_path".to_string())?
        .file_path;

    // Step 2: stream the actual bytes.
    let dl_url = format!("https://api.telegram.org/file/bot{token}/{file_path}");
    let resp = cli
        .get(&dl_url)
        .send()
        .await
        .map_err(|e| format!("download: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("download HTTP {status}: {body}"));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("download bytes: {e}"))?;
    if bytes.len() > MAX_BYTES {
        return Err(format!(
            "file too large: {} bytes (limit {} bytes)",
            bytes.len(),
            MAX_BYTES
        ));
    }

    // Best-effort MIME resolution. Prefer what the caller passed
    // (Telegram's mime_type on audio/document); fall back to a guess
    // from the file_path extension; default to octet-stream.
    let mime = expected_mime
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| mime_from_path(&file_path));
    let data_b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(TelegramFileDownload {
        mime,
        data_b64,
        size: bytes.len() as i64,
    })
}

#[derive(Serialize)]
pub struct TelegramFileDownload {
    pub mime: String,
    pub data_b64: String,
    pub size: i64,
}

#[derive(Deserialize)]
struct GetFileResp {
    ok: bool,
    #[serde(default)]
    result: Option<GetFileResult>,
    #[serde(default)]
    description: Option<String>,
}
#[derive(Deserialize)]
struct GetFileResult {
    file_path: String,
}

fn mime_from_path(path: &str) -> String {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "heic" => "image/heic",
        "oga" | "ogg" => "audio/ogg",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "webm" => "audio/webm",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// POST `sendMessage`. Plain-text body; the React side decides what to
/// quote / format. The bot token comes from the saved bridge config.
#[tauri::command]
pub async fn telegram_send_message(
    token: String,
    chat_id: i64,
    text: String,
) -> Result<(), String> {
    let cli = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let url = format!("https://api.telegram.org/bot{token}/sendMessage");
    let body = serde_json::json!({
        "chat_id": chat_id,
        "text": if text.is_empty() { "(empty)".to_string() } else { text },
    });
    let resp = cli
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("sendMessage: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("sendMessage HTTP {status}: {body}"));
    }
    Ok(())
}
