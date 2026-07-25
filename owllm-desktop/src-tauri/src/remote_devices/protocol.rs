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
    /// Primary listen endpoint ("ip:port") — kept for back-compat. `endpoints`
    /// is the full candidate list; this mirrors its first entry.
    #[serde(default)]
    pub endpoint: Option<String>,
    /// ALL addresses a peer can dial to reach this device's listener, most
    /// WAN-reachable first: a user-set public host, then overlay (Tailscale/VPN)
    /// IPs, then LAN IPs. The controller tries each until one connects — this is
    /// what makes control work off-LAN (over a Tailscale/WireGuard overlay or a
    /// port-forwarded/DDNS host). Metadata only; control still needs a paired key.
    #[serde(default)]
    pub endpoints: Vec<String>,
    /// True if this device is reachable via a shared relay (for pure-NAT peers
    /// with no overlay/port-forward). The relay only ever forwards ciphertext.
    #[serde(default)]
    pub relay: bool,
    /// Embedded P2P (iroh) endpoint id — lets peers dial this device through the
    /// built-in hole-punching transport when no direct address works. No account
    /// or network setup required; still metadata only (control needs a paired key).
    #[serde(default)]
    pub p2p_node_id: Option<String>,
    /// Public heartbeat stamped when this device publishes its vault record.
    /// Metadata only; it does not authorize control. Older app versions ignore
    /// this unknown JSON field when they read records written by newer builds.
    #[serde(default)]
    pub published_at: Option<String>,
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
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandKind {
    /// Read-only device diagnostics. Always allowed. No side effects.
    #[default]
    Diagnostics,
    /// Run a shell command on the host. Gated by `allow_shell`.
    Shell,
    /// Run a command inside WSL (Windows targets). Gated by `allow_wsl`.
    Wsl,
    /// Write/modify files. Gated by `allow_file_writes` AND per-action approval.
    FileWrite,
    /// Admin / system change. Gated by `allow_admin` AND per-action approval.
    Admin,
    /// Open an interactive PTY shell session (SSH-like). Gated by `allow_shell`.
    SessionOpen,
    /// Send keystrokes to an open session. Gated by `allow_shell`.
    SessionWrite,
    /// Drain buffered output from an open session. Gated by `allow_shell`.
    SessionRead,
    /// Resize an open session's PTY. Gated by `allow_shell`.
    SessionResize,
    /// Close an open session. Gated by `allow_shell`.
    SessionClose,
    /// Capture the target's primary screen and return a PNG. Privacy-sensitive,
    /// so gated by `allow_shell` (a controller that can run a shell could
    /// screenshot anyway); returns the image in `CommandResult.image`.
    Screenshot,
    /// Proxy one chat-completion request to the target's own local llama-server
    /// (127.0.0.1) and return its response body. Lets a device use another
    /// device's local model over the sealed channel. Gated by `allow_shell`.
    Inference,
    /// Return the target's locally installed, runnable models and current
    /// server status. Read-only, but restricted to the same permission tier as
    /// inference because model inventory is not part of public discovery.
    ModelCatalog,
    /// Start or switch the target's managed local server to a selected model.
    /// This is the explicit remote-inference control surface; it never runs an
    /// arbitrary shell command. Gated by the same policy as inference.
    ModelStart,
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
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CommandRequest {
    pub request_id: String,
    pub kind: CommandKind,
    /// Command text (shell/wsl), the target PATH for a `FileWrite`, or empty for
    /// a plain diagnostics sweep.
    #[serde(default)]
    pub command: String,
    /// base64 file content for `FileWrite`, or base64 keystrokes for
    /// `SessionWrite` (ignored by other kinds).
    #[serde(default)]
    pub payload: Option<String>,
    /// Session id for `SessionWrite`/`SessionRead`/`SessionResize`/`SessionClose`.
    #[serde(default)]
    pub session: Option<String>,
    /// PTY size for `SessionOpen`/`SessionResize`.
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
    /// Hard execution deadline in milliseconds (clamped by the executor).
    #[serde(default)]
    pub timeout_ms: u64,
}

/// What the target returns to the controller (also sealed on the way back, in
/// the network transport; loopback returns it in-process).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
    /// Session id returned by `SessionOpen`.
    #[serde(default)]
    pub session: Option<String>,
    /// base64 PTY output returned by `SessionRead`.
    #[serde(default)]
    pub data: Option<String>,
    /// True when a session's shell has exited (from `SessionRead`/`SessionOpen`).
    #[serde(default)]
    pub exited: bool,
    /// base64 PNG returned by `Screenshot` (a full-frame image, no `data:` prefix).
    #[serde(default)]
    pub image: Option<String>,
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
    /// The sender's STATIC X25519 public key — so the target can seal the reply
    /// back to the controller. Signed (in the header), so it is authenticated.
    pub from_x25519_pub: String,
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
            "owllm-remote-devices-v1\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
            self.from_device,
            self.from_ed25519_pub,
            self.from_x25519_pub,
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

// ------------------------------------------------------------------
// Wire protocol (LAN-direct transport)
// ------------------------------------------------------------------

/// A pairing request sent over the wire: the controller's public record plus a
/// signature proving it holds the matching Ed25519 secret — so no one can
/// register a pairing request under someone else's key.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairRequest {
    pub from: DevicePublic,
    /// base64 Ed25519 signature over `signed_bytes(&from)`.
    pub sig: String,
}

impl PairRequest {
    /// The exact bytes signed — binds the request to the sender's identity keys.
    pub fn signed_bytes(from: &DevicePublic) -> Vec<u8> {
        format!(
            "owllm-remote-devices-pair-v1\n{}\n{}\n{}",
            from.device_id, from.ed25519_pub, from.x25519_pub
        )
        .into_bytes()
    }
}

/// What a controller POSTs to a target's listener.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WireMessage {
    Pair(PairRequest),
    Command(SignedEnvelope),
}

/// The target's reply. `Result` carries the CommandResult SEALED back to the
/// controller (so even the LAN return path is end-to-end encrypted).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WireReply {
    /// Pairing recorded (pending human approval). Carries the target's own public
    /// record so the controller learns its keys/id — this is what lets a manual
    /// "pair by IP" work with no vault discovery.
    Paired {
        device: DevicePublic,
    },
    Result(SignedEnvelope),
    Error {
        message: String,
    },
}

// ------------------------------------------------------------------
// Relay protocol (WAN store-and-forward — the relay sees only ciphertext)
// ------------------------------------------------------------------

/// A wire message dropped at the relay by a controller. `to` routes it to the
/// target's mailbox; `corr` lets the relay hand the reply back to this sender.
/// `frame` is the opaque sealed envelope — the relay cannot read it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayPacket {
    pub to: String,
    pub corr: String,
    pub frame: SignedEnvelope,
}

/// A target's reply flowing back through the relay, matched to the waiting
/// sender by `corr`. `frame` is the sealed CommandResult envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayReply {
    pub corr: String,
    pub frame: SignedEnvelope,
}
