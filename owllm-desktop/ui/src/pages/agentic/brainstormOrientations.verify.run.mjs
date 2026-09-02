#!/usr/bin/env node
// Regression guard for brainstorm ORIENTATIONS — what the idea is FOR, checked
// independently of the mode/track in brainstormModes.ts.
//
// The defect this pins: the co-founder wrapper's vocabulary is commercial, so
// every brief came back written like a pitch — a hobby project got asked for a
// business case, a research question got "unlock" and "game-changing". Ticking
// Business/Product is now the ONLY thing that licenses that language; every
// other combination, including the empty one, gets the plain-prose tone guard.
//
// Covered here: each orientation on its own, combinations, the neutral
// fallback, and the preference surviving navigation and restart.
//
// Run from owllm-desktop/:  node ui/src/pages/agentic/brainstormOrientations.verify.run.mjs
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");                    // owllm-desktop
const ts = (await import(pathToFileURL(path.join(REPO, "node_modules/typescript/lib/typescript.js")).href)).default;
const readLF = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const TMP = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "brainstorm-orient-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

function loadTs(rel) {
  const out = path.join(TMP, path.basename(rel).replace(/\.tsx?$/, ".cjs"));
  fs.writeFileSync(out, ts.transpileModule(readLF(path.join(HERE, rel)), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText);
  return import(pathToFileURL(out).href);
}

let pass = 0;
const fails = [];
const check = (name, cond) => { if (cond) pass++; else fails.push(name); };
const section = (s) => console.log(`\n${s}`);

const o = await loadTs("brainstormOrientations.ts");
const panel = readLF(path.join(HERE, "BrainstormPanel.tsx"));

// Hype vocabulary the tone guard must ban when Business/Product is unchecked.
const HYPE = ["revolutionary", "game-changing", "unlock", "supercharge", "10x"];

// ── 1) The catalogue ─────────────────────────────────────────────────────────
section("1) the four orientations the user can tick");
const ids = o.BRAINSTORM_ORIENTATIONS.map((x) => x.id);
check("business / science / fun / social are all offered",
  ["business", "science", "fun", "social"].every((id) => ids.includes(id)));
check("exactly four, with unique ids", ids.length === 4 && new Set(ids).size === 4);
check("every orientation has an icon, label, hint and directive",
  o.BRAINSTORM_ORIENTATIONS.every((x) => x.icon.trim() && x.label.trim() && x.hint.trim() && x.directive.trim()));
check("isBrainstormOrientationId rejects junk",
  o.isBrainstormOrientationId("fun") && !o.isBrainstormOrientationId("marketing") && !o.isBrainstormOrientationId(7));

// ── 2) Each orientation on its own ───────────────────────────────────────────
section("2) each orientation tunes the prompt on its own");
const only = (id) => o.orientationDirective([id]);
check("business asks for users, value and positioning",
  /BUSINESS \/ PRODUCT/.test(only("business"))
  && /users/i.test(only("business")) && /pay for/i.test(only("business")));
check("science asks for hypothesis, method and falsification",
  /SCIENTIFIC RESEARCH/.test(only("science"))
  && /hypothesis/i.test(only("science")) && /falsif/i.test(only("science")) && /cite/i.test(only("science")));
check("fun explicitly forbids demanding a business case",
  /JUST FOR FUN/.test(only("fun"))
  && /Do not ask for a business case/i.test(only("fun")) && /monetisation plan/i.test(only("fun")));
check("social asks for audience, platform, format, hook and cadence",
  /SOCIAL MEDIA/.test(only("social"))
  && ["audience", "platform", "format", "hook", "cadence"].every((w) => new RegExp(w, "i").test(only("social"))));
check("each single orientation injects its own directive and no other's",
  o.BRAINSTORM_ORIENTATIONS.every((x) =>
    only(x.id).includes(x.directive)
    && o.BRAINSTORM_ORIENTATIONS.filter((y) => y.id !== x.id).every((y) => !only(x.id).includes(y.directive))));

// ── 3) The sales-language rule ───────────────────────────────────────────────
section("3) sales language only when Business/Product is ticked");
check("business is the only orientation that licenses sales language",
  o.allowsSalesLanguage(["business"])
  && !o.allowsSalesLanguage(["science"]) && !o.allowsSalesLanguage(["fun"]) && !o.allowsSalesLanguage(["social"])
  && !o.allowsSalesLanguage([]));
check("business alone carries NO tone guard", !only("business").includes(o.NO_SALES_TONE_DIRECTIVE));
check("every non-business single selection carries the tone guard",
  ["science", "fun", "social"].every((id) => only(id).includes(o.NO_SALES_TONE_DIRECTIVE)));
check("the tone guard names the hype vocabulary it bans",
  HYPE.every((w) => o.NO_SALES_TONE_DIRECTIVE.toLowerCase().includes(w)));
check("the tone guard bans UNREQUESTED commercial sections, not the track's own",
  /Keep whatever sections your track requires/i.test(o.NO_SALES_TONE_DIRECTIVE)
  && /that the track does not\s+already ask for/i.test(o.NO_SALES_TONE_DIRECTIVE));
check("business + anything else still allows sales language (one tick is enough)",
  o.allowsSalesLanguage(["fun", "business"])
  && !o.orientationDirective(["fun", "business"]).includes(o.NO_SALES_TONE_DIRECTIVE));

// ── 4) Combinations ──────────────────────────────────────────────────────────
section("4) combined selections compose instead of overriding");
const pair = o.orientationDirective(["social", "science"]);
check("both directives are present in a two-way selection",
  pair.includes(o.BRAINSTORM_ORIENTATIONS.find((x) => x.id === "science").directive)
  && pair.includes(o.BRAINSTORM_ORIENTATIONS.find((x) => x.id === "social").directive));
check("a combination is told to satisfy every orientation, not pick one",
  pair.includes(o.BLENDED_ORIENTATION_DIRECTIVE) && /name the tension/i.test(o.BLENDED_ORIENTATION_DIRECTIVE));
check("a single selection gets no blend instruction", !only("fun").includes(o.BLENDED_ORIENTATION_DIRECTIVE));
check("all four at once carry all four directives plus the blend line",
  o.BRAINSTORM_ORIENTATIONS.every((x) => o.orientationDirective(ids).includes(x.directive))
  && o.orientationDirective(ids).includes(o.BLENDED_ORIENTATION_DIRECTIVE));
check("selection order does not change the prompt (stable catalogue order)",
  o.orientationDirective(["social", "science"]) === o.orientationDirective(["science", "social"]));
check("duplicates are collapsed",
  o.normalizeOrientations(["fun", "fun", "social"]).join() === "fun,social"
  && o.orientationDirective(["fun", "fun"]) === o.orientationDirective(["fun"]));
check("toggle adds, removes and normalises",
  o.toggleOrientation([], "fun").join() === "fun"
  && o.toggleOrientation(["fun"], "fun").length === 0
  && o.toggleOrientation(["social"], "business").join() === "business,social");

// ── 5) The neutral fallback ──────────────────────────────────────────────────
section("5) nothing ticked is a real instruction, not an empty string");
const neutral = o.orientationDirective([]);
check("the empty selection still produces a directive", neutral.trim().length > 0);
check("it is the balanced fallback and forbids inventing an orientation",
  neutral.includes(o.NEUTRAL_ORIENTATION_DIRECTIVE) && /do not invent one/i.test(neutral));
check("it gives the commercial angle no extra room",
  /commercial angle gets no more space/i.test(neutral));
check("it asks rather than assumes when the purpose would change the answer",
  /ask the user instead of assuming/i.test(neutral));
check("it carries the no-sales tone guard (business is not ticked)",
  neutral.includes(o.NO_SALES_TONE_DIRECTIVE));
check("it names no orientation's own directive",
  o.BRAINSTORM_ORIENTATIONS.every((x) => !neutral.includes(x.directive)));
check("junk, null and non-arrays all fall back to neutral",
  [null, undefined, "business", 7, ["nope", 3]].every((v) => o.orientationDirective(o.normalizeOrientations(v)) === neutral));
check("the summary line reflects the fallback",
  /balanced/i.test(o.orientationSummary([]))
  && /no orientation chosen/i.test(o.orientationSummary([]))
  && /free of sales language/i.test(o.orientationSummary([])));
check("the summary names the ticked labels and whether sales language is allowed",
  /Business \/ Product/.test(o.orientationSummary(["business"]))
  && /commercial framing is allowed/i.test(o.orientationSummary(["business"]))
  && /Just for fun \+ Social media/.test(o.orientationSummary(["social", "fun"]))
  && /no sales language/i.test(o.orientationSummary(["social", "fun"])));

// ── 6) Preference persistence ────────────────────────────────────────────────
section("6) the choice survives navigation and restart");
const store = new Map();
const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
check("no project id → no key written and nothing read",
  o.orientationPrefKey(undefined) === ""
  && (o.writeOrientationPref(storage, undefined, ["fun"]), store.size === 0)
  && o.readOrientationPref(storage, undefined).length === 0);
o.writeOrientationPref(storage, "proj-1", ["social", "fun"]);
check("the preference is stored per project",
  store.has("owllm:brainstorm-orientations:proj-1") && o.orientationPrefKey("proj-1") === "owllm:brainstorm-orientations:proj-1");
check("it reads back identically (restart = a fresh read of the same store)",
  o.readOrientationPref(storage, "proj-1").join() === "fun,social");
check("another project is unaffected", o.readOrientationPref(storage, "proj-2").length === 0);
check("an explicitly emptied selection persists as empty (not as 'never chose')",
  (o.writeOrientationPref(storage, "proj-1", []), store.get("owllm:brainstorm-orientations:proj-1") === "[]")
  && o.readOrientationPref(storage, "proj-1").length === 0);
store.set("owllm:brainstorm-orientations:proj-3", "{not json");
check("a corrupt preference degrades to neutral instead of throwing",
  o.readOrientationPref(storage, "proj-3").length === 0);
store.set("owllm:brainstorm-orientations:proj-4", JSON.stringify(["fun", "marketing", 9]));
check("junk entries are dropped, valid ones kept",
  o.readOrientationPref(storage, "proj-4").join() === "fun");
check("a storage that throws is survivable (private mode / quota)",
  (() => {
    const hostile = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    try {
      o.writeOrientationPref(hostile, "proj-5", ["fun"]);
      return o.readOrientationPref(hostile, "proj-5").length === 0;
    } catch { return false; }
  })());

// ── 7) Panel wiring ──────────────────────────────────────────────────────────
section("7) the panel actually renders and uses it");
check("the checkbox group is rendered", panel.includes('data-ui="BrainstormOrientationPicker"')
  && panel.includes('data-ui={`BrainstormOrientation-${o.id}`}'));
check("it uses real checkboxes, so several can be ticked at once",
  /type="checkbox"[\s\S]{0,240}onChange=\{\(\) => toggleBrainstormOrientation\(o\.id\)\}/.test(panel));
check("the summary line is shown", panel.includes('data-ui="BrainstormOrientationSummary"')
  && panel.includes("orientationSummary(activeOrientations)"));
check("the directive reaches the co-founder system prompt",
  /orientationDirective\(activeOrientations\)/.test(panel));
check("...and the opening turn", (panel.match(/orientationDirective\(activeOrientations\)/g) ?? []).length >= 2);
check("the selection is checkpointed (v4) and normalised on load",
  panel.includes("orientations: normalizeOrientations(value.orientations)")
  && /v: 4,\n\s+modeId,\n\s+orientations,/.test(panel));
check("older checkpoints (v1-v3) still load and get the neutral fallback",
  /!\[1, 2, 3, 4\]\.includes\(value\.v as number\)/.test(panel));
check("the checkpoint effect re-runs when the orientation changes",
  /\[open, hydrated, targetKey, modeId, orientations, idea/.test(panel));
check("a project with no checkpoint starts from the saved preference",
  panel.includes("readOrientationPref(localStorage, projectId)")
  && panel.includes("setOrientations(st ? st.orientations : savedOrientations)"));
check("every tick writes the preference through",
  panel.includes("writeOrientationPref(localStorage, projectId, next)"));
check("🆕 Start fresh keeps the orientation (it is a preference, not a transcript)",
  /orientations: activeOrientations,\n\s+idea: "",/.test(panel));
check("the orientation is editable mid-conversation but frozen while a turn streams",
  /const toggleBrainstormOrientation = \(id: BrainstormOrientationId\) => \{\n\s+if \(running\) return;/.test(panel)
  && !panel.includes("disabled={modeLocked}\n                      onChange"));

// ── 8) The real panel, mounted ───────────────────────────────────────────────
// Source greps prove the wiring exists; this proves it WORKS: the boxes render,
// several tick at once, the preference is written, and a remount (= leaving the
// page and coming back, or restarting the app) brings the ticks back.
section("8) the real BrainstormPanel in jsdom");
await mountedPanelChecks();

async function mountedPanelChecks() {
  const req = createRequire(path.join(REPO, "package.json"));
  let JSDOM;
  try { ({ JSDOM } = req("jsdom")); } catch {
    fails.push("jsdom is required for the mounted-panel section (npm i --no-save jsdom)");
    return;
  }
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.Event = dom.window.Event;
  globalThis.getComputedStyle = dom.window.getComputedStyle;
  globalThis.localStorage = dom.window.localStorage;

  const SANDBOX = path.join(TMP, "panel");
  fs.mkdirSync(path.join(SANDBOX, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(SANDBOX, "package.json"), "{}");
  for (const m of ["react", "react-dom", "scheduler"]) {
    fs.cpSync(path.join(REPO, "node_modules", m), path.join(SANDBOX, "node_modules", m), { recursive: true });
  }
  const toCjs = (file) => ts.transpileModule(readLF(path.join(HERE, file)), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    },
  }).outputText;
  // The two catalogue modules are the REAL ones — the point of the mount is that
  // the panel and brainstormOrientations.ts agree in a browser, not in a grep.
  fs.writeFileSync(path.join(SANDBOX, "brainstormOrientations.js"), toCjs("brainstormOrientations.ts"));
  fs.writeFileSync(path.join(SANDBOX, "brainstormModes.js"), toCjs("brainstormModes.ts"));
  fs.writeFileSync(path.join(SANDBOX, "stubs.js"), `
    const React = require("react");
    module.exports = {
      __esModule: true,
      default: () => React.createElement("div", null, "(model picker)"),
      useStickyScroll: () => ({ current: null }),
      // No project folder in this harness, so the panel never reaches a disk
      // read/write; anything that does ask is answered "not there".
      invoke: async () => { throw new Error("no tauri in jsdom"); },
      streamChatCompletion: async () => {},
      providerFor: () => "local",
      seedNotebookFromBrief: () => 0,
      briefImplementationSteps: () => [],
    };
  `);
  let panelJs = toCjs("BrainstormPanel.tsx")
    .replace(/require\("\.\/brainstormOrientations"\)/g, 'require("./brainstormOrientations.js")')
    .replace(/require\("\.\/brainstormModes"\)/g, 'require("./brainstormModes.js")')
    .replace(/require\("[^"]*(?:useStickyScroll|ModelPicker|RunNotebook|dispatch|@tauri-apps\/api\/core)"\)/g, 'require("./stubs.js")');
  fs.writeFileSync(path.join(SANDBOX, "BrainstormPanel.js"), panelJs);

  const reqBox = createRequire(path.join(SANDBOX, "BrainstormPanel.js"));
  const React = reqBox("react");
  const { act } = reqBox("react");
  const { createRoot } = reqBox("react-dom/client");
  const Panel = reqBox("./BrainstormPanel.js").default;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const PID = "verify-orientations";
  const PREF_KEY = `owllm:brainstorm-orientations:${PID}`;
  const props = {
    open: true, onClose: () => {}, projectCwd: "", projectId: PID,
    brainstormerRole: { systemPrompt: "role", toolAllowlist: [] },
    modelId: "local-test", port: 0, models: [], accountsStatus: null,
  };
  const mount = async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(React.createElement(Panel, props)); });
    return { root, host };
  };
  const boxes = () => o.BRAINSTORM_ORIENTATIONS.map((x) =>
    document.querySelector(`[data-ui="BrainstormOrientation-${x.id}"] input[type=checkbox]`));
  const summary = () => document.querySelector('[data-ui="BrainstormOrientationSummary"]')?.textContent ?? "";
  const tick = async (el) => {
    await act(async () => { el.click(); });
  };

  let { root } = await mount();
  check("all four checkboxes render", boxes().every(Boolean) && boxes().length === 4);
  if (!boxes().every(Boolean)) {
    // Without the group there is nothing to click; report that plainly instead
    // of crashing on a null element, so the gate output names the real defect.
    fails.push("mounted panel: the orientation group is absent — the rest of section 8 could not run");
    await act(async () => { root.unmount(); });
    return;
  }
  check("none is ticked on a project with no saved preference", boxes().every((b) => !b.checked));
  check("the neutral summary is shown before anything is ticked", /balanced/i.test(summary()));

  const byId = (id) => document.querySelector(`[data-ui="BrainstormOrientation-${id}"] input[type=checkbox]`);
  await tick(byId("business"));
  await tick(byId("social"));
  check("two orientations stay ticked together (it is a checkbox group, not a radio)",
    byId("business").checked && byId("social").checked && !byId("fun").checked && !byId("science").checked);
  check("the summary names both and allows commercial framing",
    /Business \/ Product \+ Social media/.test(summary()) && /commercial framing is allowed/i.test(summary()));
  check("the preference was written to storage",
    JSON.parse(localStorage.getItem(PREF_KEY) ?? "[]").join() === "business,social");

  // Leaving the page and coming back: a brand-new tree, nothing carried in JS.
  await act(async () => { root.unmount(); });
  ({ root } = await mount());
  check("both ticks come back after a remount (navigation / restart)",
    byId("business").checked && byId("social").checked);
  check("the summary comes back with them", /commercial framing is allowed/i.test(summary()));

  await tick(byId("business"));
  check("unticking Business/Product flips the tone promise back to plain prose",
    !byId("business").checked && byId("social").checked && /no sales language/i.test(summary()));
  check("...and the emptier preference is persisted",
    JSON.parse(localStorage.getItem(PREF_KEY) ?? "[]").join() === "social");
  await tick(byId("social"));
  check("unticking everything persists as an explicit empty set and shows the fallback",
    localStorage.getItem(PREF_KEY) === "[]" && /balanced/i.test(summary()));
  await act(async () => { root.unmount(); });
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log("PASS brainstorm orientations: each lens, combinations, neutral fallback, preference persistence");
