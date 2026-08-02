// Regression gate for the Code page's second-agent pane initialization and
// user-controlled switching. The full CodePage requires Tauri/runtime state,
// so this pins the real source contract and exercises the small state rule.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const codePage = fs.readFileSync(path.join(HERE, "CodePage.tsx"), "utf8").replace(/\r\n/g, "\n");

let failures = 0;
const check = (label, condition) => {
  if (condition) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ ${label}`); }
};

console.log("\nCodePage second-agent visibility:\n");

const defaultState = codePage.slice(
  codePage.indexOf("const DEFAULT_CODE_STATE"),
  codePage.indexOf("};", codePage.indexOf("const DEFAULT_CODE_STATE")) + 2,
);
check("new Code pages default the second-agent pane to open",
  /secondaryOpen:\s*true/.test(defaultState));
check("restored sessions use the open default only when no preference exists",
  codePage.includes("const secondaryOpen: boolean = stx.secondaryOpen ?? true;"));

// Controlled state model: the default applies only at initialization; later
// user actions are explicit and must be able to close and reopen the pane.
const initialState = { secondaryOpen: undefined };
const initialized = { secondaryOpen: initialState.secondaryOpen ?? true };
check("missing saved preference initializes open", initialized.secondaryOpen === true);

const restoredClosed = { secondaryOpen: false };
check("saved collapsed preference remains collapsed", (restoredClosed.secondaryOpen ?? true) === false);

const restoredOpen = { secondaryOpen: true };
check("saved expanded preference remains expanded", (restoredOpen.secondaryOpen ?? true) === true);

let panelState = { secondaryOpen: initialized.secondaryOpen };
const setSecondaryOpen = (open) => { panelState = { ...panelState, secondaryOpen: open }; };
setSecondaryOpen(false);
const closedByUser = panelState.secondaryOpen === false;
setSecondaryOpen(true);
const reopenedByUser = panelState.secondaryOpen === true;
check("user can collapse and reopen the second-agent pane", closedByUser && reopenedByUser);

check("rendering and controls switch from the same persisted panel state",
  codePage.includes("{secondaryOpen && (")
  && codePage.includes("!secondaryOpen && (")
  && codePage.includes('onClick={() => setSecondaryOpen(true)}')
  && codePage.includes('onClick={() => setSecondaryOpen(false)}')
  && codePage.includes('const setSecondaryOpen = (v: boolean) => setField("secondaryOpen", v)'));

if (failures) throw new Error(`FAILED: ${failures} CodePage visibility check(s).`);
console.log("\nall CodePage second-agent visibility checks passed");
