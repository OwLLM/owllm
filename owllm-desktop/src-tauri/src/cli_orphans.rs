//! Background-work continuity for agent CLI turns.
//!
//! A Code-page turn is a one-shot CLI process (claude/codex/kimi/gemini/…).
//! When the agent starts a long background job (a build, a test matrix, a
//! deploy) and then ends its turn, the CLI exits and the job keeps running with
//! nobody left to receive its result — the turn's promise ("I'll commit when
//! the matrix finishes") silently dies. This module is the missing listener:
//!
//! 1. While any registered CLI child runs, a single sampler thread records its
//!    live descendant processes (sysinfo — Windows/macOS/Linux alike). The
//!    tree must be sampled BEFORE the CLI exits: on Unix, orphans reparent to
//!    init the moment the parent dies, so a post-exit walk finds nothing.
//! 2. When the CLI exits NATURALLY (not Stop, not timeout — those tree-kill),
//!    recorded descendants still alive are adopted under the turn's cancel
//!    scope (= the workspace for Code-page turns).
//! 3. Adopted orphans that survive a grace period are announced
//!    (`cli-orphans-detected`); when the last announced orphan of a scope
//!    exits, `cli-orphans-finished` fires and the UI auto-resumes the session
//!    with the result — the turn finishes itself instead of waiting for the
//!    user to notice.
//!
//! Exit codes are NOT reported: an adopted orphan is not our child, and no OS
//! hands a non-parent the exit status portably. The continuation prompt
//! therefore instructs the agent to verify the real result from the process's
//! own output/logs — never to assume success.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How often the sampler walks the process table while work is tracked.
const SAMPLE_INTERVAL: Duration = Duration::from_secs(2);
/// An adopted orphan that exits within this window is a straggler (an MCP
/// server draining, a shell wrapper closing) — dropped silently, no events.
const ANNOUNCE_GRACE: Duration = Duration::from_secs(15);
/// An announced orphan still alive after this long is reported as
/// `stillRunning` and dropped from the watch — a daemon the agent started on
/// purpose must not arm a continuation forever.
const WATCH_CEILING: Duration = Duration::from_secs(2 * 60 * 60);

/// One process the agent left behind. `start_time` (secs since epoch, from the
/// OS process table) guards every aliveness check against PID reuse.
#[derive(Clone)]
struct OrphanProc {
    pid: u32,
    start_time: u64,
    name: String,
    cmdline: String,
}

/// Wire shape for events + commands. camelCase on purpose — and pinned by the
/// release gate together with the UI's reads, because a serde rename the UI
/// doesn't follow is exactly how the WSL host-fallback stayed dead for two
/// releases.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanWire {
    pub pid: u32,
    pub name: String,
    pub cmdline: String,
    pub ran_secs: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanGroup {
    pub scope: String,
    pub orphans: Vec<OrphanWire>,
    pub still_running: bool,
}

/// A descendant adopted at natural CLI exit, being watched to completion.
struct Adopted {
    scope: String,
    proc_: OrphanProc,
    adopted_at: Instant,
    announced: bool,
}

/// Descendants recorded per live CLI root, refreshed every sample.
fn tracked() -> &'static Mutex<HashMap<u32, HashMap<u32, OrphanProc>>> {
    static S: OnceLock<Mutex<HashMap<u32, HashMap<u32, OrphanProc>>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

fn adopted() -> &'static Mutex<Vec<Adopted>> {
    static S: OnceLock<Mutex<Vec<Adopted>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Vec::new()))
}

/// Finished groups the UI has not acknowledged yet — survives a webview
/// reload (the event listener dies with the page; this buffer does not).
fn finished_buffer() -> &'static Mutex<Vec<OrphanGroup>> {
    static S: OnceLock<Mutex<Vec<OrphanGroup>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Vec::new()))
}

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Called once from lib.rs setup so the sampler can emit events.
pub fn init(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
}

/// Start tracking a freshly spawned CLI child's descendants.
/// Called from `register_cli_child_scoped` — i.e. every CLI on every OS.
pub(crate) fn track(root_pid: u32) {
    if let Ok(mut t) = tracked().lock() {
        t.insert(root_pid, HashMap::new());
    }
    ensure_sampler();
}

/// The CLI exited on its own: adopt its surviving descendants under `scope`.
/// Unscoped children (no run, no cwd — stateless probes) have no UI surface
/// that could ever consume a continuation, so their record is just dropped.
pub(crate) fn adopt(root_pid: u32, scope: Option<&str>) {
    let candidates = tracked()
        .lock()
        .ok()
        .and_then(|mut t| t.remove(&root_pid))
        .unwrap_or_default();
    let Some(scope) = scope.map(str::trim).filter(|s| !s.is_empty()) else {
        return;
    };
    if candidates.is_empty() {
        return;
    }
    let now = Instant::now();
    if let Ok(mut a) = adopted().lock() {
        for (_, proc_) in candidates {
            a.push(Adopted {
                scope: scope.to_string(),
                proc_,
                adopted_at: now,
                announced: false,
            });
        }
    }
}

/// The CLI was killed (Stop / timeout): its tree was terminated with it, so
/// nothing is adopted and the record is discarded.
pub(crate) fn forget(root_pid: u32) {
    if let Ok(mut t) = tracked().lock() {
        t.remove(&root_pid);
    }
}

/// What the sampler should do with one adopted orphan this pass.
/// Pure — this is the state machine the release gate executes directly.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum OrphanPhase {
    /// Died before the grace elapsed — a straggler, drop with no events.
    DropSilently,
    /// Survived grace — announce it and keep watching.
    Announce,
    /// Announced and still alive — nothing to do yet.
    KeepWatching,
    /// Announced and now gone — its group may be complete.
    Finished,
    /// Announced and alive past the ceiling — report as still running, stop watching.
    CeilingHit,
}

pub(crate) fn orphan_phase(announced: bool, alive: bool, age: Duration) -> OrphanPhase {
    match (announced, alive) {
        (false, false) => OrphanPhase::DropSilently,
        (false, true) => {
            if age >= ANNOUNCE_GRACE {
                OrphanPhase::Announce
            } else {
                OrphanPhase::KeepWatching
            }
        }
        (true, true) => {
            if age >= WATCH_CEILING {
                OrphanPhase::CeilingHit
            } else {
                OrphanPhase::KeepWatching
            }
        }
        (true, false) => OrphanPhase::Finished,
    }
}

fn ensure_sampler() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        std::thread::Builder::new()
            .name("cli-orphan-sampler".into())
            .spawn(sampler_loop)
            .map(|_| ())
            .unwrap_or(())
    });
}

fn sampler_loop() {
    use sysinfo::{ProcessesToUpdate, System};
    let mut sys = System::new();
    loop {
        std::thread::sleep(SAMPLE_INTERVAL);
        let roots_live = tracked().lock().map(|t| !t.is_empty()).unwrap_or(false);
        let watching = adopted().lock().map(|a| !a.is_empty()).unwrap_or(false);
        if !roots_live && !watching {
            continue;
        }
        sys.refresh_processes(ProcessesToUpdate::All, true);
        if roots_live {
            sample_descendants(&sys);
        }
        if watching {
            advance_adopted(&sys);
        }
    }
}

/// Record every live descendant of every tracked root. Children are merged in
/// (a process seen once stays recorded even if a later sample misses it — its
/// aliveness is re-proven at adoption time anyway), so a short sampling gap
/// can't lose a long-running grandchild.
fn sample_descendants(sys: &sysinfo::System) {
    // parent pid -> child pids, one pass over the table.
    let mut children_of: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, proc_) in sys.processes() {
        if let Some(parent) = proc_.parent() {
            children_of
                .entry(parent.as_u32())
                .or_default()
                .push(pid.as_u32());
        }
    }
    let Ok(mut t) = tracked().lock() else { return };
    for (root, seen) in t.iter_mut() {
        let mut queue: Vec<u32> = children_of.get(root).cloned().unwrap_or_default();
        while let Some(pid) = queue.pop() {
            if let Some(kids) = children_of.get(&pid) {
                queue.extend(kids.iter().copied());
            }
            if seen.contains_key(&pid) {
                continue;
            }
            let Some(p) = sys.process(sysinfo::Pid::from_u32(pid)) else {
                continue;
            };
            let cmdline = p
                .cmd()
                .iter()
                .map(|s| s.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ");
            let mut cmdline = if cmdline.trim().is_empty() {
                p.name().to_string_lossy().into_owned()
            } else {
                cmdline
            };
            cmdline.truncate(300);
            seen.insert(
                pid,
                OrphanProc {
                    pid,
                    start_time: p.start_time(),
                    name: p.name().to_string_lossy().into_owned(),
                    cmdline,
                },
            );
        }
    }
}

/// Run the per-orphan state machine, then emit per-scope events for whatever
/// changed this pass.
fn advance_adopted(sys: &sysinfo::System) {
    let mut announce_now: HashMap<String, Vec<OrphanWire>> = HashMap::new();
    let mut finished_groups: Vec<OrphanGroup> = Vec::new();
    {
        let Ok(mut a) = adopted().lock() else { return };
        let mut newly_finished: HashMap<String, Vec<OrphanWire>> = HashMap::new();
        let mut ceiling: HashMap<String, Vec<OrphanWire>> = HashMap::new();
        a.retain_mut(|entry| {
            let alive = sys
                .process(sysinfo::Pid::from_u32(entry.proc_.pid))
                .map(|p| p.start_time() == entry.proc_.start_time)
                .unwrap_or(false);
            let age = entry.adopted_at.elapsed();
            match orphan_phase(entry.announced, alive, age) {
                OrphanPhase::DropSilently => false,
                OrphanPhase::Announce => {
                    entry.announced = true;
                    announce_now
                        .entry(entry.scope.clone())
                        .or_default()
                        .push(wire(&entry.proc_, age));
                    true
                }
                OrphanPhase::KeepWatching => true,
                OrphanPhase::Finished => {
                    newly_finished
                        .entry(entry.scope.clone())
                        .or_default()
                        .push(wire(&entry.proc_, age));
                    false
                }
                OrphanPhase::CeilingHit => {
                    ceiling
                        .entry(entry.scope.clone())
                        .or_default()
                        .push(wire(&entry.proc_, age));
                    false
                }
            }
        });
        // A scope's continuation fires only when its LAST watched orphan is
        // gone — partial completion keeps waiting so one turn gets one
        // continuation, not a burst.
        for (scope, orphans) in newly_finished {
            let scope_still_watched = a.iter().any(|e| e.scope == scope);
            if scope_still_watched {
                // Put the finished ones back until the rest of the scope ends.
                for o in orphans {
                    a.push(Adopted {
                        scope: scope.clone(),
                        proc_: OrphanProc {
                            pid: o.pid,
                            start_time: 0,
                            name: o.name,
                            cmdline: o.cmdline,
                        },
                        adopted_at: Instant::now() - Duration::from_secs(o.ran_secs),
                        announced: true,
                    });
                }
            } else {
                finished_groups.push(OrphanGroup {
                    scope,
                    orphans,
                    still_running: false,
                });
            }
        }
        for (scope, orphans) in ceiling {
            finished_groups.push(OrphanGroup {
                scope,
                orphans,
                still_running: true,
            });
        }
    }
    for (scope, orphans) in announce_now {
        emit(
            "cli-orphans-detected",
            &OrphanGroup {
                scope,
                orphans,
                still_running: false,
            },
        );
    }
    for group in finished_groups {
        if let Ok(mut buf) = finished_buffer().lock() {
            buf.push(group.clone());
            // Bounded: the UI acks after consuming; a UI that never acks
            // (headless run) must not grow this forever.
            let excess = buf.len().saturating_sub(32);
            if excess > 0 {
                buf.drain(..excess);
            }
        }
        emit("cli-orphans-finished", &group);
    }
}

fn wire(p: &OrphanProc, age: Duration) -> OrphanWire {
    OrphanWire {
        pid: p.pid,
        name: p.name.clone(),
        cmdline: p.cmdline.clone(),
        ran_secs: age.as_secs(),
    }
}

fn emit<S: Serialize + Clone>(event: &str, payload: &S) {
    use tauri::Emitter;
    if let Some(app) = APP.get() {
        let _ = app.emit(event, payload.clone());
    }
}

/// Snapshot for the UI's module init after a webview (re)load: announced
/// orphans still being watched, plus finished groups nobody consumed yet.
#[tauri::command]
pub fn cli_orphans_snapshot() -> Result<serde_json::Value, String> {
    let mut live: HashMap<String, Vec<OrphanWire>> = HashMap::new();
    if let Ok(a) = adopted().lock() {
        for e in a.iter().filter(|e| e.announced) {
            live.entry(e.scope.clone())
                .or_default()
                .push(wire(&e.proc_, e.adopted_at.elapsed()));
        }
    }
    let live: Vec<OrphanGroup> = live
        .into_iter()
        .map(|(scope, orphans)| OrphanGroup {
            scope,
            orphans,
            still_running: false,
        })
        .collect();
    let finished: Vec<OrphanGroup> = finished_buffer()
        .lock()
        .map(|b| b.clone())
        .unwrap_or_default();
    serde_json::to_value(serde_json::json!({ "live": live, "finished": finished }))
        .map_err(|e| e.to_string())
}

/// The UI consumed (queued or sent) the continuation for `scope` — drop its
/// finished groups so a later snapshot can't replay them.
#[tauri::command]
pub fn cli_orphans_ack(scope: String) -> Result<(), String> {
    if let Ok(mut b) = finished_buffer().lock() {
        b.retain(|g| g.scope != scope);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn straggler_dies_in_grace_silently() {
        assert_eq!(
            orphan_phase(false, false, Duration::from_secs(3)),
            OrphanPhase::DropSilently
        );
    }

    #[test]
    fn survivor_announces_only_after_grace() {
        assert_eq!(
            orphan_phase(false, true, Duration::from_secs(3)),
            OrphanPhase::KeepWatching
        );
        assert_eq!(
            orphan_phase(false, true, ANNOUNCE_GRACE),
            OrphanPhase::Announce
        );
    }

    #[test]
    fn announced_exit_finishes() {
        assert_eq!(
            orphan_phase(true, false, Duration::from_secs(600)),
            OrphanPhase::Finished
        );
    }

    #[test]
    fn ceiling_stops_the_watch() {
        assert_eq!(
            orphan_phase(true, true, WATCH_CEILING),
            OrphanPhase::CeilingHit
        );
        assert_eq!(
            orphan_phase(true, true, WATCH_CEILING - Duration::from_secs(1)),
            OrphanPhase::KeepWatching
        );
    }
}
