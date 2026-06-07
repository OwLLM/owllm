// Slack HTTP — server-side REST so the webview doesn't trip over CORS
// (slack.com/api sends no Access-Control-Allow-Origin). RECEIVING uses Socket
// Mode: we open a WebSocket URL here (apps.connections.open needs an
// app-level token, xapp-…) and the React SlackBridgeRunner connects to it
// (WebSocket is not CORS-gated) and ACKs envelopes. Sending a reply +
// downloading files (which need the bot token in an Authorization header) go
// through the commands below.

use serde::Serialize;

const API: &str = "https://slack.com/api";

#[derive(serde::Deserialize)]
struct OpenConnResp {
    ok: bool,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

/// Open a Socket Mode connection and return the wss URL the webview should
/// connect to. `app_token` is the app-level token (xapp-…) with
/// connections:write.
#[tauri::command]
pub async fn slack_open_connection(app_token: String) -> Result<String, String> {
    let cli = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = cli
        .post(format!("{API}/apps.connections.open"))
        .header("Authorization", format!("Bearer {app_token}"))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .send()
        .await
        .map_err(|e| format!("apps.connections.open: {e}"))?;
    let body = resp.text().await.map_err(|e| format!("body: {e}"))?;
    let parsed: OpenConnResp = serde_json::from_str(&body)
        .map_err(|e| format!("parse: {e} — body was: {body}"))?;
    if !parsed.ok {
        return Err(parsed.error.unwrap_or_else(|| "apps.connections.open returned ok=false".to_string()));
    }
    parsed.url.ok_or_else(|| "no url in apps.connections.open response".to_string())
}

#[derive(serde::Deserialize)]
struct PostMsgResp {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
}

/// POST chat.postMessage. `bot_token` is xoxb-…. `channel` is a channel id
/// (C…/G…/D…) or name.
#[tauri::command]
pub async fn slack_send_message(bot_token: String, channel: String, text: String) -> Result<(), String> {
    let cli = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = cli
        .post(format!("{API}/chat.postMessage"))
        .header("Authorization", format!("Bearer {bot_token}"))
        .json(&serde_json::json!({
            "channel": channel,
            "text": if text.is_empty() { "(empty)".to_string() } else { text },
        }))
        .send()
        .await
        .map_err(|e| format!("chat.postMessage: {e}"))?;
    let body = resp.text().await.map_err(|e| format!("body: {e}"))?;
    let parsed: PostMsgResp = serde_json::from_str(&body)
        .map_err(|e| format!("parse: {e} — body was: {body}"))?;
    if !parsed.ok {
        return Err(parsed.error.unwrap_or_else(|| "chat.postMessage returned ok=false".to_string()));
    }
    Ok(())
}

#[derive(Serialize)]
pub struct SlackFileDownload {
    pub mime: String,
    pub data_b64: String,
    pub size: i64,
}

/// Download a Slack file by url_private. Slack requires the bot token in an
/// Authorization header even for url_private. 20 MB cap matches the JS-side
/// MAX_ATTACH_BYTES.
#[tauri::command]
pub async fn slack_download_file(
    url: String,
    bot_token: String,
    expected_mime: Option<String>,
) -> Result<SlackFileDownload, String> {
    use base64::Engine as _;
    const MAX_BYTES: usize = 20 * 1024 * 1024;
    let cli = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = cli
        .get(&url)
        .header("Authorization", format!("Bearer {bot_token}"))
        .send()
        .await
        .map_err(|e| format!("download: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("slack download HTTP {status}: {txt}"));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("download bytes: {e}"))?;
    if bytes.len() > MAX_BYTES {
        return Err(format!("file too large: {} bytes (limit {})", bytes.len(), MAX_BYTES));
    }
    let mime = expected_mime
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let data_b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(SlackFileDownload { mime, data_b64, size: bytes.len() as i64 })
}
