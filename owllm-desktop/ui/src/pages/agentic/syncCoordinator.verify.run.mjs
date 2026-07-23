#!/usr/bin/env node
// Regression gate for the cross-PC sync coordinator (the 2026-07-22 release-rail
// root fix). Two layers:
//   default  — static source anchors: the transaction exists, is generic, never
//              force-pushes, never auto-picks a side, and the UI routes through it.
//   --live   — compiles and runs the standalone two-clone harness: a REAL bare
//              remote + two clones driven through every divergence/conflict
//              scenario using the exact sync_core.rs the app ships.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../../../..");

function fail(message) {
  console.error(`FAIL sync coordinator: ${message}`);
  process.exit(1);
}

const syncCore = fs.readFileSync(path.join(APP, "src-tauri/src/sync_core.rs"), "utf8");
const release = fs.readFileSync(path.join(APP, "src-tauri/src/release.rs"), "utf8");
const lib = fs.readFileSync(path.join(APP, "src-tauri/src/lib.rs"), "utf8");
const cards = fs.readFileSync(path.join(APP, "ui/src/pages/agentic/PublishCards.tsx"), "utf8");
const harnessMain = path.join(APP, "src-tauri/sync-harness/src/main.rs");

// --- The transaction itself -------------------------------------------------
if (!syncCore.includes("pub fn sync_repo")) fail("sync_core::sync_repo is missing");
if (!syncCore.includes("refs/owllm/recovery/")) {
  fail("recovery refs are no longer created before integration");
}
if (/["']-X["']/.test(syncCore) || syncCore.includes("theirs\".into()")) {
  fail("sync_core must use a plain three-way merge — no -X side preference");
}
if (!syncCore.includes('"--no-ff".into()')) {
  fail("the integration merge is no longer an explicit merge commit");
}
// Local `worktree remove --force` cleanup is fine; a force on any PUSH is not.
for (const line of syncCore.split("\n")) {
  if (line.includes('"push"') && /--force|force-with-lease|"\+/.test(line)) {
    fail(`sync_core force-pushes — it must NEVER rewrite remote history: ${line.trim()}`);
  }
}
if (!syncCore.includes("fn is_remote_moved_rejection") || !syncCore.includes("MAX_PUSH_ATTEMPTS")) {
  fail("the moved-remote retry loop is missing");
}
if (!syncCore.includes("struct TempWorktree") || !syncCore.includes("impl Drop for TempWorktree")) {
  fail("integration no longer happens on a self-cleaning temporary worktree");
}
if (!syncCore.includes("SyncError::Conflict") || !syncCore.includes("recovery_ref")) {
  fail("real conflicts no longer stop with a recovery ref and both sides preserved");
}
if (!syncCore.includes("fn is_disposable_runtime_path") ||
    syncCore.includes('".owllm/project.json"')) {
  fail("runtime-file auto-resolve is missing or has grown beyond disposable app files");
}
if (!syncCore.includes("run_verify(&wt.path, cmd)?")) {
  fail("the verify hook no longer runs on the INTEGRATED commit before push");
}

// --- Command wiring: every rail path reaches the same transaction ------------
if (!release.includes("pub async fn repo_sync") || !release.includes("fn sync_blocking")) {
  fail("the repo_sync command is missing from release.rs");
}
const pushBody = release.slice(release.indexOf("pub async fn repo_push"), release.indexOf("pub async fn repo_merge"));
if (!pushBody.includes("sync_blocking")) {
  fail("repo_push no longer delegates to the sync transaction — diverged pushes will dead-end again");
}
const mergeBody = release.slice(release.indexOf("pub async fn repo_merge"));
if (!mergeBody.slice(0, 600).includes("sync_blocking")) {
  fail("repo_merge no longer delegates to the sync transaction");
}
if (!release.includes("Nothing was lost")) {
  fail("conflict messaging no longer states that both sides are preserved");
}
if (!lib.includes("release::repo_sync")) fail("repo_sync is not registered in the invoke handler");
if (!lib.includes("mod sync_core;")) fail("sync_core module is not compiled into the app");

// --- UI rail ------------------------------------------------------------------
if (!cards.includes('invoke<string>("repo_sync"')) {
  fail("the non-isolated Merge action no longer calls repo_sync");
}
if (!cards.includes('await invoke("repo_sync", { repoDir, target: "main" })')) {
  fail("Publish no longer synchronizes before the long build");
}

// --- The two-clone proof exists and covers the load-bearing scenarios ---------
if (!fs.existsSync(harnessMain)) fail("the standalone two-clone harness is missing");
const harness = fs.readFileSync(harnessMain, "utf8");
for (const scenario of [
  "different_files_both_survive",
  "same_file_different_lines_both_survive",
  "same_lines_conflict_preserves_both",
  "remote_advances_mid_sync_retries",
  "dirty_files_untouched",
  "verify_failure_blocks_push",
  "behind_and_up_to_date",
  "runtime_files_auto_resolve",
]) {
  if (!harness.includes(`fn ${scenario}`)) fail(`harness scenario missing: ${scenario}`);
}
if (!harness.includes('#[path = "../../src/sync_core.rs"]')) {
  fail("the harness no longer tests the exact sync_core.rs the app ships");
}

if (process.argv.includes("--live")) {
  const manifest = path.join(APP, "src-tauri/sync-harness/Cargo.toml");
  const run = spawnSync("cargo", ["run", "--quiet", "--manifest-path", manifest], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (run.status !== 0) fail("live two-clone harness reported failures");
  console.log("PASS sync coordinator (static + live two-clone harness)");
} else {
  console.log("PASS sync coordinator source contract (run with --live for the two-clone harness)");
}
