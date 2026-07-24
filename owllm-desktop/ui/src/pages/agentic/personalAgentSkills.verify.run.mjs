// Focused executable verifier for personal skill creation, attachment, and
// runtime authorization. Uses the pure-JS TypeScript compiler available in
// this checkout so it is portable across the Windows/WSL workspace.
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const ts = (await import(pathToFileURL(path.join(REPO, "node_modules/typescript/lib/typescript.js")).href)).default;
const ROOT = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || "/tmp", "personal-skills-verify-"));
const AGENTIC = path.join(ROOT, "ui/src/pages/agentic");
fs.mkdirSync(AGENTIC, { recursive: true });

for (const name of [
  "personalAgentConfig.ts",
  "personalAgentRuntime.ts",
  "personalAgentTeams.ts",
  "personalAgentSkills.verify.ts",
]) {
  const source = fs.readFileSync(path.join(HERE, name), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  fs.writeFileSync(path.join(AGENTIC, name.replace(/\.ts$/, ".js")), output);
}

const tauriDir = path.join(ROOT, "node_modules/@tauri-apps/api");
fs.mkdirSync(tauriDir, { recursive: true });
fs.writeFileSync(path.join(tauriDir, "package.json"), JSON.stringify({ name: "@tauri-apps/api", main: "core.js" }));
fs.writeFileSync(path.join(tauriDir, "core.js"), "exports.invoke = async () => { throw new Error('unexpected Tauri call in pure skill verifier'); };");

try {
  createRequire(path.join(AGENTIC, "personalAgentSkills.verify.js"))(
    path.join(AGENTIC, "personalAgentSkills.verify.js"),
  );

  const dialog = fs.readFileSync(path.join(HERE, "PersonalAgentsDialog.tsx"), "utf8").replace(/\r\n/g, "\n");
  const teamPanel = fs.readFileSync(path.join(HERE, "PersonalAgentTeamsPanel.tsx"), "utf8").replace(/\r\n/g, "\n");
  const runtime = fs.readFileSync(path.join(HERE, "personalAgentRuntime.ts"), "utf8").replace(/\r\n/g, "\n");
  const localTools = fs.readFileSync(path.join(HERE, "localTools.ts"), "utf8").replace(/\r\n/g, "\n");
  const personalAgentsRust = fs.readFileSync(path.join(REPO, "src-tauri/src/personal_agents.rs"), "utf8").replace(/\r\n/g, "\n");
  let failed = 0;
  const pin = (label, condition) => {
    if (condition) console.log(`  ✓ ${label}`);
    else { failed++; console.error(`  ✗ ${label}`); }
  };

  console.log("\nPersonal-agent skill UI/runtime wiring pins:\n");
  for (const command of [
    "personal_agent_list_skills",
    "personal_agent_get_skill",
    "personal_agent_validate_skill",
    "personal_agent_save_skill",
  ]) {
    pin(`dialog invokes ${command}`, dialog.includes(`"${command}"`));
  }
  pin("dialog exposes a dedicated Skills tab", dialog.includes('nav("skills", "Skills")'));
  pin("starter workflows are explicitly draft-only",
    dialog.includes("Templates are editable drafts. They never auto-activate"));
  pin("profile attachment stores exact personal-skill revisions",
    dialog.includes("personalSkillRefs: ids.map") &&
    dialog.includes("revision: activeGlobalSkills.find"));
  pin("base profiles expose only active global personal skills",
    dialog.includes("activeGlobalSkills.map") &&
    dialog.includes("Project-private skills belong in the current project's override"));
  pin("project override separately attaches project-visible personal skills",
    dialog.includes("<ProjectOverrideEditor") &&
    dialog.includes("personalSkills={activeSkills}") &&
    dialog.includes("Personal-skill override"));
  pin("import preview accepts new and legacy skill count fields",
    dialog.includes("importPreview.personalSkills ?? importPreview.skills ?? 0"));
  pin("quarantined imports cannot activate without review",
    dialog.includes("Quarantined skills must first be saved as a reviewed draft"));
  pin("team UI allows only runtime-supported and profile-authorized skill tools",
    teamPanel.includes("disabled={incompatible}") &&
    teamPanel.includes("PERSONAL_TEAM_RUNTIME_TOOL_NAMES") &&
    teamPanel.includes("Every member profile must allow"));
  const uiRegistry = localTools
    .match(/export const LOCAL_TOOL_SPECS: ToolSpec\[\] = \[(.*?)\n\];/s)?.[1]
    ?.matchAll(/^    name:\s*"([^"]+)"/gm);
  const rustRegistry = personalAgentsRust
    .match(/fn canonical_tool_names\(\).*?\{\s*\[(.*?)\]\s*\.into_iter\(\)/s)?.[1]
    ?.matchAll(/"([^"]+)"/g);
  const uiToolNames = new Set([...(uiRegistry ?? [])].map(match => match[1]));
  const rustToolNames = new Set([...(rustRegistry ?? [])].map(match => match[1]));
  pin("frontend and backend personal-skill tool registries stay in parity",
    uiToolNames.size > 0 &&
    uiToolNames.size === rustToolNames.size &&
    [...uiToolNames].every(name => rustToolNames.has(name)));
  pin("runtime prompt includes only exact attached refs",
    runtime.includes("attachedRefs.has(`${skill.id}@${skill.revision}`)") &&
    runtime.includes("Do not invoke, infer, or search for any other personal skill"));
  if (failed) throw new Error(`FAILED: ${failed} source wiring pin(s).`);
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}
