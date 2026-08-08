// Regression gate for independently shrinkable Code-page outer columns.
// CodePage needs Tauri/runtime state to mount, so exercise the persisted state
// rule directly and pin the rendered controls/layout contract in source.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readLF = (name) => fs.readFileSync(path.join(HERE, name), "utf8").replace(/\r\n/g, "\n");
const codePage = readLF("CodePage.tsx");
const sidePanel = readLF("CodeSidePanel.tsx");
const rails = readLF("CodeColumnRails.tsx");

let passed = 0;
let failed = 0;
// Report EVERY broken invariant, not just the first — a rail regression usually
// breaks several at once and one message hides the shape of the damage.
const check = (condition, label) => {
  if (condition) { passed += 1; console.log(`✓ ${label}`); }
  else { failed += 1; console.error(`✗ FAIL ${label}`); }
};

const defaultState = codePage.slice(
  codePage.indexOf("const DEFAULT_CODE_STATE"),
  codePage.indexOf("};", codePage.indexOf("const DEFAULT_CODE_STATE")) + 2,
);
check(/projectRailOpen:\s*true/.test(defaultState) && /utilityPanelOpen:\s*true/.test(defaultState),
  "new coding pages start with both outer columns expanded");
check(codePage.includes("const projectRailOpen: boolean = stx.projectRailOpen ?? true;")
  && codePage.includes("const utilityPanelOpen: boolean = stx.utilityPanelOpen ?? true;"),
  "older saved pages receive the expanded default only when no preference exists");
check(codePage.includes('setField("projectRailOpen", v)')
  && codePage.includes('setField("utilityPanelOpen", v)'),
  "both column choices use the existing per-page persisted state");

let state = { projectRailOpen: true, utilityPanelOpen: true };
const setProjectRailOpen = (open) => { state = { ...state, projectRailOpen: open }; };
const setUtilityPanelOpen = (open) => { state = { ...state, utilityPanelOpen: open }; };
setProjectRailOpen(false);
check(state.projectRailOpen === false && state.utilityPanelOpen === true,
  "shrinking the left column does not change the right column");
setUtilityPanelOpen(false);
check(state.projectRailOpen === false && state.utilityPanelOpen === false,
  "the right column can shrink independently");
setProjectRailOpen(true);
setUtilityPanelOpen(true);
check(state.projectRailOpen === true && state.utilityPanelOpen === true,
  "both columns can be expanded again");

check(codePage.includes('data-ui="CodeProjectRail"')
  && codePage.includes('width: projectRailOpen ? 220 : RAIL_W')
  && rails.includes("export const RAIL_W = 46")
  && codePage.includes('data-state={projectRailOpen ? "expanded" : "collapsed"}'),
  "left column shrinks to a stable labelled rail instead of disappearing");
check(codePage.includes('data-ui="CodeUtilityPanelRail"')
  && codePage.includes('data-state="collapsed"')
  && codePage.includes("width: RAIL_W, flexShrink: 0"),
  "right column shrinks to a stable labelled rail instead of disappearing");
check(rails.includes('iconId="CodeProjectRailCollapsedIcon"')
  && rails.includes('>🧠</RailButton>')
  && rails.includes("export const RAIL_ICON: CSSProperties = { fontSize: 22 }")
  && rails.includes('const PINK = { color: "#ff78b7", bg: "rgba(255, 82, 160, 0.16)", border: "rgba(255, 105, 180, 0.68)" }'),
  "collapsed left rail shows a larger pink brain control");
check(rails.includes('iconId="CodeUtilityPanelCollapsedIcon"')
  && rails.includes('>📓</RailButton>')
  && rails.includes('const ORANGE = { color: "#ffad42", bg: "rgba(255, 153, 51, 0.17)", border: "rgba(255, 166, 64, 0.7)" }'),
  "collapsed right rail shows a larger orange notebook control");
check(/export const railIconBtn[\s\S]*?width: 38, height: 40/.test(rails),
  "rail feature icons are bigger than an ordinary 30px control");

// ---- Every feature the columns hold is reachable while shrunk ----
for (const [id, glyph] of [
  ["CodeProjectRailCollapsedMemory", "🧠"],
  ["CodeProjectRailCollapsedFiles", "📁"],
  ["CodeProjectRailCollapsedGithub", "🐙"],
]) {
  check(rails.includes(`id="${id}"`) && rails.includes(`>${glyph}</RailButton>`),
    `collapsed left rail exposes ${id}`);
}
for (const [id, glyph] of [
  ["CodeUtilityPanelCollapsedNotebook", "📓"],
  ["CodeUtilityPanelCollapsedUsage", "📊"],
  ["CodeUtilityPanelCollapsedRules", "⚡"],
  ["CodeUtilityPanelCollapsedBrowser", "🌐"],
]) {
  check(rails.includes(`id="${id}"`) && rails.includes(`>${glyph}</RailButton>`),
    `collapsed right rail exposes ${id}`);
}
check(codePage.includes('selectCodeSidePanelTab("notebook"); setUtilityPanelOpen(true)')
  && codePage.includes('selectCodeSidePanelTab("super"); setUtilityPanelOpen(true)')
  && sidePanel.includes("export function selectCodeSidePanelTab")
  && sidePanel.includes("const pickTab = (t: CodeSidePanelTab) => { setTab(t); selectCodeSidePanelTab(t); };"),
  "notebook/rules rail icons open the column onto the page they name, through the panel's own tab store");

// The shrunk browser icon must ACT, not merely expand the column.
const browserRailAction = codePage.slice(
  codePage.indexOf("onBrowser={"),
  codePage.indexOf("onExpand={() => setUtilityPanelOpen(true)}"),
);
check(browserRailAction.includes("void openBrowserSplit()")
  && !browserRailAction.includes("setUtilityPanelOpen(true)"),
  "shrunk browser icon opens the browser itself instead of only expanding the column");
check(codePage.includes("await openWelcomeBrowserSplit(")
  && codePage.includes('import { openWelcomeBrowserSplit } from "./projectEnvironment"'),
  "the browser control reuses the shared environment launcher, not a private copy");
// Run the REAL helper the rail calls, recording what it asks the backend to do.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-code-rail-"));
try {
  const compiled = ts.transpileModule(readLF("projectEnvironment.ts"), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modulePath = path.join(temp, "projectEnvironment.mjs");
  fs.writeFileSync(modulePath, compiled);
  const environment = await import(pathToFileURL(modulePath).href);
  const calls = [];
  // A missing/broken helper must be REPORTED, not crash the run — a gate that
  // dies mid-way hides every invariant after it.
  try {
    await environment.openWelcomeBrowserSplit(async (command, args) => {
      calls.push({ command, args });
      return null;
    });
  } catch (e) {
    check(false, `openWelcomeBrowserSplit is callable (${e})`);
  }
  const names = calls.map(c => c.command);
  check(!names.includes("browser_open_tab") && names.includes("browser_start"),
    "welcome split opens no site tab — browser_start lands on the welcome page");
  const arrange = calls.find(c => c.command === "browser_arrange");
  check(arrange?.args?.layout === "right-half",
    "welcome split arranges the app and browser half/half");
  check(names.indexOf("browser_arrange") > names.indexOf("browser_start")
    && names.at(-1) === "browser_focus",
    "the split is applied after the window exists and ends with a visible browser");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
check(codePage.includes('data-ui="CodeProjectRailCollapse"')
  && rails.includes('id="CodeProjectRailExpand"')
  && codePage.includes('aria-label="Shrink left project column"')
  && rails.includes('label="Expand left project column"'),
  "left arrow controls are visible and keyboard-labelled in both states");
check(sidePanel.includes('data-ui="CodeUtilityPanelCollapse"')
  && rails.includes('id="CodeUtilityPanelExpand"')
  && sidePanel.includes('aria-label="Shrink right utility column"')
  && rails.includes('label="Expand right utility column"'),
  "right arrow controls are visible and keyboard-labelled in both states");
check(codePage.includes('onClick={() => setProjectRailOpen(false)}')
  && codePage.includes('onExpand={() => setProjectRailOpen(true)}')
  && codePage.includes('onCollapse={() => setUtilityPanelOpen(false)}')
  && codePage.includes('onExpand={() => setUtilityPanelOpen(true)}'),
  "all four arrow actions route to the matching column state");
check(sidePanel.includes("onCollapse: () => void;")
  && sidePanel.includes("notebook, onCollapse }: Props"),
  "expanded right panel delegates collapse without owning duplicate state");
check(codePage.includes('flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column"'),
  "center chat remains shrinkable and consumes released column space");

if (failed) {
  console.error(`\ncodePageOuterColumns: ${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`\nall checks passed (${passed})`);
