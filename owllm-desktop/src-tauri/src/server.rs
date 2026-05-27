// Model-server lifecycle — native Rust, NO Python.
//
// Spawns llama-server.exe (LLM/runtime/llama.cpp/llama-server.exe) as
// a child process with `CREATE_NO_WINDOW` on Windows so the
// llama.cpp console never pops as a separate window. stdout + stderr
// are line-buffered and forwarded to a Tauri `server-log` event so
// the React UI can render a live log without polling.
//
// State (current child, model_id, port) lives in `ServerState` which
// the lib wires up via `tauri::Builder::manage`. Every command goes
// through the same Mutex so start/stop/status see one truth.

use crate::{models, paths};
use serde::Serialize;
use std::process::Stdio;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

#[derive(Default, Serialize, Clone)]
pub struct ServerStatus {
    pub running: bool,
    pub model_id: Option<String>,
    pub port: Option<u16>,
    pub message: String,
}

#[derive(Clone, Serialize)]
pub struct ServerLogEvent {
    pub stream: String,   // "stdout" | "stderr"
    pub line: String,
}

#[derive(Default)]
pub struct ServerState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    model_id: Option<String>,
    port: Option<u16>,
    message: String,
}

#[tauri::command]
pub async fn server_status(state: tauri::State<'_, ServerState>) -> Result<ServerStatus, String> {
    let mut inner = state.inner.lock().await;
    // Reap dead child so the "running" bit doesn't lie after a crash.
    let (alive, exit_code) = match inner.child.as_mut() {
        Some(c) => match c.try_wait() {
            Ok(None) => (true, None),
            Ok(Some(status)) => (false, status.code()),
            Err(_) => (false, None),
        },
        None => (false, None),
    };
    if !alive && inner.child.is_some() {
        // Transition from running -> dead: overwrite the stale
        // "Starting on http://..." message so the UI shows the truth.
        inner.child = None;
        inner.message = match exit_code {
            Some(0) => "Stopped cleanly.".to_string(),
            // Decode Windows NTSTATUS-style codes that surface as
            // signed i32 from Tokio's exit_status — these are by far
            // the most common llama-server crashes the user hits and
            // a bare exit code is impossible to act on without
            // googling. We surface the friendly cause + remediation
            // inline so the user knows the next step.
            Some(code) => {
                let hint = crash_hint_for(code);
                if let Some(h) = hint {
                    format!("Crashed (exit code {code}). {h} See log for full trace.")
                } else {
                    format!("Crashed (exit code {code}). Check the log for details.")
                }
            }
            None => "Process ended unexpectedly. Check the log for details.".to_string(),
        };
    } else if !alive && inner.message.is_empty() {
        inner.message = "Not running.".to_string();
    }
    Ok(ServerStatus {
        running: alive,
        model_id: inner.model_id.clone(),
        port: inner.port,
        message: inner.message.clone(),
    })
}

#[tauri::command]
pub async fn server_start(
    app: AppHandle,
    model_id: String,
    state: tauri::State<'_, ServerState>,
) -> Result<(), String> {
    // Resolve model entry by id.
    let registry = models::list_models().await?;
    let entry = registry
        .into_iter()
        .find(|m| m.model_id == model_id)
        .ok_or_else(|| format!("unknown model_id: {model_id}"))?;
    let port = entry
        .port
        .ok_or_else(|| format!("model {model_id} has no port in config"))?;
    let base_model = entry
        .base_model
        .ok_or_else(|| format!("model {model_id} has no base_model path"))?;

    let exe = paths::llama_server_exe().ok_or_else(|| {
        "llama-server.exe not found; set OWLLM_LLAMA_SERVER or place it at LLM/runtime/llama.cpp/llama-server.exe"
            .to_string()
    })?;

    // Take the lock and stop any running child before spawning a new one.
    let mut inner = state.inner.lock().await;
    if let Some(mut c) = inner.child.take() {
        let _ = c.kill().await;
    }

    let mut cmd = Command::new(&exe);
    cmd.arg("--model").arg(&base_model);
    cmd.arg("--host").arg("127.0.0.1");
    cmd.arg("--port").arg(port.to_string());
    // `-fit off` disables llama.cpp's auto-fit pass, which routinely
    // crashes with GGML_ASSERT(n_inputs < GGML_SCHED_MAX_SPLIT_INPUTS)
    // on models the heuristic can't place (verified on supergemma4 +
    // gemma-4-E4B in this tree). Pair with `-ngl 99` so all layers
    // go to GPU explicitly — without -ngl, `-fit off` defaults to
    // CPU and the user sees zero VRAM use, which feels like the app
    // is faking it. 99 is the conventional "all layers" sentinel.
    cmd.arg("-fit").arg("off");
    cmd.arg("-ngl").arg("99");
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW — the whole reason we did the Python wipe.
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn {}: {e}", exe.display()))?;

    // Forward stdout + stderr to a Tauri event channel.
    if let Some(stdout) = child.stdout.take() {
        let app = app.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app.emit(
                    "server-log",
                    ServerLogEvent {
                        stream: "stdout".into(),
                        line,
                    },
                );
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let app = app.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app.emit(
                    "server-log",
                    ServerLogEvent {
                        stream: "stderr".into(),
                        line,
                    },
                );
            }
        });
    }

    inner.child = Some(child);
    inner.model_id = Some(model_id);
    inner.port = Some(port);
    inner.message = format!("Starting on http://127.0.0.1:{port}");
    drop(inner);

    // Inform the UI immediately so the row turns "starting" without
    // waiting for a status poll.
    let _ = app.emit(
        "server-log",
        ServerLogEvent {
            stream: "stdout".into(),
            line: format!("[supervisor] spawned {} on :{port}", exe.display()),
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn server_stop(
    app: AppHandle,
    state: tauri::State<'_, ServerState>,
) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    if let Some(mut c) = inner.child.take() {
        let _ = c.kill().await;
    }
    inner.model_id = None;
    inner.port = None;
    inner.message = "Stopped.".to_string();
    drop(inner);
    let _ = app.emit(
        "server-log",
        ServerLogEvent {
            stream: "stdout".into(),
            line: "[supervisor] server stopped".into(),
        },
    );
    Ok(())
}

/// Translate the most common llama-server crash exit codes into a
/// one-line, actionable English hint shown alongside the raw number
/// in the Server tab status. Built around what the user actually
/// hits on Windows; non-matches fall through to the generic
/// "Check the log for details." message.
fn crash_hint_for(code: i32) -> Option<&'static str> {
    // Tokio's exit_status returns the unsigned NTSTATUS as a signed
    // i32, so 0xC000_0005 surfaces as -1_073_741_819, etc. Match on
    // both forms for clarity.
    let unsigned = code as u32;
    match unsigned {
        0xC000_0005 => Some(
            "STATUS_ACCESS_VIOLATION — usually VRAM OOM on a too-large model. \
             Try a smaller quant (e.g. Q4_K_M instead of f16) or lower -ngl."
        ),
        0xC000_0017 => Some(
            "STATUS_NO_MEMORY — out of system RAM. Close other apps or pick a smaller model."
        ),
        0xC000_001D => Some(
            "STATUS_ILLEGAL_INSTRUCTION — the llama.cpp build needs a CPU feature this machine lacks. \
             Reinstall the llama.cpp runtime with the non-AVX build."
        ),
        0xC000_0096 => Some(
            "STATUS_PRIVILEGED_INSTRUCTION — same root cause as STATUS_ILLEGAL_INSTRUCTION: CPU/build mismatch."
        ),
        0xC000_0142 => Some(
            "STATUS_DLL_INIT_FAILED — a CUDA / cuBLAS DLL failed to load. \
             Reinstall the llama.cpp+CUDA runtime."
        ),
        0xC000_0409 => Some(
            "STATUS_STACK_BUFFER_OVERRUN — likely a corrupt model file. Re-download or re-export the GGUF."
        ),
        _ => None,
    }
}

/// Convenience: install ServerState in a Tauri builder. Keeps the
/// `.manage(ServerState::default())` call out of lib.rs's wiring
/// manifest — module-local concerns stay in the module.
///
/// Also kills any leftover llama-server processes from a previous
/// session. The user has been bitten by this: kill_on_drop(true) on
/// tokio's Command isn't guaranteed to fire if the app is
/// force-killed, panics during shutdown, or the OS reaps the parent
/// before drop runs. Wiping orphans at startup gives the user a
/// reliably-clean slate every launch — and matches the UI's
/// expectation (header says "Stopped" the moment the app starts).
pub fn install<R: tauri::Runtime>(app: &tauri::App<R>) {
    app.manage(ServerState::default());
    kill_all_llama_servers("startup");
}

/// Walk the OS process table and kill every llama-server process by
/// name. Idempotent — safe to call multiple times. Called on
/// startup AND on app-exit so the user never accumulates orphans.
///
/// The `reason` string is just for the eprintln so we can see in the
/// log which path triggered the cleanup.
pub fn kill_all_llama_servers(reason: &str) {
    use sysinfo::System;
    let target_lc = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let mut killed = 0usize;
    for process in sys.processes().values() {
        let name = process.name().to_string_lossy();
        if name.eq_ignore_ascii_case(target_lc) {
            if process.kill() {
                killed += 1;
            }
        }
    }
    if killed > 0 {
        eprintln!("[supervisor] {reason}: killed {killed} stray llama-server process(es)");
    }
}
