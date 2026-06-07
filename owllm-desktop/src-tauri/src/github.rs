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
    let distro = distro
        .map(|s| s.to_string())
        .or_else(|| crate::wsl::wsl_status().default_distro)
        .ok_or_else(|| "no WSL distro available".to_string())?;
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

/// Disconnect: forget the token and scrub credentials from the sandbox and
/// host. Best effort — always clears the stored token even if scrubbing fails.
#[tauri::command]
pub async fn github_disconnect(distro: Option<String>) -> Result<(), String> {
    let _ = crate::accounts::accounts_delete_secret("GITHUB_TOKEN".to_string());
    let _ = crate::accounts::accounts_delete_secret("GITHUB_LOGIN".to_string());

    tokio::task::spawn_blocking(move || {
        if let Some(d) = distro.or_else(|| crate::wsl::wsl_status().default_distro) {
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
