// OWLLM Node — host capability that drives a remote KVM (e.g. a Sipeed
// NanoKVM) over the network. The agent's *eyes* are the target's captured
// video (screenshot → the existing VLM/mmproj path); its *hands* are an
// emulated USB-HID (type / keys / mouse / boot_key) plus out-of-band
// controls (mount_iso / power).
//
// SLICE 1 scaffolds the SAFETY plumbing only — the actual websocket/HID
// transport bodies are Phase-1 stubs that return "not connected — Phase 1".
// What IS real and enforced here:
//
//   1. FEATURE FLAG (default OFF) — the whole command errors unless
//      OWLLM_KVM_NODE is truthy. Matches the env-var flag convention used
//      across this crate (overlay_frame.rs, sandbox.rs, paths.rs).
//   2. CONSENT GATE — every injection action (type/keys/mouse/boot_key/
//      mount_iso/power) is checked against a per-host allowlist at exec
//      time, INDEPENDENT of the feature flag, and FAILS CLOSED. screenshot
//      is exempt (read-only "eyes"). Consent persists in kvm_consent.json.
//   3. AUDIT — every action appends ONE redacted JSONL line. Redaction is
//      the DEFAULT path (keyed on field name, not on the action) so a future
//      action can't leak a secret by simply forgetting to opt in:
//        auth.token       → never written (marker "<redacted>")
//        auth.sshKeyPath  → path string only (file contents are never read)
//        keystroke fields → {len, sha256} instead of the verbatim text.
//
// The session handle mirrors the mcp.rs / browser.rs pattern
// (`static SESSION: Lazy<TokioMutex<Option<..>>>`); in slice 1 it is always
// empty, which is exactly why the transport stubs report "not connected".

use once_cell::sync::Lazy;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tokio::sync::Mutex as TokioMutex;

// ------------------------------------------------------------------
// Contract types (the FROZEN slice-1 shapes)
// ------------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KvmAuth {
    /// Path to an SSH private key (for the `ssh` transport). Only the PATH is
    /// ever recorded; the key file itself is never read into the audit log.
    #[serde(default)]
    pub ssh_key_path: Option<String>,
    /// Bearer token / password for the `websocket` transport. Never logged.
    #[serde(default)]
    pub token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct KvmTarget {
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub auth: KvmAuth,
    /// "websocket" | "ssh".
    pub transport: String,
}

/// Live transport handle. Phase 1 never constructs one (the transport bodies
/// are stubs), so SESSION is always `None` — kept to mirror the session
/// pattern in mcp.rs / browser.rs and to give Phase 2 a home.
#[allow(dead_code)]
struct KvmSession {
    target: KvmTarget,
    transport: String,
}

static SESSION: Lazy<TokioMutex<Option<KvmSession>>> = Lazy::new(|| TokioMutex::new(None));

// ------------------------------------------------------------------
// Feature flag — default OFF
// ------------------------------------------------------------------

/// True only when OWLLM_KVM_NODE is set to a truthy value. Default OFF, so the
/// whole capability stays dormant unless a user explicitly opts in — same
/// env-var flag style as overlay_frame::enabled().
fn feature_enabled() -> bool {
    std::env::var("OWLLM_KVM_NODE")
        .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes" | "YES" | "on" | "ON"))
        .unwrap_or(false)
}

// ------------------------------------------------------------------
// Envelope — every return uses {ok, action, data?, error?}
// ------------------------------------------------------------------

fn env_ok(action: &str, data: Value) -> Value {
    json!({ "ok": true, "action": action, "data": data })
}

fn env_err(action: &str, error: &str) -> Value {
    json!({ "ok": false, "action": action, "error": error })
}

// ------------------------------------------------------------------
// Consent gate — per-host allowlist, fail-closed, screenshot exempt
// ------------------------------------------------------------------

/// Injection actions move the target's hands; they require prior consent.
/// screenshot (read-only "eyes") and any non-injection read do not.
fn is_injection(action: &str) -> bool {
    matches!(
        action,
        "type" | "keys" | "mouse" | "boot_key" | "mount_iso" | "power"
    )
}

/// Fail-closed consent decision. Pure so it is directly unit-testable.
/// screenshot / reads → always allowed. Injection → allowed ONLY if the exact
/// host is present in the granted set.
fn consent_allowed(action: &str, host: &str, granted: &HashSet<String>) -> bool {
    if !is_injection(action) {
        return true;
    }
    granted.contains(host)
}

fn consent_path() -> Option<PathBuf> {
    crate::paths::user_data_root().map(|r| r.join("kvm_consent.json"))
}

/// Load the set of hosts with consent == true. Any read/parse failure yields an
/// EMPTY set — i.e. fail-closed (a corrupt file grants nothing).
fn load_consent() -> HashSet<String> {
    let mut set = HashSet::new();
    let Some(path) = consent_path() else { return set };
    let Ok(txt) = std::fs::read_to_string(&path) else { return set };
    let Ok(v) = serde_json::from_str::<Value>(&txt) else { return set };
    if let Some(map) = v.get("hosts").and_then(Value::as_object) {
        for (host, granted) in map {
            if granted.as_bool() == Some(true) {
                set.insert(host.clone());
            }
        }
    }
    set
}

/// Persist a host's consent decision in kvm_consent.json ({"hosts": {host: bool}}).
fn save_consent(host: &str, grant: bool) -> Result<(), String> {
    let path = consent_path()
        .ok_or_else(|| "could not resolve app data dir for kvm_consent.json".to_string())?;
    let mut doc = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(|v| v.get("hosts").map(Value::is_object).unwrap_or(false))
        .unwrap_or_else(|| json!({ "hosts": {} }));
    doc["hosts"][host] = json!(grant);
    let txt = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(&path, txt).map_err(|e| format!("write kvm_consent.json: {e}"))
}

// ------------------------------------------------------------------
// Audit — one redacted JSONL line per action; redaction is the default
// ------------------------------------------------------------------

/// Field names whose STRING value is a secret or a keystroke payload. Redaction
/// is keyed on the NAME (not the action) so any current or future action that
/// carries one of these can't leak it by omission.
const SENSITIVE_FIELDS: &[&str] = &[
    "text", "combo", "key", "keys", "password", "passphrase", "token", "secret",
];

fn sha256_hex(s: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Replace every sensitive string field with `{len, sha256}`. Non-string values
/// and non-sensitive fields pass through unchanged (mouse coords, op, button…).
fn redact_params(params: &Value) -> Value {
    let mut out = params.clone();
    if let Some(obj) = out.as_object_mut() {
        for &field in SENSITIVE_FIELDS {
            if let Some(s) = obj.get(field).and_then(Value::as_str) {
                let redacted = json!({ "len": s.chars().count(), "sha256": sha256_hex(s) });
                obj.insert(field.to_string(), redacted);
            }
        }
    }
    out
}

/// Build the redacted audit record. This is the ONLY constructor of an audit
/// line, and it always redacts — there is no unredacted path to forget.
fn audit_record(action: &str, target: &KvmTarget, params: &Value, envelope: &Value) -> Value {
    let mut auth = serde_json::Map::new();
    if target.auth.token.is_some() {
        // Presence marker only — never the value.
        auth.insert("token".to_string(), json!("<redacted>"));
    }
    if let Some(p) = &target.auth.ssh_key_path {
        // Path is safe to record; the key file's contents are never read.
        auth.insert("sshKeyPath".to_string(), json!(p));
    }
    json!({
        "ts": chrono::Utc::now().to_rfc3339(),
        "action": action,
        "host": target.host,
        "port": target.port,
        "transport": target.transport,
        "auth": Value::Object(auth),
        "params": redact_params(params),
        "ok": envelope.get("ok").and_then(Value::as_bool).unwrap_or(false),
        "error": envelope.get("error").cloned().unwrap_or(Value::Null),
    })
}

fn audit_log_path() -> Option<PathBuf> {
    crate::paths::user_data_root().map(|r| r.join("kvm_audit.jsonl"))
}

/// Append-only JSONL writer (create-if-missing, O_APPEND) — the same
/// append-once-per-event shape as the fleet log trail.
fn append_audit_line(path: &Path, record: &Value) -> std::io::Result<()> {
    use std::io::Write;
    let line = serde_json::to_string(record)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(f, "{line}")
}

/// Write one redacted audit line for this action. Best-effort: a missing app
/// data dir must not swallow the command's result, but any failure is surfaced
/// to stderr (never silent).
fn audit(action: &str, target: &KvmTarget, params: &Value, envelope: &Value) {
    let record = audit_record(action, target, params, envelope);
    match audit_log_path() {
        Some(path) => {
            if let Err(e) = append_audit_line(&path, &record) {
                eprintln!("kvm audit write failed ({}): {e}", path.display());
            }
        }
        None => eprintln!("kvm audit skipped: could not resolve app data dir"),
    }
}

// ------------------------------------------------------------------
// Transport — Phase-1 stubs
// ------------------------------------------------------------------

/// Phase 1 has no live websocket/HID bodies. Locking SESSION mirrors the
/// mcp.rs / browser.rs session pattern; it is always empty in slice 1, so
/// every connected action reports a clear "not connected" error.
async fn transport_stub(action: &str) -> Value {
    let _guard = SESSION.lock().await;
    env_err(action, "not connected — Phase 1")
}

/// Dispatch by action string, validating required params (helpful 4xx-style
/// errors, never a panic). Screenshot returns the {ok,imagePath,width,height}
/// shape once connected; in slice 1 it stops at the transport stub.
async fn dispatch(action: &str, params: &Value) -> Value {
    match action {
        "screenshot" => transport_stub(action).await,
        "type" => match params.get("text").and_then(Value::as_str) {
            Some(_) => transport_stub(action).await,
            None => env_err(action, "missing string field 'text' in params"),
        },
        "keys" => match params.get("combo").and_then(Value::as_str) {
            Some(_) => transport_stub(action).await,
            None => env_err(action, "missing string field 'combo' in params"),
        },
        "mouse" => match params.get("op").and_then(Value::as_str) {
            Some(_) => transport_stub(action).await,
            None => env_err(action, "missing string field 'op' in params"),
        },
        "boot_key" => match params.get("key").and_then(Value::as_str) {
            Some(_) => transport_stub(action).await,
            None => env_err(action, "missing string field 'key' in params"),
        },
        "mount_iso" | "power" => env_err(action, "not implemented in slice 1"),
        other => env_err(other, &format!("unknown action '{other}'")),
    }
}

// ------------------------------------------------------------------
// Tauri commands
// ------------------------------------------------------------------

/// Execute one OWLLM Node action against `target`.
///
/// Order of enforcement: (1) feature flag → hard error if OFF; (2) consent gate
/// (fail-closed for injection, screenshot exempt); (3) dispatch; (4) audit the
/// outcome as one redacted JSONL line. Always returns Ok(envelope) once the
/// flag is on — errors are carried in the envelope, not as a panic/500.
#[tauri::command]
pub async fn kvm_node_exec(
    target: KvmTarget,
    action: String,
    params: Value,
) -> Result<Value, String> {
    if !feature_enabled() {
        return Err(
            "OWLLM Node is disabled. Set OWLLM_KVM_NODE=1 to enable (default off).".to_string(),
        );
    }

    let envelope = if consent_allowed(&action, &target.host, &load_consent()) {
        dispatch(&action, &params).await
    } else {
        // Fail-closed: an injection action against an ungranted host is refused
        // regardless of the feature flag.
        env_err(&action, "unconsented target")
    };

    audit(&action, &target, &params, &envelope);
    Ok(envelope)
}

/// Grant or revoke consent for injection actions against `host`.
#[tauri::command]
pub fn kvm_node_consent(host: String, grant: bool) -> Result<Value, String> {
    if host.trim().is_empty() {
        return Err("missing field 'host'".to_string());
    }
    save_consent(&host, grant)?;
    Ok(json!({ "ok": true, "host": host, "granted": grant }))
}

// ------------------------------------------------------------------
// Tests — the enforced slice-1 guarantees
// ------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn secret_target() -> KvmTarget {
        KvmTarget {
            host: "10.0.0.5".to_string(),
            port: Some(443),
            auth: KvmAuth {
                ssh_key_path: Some("/home/user/.ssh/id_rsa".to_string()),
                token: Some("SUPER_SECRET_TOKEN".to_string()),
            },
            transport: "websocket".to_string(),
        }
    }

    #[test]
    fn redaction_hides_token_and_keystrokes_but_keeps_key_path() {
        let target = secret_target();
        let params = json!({ "text": "hunter2 my password" });
        let envelope = env_err("type", "not connected — Phase 1");
        let line = serde_json::to_string(&audit_record("type", &target, &params, &envelope)).unwrap();

        // Secrets never appear verbatim.
        assert!(!line.contains("SUPER_SECRET_TOKEN"), "token leaked: {line}");
        assert!(!line.contains("hunter2"), "keystroke text leaked: {line}");
        // Token is present only as the redaction marker.
        assert!(line.contains("<redacted>"), "missing token marker: {line}");
        // sshKeyPath keeps the PATH (never file contents).
        assert!(line.contains("/home/user/.ssh/id_rsa"), "key path missing: {line}");
        // Keystroke recorded as {len, sha256}.
        assert!(line.contains("\"len\""), "missing len: {line}");
        assert!(line.contains("\"sha256\""), "missing sha256: {line}");
        assert!(
            line.contains(&sha256_hex("hunter2 my password")),
            "sha256 of the keystroke should be present: {line}"
        );
    }

    #[test]
    fn redaction_covers_every_sensitive_field_by_name() {
        // A future action reusing these field names is redacted automatically.
        let params = json!({
            "combo": "ctrl+alt+del",
            "key": "F12",
            "password": "letmein",
            "token": "abc123",
            "op": "click",          // non-sensitive — must pass through
            "x": 10, "y": 20,
        });
        let red = redact_params(&params);
        for f in ["combo", "key", "password", "token"] {
            assert!(red[f].get("sha256").is_some(), "field {f} not redacted: {red}");
        }
        assert_eq!(red["op"], json!("click"), "non-sensitive field mangled");
        assert_eq!(red["x"], json!(10));
    }

    #[test]
    fn consent_fails_closed_on_unlisted_host() {
        let granted = HashSet::new(); // nothing granted
        assert!(
            !consent_allowed("type", "1.2.3.4", &granted),
            "injection on an unlisted host must be refused"
        );
        for action in ["keys", "mouse", "boot_key", "mount_iso", "power"] {
            assert!(!consent_allowed(action, "1.2.3.4", &granted), "{action} should fail closed");
        }
    }

    #[test]
    fn consent_allows_injection_on_granted_host() {
        let mut granted = HashSet::new();
        granted.insert("1.2.3.4".to_string());
        assert!(consent_allowed("type", "1.2.3.4", &granted));
        // A different host is still refused.
        assert!(!consent_allowed("type", "9.9.9.9", &granted));
    }

    #[test]
    fn screenshot_bypasses_consent() {
        let granted = HashSet::new(); // empty allowlist
        assert!(
            consent_allowed("screenshot", "never-granted-host", &granted),
            "screenshot (read-only eyes) must not require consent"
        );
    }

    #[test]
    fn audit_line_is_appended_to_disk() {
        // Grounds the append-only writer end-to-end without the app data dir.
        let dir = std::env::temp_dir();
        let path = dir.join(format!("kvm_audit_test_{}.jsonl", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let rec = audit_record(
            "screenshot",
            &secret_target(),
            &json!({}),
            &env_err("screenshot", "not connected — Phase 1"),
        );
        append_audit_line(&path, &rec).unwrap();
        append_audit_line(&path, &rec).unwrap();
        let body = std::fs::read_to_string(&path).unwrap();
        assert_eq!(body.lines().count(), 2, "each action appends exactly one line");
        assert!(!body.contains("SUPER_SECRET_TOKEN"), "disk log leaked token");
        let _ = std::fs::remove_file(&path);
    }
}
