// Per-user GitHub "vault" — the private repo that backs cross-device sync.
//
// Identity + storage = the user's OWN GitHub (see github.rs / accounts.rs):
// we never host their data. This module ensures a PRIVATE `owllm-vault` repo
// exists for the connected account and keeps a local clone that the sync
// engine reads/writes. We talk to the GitHub REST API via host `curl` (same
// pattern as github.rs — no Rust HTTP client) and use `git` for clone/push.
//
// The clone uses the host git credential helper that github_connect already
// configured (~/.git-credentials), so the token never has to live in this
// repo's .git/config. If that helper isn't present we fall back to a
// one-time token-embedded clone URL.

use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const VAULT_REPO: &str = "owllm-vault";

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    /// GitHub is connected (token + login stored).
    pub connected: bool,
    pub login: Option<String>,
    /// The owllm-vault repo exists on GitHub.
    pub repo_exists: bool,
    /// A local clone is present on this device.
    pub cloned: bool,
    /// Local clone path (when cloned).
    pub path: Option<String>,
    /// https URL of the repo (for "view on GitHub").
    pub repo_url: Option<String>,
}

/// Local clone location: `%USERPROFILE%\.owllm\vault` (matches the `.owllm`
/// convention used elsewhere — wsl.rs, wsl_setup.rs).
fn vault_dir() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(home).join(".owllm").join("vault"))
}

fn token_and_login() -> Option<(String, String)> {
    let token = crate::accounts::accounts_get_secret("GITHUB_TOKEN".to_string())?;
    let login = crate::accounts::accounts_get_secret("GITHUB_LOGIN".to_string())?;
    Some((token, login))
}

/// Remote vault operations must be authorized by OWLLM's CURRENT GitHub
/// session, not merely by whatever Git Credential Manager/gh credentials happen
/// to exist on the machine. The local clone remains after logout for offline
/// access, but no fetch/push command may use it until the app reconnects.
fn connected_vault_dir() -> Result<PathBuf, String> {
    token_and_login().ok_or_else(|| "GitHub is disconnected — vault sync is disabled.".to_string())?;
    let dir = vault_dir().ok_or_else(|| "no vault dir".to_string())?;
    // Every remote vault operation funnels through here, so this is the one place
    // that has to hold the line: refuse to run while the breaker is open, and make
    // sure the clone is hardened (durable ref writes, no auto-gc thrash) exactly
    // once per process before anything touches it.
    if let Some(secs) = sync_cooldown_remaining() {
        return Err(format!(
            "vault sync paused for {secs}s after repeated failures — the local clone needs attention"
        ));
    }
    ensure_hardened(&dir);
    Ok(dir)
}

/// Apply the durability policy to an existing clone, once per run.
/// Cheap no-op when there is no clone yet (`clone_vault` hardens the fresh one).
///
/// Config writes only. Consolidation used to run from here too, but this is
/// reached from `connected_vault_dir` on the ASYNC runtime, at the top of every
/// vault command — a repack there blocks an executor thread for minutes. It now
/// runs as `maintain_repo_if_due` on the gated blocking thread instead.
fn ensure_hardened(dir: &std::path::Path) {
    use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
    static DONE: AtomicBool = AtomicBool::new(false);
    if !dir.join(".git").exists() || DONE.swap(true, Relaxed) {
        return;
    }
    harden_repo(dir);
}

/// GET an authenticated GitHub API URL; return the parsed JSON body.
fn curl_get(token: &str, url: &str) -> Result<serde_json::Value, String> {
    let mut cmd = std::process::Command::new("curl");
    cmd.args([
        "-s",
        "-H",
        &format!("Authorization: Bearer {token}"),
        "-H",
        "User-Agent: owllm-desktop",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
        url,
    ]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|e| format!("curl GitHub: {e}"))?;
    let body = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(body.trim()).map_err(|_| {
        format!(
            "GitHub returned non-JSON (offline?): {}",
            body.chars().take(160).collect::<String>()
        )
    })
}

/// POST a JSON body to a GitHub API URL; return the parsed JSON response.
fn curl_post(token: &str, url: &str, json_body: &str) -> Result<serde_json::Value, String> {
    let mut cmd = std::process::Command::new("curl");
    cmd.args([
        "-s",
        "-X",
        "POST",
        "-H",
        &format!("Authorization: Bearer {token}"),
        "-H",
        "User-Agent: owllm-desktop",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
        "-H",
        "Content-Type: application/json",
        "-d",
        json_body,
        url,
    ]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|e| format!("curl GitHub: {e}"))?;
    let body = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(body.trim()).map_err(|_| {
        format!(
            "GitHub returned non-JSON (offline?): {}",
            body.chars().take(160).collect::<String>()
        )
    })
}

fn repo_exists(token: &str, login: &str) -> bool {
    let url = format!("https://api.github.com/repos/{login}/{VAULT_REPO}");
    match curl_get(token, &url) {
        Ok(v) => v.get("full_name").is_some(),
        Err(_) => false,
    }
}

/// Create the private vault repo. auto_init gives it a first commit so it can
/// be cloned immediately. Tolerates "already exists".
fn create_repo(token: &str) -> Result<(), String> {
    let body = serde_json::json!({
        "name": VAULT_REPO,
        "private": true,
        "auto_init": true,
        "description": "OWLLM sync vault — chats, settings & agent teams. Managed by OwLLM Desktop."
    })
    .to_string();
    let v = curl_post(token, "https://api.github.com/user/repos", &body)?;
    if v.get("full_name").is_some() {
        return Ok(());
    }
    // "name already exists on this account" is success for our purposes.
    let msg = v.get("message").and_then(|m| m.as_str()).unwrap_or("");
    let already = v
        .get("errors")
        .and_then(|e| e.as_array())
        .map(|arr| {
            arr.iter().any(|e| {
                e.get("message")
                    .and_then(|m| m.as_str())
                    .map(|s| s.contains("already exists"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);
    if already || msg.contains("already exists") {
        Ok(())
    } else {
        Err(format!(
            "GitHub couldn't create the vault repo: {}",
            if msg.is_empty() { "unknown error" } else { msg }
        ))
    }
}

fn is_cloned(dir: &std::path::Path) -> bool {
    dir.join(".git").is_dir()
}

static VAULT_WRITE_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Replace a vault file without truncating the inode Git may already have
/// mmap'd. `git add`/`commit` hashes regular files through mmap on Linux;
/// truncating one in place while that read is active faults past the new end of
/// file, which the kernel reports as SIGBUS — Ubuntu then shows its "internal
/// error" dialog and the sync dies. Writing a complete temp file and replacing
/// the name atomically leaves an in-flight reader on the old inode and points
/// new readers at the new one. The temp lives under `.git`, when we can find
/// it, so a concurrent `git add -A` can never stage it.
fn atomic_write(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::sync::atomic::Ordering;

    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "vault path has no parent")
    })?;
    let temp_dir = path
        .ancestors()
        .find(|ancestor| ancestor.join(".git").is_dir())
        .map(|root| root.join(".git").join("owllm-write-tmp"))
        .unwrap_or_else(|| parent.to_path_buf());
    std::fs::create_dir_all(&temp_dir)?;
    let sequence = VAULT_WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("vault-state");
    let temp = temp_dir.join(format!(".{name}.{}.{sequence}.tmp", std::process::id()));

    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        replace_file(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(not(windows))]
fn replace_file(temp: &std::path::Path, path: &std::path::Path) -> std::io::Result<()> {
    std::fs::rename(temp, path)
}

/// Windows has no atomic `rename` over an existing file; `MoveFileExW` with
/// MOVEFILE_REPLACE_EXISTING is the equivalent primitive.
#[cfg(windows)]
fn replace_file(temp: &std::path::Path, path: &std::path::Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let from: Vec<u16> = temp
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let to: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let ok = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

// Serialize ALL app git operations on the vault clone. The sync engine fires on
// a 5s poll, on tab-hide, on close, and across every window, and three channels
// (projects/teams/devices) can run at once — concurrent git on one repo races on
// `.git/index` (and its `.lock`), which is a corruption + contention vector.
// One process-wide lock means our git never runs two-at-once on the vault.
static VAULT_GIT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

// …but one lock per git INVOCATION is not enough. Every vault channel is a
// read-modify-write TRANSACTION: `reset --hard origin/<branch>`, rewrite files
// under state/, then add+commit+push. With only the per-command lock, a second
// channel's `reset --hard` lands between another channel's file write and its
// commit and silently discards it — `commit_push` then finds "nothing to
// commit" and returns Ok, so the loss is invisible. The launch path fires
// teams/devices/signing/projects concurrently, and signing (the last one wired
// in, and the smallest write) is the one that kept losing: its meta.json never
// reached the vault while the other channels synced fine.
//
// Held for the whole transaction. ALWAYS acquired before VAULT_GIT_LOCK and
// never the reverse, so the two cannot deadlock.
static VAULT_TXN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Guard one whole vault transaction. A poisoned lock (a prior panic mid-sync)
/// must not wedge sync forever — recover the guard, same as run_git does.
fn vault_txn() -> std::sync::MutexGuard<'static, ()> {
    VAULT_TXN_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

// ADMISSION GATE — the async half of VAULT_TXN_LOCK.
//
// Both locks above are BLOCKING mutexes, and every vault command runs its
// transaction inside `spawn_blocking`. A transaction holds the lock across
// `fetch` + `merge` + `push`, which is seconds against a large vault. So a tick
// that arrives mid-transaction does not just wait — it occupies a whole tokio
// blocking thread doing nothing but waiting.
//
// The UI drives four periodic channels PER WINDOW (5s state push, 10s notebook
// pull, 60s projects, 150s devices) and none of them coalesce at the Rust
// boundary. Once pushes take longer than the poll interval the queue grows
// faster than it drains and pins tokio's blocking pool at its default 512-thread
// ceiling. Past that point every `spawn_blocking` in the WHOLE APP — chat
// persistence, model listing, engine start — queues behind vault sync forever:
// the app renders fine and does absolutely nothing, for any model.
//
// Observed 2026-08-12: 552 threads (512 blocking pool + ~40), all in Wait, ~2%
// CPU, against an 83,095-commit / 7.2 GB vault committing 660 times an hour.
//
// The fix is to wait HERE instead — on the async runtime, where a waiter is a
// task and not a thread — and only enter `spawn_blocking` once the gate is ours.
// A blocking thread is then held only while git actually runs.
//
// Lock ordering is gate → VAULT_TXN_LOCK → VAULT_GIT_LOCK, never the reverse.
// The inner locks are kept: they still serialize the non-async callers (the
// concurrency tests below drive `vault_txn` directly from plain threads), and
// with the gate in front they are uncontended for command traffic.
fn vault_gate() -> &'static tokio::sync::Semaphore {
    static GATE: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    GATE.get_or_init(|| tokio::sync::Semaphore::new(1))
}

/// Wait for exclusive vault access WITHOUT occupying a blocking thread. For the
/// channels whose write must land: user actions and launch-time publishes.
async fn vault_admit() -> tokio::sync::SemaphorePermit<'static> {
    // The semaphore is never closed, so acquire() cannot fail.
    vault_gate()
        .acquire()
        .await
        .expect("vault gate is never closed")
}

/// Take the gate only if it is free RIGHT NOW, else `None`.
///
/// For the PERIODIC republishers. Each tick rewrites the same derived state from
/// scratch, so a tick arriving while the previous one is still pushing has
/// nothing to add that the in-flight one is not already carrying — dropping it
/// is strictly better than queueing a duplicate behind it. Callers MUST report
/// the skip to their caller (never a silent success) so the next tick retries;
/// see `vault_write_state`, whose JS dedupe marker only advances on a real write.
fn vault_admit_now() -> Option<tokio::sync::SemaphorePermit<'static>> {
    vault_gate().try_acquire().ok()
}

fn run_git_once(args: &[&str], cwd: Option<&std::path::Path>) -> Result<String, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(crate::git::app_owned_credential_args());
    cmd.args(args);
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|e| format!("run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// A corrupt/truncated `.git/index` — "bad signature 0x00000000", a partial
/// write (app killed mid-sync), AV interference, etc. Recognized so we can heal
/// instead of failing every subsequent sync forever ("nothing happening").
pub(crate) fn is_corrupt_index(err: &str) -> bool {
    let l = err.to_lowercase();
    l.contains("index file corrupt")
        || l.contains("bad signature")
        || l.contains("bad index file")
        || l.contains("index file smaller than expected")
        || l.contains("unknown index entry format")
        || l.contains("resolve-undo")
}

/// Drop a corrupt index and rebuild it from HEAD. Working-tree files are NEVER
/// touched — the index is only the staging area, so a following `add`/`commit`/
/// `reset` re-stages cleanly. Best-effort; safe to call spuriously. Shared with
/// git.rs (the Code-page git) so a corrupt project index self-heals too.
pub(crate) fn repair_index(cwd: Option<&std::path::Path>) {
    if let Ok(p) = run_git_once(&["rev-parse", "--git-path", "index"], cwd) {
        let rel = p.trim();
        if !rel.is_empty() {
            let full = match cwd {
                Some(d) => d.join(rel),
                None => std::path::PathBuf::from(rel),
            };
            let _ = std::fs::remove_file(&full);
            let _ = std::fs::remove_file(full.with_extension("lock")); // stale index.lock too
        }
    }
    // Rebuild the index to match HEAD so the retried op has a valid base.
    let _ = run_git_once(&["read-tree", "HEAD"], cwd);
    eprintln!("vault: rebuilt a corrupt git index");
}

/// A leftover `.lock` file — git's single-writer guard, orphaned when the app (or
/// a git child) is killed mid-write. Git then refuses EVERY operation that needs
/// that lock: `add`, `commit` and `reset --hard` all fail with "Unable to create
/// '<path>.lock': File exists". Nothing ever removes it, so one crash freezes
/// vault sync permanently.
///
/// Observed live: a 0-byte `.git/index.lock` from 2026-07-29 15:15 left this
/// device's clone 31,997 commits behind origin for eleven days. Device sync still
/// looked healthy because its `reset --hard` was best-effort — it kept re-reading
/// an eleven-day-old snapshot of `state/devices/` and reporting "no change", so
/// "My OwLLM Devices" silently stopped seeing peers.
pub(crate) fn is_lock_contention(err: &str) -> bool {
    let l = err.to_lowercase();
    l.contains(".lock") && l.contains("file exists")
}

/// How long a `.lock` must sit untouched before we treat it as orphaned. A lock
/// is created once and held for the whole operation, so age is the honest signal:
/// a genuinely concurrent write is seconds old, the wedge this repairs was days
/// old. Ten minutes is far beyond any index write on a text-only vault, and far
/// short of "one crash freezes sync forever".
const STALE_LOCK_SECS: u64 = 600;

/// The lock path git names in its own error — `Unable to create '<path>': File
/// exists`. Using git's reported path (rather than guessing `.git/index.lock`)
/// heals whichever lock actually blocked us, including ref locks under a
/// worktree's private git dir.
fn lock_path_from_err(err: &str) -> Option<std::path::PathBuf> {
    let (_, rest) = err.split_once('\'')?;
    let (path, _) = rest.split_once('\'')?;
    let p = std::path::PathBuf::from(path);
    let is_lock = p
        .extension()
        .and_then(|x| x.to_str())
        .is_some_and(|x| x.eq_ignore_ascii_case("lock"));
    is_lock.then_some(p)
}

/// Remove an orphaned lock so the retried command can proceed. Only removes it
/// when it is older than `STALE_LOCK_SECS`, so a git process that really is
/// mid-write is never sabotaged — that case is transient and resolves itself.
/// Working-tree files are NEVER touched. Returns true when a lock was cleared,
/// so the caller only retries if something actually changed.
pub(crate) fn repair_stale_lock(err: &str) -> bool {
    let Some(path) = lock_path_from_err(err) else {
        return false;
    };
    let stale = path
        .metadata()
        .and_then(|m| m.modified())
        .map(|t| t.elapsed().map(|d| d.as_secs() >= STALE_LOCK_SECS).unwrap_or(false))
        .unwrap_or(false);
    if !stale {
        return false;
    }
    if std::fs::remove_file(&path).is_err() {
        return false;
    }
    eprintln!("vault: cleared an orphaned git lock ({})", path.display());
    true
}

/// A zeroed / unreadable branch ref — `.git/refs/heads/<branch>` left as 41 NUL
/// bytes when the app dies mid-ref-write (the filesystem records the size but the
/// content never flushes). HEAD then resolves to nothing and EVERY git command in
/// the repo fails with "your current branch appears to be broken". Recognized for
/// the same reason as a corrupt index: without it each sync tick retried forever,
/// and since `gc --auto` failed too it wrote a fresh pack per attempt — observed
/// live as 5,046 packs / 11.5 GB on a two-file vault, ~2 git processes a second,
/// which starved every other git operation on the machine (the shared
/// credential-store lock) until the app was killed.
pub(crate) fn is_broken_ref(err: &str) -> bool {
    let l = err.to_lowercase();
    l.contains("reference broken")
        || l.contains("branch appears to be broken")
        || l.contains("failed to resolve head")
        || l.contains("unable to resolve reference")
        // git 2.43+ fetch reports a zeroed remote-tracking ref as
        // "fatal: bad object refs/remotes/origin/<b>" — a REF path after
        // "bad object" always means ref-file corruption, never a bad commit.
        || l.contains("bad object refs/")
        // …and symbolic-ref/rev-parse report the broken-ref case as a missing
        // HEAD (verified on git 2.34 and 2.43).
        || l.contains("no such ref: head")
}

/// Restore a zeroed branch ref from the best source available: the ref's own
/// reflog (the last SHA it held), then the matching remote-tracking ref. Only the
/// 41-byte pointer is lost in this corruption — every commit object is still in
/// the object store — so this recovers the full history. Working-tree files are
/// NEVER touched. Best-effort; safe to call spuriously.
/// True when a git ref/HEAD file on disk is unusable: empty, or nothing but NUL
/// padding (the crash signature — the filesystem recorded the 41-byte size but
/// never flushed the content). A MISSING file is not corruption: that is normal
/// for packed refs and for an unborn branch, so callers must leave it alone.
fn file_is_zeroed(path: &std::path::Path) -> bool {
    match std::fs::read(path) {
        Ok(b) => b.is_empty() || b.iter().all(|c| matches!(c, 0 | b'\n' | b'\r' | b' ')),
        Err(_) => false,
    }
}

/// Absolute `--git-common-dir` and `--absolute-git-dir` for `cwd`.
///
/// These differ and the distinction is load-bearing: in a linked worktree (every
/// fleet per-agent checkout) `refs/heads/*` and `logs/refs/heads/*` live in the
/// COMMON dir, while HEAD and the index live in the worktree's own gitdir. Using
/// the worktree gitdir for refs would look under `.git/worktrees/<name>/refs/…`,
/// find nothing, and silently never heal. `--path-format=absolute` is required
/// because the bare form returns a RELATIVE ".git" from the repo root.
fn git_dirs(cwd: Option<&std::path::Path>) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    if let (Ok(common), Ok(own)) = (
        run_git_once(
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            cwd,
        ),
        run_git_once(&["rev-parse", "--absolute-git-dir"], cwd),
    ) {
        let (common, own) = (common.trim(), own.trim());
        if !common.is_empty() && !own.is_empty() {
            return Some((
                std::path::PathBuf::from(common),
                std::path::PathBuf::from(own),
            ));
        }
    }
    // FALLBACK — a zeroed HEAD makes git disown the directory entirely ("fatal:
    // not a git repository"), so `rev-parse` cannot locate the dirs we need in
    // order to repair that very HEAD. Resolve them from the filesystem instead.
    let base = cwd?;
    let dot = base.join(".git");
    let own = if dot.is_dir() {
        dot
    } else if dot.is_file() {
        // Linked worktree / submodule: ".git" is a file holding "gitdir: <path>".
        let txt = std::fs::read_to_string(&dot).ok()?;
        let p = txt.split_once("gitdir:")?.1.trim();
        let p = std::path::PathBuf::from(p);
        if p.is_absolute() { p } else { base.join(p) }
    } else {
        return None;
    };
    // A worktree gitdir carries `commondir` (usually the relative "../..").
    let common = match std::fs::read_to_string(own.join("commondir")) {
        Ok(rel) => {
            let rel = rel.trim();
            let p = std::path::PathBuf::from(rel);
            let joined = if p.is_absolute() { p } else { own.join(p) };
            joined.canonicalize().unwrap_or(joined)
        }
        Err(_) => own.clone(),
    };
    Some((common, own))
}

/// Restore a zeroed ref. Handles BOTH shapes of the corruption:
///   * the branch ref (`refs/heads/<b>`) — restored from its own reflog, else
///     the matching remote-tracking ref;
///   * the HEAD file itself — restored to the default branch (origin/HEAD, else
///     an existing main/master), since a zeroed HEAD hides which branch we were on.
///
/// Only the pointer is lost in this corruption — every commit object survives —
/// so the full history comes back. Working-tree files are NEVER touched.
/// Best-effort, idempotent, and safe to call spuriously on any platform.
pub(crate) fn repair_broken_ref(cwd: Option<&std::path::Path>) {
    let Some((common, own)) = git_dirs(cwd) else {
        return;
    };

    // 1. HEAD is written the same way and can be zeroed too. Without this the
    //    branch repair below cannot even learn which ref to fix.
    let head_path = own.join("HEAD");
    if file_is_zeroed(&head_path) {
        let default = run_git_once(&["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], cwd)
            .ok()
            .map(|s| s.trim().replace("refs/remotes/origin/", "refs/heads/"))
            .filter(|s| s.starts_with("refs/heads/"))
            .or_else(|| {
                ["main", "master"]
                    .iter()
                    .map(|b| format!("refs/heads/{b}"))
                    .find(|r| common.join(r).exists())
            })
            .unwrap_or_else(|| "refs/heads/main".to_string());
        let _ = std::fs::remove_file(head_path.with_extension("lock"));
        if atomic_write(&head_path, format!("ref: {default}\n").as_bytes()).is_ok() {
            eprintln!("vault: restored zeroed HEAD -> {default}");
        }
    }

    // 2. Zeroed remote-tracking refs. `git fetch` cannot heal these itself: it
    //    refuses to lock a ref file it cannot parse ("cannot lock ref …
    //    reference broken"), so every fetch DOWNLOADS the full pack, fails the
    //    ref update, and KEEPS the pack — with auto-gc off (harden_repo) that
    //    reached 1,432 identical packs / 94.7 GB before it was caught (observed
    //    live 2026-08-22, three days after a disk-full crash zeroed the refs).
    //    Deleting the zeroed file IS the repair: the ref falls back to
    //    packed-refs, and the next fetch fast-forwards it normally.
    let mut stack = vec![common.join("refs").join("remotes")];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if file_is_zeroed(&p) {
                let _ = std::fs::remove_file(p.with_extension("lock"));
                if std::fs::remove_file(&p).is_ok() {
                    eprintln!("vault: removed zeroed remote ref {}", p.display());
                }
            }
        }
    }

    // 3. The branch ref HEAD points at. Read the HEAD file ourselves: `git
    //    symbolic-ref HEAD` fails with "fatal: No such ref: HEAD" precisely
    //    when the pointed-at ref is broken — verified on git 2.34 (Windows)
    //    and 2.43 (Linux) — which made this whole repair silently bail on the
    //    PRIMARY corruption case. That is why a zeroed refs/heads/main
    //    survived three days on a machine whose build shipped this healer.
    let Ok(head) = std::fs::read_to_string(own.join("HEAD")) else {
        return;
    };
    let refname = match head.trim().strip_prefix("ref:") {
        Some(r) => r.trim().to_string(),
        None => return, // detached HEAD — nothing branch-shaped to fix
    };
    if !refname.starts_with("refs/heads/") {
        return;
    }
    let ref_path = common.join(&refname);
    if !file_is_zeroed(&ref_path) {
        return;
    }
    let mut candidates: Vec<String> = Vec::new();
    if let Ok(text) = std::fs::read_to_string(common.join("logs").join(&refname)) {
        // Reflog line: "<old-sha> <new-sha> <who> <when>\t<message>" — field 2 is
        // the value the ref last held. The crash that zeroes the ref usually
        // zeroes the reflog's FINAL line the same way, and NUL bytes survive
        // trim(), so "last non-empty line" picked the corrupt line and the heal
        // came up empty (observed live 2026-08-22). Walk backwards to the newest
        // line whose second field is a real SHA.
        if let Some(sha) = text.lines().rev().find_map(|l| {
            let sha = l.split_whitespace().nth(1)?;
            (matches!(sha.len(), 40 | 64) && sha.bytes().all(|b| b.is_ascii_hexdigit()))
                .then(|| sha.to_string())
        }) {
            candidates.push(sha);
        }
    }
    if let Some(branch) = refname.strip_prefix("refs/heads/") {
        candidates.push(format!("refs/remotes/origin/{branch}"));
    }
    // The zeroed file has to go FIRST: `update-ref` refuses to lock a ref it
    // cannot read ("cannot lock ref: reference broken").
    let _ = std::fs::remove_file(&ref_path);
    let _ = std::fs::remove_file(ref_path.with_extension("lock"));
    for c in candidates {
        let spec = format!("{c}^{{commit}}");
        let Ok(sha) = run_git_once(&["rev-parse", "--verify", &spec], cwd) else {
            continue;
        };
        let sha = sha.trim().to_string();
        if sha.is_empty() {
            continue;
        }
        if run_git_once(&["update-ref", &refname, &sha], cwd).is_ok() {
            eprintln!("vault: restored broken ref {refname} -> {sha}");
            return;
        }
    }
    eprintln!("vault: ref {refname} is broken and could not be restored");
}

/// PREVENTION. Git does not fsync refs by default on ANY platform — the default
/// `core.fsync` set covers objects and the index only, so a power loss or hard
/// kill mid-ref-write leaves `refs/heads/<b>` as NUL bytes. That is exactly how
/// the 2026-08-01 vault corruption happened (Kernel-Power 41 during a sync).
/// `all` adds `reference`, making the ref write durable.
///
/// Also takes auto-gc off git's hands. A FAILING `gc --auto` re-fires on every
/// subsequent command once the pack count passes gc.autoPackLimit (default 50)
/// and writes a fresh pack each time — the runaway that reached 5,046 packs /
/// 11.5 GB on a two-file repo. We consolidate deliberately in `maintain_repo`.
/// Plain `git config`, so it behaves identically on Windows/macOS/Linux.
pub(crate) fn harden_repo(dir: &std::path::Path) {
    let _ = run_git_once(&["config", "core.fsync", "all"], Some(dir));
    let _ = run_git_once(&["config", "gc.auto", "0"], Some(dir));
    let _ = run_git_once(&["config", "maintenance.auto", "false"], Some(dir));
}

/// Loose objects across the 256 fan-out dirs, counting no further than `cap`.
/// The result is only ever compared against a threshold and a runaway vault
/// holds six figures of them, so enumerating past the cap is pure waste.
fn loose_object_count(common: &std::path::Path, cap: usize) -> usize {
    let Ok(rd) = std::fs::read_dir(common.join("objects")) else {
        return 0;
    };
    let mut n = 0usize;
    for e in rd.flatten() {
        // Only the hex fan-out dirs hold loose objects; skip pack/, info/, etc.
        let name = e.file_name();
        let is_fanout = name
            .to_str()
            .is_some_and(|s| s.len() == 2 && s.bytes().all(|b| b.is_ascii_hexdigit()));
        if !is_fanout {
            continue;
        }
        if let Ok(inner) = std::fs::read_dir(e.path()) {
            n += inner.flatten().count();
            if n >= cap {
                return n;
            }
        }
    }
    n
}

/// Deliberate, bounded replacement for the auto-gc we disabled. The vault commits
/// on every change (~47k commits in 50 days observed), so object count grows
/// without limit and every git command has to mmap each pack index.
///
/// Gated on LOOSE OBJECTS as well as pack count. Pack count alone missed the
/// failure mode that actually happened: a vault reached 83,095 commits, 128,117
/// loose objects and 7.2 GB while sitting at just 10 packs, so this never once
/// fired — and every 5-second sync had to walk that repo, which is what made
/// each push slow enough to saturate the blocking pool.
pub(crate) fn maintain_repo(dir: &std::path::Path) {
    const PACK_LIMIT: usize = 24;
    const LOOSE_LIMIT: usize = 8192;
    let Some((common, _)) = git_dirs(Some(dir)) else {
        return;
    };
    let pack_dir = common.join("objects").join("pack");
    let packs = std::fs::read_dir(&pack_dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.path().extension().is_some_and(|x| x == "pack"))
                .count()
        })
        .unwrap_or(0);
    let loose = loose_object_count(&common, LOOSE_LIMIT);
    if packs <= PACK_LIMIT && loose < LOOSE_LIMIT {
        return;
    }
    eprintln!("vault: {packs} packs / {loose}+ loose objects — consolidating");
    // Keep 30 days of reflog as the recovery source repair_broken_ref reads from;
    // -ad folds every pack into one. All take the shared git lock via run_git.
    let _ = run_git(&["reflog", "expire", "--expire=30.days", "--all"], Some(dir));
    // A SILENT repack failure is how the 1,432-pack runaway stayed invisible:
    // broken refs made every repack fail while `let _ =` swallowed it, so the
    // pack count only ever grew. run_git's heal ladder already repairs and
    // retries; whatever still fails here must be said out loud.
    if let Err(e) = run_git(&["repack", "-ad", "--quiet"], Some(dir)) {
        eprintln!("vault: repack failed — packs will keep accumulating: {e}");
        return; // prune would fail the same way; keep the noise to one line
    }
    // repack -ad packs everything REACHABLE; unreachable loose objects (dropped
    // merge parents, expired reflog tips) survive it and are what actually pile
    // up here, so prune them too.
    let _ = run_git(&["prune", "--expire=30.days"], Some(dir));
}

/// Run `maintain_repo` at most once every 6 hours.
///
/// MUST be called from a blocking thread that already holds the vault gate —
/// never from the async runtime, where a multi-minute repack would stall every
/// other task. Re-checking on an interval rather than once per process is the
/// point: this app is left open for days, and the runaway that wedged it grew
/// entirely inside a single 14-hour session.
fn maintain_repo_if_due(dir: &std::path::Path) {
    use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
    const INTERVAL_SECS: u64 = 6 * 3600;
    static LAST_RUN: AtomicU64 = AtomicU64::new(0);
    let now = now_secs();
    let last = LAST_RUN.load(Relaxed);
    // last == 0: first sync of the process, so a repo that arrived bloated gets
    // consolidated promptly instead of waiting out the first interval.
    if last != 0 && now.saturating_sub(last) < INTERVAL_SECS {
        return;
    }
    LAST_RUN.store(now, Relaxed);
    maintain_repo(dir);
}

/// Consecutive failures that persisted THROUGH a self-heal, plus the epoch second
/// until which sync is paused. Only corruption-shaped failures count: ordinary
/// network/auth errors must keep retrying normally.
static REPO_FAILS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
static COOLDOWN_UNTIL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Seconds of cooldown left, if sync is currently paused.
pub(crate) fn sync_cooldown_remaining() -> Option<u64> {
    let until = COOLDOWN_UNTIL.load(std::sync::atomic::Ordering::Relaxed);
    until.checked_sub(now_secs()).filter(|s| *s > 0)
}

/// CIRCUIT BREAKER. Four UI timers drive vault sync; when the repo was broken they
/// each retried on schedule forever (~2 git processes/second for 38 hours). After
/// three failures that survived a self-heal, back off exponentially (1 min → 1 h)
/// instead of hammering. A success clears it — but callers only report a success
/// when it PROVES health (a repaired command's retry), never for routine commands
/// that succeed while the repo is broken (see run_git's final arm).
fn note_repo_health(r: &Result<String, String>) {
    use std::sync::atomic::Ordering::Relaxed;
    match r {
        Ok(_) => {
            REPO_FAILS.store(0, Relaxed);
            COOLDOWN_UNTIL.store(0, Relaxed);
        }
        Err(e) if is_broken_ref(e) || is_corrupt_index(e) || is_lock_contention(e) => {
            let n = REPO_FAILS.fetch_add(1, Relaxed) + 1;
            if n >= 3 {
                let backoff = 60u64.saturating_mul(1u64 << (n - 3).min(6)).min(3600);
                COOLDOWN_UNTIL.store(now_secs() + backoff, Relaxed);
                eprintln!(
                    "vault: repo still broken after self-heal ({n}x) — pausing sync {backoff}s"
                );
            }
        }
        Err(_) => {} // network / auth / merge conflicts are not corruption
    }
}

fn run_git(args: &[&str], cwd: Option<&std::path::Path>) -> Result<String, String> {
    // Poisoned lock (a prior panic) must not wedge sync — recover the guard.
    let _guard = VAULT_GIT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    match run_git_once(args, cwd) {
        Err(e) if is_corrupt_index(&e) => {
            repair_index(cwd);
            let retried = run_git_once(args, cwd); // retry once, now with a clean index
            note_repo_health(&retried);
            retried
        }
        Err(e) if is_broken_ref(&e) => {
            repair_broken_ref(cwd);
            let retried = run_git_once(args, cwd); // retry once, now with a resolvable HEAD
            note_repo_health(&retried);
            retried
        }
        Err(e) if is_lock_contention(&e) && repair_stale_lock(&e) => {
            let retried = run_git_once(args, cwd); // retry once, now with the lock gone
            note_repo_health(&retried);
            retried
        }
        other => {
            // Failures still count (a lock too FRESH to clear is one), but a
            // ROUTINE success must not reset the breaker: during the 2026-08-22
            // runaway every tick mixed successful `config`/`rev-parse` calls in
            // with the failing fetch, so reset-on-any-success pinned the fail
            // count at zero and the breaker never engaged. Only a repaired-and-
            // retried command (the arms above) proves health and clears it.
            if other.is_err() {
                note_repo_health(&other);
            }
            other
        }
    }
}

/// Clone the vault. Prefer the host credential helper (github_connect wrote
/// ~/.git-credentials), falling back to a token-embedded URL if that fails.
fn clone_vault(token: &str, login: &str, dir: &std::path::Path) -> Result<(), String> {
    if let Some(parent) = dir.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let dir_s = dir.to_string_lossy().to_string();
    let plain = format!("https://github.com/{login}/{VAULT_REPO}.git");
    // Full clone (the vault is tiny text) so commit/push stay simple — shallow
    // clones complicate pushes.
    if run_git(&["clone", &plain, &dir_s], None).is_ok() {
        harden_repo(dir); // durable ref writes from the very first sync
        return Ok(());
    }
    // Fallback: embed the token for this clone (the helper wasn't usable).
    let auth = format!("https://{login}:{token}@github.com/{login}/{VAULT_REPO}.git");
    run_git(&["clone", &auth, &dir_s], None)?;
    harden_repo(dir);
    // Reset the remote to the tokenless URL so the token isn't left in
    // .git/config — the helper (or a future re-embed) handles auth on push.
    let _ = run_git(&["remote", "set-url", "origin", &plain], Some(dir));
    Ok(())
}

fn build_status(repo_exists: bool, cloned: bool, login: &str) -> VaultStatus {
    let dir = vault_dir();
    VaultStatus {
        connected: true,
        login: Some(login.to_string()),
        repo_exists,
        cloned,
        path: if cloned {
            dir.as_ref().map(|p| p.to_string_lossy().into_owned())
        } else {
            None
        },
        repo_url: Some(format!("https://github.com/{login}/{VAULT_REPO}")),
    }
}

// --------------------------------------------------------------------------
// SECURITY: account-ownership guard
//
// Credentials are tied to the GitHub account that OWNS the `.owllm` folder. The
// only durable, per-account marker of that ownership on disk is the local vault
// clone's `origin` remote: it points at `github.com/<owner>/owllm-vault`, and
// only the account that created it could have. If that owner differs from the
// account signed in now, the whole `.owllm` was transplanted from someone else
// — a copied/portable install, a cloned disk image, a shared build — carrying
// THAT person's `agent_secrets.json` (API keys) and their synced vault. This is
// exactly the reported leak: a fresh install on a different GitHub still showed
// (and could USE) the original owner's keys, because `vault_ensure` reused the
// existing clone without checking who it belonged to.
// --------------------------------------------------------------------------

/// Parse the GitHub owner ("login") out of an `owllm-vault` remote URL.
/// Handles the forms git ever writes for this repo:
///   https://github.com/OWNER/owllm-vault
///   https://github.com/OWNER/owllm-vault.git
///   https://user:token@github.com/OWNER/owllm-vault.git   (token-embedded fallback)
///   git@github.com:OWNER/owllm-vault.git                   (ssh)
/// Returns None when no `github.com/<owner>` segment is present.
pub(crate) fn parse_vault_owner(remote: &str) -> Option<String> {
    let r = remote.trim();
    let idx = r.find("github.com")?;
    // After "github.com" comes either '/' (https) or ':' (ssh), then OWNER/repo.
    let after = r[idx + "github.com".len()..].trim_start_matches(['/', ':']);
    let owner = after.split('/').next()?.trim();
    if owner.is_empty() {
        None
    } else {
        Some(owner.to_string())
    }
}

/// Pure decision: is the local vault owned by a DIFFERENT account than the one
/// signed in? Only a provable mismatch (both sides non-empty, case-insensitively
/// different) counts — so a user's own machine is never flagged.
pub(crate) fn is_foreign_owner(vault_owner: &str, signed_in_login: &str) -> bool {
    let o = vault_owner.trim();
    let l = signed_in_login.trim();
    !o.is_empty() && !l.is_empty() && !o.eq_ignore_ascii_case(l)
}

/// Read the `origin` owner of the local vault clone, if one exists.
fn local_vault_owner() -> Option<String> {
    let dir = vault_dir()?;
    if !is_cloned(&dir) {
        return None;
    }
    let url = run_git(&["remote", "get-url", "origin"], Some(&dir)).ok()?;
    parse_vault_owner(&url)
}

/// Enforce that on-disk credentials belong to `current_login`. When the local
/// vault clone was created by a different account (transplanted `.owllm`):
///   1. quarantine every inherited API secret (keeping only the current GitHub
///      sign-in) so nothing of the previous owner's remains usable, and
///   2. remove the foreign vault clone so `vault_ensure` re-clones THIS
///      account's own (empty) vault instead of syncing the previous owner's
///      chats/projects/model list.
/// Fires only on a provable cross-account mismatch; a no-op otherwise. Returns
/// true when it acted.
pub fn enforce_account_ownership(current_login: &str) -> bool {
    let Some(owner) = local_vault_owner() else {
        return false;
    };
    if !is_foreign_owner(&owner, current_login) {
        return false;
    }
    eprintln!(
        "SECURITY: local vault belongs to '{owner}' but the signed-in account is \
         '{}'. This `.owllm` was transplanted from another account — quarantining \
         inherited credentials and re-cloning the correct vault.",
        current_login.trim()
    );
    match crate::accounts::quarantine_foreign_secrets(&["GITHUB_TOKEN", "GITHUB_LOGIN"]) {
        Ok(n) => eprintln!("SECURITY: quarantined {n} inherited API secret(s)."),
        Err(e) => eprintln!("SECURITY: secret quarantine failed: {e}"),
    }
    if let Some(dir) = vault_dir() {
        if let Err(e) = std::fs::remove_dir_all(&dir) {
            eprintln!("SECURITY: could not remove foreign vault clone: {e}");
        }
    }
    true
}

/// Startup entry: enforce ownership using the stored GitHub login BEFORE any
/// sync runs, so an app UPDATE neutralizes a transplanted install on the very
/// next launch. No-op when GitHub isn't connected or no local vault clone
/// exists (nothing to prove ownership against yet).
pub fn enforce_account_ownership_on_startup() {
    if let Some(login) = crate::accounts::accounts_get_secret("GITHUB_LOGIN".to_string()) {
        enforce_account_ownership(&login);
    }
}

// --------------------------------------------------------------------------
// Tauri commands
// --------------------------------------------------------------------------

/// Report the vault state without changing anything (cheap-ish: one API GET
/// + a local dir check). Used to render the sync panel.
#[tauri::command]
pub async fn vault_status() -> VaultStatus {
    let Some((token, login)) = token_and_login() else {
        return VaultStatus::default();
    };
    tokio::task::spawn_blocking(move || {
        let exists = repo_exists(&token, &login);
        let cloned = vault_dir().map(|d| is_cloned(&d)).unwrap_or(false);
        build_status(exists, cloned, &login)
    })
    .await
    .unwrap_or_default()
}

// --------------------------------------------------------------------------
// One-click remote inference: a PC that exposes its model server publishes a
// "GPU server" record (its LAN IP + port + key) into the vault; other devices
// on the same account read it and connect with one click instead of typing IPs.
// --------------------------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GpuServer {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub api_key: String,
    /// The publishing machine (so a device doesn't offer itself).
    pub device: String,
}

fn machine_name() -> String {
    crate::hardware::machine_name().unwrap_or_else(|| "this-pc".to_string())
}

/// Primary LAN IPv4 — the UDP "connect to a public addr, read local_addr"
/// trick. No packets are sent; it just resolves the OS's default-route source
/// address, which is this machine's LAN IP. Works offline.
fn local_lan_ip() -> Option<String> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    sock.local_addr().ok().map(|a| a.ip().to_string())
}

/// Fast-forward the clone to origin's tip — the base every vault transaction
/// reads peers from and builds its commit on.
///
/// NOT best-effort, which is what it used to be. When the reset fails the working
/// tree is an unknown snapshot, and each channel then ingests that snapshot as if
/// it were current: a clone wedged by an orphaned lock kept reporting "no peer
/// changed" for eleven days instead of reporting that it could not read the
/// account at all. Failing here makes the channel return the error to the UI.
///
/// The fetch stays best-effort — offline is normal, and origin/<branch> is still
/// a valid base then. A vault with no origin ref yet (brand-new, never pushed) is
/// likewise not a failure: there is simply nothing to reset to.
fn reset_to_origin(dir: &std::path::Path, branch: &str) -> Result<(), String> {
    let _ = run_git(&["fetch", "origin", branch], Some(dir));
    let remote = format!("origin/{branch}");
    if run_git(&["rev-parse", "--verify", "--quiet", &remote], Some(dir)).is_err() {
        return Ok(());
    }
    run_git(&["reset", "--hard", &remote], Some(dir))
        .map(|_| ())
        .map_err(|e| format!("vault reset to {remote} failed: {e}"))
}

fn commit_push(dir: &std::path::Path, branch: &str) -> Result<(), String> {
    run_git(&["add", "-A"], Some(dir))?;
    let _ = run_git(&["commit", "-m", "owllm sync"], Some(dir));
    let _ = run_git(&["fetch", "origin", branch], Some(dir));
    let _ = run_git(
        &[
            "merge",
            "-X",
            "ours",
            "--no-edit",
            &format!("origin/{branch}"),
        ],
        Some(dir),
    );
    run_git(&["push", "origin", &format!("HEAD:{branch}")], Some(dir))
        .map(|_| ())
        .map_err(|e| format!("push failed: {e}"))
}

/// Publish this machine as a usable GPU/inference server in the vault.
#[tauri::command]
pub async fn vault_publish_server(port: u16, api_key: String) -> Result<(), String> {
    let dir = connected_vault_dir()?;
    if !is_cloned(&dir) {
        return Err("vault not set up on this device yet".to_string());
    }
    let host = local_lan_ip().ok_or_else(|| "couldn't determine this PC's LAN IP".to_string())?;
    let rec = GpuServer {
        name: machine_name(),
        host,
        port,
        api_key,
        device: machine_name(),
    };
    let _gate = vault_admit().await;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let _txn = vault_txn();
        let branch = current_branch(&dir);
        let state_dir = dir.join("state");
        std::fs::create_dir_all(&state_dir).map_err(|e| format!("mkdir state: {e}"))?;
        let json = serde_json::to_string_pretty(&rec).map_err(|e| e.to_string())?;
        atomic_write(&state_dir.join("gpu-server.json"), json.as_bytes())
            .map_err(|e| format!("write: {e}"))?;
        commit_push(&dir, &branch)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Stop advertising this machine as a server (deletes the record).
#[tauri::command]
pub async fn vault_unpublish_server() -> Result<(), String> {
    let dir = connected_vault_dir()?;
    if !is_cloned(&dir) {
        return Ok(());
    }
    let _gate = vault_admit().await;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let _txn = vault_txn();
        let branch = current_branch(&dir);
        let f = dir.join("state").join("gpu-server.json");
        if f.exists() {
            let _ = std::fs::remove_file(&f);
        }
        commit_push(&dir, &branch)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Read the published GPU server from the vault (None if absent, or if it's
/// THIS device's own record). Used to offer a one-click "Use my GPU box".
#[tauri::command]
pub async fn vault_read_server() -> Result<Option<GpuServer>, String> {
    let dir = connected_vault_dir()?;
    if !is_cloned(&dir) {
        return Ok(None);
    }
    let me = machine_name();
    tokio::task::spawn_blocking(move || -> Result<Option<GpuServer>, String> {
        let branch = current_branch(&dir);
        let _ = run_git(&["fetch", "origin", &branch], Some(&dir));
        match run_git(
            &["show", &format!("origin/{branch}:state/gpu-server.json")],
            Some(&dir),
        ) {
            Ok(contents) => {
                let rec: GpuServer =
                    serde_json::from_str(&contents).map_err(|e| format!("parse: {e}"))?;
                // Don't offer a device its own record.
                if rec.device == me {
                    Ok(None)
                } else {
                    Ok(Some(rec))
                }
            }
            Err(_) => Ok(None),
        }
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Copy plain files between two dirs. `overwrite=false` only adds files the
/// destination lacks (used remote→local so a remote team doesn't clobber a
/// locally-edited one); `overwrite=true` always copies (local→vault, so local
/// edits propagate). Together this gives union-of-all-devices for agent teams
/// + roles, with the locally-syncing device winning the vault copy.
fn copy_dir_files(from: &std::path::Path, to: &std::path::Path, overwrite: bool) {
    let Ok(rd) = std::fs::read_dir(from) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let Some(name) = p.file_name() else { continue };
        let dest = to.join(name);
        if !overwrite && dest.exists() {
            continue;
        }
        let Ok(bytes) = std::fs::read(&p) else {
            continue;
        };
        if overwrite {
            let _ = atomic_write(&dest, &bytes);
        } else {
            // A missing destination has no inode for another reader to map, so
            // create-new is already safe here — and it also refuses to clobber a
            // team file another channel created since the `exists()` check.
            let _ = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&dest)
                .and_then(|mut out| {
                    use std::io::Write;
                    out.write_all(&bytes)
                });
        }
    }
}

/// Sync custom agent teams + roles (files, not localStorage) through the
/// vault: pull teams from other devices (add-missing) and publish ours.
#[tauri::command]
pub async fn vault_sync_teams() -> Result<(), String> {
    let dir = connected_vault_dir()?;
    if !is_cloned(&dir) {
        return Ok(());
    }
    let pairs: Vec<(Option<std::path::PathBuf>, &str)> = vec![
        (crate::paths::custom_teams_dir(), "teams"),
        (crate::paths::custom_agents_dir(), "roles"),
    ];
    let _gate = vault_admit().await;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let _txn = vault_txn();
        let branch = current_branch(&dir);
        // Bring the working tree to the latest remote first.
        reset_to_origin(&dir, &branch)?;
        let mut any = false;
        for (src_opt, sub) in &pairs {
            let Some(src) = src_opt.as_ref() else {
                continue;
            };
            let vault_sub = dir.join("state").join(sub);
            let _ = std::fs::create_dir_all(&vault_sub);
            let _ = std::fs::create_dir_all(src);
            copy_dir_files(&vault_sub, src, false); // remote → local (add missing)
            copy_dir_files(src, &vault_sub, true); // local → vault (ours)
            any = true;
        }
        if any {
            commit_push(&dir, &branch)
        } else {
            Ok(())
        }
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

// --------------------------------------------------------------------------
// Project (chat) sync.
//
// Chats + per-project team wiring + routing graph live in the SQLite
// `agent_projects` table, NOT in localStorage — so the localStorage blob sync
// (vault_write_state) and the team-file sync (vault_sync_teams) both miss them.
// That made the "your chats follow you to every device" promise hollow. This
// closes the gap: each project row is mirrored to `state/projects/<id>.json`
// and remote rows are merged back in, last-writer-wins per project by
// updated_at. Device-LOCAL fields (the on-disk folder path, the trust flags)
// are NEVER overwritten on a project that already exists locally — only the
// content (name, description, team, graph, chat transcript, agent logs,
// team model) follows the user across devices.
// --------------------------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct VaultProject {
    id: String,
    name: String,
    description: String,
    team_json: String,
    model_overrides_json: String,
    graph_json: String,
    chat_json: String,
    agent_logs_json: String,
    team_default_model_id: String,
    created_at: String,
    updated_at: String,
    /// Portable project identity. Local paths never cross devices; this does.
    #[serde(default)]
    repo_url: String,
    #[serde(default)]
    created_device_id: String,
    #[serde(default)]
    created_device_name: String,
    /// LEGACY single path. Kept for back-compat with vault files/clients written
    /// before `locations` existed, but a folder path is device-LOCAL and is no
    /// longer adopted from here on a fresh device (that caused a Windows `C:\…`
    /// path to show up on a Mac). New devices read `locations[self_device_id]`
    /// and otherwise start GHOSTED (empty path) until the user picks a folder.
    location: String,
    /// Per-device folder paths, keyed by `device_id`. Each machine records ONLY
    /// its own entry on export and never clobbers a peer's, so changing the
    /// folder on one device can't break the path on another. `#[serde(default)]`
    /// so vault files written before this field still load.
    #[serde(default)]
    locations: HashMap<String, String>,
    /// Shared team-memory entries for this project (the RAG-like brain), keyed by
    /// project ID so they match across machines. Merged per-entry on import
    /// (last-writer-wins by each entry's own ts), independent of the project's
    /// updated_at — agents write memory without bumping the project row.
    /// `#[serde(default)]` so vault files written before this field still load.
    #[serde(default)]
    team_memory_json: String,
    /// Project RULES (directives) as a JSON array, synced as a UNIT with
    /// last-writer-wins by `directives_updated_at` (a real edit beats the seed-only
    /// sentinel ''). Unit-replace — not per-entry merge — so a DELETED rule stays
    /// deleted across PCs instead of resurrecting. `directives_seeded` carries the
    /// native-set version so the importer won't re-seed over a synced set.
    #[serde(default)]
    directives_json: String,
    #[serde(default)]
    directives_updated_at: String,
    #[serde(default)]
    directives_seeded: i64,
}

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct VaultDirective {
    id: String,
    kind: String,
    text: String,
    source: String,
    created_at: String,
    updated_at: String,
}

/// Read a project's rule set for export.
fn export_directives(conn: &rusqlite::Connection, project_id: &str) -> Vec<VaultDirective> {
    let mut stmt = match conn.prepare(
        "SELECT id, kind, text, source, created_at, updated_at FROM agent_directives \
         WHERE project_id = ?1 ORDER BY kind, created_at",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(rusqlite::params![project_id], |r| {
        Ok(VaultDirective {
            id: r.get::<_, String>(0).unwrap_or_default(),
            kind: r.get::<_, String>(1).unwrap_or_else(|_| "must".into()),
            text: r.get::<_, String>(2).unwrap_or_default(),
            source: r
                .get::<_, String>(3)
                .unwrap_or_else(|_| "user_typed".into()),
            created_at: r.get::<_, String>(4).unwrap_or_default(),
            updated_at: r.get::<_, String>(5).unwrap_or_default(),
        })
    });
    match rows {
        Ok(it) => it.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    }
}

/// Replace a project's local rule set with the remote one ONLY when the remote is
/// the newer writer (remote `directives_updated_at` > local). Unit-replace makes
/// deletes propagate; the seed version is adopted so the importer won't re-seed.
fn merge_directives(
    conn: &rusqlite::Connection,
    project_id: &str,
    remote_dua: &str,
    remote_seeded: i64,
    entries: &[VaultDirective],
) {
    let remote_dua = remote_dua.trim();
    if remote_dua.is_empty() {
        return; // remote is seed-only — nothing curated to propagate.
    }
    let local_dua: String = conn
        .query_row(
            "SELECT COALESCE(directives_updated_at, '') FROM agent_projects WHERE id = ?1",
            rusqlite::params![project_id],
            |r| r.get(0),
        )
        .unwrap_or_default();
    if remote_dua <= local_dua.as_str() {
        return; // local is same/newer — keep it.
    }
    // Remote wins → swap the whole set in.
    let _ = conn.execute(
        "DELETE FROM agent_directives WHERE project_id = ?1",
        rusqlite::params![project_id],
    );
    for e in entries {
        if e.text.trim().is_empty() {
            continue;
        }
        let _ = conn.execute(
            "INSERT INTO agent_directives (id, project_id, kind, text, source, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![e.id, project_id, e.kind, e.text, e.source, e.created_at, e.updated_at],
        );
    }
    // Adopt the remote stamp + seed version so we neither re-seed over this set nor
    // re-import it next round.
    let seeded = remote_seeded.max(0);
    let _ = conn.execute(
        "UPDATE agent_projects SET directives_updated_at = ?2, directives_seeded = ?3 WHERE id = ?1",
        rusqlite::params![project_id, remote_dua, seeded],
    );
}

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
struct VaultMemEntry {
    key: String,
    content: String,
    tags: String,
    author: String,
    ts: i64,
    // 'fact' | 'worklog'. Empty when the blob was written by a pre-kind client
    // (or round-tripped through one — old serde drops unknown fields).
    kind: String,
}

/// True for auto-captured worklog rows, whether flagged by the kind column
/// (new blobs) or the legacy tags convention (pre-kind blobs, and any blob
/// laundered through an old client that dropped the kind field).
fn is_worklog(kind: &str, tags: &str) -> bool {
    kind == "worklog"
        || tags
            .split(',')
            .any(|t| t.trim().eq_ignore_ascii_case("worklog"))
}

/// Read a project's shared team-memory rows (scope == project id) for export.
/// FACTS ONLY — the auto-captured worklog transcript is local, never synced.
fn export_team_memory(conn: &rusqlite::Connection, project_id: &str) -> Vec<VaultMemEntry> {
    let mut stmt = match conn.prepare(
        "SELECT mkey, content, tags, author, ts, kind FROM team_memory \
         WHERE scope = ?1 AND kind = 'fact' ORDER BY id ASC",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(rusqlite::params![project_id], |r| {
        Ok(VaultMemEntry {
            key: r.get::<_, String>(0).unwrap_or_default(),
            content: r.get::<_, String>(1).unwrap_or_default(),
            tags: r.get::<_, String>(2).unwrap_or_default(),
            author: r.get::<_, String>(3).unwrap_or_default(),
            ts: r.get::<_, i64>(4).unwrap_or(0),
            kind: r.get::<_, String>(5).unwrap_or_else(|_| "fact".into()),
        })
    });
    match rows {
        Ok(it) => it.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    }
}

/// Merge remote team-memory entries into the local store for one project scope.
/// Keyed entries upsert by (scope, key) keeping the newer ts; keyless entries
/// insert if a whitespace-normalized-identical (scope, content) isn't already
/// present. Additive for facts — a shared brain must never lose another
/// device's contributions — but worklog rows are quarantined: blobs pushed by
/// pre-kind clients still carry the whole work transcript, and adopting it
/// would re-inflate every device forever. This import filter is permanent, not
/// a migration shim.
fn merge_team_memory(conn: &rusqlite::Connection, project_id: &str, entries: &[VaultMemEntry]) {
    // Preload keyless content identities once for normalized dedup.
    let mut seen: std::collections::HashSet<String> = conn
        .prepare("SELECT content FROM team_memory WHERE scope = ?1 AND mkey = ''")
        .ok()
        .and_then(|mut s| {
            s.query_map(rusqlite::params![project_id], |r| r.get::<_, String>(0))
                .ok()
                .map(|it| {
                    it.filter_map(|r| r.ok())
                        .map(|c| crate::memory::normalize_content(&c))
                        .collect()
                })
        })
        .unwrap_or_default();
    for e in entries {
        if e.content.trim().is_empty() || is_worklog(&e.kind, &e.tags) {
            continue;
        }
        let tags = crate::memory::normalize_tags(&e.tags);
        if !e.key.trim().is_empty() {
            let local_ts: Option<i64> = conn
                .query_row(
                    "SELECT ts FROM team_memory WHERE scope = ?1 AND mkey = ?2",
                    rusqlite::params![project_id, e.key],
                    |r| r.get(0),
                )
                .ok();
            match local_ts {
                Some(ts) if ts >= e.ts => { /* local is same/newer — keep it */ }
                Some(_) => {
                    let _ = conn.execute(
                        "UPDATE team_memory SET content = ?1, tags = ?2, author = ?3, ts = ?4, kind = 'fact' \
                         WHERE scope = ?5 AND mkey = ?6",
                        rusqlite::params![e.content, tags, e.author, e.ts, project_id, e.key],
                    );
                }
                None => {
                    let _ = conn.execute(
                        "INSERT INTO team_memory (scope, mkey, content, tags, author, ts, kind) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'fact')",
                        rusqlite::params![project_id, e.key, e.content, tags, e.author, e.ts],
                    );
                }
            }
        } else {
            // Keyless: dedup on whitespace-normalized (case-sensitive) content.
            let norm = crate::memory::normalize_content(&e.content);
            if seen.insert(norm) {
                let _ = conn.execute(
                    "INSERT INTO team_memory (scope, mkey, content, tags, author, ts, kind) \
                     VALUES (?1, '', ?2, ?3, ?4, ?5, 'fact')",
                    rusqlite::params![project_id, e.content, tags, e.author, e.ts],
                );
            }
        }
    }
}

/// Raw text of a device record from the LOCAL vault clone
/// (`state/devices/<id>.json`), or None when the vault isn't set up or the
/// device was never published. Only someone with push access to the
/// account's private vault repo can put a record here — that's what makes
/// it usable as a same-GitHub-account proof for device auto-trust.
pub fn vault_device_record(device_id: &str) -> Option<String> {
    let p = vault_dir()?
        .join("state")
        .join("devices")
        .join(format!("{}.json", safe_id(device_id)));
    std::fs::read_to_string(p).ok()
}

/// Keep a project id safe as a filename (ids are `{hex}_{hex}` already, but be
/// defensive against anything hand-edited into the DB).
fn safe_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn export_projects(db: &std::path::Path) -> Result<Vec<VaultProject>, String> {
    if !db.is_file() {
        return Ok(Vec::new());
    }
    let conn = crate::projects::open_state_db(db)?;
    let exists: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='agent_projects'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        return Ok(Vec::new());
    }
    crate::projects::ensure_schema(&conn)?;
    let _ = crate::memory::ensure_schema(&conn);
    let self_id = crate::remote_devices::self_device_id().unwrap_or_default();
    let mut stmt = conn
        .prepare(
            "SELECT id, name, description, team_json, model_overrides_json, graph_json, \
             COALESCE(chat_json,''), COALESCE(agent_logs_json,''), team_default_model_id, \
             created_at, updated_at, location, COALESCE(location_device_id, ''), \
             COALESCE(repo_url, ''), COALESCE(created_device_id, ''), \
             COALESCE(created_device_name, '') \
             FROM agent_projects",
        )
        .map_err(|e| format!("prepare export: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(VaultProject {
                id: r.get(0)?,
                name: r.get(1)?,
                description: r.get::<_, String>(2).unwrap_or_default(),
                team_json: r.get::<_, String>(3).unwrap_or_else(|_| "[]".into()),
                model_overrides_json: r.get::<_, String>(4).unwrap_or_else(|_| "{}".into()),
                graph_json: r.get::<_, String>(5).unwrap_or_default(),
                chat_json: r.get::<_, String>(6).unwrap_or_default(),
                agent_logs_json: r.get::<_, String>(7).unwrap_or_default(),
                team_default_model_id: r.get::<_, String>(8).unwrap_or_default(),
                created_at: r.get::<_, String>(9).unwrap_or_default(),
                updated_at: r.get::<_, String>(10).unwrap_or_default(),
                repo_url: r.get::<_, String>(13).unwrap_or_default(),
                created_device_id: r.get::<_, String>(14).unwrap_or_default(),
                created_device_name: r.get::<_, String>(15).unwrap_or_default(),
                location: if r.get::<_, String>(12).unwrap_or_default() == self_id {
                    r.get::<_, String>(11).unwrap_or_default()
                } else {
                    String::new()
                },
                locations: HashMap::new(),
                team_memory_json: String::new(),
                directives_json: String::new(),
                directives_updated_at: String::new(),
                directives_seeded: 0,
            })
        })
        .map_err(|e| format!("query export: {e}"))?;
    let mut projects: Vec<VaultProject> = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("decode export: {e}"))?;
    let _ = crate::directives::ensure_schema(&conn);
    for p in projects.iter_mut() {
        // Shared team-memory (scope == project id).
        let mem = export_team_memory(&conn, &p.id);
        if !mem.is_empty() {
            p.team_memory_json = serde_json::to_string(&mem).unwrap_or_else(|_| "[]".into());
        }
        // Rule set + its sync stamps (only meaningful once the user has edited rules,
        // i.e. directives_updated_at != '').
        let (dua, seeded): (String, i64) = conn
            .query_row(
                "SELECT COALESCE(directives_updated_at,''), COALESCE(directives_seeded,0) \
                 FROM agent_projects WHERE id = ?1",
                rusqlite::params![p.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap_or_default();
        p.directives_updated_at = dua;
        p.directives_seeded = seeded;
        let dirs = export_directives(&conn, &p.id);
        if !dirs.is_empty() {
            p.directives_json = serde_json::to_string(&dirs).unwrap_or_else(|_| "[]".into());
        }
    }
    Ok(projects)
}

/// Upsert one remote project into the local DB. Returns true when the local DB
/// changed (new project, or remote was newer). Existing projects keep their
/// device-local location + trust/auto-approve flags.
///
/// `self_id` is THIS device's id: a fresh import takes the folder path from
/// `locations[self_id]` if this machine has bound one before, otherwise starts
/// GHOSTED (empty path) — it never adopts a peer's absolute path.
fn import_project(
    conn: &rusqlite::Connection,
    p: &VaultProject,
    self_id: &str,
) -> Result<bool, String> {
    // Device-local folder path for a brand-new import: only a path THIS device
    // recorded before (survives reinstall), else empty → the UI shows the
    // project ghosted with a "pick a folder" affordance. Deliberately does NOT
    // fall back to `p.location` — that is what surfaced a foreign machine's path.
    let insert_location = p
        .locations
        .get(self_id)
        .filter(|path| std::path::Path::new(path).is_dir())
        .cloned()
        .unwrap_or_default();
    let local_row: Option<(String, String, String, String)> = match conn.query_row(
        "SELECT updated_at, location, COALESCE(location_device_id, ''), COALESCE(repo_url, '') \
         FROM agent_projects WHERE id = ?",
        rusqlite::params![p.id],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        },
    ) {
        Ok(row) => Some(row),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(e) => return Err(format!("probe project: {e}")),
    };
    // 1) Upsert the project row FIRST so it's guaranteed to exist before the
    //    sub-table merges below (which UPDATE flags on agent_projects).
    let mut changed = match &local_row {
        None => {
            conn.execute(
                "INSERT INTO agent_projects (id, name, description, location, location_device_id, repo_url, \
                 created_device_id, created_device_name, trust_writes, \
                 auto_approve_all, team_json, model_overrides_json, graph_json, created_at, \
                 updated_at, team_default_model_id, chat_json, agent_logs_json) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, 0, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                rusqlite::params![
                    p.id,
                    p.name,
                    p.description,
                    insert_location,
                    self_id,
                    crate::projects::normalize_repo_url(&p.repo_url),
                    p.created_device_id,
                    p.created_device_name,
                    p.team_json,
                    p.model_overrides_json,
                    p.graph_json,
                    if p.created_at.is_empty() {
                        p.updated_at.clone()
                    } else {
                        p.created_at.clone()
                    },
                    p.updated_at,
                    p.team_default_model_id,
                    p.chat_json,
                    p.agent_logs_json,
                ],
            )
            .map_err(|e| format!("insert project: {e}"))?;
            true
        }
        Some((local, _, _, _)) => {
            if p.updated_at > *local {
                // Remote is newer → adopt CONTENT, keep local path + trust flags.
                conn.execute(
                    "UPDATE agent_projects SET name = ?2, description = ?3, repo_url = ?4, \
                     created_device_id = ?5, created_device_name = ?6, team_json = ?7, \
                     model_overrides_json = ?8, graph_json = ?9, chat_json = ?10, \
                     agent_logs_json = ?11, team_default_model_id = ?12, updated_at = ?13 \
                     WHERE id = ?1",
                    rusqlite::params![
                        p.id,
                        p.name,
                        p.description,
                        crate::projects::normalize_repo_url(&p.repo_url),
                        p.created_device_id,
                        p.created_device_name,
                        p.team_json,
                        p.model_overrides_json,
                        p.graph_json,
                        p.chat_json,
                        p.agent_logs_json,
                        p.team_default_model_id,
                        p.updated_at,
                    ],
                )
                .map_err(|e| format!("update project: {e}"))?;
                true
            } else {
                false
            }
        }
    };
    // Reconcile a legacy/existing row's folder binding independently of the
    // content timestamp. Old versions stored one global `location`, so merely
    // protecting brand-new imports left already-contaminated rows pointing at
    // a peer PC forever.
    if let Some((_, local_location, owner, local_repo)) = &local_row {
        // Repo identity is portable and may be discovered after the project's
        // content timestamp was written. Reconcile it independently so another
        // device cannot overwrite a newly-discovered origin with blank.
        if local_repo.trim().is_empty() && !p.repo_url.trim().is_empty() {
            conn.execute(
                "UPDATE agent_projects SET repo_url = ?2 WHERE id = ?1",
                rusqlite::params![p.id, p.repo_url],
            )
            .map_err(|e| format!("reconcile project repo: {e}"))?;
            changed = true;
        }
        let desired = p.locations.get(self_id).cloned();
        let local_is_real =
            !local_location.trim().is_empty() && std::path::Path::new(local_location).is_dir();
        let belongs_to_peer = p
            .locations
            .iter()
            .any(|(device, path)| device != self_id && path == local_location);
        let reconciled = match desired {
            // Schema migration has already validated this computer's binding.
            // owner=self + empty is an intentional tombstone for a foreign or
            // nonexistent path, even if an older release stamped that same bad
            // path into this device's vault map.
            _ if owner == self_id => None,
            // Restore the same-device record after reinstall/ghosting, but a
            // currently valid local folder wins: the user may just have moved
            // it and this sync is what will publish the new binding.
            Some(path)
                if local_location.trim().is_empty()
                    || (!local_is_real && path != *local_location) =>
            {
                Some(path)
            }
            Some(_) => None,
            // Definitely inherited from another machine and not a real folder
            // here: ghost it. If the identical path really exists on both PCs,
            // keep it as a legitimate legacy local binding and export will add
            // this device's own map entry below.
            None if belongs_to_peer && !local_is_real => Some(String::new()),
            // Unmapped legacy paths remain local and are claimed on export.
            None => None,
        };
        if let Some(path) = reconciled {
            if path != *local_location {
                conn.execute(
                    "UPDATE agent_projects SET location = ?2, location_device_id = ?3 WHERE id = ?1",
                    rusqlite::params![p.id, path, self_id],
                )
                .map_err(|e| format!("reconcile project location: {e}"))?;
                changed = true;
            }
        }
    }
    // 2) Merge the shared team-memory — INDEPENDENT of the project's updated_at
    //    (memory writes don't bump it). Per-entry last-writer-wins.
    if !p.team_memory_json.trim().is_empty() {
        if let Ok(entries) = serde_json::from_str::<Vec<VaultMemEntry>>(&p.team_memory_json) {
            let _ = crate::memory::ensure_schema(conn);
            // Re-indexing rewrites every term row for every memory in the
            // scope, so only pay for it when the merge actually wrote
            // something. On a converged fleet the 60-second sync merges
            // nothing, and re-indexing unconditionally meant the app never
            // stopped writing to the shared state DB.
            let before = conn.total_changes();
            merge_team_memory(conn, &p.id, &entries);
            if conn.total_changes() != before {
                let _ = crate::memory::reindex_team_memory_scope(conn, &p.id);
            }
        }
    }
    // 3) Merge the rule set — unit last-writer-wins by directives_updated_at
    //    (delete-aware), also independent of the project's updated_at.
    if !p.directives_updated_at.trim().is_empty() {
        let _ = crate::directives::ensure_schema(conn);
        let dirs = if p.directives_json.trim().is_empty() {
            Vec::new()
        } else {
            serde_json::from_str::<Vec<VaultDirective>>(&p.directives_json).unwrap_or_default()
        };
        merge_directives(
            conn,
            &p.id,
            &p.directives_updated_at,
            p.directives_seeded,
            &dirs,
        );
    }
    Ok(changed)
}

/// Sync the project/chat rows through the vault: pull every other device's
/// projects into the local DB (last-writer-wins per project), then publish
/// ours. Returns true when the local DB changed (so the UI can reload).
#[tauri::command]
pub async fn vault_sync_projects() -> Result<bool, String> {
    let dir = connected_vault_dir()?;
    if !is_cloned(&dir) {
        return Ok(false);
    }
    let db = crate::projects::project_db_path().ok_or_else(|| "no project db path".to_string())?;
    // This device's stable id — keys the per-device folder path in each project
    // file so we never adopt (or clobber) a peer's absolute path. Empty string
    // if the keypair can't be loaded; then paths fall through as ghosted, which
    // is the safe default.
    let self_id = crate::remote_devices::self_device_id().unwrap_or_default();
    // Coalescing: a 60s republisher. Skipping a tick that lands mid-sync costs
    // nothing — the next one rewrites the same rows from the DB.
    let Some(_gate) = vault_admit_now() else {
        return Ok(false);
    };
    tokio::task::spawn_blocking(move || -> Result<bool, String> {
        let _txn = vault_txn();
        let branch = current_branch(&dir);
        // Bring the working tree to the latest remote first (same as teams).
        reset_to_origin(&dir, &branch)?;
        let proj_dir = dir.join("state").join("projects");
        std::fs::create_dir_all(&proj_dir).map_err(|e| format!("mkdir projects: {e}"))?;

        // 1) remote → local DB.
        let mut imported = false;
        {
            // Ensure the DB + schema exist even on a fresh device that has
            // never created a project (so the first import can INSERT).
            if let Some(parent) = db.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let conn = crate::projects::open_state_db(&db)?;
            crate::projects::ensure_schema(&conn)?;
            if let Ok(rd) = std::fs::read_dir(&proj_dir) {
                for e in rd.flatten() {
                    let p = e.path();
                    if p.extension().and_then(|x| x.to_str()) != Some("json") {
                        continue;
                    }
                    let Ok(txt) = std::fs::read_to_string(&p) else {
                        continue;
                    };
                    let Ok(vp) = serde_json::from_str::<VaultProject>(&txt) else {
                        continue;
                    };
                    if vp.id.is_empty() {
                        continue;
                    }
                    if import_project(&conn, &vp, &self_id)? {
                        imported = true;
                    }
                }
            }
        }

        // 2) local DB → files (so locally-newer projects propagate up).
        for mut vp in export_projects(&db)? {
            if vp.id.is_empty() {
                continue;
            }
            let path = proj_dir.join(format!("{}.json", safe_id(&vp.id)));
            // Start from the peers' per-device map already on disk (the working
            // tree reflects origin after the reset above) so we never drop
            // another machine's recorded path, then record only OUR own path.
            let mut locations: HashMap<String, String> = std::fs::read_to_string(&path)
                .ok()
                .and_then(|txt| serde_json::from_str::<VaultProject>(&txt).ok())
                .map(|prev| prev.locations)
                .unwrap_or_default();
            if !self_id.is_empty() {
                if vp.location.trim().is_empty() {
                    locations.remove(&self_id);
                } else {
                    locations.insert(self_id.clone(), vp.location.clone());
                }
            }
            vp.locations = locations;
            let json = serde_json::to_string_pretty(&vp).map_err(|e| e.to_string())?;
            atomic_write(&path, json.as_bytes())
                .map_err(|e| format!("write project {}: {e}", vp.id))?;
        }

        // 3) commit + push.
        commit_push(&dir, &branch)?;
        Ok(imported)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Sync remote-device records through the vault: pull peer devices into the
/// local registry (so "My OwLLM Devices" auto-populates across the account),
/// then publish THIS device's public record. Metadata only — the vault is never
/// a command queue; control flows through the sealed transport. Returns true
/// when a peer record changed locally.
#[tauri::command]
pub async fn vault_sync_devices() -> Result<bool, String> {
    let dir = connected_vault_dir()?;
    if !is_cloned(&dir) {
        return Ok(false);
    }
    let (self_id, self_json) = crate::remote_devices::self_vault_record()?;
    // Presence is a machine-level contract. This used to use try_acquire and
    // silently drop the beat whenever projects/notebooks already owned the
    // vault. On a busy app, repeated collisions made a running peer look
    // offline. The native supervisor has one in-flight heartbeat, so waiting
    // asynchronously here is bounded without consuming a blocking thread.
    let _gate = vault_admit().await;
    tokio::task::spawn_blocking(move || -> Result<bool, String> {
        let _txn = vault_txn();
        let branch = current_branch(&dir);
        reset_to_origin(&dir, &branch)?;
        let dev_dir = dir.join("state").join("devices");
        std::fs::create_dir_all(&dev_dir).map_err(|e| format!("mkdir devices: {e}"))?;

        // 1) remote → local registry (public metadata only).
        let mut changed = false;
        if let Ok(rd) = std::fs::read_dir(&dev_dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) != Some("json") {
                    continue;
                }
                let Ok(txt) = std::fs::read_to_string(&p) else {
                    continue;
                };
                if let Ok(true) = crate::remote_devices::ingest_peer_record(&txt) {
                    changed = true;
                }
            }
        }

        // 2) publish OUR record.
        atomic_write(
            &dev_dir.join(format!("{}.json", safe_id(&self_id))),
            self_json.as_bytes(),
        )
        .map_err(|e| format!("write device record: {e}"))?;

        // 3) commit + push.
        commit_push(&dir, &branch)?;
        Ok(changed)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Sync the code-signing metadata through the vault: pull the newest per-platform
/// signing metadata (identity, team, expiry — NEVER the certificate bytes or
/// passwords) from the account and publish ours. This lets the user's other PCs
/// SEE that signing is configured and know to import the .p12 locally; the secret
/// material never enters the git repo. Returns true when local metadata changed.
#[tauri::command]
pub async fn vault_sync_signing() -> Result<bool, String> {
    let dir = connected_vault_dir()?;
    if !is_cloned(&dir) {
        return Ok(false);
    }
    let _gate = vault_admit().await;
    tokio::task::spawn_blocking(move || -> Result<bool, String> {
        let _txn = vault_txn();
        let branch = current_branch(&dir);
        reset_to_origin(&dir, &branch)?;
        let sdir = dir.join("state").join("signing");
        std::fs::create_dir_all(&sdir).map_err(|e| format!("mkdir signing: {e}"))?;
        let file = sdir.join("meta.json");

        // 1) remote → local (ingest, last-writer-wins by per-platform updated_ms).
        let mut changed = false;
        if let Ok(txt) = std::fs::read_to_string(&file) {
            if let Ok(true) = crate::signing::ingest_vault_meta(&txt) {
                changed = true;
            }
        }
        // 2) publish OUR metadata — recomputed AFTER ingest so a locally-newer
        //    set wins the next round instead of being clobbered.
        if let Some(js) = crate::signing::vault_meta_json() {
            atomic_write(&file, js.as_bytes()).map_err(|e| format!("write signing meta: {e}"))?;
        }
        // 3) commit + push.
        commit_push(&dir, &branch)?;
        Ok(changed)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// The clone's current branch (GitHub auto_init defaults to `main`).
fn current_branch(dir: &std::path::Path) -> String {
    run_git(&["rev-parse", "--abbrev-ref", "HEAD"], Some(dir))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "HEAD")
        .unwrap_or_else(|| "main".to_string())
}

/// Read the LATEST remote sync blob (`state/local.json`) WITHOUT touching the
/// working tree — `git show origin/<branch>:state/local.json` after a fetch.
/// Returns None when the file doesn't exist yet (fresh vault). The JS layer
/// decides whether to adopt it (last-write-wins by timestamp).
#[tauri::command]
pub async fn vault_read_remote_state() -> Result<Option<String>, String> {
    let dir = connected_vault_dir()?;
    if !is_cloned(&dir) {
        return Ok(None);
    }
    // Takes the gate even though it holds no transaction: it shells a network
    // `git fetch`, and without the gate it parked a blocking thread on
    // VAULT_GIT_LOCK behind whatever transaction was mid-push.
    let _gate = vault_admit().await;
    tokio::task::spawn_blocking(move || -> Result<Option<String>, String> {
        let branch = current_branch(&dir);
        let _ = run_git(&["fetch", "origin", &branch], Some(&dir));
        match run_git(
            &["show", &format!("origin/{branch}:state/local.json")],
            Some(&dir),
        ) {
            Ok(contents) => Ok(Some(contents)),
            Err(_) => Ok(None),
        }
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Write the sync blob, commit, integrate remote (ours wins on conflict — the
/// JS layer already resolved which side is newer), and push.
///
/// Returns whether the blob was actually written. `false` means a sync was
/// already in flight and this tick was coalesced into it — NOT that the state
/// is safe. The caller must leave its dedupe marker alone on `false` so the
/// next poll retries; see `pushNow` in vaultSync.ts.
#[tauri::command]
pub async fn vault_write_state(json: String) -> Result<bool, String> {
    let dir = connected_vault_dir()?;
    if !is_cloned(&dir) {
        return Err("vault not set up on this device yet".to_string());
    }
    // Coalescing: this is the 5-second poll, the channel that produced the
    // 512-thread pileup. A tick that cannot get the gate immediately carries
    // nothing the in-flight push is not already writing.
    let Some(_gate) = vault_admit_now() else {
        return Ok(false);
    };
    tokio::task::spawn_blocking(move || -> Result<bool, String> {
        let _txn = vault_txn();
        let branch = current_branch(&dir);
        let state_dir = dir.join("state");
        std::fs::create_dir_all(&state_dir).map_err(|e| format!("mkdir state: {e}"))?;
        atomic_write(&state_dir.join("local.json"), json.as_bytes())
            .map_err(|e| format!("write state: {e}"))?;
        run_git(&["add", "-A"], Some(&dir))?;
        // Commit; "nothing to commit" is fine (returns Err — ignore).
        let _ = run_git(&["commit", "-m", "owllm sync"], Some(&dir));
        // Integrate any remote commits before pushing; -X ours keeps our
        // just-written blob on conflict (JS already decided newer-wins).
        let _ = run_git(&["fetch", "origin", &branch], Some(&dir));
        let _ = run_git(
            &[
                "merge",
                "-X",
                "ours",
                "--no-edit",
                &format!("origin/{branch}"),
            ],
            Some(&dir),
        );
        let pushed = run_git(&["push", "origin", &format!("HEAD:{branch}")], Some(&dir))
            .map(|_| true)
            .map_err(|e| format!("push failed: {e}"));
        // Bounded consolidation, here on the blocking thread while the gate is
        // still ours: exclusive, off the async runtime, and at most 6-hourly.
        maintain_repo_if_due(&dir);
        pushed
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Fast-forward the local clone to origin after the JS layer has adopted the
/// remote blob into localStorage — keeps future commits clean/linear.
#[tauri::command]
pub async fn vault_align() -> Result<(), String> {
    let dir = connected_vault_dir()?;
    if !is_cloned(&dir) {
        return Ok(());
    }
    let _gate = vault_admit().await;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let _txn = vault_txn();
        let branch = current_branch(&dir);
        reset_to_origin(&dir, &branch)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Ensure the private vault repo exists AND is cloned locally. Idempotent:
/// safe to call on every connect / launch. Returns the resulting status.
#[tauri::command]
pub async fn vault_ensure() -> Result<VaultStatus, String> {
    let (token, login) =
        token_and_login().ok_or_else(|| "Connect GitHub first (Sync sign-in).".to_string())?;
    tokio::task::spawn_blocking(move || -> Result<VaultStatus, String> {
        // 0) SECURITY: if the local clone belongs to another account (a
        //    transplanted `.owllm`), quarantine the inherited credentials and
        //    drop the foreign clone BEFORE trusting or reusing it below.
        enforce_account_ownership(&login);
        // 1) Repo on GitHub.
        if !repo_exists(&token, &login) {
            create_repo(&token)?;
        }
        // 2) Local clone.
        let dir = vault_dir().ok_or_else(|| "no home directory for the local vault".to_string())?;
        if !is_cloned(&dir) {
            // A stale empty dir would make clone fail — remove it first.
            if dir.exists() {
                let _ = std::fs::remove_dir_all(&dir);
            }
            clone_vault(&token, &login, &dir)?;
        }
        Ok(build_status(true, is_cloned(&dir), &login))
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Ubuntu SIGBUS: a Git mmap reader must survive a concurrent write ----

    /// `git add` mmaps the file it is hashing. Truncating that inode in place
    /// faults the reader past the new end of file, which is SIGBUS. Proven on
    /// the reference Jetson: a core dump showed git faulting at byte 143156 of
    /// a 193558-byte project JSON that the sync had just shortened.
    #[test]
    fn atomic_write_keeps_an_existing_reader_on_the_complete_old_inode() {
        use std::io::{Read, Seek, SeekFrom};

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("project.json");
        let old = vec![b'A'; 256 * 1024];
        std::fs::write(&path, &old).unwrap();
        #[cfg(unix)]
        let before = std::fs::metadata(&path).unwrap();
        // Stand in for git's open mmap of the file it is hashing.
        let mut reader = std::fs::File::open(&path).unwrap();

        atomic_write(&path, b"new").unwrap();

        reader.seek(SeekFrom::Start(192 * 1024)).unwrap();
        let mut byte = [0_u8; 1];
        reader
            .read_exact(&mut byte)
            .expect("the old inode must still be readable past the new file's length");
        assert_eq!(byte[0], b'A', "an in-flight Git reader keeps the old bytes");
        assert_eq!(std::fs::read(&path).unwrap(), b"new", "the name is replaced");
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_ne!(
                before.ino(),
                std::fs::metadata(&path).unwrap().ino(),
                "replacement must swap the inode, not truncate it in place",
            );
        }
    }

    /// The temp file must never be visible to `git add -A`: it goes under
    /// `.git/`, which git always ignores, whenever a repo root is above us.
    #[test]
    fn atomic_write_stages_its_temp_inside_dot_git() {
        let repo = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(repo.path().join(".git")).unwrap();
        let state = repo.path().join("state");
        std::fs::create_dir_all(&state).unwrap();

        atomic_write(&state.join("local.json"), b"{}").unwrap();

        assert_eq!(std::fs::read(state.join("local.json")).unwrap(), b"{}");
        let leftovers: Vec<_> = std::fs::read_dir(&state)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .filter(|n| n != "local.json")
            .collect();
        assert!(
            leftovers.is_empty(),
            "no temp may be left in the working tree: {leftovers:?}",
        );
        assert!(
            repo.path().join(".git").join("owllm-write-tmp").is_dir(),
            "temps belong under .git so `git add -A` cannot stage them",
        );
    }

    // ---- SECURITY: account-ownership guard ----

    #[test]
    fn parse_owner_handles_every_remote_form() {
        assert_eq!(
            parse_vault_owner("https://github.com/ruigro/owllm-vault").as_deref(),
            Some("ruigro")
        );
        assert_eq!(
            parse_vault_owner("https://github.com/ruigro/owllm-vault.git").as_deref(),
            Some("ruigro")
        );
        assert_eq!(
            parse_vault_owner("https://ruigro:ghp_tok@github.com/ruigro/owllm-vault.git")
                .as_deref(),
            Some("ruigro")
        );
        assert_eq!(
            parse_vault_owner("git@github.com:ruigro/owllm-vault.git").as_deref(),
            Some("ruigro")
        );
        assert_eq!(parse_vault_owner("not a url").as_deref(), None);
        assert_eq!(parse_vault_owner("https://github.com/").as_deref(), None);
    }

    #[test]
    fn foreign_owner_only_fires_on_a_provable_cross_account_mismatch() {
        // The reported leak: vault cloned by 'ruigro', signed in as someone else.
        assert!(is_foreign_owner("ruigro", "sg-user"));
        // Same account (case-insensitive) is NEVER foreign — a user's own machine.
        assert!(!is_foreign_owner("ruigro", "ruigro"));
        assert!(!is_foreign_owner("RuiGro", "ruigro"));
        // Missing either side is not provable → never flag (no false wipes).
        assert!(!is_foreign_owner("", "ruigro"));
        assert!(!is_foreign_owner("ruigro", ""));
        assert!(!is_foreign_owner("  ", "  "));
    }

    #[test]
    fn quarantine_keeps_github_signin_and_drops_inherited_keys() {
        // Prove the purge contract on a temp secrets file via a scoped HOME.
        let tmp = std::env::temp_dir().join(format!("owllm-quar-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join(".owllm")).unwrap();
        let prev_home = std::env::var_os("USERPROFILE");
        std::env::set_var("USERPROFILE", &tmp);
        let secrets = tmp.join(".owllm").join("agent_secrets.json");
        std::fs::write(
            &secrets,
            r#"{"ANTHROPIC_API_KEY":"sk-ant-leaked","OPENAI_API_KEY":"sk-leaked","GITHUB_TOKEN":"his-tok","GITHUB_LOGIN":"sg-user"}"#,
        )
        .unwrap();

        let removed =
            crate::accounts::quarantine_foreign_secrets(&["GITHUB_TOKEN", "GITHUB_LOGIN"]).unwrap();
        assert_eq!(removed, 2, "both inherited API keys must be counted purged");

        let rewritten: std::collections::BTreeMap<String, String> =
            serde_json::from_str(&std::fs::read_to_string(&secrets).unwrap()).unwrap();
        assert_eq!(rewritten.get("GITHUB_LOGIN").map(String::as_str), Some("sg-user"));
        assert!(rewritten.get("ANTHROPIC_API_KEY").is_none(), "leaked key must be gone");
        assert!(rewritten.get("OPENAI_API_KEY").is_none(), "leaked key must be gone");

        // The original is preserved (moved aside), never silently destroyed.
        let quarantined = std::fs::read_dir(tmp.join(".owllm"))
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().starts_with("agent_secrets.quarantine-"));
        assert!(quarantined, "original secrets must be recoverable");

        match prev_home {
            Some(h) => std::env::set_var("USERPROFILE", h),
            None => std::env::remove_var("USERPROFILE"),
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    fn row_location(conn: &rusqlite::Connection, id: &str) -> String {
        conn.query_row(
            "SELECT location FROM agent_projects WHERE id = ?1",
            rusqlite::params![id],
            |r| r.get::<_, String>(0),
        )
        .unwrap()
    }

    fn vp_with(id: &str, locations: &[(&str, &str)]) -> VaultProject {
        let mut vp = VaultProject::default();
        vp.id = id.into();
        vp.name = "proj".into();
        vp.location = r"C:\foreign\path".into(); // a peer's absolute path
        vp.updated_at = "2026-01-01T00:00:00Z".into();
        vp.locations = locations
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        vp
    }

    // A fresh device that never bound a folder for this project must import it
    // GHOSTED (empty path) — it must NOT adopt the peer's `location`.
    #[test]
    fn import_ghosts_when_this_device_has_no_recorded_path() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::projects::ensure_schema(&conn).unwrap();
        let vp = vp_with("p1", &[("device-A", r"D:\1_GitHome\LLM-Studio")]);
        assert!(import_project(&conn, &vp, "device-B").unwrap());
        assert_eq!(row_location(&conn, "p1"), "");
    }

    // A device that HAS a recorded path in the map imports that path, so a
    // reinstall of the same machine re-binds automatically.
    #[test]
    fn import_uses_this_devices_recorded_path() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::projects::ensure_schema(&conn).unwrap();
        let local = std::env::temp_dir().join(format!("owllm-vault-p2-{}", std::process::id()));
        std::fs::create_dir_all(&local).unwrap();
        let local_text = local.to_string_lossy().to_string();
        let vp = vp_with("p2", &[("device-A", r"D:\x"), ("device-B", &local_text)]);
        assert!(import_project(&conn, &vp, "device-B").unwrap());
        assert_eq!(row_location(&conn, "p2"), local_text);
        let _ = std::fs::remove_dir_all(local);
    }

    // An EXISTING legacy local project keeps an unmapped path even when a
    // newer remote arrives; export will claim it for this device.
    #[test]
    fn import_keeps_existing_local_path() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::projects::ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO agent_projects (id, name, location, created_at, updated_at) \
             VALUES ('p3', 'proj', '/Users/me/local', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        let mut vp = vp_with("p3", &[("device-A", r"D:\x")]);
        vp.updated_at = "2026-02-01T00:00:00Z".into(); // remote newer → adopt content
        assert!(import_project(&conn, &vp, "device-B").unwrap());
        assert_eq!(row_location(&conn, "p3"), "/Users/me/local");
    }

    #[test]
    fn import_clears_existing_foreign_legacy_path() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::projects::ensure_schema(&conn).unwrap();
        let foreign = std::env::temp_dir()
            .join("owllm-path-that-must-not-exist")
            .to_string_lossy()
            .to_string();
        conn.execute(
            "INSERT INTO agent_projects (id, name, location, created_at, updated_at) \
             VALUES ('p4', 'proj', ?1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            rusqlite::params![foreign],
        )
        .unwrap();
        let vp = vp_with("p4", &[("device-A", &foreign)]);
        assert!(import_project(&conn, &vp, "device-B").unwrap());
        assert_eq!(row_location(&conn, "p4"), "");
    }

    #[test]
    fn import_restores_this_devices_path_on_existing_row() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::projects::ensure_schema(&conn).unwrap();
        let local = std::env::temp_dir().join(format!("owllm-vault-p5-{}", std::process::id()));
        std::fs::create_dir_all(&local).unwrap();
        let local_text = local.to_string_lossy().to_string();
        conn.execute(
            "INSERT INTO agent_projects (id, name, location, created_at, updated_at) \
             VALUES ('p5', 'proj', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        let vp = vp_with("p5", &[("device-B", &local_text)]);
        assert!(import_project(&conn, &vp, "device-B").unwrap());
        assert_eq!(row_location(&conn, "p5"), local_text);
        let _ = std::fs::remove_dir_all(local);
    }

    #[test]
    fn import_adopts_portable_repo_without_adopting_peer_path() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::projects::ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO agent_projects (id, name, location, location_device_id, repo_url, created_at, updated_at) \
             VALUES ('portable', 'proj', '', 'device-B', '', '2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z')",
            [],
        )
        .unwrap();
        let mut vp = vp_with("portable", &[("device-A", r"D:\peer\repo")]);
        vp.repo_url = "https://github.com/acme/project.git".into();
        // Older content timestamp on purpose: repo identity reconciles
        // independently and the peer's absolute folder still does not.
        vp.updated_at = "2026-02-01T00:00:00Z".into();
        assert!(import_project(&conn, &vp, "device-B").unwrap());
        let row: (String, String) = conn
            .query_row(
                "SELECT location, repo_url FROM agent_projects WHERE id = 'portable'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(row.0, "");
        assert_eq!(row.1, "https://github.com/acme/project.git");
    }

    // ---- REGRESSION: concurrent sync transactions ----

    /// Every vault channel is a read-modify-write: `reset --hard origin/<branch>`,
    /// rewrite files under state/, then commit+push. VAULT_GIT_LOCK only serialized
    /// ONE git invocation, so a second channel's reset could land between another
    /// channel's write and its commit — reverting a TRACKED file to origin's copy.
    /// `commit_push` then found nothing to commit and returned Ok, so the loss was
    /// silent. Observed live: state/signing/meta.json stayed frozen at its old
    /// content while devices/projects kept syncing, because startVaultSync fires
    /// teams/devices/signing/projects concurrently.
    ///
    /// Forces exactly that interleaving against a real local repo (no network):
    /// A takes the transaction, rewrites the tracked file, then stalls before
    /// committing; B starts mid-stall and resets. With VAULT_TXN_LOCK, B waits and
    /// A's rewrite reaches origin. Without it, origin still serves the OLD bytes.
    #[test]
    fn a_concurrent_sync_cannot_discard_another_channels_pending_write() {
        let root = std::env::temp_dir().join(format!("owllm-vault-txn-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let origin = root.join("origin.git");
        let clone = root.join("clone");
        let origin_s = origin.to_string_lossy().to_string();
        let clone_s = clone.to_string_lossy().to_string();

        run_git(&["init", "--bare", &origin_s], None).unwrap();
        run_git(&["clone", &origin_s, &clone_s], None).unwrap();
        run_git(&["config", "user.email", "test@owllm.local"], Some(&clone)).unwrap();
        run_git(&["config", "user.name", "owllm test"], Some(&clone)).unwrap();

        // The file must be TRACKED — that is what makes a stray `reset --hard`
        // destructive (it reverts committed content; untracked files survive it).
        // This mirrors state/signing/meta.json, which already existed at origin.
        let meta = clone.join("state").join("meta.json");
        std::fs::create_dir_all(meta.parent().unwrap()).unwrap();
        std::fs::write(&meta, "OLD").unwrap();
        run_git(&["add", "-A"], Some(&clone)).unwrap();
        run_git(&["commit", "-m", "seed"], Some(&clone)).unwrap();
        let branch = current_branch(&clone);
        run_git(&["push", "origin", &format!("HEAD:{branch}")], Some(&clone)).unwrap();

        // An atomic, not a channel: scoped threads borrow their captures, and
        // mpsc::Receiver is Send but not Sync.
        use std::sync::atomic::{AtomicBool, Ordering};
        let a_wrote = AtomicBool::new(false);
        std::thread::scope(|s| {
            // Channel A — the one whose write used to vanish.
            s.spawn(|| {
                let _txn = vault_txn();
                let _ = run_git(&["fetch", "origin", &branch], Some(&clone));
                let _ = run_git(
                    &["reset", "--hard", &format!("origin/{branch}")],
                    Some(&clone),
                );
                std::fs::write(&meta, "NEW").unwrap();
                a_wrote.store(true, Ordering::SeqCst);
                // Stall between write and commit — the window the bug lived in.
                std::thread::sleep(std::time::Duration::from_millis(400));
                commit_push(&clone, &branch).unwrap();
            });
            // Channel B — a different sync firing concurrently.
            s.spawn(|| {
                while !a_wrote.load(Ordering::SeqCst) {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                std::thread::sleep(std::time::Duration::from_millis(100)); // land mid-stall
                let _txn = vault_txn();
                let _ = run_git(&["fetch", "origin", &branch], Some(&clone));
                let _ = run_git(
                    &["reset", "--hard", &format!("origin/{branch}")],
                    Some(&clone),
                );
                std::fs::write(clone.join("state").join("other.json"), "B").unwrap();
                commit_push(&clone, &branch).unwrap();
            });
        });

        // Assert against ORIGIN, not the working tree: what actually got published.
        let published = run_git(&["show", &format!("{branch}:state/meta.json")], Some(&origin))
            .expect("channel A's file must exist at origin");
        assert_eq!(
            published.trim(),
            "NEW",
            "a concurrent sync's `reset --hard` discarded channel A's pending write"
        );
        let other = run_git(&["show", &format!("{branch}:state/other.json")], Some(&origin))
            .expect("channel B's file must exist at origin");
        assert_eq!(other.trim(), "B", "channel B's own write must also survive");

        let _ = std::fs::remove_dir_all(&root);
    }

    // ---- an orphaned git lock must not freeze vault sync forever ----

    /// A seeded repo plus a `.git/index.lock` aged `age_secs` into the past —
    /// the exact on-disk shape left behind when the app is killed mid-index-write.
    fn repo_with_planted_lock(tag: &str, age_secs: u64) -> (std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("owllm-vault-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo_s = root.to_string_lossy().to_string();
        run_git(&["init", &repo_s], None).unwrap();
        run_git(&["config", "user.email", "test@owllm.local"], Some(&root)).unwrap();
        run_git(&["config", "user.name", "owllm test"], Some(&root)).unwrap();
        std::fs::write(root.join("seed.txt"), "seed").unwrap();
        run_git(&["add", "-A"], Some(&root)).unwrap();
        run_git(&["commit", "-m", "seed"], Some(&root)).unwrap();

        let lock = root.join(".git").join("index.lock");
        let f = std::fs::File::create(&lock).unwrap();
        let when = std::time::SystemTime::now() - std::time::Duration::from_secs(age_secs);
        f.set_times(std::fs::FileTimes::new().set_modified(when)).unwrap();
        drop(f);
        (root, lock)
    }

    /// The breaker is process-global; keep these cases from leaking into each other.
    fn clear_breaker() {
        use std::sync::atomic::Ordering::Relaxed;
        REPO_FAILS.store(0, Relaxed);
        COOLDOWN_UNTIL.store(0, Relaxed);
    }

    /// Tests that trip, clear, or assert the process-global breaker must not
    /// interleave — cargo runs tests in parallel by default.
    static BREAKER_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn breaker_gate() -> std::sync::MutexGuard<'static, ()> {
        BREAKER_TESTS.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn an_orphaned_git_lock_self_heals_instead_of_freezing_sync_forever() {
        let _gate = breaker_gate();
        clear_breaker();
        let (repo, lock) = repo_with_planted_lock("lock-stale", STALE_LOCK_SECS + 60);

        // The wedge is real, not hypothetical: raw git refuses EVERY index
        // operation while the lock exists — `add`, `commit` and `reset --hard`
        // alike. That is what froze one device's clone 31,997 commits behind
        // origin for eleven days while device sync kept reporting success.
        let raw = run_git_once(&["add", "-A"], Some(&repo))
            .expect_err("a planted lock must make raw git fail");
        assert!(is_lock_contention(&raw), "unexpected git error: {raw}");
        assert!(
            !is_corrupt_index(&raw) && !is_broken_ref(&raw),
            "lock contention is a THIRD failure shape — the older healers must not claim it"
        );

        // The healed path recovers instead of failing forever.
        run_git(&["add", "-A"], Some(&repo)).expect("an orphaned lock must self-heal");
        assert!(!lock.exists(), "the orphaned lock must be gone");
        assert!(
            sync_cooldown_remaining().is_none(),
            "a successful heal must clear the circuit breaker"
        );

        clear_breaker();
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_lock_young_enough_to_be_live_is_never_stolen() {
        let _gate = breaker_gate();
        clear_breaker();
        // Age 0 — indistinguishable from a git process that is mid-write right
        // now. Deleting it would corrupt that writer's index, so we must not.
        let (repo, lock) = repo_with_planted_lock("lock-fresh", 0);

        let err = run_git(&["add", "-A"], Some(&repo))
            .expect_err("a live lock must still surface as a failure");
        assert!(is_lock_contention(&err), "unexpected git error: {err}");
        assert!(
            lock.exists(),
            "a lock young enough to belong to a live git process must survive"
        );

        clear_breaker();
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn only_a_lock_file_is_ever_removed() {
        // The path is taken from git's own message, so it must be validated:
        // anything that is not a `.lock` is never touched, and a message with no
        // quoted path is simply not actionable.
        assert!(lock_path_from_err("fatal: Unable to create 'C:/v/.git/index.lock': File exists.")
            .is_some());
        assert!(lock_path_from_err("error: cannot open 'C:/v/state/local.json'").is_none());
        assert!(lock_path_from_err("fatal: could not read Username").is_none());
        assert!(!repair_stale_lock("fatal: no quoted path here: File exists"));
    }

    // ---- REGRESSION: 2026-08-22 — 1,432 packs / 94.7 GB from one zeroed ref ----
    //
    // A disk-full crash zeroed `refs/heads/main`, `refs/remotes/origin/main`,
    // and the reflog's final line on a live vault. For three days every fetch
    // then re-downloaded the FULL repo (~70 MB), failed to lock the broken
    // remote ref, and kept the pack — auto-gc is off, so nothing ever cleaned
    // up. The three tests below each pin one link of that chain.

    /// A seeded origin plus a clone whose remote-tracking ref is zeroed exactly
    /// like the crash leaves it, with origin one commit ahead so a fetch MUST
    /// update the ref. Returns (root, clone, branch, sha_at_origin).
    fn clone_with_zeroed_remote_ref(
        tag: &str,
    ) -> (std::path::PathBuf, std::path::PathBuf, String, String) {
        let root = std::env::temp_dir().join(format!("owllm-vault-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let origin = root.join("origin.git");
        let a = root.join("a");
        let b = root.join("b");
        run_git(&["init", "--bare", &origin.to_string_lossy()], None).unwrap();
        run_git(
            &["clone", &origin.to_string_lossy(), &a.to_string_lossy()],
            None,
        )
        .unwrap();
        for (dir, file) in [(&a, "seed.txt"), (&b, "advance.txt")] {
            if !dir.exists() {
                run_git(
                    &["clone", &origin.to_string_lossy(), &dir.to_string_lossy()],
                    None,
                )
                .unwrap();
            }
            run_git(&["config", "user.email", "test@owllm.local"], Some(dir)).unwrap();
            run_git(&["config", "user.name", "owllm test"], Some(dir)).unwrap();
            std::fs::write(dir.join(file), file).unwrap();
            run_git(&["add", "-A"], Some(dir)).unwrap();
            run_git(&["commit", "-m", file], Some(dir)).unwrap();
            let branch = current_branch(dir);
            run_git(&["push", "origin", &format!("HEAD:{branch}")], Some(dir)).unwrap();
        }
        let branch = current_branch(&a);
        let ahead = run_git(&["rev-parse", "HEAD"], Some(&b)).unwrap().trim().to_string();
        // Plant the corruption: a loose remote-tracking ref of 41 NUL bytes
        // (loose shadows packed-refs, exactly as the crash leaves it).
        let ref_file = a
            .join(".git")
            .join("refs")
            .join("remotes")
            .join("origin")
            .join(&branch);
        std::fs::create_dir_all(ref_file.parent().unwrap()).unwrap();
        std::fs::write(&ref_file, [0u8; 41]).unwrap();
        (root, a, branch, ahead)
    }

    #[test]
    fn a_zeroed_remote_tracking_ref_heals_so_fetch_stops_redownloading_forever() {
        let _gate = breaker_gate();
        clear_breaker();
        let (root, a, branch, ahead) = clone_with_zeroed_remote_ref("remote-ref");

        // CONTROL — the wedge is real: raw git cannot update the broken ref, and
        // the error is the shape the heal ladder keys on. This is the failure
        // that ran every ~60s for three days.
        let raw = run_git_once(&["fetch", "origin", &branch], Some(&a))
            .expect_err("a zeroed remote-tracking ref must make a raw fetch fail");
        assert!(is_broken_ref(&raw), "unexpected fetch error: {raw}");

        // The healed path recovers in ONE call instead of looping forever.
        run_git(&["fetch", "origin", &branch], Some(&a))
            .expect("run_git must heal the zeroed remote ref and complete the fetch");
        let got = run_git_once(
            &["rev-parse", "--verify", &format!("refs/remotes/origin/{branch}")],
            Some(&a),
        )
        .expect("the remote-tracking ref must resolve after the heal");
        assert_eq!(got.trim(), ahead, "the healed ref must land on origin's tip");

        clear_breaker();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_nul_corrupted_reflog_tail_does_not_defeat_the_branch_ref_heal() {
        // No remote at all: the reflog must be sufficient on its own, because
        // in the live incident origin/main was zeroed too.
        let root = std::env::temp_dir().join(format!("owllm-vault-reflog-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        run_git(&["init", &root.to_string_lossy()], None).unwrap();
        run_git(&["config", "user.email", "test@owllm.local"], Some(&root)).unwrap();
        run_git(&["config", "user.name", "owllm test"], Some(&root)).unwrap();
        std::fs::write(root.join("one.txt"), "1").unwrap();
        run_git(&["add", "-A"], Some(&root)).unwrap();
        run_git(&["commit", "-m", "one"], Some(&root)).unwrap();
        std::fs::write(root.join("two.txt"), "2").unwrap();
        run_git(&["add", "-A"], Some(&root)).unwrap();
        run_git(&["commit", "-m", "two"], Some(&root)).unwrap();
        let branch = current_branch(&root);
        let tip = run_git(&["rev-parse", "HEAD"], Some(&root)).unwrap().trim().to_string();

        // The crash zeroes the ref AND appends a NUL line to its reflog. NULs
        // are not whitespace, so "last non-empty line" used to select the
        // corrupt line, find no SHA in it, and give up — deleting the ref
        // without restoring it (the branch simply vanished).
        let logp = root.join(".git").join("logs").join("refs").join("heads").join(&branch);
        let mut log = std::fs::read(&logp).unwrap();
        log.extend_from_slice(&[0u8; 82]);
        std::fs::write(&logp, log).unwrap();
        std::fs::write(
            root.join(".git").join("refs").join("heads").join(&branch),
            [0u8; 41],
        )
        .unwrap();

        repair_broken_ref(Some(&root));

        let got = run_git_once(&["rev-parse", "--verify", &format!("refs/heads/{branch}")], Some(&root))
            .expect("the branch must survive a NUL-corrupted reflog tail");
        assert_eq!(got.trim(), tip, "the heal must restore the newest VALID reflog entry");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_routine_success_does_not_reset_the_breaker_mid_outage() {
        let _gate = breaker_gate();
        clear_breaker();
        // Three corruption-shaped failures: the breaker engages…
        for _ in 0..3 {
            note_repo_health(&Err("cannot lock ref: reference broken".to_string()));
        }
        assert!(
            sync_cooldown_remaining().is_some(),
            "three corruption failures must open the breaker"
        );
        // …and a git command that succeeds WITHOUT proving a heal (config,
        // rev-parse, version — every tick is full of them) must not close it.
        // Reset-on-any-success is how the breaker sat at zero for three days
        // while the failing fetch downloaded 94.7 GB.
        run_git(&["--version"], None).expect("git --version must succeed");
        assert!(
            sync_cooldown_remaining().is_some(),
            "a routine success must NOT clear the breaker while the repo is still broken"
        );
        clear_breaker();
    }
}
