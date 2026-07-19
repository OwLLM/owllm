// Focused verification for the state mirror — the SQLite backup of durable
// localStorage keys (Coding pages/sessions, notebook blobs, chat state) that
// makes a WebView profile change unable to erase history. Root cause chain
// (2026-07-19 forensics): v0.8.97 profile isolation + updater env inheritance
// hopped users across empty profiles; everything DB-backed survived,
// everything localStorage-only "disappeared". This suite drives the real
// transpiled runtime/stateMirror.ts with a fake localStorage + stubbed
// Tauri invoke, then pins the boot wiring and the Rust command surface.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../..");
const DESKTOP = path.resolve(SRC, "../..");
const require = createRequire(path.join(DESKTOP, "package.json"));
const ts = require("typescript");

// Read source for content matching independent of the checkout's line endings
// (Windows core.autocrlf checks LF-committed files out as CRLF).
const readSource = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8").replace(/\r\n/g, "\n");
const readTauri = (rel) =>
  fs.readFileSync(path.join(DESKTOP, "src-tauri", rel), "utf8").replace(/\r\n/g, "\n");

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
}

// ---- transpile the real module with a Tauri API shim ----
const source = fs.readFileSync(path.join(SRC, "runtime/stateMirror.ts"), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-mirror-"));
const shimDir = path.join(temp, "node_modules", "@tauri-apps", "api");
fs.mkdirSync(shimDir, { recursive: true });
fs.writeFileSync(
  path.join(shimDir, "package.json"),
  JSON.stringify({ name: "@tauri-apps/api", version: "0.0.0", exports: { "./core": "./core.js" } }),
);
fs.writeFileSync(
  path.join(shimDir, "core.js"),
  "module.exports = { invoke: (...a) => globalThis.__invokeStub(...a) };\n",
);
const modulePath = path.join(temp, "stateMirror.cjs");
fs.writeFileSync(modulePath, output);

// ---- fake browser environment ----
function makeStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    _map: map,
  };
}
globalThis.window = { __TAURI_INTERNALS__: {}, addEventListener: () => {} };
globalThis.document = { addEventListener: () => {}, visibilityState: "visible" };
globalThis.localStorage = makeStorage();

const mirror = require(modulePath);

// ---- restore semantics ----
globalThis.__invokeStub = async (cmd) => {
  check(cmd === "state_mirror_load", "restore asks the backend for the mirrored rows");
  return [
    { key: "owllm:code:pages", value: "[restored]" },
    { key: "owllm:code:page:p1", value: "{restored}" },
    { key: "owllm:agents:notebook:proj1", value: "{nb}" },
    { key: "owllm:chat:v3", value: "{chat}" },
    { key: "owllm:secret-unrelated", value: "nope" },
  ];
};
localStorage.setItem("owllm:code:pages", "[live]");
const restored = await mirror.restoreStateMirror();
check(restored === 3, "restore fills exactly the missing durable keys");
check(localStorage.getItem("owllm:code:pages") === "[live]",
  "restore NEVER overwrites a key the live profile already has");
check(localStorage.getItem("owllm:code:page:p1") === "{restored}",
  "a missing Coding session comes back from the DB");
check(localStorage.getItem("owllm:agents:notebook:proj1") === "{nb}",
  "a missing notebook blob comes back from the DB");
check(localStorage.getItem("owllm:secret-unrelated") === null,
  "rows outside the durable prefixes are ignored on restore");

// ---- restore resilience: backend failure cannot block boot ----
mirror.__resetStateMirrorForTests();
globalThis.__invokeStub = async () => { throw new Error("backend down"); };
check((await mirror.restoreStateMirror()) === 0, "a dead backend degrades to an empty restore, not a crash");

// ---- sweep: upserts deltas, then goes quiet ----
mirror.__resetStateMirrorForTests();
globalThis.localStorage = makeStorage();
localStorage.setItem("owllm:code:pages", "[v1]");
localStorage.setItem("owllm:agents:notebook:proj1", "{nb1}");
localStorage.setItem("owllm:untracked", "ignore-me");
let saves = [];
globalThis.__invokeStub = async (cmd, args) => {
  if (cmd === "state_mirror_load") return [];
  saves.push(args.input);
  return null;
};
await mirror.restoreStateMirror();
await mirror.__sweepOnceForTests();
check(saves.length === 1 && saves[0].sets.length === 2 && saves[0].deletes.length === 0,
  "first sweep mirrors every durable key exactly once");
check(!saves[0].sets.some((e) => e.key === "owllm:untracked"),
  "non-durable keys never reach the mirror");
saves = [];
await mirror.__sweepOnceForTests();
check(saves.length === 0, "an unchanged store produces zero DB traffic");
localStorage.setItem("owllm:code:pages", "[v2]");
await mirror.__sweepOnceForTests();
check(saves.length === 1 && saves[0].sets.length === 1 && saves[0].sets[0].value === "[v2]",
  "a changed key is re-mirrored as a single delta");

// ---- deletion vs wipe ----
saves = [];
localStorage.removeItem("owllm:agents:notebook:proj1");
await mirror.__sweepOnceForTests();
check(saves.length === 1 && saves[0].deletes.includes("owllm:agents:notebook:proj1"),
  "deleting a key while storage is alive drops its mirror row");
saves = [];
localStorage.removeItem("owllm:code:pages"); // now ZERO durable keys remain
await mirror.__sweepOnceForTests();
check(saves.length === 0,
  "a fully-wiped store deletes NOTHING — the mirror survives to restore next boot");

// ---- failed save keeps deltas pending ----
mirror.__resetStateMirrorForTests();
globalThis.localStorage = makeStorage();
localStorage.setItem("owllm:code:pages", "[v1]");
let calls = 0;
globalThis.__invokeStub = async (cmd) => {
  if (cmd === "state_mirror_load") return [];
  calls++;
  throw new Error("disk hiccup");
};
await mirror.restoreStateMirror();
await mirror.__sweepOnceForTests();
globalThis.__invokeStub = async (cmd, args) => {
  if (cmd === "state_mirror_load") return [];
  calls++;
  saves.push(args.input);
  return null;
};
saves = [];
await mirror.__sweepOnceForTests();
check(calls === 2 && saves.length === 1 && saves[0].sets[0].value === "[v1]",
  "a failed save is retried on the next sweep (nothing silently lost)");

// ---- wiring pins ----
const mirrorSrc = readSource("runtime/stateMirror.ts");
check(mirrorSrc.includes('"owllm:code:"') && mirrorSrc.includes('"owllm:agents:notebook:"') && mirrorSrc.includes('"owllm:chat:"'),
  "durable prefixes cover Coding pages, notebook blobs and chat state");
const mainSrc = readSource("main.tsx");
check(mainSrc.includes("await restoreStateMirror()"),
  "boot AWAITS the restore so pages' useState initializers see recovered keys");
check(/await restoreStateMirror\(\)[\s\S]*createRoot/.test(mainSrc),
  "restore runs BEFORE the React root renders");
check(mainSrc.includes("startStateMirror()"), "the background mirror starts at boot");
const rustMod = readTauri("src/state_mirror.rs");
check(rustMod.includes("pub async fn state_mirror_load") && rustMod.includes("pub async fn state_mirror_save"),
  "Rust exposes the load/save commands the UI invokes");
check(rustMod.includes("LIKE 'ls:%'"), "the mirror only ever reads its own ls: rows from kv");
const librs = readTauri("src/lib.rs");
check(librs.includes("state_mirror::state_mirror_load") && librs.includes("state_mirror::state_mirror_save"),
  "both commands are registered in the invoke handler");

console.log(`\nall checks passed (${passed})`);
process.exit(0);
