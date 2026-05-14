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
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, DefWindowProcW, GetWindowLongPtrW, SetWindowLongPtrW,
        GWLP_WNDPROC, MINMAXINFO, WM_GETMINMAXINFO, WM_NCCALCSIZE,
    };

    /// Original window proc pointer, captured the first time we
    /// subclass. All non-NC messages flow back through it.
    static ORIGINAL_PROC: OnceLock<isize> = OnceLock::new();

    /// Replace the window proc with one that swallows WM_NCCALCSIZE
    /// (so no system frame is drawn) AND clamps WM_GETMINMAXINFO to
    /// the monitor work area (so maximize doesn't hide under the
    /// taskbar). This is the documented Discord/VSCode pattern for
    /// fully custom Windows frames. CRUCIAL: we must KEEP
    /// WS_THICKFRAME on the window style — that's what makes maximize
    /// snap to the work area and drag-from-caption restore properly.
    /// Stripping THICKFRAME (our previous bug) caused maximize to use
    /// the whole monitor rect (so the taskbar covered the bottom) and
    /// disabled the OS's "restore on drag" logic, which is why drag
    /// was snapping back.
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
            // → the client rect equals the proposed window rect, i.e.
            // no non-client area. Combined with WM_GETMINMAXINFO below,
            // maximized state already sits inside the work area so we
            // don't need to inset the rect ourselves.
            return LRESULT(0);
        }
        if msg == WM_GETMINMAXINFO {
            // Tell Windows to maximize to the monitor WORK AREA (not
            // the full monitor rect). Without this, a window without
            // a system frame can be maximized over the taskbar — which
            // is exactly the "appears below the taskbar" bug the user
            // hit. This is the standard Win32 frameless-window dance.
            let info = lparam.0 as *mut MINMAXINFO;
            if !info.is_null() {
                let monitor: HMONITOR = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                let mut mi = MONITORINFO {
                    cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                    rcMonitor: RECT::default(),
                    rcWork: RECT::default(),
                    dwFlags: 0,
                };
                if GetMonitorInfoW(monitor, &mut mi).as_bool() {
                    // ptMaxPosition is RELATIVE to the monitor's
                    // top-left in virtual screen coordinates.
                    (*info).ptMaxPosition.x = mi.rcWork.left - mi.rcMonitor.left;
                    (*info).ptMaxPosition.y = mi.rcWork.top  - mi.rcMonitor.top;
                    (*info).ptMaxSize.x     = mi.rcWork.right  - mi.rcWork.left;
                    (*info).ptMaxSize.y     = mi.rcWork.bottom - mi.rcWork.top;
                    // Track maxes too so the OS doesn't think the
                    // window can grow taller than the work area.
                    (*info).ptMaxTrackSize.x = (*info).ptMaxSize.x;
                    (*info).ptMaxTrackSize.y = (*info).ptMaxSize.y;
                }
            }
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
        WS_CAPTION, WS_SYSMENU,
    };
    let hwnd = HWND(hwnd_raw as *mut std::ffi::c_void);
    unsafe {
        // Strip ONLY the visible title-bar bits. CRITICALLY we KEEP
        // WS_THICKFRAME — that's the style that tells the OS this
        // window is "movable + resizable like a normal app window",
        // which in turn:
        //   * makes startDragging() (WM_NCLBUTTONDOWN(HTCAPTION))
        //     restore-and-follow-cursor when maximized (otherwise
        //     the drag silently snaps the window back),
        //   * makes maximize obey the work area (under WS_THICKFRAME
        //     plus our WM_GETMINMAXINFO clamp), and
        //   * preserves the invisible resize edges so our explicit
        //     ResizeEdges JS handlers + the OS both work.
        //
        // WS_CAPTION (the title strip) is the visible source of the
        // "we look like a normal Windows app" appearance — strip it.
        // WS_SYSMENU (system menu icon) makes no sense without a
        // caption — strip it too. Everything else stays.
        let style = GetWindowLongW(hwnd, GWL_STYLE);
        let strip = (WS_CAPTION.0 | WS_SYSMENU.0) as i32;
        let new_style = style & !strip;
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
