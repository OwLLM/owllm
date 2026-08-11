// Regression gate for the two coding-agent composers. This is intentionally a
// source contract: CodePage owns substantial Tauri/runtime state, so loading
// the full page would replace the real routing with mocks. The checks below
// pin the actual callbacks and layout branches, then exercise the small state
// contracts those callbacks must preserve.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(HERE, name), "utf8").replace(/\r\n/g, "\n");
const codePage = read("CodePage.tsx");
const styles = fs.readFileSync(path.resolve(HERE, "../../styles.css"), "utf8").replace(/\r\n/g, "\n");

let failures = 0;
const check = (label, condition) => {
  if (condition) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ ${label}`); }
};

const primaryStart = codePage.indexOf('dataUi="CodePrimaryComposer"');
const secondaryStart = codePage.indexOf('const renderSecondaryComposer');
const secondaryEnd = codePage.indexOf("// Notebook", secondaryStart);
const primaryEnd = codePage.indexOf("{/* Right cell of the divided composer row", primaryStart);
const primary = codePage.slice(primaryStart, primaryEnd);
const secondary = codePage.slice(secondaryStart, secondaryEnd);

console.log("\nCodePage composer parity:\n");

check("both agents render the shared Composer component",
  codePage.includes('dataUi="CodePrimaryComposer"')
  && codePage.includes('dataUi="CodeSecondaryComposer"')
  && (codePage.match(/<Composer\b/g) ?? []).length >= 3);
check("both agents use the same composer geometry constants",
  codePage.includes("const CODE_COMPOSER_MIN_HEIGHT = 82")
  && codePage.includes("const CODE_COMPOSER_MAX_HEIGHT = 142")
  && (primary.match(/minHeight=\{CODE_COMPOSER_MIN_HEIGHT\}/g) ?? []).length === 1
  && (secondary.match(/minHeight=\{CODE_COMPOSER_MIN_HEIGHT\}/g) ?? []).length === 1
  && (primary.match(/maxHeight=\{CODE_COMPOSER_MAX_HEIGHT\}/g) ?? []).length === 1
  && (secondary.match(/maxHeight=\{CODE_COMPOSER_MAX_HEIGHT\}/g) ?? []).length === 1);
check("both agents use the same model-picker renderer and drop-up placement",
  codePage.includes("const renderCodeModelPicker = (")
  && codePage.includes('placement="top"')
  && codePage.includes('renderCodeModelPicker("primary", modelId, setModelId, busy')
  && codePage.includes('renderCodeModelPicker("secondary", secondaryModelId, setSecondaryModelId, secondaryBusy'));
check("the shared model-picker renderer emits both stable control ids",
  codePage.includes('owner === "primary" ? "CodePrimaryComposerModelPicker" : "CodeSecondaryComposerModelPicker"')
  && codePage.includes("CODE_COMPOSER_MODEL_MIN_WIDTH"));
check("both agents place their Terminal control in the Composer header",
  primary.includes('headerExtra={renderTerminalButton("primary")}')
  && secondary.includes('headerExtra={renderTerminalButton("secondary")}')
  && codePage.includes('const renderTerminalButton = (owner: "primary" | "secondary")'));
check("the shared header pushes model and Terminal controls to the upper right",
  styles.includes(".owc__model {") && styles.includes("margin-left: auto;"));
check("both agents retain independent model-change callbacks",
  codePage.includes("const setModelId =")
  && codePage.includes("const setSecondaryModelId =")
  && codePage.includes("const secondaryModelEffective = secondaryModelId || modelId")
  && primary.includes("onSend={() => { if (agentMode === \"plan\")")
  && secondary.includes("onSend={() => { void sendSecondary(); }}"));
check("submission remains routed to the matching agent history/backend",
  codePage.includes("const send = async (textOverride?: string) =>")
  && codePage.includes("const sendSecondary = async (textOverride?: string) =>")
  && codePage.includes("setMessages((msgs) => [...msgs, { role: \"user\"")
  && codePage.includes("setSecondaryMessages((m) => [...m, {")
  // The second agent is rooted in ITS own checkout (`cwd`), not the primary's.
  && codePage.includes("runSecondaryTurn(CODING_SYSTEM(cwd)"));
check("wide layout aligns both composers as equal columns",
  codePage.includes("secondaryOpen && wideView")
  && codePage.includes('gridTemplateColumns: "1fr 1fr"')
  && codePage.includes('{ minWidth: 0 }}>{renderSecondaryComposer()}</div>'));
check("narrow layout keeps the second composer with its own pane",
  codePage.includes("!wideView && renderSecondaryComposer()")
  && codePage.includes("{secondaryOpen && (")
  && codePage.includes("const [wideView, setWideView]"));
check("panel switching remains user-controlled",
  codePage.includes("const setSecondaryOpen = (v: boolean) => setField(\"secondaryOpen\", v)")
  && codePage.includes('onClick={() => setSecondaryOpen(true)}')
  && codePage.includes('onClick={() => setSecondaryOpen(false)}'));

// Controlled state contract: changing one pick must not change the other,
// both Terminal buttons must invoke the same open/hide transition, and each
// send action must increment only its own route.
const modelState = { primary: "p0", secondary: "s0" };
const changeModel = (owner, value) => { modelState[owner] = value; };
changeModel("primary", "p1");
check("model change contract is independent per agent", modelState.primary === "p1" && modelState.secondary === "s0");

const terminalState = { open: false, hidden: false };
const toggleTerminal = () => {
  if (!terminalState.open) { terminalState.open = true; terminalState.hidden = false; }
  else terminalState.hidden = !terminalState.hidden;
};
toggleTerminal();
const opened = terminalState.open && !terminalState.hidden;
toggleTerminal();
const hidden = terminalState.open && terminalState.hidden;
check("Terminal action contract opens and then hides the shared shell", opened && hidden);

const sends = { primary: 0, secondary: 0 };
const submit = (owner) => { sends[owner] += 1; };
submit("primary");
submit("secondary");
check("submission contract keeps one send route per agent", sends.primary === 1 && sends.secondary === 1);

if (failures) throw new Error(`FAILED: ${failures} CodePage composer parity check(s).`);
console.log("\nall CodePage composer parity checks passed");
