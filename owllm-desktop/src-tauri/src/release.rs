// Host-side release publisher — the capability a sandboxed/CLI agent CANNOT have
// (build toolchain + signing key + gh all live on the host). The Publisher agent
// invokes `publish_release`; this runs the vetted scripts/publish-release.sh on
// the host via bash and returns its output. It runs ONLY that one script — not
// arbitrary commands — so it's a controlled escape hatch, gated to the Publisher
// role's tool_allowlist. Model-agnostic (one native tool call → all CLI) and the
// script branches per-OS (all OS).

use std::process::Command;

/// One readiness probe result for the Publisher card's READY / NOT READY tag.
#[derive(serde::Serialize, Clone)]
pub struct ReadyCheck {
    pub id: String,
    pub label: String,
    pub ok: bool,
    pub detail: String,
}

/// Run one git command against the repo on the HOST (native path, native git,
/// native credentials — the exact environment the sandboxed agents lack).
/// GIT_TERMINAL_PROMPT=0 makes a missing credential FAIL FAST instead of
/// hanging the UI waiting for a username prompt that can never be answered.
fn run_git(host_dir: &str, args: &[&str]) -> (bool, String) {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(host_dir).args(args);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    match cmd.output() {
        Ok(out) => {
            let combined = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            (out.status.success(), combined.trim().to_string())
        }
        Err(e) => (false, format!("spawn git: {e}")),
    }
}

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

/// Compute the Publisher card's READY / NOT READY tag. Each check is a real
/// probe, not decoration — in particular `ls-remote` proves push credentials
/// actually work on THIS machine (the failure mode sandboxed agents hit with
/// "could not read Username"). Returns every check so the setup popup can show
/// pass/fail per line.
#[tauri::command]
pub async fn publish_readiness(repo_dir: String) -> Result<Vec<ReadyCheck>, String> {
    let host = crate::agent_tools::host_cwd(&repo_dir);
    tokio::task::spawn_blocking(move || {
        let mut checks: Vec<ReadyCheck> = Vec::new();
        let (repo_ok, repo_out) = run_git(&host, &["rev-parse", "--is-inside-work-tree"]);
        checks.push(ReadyCheck {
            id: "repo".into(),
            label: "Git repository".into(),
            ok: repo_ok,
            detail: if repo_ok { host.clone() } else { repo_out },
        });
        let (rem_ok, rem_out) = if repo_ok {
            run_git(&host, &["remote", "get-url", "origin"])
        } else {
            (false, "skipped — not a git repo".into())
        };
        checks.push(ReadyCheck {
            id: "remote".into(),
            label: "Remote 'origin' configured".into(),
            ok: rem_ok,
            detail: rem_out.clone(),
        });
        let (auth_ok, auth_out) = if rem_ok {
            run_git(&host, &["ls-remote", "--heads", "origin"])
        } else {
            (false, "skipped — no remote".into())
        };
        checks.push(ReadyCheck {
            id: "auth".into(),
            label: "Remote reachable (credentials work)".into(),
            ok: auth_ok,
            detail: if auth_ok {
                "authenticated OK".into()
            } else {
                auth_out.chars().rev().take(300).collect::<Vec<_>>().into_iter().rev().collect()
            },
        });
        let ver = [
            "owllm-desktop/src-tauri/tauri.conf.json",
            "src-tauri/tauri.conf.json",
            "tauri.conf.json",
            "package.json",
        ]
        .iter()
        .find(|p| std::path::Path::new(&host).join(p).is_file());
        checks.push(ReadyCheck {
            id: "version".into(),
            label: "Version file found".into(),
            ok: ver.is_some(),
            detail: ver.map(|p| p.to_string()).unwrap_or_else(|| "no tauri.conf.json / package.json".into()),
        });
        let script = std::path::Path::new(&host).join("owllm-desktop/scripts/finish-and-publish.sh");
        checks.push(ReadyCheck {
            id: "script".into(),
            label: "Publish script present".into(),
            ok: script.is_file(),
            detail: if script.is_file() {
                "owllm-desktop/scripts/finish-and-publish.sh".into()
            } else {
                "finish-and-publish.sh not found — Publish disabled (Commit/Merge still work)".into()
            },
        });
        Ok(checks)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Deterministic host-side commit for the Publisher card. Stages `scope` (a
/// pathspec; empty = whole tree) and commits. "Nothing to commit" is a clean
/// no-op result, not an error.
#[tauri::command]
pub async fn repo_commit(
    repo_dir: String,
    message: String,
    scope: Option<String>,
) -> Result<String, String> {
    let host = crate::agent_tools::host_cwd(&repo_dir);
    tokio::task::spawn_blocking(move || {
        let scope = scope.unwrap_or_default();
        let (add_ok, add_out) = if scope.trim().is_empty() {
            run_git(&host, &["add", "-A"])
        } else {
            run_git(&host, &["add", "-A", "--", scope.trim()])
        };
        if !add_ok {
            return Err(format!("git add failed:\n{add_out}"));
        }
        let msg = if message.trim().is_empty() {
            "Checkpoint from Publisher card".to_string()
        } else {
            message.trim().to_string()
        };
        let (c_ok, c_out) = run_git(&host, &["commit", "-m", &msg]);
        if c_ok {
            Ok(c_out)
        } else if c_out.contains("nothing to commit") || c_out.contains("nothing added to commit") {
            Ok("Nothing to commit — working tree clean.".into())
        } else {
            Err(format!("git commit failed:\n{c_out}"))
        }
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Push the current branch to origin. Fast-forward-only on the remote side,
/// refusing to overwrite history. Lightweight counterpart to repo_merge for
/// the "Push" card in the Code page rail.
#[tauri::command]
pub async fn repo_push(repo_dir: String) -> Result<String, String> {
    let host = crate::agent_tools::host_cwd(&repo_dir);
    tokio::task::spawn_blocking(move || {
        let (cur_ok, cur) = run_git(&host, &["rev-parse", "--abbrev-ref", "HEAD"]);
        if !cur_ok {
            return Err(format!("not on a branch:\n{cur}"));
        }
        let branch = cur.trim();
        let (p_ok, p_out) = run_git(&host, &["push", "origin", branch]);
        if p_ok {
            Ok(format!("Pushed {branch} to origin.\n{p_out}"))
        } else if p_out.contains("Everything up-to-date") {
            Ok("Everything up-to-date.".into())
        } else {
            Err(format!("git push failed:\n{p_out}"))
        }
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Fast-forward-only merge: push HEAD to the target branch on origin, refusing
/// anything that isn't a clean fast-forward. NEVER force-pushes — if the target
/// has diverged, it errors with the reason instead of rewriting history.
#[tauri::command]
pub async fn repo_merge(repo_dir: String, target: Option<String>) -> Result<String, String> {
    let host = crate::agent_tools::host_cwd(&repo_dir);
    tokio::task::spawn_blocking(move || {
        let target = target
            .filter(|t| !t.trim().is_empty())
            .map(|t| t.trim().to_string())
            .unwrap_or_else(|| "main".to_string());
        let (f_ok, f_out) = run_git(&host, &["fetch", "origin", &target]);
        if !f_ok {
            return Err(format!("git fetch origin {target} failed:\n{f_out}"));
        }
        let (anc_ok, _) = run_git(
            &host,
            &["merge-base", "--is-ancestor", &format!("origin/{target}"), "HEAD"],
        );
        if !anc_ok {
            return Err(format!(
                "origin/{target} is NOT an ancestor of HEAD — a fast-forward isn't possible. \
                 Rebase or merge {target} into your branch first; this button never force-pushes."
            ));
        }
        let (p_ok, p_out) = run_git(&host, &["push", "origin", &format!("HEAD:refs/heads/{target}")]);
        if !p_ok {
            return Err(format!("git push failed:\n{p_out}"));
        }
        // Best-effort: move the LOCAL target branch pointer too, so the local
        // checkout doesn't read as behind. Skipped when target is checked out.
        let (cur_ok, cur) = run_git(&host, &["rev-parse", "--abbrev-ref", "HEAD"]);
        if cur_ok && cur != target {
            let _ = run_git(&host, &["branch", "-f", &target, "HEAD"]);
        }
        Ok(format!("Fast-forwarded '{target}' to HEAD and pushed.\n{p_out}"))
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}
