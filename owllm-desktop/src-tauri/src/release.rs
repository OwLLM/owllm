// Host-side release publisher — the capability a sandboxed/CLI agent CANNOT have
// (build toolchain + signing key + gh all live on the host). The Publisher agent
// invokes `publish_release`; this runs the vetted scripts/publish-release.sh on
// the host via bash and returns its output. It runs ONLY that one script — not
// arbitrary commands — so it's a controlled escape hatch, gated to the Publisher
// role's tool_allowlist. Model-agnostic (one native tool call → all CLI) and the
// script branches per-OS (all OS).

use std::process::Command;

/// Convert any project-path shape the agent might pass — Windows `C:\…`, WSL
/// `/mnt/c/…`, or a `\\wsl.localhost\<distro>\mnt\c\…` UNC — into a git-bash
/// POSIX path (`/c/…`) so the script runs correctly under bash.exe on the host.
fn to_gitbash_path(p: &str) -> String {
    let s = p.trim().replace('\\', "/");
    // \\wsl.localhost/<distro>/mnt/<d>/… or //wsl$/… → take from /mnt/<d>/…
    let s = match s.to_lowercase().find("/mnt/") {
        Some(i) if s.to_lowercase().contains("wsl") => s[i..].to_string(),
        _ => s,
    };
    if let Some(rest) = s.strip_prefix("/mnt/") {
        let mut it = rest.splitn(2, '/');
        let drive = it.next().unwrap_or("");
        let tail = it.next().unwrap_or("");
        if drive.len() == 1 {
            return format!("/{}/{}", drive.to_lowercase(), tail);
        }
    }
    if s.len() >= 2 && s.as_bytes()[1] == b':' {
        return format!("/{}{}", s[..1].to_lowercase(), &s[2..]);
    }
    s
}

/// Locate bash: PATH first (Linux/macOS/`bash` on PATH), then the standard Git
/// for Windows install so the host doesn't need bash on PATH.
fn which_bash() -> String {
    #[cfg(windows)]
    for c in [
        "C:/Program Files/Git/bin/bash.exe",
        "C:/Program Files (x86)/Git/bin/bash.exe",
    ] {
        if std::path::Path::new(c).exists() {
            return c.to_string();
        }
    }
    "bash".to_string()
}

/// Build → sign → latest.json → gh release → verify, by running the canonical
/// publish script on the host. `repo_dir` is the project root (the agent's cwd).
/// Returns the script's combined output; errors if it didn't reach a success
/// marker so the agent can't report a phantom release.
#[tauri::command]
pub async fn publish_release(
    repo_dir: String,
    notes: Option<String>,
    dry_run: Option<bool>,
    draft: Option<bool>,
) -> Result<String, String> {
    let posix = to_gitbash_path(&repo_dir);
    let script = format!("{posix}/owllm-desktop/scripts/publish-release.sh");
    let mut args: Vec<String> = vec![script, "--notes".into(), notes.unwrap_or_default()];
    if dry_run.unwrap_or(false) {
        args.push("--dry-run".into());
    }
    if draft.unwrap_or(false) {
        args.push("--draft".into());
    }

    let out = tokio::task::spawn_blocking(move || {
        let bash = which_bash();
        let mut cmd = Command::new(&bash);
        cmd.args(&args);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        cmd.output().map_err(|e| format!("spawn bash ({bash}): {e}"))
    })
    .await
    .map_err(|e| format!("join error: {e}"))??;

    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let ok = out.status.success()
        && (combined.contains("PUBLISH_OK")
            || combined.contains("PUBLISH_DRYRUN_OK")
            || combined.contains("PUBLISH_DRAFT_OK"));
    if ok {
        Ok(combined)
    } else {
        // Tail so the agent sees the real failure, not a truncated head.
        let tail: String = combined.chars().rev().take(2000).collect::<Vec<_>>().into_iter().rev().collect();
        Err(format!("publish did not complete:\n{tail}"))
    }
}

/// Rule-based "finish & publish" — the deterministic host release the SOLO path
/// fires when the goal says publish. Bumps the version, commits ONLY the app dir,
/// pushes, tags, then runs the canonical publish-release.sh — none of it dependent
/// on the model committing/tagging/not-lying. Same host-only requirements +
/// success markers as publish_release.
#[tauri::command]
pub async fn finish_and_publish(repo_dir: String, notes: Option<String>) -> Result<String, String> {
    let posix = to_gitbash_path(&repo_dir);
    let script = format!("{posix}/owllm-desktop/scripts/finish-and-publish.sh");
    let args: Vec<String> = vec![script, "--notes".into(), notes.unwrap_or_default()];

    let out = tokio::task::spawn_blocking(move || {
        let bash = which_bash();
        let mut cmd = Command::new(&bash);
        cmd.args(&args);
        // NO current_dir: repo_dir can be a WSL/posix path Windows can't cd into
        // (os error 267). finish-and-publish.sh cd's to the repo itself (from its
        // own BASH_SOURCE path), exactly like publish_release does.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        cmd.output().map_err(|e| format!("spawn bash ({bash}): {e}"))
    })
    .await
    .map_err(|e| format!("join error: {e}"))??;

    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let ok = out.status.success()
        && (combined.contains("PUBLISH_OK")
            || combined.contains("PUBLISH_DRYRUN_OK")
            || combined.contains("PUBLISH_DRAFT_OK"));
    if ok {
        Ok(combined)
    } else {
        let tail: String = combined.chars().rev().take(2000).collect::<Vec<_>>().into_iter().rev().collect();
        Err(format!("finish_and_publish did not complete:\n{tail}"))
    }
}
