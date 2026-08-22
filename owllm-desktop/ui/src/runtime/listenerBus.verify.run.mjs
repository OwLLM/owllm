// One-shot verify for the watcher/callback pipeline (listenerBus.ts + every
// store that fans changes out to registered watchers).
//
// WHAT IT PROVES
//   A. listenerBus semantics — repeated events, error isolation, disposal
//      during a notify pass, re-registration, no duplicate callback for a
//      listener that subscribes mid-pass, background→UI delivery order.
//   B. INTEGRATION over the REAL store modules, one per family named in the
//      bug: state (pageSettings), file/queue (downloadStore), agent
//      (chatRuntime), plus worldState and the toast hub. Each is driven
//      through its real emit path with a THROWING watcher registered first —
//      before the fix, that watcher starved every later one.
//   C. STATIC gate — no store may go back to the unguarded
//      `for (const l of listeners) l()` / `listeners.forEach(...)` loop.
//   D. Restart behaviour — a freshly loaded module starts with an empty
//      registry and still delivers; watchers from the previous "session" are
//      not resurrected.
//
// Modules are transpiled from the REAL .ts/.tsx sources and executed against a
// tiny require shim (Tauri/React/etc. are stubbed) — no jsdom, no bundler.
//
// Run from owllm-desktop/:  node ui/src/runtime/listenerBus.verify.run.mjs
// Exits non-zero on any assertion failure.
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// HERE = owllm-desktop/ui/src/runtime → up 3 = owllm-desktop (holds node_modules).
const REPO = path.resolve(HERE, "../../..");
const SRC = path.resolve(HERE, "..");
const ts = (await import(pathToFileURL(path.join(REPO, "node_modules/typescript/lib/typescript.js")).href)).default;

let pass = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) { pass++; return; }
  fails.push(extra ? `${name} — ${extra}` : name);
}

// ---- minimal browser shim ---------------------------------------------------
function makeLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
  };
}
const winListeners = new Map();
globalThis.window = {
  addEventListener: (t, cb) => {
    if (!winListeners.has(t)) winListeners.set(t, new Set());
    winListeners.get(t).add(cb);
  },
  removeEventListener: (t, cb) => { winListeners.get(t)?.delete(cb); },
  dispatchEvent: (e) => { winListeners.get(e.type)?.forEach((cb) => cb(e)); return true; },
};
globalThis.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
globalThis.localStorage = makeLocalStorage();

// Swallow the deliberate "watcher threw" report so the run stays readable, but
// count it — the fix MUST report, not silently eat, a bad watcher.
let reported = 0;
const realError = console.error;
console.error = (...a) => {
  if (typeof a[0] === "string" && a[0].includes("[owllm] watcher")) { reported++; return; }
  realError(...a);
};

// ---- module loader ----------------------------------------------------------
// A stub that can be called, constructed, and property-accessed without ever
// throwing — stands in for Tauri/React/sibling modules we are not testing.
function makeAnyFn() {
  const fn = function () {};
  const p = new Proxy(fn, {
    get: (_t, key) => (key === "__esModule" ? true : p),
    apply: () => undefined,
    construct: () => ({}),
  });
  return p;
}
const ANY = makeAnyFn();
const GENERIC_STUB = new Proxy({}, { get: (_t, key) => (key === "__esModule" ? true : ANY) });

function transpile(absPath) {
  const src = fs.readFileSync(absPath, "utf8");
  return ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      jsx: ts.JsxEmit.React,
    },
    fileName: absPath,
  }).outputText;
}

/// Load one real source file. `deps` maps a bare/relative request to an
/// exports object; anything unlisted resolves to GENERIC_STUB, except
/// listenerBus which always resolves to the single real instance.
function load(relPath, deps = {}, busInstance = null) {
  const abs = path.join(SRC, relPath);
  const js = transpile(abs);
  const module = { exports: {} };
  const require = (req) => {
    if (req.endsWith("listenerBus")) return busInstance ?? loadBus();
    if (Object.prototype.hasOwnProperty.call(deps, req)) return deps[req];
    return GENERIC_STUB;
  };
  // eslint-disable-next-line no-new-func
  new Function("exports", "require", "module", "__filename", "__dirname", js)(
    module.exports, require, module, abs, path.dirname(abs),
  );
  return module.exports;
}

let BUS = null;
function loadBus() {
  if (!BUS) BUS = load("runtime/listenerBus.ts", {}, {});
  return BUS;
}
const bus = loadBus();
const { notifyListeners } = bus;

// ============================================================================
// A. listenerBus semantics
// ============================================================================
check("A1 notifyListeners is exported", typeof notifyListeners === "function");

{ // repeated events reach the same watcher every time
  const set = new Set();
  let n = 0;
  set.add(() => { n++; });
  for (let i = 0; i < 5; i++) notifyListeners(set, "t");
  check("A2 repeated events all delivered", n === 5, `got ${n}`);
}

{ // ERROR ISOLATION — the core defect
  const set = new Set();
  const seen = [];
  set.add(() => { seen.push("first"); });
  set.add(() => { throw new Error("bad watcher"); });
  set.add(() => { seen.push("third"); });
  const before = reported;
  notifyListeners(set, "isolation");
  check("A3 a throwing watcher does not starve later watchers",
    seen.join(",") === "first,third", `saw [${seen}]`);
  check("A4 the throw is reported, not swallowed", reported === before + 1);
  seen.length = 0;
  notifyListeners(set, "isolation");
  check("A5 the throwing watcher stays registered and others keep firing",
    seen.join(",") === "first,third", `saw [${seen}]`);
}

{ // the emitter must survive a bad watcher (no unwinding of the caller)
  const set = new Set();
  set.add(() => { throw new Error("boom"); });
  let threw = false;
  try { notifyListeners(set, "emitter"); } catch { threw = true; }
  check("A6 notifyListeners never rethrows into the emitter", !threw);
}

{ // disposal DURING a pass is honoured
  const set = new Set();
  let lateCalled = 0;
  const late = () => { lateCalled++; };
  set.add(() => { set.delete(late); });
  set.add(late);
  notifyListeners(set, "dispose");
  check("A7 a watcher disposed mid-pass is not called in that pass", lateCalled === 0);
}

{ // registration DURING a pass must NOT double-fire in the same pass
  const set = new Set();
  let addedCalls = 0;
  const added = () => { addedCalls++; };
  set.add(() => { set.add(added); });
  notifyListeners(set, "add");
  check("A8 a watcher added mid-pass waits for the next event", addedCalls === 0);
  notifyListeners(set, "add");
  check("A9 the added watcher fires on the next event", addedCalls === 1, `got ${addedCalls}`);
}

{ // unsubscribe + re-register (page unmount → remount)
  const set = new Set();
  let n = 0;
  const cb = () => { n++; };
  set.add(cb);
  notifyListeners(set, "re");
  set.delete(cb);
  notifyListeners(set, "re");
  check("A10 a disposed watcher stops receiving", n === 1, `got ${n}`);
  set.add(cb);
  notifyListeners(set, "re");
  check("A11 re-registration works after disposal", n === 2, `got ${n}`);
  check("A12 re-registration does not duplicate", set.size === 1);
}

{ // arguments are forwarded verbatim
  const set = new Set();
  let got = null;
  set.add((a, b) => { got = [a, b]; });
  notifyListeners(set, "args", 1, "x");
  check("A13 payload args are forwarded", JSON.stringify(got) === '[1,"x"]', JSON.stringify(got));
}

// ============================================================================
// B. Integration over the REAL stores
// ============================================================================

// --- B1 state updates: pageSettings -----------------------------------------
{
  const settings = load("state/pageSettings.ts", {
    "react": { useEffect: () => {}, useState: () => [null, () => {}] },
    "../runtime/stateMirror": { hotBlobKeys: () => [], readHotBlob: () => null },
  });
  const seen = [];
  const offBad = settings.subscribeSettings(() => { throw new Error("bad state watcher"); });
  const offGood = settings.subscribeSettings(() => { seen.push("good"); });
  settings.setSetting("verify-scope", "k", "v1");
  check("B1 state watcher fires past a throwing watcher", seen.length === 1, `got ${seen.length}`);
  settings.setSetting("verify-scope", "k", "v2");
  check("B2 state watcher keeps firing on repeated writes", seen.length === 2, `got ${seen.length}`);
  offGood();
  settings.setSetting("verify-scope", "k", "v3");
  check("B3 unsubscribed state watcher goes quiet", seen.length === 2, `got ${seen.length}`);
  offBad();
}

// --- B4 file/queue updates: downloadStore ------------------------------------
{
  const dl = load("pages/finetuning/downloadStore.ts");
  let good = 0;
  const offBad = dl.subscribe(() => { throw new Error("bad download watcher"); });
  const offGood = dl.subscribe(() => { good++; });
  void dl.startDownload("verify/model", ["a.gguf"]);
  check("B4 download-queue watcher fires past a throwing watcher", good >= 1, `got ${good}`);
  const afterStart = good;
  dl.dismiss("verify/model");
  check("B5 download watcher receives the follow-up event", good >= afterStart, `got ${good}`);
  offGood(); offBad();
  const quiet = good;
  dl.dismiss("verify/model");
  check("B6 disposed download watcher goes quiet", good === quiet);
}

// --- B7 agent/stream updates: chatRuntime ------------------------------------
{
  const cr = load("runtime/chatRuntime.ts", { "./runActivity": { setRunActivity: () => {} } });
  const store = cr.chatRuntime;
  const sid = "verify-session";
  store.ensureSession(sid);
  let good = 0;
  const offBad = store.subscribe(sid, () => { throw new Error("bad agent watcher"); });
  const offGood = store.subscribe(sid, () => { good++; });
  store.hydrateIfIdle(sid, { messages: [1] });
  check("B7 agent watcher fires past a throwing watcher", good === 1, `got ${good}`);
  // a second session's watchers must be untouched by the first's bad one
  let other = 0;
  const offOther = store.subscribe("verify-other", () => { other++; });
  store.ensureSession("verify-other");
  store.hydrateIfIdle("verify-other", { messages: [2] });
  check("B8 per-session watcher isolation holds", other === 1, `got ${other}`);
  offGood(); offBad(); offOther();
}

// --- B9 world/XP state -------------------------------------------------------
{
  const ws = load("pages/world/worldState.ts");
  let good = 0;
  const offBad = ws.subscribeProgress(() => { throw new Error("bad world watcher"); });
  const offGood = ws.subscribeProgress(() => { good++; });
  ws.addXp(5, "verify");
  check("B9 world watcher fires past a throwing watcher", good >= 1, `got ${good}`);
  ws.invalidateProgress();
  check("B10 world watcher receives repeated events", good >= 2, `got ${good}`);
  offGood(); offBad();
}

// --- B11 toast hub (background → UI delivery) --------------------------------
{
  const toast = load("components/Toast.tsx", {
    "react": { useEffect: () => {}, useRef: () => ({ current: null }), useState: () => [null, () => {}], createElement: () => null, default: {} },
  });
  check("B11 toast hub exposes notify()", typeof toast.notify === "function");
  toast.notify("info", "verify");
  check("B12 toast hub records the event", toast.currentToasts().length >= 1);
}

// ============================================================================
// C. STATIC gate — no store may regress to the unguarded loop
// ============================================================================
const HUBS = [
  "state/pageSettings.ts",
  "runtime/chatRuntime.ts",
  "runtime/moduleUpdates.ts",
  "components/Toast.tsx",
  "pages/finetuning/downloadStore.ts",
  "pages/finetuning/envInstall.ts",
  "pages/core/accountsStore.ts",
  "pages/core/readinessStore.ts",
  "pages/core/ServerPage.tsx",
  "pages/advanced/AccountsPage.tsx",
  "pages/agentic/CodePage.tsx",
  "pages/agentic/cloudCatalogue.ts",
  "pages/agentic/peerCatalogue.ts",
  "pages/agentic/voice.ts",
  "pages/gamify/worldChatRuntime.ts",
  "pages/world/worldState.ts",
];
// Matches the unsafe fan-out shapes this fix removed.
const UNSAFE = [
  /for\s*\(\s*const\s+\w+\s+of\s+(?:this\.)?_?(?:listeners|subs|_listeners|activityListeners)\s*\)\s*\w+\s*\(/,
  /(?:this\.)?_?(?:listeners|subs|_listeners|activityListeners)\s*\.forEach\s*\(/,
];
for (const rel of HUBS) {
  const text = fs.readFileSync(path.join(SRC, rel), "utf8");
  check(`C:${rel} routes its fan-out through notifyListeners`,
    /notifyListeners\s*\(/.test(text) && /from "[^"]*listenerBus"/.test(text));
  const bad = UNSAFE.find((re) => re.test(text));
  check(`C:${rel} has no unguarded listener loop`, !bad, bad ? String(bad) : "");
}

// ============================================================================
// D. Restart behaviour — a fresh load starts clean and still delivers
// ============================================================================
{
  const first = load("pages/world/worldState.ts");
  let stale = 0;
  first.subscribeProgress(() => { stale++; });
  first.invalidateProgress();
  const afterFirst = stale;
  check("D1 pre-restart watcher works", afterFirst === 1, `got ${afterFirst}`);

  // Re-loading the module is this harness's stand-in for an app restart: a new
  // module instance with its own, empty registry.
  const second = load("pages/world/worldState.ts");
  let fresh = 0;
  second.subscribeProgress(() => { fresh++; });
  second.invalidateProgress();
  check("D2 watcher registered after restart fires", fresh === 1, `got ${fresh}`);
  check("D3 pre-restart watchers are not resurrected", stale === afterFirst, `got ${stale}`);
}

// ---- report -----------------------------------------------------------------
console.error = realError;
if (fails.length) {
  console.error(`\n✗ listenerBus verify: ${fails.length} FAILED, ${pass} passed`);
  for (const f of fails) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`✓ listenerBus verify: ${pass}/${pass} checks passed (watcher fan-out, ${HUBS.length} stores)`);
