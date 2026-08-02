// Focused layout guard for the agentic utility controls. These controls live
// in narrow/resizable columns, so source pins intentionally cover the sizing
// contracts that prevent labels and Notebook editors from being clipped.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readLF = (name) => fs.readFileSync(path.join(HERE, name), "utf8").replace(/\r\n/g, "\n");
const sidePanel = readLF("CodeSidePanel.tsx");
const codePage = readLF("CodePage.tsx");
const agentsPage = readLF("AgentsPage.tsx");

let failures = 0;
const check = (label, condition) => {
  if (condition) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ ${label}`); }
};

console.log("\nAgentic layout/control checks:\n");

check("inline Notebook column has a 420px writable minimum", sidePanel.includes("const MIN_W = 420"));
check("inline Notebook defaults to a comfortably wide column", sidePanel.includes("window.innerWidth * 0.28"));
check("Notebook surface fills the widened column", sidePanel.includes('width, flexShrink: 0, minHeight: 0, display: "flex"'));
check("Terminal is absent from the compact side-panel header", !sidePanel.includes("onToggleTerminal") && !sidePanel.includes("🖥 Terminal"));
check("Terminal remains reachable in both toolbars above the Code composers",
  codePage.includes('"CodePrimaryTerminalButton"')
  && codePage.includes('"CodeSecondaryTerminalButton"')
  && codePage.includes(">Terminal</button>")
  && !codePage.includes("Terminal belongs with the workspace composer"));
const codeHeader = codePage.slice(codePage.indexOf("{/* Header: workspace"), codePage.indexOf("{/* Phase 3:"));
check("Terminal and model picker are absent from the crowded Code header", !codeHeader.includes("aria-label=\"Open terminal\"") && !codeHeader.includes("<ModelPicker"));
// Both Code composers are now the ONE shared <Composer/> (components/Composer.tsx);
// the header slot still carries that agent's model picker and Terminal button.
const primaryToolbar = codePage.slice(codePage.indexOf('dataUi="CodePrimaryComposer"'), codePage.indexOf("attachments={codeAttachments}"));
const secondaryToolbar = codePage.slice(codePage.indexOf('dataUi="CodeSecondaryComposer"'), codePage.indexOf("attachments={secondaryAttachments}"));
check("primary model selection shares its Terminal row above the input", primaryToolbar.includes('toolbarDataUi="CodePrimaryComposerToolbar"') && primaryToolbar.includes('data-ui="CodePrimaryComposerModelPicker"') && primaryToolbar.includes("<ModelPicker") && primaryToolbar.includes('renderTerminalButton("primary")'));
check("second-agent model selection shares its Terminal row above its input", secondaryToolbar.includes('toolbarDataUi="CodeSecondaryComposerToolbar"') && secondaryToolbar.includes('data-ui="CodeSecondaryComposerModelPicker"') && secondaryToolbar.includes("<ModelPicker") && secondaryToolbar.includes('renderTerminalButton("secondary")'));
check("both composer model selectors are dropups", primaryToolbar.includes('placement="top"') && secondaryToolbar.includes('placement="top"'));
check("Project Memory has a protected visible row in the left project rail", codePage.includes('data-ui="CodeProjectMemory"') && codePage.includes("🧠 Project Memory"));
check("Code side-panel invocation no longer passes terminal header props", !codePage.includes("terminalOpen={termOpen && !termHidden}"));
check("publisher panel can shrink inside the chat-grid column", agentsPage.includes('flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column"'));
check("Set up repo row wraps rather than clipping on narrow columns", agentsPage.includes('gap: 8, flexWrap: "wrap", width: "100%", minWidth: 0'));
check("Set up repo label has an explicit non-clipping layout", agentsPage.includes('flex: "0 0 auto", whiteSpace: "nowrap" }}>⚙ Set up repo'));
check("publisher readiness badge stays within a wrapped row", agentsPage.includes('marginLeft: "auto", maxWidth: "100%", whiteSpace: "nowrap"'));

if (failures) throw new Error(`FAILED: ${failures} agentic layout/control check(s).`);
console.log("\nall checks passed");
