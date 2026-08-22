#!/usr/bin/env node
// Permanent regression gate for Code-page and Agentic fleet merges. Plain
// three-way merging must preserve both sides' non-overlapping work, and a REAL
// overlapping edit must STOP with both sides preserved — never silently prefer
// one side (`-X theirs` is how integrated work got dropped: SmartImage ×3, the
// v0.9.24 seven-file drop).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../../../..");
const fleet = fs.readFileSync(path.join(APP, "src-tauri/src/fleet.rs"), "utf8");
const wsl = fs.readFileSync(path.join(APP, "src-tauri/src/wsl.rs"), "utf8");

function fail(message) {
  console.error(`FAIL fleet merge policy: ${message}`);
  process.exit(1);
}

if (/["']-X["']\s*,\s*["']theirs["']/.test(fleet)) {
  fail("-X theirs is back — overlapping hunks would silently drop one side again");
}
if (fleet.includes("fn resolve_user_conflicts_from_branch")) {
  fail("the whole-file conflict fallback is back — it can discard valid main changes");
}
if (!fleet.includes("return Ok(MergeOutcome::Conflict { files });")) {
  fail("real source conflicts no longer stop the merge with both sides preserved");
}
if (!fleet.includes("overlapping_text_edits_stop_with_both_sides_preserved") ||
    !fleet.includes("modify_delete_overlap_stops_with_both_sides_preserved") ||
    !fleet.includes("mixed_merge_conflict_resolves_scratch_but_stops_on_source_overlap")) {
  fail("merge-policy unit coverage is missing");
}
if (!fleet.includes("let _merge_guard = lock.lock()") || !fleet.includes("fn repo_git_lock")) {
  fail("same-repository merges are not serialized against index races");
}
if (!fleet.includes("fn prepare_untracked_collisions") ||
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
if (!fleet.includes("preserve_after_merge") ||
    !fleet.includes("backup.restore_preserved()") ||
    !fleet.includes("differing_untracked_app_state_is_preserved_and_does_not_block_merge")) {
  fail("differing app-owned state is not preserved across worktree merges");
}
// Both collision classifiers read `git diff --name-only -z`, so the decoder
// that git output passes through must keep NUL separators. `decode_wsl` used to
// strip every null byte (to recover wsl.exe's UTF-16LE error text): the two
// paths arrived concatenated, `split('\0')` yielded one pseudo-path that
// matched nothing, and BOTH classifiers saw zero collisions — so a merge over
// local edits aborted with git's raw "your local changes would be overwritten"
// instead of adopting identical ones or naming the differing ones.
if (!wsl.includes("fn looks_like_utf16le") ||
    !/if looks_like_utf16le\(body\)/.test(wsl) ||
    !wsl.includes("decode_preserves_nul_separated_git_output") ||
    !wsl.includes("decode_recovers_utf16le_wsl_errors")) {
  fail("decode_wsl no longer distinguishes UTF-16LE from NUL-separated git output — `-z` separators would be eaten and every tracked/untracked collision would be missed");
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
    !gitSource.includes("fn is_tracked_runtime_path") ||
    !gitSource.includes("status_reports_tracked_runtime_but_keeps_project_card_committable") ||
    !gitSource.includes("git_untrack_runtime_files") ||
    !publishCards.includes("Clean tracked runtime") ||
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

  // Plain three-way squash: the overlapping "shared" hunk must CONFLICT (both
  // versions present in the markers), never auto-pick a side. Non-overlapping
  // edits still land.
  let merged = true;
  try { git("merge", "--squash", "--no-commit", "page"); } catch { merged = false; }
  if (merged) fail("overlapping same-hunk edits merged cleanly — the conflict contract is gone");
  const unresolved = git("diff", "--name-only", "--diff-filter=U").toString().trim();
  if (unresolved !== "feature.txt") fail(`expected feature.txt unresolved, got: ${unresolved}`);
  const actual = fs.readFileSync(path.join(tmp, "feature.txt"), "utf8").replace(/\r\n/g, "\n");
  if (!actual.includes("shared main") || !actual.includes("shared page")) {
    fail(`conflict markers must carry BOTH sides, got: ${JSON.stringify(actual)}`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("PASS fleet merges use plain three-way merging and stop on real conflicts with both sides preserved");
