//! Two-clone regression proof for the cross-PC sync coordinator.
//!
//! Every scenario builds a REAL bare remote plus independent clones (PC A and
//! PC B) in a temp dir and drives them through the exact `sync_repo` code the
//! app ships — no OWLLM app, no mocks. This is the suite that was missing from
//! every previous "verified" claim about the release rail: it proves work from
//! two PCs survives divergence, that real conflicts stop without losing either
//! side, and that a remote advancing mid-sync retries instead of failing.

// The app crate reads every field; the harness only Debug-formats some of
// them, which dead-code analysis ignores — silence that noise here only.
#[path = "../../src/sync_core.rs"]
#[allow(dead_code)]
mod sync_core;

use std::path::{Path, PathBuf};
use std::process::Command;
use sync_core::{sync_repo, SyncError};

fn git(dir: &Path, args: &[&str]) -> (bool, String, String) {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .unwrap_or_else(|e| panic!("git {:?} in {}: {e}", args, dir.display()));
    (
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

fn must(dir: &Path, args: &[&str]) {
    let (ok, out, err) = git(dir, args);
    assert!(ok, "git {:?} failed in {}:\n{out}\n{err}", args, dir.display());
}

fn head(dir: &Path) -> String {
    let (_, out, _) = git(dir, &["rev-parse", "HEAD"]);
    out.trim().to_string()
}

fn write(dir: &Path, rel: &str, content: &str) {
    let p = dir.join(rel);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(p, content).unwrap();
}

fn read(dir: &Path, rel: &str) -> String {
    std::fs::read_to_string(dir.join(rel)).unwrap_or_default()
}

fn commit_all(dir: &Path, msg: &str) {
    must(dir, &["add", "-A"]);
    must(dir, &["commit", "-m", msg]);
}

struct World {
    root: PathBuf,
    remote: PathBuf,
    a: PathBuf,
    b: PathBuf,
}

/// Bare remote + clone A with a pushed base commit + independent clone B.
fn world(name: &str) -> World {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "owllm-sync-harness-{}-{}-{}",
        std::process::id(),
        seq,
        name
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let remote = root.join("remote.git");
    must(&root, &["init", "--bare", "-b", "main", "remote.git"]);
    let remote_url = remote.to_string_lossy().replace('\\', "/");

    let a = root.join("pc-a");
    must(&root, &["clone", &remote_url, "pc-a"]);
    must(&a, &["config", "user.name", "PC A"]);
    must(&a, &["config", "user.email", "a@test.local"]);
    must(&a, &["checkout", "-b", "main"]);
    write(
        &a,
        "shared.txt",
        &(1..=40).map(|i| format!("line {i}\n")).collect::<String>(),
    );
    write(&a, "base.txt", "base\n");
    commit_all(&a, "base");
    must(&a, &["push", "origin", "main"]);

    let b = root.join("pc-b");
    must(&root, &["clone", &remote_url, "pc-b"]);
    must(&b, &["config", "user.name", "PC B"]);
    must(&b, &["config", "user.email", "b@test.local"]);

    World { root, remote, a, b }
}

fn remote_tip(w: &World) -> String {
    let (_, out, _) = git(&w.remote, &["rev-parse", "refs/heads/main"]);
    out.trim().to_string()
}

fn edit_line(dir: &Path, line_no: usize, new_line: &str) {
    let content = read(dir, "shared.txt");
    let updated: String = content
        .lines()
        .enumerate()
        .map(|(i, l)| {
            if i + 1 == line_no {
                format!("{new_line}\n")
            } else {
                format!("{l}\n")
            }
        })
        .collect();
    write(dir, "shared.txt", &updated);
}

type Scenario = fn() -> Result<(), String>;

fn check(cond: bool, msg: &str) -> Result<(), String> {
    if cond {
        Ok(())
    } else {
        Err(msg.to_string())
    }
}

/// PC A and PC B change DIFFERENT FILES while both advance main → both survive.
fn different_files_both_survive() -> Result<(), String> {
    let w = world("diff-files");
    write(&w.a, "from-a.txt", "made on A\n");
    commit_all(&w.a, "A adds file");
    let ra = sync_repo(&w.a, "main", None).map_err(|e| format!("A sync: {e:?}"))?;
    check(ra.action == "pushed", &format!("A should push, got {}", ra.action))?;

    write(&w.b, "from-b.txt", "made on B\n");
    commit_all(&w.b, "B adds file"); // based on the OLD tip → diverged
    let rb = sync_repo(&w.b, "main", None).map_err(|e| format!("B sync: {e:?}"))?;
    check(rb.action == "integrated", &format!("B should integrate, got {}", rb.action))?;

    check(read(&w.b, "from-a.txt").contains("made on A"), "B lost A's file")?;
    check(read(&w.b, "from-b.txt").contains("made on B"), "B lost its own file")?;
    check(remote_tip(&w) == head(&w.b), "remote main != B's integrated head")?;

    // A syncs after B: pure fast-forward, ends with both files.
    let ra2 = sync_repo(&w.a, "main", None).map_err(|e| format!("A resync: {e:?}"))?;
    check(ra2.action == "fast-forwarded", &format!("A should fast-forward, got {}", ra2.action))?;
    check(read(&w.a, "from-b.txt").contains("made on B"), "A lost B's file")?;
    let _ = std::fs::remove_dir_all(&w.root);
    Ok(())
}

/// Both PCs edit the SAME FILE on different lines → Git merges both edits.
fn same_file_different_lines_both_survive() -> Result<(), String> {
    let w = world("same-file");
    edit_line(&w.a, 5, "line 5 CHANGED BY A");
    commit_all(&w.a, "A edits line 5");
    sync_repo(&w.a, "main", None).map_err(|e| format!("A sync: {e:?}"))?;

    edit_line(&w.b, 35, "line 35 CHANGED BY B");
    commit_all(&w.b, "B edits line 35");
    let rb = sync_repo(&w.b, "main", None).map_err(|e| format!("B sync: {e:?}"))?;
    check(rb.action == "integrated", &format!("expected integrate, got {}", rb.action))?;

    let merged = read(&w.b, "shared.txt");
    check(merged.contains("CHANGED BY A"), "merge lost A's line-5 edit")?;
    check(merged.contains("CHANGED BY B"), "merge lost B's line-35 edit")?;
    check(remote_tip(&w) == head(&w.b), "remote doesn't have the integrated commit")?;
    let _ = std::fs::remove_dir_all(&w.root);
    Ok(())
}

/// Both PCs edit the SAME LINES → sync STOPS; neither side is lost or chosen.
fn same_lines_conflict_preserves_both() -> Result<(), String> {
    let w = world("conflict");
    edit_line(&w.a, 10, "line 10 A VERSION");
    commit_all(&w.a, "A edits line 10");
    sync_repo(&w.a, "main", None).map_err(|e| format!("A sync: {e:?}"))?;
    let remote_before = remote_tip(&w);

    edit_line(&w.b, 10, "line 10 B VERSION");
    commit_all(&w.b, "B edits line 10");
    let b_head_before = head(&w.b);
    match sync_repo(&w.b, "main", None) {
        Err(SyncError::Conflict {
            files,
            recovery_ref,
        }) => {
            check(
                files.iter().any(|f| f.contains("shared.txt")),
                &format!("conflict should name shared.txt, got {files:?}"),
            )?;
            check(head(&w.b) == b_head_before, "B's local commit moved — it must stay untouched")?;
            check(remote_tip(&w) == remote_before, "origin moved — a conflict must not push")?;
            let (rr_ok, rr_sha, _) = git(&w.b, &["rev-parse", "--verify", &recovery_ref]);
            check(rr_ok, "recovery ref was not created")?;
            check(rr_sha.trim() == b_head_before, "recovery ref doesn't point at B's commit")?;
            check(
                read(&w.b, "shared.txt").contains("line 10 B VERSION"),
                "B's working file was altered by a failed sync",
            )?;
        }
        other => return Err(format!("expected Conflict, got {other:?}")),
    }
    let _ = std::fs::remove_dir_all(&w.root);
    Ok(())
}

/// Remote advances WHILE B is integrating (injected via the verify hook, which
/// runs between merge and push) → the coordinator refetches and retries; every
/// commit from both PCs survives. No force-push at any point.
fn remote_advances_mid_sync_retries() -> Result<(), String> {
    let w = world("midsync");
    write(&w.b, "from-b.txt", "made on B\n");
    commit_all(&w.b, "B adds file");
    // A pushes one commit ahead of B before B syncs → B is diverged.
    write(&w.a, "from-a.txt", "made on A\n");
    commit_all(&w.a, "A adds file");
    must(&w.a, &["push", "origin", "main"]);

    // Injection script: the FIRST verify invocation pushes another commit from
    // A (simulating a second PC racing us mid-transaction); later runs no-op.
    let a_path = w.a.to_string_lossy().replace('\\', "/");
    let marker = w.root.join("injected.marker");
    let marker_path = marker.to_string_lossy().replace('\\', "/");
    let verify_cmd = if cfg!(windows) {
        let script = w.root.join("inject.cmd");
        std::fs::write(
            &script,
            format!(
                "@echo off\r\nif exist \"{m}\" exit /b 0\r\necho x > \"{m}\"\r\n\
                 git -C \"{a}\" commit --allow-empty -m midsync-race\r\n\
                 git -C \"{a}\" push origin main\r\nexit /b 0\r\n",
                m = marker_path,
                a = a_path
            ),
        )
        .unwrap();
        script.to_string_lossy().to_string()
    } else {
        let script = w.root.join("inject.sh");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nif [ -f \"{m}\" ]; then exit 0; fi\ntouch \"{m}\"\n\
                 git -C \"{a}\" commit --allow-empty -m midsync-race\n\
                 git -C \"{a}\" push origin main\nexit 0\n",
                m = marker_path,
                a = a_path
            ),
        )
        .unwrap();
        format!("sh \"{}\"", script.to_string_lossy())
    };

    let rb = sync_repo(&w.b, "main", Some(&verify_cmd)).map_err(|e| format!("B sync: {e:?}"))?;
    check(rb.action == "integrated", &format!("expected integrate, got {}", rb.action))?;
    check(marker.exists(), "the mid-sync race was never injected — scenario is vacuous")?;
    // Everything survived: A's file, B's file, and the racing commit.
    check(read(&w.b, "from-a.txt").contains("made on A"), "lost A's pre-sync commit")?;
    check(read(&w.b, "from-b.txt").contains("made on B"), "lost B's commit")?;
    let (_, log, _) = git(&w.b, &["log", "--format=%s", "origin/main"]);
    check(log.contains("midsync-race"), "lost the commit pushed during the sync")?;
    check(log.contains("B adds file"), "remote history lost B's commit")?;
    check(remote_tip(&w) == head(&w.b), "B's checkout didn't land on the pushed result")?;
    let _ = std::fs::remove_dir_all(&w.root);
    Ok(())
}

/// Uncommitted local edits are NEVER touched by a sync — including a diverged
/// integration. The dirty file stays byte-identical; nothing stages or commits it.
fn dirty_files_untouched() -> Result<(), String> {
    let w = world("dirty");
    write(&w.a, "from-a.txt", "made on A\n");
    commit_all(&w.a, "A adds file");
    must(&w.a, &["push", "origin", "main"]);

    write(&w.b, "from-b.txt", "made on B\n");
    commit_all(&w.b, "B adds file"); // diverged
    write(&w.b, "wip-uncommitted.txt", "precious WIP — do not lose\n");
    edit_line(&w.b, 20, "line 20 dirty uncommitted edit");

    let rb = sync_repo(&w.b, "main", None).map_err(|e| format!("B sync: {e:?}"))?;
    check(rb.action == "integrated", &format!("expected integrate, got {}", rb.action))?;
    check(
        read(&w.b, "wip-uncommitted.txt").contains("precious WIP"),
        "untracked WIP file was lost",
    )?;
    check(
        read(&w.b, "shared.txt").contains("line 20 dirty uncommitted edit"),
        "dirty tracked edit was lost",
    )?;
    let (_, staged, _) = git(&w.b, &["diff", "--cached", "--name-only"]);
    check(staged.trim().is_empty(), "sync staged the user's dirty files")?;
    let _ = std::fs::remove_dir_all(&w.root);
    Ok(())
}

/// A failing verify command WITHHOLDS the push — origin must not move.
fn verify_failure_blocks_push() -> Result<(), String> {
    let w = world("verify-fail");
    write(&w.a, "from-a.txt", "made on A\n");
    commit_all(&w.a, "A adds file");
    must(&w.a, &["push", "origin", "main"]);
    let remote_before = remote_tip(&w);

    write(&w.b, "from-b.txt", "made on B\n");
    commit_all(&w.b, "B adds file");
    let fail_cmd = if cfg!(windows) { "exit /b 1" } else { "false" };
    match sync_repo(&w.b, "main", Some(fail_cmd)) {
        Err(SyncError::VerifyFailed { .. }) => {}
        other => return Err(format!("expected VerifyFailed, got {other:?}")),
    }
    check(remote_tip(&w) == remote_before, "verify failed but the push happened anyway")?;
    let _ = std::fs::remove_dir_all(&w.root);
    Ok(())
}

/// Behind-only and up-to-date are quiet no-surprise paths.
fn behind_and_up_to_date() -> Result<(), String> {
    let w = world("behind");
    write(&w.a, "from-a.txt", "made on A\n");
    commit_all(&w.a, "A adds file");
    must(&w.a, &["push", "origin", "main"]);

    let rb = sync_repo(&w.b, "main", None).map_err(|e| format!("B sync: {e:?}"))?;
    check(rb.action == "fast-forwarded", &format!("expected fast-forward, got {}", rb.action))?;
    check(read(&w.b, "from-a.txt").contains("made on A"), "fast-forward didn't materialize")?;

    let rb2 = sync_repo(&w.b, "main", None).map_err(|e| format!("B resync: {e:?}"))?;
    check(rb2.action == "up-to-date", &format!("expected up-to-date, got {}", rb2.action))?;
    let _ = std::fs::remove_dir_all(&w.root);
    Ok(())
}

/// Disposable app runtime files auto-resolve during integration; they must not
/// surface as a user conflict, and real files still merge.
fn runtime_files_auto_resolve() -> Result<(), String> {
    let w = world("runtime");
    write(&w.a, ".owllm/brainstorm.json", "{\"from\":\"A\"}\n");
    commit_all(&w.a, "A runtime state");
    must(&w.a, &["push", "origin", "main"]);

    write(&w.b, ".owllm/brainstorm.json", "{\"from\":\"B\"}\n");
    write(&w.b, "from-b.txt", "made on B\n");
    commit_all(&w.b, "B runtime + real work");
    let rb = sync_repo(&w.b, "main", None).map_err(|e| format!("B sync: {e:?}"))?;
    check(rb.action == "integrated", &format!("expected integrate, got {}", rb.action))?;
    check(read(&w.b, "from-b.txt").contains("made on B"), "real work lost")?;
    let _ = std::fs::remove_dir_all(&w.root);
    Ok(())
}

fn main() {
    let scenarios: &[(&str, Scenario)] = &[
        ("different files from two PCs both survive", different_files_both_survive),
        ("same file, different lines: both edits survive", same_file_different_lines_both_survive),
        ("same lines: conflict stops, both sides preserved", same_lines_conflict_preserves_both),
        ("remote advances mid-sync: retry integrates everything", remote_advances_mid_sync_retries),
        ("uncommitted local files are never touched", dirty_files_untouched),
        ("failing verify withholds the push", verify_failure_blocks_push),
        ("behind fast-forwards; synced is up-to-date", behind_and_up_to_date),
        ("disposable runtime files auto-resolve", runtime_files_auto_resolve),
    ];
    let mut failed = 0;
    for (name, f) in scenarios {
        match std::panic::catch_unwind(f) {
            Ok(Ok(())) => println!("PASS  {name}"),
            Ok(Err(msg)) => {
                failed += 1;
                println!("FAIL  {name}\n      {msg}");
            }
            Err(_) => {
                failed += 1;
                println!("FAIL  {name}\n      (panicked — see stderr)");
            }
        }
    }
    println!(
        "\nsync-harness: {} passed · {} failed",
        scenarios.len() - failed,
        failed
    );
    if failed > 0 {
        std::process::exit(1);
    }
}
