// VAULT SYNC MUST NEVER QUEUE. It is the back-pressure gate on the whole app.
//
// Every vault command runs its git transaction inside `spawn_blocking`, holding
// a lock across fetch+merge+push. The UI drives four periodic channels per
// window (5s state push, 10s notebook pull, 60s projects, 150s devices) and
// `pushNow` had no inflight guard, so once a push took longer than the poll
// interval each tick stacked another `vault_write_state` on top of the last —
// and each one parked a WHOLE tokio blocking thread waiting for the lock. At
// tokio's default 512-thread blocking-pool ceiling every other spawn_blocking in
// the app (chat persistence, model listing, engine start) queued behind vault
// sync forever: the app rendered fine and did nothing at all, for any model.
//
// Observed 2026-08-12: 552 threads, all in Wait, ~2% CPU, against an
// 83,095-commit / 7.2 GB vault committing 660 times an hour.
//
// Pinned four ways:
//
//   Part 1  BEHAVIOURAL — drive the REAL vaultSync module with a push that does
//           not resolve, fire concurrent pushes, and prove only ONE reaches the
//           native side and the rest collapse into a single trailing re-run.
//   Part 2  BEHAVIOURAL — when the native side reports a COALESCED tick
//           (`false`), the dedupe marker must not advance, or unsaved state is
//           recorded as published and silently lost.
//   Part 3  CONTROL — `null` (what the other harnesses stub) still counts as
//           written, and a real write does advance the marker. Without this,
//           part 2 would pass for a module that never advanced anything.
//   Part 4  SOURCE — the Rust half: an async admission gate, coalescing on the
//           periodic channels, loose-object-gated consolidation, and no repack
//           on the async runtime.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));   // ui/src/runtime
const SRC = path.resolve(HERE, "..");                        // ui/src
const DESKTOP = path.resolve(HERE, "../../..");              // owllm-desktop
const require = createRequire(path.join(DESKTOP, "package.json"));
const ts = require("typescript");
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

let passed = 0;
const check = (ok, message) => {
  if (!ok) throw new Error(`FAIL ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
};

// --- sandbox ---------------------------------------------------------------

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-vault-backpressure-"));
const transpile = (src) => ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

const coreDir = path.join(temp, "node_modules", "@tauri-apps", "api");
const runtimeDir = path.join(temp, "runtime");
const githubDir = path.join(temp, "pages", "agentic");
const advancedDir = path.join(temp, "pages", "advanced");
for (const d of [coreDir, runtimeDir, githubDir, advancedDir]) fs.mkdirSync(d, { recursive: true });

fs.writeFileSync(
  path.join(coreDir, "package.json"),
  JSON.stringify({ name: "@tauri-apps/api", version: "0.0.0", exports: { "./core": "./core.js" } }),
);
fs.writeFileSync(
  path.join(coreDir, "core.js"),
  "module.exports = { invoke: (...a) => globalThis.__vaultInvoke(...a) };\n",
);
fs.writeFileSync(
  path.join(githubDir, "github.js"),
  "module.exports = {\n"
  + "  vaultStatus: async () => ({ connected: true, cloned: true }),\n"
  + "  vaultEnsure: async () => ({ connected: true, cloned: true }),\n"
  + "};\n",
);
fs.writeFileSync(
  path.join(advancedDir, "deviceLiveness.js"),
  transpile(read(path.join(SRC, "pages", "advanced", "deviceLiveness.ts"))),
);
// The cache modules repaintAfterAdopt invalidates instead of reloading. All
// dependency-free, so the REAL sources go in rather than stubs that could drift.
const worldDir = path.join(temp, "pages", "world");
fs.mkdirSync(worldDir, { recursive: true });
for (const [dir, rel] of [
  [githubDir, ["pages", "agentic", "modelProfiles.ts"]],
  [githubDir, ["pages", "agentic", "cloudCatalogue.ts"]],
  [worldDir, ["pages", "world", "worldState.ts"]],
]) {
  fs.writeFileSync(
    path.join(dir, rel[rel.length - 1].replace(/\.ts$/, ".js")),
    transpile(read(path.join(SRC, ...rel))),
  );
}
const HOT_PREFIXES = [
  ...(read(path.join(SRC, "runtime", "stateMirror.ts"))
    .split("export const HOT_BLOB_PREFIXES")[1] ?? "").split("]")[0].matchAll(/"([^"]+)"/g),
].map((m) => m[1]);
fs.writeFileSync(
  path.join(runtimeDir, "stateMirror.js"),
  `const P = ${JSON.stringify(HOT_PREFIXES)};\n`
  + "const m = new Map();\n"
  + "module.exports = {\n"
  + "  hotBlobKeys: () => [...m.keys()],\n"
  + "  readHotBlob: (k) => (m.has(k) ? m.get(k) : null),\n"
  + "  writeHotBlob: (k, v) => { m.set(k, String(v)); },\n"
  + "  isHotBlobKey: (k) => P.some((p) => k.startsWith(p)),\n"
  + "};\n",
);
fs.writeFileSync(
  path.join(runtimeDir, "notebookMerge.js"),
  transpile(read(path.join(SRC, "runtime", "notebookMerge.ts"))),
);
// The shared watcher fan-out helper — cloudCatalogue/worldState notify
// through it, so the REAL (dependency-free) module goes in.
fs.writeFileSync(
  path.join(runtimeDir, "listenerBus.js"),
  transpile(read(path.join(SRC, "runtime", "listenerBus.ts"))),
);
fs.writeFileSync(
  path.join(runtimeDir, "vaultSync.js"),
  transpile(read(path.join(SRC, "runtime", "vaultSync.ts"))),
);

function storage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    get length() { return values.size; },
    key: (i) => [...values.keys()][i] ?? null,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => void values.set(key, String(value)),
    removeItem: (key) => void values.delete(key),
  };
}

const store = storage({ "owllm:agents:notebook:seed": "1" });
globalThis.localStorage = store;
globalThis.sessionStorage = storage({ "owllm:session:user-interacted": "1" });
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
globalThis.location = { reload: () => { throw new Error("unexpected reload"); } };
globalThis.document = { addEventListener: () => {}, visibilityState: "visible" };
globalThis.window = { addEventListener: () => {}, dispatchEvent: () => {}, setInterval: () => 1, setTimeout: () => 1 };

// The native side, under our control: `hold` makes a push hang exactly the way
// a real git push against a bloated vault does, which is the condition the
// pileup needed.
let inflight = 0;
let maxInflight = 0;
let writes = 0;
let writeResult = true;
let hold = false;
const waiting = [];
const releaseAll = () => { while (waiting.length) waiting.pop()(); };

globalThis.__vaultInvoke = async (command, args) => {
  if (command === "device_get_id") return "this-device";
  if (command === "vault_read_remote_state") return null;
  if (command === "vault_sync_projects") return false;
  if (command === "vault_write_state") {
    JSON.parse(args.json); // the blob must always be valid JSON
    writes += 1;
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    if (hold) await new Promise((r) => waiting.push(r));
    inflight -= 1;
    return writeResult;
  }
  return null;
};

const sync = require(path.join(runtimeDir, "vaultSync.js"));
// Let the event loop turn over until everything settles.
const drain = async (n = 10) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

await sync.startVaultSync();
// startVaultSync fires a push it does not await, so its own inflight run is
// still live here. Measuring the burst against THAT would credit the guard for
// work it never did — quiesce first so part 1 starts from a genuinely idle
// engine and every call in the burst is one this test made.
await drain();

// --- Part 1: concurrent pushes never stack on the native side --------------

writes = 0; maxInflight = 0; hold = true;
// Five callers at once — the 5s poll, a tab-hide, a queue transition and two
// more windows all landing while one push is still waiting on git.
const burst = [
  sync.pushNow(true),
  sync.pushNow(true),
  sync.pushNow(true),
  sync.pushNow(true),
  sync.pushNow(true),
];
// Let every caller reach its first await before anything is released.
await drain(2);
check(maxInflight === 1,
  `only ONE vault_write_state is ever in flight (saw ${maxInflight})`);
check(writes === 1,
  `four concurrent callers add no native calls while one is pending (saw ${writes})`);
releaseAll();
await drain();
releaseAll();
await Promise.all(burst);
check(maxInflight === 1,
  "still never more than one in flight once the held push drains");
check(writes === 2,
  `the four coalesce into exactly ONE trailing re-run, not a queue (saw ${writes})`);

// --- Part 2: a coalesced tick must not be recorded as published ------------

hold = false;
writeResult = false;
store.setItem("owllm:agents:notebook:seed", "part2");
writes = 0;
await sync.pushNow();
check(writes === 1, "control: the changed state really was offered to the vault");
// Same state, next poll. The native side said it wrote NOTHING, so this must go
// out again — advancing the marker here is silent data loss.
writes = 0;
await sync.pushNow();
check(writes === 1,
  "a coalesced (false) tick leaves the dedupe marker alone, so the next poll retries");

// --- Part 3: control — a real write DOES advance the marker ----------------

writeResult = true;
store.setItem("owllm:agents:notebook:seed", "part3");
writes = 0;
await sync.pushNow();
check(writes === 1, "control: a fresh change is pushed");
writes = 0;
await sync.pushNow();
check(writes === 0,
  "control: after a successful write the unchanged state is deduped (part 2 is not vacuous)");

writeResult = null; // what the other verify harnesses stub
store.setItem("owllm:agents:notebook:seed", "part3-null");
writes = 0;
await sync.pushNow();
check(writes === 1, "control: a null result still pushes");
writes = 0;
await sync.pushNow();
check(writes === 0,
  "null counts as WRITTEN, so the existing harnesses that stub null keep passing");

// --- Part 4: the Rust half --------------------------------------------------

const vaultRs = read(path.join(DESKTOP, "src-tauri", "src", "vault.rs"));

check(/fn vault_gate\(\) -> &'static tokio::sync::Semaphore/.test(vaultRs),
  "vault.rs has an async admission gate (a semaphore, not a blocking mutex)");
check(/async fn vault_admit\(\)/.test(vaultRs) && /fn vault_admit_now\(\)/.test(vaultRs),
  "vault.rs exposes both a waiting and a try-once admission path");

// The gate is worthless if it is taken INSIDE spawn_blocking — the thread is
// already committed by then. Every acquisition must precede the spawn.
const admissions = [...vaultRs.matchAll(/vault_admit(_now)?\s*\(\)/g)]
  // The definitions themselves are not call sites.
  .filter((m) => !/fn vault_admit/.test(vaultRs.slice(Math.max(0, m.index - 60), m.index)));
const insideSpawn = admissions.filter((m) => {
  const before = vaultRs.slice(0, m.index);
  const spawnAt = before.lastIndexOf("spawn_blocking");
  const fnAt = Math.max(before.lastIndexOf("\npub async fn "), before.lastIndexOf("\nasync fn "));
  return spawnAt > fnAt;
});
check(admissions.length >= 8 && insideSpawn.length === 0,
  `all ${admissions.length} admissions are taken BEFORE spawn_blocking, never inside it`);

// High-frequency derived-state pollers coalesce. Device presence is different:
// one native supervisor owns it, so dropping the only heartbeat can mark a live
// machine offline; it waits asynchronously without occupying a blocking thread.
const coalescing = ["vault_write_state", "vault_sync_projects"];
for (const name of coalescing) {
  const body = vaultRs.split(`pub async fn ${name}`)[1]?.split("\npub async fn ")[0] ?? "";
  check(/let Some\(_gate\) = vault_admit_now\(\)/.test(body),
    `${name} coalesces a tick that lands mid-sync instead of queueing behind it`);
}
const deviceSyncBody = vaultRs.split("pub async fn vault_sync_devices")[1]?.split("\npub async fn ")[0] ?? "";
check(/let _gate = vault_admit\(\)\.await;/.test(deviceSyncBody)
  && !/vault_admit_now\(\)/.test(deviceSyncBody),
  "vault_sync_devices reliably waits as an async task instead of dropping machine presence");
check(/pub async fn vault_write_state\(json: String\) -> Result<bool, String>/.test(vaultRs),
  "vault_write_state reports whether it actually wrote, so a skip can be retried");

// Consolidation: pack count alone never fired on the vault that wedged (10
// packs, 128,117 loose objects), and a repack must never run on the async
// runtime where it would stall every other task.
check(/fn loose_object_count\(/.test(vaultRs) && /LOOSE_LIMIT/.test(vaultRs),
  "maintain_repo is gated on loose objects, not just pack count");
check(/fn maintain_repo_if_due\(/.test(vaultRs),
  "consolidation re-checks on an interval, not once per process");
const hardened = vaultRs.split("fn ensure_hardened")[1]?.split("\n}")[0] ?? "";
check(!/maintain_repo/.test(hardened),
  "ensure_hardened does NOT repack — it runs on the async runtime");
const writeBody = vaultRs.split("pub async fn vault_write_state")[1]?.split("\npub async fn ")[0] ?? "";
check(writeBody.includes("maintain_repo_if_due(&dir)")
  && writeBody.indexOf("spawn_blocking") < writeBody.indexOf("maintain_repo_if_due"),
  "consolidation runs on the gated blocking thread, inside the write transaction");

fs.rmSync(temp, { recursive: true, force: true });
console.log(`\nvaultSyncBackpressure: ${passed} checks passed`);
