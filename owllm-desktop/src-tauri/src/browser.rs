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
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock, TryLockError};
use std::thread;
use std::time::{Duration, Instant};
use tauri::webview::{Color, NewWindowResponse, Webview, WebviewBuilder};
use tauri::{
    LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent,
};

/// OwLLM dark base (matches the UI `--bg-panel` floor `#0e1117`), so the agent
/// browser's blank / loading state reads as OwLLM's own surface instead of the
/// bare white "window colour" a fresh webview shows (user spec 2026-07-05).
const OWLLM_BG: Color = Color(14, 17, 23, 255);

/// Label of the framed browser container on Windows/macOS. Linux labels each
/// top-level tab with `tab_label(id)` instead.
const BROWSER_LABEL: &str = "owllm-browser";

/// Child-webview labels of the framed (app-styled) browser window: an OwLLM
/// chrome bar on top, the actual page below. Tab webviews are labelled
/// `owllm-browser-page-{id}` (see `tab_label`). CONTENT_LABEL remains as a
/// compatibility lookup for browser windows created by older builds.
const CONTENT_LABEL: &str = "owllm-browser-page";
const CHROME_LABEL: &str = "owllm-browser-chrome";

/// Height of the OwLLM chrome bar (logical px) in the framed window:
/// a 28px tab strip over a 38px nav (back/reload/URL) row.
const CHROME_H: f64 = 66.0;

/// X where parked (inactive) tab webviews live. Tauri has no cross-platform
/// hide() for child webviews, so inactive tabs are simply moved far offscreen
/// and slid back on activation. Linux uses hidden top-level tab windows because
/// stacked child WebViews are unsafe on affected WebKitGTK/Jetson drivers.
const PARK_X: f64 = -20000.0;

/// Open tabs of the framed browser window, strip order + the active id.
/// Each tab is its own content webview; they all share the same profile
/// data dir, so cookies/logins span tabs like a normal browser.
struct Tabs {
    order: Vec<u64>,
    active: u64,
    titles: HashMap<u64, String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct BrowserTabInfo {
    id: u64,
    title: String,
    url: String,
    active: bool,
}

static TABS: Mutex<Option<Tabs>> = Mutex::new(None);
static NEXT_TAB: AtomicU64 = AtomicU64::new(1);

fn tab_label(id: u64) -> String {
    format!("{CONTENT_LABEL}-{id}")
}

fn is_active_tab(id: u64) -> bool {
    TABS.lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(|t| t.active == id)
        .unwrap_or(false)
}

fn active_tab_id() -> Option<u64> {
    TABS.lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(|tabs| tabs.active)
}

/// Which tab becomes active after `closed` closes: the active tab if a
/// different one closed, else the next tab in strip order, else the previous
/// one, else None (the last tab closed → the window goes with it).
fn next_active_after_close(order: &[u64], closed: u64, active: u64) -> Option<u64> {
    if closed != active {
        return Some(active);
    }
    let idx = order.iter().position(|t| *t == closed)?;
    order
        .get(idx + 1)
        .copied()
        .or_else(|| idx.checked_sub(1).and_then(|i| order.get(i).copied()))
}

/// The app's chrome colour (resolved `--bg-header`), pushed by the UI via
/// `browser_set_chrome` on boot and on every accent change. The agent-browser
/// window paints its NATIVE title bar / border with it so the popup reads as
/// an OwLLM window instead of a stock light-grey OS frame. None until the UI
/// has pushed once (then the window still gets the dark-theme frame).
static CHROME_BG: Mutex<Option<(u8, u8, u8)>> = Mutex::new(None);

/// Parse "#rrggbb" (case-insensitive, leading '#' optional).
fn parse_hex_rgb(s: &str) -> Option<(u8, u8, u8)> {
    let h = s.trim().trim_start_matches('#');
    if h.len() != 6 || !h.is_ascii() {
        return None;
    }
    let r = u8::from_str_radix(&h[0..2], 16).ok()?;
    let g = u8::from_str_radix(&h[2..4], 16).ok()?;
    let b = u8::from_str_radix(&h[4..6], 16).ok()?;
    Some((r, g, b))
}

/// Paint the window's native frame in OwLLM chrome. The framed browser window
/// is undecorated (its bar is our own webview), so only the DWM border colour
/// still applies — kept for it and for the legacy decorated fallback, where
/// caption colouring still matters. Windows 11 only (the DWM colour attributes
/// appeared in build 22000); elsewhere the calls fail benignly.
#[cfg(windows)]
fn apply_chrome(win: &Window) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
    };
    let Some((r, g, b)) = *CHROME_BG.lock().unwrap_or_else(|p| p.into_inner()) else {
        return;
    };
    let Ok(hwnd) = win.hwnd() else { return };
    // COLORREF is 0x00BBGGRR.
    let bg: u32 = (r as u32) | ((g as u32) << 8) | ((b as u32) << 16);
    let white: u32 = 0x00ff_ffff;
    let set = |attr: i32, val: &u32| unsafe {
        DwmSetWindowAttribute(
            hwnd.0 as _,
            attr as u32,
            val as *const u32 as *const _,
            std::mem::size_of::<u32>() as u32,
        )
    };
    let _ = set(DWMWA_CAPTION_COLOR, &bg);
    let _ = set(DWMWA_BORDER_COLOR, &bg);
    let _ = set(DWMWA_TEXT_COLOR, &white);
}

#[cfg(not(windows))]
fn apply_chrome(_win: &Window) {}

/// UI → backend: the resolved app chrome colour (`--bg-header`). Stored for
/// every future agent-browser window build and applied live if one is open.
#[tauri::command(async)]
pub fn browser_set_chrome(app: tauri::AppHandle, bg: String) -> Result<(), String> {
    let rgb = parse_hex_rgb(&bg).ok_or_else(|| format!("bad chrome colour {bg:?}"))?;
    *CHROME_BG.lock().unwrap_or_else(|p| p.into_inner()) = Some(rgb);
    if let Some(win) = get_window(&app) {
        apply_chrome(&win);
    }
    Ok(())
}

/// Sentinel that fronts every reply written into `document.title`. Uses an
/// invisible separator (U+2063) so it can never collide with real page titles.
const SENTINEL: &str = "\u{2063}OWLLM\u{2063}";

/// Monotonic request id so a stale title from a previous action is never
/// mistaken for the current reply.
static REQ: AtomicU64 = AtomicU64::new(1);

/// Agent DOM actions are serialized at the native-engine boundary. Each action
/// captures its target Webview before waiting, so the user can switch/navigate
/// a different tab without redirecting the in-flight command. The command runs
/// on Tauri's async worker pool, so waiting never occupies the UI event thread.
static BROWSER_OPERATION: Mutex<()> = Mutex::new(());

fn lock_browser_operation() -> std::sync::MutexGuard<'static, ()> {
    BROWSER_OPERATION.lock().unwrap_or_else(|p| p.into_inner())
}

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
    Some((
        id.parse().ok()?,
        k.parse().ok()?,
        total.parse().ok()?,
        payload,
    ))
}

/// Called by the title-changed handler for every title the page sets.
fn capture_reply(title: &str) {
    let Some((id, k, total, payload)) = parse_reply(title) else {
        return;
    };
    // This runs in WebView2/WKWebView/WebKitGTK's native callback. It must
    // never wait for a Rust worker holding REPLIES: a missed title is harmless
    // because eval_until_reply re-emits/retries it, while a blocked callback
    // freezes every OwLLM window sharing the event thread.
    let mut guard = match REPLIES.try_lock() {
        Ok(guard) => guard,
        Err(TryLockError::Poisoned(p)) => p.into_inner(),
        Err(TryLockError::WouldBlock) => return,
    };
    let map = guard.get_or_insert_with(HashMap::new);
    let acc = map.entry(id).or_insert_with(|| ReplyAcc {
        total,
        chunks: Default::default(),
    });
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
    active_tab_id: Option<u64>,
    tabs: Vec<BrowserTabInfo>,
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
  // The reply channel briefly parks a sentinel in document.title (restored after
  // 60ms). A title READ that lands inside that window would capture the encoded
  // reply — so page-title readouts fall back to the last real title instead.
  function realTitle() {
    return document.title.indexOf(SENT) === 0 ? (window.__owllmTitle0 || "") : document.title;
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
    var lines = ["URL: " + location.href, "TITLE: " + realTitle(), "",
                 "INTERACTIVE ELEMENTS (act on these by index):"];
    for (var i = 0; i < els.length; i++) lines.push("[" + i + "] " + label(els[i]));
    return lines.join("\n");
  }
  function elAt(i) { var e = (window.__owllmEls || [])[i]; if (!e) throw new Error("no element at index " + i); return e; }
  function fire(el, type) { el.dispatchEvent(new Event(type, { bubbles: true })); }
  // A bare el.click() dispatches ONLY a 'click' event — it skips the hover and
  // pointer/mouse-down events a real cursor emits. Menus that open on hover or
  // pointerdown (React/Radix/Headless language switchers, custom dropdowns)
  // therefore never open under automation even though a human mouse works.
  // Replay the full trusted-mouse sequence, ending in a SINGLE native click so a
  // toggle button can't open-then-close (no double click event).
  function realClick(el) {
    var r = el.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var base = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
    function pt(t, ex) { try { el.dispatchEvent(new PointerEvent(t, Object.assign({ pointerId: 1, pointerType: "mouse", isPrimary: true }, base, ex || {}))); } catch (e) {} }
    function ms(t, ex) { try { el.dispatchEvent(new MouseEvent(t, Object.assign({ button: 0 }, base, ex || {}))); } catch (e) {} }
    pt("pointerover"); ms("mouseover"); pt("pointerenter"); ms("mouseenter");
    pt("pointermove"); ms("mousemove");
    pt("pointerdown", { buttons: 1 }); ms("mousedown", { buttons: 1 });
    try { el.focus(); } catch (e) {}
    pt("pointerup"); ms("mouseup");
    try { el.click(); } catch (e) { ms("click"); }
  }
  window.__owllmRun = function (reqId, action, paramsJson) {
    var p = {};
    try { p = paramsJson ? JSON.parse(paramsJson) : {}; } catch (e) {}
    try {
      switch (action) {
        case "info":
          return report(reqId, JSON.stringify({ url: location.href, title: realTitle(), ready: document.readyState }));
        case "await_load":
          if (document.readyState === "complete" || document.readyState === "interactive") {
            return report(reqId, "Loaded: " + location.href + " — " + realTitle());
          }
          window.addEventListener("DOMContentLoaded", function () {
            report(reqId, "Loaded: " + location.href + " — " + realTitle());
          }, { once: true });
          return;
        case "snapshot": return report(reqId, snapshot());
        case "get_text": {
          var t = (document.body ? document.body.innerText : "") || "";
          return report(reqId, t.replace(/\n{3,}/g, "\n\n").trim());
        }
        case "click": {
          var el = elAt(p.index); el.scrollIntoView({ block: "center" });
          realClick(el);
          // 500ms lets a just-opened menu finish its enter animation before the
          // re-snapshot re-indexes it (the newly-rendered items are then caught
          // by the cursor:pointer pass in reindex()).
          return setTimeout(function () { report(reqId, "clicked [" + p.index + "] " + label(el) + "\n\n" + snapshot()); }, 500);
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
  // --- typed-login capture → OwLLM vault ---------------------------------
  // When the user submits a form with a filled password field (or leaves the
  // page with one still filled), report origin+username+password to Rust on
  // the EVT title channel; Rust upserts it into the encrypted browser vault
  // (browser_vault.rs) so the login autofills next time. Same transient
  // base64 title mechanics as every other message on this channel.
  var credSent = "";
  function grabCred() {
    var pws = document.querySelectorAll("input[type=password]");
    var pw = null;
    for (var i = 0; i < pws.length; i++) if (pws[i].value) { pw = pws[i]; break; }
    if (!pw) return null;
    var user = "";
    var ins = document.querySelectorAll("input");
    for (var j = 0; j < ins.length; j++) {
      if (ins[j] === pw) break;
      var ty = (ins[j].type || "text").toLowerCase();
      if ((ty === "text" || ty === "email" || ty === "tel") && ins[j].value) user = ins[j].value;
    }
    return { origin: location.origin, username: user, password: pw.value };
  }
  function reportCred() {
    var c = grabCred();
    if (!c) return;
    var key = c.origin + "" + c.username + "" + c.password;
    if (key === credSent) return; // same login already reported on this page
    credSent = key;
    if (document.title.indexOf(SENT) !== 0) window.__owllmTitle0 = document.title;
    document.title = SENT + "EVT" + Z + "cred" + Z + b64(JSON.stringify(c));
    setTimeout(function () { try { document.title = window.__owllmTitle0 || ""; } catch (e) {} }, 60);
  }
  document.addEventListener("submit", reportCred, true);
  window.addEventListener("pagehide", reportCred);
})();
"##;

/// Stable data directory so cookies/logins in the agent browser persist across
/// runs and are isolated from the app UI's own webview storage.
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
fn browser_data_dir() -> Option<std::path::PathBuf> {
    // A side-by-side Windows build receives its own WebView2 root before Tauri
    // starts (paths::init_isolated_webview_profile). Keep the agent-browser
    // child WebViews under that same isolated root too; otherwise their
    // explicit data_directory would silently reconnect the builds again.
    #[cfg(windows)]
    if let Some(root) = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER") {
        if !root.is_empty() {
            return Some(std::path::PathBuf::from(root).join("agent-browser"));
        }
    }
    crate::paths::user_data_root().map(|r| r.join("browser_profile"))
}

fn get_window(app: &tauri::AppHandle) -> Option<Window> {
    app.get_window(BROWSER_LABEL)
        .or_else(|| active_tab_id().and_then(|id| app.get_window(&tab_label(id))))
}

fn destroy_browser_windows(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_window(BROWSER_LABEL) {
        return window.destroy().map_err(|e| format!("close failed: {e}"));
    }
    let ids = TABS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(|tabs| tabs.order.clone())
        .unwrap_or_default();
    *TABS.lock().unwrap_or_else(|p| p.into_inner()) = None;
    for id in ids {
        if let Some(window) = app.get_window(&tab_label(id)) {
            window.destroy().map_err(|e| format!("close failed: {e}"))?;
        }
    }
    Ok(())
}

/// Resolve a specific framed tab, the active tab when no id is supplied, or
/// the selected top-level WebView of the Linux fallback. Capturing this handle once per
/// command prevents a later user tab switch from retargeting agent work.
fn content_webview_for_tab(app: &tauri::AppHandle, tab_id: Option<u64>) -> Option<Webview> {
    let resolved = tab_id.or_else(active_tab_id);
    if let Some(id) = resolved {
        if let Some(wv) = app.get_webview(&tab_label(id)) {
            return Some(wv);
        }
        if tab_id.is_some() {
            return None;
        }
    }
    app.get_webview(CONTENT_LABEL)
        .or_else(|| app.get_webview(BROWSER_LABEL))
}

fn content_webview(app: &tauri::AppHandle) -> Option<Webview> {
    content_webview_for_tab(app, None)
}

fn tab_id_from_params(params: &Value) -> Result<Option<u64>, String> {
    match params.get("tab_id") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(value)) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| "tab_id must be a positive integer".to_string()),
        Some(Value::String(value)) => value
            .trim()
            .parse::<u64>()
            .map(Some)
            .map_err(|_| format!("bad tab_id {value:?}")),
        Some(_) => Err("tab_id must be an integer".to_string()),
    }
}

fn list_tabs(app: &tauri::AppHandle) -> Vec<BrowserTabInfo> {
    let guard = TABS.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(tabs) = guard.as_ref() {
        return tabs
            .order
            .iter()
            .filter_map(|id| {
                app.get_webview(&tab_label(*id))
                    .map(|webview| BrowserTabInfo {
                        id: *id,
                        title: tabs.titles.get(id).cloned().unwrap_or_default(),
                        url: webview.url().map(|url| url.to_string()).unwrap_or_default(),
                        active: *id == tabs.active,
                    })
            })
            .collect();
    }
    app.get_webview(CONTENT_LABEL)
        .or_else(|| app.get_webview(BROWSER_LABEL))
        .map(|webview| BrowserTabInfo {
            id: 0,
            title: String::new(),
            url: webview.url().map(|url| url.to_string()).unwrap_or_default(),
            active: true,
        })
        .into_iter()
        .collect()
}

/// Native WebView callbacks run on the application's shared UI event thread on
/// Windows (WebView2), macOS (WKWebView), and Linux (WebKitGTK). Calling any
/// other Window/Webview method from inside one of those callbacks can re-enter
/// the engine and deadlock that one thread, freezing the main app, overlay, and
/// browser together. Keep callbacks enqueue-only; this worker performs every
/// cross-window operation after the callback has returned to the event loop.
#[derive(Debug)]
enum BrowserUiEvent {
    ChromeAction {
        action: String,
        data: String,
    },
    ChromeUpdate {
        url: Option<String>,
        title: Option<String>,
    },
    Layout {
        width: u32,
        height: u32,
    },
    /// A tab's document title changed (multi-tab shape): store it, refresh the
    /// chrome bar if that tab is active, re-push the strip — all off-callback.
    TabTitle {
        id: u64,
        title: String,
    },
    /// Re-push the live tab list into the chrome strip (chrome page load).
    PushTabs,
    /// Typed-login capture from BRIDGE_JS. Vault I/O must stay off the native
    /// callback thread just like window work.
    TypedLogin {
        data: String,
    },
    /// A page requested a separate browsing context (`target=_blank` or
    /// `window.open`). The native callback denies the engine-owned popup and
    /// queues this event so the URL becomes a managed OwLLM tab instead.
    OpenTab {
        url: String,
        activate: bool,
    },
    LegacyTabClosed {
        id: u64,
    },
}

#[derive(Default)]
struct BrowserUiBatch {
    actions: Vec<(String, String)>,
    url: Option<String>,
    title: Option<String>,
    layout: Option<(u32, u32)>,
    tab_titles: HashMap<u64, String>,
    push_tabs: bool,
    creds: Vec<String>,
    open_tabs: Vec<(String, bool)>,
    legacy_closed: Vec<u64>,
}

impl BrowserUiBatch {
    fn absorb(&mut self, event: BrowserUiEvent) {
        match event {
            BrowserUiEvent::ChromeAction { action, data } => self.actions.push((action, data)),
            BrowserUiEvent::ChromeUpdate { url, title } => {
                if url.is_some() {
                    self.url = url;
                }
                if title.is_some() {
                    self.title = title;
                }
            }
            BrowserUiEvent::Layout { width, height } => self.layout = Some((width, height)),
            BrowserUiEvent::TabTitle { id, title } => {
                self.tab_titles.insert(id, title);
            }
            BrowserUiEvent::PushTabs => self.push_tabs = true,
            BrowserUiEvent::TypedLogin { data } => self.creds.push(data),
            BrowserUiEvent::OpenTab { url, activate } => self.open_tabs.push((url, activate)),
            BrowserUiEvent::LegacyTabClosed { id } => self.legacy_closed.push(id),
        }
    }
}

static BROWSER_UI_TX: OnceLock<Option<mpsc::Sender<BrowserUiEvent>>> = OnceLock::new();

fn browser_ui_sender(app: &tauri::AppHandle) -> Option<&'static mpsc::Sender<BrowserUiEvent>> {
    BROWSER_UI_TX
        .get_or_init(|| {
            let (tx, rx) = mpsc::channel();
            let app = app.clone();
            match thread::Builder::new()
                .name("owllm-browser-ui-dispatch".to_string())
                .spawn(move || browser_ui_worker(app, rx))
            {
                Ok(_) => Some(tx),
                Err(e) => {
                    eprintln!("[browser] could not start UI dispatcher: {e}");
                    None
                }
            }
        })
        .as_ref()
}

fn queue_browser_ui(app: &tauri::AppHandle, event: BrowserUiEvent) {
    if let Some(sender) = browser_ui_sender(app) {
        let _ = sender.send(event);
    }
}

fn browser_ui_worker(app: tauri::AppHandle, rx: mpsc::Receiver<BrowserUiEvent>) {
    while let Ok(first) = rx.recv() {
        let mut batch = BrowserUiBatch::default();
        batch.absorb(first);
        // Resize and title events arrive in bursts. Keep every user action but
        // collapse presentation work to the newest values before dispatching
        // back through Tauri, avoiding an unbounded main-thread queue.
        for event in rx.try_iter() {
            batch.absorb(event);
        }
        for (action, data) in batch.actions {
            handle_chrome_event(&app, &action, &data);
        }
        for data in batch.creds {
            if let Err(e) = crate::browser_vault::store_typed_login(&data) {
                eprintln!("[browser] could not save typed login: {e}");
            }
        }
        for (url, activate) in batch.open_tabs {
            if let Err(e) = new_tab(&app, &url, activate) {
                eprintln!("[browser] requested tab failed: {e}");
            }
        }
        for id in batch.legacy_closed {
            on_legacy_tab_closed(&app, id);
        }
        if let Some((width, height)) = batch.layout {
            layout_children(&app, tauri::PhysicalSize::new(width, height));
        }
        for (id, title) in batch.tab_titles {
            on_tab_title(&app, id, &title);
        }
        if batch.push_tabs {
            push_tabs(&app);
        }
        if batch.url.is_some() || batch.title.is_some() {
            update_chrome_bar(&app, batch.url.as_deref(), batch.title.as_deref());
        }
    }
}

/// Chrome-bar → Rust events, carried on the same title channel as page
/// replies but tagged EVT: SENTINEL + "EVT" + U+2063 + action + U+2063 + b64(data).
fn parse_chrome_event(title: &str) -> Option<(String, String)> {
    let rest = title.strip_prefix(SENTINEL)?;
    let (tag, rest) = rest.split_once('\u{2063}')?;
    if tag != "EVT" {
        return None;
    }
    let (action, b64) = rest.split_once('\u{2063}')?;
    Some((action.to_string(), decode_b64(b64)))
}

/// Act on a chrome-bar event (window buttons / drag / URL entry). Always called
/// by `browser_ui_worker`, never directly by a native WebView callback.
fn handle_chrome_event(app: &tauri::AppHandle, action: &str, data: &str) {
    let Some(win) = get_window(app) else { return };
    match action {
        "drag" => {
            let _ = win.start_dragging();
        }
        "minimize" => {
            let _ = win.minimize();
        }
        "maximize" => {
            if win.is_maximized().unwrap_or(false) {
                let _ = win.unmaximize();
            } else {
                let _ = win.maximize();
            }
        }
        "close" => {
            let _ = win.destroy();
        }
        "back" => {
            if let Some(wv) = content_webview(app) {
                let _ = wv.eval("history.back()");
            }
        }
        "reload" => {
            if let Some(wv) = content_webview(app) {
                let _ = wv.eval("location.reload()");
            }
        }
        "nav" => {
            let app = app.clone();
            let url = data.to_string();
            std::thread::spawn(move || {
                let _ = browser_cmd(app, "navigate".to_string(), json!({ "url": url }));
            });
        }
        // Tab strip events. All spawned off the title-changed callback (same
        // reason as "nav": webview creation/teardown must never block the
        // callback or the main event loop).
        "tabnew" => {
            let app = app.clone();
            std::thread::spawn(move || {
                if let Err(e) = new_tab(&app, "about:blank", true) {
                    eprintln!("[browser] new tab failed: {e}");
                }
            });
        }
        "tabsel" => {
            if let Ok(id) = data.trim().parse::<u64>() {
                let app = app.clone();
                std::thread::spawn(move || activate_tab(&app, id));
            }
        }
        "tabclose" => {
            if let Ok(id) = data.trim().parse::<u64>() {
                let app = app.clone();
                std::thread::spawn(move || close_tab(&app, id));
            }
        }
        _ => {}
    }
}

/// Build + attach one content (page) webview as a new tab. Active tabs sit
/// under the chrome bar; inactive ones are parked offscreen. All tabs share
/// the same profile data dir, so logins/cookies span tabs.
fn attach_tab(
    app: &tauri::AppHandle,
    win: &Window,
    url: tauri::Url,
    id: u64,
    active: bool,
) -> Result<(), String> {
    let dev = current_device();
    let new_window_app = app.clone();
    #[allow(unused_mut)]
    let mut content = WebviewBuilder::new(tab_label(id), WebviewUrl::External(url))
        .initialization_script(BRIDGE_JS)
        .on_new_window(move |url, _features| {
            // Never let WebView2/WKWebView/WebKitGTK create an unmanaged popup.
            // Queue it as a normal OwLLM tab after this native callback returns.
            queue_browser_ui(
                &new_window_app,
                BrowserUiEvent::OpenTab {
                    url: url.to_string(),
                    activate: true,
                },
            );
            NewWindowResponse::Deny
        })
        // Dark OwLLM base so the blank / loading webview is OwLLM's surface,
        // not the bare white "window colour" a fresh webview shows.
        .background_color(OWLLM_BG)
        .on_document_title_changed(move |wv, title| {
            // Typed-login capture rides the EVT channel from BRIDGE_JS. The
            // vault write is queued — no I/O on the native callback thread.
            if let Some((action, data)) = parse_chrome_event(&title) {
                if action == "cred" {
                    queue_browser_ui(
                        &wv.app_handle().clone(),
                        BrowserUiEvent::TypedLogin { data },
                    );
                }
                return;
            }
            capture_reply(&title);
            if !title.starts_with(SENTINEL) {
                queue_browser_ui(
                    &wv.app_handle().clone(),
                    BrowserUiEvent::TabTitle { id, title },
                );
            }
        })
        .on_page_load(move |wv, payload| {
            if is_active_tab(id) {
                queue_browser_ui(
                    &wv.app_handle().clone(),
                    BrowserUiEvent::ChromeUpdate {
                        url: Some(payload.url().to_string()),
                        title: None,
                    },
                );
            }
        });
    if let Some(ua) = dev.ua {
        content = content.user_agent(ua);
    }
    // A stable, isolated data dir so agent-browser logins persist across runs.
    // The builder method is only present on Windows/Linux; macOS WKWebView uses
    // the app's default per-app store (logins still persist there).
    #[cfg(any(windows, target_os = "linux"))]
    if let Some(dir) = browser_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        content = content.data_directory(dir);
    }
    let scale = win.scale_factor().unwrap_or(1.0);
    let ls = win
        .inner_size()
        .map(|s| s.to_logical::<f64>(scale))
        .unwrap_or_else(|_| LogicalSize::new(dev.width, dev.height + CHROME_H));
    let x = if active { 0.0 } else { PARK_X };
    win.add_child(
        content,
        LogicalPosition::new(x, CHROME_H),
        LogicalSize::new(ls.width, (ls.height - CHROME_H).max(50.0)),
    )
    .map_err(|e| format!("page webview: {e}"))?;
    Ok(())
}

/// Open a fresh tab and optionally make it active. Agent-created tabs default
/// to background; user/new-window requests select their new tab.
fn new_tab(app: &tauri::AppHandle, url: &str, activate: bool) -> Result<u64, String> {
    let framed = app.get_webview(CHROME_LABEL).is_some();
    let win = framed.then(|| get_window(app)).flatten();
    if TABS.lock().unwrap_or_else(|p| p.into_inner()).is_none() {
        return Err("browser has no tab session".to_string());
    }
    let parsed: tauri::Url = url.parse().map_err(|e| format!("bad url {url:?}: {e}"))?;
    let id = NEXT_TAB.fetch_add(1, Ordering::SeqCst);
    let mut previous_active = None;
    {
        let mut guard = TABS.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(tabs) = guard.as_mut() {
            previous_active = Some(tabs.active);
            tabs.order.push(id);
            if activate {
                tabs.active = id;
            }
        }
    }
    let attached = if let Some(win) = win.as_ref() {
        attach_tab(app, win, parsed, id, activate)
    } else {
        attach_legacy_tab(app, parsed, id, activate)
    };
    if let Err(error) = attached {
        let mut guard = TABS.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(tabs) = guard.as_mut() {
            tabs.order.retain(|tab| *tab != id);
            tabs.titles.remove(&id);
            if tabs.active == id {
                if let Some(previous) = previous_active {
                    tabs.active = previous;
                }
            }
        }
        return Err(error);
    }
    // Relayout parks the previously active tab and seats the new one.
    if let Some(win) = win {
        if let Ok(size) = win.inner_size() {
            layout_children(app, size);
        }
    } else if activate {
        activate_tab(app, id);
    }
    if activate {
        update_chrome_bar(app, Some(""), Some(""));
    }
    push_tabs(app);
    Ok(id)
}

/// Bring `id` into view, park the rest, sync the URL bar + tab strip.
fn activate_tab(app: &tauri::AppHandle, id: u64) {
    let order = {
        let mut guard = TABS.lock().unwrap_or_else(|p| p.into_inner());
        let Some(tabs) = guard.as_mut() else { return };
        if !tabs.order.contains(&id) {
            return;
        }
        tabs.active = id;
        tabs.order.clone()
    };
    if app.get_webview(CHROME_LABEL).is_some() {
        let Some(win) = get_window(app) else { return };
        if let Ok(size) = win.inner_size() {
            layout_children(app, size);
        }
    } else {
        // Linux's WebKitGTK safety shape uses one top-level WebView per tab
        // because stacked child views crash on some Jetson/Tegra drivers.
        // Keep exactly one visible so it behaves as a tabbed surface while
        // every hidden window preserves its own DOM + navigation history.
        for tab in order {
            if let Some(win) = app.get_window(&tab_label(tab)) {
                if tab == id {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                } else {
                    let _ = win.hide();
                }
            }
        }
    }
    let url = app
        .get_webview(&tab_label(id))
        .and_then(|wv| wv.url().ok())
        .map(|u| u.to_string())
        .unwrap_or_default();
    let title = TABS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .and_then(|t| t.titles.get(&id).cloned())
        .unwrap_or_default();
    update_chrome_bar(app, Some(&url), Some(&title));
    push_tabs(app);
}

/// Close one tab; closing the last tab closes the whole window.
fn close_tab(app: &tauri::AppHandle, id: u64) {
    let target_window = app
        .get_window(BROWSER_LABEL)
        .or_else(|| app.get_window(&tab_label(id)));
    let next = {
        let mut guard = TABS.lock().unwrap_or_else(|p| p.into_inner());
        let Some(tabs) = guard.as_mut() else { return };
        if !tabs.order.contains(&id) {
            return;
        }
        let Some(next) = next_active_after_close(&tabs.order, id, tabs.active) else {
            *guard = None;
            drop(guard);
            if let Some(win) = target_window {
                let _ = win.destroy();
            }
            return;
        };
        tabs.order.retain(|t| *t != id);
        tabs.titles.remove(&id);
        tabs.active = next;
        next
    };
    if app.get_webview(CHROME_LABEL).is_some() {
        if let Some(wv) = app.get_webview(&tab_label(id)) {
            let _ = wv.close();
        }
    } else if let Some(window) = app.get_window(&tab_label(id)) {
        let _ = window.destroy();
    }
    activate_tab(app, next);
}

fn on_legacy_tab_closed(app: &tauri::AppHandle, id: u64) {
    let next = {
        let mut guard = TABS.lock().unwrap_or_else(|p| p.into_inner());
        let Some(tabs) = guard.as_mut() else { return };
        if !tabs.order.contains(&id) {
            return;
        }
        tabs.order.retain(|tab| *tab != id);
        tabs.titles.remove(&id);
        if tabs.order.is_empty() {
            *guard = None;
            return;
        }
        if tabs.active == id {
            tabs.active = tabs.order[0];
        }
        tabs.active
    };
    activate_tab(app, next);
}

/// A tab's page set a real title: remember it for the strip, forward the
/// active tab's to the chrome bar, and refresh the tab pills.
fn on_tab_title(app: &tauri::AppHandle, id: u64, title: &str) {
    {
        let mut guard = TABS.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(tabs) = guard.as_mut() {
            tabs.titles.insert(id, title.to_string());
        }
    }
    if is_active_tab(id) {
        let url = app
            .get_webview(&tab_label(id))
            .and_then(|wv| wv.url().ok())
            .map(|u| u.to_string())
            .unwrap_or_default();
        update_chrome_bar(app, Some(&url), Some(title));
    }
    push_tabs(app);
}

/// Push the live tab list into the chrome bar's tab strip.
fn push_tabs(app: &tauri::AppHandle) {
    let Some(chrome) = app.get_webview(CHROME_LABEL) else {
        return;
    };
    let json = {
        let guard = TABS.lock().unwrap_or_else(|p| p.into_inner());
        let Some(tabs) = guard.as_ref() else { return };
        let list: Vec<Value> = tabs
            .order
            .iter()
            .map(|id| {
                json!({
                    "id": id,
                    "title": tabs.titles.get(id).cloned().unwrap_or_default(),
                    "active": *id == tabs.active,
                })
            })
            .collect();
        Value::Array(list).to_string()
    };
    let _ = chrome.eval(&format!(
        "try{{window.__owllmTabsSet&&window.__owllmTabsSet({})}}catch(e){{}}",
        serde_json::to_string(&json).unwrap_or_else(|_| "\"[]\"".into())
    ));
}

/// Push the page's live url/title into the chrome bar (best-effort).
fn update_chrome_bar(app: &tauri::AppHandle, url: Option<&str>, title: Option<&str>) {
    let Some(chrome) = app.get_webview(CHROME_LABEL) else {
        return;
    };
    let info = json!({ "url": url, "title": title });
    let _ = chrome.eval(&format!(
        "try{{window.__owllmChromeSet&&window.__owllmChromeSet({})}}catch(e){{}}",
        serde_json::to_string(&info.to_string()).unwrap_or_else(|_| "\"{}\"".into())
    ));
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
    let bare = host
        .strip_prefix('[')
        .map(|h| h.split(']').next().unwrap_or(h));
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
///
/// Preferred shape: a FRAMELESS window that looks like OwLLM — our own chrome
/// bar (browser-chrome.html, an app-origin webview) on top, the page webview
/// below it, so no stock OS title bar and nothing ever overlays site content.
/// If the multi-webview build fails on some platform/engine, fall back to the
/// decorated top-level-WebView tab shape so agent browsing never breaks.
fn build_window(app: &tauri::AppHandle, url: tauri::Url) -> Result<(), String> {
    // Linux/WebKitGTK — notably the Jetson/Tegra GL stack — mislays stacked child
    // webviews (the chrome bar ends up floating mid-window over a blank strip) and
    // SIGBUSes the WebKitWebProcess when they are resized, taking the whole app
    // down. The framed multi-webview shape build_framed() builds is therefore
    // unusable there, and it "succeeds" without erroring so the runtime fallback
    // below never triggers. Use independent decorated top-level tab WebViews on
    // Linux; keep the OwLLM-chrome framed shape on Windows/macOS where it works.
    #[cfg(target_os = "linux")]
    {
        build_legacy(app, url)
    }
    #[cfg(not(target_os = "linux"))]
    {
        match build_framed(app, url.clone()) {
            Ok(()) => Ok(()),
            Err(e) => {
                eprintln!("[browser] app-styled window failed ({e}); using the decorated fallback");
                if let Some(w) = get_window(app) {
                    let _ = w.destroy();
                }
                build_legacy(app, url)
            }
        }
    }
}

/// The app-styled browser: frameless Window + chrome-bar webview + page webview.
/// Windows/macOS only — build_window() routes Linux to build_legacy() because
/// stacked child webviews are broken on WebKitGTK/Jetson (see build_window).
#[cfg_attr(target_os = "linux", allow(dead_code))]
fn build_framed(app: &tauri::AppHandle, url: tauri::Url) -> Result<(), String> {
    // Start the dispatcher before adding child webviews so even their very
    // first load/title callback performs only a cheap channel send.
    let _ = browser_ui_sender(app);
    let dev = current_device();
    let start_url = url.to_string();
    let win_w = dev.width;
    let win_h = dev.height + CHROME_H;
    let mut builder = Window::builder(app, BROWSER_LABEL)
        .title("OwLLM — Agent Browser")
        .inner_size(win_w, win_h)
        // No OS chrome: the bar below IS the chrome. shadow(true) keeps the
        // drop shadow + resize borders on undecorated Windows windows.
        .decorations(false)
        .shadow(true)
        .theme(Some(tauri::Theme::Dark))
        .resizable(true)
        .visible(true);
    // Centre it on the primary monitor (the "open 300px up" spec applies to the
    // in-app Agent Browser *panel*, not this native window — user spec 2026-07-05).
    if let Ok(Some(m)) = app.primary_monitor() {
        let ls = m.size().to_logical::<f64>(m.scale_factor());
        let x = ((ls.width - win_w) / 2.0).max(0.0);
        let y = ((ls.height - win_h) / 2.0).max(12.0);
        builder = builder.position(x, y);
    }
    let win = builder
        .build()
        .map_err(|e| format!("browser window: {e}"))?;

    // Chrome bar — app origin (shares the UI's localStorage theme). Its
    // buttons/drag/URL box/tab strip report through the same title channel the
    // page bridge uses; no IPC grant to any webview is needed.
    let chrome = WebviewBuilder::new(CHROME_LABEL, WebviewUrl::App("browser-chrome.html".into()))
        .background_color(OWLLM_BG)
        .on_document_title_changed(|wv, title| {
            if let Some((action, data)) = parse_chrome_event(&title) {
                queue_browser_ui(
                    &wv.app_handle().clone(),
                    BrowserUiEvent::ChromeAction { action, data },
                );
            }
        })
        // The strip renders from Rust pushes — seed it once the bar exists.
        .on_page_load(|wv, _payload| {
            queue_browser_ui(&wv.app_handle().clone(), BrowserUiEvent::PushTabs);
        });
    win.add_child(
        chrome,
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(win_w, CHROME_H),
    )
    .map_err(|e| format!("chrome bar webview: {e}"))?;

    // First tab. Further tabs come from the chrome bar's "+" (tabnew event).
    let first = NEXT_TAB.fetch_add(1, Ordering::SeqCst);
    *TABS.lock().unwrap_or_else(|p| p.into_inner()) = Some(Tabs {
        order: vec![first],
        active: first,
        titles: HashMap::new(),
    });
    attach_tab(app, &win, url, first, true)?;

    // Keep the children glued to the window on resize/maximize, and drop the
    // tab state when the window goes away (✕, browser_stop, device rebuild).
    // Resize work is QUEUED — layout_children does set_position/set_size,
    // which must never run inside a native window callback (UI-thread gate).
    let handle = app.clone();
    win.on_window_event(move |ev| {
        match ev {
            WindowEvent::Resized(size) => queue_browser_ui(
                &handle,
                BrowserUiEvent::Layout {
                    width: size.width,
                    height: size.height,
                },
            ),
            WindowEvent::Destroyed => {
                // Pure state drop — no window/webview work.
                *TABS.lock().unwrap_or_else(|p| p.into_inner()) = None;
            }
            _ => {}
        }
    });

    apply_chrome(&win);
    update_chrome_bar(app, Some(&start_url), None);
    push_tabs(app);
    Ok(())
}

/// Re-fit the chrome bar + page webviews to a new window size. The active
/// tab is seated under the chrome bar; the rest stay parked offscreen.
fn layout_children(app: &tauri::AppHandle, size: tauri::PhysicalSize<u32>) {
    let Some(win) = get_window(app) else { return };
    let scale = win.scale_factor().unwrap_or(1.0);
    let ls = size.to_logical::<f64>(scale);
    if let Some(chrome) = app.get_webview(CHROME_LABEL) {
        let _ = chrome.set_position(LogicalPosition::new(0.0, 0.0));
        let _ = chrome.set_size(LogicalSize::new(ls.width, CHROME_H));
    }
    let page = LogicalSize::new(ls.width, (ls.height - CHROME_H).max(50.0));
    let (order, active) = {
        let guard = TABS.lock().unwrap_or_else(|p| p.into_inner());
        match guard.as_ref() {
            Some(t) => (t.order.clone(), t.active),
            None => (Vec::new(), 0),
        }
    };
    for id in order {
        if let Some(content) = app.get_webview(&tab_label(id)) {
            let x = if id == active { 0.0 } else { PARK_X };
            let _ = content.set_position(LogicalPosition::new(x, CHROME_H));
            let _ = content.set_size(page);
        }
    }
    // Legacy single-webview shape (no tab state).
    if let Some(content) = app.get_webview(CONTENT_LABEL) {
        let _ = content.set_position(LogicalPosition::new(0.0, CHROME_H));
        let _ = content.set_size(page);
    }
}

/// Safe decorated top-level-WebView tab shape used by Linux/WebKitGTK.
fn build_legacy(app: &tauri::AppHandle, url: tauri::Url) -> Result<(), String> {
    let first = NEXT_TAB.fetch_add(1, Ordering::SeqCst);
    *TABS.lock().unwrap_or_else(|p| p.into_inner()) = Some(Tabs {
        order: vec![first],
        active: first,
        titles: HashMap::new(),
    });
    if let Err(error) = attach_legacy_tab(app, url, first, true) {
        *TABS.lock().unwrap_or_else(|p| p.into_inner()) = None;
        return Err(error);
    }
    Ok(())
}

/// WebKitGTK safety shape: each tab is a separate decorated top-level WebView.
/// Only the active one is visible; BrowserPanel supplies the shared tab strip.
/// This preserves true per-tab DOM/history without the stacked-child SIGBUS
/// seen on Jetson/Tegra.
fn attach_legacy_tab(
    app: &tauri::AppHandle,
    url: tauri::Url,
    id: u64,
    active: bool,
) -> Result<(), String> {
    let dev = current_device();
    let new_window_app = app.clone();
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, tab_label(id), WebviewUrl::External(url))
        .title("OwLLM — Agent Browser")
        .inner_size(dev.width, dev.height)
        .initialization_script(BRIDGE_JS)
        .on_new_window(move |url, _features| {
            queue_browser_ui(
                &new_window_app,
                BrowserUiEvent::OpenTab {
                    url: url.to_string(),
                    activate: true,
                },
            );
            NewWindowResponse::Deny
        })
        .on_document_title_changed(move |win, title| {
            // Typed-login capture works in this shape too (same EVT channel);
            // the vault write is queued off the native callback thread.
            if let Some((action, data)) = parse_chrome_event(&title) {
                if action == "cred" {
                    queue_browser_ui(
                        &win.app_handle().clone(),
                        BrowserUiEvent::TypedLogin { data },
                    );
                }
                return;
            }
            capture_reply(&title);
            if !title.starts_with(SENTINEL) {
                queue_browser_ui(
                    &win.app_handle().clone(),
                    BrowserUiEvent::TabTitle { id, title },
                );
            }
        })
        .background_color(OWLLM_BG)
        .theme(Some(tauri::Theme::Dark))
        .decorations(true)
        .resizable(true)
        .visible(active);
    if let Some(ua) = dev.ua {
        builder = builder.user_agent(ua);
    }
    if let Ok(Some(m)) = app.primary_monitor() {
        let ls = m.size().to_logical::<f64>(m.scale_factor());
        let x = ((ls.width - dev.width) / 2.0).max(0.0);
        let y = ((ls.height - dev.height) / 2.0).max(12.0);
        builder = builder.position(x, y);
    }
    #[cfg(any(windows, target_os = "linux"))]
    if let Some(dir) = browser_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        builder = builder.data_directory(dir);
    }
    builder
        .build()
        .map_err(|e| format!("failed to open agent browser window: {e}"))?;
    if let Some(win) = app.get_window(&tab_label(id)) {
        apply_chrome(&win);
        let handle = app.clone();
        win.on_window_event(move |event| {
            if matches!(event, WindowEvent::Destroyed) {
                queue_browser_ui(&handle, BrowserUiEvent::LegacyTabClosed { id });
            }
        });
    }
    Ok(())
}

/// Create the agent-browser window if it isn't already open. Idempotent.
#[tauri::command(async)]
pub fn browser_start(app: tauri::AppHandle) -> Result<String, String> {
    let _operation = lock_browser_operation();
    browser_start_inner(&app)
}

fn browser_start_inner(app: &tauri::AppHandle) -> Result<String, String> {
    if get_window(&app).is_some() {
        return Ok("browser already running".to_string());
    }
    let start_url = "about:blank"
        .parse()
        .map_err(|e| format!("bad start url: {e}"))?;
    build_window(app, start_url)?;
    Ok("browser started".to_string())
}

/// Open an http(s) URL in OwLLM's persistent browser window.
///
/// This is the single entry point for user-facing web links throughout the
/// desktop app. It deliberately does not wait for the page bridge: buttons
/// such as "Get a token" must return immediately even when the destination is
/// a slow login page. Agent browser tools continue to use `browser_cmd`, which
/// waits for the document because they need to interact with its contents.
fn parse_web_url(raw_url: &str) -> Result<tauri::Url, String> {
    let url = raw_url.trim();
    if url.is_empty() {
        return Err("web url is empty".to_string());
    }
    let parsed: tauri::Url = url
        .parse()
        .map_err(|e| format!("bad web url {url:?}: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http(s) urls can open in the OwLLM browser".to_string());
    }
    Ok(parsed)
}

pub(crate) fn open_web_url(app: &tauri::AppHandle, raw_url: &str) -> Result<String, String> {
    let url = raw_url.trim();
    let parsed = parse_web_url(url)?;

    let _operation = lock_browser_operation();
    let tab_id = if get_window(app).is_none() {
        build_window(app, parsed)?;
        active_tab_id()
    } else if TABS.lock().unwrap_or_else(|p| p.into_inner()).is_some() {
        Some(new_tab(app, parsed.as_str(), true)?)
    } else {
        content_webview(app)
            .ok_or_else(|| "OwLLM browser page is unavailable".to_string())?
            .navigate(parsed)
            .map_err(|e| format!("navigate failed: {e}"))?;
        None
    };
    if let Some(win) = get_window(app) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
    Ok(match tab_id {
        Some(id) => format!("Opened {url} in OwLLM browser tab {id}"),
        None => format!("Opened {url} in the OwLLM browser"),
    })
}

fn parse_navigation_url(raw_url: &str) -> Result<tauri::Url, String> {
    let value = raw_url.trim();
    if value.is_empty() {
        return Err("navigate requires a url".to_string());
    }
    let full = if value.contains("://") || value == "about:blank" {
        value.to_string()
    } else if is_local_host(value) {
        format!("http://{value}")
    } else {
        format!("https://{value}")
    };
    full.parse().map_err(|e| format!("bad url {full:?}: {e}"))
}

#[tauri::command(async)]
pub fn browser_open_url(app: tauri::AppHandle, url: String) -> Result<String, String> {
    open_web_url(&app, &url)
}

/// Agent-facing tab creation. When a browser already exists, the new page is
/// backgrounded by default so an agent cannot steal the tab the user is
/// reading. The returned id addresses every subsequent browser_* operation.
#[tauri::command(async)]
pub fn browser_open_tab(
    app: tauri::AppHandle,
    url: String,
    activate: Option<bool>,
) -> Result<String, String> {
    let _operation = lock_browser_operation();
    let parsed = parse_navigation_url(&url)?;
    let activate = activate.unwrap_or(false);
    let id = if get_window(&app).is_none() {
        build_window(&app, parsed)?;
        active_tab_id().unwrap_or(0)
    } else if TABS.lock().unwrap_or_else(|p| p.into_inner()).is_some() {
        new_tab(&app, parsed.as_str(), activate)?
    } else {
        // Compatibility fallback for a browser window created by an older
        // single-page build. New framed and Linux-safe sessions both own TABS.
        content_webview(&app)
            .ok_or_else(|| "OwLLM browser page is unavailable".to_string())?
            .navigate(parsed)
            .map_err(|e| format!("navigate failed: {e}"))?;
        0
    };
    Ok(
        json!({ "tab_id": id, "url": url, "active": id == active_tab_id().unwrap_or(0) })
            .to_string(),
    )
}

#[tauri::command(async)]
pub fn browser_list_tabs(app: tauri::AppHandle) -> Result<String, String> {
    Ok(serde_json::to_string(&list_tabs(&app)).map_err(|e| e.to_string())?)
}

#[tauri::command(async)]
pub fn browser_select_tab(app: tauri::AppHandle, tab_id: u64) -> Result<String, String> {
    let _operation = lock_browser_operation();
    if !list_tabs(&app).iter().any(|tab| tab.id == tab_id) {
        return Err(format!("browser tab {tab_id} does not exist"));
    }
    if tab_id != 0 {
        activate_tab(&app, tab_id);
    }
    Ok(format!("selected browser tab {tab_id}"))
}

#[tauri::command(async)]
pub fn browser_close_tab(app: tauri::AppHandle, tab_id: u64) -> Result<String, String> {
    let _operation = lock_browser_operation();
    if !list_tabs(&app).iter().any(|tab| tab.id == tab_id) {
        return Err(format!("browser tab {tab_id} does not exist"));
    }
    if tab_id == 0 {
        return browser_stop(app);
    }
    close_tab(&app, tab_id);
    Ok(format!("closed browser tab {tab_id}"))
}

/// Switch device emulation (desktop / iphone / android / tablet). The UA can
/// only be set at build time, so if the window is open we rebuild it in place
/// and re-navigate to the page it was on. Logins survive (stable profile dir).
/// A rebuild reloads every tab under the new engine profile. Native back/forward
/// history resets, but background pages remain open and independently addressable.
#[tauri::command(async)]
pub fn browser_set_device(app: tauri::AppHandle, device: String) -> Result<String, String> {
    let _operation = lock_browser_operation();
    let dev = device_by_name(&device).ok_or_else(|| {
        format!("unknown device {device:?} — use desktop, iphone, android or tablet")
    })?;
    *CURRENT_DEVICE.lock().unwrap_or_else(|p| p.into_inner()) = dev.name;

    let Some(_win) = get_window(&app) else {
        return Ok(format!(
            "device set to {} (applies when the browser opens)",
            dev.name
        ));
    };
    // Remember every tab, tear down, rebuild with the new UA + viewport. Native
    // engine rebuilds reset history, but no background page is silently lost.
    let tabs_before = list_tabs(&app);
    let back_to = content_webview(&app)
        .and_then(|wv| wv.url().ok())
        .map(|u| u.to_string())
        .unwrap_or_default();
    destroy_browser_windows(&app).map_err(|e| format!("could not rebuild browser window: {e}"))?;
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
    for tab in tabs_before.iter().filter(|tab| !tab.active) {
        let restore_url = if tab.url.is_empty() {
            "about:blank"
        } else {
            &tab.url
        };
        if let Err(error) = new_tab(&app, restore_url, false) {
            eprintln!(
                "[browser] could not restore tab {} after device switch: {error}",
                tab.id
            );
        }
    }
    Ok(format!(
        "device set to {} ({}×{}{}) — reloaded {}",
        dev.name,
        dev.width as u32,
        dev.height as u32,
        if dev.ua.is_some() {
            ", mobile user-agent"
        } else {
            ""
        },
        if url == "about:blank" {
            "blank page".to_string()
        } else {
            url
        }
    ))
}

/// Run one action against the live page and return its text reply.
///
/// `navigate` uses the native `webview.navigate()` (robust across origins),
/// then awaits the new document's load through the bridge. All other actions
/// eval __owllmRun directly. Read-back is via the sentinel title channel.
#[tauri::command(async)]
pub fn browser_cmd(app: tauri::AppHandle, action: String, params: Value) -> Result<String, String> {
    let _operation = lock_browser_operation();
    if get_window(&app).is_none() {
        browser_start_inner(&app)?;
    }
    let tab_id = tab_id_from_params(&params)?;
    let win = content_webview_for_tab(&app, tab_id).ok_or_else(|| match tab_id {
        Some(id) => format!("browser tab {id} does not exist"),
        None => "browser did not start".to_string(),
    })?;
    let req = REQ.fetch_add(1, Ordering::SeqCst);

    match action.as_str() {
        "navigate" | "open" => {
            let url_s = params
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let url = parse_navigation_url(&url_s)?;
            // Scheme-less URLs default to https — EXCEPT local dev servers
            // (localhost:5173, 127.0.0.1:3000, …), which are plain http.
            win.navigate(url)
                .map_err(|e| format!("navigate failed: {e}"))?;
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
    win: &Webview,
    req: u64,
    action: &str,
    params: &Value,
    timeout: Duration,
) -> Result<String, String> {
    let params_js =
        serde_json::to_string(&params.to_string()).unwrap_or_else(|_| "\"{}\"".to_string());
    let call = format!(
        "try{{window.__owllmRun&&window.__owllmRun({req},{action:?},{params_js})}}catch(e){{}}"
    );
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
        Some(_) => {
            // destroy() tears the window down unconditionally — close() asks
            // the page politely, and an unresponsive page could refuse.
            destroy_browser_windows(&app)?;
            Ok("browser stopped".to_string())
        }
        None => Ok("browser was not running".to_string()),
    }
}

/// Panel view: current URL + title as JSON (the window itself is the live view).
#[tauri::command(async)]
pub fn browser_view(app: tauri::AppHandle) -> Result<String, String> {
    let _operation = lock_browser_operation();
    let win = content_webview(&app).ok_or_else(|| "browser not running".to_string())?;
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
    fn chrome_hex_parses() {
        assert_eq!(parse_hex_rgb("#5865b8"), Some((0x58, 0x65, 0xb8)));
        assert_eq!(parse_hex_rgb("5865B8"), Some((0x58, 0x65, 0xb8)));
        assert_eq!(parse_hex_rgb(" #ffffff "), Some((255, 255, 255)));
        for bad in ["", "#fff", "#12345", "#1234567", "#gg0000", "€€"] {
            assert_eq!(parse_hex_rgb(bad), None, "{bad:?} should not parse");
        }
    }

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
        for u in [
            "github.com",
            "example.com/login",
            "127x.com",
            "myapp.io:443",
            "1270.0.0.1",
        ] {
            assert!(!is_local_host(u), "{u} should default to https");
        }
    }

    #[test]
    fn user_web_links_accept_http_and_reject_local_schemes() {
        assert_eq!(
            parse_web_url(" https://huggingface.co/settings/tokens ")
                .unwrap()
                .as_str(),
            "https://huggingface.co/settings/tokens"
        );
        assert!(parse_web_url("http://localhost:5173").is_ok());
        for bad in [
            "",
            "file:///tmp/model",
            "C:/models/model.gguf",
            "javascript:alert(1)",
        ] {
            assert!(
                parse_web_url(bad).is_err(),
                "{bad:?} must not open as web content"
            );
        }
    }

    #[test]
    fn reply_channel_round_trip() {
        use base64::Engine as _;
        let payload = base64::engine::general_purpose::STANDARD.encode("hello page");
        // A single-chunk reply (total=1) — exactly what report() writes for a
        // short payload: SENTINEL id Z 0 Z 1 Z b64.
        let title = format!("{SENTINEL}42\u{2063}0\u{2063}1\u{2063}{payload}");
        assert_eq!(
            parse_reply(&title),
            Some((42u64, 0u64, 1u64, payload.as_str()))
        );
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
    fn chrome_events_parse() {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode("github.com");
        let t = format!("{SENTINEL}EVT\u{2063}nav\u{2063}{b64}");
        assert_eq!(
            parse_chrome_event(&t),
            Some(("nav".to_string(), "github.com".to_string()))
        );
        let t2 = format!("{SENTINEL}EVT\u{2063}drag\u{2063}");
        assert_eq!(
            parse_chrome_event(&t2),
            Some(("drag".to_string(), String::new()))
        );
        // Page replies (numeric id) and ordinary titles are NOT chrome events —
        // and vice versa, an EVT title is not a page reply. Disjoint channels.
        let reply = format!("{SENTINEL}42\u{2063}0\u{2063}1\u{2063}aaaa");
        assert_eq!(parse_chrome_event(&reply), None);
        assert_eq!(parse_chrome_event("GitHub — where software is built"), None);
        assert_eq!(parse_reply(&t), None);
    }

    #[test]
    fn tab_close_picks_neighbor() {
        // Closing the ACTIVE tab activates the next one, else the previous.
        assert_eq!(next_active_after_close(&[1, 2, 3], 2, 2), Some(3));
        assert_eq!(next_active_after_close(&[1, 2, 3], 3, 3), Some(2));
        assert_eq!(next_active_after_close(&[1, 2, 3], 1, 1), Some(2));
        // Closing a BACKGROUND tab keeps the current active tab.
        assert_eq!(next_active_after_close(&[1, 2, 3], 1, 3), Some(3));
        // Closing the last tab → None (the window closes with it).
        assert_eq!(next_active_after_close(&[7], 7, 7), None);
    }

    #[test]
    fn tab_labels_are_stable_and_distinct() {
        assert_eq!(tab_label(1), "owllm-browser-page-1");
        assert_ne!(tab_label(1), tab_label(2));
        // The base content label stays reserved for the legacy fallback.
        assert!(tab_label(1).starts_with(CONTENT_LABEL));
        assert_ne!(tab_label(1), CONTENT_LABEL);
    }

    #[test]
    fn bridge_reports_typed_logins() {
        // The cred capture must ride the EVT channel with action "cred" so the
        // content webview's title handler routes it into the vault.
        assert!(BRIDGE_JS.contains("reportCred"));
        assert!(BRIDGE_JS.contains("input[type=password]"));
        assert!(BRIDGE_JS.contains("\"cred\""));
        assert!(BRIDGE_JS.contains("addEventListener(\"submit\", reportCred, true)"));
        assert!(BRIDGE_JS.contains("addEventListener(\"pagehide\", reportCred)"));
    }

    #[test]
    fn explicit_tab_ids_parse_without_falling_back_to_active() {
        assert_eq!(tab_id_from_params(&json!({})).unwrap(), None);
        assert_eq!(
            tab_id_from_params(&json!({ "tab_id": 42 })).unwrap(),
            Some(42)
        );
        assert_eq!(
            tab_id_from_params(&json!({ "tab_id": "7" })).unwrap(),
            Some(7)
        );
        assert!(tab_id_from_params(&json!({ "tab_id": "current" })).is_err());
    }

    #[test]
    fn queued_new_windows_remain_distinct_tabs() {
        let mut batch = BrowserUiBatch::default();
        batch.absorb(BrowserUiEvent::OpenTab {
            url: "https://one.example/".to_string(),
            activate: true,
        });
        batch.absorb(BrowserUiEvent::OpenTab {
            url: "https://two.example/".to_string(),
            activate: false,
        });
        assert_eq!(batch.open_tabs.len(), 2);
        assert_eq!(
            batch.open_tabs[0],
            ("https://one.example/".to_string(), true)
        );
        assert_eq!(
            batch.open_tabs[1],
            ("https://two.example/".to_string(), false)
        );
    }

    #[test]
    fn closing_one_tab_keeps_the_other_tab_active() {
        let order = vec![10, 20, 30];
        assert_eq!(next_active_after_close(&order, 20, 10), Some(10));
        assert_eq!(next_active_after_close(&order, 20, 20), Some(30));
        assert_eq!(next_active_after_close(&order, 30, 30), Some(20));
        assert_eq!(next_active_after_close(&[10], 10, 10), None);
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
        Some(_) => {
            let url = content_webview(&app)
                .and_then(|wv| wv.url().ok())
                .map(|u| u.to_string())
                .unwrap_or_default();
            Ok(BrowserStatus {
                running: true,
                url,
                device,
                active_tab_id: active_tab_id().or(Some(0)),
                tabs: list_tabs(&app),
            })
        }
        None => Ok(BrowserStatus {
            running: false,
            url: String::new(),
            device,
            active_tab_id: None,
            tabs: Vec::new(),
        }),
    }
}
