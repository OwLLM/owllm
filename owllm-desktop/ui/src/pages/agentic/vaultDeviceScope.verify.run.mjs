// Regression pins for cross-device state boundaries. Project/chat content is
// shared; open tabs, selected projects and absolute folders belong to a single
// device and must never be adopted from a peer.
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
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
let passed = 0;
const check = (ok, message) => {
  if (!ok) throw new Error(`FAIL ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
};

const sync = read(path.join(SRC, "runtime", "vaultSync.ts"));
for (const key of [
  "owllm:agents:pages",
  "owllm:agents:activePage",
  "owllm:assets:selectedProject",
]) {
  check(sync.includes(`"${key}"`), `${key} is device-local`);
}
check(sync.includes('"owllm:agents:page:"'), "per-page project selection is device-local");
check(sync.includes("if (!isSyncable(k)) continue"),
  "old remote blobs cannot re-import newly denied device-local keys");
check(sync.includes('invoke<string>("device_get_id")'),
  "vault metadata uses the backend's stable cryptographic device id");
check(sync.includes("import { vaultEnsure, vaultStatus }"),
  "startup can repair a missing local vault clone");
check(sync.includes("if (!st?.connected) return") &&
      sync.includes("if (!st.cloned) st = await vaultEnsure()"),
  "a connected device ensures its vault clone before project sync");
check(sync.indexOf("if (!st.cloned) st = await vaultEnsure()") <
      sync.indexOf("if (await syncProjectsNow() && reloadOnce()) return"),
  "vault recovery happens before projects are pulled");
check(sync.includes("_started = false") &&
      sync.includes("[vaultSync] vault startup failed"),
  "a transient vault-recovery failure does not permanently latch sync off");

// Execute the real startup module with Tauri/GitHub shims. The first ensure
// deliberately fails; a second startup call must retry, repair the clone, and
// only then pull projects.
const output = ts.transpileModule(sync, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-vault-startup-"));
const coreDir = path.join(temp, "node_modules", "@tauri-apps", "api");
const runtimeDir = path.join(temp, "runtime");
const githubDir = path.join(temp, "pages", "agentic");
fs.mkdirSync(coreDir, { recursive: true });
fs.mkdirSync(runtimeDir, { recursive: true });
fs.mkdirSync(githubDir, { recursive: true });
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
  "module.exports = {\n" +
    "  vaultStatus: async () => ({ connected: true, cloned: false }),\n" +
    "  vaultEnsure: async () => globalThis.__vaultEnsure(),\n" +
    "};\n",
);
// The real (dependency-free) liveness module — vaultSync imports the
// heartbeat cadence constant from it.
const advancedDir = path.join(temp, "pages", "advanced");
fs.mkdirSync(advancedDir, { recursive: true });
fs.writeFileSync(
  path.join(advancedDir, "deviceLiveness.js"),
  ts.transpileModule(read(path.join(SRC, "pages", "advanced", "deviceLiveness.ts")), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText,
);
// vaultSync reads/writes hot blobs (keys that deliberately never touch
// localStorage). Back the stub with a real map and take the prefix list from
// the REAL stateMirror source, so this stub cannot drift from the app.
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
fs.writeFileSync(path.join(runtimeDir, "vaultSync.js"), output);

function storage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key: (i) => [...values.keys()][i] ?? null,
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => void values.set(key, String(value)),
    removeItem: (key) => void values.delete(key),
  };
}
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
globalThis.location = { reload: () => {} };
globalThis.document = { addEventListener: () => {}, visibilityState: "visible" };
globalThis.window = {
  addEventListener: () => {},
  dispatchEvent: () => {},
  setInterval: () => 1,
};
const startupEvents = [];
let ensureCalls = 0;
globalThis.__vaultEnsure = async () => {
  ensureCalls += 1;
  startupEvents.push("ensure");
  if (ensureCalls === 1) throw new Error("temporary network failure");
  return { connected: true, cloned: true };
};
globalThis.__vaultInvoke = async (command) => {
  startupEvents.push(command);
  if (command === "device_get_id") return "device-test";
  if (command === "vault_read_remote_state") return null;
  if (command === "vault_sync_projects") return false;
  return null;
};
const runtime = require(path.join(runtimeDir, "vaultSync.js"));
const originalWarn = console.warn;
console.warn = () => {}; // the first failure is intentional in this test
try {
  await runtime.startVaultSync();
  await runtime.startVaultSync();
} finally {
  console.warn = originalWarn;
}
check(ensureCalls === 2,
  "startup retries clone recovery after a transient failure");
check(startupEvents.lastIndexOf("ensure") < startupEvents.indexOf("vault_sync_projects"),
  "the repaired clone exists before the real project-sync command runs");

const remote = read(path.join(DESKTOP, "src-tauri", "src", "remote_devices", "mod.rs"));
check(remote.includes("pub fn device_get_id()") && remote.includes("self_device_id()"),
  "the UI identity and folder-map identity are the same backend id");

const vault = read(path.join(DESKTOP, "src-tauri", "src", "vault.rs"));
check(vault.includes("belongs_to_peer") && vault.includes("reconcile project location"),
  "existing legacy project rows reconcile foreign folder paths");
check(vault.includes("fn import_clears_existing_foreign_legacy_path"),
  "a regression test covers already-contaminated project rows");
check(vault.includes("fn import_restores_this_devices_path_on_existing_row"),
  "a regression test covers same-device folder restoration");
const projects = read(path.join(DESKTOP, "src-tauri", "src", "projects.rs"));
check(projects.includes("location_device_id") && projects.includes("Path::new(&location).is_dir()"),
  "legacy rows are locally owned only when their folder exists on this computer");
check(projects.includes("CASE WHEN location_device_id = ?1 THEN location ELSE '' END"),
  "the project API never exposes a folder owned by another device");

console.log(`\nall checks passed (${passed})`);
