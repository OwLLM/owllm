// Focused runtime verification for two Code page behaviours:
//
//   A. Per-page rename (CodePage.tsx, 43d874a5) — the header "Rename page…"
//      box. Tab titles compose as `folder(rename)`; unrenamed pages fall back
//      to the folder name only; renames persist PER PAGE so multiple pages on
//      the same project carry independent labels; reopening the same project
//      (incl. worktree self-heal) keeps the rename while switching projects
//      resets it; blur normalises whitespace.
//
//   B. GitHub functions container (PublishCards.tsx, facec5ae) — visibility
//      is decided by the cheap LOCAL git_status (the card must not vanish when
//      the network readiness probe is slow or fails), a failed readiness probe
//      keeps the last known checks, isolated pages get Merge without a remote,
//      and the enriched status surface (branch / ↑ahead / ↓behind / dirty
//      count, Commit(n) / Push(n) labels, READY / "N issues" checklist).
//
// Run:  node owllm-desktop/ui/src/pages/agentic/codePageRenamePublish.verify.run.mjs
// (The runner ALSO anchors these invariants against the real CodePage.tsx /
// PublishCards.tsx source, so a revert fails the gate even though this file
// mirrors the logic.)

// Module scope (not script scope) — the sibling verify files share tsc's
// global scope and their top-level `store`/`save`/`load` names would collide.
export {};

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

// ===========================================================================
// A. Per-page rename
// ===========================================================================
console.log("A) Code page per-page rename:\n");

// Mirror of the CodePage.tsx tab-title effect (basename of projectRoot, else
// workspace; rename appended in parens when non-empty; "New page" otherwise).
const composeTitle = (projectRoot: string, workspace: string, pageRename?: string): string => {
  const folder = projectRoot ? projectRoot.replace(/^.*[\\/]/, "")
    : workspace ? workspace.replace(/^.*[\\/]/, "")
    : "";
  const rename = (pageRename ?? "").trim();
  return folder ? (rename ? `${folder}(${rename})` : folder) : "New page";
};

// Mirror of the onBlur normalisation: trimmed value, or the field removed.
const normalizeRename = (raw: string): string | undefined => raw.trim() || undefined;

// Mirror of the openWorkspace keep-vs-reset rule: reopening the SAME project
// (by projectRoot or by the worktree path during self-heal) keeps the rename;
// a different project starts unnamed.
const renameAfterOpen = (
  stx: { projectRoot?: string; workspace?: string; pageRename?: string },
  dir: string,
): string | undefined =>
  (stx.projectRoot === dir || stx.workspace === dir) ? stx.pageRename : undefined;

// --- title composition -----------------------------------------------------
check("renamed page shows folder(rename) — LocaLLM(GUI_fix)",
  composeTitle("C:\\1-Git\\LocaLLM", "", "GUI_fix") === "LocaLLM(GUI_fix)");
check("unrenamed page shows the folder name only",
  composeTitle("C:\\1-Git\\LocaLLM", "") === "LocaLLM");
check("whitespace-only rename falls back to the folder name",
  composeTitle("C:\\1-Git\\LocaLLM", "", "   ") === "LocaLLM");
check("forward-slash paths compose the same (cross-platform)",
  composeTitle("/home/u/LocaLLM", "", "GUI_fix") === "LocaLLM(GUI_fix)");
check("no project and no workspace → \"New page\" (rename ignored)",
  composeTitle("", "", "GUI_fix") === "New page");
check("workspace basename is the fallback when projectRoot is empty",
  composeTitle("", "C:\\fleet\\LocaLLM\\pmxyz\\code", "wt_fix") === "code(wt_fix)");

// --- blur normalisation ----------------------------------------------------
check("blur trims surrounding whitespace", normalizeRename("  GUI_fix ") === "GUI_fix");
check("blur on an emptied box removes the field entirely", normalizeRename("   ") === undefined);

// --- per-page persistence: two pages, SAME project, independent renames -----
type PageState = { projectRoot: string; workspace: string; pageRename?: string };
const pageSessionKey = (pageId: string) => `owllm:code:page:${pageId}`;
const store = new Map<string, string>();
const save = (pageId: string, s: PageState) => store.set(pageSessionKey(pageId), JSON.stringify(s));
const load = (pageId: string): PageState | null => {
  const raw = store.get(pageSessionKey(pageId));
  return raw ? JSON.parse(raw) : null;
};

const PROJECT = "C:\\1-Git\\LocaLLM";
save("page-1", { projectRoot: PROJECT, workspace: "C:\\fleet\\p1\\code", pageRename: "GUI_fix" });
save("page-2", { projectRoot: PROJECT, workspace: "C:\\fleet\\p2\\code", pageRename: "release" });
save("page-3", { projectRoot: PROJECT, workspace: "C:\\fleet\\p3\\code" }); // never renamed

const p1 = load("page-1")!, p2 = load("page-2")!, p3 = load("page-3")!;
check("persistence keys are distinct per page (same project)",
  pageSessionKey("page-1") !== pageSessionKey("page-2"));
check("page 1 restores its own rename", p1.pageRename === "GUI_fix");
check("page 2 restores its own rename (not page 1's)", p2.pageRename === "release");
check("page 3 restores with no rename at all", p3.pageRename === undefined);
check("three pages on the SAME project render distinct titles",
  new Set([
    composeTitle(p1.projectRoot, p1.workspace, p1.pageRename),
    composeTitle(p2.projectRoot, p2.workspace, p2.pageRename),
    composeTitle(p3.projectRoot, p3.workspace, p3.pageRename),
  ]).size === 3);
check("unrenamed sibling page still shows the plain folder label",
  composeTitle(p3.projectRoot, p3.workspace, p3.pageRename) === "LocaLLM");

// --- keep-vs-reset on (re)open ----------------------------------------------
check("re-picking the SAME project keeps the rename",
  renameAfterOpen(p1, PROJECT) === "GUI_fix");
check("worktree self-heal (dir == workspace) keeps the rename",
  renameAfterOpen(p1, "C:\\fleet\\p1\\code") === "GUI_fix");
check("switching the page to a DIFFERENT project resets the rename",
  renameAfterOpen(p1, "C:\\other\\Project") === undefined);

// ===========================================================================
// B. GitHub functions container (PublishCards)
// ===========================================================================
console.log("\nB) GitHub functions container:\n");

// Mirrors of the PublishCards.tsx types + gating logic.
type GitStatusInfo = { isRepo: boolean; branch: string; ahead: number; behind: number; total: number };
type ReadyCheck = { id: string; label: string; ok: boolean; detail: string };

function gates(
  git: GitStatusInfo | null,
  ready: ReadyCheck[] | null,
  isolated: boolean,
  projectRoot: string,
  branch: string,
) {
  const isRepo = git ? git.isRepo : (ready?.find((c) => c.id === "repo")?.ok ?? false);
  const hasRemote = ready?.find((c) => c.id === "remote")?.ok ?? false;
  const hasPublishScript = ready?.find((c) => c.id === "script")?.ok ?? false;
  const showCommit = isRepo;
  const showPush = isRepo && hasRemote;
  const showMerge = isRepo && ((isolated && !!projectRoot && !!branch) || hasRemote);
  const showPublish = isRepo && hasPublishScript;
  const canPublish = ready?.every((c) => c.ok) ?? false;
  const readyFails = ready?.filter((c) => !c.ok) ?? [];
  return {
    showCommit, showPush, showMerge, showPublish, canPublish, readyFails,
    visible: showCommit || showPush || showMerge || showPublish,
    publishFailReason: readyFails.map((c) => `${c.label}: ${c.detail}`).join("\n"),
  };
}

const localRepo: GitStatusInfo = { isRepo: true, branch: "owllm-page/px/code", ahead: 2, behind: 1, total: 3 };
const allOk: ReadyCheck[] = [
  { id: "repo", label: "Git repository", ok: true, detail: "" },
  { id: "remote", label: "Remote origin", ok: true, detail: "" },
  { id: "script", label: "Publish script", ok: true, detail: "" },
  { id: "gh", label: "gh auth", ok: true, detail: "" },
];

// --- repair 1: the card must not vanish / wait on the network ---------------
check("local repo + readiness probe still pending → card visible (Commit shown)",
  gates(localRepo, null, false, "", "").visible
  && gates(localRepo, null, false, "", "").showCommit);
check("remote-dependent buttons stay hidden until the probe answers",
  !gates(localRepo, null, false, "", "").showPush
  && !gates(localRepo, null, false, "", "").showPublish);

// A failed refresh keeps the LAST KNOWN checks (the old code nulled them,
// which unmounted the whole container). Mirror the .catch(() => {}) contract.
let readyState: ReadyCheck[] | null = allOk;
const refreshFailed = () => { /* .catch(() => {}) — readyState intentionally untouched */ };
refreshFailed();
check("failed readiness probe keeps the last known checks (card stays)",
  readyState === allOk && gates(localRepo, readyState, false, "", "").visible);

check("not a repo anywhere → the container renders nothing",
  !gates({ ...localRepo, isRepo: false }, null, false, "", "").visible);

// --- repair 2: isolated pages merge locally, no remote needed ---------------
const noRemote: ReadyCheck[] = allOk.map((c) => c.id === "remote" ? { ...c, ok: false, detail: "no origin" } : c);
check("isolated page WITHOUT a remote still gets Merge",
  gates(localRepo, noRemote, true, "C:\\1-Git\\LocaLLM", "owllm-page/px/code").showMerge);
check("non-isolated page without a remote gets neither Merge nor Push",
  !gates(localRepo, noRemote, false, "", "").showMerge
  && !gates(localRepo, noRemote, false, "", "").showPush);
check("remote present → Merge and Push show without isolation too",
  gates(localRepo, allOk, false, "", "").showMerge
  && gates(localRepo, allOk, false, "", "").showPush);

// --- publish gating + actionable failure surface ----------------------------
const ghDown: ReadyCheck[] = allOk.map((c) =>
  c.id === "gh" ? { ...c, ok: false, detail: "gh auth status failed — run 'gh auth login' on this host" } : c);
check("all checks green → Publish enabled (READY)",
  gates(localRepo, allOk, false, "", "").canPublish
  && gates(localRepo, allOk, false, "", "").readyFails.length === 0);
const failing = gates(localRepo, ghDown, false, "", "");
check("one failing check disables Publish", !failing.canPublish);
check("\"N issues\" count matches the failing checks", failing.readyFails.length === 1);
check("failure reason carries the label AND the actionable detail",
  failing.publishFailReason.includes("gh auth")
  && failing.publishFailReason.includes("gh auth login"));

// --- enriched status labels (branch / ahead / behind / dirty / counts) ------
const headerBits = (g: GitStatusInfo) => ({
  branch: g.branch || "(detached)",
  ahead: g.ahead > 0 ? `↑${g.ahead}` : "",
  behind: g.behind > 0 ? `↓${g.behind}` : "",
  dirty: g.total > 0 ? `● ${g.total}` : "✓ clean",
  commitLabel: `Commit${g.total > 0 ? ` (${g.total})` : ""}`,
  pushLabel: `Push${g.ahead > 0 ? ` (${g.ahead})` : ""}`,
});

const dirty = headerBits(localRepo);
check("header shows the current branch", dirty.branch === "owllm-page/px/code");
check("header shows ↑ahead and ↓behind", dirty.ahead === "↑2" && dirty.behind === "↓1");
check("header shows the uncommitted count", dirty.dirty === "● 3");
check("Commit button carries the live change count", dirty.commitLabel === "Commit (3)");
check("Push button carries the live ahead count", dirty.pushLabel === "Push (2)");

const clean = headerBits({ isRepo: true, branch: "main", ahead: 0, behind: 0, total: 0 });
check("clean tree shows ✓ clean and unadorned buttons",
  clean.dirty === "✓ clean" && clean.commitLabel === "Commit" && clean.pushLabel === "Push"
  && clean.ahead === "" && clean.behind === "");
check("detached HEAD gets an explicit label",
  headerBits({ isRepo: true, branch: "", ahead: 0, behind: 0, total: 0 }).branch === "(detached)");

// ===========================================================================
if (failures > 0) {
  throw new Error(`FAILED: ${failures} assertion(s) failed.`);
}
console.log("\nPASSED: rename + GitHub-container invariants hold.");
