#!/usr/bin/env node
// Permanent regression gate for Code-page and Agentic fleet merges. Long-lived
// worktrees routinely overlap a newer main branch; Merge must preserve both
// non-overlapping work and deterministically retain the page inside conflicts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../../../..");
const fleet = fs.readFileSync(path.join(APP, "src-tauri/src/fleet.rs"), "utf8");

function fail(message) {
  console.error(`FAIL fleet merge policy: ${message}`);
  process.exit(1);
}

if (!/["']-X["']\s*,\s*["']theirs["']/.test(fleet)) {
  fail("squash merge no longer prefers the isolated page for overlapping hunks");
}
if (!fleet.includes("fn resolve_user_conflicts_from_branch") ||
    !fleet.includes('["checkout", branch, "--", path]') ||
    !fleet.includes('["rm", "-f", "--ignore-unmatch", "--", path]')) {
  fail("rename/delete/binary conflict fallback is missing");
}
if (!fleet.includes("text_conflict_keeps_page_hunk_and_nonoverlapping_main_edit") ||
    !fleet.includes("page_delete_wins_over_main_modify")) {
  fail("merge-policy unit coverage is missing");
}
if (!fleet.includes("let _merge_guard = lock.lock()") || !fleet.includes("fn repo_git_lock")) {
  fail("same-repository merges are not serialized against index races");
}
if (!fleet.includes("fn prepare_identical_untracked_collisions") ||
    !fleet.includes('["hash-object", "--", path]') ||
    !fleet.includes("branch_blob.trim() == disk_blob.trim()") ||
    !fleet.includes("backup.discard()")) {
  fail("identical untracked branch additions are not safely adopted before merge");
}
if (!fleet.includes("contents differ from the page branch") ||
    !fleet.includes("differing_untracked_branch_addition_is_preserved_and_blocks_merge") ||
    !fleet.includes("identical_untracked_branch_addition_is_adopted_by_merge")) {
  fail("untracked collision safety or regression coverage is missing");
}
if (!fleet.includes("fn prepare_identical_tracked_collisions") ||
    !fleet.includes("IdenticalTrackedBackup") ||
    !fleet.includes("identical_tracked_local_edits_are_adopted_by_merge") ||
    !fleet.includes("differing_tracked_local_edits_are_preserved_and_block_merge")) {
  fail("tracked local edit collision safety or regression coverage is missing");
}
if (!fleet.includes('["diff", "--cached", "--name-only"]') ||
    !fleet.includes("scratch_only_finalize_returns_no_changes") ||
    !fleet.includes("git_failure_message_uses_stdout_when_stderr_is_empty")) {
  fail("worktree finalize can still treat unstaged OWLLM scratch as a committable change or return blank commit diagnostics");
}
if (!fleet.includes('p == ".owllm/brainstorm.json"') ||
    !fleet.includes('!is_app_scratch(".owllm/project.json")') ||
    !fleet.includes('!is_app_scratch(".owllm/verify.json")')) {
  fail("runtime cleanup can still hide durable .owllm project metadata from commits");
}

const gitSource = fs.readFileSync(path.join(APP, "src-tauri/src/git.rs"), "utf8");
const publishCards = fs.readFileSync(path.join(APP, "ui/src/pages/agentic/PublishCards.tsx"), "utf8");
if (!gitSource.includes("pub nuisance_files: Vec<String>") ||
    !gitSource.includes("crate::fleet::is_app_scratch(path)") ||
    !gitSource.includes("status_reports_tracked_runtime_but_keeps_project_card_committable") ||
    !publishCards.includes("Use Fix with agent to safely de-track them") ||
    !publishCards.includes("Do not delete or ignore durable project data")) {
  fail("tracked runtime files are not surfaced through the constrained Fix-with-agent cleanup path");
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-merge-policy-"));
const git = (...args) => execFileSync("git", args, { cwd: tmp, stdio: "pipe" });
try {
  git("init", "-b", "main");
  git("config", "user.email", "merge-gate@owllm.local");
  git("config", "user.name", "OwLLM Merge Gate");
  git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(tmp, "feature.txt"),
    "header base\nkeep one\nkeep two\nkeep three\nshared base\nfooter\n");
  git("add", "feature.txt");
  git("commit", "-m", "base");
  git("checkout", "-b", "page");
  fs.writeFileSync(path.join(tmp, "feature.txt"),
    "header base\nkeep one\nkeep two\nkeep three\nshared page\nfooter\n");
  git("commit", "-am", "page edit");
  git("checkout", "main");
  fs.writeFileSync(path.join(tmp, "feature.txt"),
    "header main\nkeep one\nkeep two\nkeep three\nshared main\nfooter\n");
  git("commit", "-am", "main edits");
  git("merge", "--squash", "--no-commit", "-X", "theirs", "page");

  const actual = fs.readFileSync(path.join(tmp, "feature.txt"), "utf8").replace(/\r\n/g, "\n");
  const expected = "header main\nkeep one\nkeep two\nkeep three\nshared page\nfooter\n";
  if (actual !== expected) fail(`unexpected merged content: ${JSON.stringify(actual)}`);
  if (git("diff", "--name-only", "--diff-filter=U").toString().trim()) {
    fail("text merge left unresolved paths");
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("PASS fleet merges preserve main and prefer isolated page conflicts");
