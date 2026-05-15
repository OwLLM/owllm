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
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Instant;

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
