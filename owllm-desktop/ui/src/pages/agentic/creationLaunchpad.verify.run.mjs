// Release-discovered regression check for the shared Coding / Agentic start
// experience. Run from owllm-desktop:
//   node ui/src/pages/agentic/creationLaunchpad.verify.run.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Read line-ending agnostically: on a Windows release host core.autocrlf checks
// sources out with CRLF, which would break every multi-line assertion below.
const read = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const src = (name) => read(path.join(here, name));
const component = src("CreationLaunchpad.tsx");
const code = src("CodePage.tsx");
const agents = src("AgentsPage.tsx");
const projectDialog = src("ProjectSettingsDialog.tsx");
const styles = read(path.resolve(here, "../../styles.css"));
const foldStyles = src("CreationLaunchpad.fold.css");
const theme = read(path.resolve(here, "../../theme.ts"));
const themePreferences = read(path.resolve(here, "../../themePreferences.ts"));

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
check("Fold derives its complete material palette from the active app accent",
  foldStyles.includes("--fold-accent-rgb: var(--accent-rgb);")
  && foldStyles.includes("--fold-tone-a: color-mix(in srgb, var(--accent)")
  && foldStyles.includes("--fold-tone-b: color-mix(in srgb, var(--accent)")
  && foldStyles.includes("--fold-tone-c: color-mix(in srgb, var(--accent)")
  && ["base", "plane", "rail", "card"].every((token) =>
    (foldStyles.match(new RegExp(`--fold-${token}: color-mix\\(in srgb, var\\(--accent\\)`, "g")) ?? []).length === 2)
  && !/--fold-(?:cyan|violet|coral)/.test(foldStyles));
check("Fold receives every named and custom GUI colour through the live accent tokens",
  ["indigo", "amber", "red", "blue", "emerald", "slate"].every((key) =>
    themePreferences.includes(`key: "${key}"`))
  && themePreferences.includes("if (value && isHexColor(value)) return value;")
  && theme.includes('root.style.setProperty("--accent", hex)')
  && theme.includes('root.style.setProperty("--accent-rgb", rgb)'));
check("Fold keeps accent-derived material surfaces legible in the light app theme",
  foldStyles.includes(':root[data-theme="light"] .creation-launchpad[data-design="fold"]')
  && foldStyles.includes("--fold-tone-a: color-mix(in srgb, var(--accent) 76%, black 24%);")
  && foldStyles.includes("--fold-base: color-mix(in srgb, var(--accent) 12%, #f4f6fa 88%);")
  && foldStyles.includes("--fold-card: color-mix(in srgb, var(--accent) 14%, #ffffff 86%);"));
check("Fold retains the installed app accent for its primary action",
  foldStyles.includes("color-mix(in srgb, var(--accent) 74%, var(--fold-tone-a) 26%)")
  && foldStyles.includes("color: var(--accent-fg);"));
check("Fold effects are ambient and interaction-specific",
  foldStyles.includes("@keyframes fold-aurora-drift")
  && foldStyles.includes("@keyframes fold-refraction")
  && foldStyles.includes("@keyframes fold-seam-breathe")
  && foldStyles.includes(".creation-launchpad__composer:focus-within")
  && foldStyles.includes(".creation-launchpad__mode:hover"));
check("Fold turns the established chat aura around its own perimeter",
  !component.includes('className="creation-launchpad__aura"')
  && foldStyles.includes("@property --fold-aura-angle")
  && foldStyles.includes("@keyframes fold-aura-border-turn")
  && foldStyles.includes("animation: fold-aura-border-turn 8s linear infinite;")
  && foldStyles.includes("border: 2px solid transparent;")
  && foldStyles.includes("conic-gradient(\n      from var(--fold-aura-angle)")
  && foldStyles.includes(") border-box;")
  && ["#3cf26b", "#ffd93c", "#ff9a3c", "#ff5c8a", "#b07cff", "#7fd4ff"].every((colour) => foldStyles.includes(colour))
  && foldStyles.includes("0 0 12px rgba(176, 124, 255, .22)")
  && foldStyles.includes("0 0 20px rgba(127, 212, 255, .14)"));
check("Fold carries the same turning aura around every right-column mode card",
  /\.creation-launchpad__mode\s*\{[\s\S]*?border:\s*1px solid transparent;[\s\S]*?conic-gradient\(\s*from var\(--fold-aura-angle\)[\s\S]*?\) border-box;[\s\S]*?animation:\s*fold-aura-border-turn 8s linear infinite;/.test(foldStyles)
  && /\.creation-launchpad__mode\.is-active\s*\{[\s\S]*?border-color:\s*transparent;/.test(foldStyles)
  && !/\.creation-launchpad__mode\.is-active\s*\{[\s\S]*?-5px\s+0\s+0/.test(foldStyles));
check("Fold mode copy stays sharp and fully opaque",
  /\.creation-launchpad__mode-copy strong\s*\{[\s\S]*?color:\s*var\(--fg-strong\);[\s\S]*?font-weight:\s*800;[\s\S]*?opacity:\s*1;/.test(foldStyles)
  && /\.creation-launchpad__mode-copy small\s*\{[\s\S]*?color:\s*var\(--fg\);[\s\S]*?font-size:\s*11px;[\s\S]*?font-weight:\s*600;[\s\S]*?opacity:\s*1;/.test(foldStyles));
check("Fold carries the visible spectrum into its outcome headline",
  ["--fold-spectrum-cyan", "--fold-spectrum-violet", "--fold-spectrum-rose", "--fold-spectrum-gold"].every((tone) =>
    foldStyles.includes(`var(${tone})`))
  && /\.creation-launchpad__title em\s*\{[\s\S]*?var\(--fold-spectrum-cyan\)[\s\S]*?var\(--fold-spectrum-violet\)[\s\S]*?var\(--fold-spectrum-rose\)[\s\S]*?var\(--fold-spectrum-gold\)/.test(foldStyles));
check("Fold material planes retain visible accent colour",
  foldStyles.includes("--fold-base: color-mix(in srgb, var(--accent) 28%")
  && foldStyles.includes("--fold-plane: color-mix(in srgb, var(--accent) 36%")
  && foldStyles.includes("--fold-rail: color-mix(in srgb, var(--accent) 43%")
  && foldStyles.includes("--fold-card: color-mix(in srgb, var(--accent) 34%"));
check("Fold motion respects reduced-motion preferences",
  foldStyles.includes("@media (prefers-reduced-motion: reduce)")
  && foldStyles.includes("animation: none;")
  && foldStyles.includes("transition: none;")
  && foldStyles.includes("animation-duration: 48s;"));
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
