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
static MAIN_FOCUSED: AtomicBool = AtomicBool::new(true);
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

    start_sync_loop(main, overlay);
}

pub fn close_if_present<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = overlay.hide();
        let _ = overlay.close();
    }
}

pub fn set_main_focused(app: &tauri::AppHandle, focused: bool) {
    if !enabled() {
        return;
    }

    MAIN_FOCUSED.store(focused, Ordering::Release);

    let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) else {
        return;
    };

    if !focused {
        let _ = overlay.hide();
        return;
    }

    if let Some(main) = app.get_webview_window("main") {
        let _ = sync_once(&main, &overlay);
    }
}

fn create_overlay(app: &mut App) -> tauri::Result<WebviewWindow> {
    if let Some(existing) = app.get_webview_window(OVERLAY_LABEL) {
        return Ok(existing);
    }

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
    .always_on_top(true)
    .visible(false)
    .build()
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

    if !MAIN_FOCUSED.load(Ordering::Acquire) {
        let _ = overlay.hide();
        return Ok(());
    }

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
    std::thread::spawn(move || loop {
        if sync_once(&main, &overlay).is_err() {
            break;
        }
        std::thread::sleep(Duration::from_millis(33));
    });
}
