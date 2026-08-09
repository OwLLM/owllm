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

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock, TryLockError};
use std::thread;
use std::time::{Duration, Instant};
use tauri::webview::{Color, NewWindowResponse, Webview, WebviewBuilder};
use tauri::{
    Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder, Window,
    WindowEvent,
};

/// OwLLM dark base (matches the UI `--bg-panel` floor `#0e1117`), so the agent
/// browser's blank / loading state reads as OwLLM's own surface instead of the
/// bare white "window colour" a fresh webview shows (user spec 2026-07-05).
const OWLLM_BG: Color = Color(14, 17, 23, 255);

/// Local new-tab document, served from the OwLLM app origin exactly like the chrome
/// bar. It must NOT be a `data:` URL: Tauri refuses to build a webview for one
/// unless the `webview-data-url` feature is enabled, so a `data:` start page
/// made every "+" click fail to open a tab at all.
const BROWSER_HOME_PAGE: &str = "browser-home.html";

/// Label of the framed browser container on Windows/macOS. Linux labels each
/// top-level tab with `tab_label(id)` instead.
const BROWSER_LABEL: &str = "owllm-browser";

/// Child-webview labels of the framed (app-styled) browser window: an OwLLM
/// chrome bar on top, the actual page below. Tab webviews are labelled
/// `owllm-browser-page-{id}` (see `tab_label`). CONTENT_LABEL remains as a
/// compatibility lookup for browser windows created by older builds.
const CONTENT_LABEL: &str = "owllm-browser-page";
const CHROME_LABEL: &str = "owllm-browser-chrome";
const CHROME_EVENT_PATH: &str = "/__owllm_browser_event__";

/// Height of the OwLLM chrome bar (logical px) in the framed window:
/// a 58px identity strip (30px taller than a plain tab bar) that carries the
/// open site's real logo at a size the user recognises at a glance, over a
/// 38px nav toolbar with back/reload/URL (user spec 2026-07-29) — keep in
/// step with browser-chrome.html's #tabsrow.
const CHROME_H: f64 = 96.0;
/// Same solid accent edge thickness as AppShell's `WindowAccentEdge`.
/// The chrome webview paints it; page webviews leave this narrow edge exposed.
const BROWSER_FRAME_T: f64 = 3.0;

/// Width of the edge strip the user can grab to resize the window.
///
/// The window is undecorated on every OS, so nothing but this strip is left for
/// the resize hit test — and a webview that covers it makes the window
/// unresizable, which is exactly what happened on Linux (tao's own
/// `connect_button_press_event` edge handler never fired because the
/// WebKitWebView consumed every press) and on the Windows top edge. tao uses a
/// 5px border for its Linux hit test, so the exposed strip must be at least
/// that wide to be reachable.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const RESIZE_EDGE: i32 = 5;

/// True when the chrome-bar webview spans the whole window and the page webview
/// is stacked on top of it (Windows/macOS), so browser-chrome.html can paint the
/// accent frame around the page. WebKitGTK mislays stacked child webviews, so on
/// Linux the two are TILED instead — bar owns the top CHROME_H strip, page owns
/// everything below, never overlapping.
fn chrome_overlaps_page() -> bool {
    !cfg!(target_os = "linux")
}

/// Accent edge left exposed around the page webview. Only meaningful when the
/// chrome webview is behind it; a tiled bar has nothing to show through.
fn frame_t() -> f64 {
    if chrome_overlaps_page() {
        BROWSER_FRAME_T
    } else {
        0.0
    }
}

/// X where parked (inactive) tab webviews live. Tauri has no cross-platform
/// hide() for child webviews, so inactive tabs are simply moved far offscreen
/// and slid back on activation. Linux uses hidden top-level tab windows because
/// stacked child WebViews are unsafe on affected WebKitGTK/Jetson drivers.
const PARK_X: f64 = -20000.0;

/// Open tabs of the framed browser window, strip order + the active id.
/// Each tab is its own content webview. Ordinary tabs share the persistent
/// profile; provider-auth tab ids are tracked separately and stay private.
struct Tabs {
    order: Vec<u64>,
    active: u64,
    titles: HashMap<u64, String>,
    /// OAuth tabs must not inherit or persist ordinary browser credentials.
    private_tabs: HashSet<u64>,
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
/// Linux/WebKitGTK on NVIDIA/Tegra can abort the entire process with
/// `BadDrawable` when a top-level WebView window is destroyed. A stopped
/// browser therefore remains allocated but hidden and blank until it is reused.
static BROWSER_SUSPENDED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "linux")]
static RETIRED_LINUX_TABS: Mutex<Vec<u64>> = Mutex::new(Vec::new());

fn tab_label(id: u64) -> String {
    format!("{CONTENT_LABEL}-{id}")
}

/// True when `id` is the active tab. **NEVER BLOCKS.**
///
/// This is reached from `attach_tab`'s `on_page_load` — a NATIVE WebView2 /
/// WKWebView / WebKitGTK callback that runs ON THE UI THREAD. Waiting here for a
/// Rust worker that holds TABS deadlocks the event thread and freezes every OwLLM
/// window (observed live on v0.9.64: main thread parked in
/// `Mutex::lock_contended` inside `browser::attach_tab::{closure#2}`, under a
/// WebView2 `WebResourceRequested` handler — the app hung the moment a project
/// opened the agent browser).
///
/// Both call sites only gate a COSMETIC chrome-bar refresh, so on contention we
/// answer `false` and let the next title/`sync_tabs` event repaint — the same
/// trade `capture_reply` already makes for REPLIES. A stale URL bar for one load
/// is invisible; a frozen app is not.
fn is_active_tab(id: u64) -> bool {
    let active_is = |t: &Option<Tabs>| t.as_ref().map(|t| t.active == id).unwrap_or(false);
    match TABS.try_lock() {
        Ok(guard) => active_is(&guard),
        Err(TryLockError::Poisoned(p)) => active_is(&p.into_inner()),
        Err(TryLockError::WouldBlock) => false,
    }
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

/// Move `id` to position `to` in the strip order (chrome-bar drag-reorder).
/// Pure so the rule is testable without a window. Out-of-range indices clamp to
/// the ends rather than dropping the gesture: a pill dragged past the last one
/// belongs at the end. Returns whether the order actually changed.
fn move_tab_order(order: &mut Vec<u64>, id: u64, to: usize) -> bool {
    let Some(from) = order.iter().position(|t| *t == id) else {
        return false;
    };
    let to = to.min(order.len().saturating_sub(1));
    if from == to {
        return false;
    }
    let moved = order.remove(from);
    order.insert(to, moved);
    true
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

/// Linux analog: the exposed resize edge (see `linux_expose_resize_edges`) is
/// the GTK window's own background showing through, so paint it in the same
/// chrome colour the bar uses — otherwise the ring reads as a stray grey
/// border from the system theme instead of OwLLM's accent edge.
#[cfg(target_os = "linux")]
fn apply_chrome(win: &Window) {
    use gtk::prelude::*;
    let (r, g, b) = CHROME_BG
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .unwrap_or((OWLLM_BG.0, OWLLM_BG.1, OWLLM_BG.2));
    let Ok(gtk_win) = win.gtk_window() else { return };
    let css = gtk::CssProvider::new();
    if css
        .load_from_data(format!("window {{ background-color: rgb({r},{g},{b}); }}").as_bytes())
        .is_err()
    {
        return;
    }
    // Per-widget, NOT add_provider_for_screen: a screen-wide provider would
    // repaint the main app window too.
    gtk_win
        .style_context()
        .add_provider(&css, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
}

#[cfg(not(any(windows, target_os = "linux")))]
fn apply_chrome(_win: &Window) {}

/// Run `f` against `win` on the UI (event-loop) thread and wait for it.
///
/// Native window mutation is main-thread-only: AppKit tears down and rebuilds
/// the window's NSThemeFrame inside `setStyleMask:`, and GTK owns its widget
/// tree the same way. Every window built here is built by a
/// `#[tauri::command(async)]`, which Tauri runs on a tokio worker — so doing
/// that work inline is off-thread by construction. It crashed OwLLM three times
/// on 2026-08-09: twice trapping immediately inside `NSWMWindowCoordinator`
/// (v1.0.7, v1.0.10) and once as a delayed main-thread SIGSEGV in
/// `NSViewUpdateVibrancyForSubtree` on the next display cycle, from a
/// half-swapped view tree (v1.0.7). A standalone AppKit probe of the same call
/// sequence crashed 5/5 off-thread and survived 5/5 on the main thread.
///
/// Waits, because callers depend on the window being set up before they add
/// child webviews. Runs inline when we already are the UI thread, so a
/// UI-thread caller can never deadlock waiting on its own dispatch.
fn on_ui_thread(win: &Window, f: impl FnOnce(&Window) + Send + 'static) -> Result<(), String> {
    if crate::is_ui_thread() {
        f(win);
        return Ok(());
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let window = win.clone();
    win.run_on_main_thread(move || {
        f(&window);
        let _ = tx.send(());
    })
    .map_err(|e| format!("ui thread dispatch: {e}"))?;
    // Bounded: a wedged event loop must surface as an error, never as a hang.
    rx.recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|_| "native window setup did not run on the UI thread".to_string())
}

/// macOS: keep the undecorated window natively resizable.
///
/// tao maps `decorations(false)` to an NSWindow styleMask of
/// `Borderless | Resizable`, and AppKit only installs frame-view resize
/// tracking for a TITLED window — a borderless one ignores edge drags. There is
/// no software fallback either: tao's `drag_resize_window` returns
/// `NotSupported` on macOS, so `start_resize_dragging` (what the chrome bar's
/// edge strips use on Windows) does nothing here. Re-add
/// `Titled | FullSizeContentView` and hide every titlebar element instead: the
/// window still looks frameless — our chrome bar is the bar — but AppKit
/// resizes it like any other window.
#[cfg(target_os = "macos")]
fn mac_enable_native_resize(win: &Window) {
    use objc2::runtime::AnyObject;
    const TITLED: usize = 1 << 0;
    const RESIZABLE: usize = 1 << 3;
    const FULL_SIZE_CONTENT_VIEW: usize = 1 << 15;
    /// `NSWindowTitleVisibility::Hidden`.
    const TITLE_HIDDEN: isize = 1;
    let Ok(ptr) = win.ns_window() else { return };
    if ptr.is_null() {
        return;
    }
    let ns_window = ptr as *mut AnyObject;
    unsafe {
        let mask: usize = objc2::msg_send![ns_window, styleMask];
        let _: () = objc2::msg_send![
            ns_window,
            setStyleMask: mask | TITLED | RESIZABLE | FULL_SIZE_CONTENT_VIEW
        ];
        let _: () = objc2::msg_send![ns_window, setTitlebarAppearsTransparent: true];
        let _: () = objc2::msg_send![ns_window, setTitleVisibility: TITLE_HIDDEN];
        // Our chrome bar carries its own ─ ▢ ✕, so the traffic lights the
        // titled style brings back would be a SECOND set of window buttons.
        for kind in 0usize..3 {
            let button: *mut AnyObject = objc2::msg_send![ns_window, standardWindowButton: kind];
            if !button.is_null() {
                let _: () = objc2::msg_send![button, setHidden: true];
            }
        }
    }
}

/// UI → backend: the resolved app chrome colour (`--bg-header`). Stored for
/// every future agent-browser window build and applied live if one is open.
#[tauri::command(async)]
pub fn browser_set_chrome(app: tauri::AppHandle, bg: String) -> Result<(), String> {
    let rgb = parse_hex_rgb(&bg).ok_or_else(|| format!("bad chrome colour {bg:?}"))?;
    *CHROME_BG.lock().unwrap_or_else(|p| p.into_inner()) = Some(rgb);
    if let Some(win) = get_window(&app) {
        on_ui_thread(&win, apply_chrome)?;
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

/// WKWebView deliberately omits Safari's `Version/... Safari/...` tokens from
/// its default user agent. Sites such as WhatsApp therefore mistake a current
/// embedded WebKit for Safari < 15 and send the user into an update loop that
/// no macOS update can fix. Read the installed Safari compatibility version so
/// the embedded browser reports the engine actually present on this Mac. The
/// privacy-reduced macOS token matches WKWebView's own default UA.
#[cfg(target_os = "macos")]
fn macos_desktop_user_agent() -> Option<&'static str> {
    static USER_AGENT: OnceLock<Option<String>> = OnceLock::new();
    USER_AGENT
        .get_or_init(|| {
            use objc2_foundation::{NSBundle, NSString};

            let version = NSBundle::bundleWithPath(objc2_foundation::ns_string!(
                "/Applications/Safari.app"
            ))
            .and_then(|bundle| {
                bundle.objectForInfoDictionaryKey(objc2_foundation::ns_string!(
                    "CFBundleShortVersionString"
                ))
            })
            .and_then(|value| value.downcast::<NSString>().ok())
            .map(|value| value.to_string())
            .filter(|value| {
                !value.is_empty()
                    && value
                        .chars()
                        .all(|character| character.is_ascii_digit() || character == '.')
            })?;
            Some(format!(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
                 AppleWebKit/605.1.15 (KHTML, like Gecko) Version/{version} Safari/605.1.15"
            ))
        })
        .as_deref()
}

fn device_user_agent(device: &Device) -> Option<Cow<'static, str>> {
    #[cfg(target_os = "macos")]
    if device.name == "desktop" {
        if let Some(user_agent) = macos_desktop_user_agent() {
            return Some(Cow::Borrowed(user_agent));
        }
    }
    device.ua.map(Cow::Borrowed)
}

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
  function scrollableRegion(el, axis) {
    if (!el || el === document.body || el === document.documentElement) return false;
    var st = getComputedStyle(el);
    if (axis !== "x" && el.scrollHeight > el.clientHeight + 2 &&
        /^(auto|scroll|overlay)$/.test(st.overflowY)) return true;
    return axis !== "y" && el.scrollWidth > el.clientWidth + 2 &&
        /^(auto|scroll|overlay)$/.test(st.overflowX);
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
    // Reserve a few indexes for scroll regions. Virtualized chat/mail/contact
    // lists often expose no useful control beyond the items currently mounted.
    for (var i = 0; i < primary.length && els.length < 140; i++) {
      if (visible(primary[i])) els.push(primary[i]);
    }
    var scrollCandidates = [];
    for (var si = 0; si < els.length; si++) {
      for (var parent = els[si].parentElement; parent; parent = parent.parentElement) {
        if (scrollableRegion(parent) && scrollCandidates.indexOf(parent) === -1) {
          scrollCandidates.push(parent);
        }
      }
    }
    var regions = document.querySelectorAll("main,section,div,ul,ol,[role=list],[role=grid],[role=feed],[role=log]");
    for (var sr = 0; sr < regions.length && sr < 5000; sr++) {
      if (visible(regions[sr]) && scrollableRegion(regions[sr]) &&
          scrollCandidates.indexOf(regions[sr]) === -1) scrollCandidates.push(regions[sr]);
    }
    // Prefer the innermost regions: scrolling a chat list is useful; scrolling
    // its full-page wrapper usually is not.
    scrollCandidates.sort(function (a, b) {
      if (a.contains(b)) return 1;
      if (b.contains(a)) return -1;
      return 0;
    });
    for (var sc = 0; sc < scrollCandidates.length && els.length < 150; sc++) {
      if (els.indexOf(scrollCandidates[sc]) === -1) els.push(scrollCandidates[sc]);
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
    if (scrollableRegion(el)) {
      var axes = (scrollableRegion(el, "x") ? "x" : "") + (scrollableRegion(el, "y") ? "y" : "");
      extra += "[scrollable-" + axes + " " + Math.round(el.scrollLeft) + "," +
               Math.round(el.scrollTop) + "]";
    }
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
  function textInputEvent(el, type, text, cancelable) {
    var event;
    try {
      event = new InputEvent(type, {
        bubbles: true, cancelable: !!cancelable, composed: true,
        inputType: "insertText", data: text
      });
    } catch (e) {
      event = new Event(type, { bubbles: true, cancelable: !!cancelable, composed: true });
    }
    return el.dispatchEvent(event);
  }
  function setNativeTextValue(el, text) {
    var proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, text); else el.value = text;
    textInputEvent(el, "input", text, false);
    fire(el, "change");
  }
  function replaceEditableText(el, text) {
    var selection = window.getSelection();
    var range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    var emitted = false;
    var mark = function () { emitted = true; };
    el.addEventListener("input", mark, { once: true });
    var inserted = false;
    try { inserted = document.execCommand("insertText", false, text); } catch (e) {}
    if (!inserted) {
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    if (!emitted) textInputEvent(el, "input", text, false);
    fire(el, "change");
  }
  function nearestScrollable(el, axis) {
    for (var node = el; node; node = node.parentElement) {
      if (scrollableRegion(node, axis)) return node;
    }
    return null;
  }
  function bestScrollable(axis) {
    var active = nearestScrollable(document.activeElement, axis);
    if (active) return active;
    var els = window.__owllmEls || reindex();
    var best = null, area = -1;
    for (var i = 0; i < els.length; i++) {
      if (!visible(els[i]) || !scrollableRegion(els[i], axis)) continue;
      var r = els[i].getBoundingClientRect();
      if (r.width * r.height > area) { best = els[i]; area = r.width * r.height; }
    }
    return best || document.scrollingElement || document.documentElement;
  }
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
  // Rust streams a local file into this page as base64 chunks, then this
  // creates a real FileList on the target input. No OS file picker is opened,
  // so browser automation never steals the user's keyboard or blocks the GUI.
  // The Rust side enforces the size cap before any bytes enter the WebView.
  var uploads = Object.create(null);
  function fileInputFor(index) {
    var indexed = index === null || index === undefined ? null : elAt(index);
    if (indexed && indexed.matches && indexed.matches('input[type=file]')) return indexed;
    if (indexed && indexed.control && indexed.control.matches && indexed.control.matches('input[type=file]')) return indexed.control;
    if (indexed && indexed.querySelector) {
      var nested = indexed.querySelector('input[type=file]');
      if (nested) return nested;
    }
    for (var parent = indexed && indexed.parentElement; parent; parent = parent.parentElement) {
      var nearby = parent.querySelector && parent.querySelector('input[type=file]');
      if (nearby) return nearby;
    }
    var all = document.querySelectorAll('input[type=file]');
    if (all.length === 1) return all[0];
    throw new Error(all.length
      ? "multiple file inputs found; click the site's attachment control first, snapshot, then pass its index"
      : "no file input found; click the site's attachment/upload control first");
  }
  window.__owllmUploadStart = function (token, index, name, mime) {
    try {
      uploads[token] = { input: fileInputFor(index), name: name, mime: mime, chunks: [] };
    } catch (e) {
      uploads[token] = { error: String(e && e.message || e), chunks: [] };
    }
  };
  window.__owllmUploadChunk = function (token, chunk) {
    if (uploads[token] && !uploads[token].error) uploads[token].chunks.push(chunk);
  };
  window.__owllmUploadFinish = function (reqId, token) {
    var upload = uploads[token];
    delete uploads[token];
    try {
      if (!upload) throw new Error("upload session was lost during page navigation");
      if (upload.error) throw new Error(upload.error);
      var parts = [];
      for (var i = 0; i < upload.chunks.length; i++) {
        var raw = atob(upload.chunks[i]);
        var bytes = new Uint8Array(raw.length);
        for (var j = 0; j < raw.length; j++) bytes[j] = raw.charCodeAt(j);
        parts.push(bytes);
      }
      var file = new File(parts, upload.name, { type: upload.mime, lastModified: Date.now() });
      var transfer = new DataTransfer();
      transfer.items.add(file);
      upload.input.files = transfer.files;
      fire(upload.input, "input");
      fire(upload.input, "change");
      report(reqId, "attached " + upload.name + " (" + file.size + " bytes)");
    } catch (e) {
      report(reqId, "ERROR: " + String(e && e.message || e));
    }
  };
  window.__owllmRun = function (reqId, action, paramsJson) {
    var p = {};
    try { p = paramsJson ? JSON.parse(paramsJson) : {}; } catch (e) {}
    try {
      switch (action) {
        case "info":
          return report(reqId, JSON.stringify({ url: location.href, title: realTitle(), ready: document.readyState }));
        case "capture_metrics": {
          var root = document.documentElement;
          var body = document.body;
          var width = Math.max(
            root ? root.scrollWidth : 0, root ? root.offsetWidth : 0,
            body ? body.scrollWidth : 0, body ? body.offsetWidth : 0,
            window.innerWidth || 0
          );
          var height = Math.max(
            root ? root.scrollHeight : 0, root ? root.offsetHeight : 0,
            body ? body.scrollHeight : 0, body ? body.offsetHeight : 0,
            window.innerHeight || 0
          );
          return report(reqId, JSON.stringify({
            width: Math.ceil(width), height: Math.ceil(height),
            viewport_width: Math.ceil(window.innerWidth || 0),
            viewport_height: Math.ceil(window.innerHeight || 0),
            device_scale: Number(window.devicePixelRatio || 1)
          }));
        }
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
          if (f.isContentEditable) replaceEditableText(f, String(p.text == null ? "" : p.text));
          else if (f.tagName === "INPUT" || f.tagName === "TEXTAREA") {
            setNativeTextValue(f, String(p.text == null ? "" : p.text));
          } else {
            throw new Error("element at index " + p.index + " is not a text field");
          }
          return report(reqId, "filled [" + p.index + "] with " + JSON.stringify(p.text));
        }
        case "scroll": {
          var direction = /^(up|down|left|right)$/.test(p.direction) ? p.direction : "down";
          var axis = direction === "left" || direction === "right" ? "x" : "y";
          var target = null;
          if (p.index !== undefined && p.index !== null) {
            var indexed = elAt(p.index);
            target = scrollableRegion(indexed, axis) ? indexed : nearestScrollable(indexed, axis);
            if (!target) throw new Error("no " + axis + "-scrollable region at or above index " + p.index);
          } else {
            target = bestScrollable(axis);
          }
          var viewport = axis === "x" ? target.clientWidth : target.clientHeight;
          var amount = Number(p.amount);
          if (!isFinite(amount) || amount <= 0) amount = Math.max(120, Math.round(viewport * 0.8));
          amount = Math.min(5000, Math.max(20, amount));
          if (direction === "up" || direction === "left") amount = -amount;
          var before = axis === "x" ? target.scrollLeft : target.scrollTop;
          if (target.scrollBy) {
            target.scrollBy(axis === "x" ? { left: amount, behavior: "auto" } : { top: amount, behavior: "auto" });
          } else if (axis === "x") {
            target.scrollLeft += amount;
          } else {
            target.scrollTop += amount;
          }
          return setTimeout(function () {
            var after = axis === "x" ? target.scrollLeft : target.scrollTop;
            var maximum = axis === "x"
              ? Math.max(0, target.scrollWidth - target.clientWidth)
              : Math.max(0, target.scrollHeight - target.clientHeight);
            report(reqId, "scrolled " + direction + " from " + Math.round(before) + " to " +
              Math.round(after) + " of " + Math.round(maximum) + "\n\n" + snapshot());
          }, 250);
        }
        case "fill_device_code": {
          // GitHub's Device Flow gives OWLLM the short code before the page is
          // opened. Fill the provider-owned form without storing the code or
          // bypassing GitHub's explicit final authorization/approval screen.
          if (location.hostname !== "github.com" || location.pathname.indexOf("/login/device") !== 0) {
            return report(reqId, "refused device-code fill outside github.com/login/device");
          }
          var code = String(p.code || "").trim();
          var selectors = [
            'input[autocomplete="one-time-code"]',
            'input[name="user_code"]',
            'input[name="user-code"]',
            'input[id*="user-code"]',
            'input[id*="device-code"]',
            'input[inputmode="text"]'
          ];
          var dc = null;
          for (var ds = 0; ds < selectors.length && !dc; ds++) {
            var candidates = document.querySelectorAll(selectors[ds]);
            for (var di = 0; di < candidates.length; di++) {
              if (visible(candidates[di])) { dc = candidates[di]; break; }
            }
          }
          if (!dc) return report(reqId, "device code field not ready");
          dc.focus();
          // React-controlled inputs ignore a plain assignment in some GitHub
          // builds. Use the native setter, then emit the same events as typing.
          var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
          if (setter && setter.set) setter.set.call(dc, code); else dc.value = code;
          fire(dc, "input"); fire(dc, "change");
          if (p.submit !== false && dc.form) {
            setTimeout(function () {
              try { dc.form.requestSubmit ? dc.form.requestSubmit() : dc.form.submit(); } catch (e) {}
            }, 120);
          }
          return report(reqId, "filled GitHub device code");
        }
        case "auth_complete": {
          // Some provider device-flow pages intentionally finish on an empty
          // dark document. Keep the provider page/cookies intact, but put a
          // readable OWLLM-owned completion card above it so the user is never
          // stranded wondering whether login worked.
          var provider = String(p.provider || "Account");
          var old = document.getElementById("owllm-auth-complete");
          if (old) old.remove();
          var wrap = document.createElement("div");
          wrap.id = "owllm-auth-complete";
          wrap.setAttribute("role", "status");
          wrap.setAttribute("aria-live", "polite");
          wrap.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:28px;background:#0b0f17;color:#f7f9fc;font-family:system-ui,-apple-system,sans-serif";
          var card = document.createElement("div");
          card.style.cssText = "max-width:520px;padding:30px 34px;border-radius:18px;border:1px solid #334155;background:#111827;box-shadow:0 24px 80px rgba(0,0,0,.45);text-align:center";
          var mark = document.createElement("div");
          mark.textContent = "✓";
          mark.style.cssText = "font-size:42px;color:#4ade80;margin-bottom:10px";
          var title = document.createElement("h1");
          title.textContent = provider + " connected";
          title.style.cssText = "font-size:24px;margin:0 0 9px";
          var body = document.createElement("p");
          body.textContent = "Authentication completed successfully. You can return to OWLLM and close this tab.";
          body.style.cssText = "font-size:15px;line-height:1.55;color:#cbd5e1;margin:0";
          card.appendChild(mark); card.appendChild(title); card.appendChild(body);
          wrap.appendChild(card); document.documentElement.appendChild(wrap);
          return report(reqId, "showed " + provider + " authentication completion");
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
  // --- typed-login capture: TRANSPORT ONLY -------------------------------
  // The SCANNER lives in FRAME_CRED_JS, injected into EVERY frame. This script
  // is main-frame-only -- Tauri hardcodes for_main_frame_only:true on
  // initialization_script -- which is exactly why an iframed login (the Google
  // identity iframe, most embedded OAuth) was never captured at all.
  //
  // Split so there is one scanner and one transport: a sub-frame postMessages
  // its find up here and the top frame writes it to the EVT title channel. A
  // sub-frame cannot report for itself -- an iframe document's title never
  // reaches the window, so the channel simply does not exist down there. Rust
  // upserts into the encrypted vault (browser_vault.rs) for next-time autofill.
  // A SET, not a last-seen slot: a page can now report from several frames at
  // once (top form + embedded provider), and with a single slot two logins
  // ping-pong and re-report each other forever, rewriting the vault on a loop.
  var credSeen = {};
  window.__owllmSendCred = function (c) {
    if (!c || !c.password) return;
    var key = c.origin + "" + c.username + "" + c.password;
    if (credSeen[key]) return; // this exact login already reported on this page
    credSeen[key] = 1;
    if (document.title.indexOf(SENT) !== 0) window.__owllmTitle0 = document.title;
    document.title = SENT + "EVT" + Z + "cred" + Z + b64(JSON.stringify(c));
    setTimeout(function () { try { document.title = window.__owllmTitle0 || ""; } catch (e) {} }, 60);
  };
  // The origin travels in the payload -- it is the FRAME's origin, not the top
  // page's -- so a login typed into an embedded identity provider is filed
  // under the site that actually owns it.
  window.addEventListener("message", function (e) {
    var d = e && e.data;
    if (d && d.__owllmCred && d.__owllmCred.password) window.__owllmSendCred(d.__owllmCred);
  });
  // --- vault autofill (Rust → page) --------------------------------------
  // Rust evals __owllmAutofill(user, pass) after a page finishes loading when
  // the vault holds a login for this origin (browser_vault::autofill_eval_for).
  // Fills ONLY empty fields — never clobbers what the user or the engine's own
  // password manager already put there — and waits for late-rendered SPA login
  // forms with a capped MutationObserver. Works identically on WebView2,
  // WebKitGTK and WKWebView because it is plain injected JS.
  window.__owllmAutofill = function (user, pass) {
    if (window.__owllmAutofilled) return;
    function visible(el) { return !!(el && el.offsetParent !== null && !el.disabled && !el.readOnly); }
    function tryFill() {
      var pws = document.querySelectorAll("input[type=password]");
      var pw = null;
      for (var i = 0; i < pws.length; i++) if (visible(pws[i])) { pw = pws[i]; break; }
      if (!pw) return false;
      window.__owllmAutofilled = true;
      if (pw.value) return true; // something else filled it first — leave it
      var userEl = null;
      var ins = document.querySelectorAll("input");
      for (var j = 0; j < ins.length; j++) {
        if (ins[j] === pw) break;
        var ty = (ins[j].type || "text").toLowerCase();
        if ((ty === "text" || ty === "email" || ty === "tel") && visible(ins[j])) userEl = ins[j];
      }
      if (userEl && !userEl.value && user) { userEl.value = user; fire(userEl, "input"); fire(userEl, "change"); }
      if (pass) { pw.value = pass; fire(pw, "input"); fire(pw, "change"); }
      return true;
    }
    if (tryFill()) return;
    var tries = 0;
    var obs = new MutationObserver(function () {
      if (window.__owllmAutofilled || ++tries > 400 || tryFill()) { try { obs.disconnect(); } catch (e) {} }
    });
    obs.observe(document.documentElement || document, { childList: true, subtree: true });
    setTimeout(function () { try { obs.disconnect(); } catch (e) {} }, 20000);
  };
})();
"##;

/// Injected at document-start into EVERY frame (`initialization_script_for_all_frames`).
///
/// Tauri's plain `initialization_script` hardcodes `for_main_frame_only: true`,
/// so BRIDGE_JS has never run inside an iframe — which is why an iframed login
/// (Google's identity iframe, most embedded OAuth) produced no vault entry at
/// all. This is the whole credential SCANNER, kept deliberately small because
/// it runs in every frame of every page:
///
///   * pierces shadow roots, so a login built as a web component is seen (a
///     plain `document.querySelectorAll` cannot cross a shadow boundary);
///   * caches the password element, so the deep walk happens once per form and
///     not on every keystroke;
///   * reports through the top frame — an iframe's `document.title` never
///     reaches the window, so the EVT channel does not exist in a sub-frame.
const FRAME_CRED_JS: &str = r##"
(function () {
  if (window.__owllmCredScan) return;
  window.__owllmCredScan = true;
  var TOP = window.top === window;

  // Cached password field. Re-finding it costs a full shadow walk, so hold on
  // to it while it is still in the document.
  var pwEl = null;
  function livePw() {
    if (pwEl && pwEl.isConnected && (pwEl.type || "").toLowerCase() === "password") return pwEl;
    pwEl = null;
    return null;
  }
  // Cheap first: the ordinary top-level query covers almost every site. Only
  // when that finds nothing do we pay for the shadow-root walk.
  function findPw() {
    var live = livePw();
    if (live) return live;
    var shallow = document.querySelectorAll("input[type=password]");
    for (var i = 0; i < shallow.length; i++) { pwEl = shallow[i]; return pwEl; }
    var found = deepPw(document, 0);
    if (found) pwEl = found;
    return found;
  }
  function deepPw(root, depth) {
    if (!root || depth > 8 || !root.querySelectorAll) return null;
    var hosts = root.querySelectorAll("*");
    for (var i = 0; i < hosts.length; i++) {
      var sr = hosts[i].shadowRoot;
      if (!sr) continue;
      var p = sr.querySelector("input[type=password]");
      if (p) return p;
      var deeper = deepPw(sr, depth + 1);
      if (deeper) return deeper;
    }
    return null;
  }
  // The username is the last filled text/email/tel input BEFORE the password
  // field, in the same root. Two-step logins (Google, Microsoft) put the two on
  // separate pages, so the typed value is also remembered in sessionStorage —
  // which survives a same-origin navigation within this tab.
  function userFor(pw) {
    var u = "";
    try { u = sessionStorage.getItem("__owllmLoginUser") || ""; } catch (e) {}
    var root = pw.getRootNode ? pw.getRootNode() : document;
    var ins = (root.querySelectorAll ? root : document).querySelectorAll("input");
    for (var j = 0; j < ins.length; j++) {
      if (ins[j] === pw) break;
      var ty = (ins[j].type || "text").toLowerCase();
      if ((ty === "text" || ty === "email" || ty === "tel") && ins[j].value) u = ins[j].value;
    }
    return u;
  }
  function scan() {
    var pw = findPw();
    if (!pw || !pw.value) return null;
    var u = userFor(pw);
    try { if (u) sessionStorage.setItem("__owllmLoginUser", u); } catch (e) {}
    // location.origin of THIS frame: an embedded identity provider's login
    // belongs to the provider, not to the page that framed it.
    return { origin: location.origin, username: u, password: pw.value };
  }

  var prov = null; // last complete login seen while typing
  function emit() {
    var c = scan() || prov;
    if (!c) return;
    if (TOP) {
      // Both scripts are document-start; if the transport has not defined
      // itself yet, come back on the next tick rather than dropping the login.
      if (window.__owllmSendCred) window.__owllmSendCred(c);
      else setTimeout(function () { if (window.__owllmSendCred) window.__owllmSendCred(c); }, 50);
    } else {
      try { window.top.postMessage({ __owllmCred: c }, "*"); } catch (e) {}
    }
  }
  var timer = 0;
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = 0; emit(); }, 700);
  }

  // SPA logins often clear the form without ever navigating, so submit/pagehide
  // alone lose the values. Keep a provisional copy while the user types and
  // also report on submit-ish clicks, Enter and tab-hide; the transport dedupes.
  document.addEventListener("submit", emit, true);
  window.addEventListener("pagehide", emit);
  // e.target is RETARGETED to the shadow HOST once an event crosses a shadow
  // boundary, so a document-level listener sees a <div>, not the <input> the
  // user typed into. composedPath()[0] is the real originating element — without
  // it these listeners silently never fire for a web-component login.
  function src(e) {
    if (e && e.composedPath) { var p = e.composedPath(); if (p && p.length) return p[0]; }
    return e ? e.target : null;
  }
  document.addEventListener("input", function (e) {
    var t = src(e);
    if (!t || t.tagName !== "INPUT") return;
    var ty = (t.type || "text").toLowerCase();
    if ((ty === "text" || ty === "email" || ty === "tel") && t.value) {
      try { sessionStorage.setItem("__owllmLoginUser", t.value); } catch (e2) {}
    }
    if (ty === "password") pwEl = t; // cheapest possible find
    var c = scan();
    if (c) { prov = c; schedule(); }
  }, true);
  document.addEventListener("click", function (e) {
    var t = src(e);
    var el = t && t.closest ? t.closest("button, input[type=submit], [role=button]") : null;
    if (el) setTimeout(emit, 0);
  }, true);
  document.addEventListener("keydown", function (e) {
    var t = src(e);
    if (e.key === "Enter" && t && t.tagName === "INPUT") setTimeout(emit, 0);
  }, true);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") emit();
  });
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

#[cfg(any(windows, target_os = "linux"))]
fn private_auth_data_dir(id: u64) -> std::path::PathBuf {
    std::env::temp_dir()
        .join("owllm-provider-auth")
        .join(format!("{}-{id}", std::process::id()))
}

/// Enable WebView2 password autosave + general autofill on an agent-browser
/// webview. WebView2 disables both by default (unlike a normal Chrome/Edge
/// profile), so a login typed here would never trigger a "Save password?"
/// prompt and never be re-filled on return, even though the profile dir keeps
/// cookies. Called on every agent-browser webview right after creation. The
/// stored credentials live only in the per-user, per-machine WebView2 profile
/// (`browser_data_dir()`); nothing is written to the repo or a release.
#[cfg(windows)]
fn win_enable_web_credentials(pw: tauri::webview::PlatformWebview) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings4;
    use windows::core::Interface;
    unsafe {
        let core = match pw.controller().CoreWebView2() {
            Ok(c) => c,
            Err(_) => return,
        };
        let settings = match core.Settings() {
            Ok(s) => s,
            Err(_) => return,
        };
        if let Ok(s4) = settings.cast::<ICoreWebView2Settings4>() {
            let _ = s4.SetIsGeneralAutofillEnabled(true);
            let _ = s4.SetIsPasswordAutosaveEnabled(true);
        }
    }
}

/// Linux (WebKitGTK) analog of `win_enable_web_credentials`: the engine's
/// persistent credential storage — HTTP-auth logins saved into the user's
/// secret service (libsecret) — is also DISABLED by default. Form-password
/// autosave has no embedder API in WebKitGTK; staying logged in on ordinary
/// websites comes from the persisted cookie/session profile set via
/// `data_directory()`. macOS WKWebView exposes neither switch, but its default
/// persistent data store already keeps cookies/sessions per app.
#[cfg(target_os = "linux")]
fn linux_enable_web_credentials(pw: &tauri::webview::PlatformWebview) {
    use webkit2gtk::{WebViewExt, WebsiteDataManagerExt};
    if let Some(manager) = pw.inner().website_data_manager() {
        manager.set_persistent_credential_storage_enabled(true);
    }
}

/// Make the undecorated window resizable on Linux by leaving its outer
/// `RESIZE_EDGE` pixels uncovered.
///
/// tao ALREADY hit-tests the edges of an undecorated resizable window and calls
/// `begin_resize_drag` (linux/event_loop.rs `connect_button_press_event`), but
/// it listens on the GtkWindow — and Tauri packs every webview into that
/// window's box edge to edge, so WebKitWebView swallowed the press and the
/// handler never ran. Measured on THOR (Jetson, GTK 2.52): dragging the right
/// edge of the window left it at exactly its old size. Insetting the box hands
/// those pixels back to the toplevel, which is all tao needs.
#[cfg(target_os = "linux")]
fn linux_expose_resize_edges(win: &Window) {
    use gtk::prelude::*;
    let Ok(vbox) = win.default_vbox() else { return };
    vbox.set_margin_start(RESIZE_EDGE);
    vbox.set_margin_end(RESIZE_EDGE);
    vbox.set_margin_top(RESIZE_EDGE);
    vbox.set_margin_bottom(RESIZE_EDGE);
}

/// Give the chrome bar a fixed height inside the window's GTK box. Tauri packs
/// every child webview into that box with expand=true, so without this the bar
/// and the page each get half the window and set_size cannot correct it.
#[cfg(target_os = "linux")]
fn linux_pin_chrome_bar(pw: tauri::webview::PlatformWebview) {
    use gtk::prelude::*;
    let widget: gtk::Widget = pw.inner().clone().upcast();
    widget.set_size_request(-1, CHROME_H as i32);
    // wry packs every child webview with expand=TRUE, and that packing property
    // outranks the widget's own vexpand — clearing it here is what actually stops
    // the box from handing the bar half the window.
    if let Some(vbox) = widget.parent().as_ref().and_then(|p| p.downcast_ref::<gtk::Box>()) {
        vbox.set_child_packing(&widget, false, true, 0, gtk::PackType::Start);
    }
}

/// Let the active page take every pixel the bar does not, so the two tile
/// instead of splitting the window evenly.
#[cfg(target_os = "linux")]
fn linux_expand_page(pw: tauri::webview::PlatformWebview) {
    use gtk::prelude::*;
    let widget: gtk::Widget = pw.inner().clone().upcast();
    widget.set_vexpand(true);
    widget.set_valign(gtk::Align::Fill);
}

#[cfg(target_os = "linux")]
fn linux_configure_browser_webview(
    pw: tauri::webview::PlatformWebview,
    requested_url: String,
    private_session: bool,
) {
    use std::cell::Cell;
    use std::rc::Rc;
    use webkit2gtk::{WebContextExt, WebViewExt};

    // Keep arbitrary internet pages out of the process used by the main app.
    // WebKitGTK defaults to one shared secondary process per WebContext; one
    // fatal page load can therefore blank every view in that context. The
    // browser has its own persistent WebContext/data directory, and this model
    // gives each site a secondary process inside it as well.
    if let Some(context) = pw.inner().context() {
        #[allow(deprecated)]
        context.set_process_model(webkit2gtk::ProcessModel::MultipleSecondaryProcesses);
    }
    if !private_session {
        linux_enable_web_credentials(&pw);
    }

    // A browser-page failure is recoverable and must remain local to that tab.
    // Retry once for a transient WebKit/network-process failure; if the same
    // page immediately kills its renderer again, stop the loop on a safe local
    // error surface instead of repeatedly destabilising the desktop.
    let recoveries = Rc::new(Cell::new(0_u8));
    pw.inner().connect_web_process_terminated({
        let recoveries = Rc::clone(&recoveries);
        move |webview, reason| {
            let entry = format!(
                "[{}] agent browser WebKit process terminated: {reason:?}\n",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
            );
            if let Some(root) = crate::paths::user_data_root() {
                use std::io::Write;
                let _ = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(root.join("browser-webkit.log"))
                    .and_then(|mut file| file.write_all(entry.as_bytes()));
            }
            eprint!("[browser] {entry}");
            if !matches!(
                reason,
                webkit2gtk::WebProcessTerminationReason::Crashed
                    | webkit2gtk::WebProcessTerminationReason::ExceededMemoryLimit
            ) {
                return;
            }
            let attempts = recoveries.get();
            recoveries.set(attempts.saturating_add(1));
            if attempts == 0 {
                webview.reload();
            } else {
                webview.load_html(
                    r#"<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="dark"><style>body{margin:0;background:#0e1117;color:#e7eaf0;font:16px system-ui;display:grid;place-items:center;min-height:100vh}main{max-width:40rem;padding:2rem}h1{font-size:1.2rem}p{color:#aeb6c5;line-height:1.5}</style><main><h1>This page’s browser process stopped</h1><p>OwLLM kept the app and your other work running. Reload the tab to try the page again.</p></main>"#,
                    Some("about:blank"),
                );
            }
        }
    });

    // The Linux builder starts at about:blank so the process model and crash
    // callback above are installed before any untrusted page begins loading.
    pw.inner().load_uri(&requested_url);
}

fn get_window(app: &tauri::AppHandle) -> Option<Window> {
    app.get_window(BROWSER_LABEL)
        .or_else(|| active_tab_id().and_then(|id| app.get_window(&tab_label(id))))
}

fn browser_is_suspended() -> bool {
    BROWSER_SUSPENDED.load(Ordering::SeqCst)
}

fn resume_browser(app: &tauri::AppHandle, navigate_to: Option<tauri::Url>) -> Result<(), String> {
    let Some(id) = active_tab_id() else {
        return Err("browser has no reusable tab".to_string());
    };
    if let Some(url) = navigate_to {
        app.get_webview(&tab_label(id))
            .ok_or_else(|| "browser page is unavailable".to_string())?
            .navigate(url)
            .map_err(|e| format!("navigate failed: {e}"))?;
    }
    BROWSER_SUSPENDED.store(false, Ordering::SeqCst);
    activate_tab(app, id);
    Ok(())
}

fn resume_normal_browser(app: &tauri::AppHandle, url: tauri::Url) -> Result<u64, String> {
    let old_id = active_tab_id();
    if old_id.is_some_and(is_private_tab) {
        BROWSER_SUSPENDED.store(false, Ordering::SeqCst);
        let id = new_tab(app, url.as_str(), true, false)?;
        if let Some(old_id) = old_id.filter(|old_id| *old_id != id) {
            close_tab(app, old_id);
        }
        Ok(id)
    } else {
        resume_browser(app, Some(url))?;
        active_tab_id().ok_or_else(|| "browser has no reusable tab".to_string())
    }
}

#[cfg(target_os = "linux")]
fn retire_linux_tab(app: &tauri::AppHandle, id: u64, private_session: bool) {
    if let Some(webview) = app.get_webview(&tab_label(id)) {
        if let Ok(blank) = "about:blank".parse() {
            let _ = webview.navigate(blank);
        }
    }
    if let Some(window) = app.get_window(&tab_label(id)) {
        let _ = window.hide();
    }
    if private_session {
        return;
    }
    let mut retired = RETIRED_LINUX_TABS.lock().unwrap_or_else(|p| p.into_inner());
    if !retired.contains(&id) {
        retired.push(id);
    }
}

/// Stop the Linux browser without destroying a WebKitGTK top-level window.
/// Keep the active window as the reusable seed and retire the rest. All pages
/// navigate to about:blank so a stopped browser does not leave sites executing
/// invisibly or retain their renderer memory.
#[cfg(target_os = "linux")]
fn suspend_linux_browser(app: &tauri::AppHandle) -> Result<(), String> {
    let (active, inactive) = {
        let mut guard = TABS.lock().unwrap_or_else(|p| p.into_inner());
        let Some(tabs) = guard.as_mut() else {
            BROWSER_SUSPENDED.store(true, Ordering::SeqCst);
            return Ok(());
        };
        let active = tabs.active;
        let inactive = tabs
            .order
            .iter()
            .copied()
            .filter(|id| *id != active)
            .map(|id| (id, tabs.private_tabs.contains(&id)))
            .collect::<Vec<_>>();
        tabs.order.clear();
        tabs.order.push(active);
        tabs.titles.clear();
        (active, inactive)
    };
    for (id, private_session) in inactive {
        retire_linux_tab(app, id, private_session);
    }
    let blank = "about:blank"
        .parse()
        .map_err(|e| format!("bad blank browser url: {e}"))?;
    if let Some(webview) = app.get_webview(&tab_label(active)) {
        webview
            .navigate(blank)
            .map_err(|e| format!("blank browser page: {e}"))?;
    }
    if let Some(window) = app.get_window(&tab_label(active)) {
        window
            .hide()
            .map_err(|e| format!("hide browser window: {e}"))?;
    }
    BROWSER_SUSPENDED.store(true, Ordering::SeqCst);
    Ok(())
}

#[cfg(not(target_os = "linux"))]
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

pub(crate) fn browser_tab_url(app: &tauri::AppHandle, tab_id: u64) -> Result<String, String> {
    let webview = content_webview_for_tab(app, Some(tab_id))
        .ok_or_else(|| format!("browser tab {tab_id} does not exist"))?;
    webview
        .url()
        .map(|url| public_browser_url(url.as_str()))
        .map_err(|e| format!("could not read browser tab {tab_id} URL: {e}"))
}

pub(crate) fn eval_browser_tab(
    app: &tauri::AppHandle,
    tab_id: u64,
    script: &str,
) -> Result<(), String> {
    let webview = content_webview_for_tab(app, Some(tab_id))
        .ok_or_else(|| format!("browser tab {tab_id} does not exist"))?;
    webview
        .eval(script)
        .map_err(|e| format!("could not autofill browser tab {tab_id}: {e}"))
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
                        url: webview
                            .url()
                            .map(|url| public_browser_url(url.as_str()))
                            .unwrap_or_default(),
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
            url: webview
                .url()
                .map(|url| public_browser_url(url.as_str()))
                .unwrap_or_default(),
            active: true,
        })
        .into_iter()
        .collect()
}

// ---------------------------------------------------------------------------
// Per-project browser session
//
// The tab strip itself only ever lived in memory (`TABS`), so closing the
// browser window — or restarting the app — lost every page the user had open,
// even though the logins behind them survive in the stable profile dir. A
// project's browser IS part of the project, so the live tab set is mirrored to
// disk per project and replayed when that project is opened again.
//
// Only the owning project is ever written, and an empty tab set is never
// written over a good one: a teardown must not erase the session it is tearing
// down. Restoring is driven by the UI (it re-uses browser_open_tab), so there
// is no second, divergent copy of the tab-opening logic down here.
// ---------------------------------------------------------------------------

/// Project whose session the live tab set belongs to. `None` = tabs opened
/// outside any project — the personal agent's desk, an agent one-off, the
/// browser tools. Those are the user's logged-in pages too, so they persist to
/// the reserved file below instead of being thrown away.
static SESSION_OWNER: Mutex<Option<String>> = Mutex::new(None);

/// Session file for tabs that belong to no project. The leading `_` cannot
/// collide with a project's file: `session_file_stem` trims those off.
const PERSONAL_SESSION_STEM: &str = "_personal";

/// How many closed pages stay reopenable. Deep enough to undo a wrong ✕ or a
/// whole row of them, short enough that the file stays a few KB.
const CLOSED_HISTORY_MAX: usize = 25;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct BrowserSession {
    /// Tab urls in strip order.
    #[serde(default)]
    pub tabs: Vec<String>,
    /// Index into `tabs` of the tab that was in front.
    #[serde(default)]
    pub active: usize,
    /// False once the user deliberately closed the browser, so an app restart
    /// does not resurrect a window they had put away on purpose.
    #[serde(default)]
    pub open: bool,
    /// Recently closed pages, oldest first. Closing a tab rewrites `tabs`
    /// without it, so without this the page is gone the instant it is closed.
    #[serde(default)]
    pub closed: Vec<String>,
}

/// Project ids come from our own database, but the session file name is still
/// built defensively — a stray separator must not escape the sessions dir.
fn session_file_stem(project_id: &str) -> String {
    let stem: String = project_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    stem.trim_matches('_').chars().take(120).collect()
}

fn session_path(stem: &str) -> Option<std::path::PathBuf> {
    if stem.is_empty() {
        return None;
    }
    let dir = crate::paths::user_data_root()?.join("browser_sessions");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(format!("{stem}.json")))
}

/// File the tabs on screen belong to. Falls back to the personal desk, so
/// there is no state in which the browser forgets what was open.
fn live_session_stem() -> String {
    SESSION_OWNER
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_deref()
        .map(session_file_stem)
        .filter(|stem| !stem.is_empty())
        .unwrap_or_else(|| PERSONAL_SESSION_STEM.to_string())
}

fn read_session(stem: &str) -> BrowserSession {
    session_path(stem)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<BrowserSession>(&raw).ok())
        .unwrap_or_default()
}

fn is_browser_home_url(url: &str) -> bool {
    let Ok(parsed) = url.parse::<tauri::Url>() else {
        return false;
    };
    if !parsed.path().ends_with(BROWSER_HOME_PAGE) {
        return false;
    }
    // Only the app's own origin counts, so a remote page that happens to end in
    // the same file name is never masked as the local start page.
    parsed.scheme() == "tauri"
        || matches!(
            parsed.host_str(),
            Some("tauri.localhost") | Some("localhost") | Some("127.0.0.1")
        )
}

/// Base URL of the OwLLM frontend — the dev server in development, the bundled
/// app origin in a release build. Read from the main window's webview so we
/// reuse Tauri's own resolution instead of duplicating it.
fn app_origin(app: &tauri::AppHandle) -> Result<tauri::Url, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "main window is not available".to_string())?
        .url()
        .map_err(|error| format!("could not resolve the app origin: {error}"))
}

fn public_browser_url(url: &str) -> String {
    if is_browser_home_url(url) {
        "about:blank".to_string()
    } else {
        url.to_string()
    }
}

/// Build the local start page with the five most recently known project URLs.
/// Closed entries are newest-at-the-end; live tabs follow as a fallback. The
/// session never contains credentials, page text or query results.
fn browser_home_url(app: &tauri::AppHandle) -> Result<tauri::Url, String> {
    use base64::Engine as _;

    let session = read_session(&live_session_stem());
    let mut seen = HashSet::new();
    let mut recent = Vec::new();
    for raw in session.closed.iter().rev().chain(session.tabs.iter().rev()) {
        let Ok(mut url) = raw.parse::<tauri::Url>() else {
            continue;
        };
        if !matches!(url.scheme(), "http" | "https") {
            continue;
        }
        // Recent shortcuts must not surface OAuth codes, search terms or
        // other query/fragment data that happened to be present in a tab URL.
        url.set_query(None);
        url.set_fragment(None);
        let safe_url = url.to_string();
        if !seen.insert(safe_url.clone()) {
            continue;
        }
        let host = url.host_str().unwrap_or("Recent page");
        let label = host.strip_prefix("www.").unwrap_or(host);
        let origin = match url.port() {
            Some(port) => format!("{}://{}:{}", url.scheme(), host, port),
            None => format!("{}://{}", url.scheme(), host),
        };
        recent.push(serde_json::json!({
            "url": safe_url,
            "origin": origin,
            "label": label,
        }));
        if recent.len() == 5 {
            break;
        }
    }
    // Handed to the page as base64url JSON in ?r= so the static document does
    // not have to reach into the session store itself.
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
        serde_json::to_string(&recent).unwrap_or_else(|_| "[]".to_string()),
    );
    let mut url = app_origin(app)?
        .join(BROWSER_HOME_PAGE)
        .map_err(|error| format!("bad browser home URL: {error}"))?;
    url.set_query(Some(&format!("r={encoded}")));
    Ok(url)
}

fn write_session(stem: &str, session: &BrowserSession) {
    if let (Some(path), Ok(raw)) = (session_path(stem), serde_json::to_string(session)) {
        let _ = std::fs::write(path, raw);
    }
}

/// Mirror the live tab set into the owning project's session file. Called
/// wherever the strip changes (open/close/activate/title, i.e. navigation).
fn persist_session(app: &tauri::AppHandle) {
    let stem = live_session_stem();
    let live = list_tabs(app);
    let (private_tabs, active_id) = TABS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(|tabs| (tabs.private_tabs.clone(), tabs.active))
        .unwrap_or_default();
    // Private authorization tabs must never be restored into the ordinary
    // browser session. Blank/loading tabs are also dropped, so the remembered
    // index is counted over the kept tabs rather than the raw live list.
    let kept: Vec<&BrowserTabInfo> = live
        .iter()
        .filter(|tab| !private_tabs.contains(&tab.id))
        .filter(|tab| !tab.url.is_empty() && tab.url != "about:blank")
        .collect();
    if kept.is_empty() {
        // A window being destroyed reports no tabs. Keeping the previous
        // session is the whole point: an accidental close must be undoable.
        return;
    }
    let tabs: Vec<String> = kept.iter().map(|tab| tab.url.clone()).collect();
    let active = kept
        .iter()
        .position(|tab| tab.id == active_id)
        .or_else(|| kept.iter().position(|tab| tab.active))
        .unwrap_or(0);
    // The reopen history outlives the strip: this runs on every tab mutation,
    // so rebuilding the record from scratch would erase it on the very next
    // navigation after a close.
    let closed = read_session(&stem).closed;
    write_session(
        &stem,
        &BrowserSession {
            tabs,
            active,
            open: true,
            closed,
        },
    );
}

/// Remember a page the user just closed so it can be reopened. Called before
/// the strip is rewritten without it.
fn remember_closed_tab(url: &str) {
    if url.is_empty() || url == "about:blank" {
        return;
    }
    let stem = live_session_stem();
    let mut session = read_session(&stem);
    session.closed.retain(|seen| seen != url);
    session.closed.push(url.to_string());
    let overflow = session.closed.len().saturating_sub(CLOSED_HISTORY_MAX);
    if overflow > 0 {
        session.closed.drain(..overflow);
    }
    write_session(&stem, &session);
}

/// The user put the browser away on purpose (✕ / browser_stop / last tab
/// closed). Keep the pages, but do not reopen the window by itself next boot.
fn mark_session_closed() {
    let stem = live_session_stem();
    let mut session = read_session(&stem);
    if session.tabs.is_empty() {
        return;
    }
    session.open = false;
    write_session(&stem, &session);
}

/// Push the strip to the chrome bar and mirror it to disk. Every tab mutation
/// goes through here so the two never drift.
fn sync_tabs(app: &tauri::AppHandle) {
    push_tabs(app);
    persist_session(app);
}

/// Claim the live browser for `project_id` and hand back its saved session.
///
/// `busy` means another project's tabs are on screen: the caller must not
/// restore over them, and ownership is left alone so the running project keeps
/// mirroring to its own file. `live` means this project's tabs are already
/// open, so there is nothing to restore.
#[tauri::command(async)]
pub fn browser_session_bind(app: tauri::AppHandle, project_id: String) -> Result<String, String> {
    let id = project_id.trim().to_string();
    if id.is_empty() {
        return Err("browser_session_bind requires a project id".to_string());
    }
    let has_tabs = !list_tabs(&app).is_empty();
    let mut owner = SESSION_OWNER.lock().unwrap_or_else(|p| p.into_inner());
    let owned_by_other = has_tabs && owner.as_deref().is_some_and(|current| current != id);
    if !owned_by_other {
        *owner = Some(id.clone());
    }
    drop(owner);
    Ok(json!({
        "busy": owned_by_other,
        "live": has_tabs && !owned_by_other,
        "session": read_session(&session_file_stem(&id)),
    })
    .to_string())
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
    /// A content tab finished loading an http(s) page: look the origin up in
    /// the credential vault and, on a hit, inject the autofill script. Vault
    /// I/O and the eval stay off the native callback thread.
    AutofillPage {
        id: u64,
        url: String,
    },
    /// Claude's manual OAuth callback contains the one-time code and PKCE
    /// state that the waiting login PTY expects as `code#state`. Keep it off
    /// the WebView callback thread and never persist or log it.
    ClaudeAuthCode {
        code: String,
    },
    /// A page requested a separate browsing context (`target=_blank` or
    /// `window.open`). The native callback denies the engine-owned popup and
    /// queues this event so the URL becomes a managed OwLLM tab instead.
    OpenTab {
        url: String,
        activate: bool,
        private_session: bool,
    },
    /// Linux title-bar close requests are intercepted before WebKitGTK can
    /// destroy the native window. The worker applies normal tab-close
    /// semantics after the native callback has returned.
    LegacyTabCloseRequested {
        id: u64,
    },
    LegacyTabDestroyed {
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
    autofills: HashMap<u64, String>,
    claude_auth_codes: Vec<String>,
    open_tabs: Vec<(String, bool, bool)>,
    legacy_close_requested: Vec<u64>,
    legacy_destroyed: Vec<u64>,
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
            BrowserUiEvent::AutofillPage { id, url } => {
                self.autofills.insert(id, url);
            }
            BrowserUiEvent::ClaudeAuthCode { code } => self.claude_auth_codes.push(code),
            BrowserUiEvent::OpenTab {
                url,
                activate,
                private_session,
            } => self.open_tabs.push((url, activate, private_session)),
            BrowserUiEvent::LegacyTabCloseRequested { id } => self.legacy_close_requested.push(id),
            BrowserUiEvent::LegacyTabDestroyed { id } => self.legacy_destroyed.push(id),
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
        for (id, url) in batch.autofills {
            if let Some(script) = crate::browser_vault::autofill_eval_for(&url) {
                if let Some(wv) = content_webview_for_tab(&app, Some(id)) {
                    let _ = wv.eval(&script);
                }
            }
        }
        for code in batch.claude_auth_codes {
            // Send only to the trusted application WebView. Browser tabs must
            // never receive another tab's one-time authorization code.
            let _ = app.emit_to("main", "owllm:claude-auth-code", json!({ "code": code }));
        }
        for (url, activate, private_session) in batch.open_tabs {
            if let Err(e) = new_tab(&app, &url, activate, private_session) {
                eprintln!("[browser] requested tab failed: {e}");
            }
        }
        for id in batch.legacy_close_requested {
            close_tab(&app, id);
        }
        for id in batch.legacy_destroyed {
            on_legacy_tab_closed(&app, id);
        }
        if let Some((width, height)) = batch.layout {
            layout_children(&app, tauri::PhysicalSize::new(width, height));
        }
        for (id, title) in batch.tab_titles {
            on_tab_title(&app, id, &title);
        }
        if batch.push_tabs {
            sync_tabs(&app);
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
    let (wire_action, b64) = rest.split_once('\u{2063}')?;
    // The chrome page appends a nonce so repeated identical clicks are not
    // coalesced by the WebView title-change implementation. It is transport
    // metadata, never part of the native action name.
    let action = wire_action.split_once('#').map_or(wire_action, |(name, _)| name);
    Some((action.to_string(), decode_b64(b64)))
}

/// Parse a browser-chrome control request from its reserved, same-origin URL.
/// The chrome WebView's navigation handler always cancels this navigation, so
/// the URL is only a reliable cross-platform event envelope, never a request.
fn parse_chrome_navigation(url: &tauri::Url) -> Option<(String, String)> {
    if url.path() != CHROME_EVENT_PATH {
        return None;
    }
    let mut action = None;
    let mut data = String::new();
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "action" => action = Some(value.into_owned()),
            "data" => data = decode_b64(&value),
            _ => {}
        }
    }
    action
        .filter(|value| !value.is_empty())
        .map(|value| (value, data))
}

/// Map a chrome-bar edge/corner id onto the runtime's resize direction. Unknown
/// ids are dropped rather than guessed — a wrong direction would resize the
/// window from the opposite side under the user's cursor.
fn parse_resize_direction(data: &str) -> Option<tauri_runtime::ResizeDirection> {
    use tauri_runtime::ResizeDirection as D;
    Some(match data {
        "n" => D::North,
        "s" => D::South,
        "e" => D::East,
        "w" => D::West,
        "ne" => D::NorthEast,
        "nw" => D::NorthWest,
        "se" => D::SouthEast,
        "sw" => D::SouthWest,
        _ => return None,
    })
}

/// Act on a chrome-bar event (window buttons / drag / URL entry). Always called
/// by `browser_ui_worker`, never directly by a native WebView callback.
fn handle_chrome_event(app: &tauri::AppHandle, action: &str, data: &str) {
    let Some(win) = get_window(app) else { return };
    match action {
        "drag" => {
            let _ = win.start_dragging();
        }
        // Edge/corner strips of the chrome webview. The window is undecorated,
        // so the only pixels an OS resize border could live in are the ones the
        // page webview leaves exposed — and on Windows the OS only hit-tests
        // some of them (measured: right/bottom resize, left/top return
        // HTNOWHERE or sit under the webview's own HWND). Driving the resize
        // ourselves makes all eight directions behave the same everywhere.
        "resize" => {
            if let Some(direction) = parse_resize_direction(data) {
                let _ = win.start_resize_dragging(direction);
            }
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
            #[cfg(target_os = "linux")]
            {
                persist_session(app);
                mark_session_closed();
                let _ = suspend_linux_browser(app);
            }
            #[cfg(not(target_os = "linux"))]
            {
                let _ = win.destroy();
            }
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
                let result = browser_home_url(&app)
                    .and_then(|home| new_tab(&app, home.as_str(), true, false).map(|_| ()));
                if let Err(e) = result {
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
        // Drag-reorder from the chrome strip: "<tab id>:<new index>". Only the
        // order changes — no webview is created, moved or destroyed — so this
        // runs inline instead of on a worker thread.
        "tabmove" => {
            let mut parts = data.split(':');
            let id = parts.next().and_then(|s| s.trim().parse::<u64>().ok());
            let to = parts.next().and_then(|s| s.trim().parse::<usize>().ok());
            if let (Some(id), Some(to)) = (id, to) {
                let changed = {
                    let mut guard = TABS.lock().unwrap_or_else(|p| p.into_inner());
                    guard
                        .as_mut()
                        .map(|tabs| move_tab_order(&mut tabs.order, id, to))
                        .unwrap_or(false)
                };
                if changed {
                    sync_tabs(app);
                }
            }
        }
        "tabreopen" => {
            let app = app.clone();
            std::thread::spawn(move || {
                if let Err(e) = browser_reopen_closed(app) {
                    eprintln!("[browser] reopen closed tab: {e}");
                }
            });
        }
        _ => {}
    }
}

/// OAuth/SSO popups that post the sign-in result back through
/// `window.opener` and then close themselves. These must stay engine-owned
/// popups: re-opening them as detached OwLLM tabs severs the opener (and the
/// per-tab sessionStorage nonce), so the identity provider's callback page
/// has nowhere to deliver the token and dies black — seen live with Kimi's
/// "Continue with Google" (kimi.com/google-callback). The engine popup shares
/// this webview's profile, so the resulting session lands in the opening tab.
fn is_opener_dependent_popup(url: &tauri::Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    let host = url.host_str().unwrap_or("");
    let path = url.path();
    match host {
        // Google Identity Services popup mode (GSI / "Sign in with Google").
        "accounts.google.com" => true,
        // Sign in with Apple popup flow.
        "appleid.apple.com" => true,
        // Microsoft MSAL loginPopup flows.
        "login.microsoftonline.com" | "login.live.com" => true,
        // GitHub OAuth popup flows only — plain github.com links stay tabs.
        "github.com" => path.starts_with("/login"),
        // Facebook Login dialog.
        "www.facebook.com" | "m.facebook.com" | "facebook.com" => {
            path.starts_with("/dialog/") || path.starts_with("/login")
        }
        _ => false,
    }
}

/// Build + attach one content (page) webview as a new tab. Active tabs sit
/// under the chrome bar; inactive ones are parked offscreen. Ordinary tabs
/// share the persistent profile; provider-auth tabs get a private profile.
fn attach_tab(
    app: &tauri::AppHandle,
    win: &Window,
    url: tauri::Url,
    id: u64,
    active: bool,
    private_session: bool,
) -> Result<(), String> {
    let dev = current_device();
    let new_window_app = app.clone();
    #[allow(unused_mut)]
    let mut content = WebviewBuilder::new(tab_label(id), WebviewUrl::External(url))
        .initialization_script(BRIDGE_JS)
        // Credential scanning must reach IFRAMES too — the plain
        // initialization_script above is main-frame-only.
        .initialization_script_for_all_frames(FRAME_CRED_JS)
        .on_new_window(move |url, _features| {
            // Opener-dependent OAuth popups must stay engine-owned so
            // `window.opener` / `window.close` keep working; everything else
            // is queued as a managed OwLLM tab after this callback returns.
            if is_opener_dependent_popup(&url) {
                return NewWindowResponse::Allow;
            }
            queue_browser_ui(
                &new_window_app,
                BrowserUiEvent::OpenTab {
                    url: url.to_string(),
                    activate: true,
                    private_session,
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
                let display_url = public_browser_url(payload.url().as_str());
                queue_browser_ui(
                    &wv.app_handle().clone(),
                    BrowserUiEvent::ChromeUpdate {
                        url: Some(display_url),
                        title: None,
                    },
                );
            }
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                if private_session {
                    if let Some(code) = claude_auth_code_from_callback(payload.url()) {
                        queue_browser_ui(
                            &wv.app_handle().clone(),
                            BrowserUiEvent::ClaudeAuthCode { code },
                        );
                    }
                }
                let url = payload.url().to_string();
                if !private_session && url.starts_with("http") {
                    queue_browser_ui(
                        &wv.app_handle().clone(),
                        BrowserUiEvent::AutofillPage { id, url },
                    );
                }
            }
        });
    if private_session {
        content = content.incognito(true);
    }
    if let Some(ua) = device_user_agent(dev) {
        content = content.user_agent(&ua);
    }
    // A stable, isolated data dir so agent-browser logins persist across runs.
    // The builder method is only present on Windows/Linux; macOS WKWebView uses
    // the app's default per-app store (logins still persist there).
    #[cfg(any(windows, target_os = "linux"))]
    {
        if private_session {
            let dir = private_auth_data_dir(id);
            let _ = std::fs::create_dir_all(&dir);
            content = content.data_directory(dir);
        } else if let Some(dir) = browser_data_dir() {
            let _ = std::fs::create_dir_all(&dir);
            content = content.data_directory(dir);
        }
    }
    let scale = win.scale_factor().unwrap_or(1.0);
    let ls = win
        .inner_size()
        .map(|s| s.to_logical::<f64>(scale))
        .unwrap_or_else(|_| LogicalSize::new(dev.width, dev.height + CHROME_H));
    let inset = frame_t();
    let x = if active { inset } else { PARK_X };
    let _webview = win
        .add_child(
            content,
            LogicalPosition::new(x, CHROME_H),
            LogicalSize::new(
                (ls.width - (inset * 2.0)).max(50.0),
                (ls.height - CHROME_H - inset).max(50.0),
            ),
        )
        .map_err(|e| format!("page webview: {e}"))?;
    // GTK packs child webviews into the window's vbox, where set_position is a
    // no-op (see layout_children), so a tiled bar cannot park a tab offscreen —
    // inactive tabs are hidden instead and the vbox gives their space to the
    // active one.
    #[cfg(target_os = "linux")]
    if !chrome_overlaps_page() {
        let _ = _webview.with_webview(linux_expand_page);
    }
    if !chrome_overlaps_page() && !active {
        let _ = _webview.hide();
    }
    #[cfg(windows)]
    if !private_session {
        let _ = _webview.with_webview(win_enable_web_credentials);
    }
    #[cfg(target_os = "linux")]
    if !private_session {
        let _ = _webview.with_webview(|platform| linux_enable_web_credentials(&platform));
    }
    Ok(())
}

/// Open a fresh tab and optionally make it active. Agent-created tabs default
/// to background; user/new-window requests select their new tab.
#[cfg(target_os = "linux")]
fn reuse_retired_linux_tab(
    app: &tauri::AppHandle,
    parsed: tauri::Url,
    activate: bool,
) -> Result<Option<u64>, String> {
    let id = {
        let mut retired = RETIRED_LINUX_TABS.lock().unwrap_or_else(|p| p.into_inner());
        let position = retired.iter().rposition(|id| {
            app.get_window(&tab_label(*id)).is_some() && app.get_webview(&tab_label(*id)).is_some()
        });
        position.map(|index| retired.remove(index))
    };
    let Some(id) = id else { return Ok(None) };
    let previous_active = {
        let mut guard = TABS.lock().unwrap_or_else(|p| p.into_inner());
        let tabs = guard
            .as_mut()
            .ok_or_else(|| "browser has no tab session".to_string())?;
        let previous = tabs.active;
        tabs.order.push(id);
        tabs.titles.remove(&id);
        tabs.private_tabs.remove(&id);
        if activate {
            tabs.active = id;
        }
        previous
    };
    if let Err(error) = app
        .get_webview(&tab_label(id))
        .ok_or_else(|| "retired browser page is unavailable".to_string())?
        .navigate(parsed)
        .map_err(|e| format!("navigate failed: {e}"))
    {
        let mut guard = TABS.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(tabs) = guard.as_mut() {
            tabs.order.retain(|tab| *tab != id);
            tabs.private_tabs.remove(&id);
            tabs.active = previous_active;
        }
        RETIRED_LINUX_TABS
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(id);
        return Err(error);
    }
    if activate {
        activate_tab(app, id);
        update_chrome_bar(app, Some(""), Some(""));
    } else if let Some(window) = app.get_window(&tab_label(id)) {
        let _ = window.hide();
    }
    sync_tabs(app);
    Ok(Some(id))
}

fn new_tab(
    app: &tauri::AppHandle,
    url: &str,
    activate: bool,
    private_session: bool,
) -> Result<u64, String> {
    let framed = app.get_webview(CHROME_LABEL).is_some();
    let win = framed.then(|| get_window(app)).flatten();
    if TABS.lock().unwrap_or_else(|p| p.into_inner()).is_none() {
        return Err("browser has no tab session".to_string());
    }
    let parsed: tauri::Url = url.parse().map_err(|e| format!("bad url {url:?}: {e}"))?;
    validate_provider_auth_url(&parsed)?;
    #[cfg(target_os = "linux")]
    if !private_session && !framed {
        if let Some(id) = reuse_retired_linux_tab(app, parsed.clone(), activate)? {
            return Ok(id);
        }
    }
    let id = NEXT_TAB.fetch_add(1, Ordering::SeqCst);
    let mut previous_active = None;
    {
        let mut guard = TABS.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(tabs) = guard.as_mut() {
            previous_active = Some(tabs.active);
            tabs.order.push(id);
            if private_session {
                tabs.private_tabs.insert(id);
            }
            if activate {
                tabs.active = id;
            }
        }
    }
    let attached = if let Some(win) = win.as_ref() {
        attach_tab(app, win, parsed, id, activate, private_session)
    } else {
        attach_legacy_tab(app, parsed, id, activate, private_session)
    };
    if let Err(error) = attached {
        let mut guard = TABS.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(tabs) = guard.as_mut() {
            tabs.order.retain(|tab| *tab != id);
            tabs.titles.remove(&id);
            tabs.private_tabs.remove(&id);
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
    sync_tabs(app);
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
        .map(|url| public_browser_url(url.as_str()))
        .unwrap_or_default();
    let title = TABS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .and_then(|t| t.titles.get(&id).cloned())
        .unwrap_or_default();
    update_chrome_bar(app, Some(&url), Some(&title));
    sync_tabs(app);
}

/// Close one tab; closing the last tab stops the browser. Linux retires native
/// WebKitGTK windows for reuse because destroying one can abort the whole app.
fn close_tab(app: &tauri::AppHandle, id: u64) {
    #[cfg(not(target_os = "linux"))]
    let target_window = app
        .get_window(BROWSER_LABEL)
        .or_else(|| app.get_window(&tab_label(id)));
    // Read the page BEFORE the strip loses it, and outside the TABS lock —
    // list_tabs takes that same lock.
    let closing_url = list_tabs(app)
        .into_iter()
        .find(|tab| tab.id == id)
        .map(|tab| tab.url)
        .unwrap_or_default();
    let (next, _private_session) = {
        let mut guard = TABS.lock().unwrap_or_else(|p| p.into_inner());
        let Some(tabs) = guard.as_mut() else { return };
        if !tabs.order.contains(&id) {
            return;
        }
        let private_session = tabs.private_tabs.contains(&id);
        let Some(next) = next_active_after_close(&tabs.order, id, tabs.active) else {
            drop(guard);
            // Closing the last tab is a deliberate "put the browser away": keep
            // the pages for the next project open, but don't self-reopen.
            persist_session(app);
            mark_session_closed();
            #[cfg(target_os = "linux")]
            {
                let _ = suspend_linux_browser(app);
            }
            #[cfg(not(target_os = "linux"))]
            {
                *TABS.lock().unwrap_or_else(|p| p.into_inner()) = None;
                if let Some(win) = target_window {
                    let _ = win.destroy();
                }
            }
            return;
        };
        tabs.order.retain(|t| *t != id);
        tabs.titles.remove(&id);
        tabs.private_tabs.remove(&id);
        tabs.active = next;
        (next, private_session)
    };
    // Closing the last tab keeps the whole set in `tabs` (it is persisted
    // above, before teardown), so only a mid-strip ✕ needs the undo record.
    remember_closed_tab(&closing_url);
    if app.get_webview(CHROME_LABEL).is_some() {
        if let Some(wv) = app.get_webview(&tab_label(id)) {
            let _ = wv.close();
        }
    } else {
        #[cfg(target_os = "linux")]
        retire_linux_tab(app, id, _private_session);
        #[cfg(not(target_os = "linux"))]
        if let Some(window) = app.get_window(&tab_label(id)) {
            let _ = window.destroy();
        }
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
        tabs.private_tabs.remove(&id);
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
            .map(|u| public_browser_url(u.as_str()))
            .unwrap_or_default();
        update_chrome_bar(app, Some(&url), Some(title));
    }
    sync_tabs(app);
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
                    // The strip draws every page's own brand mark, open or not,
                    // so each pill needs its url — not just the active one's.
                    "url": app
                        .get_webview(&tab_label(*id))
                        .and_then(|wv| wv.url().ok())
                        .map(|url| public_browser_url(url.as_str()))
                        .unwrap_or_default(),
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
fn build_window(
    app: &tauri::AppHandle,
    url: tauri::Url,
    private_session: bool,
) -> Result<(), String> {
    // Every platform gets the same app-styled window. Linux used to be routed to
    // build_legacy because the STACKED shape mislays child webviews on WebKitGTK:
    // Tauri packs them into the window's GtkBox (tauri-runtime-wry lib.rs
    // build_gtk(default_vbox) → wry pack_start), where set_position/set_size are
    // no-ops and the box splits the window between them. That is a layout
    // mismatch, not a broken engine — with the bar TILED above the page
    // (chrome_overlaps_page() == false) the same chrome bar works, verified on
    // Jetson/Tegra WebKitGTK 2.52: `+`, tab strip, URL bar and resize all behave.
    {
        match build_framed(app, url.clone(), private_session) {
            Ok(()) => Ok(()),
            Err(e) => {
                eprintln!("[browser] app-styled window failed ({e}); using the decorated fallback");
                if let Some(w) = get_window(app) {
                    let _ = w.destroy();
                }
                build_legacy(app, url, private_session)
            }
        }
    }
}

/// The app-styled browser: frameless Window + chrome-bar webview + page webview.
/// Every platform uses this shape; build_legacy() is only the fallback when it
/// fails to build. On Linux the bar is TILED above the page rather than stacked
/// over it, because Tauri packs child webviews into a GtkBox (see build_window).
fn build_framed(
    app: &tauri::AppHandle,
    url: tauri::Url,
    private_session: bool,
) -> Result<(), String> {
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
    // An undecorated window is resizable only where something still hit-tests
    // its edges. Both of these run before the webviews exist so the very first
    // frame is already resizable.
    #[cfg(target_os = "macos")]
    on_ui_thread(&win, mac_enable_native_resize)?;
    #[cfg(target_os = "linux")]
    on_ui_thread(&win, linux_expose_resize_edges)?;

    // Chrome bar — app origin (shares the UI's localStorage theme). Its
    // buttons/drag/URL box/tab strip use a reserved same-origin navigation as
    // an event envelope. We intercept and cancel it before any document load;
    // no IPC grant to this webview is needed.
    let chrome_navigation_app = app.clone();
    // `overlay` tells the bar whether it spans the whole window. Only then do
    // its edge grips sit on the window's real edges; where the bar is TILED
    // (Linux) its bottom is the middle of the window, so a "south" grip there
    // would resize from the wrong edge — that shape uses the GTK resize edge
    // (linux_expose_resize_edges) instead.
    let chrome_url = format!(
        "browser-chrome.html?overlay={}",
        if chrome_overlaps_page() { "1" } else { "0" }
    );
    let chrome = WebviewBuilder::new(CHROME_LABEL, WebviewUrl::App(chrome_url.into()))
        .background_color(OWLLM_BG)
        .on_navigation(move |url| {
            let Some((action, data)) = parse_chrome_navigation(url) else {
                return true;
            };
            queue_browser_ui(
                &chrome_navigation_app,
                BrowserUiEvent::ChromeAction { action, data },
            );
            false
        })
        // The strip renders from Rust pushes — seed it once the bar exists.
        .on_page_load(|wv, _payload| {
            queue_browser_ui(&wv.app_handle().clone(), BrowserUiEvent::PushTabs);
        });
    let _chrome_webview = win
        .add_child(
            chrome,
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(
                win_w,
                if chrome_overlaps_page() { win_h } else { CHROME_H },
            ),
        )
        .map_err(|e| format!("chrome bar webview: {e}"))?;
    // GTK ignores the geometry above (see layout_children), so pin the bar's
    // height in the box itself — otherwise the box splits the window evenly
    // between the bar and the page.
    #[cfg(target_os = "linux")]
    if !chrome_overlaps_page() {
        let _ = _chrome_webview.with_webview(linux_pin_chrome_bar);
    }

    // First tab. Further tabs come from the chrome bar's "+" (tabnew event).
    let first = NEXT_TAB.fetch_add(1, Ordering::SeqCst);
    *TABS.lock().unwrap_or_else(|p| p.into_inner()) = Some(Tabs {
        order: vec![first],
        active: first,
        titles: HashMap::new(),
        private_tabs: if private_session {
            HashSet::from([first])
        } else {
            HashSet::new()
        },
    });
    attach_tab(app, &win, url, first, true, private_session)?;

    // Keep the children glued to the window on resize/maximize, and drop the
    // tab state when the window goes away (✕, browser_stop, device rebuild).
    // Resize work is QUEUED — layout_children does set_position/set_size,
    // which must never run inside a native window callback (UI-thread gate).
    let handle = app.clone();
    win.on_window_event(move |ev| {
        match ev {
            WindowEvent::Resized(size) => {
                queue_browser_ui(
                    &handle,
                    BrowserUiEvent::Layout {
                        width: size.width,
                        height: size.height,
                    },
                );
            }
            WindowEvent::Destroyed => {
                // Pure state drop — no window/webview work.
                *TABS.lock().unwrap_or_else(|p| p.into_inner()) = None;
            }
            _ => {}
        }
    });

    on_ui_thread(&win, apply_chrome)?;
    update_chrome_bar(app, Some(&public_browser_url(&start_url)), None);
    sync_tabs(app);
    Ok(())
}

/// Re-fit the chrome bar + page webviews to a new window size. The active
/// tab is seated under the chrome bar; the rest stay parked offscreen.
fn layout_children(app: &tauri::AppHandle, size: tauri::PhysicalSize<u32>) {
    let Some(win) = get_window(app) else { return };
    let scale = win.scale_factor().unwrap_or(1.0);
    let ls = size.to_logical::<f64>(scale);
    let inset = frame_t();
    if let Some(chrome) = app.get_webview(CHROME_LABEL) {
        let _ = chrome.set_position(LogicalPosition::new(0.0, 0.0));
        let _ = chrome.set_size(LogicalSize::new(
            ls.width,
            if chrome_overlaps_page() {
                ls.height
            } else {
                CHROME_H
            },
        ));
    }
    let page = LogicalSize::new(
        (ls.width - (inset * 2.0)).max(50.0),
        (ls.height - CHROME_H - inset).max(50.0),
    );
    let (order, active) = {
        let guard = TABS.lock().unwrap_or_else(|p| p.into_inner());
        match guard.as_ref() {
            Some(t) => (t.order.clone(), t.active),
            None => (Vec::new(), 0),
        }
    };
    for id in order {
        if let Some(content) = app.get_webview(&tab_label(id)) {
            // GTK (tiled bar): child webviews live in the window's vbox, which
            // ignores set_position/set_size — the box itself tiles them in the
            // order they were added. Switch tabs by visibility instead, so the
            // active page takes the whole area under the bar.
            if !chrome_overlaps_page() {
                let _ = if id == active {
                    content.show()
                } else {
                    content.hide()
                };
                continue;
            }
            let x = if id == active { inset } else { PARK_X };
            let _ = content.set_position(LogicalPosition::new(x, CHROME_H));
            let _ = content.set_size(page);
        }
    }
    // Legacy single-webview shape (no tab state).
    if let Some(content) = app.get_webview(CONTENT_LABEL) {
        let _ = content.set_position(LogicalPosition::new(inset, CHROME_H));
        let _ = content.set_size(page);
    }
}

/// Safe decorated top-level-WebView tab shape used by Linux/WebKitGTK.
fn build_legacy(
    app: &tauri::AppHandle,
    url: tauri::Url,
    private_session: bool,
) -> Result<(), String> {
    let first = NEXT_TAB.fetch_add(1, Ordering::SeqCst);
    *TABS.lock().unwrap_or_else(|p| p.into_inner()) = Some(Tabs {
        order: vec![first],
        active: first,
        titles: HashMap::new(),
        private_tabs: if private_session {
            HashSet::from([first])
        } else {
            HashSet::new()
        },
    });
    if let Err(error) = attach_legacy_tab(app, url, first, true, private_session) {
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
    private_session: bool,
) -> Result<(), String> {
    let dev = current_device();
    let new_window_app = app.clone();
    #[cfg(target_os = "linux")]
    let requested_url = url.to_string();
    #[cfg(target_os = "linux")]
    let initial_url = WebviewUrl::External(
        "about:blank"
            .parse()
            .expect("about:blank is always a valid URL"),
    );
    #[cfg(not(target_os = "linux"))]
    let initial_url = WebviewUrl::External(url);
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, tab_label(id), initial_url)
        .title("OwLLM — Agent Browser")
        .inner_size(dev.width, dev.height)
        .initialization_script(BRIDGE_JS)
        // Credential scanning must reach IFRAMES too — the plain
        // initialization_script above is main-frame-only.
        .initialization_script_for_all_frames(FRAME_CRED_JS)
        .on_new_window(move |url, _features| {
            // Same opener-preserving OAuth popup rule as the framed shape.
            if is_opener_dependent_popup(&url) {
                return NewWindowResponse::Allow;
            }
            queue_browser_ui(
                &new_window_app,
                BrowserUiEvent::OpenTab {
                    url: url.to_string(),
                    activate: true,
                    private_session,
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
        .on_page_load(move |win, payload| {
            // Vault autofill works in this top-level-window shape too.
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                if private_session {
                    if let Some(code) = claude_auth_code_from_callback(payload.url()) {
                        queue_browser_ui(
                            &win.app_handle().clone(),
                            BrowserUiEvent::ClaudeAuthCode { code },
                        );
                    }
                }
                let url = payload.url().to_string();
                if !private_session && url.starts_with("http") {
                    queue_browser_ui(
                        &win.app_handle().clone(),
                        BrowserUiEvent::AutofillPage { id, url },
                    );
                }
            }
        })
        .background_color(OWLLM_BG)
        .theme(Some(tauri::Theme::Dark))
        .decorations(true)
        .resizable(true)
        .visible(active);
    if private_session {
        builder = builder.incognito(true);
    }
    if let Some(ua) = device_user_agent(dev) {
        builder = builder.user_agent(&ua);
    }
    if let Ok(Some(m)) = app.primary_monitor() {
        let ls = m.size().to_logical::<f64>(m.scale_factor());
        let x = ((ls.width - dev.width) / 2.0).max(0.0);
        let y = ((ls.height - dev.height) / 2.0).max(12.0);
        builder = builder.position(x, y);
    }
    #[cfg(any(windows, target_os = "linux"))]
    {
        if private_session {
            let dir = private_auth_data_dir(id);
            let _ = std::fs::create_dir_all(&dir);
            builder = builder.data_directory(dir);
        } else if let Some(dir) = browser_data_dir() {
            let _ = std::fs::create_dir_all(&dir);
            builder = builder.data_directory(dir);
        }
    }
    let _ww = builder
        .build()
        .map_err(|e| format!("failed to open agent browser window: {e}"))?;
    #[cfg(windows)]
    if !private_session {
        let _ = _ww.with_webview(win_enable_web_credentials);
    }
    #[cfg(target_os = "linux")]
    {
        let _ = _ww.with_webview(move |platform| {
            linux_configure_browser_webview(platform, requested_url, private_session)
        });
    }
    if let Some(win) = app.get_window(&tab_label(id)) {
        let _ = on_ui_thread(&win, apply_chrome);
        let handle = app.clone();
        win.on_window_event(move |event| {
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    #[cfg(target_os = "linux")]
                    {
                        // A native destroy can terminate OwLLM with X11
                        // BadDrawable on NVIDIA/Tegra. Close the logical tab
                        // through the dispatcher and retain the native WebView.
                        api.prevent_close();
                        queue_browser_ui(&handle, BrowserUiEvent::LegacyTabCloseRequested { id });
                    }
                    #[cfg(not(target_os = "linux"))]
                    let _ = api;
                }
                WindowEvent::Destroyed => {
                    queue_browser_ui(&handle, BrowserUiEvent::LegacyTabDestroyed { id });
                }
                _ => {}
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
        if browser_is_suspended() {
            resume_normal_browser(app, browser_home_url(app)?)?;
            return Ok("browser started".to_string());
        }
        return Ok("browser already running".to_string());
    }
    let start_url = browser_home_url(app)?;
    build_window(app, start_url, false)?;
    BROWSER_SUSPENDED.store(false, Ordering::SeqCst);
    Ok("browser started".to_string())
}

/// Open an http(s) URL in OwLLM's persistent browser window.
///
/// This is the single entry point for user-facing web links throughout the
/// desktop app. It deliberately does not wait for the page bridge: buttons
/// such as "Get a token" must return immediately even when the destination is
/// a slow login page. Agent browser tools continue to use `browser_cmd`, which
/// waits for the document because they need to interact with its contents.
fn validate_provider_auth_url(url: &tauri::Url) -> Result<(), String> {
    let has_param = |name: &str| {
        url.query_pairs()
            .any(|(key, value)| key == name && !value.trim().is_empty())
    };
    match (url.host_str(), url.path()) {
        (Some("claude.ai"), "/oauth/authorize")
        | (Some("claude.com"), "/cai/oauth/authorize") => {
            let missing = ["client_id", "redirect_uri", "code_challenge", "state"]
                .into_iter()
                .filter(|name| !has_param(name))
                .collect::<Vec<_>>();
            if !missing.is_empty() {
                return Err(format!(
                    "incomplete Claude authorization URL (missing {}); waiting for the CLI to print the complete URL",
                    missing.join(", ")
                ));
            }
        }
        (Some("www.kimi.com"), "/code/authorize_device") if !has_param("user_code") => {
            return Err(
                "incomplete Kimi authorization URL (missing user_code); waiting for the CLI to print the complete URL"
                    .to_string(),
            );
        }
        _ => {}
    }
    if matches!(url.host_str(), Some("claude.ai") | Some("claude.com"))
        && url.path() == "/login"
    {
        if let Some((_, return_to)) = url
            .query_pairs()
            .find(|(key, value)| key == "returnTo" && !value.trim().is_empty())
        {
            let nested = url
                .join(&return_to)
                .map_err(|error| format!("invalid Claude login returnTo URL: {error}"))?;
            if matches!(
                (nested.host_str(), nested.path()),
                (Some("claude.ai"), "/oauth/authorize")
                    | (Some("claude.com"), "/cai/oauth/authorize")
            ) {
                validate_provider_auth_url(&nested)?;
            }
        }
    }
    Ok(())
}

fn is_private_tab(id: u64) -> bool {
    TABS.lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .is_some_and(|tabs| tabs.private_tabs.contains(&id))
}

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
    validate_provider_auth_url(&parsed)?;
    Ok(parsed)
}

pub(crate) fn open_web_url(app: &tauri::AppHandle, raw_url: &str) -> Result<String, String> {
    let url = raw_url.trim();
    let parsed = parse_web_url(url)?;

    let _operation = lock_browser_operation();
    let tab_id = if browser_is_suspended() && get_window(app).is_some() {
        Some(resume_normal_browser(app, parsed)?)
    } else if get_window(app).is_none() {
        build_window(app, parsed, false)?;
        BROWSER_SUSPENDED.store(false, Ordering::SeqCst);
        active_tab_id()
    } else if TABS.lock().unwrap_or_else(|p| p.into_inner()).is_some() {
        Some(new_tab(app, parsed.as_str(), true, false)?)
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
    let parsed = full.parse().map_err(|e| format!("bad url {full:?}: {e}"))?;
    validate_provider_auth_url(&parsed)?;
    Ok(parsed)
}

/// Turn Claude's browser callback into the exact line requested by
/// `claude auth login`: `<code>#<state>`. The callback is accepted only from
/// Anthropic's fixed HTTPS origin/path and only for bounded base64url-like
/// values, so an ordinary page cannot type arbitrary text into a login PTY.
fn claude_auth_code_from_callback(url: &tauri::Url) -> Option<String> {
    if url.scheme() != "https"
        || url.host_str() != Some("platform.claude.com")
        || url.path().trim_end_matches('/') != "/oauth/code/callback"
    {
        return None;
    }
    let mut code = None;
    let mut state = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" if code.is_none() => code = Some(value.into_owned()),
            "state" if state.is_none() => state = Some(value.into_owned()),
            _ => {}
        }
    }
    let valid = |value: &str| {
        (16..=1024).contains(&value.len())
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    };
    let (code, state) = (code?, state?);
    if !valid(&code) || !valid(&state) {
        return None;
    }
    Some(format!("{code}#{state}"))
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
    let id = if browser_is_suspended() && get_window(&app).is_some() {
        resume_normal_browser(&app, parsed)?
    } else if get_window(&app).is_none() {
        build_window(&app, parsed, false)?;
        BROWSER_SUSPENDED.store(false, Ordering::SeqCst);
        active_tab_id().unwrap_or(0)
    } else if TABS.lock().unwrap_or_else(|p| p.into_inner()).is_some() {
        new_tab(&app, parsed.as_str(), activate, false)?
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

/// Open a new tab on the OwLLM start page — the chrome bar's "+" as a command
/// so BrowserPanel can offer it too. Linux has no chrome bar at all (WebKitGTK
/// cannot host the stacked webviews it is built from — see build_window), so on
/// that platform this command is the only "+" there is.
#[tauri::command(async)]
pub fn browser_new_tab(app: tauri::AppHandle) -> Result<String, String> {
    let _operation = lock_browser_operation();
    let home = browser_home_url(&app)?;
    let id = if get_window(&app).is_none() {
        build_window(&app, home, false)?;
        BROWSER_SUSPENDED.store(false, Ordering::SeqCst);
        active_tab_id().unwrap_or(0)
    } else if browser_is_suspended() {
        resume_normal_browser(&app, home)?
    } else {
        new_tab(&app, home.as_str(), true, false)?
    };
    Ok(json!({ "tab_id": id }).to_string())
}

/// Reopen the page that was closed last — the ↺ button and Ctrl+Shift+T.
#[tauri::command(async)]
pub fn browser_reopen_closed(app: tauri::AppHandle) -> Result<String, String> {
    let stem = live_session_stem();
    let mut session = read_session(&stem);
    let Some(url) = session.closed.pop() else {
        return Err("no recently closed page to reopen".to_string());
    };
    // Take it off the record first: a page that fails to reopen must not sit at
    // the head of the history and swallow every later press.
    write_session(&stem, &session);
    browser_open_tab(app, url, Some(true))
}

/// Reopen every page this browser had open. Tabs that belong to no project
/// have no project screen to restore them from, so this is the only way back
/// to a desk of logged-in apps after the window was closed.
#[tauri::command(async)]
pub fn browser_session_reopen(app: tauri::AppHandle) -> Result<String, String> {
    let stem = live_session_stem();
    let session = read_session(&stem);
    if session.tabs.is_empty() {
        return Err("no saved browser pages to reopen".to_string());
    }
    let already: std::collections::HashSet<String> =
        list_tabs(&app).into_iter().map(|tab| tab.url).collect();
    let mut reopened = 0usize;
    let mut failed: Vec<String> = Vec::new();
    for (index, url) in session.tabs.iter().enumerate() {
        if already.contains(url) {
            continue;
        }
        // One dead page must not cost the user the rest of the desk.
        match browser_open_tab(app.clone(), url.clone(), Some(index == session.active)) {
            Ok(_) => reopened += 1,
            Err(e) => failed.push(format!("{url}: {e}")),
        }
    }
    Ok(json!({
        "reopened": reopened,
        "tabs": session.tabs.len(),
        "failed": failed,
    })
    .to_string())
}

/// Open a provider authorization page without the persistent browser profile.
///
/// Subscription OAuth must never inherit the account used by Gmail, Calendar,
/// Claude Web, or another ordinary browser tab. The user may explicitly select
/// one identity from the encrypted local vault, but no ordinary browser cookie
/// or implicit first-account autofill is allowed into this flow.
#[tauri::command(async)]
pub fn browser_open_auth_tab(app: tauri::AppHandle, url: String) -> Result<String, String> {
    let _operation = lock_browser_operation();
    let parsed = parse_navigation_url(&url)?;
    let id = if browser_is_suspended() && get_window(&app).is_some() {
        let old_id = active_tab_id();
        BROWSER_SUSPENDED.store(false, Ordering::SeqCst);
        let id = new_tab(&app, parsed.as_str(), true, true)?;
        if let Some(old_id) = old_id.filter(|old_id| *old_id != id) {
            close_tab(&app, old_id);
        }
        id
    } else if get_window(&app).is_none() {
        build_window(&app, parsed, true)?;
        BROWSER_SUSPENDED.store(false, Ordering::SeqCst);
        active_tab_id().unwrap_or(0)
    } else {
        new_tab(&app, parsed.as_str(), true, true)?
    };
    if let Some(win) = get_window(&app) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
    Ok(json!({ "tab_id": id, "url": url, "active": true, "private": true }).to_string())
}

#[tauri::command(async)]
pub fn browser_list_tabs(app: tauri::AppHandle) -> Result<String, String> {
    if browser_is_suspended() {
        return Ok("[]".to_string());
    }
    Ok(serde_json::to_string(&list_tabs(&app)).map_err(|e| e.to_string())?)
}

#[tauri::command(async)]
pub fn browser_select_tab(app: tauri::AppHandle, tab_id: u64) -> Result<String, String> {
    let _operation = lock_browser_operation();
    if browser_is_suspended() {
        return Err("browser not running".to_string());
    }
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
    if browser_is_suspended() {
        return Err("browser not running".to_string());
    }
    if !list_tabs(&app).iter().any(|tab| tab.id == tab_id) {
        return Err(format!("browser tab {tab_id} does not exist"));
    }
    if tab_id == 0 {
        return browser_stop(app);
    }
    close_tab(&app, tab_id);
    Ok(format!("closed browser tab {tab_id}"))
}

#[cfg(target_os = "linux")]
fn apply_linux_device(app: &tauri::AppHandle, dev: &'static Device) -> Result<(), String> {
    let ids = TABS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(|tabs| tabs.order.clone())
        .unwrap_or_default();
    for id in ids {
        if let Some(webview) = app.get_webview(&tab_label(id)) {
            let user_agent = device_user_agent(dev).map(Cow::into_owned);
            webview
                .with_webview(move |platform| {
                    use webkit2gtk::{SettingsExt, WebViewExt};
                    if let Some(settings) = platform.inner().settings() {
                        settings.set_user_agent(user_agent.as_deref());
                    }
                    platform.inner().reload();
                })
                .map_err(|e| format!("apply browser user-agent: {e}"))?;
        }
        if let Some(window) = app.get_window(&tab_label(id)) {
            window
                .set_size(LogicalSize::new(dev.width, dev.height))
                .map_err(|e| format!("resize browser for {}: {e}", dev.name))?;
        }
    }
    if !browser_is_suspended() {
        if let Some(active) = active_tab_id() {
            activate_tab(app, active);
        }
    }
    Ok(())
}

/// Switch device emulation (desktop / iphone / android / tablet). Windows and
/// macOS rebuild the browser so the UA applies at construction. Linux updates
/// WebKitGTK settings in place because destroying a browser window can abort
/// the whole process on NVIDIA/Tegra.
#[tauri::command(async)]
pub fn browser_set_device(app: tauri::AppHandle, device: String) -> Result<String, String> {
    let _operation = lock_browser_operation();
    let dev = device_by_name(&device).ok_or_else(|| {
        format!("unknown device {device:?} — use desktop, iphone, android or tablet")
    })?;
    if current_device().name == dev.name {
        return Ok(format!("device already set to {}", dev.name));
    }
    *CURRENT_DEVICE.lock().unwrap_or_else(|p| p.into_inner()) = dev.name;

    let Some(_win) = get_window(&app) else {
        return Ok(format!(
            "device set to {} (applies when the browser opens)",
            dev.name
        ));
    };
    #[cfg(target_os = "linux")]
    {
        apply_linux_device(&app, dev)?;
        return Ok(format!(
            "device set to {} ({}횞{}{})",
            dev.name,
            dev.width as u32,
            dev.height as u32,
            if dev.ua.is_some() {
                ", mobile user-agent"
            } else {
                ""
            }
        ));
    }
    #[cfg(not(target_os = "linux"))]
    {
        // Remember every tab, tear down, rebuild with the new UA + viewport. Native
        // engine rebuilds reset history, but no background page is silently lost.
        let tabs_before = list_tabs(&app);
        let back_to = content_webview(&app)
            .and_then(|wv| wv.url().ok())
            .map(|u| u.to_string())
            .unwrap_or_default();
        destroy_browser_windows(&app)
            .map_err(|e| format!("could not rebuild browser window: {e}"))?;
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
        build_window(&app, parsed, false)?;
        for tab in tabs_before.iter().filter(|tab| !tab.active) {
            let restore_url = if tab.url.is_empty() {
                "about:blank"
            } else {
                &tab.url
            };
            if let Err(error) = new_tab(&app, restore_url, false, false) {
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
}

const MAX_BROWSER_UPLOAD_BYTES: u64 = 25 * 1024 * 1024;
const UPLOAD_CHUNK_BYTES: usize = 96 * 1024; // divisible by 3: independently-decodable base64

fn arg_u64(value: Option<&Value>) -> Option<u64> {
    value.and_then(|value| {
        value
            .as_u64()
            .or_else(|| value.as_str().and_then(|raw| raw.parse().ok()))
    })
}

fn browser_upload_path(params: &Value) -> Result<std::path::PathBuf, String> {
    let raw = params
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| "browser_upload_file requires a file path".to_string())?;
    let path = std::path::Path::new(raw);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        let cwd = params
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|cwd| !cwd.is_empty())
            .ok_or_else(|| "relative upload paths require the project cwd".to_string())?;
        std::path::Path::new(&crate::agent_tools::host_cwd(cwd)).join(path)
    };
    let resolved = resolved
        .canonicalize()
        .map_err(|e| format!("cannot open upload file {}: {e}", resolved.display()))?;
    let meta = resolved
        .metadata()
        .map_err(|e| format!("cannot inspect upload file {}: {e}", resolved.display()))?;
    if !meta.is_file() {
        return Err(format!("upload path is not a file: {}", resolved.display()));
    }
    if meta.len() > MAX_BROWSER_UPLOAD_BYTES {
        return Err(format!(
            "browser upload is capped at 25 MiB to keep the shared WebView responsive; {} is {:.1} MiB",
            resolved.display(),
            meta.len() as f64 / 1_048_576.0
        ));
    }
    Ok(resolved)
}

fn browser_upload_mime(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" | "log" | "md" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "zip" => "application/zip",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

fn wait_for_direct_reply(
    win: &Webview,
    req: u64,
    action: &str,
    timeout: Duration,
) -> Result<String, String> {
    let start = Instant::now();
    loop {
        if let Some(payload) = take_if_complete(req) {
            let out = decode_b64(&payload);
            if let Some(message) = out.strip_prefix("ERROR: ") {
                return Err(message.to_string());
            }
            return Ok(out);
        }
        if let Some((total, have)) = reply_progress(req) {
            if total > 1 {
                if let Some(k) = (0..total).find(|k| !have.contains(k)) {
                    let _ = win.eval(&format!(
                        "try{{window.__owllmEmit&&window.__owllmEmit({req},{k})}}catch(e){{}}"
                    ));
                }
            }
        }
        if start.elapsed() > timeout {
            return Err(format!(
                "browser action '{action}' timed out — the page may have navigated; snapshot and try again"
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn upload_file_to_page(win: &Webview, req: u64, params: &Value) -> Result<String, String> {
    use base64::Engine as _;

    let path = browser_upload_path(params)?;
    let bytes =
        std::fs::read(&path).map_err(|e| format!("read upload file {}: {e}", path.display()))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "upload filename is not valid Unicode".to_string())?;
    let index = arg_u64(params.get("index"));
    let token = format!("upload-{req}");
    let start = format!(
        "try{{window.__owllmUploadStart&&window.__owllmUploadStart({},{},{},{})}}catch(e){{}}",
        serde_json::to_string(&token).unwrap(),
        index.map_or_else(|| "null".to_string(), |index| index.to_string()),
        serde_json::to_string(name).unwrap(),
        serde_json::to_string(browser_upload_mime(&path)).unwrap(),
    );
    win.eval(&start)
        .map_err(|e| format!("start browser upload: {e}"))?;
    for chunk in bytes.chunks(UPLOAD_CHUNK_BYTES) {
        let encoded = base64::engine::general_purpose::STANDARD.encode(chunk);
        win.eval(&format!(
            "try{{window.__owllmUploadChunk&&window.__owllmUploadChunk({},{})}}catch(e){{}}",
            serde_json::to_string(&token).unwrap(),
            serde_json::to_string(&encoded).unwrap(),
        ))
        .map_err(|e| format!("stream browser upload: {e}"))?;
    }
    win.eval(&format!(
        "try{{window.__owllmUploadFinish&&window.__owllmUploadFinish({req},{})}}catch(e){{}}",
        serde_json::to_string(&token).unwrap(),
    ))
    .map_err(|e| format!("finish browser upload: {e}"))?;
    wait_for_direct_reply(win, req, "upload_file", Duration::from_secs(30))
}

fn prune_browser_captures(dir: &std::path::Path) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    let mut captures = read
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            entry.path().is_file() && name.starts_with("browser-") && name.ends_with(".png")
        })
        .filter_map(|entry| {
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, entry.path()))
        })
        .collect::<Vec<_>>();
    captures.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    for (index, (modified, path)) in captures.into_iter().enumerate() {
        let expired = modified
            .elapsed()
            .map(|age| age > Duration::from_secs(7 * 24 * 60 * 60))
            .unwrap_or(false);
        if index >= 50 || expired {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[derive(Deserialize)]
#[cfg_attr(not(windows), allow(dead_code))]
struct PageCaptureMetrics {
    width: u32,
    height: u32,
}

const MAX_FULL_PAGE_PIXELS: f64 = 80_000_000.0;

fn full_page_scale(metrics: &PageCaptureMetrics) -> Result<f64, String> {
    if metrics.width == 0 || metrics.height == 0 {
        return Err("page reported an empty document".into());
    }
    let area = metrics.width as f64 * metrics.height as f64;
    let scale = (MAX_FULL_PAGE_PIXELS / area).sqrt().min(1.0);
    if scale < 0.1 {
        return Err(format!(
            "page is too large to capture safely ({}x{} CSS pixels)",
            metrics.width, metrics.height
        ));
    }
    Ok(scale)
}

fn save_browser_capture(
    app: &tauri::AppHandle,
    png: &[u8],
    width: u32,
    height: u32,
    scope: &str,
    tab_id: Option<u64>,
    req: u64,
) -> Result<String, String> {
    crate::support::png_dimensions(png)?;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("browser capture cache: {e}"))?
        .join("browser-screenshots");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create browser capture cache {}: {e}", dir.display()))?;
    prune_browser_captures(&dir);
    let path = dir.join(format!(
        "browser-{scope}-{}-{req}.png",
        chrono::Utc::now().format("%Y%m%d-%H%M%S-%3f")
    ));
    let temporary = path.with_extension("png.tmp");
    std::fs::write(&temporary, png)
        .map_err(|e| format!("write browser screenshot {}: {e}", temporary.display()))?;
    if let Err(error) = std::fs::rename(&temporary, &path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!(
            "finish browser screenshot {}: {error}",
            path.display()
        ));
    }
    Ok(json!({
        "path": path.to_string_lossy(),
        "width": width,
        "height": height,
        "scope": scope,
        "tab_id": tab_id,
    })
    .to_string())
}

#[cfg(windows)]
fn call_webview2_devtools(webview: &Webview, method: &str, params: &str) -> Result<String, String> {
    use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, CoTaskMemPWSTR};

    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    let method = method.to_string();
    let params = params.to_string();
    webview
        .with_webview(move |platform| {
            let immediate_tx = tx.clone();
            let result = (|| -> Result<(), String> {
                let core = unsafe { platform.controller().CoreWebView2() }
                    .map_err(|e| format!("get WebView2 core: {e}"))?;
                let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |status, payload| {
                        let value = status
                            .map(|_| payload)
                            .map_err(|e| format!("WebView2 DevTools call failed: {e}"));
                        let _ = tx.send(value);
                        Ok(())
                    },
                ));
                let method_wide = CoTaskMemPWSTR::from(method.as_str());
                let params_wide = CoTaskMemPWSTR::from(params.as_str());
                unsafe {
                    core.CallDevToolsProtocolMethod(
                        *method_wide.as_ref().as_pcwstr(),
                        *params_wide.as_ref().as_pcwstr(),
                        &callback,
                    )
                }
                .map_err(|e| format!("start WebView2 DevTools call: {e}"))?;
                Ok(())
            })();
            if let Err(error) = result {
                let _ = immediate_tx.send(Err(error));
            }
        })
        .map_err(|e| format!("schedule WebView2 snapshot: {e}"))?;
    rx.recv_timeout(Duration::from_secs(30))
        .map_err(|_| "WebView2 full-page screenshot timed out".to_string())?
}

#[cfg(windows)]
fn capture_full_page_png(
    webview: &Webview,
    metrics: &PageCaptureMetrics,
) -> Result<(Vec<u8>, u32, u32), String> {
    use base64::Engine as _;

    let scale = full_page_scale(metrics)?;
    let params = json!({
        "format": "png",
        "fromSurface": true,
        "captureBeyondViewport": true,
        "clip": {
            "x": 0,
            "y": 0,
            "width": metrics.width,
            "height": metrics.height,
            "scale": scale,
        }
    })
    .to_string();
    let raw = call_webview2_devtools(webview, "Page.captureScreenshot", &params)?;
    let data = serde_json::from_str::<Value>(&raw)
        .map_err(|e| format!("parse WebView2 screenshot response: {e}"))?
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| "WebView2 screenshot response contained no PNG data".to_string())?
        .to_string();
    let png = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("decode WebView2 screenshot: {e}"))?;
    let (width, height) = crate::support::png_dimensions(&png)?;
    Ok((png, width, height))
}

/// Render the one-page PDF returned by WKWebView into a bounded RGBA bitmap.
/// CoreGraphics is used directly so this remains installer-local and does not
/// shell out to Preview, `sips`, ImageMagick, or another GUI process.
#[cfg(target_os = "macos")]
fn render_macos_pdf(
    pdf: &[u8],
    metrics: &PageCaptureMetrics,
) -> Result<(Vec<u8>, u32, u32), String> {
    use std::ffi::c_void;

    type CFDataRef = *const c_void;
    type CGColorSpaceRef = *mut c_void;
    type CGContextRef = *mut c_void;
    type CGDataProviderRef = *mut c_void;
    type CGPDFDocumentRef = *mut c_void;
    type CGPDFPageRef = *mut c_void;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFDataCreate(allocator: *const c_void, bytes: *const u8, length: isize) -> CFDataRef;
        fn CFRelease(value: *const c_void);
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGDataProviderCreateWithCFData(data: CFDataRef) -> CGDataProviderRef;
        fn CGDataProviderRelease(provider: CGDataProviderRef);
        fn CGPDFDocumentCreateWithProvider(provider: CGDataProviderRef) -> CGPDFDocumentRef;
        fn CGPDFDocumentRelease(document: CGPDFDocumentRef);
        fn CGPDFDocumentGetPage(document: CGPDFDocumentRef, page: usize) -> CGPDFPageRef;
        fn CGColorSpaceCreateDeviceRGB() -> CGColorSpaceRef;
        fn CGColorSpaceRelease(space: CGColorSpaceRef);
        fn CGBitmapContextCreate(
            data: *mut c_void,
            width: usize,
            height: usize,
            bits_per_component: usize,
            bytes_per_row: usize,
            space: CGColorSpaceRef,
            bitmap_info: u32,
        ) -> CGContextRef;
        fn CGContextRelease(context: CGContextRef);
        fn CGContextSetRGBFillColor(
            context: CGContextRef,
            red: f64,
            green: f64,
            blue: f64,
            alpha: f64,
        );
        fn CGContextFillRect(context: CGContextRef, rect: objc2_core_foundation::CGRect);
        fn CGContextTranslateCTM(context: CGContextRef, tx: f64, ty: f64);
        fn CGContextScaleCTM(context: CGContextRef, sx: f64, sy: f64);
        fn CGContextDrawPDFPage(context: CGContextRef, page: CGPDFPageRef);
    }

    let scale = full_page_scale(metrics)?;
    let width = ((metrics.width as f64 * scale).round() as u32).max(1);
    let height = ((metrics.height as f64 * scale).round() as u32).max(1);
    let stride = width as usize * 4;
    let mut rgba = vec![0u8; stride * height as usize];

    unsafe {
        let data = CFDataCreate(std::ptr::null(), pdf.as_ptr(), pdf.len() as isize);
        if data.is_null() {
            return Err("CoreFoundation could not read the WebKit PDF".into());
        }
        let provider = CGDataProviderCreateWithCFData(data);
        CFRelease(data);
        if provider.is_null() {
            return Err("CoreGraphics could not create a PDF data provider".into());
        }
        let document = CGPDFDocumentCreateWithProvider(provider);
        CGDataProviderRelease(provider);
        if document.is_null() {
            return Err("WebKit returned an invalid PDF snapshot".into());
        }
        let page = CGPDFDocumentGetPage(document, 1);
        if page.is_null() {
            CGPDFDocumentRelease(document);
            return Err("WebKit PDF snapshot contained no page".into());
        }
        let color_space = CGColorSpaceCreateDeviceRGB();
        if color_space.is_null() {
            CGPDFDocumentRelease(document);
            return Err("CoreGraphics could not create an RGB color space".into());
        }
        // kCGImageAlphaPremultipliedLast: RGBA, matching encode_png.
        let context = CGBitmapContextCreate(
            rgba.as_mut_ptr().cast(),
            width as usize,
            height as usize,
            8,
            stride,
            color_space,
            1,
        );
        CGColorSpaceRelease(color_space);
        if context.is_null() {
            CGPDFDocumentRelease(document);
            return Err("CoreGraphics could not allocate the screenshot bitmap".into());
        }
        let target = objc2_core_foundation::CGRect::new(
            objc2_core_foundation::CGPoint::ZERO,
            objc2_core_foundation::CGSize::new(width as f64, height as f64),
        );
        CGContextSetRGBFillColor(context, 1.0, 1.0, 1.0, 1.0);
        CGContextFillRect(context, target);
        CGContextTranslateCTM(context, 0.0, height as f64);
        CGContextScaleCTM(context, scale, -scale);
        CGContextDrawPDFPage(context, page);
        CGContextRelease(context);
        CGPDFDocumentRelease(document);
    }

    let png = crate::support::encode_png(&rgba, width, height)?;
    Ok((png, width, height))
}

#[cfg(target_os = "macos")]
fn capture_full_page_png(
    webview: &Webview,
    metrics: &PageCaptureMetrics,
) -> Result<(Vec<u8>, u32, u32), String> {
    use objc2::MainThreadMarker;
    use objc2_foundation::{NSData, NSError};
    use objc2_web_kit::{WKPDFConfiguration, WKWebView};

    full_page_scale(metrics)?;
    let capture_width = metrics.width;
    let capture_height = metrics.height;
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
    webview
        .with_webview(move |platform| {
            let Some(mtm) = MainThreadMarker::new() else {
                let _ = tx.send(Err(
                    "WKWebView capture was not scheduled on the main thread".into(),
                ));
                return;
            };
            let raw = platform.inner().cast::<WKWebView>();
            let Some(wkwebview) = (unsafe { raw.as_ref() }) else {
                let _ = tx.send(Err("WKWebView handle was unavailable".into()));
                return;
            };
            let configuration = unsafe { WKPDFConfiguration::new(mtm) };
            let rect = objc2_core_foundation::CGRect::new(
                objc2_core_foundation::CGPoint::ZERO,
                objc2_core_foundation::CGSize::new(capture_width as f64, capture_height as f64),
            );
            unsafe { configuration.setRect(rect) };
            let callback = block2::RcBlock::new(move |data: *mut NSData, error: *mut NSError| {
                let result = if let Some(data) = unsafe { data.as_ref() } {
                    Ok(data.to_vec())
                } else if let Some(error) = unsafe { error.as_ref() } {
                    Err(format!("WKWebView full-page PDF failed: {error:?}"))
                } else {
                    Err("WKWebView full-page PDF returned no data".into())
                };
                let _ = tx.send(result);
            });
            unsafe {
                wkwebview
                    .createPDFWithConfiguration_completionHandler(Some(&configuration), &callback)
            };
        })
        .map_err(|e| format!("schedule WKWebView full-page snapshot: {e}"))?;
    let pdf = rx
        .recv_timeout(Duration::from_secs(30))
        .map_err(|_| "WKWebView full-page screenshot timed out".to_string())??;
    render_macos_pdf(&pdf, metrics)
}

#[cfg(target_os = "linux")]
fn capture_full_page_png(
    webview: &Webview,
    _metrics: &PageCaptureMetrics,
) -> Result<(Vec<u8>, u32, u32), String> {
    let (tx, rx) = mpsc::channel();
    webview
        .with_webview(move |platform| {
            use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};

            platform.inner().snapshot(
                SnapshotRegion::FullDocument,
                SnapshotOptions::NONE,
                None::<&webkit2gtk::gio::Cancellable>,
                move |result| {
                    let result = result
                        .map_err(|e| format!("WebKitGTK full-page snapshot: {e}"))
                        .and_then(|surface| {
                            let mut png = Vec::new();
                            surface
                                .write_to_png(&mut png)
                                .map_err(|e| format!("encode WebKitGTK snapshot: {e}"))?;
                            let (width, height) = crate::support::png_dimensions(&png)?;
                            Ok((png, width, height))
                        });
                    let _ = tx.send(result);
                },
            );
        })
        .map_err(|e| format!("schedule WebKitGTK full-page snapshot: {e}"))?;
    rx.recv_timeout(Duration::from_secs(30))
        .map_err(|_| "WebKitGTK full-page screenshot timed out".to_string())?
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn capture_full_page_png(
    _webview: &Webview,
    _metrics: &PageCaptureMetrics,
) -> Result<(Vec<u8>, u32, u32), String> {
    Err("full-page screenshot is not yet implemented by this platform WebView".into())
}

fn capture_browser_window(
    app: &tauri::AppHandle,
    requested_tab: Option<u64>,
    req: u64,
) -> Result<String, String> {
    let active = active_tab_id();
    if requested_tab.is_some() && requested_tab != active {
        return Err(format!(
            "browser screenshot captures the shared visible tab only (active tab is {}); select the requested tab first",
            active.map_or_else(|| "none".to_string(), |id| id.to_string())
        ));
    }
    let window = get_window(app).ok_or_else(|| "browser window is unavailable".to_string())?;
    let (png, width, height) = crate::support::capture_window_png(&window)?;
    save_browser_capture(app, &png, width, height, "viewport", active, req)
}

/// Capture only the main OWLLM application window. This is intentionally
/// separate from the shared browser viewport and desktop scopes: UI text must
/// occupy the PNG at native pixels instead of being a small rectangle inside
/// a full desktop/browser capture.
fn capture_app(app: &tauri::AppHandle, req: u64) -> Result<String, String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "main OWLLM window is unavailable".to_string())?;
    let (png, width, height) = crate::support::capture_window_png(&window)?;
    save_browser_capture(app, &png, width, height, "app", None, req)
}

fn capture_browser_full_page(
    app: &tauri::AppHandle,
    webview: &Webview,
    tab_id: Option<u64>,
    req: u64,
) -> Result<String, String> {
    let raw = eval_until_reply(
        webview,
        req,
        "capture_metrics",
        &json!({}),
        Duration::from_secs(8),
    )?;
    let metrics: PageCaptureMetrics = serde_json::from_str(&raw)
        .map_err(|e| format!("parse page capture dimensions: {e}"))?;
    let (png, width, height) = capture_full_page_png(webview, &metrics)?;
    save_browser_capture(app, &png, width, height, "full-page", tab_id, req)
}

fn capture_desktop(
    app: &tauri::AppHandle,
    tab_id: Option<u64>,
    req: u64,
) -> Result<String, String> {
    let (png, width, height) = tauri::async_runtime::block_on(crate::support::capture_screen_png())?;
    save_browser_capture(app, &png, width, height, "desktop", tab_id, req)
}

/// Read back only PNGs created by `browser_screenshot`. This lets local/API
/// vision models receive the pixels on their next tool-loop turn without
/// granting an arbitrary binary-file read over Tauri IPC.
#[tauri::command(async)]
pub fn browser_read_capture(app: tauri::AppHandle, path: String) -> Result<String, String> {
    use base64::Engine as _;

    let root = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("browser capture cache: {e}"))?
        .join("browser-screenshots")
        .canonicalize()
        .map_err(|e| format!("browser capture cache is unavailable: {e}"))?;
    let requested = std::path::PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("browser screenshot does not exist: {e}"))?;
    if !requested.starts_with(&root)
        || requested.extension().and_then(|ext| ext.to_str()) != Some("png")
    {
        return Err("only PNGs created by browser_screenshot can be read".into());
    }
    let bytes = std::fs::read(&requested)
        .map_err(|e| format!("read browser screenshot {}: {e}", requested.display()))?;
    if bytes.len() > 12 * 1024 * 1024 {
        return Err("browser screenshot exceeds the 12 MiB vision-input limit".into());
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Run one action against the live page and return its text reply.
///
/// `navigate` uses the native `webview.navigate()` (robust across origins),
/// then awaits the new document's load through the bridge. All other actions
/// eval __owllmRun directly. Read-back is via the sentinel title channel.
#[tauri::command(async)]
pub fn browser_cmd(app: tauri::AppHandle, action: String, params: Value) -> Result<String, String> {
    let _operation = lock_browser_operation();
    let req = REQ.fetch_add(1, Ordering::SeqCst);
    let screenshot_scope = params
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("viewport")
        .trim()
        .to_ascii_lowercase();
    if action == "screenshot" {
        match screenshot_scope.as_str() {
            "desktop" => return capture_desktop(&app, None, req),
            "app" | "application" | "owllm" => return capture_app(&app, req),
            _ => {}
        }
    }
    if get_window(&app).is_none() || browser_is_suspended() {
        browser_start_inner(&app)?;
    }
    let tab_id = tab_id_from_params(&params)?;
    let win = content_webview_for_tab(&app, tab_id).ok_or_else(|| match tab_id {
        Some(id) => format!("browser tab {id} does not exist"),
        None => "browser did not start".to_string(),
    })?;
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
        "screenshot" => match screenshot_scope.as_str() {
            "viewport" | "window" | "visible" => capture_browser_window(&app, tab_id, req),
            "app" | "application" | "owllm" => capture_app(&app, req),
            "full_page" | "full-page" | "page" => {
                capture_browser_full_page(&app, &win, tab_id.or_else(active_tab_id), req)
            }
            other => Err(format!(
                "unknown screenshot scope {other:?}; use viewport, full_page, or desktop"
            )),
        },
        "upload_file" => upload_file_to_page(&win, req, &params),
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
    match (get_window(&app), browser_is_suspended()) {
        (_, true) => Ok("browser was not running".to_string()),
        (Some(_), false) => {
            // Record the pages BEFORE the teardown: once the windows are gone
            // there is nothing left to read them from.
            persist_session(&app);
            mark_session_closed();
            #[cfg(target_os = "linux")]
            suspend_linux_browser(&app)?;
            #[cfg(not(target_os = "linux"))]
            destroy_browser_windows(&app)?;
            Ok("browser stopped".to_string())
        }
        (None, false) => Ok("browser was not running".to_string()),
    }
}

/// Panel view: current URL + title as JSON (the window itself is the live view).
#[tauri::command(async)]
pub fn browser_view(app: tauri::AppHandle) -> Result<String, String> {
    let _operation = lock_browser_operation();
    if browser_is_suspended() {
        return Err("browser not running".to_string());
    }
    let win = content_webview(&app).ok_or_else(|| "browser not running".to_string())?;
    let req = REQ.fetch_add(1, Ordering::SeqCst);
    let reply = eval_until_reply(&win, req, "info", &json!({}), Duration::from_secs(6))?;
    // The page reports its own location, so the start page would arrive as the
    // internal app-origin document. Every other surface reports it as
    // about:blank; agents and the panel must not see a different URL here.
    let Ok(mut info) = serde_json::from_str::<serde_json::Value>(&reply) else {
        return Ok(reply);
    };
    if let Some(url) = info.get("url").and_then(|url| url.as_str()) {
        info["url"] = json!(public_browser_url(url));
    }
    Ok(info.to_string())
}

/// Focus/raise the agent-browser window so the user can watch or log in.
#[tauri::command(async)]
pub fn browser_focus(app: tauri::AppHandle) -> Result<(), String> {
    let _operation = lock_browser_operation();
    if get_window(&app).is_none() || browser_is_suspended() {
        browser_start_inner(&app)?;
    }
    if let Some(win) = get_window(&app) {
        let _ = win.show();
        let _ = win.set_focus();
    }
    Ok(())
}

/// Geometry for the coordinated main-left/browser-right arrangement.
#[derive(Clone, Copy, Debug, PartialEq)]
struct SplitScreenLayout {
    app_position: LogicalPosition<f64>,
    app_size: LogicalSize<f64>,
    browser_position: LogicalPosition<f64>,
    browser_size: LogicalSize<f64>,
}

fn split_screen_layout(origin: LogicalPosition<f64>, size: LogicalSize<f64>) -> SplitScreenLayout {
    // The split is edge-to-edge: both panes share the monitor's origin and
    // full height, and meet at the center without a floating-card gap.
    const MIN_PANE: f64 = 320.0;
    let available_width = size.width.max(MIN_PANE * 2.0);
    let pane_width = available_width / 2.0;
    let app_height = size.height.max(320.0);
    let app_x = origin.x;
    let browser_x = app_x + pane_width;
    SplitScreenLayout {
        app_position: LogicalPosition::new(app_x, origin.y),
        app_size: LogicalSize::new(pane_width, app_height),
        browser_position: LogicalPosition::new(browser_x, origin.y),
        browser_size: LogicalSize::new(pane_width, app_height),
    }
}

/// Set the visible client rectangle, not the invisible native resize frame.
///
/// `Window::set_position` targets the outer rectangle while `set_size` targets
/// the client rectangle. On Windows an undecorated, resizable window still has
/// an invisible 8px resize border: placing its outer edge at x=0 therefore put
/// the visible app at x=8 and cropped the browser by 8px on the right. Measure
/// the live client offset after sizing and compensate it on every platform.
fn set_client_bounds(
    window: &Window,
    position: LogicalPosition<f64>,
    size: LogicalSize<f64>,
) -> Result<(), String> {
    // Linux's safe browser fallback is an intentionally decorated top-level
    // WebView. Keep that OS title bar inside the work area; the main window is
    // undecorated and follows the client-alignment path below.
    #[cfg(target_os = "linux")]
    if window.label() != "main" {
        window
            .set_size(size)
            .map_err(|e| format!("resize {} window: {e}", window.label()))?;
        let scale = window.scale_factor().unwrap_or(1.0);
        let inner = window
            .inner_size()
            .map_err(|e| format!("measure {} client: {e}", window.label()))?
            .to_logical::<f64>(scale);
        let outer = window
            .outer_size()
            .map_err(|e| format!("measure {} frame: {e}", window.label()))?
            .to_logical::<f64>(scale);
        window
            .set_size(LogicalSize::new(
                (size.width - (outer.width - inner.width)).max(50.0),
                (size.height - (outer.height - inner.height)).max(50.0),
            ))
            .map_err(|e| format!("fit {} window frame: {e}", window.label()))?;
        return window
            .set_position(position)
            .map_err(|e| format!("position {} window: {e}", window.label()));
    }

    window
        .set_size(size)
        .map_err(|e| format!("resize {} window: {e}", window.label()))?;
    window
        .set_position(position)
        .map_err(|e| format!("position {} window: {e}", window.label()))?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let inner = window
        .inner_position()
        .map_err(|e| format!("measure {} client position: {e}", window.label()))?
        .to_logical::<f64>(scale);
    let outer = window
        .outer_position()
        .map_err(|e| format!("measure {} outer position: {e}", window.label()))?
        .to_logical::<f64>(scale);
    window
        .set_position(LogicalPosition::new(
            position.x - (inner.x - outer.x),
            position.y - (inner.y - outer.y),
        ))
        .map_err(|e| format!("align {} client bounds: {e}", window.label()))
}

fn arrange_split_screen(app: &tauri::AppHandle) -> Result<(), String> {
    let main = app
        .get_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    let browser = get_window(app).ok_or_else(|| "browser window is unavailable".to_string())?;
    let monitor = main
        .current_monitor()
        .map_err(|e| format!("read main monitor: {e}"))?
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or_else(|| "could not determine a monitor for the split layout".to_string())?;
    let scale = monitor.scale_factor();
    let work_area = monitor.work_area();
    let layout = split_screen_layout(
        work_area.position.to_logical::<f64>(scale),
        work_area.size.to_logical::<f64>(scale),
    );

    let _ = main.unmaximize();
    let _ = browser.unmaximize();
    set_client_bounds(&main, layout.app_position, layout.app_size)?;
    set_client_bounds(&browser, layout.browser_position, layout.browser_size)?;
    Ok(())
}

/// Place the browser on the right half and OwLLM on the left half of the
/// usable area of the monitor containing the main window. This is a one-time
/// initial arrangement: later user moves and resizes are deliberately left
/// alone.
#[tauri::command(async)]
pub fn browser_arrange(app: tauri::AppHandle, layout: String) -> Result<String, String> {
    if layout.trim() != "right-half" {
        return Err(format!("unknown browser layout {layout:?}"));
    }
    let _operation = lock_browser_operation();
    browser_start_inner(&app)?;
    if let Err(error) = arrange_split_screen(&app) {
        return Err(error);
    }
    Ok(
        "OwLLM arranged on the left and browser on the right half of the current monitor"
            .to_string(),
    )
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
    fn incomplete_provider_authorization_urls_never_reach_the_browser() {
        let claude_prefix = "https://claude.ai/oauth/authorize?code=true&client_id=owllm";
        let claude_complete = concat!(
            "https://claude.ai/oauth/authorize?code=true&client_id=owllm",
            "&redirect_uri=https%3A%2F%2Flocalhost%2Fcallback",
            "&code_challenge=pkce&state=state"
        );
        let current_claude_prefix =
            "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44";
        let current_claude_complete = concat!(
            "https://claude.com/cai/oauth/authorize?code=true&client_id=",
            "9d1c250a-e61b-44fe-93d9-2f5e",
            "&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback",
            "&code_challenge=pkce&state=state"
        );
        let missing_state = concat!(
            "https://claude.ai/oauth/authorize?code=true&client_id=owllm",
            "&redirect_uri=https%3A%2F%2Flocalhost%2Fcallback",
            "&code_challenge=pkce"
        );
        let nested_claude_prefix = concat!(
            "https://claude.com/login?selectAccount=true&returnTo=",
            "%2Fcai%2Foauth%2Fauthorize%3Fcode%3Dtrue%26client_id%3D",
            "9d1c250a-e61b-44"
        );
        let kimi_prefix = "https://www.kimi.com/code/authorize_device?user_cod";
        let kimi_complete = "https://www.kimi.com/code/authorize_device?user_code=ABCD-1234";

        for incomplete in [
            claude_prefix,
            current_claude_prefix,
            missing_state,
            nested_claude_prefix,
            kimi_prefix,
        ] {
            assert!(
                parse_web_url(incomplete).is_err(),
                "{incomplete} must not open through the global web-link route"
            );
            assert!(
                parse_navigation_url(incomplete).is_err(),
                "{incomplete} must not open through browser navigation"
            );
        }
        for complete in [claude_complete, current_claude_complete, kimi_complete] {
            assert!(
                parse_web_url(complete).is_ok(),
                "{complete} is a complete provider authorization URL"
            );
            assert!(
                parse_navigation_url(complete).is_ok(),
                "{complete} is a complete provider authorization URL"
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
        let t = format!("{SENTINEL}EVT\u{2063}nav#17\u{2063}{b64}");
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

        let nav: tauri::Url =
            "http://tauri.localhost/__owllm_browser_event__?action=tabnew&data=&nonce=1"
                .parse()
                .unwrap();
        assert_eq!(
            parse_chrome_navigation(&nav),
            Some(("tabnew".to_string(), String::new()))
        );
        let ordinary: tauri::Url = "http://tauri.localhost/browser-chrome.html"
            .parse()
            .unwrap();
        assert_eq!(parse_chrome_navigation(&ordinary), None);
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
    fn tab_drag_reorders_the_strip() {
        let mut order = vec![1, 2, 3, 4];
        assert!(move_tab_order(&mut order, 4, 0));
        assert_eq!(order, vec![4, 1, 2, 3]);
        // Dropping past the last pill lands at the end, never dropped.
        assert!(move_tab_order(&mut order, 4, 99));
        assert_eq!(order, vec![1, 2, 3, 4]);
        // A drop back onto its own slot, or an id that is no longer open, is
        // not a change — the strip must not be re-pushed for nothing.
        assert!(!move_tab_order(&mut order, 2, 1));
        assert!(!move_tab_order(&mut order, 77, 0));
        assert_eq!(order, vec![1, 2, 3, 4]);
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
            private_session: true,
        });
        batch.absorb(BrowserUiEvent::OpenTab {
            url: "https://two.example/".to_string(),
            activate: false,
            private_session: false,
        });
        assert_eq!(batch.open_tabs.len(), 2);
        assert_eq!(
            batch.open_tabs[0],
            ("https://one.example/".to_string(), true, true)
        );
        assert_eq!(
            batch.open_tabs[1],
            ("https://two.example/".to_string(), false, false)
        );
    }

    #[test]
    fn oauth_popups_keep_engine_opener_and_plain_links_stay_tabs() {
        let popup = |u: &str| is_opener_dependent_popup(&tauri::Url::parse(u).unwrap());
        // Opener-dependent IdP popups → engine-owned (window.opener intact).
        assert!(popup(
            "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&nonce=y"
        ));
        assert!(popup("https://appleid.apple.com/auth/authorize?x=1"));
        assert!(popup("https://login.microsoftonline.com/common/oauth2/v2.0/authorize"));
        assert!(popup("https://github.com/login/oauth/authorize?client_id=x"));
        assert!(popup("https://www.facebook.com/dialog/oauth?client_id=x"));
        // Ordinary target=_blank links → managed OwLLM tabs, as before.
        assert!(!popup("https://github.com/OwLLM/owllm"));
        assert!(!popup("https://www.kimi.com/code/authorize_device?user_code=x"));
        assert!(!popup("https://example.com/login"));
        // Non-https never gets an unmanaged engine popup.
        assert!(!popup("http://accounts.google.com/o/oauth2/v2/auth"));
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
        // Mobile presets carry an explicit UA override. Desktop uses the native
        // engine default except on macOS, where bare WKWebView needs Safari's
        // compatibility tokens for sites that enforce a minimum Safari version.
        assert!(device_by_name("iphone").unwrap().ua.is_some());
        assert!(device_by_name("desktop").unwrap().ua.is_none());
        #[cfg(target_os = "macos")]
        {
            let desktop = device_user_agent(device_by_name("desktop").unwrap()).unwrap();
            assert!(desktop.contains("Version/"));
            assert!(desktop.contains(" Safari/"));
        }
        #[cfg(not(target_os = "macos"))]
        assert!(device_user_agent(device_by_name("desktop").unwrap()).is_none());
    }

    #[test]
    fn claude_callback_returns_only_the_bounded_code_and_state() {
        let callback = tauri::Url::parse(
            "https://platform.claude.com/oauth/code/callback?code=abcdefghijklmnopqrstuvwxyz012345&state=ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789",
        )
        .unwrap();
        assert_eq!(
            claude_auth_code_from_callback(&callback).as_deref(),
            Some("abcdefghijklmnopqrstuvwxyz012345#ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789")
        );
        for rejected in [
            "http://platform.claude.com/oauth/code/callback?code=abcdefghijklmnopqrstuvwxyz012345&state=ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789",
            "https://evil.example/oauth/code/callback?code=abcdefghijklmnopqrstuvwxyz012345&state=ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789",
            "https://platform.claude.com/oauth/code/callback?code=short&state=ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789",
            "https://platform.claude.com/oauth/code/callback?code=abcdefghijklmnopqrstuvwxyz012345&state=bad%23input________________",
        ] {
            assert_eq!(
                claude_auth_code_from_callback(&tauri::Url::parse(rejected).unwrap()),
                None
            );
        }
    }

    #[test]
    fn split_layout_places_matching_edge_to_edge_panes() {
        let layout = split_screen_layout(
            LogicalPosition::new(100.0, 20.0),
            LogicalSize::new(1920.0, 1080.0),
        );
        assert_eq!(layout.app_position, LogicalPosition::new(100.0, 20.0));
        assert_eq!(layout.browser_position.y, 20.0);
        assert_eq!(layout.app_size.height, 1080.0);
        assert_eq!(layout.browser_size, layout.app_size);
        assert_eq!(
            layout.browser_position.x,
            layout.app_position.x + layout.app_size.width
        );
        assert_eq!(
            layout.browser_position.x + layout.browser_size.width,
            2020.0
        );
    }

    #[test]
    fn split_layout_recomputes_both_panes_for_a_resized_monitor() {
        let wide = split_screen_layout(
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1920.0, 1080.0),
        );
        let resized = split_screen_layout(
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1440.0, 900.0),
        );
        assert!(resized.app_size.width < wide.app_size.width);
        assert!(resized.app_size.height < wide.app_size.height);
        assert_eq!(resized.app_size.height, 900.0);
        assert_eq!(resized.browser_size.height, 900.0);
        assert!(resized.browser_position.x > resized.app_position.x);
        assert_eq!(resized.app_position.x, 0.0);
        assert_eq!(resized.browser_position.y, 0.0);
        assert_eq!(
            resized.browser_position.x + resized.browser_size.width,
            1440.0
        );
    }

}

#[tauri::command(async)]
pub fn browser_status(app: tauri::AppHandle) -> Result<BrowserStatus, String> {
    let device = current_device().name.to_string();
    if browser_is_suspended() {
        return Ok(BrowserStatus {
            running: false,
            url: String::new(),
            device,
            active_tab_id: None,
            tabs: Vec::new(),
        });
    }
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
