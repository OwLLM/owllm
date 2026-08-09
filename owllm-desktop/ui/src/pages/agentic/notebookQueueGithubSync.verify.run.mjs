// One-shot verify for the notebook QUEUE as a shared, GitHub-backed document.
//
// A notebook must be the SAME object on every PC, including while a queue is
// running. That needs four things, and this harness proves each behaviourally
// rather than by reading the source:
//
//   1. A versioned queue document — queue id, ordered job list with per-job
//      status, current job index, run owner device, timestamps, and a MONOTONIC
//      revision counter. The revision is what makes two PCs orderable when
//      their wall clocks disagree (they do: vaultSync's own history shows peers
//      writing out-of-order stamps).
//   2. Starting a queue publishes it INSIDE the start action. Before this, the
//      only paths to the vault were a 5s snapshot poll feeding a 4s debounce,
//      so device B could not see a queue for ~9s — and if the run finished or
//      the window closed first, never.
//   3. Every job state transition publishes too (not just completion).
//   4. Device B opening the same notebook loads the IN-PROGRESS queue, not a
//      fresh/empty one.
//
// Two devices are modelled honestly: two separate module instances of the real
// vaultSync.ts, each with its own device id and its own localStorage backing
// store, exchanging exactly one blob — the bytes device A actually pushed.
//
// Run from owllm-desktop/:  node ui/src/pages/agentic/notebookQueueGithubSync.verify.run.mjs
import { pathToFileURL, fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../..");   // ui/src
const APP = path.resolve(SRC, "../..");    // owllm-desktop
const req = createRequire(path.join(APP, "package.json"));
const ts = (await import(pathToFileURL(path.join(APP, "node_modules/typescript/lib/typescript.js")).href)).default;

const readLF = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const runNotebookSrc = readLF(path.join(HERE, "RunNotebook.tsx"));
const vaultSyncSrc = readLF(path.join(SRC, "runtime", "vaultSync.ts"));

let failures = 0;
function check(name, cond) {
  if (cond) console.log("  ok  " + name);
  else { console.error("  FAIL " + name); failures++; }
}

// ---------------------------------------------------------------- shims ----
// Two backing maps = two PCs. `backing` selects whose disk we are on.
const storeA = new Map();
const storeB = new Map();
let backing = storeA;
globalThis.localStorage = {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
  key: (i) => [...backing.keys()][i],
  get length() { return backing.size; },
};

// A real (tiny) event bus: the queue helpers publish through an event so the
// runtime layer never has to import a page module. If the bus were a stub that
// dropped events, case 2 below would pass for the wrong reason.
const listeners = new Map();
// Any timer at or above this delay is a DEBOUNCE/POLL, never an immediate
// action. Refusing to schedule those is what makes "published within the start
// action" a real claim: nothing deferred can be responsible for the write.
const DEFERRED_MS = 1000;
let deferredScheduled = 0;
globalThis.window = {
  addEventListener: (t, fn) => { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
  removeEventListener: (t, fn) => { const a = listeners.get(t) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
  dispatchEvent: (ev) => { for (const fn of listeners.get(ev.type) || []) fn(ev); return true; },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
};
globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" };
globalThis.sessionStorage = { getItem: () => null, setItem() {} };
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => {
  if (typeof ms === "number" && ms >= DEFERRED_MS) { deferredScheduled++; return 0; }
  return realSetTimeout(fn, ms, ...rest);
};
globalThis.clearTimeout = (id) => { if (id) clearTimeout(id); };
const drain = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r)); };

// ------------------------------------------------------------- sandbox ----
// Built inside node_modules so `require("react")` resolves by walking up,
// instead of copying react/react-dom in on every run (that leaked ~4 MB a run
// in a sibling harness).
const TMP = fs.mkdtempSync(path.join(APP, "node_modules", ".nbqueue-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

const toCjs = (src, jsx) => ts.transpileModule(src, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
    ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}),
  },
}).outputText;

const w = (name, body) => fs.writeFileSync(path.join(TMP, name), body);
w("package.json", "{}");

// RunNotebook: only its exported queue helpers are exercised, but the module
// imports React and siblings at load, so those are stubbed.
w("RunNotebook.js", toCjs(runNotebookSrc, true)
  .replace(/require\("\.\.\/\.\.\/hooks\/useAutoResize"\)/g, 'require("./_noop.js")')
  .replace(/require\("\.\.\/\.\.\/components\/LogBox"\)/g, 'require("./_noop.js")')
  .replace(/require\("\.\/dispatch"\)/g, 'require("./_noop.js")')
  .replace(/require\("\.\/ModelPicker"\)/g, 'require("./_noop.js")')
  .replace(/require\("\.\/RunTimer"\)/g, 'require("./_noop.js")')
  .replace(/require\("\.\.\/\.\.\/runtime\/renderingPolicy"\)/g, 'require("./_noop.js")')
  .replace(/require\("\.\/notebookDigestAura"\)/g, 'require("./_noop.js")')
  .replace(/require\("\.\.\/\.\.\/localization"\)/g, 'require("./_noop.js")')
  .replace(/require\("\.\.\/\.\.\/components\/ActionIcon"\)/g, 'require("./_noop.js")')
  .replace(/require\("@tauri-apps\/api\/core"\)/g, 'require("./_tauriIdentity.js")'));
w("_noop.js", `
  const React = require("react");
  const stub = () => React.createElement("div", null);
  module.exports = new Proxy({ __esModule: true, default: stub }, {
    get: (t, k) => (k in t ? t[k] : (typeof k === "string" ? stub : undefined)),
  });
`);
w("_tauriIdentity.js", `
  module.exports = { invoke: async (cmd) =>
    (cmd === "device_get_identity" ? { device_id: "dev-A", name: "PC A" } : null) };
`);

// Two independent vaultSync instances. Separate FILES so each gets its own
// module registry entry (and therefore its own cached device id + enable flag).
const vaultJs = toCjs(vaultSyncSrc, false)
  .replace(/require\("\.\.\/pages\/agentic\/github"\)/g, 'require("./_github.js")')
  .replace(/require\("\.\.\/pages\/advanced\/deviceLiveness"\)/g, 'require("./_deviceLiveness.js")')
  .replace(/require\("\.\/stateMirror"\)/g, 'require("./_stateMirror.js")');
w("_github.js", 'module.exports = { vaultEnsure: async () => ({ connected: true, cloned: true }), vaultStatus: async () => ({ connected: true, cloned: true }) };');
w("_deviceLiveness.js", "module.exports = { REMOTE_DEVICE_HEARTBEAT_MS: 150000 };");
w("_stateMirror.js", `
  const HOT = ${JSON.stringify(
  [...(readLF(path.join(SRC, "runtime", "stateMirror.ts")).split("export const HOT_BLOB_PREFIXES")[1] ?? "")
    .split("]")[0].matchAll(/"([^"]+)"/g)].map((m) => m[1]),
)};
  const m = new Map();
  module.exports = {
    hotBlobKeys: () => [...m.keys()],
    readHotBlob: (k) => (m.has(k) ? m.get(k) : null),
    writeHotBlob: (k, v) => { m.set(k, String(v)); },
    isHotBlobKey: (k) => HOT.some((p) => k.startsWith(p)),
  };
`);

// The shared "GitHub vault": exactly one blob, exchanged between the two
// instances. Writes are recorded with the wall-clock moment they landed.
const vault = { blob: null };
const writes = { A: [], B: [] };
for (const [id, dev] of [["A", "dev-A"], ["B", "dev-B"]]) {
  w(`vaultSync${id}.js`, vaultJs.replace(/require\("@tauri-apps\/api\/core"\)/g, `require("./_tauri${id}.js")`));
  w(`_tauri${id}.js`, `
    const vault = require("./_vault.js");
    module.exports = { invoke: async (cmd, args) => {
      if (cmd === "device_get_id") return ${JSON.stringify(dev)};
      if (cmd === "vault_write_state") { vault.record(${JSON.stringify(id)}, args.json); return null; }
      if (cmd === "vault_read_remote_state") return vault.blob;
      return null;
    } };
  `);
}
w("_vault.js", "module.exports = { blob: null, record: () => {} };");

const reqTmp = createRequire(path.join(TMP, "package.json"));
const sharedVault = reqTmp("./_vault.js");
sharedVault.record = (who, json) => { writes[who].push({ at: Date.now(), json }); sharedVault.blob = json; };

const NB = reqTmp("./RunNotebook.js");
const A = reqTmp("./vaultSyncA.js");
const B = reqTmp("./vaultSyncB.js");

const PID = "verify-project";
const KEY = `owllm:agents:notebook:${PID}`;
const notebookOf = (json) => { try { return JSON.parse(JSON.parse(json).data[KEY]); } catch { return null; } };
const lastPush = (who) => (writes[who].length ? notebookOf(writes[who][writes[who].length - 1].json) : null);

function seedA() {
  backing = storeA;
  storeA.clear();
  storeA.set(KEY, JSON.stringify({
    text: "", plan: "", digest: [],
    steps: [
      { id: "s1", text: "first job", status: "pending", ts: 1 },
      { id: "s2", text: "second job", status: "pending", ts: 2 },
    ],
    autoFeed: true,
  }));
}

// ------------------------------------------------------------- case 1 ----
console.log("case 1: the queue document is versioned (id, index, monotonic revision)");
{
  seedA();
  NB.warmNotebookDeviceIdentity();
  await drain();
  const started = NB.takeNextAutoStep(PID, "surface-A");
  const nb = NB.loadNotebook(PID);
  check("starting the queue pops the first job", started && started.id === "s1");
  check("the job list stays ordered", nb.steps.map((s) => s.id).join(",") === "s1,s2");
  check("the started job is no longer pending", nb.steps[0].status !== "pending");
  check("the untouched job is still pending", nb.steps[1].status === "pending");
  check("the document carries a queue id", typeof nb.queueId === "string" && nb.queueId.length > 0);
  check("the document carries the current job index", nb.currentIndex === 0);
  check("the document carries a monotonic revision", typeof nb.queueRev === "number" && nb.queueRev > 0);
  check("the run owner device is recorded", !!nb.runningOn && nb.runningOn.deviceId === "dev-A");

  const rev1 = nb.queueRev;
  const qid = nb.queueId;
  NB.markNotebookStepFinished(PID, "s1");
  const nb2 = NB.loadNotebook(PID);
  check("a job transition advances the revision", nb2.queueRev > rev1);
  check("and keeps the same queue id", nb2.queueId === qid);
  check("the revision never goes backwards across saves",
    NB.loadNotebook(PID).queueRev >= nb2.queueRev);
}

// ------------------------------------------------------------- case 2 ----
console.log("case 2: starting a queue publishes to GitHub INSIDE the start action");
{
  seedA();
  writes.A.length = 0;
  await A.onVaultConnected();       // device A comes online, seeds the vault
  await drain();
  const beforeCount = writes.A.length;
  const beforeDeferred = deferredScheduled;

  const t0 = Date.now();
  const started = NB.takeNextAutoStep(PID, "surface-A");
  await drain();
  const elapsed = Date.now() - t0;

  check("the start action returned a job", !!started);
  check("starting the queue wrote to the vault", writes.A.length > beforeCount);
  check("...without waiting for any debounce or poll", elapsed < DEFERRED_MS);
  check("...and no deferred timer was what published it",
    writes.A.length > beforeCount && deferredScheduled === beforeDeferred);

  const published = lastPush("A");
  check("the published document contains the queue", !!published && Array.isArray(published.steps));
  check("the published job is marked as running, not pending",
    !!published && published.steps[0].id === "s1" && published.steps[0].status !== "pending");
  check("the published document names the run owner",
    !!published && !!published.runningOn && published.runningOn.deviceId === "dev-A");
  check("the published document carries the queue id + revision",
    !!published && typeof published.queueId === "string" && typeof published.queueRev === "number");
}

// ------------------------------------------------------------- case 3 ----
console.log("case 3: every job state transition publishes too");
{
  const before = writes.A.length;
  NB.markNotebookStepFinished(PID, "s1");
  await drain();
  check("finishing a job publishes", writes.A.length > before);

  const beforeFail = writes.A.length;
  NB.markNotebookStepFailed(PID, "s2", "boom");
  await drain();
  check("failing a job publishes", writes.A.length > beforeFail);
  const failed = lastPush("A");
  check("the failure state reached the vault",
    !!failed && failed.steps.some((s) => s.id === "s2" && s.status === "failed"));
}

// ------------------------------------------------------------- case 4 ----
console.log("case 4: device B opening the notebook loads the IN-PROGRESS queue");
{
  // Rebuild a clean in-progress run on A so B adopts a queue mid-flight.
  seedA();
  writes.A.length = 0;
  NB.takeNextAutoStep(PID, "surface-A");
  await drain();
  const fromA = lastPush("A");
  check("device A published an in-progress queue", !!fromA && fromA.steps[0].status !== "pending");

  // Device B: a PC that has never seen this notebook.
  backing = storeB;
  storeB.clear();
  check("device B starts with no notebook at all", localStorage.getItem(KEY) === null);

  await B.onVaultConnected();
  await drain();
  // B pulls exactly the bytes A published. If A published nothing at all, the
  // remaining checks must FAIL rather than crash the harness.
  sharedVault.blob = writes.A.length ? writes.A[writes.A.length - 1].json : null;
  const changed = await B.pullNotebooksNow();
  check("opening the notebook on B adopts remote state", changed === true);

  const onB = NB.loadNotebook(PID);
  check("device B does NOT show a fresh/empty queue", onB.steps.length === 2);
  check("device B sees the in-progress job as running", onB.steps[0].status !== "pending");
  check("device B sees the remaining job as pending", onB.steps[1].status === "pending");
  check("device B sees the same queue id", onB.queueId === fromA.queueId);
  check("device B sees the current job index", onB.currentIndex === fromA.currentIndex);
  check("device B sees the revision", onB.queueRev === fromA.queueRev);
  check("device B is told which device owns the run",
    !!onB.runningOn && onB.runningOn.deviceId === "dev-A");
  check("...and B did not inherit A's run lease",
    onB.autoFeedOwner === undefined && onB.autoFeedHeartbeat === undefined);
  backing = storeA;
}

// ------------------------------------------------------------- case 5 ----
console.log("case 5: the revision counter survives clock skew");
{
  // The documented hazard: device clocks are not synchronized, so a peer can
  // publish a NEWER queue carrying an OLDER wall clock. Ordering by updatedAt
  // alone then rolls the queue back. The monotonic revision is the guard.
  backing = storeA;
  storeA.clear();
  storeA.set(KEY, JSON.stringify({
    text: "local", plan: "", digest: [], autoFeed: true, queueId: "q1", queueRev: 4, currentIndex: 0,
    updatedAt: 9_000_000,
    steps: [{ id: "s1", text: "job", status: "sent", ts: 1, stepUpdatedAt: 1 }],
  }));
  const remote = JSON.stringify({
    text: "peer wrote later", plan: "", digest: [], autoFeed: true, queueId: "q1", queueRev: 9, currentIndex: 1,
    updatedAt: 1_000,   // skewed BACKWARDS relative to ours
    steps: [{ id: "s1", text: "job", status: "done", ts: 1, stepUpdatedAt: 2 }],
  });
  const merged = JSON.parse(A.mergeNotebookLease(KEY, remote));
  check("a higher revision wins even with an older wall clock", merged.text === "peer wrote later");
  check("and the merged revision is the highest seen", merged.queueRev === 9);
  check("and the current index comes from the winning revision", merged.currentIndex === 1);

  // Same revision on both sides must fall back to the existing wall-clock rule,
  // so nothing about the legacy ordering changes.
  const sameRev = JSON.stringify({
    text: "older peer", plan: "", digest: [], autoFeed: true, queueId: "q1", queueRev: 4,
    updatedAt: 1_000,
    steps: [{ id: "s1", text: "job", status: "sent", ts: 1, stepUpdatedAt: 1 }],
  });
  check("equal revisions still defer to updatedAt", JSON.parse(A.mergeNotebookLease(KEY, sameRev)).text === "local");
}

// ------------------------------------------------------------- case 6 ----
console.log("case 6: publishing never blocks the notebook window");
{
  check("the queue publish path is async (never awaited by a save)",
    /export function saveNotebook/.test(runNotebookSrc)
    && !/await\s+[A-Za-z_$]*[Pp]ublish/.test(runNotebookSrc));
  check("saves reach the runtime layer by event, not a page->runtime import",
    !/from\s+"\.\.\/\.\.\/runtime\/vaultSync"/.test(runNotebookSrc));
  check("a running queue is pulled more often than an idle one",
    /NOTEBOOK_ACTIVE_PULL_MS/.test(vaultSyncSrc) && /NOTEBOOK_IDLE_PULL_MS/.test(vaultSyncSrc));
  const active = Number((vaultSyncSrc.match(/NOTEBOOK_ACTIVE_PULL_MS\s*=\s*([0-9_]+)/) || [])[1]?.replace(/_/g, ""));
  const idle = Number((vaultSyncSrc.match(/NOTEBOOK_IDLE_PULL_MS\s*=\s*([0-9_]+)/) || [])[1]?.replace(/_/g, ""));
  check("...and the active interval is genuinely shorter", active > 0 && idle > 0 && active < idle);
}

console.log(failures ? `\n${failures} FAILURES` : "\nall checks passed");
process.exit(failures ? 1 : 0);
