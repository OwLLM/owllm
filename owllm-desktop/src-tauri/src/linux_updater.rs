//! Linux AppImage update handoff.
//!
//! A running AppImage must never be rewritten in place: WebKitGTK subprocesses
//! memory-map libraries from its mount and can crash with SIGBUS when the
//! backing file changes. Download and signature verification happen in the
//! running app, but the actual replacement is deferred to the downloaded
//! AppImage. It waits for the old process to exit, swaps files with `rename(2)`,
//! and keeps a rollback copy until the new WebView has loaded successfully.

#[cfg(target_os = "linux")]
use serde::Serialize;
#[cfg(target_os = "linux")]
use std::io::Write;
#[cfg(target_os = "linux")]
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
const APPLY_TARGET_ENV: &str = "OWLLM_LINUX_UPDATE_TARGET";
#[cfg(target_os = "linux")]
const APPLY_PARENT_ENV: &str = "OWLLM_LINUX_UPDATE_PARENT";
#[cfg(target_os = "linux")]
const FIRST_BOOT_ENV: &str = "OWLLM_LINUX_UPDATE_FIRST_BOOT";

/// How long a pending-update marker may exist before an unflagged launch reads
/// it as "the first boot of the new build failed" and rolls back.
///
/// Must be comfortably longer than swap + relaunch + WebView load on slow
/// hardware, and comfortably shorter than a human noticing a crash loop and
/// intervening. A supervisor restarting a genuinely broken build every few
/// seconds crosses this threshold quickly and still gets the rollback.
#[cfg(target_os = "linux")]
const PENDING_MARKER_GRACE: std::time::Duration = std::time::Duration::from_secs(120);

/// True when the marker has outlived [`PENDING_MARKER_GRACE`] — the first boot
/// never confirmed, so the new build is presumed broken. An unreadable mtime
/// counts as stale: that was the pre-grace behaviour (roll back on sight), and
/// rolling back to a known-good build is the safe way to fail.
#[cfg(target_os = "linux")]
fn pending_marker_is_stale(pending: &Path) -> bool {
    std::fs::metadata(pending)
        .and_then(|m| m.modified())
        .and_then(|t| t.elapsed().map_err(|e| std::io::Error::other(e)))
        .map(|age| age > PENDING_MARKER_GRACE)
        .unwrap_or(true)
}

#[cfg(target_os = "linux")]
fn backup_path(target: &Path) -> PathBuf {
    target.with_file_name(format!(
        "{}.previous",
        target.file_name().unwrap_or_default().to_string_lossy()
    ))
}

#[cfg(target_os = "linux")]
fn pending_path(target: &Path) -> PathBuf {
    target.with_file_name(format!(
        "{}.update-pending",
        target.file_name().unwrap_or_default().to_string_lossy()
    ))
}

#[cfg(target_os = "linux")]
fn failed_path(target: &Path) -> PathBuf {
    target.with_file_name(format!(
        "{}.failed-{}",
        target.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ))
}

#[cfg(target_os = "linux")]
fn sync_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("update path has no parent: {}", path.display()))?;
    std::fs::File::open(parent)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| format!("sync update directory {}: {e}", parent.display()))
}

#[cfg(target_os = "linux")]
fn validated_appimage_target(raw: &std::ffi::OsStr) -> Result<PathBuf, String> {
    let target = PathBuf::from(raw);
    if !target.is_absolute() {
        return Err(format!(
            "APPIMAGE must be an absolute path, got {}",
            target.display()
        ));
    }
    if !target.is_file() {
        return Err(format!("AppImage does not exist: {}", target.display()));
    }
    target
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| format!("AppImage parent is unavailable: {}", target.display()))?;
    Ok(target)
}

#[cfg(target_os = "linux")]
fn spawn_appimage(path: &Path, first_boot: bool) -> Result<(), String> {
    let mut command = std::process::Command::new(path);
    for key in [
        "APPDIR",
        "APPIMAGE",
        "ARGV0",
        "LD_LIBRARY_PATH",
        APPLY_TARGET_ENV,
        APPLY_PARENT_ENV,
        FIRST_BOOT_ENV,
    ] {
        command.env_remove(key);
    }
    if first_boot {
        command.env(FIRST_BOOT_ENV, "1");
    }
    command
        .stdin(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("launch {}: {e}", path.display()))
}

#[cfg(target_os = "linux")]
fn atomic_swap(stage: &Path, target: &Path, backup: &Path) -> Result<(), String> {
    if backup.exists() {
        return Err(format!(
            "rollback copy already exists at {}; launch the current app once or recover it before updating again",
            backup.display()
        ));
    }
    std::fs::rename(target, backup)
        .map_err(|e| format!("preserve current AppImage as {}: {e}", backup.display()))?;
    if let Err(error) = std::fs::rename(stage, target) {
        let restore = std::fs::rename(backup, target);
        return Err(match restore {
            Ok(()) => format!("activate downloaded AppImage: {error}; previous version restored"),
            Err(restore_error) => format!(
                "activate downloaded AppImage: {error}; restoring {} also failed: {restore_error}",
                backup.display()
            ),
        });
    }
    if let Err(error) = sync_parent(target) {
        let failed = failed_path(target);
        let _ = std::fs::rename(target, &failed);
        let restore = std::fs::rename(backup, target);
        return Err(match restore {
            Ok(()) => format!(
                "sync activated AppImage: {error}; previous version restored and failed update preserved at {}",
                failed.display()
            ),
            Err(restore_error) => format!(
                "sync activated AppImage: {error}; restoring {} also failed: {restore_error}",
                backup.display()
            ),
        });
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn rollback_incomplete_update(target: &Path) -> Result<(), String> {
    let backup = backup_path(target);
    if !backup.is_file() {
        return Err(format!(
            "update recovery marker exists but rollback copy is missing: {}",
            backup.display()
        ));
    }
    let failed = failed_path(target);
    std::fs::rename(target, &failed)
        .map_err(|e| format!("preserve failed update as {}: {e}", failed.display()))?;
    if let Err(error) = std::fs::rename(&backup, target) {
        let _ = std::fs::rename(&failed, target);
        return Err(format!(
            "restore previous AppImage from {}: {error}",
            backup.display()
        ));
    }
    let _ = std::fs::remove_file(pending_path(target));
    sync_parent(target)?;
    spawn_appimage(target, false)
}

#[cfg(target_os = "linux")]
fn wait_for_process_exit(pid: u32) -> Result<(), String> {
    let proc_path = PathBuf::from(format!("/proc/{pid}"));
    for _ in 0..600 {
        if !proc_path.exists() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err(format!(
        "old OwLLM process {pid} did not exit within 60 seconds"
    ))
}

/// Handles the downloaded-AppImage helper and rollback modes before GTK starts.
/// Returns `true` when this process must exit without starting the Tauri app.
pub fn handle_startup_mode() -> bool {
    #[cfg(target_os = "linux")]
    {
        if let Some(raw_target) = std::env::var_os(APPLY_TARGET_ENV) {
            let result = (|| {
                let target = validated_appimage_target(&raw_target)?;
                let stage =
                    validated_appimage_target(&std::env::var_os("APPIMAGE").ok_or_else(|| {
                        "update helper was not launched as an AppImage".to_string()
                    })?)?;
                if stage.parent() != target.parent() || stage == target {
                    return Err(format!(
                        "unsafe update handoff: stage {} and target {} must be distinct siblings",
                        stage.display(),
                        target.display()
                    ));
                }
                let parent = std::env::var(APPLY_PARENT_ENV)
                    .map_err(|_| "update helper parent PID is missing".to_string())?
                    .parse::<u32>()
                    .map_err(|_| "update helper parent PID is invalid".to_string())?;
                wait_for_process_exit(parent)?;
                let backup = backup_path(&target);
                atomic_swap(&stage, &target, &backup)?;
                if let Err(error) = std::fs::write(pending_path(&target), b"pending\n")
                    .map_err(|e| format!("write update recovery marker: {e}"))
                    .and_then(|_| sync_parent(&target))
                {
                    rollback_incomplete_update(&target)?;
                    return Err(error);
                }
                if let Err(error) = spawn_appimage(&target, true) {
                    rollback_incomplete_update(&target)?;
                    return Err(error);
                }
                Ok::<(), String>(())
            })();
            if let Err(error) = result {
                eprintln!("[owllm updater] {error}");
            }
            return true;
        }

        if std::env::var_os(FIRST_BOOT_ENV).is_none() {
            if let Some(raw_target) = std::env::var_os("APPIMAGE") {
                if let Ok(target) = validated_appimage_target(&raw_target) {
                    let pending = pending_path(&target);
                    if pending.is_file() {
                        // A marker alone is NOT proof the update failed. Any
                        // supervisor that relaunches OwLLM (systemd unit,
                        // session autostart, a user double-clicking during the
                        // handoff) starts the swapped-in AppImage without
                        // FIRST_BOOT_ENV seconds after the helper wrote the
                        // marker — and the old rule rolled the update back on
                        // the spot, every time. Downloaded, installed,
                        // reverted, "update available" again: the exact
                        // Linux-only loop reported on 2026-08-15.
                        //
                        // So judge by AGE, which converges either way. A fresh
                        // marker means the first boot is happening right now —
                        // possibly as THIS process — so boot normally and let
                        // `confirm_successful_boot` clean up. A new build that
                        // cannot boot keeps failing until the marker goes
                        // stale, and then the rollback still runs.
                        if pending_marker_is_stale(&pending) {
                            if let Err(error) = rollback_incomplete_update(&target) {
                                eprintln!("[owllm updater] automatic rollback failed: {error}");
                            }
                            return true;
                        }
                        eprintln!(
                            "[owllm updater] fresh update marker: adopting this launch as the first boot"
                        );
                    }
                }
            }
        }
    }
    false
}

#[cfg(target_os = "linux")]
#[derive(Clone, Serialize)]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

/// Download and verify the announced update, then launch it as a helper which
/// performs the atomic swap after this process exits.
#[tauri::command(async)]
pub async fn linux_appimage_update_install(
    app: tauri::AppHandle,
    expected_version: String,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        use tauri::Emitter;
        use tauri_plugin_updater::UpdaterExt;

        let raw_target = std::env::var_os("APPIMAGE").ok_or_else(|| {
            "This Linux install is not an AppImage; use the package download.".to_string()
        })?;
        let target = validated_appimage_target(&raw_target)?;
        let backup = backup_path(&target);
        if backup.exists() || pending_path(&target).exists() {
            return Err(format!(
                "A previous update has not been confirmed yet. Restart OwLLM once to recover or finish it before retrying."
            ));
        }

        let update = app
            .updater()
            .map_err(|e| format!("initialize updater: {e}"))?
            .check()
            .await
            .map_err(|e| format!("check updater manifest: {e}"))?
            .ok_or_else(|| "The announced update is no longer available.".to_string())?;
        if update.version != expected_version {
            return Err(format!(
                "The available update changed from {expected_version} to {}; check again.",
                update.version
            ));
        }

        let progress_app = app.clone();
        let mut downloaded = 0_u64;
        let bytes = update
            .download(
                move |chunk, total| {
                    downloaded = downloaded.saturating_add(chunk as u64);
                    let _ = progress_app.emit(
                        "owllm:update-progress",
                        UpdateProgress { downloaded, total },
                    );
                },
                || {},
            )
            .await
            .map_err(|e| format!("download or signature verification failed: {e}"))?;
        if !bytes.starts_with(b"\x7fELF") {
            return Err("The signed Linux update is not an ELF AppImage.".to_string());
        }

        let file_name = target.file_name().unwrap_or_default().to_string_lossy();
        let stage = target.with_file_name(format!(
            ".{file_name}.update-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let write_result = (|| {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&stage)
                .map_err(|e| format!("create update beside {}: {e}", target.display()))?;
            file.write_all(&bytes)
                .map_err(|e| format!("write downloaded AppImage: {e}"))?;
            file.set_permissions(std::fs::Permissions::from_mode(
                target
                    .metadata()
                    .map_err(|e| format!("read AppImage permissions: {e}"))?
                    .permissions()
                    .mode(),
            ))
            .map_err(|e| format!("set downloaded AppImage permissions: {e}"))?;
            file.sync_all()
                .map_err(|e| format!("sync downloaded AppImage: {e}"))
        })();
        if let Err(error) = write_result {
            let _ = std::fs::remove_file(&stage);
            return Err(error);
        }
        sync_parent(&stage)?;

        std::process::Command::new(&stage)
            .env(APPLY_TARGET_ENV, &target)
            .env(APPLY_PARENT_ENV, std::process::id().to_string())
            .stdin(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("start deferred AppImage updater: {e}"))?;

        let exit_app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(150));
            exit_app.exit(0);
        });
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, expected_version);
        Err("The AppImage updater is available only on Linux.".to_string())
    }
}

/// Remove the rollback copy only after the new Linux WebView has loaded.
///
/// Gated on the MARKER, not on `FIRST_BOOT_ENV`: a supervisor-relaunched
/// instance adopted as the first boot (see `handle_startup_mode`) has no env
/// var, but it is running the swapped-in build and its WebView loading is
/// exactly the success the marker is waiting for. Leaving the marker there
/// would let it go stale and trigger a rollback of a perfectly healthy update.
pub fn confirm_successful_boot() {
    #[cfg(target_os = "linux")]
    {
        let Some(raw_target) = std::env::var_os("APPIMAGE") else {
            return;
        };
        let Ok(target) = validated_appimage_target(&raw_target) else {
            return;
        };
        let pending = pending_path(&target);
        if !pending.is_file() {
            return;
        }
        if let Err(error) = std::fs::remove_file(&pending) {
            eprintln!(
                "[owllm updater] could not remove recovery marker {}: {error}",
                pending.display()
            );
            return;
        }
        let _ = sync_parent(&target);
        let backup = backup_path(&target);
        if let Err(error) = std::fs::remove_file(&backup) {
            eprintln!(
                "[owllm updater] could not remove confirmed rollback copy {}: {error}",
                backup.display()
            );
        }
        let _ = sync_parent(&target);
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("owllm-linux-updater-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The Linux update-revert loop of 2026-08-15: a supervisor (systemd unit,
    /// session autostart) relaunches the app seconds after the helper swaps the
    /// AppImage and writes the marker. That relaunch has no FIRST_BOOT_ENV, and
    /// treating its bare existence-check as "the update failed" rolled back
    /// every single update on such machines. A fresh marker must read as "the
    /// first boot is happening now", never as failure.
    #[test]
    fn a_fresh_marker_is_not_stale() {
        let dir = fixture("fresh-marker");
        let pending = dir.join("OwLLM.AppImage.update-pending");
        std::fs::write(&pending, b"pending\n").unwrap();

        assert!(!pending_marker_is_stale(&pending));
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// The counterpart that keeps crash recovery working: a marker nobody
    /// confirmed within the grace window means the new build never managed to
    /// boot, and rollback must still happen.
    #[test]
    fn a_marker_older_than_the_grace_window_is_stale() {
        let dir = fixture("stale-marker");
        let pending = dir.join("OwLLM.AppImage.update-pending");
        let file = std::fs::File::create(&pending).unwrap();
        let old = std::time::SystemTime::now() - (PENDING_MARKER_GRACE * 2);
        file.set_times(std::fs::FileTimes::new().set_modified(old))
            .unwrap();
        drop(file);

        assert!(pending_marker_is_stale(&pending));
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A marker whose age cannot be read must fail toward rollback — that is
    /// the pre-grace behaviour, and restoring a known-good build is the safe
    /// direction to be wrong in.
    #[test]
    fn an_unreadable_marker_counts_as_stale() {
        let dir = fixture("gone-marker");
        let pending = dir.join("OwLLM.AppImage.update-pending");
        // Never created: metadata() fails.
        assert!(pending_marker_is_stale(&pending));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn atomic_swap_preserves_previous_appimage() {
        let dir = fixture("swap");
        let target = dir.join("OwLLM.AppImage");
        let stage = dir.join(".OwLLM.update");
        let backup = backup_path(&target);
        std::fs::write(&target, b"old").unwrap();
        std::fs::write(&stage, b"new").unwrap();

        atomic_swap(&stage, &target, &backup).unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"new");
        assert_eq!(std::fs::read(&backup).unwrap(), b"old");
        assert!(!stage.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn atomic_swap_refuses_to_destroy_an_unconfirmed_backup() {
        let dir = fixture("backup");
        let target = dir.join("OwLLM.AppImage");
        let stage = dir.join(".OwLLM.update");
        let backup = backup_path(&target);
        std::fs::write(&target, b"old").unwrap();
        std::fs::write(&stage, b"new").unwrap();
        std::fs::write(&backup, b"recoverable").unwrap();

        let error = atomic_swap(&stage, &target, &backup).unwrap_err();

        assert!(error.contains("rollback copy already exists"));
        assert_eq!(std::fs::read(&target).unwrap(), b"old");
        assert_eq!(std::fs::read(&backup).unwrap(), b"recoverable");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
