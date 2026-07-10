// At-rest encryption for small local secrets (the WSL account password).
//
// On Windows we use DPAPI (CryptProtectData / CryptUnprotectData): the
// ciphertext is bound to the current Windows user account, so it can't be
// read by another user or moved to another machine. No key to manage, no
// extra crate. The result is stored base64 in a JSON file under the app
// config dir.
//
// On non-Windows the guided WSL flow doesn't run, but to keep the module
// total we fall back to a plain passthrough (callers there don't store a
// WSL password).

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

#[cfg(not(windows))]
pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    Ok(plain.to_vec())
}

#[cfg(not(windows))]
pub fn unprotect(cipher: &[u8]) -> Result<Vec<u8>, String> {
    Ok(cipher.to_vec())
}
