// Code-signing credential vault — the one place a developer stores everything
// needed to ship a SIGNED build, so it is reachable from every OwLLM instance
// and from the coding agents (whatever project they're started in).
//
// The pain this removes: setting up macOS Developer ID signing + notarization
// (and Windows Authenticode) is a scavenger hunt across Apple's portal, the
// Keychain, GitHub Actions secrets and half-remembered `openssl`/`security`
// incantations. Non-experts get stuck. This module keeps the whole set in one
// encrypted store with a management page on top of it.
//
// At rest the store is encrypted with `crypt::protect` — DPAPI (per Windows
// user account) on Windows; on macOS/Linux `crypt` is currently a passthrough,
// so the file is NOT yet encrypted there (same known limitation as
// browser_vault.rs, called out in the UI). Secret values (the .p12/.pfx bytes
// and the passwords) are NEVER returned to the frontend by `signing_status`;
// they only leave Rust through the explicit `signing_export_env` reveal path
// (used by "Push to GitHub secrets" and the agent tool) — the same trust
// boundary the agent already crosses via `device_exec`/`agent_secrets.json`.
//
// "Shared within the running instances": every OwLLM window / fleet worktree on
// the same machine reads the same `owllm_config_home()` store, so a cert saved
// in one is instantly usable in all. Across the user's *other* PCs, the vault
// (vault.rs::vault_sync_signing) mirrors the NON-secret metadata only (identity,
// team id, expiry, which fields are present) — the secret material stays local
// per machine, consistent with the vault's "no secrets in the git repo" rule.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// ---------------------------------------------------------------------------
// On-disk model (encrypted). Only this struct is ever persisted.
// ---------------------------------------------------------------------------

/// The Apple Developer ID set. Field names map 1:1 onto the `APPLE_*` GitHub
/// Actions secrets consumed by `.github/workflows/release.yml`.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct AppleSigning {
    /// The Developer ID Application certificate + private key as a base64 .p12.
    /// → APPLE_CERTIFICATE. Secret.
    #[serde(default)]
    pub certificate_p12_b64: String,
    /// Passphrase that opens the .p12. → APPLE_CERTIFICATE_PASSWORD. Secret.
    #[serde(default)]
    pub certificate_password: String,
    /// "Developer ID Application: <name> (<TEAMID>)". → APPLE_SIGNING_IDENTITY.
    #[serde(default)]
    pub signing_identity: String,
    /// Apple ID e-mail used for notarization. → APPLE_ID.
    #[serde(default)]
    pub apple_id: String,
    /// App-specific password for notarization (NOT the account password).
    /// → APPLE_PASSWORD. Secret.
    #[serde(default)]
    pub app_specific_password: String,
    /// 10-char Team ID. → APPLE_TEAM_ID.
    #[serde(default)]
    pub team_id: String,
    /// Certificate expiry, as parsed from the .p12 at import time
    /// ("notAfter"), stored as epoch-ms. 0 = unknown.
    #[serde(default)]
    pub cert_not_after_ms: i64,
    /// Certificate subject line, parsed at import ("CN=…"). Display only.
    #[serde(default)]
    pub cert_subject: String,
    /// Last time this set was written (epoch-ms).
    #[serde(default)]
    pub updated_ms: i64,
}

/// The Windows Authenticode set. Field names map onto `release.rs::SignCfg`
/// (`OWLLM_SIGN_*`). Forward-looking companion to the Apple set — the same page
/// manages both so a cross-platform release has one home for its keys.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct WindowsSigning {
    /// Optional base64 .pfx (when signing from a file rather than a mounted
    /// hardware/cloud cert). Secret.
    #[serde(default)]
    pub certificate_pfx_b64: String,
    /// Passphrase for the .pfx. Secret.
    #[serde(default)]
    pub certificate_password: String,
    /// SHA-1 thumbprint selector (cert already in the Windows store / on a
    /// token). → OWLLM_SIGN_THUMBPRINT.
    #[serde(default)]
    pub thumbprint: String,
    /// Subject-name selector. → OWLLM_SIGN_SUBJECT.
    #[serde(default)]
    pub subject: String,
    /// RFC3161 timestamp authority URL. → OWLLM_SIGN_TSA.
    #[serde(default)]
    pub tsa: String,
    #[serde(default)]
    pub updated_ms: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct SigningVault {
    #[serde(default)]
    pub apple: Option<AppleSigning>,
    #[serde(default)]
    pub windows: Option<WindowsSigning>,
}

fn vault_path() -> Option<PathBuf> {
    Some(crate::paths::owllm_config_home()?.join("signing_vault.enc"))
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn load() -> SigningVault {
    let Some(path) = vault_path() else {
        return SigningVault::default();
    };
    let Ok(cipher) = std::fs::read(&path) else {
        return SigningVault::default();
    };
    let Ok(plain) = crate::crypt::unprotect(&cipher) else {
        return SigningVault::default();
    };
    serde_json::from_slice(&plain).unwrap_or_default()
}

fn save(vault: &SigningVault) -> Result<(), String> {
    let path = vault_path().ok_or_else(|| "could not resolve config home".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let plain = serde_json::to_vec(vault).map_err(|e| e.to_string())?;
    let cipher = crate::crypt::protect(&plain)?;
    std::fs::write(&path, cipher).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Frontend-safe view. NEVER carries the .p12/.pfx bytes or any password.
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppleStatus {
    /// A certificate (.p12) is stored.
    pub has_certificate: bool,
    /// The .p12 password is stored.
    pub has_certificate_password: bool,
    /// The app-specific (notarization) password is stored.
    pub has_app_password: bool,
    pub signing_identity: String,
    pub apple_id: String,
    pub team_id: String,
    pub cert_subject: String,
    /// Expiry epoch-ms (0 = unknown).
    pub cert_not_after_ms: i64,
    /// Whole days until expiry (negative once expired; None when unknown).
    pub days_left: Option<i64>,
    /// True when every field a signed+notarized release needs is present.
    pub ready: bool,
    pub updated_ms: i64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WindowsStatus {
    pub has_certificate: bool,
    pub has_certificate_password: bool,
    pub thumbprint: String,
    pub subject: String,
    pub tsa: String,
    /// A selector (thumbprint or subject) OR a .pfx is present.
    pub ready: bool,
    pub updated_ms: i64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SigningStatus {
    pub apple: Option<AppleStatus>,
    pub windows: Option<WindowsStatus>,
}

fn nonempty(s: &str) -> bool {
    !s.trim().is_empty()
}

fn days_left(not_after_ms: i64) -> Option<i64> {
    if not_after_ms <= 0 {
        return None;
    }
    Some((not_after_ms - now_ms()) / 86_400_000)
}

fn apple_status(a: &AppleSigning) -> AppleStatus {
    let ready = nonempty(&a.certificate_p12_b64)
        && nonempty(&a.certificate_password)
        && nonempty(&a.signing_identity)
        && nonempty(&a.apple_id)
        && nonempty(&a.app_specific_password)
        && nonempty(&a.team_id);
    AppleStatus {
        has_certificate: nonempty(&a.certificate_p12_b64),
        has_certificate_password: nonempty(&a.certificate_password),
        has_app_password: nonempty(&a.app_specific_password),
        signing_identity: a.signing_identity.clone(),
        apple_id: a.apple_id.clone(),
        team_id: a.team_id.clone(),
        cert_subject: a.cert_subject.clone(),
        cert_not_after_ms: a.cert_not_after_ms,
        days_left: days_left(a.cert_not_after_ms),
        ready,
        updated_ms: a.updated_ms,
    }
}

fn windows_status(w: &WindowsSigning) -> WindowsStatus {
    let ready = nonempty(&w.thumbprint) || nonempty(&w.subject) || nonempty(&w.certificate_pfx_b64);
    WindowsStatus {
        has_certificate: nonempty(&w.certificate_pfx_b64),
        has_certificate_password: nonempty(&w.certificate_password),
        thumbprint: w.thumbprint.clone(),
        subject: w.subject.clone(),
        tsa: w.tsa.clone(),
        ready,
        updated_ms: w.updated_ms,
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub fn signing_status() -> SigningStatus {
    let v = load();
    SigningStatus {
        apple: v.apple.as_ref().map(apple_status),
        windows: v.windows.as_ref().map(windows_status),
    }
}

/// Input for saving the Apple set. Non-secret fields (`signing_identity`,
/// `apple_id`, `team_id`) are set verbatim (empty clears them). The three
/// SECRET fields (`certificate_p12_b64`, `certificate_password`,
/// `app_specific_password`) follow "empty = keep the existing value" so the UI
/// can edit metadata without forcing the user to re-enter the certificate.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppleSaveInput {
    #[serde(default)]
    pub signing_identity: String,
    #[serde(default)]
    pub apple_id: String,
    #[serde(default)]
    pub team_id: String,
    #[serde(default)]
    pub app_specific_password: String,
    #[serde(default)]
    pub certificate_p12_b64: String,
    #[serde(default)]
    pub certificate_password: String,
}

/// Pure merge so it can be unit-tested without disk. `secret_or_keep` picks the
/// new value when non-empty, else preserves `prev`.
pub fn apply_apple(prev: Option<AppleSigning>, input: AppleSaveInput) -> AppleSigning {
    let prev = prev.unwrap_or_default();
    let secret_or_keep = |new: String, old: &str| {
        if new.trim().is_empty() {
            old.to_string()
        } else {
            new
        }
    };
    AppleSigning {
        certificate_p12_b64: secret_or_keep(input.certificate_p12_b64, &prev.certificate_p12_b64),
        certificate_password: secret_or_keep(
            input.certificate_password,
            &prev.certificate_password,
        ),
        signing_identity: input.signing_identity.trim().to_string(),
        apple_id: input.apple_id.trim().to_string(),
        app_specific_password: secret_or_keep(
            input.app_specific_password,
            &prev.app_specific_password,
        ),
        team_id: input.team_id.trim().to_string(),
        // Preserve parsed metadata; import is the only writer of these.
        cert_not_after_ms: prev.cert_not_after_ms,
        cert_subject: prev.cert_subject,
        updated_ms: now_ms(),
    }
}

#[tauri::command(async)]
pub fn signing_apple_save(input: AppleSaveInput) -> Result<SigningStatus, String> {
    let mut v = load();
    v.apple = Some(apply_apple(v.apple.take(), input));
    save(&v)?;
    Ok(signing_status())
}

/// Import a Developer ID .p12 (certificate + private key). Reads the file,
/// base64-encodes it into the store, and — best-effort — parses the identity +
/// expiry via `openssl` when it's available (so the page can show a countdown).
/// The .p12 password is also the `APPLE_CERTIFICATE_PASSWORD` secret and is
/// stored. Parsing failures are non-fatal: the cert still saves, expiry just
/// shows "unknown".
#[tauri::command(async)]
pub fn signing_apple_import_p12(path: String, password: String) -> Result<SigningStatus, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
    if bytes.is_empty() {
        return Err("the selected .p12 file is empty".into());
    }
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

    let mut v = load();
    let mut apple = v.apple.take().unwrap_or_default();
    apple.certificate_p12_b64 = b64;
    apple.certificate_password = password.clone();

    // Best-effort metadata from the cert inside the .p12.
    if let Some((subject, identity, not_after_ms)) = parse_p12_meta(&path, &password) {
        if nonempty(&subject) {
            apple.cert_subject = subject;
        }
        // Only auto-fill the identity if the user hasn't set one already.
        if apple.signing_identity.trim().is_empty() && nonempty(&identity) {
            apple.signing_identity = identity;
        }
        if not_after_ms > 0 {
            apple.cert_not_after_ms = not_after_ms;
        }
    }
    apple.updated_ms = now_ms();
    v.apple = Some(apple);
    save(&v)?;
    Ok(signing_status())
}

#[tauri::command(async)]
pub fn signing_windows_save(
    thumbprint: String,
    subject: String,
    tsa: String,
    certificate_pfx_b64: String,
    certificate_password: String,
) -> Result<SigningStatus, String> {
    let mut v = load();
    let prev = v.windows.take().unwrap_or_default();
    let keep = |new: String, old: &str| {
        if new.trim().is_empty() {
            old.to_string()
        } else {
            new
        }
    };
    v.windows = Some(WindowsSigning {
        certificate_pfx_b64: keep(certificate_pfx_b64, &prev.certificate_pfx_b64),
        certificate_password: keep(certificate_password, &prev.certificate_password),
        thumbprint: thumbprint.trim().to_string(),
        subject: subject.trim().to_string(),
        tsa: tsa.trim().to_string(),
        updated_ms: now_ms(),
    });
    save(&v)?;
    Ok(signing_status())
}

/// Drop one platform's stored set (or clear the whole vault when `platform`
/// is "all").
#[tauri::command(async)]
pub fn signing_clear(platform: String) -> Result<SigningStatus, String> {
    let mut v = load();
    match platform.as_str() {
        "apple" => v.apple = None,
        "windows" => v.windows = None,
        "all" => v = SigningVault::default(),
        other => return Err(format!("unknown platform: {other}")),
    }
    save(&v)?;
    Ok(signing_status())
}

/// Reveal the CI environment values for one platform. THIS RETURNS SECRETS —
/// it's the deliberate export path used by "Push to GitHub secrets" and the
/// signing agent tool. For Apple it yields the six `APPLE_*` names the release
/// workflow reads; for Windows the `OWLLM_SIGN_*` selectors.
#[tauri::command(async)]
pub fn signing_export_env(platform: String) -> Result<BTreeMap<String, String>, String> {
    let v = load();
    let mut out = BTreeMap::new();
    match platform.as_str() {
        "apple" => {
            let a = v.apple.ok_or_else(|| "no Apple signing set stored".to_string())?;
            out.insert("APPLE_CERTIFICATE".into(), a.certificate_p12_b64);
            out.insert("APPLE_CERTIFICATE_PASSWORD".into(), a.certificate_password);
            out.insert("APPLE_SIGNING_IDENTITY".into(), a.signing_identity);
            out.insert("APPLE_ID".into(), a.apple_id);
            out.insert("APPLE_PASSWORD".into(), a.app_specific_password);
            out.insert("APPLE_TEAM_ID".into(), a.team_id);
        }
        "windows" => {
            let w = v.windows.ok_or_else(|| "no Windows signing set stored".to_string())?;
            out.insert("OWLLM_SIGN_THUMBPRINT".into(), w.thumbprint);
            out.insert("OWLLM_SIGN_SUBJECT".into(), w.subject);
            out.insert("OWLLM_SIGN_TSA".into(), w.tsa);
        }
        other => return Err(format!("unknown platform: {other}")),
    }
    Ok(out)
}

/// Push the stored signing secrets to a GitHub repository's Actions secrets,
/// via the `gh` CLI (which handles libsodium sealed-box encryption). Only the
/// non-empty values are pushed. Returns a human-readable log. When `gh` is not
/// installed the command fails with guidance — the copy-values fallback in the
/// UI (and the agent path) still work.
#[tauri::command(async)]
pub fn signing_push_github(
    owner: String,
    repo: String,
    platform: String,
) -> Result<String, String> {
    let slug = format!("{}/{}", owner.trim(), repo.trim());
    if owner.trim().is_empty() || repo.trim().is_empty() {
        return Err("owner and repo are required (e.g. myorg/myapp)".into());
    }
    if !gh_available() {
        return Err(
            "the GitHub CLI (`gh`) is not on PATH. Install it and run `gh auth login`, or use \
             'Copy values' and paste them into the repo's Settings → Secrets."
                .into(),
        );
    }
    let env = signing_export_env(platform)?;
    let mut log = String::new();
    let mut pushed = 0usize;
    for (name, value) in &env {
        if value.trim().is_empty() {
            log.push_str(&format!("· {name}: (empty — skipped)\n"));
            continue;
        }
        match gh_set_secret(&slug, name, value) {
            Ok(()) => {
                pushed += 1;
                log.push_str(&format!("✓ {name} set\n"));
            }
            Err(e) => log.push_str(&format!("✗ {name}: {e}\n")),
        }
    }
    log.push_str(&format!("\n{pushed} secret(s) written to {slug}."));
    Ok(log)
}

fn gh_available() -> bool {
    let mut cmd = Command::new("gh");
    cmd.arg("--version");
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

fn gh_set_secret(slug: &str, name: &str, value: &str) -> Result<(), String> {
    let mut cmd = Command::new("gh");
    cmd.args(["secret", "set", name, "--repo", slug, "--body", value]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|e| format!("spawn gh: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

// ---------------------------------------------------------------------------
// Agent access — reachable from every project's coding agent.
// ---------------------------------------------------------------------------

/// Backing for the `signing_get` agent tool (local + MCP-gateway paths). Returns
/// the frontend-safe status always, and — only when `include_secrets` is true —
/// the CI env values for `platform`. Same reveal boundary as `signing_export_env`.
pub fn agent_get(platform: &str, include_secrets: bool) -> Result<serde_json::Value, String> {
    let status = signing_status();
    let mut obj = serde_json::json!({ "status": status });
    if include_secrets {
        let env = signing_export_env(platform.to_string())?;
        obj["env"] = serde_json::to_value(env).map_err(|e| e.to_string())?;
    }
    Ok(obj)
}

#[tauri::command(async)]
pub fn signing_agent_get(
    platform: String,
    include_secrets: bool,
) -> Result<serde_json::Value, String> {
    agent_get(&platform, include_secrets)
}

// ---------------------------------------------------------------------------
// Cross-device vault sync — NON-SECRET metadata only.
//
// The certificate bytes + passwords never leave the machine (the vault is a
// GitHub repo; secrets don't belong there). What syncs is enough for the user's
// other PCs to SEE that signing is configured — identity, team, expiry — and
// know to import the .p12 locally. Last-writer-wins by per-platform updated_ms.
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Default)]
struct AppleMeta {
    #[serde(default)]
    signing_identity: String,
    #[serde(default)]
    apple_id: String,
    #[serde(default)]
    team_id: String,
    #[serde(default)]
    cert_subject: String,
    #[serde(default)]
    cert_not_after_ms: i64,
    /// Informational: whether the source device holds the actual certificate.
    #[serde(default)]
    has_certificate: bool,
    #[serde(default)]
    updated_ms: i64,
}

#[derive(Serialize, Deserialize, Default)]
struct WindowsMeta {
    #[serde(default)]
    thumbprint: String,
    #[serde(default)]
    subject: String,
    #[serde(default)]
    tsa: String,
    #[serde(default)]
    has_certificate: bool,
    #[serde(default)]
    updated_ms: i64,
}

#[derive(Serialize, Deserialize, Default)]
struct SigningMeta {
    #[serde(default)]
    apple: Option<AppleMeta>,
    #[serde(default)]
    windows: Option<WindowsMeta>,
}

/// The non-secret metadata blob to publish to the vault, or None when nothing
/// is stored.
pub fn vault_meta_json() -> Option<String> {
    let v = load();
    if v.apple.is_none() && v.windows.is_none() {
        return None;
    }
    let meta = SigningMeta {
        apple: v.apple.as_ref().map(|a| AppleMeta {
            signing_identity: a.signing_identity.clone(),
            apple_id: a.apple_id.clone(),
            team_id: a.team_id.clone(),
            cert_subject: a.cert_subject.clone(),
            cert_not_after_ms: a.cert_not_after_ms,
            has_certificate: nonempty(&a.certificate_p12_b64),
            updated_ms: a.updated_ms,
        }),
        windows: v.windows.as_ref().map(|w| WindowsMeta {
            thumbprint: w.thumbprint.clone(),
            subject: w.subject.clone(),
            tsa: w.tsa.clone(),
            has_certificate: nonempty(&w.certificate_pfx_b64),
            updated_ms: w.updated_ms,
        }),
    };
    serde_json::to_string_pretty(&meta).ok()
}

/// Merge a peer's metadata blob into the local store. Only NON-secret fields are
/// touched, and only when the peer's per-platform `updated_ms` is newer than
/// ours. Local certificate bytes + passwords are always preserved. Returns true
/// when anything changed locally. Pure-ish: reads/writes the store.
pub fn ingest_vault_meta(json: &str) -> Result<bool, String> {
    let remote: SigningMeta = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let mut v = load();
    let mut changed = false;

    if let Some(ra) = remote.apple {
        let local_ms = v.apple.as_ref().map(|a| a.updated_ms).unwrap_or(0);
        if ra.updated_ms > local_ms {
            let mut a = v.apple.take().unwrap_or_default();
            a.signing_identity = ra.signing_identity;
            a.apple_id = ra.apple_id;
            a.team_id = ra.team_id;
            a.cert_subject = ra.cert_subject;
            a.cert_not_after_ms = ra.cert_not_after_ms;
            a.updated_ms = ra.updated_ms;
            v.apple = Some(a); // secret fields (if any) preserved via take()+default merge
            changed = true;
        }
    }
    if let Some(rw) = remote.windows {
        let local_ms = v.windows.as_ref().map(|w| w.updated_ms).unwrap_or(0);
        if rw.updated_ms > local_ms {
            let mut w = v.windows.take().unwrap_or_default();
            w.thumbprint = rw.thumbprint;
            w.subject = rw.subject;
            w.tsa = rw.tsa;
            w.updated_ms = rw.updated_ms;
            v.windows = Some(w);
            changed = true;
        }
    }
    if changed {
        save(&v)?;
    }
    Ok(changed)
}

// ---------------------------------------------------------------------------
// openssl-based .p12 metadata parsing (best-effort, never fatal)
// ---------------------------------------------------------------------------

/// Locate an `openssl` executable. PATH first, then the copy Git-for-Windows
/// ships under `usr/bin` (common on dev machines, not on PATH).
fn openssl_bin() -> Option<String> {
    if probe_openssl("openssl") {
        return Some("openssl".into());
    }
    #[cfg(windows)]
    {
        for base in [
            "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
            "C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe",
        ] {
            if std::path::Path::new(base).exists() && probe_openssl(base) {
                return Some(base.to_string());
            }
        }
    }
    None
}

fn probe_openssl(bin: &str) -> bool {
    let mut cmd = Command::new(bin);
    cmd.arg("version");
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

fn run_openssl(bin: &str, args: &[&str], stdin: Option<&[u8]>) -> Option<Vec<u8>> {
    use std::io::Write;
    let mut cmd = Command::new(bin);
    cmd.args(args);
    cmd.stdout(Stdio::piped()).stderr(Stdio::null());
    cmd.stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().ok()?;
    if let Some(data) = stdin {
        child.stdin.take()?.write_all(data).ok()?;
    }
    let out = child.wait_with_output().ok()?;
    if out.status.success() && !out.stdout.is_empty() {
        Some(out.stdout)
    } else {
        None
    }
}

/// Returns (subject, derived_identity, not_after_epoch_ms) parsed from the .p12.
/// The identity is derived as `"<CN> (<TEAM>)"` only when both the common name
/// and an OU/team can be read; otherwise it's empty and the user supplies it.
fn parse_p12_meta(p12_path: &str, password: &str) -> Option<(String, String, i64)> {
    let bin = openssl_bin()?;
    let passin = format!("pass:{password}");
    // Extract the leaf certificate as PEM. Try modern first, then -legacy
    // (OpenSSL 3 needs it for the older RC2-40 PBE Keychain/`openssl` emits).
    let pem = run_openssl(
        &bin,
        &[
            "pkcs12", "-in", p12_path, "-clcerts", "-nokeys", "-passin", &passin,
        ],
        None,
    )
    .or_else(|| {
        run_openssl(
            &bin,
            &[
                "pkcs12", "-in", p12_path, "-clcerts", "-nokeys", "-passin", &passin, "-legacy",
            ],
            None,
        )
    })?;

    // Read notAfter + subject from the PEM via `openssl x509`.
    let info = run_openssl(
        &bin,
        &["x509", "-noout", "-enddate", "-subject", "-nameopt", "RFC2253"],
        Some(&pem),
    )?;
    let text = String::from_utf8_lossy(&info);
    parse_x509_text(&text)
}

/// Parse the `notAfter=…` / `subject=…` lines `openssl x509` prints. Split out
/// so it's unit-testable without openssl installed.
fn parse_x509_text(text: &str) -> Option<(String, String, i64)> {
    let mut subject = String::new();
    let mut not_after_ms = 0i64;
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("notAfter=") {
            not_after_ms = parse_openssl_date(rest.trim()).unwrap_or(0);
        } else if let Some(rest) = line.strip_prefix("subject=") {
            subject = rest.trim().to_string();
        }
    }
    let identity = derive_identity(&subject);
    if subject.is_empty() && not_after_ms == 0 {
        return None;
    }
    Some((subject, identity, not_after_ms))
}

/// "Feb  1 12:00:00 2027 GMT" → epoch-ms. Uses chrono; returns None on any
/// unexpected shape so a locale/format surprise never aborts the import.
fn parse_openssl_date(s: &str) -> Option<i64> {
    use chrono::NaiveDateTime;
    // openssl pads single-digit days with a second space — normalise runs of
    // whitespace to one so "%b %e" parsing is stable.
    let norm = s.split_whitespace().collect::<Vec<_>>().join(" ");
    // Drop a trailing timezone token (GMT); openssl always prints GMT/UTC.
    let core = norm.trim_end_matches(" GMT").trim_end_matches(" UTC");
    let dt = NaiveDateTime::parse_from_str(core, "%b %d %H:%M:%S %Y").ok()?;
    Some(dt.and_utc().timestamp_millis())
}

/// Best-effort "Developer ID Application: <CN> (<TEAM>)" from an RFC2253
/// subject. Apple leaf certs carry CN="Developer ID Application: Name (TEAM)"
/// already, so when the CN starts with that prefix we return it verbatim.
fn derive_identity(subject: &str) -> String {
    for part in subject.split(',') {
        let part = part.trim();
        if let Some(cn) = part.strip_prefix("CN=") {
            let cn = cn.trim();
            if cn.starts_with("Developer ID Application") {
                return cn.to_string();
            }
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_apple_keeps_secrets_when_blank() {
        let prev = AppleSigning {
            certificate_p12_b64: "CERT".into(),
            certificate_password: "P12PW".into(),
            signing_identity: "old identity".into(),
            apple_id: "old@x.com".into(),
            app_specific_password: "APPPW".into(),
            team_id: "OLDTEAM".into(),
            cert_not_after_ms: 123,
            cert_subject: "CN=x".into(),
            updated_ms: 1,
        };
        // Edit only the non-secret metadata; leave secret fields blank.
        let merged = apply_apple(
            Some(prev),
            AppleSaveInput {
                signing_identity: "new identity".into(),
                apple_id: "new@x.com".into(),
                team_id: "NEWTEAM".into(),
                app_specific_password: String::new(),
                certificate_p12_b64: String::new(),
                certificate_password: String::new(),
            },
        );
        // Secrets preserved…
        assert_eq!(merged.certificate_p12_b64, "CERT");
        assert_eq!(merged.certificate_password, "P12PW");
        assert_eq!(merged.app_specific_password, "APPPW");
        // …parsed metadata preserved…
        assert_eq!(merged.cert_not_after_ms, 123);
        assert_eq!(merged.cert_subject, "CN=x");
        // …and the metadata fields updated.
        assert_eq!(merged.signing_identity, "new identity");
        assert_eq!(merged.apple_id, "new@x.com");
        assert_eq!(merged.team_id, "NEWTEAM");
    }

    #[test]
    fn apply_apple_replaces_secret_when_provided() {
        let prev = AppleSigning {
            certificate_password: "OLD".into(),
            ..Default::default()
        };
        let merged = apply_apple(
            Some(prev),
            AppleSaveInput {
                certificate_password: "NEW".into(),
                ..Default::default()
            },
        );
        assert_eq!(merged.certificate_password, "NEW");
    }

    #[test]
    fn apple_status_hides_secret_values_but_flags_presence() {
        let a = AppleSigning {
            certificate_p12_b64: "CERTBYTES".into(),
            certificate_password: "pw".into(),
            signing_identity: "Developer ID Application: X (TEAM)".into(),
            apple_id: "a@b.com".into(),
            app_specific_password: "aspw".into(),
            team_id: "TEAM123456".into(),
            cert_not_after_ms: 0,
            cert_subject: String::new(),
            updated_ms: 5,
        };
        let s = apple_status(&a);
        assert!(s.has_certificate);
        assert!(s.has_certificate_password);
        assert!(s.has_app_password);
        assert!(s.ready);
        // The serialized status must not carry the secret bytes anywhere.
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains("CERTBYTES"));
        assert!(!json.contains("aspw"));
    }

    #[test]
    fn apple_status_not_ready_without_cert() {
        let a = AppleSigning {
            signing_identity: "id".into(),
            apple_id: "a@b.com".into(),
            app_specific_password: "x".into(),
            team_id: "T".into(),
            ..Default::default()
        };
        assert!(!apple_status(&a).ready); // no certificate/password
    }

    #[test]
    fn parse_openssl_date_reads_gmt_format() {
        // 2027-02-01T12:00:00Z
        let ms = parse_openssl_date("Feb  1 12:00:00 2027 GMT").unwrap();
        let expected = chrono::NaiveDate::from_ymd_opt(2027, 2, 1)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp_millis();
        assert_eq!(ms, expected);
    }

    #[test]
    fn parse_x509_text_extracts_subject_and_expiry() {
        let text = "notAfter=Feb  1 12:00:00 2027 GMT\n\
                    subject=CN=Developer ID Application: Far island Co. Ltd. (J9H9BT3994),OU=J9H9BT3994";
        let (subject, identity, ms) = parse_x509_text(text).unwrap();
        assert!(subject.contains("Far island"));
        assert_eq!(
            identity,
            "Developer ID Application: Far island Co. Ltd. (J9H9BT3994)"
        );
        assert!(ms > 0);
    }

    #[test]
    fn days_left_none_when_unknown() {
        assert_eq!(days_left(0), None);
        assert!(days_left(now_ms() + 10 * 86_400_000).unwrap() >= 9);
    }
}
