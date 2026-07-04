// Agent Browser — a NATIVE, embedded browser the agents drive.
//
// This replaces the old Playwright/Python daemon entirely. Instead of a
// separate downloaded Chromium driven over stdio, we open a real Tauri
// `WebviewWindow` (the SAME WebView2 / WKWebView / WebKitGTK engine the app
// already ships) pointed at the live web page. The user sees it as an
// OwLLM-owned popup window they can watch, move, and log into; the agents
// drive it with the browser_* tools. Cookies/logins persist because the
// window is pinned to a stable data directory under the app's user-data tree.
//
// HOW WE DRIVE IT (no Python, no IPC ACL gymnastics):
//   * An `initialization_script` (BRIDGE_JS) is injected at document-start on
//     every navigation, defining window.__owllmRun(reqId, action, paramsJson).
//     It does the DOM work (snapshot/click/fill/…) and reports the result by
//     writing a sentinel-prefixed string into `document.title`.
//   * Rust calls webview.eval(...) to invoke __owllmRun, then polls
//     webview.title() until the sentinel for that reqId appears, and reads the
//     payload back out. This channel is engine-agnostic and needs no remote
//     capability grant. Payloads are truncated JS-side (see CAP) so a single
//     title carries the whole reply — no multi-chunk loop that could hang.
//
// The Tauri command NAMES are unchanged (browser_ensure/start/cmd/stop/
// status/view) so localTools.ts and BrowserPanel.tsx keep working as-is.

use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Label of the single agent-browser window. Looked up by label everywhere, so
/// there is no global handle to keep in sync — if the user closes the window,
/// `get_webview_window` simply returns None and we report "not running".
const BROWSER_LABEL: &str = "owllm-browser";

/// Sentinel that fronts every reply written into `document.title`. Uses an
/// invisible separator (U+2063) so it can never collide with real page titles.
const SENTINEL: &str = "\u{2063}OWLLM\u{2063}";

/// Monotonic request id so a stale title from a previous action is never
/// mistaken for the current reply.
static REQ: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize)]
pub struct BrowserStatus {
    running: bool,
    /// URL the window is currently on (best-effort; empty if unknown).
    url: String,
}

/// Injected at document-start on every page. Defines the driver used by
/// `browser_cmd`. Everything is plain DOM — works on any site, any engine.
const BRIDGE_JS: &str = r##"
(function () {
  if (window.__owllmBridge) return;
  window.__owllmBridge = true;
  var SENT = "⁣OWLLM⁣";
  var CAP = 4000; // keep the whole reply inside one document.title write
  function b64(s) {
    // UTF-8 → latin1 → base64 so the reply survives the OS title channel with
    // no whitespace (document.title collapses whitespace; base64 has none).
    try { return btoa(unescape(encodeURIComponent(s))); } catch (e) { return btoa("(encode error)"); }
  }
  function report(reqId, text) {
    var s = String(text == null ? "" : text);
    if (s.length > CAP) s = s.slice(0, CAP) + "\n…[truncated]";
    document.title = SENT + reqId + "⁣" + b64(s);
  }
  function visible(el) {
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
  }
  var SEL = "a,button,input,select,textarea,[role=button],[role=link]," +
            "[role=checkbox],[role=radio],[role=tab],[role=menuitem]," +
            "[role=option],[contenteditable=true],[onclick]";
  function reindex() {
    var all = Array.prototype.slice.call(document.querySelectorAll(SEL));
    var els = [];
    for (var i = 0; i < all.length && els.length < 150; i++) {
      if (visible(all[i])) els.push(all[i]);
    }
    window.__owllmEls = els;
    return els;
  }
  function label(el) {
    var tag = el.tagName.toLowerCase();
    var txt = (el.getAttribute("aria-label") || el.getAttribute("placeholder") ||
               el.getAttribute("name") || el.value || el.innerText || el.textContent || "").trim();
    txt = txt.replace(/\s+/g, " ").slice(0, 80);
    var extra = tag === "input" ? ("[" + (el.getAttribute("type") || "text") + "]") : "";
    return "#" + tag + extra + (txt ? " " + txt : "");
  }
  function snapshot() {
    var els = reindex();
    var lines = ["URL: " + location.href, "TITLE: " + document.title, "",
                 "INTERACTIVE ELEMENTS (act on these by index):"];
    for (var i = 0; i < els.length; i++) lines.push("[" + i + "] " + label(els[i]));
    return lines.join("\n");
  }
  function elAt(i) { var e = (window.__owllmEls || [])[i]; if (!e) throw new Error("no element at index " + i); return e; }
  function fire(el, type) { el.dispatchEvent(new Event(type, { bubbles: true })); }
  window.__owllmRun = function (reqId, action, paramsJson) {
    var p = {};
    try { p = paramsJson ? JSON.parse(paramsJson) : {}; } catch (e) {}
    try {
      switch (action) {
        case "info":
          return report(reqId, JSON.stringify({ url: location.href, title: document.title, ready: document.readyState }));
        case "await_load":
          if (document.readyState === "complete" || document.readyState === "interactive") {
            return report(reqId, "Loaded: " + location.href + " — " + document.title);
          }
          window.addEventListener("DOMContentLoaded", function () {
            report(reqId, "Loaded: " + location.href + " — " + document.title);
          }, { once: true });
          return;
        case "snapshot": return report(reqId, snapshot());
        case "get_text": {
          var t = (document.body ? document.body.innerText : "") || "";
          return report(reqId, t.replace(/\n{3,}/g, "\n\n").trim());
        }
        case "click": {
          var el = elAt(p.index); el.scrollIntoView({ block: "center" });
          el.click();
          return setTimeout(function () { report(reqId, "clicked [" + p.index + "] " + label(el) + "\n\n" + snapshot()); }, 350);
        }
        case "fill": {
          var f = elAt(p.index); f.focus();
          if (f.isContentEditable) { f.textContent = p.text; }
          else { f.value = p.text; }
          fire(f, "input"); fire(f, "change");
          return report(reqId, "filled [" + p.index + "] with " + JSON.stringify(p.text));
        }
        case "select": {
          var s = elAt(p.index); var matched = false;
          for (var i = 0; i < s.options.length; i++) {
            if (s.options[i].value === p.value || s.options[i].text === p.value) { s.selectedIndex = i; matched = true; break; }
          }
          fire(s, "change");
          return report(reqId, matched ? ("selected " + JSON.stringify(p.value)) : ("no option matching " + JSON.stringify(p.value)));
        }
        case "press": {
          var t2 = document.activeElement || document.body;
          ["keydown", "keypress", "keyup"].forEach(function (k) {
            t2.dispatchEvent(new KeyboardEvent(k, { key: p.key, bubbles: true }));
          });
          if (p.key === "Enter" && t2.form) { try { t2.form.requestSubmit ? t2.form.requestSubmit() : t2.form.submit(); } catch (e) {} }
          return report(reqId, "pressed " + p.key);
        }
        case "fill_login": {
          // Autofill from the vault: fill the first visible password field and
          // the nearest preceding text/email field. Returns what it did.
          var pw = null, els = reindex();
          for (var i = 0; i < els.length; i++) { if (els[i].tagName === "INPUT" && (els[i].type === "password")) { pw = els[i]; break; } }
          var user = null;
          var inputs = Array.prototype.slice.call(document.querySelectorAll("input"));
          for (var j = 0; j < inputs.length; j++) {
            var ty = (inputs[j].type || "text");
            if (ty === "text" || ty === "email" || inputs[j].name && /user|email|login/i.test(inputs[j].name)) { user = inputs[j]; }
            if (pw && inputs[j] === pw) break;
          }
          var did = [];
          if (user && p.username) { user.focus(); user.value = p.username; fire(user, "input"); fire(user, "change"); did.push("username"); }
          if (pw && p.password) { pw.focus(); pw.value = p.password; fire(pw, "input"); fire(pw, "change"); did.push("password"); }
          return report(reqId, did.length ? ("autofilled " + did.join(" + ")) : "no login fields found on this page");
        }
        default: return report(reqId, "(unknown action: " + action + ")");
      }
    } catch (e) { report(reqId, "ERROR: " + (e && e.message ? e.message : e)); }
  };
})();
"##;

/// Stable data directory so cookies/logins in the agent browser persist across
/// runs and are isolated from the app UI's own webview storage.
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
fn browser_data_dir() -> Option<std::path::PathBuf> {
    crate::paths::user_data_root().map(|r| r.join("browser_profile"))
}

fn get_window(app: &tauri::AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(BROWSER_LABEL)
}

/// Native engine is always available — nothing to install. Kept so the tool
/// contract (localTools.ts calls browser_ensure before browser_start) is stable.
#[tauri::command]
pub fn browser_ensure() -> Result<String, String> {
    Ok("native browser ready".to_string())
}

/// Create the agent-browser window if it isn't already open. Idempotent.
#[tauri::command]
pub fn browser_start(app: tauri::AppHandle) -> Result<String, String> {
    if get_window(&app).is_some() {
        return Ok("browser already running".to_string());
    }
    let start_url = "about:blank"
        .parse()
        .map_err(|e| format!("bad start url: {e}"))?;
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(&app, BROWSER_LABEL, WebviewUrl::External(start_url))
        .title("OwLLM — Agent Browser")
        .inner_size(1180.0, 820.0)
        .initialization_script(BRIDGE_JS)
        .decorations(true)
        .resizable(true)
        .visible(true);
    // A stable, isolated data dir so agent-browser logins persist across runs.
    // The builder method is only present on Windows/Linux; macOS WKWebView uses
    // the app's default per-app store (logins still persist there).
    #[cfg(any(windows, target_os = "linux"))]
    if let Some(dir) = browser_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        builder = builder.data_directory(dir);
    }
    builder
        .build()
        .map_err(|e| format!("failed to open agent browser window: {e}"))?;
    Ok("browser started".to_string())
}

/// Run one action against the live page and return its text reply.
///
/// `navigate` uses the native `webview.navigate()` (robust across origins),
/// then awaits the new document's load through the bridge. All other actions
/// eval __owllmRun directly. Read-back is via the sentinel title channel.
#[tauri::command]
pub fn browser_cmd(app: tauri::AppHandle, action: String, params: Value) -> Result<String, String> {
    let win = get_window(&app).ok_or_else(|| "browser is not running — call browser_start first".to_string())?;
    let req = REQ.fetch_add(1, Ordering::SeqCst);

    match action.as_str() {
        "navigate" | "open" => {
            let url_s = params.get("url").and_then(Value::as_str).unwrap_or("").trim().to_string();
            if url_s.is_empty() {
                return Err("navigate requires a url".to_string());
            }
            let full = if url_s.contains("://") { url_s } else { format!("https://{url_s}") };
            let url = full.parse().map_err(|e| format!("bad url {full:?}: {e}"))?;
            win.navigate(url).map_err(|e| format!("navigate failed: {e}"))?;
            // Give the new document a moment to begin, then await its load via
            // the (re-injected) bridge. Evaled every poll tick until it reports.
            std::thread::sleep(Duration::from_millis(200));
            eval_until_reply(&win, req, "await_load", &json!({}), Duration::from_secs(30))
        }
        "back" => {
            let _ = win.eval("history.back()");
            std::thread::sleep(Duration::from_millis(300));
            eval_until_reply(&win, req, "await_load", &json!({}), Duration::from_secs(20))
        }
        "reload" => {
            let _ = win.eval("location.reload()");
            std::thread::sleep(Duration::from_millis(300));
            eval_until_reply(&win, req, "await_load", &json!({}), Duration::from_secs(20))
        }
        "screenshot" => {
            // Native window is visible to the user; return a page summary rather
            // than pixels (agents act via snapshot). Honest + cheap.
            eval_until_reply(&win, req, "info", &json!({}), Duration::from_secs(8))
        }
        _ => eval_until_reply(&win, req, &action, &params, Duration::from_secs(12)),
    }
}

/// Eval `__owllmRun(req, action, params)` on a poll loop and wait for the
/// sentinel reply in the window title. Re-evals each tick so a still-loading
/// document (where the bridge isn't defined yet) is retried until ready.
fn eval_until_reply(
    win: &WebviewWindow,
    req: u64,
    action: &str,
    params: &Value,
    timeout: Duration,
) -> Result<String, String> {
    let params_js = serde_json::to_string(&params.to_string()).unwrap_or_else(|_| "\"{}\"".to_string());
    let call = format!("try{{window.__owllmRun&&window.__owllmRun({req},{action:?},{params_js})}}catch(e){{}}");
    let prefix = format!("{SENTINEL}{req}\u{2063}");
    let start = Instant::now();
    let mut last_eval = Instant::now() - Duration::from_secs(1);
    loop {
        // Re-eval periodically (covers the case where the first eval hit a
        // transitional/loading document before the bridge was injected).
        if last_eval.elapsed() >= Duration::from_millis(250) {
            let _ = win.eval(&call);
            last_eval = Instant::now();
        }
        if let Ok(title) = win.title() {
            if let Some(rest) = title.strip_prefix(&prefix) {
                use base64::Engine as _;
                let out = base64::engine::general_purpose::STANDARD
                    .decode(rest.trim())
                    .ok()
                    .and_then(|b| String::from_utf8(b).ok())
                    .unwrap_or_else(|| rest.to_string());
                // Neutralise the title so this reply isn't re-read next tick.
                let _ = win.eval("try{document.title=location.href}catch(e){}");
                if let Some(msg) = out.strip_prefix("ERROR: ") {
                    return Err(msg.to_string());
                }
                return Ok(out);
            }
        }
        if start.elapsed() > timeout {
            return Err(format!("browser action '{action}' timed out"));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Close the agent-browser window. Safe when nothing is open.
#[tauri::command]
pub fn browser_stop(app: tauri::AppHandle) -> Result<String, String> {
    match get_window(&app) {
        Some(win) => {
            win.close().map_err(|e| format!("close failed: {e}"))?;
            Ok("browser stopped".to_string())
        }
        None => Ok("browser was not running".to_string()),
    }
}

/// Panel view: current URL + title as JSON (the window itself is the live view).
#[tauri::command]
pub fn browser_view(app: tauri::AppHandle) -> Result<String, String> {
    let win = get_window(&app).ok_or_else(|| "browser not running".to_string())?;
    let req = REQ.fetch_add(1, Ordering::SeqCst);
    eval_until_reply(&win, req, "info", &json!({}), Duration::from_secs(6))
}

/// Focus/raise the agent-browser window so the user can watch or log in.
#[tauri::command]
pub fn browser_focus(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = get_window(&app) {
        let _ = win.show();
        let _ = win.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub fn browser_status(app: tauri::AppHandle) -> Result<BrowserStatus, String> {
    match get_window(&app) {
        Some(win) => {
            let url = win.url().map(|u| u.to_string()).unwrap_or_default();
            Ok(BrowserStatus { running: true, url })
        }
        None => Ok(BrowserStatus { running: false, url: String::new() }),
    }
}
