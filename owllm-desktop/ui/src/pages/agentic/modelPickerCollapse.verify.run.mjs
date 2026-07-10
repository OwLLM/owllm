// One-shot verify for the ModelPicker collapsed-sections behaviour
// (sections show only the lab name + count until clicked; the section
// holding the current selection opens itself; a sole section is always
// open). Mounts the REAL ModelPicker.tsx in jsdom via react-dom.
//
// Run from owllm-desktop/:  node ui/src/pages/agentic/modelPickerCollapse.verify.run.mjs
// Needs jsdom present in node_modules (npm i --no-save jsdom). Exits
// non-zero on any assertion failure.
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const req = createRequire(path.join(REPO, "package.json"));
const ts = (await import(pathToFileURL(path.join(REPO, "node_modules/typescript/lib/typescript.js")).href)).default;
const { JSDOM } = req("jsdom");

// ---- DOM environment (react-dom needs window/document globals) ----
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle;

// ---- transpile the real ModelPicker.tsx to CJS, stub cloudCatalogue ----
const src = fs.readFileSync(path.join(HERE, "ModelPicker.tsx"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
}).outputText;
const TMP = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "mp-verify-"));
fs.writeFileSync(path.join(TMP, "ModelPicker.js"), js);
fs.writeFileSync(path.join(TMP, "cloudCatalogue.js"), `
  const CAT = {
    anthropic: [{ id: "claude-opus-4-7", display: "Claude Opus 4.7" }],
    openai:    [{ id: "gpt-5.2", display: "GPT-5.2", api: true }],
    kimi: [], gemini: [], deepseek: [], xai: [], groq: [],
    perplexity: [], mistral: [], together: [],
  };
  module.exports = { getCloudCatalogue: () => CAT, subscribeCloudCatalogue: () => () => {} };
`);
// Route the transpiled module's react/react-dom requires to the repo copy.
fs.writeFileSync(path.join(TMP, "package.json"), "{}");
fs.mkdirSync(path.join(TMP, "node_modules"), { recursive: true });
for (const m of ["react", "react-dom", "scheduler"]) {
  fs.cpSync(path.join(REPO, "node_modules", m), path.join(TMP, "node_modules", m), { recursive: true });
}

const reqTmp = createRequire(path.join(TMP, "ModelPicker.js"));
const React = reqTmp("react");
const { createRoot } = reqTmp("react-dom/client");
const { act } = reqTmp("react");
const ModelPicker = reqTmp("./ModelPicker.js").default;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ---- helpers ----
const LOCAL_MODELS = [
  { model_id: "llama-8b.gguf",  port: 11101, base_model: null, size_mib: 4800, provider: "local" },
  { model_id: "qwen-14b.gguf",  port: 11102, base_model: null, size_mib: 9100, provider: "local" },
];
const STATUS = null; // no keys / CLIs — availability doesn't matter for collapse

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
      value: "", onChange: () => {}, models: LOCAL_MODELS, status: STATUS, ...props,
    }));
  });
  return { root, container };
}

// ---- 1. open: sections collapsed, headers show name + count, no model rows ----
console.log("case 1: fresh open — everything collapsed");
{
  const { root } = mount({});
  clickEl(buttons()[0]); // trigger
  const body = textOf(document.body);
  check("LOCAL header visible", body.includes("LOCAL"));
  check("ANTHROPIC header visible", body.includes("ANTHROPIC"));
  check("local count shown (2)", buttons().some(b => textOf(b).includes("LOCAL") && textOf(b).includes("2")));
  check("no local model rows yet", !body.includes("llama-8b.gguf"));
  check("no anthropic model rows yet", !body.includes("Claude Opus 4.7"));
  check("no auto rows yet", !body.includes("Auto · Cheapest"));
  act(() => root.unmount());
}

// ---- 2. clicking a header expands that section only; again collapses ----
console.log("case 2: header click toggles its section");
{
  const { root } = mount({});
  clickEl(buttons()[0]);
  const localHdr = buttons().find(b => textOf(b).includes("LOCAL") && !textOf(b).includes("TUNED"));
  clickEl(localHdr);
  let body = textOf(document.body);
  check("local rows appear after header click", body.includes("llama-8b.gguf") && body.includes("qwen-14b.gguf"));
  check("other sections stay collapsed", !body.includes("Claude Opus 4.7") && !body.includes("Auto · Cheapest"));
  clickEl(buttons().find(b => textOf(b).includes("LOCAL") && !textOf(b).includes("TUNED")));
  body = textOf(document.body);
  check("second click collapses again", !body.includes("llama-8b.gguf"));
  act(() => root.unmount());
}

// ---- 3. current selection's section pre-expands on open ----
console.log("case 3: selected model's section opens itself");
{
  const { root } = mount({ value: "api/gpt-5.2" });
  clickEl(buttons()[0]);
  const body = textOf(document.body);
  check("openai section pre-expanded", body.includes("GPT-5.2 (API)"));
  check("local still collapsed", !body.includes("llama-8b.gguf"));
  act(() => root.unmount());
}

// ---- 4. localOnly with a single section: always expanded, no dead click ----
console.log("case 4: sole section (localOnly) auto-expands");
{
  const { root } = mount({ localOnly: true });
  clickEl(buttons()[0]);
  const body = textOf(document.body);
  check("sole LOCAL section shows its rows immediately", body.includes("llama-8b.gguf"));
  act(() => root.unmount());
}

// ---- 5. picking a model still works through an expanded section ----
console.log("case 5: selection still fires onChange");
{
  let picked = "";
  const container = document.getElementById("root");
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(ModelPicker, {
      value: "", onChange: (id) => { picked = id; }, models: LOCAL_MODELS, status: STATUS,
    }));
  });
  clickEl(buttons()[0]);
  clickEl(buttons().find(b => textOf(b).includes("LOCAL") && !textOf(b).includes("TUNED")));
  clickEl(buttons().find(b => textOf(b).includes("llama-8b.gguf")));
  check("onChange got the model id", picked === "llama-8b.gguf");
  check("popover closed after pick", !textOf(document.body).includes("ANTHROPIC"));
  act(() => root.unmount());
}

fs.rmSync(TMP, { recursive: true, force: true });
if (failures > 0) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log("\nall assertions passed");
