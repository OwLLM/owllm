// Embedded P2P transport (iroh) — the zero-setup off-LAN path.
//
// LAN-direct dies on AP isolation / different networks, the self-hosted relay
// needs a user-run public URL, and an overlay VPN (Tailscale) needs an account
// and a login on every machine. This transport embeds iroh in the app itself:
// QUIC with NAT hole-punching, falling back to n0's free public relay fleet —
// no account, no login, no external daemon. Like every transport it only ever
// carries sealed `WireMessage` frames, so the relays and any on-path node see
// ciphertext-in-ciphertext; the end-to-end security model is unchanged.
//
// The iroh keypair is SEPARATE from the device identity keypair (no key reuse
// across protocols). The endpoint id (`p2p_node_id`) is published in the
// device's public record and syncs to peers through the vault — a peer dials
// it by id alone; discovery + hole punching are iroh's job.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointId, SecretKey};
use once_cell::sync::Lazy;
use rand::{rngs::OsRng, RngCore};

use super::protocol::{CommandResult, DevicePublic, PairRequest, SignedEnvelope, WireMessage, WireReply};
use super::transport::{open_sealed_reply, Transport};

const ALPN: &[u8] = b"owllm/remote-devices/v1";
/// Cap on one wire frame — a FileWrite payload rides base64 inside the sealed
/// envelope, so leave generous room.
const MAX_FRAME: usize = 64 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Ceiling on waiting for the target's reply (long commands run under the
/// executor's own timeout; this only bounds a wedged connection).
const REPLY_TIMEOUT: Duration = Duration::from_secs(180);

// ------------------------------------------------------------------
// Key management — a dedicated iroh keypair, DPAPI-wrapped like the identity
// ------------------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize)]
struct P2pKeyFile {
    /// base64(DPAPI(seed)) — passthrough wrap on non-Windows, matching crypt.rs.
    secret_wrapped: String,
    /// The derived public endpoint id, stored for humans/debugging only.
    node_id: String,
}

fn key_path() -> Result<PathBuf, String> {
    crate::paths::user_data_root()
        .map(|r| r.join("remote_device_p2p_key.json"))
        .ok_or_else(|| "could not resolve app data dir for the p2p key".to_string())
}

fn b64(bytes: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD.encode(bytes)
}

fn unb64(s: &str) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD.decode(s).map_err(|e| format!("base64 decode: {e}"))
}

/// Load the iroh secret key, generating (and persisting) one on first use.
fn load_or_create_secret() -> Result<SecretKey, String> {
    let path = key_path()?;
    if let Ok(txt) = std::fs::read_to_string(&path) {
        if let Ok(f) = serde_json::from_str::<P2pKeyFile>(&txt) {
            if let Ok(raw) = crate::crypt::unprotect(&unb64(&f.secret_wrapped)?) {
                if let Ok(seed) = <[u8; 32]>::try_from(raw.as_slice()) {
                    return Ok(SecretKey::from_bytes(&seed));
                }
            }
        }
    }
    let mut seed = [0u8; 32];
    OsRng.fill_bytes(&mut seed);
    let sk = SecretKey::from_bytes(&seed);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let f = P2pKeyFile {
        secret_wrapped: b64(&crate::crypt::protect(&seed)?),
        node_id: sk.public().to_string(),
    };
    let txt = serde_json::to_string_pretty(&f).map_err(|e| e.to_string())?;
    std::fs::write(&path, txt).map_err(|e| format!("write p2p key: {e}"))?;
    Ok(sk)
}

/// This device's p2p endpoint id (creates the keypair on first call).
pub fn node_id() -> Option<String> {
    load_or_create_secret().ok().map(|sk| sk.public().to_string())
}

/// True when `s` parses as an iroh endpoint id (vs an "ip:port" address).
pub fn looks_like_node_id(s: &str) -> bool {
    s.trim().parse::<EndpointId>().is_ok()
}

// ------------------------------------------------------------------
// Endpoint lifecycle
// ------------------------------------------------------------------

static ENDPOINT: Lazy<tokio::sync::Mutex<Option<Endpoint>>> =
    Lazy::new(|| tokio::sync::Mutex::new(None));
static RUNNING: AtomicBool = AtomicBool::new(false);

pub fn running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

/// Bind the endpoint (idempotent) and spawn the accept loop. Also used by the
/// controller side before dialing — inbound frames are still fully gated by
/// `handle_incoming` (feature flag → trust → policy), so accepting is safe.
pub async fn ensure_running() -> Result<Endpoint, String> {
    let mut g = ENDPOINT.lock().await;
    if let Some(ep) = g.as_ref() {
        return Ok(ep.clone());
    }
    let sk = load_or_create_secret()?;
    let ep = Endpoint::builder(presets::N0)
        .secret_key(sk)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .map_err(|e| format!("p2p bind: {e}"))?;
    let accept_ep = ep.clone();
    tokio::spawn(async move { accept_loop(accept_ep).await });
    RUNNING.store(true, Ordering::SeqCst);
    *g = Some(ep.clone());
    Ok(ep)
}

/// Fire-and-forget start from sync callers (mirrors relay::start_client).
pub fn start(rt: tokio::runtime::Handle) {
    rt.spawn(async {
        if let Err(e) = ensure_running().await {
            eprintln!("remote_devices: p2p start failed: {e}");
        }
    });
}

/// Stop the endpoint. Best-effort: if a bind is racing us the lock is busy and
/// the endpoint stays up — harmless, since every inbound frame is still refused
/// by the feature-flag gate in `handle_incoming` / `handle_pair`.
pub fn stop() {
    if let Ok(mut g) = ENDPOINT.try_lock() {
        if let Some(ep) = g.take() {
            RUNNING.store(false, Ordering::SeqCst);
            if let Ok(h) = tokio::runtime::Handle::try_current() {
                h.spawn(async move { ep.close().await });
            }
            // No runtime → dropping the endpoint closes the socket.
        }
    }
}

// ------------------------------------------------------------------
// Target side — accept loop (one wire exchange per bi-stream)
// ------------------------------------------------------------------

async fn accept_loop(ep: Endpoint) {
    while let Some(incoming) = ep.accept().await {
        tokio::spawn(async move {
            let Ok(conn) = incoming.await else { return };
            while let Ok((mut send, mut recv)) = conn.accept_bi().await {
                let Ok(buf) = recv.read_to_end(MAX_FRAME).await else { break };
                let reply = handle_wire(&buf).await;
                let bytes = serde_json::to_vec(&reply).unwrap_or_default();
                if send.write_all(&bytes).await.is_err() {
                    break;
                }
                let _ = send.finish();
            }
        });
    }
}

/// Decode + dispatch one inbound wire message. Same semantics as the LAN
/// listener: pairing requests go through the signature/id checks, commands run
/// the full inbound pipeline and the result is sealed back to the controller.
async fn handle_wire(buf: &[u8]) -> WireReply {
    let msg: WireMessage = match serde_json::from_slice(buf) {
        Ok(m) => m,
        Err(e) => return WireReply::Error { message: format!("bad wire message: {e}") },
    };
    match msg {
        WireMessage::Pair(pr) => super::lan::handle_pair(pr),
        WireMessage::Command(frame) => {
            // Keep the controller's reply key before the frame is consumed.
            let reply_to_device = frame.from_device.clone();
            let reply_to_x = frame.from_x25519_pub.clone();
            match super::handle_incoming(frame).await {
                Ok(result) => match super::seal_result_for(&reply_to_device, &reply_to_x, &result) {
                    Ok(sealed) => WireReply::Result(sealed),
                    Err(e) => WireReply::Error { message: e },
                },
                Err(e) => WireReply::Error { message: e },
            }
        }
    }
}

// ------------------------------------------------------------------
// Controller side — dial by endpoint id
// ------------------------------------------------------------------

/// Dial a peer's endpoint id, send one wire message, and read the reply.
pub async fn send_wire(node_id: &str, msg: &WireMessage) -> Result<WireReply, String> {
    let id: EndpointId = node_id
        .trim()
        .parse()
        .map_err(|e| format!("bad p2p node id: {e}"))?;
    let ep = ensure_running().await?;
    let conn = tokio::time::timeout(CONNECT_TIMEOUT, ep.connect(id, ALPN))
        .await
        .map_err(|_| "p2p connect timeout — peer offline or unreachable".to_string())?
        .map_err(|e| format!("p2p connect: {e}"))?;
    let (mut send, mut recv) = conn.open_bi().await.map_err(|e| format!("p2p stream: {e}"))?;
    let bytes = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
    send.write_all(&bytes).await.map_err(|e| format!("p2p send: {e}"))?;
    send.finish().map_err(|e| format!("p2p finish: {e}"))?;
    let buf = tokio::time::timeout(REPLY_TIMEOUT, recv.read_to_end(MAX_FRAME))
        .await
        .map_err(|_| "p2p reply timeout".to_string())?
        .map_err(|e| format!("p2p read: {e}"))?;
    conn.close(0u32.into(), b"done");
    serde_json::from_slice(&buf).map_err(|e| format!("decode p2p reply: {e}"))
}

/// Send a pairing request to a peer endpoint id (controller side).
pub async fn send_pair(node_id: &str, pr: PairRequest) -> Result<DevicePublic, String> {
    match send_wire(node_id, &WireMessage::Pair(pr)).await? {
        WireReply::Paired { device } => Ok(device),
        WireReply::Error { message } => Err(message),
        WireReply::Result(_) => Err("unexpected Result reply to a pairing request".into()),
    }
}

/// Embedded P2P transport: deliver a sealed frame over iroh and open the
/// sealed reply. Same contract as every other transport.
pub struct P2pTransport {
    pub node_id: String,
}

impl Transport for P2pTransport {
    async fn deliver(&self, frame: SignedEnvelope) -> Result<CommandResult, String> {
        let reply = send_wire(&self.node_id, &WireMessage::Command(frame)).await?;
        open_sealed_reply(reply)
    }
}
