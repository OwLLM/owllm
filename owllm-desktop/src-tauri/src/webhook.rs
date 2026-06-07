// Inbound webhook bridges — WhatsApp Cloud API, LINE Messaging API, KakaoTalk
// skill server. Unlike the outbound bridges these RECEIVE over HTTP, so they
// need a public URL: the user points a tunnel (cloudflared/ngrok) at the local
// port and uses it as the webhook callback in each provider's console.
//
// One tiny_http listener serves all three, routed by path (/whatsapp, /line,
// /kakao). Each inbound message is emitted to the frontend as
// owllm:webhook:inbound; the WebhookBridgeRunner dispatches it through the
// shared bridge core and replies via the REST commands below. KakaoTalk's
// skill protocol wants the answer asynchronously, so we ack with useCallback
// and post the real reply to its callbackUrl when ready.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

struct WebhookServer {
    stop: Arc<AtomicBool>,
    _handle: JoinHandle<()>,
    port: u16,
}

static SERVER: Mutex<Option<WebhookServer>> = Mutex::new(None);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Inbound {
    platform: String,
    from: String,
    text: String,
    callback_url: String, // KakaoTalk only
}

/// Start (or restart on a new port) the shared inbound webhook server.
/// `whatsapp_verify_token` is checked on the WhatsApp GET verification probe.
#[tauri::command]
pub fn webhook_start(app: AppHandle, port: u16, whatsapp_verify_token: String) -> Result<(), String> {
    let mut guard = SERVER.lock().map_err(|_| "lock".to_string())?;
    if let Some(s) = guard.as_ref() {
        if s.port == port {
            return Ok(()); // already listening on this port
        }
    }
    if let Some(s) = guard.take() {
        s.stop.store(true, Ordering::SeqCst); // old loop exits within 500ms
    }
    let server = tiny_http::Server::http(("0.0.0.0", port))
        .map_err(|e| format!("bind 0.0.0.0:{port}: {e}"))?;
    let stop = Arc::new(AtomicBool::new(false));
    let stop_loop = stop.clone();
    let app2 = app.clone();
    let vtoken = whatsapp_verify_token;
    let handle = std::thread::spawn(move || {
        loop {
            if stop_loop.load(Ordering::SeqCst) {
                break;
            }
            match server.recv_timeout(std::time::Duration::from_millis(500)) {
                Ok(Some(req)) => handle_request(req, &app2, &vtoken),
                Ok(None) => continue,
                Err(_) => break,
            }
        }
    });
    *guard = Some(WebhookServer { stop, _handle: handle, port });
    Ok(())
}

#[tauri::command]
pub fn webhook_stop() -> Result<(), String> {
    let mut guard = SERVER.lock().map_err(|_| "lock".to_string())?;
    if let Some(s) = guard.take() {
        s.stop.store(true, Ordering::SeqCst);
    }
    Ok(())
}

fn parse_query(url: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    if let Some(q) = url.split('?').nth(1) {
        for pair in q.split('&') {
            let mut it = pair.splitn(2, '=');
            if let (Some(k), Some(v)) = (it.next(), it.next()) {
                map.insert(
                    urlencoding::decode(k).map(|c| c.into_owned()).unwrap_or_else(|_| k.to_string()),
                    urlencoding::decode(v).map(|c| c.into_owned()).unwrap_or_else(|_| v.to_string()),
                );
            }
        }
    }
    map
}

fn json_header() -> tiny_http::Header {
    tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()
}

fn emit(app: &AppHandle, platform: &str, from: &str, text: &str, callback_url: &str) {
    if from.is_empty() || (text.is_empty() && platform != "kakao") {
        return;
    }
    let _ = app.emit(
        "owllm:webhook:inbound",
        Inbound {
            platform: platform.to_string(),
            from: from.to_string(),
            text: text.to_string(),
            callback_url: callback_url.to_string(),
        },
    );
}

fn handle_request(mut req: tiny_http::Request, app: &AppHandle, verify_token: &str) {
    let method = req.method().as_str().to_uppercase();
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("").to_string();

    // WhatsApp webhook verification (Meta GETs the callback URL once).
    if method == "GET" && path.starts_with("/whatsapp") {
        let q = parse_query(&url);
        let ok = !verify_token.is_empty()
            && q.get("hub.verify_token").map(|s| s.as_str()) == Some(verify_token);
        let resp = if ok {
            tiny_http::Response::from_string(q.get("hub.challenge").cloned().unwrap_or_default())
        } else {
            tiny_http::Response::from_string("forbidden").with_status_code(403)
        };
        let _ = req.respond(resp);
        return;
    }

    let mut body = String::new();
    let _ = req.as_reader().read_to_string(&mut body);
    let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);

    if method == "POST" && path.starts_with("/whatsapp") {
        // entry[].changes[].value.messages[] : { from, text:{ body } }
        if let Some(entries) = v.get("entry").and_then(|e| e.as_array()) {
            for e in entries {
                if let Some(changes) = e.get("changes").and_then(|c| c.as_array()) {
                    for c in changes {
                        if let Some(msgs) = c.pointer("/value/messages").and_then(|m| m.as_array()) {
                            for m in msgs {
                                let from = m.get("from").and_then(|x| x.as_str()).unwrap_or("");
                                let text = m.pointer("/text/body").and_then(|x| x.as_str()).unwrap_or("");
                                emit(app, "whatsapp", from, text, "");
                            }
                        }
                    }
                }
            }
        }
        let _ = req.respond(tiny_http::Response::from_string("EVENT_RECEIVED"));
        return;
    }

    if method == "POST" && path.starts_with("/line") {
        // events[] : { type:"message", message:{ type:"text", text }, source:{ userId } }
        if let Some(events) = v.get("events").and_then(|e| e.as_array()) {
            for ev in events {
                if ev.get("type").and_then(|t| t.as_str()) == Some("message")
                    && ev.pointer("/message/type").and_then(|t| t.as_str()) == Some("text")
                {
                    let from = ev.pointer("/source/userId").and_then(|x| x.as_str()).unwrap_or("");
                    let text = ev.pointer("/message/text").and_then(|x| x.as_str()).unwrap_or("");
                    emit(app, "line", from, text, "");
                }
            }
        }
        let _ = req.respond(tiny_http::Response::from_string("OK"));
        return;
    }

    if method == "POST" && path.starts_with("/kakao") {
        // { userRequest: { utterance, user:{ id }, callbackUrl } }
        let from = v.pointer("/userRequest/user/id").and_then(|x| x.as_str()).unwrap_or("");
        let text = v.pointer("/userRequest/utterance").and_then(|x| x.as_str()).unwrap_or("");
        let cb = v.pointer("/userRequest/callbackUrl").and_then(|x| x.as_str()).unwrap_or("");
        emit(app, "kakao", from, text, cb);
        // Ack asynchronously — the real answer is POSTed to callbackUrl later.
        let resp = tiny_http::Response::from_string(r#"{"version":"2.0","useCallback":true}"#)
            .with_header(json_header());
        let _ = req.respond(resp);
        return;
    }

    let _ = req.respond(tiny_http::Response::from_string("ok"));
}

// ---- Reply commands (REST; CORS-blocked for the webview, so server-side) ----

#[tauri::command]
pub async fn whatsapp_send(
    access_token: String,
    phone_number_id: String,
    to: String,
    text: String,
) -> Result<(), String> {
    let url = format!("https://graph.facebook.com/v18.0/{phone_number_id}/messages");
    let resp = reqwest::Client::new()
        .post(&url)
        .bearer_auth(&access_token)
        .json(&json!({ "messaging_product": "whatsapp", "to": to, "type": "text", "text": { "body": text } }))
        .send()
        .await
        .map_err(|e| format!("whatsapp send: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("whatsapp send HTTP {}: {}", resp.status(), resp.text().await.unwrap_or_default()));
    }
    Ok(())
}

#[tauri::command]
pub async fn line_push(channel_access_token: String, to: String, text: String) -> Result<(), String> {
    let resp = reqwest::Client::new()
        .post("https://api.line.me/v2/bot/message/push")
        .bearer_auth(&channel_access_token)
        .json(&json!({ "to": to, "messages": [{ "type": "text", "text": text }] }))
        .send()
        .await
        .map_err(|e| format!("line push: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("line push HTTP {}: {}", resp.status(), resp.text().await.unwrap_or_default()));
    }
    Ok(())
}

#[tauri::command]
pub async fn kakao_callback(callback_url: String, text: String) -> Result<(), String> {
    if callback_url.is_empty() {
        return Err("no Kakao callbackUrl for this user (it expires quickly — reply was too slow)".to_string());
    }
    let resp = reqwest::Client::new()
        .post(&callback_url)
        .json(&json!({ "version": "2.0", "template": { "outputs": [{ "simpleText": { "text": text } }] } }))
        .send()
        .await
        .map_err(|e| format!("kakao callback: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("kakao callback HTTP {}: {}", resp.status(), resp.text().await.unwrap_or_default()));
    }
    Ok(())
}
