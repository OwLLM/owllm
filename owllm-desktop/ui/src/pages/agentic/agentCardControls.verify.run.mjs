// Regression for the per-agent card controls. Discovered automatically by
// scripts/smoke-matrix.mjs before release.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../..");
const agents = fs.readFileSync(path.join(SRC, "pages/agentic/AgentsPage.tsx"), "utf8").replace(/\r\n/g, "\n");
const picker = fs.readFileSync(path.join(SRC, "pages/agentic/ModelPicker.tsx"), "utf8").replace(/\r\n/g, "\n");

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
}

check(picker.includes("compactTrigger?: React.ReactNode"),
  "shared ModelPicker accepts a compact card trigger");
check(picker.includes("{compactTrigger}"),
  "compact trigger still uses the shared ModelPicker popover");
check(agents.includes("onPickAgentModel={onPickAgentModel}"),
  "agent cards receive the existing per-agent model setter");
check(agents.includes("value={modelId}") && agents.includes("onChange={onPickModel}"),
  "card logo picker is bound to the full resolved model id");
check(agents.includes("compactTrigger={"),
  "model logo is the compact picker trigger");
check(agents.includes('aria-label={`${criticEnabled ? "Disable" : "Enable"} Critical Thinker`}'),
  "Critical Thinker card exposes an accessible toggle");
check(agents.includes("aria-pressed={criticEnabled}"),
  "Critical Thinker toggle exposes its current state");
check(agents.includes('data-critic-toggle="true"') && agents.includes('>{criticEnabled ? "ON" : "OFF"}</span>'),
  "Critical Thinker toggle visibly labels its ON/OFF state");
const criticName = agents.indexOf(">{label ?? displayLabel(name)}</span>");
const criticToggle = agents.indexOf('data-critic-toggle="true"');
check(criticName >= 0 && criticToggle > criticName,
  "Critical Thinker ON/OFF toggle appears after the card name");
check(agents.includes("owllm:agents:critic-enabled:"),
  "Critical Thinker preference is scoped per project");
check((agents.match(/criticEnabled &&/g) ?? []).length >= 4,
  "critic off state gates solo, explicit, pre-review, and post-review paths");
check(agents.includes("onToggleCritic={() => setCriticEnabled(v => !v)}"),
  "card toggle is wired to the persisted preference setter");

console.log(`agent card controls verification: ${passed}/${passed} passed`);
