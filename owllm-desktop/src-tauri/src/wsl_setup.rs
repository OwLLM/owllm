// In-app WSL setup — so users never have to touch the CLI.
//
// The Code-page Coder and the fine-tuning env both want a Linux sandbox.
// On a fresh PC that means: enable the Windows components, install Ubuntu,
// and put Python/uv inside it. This module automates every step that CAN
// be automated and is HONEST about the one that can't.
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
//   needsReboot       → wsl_reboot() (or user reboots), then Re-check
//   needsPython       → wsl_setup_provision_python() apt-installs python3/pip + uv
//   ready             → green

use serde::Serialize;

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct WslSetupStatus {
    /// One of: virtualizationOff | needsInstall | needsPython | ready | unsupported
    pub stage: String,
    pub virtualization_enabled: bool,
    pub distro_installed: bool,
    pub default_distro: Option<String>,
    pub python_ready: bool,
    /// Human-readable one-liner for the current stage.
    pub detail: String,
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

    pub fn status() -> WslSetupStatus {
        let text = wsl_status_text().unwrap_or_default();
        let lower = text.to_lowercase();
        // Firmware virtualization is the hard blocker. wsl --status spells it
        // out: "virtualization is not enabled on this machine".
        let virtualization_enabled = !lower.contains("virtualization is not enabled");

        let ws = crate::wsl::wsl_status();
        let distro_installed = !ws.distros.is_empty() || ws.default_distro.is_some();
        let default_distro = ws.default_distro.clone().or_else(|| ws.distros.first().cloned());

        let python_ready = if let Some(d) = &default_distro {
            crate::wsl::run_in_distro(d, "command -v python3 >/dev/null 2>&1 && echo OK || true")
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
        } else if !distro_installed {
            (
                "needsInstall",
                "Ready to install WSL + Ubuntu automatically.".to_string(),
            )
        } else if !python_ready {
            (
                "needsPython",
                format!(
                    "Ubuntu is installed{} — just needs Python.",
                    default_distro.as_deref().map(|d| format!(" ({d})")).unwrap_or_default()
                ),
            )
        } else {
            (
                "ready",
                format!(
                    "WSL is ready{}.",
                    default_distro.as_deref().map(|d| format!(" ({d})")).unwrap_or_default()
                ),
            )
        };

        WslSetupStatus {
            stage: stage.to_string(),
            virtualization_enabled,
            distro_installed,
            default_distro,
            python_ready,
            detail,
        }
    }

    /// Launch `wsl --install -d Ubuntu` ELEVATED (UAC). On a fresh machine
    /// this single call enables the WSL + Virtual Machine Platform optional
    /// components AND installs Ubuntu. It runs in its own window so the user
    /// sees download progress; it usually asks for a reboot when done.
    /// Start-Process returns as soon as it's launched (we don't -Wait): the
    /// UI polls wsl_setup_status() afterward.
    pub fn install() -> Result<(), String> {
        let status = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "Start-Process -FilePath 'wsl.exe' -ArgumentList '--install','-d','Ubuntu' -Verb RunAs",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| format!("could not launch the elevated installer: {e}"))?;
        if !status.success() {
            return Err("WSL install was cancelled (the UAC prompt was declined).".to_string());
        }
        Ok(())
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
curl -LsSf https://astral.sh/uv/install.sh | sh || echo '   (uv install skipped — offline?)'
echo '>> Done. Versions:'
python3 --version
pip3 --version || true
"#;

        let mut cmd = std::process::Command::new("wsl.exe");
        cmd.arg("-d").arg(distro).arg("-u").arg("root").arg("--").arg("bash").arg("-ls");
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
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

#[tauri::command]
pub async fn wsl_setup_provision_python(
    channel: tauri::ipc::Channel<SetupEvent>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let distro = crate::wsl::wsl_status()
            .default_distro
            .ok_or_else(|| "No WSL distro installed yet — install Ubuntu first.".to_string())?;
        let _ = channel.send(SetupEvent::Started);
        let ch = channel.clone();
        let res = tokio::task::spawn_blocking(move || imp::provision_python(&distro, &ch))
            .await
            .map_err(|e| format!("join error: {e}"))?;
        match res {
            Ok(()) => {
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
