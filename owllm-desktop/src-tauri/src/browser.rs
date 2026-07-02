// Browser Control — the SERVER side of the OWLLM "logged-in browser" feature.
//
// A single persistent Playwright daemon (resources/tools/browser_daemon.py)
// runs as a child process; we own it here and talk to it over stdio with
// newline-delimited JSON. The frontend (localTools.ts) never sees Python — it
// calls these five Tauri commands and gets text back:
//
//   browser_ensure  -> verify Playwright + Chromium are available (actionable
//                      error otherwise); does NOT spawn the daemon.
//   browser_start   -> spawn the daemon (idempotent: no-op if already alive).
//   browser_cmd     -> send one {action, params} line, return the daemon's text.
//   browser_stop    -> close the session, return a text reply.
//   browser_status  -> {running, pid}; resilient to a dead child.
//
// Concurrency: exactly one daemon. SESSION is a Mutex<Option<Session>>; every
// command locks it, so requests to the single daemon are serialized (a slow
// navigate blocks a concurrent snapshot — correct for one shared browser).

use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;

struct Session {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

static SESSION: Lazy<Mutex<Option<Session>>> = Lazy::new(|| Mutex::new(None));

#[derive(Serialize)]
pub struct BrowserStatus {
    running: bool,
    pid: Option<u32>,
}

/// Resolve a Python interpreter to run the daemon. Mirrors how other bundled
/// scripts are spawned (prefer OWLLM_PYTHON, then the app's bundled runtime),
/// then falls back to a `python3`/`python` on PATH so the feature works on a
/// dev machine or a Playwright-provisioned host.
fn python_cmd() -> Result<String, String> {
    if let Ok(p) = std::env::var("OWLLM_PYTHON") {
        if !p.is_empty() && std::path::Path::new(&p).is_file() {
            return Ok(p);
        }
    }
    if let Some(p) = crate::paths::bundled_python_exe() {
        return Ok(p.to_string_lossy().into_owned());
    }
    for cand in ["python3", "python"] {
        let ok = Command::new(cand)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            return Ok(cand.to_string());
        }
    }
    Err("No Python interpreter found. Set OWLLM_PYTHON, install the python-runtime module, \
         or add python3 to PATH."
        .to_string())
}

/// Locate the daemon script — prefer the bundled resources copy, fall back to
/// the legacy LLM/tools/ tree (same order as `paths::abliterate_script()`).
fn daemon_script() -> Result<PathBuf, String> {
    if let Some(root) = crate::paths::resources_root() {
        let p = root.join("tools").join("browser_daemon.py");
        if p.is_file() {
            return Ok(p);
        }
    }
    if let Some(root) = crate::paths::llm_root() {
        let p = root.join("tools").join("browser_daemon.py");
        if p.is_file() {
            return Ok(p);
        }
    }
    Err("browser_daemon.py not found in resources/tools/ or LLM/tools/".to_string())
}

/// Stable default profile dir so browser logins persist across app runs.
/// The daemon has the same default; we set it explicitly to keep the two in
/// lockstep and rooted in the app's user-data tree.
fn default_profile_dir() -> Option<PathBuf> {
    crate::paths::user_data_root().map(|r| r.join("browser_profile"))
}

/// True when a session exists AND its child is still alive. Clears a dead
/// session in place so callers never reuse a stale handle.
fn session_alive(guard: &mut Option<Session>) -> bool {
    let dead = match guard.as_mut() {
        Some(sess) => matches!(sess.child.try_wait(), Ok(Some(_))),
        None => return false,
    };
    if dead {
        *guard = None;
        return false;
    }
    true
}

/// Verify Playwright (and a real Chromium binary) are usable by the resolved
/// Python. Does NOT spawn the daemon — cheap enough to call before start.
#[tauri::command]
pub fn browser_ensure() -> Result<String, String> {
    let py = python_cmd()?;
    // Import Playwright AND confirm the Chromium executable actually exists,
    // so we fail here (with the install command) instead of at launch time.
    let probe = r#"
import os, sys
try:
    from playwright.sync_api import sync_playwright
except Exception as e:
    sys.stderr.write("IMPORT:%s" % e); sys.exit(2)
with sync_playwright() as p:
    exe = p.chromium.executable_path
    if not exe or not os.path.exists(exe):
        sys.stderr.write("CHROMIUM_MISSING"); sys.exit(3)
"#;
    let out = Command::new(&py)
        .arg("-c")
        .arg(probe)
        .output()
        .map_err(|e| format!("failed to run Python ({py}): {e}"))?;
    if out.status.success() {
        return Ok(format!("Playwright + Chromium available ({py})"));
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.contains("CHROMIUM_MISSING") {
        return Err(format!(
            "Chromium is not installed for this Python. Install it:\n  {py} -m playwright install chromium"
        ));
    }
    Err(format!(
        "Playwright is not available for {py}. Install it:\n  \
         {py} -m pip install playwright && {py} -m playwright install chromium\n\n{stderr}"
    ))
}

/// Spawn the daemon child. Idempotent: if a live daemon already exists this is
/// a no-op. Reads the daemon's one-line startup handshake so a launch failure
/// (missing Chromium, unwritable profile) surfaces here, not on first command.
#[tauri::command]
pub fn browser_start() -> Result<String, String> {
    let mut guard = SESSION.lock().map_err(|_| "browser session lock poisoned".to_string())?;
    if session_alive(&mut guard) {
        return Ok("browser already running".to_string());
    }

    let py = python_cmd()?;
    let script = daemon_script()?;

    let mut cmd = Command::new(&py);
    cmd.arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // Give the daemon a stable profile dir (unless the user pinned one).
    if std::env::var_os("OWLLM_BROWSER_PROFILE").is_none() {
        if let Some(dir) = default_profile_dir() {
            cmd.env("OWLLM_BROWSER_PROFILE", dir);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn browser daemon ({py}): {e}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "browser daemon: no stdin pipe".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "browser daemon: no stdout pipe".to_string())?;
    let mut reader = BufReader::new(stdout);

    // Startup handshake — one JSON line: ready, or an actionable launch error.
    let mut line = String::new();
    let n = reader
        .read_line(&mut line)
        .map_err(|e| format!("browser daemon: reading startup line: {e}"))?;
    if n == 0 {
        let _ = child.kill();
        return Err("browser daemon exited before signalling ready".to_string());
    }
    let v: Value = serde_json::from_str(line.trim())
        .map_err(|e| format!("browser daemon: bad startup line {line:?}: {e}"))?;
    if v.get("ok").and_then(Value::as_bool) != Some(true) {
        let _ = child.kill();
        let msg = v.get("output").and_then(Value::as_str).unwrap_or("unknown launch error");
        return Err(msg.to_string());
    }

    *guard = Some(Session { child, stdin, stdout: reader });
    Ok("browser started".to_string())
}

/// Send one action to the daemon and return its text reply. Rechecks the child
/// is alive before use (never talks to a stale session).
#[tauri::command]
pub fn browser_cmd(action: String, params: Value) -> Result<String, String> {
    let mut guard = SESSION.lock().map_err(|_| "browser session lock poisoned".to_string())?;
    if !session_alive(&mut guard) {
        return Err("browser is not running — call browser_start first".to_string());
    }
    let req = json!({ "action": action, "params": params });
    let line = serde_json::to_string(&req).map_err(|e| format!("serialize request: {e}"))?;

    let sess = guard.as_mut().expect("session present after alive check");
    let write_res = sess
        .stdin
        .write_all(line.as_bytes())
        .and_then(|_| sess.stdin.write_all(b"\n"))
        .and_then(|_| sess.stdin.flush());
    if let Err(e) = write_res {
        *guard = None;
        return Err(format!("browser daemon: writing request failed (daemon gone?): {e}"));
    }

    let sess = guard.as_mut().expect("session present");
    let mut resp = String::new();
    let read_res = sess.stdout.read_line(&mut resp);
    let n = match read_res {
        Ok(n) => n,
        Err(e) => return Err(format!("browser daemon: reading reply failed: {e}")),
    };
    if n == 0 {
        *guard = None;
        return Err("browser daemon closed the connection".to_string());
    }
    let v: Value = serde_json::from_str(resp.trim())
        .map_err(|e| format!("browser daemon: bad reply {resp:?}: {e}"))?;
    let output = v.get("output").and_then(Value::as_str).unwrap_or("").to_string();
    if v.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(output)
    } else {
        Err(if output.is_empty() { "browser command failed".to_string() } else { output })
    }
}

/// Close the session: tell the daemon to shut down, read its final reply, reap
/// the child, and clear SESSION. Safe to call when nothing is running.
#[tauri::command]
pub fn browser_stop() -> Result<String, String> {
    let mut guard = SESSION.lock().map_err(|_| "browser session lock poisoned".to_string())?;
    let mut sess = match guard.take() {
        Some(s) => s,
        None => return Ok("browser was not running".to_string()),
    };
    let mut reply = "browser stopped".to_string();
    let _ = sess.stdin.write_all(b"{\"action\":\"close\",\"params\":{}}\n");
    let _ = sess.stdin.flush();
    let mut line = String::new();
    if sess.stdout.read_line(&mut line).unwrap_or(0) > 0 {
        if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
            if let Some(o) = v.get("output").and_then(Value::as_str) {
                reply = o.to_string();
            }
        }
    }
    // Ensure the child is gone even if it ignored `close`.
    let _ = sess.child.wait();
    Ok(reply)
}

/// Whether a live daemon is running. Resilient to a dead child: if the process
/// has exited we clear SESSION and report running:false.
#[tauri::command]
pub fn browser_status() -> Result<BrowserStatus, String> {
    let mut guard = SESSION.lock().map_err(|_| "browser session lock poisoned".to_string())?;
    if !session_alive(&mut guard) {
        return Ok(BrowserStatus { running: false, pid: None });
    }
    let pid = guard.as_ref().map(|s| s.child.id());
    Ok(BrowserStatus { running: true, pid })
}
