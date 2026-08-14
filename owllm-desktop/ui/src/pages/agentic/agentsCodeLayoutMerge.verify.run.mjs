// Regression gate for the Agents ⇄ Code page layout merge (user spec
// 2026-08-14): the Agents page REUSES the Code page's column building blocks
// instead of keeping its own layout —
//   • left column   = Code project rail (🧠 memory + file tree) with the
//                     agentic Publisher card where Code carries GitHub cards
//   • right column  = the Code side panel's resizable shell + tab style +
//                     bottom Usage/Browser container, carrying the agentic
//                     Super User / Orchestrator / Team pages (NO notebook tab)
//   • composer      = bottom of the canvas column (Code-page position), no
//                     longer docked inside the right column's pane
//   • 🌐 browser    = opens the popup AND splits app + browser side by side
// The rails are additionally EXECUTED (rendered with real React) so the
// notebook-less and publisher variants are proven, not just grepped.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readLF = (name) => fs.readFileSync(path.join(HERE, name), "utf8").replace(/\r\n/g, "\n");
const agentsPage = readLF("AgentsPage.tsx");
const sidePanel = readLF("CodeSidePanel.tsx");
const rails = readLF("CodeColumnRails.tsx");
const codePage = readLF("CodePage.tsx");

let passed = 0;
let failed = 0;
const check = (condition, label) => {
  if (condition) { passed += 1; console.log(`✓ ${label}`); }
  else { failed += 1; console.error(`✗ FAIL ${label}`); }
};

// ---- 1. One implementation: the shared blocks exist and BOTH pages use them ----
check(sidePanel.includes("export function SideColumnShell")
  && sidePanel.includes("export function UsagePanel")
  && sidePanel.includes("export function BrowserToggleButton")
  && sidePanel.includes("export const sideTabStyle"),
  "the Code side panel exports its shell, tab style, usage panel and browser toggle for reuse");
check(sidePanel.includes("<SideColumnShell widthKey={WIDTH_KEY}")
  && sidePanel.includes("<UsagePanel provider={usageProvider} />")
  && sidePanel.includes("<BrowserToggleButton open={browserOpen}"),
  "CodeSidePanel itself renders through the shared pieces (extraction, not a fork)");
check(agentsPage.includes('import { SideColumnShell, sideTabStyle, UsagePanel, BrowserToggleButton } from "./CodeSidePanel"')
  && agentsPage.includes('import { CodeProjectRailIcons, CodeUtilityRailIcons, RAIL_W } from "./CodeColumnRails"')
  && agentsPage.includes('import { TreeDir } from "./CodePage"'),
  "AgentsPage imports the Code page's column building blocks instead of redefining them");
check(codePage.includes("export function TreeDir"),
  "the lazy file tree is exported from CodePage — one tree, both pages");

// ---- 2. Right column = the Code panel's shell + agentic pages, no notebook ----
check(agentsPage.includes('<SideColumnShell widthKey={AGENTS_SIDE_WIDTH_KEY} minW={AGENTS_SIDE_MIN_W} dataUi="RightColumnTabs"'),
  "the agentic right column lives in the SAME resizable shell as the Code side panel");
check(agentsPage.includes("sideTabStyle(tab === id)"),
  "its tab strip renders with the Code panel's tab style");
const rightColumn = agentsPage.slice(
  agentsPage.indexOf("function RightColumnTabs"),
  agentsPage.indexOf("// ---------- SuperUserSettings ----------"),
);
check(rightColumn.includes("<UsagePanel provider={props.usageProvider} />")
  && rightColumn.includes("<BrowserToggleButton open={props.browserOpen}"),
  "the bottom utility container carries Usage + the 🌐 Browser toggle, like the Code panel");
check(!rightColumn.toLowerCase().includes("notebook"),
  "the agentic right column has NO notebook page (Notebook stays on the FlowHeader)");
check(agentsPage.includes('data-ui="AgentsUtilityPanelCollapse"')
  && agentsPage.includes('data-ui="AgentsUtilityPanelRail"')
  && /CodeUtilityRailIcons\s*\n(?:(?!onNotebook)[\s\S])*?onUsage=/.test(agentsPage.slice(agentsPage.indexOf('data-ui="AgentsUtilityPanelRail"'))),
  "the right column collapses to the Code rail — without a notebook icon");
check(agentsPage.includes('selectAgentsSideTab("super"); setSideOpen(true)'),
  "the shrunk ⚡ rules icon lands on the Super User page through the stored tab handover");

// ---- 3. Left column = Code project rail with the Publisher card ----
check(agentsPage.includes('data-ui="AgentsProjectRail"')
  && agentsPage.includes('data-state={agentsProjectRailOpen ? "expanded" : "collapsed"}')
  && agentsPage.includes("width: agentsProjectRailOpen ? 220 : RAIL_W"),
  "the Agents page has the Code page's left project rail (220px, collapsible to the icon rail)");
const leftRail = agentsPage.slice(
  agentsPage.indexOf('data-ui="AgentsProjectRail"'),
  agentsPage.indexOf("{/* Canvas column"),
);
check(leftRail.includes("<TreeDir path={publisherCwd}")
  && leftRail.includes("<PublisherTilePanel cwd={publisherCwd}"),
  "expanded left column = 🧠 memory + the shared file tree + the agentic Publisher card");
check(!leftRail.includes("PublishCards"),
  "the left column carries the Publisher card, NOT the Code page's GitHub container");
check(leftRail.includes("<CodeProjectRailIcons")
  && leftRail.includes("publisher"),
  "collapsed left rail reuses CodeProjectRailIcons in its publisher variant");
check(agentsPage.includes('data-ui="AgentsProjectMemory"')
  && leftRail.includes('new CustomEvent("owllm:open-team-memory")'),
  "the rail's 🧠 button opens the SAME Team/Project Memory the header button opens");

// ---- 4. Composer position: canvas column bottom, not the right pane ----
const orchPane = agentsPage.slice(
  agentsPage.indexOf("function OrchestratorPane"),
  agentsPage.indexOf("// ---------- RightColumnTabs ----------"),
);
check(!orchPane.includes("<ChatInputDock"),
  "OrchestratorPane no longer docks the composer (it is purely the log/chat viewer)");
const canvasColumn = agentsPage.slice(
  agentsPage.indexOf('data-ui="RosterLeft"'),
  agentsPage.indexOf('data-ui="RosterSplitter"'),
);
check(canvasColumn.includes("<ChatInputDock"),
  "the composer renders at the bottom of the canvas column — the Code page's position");
check(agentsPage.includes("rightTabSwitchRef.current?.(t)")
  && orchPane.includes("switchTabRef.current = setActiveTab"),
  "the composer's slash commands still switch the right pane's sub-tabs (instance-scoped ref bridge)");
check(agentsPage.includes("const dockDraftKey = selectedProjectId ? `owllm:supdraft:${selectedProjectId}` : \"\""),
  "the lifted draft keeps its per-project storage key — no draft is lost by the move");

// ---- 5. 🌐 also splits the app + browser side by side ----
check(agentsPage.includes('openWelcomeBrowserSplit,'),
  "AgentsPage reuses the shared welcome-split launcher, not a private copy");
const panelListener = agentsPage.slice(
  agentsPage.indexOf('window.addEventListener("owllm:open-browser-panel"') - 400,
  agentsPage.indexOf('window.addEventListener("owllm:open-browser-panel"'),
);
check(panelListener.includes("setBrowserPanelOpen(true);")
  && panelListener.includes("void openBrowserSplit();"),
  "the FlowHeader 🌐 button now opens the popup AND performs the side-by-side split");
check(agentsPage.includes("onToggleBrowser={() => { if (!browserPanelOpen) void openBrowserSplit(); setBrowserPanelOpen(v => !v); }}"),
  "the right column's 🌐 toggle splits when opening — same contract as the Code page");
check(agentsPage.includes('onBrowser={() => { void openBrowserSplit(); }}'),
  "the shrunk 🌐 rail icon opens the browser itself instead of only expanding the column");

// ---- 6. EXECUTED: the rail variants really render what the pins claim ----
// The compiled module must live INSIDE the repo tree so node can resolve
// react/react-dom by walking up to owllm-desktop/node_modules (a module in
// the OS temp dir has no node_modules above it).
const modulePath = path.join(HERE, `.tmp-agentsCodeLayoutMerge-${process.pid}.mjs`);
try {
  const compiled = ts.transpileModule(rails, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  fs.writeFileSync(modulePath, compiled);
  const railsMod = await import(pathToFileURL(modulePath).href);
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement: h } = await import("react");
  const noop = () => {};
  const utilAgents = renderToStaticMarkup(h(railsMod.CodeUtilityRailIcons, { onUsage: noop, onRules: noop, onBrowser: noop, onExpand: noop }));
  check(!utilAgents.includes("📓") && utilAgents.includes("📊") && utilAgents.includes("⚡") && utilAgents.includes("🌐"),
    "EXECUTED: the utility rail without onNotebook renders usage/rules/browser and NO notebook icon");
  const utilCode = renderToStaticMarkup(h(railsMod.CodeUtilityRailIcons, { onNotebook: noop, onUsage: noop, onRules: noop, onBrowser: noop, onExpand: noop }));
  check(utilCode.includes("📓"),
    "EXECUTED: the Code page's rail (with onNotebook) still shows the notebook icon");
  const projAgents = renderToStaticMarkup(h(railsMod.CodeProjectRailIcons, { publisher: true, onMemory: noop, onExpand: noop }));
  check(projAgents.includes("🚀") && !projAgents.includes("🐙") && projAgents.includes("CodeProjectRailCollapsedPublisher"),
    "EXECUTED: the publisher variant renders 🚀 instead of the GitHub octopus");
  const projCode = renderToStaticMarkup(h(railsMod.CodeProjectRailIcons, { onMemory: noop, onExpand: noop }));
  check(projCode.includes("🐙") && !projCode.includes("🚀"),
    "EXECUTED: the Code page's default rail still renders the GitHub octopus");
} catch (e) {
  check(false, `executed rail render works (${e})`);
} finally {
  fs.rmSync(modulePath, { force: true });
}

if (failed) {
  console.error(`\nagentsCodeLayoutMerge: ${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`\nall checks passed (${passed})`);
