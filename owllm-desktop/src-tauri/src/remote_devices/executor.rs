// Remote command executor. Runs ONLY what `policy::authorize` permits, always
// with a hard timeout, and registers every run so it can be cancelled (by
// request id) or halted en masse (the emergency Stop).
//
// v1 executes: Diagnostics (read-only), Shell (gated), WSL (gated on Windows).
// FileWrite / Admin are dangerous — authorize returns RequiresApproval and this
// executor refuses to run them (fail-closed); wiring approved-dangerous
// execution is a deliberate later step, not an accidental gap.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use once_cell::sync::Lazy;
use tokio::io::AsyncReadExt;
use tokio::sync::watch;

use super::policy::{authorize, decision_label};
use super::protocol::{Authorization, CommandKind, CommandRequest, CommandResult, PermissionPolicy};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 120_000;

// Active runs, keyed by request id, each with a cancel signal. std::Mutex is
// fine — never held across an await.
static ACTIVE: Lazy<Mutex<HashMap<String, watch::Sender<bool>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn register(request_id: &str) -> watch::Receiver<bool> {
    let (tx, rx) = watch::channel(false);
    ACTIVE.lock().unwrap().insert(request_id.to_string(), tx);
    rx
}

fn unregister(request_id: &str) {
    ACTIVE.lock().unwrap().remove(request_id);
}

/// Signal a specific in-flight command to cancel. Returns true if it was live.
pub fn cancel(request_id: &str) -> bool {
    if let Some(tx) = ACTIVE.lock().unwrap().get(request_id) {
        let _ = tx.send(true);
        true
    } else {
        false
    }
}

/// Signal every in-flight command to cancel (the emergency Stop). Returns count.
pub fn cancel_all() -> usize {
    let map = ACTIVE.lock().unwrap();
    for tx in map.values() {
        let _ = tx.send(true);
    }
    map.len()
}

fn clamp_timeout(ms: u64) -> u64 {
    if ms == 0 {
        DEFAULT_TIMEOUT_MS
    } else {
        ms.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
    }
}

async fn wait_cancel(rx: &mut watch::Receiver<bool>) {
    if *rx.borrow() {
        return;
    }
    while rx.changed().await.is_ok() {
        if *rx.borrow() {
            return;
        }
    }
}

fn refused(req: &CommandRequest, decision: Authorization, msg: &str, started: Instant) -> CommandResult {
    CommandResult {
        request_id: req.request_id.clone(),
        ok: false,
        stdout: String::new(),
        stderr: String::new(),
        exit_code: None,
        error: Some(msg.to_string()),
        decision: decision_label(decision).to_string(),
        duration_ms: started.elapsed().as_millis() as u64, ..Default::default()
    }
}

/// Execute `req` under `policy`. This is the single execution entry point; it
/// authorizes first and never runs a denied/approval-gated command.
pub async fn execute(req: &CommandRequest, policy: &PermissionPolicy) -> CommandResult {
    let started = Instant::now();
    let decision = authorize(req.kind, policy);
    match decision {
        Authorization::Denied => {
            return refused(req, decision, "permission denied by target policy", started);
        }
        Authorization::RequiresApproval => {
            return refused(
                req,
                decision,
                "dangerous operation requires per-action target approval (not available in v1)",
                started,
            );
        }
        Authorization::Allowed => {}
    }

    let timeout_ms = clamp_timeout(req.timeout_ms);
    match req.kind {
        CommandKind::Diagnostics => diagnostics(req, started),
        CommandKind::Shell => run_process(req, timeout_ms, started, ProcKind::Shell).await,
        CommandKind::Wsl => run_wsl(req, timeout_ms, started).await,
        // Unreachable: authorize() only returns Allowed for the three above.
        CommandKind::FileWrite | CommandKind::Admin => {
            refused(req, Authorization::Denied, "not executable", started)
        }
        // Session ops are routed to session.rs by handle_incoming, never here.
        CommandKind::SessionOpen
        | CommandKind::SessionWrite
        | CommandKind::SessionRead
        | CommandKind::SessionResize
        | CommandKind::SessionClose => {
            refused(req, Authorization::Denied, "session op mis-routed to executor", started)
        }
    }
}

/// Run a dangerous command AFTER a target-side approval was granted. The caller
/// (handle_incoming) owns the approval gate; this does NOT re-authorize.
pub async fn execute_dangerous(req: &CommandRequest) -> CommandResult {
    let started = Instant::now();
    let mut r = match req.kind {
        CommandKind::FileWrite => run_file_write(req, started),
        // Admin runs as an (audited) shell command — the elevation semantics are
        // OS-specific; v1 treats it as an explicitly-approved privileged command.
        CommandKind::Admin => run_process(req, clamp_timeout(req.timeout_ms), started, ProcKind::Shell).await,
        _ => refused(req, Authorization::Denied, "not a dangerous kind", started),
    };
    // We're only here because the human approved it.
    r.decision = "approved".into();
    r
}

fn run_file_write(req: &CommandRequest, started: Instant) -> CommandResult {
    let path = req.command.trim();
    if path.is_empty() {
        return finish_err(req, started, "empty file path");
    }
    let content = match &req.payload {
        Some(b64) => {
            use base64::{engine::general_purpose::STANDARD, Engine as _};
            match STANDARD.decode(b64) {
                Ok(bytes) => bytes,
                Err(e) => return finish_err(req, started, &format!("bad base64 payload: {e}")),
            }
        }
        None => Vec::new(),
    };
    match std::fs::write(path, &content) {
        Ok(()) => CommandResult {
            request_id: req.request_id.clone(),
            ok: true,
            stdout: format!("wrote {} bytes to {path}", content.len()),
            stderr: String::new(),
            exit_code: Some(0),
            error: None,
            decision: "approved".into(),
            duration_ms: started.elapsed().as_millis() as u64, ..Default::default()
        },
        Err(e) => finish_err(req, started, &format!("write failed: {e}")),
    }
}

// ------------------------------------------------------------------
// Diagnostics — read-only, no side effects
// ------------------------------------------------------------------

fn diagnostics(req: &CommandRequest, started: Instant) -> CommandResult {
    let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0);
    let wsl = wsl_summary();
    let text = format!(
        "OwLLM device diagnostics\n\
         os          : {}\n\
         family      : {}\n\
         arch        : {}\n\
         app_version : {}\n\
         hostname    : {}\n\
         logical_cpus: {}\n\
         wsl         : {}\n",
        std::env::consts::OS,
        std::env::consts::FAMILY,
        std::env::consts::ARCH,
        env!("CARGO_PKG_VERSION"),
        hostname(),
        cpus,
        wsl,
    );
    CommandResult {
        request_id: req.request_id.clone(),
        ok: true,
        stdout: text,
        stderr: String::new(),
        exit_code: Some(0),
        error: None,
        decision: "allowed".into(),
        duration_ms: started.elapsed().as_millis() as u64, ..Default::default()
    }
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".to_string())
}

fn wsl_summary() -> String {
    #[cfg(windows)]
    {
        match crate::wsl::best_linux_distro() {
            Some(d) => format!("available (distro: {d})"),
            None => "not available".to_string(),
        }
    }
    #[cfg(not(windows))]
    {
        "n/a (non-Windows)".to_string()
    }
}

// ------------------------------------------------------------------
// Shell — spawned with timeout + cancellation
// ------------------------------------------------------------------

enum ProcKind {
    Shell,
}

fn shell_invocation(command: &str) -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        ("cmd".to_string(), vec!["/C".to_string(), command.to_string()])
    }
    #[cfg(not(windows))]
    {
        ("sh".to_string(), vec!["-c".to_string(), command.to_string()])
    }
}

async fn run_process(
    req: &CommandRequest,
    timeout_ms: u64,
    started: Instant,
    _kind: ProcKind,
) -> CommandResult {
    if req.command.trim().is_empty() {
        return refused(req, Authorization::Allowed, "empty command", started);
    }
    let (program, args) = shell_invocation(&req.command);
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        // tokio::process::Command provides creation_flags inherently on Windows.
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return finish_err(req, started, &format!("spawn failed: {e}")),
    };

    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let out_task = tokio::spawn(async move { drain(out_pipe.as_mut()).await });
    let err_task = tokio::spawn(async move { drain(err_pipe.as_mut()).await });

    let mut cancel_rx = register(&req.request_id);
    let mut outcome = "ok";
    let mut exit_code: Option<i32> = None;
    tokio::select! {
        r = child.wait() => {
            match r {
                Ok(status) => exit_code = status.code(),
                Err(_) => outcome = "wait_error",
            }
        }
        _ = tokio::time::sleep(std::time::Duration::from_millis(timeout_ms)) => {
            let _ = child.kill().await;
            outcome = "timeout";
        }
        _ = wait_cancel(&mut cancel_rx) => {
            let _ = child.kill().await;
            outcome = "cancelled";
        }
    }
    unregister(&req.request_id);

    let stdout = out_task.await.unwrap_or_default();
    let stderr = err_task.await.unwrap_or_default();
    let ok = outcome == "ok" && exit_code == Some(0);
    let error = match outcome {
        "timeout" => Some(format!("command timed out after {timeout_ms} ms")),
        "cancelled" => Some("command cancelled".to_string()),
        "wait_error" => Some("failed waiting on child".to_string()),
        _ => None,
    };
    CommandResult {
        request_id: req.request_id.clone(),
        ok,
        stdout,
        stderr,
        exit_code,
        error,
        decision: "allowed".into(),
        duration_ms: started.elapsed().as_millis() as u64, ..Default::default()
    }
}

async fn drain(pipe: Option<&mut (impl AsyncReadExt + Unpin)>) -> String {
    let mut buf = Vec::new();
    if let Some(p) = pipe {
        let _ = p.read_to_end(&mut buf).await;
    }
    String::from_utf8_lossy(&buf).to_string()
}

fn finish_err(req: &CommandRequest, started: Instant, msg: &str) -> CommandResult {
    CommandResult {
        request_id: req.request_id.clone(),
        ok: false,
        stdout: String::new(),
        stderr: String::new(),
        exit_code: None,
        error: Some(msg.to_string()),
        decision: "allowed".into(),
        duration_ms: started.elapsed().as_millis() as u64, ..Default::default()
    }
}

// ------------------------------------------------------------------
// WSL — Windows targets only, via the existing distro runner
// ------------------------------------------------------------------

async fn run_wsl(req: &CommandRequest, timeout_ms: u64, started: Instant) -> CommandResult {
    #[cfg(not(windows))]
    {
        let _ = timeout_ms;
        return refused(req, Authorization::Allowed, "WSL is only available on Windows targets", started);
    }
    #[cfg(windows)]
    {
        if req.command.trim().is_empty() {
            return refused(req, Authorization::Allowed, "empty command", started);
        }
        let Some(distro) = crate::wsl::best_linux_distro() else {
            return refused(req, Authorization::Allowed, "no usable WSL distro on this device", started);
        };
        let script = req.command.clone();
        // run_in_distro_script is blocking; run it off-thread with a timeout.
        // Cancellation of an in-flight WSL command is best-effort in v1 (the
        // blocking task cannot be force-killed) — the timeout still bounds it.
        let join = tokio::task::spawn_blocking(move || crate::wsl::run_in_distro_script(&distro, &script));
        let result = tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), join).await;
        match result {
            Err(_) => refused(req, Authorization::Allowed, &format!("WSL command timed out after {timeout_ms} ms"), started),
            Ok(Err(_join_err)) => finish_err(req, started, "WSL task panicked"),
            Ok(Ok(Ok(out))) => CommandResult {
                request_id: req.request_id.clone(),
                ok: true,
                stdout: out,
                stderr: String::new(),
                exit_code: Some(0),
                error: None,
                decision: "allowed".into(),
                duration_ms: started.elapsed().as_millis() as u64, ..Default::default()
            },
            Ok(Ok(Err(e))) => CommandResult {
                request_id: req.request_id.clone(),
                ok: false,
                stdout: String::new(),
                stderr: e,
                exit_code: None,
                error: Some("WSL command failed".to_string()),
                decision: "allowed".into(),
                duration_ms: started.elapsed().as_millis() as u64, ..Default::default()
            },
        }
    }
}
