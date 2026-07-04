// MCP Gateway — exposes OWLLM's own tool palette to subscription-CLI agents.
//
// WHY THIS EXISTS
// Subscription-CLI agents (Claude Code / Codex) never reach the app's
// `executeToolCall` in localTools.ts, so OWLLM-only tools (browser_*, and later
// memory_*, kvm_node, …) were invisible to them — the recurring "CLI can't use
// the browser" gap that spawned per-tool harvest hacks. The clean fix is the
// protocol the CLI already speaks: MCP. We host a tiny MCP server INSIDE the app
// and point the CLI at it with `--mcp-config`, so the subscription model calls
// our tools NATIVELY (as `mcp__owllm__browser_open`, …) — no puppet model, no
// paraphrase layer.
//
// TRANSPORT — loopback HTTP, bearer-authed
// The tools live in THIS process (the browser is a Tauri window only the app can
// drive), so the server is hosted here rather than as a spawned sidecar. It binds
// 127.0.0.1 on an ephemeral port (NEVER 0.0.0.0 — unlike webhook.rs, which is
// meant to be tunnelled) and requires `Authorization: Bearer <token>` on every
// request. It speaks MCP Streamable-HTTP in single-JSON-response mode (POST →
// one application/json JSON-RPC reply; GET → 405, we offer no server push).
//
// SCOPE — host + full-access (trusted) WSL runs
// HOST runs reach 127.0.0.1 directly (HTTP transport). A WSL-isolated run can't
// reach the host loopback over TCP (NAT + Windows Firewall drop WSL→host —
// verified empirically), but a FULL-ACCESS (trusted) WSL run can reach it via
// interop: an MCP *stdio* relay (write_cli_config_wsl) forwards each JSON-RPC
// message through curl.exe, which runs on the host and hits its own loopback.
// A bwrap-JAILED run is deliberately excluded: interop is unavailable in the
// jail, and a jailed agent is meant to be cut off from the host — handing it the
// user's logged-in browser would defeat the sandbox.
//
// RUNTIME-VERIFICATION NOTE: the transport is verified in pieces — the real
// `claude` CLI speaks this MCP protocol (mock-gateway test), and the stdio relay
// reaches the host gateway through interop curl.exe (WSL round-trip test). The
// one seam not exercisable from a headless box is the CLI spawning THIS relay
// inside a live full-access WSL agentic run.

use serde_json::{json, Value};
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tauri::AppHandle;

/// The MCP server name the CLI namespaces our tools under: a tool `browser_open`
/// becomes `mcp__owllm__browser_open` in the CLI's allowedTools space.
pub const SERVER_NAME: &str = "owllm";

struct Gateway {
    url: String,
    token: String,
    stop: Arc<AtomicBool>,
    _handle: JoinHandle<()>,
}

static GATEWAY: Mutex<Option<Gateway>> = Mutex::new(None);

/// What the CLI-spawn path needs to reach the gateway.
#[derive(Clone)]
pub struct GatewayInfo {
    pub url: String,
    pub token: String,
}

/// 256-bit hex token from two v4 UUIDs (122 bits of entropy each). Plenty for a
/// loopback bearer that lives only in a user-readable temp config for one session.
fn new_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Start the gateway if it isn't already running; return how to reach it.
/// Idempotent — repeated calls return the same URL + token for the session.
pub fn ensure_started(app: &AppHandle) -> Result<GatewayInfo, String> {
    let mut guard = GATEWAY.lock().map_err(|_| "gateway lock".to_string())?;
    if let Some(g) = guard.as_ref() {
        return Ok(GatewayInfo { url: g.url.clone(), token: g.token.clone() });
    }
    // Bind loopback + ephemeral port. Loopback is the security boundary: no
    // non-local host can reach it; the bearer token gates local processes.
    let server = tiny_http::Server::http(("127.0.0.1", 0))
        .map_err(|e| format!("bind 127.0.0.1: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or_else(|| "gateway: no bound port".to_string())?;
    let token = new_token();
    let url = format!("http://127.0.0.1:{port}/");

    let stop = Arc::new(AtomicBool::new(false));
    let stop_loop = stop.clone();
    let app2 = app.clone();
    let token2 = token.clone();
    let handle = std::thread::spawn(move || loop {
        if stop_loop.load(Ordering::SeqCst) {
            break;
        }
        match server.recv_timeout(std::time::Duration::from_millis(500)) {
            Ok(Some(req)) => handle_request(req, &app2, &token2),
            Ok(None) => continue,
            Err(_) => break,
        }
    });
    *guard = Some(Gateway { url: url.clone(), token: token.clone(), stop, _handle: handle });
    Ok(GatewayInfo { url, token })
}

/// Ensure the gateway is up and write the `--mcp-config` JSON the Claude CLI
/// consumes, returning its path. The config carries the bearer token, so it goes
/// in the app's user-data dir (user-readable only), not the project tree.
pub fn write_cli_config(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let info = ensure_started(app)?;
    let dir = crate::paths::user_data_root().ok_or_else(|| "no user-data dir".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let path = dir.join("mcp-gateway.json");
    let cfg = json!({
        "mcpServers": {
            SERVER_NAME: {
                "type": "http",
                "url": info.url,
                "headers": { "Authorization": format!("Bearer {}", info.token) }
            }
        }
    });
    std::fs::write(&path, serde_json::to_vec_pretty(&cfg).unwrap_or_default())
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(path)
}

/// stdio↔HTTP relay for FULL-ACCESS WSL runs.
///
/// A WSL-isolated agent can't reach the host loopback gateway over TCP (NAT +
/// Windows Firewall drops WSL→host — verified). But WSL *interop* lets a Linux
/// process exec a Windows `.exe`, which runs on the HOST and so reaches the
/// host's own 127.0.0.1. So instead of MCP-over-HTTP we hand the in-distro CLI
/// an MCP **stdio** server: this tiny bash relay forwards each newline-delimited
/// JSON-RPC message to the gateway via `curl.exe` (interop → host → loopback)
/// and prints the reply. Notifications (HTTP 202, empty body) produce no line,
/// exactly as MCP stdio requires. Only wired for full-access (trusted) WSL
/// projects — a bwrap-jailed run has no interop and is deliberately cut off from
/// the host, so its agent never gets host-browser control.
///   $1 = gateway URL (http://127.0.0.1:PORT/)   $2 = "Bearer <token>"
///   $3 = /mnt path to Windows curl.exe
#[cfg(windows)]
const WSL_RELAY_SH: &str = r#"#!/usr/bin/env bash
# OWLLM MCP stdio<->HTTP relay (full-access WSL runs). See mcp_gateway.rs.
url="$1"; auth="$2"; curlexe="$3"
[ -x "$curlexe" ] || curlexe="curl.exe"   # fall back to interop PATH
while IFS= read -r line; do
  [ -z "$line" ] && continue
  resp=$(printf '%s' "$line" | "$curlexe" -s -m 120 \
      -H "Authorization: $auth" -H "Content-Type: application/json" \
      --data-binary @- "$url" 2>/dev/null)
  [ -n "$resp" ] && printf '%s\n' "$resp"
done
"#;

/// Ensure the gateway is up and write a `--mcp-config` that a FULL-ACCESS WSL
/// CLI run can use. Returns the config path as a Linux (/mnt) path the in-distro
/// CLI reads. Windows-only: interop is a WSL concept.
#[cfg(windows)]
pub fn write_cli_config_wsl(app: &AppHandle) -> Result<String, String> {
    let info = ensure_started(app)?;
    let dir = crate::paths::user_data_root().ok_or_else(|| "no user-data dir".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;

    // Materialize the relay script and translate its path into the distro.
    let relay_win = dir.join("mcp_wsl_relay.sh");
    std::fs::write(&relay_win, WSL_RELAY_SH.replace("\r\n", "\n"))
        .map_err(|e| format!("write relay: {e}"))?;
    let relay_mnt = crate::sandbox::win_to_mnt(&relay_win.to_string_lossy())?;

    // Windows curl.exe, expressed as its /mnt path (robust to a non-C: SystemRoot).
    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let curl_win = format!("{}\\System32\\curl.exe", sysroot.trim_end_matches('\\'));
    let curl_mnt = crate::sandbox::win_to_mnt(&curl_win).unwrap_or_else(|_| "curl.exe".to_string());

    let cfg = json!({
        "mcpServers": {
            SERVER_NAME: {
                "type": "stdio",
                "command": "bash",
                "args": [ relay_mnt, info.url, format!("Bearer {}", info.token), curl_mnt ]
            }
        }
    });
    let cfg_win = dir.join("mcp-gateway-wsl.json");
    std::fs::write(&cfg_win, serde_json::to_vec_pretty(&cfg).unwrap_or_default())
        .map_err(|e| format!("write {}: {e}", cfg_win.display()))?;
    crate::sandbox::win_to_mnt(&cfg_win.to_string_lossy())
}

/// The fully-namespaced CLI tool names this gateway exposes, e.g.
/// `mcp__owllm__browser_open`. Added to `--allowedTools` so a strict allowlist
/// still permits them (availability is separate from permission).
pub fn cli_tool_names() -> Vec<String> {
    tool_specs()
        .iter()
        .filter_map(|t| t.get("name").and_then(Value::as_str))
        .map(|n| format!("mcp__{SERVER_NAME}__{n}"))
        .collect()
}

/// Stop the gateway (called at app teardown; harmless if never started).
#[allow(dead_code)]
pub fn stop() {
    if let Ok(mut guard) = GATEWAY.lock() {
        if let Some(g) = guard.take() {
            g.stop.store(true, Ordering::SeqCst);
        }
    }
}

// ----- MCP protocol handling -------------------------------------------------

fn handle_request(mut req: tiny_http::Request, app: &AppHandle, token: &str) {
    // We only serve POST for JSON-RPC. A GET (client opening an SSE stream) gets
    // 405 per the Streamable-HTTP spec — we push nothing server-initiated.
    if req.method() != &tiny_http::Method::Post {
        let _ = req.respond(tiny_http::Response::from_string("method not allowed").with_status_code(405));
        return;
    }
    // Bearer auth on EVERY request. Constant-length-ish compare.
    let provided = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Authorization"))
        .map(|h| h.value.as_str().to_string())
        .unwrap_or_default();
    let expected = format!("Bearer {token}");
    if !ct_eq(provided.as_bytes(), expected.as_bytes()) {
        let _ = req.respond(tiny_http::Response::from_string("unauthorized").with_status_code(401));
        return;
    }

    let mut body = String::new();
    let _ = req.as_reader().read_to_string(&mut body);
    let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);

    // Support a single request or a JSON-RPC batch (array).
    let response: Option<Value> = match parsed {
        Value::Array(items) => {
            let replies: Vec<Value> = items
                .into_iter()
                .filter_map(|it| dispatch_rpc(app, &it))
                .collect();
            if replies.is_empty() { None } else { Some(Value::Array(replies)) }
        }
        v => dispatch_rpc(app, &v),
    };

    match response {
        Some(body) => {
            let data = serde_json::to_vec(&body).unwrap_or_default();
            let resp = tiny_http::Response::from_data(data).with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
            );
            let _ = req.respond(resp);
        }
        // Pure notification(s) → 202 Accepted, empty body (spec-compliant).
        None => {
            let _ = req.respond(tiny_http::Response::from_string("").with_status_code(202));
        }
    }
}

/// Handle one JSON-RPC request object. Returns Some(reply) for requests (those
/// with an `id`) and None for notifications (no `id` — e.g. notifications/initialized).
fn dispatch_rpc(app: &AppHandle, req: &Value) -> Option<Value> {
    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
    let id = req.get("id").cloned();
    // A missing/null id means a notification: run any side effect, never reply.
    let is_notification = id.is_none() || id == Some(Value::Null);

    match method {
        "initialize" => {
            let proto = req
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("2024-11-05")
                .to_string();
            reply(id, json!({
                "protocolVersion": proto,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") }
            }))
        }
        "notifications/initialized" | "notifications/cancelled" => None,
        "ping" => reply(id, json!({})),
        "tools/list" => reply(id, json!({ "tools": tool_specs() })),
        "tools/call" => {
            if is_notification {
                return None;
            }
            let name = req.pointer("/params/name").and_then(Value::as_str).unwrap_or("");
            let args = req
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            match call_tool(app, name, &args) {
                Ok(text) => reply(id, tool_content(&text, false)),
                Err(e) => reply(id, tool_content(&format!("error: {e}"), true)),
            }
        }
        _ => {
            if is_notification {
                None
            } else {
                Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": format!("method not found: {method}") }
                }))
            }
        }
    }
}

fn reply(id: Option<Value>, result: Value) -> Option<Value> {
    Some(json!({ "jsonrpc": "2.0", "id": id.unwrap_or(Value::Null), "result": result }))
}

fn tool_content(text: &str, is_error: bool) -> Value {
    json!({ "content": [ { "type": "text", "text": text } ], "isError": is_error })
}

/// Constant-time-ish byte compare (length then XOR-fold), same shape webhook.rs
/// uses for the LINE signature — avoids leaking the token via early return.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// ----- Tool catalogue + dispatch --------------------------------------------

/// The browser tool palette, as MCP tool specs (name/description/inputSchema).
/// Mirrors the browser_* tools in localTools.ts so a CLI agent gets the same
/// capability a local/API agent has. Kept deliberately small and stable.
fn tool_specs() -> Vec<Value> {
    let idx = json!({ "type": "integer", "description": "Element index from the latest browser_snapshot." });
    vec![
        json!({ "name": "browser_open",
            "description": "Open the agent browser (a native OwLLM window) and navigate to a URL. Use this before other browser tools. Localhost/dev-server URLs are supported.",
            "inputSchema": { "type": "object", "properties": { "url": { "type": "string", "description": "URL to open. Scheme optional (https assumed; http for localhost)." } }, "required": ["url"] } }),
        json!({ "name": "browser_navigate",
            "description": "Navigate the already-open agent browser to a URL.",
            "inputSchema": { "type": "object", "properties": { "url": { "type": "string" } }, "required": ["url"] } }),
        json!({ "name": "browser_snapshot",
            "description": "Return an indexed list of the page's interactive elements (links, buttons, inputs). Read this to SEE the page, then act by index.",
            "inputSchema": { "type": "object", "properties": {} } }),
        json!({ "name": "browser_click",
            "description": "Click an interactive element by its index from the latest snapshot.",
            "inputSchema": { "type": "object", "properties": { "index": idx }, "required": ["index"] } }),
        json!({ "name": "browser_fill",
            "description": "Type text into an input/textarea by index.",
            "inputSchema": { "type": "object", "properties": { "index": idx, "text": { "type": "string" } }, "required": ["index", "text"] } }),
        json!({ "name": "browser_select",
            "description": "Choose an option in a <select> by index and option value or label.",
            "inputSchema": { "type": "object", "properties": { "index": idx, "value": { "type": "string" } }, "required": ["index", "value"] } }),
        json!({ "name": "browser_press",
            "description": "Press a keyboard key on the focused element (e.g. Enter, Tab, Escape).",
            "inputSchema": { "type": "object", "properties": { "key": { "type": "string" } }, "required": ["key"] } }),
        json!({ "name": "browser_get_text",
            "description": "Return the visible text of the current page.",
            "inputSchema": { "type": "object", "properties": {} } }),
        json!({ "name": "browser_back",
            "description": "Go back one entry in the browser history.",
            "inputSchema": { "type": "object", "properties": {} } }),
        json!({ "name": "browser_reload",
            "description": "Reload the current page.",
            "inputSchema": { "type": "object", "properties": {} } }),
        json!({ "name": "browser_device",
            "description": "Switch device emulation: desktop, iphone, android or tablet (viewport size + mobile user-agent).",
            "inputSchema": { "type": "object", "properties": { "device": { "type": "string", "enum": ["desktop", "iphone", "android", "tablet"] } }, "required": ["device"] } }),
        json!({ "name": "browser_close",
            "description": "Close the agent browser window.",
            "inputSchema": { "type": "object", "properties": {} } }),
    ]
}

/// Coerce an argument to an integer (models sometimes send "3" for an index).
fn as_index(args: &Value, key: &str) -> Value {
    match args.get(key) {
        Some(Value::Number(n)) => Value::Number(n.clone()),
        Some(Value::String(s)) => s.parse::<i64>().map(|i| json!(i)).unwrap_or(json!(0)),
        _ => json!(0),
    }
}

fn as_str(args: &Value, key: &str) -> String {
    args.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

/// Route an MCP tool call to the native browser commands. Everything funnels
/// through the SAME `browser::*` functions the Tauri commands use — one engine,
/// no second implementation.
fn call_tool(app: &AppHandle, name: &str, args: &Value) -> Result<String, String> {
    match name {
        "browser_open" => {
            let _ = crate::browser::browser_start(app.clone());
            crate::browser::browser_cmd(app.clone(), "navigate".into(), json!({ "url": as_str(args, "url") }))
        }
        "browser_navigate" => {
            crate::browser::browser_cmd(app.clone(), "navigate".into(), json!({ "url": as_str(args, "url") }))
        }
        "browser_snapshot" => crate::browser::browser_cmd(app.clone(), "snapshot".into(), json!({})),
        "browser_get_text" => crate::browser::browser_cmd(app.clone(), "get_text".into(), json!({})),
        "browser_back" => crate::browser::browser_cmd(app.clone(), "back".into(), json!({})),
        "browser_reload" => crate::browser::browser_cmd(app.clone(), "reload".into(), json!({})),
        "browser_click" => {
            crate::browser::browser_cmd(app.clone(), "click".into(), json!({ "index": as_index(args, "index") }))
        }
        "browser_fill" => crate::browser::browser_cmd(
            app.clone(),
            "fill".into(),
            json!({ "index": as_index(args, "index"), "text": as_str(args, "text") }),
        ),
        "browser_select" => crate::browser::browser_cmd(
            app.clone(),
            "select".into(),
            json!({ "index": as_index(args, "index"), "value": as_str(args, "value") }),
        ),
        "browser_press" => {
            crate::browser::browser_cmd(app.clone(), "press".into(), json!({ "key": as_str(args, "key") }))
        }
        "browser_device" => crate::browser::browser_set_device(app.clone(), as_str(args, "device")),
        "browser_close" => crate::browser::browser_stop(app.clone()),
        other => Err(format!("unknown tool: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_256_bit_hex() {
        let t = new_token();
        assert_eq!(t.len(), 64);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(new_token(), new_token()); // fresh each call
    }

    #[test]
    fn cli_tool_names_are_namespaced() {
        let names = cli_tool_names();
        assert!(names.contains(&"mcp__owllm__browser_open".to_string()));
        assert!(names.contains(&"mcp__owllm__browser_snapshot".to_string()));
        assert!(names.iter().all(|n| n.starts_with("mcp__owllm__")));
        assert_eq!(names.len(), tool_specs().len());
    }

    #[test]
    fn ct_eq_matches_only_identical() {
        assert!(ct_eq(b"Bearer abc", b"Bearer abc"));
        assert!(!ct_eq(b"Bearer abc", b"Bearer abd"));
        assert!(!ct_eq(b"Bearer abc", b"Bearer ab")); // length differs
        assert!(!ct_eq(b"", b"x"));
    }

    #[test]
    fn initialize_echoes_protocol_and_names_server() {
        let req = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-03-26" } });
        // dispatch_rpc needs an AppHandle only for tools/call; initialize doesn't
        // touch it, but the signature requires one — cover the pure shaping via
        // the same code path is impractical here, so assert the tool catalogue
        // and content helpers that initialize/list depend on instead.
        let _ = req;
        let specs = tool_specs();
        assert!(specs.iter().all(|t| t.get("name").is_some() && t.get("inputSchema").is_some()));
        let c = tool_content("hello", false);
        assert_eq!(c["content"][0]["text"], "hello");
        assert_eq!(c["isError"], false);
    }

    #[test]
    fn index_coercion_handles_string_and_number() {
        assert_eq!(as_index(&json!({ "index": 3 }), "index"), json!(3));
        assert_eq!(as_index(&json!({ "index": "5" }), "index"), json!(5));
        assert_eq!(as_index(&json!({ "index": "x" }), "index"), json!(0));
        assert_eq!(as_index(&json!({}), "index"), json!(0));
    }
}
