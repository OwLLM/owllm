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

mod accounts;
mod agents;
mod bridges;
mod code;
mod dialog;
mod hardware;
mod models;
mod paths;
mod projects;
mod server;
mod skill_library;

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
            accounts::accounts_status,
            accounts::accounts_save_api_key,
            accounts::accounts_delete_secret,
            accounts::accounts_get_secret,
            accounts::accounts_test_probe,
            agents::list_team_templates,
            agents::list_agent_roles,
            agents::list_skill_packs,
            bridges::load_bridge_configs,
            bridges::save_telegram_config,
            bridges::save_whatsapp_config,
            code::launch_external_editor,
            dialog::pick_folder,
            dialog::pick_file,
            hardware::hardware_info,
            hardware::vram_status,
            models::list_models,
            projects::list_projects,
            projects::create_project,
            projects::update_project,
            projects::delete_project,
            server::server_status,
            server::server_start,
            server::server_stop,
            skill_library::list_skill_sources,
            skill_library::fetch_skill_source,
            skill_library::discover_skills,
            skill_library::install_skill,
            skill_library::uninstall_skill,
            skill_library::list_installed_skill_folders,
            skill_library::read_skill_md,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OwLLM Desktop");
}

#[cfg(windows)]
mod win_nc {
    use std::sync::OnceLock;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, DefWindowProcW, GetWindowLongPtrW, SetWindowLongPtrW,
        GWLP_WNDPROC, HTCAPTION, MINMAXINFO, SC_MAXIMIZE, SC_MINIMIZE, SC_RESTORE,
        WM_GETMINMAXINFO, WM_NCCALCSIZE, WM_NCLBUTTONDOWN, WM_SYSCOMMAND,
    };

    /// Original window proc pointer, captured the first time we
    /// subclass. All non-NC messages flow back through it.
    static ORIGINAL_PROC: OnceLock<isize> = OnceLock::new();

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
        match msg {
            WM_NCCALCSIZE if wparam.0 != 0 => {
                // Return 0 → entire window IS the client area. No
                // system-painted frame. Combined with WM_GETMINMAXINFO
                // below, maximized state already sits inside the work
                // area so we don't need to inset the rect ourselves.
                return LRESULT(0);
            }
            WM_GETMINMAXINFO => {
                // Clamp maximize to the monitor WORK AREA (taskbar-
                // aware). Without this, a frameless window maximizes
                // over the full monitor rect and the taskbar covers
                // the bottom. THIS is the path that fires when the
                // OS routes the maximize itself.
                clamp_to_work_area(hwnd, lparam);
                return LRESULT(0);
            }
            WM_NCLBUTTONDOWN if wparam.0 == HTCAPTION as usize => {
                // Tao's default WM_NCLBUTTONDOWN handler swallows the
                // caption click and does its own (broken-for-us) move
                // logic. Bypass Tao by going straight to DefWindowProcW,
                // which enters the standard Win32 modal move loop.
                return DefWindowProcW(hwnd, msg, wparam, lparam);
            }
            WM_SYSCOMMAND => {
                // For SC_MAXIMIZE / SC_RESTORE / SC_MINIMIZE we also
                // want the standard Win32 path so our
                // WM_GETMINMAXINFO clamp fires. Tao's own handler may
                // call SetWindowPos directly with custom dimensions,
                // bypassing the clamp.
                let cmd = wparam.0 & 0xFFF0;
                if cmd == SC_MAXIMIZE as usize
                    || cmd == SC_RESTORE  as usize
                    || cmd == SC_MINIMIZE as usize
                {
                    return DefWindowProcW(hwnd, msg, wparam, lparam);
                }
            }
            _ => {}
        }
        if let Some(&p) = ORIGINAL_PROC.get() {
            let proc: extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT =
                std::mem::transmute(p);
            return CallWindowProcW(Some(proc), hwnd, msg, wparam, lparam);
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    unsafe fn clamp_to_work_area(hwnd: HWND, lparam: LPARAM) {
        let info = lparam.0 as *mut MINMAXINFO;
        if info.is_null() { return; }
        let monitor: HMONITOR = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            rcMonitor: RECT::default(),
            rcWork: RECT::default(),
            dwFlags: 0,
        };
        if GetMonitorInfoW(monitor, &mut mi).as_bool() {
            (*info).ptMaxPosition = POINT {
                x: mi.rcWork.left - mi.rcMonitor.left,
                y: mi.rcWork.top  - mi.rcMonitor.top,
            };
            (*info).ptMaxSize = POINT {
                x: mi.rcWork.right  - mi.rcWork.left,
                y: mi.rcWork.bottom - mi.rcWork.top,
            };
            // Don't clamp ptMaxTrackSize — leaving it at the OS default
            // lets the user resize the (non-maximized) window freely,
            // including to a size larger than the work area if they
            // want. ptMaxSize controls ONLY the zoomed/maximized rect.
        }
    }
}

#[cfg(windows)]
fn strip_windows_decorations(hwnd_raw: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetWindowLongW, SetWindowPos, GWL_STYLE,
        SWP_FRAMECHANGED, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_NOACTIVATE,
        WS_CAPTION, WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_SYSMENU, WS_THICKFRAME,
    };
    let hwnd = HWND(hwnd_raw as *mut std::ffi::c_void);
    unsafe {
        // Strip ONLY the visible title-bar bits, AND explicitly ADD
        // WS_THICKFRAME + the min/max box bits. Tauri's
        // `decorations: false` at create time strips WS_THICKFRAME on
        // Tauri 2.10+ (this changed between releases — the previous
        // setup that assumed Tauri preserved it broke drag + maximize
        // on the user's machine). Without WS_THICKFRAME the OS:
        //   * places a "maximized" window over the FULL monitor rect
        //     (covering the taskbar), and
        //   * doesn't recognize startDragging()'s WM_NCLBUTTONDOWN
        //     (HTCAPTION) as a real move command, so the drag silently
        //     snaps the window back to its starting position.
        //
        // The fix is to FORCE the style bits we want — both add the
        // ones we need AND strip the ones we don't — instead of
        // trusting Tauri's pre-state.
        let style = GetWindowLongW(hwnd, GWL_STYLE);
        let strip = (WS_CAPTION.0 | WS_SYSMENU.0) as i32;
        let add   = (WS_THICKFRAME.0 | WS_MINIMIZEBOX.0 | WS_MAXIMIZEBOX.0) as i32;
        let new_style = (style & !strip) | add;
        SetWindowLongW(hwnd, GWL_STYLE, new_style);

        // Subclass the window proc so WM_NCCALCSIZE returns 0 →
        // client area covers the entire window, no residual title
        // strip or accent border can be painted by the OS or DWM.
        // AND so WM_GETMINMAXINFO clamps maximize to the work area.
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
