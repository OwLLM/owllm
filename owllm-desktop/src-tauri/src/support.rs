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
    /// RAW WSL distro list as the app's own probe sees it (`wsl -l -q`,
    /// system distros included). The single most useful line for diagnosing
    /// the recurring "WSL installed but app says not installed" reports —
    /// e.g. `["docker-desktop"]` means there's no real Linux, only Docker's.
    pub wsl_distros: Vec<String>,
    /// Installed module ids (e.g. local-inference, python-runtime).
    pub modules: Vec<String>,
    /// Sessions that ended without running their shutdown — the app being
    /// killed, an OOM, a hard crash, a power cut. Rides along on every support
    /// report because the user who files "it keeps closing by itself" is
    /// exactly the user who cannot tell you why.
    pub unclean_shutdowns: Vec<crate::session_health::UncleanShutdown>,
    /// Tail of the crash log: panic backtraces and the exit-path breadcrumbs
    /// that say who asked for the last shutdown.
    pub crash_log_tail: String,
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
/// DIB, works even when partially occluded). Linux: GDK pixbuf readback of
/// our own GTK window (works on X11 and, for the app's own surface, on
/// Wayland — no portal round-trip needed because we never touch other
/// windows). macOS uses the system screenshot service scoped to our NSWindow.
/// NEVER captures other windows or monitors.
#[tauri::command]
pub async fn support_capture_window(app: tauri::AppHandle) -> Result<WindowCapture, String> {
    let main = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let (png, w, h) = tokio::task::spawn_blocking(move || capture_window_png(&main))
        .await
        .map_err(|e| format!("join: {e}"))??;
    use base64::Engine as _;
    Ok(WindowCapture {
        png_base64: base64::engine::general_purpose::STANDARD.encode(png),
        width: w,
        height: h,
        not_captured: "the decorative frame chrome around the window (a separate overlay layer); other windows and monitors are never captured".to_string(),
    })
}

/// Capture one OWLLM-owned window as PNG bytes without touching any other
/// application or monitor. Shared by Watcher and the agent browser so both
/// surfaces use one platform implementation.
pub(crate) fn capture_window_png(win: &tauri::Window) -> Result<(Vec<u8>, u32, u32), String> {
    // A minimized window has no rendered pixels. Windows parks it at 160x28
    // off-screen, so the capture SUCCEEDS and returns a black sliver that an
    // agent then treats as a real screenshot of the page. Refuse instead of
    // handing back evidence of nothing.
    if win.is_minimized().unwrap_or(false) {
        return Err(format!(
            "the {} window is minimized, so it has no rendered pixels to capture — \
             restore it and retry, or use scope=desktop",
            win.label()
        ));
    }
    #[cfg(windows)]
    {
        let hwnd = win.hwnd().map_err(|e| format!("hwnd: {e}"))?.0 as isize;
        let (raw, w, h) = capture_hwnd_rgba(hwnd)?;
        return Ok((encode_png(&raw, w, h)?, w, h));
    }
    #[cfg(target_os = "linux")]
    {
        // GTK/GDK are main-thread-only. Schedule the readback and wait from the
        // caller's worker thread; the Tauri event loop remains free to paint.
        let (tx, rx) = std::sync::mpsc::channel();
        let window = win.clone();
        win.run_on_main_thread(move || {
            let _ = tx.send(capture_gtk_window_png(&window));
        })
        .map_err(|e| format!("main thread: {e}"))?;
        return rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .map_err(|_| "capture timed out".to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        return capture_macos_window_png(win);
    }
    #[allow(unreachable_code)]
    Err(format!(
        "window capture is not implemented on {}",
        std::env::consts::OS
    ))
}

/// GDK readback of our own window → PNG bytes (+ pixel size). Must run on
/// the GTK main thread. Returns an honest error when the compositor gives
/// us nothing (e.g. the window is unmapped) instead of a black image.
#[cfg(target_os = "linux")]
fn capture_gtk_window_png(win: &tauri::Window) -> Result<(Vec<u8>, u32, u32), String> {
    use gtk::prelude::*;
    let gtk_win = win.gtk_window().map_err(|e| format!("gtk window: {e}"))?;
    let gdk_win = gtk_win
        .window()
        .ok_or_else(|| "window is not realized yet".to_string())?;
    let w = gdk_win.width();
    let h = gdk_win.height();
    // gdk_pixbuf_get_from_window — bound as WindowExtManual::pixbuf().
    let pixbuf = gdk_win.pixbuf(0, 0, w, h).ok_or_else(|| {
        "the compositor refused the readback — attach a regular OS screenshot instead".to_string()
    })?;
    let png = pixbuf
        .save_to_bufferv("png", &[])
        .map_err(|e| format!("png encode: {e}"))?;
    Ok((png, pixbuf.width() as u32, pixbuf.height() as u32))
}

/// Capture a single NSWindow through macOS' built-in screenshot utility. The
/// `-l` window id keeps the capture scoped to OWLLM even when another app sits
/// above it; there is deliberately no screen-sized fallback.
#[cfg(target_os = "macos")]
fn capture_macos_window_png(win: &tauri::Window) -> Result<(Vec<u8>, u32, u32), String> {
    use std::ffi::{c_char, c_void};

    #[link(name = "objc")]
    extern "C" {
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend(receiver: *mut c_void, selector: *mut c_void) -> isize;
    }

    let ns_window = win.ns_window().map_err(|e| format!("NSWindow: {e}"))? as *mut c_void;
    let window_number = unsafe {
        let selector = sel_registerName(b"windowNumber\0".as_ptr().cast());
        objc_msgSend(ns_window, selector)
    };
    if window_number <= 0 {
        return Err("macOS returned no window id for this OWLLM window".into());
    }

    let path = std::env::temp_dir().join(format!(
        "owllm-window-capture-{}-{}.png",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let output = std::process::Command::new("/usr/sbin/screencapture")
        .arg("-x")
        .arg("-o")
        .arg("-l")
        .arg(window_number.to_string())
        .arg(&path)
        .output()
        .map_err(|e| format!("start macOS window capture: {e}"))?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&path);
        return Err(format!(
            "macOS window capture failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let png = std::fs::read(&path).map_err(|e| format!("read captured PNG: {e}"));
    let _ = std::fs::remove_file(&path);
    let png = png?;
    let (w, h) = png_dimensions(&png)?;
    Ok((png, w, h))
}

pub(crate) fn png_dimensions(png: &[u8]) -> Result<(u32, u32), String> {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if png.len() < 24 || &png[..8] != PNG_SIGNATURE || &png[12..16] != b"IHDR" {
        return Err("capture did not produce a valid PNG".into());
    }
    let width = u32::from_be_bytes(png[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(png[20..24].try_into().unwrap());
    if width == 0 || height == 0 {
        return Err("capture produced an empty PNG".into());
    }
    Ok((width, height))
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
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
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
        let dib = CreateDIBSection(
            mem_dc,
            &bi,
            DIB_RGB_COLORS,
            &mut bits,
            std::ptr::null_mut(),
            0,
        );
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

/// Capture the whole virtual screen (all monitors) → tightly-packed RGBA
/// (top-down). BitBlt of the screen DC — works from any thread, needs no
/// window handle (unlike the PrintWindow app-window capture above).
#[cfg(windows)]
fn capture_virtual_screen_rgba() -> Result<(Vec<u8>, u32, u32), String> {
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
        SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, SRCCOPY,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };
    unsafe {
        let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let w = GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1) as u32;
        let h = GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1) as u32;

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
        let dib = CreateDIBSection(
            mem_dc,
            &bi,
            DIB_RGB_COLORS,
            &mut bits,
            std::ptr::null_mut(),
            0,
        );
        if dib.is_null() || bits.is_null() {
            DeleteDC(mem_dc);
            ReleaseDC(std::ptr::null_mut(), screen_dc);
            return Err("CreateDIBSection failed".into());
        }
        let old = SelectObject(mem_dc, dib as _);
        let ok = BitBlt(mem_dc, 0, 0, w as i32, h as i32, screen_dc, x, y, SRCCOPY);
        let result = if ok != 0 {
            let n = (w as usize) * (h as usize) * 4;
            let src = std::slice::from_raw_parts(bits as *const u8, n);
            // BGRA → RGBA, force alpha opaque.
            let mut rgba = vec![0u8; n];
            for i in (0..n).step_by(4) {
                rgba[i] = src[i + 2];
                rgba[i + 1] = src[i + 1];
                rgba[i + 2] = src[i];
                rgba[i + 3] = 0xFF;
            }
            Ok((rgba, w, h))
        } else {
            Err("BitBlt failed".to_string())
        };
        SelectObject(mem_dc, old);
        DeleteObject(dib as _);
        DeleteDC(mem_dc);
        ReleaseDC(std::ptr::null_mut(), screen_dc);
        result
    }
}

/// Capture the desktop as PNG bytes (+ pixel size), for agent and remote-device
/// screenshot commands. Windows captures the full virtual desktop, macOS the
/// primary display (subject to Screen Recording permission), and Linux uses the
/// XDG screenshot portal so Wayland compositors can enforce user consent.
#[cfg(windows)]
pub(crate) async fn capture_screen_png() -> Result<(Vec<u8>, u32, u32), String> {
    let (raw, w, h) = tokio::task::spawn_blocking(capture_virtual_screen_rgba)
        .await
        .map_err(|e| format!("join: {e}"))??;
    let png = encode_png(&raw, w, h)?;
    Ok((png, w, h))
}

#[cfg(target_os = "macos")]
pub(crate) async fn capture_screen_png() -> Result<(Vec<u8>, u32, u32), String> {
    tokio::task::spawn_blocking(|| {
        let path = std::env::temp_dir().join(format!(
            "owllm-screen-capture-{}-{}.png",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let output = std::process::Command::new("/usr/sbin/screencapture")
            .arg("-x")
            .arg("-D")
            .arg("1")
            .arg(&path)
            .output()
            .map_err(|e| format!("start macOS screen capture: {e}"))?;
        if !output.status.success() {
            let _ = std::fs::remove_file(&path);
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if detail.is_empty() {
                "macOS screen capture failed; allow Screen Recording for OWLLM in System Settings > Privacy & Security".to_string()
            } else {
                format!("macOS screen capture failed: {detail}")
            });
        }
        let png = std::fs::read(&path).map_err(|e| format!("read captured PNG: {e}"));
        let _ = std::fs::remove_file(&path);
        let png = png?;
        let (w, h) = png_dimensions(&png)?;
        Ok((png, w, h))
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

#[cfg(target_os = "linux")]
pub(crate) async fn capture_screen_png() -> Result<(Vec<u8>, u32, u32), String> {
    let response = ashpd::desktop::screenshot::Screenshot::request()
        .interactive(false)
        .modal(false)
        .send()
        .await
        .map_err(|e| format!("request Linux screen capture: {e}"))?
        .response()
        .map_err(|e| format!("Linux screen capture was cancelled or denied: {e}"))?;
    let path = response.uri().to_file_path().map_err(|_| {
        format!(
            "Linux screenshot portal returned a non-file URI: {}",
            response.uri()
        )
    })?;
    let png = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("read Linux portal screenshot {}: {e}", path.display()))?;
    let (w, h) = png_dimensions(&png)?;
    Ok((png, w, h))
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
pub(crate) async fn capture_screen_png() -> Result<(Vec<u8>, u32, u32), String> {
    Err(format!(
        "screen capture is not implemented on {}",
        std::env::consts::OS
    ))
}

/// RGBA → PNG bytes.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn encode_png(rgba: &[u8], w: u32, h: u32) -> Result<Vec<u8>, String> {
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

/// Save a bug-report bundle LOCALLY (the private default — no backend is
/// configured, so nothing is transmitted anywhere). Writes report.json and
/// the optional screenshot into %USERPROFILE%\OwLLM\bug-reports\<stamp>\
/// and returns that folder. The caller has already shown the user the
/// exact redacted contents (preview-before-anything is mandatory).
#[cfg(test)]
mod capture_tests {
    #[test]
    fn png_dimensions_rejects_non_png_input() {
        assert!(super::png_dimensions(b"not a png").is_err());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_virtual_desktop_capture_produces_a_real_png() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
        };

        let (png, width, height) = super::capture_screen_png()
            .await
            .expect("Windows virtual desktop capture should succeed");
        assert!(width > 0 && height > 0);
        assert_eq!(width, unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) }
            as u32);
        assert_eq!(height, unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) }
            as u32);
        assert_eq!(super::png_dimensions(&png), Ok((width, height)));
    }
}

#[tauri::command]
pub async fn support_export_report(
    report_json: String,
    png_base64: Option<String>,
) -> Result<String, String> {
    use base64::Engine as _;
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or_else(|| "no home directory".to_string())?;
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let dir = std::path::PathBuf::from(home)
        .join("OwLLM")
        .join("bug-reports")
        .join(format!("report-{stamp}"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    std::fs::write(dir.join("report.json"), report_json.as_bytes())
        .map_err(|e| format!("write report.json: {e}"))?;
    if let Some(b64) = png_base64.filter(|s| !s.is_empty()) {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64.as_bytes())
            .map_err(|e| format!("decode screenshot: {e}"))?;
        std::fs::write(dir.join("screenshot.png"), bytes)
            .map_err(|e| format!("write screenshot.png: {e}"))?;
    }
    Ok(dir.to_string_lossy().into_owned())
}

/// The team intake repo for in-app bug reports. Private; reports arrive as
/// issues (label `auto-report`) plus the raw redacted bundle committed under
/// reports/<stamp>/.
const BUG_REPORT_REPO: &str = "OwLLM/bug-reports";

/// Where a submitted report landed, so the UI can link the user straight to it.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SentReport {
    pub issue_url: String,
    pub bundle_url: String,
}

/// SEND a redacted bug report straight to the OwLLM team's GitHub intake
/// (one click — no save-and-forward). Commits report.json (+ optional
/// screenshot.png) under reports/<stamp>/ and opens an issue referencing
/// them. Uses the user's connected GitHub token (device-local; never
/// embedded). The caller has already redacted + previewed the bundle.
#[tauri::command]
pub async fn support_send_report(
    title: String,
    body_md: String,
    report_json: String,
    png_base64: Option<String>,
) -> Result<SentReport, String> {
    use base64::Engine as _;
    let token = crate::accounts::accounts_get_secret("GITHUB_TOKEN".to_string()).ok_or_else(|| {
        "Connect GitHub first (Home → sign in) so the Watcher can send reports to the OwLLM team."
            .to_string()
    })?;
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let dir = format!("reports/{stamp}");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("owllm-desktop")
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    // 1) Commit the redacted report bundle.
    let report_b64 = base64::engine::general_purpose::STANDARD.encode(report_json.as_bytes());
    gh_put_file(
        &client,
        &token,
        &format!("{dir}/report.json"),
        &report_b64,
        &format!("report {stamp}"),
    )
    .await
    .map_err(|e| format!("couldn't upload the report to the OwLLM team repo: {e}"))?;

    let mut shot_line = String::new();
    if let Some(png) = png_base64.filter(|s| !s.is_empty()) {
        // png_base64 is already base64 of the PNG bytes — the Contents API
        // wants exactly that.
        gh_put_file(
            &client,
            &token,
            &format!("{dir}/screenshot.png"),
            &png,
            &format!("screenshot {stamp}"),
        )
        .await
        .map_err(|e| format!("report uploaded but screenshot failed: {e}"))?;
        shot_line = format!(
            "\n📸 Screenshot: [`{dir}/screenshot.png`](https://github.com/{repo}/blob/main/{dir}/screenshot.png)\n",
            repo = BUG_REPORT_REPO,
        );
    }

    // 2) Open the issue referencing the bundle.
    let bundle_url = format!("https://github.com/{}/tree/main/{}", BUG_REPORT_REPO, dir);
    let body =
        format!("{body_md}\n\n---\n📦 Full redacted bundle: [`{dir}/`]({bundle_url}){shot_line}",);
    let issue_url = gh_create_issue(&client, &token, &title, &body).await?;
    Ok(SentReport {
        issue_url,
        bundle_url,
    })
}

/// PUT a file into the bug-report repo via the GitHub Contents API.
async fn gh_put_file(
    client: &reqwest::Client,
    token: &str,
    path: &str,
    content_b64: &str,
    message: &str,
) -> Result<(), String> {
    let url = format!(
        "https://api.github.com/repos/{}/contents/{}",
        BUG_REPORT_REPO, path
    );
    let resp = client
        .put(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(&serde_json::json!({ "message": message, "content": content_b64 }))
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;
    if resp.status().is_success() {
        return Ok(());
    }
    let code = resp.status();
    let msg = resp
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
        .unwrap_or_else(|| "unknown error".into());
    Err(format!("GitHub {code}: {msg}"))
}

/// Open an issue in the bug-report repo. Returns its html_url.
async fn gh_create_issue(
    client: &reqwest::Client,
    token: &str,
    title: &str,
    body: &str,
) -> Result<String, String> {
    let url = format!("https://api.github.com/repos/{}/issues", BUG_REPORT_REPO);
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(&serde_json::json!({ "title": title, "body": body, "labels": ["auto-report"] }))
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;
    if !resp.status().is_success() {
        let code = resp.status();
        let msg = resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
            .unwrap_or_else(|| "unknown error".into());
        return Err(format!(
            "opened the bundle but couldn't create the issue — GitHub {code}: {msg}"
        ));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("parse issue: {e}"))?;
    v.get("html_url")
        .and_then(|u| u.as_str())
        .map(String::from)
        .ok_or_else(|| "issue created but no URL returned".to_string())
}

#[tauri::command]
pub async fn support_snapshot(app: tauri::AppHandle) -> Result<SupportSnapshot, String> {
    let readiness = crate::readiness::app_readiness(app.clone())
        .await
        .unwrap_or_default();
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
        .filter(|m| {
            matches!(
                m.state,
                crate::modules::ModuleState::Installed
                    | crate::modules::ModuleState::UpdateAvailable
            )
        })
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
        wsl_distros: crate::wsl::wsl_status_blocking().distros,
        modules,
        unclean_shutdowns: crate::session_health::pending(),
        crash_log_tail: crate::session_health::crash_log_tail(16 * 1024),
    })
}
