// Regression verifier for generic auto-skill selection in Solo mode.
// Replaces the old Personal Secretary screenshot fast-path verifier.
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const SKILLS_ROOT = path.join(REPO, "resources/agents/skills");
const ts = (await import(pathToFileURL(path.join(REPO, "node_modules/typescript/lib/typescript.js")).href)).default;

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || "/tmp", "autoskill-verify-"));

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

// --- minimal frontmatter parser for SKILL.md --------------------------------
function splitFrontmatter(raw) {
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0] !== "---") return { frontmatter: {}, body: raw };
  const end = lines.slice(1).findIndex((l) => l === "---");
  if (end < 0) return { frontmatter: {}, body: raw };
  return {
    frontmatter: lines.slice(1, end + 1).join("\n"),
    body: lines.slice(end + 2).join("\n"),
  };
}

function parseFrontmatter(text) {
  const fm = {};
  let currentKey = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const arrMatch = /^([a-zA-Z0-9_]+):\s*$/.exec(line);
    if (arrMatch) {
      currentKey = arrMatch[1];
      fm[currentKey] = [];
      continue;
    }
    const itemMatch = /^\s*-\s+(.+)$/.exec(line);
    if (itemMatch && currentKey) {
      fm[currentKey].push(itemMatch[1].trim());
      continue;
    }
    const kvMatch = /^([a-zA-Z0-9_]+):\s*(.+)$/.exec(line);
    if (kvMatch) {
      currentKey = null;
      fm[kvMatch[1]] = kvMatch[2].trim();
    }
  }
  return fm;
}

// --- mock Tauri invoke that serves the real bundled skill packs -----------
function loadSkillPacks() {
  const packs = [];
  for (const dir of fs.readdirSync(SKILLS_ROOT)) {
    const md = path.join(SKILLS_ROOT, dir, "SKILL.md");
    if (!fs.existsSync(md)) continue;
    const raw = fs.readFileSync(md, "utf8");
    const { frontmatter, body } = splitFrontmatter(raw);
    packs.push({
      id: dir,
      path: md,
      dir: path.join(SKILLS_ROOT, dir),
      frontmatter: parseFrontmatter(frontmatter),
      body,
    });
  }
  return packs;
}

const skillPacks = loadSkillPacks();
const mockCoreDir = path.join(tmp, "node_modules/@tauri-apps/api");
fs.mkdirSync(mockCoreDir, { recursive: true });
fs.writeFileSync(
  path.join(mockCoreDir, "core.js"),
  `exports.invoke = async function (cmd) { if (cmd === "list_skill_packs") return ${JSON.stringify(skillPacks)}; throw new Error("unexpected invoke: " + cmd); };`,
);

function load(rel) {
  const out = path.join(tmp, rel.replace(/\.ts$/, ".cjs"));
  const js = ts.transpileModule(fs.readFileSync(path.join(HERE, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  fs.writeFileSync(out, js);
  return import(pathToFileURL(out).href);
}

const { selectRelevantSkillIds, buildSoloSkillBlock } = await load("skillRuntime.ts");

// --- source-level assertions: the old workaround must be gone ---------------
const agentsPage = fs.readFileSync(path.join(HERE, "AgentsPage.tsx"), "utf8");
check("isPersonalSecretaryMediaRequest removed", !agentsPage.includes("isPersonalSecretaryMediaRequest"));
check("directExternalAction removed", !agentsPage.includes("directExternalAction"));
check("FAST EXTERNAL OPERATION prompt removed", !agentsPage.includes("FAST EXTERNAL OPERATION"));
check("buildSoloSkillBlock imported and wired", agentsPage.includes("buildSoloSkillBlock"));
check("auto-loaded skills are surfaced in thought log", /Auto-loaded skill\(s\)/.test(agentsPage));

// --- BOTH dispatch copies are wired (AgentsPage solo+orchestrator, bridge) ---
const dispatchTs = fs.readFileSync(path.join(HERE, "dispatch.ts"), "utf8");
check("bridge dispatch copy wires buildSoloSkillBlock", dispatchTs.includes("buildSoloSkillBlock"));
check("bridge dispatch surfaces auto-loaded skills", /Auto-loaded skill\(s\)/.test(dispatchTs));
check(
  "desktop orchestrator path wires buildSoloSkillBlock",
  (agentsPage.match(/buildSoloSkillBlock\(/g) ?? []).length >= 2,
);

// --- every bundled skill declares explicit triggers --------------------------
for (const p of skillPacks) {
  check(`bundled skill '${p.id}' declares triggers`, Array.isArray(p.frontmatter.triggers) && p.frontmatter.triggers.length > 0);
}

// --- the new skill exists and declares triggers -----------------------------
const skillPath = path.join(SKILLS_ROOT, "web-messaging-artifact/SKILL.md");
check("web-messaging-artifact skill exists", fs.existsSync(skillPath));
const skillText = fs.readFileSync(skillPath, "utf8");
check("skill declares triggers", /triggers:\s*$/m.test(skillText) && /^\s+-\s+whatsapp/m.test(skillText));
check("skill references browser_upload_file", skillText.includes("browser_upload_file"));
check("skill references browser_screenshot", skillText.includes("browser_screenshot"));

// --- functional assertions: auto-selection matches real user requests --------
async function matches(query, expectedId) {
  const ids = await selectRelevantSkillIds(query, { max: 2 });
  return ids.includes(expectedId);
}

check(
  "whatsapp screenshot request matches web-messaging-artifact",
  await matches("send this screenshot to John on WhatsApp", "web-messaging-artifact"),
);
check(
  "telegram upload request matches web-messaging-artifact",
  await matches("upload the report to Telegram", "web-messaging-artifact"),
);
check(
  "unrelated code request does not auto-load web-messaging-artifact",
  !(await matches("fix the rust compile error in src/main.rs", "web-messaging-artifact")),
);

// --- buildSoloSkillBlock merges equipped + auto-loaded skills ---------------
const { block, autoLoaded } = await buildSoloSkillBlock(["engineering-craft"], "attach this file on WhatsApp");
check("buildSoloSkillBlock auto-loads the messaging skill", autoLoaded.includes("web-messaging-artifact"));
check("buildSoloSkillBlock keeps equipped skill", block.includes("Skill: Engineering Craft") || block.includes("engineering-craft"));
check("buildSoloSkillBlock injects auto-loaded skill body", block.includes("Web Messaging Artifact"));

console.log(`\nautoSkillSelection.verify: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
