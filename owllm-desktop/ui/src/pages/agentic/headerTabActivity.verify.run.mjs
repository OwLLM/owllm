// Focused verification for the WORKFLOW-AWARE second header: the Coding and
// Agents buttons in the SubTabs bar glow (same visual language as those pages'
// own tab-strip activity glow) while that page has a run in flight, then convert
// to a "finished (unseen)" ✓ badge if the run ends while you're on another tab,
// and clear when you open the page. Transpiles the real runActivity +
// headerTabActivity modules for the state-machine behaviour (active / completed
// / idle / simultaneous); source-level checks cover the AppShell wiring and the
// visual-consistency contract with the page tab strip.
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

function loadModule(rel, filename) {
  const source = fs.readFileSync(path.join(SRC, rel), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-tabact-"));
  const modulePath = path.join(temp, filename);
  fs.writeFileSync(modulePath, output);
  return { mod: require(modulePath), cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}

const run = loadModule("runtime/runActivity.ts", "runActivity.cjs");
const act = run.mod;
const tab = loadModule("runtime/headerTabActivity.ts", "headerTabActivity.cjs");
const H = tab.mod;

// Read source for content matching independent of the checkout's line endings
// (Windows core.autocrlf checks LF-committed files out as CRLF).
const readSource = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8").replace(/\r\n/g, "\n");

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
}

// ---- run-tag → page family detection (off the SAME tags as the aggregate) ----
const CODE = H.runPrefixesForPage("code");
const AGENTS = H.runPrefixesForPage("agents");
check(CODE.includes("code:") && CODE.includes("stream:code:"),
  "the Coding button watches code runs (setBusy 'code:*') and code chat streams ('stream:code:*')");
check(AGENTS.includes("agents:"), "the Agents button watches agent runs ('agents:*')");
check(H.isWorkflowAwarePage("code") && H.isWorkflowAwarePage("agents"),
  "code and agents pages are workflow-aware");
check(!H.isWorkflowAwarePage("home") && !H.isWorkflowAwarePage("models") && H.runPrefixesForPage("info").length === 0,
  "other pages (home/models/info) are NOT workflow-aware and never glow");

// ---- IDLE: nothing running ----
check(act.isRunActiveMatching(CODE) === false && act.isRunActiveMatching(AGENTS) === false,
  "idle: no run tags means neither button is working");

// ---- ACTIVE: a code run lights only the Coding button ----
act.setRunActivity("code:code:ws:p1", true);
check(act.isRunActiveMatching(CODE) === true, "active: a code run lights the Coding button");
check(act.isRunActiveMatching(AGENTS) === false, "active: a code run does NOT light the Agents button");

// a code CHAT stream (chatRuntime tags stream:<sid>, sid=code:ws:*) also counts
act.setRunActivity("code:code:ws:p1", false);
act.setRunActivity("stream:code:ws:p1", true);
check(act.isRunActiveMatching(CODE) === true, "active: a code chat stream also lights the Coding button");
act.setRunActivity("stream:code:ws:p1", false);
check(act.isRunActiveMatching(CODE) === false, "the Coding button clears once its code run ends");

// ---- SIMULTANEOUS: code + agents both running light both buttons ----
act.setRunActivity("code:code:ws:p1", true);
act.setRunActivity("agents:coder", true);
check(act.isRunActiveMatching(CODE) === true && act.isRunActiveMatching(AGENTS) === true,
  "simultaneous: both buttons glow when code AND agents run at once");
// one family stopping must clear ONLY its button while the other keeps glowing
act.setRunActivity("code:code:ws:p1", false);
check(act.isRunActiveMatching(CODE) === false && act.isRunActiveMatching(AGENTS) === true,
  "simultaneous: code finishing clears the Coding button but the Agents button stays lit");
act.setRunActivity("agents:coder", false);

// ---- version bumps on EVERY change (drives the per-button re-render) ----
const v0 = act.getRunActivityVersion();
act.setRunActivity("agents:one", true);
act.setRunActivity("agents:two", true);
const v2 = act.getRunActivityVersion();
check(v2 > v0, "the activity version bumps on every change (so glow updates even mid-run)");
act.setRunActivity("agents:one", false);
check(act.getRunActivityVersion() > v2 && act.isRunActiveMatching(AGENTS) === true,
  "version still bumps when one of several agent runs ends, aggregate stays active");
act.clearRunActivity("agents:");

// ---- COMPLETED: run ends while you're AWAY → finished badge; clears on open ----
let s = H.initTabActivity();
// code running while you look at the Agents tab
s = H.stepTabActivity(s, { code: true, agents: false }, "agents");
check(H.showFinishedBadge(s, "code", true) === false,
  "a working page shows NO finished badge (the glow is the signal)");
// code run FINISHES while still on the Agents tab
s = H.stepTabActivity(s, { code: false, agents: false }, "agents");
check(H.showFinishedBadge(s, "code", false) === true,
  "completed-while-away: the Coding button converts to a finished ✓ badge");
// badge persists across idle ticks until you open the page
s = H.stepTabActivity(s, { code: false, agents: false }, "agents");
check(H.showFinishedBadge(s, "code", false) === true, "the finished badge persists until you open the page");
// opening the Coding tab clears its badge
s = H.stepTabActivity(s, { code: false, agents: false }, "code");
check(H.showFinishedBadge(s, "code", false) === false, "opening the page clears its finished badge (seen)");

// ---- a run that finishes ON the active tab never badges (you saw it) ----
let s2 = H.initTabActivity();
s2 = H.stepTabActivity(s2, { code: true, agents: false }, "code"); // working, you're watching
s2 = H.stepTabActivity(s2, { code: false, agents: false }, "code"); // finished while watching
check(H.showFinishedBadge(s2, "code", false) === false,
  "a run finishing on the ACTIVE tab leaves no badge — it was seen live");

// ---- glow wins over a stale badge: never both at once ----
let s3 = H.initTabActivity();
s3 = H.stepTabActivity(s3, { code: true }, "agents");
s3 = H.stepTabActivity(s3, { code: false }, "agents"); // badge earned
check(H.showFinishedBadge(s3, "code", false) === true, "badge present when idle");
check(H.showFinishedBadge(s3, "code", true) === false,
  "if the page starts working again, the live glow suppresses the badge (no double signal)");

// ---- stepTabActivity is a stable React updater (returns prev when unchanged) ----
let s4 = H.initTabActivity();
s4 = H.stepTabActivity(s4, { code: false, agents: false }, "home");
const s4b = H.stepTabActivity(s4, { code: false, agents: false }, "home");
check(s4b === s4, "no-op ticks return the SAME state object (React bail-out, no render churn)");

run.cleanup();
tab.cleanup();

// ---- wiring: runActivity exposes the per-page query + version ----
const runSrc = readSource("runtime/runActivity.ts");
check(runSrc.includes("export function isRunActiveMatching(") && runSrc.includes("export function getRunActivityVersion("),
  "runActivity exports the prefix-match query and the change-version snapshot");

// ---- wiring: AppShell SubTabs renders the per-button glow ----
const shell = readSource("AppShell.tsx");
check(shell.includes('from "./runtime/headerTabActivity"')
  && shell.includes("isWorkflowAwarePage") && shell.includes("runPrefixesForPage")
  && shell.includes("stepTabActivity") && shell.includes("showFinishedBadge"),
  "AppShell imports the workflow-aware header-tab helpers");
check(shell.includes("useRunActivityVersion()") && shell.includes("useSyncExternalStore(subscribeRunActivity, getRunActivityVersion)"),
  "SubTabs re-renders on every run-activity change via the version snapshot");
check(shell.includes("isRunActiveMatching(runPrefixesForPage(p.key))"),
  "SubTabs computes each button's working state from that page's run-tag prefixes");
check(shell.includes("stepTabActivity(prev, workingByKey, activeKey)"),
  "SubTabs drives the finished-badge state machine from working state + the active tab");

// SubTabs button visuals: same pulse + rainbow dot + ✓ as the page tab strip.
const subAt = shell.indexOf("function SubTabs(");
const subBlock = shell.slice(subAt, subAt + 4600);
check(subBlock.includes("animation: working ? HEADER_TAB_WORKING_ANIMATION : undefined"),
  "a working button pulses with the page tab strip's owllm-tab-working animation");
check(subBlock.includes("working && (") && subBlock.includes("background: HEADER_TAB_AURA_DOT"),
  "a working button shows the live rainbow activity dot");
check(subBlock.includes("done && (") && subBlock.includes("}}>✓</span>"),
  "a finished-while-away button shows the ✓ badge");
check(shell.includes('HEADER_TAB_WORKING_ANIMATION = "owllm-tab-working 1.4s ease-in-out infinite"'),
  "the header uses the SAME 1.4s owllm-tab-working timing as the page tab strip");
check(shell.includes("@keyframes owllm-tab-working") && shell.includes("0 0 18px rgba(176,124,255,0.90)"),
  "AppShell declares the owllm-tab-working keyframes (available even when CodePage is unmounted)");

// visual-consistency: the header dot rainbow matches CodePage's tab-strip dot.
const codeSrc = readSource("pages/agentic/CodePage.tsx");
const codeStops = codeSrc.match(/PSYCHEDELIC_AURA_STOPS = "([^"]+)"/);
const headerStops = shell.match(/HEADER_TAB_AURA_STOPS = "([^"]+)"/);
check(codeStops && headerStops && codeStops[1] === headerStops[1],
  "the header activity dot uses the EXACT rainbow stops of the page tab strip (same visual language)");
check(codeSrc.includes('"owllm-tab-working 1.4s ease-in-out infinite"'),
  "…and the page tab strip still uses that same pulse at its origin");

// ---- the aggregate bar aura is preserved (not regressed by the per-button work) ----
check(shell.includes("const runActive = useRunActive();") && shell.includes("runActive ? HEADER_AURA_ANIMATION : undefined"),
  "the existing whole-bar run aura is preserved alongside the new per-button glow");

console.log(`OK header tab activity: ${passed}/${passed} checks passed`);
