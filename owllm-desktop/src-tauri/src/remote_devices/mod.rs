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
mod policy;
mod registry;
mod transport;
mod trust;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use protocol::{
    CommandKind, CommandRequest, CommandResult, DeviceRecord, PermissionPolicy, SignedEnvelope,
    TrustedController,
};
use transport::{LoopbackTransport, Transport};

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
// Replay guard (in-memory, bounded) — see docs for the persistence note
// ------------------------------------------------------------------

static SEEN: Lazy<Mutex<VecDeque<String>>> = Lazy::new(|| Mutex::new(VecDeque::new()));
const SEEN_MAX: usize = 4096;

fn replay_ok(nonce: &str) -> bool {
    let mut q = SEEN.lock().unwrap();
    if q.iter().any(|n| n == nonce) {
        return false;
    }
    q.push_back(nonce.to_string());
    while q.len() > SEEN_MAX {
        q.pop_front();
    }
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
            timeout_ms: 0,
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
    if (now_unix() - frame.ts).abs() > 120 {
        let r = deny(&req.request_id, "stale request (outside the freshness window)");
        audit_inbound(&frame, &req, &r);
        return Ok(r);
    }

    // Replay — reject a re-sent nonce within the window.
    if !replay_ok(&frame.nonce) {
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

    // Authorized surface — show the banner while it runs, then execute.
    begin_control(&frame, &req);
    let result = executor::execute(&req, &policy).await;
    end_control(&req.request_id);

    let _ = registry::touch_last_seen(&frame.from_device);
    audit_inbound(&frame, &req, &result);
    Ok(result)
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

// ==================================================================
// Tauri commands
// ==================================================================

/// This device's public identity + live capability/enable state.
#[tauri::command]
pub fn device_get_identity(app: AppHandle) -> Result<Value, String> {
    store_app(&app);
    let rec = identity::public_record(github_login())?;
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
#[tauri::command]
pub fn device_remote_enabled_set(enabled: bool) -> Result<(), String> {
    set_enabled(enabled)
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

/// v1 loopback pairing: register an incoming pairing request FROM this device
/// (so on a single machine you can drive the full approve→control flow). The
/// network relay path delivers a peer's request the same way.
#[tauri::command]
pub fn device_request_pairing(to_device: String) -> Result<(), String> {
    let me = identity::public_record(github_login())?;
    if to_device != me.device_id {
        return Err(
            "v1 loopback can only pair with THIS device; cross-device relay pairing is a follow-up"
                .into(),
        );
    }
    trust::record_pairing_request(&me.device_id, &me.name, &me.ed25519_pub, &me.x25519_pub)
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
/// the transport, audits, and returns the target's result.
#[tauri::command]
pub async fn device_send(
    app: AppHandle,
    to_device: String,
    kind: CommandKind,
    command: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<CommandResult, String> {
    store_app(&app);
    let me = identity::load_or_create()?;
    let recipient_pub = recipient_x_pub(&to_device)?;

    let req = CommandRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        kind,
        command: command.unwrap_or_default(),
        timeout_ms: timeout_ms.unwrap_or(0),
    };
    let plaintext = serde_json::to_vec(&req).map_err(|e| e.to_string())?;

    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let env = crypto::seal(
        &me.secrets,
        &to_device,
        &recipient_pub,
        &plaintext,
        now_unix(),
        &nonce,
    )?;

    let result = LoopbackTransport.deliver(env).await?;
    audit::write(&audit::record(
        "outbound",
        &me.secrets.device_id(),
        &to_device,
        kind_str(req.kind),
        &req.command,
        &result.decision,
        &result,
    ));
    Ok(result)
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

/// EMERGENCY STOP — cancel every in-flight remote command and clear the state.
#[tauri::command]
pub fn device_stop_remote_control(app: AppHandle) -> Value {
    store_app(&app);
    let cancelled = executor::cancel_all();
    CONTROL.lock().unwrap().clear();
    emit_control();
    json!({ "cancelled": cancelled })
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
        timeout_ms: 10_000,
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
            timeout_ms: 5000,
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
