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
use serde_json::json;
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

// ---- Stop support: registry of live agent-CLI children ---------------------
// The UI's Stop button aborts the JS AbortController, but that abort never
// reached the spawned claude/codex/kimi/gemini child — it ran to completion
// and the awaited invoke() kept the run "busy" (the "Stop never works" bug).
// Every agent-CLI spawn registers its PID here; `cli_cancel_all` kills them
// all (tree-kill on Windows — the npm .cmd shims wrap a node child that must
// die with the shim). Global on purpose: Stop means "stop everything", the
// same semantics the dock's Stop already promises.
fn cli_children() -> &'static std::sync::Mutex<std::collections::HashSet<u32>> {
    static S: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<u32>>> =
        std::sync::OnceLock::new();
    S.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

fn register_cli_child(child: &std::process::Child) -> u32 {
    let pid = child.id();
    if let Ok(mut s) = cli_children().lock() {
        s.insert(pid);
    }
    pid
}

fn unregister_cli_child(pid: u32) {
    if let Ok(mut s) = cli_children().lock() {
        s.remove(&pid);
    }
}

/// Wait for a registered CLI child and drop it from the kill registry no
/// matter how the wait ends. Used by every one-shot `*_cli_complete` path.
fn wait_cli_child(mut child: std::process::Child, pid: u32) -> std::io::Result<std::process::Output> {
    let out = child.wait_with_output();
    unregister_cli_child(pid);
    out
}

/// Kill every live agent-CLI child. Windows needs `taskkill /T /F`: the
/// process we spawned is often a cmd.exe batch shim whose real work happens
/// in a node/python grandchild — killing only the shim leaves the agent
/// running. Returns how many processes were signalled.
#[tauri::command]
pub fn cli_cancel_all() -> Result<u32, String> {
    let pids: Vec<u32> = cli_children()
        .lock()
        .map(|s| s.iter().copied().collect())
        .unwrap_or_default();
    let mut killed = 0u32;
    for pid in pids {
        #[cfg(windows)]
        let ok = {
            let mut c = Command::new("taskkill");
            c.args(["/PID", &pid.to_string(), "/T", "/F"]);
            c.stdout(Stdio::null());
            c.stderr(Stdio::null());
            use std::os::windows::process::CommandExt;
            c.creation_flags(CREATE_NO_WINDOW);
            c.status().map(|s| s.success()).unwrap_or(false)
        };
        #[cfg(not(windows))]
        let ok = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            killed += 1;
        }
        unregister_cli_child(pid);
    }
    Ok(killed)
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
/// Honors portable mode via the shared resolver (USB-portable Block 1).
fn secrets_path() -> Option<PathBuf> {
    Some(crate::paths::owllm_config_home()?.join("agent_secrets.json"))
}

/// Read the secrets file. Returns an empty map when the file is
/// missing or unreadable so callers can treat "no keys" identically.
fn load_secrets() -> BTreeMap<String, String> {
    let Some(path) = secrets_path() else { return BTreeMap::new() };
    let Ok(raw) = std::fs::read_to_string(&path) else { return BTreeMap::new() };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// All saved secrets (API keys + tokens). Used by the sandbox to mirror keys
/// into the isolated environment so isolated agents/CLIs can reach every
/// provider, not just the ones with an OAuth login file.
pub fn all_secrets() -> BTreeMap<String, String> {
    load_secrets()
}

fn nonempty(map: &BTreeMap<String, String>, key: &str) -> bool {
    map.get(key).map(|s| !s.trim().is_empty()).unwrap_or(false)
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
    /// MOONSHOT_API_KEY is set + non-empty. Moonshot AI's Kimi
    /// platform — OpenAI-compatible REST API at api.moonshot.ai/v1.
    pub moonshot_api_key: bool,
    /// DEEPSEEK_API_KEY for api.deepseek.com (OpenAI-compatible).
    pub deepseek_api_key: bool,
    /// XAI_API_KEY for api.x.ai (Grok, OpenAI-compatible).
    pub xai_api_key: bool,
    /// GROQ_API_KEY for api.groq.com (OpenAI-compatible, ultra-fast LPU).
    pub groq_api_key: bool,
    /// PERPLEXITY_API_KEY for api.perplexity.ai (Sonar, OAI-compatible).
    pub perplexity_api_key: bool,
    /// MISTRAL_API_KEY for api.mistral.ai (OpenAI-compatible).
    pub mistral_api_key: bool,
    /// TOGETHER_API_KEY for api.together.xyz (hosts open-source models).
    pub together_api_key: bool,
    /// GEMINI_API_KEY (or GOOGLE_API_KEY) for Google's Gemini REST.
    pub gemini_api_key: bool,
    /// HF_TOKEN — HuggingFace user access token.
    pub hf_token: bool,
    /// Claude Code CLI is installed AND has logged-in credentials.
    pub claude_cli: bool,
    /// OpenAI Codex CLI is installed AND has logged-in credentials.
    pub codex_cli: bool,
    /// Kimi Code CLI (MoonshotAI/kimi-cli) is installed AND logged in.
    pub kimi_cli: bool,
    /// Google Gemini CLI (google-gemini/gemini-cli) is installed AND
    /// logged in (~/.gemini/ contains OAuth cache).
    pub gemini_cli: bool,
}

/// Probe what's connected right now. Cheap — runs on the AccountsPage
/// 3-second poll loop. Never returns the secret values themselves.
/// Probe what's connected right now. ASYNC + spawn_blocking: the CLI
/// detection shells out (which/npm/CLI probes — slow on Windows), and a
/// SYNC Tauri command runs on the event-loop thread shared by ALL windows.
/// On the AccountsPage's 3-second poll that froze the whole UI for the
/// duration of those subprocess spawns; changing page mid-probe left the
/// app "Not Responding", which made Windows draw a ghost frame (the stray
/// "OwLLM Overlay Frame" title bar the user saw). Moving the work off the
/// main thread keeps the UI responsive during the probe.
#[tauri::command]
pub async fn accounts_status() -> AccountsStatus {
    tokio::task::spawn_blocking(accounts_status_blocking)
        .await
        .unwrap_or_default()
}

fn accounts_status_blocking() -> AccountsStatus {
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
        moonshot_api_key: nonempty(&map, "MOONSHOT_API_KEY"),
        deepseek_api_key:  nonempty(&map, "DEEPSEEK_API_KEY"),
        xai_api_key:       nonempty(&map, "XAI_API_KEY"),
        groq_api_key:      nonempty(&map, "GROQ_API_KEY"),
        perplexity_api_key: nonempty(&map, "PERPLEXITY_API_KEY"),
        mistral_api_key:   nonempty(&map, "MISTRAL_API_KEY"),
        together_api_key:  nonempty(&map, "TOGETHER_API_KEY"),
        gemini_api_key:    nonempty(&map, "GEMINI_API_KEY") || nonempty(&map, "GOOGLE_API_KEY"),
        gemini_cli:        gemini_cli_logged_in(),
        hf_token: map
            .get("HF_TOKEN")
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false),
        claude_cli: claude_cli_logged_in(),
        codex_cli: codex_cli_logged_in(),
        kimi_cli: kimi_cli_logged_in(),
    }
}

// ---------------------------------------------------------------------
// Account usage — VS Code-style quota bars for the account behind the
// active model — works for ALL models: provider quota bars where a
// quota API exists (today only the Claude subscription — the CLI's own
// /usage screen reads the same OAuth endpoint), plus the app's OWN
// recorded traffic (usage_tally) for every provider, since plain API
// keys and local models have no client-readable quota.
// ---------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// Human label, e.g. "Session (5hr)" / "Weekly (7 day)".
    pub label: String,
    /// 0..100 — percentage of the window already used.
    pub used_pct: f64,
    /// ISO timestamp when the window resets (UI renders "Resets in Xh").
    pub resets_at: Option<String>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsage {
    pub available: bool,
    pub provider: String,
    /// Why quota windows are unavailable (ignored when `available`).
    pub note: String,
    pub windows: Vec<UsageWindow>,
    /// App-recorded traffic for this provider — present for EVERY model
    /// (local GGUF, API keys, CLIs), independent of quota availability.
    pub stats: Vec<UsageStat>,
    /// Provider-reported account balance (e.g. "¥49.59") when available.
    /// Independent of quota windows; rendered as plain text by the UI.
    pub balance: Option<String>,
}

/// One aggregate row of the app's own usage tally ("Session (5h)" /
/// "Weekly (7 day)"). `tokens_est` is chars/4 — an ESTIMATE, and the UI
/// labels it as one; we never fabricate provider-exact token counts.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UsageStat {
    pub label: String,
    pub turns: i64,
    pub tokens_est: i64,
}

// ---- Local usage tally: model-agnostic usage recording ----------------
// Quota APIs are provider-specific (today only the Claude subscription
// exposes one), so the app records its OWN traffic per provider in
// owllm_state.db. That makes the USAGE panel work for ALL models: quota
// bars when the provider reports them, recorded-traffic stats always.

fn usage_db() -> Option<rusqlite::Connection> {
    let path = crate::projects::project_db_path()?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = rusqlite::Connection::open(&path).ok()?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS usage_tally (\
            id INTEGER PRIMARY KEY AUTOINCREMENT,\
            provider TEXT NOT NULL,\
            model TEXT NOT NULL DEFAULT '',\
            chars_in INTEGER NOT NULL DEFAULT 0,\
            chars_out INTEGER NOT NULL DEFAULT 0,\
            ts INTEGER NOT NULL\
        );\
        CREATE INDEX IF NOT EXISTS idx_usage_tally ON usage_tally(provider, ts);",
    )
    .ok()?;
    Some(conn)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Record one completed model turn. Fired best-effort from the UI's
/// single dispatch router (streamChatCompletion) after each turn, for
/// every provider. Also prunes rows older than 8 days (the widest
/// window shown is 7 days).
#[tauri::command]
pub async fn usage_record(provider: String, model: String, chars_in: i64, chars_out: i64) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let Some(conn) = usage_db() else { return };
        let ts = now_ms();
        let _ = conn.execute(
            "INSERT INTO usage_tally(provider, model, chars_in, chars_out, ts) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![provider.to_lowercase(), model, chars_in.max(0), chars_out.max(0), ts],
        );
        let _ = conn.execute(
            "DELETE FROM usage_tally WHERE ts < ?1",
            rusqlite::params![ts - 8 * 24 * 3600 * 1000],
        );
    })
    .await
    .map_err(|e| e.to_string())
}

/// Session (5h) + Weekly (7d) aggregates of the app's recorded traffic
/// for `provider`. Empty when nothing was recorded yet.
fn usage_tally_stats(provider: &str) -> Vec<UsageStat> {
    let Some(conn) = usage_db() else { return Vec::new() };
    let now = now_ms();
    let p = provider.to_lowercase();
    let mut out = Vec::new();
    for (label, span_ms) in [
        ("Session (5h)", 5i64 * 3600 * 1000),
        ("Weekly (7 day)", 7i64 * 24 * 3600 * 1000),
    ] {
        let row = conn
            .query_row(
                "SELECT count(*), coalesce(sum(chars_in + chars_out), 0) FROM usage_tally WHERE provider = ?1 AND ts >= ?2",
                rusqlite::params![p, now - span_ms],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
            )
            .unwrap_or((0, 0));
        if row.0 > 0 {
            out.push(UsageStat {
                label: label.to_string(),
                turns: row.0,
                tokens_est: row.1 / 4,
            });
        }
    }
    out
}

/// Pretty label for the OAuth usage endpoint's window keys. Unknown keys
/// (new windows Anthropic adds) fall back to the key with underscores
/// spaced — never dropped.
fn usage_window_label(key: &str) -> String {
    match key {
        "five_hour" => "Session (5hr)".to_string(),
        "seven_day" => "Weekly (7 day)".to_string(),
        "seven_day_opus" => "Weekly Opus".to_string(),
        "seven_day_sonnet" => "Weekly Sonnet".to_string(),
        "seven_day_oauth_apps" => "Weekly (apps)".to_string(),
        other => other.replace('_', " "),
    }
}

/// Usage for the account behind `provider` (a `providerFor()` string from
/// the UI, e.g. "claude_cli"). Network + file reads → spawn_blocking-free
/// async via reqwest; every failure path returns a explanatory struct
/// instead of an Err so the UI never surfaces a red toast for a quota bar.
#[tauri::command]
pub async fn account_usage(provider: String) -> AccountUsage {
    let p = provider.to_lowercase();
    // App-recorded traffic first — present for EVERY provider, so the
    // panel shows real numbers even where no quota API exists.
    let stats = {
        let p2 = p.clone();
        tokio::task::spawn_blocking(move || usage_tally_stats(&p2))
            .await
            .unwrap_or_default()
    };
    let empty = || AccountUsage {
        available: false,
        provider: provider.clone(),
        note: String::new(),
        windows: Vec::new(),
        stats: stats.clone(),
        balance: None,
    };
    let unavailable = |note: &str| AccountUsage {
        note: note.to_string(),
        ..empty()
    };

    // Provider-specific quota / balance APIs. Each branch is responsible
    // for returning a fully-formed AccountUsage on success OR failure.
    if p.contains("claude") || p.contains("anthropic") {
        return fetch_anthropic_usage(&provider, &stats).await;
    }
    if p.contains("moonshot") || p.contains("kimi") {
        return fetch_moonshot_balance(&provider, &stats).await;
    }

    // Everything else (OpenAI/Codex, Gemini, DeepSeek, xAI, Groq,
    // Perplexity, Mistral, Together, local models) has no client-readable
    // quota/balance API we can query with an API key. Return the app's own
    // recorded traffic plus a short note so the panel isn't blank.
    let pretty = match p.as_str() {
        "openai" | "codex" => "OpenAI / Codex",
        "gemini" => "Gemini",
        "deepseek" => "DeepSeek",
        "xai" => "xAI",
        "groq" => "Groq",
        "perplexity" => "Perplexity",
        "mistral" => "Mistral",
        "together" => "Together",
        "local" | "tuned" => "Local model",
        _ => &provider,
    };
    unavailable(&format!(
        "{pretty} does not expose a usage/balance API — showing this app's recorded traffic"
    ))
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

/// Fetch Claude/Anthropic OAuth usage windows.
async fn fetch_anthropic_usage(provider: &str, stats: &[UsageStat]) -> AccountUsage {
    let empty = || AccountUsage {
        available: false,
        provider: provider.to_string(),
        note: String::new(),
        windows: Vec::new(),
        stats: stats.to_vec(),
        balance: None,
    };
    let unavailable = |note: &str| AccountUsage {
        note: note.to_string(),
        ..empty()
    };
    // OAuth token from the Claude CLI's credential store (same file
    // claude_cli_logged_in() checks; sandbox mirroring copies this too).
    let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) else {
        return unavailable("no home dir");
    };
    let creds_path = PathBuf::from(home).join(".claude").join(".credentials.json");
    let Ok(raw) = std::fs::read_to_string(&creds_path) else {
        return unavailable("Claude CLI is not logged in (no credentials file)");
    };
    let token = serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| {
            v.get("claudeAiOauth")
                .and_then(|o| o.get("accessToken"))
                .and_then(|t| t.as_str())
                .map(|s| s.to_string())
        });
    let Some(token) = token else {
        return unavailable("no OAuth access token in the Claude CLI credentials");
    };
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => return unavailable(&format!("http client: {e}")),
    };
    // The same endpoint the Claude CLI's /usage screen reads.
    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await;
    let resp = match resp {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => return unavailable(&format!("usage endpoint returned {}", r.status())),
        Err(e) => return unavailable(&format!("usage request failed: {e}")),
    };
    let body: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => return unavailable(&format!("usage response unreadable: {e}")),
    };
    // Parse generically: every top-level object carrying a numeric
    // "utilization" is a quota window — robust to Anthropic adding windows.
    let mut windows = Vec::new();
    if let Some(map) = body.as_object() {
        for (key, val) in map {
            let Some(util) = val.get("utilization").and_then(|u| u.as_f64()) else { continue };
            windows.push(UsageWindow {
                label: usage_window_label(key),
                used_pct: util,
                resets_at: val
                    .get("resets_at")
                    .and_then(|r| r.as_str())
                    .map(|s| s.to_string()),
            });
        }
    }
    if windows.is_empty() {
        return unavailable("usage endpoint returned no quota windows");
    }
    // Fractions (all ≤ 1.0) → percentages; the endpoint has reported 0-100.
    if windows.iter().all(|w| w.used_pct <= 1.0) {
        for w in &mut windows {
            w.used_pct *= 100.0;
        }
    }
    for w in &mut windows {
        w.used_pct = w.used_pct.clamp(0.0, 100.0);
    }
    AccountUsage {
        available: true,
        provider: provider.to_string(),
        note: String::new(),
        windows,
        stats: stats.to_vec(),
        balance: None,
    }
}

/// Fetch Moonshot/Kimi account balance from the Open Platform API.
/// Works for both the API-key route and the subscription CLI route when a
/// MOONSHOT_API_KEY is saved. Returns stats-only when no key is saved.
async fn fetch_moonshot_balance(provider: &str, stats: &[UsageStat]) -> AccountUsage {
    let empty = || AccountUsage {
        available: false,
        provider: provider.to_string(),
        note: String::new(),
        windows: Vec::new(),
        stats: stats.to_vec(),
        balance: None,
    };
    let unavailable = |note: &str| AccountUsage {
        note: note.to_string(),
        ..empty()
    };

    let secrets = load_secrets();
    let Some(key) = secrets.get("MOONSHOT_API_KEY").cloned().filter(|v| !v.trim().is_empty()) else {
        return unavailable("Moonshot API key not saved — showing this app's recorded traffic");
    };

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => return unavailable(&format!("http client: {e}")),
    };

    // Try international endpoint first, then China mainland. Both share the
    // same response shape; only one will work for a given API key.
    let endpoints = [
        "https://api.moonshot.ai/v1/users/me/balance",
        "https://api.moonshot.cn/v1/users/me/balance",
    ];
    let mut last_err = String::new();
    for url in endpoints {
        let resp = client
            .get(url)
            .header("Authorization", format!("Bearer {key}"))
            .send()
            .await;
        let resp = match resp {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                last_err = format!("{url} returned {}", r.status());
                continue;
            }
            Err(e) => {
                last_err = format!("{url} request failed: {e}");
                continue;
            }
        };
        let body: serde_json::Value = match resp.json().await {
            Ok(v) => v,
            Err(e) => {
                last_err = format!("{url} response unreadable: {e}");
                continue;
            }
        };
        // Expected: { "code": 0, "data": { "available_balance": ..., "voucher_balance": ..., "cash_balance": ... }, ... }
        if body.get("code").and_then(|c| c.as_i64()) != Some(0) {
            last_err = format!("{url} returned code {:?}", body.get("code"));
            continue;
        }
        let data = body.get("data").cloned().unwrap_or_default();
        let avail = data.get("available_balance").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let cash = data.get("cash_balance").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let voucher = data.get("voucher_balance").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let balance = format!(
            "Available ¥{avail:.2} (cash ¥{cash:.2} · voucher ¥{voucher:.2})"
        );
        return AccountUsage {
            available: false,
            provider: provider.to_string(),
            note: String::new(),
            windows: Vec::new(),
            stats: stats.to_vec(),
            balance: Some(balance),
        };
    }
    unavailable(&format!("balance endpoint unreachable ({last_err})"))
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
        "moonshot_api" => generic_api_probe(&load_secrets(), "MOONSHOT_API_KEY", Some("sk-")),
        "deepseek_api" => generic_api_probe(&load_secrets(), "DEEPSEEK_API_KEY", Some("sk-")),
        "xai_api"      => generic_api_probe(&load_secrets(), "XAI_API_KEY", Some("xai-")),
        "groq_api"     => generic_api_probe(&load_secrets(), "GROQ_API_KEY", Some("gsk_")),
        "perplexity_api" => generic_api_probe(&load_secrets(), "PERPLEXITY_API_KEY", Some("pplx-")),
        "mistral_api"  => generic_api_probe(&load_secrets(), "MISTRAL_API_KEY", None),
        "together_api" => generic_api_probe(&load_secrets(), "TOGETHER_API_KEY", None),
        "gemini_api"   => {
            // Google accepts either env var; check both.
            let map = load_secrets();
            if nonempty(&map, "GEMINI_API_KEY") || nonempty(&map, "GOOGLE_API_KEY") {
                (true, "Key present".to_string())
            } else {
                (false, "No GEMINI_API_KEY (or GOOGLE_API_KEY) saved".to_string())
            }
        }
        "gemini_cli" => {
            if gemini_cli_logged_in() {
                (true, "gemini CLI credentials found".to_string())
            } else {
                (false, "gemini CLI not installed or not logged in".to_string())
            }
        }
        "huggingface" => {
            // HF user-access tokens are prefixed "hf_" (read tokens
            // and write tokens alike). The prefix isn't enforced by
            // HF — older tokens may not have it — so we accept any
            // non-empty value but flag the common "hf_" pattern as
            // the green path.
            let v = load_secrets().get("HF_TOKEN").cloned();
            match v {
                Some(k) if k.starts_with("hf_") => (true, "Token present (hf_…)".to_string()),
                Some(k) if !k.trim().is_empty() => (true, format!("Token present ({} chars)", k.len())),
                _ => (false, "No HF_TOKEN saved".to_string()),
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
        "kimi_cli" => {
            if kimi_cli_logged_in() {
                (true, "kimi CLI credentials found".to_string())
            } else {
                (false, "kimi CLI not installed or not logged in".to_string())
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

/// Live round-trip probe — actually calls the CLI / API endpoint and
/// surfaces real failures (subscription required, quota exceeded,
/// API key invalid). The existing accounts_test_probe is presence-only
/// and would happily return "key present (sk-…)" for a logged-in but
/// free-tier kimi account, even though dispatch later fails. This
/// command exists so the Test button can fail honestly. Fires only
/// Refresh the credentials that a SANDBOXED project's subscription CLI actually
/// reads — the fix for the recurring agentic-team 401 on subscription agents.
///
/// THE BUG: when a project is isolated, the team runs `claude`/`codex` INSIDE the
/// WSL sandbox (claude_cli_stream → sandbox::program_argv with cwd). That CLI reads
/// a one-time COPY of the Windows credentials (sandbox.rs `sync_logins` does
/// `cp -f`, then bwrap binds the distro's ~/.claude). Every warm/refresh/retry we
/// run only touches the WINDOWS token; the WSL copy goes stale (its access token
/// expires and its refresh token gets ROTATED/revoked by a Windows-side refresh),
/// so the in-sandbox CLI 401s forever — no host-side fix can reach it. Chat/Code
/// run the CLI on the Windows host directly, against the live token, so they never
/// show this — which is why it was agentic-team-ONLY.
///
/// THE FIX: re-copy the current Windows creds into the distro so the in-sandbox CLI
/// gets a valid token + valid refresh token. No-op when the project isn't isolated
/// (the host CLI already reads the live Windows creds). Called from the warm path
/// (proactive) and the auth-retry (reactive) in the frontend.
#[tauri::command]
pub async fn accounts_refresh_sandbox_creds(cwd: Option<String>) -> Result<bool, String> {
    if !crate::sandbox::is_isolated(cwd.as_deref()) {
        return Ok(false);
    }
    let fut = tokio::task::spawn_blocking(|| {
        // Re-mirror Windows → distro (claude/codex/gemini/kimi creds + keys). The
        // distro is resolved inside (best_linux_distro). Best-effort.
        let _ = crate::sandbox::sandbox_sync_logins(None);
        true
    });
    // BOUND IT: a cold / unresponsive WSL (classically right after a PC reboot) made
    // this WSL round-trip hang with no timeout — which blocked the warm-up, which
    // blocked the orchestrator's first call for MINUTES with no way to recover. On
    // timeout we give up (best-effort): the run proceeds, and the next warm cycle
    // re-syncs once WSL is healthy. Never let a stuck WSL stall a dispatch.
    match tokio::time::timeout(std::time::Duration::from_secs(20), fut).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(_)) | Err(_) => Ok(false),
    }
}

/// on user click, not on the 3-s status poll.
#[tauri::command]
pub async fn accounts_test_probe_live(backend: String) -> ProbeResult {
    let start = Instant::now();
    let (ok, detail) = match backend.as_str() {
        // -- CLI subscriptions: ask the CLI to print "ok" via a
        //    minimum-cost prompt. Any non-zero exit or stderr blob
        //    mentioning subscription/quota/auth is a real failure.
        // Claude Code CLI: --print is non-interactive, prompt goes on
        // stdin (no --prompt flag — that's REPL-only). Matches how
        // claude_cli_complete invokes it elsewhere in this file.
        "claude_cli" => probe_cli_subscription(
            find_claude_cli(), vec!["--print".into()], "Claude", Some("ok")).await,
        // OpenAI Codex CLI: `codex exec <prompt>` is the non-interactive
        // shape. There's no --print/--prompt; older docs to the contrary.
        // Two things have to be right or it exits 1 with "Reading additional
        // input from stdin...":
        //   1. The prompt is fed BOTH as the positional arg AND on stdin —
        //      older builds read the arg, newer ones read stdin; stdin is
        //      closed right after the write (EOF) so the stdin-style codex
        //      proceeds instead of hanging.
        //   2. The SAME non-interactive flags codex_cli_complete uses must be
        //      present. Without --skip-git-repo-check, codex run outside a git
        //      repo stops to read a confirmation from stdin (that "Reading
        //      additional input from stdin..." line) and exits 1 when it gets
        //      the prompt instead of a yes/no. --sandbox read-only + --color
        //      never keep the probe side-effect-free and unescaped. This is
        //      why the chat path worked but Test didn't — Test was missing
        //      the flags.
        "codex_cli" => probe_cli_subscription(
            find_codex_cli(),
            ["exec", "--skip-git-repo-check", "--color", "never",
             "--sandbox", "read-only", "ok"].iter().map(|s| s.to_string()).collect(),
            "Codex", Some("ok"),
        ).await,
        "kimi_cli" => {
            // Both legacy kimi-cli and current kimi-code support --print
            // non-interactive mode. Use the same shape as the chat path so the
            // probe is a real end-to-end check.
            // Model flag is config-aware: the CLI hard-rejects any id not
            // declared in its config (LLMNotSet), so we only force a model when
            // there is no configured default.
            let mut args: Vec<String> = vec![
                "--print".into(),
                "--output-format".into(),
                "text".into(),
                "--final-message-only".into(),
            ];
            args.extend(kimi_model_args(None));
            args.push("--prompt".into());
            args.push("ok".into());
            probe_cli_subscription(find_kimi_cli(), args, "Kimi", None).await
        }
        "gemini_cli" => probe_cli_subscription(
            find_gemini_cli(),
            vec![
                "--skip-trust".into(),
                "--output-format".into(),
                "text".into(),
                "--prompt".into(),
                "ok".into(),
            ],
            "Gemini",
            None,
        ).await,

        // -- API keys: HTTP GET the provider's /v1/models endpoint
        //    with the key in Authorization. 200 = valid. 401/403 =
        //    invalid key. Other = network / transient.
        "claude_api"     => probe_api_key("ANTHROPIC_API_KEY", "https://api.anthropic.com/v1/models", true).await,
        "openai_api"     => probe_api_key("OPENAI_API_KEY", "https://api.openai.com/v1/models", false).await,
        "moonshot_api"   => probe_api_key("MOONSHOT_API_KEY", "https://api.moonshot.ai/v1/models", false).await,
        "deepseek_api"   => probe_api_key("DEEPSEEK_API_KEY", "https://api.deepseek.com/v1/models", false).await,
        "xai_api"        => probe_api_key("XAI_API_KEY", "https://api.x.ai/v1/models", false).await,
        "groq_api"       => probe_api_key("GROQ_API_KEY", "https://api.groq.com/openai/v1/models", false).await,
        "perplexity_api" => probe_api_key("PERPLEXITY_API_KEY", "https://api.perplexity.ai/models", false).await,
        "mistral_api"    => probe_api_key("MISTRAL_API_KEY", "https://api.mistral.ai/v1/models", false).await,
        "together_api"   => probe_api_key("TOGETHER_API_KEY", "https://api.together.xyz/v1/models", false).await,
        "gemini_api" => {
            // Google's REST API takes the key as a query param, not
            // Authorization header. Probe the models list endpoint.
            let map = load_secrets();
            let key = map.get("GEMINI_API_KEY").or_else(|| map.get("GOOGLE_API_KEY")).cloned();
            match key.filter(|k| !k.trim().is_empty()) {
                Some(k) => {
                    let url = format!("https://generativelanguage.googleapis.com/v1beta/models?key={k}");
                    match http_get(&url, None).await {
                        Ok(200) => (true, "API responded 200 OK".to_string()),
                        Ok(s) => (false, format!("API responded HTTP {s} — key may be invalid")),
                        Err(e) => (false, format!("network: {e}")),
                    }
                }
                None => (false, "No GEMINI_API_KEY saved".to_string()),
            }
        }
        // HuggingFace: hit /api/whoami-v2 with the saved HF_TOKEN. The
        // endpoint returns 200 + the user's profile when the token is
        // valid, 401 on bad/expired tokens. AccessTokensPane's Test
        // button calls this; without an HF case here the live probe
        // returned "Unknown backend 'huggingface'" — the error chain
        // the user hit alongside the Save bug.
        "huggingface" => {
            let map = load_secrets();
            let key = map.get("HF_TOKEN").cloned().filter(|k| !k.trim().is_empty());
            match key {
                Some(k) => {
                    let bearer = format!("Bearer {k}");
                    match http_get(
                        "https://huggingface.co/api/whoami-v2",
                        Some(("Authorization", bearer)),
                    ).await {
                        Ok(200) => (true, "Token valid (HF /whoami-v2 → 200 OK)".to_string()),
                        Ok(401) => (false, "HF rejected the token (401 Unauthorized — expired or wrong scope)".to_string()),
                        Ok(s)   => (false, format!("HF responded HTTP {s}")),
                        Err(e)  => (false, format!("network: {e}")),
                    }
                }
                None => (false, "No HF_TOKEN saved — paste a token and Save first".to_string()),
            }
        }
        other => (false, format!("Unknown backend '{other}'")),
    };
    ProbeResult { ok, detail, elapsed_ms: start.elapsed().as_millis() as u64 }
}

/// Probe whether a backend's credentials are present INSIDE the WSL sandbox —
/// i.e. whether an *isolated* agent will be able to use it. Complements
/// accounts_test_probe (which tests the Windows host). CLIs → the in-distro
/// login file; API keys → the key in the sandbox env file (~/.owllm/agent_env.sh).
#[tauri::command]
pub async fn accounts_test_probe_wsl(backend: String) -> ProbeResult {
    let start = Instant::now();
    let (ok, detail) = tokio::task::spawn_blocking(move || wsl_probe(&backend))
        .await
        .unwrap_or((false, "probe failed".to_string()));
    ProbeResult { ok, detail, elapsed_ms: start.elapsed().as_millis() as u64 }
}

#[cfg(windows)]
fn wsl_probe(backend: &str) -> (bool, String) {
    // Use a real general-purpose distro, not a Docker/system one (which has no
    // bash → wsl exits 1 with a UTF-16 error that showed as garbled mojibake).
    let Some(distro) = crate::wsl::best_linux_distro() else {
        return (false, "No Ubuntu/Linux distro in WSL yet — set it up on Home".to_string());
    };
    // CLI backends get an HONEST 3-way probe instead of "does a config file
    // exist" (which was a false positive — it reported kimi/gemini as ready
    // when an isolated agent couldn't actually run them):
    //   NOBIN  — the binary isn't on the PATH the JAIL sees. The sandbox runner
    //            exposes /usr/local + system dirs, NOT ~/.local/bin, so a CLI
    //            installed there (e.g. `uv tool install kimi-cli`) is invisible
    //            to an isolated agent even though it runs in a plain shell.
    //   NOCRED — the binary is reachable but there's no REAL credential (e.g.
    //            gemini has a ~/.gemini dir full of history/state but no
    //            oauth_creds.json → "set an Auth method"; often means no login
    //            or no active subscription).
    //   YES    — installed where the agent can reach it AND a real credential.
    let cli_probe = |bin: &str, cred: &str| -> String {
        format!(
            "if ! PATH=/usr/local/bin:/usr/bin:/bin command -v {bin} >/dev/null 2>&1; then echo NOBIN; \
             elif ! {cred}; then echo NOCRED; else echo YES; fi"
        )
    };
    let script = match backend {
        "claude_cli" => cli_probe("claude", "[ -f ~/.claude/.credentials.json ]"),
        "codex_cli" => cli_probe("codex", "[ -f ~/.codex/auth.json ]"),
        // Modern kimi-code uses ~/.kimi-code; legacy kimi-cli used ~/.kimi.
        // Accept a credential or config file in either home.
        "kimi_cli" => cli_probe(
            "kimi",
            "{ [ -f ~/.kimi-code/credentials/kimi-code.json ] || [ -f ~/.kimi-code/config.toml ] || [ -f ~/.kimi/credentials/kimi-code.json ] || [ -f ~/.kimi/config.toml ]; }",
        ),
        "gemini_cli" => cli_probe("gemini", "[ -f ~/.gemini/oauth_creds.json ]"),
        other => {
            let var = match other {
                "claude_api" => "ANTHROPIC_API_KEY",
                "openai_api" => "OPENAI_API_KEY",
                "moonshot_api" => "MOONSHOT_API_KEY",
                "deepseek_api" => "DEEPSEEK_API_KEY",
                "xai_api" => "XAI_API_KEY",
                "groq_api" => "GROQ_API_KEY",
                "perplexity_api" => "PERPLEXITY_API_KEY",
                "mistral_api" => "MISTRAL_API_KEY",
                "together_api" => "TOGETHER_API_KEY",
                "gemini_api" => "GEMINI_API_KEY|GOOGLE_API_KEY",
                "huggingface" => "HF_TOKEN",
                _ => return (false, format!("No WSL check for '{other}'")),
            };
            format!("if grep -qE '{var}' ~/.owllm/agent_env.sh 2>/dev/null; then echo YES; else echo NO; fi")
        }
    };
    match crate::wsl::run_in_distro(&distro, &script) {
        Ok(o) if o.contains("YES") => (true, "Installed + logged in — an isolated agent can use it".to_string()),
        Ok(o) if o.contains("NOBIN") => (false,
            "CLI isn't installed where an isolated agent can reach it (the sandbox sees /usr/local, not ~/.local/bin) — re-run Install CLI for WSL.".to_string()),
        Ok(o) if o.contains("NOCRED") => (false,
            "Not actually logged in for an isolated agent — no real credential found. Sign in inside WSL (a paid subscription may be required).".to_string()),
        Ok(_) => (false, "Not in the WSL sandbox yet — add the API key or click 'Sync logins'".to_string()),
        Err(e) => (false, format!("WSL check failed: {e}")),
    }
}

#[cfg(not(windows))]
fn wsl_probe(_backend: &str) -> (bool, String) {
    (false, "WSL test is available on Windows only".to_string())
}

/// Real CLI round-trip. Runs the CLI with a tiny prompt and reads its
/// stdout + stderr. Heuristic for "subscription works":
///   * exit 0 AND stdout non-empty AND no subscription-error pattern
///     in stderr → success
///   * any subscription/quota/auth pattern in stdout OR stderr → fail
///     (surface a trimmed slice of the offending message)
///   * timeout (15 s) → fail
// stdin_text: text to write to the CLI's stdin (Claude takes the prompt
// this way under --print since it has no --prompt flag). None = no
// stdin (CLIs that accept the prompt as an argument).
async fn probe_cli_subscription(
    exe: Option<PathBuf>,
    args: Vec<String>,
    name: &'static str,
    stdin_text: Option<&'static str>,
) -> (bool, String) {
    let Some(exe) = exe else {
        return (false, format!("{name} CLI not found on PATH"));
    };
    let args_vec: Vec<String> = args;
    let exe_clone = exe.clone();
    let stdin_owned: Option<String> = stdin_text.map(|s| s.to_string());

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        tokio::task::spawn_blocking(move || {
            use std::io::Write as _;
            let mut cmd = Command::new(&exe_clone);
            #[cfg(windows)]
            let batch = is_batch_shim(&exe_clone);
            #[cfg(not(windows))]
            let batch = false;
            for a in &args_vec {
                push_arg(&mut cmd, batch, a);
            }
            cmd.stdin(if stdin_owned.is_some() { Stdio::piped() } else { Stdio::null() });
            cmd.stdout(Stdio::piped());
            cmd.stderr(Stdio::piped());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            let mut child = cmd.spawn().map_err(|e| e.to_string())?;
            if let Some(text) = &stdin_owned {
                if let Some(mut stdin) = child.stdin.take() {
                    let _ = stdin.write_all(text.as_bytes());
                }
            }
            child.wait_with_output().map_err(|e| e.to_string())
        }),
    )
    .await;

    let output = match result {
        Err(_) => return (false, format!("{name} CLI timed out after 15s — login may be stale")),
        Ok(Err(e)) => return (false, format!("{name} CLI join error: {e}")),
        Ok(Ok(Err(e))) => return (false, format!("{name} CLI spawn error: {e}")),
        Ok(Ok(Ok(out))) => out,
    };
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let combined = format!("{stdout}\n{stderr}");
    let lower = combined.to_ascii_lowercase();

    // Subscription / quota error patterns. Each CLI phrases these
    // differently; cast a wide net.
    let sub_errors: &[&str] = &[
        "subscription required",
        "upgrade your plan",
        "not subscribed",
        "free tier",
        "quota exceeded",
        "rate limit",
        "insufficient_quota",
        "not authenticated",
        "401",
        "403",
        "auth required",
        "please log in",
        "no credit",
        "billing required",
    ];
    if let Some(hit) = sub_errors.iter().find(|p| lower.contains(*p)) {
        let snippet = combined.lines()
            .find(|l| l.to_ascii_lowercase().contains(hit))
            .unwrap_or(*hit)
            .trim().to_string();
        let trimmed = if snippet.len() > 140 { format!("{}…", &snippet[..140]) } else { snippet };
        return (false, format!("{name}: {trimmed}"));
    }
    if !output.status.success() {
        let snippet = stderr.lines().next().unwrap_or("non-zero exit").trim().to_string();
        let trimmed = if snippet.len() > 140 { format!("{}…", &snippet[..140]) } else { snippet };
        return (false, format!("{name} CLI exited {}: {trimmed}", output.status.code().unwrap_or(-1)));
    }
    if stdout.trim().is_empty() {
        return (false, format!("{name} CLI returned empty output — model may have refused"));
    }
    (true, format!("{name} responded: {}", stdout.trim().chars().take(80).collect::<String>()))
}

/// Round-trip an API key against the provider's /v1/models endpoint.
/// `use_anthropic_header` switches the auth header to x-api-key
/// (Anthropic's convention) vs Authorization: Bearer.
async fn probe_api_key(env: &str, url: &str, use_anthropic_header: bool) -> (bool, String) {
    let map = load_secrets();
    let key = map.get(env).cloned().filter(|k| !k.trim().is_empty());
    let Some(key) = key else {
        return (false, format!("No {env} saved"));
    };
    let header = if use_anthropic_header {
        ("x-api-key", key)
    } else {
        ("Authorization", format!("Bearer {key}"))
    };
    match http_get(url, Some(header)).await {
        Ok(200) => (true, "API responded 200 OK".to_string()),
        Ok(401) | Ok(403) => (false, format!("API rejected key (HTTP {})", 401)),
        Ok(s)   => (false, format!("API responded HTTP {s}")),
        Err(e)  => (false, format!("network: {e}")),
    }
}

/// Thin reqwest GET wrapper that returns just the status code so the
/// probe helpers stay one-liner. Includes a 10-s timeout; anything
/// slower than that is surfaced as "network: timeout".
async fn http_get(url: &str, header: Option<(&str, String)>) -> Result<u16, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(url);
    if let Some((k, v)) = header {
        req = req.header(k, v);
    }
    // Anthropic requires the version header even on /v1/models.
    if url.contains("api.anthropic.com") {
        req = req.header("anthropic-version", "2023-06-01");
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    Ok(resp.status().as_u16())
}

// ---------------------------------------------------------------------
// Subscription-CLI dispatch — runs `claude --print` non-interactively
// so the agentic loop can use the user's Claude Code subscription
// when no ANTHROPIC_API_KEY is saved.
// ---------------------------------------------------------------------

/// Locate the `claude` executable. Searches PATH first, then the
/// canonical npm-global install dir (%APPDATA%\npm on Windows) via
/// which_extended. This catches users who just ran
/// `npm install -g @anthropic-ai/claude-code` without restarting us.
fn find_claude_cli() -> Option<PathBuf> {
    for name in ["claude.exe", "claude.cmd", "claude"] {
        if let Some(path) = which_extended(name) {
            return Some(path);
        }
    }
    None
}

/// Locate the `kimi` executable (Moonshot's Kimi Code CLI). Same
/// resolution shape as Claude — installed via pip, so the shim lives
/// in Python's Scripts dir which which_extended walks for us.
fn find_kimi_cli() -> Option<PathBuf> {
    for name in ["kimi.exe", "kimi.cmd", "kimi"] {
        if let Some(path) = which_extended(name) {
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

/// Extra dirs to search when a CLI isn't on PATH. The Tauri process
/// inherits PATH from whenever the desktop was launched — if the user
/// `pip install kimi-cli`s AFTER launch, the new kimi.exe lands in
/// %APPDATA%\Python\Python3X\Scripts (per-user pip) which isn't on
/// the inherited PATH and the card forever insists "kimi not found".
/// Restarting fixes it, but that's a terrible UX. Walking these
/// canonical install locations directly catches every standard pip /
/// npm global install layout without forcing a restart.
fn extra_search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    let appdata = std::env::var_os("APPDATA");
    let localappdata = std::env::var_os("LOCALAPPDATA");

    // Bundled Node.js runtime (the nodejs-runtime-* module). When the
    // user installed this from the Modules wizard, node.exe / npm.cmd /
    // npx.cmd all live in this directory — search it FIRST so a clean
    // PC with no system Node still resolves the CLI installer.
    if let Some(d) = crate::paths::module_node_dir() {
        dirs.push(d);
    }

    // npm global — Windows default for `npm install -g`.
    if let Some(ad) = &appdata {
        dirs.push(PathBuf::from(ad).join("npm"));
    }

    // pip --user / pipx — Windows: %APPDATA%\Python\PythonNNN\Scripts.
    // Walk every PythonNNN dir we find so 3.10/3.11/3.12 coexist.
    if let Some(ad) = &appdata {
        let py_root = PathBuf::from(ad).join("Python");
        if let Ok(entries) = std::fs::read_dir(&py_root) {
            for e in entries.flatten() {
                let scripts = e.path().join("Scripts");
                if scripts.is_dir() {
                    dirs.push(scripts);
                }
            }
        }
    }

    // Per-user Python install (no admin) — same Scripts layout under
    // %LOCALAPPDATA%\Programs\Python\PythonNNN\Scripts.
    if let Some(lad) = &localappdata {
        let py_root = PathBuf::from(lad).join("Programs").join("Python");
        if let Ok(entries) = std::fs::read_dir(&py_root) {
            for e in entries.flatten() {
                let scripts = e.path().join("Scripts");
                if scripts.is_dir() {
                    dirs.push(scripts);
                }
            }
        }
    }

    // System-wide Python install (admin) — C:\Python3NN\Scripts.
    #[cfg(windows)]
    if let Ok(entries) = std::fs::read_dir("C:\\") {
        for e in entries.flatten() {
            let name = e.file_name();
            if let Some(s) = name.to_str() {
                if s.starts_with("Python3") {
                    let scripts = e.path().join("Scripts");
                    if scripts.is_dir() {
                        dirs.push(scripts);
                    }
                }
            }
        }
    }

    // System Node.js install.
    #[cfg(windows)]
    {
        for p in [
            "C:\\Program Files\\nodejs",
            "C:\\Program Files (x86)\\nodejs",
        ] {
            let pp = PathBuf::from(p);
            if pp.is_dir() {
                dirs.push(pp);
            }
        }
    }

    // POSIX pip --user / pipx fallback.
    if let Some(h) = &home {
        let local_bin = PathBuf::from(h).join(".local").join("bin");
        if local_bin.is_dir() {
            dirs.push(local_bin);
        }
        // Rust/cargo-installed binaries (some codex distributions, misc
        // tools) and Volta-managed Node shims both live under the home dir.
        let cargo_bin = PathBuf::from(h).join(".cargo").join("bin");
        if cargo_bin.is_dir() { dirs.push(cargo_bin); }
        let volta_bin = PathBuf::from(h).join(".volta").join("bin");
        if volta_bin.is_dir() { dirs.push(volta_bin); }
    }

    // Volta on Windows installs its shims under %LOCALAPPDATA%\Volta\bin.
    #[cfg(windows)]
    if let Some(lad) = &localappdata {
        let volta = PathBuf::from(lad).join("Volta").join("bin");
        if volta.is_dir() { dirs.push(volta); }
    }

    // npm's REAL global prefix — THE catch-all for "claude / codex /
    // gemini not found" on a machine where `npm install -g` put the shim
    // somewhere none of the hard-coded guesses above cover (custom npmrc
    // prefix, nvm, fnm, volta, corporate setups). Ask npm itself; cached
    // to a single subprocess per run, and only reached when a PATH lookup
    // already missed (which_extended checks PATH first).
    dirs.extend(npm_global_bin_dirs());

    dirs
}

/// npm's global bin dir(s), resolved by asking npm `config get prefix`.
/// On Windows the global shims (`claude.cmd`, `codex.cmd`, …) live at
/// `<prefix>` itself; on POSIX at `<prefix>/bin`. Cached for the process
/// lifetime so we shell out at most once. Returns empty when npm isn't
/// reachable (then the other search dirs still apply).
fn npm_global_bin_dirs() -> Vec<PathBuf> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Vec<PathBuf>> = OnceLock::new();
    CACHE.get_or_init(|| {
        // Locate npm: PATH first, then the bundled Node.js runtime.
        let npm = ["npm.cmd", "npm.exe", "npm"]
            .iter()
            .find_map(|n| which_in_path(n).ok())
            .or_else(|| {
                crate::paths::module_node_dir().and_then(|d| {
                    ["npm.cmd", "npm.exe", "npm"]
                        .iter()
                        .map(|n| d.join(n))
                        .find(|c| c.is_file())
                })
            });
        let Some(npm) = npm else { return Vec::new(); };

        let mut cmd = Command::new(&npm);
        #[cfg(windows)]
        let batch = is_batch_shim(&npm);
        #[cfg(not(windows))]
        let batch = false;
        push_arg(&mut cmd, batch, "config");
        push_arg(&mut cmd, batch, "get");
        push_arg(&mut cmd, batch, "prefix");
        // Bundled Node on PATH so npm can resolve `node` if needed.
        if let Some(node_dir) = crate::paths::module_node_dir() {
            let existing = std::env::var("PATH").unwrap_or_default();
            #[cfg(windows)] let sep = ";";
            #[cfg(not(windows))] let sep = ":";
            cmd.env("PATH", format!("{}{sep}{}", node_dir.display(), existing));
        }
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let Ok(out) = cmd.output() else { return Vec::new(); };
        if !out.status.success() { return Vec::new(); }
        let prefix = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if prefix.is_empty() { return Vec::new(); }

        let base = PathBuf::from(&prefix);
        let mut dirs = Vec::new();
        if base.is_dir() { dirs.push(base.clone()); }   // Windows shims
        let bin = base.join("bin");
        if bin.is_dir() { dirs.push(bin); }             // POSIX layout
        dirs
    }).clone()
}

/// PATH search → fallback to extra_search_dirs. Use this anywhere we
/// need to locate a CLI/binary that the user may have just installed.
pub fn which_extended(name: &str) -> Option<PathBuf> {
    if let Ok(p) = which_in_path(name) {
        return Some(p);
    }
    for dir in extra_search_dirs() {
        let cand = dir.join(name);
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// True when a claude CLI error text reports a session-id collision
/// ("Session ID … is already in use"). Matched loosely so a wording
/// change in the CLI doesn't silently disable the retry.
fn is_session_in_use(err: &str) -> bool {
    let l = err.to_lowercase();
    l.contains("already in use") && l.contains("session")
}

/// Return a copy of `args` with the `--session-id <uuid>` pair removed,
/// so a conflicting call can retry with a fresh CLI-generated session.
fn strip_session_arg(args: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(args.len());
    let mut skip_next = false;
    for a in args {
        if skip_next {
            skip_next = false;
            continue;
        }
        if a == "--session-id" {
            skip_next = true;
            continue;
        }
        out.push(a.clone());
    }
    out
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
    // Per-run, user-consented widening of the CLI filesystem scope to the
    // user's home profile (--add-dir). Default None/false = NO widening: the
    // agent stays jailed to the project. Set true ONLY after the user approves
    // the "grant home for this run" prompt — never silently. See
    // sandbox::extra_allowed_dirs.
    grant_home: Option<bool>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        // Collect args once → run as the Windows CLI or inside WSL (isolated).
        let mut args: Vec<String> = Vec::new();
        args.push("--print".into());
        if let Some(m) = model.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            args.push("--model".into());
            args.push(m.to_string());
        }
        if let Some(e) = effort.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            args.push("--effort".into());
            args.push(e.to_string());
        }
        if let Some(sid) = session_id.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            args.push("--session-id".into());
            args.push(sid.to_string());
        }
        if auto_approve.unwrap_or(false) {
            args.push("--permission-mode".into());
            args.push("bypassPermissions".into());
        }
        // Widen the CLI's filesystem scope to the user's home profile ONLY when
        // the user has explicitly consented for this run (grant_home). Default is
        // NO widening — the agent stays jailed to the project, and a block on an
        // outside file surfaces a consent prompt in the UI instead of silently
        // opening the whole home dir. Empty (no-op) for a bwrap-jailed run anyway.
        // See sandbox::extra_allowed_dirs.
        if grant_home.unwrap_or(false) {
            for dir in crate::sandbox::extra_allowed_dirs(cwd.as_deref()) {
                args.push("--add-dir".into());
                args.push(dir);
            }
        }
        // The agentic system prompt (role + team + injected memory snapshot +
        // directives + skills) can be tens of KB. Windows caps a process command
        // line at ~32 KB, so passing it via `--append-system-prompt <arg>` blew up
        // once the team-memory snapshot grew → "spawn claude: The filename or
        // extension is too long. (os error 206)" — the orchestrator "crash after a
        // few seconds". Fix: keep the small case on the proven flag, but FOLD a
        // large system prompt into the stdin prompt (stdin is an unbounded pipe),
        // so the command line can never overflow no matter how big memory / roster
        // / skills get. The model reads the same content either way.
        // Deliver the agent's system prompt as a PROPER system prompt
        // (--append-system-prompt) whenever it fits — that is what keeps the model
        // behaving as its role. FOLDING it into stdin strips the role out of the
        // system position and makes a smart model (Opus 4.8) behave dumbly, so only
        // fold when the prompt would actually overflow the command line. The host
        // path takes a ~32 KB command line; the WSL path wraps args in a bash -lc
        // script (escaping expands length), so fold earlier there.
        let on_wsl = cwd.as_deref().and_then(crate::wsl::parse_wsl_unc).is_some();
        // On Windows the resolved `claude` is usually an npm `.cmd` shim, which Rust
        // must launch THROUGH cmd.exe — a ~8 KB command-line limit, NOT the ~32 KB of
        // a direct CreateProcess. A 24 KB --append-system-prompt then dies with "The
        // command line is too long." (exit 1, empty reply — the Code page "done" with
        // no output). When the host CLI is a batch shim, budget the system-prompt arg
        // against what the other flags already consumed and fold the rest into stdin.
        let host_batch_shim = !on_wsl
            && !crate::sandbox::is_isolated(cwd.as_deref())
            && find_claude_cli().map(|p| is_batch_shim(&p)).unwrap_or(false);
        let max_system_arg: usize = if host_batch_shim {
            let already: usize = args.iter().map(|a| a.len() + 3).sum::<usize>() + 96;
            7_000usize.saturating_sub(already)
        } else if on_wsl {
            10_000
        } else {
            24_000
        };
        let fold_system_into_stdin =
            !system_prompt.trim().is_empty() && system_prompt.len() > max_system_arg;
        if !system_prompt.trim().is_empty() && !fold_system_into_stdin {
            args.push("--append-system-prompt".into());
            args.push(system_prompt.clone());
        }
        // What actually gets piped to the CLI's stdin: just the user turn normally,
        // or system-prompt + user turn when we folded above.
        let stdin_payload = if fold_system_into_stdin {
            format!("{system_prompt}\n\n----- YOUR TASK -----\n\n{user_message}")
        } else {
            user_message.clone()
        };

        // Build + run wrapped in a closure so a "Session ID … is already in use"
        // failure RETRIES once WITHOUT --session-id. Cause: `--session-id X`
        // *creates* session X, so a reused id (or a stale session file from a
        // prior run) collides with what's already on disk — no concurrent
        // process needed. Doing the retry at the source guarantees the conflict
        // self-heals on every path; the prompt still carries the folded history,
        // so dropping the id costs nothing.
        let session_was_set = session_id.as_ref().map(|s| !s.trim().is_empty()).unwrap_or(false);
        let run_once = |args: &[String]| -> Result<String, String> {
            // WSL-isolated project → run `claude` inside the distro; else the
            // Windows CLI. (On Windows, npm installs claude.cmd; push_arg routes
            // multi-line args via raw_arg quoting for batch shims.)
            let mut cmd = if let Some((exe, sargs)) =
                crate::sandbox::program_argv(cwd.as_deref(), "claude", args)
            {
                let mut c = Command::new(exe);
                c.args(sargs);
                c
            } else {
                let exe = find_claude_cli()
                    .ok_or_else(|| "claude CLI not found on PATH — install Claude Code first".to_string())?;
                #[cfg(windows)]
                let batch = is_batch_shim(&exe);
                #[cfg(not(windows))]
                let batch = false;
                let mut c = Command::new(&exe);
                for a in args {
                    push_arg(&mut c, batch, a);
                }
                if let Some(dir) = cwd.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
                    let p = std::path::Path::new(dir);
                    if p.is_dir() {
                        c.current_dir(p);
                    }
                }
                c
            };
            cmd.stdin(Stdio::piped());
            cmd.stdout(Stdio::piped());
            cmd.stderr(Stdio::piped());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            let mut child = cmd.spawn().map_err(|e| format!("spawn claude: {e}"))?;
            let pid = register_cli_child(&child);
            if let Some(mut stdin) = child.stdin.take() {
                // Best-effort, like every OTHER CLI spawn here (`let _ =`). If claude
                // exited early — a rejected --model, a bad flag, an auth failure — its
                // stdin pipe is already closed and this write returns "pipe has been
                // ended (os error 109)". Propagating that (the old `?`) MASKED the real
                // reason: we returned the pipe error instead of reaching wait_with_output
                // below, which captures claude's actual stderr/exit. Swallow it; drop
                // stdin (EOF) and let the real error surface.
                let _ = stdin.write_all(stdin_payload.as_bytes());
            }
            // Wait as long as the CLI needs (agentic runs can be 15-30 min).
            let output = wait_cli_child(child, pid)
                .map_err(|e| format!("wait claude: {e}"))?;
            if !output.status.success() {
                // Non-zero exit can still carry a 401 in stdout with empty stderr —
                // surface the auth text (not a generic "exited N") so the retry fires.
                let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
                let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
                return Err(cli_exit_err("claude", output.status.code().unwrap_or(-1), &stdout, &stderr));
            }
            let stdout = String::from_utf8(output.stdout).map_err(|e| format!("decode stdout: {e}"))?;
            let trimmed = stdout.trim().to_string();
            // Exit 0 but the body is an auth-failure envelope (the CLI prints
            // "… API Error: 401 Invalid authentication credentials" and exits 0
            // when its OAuth token has expired) → surface as Err so the caller's
            // auth-retry (clearCliWarm + re-warm + backoff) runs, instead of
            // handing the 401 text back as the reply. See looks_like_cli_auth_error.
            if looks_like_cli_auth_error(&trimmed) || looks_like_transient_server_error(&trimmed) {
                return Err(trimmed);
            }
            Ok(trimmed)
        };
        match run_once(&args) {
            Err(e) if session_was_set && is_session_in_use(&e) => run_once(&strip_session_arg(&args)),
            other => other,
        }
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// The Claude / Codex subscription CLI can REPORT an authentication failure as a
/// *successful* response instead of a non-zero exit: in `--print` text mode it
/// prints `… API Error: 401 Invalid authentication credentials` to stdout and
/// exits 0; in `--output-format stream-json` it emits a `result` event with
/// `is_error: true` carrying the same text. In BOTH cases `status.success()` is
/// true, so without this check the 401 sails through as the agent's reply and
/// the frontend's auth-retry / token-refresh (which only triggers on a THROWN
/// error) never runs — the user just sees "Failed to authenticate…" as the
/// answer. This was the root cause behind every recurring "401 mid-run" report:
/// the retry machinery was downstream of a throw that never happened. Detect the
/// envelope so the command returns Err and the existing retry finally fires.
fn looks_like_cli_auth_error(text: &str) -> bool {
    let low = text.to_ascii_lowercase();
    low.contains("invalid authentication credentials")
        || low.contains("failed to authenticate")
        || low.contains("api error: 401")
        || low.contains("authentication_error")
        || low.contains("401 unauthorized")
        || low.contains("oauth token has expired")
        || low.contains("please run /login")
        || low.contains("please log in")
}

/// A TRANSIENT server-side error the CLI prints as its reply — Anthropic 529
/// "Overloaded", 503/502 service-unavailable, 429 rate-limit. These mean "try
/// again in a moment", not a real failure of the agent's work, so we surface them
/// as `Err` (like the auth envelope) — the frontend's withCliAuthRetry then matches
/// them via isTransientNetError and retries on a backoff instead of handing the
/// "API Error: 529 Overloaded" text back as the agent's answer.
fn looks_like_transient_server_error(text: &str) -> bool {
    let low = text.to_ascii_lowercase();
    low.contains("overloaded")
        || low.contains("api error: 529")
        || low.contains("error: 529")
        || low.contains("api error: 503")
        || low.contains("api error: 502")
        || low.contains("service unavailable")
        || low.contains("api error: 429")
        || low.contains("rate limit")
        || low.contains("too many requests")
}

/// Build the Err string for any subscription CLI (claude/codex/gemini/kimi) that
/// exited NON-ZERO. The CLIs frequently print the real cause — most importantly an
/// expired-token 401 — into their STDOUT / streamed body and exit non-zero with an
/// EMPTY stderr. A generic "<cli> CLI exited N — no stderr" then hides the auth
/// envelope, so the frontend's `isCliAuthError` can't match it and the token-refresh
/// retry (`withCliAuthRetry`) never fires → the 401 surfaces and the agent dies.
/// Prefer the auth text (from body, else stderr) so the retry engages; otherwise
/// fall back to the generic exit message. This is the cross-model counterpart to the
/// exit-0 envelope detection done by `looks_like_cli_auth_error` callers.
fn cli_exit_err(cli: &str, code: i32, body: &str, stderr: &str) -> String {
    let body = body.trim();
    if looks_like_cli_auth_error(body) {
        return body.to_string();
    }
    let stderr = stderr.trim();
    if looks_like_cli_auth_error(stderr) {
        return stderr.to_string();
    }
    format!(
        "{cli} CLI exited {code} — {}",
        if stderr.is_empty() { "no stderr".to_string() } else { stderr.to_string() }
    )
}

/// One-shot completion via the OpenAI Codex CLI — the OpenAI-subscription
/// analogue of `claude_cli_complete`. Without this the chat fell back to
/// demanding OPENAI_API_KEY even when a ChatGPT/Codex subscription was
/// connected (streamOpenAI had no CLI path, only the API one).
///
/// `codex exec` is the non-interactive entry point. It has no `--system`
/// flag, so the system prompt is folded into the prompt as a leading
/// block. The prompt is passed BOTH as the positional arg AND on stdin so
/// every codex version gets it (older builds read the arg, newer ones read
/// stdin — same cross-version split that broke the Test probe). The final
/// assistant message is captured via `-o <file>` (clean text, no JSONL /
/// agent-activity noise) and read back. Sandbox is forced read-only so a
/// chat turn can never mutate the user's disk.
#[tauri::command]
pub async fn codex_cli_complete(
    system_prompt: String,
    user_message: String,
    cwd: Option<String>,
    image_paths: Option<Vec<String>>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let prompt = if system_prompt.trim().is_empty() {
            user_message.clone()
        } else {
            format!("{}\n\n{}", system_prompt.trim(), user_message)
        };
        // Windows caps a command line at ~32 KB. codex passes the prompt BOTH as a
        // positional arg AND on stdin (cross-version); a large agentic prompt as
        // the positional arg overflows ("filename or extension is too long, os
        // 206") — the same crash the claude path hit. Newer codex reads the prompt
        // from stdin (always piped below), so for a large prompt we DROP the
        // positional arg and rely on stdin. Small prompts keep both (older codex).
        const MAX_PROMPT_ARG: usize = 4000;
        let pass_prompt_positionally = prompt.len() <= MAX_PROMPT_ARG;
        // Base args shared by both paths (no -o — see per-branch handling).
        let mut base_args: Vec<String> = vec![
            "exec".into(),
            "--skip-git-repo-check".into(),
            "--color".into(),
            "never".into(),
            // Read-only sandbox: a chat reply never needs to write to disk.
            "--sandbox".into(),
            "read-only".into(),
        ];
        // Attach pasted images via codex's native `-i` flag (verified: codex
        // reads them as vision input). One flag per file so the variadic `-i`
        // doesn't swallow the positional prompt. Paths are relative to cwd.
        for p in image_paths.iter().flatten() {
            base_args.push("-i".into());
            base_args.push(p.clone());
        }

        // Isolated project → run `codex` inside the sandbox and read the final
        // message from stdout (a Windows -o tempfile path is meaningless inside
        // the sandbox, so we omit -o on this path).
        if let Some((exe, sargs)) = {
            let mut args = base_args.clone();
            if pass_prompt_positionally { args.push(prompt.clone()); }
            crate::sandbox::program_argv(cwd.as_deref(), "codex", &args)
        } {
            let mut cmd = Command::new(exe);
            cmd.args(sargs);
            cmd.stdin(Stdio::piped());
            cmd.stdout(Stdio::piped());
            cmd.stderr(Stdio::piped());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            let mut child = cmd.spawn().map_err(|e| format!("spawn codex: {e}"))?;
            let pid = register_cli_child(&child);
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(prompt.as_bytes());
            }
            let output = wait_cli_child(child, pid).map_err(|e| format!("wait codex: {e}"))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
                let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
                return Err(cli_exit_err("codex", output.status.code().unwrap_or(-1), &stdout, &stderr));
            }
            let reply = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if reply.is_empty() {
                return Err("codex CLI returned an empty reply".to_string());
            }
            return Ok(reply);
        }

        // Windows path (unchanged): -o <tempfile> captures the clean final msg.
        let exe = find_codex_cli()
            .ok_or_else(|| "codex CLI not found on PATH — install OpenAI Codex first (Accounts → Install CLI)".to_string())?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let out_file = std::env::temp_dir().join(format!("owllm-codex-{}-{}.txt", std::process::id(), stamp));
        #[cfg(windows)]
        let batch = is_batch_shim(&exe);
        #[cfg(not(windows))]
        let batch = false;
        let mut cmd = Command::new(&exe);
        for a in &base_args {
            push_arg(&mut cmd, batch, a);
        }
        push_arg(&mut cmd, batch, "-o");
        push_arg(&mut cmd, batch, &out_file.to_string_lossy());
        // Positional prompt (older codex reads it here); stdin carries it too.
        // Skipped for a large prompt to stay under the ~32 KB command-line cap —
        // stdin below still delivers it (see MAX_PROMPT_ARG note above).
        if pass_prompt_positionally {
            push_arg(&mut cmd, batch, &prompt);
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
        let mut child = cmd.spawn().map_err(|e| format!("spawn codex: {e}"))?;
        let pid = register_cli_child(&child);
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(prompt.as_bytes());
        }
        let output = wait_cli_child(child, pid)
            .map_err(|e| format!("wait codex: {e}"))?;
        let from_file = std::fs::read_to_string(&out_file).ok();
        let _ = std::fs::remove_file(&out_file);
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            let body = from_file
                .clone()
                .unwrap_or_else(|| String::from_utf8_lossy(&output.stdout).into_owned());
            return Err(cli_exit_err("codex", output.status.code().unwrap_or(-1), &body, &stderr));
        }
        let reply = from_file
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| String::from_utf8_lossy(&output.stdout).trim().to_string());
        if reply.is_empty() {
            return Err("codex CLI returned an empty reply".to_string());
        }
        Ok(reply)
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
    /// `is_error` is the tool's REAL success flag from the CLI — the only
    /// reliable signal. (The UI must NOT guess from the result text: a grep
    /// that searches for "error"/"denied" returns matching lines containing
    /// those words and was being mislabeled "Failed".)
    ToolResult { tool_use_id: String, content: String, is_error: bool },
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
    // The KEYS here must match the real tool names emitted by localTools.ts
    // (executeToolCall cases) — not aliases. A mismatch silently drops the tool
    // from the CLI agent's --allowedTools, so the capability vanishes with no
    // error (this bit `glob` and `web_fetch`, which the coder/orchestrator/
    // brainstormer roles rely on). Claude's native tool names are the values.
    match name {
        "read_file" => Some("Read"),
        "edit_file" => Some("Edit"),
        "write_file_with_diff" | "write_file" => Some("Write"),
        "list_dir" | "glob_files" | "glob" => Some("Glob"),
        "grep" => Some("Grep"),
        "shell" | "shell_exec" => Some("Bash"),
        "create_dir" => Some("Bash"), // no dedicated CLI mkdir tool — Bash covers it
        "todo_write" => Some("TodoWrite"),
        "http_get" | "web_fetch" => Some("WebFetch"),
        "web_search" | "search_web" => Some("WebSearch"),
        // OWLLM-only tools with NO Claude-CLI counterpart — silently dropped so
        // the role still works on the CLI path. NOTE: load_skill/list_skills are
        // covered by disk self-load (.owllm/skills), publish_release by the
        // [PUBLISH] host-harvest, and memory by snapshot-inject + [REMEMBER].
        // STILL UNBRIDGED for CLI: screenshot_url, memory_search/read (on-demand),
        // ssh_* — these genuinely don't work for a CLI agent yet.
        "dispatch" | "verify" | "ssh" | "ssh_exec" | "ssh_upload" | "ssh_download"
        | "screenshot_url" | "memory_read" | "memory_search" | "memory_write"
        | "load_skill" | "list_skills" | "publish_release" => None,
        _ => None,
    }
}

/// True when a role's tool allowlist marks it as the BROWSER role — the only
/// role whose YAML names browser_* tools (resources/agents/roles/browser.yaml).
/// Same capability-keyed pattern as the Publisher (`publish_release` in the
/// allowlist). Accepts both bare (`browser_open`) and MCP-prefixed
/// (`mcp__owllm__browser_open`) spellings so a future allowlist rewrite can't
/// silently un-grant the exception.
pub(crate) fn is_browser_role_allowlist(allowed: Option<&Vec<String>>) -> bool {
    allowed
        .map(|v| {
            v.iter().any(|t| {
                let t = t.trim();
                let bare = t.strip_prefix("mcp__owllm__").unwrap_or(t);
                bare.starts_with("browser_")
            })
        })
        .unwrap_or(false)
}

fn codex_should_grant_browser(host_run: bool, jailed: bool, browser_role: bool) -> bool {
    // Browser tools are cross-cutting: every agent running where the transport
    // can reach the in-app gateway gets to drive the shared browser window,
    // not just the Browser role. Host runs and non-jailed WSL/Lima/bwrap
    // environments can reach the gateway; the Browser role keeps an extra
    // exception for bwrap-jailed WSL projects, where it is spawned unjailed
    // so interop survives.
    host_run || !jailed || browser_role
}

#[tauri::command]
pub async fn claude_cli_stream(
    // Injected by Tauri (not passed from JS) — needed to host the in-app MCP
    // gateway that lends OWLLM tools (browser_*) to the CLI on host runs.
    app: tauri::AppHandle,
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
    // Per-run, user-consented widening of the CLI filesystem scope to the
    // user's home profile (--add-dir). Default None/false = NO widening. Set
    // true ONLY after the user approves the consent prompt. See
    // sandbox::extra_allowed_dirs.
    grant_home: Option<bool>,
    on_event: Channel<ClaudeStreamEvent>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        // Collect the CLI args once so we can run the SAME invocation either as
        // the Windows CLI (default) or — for a WSL-isolated project — inside the
        // distro (so the agent's tools can't touch the Windows drive).
        let mut args: Vec<String> = Vec::new();
        args.push("--print".into());

        // MCP GATEWAY: expose OWLLM's browser_* tools to this CLI agent natively
        // (as mcp__owllm__browser_*). The browser is a CROSS-CUTTING capability
        // (one window shared with the user, mirroring BROWSER_TOOL_NAMES in
        // localTools.ts): never gated by the role tool_allowlist — no role YAML
        // names browser_*, so gating here meant specialist CLI agents could never
        // see the page the user opened.
        //   * HOST run → HTTP transport on 127.0.0.1 (directly reachable).
        //   * NON-JAILED WSL run (full-access OR bwrap not installed) → MCP *stdio*
        //     relay: interop (curl.exe) runs on the host, reaches its own loopback,
        //     no firewall rule needed.
        //   * bwrap-JAILED WSL run → no browser: interop unavailable in the jail;
        //     deliberately excluded (jailed agent must not control the host browser).
        // Best-effort: any gateway failure logs and falls back gracefully.
        //
        // BROWSER-ROLE JAIL EXCEPTION: the Browser role is the ONE role allowed
        // to drive the host browser from an isolated project. Detected the same
        // way the Publisher is (capability keyed on the role's tool_allowlist —
        // browser.yaml is the only role naming browser_*), so no new dispatch
        // parameter is needed and both UI dispatch copies are covered. When it
        // would be bwrap-jailed, this role instead runs via PLAIN WSL routing
        // (program_argv_unjailed) so interop stays alive for the stdio relay.
        let browser_role = is_browser_role_allowlist(allowed_tools.as_ref());
        let host_run = !crate::sandbox::is_isolated(cwd.as_deref());
        // Track the wiring outcome so it can be SURFACED INTO THE RUN LOG below.
        // Every prior failure in this chain was an eprintln nobody sees — the
        // agent then truthfully reports "no browser tools" and the user gets a
        // 10-turn goose chase instead of the one-line reason.
        let mut gateway_err: Option<String> = None;
        let mcp_config_path: Option<String> = if host_run {
            match crate::mcp_gateway::write_cli_config(&app) {
                Ok(p) => Some(p.to_string_lossy().to_string()),
                Err(e) => {
                    gateway_err = Some(e);
                    None
                }
            }
        } else {
            #[cfg(windows)]
            {
                // Wire relay for any non-jailed WSL run (full-access *or* no
                // bwrap) — and for the Browser role, which is spawned unjailed
                // below precisely so this relay can work.
                if !crate::sandbox::is_bwrap_jailed(cwd.as_deref()) || browser_role {
                    match crate::mcp_gateway::write_cli_config_wsl(&app, cwd.as_deref()) {
                        Ok(p) => Some(p),
                        Err(e) => {
                            gateway_err = Some(e);
                            None
                        }
                    }
                } else {
                    None
                }
            }
            #[cfg(not(windows))]
            {
                None
            }
        };
        if let Some(e) = gateway_err.as_ref() {
            eprintln!("mcp gateway not wired ({e}); CLI agent runs without browser tools");
            // Non-fatal by design: the run continues, just without browser tools —
            // but now the run log SAYS SO, with the exact reason.
            let _ = on_event.send(ClaudeStreamEvent::Error {
                message: format!(
                    "browser gateway not wired — {e}. Browser tools (mcp__owllm__browser_*) are unavailable for this run."
                ),
            });
        } else if mcp_config_path.is_some() && !host_run {
            // The WSL relay is the fragile transport (interop + stdio bridge) —
            // record that it was wired so a later "0 tools" report can be
            // separated into app-side vs CLI-side at a glance.
            let _ = on_event.send(ClaudeStreamEvent::Thinking {
                delta: "[owllm] browser gateway: wired via WSL interop relay\n".to_string(),
            });
        }
        let mcp_tool_names: Vec<String> = if mcp_config_path.is_some() {
            crate::mcp_gateway::cli_tool_names()
        } else {
            Vec::new()
        };
        if let Some(m) = model.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            args.push("--model".into());
            args.push(m.to_string());
        }
        if let Some(e) = effort.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            args.push("--effort".into());
            args.push(e.to_string());
        }
        if let Some(sid) = session_id.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            args.push("--session-id".into());
            args.push(sid.to_string());
        }
        if brief_mode.unwrap_or(false) {
            args.push("--brief".into());
        }
        args.push("--output-format".into());
        args.push("stream-json".into());
        args.push("--verbose".into());
        if auto_approve.unwrap_or(false) {
            args.push("--permission-mode".into());
            args.push("bypassPermissions".into());
        }
        if let Some(allowed) = allowed_tools.as_ref() {
            let wants_all = allowed.iter().any(|t| t == "all");
            if !wants_all && !allowed.is_empty() {
                let mut cli_tools: Vec<String> = allowed
                    .iter()
                    .filter_map(|t| map_owllm_tool_to_cli(t).map(|s| s.to_string()))
                    .collect();
                // Permit the gateway's MCP tools too (availability via --mcp-config
                // is a separate axis from this permission allowlist).
                cli_tools.extend(mcp_tool_names.iter().cloned());
                if !cli_tools.is_empty() {
                    args.push("--allowedTools".into());
                    args.push(cli_tools.join(" "));
                }
            }
        }
        // Point the CLI at the in-app MCP gateway (host runs with browser access).
        if let Some(cfg) = mcp_config_path.as_ref() {
            args.push("--mcp-config".into());
            args.push(cfg.clone());
        }
        // Widen the CLI's filesystem SCOPE to the user's home profile so an agent
        // can open a file the user points it at OUTSIDE the project (e.g.
        // ~/Downloads/BRIEF.md). Without this, Claude Code's own allowed-working-
        // dirs guard blocks the Read/`cat` even when every TOOL permission is
        // granted — the allowlist and the filesystem jail are separate axes. This
        // is empty (a no-op) for a bwrap-jailed run, preserving confinement there.
        for dir in crate::sandbox::extra_allowed_dirs(cwd.as_deref()) {
            args.push("--add-dir".into());
            args.push(dir);
        }
        // See claude_cli_complete: a large agentic system prompt passed via
        // `--append-system-prompt <arg>` overflows the Windows ~32 KB command line
        // ("os error 206" → the orchestrator "crash after a few seconds"). Fold a
        // large prompt into stdin (unbounded pipe) instead; keep the proven flag
        // for small prompts.
        // Deliver the agent's system prompt as a PROPER system prompt
        // (--append-system-prompt) whenever it fits — that is what keeps the model
        // behaving as its role. FOLDING it into stdin strips the role out of the
        // system position and makes a smart model (Opus 4.8) behave dumbly, so only
        // fold when the prompt would actually overflow the command line. The host
        // path takes a ~32 KB command line; the WSL path wraps args in a bash -lc
        // script (escaping expands length), so fold earlier there.
        let on_wsl = cwd.as_deref().and_then(crate::wsl::parse_wsl_unc).is_some();
        // On Windows the resolved `claude` is usually an npm `.cmd` shim, which Rust
        // must launch THROUGH cmd.exe — a ~8 KB command-line limit, NOT the ~32 KB of
        // a direct CreateProcess. A 24 KB --append-system-prompt then dies with "The
        // command line is too long." (exit 1, empty reply — the Code page "done" with
        // no output). When the host CLI is a batch shim, budget the system-prompt arg
        // against what the other flags already consumed and fold the rest into stdin.
        let host_batch_shim = !on_wsl
            && !crate::sandbox::is_isolated(cwd.as_deref())
            && find_claude_cli().map(|p| is_batch_shim(&p)).unwrap_or(false);
        let max_system_arg: usize = if host_batch_shim {
            let already: usize = args.iter().map(|a| a.len() + 3).sum::<usize>() + 96;
            7_000usize.saturating_sub(already)
        } else if on_wsl {
            10_000
        } else {
            24_000
        };
        let fold_system_into_stdin =
            !system_prompt.trim().is_empty() && system_prompt.len() > max_system_arg;
        if !system_prompt.trim().is_empty() && !fold_system_into_stdin {
            args.push("--append-system-prompt".into());
            args.push(system_prompt.clone());
        }
        let stdin_payload = if fold_system_into_stdin {
            format!("{system_prompt}\n\n----- YOUR TASK -----\n\n{user_message}")
        } else {
            user_message.clone()
        };

        // Build + stream wrapped in a closure so a "Session ID … is already in
        // use" startup failure retries once WITHOUT --session-id (see
        // claude_cli_complete — the id collides with an existing/stale session
        // on disk, not a live process). The conflict aborts the CLI before any
        // event is streamed, so the retry can't double-emit.
        let run_once = |args: &[String]| -> Result<String, String> {
        // WSL-isolated project → run `claude` inside the distro; else the
        // Windows CLI exactly as before (no regression for normal folders).
        // The Browser role skips the bwrap jail (plain WSL) so the MCP relay's
        // interop path works — every other role keeps today's routing.
        let spawn_argv = if browser_role {
            crate::sandbox::program_argv_unjailed(cwd.as_deref(), "claude", args)
        } else {
            crate::sandbox::program_argv(cwd.as_deref(), "claude", args)
        };
        let mut cmd = if let Some((exe, sargs)) = spawn_argv
        {
            let mut c = Command::new(exe);
            c.args(sargs);
            c
        } else {
            let exe = find_claude_cli()
                .ok_or_else(|| "claude CLI not found on PATH — install Claude Code first".to_string())?;
            #[cfg(windows)]
            let batch = is_batch_shim(&exe);
            #[cfg(not(windows))]
            let batch = false;
            let mut c = Command::new(&exe);
            for a in args {
                push_arg(&mut c, batch, a);
            }
            if let Some(dir) = cwd.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
                let p = std::path::Path::new(dir);
                if p.is_dir() {
                    c.current_dir(p);
                }
            }
            c
        };
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| format!("spawn claude: {e}"))?;
        let child_pid = register_cli_child(&child);
        if let Some(mut stdin) = child.stdin.take() {
            // Best-effort: the CLI can read what it needs and exit while we're still
            // writing the (large agentic) payload → "pipe has been ended (os error
            // 109)". Propagating that (the old `?`) aborted the whole stream and
            // discarded the reply — the "done" with no output on the Code page. Swallow
            // it; the drop() below signals EOF and we still read stdout for the reply.
            let _ = stdin.write_all(stdin_payload.as_bytes());
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
        // Set when the CLI reports a failure via a `result` event with
        // `is_error:true` while still exiting 0 (auth 401, exec error). Without
        // this the error text is handed back as the reply and the frontend's
        // auth-retry never fires. Drained into an Err after the loop.
        let mut result_error: Option<String> = None;
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
                                let is_error = block
                                    .get("is_error")
                                    .and_then(|b| b.as_bool())
                                    .unwrap_or(false);
                                let _ = on_event.send(ClaudeStreamEvent::ToolResult {
                                    tool_use_id: id,
                                    content: content_str,
                                    is_error,
                                });
                            }
                        }
                    }
                }
                "result" => {
                    // Final summary event — carries the full assistant text in
                    // the `result` field AND an `is_error` flag. The CLI sets
                    // is_error:true (e.g. an expired-token 401, or an exec error)
                    // while STILL exiting 0, so we must inspect this flag — not
                    // just the process exit code — to know the run actually
                    // failed. When it did, capture the message and return Err
                    // after the loop so the caller's auth-retry path runs instead
                    // of treating "Failed to authenticate…" as the agent's reply.
                    let is_err = v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false);
                    let subtype = v.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
                    let result_text = v.get("result").and_then(|r| r.as_str()).unwrap_or("");
                    let is_auth = looks_like_cli_auth_error(result_text);
                    if is_err && (assembled.trim().is_empty() || is_auth) {
                        // Clean failure (no usable content) OR an auth failure at
                        // any point → surface it. We keep partial content for
                        // non-auth errors that DID produce output (e.g. a
                        // max-turns cutoff), so a useful partial answer isn't
                        // discarded.
                        let msg = if !result_text.is_empty() {
                            result_text.to_string()
                        } else if !subtype.is_empty() {
                            format!("claude CLI error: {subtype}")
                        } else {
                            "claude CLI reported an error".to_string()
                        };
                        let _ = on_event.send(ClaudeStreamEvent::Error { message: msg.clone() });
                        result_error = Some(msg);
                    } else if assembled.is_empty() && !result_text.is_empty() {
                        // No assistant event ever fired (ultra-fast result) —
                        // surface the final text as the reply.
                        assembled.push_str(result_text);
                        let _ = on_event.send(ClaudeStreamEvent::Text {
                            delta: result_text.to_string(),
                        });
                    }
                }
                _ => {}
            }
        }
        let wait_res = child.wait();
        unregister_cli_child(child_pid);
        let status = wait_res.map_err(|e| format!("wait claude: {e}"))?;
        if !status.success() {
            // Drain stderr after exit to surface the failure reason.
            let mut stderr_buf = String::new();
            if let Some(mut stderr) = child.stderr.take() {
                let _ = stderr.read_to_string(&mut stderr_buf);
            }
            // CRITICAL (the recurring "claude CLI exited 1 — no stderr" / 401): the
            // CLI prints an expired-token 401 into its STREAMED output (a result
            // event with is_error, or plain assistant text in `assembled`) and exits
            // NON-ZERO with EMPTY stderr. The is_error text is the most precise, then
            // the assembled body; surface whichever is the auth envelope so the
            // frontend's isCliAuthError matches and withCliAuthRetry refreshes the
            // token — instead of the generic exit string the retry can't recognize.
            if let Some(err) = result_error.as_ref() {
                if looks_like_cli_auth_error(err) {
                    return Err(err.clone());
                }
            }
            return Err(cli_exit_err(
                "claude",
                status.code().unwrap_or(-1),
                assembled.trim(),
                &stderr_buf,
            ));
        }
        // Exit 0 but the CLI flagged the run as failed via a `result` event
        // (is_error:true) — most importantly an expired-token 401. Return Err so
        // withCliAuthRetry refreshes the token and retries instead of handing the
        // error text back as the agent's answer.
        if let Some(err) = result_error {
            return Err(err);
        }
        let out = assembled.trim().to_string();
        // Belt-and-suspenders: some CLI versions surface the 401 as plain
        // assistant text (no is_error result event) while still exiting 0. Only
        // treat a SHORT reply that IS the auth envelope as an error — a long
        // substantive answer that merely mentions a 401 must not be discarded.
        if out.len() < 600 && (looks_like_cli_auth_error(&out) || looks_like_transient_server_error(&out)) {
            return Err(out);
        }
        Ok(out)
        };
        let session_was_set = session_id.as_ref().map(|s| !s.trim().is_empty()).unwrap_or(false);
        match run_once(&args) {
            Err(e) if session_was_set && is_session_in_use(&e) => run_once(&strip_session_arg(&args)),
            other => other,
        }
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

// ---------------------------------------------------------------------
// Streaming Codex CLI dispatch — runs `codex exec --json` so the UI
// shows live activity (reasoning summaries, command runs, MCP tool
// calls, web searches) as the agent works, instead of freezing on a
// blank reply until the one-shot `codex_cli_complete` returns the whole
// blob at the end. Codex does NOT stream the assistant text token by
// token (the `agent_message` arrives whole on `item.completed`), but it
// DOES stream every other item event — which is exactly the missing
// "no thinking, no tools, nothing until the end" feedback.
// ---------------------------------------------------------------------

/// One streaming event from the Codex CLI. Deliberately the SAME wire
/// shape as ClaudeStreamEvent (tag "kind", camelCase) so the frontend
/// reuses one handler: text → reply pane, thinking → Thought tab,
/// toolUse/toolResult → tool blocks (paired by tool_use_id).
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CodexStreamEvent {
    Text { delta: String },
    Thinking { delta: String },
    ToolUse { tool_use_id: String, name: String, input: String },
    ToolResult { tool_use_id: String, content: String },
    Error { message: String },
}

/// Flatten an MCP tool `result` value (string, or an array of content
/// blocks like `{type:"text",text:"…"}`) into a single display string.
fn codex_result_text(r: &serde_json::Value) -> String {
    if let Some(s) = r.as_str() {
        return s.to_string();
    }
    if let Some(arr) = r.as_array() {
        let joined = arr
            .iter()
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()).map(|s| s.to_string()))
            .collect::<Vec<_>>()
            .join("\n");
        if !joined.is_empty() {
            return joined;
        }
    }
    serde_json::to_string(r).unwrap_or_default()
}

#[tauri::command]
pub async fn codex_cli_stream(
    // Injected by Tauri (not passed from JS) — needed to host the in-app MCP
    // gateway that lends OWLLM's browser_* tools to the Codex CLI, mirroring
    // claude_cli_stream. Without this, an OpenAI/Codex team agent had NO browser
    // tools on any run (the whole "team can't see the browser" bug for OpenAI users).
    app: tauri::AppHandle,
    system_prompt: String,
    user_message: String,
    cwd: Option<String>,
    image_paths: Option<Vec<String>>,
    // Per-role tool gate. Codex has no `--allowedTools` flag, so this is used
    // to detect the Browser role (its allowlist names browser_*, the same
    // capability-key the Publisher uses). Browser is the host-capable role
    // that owns the shared browser; ordinary coders should dispatch browser
    // work to @browser instead of receiving host-browser privileges.
    allowed_tools: Option<Vec<String>>,
    on_event: Channel<CodexStreamEvent>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let prompt = if system_prompt.trim().is_empty() {
            user_message.clone()
        } else {
            format!("{}\n\n{}", system_prompt.trim(), user_message)
        };

        // ---- MCP GATEWAY (browser_* tools) — the Codex counterpart of the
        // claude_cli_stream block. Browser tools are a CROSS-CUTTING capability:
        // any agent running where the transport can reach the in-app gateway
        // gets to drive the shared browser window, not just the Browser role.
        // VERIFIED against codex 0.128.0:
        //   * HOST run  → `-c mcp_servers.owllm.url=…` + `bearer_token_env_var`
        //                 (token in OWLLM_GW_TOKEN env).
        //   * WSL run   → `-c mcp_servers.owllm.command="bash"` + args = the same
        //                 stdio interop relay the Claude WSL path uses.
        // CRUCIAL codex quirk (verified): `codex exec` SILENTLY CANCELS every MCP
        // tool call under `--sandbox workspace-write` — they execute only with
        // `approval_policy=never` AND `--sandbox danger-full-access`.
        // Because the browser is cross-cutting, wiring the gateway on a host or
        // unjailed run means that agent needs `danger-full-access` to actually
        // execute MCP calls. This matches the local/API path, which already has
        // full host access. The Browser role keeps a special WSL jail exception
        // so interop survives in bwrap-isolated projects.
        let browser_role = is_browser_role_allowlist(allowed_tools.as_ref());
        let host_run = !crate::sandbox::is_isolated(cwd.as_deref());
        let jailed = crate::sandbox::is_bwrap_jailed(cwd.as_deref());
        let grant_browser = codex_should_grant_browser(host_run, jailed, browser_role);
        let mut gateway_err: Option<String> = None;
        let mut gw_cfg: Vec<String> = Vec::new();
        let mut token_env: Option<String> = None;
        if grant_browser {
            if host_run {
                match crate::mcp_gateway::codex_http_config(&app) {
                    Ok((cfg, token)) => {
                        gw_cfg = cfg;
                        token_env = Some(token);
                    }
                    Err(e) => gateway_err = Some(e),
                }
            } else {
                #[cfg(windows)]
                {
                    // WSL isolated run: the relay works for any non-jailed
                    // environment (full-access or no bwrap) and for the Browser
                    // role, which is spawned unjailed below as a jail exception.
                    if !jailed || browser_role {
                        match crate::mcp_gateway::codex_wsl_config(&app, cwd.as_deref()) {
                            Ok(cfg) => gw_cfg = cfg,
                            Err(e) => gateway_err = Some(e),
                        }
                    }
                }
            }
        }
        let gateway_wired = !gw_cfg.is_empty();
        if let Some(e) = gateway_err.as_ref() {
            eprintln!("codex mcp gateway not wired ({e}); agent runs without browser tools");
            let _ = on_event.send(CodexStreamEvent::Error {
                message: format!(
                    "browser gateway not wired — {e}. Browser tools (mcp__owllm__browser_*) are unavailable for this run."
                ),
            });
        } else if gateway_wired && !host_run {
            let _ = on_event.send(CodexStreamEvent::Thinking {
                delta: "[owllm] browser gateway: wired via WSL interop relay\n".to_string(),
            });
        }
        // Escalate the sandbox only when we actually wired the gateway (see the
        // codex-quirk note above). `never` stops the non-interactive auto-cancel
        // of MCP tool calls; `danger-full-access` is what lets them execute.
        let sandbox_mode = if gateway_wired {
            "danger-full-access"
        } else {
            "workspace-write"
        };

        // Same non-interactive flags as codex_cli_complete, plus --json for the
        // NDJSON event stream. Collected once so the same invocation runs as the
        // Windows CLI or inside WSL for an isolated project.
        let mut args: Vec<String> = vec![
            "exec".into(),
            "--json".into(),
            "--skip-git-repo-check".into(),
            "--color".into(),
            "never".into(),
            // WRITABLE workspace — this is the coding/agentic stream (the Code
            // page + agentic teams), not the read-only chat (codex_cli_complete).
            // `read-only` here made the Coder unable to create dirs / write files
            // ("mkdir: Read-only file system"); it could only rationalise the
            // failure. workspace-write confines writes to the project cwd, and
            // for isolated projects the WSL/Lima/bwrap sandbox is the outer
            // boundary, so nothing escapes the workspace either way. In `codex
            // exec` the approval policy already defaults to never, so writes in
            // the workspace proceed without a prompt. (Escalated to
            // danger-full-access above only when the browser gateway is wired.)
            "--sandbox".into(),
            sandbox_mode.into(),
        ];
        // Point Codex at the in-app MCP gateway (browser_* tools) + let its calls
        // actually execute (approval_policy=never — see the codex-quirk note).
        if gateway_wired {
            args.extend(gw_cfg.iter().cloned());
            args.push("-c".into());
            args.push("approval_policy=\"never\"".into());
        }
        // Pasted images via codex's native `-i` flag (one per file so the
        // positional prompt isn't swallowed). Relative paths (cwd-rooted).
        for p in image_paths.iter().flatten() {
            args.push("-i".into());
            args.push(p.clone());
        }
        // Positional prompt (older codex reads it here); stdin carries it
        // too (newer codex reads it there). A large agentic prompt as the
        // positional arg overflows the Windows ~32 KB command line ("os error
        // 206") — same crash the claude path hit — so for a large prompt we drop
        // the positional and rely on stdin (written below).
        const MAX_PROMPT_ARG: usize = 4000;
        if prompt.len() <= MAX_PROMPT_ARG {
            args.push(prompt.clone());
        }

        // WSL-isolated project → run `codex` inside the distro; else Windows CLI.
        // BROWSER-ROLE JAIL EXCEPTION: the Browser role runs UNJAILED (plain WSL)
        // even in a bwrap-isolated team, so interop stays alive for the stdio
        // relay — mirrors the claude_cli_stream exception. Every other role keeps
        // its normal (possibly jailed) routing.
        let resolved = if browser_role && crate::sandbox::is_bwrap_jailed(cwd.as_deref()) {
            crate::sandbox::program_argv_unjailed(cwd.as_deref(), "codex", &args)
        } else {
            crate::sandbox::program_argv(cwd.as_deref(), "codex", &args)
        };
        let mut cmd = if let Some((exe, sargs)) = resolved {
            let mut c = Command::new(exe);
            c.args(sargs);
            c
        } else {
            let exe = find_codex_cli().ok_or_else(|| {
                "codex CLI not found on PATH — install OpenAI Codex first (Accounts → Install CLI)"
                    .to_string()
            })?;
            #[cfg(windows)]
            let batch = is_batch_shim(&exe);
            #[cfg(not(windows))]
            let batch = false;
            let mut c = Command::new(&exe);
            for a in &args {
                push_arg(&mut c, batch, a);
            }
            if let Some(dir) = cwd.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
                let p = std::path::Path::new(dir);
                if p.is_dir() {
                    c.current_dir(p);
                }
            }
            c
        };
        // Host run: hand codex the gateway bearer token via env (its MCP config
        // references it by name, so the secret never lands on the argv). No-op for
        // WSL runs — there the token travels inside the relay args instead.
        if let Some(tok) = token_env.as_ref() {
            cmd.env(crate::mcp_gateway::CODEX_TOKEN_ENV, tok);
        }
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| format!("spawn codex: {e}"))?;
        let child_pid = register_cli_child(&child);
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(prompt.as_bytes());
            // Drop closes the pipe (EOF) so the stdin-style codex proceeds.
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
                    let _ = on_event.send(CodexStreamEvent::Error {
                        message: format!("read stdout: {e}"),
                    });
                    continue;
                }
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let v: serde_json::Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let etype = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match etype {
                "item.started" | "item.updated" | "item.completed" => {
                    let completed = etype == "item.completed";
                    let item = match v.get("item") {
                        Some(i) => i,
                        None => continue,
                    };
                    let itype = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    let id = item
                        .get("id")
                        .and_then(|i| i.as_str())
                        .unwrap_or("")
                        .to_string();
                    match itype {
                        // Final assistant message — only on completion, whole text.
                        "agent_message" => {
                            if completed {
                                if let Some(t) = item.get("text").and_then(|t| t.as_str()) {
                                    if !t.is_empty() {
                                        assembled.push_str(t);
                                        let _ = on_event
                                            .send(CodexStreamEvent::Text { delta: t.to_string() });
                                    }
                                }
                            }
                        }
                        // Reasoning summary — Thought tab.
                        "reasoning" => {
                            if completed {
                                if let Some(t) = item.get("text").and_then(|t| t.as_str()) {
                                    if !t.is_empty() {
                                        let _ = on_event
                                            .send(CodexStreamEvent::Thinking { delta: t.to_string() });
                                    }
                                }
                            }
                        }
                        // Shell command: start → ToolUse, completion → ToolResult.
                        "command_execution" => {
                            if !completed {
                                let command = item
                                    .get("command")
                                    .and_then(|c| c.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let _ = on_event.send(CodexStreamEvent::ToolUse {
                                    tool_use_id: id,
                                    name: "shell".to_string(),
                                    input: command,
                                });
                            } else {
                                let out = item
                                    .get("aggregated_output")
                                    .and_then(|c| c.as_str())
                                    .unwrap_or("");
                                let content = match item.get("exit_code").and_then(|c| c.as_i64()) {
                                    Some(code) => format!("{out}\n(exit {code})"),
                                    None => out.to_string(),
                                };
                                let _ = on_event
                                    .send(CodexStreamEvent::ToolResult { tool_use_id: id, content });
                            }
                        }
                        // MCP tool call: start → ToolUse, completion → ToolResult.
                        "mcp_tool_call" => {
                            let server = item.get("server").and_then(|c| c.as_str()).unwrap_or("");
                            let tool = item.get("tool").and_then(|c| c.as_str()).unwrap_or("tool");
                            if !completed {
                                let args = item
                                    .get("arguments")
                                    .map(|a| {
                                        serde_json::to_string_pretty(a)
                                            .unwrap_or_else(|_| a.to_string())
                                    })
                                    .unwrap_or_default();
                                let _ = on_event.send(CodexStreamEvent::ToolUse {
                                    tool_use_id: id,
                                    name: format!("{server}.{tool}"),
                                    input: args,
                                });
                            } else {
                                let content = if let Some(err) =
                                    item.get("error").and_then(|e| e.as_str())
                                {
                                    format!("error: {err}")
                                } else {
                                    item.get("result").map(codex_result_text).unwrap_or_default()
                                };
                                let _ = on_event
                                    .send(CodexStreamEvent::ToolResult { tool_use_id: id, content });
                            }
                        }
                        // Web search — surface the query as a tool invocation.
                        "web_search" => {
                            if completed {
                                let q = item
                                    .get("query")
                                    .and_then(|c| c.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let _ = on_event.send(CodexStreamEvent::ToolUse {
                                    tool_use_id: id,
                                    name: "web_search".to_string(),
                                    input: q,
                                });
                            }
                        }
                        // Non-fatal item warning.
                        "error" => {
                            if let Some(m) = item.get("message").and_then(|c| c.as_str()) {
                                let _ = on_event
                                    .send(CodexStreamEvent::Error { message: m.to_string() });
                            }
                        }
                        _ => {}
                    }
                }
                // Stream-level / turn-level failures.
                "error" => {
                    if let Some(m) = v.get("message").and_then(|t| t.as_str()) {
                        let _ = on_event.send(CodexStreamEvent::Error { message: m.to_string() });
                    }
                }
                "turn.failed" => {
                    if let Some(m) = v
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(|t| t.as_str())
                    {
                        let _ = on_event.send(CodexStreamEvent::Error { message: m.to_string() });
                    }
                }
                _ => {}
            }
        }
        let wait_res = child.wait();
        unregister_cli_child(child_pid);
        let status = wait_res.map_err(|e| format!("wait codex: {e}"))?;
        let asm = assembled.trim().to_string();
        if !status.success() && asm.is_empty() {
            // Only an error if we got NO usable reply — codex can exit
            // nonzero after the read-only sandbox denies a write it tried,
            // even though it produced a perfectly good message.
            let mut stderr_buf = String::new();
            if let Some(mut stderr) = child.stderr.take() {
                let _ = stderr.read_to_string(&mut stderr_buf);
            }
            return Err(cli_exit_err(
                "codex",
                status.code().unwrap_or(-1),
                "",
                &stderr_buf,
            ));
        }
        // Belt-and-suspenders (same 401-as-reply hazard as Claude): codex can print
        // "API Error: 401 …" / "Failed to authenticate" as its ONLY message and exit
        // 0. Treat a SHORT reply that IS the auth envelope as an error so the
        // token-refresh retry runs, instead of handing the 401 back as the answer.
        if asm.len() < 600 && (looks_like_cli_auth_error(&asm) || looks_like_transient_server_error(&asm)) {
            return Err(asm);
        }
        Ok(asm)
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

/// The user's OS home directory.
fn user_home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Possible Kimi CLI home directories. Modern `kimi-code` uses `~/.kimi-code`;
/// the older `MoonshotAI/kimi-cli` used `~/.kimi`. We keep both so the app
/// works regardless of which `kimi` binary is on PATH.
fn kimi_home_candidates() -> Vec<PathBuf> {
    let Some(home) = user_home_dir() else { return Vec::new() };
    vec![home.join(".kimi-code"), home.join(".kimi")]
}

/// The active Kimi home: prefer `~/.kimi-code` when it exists, otherwise
/// `~/.kimi`. This lets us detect which flavor the user actually has installed.
fn kimi_home_dir() -> Option<PathBuf> {
    kimi_home_candidates().into_iter().find(|p| p.is_dir())
}

/// Best guess at whether the installed `kimi` binary is the new `kimi-code`
/// (true) or the legacy `kimi-cli` (false). The safest signal is the home
/// directory the CLI has already created on disk.
fn kimi_is_new_flavor() -> bool {
    kimi_home_dir()
        .map(|p| p.file_name().map(|n| n == "kimi-code").unwrap_or(false))
        .unwrap_or(true)
}

/// Kimi Code CLI marks a login in `credentials/kimi-code.json` (modern) or
/// directly in `config.toml` (legacy). Accept either marker in either home.
fn kimi_cli_logged_in() -> bool {
    kimi_home_candidates().iter().any(|kimi| {
        kimi.join("credentials")
            .join("kimi-code.json")
            .is_file()
            || kimi.join("config.toml").exists()
    })
}

/// Raw text of the active Kimi config.toml (None when absent/unreadable).
fn kimi_config_text() -> Option<String> {
    for kimi in kimi_home_candidates() {
        let p = kimi.join("config.toml");
        if let Ok(text) = std::fs::read_to_string(&p) {
            return Some(text);
        }
    }
    None
}

/// Does the kimi config define a default model? When present the CLI runs fine
/// with NO --model flag — and rejects any model id that isn't declared in its
/// [models] table with a hard `LLMNotSet` error.
fn kimi_config_has_default(text: &str) -> bool {
    text.lines().any(|l| l.trim_start().starts_with("default_model"))
}

/// Model ids declared in the kimi config's `[models."<id>"]` tables.
fn kimi_config_model_keys(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|l| {
            let t = l.trim();
            t.strip_prefix("[models.\"")
                .and_then(|rest| rest.strip_suffix("\"]"))
                .map(|k| k.to_string())
        })
        .collect()
}

/// True when a modern login is present (`credentials/kimi-code.json`). The
/// current CLI writes this at login and resolves its own model from it — often
/// WITHOUT writing a `config.toml` default. So the config parse alone can't tell
/// we're safely logged in; without this check a modern-logged-in user reads as
/// `has_default=false` and an undeclared id gets force-passed.
fn kimi_has_modern_login() -> bool {
    kimi_home_candidates().iter().any(|kimi| {
        kimi.join("credentials")
            .join("kimi-code.json")
            .is_file()
    })
}

/// Recursively copy a directory, best-effort (individual file failures are
/// ignored so one unreadable credential doesn't abort the whole temp home).
fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let dest = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &dest)?;
        } else {
            let _ = std::fs::copy(&entry.path(), &dest);
        }
    }
    Ok(())
}

/// Build a temporary `KIMI_CODE_HOME` for a single `kimi-code` run.
/// Copies the user's real config + credentials, writes our system prompt as
/// `AGENTS.md`, and (when requested) wires the OwLLM browser gateway via
/// `mcp.json` + the `OWLLM_GW_TOKEN` env var. Project-level files are left
/// untouched.
fn prepare_kimi_code_home(
    app: &tauri::AppHandle,
    system_prompt: &str,
    with_mcp: bool,
) -> Result<std::path::PathBuf, String> {
    let real = kimi_home_dir()
        .or_else(|| user_home_dir().map(|h| h.join(".kimi-code")))
        .ok_or_else(|| "could not resolve home dir".to_string())?;
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let base = std::env::temp_dir().join(format!("owllm-kimi-code-home-{millis}"));
    std::fs::create_dir_all(&base).map_err(|e| format!("mkdir {}: {e}", base.display()))?;

    // Carry over the user's config and OAuth credentials so the temp home is
    // still authenticated and keeps any configured default model.
    let src_config = real.join("config.toml");
    if src_config.is_file() {
        let _ = std::fs::copy(&src_config, base.join("config.toml"));
    }
    let src_creds = real.join("credentials");
    if src_creds.is_dir() {
        let _ = copy_dir_all(&src_creds, &base.join("credentials"));
    }

    if !system_prompt.trim().is_empty() {
        // Do not set system_prompt_path here: Kimi treats that as replacing the
        // builtin coding-agent prompt, which makes Code page runs act like weak
        // generic chat. The default prompt exposes ROLE_ADDITIONAL specifically
        // for caller guidance, so inject OWLLM's prompt through that variable.
        let agent_yaml = base.join("agent.yaml");
        std::fs::write(&agent_yaml, kimi_agent_yaml(system_prompt))
        .map_err(|e| format!("write agent.yaml: {e}"))?;
    }

    if with_mcp {
        let info = crate::mcp_gateway::ensure_started(app)
            .map_err(|e| format!("browser gateway: {e}"))?;
        let mcp = json!({
            "mcpServers": {
                crate::mcp_gateway::SERVER_NAME: {
                    "url": info.url,
                    "bearerTokenEnvVar": "OWLLM_GW_TOKEN"
                }
            }
        });
        std::fs::write(
            base.join("mcp.json"),
            serde_json::to_vec_pretty(&mcp).unwrap_or_default(),
        )
        .map_err(|e| format!("write mcp.json: {e}"))?;

        // Pre-allow our own browser tools so auto-permission prompt mode doesn't
        // stall on every mcp__owllm__* call.
        let config = base.join("config.toml");
        let rules = "\n[[permission.rules]]\ndecision = \"allow\"\npattern = \"mcp__owllm__*\"\n";
        use std::io::Write;
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&config)
            .and_then(|mut f| f.write_all(rules.as_bytes()));
    }

    Ok(base)
}

/// Build a temporary agent YAML for legacy `kimi-cli` so we can inject a system
/// prompt via `--agent-file` without overwriting the user's project files.
fn prepare_kimi_agent_file(system_prompt: &str) -> Result<std::path::PathBuf, String> {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let base = std::env::temp_dir().join(format!("owllm-kimi-agent-{millis}"));
    std::fs::create_dir_all(&base).map_err(|e| format!("mkdir {}: {e}", base.display()))?;

    let agent_yaml = base.join("agent.yaml");
    std::fs::write(&agent_yaml, kimi_agent_yaml(system_prompt))
        .map_err(|e| format!("write agent.yaml: {e}"))?;

    Ok(agent_yaml)
}

fn kimi_agent_yaml(system_prompt: &str) -> String {
    let mut yaml =
        "version: 1\nagent:\n  name: owllm\n  extend: default\n  system_prompt_args:\n    ROLE_ADDITIONAL: |-\n"
            .to_string();
    for line in system_prompt.trim().lines() {
        yaml.push_str("      ");
        yaml.push_str(line);
        yaml.push('\n');
    }
    yaml
}

/// kimi-cli exits 0 even when its turn FAILS — the error only appears in the
/// printed output (verified live 2026-07-06 via ~/.kimi/logs/kimi.log). So a
/// clean exit code can't be trusted; classify the output text instead, or the
/// caller returns kimi's error message AS the assistant's reply.
///
/// kimi's `_agent_loop` calls `wait_for_background_mcp_loading()` which raises
/// `MCPRuntimeError` if ANY configured MCP server can't connect — it aborts the
/// whole turn BEFORE the model runs, unlike Claude/Codex which just proceed
/// without those tools. So an unreachable browser gateway kills the run.
fn kimi_output_mcp_failed(out: &str) -> bool {
    let l = out.to_ascii_lowercase();
    l.contains("failed to connect mcp servers") || l.contains("mcpruntimeerror")
}

/// kimi prints `LLM not set` and exits 0 when no model resolves (LLMNotSet).
fn kimi_output_llm_unset(out: &str) -> bool {
    out.to_ascii_lowercase().contains("llm not set")
}

/// kimi prints a 401 / unauthorized / login-expired message and exits 0 when its
/// OAuth access token is stale or revoked. Without this check the caller would
/// hand the error text back as the agent's answer and the retry layer would not
/// recognize it as an auth failure.
fn kimi_output_auth_failed(out: &str) -> bool {
    let l = out.to_ascii_lowercase();
    l.contains("401") || l.contains("unauthorized") || l.contains("not logged in") || l.contains("login expired") || l.contains("signed out")
}

/// `--model` args for a kimi invocation, resilient to the CLI's config:
/// pass the requested id only when the config declares it. Forcing an
/// undeclared id makes current kimi-cli abort with `LLMNotSet` — that was the
/// "subscription never ties after login" bug AND the ~1s silent crash when a
/// team requests a catalogue id (e.g. `kimi-k2.7`) the CLI's config doesn't
/// list (reproduced live 2026-07-05: exit 1 with the forced model, exit 0
/// without it).
fn kimi_model_args(requested: Option<&str>) -> Vec<String> {
    let cfg = kimi_config_text();
    let has_default = cfg.as_deref().map(kimi_config_has_default).unwrap_or(false);
    let keys = cfg.as_deref().map(kimi_config_model_keys).unwrap_or_default();
    kimi_model_args_inner(requested, has_default, &keys, kimi_has_modern_login())
}

/// Pure decision core for `kimi_model_args` (no filesystem) so the policy is
/// unit-tested. `self_sufficient` = the CLI can resolve its own model (a config
/// default OR a modern credentials login); when true we must NOT force an
/// undeclared id, or the CLI dies on `LLMNotSet`.
fn kimi_model_args_inner(
    requested: Option<&str>,
    has_default: bool,
    keys: &[String],
    modern_login: bool,
) -> Vec<String> {
    let _ = keys;
    let self_sufficient = has_default || modern_login;
    match requested.map(str::trim).filter(|s| !s.is_empty()) {
        // Always pass the model the user actually selected. Silently dropping
        // an undeclared id was making OwLLM use the user's unrelated CLI
        // default (e.g. Claude) instead of the requested Kimi model. If the
        // id is invalid, Kimi prints LLMNotSet and kimi_cli_complete retries
        // once without the flag.
        Some(req) => vec!["--model".into(), req.to_string()],
        None if self_sufficient => Vec::new(),
        // No config default, no modern login, and no request: ancient CLI needs
        // the always-valid alias.
        None => vec!["--model".into(), "kimi-latest".into()],
    }
}

/// Google Gemini CLI stores settings and history under ~/.gemini too, so the
/// directory itself is not proof of auth. These are the narrow credential file
/// names we accept and remove.
fn gemini_credential_paths(home: &std::path::Path) -> Vec<PathBuf> {
    let dir = home.join(".gemini");
    vec![
        dir.join("oauth_creds.json"),
        dir.join("credentials.json"),
    ]
}

fn gemini_cli_logged_in() -> bool {
    let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) else {
        return false;
    };
    let home = PathBuf::from(home);
    gemini_credential_paths(&home)
        .into_iter()
        .any(|p| p.is_file() && std::fs::metadata(p).map(|m| m.len() > 0).unwrap_or(false))
}

fn find_gemini_cli() -> Option<PathBuf> {
    for name in ["gemini.exe", "gemini.cmd", "gemini"] {
        if let Some(path) = which_extended(name) {
            return Some(path);
        }
    }
    None
}

/// Reusable validator for the new wave of OpenAI-compatible providers.
/// `prefix` lets each provider's expected key shape ("sk-", "xai-",
/// "gsk_", "pplx-") surface in the probe message; pass None for
/// providers that don't enforce one.
fn generic_api_probe(
    map: &BTreeMap<String, String>,
    env: &str,
    prefix: Option<&str>,
) -> (bool, String) {
    let v = map.get(env).cloned();
    match v {
        Some(k) if k.trim().is_empty() => (false, format!("No {env} saved")),
        Some(k) if prefix.map(|p| k.starts_with(p)).unwrap_or(true) => {
            let detail = match prefix {
                Some(p) => format!("Key present ({p}…)"),
                None => format!("Key present ({} chars)", k.len()),
            };
            (true, detail)
        }
        Some(_) => (
            false,
            format!("Key does not start with {:?} — double-check the provider's docs", prefix.unwrap_or("")),
        ),
        None => (false, format!("No {env} saved")),
    }
}

/// Wipe the local credentials file for a subscription CLI so the
/// AccountsPage card flips to disconnected within the next 3-second
/// status poll, AND so the next Connect click triggers a clean fresh
/// OAuth instead of resuming the broken session. This is the real
/// "Disconnect" — the legacy path only printed a "run `kimi /logout`
/// in a terminal" message and called it done, which left the user
/// stuck if the CLI was logged in but broken (e.g. free-tier account
/// can't use subscription, or stale token).
///
/// Cred file locations per CLI (mirrors the corresponding
/// `*_cli_logged_in()` detector):
///   * claude: ~/.claude/.credentials.json
///   * codex:  ~/.codex/auth.json + ~/.openai/auth.json (old path)
///   * kimi:   ~/.kimi/credentials/kimi-code.json (modern) + ~/.kimi/config.toml (old)
///   * gemini: ~/.gemini/oauth_creds.json + ~/.gemini/credentials.json
///             only. settings.json is configuration, not auth.
///
/// Returns a human-readable summary of what was removed so the React
/// log panel can confirm; never errors on a missing file (already
/// disconnected = success).
#[tauri::command]
pub fn subscription_cli_logout(backend: String) -> Result<String, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or_else(|| "could not resolve home dir".to_string())?;
    let home = PathBuf::from(home);
    let mut removed: Vec<String> = Vec::new();

    let try_remove = |p: &PathBuf, removed: &mut Vec<String>| {
        if p.exists() {
            if std::fs::remove_file(p).is_ok() {
                removed.push(p.display().to_string());
            }
        }
    };

    match backend.as_str() {
        "claude_cli" => {
            try_remove(&home.join(".claude").join(".credentials.json"), &mut removed);
        }
        "codex_cli" => {
            try_remove(&home.join(".codex").join("auth.json"), &mut removed);
            try_remove(&home.join(".openai").join("auth.json"), &mut removed);
        }
        "kimi_cli" => {
            // Modern kimi-code uses ~/.kimi-code; legacy kimi-cli used ~/.kimi.
            // Remove from BOTH so Disconnect actually clears the real token.
            for kimi in kimi_home_candidates() {
                try_remove(&kimi.join("credentials").join("kimi-code.json"), &mut removed);
                try_remove(&kimi.join("config.toml"), &mut removed);
            }
        }
        "gemini_cli" => {
            for path in gemini_credential_paths(&home) {
                try_remove(&path, &mut removed);
            }
        }
        other => return Err(format!("unknown subscription backend: {other}")),
    }

    if removed.is_empty() {
        Ok("Already disconnected (no credentials file found).".to_string())
    } else {
        Ok(format!("Removed credentials: {}", removed.join(", ")))
    }
}

/// Trigger the subscription CLI's OAuth flow. Each CLI needs a real
/// TTY to print the OAuth URL + handle the interactive slash-command
/// path (`claude /login`, `kimi /login`, …) — hiding the console was
/// the wrong fix and silently killed the login flow. Match the legacy
/// PySide6 app (agent_runtime_manager._spawn_visible_login): open a
/// NEW visible console with `cmd /K` so:
///   * the OAuth URL stays on screen long enough to copy
///   * the user can type the slash-command if the CLI needs it
///   * the window survives the CLI exit ("press enter" prompts work)
///
/// Once the CLI writes its credentials file, the AccountsPage 3-s
/// poll flips the card to green. Returns immediately after spawn.
#[tauri::command]
pub fn subscription_cli_login(backend: String) -> Result<(), String> {
    // Resolve which CLI to launch + the login command. Two flavours:
    //   * codex login          — real subcommand, runs OAuth and exits
    //   * gemini (no args)     — REPL prompts for auth; the embedded
    //                            terminal auto-sends /auth
    //   * claude (no args)     — REPL auto-prompts /login on first run
    //                            because there are no credentials yet
    //   * kimi (no args)       — same: kimi REPL auto-prompts for login
    //                            when ~/.kimi/config.toml is missing
    //
    // We avoid passing `/login` as a positional argv because slash
    // commands only work INSIDE the REPL — every CLI we tested
    // (claude, kimi) errors out with "unknown argument /login" if
    // they receive it on the command line.
    let (find_fn, login_args): (fn() -> Option<PathBuf>, &[&str]) = match backend.as_str() {
        "claude_cli"  => (find_claude_cli,  &[]),
        "codex_cli"   => (find_codex_cli,   &["login"]),
        "kimi_cli"    => (find_kimi_cli,    &[]),
        "gemini_cli"  => (find_gemini_cli,  &[]),
        other => return Err(format!("unknown subscription backend: {other}")),
    };
    let exe = find_fn().ok_or_else(|| format!(
        "CLI not found on PATH for {backend} — install it first"
    ))?;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // `cmd /c start "Login" cmd /k "<cli> <args>"`:
        //   * `start` spawns a NEW window (CREATE_NEW_CONSOLE), so the
        //     CLI's stdout/stderr go somewhere the user can see.
        //   * `/k` keeps the inner cmd open after the CLI exits so the
        //     OAuth URL and any closing message stay readable.
        // We pass the cli args inside one quoted string so any spaces
        // in the exe path survive cmd's word-splitting.
        let inner = format!(
            "\"\"{}\" {}\"",
            exe.display(),
            login_args.join(" ")
        );
        let mut cmd = Command::new("cmd.exe");
        cmd.raw_arg("/c");
        cmd.raw_arg("start");
        cmd.raw_arg("\"OWLLM Login\"");
        cmd.raw_arg("cmd.exe");
        cmd.raw_arg("/k");
        cmd.raw_arg(inner);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());
        // CREATE_NEW_CONSOLE (0x00000010) on the wrapper so the new
        // console actually decouples from this Tauri-spawned process.
        cmd.creation_flags(0x00000010);
        cmd.spawn().map_err(|e| format!("spawn login console: {e}"))?;
    }

    #[cfg(not(windows))]
    {
        let mut cmd = Command::new(&exe);
        cmd.args(login_args);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());
        cmd.spawn().map_err(|e| format!("spawn {}: {e}", exe.display()))?;
    }

    Ok(())
}

/// Locate the `codex` executable (OpenAI Codex CLI). Pattern matches
/// find_claude_cli / find_kimi_cli — npm-installed, lives in the
/// npm-global dir on Windows.
fn find_codex_cli() -> Option<PathBuf> {
    for name in ["codex.exe", "codex.cmd", "codex"] {
        if let Some(path) = which_extended(name) {
            return Some(path);
        }
    }
    None
}

/// One streaming event from the install process. Mirrors the shape
/// React's right-rail log panel renders. `stream` is "stdout" |
/// "stderr" so the UI can colour-tint stderr lines without giving
/// up colour-by-content heuristics.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CliInstallEvent {
    /// One line of output from the install process.
    Line { stream: String, text: String },
    /// Final exit status. code is None when the OS killed the process
    /// before it set one (timeout, OOM).
    Done { code: Option<i32> },
}

/// Streaming counterpart to cli_install. Spawns the install hidden,
/// pipes stdout + stderr, and streams each line back over the supplied
/// Channel so the React side can render it in an in-app log panel
/// instead of a pop-out console window. Same per-backend mapping as
/// cli_install — see that function for the install commands.
///
/// Returns Ok with the exit code on completion. Callers should also
/// watch the on_event stream for a Done event so they can disable the
/// Install button until it fires.
#[tauri::command]
pub async fn cli_install_stream(
    backend: String,
    on_event: Channel<CliInstallEvent>,
) -> Result<i32, String> {
    // kimi-cli requires Python >=3.12; on hosts with an older Python, pip
    // filters out EVERY release and dies with "No matching distribution
    // found for kimi-cli" (bug report #32). uv sidesteps the host Python
    // entirely by provisioning a managed CPython for the tool env — the
    // same approach the WSL install already uses. Prefer the bundled uv
    // (MCP toolchain module), then a PATH uv; plain pip stays as the last
    // resort for machines that have neither but do have Python 3.12+.
    let kimi_uv: Option<PathBuf> = if backend == "kimi_cli" {
        crate::paths::module_uv_exe()
            .or_else(|| ["uv.exe", "uv"].iter().find_map(|n| which_extended(n)))
    } else {
        None
    };
    let kimi_via_pip = backend == "kimi_cli" && kimi_uv.is_none();

    let (tool_path, args): (PathBuf, Vec<String>) = if let Some(uv) = kimi_uv {
        // `uv tool install` puts the shim in ~/.local/bin, which
        // extra_search_dirs() already walks — no restart needed.
        (uv, ["tool", "install", "--upgrade", "--python", "3.13", "kimi-cli"]
            .iter().map(|s| s.to_string()).collect())
    } else {
        let (tool, args): (&'static str, Vec<&'static str>) = match backend.as_str() {
            "claude_cli" => ("npm", vec!["install", "-g", "@anthropic-ai/claude-code"]),
            "codex_cli"  => ("npm", vec!["install", "-g", "@openai/codex"]),
            "kimi_cli"   => ("pip", vec!["install", "--upgrade", "kimi-cli"]),
            "gemini_cli" => ("npm", vec!["install", "-g", "@google/gemini-cli"]),
            other => return Err(format!("unknown CLI backend: {other}")),
        };

        // Find the package manager. Mirrors cli_install's pre-check.
        let tool_path = {
            let names = [format!("{tool}.exe"), format!("{tool}.cmd"), tool.to_string()];
            names.iter().find_map(|n| which_extended(n))
                .ok_or_else(|| {
                    if tool == "npm" {
                        // Direct the user at OUR module installer instead
                        // of nodejs.org — the bundled runtime is one click
                        // away in the Modules wizard and doesn't require
                        // a manual download / system Node install.
                        "Node.js runtime not installed. Open Modules and install 'Node.js runtime' (one click, ~30 MB) — then retry. (Or install Node.js system-wide from https://nodejs.org/ if you prefer.)".to_string()
                    } else {
                        format!("{tool} not found on PATH — install Python (https://www.python.org/) first.")
                    }
                })?
        };
        (tool_path, args.iter().map(|s| s.to_string()).collect())
    };

    let backend_label = backend.clone();
    let on_event_done = on_event.clone();
    tokio::task::spawn_blocking(move || -> Result<i32, String> {
        let mut cmd = Command::new(&tool_path);
        // npm/pip on Windows are .cmd shims; route args through raw_arg
        // so the BatBadBut guard doesn't reject perfectly safe arg strings.
        #[cfg(windows)]
        let batch = is_batch_shim(&tool_path);
        #[cfg(not(windows))]
        let batch = false;
        for a in &args {
            push_arg(&mut cmd, batch, a);
        }
        // Prepend the bundled Node.js dir to the child's PATH so
        // npm's spawned helpers (node-gyp, postinstall scripts, etc.)
        // can resolve `node` without the user having installed Node
        // system-wide. Falls through to the inherited PATH for anything
        // else (git, python for native modules, etc.).
        if let Some(node_dir) = crate::paths::module_node_dir() {
            let existing = std::env::var("PATH").unwrap_or_default();
            #[cfg(windows)] let sep = ";";
            #[cfg(not(windows))] let sep = ":";
            cmd.env("PATH", format!("{}{sep}{}", node_dir.display(), existing));
        }
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let _ = on_event.send(CliInstallEvent::Line {
            stream: "stdout".to_string(),
            text: format!("$ {} {}", tool_path.display(), args.join(" ")),
        });
        let _ = on_event.send(CliInstallEvent::Line {
            stream: "stdout".to_string(),
            text: format!("[{backend_label}] installing… this can take 30-90 s for npm packages."),
        });
        if kimi_via_pip {
            let _ = on_event.send(CliInstallEvent::Line {
                stream: "stdout".to_string(),
                text: "[kimi_cli] note: kimi-cli needs Python 3.12+. If pip ends with 'No matching distribution found', install the 'MCP Server Toolchain' module (bundles uv) and retry — uv provisions its own Python.".to_string(),
            });
        }

        let mut child = cmd.spawn().map_err(|e| format!("spawn {}: {e}", tool_path.display()))?;
        let stdout = child.stdout.take().ok_or("no stdout pipe")?;
        let stderr = child.stderr.take().ok_or("no stderr pipe")?;

        // Two reader threads — one per pipe — so a chatty stderr can't
        // backpressure a stdout-only npm run (or vice versa).
        let ev_out = on_event.clone();
        let t_out = std::thread::spawn(move || {
            let r = BufReader::new(stdout);
            for line in r.lines().flatten() {
                let _ = ev_out.send(CliInstallEvent::Line {
                    stream: "stdout".to_string(),
                    text: line,
                });
            }
        });
        let ev_err = on_event.clone();
        let t_err = std::thread::spawn(move || {
            let r = BufReader::new(stderr);
            for line in r.lines().flatten() {
                let _ = ev_err.send(CliInstallEvent::Line {
                    stream: "stderr".to_string(),
                    text: line,
                });
            }
        });

        let status = child.wait().map_err(|e| format!("wait child: {e}"))?;
        let _ = t_out.join();
        let _ = t_err.join();
        let code = status.code().unwrap_or(-1);
        Ok(code)
    })
    .await
    .map_err(|e| format!("join error: {e}"))
    .and_then(|r| r)
    .map(|code| {
        let _ = on_event_done.send(CliInstallEvent::Done { code: Some(code) });
        code
    })
    .map_err(|e| {
        let _ = on_event_done.send(CliInstallEvent::Done { code: None });
        e
    })
}

/// One-click installer for the four subscription CLIs. Bundling these
/// directly in our installer is impractical — Node.js + Python +
/// 4 CLIs is ~300 MB of extra weight and the CLIs auto-update on
/// their own. Instead we shell out to the user's existing npm / pip
/// in a VISIBLE console so they can see the install progress and any
/// permission prompts. Once the install finishes the console stays
/// open (cmd /k) so they can read the success / error message before
/// closing it. The next Connect click then finds the CLI on PATH and
/// runs the OAuth flow normally.
///
/// Returns an Err with a "tool not on PATH" message when the user
/// doesn't have npm or pip; the React side surfaces that with a link
/// to the appropriate runtime download page (nodejs.org / python.org).
#[tauri::command]
pub fn cli_install(backend: String) -> Result<(), String> {
    // Per-backend install recipe + the runtime tool it needs. We
    // intentionally pick the canonical package each project publishes:
    //   * Claude Code: @anthropic-ai/claude-code (npm)
    //   * Codex:       @openai/codex (npm)
    //   * Kimi Code:   kimi-cli (pip)
    //   * Gemini CLI:  @google/gemini-cli (npm)
    let (tool, install_cmd) = match backend.as_str() {
        "claude_cli" => ("npm", "npm install -g @anthropic-ai/claude-code"),
        "codex_cli"  => ("npm", "npm install -g @openai/codex"),
        "kimi_cli"   => ("pip", "pip install --upgrade kimi-cli"),
        "gemini_cli" => ("npm", "npm install -g @google/gemini-cli"),
        other => return Err(format!("unknown CLI backend: {other}")),
    };

    // Verify the package manager is reachable before we open a console
    // and run something that just errors out. On Windows npm/pip ship
    // as .cmd shims; check all three extensions. Use which_extended so
    // a freshly-installed Node.js or Python that hasn't been picked up
    // by our inherited PATH still counts.
    let names: [String; 3] = [
        format!("{tool}.exe"),
        format!("{tool}.cmd"),
        tool.to_string(),
    ];
    let pm_found = names.iter().any(|n| which_extended(n).is_some());
    if !pm_found {
        let runtime = if tool == "npm" { "Node.js (https://nodejs.org/)" }
                      else            { "Python (https://www.python.org/)" };
        return Err(format!(
            "{tool} not found on PATH — install {runtime} first, then click Install again."
        ));
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Same shape as subscription_cli_login: open a new visible
        // console via `cmd /c start cmd /k "<install command>"`. /k
        // keeps the window open after install completes so the user
        // can read npm's summary / any "added 132 packages in 14s"
        // confirmation before closing.
        let inner = format!("\"{install_cmd}\"");
        let title = format!("\"Install {backend}\"");
        let mut cmd = Command::new("cmd.exe");
        cmd.raw_arg("/c");
        cmd.raw_arg("start");
        cmd.raw_arg(title);
        cmd.raw_arg("cmd.exe");
        cmd.raw_arg("/k");
        cmd.raw_arg(inner);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());
        // CREATE_NEW_CONSOLE so the install window is decoupled from
        // this Tauri-spawned process.
        cmd.creation_flags(0x00000010);
        cmd.spawn().map_err(|e| format!("spawn install console: {e}"))?;
    }

    #[cfg(not(windows))]
    {
        // POSIX: rely on the user's default terminal. Most distros
        // have $TERMINAL or xdg-terminal; fall back to plain spawn.
        let mut parts = install_cmd.split_whitespace();
        let head = parts.next().ok_or("empty install command")?;
        let args: Vec<&str> = parts.collect();
        let mut cmd = Command::new(head);
        cmd.args(&args);
        cmd.spawn().map_err(|e| format!("spawn {head}: {e}"))?;
    }

    Ok(())
}

/// One-shot completion via `gemini --prompt`. Same shape as the
/// Kimi CLI handler — non-interactive mode that returns the model's
/// final reply on stdout. gemini-cli (google-gemini/gemini-cli) reads
/// OAuth creds from ~/.gemini and routes the call through the
/// Gemini API on the user's subscription.
#[tauri::command]
pub async fn gemini_cli_complete(
    app: tauri::AppHandle,
    system_prompt: String,
    user_message: String,
    cwd: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    // Host runs get the in-app browser gateway. Gemini CLI has no per-run
    // MCP flag — it reads project-scoped `<cwd>/.gemini/settings.json`
    // (shape verified against `gemini mcp add -s project -t http` 0.43.0).
    // The entry is merge-written on every spawn so the gateway's fresh
    // port/token always win; other settings keys are preserved.
    if !crate::sandbox::is_isolated(cwd.as_deref()) {
        if let Some(dir) = cwd.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            if std::path::Path::new(dir).is_dir() {
                if let Err(e) = crate::mcp_gateway::write_gemini_project_config(&app, dir) {
                    eprintln!("gemini: browser gateway not wired ({e}); run continues without browser tools");
                }
            }
        }
    }
    tokio::task::spawn_blocking(move || {
        let composed = if system_prompt.trim().is_empty() {
            user_message
        } else {
            format!("{system_prompt}\n\n---\n\n{user_message}")
        };

        // gemini-cli accepts --prompt (-p) for non-interactive output.
        // Keep --output-format text explicit so stdout stays machine-friendly.
        //
        // COMMAND-LINE LIMIT (same class as the kimi os-error-206 / claude
        // "command line is too long" bugs): a full agentic system prompt as the
        // --prompt ARG blows the ~8-32 KB Windows argv cap and the spawn dies
        // before the model ever runs. gemini-cli also reads a piped-stdin
        // prompt in non-interactive mode, so for a LARGE prompt we keep
        // `--prompt ""` for headless mode and feed the real text on stdin.
        // Small prompts keep --prompt + null stdin — byte-identical to the
        // proven Accounts-Test path. Mirrors the kimi/codex/claude folds.
        const MAX_PROMPT_ARG: usize = 4000;
        let fold_prompt_into_stdin = composed.len() > MAX_PROMPT_ARG;
        let mut args: Vec<String> = Vec::new();
        args.push("--skip-trust".into());
        args.push("--output-format".into());
        args.push("text".into());
        if let Some(m) = model.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            args.push("--model".into());
            args.push(m.to_string());
        }
        args.push("--prompt".into());
        args.push(if fold_prompt_into_stdin { String::new() } else { composed.clone() });

        // WSL-isolated project → run `gemini` inside the distro; else Windows CLI.
        let mut cmd = if let Some((exe, sargs)) =
            crate::sandbox::program_argv(cwd.as_deref(), "gemini", &args)
        {
            let mut c = Command::new(exe);
            c.args(sargs);
            c
        } else {
            let exe = find_gemini_cli()
                .ok_or_else(|| "gemini CLI not found on PATH — install gemini-cli (https://github.com/google-gemini/gemini-cli) first".to_string())?;
            #[cfg(windows)]
            let batch = is_batch_shim(&exe);
            #[cfg(not(windows))]
            let batch = false;
            let mut c = Command::new(&exe);
            for a in &args {
                push_arg(&mut c, batch, a);
            }
            if let Some(dir) = cwd.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
                let p = std::path::Path::new(dir);
                if p.is_dir() {
                    c.current_dir(p);
                }
            }
            c
        };
        cmd.stdin(if fold_prompt_into_stdin { Stdio::piped() } else { Stdio::null() });
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| format!("spawn gemini: {e}"))?;
        let pid = register_cli_child(&child);
        if fold_prompt_into_stdin {
            if let Some(mut stdin) = child.stdin.take() {
                // Best-effort like the kimi/claude folds: if gemini exited early
                // its pipe is closed and this write fails — the real error
                // surfaces from the exit status below.
                use std::io::Write as _;
                let _ = stdin.write_all(composed.as_bytes());
            }
        }
        let output = wait_cli_child(child, pid)
            .map_err(|e| format!("wait gemini: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
            return Err(cli_exit_err("gemini", output.status.code().unwrap_or(-1), &stdout, &stderr));
        }
        let stdout = String::from_utf8(output.stdout).map_err(|e| format!("decode stdout: {e}"))?;
        Ok(stdout.trim().to_string())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// One-shot completion via the `kimi` CLI.
///
/// Supports both the legacy `MoonshotAI/kimi-cli` and the newer
/// `MoonshotAI/kimi-code` (the user's linked repo):
///   * Base invocation (both): `--print --final-message-only --output-format text`
///     so the run is non-interactive and stdout is plain text.
///   * Legacy: inject the system prompt via `--agent-file` and wire the browser
///     gateway via `--mcp-config-file`.
///   * New (`kimi-code`): there is no `--system-prompt` or `--mcp-config-file`
///     flag, so we inject the system prompt via a temporary `KIMI_CODE_HOME`
///     containing `AGENTS.md`, copy the user's config/credentials, and wire the
///     browser gateway through `mcp.json` + `OWLLM_GW_TOKEN`.
#[tauri::command]
pub async fn kimi_cli_complete(
    app: tauri::AppHandle,
    system_prompt: String,
    user_message: String,
    cwd: Option<String>,
    model: Option<String>,
    _allowed_tools: Option<Vec<String>>,
) -> Result<String, String> {
    // Browser tools are a CROSS-CUTTING capability: every host-run Kimi agent
    // gets the in-app browser gateway, not just the Browser role. kimi-cli
    // fatally aborts a turn if ANY configured MCP server can't connect
    // (wait_for_background_mcp_loading -> MCPRuntimeError; exit 0, error only
    // in stdout), so we keep a session cache: once the gateway proves
    // unreachable we stop wiring it for the rest of the session.
    // WSL-isolated runs skip it regardless: the distro kimi can't reach host
    // loopback and no relay is plumbed for this one-shot path yet.
    // Session cache: 0=unknown, 1=reachable, 2=broken.
    static KIMI_GATEWAY: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);
    let host_run = !crate::sandbox::is_isolated(cwd.as_deref());
    let gw_broken = KIMI_GATEWAY.load(std::sync::atomic::Ordering::Relaxed) == 2;
    let new_flavor = kimi_is_new_flavor();

    // Legacy CLI needs a JSON `--mcp-config-file`; new kimi-code reads
    // `mcp.json` from `KIMI_CODE_HOME`, so the MCP wiring is done inside the
    // temporary home in the spawn-blocking closure below.
    let old_mcp_config: Option<String> = if !new_flavor && host_run && !gw_broken {
        match crate::mcp_gateway::write_cli_config(&app) {
            Ok(p) => Some(p.to_string_lossy().to_string()),
            Err(e) => {
                eprintln!("kimi: browser gateway not wired ({e}); run continues without browser tools");
                None
            }
        }
    } else {
        None
    };

    tokio::task::spawn_blocking(move || {
        let system_empty = system_prompt.trim().is_empty();
        let folded_prompt = if system_empty {
            user_message.clone()
        } else {
            format!("{system_prompt}\n\n===== YOUR TASK =====\n\n{user_message}")
        };

        // Pass the model the user selected. If Kimi CLI doesn't recognise the id
        // it aborts with LLMNotSet; we catch that and retry once without the
        // --model flag so the CLI can fall back to its configured default.
        let model_args = kimi_model_args(model.as_deref());

        enum Injection {
            TempHome(std::path::PathBuf),
            AgentFile(std::path::PathBuf),
        }

        // One kimi invocation. `with_mcp` controls whether the browser gateway
        // is wired; `with_model` controls whether the --model flag is present.
        // Returns (final assistant text, whether MCP loading failed).
        let attempt = |with_mcp: bool, with_model: bool| -> Result<(String, bool), String> {
            // We can only safely inject AGENTS.md / mcp.json when the child is
            // spawned directly on the host. The WSL route is a `wsl.exe bash -lc`
            // wrapper; environment variables don't propagate, so fall back to
            // folding the system prompt into the user prompt there.
            let will_use_wsl = crate::sandbox::program_argv(cwd.as_deref(), "kimi", &[]).is_some();
            let injection: Option<Injection> = if will_use_wsl {
                None
            } else if new_flavor && (with_mcp || !system_empty) {
                Some(Injection::TempHome(prepare_kimi_code_home(
                    &app,
                    &system_prompt,
                    with_mcp,
                )?))
            } else if !new_flavor && !system_empty {
                Some(Injection::AgentFile(prepare_kimi_agent_file(&system_prompt)?))
            } else {
                None
            };

            // When we couldn't inject the system prompt separately, fold it.
            let prompt_value = if injection.is_none() && !system_empty {
                folded_prompt.clone()
            } else {
                user_message.clone()
            };

            // New kimi-code has no stdin prompt path; legacy does. Keep a safe
            // argv budget on Windows to avoid CreateProcess ENAMETOOLONG.
            const ARGV_BUDGET: usize = 28_000;
            let prompt_fits = prompt_value.len() <= ARGV_BUDGET;
            if new_flavor && !prompt_fits {
                return Err("kimi prompt exceeds the safe Windows argv budget; shorten the request".to_string());
            }
            let use_prompt_flag = prompt_fits;

            // Both legacy kimi-cli and current kimi-code support --print
            // non-interactive mode; --output-format only works in that mode.
            let mut args: Vec<String> = vec![
                "--print".into(),
                "--output-format".into(),
                "text".into(),
                "--final-message-only".into(),
            ];
            if with_model {
                args.extend(model_args.iter().cloned());
            }
            if !new_flavor && with_mcp {
                if let Some(cfg) = old_mcp_config.as_ref() {
                    args.push("--mcp-config-file".into());
                    args.push(cfg.clone());
                }
            }
            if let Some(Injection::AgentFile(p)) = injection.as_ref() {
                args.push("--agent-file".into());
                args.push(p.to_string_lossy().to_string());
            }
            if let Some(Injection::TempHome(home)) = injection.as_ref() {
                if !system_empty {
                    args.push("--agent-file".into());
                    args.push(home.join("agent.yaml").to_string_lossy().to_string());
                }
            }
            if use_prompt_flag {
                args.push("--prompt".into());
                args.push(prompt_value.clone());
            }

            // WSL-isolated project → run `kimi` inside the distro; else host CLI.
            let mut cmd = if let Some((exe, sargs)) =
                crate::sandbox::program_argv(cwd.as_deref(), "kimi", &args)
            {
                let mut c = Command::new(exe);
                c.args(sargs);
                c
            } else {
                let exe = find_kimi_cli()
                    .ok_or_else(|| "kimi CLI not found on PATH — install Kimi Code (https://github.com/MoonshotAI/kimi-code) first".to_string())?;
                #[cfg(windows)]
                let batch = is_batch_shim(&exe);
                #[cfg(not(windows))]
                let batch = false;
                let mut c = Command::new(&exe);
                for a in &args {
                    push_arg(&mut c, batch, a);
                }
                if let Some(dir) = cwd.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
                    let p = std::path::Path::new(dir);
                    if p.is_dir() {
                        c.current_dir(p);
                    }
                }
                c
            };

            // kimi-cli (legacy) is Python; force UTF-8 so non-ANSI replies don't
            // crash the codec. PYTHONIOENCODING is required on Windows so stdout
            // can carry emoji; PYTHONUTF8 covers file reads. New kimi-code is Node,
            // but the variables are harmless.
            cmd.env("PYTHONUTF8", "1");
            cmd.env("PYTHONIOENCODING", "utf-8");
            if let Some(Injection::TempHome(home)) = injection.as_ref() {
                cmd.env("KIMI_CODE_HOME", home);
                if with_mcp {
                    if let Ok(info) = crate::mcp_gateway::ensure_started(&app) {
                        cmd.env("OWLLM_GW_TOKEN", &info.token);
                    }
                }
            }

            cmd.stdin(if use_prompt_flag { Stdio::null() } else { Stdio::piped() });
            cmd.stdout(Stdio::piped());
            cmd.stderr(Stdio::piped());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            let mut child = cmd.spawn().map_err(|e| format!("spawn kimi: {e}"))?;
            let pid = register_cli_child(&child);
            if !use_prompt_flag {
                if let Some(mut stdin) = child.stdin.take() {
                    // Best-effort: on the WSL path the pipe can close early ("pipe
                    // has been ended, os error 109"); the real error still surfaces
                    // via exit status / stdout, so don't abort on the write.
                    let _ = stdin.write_all(prompt_value.as_bytes());
                }
            }
            let output = wait_cli_child(child, pid)
                .map_err(|e| format!("wait kimi: {e}"))?;

            // Clean up the temporary injection files now that the child is done.
            match injection {
                Some(Injection::TempHome(home)) => {
                    let _ = std::fs::remove_dir_all(&home);
                }
                Some(Injection::AgentFile(path)) => {
                    if let Some(parent) = path.parent() {
                        let _ = std::fs::remove_dir_all(parent);
                    }
                }
                None => {}
            }

            let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            if !output.status.success() {
                // Kimi splits its error signal: the real cause (LLMNotSet, auth,
                // MCP failure) is usually in stdout, while stderr carries a
                // session-resume line that confuses users. Detect the actionable
                // failures first so the outer retry / auth handlers engage.
                if kimi_output_llm_unset(&stdout) {
                    return Err("kimi: LLM not set".to_string());
                }
                if kimi_output_auth_failed(&stdout) || kimi_output_auth_failed(&stderr) {
                    let detail = if kimi_output_auth_failed(&stdout) {
                        stdout.trim()
                    } else {
                        stderr.trim()
                    };
                    return Err(format!("kimi: authentication failed — {detail}"));
                }
                if kimi_output_mcp_failed(&stdout) || kimi_output_mcp_failed(&stderr) {
                    return Err("kimi: browser gateway unreachable".to_string());
                }
                // Strip the noisy "To resume this session:" line from stderr
                // before falling back to the generic message.
                let clean_stderr = stderr
                    .lines()
                    .filter(|l| !l.to_ascii_lowercase().contains("to resume this session"))
                    .collect::<Vec<_>>()
                    .join("\n");
                return Err(cli_exit_err(
                    "kimi",
                    output.status.code().unwrap_or(-1),
                    &stdout,
                    &clean_stderr,
                ));
            }
            // kimi exits 0 even on a fatal MCP-load failure; the error is only in
            // the output. Detect it so we can retry without the gateway.
            let mcp_failed = kimi_output_mcp_failed(&stdout) || kimi_output_mcp_failed(&stderr);
            Ok((stdout.trim().to_string(), mcp_failed))
        };

        let wired = old_mcp_config.is_some()
            || (new_flavor && host_run && !gw_broken);
        let (mut reply, mcp_failed) = match attempt(wired, true) {
            Ok(r) => r,
            Err(e) if kimi_output_llm_unset(&e) => {
                eprintln!("kimi: requested model not recognised ({e}); retrying with CLI default");
                attempt(wired, false)?
            }
            Err(e) => return Err(e),
        };
        if wired && mcp_failed {
            // kimi aborts the whole turn if an MCP server can't connect — retry
            // once without the browser gateway so the user gets a real answer
            // (no browser tools this run), and skip it for the rest of the session.
            KIMI_GATEWAY.store(2, std::sync::atomic::Ordering::Relaxed);
            eprintln!("kimi: browser gateway unreachable (kimi aborts on MCP-connect failure); retrying without it");
            reply = attempt(false, true)?.0;
        } else if wired {
            KIMI_GATEWAY.store(1, std::sync::atomic::Ordering::Relaxed);
        }

        // kimi prints these and STILL exits 0, so guard explicitly — otherwise
        // the caller would hand the error text back as the agent's answer.
        if reply.is_empty() {
            return Err("kimi returned an empty reply".to_string());
        }
        if kimi_output_llm_unset(&reply) {
            return Err("kimi: no model resolved (LLMNotSet) — run `kimi login`, or set a default model in ~/.kimi-code/config.toml (or ~/.kimi/config.toml for legacy CLI)".to_string());
        }
        if kimi_output_mcp_failed(&reply) {
            return Err("kimi: browser gateway unreachable and the retry without it also failed".to_string());
        }
        if kimi_output_auth_failed(&reply) {
            return Err("kimi: authentication failed (401 / login expired / signed out)".to_string());
        }

        // New kimi-code text mode prefixes each assistant block with "• ";
        // strip the leading bullet so the React side receives clean text.
        if new_flavor {
            reply = reply.trim_start_matches("• ").trim().to_string();
        }

        Ok(reply)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::{
        codex_should_grant_browser, is_browser_role_allowlist, kimi_config_has_default,
        kimi_agent_yaml, kimi_config_model_keys, kimi_output_auth_failed, kimi_output_llm_unset,
        kimi_output_mcp_failed,
    };

    // The exact kimi output that crashed a team run (reproduced live 2026-07-06,
    // ~/.kimi/logs/kimi.log): kimi aborts the turn when the browser gateway
    // can't connect, but EXITS 0 — so the failure must be detected in the text.
    #[test]
    fn kimi_mcp_failure_is_detected_despite_exit_0() {
        let out = "Unknown error: Failed to connect MCP servers: {'owllm': \
            RuntimeError('Client failed to connect: All connection attempts failed')}";
        assert!(kimi_output_mcp_failed(out));
        assert!(kimi_output_mcp_failed("kimi_cli.exception.MCPRuntimeError: ..."));
        assert!(!kimi_output_mcp_failed("Here is the summary you asked for."));
        // A real reply that merely mentions MCP must not trip the detector.
        assert!(!kimi_output_mcp_failed("I added an MCP server to your config."));
    }

    #[test]
    fn kimi_llm_unset_is_detected() {
        assert!(kimi_output_llm_unset("LLM not set"));
        assert!(kimi_output_llm_unset("  llm not set\n"));
        assert!(!kimi_output_llm_unset("The model is set to K2.7."));
    }

    #[test]
    fn kimi_auth_failure_is_detected_despite_exit_0() {
        assert!(kimi_output_auth_failed("⚠ moonshot is signed out — its login expired (401). Re-authenticate..."));
        assert!(kimi_output_auth_failed("HTTP 401 Unauthorized"));
        assert!(kimi_output_auth_failed("You are not logged in. Run `kimi login`."));
        assert!(!kimi_output_auth_failed("The server responded with a 200 OK."));
    }

    #[test]
    fn kimi_agent_yaml_preserves_default_coding_prompt() {
        let yaml = kimi_agent_yaml("Stay on task.\nUse repo tools.");
        assert!(yaml.contains("extend: default"));
        assert!(yaml.contains("ROLE_ADDITIONAL: |-"));
        assert!(yaml.contains("      Stay on task."));
        assert!(!yaml.contains("system_prompt_path"));
    }

    // Reproduces the "subscription never ties after login" bug: a login-time
    // config declares a default + one model; forcing an undeclared id (the old
    // hardcoded `kimi-latest`) is what triggered LLMNotSet.
    const KIMI_CFG: &str = "default_model = \"kimi-code/kimi-for-coding\"\n\
        [models.\"kimi-code/kimi-for-coding\"]\nmodel = \"kimi-for-coding\"\n";

    #[test]
    fn kimi_config_default_and_keys_parse() {
        assert!(kimi_config_has_default(KIMI_CFG));
        assert_eq!(kimi_config_model_keys(KIMI_CFG), vec!["kimi-code/kimi-for-coding"]);
        assert!(!kimi_config_has_default("theme = \"dark\"\n"));
        assert!(kimi_config_model_keys("theme = \"dark\"\n").is_empty());
    }

    #[test]
    fn kimi_model_args_policy() {
        use super::{kimi_config_has_default, kimi_config_model_keys, kimi_model_args_inner};
        // Exercise the REAL decision core (no filesystem) so the shipped policy
        // is what's tested — the old copy-of-the-logic closure hid the crash.
        let decide = |req: Option<&str>, cfg: Option<&str>, modern: bool| -> Vec<String> {
            let has_default = cfg.map(kimi_config_has_default).unwrap_or(false);
            let keys = cfg.map(kimi_config_model_keys).unwrap_or_default();
            kimi_model_args_inner(req, has_default, &keys, modern)
        };
        // Any requested id is passed explicitly. If Kimi CLI doesn't recognise it,
        // the LLMNotSet detector in kimi_cli_complete retries without the flag.
        // This prevents OwLLM from silently switching to the user's unrelated CLI
        // default (e.g. Claude) when they asked for a specific Kimi model.
        assert_eq!(
            decide(Some("kimi-latest"), Some(KIMI_CFG), false),
            vec!["--model", "kimi-latest"]
        );
        assert_eq!(
            decide(Some("kimi-k2.7"), None, true),
            vec!["--model", "kimi-k2.7"]
        );
        assert_eq!(
            decide(Some("kimi-code/kimi-for-coding"), Some(KIMI_CFG), false),
            vec!["--model", "kimi-code/kimi-for-coding"]
        );
        // No model requested → let the CLI use its configured default.
        assert!(decide(None, Some(KIMI_CFG), false).is_empty());
        // No config at all (ancient CLI) and no request → keep the always-valid alias.
        assert_eq!(decide(None, None, false), vec!["--model", "kimi-latest"]);
    }

    #[test]
    fn browser_role_detected_from_bare_and_prefixed_names() {
        let bare = vec!["browser_open".to_string(), "read_file".to_string()];
        assert!(is_browser_role_allowlist(Some(&bare)));
        let prefixed = vec!["mcp__owllm__browser_snapshot".to_string()];
        assert!(is_browser_role_allowlist(Some(&prefixed)));
    }

    #[test]
    fn non_browser_roles_are_not_matched() {
        let publisher = vec![
            "read_file".to_string(),
            "shell".to_string(),
            "publish_release".to_string(),
        ];
        assert!(!is_browser_role_allowlist(Some(&publisher)));
        assert!(!is_browser_role_allowlist(Some(&vec![])));
        assert!(!is_browser_role_allowlist(None));
        // "web_fetch"/"web_search" must NOT trip the browser exception.
        let researcher = vec!["web_fetch".to_string(), "web_search".to_string()];
        assert!(!is_browser_role_allowlist(Some(&researcher)));
    }

    #[test]
    fn codex_browser_grant_is_cross_cutting_except_jailed_non_browser() {
        // Host runs and non-jailed WSL/Lima/bwrap environments get the gateway
        // regardless of role, matching the documented cross-cutting design.
        assert!(codex_should_grant_browser(true, false, false));
        assert!(codex_should_grant_browser(false, false, false));
        // Jailed WSL blocks the transport for ordinary agents.
        assert!(!codex_should_grant_browser(false, true, false));
        // The Browser role keeps an explicit jail exception.
        assert!(codex_should_grant_browser(false, true, true));
    }
}
