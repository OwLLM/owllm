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
            find_claude_cli(), &["--print"], "Claude", Some("ok")).await,
        // OpenAI Codex CLI: `codex exec <prompt>` is the non-interactive
        // shape. There's no --print/--prompt; older docs to the contrary.
        "codex_cli" => probe_cli_subscription(
            find_codex_cli(), &["exec", "ok"], "Codex", None).await,
        "kimi_cli" => probe_cli_subscription(
            find_kimi_cli(),
            // `--model kimi-latest` so the probe works even when the
            // user's kimi config has no default model set (CLI's REPL
            // welcome screen prints "Model: not set" and any --print
            // call exits 1 without a model). kimi-latest is Moonshot's
            // always-available alias.
            &["--print", "--output-format", "text", "--final-message-only",
              "--model", "kimi-latest", "--prompt", "ok"],
            "Kimi", None,
        ).await,
        "gemini_cli" => probe_cli_subscription(
            find_gemini_cli(), &["--prompt", "ok"], "Gemini", None).await,

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
    args: &'static [&'static str],
    name: &'static str,
    stdin_text: Option<&'static str>,
) -> (bool, String) {
    let Some(exe) = exe else {
        return (false, format!("{name} CLI not found on PATH"));
    };
    let args_vec: Vec<String> = args.iter().map(|s| s.to_string()).collect();
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
    }

    dirs
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

/// Kimi Code CLI (MoonshotAI/kimi-cli) saves its OAuth config to
/// ~/.kimi/config.toml after `kimi /login`. Same presence-of-file
/// signal as Claude / Codex.
fn kimi_cli_logged_in() -> bool {
    let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) else {
        return false;
    };
    let cfg = PathBuf::from(home).join(".kimi").join("config.toml");
    cfg.exists()
}

/// Google Gemini CLI (google-gemini/gemini-cli) caches OAuth at
/// ~/.gemini/ after `gemini /auth` (or `gemini login`). The dir
/// presence + at least one file inside is a reliable "logged in"
/// signal — Google ships a few JSON files there (credentials.json,
/// settings.json) once auth completes.
fn gemini_cli_logged_in() -> bool {
    let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) else {
        return false;
    };
    let dir = PathBuf::from(home).join(".gemini");
    if !dir.is_dir() {
        return false;
    }
    // Require at least one JSON-shaped file to avoid greenlighting an
    // empty stub directory left behind by a previous failed install.
    std::fs::read_dir(&dir)
        .map(|it| it.flatten().any(|e| {
            e.path().extension().and_then(|s| s.to_str()).map(|x| x.eq_ignore_ascii_case("json")).unwrap_or(false)
        }))
        .unwrap_or(false)
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
///   * kimi:   ~/.kimi/config.toml
///   * gemini: every *.json under ~/.gemini/ (oauth_creds.json,
///             settings.json, etc. — the detector greenlights on any
///             json present, so we wipe them all)
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
            try_remove(&home.join(".kimi").join("config.toml"), &mut removed);
        }
        "gemini_cli" => {
            let dir = home.join(".gemini");
            if dir.is_dir() {
                if let Ok(entries) = std::fs::read_dir(&dir) {
                    for e in entries.flatten() {
                        let path = e.path();
                        let is_json = path
                            .extension()
                            .and_then(|s| s.to_str())
                            .map(|x| x.eq_ignore_ascii_case("json"))
                            .unwrap_or(false);
                        if is_json {
                            try_remove(&path, &mut removed);
                        }
                    }
                }
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
    //   * gemini auth login    — same shape, two-word subcommand
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
        "gemini_cli"  => (find_gemini_cli,  &["auth", "login"]),
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
                let runtime = if tool == "npm" { "Node.js (https://nodejs.org/)" }
                              else            { "Python (https://www.python.org/)" };
                format!("{tool} not found on PATH — install {runtime} first.")
            })?
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
    system_prompt: String,
    user_message: String,
    cwd: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let exe = find_gemini_cli()
            .ok_or_else(|| "gemini CLI not found on PATH — install gemini-cli (https://github.com/google-gemini/gemini-cli) first".to_string())?;
        let mut cmd = Command::new(&exe);

        #[cfg(windows)]
        let batch = is_batch_shim(&exe);
        #[cfg(not(windows))]
        let batch = false;

        let composed = if system_prompt.trim().is_empty() {
            user_message
        } else {
            format!("{system_prompt}\n\n---\n\n{user_message}")
        };

        // gemini-cli accepts --prompt (-p) for non-interactive output
        // (matches Claude/Kimi conventions). --model picks the variant.
        if let Some(m) = model.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            push_arg(&mut cmd, batch, "--model");
            push_arg(&mut cmd, batch, m);
        }
        push_arg(&mut cmd, batch, "--prompt");
        push_arg(&mut cmd, batch, &composed);

        if let Some(dir) = cwd.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            let p = std::path::Path::new(dir);
            if p.is_dir() {
                cmd.current_dir(p);
            }
        }
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let output = cmd
            .spawn()
            .map_err(|e| format!("spawn gemini: {e}"))?
            .wait_with_output()
            .map_err(|e| format!("wait gemini: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            return Err(format!(
                "gemini CLI exited {} — {}",
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

/// One-shot completion via `kimi --print --prompt`. Mirrors the
/// shape of claude_cli_complete but uses Kimi Code CLI's actual flag
/// surface: `--print` (alias `-q` for quiet/final-only when paired
/// with `--final-message-only`), `--prompt` (`-p`) for the user text,
/// `--model` (`-m`) for the model id. We use `--print
/// --final-message-only --output-format text` so the CLI emits ONLY
/// the assistant's final reply on stdout — no streaming preamble for
/// us to strip on this side.
///
/// System prompt: the CLI has no `--append-system-prompt` (that's a
/// Claude-CLI-specific flag); we fold it into the prompt with a clear
/// separator instead.
#[tauri::command]
pub async fn kimi_cli_complete(
    system_prompt: String,
    user_message: String,
    cwd: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let exe = find_kimi_cli()
            .ok_or_else(|| "kimi CLI not found on PATH — install Kimi Code (https://github.com/MoonshotAI/kimi-cli) first".to_string())?;
        let mut cmd = Command::new(&exe);

        #[cfg(windows)]
        let batch = is_batch_shim(&exe);
        #[cfg(not(windows))]
        let batch = false;

        // Compose system + user into a single prompt — Kimi --print
        // mode doesn't expose a system-message flag.
        let composed = if system_prompt.trim().is_empty() {
            user_message
        } else {
            format!("{system_prompt}\n\n---\n\n{user_message}")
        };

        push_arg(&mut cmd, batch, "--print");
        // Suppress everything except the final assistant message so
        // the React side gets a clean blob, not a streaming preamble.
        push_arg(&mut cmd, batch, "--output-format");
        push_arg(&mut cmd, batch, "text");
        push_arg(&mut cmd, batch, "--final-message-only");
        if let Some(m) = model.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            push_arg(&mut cmd, batch, "--model");
            push_arg(&mut cmd, batch, m);
        }
        push_arg(&mut cmd, batch, "--prompt");
        push_arg(&mut cmd, batch, &composed);

        if let Some(dir) = cwd.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            let p = std::path::Path::new(dir);
            if p.is_dir() {
                cmd.current_dir(p);
            }
        }
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let output = cmd
            .spawn()
            .map_err(|e| format!("spawn kimi: {e}"))?
            .wait_with_output()
            .map_err(|e| format!("wait kimi: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            return Err(format!(
                "kimi CLI exited {} — {}",
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
