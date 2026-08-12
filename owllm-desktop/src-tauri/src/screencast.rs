// Linux screen recording that does not go through xdg-desktop-portal.
//
// `navigator.mediaDevices.getDisplayMedia()` cannot record on a GNOME/Ubuntu
// desktop: WebKitGTK routes display capture through xdg-desktop-portal, and the
// GNOME backend (xdg-desktop-portal-gnome 46.2, the current Ubuntu 24.04 build)
// SEGVs on the parent-window handle WebKit hands it —
//
//     xdg-desktop-por[...]: Failed to associate portal window with parent window
//     xdg-desktop-portal-gnome.service: Main process exited, code=dumped, status=11/SEGV
//
// WebKit then falls back to camera enumeration, finds no devices and rejects
// with OverconstrainedError after ~25 s, so the recorder appears to do nothing.
//
// GNOME Shell exposes the very same recorder directly on the session bus, one
// layer BELOW the portal, as org.gnome.Shell.Screencast. That path records
// fine. Two properties of it drive the shape of this module:
//
//   * The recording is bound to the CALLER's D-Bus connection. A client that
//     disconnects gets `RecorderError: Sender has vanished` and a truncated
//     stub file, so the connection is parked in a process-global for the whole
//     recording rather than created per command.
//   * There is no picker and no pause. Whole-screen capture is `Screencast`;
//     "just the app" is `ScreencastArea` over the main window's rectangle.
//
// Every other platform keeps getDisplayMedia: `screencast_supported()` returns
// false off Linux and on Linux desktops that do not run GNOME Shell (KDE,
// Sway, …), where the portal is the only route and generally works.

use serde::Serialize;

/// Where a finished recording ends up, and how big it is.
#[derive(Serialize)]
pub struct ScreencastFile {
    pub path: String,
    pub bytes: u64,
}

#[cfg(target_os = "linux")]
mod imp {
    use super::ScreencastFile;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;
    use zbus::zvariant::Value;

    /// A non-GNOME session must not make the UI wait: every probe is bounded.
    const BUS_TIMEOUT: Duration = Duration::from_secs(3);
    /// GNOME finalises the container after StopScreencast returns; give the
    /// muxer a moment to settle before reporting a size.
    const FINALIZE_POLL: Duration = Duration::from_millis(150);
    const FINALIZE_TRIES: u32 = 20;

    #[zbus::proxy(
        interface = "org.gnome.Shell.Screencast",
        default_service = "org.gnome.Shell.Screencast",
        default_path = "/org/gnome/Shell/Screencast"
    )]
    trait Screencast {
        fn screencast(
            &self,
            file_template: &str,
            options: HashMap<&str, Value<'_>>,
        ) -> zbus::Result<(bool, String)>;

        fn screencast_area(
            &self,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            file_template: &str,
            options: HashMap<&str, Value<'_>>,
        ) -> zbus::Result<(bool, String)>;

        fn stop_screencast(&self) -> zbus::Result<bool>;

        #[zbus(property)]
        fn screencast_supported(&self) -> zbus::Result<bool>;
    }

    /// The live recording. Holding `conn` is what keeps GNOME writing frames —
    /// dropping it is what produces "Sender has vanished".
    struct Session {
        conn: zbus::Connection,
        path: PathBuf,
    }

    fn session() -> &'static Mutex<Option<Session>> {
        static SESSION: OnceLock<Mutex<Option<Session>>> = OnceLock::new();
        SESSION.get_or_init(|| Mutex::new(None))
    }

    async fn connect() -> Result<zbus::Connection, String> {
        tokio::time::timeout(BUS_TIMEOUT, zbus::Connection::session())
            .await
            .map_err(|_| "the session D-Bus did not answer".to_string())?
            .map_err(|e| format!("session D-Bus unavailable: {e}"))
    }

    pub async fn supported() -> bool {
        let Ok(conn) = connect().await else { return false };
        let Ok(Ok(proxy)) =
            tokio::time::timeout(BUS_TIMEOUT, ScreencastProxy::new(&conn)).await
        else {
            return false;
        };
        matches!(
            tokio::time::timeout(BUS_TIMEOUT, proxy.screencast_supported()).await,
            Ok(Ok(true))
        )
    }

    /// Recordings land beside whatever the WebView downloads, so the video and
    /// its companion clicks.json stay together.
    fn output_dir() -> PathBuf {
        if let Some(dir) = std::env::var_os("XDG_DOWNLOAD_DIR") {
            let dir = PathBuf::from(dir);
            if dir.is_dir() {
                return dir;
            }
        }
        let home = std::env::var_os("HOME").map(PathBuf::from);
        if let Some(home) = home {
            let downloads = home.join("Downloads");
            if downloads.is_dir() {
                return downloads;
            }
            return home;
        }
        std::env::temp_dir()
    }

    /// `file_stem` comes from the recorder UI so the video and the click track
    /// share one timestamp; strip any path separators a caller could smuggle in.
    fn safe_stem(file_stem: &str) -> String {
        let cleaned: String = file_stem
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
            .collect();
        if cleaned.is_empty() {
            "owllm-recording".to_string()
        } else {
            cleaned
        }
    }

    fn options(fps: u32) -> HashMap<&'static str, Value<'static>> {
        let mut opts: HashMap<&'static str, Value<'static>> = HashMap::new();
        opts.insert("framerate", Value::I32(fps.clamp(1, 60) as i32));
        opts.insert("draw-cursor", Value::Bool(true));
        opts
    }

    pub async fn start(
        file_stem: String,
        fps: u32,
        area: Option<(i32, i32, i32, i32)>,
    ) -> Result<String, String> {
        if session().lock().map_err(|_| "recorder state poisoned")?.is_some() {
            return Err("A recording is already running.".into());
        }
        let template = output_dir().join(safe_stem(&file_stem));
        let template = template.to_string_lossy().to_string();

        let conn = connect().await?;
        let proxy = ScreencastProxy::new(&conn)
            .await
            .map_err(|e| format!("GNOME Shell recorder unavailable: {e}"))?;

        // GNOME appends the container extension itself and reports the real
        // name back, so the returned path is the one to trust.
        let (ok, filename) = match area {
            Some((x, y, w, h)) => proxy
                .screencast_area(x, y, w, h, &template, options(fps))
                .await
                .map_err(|e| format!("GNOME Shell refused the area recording: {e}"))?,
            None => proxy
                .screencast(&template, options(fps))
                .await
                .map_err(|e| format!("GNOME Shell refused the recording: {e}"))?,
        };
        if !ok {
            return Err("GNOME Shell could not start the recording.".into());
        }

        let path = PathBuf::from(&filename);
        *session().lock().map_err(|_| "recorder state poisoned")? =
            Some(Session { conn, path });
        Ok(filename)
    }

    pub async fn stop() -> Result<ScreencastFile, String> {
        let Session { conn, path } = session()
            .lock()
            .map_err(|_| "recorder state poisoned")?
            .take()
            .ok_or_else(|| "No recording is running.".to_string())?;

        let proxy = ScreencastProxy::new(&conn)
            .await
            .map_err(|e| format!("GNOME Shell recorder unavailable: {e}"))?;
        proxy
            .stop_screencast()
            .await
            .map_err(|e| format!("GNOME Shell refused to stop the recording: {e}"))?;

        // Wait for the muxer to stop growing the file before reporting a size;
        // the connection stays alive until this returns.
        let mut bytes = 0u64;
        for _ in 0..FINALIZE_TRIES {
            let now = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            if now > 0 && now == bytes {
                break;
            }
            bytes = now;
            tokio::time::sleep(FINALIZE_POLL).await;
        }
        drop(conn);
        if bytes == 0 {
            return Err(format!(
                "GNOME Shell wrote no video to {}.",
                path.to_string_lossy()
            ));
        }
        Ok(ScreencastFile {
            path: path.to_string_lossy().to_string(),
            bytes,
        })
    }
}

#[cfg(not(target_os = "linux"))]
mod imp {
    use super::ScreencastFile;

    pub async fn supported() -> bool {
        false
    }

    pub async fn start(
        _file_stem: String,
        _fps: u32,
        _area: Option<(i32, i32, i32, i32)>,
    ) -> Result<String, String> {
        Err("The GNOME Shell recorder only exists on Linux.".into())
    }

    pub async fn stop() -> Result<ScreencastFile, String> {
        Err("The GNOME Shell recorder only exists on Linux.".into())
    }
}

/// True only where the portal-free recorder exists: a Linux session running
/// GNOME Shell. Everywhere else the recorder keeps using getDisplayMedia.
#[tauri::command]
pub async fn screencast_supported() -> bool {
    imp::supported().await
}

/// Start recording. `app_window_only` records the main window's rectangle
/// instead of the whole screen — GNOME has no source picker, so the region is
/// taken from the window itself.
#[tauri::command]
pub async fn screencast_start(
    app: tauri::AppHandle,
    file_stem: String,
    fps: u32,
    app_window_only: bool,
) -> Result<String, String> {
    let area = if app_window_only {
        Some(main_window_rect(&app)?)
    } else {
        None
    };
    imp::start(file_stem, fps, area).await
}

/// Stop recording and report the finished file.
#[tauri::command]
pub async fn screencast_stop() -> Result<ScreencastFile, String> {
    imp::stop().await
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    // Records for real against the running GNOME Shell, so it cannot run on a
    // headless gate — `cargo test -- --ignored screencast_records_a_real_file`
    // on a GNOME session is the manual check that the D-Bus signatures in this
    // module still match the shell's.
    #[tokio::test]
    #[ignore]
    async fn screencast_records_a_real_file() {
        assert!(super::imp::supported().await, "no GNOME Shell recorder on this session");
        let path = super::imp::start("owllm-screencast-selftest".into(), 15, None)
            .await
            .expect("start");
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let file = super::imp::stop().await.expect("stop");
        assert_eq!(file.path, path, "stop reported a different file than start");
        assert!(file.bytes > 10_000, "recording is a {}-byte stub", file.bytes);
        // A dropped connection yields a 48-byte header-only stub, so check the
        // container really is an ISO media file rather than just non-empty.
        let head = std::fs::read(&file.path).expect("read recording");
        assert_eq!(&head[4..8], b"ftyp", "not an ISO media container: {}", file.path);
        std::fs::remove_file(&file.path).ok();
    }

    #[tokio::test]
    #[ignore]
    async fn stop_without_start_is_an_error() {
        assert!(super::imp::stop().await.is_err());
    }
}

/// Physical-pixel rectangle of the main window, which is the coordinate space
/// `ScreencastArea` expects.
fn main_window_rect(app: &tauri::AppHandle) -> Result<(i32, i32, i32, i32), String> {
    use tauri::Manager as _;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "The main window is not open.".to_string())?;
    let pos = window
        .outer_position()
        .map_err(|e| format!("could not read the window position: {e}"))?;
    let size = window
        .outer_size()
        .map_err(|e| format!("could not read the window size: {e}"))?;
    if size.width == 0 || size.height == 0 {
        return Err("The main window has no size to record.".into());
    }
    Ok((
        pos.x.max(0),
        pos.y.max(0),
        size.width as i32,
        size.height as i32,
    ))
}
