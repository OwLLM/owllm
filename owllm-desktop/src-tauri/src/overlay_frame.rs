//! Optional decorative overlay frame.
//!
//! This module is intentionally dormant unless `OWLLM_OVERLAY_FRAME=1`
//! is present in the environment. It prototypes the PySide-style split:
//! the main WebView can become a normal rectangular content window, while
//! a second transparent, click-through window carries only the frame art.
//!
//! Nothing in the current app depends on this yet. It exists so we can
//! test the approach later without touching the production chrome.

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
const OVERLAY_EXTRA_H: u32 = EXTRA_TOP as u32 + EXTRA_BOTTOM + 2 * (SHIFT_OUT as u32) + 2 * CORNER_OUTSET as u32;

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
    std::env::var("OWLLM_OVERLAY_FRAME")
        .map(|v| !matches!(v.as_str(), "0" | "false" | "FALSE" | "no" | "NO"))
        .unwrap_or(true)
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
    let Some(overlay) = main
        .app_handle()
        .get_webview_window(OVERLAY_LABEL)
    else {
        return Ok(());
    };
    sync_geometry(main.outer_position()?, main.outer_size()?, &overlay)?;
    overlay.show()?;
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

fn sync_once(main: &WebviewWindow, overlay: &WebviewWindow) -> tauri::Result<()> {
    sync_geometry(main.outer_position()?, main.outer_size()?, overlay)?;

    if !main.is_visible()? {
        let _ = overlay.hide();
    } else if !main.is_minimized()? {
        let _ = overlay.show();
    }

    if main.is_minimized()? {
        let _ = overlay.hide();
    }

    Ok(())
}

fn start_sync_loop(main: WebviewWindow, overlay: WebviewWindow) {
    std::thread::spawn(move || {
        // A single transient failure must NOT kill the follow. Reading the
        // main window's position/size/visibility can briefly error while it's
        // mid-move or the webview is momentarily busy; the old code did
        // `if is_err() { break }`, so one hiccup froze the frame at a stale
        // spot forever (the "stuck outside / not following" bug). Now we keep
        // going on errors and only give up once main has been unreachable for
        // a sustained stretch (≈ window really gone), not a momentary glitch.
        let mut consecutive_err: u32 = 0;
        loop {
            match sync_once(&main, &overlay) {
                Ok(()) => consecutive_err = 0,
                Err(_) => {
                    consecutive_err += 1;
                    if consecutive_err > 150 {
                        // ~5s of continuous failure → main is gone; stop.
                        break;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(33));
        }
    });
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
        let _ = sync_once(&main, &overlay);
    }
}
