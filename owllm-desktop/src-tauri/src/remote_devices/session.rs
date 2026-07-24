// Interactive remote shell sessions (SSH-like). When a paired controller with
// the `shell` permission opens a session, the TARGET spawns a real PTY (same
// portable-pty engine as pty.rs) and buffers its output; the controller drives
// it with sealed SessionWrite/SessionRead round-trips over whatever transport is
// in use (LAN / overlay / relay). So installers that prompt, REPLs, `sudo`
// flows, log tails, and real dev work all work — not just one-shot commands.
//
// Security: every op runs through the same authenticate → trust → policy gate
// (session ops are the `shell` tier), and a session is bound to the controller
// that opened it — no other device can read or write it.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use once_cell::sync::Lazy;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

use super::protocol::{CommandKind, CommandRequest, CommandResult};

struct Session {
    controller_id: String,
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    buffer: Arc<Mutex<Vec<u8>>>,
    exited: Arc<AtomicBool>,
    last_active: Instant,
}

static SESSIONS: Lazy<Mutex<HashMap<String, Session>>> = Lazy::new(|| Mutex::new(HashMap::new()));
const IDLE_LIMIT_SECS: u64 = 600; // reap sessions idle > 10 min
const MAX_BUFFER: usize = 1 << 20; // cap buffered output at 1 MiB (drop oldest)

fn default_shell() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        ("cmd.exe".to_string(), Vec::new())
    }
    #[cfg(not(windows))]
    {
        let sh = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        (sh, vec!["-i".to_string()])
    }
}

fn base(req: &CommandRequest, ok: bool) -> CommandResult {
    CommandResult {
        request_id: req.request_id.clone(),
        ok,
        decision: "allowed".into(),
        ..Default::default()
    }
}

fn err(req: &CommandRequest, msg: &str) -> CommandResult {
    CommandResult {
        request_id: req.request_id.clone(),
        ok: false,
        error: Some(msg.to_string()),
        decision: "allowed".into(),
        ..Default::default()
    }
}

/// Route a session op. `controller` is the authenticated caller — it owns the
/// sessions it opens; no other device may drive them.
pub fn handle(controller: &str, req: &CommandRequest) -> CommandResult {
    reap_idle();
    let started = Instant::now();
    let mut r = match req.kind {
        CommandKind::SessionOpen => open(controller, req),
        CommandKind::SessionWrite => write(controller, req),
        CommandKind::SessionRead => read(controller, req),
        CommandKind::SessionResize => resize(controller, req),
        CommandKind::SessionClose => close(controller, req),
        _ => err(req, "not a session op"),
    };
    r.duration_ms = started.elapsed().as_millis() as u64;
    r
}

fn open(controller: &str, req: &CommandRequest) -> CommandResult {
    let cols = req.cols.unwrap_or(100);
    let rows = req.rows.unwrap_or(30);
    let (shell, args) = if req.command.trim().is_empty() {
        default_shell()
    } else {
        (req.command.trim().to_string(), Vec::new())
    };

    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(p) => p,
        Err(e) => return err(req, &format!("openpty: {e}")),
    };
    let mut cmd = CommandBuilder::new(&shell);
    for a in args {
        cmd.arg(a);
    }
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        cmd.cwd(home);
    }
    if let Some(path) = std::env::var_os("PATH") {
        cmd.env("PATH", path);
    }
    let mut child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => return err(req, &format!("spawn shell: {e}")),
    };
    drop(pair.slave);

    let writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(e) => return err(req, &format!("take_writer: {e}")),
    };
    let mut reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => return err(req, &format!("clone_reader: {e}")),
    };

    let session_id = uuid::Uuid::new_v4().to_string();
    let buffer = Arc::new(Mutex::new(Vec::new()));
    let exited = Arc::new(AtomicBool::new(false));
    let buf2 = buffer.clone();
    let exited2 = exited.clone();
    std::thread::spawn(move || {
        let mut b = [0u8; 4096];
        loop {
            match reader.read(&mut b) {
                Ok(0) => break,
                Ok(n) => {
                    let mut buf = buf2.lock().unwrap();
                    buf.extend_from_slice(&b[..n]);
                    if buf.len() > MAX_BUFFER {
                        let drop_n = buf.len() - MAX_BUFFER;
                        buf.drain(..drop_n);
                    }
                }
                Err(_) => break,
            }
        }
        let _ = child.wait();
        exited2.store(true, Ordering::SeqCst);
    });

    SESSIONS.lock().unwrap().insert(
        session_id.clone(),
        Session {
            controller_id: controller.to_string(),
            writer,
            master: pair.master,
            buffer,
            exited,
            last_active: Instant::now(),
        },
    );
    let mut r = base(req, true);
    r.session = Some(session_id);
    r
}

/// Fetch a session the caller owns (and mark it active). Fails closed on a
/// missing session or an ownership mismatch.
fn owned<'a>(
    sessions: &'a mut HashMap<String, Session>,
    controller: &str,
    id: &str,
) -> Result<&'a mut Session, String> {
    match sessions.get_mut(id) {
        Some(s) if s.controller_id == controller => {
            s.last_active = Instant::now();
            Ok(s)
        }
        Some(_) => Err("session belongs to another controller".into()),
        None => Err("no such session".into()),
    }
}

fn write(controller: &str, req: &CommandRequest) -> CommandResult {
    let Some(id) = req.session.clone() else {
        return err(req, "missing session id");
    };
    let data = match &req.payload {
        Some(b64) => {
            use base64::{engine::general_purpose::STANDARD, Engine as _};
            match STANDARD.decode(b64) {
                Ok(d) => d,
                Err(e) => return err(req, &format!("bad payload: {e}")),
            }
        }
        None => Vec::new(),
    };
    let mut sessions = SESSIONS.lock().unwrap();
    match owned(&mut sessions, controller, &id) {
        Ok(s) => match s.writer.write_all(&data).and_then(|_| s.writer.flush()) {
            Ok(()) => base(req, true),
            Err(e) => err(req, &format!("write: {e}")),
        },
        Err(e) => err(req, &e),
    }
}

fn read(controller: &str, req: &CommandRequest) -> CommandResult {
    let Some(id) = req.session.clone() else {
        return err(req, "missing session id");
    };
    let mut sessions = SESSIONS.lock().unwrap();
    match owned(&mut sessions, controller, &id) {
        Ok(s) => {
            let bytes = {
                let mut buf = s.buffer.lock().unwrap();
                std::mem::take(&mut *buf)
            };
            let exited = s.exited.load(Ordering::SeqCst);
            let mut r = base(req, true);
            if !bytes.is_empty() {
                use base64::{engine::general_purpose::STANDARD, Engine as _};
                r.data = Some(STANDARD.encode(&bytes));
            }
            r.exited = exited;
            r
        }
        Err(e) => err(req, &e),
    }
}

fn resize(controller: &str, req: &CommandRequest) -> CommandResult {
    let Some(id) = req.session.clone() else {
        return err(req, "missing session id");
    };
    let cols = req.cols.unwrap_or(100);
    let rows = req.rows.unwrap_or(30);
    let mut sessions = SESSIONS.lock().unwrap();
    match owned(&mut sessions, controller, &id) {
        Ok(s) => {
            let _ = s.master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
            base(req, true)
        }
        Err(e) => err(req, &e),
    }
}

fn close(controller: &str, req: &CommandRequest) -> CommandResult {
    let Some(id) = req.session.clone() else {
        return err(req, "missing session id");
    };
    let mut sessions = SESSIONS.lock().unwrap();
    match sessions.get(&id) {
        Some(s) if s.controller_id == controller => {
            sessions.remove(&id); // dropping the master hangs up the PTY → shell exits
            base(req, true)
        }
        Some(_) => err(req, "session belongs to another controller"),
        None => base(req, true), // already gone — idempotent
    }
}

/// Drop sessions idle past the limit (a controller that vanished leaves a shell).
fn reap_idle() {
    let mut sessions = SESSIONS.lock().unwrap();
    sessions.retain(|_, s| s.last_active.elapsed().as_secs() < IDLE_LIMIT_SECS);
}

/// Kill every live session (the emergency Stop path).
pub fn kill_all() -> usize {
    let mut sessions = SESSIONS.lock().unwrap();
    let n = sessions.len();
    sessions.clear();
    n
}
