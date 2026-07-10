// Import saved logins from the user's real browsers into the agent-browser
// vault (browser_vault.rs).
//
// Chrome, Edge, Brave and Opera are ALL Chromium — they share one password
// scheme, so one code path covers four of the five requested browsers:
//   * a per-profile AES-256 key lives in `Local State` JSON under
//     os_crypt.encrypted_key, base64 + a 5-byte "DPAPI" prefix, unwrapped with
//     the Windows DPAPI (crypt::unprotect).
//   * each password in the `Login Data` SQLite is a "v10"/"v11" blob:
//     3-byte tag, 12-byte GCM nonce, ciphertext, 16-byte GCM tag — AES-256-GCM.
// Firefox uses NSS (key4.db + logins.json), a different scheme.
//
// SCOPE / HONESTY: full decryption is implemented for the Chromium family on
// WINDOWS (the user's platform). Detection + a saved-login COUNT works
// cross-platform and for Firefox so the UI shows what exists, but importing an
// unsupported combination returns a clear error instead of fabricating data.
// The Chromium key scheme differs on macOS/Linux (Keychain/Secret-Service +
// AES-128-CBC), so those return "not yet supported" rather than wrong output.

use serde::Serialize;
use std::path::PathBuf;

#[derive(Clone, Copy, PartialEq)]
pub enum BrowserKind {
    Chrome,
    Edge,
    Brave,
    Opera,
    Firefox,
}

impl BrowserKind {
    fn id(self) -> &'static str {
        match self {
            BrowserKind::Chrome => "chrome",
            BrowserKind::Edge => "edge",
            BrowserKind::Brave => "brave",
            BrowserKind::Opera => "opera",
            BrowserKind::Firefox => "firefox",
        }
    }
    fn name(self) -> &'static str {
        match self {
            BrowserKind::Chrome => "Google Chrome",
            BrowserKind::Edge => "Microsoft Edge",
            BrowserKind::Brave => "Brave",
            BrowserKind::Opera => "Opera",
            BrowserKind::Firefox => "Firefox",
        }
    }
    fn from_id(s: &str) -> Option<Self> {
        Some(match s {
            "chrome" => BrowserKind::Chrome,
            "edge" => BrowserKind::Edge,
            "brave" => BrowserKind::Brave,
            "opera" => BrowserKind::Opera,
            "firefox" => BrowserKind::Firefox,
            _ => return None,
        })
    }
    fn is_chromium(self) -> bool {
        !matches!(self, BrowserKind::Firefox)
    }
}

const ALL: [BrowserKind; 5] = [
    BrowserKind::Chrome,
    BrowserKind::Edge,
    BrowserKind::Brave,
    BrowserKind::Opera,
    BrowserKind::Firefox,
];

#[derive(Serialize)]
pub struct DetectedBrowser {
    pub id: String,
    pub name: String,
    pub profile: String,
    pub count: usize,
    pub supported: bool,
    /// Why unsupported (empty when supported), shown in the UI.
    pub note: String,
}

/// (user_data_root, default_profile_dir) for a Chromium browser on this OS.
/// `Local State` lives in the user-data root; `Login Data` in the profile.
fn chromium_paths(kind: BrowserKind) -> Option<(PathBuf, PathBuf)> {
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
    let home = std::env::var_os("HOME").map(PathBuf::from);

    if cfg!(windows) {
        let l = local?;
        let a = appdata?;
        let root = match kind {
            BrowserKind::Chrome => l.join("Google").join("Chrome").join("User Data"),
            BrowserKind::Edge => l.join("Microsoft").join("Edge").join("User Data"),
            BrowserKind::Brave => l
                .join("BraveSoftware")
                .join("Brave-Browser")
                .join("User Data"),
            // Opera keeps Local State + profile in one dir under Roaming.
            BrowserKind::Opera => a.join("Opera Software").join("Opera Stable"),
            BrowserKind::Firefox => return None,
        };
        let profile = if kind == BrowserKind::Opera {
            root.clone()
        } else {
            root.join("Default")
        };
        Some((root, profile))
    } else if cfg!(target_os = "macos") {
        let base = home?.join("Library").join("Application Support");
        let root = match kind {
            BrowserKind::Chrome => base.join("Google").join("Chrome"),
            BrowserKind::Edge => base.join("Microsoft Edge"),
            BrowserKind::Brave => base.join("BraveSoftware").join("Brave-Browser"),
            BrowserKind::Opera => base.join("com.operasoftware.Opera"),
            BrowserKind::Firefox => return None,
        };
        let profile = if kind == BrowserKind::Opera {
            root.clone()
        } else {
            root.join("Default")
        };
        Some((root, profile))
    } else {
        let cfg = home?.join(".config");
        let root = match kind {
            BrowserKind::Chrome => cfg.join("google-chrome"),
            BrowserKind::Edge => cfg.join("microsoft-edge"),
            BrowserKind::Brave => cfg.join("BraveSoftware").join("Brave-Browser"),
            BrowserKind::Opera => cfg.join("opera"),
            BrowserKind::Firefox => return None,
        };
        let profile = if kind == BrowserKind::Opera {
            root.clone()
        } else {
            root.join("Default")
        };
        Some((root, profile))
    }
}

/// Firefox default-release profile dir (contains logins.json + key4.db).
fn firefox_profile() -> Option<PathBuf> {
    let roots = if cfg!(windows) {
        vec![std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("Mozilla").join("Firefox"))]
    } else if cfg!(target_os = "macos") {
        vec![std::env::var_os("HOME").map(|h| {
            PathBuf::from(h)
                .join("Library")
                .join("Application Support")
                .join("Firefox")
        })]
    } else {
        vec![std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".mozilla").join("firefox"))]
    };
    let base = roots.into_iter().flatten().find(|p| p.exists())?;
    let profiles = base.join("Profiles");
    let search = if profiles.exists() { profiles } else { base };
    // Prefer a *.default-release, else the first dir holding logins.json.
    let mut fallback = None;
    for entry in std::fs::read_dir(&search).ok()?.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        if p.join("logins.json").exists() {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name.ends_with("default-release") {
                return Some(p);
            }
            fallback.get_or_insert(p);
        }
    }
    fallback
}

/// Count rows in a Chromium `Login Data` DB (copy first — the live file is
/// locked). Best-effort: returns 0 on any error.
fn chromium_count(profile: &PathBuf) -> usize {
    let db = profile.join("Login Data");
    if !db.exists() {
        return 0;
    }
    with_temp_copy(&db, |tmp| {
        let conn = rusqlite::Connection::open(tmp).ok()?;
        conn.query_row("SELECT COUNT(*) FROM logins", [], |r| r.get::<_, i64>(0))
            .ok()
    })
    .unwrap_or(0)
    .max(0) as usize
}

fn firefox_count(profile: &PathBuf) -> usize {
    let f = profile.join("logins.json");
    let Ok(raw) = std::fs::read_to_string(&f) else {
        return 0;
    };
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| v.get("logins").and_then(|l| l.as_array()).map(|a| a.len()))
        .unwrap_or(0)
}

/// Copy `src` to a unique temp file, hand its path to `f`, then remove it.
fn with_temp_copy<T>(src: &PathBuf, f: impl FnOnce(&PathBuf) -> Option<T>) -> Option<T> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::SeqCst);
    let tmp = std::env::temp_dir().join(format!("owllm-import-{}-{}.db", std::process::id(), n));
    std::fs::copy(src, &tmp).ok()?;
    let out = f(&tmp);
    let _ = std::fs::remove_file(&tmp);
    out
}

/// Detect installed browsers with saved-login counts.
#[tauri::command(async)]
pub fn browser_import_scan() -> Vec<DetectedBrowser> {
    let mut out = Vec::new();
    for kind in ALL {
        if kind.is_chromium() {
            if let Some((_root, profile)) = chromium_paths(kind) {
                if profile.join("Login Data").exists() {
                    let supported = cfg!(windows);
                    out.push(DetectedBrowser {
                        id: kind.id().into(),
                        name: kind.name().into(),
                        profile: profile.to_string_lossy().into_owned(),
                        count: chromium_count(&profile),
                        supported,
                        note: if supported {
                            String::new()
                        } else {
                            "import supported on Windows in this build".into()
                        },
                    });
                }
            }
        } else if let Some(profile) = firefox_profile() {
            out.push(DetectedBrowser {
                id: kind.id().into(),
                name: kind.name().into(),
                profile: profile.to_string_lossy().into_owned(),
                count: firefox_count(&profile),
                supported: false,
                note: "Firefox (NSS) import isn't wired up yet — Chrome/Edge/Brave/Opera are"
                    .into(),
            });
        }
    }
    out
}

/// Import saved logins from one browser into the vault. Returns a status line
/// with the number added/updated.
#[tauri::command(async)]
pub fn browser_import_run(id: String) -> Result<String, String> {
    let kind = BrowserKind::from_id(&id).ok_or_else(|| format!("unknown browser '{id}'"))?;
    if !kind.is_chromium() {
        return Err(
            "Firefox import isn't supported in this build yet. Chrome, Edge, Brave and Opera work."
                .into(),
        );
    }
    if !cfg!(windows) {
        return Err(format!(
            "{} import is implemented for Windows in this build. macOS/Linux use a different key store (coming next).",
            kind.name()
        ));
    }
    import_chromium(kind)
}

#[cfg(windows)]
fn import_chromium(kind: BrowserKind) -> Result<String, String> {
    let (root, profile) =
        chromium_paths(kind).ok_or_else(|| "could not locate browser profile".to_string())?;
    let key = chromium_master_key(&root)?;
    let db = profile.join("Login Data");
    if !db.exists() {
        return Err(format!("{} has no saved-login database", kind.name()));
    }
    let rows = with_temp_copy(&db, |tmp| {
        let conn = rusqlite::Connection::open(tmp).ok()?;
        let mut stmt = conn
            .prepare("SELECT origin_url, username_value, password_value FROM logins")
            .ok()?;
        let mapped = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Vec<u8>>(2)?,
                ))
            })
            .ok()?;
        Some(mapped.filter_map(Result::ok).collect::<Vec<_>>())
    })
    .ok_or_else(|| "could not read Login Data (is the browser open? try closing it)".to_string())?;

    let mut creds = Vec::new();
    let now = now_ms();
    for (origin, user, blob) in rows {
        let Some(pw) = decrypt_chromium_password(&blob, &key) else {
            continue;
        };
        if pw.is_empty() {
            continue;
        }
        creds.push(crate::browser_vault::BrowserCred {
            origin: crate::browser_vault::normalize_origin(&origin),
            username: user,
            password: pw,
            note: format!("imported from {}", kind.name()),
            ts: now,
        });
    }
    let n = crate::browser_vault::store_imported(creds)?;
    Ok(format!("Imported {n} login(s) from {}", kind.name()))
}

#[cfg(not(windows))]
fn import_chromium(_kind: BrowserKind) -> Result<String, String> {
    Err("Chromium import is Windows-only in this build.".into())
}

/// Unwrap the AES-256 key from `Local State` via DPAPI. Windows only.
#[cfg(windows)]
fn chromium_master_key(user_data_root: &PathBuf) -> Result<Vec<u8>, String> {
    let ls = user_data_root.join("Local State");
    let raw = std::fs::read_to_string(&ls).map_err(|e| format!("read Local State: {e}"))?;
    let enc = parse_encrypted_key(&raw)
        .ok_or_else(|| "no os_crypt.encrypted_key in Local State".to_string())?;
    crate::crypt::unprotect(&enc).map_err(|e| format!("DPAPI unwrap of browser key failed: {e}"))
}

/// Pure: base64-decode os_crypt.encrypted_key and strip the 5-byte "DPAPI"
/// prefix, yielding the DPAPI blob ready for unprotect. Unit-tested.
fn parse_encrypted_key(local_state_json: &str) -> Option<Vec<u8>> {
    let v: serde_json::Value = serde_json::from_str(local_state_json).ok()?;
    let b64 = v.get("os_crypt")?.get("encrypted_key")?.as_str()?;
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    if bytes.len() > 5 && &bytes[..5] == b"DPAPI" {
        Some(bytes[5..].to_vec())
    } else {
        Some(bytes)
    }
}

/// Split a "v10"/"v11" blob into (nonce, ciphertext+tag). Pure, unit-tested.
fn split_v10(blob: &[u8]) -> Option<(&[u8], &[u8])> {
    if blob.len() > 15 && (&blob[..3] == b"v10" || &blob[..3] == b"v11") {
        Some((&blob[3..15], &blob[15..]))
    } else {
        None
    }
}

/// Decrypt one Chromium password blob with the profile key. v10/v11 → AES-256-GCM;
/// legacy blobs → DPAPI directly (Windows).
#[cfg(windows)]
fn decrypt_chromium_password(blob: &[u8], key: &[u8]) -> Option<String> {
    if let Some((nonce, ct)) = split_v10(blob) {
        use aes_gcm::aead::{Aead, KeyInit};
        use aes_gcm::{Aes256Gcm, Key, Nonce};
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
        let plain = cipher.decrypt(Nonce::from_slice(nonce), ct).ok()?;
        return String::from_utf8(plain).ok();
    }
    // Pre-v80 Chromium: the whole blob is a DPAPI ciphertext.
    let plain = crate::crypt::unprotect(blob).ok()?;
    String::from_utf8(plain).ok()
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    #[test]
    fn parse_key_strips_dpapi_prefix() {
        let mut blob = b"DPAPI".to_vec();
        blob.extend_from_slice(&[1, 2, 3, 4]);
        let b64 = base64::engine::general_purpose::STANDARD.encode(&blob);
        let json = format!(r#"{{"os_crypt":{{"encrypted_key":"{b64}"}}}}"#);
        assert_eq!(parse_encrypted_key(&json), Some(vec![1, 2, 3, 4]));
    }

    #[test]
    fn parse_key_without_prefix_kept() {
        let b64 = base64::engine::general_purpose::STANDARD.encode([9, 9, 9]);
        let json = format!(r#"{{"os_crypt":{{"encrypted_key":"{b64}"}}}}"#);
        assert_eq!(parse_encrypted_key(&json), Some(vec![9, 9, 9]));
    }

    #[test]
    fn parse_key_missing_returns_none() {
        assert_eq!(parse_encrypted_key(r#"{"os_crypt":{}}"#), None);
        assert_eq!(parse_encrypted_key("not json"), None);
    }

    #[test]
    fn split_v10_frames_nonce_and_body() {
        let mut blob = b"v10".to_vec();
        blob.extend_from_slice(&[7u8; 12]); // nonce
        blob.extend_from_slice(&[42u8; 20]); // ct + tag
        let (nonce, ct) = split_v10(&blob).unwrap();
        assert_eq!(nonce, &[7u8; 12]);
        assert_eq!(ct, &[42u8; 20]);
    }

    #[test]
    fn split_v10_rejects_short_or_untagged() {
        assert!(split_v10(b"v10short").is_none());
        assert!(split_v10(b"plaintextblobwithoutversiontag").is_none());
    }
}
