#!/usr/bin/env node
// Regression gate for the isolated Code-page release rail.
//
// An isolated page used to expose two independent operations:
//   Merge worktree -> project, then Push project -> origin.
// That left a race between the operations and never refreshed the page
// worktree from the synchronized canonical checkout. The product contract is
// now one backend-owned transaction and one user-facing Sync action.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../../../..");
const fleet = fs.readFileSync(path.join(APP, "src-tauri/src/fleet.rs"), "utf8");
const lib = fs.readFileSync(path.join(APP, "src-tauri/src/lib.rs"), "utf8");
const cards = fs.readFileSync(path.join(HERE, "PublishCards.tsx"), "utf8");

let passed = 0;
function check(condition, message) {
  if (!condition) {
    console.error(`FAIL isolated worktree Sync: ${message}`);
    process.exitCode = 1;
    return;
  }
  passed += 1;
  console.log(`  ✓ ${message}`);
}

check(fleet.includes("pub async fn fleet_worktree_sync"),
  "one backend command owns the isolated Sync transaction");
check(lib.includes("fleet::fleet_worktree_sync"),
  "the isolated Sync command is registered with Tauri");
check((fleet.match(/#\[serde\(rename = "projectSha"\)\]/g) ?? []).length === 2 &&
      fleet.includes('#[serde(rename = "pageSha")]'),
  "the native result serializes commit fields with the camelCase names consumed by the UI");

const syncStart = fleet.indexOf("pub async fn fleet_worktree_sync");
const syncBody = syncStart >= 0 ? fleet.slice(syncStart, syncStart + 7000) : "";
check(syncBody.includes("fleet_worktree_finalize_blocking"),
  "Sync commits pending page work before integration");
check(syncBody.includes("repo_git_lock(&project)"),
  "Sync serializes the canonical repository transaction");
check(syncBody.includes("fleet_worktree_merge_locked"),
  "local integration runs while the canonical lock is held");
check(syncBody.includes("sync_core::sync_repo"),
  "remote reconciliation reuses the proven cross-PC coordinator");
const firstReconcile = syncBody.indexOf("sync_core::sync_repo");
const localIntegration = syncBody.indexOf("fleet_worktree_merge_locked");
check(firstReconcile >= 0 && firstReconcile < localIntegration,
  "canonical history is reconciled before the page branch is squash-merged");
check(syncBody.includes("bridge_equivalent_page_history") &&
      fleet.includes('local_tree.trim() != page_tree.trim()') &&
      fleet.includes('["merge-base", "--is-ancestor", &remote_ref, branch]'),
  "the old stale-squash state is repaired only for identical trees whose page contains origin");
check(syncBody.includes("remote get-url origin") || syncBody.includes('["remote", "get-url", "origin"]'),
  "repositories without origin are detected rather than rejected");
check(syncBody.includes('git(&worktree, &["reset", "--hard", &project_sha])'),
  "the page worktree refreshes from the synchronized canonical commit");
check(syncBody.includes('page_sha.trim() != project_sha'),
  "Sync verifies that page and canonical HEAD agree before reporting success");

const mergeStart = cards.indexOf("const doMerge");
const publishStart = cards.indexOf("const signPayload");
const isolatedAction = mergeStart >= 0 && publishStart > mergeStart
  ? cards.slice(mergeStart, publishStart)
  : "";
check(isolatedAction.includes('invoke<WtSync>("fleet_worktree_sync"'),
  "the isolated rail calls the single backend Sync command");
check(isolatedAction.includes('typeof sync.projectSha !== "string"'),
  "the UI reports a malformed native result instead of crashing while formatting it");
check(!isolatedAction.includes('"fleet_worktree_finalize"') &&
      !isolatedAction.includes('"fleet_worktree_merge"'),
  "the UI cannot split isolated commit and merge into separate IPC operations");
check(cards.includes("const showPush = isRepo && !isolated && hasRemote"),
  "isolated pages no longer expose a second Push action");
check(cards.includes('{loading ? "⏳" : "⇅"} Sync'),
  "isolated and direct pages present the same Sync action");

// Real Git mechanism proof. The old order silently loses an intentional
// revert when a page already contains an origin commit: squash(base -> page)
// cannot represent remote -> base, so the later merge resurrects the remote
// version. Starting the squash from remote preserves that revert.
const experimentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-sync-order-"));
const git = (...args) => {
  const run = spawnSync("git", ["-C", experimentRoot, ...args], { encoding: "utf8" });
  if (run.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(run.stderr || run.stdout || "").trim()}`);
  }
  return (run.stdout || "").trim();
};
const shared = path.join(experimentRoot, "terminal.txt");
let oldOrderLostRevert = false;
let fixedOrderPreservedBoth = false;
try {
  git("init", "-b", "main");
  git("config", "user.name", "OWLLM regression");
  git("config", "user.email", "regression@owllm.local");
  fs.writeFileSync(shared, "terminal input only\n");
  git("add", "terminal.txt");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");

  git("checkout", "-b", "remote");
  fs.writeFileSync(shared, "duplicate auth box\n");
  git("commit", "-am", "remote adds duplicate input");
  const remote = git("rev-parse", "HEAD");

  git("checkout", "-b", "page");
  fs.writeFileSync(shared, "terminal input only\n");
  fs.writeFileSync(path.join(experimentRoot, "credential-fix.txt"), "save before navigation\n");
  git("add", "terminal.txt", "credential-fix.txt");
  git("commit", "-m", "page restores terminal and fixes vault");
  const page = git("rev-parse", "HEAD");

  git("checkout", "-b", "old-order", base);
  git("merge", "--squash", "--no-commit", page);
  git("commit", "-m", "old order squash");
  const staleSquash = git("rev-parse", "HEAD");
  git("merge", "--no-edit", remote);
  oldOrderLostRevert = fs.readFileSync(shared, "utf8").includes("duplicate auth box");

  git("checkout", "-b", "recovered-order", staleSquash);
  git("merge", "--no-ff", "--no-edit", "--strategy=ours", page);
  const recoveredTreeMatches = git("rev-parse", "HEAD^{tree}") === git("rev-parse", `${page}^{tree}`);
  const recoveredContainsRemote = spawnSync(
    "git", ["-C", experimentRoot, "merge-base", "--is-ancestor", remote, "HEAD"]
  ).status === 0;

  git("checkout", "-b", "fixed-order", remote);
  git("merge", "--squash", "--no-commit", page);
  git("commit", "-m", "fixed order squash");
  fixedOrderPreservedBoth = recoveredTreeMatches && recoveredContainsRemote &&
    fs.readFileSync(shared, "utf8").includes("terminal input only") &&
    fs.readFileSync(path.join(experimentRoot, "credential-fix.txt"), "utf8").includes("save before navigation");
} finally {
  fs.rmSync(experimentRoot, { recursive: true, force: true });
}
check(oldOrderLostRevert && fixedOrderPreservedBoth,
  "controlled Git experiment reproduces old revert loss and proves reconcile-first preserves both changes");

if (process.exitCode) {
  console.error(`\n${passed}/18 isolated worktree Sync checks passed.`);
  process.exit(process.exitCode);
}
console.log(`\n${passed}/18 isolated worktree Sync checks passed.`);
