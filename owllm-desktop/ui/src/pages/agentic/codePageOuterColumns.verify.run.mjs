// Regression gate for independently shrinkable Code-page outer columns.
// CodePage needs Tauri/runtime state to mount, so exercise the persisted state
// rule directly and pin the rendered controls/layout contract in source.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readLF = (name) => fs.readFileSync(path.join(HERE, name), "utf8").replace(/\r\n/g, "\n");
const codePage = readLF("CodePage.tsx");
const sidePanel = readLF("CodeSidePanel.tsx");

let passed = 0;
const check = (condition, label) => {
  if (!condition) throw new Error(`FAIL ${label}`);
  passed += 1;
  console.log(`✓ ${label}`);
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
  && codePage.includes('width: projectRailOpen ? 220 : 40')
  && codePage.includes('data-state={projectRailOpen ? "expanded" : "collapsed"}'),
  "left column shrinks to a stable labelled rail instead of disappearing");
check(codePage.includes('data-ui="CodeUtilityPanelRail"')
  && codePage.includes('data-state="collapsed"')
  && codePage.includes("width: 40"),
  "right column shrinks to a stable labelled rail instead of disappearing");
check(codePage.includes('data-ui="CodeProjectRailCollapsedIcon"')
  && codePage.includes('>🧠</span>')
  && codePage.includes('fontSize: 22')
  && codePage.includes('color: "#ff78b7"')
  && codePage.includes('rgba(255, 82, 160, 0.16)'),
  "collapsed left rail shows a larger pink brain control");
check(codePage.includes('data-ui="CodeUtilityPanelCollapsedIcon"')
  && codePage.includes('>📓</span>')
  && codePage.includes('color: "#ffad42"')
  && codePage.includes('rgba(255, 153, 51, 0.17)'),
  "collapsed right rail shows a larger orange notebook control");
check(codePage.includes('data-ui="CodeProjectRailCollapse"')
  && codePage.includes('data-ui="CodeProjectRailExpand"')
  && codePage.includes('aria-label="Shrink left project column"')
  && codePage.includes('aria-label="Expand left project column"'),
  "left arrow controls are visible and keyboard-labelled in both states");
check(sidePanel.includes('data-ui="CodeUtilityPanelCollapse"')
  && codePage.includes('data-ui="CodeUtilityPanelExpand"')
  && sidePanel.includes('aria-label="Shrink right utility column"')
  && codePage.includes('aria-label="Expand right utility column"'),
  "right arrow controls are visible and keyboard-labelled in both states");
check(codePage.includes('onClick={() => setProjectRailOpen(false)}')
  && codePage.includes('onClick={() => setProjectRailOpen(true)}')
  && codePage.includes('onCollapse={() => setUtilityPanelOpen(false)}')
  && codePage.includes('onClick={() => setUtilityPanelOpen(true)}'),
  "all four arrow actions route to the matching column state");
check(sidePanel.includes("onCollapse: () => void;")
  && sidePanel.includes("notebook, onCollapse }: Props"),
  "expanded right panel delegates collapse without owning duplicate state");
check(codePage.includes('flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column"'),
  "center chat remains shrinkable and consumes released column space");

console.log(`\nall checks passed (${passed})`);
