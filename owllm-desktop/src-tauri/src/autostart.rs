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

#[cfg(target_os = "windows")]
fn set_windows(enabled: bool) -> Result<(), String> {
    use std::process::Command;
    if enabled {
        let exe = exe_path().ok_or("current exe path unavailable")?;
        // Quote the path so spaces survive; reg stores the /d value verbatim.
        let value = format!("\"{}\"", exe.display());
        let out = Command::new("reg")
            .args(["add", RUN_KEY, "/v", APP_KEY, "/t", "REG_SZ", "/d", &value, "/f"])
            .output()
            .map_err(|e| format!("reg add: {e}"))?;
        if !out.status.success() {
            return Err(format!("reg add failed: {}", String::from_utf8_lossy(&out.stderr)));
        }
    } else {
        let out = Command::new("reg")
            .args(["delete", RUN_KEY, "/v", APP_KEY, "/f"])
            .output()
            .map_err(|e| format!("reg delete: {e}"))?;
        // Absent value → non-zero exit; treat as already-disabled.
        let _ = out;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn is_enabled_windows() -> bool {
    use std::process::Command;
    Command::new("reg")
        .args(["query", RUN_KEY, "/v", APP_KEY])
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

#[cfg(target_os = "linux")]
fn set_linux(enabled: bool) -> Result<(), String> {
    let desktop = linux_desktop().ok_or("HOME/XDG_CONFIG_HOME unavailable")?;
    if enabled {
        let exe = exe_path().ok_or("current exe path unavailable")?;
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
    if is_enabled() {
        return; // already registered
    }
    if let Err(e) = set(true) {
        eprintln!("[owllm] autostart default-enable failed: {e}");
    }
}
