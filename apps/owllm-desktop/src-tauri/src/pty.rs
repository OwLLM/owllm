// PTY module — spawns a CLI inside a pseudo-terminal so the React
// side can render its TUI (cursor, colors, alternate screen buffer)
// inside an xterm.js terminal in the right rail. Replaces the
// pop-out CMD window we used for subscription CLI login.
//
// Lifecycle:
//   * React calls `pty_spawn { cli, args, cwd, on_event }` and gets
//     a session_id (uuid v4 string).
//   * Rust spawns the CLI through ConPTY (Win) / forkpty (Unix),
//     streams every chunk of the master pty read end back over the
//     Channel as PtyEvent::Data { data: Vec<u8> }.
//   * React's xterm.write() consumes those bytes verbatim.
//   * React calls `pty_write { session_id, data }` for every
//     keystroke; we forward the bytes to the master writer.
//   * `pty_resize { cols, rows }` whenever the xterm container
//     resizes — keeps the CLI's drawing aware of the viewport.
//   * `pty_kill { session_id }` on unmount; we also auto-emit
//     PtyEvent::Exit when the child exits.
//
// Concurrency: one session = one std::thread reader pumping the pty
// master into the Channel. SESSIONS map is a Mutex<HashMap<id, Slot>>
// so multiple concurrent terminals (Connect on two providers at once)
// don't collide.

use once_cell::sync::Lazy;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::ipc::Channel;

/// One PTY event the React xterm.js side consumes.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PtyEvent {
    /// Raw bytes from the pty master. Includes ANSI escape sequences,
    /// cursor moves, alt-screen toggles — xterm.write() handles them.
    /// Sent as Vec<u8> so binary-safe (some CLIs emit non-UTF-8).
    Data { data: Vec<u8> },
    /// Child process exited. `code` is None for signal kills.
    Exit { code: Option<i32> },
}

/// One live PTY session. The master is held so we can resize / write;
/// `writer` is a separately-cloned writer because portable-pty's
/// MasterPty hands out a Box<dyn Write> we can't share otherwise.
struct Slot {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
}

static SESSIONS: Lazy<Mutex<HashMap<String, Slot>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Spawn `cli` with `args` inside a fresh PTY. Returns the session
/// id the React side passes back to pty_write / pty_resize / pty_kill.
#[tauri::command]
pub fn pty_spawn(
    cli: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    on_event: Channel<PtyEvent>,
) -> Result<String, String> {
    let cols = cols.unwrap_or(100);
    let rows = rows.unwrap_or(28);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty: {e}"))?;

    let mut cmd = CommandBuilder::new(&cli);
    for a in &args {
        cmd.arg(a);
    }
    if let Some(c) = cwd.as_ref().filter(|s| !s.trim().is_empty()) {
        cmd.cwd(c);
    } else {
        // Default to user's home; some CLIs assume a writable cwd.
        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            cmd.cwd(home);
        }
    }
    // Make sure the child inherits the same PATH we already extended
    // in accounts::which_extended — so kimi.exe lives where the CLI
    // expects when invoked under the PTY shell.
    if let Some(path) = std::env::var_os("PATH") {
        cmd.env("PATH", path);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn {cli}: {e}"))?;
    // We don't need the slave end here; dropping it closes the
    // child-side fd so EOF on the master end propagates correctly
    // when the child exits.
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer: {e}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader: {e}"))?;

    let session_id = uuid::Uuid::new_v4().to_string();
    let event_for_data = on_event.clone();

    // Reader thread: pump pty output into the Channel.
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — child closed
                Ok(n) => {
                    if event_for_data
                        .send(PtyEvent::Data { data: buf[..n].to_vec() })
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        // Wait for the child to report an exit code, then notify React.
        let code = match child.wait() {
            Ok(status) => status.exit_code() as i32,
            Err(_) => -1,
        };
        let _ = event_for_data.send(PtyEvent::Exit { code: Some(code) });
    });

    SESSIONS
        .lock()
        .unwrap()
        .insert(session_id.clone(), Slot { writer, master: pair.master });
    Ok(session_id)
}

/// Forward keystrokes from the React xterm.js side to the PTY's
/// stdin. `data` is a byte array (xterm's onData gives a string; the
/// React side encodes it via TextEncoder).
#[tauri::command]
pub fn pty_write(session_id: String, data: Vec<u8>) -> Result<(), String> {
    let mut sessions = SESSIONS.lock().unwrap();
    let slot = sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("no PTY session: {session_id}"))?;
    slot.writer
        .write_all(&data)
        .map_err(|e| format!("pty_write: {e}"))?;
    slot.writer.flush().map_err(|e| format!("pty_flush: {e}"))?;
    Ok(())
}

/// Resize the PTY when xterm-fit reflows. Without this the CLI keeps
/// drawing for the old viewport and wraps lines at the wrong column.
#[tauri::command]
pub fn pty_resize(session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = SESSIONS.lock().unwrap();
    let slot = sessions
        .get(&session_id)
        .ok_or_else(|| format!("no PTY session: {session_id}"))?;
    slot.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("pty_resize: {e}"))?;
    Ok(())
}

/// Tear down the session — React calls this on unmount. The reader
/// thread also exits on its own once the master end EOFs.
#[tauri::command]
pub fn pty_kill(session_id: String) -> Result<(), String> {
    let mut sessions = SESSIONS.lock().unwrap();
    if let Some(_slot) = sessions.remove(&session_id) {
        // Dropping the master closes its read+write ends, which sends
        // SIGHUP / closes ConPTY on Windows. The child then exits.
        // We don't have a stored Child reference here (it's owned by
        // the reader thread); that's fine — the thread will see EOF,
        // wait on the child, and emit PtyEvent::Exit.
    }
    Ok(())
}
