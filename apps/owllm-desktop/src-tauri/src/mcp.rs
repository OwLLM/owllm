// Model Context Protocol — MCP client runtime.
//
// MCP servers are stdio child processes that speak JSON-RPC 2.0. The
// official Anthropic MCP servers ship as npm packages and run via
// `npx -y @modelcontextprotocol/server-<name>`. Examples:
//
//   - @modelcontextprotocol/server-brave-search    (web search)
//   - @modelcontextprotocol/server-filesystem      (sandboxed FS)
//   - @modelcontextprotocol/server-github          (GitHub API)
//   - @modelcontextprotocol/server-postgres        (SQL queries)
//   - @modelcontextprotocol/server-puppeteer       (browser automation)
//
// This module spawns those processes, performs the MCP initialize +
// tools/list handshake, and exposes a tools/call commando the agent
// dispatch loop hits when a model emits `<tool_call name="mcp:<server>:<tool>">`.
//
// One process per configured server. Sessions live in a global Mutex
// so React can list/start/stop them and the agent loop can call into
// them concurrently with the dispatch.
//
// Lifecycle:
//   1. mcp_load_config()  reads ~/.owllm/mcp_config.json
//   2. mcp_start_server(name)  spawns process, sends initialize, then
//      tools/list, caches the schema in the session
//   3. mcp_list_all_tools()  → flat list used by formatToolsForPrompt
//   4. mcp_call_tool(server, tool, args)  → JSON-RPC call returning
//      the content array (or error) — wired into executeToolCall
//   5. mcp_stop_server(name)  kills the child, drops the session

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex as TokioMutex};
use tokio::time::timeout;

// ===== Config persistence =====

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct McpServerConfig {
    /// Unique short name — agents reference tools as `mcp:<name>:<tool>`.
    /// Stable across restarts; the user shouldn't rename casually.
    pub name: String,
    /// Command to launch. Typically `npx` or `uvx`; on Windows we
    /// auto-rewrite `.cmd` shims via cmd.exe /c the same way pty.rs does.
    pub command: String,
    /// Args to pass — e.g. `["-y", "@modelcontextprotocol/server-brave-search"]`.
    #[serde(default)]
    pub args: Vec<String>,
    /// Extra env vars merged into the child env (e.g. BRAVE_API_KEY).
    /// Inherits everything else from the desktop process.
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// If true, auto-start on app boot. Default true.
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool { true }

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct McpConfig {
    #[serde(default)]
    pub servers: Vec<McpServerConfig>,
}

fn config_path() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(home).join(".owllm").join("mcp_config.json"))
}

#[tauri::command]
pub fn mcp_load_config() -> Result<McpConfig, String> {
    let Some(path) = config_path() else { return Ok(McpConfig::default()) };
    if !path.is_file() { return Ok(McpConfig::default()) }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

#[tauri::command]
pub fn mcp_save_config(config: McpConfig) -> Result<(), String> {
    let Some(path) = config_path() else { return Err("no home directory".to_string()) };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("write {}: {e}", path.display()))
}

// ===== Tool schema (returned to React + injected into agent prompts) =====

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpToolSpec {
    /// Tool name as the MCP server reports it (no server-prefix here —
    /// the prefix `mcp:<server>:` is added at advertise/dispatch time).
    pub name: String,
    pub description: String,
    /// JSON Schema of the tool's input — pass to the model so it knows
    /// what args to emit. We don't validate; the server enforces.
    pub input_schema: Value,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub name: String,
    pub running: bool,
    pub enabled: bool,
    pub command: String,
    pub args: Vec<String>,
    /// Cached tool list from the last successful initialize. Empty
    /// when the server isn't running or hasn't finished handshake.
    pub tools: Vec<McpToolSpec>,
    /// Last error message — populated on start failure / runtime
    /// stderr noise / handshake timeout. Empty on success.
    pub error: String,
}

// ===== Session =====

struct McpSession {
    name: String,
    config: McpServerConfig,
    child: Arc<TokioMutex<Child>>,
    stdin: Arc<TokioMutex<ChildStdin>>,
    pending: Arc<StdMutex<HashMap<i64, oneshot::Sender<Value>>>>,
    next_id: Arc<StdMutex<i64>>,
    tools: Arc<StdMutex<Vec<McpToolSpec>>>,
    error: Arc<StdMutex<String>>,
}

static SESSIONS: Lazy<TokioMutex<HashMap<String, Arc<McpSession>>>> =
    Lazy::new(|| TokioMutex::new(HashMap::new()));

/// Resolve a command name to (exe, args) accounting for .cmd / .bat
/// shims on Windows. Mirrors pty.rs::resolve_cli_command's strategy:
/// npx / uvx / similar npm-bin shims are .cmd files that CreateProcessW
/// can't launch directly.
fn resolve_command(command: &str, args: &[String]) -> (PathBuf, Vec<String>) {
    let candidates = [
        format!("{command}.exe"),
        format!("{command}.cmd"),
        command.to_string(),
    ];
    let resolved = candidates
        .iter()
        .find_map(|n| crate::accounts::which_extended(n))
        .unwrap_or_else(|| PathBuf::from(command));

    let is_batch = resolved
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| {
            let e = e.to_ascii_lowercase();
            e == "cmd" || e == "bat"
        })
        .unwrap_or(false);

    if is_batch && cfg!(windows) {
        let mut wrapped: Vec<String> = vec!["/c".to_string(), resolved.to_string_lossy().to_string()];
        wrapped.extend(args.iter().cloned());
        (PathBuf::from("cmd.exe"), wrapped)
    } else {
        (resolved, args.to_vec())
    }
}

/// Spawn `cfg.command cfg.args` with stdin/stdout piped. Wire a
/// reader task that consumes line-delimited JSON-RPC responses and
/// routes them to pending oneshot channels by id.
async fn spawn_session(cfg: &McpServerConfig) -> Result<Arc<McpSession>, String> {
    let (exe, resolved_args) = resolve_command(&cfg.command, &cfg.args);

    // Pre-flight: when which_extended fell back to the bare command
    // name (no .exe / .cmd resolved), the spawn is almost certain to
    // fail on Windows with a cryptic "cannot find file". Catch that
    // here and return an actionable error before spawning.
    let resolved_ok = exe.is_absolute() || exe == PathBuf::from("cmd.exe");
    if !resolved_ok {
        let hint = match cfg.command.as_str() {
            "uvx" | "uv" => " — install Astral uv via `winget install --id=astral-sh.uv` (Windows) or `pip install uv`, then restart OwLLM Desktop so the new PATH is picked up.",
            "npx" | "npm" | "node" => " — install Node.js from nodejs.org (gives you npx + npm), then restart OwLLM Desktop.",
            _ => "",
        };
        return Err(format!(
            "'{}' not found on PATH or common install dirs{}",
            cfg.command, hint
        ));
    }

    let mut cmd = Command::new(&exe);
    for a in &resolved_args {
        cmd.arg(a);
    }
    for (k, v) in &cfg.env {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn '{}': {e}", cfg.command))?;
    let stdin = child.stdin.take().ok_or_else(|| "no stdin".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "no stdout".to_string())?;
    let stderr = child.stderr.take();

    let pending: Arc<StdMutex<HashMap<i64, oneshot::Sender<Value>>>> =
        Arc::new(StdMutex::new(HashMap::new()));
    let tools: Arc<StdMutex<Vec<McpToolSpec>>> = Arc::new(StdMutex::new(Vec::new()));
    let error: Arc<StdMutex<String>> = Arc::new(StdMutex::new(String::new()));

    // Reader task: pumps stdout, parses JSON-RPC envelopes, routes
    // responses by id, ignores server-originated notifications for now.
    {
        let pending = pending.clone();
        let error = error.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break, // EOF
                    Ok(_) => {}
                    Err(e) => {
                        *error.lock().unwrap() = format!("stdout read: {e}");
                        break;
                    }
                }
                let trimmed = line.trim();
                if trimmed.is_empty() { continue }
                let parsed: Value = match serde_json::from_str(trimmed) {
                    Ok(v) => v,
                    Err(_) => continue, // ignore garbage / partial frames
                };
                // Response: { jsonrpc, id, result|error }
                if let Some(id) = parsed.get("id").and_then(|v| v.as_i64()) {
                    let tx = pending.lock().unwrap().remove(&id);
                    if let Some(tx) = tx {
                        let _ = tx.send(parsed);
                    }
                }
                // Notifications (no id) — ignored in v1.
            }
        });
    }

    // Stderr drain — stash the last ~4 KB so errors are visible.
    if let Some(stderr) = stderr {
        let error = error.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            let mut buf = String::new();
            loop {
                line.clear();
                if reader.read_line(&mut line).await.unwrap_or(0) == 0 { break }
                buf.push_str(&line);
                if buf.len() > 4096 {
                    let drop = buf.len() - 4096;
                    buf = buf[drop..].to_string();
                }
                *error.lock().unwrap() = buf.clone();
            }
        });
    }

    let session = Arc::new(McpSession {
        name: cfg.name.clone(),
        config: cfg.clone(),
        child: Arc::new(TokioMutex::new(child)),
        stdin: Arc::new(TokioMutex::new(stdin)),
        pending,
        next_id: Arc::new(StdMutex::new(0)),
        tools,
        error,
    });

    // Initialize handshake. Failures here = the server didn't speak
    // MCP properly; kill the child + bubble up.
    if let Err(e) = mcp_initialize(&session).await {
        let _ = session.child.lock().await.start_kill();
        return Err(format!("initialize failed: {e}"));
    }
    if let Err(e) = mcp_fetch_tools(&session).await {
        // Tools missing isn't fatal — some MCP servers expose only
        // resources/prompts. Log into `error` but keep the session.
        *session.error.lock().unwrap() = format!("tools/list: {e}");
    }
    Ok(session)
}

async fn next_request_id(session: &McpSession) -> i64 {
    let mut guard = session.next_id.lock().unwrap();
    *guard += 1;
    *guard
}

async fn send_request(session: &McpSession, method: &str, params: Value) -> Result<Value, String> {
    let id = next_request_id(session).await;
    let payload = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    let (tx, rx) = oneshot::channel();
    session.pending.lock().unwrap().insert(id, tx);
    let line = format!("{}\n", payload.to_string());
    {
        let mut stdin = session.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await.map_err(|e| format!("stdin write: {e}"))?;
        stdin.flush().await.map_err(|e| format!("stdin flush: {e}"))?;
    }
    // 180s ceiling. First-run npx -y @modelcontextprotocol/server-X
    // downloads the package from npm (can be 30-60s on slow networks).
    // Once cached, subsequent starts respond in <1s. Bump up so we don't
    // false-fail the first start and confuse users into thinking MCP
    // is broken when really npm is just being slow.
    let resp = timeout(Duration::from_secs(180), rx)
        .await
        .map_err(|_| format!("MCP request '{method}' timed out after 180s — if this is the first run, npx may still be downloading the package; try Start again"))?
        .map_err(|_| format!("MCP request '{method}' dropped before reply"))?;
    if let Some(err) = resp.get("error") {
        return Err(format!("MCP error on {method}: {err}"));
    }
    Ok(resp.get("result").cloned().unwrap_or(Value::Null))
}

async fn send_notification(session: &McpSession, method: &str, params: Value) -> Result<(), String> {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    });
    let line = format!("{}\n", payload.to_string());
    let mut stdin = session.stdin.lock().await;
    stdin.write_all(line.as_bytes()).await.map_err(|e| format!("stdin write: {e}"))?;
    stdin.flush().await.map_err(|e| format!("stdin flush: {e}"))?;
    Ok(())
}

async fn mcp_initialize(session: &McpSession) -> Result<(), String> {
    // MCP spec 2024-11-05 handshake.
    let init_params = json!({
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {
            "name": "owllm-desktop",
            "version": env!("CARGO_PKG_VERSION"),
        }
    });
    let _ = send_request(session, "initialize", init_params).await?;
    send_notification(session, "notifications/initialized", json!({})).await?;
    Ok(())
}

async fn mcp_fetch_tools(session: &McpSession) -> Result<(), String> {
    let result = send_request(session, "tools/list", json!({})).await?;
    let list = result
        .get("tools")
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default();
    let parsed: Vec<McpToolSpec> = list
        .into_iter()
        .filter_map(|item| {
            let name = item.get("name")?.as_str()?.to_string();
            let description = item
                .get("description")
                .and_then(|d| d.as_str())
                .unwrap_or("")
                .to_string();
            let input_schema = item
                .get("inputSchema")
                .cloned()
                .unwrap_or(json!({}));
            Some(McpToolSpec { name, description, input_schema })
        })
        .collect();
    *session.tools.lock().unwrap() = parsed;
    Ok(())
}

// ===== Tauri commands =====

#[tauri::command]
pub async fn mcp_start_server(name: String) -> Result<McpServerStatus, String> {
    // Already running? Return the existing status (idempotent).
    {
        let sessions = SESSIONS.lock().await;
        if let Some(existing) = sessions.get(&name) {
            return Ok(status_from_session(existing));
        }
    }
    let config = mcp_load_config()?;
    let cfg = config
        .servers
        .iter()
        .find(|s| s.name == name)
        .cloned()
        .ok_or_else(|| format!("no MCP server configured with name '{name}'"))?;
    let session = spawn_session(&cfg).await?;
    let status = status_from_session(&session);
    SESSIONS.lock().await.insert(name, session);
    Ok(status)
}

#[tauri::command]
pub async fn mcp_stop_server(name: String) -> Result<(), String> {
    let session = {
        let mut sessions = SESSIONS.lock().await;
        sessions.remove(&name)
    };
    if let Some(session) = session {
        let _ = session.child.lock().await.start_kill();
    }
    Ok(())
}

#[tauri::command]
pub async fn mcp_list_servers() -> Result<Vec<McpServerStatus>, String> {
    let config = mcp_load_config()?;
    let sessions = SESSIONS.lock().await;
    let mut out: Vec<McpServerStatus> = Vec::new();
    for cfg in &config.servers {
        if let Some(session) = sessions.get(&cfg.name) {
            out.push(status_from_session(session));
        } else {
            out.push(McpServerStatus {
                name: cfg.name.clone(),
                running: false,
                enabled: cfg.enabled,
                command: cfg.command.clone(),
                args: cfg.args.clone(),
                tools: Vec::new(),
                error: String::new(),
            });
        }
    }
    Ok(out)
}

/// Aggregate every tool from every RUNNING MCP server. Names come
/// back prefixed `mcp:<server>:<tool>` so the agent's XML tool_call
/// dispatch routes through mcp_call_tool unambiguously.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AggregatedMcpTool {
    /// Display name: `mcp:<server>:<tool>`.
    pub qualified_name: String,
    pub server: String,
    pub tool: String,
    pub description: String,
    pub input_schema: Value,
}

#[tauri::command]
pub async fn mcp_list_all_tools() -> Result<Vec<AggregatedMcpTool>, String> {
    let sessions = SESSIONS.lock().await;
    let mut out: Vec<AggregatedMcpTool> = Vec::new();
    for (name, session) in sessions.iter() {
        let tools = session.tools.lock().unwrap().clone();
        for t in tools {
            out.push(AggregatedMcpTool {
                qualified_name: format!("mcp:{}:{}", name, t.name),
                server: name.clone(),
                tool: t.name.clone(),
                description: t.description.clone(),
                input_schema: t.input_schema.clone(),
            });
        }
    }
    Ok(out)
}

/// Call a specific tool on a specific server. Returns the concatenated
/// text of every `content` entry the server emitted (MCP tools usually
/// return one text entry; some return multiple — we join with \n\n).
#[tauri::command]
pub async fn mcp_call_tool(
    server: String,
    tool: String,
    arguments: Value,
) -> Result<String, String> {
    let session = {
        let sessions = SESSIONS.lock().await;
        sessions
            .get(&server)
            .cloned()
            .ok_or_else(|| format!("MCP server '{server}' is not running — start it first"))?
    };
    let result = send_request(
        &session,
        "tools/call",
        json!({"name": tool, "arguments": arguments}),
    ).await?;
    // Standard MCP response shape: {content: [{type, text}], isError?}
    let is_error = result.get("isError").and_then(|v| v.as_bool()).unwrap_or(false);
    let content = result.get("content").and_then(|c| c.as_array()).cloned().unwrap_or_default();
    let parts: Vec<String> = content
        .iter()
        .filter_map(|c| {
            let kind = c.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match kind {
                "text" => c.get("text").and_then(|v| v.as_str()).map(|s| s.to_string()),
                "image" => Some(format!("[image: {} bytes]",
                    c.get("data").and_then(|v| v.as_str()).map(|s| s.len()).unwrap_or(0))),
                _ => Some(format!("[unsupported MCP content type: {kind}]")),
            }
        })
        .collect();
    let text = parts.join("\n\n");
    if is_error {
        Err(format!("MCP tool error: {text}"))
    } else {
        Ok(text)
    }
}

/// Start every enabled server in the config. Called on app boot so
/// agents see MCP tools without the user clicking Start each time.
#[tauri::command]
pub async fn mcp_autostart_all() -> Result<Vec<McpServerStatus>, String> {
    let config = mcp_load_config()?;
    let mut out: Vec<McpServerStatus> = Vec::new();
    for cfg in &config.servers {
        if !cfg.enabled { continue }
        match mcp_start_server(cfg.name.clone()).await {
            Ok(s) => out.push(s),
            Err(e) => out.push(McpServerStatus {
                name: cfg.name.clone(),
                running: false,
                enabled: cfg.enabled,
                command: cfg.command.clone(),
                args: cfg.args.clone(),
                tools: Vec::new(),
                error: e,
            }),
        }
    }
    Ok(out)
}

fn status_from_session(session: &McpSession) -> McpServerStatus {
    McpServerStatus {
        name: session.name.clone(),
        running: true,
        enabled: session.config.enabled,
        command: session.config.command.clone(),
        args: session.config.args.clone(),
        tools: session.tools.lock().unwrap().clone(),
        error: session.error.lock().unwrap().clone(),
    }
}
