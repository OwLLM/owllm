//! Did the last session end, or did it die?
//!
//! Every other diagnostic in this app runs *inside* the process, so every one
//! of them shares a blind spot: a SIGKILL, an OOM kill, a hard GPU hang or a
//! power cut leaves no panic, no exit-path breadcrumb, no log line at all. The
//! August 2026 "OwLLM keeps crashing on Linux" reports were undiagnosable for
//! exactly this reason — absence of evidence looked identical to absence of a
//! crash, and it took an out-of-process record (the system's own crash logger)
//! to tell the two apart. Users do not have that.
//!
//! So leave a mark on disk instead. Each running process writes a marker on
//! startup and removes it on the way out through `RunEvent::Exit`. A marker
//! still present when nothing owns it means that session never reached its exit
//! path — the one fact no in-process logging can establish about its own death.
//!
//! Two properties this has to get right, because both would turn the feature
//! into a liar:
//!
//! * **Multi-instance.** OwLLM runs several windows as separate processes (see
//!   the window registry in `server`), so one shared marker would have every
//!   instance reporting every other instance's exit. Markers are per-process.
//! * **PID reuse.** A recycled pid would make a dead session look alive and
//!   silently swallow the report. A marker is matched on pid *and* the
//!   process's own start time, so a different process wearing the same number
//!   is never mistaken for the one that wrote it.

use serde::{Deserialize, Serialize};

/// How many unclean-shutdown records to keep. Enough that a user who only
/// opens the app occasionally still has the history when they finally report
/// it; bounded so a crash loop cannot grow the file without limit.
const MAX_REPORTS: usize = 20;

/// One session's marker: who wrote it, and the identity needed to decide later
/// whether that process is still alive.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMarker {
    pub pid: u32,
    /// The process's own start time, as the OS reports it. Pairs with `pid` to
    /// form an identity a recycled pid cannot forge.
    pub process_started: u64,
    /// When the machine booted. Markers from an earlier boot belong to
    /// processes that are gone by definition — which is what makes a power cut
    /// or hard reset detectable at all.
    pub boot_time: u64,
    /// Wall-clock start, for the human reading the report.
    pub started_unix: u64,
    pub version: String,
    pub os: String,
}

/// A session that never reached its exit path, as reported to the user.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UncleanShutdown {
    pub marker: SessionMarker,
    /// When we noticed — i.e. the startup after the death.
    pub detected_unix: u64,
    /// Why we concluded it died, in words the user can read.
    pub reason: String,
}

fn sessions_dir() -> Option<std::path::PathBuf> {
    Some(crate::paths::owllm_config_home()?.join("sessions"))
}

fn reports_path() -> Option<std::path::PathBuf> {
    Some(crate::paths::owllm_config_home()?.join("unclean_shutdowns.json"))
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// This process's `(boot_time, start_time)` as the OS reports them.
fn own_identity() -> (u64, u64) {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let boot = System::boot_time();
    let me = Pid::from_u32(std::process::id());
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[me]),
        true,
        ProcessRefreshKind::new(),
    );
    let started = sys.process(me).map(|p| p.start_time()).unwrap_or(0);
    (boot, started)
}

fn marker_path(pid: u32) -> Option<std::path::PathBuf> {
    Some(sessions_dir()?.join(format!("{pid}.json")))
}

/// Record that this process is running, and harvest any marker left behind by
/// a session that died. Call once, early in startup.
///
/// Returns the number of unclean shutdowns newly detected (for logging; the
/// records themselves go to disk for the UI to collect).
pub fn begin(version: &str) -> usize {
    let Some(dir) = sessions_dir() else {
        return 0;
    };
    let _ = std::fs::create_dir_all(&dir);
    let found = harvest(&dir);
    if !found.is_empty() {
        append_reports(&found);
    }
    let (boot_time, process_started) = own_identity();
    let marker = SessionMarker {
        pid: std::process::id(),
        process_started,
        boot_time,
        started_unix: now_unix(),
        version: version.to_string(),
        os: std::env::consts::OS.to_string(),
    };
    write_marker(&marker);
    let _ = OWN_MARKER.set(marker);
    NEW_THIS_LAUNCH.store(found.len(), std::sync::atomic::Ordering::SeqCst);
    found.len()
}

fn write_marker(marker: &SessionMarker) {
    if let (Some(path), Ok(json)) = (marker_path(marker.pid), serde_json::to_string(marker)) {
        let _ = std::fs::write(path, json);
    }
}

/// This session's own marker, kept so an expected replacement that never
/// happened can put it back — see [`expect_replacement`].
static OWN_MARKER: std::sync::OnceLock<SessionMarker> = std::sync::OnceLock::new();

/// Deaths discovered by *this* launch, as opposed to the stored history.
///
/// The notice is driven by this rather than by the report list, because the
/// two must not share a fate: telling the user once is a UI concern, while the
/// records themselves have to survive so a support report filed days later
/// still carries them. Clearing the notice by deleting the evidence would
/// throw away the only thing that makes the report worth sending.
static NEW_THIS_LAUNCH: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Remove this process's marker — the session ended the way it should.
pub fn end_clean() {
    if let Some(path) = marker_path(std::process::id()) {
        let _ = std::fs::remove_file(path);
    }
}

/// An installer is about to end this process from outside the exit path, so
/// drop the marker now: this death is intentional, not a crash.
///
/// Needed because `RunEvent::Exit` — the only place [`end_clean`] otherwise
/// runs — never fires here. On Windows the updater hands the NSIS installer to
/// the shell and leaves through `std::process::exit(0)`
/// (`tauri-plugin-updater`'s `install`), and the installer terminates
/// `owllm-desktop.exe` besides. Either way the event loop is gone before it can
/// emit anything, so without this every auto-update makes the freshly installed
/// build greet the user by accusing the previous one of crashing.
pub fn expect_replacement() {
    end_clean();
}

/// The replacement did not happen — put the marker back.
///
/// A failed install leaves the app running, and an unmarked session is a
/// session whose death nothing can report. Pairs with [`expect_replacement`] on
/// every path that can return instead of exiting.
pub fn rearm() {
    if let Some(marker) = OWN_MARKER.get() {
        write_marker(marker);
    }
}

/// Read every marker in `dir`, keep the ones whose owner is gone, and delete
/// the markers we consumed so a death is reported once and not on every launch
/// thereafter.
fn harvest(dir: &std::path::Path) -> Vec<UncleanShutdown> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let (boot_time, _) = own_identity();
    let mut live = LiveProcesses::snapshot();
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(marker) = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<SessionMarker>(&raw).ok())
        else {
            // An unreadable marker is still evidence something was running and
            // never cleaned up after itself; drop it rather than re-reading a
            // corrupt file forever.
            let _ = std::fs::remove_file(&path);
            continue;
        };
        if marker.pid == std::process::id() {
            continue;
        }
        let Some(reason) = death_reason(&marker, boot_time, &mut live) else {
            // Owner is alive: another OwLLM instance. Leave its marker alone.
            continue;
        };
        out.push(UncleanShutdown {
            marker,
            detected_unix: now_unix(),
            reason,
        });
        let _ = std::fs::remove_file(&path);
    }
    out
}

/// Why this marker's owner is gone — or `None` if it is still running.
fn death_reason(marker: &SessionMarker, boot_time: u64, live: &mut LiveProcesses) -> Option<String> {
    // Boot times differ by a second or two between readings on some platforms,
    // so compare with slack rather than for equality — an exact test would
    // report every previous session as a reboot.
    if marker.boot_time.abs_diff(boot_time) > 5 {
        return Some(
            "the machine restarted before that session closed — a power loss, a hard reset, or a \
             shutdown that did not let OwLLM finish"
                .to_string(),
        );
    }
    match live.start_time(marker.pid) {
        Some(started) if started == marker.process_started => None,
        Some(_) => Some(
            "that session's process is gone (its process id now belongs to something else) and it \
             never ran its shutdown"
                .to_string(),
        ),
        None => Some(
            "that session's process disappeared without running its shutdown — killed outright, \
             out of memory, or a crash the app could not log"
                .to_string(),
        ),
    }
}

/// One process-table read, reused across every marker in a harvest.
struct LiveProcesses(std::collections::HashMap<u32, u64>);

impl LiveProcesses {
    fn snapshot() -> Self {
        use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
        let mut sys = System::new();
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::new(),
        );
        Self(
            sys.processes()
                .iter()
                .map(|(pid, p)| (pid.as_u32(), p.start_time()))
                .collect(),
        )
    }
    fn start_time(&mut self, pid: u32) -> Option<u64> {
        self.0.get(&pid).copied()
    }
}

fn load_reports() -> Vec<UncleanShutdown> {
    reports_path()
        .filter(|p| p.is_file())
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_reports(reports: &[UncleanShutdown]) {
    let Some(path) = reports_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(reports) {
        let _ = std::fs::write(path, json);
    }
}

fn append_reports(found: &[UncleanShutdown]) {
    let mut reports = load_reports();
    reports.extend_from_slice(found);
    let overflow = reports.len().saturating_sub(MAX_REPORTS);
    reports.drain(..overflow);
    save_reports(&reports);
}

/// Unclean shutdowns waiting to be shown to the user, oldest first.
pub fn pending() -> Vec<UncleanShutdown> {
    load_reports()
}

/// The user has seen them; stop offering.
pub fn dismiss() {
    save_reports(&[]);
}

/// The tail of the crash log, which is where the exit-path breadcrumbs and any
/// panic backtrace land. Bounded: a support report must stay sendable, and the
/// end of the file is the part that describes the death being reported.
pub fn crash_log_tail(max_bytes: usize) -> String {
    for base in [
        std::env::var_os("TEMP"),
        std::env::var_os("USERPROFILE"),
        std::env::var_os("HOME"),
        Some(std::ffi::OsString::from("/tmp")),
    ]
    .into_iter()
    .flatten()
    {
        let path = std::path::PathBuf::from(base).join("owllm-crash.log");
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        // Cut on a char boundary — the log carries user-visible panic messages
        // and a naive byte slice would panic on multi-byte text.
        let start = text.len().saturating_sub(max_bytes);
        let start = (start..=text.len())
            .find(|i| text.is_char_boundary(*i))
            .unwrap_or(text.len());
        return text[start..].to_string();
    }
    String::new()
}

/// What the UI needs to decide whether to say anything.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHealth {
    /// Deaths this launch discovered. Non-zero means "tell the user now".
    pub new_this_launch: usize,
    /// The stored history, newest last. Always returned, notice or not.
    pub reports: Vec<UncleanShutdown>,
}

/// Sessions that died, for the user to see and send.
#[tauri::command]
pub fn session_health_pending() -> SessionHealth {
    SessionHealth {
        new_this_launch: NEW_THIS_LAUNCH.load(std::sync::atomic::Ordering::SeqCst),
        reports: pending(),
    }
}

/// The updater is about to hand this process to an installer.
#[tauri::command]
pub fn session_health_expect_replacement() {
    expect_replacement();
}

/// The install returned instead of replacing us.
#[tauri::command]
pub fn session_health_rearm() {
    rearm();
}

/// Forget the stored history. Only ever on an explicit user action — never as
/// a side effect of showing the notice.
#[tauri::command]
pub fn session_health_dismiss() {
    NEW_THIS_LAUNCH.store(0, std::sync::atomic::Ordering::SeqCst);
    dismiss();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marker(pid: u32, process_started: u64, boot_time: u64) -> SessionMarker {
        SessionMarker {
            pid,
            process_started,
            boot_time,
            started_unix: 1_700_000_000,
            version: "1.0.13".into(),
            os: "linux".into(),
        }
    }

    fn live_with(entries: &[(u32, u64)]) -> LiveProcesses {
        LiveProcesses(entries.iter().copied().collect())
    }

    /// The whole point: a process that is gone is reported.
    #[test]
    fn a_vanished_process_is_reported() {
        let mut live = live_with(&[]);
        let reason = death_reason(&marker(42, 100, 900), 900, &mut live);
        assert!(reason.is_some_and(|r| r.contains("disappeared")));
    }

    /// …and a second OwLLM window, which is alive, is NOT — otherwise every
    /// multi-window user would be told their app crashed every launch.
    #[test]
    fn a_live_sibling_instance_is_not_reported() {
        let mut live = live_with(&[(42, 100)]);
        assert!(death_reason(&marker(42, 100, 900), 900, &mut live).is_none());
    }

    /// A recycled pid must not launder a dead session into a live one: same
    /// number, different process, so the death still gets reported.
    #[test]
    fn a_recycled_pid_does_not_hide_a_death() {
        let mut live = live_with(&[(42, 555)]);
        let reason = death_reason(&marker(42, 100, 900), 900, &mut live);
        assert!(reason.is_some_and(|r| r.contains("belongs to something else")));
    }

    /// A marker from before the current boot means the machine went down under
    /// the app — the case no in-process logging can ever record.
    #[test]
    fn a_marker_from_a_previous_boot_reads_as_a_restart() {
        // Pid is "alive" now, but from a different boot: the boot check must
        // win, or a post-reboot pid collision would report the wrong cause.
        let mut live = live_with(&[(42, 100)]);
        let reason = death_reason(&marker(42, 100, 500), 900, &mut live);
        assert!(reason.is_some_and(|r| r.contains("restarted")));
    }

    /// Clock jitter between two boot-time readings must not masquerade as a
    /// reboot on every single launch.
    #[test]
    fn boot_time_jitter_is_not_a_reboot() {
        let mut live = live_with(&[(42, 100)]);
        assert!(death_reason(&marker(42, 100, 898), 900, &mut live).is_none());
    }

    /// A crash loop must not grow the report file without bound, and must keep
    /// the NEWEST records rather than the first twenty.
    #[test]
    fn reports_are_capped_keeping_the_most_recent() {
        let mut reports: Vec<UncleanShutdown> = (0..MAX_REPORTS + 5)
            .map(|i| UncleanShutdown {
                marker: marker(i as u32, 1, 1),
                detected_unix: i as u64,
                reason: "test".into(),
            })
            .collect();
        let overflow = reports.len().saturating_sub(MAX_REPORTS);
        reports.drain(..overflow);
        assert_eq!(reports.len(), MAX_REPORTS);
        assert_eq!(reports[0].detected_unix, 5);
    }
}
