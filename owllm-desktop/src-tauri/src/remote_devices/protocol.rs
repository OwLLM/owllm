// Wire + storage types shared across the remote_devices module.
//
// These are the FROZEN v1 shapes. The controller and target both speak these;
// the transport carries only `SignedEnvelope` bytes (opaque ciphertext to it).

use serde::{Deserialize, Serialize};

// ------------------------------------------------------------------
// Device identity (public half) + registry record
// ------------------------------------------------------------------

/// The PUBLIC identity of a device — safe to share/sync. `device_id` is
/// `hex(SHA-256(ed25519_pub))`, so it is bound to the signing key and cannot be
/// spoofed independently of it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DevicePublic {
    pub device_id: String,
    pub name: String,
    /// base64 Ed25519 public key (identity + signature verification).
    pub ed25519_pub: String,
    /// base64 X25519 static public key (command bodies are sealed TO this).
    pub x25519_pub: String,
    pub os: String,
    pub arch: String,
    pub app_version: String,
    #[serde(default)]
    pub github_login: Option<String>,
    #[serde(default)]
    pub capabilities: Capabilities,
}

/// What a device can do — advertised to peers, informational (the real gate is
/// the target's per-controller `PermissionPolicy`, never this).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Capabilities {
    pub shell: bool,
    pub wsl: bool,
}

/// A known peer as stored in the local registry. Adds device-local liveness
/// fields to the public record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceRecord {
    #[serde(flatten)]
    pub public: DevicePublic,
    /// RFC3339 of the last frame we saw from this device (None = never).
    #[serde(default)]
    pub last_seen: Option<String>,
    /// True when this record is THIS machine.
    #[serde(default)]
    pub is_self: bool,
}

// ------------------------------------------------------------------
// Permission policy — the four toggles, read-only by default
// ------------------------------------------------------------------

/// Per-controller capability grant held by the TARGET. Default = all false =
/// read-only diagnostics only. There is no "allow everything" shortcut on
/// purpose; each dangerous surface is opted into individually.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PermissionPolicy {
    #[serde(default)]
    pub allow_shell: bool,
    #[serde(default)]
    pub allow_wsl: bool,
    #[serde(default)]
    pub allow_file_writes: bool,
    #[serde(default)]
    pub allow_admin: bool,
}

/// The kinds of command a controller can ask a target to run. New dangerous
/// kinds MUST be added to `policy::authorize` (which is exhaustive-matched) or
/// the build fails — you cannot forget to gate one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandKind {
    /// Read-only device diagnostics. Always allowed. No side effects.
    Diagnostics,
    /// Run a shell command on the host. Gated by `allow_shell`.
    Shell,
    /// Run a command inside WSL (Windows targets). Gated by `allow_wsl`.
    Wsl,
    /// Write/modify files. Gated by `allow_file_writes` AND per-action approval.
    FileWrite,
    /// Admin / system change. Gated by `allow_admin` AND per-action approval.
    Admin,
}

/// The decision `authorize()` returns. `RequiresApproval` means the policy
/// permits the *class* of action but a fresh target-side human approval is
/// still required before it runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Authorization {
    Allowed,
    RequiresApproval,
    Denied,
}

// ------------------------------------------------------------------
// Command request / result (the sealed payload)
// ------------------------------------------------------------------

/// The plaintext a controller seals inside an envelope. `request_id` is echoed
/// in the result and used as the cancellation handle.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandRequest {
    pub request_id: String,
    pub kind: CommandKind,
    /// Command text (shell/wsl) or a diagnostics selector. Empty for a plain
    /// diagnostics sweep.
    #[serde(default)]
    pub command: String,
    /// Hard execution deadline in milliseconds (clamped by the executor).
    #[serde(default)]
    pub timeout_ms: u64,
}

/// What the target returns to the controller (also sealed on the way back, in
/// the network transport; loopback returns it in-process).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandResult {
    pub request_id: String,
    pub ok: bool,
    #[serde(default)]
    pub stdout: String,
    #[serde(default)]
    pub stderr: String,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub error: Option<String>,
    /// The authorization decision the target reached (for the controller's log).
    pub decision: String,
    pub duration_ms: u64,
}

// ------------------------------------------------------------------
// Sealed, signed envelope — the ONLY thing the transport carries
// ------------------------------------------------------------------

/// End-to-end sealed + signed command. The transport treats this as opaque
/// bytes; only the target's X25519 secret opens the body and only the
/// controller's Ed25519 secret could have produced `sig`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedEnvelope {
    pub from_device: String,
    pub from_ed25519_pub: String,
    pub to_device: String,
    /// Unix seconds — freshness window (±120s) rejects stale/pre-recorded frames.
    pub ts: i64,
    /// base64 random 24 bytes — replay guard within the freshness window.
    pub nonce: String,
    /// base64 ephemeral X25519 public key for this one message.
    pub eph_x25519_pub: String,
    /// base64 AES-256-GCM nonce (12 bytes).
    pub gcm_nonce: String,
    /// base64 AES-256-GCM ciphertext of the `CommandRequest` JSON.
    pub ciphertext: String,
    /// base64 Ed25519 signature over the canonical header (commits to everything
    /// above including the ciphertext).
    pub sig: String,
}

impl SignedEnvelope {
    /// Associated data bound into the AEAD tag — every header field EXCEPT the
    /// ciphertext (which is the encryption output, so it can't be an input).
    /// Order is fixed here: it is the wire contract, not serde's whim. Moving a
    /// ciphertext to a different header changes the AAD and fails the tag.
    pub fn aad(&self) -> Vec<u8> {
        format!(
            "owllm-remote-devices-v1\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
            self.from_device,
            self.from_ed25519_pub,
            self.to_device,
            self.ts,
            self.nonce,
            self.eph_x25519_pub,
            self.gcm_nonce,
        )
        .into_bytes()
    }

    /// The exact bytes the Ed25519 signature covers: the AAD PLUS the ciphertext.
    /// So the signature commits to the entire frame (header + sealed body), and
    /// any tamper — including swapping the ciphertext — breaks verification.
    pub fn canonical_header(&self) -> Vec<u8> {
        let mut v = self.aad();
        v.push(b'\n');
        v.extend_from_slice(self.ciphertext.as_bytes());
        v
    }
}

// ------------------------------------------------------------------
// Trust store shapes
// ------------------------------------------------------------------

/// Lifecycle of a controller in the target's trust store.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustState {
    /// A pairing request arrived; awaiting the human's approve/deny.
    Pending,
    /// Approved — commands are accepted subject to `PermissionPolicy`.
    Trusted,
    /// Explicitly revoked/denied — fails closed on the next request.
    Revoked,
}

/// One controller the target knows about.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustedController {
    pub device_id: String,
    pub name: String,
    pub ed25519_pub: String,
    pub x25519_pub: String,
    pub state: TrustState,
    #[serde(default)]
    pub policy: PermissionPolicy,
    /// RFC3339 first-seen / request time.
    pub requested_at: String,
    #[serde(default)]
    pub decided_at: Option<String>,
}
