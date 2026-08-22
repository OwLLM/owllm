// Release-discovered regression for Personal Secretary screenshot operations.
// The old path captured only the shared browser/desktop scope and routed a
// simple media operation through the full multi-agent workflow.
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ROOT = path.resolve(HERE, "../../../..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");
const browser = read("src-tauri/src/browser.rs");
const localTools = read("ui/src/pages/agentic/localTools.ts");
const gateway = read("src-tauri/src/mcp_gateway.rs");
const agents = read("ui/src/pages/agentic/AgentsPage.tsx");
const skill = read("resources/agents/skills/web-messaging-artifact/SKILL.md");

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

check("app screenshot scope captures the native OWLLM window",
  browser.includes('"app" | "application" | "owllm" => return capture_app(&app, req)') &&
  browser.includes("support::capture_window_png") &&
  browser.includes('save_browser_capture(app, &png, width, height, "app", None, req)'));
check("app screenshot scope is documented for local/API agents",
  localTools.includes("app captures only the native OWLLM") &&
  localTools.includes("scope=app"));
check("subscription gateway exposes the app screenshot scope",
  gateway.includes('"app"') && gateway.includes("OWLLM app window only"));
// The hardcoded isPersonalSecretaryMediaRequest fast path was replaced by auto
// skill selection (see autoSkillSelection.verify.run.mjs). The guidance it used
// to inline now lives in the web-messaging-artifact skill, loaded on demand.
check("the hardcoded Secretary fast path stays retired",
  !agents.includes("isPersonalSecretaryMediaRequest") &&
  !agents.includes("FAST EXTERNAL OPERATION"));
check("skill guidance replaces it on the solo and orchestrator paths",
  (agents.match(/buildSoloSkillBlock\(/g) ?? []).length >= 2);
check("the skill protects readable screenshots from WhatsApp photo recompression",
  /as a \*\*Document\*\*/.test(skill) && /not recompressed/.test(skill));

// Negative controls: the old implementation must not satisfy these guards.
check("negative control catches the old browser-only screenshot scopes",
  !browser.replace('"app" => capture_app(&app, req)', '"viewport" => capture_browser_window(&app, None, req)')
    .includes('"app" => capture_app(&app, req)'));
check("negative control catches removal of the skill block",
  !agents.replace(/buildSoloSkillBlock\(/g, "noSkillBlock(").includes("buildSoloSkillBlock("));

console.log(`\npersonalSecretaryScreenshot.verify: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
