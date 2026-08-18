// Release-discovered regression check for the shared Coding / Agentic start
// experience. Run from owllm-desktop:
//   node ui/src/pages/agentic/creationLaunchpad.verify.run.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (name) => fs.readFileSync(path.join(here, name), "utf8");
const component = src("CreationLaunchpad.tsx");
const code = src("CodePage.tsx");
const agents = src("AgentsPage.tsx");
const projectDialog = src("ProjectSettingsDialog.tsx");
const styles = fs.readFileSync(path.resolve(here, "../../styles.css"), "utf8");

const checks = [];
function check(name, condition) {
  checks.push({ name, ok: Boolean(condition) });
}

check("shared launchpad exposes a stable UI marker", component.includes('data-ui="CreationLaunchpad"'));
check("shared prompt exposes a stable UI marker", component.includes('data-ui="CreationPrompt"'));
check("Enter submits while Shift+Enter remains multiline",
  component.includes('event.key === "Enter" && !event.shiftKey'));
check("mode cards expose pressed state", component.includes("aria-pressed={active}"));
check("launchpad offers three named visual styles",
  component.includes('id: "orbit"')
  && component.includes('id: "aurora"')
  && component.includes('id: "graphite"'));
check("unknown or missing style preferences safely use the calm Orbit default",
  component.includes('export function normalizeLaunchpadStyle')
  && component.includes(': "orbit";'));
check("visual style is exposed to CSS and its controls expose pressed state",
  component.includes("data-style={visualStyle}")
  && component.includes('aria-label="Launchpad visual style"')
  && component.includes("aria-pressed={visualStyle === style.id}"));
check("visual style persists across Coding and Agents without backend coupling",
  component.includes('"owllm:creation-launchpad-style"')
  && component.includes("window.localStorage.getItem(LAUNCHPAD_STYLE_KEY)")
  && component.includes("window.localStorage.setItem(LAUNCHPAD_STYLE_KEY, style)"));
check("Coding renders the shared launchpad", code.includes("<CreationLaunchpad"));
check("Coding uses the same centered workspace shell as Agentic",
  code.includes('data-ui="CodingProjectHubContainer"')
  && code.includes('maxWidth: 1180')
  && code.includes('padding: "clamp(20px,4vw,54px)"')
  && code.includes('radial-gradient(circle at 84% 12%'));
check("Coding offers project, chat and team modes",
  code.includes('id: "project"') && code.includes('id: "chat"') && code.includes('id: "team"'));
check("Coding carries a launch prompt into a new chat",
  code.includes("if (intent) setChatDraft(intent)") && code.includes("setChatMode(true)"));
check("Coding carries a launch prompt through project preparation",
  code.includes("pendingProjectPromptRef") && code.includes("setDraft(pendingPrompt)"));
check("Coding transfers team intent across navigation",
  code.includes('sessionStorage.setItem("owllm:agentic-launch-intent", intent)'));
check("Agentic renders the shared launchpad", agents.includes("<CreationLaunchpad"));
check("Agentic launchpad keeps incoming Coding intent",
  agents.includes('sessionStorage.getItem("owllm:agentic-launch-intent")'));
check("Agentic passes intent and recipe into both project dialogs",
  (agents.match(/initialIntent=\{newProjectIntent\}/g) ?? []).length === 2
    && (agents.match(/initialKindKey=\{newProjectKind\}/g) ?? []).length === 2);
check("project dialog preserves the user's initial intent",
  projectDialog.includes("initialIntent.trim() || requestedKind.descSeed")
    && projectDialog.includes("initialIntent.trim() || k.descSeed"));
check("project dialog can open a preselected visual recipe",
  projectDialog.includes("PROJECT_KINDS.find(k => k.key === initialKindKey)")
    && projectDialog.includes('setStep("form")'));
check("launchpad visual follows the active accent",
  styles.includes(".creation-launchpad") && styles.includes("rgba(var(--accent-rgb)"));
check("shared Coding and Agentic header spans the full launchpad width",
  /\.creation-launchpad__content\s*\{\s*width:\s*100%;\s*max-width:\s*none;\s*box-sizing:\s*border-box;/.test(styles)
  && /\.creation-launchpad__header\s*\{\s*width:\s*100%;\s*box-sizing:\s*border-box;/.test(styles));
check("launchpad has a narrow-layout regression rule",
  styles.includes("@media (max-width: 720px)") && styles.includes("grid-template-columns: 1fr"));
check("each launchpad style has a real palette",
  styles.includes('.creation-launchpad[data-style="aurora"]')
  && styles.includes('.creation-launchpad[data-style="graphite"]')
  && styles.includes("--launch-spectrum:"));
check("launchpad visuals consume palette tokens instead of restoring the aggressive rainbow",
  styles.includes("background: var(--launch-spectrum);")
  && styles.includes("rgba(var(--launch-a-rgb)")
  && !styles.includes("#efff00"));
check("style choices remain usable at phone width",
  styles.includes(".creation-launchpad__style-option { min-width: 28px; width: 28px; padding: 0; }")
  && styles.includes(".creation-launchpad__style-option > span:last-child { display: none; }"));
check("narrow desktop mode cards reserve readable space for their labels",
  /\.creation-launchpad__mode-copy\s*\{\s*flex:\s*1 1 auto;/.test(styles)
  && styles.includes(".creation-launchpad__mode:has(.creation-launchpad__badge) .creation-launchpad__mode-arrow"));

for (const result of checks) {
  console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}`);
}

const failed = checks.filter((result) => !result.ok);
console.log(`\ncreation launchpad: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) process.exit(1);
