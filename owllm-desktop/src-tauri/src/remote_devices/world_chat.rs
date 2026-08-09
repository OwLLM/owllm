// World Map chat — the crypto half, kept in Rust because the private keys are.
//
// This adds NO new key material and NO new identity. It reuses the device
// keypair the fleet already owns, so the id a peer chats with is the same id
// its dot already has on the map:
//
//     device_id   = hex(SHA-256(ed25519_pub))
//     presence_id = hex(SHA-256(domain || device_id))
//
// Two operations live here:
//
//   * signing the service's challenge nonce, which proves to the relay that
//     this install owns the key its map id is derived from; and
//   * sealing/opening message bodies with `crypto::seal`/`crypto::open` — the
//     same authenticated, per-message-forward-secret envelope the remote-device
//     channel uses. The relay stores and forwards that envelope verbatim, so it
//     never holds a readable message.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use rand::{rngs::OsRng, RngCore};
use serde_json::{json, Value};

use super::crypto;
use super::identity;
use super::protocol::SignedEnvelope;

/// Domain separator for the presence challenge. Must stay byte-for-byte
/// identical to `CHAT_AUTH_DOMAIN` in services/world-presence/src/chat.js, and
/// must differ from every other thing this key ever signs — otherwise a
/// signature gathered for one purpose would authenticate another.
const CHAT_AUTH_DOMAIN: &str = "owllm-world-chat-auth-v1\0";

fn b64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

fn unb64_32(value: &str, what: &str) -> Result<[u8; 32], String> {
    let raw = STANDARD
        .decode(value.trim())
        .map_err(|e| format!("{what}: base64 decode: {e}"))?;
    raw.try_into()
        .map_err(|_| format!("{what}: expected 32 bytes"))
}

/// Sign the relay's challenge so it can bind this socket to this device's dot.
pub fn sign_challenge(nonce: &str) -> Result<String, String> {
    let nonce = nonce.trim();
    // The relay issues 32 random bytes as hex; refuse to sign anything else so
    // this command can never be steered into signing attacker-chosen bytes.
    if nonce.len() != 64 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("world chat challenge must be 64 hex characters".into());
    }
    let me = identity::load_or_create()?;
    let mut message = Vec::with_capacity(CHAT_AUTH_DOMAIN.len() + nonce.len());
    message.extend_from_slice(CHAT_AUTH_DOMAIN.as_bytes());
    message.extend_from_slice(nonce.as_bytes());
    Ok(b64(&me.secrets.sign(&message)))
}

/// Seal `text` for the peer that owns `to_ed25519_pub` / `to_x25519_pub`.
///
/// The recipient's device id is re-derived from its signing key rather than
/// accepted from the caller, so a body can only ever be encrypted to the device
/// the presented key actually belongs to.
pub fn seal_message(
    to_ed25519_pub: &str,
    to_x25519_pub: &str,
    text: &str,
) -> Result<String, String> {
    let to_ed = unb64_32(to_ed25519_pub, "peer ed25519 pub")?;
    let to_x = unb64_32(to_x25519_pub, "peer x25519 pub")?;
    let to_device = crypto::device_id_from_ed_pub(&to_ed);
    let me = identity::load_or_create()?;
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let envelope = crypto::seal(
        &me.secrets,
        &to_device,
        &to_x,
        text.as_bytes(),
        super::now_unix(),
        &nonce,
    )?;
    serde_json::to_string(&envelope).map_err(|e| format!("serialize sealed message: {e}"))
}

/// Open a sealed message addressed to this device.
///
/// Returns the plaintext together with the sender's *presence* id, derived from
/// the signature-verified sender key — never from anything the relay said. That
/// is what stops a relay from attributing a message to the wrong dot.
pub fn open_message(envelope_json: &str) -> Result<Value, String> {
    let envelope: SignedEnvelope = serde_json::from_str(envelope_json)
        .map_err(|e| format!("sealed message is not a valid envelope: {e}"))?;
    let me = identity::load_or_create()?;
    if envelope.to_device != me.secrets.device_id() {
        return Err("sealed message is addressed to another device".into());
    }
    let plaintext = crypto::open(&envelope, &me.secrets.x25519_secret)?;
    let text = String::from_utf8(plaintext).map_err(|_| "message body is not UTF-8".to_string())?;
    Ok(json!({
        "from": identity::presence_id(&envelope.from_device),
        "fromDevice": envelope.from_device,
        "fromXPub": envelope.from_x25519_pub,
        "ts": envelope.ts,
        "text": text,
    }))
}

// ==================================================================
// Tauri commands
// ==================================================================

#[tauri::command]
pub fn world_chat_sign(nonce: String) -> Result<String, String> {
    sign_challenge(&nonce)
}

#[tauri::command]
pub fn world_chat_seal(
    to_ed25519_pub: String,
    to_x25519_pub: String,
    text: String,
) -> Result<String, String> {
    seal_message(&to_ed25519_pub, &to_x25519_pub, &text)
}

#[tauri::command]
pub fn world_chat_open(envelope: String) -> Result<Value, String> {
    open_message(&envelope)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A round trip proves the relay format is genuinely end-to-end: the body is
    /// only ever readable by the holder of the recipient's secret key.
    #[test]
    fn seals_and_opens_between_two_devices() {
        let alice = crypto::DeviceSecrets::generate();
        let bob = crypto::DeviceSecrets::generate();
        let mut nonce = [0u8; 24];
        OsRng.fill_bytes(&mut nonce);
        let envelope = crypto::seal(
            &alice,
            &bob.device_id(),
            &bob.x25519_public(),
            b"hello",
            42,
            &nonce,
        )
        .expect("seal");
        let opened = crypto::open(&envelope, &bob.x25519_secret).expect("open");
        assert_eq!(opened, b"hello");
        // A third party holding the ciphertext cannot read it.
        let eve = crypto::DeviceSecrets::generate();
        assert!(crypto::open(&envelope, &eve.x25519_secret).is_err());
    }

    #[test]
    fn refuses_to_sign_anything_that_is_not_a_relay_challenge() {
        assert!(sign_challenge("not-hex").is_err());
        assert!(sign_challenge(&"a".repeat(63)).is_err());
        assert!(sign_challenge("z".repeat(64).as_str()).is_err());
    }
}
