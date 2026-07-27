// At-rest encryption for small local secrets (the WSL account password, the
// agent-browser credential vault).
//
// On Windows we use DPAPI (CryptProtectData / CryptUnprotectData): the
// ciphertext is bound to the current Windows user account, so it can't be
// read by another user or moved to another machine. No key to manage, no
// extra crate. The result is stored base64 in a JSON file under the app
// config dir.
//
// On macOS/Linux there is no DPAPI; see the non-Windows section below for the
// AES-256-GCM + per-user 0600 key-file scheme (with legacy plaintext read
// compatibility for vaults written while this module was a passthrough).

/// Encrypt bytes for the current user. Returns opaque ciphertext.
#[cfg(windows)]
pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: plain.len() as u32,
            pbData: plain.as_ptr() as *mut u8,
        };
        let mut out_blob = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = CryptProtectData(
            &in_blob,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut out_blob,
        );
        if ok == 0 {
            return Err("CryptProtectData failed".into());
        }
        let slice = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize);
        let v = slice.to_vec();
        LocalFree(out_blob.pbData as _);
        Ok(v)
    }
}

/// Decrypt bytes previously produced by `protect` on this machine/account.
#[cfg(windows)]
pub fn unprotect(cipher: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: cipher.len() as u32,
            pbData: cipher.as_ptr() as *mut u8,
        };
        let mut out_blob = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = CryptUnprotectData(
            &in_blob,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut out_blob,
        );
        if ok == 0 {
            return Err("CryptUnprotectData failed".into());
        }
        let slice = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize);
        let v = slice.to_vec();
        LocalFree(out_blob.pbData as _);
        Ok(v)
    }
}

// On macOS/Linux there is no DPAPI. Instead: AES-256-GCM (already in the tree
// for browser import + team envelopes) with a random per-user key kept in a
// 0600-perm file under the app config dir. Another OS user can't read the key,
// and the vault file alone is useless without it. Ciphertext is framed with a
// magic prefix so `unprotect` can still read pre-existing PLAINTEXT blobs from
// the era when this module was a passthrough — those decrypt-as-is and get
// re-encrypted on the next save.
#[cfg(not(windows))]
const MAGIC: &[u8] = b"OWLLMSEC1\n";

/// Seal with an explicit key: MAGIC + 12-byte nonce + AES-256-GCM ciphertext.
/// Pure (no I/O) so it is unit-testable; `protect` supplies the per-user key.
#[cfg(not(windows))]
pub fn seal_with_key(key: &[u8; 32], plain: &[u8]) -> Result<Vec<u8>, String> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Key, Nonce};
    use rand::{rngs::OsRng, RngCore};
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), plain)
        .map_err(|_| "encrypt failed".to_string())?;
    let mut out = Vec::with_capacity(MAGIC.len() + 12 + ct.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Open a `seal_with_key` blob. Data without the magic prefix is treated as
/// legacy plaintext from the passthrough era and returned unchanged.
#[cfg(not(windows))]
pub fn open_with_key(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, String> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Key, Nonce};
    let Some(rest) = data.strip_prefix(MAGIC) else {
        return Ok(data.to_vec()); // legacy plaintext blob
    };
    if rest.len() < 12 {
        return Err("ciphertext too short".to_string());
    }
    let (nonce, ct) = rest.split_at(12);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|_| "decrypt failed (wrong key or corrupted data)".to_string())
}

/// Load — or create on first use — the random per-user vault key. The file
/// lives beside the vaults it protects but is 0600, so only this OS user can
/// read it. Never committed/bundled (config dir is runtime state, and the
/// credential-embed release gate blocks key-named files from the repo).
#[cfg(not(windows))]
fn user_key() -> Result<[u8; 32], String> {
    use rand::{rngs::OsRng, RngCore};
    use std::os::unix::fs::PermissionsExt;
    let dir =
        crate::paths::owllm_config_home().ok_or_else(|| "no config home".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(".vault.key");
    if let Ok(raw) = std::fs::read(&path) {
        if raw.len() == 32 {
            let mut k = [0u8; 32];
            k.copy_from_slice(&raw);
            return Ok(k);
        }
    }
    let mut k = [0u8; 32];
    OsRng.fill_bytes(&mut k);
    std::fs::write(&path, k).map_err(|e| e.to_string())?;
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    Ok(k)
}

#[cfg(not(windows))]
pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    seal_with_key(&user_key()?, plain)
}

#[cfg(not(windows))]
pub fn unprotect(cipher: &[u8]) -> Result<Vec<u8>, String> {
    open_with_key(&user_key()?, cipher)
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [7u8; 32];

    #[test]
    fn seal_open_roundtrip() {
        let sealed = seal_with_key(&KEY, b"hello vault").unwrap();
        assert!(sealed.starts_with(MAGIC));
        assert_ne!(&sealed[MAGIC.len() + 12..], b"hello vault" as &[u8]);
        assert_eq!(open_with_key(&KEY, &sealed).unwrap(), b"hello vault");
    }

    #[test]
    fn legacy_plaintext_passes_through() {
        // Pre-encryption vaults were raw JSON; they must still load.
        let legacy = br#"[{"origin":"https://a.com"}]"#;
        assert_eq!(open_with_key(&KEY, legacy).unwrap(), legacy.to_vec());
    }

    #[test]
    fn wrong_key_and_tamper_fail() {
        let sealed = seal_with_key(&KEY, b"secret").unwrap();
        assert!(open_with_key(&[8u8; 32], &sealed).is_err());
        let mut bad = sealed.clone();
        let last = bad.len() - 1;
        bad[last] ^= 0xff;
        assert!(open_with_key(&KEY, &bad).is_err());
    }

    #[test]
    fn nonce_is_fresh_per_seal() {
        let a = seal_with_key(&KEY, b"x").unwrap();
        let b = seal_with_key(&KEY, b"x").unwrap();
        assert_ne!(a, b);
    }
}
