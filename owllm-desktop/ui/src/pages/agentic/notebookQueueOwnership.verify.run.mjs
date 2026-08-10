// One-shot verify for CROSS-DEVICE queue ownership.
//
// notebookQueueGithubSync proves the queue is one shared DOCUMENT. This proves
// only one device may DRIVE it. Those are different problems: two PCs that see
// the same in-progress queue will both happily feed job 1 unless something
// stops the second one, and "the same job ran twice on two machines" is the
// expensive failure — duplicated agent runs, duplicated commits.
//
// What must hold:
//   1. Exactly one device holds the active run lock. Device B cannot restart
//      A's in-progress queue from job 1.
//   2. A heartbeat renews the lock, and an expiry releases it if the owner
//      disappears — so a crashed PC never strands the queue forever.
//   3. B's view advances as A completes jobs ("job N of M").
//   4. Ownership transfers on explicit takeover, and the loser stands down.
//   5. A write that loses the revision check re-pulls and reconciles instead of
//      overwriting the other device's progress.
//   6. No job is ever executed twice.
//
// CLOCK SKEW IS MODELLED, not assumed away. The two devices below run clocks
// two hours apart, because that is the documented hazard in this codebase: the
// lease must never be decided by comparing one PC's wall clock to another's.
// A harness with synchronized clocks would pass a lock that skew would break.
//
// Two devices = two module registries: each gets its OWN RunNotebook and
// vaultSync instance, its own device identity, and its own localStorage. A
// single shared instance would let module-level state leak between the PCs and
// quietly fake the result.
//
// Run from owllm-desktop/:  node ui/src/pages/agentic/notebookQueueOwnership.verify.run.mjs
import { pathToFileURL, fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../..");   // ui/src
const APP = path.resolve(SRC, "../..");    // owllm-desktop
const ts = (await import(pathToFileURL(path.join(APP, "node_modules/typescript/lib/typescript.js")).href)).default;

const readLF = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const runNotebookSrc = readLF(path.join(HERE, "RunNotebook.tsx"));
const vaultSyncSrc = readLF(path.join(SRC, "runtime", "vaultSync.ts"));

let failures = 0;
function check(name, cond) {
  if (cond) console.log("  ok  " + name);
  else { console.error("  FAIL " + name); failures++; }
}

// ------------------------------------------------------- devices + clock ----
// Device B's clock is two hours ahead of A's. Every helper below reads the
// clock of whichever device is "current", so any lease rule that compares a
// peer stamp to the local clock is off by 7_200_000 ms and cannot survive.
const SKEW_MS = 7_200_000;
const clocks = { A: 1_700_000_000_000, B: 1_700_000_000_000 + SKEW_MS };
const stores = { A: new Map(), B: new Map() };
let current = "A";
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [clocks[current]])); }
  static now() { return clocks[current]; }
};
/// Advance BOTH clocks by the same amount: real time passes for everyone. The
/// skew between them is constant, which is exactly what a skew is.
const advance = (ms) => { clocks.A += ms; clocks.B += ms; };

globalThis.localStorage = {
  getItem: (k) => (stores[current].has(k) ? stores[current].get(k) : null),
  setItem: (k, v) => stores[current].set(k, String(v)),
  removeItem: (k) => stores[current].delete(k),
  key: (i) => [...stores[current].keys()][i],
  get length() { return stores[current].size; },
};

// One event bus PER DEVICE. Two PCs do not share a window: if they did, a queue
// event raised on A would also wake B's sync engine, which then publishes B's
// own copy over A's — the harness would be modelling a bug that does not exist
// and hiding the behaviour under test.
const buses = { A: new Map(), B: new Map() };
globalThis.window = {
  addEventListener: (t, fn) => { const m = buses[current]; if (!m.has(t)) m.set(t, []); m.get(t).push(fn); },
  removeEventListener: (t, fn) => { const a = buses[current].get(t) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
  dispatchEvent: (ev) => { for (const fn of buses[current].get(ev.type) || []) fn(ev); return true; },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
};
globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" };
globalThis.sessionStorage = { getItem: () => null, setItem() {} };
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
const drain = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r)); };

// ------------------------------------------------------------- sandbox ----
const TMP = fs.mkdtempSync(path.join(APP, "node_modules", ".nbown-"));
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
w("_noop.js", `
  const React = require("react");
  const stub = () => React.createElement("div", null);
  module.exports = new Proxy({ __esModule: true, default: stub }, {
    get: (t, k) => (k in t ? t[k] : (typeof k === "string" ? stub : undefined)),
  });
`);
w("notebookMerge.js", toCjs(readLF(path.join(SRC, "runtime", "notebookMerge.ts")), false));

const nbJs = toCjs(runNotebookSrc, true)
  .replace(/require\("\.\.\/\.\.\/hooks\/useAutoResize"\)/g, 'require("./_noop.js")')
  .replace(/require\("\.\.\/\.\.\/components\/LogBox"\)/g, 'require("./_noop.js")')
  .replace(/require\("\.\/dispatch"\)/g, 'require("./_noop.js")')
  .replace(/require\("\.\/ModelPicker"\)/g, 'require("./_noop.js")')
  .replace(/require\("\.\/RunTimer"\)/g, 'require("./_noop.js")')
  .replace(/require\("\.\.\/\.\.\/runtime\/renderingPolicy"\)/g, 'require("./_noop.js")')
  .replace(/require\("\.\.\/\.\.\/runtime\/notebookMerge"\)/g, 'require("./notebookMerge.js")')
  .replace(/require\("\.\/notebookDigestAura"\)/g, 'require("./_noop.js")')
  .replace(/require\("\.\.\/\.\.\/localization"\)/g, 'require("./_noop.js")')
  .replace(/require\("\.\.\/\.\.\/components\/ActionIcon"\)/g, 'require("./_noop.js")');

const vaultJs = toCjs(vaultSyncSrc, false)
  .replace(/require\("\.\.\/pages\/agentic\/github"\)/g, 'require("./_github.js")')
  .replace(/require\("\.\.\/pages\/advanced\/deviceLiveness"\)/g, 'require("./_deviceLiveness.js")')
  .replace(/require\("\.\/notebookMerge"\)/g, 'require("./notebookMerge.js")')
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
w("_vault.js", "module.exports = { blob: null, record: () => {} };");

for (const [id, dev, name] of [["A", "dev-A", "PC A"], ["B", "dev-B", "PC B"]]) {
  w(`_tauri${id}.js`, `
    const vault = require("./_vault.js");
    module.exports = { invoke: async (cmd, args) => {
      if (cmd === "device_get_id") return ${JSON.stringify(dev)};
      if (cmd === "device_get_identity") return { device_id: ${JSON.stringify(dev)}, name: ${JSON.stringify(name)} };
      if (cmd === "vault_write_state") { vault.record(${JSON.stringify(id)}, args.json); return null; }
      if (cmd === "vault_read_remote_state") return vault.blob;
      return null;
    } };
  `);
  w(`RunNotebook${id}.js`, nbJs.replace(/require\("@tauri-apps\/api\/core"\)/g, `require("./_tauri${id}.js")`));
  w(`vaultSync${id}.js`, vaultJs.replace(/require\("@tauri-apps\/api\/core"\)/g, `require("./_tauri${id}.js")`));
}

const reqTmp = createRequire(path.join(TMP, "package.json"));
const sharedVault = reqTmp("./_vault.js");
const writes = { A: [], B: [] };
sharedVault.record = (who, json) => { writes[who].push(json); sharedVault.blob = json; };

const NB = { A: reqTmp("./RunNotebookA.js"), B: reqTmp("./RunNotebookB.js") };
const VS = { A: reqTmp("./vaultSyncA.js"), B: reqTmp("./vaultSyncB.js") };

// If a helper this gate exists to guard is missing, stand in a stub that says
// "no lock at all" — the state the pre-fix code was actually in. The checks
// then FAIL under their own names instead of the harness dying on a TypeError,
// which is what makes this file usable as a tripwire against older code.
const IF_ABSENT = {
  peerQueueLock: () => null,
  renewQueueLease: () => {},
  takeOverQueueHere: () => {},
  releaseQueueOwnership: () => {},
};
for (const id of ["A", "B"]) {
  for (const [name, stub] of Object.entries(IF_ABSENT)) {
    if (typeof NB[id][name] !== "function") NB[id][name] = stub;
  }
}

const PID = "verify-project";
const KEY = `owllm:agents:notebook:${PID}`;
const SURFACE = { A: "agents:A", B: "agents:B" };

/// Run `fn` as device `id`: its clock, its disk, its module instances.
const on = (id, fn) => { const prev = current; current = id; try { return fn(NB[id], VS[id]); } finally { current = prev; } };
/// Same, but stays "on" that device until its fire-and-forget work settles.
/// Draining outside the device context would let an async publish read the
/// OTHER PC's disk — an artefact of one process pretending to be two.
const act = async (id, fn) => {
  const prev = current; current = id;
  try { const r = await fn(NB[id], VS[id]); await drain(); return r; } finally { current = prev; }
};

/// Push whatever device `id` has, then let the other device pull it. This is
/// the only channel between the two PCs — exactly the bytes that crossed.
async function syncFrom(id) {
  const other = id === "A" ? "B" : "A";
  await act(id, (_nb, vs) => vs.pushNow(true));
  await act(other, (_nb, vs) => vs.pullNotebooksNow());
}

function seed(id, steps) {
  stores[id].clear();
  stores[id].set(KEY, JSON.stringify({ text: "", plan: "", digest: [], autoFeed: true, steps }));
}

const TWO_JOBS = [
  { id: "s1", text: "first job", status: "pending", ts: 1 },
  { id: "s2", text: "second job", status: "pending", ts: 2 },
];

// Bring both devices online and warm their identities.
for (const id of ["A", "B"]) {
  seed(id, TWO_JOBS.map((s) => ({ ...s })));
  await act(id, async (nb, vs) => { nb.warmNotebookDeviceIdentity(); await vs.onVaultConnected(); });
}
await drain();

// ------------------------------------------------------------- case 1 ----
console.log("case 1: device B cannot restart a queue that is running on device A");
{
  seed("A", TWO_JOBS.map((s) => ({ ...s })));
  seed("B", TWO_JOBS.map((s) => ({ ...s })));

  const startedOnA = await act("A", (nb) => nb.takeNextAutoStep(PID, SURFACE.A));
  check("device A started the queue", !!startedOnA && startedOnA.id === "s1");
  await syncFrom("A");

  const seenOnB = on("B", (nb) => nb.loadNotebook(PID));
  check("device B sees A's in-progress queue", seenOnB.steps[0].status === "sent");
  check("device B is told the run owner is A", seenOnB.runningOn?.deviceId === "dev-A");

  const lock = on("B", (nb) => nb.peerQueueLock(PID, nb.loadNotebook(PID)));
  check("device B reports the queue as LOCKED by a peer", !!lock && lock.live === true);
  check("...and names the owning device for the user", lock?.deviceName === "PC B" ? false : lock?.deviceName === "PC A");
  check("...and reports which job of how many", lock?.jobIndex === 0 && lock?.jobTotal === 2);

  const stolen = await act("B", (nb) => nb.takeNextAutoStep(PID, SURFACE.B));
  check("device B REFUSES to feed a job from A's queue", stolen === null);
  const afterB = on("B", (nb) => nb.loadNotebook(PID));
  check("...and B did not restart the queue from job 1",
    afterB.steps[0].status === "sent" && afterB.steps[0].startedAt === seenOnB.steps[0].startedAt);
  check("...and B left job 2 alone", afterB.steps[1].status === "pending");
  check("device A itself is NOT locked out of its own queue",
    on("A", (nb) => nb.peerQueueLock(PID, nb.loadNotebook(PID))) === null);
}

// ------------------------------------------------------------- case 2 ----
console.log("case 2: B's view advances as A completes jobs");
{
  await act("A", (nb) => nb.markNotebookStepFinished(PID, "s1"));
  await syncFrom("A");
  let onB = on("B", (nb) => nb.loadNotebook(PID));
  check("B sees job 1 finished", onB.steps[0].status === "sent" && onB.steps[0].finishedAt != null);
  check("B's job pointer advanced to job 2", onB.currentIndex === 1);

  const nextOnA = await act("A", (nb) => nb.takeNextAutoStep(PID, SURFACE.A));
  check("A moved on to job 2", !!nextOnA && nextOnA.id === "s2");
  await syncFrom("A");
  onB = on("B", (nb) => nb.loadNotebook(PID));
  check("B sees job 2 in flight", onB.steps[1].status === "sent" && onB.steps[1].finishedAt == null);
  const lock = on("B", (nb) => nb.peerQueueLock(PID, nb.loadNotebook(PID)));
  check("B still reads the lock as held, now on job 2 of 2", lock?.live === true && lock?.jobIndex === 1 && lock?.jobTotal === 2);
  check("B still refuses to feed", (await act("B", (nb) => nb.takeNextAutoStep(PID, SURFACE.B))) === null);
}

// ------------------------------------------------------------- case 3 ----
console.log("case 3: the heartbeat renews the lock while the owner is alive");
{
  // A holds the lock but publishes nothing new except its heartbeat. B must
  // keep seeing the lock as live purely because the beat VALUE keeps changing.
  seed("A", [{ id: "s1", text: "long job", status: "pending", ts: 1 }]);
  seed("B", [{ id: "s1", text: "long job", status: "pending", ts: 1 }]);
  await act("A", (nb) => nb.takeNextAutoStep(PID, SURFACE.A));
  await syncFrom("A");
  const ttl = Number((runNotebookSrc.match(/PEER_LEASE_TTL_MS\s*=\s*([0-9_]+)/) || [])[1]?.replace(/_/g, ""));
  const beatMs = Number((runNotebookSrc.match(/PEER_HEARTBEAT_MS\s*=\s*([0-9_]+)/) || [])[1]?.replace(/_/g, ""));
  check("a peer heartbeat interval is defined", Number.isFinite(beatMs) && beatMs > 0);
  check("a peer lease TTL is defined and tolerates missed beats",
    Number.isFinite(ttl) && ttl > beatMs * 2);

  // Four heartbeat periods — well past the TTL had nothing renewed it.
  let live = true;
  for (let i = 0; i < 4; i++) {
    advance(beatMs);
    on("B", (nb) => { live = live && nb.peerQueueLock(PID, nb.loadNotebook(PID))?.live === true; });
    await act("A", (nb) => nb.renewQueueLease(PID, SURFACE.A));
    await syncFrom("A");
  }
  advance(beatMs);
  const lock = on("B", (nb) => nb.peerQueueLock(PID, nb.loadNotebook(PID)));
  check("the lock stayed live across every heartbeat", live);
  check("...and is still live after a renewed beat", lock?.live === true);
  check("...so B still refuses to feed", (await act("B", (nb) => nb.takeNextAutoStep(PID, SURFACE.B))) === null);
  check("a renewal republishes the lease so the peer can see it", writes.A.length > 0);
}

// ------------------------------------------------------------- case 4 ----
console.log("case 4: the lock EXPIRES when the owner disappears");
{
  // A stops beating (crash / closed window). Nothing new is published. B must
  // release the lock after the TTL measured on B's OWN clock.
  const ttl = Number((runNotebookSrc.match(/PEER_LEASE_TTL_MS\s*=\s*([0-9_]+)/) || [])[1]?.replace(/_/g, ""));
  check("the lock is live before the owner goes quiet",
    on("B", (nb) => nb.peerQueueLock(PID, nb.loadNotebook(PID)))?.live === true);
  advance(ttl + 1_000);
  const lock = on("B", (nb) => nb.peerQueueLock(PID, nb.loadNotebook(PID)));
  check("the expired lock is reported as no longer live", !lock || lock.live === false);
  // The in-flight card is A's abandoned job; B recovers the queue by resetting
  // it, which is the same recovery a crashed window already gets on one PC.
  await act("B", (nb) => nb.releaseQueueOwnership(PID));
  const fed = await act("B", (nb) => nb.takeNextAutoStep(PID, SURFACE.B));
  check("device B can now drive the queue itself", !!fed && fed.id === "s1");
  check("...and B is recorded as the new run owner",
    on("B", (nb) => nb.loadNotebook(PID)).runningOn?.deviceId === "dev-B");
}

// ------------------------------------------------------------- case 5 ----
console.log("case 5: explicit takeover transfers ownership and the loser stands down");
{
  seed("A", TWO_JOBS.map((s) => ({ ...s })));
  seed("B", TWO_JOBS.map((s) => ({ ...s })));
  await act("A", (nb) => nb.takeNextAutoStep(PID, SURFACE.A));
  await syncFrom("A");
  check("B is locked out before the takeover",
    on("B", (nb) => nb.peerQueueLock(PID, nb.loadNotebook(PID)))?.live === true);

  await act("B", (nb) => nb.takeOverQueueHere(PID, SURFACE.B));
  const afterTakeover = on("B", (nb) => nb.loadNotebook(PID));
  check("the takeover makes B the run owner", afterTakeover.runningOn?.deviceId === "dev-B");
  check("...and B is no longer locked",
    on("B", (nb) => nb.peerQueueLock(PID, nb.loadNotebook(PID))) === null);
  check("...and the takeover did NOT reset the queue to job 1",
    afterTakeover.steps[0].status === "sent");

  await syncFrom("B");
  const onA = on("A", (nb) => nb.loadNotebook(PID));
  check("device A learns that B now owns the run", onA.runningOn?.deviceId === "dev-B");
  const lockOnA = on("A", (nb) => nb.peerQueueLock(PID, nb.loadNotebook(PID)));
  check("device A now reads the queue as locked elsewhere", lockOnA?.live === true && lockOnA.deviceName === "PC B");
  check("device A stands down and refuses to feed", (await act("A", (nb) => nb.takeNextAutoStep(PID, SURFACE.A))) === null);
}

// ------------------------------------------------------------- case 6 ----
console.log("case 6: a write that loses the revision check reconciles, never overwrites");
{
  // Device A holds a STALE in-memory copy: the peer's progress landed in
  // localStorage (via a pull) after A read the notebook. The classic lost
  // update — A's save must not roll the peer's finished job back to pending.
  seed("A", TWO_JOBS.map((s) => ({ ...s })));
  const stale = on("A", (nb) => nb.loadNotebook(PID));
  await act("A", (nb) => nb.saveNotebook(PID, { ...stale, text: "base" }));
  const base = on("A", (nb) => nb.loadNotebook(PID));

  // A newer revision lands underneath us — as a pull would write it.
  stores.A.set(KEY, JSON.stringify({
    ...base,
    text: "base",
    queueRev: base.queueRev + 5,
    steps: [
      { ...base.steps[0], status: "sent", startedAt: 10, finishedAt: 20, stepUpdatedAt: 20 },
      { ...base.steps[1] },
    ],
  }));

  // A now saves its STALE copy with an unrelated edit of its own.
  await act("A", (nb) => nb.saveNotebook(PID, { ...base, text: "my note" }));
  const after = on("A", (nb) => nb.loadNotebook(PID));
  check("the losing write kept the peer's finished job", after.steps[0].status === "sent" && after.steps[0].finishedAt === 20);
  check("...and did not resurrect it as pending", after.steps[0].status !== "pending");
  check("...while still landing this device's own edit", after.text === "my note");
  check("...and the revision moved past the copy it reconciled with", after.queueRev > base.queueRev + 5);
  check("...and the job pointer was recomputed from the reconciled list", after.currentIndex === 1);

  // A write that did NOT lose the race must stay a plain write.
  const fresh = on("A", (nb) => nb.loadNotebook(PID));
  await act("A", (nb) => nb.saveNotebook(PID, { ...fresh, text: "uncontended" }));
  check("an uncontended write still applies normally", on("A", (nb) => nb.loadNotebook(PID)).text === "uncontended");
}

// ------------------------------------------------------------- case 7 ----
console.log("case 7: no job is executed twice across a full two-device run");
{
  const jobs = [1, 2, 3, 4].map((n) => ({ id: `s${n}`, text: `job ${n}`, status: "pending", ts: n }));
  seed("A", jobs.map((s) => ({ ...s })));
  seed("B", jobs.map((s) => ({ ...s })));
  await syncFrom("A");

  const dispatched = [];
  // Both PCs try to drive the same queue, turn by turn. Only the lock holder
  // may win; the other must come back empty every single time.
  for (let round = 0; round < 6; round++) {
    for (const id of ["A", "B"]) {
      const got = await act(id, (nb) => nb.takeNextAutoStep(PID, SURFACE[id]));
      if (got) {
        dispatched.push(`${id}:${got.id}`);
        await syncFrom(id);
        await act(id, (nb) => nb.markNotebookStepFinished(PID, got.id));
        await syncFrom(id);
      }
      advance(1_000);
    }
  }
  const ids = dispatched.map((d) => d.split(":")[1]);
  check("every job ran", new Set(ids).size === 4);
  check("no job was executed twice", ids.length === new Set(ids).size);
  check("...and one device drove the whole queue", new Set(dispatched.map((d) => d.split(":")[0])).size === 1);
  const finalA = on("A", (nb) => nb.loadNotebook(PID));
  check("both devices agree the queue is drained",
    finalA.steps.every((s) => s.finishedAt != null));
}

// ------------------------------------------------------------- case 8 ----
console.log("case 8: the lock is decided WITHOUT comparing one PC's clock to another's");
{
  // The device that owns the run is two hours BEHIND the observer. A rule that
  // subtracts the peer's stamp from the local clock reads that as "two hours
  // stale" and unlocks instantly — the exact bug this codebase documented as
  // the reason the advisory was never a lock.
  seed("A", [{ id: "s1", text: "job", status: "pending", ts: 1 }]);
  seed("B", [{ id: "s1", text: "job", status: "pending", ts: 1 }]);
  await act("A", (nb) => nb.takeNextAutoStep(PID, SURFACE.A));
  await syncFrom("A");
  const seen = on("B", (nb) => nb.loadNotebook(PID));
  check("the owner's stamp really is skewed far from the observer's clock",
    Math.abs(clocks.B - seen.runningOn.at) >= SKEW_MS);
  check("the lock is still live despite the skew",
    on("B", (nb) => nb.peerQueueLock(PID, nb.loadNotebook(PID)))?.live === true);
  check("...so a skewed clock cannot let B double-drive the queue",
    (await act("B", (nb) => nb.takeNextAutoStep(PID, SURFACE.B))) === null);

  // And the reverse skew — a peer stamped in our FUTURE — must not pin the
  // lock open forever either. Expiry is measured on the observer's own clock.
  const ttl = Number((runNotebookSrc.match(/PEER_LEASE_TTL_MS\s*=\s*([0-9_]+)/) || [])[1]?.replace(/_/g, ""));
  advance(ttl + 1_000);
  check("an unchanged beat still expires on the observer's own clock",
    on("B", (nb) => nb.peerQueueLock(PID, nb.loadNotebook(PID)))?.live !== true);
}

// ------------------------------------------------------------- case 9 ----
console.log("case 9: ownership survives the merge, and the UI exposes the lock");
{
  // mergeNotebookLease must pick the run owner by the MONOTONIC revision, not
  // by whichever runningOn.at is numerically larger: the larger stamp belongs
  // to whichever PC's clock runs fast, which has nothing to do with who is
  // actually driving. This is the same skew that broke ordering elsewhere.
  current = "A";
  stores.A.set(KEY, JSON.stringify({
    text: "", plan: "", digest: [], autoFeed: true, steps: [], queueId: "q1",
    queueRev: 2, updatedAt: 500,
    runningOn: { deviceId: "dev-A", deviceName: "PC A", at: 9_999_999_999 },
  }));
  const remote = JSON.stringify({
    text: "", plan: "", digest: [], autoFeed: true, steps: [], queueId: "q1",
    queueRev: 7, updatedAt: 100,
    runningOn: { deviceId: "dev-B", deviceName: "PC B", at: 1 },
  });
  const merged = JSON.parse(VS.A.mergeNotebookLease(KEY, remote));
  check("the higher revision decides the run owner, not the higher timestamp",
    merged.runningOn?.deviceId === "dev-B");

  check("the queue control has a peer-locked state",
    /peerLocked/.test(runNotebookSrc));
  // Deliberately a lazy [\s\S] window, not [^}]: the label is a template
  // literal, so the first `}` inside it ends a `[^}]` scan long before
  // `disabled` and the check would pass whatever the control actually does.
  check("...whose control is disabled", /peerLocked:\s*\{[\s\S]{0,400}?disabled:\s*true/.test(runNotebookSrc));
  check("...and names the device and the job position",
    /Running on \$\{/.test(runNotebookSrc) && /job \$\{[^}]*jobIndex[^}]*\+\s*1\}\s*of\s*\$\{/.test(runNotebookSrc));
  check("...and an explicit takeover is offered", /takeOverQueueHere\(/.test(runNotebookSrc));
  check("the peer lock also gates feeding a single card",
    /peerLock/.test(runNotebookSrc) && /lockedElsewhere\s*\|\|\s*peerLock/.test(runNotebookSrc));
  check("the step merge is shared with the runtime layer, not duplicated",
    /from\s+"\.\/notebookMerge"/.test(vaultSyncSrc) && /notebookMerge/.test(runNotebookSrc));
}

console.log(failures ? `\n${failures} FAILURES` : "\nall checks passed");
process.exit(failures ? 1 : 0);
