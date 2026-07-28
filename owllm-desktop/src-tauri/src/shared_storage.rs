// Shared model storage for multi-user Windows PCs.
//
// Goal: keep the 50 MB binary per-user (so auto-update can swap it
// without UAC), but let the *models* (gigabytes per family) live in a
// single shared `C:\ProgramData\OwLLM Desktop\models\` folder readable
// and writable by every Windows user on the machine.
//
// `C:\ProgramData\` is the Windows-blessed per-machine app data
// location, but its default ACL only grants the Users group READ.
// We need write too. The one-time setup:
//
//   1. Create `C:\ProgramData\OwLLM Desktop\models\`
//   2. Grant the `Users` group full-control with inheritance via icacls
//
// Both steps require admin. We elevate with PowerShell's
// `Start-Process -Verb RunAs` which triggers a UAC prompt the user
// approves once — never again. After that, every Windows account on
// the PC can read/write that folder without further prompts.

use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::paths;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SharedStorageStatus {
    /// True when ProgramData\OwLLM Desktop\models\ exists *and* the
    /// current user has write permission. Mirrors paths::shared_models_root().
    pub enabled: bool,
    /// Fully resolved shared path, when available, regardless of whether
    /// this user can write to it (so the UI can show what the path
    /// WOULD be even if setup hasn't run yet).
    pub path: Option<String>,
    /// True when the directory exists but write-probe failed — likely
    /// means another user enabled it but ACLs weren't permissive enough
    /// somehow. Surfaces a useful diagnostic in the UI.
    pub directory_exists_but_readonly: bool,
}

#[tauri::command]
pub fn shared_storage_status() -> SharedStorageStatus {
    let mut status = SharedStorageStatus {
        enabled: false,
        path: None,
        directory_exists_but_readonly: false,
    };

    if !cfg!(target_os = "windows") {
        return status;
    }

    let programdata = match std::env::var_os("PROGRAMDATA") {
        Some(s) => s,
        None => return status,
    };
    let dir = std::path::PathBuf::from(programdata)
        .join("OwLLM Desktop")
        .join("models");
    status.path = Some(dir.to_string_lossy().into_owned());

    if paths::shared_models_root().is_some() {
        status.enabled = true;
    } else if dir.is_dir() {
        // Folder exists but write-probe failed.
        status.directory_exists_but_readonly = true;
    }

    status
}

/// Trigger the one-time elevated setup. Spawns a PowerShell child with
/// `Start-Process -Verb RunAs` which presents the UAC consent dialog.
/// On approval, the elevated script creates the folder and rewrites
/// its ACL to grant the Users group full control (with inheritance to
/// new children — `(OI)(CI)F`).
///
/// Returns immediately after spawning; the actual elevation completes
/// asynchronously in the OS shell. Callers should poll
/// `shared_storage_status()` afterwards to observe the new state.
#[tauri::command]
pub fn shared_storage_enable() -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err("shared storage is Windows-only".into());
    }

    // The script that needs admin. Quoted carefully because it runs
    // inside a -Command "..." that's itself inside another PowerShell
    // -Command invocation (Start-Process forwards a string).
    //
    // - `New-Item -Force` is idempotent (no error if folder exists)
    // - icacls grants Users:F on the OwLLM Desktop parent so child
    //   folders inherit. (OI) = ObjectInherit, (CI) = ContainerInherit.
    //   /T applies recursively to existing children.
    let elevated_cmd = "\
        $base = Join-Path $env:ProgramData 'OwLLM Desktop'; \
        New-Item -ItemType Directory -Path (Join-Path $base 'models') -Force | Out-Null; \
        & icacls $base /grant '*S-1-5-32-545:(OI)(CI)F' /T | Out-Null; \
        exit 0\
    ";

    // Wrap the elevated script in a Start-Process invocation so the
    // OUTER (non-elevated) PowerShell triggers UAC and the INNER
    // elevated PowerShell runs the actual work.
    let outer = format!(
        "Start-Process -Verb RunAs -WindowStyle Hidden -Wait powershell -ArgumentList '-NoProfile','-WindowStyle','Hidden','-Command','{}'",
        elevated_cmd.replace('\'', "''")
    );

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let status = Command::new("powershell")
            .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &outer])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| format!("failed to spawn powershell: {e}"))?;
        if !status.success() {
            // Exit code can mean: UAC declined (1223), or the elevated
            // process itself failed. We can't distinguish easily, so
            // surface a unified message and let the user retry.
            return Err(format!(
                "elevation failed or was declined (exit code {:?})",
                status.code()
            ));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = elevated_cmd;
        let _ = outer;
        Err("shared storage is Windows-only".into())
    }
}
