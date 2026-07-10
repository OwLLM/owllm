// Discord HTTP — server-side REST calls so the webview doesn't trip over
// CORS. discord.com/api does not send Access-Control-Allow-Origin, so a
// fetch() from React would silently fail. RECEIVING happens over the gateway
// WebSocket in the React DiscordBridgeRunner (WebSocket has no CORS); only the
// reply send + attachment download need Rust. Both are async commands the
// runner invoke()s exactly like any other Tauri command.

use serde::Serialize;

const API: &str = "https://discord.com/api/v10";

/// POST a plain-text message to a channel. `token` is the bot token (without
/// the "Bot " prefix — we add it). Discord's per-message limit is 2000 chars;
/// the JS side splits, so we just forward whatever chunk we're given.
#[tauri::command]
pub async fn discord_send_message(
    token: String,
    channel_id: String,
    content: String,
) -> Result<(), String> {
    let cli = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let url = format!("{API}/channels/{channel_id}/messages");
    let body = serde_json::json!({
        "content": if content.is_empty() { "(empty)".to_string() } else { content },
    });
    let resp = cli
        .post(&url)
        .header("Authorization", format!("Bot {token}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("sendMessage: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("discord sendMessage HTTP {status}: {txt}"));
    }
    Ok(())
}

#[derive(Serialize)]
pub struct DiscordFileDownload {
    pub mime: String,
    pub data_b64: String,
    pub size: i64,
}

/// Download a Discord attachment by its CDN URL and return base64 + a
/// best-effort MIME type. 20 MB cap matches the JS-side MAX_ATTACH_BYTES so we
/// never round-trip something we'd then reject. `expected_mime` is the
/// content_type Discord reported on the attachment (trusted first; URL
/// extension is the fallback).
#[tauri::command]
pub async fn discord_download_file(
    url: String,
    expected_mime: Option<String>,
) -> Result<DiscordFileDownload, String> {
    use base64::Engine as _;
    const MAX_BYTES: usize = 20 * 1024 * 1024;

    let cli = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = cli
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("download: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("discord download HTTP {status}: {txt}"));
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
    let mime = expected_mime
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| mime_from_url(&url));
    let data_b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(DiscordFileDownload {
        mime,
        data_b64,
        size: bytes.len() as i64,
    })
}

fn mime_from_url(url: &str) -> String {
    // Strip query string before reading the extension (CDN URLs carry ?ex=…).
    let path = url.split('?').next().unwrap_or(url);
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
