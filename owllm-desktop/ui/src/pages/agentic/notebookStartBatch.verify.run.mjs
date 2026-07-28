// One-shot verify for the Notebook's start controls: the Kanban NOW column's
// "⚡ Start batch" button feeds the whole lane WITHOUT consuming the board,
// and the "▶ Start queue" button feeds the first pending step so an idle
// team + auto-feed can actually begin walking the list. Mounts the REAL
// RunNotebook.tsx in jsdom via react-dom.
//
// Run from owllm-desktop/:  node ui/src/pages/agentic/notebookStartBatch.verify.run.mjs
// Needs jsdom present in node_modules (npm i --no-save jsdom). Exits
// non-zero on any assertion failure.
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const req = createRequire(path.join(REPO, "package.json"));
const ts = (await import(pathToFileURL(path.join(REPO, "node_modules/typescript/lib/typescript.js")).href)).default;
let JSDOM;
try {
  ({ JSDOM } = req("jsdom"));
} catch {
  console.error("FAIL notebookStartBatch: jsdom is required (run `npm i --no-save jsdom` to exercise this harness).");
  process.exit(1);
}

// ---- DOM environment (react-dom needs window/document globals; the notebook
// needs a working localStorage, which jsdom provides given a real origin) ----
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.localStorage = dom.window.localStorage;
globalThis.CustomEvent = dom.window.CustomEvent;

// ---- transpile the real RunNotebook.tsx to CJS, stub its siblings ----
// Normalize CRLF -> LF on read: on Windows the tree is checked out CRLF, but the
// source-string checks below use literal "\n". Without this they false-fail on a
// correct file (the busySendRef gate check regressed exactly this way). Keeps
// every check's intent; only removes line-ending fragility.
const readLF = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const src = readLF(path.join(HERE, "RunNotebook.tsx"));
const codePageSrc = readLF(path.join(HERE, "CodePage.tsx"));
const agentsPageSrc = readLF(path.join(HERE, "AgentsPage.tsx"));
const brainstormSrc = readLF(path.join(HERE, "BrainstormPanel.tsx"));
const watcherSrc = readLF(path.join(REPO, "ui/src/support/WatcherDrawer.tsx"));
const vaultSyncSrc = readLF(path.join(REPO, "ui/src/runtime/vaultSync.ts"));
const js = ts.transpileModule(src, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
}).outputText;
const TMP = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "nb-verify-"));
fs.mkdirSync(path.join(TMP, "hooks"), { recursive: true });
fs.mkdirSync(path.join(TMP, "components"), { recursive: true });
fs.writeFileSync(path.join(TMP, "pages.js"), js); // placeholder name below
fs.writeFileSync(path.join(TMP, "RunNotebook.js"), js);
fs.writeFileSync(path.join(TMP, "dispatch.js"), `
  module.exports = { streamChatCompletion: async () => {}, providerFor: () => "local" };
`);
fs.writeFileSync(path.join(TMP, "ModelPicker.js"), `
  const React = require("react");
  module.exports = { __esModule: true, default: () => React.createElement("div", null, "(model picker)") };
`);
fs.writeFileSync(path.join(TMP, "hooks.js"), `
  module.exports = { __esModule: true, useAutoResize: () => ({ current: null }) };
`);
fs.writeFileSync(path.join(TMP, "LogBox.js"), `
  const React = require("react");
  module.exports = { __esModule: true, default: () => React.createElement("pre", null) };
`);
fs.writeFileSync(path.join(TMP, "RunTimer.js"), `
  module.exports = {
    __esModule: true,
    formatDuration: (ms) => String(Math.floor(ms / 1000)) + "s",
    formatClock: (ts) => new Date(ts).toLocaleTimeString(),
    useTick: () => {},
  };
`);
fs.writeFileSync(path.join(TMP, "localization.js"), `
  module.exports = { __esModule: true, translateUiText: (text) => text };
`);
fs.writeFileSync(path.join(TMP, "ActionIcon.js"), `
  const React = require("react");
  module.exports = { __esModule: true, default: ({ name }) => React.createElement("svg", { "data-icon": name }) };
`);
// device_get_identity backs the cross-PC "queue started on <name>" advisory.
fs.writeFileSync(path.join(TMP, "tauri.js"), `
  module.exports = { invoke: async (cmd) => (cmd === "device_get_identity" ? { device_id: "dev-local", name: "This PC" } : null) };
`);
// Rewrite relative imports in the transpiled output to the stubs.
let out = fs.readFileSync(path.join(TMP, "RunNotebook.js"), "utf8");
out = out
  .replace(/require\("\.\.\/\.\.\/hooks\/useAutoResize"\)/g, 'require("./hooks.js")')
  .replace(/require\("\.\.\/\.\.\/components\/LogBox"\)/g, 'require("./LogBox.js")')
  .replace(/require\("\.\/dispatch"\)/g, 'require("./dispatch.js")')
  .replace(/require\("\.\/ModelPicker"\)/g, 'require("./ModelPicker.js")')
  .replace(/require\("\.\/RunTimer"\)/g, 'require("./RunTimer.js")')
  .replace(/require\("\.\.\/\.\.\/localization"\)/g, 'require("./localization.js")')
  .replace(/require\("\.\.\/\.\.\/components\/ActionIcon"\)/g, 'require("./ActionIcon.js")')
  .replace(/require\("@tauri-apps\/api\/core"\)/g, 'require("./tauri.js")');
fs.writeFileSync(path.join(TMP, "RunNotebook.js"), out);
fs.writeFileSync(path.join(TMP, "package.json"), "{}");
fs.mkdirSync(path.join(TMP, "node_modules"), { recursive: true });
for (const m of ["react", "react-dom", "scheduler"]) {
  fs.cpSync(path.join(REPO, "node_modules", m), path.join(TMP, "node_modules", m), { recursive: true });
}

const reqTmp = createRequire(path.join(TMP, "RunNotebook.js"));
const React = reqTmp("react");
const { createRoot } = reqTmp("react-dom/client");
const { act } = reqTmp("react");
const NB = reqTmp("./RunNotebook.js");
const RunNotebook = NB.default;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ---- helpers ----
const PID = "verify-project";
const KEY = `owllm:agents:notebook:${PID}`;
const PLAN = "NOW:\n- fix the frame\n- fix the hit area\n\nNEXT:\n- linux screenshots\n\nLATER:\n- parity pass";
function seed() {
  localStorage.setItem(KEY, JSON.stringify({
    text: "", plan: PLAN,
    steps: [
      { id: "s1", text: "first pending step", status: "pending", ts: 1 },
      { id: "s2", text: "second pending step", status: "pending", ts: 2 },
    ],
    autoFeed: true, digest: [],
  }));
}
function blob() { return JSON.parse(localStorage.getItem(KEY)); }
function textOf(el) { return el.textContent || ""; }
function buttons() { return [...document.querySelectorAll("button")]; }
function clickEl(el) {
  act(() => {
    el.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
}
let failures = 0;
function check(name, cond) {
  if (cond) console.log("  ok  " + name);
  else { console.error("  FAIL " + name); failures++; }
}

console.log("case 0: run completion paths cannot depend on a later React render");
check("Code busy state synchronizes the imperative lock", codePageSrc.includes("const setBusy = (v: boolean) => {\n    // Keep the imperative send gate") && codePageSrc.includes("busySendRef.current = v;"));
check("Code send gates on the synchronous lock", codePageSrc.includes("if (busySendRef.current) {"));
// Both Agents exits must still resolve auto-feed — but they now pass the run's
// PROVENANCE rather than continuing unconditionally, so a goal the user typed
// by hand cannot resume a queue left switched on days ago.
check("Agents single-assistant completion continues auto-feed", agentsPageSrc.includes("if (singleRunCompletedCleanly) scheduleNotebookAutoFeed(ranFromNotebook);"));
check("Agents resolves auto-feed from every dispatch exit", agentsPageSrc.includes("if (notebookRunCompletedCleanly) scheduleNotebookAutoFeed(ranFromNotebook);") && agentsPageSrc.includes("else if (ranFromNotebook) notifyAutoFeedPaused(notebookPauseReason);"));
// Both surfaces settle their cards through ONE helper now. Asserting the shared
// helper (rather than each page's own three-way branch, as this gate used to)
// is what stops the Coding page silently losing the "preflight → pending" case
// again: it never imported markNotebookStepPending at all.
check("Recoverable worktree preflight leaves the notebook card pending",
  agentsPageSrc.includes("e instanceof WorktreePreflightError || e instanceof CliPreflightError")
    && agentsPageSrc.includes('notebookRunStoppedAtPreflight ? { kind: "preflight" }'));
check("Recoverable CLI preflight leaves team and single-agent notebook cards pending",
  agentsPageSrc.includes("singleRunStoppedAtPreflight = e instanceof CliPreflightError")
    && agentsPageSrc.includes('singleRunStoppedAtPreflight ? { kind: "preflight" }'));
check("Coding page recognises a preflight stop too (it used to record it as a real failure)",
  codePageSrc.includes("stoppedAtPreflight = e instanceof CliPreflightError || e instanceof WorktreePreflightError")
    && codePageSrc.includes('stoppedAtPreflight ? { kind: "preflight" }'));
check("both surfaces settle cards through the one shared helper",
  agentsPageSrc.includes("settleNotebookStep(selectedProjectId") && codePageSrc.includes("settleNotebookStep(ruleScopeRef.current.id"));
check("Code uses the shared auto-feed continuation", codePageSrc.includes("continueNotebookAutoFeed(ruleScopeRef.current.id, notebookSurfaceId"));
check("Agents uses the shared auto-feed continuation", agentsPageSrc.includes("continueNotebookAutoFeed(pid, notebookSurfaceId"));
check("Watcher help and bug actions have accessible names", watcherSrc.includes('aria-label="Help using the app"') && watcherSrc.includes('aria-label="Report a bug"'));
check("Watcher actions use bundled SVG icons", watcherSrc.includes('<ActionIcon name="help"') && watcherSrc.includes('<ActionIcon name="bug"') && !watcherSrc.includes(">🐞 Report this as a bug"));
check("Existing-project brainstorm ends in the Notebook", brainstormSrc.includes('data-ui="BrainstormOpenNotebook"') && brainstormSrc.includes("seedNotebookFromBrief(projectId, briefTextOnDisk)"));
check("Existing-project brainstorm does not offer another team", brainstormSrc.includes("{hasTeam ? (") && brainstormSrc.includes("Assemble first team from brief"));
check("Agents wires brainstorm completion to the Notebook", agentsPageSrc.includes('hasTeam={!!activeTeam?.agents.length}') && agentsPageSrc.includes('new CustomEvent("owllm:open-run-notebook")'));
check("Graph fills its parent instead of retaining a stale pixel width", agentsPageSrc.includes('data-ui="GraphFitViewport"') && agentsPageSrc.includes('position:"relative", width:"100%", height:"100%"'));
check("Graph reframes saved positions when its viewport changes", agentsPageSrc.includes("const fitGraphToViewport = () =>") && agentsPageSrc.includes("positionMembershipKey"));

console.log("case 0a: false WSL redirector failures are repaired to pending");
{
  localStorage.setItem(KEY, JSON.stringify({
    text: "", plan: PLAN, autoFeed: true, digest: [],
    steps: [{
      id: "wsl-false-failure",
      text: "implement the queued website step",
      status: "failed",
      ts: 1,
      startedAt: 10,
      finishedAt: 20,
      archivedAt: 20,
      failureReason: "Could not create the required isolated worktree: project_cwd does not exist: \\\\wsl.localhost\\Ubuntu\\mnt\\c\\repo",
    }],
  }));
  const repaired = NB.loadNotebook(PID);
  check("known false WSL failure returns to pending", repaired.steps[0]?.status === "pending");
  check("false-failure timing and reason are cleared",
    repaired.steps[0]?.startedAt == null
      && repaired.steps[0]?.finishedAt == null
      && repaired.steps[0]?.archivedAt == null
      && repaired.steps[0]?.failureReason == null);
  check("repair is durable in the notebook blob", blob().steps[0]?.status === "pending");
}

console.log("case 0aa: known CLI provisioning failures are repaired without hiding real agent failures");
{
  localStorage.setItem(KEY, JSON.stringify({
    text: "", plan: PLAN, autoFeed: true, digest: [],
    steps: [
      {
        id: "npm-staging-collision",
        text: "retry Codex after provisioning",
        status: "failed",
        ts: 1,
        startedAt: 10,
        finishedAt: 20,
        failureReason: "wsl exited 217: npm ERR! code ENOTEMPTY rename '/usr/local/lib/node_modules/@openai/codex'",
      },
      {
        id: "closed-stdin",
        text: "retry Codex after startup repair",
        status: "failed",
        ts: 2,
        startedAt: 30,
        finishedAt: 40,
        failureReason: "write codex prompt to stdin: The pipe has been ended. (os error 109)",
      },
      {
        id: "real-agent-failure",
        text: "preserve genuine task failures",
        status: "failed",
        ts: 3,
        startedAt: 50,
        finishedAt: 60,
        failureReason: "The implementation tests failed.",
      },
    ],
  }));
  const repaired = NB.loadNotebook(PID);
  check("npm ENOTEMPTY preflight returns to pending", repaired.steps[0]?.status === "pending");
  check("closed stdin preflight returns to pending", repaired.steps[1]?.status === "pending");
  check("genuine agent failure remains failed", repaired.steps[2]?.status === "failed");
  check("CLI repair is durable in the notebook blob",
    blob().steps[0]?.status === "pending" && blob().steps[1]?.status === "pending");
}

function mount(props) {
  const container = document.getElementById("root");
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(RunNotebook, {
      projectId: PID, running: false, onFeed: () => "dispatched",
      modelId: "m", port: 0, models: [], inline: true, ...props,
    }));
  });
  return { root, container };
}

console.log("case 0b: Digest Notes is visibly enabled whenever clickable");
{
  seed();
  const { root } = mount({});
  const btn = buttons().find((b) => textOf(b).includes("Digest notes"));
  check("Digest Notes is clickable", !!btn && !btn.disabled);
  check("Digest Notes uses the bundled wand icon", !!btn?.querySelector('svg[data-icon="wand"]'));
  check("Digest Notes has a strong enabled fill", /backgroundImage:\s*digestBusy \? "none" : "linear-gradient/.test(src));
  act(() => root.unmount());
}

// ---- 1. The Kanban plan board is hidden (kept in code, gated off) ----
console.log("case 1: the Kanban plan board is hidden");
{
  seed();
  const { root } = mount({});
  check("no Start batch button (board hidden)", !buttons().some((b) => textOf(b).includes("Start batch")));
  check("Plan board heading is not rendered", !textOf(document.body).includes("Plan board"));
  check("SHOW_KANBAN flag is present so the board can be restored", src.includes("const SHOW_KANBAN"));
  act(() => root.unmount());
}

// ---- 3. ▶ Start queue feeds the FIRST pending step and marks it sent ----
console.log("case 3: ▶ Start queue kicks off the step list");
{
  seed();
  const fed = [];
  const ids = [];
  const { root } = mount({ onFeed: (t, id) => { fed.push(t); ids.push(id); return "dispatched"; } });
  const btn = buttons().find((b) => textOf(b).includes("Start queue"));
  check("Start queue button exists when steps pending", !!btn);
  clickEl(btn);
  check("first pending step fed", fed.length === 1 && fed[0] === "first pending step");
  check("step id is passed to onFeed", ids.length === 1 && ids[0] === "s1");
  const after = blob();
  check("first step marked sent", after.steps.find((s) => s.id === "s1")?.status === "sent");
  check("first step has startedAt", typeof after.steps.find((s) => s.id === "s1")?.startedAt === "number");
  check("second step still pending", after.steps.find((s) => s.id === "s2")?.status === "pending");
  act(() => root.unmount());
}

// ---- 3a. Start queue is an explicit ownership takeover. A closed page can
//          leave its persisted owner behind; card one must not run and then
//          strand card two behind that stale owner. ----
console.log("case 3a: Start queue takes over a stale auto-feed owner");
{
  seed();
  localStorage.setItem(KEY, JSON.stringify({ ...blob(), autoFeedOwner: "code:closed-page" }));
  const fed = [];
  const { root } = mount({ surfaceId: "code:current-page", onFeed: (_t, id) => { fed.push(id); return "dispatched"; } });
  clickEl(buttons().find((b) => textOf(b).includes("Start queue")));
  check("first card dispatches from the current page", fed.join(",") === "s1");
  check("idle Start queue claims the current page", blob().autoFeedOwner === "code:current-page");
  NB.markNotebookStepFinished(PID, "s1", 2000);
  check("next clean completion can dispatch card two", NB.continueNotebookAutoFeed(PID, "code:current-page", (step) => fed.push(step.id)) === "dispatched" && fed.join(",") === "s1,s2");
  act(() => root.unmount());
}

console.log("case 3aa: Start queue waits for an already-running job");
{
  seed();
  localStorage.setItem(KEY, JSON.stringify({ ...blob(), autoFeedOwner: "agents:closed-page" }));
  const fed = [];
  const { root } = mount({ surfaceId: "agents:current-page", running: true, onFeed: (_t, id) => { fed.push(id); return "dispatched"; } });
  clickEl(buttons().find((b) => textOf(b).includes("Start queue")));
  check("no card steers the live run", fed.length === 0 && blob().steps.every((s) => s.status === "pending"));
  check("running Start queue claims the current page", blob().autoFeed && blob().autoFeedOwner === "agents:current-page");
  check("current run completion dispatches card one", NB.continueNotebookAutoFeed(PID, "agents:current-page", (step) => fed.push(step.id)) === "dispatched" && fed.join(",") === "s1");
  act(() => root.unmount());
}

// ---- 3b. notebook timing helpers stamp start/finish on the blob ----
console.log("case 3b: markNotebookStepStarted / markNotebookStepFinished update the blob");
{
  seed();
  const { markNotebookStepStarted, markNotebookStepFinished } = NB;
  markNotebookStepStarted(PID, "s1", 1000);
  check("startedAt is stamped", blob().steps.find((s) => s.id === "s1")?.startedAt === 1000);
  markNotebookStepFinished(PID, "s1", 5000);
  check("finishedAt is stamped", blob().steps.find((s) => s.id === "s1")?.finishedAt === 5000);
  check("successful completion is archived", blob().steps.find((s) => s.id === "s1")?.status === "sent"
    && NB.isStepArchived(blob().steps.find((s) => s.id === "s1")));
}

console.log("case 3c: failed runs remain active and can be re-fed");
{
  seed();
  NB.markNotebookStepStarted(PID, "s1", 1000);
  NB.markNotebookStepFailed(PID, "s1", "Kimi login expired", 5000);
  const failed = blob().steps.find((s) => s.id === "s1");
  check("failed card stores its incomplete result", failed?.status === "failed"
    && failed?.finishedAt === 5000
    && failed?.failureReason === "Kimi login expired");
  check("failed card is not archived", NB.isStepArchived(failed) === false);
  NB.markNotebookStepStarted(PID, "s1", 6000);
  const refeed = blob().steps.find((s) => s.id === "s1");
  check("re-feed clears failure and starts the card again", refeed?.status === "sent"
    && refeed?.startedAt === 6000
    && refeed?.finishedAt == null
    && refeed?.failureReason == null);
}

console.log("case 0c: a completed project brainstorm prepares its Notebook queue");
{
  localStorage.removeItem(KEY);
  const brief = [
    "# Improve the graph",
    "",
    "## Plan",
    "1. Fix the graph sizing - AgentsPage.tsx - verify every card is visible",
    "2. Add regression coverage - notebookStartBatch.verify.run.mjs - run the harness",
    "",
    "## Scope",
    "In: graph and tests",
  ].join("\n");
  const added = NB.seedNotebookFromBrief(PID, brief);
  check("brief creates two feedable steps", added === 2 && blob().steps.length === 2);
  check("brief steps are pending", blob().steps.every((s) => s.status === "pending"));
  check("brief becomes the Notebook plan", blob().plan === brief);
  check("seeding the same brief is idempotent", NB.seedNotebookFromBrief(PID, brief) === 0 && blob().steps.length === 2);
}

// ---- 3c. The auto-feed sequence tracks wall-clock start through final stop,
//          rather than summing only individual job durations. ----
console.log("case 3c: whole auto-feed sequence start / completion timing");
{
  const { markNotebookAutoFeedStarted, markNotebookAutoFeedFinished } = NB;
  localStorage.setItem(KEY, JSON.stringify({
    text: "", plan: PLAN,
    steps: [{ id: "s1", text: "completed auto-fed step", status: "sent", ts: 1, startedAt: 2000, finishedAt: 5000 }],
    autoFeed: true, autoFeedOwner: "agents:main", digest: [],
  }));
  markNotebookAutoFeedStarted(PID, 1000);
  check("sequence start is persisted", blob().autoFeedStartedAt === 1000 && blob().autoFeedFinishedAt == null);
  check("sequence cannot finish while another job is pending", (() => {
    const withPending = { ...blob(), steps: [...blob().steps, { id: "s2", text: "pending", status: "pending", ts: 2 }] };
    localStorage.setItem(KEY, JSON.stringify(withPending));
    const result = markNotebookAutoFeedFinished(PID, "agents:main", 9000);
    localStorage.setItem(KEY, JSON.stringify({ ...withPending, steps: withPending.steps.slice(0, 1) }));
    return result === false && blob().autoFeedFinishedAt == null;
  })());
  check("sequence completion is persisted after the final job", markNotebookAutoFeedFinished(PID, "agents:main", 10000) === true && blob().autoFeedFinishedAt === 10000);
  const { root } = mount({ surfaceId: "agents:main" });
  check("total sequence elapsed time is displayed", textOf(document.body).includes("Auto-feed finished") && textOf(document.body).includes("9s"));
  act(() => root.unmount());
}

console.log("case 3d: stopping auto-feed freezes its sequence timer");
{
  seed();
  const { root } = mount({ surfaceId: "agents:main" });
  clickEl(buttons().find((b) => textOf(b).includes("Start queue")));
  check("successful auto-feed start stamps sequence start", typeof blob().autoFeedStartedAt === "number" && blob().autoFeedFinishedAt == null);
  clickEl(document.querySelector("input[type=checkbox]"));
  check("turning auto-feed off stamps a stopped finish", typeof blob().autoFeedFinishedAt === "number" && blob().autoFeedStopped === true);
  check("stopped total time remains visible", textOf(document.body).includes("Auto-feed stopped"));
  act(() => root.unmount());
}

// ---- 4. no team ready → step NOT consumed ----
console.log("case 4: no-team result consumes nothing");
{
  seed();
  const { root } = mount({ onFeed: () => "no-team" });
  clickEl(buttons().find((b) => textOf(b).includes("Start queue")));
  check("step stays pending on no-team", blob().steps.find((s) => s.id === "s1")?.status === "pending");
  check("no-team notice shows", textOf(document.body).includes("no team ready"));
  act(() => root.unmount());
}

// ---- 5. no pending steps → Start queue hidden ----
console.log("case 5: Start queue hides with nothing pending");
{
  localStorage.setItem(KEY, JSON.stringify({ text: "", plan: PLAN, steps: [{ id: "s1", text: "done step", status: "done", ts: 1 }], autoFeed: true, digest: [] }));
  const { root } = mount({});
  check("no Start queue button", !buttons().some((b) => textOf(b).includes("Start queue")));
  act(() => root.unmount());
}

// ---- 5b. done steps live ONLY on the Archive tab ----
console.log("case 5b: done steps are hidden until the Archive tab is clicked");
{
  localStorage.setItem(KEY, JSON.stringify({
    text: "", plan: PLAN,
    steps: [
      { id: "s1", text: "still open step", status: "pending", ts: 1 },
      { id: "s2", text: "finished archived step", status: "done", ts: 2 },
    ],
    autoFeed: false, digest: [],
  }));
  const { root } = mount({});
  check("done step is NOT visible on the default Active tab", !textOf(document.body).includes("finished archived step"));
  check("active step is visible", textOf(document.body).includes("still open step"));
  const archiveTab = buttons().find((b) => b.getAttribute("role") === "tab" && textOf(b).includes("Archive"));
  check("Archive tab shows the done count", !!archiveTab && textOf(archiveTab).includes("(1)"));
  clickEl(archiveTab);
  check("done step appears after clicking Archive", textOf(document.body).includes("finished archived step"));
  check("active queue is hidden on the Archive tab", !textOf(document.body).includes("still open step"));
  const reopen = buttons().find((b) => textOf(b).includes("Reopen"));
  check("archived step can be reopened", !!reopen);
  clickEl(reopen);
  check("reopened step is pending again", blob().steps.find((s) => s.id === "s2")?.status === "pending");
  check("archive shows its empty state once cleared", textOf(document.body).includes("No archived steps yet"));
  act(() => root.unmount());
}

// ---- 5c. a fed-and-finished step auto-archives out of Active (no manual
//          check-off needed) — the reported bug: finished steps stayed Active ----
console.log("case 5c: a finished (sent + finishedAt) step leaves Active for Archive");
{
  localStorage.setItem(KEY, JSON.stringify({
    text: "", plan: PLAN,
    steps: [
      { id: "s1", text: "open pending step", status: "pending", ts: 1 },
      { id: "s2", text: "completed run step", status: "sent", ts: 2, startedAt: 1000, finishedAt: 5000 },
    ],
    autoFeed: false, digest: [],
  }));
  const { root } = mount({});
  check("finished step is NOT on the Active tab", !textOf(document.body).includes("completed run step"));
  check("pending step remains on Active", textOf(document.body).includes("open pending step"));
  const archiveTab = buttons().find((b) => b.getAttribute("role") === "tab" && textOf(b).includes("Archive"));
  check("Archive tab counts the finished step", !!archiveTab && textOf(archiveTab).includes("(1)"));
  clickEl(archiveTab);
  check("finished step shows under Archive", textOf(document.body).includes("completed run step"));
  const reopen = buttons().find((b) => textOf(b).includes("Reopen"));
  check("finished step can be reopened", !!reopen);
  clickEl(reopen);
  const s2 = blob().steps.find((s) => s.id === "s2");
  check("reopened finished step returns to pending", s2?.status === "pending");
  check("reopening clears the finish/start stamps", s2?.finishedAt == null && s2?.startedAt == null);
  act(() => root.unmount());
}

// ---- 5d. Archive tab lists archived steps newest-first by persisted timestamp ----
console.log("case 5d: archive tab sorts newest archived step first");
{
  localStorage.setItem(KEY, JSON.stringify({
    text: "", plan: PLAN,
    steps: [
      { id: "active", text: "active pending step", status: "pending", ts: 1 },
      { id: "oldest", text: "oldest archived step", status: "done", ts: 2, archivedAt: 1000 },
      { id: "middle", text: "middle archived step", status: "sent", ts: 3, startedAt: 2000, finishedAt: 2500, archivedAt: 2500 },
      { id: "newest", text: "newest archived step", status: "done", ts: 4, archivedAt: 5000 },
    ],
    autoFeed: false, digest: [],
  }));
  const { root } = mount({});
  check("active step is visible by default", textOf(document.body).includes("active pending step"));
  check("archived steps are hidden by default", !textOf(document.body).includes("oldest archived step"));
  const archiveTab = buttons().find((b) => b.getAttribute("role") === "tab" && textOf(b).includes("Archive"));
  check("Archive tab shows count 3", !!archiveTab && textOf(archiveTab).includes("(3)"));
  clickEl(archiveTab);
  const html = document.body.innerHTML;
  check("newest archived step appears before middle", html.indexOf("newest archived step") < html.indexOf("middle archived step"));
  check("middle archived step appears before oldest", html.indexOf("middle archived step") < html.indexOf("oldest archived step"));
  act(() => root.unmount());
}

// ---- 5dd. The Archive button archives an active step without deleting it ----
console.log("case 5dd: Archive button moves an active step to the Archive tab");
{
  localStorage.setItem(KEY, JSON.stringify({
    text: "", plan: PLAN,
    steps: [{ id: "to-archive", text: "step to archive", status: "pending", ts: 1 }],
    autoFeed: false, digest: [],
  }));
  const { root } = mount({});
  check("active step is visible by default", textOf(document.body).includes("step to archive"));
  const archiveBtn = buttons().find((b) => b.getAttribute("aria-label") === "Archive step");
  check("Archive button is present with correct aria-label", !!archiveBtn);
  check("Archive button is visibly labeled", !!archiveBtn && textOf(archiveBtn).includes("Archive"));
  check("Archive button uses the archive icon", !!archiveBtn && !!archiveBtn.querySelector('svg[data-icon="archive"]'));
  const trashBtn = buttons().find((b) => b.getAttribute("aria-label") === "Delete step");
  check("Delete step button remains beside Archive", !!trashBtn);
  check("no Mark done control remains in the active card", !buttons().some((b) => b.getAttribute("title")?.includes("Mark done")));
  clickEl(archiveBtn);
  check("archived step leaves the Active tab", !textOf(document.body).includes("step to archive"));
  check("step is not deleted from the notebook", blob().steps.some((s) => s.id === "to-archive"));
  check("step has archivedAt set", typeof blob().steps.find((s) => s.id === "to-archive")?.archivedAt === "number");
  const archiveTab = buttons().find((b) => b.getAttribute("role") === "tab" && textOf(b).includes("Archive"));
  check("Archive tab shows count 1", !!archiveTab && textOf(archiveTab).includes("(1)"));
  clickEl(archiveTab);
  check("archived step appears in the Archive tab", textOf(document.body).includes("step to archive"));
  check("archive lifecycle timestamp is persisted", typeof blob().steps.find((s) => s.id === "to-archive")?.stepUpdatedAt === "number");
  act(() => root.unmount());
}

// ---- 5de. Archiving an in-flight card closes its visible timing instead of
//            leaving a completed card labelled "running" forever. ----
console.log("case 5de: manually archiving an in-flight card stamps completion");
{
  localStorage.setItem(KEY, JSON.stringify({
    text: "", plan: PLAN,
    steps: [{ id: "in-flight", text: "manual completion", status: "sent", ts: 1, startedAt: 1000 }],
    autoFeed: false, digest: [],
  }));
  const { root } = mount({});
  clickEl(buttons().find((b) => b.getAttribute("aria-label") === "Archive step"));
  const archived = blob().steps.find((s) => s.id === "in-flight");
  check("manual archive stamps a finish time", typeof archived?.finishedAt === "number");
  clickEl(buttons().find((b) => b.getAttribute("role") === "tab" && textOf(b).includes("Archive")));
  check("archived timing no longer says running", !textOf(document.body).includes("running"));
  act(() => root.unmount());
}

// ---- 5e. archivedAt survives save/load/restart ----
console.log("case 5e: archive timestamp persists across save and reload");
{
  localStorage.setItem(KEY, JSON.stringify({
    text: "", plan: PLAN,
    steps: [
      { id: "legacy", text: "legacy done step", status: "done", ts: 1 },
      { id: "dated", text: "dated archived step", status: "done", ts: 2, archivedAt: 9999 },
    ],
    autoFeed: false, digest: [],
  }));
  const loaded = NB.loadNotebook(PID);
  check("load preserves explicit archivedAt", loaded.steps.find((s) => s.id === "dated")?.archivedAt === 9999);
  check("legacy done step falls back to ts", (loaded.steps.find((s) => s.id === "legacy")?.archivedAt ?? loaded.steps.find((s) => s.id === "legacy")?.ts) === 1);
  NB.saveNotebook(PID, loaded);
  const reloaded = NB.loadNotebook(PID);
  check("reloaded keeps archivedAt", reloaded.steps.find((s) => s.id === "dated")?.archivedAt === 9999);
  check("reloaded keeps fallback ts for legacy", (reloaded.steps.find((s) => s.id === "legacy")?.archivedAt ?? reloaded.steps.find((s) => s.id === "legacy")?.ts) === 1);
  const { root } = mount({});
  clickEl(buttons().find((b) => b.getAttribute("role") === "tab" && textOf(b).includes("Archive")));
  const html = document.body.innerHTML;
  check("newest archived step is first after reload", html.indexOf("dated archived step") < html.indexOf("legacy done step"));
  act(() => root.unmount());
}

// ---- 6. auto-feed ownership: only the owning surface pops the queue ----
console.log("case 6: takeNextAutoStep is gated per surface");
{
  seed(); // autoFeed on, NO owner (legacy blob)
  const { takeNextAutoStep } = NB;
  const first = takeNextAutoStep(PID, "agents:main");
  check("legacy blob feeds and is adopted", first?.id === "s1" && blob().autoFeedOwner === "agents:main");
  check("auto-fed step gets a fresh start time", typeof first?.startedAt === "number" && typeof blob().steps.find((s) => s.id === "s1")?.startedAt === "number");
  const stolen = takeNextAutoStep(PID, "code:other-page");
  check("a different page gets NOTHING", stolen === null);
  check("its step is still pending", blob().steps.find((s) => s.id === "s2")?.status === "pending");
  const second = takeNextAutoStep(PID, "agents:main");
  check("the owner keeps walking the queue", second?.id === "s2");
}

// ---- 6b. Repeated clean run completions walk beyond the first card ----
console.log("case 6b: clean completions walk the complete auto-feed queue");
{
  seed();
  const dispatched = [];
  const dispatch = (step) => dispatched.push(step.id);
  check("first completion dispatches card one", NB.continueNotebookAutoFeed(PID, "agents:main", dispatch) === "dispatched" && dispatched.join(",") === "s1");
  NB.markNotebookStepFinished(PID, "s1", 2000);
  check("second completion dispatches card two", NB.continueNotebookAutoFeed(PID, "agents:main", dispatch) === "dispatched" && dispatched.join(",") === "s1,s2");
  NB.markNotebookStepFinished(PID, "s2", 3000);
  check("final completion closes the sequence", NB.continueNotebookAutoFeed(PID, "agents:main", dispatch) === "finished" && typeof blob().autoFeedFinishedAt === "number");
}

// ---- 7. autoFeedWouldRun mirrors the same gate ----
console.log("case 7: autoFeedWouldRun respects owner + pending");
{
  seed();
  localStorage.setItem(KEY, JSON.stringify({ ...blob(), autoFeedOwner: "agents:main" }));
  const { autoFeedWouldRun } = NB;
  check("true for the owning surface", autoFeedWouldRun(PID, "agents:main") === true);
  // A named owner with NO live heartbeat is a window that closed mid-queue.
  // This gate used to require `false` here — certifying the exact stall the
  // user hit: no dispatch, and no "auto-feed paused" notice either, because
  // this very function suppressed it. A dead owner must release.
  check("a dead owner releases to another surface", autoFeedWouldRun(PID, "code:p2") === true);
  localStorage.setItem(KEY, JSON.stringify({ ...blob(), autoFeedOwner: "agents:main", autoFeedHeartbeat: Date.now() }));
  check("a LIVE owner still locks another surface out", autoFeedWouldRun(PID, "code:p2") === false);
  localStorage.setItem(KEY, JSON.stringify({ ...blob(), autoFeed: false }));
  check("false when the toggle is off", autoFeedWouldRun(PID, "agents:main") === false);
}

// ---- 8. the owning window drives; a live spectator must take over to control ----
console.log("case 8: a live queue owner locks other windows until they take over");
{
  localStorage.setItem(KEY, JSON.stringify({ text: "", plan: PLAN, steps: [{ id: "s1", text: "step", status: "pending", ts: 1 }], autoFeed: false, digest: [] }));
  const m1 = mount({ surfaceId: "code:p1" });
  clickEl(document.querySelector("input[type=checkbox]"));
  check("checking ON records this page as owner", blob().autoFeed === true && blob().autoFeedOwner === "code:p1");
  check("turning it on beats a heartbeat", typeof blob().autoFeedHeartbeat === "number");
  act(() => m1.root.unmount());
  const m2 = mount({ surfaceId: "code:p2" });
  check("another window is locked to the live owner", textOf(document.body).includes("Queue runs in another window"));
  check("the spectator cannot pop the queue", NB.takeNextAutoStep(PID, "code:p2") === null);
  check("no auto-feed checkbox for the spectator", !document.querySelector("input[type=checkbox]"));
  clickEl(buttons().find((b) => textOf(b).includes("Take over")));
  check("taking over hands the queue to this window", blob().autoFeedOwner === "code:p2");
  check("after takeover the checkbox is back", !!document.querySelector("input[type=checkbox]"));
  clickEl(document.querySelector("input[type=checkbox]"));
  check("the new owner can stop it", blob().autoFeed === false && blob().autoFeedOwner === undefined);
  act(() => m2.root.unmount());
}

// ---- 8b. a STALE owner (window closed mid-queue → heartbeat lapsed) does NOT
//          lock other windows: Start queue takes over instead of stranding. ----
console.log("case 8b: a stale (dead) owner never strands the queue");
{
  localStorage.setItem(KEY, JSON.stringify({
    text: "", plan: PLAN, steps: [{ id: "s1", text: "step", status: "pending", ts: 1 }],
    autoFeed: true, autoFeedOwner: "code:dead-window", autoFeedHeartbeat: 1, // ancient beat
    digest: [],
  }));
  const { root } = mount({ surfaceId: "code:live-window" });
  check("a lapsed owner does not lock this window", !textOf(document.body).includes("Queue runs in another window"));
  const startBtn = buttons().find((b) => textOf(b).includes("Start queue"));
  check("Start queue is enabled to take over a dead owner", !!startBtn && !startBtn.disabled);
  act(() => root.unmount());
}

// ---- 9. a queue started in another WINDOW is ghosted (read-only) here ----
console.log("case 9: a queue owned by another window is ghosted here");
{
  seed();
  localStorage.setItem(KEY, JSON.stringify({ ...blob(), autoFeed: true, autoFeedOwner: "code:other-window", autoFeedHeartbeat: Date.now() }));
  const { root } = mount({ surfaceId: "code:this-window" });
  check("shows the queue runs in another window", textOf(document.body).includes("Queue runs in another window"));
  check("no auto-feed checkbox while locked", !document.querySelector("input[type=checkbox]"));
  const startBtn = buttons().find((b) => textOf(b).includes("Start queue"));
  check("Start queue is disabled here", !!startBtn && startBtn.disabled);
  const stepFeed = buttons().find((b) => textOf(b) === "Feed" || textOf(b).includes("Re-feed") || /(^|>)Feed$/.test(textOf(b)));
  check("per-step Feed is disabled here", !!stepFeed && stepFeed.disabled);
  const takeOver = buttons().find((b) => textOf(b).includes("Take over"));
  check("a Take over control is offered", !!takeOver);
  clickEl(takeOver);
  check("taking over makes THIS window the owner", blob().autoFeedOwner === "code:this-window");
  act(() => root.unmount());
}

// ---- 9b. the OWNING window keeps full control (not ghosted) ----
console.log("case 9b: the owning window is not ghosted");
{
  seed();
  localStorage.setItem(KEY, JSON.stringify({ ...blob(), autoFeed: true, autoFeedOwner: "code:mine", autoFeedHeartbeat: Date.now() }));
  const { root } = mount({ surfaceId: "code:mine" });
  check("owner sees no locked banner", !textOf(document.body).includes("Queue runs in another window"));
  check("owner keeps the auto-feed checkbox", !!document.querySelector("input[type=checkbox]"));
  const startBtn = buttons().find((b) => textOf(b).includes("Start queue"));
  check("owner Start queue is enabled", !!startBtn && !startBtn.disabled);
  act(() => root.unmount());
}

// ---- 9c. an idle Start queue claims the lease even with auto-feed OFF, so a
//          plain (non-auto) queue is still owned by the starting window ----
console.log("case 9c: Start queue claims the window lease even with auto-feed off");
{
  localStorage.setItem(KEY, JSON.stringify({ text: "", plan: PLAN, steps: [{ id: "s1", text: "only step", status: "pending", ts: 1 }], autoFeed: false, digest: [] }));
  const { root } = mount({ surfaceId: "code:starter", onFeed: () => "dispatched" });
  clickEl(buttons().find((b) => textOf(b).includes("Start queue")));
  check("starting claims ownership without turning auto-feed on", blob().autoFeedOwner === "code:starter" && blob().autoFeed !== true);
  act(() => root.unmount());
  // A different window now sees the in-flight (sent, unfinished) queue as locked.
  const m2 = mount({ surfaceId: "code:bystander" });
  check("another window is locked out of the in-flight queue", textOf(document.body).includes("Queue runs in another window"));
  act(() => m2.root.unmount());
}

// ---- 8b. a STALE owner (window closed mid-queue → heartbeat lapsed) does NOT
//          lock other windows: Start queue takes over instead of stranding. ----
console.log("case 8b: a stale (dead) owner never strands the queue");
{
  localStorage.setItem(KEY, JSON.stringify({
    text: "", plan: PLAN, steps: [{ id: "s1", text: "step", status: "pending", ts: 1 }],
    autoFeed: true, autoFeedOwner: "code:dead-window", autoFeedHeartbeat: 1, // ancient beat
    digest: [],
  }));
  const { root } = mount({ surfaceId: "code:live-window" });
  check("a lapsed owner does not lock this window", !textOf(document.body).includes("Queue runs in another window"));
  const startBtn = buttons().find((b) => textOf(b).includes("Start queue"));
  check("Start queue is enabled to take over a dead owner", !!startBtn && !startBtn.disabled);
  act(() => root.unmount());
}

// ---- 9. a queue started in another WINDOW is ghosted (read-only) here ----
console.log("case 9: a queue owned by another window is ghosted here");
{
  seed();
  localStorage.setItem(KEY, JSON.stringify({ ...blob(), autoFeed: true, autoFeedOwner: "code:other-window", autoFeedHeartbeat: Date.now() }));
  const { root } = mount({ surfaceId: "code:this-window" });
  check("shows the queue runs in another window", textOf(document.body).includes("Queue runs in another window"));
  check("no auto-feed checkbox while locked", !document.querySelector("input[type=checkbox]"));
  const startBtn = buttons().find((b) => textOf(b).includes("Start queue"));
  check("Start queue is disabled here", !!startBtn && startBtn.disabled);
  const stepFeed = buttons().find((b) => textOf(b) === "Feed" || textOf(b).includes("Re-feed") || /(^|>)Feed$/.test(textOf(b)));
  check("per-step Feed is disabled here", !!stepFeed && stepFeed.disabled);
  const takeOver = buttons().find((b) => textOf(b).includes("Take over"));
  check("a Take over control is offered", !!takeOver);
  clickEl(takeOver);
  check("taking over makes THIS window the owner", blob().autoFeedOwner === "code:this-window");
  act(() => root.unmount());
}

// ---- 9b. the OWNING window keeps full control (not ghosted) ----
console.log("case 9b: the owning window is not ghosted");
{
  seed();
  localStorage.setItem(KEY, JSON.stringify({ ...blob(), autoFeed: true, autoFeedOwner: "code:mine", autoFeedHeartbeat: Date.now() }));
  const { root } = mount({ surfaceId: "code:mine" });
  check("owner sees no locked banner", !textOf(document.body).includes("Queue runs in another window"));
  check("owner keeps the auto-feed checkbox", !!document.querySelector("input[type=checkbox]"));
  const startBtn = buttons().find((b) => textOf(b).includes("Start queue"));
  check("owner Start queue is enabled", !!startBtn && !startBtn.disabled);
  act(() => root.unmount());
}

// ---- 9c. an idle Start queue claims the lease even with auto-feed OFF, so a
//          plain (non-auto) queue is still owned by the starting window ----
console.log("case 9c: Start queue claims the window lease even with auto-feed off");
{
  localStorage.setItem(KEY, JSON.stringify({ text: "", plan: PLAN, steps: [{ id: "s1", text: "only step", status: "pending", ts: 1 }], autoFeed: false, digest: [] }));
  const { root } = mount({ surfaceId: "code:starter", onFeed: () => "dispatched" });
  clickEl(buttons().find((b) => textOf(b).includes("Start queue")));
  check("starting claims ownership without turning auto-feed on", blob().autoFeedOwner === "code:starter" && blob().autoFeed !== true);
  act(() => root.unmount());
  // A different window now sees the in-flight (sent, unfinished) queue as locked.
  const m2 = mount({ surfaceId: "code:bystander" });
  check("another window is locked out of the in-flight queue", textOf(document.body).includes("Queue runs in another window"));
  act(() => m2.root.unmount());
}

// ---- 10. Accepting the digest's proposed steps ("Add all + clear notes")
//          MUST clear the working notes — even when the digest also set a
//          proposedPlan. With the Kanban board hidden (SHOW_KANBAN=false) the
//          plan's own clear button never renders, so a leftover proposedPlan
//          used to strand the notes forever (the recurring "notes won't clear"
//          complaint). ----
console.log("case 10: Add all + clear notes actually clears the working notes");
{
  localStorage.setItem(KEY, JSON.stringify({
    text: "raw brainstorm notes the digest already consumed",
    plan: PLAN,
    steps: [],
    autoFeed: false,
    digest: [],
    proposed: ["implement step A", "implement step B"],
    // The exact trigger: a non-empty proposed plan the hidden board can't apply.
    proposedPlan: "NOW:\n- something the hidden board would show",
  }));
  const { root } = mount({});
  const addAll = buttons().find((b) => textOf(b).includes("Add all"));
  check("Add all + clear notes button is present with proposed steps", !!addAll);
  clickEl(addAll);
  const after = blob();
  check("all proposed steps are added to the list", after.steps.map((s) => s.text).join("|") === "implement step A|implement step B");
  check("proposed steps are consumed", (after.proposed ?? []).length === 0);
  check("working notes are cleared even with a leftover proposedPlan", after.text === "");
  check("orphaned proposedPlan is cleared while the board is hidden", (after.proposedPlan ?? "") === "");
  act(() => root.unmount());
}

// ---- 11. A run the QUEUE DID NOT DISPATCH must never start the queue. This
//          reproduces a real incident: auto-feed had been left on days earlier,
//          the user typed an ordinary Coding-page message, the turn ended
//          cleanly, and the run-end hook popped a notebook card and sent it as
//          the next turn — indistinguishable from something the user had asked
//          for. `autoFeed` is sticky across restarts, so the checkbox alone can
//          never be the permission to BEGIN a chain. ----
console.log("case 11: only a queue-driven (or explicitly armed) run advances the queue");
{
  const ARM_PID = "verify-arm-project";
  const ARM_KEY = `owllm:agents:notebook:${ARM_PID}`;
  const SURFACE = "code:pFRESH";
  const seedArm = (extra) => localStorage.setItem(ARM_KEY, JSON.stringify({
    text: "", plan: "", digest: [], proposed: [],
    autoFeed: true, // left ON from an earlier session — exactly the real state
    steps: [
      { id: "s1", text: "build the website package", status: "pending" },
      { id: "s2", text: "build the homepage", status: "pending" },
    ],
    ...extra,
  }));

  // Assert the export before calling it, so a removed gate reads as a failed
  // check rather than an unexplained stack trace.
  check("consumeAutoFeedArm is exported", typeof NB.consumeAutoFeedArm === "function");
  const consumeArm = typeof NB.consumeAutoFeedArm === "function" ? NB.consumeAutoFeedArm : () => true;

  seedArm();
  check("an unarmed clean turn cannot start the queue", consumeArm(ARM_PID, SURFACE) === false);
  check("  ...and leaves every card pending", NB.loadNotebook(ARM_PID).steps.every((s) => s.status === "pending"));

  seedArm({ autoFeedArmed: true });
  check("▶ Start queue while busy arms exactly one run", consumeArm(ARM_PID, SURFACE) === true);
  check("  ...and the arm is one-shot", consumeArm(ARM_PID, SURFACE) === false);

  // Once the chain is live it sustains itself from its own dispatches, so the
  // arm must be spent rather than left able to start a second queue later.
  seedArm({ autoFeedArmed: true });
  check("the chain still walks the list", NB.takeNextAutoStep(ARM_PID, SURFACE)?.id === "s1" && NB.takeNextAutoStep(ARM_PID, SURFACE)?.id === "s2");
  check("dispatching clears the arm", NB.loadNotebook(ARM_PID).autoFeedArmed === false);

  // The arm is a per-window intent: a peer that is genuinely driving still wins.
  seedArm({ autoFeedArmed: true, autoFeedOwner: "agents:pOTHER", autoFeedHeartbeat: Date.now() });
  check("a live peer lease still blocks the arm", consumeArm(ARM_PID, SURFACE) === false);

  // ...and it must never travel to another PC, or a peer would start a queue
  // nobody asked it to. Same rule as the rest of the run lease.
  check("the arm is stripped before the notebook syncs", vaultSyncSrc.includes('"autoFeedArmed"'));

  // Both pages gate on provenance, and the Coding page labels what it injects
  // (an unlabelled auto-fed step is why the incident looked like a user turn).
  check("Coding page gates the chain on run provenance", codePageSrc.includes("if (ok && (ranFromNotebook || consumeAutoFeedArm("));
  check("Coding page labels an auto-fed step", codePageSrc.includes("📓 Next step from the Notebook (auto-fed):"));
  check("Agents page arms or refuses inside the shared scheduler", agentsPageSrc.includes("if (!ranFromNotebook && !consumeAutoFeedArm(pid, notebookSurfaceId)) return;"));
  // The old pause notice told the user a plain message would resume the queue —
  // the very accident this case exists to prevent. It must not say that again.
  check("no page still advertises 'send a message' as a way to resume", !codePageSrc.includes("send a message or press ▶ Start queue") && !agentsPageSrc.includes("fix or dispatch the next one (▶ Start queue)"));
}

console.log(failures ? `\n${failures} FAILURES` : "\nall checks passed");
process.exit(failures ? 1 : 0);
