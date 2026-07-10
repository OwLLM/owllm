// The cryptographic core: device keypairs, and sealing/opening the command
// envelope. This is the property the whole design rests on — the transport is
// untrusted, so the body is sealed to the target's key and signed by the
// controller's key.
//
//   * Ed25519 — identity + signature. `device_id = hex(SHA-256(ed_pub))`, so an
//     id is bound to its signing key and can't be spoofed on its own.
//   * X25519  — ECDH. Each message uses a fresh ephemeral key; the shared secret
//     keys an AES-256-GCM seal of the request. A relay only sees ciphertext.
//
// This module does CRYPTO INTEGRITY ONLY (decrypt + signature + id binding).
// Freshness (ts), replay (nonce), trust, and policy are enforced by the caller
// (`mod.rs`) — deliberately separated so each layer is independently testable.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

use super::protocol::SignedEnvelope;

const KDF_CONTEXT: &[u8] = b"owllm-remote-devices-v1/aead-key";

// ------------------------------------------------------------------
// base64 helpers (standard alphabet, matches the rest of the crate)
// ------------------------------------------------------------------

fn b64(bytes: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD.encode(bytes)
}

fn unb64(s: &str) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD.decode(s).map_err(|e| format!("base64 decode: {e}"))
}

fn arr32(v: &[u8], what: &str) -> Result<[u8; 32], String> {
    v.try_into().map_err(|_| format!("{what}: expected 32 bytes, got {}", v.len()))
}

// ------------------------------------------------------------------
// Key material
// ------------------------------------------------------------------

/// A device's two secret keys (32-byte seeds). Persisted DPAPI-wrapped; never
/// synced. Public halves are derived on demand.
#[derive(Clone)]
pub struct DeviceSecrets {
    pub ed25519_seed: [u8; 32],
    pub x25519_secret: [u8; 32],
}

impl DeviceSecrets {
    /// Fresh random secrets from the OS CSPRNG. We fill raw bytes rather than
    /// using the dalek `generate` helpers so keygen depends only on OsRng.
    pub fn generate() -> Self {
        let mut ed = [0u8; 32];
        let mut xs = [0u8; 32];
        OsRng.fill_bytes(&mut ed);
        OsRng.fill_bytes(&mut xs);
        DeviceSecrets { ed25519_seed: ed, x25519_secret: xs }
    }

    fn signing_key(&self) -> SigningKey {
        SigningKey::from_bytes(&self.ed25519_seed)
    }

    pub fn ed25519_public(&self) -> [u8; 32] {
        self.signing_key().verifying_key().to_bytes()
    }

    pub fn x25519_public(&self) -> [u8; 32] {
        PublicKey::from(&StaticSecret::from(self.x25519_secret)).to_bytes()
    }

    /// The device id derived from the public signing key.
    pub fn device_id(&self) -> String {
        device_id_from_ed_pub(&self.ed25519_public())
    }
}

/// `device_id = hex(SHA-256(ed25519_public_key))`. Deterministic and bound to
/// the key, so the target can re-derive it and reject an envelope whose claimed
/// `from_device` doesn't match its `from_ed25519_pub`.
pub fn device_id_from_ed_pub(ed_pub: &[u8; 32]) -> String {
    let mut h = Sha256::new();
    h.update(ed_pub);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Same, from a base64 Ed25519 public key. None if it isn't a valid 32-byte key.
pub fn device_id_from_ed_pub_b64(ed_pub_b64: &str) -> Option<String> {
    let raw = unb64(ed_pub_b64).ok()?;
    let arr: [u8; 32] = raw.try_into().ok()?;
    Some(device_id_from_ed_pub(&arr))
}

// ------------------------------------------------------------------
// Key derivation for the seal
// ------------------------------------------------------------------

fn derive_key(shared: &[u8; 32], from_ed_pub: &[u8; 32], to_device: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(KDF_CONTEXT);
    h.update(shared);
    h.update(from_ed_pub);
    h.update(to_device.as_bytes());
    let out = h.finalize();
    let mut k = [0u8; 32];
    k.copy_from_slice(&out);
    k
}

// ------------------------------------------------------------------
// Seal (controller side)
// ------------------------------------------------------------------

/// Seal + sign `plaintext` (a serialized `CommandRequest`) for `to_device`.
///
/// `ts` and `nonce` are passed in so callers control freshness/uniqueness and
/// tests are deterministic. The returned envelope is safe to hand to an
/// untrusted transport.
pub fn seal(
    from: &DeviceSecrets,
    to_device: &str,
    to_x25519_pub: &[u8; 32],
    plaintext: &[u8],
    ts: i64,
    nonce_bytes: &[u8],
) -> Result<SignedEnvelope, String> {
    let from_ed_pub = from.ed25519_public();
    let from_device = device_id_from_ed_pub(&from_ed_pub);

    // Fresh ephemeral X25519 for THIS message → forward secrecy per message.
    let mut eph_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut eph_bytes);
    let eph = StaticSecret::from(eph_bytes);
    let eph_pub = PublicKey::from(&eph);

    let recipient = PublicKey::from(*to_x25519_pub);
    let shared = eph.diffie_hellman(&recipient);
    let key = derive_key(shared.as_bytes(), &from_ed_pub, to_device);

    let mut gcm_nonce = [0u8; 12];
    OsRng.fill_bytes(&mut gcm_nonce);

    // Build the header first (everything except ciphertext + sig) so the AAD is
    // stable, then encrypt with the AAD bound in.
    let mut env = SignedEnvelope {
        from_device,
        from_ed25519_pub: b64(&from_ed_pub),
        from_x25519_pub: b64(&from.x25519_public()),
        to_device: to_device.to_string(),
        ts,
        nonce: b64(nonce_bytes),
        eph_x25519_pub: b64(&eph_pub.to_bytes()),
        gcm_nonce: b64(&gcm_nonce),
        ciphertext: String::new(),
        sig: String::new(),
    };

    let aad = env.aad();
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let ct = cipher
        .encrypt(Nonce::from_slice(&gcm_nonce), Payload { msg: plaintext, aad: &aad })
        .map_err(|_| "seal: AEAD encrypt failed".to_string())?;
    env.ciphertext = b64(&ct);

    // Sign the canonical header (now including the ciphertext).
    let sig: Signature = from.signing_key().sign(&env.canonical_header());
    env.sig = b64(&sig.to_bytes());
    Ok(env)
}

// ------------------------------------------------------------------
// Open (target side)
// ------------------------------------------------------------------

/// Verify the signature + id binding and decrypt. Returns the plaintext
/// `CommandRequest` bytes. Does NOT check freshness/replay/trust/policy — the
/// caller does, so those concerns stay out of the crypto unit.
pub fn open(env: &SignedEnvelope, my_x25519_secret: &[u8; 32]) -> Result<Vec<u8>, String> {
    // 1. The claimed id must match the claimed key (cheap, reject spoofed ids).
    let from_ed_pub = arr32(&unb64(&env.from_ed25519_pub)?, "from_ed25519_pub")?;
    if env.from_device != device_id_from_ed_pub(&from_ed_pub) {
        return Err("open: from_device does not match from_ed25519_pub".into());
    }

    // 2. Signature over the whole frame (verify_strict rejects malleable sigs).
    let vk = VerifyingKey::from_bytes(&from_ed_pub).map_err(|e| format!("bad ed25519 pub: {e}"))?;
    let sig_bytes = arr64(&unb64(&env.sig)?, "sig")?;
    let sig = Signature::from_bytes(&sig_bytes);
    vk.verify_strict(&env.canonical_header(), &sig)
        .map_err(|_| "open: signature verification failed".to_string())?;

    // 3. Re-derive the AEAD key and decrypt (the tag also authenticates the AAD).
    let eph_pub = arr32(&unb64(&env.eph_x25519_pub)?, "eph_x25519_pub")?;
    let my = StaticSecret::from(*my_x25519_secret);
    let shared = my.diffie_hellman(&PublicKey::from(eph_pub));
    let key = derive_key(shared.as_bytes(), &from_ed_pub, &env.to_device);

    let gcm_nonce = unb64(&env.gcm_nonce)?;
    if gcm_nonce.len() != 12 {
        return Err("open: bad gcm nonce length".into());
    }
    let ct = unb64(&env.ciphertext)?;
    let aad = env.aad();
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    cipher
        .decrypt(Nonce::from_slice(&gcm_nonce), Payload { msg: &ct, aad: &aad })
        .map_err(|_| "open: AEAD decrypt/verify failed".to_string())
}

fn arr64(v: &[u8], what: &str) -> Result<[u8; 64], String> {
    v.try_into().map_err(|_| format!("{what}: expected 64 bytes, got {}", v.len()))
}

// ------------------------------------------------------------------
// Detached signatures (used to prove key possession on a pairing request)
// ------------------------------------------------------------------

/// Sign arbitrary bytes with this device's Ed25519 key; returns base64.
pub fn sign_detached(from: &DeviceSecrets, msg: &[u8]) -> String {
    let sig: Signature = from.signing_key().sign(msg);
    b64(&sig.to_bytes())
}

/// Verify a base64 detached signature over `msg` against a base64 Ed25519 pubkey.
pub fn verify_detached(ed25519_pub_b64: &str, msg: &[u8], sig_b64: &str) -> Result<(), String> {
    let ed_pub = arr32(&unb64(ed25519_pub_b64)?, "ed25519_pub")?;
    let vk = VerifyingKey::from_bytes(&ed_pub).map_err(|e| format!("bad ed25519 pub: {e}"))?;
    let sig_bytes = arr64(&unb64(sig_b64)?, "sig")?;
    let sig = Signature::from_bytes(&sig_bytes);
    vk.verify_strict(msg, &sig)
        .map_err(|_| "signature verification failed".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nonce24() -> [u8; 24] {
        let mut n = [0u8; 24];
        OsRng.fill_bytes(&mut n);
        n
    }

    #[test]
    fn device_id_is_bound_to_key() {
        let a = DeviceSecrets::generate();
        let b = DeviceSecrets::generate();
        assert_ne!(a.device_id(), b.device_id());
        // Deterministic from the public key.
        assert_eq!(a.device_id(), device_id_from_ed_pub(&a.ed25519_public()));
        assert_eq!(a.device_id().len(), 64); // hex of a 32-byte digest
    }

    #[test]
    fn seal_open_roundtrip() {
        let controller = DeviceSecrets::generate();
        let target = DeviceSecrets::generate();
        let msg = br#"{"request_id":"r1","kind":"diagnostics","command":"","timeout_ms":5000}"#;
        let env = seal(
            &controller,
            &target.device_id(),
            &target.x25519_public(),
            msg,
            1_700_000_000,
            &nonce24(),
        )
        .unwrap();
        // The transport-visible frame is opaque: the plaintext must not appear.
        assert!(!env.ciphertext.contains("diagnostics"));
        let opened = open(&env, &target.x25519_secret).unwrap();
        assert_eq!(opened, msg);
        // And the envelope carries who signed it.
        assert_eq!(env.from_device, controller.device_id());
    }

    #[test]
    fn wrong_recipient_cannot_open() {
        let controller = DeviceSecrets::generate();
        let target = DeviceSecrets::generate();
        let eavesdropper = DeviceSecrets::generate();
        let env = seal(&controller, &target.device_id(), &target.x25519_public(), b"secret", 1, &nonce24()).unwrap();
        // A different X25519 secret derives a different key → decrypt fails.
        assert!(open(&env, &eavesdropper.x25519_secret).is_err());
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let controller = DeviceSecrets::generate();
        let target = DeviceSecrets::generate();
        let mut env = seal(&controller, &target.device_id(), &target.x25519_public(), b"hello", 1, &nonce24()).unwrap();
        // Flip the ciphertext — signature no longer covers it AND the AEAD tag
        // fails. Either way, open() must refuse.
        env.ciphertext = b64(b"totally-different-bytes");
        assert!(open(&env, &target.x25519_secret).is_err());
    }

    #[test]
    fn forged_signature_is_rejected() {
        let controller = DeviceSecrets::generate();
        let target = DeviceSecrets::generate();
        let attacker = DeviceSecrets::generate();
        let mut env = seal(&controller, &target.device_id(), &target.x25519_public(), b"hello", 1, &nonce24()).unwrap();
        // Attacker re-signs the frame with THEIR key but leaves the victim's
        // from_* fields — signature won't verify against the claimed pubkey.
        let sig = attacker.signing_key().sign(&env.canonical_header());
        env.sig = b64(&sig.to_bytes());
        assert!(open(&env, &target.x25519_secret).is_err());
    }

    #[test]
    fn spoofed_device_id_is_rejected() {
        let controller = DeviceSecrets::generate();
        let target = DeviceSecrets::generate();
        let mut env = seal(&controller, &target.device_id(), &target.x25519_public(), b"hi", 1, &nonce24()).unwrap();
        // Claim a different id than the key hashes to.
        env.from_device = "deadbeef".repeat(8);
        assert!(open(&env, &target.x25519_secret).is_err());
    }
}
