// Regression gate for Workflow <-> Solo continuity and Solo isolation.
// Dependency-free so the smoke matrix can run it before UI packages exist.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const page = fs.readFileSync(path.join(HERE, "AgentsPage.tsx"), "utf8");
const config = fs.readFileSync(path.join(HERE, "teamConfig.ts"), "utf8");

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}

const soloPromptStart = page.indexOf("function buildSoloExecutorPrompt(");
const soloPromptEnd = page.indexOf("\ntype Dispatch =", soloPromptStart);
const soloPrompt = soloPromptStart >= 0 && soloPromptEnd > soloPromptStart
  ? page.slice(soloPromptStart, soloPromptEnd)
  : "";

check("Solo has a dedicated prompt builder", soloPrompt.length > 0);
check("Solo prompt says there is no team roster", soloPrompt.includes("There is no team roster"));
check("Solo prompt forbids dispatch and delegation", soloPrompt.includes("Never emit @agent dispatch lines, delegate"));
check("Solo prompt does not inject the team operating contract", !soloPrompt.includes("TEAM_OPERATING_CONTRACT"));
check("Solo prompt does not inject a routing hint", !soloPrompt.includes("routingHint("));
check("Solo prompt does not reuse a team prompt builder",
  !soloPrompt.includes("buildSpecialistPrompt(") && !soloPrompt.includes("buildOrchestratorPrompt("));
check("Solo prompt does not inherit the lead's Workflow role or system instructions",
  !soloPrompt.includes("effective.role")
    && !soloPrompt.includes("effective.systemInstructions")
    && !soloPrompt.includes("spec.extraPrompt"));
check("Solo runtime uses only the dedicated prompt",
  /const sPrompt = buildSoloExecutorPrompt\(coder, roleByName, directives, sBlock, soloCwd, runEnvironment\);/.test(page)
    && !page.includes("const SOLO_OVERRIDE ="));

check("Solo derives both canvas and runtime executor from the Workflow lead",
  (page.match(/soloGeneralistForTeam\([^\n]+findOrchestratorSpec\(/g) || []).length === 2);
check("Solo executor keeps the lead name but receives generalist capability",
  config.includes("...lead,")
    && config.includes("base: SOLO_GENERALIST_BASE")
    && config.includes('role: "agent"'));
check("Solo executor strips team-only prompt and skill seeds",
  config.includes("extraPrompt: undefined") && config.includes("extraSkills: undefined"));

const modeSetterStart = page.indexOf("const setSoloMode = (v: boolean) => {");
const modeSetterEnd = page.indexOf("\n  };", modeSetterStart);
const modeSetter = modeSetterStart >= 0 && modeSetterEnd > modeSetterStart
  ? page.slice(modeSetterStart, modeSetterEnd)
  : "";
check("Mode switching is refused while a run is active",
  modeSetter.includes("busy || backgroundRunning") && modeSetter.includes("Stop the active run"));
check("Mode switching returns the chat to the canonical transcript",
  modeSetter.includes("setSelectedNode(null)") && page.includes("isSpecialistFocus ? (agentLogs.get(focus) ?? []) : supChat"));
check("Mode controls are disabled for an active run",
  page.includes("disabled={modeSwitchLocked}") && page.includes("modeSwitchLocked={busy || backgroundRunning}"));
check("Solo still receives the visible project conversation",
  page.includes("const sHist = priorHistory && priorHistory.length > 0 ? priorHistory"));
check("Solo uses the same lead name for model, memory and provider session",
  page.includes("effectiveModelFor(coder)")
    && page.includes("runtimeMemoryKey(coder, selectedProjectId)")
    && page.includes("getClaudeSession(selectedProjectId, coder.name)"));

console.log(`\nsoloModeContinuity.verify: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
