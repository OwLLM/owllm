// Inbound webhook bridges — WhatsApp Cloud API + LINE Messaging API. Unlike the
// outbound bridges these RECEIVE over HTTP, so they need a public URL: the user
// points a tunnel (cloudflared/ngrok) at the local port and uses it as the
// webhook callback in each provider's console.
//
// One tiny_http listener serves both, routed by path (/whatsapp, /line). Each
// inbound message is emitted to the frontend as owllm:webhook:inbound; the
// WebhookBridgeRunner dispatches it through the shared bridge core and replies
// via the REST commands below. LINE requests are authenticated by verifying the
// X-Line-Signature header (HMAC-SHA256 of the raw body with the channel secret)
// whenever a secret is configured — without it, anyone who finds the tunnel URL
// could drive the tool-executing agent.

use base64::Engine as _;
use sha2::{Digest, Sha256};
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
}

/// Base64(HMAC-SHA256(key, msg)) — the X-Line-Signature scheme. Hand-rolled on
/// `sha2` (already a dep) so we don't pull in the `hmac` crate.
fn hmac_sha256_base64(key: &[u8], msg: &[u8]) -> String {
    const BLOCK: usize = 64;
    let mut k = if key.len() > BLOCK {
        Sha256::digest(key).to_vec()
    } else {
        key.to_vec()
    };
    k.resize(BLOCK, 0);
    let ipad: Vec<u8> = k.iter().map(|b| b ^ 0x36).collect();
    let opad: Vec<u8> = k.iter().map(|b| b ^ 0x5c).collect();
    let inner = {
        let mut h = Sha256::new();
        h.update(&ipad);
        h.update(msg);
        h.finalize()
    };
    let mut h = Sha256::new();
    h.update(&opad);
    h.update(inner);
    base64::engine::general_purpose::STANDARD.encode(h.finalize())
}

/// Start (or restart on a new port) the shared inbound webhook server.
/// `whatsapp_verify_token` is checked on the WhatsApp GET verification probe;
/// `line_channel_secret` (when non-empty) authenticates LINE POSTs via the
/// X-Line-Signature header.
#[tauri::command]
pub fn webhook_start(
    app: AppHandle,
    port: u16,
    whatsapp_verify_token: String,
    line_channel_secret: String,
) -> Result<(), String> {
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
    let lsecret = line_channel_secret;
    let handle = std::thread::spawn(move || loop {
        if stop_loop.load(Ordering::SeqCst) {
            break;
        }
        match server.recv_timeout(std::time::Duration::from_millis(500)) {
            Ok(Some(req)) => handle_request(req, &app2, &vtoken, &lsecret),
            Ok(None) => continue,
            Err(_) => break,
        }
    });
    *guard = Some(WebhookServer {
        stop,
        _handle: handle,
        port,
    });
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
                    urlencoding::decode(k)
                        .map(|c| c.into_owned())
                        .unwrap_or_else(|_| k.to_string()),
                    urlencoding::decode(v)
                        .map(|c| c.into_owned())
                        .unwrap_or_else(|_| v.to_string()),
                );
            }
        }
    }
    map
}

fn emit(app: &AppHandle, platform: &str, from: &str, text: &str) {
    if from.is_empty() || text.is_empty() {
        return;
    }
    let _ = app.emit(
        "owllm:webhook:inbound",
        Inbound {
            platform: platform.to_string(),
            from: from.to_string(),
            text: text.to_string(),
        },
    );
}

fn handle_request(
    mut req: tiny_http::Request,
    app: &AppHandle,
    verify_token: &str,
    line_secret: &str,
) {
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
                        if let Some(msgs) = c.pointer("/value/messages").and_then(|m| m.as_array())
                        {
                            for m in msgs {
                                let from = m.get("from").and_then(|x| x.as_str()).unwrap_or("");
                                let text = m
                                    .pointer("/text/body")
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("");
                                emit(app, "whatsapp", from, text);
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
        // Authenticate: X-Line-Signature = Base64(HMAC-SHA256(channel_secret, raw body)).
        // Only enforced when a secret is configured (the card marks it optional),
        // but strongly recommended — the agent can run tools.
        if !line_secret.is_empty() {
            let provided = req
                .headers()
                .iter()
                .find(|h| h.field.equiv("X-Line-Signature"))
                .map(|h| h.value.as_str().to_string())
                .unwrap_or_default();
            let expected = hmac_sha256_base64(line_secret.as_bytes(), body.as_bytes());
            // Constant-time-ish: lengths then bytes. Reject on mismatch.
            if provided.as_bytes().len() != expected.as_bytes().len()
                || provided
                    .bytes()
                    .zip(expected.bytes())
                    .fold(0u8, |a, (x, y)| a | (x ^ y))
                    != 0
            {
                let _ = req.respond(
                    tiny_http::Response::from_string("bad signature").with_status_code(403),
                );
                return;
            }
        }
        // events[] : { type:"message", message:{ type:"text", text }, source:{ userId } }
        if let Some(events) = v.get("events").and_then(|e| e.as_array()) {
            for ev in events {
                if ev.get("type").and_then(|t| t.as_str()) == Some("message")
                    && ev.pointer("/message/type").and_then(|t| t.as_str()) == Some("text")
                {
                    let from = ev
                        .pointer("/source/userId")
                        .and_then(|x| x.as_str())
                        .unwrap_or("");
                    let text = ev
                        .pointer("/message/text")
                        .and_then(|x| x.as_str())
                        .unwrap_or("");
                    emit(app, "line", from, text);
                }
            }
        }
        let _ = req.respond(tiny_http::Response::from_string("OK"));
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
        return Err(format!(
            "whatsapp send HTTP {}: {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn line_push(
    channel_access_token: String,
    to: String,
    text: String,
) -> Result<(), String> {
    let resp = reqwest::Client::new()
        .post("https://api.line.me/v2/bot/message/push")
        .bearer_auth(&channel_access_token)
        .json(&json!({ "to": to, "messages": [{ "type": "text", "text": text }] }))
        .send()
        .await
        .map_err(|e| format!("line push: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "line push HTTP {}: {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::hmac_sha256_base64;

    // Cross-checked against Node:
    //   crypto.createHmac("sha256", key).update(body).digest("base64")
    // This is exactly the X-Line-Signature LINE sends, so a match here means
    // our verification accepts genuine LINE webhooks and rejects forgeries.
    #[test]
    fn line_signature_matches_reference() {
        let key = b"my_channel_secret";
        let body = br#"{"events":[{"type":"message","message":{"type":"text","text":"hi"},"source":{"userId":"U123"}}]}"#;
        assert_eq!(
            hmac_sha256_base64(key, body),
            "bl6F3b3mJ78T8AH8eBJCrDyyPqbrv1s4/1geOWcvewI="
        );
    }
}
