// Regression gate for the Agents ⇄ Code page layout merge (user spec
// 2026-08-14): the Agents page REUSES the Code page's column building blocks
// instead of keeping its own layout —
//   • left column   = Code project rail (🧠 memory + file tree) with the
//                     agentic Publisher card where Code carries GitHub cards
//   • right column  = the Code side panel's resizable shell + tab style +
//                     bottom Usage/Browser container, carrying the agentic
//                     Rules / Team pages AND the Code page's Notebook page.
//                     The focused agent's page has no tab of its own — the
//                     chat/log host below IS it and is always on screen.
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
const rightColumnEnd = agentsPage.indexOf("// ---------- AgentVoiceRow ----------");
check(rightColumnEnd > agentsPage.indexOf("function RightColumnTabs"),
  "the right-column slice used by the checks below is real (a -1 marker would slice the WHOLE file and pass everything)");
const rightColumn = agentsPage.slice(
  agentsPage.indexOf("function RightColumnTabs"),
  rightColumnEnd,
);
check(rightColumn.includes("<UsagePanel provider={props.usageProvider} />")
  && rightColumn.includes("<BrowserToggleButton open={props.browserOpen}"),
  "the bottom utility container carries Usage + the 🌐 Browser toggle, like the Code panel");
// Step 2 (user spec 2026-08-14): ADD the agentic pages to the Code page's
// column — don't REPLACE its features. So the 📓 Notebook page the Code panel
// carries must be here too, and the FlowHeader's duplicate button is gone.
check(agentsPage.includes('notebook: "📓 Notebook"')
  && rightColumn.includes('data-ui="RightNotebookHost"')
  && rightColumn.includes("{props.notebook}"),
  "the agentic right column carries the Code panel's 📓 Notebook page");
check(rightColumn.includes('display: tab === "notebook" ? "flex" : "none"')
  && rightColumn.includes('display: tab === "notebook" ? "none" : "flex"'),
  "the Notebook page swaps with the chat host and BOTH stay mounted (state survives tab flips)");
check(agentsPage.includes("<RunNotebook\n                inline")
  && !/<RunNotebook(?![\s\S]{0,40}inline)/.test(agentsPage),
  "AgentsPage mounts the shared RunNotebook INLINE in that page — the popup copy is gone");
check(rightColumn.includes('window.addEventListener("owllm:open-run-notebook"'),
  "the open-notebook event (Brainstorm hand-off) selects the page instead of popping a window");
check(!agentsPage.includes('data-ui="FlowNotebookBtn"'),
  "the FlowHeader's duplicate 📓 Notebook button is gone — the page IS the notebook");
check(agentsPage.includes('data-ui="AgentsUtilityPanelCollapse"')
  && agentsPage.includes('data-ui="AgentsUtilityPanelRail"')
  && agentsPage.slice(agentsPage.indexOf('data-ui="AgentsUtilityPanelRail"')).includes('selectAgentsSideTab("notebook"); setSideOpen(true)'),
  "the collapsed rail carries the notebook icon and it lands on the Notebook page");

// ---- 2b. Memory is the LEFT column's button only (user spec 2026-08-14) ----
check(!agentsPage.includes('data-ui="FlowMemoryBtn"')
  && agentsPage.includes('data-ui="AgentsProjectMemory"'),
  "the canvas header's 🧠 Memory button is gone — memory lives in the left column");
check(agentsPage.includes('selectAgentsSideTab("rules"); setSideOpen(true)'),
  "the shrunk ⚡ rules icon lands on the Rules page through the stored tab handover");

// ---- 2c. Pages are Rules | Team | Notebook — the agent's page has no button
//          (user spec 2026-08-14). The chat/log host below IS that page and is
//          always on screen, so a tab that only collapsed the settings strip
//          was redundant. "Super User" is renamed to what it shows: Rules. ----
check(agentsPage.includes('type RightTabId = "rules" | "team" | "notebook"')
  && agentsPage.includes('rules: "📋 Rules"')
  && !agentsPage.includes('"📜 Orchestrator"'),
  "the right column's page ids/labels are Rules | Team | Notebook — no agent tab, no Super User");
check(rightColumn.includes('{(["rules","team","notebook"] as const).map(id => {')
  && !rightColumn.includes('tab === "orch"')
  && !rightColumn.includes("<OrchAgentSettings"),
  "the tab strip renders exactly those three and the per-agent settings face is gone with the tab");
check(!agentsPage.includes("function OrchAgentSettings"),
  "the now-unreachable per-agent settings component is deleted, not left as dead code");
check(agentsPage.includes("<AgentVoiceRow\n            agent={agentName}")
  && agentsPage.includes("onPickAgentVoice={onPickAgentVoice}\n            ttsVoices={ttsVoices}"),
  "the per-agent Voice row survives the tab removal — it moved into the agent editor, next to its model");
check(rightColumn.includes('rulesPage={tab === "rules"}')
  && agentsPage.includes("const effTab = rulesPage"),
  "the renamed Rules page still pins the pane to the rules editor (chat tabs hidden there)");
check(agentsPage.includes('if (t === "rules" || t === "super") return "rules";'),
  'a column left on the pre-rename "super" page migrates to Rules instead of being bounced elsewhere');
check(rightColumn.includes('display: tab === "team" ? "block" : "none"'),
  "the settings strip is Team-scope only — Rules and Notebook are full pages");

// ---- 2d. The three run switches sit on ONE line above the composer ----
check(!agentsPage.includes("function SuperUserSettings")
  && !rightColumn.includes("<SuperUserSettings"),
  "the Super User container is gone from the right column, component and all");
check(agentsPage.includes("function RunToggleRow")
  && agentsPage.includes('data-ui="RunToggleRow"')
  && agentsPage.includes("checked={autoApprove}")
  && agentsPage.includes("checked={directorMode}")
  && agentsPage.includes("checked={parallelMode}"),
  "all THREE switches (auto-approve · critic authority · parallel dispatch) live in one row component");
const dock = agentsPage.slice(
  agentsPage.indexOf("function ChatInputDock"),
  agentsPage.indexOf("// OrchestratorPane — RIGHT pane"),
);
check(dock.includes("<RunToggleRow")
  && dock.indexOf("<RunToggleRow") < dock.indexOf("<Composer"),
  "the row renders ABOVE the input text box, inside the composer dock");
check(!dock.includes('key: "auto"') && !dock.includes("⚡ Auto mode"),
  "auto-approve is no longer ALSO a Composer toolbar toggle — one control per setting");

// ---- 2e. The project strip's create button says what it creates ----
check(agentsPage.includes('data-ui="NewProjectBtn"')
  && agentsPage.slice(agentsPage.indexOf('data-ui="NewProjectBtn"')).startsWith('data-ui="NewProjectBtn"')
  && /data-ui="NewProjectBtn"[\s\S]{0,400}?>\+ New Project<\/button>/.test(agentsPage),
  'the project strip\'s create button reads "+ New Project", not a bare "+ New"');

// ---- 3. Left column = Code project rail with the Publisher card ----
check(agentsPage.includes('data-ui="AgentsProjectRail"')
  && agentsPage.includes('data-state={agentsProjectRailOpen ? "expanded" : "collapsed"}')
  && agentsPage.includes("width: agentsProjectRailOpen ? 220 : RAIL_W"),
  "the Agents page has the Code page's left project rail (220px, collapsible to the icon rail)");
const leftRail = agentsPage.slice(
  agentsPage.indexOf('data-ui="AgentsProjectRail"'),
  agentsPage.indexOf("{/* Canvas column"),
);
// Step 4 (user spec 2026-08-14): the Publish card IS the Producer card — the
// WHOLE agent card (identity + model picker + release controls), docked at the
// bottom of this column, and NOT also tiled on the canvas.
check(leftRail.includes("<TreeDir path={publisherCwd}")
  && leftRail.includes('data-ui="AgentsProjectRailPublisher"')
  && leftRail.includes("<AgentChatTile")
  && leftRail.includes("isPublisher")
  && leftRail.includes("projectCwd={publisherCwd}"),
  "expanded left column = 🧠 memory + the shared file tree + the whole Producer CARD");
check(leftRail.includes("onPickModel={(id) => onPickAgentModel(producerSpec.name, id)}")
  // The picker's VALUE is the Producer's explicit pick; the resolved model
  // stays disclosed through modelDisplayLabel (one-model-every-surface fix).
  && leftRail.includes("modelId={agentExplicitModelFor(producerSpec.name)}")
  && leftRail.includes("modelDisplayLabel={labelForModel(resolved)}")
  && leftRail.includes("onOpenEditor={() => setEditingAgent(producerSpec.name)}")
  // and NOT the buttons-only panel it replaced — the whole card, or nothing.
  && !leftRail.includes("<PublisherTilePanel"),
  "the docked Producer card keeps its model selection and its agent identity, not just the buttons");
check(leftRail.indexOf('data-ui="AgentsProjectRailPublisher"') > leftRail.indexOf("<TreeDir path={publisherCwd}"),
  "the Producer card sits at the BOTTOM of the column, under the file tree");
const chatGrid = agentsPage.slice(
  agentsPage.indexOf("function AgentChatGrid"),
  agentsPage.indexOf("// ── Publisher card body"),
);
check(chatGrid.includes("agents: team.agents.filter(a => !isPublisherAgent(a, roleByName))")
  && !chatGrid.includes("isPublisher={"),
  "the canvas chat grid no longer tiles a Producer card — the docked one is the only copy");
check(agentsPage.includes("function isPublisherAgent(")
  && agentsPage.includes("roster.find(a => isPublisherAgent(a, roleByName))")
  && agentsPage.includes("agents.find(a => isPublisherAgent(a, roleByName))"),
  "ONE publisher predicate drives the solo roster, the grid filter and the docked card");
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
