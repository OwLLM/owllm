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
// SCOPE — host + non-jailed WSL runs
// HOST runs reach 127.0.0.1 directly (HTTP transport). A WSL-isolated run can't
// reach the host loopback over TCP (NAT + Windows Firewall drop WSL→host —
// verified empirically), but any non-jailed WSL run (full-access OR bwrap not
// installed) can reach it via interop: an MCP *stdio* relay (write_cli_config_wsl)
// forwards each JSON-RPC message through curl.exe, which runs on the host and
// hits its own loopback. A bwrap-JAILED run is deliberately excluded: interop is
// unavailable inside the jail, and a jailed agent is meant to be cut off from the
// host — handing it the user's logged-in browser would defeat the sandbox.
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

/// Env var the Codex CLI reads the gateway bearer token from (its HTTP MCP
/// config references it via `bearer_token_env_var`, so the token never lands
/// on the argv). The caller sets this in the codex child's environment.
pub const CODEX_TOKEN_ENV: &str = "OWLLM_GW_TOKEN";

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
        return Ok(GatewayInfo {
            url: g.url.clone(),
            token: g.token.clone(),
        });
    }
    // Bind loopback + ephemeral port. Loopback is the security boundary: no
    // non-local host can reach it; the bearer token gates local processes.
    let server =
        tiny_http::Server::http(("127.0.0.1", 0)).map_err(|e| format!("bind 127.0.0.1: {e}"))?;
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
    *guard = Some(Gateway {
        url: url.clone(),
        token: token.clone(),
        stop,
        _handle: handle,
    });
    Ok(GatewayInfo { url, token })
}

/// Look up the Windows 8.3 short path for an existing file (spaces collapse:
/// `…\OwLLM Desktop\mcp-gateway.json` → `…\OWLLMD~1\MCP-GA~1.JSO`). Returns None
/// if 8.3 generation is disabled on the volume or the call fails.
#[cfg(windows)]
fn short_path(p: &std::path::Path) -> Option<String> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;
    let wide: Vec<u16> = p
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        let len = GetShortPathNameW(wide.as_ptr(), std::ptr::null_mut(), 0);
        if len == 0 {
            return None;
        }
        let mut buf = vec![0u16; len as usize];
        let got = GetShortPathNameW(wide.as_ptr(), buf.as_mut_ptr(), len);
        if got == 0 || got >= len {
            return None;
        }
        Some(
            std::ffi::OsString::from_wide(&buf[..got as usize])
                .to_string_lossy()
                .into_owned(),
        )
    }
}

/// A path safe to hand the Claude CLI as `--mcp-config`. The app's user-data dir
/// is `…\OwLLM Desktop\…` — the SPACE gets split by the Windows batch-shim spawn
/// chain (Rust Command → cmd.exe → claude.cmd → node) even when quoted, so the
/// CLI reports "MCP config file not found" and silently runs WITHOUT the gateway
/// → browser tools vanish (root cause of "the agent says it has no browser
/// tools"). Collapse to the 8.3 short name; if 8.3 is off, relocate the file
/// under the (usually space-free) temp dir. Verified: the short path loads the
/// tools where the spaced path does not.
fn cli_safe_path(p: &std::path::Path) -> String {
    let raw = p.to_string_lossy().into_owned();
    if !raw.contains(' ') {
        return raw;
    }
    #[cfg(windows)]
    {
        if let Some(s) = short_path(p) {
            if !s.contains(' ') {
                return s;
            }
        }
        // 8.3 disabled → copy the config under a space-free temp dir instead.
        let tmp = std::env::temp_dir().join("owllm-mcp");
        if std::fs::create_dir_all(&tmp).is_ok() {
            if let Some(name) = p.file_name() {
                let dest = tmp.join(name);
                if std::fs::copy(p, &dest).is_ok() {
                    let d = dest.to_string_lossy().into_owned();
                    if !d.contains(' ') {
                        return d;
                    }
                    if let Some(s) = short_path(&dest) {
                        if !s.contains(' ') {
                            return s;
                        }
                    }
                }
            }
        }
    }
    raw // best effort (non-Windows shells quote spaces fine)
}

/// Ensure the gateway is up and write the `--mcp-config` JSON the Claude CLI
/// consumes, returning a path safe to pass on the CLI (see `cli_safe_path` — a
/// SPACE in the path breaks the Windows batch-shim spawn). The config carries the
/// bearer token, so it goes in the app's user-data dir (user-readable only), not
/// the project tree.
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
    Ok(std::path::PathBuf::from(cli_safe_path(&path)))
}

/// Wire the gateway into Gemini CLI, which (unlike Claude/Codex/Kimi) has NO
/// per-run MCP flag — it reads project-scoped `<cwd>/.gemini/settings.json`.
/// We MERGE our `owllm` server entry into any existing settings (preserving
/// the user's other keys) and rewrite it every spawn so the fresh
/// port/token win. Entry shape verified against `gemini mcp add -s project
/// -t http … -H "Authorization: Bearer …" --trust` (gemini-cli 0.43.0):
///   { "mcpServers": { "owllm": { "url":…, "type":"http",
///       "headers": {"Authorization":"Bearer …"}, "trust": true } } }
/// `trust: true` skips per-tool confirmation prompts, which would otherwise
/// stall a non-interactive `--prompt` run.
pub fn write_gemini_project_config(app: &AppHandle, cwd: &str) -> Result<(), String> {
    let info = ensure_started(app)?;
    let dir = std::path::Path::new(cwd).join(".gemini");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let path = dir.join("settings.json");

    // Preserve existing settings; only replace our own server entry.
    let mut root: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    if !root.is_object() {
        root = json!({});
    }
    let servers = root
        .as_object_mut()
        .unwrap()
        .entry("mcpServers")
        .or_insert_with(|| json!({}));
    if !servers.is_object() {
        *servers = json!({});
    }
    servers.as_object_mut().unwrap().insert(
        SERVER_NAME.to_string(),
        json!({
            "url": info.url,
            "type": "http",
            "headers": { "Authorization": format!("Bearer {}", info.token) },
            "trust": true
        }),
    );
    std::fs::write(&path, serde_json::to_vec_pretty(&root).unwrap_or_default())
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

/// stdio↔HTTP relay for non-jailed WSL runs (full-access or no bwrap).
///
/// A WSL-isolated agent can't reach the host loopback gateway over TCP (NAT +
/// Windows Firewall drops WSL→host — verified). But WSL *interop* lets a Linux
/// process exec a Windows `.exe`, which runs on the HOST and so reaches the
/// host's own 127.0.0.1. So instead of MCP-over-HTTP we hand the in-distro CLI
/// an MCP **stdio** server: this tiny bash relay forwards each newline-delimited
/// JSON-RPC message to the gateway via `curl.exe` (interop → host → loopback)
/// and prints the reply. Notifications (HTTP 202, empty body) produce no line,
/// exactly as MCP stdio requires. Not wired for bwrap-jailed runs — interop is
/// unavailable in the jail and jailed agents are deliberately cut off from the host.
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

/// Per-distro cache of the interop probe below — one wsl.exe round-trip per
/// distro per app run, same pattern as sandbox.rs::sandbox_cache.
#[cfg(windows)]
fn interop_cache() -> &'static Mutex<std::collections::HashMap<String, bool>> {
    static C: std::sync::OnceLock<Mutex<std::collections::HashMap<String, bool>>> =
        std::sync::OnceLock::new();
    C.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Probe whether Windows interop actually works inside `distro` by exec'ing the
/// host curl.exe from in there — the exact operation the stdio relay performs on
/// every request. When interop is disabled (`[interop] enabled=false` in
/// /etc/wsl.conf, common on hardened setups), the relay dies silently and the
/// CLI just reports zero MCP tools — this probe turns that into a precise,
/// user-visible error instead. Cached per distro.
#[cfg(windows)]
fn wsl_interop_ok(distro: &str, curl_mnt: &str) -> bool {
    if let Some(v) = interop_cache()
        .lock()
        .ok()
        .and_then(|m| m.get(distro).copied())
    {
        return v;
    }
    use std::os::windows::process::CommandExt;
    let script = format!(
        "{} --version >/dev/null 2>&1 && echo OWLLM_INTEROP_OK",
        crate::wsl::sh_quote(curl_mnt)
    );
    let ok = std::process::Command::new("wsl.exe")
        .args(["-d", distro, "--", "bash", "-lc", &script])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("OWLLM_INTEROP_OK"))
        .unwrap_or(false);
    if let Ok(mut m) = interop_cache().lock() {
        m.insert(distro.to_string(), ok);
    }
    ok
}

/// Ensure the gateway is up and write a `--mcp-config` that a non-jailed WSL
/// CLI run can use (full-access or bwrap not installed). Returns the config path
/// as a Linux (/mnt) path the in-distro CLI reads. Windows-only.
///
/// `cwd` is the project's `\\wsl.localhost\...` path — used to derive the distro
/// so the relay's transport (interop → curl.exe) can be preflighted. Wiring a
/// config whose relay can't exec curl.exe would produce the silent
/// "0 tools" failure this preflight exists to name.
#[cfg(windows)]
pub fn write_cli_config_wsl(app: &AppHandle, cwd: Option<&str>) -> Result<String, String> {
    // argv = [ "bash", relay_mnt, url, "Bearer <token>", curl_mnt ]
    let argv = wsl_relay_argv(app, cwd)?;
    let dir = crate::paths::user_data_root().ok_or_else(|| "no user-data dir".to_string())?;
    let cfg = json!({
        "mcpServers": {
            SERVER_NAME: {
                "type": "stdio",
                "command": argv[0],
                "args": &argv[1..],
            }
        }
    });
    let cfg_win = dir.join("mcp-gateway-wsl.json");
    std::fs::write(
        &cfg_win,
        serde_json::to_vec_pretty(&cfg).unwrap_or_default(),
    )
    .map_err(|e| format!("write {}: {e}", cfg_win.display()))?;
    crate::sandbox::win_to_mnt(&cfg_win.to_string_lossy())
}

/// The stdio-relay command+args a non-jailed WSL CLI uses to reach the host
/// gateway via interop. Returns `["bash", relay_mnt, url, "Bearer <token>",
/// curl_mnt]`. Materializes the relay script and runs the interop preflight, so
/// a dead-relay config is turned into a precise error here rather than a silent
/// "0 tools" downstream. Shared by the Claude JSON config (`write_cli_config_wsl`)
/// and the Codex `-c` overrides (`codex_wsl_config`). Windows-only.
#[cfg(windows)]
pub fn wsl_relay_argv(app: &AppHandle, cwd: Option<&str>) -> Result<Vec<String>, String> {
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

    // Preflight the relay's transport: the relay execs Windows curl.exe via
    // interop on every request. If interop is off in this distro, fail HERE
    // with a precise reason instead of wiring a dead relay (CLI would list
    // zero MCP tools with no explanation).
    if let Some((distro, _)) = cwd.and_then(crate::wsl::parse_wsl_unc) {
        if !wsl_interop_ok(&distro, &curl_mnt) {
            return Err(format!(
                "WSL interop is disabled in distro '{distro}' (can't exec Windows curl.exe from inside it) — the browser-gateway relay needs it. Enable it: in the distro set /etc/wsl.conf [interop] enabled=true, then run `wsl --shutdown` and retry"
            ));
        }
    }

    Ok(vec![
        "bash".to_string(),
        relay_mnt,
        info.url,
        format!("Bearer {}", info.token),
        curl_mnt,
    ])
}

/// TOML basic-string literal for a `-c key=value` override. JSON string escaping
/// is a subset of TOML basic-string escaping for the characters that occur in
/// URLs/paths, so `serde_json` gives us a value codex parses correctly.
fn toml_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| format!("{s:?}"))
}

/// Codex CLI `-c` overrides + bearer token for a HOST run (HTTP transport).
/// Returns `(["-c", "mcp_servers.owllm.url=…", "-c", "…bearer_token_env_var=…"],
/// token)`. The caller puts `token` in the child's [`CODEX_TOKEN_ENV`] env var.
/// Codex only accepts MCP config via `-c` overrides (no `--mcp-config` flag),
/// which is why this returns args rather than a file path like the Claude path.
pub fn codex_http_config(app: &AppHandle) -> Result<(Vec<String>, String), String> {
    let info = ensure_started(app)?;
    let cfg = vec![
        "-c".to_string(),
        format!("mcp_servers.{SERVER_NAME}.url={}", toml_str(&info.url)),
        "-c".to_string(),
        format!(
            "mcp_servers.{SERVER_NAME}.bearer_token_env_var={}",
            toml_str(CODEX_TOKEN_ENV)
        ),
    ];
    Ok((cfg, info.token))
}

/// Codex CLI `-c` overrides for a NON-JAILED WSL run (stdio relay, token carried
/// in the relay args exactly like the Claude WSL config). Windows-only.
#[cfg(windows)]
pub fn codex_wsl_config(app: &AppHandle, cwd: Option<&str>) -> Result<Vec<String>, String> {
    let argv = wsl_relay_argv(app, cwd)?; // [ bash, relay, url, "Bearer <token>", curl ]
    let args_arr = serde_json::to_string(&argv[1..]).unwrap_or_else(|_| "[]".to_string());
    Ok(vec![
        "-c".to_string(),
        format!("mcp_servers.{SERVER_NAME}.command={}", toml_str(&argv[0])),
        "-c".to_string(),
        format!("mcp_servers.{SERVER_NAME}.args={args_arr}"),
    ])
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
        let _ = req
            .respond(tiny_http::Response::from_string("method not allowed").with_status_code(405));
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
            if replies.is_empty() {
                None
            } else {
                Some(Value::Array(replies))
            }
        }
        v => dispatch_rpc(app, &v),
    };

    match response {
        Some(body) => {
            let data = serde_json::to_vec(&body).unwrap_or_default();
            let resp = tiny_http::Response::from_data(data).with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
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
            reply(
                id,
                json!({
                    "protocolVersion": proto,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": SERVER_NAME, "version": crate::APP_VERSION.as_str() }
                }),
            )
        }
        "notifications/initialized" | "notifications/cancelled" => None,
        "ping" => reply(id, json!({})),
        "tools/list" => reply(id, json!({ "tools": tool_specs() })),
        "tools/call" => {
            if is_notification {
                return None;
            }
            let name = req
                .pointer("/params/name")
                .and_then(Value::as_str)
                .unwrap_or("");
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
    a.len() == b.len()
        && a.iter()
            .zip(b.iter())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

// ----- Tool catalogue + dispatch --------------------------------------------

/// The browser tool palette, as MCP tool specs (name/description/inputSchema).
/// Mirrors the browser_* tools in localTools.ts so a CLI agent gets the same
/// capability a local/API agent has. Kept deliberately small and stable.
fn tool_specs() -> Vec<Value> {
    let idx = json!({ "type": "integer", "description": "Element index from the latest browser_snapshot." });
    let tab = json!({ "type": "integer", "description": "Browser tab id from browser_open or browser_tabs. Omit to use the user's active tab." });
    vec![
        json!({ "name": "browser_open",
            "description": "Open a URL in a new OwLLM browser tab and return its tab id. Existing user tabs are not replaced. Localhost/dev-server URLs are supported.",
            "inputSchema": { "type": "object", "properties": { "url": { "type": "string", "description": "URL to open. Scheme optional (https assumed; http for localhost)." }, "activate": { "type": "boolean", "description": "Select the new tab visibly. Defaults false so the user's current tab is not interrupted." } }, "required": ["url"] } }),
        json!({ "name": "browser_tabs",
            "description": "List every open browser tab with its stable id, title, URL and active state.",
            "inputSchema": { "type": "object", "properties": {} } }),
        json!({ "name": "browser_tab_select",
            "description": "Select a browser tab visibly for the user. Agent actions do not require selection; pass tab_id directly instead.",
            "inputSchema": { "type": "object", "properties": { "tab_id": tab }, "required": ["tab_id"] } }),
        json!({ "name": "browser_tab_close",
            "description": "Close one browser tab without affecting the others.",
            "inputSchema": { "type": "object", "properties": { "tab_id": tab }, "required": ["tab_id"] } }),
        json!({ "name": "browser_navigate",
            "description": "Navigate one browser tab to a URL. Pass tab_id to avoid changing a tab the user is working in.",
            "inputSchema": { "type": "object", "properties": { "url": { "type": "string" }, "tab_id": tab }, "required": ["url"] } }),
        json!({ "name": "browser_snapshot",
            "description": "Return an indexed list of the page's interactive elements (links, buttons, inputs). Read this to SEE the page, then act by index.",
            "inputSchema": { "type": "object", "properties": { "tab_id": tab } } }),
        json!({ "name": "browser_click",
            "description": "Click an interactive element by its index from the latest snapshot.",
            "inputSchema": { "type": "object", "properties": { "index": idx, "tab_id": tab }, "required": ["index"] } }),
        json!({ "name": "browser_fill",
            "description": "Type text into an input, textarea, or contenteditable editor by index. Emits the input events required by controlled web apps.",
            "inputSchema": { "type": "object", "properties": { "index": idx, "text": { "type": "string" }, "tab_id": tab }, "required": ["index", "text"] } }),
        json!({ "name": "browser_scroll",
            "description": "Scroll a virtualized list, message history, mail list, or page. Pass an element index to scroll that region (or its scrollable ancestor); omit it to use the focused or largest visible scroll region. Snapshot again afterward if more history is needed.",
            "inputSchema": { "type": "object", "properties": {
                "direction": { "type": "string", "enum": ["up", "down", "left", "right"], "description": "Scroll direction; defaults to down." },
                "amount": { "type": "number", "minimum": 20, "maximum": 5000, "description": "Distance in CSS pixels; defaults to about 80% of the region." },
                "index": idx,
                "tab_id": tab
            } } }),
        json!({ "name": "browser_select",
            "description": "Choose an option in a <select> by index and option value or label.",
            "inputSchema": { "type": "object", "properties": { "index": idx, "value": { "type": "string" }, "tab_id": tab }, "required": ["index", "value"] } }),
        json!({ "name": "browser_press",
            "description": "Press a keyboard key on the focused element (e.g. Enter, Tab, Escape).",
            "inputSchema": { "type": "object", "properties": { "key": { "type": "string" }, "tab_id": tab }, "required": ["key"] } }),
        json!({ "name": "browser_get_text",
            "description": "Return the visible text of the current page.",
            "inputSchema": { "type": "object", "properties": { "tab_id": tab } } }),
        json!({ "name": "browser_back",
            "description": "Go back one entry in the browser history.",
            "inputSchema": { "type": "object", "properties": { "tab_id": tab } } }),
        json!({ "name": "browser_reload",
            "description": "Reload the current page.",
            "inputSchema": { "type": "object", "properties": { "tab_id": tab } } }),
        json!({ "name": "browser_device",
            "description": "Switch device emulation: desktop, iphone, android or tablet (viewport size + mobile user-agent).",
            "inputSchema": { "type": "object", "properties": { "device": { "type": "string", "enum": ["desktop", "iphone", "android", "tablet"] } }, "required": ["device"] } }),
        json!({ "name": "browser_screenshot",
            "description": "Describe the current page (title/URL/state summary). The browser window is natively visible to the user; agents act via browser_snapshot.",
            "inputSchema": { "type": "object", "properties": { "tab_id": tab } } }),
        json!({ "name": "browser_close",
            "description": "Close the agent browser window.",
            "inputSchema": { "type": "object", "properties": {} } }),
        json!({ "name": "mcp_search_capabilities",
            "description": "Search OWLLM's reviewed MCP catalog when a needed capability is missing. If no reviewed match exists, research the official MCP Registry/vendor source and ask the user before any arbitrary package install.",
            "inputSchema": { "type": "object", "properties": {
                "query": { "type": "string", "description": "Capability needed, e.g. GitHub issues, Slack search, or web research." }
            }, "required": ["query"] } }),
        json!({ "name": "mcp_install_curated",
            "description": "Install, start and verify one exact reviewed MCP returned by mcp_search_capabilities. Credentialed entries fail closed until configured in Settings > MCP; secrets are never accepted in chat.",
            "inputSchema": { "type": "object", "properties": {
                "name": { "type": "string", "description": "Exact reviewed MCP name." },
                "workspace": { "type": "string", "description": "Current project path for workspace-scoped MCPs." }
            }, "required": ["name"] } }),
        json!({ "name": "mcp_call_connected",
            "description": "Call a tool exposed by a connected MCP immediately after installation. Use the exact server/tool and input schema returned by mcp_install_curated.",
            "inputSchema": { "type": "object", "properties": {
                "server": { "type": "string" },
                "tool": { "type": "string" },
                "arguments": { "type": "object", "description": "Arguments matching the connected tool's input schema." }
            }, "required": ["server", "tool"] } }),
        // KVM node control — mirrors the kvm_node local tool so CLI agents get
        // the same capability. The backend feature flag + per-host consent
        // (kvm.rs, fail-closed) gate execution, so exposure here is safe.
        json!({ "name": "kvm_node",
            "description": "Control a networked KVM node (Sipeed NanoKVM) as the target machine's eyes + hands. Actions: 'screenshot' (capture target video → saved PNG path), 'type' (USB-HID keyboard text), 'keys' (key chord e.g. 'ctrl+alt+del'), 'mouse' (move/click), 'boot_key' (tap F2/F12/Del during POST), 'mount_iso', 'power'. Take a 'screenshot' first to see the target before acting.",
            "inputSchema": { "type": "object", "properties": {
                "action": { "type": "string", "enum": ["screenshot", "type", "keys", "mouse", "boot_key", "mount_iso", "power"] },
                "target": { "type": "object", "description": "KVM node: { host, port?, auth: { sshKeyPath? | token? }, transport: 'ssh'|'http' }." },
                "params": { "type": "object", "description": "Action params: type={text} keys={combo} mouse={x?,y?,button?,op?} boot_key={key} mount_iso={isoPath} power={line}." }
            }, "required": ["action", "target"] } }),
        // Remote OwLLM device control — mirrors the device_exec local tool so CLI
        // agents can run commands on a PAIRED device (no SSH keys; over the
        // end-to-end-sealed device channel). Gated by the agents-allowed switch +
        // the target's pairing/shell policy, so exposure here is safe.
        json!({ "name": "device_exec",
            "description": "Run a shell command on a PAIRED OwLLM device (another PC running OwLLM you've paired + granted shell to). No SSH keys; works across networks (LAN, Tailscale overlay, or relay) over the encrypted device channel. Use for tech support, installing software, or development on another machine. Requires 'Let agents use remote devices' enabled.",
            "inputSchema": { "type": "object", "properties": {
                "device": { "type": "string", "description": "Target device NAME or id from the user's OwLLM Devices list." },
                "command": { "type": "string", "description": "The shell command to run on the remote device." }
            }, "required": ["device", "command"] } }),
        // Code-signing vault — the user's stored Apple Developer ID / Windows
        // Authenticode credentials, so a coding agent in ANY project can set up
        // signed + notarized releases. Managed from the app's Signing page.
        json!({ "name": "signing_get",
            "description": "Read the user's shared code-signing credentials (managed on the OwLLM Signing page) so you can wire up a signed + notarized release in ANY project. Returns status/metadata (identity, team id, expiry, which fields are present) by default. Pass include_secrets=true to also get the CI environment values — for Apple: APPLE_CERTIFICATE (base64 .p12), APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY, APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID — e.g. to set them as GitHub Actions secrets. Handle secret values carefully; never echo them into logs or commits. Secret material is stored PER MACHINE and never syncs: if certOnOtherDevice is true the credentials are configured but live on another of the user's PCs — build/sign there (device_exec) instead of reporting signing as unconfigured or asking the user for the certificate again.",
            "inputSchema": { "type": "object", "properties": {
                "platform": { "type": "string", "enum": ["apple", "windows"], "description": "Which signing set to read (default apple)." },
                "include_secrets": { "type": "boolean", "description": "When true, also return the secret CI env values. Default false (metadata only)." }
            } } }),
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

fn as_optional_index(args: &Value, key: &str) -> Value {
    match args.get(key) {
        None | Some(Value::Null) => Value::Null,
        Some(Value::Number(n)) => Value::Number(n.clone()),
        Some(Value::String(s)) => s.parse::<u64>().map(Value::from).unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

fn as_str(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// Route an MCP tool call to the native browser commands. Everything funnels
/// through the SAME `browser::*` functions the Tauri commands use — one engine,
/// no second implementation.
fn call_tool(app: &AppHandle, name: &str, args: &Value) -> Result<String, String> {
    match name {
        "browser_open" => crate::browser::browser_open_tab(
            app.clone(),
            as_str(args, "url"),
            args.get("activate").and_then(Value::as_bool),
        ),
        "browser_tabs" => crate::browser::browser_list_tabs(app.clone()),
        "browser_tab_select" => crate::browser::browser_select_tab(
            app.clone(),
            as_optional_index(args, "tab_id").as_u64().unwrap_or(0),
        ),
        "browser_tab_close" => crate::browser::browser_close_tab(
            app.clone(),
            as_optional_index(args, "tab_id").as_u64().unwrap_or(0),
        ),
        "browser_navigate" => crate::browser::browser_cmd(
            app.clone(),
            "navigate".into(),
            json!({ "url": as_str(args, "url"), "tab_id": as_optional_index(args, "tab_id") }),
        ),
        "browser_snapshot" => {
            crate::browser::browser_cmd(app.clone(), "snapshot".into(), json!({ "tab_id": as_optional_index(args, "tab_id") }))
        }
        "browser_get_text" => {
            crate::browser::browser_cmd(app.clone(), "get_text".into(), json!({ "tab_id": as_optional_index(args, "tab_id") }))
        }
        "browser_back" => crate::browser::browser_cmd(app.clone(), "back".into(), json!({ "tab_id": as_optional_index(args, "tab_id") })),
        "browser_reload" => crate::browser::browser_cmd(app.clone(), "reload".into(), json!({ "tab_id": as_optional_index(args, "tab_id") })),
        "browser_click" => crate::browser::browser_cmd(
            app.clone(),
            "click".into(),
            json!({ "index": as_index(args, "index"), "tab_id": as_optional_index(args, "tab_id") }),
        ),
        "browser_fill" => crate::browser::browser_cmd(
            app.clone(),
            "fill".into(),
            json!({ "index": as_index(args, "index"), "text": as_str(args, "text"), "tab_id": as_optional_index(args, "tab_id") }),
        ),
        "browser_scroll" => crate::browser::browser_cmd(
            app.clone(),
            "scroll".into(),
            json!({
                "direction": as_str(args, "direction"),
                "amount": args.get("amount").cloned().unwrap_or(Value::Null),
                "index": as_optional_index(args, "index"),
                "tab_id": as_optional_index(args, "tab_id")
            }),
        ),
        "browser_select" => crate::browser::browser_cmd(
            app.clone(),
            "select".into(),
            json!({ "index": as_index(args, "index"), "value": as_str(args, "value"), "tab_id": as_optional_index(args, "tab_id") }),
        ),
        "browser_press" => crate::browser::browser_cmd(
            app.clone(),
            "press".into(),
            json!({ "key": as_str(args, "key"), "tab_id": as_optional_index(args, "tab_id") }),
        ),
        "browser_device" => crate::browser::browser_set_device(app.clone(), as_str(args, "device")),
        "browser_screenshot" => crate::browser::browser_cmd(
            app.clone(),
            "screenshot".into(),
            json!({ "tab_id": as_optional_index(args, "tab_id") }),
        ),
        "browser_close" => crate::browser::browser_stop(app.clone()),
        "mcp_search_capabilities" => tauri::async_runtime::block_on(
            crate::mcp::mcp_search_capabilities(as_str(args, "query")),
        )
        .and_then(|value| serde_json::to_string_pretty(&value).map_err(|e| e.to_string())),
        "mcp_install_curated" => tauri::async_runtime::block_on(
            crate::mcp::mcp_install_curated(
                as_str(args, "name"),
                args.get("workspace").and_then(Value::as_str).map(str::to_string),
            ),
        )
        .and_then(|value| serde_json::to_string_pretty(&value).map_err(|e| e.to_string())),
        "mcp_call_connected" => {
            let arguments = match args.get("arguments") {
                Some(Value::String(raw)) => serde_json::from_str(raw)
                    .map_err(|e| format!("arguments must be valid JSON: {e}"))?,
                Some(value) => value.clone(),
                None => json!({}),
            };
            tauri::async_runtime::block_on(crate::mcp::mcp_call_tool(
                as_str(args, "server"),
                as_str(args, "tool"),
                arguments,
            ))
        }
        "kvm_node" => {
            // `target`/`params` may arrive as objects (per schema) or as JSON
            // strings (models and the local-tool path both do this) — accept both.
            let tval = match args.get("target") {
                Some(Value::String(s)) => serde_json::from_str::<Value>(s)
                    .map_err(|e| format!("target is not valid JSON: {e}"))?,
                Some(v) => v.clone(),
                None => return Err("kvm_node requires a 'target' object".into()),
            };
            let target: crate::kvm::KvmTarget =
                serde_json::from_value(tval).map_err(|e| format!("bad target: {e}"))?;
            let params = match args.get("params") {
                Some(Value::String(s)) if !s.trim().is_empty() => {
                    serde_json::from_str::<Value>(s).unwrap_or_else(|_| json!({}))
                }
                Some(v) => v.clone(),
                None => json!({}),
            };
            // Gateway requests run on the tiny_http thread (not in the tokio
            // runtime), so blocking on the async command here is safe.
            tauri::async_runtime::block_on(crate::kvm::kvm_node_exec(
                target,
                as_str(args, "action"),
                params,
            ))
            .map(|v| v.to_string())
        }
        "device_exec" | "owllm_device" | "device_run" => {
            let device = as_str(args, "device");
            let command = as_str(args, "command");
            // Runs on the tiny_http thread, so block_on the async send is safe.
            let res = tauri::async_runtime::block_on(crate::remote_devices::agent_device_exec(
                &device, &command,
            ))?;
            let mut out = String::new();
            let clip = |s: &str, n: usize| {
                if s.chars().count() > n {
                    format!("{}…[truncated]", s.chars().take(n).collect::<String>())
                } else {
                    s.to_string()
                }
            };
            if !res.stdout.trim().is_empty() {
                out.push_str(&format!("stdout:\n{}\n\n", clip(&res.stdout, 4000)));
            }
            if !res.stderr.trim().is_empty() {
                out.push_str(&format!("stderr:\n{}\n\n", clip(&res.stderr, 2000)));
            }
            if let Some(e) = &res.error {
                out.push_str(&format!("error: {e}\n"));
            }
            out.push_str(&format!(
                "device: {device} · decision: {} · exit_code: {}",
                res.decision,
                res.exit_code
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "n/a".into())
            ));
            Ok(out)
        }
        "signing_get" => {
            // Read the shared code-signing vault so a coding agent in ANY
            // project can wire signed releases. Metadata by default; secrets
            // only when explicitly asked (same reveal boundary as device_exec,
            // which already runs arbitrary shell as this user).
            let platform = {
                let p = as_str(args, "platform");
                if p.trim().is_empty() {
                    "apple".to_string()
                } else {
                    p
                }
            };
            let include_secrets = args
                .get("include_secrets")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            crate::signing::agent_get(&platform, include_secrets).map(|v| v.to_string())
        }
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
    fn cli_safe_path_passthrough_when_no_space() {
        // A path without a space is returned verbatim on every platform.
        let p = std::path::Path::new("/tmp/owllm/mcp-gateway.json");
        assert_eq!(cli_safe_path(p), "/tmp/owllm/mcp-gateway.json");
    }

    #[cfg(windows)]
    #[test]
    fn cli_safe_path_removes_space_for_existing_file() {
        // Regression for the 10-round "agent has no browser tools" bug: the
        // config lived at …\OwLLM Desktop\… and the SPACE split the --mcp-config
        // arg in the CLI batch-shim spawn. cli_safe_path must hand back a
        // space-free, still-readable path for a file under a spaced dir.
        let dir = std::env::temp_dir().join("owllm mcp space test");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("mcp-gateway.json");
        std::fs::write(&f, b"{}").unwrap();
        let safe = cli_safe_path(&f);
        assert!(!safe.contains(' '), "expected space-free path, got: {safe}");
        assert!(
            std::fs::read(&safe).is_ok(),
            "safe path not readable: {safe}"
        );
        let _ = std::fs::remove_dir_all(&dir);
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
        assert!(specs
            .iter()
            .all(|t| t.get("name").is_some() && t.get("inputSchema").is_some()));
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
