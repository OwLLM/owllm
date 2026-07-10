// Persistent device identity: the Ed25519 + X25519 keypair generated once per
// install. The secrets are DPAPI-wrapped at rest on Windows (passthrough on
// other OSes, matching crypt.rs) and are NEVER synced. Only the public halves,
// id, name, and capabilities are shareable.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::crypto::DeviceSecrets;
use super::protocol::{Capabilities, DevicePublic};

/// On-disk identity file. Secret fields hold base64(DPAPI(seed)).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct IdentityFile {
    device_id: String,
    name: String,
    created_at: String,
    ed25519_secret_wrapped: String,
    x25519_secret_wrapped: String,
    ed25519_pub: String,
    x25519_pub: String,
}

/// The live identity: secrets in memory + the user-facing name.
pub struct Identity {
    pub secrets: DeviceSecrets,
    pub name: String,
    pub created_at: String,
}

fn identity_path() -> Result<PathBuf, String> {
    crate::paths::user_data_root()
        .map(|r| r.join("remote_device_identity.json"))
        .ok_or_else(|| "could not resolve app data dir for device identity".to_string())
}

fn b64(bytes: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD.encode(bytes)
}

fn unb64(s: &str) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD.decode(s).map_err(|e| format!("base64 decode: {e}"))
}

fn wrap_secret(seed: &[u8; 32]) -> Result<String, String> {
    // crypt::protect = DPAPI on Windows, passthrough elsewhere.
    Ok(b64(&crate::crypt::protect(seed)?))
}

fn unwrap_secret(wrapped: &str, what: &str) -> Result<[u8; 32], String> {
    let raw = crate::crypt::unprotect(&unb64(wrapped)?)?;
    raw.try_into().map_err(|_| format!("{what}: unwrapped key not 32 bytes"))
}

/// Best-effort machine name for the default device name.
fn machine_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "This OwLLM PC".to_string())
}

/// Load the identity, creating (and persisting) a fresh keypair on first use.
pub fn load_or_create() -> Result<Identity, String> {
    let path = identity_path()?;
    if let Ok(txt) = std::fs::read_to_string(&path) {
        if let Ok(f) = serde_json::from_str::<IdentityFile>(&txt) {
            let secrets = DeviceSecrets {
                ed25519_seed: unwrap_secret(&f.ed25519_secret_wrapped, "ed25519")?,
                x25519_secret: unwrap_secret(&f.x25519_secret_wrapped, "x25519")?,
            };
            // Guard against a corrupted/edited id that no longer matches the key.
            if secrets.device_id() == f.device_id {
                return Ok(Identity { secrets, name: f.name, created_at: f.created_at });
            }
        }
    }
    // First run (or unreadable) → generate + persist.
    let secrets = DeviceSecrets::generate();
    let created_at = crate::remote_devices::now_rfc3339();
    let ident = Identity { secrets, name: machine_name(), created_at };
    write_identity(&ident)?;
    Ok(ident)
}

fn write_identity(id: &Identity) -> Result<(), String> {
    let path = identity_path()?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let f = IdentityFile {
        device_id: id.secrets.device_id(),
        name: id.name.clone(),
        created_at: id.created_at.clone(),
        ed25519_secret_wrapped: wrap_secret(&id.secrets.ed25519_seed)?,
        x25519_secret_wrapped: wrap_secret(&id.secrets.x25519_secret)?,
        ed25519_pub: b64(&id.secrets.ed25519_public()),
        x25519_pub: b64(&id.secrets.x25519_public()),
    };
    let txt = serde_json::to_string_pretty(&f).map_err(|e| e.to_string())?;
    std::fs::write(&path, txt).map_err(|e| format!("write device identity: {e}"))
}

/// Rename this device (cosmetic — does not touch the keypair or id).
pub fn set_name(name: &str) -> Result<(), String> {
    let mut id = load_or_create()?;
    id.name = name.trim().to_string();
    if id.name.is_empty() {
        id.name = machine_name();
    }
    write_identity(&id)
}

/// Detected capabilities of THIS device (informational; the real gate is the
/// target's per-controller policy, never this).
pub fn capabilities() -> Capabilities {
    Capabilities {
        shell: true,
        wsl: wsl_available(),
    }
}

fn wsl_available() -> bool {
    #[cfg(windows)]
    {
        crate::wsl::best_linux_distro().is_some()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// The shareable public identity of this device.
pub fn public_record(github_login: Option<String>) -> Result<DevicePublic, String> {
    let id = load_or_create()?;
    Ok(DevicePublic {
        device_id: id.secrets.device_id(),
        name: id.name,
        ed25519_pub: b64(&id.secrets.ed25519_public()),
        x25519_pub: b64(&id.secrets.x25519_public()),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        github_login,
        capabilities: capabilities(),
        // All addresses peers can dial (LAN + overlay). mod::self_public_record
        // decorates this with the user-set public endpoint + relay flag.
        endpoint: super::lan::current_endpoint(),
        endpoints: super::lan::candidate_endpoints(),
        relay: false,
    })
}
