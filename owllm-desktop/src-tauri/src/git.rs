// Lightweight git commands for the Code page header (status / branches /
// commit / diff). Generic, workspace-scoped — distinct from fleet.rs, whose
// git helper is private and worktree-specific. All calls run with
// CREATE_NO_WINDOW so polling git status never flashes a console window.

use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn git_once(dir: &str, args: &[&str]) -> Result<(bool, String, String), String> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(Path::new(dir));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("git {} in {}: {}", args.join(" "), dir, e))?;
    Ok((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

/// Run a git command in `dir`, capturing stdout/stderr/success. Self-heals a
/// corrupt `.git/index` (rebuild from HEAD, retry once) so the Code page's git
/// panel doesn't stay stuck on "index file corrupt" — shares the vault.rs helper.
/// Same for a zeroed branch ref ("current branch appears to be broken"), which
/// otherwise makes every command in the repo fail forever.
fn git(dir: &str, args: &[&str]) -> Result<(bool, String, String), String> {
    let r = git_once(dir, args)?;
    if !r.0 && crate::vault::is_corrupt_index(&r.2) {
        crate::vault::repair_index(Some(Path::new(dir)));
        return git_once(dir, args);
    }
    if !r.0 && crate::vault::is_broken_ref(&r.2) {
        crate::vault::repair_broken_ref(Some(Path::new(dir)));
        return git_once(dir, args);
    }
    Ok(r)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    /// Two-char porcelain status code (e.g. " M", "??", "A ").
    pub code: String,
    pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: String,
    pub ahead: i64,
    pub behind: i64,
    pub files: Vec<GitFile>,
    /// Total changed paths, even when `files` is capped. The Code page polls
    /// this every few seconds; a repo with an un-ignored node_modules has
    /// 100k+ untracked entries, and shipping them all over IPC each poll is
    /// what melts the webview — so `files` carries at most MAX_STATUS_FILES.
    pub total: u64,
    /// App-generated runtime files that are still tracked by Git. They may be
    /// clean now but become recurring dirty changes when OWLLM rewrites them.
    pub nuisance_files: Vec<String>,
}

/// Cap on the per-poll `files` payload (see GitStatus::total).
const MAX_STATUS_FILES: usize = 2000;

/// `git status --porcelain=v1 -b` parsed into a compact summary.
#[tauri::command]
pub async fn git_status(dir: String) -> Result<GitStatus, String> {
    tokio::task::spawn_blocking(move || {
        let empty = GitStatus {
            is_repo: false,
            branch: String::new(),
            ahead: 0,
            behind: 0,
            files: Vec::new(),
            total: 0,
            nuisance_files: Vec::new(),
        };
        // Cheap repo check first — non-repos return is_repo:false (not an error).
        match git(&dir, &["rev-parse", "--is-inside-work-tree"]) {
            Ok((true, out, _)) if out.trim() == "true" => {}
            _ => return Ok(empty),
        }
        let (ok, out, err) = git(&dir, &["status", "--porcelain=v1", "-b"])?;
        if !ok {
            return Err(format!("git status: {err}"));
        }
        let mut branch = String::new();
        let mut ahead = 0i64;
        let mut behind = 0i64;
        let mut files = Vec::new();
        let mut total = 0u64;
        for line in out.lines() {
            if let Some(rest) = line.strip_prefix("## ") {
                // "## main...origin/main [ahead 1, behind 2]" or "## main"
                let name_part = rest.split("...").next().unwrap_or(rest);
                branch = name_part.trim().to_string();
                if let Some(b) = rest.find('[') {
                    let bracket = &rest[b + 1..rest.find(']').unwrap_or(rest.len())];
                    for tok in bracket.split(',') {
                        let t = tok.trim();
                        if let Some(n) = t.strip_prefix("ahead ") {
                            ahead = n.trim().parse().unwrap_or(0);
                        }
                        if let Some(n) = t.strip_prefix("behind ") {
                            behind = n.trim().parse().unwrap_or(0);
                        }
                    }
                }
            } else if line.len() > 3 {
                // Skip OWLLM's own runtime scratch so the publish card never reports a phantom
                // "1 pending" that the user can't commit away — it's app
                // runtime data, not a user change.
                if crate::fleet::is_app_scratch(&line[3..]) {
                    continue;
                }
                total += 1;
                if files.len() < MAX_STATUS_FILES {
                    files.push(GitFile {
                        code: line[..2].to_string(),
                        path: line[3..].to_string(),
                    });
                }
            }
        }
        // Query only known runtime paths; scanning every tracked file on the
        // Code page's five-second status poll is wasteful on large repos.
        let nuisance_files = git(
            &dir,
            &[
                "ls-files",
                "--",
                ".owllm-inbox",
                ".owllm/brainstorm.json",
                ".owllm/eval-traces.jsonl",
            ],
        )
        .ok()
        .filter(|(ok, _, _)| *ok)
        .map(|(_, tracked, _)| {
            tracked
                .lines()
                .map(str::trim)
                .filter(|path| crate::fleet::is_app_scratch(path))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
        Ok(GitStatus {
            is_repo: true,
            branch,
            ahead,
            behind,
            files,
            total,
            nuisance_files,
        })
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::{git_status, truncate_on_char_boundary};
    use std::{fs, process::Command};

    #[tokio::test]
    async fn status_reports_tracked_runtime_but_keeps_project_card_committable() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let git_ok = |args: &[&str]| {
            assert!(Command::new("git")
                .args(args)
                .current_dir(root)
                .status()
                .unwrap()
                .success());
        };
        git_ok(&["init", "-b", "main"]);
        git_ok(&["config", "user.email", "git-status-test@owllm.local"]);
        git_ok(&["config", "user.name", "OwLLM Git Status Test"]);
        fs::create_dir_all(root.join(".owllm-inbox")).unwrap();
        fs::create_dir_all(root.join(".owllm")).unwrap();
        fs::write(root.join(".owllm-inbox/image_1.png"), b"runtime").unwrap();
        fs::write(root.join(".owllm/brainstorm.json"), b"{}\n").unwrap();
        fs::write(root.join(".owllm/project.json"), b"{}\n").unwrap();
        git_ok(&["add", "-A"]);
        git_ok(&["commit", "-m", "fixture"]);

        fs::write(root.join(".owllm-inbox/image_1.png"), b"new runtime").unwrap();
        fs::write(root.join(".owllm/project.json"), b"{\"goal\":\"ship\"}\n").unwrap();
        let status = git_status(root.to_string_lossy().to_string())
            .await
            .unwrap();

        assert_eq!(status.total, 1);
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].path, ".owllm/project.json");
        assert_eq!(
            status.nuisance_files,
            vec![
                ".owllm-inbox/image_1.png".to_string(),
                ".owllm/brainstorm.json".to_string(),
            ]
        );
    }

    #[test]
    fn truncation_backs_off_to_a_char_boundary() {
        // "é" is 2 bytes — cutting at byte 1 lands mid-char and must back off.
        assert_eq!(truncate_on_char_boundary("é", 1), "");
        assert_eq!(truncate_on_char_boundary("aé", 2), "a");
        assert_eq!(truncate_on_char_boundary("aé", 3), "aé");
        // ASCII and short strings pass through untouched.
        assert_eq!(truncate_on_char_boundary("abc", 10), "abc");
        assert_eq!(truncate_on_char_boundary("abc", 2), "ab");
        // The exact shape that used to panic: a multibyte char straddling MAX.
        let s = format!("{}💥", "x".repeat(199_999));
        let t = truncate_on_char_boundary(&s, 200_000);
        assert_eq!(t.len(), 199_999); // backed off past the 4-byte emoji start
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranches {
    pub current: String,
    pub branches: Vec<String>,
}

#[tauri::command]
pub async fn git_branches(dir: String) -> Result<GitBranches, String> {
    tokio::task::spawn_blocking(move || {
        let (_, cur, _) = git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"])?;
        let (ok, out, err) = git(&dir, &["branch", "--format=%(refname:short)"])?;
        if !ok {
            return Err(format!("git branch: {err}"));
        }
        let branches: Vec<String> = out
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        Ok(GitBranches {
            current: cur.trim().to_string(),
            branches,
        })
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Switch to `branch` (or create it with `create=true`).
#[tauri::command]
pub async fn git_checkout(dir: String, branch: String, create: bool) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let args: Vec<&str> = if create {
            vec!["checkout", "-b", &branch]
        } else {
            vec!["checkout", &branch]
        };
        let (ok, out, err) = git(&dir, &args)?;
        if !ok {
            return Err(err.trim().to_string());
        }
        Ok(format!("{out}{err}").trim().to_string())
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Commit. With `all=true`, stages every change first (git add -A).
#[tauri::command]
pub async fn git_commit(dir: String, message: String, all: bool) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        if message.trim().is_empty() {
            return Err("Commit message is empty.".to_string());
        }
        if all {
            let (ok, _, err) = git(&dir, &["add", "-A"])?;
            if !ok {
                return Err(format!("git add: {}", err.trim()));
            }
        }
        let (ok, out, err) = git(&dir, &["commit", "-m", &message])?;
        let combined = format!("{out}{err}");
        if !ok {
            // "nothing to commit" comes back as a failure — surface it plainly.
            return Err(combined.trim().to_string());
        }
        Ok(combined.trim().to_string())
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// First `max` bytes of `s`, backed off to a char boundary — slicing a
/// multibyte string at a raw byte offset panics ("not a char boundary"),
/// which used to kill git_diff on large diffs with non-ASCII content.
fn truncate_on_char_boundary(s: &str, max: usize) -> &str {
    let mut end = max.min(s.len());
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Uncommitted changes vs HEAD (staged + unstaged). Capped so a huge diff
/// can't blow up the IPC payload.
#[tauri::command]
pub async fn git_diff(dir: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        const MAX: usize = 200_000;
        let (ok, out, err) = git(&dir, &["diff", "HEAD"])?;
        if !ok {
            return Err(err.trim().to_string());
        }
        if out.len() > MAX {
            let mut s = truncate_on_char_boundary(&out, MAX).to_string();
            s.push_str("\n\n… (diff truncated)");
            Ok(s)
        } else {
            Ok(out)
        }
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}
