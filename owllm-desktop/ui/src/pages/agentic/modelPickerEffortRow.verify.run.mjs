// One-shot verify for the COMPACT model rows: a model that exposes reasoning
// -effort tiers must occupy ONE line carrying an inline tier strip, instead of
// one full-width row per tier (7 Claude models x 4 tiers x 2 accounts had
// turned the popover into a wall of near-identical lines).
//
// Mounts the REAL ModelPicker.tsx in jsdom via react-dom, and also exercises
// the exported groupRows() directly so the grouping contract is pinned without
// a DOM.
//
// Run from owllm-desktop/:  node ui/src/pages/agentic/modelPickerEffortRow.verify.run.mjs
// Needs jsdom present in node_modules (npm i --no-save jsdom). Exits non-zero
// on any assertion failure.
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const req = createRequire(path.join(REPO, "package.json"));
const ts = (await import(pathToFileURL(path.join(REPO, "node_modules/typescript/lib/typescript.js")).href)).default;
// jsdom is an optional test-only dep. Skip cleanly when absent — a ship gate
// must never be a landmine on a box without this local install.
let JSDOM;
try {
  ({ JSDOM } = req("jsdom"));
} catch {
  console.log("SKIP modelPickerEffortRow: jsdom not installed (run `npm i --no-save jsdom` to exercise this harness).");
  process.exit(0);
}

// ---- DOM environment ----
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle;

// ---- transpile the real ModelPicker.tsx, stub its data modules ----
const src = fs.readFileSync(path.join(HERE, "ModelPicker.tsx"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
}).outputText;
const TMP = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "mpe-verify-"));
fs.writeFileSync(path.join(TMP, "ModelPicker.js"), js);
// Fixture mirrors the real catalogue shape: a tiered flagship, a tiered model
// with a SINGLE tier, and an untiered one.
fs.writeFileSync(path.join(TMP, "cloudCatalogue.js"), `
  const CAT = {
    anthropic: [
      { id: "claude-opus-5", display: "Claude Opus 5", effort: ["low", "medium", "high", "extra_high"] },
      { id: "claude-solo-1", display: "Claude Solo 1", effort: ["high"] },
      { id: "claude-haiku-4-5", display: "Claude Haiku 4.5" },
      // Declared out of order on purpose: the strip must read cheapest ->
      // deepest regardless of how a catalogue override lists the tiers.
      { id: "claude-scramble-1", display: "Claude Scramble 1", effort: ["extra_high", "low", "high", "medium"] },
    ],
    openai: [{ id: "gpt-5.6-sol", display: "GPT-5.6 Sol", api: true, effort: ["low", "medium", "high", "extra_high"] }],
    kimi: [], gemini: [], deepseek: [], xai: [], groq: [],
    perplexity: [], mistral: [], together: [],
  };
  module.exports = { getCloudCatalogue: () => CAT, subscribeCloudCatalogue: () => () => {} };
`);
fs.writeFileSync(path.join(TMP, "peerCatalogue.js"), `
  module.exports = {
    DEVICE_PREFIX: "device/",
    encodeDeviceModel: (d, m) => "device/" + d + "/" + m,
    getPeerCatalogue: () => [],
    refreshPeerCatalogue: async () => {},
    subscribePeerCatalogue: () => () => {},
  };
`);
fs.writeFileSync(path.join(TMP, "package.json"), "{}");
fs.mkdirSync(path.join(TMP, "node_modules"), { recursive: true });
for (const m of ["react", "react-dom", "scheduler"]) {
  fs.cpSync(path.join(REPO, "node_modules", m), path.join(TMP, "node_modules", m), { recursive: true });
}

const reqTmp = createRequire(path.join(TMP, "ModelPicker.js"));
const React = reqTmp("react");
const { createRoot } = reqTmp("react-dom/client");
const { act } = reqTmp("react");
const mod = reqTmp("./ModelPicker.js");
const ModelPicker = mod.default;
const { buildEntries, groupRows } = mod;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Both accounts connected so every row is selectable.
const STATUS = { claude_cli: true, anthropic_api_key: true, openai_api_key: true };
const MODELS = [];

function textOf(el) { return el.textContent || ""; }
function buttons() { return [...document.querySelectorAll("button")]; }
function clickEl(el) {
  act(() => {
    el.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
}
let failures = 0;
function check(name, cond) {
  if (cond) console.log("  ok  " + name);
  else { console.error("  FAIL " + name); failures++; }
}
function mount(props) {
  const container = document.getElementById("root");
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(ModelPicker, {
      value: "", onChange: () => {}, models: MODELS, status: STATUS, ...props,
    }));
  });
  return root;
}
/// Open the popover and expand a section header by label.
function openSection(label) {
  clickEl(buttons()[0]);
  const hdr = buttons().find(b => textOf(b).includes(label));
  clickEl(hdr);
  return hdr;
}
/// Locate a rendered row by its visible title. Returns null rather than
/// throwing, so a build WITHOUT collapsed rows reports every failed check
/// instead of crashing the harness on the first missing row.
function rowByTitle(title) {
  return [...document.querySelectorAll(".ow-model-picker__option")]
    .find(el => textOf(el).includes(title)) || null;
}
function tiersOf(row) {
  return row ? [...row.querySelectorAll(".ow-model-picker__effort")] : [];
}

// ---- 0. groupRows contract, no DOM ----
console.log("case 0: groupRows collapses tiers, keeps everything else");
// Presence is its own check: without it the rest of case 0 would throw and the
// DOM cases below — the ones that actually prove the layout — would never run.
check("ModelPicker exports groupRows()", typeof groupRows === "function");
if (typeof groupRows === "function") {
  const entries = buildEntries(MODELS, STATUS);
  const anthropic = entries.filter(e => e.section === "anthropic");
  const rows = groupRows(anthropic);
  // 4 models x 2 accounts = 8 rows, from (4+1+1+4) x 2 = 20 tier entries.
  check("tier entries still all exist (dispatch ids unchanged)", anthropic.length === 20);
  check("rows collapse to one per model+account", rows.length === 8);
  check("every id keeps its ':<tier>' encoding",
    anthropic.filter(e => e.effort).every(e => e.id === `${e.baseId}:${e.effort}`));
  const opusSub = rows.find(r => r.key === "sub/claude-opus-5");
  check("the flagship row carries all four tiers", !!opusSub && opusSub.entries.length === 4);
  check("tiers are ordered cheapest -> deepest",
    opusSub.entries.map(e => e.effort).join(",") === "low,medium,high,extra_high");
  check("a scrambled catalogue order is normalised, not passed through",
    rows.find(r => r.key === "sub/claude-scramble-1")?.entries.map(e => e.effort).join(",")
      === "low,medium,high,extra_high");
  check("a single-tier model is still a tiered row (its tier stays visible)",
    groupRows(anthropic).find(r => r.key === "sub/claude-solo-1")?.tiered === true);
  check("an untiered model is a plain row",
    groupRows(anthropic).find(r => r.key === "sub/claude-haiku-4-5")?.tiered === false);
  check("plain rows keep their full label",
    groupRows(anthropic).find(r => r.key === "sub/claude-haiku-4-5")?.label === "Claude Haiku 4.5 (subscription)");
  check("tiered row title drops the tier but KEEPS the account tag",
    opusSub.label === "Claude Opus 5 (subscription)");
}

// ---- 1. the popover renders ONE line per model, not one per tier ----
console.log("case 1: one line per model");
{
  const root = mount({});
  openSection("ANTHROPIC");
  const body = textOf(document.body);
  check("no full-width per-tier row is rendered",
    !body.includes("Claude Opus 5 · medium") && !body.includes("Claude Opus 5 · extra high"));
  check("the model line is present once per account",
    (body.match(/Claude Opus 5 \(subscription\)/g) || []).length === 1
    && (body.match(/Claude Opus 5 \(API\)/g) || []).length === 1);
  const strip = [...document.querySelectorAll(".ow-model-picker__effort")];
  check("tier segments are rendered as their own controls", strip.length > 0);
  const opusRow = rowByTitle("Claude Opus 5 (subscription)");
  check("the flagship row shows Low/Med/High/Max on ONE line",
    ["Low", "Med", "High", "Max"].every(t => tiersOf(opusRow).some(b => textOf(b) === t)));
  check("the untiered model has NO tier strip",
    [...document.querySelectorAll(".ow-model-picker__option")]
      .filter(el => textOf(el).includes("Claude Haiku 4.5 (subscription)"))
      .every(el => el.querySelectorAll(".ow-model-picker__effort").length === 0));
  act(() => root.unmount());
}

// ---- 2. the section count reports ROWS, not tier entries ----
console.log("case 2: header count matches what is shown");
{
  const root = mount({});
  clickEl(buttons()[0]);
  const hdr = buttons().find(b => textOf(b).includes("ANTHROPIC"));
  check("ANTHROPIC header counts the 8 visible rows, not the 20 tier entries",
    textOf(hdr).includes("8") && !textOf(hdr).includes("20"));
  act(() => root.unmount());
}

// ---- 3. clicking a tier segment selects that exact id ----
console.log("case 3: a tier segment is the selection control");
{
  let picked = null;
  const container = document.getElementById("root");
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(ModelPicker, {
      value: "", onChange: (id) => { picked = id; }, models: MODELS, status: STATUS,
    }));
  });
  openSection("ANTHROPIC");
  const high = tiersOf(rowByTitle("Claude Opus 5 (subscription)")).find(b => textOf(b) === "High");
  if (high) clickEl(high);
  check("onChange got the tier-encoded id", picked === "sub/claude-opus-5:high");
  check("popover closed after picking a tier", !textOf(document.body).includes("ANTHROPIC"));
  act(() => root.unmount());
}

// ---- 4. no tier is chosen on the user's behalf ----
console.log("case 4: the row itself never auto-picks a tier");
{
  let calls = 0;
  const container = document.getElementById("root");
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(ModelPicker, {
      value: "", onChange: () => { calls++; }, models: MODELS, status: STATUS,
    }));
  });
  openSection("ANTHROPIC");
  const opusRow = rowByTitle("Claude Opus 5 (subscription)");
  const nameCell = opusRow
    ? [...opusRow.querySelectorAll("span")].find(s => textOf(s) === "Claude Opus 5 (subscription)")
    : null;
  check("the collapsed row exposes the model name as a non-control", !!nameCell);
  if (nameCell) clickEl(nameCell);
  check("clicking the model NAME does not select a tier", calls === 0);
  check("the row stays open so the user can still choose", textOf(document.body).includes("ANTHROPIC"));
  act(() => root.unmount());
}

// ---- 5. the active tier is marked, and the trigger still names it ----
console.log("case 5: current selection is visible");
{
  const root = mount({ value: "sub/claude-opus-5:extra_high" });
  const trigger = buttons()[0];
  check("trigger still spells out the selected tier",
    textOf(trigger).includes("Claude Opus 5") && textOf(trigger).includes("extra high"));
  clickEl(trigger);
  check("the selection's section pre-expanded", textOf(document.body).includes("Claude Opus 5 (subscription)"));
  const selected = [...document.querySelectorAll('.ow-model-picker__effort[data-state="selected"]')];
  check("exactly one tier segment is marked selected", selected.length === 1);
  check("it is the Max segment", selected.length === 1 && textOf(selected[0]) === "Max");
  const opusRow = [...document.querySelectorAll('.ow-model-picker__option[data-state="selected"]')]
    .find(el => textOf(el).includes("Claude Opus 5 (subscription)"));
  check("its row is marked selected too", !!opusRow);
  act(() => root.unmount());
}

// ---- 6. an unavailable account dims the row AND disables its tiers ----
console.log("case 6: unavailable accounts cannot be selected through a tier");
{
  let picked = null;
  const container = document.getElementById("root");
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(ModelPicker, {
      value: "", onChange: (id) => { picked = id; }, models: MODELS,
      status: { claude_cli: false, anthropic_api_key: false, openai_api_key: false },
    }));
  });
  openSection("ANTHROPIC");
  const opusRow = rowByTitle("Claude Opus 5 (subscription)");
  const segs = tiersOf(opusRow);
  check("every tier of a disconnected account is disabled", segs.length === 4 && segs.every(b => b.disabled));
  check("the row still explains why", !!opusRow && textOf(opusRow).includes("claude /login"));
  if (segs[0]) clickEl(segs[0]);
  check("clicking a disabled tier selects nothing", picked === null);
  act(() => root.unmount());
}

fs.rmSync(TMP, { recursive: true, force: true });
if (failures > 0) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log("\nall assertions passed");
