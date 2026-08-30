// One-shot verify for cross-PC notebook sync (ui/src/runtime/vaultSync.ts):
//   • The notebook CONTENT (notes/plan/steps) syncs across the user's PCs.
//   • Its RUN-LEASE (auto-feed on/off + which live window owns the queue + the
//     heartbeat + the sequence clock) is stripped before syncing and the LOCAL
//     lease is preserved on adopt, so a peer PC never inherits a queue owner and
//     two windows can't drive the one team.
//   • Adopting newer remote state repaints open notebooks (owllm:notebook-changed).
//
// Transpiles the REAL vaultSync.ts to CJS with stubbed Tauri/github deps and a
// tiny localStorage shim, then exercises the exported strip/merge helpers.
import { pathToFileURL, fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../..");          // ui/src
const APP = path.resolve(SRC, "../..");           // owllm-desktop
const req = createRequire(path.join(APP, "package.json"));
const ts = (await import(pathToFileURL(path.join(APP, "node_modules/typescript/lib/typescript.js")).href)).default;

const readLF = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const vaultSyncPath = path.join(SRC, "runtime", "vaultSync.ts");
const rawSrc = readLF(vaultSyncPath);

// ---- localStorage / window shims (module import must not touch a real DOM) --
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  key: (i) => [...store.keys()][i],
  get length() { return store.size; },
};
globalThis.window = { addEventListener() {}, dispatchEvent() { return true; }, setInterval() { return 0; }, setTimeout() { return 0; } };
globalThis.document = { addEventListener() {}, visibilityState: "visible" };
globalThis.sessionStorage = { getItem: () => null, setItem() {} };
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };

// ---- transpile vaultSync.ts, stub its imports ----
const js = ts.transpileModule(rawSrc, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText
  .replace(/require\("@tauri-apps\/api\/core"\)/g, 'require("./_tauri.js")')
  .replace(/require\("\.\.\/pages\/agentic\/github"\)/g, 'require("./_github.js")')
  .replace(/require\("\.\.\/pages\/advanced\/deviceLiveness"\)/g, 'require("./_deviceLiveness.js")')
  .replace(/require\("\.\.\/pages\/(agentic\/modelProfiles|agentic\/cloudCatalogue|world\/worldState)"\)/g, 'require("./_caches.js")')
  .replace(/require\("\.\/stateMirror"\)/g, 'require("./_stateMirror.js")');

// Hot-blob prefixes come from the REAL stateMirror source so this stub cannot
// drift from the app's list.
const HOT_PREFIXES = [
  ...(readLF(path.join(SRC, "runtime", "stateMirror.ts"))
    .split("export const HOT_BLOB_PREFIXES")[1] ?? "").split("]")[0].matchAll(/"([^"]+)"/g),
].map((m) => m[1]);

const TMP = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "nbsync-"));
fs.writeFileSync(path.join(TMP, "vaultSync.js"), js);
// The REAL step-merge module, not a stub: it holds the union/ratchet rules the
// cases below actually exercise, so stubbing it would test nothing.
fs.writeFileSync(path.join(TMP, "notebookMerge.js"), ts.transpileModule(
  readLF(path.join(SRC, "runtime", "notebookMerge.ts")),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } },
).outputText);
fs.writeFileSync(path.join(TMP, "_tauri.js"), "module.exports = { invoke: async () => null };");
fs.writeFileSync(path.join(TMP, "_github.js"), "module.exports = { vaultEnsure: async () => ({}), vaultStatus: async () => ({ connected: false }) };");
fs.writeFileSync(path.join(TMP, "_deviceLiveness.js"), "module.exports = { REMOTE_DEVICE_HEARTBEAT_MS: 150000 };");
// repaintAfterAdopt drops the module caches that hold a synced key. This suite
// exercises notebook merging, where those caches play no part — the dedicated
// cover for the invalidators is runtime/vaultSyncNoReload.verify.run.mjs.
fs.writeFileSync(path.join(TMP, "_caches.js"), "module.exports = { invalidateProfileCache: () => {}, invalidateCloudCatalogueCache: () => {}, invalidateProgress: () => {} };");
fs.writeFileSync(path.join(TMP, "_stateMirror.js"),
  `const P = ${JSON.stringify(HOT_PREFIXES)};\n` +
  "const m = new Map();\n" +
  "module.exports = {\n" +
  "  hotBlobKeys: () => [...m.keys()],\n" +
  "  readHotBlob: (k) => (m.has(k) ? m.get(k) : null),\n" +
  "  writeHotBlob: (k, v) => { m.set(k, String(v)); },\n" +
  "  isHotBlobKey: (k) => P.some((p) => k.startsWith(p)),\n" +
  "};\n");
fs.writeFileSync(path.join(TMP, "package.json"), "{}");

const reqTmp = createRequire(path.join(TMP, "vaultSync.js"));
const { stripNotebookLease, mergeNotebookLease, pullNotebooksNow } = reqTmp("./vaultSync.js");

let failures = 0;
function check(name, cond) {
  if (cond) console.log("  ok  " + name);
  else { console.error("  FAIL " + name); failures++; }
}

const NBKEY = "owllm:agents:notebook:p1";
const LEASE = ["autoFeed", "autoFeedOwner", "autoFeedHeartbeat", "autoFeedStartedAt", "autoFeedFinishedAt", "autoFeedStopped"];

console.log("case 1: strip removes the run-lease but keeps content");
{
  const content = {
    text: "notes", plan: "PLAN",
    steps: [{ id: "s1", text: "a", status: "done", ts: 1, finishedAt: 5 }],
    digest: [], digestModel: "m",
    autoFeed: true, autoFeedOwner: "code:win", autoFeedHeartbeat: 123, autoFeedStartedAt: 10, autoFeedFinishedAt: 20, autoFeedStopped: true,
  };
  const stripped = JSON.parse(stripNotebookLease(NBKEY, JSON.stringify(content)));
  check("all lease fields removed", LEASE.every((f) => stripped[f] === undefined));
  check("content preserved", stripped.text === "notes" && stripped.plan === "PLAN" && stripped.steps[0].status === "done" && stripped.digestModel === "m");
}

console.log("case 2: strip is a no-op for non-notebook keys and non-JSON");
{
  check("non-notebook key passes through untouched", stripNotebookLease("owllm:agents:pages", '{"autoFeed":true}') === '{"autoFeed":true}');
  check("unparseable value never corrupted", stripNotebookLease(NBKEY, "not json") === "not json");
}

console.log("case 3: adopt keeps the LOCAL lease, takes remote content");
{
  // This PC is mid-queue: local blob owns the queue and has a live heartbeat.
  store.set(NBKEY, JSON.stringify({
    text: "old local", steps: [{ id: "s1", text: "a", status: "pending", ts: 1 }],
    autoFeed: true, autoFeedOwner: "code:mywin", autoFeedHeartbeat: 999, autoFeedStartedAt: 99,
  }));
  // Peer pushed newer CONTENT (lease already stripped on their push).
  const remote = JSON.stringify({ text: "new peer notes", steps: [{ id: "s1", text: "a", status: "done", ts: 1, finishedAt: 7 }] });
  const merged = JSON.parse(mergeNotebookLease(NBKEY, remote));
  check("peer content is adopted", merged.text === "new peer notes" && merged.steps[0].status === "done");
  check("this PC keeps its own live lease", merged.autoFeedOwner === "code:mywin" && merged.autoFeed === true && merged.autoFeedHeartbeat === 999 && merged.autoFeedStartedAt === 99);
}

console.log("case 4: adopt drops any stray lease when this PC holds none");
{
  const KEY2 = "owllm:agents:notebook:p2";
  store.set(KEY2, JSON.stringify({ text: "x", steps: [] })); // no local lease
  // Defensive: even if a remote blob still carries lease fields, they must not land.
  const merged = JSON.parse(mergeNotebookLease(KEY2, JSON.stringify({ text: "peer", steps: [], autoFeed: true, autoFeedOwner: "code:peerwin" })));
  check("no lease inherited from peer", LEASE.every((f) => merged[f] === undefined));
  check("peer content still adopted", merged.text === "peer");
}

// Auto-feed now defaults to ON for a notebook nobody has decided about
// (RunNotebook.loadNotebook reads it tri-state: absent = ON). That makes a LOST
// `false` behaviourally different from a missing one for the first time: drop it
// during adoption and the user's deliberate OFF silently comes back as ON, and
// the queue starts walking again on a PC where they switched it off.
console.log("case 4a: an explicit auto-feed OFF survives adopting a peer's content");
{
  const KEY_OFF = "owllm:agents:notebook:p-off";
  store.set(KEY_OFF, JSON.stringify({
    text: "local", steps: [{ id: "s1", text: "a", status: "pending", ts: 1 }],
    autoFeed: false, // the user's explicit choice on THIS PC
  }));
  // The peer stripped its own lease on push, so the remote carries no autoFeed.
  const merged = JSON.parse(mergeNotebookLease(KEY_OFF, JSON.stringify({
    text: "peer notes", steps: [{ id: "s1", text: "a", status: "pending", ts: 1 }],
  })));
  check("an explicit OFF is preserved, not dropped to the ON default", merged.autoFeed === false);
  check("peer content is still adopted alongside it", merged.text === "peer notes");
}

console.log("case 5: source wiring");
{
  check("snapshot strips the lease before syncing", rawSrc.includes("stripNotebookLease(k, v)"));
  check("adopt keeps the local lease", rawSrc.includes("mergeNotebookLease(k, v)"));
  check("adopt repaints open notebooks", rawSrc.includes("owllm:notebook-changed") && rawSrc.includes("adoptedNotebookPids"));
  const denyStart = rawSrc.indexOf("const DENY_PREFIX");
  const denyBlock = rawSrc.slice(denyStart, rawSrc.indexOf("]", denyStart));
  check("notebook CONTENT is NOT denied from sync", denyStart >= 0 && !denyBlock.includes("notebook"));
}

// ---------------------------------------------------------------------------
// The reported bug: "old steps already implemented and archived keep popping up
// randomly in the to-do list." Adoption used to take the peer's `steps` array
// WHOLESALE, so whichever PC pushed last won outright — a step this device had
// just finished came back as pending, and steps created here since the peer's
// last push were deleted. The vault's own git history shows that ping-pong
// running for hours (archived counts alternating 16 ↔ 13 ↔ 20).
// ---------------------------------------------------------------------------
const KEY3 = "owllm:agents:notebook:p3";
const nb = (o) => JSON.stringify(o);

console.log("case 6: a step finished HERE is never dragged back to pending by a stale peer");
{
  store.set(KEY3, nb({
    updatedAt: 100,
    steps: [{ id: "s1", text: "ship it", status: "sent", ts: 1, startedAt: 5, finishedAt: 9, stepUpdatedAt: 9 }],
  }));
  // Peer pushed LATER but still holds the old pending copy of the same step.
  const merged = JSON.parse(mergeNotebookLease(KEY3, nb({
    updatedAt: 200,
    steps: [{ id: "s1", text: "ship it", status: "pending", ts: 1 }],
  })));
  check("archived step stays archived", merged.steps.length === 1 && merged.steps[0].status === "sent" && merged.steps[0].finishedAt === 9);
}

console.log("case 6b: a newer explicit reopen is not undone by an older archived peer");
{
  store.set(KEY3, nb({
    updatedAt: 300,
    steps: [{ id: "s1", text: "ship it", status: "pending", ts: 1, stepUpdatedAt: 300 }],
  }));
  const merged = JSON.parse(mergeNotebookLease(KEY3, nb({
    updatedAt: 400,
    steps: [{ id: "s1", text: "ship it", status: "done", ts: 1, archivedAt: 200, stepUpdatedAt: 200 }],
  })));
  check("newer reopened lifecycle wins despite the peer's advanced status",
    merged.steps[0].status === "pending" && merged.steps[0].archivedAt == null);
}

console.log("case 6c: a repaired legacy preflight failure beats its stale failed copy");
{
  store.set(KEY3, nb({
    updatedAt: 500,
    steps: [{ id: "s1", text: "retry setup", status: "pending", ts: 1, stepUpdatedAt: 500 }],
  }));
  const merged = JSON.parse(mergeNotebookLease(KEY3, nb({
    updatedAt: 600,
    steps: [{ id: "s1", text: "retry setup", status: "failed", ts: 1, finishedAt: 200, archivedAt: 200 }],
  })));
  check("repair remains pending and does not regain stale archive metadata",
    merged.steps[0].status === "pending" && merged.steps[0].archivedAt == null);
}

console.log("case 7: adopting does not delete steps this PC created since the peer's push");
{
  store.set(KEY3, nb({
    updatedAt: 100,
    steps: [
      { id: "s1", text: "shared", status: "pending", ts: 1 },
      { id: "s2", text: "added here", status: "pending", ts: 2 },
    ],
  }));
  const merged = JSON.parse(mergeNotebookLease(KEY3, nb({
    updatedAt: 200,
    steps: [
      { id: "s1", text: "shared", status: "pending", ts: 1 },
      { id: "s3", text: "added on the peer", status: "pending", ts: 3 },
    ],
  })));
  const ids = merged.steps.map((s) => s.id).sort();
  check("union keeps every id from both sides", ids.join(",") === "s1,s2,s3");
}

console.log("case 8: tombstones stop a union from resurrecting deliberate deletions");
{
  // Deleted HERE; the peer still has it.
  store.set(KEY3, nb({ updatedAt: 300, steps: [], deletedSteps: [{ id: "s9", ts: 290 }] }));
  const a = JSON.parse(mergeNotebookLease(KEY3, nb({
    updatedAt: 400, steps: [{ id: "s9", text: "deleted", status: "pending", ts: 1 }],
  })));
  check("a step deleted here stays deleted", a.steps.length === 0 && a.deletedSteps.some((d) => d.id === "s9"));
  // Deleted on the PEER; we still have it. A delete on either side is authoritative.
  store.set(KEY3, nb({ updatedAt: 400, steps: [{ id: "s8", text: "deleted there", status: "pending", ts: 1 }] }));
  const b = JSON.parse(mergeNotebookLease(KEY3, nb({ updatedAt: 300, steps: [], deletedSteps: [{ id: "s8", ts: 290 }] })));
  check("a step deleted on the peer is removed here", b.steps.length === 0);
}

console.log("case 9: scalars order by the NOTEBOOK's own updatedAt, not the vault blob's");
{
  store.set(KEY3, nb({ updatedAt: 900, text: "my newer notes", steps: [] }));
  const older = JSON.parse(mergeNotebookLease(KEY3, nb({ updatedAt: 500, text: "peer stale notes", steps: [] })));
  check("a stale peer cannot overwrite newer local notes", older.text === "my newer notes");
  check("merged stamp is the max of both", older.updatedAt === 900);
  store.set(KEY3, nb({ updatedAt: 100, text: "my stale notes", steps: [] }));
  const newer = JSON.parse(mergeNotebookLease(KEY3, nb({ updatedAt: 500, text: "peer newer notes", steps: [] })));
  check("a newer peer does replace older local notes", newer.text === "peer newer notes");
}

console.log("case 10: merging is idempotent and monotonic (two PCs converge, no ping-pong)");
{
  const local = nb({ updatedAt: 100, text: "a", steps: [{ id: "s1", text: "x", status: "sent", ts: 1, finishedAt: 7 }] });
  const remote = nb({ updatedAt: 200, text: "b", steps: [{ id: "s1", text: "x", status: "pending", ts: 1 }] });
  store.set(KEY3, local);
  const once = mergeNotebookLease(KEY3, remote);
  store.set(KEY3, once);
  const twice = mergeNotebookLease(KEY3, once);
  check("re-merging the same pair changes nothing", twice === once);
}

console.log("case 11: the cross-PC advisory syncs, the run-lease still does not");
{
  const stripped = JSON.parse(stripNotebookLease(KEY3, nb({
    steps: [], runningOn: { deviceId: "d1", deviceName: "DESKTOP-A", at: 42 }, autoFeedOwner: "agents:p1",
  })));
  check("runningOn survives the push (it is advisory, not a lease)", stripped.runningOn?.deviceName === "DESKTOP-A");
  check("autoFeedOwner is still stripped", stripped.autoFeedOwner === undefined);
  store.set(KEY3, nb({ updatedAt: 1, steps: [], runningOn: { deviceId: "d1", deviceName: "OLD", at: 10 } }));
  const merged = JSON.parse(mergeNotebookLease(KEY3, nb({
    updatedAt: 2, steps: [], runningOn: { deviceId: "d2", deviceName: "NEW", at: 99 },
  })));
  check("the most recent device to start a queue wins the advisory", merged.runningOn?.deviceName === "NEW");
}

console.log("case 12: a notebook keyed by a raw folder path never leaves this PC");
{
  const before = store.size;
  store.set("owllm:agents:notebook:code:c:\\0_githome\\owllm", nb({ steps: [] }));
  store.set("owllm:agents:notebook:19efdfe2adf_9df1464dbca70023", nb({ steps: [] }));
  const denyStart = rawSrc.indexOf("NOTEBOOK_PATH_FALLBACK_PREFIX");
  check("the path-scoped fallback prefix is defined", denyStart >= 0);
  check("isSyncable rejects it", rawSrc.includes("if (key.startsWith(NOTEBOOK_PATH_FALLBACK_PREFIX)) return false;"));
  check("durable project ids are unaffected", store.size === before + 2);
}

console.log("case 13: notebooks converge WITHOUT waiting for the next app launch");
{
  check("a scoped mid-session pull exists", typeof pullNotebooksNow === "function");
  // Was a flat `window.setInterval(... pullNotebooksNow ...)`; it is now a
  // self-rescheduling timer so a RUNNING queue can be polled harder than an
  // idle one. The invariant is unchanged and is what we assert: the pull is
  // armed periodically, and every path re-arms it — a timer that fails to
  // re-arm converges once and then goes silent, which the old interval could
  // not do and this shape can.
  {
    const wire = rawSrc.slice(rawSrc.indexOf("function wireListeners"));
    const body = wire.slice(wire.indexOf("const scheduleNotebookPull"), wire.indexOf("Fleet liveness heartbeat"));
    // Anchored to the call that follows the closure's `};` — matching a bare
    // `scheduleNotebookPull();` would also match the re-arm INSIDE the closure,
    // so deleting the startup call would still pass. It must be armed once from
    // wireListeners or the timer never starts at all.
    check("a periodic pull is armed at startup", /\};\s*\n\s*scheduleNotebookPull\(\);/.test(body) && body.includes("pullNotebooksNow()"));
    check("...and re-arms when sync is disabled", /if \(!_enabled\) \{ scheduleNotebookPull\(\); return; \}/.test(body));
    check("...and re-arms even if the pull rejects", body.includes(".finally(scheduleNotebookPull)"));
  }
  check("and runs when the window regains focus", rawSrc.includes("else void pullNotebooksNow();"));
  check("it must NOT claim the whole blob as adopted", rawSrc.slice(rawSrc.indexOf("export async function pullNotebooksNow"), rawSrc.indexOf("export async function pushNow")).includes("NOT setLast()"));
  check("launch-time full adopt is still there", rawSrc.includes("if (await pullAndAdopt())"));
}

console.log("case 13b: two idle PCs settle instead of re-writing each other forever");
{
  // The merged value is rebuilt from the PEER's object, so its KEY ORDER can
  // differ from ours while meaning the same thing. A raw string compare would
  // then see a change on every poll — write, repaint and re-push, forever.
  const content = { steps: [{ id: "s1", text: "x", status: "pending", ts: 1 }], updatedAt: 5, text: "n" };
  const reordered = { text: "n", updatedAt: 5, steps: [{ ts: 1, status: "pending", text: "x", id: "s1" }] };
  check("identical content in a different key order is recognised as unchanged",
    rawSrc.includes("function sameNotebookJson") && rawSrc.includes("if (sameNotebookJson(current, merged)) continue;"));
  store.set(KEY3, nb(content));
  const merged = mergeNotebookLease(KEY3, nb(reordered));
  check("and the merge itself is content-stable across key order",
    JSON.stringify(Object.keys(JSON.parse(merged)).sort()) === JSON.stringify(Object.keys(JSON.parse(mergeNotebookLease(KEY3, nb(content)))).sort()));
}

console.log("case 14: legacy blobs written before updatedAt existed still adopt the peer");
{
  store.set(KEY3, nb({ text: "local legacy", steps: [{ id: "s1", text: "x", status: "pending", ts: 1 }] }));
  const merged = JSON.parse(mergeNotebookLease(KEY3, nb({ text: "peer legacy", steps: [{ id: "s1", text: "x", status: "pending", ts: 1 }] })));
  check("no-stamp on both sides keeps the previous adopt-the-peer behaviour", merged.text === "peer legacy");
  check("and still yields exactly one copy of the shared step", merged.steps.length === 1);
}

console.log(failures ? `\n${failures} FAILURES` : "\nall checks passed");
process.exit(failures ? 1 : 0);
