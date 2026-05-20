// Accounts module — API-key + subscription-CLI state for the React
// AccountsPage. Persists API keys to ~/.owllm/agent_secrets.json,
// matching the legacy Python format (LLM/desktop_app/
// agent_runtime_manager.py:_secrets_path) so users who already
// configured keys in the PySide6 app don't lose them.
//
// Subscription routes (claude_cli, codex_cli) are detected via PATH:
// if the corresponding CLI is available + has a credentials file in
// its conventional location, the card flips to Connected.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Instant;
use tauri::ipc::Channel;

/// Windows: prevent a flashing console window when we shell out to
/// the claude / codex CLIs. 0x08000000 = CREATE_NO_WINDOW.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Quote an argument for cmd.exe so it round-trips through a .cmd /
/// .bat shim to the underlying program (npm installs Claude Code as
/// `claude.cmd` on Windows, which wraps `node cli.js`). This bypasses
/// Rust's CVE-2024-24576 BatBadBut guard (which rejects any arg
/// containing `"`, `\n`, etc. when the target is a batch file) by
/// going through `CommandExt::raw_arg` and doing the escaping
/// ourselves. Without this every dispatch fails with
/// "spawn claude: batch file arguments are invalid" because the
/// orchestrator's system prompt contains newlines.
#[cfg(windows)]
fn win_quote_arg(s: &str) -> String {
    // Batch arg parsing treats CR/LF as separators. Collapse to space
    // so a multi-line system prompt arrives as a single argument.
    let s = s.replace('\r', "").replace('\n', " ");
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let mut bs = 0;
        while i < chars.len() && chars[i] == '\\' {
            bs += 1;
            i += 1;
        }
        if i == chars.len() {
            for _ in 0..(bs * 2) { out.push('\\'); }
        } else if chars[i] == '"' {
            for _ in 0..(bs * 2 + 1) { out.push('\\'); }
            out.push('"');
            i += 1;
        } else {
            for _ in 0..bs { out.push('\\'); }
            out.push(chars[i]);
            i += 1;
        }
    }
    out.push('"');
    out
}

#[cfg(windows)]
fn is_batch_shim(p: &std::path::Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let e = e.to_ascii_lowercase();
            e == "cmd" || e == "bat"
        })
        .unwrap_or(false)
}

/// Push an arg onto `cmd`, going through `raw_arg` + manual quoting
/// when `batch` is true (Windows .cmd / .bat shim) so we bypass Rust's
/// BatBadBut guard. Plain `arg()` is fine for .exe and for non-Windows.
fn push_arg(cmd: &mut Command, _batch: bool, arg: &str) {
    #[cfg(windows)]
    {
        if _batch {
            use std::os::windows::process::CommandExt;
            cmd.raw_arg(win_quote_arg(arg));
            return;
        }
    }
    cmd.arg(arg);
}

/// Where API keys live on disk. Same path as the legacy Python store.
fn secrets_path() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))?;
    let p = PathBuf::from(home).join(".owllm").join("agent_secrets.json");
    Some(p)
}

/// Read the secrets file. Returns an empty map when the file is
/// missing or unreadable so callers can treat "no keys" identically.
fn load_secrets() -> BTreeMap<String, String> {
    let Some(path) = secrets_path() else { return BTreeMap::new() };
    let Ok(raw) = std::fs::read_to_string(&path) else { return BTreeMap::new() };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_secrets(map: &BTreeMap<String, String>) -> Result<(), String> {
    let path = secrets_path().ok_or_else(|| "could not resolve home dir".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let s = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    std::fs::write(&path, s).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct AccountsStatus {
    /// ANTHROPIC_API_KEY is set + non-empty.
    pub anthropic_api_key: bool,
    /// OPENAI_API_KEY is set + non-empty.
    pub openai_api_key: bool,
    /// Claude CLI is installed AND has logged-in credentials.
    pub claude_cli: bool,
    /// OpenAI Codex CLI is installed AND has logged-in credentials.
    pub codex_cli: bool,
}

/// Probe what's connected right now. Cheap — runs on the AccountsPage
/// 3-second poll loop. Never returns the secret values themselves.
#[tauri::command]
pub fn accounts_status() -> AccountsStatus {
    let map = load_secrets();
    AccountsStatus {
        anthropic_api_key: map
            .get("ANTHROPIC_API_KEY")
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false),
        openai_api_key: map
            .get("OPENAI_API_KEY")
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false),
        claude_cli: claude_cli_logged_in(),
        codex_cli: codex_cli_logged_in(),
    }
}

/// Save a single API key. `name` is the env-var name
/// (ANTHROPIC_API_KEY / OPENAI_API_KEY); `value` is the raw key.
/// Empty value behaves like `accounts_delete_secret` for parity with
/// the legacy Python helper.
#[tauri::command]
pub fn accounts_save_api_key(name: String, value: String) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return accounts_delete_secret(name);
    }
    let mut map = load_secrets();
    map.insert(name, trimmed.to_string());
    write_secrets(&map)
}

#[tauri::command]
pub fn accounts_delete_secret(name: String) -> Result<(), String> {
    let mut map = load_secrets();
    map.remove(&name);
    if map.is_empty() {
        // Delete the file when empty so a stale {} doesn't linger.
        if let Some(path) = secrets_path() {
            if path.exists() {
                let _ = std::fs::remove_file(&path);
            }
        }
        return Ok(());
    }
    write_secrets(&map)
}

/// Return the secret value for `name` (or None when not set). Used by
/// the dispatch loop on the React side to make authenticated requests
/// to api.anthropic.com / api.openai.com. Keeping this on the Rust
/// side means the key only crosses the IPC boundary on demand.
#[tauri::command]
pub fn accounts_get_secret(name: String) -> Option<String> {
    let map = load_secrets();
    map.get(&name).cloned().filter(|v| !v.trim().is_empty())
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ProbeResult {
    pub ok: bool,
    pub detail: String,
    pub elapsed_ms: u64,
}

/// Lightweight credential probe. For API keys we just check the value
/// is present + non-empty + has the conventional prefix; for the CLIs
/// we check the credentials file exists. A full round-trip probe lives
/// in a future slice (needs a Rust HTTP client). The fast local probe
/// is enough to surface "key was saved" vs "key got cleared".
#[tauri::command]
pub fn accounts_test_probe(backend: String) -> ProbeResult {
    let start = Instant::now();
    let (ok, detail) = match backend.as_str() {
        "claude_api" => {
            let v = load_secrets().get("ANTHROPIC_API_KEY").cloned();
            match v {
                Some(k) if k.starts_with("sk-ant-") => (true, "Key present (sk-ant-…)".to_string()),
                Some(_) => (false, "Key does not start with 'sk-ant-'".to_string()),
                None => (false, "No ANTHROPIC_API_KEY saved".to_string()),
            }
        }
        "openai_api" => {
            let v = load_secrets().get("OPENAI_API_KEY").cloned();
            match v {
                Some(k) if k.starts_with("sk-") => (true, "Key present (sk-…)".to_string()),
                Some(_) => (false, "Key does not start with 'sk-'".to_string()),
                None => (false, "No OPENAI_API_KEY saved".to_string()),
            }
        }
        "claude_cli" => {
            if claude_cli_logged_in() {
                (true, "claude CLI credentials found".to_string())
            } else {
                (false, "claude CLI not installed or not logged in".to_string())
            }
        }
        "codex_cli" => {
            if codex_cli_logged_in() {
                (true, "codex CLI credentials found".to_string())
            } else {
                (false, "codex CLI not installed or not logged in".to_string())
            }
        }
        other => (false, format!("Unknown backend '{}'", other)),
    };
    ProbeResult {
        ok,
        detail,
        elapsed_ms: start.elapsed().as_millis() as u64,
    }
}

// ---------------------------------------------------------------------
// Subscription-CLI dispatch — runs `claude --print` non-interactively
// so the agentic loop can use the user's Claude Code subscription
// when no ANTHROPIC_API_KEY is saved.
// ---------------------------------------------------------------------

/// Locate the `claude` executable. Searches PATH for `claude.exe`,
/// `claude.cmd`, then `claude`. Returns the resolved path or None.
fn find_claude_cli() -> Option<PathBuf> {
    // npm's Windows shim is `claude.cmd` (no extension on Unix).
    for name in ["claude.exe", "claude.cmd", "claude"] {
        if let Ok(path) = which_in_path(name) {
            return Some(path);
        }
    }
    None
}

fn which_in_path(name: &str) -> Result<PathBuf, ()> {
    let path_var = std::env::var_os("PATH").ok_or(())?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(())
}

/// One-shot completion via `claude --print`. Streams the user's
/// system + user prompt on stdin and returns the full reply text on
/// stdout. No token-level streaming — Claude Code's --print mode
/// only emits the final response, not a token-by-token feed.
///
/// `cwd`, when supplied, is set as the child process working directory
/// so the CLI's repo / project context matches what the user picked on
/// the agentic LocationRow. Without this the CLI inherits the desktop
/// app's install dir and ends up summarising the wrong tree (the bug
/// users hit when they pointed Location at one folder but the bot
/// reported on another).
///
/// `auto_approve` toggles `--dangerously-skip-permissions`. The user
/// flips "auto-approve every tool call" on the SuperUserCard (or in
/// the Telegram bridge config) when they're driving the agent
/// unattended — without this flag the CLI prompts for every file
/// write and the bridge stalls. The flag is intentionally namespaced
/// `dangerously-` by the CLI; the runner only honours it when the
/// user explicitly opts in.
#[tauri::command]
pub async fn claude_cli_complete(
    system_prompt: String,
    user_message: String,
    cwd: Option<String>,
    auto_approve: Option<bool>,
    // Bare Claude model id ("claude-opus-4-7", "sonnet", etc). When
    // supplied, passed as `--model <id>` so the picker's row choice
    // actually steers the subscription. Without it the CLI uses its
    // own default — which is why all the picker's sub rows used to
    // behave identically.
    model: Option<String>,
    // Effort tier on the subscription path: "low" | "medium" | "high"
    // | "xhigh" | "max". Passed verbatim as `--effort <level>`. Maps
    // from the picker's "extra_high" UI label to the CLI's "xhigh"
    // in the JS layer; this just forwards.
    effort: Option<String>,
    // Optional UUID for session persistence (Phase B). When the same
    // id is reused across dispatches, the CLI loads the prior turn so
    // the agent has memory without re-feeding history via prompt.
    session_id: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let exe = find_claude_cli()
            .ok_or_else(|| "claude CLI not found on PATH — install Claude Code first".to_string())?;
        let mut cmd = Command::new(&exe);

        // On Windows, npm installs `claude.cmd`. Rust 1.77 rejects
        // multi-line args to .cmd files via `arg()`. Route every arg
        // through `raw_arg` with our own quoting when the shim is a
        // batch file. Non-Windows / `.exe` use the normal arg() path.
        #[cfg(windows)]
        let batch = is_batch_shim(&exe);
        #[cfg(not(windows))]
        let batch = false;

        push_arg(&mut cmd, batch, "--print");
        if let Some(m) = model.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            push_arg(&mut cmd, batch, "--model");
            push_arg(&mut cmd, batch, m);
        }
        if let Some(e) = effort.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            push_arg(&mut cmd, batch, "--effort");
            push_arg(&mut cmd, batch, e);
        }
        if let Some(sid) = session_id.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            push_arg(&mut cmd, batch, "--session-id");
            push_arg(&mut cmd, batch, sid);
        }
        if auto_approve.unwrap_or(false) {
            // `--permission-mode bypassPermissions` is the canonical
            // modern flag (see `claude --help`). Older `--dangerously-
            // skip-permissions` requires a one-time interactive
            // acknowledgement that --print mode never gets to perform,
            // so it ends up not applying. permission-mode just sets
            // the session mode and skips every prompt for this run.
            push_arg(&mut cmd, batch, "--permission-mode");
            push_arg(&mut cmd, batch, "bypassPermissions");
        }
        if !system_prompt.trim().is_empty() {
            push_arg(&mut cmd, batch, "--append-system-prompt");
            push_arg(&mut cmd, batch, &system_prompt);
        }
        // Pin the CLI to the project's location. Skip silently if the
        // path is empty / non-existent so a misconfigured project
        // falls back to the inherited cwd instead of failing the
        // dispatch outright.
        if let Some(dir) = cwd.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            let p = std::path::Path::new(dir);
            if p.is_dir() {
                cmd.current_dir(p);
            }
        }
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| format!("spawn claude: {e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(user_message.as_bytes())
                .map_err(|e| format!("write stdin: {e}"))?;
        }
        // Wait as long as the CLI needs. Real agentic coding sessions
        // routinely run 15-30 min under bypassPermissions; the previous
        // 10-minute wall-clock cap was killing them mid-flight. The
        // bridge runner already serializes dispatches, so a long run
        // can't pile up against itself; that's a sufficient guard
        // against resource exhaustion. If the CLI truly wedges, the
        // user can close the app to terminate the child (it's spawned
        // as a child of this process, so OS process cleanup gets it).
        let output = child
            .wait_with_output()
            .map_err(|e| format!("wait claude: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            return Err(format!(
                "claude CLI exited {} — {}",
                output.status.code().unwrap_or(-1),
                if stderr.is_empty() { "no stderr".to_string() } else { stderr.trim().to_string() }
            ));
        }
        let stdout = String::from_utf8(output.stdout).map_err(|e| format!("decode stdout: {e}"))?;
        Ok(stdout.trim().to_string())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

// ---------------------------------------------------------------------
// Streaming Claude CLI dispatch — runs `claude --print --output-format
// stream-json --verbose` so the agentic UI can see thinking content
// blocks and tool_use calls as the CLI emits them, instead of waiting
// for one final blob from --print.
// ---------------------------------------------------------------------

/// One streaming event from the Claude CLI. Frontend receives these on
/// a Tauri Channel and routes text → reply pane, thinking → Thought
/// tab (italic), tool_use → Thought tab (monospace), tool_result →
/// Thought tab (under the matching tool's id).
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ClaudeStreamEvent {
    /// User-facing reply text. Multiple events accumulate into the
    /// final message in the Reply pane.
    Text { delta: String },
    /// Extended-thinking content. Streamed as the CLI emits assistant
    /// messages with `thinking` content blocks.
    Thinking { delta: String },
    /// The CLI is invoking a tool. `input` is the JSON arguments,
    /// pretty-printed; `tool_use_id` lets us match the matching
    /// `tool_result` back to this call.
    ToolUse { tool_use_id: String, name: String, input: String },
    /// The result of a tool call (file contents, command output, etc.).
    /// Surfaced under the same Thought block as the matching tool_use
    /// so the user sees both the request and its outcome.
    ToolResult { tool_use_id: String, content: String },
    /// Non-fatal error during stream parsing — surfaced so the user
    /// knows the dispatch had partial trouble, but the CLI keeps
    /// running.
    Error { message: String },
}

/// Streaming completion via `claude --print --output-format stream-json
/// --verbose`. Each line of CLI stdout is one JSON event; we parse it
/// and forward the relevant pieces over the supplied Channel. Returns
/// the assembled assistant text on completion.
///
/// `cwd` and `auto_approve` behave identically to claude_cli_complete.
/// Map an OWLLM-style role tool name (read_file, edit_file, shell, …)
/// to the corresponding Claude Code CLI tool name. Returns None for
/// OWLLM-only tools that have no Claude CLI equivalent (dispatch,
/// verify, ssh_*) — they're silently dropped so the role still works
/// when the dispatch resolves to the CLI subscription.
fn map_owllm_tool_to_cli(name: &str) -> Option<&'static str> {
    match name {
        "read_file" => Some("Read"),
        "edit_file" => Some("Edit"),
        "write_file_with_diff" => Some("Write"),
        "list_dir" | "glob_files" => Some("Glob"),
        "grep" => Some("Grep"),
        "shell" => Some("Bash"),
        "todo_write" => Some("TodoWrite"),
        "http_get" => Some("WebFetch"),
        "web_search" | "search_web" => Some("WebSearch"),
        // OWLLM-internal control tools — no CLI counterpart.
        "dispatch" | "verify" | "ssh_exec" | "ssh_upload" | "ssh_download" => None,
        _ => None,
    }
}

#[tauri::command]
pub async fn claude_cli_stream(
    system_prompt: String,
    user_message: String,
    cwd: Option<String>,
    auto_approve: Option<bool>,
    // Optional per-role tool gate. When supplied, gets translated to
    // `--allowedTools "<Tool> <Tool> …"` so the CLI hard-rejects any
    // other tool the model tries. None / empty / containing "all"
    // passes through unrestricted (operator role behaviour).
    allowed_tools: Option<Vec<String>>,
    // Bare Claude model id; passes as `--model <id>`. See claude_cli_complete.
    model: Option<String>,
    // Effort tier: low/medium/high/xhigh/max. Passes as `--effort`.
    effort: Option<String>,
    // Optional UUID for session persistence — same id across calls
    // gives the agent multi-turn memory.
    session_id: Option<String>,
    // When true, pass `--brief` so the SendUserMessage tool is
    // enabled. The streaming consumer detects SendUserMessage tool
    // calls and surfaces the agent's question to the UI (Phase C).
    brief_mode: Option<bool>,
    on_event: Channel<ClaudeStreamEvent>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let exe = find_claude_cli()
            .ok_or_else(|| "claude CLI not found on PATH — install Claude Code first".to_string())?;
        let mut cmd = Command::new(&exe);

        #[cfg(windows)]
        let batch = is_batch_shim(&exe);
        #[cfg(not(windows))]
        let batch = false;

        push_arg(&mut cmd, batch, "--print");
        if let Some(m) = model.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            push_arg(&mut cmd, batch, "--model");
            push_arg(&mut cmd, batch, m);
        }
        if let Some(e) = effort.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            push_arg(&mut cmd, batch, "--effort");
            push_arg(&mut cmd, batch, e);
        }
        if let Some(sid) = session_id.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            push_arg(&mut cmd, batch, "--session-id");
            push_arg(&mut cmd, batch, sid);
        }
        if brief_mode.unwrap_or(false) {
            // --brief enables the SendUserMessage tool so the model
            // can mid-turn ask the user a question. The streaming
            // consumer below routes those to the UI as a prompt.
            push_arg(&mut cmd, batch, "--brief");
        }
        // stream-json + --verbose: the CLI emits one NDJSON event per
        // line. Without --verbose, stream-json suppresses assistant
        // messages and only the final result event is produced —
        // exactly what we don't want.
        push_arg(&mut cmd, batch, "--output-format");
        push_arg(&mut cmd, batch, "stream-json");
        push_arg(&mut cmd, batch, "--verbose");
        if auto_approve.unwrap_or(false) {
            push_arg(&mut cmd, batch, "--permission-mode");
            push_arg(&mut cmd, batch, "bypassPermissions");
        }
        // Hard tool gate: each agent role declares a tool_allowlist
        // (read_file, shell, …). Translate to CLI tool names and pass
        // as --allowedTools so the CLI rejects anything outside the
        // allowed set. The `operator` role uses ["all"] → skip the
        // flag so it gets the full CLI surface.
        if let Some(allowed) = allowed_tools.as_ref() {
            let wants_all = allowed.iter().any(|t| t == "all");
            if !wants_all && !allowed.is_empty() {
                let cli_tools: Vec<&str> = allowed
                    .iter()
                    .filter_map(|t| map_owllm_tool_to_cli(t))
                    .collect();
                if !cli_tools.is_empty() {
                    push_arg(&mut cmd, batch, "--allowedTools");
                    push_arg(&mut cmd, batch, &cli_tools.join(" "));
                }
            }
        }
        if !system_prompt.trim().is_empty() {
            push_arg(&mut cmd, batch, "--append-system-prompt");
            push_arg(&mut cmd, batch, &system_prompt);
        }
        if let Some(dir) = cwd.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            let p = std::path::Path::new(dir);
            if p.is_dir() {
                cmd.current_dir(p);
            }
        }
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| format!("spawn claude: {e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(user_message.as_bytes())
                .map_err(|e| format!("write stdin: {e}"))?;
            // Closing stdin signals EOF — without this the CLI sits
            // waiting for more input and never emits anything.
            drop(stdin);
        }
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "no stdout pipe".to_string())?;
        let reader = BufReader::new(stdout);
        let mut assembled = String::new();
        for line_res in reader.lines() {
            let line = match line_res {
                Ok(l) => l,
                Err(e) => {
                    let _ = on_event.send(ClaudeStreamEvent::Error {
                        message: format!("read stdout: {e}"),
                    });
                    continue;
                }
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            // Parse the NDJSON line. Skip malformed lines silently —
            // the CLI sometimes interleaves a non-JSON warning before
            // the first event when, e.g., a config file is missing.
            let v: serde_json::Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let event_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match event_type {
                "assistant" => {
                    // Each assistant event is one full message with a
                    // content array. Walk the blocks and emit per-block
                    // events so the frontend can route each to the
                    // right pane (text → reply, thinking → italic,
                    // tool_use → monospace command block).
                    if let Some(content) = v
                        .get("message")
                        .and_then(|m| m.get("content"))
                        .and_then(|c| c.as_array())
                    {
                        for block in content {
                            let bkind =
                                block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                            match bkind {
                                "text" => {
                                    if let Some(t) =
                                        block.get("text").and_then(|t| t.as_str())
                                    {
                                        assembled.push_str(t);
                                        let _ = on_event.send(ClaudeStreamEvent::Text {
                                            delta: t.to_string(),
                                        });
                                    }
                                }
                                "thinking" => {
                                    if let Some(t) =
                                        block.get("thinking").and_then(|t| t.as_str())
                                    {
                                        let _ = on_event.send(ClaudeStreamEvent::Thinking {
                                            delta: t.to_string(),
                                        });
                                    }
                                }
                                "tool_use" => {
                                    let id = block
                                        .get("id")
                                        .and_then(|i| i.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let name = block
                                        .get("name")
                                        .and_then(|n| n.as_str())
                                        .unwrap_or("tool")
                                        .to_string();
                                    // Pretty-print the JSON input so a
                                    // multi-line shell command stays
                                    // readable in the Thought tab.
                                    let input = block
                                        .get("input")
                                        .map(|i| {
                                            serde_json::to_string_pretty(i)
                                                .unwrap_or_else(|_| i.to_string())
                                        })
                                        .unwrap_or_default();
                                    let _ = on_event.send(ClaudeStreamEvent::ToolUse {
                                        tool_use_id: id,
                                        name,
                                        input,
                                    });
                                }
                                _ => {}
                            }
                        }
                    }
                }
                "user" => {
                    // Tool result blocks come back wrapped in a user
                    // event — the CLI is showing what the tool did.
                    if let Some(content) = v
                        .get("message")
                        .and_then(|m| m.get("content"))
                        .and_then(|c| c.as_array())
                    {
                        for block in content {
                            if block.get("type").and_then(|t| t.as_str())
                                == Some("tool_result")
                            {
                                let id = block
                                    .get("tool_use_id")
                                    .and_then(|i| i.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let content_str = match block.get("content") {
                                    Some(c) if c.is_string() => {
                                        c.as_str().unwrap_or("").to_string()
                                    }
                                    Some(c) if c.is_array() => c
                                        .as_array()
                                        .unwrap()
                                        .iter()
                                        .filter_map(|p| {
                                            p.get("text")
                                                .and_then(|t| t.as_str())
                                                .map(|s| s.to_string())
                                        })
                                        .collect::<Vec<_>>()
                                        .join("\n"),
                                    _ => String::new(),
                                };
                                let _ = on_event.send(ClaudeStreamEvent::ToolResult {
                                    tool_use_id: id,
                                    content: content_str,
                                });
                            }
                        }
                    }
                }
                "result" => {
                    // Final summary event — carries the full assistant
                    // text in the `result` field. We've already streamed
                    // it via assistant text blocks, but if no assistant
                    // event ever fired (ultra-fast result), surface this
                    // as the reply.
                    if let Some(t) = v.get("result").and_then(|r| r.as_str()) {
                        if assembled.is_empty() && !t.is_empty() {
                            assembled.push_str(t);
                            let _ = on_event.send(ClaudeStreamEvent::Text {
                                delta: t.to_string(),
                            });
                        }
                    }
                }
                _ => {}
            }
        }
        let status = child.wait().map_err(|e| format!("wait claude: {e}"))?;
        if !status.success() {
            // Drain stderr after exit to surface the failure reason.
            let mut stderr_buf = String::new();
            if let Some(mut stderr) = child.stderr.take() {
                let _ = stderr.read_to_string(&mut stderr_buf);
            }
            return Err(format!(
                "claude CLI exited {} — {}",
                status.code().unwrap_or(-1),
                if stderr_buf.is_empty() {
                    "no stderr".to_string()
                } else {
                    stderr_buf.trim().to_string()
                }
            ));
        }
        Ok(assembled.trim().to_string())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

// ---------------------------------------------------------------------
// Subscription-CLI detection helpers
// ---------------------------------------------------------------------

/// Claude CLI persists its OAuth token at ~/.claude/.credentials.json
/// (anthropic-ai/claude-code). Presence of the file is a reliable
/// "logged in" signal; presence of just the binary on PATH is not.
fn claude_cli_logged_in() -> bool {
    let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) else {
        return false;
    };
    let creds = PathBuf::from(home).join(".claude").join(".credentials.json");
    creds.exists()
}

/// OpenAI Codex CLI persists its token at ~/.openai/auth.json (per
/// the OpenAI codex repo). Same logic as Claude.
fn codex_cli_logged_in() -> bool {
    let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) else {
        return false;
    };
    // Codex actually stores in ~/.codex/auth.json now; older releases
    // used ~/.openai/. Treat either as logged in.
    let p1 = PathBuf::from(&home).join(".codex").join("auth.json");
    let p2 = PathBuf::from(&home).join(".openai").join("auth.json");
    p1.exists() || p2.exists()
}
