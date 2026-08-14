// In-app WSL setup — so users never have to touch the CLI.
//
// The Code-page Coder and the fine-tuning env both want a Linux sandbox.
// On a fresh PC that means: enable the Windows components, install Ubuntu,
// create a Linux user, and put Python/uv inside it. This module automates
// every step that CAN be automated and is HONEST about the one that can't.
//
// THE ONE HARD WALL: WSL2 needs CPU virtualization enabled in the BIOS/
// firmware. No software — not OwLLM, not Microsoft's own `wsl --install` —
// can flip that; it's a firmware switch the user must toggle once. On most
// PCs it's already on, so the flow is hands-free; when it's off we detect
// it and show exact instructions instead of a cryptic failure.
//
// Flow (driven by the UI off wsl_setup_status().stage):
//   virtualizationOff → show BIOS card (+ Re-check)
//   needsInstall      → wsl_setup_install() runs elevated `wsl --install -d Ubuntu`
//   needsReboot       → we launched the installer; Windows must reboot to
//                       enable the VM platform. wsl_reboot() (or user reboots).
//   needsUser         → distro is registered but has no Linux user (e.g. the
//                       user closed the first-run window before creating one).
//                       wsl_setup_ensure_user() creates it non-interactively.
//   needsPython       → wsl_setup_provision_python() apt-installs python3/pip + uv
//   ready             → green

use serde::Serialize;

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct WslSetupStatus {
    /// One of: virtualizationOff | needsInstall | needsReboot | needsUser |
    /// needsPython | ready | unsupported
    pub stage: String,
    pub virtualization_enabled: bool,
    pub distro_installed: bool,
    pub default_distro: Option<String>,
    /// A non-root Linux user is configured as the distro's default.
    pub user_ready: bool,
    /// The configured default Linux user name, if any (root → None).
    pub default_user: Option<String>,
    pub python_ready: bool,
    /// We launched `wsl --install` this session and are waiting for the
    /// reboot that enables the Virtual Machine Platform.
    pub awaiting_reboot: bool,
    /// Human-readable one-liner for the current stage.
    pub detail: String,
}

/// The saved WSL account (username + whether a password is stored). The
/// password itself is NEVER returned to the UI — only whether one exists.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct WslAccount {
    pub username: Option<String>,
    pub has_password: bool,
}

/// Streamed progress for the Python provisioning step.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SetupEvent {
    Started,
    Log { line: String },
    Finished,
    Failed { error: String },
}

// --------------------------------------------------------------------------
// Credential storage (Windows-host side, DPAPI-encrypted at rest)
// --------------------------------------------------------------------------

/// `%USERPROFILE%\.owllm\wsl_user.json` — username (plain) + DPAPI-encrypted
/// password (base64). Matches the `.owllm` convention used by wsl.rs.
fn user_cfg_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(
        std::path::PathBuf::from(home)
            .join(".owllm")
            .join("wsl_user.json"),
    )
}

/// Marker file: set when we launch `wsl --install`, cleared once a usable
/// distro appears. Drives the needsReboot stage so the user gets a clear
/// "reboot now" instead of a sluggish app that keeps re-probing a half-
/// installed WSL.
fn install_marker_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(
        std::path::PathBuf::from(home)
            .join(".owllm")
            .join("wsl_install_pending"),
    )
}

fn set_install_marker() {
    if let Some(p) = install_marker_path() {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&p, b"1");
    }
}

fn clear_install_marker() {
    if let Some(p) = install_marker_path() {
        let _ = std::fs::remove_file(p);
    }
}

fn install_marker_present() -> bool {
    install_marker_path().map(|p| p.is_file()).unwrap_or(false)
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct StoredAccount {
    username: String,
    /// base64(DPAPI ciphertext) — empty when no password is stored.
    password_enc: String,
}

fn save_account(username: &str, password: &str) -> Result<(), String> {
    use base64::Engine as _;
    let enc = if password.is_empty() {
        String::new()
    } else {
        let cipher = crate::crypt::protect(password.as_bytes())?;
        base64::engine::general_purpose::STANDARD.encode(cipher)
    };
    let rec = StoredAccount {
        username: username.to_string(),
        password_enc: enc,
    };
    let p = user_cfg_path().ok_or_else(|| "no home directory".to_string())?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(&rec).map_err(|e| e.to_string())?;
    std::fs::write(&p, json).map_err(|e| format!("write {}: {e}", p.display()))?;
    Ok(())
}

fn load_account() -> Option<StoredAccount> {
    let p = user_cfg_path()?;
    let s = std::fs::read_to_string(p).ok()?;
    serde_json::from_str(&s).ok()
}

// --------------------------------------------------------------------------
// Windows implementation
// --------------------------------------------------------------------------
#[cfg(windows)]
mod imp {
    use super::{SetupEvent, WslSetupStatus};
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    /// `wsl --status` (UTF-16LE) with nulls stripped, stdout+stderr merged.
    /// Returns None when wsl.exe itself can't be launched.
    fn wsl_status_text() -> Option<String> {
        let mut cmd = std::process::Command::new("wsl.exe");
        cmd.arg("--status");
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        cmd.creation_flags(CREATE_NO_WINDOW);
        let out = cmd.output().ok()?;
        let mut bytes = out.stdout;
        bytes.extend_from_slice(&out.stderr);
        let raw: Vec<u8> = bytes.into_iter().filter(|&b| b != 0).collect();
        Some(String::from_utf8_lossy(&raw).to_string())
    }

    /// The default user's uid inside the distro (`id -u`). 0 = root, which on
    /// a fresh Ubuntu means no Linux user was ever created (the first-run
    /// window was closed). Returns None ONLY if the distro genuinely can't be
    /// reached after a retry.
    ///
    /// Robust parsing: a login shell can print MOTD / profile.d banner lines
    /// before the command output, so we DON'T trust the first line — `id -u`
    /// emits a bare integer on its own line, so we scan from the END for the
    /// first line that parses as a number. We also retry once: the first
    /// wsl.exe call right after a reboot often hits the cold WSL service and
    /// transiently fails, which previously got misread as "needs reboot".
    fn default_uid(distro: &str) -> Option<u32> {
        for attempt in 0..2 {
            if let Ok(o) = crate::wsl::run_in_distro(distro, "id -u") {
                if let Some(u) = o.lines().rev().find_map(|l| l.trim().parse::<u32>().ok()) {
                    return Some(u);
                }
            }
            if attempt == 0 {
                std::thread::sleep(std::time::Duration::from_millis(600));
            }
        }
        None
    }

    /// The default user's name inside the distro (`id -un`). None for root or
    /// when unreadable. Last non-empty line, to skip any login banner.
    fn default_user_name(distro: &str) -> Option<String> {
        crate::wsl::run_in_distro(distro, "id -un")
            .ok()
            .and_then(|o| {
                o.lines()
                    .rev()
                    .map(str::trim)
                    .find(|l| !l.is_empty())
                    .map(String::from)
            })
            .filter(|s| s != "root")
    }

    pub fn status() -> WslSetupStatus {
        let text = wsl_status_text().unwrap_or_default();
        let lower = text.to_lowercase();
        // Firmware virtualization is the hard blocker. wsl --status spells it
        // out: "virtualization is not enabled on this machine".
        let virtualization_enabled = !lower.contains("virtualization is not enabled");

        // Resolve through one probe: a Docker/system distro (no bash) doesn't
        // count as a usable fine-tuning/sandbox distro. We mirror
        // best_linux_distro() here off a SINGLE wsl_status() call (fewer
        // wsl.exe spawns = less cold-start exposure) so we can also tell the
        // "no WSL at all" case apart from "WSL is here, but only Docker's".
        let ws = crate::wsl::wsl_status_blocking();
        let default_distro: Option<String> = ws
            .default_distro
            .clone()
            .filter(|d| !crate::wsl::is_system_distro(d))
            .or_else(|| {
                ws.distros
                    .iter()
                    .find(|d| !crate::wsl::is_system_distro(d))
                    .cloned()
            });
        let distro_installed = default_distro.is_some();
        // WSL itself is present (it lists distros) but every one of them is a
        // system distro (docker-desktop/rancher/podman) — a stripped busybox
        // userland that can't run bash/apt/uv. This is NOT "WSL not installed";
        // the user just needs a real Linux (Ubuntu). Reporting it as "not
        // installed" is what made detection look broken on Docker-only PCs.
        let system_distro_only = !distro_installed && !ws.distros.is_empty();
        let awaiting_reboot = super::install_marker_present();

        // Can we actually RUN a command in the distro? A distro can be
        // *registered* (`wsl -l` lists it) yet not *runnable* until the
        // post-install reboot enables the VM platform — `id -u` is our probe.
        // We key reboot/user/python decisions off "runnable", not merely
        // "listed", so a half-installed WSL shows the reboot card instead of
        // failing deeper in the flow.
        let uid = default_distro.as_deref().and_then(default_uid);
        let distro_runnable = uid.is_some();

        // Once the distro actually runs, the install+reboot is truly done —
        // clear the marker so we don't nag forever.
        if distro_runnable {
            super::clear_install_marker();
        }

        // A non-root default user means the first-run account exists.
        let (user_ready, default_user) = match uid {
            Some(0) | None => (false, None),
            Some(_) => (true, default_distro.as_deref().and_then(default_user_name)),
        };

        let python_ready = if distro_runnable {
            default_distro
                .as_deref()
                .and_then(|d| {
                    crate::wsl::run_in_distro(
                        d,
                        "command -v python3 >/dev/null 2>&1 && echo OK || true",
                    )
                    .ok()
                })
                .map(|o| o.contains("OK"))
                .unwrap_or(false)
        } else {
            false
        };

        let (stage, detail) = if !virtualization_enabled {
            (
                "virtualizationOff",
                "CPU virtualization is OFF in your BIOS/firmware — the one thing no app can change. Enable it once, then re-check.".to_string(),
            )
        } else if !distro_installed && awaiting_reboot {
            // We launched the installer; the distro isn't registered yet —
            // Windows needs the reboot that enables the VM platform.
            (
                "needsReboot",
                "WSL was installed but Windows needs a restart to turn on the Virtual Machine Platform. Reboot, then re-check.".to_string(),
            )
        } else if system_distro_only {
            // WSL is installed and working — but the only distro is Docker
            // Desktop's, which can't run fine-tuning or the sandbox. Add Ubuntu
            // (WSL2/VM platform is already on, so no reboot needed).
            (
                "needsDistro",
                "WSL is installed, but the only Linux in it is Docker Desktop's — a stripped-down userland with no bash/apt, so fine-tuning and the agent sandbox can't run there. Add Ubuntu (one click, no reboot needed).".to_string(),
            )
        } else if !distro_installed {
            (
                "needsInstall",
                "Ready to install WSL + Ubuntu automatically.".to_string(),
            )
        } else if awaiting_reboot && !distro_runnable {
            // Our installer ran AND the distro still won't execute a command →
            // genuinely pending the post-install reboot. We DON'T trigger this
            // on a plain probe failure (no marker): a working WSL that hiccups
            // must never be forced into a reboot loop.
            (
                "needsReboot",
                "WSL was installed but Windows needs a restart to turn on the Virtual Machine Platform. Reboot, then re-check.".to_string(),
            )
        } else if uid == Some(0) {
            // CONFIRMED root (distro ran `id -u` → 0): no Linux user yet.
            (
                "needsUser",
                "Ubuntu is installed but has no Linux user yet (the first-run window was likely closed). Create one — it takes a second.".to_string(),
            )
        } else if distro_runnable && !python_ready {
            (
                "needsPython",
                format!(
                    "Ubuntu is ready{} — just needs Python.",
                    default_user
                        .as_deref()
                        .map(|u| format!(" (user {u})"))
                        .unwrap_or_default()
                ),
            )
        } else {
            (
                "ready",
                format!(
                    "WSL is ready{}.",
                    default_distro
                        .as_deref()
                        .map(|d| format!(" ({d})"))
                        .unwrap_or_default()
                ),
            )
        };

        WslSetupStatus {
            stage: stage.to_string(),
            virtualization_enabled,
            distro_installed,
            default_distro,
            user_ready,
            default_user,
            python_ready,
            awaiting_reboot,
            detail,
        }
    }

    /// Launch `wsl --install -d Ubuntu` ELEVATED (UAC). On a fresh machine
    /// this single call enables the WSL + Virtual Machine Platform optional
    /// components AND installs Ubuntu. It runs in its own window so the user
    /// sees download progress; it usually asks for a reboot when done.
    /// We pass `--no-launch` so it does NOT drop the user into the Ubuntu
    /// first-run console (the source of the "closed the window, no user"
    /// bug) — we create the Linux user ourselves afterwards.
    pub fn install() -> Result<(), String> {
        let status = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "Start-Process -FilePath 'wsl.exe' -ArgumentList '--install','-d','Ubuntu','--no-launch' -Verb RunAs",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| format!("could not launch the elevated installer: {e}"))?;
        if !status.success() {
            return Err("WSL install was cancelled (the UAC prompt was declined).".to_string());
        }
        // Remember that an install is in flight so status() can show the
        // reboot stage until a usable distro appears.
        super::set_install_marker();
        Ok(())
    }

    /// Create the Linux user non-interactively, AS ROOT (WSL allows `-u root`
    /// with no password). Idempotent: re-running just resets the password and
    /// re-applies the default-user config. The password is passed base64-
    /// encoded inside the script so arbitrary characters survive the
    /// Windows→wsl handoff, then decoded in bash. After writing
    /// /etc/wsl.conf we terminate the distro so the new default user takes
    /// effect on the next launch.
    pub fn ensure_user(distro: &str, username: &str, password: &str) -> Result<(), String> {
        use base64::Engine as _;
        let pw_b64 = base64::engine::general_purpose::STANDARD.encode(password.as_bytes());
        // username is sanitized by the caller to [a-z0-9_-]; safe to embed.
        let script = format!(
            r#"set -e
export DEBIAN_FRONTEND=noninteractive
U='{user}'
PW="$(printf %s '{pw}' | base64 -d)"
if ! id -u "$U" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$U"
fi
printf '%s:%s\n' "$U" "$PW" | chpasswd
usermod -aG sudo "$U" 2>/dev/null || true
# Make $U the distro's default user on next launch, preserving any other
# wsl.conf sections we don't manage.
if [ -f /etc/wsl.conf ] && grep -q '^\[user\]' /etc/wsl.conf; then
  if grep -q '^default=' /etc/wsl.conf; then
    sed -i "s/^default=.*/default=$U/" /etc/wsl.conf
  else
    sed -i "/^\[user\]/a default=$U" /etc/wsl.conf
  fi
else
  printf '[user]\ndefault=%s\n' "$U" >> /etc/wsl.conf
fi
echo USER_OK
"#,
            user = username,
            pw = pw_b64,
        );
        let out = run_root_capture(distro, &script)?;
        // Verify the sentinel rather than trusting a zero exit alone — a
        // banner-printing or partially-executed script must not pass as
        // "user created".
        if !out.contains("USER_OK") {
            return Err(format!(
                "user setup did not complete. Output: {}",
                out.trim().chars().take(240).collect::<String>()
            ));
        }
        // Terminate so /etc/wsl.conf [user] default takes effect.
        let _ = std::process::Command::new("wsl.exe")
            .args(["--terminate", distro])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        Ok(())
    }

    /// Run a bash script as root in the distro via stdin (immune to the
    /// Windows→wsl command-line quoting hazards), capturing output. Delegates
    /// to the shared runner so wsl.exe's UTF-16LE error messages are decoded
    /// (`decode_wsl`) instead of rendering as mojibake.
    fn run_root_capture(distro: &str, script: &str) -> Result<String, String> {
        // Guided-setup installs (apt update + Python toolchain) can
        // legitimately run far past the shared runner's default ceiling on a
        // slow network — give them an explicit hour instead of no bound.
        crate::wsl::run_in_distro_script_user_with_timeout(
            distro,
            Some("root"),
            script,
            std::time::Duration::from_secs(60 * 60),
        )
    }

    /// apt-install python3 + pip + venv and uv inside the distro, AS ROOT
    /// (so it works whether or not a Linux user was created). Streams output
    /// line-by-line over the channel.
    pub fn provision_python(
        distro: &str,
        channel: &tauri::ipc::Channel<SetupEvent>,
    ) -> Result<(), String> {
        use std::io::{BufRead, BufReader, Write};

        const SCRIPT: &str = r#"set -e
export DEBIAN_FRONTEND=noninteractive
echo '>> Updating package lists…'
apt-get update -y
echo '>> Installing python3, pip, venv, curl…'
apt-get install -y python3 python3-pip python3-venv curl ca-certificates
echo '>> Installing uv (fast envs + MCP uvx)…'
export UV_INSTALL_DIR=/usr/local/bin
curl -LsSf https://astral.sh/uv/install.sh | sh || echo '   (uv install skipped — offline?)'
echo '>> Done. Versions:'
python3 --version
pip3 --version || true
"#;

        let mut cmd = std::process::Command::new("wsl.exe");
        cmd.arg("-d")
            .arg(distro)
            .arg("-u")
            .arg("root")
            .arg("--")
            .arg("bash")
            .arg("-ls");
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd.creation_flags(CREATE_NO_WINDOW);
        let mut child = cmd.spawn().map_err(|e| format!("spawn wsl: {e}"))?;
        {
            let mut stdin = child.stdin.take().ok_or_else(|| "no stdin".to_string())?;
            stdin
                .write_all(SCRIPT.as_bytes())
                .map_err(|e| format!("write provision script: {e}"))?;
            // dropped → EOF
        }
        if let Some(out) = child.stdout.take() {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let _ = channel.send(SetupEvent::Log { line });
            }
        }
        let mut stderr_tail = String::new();
        if let Some(err) = child.stderr.take() {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                stderr_tail.push_str(&line);
                stderr_tail.push('\n');
            }
        }
        let status = child.wait().map_err(|e| format!("wait wsl: {e}"))?;
        if !status.success() {
            return Err(format!(
                "provisioning failed (exit {}). {}",
                status.code().unwrap_or(-1),
                stderr_tail.trim()
            ));
        }
        Ok(())
    }

    pub fn reboot() -> Result<(), String> {
        std::process::Command::new("shutdown")
            .args(["/r", "/t", "5"])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| format!("could not schedule reboot: {e}"))?;
        Ok(())
    }
}

// --------------------------------------------------------------------------
// Tauri commands (cross-platform shells around the Windows impl)
// --------------------------------------------------------------------------

#[tauri::command]
pub fn wsl_setup_status() -> WslSetupStatus {
    #[cfg(windows)]
    {
        imp::status()
    }
    #[cfg(not(windows))]
    {
        WslSetupStatus {
            stage: "unsupported".to_string(),
            detail: "Guided WSL setup is only available on Windows.".to_string(),
            ..Default::default()
        }
    }
}

#[tauri::command]
pub fn wsl_setup_install() -> Result<(), String> {
    #[cfg(windows)]
    {
        imp::install()
    }
    #[cfg(not(windows))]
    {
        Err("Guided WSL setup is only available on Windows.".to_string())
    }
}

/// Sanitize a desired Linux username to a valid, lowercase POSIX name.
fn sanitize_username(raw: &str) -> String {
    let mut s: String = raw
        .trim()
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_' || *c == '-')
        .collect();
    // Must start with a letter or underscore.
    while let Some(c) = s.chars().next() {
        if c.is_ascii_digit() || c == '-' {
            s.remove(0);
        } else {
            break;
        }
    }
    if s.is_empty() {
        s = "owllm".to_string();
    }
    s.chars().take(32).collect()
}

/// Create (or repair) the Linux user, set its password, make it the distro
/// default, and remember the credentials (password encrypted via DPAPI).
#[tauri::command]
pub async fn wsl_setup_ensure_user(
    username: String,
    password: String,
) -> Result<WslAccount, String> {
    #[cfg(windows)]
    {
        let distro = crate::wsl::best_linux_distro()
            .ok_or_else(|| "No Ubuntu/Linux distro in WSL yet — install Ubuntu first (a Docker/system distro doesn't count).".to_string())?;
        let user = sanitize_username(&username);
        if password.trim().is_empty() {
            return Err("Please choose a password for the Linux account.".to_string());
        }
        let u = user.clone();
        let pw = password.clone();
        let d = distro.clone();
        tokio::task::spawn_blocking(move || imp::ensure_user(&d, &u, &pw))
            .await
            .map_err(|e| format!("join error: {e}"))??;
        save_account(&user, &password)?;
        Ok(WslAccount {
            username: Some(user),
            has_password: true,
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (username, password);
        Err("Guided WSL setup is only available on Windows.".to_string())
    }
}

/// Report the saved WSL account (username + whether a password is stored).
/// The password is never returned. Used to pre-fill the setup form.
#[tauri::command]
pub fn wsl_setup_get_account() -> WslAccount {
    match load_account() {
        Some(a) => WslAccount {
            username: if a.username.is_empty() {
                None
            } else {
                Some(a.username)
            },
            has_password: !a.password_enc.is_empty(),
        },
        None => WslAccount::default(),
    }
}

/// Reveal the stored WSL password (decrypted) — for the one "show my
/// password" affordance in the setup dialog. Errors if none is stored or
/// DPAPI can't decrypt it (e.g. copied from another machine/account).
#[tauri::command]
pub fn wsl_setup_reveal_password() -> Result<String, String> {
    use base64::Engine as _;
    let a = load_account().ok_or_else(|| "No saved WSL account.".to_string())?;
    if a.password_enc.is_empty() {
        return Err("No password is stored.".to_string());
    }
    let cipher = base64::engine::general_purpose::STANDARD
        .decode(a.password_enc.as_bytes())
        .map_err(|e| format!("decode: {e}"))?;
    let plain = crate::crypt::unprotect(&cipher)?;
    String::from_utf8(plain).map_err(|e| format!("utf8: {e}"))
}

#[tauri::command]
pub async fn wsl_setup_provision_python(
    channel: tauri::ipc::Channel<SetupEvent>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let distro = crate::wsl::best_linux_distro()
            .ok_or_else(|| "No Ubuntu/Linux distro in WSL yet — install Ubuntu first (a Docker/system distro doesn't count).".to_string())?;
        let _ = channel.send(SetupEvent::Started);
        let ch = channel.clone();
        let res = tokio::task::spawn_blocking(move || imp::provision_python(&distro, &ch))
            .await
            .map_err(|e| format!("join error: {e}"))?;
        match res {
            Ok(()) => {
                // NOTE: we intentionally do NOT auto-enable a sparse disk here.
                // Modern WSL disables sparse by default "due to potential data
                // corruption", so it's an explicit, warned opt-in only (see
                // sandbox::sandbox_enable_sparse). The safe default against disk
                // inflation is the automatic cache-trim (sandbox::auto_housekeep).
                let _ = channel.send(SetupEvent::Finished);
                Ok(())
            }
            Err(e) => {
                let _ = channel.send(SetupEvent::Failed { error: e.clone() });
                Err(e)
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = channel;
        Err("Guided WSL setup is only available on Windows.".to_string())
    }
}

#[tauri::command]
pub fn wsl_reboot() -> Result<(), String> {
    #[cfg(windows)]
    {
        imp::reboot()
    }
    #[cfg(not(windows))]
    {
        Err("Reboot control is only available on Windows.".to_string())
    }
}
