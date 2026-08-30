//! Cross-PC repository synchronization coordinator.
//!
//! One transaction replaces the old fast-forward-only Merge/Push dead end:
//! fetch → classify the graph → (when diverged) integrate in a TEMPORARY
//! worktree with a normal three-way merge → optionally verify the integrated
//! commit → push with a moved-remote retry → fast-forward the local checkout.
//!
//! Design invariants (the reason this module exists — see the 2026-07-22
//! release-rail root-cause decision):
//! - NEVER force-pushes and never rewrites the user's branch; the only local
//!   branch movement is a fast-forward.
//! - NEVER auto-resolves a source conflict by preferring one side. Only
//!   app-owned disposable runtime files are auto-resolved; everything else
//!   stops with both histories intact and a recovery ref already created.
//! - Zero project-specific knowledge: pure Git plus an optional caller-supplied
//!   verify command. Anything project-shaped must arrive as data.
//! - std-only and self-contained so the standalone two-clone regression
//!   harness can compile it via `#[path]` without the Tauri app.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// App-managed runtime files that may be auto-resolved during integration.
/// Deliberately NOT the whole `.owllm/` directory: Project Cards, verify
/// config, skills and media assets are durable project data.
pub fn is_disposable_runtime_path(path: &str) -> bool {
    let p = path.trim().trim_start_matches("./").replace('\\', "/");
    p == ".owllm-inbox"
        || p.starts_with(".owllm-inbox/")
        || p == ".owllm/brainstorm.json"
        || p == ".owllm/eval-traces.jsonl"
}

#[derive(Debug)]
pub struct SyncReport {
    /// "up-to-date" | "pushed" | "fast-forwarded" | "integrated"
    pub action: &'static str,
    pub detail: String,
}

#[derive(Debug)]
pub enum SyncError {
    /// Real overlapping edits. Local branch and origin are both untouched and
    /// a recovery ref points at the local commit — nothing is lost.
    Conflict {
        files: Vec<String>,
        recovery_ref: String,
    },
    /// The integrated commit failed the caller-supplied verify command; the
    /// push was NOT performed.
    VerifyFailed {
        output: String,
    },
    Git(String),
}

fn git_cmd(dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Run git in `dir`; (ok, stdout, stderr). Spawn failures become Err.
fn git(dir: &Path, args: &[&str]) -> Result<(bool, String, String), SyncError> {
    let out = git_cmd(dir).args(args).output().map_err(|e| {
        SyncError::Git(format!(
            "git {} in {}: {}",
            args.join(" "),
            dir.display(),
            e
        ))
    })?;
    Ok((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

fn git_detail(stdout: &str, stderr: &str) -> String {
    let (o, e) = (stdout.trim(), stderr.trim());
    match (e.is_empty(), o.is_empty()) {
        (false, false) => format!("{e}\n{o}"),
        (false, true) => e.to_string(),
        (true, false) => o.to_string(),
        (true, true) => "git exited non-zero without output".to_string(),
    }
}

fn rev_parse(dir: &Path, what: &str) -> Result<Option<String>, SyncError> {
    let (ok, out, _) = git(dir, &["rev-parse", "--verify", "--quiet", what])?;
    Ok(if ok {
        Some(out.trim().to_string())
    } else {
        None
    })
}

fn is_ancestor(dir: &Path, ancestor: &str, descendant: &str) -> Result<bool, SyncError> {
    let (ok, _, _) = git(dir, &["merge-base", "--is-ancestor", ancestor, descendant])?;
    Ok(ok)
}

/// A push rejected because someone else pushed first — the retry case, as
/// opposed to auth/network failures which must surface immediately.
fn is_remote_moved_rejection(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("fetch first")
        || s.contains("non-fast-forward")
        || (s.contains("rejected") && s.contains("behind"))
        || s.contains("cannot lock ref")
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Repos without a committed identity (fresh clone on a new PC) would fail the
/// integration merge commit; fall back to an app identity WITHOUT writing config.
fn identity_args(dir: &Path) -> Result<Vec<String>, SyncError> {
    let (has_name, _, _) = git(dir, &["config", "user.name"])?;
    let (has_email, _, _) = git(dir, &["config", "user.email"])?;
    if has_name && has_email {
        return Ok(vec![]);
    }
    Ok(vec![
        "-c".into(),
        "user.name=OWLLM Sync".into(),
        "-c".into(),
        "user.email=sync@owllm.local".into(),
    ])
}

struct TempWorktree {
    repo: PathBuf,
    path: PathBuf,
}

impl TempWorktree {
    fn add(repo: &Path, at: &str, attempt: u32) -> Result<TempWorktree, SyncError> {
        // Unique per process AND per call — two repos syncing in the same
        // second must not share an integration worktree path.
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "owllm-sync-{}-{}-{}-{}",
            std::process::id(),
            unix_now(),
            seq,
            attempt
        ));
        let path_str = path.to_string_lossy().to_string();
        let (ok, out, err) = git(repo, &["worktree", "add", "--detach", &path_str, at])?;
        if !ok {
            return Err(SyncError::Git(format!(
                "could not create the temporary integration worktree: {}",
                git_detail(&out, &err)
            )));
        }
        Ok(TempWorktree {
            repo: repo.to_path_buf(),
            path,
        })
    }
}

impl Drop for TempWorktree {
    fn drop(&mut self) {
        let path = self.path.to_string_lossy().to_string();
        let _ = git(&self.repo, &["worktree", "remove", "--force", &path]);
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Auto-resolve ONLY disposable app runtime paths after a conflicted merge in
/// the integration worktree ("theirs" = the local commit being integrated).
/// Returns the remaining (real) conflict paths.
fn resolve_runtime_conflicts(wt: &Path, conflicts: &[String]) -> Result<Vec<String>, SyncError> {
    let mut remaining = Vec::new();
    for path in conflicts {
        if !is_disposable_runtime_path(path) {
            remaining.push(path.clone());
            continue;
        }
        let (took_theirs, _, _) = git(wt, &["checkout", "--theirs", "--", path])?;
        if took_theirs {
            let (ok, out, err) = git(wt, &["add", "--", path])?;
            if !ok {
                return Err(SyncError::Git(format!(
                    "could not stage auto-resolved runtime file {path}: {}",
                    git_detail(&out, &err)
                )));
            }
        } else {
            // Deleted on the local side — drop it from the merge result.
            let (ok, out, err) = git(wt, &["rm", "-f", "--ignore-unmatch", "--", path])?;
            if !ok {
                return Err(SyncError::Git(format!(
                    "could not resolve deleted runtime file {path}: {}",
                    git_detail(&out, &err)
                )));
            }
        }
    }
    Ok(remaining)
}

/// Run the caller-supplied verify command inside the integration worktree.
fn run_verify(wt: &Path, cmd: &str) -> Result<(), SyncError> {
    let mut c = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", cmd]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-lc", cmd]);
        c
    };
    c.current_dir(wt);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    let out = c
        .output()
        .map_err(|e| SyncError::Git(format!("could not launch verify command: {e}")))?;
    if out.status.success() {
        return Ok(());
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    // Keep the tail — that is where test runners put the failure.
    let combined = format!("{stdout}\n{stderr}");
    let tail: Vec<&str> = combined.lines().rev().take(40).collect();
    let tail: Vec<&str> = tail.into_iter().rev().collect();
    Err(SyncError::VerifyFailed {
        output: tail.join("\n"),
    })
}

const MAX_PUSH_ATTEMPTS: u32 = 3;

/// Synchronize `repo`'s local history with `origin/<target>`.
///
/// `verify_cmd`, when given, runs against the INTEGRATED commit (in the
/// temporary worktree) before anything is pushed; a failure aborts the push.
pub fn sync_repo(
    repo: &Path,
    target: &str,
    verify_cmd: Option<&str>,
) -> Result<SyncReport, SyncError> {
    let (in_repo, _, _) = git(repo, &["rev-parse", "--git-dir"])?;
    if !in_repo {
        return Err(SyncError::Git(format!(
            "{} is not a git repository",
            repo.display()
        )));
    }
    let (has_origin, _, _) = git(repo, &["remote", "get-url", "origin"])?;
    if !has_origin {
        return Err(SyncError::Git(
            "this repository has no 'origin' remote — nothing to synchronize with".into(),
        ));
    }
    let local_sha = rev_parse(repo, "HEAD")?
        .ok_or_else(|| SyncError::Git("repository has no commits yet".into()))?;
    let current_branch = {
        let (ok, out, _) = git(repo, &["symbolic-ref", "--short", "-q", "HEAD"])?;
        if ok {
            Some(out.trim().to_string())
        } else {
            None
        }
    };
    let remote_ref = format!("origin/{target}");
    let push_refspec = format!("HEAD:refs/heads/{target}");

    for attempt in 1..=MAX_PUSH_ATTEMPTS {
        let (f_ok, f_out, f_err) = git(repo, &["fetch", "origin", target])?;
        // A brand-new remote branch makes `fetch origin <target>` fail; that is
        // the "publish the first commit" case, not an error.
        let remote_sha = rev_parse(repo, &remote_ref)?;
        if !f_ok && remote_sha.is_some() {
            return Err(SyncError::Git(format!(
                "git fetch origin {target} failed: {}",
                git_detail(&f_out, &f_err)
            )));
        }

        let Some(remote_sha) = remote_sha else {
            let (ok, out, err) = git(repo, &["push", "origin", &push_refspec])?;
            if ok {
                return Ok(SyncReport {
                    action: "pushed",
                    detail: format!("Created origin/{target} at {}.", &local_sha[..8]),
                });
            }
            if is_remote_moved_rejection(&err) {
                continue;
            }
            return Err(SyncError::Git(format!(
                "git push failed: {}",
                git_detail(&out, &err)
            )));
        };

        if remote_sha == local_sha {
            return Ok(SyncReport {
                action: "up-to-date",
                detail: format!("Local and origin/{target} are already the same commit."),
            });
        }

        if is_ancestor(repo, &remote_ref, "HEAD")? {
            // Local is strictly ahead — a plain push is a fast-forward on the remote.
            let (ok, out, err) = git(repo, &["push", "origin", &push_refspec])?;
            if ok {
                if current_branch.as_deref() != Some(target) {
                    let _ = git(repo, &["branch", "-f", target, "HEAD"]);
                }
                return Ok(SyncReport {
                    action: "pushed",
                    detail: format!("Pushed local work to origin/{target} (fast-forward)."),
                });
            }
            if is_remote_moved_rejection(&err) {
                continue;
            }
            return Err(SyncError::Git(format!(
                "git push failed: {}",
                git_detail(&out, &err)
            )));
        }

        if is_ancestor(repo, "HEAD", &remote_ref)? {
            // Local is strictly behind — bring the checkout forward, touch nothing else.
            if current_branch.as_deref() == Some(target) {
                let (ok, out, err) = git(repo, &["merge", "--ff-only", &remote_ref])?;
                if !ok {
                    return Err(SyncError::Git(format!(
                        "origin/{target} is ahead but the local checkout could not fast-forward \
                         (local uncommitted edits are in the way): {}",
                        git_detail(&out, &err)
                    )));
                }
                return Ok(SyncReport {
                    action: "fast-forwarded",
                    detail: format!("Fast-forwarded the local checkout to origin/{target}."),
                });
            }
            return Ok(SyncReport {
                action: "up-to-date",
                detail: format!("All local commits are already contained in origin/{target}."),
            });
        }

        // ---- Diverged: integrate on a temporary worktree of origin/<target>. ----
        let recovery_ref = format!(
            "refs/owllm/recovery/sync-{}-{}",
            unix_now(),
            &local_sha[..8.min(local_sha.len())]
        );
        let (rr_ok, rr_out, rr_err) = git(repo, &["update-ref", &recovery_ref, &local_sha])?;
        if !rr_ok {
            return Err(SyncError::Git(format!(
                "could not create the recovery ref before integration: {}",
                git_detail(&rr_out, &rr_err)
            )));
        }

        let wt = TempWorktree::add(repo, &remote_sha, attempt)?;
        let ident = identity_args(repo)?;
        let mut merge_args: Vec<String> = ident.clone();
        merge_args.extend([
            "merge".into(),
            "--no-ff".into(),
            "--no-edit".into(),
            local_sha.clone(),
        ]);
        let merge_refs: Vec<&str> = merge_args.iter().map(String::as_str).collect();
        let (m_ok, m_out, m_err) = git(&wt.path, &merge_refs)?;
        if !m_ok {
            let (_, unmerged, _) = git(&wt.path, &["diff", "--name-only", "--diff-filter=U"])?;
            let conflicts: Vec<String> = unmerged
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect();
            if conflicts.is_empty() {
                return Err(SyncError::Git(format!(
                    "integration merge failed: {}",
                    git_detail(&m_out, &m_err)
                )));
            }
            let remaining = resolve_runtime_conflicts(&wt.path, &conflicts)?;
            if !remaining.is_empty() {
                // Both sides preserved: local branch untouched, origin untouched,
                // recovery ref created. The worktree is dropped — it held no
                // resolution work yet.
                return Err(SyncError::Conflict {
                    files: remaining,
                    recovery_ref,
                });
            }
            let mut commit_args: Vec<String> = ident.clone();
            commit_args.extend(["commit".into(), "--no-edit".into()]);
            let commit_refs: Vec<&str> = commit_args.iter().map(String::as_str).collect();
            let (c_ok, c_out, c_err) = git(&wt.path, &commit_refs)?;
            if !c_ok {
                return Err(SyncError::Git(format!(
                    "could not finish the integration commit: {}",
                    git_detail(&c_out, &c_err)
                )));
            }
        }
        let integrated_sha = rev_parse(&wt.path, "HEAD")?
            .ok_or_else(|| SyncError::Git("integration worktree lost HEAD".into()))?;

        if let Some(cmd) = verify_cmd {
            run_verify(&wt.path, cmd)?;
        }

        let refspec = format!("{integrated_sha}:refs/heads/{target}");
        let (p_ok, p_out, p_err) = git(repo, &["push", "origin", &refspec])?;
        if !p_ok {
            if is_remote_moved_rejection(&p_err) {
                // Someone pushed while we were integrating — refetch and redo.
                continue;
            }
            return Err(SyncError::Git(format!(
                "git push failed after integration: {}",
                git_detail(&p_out, &p_err)
            )));
        }

        // Bring the local checkout to the integrated commit. Only ever a
        // fast-forward; a failure here (dirty overlapping files) is reported
        // but the push already succeeded — nothing is lost.
        let mut local_note = String::new();
        if current_branch.as_deref() == Some(target) {
            let (ff_ok, ff_out, ff_err) = git(repo, &["merge", "--ff-only", &integrated_sha])?;
            if !ff_ok {
                local_note = format!(
                    "\nNote: origin/{target} now has the integrated result, but the local \
                     checkout could not fast-forward: {}",
                    git_detail(&ff_out, &ff_err)
                );
            }
        } else {
            let _ = git(repo, &["branch", "-f", target, &integrated_sha]);
        }

        return Ok(SyncReport {
            action: "integrated",
            detail: format!(
                "Histories had diverged; merged both sides into {} and pushed to origin/{target}. \
                 Recovery ref: {recovery_ref}.{local_note}",
                &integrated_sha[..8]
            ),
        });
    }

    Err(SyncError::Git(format!(
        "origin/{target} kept advancing during synchronization ({MAX_PUSH_ATTEMPTS} attempts) — \
         try again in a moment"
    )))
}
