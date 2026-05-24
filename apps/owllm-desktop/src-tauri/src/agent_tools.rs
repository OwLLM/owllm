// Agent-callable tool surface for the local llama-server path.
//
// The legacy Python app exposes tools to every local model via the
// XML-tag protocol defined in LLM/core/agents/tools/parser.py — the
// system prompt teaches the model the format, the agent loop parses
// <tool_call> blocks out of each turn and runs them. Without this the
// model can only describe what it would do.
//
// This module is the Rust executor for that protocol. The TS dispatch
// loop in apps/owllm-desktop/ui/src/pages/agentic/dispatch.ts parses
// tool_call blocks out of model output, invokes each command here,
// and folds the result back into the conversation. One round-trip per
// call; the loop keeps going until the model emits no more calls.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub kind: String, // "file" or "dir"
    pub size: Option<u64>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// Resolve a tool path against an optional project CWD. If the path
/// is absolute we accept it as-is; if it's relative the CWD is the
/// anchor (matches the Python tool runtime's behavior).
fn resolve(path: &str, cwd: &Option<String>) -> PathBuf {
    let p = Path::new(path);
    if p.is_absolute() {
        return p.to_path_buf();
    }
    match cwd.as_deref() {
        Some(c) if !c.is_empty() => Path::new(c).join(p),
        _ => p.to_path_buf(),
    }
}

#[tauri::command]
pub async fn tool_read_file(path: String, cwd: Option<String>) -> Result<String, String> {
    let p = resolve(&path, &cwd);
    std::fs::read_to_string(&p).map_err(|e| format!("read {}: {e}", p.display()))
}

#[tauri::command]
pub async fn tool_write_file(
    path: String,
    content: String,
    cwd: Option<String>,
) -> Result<(), String> {
    let p = resolve(&path, &cwd);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir parent of {}: {e}", p.display()))?;
    }
    std::fs::write(&p, content).map_err(|e| format!("write {}: {e}", p.display()))
}

#[tauri::command]
pub async fn tool_list_dir(path: String, cwd: Option<String>) -> Result<Vec<DirEntry>, String> {
    let p = resolve(&path, &cwd);
    let read = std::fs::read_dir(&p).map_err(|e| format!("read dir {}: {e}", p.display()))?;
    let mut out: Vec<DirEntry> = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let meta = entry.metadata().ok();
        let (kind, size) = match meta {
            Some(m) if m.is_dir() => ("dir", None),
            Some(m) => ("file", Some(m.len())),
            None => ("file", None),
        };
        out.push(DirEntry { name, kind: kind.to_string(), size });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[tauri::command]
pub async fn tool_create_dir(path: String, cwd: Option<String>) -> Result<(), String> {
    let p = resolve(&path, &cwd);
    std::fs::create_dir_all(&p).map_err(|e| format!("mkdir {}: {e}", p.display()))
}

/// Run a shell command. On Windows we go through cmd.exe /c so models
/// can use familiar pipes/redirects without us writing a parser.
/// CREATE_NO_WINDOW keeps the popup invisible (saved memory constraint:
/// All Windows subprocesses MUST use CREATE_NO_WINDOW 0x08000000).
#[tauri::command]
pub async fn tool_shell_exec(
    command: String,
    cwd: Option<String>,
) -> Result<ShellResult, String> {
    use tokio::process::Command;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let cwd_path = cwd
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);

    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/c", &command]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", &command]);
        c
    };
    if let Some(d) = cwd_path {
        cmd.current_dir(d);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("spawn shell: {e}"))?;
    Ok(ShellResult {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

// ----- Web tools (for the brainstormer agent + any web-aware agent) -----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub description: String,
}

/// Web search via Brave Search API. Requires BRAVE_API_KEY saved via
/// accounts_save_api_key (free tier: 2000 queries/month, sign up at
/// brave.com/search/api). Falls back with a clear error if missing —
/// the agent can then explain to the user what to do.
#[tauri::command]
pub async fn tool_web_search(
    query: String,
    max_results: Option<usize>,
) -> Result<Vec<SearchHit>, String> {
    let key = crate::accounts::accounts_get_secret("BRAVE_API_KEY".to_string())
        .ok_or_else(|| "BRAVE_API_KEY not saved — open Accounts page and add your Brave Search key first (free tier at brave.com/search/api).".to_string())?;

    let count = max_results.unwrap_or(5).clamp(1, 20);
    let cli = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let resp = cli
        .get("https://api.search.brave.com/res/v1/web/search")
        .header("X-Subscription-Token", key)
        .header("Accept", "application/json")
        .query(&[("q", query.as_str()), ("count", &count.to_string())])
        .send()
        .await
        .map_err(|e| format!("brave search: {e}"))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("brave body: {e}"))?;
    if !status.is_success() {
        return Err(format!("brave search HTTP {status}: {body}"));
    }
    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("brave parse: {e}"))?;
    let results = parsed
        .get("web")
        .and_then(|w| w.get("results"))
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();
    let hits: Vec<SearchHit> = results
        .into_iter()
        .filter_map(|item| {
            let title = item.get("title")?.as_str()?.to_string();
            let url = item.get("url")?.as_str()?.to_string();
            let description = item
                .get("description")
                .and_then(|d| d.as_str())
                .unwrap_or("")
                .to_string();
            Some(SearchHit { title, url, description })
        })
        .collect();
    Ok(hits)
}

/// Fetch a URL and return readable text. v1 strips <script> / <style>
/// blocks and collapses to plain text — no full Readability port. Cap
/// at 60 KB returned to keep token budgets sane; the model can paginate
/// via re-fetches if it really needs more.
#[tauri::command]
pub async fn tool_web_fetch(url: String) -> Result<String, String> {
    const MAX_BYTES: usize = 60 * 1024;
    let cli = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; OwLLM-Brainstormer/1.0)")
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = cli.get(&url).send().await.map_err(|e| format!("fetch: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("fetch HTTP {status}"));
    }
    let html = resp.text().await.map_err(|e| format!("body: {e}"))?;
    let cleaned = strip_html(&html);
    let truncated = if cleaned.len() > MAX_BYTES {
        let mut s = cleaned[..MAX_BYTES].to_string();
        s.push_str(&format!("\n…[truncated, {} more chars]", cleaned.len() - MAX_BYTES));
        s
    } else {
        cleaned
    };
    Ok(truncated)
}

/// Crude HTML → text: strip script/style blocks, then drop remaining
/// tags, then collapse whitespace. Good enough to feed competitor
/// landing pages into a model for feature extraction — not a full DOM
/// parser, and intentionally so.
fn strip_html(html: &str) -> String {
    let mut s = html.to_string();
    // Drop script and style blocks wholesale (contents + tags).
    for tag in ["script", "style", "noscript"] {
        let open = format!("<{tag}");
        let close = format!("</{tag}>");
        loop {
            let Some(start) = s.to_lowercase().find(&open) else { break };
            let Some(end_rel) = s[start..].to_lowercase().find(&close) else { break };
            let end = start + end_rel + close.len();
            s.replace_range(start..end, " ");
        }
    }
    // Drop remaining tags.
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    // Collapse whitespace.
    let collapsed: String = out.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed
}

/// Screenshot a URL using TwinForge's web_adapter via the bundled
/// Python runtime. The brainstormer uses this to capture competitor
/// landing pages for the GUI direction synthesis. Output PNG path is
/// returned on success; spawn errors propagate as Err.
#[tauri::command]
pub async fn tool_screenshot_url(
    url: String,
    out_png: String,
) -> Result<String, String> {
    use tokio::process::Command;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // Resolve the bundled Python runtime + the screenshot_url.py wrapper.
    // The repo layout puts both under LLM/ at the workspace root; the
    // Tauri exe runs from apps/owllm-desktop/, so walk up two levels.
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|q| q.to_path_buf()));
    let candidates: Vec<PathBuf> = {
        let mut v: Vec<PathBuf> = Vec::new();
        if let Some(d) = &exe_dir {
            // Walk up to 6 levels looking for LLM/python_runtime — handles
            // dev (target/release), installed (Program Files), portable.
            let mut cur = d.clone();
            for _ in 0..6 {
                v.push(cur.join("LLM"));
                if let Some(p) = cur.parent() {
                    cur = p.to_path_buf();
                } else {
                    break;
                }
            }
        }
        // Hard-coded dev fallback so this works in cargo run from the repo root.
        v.push(PathBuf::from("C:/1_Git/LocaLLM/LLM"));
        v
    };
    let mut llm_root: Option<PathBuf> = None;
    for c in candidates {
        if c.join("python_runtime").join("python3.11").join("python.exe").is_file()
            && c.join("tools").join("screenshot_url.py").is_file() {
            llm_root = Some(c);
            break;
        }
    }
    let llm_root = llm_root.ok_or_else(|| {
        "could not locate LLM/python_runtime + LLM/tools/screenshot_url.py — TwinForge dependencies missing".to_string()
    })?;
    let python = llm_root.join("python_runtime").join("python3.11").join("python.exe");
    let script = llm_root.join("tools").join("screenshot_url.py");

    // Ensure parent dir for the output PNG exists.
    if let Some(parent) = Path::new(&out_png).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir parent of {out_png}: {e}"))?;
    }

    let mut cmd = Command::new(&python);
    cmd.arg(&script)
        .arg("--url").arg(&url)
        .arg("--out-png").arg(&out_png);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().await.map_err(|e| format!("spawn python: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("screenshot failed (exit {}): {stderr}", output.status.code().unwrap_or(-1)));
    }
    Ok(out_png)
}
