//! Linux/AppImage lifetime guard for WebKitGTK's helper processes.
//!
//! WebKitGTK runs every page in its own `WebKitWebProcess` and shares one
//! `WebKitNetworkProcess`. Both are direct children of this process, and inside
//! an AppImage both mmap their executable and every library straight out of the
//! SquashFS FUSE mount. That mount is served by the AppImage runtime and is
//! torn down the moment this process leaves. A helper still running at that
//! point keeps executing code whose backing store no longer exists, so its next
//! cold page fault returns EIO and the kernel raises SIGBUS — which Ubuntu
//! surfaces as "Ubuntu has experienced an internal error".
//!
//! Usually the helpers see the closed IPC socket and exit in time. One that is
//! busy (heavy page, spinning script) does not. Measured on the reference
//! Jetson: apport recorded six SIGBUS reports whose paths had already collapsed
//! to the detached-mount form (`ProcCwd: /usr`,
//! `/usr/lib/libwebkit2gtk-4.1.so.0`, helper resolved out of the *system*
//! webkit2gtk), the last of them faulting 2.5 minutes after its mount was
//! deactivated.
//!
//! So do not rely on that race — reap the helpers before we leave.

/// SIGKILL every WebKitGTK helper this process owns.
///
/// Scoped to our own direct children on purpose: a second OwLLM instance has
/// its own AppImage mount and must keep running.
#[cfg(target_os = "linux")]
pub fn reap(reason: &str) {
    use sysinfo::{Pid, ProcessesToUpdate, System};

    let me = Pid::from_u32(std::process::id());
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let mut killed = 0usize;
    for process in sys.processes().values() {
        if process.parent() != Some(me) {
            continue;
        }
        if !is_webkit_helper(process) {
            continue;
        }
        // SIGKILL, not SIGTERM: helpers hold no state the UI process has not
        // already persisted, and a helper wedged badly enough to outlive the
        // IPC teardown is exactly the one that would ignore a polite signal.
        if process.kill() {
            killed += 1;
        }
    }
    if killed > 0 {
        eprintln!(
            "[owllm] {reason}: reaped {killed} WebKit helper process(es) before the AppImage mount is torn down"
        );
    }
}

/// `/proc/<pid>/stat` truncates `comm` to 15 bytes, so `WebKitWebProcess`
/// arrives as `WebKitWebProces`. Match on the prefix, and prefer the
/// executable's own file name where it is readable.
#[cfg(target_os = "linux")]
fn is_webkit_helper(process: &sysinfo::Process) -> bool {
    let named_webkit = process
        .exe()
        .and_then(|path| path.file_name())
        .map(|name| name.to_string_lossy().starts_with("WebKit"))
        .unwrap_or(false);
    named_webkit || process.name().to_string_lossy().starts_with("WebKit")
}

/// Route SIGHUP/SIGINT/SIGTERM through a normal Tauri shutdown so [`reap`]
/// runs on `RunEvent::Exit` instead of the kernel dropping us where we stand.
///
/// Without this a session logout or `systemctl --user stop` kills us outright
/// and leaves precisely the orphans described above. Registered on the GTK main
/// loop, so the handler body runs on the main thread like any other source.
/// SIGKILL remains unrecoverable by definition — nothing in-process can cover
/// it.
#[cfg(target_os = "linux")]
pub fn install_shutdown_signals(app: &tauri::AppHandle) {
    use gtk::glib;

    // POSIX fixes these numbers on every Linux ABI.
    const SIGHUP: i32 = 1;
    const SIGINT: i32 = 2;
    const SIGTERM: i32 = 15;

    for signum in [SIGHUP, SIGINT, SIGTERM] {
        let app = app.clone();
        glib::unix_signal_add_local(signum, move || {
            eprintln!("[owllm] signal {signum}: shutting down through the normal exit path");
            app.exit(0);
            glib::ControlFlow::Break
        });
    }
}

#[cfg(not(target_os = "linux"))]
pub fn reap(_reason: &str) {}

#[cfg(not(target_os = "linux"))]
pub fn install_shutdown_signals(_app: &tauri::AppHandle) {}
