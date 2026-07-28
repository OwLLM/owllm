// The transport seam. A transport carries a fully sealed + signed
// `SignedEnvelope` from controller to target and returns the target's
// `CommandResult`. Crucially it treats the frame as OPAQUE — it never sees or
// needs the plaintext, so no transport (relay included) is trusted.
//
// v1 ships `LoopbackTransport` (in-process): it hands the frame straight to this
// machine's own inbound handler. That is enough to exercise the entire
// sign → seal → route → open → verify → authorize → execute → audit pipeline in
// tests and to drive a real self-controlled session from the UI with zero
// network.
//
// The production `RelayTransport` (an OwLLM WebSocket relay forwarding ciphertext
// between devices) and an optional `SshTransport` compatibility mode implement
// the SAME `Transport` contract. Because they only move `frame` bytes, swapping
// them in changes NONE of the security properties. (Reply confidentiality on a
// real wire is the relay's concern: it will seal the CommandResult back to the
// controller's key; loopback needs no wire protection because nothing leaves the
// process.)

use super::protocol::{CommandResult, SignedEnvelope, WireReply};

/// The abstraction every transport implements.
#[allow(async_fn_in_trait)]
pub trait Transport {
    /// Deliver an opaque sealed frame and return the target's result.
    async fn deliver(&self, frame: SignedEnvelope) -> Result<CommandResult, String>;
}

/// In-process transport used for self-control and tests. Routes the frame to the
/// local inbound handler.
pub struct LoopbackTransport;

impl Transport for LoopbackTransport {
    async fn deliver(&self, frame: SignedEnvelope) -> Result<CommandResult, String> {
        super::handle_incoming(frame).await
    }
}

/// LAN-direct transport: POST the sealed frame to a peer's listener and open the
/// sealed reply. The peer is reached over plain HTTP because the frame — and the
/// reply — are end-to-end sealed; the wire carries only ciphertext.
pub struct LanDirectTransport {
    pub endpoint: String,
}

impl Transport for LanDirectTransport {
    async fn deliver(&self, frame: SignedEnvelope) -> Result<CommandResult, String> {
        let reply = super::lan::post_wire(
            &self.endpoint,
            &super::protocol::WireMessage::Command(frame),
        )
        .await?;
        open_sealed_reply(reply)
    }
}

/// Open a wire reply carrying a sealed CommandResult with THIS device's X25519
/// secret. Shared by every network transport (LAN-direct, embedded P2P).
pub(super) fn open_sealed_reply(reply: WireReply) -> Result<CommandResult, String> {
    match reply {
        WireReply::Result(sealed) => {
            let me = super::identity::load_or_create()?;
            let pt = super::crypto::open(&sealed, &me.secrets.x25519_secret)?;
            serde_json::from_slice(&pt).map_err(|e| format!("bad sealed result: {e}"))
        }
        WireReply::Error { message } => Err(message),
        WireReply::Paired { .. } => Err("unexpected Paired reply to a command".into()),
    }
}
