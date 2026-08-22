#!/usr/bin/env node
// Regression guard for the 🍄 psychedelic-effect preference on the agentic page.
//
// WHAT IT PINS
//  1. DEFAULT ON — an app that has never seen the setting renders the full
//     treatment. A "reduced" default would silently change the page for every
//     existing user.
//  2. TOGGLE — one activation flips full ⇄ reduced and nothing else.
//  3. PERSISTENCE — the choice lives in the SYNCED pageSettings document, so it
//     survives navigation AND a restart. Modelled honestly: a second, freshly
//     loaded copy of the module tree reads the same storage and sees the
//     choice. (Component-local state would pass a toggle test and fail this.)
//  4. ACCESSIBILITY — a real <button type="button"> (so Enter/Space work with
//     no key handling of our own), aria-pressed reflecting the mode, an
//     aria-label that says what activating it DOES, and a :focus-visible ring
//     that inline styles cannot express.
//  5. BOTH VISUAL MODES — full keeps the breathing halo; reduced keeps the
//     rainbow FRAME with the Coding-page chatbox's constant halo. Both keep the
//     ring, and both go still under prefers-reduced-motion.
//  6. PLACEMENT — the button sits immediately left of the model-selection tab,
//     and BOTH agentic card kinds (chat tile + graph node) read the preference,
//     so the graph can't stay loud after the toggle.
//
// Run from owllm-desktop/:  node ui/src/pages/agentic/psychedelicMode.verify.run.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../..");                      // ui/src
const REPO = path.resolve(HERE, "../../../..");               // owllm-desktop
const ts = (await import(pathToFileURL(path.join(REPO, "node_modules/typescript/lib/typescript.js")).href)).default;
const readLF = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const TMP = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "psychedelic-mode-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

let pass = 0;
const fails = [];
const check = (name, cond) => { if (cond) pass++; else fails.push(name); };
const section = (s) => console.log(`\n${s}`);

// ---- A loadable copy of the real module tree -------------------------------
// psychedelicMode + pageSettings + renderingPolicy + listenerBus are the REAL
// files (that is the point — persistence must be exercised through the layer
// that actually stores it). Only `react` and stateMirror (used solely by the
// legacy-key migration, which is not under test here) are stubbed.
const TS_FILES = [
  "pages/agentic/psychedelicMode.ts",
  "state/pageSettings.ts",
  "runtime/renderingPolicy.ts",
  "runtime/listenerBus.ts",
];

function materialize(root) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "commonjs" }));
  for (const rel of TS_FILES) {
    const out = path.join(root, rel.replace(/\.tsx?$/, ".js"));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, ts.transpileModule(readLF(path.join(SRC, rel)), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    }).outputText);
  }
  // stateMirror: only the migration path touches it, and that path is covered
  // by pageSettings' own callers, not by this suite.
  fs.mkdirSync(path.join(root, "runtime"), { recursive: true });
  fs.writeFileSync(path.join(root, "runtime/stateMirror.js"),
    "exports.hotBlobKeys = () => [];\nexports.readHotBlob = () => null;\n");
  // Minimal React hook harness — enough to drive useSetting's useState/useEffect.
  const reactDir = path.join(root, "node_modules/react");
  fs.mkdirSync(reactDir, { recursive: true });
  fs.writeFileSync(path.join(reactDir, "package.json"), JSON.stringify({ name: "react", main: "index.js" }));
  fs.writeFileSync(path.join(reactDir, "index.js"), `
    const slots = [];
    let cursor = 0;
    let queued = [];
    exports.__render = (fn) => { cursor = 0; queued = []; const out = fn(); for (const e of queued) e(); return out; };
    exports.useState = (init) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof init === "function" ? init() : init;
      return [slots[i], (v) => { slots[i] = typeof v === "function" ? v(slots[i]) : v; }];
    };
    exports.useEffect = (fn) => { queued.push(fn); };
  `);
  return root;
}

// ---- Browser globals the real modules expect --------------------------------
const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
globalThis.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  localStorage: globalThis.localStorage,
  // No matchMedia by default ⇒ motion allowed (continuousUiAnimation's guard).
};

const bootA = await import(pathToFileURL(path.join(materialize(path.join(TMP, "a")), "pages/agentic/psychedelicMode.js")).href);
const reactA = await import(pathToFileURL(path.join(TMP, "a/node_modules/react/index.js")).href);

// ── 1) Default ON ────────────────────────────────────────────────────────────
section("1) default is the FULL psychedelic treatment");
check("nothing stored ⇒ full", bootA.getPsychedelicMode() === "full");
check("the exported default says so too", bootA.PSYCHEDELIC_DEFAULT === "full");
check("a corrupt stored value falls back to full instead of throwing", (() => {
  localStorage.setItem("owllm:settings:v1", JSON.stringify({ v: 1, scopes: { global: { agenticPsychedelic: "disco" } }, mig: {} }));
  const ok = bootA.getPsychedelicMode() === "full";
  store.clear();
  return ok;
})());
check("isPsychedelicMode rejects junk",
  bootA.isPsychedelicMode("reduced") && !bootA.isPsychedelicMode("disco") && !bootA.isPsychedelicMode(1));
check("nextPsychedelicMode is a plain flip",
  bootA.nextPsychedelicMode("full") === "reduced" && bootA.nextPsychedelicMode("reduced") === "full");

// ── 2) Toggle ────────────────────────────────────────────────────────────────
section("2) the toggle flips the mode through the hook");
let hook = reactA.__render(() => bootA.usePsychedelicMode());
check("hook starts on full", hook[0] === "full");
hook[1]();                                   // activate the 🍄 button
check("one activation ⇒ reduced", bootA.getPsychedelicMode() === "reduced");
hook = reactA.__render(() => bootA.usePsychedelicMode());
check("the hook re-reads the new value", hook[0] === "reduced");
hook[1]();
check("activating again ⇒ back to full", bootA.getPsychedelicMode() === "full");

// ── 3) Persistence across navigation AND restart ─────────────────────────────
section("3) the choice survives navigation and restart");
bootA.setPsychedelicMode("reduced");
check("it is written to the SYNCED settings document (not a bespoke key)",
  JSON.parse(localStorage.getItem("owllm:settings:v1")).scopes.global.agenticPsychedelic === "reduced");
check("only the `owllm:settings:v1` document is touched",
  [...store.keys()].join() === "owllm:settings:v1");
// A second, independently loaded copy of the module tree = a fresh process
// reading the same storage. Component state would NOT survive this.
const bootB = await import(pathToFileURL(path.join(materialize(path.join(TMP, "b")), "pages/agentic/psychedelicMode.js")).href);
check("a freshly loaded app still reads 'reduced' (restart)", bootB.getPsychedelicMode() === "reduced");
bootB.setPsychedelicMode("full");
check("...and writing from the fresh copy round-trips", bootA.getPsychedelicMode() === "full");

// ── 4) Both visual modes ─────────────────────────────────────────────────────
section("4) full and reduced are both real, distinct treatments");
const args = { fill: "linear-gradient(180deg, #111 0%, #222 100%)", alphaA: 0.9, alphaB: 0.6, outerPx: 20 };
const full = bootA.psychedelicActiveStyle({ mode: "full", ...args });
const reduced = bootA.psychedelicActiveStyle({ mode: "reduced", ...args });
check("both paint the rainbow ring on the border-box",
  full.background.includes(bootA.PSYCHEDELIC_RING) && reduced.background.includes(bootA.PSYCHEDELIC_RING));
check("both clip the card fill to padding-box (the frame is the effect)",
  full.background.includes(`${args.fill} padding-box`) && reduced.background.includes(`${args.fill} padding-box`));
check("both keep the 2px transparent border the ring needs",
  full.border === "2px solid transparent" && reduced.border === "2px solid transparent");
check("full breathes with the dispatch pulse", full.boxShadow.includes(`${12 + args.outerPx}px`));
check("reduced does NOT breathe (pulse numbers ignored)",
  !reduced.boxShadow.includes(String(12 + args.outerPx)) && !reduced.boxShadow.includes(String(args.alphaB)));
check("reduced uses the Coding-page chatbox halo verbatim",
  reduced.boxShadow.startsWith(bootA.REDUCED_AURA_HALO));
check("...and that halo really is CodePage's PSYCHEDELIC_AURA_HALO",
  readLF(path.join(SRC, "pages/agentic/CodePage.tsx"))
    .includes(`const PSYCHEDELIC_AURA_HALO = "${bootA.REDUCED_AURA_HALO}"`));
check("the two modes are visibly different", full.boxShadow !== reduced.boxShadow);
// The card fills are TRANSLUCENT, so a padding-box fill alone does not stop the
// border-box conic from showing through the whole body — that bleed IS the full
// treatment, and it made "reduced" look identical to "full" (user report:
// "they are both fully psychedelic"). Reduced must back the fill with an opaque
// layer so the rainbow survives on the frame only.
check("the card fills really are translucent (why the opaque base is needed)",
  /const tileFill = `linear-gradient\(180deg, rgba\(/.test(readLF(path.join(SRC, "pages/agentic/AgentsPage.tsx"))));
check("reduced puts an OPAQUE base between the fill and the ring",
  reduced.background === `${args.fill} padding-box, ${bootA.REDUCED_AURA_BASE}, ${bootA.PSYCHEDELIC_RING}`);
// String(): on a tree without the fix the export is undefined — report that as
// a failed check, not a TypeError that kills the run before the summary.
check("...and that base is padding-box clipped, so it cannot cover the frame",
  String(bootA.REDUCED_AURA_BASE).endsWith(" padding-box"));
check("...and it is a gradient, not a bare colour (invalid in a layer list)",
  String(bootA.REDUCED_AURA_BASE).startsWith("linear-gradient("));
check("full keeps the body bleed (unchanged default treatment)",
  full.background === `${args.fill} padding-box, ${bootA.PSYCHEDELIC_RING}`
  && !full.background.includes(bootA.REDUCED_AURA_BASE));
check("extra shadows (drop shadow) survive in both modes", (() => {
  const a = bootA.psychedelicActiveStyle({ mode: "full", ...args, extraShadow: "0 6px 22px rgba(0,0,0,0.6)" });
  const b = bootA.psychedelicActiveStyle({ mode: "reduced", ...args, extraShadow: "0 6px 22px rgba(0,0,0,0.6)" });
  return a.boxShadow.endsWith("0 6px 22px rgba(0,0,0,0.6)") && b.boxShadow.endsWith("0 6px 22px rgba(0,0,0,0.6)");
})());
check("both spin by default", full.animation === bootA.PSYCHEDELIC_SPIN && reduced.animation === bootA.PSYCHEDELIC_SPIN);

section("5) prefers-reduced-motion still wins over the preference");
globalThis.window.matchMedia = (q) => ({ matches: /prefers-reduced-motion/.test(q) });
const stillFull = bootA.psychedelicActiveStyle({ mode: "full", ...args });
const stillReduced = bootA.psychedelicActiveStyle({ mode: "reduced", ...args });
check("no animation in either mode when the OS asks for less motion",
  stillFull.animation === undefined && stillReduced.animation === undefined);
check("the rainbow frame is still drawn (static, not deleted)",
  stillFull.background.includes(bootA.PSYCHEDELIC_RING) && stillReduced.background.includes(bootA.PSYCHEDELIC_RING));
delete globalThis.window.matchMedia;

// ── 6) The button: accessibility + placement ─────────────────────────────────
section("6) the 🍄 button — accessible, keyboard-operable, correctly placed");
const page = readLF(path.join(SRC, "pages/agentic/AgentsPage.tsx"));
const css = readLF(path.join(SRC, "styles.css"));
const toggleSrc = page.slice(page.indexOf("function PsychedelicModeToggle"), page.indexOf("function AgentChatTile"));
check("it is a native button (Enter/Space come for free)", /type="button"/.test(toggleSrc));
check("it carries the mushroom glyph", toggleSrc.includes("🍄"));
check("aria-pressed reflects the mode", /aria-pressed=\{on\}/.test(toggleSrc));
check("aria-label + title come from the shared label helper",
  /aria-label=\{label\}/.test(toggleSrc) && /title=\{label\}/.test(toggleSrc)
  && toggleSrc.includes("psychedelicToggleLabel(mode)"));
check("the label says what activating it will DO, in both states",
  /reduce them/.test(bootA.psychedelicToggleLabel("full"))
  && /restore the full effect/.test(bootA.psychedelicToggleLabel("reduced")));
check("the glyph is hidden from screen readers (the label carries the meaning)",
  /aria-hidden="true"/.test(toggleSrc));
check("keyboard activation is NOT swallowed — only stopped from the tile",
  /onKeyDown=\{\(e\) => e\.stopPropagation\(\)\}/.test(toggleSrc)
  && !/preventDefault/.test(toggleSrc));
check("a click never also selects the agent behind it", /onClick=\{\(e\) => \{ e\.stopPropagation\(\); onToggle\(\); \}\}/.test(toggleSrc));
check("focus is visible (inline styles cannot do :focus-visible)",
  /\[data-ui="PsychedelicModeToggle"\]:focus-visible \{[^}]*outline: 2px solid/.test(css));
check("the glyph keeps full-contrast ink in BOTH states (no faded label)",
  /color: "var\(--fg-strong\)"/.test(toggleSrc) && !/opacity:/.test(toggleSrc));
check("it is rendered immediately left of the model-selection tab",
  /<PsychedelicModeToggle[^>]*\/>\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)*<div\s+data-ui="AgentSelectedModel"/.test(page));

section("7) both agentic card kinds follow the one preference");
check("the chat tile reads the preference", page.includes("const [psychedelicMode, togglePsychedelic] = usePsychedelicMode()"));
check("the graph card reads the same preference", page.includes("const [graphPsychedelicMode] = usePsychedelicMode()"));
check("the chat tile's active style comes from the shared helper",
  page.includes("const activeAura = psychedelicActiveStyle({")
  && page.includes("background: isActive ? activeAura.background : tileFill"));
check("the graph card's active style comes from the shared helper",
  page.includes("const activeNodeAura = psychedelicActiveStyle({")
  && page.includes("background: isActive ? activeNodeAura.background : baseBg"));
check("no card hard-codes the old always-full halo any more",
  !/0 0 \$\{12 \+ outerPx\}px rgba\(176,124,255/.test(page)
  && !/0 0 \$\{12 \+ activeOuterPx\}px rgba\(176,124,255/.test(page));
check("no card hard-codes its own conic-gradient aura any more",
  !/conic-gradient\(from var\(--owllm-aura-angle\)/.test(page));
check("the spin keyframes are still declared on the page",
  page.includes("@keyframes owllm-aura-spin"));

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log("PASS psychedelic mode: default-on, toggle, persistence, a11y, both visual modes");
