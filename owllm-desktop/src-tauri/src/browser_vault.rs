// Agent-browser credential vault.
//
// Stores site logins the user chooses to save (or imports from a real browser)
// so the agent browser can autofill them. At rest the whole store is encrypted
// with `crypt::protect` on every OS — DPAPI (per Windows user account) on
// Windows, AES-256-GCM with a per-user 0600 key file on macOS/Linux (legacy
// plaintext vaults from before that scheme still load and are re-encrypted on
// the next save). Passwords are never returned to the frontend in `list` —
// only origin/username — and only ever leave Rust by being injected straight
// into the matching page (`fill_login`, or `autofill_eval_for` on page load).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct BrowserCred {
    /// Normalised site origin, e.g. "https://github.com".
    pub origin: String,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub ts: i64,
}

/// What the frontend is allowed to see — never the password.
#[derive(Serialize, Clone, Debug)]
pub struct CredMeta {
    pub origin: String,
    pub username: String,
    pub note: String,
    pub ts: i64,
}

fn vault_path() -> Option<PathBuf> {
    Some(crate::paths::owllm_config_home()?.join("browser_creds.enc"))
}

/// Reduce any URL (or bare host) to a stable "scheme://host[:port]" origin so
/// creds match regardless of path/query. Bare hosts default to https.
pub fn normalize_origin(input: &str) -> String {
    let s = input.trim();
    if s.is_empty() {
        return String::new();
    }
    let with_scheme = if s.contains("://") {
        s.to_string()
    } else {
        format!("https://{s}")
    };
    match url::Url::parse(&with_scheme) {
        Ok(u) => {
            let scheme = u.scheme();
            match u.host_str() {
                Some(host) => match u.port() {
                    Some(p) => format!("{scheme}://{host}:{p}"),
                    None => format!("{scheme}://{host}"),
                },
                None => with_scheme.trim_end_matches('/').to_string(),
            }
        }
        Err(_) => with_scheme.trim_end_matches('/').to_string(),
    }
}

fn load() -> Vec<BrowserCred> {
    let Some(path) = vault_path() else {
        return Vec::new();
    };
    let Ok(cipher) = std::fs::read(&path) else {
        return Vec::new();
    };
    let Ok(plain) = crate::crypt::unprotect(&cipher) else {
        return Vec::new();
    };
    serde_json::from_slice(&plain).unwrap_or_default()
}

fn save(creds: &[BrowserCred]) -> Result<(), String> {
    let path = vault_path().ok_or_else(|| "could not resolve config home".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let plain = serde_json::to_vec(creds).map_err(|e| e.to_string())?;
    let cipher = crate::crypt::protect(&plain)?;
    std::fs::write(&path, cipher).map_err(|e| e.to_string())?;
    Ok(())
}

/// Insert or replace by (origin, username). Returns the merged list. Pure so it
/// can be unit-tested without touching disk.
pub fn upsert(mut creds: Vec<BrowserCred>, cred: BrowserCred) -> Vec<BrowserCred> {
    if let Some(existing) = creds
        .iter_mut()
        .find(|c| c.origin == cred.origin && c.username == cred.username)
    {
        existing.password = cred.password;
        existing.note = cred.note;
        existing.ts = cred.ts;
    } else {
        creds.push(cred);
    }
    creds
}

/// Merge a batch (from import) into the current set, replacing matches. Returns
/// (merged, added_or_updated_count).
pub fn merge_batch(
    current: Vec<BrowserCred>,
    incoming: Vec<BrowserCred>,
) -> (Vec<BrowserCred>, usize) {
    let mut merged = current;
    let mut n = 0;
    for c in incoming {
        if c.origin.is_empty() || c.password.is_empty() {
            continue;
        }
        let before = merged.len();
        let had = merged
            .iter()
            .any(|e| e.origin == c.origin && e.username == c.username);
        merged = upsert(merged, c);
        if !had || merged.len() == before {
            n += 1;
        }
    }
    (merged, n)
}

/// Best-origin-match for a page: exact origin, else same host on any scheme.
pub fn find_for_origin<'a>(creds: &'a [BrowserCred], page_origin: &str) -> Option<&'a BrowserCred> {
    let norm = normalize_origin(page_origin);
    if let Some(c) = creds.iter().find(|c| c.origin == norm) {
        return Some(c);
    }
    let host = url::Url::parse(&norm)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string));
    if let Some(h) = host {
        return creds.iter().find(|c| {
            url::Url::parse(&c.origin)
                .ok()
                .and_then(|u| u.host_str().map(str::to_string))
                == Some(h.clone())
        });
    }
    None
}

/// Resolve one exact saved identity for an origin. Provider login pages can
/// have many saved accounts; never silently choose a different username when
/// the user explicitly selected one.
pub fn find_for_origin_user<'a>(
    creds: &'a [BrowserCred],
    page_origin: &str,
    username: &str,
) -> Option<&'a BrowserCred> {
    let norm = normalize_origin(page_origin);
    let host = url::Url::parse(&norm)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string));
    let username = username.trim();
    creds.iter().find(|c| {
        c.username == username
            && (c.origin == norm
                || (host.is_some()
                    && url::Url::parse(&c.origin)
                        .ok()
                        .and_then(|u| u.host_str().map(str::to_string))
                        == host))
    })
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---- Tauri commands ----

#[tauri::command(async)]
pub fn browser_vault_list() -> Vec<CredMeta> {
    let mut out: Vec<CredMeta> = load()
        .into_iter()
        .map(|c| CredMeta {
            origin: c.origin,
            username: c.username,
            note: c.note,
            ts: c.ts,
        })
        .collect();
    out.sort_by(|a, b| a.origin.cmp(&b.origin).then(a.username.cmp(&b.username)));
    out
}

#[tauri::command(async)]
pub fn browser_vault_add(
    origin: String,
    username: String,
    password: String,
    note: Option<String>,
) -> Result<String, String> {
    let cred = BrowserCred {
        origin: normalize_origin(&origin),
        username: username.trim().to_string(),
        password,
        note: note.unwrap_or_default(),
        ts: now_ms(),
    };
    if cred.origin.is_empty() {
        return Err("origin is required".to_string());
    }
    let merged = upsert(load(), cred);
    save(&merged)?;
    Ok("saved".to_string())
}

#[tauri::command(async)]
pub fn browser_vault_delete(origin: String, username: String) -> Result<String, String> {
    let norm = normalize_origin(&origin);
    let mut creds = load();
    let before = creds.len();
    creds.retain(|c| !(c.origin == norm && c.username == username));
    if creds.len() == before {
        return Ok("nothing to delete".to_string());
    }
    save(&creds)?;
    Ok("deleted".to_string())
}

/// Autofill the current agent-browser page from the vault. Resolves the page's
/// origin from the live window, finds a matching cred, and injects it via the
/// browser bridge. The password only ever travels Rust → the page, never to JS.
#[tauri::command(async)]
pub fn browser_vault_autofill(app: tauri::AppHandle) -> Result<String, String> {
    let info = crate::browser::browser_view(app.clone())?;
    let page_url = serde_json::from_str::<serde_json::Value>(&info)
        .ok()
        .and_then(|v| v.get("url").and_then(|u| u.as_str()).map(str::to_string))
        .unwrap_or_default();
    if page_url.is_empty() {
        return Err("no page open in the agent browser".to_string());
    }
    let creds = load();
    let cred = find_for_origin(&creds, &page_url)
        .ok_or_else(|| format!("no saved login for {}", normalize_origin(&page_url)))?;
    crate::browser::browser_cmd(
        app,
        "fill_login".to_string(),
        serde_json::json!({ "username": cred.username, "password": cred.password }),
    )
}

/// Build the JS eval that autofills a just-loaded agent-browser page, or None
/// when the vault has no login for this URL's origin. Called by the browser UI
/// worker on every page-load-finished event; the password stays inside Rust
/// until the moment it is injected into the page that matched. The injected
/// `__owllmAutofill` (BRIDGE_JS) fills only empty fields.
pub fn autofill_eval_for(page_url: &str) -> Option<String> {
    if !page_url.starts_with("http") {
        return None;
    }
    let creds = load();
    let c = find_for_origin(&creds, page_url)?;
    Some(format!(
        "try{{window.__owllmAutofill&&window.__owllmAutofill({},{})}}catch(e){{}}",
        serde_json::to_string(&c.username).ok()?,
        serde_json::to_string(&c.password).ok()?
    ))
}

/// Build an autofill script for a user-selected account. The password is
/// inserted only into the page's private Rust-owned WebView; it is never
/// returned to React or logged.
pub fn autofill_eval_for_user(page_url: &str, username: &str) -> Option<String> {
    if !page_url.starts_with("http") {
        return None;
    }
    let creds = load();
    let c = find_for_origin_user(&creds, page_url, username)?;
    Some(format!(
        "try{{window.__owllmAutofill&&window.__owllmAutofill({},{})}}catch(e){{}}",
        serde_json::to_string(&c.username).ok()?,
        serde_json::to_string(&c.password).ok()?
    ))
}

/// Arm the selected saved login in a provider's private authentication tab.
/// Cookies remain isolated while the credential is read from the encrypted
/// per-user vault and injected only into that tab.
#[tauri::command(async)]
pub fn browser_vault_autofill_tab(
    app: tauri::AppHandle,
    tab_id: u64,
    username: String,
) -> Result<String, String> {
    let page_url = crate::browser::browser_tab_url(&app, tab_id)?;
    let script = autofill_eval_for_user(&page_url, &username)
        .ok_or_else(|| format!("no saved login for {}", username.trim()))?;
    crate::browser::eval_browser_tab(&app, tab_id, &script)?;
    Ok(format!("armed saved login for {}", username.trim()))
}

/// Save a batch of imported creds. Used by browser_import.
pub fn store_imported(incoming: Vec<BrowserCred>) -> Result<usize, String> {
    let (merged, n) = merge_batch(load(), incoming);
    save(&merged)?;
    Ok(n)
}

/// Auto-save a login the user TYPED into the agent browser. `payload` is the
/// bridge's JSON {origin, username, password} (see BRIDGE_JS reportCred in
/// browser.rs). Blank origins/passwords are silently ignored — there is
/// nothing worth saving and typing continues undisturbed.
pub fn store_typed_login(payload: &str) -> Result<(), String> {
    let v: serde_json::Value = serde_json::from_str(payload).map_err(|e| e.to_string())?;
    let str_of = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let origin = normalize_origin(str_of("origin").trim());
    let password = str_of("password");
    if origin.is_empty() || password.is_empty() {
        return Ok(());
    }
    let merged = upsert(
        load(),
        BrowserCred {
            origin,
            username: str_of("username").trim().to_string(),
            password,
            note: "typed in browser".to_string(),
            ts: now_ms(),
        },
    );
    save(&merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_path_and_defaults_https() {
        assert_eq!(normalize_origin("github.com"), "https://github.com");
        assert_eq!(
            normalize_origin("https://github.com/login?x=1"),
            "https://github.com"
        );
        assert_eq!(
            normalize_origin("http://localhost:3000/app"),
            "http://localhost:3000"
        );
        assert_eq!(
            normalize_origin("  example.com/a/b  "),
            "https://example.com"
        );
    }

    #[test]
    fn upsert_replaces_same_origin_user() {
        let base = vec![BrowserCred {
            origin: "https://a.com".into(),
            username: "u".into(),
            password: "old".into(),
            note: String::new(),
            ts: 1,
        }];
        let merged = upsert(
            base,
            BrowserCred {
                origin: "https://a.com".into(),
                username: "u".into(),
                password: "new".into(),
                note: "n".into(),
                ts: 2,
            },
        );
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].password, "new");
        assert_eq!(merged[0].note, "n");
    }

    #[test]
    fn upsert_adds_distinct_user() {
        let base = vec![BrowserCred {
            origin: "https://a.com".into(),
            username: "u1".into(),
            password: "p".into(),
            note: String::new(),
            ts: 1,
        }];
        let merged = upsert(
            base,
            BrowserCred {
                origin: "https://a.com".into(),
                username: "u2".into(),
                password: "p".into(),
                note: String::new(),
                ts: 1,
            },
        );
        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn merge_batch_skips_empty_and_counts() {
        let (merged, n) = merge_batch(
            vec![],
            vec![
                BrowserCred {
                    origin: "https://a.com".into(),
                    username: "u".into(),
                    password: "p".into(),
                    note: String::new(),
                    ts: 1,
                },
                BrowserCred {
                    origin: String::new(),
                    username: "x".into(),
                    password: "p".into(),
                    note: String::new(),
                    ts: 1,
                }, // skipped: no origin
                BrowserCred {
                    origin: "https://b.com".into(),
                    username: "u".into(),
                    password: String::new(),
                    note: String::new(),
                    ts: 1,
                }, // skipped: no password
            ],
        );
        assert_eq!(merged.len(), 1);
        assert_eq!(n, 1);
    }

    #[test]
    fn find_for_origin_matches_host_across_scheme() {
        let creds = vec![BrowserCred {
            origin: "https://site.com".into(),
            username: "u".into(),
            password: "p".into(),
            note: String::new(),
            ts: 1,
        }];
        assert!(find_for_origin(&creds, "http://site.com/login").is_some());
        assert!(find_for_origin(&creds, "https://other.com").is_none());
    }
}
