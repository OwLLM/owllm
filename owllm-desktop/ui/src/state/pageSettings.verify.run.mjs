// One-shot verify for the saved-project/page settings layer (pageSettings.ts):
// the local read/write API, scope isolation, the "empty ⇒ neutral, no churn"
// write rules, subscribe notifications, the swappable backend seam, and the
// non-destructive legacy-key migration. Transpiles the REAL pageSettings.ts to
// CJS and drives it against a tiny localStorage/window shim — no jsdom needed.
//
// Run from owllm-desktop/:  node ui/src/state/pageSettings.verify.run.mjs
// Exits non-zero on any assertion failure.
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// HERE = owllm-desktop/ui/src/state → up 3 = owllm-desktop/ui (holds node_modules).
const REPO = path.resolve(HERE, "../../..");
const ts = (await import(pathToFileURL(path.join(REPO, "node_modules/typescript/lib/typescript.js")).href)).default;

// ---- minimal browser shim (localStorage + window events + CustomEvent) ----
function makeLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
    _dump: () => Object.fromEntries(m),
  };
}
const winListeners = new Map();
globalThis.window = {
  addEventListener: (t, cb) => { (winListeners.get(t) ?? winListeners.set(t, new Set()).get(t)).add(cb); },
  removeEventListener: (t, cb) => { winListeners.get(t)?.delete(cb); },
  dispatchEvent: (e) => { winListeners.get(e.type)?.forEach((cb) => cb(e)); return true; },
};
globalThis.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
globalThis.localStorage = makeLocalStorage();

// ---- transpile + load the real module ----
const src = fs.readFileSync(path.join(HERE, "pageSettings.ts"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const TMP = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "pset-"));
const modPath = path.join(TMP, "pageSettings.cjs");
fs.writeFileSync(modPath, js);
const { createRequire } = await import("node:module");
const req = createRequire(path.join(REPO, "package.json"));
// react is imported at module top; resolve it via the repo's node_modules.
const Module = req("module");
const reactPath = req.resolve("react"); // resolve ONCE, before patching (avoid recursion)
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "react") return reactPath;
  return origResolve.call(this, request, ...rest);
};
const S = req(modPath);

// ---- assertions ----
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error("FAIL:", msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// 1) get on empty ⇒ fallback
eq(S.getSetting(S.scope.global(), "nope", "fb"), "fb", "get missing returns fallback");
eq(S.getSetting(S.scope.global(), "nope"), undefined, "get missing w/o fallback ⇒ undefined");

// 2) set/get round-trip + persisted under the SYNCABLE key
S.setSetting(S.scope.page("p1"), S.SettingKey.model, "qwen");
eq(S.getSetting(S.scope.page("p1"), S.SettingKey.model), "qwen", "round-trip");
ok(localStorage.getItem(S.SETTINGS_STORAGE_KEY) != null, "stored under owllm:settings:v1");
ok(S.SETTINGS_STORAGE_KEY.startsWith("owllm:") && !S.SETTINGS_STORAGE_KEY.startsWith("owllm:code:"),
   "storage key is syncable (owllm: prefix, not the denied owllm:code: prefix)");

// 3) scope isolation — same key, different scopes don't collide
S.setSetting(S.scope.page("p2"), S.SettingKey.model, "llama");
eq(S.getSetting(S.scope.page("p1"), S.SettingKey.model), "qwen", "scope p1 intact");
eq(S.getSetting(S.scope.page("p2"), S.SettingKey.model), "llama", "scope p2 distinct");

// 4) empty/undefined ⇒ neutral (deletes, never persists an empty pick)
S.setSetting(S.scope.page("p1"), S.SettingKey.model, "");
eq(S.getSetting(S.scope.page("p1"), S.SettingKey.model), undefined, "empty clears to neutral");

// 5) subscribe fires on change, and a no-op write does NOT churn
let hits = 0;
const unsub = S.subscribeSettings(() => { hits++; });
S.setSetting(S.scope.page("p2"), S.SettingKey.model, "mistral"); // change ⇒ 1
S.setSetting(S.scope.page("p2"), S.SettingKey.model, "mistral"); // same ⇒ no fire
eq(hits, 1, "subscribe fires once for a real change, skips no-op writes");
unsub();
S.setSetting(S.scope.page("p2"), S.SettingKey.model, "gemma");
eq(hits, 1, "unsubscribe stops notifications");

// 6) backend seam — swap in an in-memory backend; API keeps working unchanged
let mem = { v: 1, scopes: {}, mig: {} };
S.setSettingsBackend({ read: () => mem, write: (d) => { mem = d; } });
eq(S.getSetting(S.scope.global(), "x"), undefined, "fresh backend is empty");
S.setSetting(S.scope.global(), "x", 42);
eq(S.getSetting(S.scope.global(), "x"), 42, "writes go to the swapped backend");
ok(mem.scopes[S.scope.global()].x === 42, "swapped backend actually holds the value");
// restore default localStorage backend for the migration test
S.setSettingsBackend({
  read: () => { try { const r = localStorage.getItem(S.SETTINGS_STORAGE_KEY); return r ? JSON.parse(r) : { v: 1, scopes: {}, mig: {} }; } catch { return { v: 1, scopes: {}, mig: {} }; } },
  write: (d) => localStorage.setItem(S.SETTINGS_STORAGE_KEY, JSON.stringify(d)),
});

// 7) migration — legacy watcher + code-page-blob models lift into the schema,
//    keyed by stable scope ids, NON-DESTRUCTIVELY (legacy keys survive).
localStorage.setItem("owllm:watcher:model", "watcher-pick");
localStorage.setItem("owllm:code:page:pAAA", JSON.stringify({ workspace: "C:/machine/path", modelId: "code-pick", secondaryModelId: "code-2nd" }));
localStorage.setItem("owllm:code:page:pBBB", JSON.stringify({ workspace: "/other", modelId: "" })); // no model ⇒ nothing to lift
S.migratePageSettings();
eq(S.getSetting(S.scope.global(), S.SettingKey.watcherModel), "watcher-pick", "migrated watcher model");
eq(S.getSetting(S.scope.page("pAAA"), S.SettingKey.model), "code-pick", "migrated code page model");
eq(S.getSetting(S.scope.page("pAAA"), S.SettingKey.secondaryModel), "code-2nd", "migrated code page 2nd model");
eq(S.getSetting(S.scope.page("pBBB"), S.SettingKey.model), undefined, "empty legacy model not migrated");
ok(localStorage.getItem("owllm:watcher:model") === "watcher-pick", "migration is non-destructive (legacy watcher key intact)");
ok(localStorage.getItem("owllm:code:page:pAAA") != null, "migration is non-destructive (legacy code blob intact)");
// idempotent: a second run neither duplicates nor re-imports a since-cleared value
S.setSetting(S.scope.global(), S.SettingKey.watcherModel, ""); // user cleared it
S.migratePageSettings();
eq(S.getSetting(S.scope.global(), S.SettingKey.watcherModel), undefined, "migration is idempotent (does not re-import after clear)");

console.log(fail === 0 ? `OK pageSettings: ${pass}/${pass} checks passed` : `pageSettings: ${pass} passed, ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
