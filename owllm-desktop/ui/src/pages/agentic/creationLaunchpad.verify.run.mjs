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
const foldStyles = src("CreationLaunchpad.fold.css");

const checks = [];
function check(name, condition) {
  checks.push({ name, ok: Boolean(condition) });
}

check("shared launchpad exposes a stable UI marker", component.includes('data-ui="CreationLaunchpad"'));
check("shared prompt exposes a stable UI marker", component.includes('data-ui="CreationPrompt"'));
check("Enter submits while Shift+Enter remains multiline",
  component.includes('event.key === "Enter" && !event.shiftKey'));
check("mode cards expose pressed state", component.includes("aria-pressed={active}"));
check("chosen Fold design replaces the temporary concept gallery",
  component.includes('data-design="fold"')
  && component.includes('CreationLaunchpad.fold.css')
  && !component.includes("LAUNCHPAD_CONCEPTS")
  && !component.includes('aria-label="Launchpad concept preview"'));
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
check("Fold preserves overlapping spatial planes and luminous seam",
  foldStyles.includes('grid-template-columns: minmax(0, 1fr) 336px;')
  && foldStyles.includes("clip-path: polygon(0 0, 94% 0, 100% 50%, 94% 100%, 0 100%);")
  && foldStyles.includes("margin-left: -42px;")
  && foldStyles.includes("animation: fold-seam-breathe"));
check("Fold adds a deliberate three-colour spectral material",
  foldStyles.includes("--fold-cyan: #5de8ff;")
  && foldStyles.includes("--fold-violet: #a38aff;")
  && foldStyles.includes("--fold-coral: #ffab91;")
  && foldStyles.includes("linear-gradient(102deg, var(--fold-cyan) 0%, var(--fold-violet) 56%, var(--fold-coral) 108%)"));
check("Fold keeps its spectral colours legible in the light app theme",
  foldStyles.includes(':root[data-theme="light"] .creation-launchpad[data-design="fold"]')
  && foldStyles.includes("--fold-cyan: #007f9d;")
  && foldStyles.includes("--fold-violet: #674bd2;")
  && foldStyles.includes("--fold-coral: #b94f38;"));
check("Fold retains the installed app accent for its primary action",
  foldStyles.includes("color-mix(in srgb, var(--accent) 74%, var(--fold-cyan) 26%)")
  && foldStyles.includes("color: var(--accent-fg);"));
check("Fold effects are ambient and interaction-specific",
  foldStyles.includes("@keyframes fold-aurora-drift")
  && foldStyles.includes("@keyframes fold-refraction")
  && foldStyles.includes("@keyframes fold-seam-breathe")
  && foldStyles.includes(".creation-launchpad__composer:focus-within")
  && foldStyles.includes(".creation-launchpad__mode:hover"));
check("Fold motion respects reduced-motion preferences",
  foldStyles.includes("@media (prefers-reduced-motion: reduce)")
  && foldStyles.includes("animation: none;")
  && foldStyles.includes("transition: none;"));
check("Fold remains usable below rail and phone breakpoints",
  foldStyles.includes("@media (max-width: 980px)")
  && foldStyles.includes("grid-template-columns: repeat(3, minmax(0, 1fr));")
  && foldStyles.includes("@media (max-width: 720px)")
  && foldStyles.includes("grid-template-columns: 1fr;"));
check("Fold's masking and glass effects include WebKit fallbacks",
  foldStyles.includes("-webkit-mask-image:")
  && foldStyles.includes("-webkit-backdrop-filter:"));
check("narrow desktop mode cards reserve readable space for their labels",
  /\.creation-launchpad__mode-copy\s*\{\s*flex:\s*1 1 auto;/.test(styles)
  && styles.includes(".creation-launchpad__mode:has(.creation-launchpad__badge) .creation-launchpad__mode-arrow"));

for (const result of checks) {
  console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}`);
}

const failed = checks.filter((result) => !result.ok);
console.log(`\ncreation launchpad: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) process.exit(1);
