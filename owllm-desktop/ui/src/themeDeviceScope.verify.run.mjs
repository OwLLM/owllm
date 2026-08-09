// GUI + text colours are PER-DEVICE. They must never cross the vault.
//
// The theme keys (`owllm:theme:*`) live in localStorage, and vaultSync mirrors
// "every owllm: key that isn't explicitly denied" into the user's vault repo.
// So the appearance of THIS computer was published to the account and adopted
// by every other one: plugging in a second PC silently repainted the first, and
// because adoption happens during startVaultSync — after bootstrapTheme has
// already painted the first frame — the repaint arrived as a visible flash.
//
// A device's own colour choice is the single source of truth for that device.
// This file pins that three ways:
//
//   Part 1  BEHAVIOURAL — run the REAL vaultSync module against a remote blob
//           carrying different colours, and prove the local values survive
//           while ordinary shared content is still adopted (the control: a
//           sandbox that adopted nothing would pass part 1 for free).
//   Part 2  BEHAVIOURAL — replay the boot through the REAL theme module and
//           prove that the post-sync state applies with ZERO css writes, i.e.
//           the sync cannot produce a post-startup repaint.
//   Part 3  SOURCE — the keys are not project-scoped, and the device-local
//           mirror never overwrites a colour that is already present.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "../..");
const require = createRequire(path.join(DESKTOP, "package.json"));
const ts = require("typescript");
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

let passed = 0;
const check = (ok, message) => {
  if (!ok) throw new Error(`FAIL ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
};

// The key names come from the real module, so renaming a key without revisiting
// the deny-list fails here instead of silently re-opening the leak.
const prefsSrc = read(path.join(HERE, "themePreferences.ts"));
const keyOf = (name) => {
  const m = prefsSrc.match(new RegExp(`export const ${name} = "([^"]+)"`));
  if (!m) throw new Error(`FAIL themePreferences.ts no longer exports ${name}`);
  return m[1];
};
const MODE_KEY = keyOf("THEME_MODE_KEY");
const GUI_COLOR_KEY = keyOf("THEME_GUI_COLOR_KEY");
const TEXT_COLOR_KEY = keyOf("THEME_TEXT_COLOR_KEY");
const COLOUR_KEYS = [MODE_KEY, GUI_COLOR_KEY, TEXT_COLOR_KEY];

// This device's choice. Deliberately a custom hex + light mode, so a remote
// payload that overwrote it would be unmistakable rather than a near-match.
const LOCAL = {
  [MODE_KEY]: "light",
  [GUI_COLOR_KEY]: "#ff8800",
  [TEXT_COLOR_KEY]: "#112233",
};
// What another device would publish.
const REMOTE = {
  [MODE_KEY]: "dark",
  [GUI_COLOR_KEY]: "emerald",
  [TEXT_COLOR_KEY]: "#ffffff",
};
// Ordinary shared content — this MUST still cross, otherwise the test proves
// nothing about the filter and everything about a broken sandbox.
const SHARED_KEY = "owllm:agents:notebook:project-alpha";
const SHARED_REMOTE = JSON.stringify({ notes: "written on the peer", updatedAt: 9e12 });

// --- Part 1: run the real sync engine --------------------------------------

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-theme-scope-"));
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
  transpile(read(path.join(HERE, "pages", "advanced", "deviceLiveness.ts"))),
);
// Hot-blob prefixes come from the REAL stateMirror source so this stub cannot
// drift from the app's idea of which keys bypass localStorage.
const HOT_PREFIXES = [
  ...(read(path.join(HERE, "runtime", "stateMirror.ts"))
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
const syncSrc = read(path.join(HERE, "runtime", "vaultSync.ts"));
fs.writeFileSync(path.join(runtimeDir, "vaultSync.js"), transpile(syncSrc));

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

const store = storage(LOCAL);
globalThis.localStorage = store;
// Mid-session sync: the user has already interacted, so adoption repaints in
// place instead of reloading. That is the path that produced the visible flash,
// and it is the one that keeps running after startVaultSync returns.
globalThis.sessionStorage = storage({ "owllm:session:user-interacted": "1" });
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
globalThis.location = { reload: () => { throw new Error("unexpected reload"); } };
globalThis.document = { addEventListener: () => {}, visibilityState: "visible" };
globalThis.window = { addEventListener: () => {}, dispatchEvent: () => {}, setInterval: () => 1 };

const pushed = [];
globalThis.__vaultInvoke = async (command, args) => {
  if (command === "device_get_id") return "this-device";
  if (command === "vault_read_remote_state") {
    return JSON.stringify({
      syncedAt: 9e12,
      device: "peer-device",
      data: { ...REMOTE, [SHARED_KEY]: SHARED_REMOTE },
    });
  }
  if (command === "vault_write_state") { pushed.push(JSON.parse(args.json)); return null; }
  if (command === "vault_sync_projects") return false;
  return null;
};

const sync = require(path.join(runtimeDir, "vaultSync.js"));
await sync.startVaultSync();

check(store.getItem(SHARED_KEY) === SHARED_REMOTE,
  "control: ordinary shared content IS adopted from the peer (the sandbox really syncs)");
for (const key of COLOUR_KEYS) {
  check(store.getItem(key) === LOCAL[key],
    `${key} keeps this device's value when a peer publishes a different one`);
}

await sync.pushNow(true);
check(pushed.length > 0, "control: this device really pushed a blob (the push path ran)");
const lastPush = pushed[pushed.length - 1].data;
check(lastPush[SHARED_KEY] != null, "control: shared content is still published");
for (const key of COLOUR_KEYS) {
  check(!(key in lastPush), `${key} is never published to the vault`);
}

// Restart: fresh module state, same localStorage, same remote blob still newer
// than anything this device adopted. A colour must not arrive on the second
// launch either — the deny-list has to hold, not just a first-run marker.
const secondDir = path.join(temp, "runtime2");
fs.mkdirSync(secondDir, { recursive: true });
fs.writeFileSync(path.join(secondDir, "vaultSync.js"), transpile(syncSrc));
fs.cpSync(path.join(runtimeDir, "stateMirror.js"), path.join(secondDir, "stateMirror.js"));
globalThis.sessionStorage = storage({ "owllm:session:user-interacted": "1" });
const sync2 = require(path.join(secondDir, "vaultSync.js"));
await sync2.startVaultSync();
for (const key of COLOUR_KEYS) {
  check(store.getItem(key) === LOCAL[key],
    `${key} survives a restart with the peer's blob still in the vault`);
}
sync.stopVaultSync();
sync2.stopVaultSync();

const postSync = Object.fromEntries(COLOUR_KEYS.map((k) => [k, store.getItem(k)]));

// --- Part 2: the sync cannot cause a post-startup repaint ------------------
//
// Apply the pre-sync colours through the REAL theme module, then apply the
// post-sync ones. Zero css writes means the first painted frame is also the
// last one — there is no second, differently-coloured frame to see.
let jsdom;
try { jsdom = require("jsdom"); }
catch { console.log("SKIP repaint replay: jsdom not installed (run npm install in owllm-desktop)"); }

if (jsdom) {
  const themeDir = path.join(temp, "theme");
  fs.mkdirSync(themeDir, { recursive: true });
  fs.writeFileSync(path.join(themeDir, "tauriStub.cjs"), "exports.invoke = () => Promise.resolve();\n");
  fs.writeFileSync(path.join(themeDir, "themePreferences.cjs"), transpile(prefsSrc));
  const reactPath = require.resolve("react").replace(/\\/g, "/");
  fs.writeFileSync(
    path.join(themeDir, "theme.cjs"),
    transpile(read(path.join(HERE, "theme.ts")))
      .replace(/"@tauri-apps\/api\/core"/g, '"./tauriStub.cjs"')
      .replace(/"\.\/themePreferences"/g, '"./themePreferences.cjs"')
      .replace(/"react"/g, JSON.stringify(reactPath)),
  );

  const dom = new jsdom.JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const root = dom.window.document.documentElement;
  const nativeSetProperty = root.style.setProperty.bind(root.style);
  let cssWrites = 0;
  root.style.setProperty = (...a) => { cssWrites += 1; return nativeSetProperty(...a); };

  for (const [k, v] of Object.entries(LOCAL)) store.setItem(k, v);
  const theme = require(path.join(themeDir, "theme.cjs"));
  theme.bootstrapTheme();
  const firstFrame = { mode: root.getAttribute("data-theme"), accent: root.style.getPropertyValue("--accent") };
  check(firstFrame.mode === "light" && firstFrame.accent === LOCAL[GUI_COLOR_KEY],
    "the first frame paints this device's persisted colours");

  // Prove the instrument can see a change at all before trusting a zero.
  cssWrites = 0;
  for (const [k, v] of Object.entries(REMOTE)) store.setItem(k, v);
  theme.bootstrapTheme();
  check(cssWrites > 0 && root.getAttribute("data-theme") === "dark",
    "control: had the peer's colours been adopted, this replay would have repainted");

  // Now the real post-sync state: identical to the first frame, so re-applying
  // it after startVaultSync writes nothing.
  for (const [k, v] of Object.entries(LOCAL)) store.setItem(k, v);
  theme.bootstrapTheme();
  cssWrites = 0;
  for (const [k, v] of Object.entries(postSync)) store.setItem(k, v);
  theme.bootstrapTheme();
  check(cssWrites === 0,
    "re-applying the theme after a vault sync writes no css — no post-startup colour flash");
  check(root.getAttribute("data-theme") === firstFrame.mode
    && root.style.getPropertyValue("--accent") === firstFrame.accent,
    "the colours showing after the sync are the ones the first frame painted");
  dom.window.close();
}

// --- Part 3: source-level invariants ---------------------------------------

check(/const DENY_PREFIX = \[[^\]]*"owllm:theme:"/.test(syncSrc),
  "vaultSync denies the whole owllm:theme: namespace, so a future colour key is device-local by default");
check(COLOUR_KEYS.every((k) => k.startsWith("owllm:theme:")),
  "every colour key really sits under the denied namespace");
check(syncSrc.includes("if (!isSyncable(k)) continue"),
  "the same filter runs on adopt, so a pre-existing vault blob cannot re-import a colour");

// Not project-scoped: a plain literal cannot pick up a project id, so switching
// projects has no key to switch to.
for (const name of ["THEME_MODE_KEY", "THEME_GUI_COLOR_KEY", "THEME_TEXT_COLOR_KEY"]) {
  check(new RegExp(`export const ${name} = "owllm:theme:[a-z-]+";`).test(prefsSrc),
    `${name} is a fixed literal, never keyed by project — switching projects cannot change it`);
}

// The device-local mirror is disaster recovery, not a second sync channel: it
// only fills a key that is absent, so it can never repaint a live choice.
const mirrorSrc = read(path.join(HERE, "runtime", "stateMirror.ts"));
check(/if \(pending_recovery \|\| localStorage\.getItem\(key\) === null\)/.test(mirrorSrc),
  "the local mirror restores a colour only when it is missing — it never overwrites a live one");

fs.rmSync(temp, { recursive: true, force: true });
console.log(`\nOK theme device scope: ${passed}/${passed} checks passed`);
