// One-shot verify for the Notebook's start controls: the Kanban NOW column's
// "⚡ Start batch" button feeds the whole lane WITHOUT consuming the board,
// and the "▶ Start queue" button feeds the first pending step so an idle
// team + auto-feed can actually begin walking the list. Mounts the REAL
// RunNotebook.tsx in jsdom via react-dom.
//
// Run from owllm-desktop/:  node ui/src/pages/agentic/notebookStartBatch.verify.run.mjs
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
let JSDOM;
try {
  ({ JSDOM } = req("jsdom"));
} catch {
  console.log("SKIP notebookStartBatch: jsdom not installed (run `npm i --no-save jsdom` to exercise this harness).");
  process.exit(0);
}

// ---- DOM environment (react-dom needs window/document globals; the notebook
// needs a working localStorage, which jsdom provides given a real origin) ----
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.localStorage = dom.window.localStorage;
globalThis.CustomEvent = dom.window.CustomEvent;

// ---- transpile the real RunNotebook.tsx to CJS, stub its siblings ----
const src = fs.readFileSync(path.join(HERE, "RunNotebook.tsx"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
}).outputText;
const TMP = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "nb-verify-"));
fs.mkdirSync(path.join(TMP, "hooks"), { recursive: true });
fs.mkdirSync(path.join(TMP, "components"), { recursive: true });
fs.writeFileSync(path.join(TMP, "pages.js"), js); // placeholder name below
fs.writeFileSync(path.join(TMP, "RunNotebook.js"), js);
fs.writeFileSync(path.join(TMP, "dispatch.js"), `
  module.exports = { streamChatCompletion: async () => {}, providerFor: () => "local" };
`);
fs.writeFileSync(path.join(TMP, "ModelPicker.js"), `
  const React = require("react");
  module.exports = { __esModule: true, default: () => React.createElement("div", null, "(model picker)") };
`);
fs.writeFileSync(path.join(TMP, "hooks.js"), `
  module.exports = { __esModule: true, useAutoResize: () => ({ current: null }) };
`);
fs.writeFileSync(path.join(TMP, "LogBox.js"), `
  const React = require("react");
  module.exports = { __esModule: true, default: () => React.createElement("pre", null) };
`);
// Rewrite relative imports in the transpiled output to the stubs.
let out = fs.readFileSync(path.join(TMP, "RunNotebook.js"), "utf8");
out = out
  .replace(/require\("\.\.\/\.\.\/hooks\/useAutoResize"\)/g, 'require("./hooks.js")')
  .replace(/require\("\.\.\/\.\.\/components\/LogBox"\)/g, 'require("./LogBox.js")')
  .replace(/require\("\.\/dispatch"\)/g, 'require("./dispatch.js")')
  .replace(/require\("\.\/ModelPicker"\)/g, 'require("./ModelPicker.js")');
fs.writeFileSync(path.join(TMP, "RunNotebook.js"), out);
fs.writeFileSync(path.join(TMP, "package.json"), "{}");
fs.mkdirSync(path.join(TMP, "node_modules"), { recursive: true });
for (const m of ["react", "react-dom", "scheduler"]) {
  fs.cpSync(path.join(REPO, "node_modules", m), path.join(TMP, "node_modules", m), { recursive: true });
}

const reqTmp = createRequire(path.join(TMP, "RunNotebook.js"));
const React = reqTmp("react");
const { createRoot } = reqTmp("react-dom/client");
const { act } = reqTmp("react");
const NB = reqTmp("./RunNotebook.js");
const RunNotebook = NB.default;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ---- helpers ----
const PID = "verify-project";
const KEY = `owllm:agents:notebook:${PID}`;
const PLAN = "NOW:\n- fix the frame\n- fix the hit area\n\nNEXT:\n- linux screenshots\n\nLATER:\n- parity pass";
function seed() {
  localStorage.setItem(KEY, JSON.stringify({
    text: "", plan: PLAN,
    steps: [
      { id: "s1", text: "first pending step", status: "pending", ts: 1 },
      { id: "s2", text: "second pending step", status: "pending", ts: 2 },
    ],
    autoFeed: true, digest: [],
  }));
}
function blob() { return JSON.parse(localStorage.getItem(KEY)); }
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
    root.render(React.createElement(RunNotebook, {
      projectId: PID, running: false, onFeed: () => "dispatched",
      modelId: "m", port: 0, models: [], inline: true, ...props,
    }));
  });
  return { root, container };
}

// ---- 1. NOW column has a Start batch button; feeding sends the lane and
//         leaves the board untouched ----
console.log("case 1: ⚡ Start batch feeds the NOW lane without consuming it");
{
  seed();
  const fed = [];
  const { root } = mount({ onFeed: (t) => { fed.push(t); return "dispatched"; } });
  const btn = buttons().find((b) => textOf(b).includes("Start batch"));
  check("Start batch button exists", !!btn);
  clickEl(btn);
  check("onFeed called once", fed.length === 1);
  check("feed text carries the NOW cards", fed[0]?.includes("fix the frame") && fed[0]?.includes("fix the hit area"));
  check("feed text names the NOW batch", /NOW batch/i.test(fed[0] ?? ""));
  check("feed text does NOT include other lanes", !fed[0]?.includes("linux screenshots") && !fed[0]?.includes("parity pass"));
  const after = blob();
  check("plan board content is unchanged", after.plan.includes("fix the frame") && after.plan.includes("linux screenshots") && after.plan.includes("parity pass"));
  check("steps are unchanged", after.steps.length === 2 && after.steps.every((s) => s.status === "pending"));
  check("dispatched notice shows", textOf(document.body).includes("dispatched as a new goal"));
  act(() => root.unmount());
}

// ---- 2. empty NOW lane → button disabled, nothing fed ----
console.log("case 2: empty NOW lane disables Start batch");
{
  localStorage.setItem(KEY, JSON.stringify({ text: "", plan: "NOW:\n\nNEXT:\n- x\n\nLATER:", steps: [], autoFeed: false, digest: [] }));
  const fed = [];
  const { root } = mount({ onFeed: (t) => { fed.push(t); return "dispatched"; } });
  const btn = buttons().find((b) => textOf(b).includes("Start batch"));
  check("button present but disabled", !!btn && btn.disabled);
  clickEl(btn);
  check("nothing fed", fed.length === 0);
  act(() => root.unmount());
}

// ---- 3. ▶ Start queue feeds the FIRST pending step and marks it sent ----
console.log("case 3: ▶ Start queue kicks off the step list");
{
  seed();
  const fed = [];
  const { root } = mount({ onFeed: (t) => { fed.push(t); return "dispatched"; } });
  const btn = buttons().find((b) => textOf(b).includes("Start queue"));
  check("Start queue button exists when steps pending", !!btn);
  clickEl(btn);
  check("first pending step fed", fed.length === 1 && fed[0] === "first pending step");
  const after = blob();
  check("first step marked sent", after.steps.find((s) => s.id === "s1")?.status === "sent");
  check("second step still pending", after.steps.find((s) => s.id === "s2")?.status === "pending");
  act(() => root.unmount());
}

// ---- 4. no team ready → step NOT consumed, lane NOT consumed ----
console.log("case 4: no-team result consumes nothing");
{
  seed();
  const { root } = mount({ onFeed: () => "no-team" });
  clickEl(buttons().find((b) => textOf(b).includes("Start queue")));
  check("step stays pending on no-team", blob().steps.find((s) => s.id === "s1")?.status === "pending");
  clickEl(buttons().find((b) => textOf(b).includes("Start batch")));
  check("board unchanged on no-team", blob().plan === PLAN.replace(/\n\n/g, "\n\n"));
  check("no-team notice shows", textOf(document.body).includes("no team ready"));
  act(() => root.unmount());
}

// ---- 5. no pending steps → Start queue hidden ----
console.log("case 5: Start queue hides with nothing pending");
{
  localStorage.setItem(KEY, JSON.stringify({ text: "", plan: PLAN, steps: [{ id: "s1", text: "done step", status: "done", ts: 1 }], autoFeed: true, digest: [] }));
  const { root } = mount({});
  check("no Start queue button", !buttons().some((b) => textOf(b).includes("Start queue")));
  act(() => root.unmount());
}

console.log(failures ? `\n${failures} FAILURES` : "\nall checks passed");
process.exit(failures ? 1 : 0);
