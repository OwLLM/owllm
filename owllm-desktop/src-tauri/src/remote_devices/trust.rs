// The trust store: which controller device keys THIS machine has paired with,
// their per-controller permission policy, and the pairing queue. This is the
// heart of "GitHub auth is not permission" — a controller is accepted only once
// it is `Trusted` here, and every accept is an explicit human action.
//
// Fail-closed everywhere: unknown, pending, or revoked → no authority.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::protocol::{PermissionPolicy, TrustState, TrustedController};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct TrustFile {
    #[serde(default)]
    controllers: Vec<TrustedController>,
}

fn trust_path() -> Result<PathBuf, String> {
    crate::paths::user_data_root()
        .map(|r| r.join("remote_devices_trust.json"))
        .ok_or_else(|| "could not resolve app data dir for trust store".to_string())
}

fn load_file() -> TrustFile {
    trust_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<TrustFile>(&t).ok())
        .unwrap_or_default()
}

fn save_file(f: &TrustFile) -> Result<(), String> {
    let path = trust_path()?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let txt = serde_json::to_string_pretty(f).map_err(|e| e.to_string())?;
    std::fs::write(&path, txt).map_err(|e| format!("write trust store: {e}"))
}

pub fn list() -> Vec<TrustedController> {
    load_file().controllers
}

pub fn find(device_id: &str) -> Option<TrustedController> {
    load_file()
        .controllers
        .into_iter()
        .find(|c| c.device_id == device_id)
}

/// Record an incoming pairing request. If the controller is already known:
/// - already `Trusted` → left as-is (idempotent re-pair, no downgrade),
/// - otherwise → reset to `Pending` for a fresh human decision.
/// The keys are refreshed from the request so a rotated key re-prompts.
pub fn record_pairing_request(
    device_id: &str,
    name: &str,
    ed25519_pub: &str,
    x25519_pub: &str,
) -> Result<(), String> {
    let mut f = load_file();
    let now = crate::remote_devices::now_rfc3339();
    if let Some(c) = f.controllers.iter_mut().find(|c| c.device_id == device_id) {
        // A key change for an existing controller must NOT silently inherit
        // trust — force it back to Pending unless the key is unchanged.
        let same_key = c.ed25519_pub == ed25519_pub && c.x25519_pub == x25519_pub;
        if !(same_key && c.state == TrustState::Trusted) {
            c.state = TrustState::Pending;
            c.decided_at = None;
        }
        c.name = name.to_string();
        c.ed25519_pub = ed25519_pub.to_string();
        c.x25519_pub = x25519_pub.to_string();
        c.requested_at = now;
    } else {
        f.controllers.push(TrustedController {
            device_id: device_id.to_string(),
            name: name.to_string(),
            ed25519_pub: ed25519_pub.to_string(),
            x25519_pub: x25519_pub.to_string(),
            state: TrustState::Pending,
            policy: PermissionPolicy::default(), // read-only until widened
            requested_at: now,
            decided_at: None,
        });
    }
    save_file(&f)
}

/// Approve a pending controller with an initial policy (defaults to read-only).
pub fn approve(device_id: &str, policy: PermissionPolicy) -> Result<(), String> {
    let mut f = load_file();
    let c = f
        .controllers
        .iter_mut()
        .find(|c| c.device_id == device_id)
        .ok_or_else(|| "no such pairing request".to_string())?;
    c.state = TrustState::Trusted;
    c.policy = policy;
    c.decided_at = Some(crate::remote_devices::now_rfc3339());
    save_file(&f)
}

/// Deny a pending request (marks it Revoked so it fails closed).
pub fn deny(device_id: &str) -> Result<(), String> {
    set_state(device_id, TrustState::Revoked)
}

/// Revoke a previously trusted controller. Takes effect on the next request.
pub fn revoke(device_id: &str) -> Result<(), String> {
    set_state(device_id, TrustState::Revoked)
}

/// Remove a controller entirely (so a future pair re-prompts fresh).
pub fn remove(device_id: &str) -> Result<(), String> {
    let mut f = load_file();
    f.controllers.retain(|c| c.device_id != device_id);
    save_file(&f)
}

fn set_state(device_id: &str, state: TrustState) -> Result<(), String> {
    let mut f = load_file();
    let c = f
        .controllers
        .iter_mut()
        .find(|c| c.device_id == device_id)
        .ok_or_else(|| "no such controller".to_string())?;
    c.state = state;
    c.decided_at = Some(crate::remote_devices::now_rfc3339());
    save_file(&f)
}

/// Update the per-controller policy (only meaningful while Trusted).
pub fn set_policy(device_id: &str, policy: PermissionPolicy) -> Result<(), String> {
    let mut f = load_file();
    let c = f
        .controllers
        .iter_mut()
        .find(|c| c.device_id == device_id)
        .ok_or_else(|| "no such controller".to_string())?;
    c.policy = policy;
    save_file(&f)
}

/// The authoritative gate used on every inbound command: returns the policy
/// ONLY for a controller whose key matches AND whose state is `Trusted`.
/// Anything else (unknown / pending / revoked / key mismatch) → None = refuse.
pub fn authorized_policy(device_id: &str, ed25519_pub: &str) -> Option<PermissionPolicy> {
    let c = find(device_id)?;
    if c.state == TrustState::Trusted && c.ed25519_pub == ed25519_pub {
        Some(c.policy)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // These operate on the real trust file under a temp OWLLM_USER_DATA so they
    // don't touch a developer's actual store. Serialized via the crate-wide test
    // lock (shared with mod.rs) because they mutate the same process env var.
    fn with_temp_store<T>(f: impl FnOnce() -> T) -> T {
        let _g = crate::remote_devices::TEST_ENV_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("OWLLM_USER_DATA", dir.path());
        let out = f();
        std::env::remove_var("OWLLM_USER_DATA");
        out
    }

    #[test]
    fn unknown_controller_is_refused() {
        with_temp_store(|| {
            assert!(authorized_policy("nope", "k").is_none());
        });
    }

    #[test]
    fn pending_then_approved_then_revoked() {
        with_temp_store(|| {
            record_pairing_request("dev1", "Laptop", "EDPUB", "XPUB").unwrap();
            // Pending → still refused.
            assert!(authorized_policy("dev1", "EDPUB").is_none());

            let mut pol = PermissionPolicy::default();
            pol.allow_shell = true;
            approve("dev1", pol).unwrap();
            let got = authorized_policy("dev1", "EDPUB").expect("trusted");
            assert!(got.allow_shell);

            // A different key for the same id is refused (key mismatch).
            assert!(authorized_policy("dev1", "OTHERKEY").is_none());

            revoke("dev1").unwrap();
            assert!(authorized_policy("dev1", "EDPUB").is_none());
        });
    }

    #[test]
    fn key_rotation_drops_trust_back_to_pending() {
        with_temp_store(|| {
            record_pairing_request("dev2", "PC", "K1", "X1").unwrap();
            approve("dev2", PermissionPolicy::default()).unwrap();
            assert!(authorized_policy("dev2", "K1").is_some());
            // Same id re-pairs with a NEW key → must fall back to Pending.
            record_pairing_request("dev2", "PC", "K2", "X2").unwrap();
            assert!(authorized_policy("dev2", "K2").is_none());
        });
    }
}
