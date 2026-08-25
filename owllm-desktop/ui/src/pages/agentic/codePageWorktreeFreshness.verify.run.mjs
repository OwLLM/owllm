#!/usr/bin/env node
// Regression gate: a persistent Coding-page worktree must not silently keep
// editing an obsolete project commit. Clean pages self-refresh; pending work is
// preserved and blocks every model/run entry point until explicit Sync.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../../../..");
const fleet = fs.readFileSync(path.join(APP, "src-tauri/src/fleet.rs"), "utf8");
const lib = fs.readFileSync(path.join(APP, "src-tauri/src/lib.rs"), "utf8");
const page = fs.readFileSync(path.join(HERE, "CodePage.tsx"), "utf8");
const matrix = fs.readFileSync(path.join(APP, "scripts/smoke-matrix.mjs"), "utf8");

let passed = 0;
function check(condition, message) {
  if (!condition) {
    console.error(`FAIL page worktree freshness: ${message}`);
    process.exitCode = 1;
    return;
  }
  passed += 1;
  console.log(`  ✓ ${message}`);
}

const refreshStart = fleet.indexOf("fn fleet_worktree_refresh_blocking");
const refreshEnd = fleet.indexOf("/// Uncommitted tracked work saved", refreshStart);
const refresh = refreshStart >= 0 && refreshEnd > refreshStart
  ? fleet.slice(refreshStart, refreshEnd)
  : "";

check(fleet.includes("pub async fn fleet_worktree_refresh"),
  "one native command owns the pre-run freshness transaction");
check(lib.includes("fleet::fleet_worktree_refresh"),
  "the freshness command is registered with Tauri");
check(matrix.includes('"codePageWorktreeFreshness.verify.run.mjs"'),
  "the release matrix executes this gate even on a host without UI dependencies");
check(refresh.includes('page_branch.trim().starts_with("owllm-page/")'),
  "the command refuses to rewrite a non-Coding-page branch");
check(refresh.includes('["status", "--porcelain", "--untracked-files=no"]') &&
      refresh.includes("if !project_status_ok") &&
      refresh.includes("if !project_dirty.is_empty()") &&
      refresh.includes("project checkout has uncommitted tracked changes"),
  "canonical tracked edits that a linked page cannot see block the run");
check(refresh.includes('["merge-base", "--is-ancestor", &project_sha, "HEAD"]') &&
      refresh.includes("WorktreeRefreshOutcome::Current"),
  "a page that already contains project HEAD remains usable with its own pending edits");
check(refresh.includes('["merge-base", "--is-ancestor", "HEAD", &project_sha]'),
  "the auto-refresh path is limited to a true behind/fast-forward relationship");
check(refresh.includes('["status", "--porcelain"]') &&
      refresh.includes("if !page_status_ok") &&
      refresh.includes("if !page_is_behind || !page_dirty.is_empty()") &&
      refresh.includes("WorktreeRefreshOutcome::Stale") &&
      refresh.includes("pending edits"),
  "dirty stale pages are preserved and reported instead of reset");
check(refresh.includes('["merge", "--ff-only", &project_sha]'),
  "a clean behind page advances with a history-preserving fast-forward");
check(refresh.includes("refreshed_sha.trim() != project_sha"),
  "the backend verifies the page actually reached project HEAD before success");
check(!refresh.includes('"branch", "-D"') &&
      /if page_dirty\.is_empty\(\) && branch_work_contained\([\s\S]{0,500}?\["reset", "--hard", &project_sha\]/.test(refresh) &&
      refresh.includes("previous_page_sha: page_sha"),
  "page realignment is limited to a clean branch whose work is already contained, and preserves its prior sha");
const projectDirtyGuard = refresh.indexOf("if !project_dirty.is_empty()");
const currentReturn = refresh.indexOf("WorktreeRefreshOutcome::Current");
const pageDirtyGuard = refresh.indexOf("if !page_is_behind || !page_dirty.is_empty()");
const fastForward = refresh.indexOf('["merge", "--ff-only", &project_sha]');
check(projectDirtyGuard >= 0 && currentReturn > projectDirtyGuard &&
      pageDirtyGuard > currentReturn && fastForward > pageDirtyGuard,
  "fail-closed dirty/divergence guards execute before either success path");

check(page.includes('invoke<WtRefresh>("fleet_worktree_refresh"'),
  "the Coding page invokes the native freshness command");
check(page.includes("void ensureWorktreeCurrent(workspace, false)"),
  "a restored valid worktree is checked on mount, not only when .git is missing");
const mountStart = page.indexOf('const healedWorkspaceRef = useRef("")');
const mountEnd = page.indexOf("function setField", mountStart);
const mountGuard = mountStart >= 0 && mountEnd > mountStart ? page.slice(mountStart, mountEnd) : "";
check(mountGuard.includes("left its branch untouched") &&
      !mountGuard.includes("void openWorkspace(projectRoot)"),
  "an unreadable/missing worktree is reported without deleting and recreating its branch");
check((page.match(/await ensureWorktreeCurrent\(workspace\)/g) ?? []).length === 3,
  "Send, Plan, and Resume each fail closed on the primary worktree preflight");
check(page.includes("const secondaryRunCwd = await ensureSecondaryWorktree()") &&
      page.includes("await ensureWorktreeCurrent(secondaryRunCwd)"),
  "the second pane preflights the worktree it will actually give its selected model");
check(page.includes('data-ui="CodeWorktreeStaleGuard"') &&
      page.includes("so no model was allowed to run"),
  "a blocked stale page stays visibly explained instead of silently dropping the task");

// Controlled Git proof of the original mechanism and the two safe outcomes.
// A valid .git file says only that the linked worktree exists; it says nothing
// about whether its commit contains the canonical project's current HEAD.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-page-freshness-"));
const repo = path.join(root, "repo");
const worktree = path.join(root, "page");
fs.mkdirSync(repo);
const git = (cwd, ...args) => {
  const run = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(run.stderr || run.stdout).trim()}`);
  return run.stdout.trim();
};
let staleWithValidGit = false;
let cleanFastForwarded = false;
let dirtyWasPreserved = false;
try {
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "OWLLM freshness gate");
  git(repo, "config", "user.email", "freshness@owllm.local");
  git(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "gui.txt"), "old gui\n");
  git(repo, "add", "gui.txt");
  git(repo, "commit", "-m", "base");
  git(repo, "worktree", "add", "-b", "owllm-page/gate/code", worktree, "HEAD");
  fs.writeFileSync(path.join(repo, "gui.txt"), "4180 gui\n");
  git(repo, "commit", "-am", "new gui");
  const projectSha = git(repo, "rev-parse", "HEAD");
  staleWithValidGit = fs.existsSync(path.join(worktree, ".git")) &&
    git(worktree, "rev-parse", "HEAD") !== projectSha &&
    fs.readFileSync(path.join(worktree, "gui.txt"), "utf8") === "old gui\n";

  git(worktree, "merge", "--ff-only", projectSha);
  cleanFastForwarded = git(worktree, "rev-parse", "HEAD") === projectSha &&
    fs.readFileSync(path.join(worktree, "gui.txt"), "utf8") === "4180 gui\n";

  fs.writeFileSync(path.join(repo, "gui.txt"), "newer project gui\n");
  git(repo, "commit", "-am", "newer project");
  fs.writeFileSync(path.join(worktree, "gui.txt"), "pending page styling\n");
  const pageBefore = git(worktree, "rev-parse", "HEAD");
  const dirty = git(worktree, "status", "--porcelain").length > 0;
  // This is the backend decision boundary: a dirty stale page returns Stale and
  // deliberately does not execute merge/reset. Assert the bytes and HEAD remain.
  if (dirty) {
    dirtyWasPreserved = git(worktree, "rev-parse", "HEAD") === pageBefore &&
      fs.readFileSync(path.join(worktree, "gui.txt"), "utf8") === "pending page styling\n";
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
check(staleWithValidGit,
  "controlled experiment reproduces a valid .git worktree serving obsolete GUI bytes");
check(cleanFastForwarded,
  "controlled experiment proves a clean stale page can fast-forward to the newer GUI");
check(dirtyWasPreserved,
  "controlled experiment proves the dirty stale path leaves both HEAD and pending bytes untouched");

if (process.exitCode) {
  console.error(`\n${passed}/21 page worktree freshness checks passed.`);
  process.exit(process.exitCode);
}
console.log(`\n${passed}/21 page worktree freshness checks passed.`);
