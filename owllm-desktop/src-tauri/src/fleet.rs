// Fleet — per-agent git worktree isolation for filesystem-capable runs.
//
// Every Agentic run that can see a project filesystem receives a private
// `git worktree`, including solo, single-agent, sequential, parallel, and WSL
// runs. This prevents model/tool behavior from mutating the user's shared
// checkout while another page, process, or PC is integrating work. A serial
// squash-merge step folds successful work back with attribution.
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
//        → plain three-way merge; real overlapping edits return Conflict
//          with both sides preserved (never silently prefer one side)
//   5. fleet_worktree_remove(path, branch, keep_on_failure)
//
// Non-git projects return `Outcome::NotAGitRepo`; filesystem-capable Agentic
// runs fail closed and ask the user to initialize Git. They never silently
// downgrade to the shared project directory.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Per-run scratch root for OWLLM-managed worktrees.
///   Windows: %LOCALAPPDATA%\owllm\fleet
///   Other:   $HOME/.owllm/fleet
/// Picked OUTSIDE the user's project so worktrees never appear inside
/// their checkout (`.owllm-fleet/` clutter, accidental commits, etc.).
fn fleet_root() -> Option<PathBuf> {
    if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("owllm").join("fleet"))
    } else {
        std::env::var_os("HOME").map(|d| PathBuf::from(d).join(".owllm").join("fleet"))
    }
}

fn linux_path_to_wsl_unc(distro: &str, linux_path: &str) -> PathBuf {
    let tail = linux_path.trim_start_matches('/').replace('/', "\\");
    PathBuf::from(format!(r"\\wsl.localhost\{distro}\{tail}"))
}

/// Run filesystem operations in the path's owning OS.
///
/// A WSL UNC is an address understood by Windows Explorer, not a reliable
/// Windows filesystem boundary. The redirector may reject `metadata`,
/// `create_dir_all`, or `rename` while the same path is healthy inside the
/// distro. Fleet Git commands already run in WSL; all accompanying filesystem
/// work must do the same or a run can create successfully and then fail during
/// finalize/merge/cleanup.
fn wsl_fs(path: &Path, operation: &str) -> Result<Option<String>, String> {
    let text = path.to_string_lossy();
    let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc(&text) else {
        return Ok(None);
    };
    crate::wsl::run_in_distro(
        &distro,
        &operation.replace("__PATH__", &crate::wsl::sh_quote(&linux_path)),
    )
    .map(Some)
}

fn path_is_dir_native(path: &Path) -> Result<bool, String> {
    if let Some(out) = wsl_fs(
        path,
        "if [ -d __PATH__ ]; then printf '__OWLLM_DIR__=1'; else printf '__OWLLM_DIR__=0'; fi",
    )? {
        return Ok(out.contains("__OWLLM_DIR__=1"));
    }
    Ok(path.is_dir())
}

fn path_is_file_native(path: &Path) -> Result<bool, String> {
    if let Some(out) = wsl_fs(
        path,
        "if [ -f __PATH__ ]; then printf '__OWLLM_FILE__=1'; else printf '__OWLLM_FILE__=0'; fi",
    )? {
        return Ok(out.contains("__OWLLM_FILE__=1"));
    }
    Ok(path.is_file())
}

fn path_exists_native(path: &Path) -> Result<bool, String> {
    if let Some(out) = wsl_fs(
        path,
        "if [ -e __PATH__ ]; then printf '__OWLLM_EXISTS__=1'; else printf '__OWLLM_EXISTS__=0'; fi",
    )? {
        return Ok(out.contains("__OWLLM_EXISTS__=1"));
    }
    Ok(path.exists())
}

fn create_dir_all_native(path: &Path) -> Result<(), String> {
    if wsl_fs(path, "mkdir -p -- __PATH__")?.is_some() {
        return Ok(());
    }
    std::fs::create_dir_all(path).map_err(|e| format!("mkdir {}: {e}", path.display()))
}

fn remove_file_native(path: &Path) -> Result<(), String> {
    if wsl_fs(path, "rm -f -- __PATH__")?.is_some() {
        return Ok(());
    }
    std::fs::remove_file(path).map_err(|e| format!("remove {}: {e}", path.display()))
}

fn remove_dir_all_native(path: &Path) -> Result<(), String> {
    if wsl_fs(path, "rm -rf -- __PATH__")?.is_some() {
        return Ok(());
    }
    std::fs::remove_dir_all(path).map_err(|e| format!("remove {}: {e}", path.display()))
}

fn remove_empty_dir_native(path: &Path) -> Result<(), String> {
    if wsl_fs(path, "rmdir -- __PATH__ 2>/dev/null || true")?.is_some() {
        return Ok(());
    }
    std::fs::remove_dir(path).map_err(|e| format!("remove empty directory {}: {e}", path.display()))
}

fn two_wsl_paths(from: &Path, to: &Path) -> Option<(String, String, String)> {
    let (from_distro, from_linux) = crate::wsl::parse_wsl_unc(&from.to_string_lossy())?;
    let (to_distro, to_linux) = crate::wsl::parse_wsl_unc(&to.to_string_lossy())?;
    from_distro
        .eq_ignore_ascii_case(&to_distro)
        .then_some((from_distro, from_linux, to_linux))
}

fn rename_native(from: &Path, to: &Path) -> Result<(), String> {
    if let Some((distro, from_linux, to_linux)) = two_wsl_paths(from, to) {
        let script = format!(
            "mv -- {} {}",
            crate::wsl::sh_quote(&from_linux),
            crate::wsl::sh_quote(&to_linux)
        );
        crate::wsl::run_in_distro(&distro, &script)?;
        return Ok(());
    }
    std::fs::rename(from, to)
        .map_err(|e| format!("rename {} to {}: {e}", from.display(), to.display()))
}

fn copy_native(from: &Path, to: &Path) -> Result<(), String> {
    if let Some((distro, from_linux, to_linux)) = two_wsl_paths(from, to) {
        let script = format!(
            "cp -- {} {}",
            crate::wsl::sh_quote(&from_linux),
            crate::wsl::sh_quote(&to_linux)
        );
        crate::wsl::run_in_distro(&distro, &script)?;
        return Ok(());
    }
    std::fs::copy(from, to)
        .map(|_| ())
        .map_err(|e| format!("copy {} to {}: {e}", from.display(), to.display()))
}

fn repo_name_for_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some((_, linux_path)) = crate::wsl::parse_wsl_unc(&text) {
        return linux_path
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .filter(|name| !name.is_empty())
            .unwrap_or("unknown")
            .to_string();
    }
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown")
        .to_string()
}

fn fleet_root_for(project_cwd: &str) -> Result<PathBuf, String> {
    let Some((distro, _)) = crate::wsl::parse_wsl_unc(project_cwd) else {
        return fleet_root()
            .ok_or_else(|| "could not resolve a home dir for the fleet scratch root".to_string());
    };
    let output =
        crate::wsl::run_in_distro(&distro, "printf '__OWLLM_FLEET_HOME__=%s\\n' \"$HOME\"")?;
    let home = output
        .lines()
        .find_map(|line| line.trim().strip_prefix("__OWLLM_FLEET_HOME__="))
        .unwrap_or("")
        .trim();
    if home.is_empty() || !home.starts_with('/') {
        return Err(format!(
            "could not resolve the Linux home directory in WSL distro {distro}"
        ));
    }
    Ok(linux_path_to_wsl_unc(
        &distro,
        &format!("{home}/.owllm/fleet"),
    ))
}

fn git_reported_path_for_host(repo: &Path, reported_path: &str) -> PathBuf {
    let repo_text = repo.to_string_lossy();
    if reported_path.starts_with('/') {
        if let Some((distro, _)) = crate::wsl::parse_wsl_unc(&repo_text) {
            return linux_path_to_wsl_unc(&distro, reported_path);
        }
    }
    PathBuf::from(reported_path)
}

/// Per-source-repo lock so two Code pages (or a page + a team dispatch) that
/// cut a worktree off the SAME repo at the same moment don't race on
/// `.git/index.lock`. `git worktree add`/`branch -D` briefly take the repo
/// index lock; concurrent calls otherwise fail with "Unable to create
/// '.git/index.lock': File exists", which surfaced as "Couldn't create the
/// worktree" when opening a second page on a project. Keyed by the repo path.
pub(crate) fn repo_git_lock(repo: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let map = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let key = repo.to_string_lossy().to_string();
    let mut guard = map.lock().unwrap_or_else(|p| p.into_inner());
    guard
        .entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// App-managed runtime files that must NEVER wedge the worktree workflow. These
/// are tracked in some repos and the app
/// rewrites them, so a `git status` on the source is perpetually "dirty" through
/// no fault of the user — which used to make EVERY `fleet_worktree_create` bounce
/// with DirtyWorkingTree. Deliberately do not classify the whole `.owllm/`
/// directory as scratch: Project Cards, verify config, skills, and media assets
/// are durable project data which users must be able to commit and share.
pub(crate) fn is_app_scratch(path: &str) -> bool {
    let p = path.trim().trim_start_matches("./").replace('\\', "/");
    p == ".owllm-inbox"
        || p.starts_with(".owllm-inbox/")
        || p == ".owllm/brainstorm.json"
        || p == ".owllm/eval-traces.jsonl"
}

/// Extract the file path from one `git status --porcelain` line, resolving the
/// rename form (`R  old -> new`) to the new path. Returns "" for a malformed line.
fn porcelain_path(line: &str) -> &str {
    // Format: two status columns + a space, then the path (columns 3..).
    let rest = line.get(3..).unwrap_or("").trim();
    match rest.rsplit_once(" -> ") {
        Some((_, new)) => new.trim(),
        None => rest,
    }
}

fn user_conflict_files(conflicts: &str) -> Vec<String> {
    conflicts
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && !is_app_scratch(s))
        .collect()
}

/// Resolve app-owned paths to the source worktree's HEAD before deciding
/// whether a failed squash contains a real user conflict. Scratch conflicts can
/// coexist with source conflicts; merely hiding their names from the response
/// leaves the index unmerged and makes the card fail forever on every retry.
fn resolve_app_scratch_conflicts(cwd: &Path, conflicts: &str) -> Result<(), String> {
    for path in conflicts
        .lines()
        .map(str::trim)
        .filter(|p| is_app_scratch(p))
    {
        let head_path = format!("HEAD:{path}");
        let (exists_in_head, _, _) = git(cwd, &["cat-file", "-e", &head_path])?;
        let (ok, _, err) = if exists_in_head {
            git(cwd, &["checkout", "HEAD", "--", path])?
        } else {
            git(cwd, &["rm", "-f", "--ignore-unmatch", "--", path])?
        };
        if !ok {
            return Err(format!(
                "could not resolve app-owned merge conflict {path}: {}",
                err.trim()
            ));
        }
    }
    Ok(())
}

pub(crate) fn unstage_app_scratch(cwd: &Path) -> Result<(), String> {
    let (_, staged, _) = git(cwd, &["diff", "--cached", "--name-only"])?;
    for path in staged.lines().map(str::trim).filter(|p| is_app_scratch(p)) {
        // Keep OWLLM-managed scratch out of user commits without deleting the
        // live runtime file. `git reset` restores only the index entry.
        let _ = git(cwd, &["reset", "--", path]);
    }
    Ok(())
}

fn drop_staged_app_scratch(cwd: &Path) -> Result<(), String> {
    let (_, staged, _) = git(cwd, &["diff", "--cached", "--name-only"])?;
    for path in staged.lines().map(str::trim).filter(|p| is_app_scratch(p)) {
        // A squash merge may have applied the branch's runtime scratch into the
        // project checkout. Restore HEAD there as well as clearing the index.
        let _ = git(cwd, &["checkout", "HEAD", "--", path]);
        let _ = git(cwd, &["reset", "--", path]);
    }
    Ok(())
}

/// Identical untracked files can still make `git merge` abort before it starts.
/// Keep them recoverable outside the checkout while the branch adds the same
/// blobs. The guard restores them on an early return; a successful merge
/// discards only the verified-identical backup.
struct UntrackedCollisionBackup {
    cwd: PathBuf,
    root: PathBuf,
    paths: Vec<String>,
    preserve_after_merge: Vec<String>,
    restore_on_drop: bool,
}

impl UntrackedCollisionBackup {
    /// Runtime state belongs to the destination checkout. If a page branch
    /// accidentally tracks an older copy, restore the destination's live file
    /// after Git has applied and unstaged the branch copy.
    fn restore_preserved(&mut self) -> Result<(), String> {
        for path in &self.preserve_after_merge {
            let from = self.root.join(path);
            let to = self.cwd.join(path);
            if !path_exists_native(&from)? {
                continue;
            }
            if path_exists_native(&to)? {
                remove_file_native(&to)
                    .map_err(|e| format!("could not remove merged app state {path}: {e}"))?;
            }
            if let Some(parent) = to.parent() {
                create_dir_all_native(parent).map_err(|e| {
                    format!("could not restore app state directory for {path}: {e}")
                })?;
            }
            rename_native(&from, &to)
                .map_err(|e| format!("could not restore app-owned file {path} after merge: {e}"))?;
        }
        self.preserve_after_merge.clear();
        Ok(())
    }

    fn discard(mut self) {
        self.restore_on_drop = false;
        let _ = remove_dir_all_native(&self.root);
    }
}

impl Drop for UntrackedCollisionBackup {
    fn drop(&mut self) {
        if !self.restore_on_drop {
            return;
        }
        for path in &self.paths {
            let from = self.root.join(path);
            let to = self.cwd.join(path);
            if !path_exists_native(&from).unwrap_or(false)
                || path_exists_native(&to).unwrap_or(true)
            {
                continue;
            }
            if let Some(parent) = to.parent() {
                let _ = create_dir_all_native(parent);
            }
            let _ = rename_native(&from, &to);
        }
        let _ = remove_dir_all_native(&self.root);
    }
}

/// A project checkout can contain uncommitted tracked edits that are byte-for-byte
/// identical to the page branch being merged. Git still aborts before the squash
/// starts ("local changes would be overwritten"). Back up only those identical
/// files, reset them to HEAD so Git can apply the branch, and restore on failure.
struct IdenticalTrackedBackup {
    cwd: PathBuf,
    root: PathBuf,
    paths: Vec<String>,
    restore_on_drop: bool,
}

impl IdenticalTrackedBackup {
    fn discard(mut self) {
        self.restore_on_drop = false;
        let _ = remove_dir_all_native(&self.root);
    }
}

impl Drop for IdenticalTrackedBackup {
    fn drop(&mut self) {
        if !self.restore_on_drop {
            return;
        }
        for path in &self.paths {
            let from = self.root.join(path);
            let to = self.cwd.join(path);
            if !path_exists_native(&from).unwrap_or(false) {
                continue;
            }
            if let Some(parent) = to.parent() {
                let _ = create_dir_all_native(parent);
            }
            let _ = copy_native(&from, &to);
        }
        let _ = remove_dir_all_native(&self.root);
    }
}

/// Move untracked files that the branch is about to add when it is safe to do
/// so. Byte-identical source assets are adopted. App-owned runtime state is
/// preserved regardless of content and restored after the merge. Any other
/// differing file is user content, so it remains untouched and blocks.
fn prepare_untracked_collisions(
    cwd: &Path,
    branch: &str,
) -> Result<Option<UntrackedCollisionBackup>, String> {
    let (ok, added, err) = git(
        cwd,
        &[
            "diff",
            "--name-only",
            "--diff-filter=A",
            "-z",
            "HEAD",
            branch,
        ],
    )?;
    if !ok {
        return Err(format!(
            "could not inspect branch additions before merge: {}",
            err.trim()
        ));
    }

    let mut identical = Vec::new();
    let mut preserve = Vec::new();
    let mut differing = Vec::new();
    for path in added.split('\0').filter(|p| !p.is_empty()) {
        let disk_path = cwd.join(path);
        if !path_is_file_native(&disk_path)? {
            continue;
        }
        let (tracked, _, _) = git(cwd, &["ls-files", "--error-unmatch", "--", path])?;
        if tracked {
            continue;
        }
        if is_app_scratch(path) {
            preserve.push(path.to_string());
            continue;
        }
        let branch_path = format!("{branch}:{path}");
        let (branch_ok, branch_blob, _) = git(cwd, &["rev-parse", &branch_path])?;
        let (disk_ok, disk_blob, _) = git(cwd, &["hash-object", "--", path])?;
        if branch_ok && disk_ok && branch_blob.trim() == disk_blob.trim() {
            identical.push(path.to_string());
        } else {
            differing.push(path.to_string());
        }
    }

    if !differing.is_empty() {
        return Err(format!(
            "merge would overwrite untracked files whose contents differ from the page branch; move or commit them first: {}",
            differing.join(", ")
        ));
    }
    if identical.is_empty() && preserve.is_empty() {
        return Ok(None);
    }

    let (git_dir_ok, git_dir, git_dir_err) = git(cwd, &["rev-parse", "--absolute-git-dir"])?;
    if !git_dir_ok {
        return Err(format!(
            "could not locate the repository metadata for untracked-file backup: {}",
            git_dir_err.trim()
        ));
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    // Keep the backup under Git metadata: it stays on the repository's own
    // filesystem (so rename remains atomic), is invisible to status/merge, and
    // works for ordinary clones and linked worktrees on every platform.
    let root = git_reported_path_for_host(cwd, git_dir.trim()).join(format!(
        "owllm-merge-untracked-{}-{nonce}",
        std::process::id()
    ));
    let mut moved = Vec::new();
    for path in identical.iter().chain(preserve.iter()) {
        let from = cwd.join(path);
        let to = root.join(path);
        if let Some(parent) = to.parent() {
            create_dir_all_native(parent)
                .map_err(|e| format!("could not prepare untracked-file backup for {path}: {e}"))?;
        }
        if let Err(e) = rename_native(&from, &to) {
            let guard = UntrackedCollisionBackup {
                cwd: cwd.to_path_buf(),
                root,
                paths: moved,
                preserve_after_merge: preserve.clone(),
                restore_on_drop: true,
            };
            drop(guard);
            return Err(format!(
                "could not preserve identical untracked file {path} before merge: {e}"
            ));
        }
        moved.push(path.clone());
    }

    Ok(Some(UntrackedCollisionBackup {
        cwd: cwd.to_path_buf(),
        root,
        paths: moved,
        preserve_after_merge: preserve,
        restore_on_drop: true,
    }))
}

/// Reset only tracked local edits whose on-disk bytes already match the page
/// branch. Those edits are almost always leftovers from a previous failed
/// release/merge attempt; letting Git abort on them wedges every retry.
fn prepare_identical_tracked_collisions(
    cwd: &Path,
    branch: &str,
) -> Result<Option<IdenticalTrackedBackup>, String> {
    let (ok, changed, err) = git(cwd, &["diff", "--name-only", "-z", "HEAD", branch])?;
    if !ok {
        return Err(format!(
            "could not inspect branch changes before merge: {}",
            err.trim()
        ));
    }

    let mut identical = Vec::new();
    let mut differing = Vec::new();
    for path in changed.split('\0').filter(|p| !p.is_empty()) {
        let (tracked, _, _) = git(cwd, &["ls-files", "--error-unmatch", "--", path])?;
        if !tracked {
            continue;
        }
        let (unstaged_clean, _, _) = git(cwd, &["diff", "--quiet", "--", path])?;
        let (staged_clean, _, _) = git(cwd, &["diff", "--cached", "--quiet", "--", path])?;
        if unstaged_clean && staged_clean {
            continue;
        }
        if !staged_clean {
            differing.push(path.to_string());
            continue;
        }

        let disk_path = cwd.join(path);
        let branch_path = format!("{branch}:{path}");
        let (branch_ok, branch_blob, _) = git(cwd, &["rev-parse", &branch_path])?;
        let (disk_ok, disk_blob, _) = git(cwd, &["hash-object", "--", path])?;
        if path_is_file_native(&disk_path)?
            && branch_ok
            && disk_ok
            && branch_blob.trim() == disk_blob.trim()
        {
            identical.push(path.to_string());
        } else {
            differing.push(path.to_string());
        }
    }

    if !differing.is_empty() {
        return Err(format!(
            "merge would overwrite tracked local changes whose contents differ from the page branch; commit or stash them first: {}",
            differing.join(", ")
        ));
    }
    if identical.is_empty() {
        return Ok(None);
    }

    let (git_dir_ok, git_dir, git_dir_err) = git(cwd, &["rev-parse", "--absolute-git-dir"])?;
    if !git_dir_ok {
        return Err(format!(
            "could not locate the repository metadata for tracked-file backup: {}",
            git_dir_err.trim()
        ));
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let root = git_reported_path_for_host(cwd, git_dir.trim()).join(format!(
        "owllm-merge-tracked-{}-{nonce}",
        std::process::id()
    ));
    let mut backed_up = Vec::new();
    for path in &identical {
        let from = cwd.join(path);
        let to = root.join(path);
        if let Some(parent) = to.parent() {
            if let Err(e) = create_dir_all_native(parent) {
                let guard = IdenticalTrackedBackup {
                    cwd: cwd.to_path_buf(),
                    root,
                    paths: backed_up,
                    restore_on_drop: true,
                };
                drop(guard);
                return Err(format!(
                    "could not prepare tracked-file backup for {path}: {e}"
                ));
            }
        }
        if let Err(e) = copy_native(&from, &to) {
            let guard = IdenticalTrackedBackup {
                cwd: cwd.to_path_buf(),
                root,
                paths: backed_up,
                restore_on_drop: true,
            };
            drop(guard);
            return Err(format!(
                "could not preserve identical tracked file {path}: {e}"
            ));
        }
        let (reset_ok, _, reset_err) = git(cwd, &["checkout", "--", path])?;
        if !reset_ok {
            let guard = IdenticalTrackedBackup {
                cwd: cwd.to_path_buf(),
                root,
                paths: backed_up,
                restore_on_drop: true,
            };
            drop(guard);
            return Err(format!(
                "could not reset identical tracked file {path} before merge: {}",
                reset_err.trim()
            ));
        }
        backed_up.push(path.clone());
    }

    Ok(Some(IdenticalTrackedBackup {
        cwd: cwd.to_path_buf(),
        root,
        paths: backed_up,
        restore_on_drop: true,
    }))
}

/// Sanitize a string into a path-safe segment (used for repo names and
/// agent names so weird characters in either don't break paths).
fn safe_seg(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Regenerable build-cache directories a fleet worktree accumulates once the app
/// is built inside it. A Rust `target/` alone is 8-17 GB, so the pile of KEPT
/// page/crashed worktrees (which the sweep never fully deletes because they hold
/// unmerged edits) is what silently fills the disk. Reclaiming these loses
/// nothing — they rebuild on demand.
const BUILD_CACHE_DIR_NAMES: &[&str] = &["target", "node_modules", "dist"];

/// Strip regenerable build caches from `worktree` in place, preserving all
/// source. A directory is removed only when BOTH hold: its name is a known build
/// cache, AND git confirms it is ignored (so it is provably not tracked source
/// nor the user's uncommitted untracked work). A cache touched in the last hour
/// is left alone in case a build is live in it right now. The walk is bounded to
/// a shallow depth so a deep dependency tree is never fully traversed.
/// Best-effort; returns the number of cache directories removed.
fn reclaim_build_caches(worktree: &Path) -> u32 {
    fn walk(root: &Path, dir: &Path, depth: u32, removed: &mut u32) {
        if depth == 0 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name();
            let path = entry.path();
            if name == ".git" {
                continue;
            }
            let is_cache = name
                .to_str()
                .map(|n| BUILD_CACHE_DIR_NAMES.contains(&n))
                .unwrap_or(false);
            if !is_cache {
                walk(root, &path, depth - 1, removed);
                continue;
            }
            // Only delete a build-cache dir git actually ignores — guarantees it
            // is an artifact, never source or the user's uncommitted work.
            let ignored = git(root, &["check-ignore", "-q", &path.to_string_lossy()])
                .map(|(ok, _, _)| ok)
                .unwrap_or(false);
            // Skip a cache modified within the last hour: a build may be live in
            // it, and yanking target/ mid-compile forces a needless rebuild.
            let recent = std::fs::metadata(&path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .map(|e| e.as_secs() < 3600)
                .unwrap_or(false);
            if ignored && !recent && std::fs::remove_dir_all(&path).is_ok() {
                *removed += 1;
            }
            // Never descend into a build-cache-named dir.
        }
    }
    let mut removed = 0;
    walk(worktree, worktree, 4, &mut removed);
    removed
}

/// Suppresses the console window that a spawned `git` would otherwise FLASH on
/// Windows. Without this every git call (and fleet_worktree_create makes ~6)
/// pops a black CMD window — the storm of flashing the user hit when opening a
/// project on the Code page. The other git helper (git.rs) already does this.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A `git` Command rooted at `dir` that never flashes a console window.
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

/// Is `dir` the root of a git repo (or inside one)?
fn is_git_repo(dir: &Path) -> Result<bool, String> {
    let (ok, out, _) = git_once(dir, &["rev-parse", "--is-inside-work-tree"])?;
    Ok(ok && out.trim() == "true")
}

/// Give a project folder OWLLM created the local repository agent isolation
/// needs. Worktrees are pure LOCAL git — `git worktree add` from HEAD, no
/// remote, no fetch, no token — so `git init` plus one commit is the whole
/// requirement and it works offline and signed out of GitHub.
///
/// Refuses folders OWLLM does not own: without the `.owllm` card directory it
/// returns `Ok(false)` instead of silently turning a directory the user picked
/// into a repository. Returns `Ok(true)` only when this call created it.
pub fn ensure_owned_git_repo(dir: &Path) -> Result<bool, String> {
    if is_git_repo(dir)? {
        return Ok(false);
    }
    if !path_is_dir_native(&dir.join(".owllm"))? {
        return Ok(false);
    }
    let (ok, _, err) = git_once(dir, &["init", "-q"])?;
    if !ok {
        return Err(format!("git init in {}: {err}", dir.display()));
    }
    git_once(dir, &["add", "-A"])?;
    const MSG: &str = "OWLLM project init";
    let (committed, _, commit_err) = git_once(dir, &["commit", "-q", "--allow-empty", "-m", MSG])?;
    if !committed {
        // A machine with no configured git identity cannot commit, which would
        // leave a repo with no HEAD for `git worktree add` to branch from.
        let (ok, _, err) = git_once(
            dir,
            &[
                "-c",
                "user.email=agent@owllm.local",
                "-c",
                "user.name=OWLLM",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                MSG,
            ],
        )?;
        if !ok {
            let detail = if err.trim().is_empty() { commit_err } else { err };
            return Err(format!("git commit in {}: {detail}", dir.display()));
        }
    }
    Ok(true)
}

/// Self-heal for a run that hit `NotAGitRepo`: initialize the repository when
/// the folder is one OWLLM created. Errors are surfaced, never swallowed.
#[tauri::command]
pub async fn fleet_repo_init(project_cwd: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let dir = PathBuf::from(&project_cwd);
        if !path_is_dir_native(&dir)? {
            return Err(format!("project folder does not exist: {project_cwd}"));
        }
        ensure_owned_git_repo(&dir)
    })
    .await
    .map_err(|e| format!("repo init task failed: {e}"))?
}

fn git_once(dir: &Path, args: &[&str]) -> Result<(bool, String, String), String> {
    let dir_text = dir.to_string_lossy();
    let out = if let Some((distro, linux_cwd)) = crate::wsl::parse_wsl_unc(&dir_text) {
        let mapped_args: Vec<String> = args
            .iter()
            .map(|arg| {
                crate::wsl::parse_wsl_unc(arg)
                    .filter(|(arg_distro, _)| arg_distro.eq_ignore_ascii_case(&distro))
                    .map(|(_, linux_path)| linux_path)
                    .unwrap_or_else(|| (*arg).to_string())
            })
            .collect();
        crate::wsl::wsl_program_command(&distro, &linux_cwd, "git", &mapped_args)
            .output()
            .map_err(|e| {
                format!(
                    "git {} in WSL {}:{}: {}",
                    args.join(" "),
                    distro,
                    linux_cwd,
                    e
                )
            })?
    } else {
        git_cmd(dir)
            .args(args)
            .output()
            .map_err(|e| format!("git {} in {}: {}", args.join(" "), dir.display(), e))?
    };
    let stdout = crate::wsl::decode_wsl(&out.stdout);
    let stderr = crate::wsl::decode_wsl(&out.stderr);
    Ok((out.status.success(), stdout, stderr))
}

/// Run a git command in `dir`, capture stdout+stderr+status. Self-heals a
/// corrupt `.git/index` (rebuild from HEAD, retry once) so a per-agent worktree
/// isn't wedged by a partial index write — shares the vault.rs helper.
fn git(dir: &Path, args: &[&str]) -> Result<(bool, String, String), String> {
    let r = git_once(dir, args)?;
    if !r.0 && crate::vault::is_corrupt_index(&r.2) {
        crate::vault::repair_index(Some(dir));
        return git_once(dir, args);
    }
    Ok(r)
}

fn git_failure_message(action: &str, stdout: &str, stderr: &str) -> String {
    let stderr = stderr.trim();
    let stdout = stdout.trim();
    let detail = match (stderr.is_empty(), stdout.is_empty()) {
        (false, false) => format!("{stderr}\n{stdout}"),
        (false, true) => stderr.to_string(),
        (true, false) => stdout.to_string(),
        (true, true) => "git exited non-zero without stdout/stderr".to_string(),
    };
    format!("{action}: {detail}")
}

// ------------------------------------------------------------------
// 1. CREATE — per-agent worktree on a fresh branch
// ------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
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
        /// Set when the shared checkout had uncommitted tracked work that was
        /// saved as a checkpoint commit so this worktree could be cut. Callers
        /// surface it so the user can see (and undo) what OWLLM committed.
        #[serde(skip_serializing_if = "Option::is_none")]
        checkpoint_sha: Option<String>,
        /// Files captured by that checkpoint commit.
        #[serde(skip_serializing_if = "Vec::is_empty", default)]
        checkpoint_files: Vec<String>,
    },
    /// project_cwd isn't a git repo. Filesystem-capable callers must stop;
    /// there is no safe shared-cwd fallback.
    NotAGitRepo,
    /// Working tree has uncommitted changes — would silently end up in
    /// the agent's branch via the base it's cut from. Caller decides
    /// whether to nag the user or force.
    DirtyWorkingTree { details: String },
    /// Anything else (git failure, fs failure). Caller should surface.
    Error { message: String },
}

/// True if `path` exists and is a directory the host can actually reach.
/// Used by the dispatch loop to detect an unreachable cwd (e.g. a
/// `\\wsl.localhost\...` isolation path when the WSL distro is stopped) so it
/// can fall back to the host folder instead of failing every worktree.
#[tauri::command]
pub fn path_is_dir(path: String) -> bool {
    !path.trim().is_empty() && path_is_dir_native(&PathBuf::from(path)).unwrap_or(false)
}

/// Create a per-agent worktree from `project_cwd`'s HEAD.
#[tauri::command]
pub async fn fleet_worktree_create(
    project_cwd: String,
    agent_name: String,
    run_id: String,
    // Branch namespace. Team-run worktrees use the default "owllm-fleet" (the
    // team-run sweep reclaims those). The Code page passes "owllm-page" so its
    // per-page worktrees — which hold the user's UNMERGED edits — live in their
    // own namespace and are NEVER touched by the team sweep.
    branch_prefix: Option<String>,
    // TRUE only for an agent RUN the user just started. Uncommitted tracked work
    // is then checkpointed so the run is not blocked. The Code page cuts its
    // worktree merely by OPENING a project, which must never commit on the
    // user's behalf, so it leaves this unset and keeps the dirty-tree stop.
    checkpoint_dirty: Option<bool>,
) -> Result<CreateOutcome, String> {
    let cwd = PathBuf::from(&project_cwd);
    let cwd_exists = match path_is_dir_native(&cwd) {
        Ok(exists) => exists,
        Err(message) => return Ok(CreateOutcome::Error { message }),
    };
    if !cwd_exists {
        return Ok(CreateOutcome::Error {
            message: format!("project_cwd does not exist: {}", project_cwd),
        });
    }
    let is_repo = match is_git_repo(&cwd) {
        Ok(is_repo) => is_repo,
        Err(message) => return Ok(CreateOutcome::Error { message }),
    };
    if !is_repo {
        return Ok(CreateOutcome::NotAGitRepo);
    }
    // Serialize creates against THIS repo so two pages opening the same project
    // don't race on `.git/index.lock`. Held for the whole create sequence.
    let lock = repo_git_lock(&cwd);
    let _create_guard = lock.lock().unwrap_or_else(|p| p.into_inner());
    // Reject if there are uncommitted TRACKED changes — the branch is cut from
    // HEAD, so those edits would be silently missing from the new worktree.
    // CRITICAL perf: `--untracked-files=no` skips enumerating untracked files.
    // A plain `git status --porcelain` walks the ENTIRE working tree (node_modules,
    // venvs, build output) — a 20-40s stall on a real project, which is exactly
    // why opening a Code page on a recent folder felt frozen. Untracked files
    // aren't in HEAD anyway, so not warning about them costs nothing.
    // App-managed runtime scratch is filtered out: the app keeps
    // those "dirty" on its own, and blocking on them wedged the Code page.
    let (_, status_out, _) = git(&cwd, &["status", "--porcelain", "--untracked-files=no"])?;
    let dirty: Vec<&str> = status_out
        .lines()
        .filter(|l| !l.trim().is_empty() && !is_app_scratch(porcelain_path(l)))
        .collect();
    // A dirty checkout used to be a HARD STOP, and that is what deadlocked team
    // runs: the shared folder picks up uncommitted work (the user's, or an
    // orchestrator's), every specialist worktree then refuses to cut, the whole
    // dispatch aborts, and the Notebook queue idles forever with nothing to fix
    // it. Checkpoint the tracked work instead — nothing is lost, the checkout is
    // clean, and merge-back (which also refuses to overwrite dirty tracked
    // files) works. The hard stop remains only if the checkpoint itself fails.
    let mut checkpoint: Option<Checkpoint> = None;
    if !dirty.is_empty() {
        let listing = dirty.iter().take(20).copied().collect::<Vec<_>>().join("\n");
        if !checkpoint_dirty.unwrap_or(false) {
            return Ok(CreateOutcome::DirtyWorkingTree { details: listing });
        }
        match checkpoint_uncommitted(&cwd) {
            Ok(saved) => checkpoint = Some(saved),
            Err(message) => {
                return Ok(CreateOutcome::DirtyWorkingTree {
                    details: format!("{}\n\n{}", message, listing),
                });
            }
        }
    }
    // Opening a Coding page is a local operation: its private worktree is cut
    // from the checkout the user actually has on this device. A local branch
    // may legitimately be ahead of or diverged from origin while work is in
    // progress; forcing remote reconciliation here made those projects
    // impossible to open even though Agentic could use the same folder.
    // Remote-history safety still runs at integration time (merge/publish),
    // where rewriting or publishing divergent history would be consequential.
    // Resolve the current HEAD SHA so the merge step later can squash
    // from exactly this base.
    let (ok, base_sha, err) = git(&cwd, &["rev-parse", "HEAD"])?;
    if !ok {
        return Ok(CreateOutcome::Error {
            message: format!("rev-parse HEAD failed: {}", err.trim()),
        });
    }
    let base_sha = base_sha.trim().to_string();

    let fleet_root = match fleet_root_for(&project_cwd) {
        Ok(root) => root,
        Err(message) => {
            return Ok(CreateOutcome::Error { message });
        }
    };
    let repo_name = repo_name_for_path(&cwd);
    let dest = fleet_root
        .join(safe_seg(&repo_name))
        .join(safe_seg(&run_id))
        .join(safe_seg(&agent_name));
    if let Some(parent) = dest.parent() {
        if let Err(e) = create_dir_all_native(parent) {
            return Ok(CreateOutcome::Error { message: e });
        }
    }
    // Belt-and-braces: if a previous run crashed mid-flight and left a
    // stale worktree at this exact path, prune it before re-creating
    // so the `git worktree add` doesn't fail with "already exists".
    let _ = git(
        &cwd,
        &["worktree", "remove", "--force", &dest.to_string_lossy()],
    );
    let _ = remove_dir_all_native(&dest);

    let prefix = branch_prefix
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("owllm-fleet");
    let branch = format!("{}/{}/{}", prefix, safe_seg(&run_id), safe_seg(&agent_name));
    // If the branch somehow already exists (interrupted run), delete it
    // first so we can re-create cleanly.
    let _ = git(&cwd, &["branch", "-D", &branch]);

    let dest_str = dest.to_string_lossy().to_string();
    let (ok, _, err) = git(&cwd, &["worktree", "add", "-b", &branch, &dest_str, "HEAD"])?;
    if !ok {
        return Ok(CreateOutcome::Error {
            message: format!("git worktree add failed: {}", err.trim()),
        });
    }
    let (checkpoint_sha, checkpoint_files) = match checkpoint {
        Some(saved) => (Some(saved.sha), saved.files),
        None => (None, Vec::new()),
    };
    Ok(CreateOutcome::Ready {
        path: dest_str,
        branch,
        base_sha,
        checkpoint_sha,
        checkpoint_files,
    })
}

/// Uncommitted tracked work saved so an isolated worktree could be cut.
struct Checkpoint {
    sha: String,
    files: Vec<String>,
}

/// Commit the shared checkout's uncommitted TRACKED work.
///
/// `git add -u` stages modifications, deletions and both halves of a rename
/// while leaving untracked files alone; OWLLM's own runtime scratch is then
/// unstaged so it never lands in the user's history. The commit is reversible
/// with `git reset --soft <sha>^`, and hooks are skipped because a repo-side
/// pre-commit hook must not be able to wedge an agent run.
fn checkpoint_uncommitted(cwd: &Path) -> Result<Checkpoint, String> {
    let (ok, _, err) = git(cwd, &["add", "-u"])?;
    if !ok {
        return Err(format!(
            "could not stage the uncommitted tracked changes: {}",
            err.trim()
        ));
    }
    unstage_app_scratch(cwd)?;
    let (_, staged, _) = git(cwd, &["diff", "--cached", "--name-only"])?;
    let files: Vec<String> = staged
        .lines()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect();
    if files.is_empty() {
        return Err("the uncommitted tracked changes could not be staged".to_string());
    }
    let message = "checkpoint: save uncommitted work before an isolated agent run\n\n\
        OWLLM cuts every agent a private git worktree from HEAD, so the shared\n\
        checkout has to be clean. This commit preserves the work that was open\n\
        at that moment. Undo it with `git reset --soft HEAD~1`.";
    let (ok, out, err) = git(cwd, &["commit", "--no-verify", "-m", message])?;
    if !ok {
        return Err(git_failure_message("checkpoint commit failed", &out, &err));
    }
    let (ok, sha, err) = git(cwd, &["rev-parse", "HEAD"])?;
    if !ok {
        return Err(format!(
            "checkpoint commit could not be resolved: {}",
            err.trim()
        ));
    }
    Ok(Checkpoint {
        sha: sha.trim().to_string(),
        files,
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
    Error {
        message: String,
    },
}

#[tauri::command]
pub async fn fleet_worktree_finalize(
    worktree_path: String,
    agent_name: String,
    summary: String,
) -> Result<FinalizeOutcome, String> {
    tokio::task::spawn_blocking(move || {
        fleet_worktree_finalize_blocking(worktree_path, agent_name, summary)
    })
    .await
    .map_err(|e| format!("worktree finalize task failed: {e}"))?
}

fn fleet_worktree_finalize_blocking(
    worktree_path: String,
    agent_name: String,
    summary: String,
) -> Result<FinalizeOutcome, String> {
    let wt = PathBuf::from(&worktree_path);
    if !path_is_dir_native(&wt)? {
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
    if let Err(message) = unstage_app_scratch(&wt) {
        return Ok(FinalizeOutcome::Error { message });
    }
    // Check if anything staged remains after OWLLM runtime scratch was removed
    // from the index. Full porcelain still includes unstaged scratch files,
    // which made scratch-only worktrees call `git commit` with nothing staged.
    let (_, staged, _) = git(&wt, &["diff", "--cached", "--name-only"])?;
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
    let (ok, out, err) = git(&wt, &["commit", "-m", &msg])?;
    if !ok {
        return Ok(FinalizeOutcome::Error {
            message: git_failure_message("git commit failed", &out, &err),
        });
    }
    let (_, sha_out, _) = git(&wt, &["rev-parse", "HEAD"])?;
    let commit_sha = sha_out.trim().to_string();
    let (_, show_out, _) = git(&wt, &["show", "--name-status", "--format=", &commit_sha])?;
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
    if !path_is_dir_native(&wt)? {
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

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum MergeOutcome {
    /// Cleanly merged + committed in project_cwd.
    Merged {
        commit_sha: String,
        files_changed: u32,
    },
    /// Nothing to merge — the agent didn't change anything (No-op).
    NoChanges,
    /// Real overlapping edits. Both sides are preserved untouched — the page
    /// branch keeps its commits and the project checkout is reset to HEAD.
    Conflict {
        files: Vec<String>,
    },
    Error {
        message: String,
    },
}

#[tauri::command]
pub async fn fleet_worktree_merge(
    project_cwd: String,
    agent_name: String,
    branch: String,
) -> Result<MergeOutcome, String> {
    tokio::task::spawn_blocking(move || {
        fleet_worktree_merge_blocking(project_cwd, agent_name, branch)
    })
    .await
    .map_err(|e| format!("worktree merge task failed: {e}"))?
}

fn fleet_worktree_merge_blocking(
    project_cwd: String,
    agent_name: String,
    branch: String,
) -> Result<MergeOutcome, String> {
    let cwd = PathBuf::from(&project_cwd);
    if !path_is_dir_native(&cwd)? {
        return Ok(MergeOutcome::Error {
            message: format!("project_cwd does not exist: {}", project_cwd),
        });
    }
    if !is_git_repo(&cwd)? {
        return Ok(MergeOutcome::Error {
            message: "project_cwd is not a git repo".to_string(),
        });
    }
    // Code and Agentic pages share this command and may finish together. Git's
    // project index is single-writer, so serialize the entire merge/commit
    // transaction per repository instead of surfacing transient index.lock
    // failures or interleaving one page's staged squash with another's.
    let lock = repo_git_lock(&cwd);
    let _merge_guard = lock.lock().unwrap_or_else(|p| p.into_inner());
    fleet_worktree_merge_locked(&cwd, &agent_name, &branch)
}

/// Merge while the caller holds `repo_git_lock(cwd)`.
///
/// Keeping the lock outside this helper lets the isolated Sync coordinator
/// retain exclusive ownership across local integration and remote
/// reconciliation. The public merge command still takes the same lock above.
fn fleet_worktree_merge_locked(
    cwd: &Path,
    agent_name: &str,
    branch: &str,
) -> Result<MergeOutcome, String> {
    // Integrate into the user's CURRENT local branch. Cross-PC reconciliation
    // belongs to the single repo_sync coordinator after local integration.
    // Fetching here with a fast-forward-only policy made a valid isolated run
    // impossible to merge whenever another PC had advanced origin/main.
    let mut untracked_backup = match prepare_untracked_collisions(cwd, branch) {
        Ok(backup) => backup,
        Err(message) => return Ok(MergeOutcome::Error { message }),
    };
    let tracked_backup = match prepare_identical_tracked_collisions(cwd, branch) {
        Ok(backup) => backup,
        Err(message) => return Ok(MergeOutcome::Error { message }),
    };
    // Squash keeps the page's checkpoints as one project commit. Plain
    // three-way merge, no `-X theirs`: silently preferring one side inside an
    // overlapping hunk is how integrated work got dropped (SmartImage ×3, the
    // v0.9.24 seven-file drop). Only app-owned disposable runtime files are
    // auto-resolved; a real source overlap stops with BOTH sides preserved.
    let (ok, _, err) = git(cwd, &["merge", "--squash", "--no-commit", branch])?;
    if !ok {
        let (_, conflicts, _) = git(cwd, &["diff", "--name-only", "--diff-filter=U"])?;
        if conflicts.trim().is_empty() {
            let _ = git(cwd, &["reset", "--hard", "HEAD"]);
            return Ok(MergeOutcome::Error {
                message: format!("git merge --squash failed: {}", err.trim()),
            });
        }
        if let Err(resolve_err) = resolve_app_scratch_conflicts(cwd, &conflicts) {
            let _ = git(cwd, &["reset", "--hard", "HEAD"]);
            return Ok(MergeOutcome::Error {
                message: resolve_err,
            });
        }
        let (_, remaining, _) = git(cwd, &["diff", "--name-only", "--diff-filter=U"])?;
        let files = user_conflict_files(&remaining);
        if !files.is_empty() {
            // Page branch keeps its commits; project checkout returns to HEAD.
            // The dropped backups restore any preserved files on this return.
            let _ = git(cwd, &["reset", "--hard", "HEAD"]);
            return Ok(MergeOutcome::Conflict { files });
        }
        let (_, unresolved, _) = git(cwd, &["diff", "--name-only", "--diff-filter=U"])?;
        if !unresolved.trim().is_empty() {
            let _ = git(cwd, &["reset", "--hard", "HEAD"]);
            return Ok(MergeOutcome::Error {
                message: format!(
                    "merge conflicts remained unresolved after runtime-file cleanup: {}",
                    unresolved.lines().collect::<Vec<_>>().join(", ")
                ),
            });
        }
    }
    drop_staged_app_scratch(cwd)?;
    if let Some(backup) = untracked_backup.as_mut() {
        backup.restore_preserved()?;
    }
    // If `merge --squash` succeeded but staged nothing, the agent's
    // branch is a fast-forward of HEAD (no new commits to apply).
    let (_, staged, _) = git(cwd, &["diff", "--cached", "--name-only"])?;
    if staged.trim().is_empty() {
        return Ok(MergeOutcome::NoChanges);
    }
    let msg = format!("[merge:{}] integrate parallel dispatch", agent_name);
    let (ok, out, err) = git(cwd, &["commit", "-m", &msg])?;
    if !ok {
        return Ok(MergeOutcome::Error {
            message: git_failure_message("git commit (merge) failed", &out, &err),
        });
    }
    let (_, sha, _) = git(cwd, &["rev-parse", "HEAD"])?;
    let commit_sha = sha.trim().to_string();
    let (_, show, _) = git(cwd, &["show", "--name-only", "--format=", &commit_sha])?;
    let files_changed = show.lines().filter(|l| !l.trim().is_empty()).count() as u32;
    if let Some(backup) = untracked_backup {
        backup.discard();
    }
    if let Some(backup) = tracked_backup {
        backup.discard();
    }
    Ok(MergeOutcome::Merged {
        commit_sha,
        files_changed,
    })
}

// ------------------------------------------------------------------
// 5. ISOLATED SYNC - finalize, integrate, reconcile, and refresh as one unit
// ------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum WorktreeSyncOutcome {
    Synced {
        #[serde(rename = "pageSha")]
        page_sha: String,
        #[serde(rename = "projectSha")]
        project_sha: String,
        remote: bool,
        detail: String,
    },
    NoChanges {
        #[serde(rename = "projectSha")]
        project_sha: String,
        remote: bool,
        detail: String,
    },
    Conflict { files: Vec<String> },
    Error { message: String },
}

#[tauri::command]
pub async fn fleet_worktree_sync(
    worktree_path: String,
    project_cwd: String,
    agent_name: String,
    branch: String,
) -> Result<WorktreeSyncOutcome, String> {
    tokio::task::spawn_blocking(move || {
        fleet_worktree_sync_blocking(worktree_path, project_cwd, agent_name, branch)
    })
    .await
    .map_err(|e| format!("isolated Sync task failed: {e}"))?
}

fn fleet_worktree_sync_blocking(
    worktree_path: String,
    project_cwd: String,
    agent_name: String,
    branch: String,
) -> Result<WorktreeSyncOutcome, String> {
    let project = PathBuf::from(&project_cwd);
    let worktree = PathBuf::from(&worktree_path);
    if !path_is_dir_native(&project)? {
        return Ok(WorktreeSyncOutcome::Error {
            message: format!("project_cwd does not exist: {project_cwd}"),
        });
    }
    if !path_is_dir_native(&worktree)? {
        return Ok(WorktreeSyncOutcome::Error {
            message: format!("worktree does not exist: {worktree_path}"),
        });
    }
    if !is_git_repo(&project)? || !is_git_repo(&worktree)? {
        return Ok(WorktreeSyncOutcome::Error {
            message: "project and page worktree must both be Git repositories".to_string(),
        });
    }

    // The canonical lock spans finalization, local integration, remote
    // reconciliation, page refresh, and final verification.
    let lock = repo_git_lock(&project);
    let _sync_guard = lock.lock().unwrap_or_else(|p| p.into_inner());
    let finalized = fleet_worktree_finalize_blocking(
        worktree_path,
        agent_name,
        "Code page Sync".to_string(),
    )?;
    match finalized {
        FinalizeOutcome::Error { message } => return Ok(WorktreeSyncOutcome::Error { message }),
        FinalizeOutcome::Committed { .. } | FinalizeOutcome::NoChanges => {}
    }

    let merged = fleet_worktree_merge_locked(&project, "code", &branch)?;
    if let MergeOutcome::Conflict { files } = &merged {
        return Ok(WorktreeSyncOutcome::Conflict { files: files.clone() });
    }
    if let MergeOutcome::Error { message } = &merged {
        return Ok(WorktreeSyncOutcome::Error { message: message.clone() });
    }

    let (has_origin, _, _) = git(&project, &["remote", "get-url", "origin"])?;
    let target = git(&project, &["symbolic-ref", "--short", "-q", "HEAD"])
        .ok()
        .and_then(|(_, out, _)| {
            let branch = out.trim().to_string();
            (!branch.is_empty()).then_some(branch)
        })
        .unwrap_or_else(|| "main".to_string());
    let detail = if has_origin {
        crate::sync_core::sync_repo(&project, &target, None)
            .map_err(|e| format!("remote reconciliation failed: {e:?}"))?
            .detail
    } else {
        "No origin configured; synchronized locally.".to_string()
    };

    let (_, project_sha, _) = git(&project, &["rev-parse", "HEAD"])?;
    let project_sha = project_sha.trim().to_string();
    let (reset_ok, _, reset_err) = git(&worktree, &["reset", "--hard", &project_sha])?;
    if !reset_ok {
        return Ok(WorktreeSyncOutcome::Error {
            message: format!("page worktree refresh failed: {}", reset_err.trim()),
        });
    }
    let (_, page_sha, _) = git(&worktree, &["rev-parse", "HEAD"])?;
    let page_sha = page_sha.trim().to_string();
    if page_sha.trim() != project_sha {
        return Ok(WorktreeSyncOutcome::Error {
            message: format!("Sync verification failed: page {page_sha} != project {project_sha}"),
        });
    }

    let no_changes = matches!(merged, MergeOutcome::NoChanges);
    if no_changes {
        Ok(WorktreeSyncOutcome::NoChanges {
            project_sha,
            remote: has_origin,
            detail,
        })
    } else {
        Ok(WorktreeSyncOutcome::Synced {
            page_sha,
            project_sha,
            remote: has_origin,
            detail,
        })
    }
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
        // Keep the worktree (unmerged edits to inspect) but reclaim its
        // regenerable build caches — otherwise every kept worktree hoards an
        // 8-17 GB `target/` forever. Source + git state are left intact.
        reclaim_build_caches(&PathBuf::from(&args.worktree_path));
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
    let _ = remove_dir_all_native(&PathBuf::from(&args.worktree_path));
    // Remove the now-empty parent RUN dir (…/<repo>/<run_id>/) so finished runs
    // don't leave a litter of empty folders (remove_dir only succeeds if empty,
    // so a kept sibling worktree is never clobbered).
    if let Some(run_dir) = PathBuf::from(&args.worktree_path).parent() {
        let _ = remove_empty_dir_native(run_dir);
    }
    Ok(())
}

/// Sweep leftover fleet worktrees for this repo. Per-run cleanup
/// (fleet_worktree_remove) handles the normal path, but a run that CRASHES
/// before its cleanup leaves a full worktree behind forever, and nothing ever
/// reclaimed it — exactly the pile of folders under ~/…/owllm/fleet the user
/// found. Called at run START (before new worktrees are created), so every
/// `owllm-fleet/*` worktree present is from a PAST run and safe to drop. Returns
/// how many were reclaimed. Best-effort; never fails a run.
#[tauri::command]
pub async fn fleet_cleanup_orphans(project_cwd: String) -> Result<u32, String> {
    let cwd = PathBuf::from(&project_cwd);
    if !is_git_repo(&cwd)? {
        return Ok(0);
    }
    let _ = git(&cwd, &["worktree", "prune"]); // drop registry entries for already-deleted dirs
    let mut removed = 0u32;
    // Reclaim TEAM-run worktrees only (owllm-fleet/*). Code-page worktrees
    // (owllm-page/*) hold the user's unmerged edits and are NEVER touched here.
    // And even a team worktree is reclaimed ONLY when there is nothing to lose:
    // CLEAN (no uncommitted changes) AND fully merged (branch tip is an ancestor
    // of HEAD). A crashed run that left real commits, or any dirty tree, is KEPT
    // for the user to inspect — we never force-delete unmerged work.
    if let (true, out, _) = git(&cwd, &["worktree", "list", "--porcelain"])? {
        let mut path: Option<String> = None;
        for line in out.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                path = Some(p.trim().to_string());
            } else if let Some(b) = line.strip_prefix("branch ") {
                let branch = b.trim().trim_start_matches("refs/heads/").to_string();
                let Some(p) = path.take() else { continue };
                if !branch.starts_with("owllm-fleet/") {
                    continue;
                } // team only
                let wt = git_reported_path_for_host(&cwd, &p);
                let dirty = git(&wt, &["status", "--porcelain", "--untracked-files=no"])
                    .map(|(_, o, _)| !o.trim().is_empty())
                    .unwrap_or(true); // can't tell → assume dirty → keep
                let merged = git(&cwd, &["merge-base", "--is-ancestor", &branch, "HEAD"])
                    .map(|(ok, _, _)| ok)
                    .unwrap_or(false); // can't tell → assume unmerged → keep
                if dirty || !merged {
                    continue;
                } // has work → KEEP
                let _ = git(&cwd, &["worktree", "remove", "--force", &p]);
                let _ = git(&cwd, &["branch", "-D", &branch]);
                let _ = remove_dir_all_native(&wt);
                if let Some(parent) = wt.parent() {
                    let _ = remove_empty_dir_native(parent);
                } // empty run dir
                removed += 1;
            }
        }
    }
    let _ = git(&cwd, &["worktree", "prune"]);
    Ok(removed)
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
    if !is_git_repo(&cwd)? {
        return Ok(Vec::new());
    }
    let (_, out, _) = git(&cwd, &["show", "--name-only", "--format=", "HEAD"])?;
    Ok(out
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::{
        fleet_worktree_create, fleet_worktree_finalize, fleet_worktree_merge_blocking,
        git_failure_message, git_reported_path_for_host, is_app_scratch, linux_path_to_wsl_unc,
        path_is_dir_native, porcelain_path, unstage_app_scratch, user_conflict_files, CreateOutcome,
        FinalizeOutcome, MergeOutcome,
    };
    use std::{fs, path::Path, process::Command};

    fn git_ok(cwd: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git should start");
        assert!(
            out.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn init_merge_repo() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        git_ok(tmp.path(), &["init", "-b", "main"]);
        git_ok(tmp.path(), &["config", "core.autocrlf", "false"]);
        git_ok(
            tmp.path(),
            &["config", "user.email", "fleet-test@owllm.local"],
        );
        git_ok(tmp.path(), &["config", "user.name", "OwLLM Fleet Test"]);
        fs::create_dir_all(tmp.path().join(".owllm-inbox")).unwrap();
        fs::create_dir_all(tmp.path().join("owllm-desktop/src-tauri/src")).unwrap();
        fs::write(tmp.path().join(".owllm-inbox/image_1.png"), b"base").unwrap();
        fs::write(
            tmp.path().join("owllm-desktop/src-tauri/src/release.rs"),
            "base\n",
        )
        .unwrap();
        git_ok(tmp.path(), &["add", "-A"]);
        git_ok(tmp.path(), &["commit", "-m", "base"]);
        tmp
    }

    #[test]
    fn app_scratch_is_ignored_but_source_is_not() {
        // The perpetually-"dirty" app-managed paths that used to wedge creates.
        assert!(is_app_scratch(".owllm-inbox/image_1.png"));
        assert!(is_app_scratch(".owllm-inbox"));
        assert!(is_app_scratch(".owllm/brainstorm.json"));
        assert!(is_app_scratch(".owllm/eval-traces.jsonl"));
        assert!(is_app_scratch("./.owllm-inbox/x.png"));
        assert!(is_app_scratch(".owllm-inbox\\image_1.png")); // porcelain can emit backslashes
                                                              // Real source changes must STILL block (branch cuts from HEAD).
        assert!(!is_app_scratch("src/main.rs"));
        assert!(!is_app_scratch("owllm-desktop/ui/src/App.tsx"));
        assert!(!is_app_scratch(".owllm/project.json"));
        assert!(!is_app_scratch(".owllm/verify.json"));
        assert!(!is_app_scratch(".owllm/skills/example/SKILL.md"));
        assert!(!is_app_scratch(".owllm/assets/mockup.png"));
        assert!(!is_app_scratch(".owllm-inbox-notes.md")); // sibling file, not the dir
        assert!(!is_app_scratch(".github/workflows/ci.yml"));
    }

    #[test]
    fn porcelain_path_parsing() {
        assert_eq!(
            porcelain_path(" M .owllm-inbox/image_1.png"),
            ".owllm-inbox/image_1.png"
        );
        assert_eq!(porcelain_path("A  src/new.rs"), "src/new.rs");
        assert_eq!(
            porcelain_path("R  old/path.rs -> new/path.rs"),
            "new/path.rs"
        );
        assert_eq!(porcelain_path("?? untracked.txt"), "untracked.txt");
        // A source file next to a scratch change is still seen as source.
        assert!(!is_app_scratch(porcelain_path("M  Cargo.toml")));
    }

    #[test]
    fn staged_app_scratch_is_removed_before_commit() {
        let tmp = init_merge_repo();
        let root = tmp.path();
        fs::write(root.join(".owllm-inbox/image_1.png"), b"runtime refresh").unwrap();
        fs::write(root.join("feature.txt"), b"user change").unwrap();
        git_ok(root, &["add", "-A"]);

        unstage_app_scratch(root).unwrap();

        let out = Command::new("git")
            .args(["diff", "--cached", "--name-only"])
            .current_dir(root)
            .output()
            .unwrap();
        let staged = String::from_utf8_lossy(&out.stdout);
        assert_eq!(staged.trim(), "feature.txt");
        assert_eq!(
            fs::read(root.join(".owllm-inbox/image_1.png")).unwrap(),
            b"runtime refresh"
        );
    }

    #[tokio::test]
    async fn scratch_only_finalize_returns_no_changes() {
        let tmp = init_merge_repo();
        let root = tmp.path();
        fs::write(root.join(".owllm-inbox/image_1.png"), b"runtime refresh").unwrap();

        let outcome = fleet_worktree_finalize(
            root.to_string_lossy().to_string(),
            "code".to_string(),
            "Code page session".to_string(),
        )
        .await
        .unwrap();

        assert!(matches!(outcome, FinalizeOutcome::NoChanges));
        let status = Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(root)
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&status.stdout).trim(),
            "M .owllm-inbox/image_1.png"
        );
    }

    /// The deadlock this fixes: an agent RUN met a dirty checkout, every
    /// worktree refused to cut, the dispatch aborted, and the Notebook queue
    /// idled with no way to recover. A run now checkpoints the open work and
    /// proceeds; nothing is lost and the checkout is clean for merge-back.
    #[tokio::test]
    async fn agent_run_checkpoints_uncommitted_work_instead_of_deadlocking() {
        let tmp = init_merge_repo();
        let root = tmp.path();
        let before = head_sha(root);
        fs::write(
            root.join("owllm-desktop/src-tauri/src/release.rs"),
            "user work in progress\n",
        )
        .unwrap();
        // App-managed scratch must stay OUT of the user's checkpoint commit.
        fs::write(root.join(".owllm-inbox/image_1.png"), b"runtime refresh").unwrap();

        let outcome = fleet_worktree_create(
            root.to_string_lossy().to_string(),
            "coder".to_string(),
            "checkpoint-run".to_string(),
            None,
            Some(true),
        )
        .await
        .unwrap();

        let (path, branch, checkpoint_sha, checkpoint_files) = match outcome {
            CreateOutcome::Ready {
                path,
                branch,
                checkpoint_sha,
                checkpoint_files,
                ..
            } => (path, branch, checkpoint_sha, checkpoint_files),
            other => panic!("a dirty checkout must not block an agent run: {other:?}"),
        };
        assert!(
            checkpoint_sha.is_some(),
            "the open work should have been checkpointed"
        );
        assert_eq!(
            checkpoint_files,
            vec!["owllm-desktop/src-tauri/src/release.rs".to_string()],
            "only the user's tracked work belongs in the checkpoint"
        );
        assert_ne!(before, head_sha(root), "the checkpoint should advance HEAD");
        // The work is preserved in history, not discarded.
        let show = Command::new("git")
            .args(["show", "HEAD:owllm-desktop/src-tauri/src/release.rs"])
            .current_dir(root)
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&show.stdout),
            "user work in progress\n"
        );
        // Tracked files are clean now, so merge-back cannot be blocked either.
        let status = Command::new("git")
            .args(["status", "--porcelain", "--untracked-files=no"])
            .current_dir(root)
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&status.stdout).trim(),
            "M .owllm-inbox/image_1.png",
            "only app scratch may remain dirty"
        );
        git_ok(root, &["worktree", "remove", "--force", &path]);
        git_ok(root, &["branch", "-D", &branch]);
    }

    /// Opening a Code page also cuts a worktree. That is not a user-started run,
    /// so it must keep the dirty-tree stop rather than commit on their behalf.
    #[tokio::test]
    async fn opening_a_page_never_commits_on_the_users_behalf() {
        let tmp = init_merge_repo();
        let root = tmp.path();
        let before = head_sha(root);
        fs::write(
            root.join("owllm-desktop/src-tauri/src/release.rs"),
            "user work in progress\n",
        )
        .unwrap();

        let outcome = fleet_worktree_create(
            root.to_string_lossy().to_string(),
            "code".to_string(),
            "page-open".to_string(),
            Some("owllm-page".to_string()),
            None,
        )
        .await
        .unwrap();

        match outcome {
            CreateOutcome::DirtyWorkingTree { details } => {
                assert!(details.contains("release.rs"), "details name the file");
            }
            other => panic!("page open must not auto-commit: {other:?}"),
        }
        assert_eq!(before, head_sha(root), "HEAD must not move");
    }

    fn head_sha(root: &Path) -> String {
        let out = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(root)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn git_failure_message_uses_stdout_when_stderr_is_empty() {
        let message = git_failure_message(
            "git commit failed",
            "On branch main\nnothing to commit, working tree clean\n",
            "",
        );
        assert!(message.contains("git commit failed: On branch main"));
        assert!(message.contains("nothing to commit"));
    }

    #[test]
    fn wsl_fleet_paths_round_trip_to_the_same_distro() {
        let unc = linux_path_to_wsl_unc("Ubuntu", "/home/owllm/.owllm/fleet/repo/run/coder");
        assert_eq!(
            unc.to_string_lossy().replace('/', "\\"),
            r"\\wsl.localhost\Ubuntu\home\owllm\.owllm\fleet\repo\run\coder"
        );
        let repo = Path::new(r"\\wsl.localhost\Ubuntu\home\owllm\repo");
        let reported = git_reported_path_for_host(repo, "/home/owllm/.owllm/fleet/repo/run/coder");
        assert_eq!(reported, unc);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn wsl_unc_worktree_lifecycle_uses_the_distro_boundary() {
        use super::{fleet_worktree_create, fleet_worktree_remove, CreateOutcome, RemoveArgs};

        let distros = Command::new("wsl.exe")
            .args(["-l", "-q"])
            .output()
            .ok()
            .map(|out| crate::wsl::decode_wsl(&out.stdout))
            .unwrap_or_default();
        let Some(distro) = distros.lines().map(str::trim).find(|line| !line.is_empty()) else {
            eprintln!("WSL is unavailable; skipping the Windows-to-WSL lifecycle assertion");
            return;
        };

        let tmp = init_merge_repo();
        let root = tmp.path();
        let windows = root.to_string_lossy().replace('\\', "/");
        let bytes = windows.as_bytes();
        if bytes.len() < 3 || bytes[1] != b':' {
            eprintln!("temporary repository is not on a drive mounted by WSL");
            return;
        }
        let drive = (bytes[0] as char).to_ascii_lowercase();
        let tail = windows[3..].replace('/', "\\");
        let project_unc = format!(r"\\wsl.localhost\{distro}\mnt\{drive}\{tail}");

        let created = fleet_worktree_create(
            project_unc.clone(),
            "coder".into(),
            "wsl-lifecycle-test".into(),
            None,
            None,
        )
        .await
        .unwrap();
        let (worktree_path, branch) = match created {
            CreateOutcome::Ready { path, branch, .. } => (path, branch),
            CreateOutcome::NotAGitRepo => panic!("WSL saw the initialized repository as non-Git"),
            CreateOutcome::DirtyWorkingTree { details } => {
                panic!("new test repository was unexpectedly dirty: {details}")
            }
            CreateOutcome::Error { message } => {
                panic!("WSL worktree creation failed: {message}")
            }
        };

        assert!(path_is_dir_native(Path::new(&worktree_path)).unwrap());
        let (worktree_distro, linux_worktree) =
            crate::wsl::parse_wsl_unc(&worktree_path).expect("worktree must stay in WSL");
        assert_eq!(worktree_distro, distro);
        crate::wsl::run_in_distro(
            &distro,
            &format!(
                "printf 'isolated WSL edit\\n' > {}",
                crate::wsl::sh_quote(&format!("{linux_worktree}/feature.txt"))
            ),
        )
        .unwrap();

        let finalized = fleet_worktree_finalize(
            worktree_path.clone(),
            "coder".into(),
            "WSL lifecycle".into(),
        )
        .await
        .unwrap();
        assert!(matches!(finalized, FinalizeOutcome::Committed { .. }));

        let merged =
            fleet_worktree_merge_blocking(project_unc.clone(), "coder".into(), branch.clone())
                .unwrap();
        assert!(matches!(merged, MergeOutcome::Merged { .. }));
        assert_eq!(
            fs::read_to_string(root.join("feature.txt")).unwrap(),
            "isolated WSL edit\n"
        );

        fleet_worktree_remove(RemoveArgs {
            project_cwd: project_unc,
            worktree_path: worktree_path.clone(),
            branch,
            keep: false,
        })
        .await
        .unwrap();
        assert!(!path_is_dir_native(Path::new(&worktree_path)).unwrap());
    }

    #[test]
    fn scratch_conflicts_are_hidden_from_user_conflicts() {
        assert_eq!(
            user_conflict_files(
                ".owllm-inbox/image_1.png\nowllm-desktop/src-tauri/src/release.rs\n"
            ),
            vec!["owllm-desktop/src-tauri/src/release.rs".to_string()]
        );
        assert_eq!(
            user_conflict_files(".owllm-inbox/image_1.png\n.owllm/project.json\n"),
            vec![".owllm/project.json".to_string()]
        );
    }

    #[test]
    fn identical_untracked_branch_addition_is_adopted_by_merge() {
        let tmp = init_merge_repo();
        let root = tmp.path();
        git_ok(root, &["checkout", "-b", "agent-icons"]);
        fs::create_dir_all(root.join("icons/App_icons")).unwrap();
        fs::write(root.join("icons/App_icons/india_flag.webp"), b"same flag").unwrap();
        git_ok(root, &["add", "icons/App_icons/india_flag.webp"]);
        git_ok(root, &["commit", "-m", "add flag"]);

        git_ok(root, &["checkout", "main"]);
        fs::create_dir_all(root.join("icons/App_icons")).unwrap();
        fs::write(root.join("icons/App_icons/india_flag.webp"), b"same flag").unwrap();

        let outcome = fleet_worktree_merge_blocking(
            root.to_string_lossy().to_string(),
            "code".into(),
            "agent-icons".into(),
        )
        .unwrap();
        assert!(matches!(outcome, MergeOutcome::Merged { .. }));
        assert_eq!(
            fs::read(root.join("icons/App_icons/india_flag.webp")).unwrap(),
            b"same flag"
        );
        let tracked = Command::new("git")
            .args([
                "ls-files",
                "--error-unmatch",
                "icons/App_icons/india_flag.webp",
            ])
            .current_dir(root)
            .status()
            .unwrap();
        assert!(tracked.success());
    }

    #[test]
    fn differing_untracked_branch_addition_is_preserved_and_blocks_merge() {
        let tmp = init_merge_repo();
        let root = tmp.path();
        git_ok(root, &["checkout", "-b", "agent-icons"]);
        fs::create_dir_all(root.join("icons/App_icons")).unwrap();
        fs::write(root.join("icons/App_icons/india_flag.webp"), b"branch flag").unwrap();
        git_ok(root, &["add", "icons/App_icons/india_flag.webp"]);
        git_ok(root, &["commit", "-m", "add flag"]);

        git_ok(root, &["checkout", "main"]);
        fs::create_dir_all(root.join("icons/App_icons")).unwrap();
        fs::write(root.join("icons/App_icons/india_flag.webp"), b"user flag").unwrap();

        let outcome = fleet_worktree_merge_blocking(
            root.to_string_lossy().to_string(),
            "code".into(),
            "agent-icons".into(),
        )
        .unwrap();
        match outcome {
            MergeOutcome::Error { message } => {
                assert!(message.contains("contents differ"));
                assert!(message.contains("icons/App_icons/india_flag.webp"));
            }
            _ => panic!("differing untracked content must block the merge"),
        }
        assert_eq!(
            fs::read(root.join("icons/App_icons/india_flag.webp")).unwrap(),
            b"user flag"
        );
    }

    #[test]
    fn differing_untracked_app_state_is_preserved_and_does_not_block_merge() {
        let tmp = init_merge_repo();
        let root = tmp.path();
        git_ok(root, &["checkout", "-b", "agent-state"]);
        fs::create_dir_all(root.join(".owllm")).unwrap();
        fs::write(
            root.join(".owllm/brainstorm.json"),
            b"older page transcript",
        )
        .unwrap();
        fs::write(root.join("feature.txt"), b"real source change").unwrap();
        git_ok(
            root,
            &["add", "-f", ".owllm/brainstorm.json", "feature.txt"],
        );
        git_ok(root, &["commit", "-m", "page source and runtime state"]);

        git_ok(root, &["checkout", "main"]);
        fs::create_dir_all(root.join(".owllm")).unwrap();
        fs::write(
            root.join(".owllm/brainstorm.json"),
            b"newer local transcript",
        )
        .unwrap();

        let outcome = fleet_worktree_merge_blocking(
            root.to_string_lossy().to_string(),
            "code".into(),
            "agent-state".into(),
        )
        .unwrap();
        assert!(matches!(outcome, MergeOutcome::Merged { .. }));
        assert_eq!(
            fs::read(root.join(".owllm/brainstorm.json")).unwrap(),
            b"newer local transcript"
        );
        assert_eq!(
            fs::read(root.join("feature.txt")).unwrap(),
            b"real source change"
        );
        let tracked = Command::new("git")
            .args(["ls-files", "--error-unmatch", ".owllm/brainstorm.json"])
            .current_dir(root)
            .status()
            .unwrap();
        assert!(
            !tracked.success(),
            "runtime transcript must remain untracked"
        );
    }

    #[test]
    fn identical_tracked_local_edits_are_adopted_by_merge() {
        let tmp = init_merge_repo();
        let root = tmp.path();
        fs::create_dir_all(root.join("owllm-desktop/ui/src/pages/agentic")).unwrap();
        fs::write(
            root.join("owllm-desktop/ui/src/pages/agentic/publishResponsiveness.verify.run.mjs"),
            "base\n",
        )
        .unwrap();
        git_ok(root, &["add", "-A"]);
        git_ok(root, &["commit", "-m", "add verifier"]);

        git_ok(root, &["checkout", "-b", "agent-release-fix"]);
        fs::write(
            root.join("owllm-desktop/src-tauri/src/release.rs"),
            "fixed release diagnostics\n",
        )
        .unwrap();
        fs::write(
            root.join("owllm-desktop/ui/src/pages/agentic/publishResponsiveness.verify.run.mjs"),
            "fixed verifier anchor\n",
        )
        .unwrap();
        git_ok(root, &["commit", "-am", "agent release fix"]);

        git_ok(root, &["checkout", "main"]);
        fs::write(
            root.join("owllm-desktop/src-tauri/src/release.rs"),
            "fixed release diagnostics\n",
        )
        .unwrap();
        fs::write(
            root.join("owllm-desktop/ui/src/pages/agentic/publishResponsiveness.verify.run.mjs"),
            "fixed verifier anchor\n",
        )
        .unwrap();

        let outcome = fleet_worktree_merge_blocking(
            root.to_string_lossy().to_string(),
            "code".into(),
            "agent-release-fix".into(),
        )
        .unwrap();
        assert!(matches!(outcome, MergeOutcome::Merged { .. }));
        assert_eq!(
            fs::read_to_string(root.join("owllm-desktop/src-tauri/src/release.rs")).unwrap(),
            "fixed release diagnostics\n"
        );
        assert_eq!(
            fs::read_to_string(
                root.join(
                    "owllm-desktop/ui/src/pages/agentic/publishResponsiveness.verify.run.mjs"
                )
            )
            .unwrap(),
            "fixed verifier anchor\n"
        );
        let status = Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(root)
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&status.stdout).trim(), "");
    }

    #[test]
    fn differing_tracked_local_edits_are_preserved_and_block_merge() {
        let tmp = init_merge_repo();
        let root = tmp.path();
        git_ok(root, &["checkout", "-b", "agent-release-fix"]);
        fs::write(
            root.join("owllm-desktop/src-tauri/src/release.rs"),
            "agent release diagnostics\n",
        )
        .unwrap();
        git_ok(root, &["commit", "-am", "agent release fix"]);

        git_ok(root, &["checkout", "main"]);
        fs::write(
            root.join("owllm-desktop/src-tauri/src/release.rs"),
            "local release diagnostics\n",
        )
        .unwrap();

        let outcome = fleet_worktree_merge_blocking(
            root.to_string_lossy().to_string(),
            "code".into(),
            "agent-release-fix".into(),
        )
        .unwrap();
        match outcome {
            MergeOutcome::Error { message } => {
                assert!(message.contains("tracked local changes"));
                assert!(message.contains("owllm-desktop/src-tauri/src/release.rs"));
            }
            _ => panic!("differing tracked local edit must block the merge"),
        }
        assert_eq!(
            fs::read_to_string(root.join("owllm-desktop/src-tauri/src/release.rs")).unwrap(),
            "local release diagnostics\n"
        );
    }

    #[test]
    fn mixed_merge_conflict_resolves_scratch_but_stops_on_source_overlap() {
        let tmp = init_merge_repo();
        let root = tmp.path();
        git_ok(root, &["checkout", "-b", "agent"]);
        fs::write(root.join(".owllm-inbox/image_1.png"), b"agent").unwrap();
        fs::write(
            root.join("owllm-desktop/src-tauri/src/release.rs"),
            "agent\n",
        )
        .unwrap();
        git_ok(root, &["commit", "-am", "agent changes"]);

        git_ok(root, &["checkout", "main"]);
        fs::write(root.join(".owllm-inbox/image_1.png"), b"main").unwrap();
        fs::write(
            root.join("owllm-desktop/src-tauri/src/release.rs"),
            "main\n",
        )
        .unwrap();
        git_ok(root, &["commit", "-am", "main changes"]);

        let outcome = fleet_worktree_merge_blocking(
            root.to_string_lossy().to_string(),
            "code".into(),
            "agent".into(),
        )
        .unwrap();
        // The scratch overlap must NOT surface as a user conflict, but the real
        // source overlap must stop the merge with main's copy untouched.
        match outcome {
            MergeOutcome::Conflict { files } => {
                assert_eq!(files, vec!["owllm-desktop/src-tauri/src/release.rs"]);
            }
            other => panic!("expected Conflict, got {other:?}"),
        }
        assert_eq!(
            fs::read_to_string(root.join("owllm-desktop/src-tauri/src/release.rs")).unwrap(),
            "main\n"
        );
        assert_eq!(
            fs::read(root.join(".owllm-inbox/image_1.png")).unwrap(),
            b"main"
        );
    }

    #[test]
    fn overlapping_text_edits_stop_with_both_sides_preserved() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        git_ok(root, &["init", "-b", "main"]);
        git_ok(root, &["config", "core.autocrlf", "false"]);
        git_ok(root, &["config", "user.email", "fleet-test@owllm.local"]);
        git_ok(root, &["config", "user.name", "OwLLM Fleet Test"]);
        fs::write(
            root.join("feature.txt"),
            "header base\nkeep one\nkeep two\nkeep three\nshared base\nfooter\n",
        )
        .unwrap();
        git_ok(root, &["add", "feature.txt"]);
        git_ok(root, &["commit", "-m", "base"]);

        git_ok(root, &["checkout", "-b", "page"]);
        fs::write(
            root.join("feature.txt"),
            "header base\nkeep one\nkeep two\nkeep three\nshared page\nfooter\n",
        )
        .unwrap();
        git_ok(root, &["commit", "-am", "page edit"]);

        git_ok(root, &["checkout", "main"]);
        fs::write(
            root.join("feature.txt"),
            "header main\nkeep one\nkeep two\nkeep three\nshared main\nfooter\n",
        )
        .unwrap();
        git_ok(root, &["commit", "-am", "main edits"]);

        let outcome = fleet_worktree_merge_blocking(
            root.to_string_lossy().to_string(),
            "code".into(),
            "page".into(),
        )
        .unwrap();
        // Same-hunk edits on both sides: NEVER silently prefer one. Main's file
        // must be exactly what main committed, and the page branch keeps its
        // commit so nothing is lost.
        match outcome {
            MergeOutcome::Conflict { files } => assert_eq!(files, vec!["feature.txt"]),
            other => panic!("expected Conflict, got {other:?}"),
        }
        assert_eq!(
            fs::read_to_string(root.join("feature.txt")).unwrap(),
            "header main\nkeep one\nkeep two\nkeep three\nshared main\nfooter\n"
        );
        let (ok, page_file, _) = super::git(root, &["show", "page:feature.txt"]).unwrap();
        assert!(ok);
        assert!(page_file.contains("shared page"));
    }

    #[test]
    fn modify_delete_overlap_stops_with_both_sides_preserved() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        git_ok(root, &["init", "-b", "main"]);
        git_ok(root, &["config", "core.autocrlf", "false"]);
        git_ok(root, &["config", "user.email", "fleet-test@owllm.local"]);
        git_ok(root, &["config", "user.name", "OwLLM Fleet Test"]);
        fs::write(root.join("obsolete.txt"), "base\n").unwrap();
        git_ok(root, &["add", "obsolete.txt"]);
        git_ok(root, &["commit", "-m", "base"]);

        git_ok(root, &["checkout", "-b", "page"]);
        git_ok(root, &["rm", "obsolete.txt"]);
        git_ok(root, &["commit", "-m", "page removes obsolete file"]);

        git_ok(root, &["checkout", "main"]);
        fs::write(root.join("obsolete.txt"), "main changed\n").unwrap();
        git_ok(root, &["commit", "-am", "main modifies obsolete file"]);

        let outcome = fleet_worktree_merge_blocking(
            root.to_string_lossy().to_string(),
            "code".into(),
            "page".into(),
        )
        .unwrap();
        // Modify/delete is a REAL disagreement — stop, keep main's file on disk
        // and the page's deletion on its branch.
        match outcome {
            MergeOutcome::Conflict { files } => assert_eq!(files, vec!["obsolete.txt"]),
            other => panic!("expected Conflict, got {other:?}"),
        }
        assert_eq!(
            fs::read_to_string(root.join("obsolete.txt")).unwrap(),
            "main changed\n"
        );
    }

    #[test]
    fn scratch_only_conflict_does_not_block_real_nonconflicting_changes() {
        let tmp = init_merge_repo();
        let root = tmp.path();
        git_ok(root, &["checkout", "-b", "agent"]);
        fs::write(root.join(".owllm-inbox/image_1.png"), b"agent").unwrap();
        fs::write(root.join("feature.txt"), "agent feature\n").unwrap();
        git_ok(root, &["add", "-A"]);
        git_ok(root, &["commit", "-m", "agent feature"]);

        git_ok(root, &["checkout", "main"]);
        fs::write(root.join(".owllm-inbox/image_1.png"), b"main").unwrap();
        git_ok(root, &["commit", "-am", "refresh app inbox"]);

        let outcome = fleet_worktree_merge_blocking(
            root.to_string_lossy().to_string(),
            "code".into(),
            "agent".into(),
        )
        .unwrap();
        assert!(matches!(outcome, MergeOutcome::Merged { .. }));
        assert_eq!(
            fs::read_to_string(root.join("feature.txt")).unwrap(),
            "agent feature\n"
        );
        assert_eq!(
            fs::read(root.join(".owllm-inbox/image_1.png")).unwrap(),
            b"main"
        );
    }
}
