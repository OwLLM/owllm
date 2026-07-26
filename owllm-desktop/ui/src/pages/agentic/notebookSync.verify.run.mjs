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
  .replace(/require\("\.\.\/pages\/advanced\/deviceLiveness"\)/g, 'require("./_deviceLiveness.js")');

const TMP = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "nbsync-"));
fs.writeFileSync(path.join(TMP, "vaultSync.js"), js);
fs.writeFileSync(path.join(TMP, "_tauri.js"), "module.exports = { invoke: async () => null };");
fs.writeFileSync(path.join(TMP, "_github.js"), "module.exports = { vaultEnsure: async () => ({}), vaultStatus: async () => ({ connected: false }) };");
fs.writeFileSync(path.join(TMP, "_deviceLiveness.js"), "module.exports = { REMOTE_DEVICE_HEARTBEAT_MS: 150000 };");
fs.writeFileSync(path.join(TMP, "package.json"), "{}");

const reqTmp = createRequire(path.join(TMP, "vaultSync.js"));
const { stripNotebookLease, mergeNotebookLease } = reqTmp("./vaultSync.js");

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

console.log("case 5: source wiring");
{
  check("snapshot strips the lease before syncing", rawSrc.includes("stripNotebookLease(k, v)"));
  check("adopt keeps the local lease", rawSrc.includes("mergeNotebookLease(k, v)"));
  check("adopt repaints open notebooks", rawSrc.includes("owllm:notebook-changed") && rawSrc.includes("adoptedNotebookPids"));
  const denyStart = rawSrc.indexOf("const DENY_PREFIX");
  const denyBlock = rawSrc.slice(denyStart, rawSrc.indexOf("]", denyStart));
  check("notebook CONTENT is NOT denied from sync", denyStart >= 0 && !denyBlock.includes("notebook"));
}

console.log(failures ? `\n${failures} FAILURES` : "\nall checks passed");
process.exit(failures ? 1 : 0);
