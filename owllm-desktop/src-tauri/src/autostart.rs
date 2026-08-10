//! Launch OwLLM automatically when the user logs in.
//!
//! Cross-platform and dependency-free: Windows uses the per-user `Run`
//! registry key, macOS a LaunchAgent plist, Linux an XDG autostart `.desktop`.
//! All operations are per-user (no elevation) and idempotent. Every failure is
//! logged and swallowed — autostart is a convenience, never a launch blocker.

use std::path::PathBuf;

const APP_KEY: &str = "OwLLM Desktop";

/// Absolute path to the running executable (best-effort).
fn exe_path() -> Option<PathBuf> {
    std::env::current_exe().ok()
}

/// Turn login-autostart on (`true`) or off (`false`). Idempotent.
pub fn set(enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        set_windows(enabled)
    }
    #[cfg(target_os = "macos")]
    {
        set_macos(enabled)
    }
    #[cfg(target_os = "linux")]
    {
        set_linux(enabled)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = enabled;
        Err("autostart unsupported on this platform".into())
    }
}

/// Whether login-autostart is currently registered.
pub fn is_enabled() -> bool {
    #[cfg(target_os = "windows")]
    {
        is_enabled_windows()
    }
    #[cfg(target_os = "macos")]
    {
        macos_plist().map(|p| p.exists()).unwrap_or(false)
    }
    #[cfg(target_os = "linux")]
    {
        linux_desktop().map(|p| p.exists()).unwrap_or(false)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        false
    }
}

// ---- Windows: HKCU\...\Run -------------------------------------------------

#[cfg(target_os = "windows")]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

/// `reg.exe` is a console program. Every invocation here happens on the app's
/// startup path, so spawning it with the default creation flags produces the
/// recurring one-frame Command Prompt flash before the webview has painted.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(target_os = "windows")]
fn set_windows(enabled: bool) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    if enabled {
        let exe = exe_path().ok_or("current exe path unavailable")?;
        // Quote the path so spaces survive; reg stores the /d value verbatim.
        let value = format!("\"{}\"", exe.display());
        let out = Command::new("reg")
            .args([
                "add", RUN_KEY, "/v", APP_KEY, "/t", "REG_SZ", "/d", &value, "/f",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("reg add: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "reg add failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
    } else {
        let out = Command::new("reg")
            .args(["delete", RUN_KEY, "/v", APP_KEY, "/f"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("reg delete: {e}"))?;
        // Absent value → non-zero exit; treat as already-disabled.
        let _ = out;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn is_enabled_windows() -> bool {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    Command::new("reg")
        .args(["query", RUN_KEY, "/v", APP_KEY])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// ---- macOS: ~/Library/LaunchAgents/<id>.plist -----------------------------

#[cfg(target_os = "macos")]
fn macos_plist() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Library/LaunchAgents/com.owllm.desktop.plist"))
}

#[cfg(target_os = "macos")]
fn set_macos(enabled: bool) -> Result<(), String> {
    let plist = macos_plist().ok_or("HOME unavailable")?;
    if enabled {
        let exe = exe_path().ok_or("current exe path unavailable")?;
        if let Some(dir) = plist.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("mkdir LaunchAgents: {e}"))?;
        }
        let body = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
             <plist version=\"1.0\"><dict>\n\
             \t<key>Label</key><string>com.owllm.desktop</string>\n\
             \t<key>ProgramArguments</key><array><string>{}</string></array>\n\
             \t<key>RunAtLoad</key><true/>\n\
             </dict></plist>\n",
            exe.display()
        );
        std::fs::write(&plist, body).map_err(|e| format!("write plist: {e}"))?;
    } else if plist.exists() {
        std::fs::remove_file(&plist).map_err(|e| format!("remove plist: {e}"))?;
    }
    Ok(())
}

// ---- Linux: ~/.config/autostart/owllm.desktop -----------------------------

#[cfg(target_os = "linux")]
fn linux_desktop() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("autostart/owllm.desktop"))
}

/// Whether `path` sits in a directory the OS clears (reboot or tmpfiles), which
/// would leave an autostart entry pointing at a file that no longer exists.
#[cfg(target_os = "linux")]
fn is_volatile_path(path: &std::path::Path) -> bool {
    const VOLATILE: [&str; 4] = ["/tmp/", "/var/tmp/", "/dev/shm/", "/run/"];
    let path = path.to_string_lossy();
    VOLATILE.iter().any(|dir| path.starts_with(dir))
}

/// Pick the path to record in the autostart entry, rejecting any candidate the
/// OS wipes. Returning `None` leaves an existing good entry untouched, which
/// beats overwriting it with a path that cannot survive the next boot.
#[cfg(target_os = "linux")]
fn stable_autostart_exe(appimage: Option<PathBuf>, current: Option<PathBuf>) -> Option<PathBuf> {
    appimage.or(current).filter(|path| !is_volatile_path(path))
}

#[cfg(target_os = "linux")]
fn linux_exe_path() -> Option<PathBuf> {
    // `current_exe()` points inside /tmp/.mount_* when running as an AppImage.
    // That mount disappears as soon as the app exits, leaving login autostart
    // permanently broken. AppImage's runtime provides the stable source path.
    let appimage = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_file());
    // An AppImage launched straight from /tmp is itself wiped on reboot, and so
    // is the .mount_* fallback. Recording either poisons autostart for good: the
    // entry can only self-repair on a launch that then never happens.
    stable_autostart_exe(appimage, exe_path())
}

#[cfg(target_os = "linux")]
fn set_linux(enabled: bool) -> Result<(), String> {
    let desktop = linux_desktop().ok_or("HOME/XDG_CONFIG_HOME unavailable")?;
    if enabled {
        let exe = linux_exe_path().ok_or(
            "current exe path unavailable or inside a directory the OS wipes \
             (/tmp, /var/tmp, /dev/shm, /run); move the AppImage somewhere \
             permanent to enable autostart",
        )?;
        if let Some(dir) = desktop.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("mkdir autostart: {e}"))?;
        }
        let body = format!(
            "[Desktop Entry]\nType=Application\nName={APP_KEY}\nExec=\"{}\"\n\
             X-GNOME-Autostart-enabled=true\nTerminal=false\n",
            exe.display()
        );
        std::fs::write(&desktop, body).map_err(|e| format!("write .desktop: {e}"))?;
    } else if desktop.exists() {
        std::fs::remove_file(&desktop).map_err(|e| format!("remove .desktop: {e}"))?;
    }
    Ok(())
}

// ---- Tauri commands --------------------------------------------------------

/// Read the current login-autostart state.
#[tauri::command]
pub fn autostart_get() -> bool {
    is_enabled()
}

/// Path to the per-user opt-out marker (present ⇒ user disabled autostart).
fn optout_marker() -> Option<PathBuf> {
    crate::paths::user_data_root().map(|d| d.join("autostart-optout"))
}

/// Turn login-autostart on or off. Persists the choice so the boot-time default
/// respects a deliberate opt-out.
#[tauri::command]
pub fn autostart_set(enabled: bool) -> Result<(), String> {
    set(enabled)?;
    if let Some(marker) = optout_marker() {
        if enabled {
            let _ = std::fs::remove_file(&marker);
        } else if let Some(dir) = marker.parent() {
            let _ = std::fs::create_dir_all(dir);
            let _ = std::fs::write(&marker, b"1");
        }
    }
    Ok(())
}

/// Register autostart once, unless the user has explicitly turned it off before.
/// Called at startup so a fresh install self-registers without a click, while
/// still honoring a deliberate opt-out.
pub fn ensure_default_enabled() {
    if optout_marker().map(|m| m.exists()).unwrap_or(false) {
        return; // user turned it off — respect that
    }
    // Re-register on every launch. This is idempotent and repairs stale paths
    // after an app move/update (especially vanished AppImage /tmp mounts).
    if let Err(e) = set(true) {
        eprintln!("[owllm] autostart default-enable failed: {e}");
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::path::Path;

    /// Regression: an AppImage run from `/tmp` was recorded verbatim, so the
    /// next reboot wiped the target. The app then never launched, and because
    /// the entry only self-repairs on launch, it stayed broken for good.
    #[test]
    fn appimage_under_tmp_is_never_recorded() {
        let picked = stable_autostart_exe(
            Some(PathBuf::from("/tmp/v106/owllm106.AppImage")),
            Some(PathBuf::from("/tmp/.mount_abc123/AppRun")),
        );
        assert_eq!(picked, None, "a /tmp AppImage must not reach the entry");
    }

    #[test]
    fn installed_appimage_wins_over_ephemeral_mount() {
        let installed = PathBuf::from("/home/u/Applications/OwLLM.Desktop.AppImage");
        let picked = stable_autostart_exe(
            Some(installed.clone()),
            Some(PathBuf::from("/tmp/.mount_abc123/AppRun")),
        );
        assert_eq!(picked, Some(installed));
    }

    #[test]
    fn wiped_dirs_are_volatile() {
        for path in [
            "/tmp/v106/owllm106.AppImage",
            "/tmp/.mount_abc123/AppRun",
            "/var/tmp/owllm.AppImage",
            "/dev/shm/owllm.AppImage",
            "/run/user/1000/owllm.AppImage",
        ] {
            assert!(is_volatile_path(Path::new(path)), "{path} must be volatile");
        }
    }

    #[test]
    fn install_dirs_are_not_volatile() {
        // `/home/u/tmpfiles/...` guards against a naive `contains("/tmp")`.
        for path in [
            "/home/u/Applications/OwLLM.Desktop.AppImage",
            "/usr/bin/owllm-desktop",
            "/opt/owllm/owllm-desktop",
            "/home/u/tmpfiles/owllm.AppImage",
        ] {
            assert!(!is_volatile_path(Path::new(path)), "{path} must be stable");
        }
    }
}
