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
mod win_nc {
    use std::sync::OnceLock;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, DefWindowProcW, GetWindowLongPtrW, SetWindowLongPtrW,
        GWLP_WNDPROC, WM_NCCALCSIZE,
    };

    /// Original window proc pointer, captured the first time we
    /// subclass. All non-NC messages flow back through it.
    static ORIGINAL_PROC: OnceLock<isize> = OnceLock::new();

    /// Replace the window proc with one that swallows WM_NCCALCSIZE.
    /// Returning 0 from WM_NCCALCSIZE tells the OS that the entire
    /// window IS the client area — no non-client space for a title
    /// strip, no DWM accent border, nothing. This is the documented
    /// Windows technique for fully custom frames (Discord/VSCode use
    /// it). DWMWA_BORDER_COLOR doesn't exist on Win10, so the prior
    /// fix was a no-op there — this works on both Win10 and Win11.
    pub fn subclass(hwnd: HWND) {
        unsafe {
            let original = GetWindowLongPtrW(hwnd, GWLP_WNDPROC);
            let _ = ORIGINAL_PROC.set(original);
            SetWindowLongPtrW(hwnd, GWLP_WNDPROC, hook_proc as *const () as isize);
        }
    }

    unsafe extern "system" fn hook_proc(
        hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_NCCALCSIZE && wparam.0 != 0 {
            // wParam != 0 means "give me the new client rect". Return 0
            // → the client rect equals the proposed window rect.
            return LRESULT(0);
        }
        if let Some(&p) = ORIGINAL_PROC.get() {
            // Forward everything else to the original Tauri/tao proc.
            let proc: extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT =
                std::mem::transmute(p);
            return CallWindowProcW(Some(proc), hwnd, msg, wparam, lparam);
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

#[cfg(windows)]
fn strip_windows_decorations(hwnd_raw: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetWindowLongW, SetWindowPos, GWL_STYLE,
        SWP_FRAMECHANGED, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_NOACTIVATE,
        WS_CAPTION, WS_THICKFRAME, WS_SYSMENU, WS_MINIMIZEBOX, WS_MAXIMIZEBOX,
    };
    let hwnd = HWND(hwnd_raw as *mut std::ffi::c_void);
    unsafe {
        let style = GetWindowLongW(hwnd, GWL_STYLE);
        let strip = (WS_CAPTION.0 | WS_THICKFRAME.0 | WS_SYSMENU.0) as i32;
        let keep = (WS_MINIMIZEBOX.0 | WS_MAXIMIZEBOX.0) as i32;
        let new_style = (style & !strip) | keep;
        SetWindowLongW(hwnd, GWL_STYLE, new_style);

        // Subclass the window proc so WM_NCCALCSIZE returns 0 →
        // client area covers the entire window, no residual title
        // strip or accent border can be painted by the OS or DWM.
        win_nc::subclass(hwnd);

        // SWP_FRAMECHANGED forces the OS to recalculate the frame
        // immediately, which in turn triggers our new WM_NCCALCSIZE
        // handler. Without this, the existing frame persists until a
        // resize/move.
        let _ = SetWindowPos(
            hwnd,
            None,
            0, 0, 0, 0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}
