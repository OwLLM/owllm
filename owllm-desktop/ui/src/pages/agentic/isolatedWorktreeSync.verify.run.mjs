#!/usr/bin/env node
// Regression gate for the isolated Code-page release rail.
//
// An isolated page used to expose two independent operations:
//   Merge worktree -> project, then Push project -> origin.
// That left a race between the operations and never refreshed the page
// worktree from the synchronized canonical checkout. The product contract is
// now one backend-owned transaction and one user-facing Sync action.

import fs from "node:fs";
import path from "node:path";
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

if (process.exitCode) {
  console.error(`\n${passed}/15 isolated worktree Sync checks passed.`);
  process.exit(process.exitCode);
}
console.log(`\n${passed}/15 isolated worktree Sync checks passed.`);
