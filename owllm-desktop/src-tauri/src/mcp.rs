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

fn default_true() -> bool {
    true
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct McpConfig {
    #[serde(default)]
    pub servers: Vec<McpServerConfig>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpPackInstallResult {
    pub added: Vec<String>,
    pub updated: Vec<String>,
    pub uv_installed: bool,
    pub config_path: String,
}

fn config_path() -> Option<PathBuf> {
    // Honors portable mode via the shared resolver (USB-portable Block 1).
    Some(crate::paths::owllm_config_home()?.join("mcp_config.json"))
}

#[tauri::command]
pub fn mcp_load_config() -> Result<McpConfig, String> {
    let Some(path) = config_path() else {
        return Ok(McpConfig::default());
    };
    if !path.is_file() {
        return Ok(McpConfig::default());
    }
    let raw =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

#[tauri::command]
pub fn mcp_save_config(config: McpConfig) -> Result<(), String> {
    let Some(path) = config_path() else {
        return Err("no home directory".to_string());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(&config).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("write {}: {e}", path.display()))
}

#[tauri::command]
pub async fn mcp_install_pack(
    servers: Vec<McpServerConfig>,
) -> Result<McpPackInstallResult, String> {
    if servers.is_empty() {
        return Err("MCP pack has no servers".to_string());
    }

    let needs_uv = servers
        .iter()
        .any(|s| matches!(s.command.as_str(), "uv" | "uvx"));
    let mut uv_installed = false;
    if needs_uv {
        install_uv().await?;
        uv_installed = true;
    }

    let mut config = mcp_load_config()?;
    let mut added = Vec::new();
    let mut updated = Vec::new();

    for mut server in servers {
        server.name = server.name.trim().to_string();
        server.command = server.command.trim().to_string();
        if server.name.is_empty() || server.command.is_empty() {
            return Err("MCP pack contains a server with an empty name or command".to_string());
        }

        if let Some(existing) = config.servers.iter_mut().find(|s| s.name == server.name) {
            for (k, v) in existing.env.iter() {
                if !v.trim().is_empty() {
                    server.env.entry(k.clone()).or_insert_with(|| v.clone());
                }
            }
            *existing = server.clone();
            updated.push(server.name);
        } else {
            added.push(server.name.clone());
            config.servers.push(server);
        }
    }

    mcp_save_config(config)?;
    Ok(McpPackInstallResult {
        added,
        updated,
        uv_installed,
        config_path: config_path()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
    })
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
///
/// First checks our private bundled-runtimes dir (LLM/runtime/uv/),
/// then falls back to PATH + the common install dirs. Means once
/// install_uv has run, the user gets uvx without touching PowerShell
/// or installing anything system-wide.
fn resolve_command(command: &str, args: &[String]) -> (PathBuf, Vec<String>) {
    let candidates = [
        format!("{command}.exe"),
        format!("{command}.cmd"),
        command.to_string(),
    ];
    // Private OwLLM-managed runtimes — keep our bundled tooling out of
    // the user's system PATH but always preferred when present. Phase 3
    // checks BOTH %LOCALAPPDATA%\OwLLM Desktop\runtime\<uv,node>\ and
    // the legacy LLM/runtime/<uv,node>/ locations.
    let mut runtime_roots: Vec<PathBuf> = Vec::new();
    if let Some(rt) = crate::paths::runtime_root() {
        runtime_roots.push(rt);
    }
    if let Some(root) = crate::paths::llm_root() {
        let legacy = root.join("runtime");
        if !runtime_roots.contains(&legacy) {
            runtime_roots.push(legacy);
        }
    }
    let mut resolved: Option<PathBuf> = None;
    'outer: for rt in &runtime_roots {
        for sub in ["uv", "node"] {
            let dir = rt.join(sub);
            for cand in &candidates {
                let p = dir.join(cand);
                if p.is_file() {
                    resolved = Some(p);
                    break 'outer;
                }
            }
        }
    }
    // Installed mcp-toolchain module (the wizard's install path — on
    // Linux ARM64 it's the only bundled node/uv source). node lives in
    // <module>/bin/, uv + uvx in <module>/uv/.
    let resolved = resolved.or_else(|| {
        let mut module_dirs: Vec<PathBuf> = Vec::new();
        if let Some(dir) = crate::paths::module_node_dir() {
            module_dirs.push(dir);
        }
        if let Some(uv) = crate::paths::module_uv_exe() {
            if let Some(dir) = uv.parent() {
                module_dirs.push(dir.to_path_buf());
            }
        }
        for dir in &module_dirs {
            for cand in &candidates {
                let p = dir.join(cand);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
        None
    });
    let resolved = resolved
        .or_else(|| {
            candidates
                .iter()
                .find_map(|n| crate::accounts::which_extended(n))
        })
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
        let mut wrapped: Vec<String> =
            vec!["/c".to_string(), resolved.to_string_lossy().to_string()];
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
            "uvx" | "uv" => " — install the MCP Toolchain module (Home → modules), or Astral uv via `winget install --id=astral-sh.uv` (Windows) / `pip install uv`, then restart OwLLM Desktop so the new PATH is picked up.",
            "npx" | "npm" | "node" => " — install the MCP Toolchain module (Home → modules), or Node.js from nodejs.org (gives you npx + npm), then restart OwLLM Desktop.",
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
                if trimmed.is_empty() {
                    continue;
                }
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
                if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                    break;
                }
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
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("stdin write: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("stdin flush: {e}"))?;
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

async fn send_notification(
    session: &McpSession,
    method: &str,
    params: Value,
) -> Result<(), String> {
    let payload = json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    });
    let line = format!("{}\n", payload.to_string());
    let mut stdin = session.stdin.lock().await;
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("stdin write: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("stdin flush: {e}"))?;
    Ok(())
}

async fn mcp_initialize(session: &McpSession) -> Result<(), String> {
    // MCP spec 2024-11-05 handshake.
    let init_params = json!({
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {
            "name": "owllm-desktop",
            "version": crate::APP_VERSION.as_str(),
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
            let input_schema = item.get("inputSchema").cloned().unwrap_or(json!({}));
            Some(McpToolSpec {
                name,
                description,
                input_schema,
            })
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
    )
    .await?;
    // Standard MCP response shape: {content: [{type, text}], isError?}
    let is_error = result
        .get("isError")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let content = result
        .get("content")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();
    let parts: Vec<String> = content
        .iter()
        .filter_map(|c| {
            let kind = c.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match kind {
                "text" => c
                    .get("text")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                "image" => Some(format!(
                    "[image: {} bytes]",
                    c.get("data")
                        .and_then(|v| v.as_str())
                        .map(|s| s.len())
                        .unwrap_or(0)
                )),
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
        if !cfg.enabled {
            continue;
        }
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

// ===== Runtime installer =====
//
// Some MCP servers (duckduckgo, sqlite, git, sentry, fetch, time) are
// distributed as PyPI packages and run via `uvx`. Asking end users to
// open PowerShell and run `winget install astral-sh.uv` to make them
// work is a non-starter for a desktop product. We bundle uv into our
// own LLM/runtime/uv/ dir the same way python_runtime/ and
// runtime/llama.cpp/ already work — private to OwLLM, no admin rights,
// no system PATH pollution.

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub name: String,
    pub installed: bool,
    pub path: String, // empty when not installed
}

/// Where bundled runtimes (uv, node, llama.cpp) live. Phase 3 puts new
/// installs in %LOCALAPPDATA%\OwLLM Desktop\runtime\<name>\; reads also
/// check the legacy LLM/runtime/<name>/ location for installs that
/// happened before the move.
fn runtime_dir(name: &str) -> Option<PathBuf> {
    // Prefer the new tree.
    if let Some(rt) = crate::paths::runtime_root() {
        let p = rt.join(name);
        // Caller uses this for both writes (install) and reads (status).
        // Always return the new path as the write target; the resolver
        // for the EXE (resolve_command) handles legacy fallback.
        return Some(p);
    }
    crate::paths::llm_root().map(|r| r.join("runtime").join(name))
}

#[tauri::command]
pub fn runtime_status(name: String) -> RuntimeStatus {
    let path = runtime_dir(&name);
    let exe_name = if cfg!(windows) {
        format!("{name}x.exe") // uvx.exe (uv ships `uv.exe` + `uvx.exe` in the same zip)
    } else {
        format!("{name}x")
    };
    let installed = path
        .as_ref()
        .map(|p| p.join(&exe_name).is_file())
        .unwrap_or(false);
    RuntimeStatus {
        name,
        installed,
        path: path
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

/// Download + extract Astral uv to LLM/runtime/uv/. Idempotent — when
/// uvx.exe is already present we short-circuit. Returns the install
/// dir path on success.
///
/// Source: github.com/astral-sh/uv/releases/latest/download/uv-<arch>.
/// We extract only the uv/uvx launchers from the host archive.
#[tauri::command]
pub async fn install_uv() -> Result<String, String> {
    let dir =
        runtime_dir("uv").ok_or_else(|| "no LLM root — repo layout unexpected".to_string())?;
    let uvx_exe = if cfg!(windows) {
        dir.join("uvx.exe")
    } else {
        dir.join("uvx")
    };
    if uvx_exe.is_file() {
        return Ok(dir.to_string_lossy().into_owned());
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;

    // Pick the right release asset for the host.
    let asset = if cfg!(all(windows, target_arch = "x86_64")) {
        "uv-x86_64-pc-windows-msvc.zip"
    } else if cfg!(all(windows, target_arch = "aarch64")) {
        "uv-aarch64-pc-windows-msvc.zip"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "uv-aarch64-apple-darwin.tar.gz"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "uv-x86_64-apple-darwin.tar.gz"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "uv-x86_64-unknown-linux-gnu.tar.gz"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "uv-aarch64-unknown-linux-gnu.tar.gz"
    } else {
        return Err(format!(
            "no uv release asset known for this host ({} {}) — install uv manually",
            std::env::consts::OS,
            std::env::consts::ARCH
        ));
    };
    let url = format!("https://github.com/astral-sh/uv/releases/latest/download/{asset}");

    let cli = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = cli
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("download {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download HTTP {} from {url}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("read bytes: {e}"))?;

    // Windows ships a zip; macOS/Linux ship tar.gz archives. Both have
    // a top-level folder, so match on the file name suffix.
    if asset.ends_with(".zip") {
        let cursor = std::io::Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("zip open: {e}"))?;
        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("zip entry {i}: {e}"))?;
            // The zip stores files like "uv-x86_64-pc-windows-msvc/uv.exe"
            // OR plain "uv.exe" depending on release version — handle both
            // by matching on the file_name() suffix.
            let entry_name = entry.name().to_string();
            let basename = std::path::Path::new(&entry_name)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(&entry_name)
                .to_string();
            if !matches!(basename.as_str(), "uv.exe" | "uvx.exe") {
                continue;
            }
            let out_path = dir.join(&basename);
            let mut out_file = std::fs::File::create(&out_path)
                .map_err(|e| format!("create {}: {e}", out_path.display()))?;
            std::io::copy(&mut entry, &mut out_file)
                .map_err(|e| format!("extract {basename}: {e}"))?;
        }
    } else if asset.ends_with(".tar.gz") {
        let cursor = std::io::Cursor::new(bytes);
        let decoder = flate2::read::GzDecoder::new(cursor);
        let mut archive = tar::Archive::new(decoder);
        let entries = archive.entries().map_err(|e| format!("tar entries: {e}"))?;
        for entry in entries {
            let mut entry = entry.map_err(|e| format!("tar entry: {e}"))?;
            let path = entry
                .path()
                .map_err(|e| format!("tar path: {e}"))?
                .into_owned();
            let Some(basename) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if !matches!(basename, "uv" | "uvx") {
                continue;
            }
            let out_path = dir.join(basename);
            let mut out_file = std::fs::File::create(&out_path)
                .map_err(|e| format!("create {}: {e}", out_path.display()))?;
            std::io::copy(&mut entry, &mut out_file)
                .map_err(|e| format!("extract {basename}: {e}"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut perms = std::fs::metadata(&out_path)
                    .map_err(|e| format!("metadata {}: {e}", out_path.display()))?
                    .permissions();
                perms.set_mode(0o755);
                std::fs::set_permissions(&out_path, perms)
                    .map_err(|e| format!("chmod {}: {e}", out_path.display()))?;
            }
        }
    } else {
        return Err(format!("unknown uv asset archive type ({asset})"));
    }

    if !uvx_exe.is_file() {
        return Err(format!(
            "uv archive extracted but {} not found — archive layout may have changed; install uv manually as a fallback",
            uvx_exe.display(),
        ));
    }
    Ok(dir.to_string_lossy().into_owned())
}
