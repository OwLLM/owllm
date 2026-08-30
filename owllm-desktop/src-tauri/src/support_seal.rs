//! Seal a bug report so only the OwLLM team can read it.
//!
//! Why this exists: a report from someone who is NOT on the team cannot reach
//! the private intake repo — GitHub masks a repo you have no access to as 404,
//! so their own token dies at the first upload. The one destination a
//! stranger's token can always reach is a public repo. Filing their paths,
//! project names, model list and machine details there in the clear is not
//! acceptable, so the payload is sealed to the team's key before it is posted
//! and the public issue carries nothing but ciphertext.
//!
//! The scheme is the one already proven in `remote_devices::crypto`, minus the
//! parts that only make sense for a live two-way session:
//!
//!   * a fresh ephemeral X25519 keypair per report → ECDH against the team's
//!     long-term public key,
//!   * `SHA-256(context ‖ shared ‖ eph_pub ‖ team_pub)` keys AES-256-GCM,
//!   * the header (version, algorithm, both public values, nonce) is bound in
//!     as AAD, so a downgrade or a swapped key fails the tag.
//!
//! There is deliberately NO signature: the reporter has no identity we trust,
//! and the GitHub account that opened the issue is the only provenance that
//! means anything. This gives confidentiality, not authorship.
//!
//! ONLY the public key is embedded. It is not a credential — it can seal a
//! report and cannot open one. The matching secret is held by the team and
//! never ships, is never committed, and is not required to build or run the
//! app. Reports are opened with `scripts/decrypt-report.mjs`.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

/// The OwLLM team's report-sealing public key (X25519, base64, 32 bytes).
/// Generated 2026-08-27; the secret half lives only on the team's machine.
pub const SUPPORT_REPORT_PUBLIC_KEY_B64: &str = "+1YHp+VxkZsYgN8/+beCgmNkPgCRERf81L6skudq40Y=";

/// Domain separator for the AEAD key derivation. Changing this string breaks
/// every previously sealed report, so it is versioned alongside `SEAL_VERSION`.
const KDF_CONTEXT: &[u8] = b"owllm-support-report-v1/aead-key";

/// Envelope version. Bump together with `KDF_CONTEXT` if the scheme changes.
const SEAL_VERSION: u32 = 1;

/// Named so the decryptor can refuse an envelope it does not understand
/// instead of producing garbage.
const SEAL_ALG: &str = "x25519-aes256gcm";

const ARMOR_BEGIN: &str = "-----BEGIN OWLLM SEALED REPORT-----";
const ARMOR_END: &str = "-----END OWLLM SEALED REPORT-----";

/// GitHub rejects an issue body over 65536 characters. Stay clear of it: a
/// report that is too long must arrive truncated, never be lost.
pub const MAX_SEALED_BODY_CHARS: usize = 60_000;

fn b64(bytes: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD.encode(bytes)
}

fn unb64(s: &str) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD.decode(s).map_err(|e| format!("base64: {e}"))
}

/// `SHA-256(context ‖ shared ‖ eph_pub ‖ recipient_pub)`. Both public values
/// are folded in so a key substituted anywhere in the envelope derives a
/// different AEAD key and the tag fails.
fn derive_key(shared: &[u8; 32], eph_pub: &[u8; 32], recipient_pub: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(KDF_CONTEXT);
    h.update(shared);
    h.update(eph_pub);
    h.update(recipient_pub);
    let out = h.finalize();
    let mut k = [0u8; 32];
    k.copy_from_slice(&out);
    k
}

/// The bytes bound in as AAD — the whole header, in a fixed order, so version,
/// algorithm, ephemeral key, recipient key and nonce are all authenticated.
fn aad(eph_pub_b64: &str, recipient_pub_b64: &str, nonce_b64: &str) -> Vec<u8> {
    format!(
        "v={SEAL_VERSION};alg={SEAL_ALG};epk={eph_pub_b64};rpk={recipient_pub_b64};n={nonce_b64}"
    )
    .into_bytes()
}

/// Seal `plaintext` to the embedded team key and return an armored block that
/// is safe to paste into a public GitHub issue.
pub fn seal_for_support(plaintext: &[u8]) -> Result<String, String> {
    seal_to(SUPPORT_REPORT_PUBLIC_KEY_B64, plaintext)
}

/// Seal to an arbitrary base64 X25519 public key. Split out from
/// `seal_for_support` only so the roundtrip test can use a throwaway keypair
/// instead of needing the team's secret.
pub fn seal_to(recipient_pub_b64: &str, plaintext: &[u8]) -> Result<String, String> {
    let recipient_raw = unb64(recipient_pub_b64)?;
    let recipient_pub: [u8; 32] = recipient_raw
        .as_slice()
        .try_into()
        .map_err(|_| format!("recipient key: expected 32 bytes, got {}", recipient_raw.len()))?;

    let mut eph_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut eph_bytes);
    let eph = StaticSecret::from(eph_bytes);
    let eph_pub = PublicKey::from(&eph).to_bytes();

    let shared = eph.diffie_hellman(&PublicKey::from(recipient_pub));
    let key = derive_key(shared.as_bytes(), &eph_pub, &recipient_pub);

    let mut gcm_nonce = [0u8; 12];
    OsRng.fill_bytes(&mut gcm_nonce);

    let eph_pub_b64 = b64(&eph_pub);
    let nonce_b64 = b64(&gcm_nonce);
    let aad = aad(&eph_pub_b64, recipient_pub_b64, &nonce_b64);

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&gcm_nonce),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| "seal: AEAD encrypt failed".to_string())?;

    let envelope = serde_json::json!({
        "v": SEAL_VERSION,
        "alg": SEAL_ALG,
        "epk": eph_pub_b64,
        "rpk": recipient_pub_b64,
        "n": nonce_b64,
        "ct": b64(&ct),
    });
    let armored = b64(
        serde_json::to_string(&envelope)
            .map_err(|e| format!("seal: envelope: {e}"))?
            .as_bytes(),
    );

    // Wrapped so the block stays readable (and diffable) in an issue body
    // instead of one multi-kilobyte line.
    let mut out = String::with_capacity(armored.len() + armored.len() / 76 + 96);
    out.push_str(ARMOR_BEGIN);
    for (i, ch) in armored.chars().enumerate() {
        if i % 76 == 0 {
            out.push('\n');
        }
        out.push(ch);
    }
    out.push('\n');
    out.push_str(ARMOR_END);
    Ok(out)
}

/// Open an armored block with the matching X25519 secret. Test-only in the
/// app: the team decrypts with `scripts/decrypt-report.mjs`, and shipping an
/// opener the app can never use would be dead code.
#[cfg(test)]
pub fn open_sealed(secret: &[u8; 32], armored: &str) -> Result<Vec<u8>, String> {
    let body: String = armored
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect::<Vec<_>>()
        .join("");
    let raw = unb64(body.trim())?;
    let env: serde_json::Value =
        serde_json::from_slice(&raw).map_err(|e| format!("open: envelope: {e}"))?;
    let field = |k: &str| -> Result<String, String> {
        env.get(k)
            .and_then(|v| v.as_str())
            .map(String::from)
            .ok_or_else(|| format!("open: missing {k}"))
    };
    if env.get("v").and_then(|v| v.as_u64()) != Some(SEAL_VERSION as u64) {
        return Err("open: unsupported envelope version".into());
    }
    if field("alg")? != SEAL_ALG {
        return Err("open: unsupported algorithm".into());
    }
    let (epk_b64, rpk_b64, n_b64, ct_b64) = (field("epk")?, field("rpk")?, field("n")?, field("ct")?);
    let epk: [u8; 32] = unb64(&epk_b64)?
        .as_slice()
        .try_into()
        .map_err(|_| "open: bad ephemeral key".to_string())?;
    let rpk: [u8; 32] = unb64(&rpk_b64)?
        .as_slice()
        .try_into()
        .map_err(|_| "open: bad recipient key".to_string())?;
    let nonce = unb64(&n_b64)?;
    if nonce.len() != 12 {
        return Err("open: bad nonce length".into());
    }
    let shared = StaticSecret::from(*secret).diffie_hellman(&PublicKey::from(epk));
    let key = derive_key(shared.as_bytes(), &epk, &rpk);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &unb64(&ct_b64)?,
                aad: &aad(&epk_b64, &rpk_b64, &n_b64),
            },
        )
        .map_err(|_| "open: AEAD decrypt/verify failed".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn throwaway() -> ([u8; 32], String) {
        let mut s = [0u8; 32];
        OsRng.fill_bytes(&mut s);
        let pubk = PublicKey::from(&StaticSecret::from(s)).to_bytes();
        (s, b64(&pubk))
    }

    #[test]
    fn roundtrip_and_opacity() {
        let (secret, pubk) = throwaway();
        let msg = br#"{"title":"crash on save","reportJson":"C:\\Users\\alice\\Projects"}"#;
        let armored = seal_to(&pubk, msg).unwrap();
        // Nothing identifying may survive into the armored block.
        assert!(!armored.contains("alice"));
        assert!(!armored.contains("crash on save"));
        assert!(armored.starts_with(ARMOR_BEGIN) && armored.ends_with(ARMOR_END));
        assert_eq!(open_sealed(&secret, &armored).unwrap(), msg);
    }

    #[test]
    fn a_different_key_cannot_open_it() {
        let (_, pubk) = throwaway();
        let (other_secret, _) = throwaway();
        let armored = seal_to(&pubk, b"private diagnostics").unwrap();
        assert!(open_sealed(&other_secret, &armored).is_err());
    }

    #[test]
    fn tampering_with_the_header_is_rejected() {
        let (secret, pubk) = throwaway();
        let armored = seal_to(&pubk, b"private diagnostics").unwrap();
        // Re-armor the same envelope with the version field bumped: the AAD no
        // longer matches, so the tag must fail rather than silently downgrade.
        let body: String = armored
            .lines()
            .filter(|l| !l.starts_with("-----"))
            .collect::<Vec<_>>()
            .join("");
        let mut env: serde_json::Value = serde_json::from_slice(&unb64(&body).unwrap()).unwrap();
        env["n"] = serde_json::Value::String(b64(&[0u8; 12]));
        let forged = format!(
            "{ARMOR_BEGIN}\n{}\n{ARMOR_END}",
            b64(serde_json::to_string(&env).unwrap().as_bytes())
        );
        assert!(open_sealed(&secret, &forged).is_err());
    }

    #[test]
    fn the_embedded_team_key_is_a_valid_x25519_public_key() {
        let raw = unb64(SUPPORT_REPORT_PUBLIC_KEY_B64).unwrap();
        assert_eq!(raw.len(), 32, "embedded team key must be 32 bytes");
        // And it must actually seal — a typo'd key would fail here, not in
        // front of a user trying to report a bug.
        assert!(seal_for_support(b"hello").unwrap().contains(ARMOR_BEGIN));
    }
}
