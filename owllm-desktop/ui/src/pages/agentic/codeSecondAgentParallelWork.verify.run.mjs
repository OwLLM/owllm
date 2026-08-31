// Regression gate: the Code page's two agents must be able to work at the same
// time without overwriting each other.
//
// The bug: both panes dispatched against the SAME worktree (`workspace`). There
// is exactly one fleet_worktree_create in the page, keyed by the page id, and
// both runTurn and runSecondaryTurn passed its path as cwd. Two agents editing
// one checkout is last-writer-wins, and a subscription CLI writes files itself
// — no in-app lock can reach it, so separate worktrees are the only mechanism
// that actually makes the panes parallel. Alongside that:
//   * every lifecycle control that DELETES those checkouts (close project,
//     switch folder) was gated on the primary's `busy` only, so the second
//     agent's work could be deleted mid-run,
//   * the second agent ignored the page's Chat mode and kept write tools while
//     the UI promised "discuss only, nothing is modified".
//
// This gate pins the source contract AND executes the two functions that carry
// the invariant, sliced out of CodePage.tsx: a source check alone would pass on
// a create call that handed back the primary's path.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODE_PAGE = path.join(HERE, "CodePage.tsx");

let failures = 0;
const check = (label, condition) => {
  if (condition) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ ${label}`); }
};

console.log("\nCode page — two agents working in parallel:\n");

if (!fs.existsSync(CODE_PAGE)) {
  console.error("  ✗ CodePage.tsx not found");
  throw new Error("FAILED: CodePage.tsx missing — cannot verify parallel second-agent work.");
}
const src = fs.readFileSync(CODE_PAGE, "utf8").replace(/\r\n/g, "\n");
// The invariant is about CODE, and the comments here describe the very shapes
// the gate forbids. Strip them so an explanatory note can't fail its own check.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

// ---- 1. source contract ----------------------------------------------------

check("the second agent's checkout is a persisted CodeState field",
  /secondaryWorkspace\?: string;/.test(code) && /secondaryBranch\?: string;/.test(code));

check("it gets its OWN worktree from the first pane, under a different agent name",
  /agentName: "code-2"/.test(code)
  && /fleet_worktree_create[\s\S]{0,240}?projectCwd: cur\.workspace[\s\S]{0,160}?agentName: "code-2"/.test(code)
  && /checkpointDirty: true/.test(code));

check("the second pane is refreshed against the first pane, never canonical main",
  /ensureWorktreeCurrent\(secondaryRunCwd, true, cur\.workspace\)/.test(code)
  && !/ensureWorktreeCurrent\(secondaryRunCwd\)/.test(code));

check("the second agent dispatches against ITS cwd, not the primary's workspace",
  /projectCwd: cwd,/.test(code)
  && !/onDelta: onSecondaryDelta[\s\S]{0,80}?projectCwd: workspace/.test(code)
  && !/streamChatCompletion\(0, secModel,[^\n]*?, onSecondaryDelta, workspace,/.test(code)
  // The system prompt must name the SAME root it is dispatched into, or the
  // agent is told to work in the primary's checkout while running in its own.
  && /runSecondaryTurn\(CODING_SYSTEM\(secondaryRunCwd\)/.test(code));

check("the page's Chat mode governs the SECOND agent too",
  /const runSecondaryTurn = async \([\s\S]{0,2000}?const chatOnly = agentMode === "chat";/.test(code)
  && !/allowedTools: \["all"\],\n\s*getSteer: \(\) => ""/.test(code));

check("closing the project is blocked while EITHER agent runs",
  /const closeProject = async \(\) => \{[\s\S]{0,400}?if \(busy \|\| secondaryBusy\) return;/.test(code));

check("switching folder is blocked while EITHER agent runs",
  /const pickWorkspace = async \(\) => \{\s*\n\s*if \(busy \|\| secondaryBusy\) return;/.test(code)
  && /const openWorkspace = async \(dir: string\) => \{[\s\S]{0,300}?if \(!dir \|\| busy \|\| secondaryBusy\) return;/.test(code));

check("the header controls that delete those checkouts disable on either run",
  /onClick=\{closeProject\} disabled=\{busy \|\| secondaryBusy\}/.test(code)
  && /onClick=\{pickWorkspace\} disabled=\{busy \|\| secondaryBusy\}/.test(code));

check("both worktrees are removed on close-project and close-page",
  /const removeWorktree = async[\s\S]{0,700}?worktreePath: st\.secondaryWorkspace/.test(code)
  && /worktreePath: st\.secondaryWorkspace, branch: st\.secondaryBranch \?\? "", keep: false/.test(code));

check("switching project clears the stale second-agent path",
  /secondaryWorkspace: "",\n\s*secondaryBranch: "",/.test(code));

check("a shared folder (non-git project) is disclosed, never implied to be isolated",
  /data-ui="code-secondary-workspace-badge"/.test(code)
  && /shared folder/.test(code));

check("the second agent's work has a route back into the page branch",
  /data-ui="code-secondary-merge"/.test(code)
  && /const mergeSecondaryIntoPrimary = async/.test(code));

// ---- 2. EXECUTE the sliced functions --------------------------------------
//
// Brace-match a function out of the page and run it with injected deps. This is
// the evidence: it proves the second agent is handed a DIFFERENT directory, and
// that the merge seals the primary's edits before a merge that can reset it.

function sliceFn(name) {
  const start = src.indexOf(`const ${name} = async`);
  if (start < 0) return null;
  let i = src.indexOf("{", src.indexOf("=>", start));
  if (i < 0) return null;
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    const c = src[j];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, j + 1) + ";";
    }
  }
  return null;
}

const ensureSrc = sliceFn("ensureSecondaryWorktree");
const mergeSrc = sliceFn("mergeSecondaryIntoPrimary");
check("ensureSecondaryWorktree can be sliced out for execution", !!ensureSrc);
check("mergeSecondaryIntoPrimary can be sliced out for execution", !!mergeSrc);

async function build(fnSrc, name) {
  const { code: js } = await esbuild.transform(fnSrc, { loader: "tsx", format: "esm" });
  // eslint-disable-next-line no-new-func
  const make = new Function("deps", `
    const { invoke, chatRuntime, SID, pageId, notify, DEFAULT_CODE_STATE, isSecondaryBusyNow, mergingSecondary, setMergingSecondary, useState } = deps;
    ${js}
    return ${name};
  `);
  return make;
}

function fakeStore(initial) {
  let payload = { ...initial };
  return {
    store: {
      getSnapshot: () => ({ payload }),
      setPayload: (_sid, fn) => { payload = fn(payload); },
    },
    read: () => payload,
  };
}

if (ensureSrc) {
  const make = await build(ensureSrc, "ensureSecondaryWorktree");

  // (a) isolated git project → its own checkout, different from the primary's.
  {
    const calls = [];
    const { store, read } = fakeStore({
      isolated: true, projectRoot: "C:/proj", workspace: "C:/fleet/page/code",
    });
    const ensure = make({
      invoke: async (cmd, args) => {
        calls.push([cmd, args]);
        return { status: "ready", path: "C:/fleet/page/code-2", branch: "owllm-page/p1/code-2", baseSha: "abc" };
      },
      chatRuntime: store, SID: "sid", pageId: "p1", notify: () => {}, DEFAULT_CODE_STATE: {},
    });
    const cwd = await ensure();
    check("the second agent is handed a DIFFERENT directory to the first",
      cwd === "C:/fleet/page/code-2" && cwd !== read().workspace);
    check("that checkout is cut from the FIRST PANE, including its completed edits",
      calls.length === 1 && calls[0][0] === "fleet_worktree_create"
      && calls[0][1].projectCwd === "C:/fleet/page/code"
      && calls[0][1].agentName === "code-2"
      && calls[0][1].checkpointDirty === true);
    check("the path + branch are persisted so a remount reuses them",
      read().secondaryWorkspace === "C:/fleet/page/code-2"
      && read().secondaryBranch === "owllm-page/p1/code-2");

    // (b) second send must NOT cut another worktree.
    const again = await ensure();
    check("a second turn reuses the same checkout instead of cutting another",
      again === "C:/fleet/page/code-2" && calls.length === 1);
  }

  // (c) non-git project: no worktree exists to cut — share, and say so.
  {
    let told = "";
    const { store } = fakeStore({ isolated: false, projectRoot: undefined, workspace: "C:/plain" });
    let created = 0;
    const ensure = make({
      invoke: async () => { created += 1; return { status: "notAGitRepo" }; },
      chatRuntime: store, SID: "sid", pageId: "p1",
      notify: (m) => { told += m; }, DEFAULT_CODE_STATE: {},
    });
    const cwd = await ensure();
    check("a non-git project falls back to the shared folder without a create call",
      cwd === "C:/plain" && created === 0);
    check("that fallback is silent about nothing — it does not claim isolation", told === "");
  }

  // (d) create fails → fail SOFT but disclosed. A hard failure here would make
  //     the second agent unusable on a project with uncommitted changes.
  {
    let told = "";
    const { store, read } = fakeStore({ isolated: true, projectRoot: "C:/proj", workspace: "C:/fleet/page/code" });
    const ensure = make({
      invoke: async () => ({ status: "dirtyWorkingTree", details: "M src/a.ts" }),
      chatRuntime: store, SID: "sid", pageId: "p1",
      notify: (m) => { told += m; }, DEFAULT_CODE_STATE: {},
    });
    const cwd = await ensure();
    check("a failed isolated create stops the second agent AND tells the user",
      cwd === "" && /did not run/i.test(told));
    check("a failed create does not persist a phantom second checkout",
      !read().secondaryWorkspace);
  }
}

if (mergeSrc) {
  const make = await build(mergeSrc, "mergeSecondaryIntoPrimary");
  const base = {
    secondaryWorkspace: "C:/fleet/page/code-2", secondaryBranch: "owllm-page/p1/code-2",
    workspace: "C:/fleet/page/code", branch: "owllm-page/p1/code",
  };

  // (a) happy path: seal 2nd, seal 1st, THEN merge into the PRIMARY worktree.
  {
    const calls = [];
    const { store } = fakeStore({ ...base });
    const merge = make({
      invoke: async (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === "fleet_worktree_finalize") return { status: "committed", commitSha: "s", filesChanged: 2, files: [] };
        return { status: "merged", commitSha: "m", filesChanged: 2 };
      },
      chatRuntime: store, SID: "sid", notify: () => {}, DEFAULT_CODE_STATE: {},
      isSecondaryBusyNow: () => false,
      mergingSecondary: false, setMergingSecondary: () => {},
      useState: () => [false, () => {}],
    });
    await merge();
    const names = calls.map((c) => c[0]);
    check("the 2nd agent's work is committed before it is merged",
      names[0] === "fleet_worktree_finalize" && calls[0][1].worktreePath === base.secondaryWorkspace);
    check("the 1st agent's uncommitted work is sealed BEFORE the merge that can reset it",
      names[1] === "fleet_worktree_finalize" && calls[1][1].worktreePath === base.workspace
      && names[2] === "fleet_worktree_merge");
    check("the merge target is the PAGE branch, not the user's project checkout",
      calls[2][1].projectCwd === base.workspace && calls[2][1].branch === base.secondaryBranch);
  }

  // (b) nothing to merge → the primary's checkout is not touched at all.
  {
    const calls = [];
    const { store } = fakeStore({ ...base });
    const merge = make({
      invoke: async (cmd) => { calls.push(cmd); return { status: "noChanges" }; },
      chatRuntime: store, SID: "sid", notify: () => {}, DEFAULT_CODE_STATE: {},
      isSecondaryBusyNow: () => false,
      mergingSecondary: false, setMergingSecondary: () => {},
      useState: () => [false, () => {}],
    });
    await merge();
    check("an idle second agent never triggers a merge into the first",
      calls.length === 1 && !calls.includes("fleet_worktree_merge"));
  }

  // (c) a live second agent must not have its tree committed mid-edit.
  {
    let told = "";
    const calls = [];
    const { store } = fakeStore({ ...base });
    const merge = make({
      invoke: async (cmd) => { calls.push(cmd); return { status: "noChanges" }; },
      chatRuntime: store, SID: "sid", notify: (m) => { told += m; }, DEFAULT_CODE_STATE: {},
      isSecondaryBusyNow: () => true,
      mergingSecondary: false, setMergingSecondary: () => {},
      useState: () => [false, () => {}],
    });
    await merge();
    check("merging is refused while the second agent is mid-run, with a reason",
      calls.length === 0 && /still working/i.test(told));
  }

  // (d) overlapping edits: BOTH sides survive and the user is told which files.
  {
    let told = "";
    const { store } = fakeStore({ ...base });
    const merge = make({
      invoke: async (cmd) => {
        if (cmd === "fleet_worktree_finalize") return { status: "committed", commitSha: "s", filesChanged: 1, files: [] };
        return { status: "conflict", files: ["src/CodePage.tsx"] };
      },
      chatRuntime: store, SID: "sid", notify: (m) => { told += m; }, DEFAULT_CODE_STATE: {},
      isSecondaryBusyNow: () => false,
      mergingSecondary: false, setMergingSecondary: () => {},
      useState: () => [false, () => {}],
    });
    await merge();
    check("a conflict names the files and says nothing was overwritten",
      /src\/CodePage\.tsx/.test(told) && /Nothing was overwritten/i.test(told)
      && told.includes(base.secondaryBranch));
  }
}

console.log(`\n${failures === 0 ? "OK" : `FAILED: ${failures} check(s)`}\n`);
if (failures > 0) throw new Error(`FAILED: ${failures} parallel-second-agent check(s)`);
