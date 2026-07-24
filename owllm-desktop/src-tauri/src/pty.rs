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
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::ipc::Channel;

/// Resolve a bare CLI name ("kimi", "claude", …) to (exe, args) ready
/// for portable-pty's CommandBuilder. Two Windows-specific gotchas
/// the bare-spawn path falls over on:
///
///   * CreateProcessW does NOT walk PATHEXT, so `CommandBuilder::new
///     ("kimi")` fails with os error 2 even though `kimi.cmd` sits
///     happily in %APPDATA%\Python\Python312\Scripts.
///   * Batch shims (.cmd / .bat) aren't PE binaries, so even when
///     CreateProcessW finds them it returns os error 193 ("not a
///     valid Win32 application"). They MUST be launched via
///     `cmd.exe /c <full path>`.
///
/// This helper handles both: walks the same PATH+extra-dirs that
/// accounts::which_extended uses (so kimi.cmd shows up), preferring
/// .exe → .cmd → bare; if the resolved file is a batch shim, wraps
/// with cmd.exe /c. Returns (exe, args) the caller hands to CommandBuilder.
fn resolve_cli_command(name: &str, args: &[String]) -> Result<(PathBuf, Vec<String>), String> {
    // Same search order as the find_*_cli helpers in accounts.rs.
    let candidates = [
        format!("{name}.exe"),
        format!("{name}.cmd"),
        name.to_string(),
    ];
    let resolved = candidates
        .iter()
        .find_map(|n| crate::accounts::which_extended(n))
        .ok_or_else(|| format!(
            "'{name}' not found on PATH or common install dirs — install it via the Install CLI button first."
        ))?;

    let is_batch = resolved
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| {
            let e = e.to_ascii_lowercase();
            e == "cmd" || e == "bat"
        })
        .unwrap_or(false);

    if is_batch {
        // cmd.exe /c <path> <args...>. We pass the path WITHOUT extra
        // quotes here because CommandBuilder quotes args itself; the
        // PATH lookup gave us a literal absolute path with no embedded
        // quoting required (no special cmd-meta chars). If a future
        // path lands in C:\Program Files\... CommandBuilder still
        // quotes the spaces correctly because we hand it as ONE arg.
        let mut wrapped: Vec<String> =
            vec!["/c".to_string(), resolved.to_string_lossy().to_string()];
        wrapped.extend(args.iter().cloned());
        Ok((PathBuf::from("cmd.exe"), wrapped))
    } else {
        Ok((resolved, args.to_vec()))
    }
}

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
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
}

static SESSIONS: Lazy<Mutex<HashMap<String, Slot>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// PATH inherited by account-login PTYs.
///
/// Desktop launches on Linux/macOS get a deliberately small PATH, while the
/// subscription CLIs can live in OwLLM's bundled Node module, ~/.local/bin, or
/// ~/.grok/bin. `resolve_cli_command` can find the top-level shim in those
/// locations, but a Node shebang such as `#!/usr/bin/env node` performs a
/// second PATH lookup after spawn.
fn pty_child_path() -> Option<OsString> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(node_dir) = crate::paths::module_node_dir() {
        dirs.push(node_dir);
    }
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let home = PathBuf::from(home);
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".grok").join("bin"));
    }
    if let Some(existing) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&existing));
    }
    dirs.retain(|dir| dir.is_dir());
    // AppImage prepends executables from its temporary mount. Those are for
    // OwLLM itself, not external CLIs, and disappear when the app exits.
    if let Some(app_dir) = std::env::var_os("APPDIR").map(PathBuf::from) {
        dirs.retain(|dir| !dir.starts_with(&app_dir));
    }
    dirs.dedup();
    std::env::join_paths(dirs).ok()
}

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

    // Resolve `cli` to an absolute path + adjust args for batch shims.
    // Without this, npm-installed CLIs (kimi.cmd, gemini.cmd) hit os
    // error 193 because CreateProcessW can't launch .cmd files
    // directly, and pip-installed CLIs hit os error 2 because
    // CreateProcessW doesn't walk PATHEXT.
    let (exe, resolved_args) = resolve_cli_command(&cli, &args)?;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let mut cmd = CommandBuilder::new(&exe);
    for a in &resolved_args {
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
    // The resolved executable may itself be a Node/Python shim. Give that
    // second-stage interpreter lookup the same bundled/user tool directories
    // that resolve_cli_command searches.
    if let Some(path) = pty_child_path() {
        cmd.env("PATH", path);
    }
    #[cfg(target_os = "linux")]
    for key in [
        "APPDIR",
        "APPIMAGE",
        "ARGV0",
        "LD_LIBRARY_PATH",
        "PYTHONHOME",
        "PYTHONPATH",
    ] {
        // AppRun exports these for OwLLM's bundled runtime. Passing them to a
        // user's Python/native CLI makes it load modules and libraries from
        // OwLLM's temporary AppImage mount instead of its own installation.
        cmd.env_remove(key);
    }
    // The UI captures login URLs from PTY output and opens them in OwLLM's
    // persistent browser. Give Python's webbrowser module (Kimi) a real
    // successful no-op: an invalid command makes it fall through to xdg-open,
    // which can hand an HTTPS URL to LibreOffice on Linux.
    #[cfg(windows)]
    cmd.env("BROWSER", "cmd.exe /c exit 0");
    #[cfg(not(windows))]
    cmd.env("BROWSER", "/usr/bin/true");

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn {cli}: {e}"))?;
    let killer = child.clone_killer();
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
    let session_for_exit = session_id.clone();
    let event_for_data = on_event.clone();

    SESSIONS.lock().unwrap().insert(
        session_id.clone(),
        Slot {
            writer,
            master: pair.master,
            killer,
        },
    );

    // Reader thread: pump pty output into the Channel.
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — child closed
                Ok(n) => {
                    if event_for_data
                        .send(PtyEvent::Data {
                            data: buf[..n].to_vec(),
                        })
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
        SESSIONS.lock().unwrap().remove(&session_for_exit);
    });
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
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("pty_resize: {e}"))?;
    Ok(())
}

/// Tear down the session — React calls this on unmount. The reader
/// thread also exits on its own once the master end EOFs.
#[tauri::command]
pub fn pty_kill(session_id: String) -> Result<(), String> {
    let mut sessions = SESSIONS.lock().unwrap();
    if let Some(mut slot) = sessions.remove(&session_id) {
        // The reader thread owns the waitable Child, so retain an independent
        // killer. Dropping the master alone does not stop a child while the
        // reader clone still holds the PTY open.
        slot.killer.kill().map_err(|e| format!("pty_kill: {e}"))?;
    }
    Ok(())
}
