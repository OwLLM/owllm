//! Decorative overlay frame — ON by default (opt out with
//! `OWLLM_OVERLAY_FRAME=0`). PySide-style split: the main WebView is a
//! normal rectangular content window, while this second transparent,
//! click-through window carries only the frame art.
//!
//! Startup rule: the overlay is only ever shown AFTER its page has
//! painted (`OVERLAY_READY`). Showing an unpainted transparent WebView2
//! window flashes white over the whole app — the startup-flash
//! regression. The 33ms sync loop picks it up as soon as it's ready.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::{App, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window};

const OVERLAY_LABEL: &str = "owllm-overlay-frame";
static OVERLAY_READY: AtomicBool = AtomicBool::new(false);
const BORDER_T: i32 = 18;
const CORNER_OUTSET: i32 = 10;
const SHIFT_OUT: i32 = BORDER_T / 2;
const EXTRA_TOP: i32 = 35;
const EXTRA_RIGHT: u32 = 0;
const EXTRA_BOTTOM: u32 = 0;
const CONTENT_OFFSET_X: i32 = SHIFT_OUT + CORNER_OUTSET;
const CONTENT_OFFSET_Y: i32 = EXTRA_TOP + SHIFT_OUT + CORNER_OUTSET;
const OVERLAY_EXTRA_W: u32 = EXTRA_RIGHT + 2 * (SHIFT_OUT as u32) + 2 * CORNER_OUTSET as u32;
const OVERLAY_EXTRA_H: u32 =
    EXTRA_TOP as u32 + EXTRA_BOTTOM + 2 * (SHIFT_OUT as u32) + 2 * CORNER_OUTSET as u32;

/// Turn off Windows' "ghost window" feature for this process.
///
/// When a top-level window stops pumping messages for a moment (e.g. a
/// synchronous command briefly blocks the shared event loop), the DWM
/// normally replaces it with a faded "(Not Responding)" GHOST window that
/// has a default title bar + min/max/close. For our decorative overlay
/// (transparent, decorations:false) that ghost shows up as a stray framed
/// window titled "OwLLM Overlay Frame" floating over the app. Disabling
/// ghosting means a transient freeze just pauses repaint in place — no
/// stray frame. Call once at startup. Safe to call unconditionally.
#[cfg(target_os = "windows")]
pub fn disable_window_ghosting() {
    use windows_sys::Win32::UI::WindowsAndMessaging::DisableProcessWindowsGhosting;
    unsafe { DisableProcessWindowsGhosting() };
}

#[cfg(not(target_os = "windows"))]
pub fn disable_window_ghosting() {}

pub fn enabled() -> bool {
    // The overlay frame is Windows-only decorative chrome: the owner-window
    // wiring is a no-op stub off Windows, and the click-through path aborts on
    // GTK (tao `CursorIgnoreEvents` unwraps a not-yet-realized GDK window,
    // SIGABRT on launch). Default it off everywhere except Windows; opt-in only.
    #[cfg(not(target_os = "windows"))]
    {
        return std::env::var("OWLLM_OVERLAY_FRAME")
            .map(|v| v == "1")
            .unwrap_or(false);
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var("OWLLM_OVERLAY_FRAME")
            .map(|v| !matches!(v.as_str(), "0" | "false" | "FALSE" | "no" | "NO"))
            .unwrap_or(true)
    }
}

#[tauri::command]
pub fn overlay_frame_enabled() -> bool {
    enabled()
}

pub fn label() -> &'static str {
    OVERLAY_LABEL
}

pub fn mark_ready() {
    OVERLAY_READY.store(true, Ordering::Release);
}

pub fn wait_until_ready(timeout: Duration) {
    if !enabled() {
        return;
    }
    let start = Instant::now();
    while !OVERLAY_READY.load(Ordering::Acquire) && start.elapsed() < timeout {
        std::thread::sleep(Duration::from_millis(10));
    }
}

pub fn install(app: &mut App) {
    if !enabled() {
        return;
    }

    let Some(main) = app.get_webview_window("main") else {
        eprintln!("[overlay-frame] main window not available");
        return;
    };

    let overlay = match create_overlay(app) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[overlay-frame] failed to create overlay window: {e}");
            return;
        }
    };

    if let Err(e) = sync_once(&main, &overlay) {
        eprintln!("[overlay-frame] initial sync failed: {e}");
    }

    // The overlay is decorative only. Clicks pass through to the real
    // app window, which avoids focus/input regressions while testing.
    let _ = overlay.set_ignore_cursor_events(true);

    // Make main the OWNER so the chrome rides with our app instead of
    // floating above every other window on the desktop. See
    // `set_owner_to_main` for the why.
    if let Err(e) = set_owner_to_main(&overlay, &main) {
        eprintln!("[overlay-frame] failed to set owner: {e}");
    }

    start_sync_loop(main, overlay);
}

pub fn close_if_present<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = overlay.hide();
        let _ = overlay.close();
    }
}

fn create_overlay(app: &mut App) -> tauri::Result<WebviewWindow> {
    if let Some(existing) = app.get_webview_window(OVERLAY_LABEL) {
        return Ok(existing);
    }

    // NOTE: NO `.always_on_top(true)` — that would make the chrome
    // float above every other app on the system (browsers, IDE,
    // explorer windows). The owner-relationship set in `set_owner_to_main`
    // below is what keeps the overlay z-ordered above main without
    // promoting it to a system-wide topmost window.
    WebviewWindowBuilder::new(
        app,
        OVERLAY_LABEL,
        WebviewUrl::App("overlay-frame.html".into()),
    )
    .title("OwLLM Overlay Frame")
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .resizable(false)
    .skip_taskbar(true)
    .visible(false)
    .build()
}

/// Make `main` the OWNER of `overlay` via Win32
/// `SetWindowLongPtrW(GWLP_HWNDPARENT, ...)`.
///
/// On Windows an "owned" window:
///   * is z-ordered above its owner automatically (no always_on_top
///     needed — clicking through to main raises both)
///   * stays BEHIND foreground windows belonging to other apps when
///     the owner loses focus (this is the bit we want — switching to
///     a browser hides the cyan chrome that used to float over it)
///   * minimises/hides with its owner
///   * is destroyed when the owner is destroyed
///
/// This is the standard Win32 idiom for tool windows / floating
/// chrome. The cross-platform Tauri API doesn't surface it cleanly,
/// so we drop to one raw FFI call.
#[cfg(target_os = "windows")]
fn set_owner_to_main(overlay: &WebviewWindow, main: &WebviewWindow) -> tauri::Result<()> {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowLongPtrW, GWLP_HWNDPARENT};

    let overlay_hwnd = overlay.hwnd()?.0 as HWND;
    let main_hwnd = main.hwnd()?.0 as HWND;

    unsafe {
        SetWindowLongPtrW(overlay_hwnd, GWLP_HWNDPARENT, main_hwnd as isize);
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn set_owner_to_main(_overlay: &WebviewWindow, _main: &WebviewWindow) -> tauri::Result<()> {
    // Non-Windows builds don't ship the overlay frame today; if they
    // ever do, equivalent owner/parent wiring goes here. The empty
    // impl keeps the call site cfg-free.
    Ok(())
}

pub fn prepare_and_show_for_main(main: &Window) -> tauri::Result<()> {
    if !enabled() {
        return Ok(());
    }
    let Some(overlay) = main.app_handle().get_webview_window(OVERLAY_LABEL) else {
        return Ok(());
    };
    sync_geometry(main.outer_position()?, main.outer_size()?, &overlay)?;
    // Never show the overlay before its page painted — a not-yet-ready
    // transparent WebView2 window flashes WHITE over the app. If the 700ms
    // startup wait timed out, the sync loop shows it once mark_ready fires.
    if OVERLAY_READY.load(Ordering::Acquire) {
        overlay.show()?;
    }
    Ok(())
}

fn sync_geometry(
    pos: tauri::PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
    overlay: &WebviewWindow,
) -> tauri::Result<()> {
    overlay.set_position(tauri::PhysicalPosition {
        x: pos.x - CONTENT_OFFSET_X,
        y: pos.y - CONTENT_OFFSET_Y,
    })?;
    overlay.set_size(tauri::PhysicalSize {
        width: size.width + OVERLAY_EXTRA_W,
        height: size.height + OVERLAY_EXTRA_H,
    })?;
    Ok(())
}

// On Windows the follow loop + sync_now use the event-loop-free sync_once_win32
// instead; this tauri-dispatcher version is only compiled-in for the (disabled)
// non-Windows path, so silence the Windows dead-code warning.
#[cfg_attr(target_os = "windows", allow(dead_code))]
fn sync_once(main: &WebviewWindow, overlay: &WebviewWindow) -> tauri::Result<()> {
    sync_geometry(main.outer_position()?, main.outer_size()?, overlay)?;

    if !main.is_visible()? {
        let _ = overlay.hide();
    } else if !main.is_minimized()? && OVERLAY_READY.load(Ordering::Acquire) {
        // Ready-gated for the same reason as prepare_and_show_for_main:
        // an unpainted transparent webview shows as a white sheet.
        let _ = overlay.show();
    }

    if main.is_minimized()? {
        let _ = overlay.hide();
    }

    Ok(())
}

/// Windows-only, event-loop-FREE geometry sync — the body of the 33 ms follow
/// loop. Reads the main window's rect and drives the overlay purely through
/// Win32 (`GetWindowRect` / `SetWindowPos` / `ShowWindow`), so the loop NEVER
/// calls a blocking `WryWindowDispatcher` method (`outer_position`, `outer_size`,
/// `is_visible`, `is_minimized`, `set_position`, `set_size`). Each of those posts
/// a message to the event loop and blocks on its reply; hammering ~7 of them
/// 30×/sec from this background thread drove re-entrancy into tao's non-reentrant
/// window-callback `parking_lot` mutex and self-deadlocked the UI thread when an
/// incoming synchronous `SendMessage` landed mid-pump — the whole app froze
/// ("Not Responding", no repaint, no mouse). Win32 reads (`GetWindowRect`) are
/// pure kernel-object queries off the event loop, so those can't deadlock. The
/// WRITE (`SetWindowPos`) still targets a MAIN-thread-owned window, so it MUST
/// carry `SWP_ASYNCWINDOWPOS` (see below) — otherwise it sends messages
/// synchronously to the main thread and reintroduces the exact freeze (observed
/// live at v0.8.56). Returns `Err` only when the main window can't be read
/// (destroyed), so the caller's give-up counter still works.
#[cfg(target_os = "windows")]
fn sync_once_win32(main_hwnd: isize, overlay_hwnd: isize) -> Result<(), ()> {
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, IsIconic, IsWindowVisible, SetWindowPos, ShowWindowAsync,
        SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOZORDER, SW_HIDE, SW_SHOWNOACTIVATE,
    };
    let main = main_hwnd as HWND;
    let overlay = overlay_hwnd as HWND;
    unsafe {
        let mut r = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if GetWindowRect(main, &mut r) == 0 {
            return Err(()); // main window gone / unqueryable
        }
        // Always keep the overlay glued around the main window's outer rect. No
        // show flag here, so a hidden overlay stays hidden (matches sync_geometry).
        let x = r.left - CONTENT_OFFSET_X;
        let y = r.top - CONTENT_OFFSET_Y;
        let w = (r.right - r.left) + OVERLAY_EXTRA_W as i32;
        let h = (r.bottom - r.top) + OVERLAY_EXTRA_H as i32;
        // SWP_ASYNCWINDOWPOS is LOAD-BEARING: this runs on a background
        // thread but the overlay window is owned by the MAIN (event-loop)
        // thread. Without the async flag, SetWindowPos SENDS
        // WM_WINDOWPOSCHANGING/CHANGED synchronously to the owning thread and
        // BLOCKS until it pumps them — and that message gets dispatched
        // re-entrantly into tao's non-reentrant window-callback parking_lot
        // mutex, self-deadlocking the UI thread ("Not Responding" freeze, seen
        // in v0.8.56 despite the earlier Win32-direct move: raw SetWindowPos is
        // still a synchronous CROSS-THREAD call). The async flag POSTS the
        // request to the main thread's queue instead, so this loop never
        // blocks and never forces a re-entrant callback.
        SetWindowPos(
            overlay,
            std::ptr::null_mut(),
            x,
            y,
            w,
            h,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
        );

        let visible = IsWindowVisible(main) != 0;
        let minimized = IsIconic(main) != 0;
        // ShowWindowAsync, NOT ShowWindow — for the SAME reason SetWindowPos above
        // carries SWP_ASYNCWINDOWPOS. The overlay window is owned by the MAIN
        // (event-loop) thread; a plain ShowWindow from this background thread SENDS
        // WM_SHOWWINDOW SYNCHRONOUSLY to the main thread, which Windows dispatches
        // re-entrantly into tao's non-reentrant window-callback parking_lot mutex
        // while it's mid-keyboard-pump — self-deadlocking the UI thread ("Not
        // Responding" freeze while typing; SWP_ASYNCWINDOWPOS on SetWindowPos fixed
        // the move path in v0.8.56 but this show/hide path kept sending). Confirmed
        // via a live gdb dump of a frozen instance: main thread parked on this exact
        // mutex under a re-entrant SendMessageTimeoutW. ShowWindowAsync POSTS the
        // request to the main thread's queue instead, so it never blocks or re-enters.
        if !visible || minimized {
            ShowWindowAsync(overlay, SW_HIDE);
        } else if OVERLAY_READY.load(Ordering::Acquire) {
            // Ready-gated: an unpainted transparent webview flashes white.
            ShowWindowAsync(overlay, SW_SHOWNOACTIVATE);
        }
    }
    Ok(())
}

/// The on-screen rectangle that holds the WHOLE app — content window plus
/// the frame that's drawn in the separate, larger overlay window around it —
/// together with the monitor it sits on. The tutorial recorder uses this to
/// crop a full-screen capture down to exactly the app (frame included), since
/// the frame lives OUTSIDE the main window and a single-window capture misses
/// it. All values are PHYSICAL pixels in virtual-desktop coordinates.
#[derive(serde::Serialize)]
pub struct CaptureGeometry {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    monitor_x: i32,
    monitor_y: i32,
    monitor_w: u32,
    monitor_h: u32,
    scale_factor: f64,
}

#[tauri::command]
pub fn overlay_frame_capture_geometry(app: tauri::AppHandle) -> Option<CaptureGeometry> {
    // The overlay window already spans content + frame; when the overlay is
    // off, the main window is itself the whole app, so fall back to it.
    let win = app
        .get_webview_window(OVERLAY_LABEL)
        .or_else(|| app.get_webview_window("main"))?;
    let pos = win.outer_position().ok()?;
    let size = win.outer_size().ok()?;
    let monitor = win.current_monitor().ok().flatten()?;
    let mpos = monitor.position();
    let msize = monitor.size();
    Some(CaptureGeometry {
        x: pos.x,
        y: pos.y,
        w: size.width,
        h: size.height,
        monitor_x: mpos.x,
        monitor_y: mpos.y,
        monitor_w: msize.width,
        monitor_h: msize.height,
        scale_factor: monitor.scale_factor(),
    })
}

fn start_sync_loop(main: WebviewWindow, overlay: WebviewWindow) {
    // A single transient failure must NOT kill the follow. Reading the main
    // window can briefly error while it's mid-move; the old code did
    // `if is_err() { break }`, so one hiccup froze the frame at a stale spot
    // forever (the "stuck outside / not following" bug). We keep going on
    // errors and only give up once main has been unreachable for a sustained
    // stretch (≈ window really gone), not a momentary glitch.
    #[cfg(target_os = "windows")]
    {
        // Resolve the raw HWNDs ONCE (isize is `Send`; `.hwnd()` is a cheap
        // cached read, not an event-loop round-trip). The 33 ms poll then uses
        // ONLY direct Win32 via sync_once_win32 — never a blocking dispatcher
        // call — which is what previously deadlocked the UI thread. See
        // sync_once_win32 for the full root-cause note.
        let (main_hwnd, overlay_hwnd) = match (main.hwnd(), overlay.hwnd()) {
            (Ok(m), Ok(o)) => (m.0 as isize, o.0 as isize),
            _ => return,
        };
        std::thread::spawn(move || {
            // Hold the window handles for the loop's life so the HWNDs stay
            // valid; never call their blocking dispatcher methods.
            let _keep = (main, overlay);
            let mut consecutive_err: u32 = 0;
            loop {
                match sync_once_win32(main_hwnd, overlay_hwnd) {
                    Ok(()) => consecutive_err = 0,
                    Err(()) => {
                        consecutive_err += 1;
                        if consecutive_err > 150 {
                            break; // ~5s of continuous failure → main is gone; stop.
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(33));
            }
        });
    }
    // Overlay frame is Windows-only (enabled() is false elsewhere); this arm
    // exists only so the module compiles cross-platform.
    #[cfg(not(target_os = "windows"))]
    {
        std::thread::spawn(move || {
            let mut consecutive_err: u32 = 0;
            loop {
                match sync_once(&main, &overlay) {
                    Ok(()) => consecutive_err = 0,
                    Err(_) => {
                        consecutive_err += 1;
                        if consecutive_err > 150 {
                            break;
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(33));
            }
        });
    }
}

/// Immediately re-glue the overlay to the main window. Called from the
/// RunEvent loop on main's Moved/Resized so the frame tracks drags/resizes
/// precisely instead of trailing the 33ms poll. Best-effort + cheap.
pub fn sync_now(app: &tauri::AppHandle) {
    if !enabled() {
        return;
    }
    if let (Some(main), Some(overlay)) = (
        app.get_webview_window("main"),
        app.get_webview_window(OVERLAY_LABEL),
    ) {
        // Same event-loop-free path as the poll. sync_now fires on the main
        // thread from Moved/Resized (many times/sec during a drag), so keep it
        // off the blocking dispatcher too.
        #[cfg(target_os = "windows")]
        {
            if let (Ok(m), Ok(o)) = (main.hwnd(), overlay.hwnd()) {
                let _ = sync_once_win32(m.0 as isize, o.0 as isize);
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = sync_once(&main, &overlay);
        }
    }
}
