// Per-user GitHub "vault" — the private repo that backs cross-device sync.
//
// Identity + storage = the user's OWN GitHub (see github.rs / accounts.rs):
// we never host their data. This module ensures a PRIVATE `owllm-vault` repo
// exists for the connected account and keeps a local clone that the sync
// engine reads/writes. We talk to the GitHub REST API via host `curl` (same
// pattern as github.rs — no Rust HTTP client) and use `git` for clone/push.
//
// The clone uses the host git credential helper that github_connect already
// configured (~/.git-credentials), so the token never has to live in this
// repo's .git/config. If that helper isn't present we fall back to a
// one-time token-embedded clone URL.

use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const VAULT_REPO: &str = "owllm-vault";

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    /// GitHub is connected (token + login stored).
    pub connected: bool,
    pub login: Option<String>,
    /// The owllm-vault repo exists on GitHub.
    pub repo_exists: bool,
    /// A local clone is present on this device.
    pub cloned: bool,
    /// Local clone path (when cloned).
    pub path: Option<String>,
    /// https URL of the repo (for "view on GitHub").
    pub repo_url: Option<String>,
}

/// Local clone location: `%USERPROFILE%\.owllm\vault` (matches the `.owllm`
/// convention used elsewhere — wsl.rs, wsl_setup.rs).
fn vault_dir() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(home).join(".owllm").join("vault"))
}

fn token_and_login() -> Option<(String, String)> {
    let token = crate::accounts::accounts_get_secret("GITHUB_TOKEN".to_string())?;
    let login = crate::accounts::accounts_get_secret("GITHUB_LOGIN".to_string())?;
    Some((token, login))
}

/// GET an authenticated GitHub API URL; return the parsed JSON body.
fn curl_get(token: &str, url: &str) -> Result<serde_json::Value, String> {
    let mut cmd = std::process::Command::new("curl");
    cmd.args([
        "-s",
        "-H", &format!("Authorization: Bearer {token}"),
        "-H", "User-Agent: owllm-desktop",
        "-H", "Accept: application/vnd.github+json",
        "-H", "X-GitHub-Api-Version: 2022-11-28",
        url,
    ]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|e| format!("curl GitHub: {e}"))?;
    let body = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(body.trim())
        .map_err(|_| format!("GitHub returned non-JSON (offline?): {}", body.chars().take(160).collect::<String>()))
}

/// POST a JSON body to a GitHub API URL; return the parsed JSON response.
fn curl_post(token: &str, url: &str, json_body: &str) -> Result<serde_json::Value, String> {
    let mut cmd = std::process::Command::new("curl");
    cmd.args([
        "-s",
        "-X", "POST",
        "-H", &format!("Authorization: Bearer {token}"),
        "-H", "User-Agent: owllm-desktop",
        "-H", "Accept: application/vnd.github+json",
        "-H", "X-GitHub-Api-Version: 2022-11-28",
        "-H", "Content-Type: application/json",
        "-d", json_body,
        url,
    ]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|e| format!("curl GitHub: {e}"))?;
    let body = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(body.trim())
        .map_err(|_| format!("GitHub returned non-JSON (offline?): {}", body.chars().take(160).collect::<String>()))
}

fn repo_exists(token: &str, login: &str) -> bool {
    let url = format!("https://api.github.com/repos/{login}/{VAULT_REPO}");
    match curl_get(token, &url) {
        Ok(v) => v.get("full_name").is_some(),
        Err(_) => false,
    }
}

/// Create the private vault repo. auto_init gives it a first commit so it can
/// be cloned immediately. Tolerates "already exists".
fn create_repo(token: &str) -> Result<(), String> {
    let body = serde_json::json!({
        "name": VAULT_REPO,
        "private": true,
        "auto_init": true,
        "description": "OWLLM sync vault — chats, settings & agent teams. Managed by OwLLM Desktop."
    })
    .to_string();
    let v = curl_post(token, "https://api.github.com/user/repos", &body)?;
    if v.get("full_name").is_some() {
        return Ok(());
    }
    // "name already exists on this account" is success for our purposes.
    let msg = v.get("message").and_then(|m| m.as_str()).unwrap_or("");
    let already = v
        .get("errors")
        .and_then(|e| e.as_array())
        .map(|arr| arr.iter().any(|e| {
            e.get("message").and_then(|m| m.as_str()).map(|s| s.contains("already exists")).unwrap_or(false)
        }))
        .unwrap_or(false);
    if already || msg.contains("already exists") {
        Ok(())
    } else {
        Err(format!("GitHub couldn't create the vault repo: {}", if msg.is_empty() { "unknown error" } else { msg }))
    }
}

fn is_cloned(dir: &std::path::Path) -> bool {
    dir.join(".git").is_dir()
}

fn run_git(args: &[&str], cwd: Option<&std::path::Path>) -> Result<String, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args);
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|e| format!("run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Clone the vault. Prefer the host credential helper (github_connect wrote
/// ~/.git-credentials), falling back to a token-embedded URL if that fails.
fn clone_vault(token: &str, login: &str, dir: &std::path::Path) -> Result<(), String> {
    if let Some(parent) = dir.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let dir_s = dir.to_string_lossy().to_string();
    let plain = format!("https://github.com/{login}/{VAULT_REPO}.git");
    if run_git(&["clone", "--depth", "1", &plain, &dir_s], None).is_ok() {
        return Ok(());
    }
    // Fallback: embed the token for this clone (the helper wasn't usable).
    let auth = format!("https://{login}:{token}@github.com/{login}/{VAULT_REPO}.git");
    run_git(&["clone", "--depth", "1", &auth, &dir_s], None)?;
    // Reset the remote to the tokenless URL so the token isn't left in
    // .git/config — the helper (or a future re-embed) handles auth on push.
    let _ = run_git(&["remote", "set-url", "origin", &plain], Some(dir));
    Ok(())
}

fn build_status(repo_exists: bool, cloned: bool, login: &str) -> VaultStatus {
    let dir = vault_dir();
    VaultStatus {
        connected: true,
        login: Some(login.to_string()),
        repo_exists,
        cloned,
        path: if cloned { dir.as_ref().map(|p| p.to_string_lossy().into_owned()) } else { None },
        repo_url: Some(format!("https://github.com/{login}/{VAULT_REPO}")),
    }
}

// --------------------------------------------------------------------------
// Tauri commands
// --------------------------------------------------------------------------

/// Report the vault state without changing anything (cheap-ish: one API GET
/// + a local dir check). Used to render the sync panel.
#[tauri::command]
pub async fn vault_status() -> VaultStatus {
    let Some((token, login)) = token_and_login() else {
        return VaultStatus::default();
    };
    tokio::task::spawn_blocking(move || {
        let exists = repo_exists(&token, &login);
        let cloned = vault_dir().map(|d| is_cloned(&d)).unwrap_or(false);
        build_status(exists, cloned, &login)
    })
    .await
    .unwrap_or_default()
}

/// Ensure the private vault repo exists AND is cloned locally. Idempotent:
/// safe to call on every connect / launch. Returns the resulting status.
#[tauri::command]
pub async fn vault_ensure() -> Result<VaultStatus, String> {
    let (token, login) = token_and_login()
        .ok_or_else(|| "Connect GitHub first (Sync sign-in).".to_string())?;
    tokio::task::spawn_blocking(move || -> Result<VaultStatus, String> {
        // 1) Repo on GitHub.
        if !repo_exists(&token, &login) {
            create_repo(&token)?;
        }
        // 2) Local clone.
        let dir = vault_dir().ok_or_else(|| "no home directory for the local vault".to_string())?;
        if !is_cloned(&dir) {
            // A stale empty dir would make clone fail — remove it first.
            if dir.exists() {
                let _ = std::fs::remove_dir_all(&dir);
            }
            clone_vault(&token, &login, &dir)?;
        }
        Ok(build_status(true, is_cloned(&dir), &login))
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}
