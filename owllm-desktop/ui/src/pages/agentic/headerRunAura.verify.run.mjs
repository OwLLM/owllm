// Focused verification for the header "running" aura: while any run is in
// flight, the top ModeBar and the SubTabs nav bar show the same rotating
// conic-gradient aura the active agent tiles use, anchored on the selected
// GUI accent. Transpiles the real runActivity module for behavioural checks;
// source-level checks cover the wiring and the visual consistency contract.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../..");
const DESKTOP = path.resolve(SRC, "../..");
const require = createRequire(path.join(DESKTOP, "package.json"));
const ts = require("typescript");
const source = fs.readFileSync(path.join(SRC, "runtime/runActivity.ts"), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-runaura-"));
const modulePath = path.join(temp, "runActivity.cjs");
fs.writeFileSync(modulePath, output);
const act = require(modulePath);

// Read source for content matching independent of the checkout's line endings
// (Windows core.autocrlf checks LF-committed files out as CRLF).
const readSource = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8").replace(/\r\n/g, "\n");

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
}

// ---- behaviour: the aggregate run signal ----
check(act.isRunActive() === false, "no tagged run means the headers stay idle");
let pings = 0;
const unsub = act.subscribeRunActivity(() => { pings += 1; });
act.setRunActivity("agents:coder", true);
check(act.isRunActive() === true && pings === 1, "one active run lights the signal and notifies subscribers");
act.setRunActivity("agents:coder", true);
check(pings === 1, "re-flagging the same tag is idempotent (no subscriber churn)");
act.setRunActivity("stream:chat:A", true);
act.setRunActivity("agents:coder", false);
check(act.isRunActive() === true, "overlapping runs keep the signal lit until the LAST one finishes");
act.setRunActivity("stream:chat:A", false);
check(act.isRunActive() === false, "signal drops when every run has finished");
act.setRunActivity("agents:one", true);
act.setRunActivity("agents:two", true);
act.setRunActivity("code:page", true);
act.clearRunActivity("agents:");
check(act.isRunActive() === true, "prefix clear sweeps only its own family of tags");
act.setRunActivity("code:page", false);
check(act.isRunActive() === false, "signal is clean after the sweep + last removal");
unsub();
const before = pings;
act.setRunActivity("agents:late", true);
check(pings === before, "unsubscribed listeners are not called");
act.clearRunActivity("agents:");

// ---- wiring: every run family feeds the signal ----
const runtime = readSource("runtime/chatRuntime.ts");
check(runtime.includes('setRunActivity(`stream:${id}`, true)') && runtime.includes('setRunActivity(`stream:${id}`, false)'),
  "chatRuntime flags every streamed chat on start and clears it in finally");
const agents = readSource("pages/agentic/AgentsPage.tsx");
check(agents.includes("setRunActivity(`agents:${name}`, true)") && agents.includes("setRunActivity(`agents:${name}`, false)"),
  "AgentsPage rides the SAME addActive/removeActive choke points that drive the tile aura");
check(agents.includes('clearRunActivity("agents:")'),
  "AgentsPage sweeps straggler tags on clearActive and run-finish");
const codePage = readSource("pages/agentic/CodePage.tsx");
check(codePage.includes("setRunActivity(`code:${SID}`, v)"),
  "CodePage setBusy flags code runs (incl. CLI paths outside chatRuntime)");

// ---- headers: both bars carry the aura, reusing the tiles' implementation ----
const shell = readSource("AppShell.tsx");
check(shell.includes("useSyncExternalStore(subscribeRunActivity, isRunActive)"),
  "AppShell subscribes to the live run signal (no polling)");
check(shell.includes("@keyframes owllm-aura-spin") && shell.includes("@property --owllm-aura-angle"),
  "AppShell declares the same aura keyframes/@property the agent tiles use");
check(shell.includes('"owllm-aura-spin 4s linear infinite"'),
  "headers reuse the tiles' exact animation name and 4s linear timing");
check(agents.includes('"owllm-aura-spin 4s linear infinite"'),
  "…and that timing still matches the tile aura at its origin");
check(shell.includes("conic-gradient(from var(--owllm-aura-angle)"),
  "headers paint the rotating conic gradient via the shared animated angle");
const gradAt = shell.indexOf("HEADER_AURA_GRADIENT =");
const gradEnd = shell.indexOf(";", gradAt);
const grad = shell.slice(gradAt, gradEnd);
check(grad.includes("var(--accent)") && grad.indexOf("var(--accent)") !== grad.lastIndexOf("var(--accent)"),
  "the header gradient anchors its start AND end stop on the selected GUI accent");
check(grad.includes("#ffd93c") && grad.includes("#b07cff") && grad.includes("#7fd4ff"),
  "the middle rainbow stops match the tile aura family");

// ModeBar: aura on the top bar, accent-driven fill preserved, geometry stable.
const headerAt = shell.indexOf('data-ui="AppHeader"');
const headerBlock = shell.slice(headerAt, headerAt + 2200);
check(headerBlock.includes("${HEADER_AURA_GRADIENT} border-box") && headerBlock.includes("var(--bg-header)) padding-box"),
  "ModeBar paints the aura border-box over its accent-token fill when running");
check(headerBlock.includes("runActive ? HEADER_AURA_ANIMATION : undefined"),
  "ModeBar animates only while a run is active");
check(headerBlock.includes('border: "2px solid transparent"') && headerBlock.includes('boxSizing: "border-box"'),
  "ModeBar reserves the aura border permanently so a run never shifts layout");

// SubTabs: same treatment on the lower navigation bar.
const subAt = shell.indexOf('data-ui="SubTabsBar"');
const subBlock = shell.slice(subAt, subAt + 2200);
check(subAt !== -1 && subBlock.includes("${HEADER_AURA_GRADIENT} border-box") && subBlock.includes("var(--bg-card)) padding-box"),
  "SubTabs paints the same aura over its own surface token when running");
check(subBlock.includes("runActive ? HEADER_AURA_ANIMATION : undefined"),
  "SubTabs animates only while a run is active");
check(subBlock.includes('borderBottomColor: runActive ? "transparent" : "var(--border)"'),
  "SubTabs keeps its idle bottom separator and hands the edge to the aura while running");

fs.rmSync(temp, { recursive: true, force: true });
console.log(`OK header run aura: ${passed}/${passed} checks passed`);
