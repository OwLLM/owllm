// Focused verification for Ctrl+mouse-wheel text zoom on the editable chat /
// notebook / brainstorm / code surfaces. Transpiles the real pure modules; no
// browser/React/Tauri runtime. Covers the four requested dimensions: focus
// targeting, zoom in/out, bounds, and restore-after-restart persistence, plus
// source pins that the AppShell handler and brainstorm wiring stay in place
// (so a squash merge can't silently drop them).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../..");            // ui/src
const DESKTOP = path.resolve(HERE, "../../..");     // owllm-desktop
const require = createRequire(path.join(DESKTOP, "package.json"));
const ts = require("typescript");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-wheelzoom-"));
function transpileInto(relFromSrc, outName) {
  const source = fs.readFileSync(path.join(SRC, relFromSrc), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const out = path.join(temp, outName);
  fs.writeFileSync(out, output);
  return out;
}
// The zoom module imports ./chatFontPreferences — transpile both so the
// generated require() resolves inside the temp dir.
transpileInto("chatFontPreferences.ts", "chatFontPreferences.js");
const zoom = require(transpileInto("chatFontWheelZoom.ts", "chatFontWheelZoom.js"));

// Read source for content matching independent of the checkout's line endings
// (Windows core.autocrlf checks LF-committed files out as CRLF).
const readSrc = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8").replace(/\r\n/g, "\n");

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
}

// Minimal DOM stand-in for the ancestor walk.
function el({ attr = null, fontSize, parent = null } = {}) {
  return {
    getAttribute: (name) => (name === zoom.CHAT_ZOOM_ATTR ? attr : null),
    style: fontSize === undefined ? null : { fontSize },
    parentElement: parent,
  };
}

// --- 1. Focus targeting -----------------------------------------------------
check(zoom.isChatZoomTarget(el({ attr: "" })) === true,
  "an element tagged data-chat-zoom is a zoom target");
check(zoom.isChatZoomTarget(el({ fontSize: "var(--chat-font-size, 13px)" })) === true,
  "an element whose font-size uses --chat-font-size is a zoom target");
const parent = el({ attr: "" });
const innerTextNode = el({ fontSize: "13px", parent });
check(zoom.isChatZoomTarget(innerTextNode) === true,
  "a wheel landing on an inner node resolves up to the zoomable box");
check(zoom.isChatZoomTarget(el({ fontSize: "14px" })) === false,
  "a plain element (fixed font-size, no marker) is NOT a zoom target");
check(zoom.isChatZoomTarget(null) === false,
  "a null target is safely not a zoom target");
// The ancestor walk is bounded — a deep chain of plain nodes stays false and
// cannot loop forever.
let chain = null;
for (let i = 0; i < 30; i += 1) chain = el({ fontSize: "12px", parent: chain });
check(zoom.isChatZoomTarget(chain) === false,
  "a deep non-zoom ancestor chain terminates and returns false");

// --- 2. Zoom in / out -------------------------------------------------------
check(zoom.wheelZoomDelta(-120) === 1 && zoom.wheelZoomDelta(-1) === 1,
  "scrolling up (deltaY < 0) zooms in (+1 step)");
check(zoom.wheelZoomDelta(120) === -1 && zoom.wheelZoomDelta(1) === -1,
  "scrolling down (deltaY > 0) zooms out (-1 step)");
check(zoom.wheelZoomDelta(0) === 0 && zoom.wheelZoomDelta(NaN) === 0,
  "a zero / non-finite wheel delta is a no-op");
check(zoom.nextChatFontStep(0, -120) === 1 && zoom.nextChatFontStep(3, 120) === 2,
  "a wheel notch moves the shared step in the wheel's direction");

// --- 3. Bounds (readable min/max, no overflow) ------------------------------
check(zoom.nextChatFontStep(9, -120) === 9,
  "zooming in at the +9 ceiling is clamped (never past readable max)");
check(zoom.nextChatFontStep(-3, 120) === -3,
  "zooming out at the -3 floor is clamped (never past readable min)");
// Repeated notches never escape the range.
let s = 0;
for (let i = 0; i < 30; i += 1) s = zoom.nextChatFontStep(s, -120);
check(s === 9, "many zoom-in notches saturate exactly at +9");
for (let i = 0; i < 30; i += 1) s = zoom.nextChatFontStep(s, 120);
check(s === -3, "many zoom-out notches saturate exactly at -3");

// --- 4. Restore after restart (persistence) ---------------------------------
// The wheel drives the SAME persisted step as the Settings buttons, so a
// wheel-chosen size survives a restart via chatFontPreferences.
const prefs = require(path.join(temp, "chatFontPreferences.js"));
const store = (() => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) };
})();
let step = prefs.readChatFontStep(store);        // fresh install → 0
step = zoom.nextChatFontStep(step, -120);        // wheel in
step = zoom.nextChatFontStep(step, -120);        // wheel in again → +2
prefs.saveChatFontStep(step, store);
check(prefs.readChatFontStep(store) === 2,
  "a wheel-chosen size persists and restores after a simulated restart");

// --- 5. Source pins ---------------------------------------------------------
const shell = readSrc("AppShell.tsx");
check(shell.includes('from "./chatFontWheelZoom"') &&
  shell.includes("isChatZoomTarget") && shell.includes("nextChatFontStep"),
  "AppShell imports and uses the wheel-zoom helpers");
check(/addEventListener\("wheel", onWheel, \{ passive: false \}\)/.test(shell),
  "AppShell registers a non-passive wheel listener (so preventDefault works)");
check(shell.includes("if (!e.ctrlKey) return;") &&
  shell.includes("e.preventDefault();") &&
  shell.includes("setChatFontStep((step) => nextChatFontStep(step, e.deltaY))"),
  "the handler is Ctrl-gated, suppresses browser zoom, and drives the shared step");

const brainstorm = readSrc("pages/agentic/BrainstormPanel.tsx");
check(brainstorm.includes("data-chat-zoom"),
  "the brainstorm modal is tagged as a zoom surface");
check((brainstorm.match(/var\(--chat-font-size, 13px\)/g) || []).length >= 2,
  "both brainstorm text boxes (idea + reply) scale with --chat-font-size");

fs.rmSync(temp, { recursive: true, force: true });
console.log(`OK chat font wheel-zoom: ${passed}/${passed} checks passed`);
