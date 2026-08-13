// vaultSync must repaint after an adoption WITHOUT reloading the WebView.
//
// The reload was the app's visible "double start": the window is already on
// screen when the launch sync lands, so the user watched the entire UI reboot
// a couple of seconds after it appeared. It existed because a vault adoption
// writes synced keys under the running UI and a handful of module-level caches
// would otherwise keep serving their pre-sync copy.
//
// This runs the REAL startVaultSync against the REAL cache modules, with a
// remote blob that changes all three of them, and asserts:
//   1. location.reload() is never called;
//   2. each cache serves the ADOPTED value afterwards, even though it was
//      warmed with the stale one first — i.e. the invalidators actually fire;
//   3. the projects refresh event still reaches mounted surfaces.
//
// Assertion 1 fails on the pre-fix source (reloadOnce), and 2 fails on a fix
// that deletes the reload without invalidating the caches.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");

let failed = 0;
const read = (p) => fs.readFileSync(p, "utf8");
const check = (cond, message) => {
  if (!cond) { failed += 1; console.error(`✗ ${message}`); return; }
  console.log(`✓ ${message}`);
};
const toCjs = (src) => ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

const sync = read(path.join(SRC, "runtime", "vaultSync.ts"));
// Comments legitimately NAME the removed reload to explain why it went away;
// only executable code may be asserted against.
const syncCode = sync.replace(/^\s*\/\/.*$/gm, "");

check(!/location\s*\.\s*reload/.test(syncCode),
  "vaultSync never reloads the WebView");
check(!syncCode.includes("reloadOnce"),
  "the reload-once budget is gone, not merely unused");
check(sync.includes("function repaintAfterAdopt"),
  "adoption repaints in place through repaintAfterAdopt");

// ---- Execute the real startup path -----------------------------------------

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-vault-noreload-"));
const coreDir = path.join(temp, "node_modules", "@tauri-apps", "api");
const runtimeDir = path.join(temp, "runtime");
const agenticDir = path.join(temp, "pages", "agentic");
const advancedDir = path.join(temp, "pages", "advanced");
const worldDir = path.join(temp, "pages", "world");
for (const d of [coreDir, runtimeDir, agenticDir, advancedDir, worldDir]) {
  fs.mkdirSync(d, { recursive: true });
}
fs.writeFileSync(
  path.join(coreDir, "package.json"),
  JSON.stringify({ name: "@tauri-apps/api", version: "0.0.0", exports: { "./core": "./core.js" } }),
);
fs.writeFileSync(
  path.join(coreDir, "core.js"),
  "module.exports = { invoke: (...a) => globalThis.__vaultInvoke(...a) };\n",
);
fs.writeFileSync(
  path.join(agenticDir, "github.js"),
  "module.exports = {\n" +
    "  vaultStatus: async () => ({ connected: true, cloned: true }),\n" +
    "  vaultEnsure: async () => ({ connected: true, cloned: true }),\n" +
    "};\n",
);
// The cache modules are dependency-free, so the REAL sources run here — a stub
// could not prove that the app's own invalidators do the job.
for (const [dir, rel] of [
  [advancedDir, ["pages", "advanced", "deviceLiveness.ts"]],
  [agenticDir, ["pages", "agentic", "modelProfiles.ts"]],
  [agenticDir, ["pages", "agentic", "cloudCatalogue.ts"]],
  [worldDir, ["pages", "world", "worldState.ts"]],
  [runtimeDir, ["runtime", "notebookMerge.ts"]],
]) {
  const name = rel[rel.length - 1].replace(/\.ts$/, ".js");
  fs.writeFileSync(path.join(dir, name), toCjs(read(path.join(SRC, ...rel))));
}
// Hot-blob keys never touch localStorage; take the prefix list from the REAL
// stateMirror so this stub cannot drift from the app.
const HOT_PREFIXES = [
  ...(read(path.join(SRC, "runtime", "stateMirror.ts"))
    .split("export const HOT_BLOB_PREFIXES")[1] ?? "").split("]")[0].matchAll(/"([^"]+)"/g),
].map((m) => m[1]);
fs.writeFileSync(
  path.join(runtimeDir, "stateMirror.js"),
  `const P = ${JSON.stringify(HOT_PREFIXES)};\n` +
    "const m = new Map();\n" +
    "module.exports = {\n" +
    "  hotBlobKeys: () => [...m.keys()],\n" +
    "  readHotBlob: (k) => (m.has(k) ? m.get(k) : null),\n" +
    "  writeHotBlob: (k, v) => { m.set(k, String(v)); },\n" +
    "  isHotBlobKey: (k) => P.some((p) => k.startsWith(p)),\n" +
    "};\n",
);
fs.writeFileSync(path.join(runtimeDir, "vaultSync.js"), toCjs(sync));

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

const STALE_PROFILE = [{
  label: "stale", match: ["verifymodel"], toolProtocol: "native",
  thinking: "none", sampling: { temperature: 0.1 },
}];
const ADOPTED_PROFILE = [{
  label: "adopted", match: ["verifymodel"], toolProtocol: "native",
  thinking: "none", sampling: { temperature: 0.9 },
}];
const ADOPTED_CLOUD = { anthropic: [{ id: "adopted-model", label: "Adopted" }] };

globalThis.localStorage = storage({
  "owllm:model-profiles": JSON.stringify(STALE_PROFILE),
  "owllm:cloud-models": JSON.stringify({ anthropic: [{ id: "stale-model", label: "Stale" }] }),
  "owllm:world:progress": JSON.stringify({ xp: 1, scene: "hq_loft", quests: [] }),
});
globalThis.sessionStorage = storage();
globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
let reloads = 0;
globalThis.location = { reload: () => { reloads += 1; } };
globalThis.document = { addEventListener: () => {}, visibilityState: "visible" };
const dispatched = [];
globalThis.window = {
  addEventListener: () => {},
  dispatchEvent: (e) => void dispatched.push(e.type),
  setInterval: () => 1,
  setTimeout: () => 1,
};
globalThis.__vaultInvoke = async (command) => {
  if (command === "device_get_id") return "device-under-test";
  if (command === "vault_read_remote_state") {
    return JSON.stringify({
      syncedAt: Date.now(),
      device: "some-other-device",
      data: {
        "owllm:model-profiles": JSON.stringify(ADOPTED_PROFILE),
        "owllm:cloud-models": JSON.stringify(ADOPTED_CLOUD),
        "owllm:world:progress": JSON.stringify({ xp: 999, scene: "hq_loft", quests: [] }),
      },
    });
  }
  if (command === "vault_sync_projects") return true;
  return null;
};

const profiles = require(path.join(agenticDir, "modelProfiles.js"));
const catalogue = require(path.join(agenticDir, "cloudCatalogue.js"));
const world = require(path.join(worldDir, "worldState.js"));

// Warm every cache with the PRE-sync value, exactly as a running UI would have.
check(profiles.resolveModelProfile("verifymodel").sampling.temperature === 0.1,
  "the profile cache is warmed with this device's pre-sync override");
check(catalogue.getCloudCatalogue().anthropic.some((m) => m.id === "stale-model"),
  "the cloud-catalogue cache is warmed with this device's pre-sync override");
check(world.getProgress().xp === 1,
  "the world-progress cache is warmed with this device's pre-sync value");

await require(path.join(runtimeDir, "vaultSync.js")).startVaultSync();

check(reloads === 0,
  "a vault adoption does NOT reload the WebView (no double start)");
check(profiles.resolveModelProfile("verifymodel").sampling.temperature === 0.9,
  "the adopted model profile is served without a reload");
check(catalogue.getCloudCatalogue().anthropic.some((m) => m.id === "adopted-model"),
  "the adopted cloud catalogue is served without a reload");
check(world.getProgress().xp === 999,
  "the adopted world progress is served without a reload");
check(dispatched.includes("owllm:projects:refresh"),
  "mounted project surfaces are still told to refetch");

fs.rmSync(temp, { recursive: true, force: true });

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nvaultSync repaints in place — no reload.");
