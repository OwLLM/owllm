// Fleet — per-agent git worktree isolation for parallel dispatches.
//
// Today's React dispatch loop runs every specialist in the same cwd
// (the project location the user picked). When two specialists run
// concurrently — coder + critic, or coder + docs — their edits race on
// the same working tree; one write wins, the other is lost, and git
// state ends up undefined. This module gives each specialist its own
// `git worktree` on a private branch so the parallel runs are
// technically isolated, then a serial squash-merge step folds each
// agent's changes back into the user's project tree with attribution.
//
// Flow per dispatch:
//   1. fleet_worktree_create(project_cwd, agent, run_id)
//        → branch  owllm-fleet/<run_id>/<agent>
//        → path    <fleet_root>/<repo>/<run_id>/<agent>
//   2. specialist's Claude CLI runs with that path as cwd
//   3. fleet_worktree_finalize(path, agent, summary)
//        → git add -A; git commit -m "[<agent>] <summary>"
//        → returns commit sha + count of files changed
//   4. fleet_worktree_merge(path, project_cwd, agent, branch)
//        → from project_cwd: git merge --squash <branch>; commit
//        → on conflict: aborts, returns conflict=true + files
//   5. fleet_worktree_remove(path, branch, keep_on_failure)
//
// Non-git projects: every command returns an `Outcome::NotAGitRepo`
// status so the frontend can fall back to the old "one shared cwd"
// behaviour without a hard error.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Per-run scratch root for OWLLM-managed worktrees.
///   Windows: %LOCALAPPDATA%\owllm\fleet
///   Other:   $HOME/.owllm/fleet
/// Picked OUTSIDE the user's project so worktrees never appear inside
/// their checkout (`.owllm-fleet/` clutter, accidental commits, etc.).
fn fleet_root() -> Option<PathBuf> {
    if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA")
            .map(|d| PathBuf::from(d).join("owllm").join("fleet"))
    } else {
        std::env::var_os("HOME").map(|d| PathBuf::from(d).join(".owllm").join("fleet"))
    }
}

/// Sanitize a string into a path-safe segment (used for repo names and
/// agent names so weird characters in either don't break paths).
fn safe_seg(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect()
}

/// Is `dir` the root of a git repo (or inside one)?
fn is_git_repo(dir: &Path) -> bool {
    Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(dir)
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

/// Run a git command in `dir`, capture stdout+stderr+status.
fn git(dir: &Path, args: &[&str]) -> Result<(bool, String, String), String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("git {} in {}: {}", args.join(" "), dir.display(), e))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    Ok((out.status.success(), stdout, stderr))
}

// ------------------------------------------------------------------
// 1. CREATE — per-agent worktree on a fresh branch
// ------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CreateOutcome {
    /// Worktree created and ready.
    Ready {
        /// Absolute path to the new worktree (use as the agent's cwd).
        path: String,
        /// The branch name we created the worktree on.
        branch: String,
        /// The base commit SHA the branch was cut from (HEAD of
        /// project_cwd at create time). Saved so merge can target
        /// the same point.
        base_sha: String,
    },
    /// project_cwd isn't a git repo — caller should fall back to the
    /// shared-cwd path with no isolation.
    NotAGitRepo,
    /// Working tree has uncommitted changes — would silently end up in
    /// the agent's branch via the base it's cut from. Caller decides
    /// whether to nag the user or force.
    DirtyWorkingTree { details: String },
    /// Anything else (git failure, fs failure). Caller should surface.
    Error { message: String },
}

/// Create a per-agent worktree from `project_cwd`'s HEAD.
#[tauri::command]
pub async fn fleet_worktree_create(
    project_cwd: String,
    agent_name: String,
    run_id: String,
) -> Result<CreateOutcome, String> {
    let cwd = PathBuf::from(&project_cwd);
    if !cwd.is_dir() {
        return Ok(CreateOutcome::Error {
            message: format!("project_cwd does not exist: {}", project_cwd),
        });
    }
    if !is_git_repo(&cwd) {
        return Ok(CreateOutcome::NotAGitRepo);
    }
    // Reject if the working tree is dirty — the agent's branch would
    // be cut from HEAD, so the user's WIP edits would be silently
    // missing from the agent's view. Surface so the user can commit
    // or stash first instead of getting confusing results.
    let (_, status_out, _) = git(&cwd, &["status", "--porcelain"])?;
    if !status_out.trim().is_empty() {
        return Ok(CreateOutcome::DirtyWorkingTree {
            details: status_out.lines().take(20).collect::<Vec<_>>().join("\n"),
        });
    }
    // Resolve the current HEAD SHA so the merge step later can squash
    // from exactly this base.
    let (ok, base_sha, err) = git(&cwd, &["rev-parse", "HEAD"])?;
    if !ok {
        return Ok(CreateOutcome::Error {
            message: format!("rev-parse HEAD failed: {}", err.trim()),
        });
    }
    let base_sha = base_sha.trim().to_string();

    let Some(fleet_root) = fleet_root() else {
        return Ok(CreateOutcome::Error {
            message: "could not resolve a home dir for the fleet scratch root".to_string(),
        });
    };
    let repo_name = cwd
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown");
    let dest = fleet_root
        .join(safe_seg(repo_name))
        .join(safe_seg(&run_id))
        .join(safe_seg(&agent_name));
    if let Some(parent) = dest.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return Ok(CreateOutcome::Error {
                message: format!("mkdir {}: {}", parent.display(), e),
            });
        }
    }
    // Belt-and-braces: if a previous run crashed mid-flight and left a
    // stale worktree at this exact path, prune it before re-creating
    // so the `git worktree add` doesn't fail with "already exists".
    let _ = git(&cwd, &["worktree", "remove", "--force", &dest.to_string_lossy()]);
    let _ = std::fs::remove_dir_all(&dest);

    let branch = format!("owllm-fleet/{}/{}", safe_seg(&run_id), safe_seg(&agent_name));
    // If the branch somehow already exists (interrupted run), delete it
    // first so we can re-create cleanly.
    let _ = git(&cwd, &["branch", "-D", &branch]);

    let dest_str = dest.to_string_lossy().to_string();
    let (ok, _, err) = git(
        &cwd,
        &["worktree", "add", "-b", &branch, &dest_str, "HEAD"],
    )?;
    if !ok {
        return Ok(CreateOutcome::Error {
            message: format!("git worktree add failed: {}", err.trim()),
        });
    }
    Ok(CreateOutcome::Ready {
        path: dest_str,
        branch,
        base_sha,
    })
}

// ------------------------------------------------------------------
// 2. FINALIZE — commit the agent's edits and read back a summary
// ------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum FinalizeOutcome {
    /// Commit landed.
    Committed {
        commit_sha: String,
        /// Count of files in the commit (additions + modifications +
        /// deletions).
        files_changed: u32,
        /// One-line per-file summary: "{status}\t{path}".
        files: Vec<String>,
    },
    /// The agent didn't touch anything — nothing to commit.
    NoChanges,
    Error { message: String },
}

#[tauri::command]
pub async fn fleet_worktree_finalize(
    worktree_path: String,
    agent_name: String,
    summary: String,
) -> Result<FinalizeOutcome, String> {
    let wt = PathBuf::from(&worktree_path);
    if !wt.is_dir() {
        return Ok(FinalizeOutcome::Error {
            message: format!("worktree path does not exist: {}", worktree_path),
        });
    }
    // git add -A captures new + modified + deleted. Without this an
    // agent's freshly-created file would not be in the commit.
    let (ok, _, err) = git(&wt, &["add", "-A"])?;
    if !ok {
        return Ok(FinalizeOutcome::Error {
            message: format!("git add failed: {}", err.trim()),
        });
    }
    // Check if anything to commit.
    let (_, staged, _) = git(&wt, &["status", "--porcelain"])?;
    if staged.trim().is_empty() {
        return Ok(FinalizeOutcome::NoChanges);
    }
    // Per-agent commit. Subject line carries the agent name in [..]
    // so `git log --pretty` immediately shows who did what; the body
    // carries the orchestrator's instruction for context.
    let trimmed_summary = summary.lines().next().unwrap_or("").trim().to_string();
    let subject = if trimmed_summary.is_empty() {
        format!("[{}] dispatch", agent_name)
    } else {
        // Keep subjects <= 72 chars per git convention.
        let head: String = trimmed_summary.chars().take(60).collect();
        format!("[{}] {}", agent_name, head)
    };
    let body = if summary.trim().is_empty() {
        String::new()
    } else {
        format!("\n\n{}", summary.trim())
    };
    let msg = format!("{}{}", subject, body);
    let (ok, _, err) = git(&wt, &["commit", "-m", &msg])?;
    if !ok {
        return Ok(FinalizeOutcome::Error {
            message: format!("git commit failed: {}", err.trim()),
        });
    }
    let (_, sha_out, _) = git(&wt, &["rev-parse", "HEAD"])?;
    let commit_sha = sha_out.trim().to_string();
    let (_, show_out, _) = git(
        &wt,
        &["show", "--name-status", "--format=", &commit_sha],
    )?;
    let files: Vec<String> = show_out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    let files_changed = files.len() as u32;
    Ok(FinalizeOutcome::Committed {
        commit_sha,
        files_changed,
        files,
    })
}

// ------------------------------------------------------------------
// 3. DIFF — read the agent's diff against the run's base
// ------------------------------------------------------------------

#[tauri::command]
pub async fn fleet_worktree_diff(
    worktree_path: String,
    base_sha: String,
) -> Result<String, String> {
    let wt = PathBuf::from(&worktree_path);
    if !wt.is_dir() {
        return Err(format!("worktree path does not exist: {}", worktree_path));
    }
    // Use the three-dot form so the diff is "what THIS branch added on
    // top of the merge-base with base_sha" — same view a PR would show.
    let range = format!("{}...HEAD", base_sha);
    let (ok, out, err) = git(&wt, &["diff", &range])?;
    if !ok {
        return Err(format!("git diff failed: {}", err.trim()));
    }
    Ok(out)
}

// ------------------------------------------------------------------
// 4. MERGE — squash-merge the agent's branch back into project_cwd
// ------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum MergeOutcome {
    /// Cleanly merged + committed in project_cwd.
    Merged {
        commit_sha: String,
        files_changed: u32,
    },
    /// Merge would have conflicted. Aborted; nothing committed in
    /// project_cwd. `files` lists conflict paths; the agent's branch
    /// is left intact so the user can inspect or merge manually.
    Conflict { files: Vec<String> },
    /// Nothing to merge — the agent didn't change anything (No-op).
    NoChanges,
    Error { message: String },
}

#[tauri::command]
pub async fn fleet_worktree_merge(
    project_cwd: String,
    agent_name: String,
    branch: String,
) -> Result<MergeOutcome, String> {
    let cwd = PathBuf::from(&project_cwd);
    if !cwd.is_dir() {
        return Ok(MergeOutcome::Error {
            message: format!("project_cwd does not exist: {}", project_cwd),
        });
    }
    if !is_git_repo(&cwd) {
        return Ok(MergeOutcome::Error {
            message: "project_cwd is not a git repo".to_string(),
        });
    }
    // squash: keep all the agent's commits as one merge commit in the
    // project tree, preserving per-agent attribution but avoiding a
    // noisy linear-history merge of every single agent micro-commit.
    let (ok, _, err) = git(&cwd, &["merge", "--squash", "--no-commit", &branch])?;
    if !ok {
        // Check for conflict — `merge --squash` exits non-zero on either
        // a genuine conflict or a bad ref. Distinguish via diff --check.
        let (_, conflicts, _) = git(&cwd, &["diff", "--name-only", "--diff-filter=U"])?;
        let files: Vec<String> = conflicts
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        // Reset the index so a failed merge doesn't leave staged junk
        // in the user's project tree.
        let _ = git(&cwd, &["reset", "--hard", "HEAD"]);
        if !files.is_empty() {
            return Ok(MergeOutcome::Conflict { files });
        }
        return Ok(MergeOutcome::Error {
            message: format!("git merge --squash failed: {}", err.trim()),
        });
    }
    // If `merge --squash` succeeded but staged nothing, the agent's
    // branch is a fast-forward of HEAD (no new commits to apply).
    let (_, staged, _) = git(&cwd, &["diff", "--cached", "--name-only"])?;
    if staged.trim().is_empty() {
        return Ok(MergeOutcome::NoChanges);
    }
    let msg = format!("[merge:{}] integrate parallel dispatch", agent_name);
    let (ok, _, err) = git(&cwd, &["commit", "-m", &msg])?;
    if !ok {
        return Ok(MergeOutcome::Error {
            message: format!("git commit (merge) failed: {}", err.trim()),
        });
    }
    let (_, sha, _) = git(&cwd, &["rev-parse", "HEAD"])?;
    let commit_sha = sha.trim().to_string();
    let (_, show, _) = git(
        &cwd,
        &["show", "--name-only", "--format=", &commit_sha],
    )?;
    let files_changed = show.lines().filter(|l| !l.trim().is_empty()).count() as u32;
    Ok(MergeOutcome::Merged {
        commit_sha,
        files_changed,
    })
}

// ------------------------------------------------------------------
// 5. REMOVE — drop the worktree (and its branch) once we're done
// ------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveArgs {
    pub project_cwd: String,
    pub worktree_path: String,
    pub branch: String,
    /// When true, leave the worktree + branch on disk (set after a
    /// merge conflict or finalize failure so the user can inspect).
    pub keep: bool,
}

#[tauri::command]
pub async fn fleet_worktree_remove(args: RemoveArgs) -> Result<(), String> {
    let cwd = PathBuf::from(&args.project_cwd);
    if args.keep {
        return Ok(());
    }
    // Best-effort: remove worktree, then delete the branch. Don't
    // fail the dispatch on cleanup failure — the worktree on disk is
    // recoverable, the run completed.
    let _ = git(
        &cwd,
        &["worktree", "remove", "--force", &args.worktree_path],
    );
    let _ = git(&cwd, &["branch", "-D", &args.branch]);
    let _ = std::fs::remove_dir_all(&args.worktree_path);
    Ok(())
}

// ------------------------------------------------------------------
// 6. READ-LAST-COMMIT-FILES — for the auto-doc trigger after merge
// ------------------------------------------------------------------

/// Inspect HEAD's file list in `project_cwd`. The dispatch loop calls
/// this after merging specialist branches to decide whether to
/// auto-dispatch the documentation agent (i.e. did any code file
/// actually change?). Returns just the file paths; the orchestrator
/// reads the actual diff via fleet_worktree_diff if it needs detail.
#[tauri::command]
pub async fn fleet_head_files(project_cwd: String) -> Result<Vec<String>, String> {
    let cwd = PathBuf::from(&project_cwd);
    if !is_git_repo(&cwd) {
        return Ok(Vec::new());
    }
    let (_, out, _) = git(&cwd, &["show", "--name-only", "--format=", "HEAD"])?;
    Ok(out
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect())
}
