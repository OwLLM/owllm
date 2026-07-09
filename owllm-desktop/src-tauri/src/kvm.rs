// OWLLM Node — host capability that drives a remote KVM (e.g. a Sipeed
// NanoKVM) over the network. The agent's *eyes* are the target's captured
// video (screenshot → the existing VLM/mmproj path); its *hands* are an
// emulated USB-HID (type / keys / mouse / boot_key) plus out-of-band
// controls (mount_iso / power).
//
// The transport (Phase 2) drives the stock NanoKVM-Server HTTPS + WebSocket
// API — no firmware fork. Auth, screenshot, HID and out-of-band controls all
// go through the same endpoints the device's own web UI uses (see the
// "Transport" section below for the verified wire details). The SAFETY plumbing
// wraps every one of those calls:
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
// Each exec authenticates fresh (one cheap login round-trip) rather than
// holding a long-lived session, so a revoked/expired JWT can never wedge the
// capability — the next action simply logs in again.

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

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
    /// The NanoKVM web-UI account name (e.g. the login set on the device).
    /// Required by the `websocket` transport's `POST /api/auth/login`.
    #[serde(default)]
    pub username: Option<String>,
    /// Web-UI password for the `websocket` transport. Never logged (it is
    /// scrambled before it leaves the host and only its presence is audited).
    #[serde(default)]
    pub token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct KvmTarget {
    /// May be omitted by the caller when exactly ONE Node is configured on the
    /// Accounts page — kvm_node_exec fills it in. (Agents kept flailing trying
    /// to guess hosts/ports; the stored config is the source of truth.)
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub auth: KvmAuth,
    /// "websocket" | "ssh". Defaults to "websocket" (the NanoKVM web API).
    #[serde(default)]
    pub transport: String,
}

// ------------------------------------------------------------------
// Feature flag — default OFF
// ------------------------------------------------------------------

/// True when OWLLM_KVM_NODE is set to a truthy value (env override, same style
/// as overlay_frame::enabled()) OR when the user flipped the persisted toggle
/// in the UI (`"enabled": true` in kvm_consent.json). Default OFF either way,
/// so the whole capability stays dormant unless a user explicitly opts in.
fn feature_enabled() -> bool {
    let env_on = std::env::var("OWLLM_KVM_NODE")
        .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes" | "YES" | "on" | "ON"))
        .unwrap_or(false);
    env_on || load_enabled_setting()
}

/// Read the persisted UI toggle. Any read/parse failure → false (fail-closed),
/// mirroring load_consent().
fn load_enabled_setting() -> bool {
    let Some(path) = consent_path() else { return false };
    let Ok(txt) = std::fs::read_to_string(&path) else { return false };
    let Ok(v) = serde_json::from_str::<Value>(&txt) else { return false };
    v.get("enabled").and_then(Value::as_bool) == Some(true)
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
// Transport — Phase 2: the stock NanoKVM-Server HTTPS + WebSocket API
// ------------------------------------------------------------------
//
// Verified against a live device (firmware 2.4.3). Auth flow:
//   1. POST /api/auth/login {username, password} where `password` is the
//      web-UI password run through the SAME scrambling the NanoKVM web client
//      uses — encodeURIComponent(base64("Salted__"+salt+AES-256-CBC(pw))) with
//      key/iv from OpenSSL EVP_BytesToKey(MD5, 1 round) over the fixed
//      passphrase below and the random salt. The server DecodeDecrypts it
//      before its bcrypt check, so sending the plaintext password fails.
//      On success `data.token` is a JWT.
//   2. Every later call carries that JWT as the cookie `nano-kvm-token`
//      (the server reads ONLY the cookie, not an Authorization header).
//
// The device serves this API on 443 with a self-signed cert (port 80 just
// 307-redirects to 443), so the HTTP client and the HID websocket both accept
// the self-signed cert — these are LAN calls to a box the operator owns.

/// Fixed passphrase the NanoKVM web client feeds to CryptoJS.AES.encrypt. Not a
/// secret (it ships in the device's own JS); it only obfuscates the password on
/// the wire. Verbatim from the on-device `encrypt-*.js`.
const KVM_LOGIN_PASSPHRASE: &[u8] = b"nanokvm-sipeed-2024";

/// Cookie name the server's auth middleware reads the JWT from.
const KVM_TOKEN_COOKIE: &str = "nano-kvm-token";

/// Realtime `/api/ws` frame tags (client→server HID). The report bytes follow
/// the tag; layouts match the USB-HID gadgets the device exposes (§3 of the
/// recon): keyboard = 8-byte `[mod,0,k1..k6]`, relative mouse = 4-byte
/// `[buttons,dx,dy,wheel]`.
const WS_TAG_KEYBOARD: u8 = 1;
const WS_TAG_MOUSE: u8 = 2;

/// A few bytes of non-cryptographic entropy for the AES salt and the WebSocket
/// masking key. Neither needs to be secret (the passphrase is public and the
/// mask is XOR-recoverable), only unique-ish, so this avoids pulling in an RNG.
fn nonce_bytes<const N: usize>() -> [u8; N] {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static CTR: AtomicU64 = AtomicU64::new(0);
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
        ^ CTR.fetch_add(1, Ordering::Relaxed).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let mut x = seed;
    let mut out = [0u8; N];
    for b in out.iter_mut() {
        // splitmix64 step
        x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = x;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        *b = z as u8;
    }
    out
}

/// OpenSSL EVP_BytesToKey with MD5 and a single iteration — the KDF CryptoJS
/// uses for a string passphrase. Produces 32-byte key + 16-byte IV for AES-256.
fn evp_bytes_to_key_md5(passphrase: &[u8], salt: &[u8; 8]) -> ([u8; 32], [u8; 16]) {
    use md5::{Digest, Md5};
    let mut material = Vec::with_capacity(48);
    let mut prev: Vec<u8> = Vec::new();
    while material.len() < 48 {
        let mut h = Md5::new();
        h.update(&prev);
        h.update(passphrase);
        h.update(salt);
        prev = h.finalize().to_vec();
        material.extend_from_slice(&prev);
    }
    let mut key = [0u8; 32];
    let mut iv = [0u8; 16];
    key.copy_from_slice(&material[..32]);
    iv.copy_from_slice(&material[32..48]);
    (key, iv)
}

/// Scramble the web-UI password exactly like the device's web client so the
/// server's DecodeDecrypt can undo it: URL-encoded base64 of
/// "Salted__" + salt + AES-256-CBC/PKCS7(password).
fn encrypt_password(plain: &str) -> Result<String, String> {
    use base64::Engine as _;
    use cbc::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
    type Enc = cbc::Encryptor<aes::Aes256>;

    let salt = nonce_bytes::<8>();
    let (key, iv) = evp_bytes_to_key_md5(KVM_LOGIN_PASSPHRASE, &salt);
    let enc = Enc::new_from_slices(&key, &iv).map_err(|e| format!("aes init: {e}"))?;
    let ciphertext = enc.encrypt_padded_vec_mut::<Pkcs7>(plain.as_bytes());

    let mut blob = Vec::with_capacity(16 + ciphertext.len());
    blob.extend_from_slice(b"Salted__");
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&ciphertext);
    let b64 = base64::engine::general_purpose::STANDARD.encode(&blob);
    Ok(urlencoding::encode(&b64).into_owned())
}

// ---- HTTP session ------------------------------------------------

fn base_url(t: &KvmTarget) -> String {
    format!("https://{}:{}", t.host, t.port.unwrap_or(443))
}

fn cookie(token: &str) -> String {
    format!("{KVM_TOKEN_COOKIE}={token}")
}

/// HTTP client that accepts the device's self-signed cert (LAN, operator-owned).
fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

/// Log in and return the JWT. Requires `auth.username` + `auth.token` (password).
async fn login(cli: &reqwest::Client, t: &KvmTarget) -> Result<String, String> {
    let username = t
        .auth
        .username
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("missing auth.username (the NanoKVM web-UI account name)")?;
    let password = t
        .auth
        .token
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or("missing auth.token (the NanoKVM web-UI password)")?;
    let scrambled = encrypt_password(password)?;

    let url = format!("{}/api/auth/login", base_url(t));
    let resp = cli
        .post(&url)
        .json(&json!({ "username": username, "password": scrambled }))
        .send()
        .await
        .map_err(|e| format!("login request: {e}"))?;
    let body: Value = resp.json().await.map_err(|e| format!("login response: {e}"))?;
    if body.get("code").and_then(Value::as_i64) != Some(0) {
        let msg = body.get("msg").and_then(Value::as_str).unwrap_or("invalid credentials");
        return Err(format!("login rejected: {msg}"));
    }
    body.get("data")
        .and_then(|d| d.get("token"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "login succeeded but no token in response".to_string())
}

/// Build a client + authenticate. Every action starts here.
async fn connect(t: &KvmTarget) -> Result<(reqwest::Client, String), String> {
    let cli = http_client()?;
    let token = login(&cli, t).await?;
    Ok((cli, token))
}

/// POST a JSON body with the session cookie and require a `{code:0,...}`
/// NanoKVM envelope; returns its `data` field (or Null).
async fn api_post(
    cli: &reqwest::Client,
    t: &KvmTarget,
    token: &str,
    path: &str,
    body: Value,
) -> Result<Value, String> {
    let url = format!("{}{}", base_url(t), path);
    let resp = cli
        .post(&url)
        .header(reqwest::header::COOKIE, cookie(token))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("POST {path}: {e}"))?;
    let status = resp.status();
    let v: Value = resp.json().await.map_err(|e| format!("POST {path} response: {e}"))?;
    let code = v.get("code").and_then(Value::as_i64);
    if code != Some(0) {
        let msg = v.get("msg").and_then(Value::as_str).unwrap_or("unknown error");
        return Err(format!("{path} failed (code {code:?}, HTTP {status}): {msg}"));
    }
    Ok(v.get("data").cloned().unwrap_or(Value::Null))
}

// ---- Eyes: one MJPEG frame ---------------------------------------

/// Slice out the first complete JPEG (SOI…EOI) in `buf`, if present.
fn extract_jpeg(buf: &[u8]) -> Option<&[u8]> {
    let soi = buf.windows(2).position(|w| w == [0xFF, 0xD8])?;
    let eoi_rel = buf[soi + 2..].windows(2).position(|w| w == [0xFF, 0xD9])?;
    let eoi = soi + 2 + eoi_rel;
    Some(&buf[soi..eoi + 2])
}

/// Read width/height from a JPEG's SOFn marker without decoding pixels.
fn jpeg_dimensions(jpeg: &[u8]) -> Option<(u32, u32)> {
    let mut i = 2; // past SOI
    while i + 9 < jpeg.len() {
        if jpeg[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = jpeg[i + 1];
        // Standalone markers (no length field).
        if marker == 0xD8 || marker == 0xD9 || (0xD0..=0xD7).contains(&marker) {
            i += 2;
            continue;
        }
        let len = ((jpeg[i + 2] as usize) << 8) | jpeg[i + 3] as usize;
        // SOF0/1/2/3/5/6/7/9/A/B/D/E/F carry frame dimensions (skip DHT/DAC etc).
        let is_sof = matches!(
            marker,
            0xC0 | 0xC1 | 0xC2 | 0xC3 | 0xC5 | 0xC6 | 0xC7 | 0xC9 | 0xCA | 0xCB | 0xCD | 0xCE | 0xCF
        );
        if is_sof {
            let h = ((jpeg[i + 5] as u32) << 8) | jpeg[i + 6] as u32;
            let w = ((jpeg[i + 7] as u32) << 8) | jpeg[i + 8] as u32;
            return Some((w, h));
        }
        i += 2 + len;
    }
    None
}

/// Persist a captured frame under <app-data>/kvm_frames/ and return its path.
fn save_frame(host: &str, jpeg: &[u8]) -> Result<String, String> {
    let dir = crate::paths::user_data_root()
        .ok_or("could not resolve app data dir for kvm_frames")?
        .join("kvm_frames");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir kvm_frames: {e}"))?;
    let safe_host: String = host
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c } else { '_' })
        .collect();
    let ts = chrono::Utc::now().format("%Y%m%dT%H%M%S%3fZ");
    let path = dir.join(format!("{safe_host}-{ts}.jpg"));
    std::fs::write(&path, jpeg).map_err(|e| format!("write frame: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

async fn do_screenshot(t: &KvmTarget) -> Result<Value, String> {
    use futures_util::StreamExt;
    let (cli, token) = connect(t).await?;
    let url = format!("{}/api/stream/mjpeg", base_url(t));
    let resp = cli
        .get(&url)
        .header(reqwest::header::COOKIE, cookie(&token))
        .send()
        .await
        .map_err(|e| format!("mjpeg request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("mjpeg HTTP {}", resp.status()));
    }
    let mut buf: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("mjpeg stream: {e}"))?;
        buf.extend_from_slice(&chunk);
        if let Some(frame) = extract_jpeg(&buf) {
            let (w, h) = jpeg_dimensions(frame).unwrap_or((0, 0));
            let path = save_frame(&t.host, frame)?;
            return Ok(json!({ "imagePath": path, "width": w, "height": h }));
        }
        if buf.len() > 8_000_000 {
            return Err("mjpeg: 8 MB read without a complete JPEG frame".into());
        }
    }
    Err("mjpeg: stream closed before a full frame arrived".into())
}

// ---- Hands: HID over the /api/ws websocket -----------------------

/// USB-HID keyboard usage code for a key name (already lowercased). Modifiers
/// are handled by `modifier_bit`; returns None for anything unmapped.
fn hid_keycode(name: &str) -> Option<u8> {
    Some(match name {
        "a" => 0x04, "b" => 0x05, "c" => 0x06, "d" => 0x07, "e" => 0x08, "f" => 0x09,
        "g" => 0x0a, "h" => 0x0b, "i" => 0x0c, "j" => 0x0d, "k" => 0x0e, "l" => 0x0f,
        "m" => 0x10, "n" => 0x11, "o" => 0x12, "p" => 0x13, "q" => 0x14, "r" => 0x15,
        "s" => 0x16, "t" => 0x17, "u" => 0x18, "v" => 0x19, "w" => 0x1a, "x" => 0x1b,
        "y" => 0x1c, "z" => 0x1d,
        "1" => 0x1e, "2" => 0x1f, "3" => 0x20, "4" => 0x21, "5" => 0x22,
        "6" => 0x23, "7" => 0x24, "8" => 0x25, "9" => 0x26, "0" => 0x27,
        "enter" | "return" => 0x28, "esc" | "escape" => 0x29, "backspace" | "bksp" => 0x2a,
        "tab" => 0x2b, "space" | "spacebar" => 0x2c, "minus" => 0x2d, "equal" => 0x2e,
        "f1" => 0x3a, "f2" => 0x3b, "f3" => 0x3c, "f4" => 0x3d, "f5" => 0x3e, "f6" => 0x3f,
        "f7" => 0x40, "f8" => 0x41, "f9" => 0x42, "f10" => 0x43, "f11" => 0x44, "f12" => 0x45,
        "print" | "printscreen" | "prtsc" => 0x46, "scrolllock" => 0x47, "pause" => 0x48,
        "insert" | "ins" => 0x49, "home" => 0x4a, "pageup" | "pgup" => 0x4b,
        "delete" | "del" => 0x4c, "end" => 0x4d, "pagedown" | "pgdn" => 0x4e,
        "right" => 0x4f, "left" => 0x50, "down" => 0x51, "up" => 0x52,
        _ => return None,
    })
}

/// Modifier bit for a key name (already lowercased), or None if not a modifier.
fn modifier_bit(name: &str) -> Option<u8> {
    Some(match name {
        "ctrl" | "control" | "lctrl" | "lcontrol" => 0x01,
        "shift" | "lshift" => 0x02,
        "alt" | "lalt" | "option" => 0x04,
        "gui" | "meta" | "cmd" | "command" | "win" | "windows" | "super" => 0x08,
        "rctrl" | "rcontrol" => 0x10,
        "rshift" => 0x20,
        "ralt" | "altgr" => 0x40,
        "rgui" | "rwin" => 0x80,
        _ => return None,
    })
}

/// Turn a combo like "ctrl+alt+del" or a single "f12" into an 8-byte keyboard
/// report `[modifiers, 0, k1..k6]`. Separators: '+', '-', or whitespace.
fn keyboard_report(combo: &str) -> Result<[u8; 8], String> {
    let mut modifiers = 0u8;
    let mut keys: Vec<u8> = Vec::new();
    for raw in combo.split(|c| c == '+' || c == '-' || c == ' ').filter(|s| !s.is_empty()) {
        let tok = raw.trim().to_ascii_lowercase();
        if let Some(m) = modifier_bit(&tok) {
            modifiers |= m;
            continue;
        }
        if let Some(k) = hid_keycode(&tok) {
            if keys.len() >= 6 {
                return Err(format!("too many keys in combo '{combo}' (USB HID max is 6)"));
            }
            keys.push(k);
            continue;
        }
        return Err(format!("unknown key '{raw}' in combo '{combo}'"));
    }
    if modifiers == 0 && keys.is_empty() {
        return Err(format!("empty key combo '{combo}'"));
    }
    let mut report = [0u8; 8];
    report[0] = modifiers;
    for (i, k) in keys.iter().enumerate() {
        report[2 + i] = *k;
    }
    Ok(report)
}

/// Tag a HID report with the ws stream tag byte.
fn tagged(tag: u8, report: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(1 + report.len());
    f.push(tag);
    f.extend_from_slice(report);
    f
}

/// Build the client→server frames for a mouse op. Relative pointer: report is
/// `[buttons, dx, dy, wheel]`; "move" is a relative nudge by (x, y).
fn mouse_frames(op: &str, params: &Value) -> Result<Vec<Vec<u8>>, String> {
    let x = params.get("x").and_then(Value::as_i64).unwrap_or(0);
    let y = params.get("y").and_then(Value::as_i64).unwrap_or(0);
    let button = params.get("button").and_then(Value::as_str).unwrap_or("left");
    let bit = match button {
        "left" => 1u8,
        "right" => 2,
        "middle" => 4,
        other => return Err(format!("unknown mouse button '{other}' (left|right|middle)")),
    };
    let clamp = |v: i64| v.clamp(-127, 127) as i8 as u8;
    let report = |buttons: u8, dx: i64, dy: i64, wheel: i64| {
        tagged(WS_TAG_MOUSE, &[buttons, clamp(dx), clamp(dy), clamp(wheel)])
    };
    Ok(match op {
        "move" => vec![report(0, x, y, 0)],
        "down" => vec![report(bit, 0, 0, 0)],
        "up" => vec![report(0, 0, 0, 0)],
        "click" => vec![report(bit, 0, 0, 0), report(0, 0, 0, 0)],
        "scroll" => {
            let wheel = if y != 0 { y } else { params.get("wheel").and_then(Value::as_i64).unwrap_or(0) };
            vec![report(0, 0, 0, wheel)]
        }
        other => return Err(format!("unknown mouse op '{other}' (move|click|down|up|scroll)")),
    })
}

/// One WebSocket data frame (client→server, so MUST be masked). HID payloads
/// here are always < 126 bytes, so the 7-bit length form always suffices.
fn ws_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    debug_assert!(payload.len() < 126);
    let mask = nonce_bytes::<4>();
    let mut out = Vec::with_capacity(6 + payload.len());
    out.push(0x80 | (opcode & 0x0f)); // FIN + opcode
    out.push(0x80 | (payload.len() as u8)); // mask bit + length
    out.extend_from_slice(&mask);
    for (i, b) in payload.iter().enumerate() {
        out.push(b ^ mask[i % 4]);
    }
    out
}

/// Open `/api/ws`, send the given (already tag-prefixed) HID frames, close.
/// Synchronous: the handshake + a few tiny writes are wrapped in spawn_blocking
/// by `ws_send`. TLS via native-tls (schannel/openssl/SecureTransport per OS).
fn ws_send_blocking(host: String, port: u16, token: String, frames: Vec<Vec<u8>>) -> Result<(), String> {
    use std::io::{Read, Write};
    let connector = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()
        .map_err(|e| format!("tls connector: {e}"))?;
    let tcp = std::net::TcpStream::connect((host.as_str(), port))
        .map_err(|e| format!("connect {host}:{port}: {e}"))?;
    tcp.set_read_timeout(Some(std::time::Duration::from_secs(10))).ok();
    tcp.set_write_timeout(Some(std::time::Duration::from_secs(10))).ok();
    let mut tls = connector
        .connect(&host, tcp)
        .map_err(|e| format!("tls handshake: {e}"))?;

    let key = {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(nonce_bytes::<16>())
    };
    let handshake = format!(
        "GET /api/ws HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nCookie: {KVM_TOKEN_COOKIE}={token}\r\n\r\n"
    );
    tls.write_all(handshake.as_bytes())
        .map_err(|e| format!("ws send handshake: {e}"))?;

    // Read response headers up to the blank line.
    let mut hdr = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let n = tls.read(&mut byte).map_err(|e| format!("ws read handshake: {e}"))?;
        if n == 0 {
            return Err("ws: connection closed during handshake".into());
        }
        hdr.push(byte[0]);
        if hdr.ends_with(b"\r\n\r\n") {
            break;
        }
        if hdr.len() > 8192 {
            return Err("ws: handshake response too large".into());
        }
    }
    let status_line = String::from_utf8_lossy(&hdr);
    let first = status_line.lines().next().unwrap_or("");
    if !first.starts_with("HTTP/1.1 101") {
        return Err(format!("ws handshake rejected: {first}"));
    }

    for f in &frames {
        tls.write_all(&ws_frame(0x2, f)).map_err(|e| format!("ws send frame: {e}"))?;
    }
    // Polite close frame (opcode 0x8), best-effort.
    let _ = tls.write_all(&ws_frame(0x8, &[]));
    let _ = tls.flush();
    Ok(())
}

async fn ws_send(t: &KvmTarget, token: &str, frames: Vec<Vec<u8>>) -> Result<(), String> {
    let host = t.host.clone();
    let port = t.port.unwrap_or(443);
    let token = token.to_string();
    tokio::task::spawn_blocking(move || ws_send_blocking(host, port, token, frames))
        .await
        .map_err(|e| format!("ws task: {e}"))?
}

async fn do_type(t: &KvmTarget, params: &Value) -> Result<Value, String> {
    let text = params
        .get("text")
        .and_then(Value::as_str)
        .ok_or("missing string field 'text' in params")?;
    let langue = params.get("langue").and_then(Value::as_str).unwrap_or("en");
    let (cli, token) = connect(t).await?;
    api_post(&cli, t, &token, "/api/hid/paste", json!({ "content": text, "langue": langue })).await?;
    Ok(json!({ "typed": text.chars().count() }))
}

async fn do_key_combo(t: &KvmTarget, action: &str, combo: &str) -> Result<Value, String> {
    let report = keyboard_report(combo)?;
    let press = tagged(WS_TAG_KEYBOARD, &report);
    let release = tagged(WS_TAG_KEYBOARD, &[0u8; 8]);
    let (_cli, token) = connect(t).await?;
    ws_send(t, &token, vec![press, release]).await?;
    Ok(json!({ action: combo }))
}

async fn do_mouse(t: &KvmTarget, params: &Value) -> Result<Value, String> {
    let op = params
        .get("op")
        .and_then(Value::as_str)
        .ok_or("missing string field 'op' in params")?;
    let frames = mouse_frames(op, params)?;
    let (_cli, token) = connect(t).await?;
    ws_send(t, &token, frames).await?;
    Ok(json!({ "op": op }))
}

async fn do_power(t: &KvmTarget, params: &Value) -> Result<Value, String> {
    let kind = params.get("type").and_then(Value::as_str).unwrap_or("power");
    if kind != "power" && kind != "reset" {
        return Err(format!("power: 'type' must be 'power' or 'reset', got '{kind}'"));
    }
    let duration = params.get("duration").and_then(Value::as_i64).unwrap_or(800);
    let (cli, token) = connect(t).await?;
    api_post(&cli, t, &token, "/api/vm/gpio", json!({ "type": kind, "duration": duration })).await?;
    Ok(json!({ "type": kind, "duration": duration }))
}

async fn do_mount_iso(t: &KvmTarget, params: &Value) -> Result<Value, String> {
    let file = params
        .get("file")
        .and_then(Value::as_str)
        .ok_or("missing string field 'file' in params")?;
    let cdrom = params.get("cdrom").and_then(Value::as_bool).unwrap_or(true);
    let (cli, token) = connect(t).await?;
    api_post(&cli, t, &token, "/api/storage/image/mount", json!({ "file": file, "cdrom": cdrom })).await?;
    Ok(json!({ "file": file, "cdrom": cdrom }))
}

/// Dispatch by action string. Each handler validates its own params (helpful
/// errors, never a panic) and returns the `data` payload; the envelope is built
/// here so every action shares the `{ok, action, data|error}` shape.
async fn dispatch(target: &KvmTarget, action: &str, params: &Value) -> Value {
    let result = match action {
        "screenshot" => do_screenshot(target).await,
        "type" => do_type(target, params).await,
        "keys" => match params.get("combo").and_then(Value::as_str) {
            Some(combo) => do_key_combo(target, "combo", combo).await,
            None => Err("missing string field 'combo' in params".to_string()),
        },
        "boot_key" => match params.get("key").and_then(Value::as_str) {
            Some(key) => do_key_combo(target, "key", key).await,
            None => Err("missing string field 'key' in params".to_string()),
        },
        "mouse" => do_mouse(target, params).await,
        "power" => do_power(target, params).await,
        "mount_iso" => do_mount_iso(target, params).await,
        other => Err(format!("unknown action '{other}'")),
    };
    match result {
        Ok(data) => env_ok(action, data),
        Err(e) => env_err(action, &e),
    }
}

// ------------------------------------------------------------------
// Credential store — per-host {username, password, port, transport}
// ------------------------------------------------------------------
// Agents can't guess a NanoKVM's host/port/login, and requiring the model to
// carry the web-UI password in every tool call is both unsafe and why "take a
// screenshot of the KVM" kept failing to even log in. The user saves each
// Node once on the Accounts page; kvm_node_exec autofills any field the caller
// omitted. The password is encrypted at rest with the same DPAPI wrapper the
// account secrets use (crypt::protect) and never returned to the UI.

fn creds_path() -> Option<PathBuf> {
    crate::paths::user_data_root().map(|r| r.join("kvm_nodes.json"))
}

fn load_nodes_doc() -> Value {
    creds_path()
        .and_then(|p| std::fs::read_to_string(&p).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(|v| v.get("nodes").map(Value::is_object).unwrap_or(false))
        .unwrap_or_else(|| json!({ "nodes": {} }))
}

/// Decrypt a stored password blob (base64 of DPAPI ciphertext). None on any
/// failure — the caller then reports "missing password" rather than crash.
fn decrypt_stored_password(b64: &str) -> Option<String> {
    use base64::Engine as _;
    let cipher = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    let plain = crate::crypt::unprotect(&cipher).ok()?;
    String::from_utf8(plain).ok()
}

/// Fill in any target field the caller omitted from the saved node config.
/// Host resolution: explicit host wins; else if exactly ONE node is saved, use
/// it (the common "I only have one KVM" case that agents kept fumbling).
fn hydrate_target_from_store(t: &mut KvmTarget) {
    let doc = load_nodes_doc();
    let nodes = match doc.get("nodes").and_then(Value::as_object) {
        Some(m) if !m.is_empty() => m,
        _ => return,
    };
    // Resolve which stored node this target refers to.
    let host = t.host.trim().to_string();
    let entry = if !host.is_empty() {
        nodes.get(&host)
    } else if nodes.len() == 1 {
        let (k, v) = nodes.iter().next().unwrap();
        t.host = k.clone();
        Some(v)
    } else {
        None
    };
    let Some(e) = entry else { return };
    if t.transport.trim().is_empty() {
        t.transport = e.get("transport").and_then(Value::as_str).unwrap_or("websocket").to_string();
    }
    if t.port.is_none() {
        t.port = e.get("port").and_then(Value::as_u64).map(|p| p as u16);
    }
    if t.auth.username.as_deref().map(str::trim).unwrap_or("").is_empty() {
        t.auth.username = e.get("username").and_then(Value::as_str).map(str::to_string);
    }
    if t.auth.token.as_deref().map(str::trim).unwrap_or("").is_empty() {
        t.auth.token = e.get("password").and_then(Value::as_str).and_then(decrypt_stored_password);
    }
    if t.auth.ssh_key_path.as_deref().map(str::trim).unwrap_or("").is_empty() {
        t.auth.ssh_key_path = e.get("sshKeyPath").and_then(Value::as_str).map(str::to_string);
    }
}

/// Save (or update) a Node's connection config. The password is DPAPI-encrypted
/// then base64'd; pass an empty password to keep the existing one.
#[tauri::command]
pub fn kvm_node_save(
    host: String,
    username: Option<String>,
    password: Option<String>,
    port: Option<u16>,
    transport: Option<String>,
    ssh_key_path: Option<String>,
) -> Result<Value, String> {
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("missing field 'host' (the NanoKVM IP or hostname)".to_string());
    }
    let mut doc = load_nodes_doc();
    if !doc["nodes"].get(&host).map(Value::is_object).unwrap_or(false) {
        doc["nodes"][&host] = json!({});
    }
    let node = &mut doc["nodes"][&host];
    if let Some(u) = username {
        node["username"] = json!(u);
    }
    if let Some(p) = password.filter(|p| !p.is_empty()) {
        use base64::Engine as _;
        let cipher = crate::crypt::protect(p.as_bytes())?;
        node["password"] = json!(base64::engine::general_purpose::STANDARD.encode(cipher));
    }
    if let Some(p) = port {
        node["port"] = json!(p);
    }
    if let Some(tr) = transport.filter(|s| !s.trim().is_empty()) {
        node["transport"] = json!(tr);
    }
    if let Some(k) = ssh_key_path {
        node["sshKeyPath"] = json!(k);
    }
    let path = creds_path().ok_or_else(|| "could not resolve app data dir for kvm_nodes.json".to_string())?;
    let txt = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(&path, txt).map_err(|e| format!("write kvm_nodes.json: {e}"))?;
    Ok(json!({ "ok": true, "host": host }))
}

/// List saved Nodes (host, username, port, transport) — NEVER the password.
#[tauri::command]
pub fn kvm_node_list() -> Result<Value, String> {
    let doc = load_nodes_doc();
    let mut out = Vec::new();
    if let Some(map) = doc.get("nodes").and_then(Value::as_object) {
        for (host, e) in map {
            out.push(json!({
                "host": host,
                "username": e.get("username").and_then(Value::as_str).unwrap_or(""),
                "port": e.get("port").and_then(Value::as_u64),
                "transport": e.get("transport").and_then(Value::as_str).unwrap_or("websocket"),
                "hasPassword": e.get("password").and_then(Value::as_str).map(|s| !s.is_empty()).unwrap_or(false),
            }));
        }
    }
    Ok(json!({ "nodes": out }))
}

/// Remove a saved Node.
#[tauri::command]
pub fn kvm_node_delete(host: String) -> Result<Value, String> {
    let mut doc = load_nodes_doc();
    if let Some(map) = doc["nodes"].as_object_mut() {
        map.remove(host.trim());
    }
    let path = creds_path().ok_or_else(|| "could not resolve app data dir for kvm_nodes.json".to_string())?;
    let txt = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(&path, txt).map_err(|e| format!("write kvm_nodes.json: {e}"))?;
    Ok(json!({ "ok": true, "host": host }))
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
    mut target: KvmTarget,
    action: String,
    params: Value,
) -> Result<Value, String> {
    if !feature_enabled() {
        return Err(
            "OWLLM Node is disabled. Enable it on the Accounts page (OWLLM Node card) or set OWLLM_KVM_NODE=1 (default off).".to_string(),
        );
    }

    // Fill host/port/username/password/transport from the saved node config for
    // anything the caller (an agent) left blank. Without this the model had to
    // guess the IP, port, and web-UI password — which is why "screenshot the
    // KVM" never even logged in.
    hydrate_target_from_store(&mut target);
    if target.host.trim().is_empty() {
        return Err("no KVM host given and none saved — add a Node on the Accounts page (OWLLM Node card), or pass target.host.".to_string());
    }
    if target.transport.trim().is_empty() {
        target.transport = "websocket".to_string();
    }

    let envelope = if consent_allowed(&action, &target.host, &load_consent()) {
        dispatch(&target, &action, &params).await
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

/// UI status: is the feature on (and why), plus the consented-host list.
/// Read-only — safe to call regardless of the flag.
#[tauri::command]
pub fn kvm_node_status() -> Result<Value, String> {
    let mut hosts: Vec<String> = load_consent().into_iter().collect();
    hosts.sort();
    Ok(json!({
        "enabled": feature_enabled(),
        "envOverride": std::env::var("OWLLM_KVM_NODE").is_ok(),
        "hosts": hosts,
    }))
}

/// Flip the persisted UI toggle (kvm_consent.json "enabled"). The env var, when
/// set, still force-enables regardless of this setting.
#[tauri::command]
pub fn kvm_node_set_enabled(enabled: bool) -> Result<Value, String> {
    let path = consent_path()
        .ok_or_else(|| "could not resolve app data dir for kvm_consent.json".to_string())?;
    let mut doc = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(|v| v.get("hosts").map(Value::is_object).unwrap_or(false))
        .unwrap_or_else(|| json!({ "hosts": {} }));
    doc["enabled"] = json!(enabled);
    let txt = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(&path, txt).map_err(|e| format!("write kvm_consent.json: {e}"))?;
    Ok(json!({ "ok": true, "enabled": enabled }))
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
                username: Some("MC9".to_string()),
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

    // ---- Phase-2 transport: wire-format known-answer tests ----

    #[test]
    fn keyboard_report_combo_and_single_key() {
        // ctrl(0x01)|alt(0x04) = 0x05 modifiers; DEL usage = 0x4c in the first slot.
        assert_eq!(keyboard_report("ctrl+alt+del").unwrap(), [0x05, 0, 0x4c, 0, 0, 0, 0, 0]);
        // A lone boot key, dash/space separators, and case-insensitivity.
        assert_eq!(keyboard_report("F12").unwrap(), [0x00, 0, 0x45, 0, 0, 0, 0, 0]);
        assert_eq!(keyboard_report("ctrl-c").unwrap(), [0x01, 0, 0x06, 0, 0, 0, 0, 0]);
        // Unknown token and empty combo fail loudly (never a panic).
        assert!(keyboard_report("ctrl+zzz").is_err());
        assert!(keyboard_report("").is_err());
        // USB HID caps at 6 concurrent keys.
        assert!(keyboard_report("a+b+c+d+e+f+g").is_err());
    }

    #[test]
    fn mouse_frames_cover_move_click_scroll() {
        // Relative move: tag=2, buttons=0, dx/dy two's-complement in a byte.
        assert_eq!(mouse_frames("move", &json!({ "x": 5, "y": -3 })).unwrap(), vec![vec![2u8, 0, 5, 0xFD, 0]]);
        // Click = button-down then button-up (right = bit 0x02).
        assert_eq!(
            mouse_frames("click", &json!({ "button": "right" })).unwrap(),
            vec![vec![2u8, 2, 0, 0, 0], vec![2u8, 0, 0, 0, 0]]
        );
        // Scroll uses y (or an explicit wheel).
        assert_eq!(mouse_frames("scroll", &json!({ "y": 1 })).unwrap(), vec![vec![2u8, 0, 0, 0, 1]]);
        assert!(mouse_frames("teleport", &json!({})).is_err());
        assert!(mouse_frames("click", &json!({ "button": "pinky" })).is_err());
    }

    #[test]
    fn ws_frame_is_masked_and_recoverable() {
        let payload = [WS_TAG_MOUSE, 0, 5, 5, 0];
        let f = ws_frame(0x2, &payload);
        assert_eq!(f[0], 0x82, "FIN + binary opcode");
        assert_eq!(f[1], 0x80 | payload.len() as u8, "mask bit + 7-bit length");
        let mask = &f[2..6];
        let unmasked: Vec<u8> = f[6..].iter().enumerate().map(|(i, b)| b ^ mask[i % 4]).collect();
        assert_eq!(unmasked, payload, "server unmasks back to the original HID report");
    }

    #[test]
    fn jpeg_extract_and_dimensions() {
        // Minimal JPEG: SOI, SOF0 (marker C0, len 17, precision 8, h=0x0090, w=0x0140), EOI.
        let mut j = vec![0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x90, 0x01, 0x40];
        j.extend_from_slice(&[0u8; 6]); // rest of the SOF payload (components), unread
        j.extend_from_slice(&[0xFF, 0xD9]);
        let frame = extract_jpeg(&j).expect("a full SOI..EOI frame");
        assert_eq!(frame.first(), Some(&0xFF));
        assert_eq!(frame.last(), Some(&0xD9));
        assert_eq!(jpeg_dimensions(frame), Some((0x0140, 0x0090)));
        // No EOI yet → no frame extracted.
        assert!(extract_jpeg(&[0xFF, 0xD8, 0xFF, 0xC0]).is_none());
    }

    #[test]
    fn encrypt_password_emits_openssl_salted_envelope() {
        use base64::Engine as _;
        // encodeURIComponent-wrapped base64 of "Salted__" + salt + ciphertext,
        // which is exactly what the server's DecodeDecrypt expects.
        let out = encrypt_password("Yuzha6341---").unwrap();
        let b64 = urlencoding::decode(&out).unwrap();
        let raw = base64::engine::general_purpose::STANDARD.decode(b64.as_bytes()).unwrap();
        assert_eq!(&raw[..8], b"Salted__", "missing OpenSSL salt header");
        // 8-byte magic + 8-byte salt + AES block(s); a 12-char secret pads to 16.
        assert_eq!(raw.len(), 16 + 16, "unexpected ciphertext length");
    }
}
