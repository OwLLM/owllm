// Tripwire for the startup white flash.
//
// This bug has shipped, been fixed, and come back TWICE. It came back because
// nothing failed when it did: the fix is several cooperating facts in several
// different files, and any one can be undone by an unrelated change with no
// signal.
//
// Part A — the window must not be revealed before it has painted:
//   1. the main window starts hidden  (tauri.conf.json  "visible": false)
//   2. it is revealed only from on_page_load / PageLoadEvent::Finished
//   3. NOT from setup() — setup runs before the first paint, so showing there
//      reveals an unpainted white surface, which IS the flash
//   4. main is shown BEFORE the overlay frame — an overlay arriving early or
//      unpainted is the other half of the flash
//
// Part B — what it paints when revealed must already be the SAVED theme.
// A hidden-until-painted window still flashes if the thing it paints is the
// wrong colour. Both startup covers used to hardcode #06080d, which matches
// no theme: resolved against the real stylesheet in a real CSS engine,
// --bg-panel is srgb(0.928 0.939 0.990) for light/indigo (near-white) and
// srgb(0.141 0.174 0.297) for dark/indigo. Because BootCover mounts AFTER the
// React tree, a light-mode boot went near-black splash -> near-white app ->
// near-black cover -> near-white app: two full-contrast flips.
//
// Part C — the theme must be applied exactly ONCE before the first frame.
// bootstrapTheme() paints it pre-render, then useTheme()'s mount effects asked
// for the same values again; that second application re-invalidated document
// style and re-pushed the accent to the overlay webview just as the window was
// revealed. And on a WebView profile change the theme keys only come back from
// restoreStateMirror(), which resolves AFTER the module-scope bootstrap — so
// the theme has to be re-applied once the mirror has rehydrated, before render.
//
// Parts A/B are source-level. Part C additionally REPLAYS a boot against the
// real theme module under jsdom, so the memoisation is proven behaviourally
// rather than by grep.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "../..");
const require = createRequire(path.join(DESKTOP, "package.json"));

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`✓ ${message}`);
}

// --- A1. the window must start hidden --------------------------------------
const conf = JSON.parse(fs.readFileSync(path.join(DESKTOP, "src-tauri", "tauri.conf.json"), "utf8"));
const windows = conf.app?.windows ?? [];
const main = windows.find((w) => w.label === "main");
check(Boolean(main), "tauri.conf.json defines the main window");
check(main.visible === false,
  'main window is created hidden ("visible": false) — a visible window paints white before the UI exists');

// --- A2..A4. the reveal must happen on page load, after paint --------------
const lib = fs.readFileSync(path.join(DESKTOP, "src-tauri", "src", "lib.rs"), "utf8");

const setupAt = lib.indexOf(".setup(");
const pageLoadAt = lib.indexOf(".on_page_load(");
const handlerAt = lib.indexOf(".invoke_handler(", pageLoadAt);
check(setupAt >= 0 && pageLoadAt > setupAt && handlerAt > pageLoadAt,
  "lib.rs still has the setup() → on_page_load() → invoke_handler() builder shape this guard reads");

const setupBlock = lib.slice(setupAt, pageLoadAt);
const pageLoadBlock = lib.slice(pageLoadAt, handlerAt);

check(/PageLoadEvent::Finished/.test(pageLoadBlock),
  "the reveal is gated on PageLoadEvent::Finished (the UI has painted)");
check(/webview\.label\(\) == "main"/.test(pageLoadBlock),
  "the reveal is gated on the main window");
check(/\.show\(\)/.test(pageLoadBlock),
  "the main window is shown from on_page_load");
check(!/\.show\(\)/.test(setupBlock),
  "setup() shows no window — setup runs before the first paint, so revealing there IS the flash");

const mainShowAt = pageLoadBlock.indexOf("dispatch_window.show()");
const overlayShowAt = pageLoadBlock.indexOf("prepare_and_show_for_main");
check(mainShowAt >= 0 && overlayShowAt >= 0,
  "both the main reveal and the overlay reveal are present");
check(mainShowAt < overlayShowAt,
  "main is revealed BEFORE the overlay frame (an early or unpainted overlay is the other half of the flash)");

// --- B. both startup covers wear the SAVED theme, not a literal -------------
//
// The canvas token is whatever the shell variants paint. Derive it from
// AppShell rather than hardcoding it here, so that if the canvas is ever
// re-tokenised this guard reports the mismatch instead of silently passing.
const shell = fs.readFileSync(path.join(HERE, "AppShell.tsx"), "utf8");
const CANVAS_TOKEN = "--bg-panel";

const overlayPanelAt = shell.indexOf("function OverlayContentPanel");
const overlayPanelBlock = shell.slice(overlayPanelAt, overlayPanelAt + 400);
check(overlayPanelAt >= 0 && overlayPanelBlock.includes(`var(${CANVAS_TOKEN})`),
  `OverlayContentPanel paints var(${CANVAS_TOKEN}) as the app canvas`);
check(/data-ui="LinuxMainContent"[^]{0,220}var\(--bg-panel\)/.test(shell),
  `the Linux shell paints var(${CANVAS_TOKEN}) as the app canvas`);
check(/data-ui="hybrid-frame-root"[^]{0,900}var\(--bg-panel\)/.test(shell),
  `HybridFrame's content pane paints var(${CANVAS_TOKEN}) as the app canvas`);

const html = fs.readFileSync(path.join(DESKTOP, "ui", "index.html"), "utf8");
const splashMatch = html.match(/id="boot-splash"[^>]*style="([^"]*)"/);
check(Boolean(splashMatch), "index.html still ships the #boot-splash cover this guard reads");
check(splashMatch[1].includes(`var(${CANVAS_TOKEN}`),
  `#boot-splash paints var(${CANVAS_TOKEN}) — a literal colour matches no theme and IS the flash`);

const mainTsx = fs.readFileSync(path.join(HERE, "main.tsx"), "utf8");
const coverAt = mainTsx.indexOf("function BootCover");
const coverBlock = mainTsx.slice(coverAt, mainTsx.indexOf("async function boot("));
check(coverAt >= 0 && coverBlock.includes(`var(${CANVAS_TOKEN}`),
  `BootCover paints var(${CANVAS_TOKEN}) — it mounts after the tree, so a literal is a SECOND flash`);
check(!/background:\s*["']#[0-9a-f]{6}["']/i.test(coverBlock),
  "BootCover carries no hardcoded background colour");

// --- C1. ordering: theme is re-applied after the mirror, before render ------
const bootAt = mainTsx.indexOf("async function boot(");
const bootBlock = mainTsx.slice(bootAt);
const restoreAt = bootBlock.indexOf("await restoreStateMirror()");
const reapplyAt = bootBlock.indexOf("bootstrapTheme()");
const renderAt = bootBlock.indexOf("ReactDOM.createRoot");
check(mainTsx.slice(0, bootAt).includes("bootstrapTheme()"),
  "bootstrapTheme() runs at module scope — before anything can paint");
check(restoreAt >= 0 && reapplyAt > restoreAt && renderAt > reapplyAt,
  "boot() re-applies the theme AFTER restoreStateMirror() and BEFORE the first render — "
  + "a mirror-restored theme would otherwise land one frame late, as a visible repaint");

// --- C2. page swaps must not unmount a themed page --------------------------
check(/display:\s*activeKey === p\.key \? "block" : "none"/.test(shell),
  "keep-alive pages are hidden via display, never unmounted — remounting repaints a page from scratch");

// --- C3. BEHAVIOURAL: replay a boot against the real theme module ----------
let jsdom;
try {
  jsdom = require("jsdom");
} catch {
  console.log("SKIP behavioural replay: jsdom not installed (run npm install in owllm-desktop)");
}

if (jsdom) {
  const ts = require("typescript");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-flash-"));
  const transpile = (name) => ts.transpileModule(
    fs.readFileSync(path.join(HERE, `${name}.ts`), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
  ).outputText;

  // Count the IPC pushes without a Tauri runtime: the accent push re-evals the
  // overlay webview, so a duplicate application is observable here.
  fs.writeFileSync(path.join(temp, "tauriStub.cjs"),
    "exports.invoke = (cmd, args) => { require('./ipcLog.cjs').push({ cmd, args }); "
    + "return Promise.resolve(); };\n");
  fs.writeFileSync(path.join(temp, "ipcLog.cjs"), "module.exports = [];\n");
  fs.writeFileSync(path.join(temp, "themePreferences.cjs"), transpile("themePreferences"));
  // The sandbox sits in the OS temp dir, so bare specifiers can't resolve back
  // to owllm-desktop/node_modules — rewrite them to absolute paths.
  const reactPath = require.resolve("react").replace(/\\/g, "/");
  fs.writeFileSync(path.join(temp, "theme.cjs"),
    transpile("theme")
      .replace(/"@tauri-apps\/api\/core"/g, '"./tauriStub.cjs"')
      .replace(/"\.\/themePreferences"/g, '"./themePreferences.cjs"')
      .replace(/"react"/g, JSON.stringify(reactPath)));

  const dom = new jsdom.JSDOM("<!doctype html><html><body></body></html>");
  const store = new Map();
  global.window = dom.window;
  global.document = dom.window.document;
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };

  // Count real CSS writes so "applied twice" is measured, not inferred.
  const rootStyle = dom.window.document.documentElement.style;
  const nativeSetProperty = rootStyle.setProperty.bind(rootStyle);
  let cssWrites = 0;
  rootStyle.setProperty = (...args) => { cssWrites += 1; return nativeSetProperty(...args); };

  const theme = require(path.join(temp, "theme.cjs"));
  const ipcLog = require(path.join(temp, "ipcLog.cjs"));

  const root = dom.window.document.documentElement;
  const readAccent = () => root.style.getPropertyValue("--accent");

  // (a) cold boot with the mirror EMPTY — the pre-upgrade / wiped-profile case
  cssWrites = 0; ipcLog.length = 0;
  theme.bootstrapTheme();
  check(root.getAttribute("data-theme") === "dark" && readAccent() === "#667eea",
    "cold boot with no persisted theme applies the documented defaults before render");

  // (b) the mirror rehydrates a LIGHT/amber theme, then boot() re-applies
  store.set("owllm:theme:mode", "light");
  store.set("owllm:theme:accent", "amber");
  cssWrites = 0; ipcLog.length = 0;
  theme.bootstrapTheme();
  check(root.getAttribute("data-theme") === "light" && readAccent() === "#fbbf24",
    "a theme restored by the state mirror is applied by the re-bootstrap, still before render");
  check(cssWrites > 0, "the re-bootstrap really did repaint (the instrument can detect a change)");

  // (c) useTheme's mount effects then ask for the SAME values — must be a no-op
  cssWrites = 0; ipcLog.length = 0;
  theme.bootstrapTheme();
  check(cssWrites === 0,
    "re-applying an unchanged theme writes no CSS — the duplicate application was a second repaint");
  check(ipcLog.length === 0,
    "re-applying an unchanged theme pushes no IPC — the accent push re-evals the overlay webview mid-reveal");
  check(root.getAttribute("data-theme") === "light" && readAccent() === "#fbbf24",
    "suppressing the duplicate application leaves the applied theme intact");

  // (d) a genuine change must still get through the memo
  store.set("owllm:theme:mode", "dark");
  store.set("owllm:theme:accent", "#123456");
  cssWrites = 0; ipcLog.length = 0;
  theme.bootstrapTheme();
  check(root.getAttribute("data-theme") === "dark" && readAccent() === "#123456",
    "a real theme change still applies — the memo suppresses no-ops only");
  check(cssWrites > 0 && ipcLog.some((c) => c.cmd === "overlay_frame_set_accent"),
    "a real accent change still repaints and still pushes the accent to the overlay frame");

  fs.rmSync(temp, { recursive: true, force: true });
}

console.log(`OK startup white flash: ${passed}/${passed} checks passed`);
