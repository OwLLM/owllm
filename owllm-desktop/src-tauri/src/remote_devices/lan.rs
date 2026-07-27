// LAN-direct transport: a small HTTP listener on each device that accepts
// sealed frames from paired peers, and a client that dials a peer's endpoint.
//
// Confidentiality + integrity are END-TO-END (the frame is sealed + signed), so
// the listener speaking plain HTTP is fine — an attacker on the wire, or hitting
// the open port, sees only ciphertext and cannot execute anything without a
// trusted key (every command runs the full authenticate → trust → policy gate
// in handle_incoming). This is the in-repo, no-external-infra path; a WAN relay
// would implement the same Transport contract.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use once_cell::sync::Lazy;
use serde_json::json;

use super::protocol::{PairRequest, SignedEnvelope, WireMessage, WireReply};

const DEFAULT_PORT: u16 = 47771;
const WIRE_PATH: &str = "/owllm-remote/v1";

/// Resolve the local source IPv4 the OS would use to reach `target`, via the UDP
/// "connect + read local_addr" trick (no packets sent). Different targets surface
/// different interfaces: a public IP → the LAN/default-route address; a Tailscale
/// CGNAT address → the overlay (100.x) address when the tailnet is up.
fn source_ip_for(target: &str) -> Option<String> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect(target).ok()?;
    let ip = sock.local_addr().ok()?.ip();
    if ip.is_unspecified() || ip.is_loopback() {
        return None;
    }
    Some(ip.to_string())
}

/// The primary LAN IPv4 (default-route source). Kept for callers that want one.
pub fn local_lan_ip() -> Option<String> {
    source_ip_for("8.8.8.8:80")
}

/// ALL addresses a peer could dial to reach us, most WAN-reachable first:
/// the Tailscale/overlay IP (routing to the CGNAT range only resolves to a 100.x
/// source when the tailnet is up), then the LAN IP. Deduped. This is what makes
/// off-LAN control work over a Tailscale/WireGuard overlay with no relay.
pub fn candidate_ips() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    // Tailscale MagicDNS anycast address — routes over tailscale0 when present.
    if let Some(ip) = source_ip_for("100.100.100.100:80") {
        if !out.contains(&ip) {
            out.push(ip);
        }
    }
    if let Some(ip) = local_lan_ip() {
        if !out.contains(&ip) {
            out.push(ip);
        }
    }
    out
}

/// Candidate "ip:port" endpoints for THIS device's listener (empty if not up).
pub fn candidate_endpoints() -> Vec<String> {
    match current_port() {
        Some(port) => candidate_ips()
            .into_iter()
            .map(|ip| format!("{ip}:{port}"))
            .collect(),
        None => Vec::new(),
    }
}

struct ListenerState {
    port: Option<u16>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

static LISTENER: Lazy<Mutex<ListenerState>> = Lazy::new(|| {
    Mutex::new(ListenerState {
        port: None,
        stop: Arc::new(AtomicBool::new(false)),
        thread: None,
    })
});

/// The port this device's listener is bound to, if running.
pub fn current_port() -> Option<u16> {
    LISTENER.lock().unwrap().port
}

/// The PRIMARY ("ip:port") endpoint — the first (most WAN-reachable) candidate.
/// None if the listener isn't running.
pub fn current_endpoint() -> Option<String> {
    candidate_endpoints().into_iter().next()
}

/// Start the listener (idempotent). Binds the default port, falling back to an
/// ephemeral one if taken, and returns the primary "ip:port" endpoint.
pub fn start(rt: tokio::runtime::Handle) -> Result<String, String> {
    {
        let st = LISTENER.lock().unwrap();
        if st.port.is_some() {
            drop(st);
            return current_endpoint().ok_or_else(|| "listener up but no address".to_string());
        }
    }
    let server = tiny_http::Server::http(("0.0.0.0", DEFAULT_PORT))
        .or_else(|_| tiny_http::Server::http(("0.0.0.0", 0)))
        .map_err(|e| format!("bind remote-devices listener: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or_else(|| "listener has no IP addr".to_string())?;

    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();
    let thread = std::thread::Builder::new()
        .name("owllm-remote-devices-listener".into())
        .spawn(move || serve_loop(server, stop_thread, rt))
        .map_err(|e| format!("spawn listener thread: {e}"))?;

    {
        let mut st = LISTENER.lock().unwrap();
        st.port = Some(port);
        st.stop = stop;
        st.thread = Some(thread);
    }
    current_endpoint().ok_or_else(|| format!("listener bound :{port} but no routable IP"))
}

/// Stop the listener (idempotent). Signals the loop and joins it.
pub fn stop() {
    let (stop, thread) = {
        let mut st = LISTENER.lock().unwrap();
        st.port = None;
        (st.stop.clone(), st.thread.take())
    };
    stop.store(true, Ordering::SeqCst);
    if let Some(t) = thread {
        let _ = t.join();
    }
}

fn serve_loop(server: tiny_http::Server, stop: Arc<AtomicBool>, rt: tokio::runtime::Handle) {
    while !stop.load(Ordering::SeqCst) {
        match server.recv_timeout(Duration::from_millis(400)) {
            Ok(Some(req)) => handle_request(req, &rt),
            Ok(None) => continue, // timeout → re-check the stop flag
            Err(_) => break,
        }
    }
}

fn respond(req: tiny_http::Request, reply: &WireReply) {
    let body = serde_json::to_string(reply)
        .unwrap_or_else(|_| "{\"type\":\"error\",\"message\":\"encode\"}".into());
    let header =
        tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    let response = tiny_http::Response::from_string(body).with_header(header);
    let _ = req.respond(response);
}

fn handle_request(mut req: tiny_http::Request, rt: &tokio::runtime::Handle) {
    // Only the wire endpoint, only POST.
    if req.url() != WIRE_PATH || req.method() != &tiny_http::Method::Post {
        let _ = req.respond(tiny_http::Response::from_string("not found").with_status_code(404));
        return;
    }
    let mut body = String::new();
    if req.as_reader().read_to_string(&mut body).is_err() {
        respond(
            req,
            &WireReply::Error {
                message: "unreadable body".into(),
            },
        );
        return;
    }
    let msg: WireMessage = match serde_json::from_str(&body) {
        Ok(m) => m,
        Err(e) => {
            respond(
                req,
                &WireReply::Error {
                    message: format!("bad wire message: {e}"),
                },
            );
            return;
        }
    };
    let reply = match msg {
        WireMessage::Pair(pr) => handle_pair(pr),
        WireMessage::Command(frame) => handle_command(frame, rt),
    };
    respond(req, &reply);
}

/// A pairing request: verify the sender actually holds the key it presents, and
/// that the claimed id matches that key, then record it as Pending (a human on
/// this machine must still approve).
pub(super) fn handle_pair(pr: PairRequest) -> WireReply {
    if !super::feature_enabled() {
        return WireReply::Error {
            message: "remote device control is disabled on this machine".into(),
        };
    }
    let expected_id = super::crypto::device_id_from_ed_pub_b64(&pr.from.ed25519_pub);
    if expected_id.as_deref() != Some(pr.from.device_id.as_str()) {
        return WireReply::Error {
            message: "device id does not match ed25519 key".into(),
        };
    }
    if super::crypto::verify_detached(
        &pr.from.ed25519_pub,
        &PairRequest::signed_bytes(&pr.from),
        &pr.sig,
    )
    .is_err()
    {
        return WireReply::Error {
            message: "pairing signature invalid".into(),
        };
    }
    // Record the requester in the registry (so it shows up) + the trust queue.
    let _ = super::registry::upsert(pr.from.clone(), false);
    match super::trust::record_pairing_request(
        &pr.from.device_id,
        &pr.from.name,
        &pr.from.ed25519_pub,
        &pr.from.x25519_pub,
    ) {
        Ok(()) => {
            // Same-GitHub-account devices (proven via the private vault repo)
            // are auto-approved with the standard grant — no human needed at
            // THIS keyboard. Unverified requesters stay Pending as before.
            let _ = super::ensure_vault_autotrust(
                &pr.from.device_id,
                &pr.from.name,
                &pr.from.ed25519_pub,
                &pr.from.x25519_pub,
            );
            super::emit_pairing();
            // Return OUR public record so the controller learns our keys/id.
            match super::self_public_record() {
                Ok(device) => WireReply::Paired { device },
                Err(e) => WireReply::Error { message: e },
            }
        }
        Err(e) => WireReply::Error { message: e },
    }
}

/// A sealed command: run it through the full inbound pipeline, then seal the
/// result BACK to the controller (using its authenticated static X25519 key from
/// the frame) so the LAN return path is end-to-end encrypted too.
fn handle_command(frame: SignedEnvelope, rt: &tokio::runtime::Handle) -> WireReply {
    // Keep the controller's reply key before the frame is consumed.
    let reply_to_device = frame.from_device.clone();
    let reply_to_x = frame.from_x25519_pub.clone();

    let result = rt.block_on(super::handle_incoming(frame));
    let result = match result {
        Ok(r) => r,
        Err(e) => return WireReply::Error { message: e },
    };

    match super::seal_result_for(&reply_to_device, &reply_to_x, &result) {
        Ok(sealed) => WireReply::Result(sealed),
        Err(e) => WireReply::Error { message: e },
    }
}

/// Controller-side: POST a wire message to a peer endpoint and read the reply.
/// A short connect timeout means an unreachable candidate fails fast (so the
/// controller can try the next address), while the overall timeout still allows
/// a slow command to finish.
pub async fn post_wire(endpoint: &str, msg: &WireMessage) -> Result<WireReply, String> {
    let url = format!("http://{endpoint}{WIRE_PATH}");
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = client
        .post(&url)
        .json(msg)
        .send()
        .await
        .map_err(|e| format!("reach {endpoint}: {e}"))?;
    resp.json::<WireReply>()
        .await
        .map_err(|e| format!("decode reply from {endpoint}: {e}"))
}

/// Send a pairing request to a peer endpoint (controller side). Returns the
/// peer's public record so the caller can add it to the registry.
pub async fn send_pair(
    endpoint: &str,
    pr: PairRequest,
) -> Result<super::protocol::DevicePublic, String> {
    match post_wire(endpoint, &WireMessage::Pair(pr)).await? {
        WireReply::Paired { device } => Ok(device),
        WireReply::Error { message } => Err(message),
        WireReply::Result(_) => Err("unexpected Result reply to a pairing request".into()),
    }
}

/// Listener status for the UI.
pub fn status_json() -> serde_json::Value {
    json!({
        "listening": current_port().is_some(),
        "endpoint": current_endpoint(),
        "endpoints": candidate_endpoints(),
    })
}
