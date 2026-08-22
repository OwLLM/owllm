#!/usr/bin/env node
// Permanent regression gate for the fleet worktree WORK-LOSS bug.
//
// The Website-Red-Hair team run (2026-08-13) lost FOUR complete site builds:
// CLI agents committed their own work in per-run worktrees, finalize then
// (correctly) reported noChanges, the merge phase skipped every non-"committed"
// finalize, and cleanup ran `git branch -D` on branches whose commits master
// never received. Each next run branched from the still-empty master, declared
// the repo greenfield, and rebuilt a different stack from scratch.
//
// Contract pinned here:
//   1. fleet_worktree_remove NEVER deletes a branch whose commits HEAD does not
//      contain, unless the caller passes the explicit user-confirmed
//      discard_unmerged flag (Code-page close).
//   2. fleet_worktree_merge may answer NoChanges ONLY for a branch HEAD already
//      contains (ancestor pre-check); a commits-ahead branch that stages
//      nothing is an ERROR, not a no-op.
//   3. The Agentic run integrates on finalize "noChanges" too (self-committed
//      branches), keeps the worktree on finalize errors, and announces any
//      branch the backend preserved.
//   4. The Code page's explicit discard flows still really discard.
// Plus an EXECUTED git proof that the old cleanup sequence orphans a
// self-committed branch while the guarded sequence keeps the work reachable
// and mergeable.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../../../..");
const fleet = fs.readFileSync(path.join(APP, "src-tauri/src/fleet.rs"), "utf8");
const agentsPage = fs.readFileSync(path.join(HERE, "AgentsPage.tsx"), "utf8");
const codePage = fs.readFileSync(path.join(HERE, "CodePage.tsx"), "utf8");

let checks = 0;
function fail(message) {
  console.error(`FAIL fleet worktree work-loss: ${message}`);
  process.exit(1);
}
function pin(ok, message) {
  checks++;
  if (!ok) fail(message);
}

// ---- 1. Rust remove guard --------------------------------------------------
pin(
  /fn branch_work_contained\(cwd: &Path, branch: &str\) -> bool/.test(fleet),
  "the containment probe (ancestry OR squash-equivalent tree) is gone",
);
pin(
  /\["merge-tree", "--write-tree", "--no-messages", "HEAD", branch\]/.test(fleet),
  "the probe no longer recognizes squash-merged work — every successfully merged branch would be preserved as litter, or worse",
);
pin(
  /let unmerged = !branch_work_contained\(&cwd, &args\.branch\);/.test(fleet),
  "fleet_worktree_remove no longer asks whether HEAD contains the branch's work",
);
{
  // "Contained" licenses deletion, so every uncertain path in the probe must
  // answer NOT contained.
  const start = fleet.indexOf("fn branch_work_contained");
  const end = fleet.indexOf("fn fleet_worktree_merge_locked");
  const probe = start >= 0 && end > start ? fleet.slice(start, end) : "";
  pin(
    probe.length > 0 && !probe.includes("unwrap_or(true)") && probe.includes("unwrap_or(false)"),
    "the containment probe must treat an unreadable ancestor check as NOT contained",
  );
  pin(
    (probe.match(/return false;/g) ?? []).length >= 3,
    "the probe's failure paths (merge-tree error, conflict, unreadable HEAD) must answer NOT contained",
  );
}
pin(
  /let preserve_branch = branch_exists && unmerged && !args\.discard_unmerged\.unwrap_or\(false\);/.test(fleet),
  "the preserve decision (exists + unmerged + no explicit discard) is gone",
);
pin(
  /if !preserve_branch \{\s*let _ = git\(&cwd, &\["branch", "-D", &args\.branch\]\);\s*\}/.test(fleet),
  "branch -D is no longer conditional on the preserve decision — unmerged work can be orphaned again",
);
pin(
  /pub struct RemoveOutcome \{[\s\S]{0,400}?branch_preserved: bool/.test(fleet),
  "remove no longer reports whether the branch was preserved",
);
pin(
  /pub discard_unmerged: Option<bool>/.test(fleet),
  "the explicit user-confirmed discard flag is missing from RemoveArgs",
);

// ---- 2. Rust merge NoChanges contract -------------------------------------
pin(
  /if branch_work_contained\(cwd, branch\) \{\s*return Ok\(MergeOutcome::NoChanges\);\s*\}/.test(fleet),
  "merge lost its containment pre-check — NoChanges can again mean 'branch with commits'",
);
pin(
  /refusing to report it as a no-op/.test(fleet),
  "a commits-ahead branch whose squash stages nothing must ERROR (kept), not read as a no-op",
);
pin(
  /staged_before_scratch_drop/.test(fleet),
  "the scratch-only-branch case is no longer distinguished from the suspicious empty squash",
);

// ---- 3. Rust regression tests present -------------------------------------
for (const name of [
  "remove_preserves_a_self_committed_unmerged_branch",
  "remove_deletes_a_branch_head_already_contains",
  "explicit_discard_still_deletes_an_unmerged_branch",
  "merge_never_calls_a_branch_with_commits_a_noop",
]) {
  pin(fleet.includes(name), `fleet.rs unit coverage '${name}' is missing`);
}

// ---- 4. Agentic run integration gates -------------------------------------
pin(
  !agentsPage.includes('o.finalize.status !== "committed") continue;'),
  "the team merge phase again skips every non-'committed' finalize — self-committed branches would be dropped",
);
pin(
  /if \(!o\.finalize \|\| o\.finalize\.status === "error"\) \{[\s\S]{0,300}?keepOnDisk\.add\(o\.name\);[\s\S]{0,100}?continue;/.test(agentsPage),
  "a failed finalize no longer keeps the worktree in the team merge phase",
);
pin(
  /soloFinalize\.status === "committed" \|\| soloFinalize\.status === "noChanges"/.test(agentsPage),
  "the solo loop again merges only on finalize 'committed' — a self-committing coder's branch would be dropped",
);
pin(
  /docFinalize\.status === "committed" \|\| docFinalize\.status === "noChanges"/.test(agentsPage),
  "the auto-doc lane again merges only on finalize 'committed'",
);
pin(
  (agentsPage.match(/removed\.branchPreserved/g) ?? []).length >= 2,
  "preserved branches are no longer announced after cleanup (team + solo)",
);

// ---- 5. Code page explicit discard ----------------------------------------
pin(
  (codePage.match(/discardUnmerged: true/g) ?? []).length >= 4,
  "the Code page's user-confirmed discard flows no longer pass the explicit flag — closing a page would leave branch litter",
);

// ---- 6. EXECUTED proof: the loss mechanism and the guarded sequence --------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-workloss-"));
const g = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
const gFails = (cwd, ...args) => {
  try { execFileSync("git", args, { cwd, stdio: "pipe" }); return false; }
  catch { return true; }
};
try {
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  g(repo, "init", "-b", "master");
  g(repo, "config", "user.email", "workloss-gate@owllm.local");
  g(repo, "config", "user.name", "OwLLM Work-Loss Gate");
  g(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "project.json"), "{}\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-m", "OWLLM project init");

  // Two agent worktrees, both self-committing — the Red Hair shape.
  const mkAgentWork = (name, file, content) => {
    const wt = path.join(tmp, name);
    g(repo, "worktree", "add", "-b", `owllm-fleet/run1/${name}`, wt, "HEAD");
    fs.writeFileSync(path.join(wt, file), content);
    g(wt, "add", "-A");
    g(wt, "commit", "-m", `agent ${name} builds the site`);
    // finalize's staging pass finds NOTHING — the noChanges shape.
    g(wt, "add", "-A");
    const staged = g(wt, "diff", "--cached", "--name-only").trim();
    pin(staged === "", `finalize simulation for ${name} unexpectedly staged: ${staged}`);
    return wt;
  };
  const wtA = mkAgentWork("worker_a", "site.html", "<h1>red hair</h1>\n");
  const wtB = mkAgentWork("worker_b", "styles.css", "h1{color:#c66}\n");

  // OLD cleanup on worker_a: exactly what shipped — worktree removed, branch -D.
  const shaA = g(wtA, "rev-parse", "HEAD").trim();
  g(repo, "worktree", "remove", "--force", wtA);
  g(repo, "branch", "-D", "owllm-fleet/run1/worker_a");
  pin(
    gFails(repo, "rev-parse", "--verify", "--quiet", "refs/heads/owllm-fleet/run1/worker_a"),
    "instrument check: the old sequence should have deleted worker_a's branch",
  );
  const fsck = g(repo, "fsck", "--lost-found");
  pin(
    fsck.includes(shaA),
    "instrument check: the old sequence should leave worker_a's commit DANGLING — the loss mechanism did not reproduce",
  );

  // NEW guarded cleanup on worker_b: the containment probe (the same shape the
  // Rust guard runs: ancestry fast-path, else merge-tree tree-equality)
  // decides the branch's fate.
  const contained = (branch) => {
    if (!gFails(repo, "merge-base", "--is-ancestor", branch, "HEAD")) return true;
    try {
      const tree = g(repo, "merge-tree", "--write-tree", "--no-messages", "HEAD", branch).trim();
      const headTree = g(repo, "rev-parse", "HEAD^{tree}").trim();
      return tree !== "" && tree === headTree;
    } catch { return false; }
  };
  const shaB = g(wtB, "rev-parse", "HEAD").trim();
  pin(!contained("owllm-fleet/run1/worker_b"), "the containment probe must report worker_b's unmerged work as NOT contained");
  g(repo, "worktree", "remove", "--force", wtB);
  // preserve_branch=true → NO branch -D. Work must remain reachable…
  const tipB = g(repo, "rev-parse", "refs/heads/owllm-fleet/run1/worker_b").trim();
  pin(tipB === shaB, "the guarded sequence must keep worker_b's branch pointing at its work");
  // …and integrable: the next run can land it on master instead of rebuilding.
  g(repo, "merge", "--squash", "--no-commit", "owllm-fleet/run1/worker_b");
  g(repo, "commit", "-m", "[merge:worker_b] integrate parallel dispatch");
  pin(
    fs.readFileSync(path.join(repo, "styles.css"), "utf8") === "h1{color:#c66}\n",
    "the preserved branch must merge into master with the agent's work intact",
  );
  // A squash-merge leaves NO ancestry — the probe must still see the work as
  // contained afterwards, so a later remove can delete the branch instead of
  // preserving litter forever. (This is exactly why a bare ancestor check is
  // NOT enough.)
  pin(
    gFails(repo, "merge-base", "--is-ancestor", "owllm-fleet/run1/worker_b", "HEAD"),
    "instrument check: squash-merge should NOT create ancestry (if it does, this gate's premise changed)",
  );
  pin(
    contained("owllm-fleet/run1/worker_b"),
    "after squash-integration the containment probe must report the branch's work as contained",
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`PASS fleet worktree work-loss gate — ${checks} checks: unmerged branches are preserved, noChanges means contained, self-committed work integrates`);
