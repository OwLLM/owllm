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
//     writing a sentinel-prefixed string into `document.title` (then restoring
//     the real title a tick later).
//   * Rust registers `on_document_title_changed` on the window — the engine
//     PUSHES every title change to us (WebView2 DocumentTitleChanged etc.), and
//     sentinel-tagged ones are parked in REPLIES keyed by request id. The
//     waiting command polls that in-process map, not the OS window title.
//     Payloads are truncated JS-side (see CAP) so a single title write carries
//     the whole reply — no multi-chunk loop that could hang.
//
// THREADING — THE PART THAT BIT US (v0.7.53 white-screen/freeze): a plain
// #[tauri::command] fn is executed INLINE ON THE MAIN THREAD. These commands
// wait (up to tens of seconds) for the page, so running them there froze the
// whole event loop: the browser window never painted (white), its ✕ never
// responded, and navigation itself could not proceed. Every command below is
// therefore #[tauri::command(async)] — Tauri runs the sync fn on a threadpool,
// and the WebviewWindow handle methods (eval/navigate/…) safely dispatch to
// the (now free) main thread. Window creation is also thread-safe: the runtime
// routes it through Message::CreateWindow to the event loop.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
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

/// A reply being assembled from one-or-more title-channel chunks.
/// `document.title` can't reliably carry a large payload in a single write (a
/// long page's base64 gets truncated in transit → decode failure → the agent
/// got raw base64). So a reply is base64-split into CAP-sized chunks that Rust
/// pulls one at a time and reassembles. A short reply is a single chunk
/// (total = 1) — same one-write path as before, no extra round-trips.
struct ReplyAcc {
    total: u64,
    chunks: std::collections::BTreeMap<u64, String>,
}

/// Replies pushed by the document-title-changed handler, keyed by request id.
/// Bounded: entries older than the newest 64 are dropped on insert.
static REPLIES: Mutex<Option<HashMap<u64, ReplyAcc>>> = Mutex::new(None);

/// Parse a sentinel-tagged title into (request id, chunk index, total chunks,
/// base64 payload). Returns None for ordinary page titles.
/// Wire format: SENTINEL + id + U+2063 + k + U+2063 + total + U+2063 + b64.
fn parse_reply(title: &str) -> Option<(u64, u64, u64, &str)> {
    let rest = title.strip_prefix(SENTINEL)?;
    let (id, rest) = rest.split_once('\u{2063}')?;
    let (k, rest) = rest.split_once('\u{2063}')?;
    let (total, payload) = rest.split_once('\u{2063}')?;
    Some((id.parse().ok()?, k.parse().ok()?, total.parse().ok()?, payload))
}

/// Called by the title-changed handler for every title the page sets.
fn capture_reply(title: &str) {
    let Some((id, k, total, payload)) = parse_reply(title) else { return };
    let mut guard = REPLIES.lock().unwrap_or_else(|p| p.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    let acc = map.entry(id).or_insert_with(|| ReplyAcc { total, chunks: Default::default() });
    acc.total = total; // trust the latest report for this id
    acc.chunks.insert(k, payload.to_string());
    if map.len() > 64 {
        let min_keep = id.saturating_sub(64);
        map.retain(|kk, _| *kk >= min_keep);
    }
}

/// Total chunk count + which indices have arrived so far for `req` (None until
/// the first chunk lands). Lets the puller ask for exactly the missing chunk.
fn reply_progress(req: u64) -> Option<(u64, std::collections::BTreeSet<u64>)> {
    let guard = REPLIES.lock().unwrap_or_else(|p| p.into_inner());
    let acc = guard.as_ref()?.get(&req)?;
    Some((acc.total, acc.chunks.keys().copied().collect()))
}

/// If every chunk for `req` has arrived, consume the entry and return the
/// reassembled base64 payload (chunks concatenated in index order).
fn take_if_complete(req: u64) -> Option<String> {
    let mut guard = REPLIES.lock().unwrap_or_else(|p| p.into_inner());
    let map = guard.as_mut()?;
    let acc = map.get(&req)?;
    if acc.total == 0 || (acc.chunks.len() as u64) < acc.total {
        return None;
    }
    let assembled: String = acc.chunks.values().cloned().collect();
    map.remove(&req);
    Some(assembled)
}

/// Decode a base64 reply payload back to text, falling back to the raw string
/// if it somehow isn't valid base64 (never silently lose the reply).
fn decode_b64(payload: &str) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .unwrap_or_else(|| payload.to_string())
}

#[derive(Serialize)]
pub struct BrowserStatus {
    running: bool,
    /// URL the window is currently on (best-effort; empty if unknown).
    url: String,
    /// Current device emulation preset ("desktop" | "iphone" | "android" | "tablet").
    device: String,
}

/// Device emulation presets. Emulation = viewport size (window inner size IS
/// the CSS viewport, so 390px wide genuinely triggers responsive mobile
/// layouts) + user-agent override (for sites that sniff UA). The UA can only
/// be set at window-build time, so switching device rebuilds the window —
/// the profile data dir is stable, so logins survive the rebuild.
struct Device {
    name: &'static str,
    ua: Option<&'static str>,
    width: f64,
    height: f64,
}

const DEVICES: &[Device] = &[
    Device { name: "desktop", ua: None, width: 1180.0, height: 820.0 },
    Device {
        name: "iphone",
        ua: Some("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"),
        width: 390.0,
        height: 844.0,
    },
    Device {
        name: "android",
        ua: Some("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36"),
        width: 412.0,
        height: 915.0,
    },
    Device {
        name: "tablet",
        ua: Some("Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"),
        width: 820.0,
        height: 1180.0,
    },
];

/// Currently selected device preset — used by browser_start so a device chosen
/// before the window opens (or after a stop) sticks.
static CURRENT_DEVICE: Mutex<&'static str> = Mutex::new("desktop");

fn device_by_name(name: &str) -> Option<&'static Device> {
    let n = name.trim().to_lowercase();
    // Friendly aliases so agents/users don't have to guess the exact key.
    let key = match n.as_str() {
        "phone" | "mobile" | "ios" => "iphone",
        "pixel" => "android",
        "ipad" => "tablet",
        "pc" | "default" => "desktop",
        other => other,
    };
    DEVICES.iter().find(|d| d.name == key)
}

fn current_device() -> &'static Device {
    let name = *CURRENT_DEVICE.lock().unwrap_or_else(|p| p.into_inner());
    device_by_name(name).unwrap_or(&DEVICES[0])
}

/// Injected at document-start on every page. Defines the driver used by
/// `browser_cmd`. Everything is plain DOM — works on any site, any engine.
const BRIDGE_JS: &str = r##"
(function () {
  if (window.__owllmBridge) return;
  window.__owllmBridge = true;
  var Z = String.fromCharCode(8291); // U+2063 invisible separator
  var SENT = Z + "OWLLM" + Z;
  var CAP = 1600; // base64 chars per title write — safely within any title limit
  function b64(s) {
    // UTF-8 → base64 so the reply survives the title channel intact (base64
    // has no whitespace for anything to collapse).
    try { return btoa(unescape(encodeURIComponent(s))); } catch (e) { return btoa("(encode error)"); }
  }
  // A reply is base64-split into CAP-sized chunks that Rust pulls one at a time
  // via __owllmEmit and reassembles — a single title write can't reliably carry
  // a whole page (long titles get truncated → the agent used to get raw base64).
  // A short reply is a single chunk (total=1): the same one-write path as before.
  function report(reqId, text) {
    var b = b64(String(text == null ? "" : text));
    var chunks = [];
    for (var i = 0; i < b.length; i += CAP) chunks.push(b.slice(i, i + CAP));
    if (!chunks.length) chunks.push("");
    (window.__owllmReplies = window.__owllmReplies || {})[reqId] = chunks;
    emit(reqId, 0);
  }
  function emit(reqId, k) {
    var chunks = (window.__owllmReplies || {})[reqId];
    if (!chunks || k < 0 || k >= chunks.length) return;
    // Remember the last REAL (non-sentinel) title so restores never persist a
    // sentinel, even while several chunks are pulled in sequence.
    if (document.title.indexOf(SENT) !== 0) window.__owllmTitle0 = document.title;
    document.title = SENT + reqId + Z + k + Z + chunks.length + Z + chunks[k];
    setTimeout(function () { try { document.title = window.__owllmTitle0 || ""; } catch (e) {} }, 60);
  }
  window.__owllmEmit = function (reqId, k) { emit(reqId, k); };
  function visible(el) {
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
  }
  var SEL = "a,button,input,select,textarea,[role=button],[role=link]," +
            "[role=checkbox],[role=radio],[role=tab],[role=menuitem]," +
            "[role=option],[contenteditable=true],[onclick]";
  // React/Vue menus often use a plain <div>/<span>/<li> with an onClick handler:
  // no role, no onclick attribute — so SEL misses them (e.g. language switchers,
  // custom dropdowns). Second pass catches the INNERMOST cursor:pointer element
  // that carries a short label, without exploding on big clickable wrappers.
  function pointerClickable(el) {
    if (getComputedStyle(el).cursor !== "pointer") return false;
    var txt = (el.innerText || el.textContent || "").trim();
    if (!txt || txt.length > 60) return false;
    var kids = el.getElementsByTagName("*");
    for (var k = 0; k < kids.length; k++) {
      if ((kids[k].innerText || "").trim() &&
          getComputedStyle(kids[k]).cursor === "pointer") return false; // not innermost
    }
    return true;
  }
  function reindex() {
    var els = [];
    var primary = document.querySelectorAll(SEL);
    for (var i = 0; i < primary.length && els.length < 150; i++) {
      if (visible(primary[i])) els.push(primary[i]);
    }
    if (els.length < 150) {
      var extra = document.querySelectorAll("div,span,li");
      for (var j = 0; j < extra.length && j < 4000 && els.length < 150; j++) {
        var e = extra[j];
        if (els.indexOf(e) === -1 && visible(e) && pointerClickable(e)) els.push(e);
      }
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

/// True when a scheme-less URL clearly points at a local dev server, so the
/// default scheme should be http (dev servers rarely have TLS certs).
fn is_local_host(url: &str) -> bool {
    let host = url
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .rsplit('@')
        .next()
        .unwrap_or("");
    let bare = host.strip_prefix('[').map(|h| h.split(']').next().unwrap_or(h));
    if let Some(v6) = bare {
        return v6 == "::1";
    }
    let name = host.split(':').next().unwrap_or("").to_lowercase();
    name == "localhost"
        || name == "0.0.0.0"
        || name.ends_with(".localhost")
        || name.starts_with("127.")
        || name.starts_with("192.168.")
        || name.starts_with("10.")
}

/// Native engine is always available — nothing to install. Kept so the tool
/// contract (localTools.ts calls browser_ensure before browser_start) is stable.
#[tauri::command(async)]
pub fn browser_ensure() -> Result<String, String> {
    Ok("native browser ready".to_string())
}

/// Build the agent-browser window at `url` with the current device preset.
fn build_window(app: &tauri::AppHandle, url: tauri::Url) -> Result<WebviewWindow, String> {
    let dev = current_device();
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, BROWSER_LABEL, WebviewUrl::External(url))
        .title("OwLLM — Agent Browser")
        .inner_size(dev.width, dev.height)
        .initialization_script(BRIDGE_JS)
        // The engine pushes every document.title change here; sentinel-tagged
        // ones are the bridge's replies. This is the read half of the channel.
        .on_document_title_changed(|_win, title| capture_reply(&title))
        .decorations(true)
        .resizable(true)
        .visible(true);
    if let Some(ua) = dev.ua {
        builder = builder.user_agent(ua);
    }
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
        .map_err(|e| format!("failed to open agent browser window: {e}"))
}

/// Create the agent-browser window if it isn't already open. Idempotent.
#[tauri::command(async)]
pub fn browser_start(app: tauri::AppHandle) -> Result<String, String> {
    if get_window(&app).is_some() {
        return Ok("browser already running".to_string());
    }
    let start_url = "about:blank"
        .parse()
        .map_err(|e| format!("bad start url: {e}"))?;
    build_window(&app, start_url)?;
    Ok("browser started".to_string())
}

/// Switch device emulation (desktop / iphone / android / tablet). The UA can
/// only be set at build time, so if the window is open we rebuild it in place
/// and re-navigate to the page it was on. Logins survive (stable profile dir).
#[tauri::command(async)]
pub fn browser_set_device(app: tauri::AppHandle, device: String) -> Result<String, String> {
    let dev = device_by_name(&device).ok_or_else(|| {
        format!("unknown device {device:?} — use desktop, iphone, android or tablet")
    })?;
    *CURRENT_DEVICE.lock().unwrap_or_else(|p| p.into_inner()) = dev.name;

    let Some(win) = get_window(&app) else {
        return Ok(format!("device set to {} (applies when the browser opens)", dev.name));
    };
    // Remember where we were, tear down, rebuild with the new UA + viewport.
    let back_to = win.url().map(|u| u.to_string()).unwrap_or_default();
    win.destroy().map_err(|e| format!("could not rebuild browser window: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(5);
    while get_window(&app).is_some() {
        if Instant::now() > deadline {
            return Err("old browser window did not close".to_string());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let url = if back_to.is_empty() || back_to == "about:blank" {
        "about:blank".to_string()
    } else {
        back_to
    };
    let parsed = url.parse().map_err(|e| format!("bad url {url:?}: {e}"))?;
    build_window(&app, parsed)?;
    Ok(format!(
        "device set to {} ({}×{}{}) — reloaded {}",
        dev.name,
        dev.width as u32,
        dev.height as u32,
        if dev.ua.is_some() { ", mobile user-agent" } else { "" },
        if url == "about:blank" { "blank page".to_string() } else { url }
    ))
}

/// Run one action against the live page and return its text reply.
///
/// `navigate` uses the native `webview.navigate()` (robust across origins),
/// then awaits the new document's load through the bridge. All other actions
/// eval __owllmRun directly. Read-back is via the sentinel title channel.
#[tauri::command(async)]
pub fn browser_cmd(app: tauri::AppHandle, action: String, params: Value) -> Result<String, String> {
    let win = get_window(&app).ok_or_else(|| "browser is not running — call browser_start first".to_string())?;
    let req = REQ.fetch_add(1, Ordering::SeqCst);

    match action.as_str() {
        "navigate" | "open" => {
            let url_s = params.get("url").and_then(Value::as_str).unwrap_or("").trim().to_string();
            if url_s.is_empty() {
                return Err("navigate requires a url".to_string());
            }
            // Scheme-less URLs default to https — EXCEPT local dev servers
            // (localhost:5173, 127.0.0.1:3000, …), which are plain http.
            let full = if url_s.contains("://") {
                url_s
            } else if is_local_host(&url_s) {
                format!("http://{url_s}")
            } else {
                format!("https://{url_s}")
            };
            let url = full.parse().map_err(|e| format!("bad url {full:?}: {e}"))?;
            win.navigate(url).map_err(|e| format!("navigate failed: {e}"))?;
            // Give the new document a moment to begin, then await its load via
            // the (re-injected) bridge. Evaled every poll tick until it reports.
            std::thread::sleep(Duration::from_millis(200));
            eval_until_reply(&win, req, "await_load", &json!({}), Duration::from_secs(20))
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

/// Eval `__owllmRun(req, action, params)` and wait for its reply, which the
/// title-changed handler parks in REPLIES. Re-evals each tick so a
/// still-loading document (where the bridge isn't defined yet) is retried
/// until ready. Runs on a threadpool thread (commands are `async`), so the
/// waiting never touches the main event loop.
fn eval_until_reply(
    win: &WebviewWindow,
    req: u64,
    action: &str,
    params: &Value,
    timeout: Duration,
) -> Result<String, String> {
    let params_js = serde_json::to_string(&params.to_string()).unwrap_or_else(|_| "\"{}\"".to_string());
    let call = format!("try{{window.__owllmRun&&window.__owllmRun({req},{action:?},{params_js})}}catch(e){{}}");
    let start = Instant::now();
    let mut last_invoke = Instant::now() - Duration::from_secs(1);
    let mut requested: Option<u64> = None;
    let mut requested_at = Instant::now() - Duration::from_secs(1);
    loop {
        // Reply fully assembled → reassemble base64 + decode.
        if let Some(b64_payload) = take_if_complete(req) {
            let out = decode_b64(&b64_payload);
            if let Some(msg) = out.strip_prefix("ERROR: ") {
                return Err(msg.to_string());
            }
            return Ok(out);
        }
        match reply_progress(req) {
            // No chunk yet — (re)invoke the action. The page may still be loading
            // (bridge not injected), so retry until the first chunk lands. Once
            // ANY chunk arrives we stop re-invoking, so a side-effecting action
            // (click/fill) runs at most until its first report — no repeat click.
            None => {
                if last_invoke.elapsed() >= Duration::from_millis(250) {
                    let _ = win.eval(&call);
                    last_invoke = Instant::now();
                }
            }
            // First chunk arrived; pull the rest ONE AT A TIME. Requesting several
            // at once would coalesce into a single title event and lose the
            // intermediate chunks — so ask for the smallest missing index, advance
            // as it arrives, and re-ask every 120ms if a title event was dropped.
            Some((total, have)) => {
                if total > 1 {
                    if let Some(k) = (0..total).find(|k| !have.contains(k)) {
                        let advanced = requested != Some(k);
                        if advanced || requested_at.elapsed() >= Duration::from_millis(120) {
                            let _ = win.eval(&format!(
                                "try{{window.__owllmEmit&&window.__owllmEmit({req},{k})}}catch(e){{}}"
                            ));
                            requested = Some(k);
                            requested_at = Instant::now();
                        }
                    }
                }
            }
        }
        if start.elapsed() > timeout {
            return Err(format!(
                "browser action '{action}' timed out — the page may still be loading; try again or browser_reload"
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Close the agent-browser window. Safe when nothing is open.
#[tauri::command(async)]
pub fn browser_stop(app: tauri::AppHandle) -> Result<String, String> {
    match get_window(&app) {
        Some(win) => {
            // destroy() tears the window down unconditionally — close() asks
            // the page politely, and an unresponsive page could refuse.
            win.destroy().map_err(|e| format!("close failed: {e}"))?;
            Ok("browser stopped".to_string())
        }
        None => Ok("browser was not running".to_string()),
    }
}

/// Panel view: current URL + title as JSON (the window itself is the live view).
#[tauri::command(async)]
pub fn browser_view(app: tauri::AppHandle) -> Result<String, String> {
    let win = get_window(&app).ok_or_else(|| "browser not running".to_string())?;
    let req = REQ.fetch_add(1, Ordering::SeqCst);
    eval_until_reply(&win, req, "info", &json!({}), Duration::from_secs(6))
}

/// Focus/raise the agent-browser window so the user can watch or log in.
#[tauri::command(async)]
pub fn browser_focus(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = get_window(&app) {
        let _ = win.show();
        let _ = win.set_focus();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_hosts_get_http() {
        for u in [
            "localhost:5173",
            "localhost:3000/app",
            "127.0.0.1:8080",
            "0.0.0.0:4000",
            "app.localhost/dash",
            "192.168.1.20:3000",
            "10.0.0.5",
            "[::1]:5173",
        ] {
            assert!(is_local_host(u), "{u} should default to http");
        }
        for u in ["github.com", "example.com/login", "127x.com", "myapp.io:443", "1270.0.0.1"] {
            assert!(!is_local_host(u), "{u} should default to https");
        }
    }

    #[test]
    fn reply_channel_round_trip() {
        use base64::Engine as _;
        let payload = base64::engine::general_purpose::STANDARD.encode("hello page");
        // A single-chunk reply (total=1) — exactly what report() writes for a
        // short payload: SENTINEL id Z 0 Z 1 Z b64.
        let title = format!("{SENTINEL}42\u{2063}0\u{2063}1\u{2063}{payload}");
        assert_eq!(parse_reply(&title), Some((42u64, 0u64, 1u64, payload.as_str())));
        // Ordinary page titles + malformed sentinels are ignored.
        assert_eq!(parse_reply("GitHub — where software is built"), None);
        assert_eq!(parse_reply(""), None);
        assert_eq!(parse_reply("\u{2063}OWLLM\u{2063}garbage"), None);
        assert_eq!(parse_reply(&format!("{SENTINEL}42\u{2063}0")), None); // missing fields

        // capture → complete → decode consumes exactly once.
        capture_reply(&title);
        assert_eq!(take_if_complete(42).as_deref(), Some(payload.as_str()));
        assert_eq!(take_if_complete(42), None);

        // Multi-chunk: 3 chunks arriving OUT OF ORDER only complete once all
        // present, and reassemble in index order.
        let full = base64::engine::general_purpose::STANDARD.encode("the quick brown fox");
        let a = &full[0..6];
        let b = &full[6..12];
        let c = &full[12..];
        assert!(take_if_complete(7).is_none());
        capture_reply(&format!("{SENTINEL}7\u{2063}2\u{2063}3\u{2063}{c}"));
        assert!(take_if_complete(7).is_none()); // still missing 0,1
        capture_reply(&format!("{SENTINEL}7\u{2063}0\u{2063}3\u{2063}{a}"));
        assert!(take_if_complete(7).is_none()); // still missing 1
        capture_reply(&format!("{SENTINEL}7\u{2063}1\u{2063}3\u{2063}{b}"));
        assert_eq!(take_if_complete(7).as_deref(), Some(full.as_str()));
        assert_eq!(decode_b64(&full), "the quick brown fox");

        // The map is bounded: old ids are pruned as new ones arrive.
        // (Kept in ONE test fn — REPLIES is a process-global; parallel test
        // threads pruning it would race.)
        let x = base64::engine::general_purpose::STANDARD.encode("x");
        for id in 1000..1100u64 {
            capture_reply(&format!("{SENTINEL}{id}\u{2063}0\u{2063}1\u{2063}{x}"));
        }
        assert_eq!(take_if_complete(1000), None);
        assert_eq!(take_if_complete(1099).as_deref(), Some(x.as_str()));
    }

    #[test]
    fn device_aliases_resolve() {
        assert_eq!(device_by_name("iPhone").unwrap().name, "iphone");
        assert_eq!(device_by_name("phone").unwrap().name, "iphone");
        assert_eq!(device_by_name("mobile").unwrap().name, "iphone");
        assert_eq!(device_by_name("Pixel").unwrap().name, "android");
        assert_eq!(device_by_name("ipad").unwrap().name, "tablet");
        assert_eq!(device_by_name("default").unwrap().name, "desktop");
        assert!(device_by_name("watch").is_none());
        // mobile presets carry a UA override; desktop uses the engine default
        assert!(device_by_name("iphone").unwrap().ua.is_some());
        assert!(device_by_name("desktop").unwrap().ua.is_none());
    }
}

#[tauri::command(async)]
pub fn browser_status(app: tauri::AppHandle) -> Result<BrowserStatus, String> {
    let device = current_device().name.to_string();
    match get_window(&app) {
        Some(win) => {
            let url = win.url().map(|u| u.to_string()).unwrap_or_default();
            Ok(BrowserStatus { running: true, url, device })
        }
        None => Ok(BrowserStatus { running: false, url: String::new(), device }),
    }
}
