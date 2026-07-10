// OwLLM Remote Devices / Fleet Control.
//
// Secure device-to-device control: one OwLLM install drives another. The
// permission to control a machine is a CRYPTOGRAPHIC device key the target has
// explicitly paired with — NOT a GitHub login. GitHub matching only helps
// discovery/identity. See docs/REMOTE_DEVICES.md for the full architecture.
//
// This file is the orchestration + command surface. The security-critical logic
// lives in the focused submodules (each independently testable):
//   protocol  wire/storage types            policy   the authorize() chokepoint
//   crypto    sign/seal/open (+ tests)       trust    pairing + trusted keys (+ tests)
//   identity  the device keypair             registry known-device metadata
//   executor  gated run + timeout/cancel     audit    redacted trail (+ tests)
//   transport the loopback seam
//
// Inbound pipeline (target side), every step fail-closed:
//   feature on? → addressed to me? → crypto open (sig + id + decrypt) →
//   fresh ts? → unseen nonce? → controller Trusted? → authorize(kind,policy) →
//   execute (timeout+cancel) → audit → clear "being controlled".

pub mod protocol;

mod audit;
mod crypto;
mod executor;
mod identity;
mod lan;
mod policy;
mod registry;
mod relay;
mod session;
mod transport;
mod trust;

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use once_cell::sync::Lazy;
use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use protocol::{
    Authorization, CommandKind, CommandRequest, CommandResult, DevicePublic, DeviceRecord,
    PairRequest, PermissionPolicy, SignedEnvelope, TrustedController,
};
use transport::{LanDirectTransport, LoopbackTransport, Transport};

// ------------------------------------------------------------------
// Shared small helpers
// ------------------------------------------------------------------

/// RFC3339 timestamp. Centralized so every submodule stamps identically.
pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn now_unix() -> i64 {
    chrono::Utc::now().timestamp()
}

fn kind_str(k: CommandKind) -> &'static str {
    match k {
        CommandKind::Diagnostics => "diagnostics",
        CommandKind::Shell => "shell",
        CommandKind::Wsl => "wsl",
        CommandKind::FileWrite => "file_write",
        CommandKind::Admin => "admin",
        CommandKind::SessionOpen => "session_open",
        CommandKind::SessionWrite => "session_write",
        CommandKind::SessionRead => "session_read",
        CommandKind::SessionResize => "session_resize",
        CommandKind::SessionClose => "session_close",
    }
}

fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD.decode(s).map_err(|e| format!("base64 decode: {e}"))
}

/// Best-effort signed-in GitHub login (identity is *associated* with it, but
/// control is never granted by it). Read straight from the accounts secrets file.
fn github_login() -> Option<String> {
    let p = crate::paths::owllm_config_home()?.join("agent_secrets.json");
    let txt = std::fs::read_to_string(p).ok()?;
    let v: Value = serde_json::from_str(&txt).ok()?;
    v.get("GITHUB_LOGIN").and_then(Value::as_str).map(|s| s.to_string())
}

// ------------------------------------------------------------------
// App handle (for emitting the "being controlled" banner)
// ------------------------------------------------------------------

static APP: Lazy<Mutex<Option<AppHandle>>> = Lazy::new(|| Mutex::new(None));

fn store_app(app: &AppHandle) {
    let mut g = APP.lock().unwrap();
    if g.is_none() {
        *g = Some(app.clone());
    }
}

// ------------------------------------------------------------------
// "Being controlled" state
// ------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct ControlSession {
    controller_id: String,
    controller_name: String,
    request_id: String,
    kind: String,
    started_at: String,
}

static CONTROL: Lazy<Mutex<Vec<ControlSession>>> = Lazy::new(|| Mutex::new(Vec::new()));

fn emit_control() {
    let payload = control_state_value();
    if let Some(app) = APP.lock().unwrap().as_ref() {
        let _ = app.emit("remote-devices:control", payload);
    }
}

fn control_state_value() -> Value {
    let sessions = CONTROL.lock().unwrap().clone();
    json!({ "active": !sessions.is_empty(), "sessions": sessions })
}

fn begin_control(frame: &SignedEnvelope, req: &CommandRequest) {
    let name = trust::find(&frame.from_device)
        .map(|c| c.name)
        .unwrap_or_else(|| frame.from_device.clone());
    CONTROL.lock().unwrap().push(ControlSession {
        controller_id: frame.from_device.clone(),
        controller_name: name,
        request_id: req.request_id.clone(),
        kind: kind_str(req.kind).to_string(),
        started_at: now_rfc3339(),
    });
    emit_control();
}

/// Persistent banner entry for an interactive session (keyed by session id, so
/// it stays up for the whole session instead of flickering per keystroke).
fn begin_session_control(frame: &SignedEnvelope, session_id: &str) {
    let name = trust::find(&frame.from_device)
        .map(|c| c.name)
        .unwrap_or_else(|| frame.from_device.clone());
    CONTROL.lock().unwrap().push(ControlSession {
        controller_id: frame.from_device.clone(),
        controller_name: name,
        request_id: session_id.to_string(),
        kind: "shell session".into(),
        started_at: now_rfc3339(),
    });
    emit_control();
}

fn end_control(request_id: &str) {
    CONTROL.lock().unwrap().retain(|s| s.request_id != request_id);
    emit_control();
}

// ------------------------------------------------------------------
// Feature flag — default OFF (env override + persisted toggle)
// ------------------------------------------------------------------

fn enabled_path() -> Option<PathBuf> {
    crate::paths::user_data_root().map(|r| r.join("remote_devices_enabled.json"))
}

fn env_override() -> bool {
    std::env::var("OWLLM_REMOTE_DEVICES")
        .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes" | "YES" | "on" | "ON"))
        .unwrap_or(false)
}

fn load_enabled() -> bool {
    enabled_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("enabled").and_then(Value::as_bool))
        .unwrap_or(false)
}

fn feature_enabled() -> bool {
    env_override() || load_enabled()
}

fn set_enabled(enabled: bool) -> Result<(), String> {
    let path = enabled_path().ok_or_else(|| "could not resolve app data dir".to_string())?;
    if let Some(p) = path.parent() {
        let _ = std::fs::create_dir_all(p);
    }
    let txt = serde_json::to_string_pretty(&json!({ "enabled": enabled })).unwrap();
    std::fs::write(&path, txt).map_err(|e| format!("write enable flag: {e}"))
}

// ------------------------------------------------------------------
// WAN config: user-set public endpoint + relay URL
// ------------------------------------------------------------------

fn config_path() -> Option<PathBuf> {
    crate::paths::user_data_root().map(|r| r.join("remote_devices_config.json"))
}

fn load_config() -> Value {
    config_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .unwrap_or_else(|| json!({}))
}

fn cfg_string(key: &str) -> Option<String> {
    load_config()
        .get(key)
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// A user-set public host:port for THIS device (port-forward / DDNS / MagicDNS),
/// published as the most WAN-reachable candidate.
fn public_endpoint() -> Option<String> {
    cfg_string("public_endpoint")
}

/// The shared relay URL both devices dial out to (WAN, pure-NAT fallback).
fn relay_url() -> Option<String> {
    cfg_string("relay_url")
}

/// Whether agents may drive remote devices (default OFF).
fn agents_allowed() -> bool {
    load_config().get("agents_allowed").and_then(Value::as_bool).unwrap_or(false)
}

fn set_agents_allowed_cfg(v: bool) -> Result<(), String> {
    let path = config_path().ok_or_else(|| "could not resolve app data dir".to_string())?;
    if let Some(p) = path.parent() {
        let _ = std::fs::create_dir_all(p);
    }
    let mut doc = load_config();
    doc["agents_allowed"] = json!(v);
    let txt = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(&path, txt).map_err(|e| format!("write remote-devices config: {e}"))
}

fn write_config(key: &str, value: Option<String>) -> Result<(), String> {
    let path = config_path().ok_or_else(|| "could not resolve app data dir".to_string())?;
    if let Some(p) = path.parent() {
        let _ = std::fs::create_dir_all(p);
    }
    let mut doc = load_config();
    match value {
        Some(v) if !v.trim().is_empty() => doc[key] = json!(v.trim()),
        _ => {
            if let Some(obj) = doc.as_object_mut() {
                obj.remove(key);
            }
        }
    }
    let txt = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(&path, txt).map_err(|e| format!("write remote-devices config: {e}"))
}

// ------------------------------------------------------------------
// Replay guard (in-memory, bounded) — see docs for the persistence note
// ------------------------------------------------------------------

const SEEN_MAX: usize = 4096;
const FRESHNESS_SECS: i64 = 120;

// Persisted so a restart doesn't reopen the replay window for nonces seen in the
// last freshness window. Entries older than the window are rejected by the ts
// check anyway, so the file is pruned to stay tiny.
static SEEN: Lazy<Mutex<VecDeque<(String, i64)>>> = Lazy::new(|| Mutex::new(load_seen()));

fn seen_path() -> Option<PathBuf> {
    crate::paths::user_data_root().map(|r| r.join("remote_devices_seen.json"))
}

fn load_seen() -> VecDeque<(String, i64)> {
    let cutoff = now_unix() - FRESHNESS_SECS * 3;
    seen_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<VecDeque<(String, i64)>>(&t).ok())
        .map(|v| v.into_iter().filter(|(_, ts)| *ts >= cutoff).collect())
        .unwrap_or_default()
}

fn persist_seen(q: &VecDeque<(String, i64)>) {
    if let Some(path) = seen_path() {
        if let Some(p) = path.parent() {
            let _ = std::fs::create_dir_all(p);
        }
        if let Ok(txt) = serde_json::to_string(q) {
            let _ = std::fs::write(path, txt);
        }
    }
}

fn replay_ok(nonce: &str, ts: i64) -> bool {
    let mut q = SEEN.lock().unwrap();
    let cutoff = now_unix() - FRESHNESS_SECS * 3;
    q.retain(|(_, t)| *t >= cutoff);
    if q.iter().any(|(n, _)| n == nonce) {
        return false;
    }
    q.push_back((nonce.to_string(), ts));
    while q.len() > SEEN_MAX {
        q.pop_front();
    }
    persist_seen(&q);
    true
}

// ------------------------------------------------------------------
// Inbound pipeline (TARGET side) — the security gate
// ------------------------------------------------------------------

fn deny(request_id: &str, msg: &str) -> CommandResult {
    CommandResult {
        request_id: request_id.to_string(),
        ok: false,
        stdout: String::new(),
        stderr: String::new(),
        exit_code: None,
        error: Some(msg.to_string()),
        decision: "denied".into(),
        duration_ms: 0,
        ..Default::default()
    }
}

fn audit_inbound(frame: &SignedEnvelope, req: &CommandRequest, result: &CommandResult) {
    audit::write(&audit::record(
        "inbound",
        &frame.from_device,
        &frame.to_device,
        kind_str(req.kind),
        &req.command,
        &result.decision,
        result,
    ));
}

/// Handle one sealed frame arriving at THIS device. Returns Err ONLY on
/// integrity failure (bad signature / spoofed id / undecryptable / misrouted) —
/// those are hard rejects. Every *authenticated but refused* case returns
/// Ok(CommandResult{decision:"denied"}) so the controller sees why.
pub async fn handle_incoming(frame: SignedEnvelope) -> Result<CommandResult, String> {
    let me = identity::load_or_create()?;
    let my_id = me.secrets.device_id();

    // Addressed to us?
    if frame.to_device != my_id {
        return Err("frame addressed to a different device".into());
    }

    // Feature must be enabled to act on ANY inbound control (even authenticated).
    if !feature_enabled() {
        // We can't decrypt intent here without doing work; refuse before it.
        let r = deny("?", "remote device control is disabled on this machine");
        let placeholder = CommandRequest {
            request_id: "?".into(),
            kind: CommandKind::Diagnostics,
            command: String::new(),
            payload: None,
            timeout_ms: 0,
            ..Default::default()
        };
        audit_inbound(&frame, &placeholder, &r);
        return Ok(r);
    }

    // Crypto: verifies the Ed25519 signature, checks the id↔key binding, and
    // decrypts. A forged/tampered frame errors out here.
    let plaintext = crypto::open(&frame, &me.secrets.x25519_secret)?;
    let req: CommandRequest =
        serde_json::from_slice(&plaintext).map_err(|e| format!("bad request payload: {e}"))?;

    // Freshness — reject stale/pre-recorded frames.
    if (now_unix() - frame.ts).abs() > FRESHNESS_SECS {
        let r = deny(&req.request_id, "stale request (outside the freshness window)");
        audit_inbound(&frame, &req, &r);
        return Ok(r);
    }

    // Replay — reject a re-sent nonce within the window.
    if !replay_ok(&frame.nonce, frame.ts) {
        let r = deny(&req.request_id, "replayed request rejected");
        audit_inbound(&frame, &req, &r);
        return Ok(r);
    }

    // Trust → policy. Unknown / pending / revoked / key-mismatch ⇒ None ⇒ refuse.
    let policy = match trust::authorized_policy(&frame.from_device, &frame.from_ed25519_pub) {
        Some(p) => p,
        None => {
            let r = deny(
                &req.request_id,
                "controller is not a trusted device — pair and approve it on this machine first",
            );
            audit_inbound(&frame, &req, &r);
            return Ok(r);
        }
    };

    // Interactive session ops route to the session manager. They keep their own
    // persistent "being controlled" banner (per-op begin/end would flicker on
    // every read poll) and skip the high-frequency keystroke/poll audit.
    if is_session_kind(req.kind) {
        let result = match policy::authorize(req.kind, &policy) {
            Authorization::Allowed => {
                let r = session::handle(&frame.from_device, &req);
                match req.kind {
                    CommandKind::SessionOpen => {
                        if let Some(sid) = &r.session {
                            begin_session_control(&frame, sid);
                        }
                    }
                    CommandKind::SessionClose => {
                        if let Some(sid) = &req.session {
                            end_control(sid);
                        }
                    }
                    _ => {}
                }
                r
            }
            _ => deny(&req.request_id, "shell permission required for interactive sessions"),
        };
        let _ = registry::touch_last_seen(&frame.from_device);
        if matches!(req.kind, CommandKind::SessionOpen | CommandKind::SessionClose) {
            audit_inbound(&frame, &req, &result);
        }
        return Ok(result);
    }

    // Authorized surface — show the banner while it runs, then execute. Dangerous
    // kinds (FileWrite/Admin) additionally require a LIVE per-action approval on
    // this machine, even when the policy toggle is on.
    begin_control(&frame, &req);
    let result = match policy::authorize(req.kind, &policy) {
        Authorization::Denied => deny(&req.request_id, "permission denied by target policy"),
        Authorization::Allowed => executor::execute(&req, &policy).await,
        Authorization::RequiresApproval => {
            if await_approval(&frame, &req).await {
                executor::execute_dangerous(&req).await
            } else {
                deny(
                    &req.request_id,
                    "dangerous action was not approved on the target (denied or timed out)",
                )
            }
        }
    };
    end_control(&req.request_id);

    let _ = registry::touch_last_seen(&frame.from_device);
    audit_inbound(&frame, &req, &result);
    Ok(result)
}

fn is_session_kind(k: CommandKind) -> bool {
    matches!(
        k,
        CommandKind::SessionOpen
            | CommandKind::SessionWrite
            | CommandKind::SessionRead
            | CommandKind::SessionResize
            | CommandKind::SessionClose
    )
}

fn recipient_x_pub(to_device: &str) -> Result<[u8; 32], String> {
    let me = identity::load_or_create()?;
    if to_device == me.secrets.device_id() {
        return Ok(me.secrets.x25519_public());
    }
    let self_pub = identity::public_record(github_login())?;
    let rec = registry::list(&self_pub)
        .into_iter()
        .find(|d| d.public.device_id == to_device)
        .ok_or_else(|| "unknown target device (not in registry)".to_string())?;
    let raw = b64_decode(&rec.public.x25519_pub)?;
    raw.try_into().map_err(|_| "target x25519 pub is not 32 bytes".to_string())
}

// ------------------------------------------------------------------
// Listener lifecycle + public-record helpers
// ------------------------------------------------------------------

/// Start the LAN listener + relay client to match the current config, if the
/// feature is on. Idempotent — safe to call from any command entry point.
fn ensure_listener_started(rt: tokio::runtime::Handle) {
    if feature_enabled() {
        if lan::current_port().is_none() {
            if let Err(e) = lan::start(rt.clone()) {
                eprintln!("remote_devices: listener start failed: {e}");
            }
        }
        ensure_relay_client(rt);
    } else {
        lan::stop();
        relay::stop_client();
    }
}

/// Run the relay client loop iff the feature is on AND a relay URL is configured,
/// so this device stays reachable via the relay. Stops it otherwise.
fn ensure_relay_client(rt: tokio::runtime::Handle) {
    match (feature_enabled(), relay_url()) {
        (true, Some(url)) => {
            if !relay::client_running() {
                if let Ok(me) = identity::load_or_create() {
                    relay::start_client(rt, url, me.secrets.device_id());
                }
            }
        }
        _ => relay::stop_client(),
    }
}

/// This device's public record, decorated with the user-set public endpoint
/// (most WAN-reachable) and the relay-reachability flag.
pub fn self_public_record() -> Result<DevicePublic, String> {
    let mut rec = identity::public_record(github_login())?;
    if let Some(pe) = public_endpoint() {
        if !rec.endpoints.contains(&pe) {
            rec.endpoints.insert(0, pe);
        }
    }
    rec.endpoint = rec.endpoints.first().cloned();
    rec.relay = relay::client_running();
    Ok(rec)
}

/// (device_id, pretty-JSON) of this device's public record — for the vault.
pub fn self_vault_record() -> Result<(String, String), String> {
    let rec = self_public_record()?;
    let json = serde_json::to_string_pretty(&rec).map_err(|e| e.to_string())?;
    Ok((rec.device_id, json))
}

/// Ingest a peer's public record (from the vault) into the local registry.
/// Skips our own record, and rejects any record whose id doesn't match its key.
pub fn ingest_peer_record(json: &str) -> Result<bool, String> {
    let peer: DevicePublic =
        serde_json::from_str(json).map_err(|e| format!("bad device record: {e}"))?;
    let me = identity::load_or_create()?;
    if peer.device_id == me.secrets.device_id() {
        return Ok(false);
    }
    if crypto::device_id_from_ed_pub_b64(&peer.ed25519_pub).as_deref() != Some(peer.device_id.as_str())
    {
        return Err("device record id does not match its ed25519 key".into());
    }
    registry::upsert(peer, false)?;
    Ok(true)
}

// ------------------------------------------------------------------
// Reply sealing (target → controller)
// ------------------------------------------------------------------

/// Seal a CommandResult back to the controller's authenticated static X25519 key
/// so the LAN return path is end-to-end encrypted too.
pub fn seal_result_for(
    to_device: &str,
    to_x25519_pub_b64: &str,
    result: &CommandResult,
) -> Result<SignedEnvelope, String> {
    let me = identity::load_or_create()?;
    let raw = b64_decode(to_x25519_pub_b64)?;
    let recipient: [u8; 32] = raw
        .try_into()
        .map_err(|_| "reply x25519 pub is not 32 bytes".to_string())?;
    let pt = serde_json::to_vec(result).map_err(|e| e.to_string())?;
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    crypto::seal(&me.secrets, to_device, &recipient, &pt, now_unix(), &nonce)
}

// ------------------------------------------------------------------
// Command routing: loopback (self) → direct candidates (LAN/overlay/public)
// → relay fallback
// ------------------------------------------------------------------

/// All direct-dial endpoints known for a target: its full candidate list
/// (public + overlay + LAN), falling back to the legacy single `endpoint`.
fn target_endpoints(to_device: &str) -> Vec<String> {
    let Ok(self_pub) = self_public_record() else {
        return vec![];
    };
    let Some(rec) = registry::list(&self_pub).into_iter().find(|d| d.public.device_id == to_device)
    else {
        return vec![];
    };
    let mut eps = rec.public.endpoints.clone();
    if eps.is_empty() {
        if let Some(e) = rec.public.endpoint {
            eps.push(e);
        }
    }
    eps
}

/// A single known endpoint for a target (first candidate) — for pairing dials.
fn lookup_endpoint(to_device: &str) -> Option<String> {
    target_endpoints(to_device).into_iter().next()
}

async fn route_command(env: SignedEnvelope, to_device: &str) -> Result<CommandResult, String> {
    let me = identity::load_or_create()?;
    if to_device == me.secrets.device_id() {
        return LoopbackTransport.deliver(env).await;
    }

    // 1) Try every direct candidate in order (public host → overlay → LAN). A
    //    dead address fails fast on the connect timeout, so we fall through.
    let cands = target_endpoints(to_device);
    let mut last_err = String::new();
    for ep in &cands {
        match (LanDirectTransport { endpoint: ep.clone() }).deliver(env.clone()).await {
            Ok(r) => return Ok(r),
            Err(e) => last_err = e,
        }
    }

    // 2) Relay fallback (works behind any NAT — both peers dial the relay out).
    if let Some(url) = relay_url() {
        return (relay::RelayTransport { url }).deliver(env).await;
    }

    if cands.is_empty() {
        Err("target device has no known endpoint and no relay is configured (discover it, pair by IP, or set a relay)".into())
    } else {
        Err(format!("no direct endpoint reachable (tried {}); last error: {last_err}. Configure a relay for off-LAN control.", cands.len()))
    }
}

/// Build a signed pairing request for THIS device, POST it to a peer endpoint,
/// and add the peer's returned record to the registry. Used by both "pair a
/// known device" and "pair by IP".
async fn pair_with_endpoint(endpoint: &str) -> Result<DevicePublic, String> {
    let me_pub = self_public_record()?;
    let me = identity::load_or_create()?;
    let sig = crypto::sign_detached(&me.secrets, &PairRequest::signed_bytes(&me_pub));
    let peer = lan::send_pair(endpoint, PairRequest { from: me_pub, sig }).await?;
    // Learn the peer's keys/id so we can later seal commands to it.
    registry::upsert(peer.clone(), false)?;
    Ok(peer)
}

// ------------------------------------------------------------------
// Pairing event + dangerous-action approval gate
// ------------------------------------------------------------------

fn emit_pairing() {
    if let Some(app) = APP.lock().unwrap().as_ref() {
        let _ = app.emit("remote-devices:pairing", json!({ "at": now_rfc3339() }));
    }
}

#[derive(Clone, Serialize)]
struct PendingApproval {
    request_id: String,
    controller_id: String,
    controller_name: String,
    kind: String,
    command: String,
    requested_at: String,
}

static PENDING_META: Lazy<Mutex<Vec<PendingApproval>>> = Lazy::new(|| Mutex::new(Vec::new()));
static PENDING_TX: Lazy<Mutex<HashMap<String, oneshot::Sender<bool>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
const APPROVAL_TIMEOUT_SECS: u64 = 120;

fn emit_approval() {
    let payload = json!({ "pending": PENDING_META.lock().unwrap().clone() });
    if let Some(app) = APP.lock().unwrap().as_ref() {
        let _ = app.emit("remote-devices:approval", payload);
    }
}

/// Register a pending approval, emit the target-side prompt, and await the human
/// decision (or a timeout). Returns true ONLY on explicit approval.
async fn await_approval(frame: &SignedEnvelope, req: &CommandRequest) -> bool {
    let name = trust::find(&frame.from_device)
        .map(|c| c.name)
        .unwrap_or_else(|| frame.from_device.clone());
    let (tx, rx) = oneshot::channel::<bool>();
    PENDING_META.lock().unwrap().push(PendingApproval {
        request_id: req.request_id.clone(),
        controller_id: frame.from_device.clone(),
        controller_name: name,
        kind: kind_str(req.kind).to_string(),
        command: req.command.clone(),
        requested_at: now_rfc3339(),
    });
    PENDING_TX.lock().unwrap().insert(req.request_id.clone(), tx);
    emit_approval();

    let decided = tokio::time::timeout(Duration::from_secs(APPROVAL_TIMEOUT_SECS), rx).await;

    PENDING_META.lock().unwrap().retain(|p| p.request_id != req.request_id);
    PENDING_TX.lock().unwrap().remove(&req.request_id);
    emit_approval();

    matches!(decided, Ok(Ok(true)))
}

fn resolve_approval(request_id: &str, approved: bool) -> bool {
    let tx = PENDING_TX.lock().unwrap().remove(request_id);
    if let Some(tx) = tx {
        let _ = tx.send(approved);
        true
    } else {
        false
    }
}

// ==================================================================
// Tauri commands
// ==================================================================

/// This device's public identity + live capability/enable state. Also starts the
/// LAN listener when the feature is enabled (so the endpoint below is populated).
#[tauri::command]
pub async fn device_get_identity(app: AppHandle) -> Result<Value, String> {
    store_app(&app);
    ensure_listener_started(tokio::runtime::Handle::current());
    let rec = self_public_record()?;
    Ok(json!({
        "device_id": rec.device_id,
        "name": rec.name,
        "os": rec.os,
        "arch": rec.arch,
        "app_version": rec.app_version,
        "ed25519_pub": rec.ed25519_pub,
        "x25519_pub": rec.x25519_pub,
        "github_login": rec.github_login,
        "capabilities": rec.capabilities,
        "enabled": feature_enabled(),
        "env_override": env_override(),
        "endpoint": rec.endpoint,
        "endpoints": rec.endpoints,
        "listening": lan::current_port().is_some(),
        "public_endpoint": public_endpoint(),
        "relay_url": relay_url(),
        "relay_client": relay::client_running(),
        "relay_serving": relay::serving(),
        "agents_allowed": agents_allowed(),
    }))
}

/// Rename this device (cosmetic; the keypair/id are unchanged).
#[tauri::command]
pub fn device_set_name(name: String) -> Result<(), String> {
    identity::set_name(&name)
}

/// The master opt-in state (default OFF).
#[tauri::command]
pub fn device_remote_enabled_get() -> bool {
    feature_enabled()
}

/// Flip the master opt-in. The env override, if set, cannot be turned off here.
/// Starts/stops the LAN listener + relay client to match.
#[tauri::command]
pub async fn device_remote_enabled_set(app: AppHandle, enabled: bool) -> Result<(), String> {
    store_app(&app);
    set_enabled(enabled)?;
    ensure_listener_started(tokio::runtime::Handle::current());
    Ok(())
}

/// Set (or clear, with null) this device's public host:port — for reaching it
/// off-LAN via a port-forward / DDNS / Tailscale MagicDNS name.
#[tauri::command]
pub fn device_set_public_endpoint(endpoint: Option<String>) -> Result<(), String> {
    write_config("public_endpoint", endpoint)
}

/// Set (or clear, with null) the shared relay URL and (re)start the relay client
/// so this device becomes reachable via the relay.
#[tauri::command]
pub async fn device_set_relay(app: AppHandle, url: Option<String>) -> Result<(), String> {
    store_app(&app);
    write_config("relay_url", url)?;
    // Re-evaluate the client loop against the new URL.
    relay::stop_client();
    ensure_relay_client(tokio::runtime::Handle::current());
    Ok(())
}

/// Run a relay server on this machine (e.g. an always-on box with a public URL /
/// tunnel). Any device that points its relay URL here can be reached through it.
/// The relay only ever forwards ciphertext.
#[tauri::command]
pub fn device_relay_serve(bind: Option<String>) -> Result<Value, String> {
    let bind = bind.unwrap_or_else(|| "0.0.0.0:47772".to_string());
    relay::serve(&bind)?;
    Ok(json!({ "serving": true, "bind": bind }))
}

/// Stop the relay server running on this machine.
#[tauri::command]
pub fn device_relay_stop() -> Value {
    relay::stop_serving();
    json!({ "serving": false })
}

/// Relay status ({ url, client, serving }).
#[tauri::command]
pub fn device_relay_status() -> Value {
    json!({
        "url": relay_url(),
        "client": relay::client_running(),
        "serving": relay::serving(),
    })
}

/// LAN listener status ({ listening, endpoint }).
#[tauri::command]
pub fn device_listener_status() -> Value {
    lan::status_json()
}

/// "My OwLLM Devices" — known devices, with this machine always present.
#[tauri::command]
pub fn devices_list() -> Result<Vec<DeviceRecord>, String> {
    let me = identity::public_record(github_login())?;
    registry::upsert(me.clone(), true)?;
    Ok(registry::list(&me))
}

/// Remove a device from the local registry.
#[tauri::command]
pub fn device_forget(device_id: String) -> Result<(), String> {
    registry::forget(&device_id)
}

/// Controllers this device knows about (pending / trusted / revoked).
#[tauri::command]
pub fn device_trust_list() -> Result<Vec<TrustedController>, String> {
    Ok(trust::list())
}

/// Request pairing with a device. For THIS device (loopback) it records a local
/// pending request so you can drive the approve→control flow on one machine. For
/// a known peer it POSTs a signed pairing request to the peer's LAN endpoint.
#[tauri::command]
pub async fn device_request_pairing(to_device: String) -> Result<(), String> {
    let me = self_public_record()?;
    if to_device == me.device_id {
        return trust::record_pairing_request(
            &me.device_id,
            &me.name,
            &me.ed25519_pub,
            &me.x25519_pub,
        );
    }
    let endpoint = lookup_endpoint(&to_device)
        .ok_or_else(|| "target device has no known LAN endpoint (discover it or pair by IP)".to_string())?;
    pair_with_endpoint(&endpoint).await.map(|_| ())
}

/// Pair by typing a peer's "ip:port" directly (no vault discovery needed). Sends
/// this device's signed pairing request and adds the peer's returned record to
/// the registry so it can then be controlled once IT approves us.
#[tauri::command]
pub async fn device_pair_by_address(endpoint: String) -> Result<DeviceRecord, String> {
    let endpoint = endpoint.trim().to_string();
    if endpoint.is_empty() {
        return Err("enter the peer's ip:port".into());
    }
    let peer = pair_with_endpoint(&endpoint).await?;
    Ok(DeviceRecord { public: peer, last_seen: Some(now_rfc3339()), is_self: false })
}

/// Approve a pending controller with an initial permission policy.
#[tauri::command]
pub fn device_pairing_approve(device_id: String, policy: PermissionPolicy) -> Result<(), String> {
    trust::approve(&device_id, policy)
}

/// Deny a pending pairing request (marks it revoked — fails closed).
#[tauri::command]
pub fn device_pairing_deny(device_id: String) -> Result<(), String> {
    trust::deny(&device_id)
}

/// Revoke a previously trusted controller (takes effect on the next request).
#[tauri::command]
pub fn device_trust_revoke(device_id: String) -> Result<(), String> {
    trust::revoke(&device_id)
}

/// Remove a controller entirely (a future pair re-prompts fresh).
#[tauri::command]
pub fn device_trust_remove(device_id: String) -> Result<(), String> {
    trust::remove(&device_id)
}

/// Update a trusted controller's permission policy (the four toggles).
#[tauri::command]
pub fn device_trust_set_policy(device_id: String, policy: PermissionPolicy) -> Result<(), String> {
    trust::set_policy(&device_id, policy)
}

/// Send a command to a device (controller side). Seals + signs, routes through
/// loopback (self) or LAN-direct (peer), audits, and returns the target's result.
#[tauri::command]
pub async fn device_send(
    app: AppHandle,
    to_device: String,
    kind: CommandKind,
    command: Option<String>,
    payload: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<CommandResult, String> {
    store_app(&app);
    let req = CommandRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        kind,
        command: command.unwrap_or_default(),
        payload,
        timeout_ms: timeout_ms.unwrap_or(0),
        ..Default::default()
    };
    send_request(&to_device, req).await
}

/// Seal `req`, route it (loopback/LAN/relay), and return the target's result.
/// High-frequency session ops (write/read/resize) skip the audit; lifecycle +
/// one-shot commands are audited.
async fn send_request(to_device: &str, req: CommandRequest) -> Result<CommandResult, String> {
    let me = identity::load_or_create()?;
    let recipient_pub = recipient_x_pub(to_device)?;
    let plaintext = serde_json::to_vec(&req).map_err(|e| e.to_string())?;
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let env = crypto::seal(&me.secrets, to_device, &recipient_pub, &plaintext, now_unix(), &nonce)?;
    let result = route_command(env, to_device).await?;

    let noisy = matches!(
        req.kind,
        CommandKind::SessionWrite | CommandKind::SessionRead | CommandKind::SessionResize
    );
    if !noisy {
        audit::write(&audit::record(
            "outbound",
            &me.secrets.device_id(),
            to_device,
            kind_str(req.kind),
            &req.command,
            &result.decision,
            &result,
        ));
    }
    Ok(result)
}

/// Agent entry point: run a shell command on a paired device by NAME or id.
/// Gated by the agents-allowed switch; the target still enforces pairing + the
/// shell policy. Used by both the local tool loop and the MCP gateway (so
/// subscription-CLI agents get the same capability).
pub async fn agent_device_exec(device_name_or_id: &str, command: &str) -> Result<CommandResult, String> {
    if !agents_allowed() {
        return Err("remote device access is disabled — enable 'Let agents use remote devices' on the Devices page".into());
    }
    let want = device_name_or_id.trim();
    if want.is_empty() {
        return Err("device is required (a paired device name or id)".into());
    }
    let self_pub = self_public_record()?;
    let target = registry::list(&self_pub)
        .into_iter()
        .find(|d| !d.is_self && (d.public.device_id == want || d.public.name.eq_ignore_ascii_case(want)))
        .ok_or_else(|| format!("no paired device '{want}' — pair it on the Devices page first"))?;
    let req = CommandRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        kind: CommandKind::Shell,
        command: command.to_string(),
        timeout_ms: 60_000,
        ..Default::default()
    };
    send_request(&target.public.device_id, req).await
}

/// Open an interactive remote shell (SSH-like). Returns the session id.
#[tauri::command]
pub async fn device_session_open(
    app: AppHandle,
    to_device: String,
    shell: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<CommandResult, String> {
    store_app(&app);
    let req = CommandRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        kind: CommandKind::SessionOpen,
        command: shell.unwrap_or_default(),
        cols,
        rows,
        ..Default::default()
    };
    send_request(&to_device, req).await
}

/// Send keystrokes (base64) to an open remote session.
#[tauri::command]
pub async fn device_session_write(to_device: String, session: String, data: String) -> Result<CommandResult, String> {
    let req = CommandRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        kind: CommandKind::SessionWrite,
        session: Some(session),
        payload: Some(data),
        ..Default::default()
    };
    send_request(&to_device, req).await
}

/// Drain buffered output from an open remote session (base64 in `data`).
#[tauri::command]
pub async fn device_session_read(to_device: String, session: String) -> Result<CommandResult, String> {
    let req = CommandRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        kind: CommandKind::SessionRead,
        session: Some(session),
        ..Default::default()
    };
    send_request(&to_device, req).await
}

/// Resize an open remote session's PTY.
#[tauri::command]
pub async fn device_session_resize(to_device: String, session: String, cols: u16, rows: u16) -> Result<CommandResult, String> {
    let req = CommandRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        kind: CommandKind::SessionResize,
        session: Some(session),
        cols: Some(cols),
        rows: Some(rows),
        ..Default::default()
    };
    send_request(&to_device, req).await
}

/// Close an open remote session.
#[tauri::command]
pub async fn device_session_close(to_device: String, session: String) -> Result<CommandResult, String> {
    let req = CommandRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        kind: CommandKind::SessionClose,
        session: Some(session),
        ..Default::default()
    };
    send_request(&to_device, req).await
}

/// Pending dangerous-action approvals awaiting a decision on THIS machine.
#[tauri::command]
pub fn device_pending_approvals() -> Value {
    json!({ "pending": PENDING_META.lock().unwrap().clone() })
}

/// Approve a pending dangerous action (target side) — lets the held command run.
#[tauri::command]
pub fn device_approve_action(request_id: String) -> bool {
    resolve_approval(&request_id, true)
}

/// Deny a pending dangerous action (target side).
#[tauri::command]
pub fn device_deny_action(request_id: String) -> bool {
    resolve_approval(&request_id, false)
}

/// Pull peer device records from the vault + publish ours (discovery).
#[tauri::command]
pub async fn device_sync_discovery() -> Result<bool, String> {
    crate::vault::vault_sync_devices().await
}

/// Cancel one in-flight command by id.
#[tauri::command]
pub fn device_cancel(request_id: String) -> bool {
    executor::cancel(&request_id)
}

/// Current "being controlled" state (which controllers are running what).
#[tauri::command]
pub fn device_control_state() -> Value {
    control_state_value()
}

/// EMERGENCY STOP — cancel every in-flight command AND kill every interactive
/// session, then clear the state.
#[tauri::command]
pub fn device_stop_remote_control(app: AppHandle) -> Value {
    store_app(&app);
    let cancelled = executor::cancel_all();
    let sessions = session::kill_all();
    CONTROL.lock().unwrap().clear();
    emit_control();
    json!({ "cancelled": cancelled, "sessions_killed": sessions })
}

/// Whether agents may drive paired+shell-granted remote devices (default OFF).
#[tauri::command]
pub fn device_agents_allowed_get() -> bool {
    agents_allowed()
}

/// Flip the "let agents use remote devices" switch. Once on, agents get a
/// remote_shell tool for any paired device your machine has been granted shell
/// on — no per-call prompt (admin/elevation on the target is still gated).
#[tauri::command]
pub fn device_set_agents_allowed(allowed: bool) -> Result<(), String> {
    set_agents_allowed_cfg(allowed)
}

/// The last `limit` audit lines (redacted), newest last.
#[tauri::command]
pub fn device_audit_tail(limit: Option<usize>) -> Vec<Value> {
    audit::tail(limit.unwrap_or(200))
}

/// End-to-end self-test: seals a diagnostics request self→self, opens it
/// (verifying signature + id binding), authorizes under the read-only default,
/// and runs it — proving the whole pipeline WITHOUT touching the trust store.
#[tauri::command]
pub async fn device_selftest(app: AppHandle) -> Result<Value, String> {
    store_app(&app);
    let me = identity::load_or_create()?;
    let req = CommandRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        kind: CommandKind::Diagnostics,
        command: String::new(),
        payload: None,
        timeout_ms: 10_000,
        ..Default::default()
    };
    let plaintext = serde_json::to_vec(&req).map_err(|e| e.to_string())?;
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let env = crypto::seal(
        &me.secrets,
        &me.secrets.device_id(),
        &me.secrets.x25519_public(),
        &plaintext,
        now_unix(),
        &nonce,
    )?;
    let sealed_opaque = !env.ciphertext.contains("diagnostics");
    // open() succeeding proves the signature + id-binding held and the body
    // decrypted under the target key.
    let opened = crypto::open(&env, &me.secrets.x25519_secret)?;
    let req2: CommandRequest = serde_json::from_slice(&opened).map_err(|e| e.to_string())?;
    let result = executor::execute(&req2, &PermissionPolicy::default()).await;
    Ok(json!({
        "ok": result.ok,
        "sealed_opaque": sealed_opaque,
        "signature_verified": true,
        "decision": result.decision,
        "device_id": me.secrets.device_id(),
        "diagnostics": result.stdout,
    }))
}

// One process-wide lock for every test that mutates the global env/user-data
// dir (this module + trust.rs). Cargo runs tests in parallel threads within one
// binary, so a per-module lock wouldn't stop cross-module races on OWLLM_USER_DATA.
#[cfg(test)]
pub(crate) static TEST_ENV_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    /// Seal a fresh controller's request to `target` and return the frame.
    fn seal_for(
        controller: &crypto::DeviceSecrets,
        target: &identity::Identity,
        kind: CommandKind,
        command: &str,
    ) -> SignedEnvelope {
        let req = CommandRequest {
            request_id: "r".into(),
            kind,
            command: command.into(),
            payload: None,
            timeout_ms: 5000,
            ..Default::default()
        };
        let pt = serde_json::to_vec(&req).unwrap();
        let mut nonce = [0u8; 24];
        OsRng.fill_bytes(&mut nonce);
        crypto::seal(
            controller,
            &target.secrets.device_id(),
            &target.secrets.x25519_public(),
            &pt,
            now_unix(),
            &nonce,
        )
        .unwrap()
    }

    #[tokio::test]
    async fn untrusted_controller_is_refused_end_to_end() {
        let _g = TEST_ENV_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("OWLLM_USER_DATA", dir.path());
        std::env::set_var("OWLLM_REMOTE_DEVICES", "1"); // feature ON

        let target = identity::load_or_create().unwrap();
        // A controller that was never paired seals a SHELL command.
        let controller = crypto::DeviceSecrets::generate();
        let env = seal_for(&controller, &target, CommandKind::Shell, "echo hi");

        // Cryptographically authentic (opens fine) but NOT trusted ⇒ refused,
        // never executed. This is the core "GitHub/keys alone ≠ control" tripwire.
        let res = handle_incoming(env).await.unwrap();
        assert!(!res.ok);
        assert_eq!(res.decision, "denied");

        std::env::remove_var("OWLLM_USER_DATA");
        std::env::remove_var("OWLLM_REMOTE_DEVICES");
    }

    #[tokio::test]
    async fn feature_off_refuses_before_acting() {
        let _g = TEST_ENV_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("OWLLM_USER_DATA", dir.path());
        std::env::remove_var("OWLLM_REMOTE_DEVICES"); // feature OFF

        let target = identity::load_or_create().unwrap();
        let controller = crypto::DeviceSecrets::generate();
        let env = seal_for(&controller, &target, CommandKind::Diagnostics, "");

        // Even read-only diagnostics is refused while the whole capability is off.
        let res = handle_incoming(env).await.unwrap();
        assert!(!res.ok);
        assert_eq!(res.decision, "denied");

        std::env::remove_var("OWLLM_USER_DATA");
    }

    #[tokio::test]
    async fn misrouted_frame_is_a_hard_error() {
        let _g = TEST_ENV_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("OWLLM_USER_DATA", dir.path());
        std::env::set_var("OWLLM_REMOTE_DEVICES", "1");

        let target = identity::load_or_create().unwrap();
        let controller = crypto::DeviceSecrets::generate();
        let mut env = seal_for(&controller, &target, CommandKind::Diagnostics, "");
        env.to_device = "someone-else".into();
        // Addressed to a different device ⇒ hard reject (Err), not a result.
        assert!(handle_incoming(env).await.is_err());

        std::env::remove_var("OWLLM_USER_DATA");
        std::env::remove_var("OWLLM_REMOTE_DEVICES");
    }
}
