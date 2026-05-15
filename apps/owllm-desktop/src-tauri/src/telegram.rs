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
}

#[derive(Deserialize, Serialize)]
pub struct TelegramMessage {
    #[serde(default)]
    pub text: Option<String>,
    pub chat: TelegramChat,
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
