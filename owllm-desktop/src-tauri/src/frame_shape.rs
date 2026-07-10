//! Input-shape for the in-page chrome (Linux).
//!
//! Off-Windows there is no separate click-through overlay window — the
//! decorative frame is drawn IN the main window (AppShell's HybridFrame),
//! so the window rectangle includes the transparent margins around the
//! frame art (most importantly the EXTRA_TOP band the owl peeks into).
//! Without shaping, clicks in that see-through band are swallowed by our
//! window instead of reaching whatever sits behind it — the "watcher
//! hit-area blocks other windows' close buttons" bug.
//!
//! The frontend computes the visible chrome rectangles (frame body + owl
//! badge) in CSS pixels and hands them here; we combine them into the GTK
//! input shape so everything OUTSIDE them is click-through at the window
//! level. `tauri.linux.conf.json` makes the same window transparent, which
//! is what lets those margins actually show the desktop behind.
//!
//! On Windows/macOS this command is a no-op: Windows uses the overlay
//! window (overlay_frame.rs), and macOS doesn't ship the in-page chrome
//! shaping today.

/// One rectangle of the window that should stay mouse-interactive.
/// CSS/logical pixels, window-relative — the same space GTK widget
/// coordinates use, so no scale conversion is needed.
#[derive(serde::Deserialize)]
pub struct InputRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// Restrict mouse input to `rects` (their union). An empty list clears the
/// shape back to the full window (everything interactive again).
#[tauri::command]
pub fn frame_input_region(window: tauri::Window, rects: Vec<InputRect>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        // GTK is main-thread-only; commands run on the async pool.
        window
            .clone()
            .run_on_main_thread(move || {
                use gtk::prelude::WidgetExt;
                let Ok(gtk_win) = window.gtk_window() else {
                    return;
                };
                if rects.is_empty() {
                    gtk_win.input_shape_combine_region(None);
                    return;
                }
                let boxes: Vec<gtk::cairo::RectangleInt> = rects
                    .iter()
                    .map(|r| gtk::cairo::RectangleInt::new(r.x, r.y, r.w.max(0), r.h.max(0)))
                    .collect();
                let region = gtk::cairo::Region::create_rectangles(&boxes);
                gtk_win.input_shape_combine_region(Some(&region));
            })
            .map_err(|e| format!("input region: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (window, rects);
        Ok(())
    }
}
