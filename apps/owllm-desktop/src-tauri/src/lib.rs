// OwLLM Desktop — Tauri + React. NO Python at runtime.
//
// Architecture (2026-05-14):
//   * Rust owns the runtime — model registry, server lifecycle,
//     hardware probe, MCP, bridges, agents. Modules below.
//   * React owns the UI — talks to Rust via `invoke()` only.
//   * Python is invited on-demand only for fine-tuning + per-model
//     venv bootstrap. NEVER auto-started; one-shot subprocesses
//     when invoked. (Future slot: `python_jobs.rs`.)
//
// Each command lives in its own module so this file stays a wiring
// manifest and nothing more.

mod agents;
mod bridges;
mod code;
mod hardware;
mod models;
mod paths;
mod projects;
mod server;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Module-local state lives where the module lives; lib.rs
            // just kicks off the install.
            server::install(app);

            // Force frameless on Windows by stripping the decoration
            // bits directly. Tauri 2.10's `decorations: false` in
            // tauri.conf.json AND `set_decorations(false)` at setup
            // both leave WS_CAPTION + WS_THICKFRAME set (verified via
            // GetWindowLong on the HWND). Doing the SetWindowLong
            // ourselves is the only thing that takes.
            #[cfg(windows)]
            if let Some(w) = app.get_webview_window("main") {
                if let Ok(hwnd) = w.hwnd() {
                    strip_windows_decorations(hwnd.0 as isize);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agents::list_team_templates,
            agents::list_agent_roles,
            agents::list_skill_packs,
            bridges::load_bridge_configs,
            bridges::save_telegram_config,
            bridges::save_whatsapp_config,
            code::launch_external_editor,
            hardware::hardware_info,
            hardware::vram_status,
            models::list_models,
            projects::list_projects,
            server::server_status,
            server::server_start,
            server::server_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OwLLM Desktop");
}

#[cfg(windows)]
fn strip_windows_decorations(hwnd_raw: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_BORDER_COLOR};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetWindowLongW, SetWindowPos, GWL_STYLE,
        SWP_FRAMECHANGED, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_NOACTIVATE,
        WS_CAPTION, WS_THICKFRAME, WS_SYSMENU, WS_MINIMIZEBOX, WS_MAXIMIZEBOX,
    };
    let hwnd = HWND(hwnd_raw as *mut std::ffi::c_void);
    unsafe {
        let style = GetWindowLongW(hwnd, GWL_STYLE);
        // Keep min/max box bits — the OS uses them for taskbar
        // interactions (Win+D restore, snap layouts) even when the
        // titlebar buttons aren't visible.
        let strip = (WS_CAPTION.0 | WS_THICKFRAME.0 | WS_SYSMENU.0) as i32;
        let keep = (WS_MINIMIZEBOX.0 | WS_MAXIMIZEBOX.0) as i32;
        let new_style = (style & !strip) | keep;
        SetWindowLongW(hwnd, GWL_STYLE, new_style);
        // SWP_FRAMECHANGED is what actually flushes the new frame.
        let _ = SetWindowPos(
            hwnd,
            None,
            0, 0, 0, 0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        );

        // Kill the Win11 DWM accent border + the 1px caption shadow.
        // DWMWA_COLOR_NONE = 0xFFFFFFFE — tells DWM "draw no border
        // at all" on this window. Without this, Win11 paints a thin
        // light border + residual "OwLLM Desktop" title strip around
        // the window even with WS_CAPTION off.
        const DWMWA_COLOR_NONE: u32 = 0xFFFF_FFFE;
        let color = DWMWA_COLOR_NONE;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR,
            &color as *const _ as *const _,
            std::mem::size_of::<u32>() as u32,
        );
    }
}
