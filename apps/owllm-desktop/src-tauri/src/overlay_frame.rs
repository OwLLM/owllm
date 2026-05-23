//! Optional decorative overlay frame.
//!
//! This module is intentionally dormant unless `OWLLM_OVERLAY_FRAME=1`
//! is present in the environment. It prototypes the PySide-style split:
//! the main WebView can become a normal rectangular content window, while
//! a second transparent, click-through window carries only the frame art.
//!
//! Nothing in the current app depends on this yet. It exists so we can
//! test the approach later without touching the production chrome.

use std::time::Duration;

use tauri::{App, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const OVERLAY_LABEL: &str = "owllm-overlay-frame";

pub fn enabled() -> bool {
    std::env::var("OWLLM_OVERLAY_FRAME")
        .map(|v| !matches!(v.as_str(), "0" | "false" | "FALSE" | "no" | "NO"))
        .unwrap_or(true)
}

#[tauri::command]
pub fn overlay_frame_enabled() -> bool {
    enabled()
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
    let _ = overlay.show();

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

fn sync_once(main: &WebviewWindow, overlay: &WebviewWindow) -> tauri::Result<()> {
    let pos = main.outer_position()?;
    let size = main.outer_size()?;
    overlay.set_position(pos)?;
    overlay.set_size(size)?;

    if main.is_visible()? {
        let _ = overlay.show();
    } else {
        let _ = overlay.hide();
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
