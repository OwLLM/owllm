// The Watcher — app-context snapshot for the in-app support assistant.
//
// COMPOSES existing probes only (readiness, hardware, server supervisor,
// WSL setup stage, module manager) — no parallel diagnostics system.
// Everything returned here is non-secret by construction: no API keys,
// no prompt/file contents, no auth material; paths are limited to none.
// The frontend Watcher merges in UI-side context (current page, project)
// before showing it to the user.

use serde::Serialize;
use tauri::Manager;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SupportSnapshot {
    pub app_version: String,
    pub os: String,
    pub arch: String,
    pub cpu: String,
    pub gpus: Vec<String>,
    pub ram_total_gb: f64,
    /// The Home page's real readiness rows (WSL / GPU / env / runtime).
    pub readiness: crate::readiness::AppReadiness,
    /// Local model-server supervisor state (running / model / crash cause).
    pub server: crate::server::ServerStatus,
    /// Guided-WSL-setup stage + detail ("ready", "needsUser", …).
    pub wsl_stage: String,
    pub wsl_detail: String,
    /// Installed module ids (e.g. local-inference, python-runtime).
    pub modules: Vec<String>,
}

/// Result of a user-approved app-window capture (Slice 3). The PNG comes
/// back base64-encoded so the UI can preview it as a data URL before the
/// user decides whether it joins a bug report. `not_captured` is honest
/// about what the platform path could NOT include.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WindowCapture {
    pub png_base64: String,
    pub width: u32,
    pub height: u32,
    /// What this capture does NOT include (e.g. the decorative overlay
    /// chrome window, other monitors/windows — never captured).
    pub not_captured: String,
}

/// Capture the actual app window — including in-app modals/popups, which
/// live in the same WebView surface. Windows: PrintWindow with
/// PW_RENDERFULLCONTENT (renders the WebView2 composition surface into a
/// DIB, works even when partially occluded). Other platforms return an
/// explicit error the UI surfaces as the documented fallback message.
/// NEVER captures other windows or monitors.
#[tauri::command]
pub async fn support_capture_window(app: tauri::AppHandle) -> Result<WindowCapture, String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    #[cfg(windows)]
    {
        let hwnd = main.hwnd().map_err(|e| format!("hwnd: {e}"))?.0 as isize;
        // GDI is thread-safe enough for this one-shot, but keep it off the
        // async executor — PrintWindow can take tens of ms.
        let (raw, w, h) = tokio::task::spawn_blocking(move || capture_hwnd_rgba(hwnd))
            .await
            .map_err(|e| format!("join: {e}"))??;
        let png = encode_png(&raw, w, h)?;
        use base64::Engine as _;
        Ok(WindowCapture {
            png_base64: base64::engine::general_purpose::STANDARD.encode(png),
            width: w,
            height: h,
            not_captured: "the decorative frame chrome around the window (a separate overlay layer); other windows and monitors are never captured".to_string(),
        })
    }
    #[cfg(not(windows))]
    {
        let _ = main;
        Err("App-window capture isn't implemented on this platform yet — attach a regular OS screenshot instead.".to_string())
    }
}

/// PrintWindow → 32-bit DIB → tightly-packed RGBA bytes (top-down).
#[cfg(windows)]
fn capture_hwnd_rgba(hwnd: isize) -> Result<(Vec<u8>, u32, u32), String> {
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
        SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows_sys::Win32::Storage::Xps::PrintWindow;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect;

    const PW_RENDERFULLCONTENT: u32 = 0x0000_0002; // undocumented-but-stable: composition surfaces (WebView2)

    unsafe {
        let hwnd = hwnd as HWND;
        let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return Err("GetWindowRect failed".into());
        }
        let w = (rect.right - rect.left).max(1) as u32;
        let h = (rect.bottom - rect.top).max(1) as u32;

        let screen_dc = GetDC(std::ptr::null_mut());
        if screen_dc.is_null() {
            return Err("GetDC failed".into());
        }
        let mem_dc = CreateCompatibleDC(screen_dc);
        if mem_dc.is_null() {
            ReleaseDC(std::ptr::null_mut(), screen_dc);
            return Err("CreateCompatibleDC failed".into());
        }
        // Top-down 32bpp DIB so the pixel buffer is directly indexable.
        let mut bi: BITMAPINFO = std::mem::zeroed();
        bi.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w as i32,
            biHeight: -(h as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB as u32,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        };
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let dib = CreateDIBSection(mem_dc, &bi, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
        if dib.is_null() || bits.is_null() {
            DeleteDC(mem_dc);
            ReleaseDC(std::ptr::null_mut(), screen_dc);
            return Err("CreateDIBSection failed".into());
        }
        let old = SelectObject(mem_dc, dib as _);
        let ok = PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT);
        // Copy pixels out BEFORE tearing the GDI objects down.
        let result = if ok != 0 {
            let n = (w as usize) * (h as usize) * 4;
            let src = std::slice::from_raw_parts(bits as *const u8, n);
            // BGRA → RGBA, force alpha opaque (GDI alpha is unreliable).
            let mut rgba = vec![0u8; n];
            for i in (0..n).step_by(4) {
                rgba[i] = src[i + 2];
                rgba[i + 1] = src[i + 1];
                rgba[i + 2] = src[i];
                rgba[i + 3] = 0xFF;
            }
            Ok((rgba, w, h))
        } else {
            Err("PrintWindow failed".to_string())
        };
        SelectObject(mem_dc, old);
        DeleteObject(dib as _);
        DeleteDC(mem_dc);
        ReleaseDC(std::ptr::null_mut(), screen_dc);
        result
    }
}

/// RGBA → PNG bytes.
#[cfg_attr(not(windows), allow(dead_code))]
fn encode_png(rgba: &[u8], w: u32, h: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().map_err(|e| format!("png header: {e}"))?;
        writer
            .write_image_data(rgba)
            .map_err(|e| format!("png encode: {e}"))?;
    }
    Ok(out)
}

#[tauri::command]
pub async fn support_snapshot(app: tauri::AppHandle) -> Result<SupportSnapshot, String> {
    let readiness = crate::readiness::app_readiness().await.unwrap_or_default();
    let hw = crate::hardware::hardware_info().await.unwrap_or_default();
    let server = {
        let st = app.state::<crate::server::ServerState>();
        crate::server::server_status(st).await.unwrap_or_default()
    };
    let wsl = crate::wsl_setup::wsl_setup_status();
    let modules = crate::modules::module_list(app.clone())
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|m| matches!(m.state, crate::modules::ModuleState::Installed | crate::modules::ModuleState::UpdateAvailable))
        .map(|m| m.id)
        .collect();
    Ok(SupportSnapshot {
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        cpu: hw.cpu_name.clone(),
        gpus: hw.gpus.iter().map(|g| g.name.clone()).collect(),
        ram_total_gb: hw.ram_total_gb,
        readiness,
        server,
        wsl_stage: wsl.stage,
        wsl_detail: wsl.detail,
        modules,
    })
}
