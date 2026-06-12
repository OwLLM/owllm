// GitHub account connection.
//
// WHY: the agents (local-model tools, the subscription CLIs, the `git` shell
// tool) run INSIDE the sandbox (WSL today; Lima/bubblewrap on Mac/Linux) for
// isolated projects. The host's GitHub credentials do NOT cross that boundary,
// so without this an isolated agent can't clone a private repo or push a
// commit. We take the user's GitHub token once, validate it, and write it into
// the SANDBOX's git credential store (and the host's, for non-isolated
// projects), plus log `gh` in so the agents can open PRs/issues.
//
// Token: a GitHub Personal Access Token — classic with `repo` scope, or a
// fine-grained token with Contents read/write. Stored in the shared agent
// secrets file (reusing accounts.rs) as GITHUB_TOKEN; the resolved login is
// cached as GITHUB_LOGIN for status display. Validation + identity lookup go
// through `curl` (present on Win10 1803+ and provisioned in the distro), so no
// Rust HTTP client is needed — matching the existing "probe via shell" pattern.

use serde::Serialize;
use std::process::Stdio;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatus {
    /// A token is stored.
    pub connected: bool,
    /// The GitHub login the token belongs to (cached at connect time).
    pub login: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GithubConnect {
    pub login: String,
    /// The noreply commit email derived from the account (id+login@…).
    pub email: String,
    /// git credentials were written inside the sandbox (distro).
    pub sandbox_configured: bool,
    /// git credentials were written on the Windows host.
    pub host_configured: bool,
    /// `gh` CLI was logged in inside the sandbox (best effort).
    pub gh_configured: bool,
}

/// Validate a token against the GitHub API and return (login, numeric id).
/// Uses host `curl` so we don't pull in an HTTP client. A rejected token
/// yields a JSON `{message: "Bad credentials"}` which we surface verbatim.
fn curl_github_user(token: &str) -> Result<(String, i64), String> {
    let mut cmd = std::process::Command::new("curl");
    cmd.args([
        "-s",
        "-H",
        &format!("Authorization: Bearer {token}"),
        "-H",
        "User-Agent: owllm-desktop",
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
        "https://api.github.com/user",
    ]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("couldn't run curl to reach GitHub: {e}"))?;
    let body = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value = serde_json::from_str(body.trim()).map_err(|_| {
        format!(
            "GitHub returned a non-JSON response (offline, or token rejected): {}",
            body.chars().take(200).collect::<String>()
        )
    })?;
    if let Some(login) = v.get("login").and_then(|x| x.as_str()) {
        let id = v.get("id").and_then(|x| x.as_i64()).unwrap_or(0);
        Ok((login.to_string(), id))
    } else {
        let msg = v
            .get("message")
            .and_then(|x| x.as_str())
            .unwrap_or("unknown error");
        Err(format!("GitHub rejected the token: {msg}"))
    }
}

/// Write git credentials + identity into the distro, and (best effort) log
/// `gh` in. Returns whether the `gh` login succeeded. Values are bash-quoted.
fn configure_sandbox(
    distro: Option<&str>,
    login: &str,
    email: &str,
    token: &str,
) -> Result<bool, String> {
    // Resolve a REAL Linux distro (skip docker-desktop etc.) so the git
    // credentials land in the same distro the sandboxed agents run in.
    let distro = distro
        .map(|s| s.to_string())
        .filter(|d| !d.trim().is_empty())
        .or_else(crate::wsl::best_linux_distro)
        .ok_or_else(|| "no Ubuntu/Linux distro in WSL available".to_string())?;
    let q = crate::wsl::sh_quote;
    let script = format!(
        "set -e; git config --global credential.helper store; \
         git config --global user.name {name}; \
         git config --global user.email {email}; \
         umask 077; printf 'https://%s:%s@github.com\\n' {login} {token} > \"$HOME/.git-credentials\"; \
         chmod 600 \"$HOME/.git-credentials\"",
        name = q(login),
        email = q(email),
        login = q(login),
        token = q(token),
    );
    crate::wsl::run_in_distro(&distro, &script)?;

    // gh login is optional — older distros may not have it until the next
    // provision. Never fail the connect over it.
    let gh_script = format!(
        "command -v gh >/dev/null 2>&1 || exit 3; \
         printf %s {token} | gh auth login --hostname github.com --with-token && gh auth setup-git",
        token = q(token),
    );
    let gh_ok = crate::wsl::run_in_distro(&distro, &gh_script).is_ok();
    Ok(gh_ok)
}

/// Configure git on the Windows host for non-isolated projects. Best effort.
fn configure_host(login: &str, email: &str, token: &str) -> Result<(), String> {
    let run_git = |args: &[&str]| {
        let mut c = std::process::Command::new("git");
        c.args(args);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(CREATE_NO_WINDOW);
        }
        let _ = c.output();
    };
    run_git(&["config", "--global", "credential.helper", "store"]);
    run_git(&["config", "--global", "user.name", login]);
    run_git(&["config", "--global", "user.email", email]);

    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or_else(|| "no home directory".to_string())?;
    let p = std::path::PathBuf::from(home).join(".git-credentials");
    let line = format!("https://{login}:{token}@github.com");
    // Keep any non-github lines, replace/add the github one.
    let existing = std::fs::read_to_string(&p).unwrap_or_default();
    let mut kept: Vec<String> = existing
        .lines()
        .filter(|l| !l.contains("@github.com") && !l.trim().is_empty())
        .map(|s| s.to_string())
        .collect();
    kept.push(line);
    let mut body = kept.join("\n");
    body.push('\n');
    std::fs::write(&p, body).map_err(|e| format!("write {}: {e}", p.display()))?;
    Ok(())
}

#[tauri::command]
pub fn github_status() -> GithubStatus {
    let connected = crate::accounts::accounts_get_secret("GITHUB_TOKEN".to_string()).is_some();
    let login = crate::accounts::accounts_get_secret("GITHUB_LOGIN".to_string());
    GithubStatus { connected, login }
}

/// Connect a GitHub account: validate the token, persist it, and wire git +
/// `gh` credentials into the sandbox (and the host). Idempotent — reconnecting
/// overwrites the stored token and re-writes credentials.
#[tauri::command]
pub async fn github_connect(token: String, distro: Option<String>) -> Result<GithubConnect, String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("paste a GitHub token first".to_string());
    }
    connect_with_token(token, distro).await
}

/// Shared connect path: validate the token → store it → wire git/gh creds.
/// Used by both the token-paste flow (github_connect) and the OAuth Device
/// Flow (github_device_poll on success).
async fn connect_with_token(token: String, distro: Option<String>) -> Result<GithubConnect, String> {
    let tok = token.clone();
    let (login, id) = tokio::task::spawn_blocking(move || curl_github_user(&tok))
        .await
        .map_err(|e| format!("join error: {e}"))??;
    let email = format!("{id}+{login}@users.noreply.github.com");

    crate::accounts::accounts_save_api_key("GITHUB_TOKEN".to_string(), token.clone())?;
    crate::accounts::accounts_save_api_key("GITHUB_LOGIN".to_string(), login.clone())?;

    let (l, e, t) = (login.clone(), email.clone(), token.clone());
    let (sandbox_configured, gh_configured, host_configured) =
        tokio::task::spawn_blocking(move || {
            let (sb, gh) = match configure_sandbox(distro.as_deref(), &l, &e, &t) {
                Ok(gh) => (true, gh),
                Err(_) => (false, false),
            };
            let host = configure_host(&l, &e, &t).is_ok();
            (sb, gh, host)
        })
        .await
        .map_err(|e| format!("join error: {e}"))?;

    Ok(GithubConnect {
        login,
        email,
        sandbox_configured,
        host_configured,
        gh_configured,
    })
}

// --------------------------------------------------------------------------
// OAuth Device Flow — the "Sign in with GitHub" experience without a server:
// no client secret, no redirect/callback. The app shows a short code, the user
// authorizes it at github.com/login/device, and we poll for the token. The
// public client_id is supplied by the UI (embedded in the app — it's public).
// --------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCodeStart {
    /// The short code the user types at the verification URL (e.g. WDJB-MJHT).
    pub user_code: String,
    /// Where the user enters the code (github.com/login/device).
    pub verification_uri: String,
    /// Opaque code we poll with (NOT shown to the user).
    pub device_code: String,
    /// Min seconds between polls.
    pub interval: u64,
    /// Seconds until the code expires.
    pub expires_in: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DevicePollResult {
    /// One of: pending | slowDown | authorized | denied | expired | error
    pub status: String,
    /// On `authorized`: the connected GitHub login.
    pub login: Option<String>,
    /// On `error`: a human-readable reason.
    pub detail: Option<String>,
}

/// POST form fields to a GitHub OAuth endpoint, asking for a JSON response.
fn curl_post_form(url: &str, fields: &[(&str, &str)]) -> Result<serde_json::Value, String> {
    let mut cmd = std::process::Command::new("curl");
    cmd.args(["-s", "-X", "POST", "-H", "Accept: application/json", "-H", "User-Agent: owllm-desktop"]);
    for (k, v) in fields {
        cmd.arg("-d").arg(format!("{k}={v}"));
    }
    cmd.arg(url);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|e| format!("couldn't run curl to reach GitHub: {e}"))?;
    let body = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(body.trim())
        .map_err(|_| format!("GitHub returned a non-JSON response (offline?): {}", body.chars().take(160).collect::<String>()))
}

/// Step 1: ask GitHub for a device + user code.
#[tauri::command]
pub async fn github_device_start(client_id: String) -> Result<DeviceCodeStart, String> {
    let cid = client_id.trim().to_string();
    if cid.is_empty() {
        return Err("missing GitHub client id".to_string());
    }
    tokio::task::spawn_blocking(move || -> Result<DeviceCodeStart, String> {
        let v = curl_post_form(
            "https://github.com/login/device/code",
            &[("client_id", &cid), ("scope", "repo")],
        )?;
        if let Some(err) = v.get("error").and_then(|x| x.as_str()) {
            let desc = v.get("error_description").and_then(|x| x.as_str()).unwrap_or(err);
            return Err(format!("GitHub rejected the device request: {desc}"));
        }
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        let user_code = s("user_code");
        let device_code = s("device_code");
        if user_code.is_empty() || device_code.is_empty() {
            return Err("GitHub didn't return a device code (is Device Flow enabled on the OAuth app?)".to_string());
        }
        Ok(DeviceCodeStart {
            user_code,
            verification_uri: {
                let u = s("verification_uri");
                if u.is_empty() { "https://github.com/login/device".to_string() } else { u }
            },
            device_code,
            interval: v.get("interval").and_then(|x| x.as_u64()).unwrap_or(5),
            expires_in: v.get("expires_in").and_then(|x| x.as_u64()).unwrap_or(900),
        })
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Step 2: poll for the token. Call repeatedly (every `interval` s) until the
/// status is no longer `pending`/`slowDown`. On `authorized` the token is
/// stored + git creds wired (same as a paste-connect), and `login` is set.
#[tauri::command]
pub async fn github_device_poll(client_id: String, device_code: String) -> Result<DevicePollResult, String> {
    let cid = client_id.trim().to_string();
    let dc = device_code.trim().to_string();
    let v = tokio::task::spawn_blocking(move || {
        curl_post_form(
            "https://github.com/login/oauth/access_token",
            &[
                ("client_id", &cid),
                ("device_code", &dc),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ],
        )
    })
    .await
    .map_err(|e| format!("join error: {e}"))??;

    if let Some(token) = v.get("access_token").and_then(|x| x.as_str()) {
        // Authorized — run the same connect path as a pasted token.
        let connected = connect_with_token(token.to_string(), None).await?;
        return Ok(DevicePollResult { status: "authorized".into(), login: Some(connected.login), detail: None });
    }
    let err = v.get("error").and_then(|x| x.as_str()).unwrap_or("error");
    let status = match err {
        "authorization_pending" => "pending",
        "slow_down" => "slowDown",
        "access_denied" => "denied",
        "expired_token" => "expired",
        _ => "error",
    };
    let detail = v.get("error_description").and_then(|x| x.as_str()).map(|s| s.to_string());
    Ok(DevicePollResult { status: status.to_string(), login: None, detail })
}

/// Disconnect: forget the token and scrub credentials from the sandbox and
/// host. Best effort — always clears the stored token even if scrubbing fails.
#[tauri::command]
pub async fn github_disconnect(distro: Option<String>) -> Result<(), String> {
    let _ = crate::accounts::accounts_delete_secret("GITHUB_TOKEN".to_string());
    let _ = crate::accounts::accounts_delete_secret("GITHUB_LOGIN".to_string());

    tokio::task::spawn_blocking(move || {
        // Scrub from the REAL Linux distro (where configure_sandbox wrote the
        // credentials), not the raw default, or the scrub misses them.
        if let Some(d) = distro
            .filter(|d| !d.trim().is_empty())
            .or_else(crate::wsl::best_linux_distro)
        {
            let _ = crate::wsl::run_in_distro(
                &d,
                "rm -f \"$HOME/.git-credentials\"; \
                 command -v gh >/dev/null 2>&1 && gh auth logout --hostname github.com 2>/dev/null; true",
            );
        }
        // Host scrub: drop any github line from ~/.git-credentials.
        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            let p = std::path::PathBuf::from(home).join(".git-credentials");
            if let Ok(existing) = std::fs::read_to_string(&p) {
                let kept: Vec<&str> = existing
                    .lines()
                    .filter(|l| !l.contains("@github.com") && !l.trim().is_empty())
                    .collect();
                if kept.is_empty() {
                    let _ = std::fs::remove_file(&p);
                } else {
                    let _ = std::fs::write(&p, format!("{}\n", kept.join("\n")));
                }
            }
        }
    })
    .await
    .map_err(|e| format!("join error: {e}"))?;
    Ok(())
}
