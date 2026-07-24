// WAN relay — store-and-forward for peers with no LAN and no overlay/port-forward.
//
// Both devices connect OUT to a shared relay (outbound works through any NAT), so
// no inbound reachability is required. The relay is UNTRUSTED: it only ever moves
// opaque sealed frames between mailboxes and matches replies by correlation id —
// it can't read, forge, or replay a command (that's all enforced end-to-end by
// the sealed envelope + the target's handle_incoming pipeline).
//
// Three parts:
//   * RelayTransport  — controller side: POST a sealed frame, await the sealed reply.
//   * client loop      — target side: long-poll for inbound frames, run them, reply.
//   * serve()          — the relay itself: any user hosts it (e.g. an always-on
//                        OwLLM box with a public URL / tunnel). Pure ciphertext relay.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use rand::{rngs::OsRng, RngCore};

use super::protocol::{CommandResult, RelayPacket, RelayReply, SignedEnvelope};
use super::transport::Transport;

const POLL_WAIT: Duration = Duration::from_secs(25); // target long-poll window
const SEND_WAIT: Duration = Duration::from_secs(120); // controller wait for a reply

fn corr_id() -> String {
    let mut b = [0u8; 16];
    OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(timeout)
        .build()
        .map_err(|e| format!("http client: {e}"))
}

// ==================================================================
// Controller side — RelayTransport
// ==================================================================

pub struct RelayTransport {
    pub url: String,
}

impl Transport for RelayTransport {
    async fn deliver(&self, frame: SignedEnvelope) -> Result<CommandResult, String> {
        let pkt = RelayPacket {
            to: frame.to_device.clone(),
            corr: corr_id(),
            frame,
        };
        let client = http_client(SEND_WAIT + Duration::from_secs(15))?;
        let resp = client
            .post(format!("{}/relay/v1/send", self.url.trim_end_matches('/')))
            .json(&pkt)
            .send()
            .await
            .map_err(|e| format!("relay send: {e}"))?;
        if resp.status().as_u16() == 504 {
            return Err("relay timeout — target not reachable via the relay".into());
        }
        if !resp.status().is_success() {
            return Err(format!("relay send HTTP {}", resp.status().as_u16()));
        }
        let reply: RelayReply = resp
            .json()
            .await
            .map_err(|e| format!("relay reply decode: {e}"))?;
        // Open the target's sealed reply with THIS device's X25519 secret.
        let me = super::identity::load_or_create()?;
        let pt = super::crypto::open(&reply.frame, &me.secrets.x25519_secret)?;
        serde_json::from_slice(&pt).map_err(|e| format!("bad sealed result: {e}"))
    }
}

// ==================================================================
// Target side — the client long-poll loop
// ==================================================================

static CLIENT_STOP: Lazy<Mutex<Option<Arc<AtomicBool>>>> = Lazy::new(|| Mutex::new(None));

/// Start (or restart) the relay client loop so this device is reachable via the
/// relay. Idempotent per URL: a running loop for a different URL is stopped first.
pub fn start_client(rt: tokio::runtime::Handle, url: String, my_id: String) {
    stop_client();
    let stop = Arc::new(AtomicBool::new(false));
    *CLIENT_STOP.lock().unwrap() = Some(stop.clone());
    rt.spawn(async move { client_loop(url, my_id, stop).await });
}

pub fn stop_client() {
    if let Some(s) = CLIENT_STOP.lock().unwrap().take() {
        s.store(true, Ordering::SeqCst);
    }
}

pub fn client_running() -> bool {
    CLIENT_STOP.lock().unwrap().is_some()
}

async fn client_loop(url: String, my_id: String, stop: Arc<AtomicBool>) {
    let base = url.trim_end_matches('/').to_string();
    let poll_client = match http_client(POLL_WAIT + Duration::from_secs(10)) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("relay client: {e}");
            return;
        }
    };
    while !stop.load(Ordering::SeqCst) {
        match poll_once(&poll_client, &base, &my_id).await {
            Ok(Some(pkt)) => {
                // Capture reply-routing info before the frame is consumed.
                let corr = pkt.corr.clone();
                let to_dev = pkt.frame.from_device.clone();
                let to_x = pkt.frame.from_x25519_pub.clone();
                // Run the FULL inbound pipeline (auth → trust → policy → exec).
                match super::handle_incoming(pkt.frame).await {
                    Ok(result) => {
                        if let Ok(sealed) = super::seal_result_for(&to_dev, &to_x, &result) {
                            let _ = post_reply(
                                &poll_client,
                                &base,
                                &RelayReply {
                                    corr,
                                    frame: sealed,
                                },
                            )
                            .await;
                        }
                    }
                    // Integrity failure (forged/misrouted) — drop silently, no reply.
                    Err(e) => eprintln!("relay client: dropped frame: {e}"),
                }
            }
            Ok(None) => {} // 204 — long-poll expired, poll again
            Err(_) => {
                // Backoff on transient relay/network errors.
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        }
    }
}

async fn poll_once(
    client: &reqwest::Client,
    base: &str,
    my_id: &str,
) -> Result<Option<RelayPacket>, String> {
    let resp = client
        .get(format!("{base}/relay/v1/poll"))
        .query(&[("device", my_id)])
        .send()
        .await
        .map_err(|e| format!("relay poll: {e}"))?;
    match resp.status().as_u16() {
        204 => Ok(None),
        200 => resp
            .json::<RelayPacket>()
            .await
            .map(Some)
            .map_err(|e| format!("relay poll decode: {e}")),
        s => Err(format!("relay poll HTTP {s}")),
    }
}

async fn post_reply(
    client: &reqwest::Client,
    base: &str,
    reply: &RelayReply,
) -> Result<(), String> {
    client
        .post(format!("{base}/relay/v1/reply"))
        .json(reply)
        .send()
        .await
        .map_err(|e| format!("relay reply: {e}"))?;
    Ok(())
}

// ==================================================================
// The relay server itself (any user hosts it)
// ==================================================================

struct RelayServer {
    mailboxes: Mutex<HashMap<String, VecDeque<RelayPacket>>>,
    mail_cv: Condvar,
    waiters: Mutex<HashMap<String, Option<SignedEnvelope>>>,
    wait_cv: Condvar,
}

impl RelayServer {
    fn new() -> Self {
        RelayServer {
            mailboxes: Mutex::new(HashMap::new()),
            mail_cv: Condvar::new(),
            waiters: Mutex::new(HashMap::new()),
            wait_cv: Condvar::new(),
        }
    }

    /// Long-poll: pop the next queued packet for `device`, or None after POLL_WAIT.
    fn take_packet(&self, device: &str) -> Option<RelayPacket> {
        let mut mb = self.mailboxes.lock().unwrap();
        let deadline = Instant::now() + POLL_WAIT;
        loop {
            if let Some(q) = mb.get_mut(device) {
                if let Some(pkt) = q.pop_front() {
                    return Some(pkt);
                }
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return None;
            }
            let (g, to) = self.mail_cv.wait_timeout(mb, remaining).unwrap();
            mb = g;
            if to.timed_out() {
                return None;
            }
        }
    }

    /// Enqueue a packet + register a reply waiter, then block until the reply
    /// arrives (or SEND_WAIT elapses).
    fn send_and_wait(&self, pkt: RelayPacket) -> Option<SignedEnvelope> {
        let corr = pkt.corr.clone();
        {
            let mut mb = self.mailboxes.lock().unwrap();
            mb.entry(pkt.to.clone()).or_default().push_back(pkt);
        }
        {
            let mut w = self.waiters.lock().unwrap();
            w.insert(corr.clone(), None);
        }
        self.mail_cv.notify_all();

        let mut w = self.waiters.lock().unwrap();
        let deadline = Instant::now() + SEND_WAIT;
        loop {
            if let Some(Some(frame)) = w.get(&corr) {
                let f = frame.clone();
                w.remove(&corr);
                return Some(f);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                w.remove(&corr);
                return None;
            }
            let (g, to) = self.wait_cv.wait_timeout(w, remaining).unwrap();
            w = g;
            if to.timed_out() {
                w.remove(&corr);
                return None;
            }
        }
    }

    /// Deliver a reply to a waiting sender (keyed by corr).
    fn deliver_reply(&self, reply: RelayReply) {
        {
            let mut w = self.waiters.lock().unwrap();
            if w.contains_key(&reply.corr) {
                w.insert(reply.corr.clone(), Some(reply.frame));
            }
        }
        self.wait_cv.notify_all();
    }
}

static SERVER_STOP: Lazy<Mutex<Option<Arc<AtomicBool>>>> = Lazy::new(|| Mutex::new(None));

pub fn serving() -> bool {
    SERVER_STOP.lock().unwrap().is_some()
}

/// Start the relay server on `bind` (e.g. "0.0.0.0:47772"). Non-blocking: spawns
/// a small worker pool. Idempotent-ish — stops any prior server first.
pub fn serve(bind: &str) -> Result<(), String> {
    stop_serving();
    let server = tiny_http::Server::http(bind).map_err(|e| format!("bind relay {bind}: {e}"))?;
    let server = Arc::new(server);
    let state = Arc::new(RelayServer::new());
    let stop = Arc::new(AtomicBool::new(false));
    *SERVER_STOP.lock().unwrap() = Some(stop.clone());

    // A few workers so concurrent long-polls (one per device + senders) don't
    // starve each other. tiny_http's Server is Sync — share it across threads.
    for i in 0..8 {
        let server = server.clone();
        let state = state.clone();
        let stop = stop.clone();
        std::thread::Builder::new()
            .name(format!("owllm-relay-{i}"))
            .spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    match server.recv_timeout(Duration::from_millis(400)) {
                        Ok(Some(req)) => handle(req, &state),
                        Ok(None) => continue,
                        Err(_) => break,
                    }
                }
            })
            .map_err(|e| format!("spawn relay worker: {e}"))?;
    }
    Ok(())
}

pub fn stop_serving() {
    if let Some(s) = SERVER_STOP.lock().unwrap().take() {
        s.store(true, Ordering::SeqCst);
    }
}

fn read_body(req: &mut tiny_http::Request) -> Option<String> {
    let mut s = String::new();
    req.as_reader().read_to_string(&mut s).ok()?;
    Some(s)
}

fn reply_json(req: tiny_http::Request, code: u16, body: &str) {
    let header =
        tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    let _ = req.respond(
        tiny_http::Response::from_string(body)
            .with_status_code(code)
            .with_header(header),
    );
}

fn handle(mut req: tiny_http::Request, state: &RelayServer) {
    let url = req.url().to_string();
    let method = req.method().clone();
    let path = url.split('?').next().unwrap_or("").to_string();

    match (method, path.as_str()) {
        (tiny_http::Method::Get, "/relay/v1/poll") => {
            let device = url
                .split('?')
                .nth(1)
                .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("device=")))
                .map(|s| s.to_string())
                .unwrap_or_default();
            if device.is_empty() {
                return reply_json(req, 400, "{\"error\":\"missing device\"}");
            }
            match state.take_packet(&device) {
                Some(pkt) => reply_json(req, 200, &serde_json::to_string(&pkt).unwrap_or_default()),
                None => {
                    let _ = req.respond(tiny_http::Response::from_string("").with_status_code(204));
                }
            }
        }
        (tiny_http::Method::Post, "/relay/v1/send") => {
            let Some(body) = read_body(&mut req) else {
                return reply_json(req, 400, "{\"error\":\"unreadable\"}");
            };
            let Ok(pkt) = serde_json::from_str::<RelayPacket>(&body) else {
                return reply_json(req, 400, "{\"error\":\"bad packet\"}");
            };
            match state.send_and_wait(pkt) {
                Some(frame) => {
                    let reply = RelayReply {
                        corr: String::new(),
                        frame,
                    };
                    reply_json(req, 200, &serde_json::to_string(&reply).unwrap_or_default());
                }
                None => reply_json(req, 504, "{\"error\":\"timeout\"}"),
            }
        }
        (tiny_http::Method::Post, "/relay/v1/reply") => {
            let Some(body) = read_body(&mut req) else {
                return reply_json(req, 400, "{\"error\":\"unreadable\"}");
            };
            let Ok(reply) = serde_json::from_str::<RelayReply>(&body) else {
                return reply_json(req, 400, "{\"error\":\"bad reply\"}");
            };
            state.deliver_reply(reply);
            reply_json(req, 200, "{\"ok\":true}");
        }
        (tiny_http::Method::Get, "/relay/v1/health") => reply_json(req, 200, "{\"ok\":true}"),
        _ => {
            let _ =
                req.respond(tiny_http::Response::from_string("not found").with_status_code(404));
        }
    }
}
