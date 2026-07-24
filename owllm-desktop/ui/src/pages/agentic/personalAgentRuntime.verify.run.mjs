// Focused runtime verifier for personal-agent policy enforcement and assignment.
// Uses the pure-JS TypeScript compiler because this WSL checkout has Windows
// native Rollup/esbuild packages.
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const ts = (await import(pathToFileURL(path.join(REPO, "node_modules/typescript/lib/typescript.js")).href)).default;
const ROOT = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || "/tmp", "personal-agent-verify-"));
const AGENTIC = path.join(ROOT, "ui/src/pages/agentic");
fs.mkdirSync(AGENTIC, { recursive: true });

for (const name of ["personalAgentConfig.ts", "personalAgentRuntime.ts", "personalAgentRuntime.verify.ts"]) {
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
fs.writeFileSync(path.join(tauriDir, "core.js"), `
exports.invoke = async function invoke(command, args) {
  const handler = globalThis.__personalAgentInvoke;
  if (typeof handler !== "function") throw new Error("missing personal-agent invoke stub");
  return handler(command, args);
};
`);

try {
  createRequire(path.join(AGENTIC, "personalAgentRuntime.verify.js"))(
    path.join(AGENTIC, "personalAgentRuntime.verify.js"),
  );
  await new Promise(resolve => setTimeout(resolve, 0));

  const readLF = file => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const agents = readLF(path.join(HERE, "AgentsPage.tsx"));
  const dispatch = readLF(path.join(HERE, "dispatch.ts"));
  const localTools = readLF(path.join(HERE, "localTools.ts"));
  let sourceFailures = 0;
  const pin = (label, condition) => {
    if (condition) console.log(`  ✓ ${label}`);
    else { sourceFailures++; console.error(`  ✗ ${label}`); }
  };
  console.log("\nPersonal-agent live wiring source pins:\n");
  pin("team editor visibly lists personal profiles",
    agents.includes("Personal agent profile") && agents.includes('personal_agent_list_profiles'));
  pin("Legacy/no-profile mode is explicit",
    agents.includes("<option value=\"\">Legacy role / no personal profile</option>"));
  pin("selected revision is persisted in profile_ref",
    agents.includes("out.profile_ref = { id: selectedProfile.id, revision: selectedProfile.revision }"));
  pin("project attachment is persisted before template profile assignment",
    agents.indexOf('"personal_agent_save_project_config"') <
    agents.indexOf('"save_team_template", { fileStem: templateId, data }'));
  pin("graph JSON serializes pinned profile references",
    agents.includes("...(a.profileRef ? { profileRef: a.profileRef } : {})"));
  pin("desktop dispatch resolves profiles once before running",
    agents.includes("await resolveRuntimeAgents(selectedProjectId, activeTeam.agents)"));
  pin("shared bridge dispatch resolves profiles once before running",
    dispatch.includes("await resolveRuntimeAgents(projectId ?? \"\", inputTeam.agents)"));
  pin("publisher host bridge is gated by effective personal tools",
    agents.includes('(specEffectiveTools ?? []).includes("publish_release")') &&
    dispatch.includes('(effectiveTools ?? []).includes("publish_release")'));
  pin("automatic documentation dispatch obeys delegation policy",
    agents.includes("docSpec && canDelegateTo(orch, docSpec.name)"));
  pin("critic calls use the critic's pinned model and policy",
    agents.includes("const criticModelForRun = () => criticSpecForRun") &&
    agents.includes("const criticToolsForRun = () => runtimeReadOnlyTools(criticSpecForRun, roleByName)") &&
    dispatch.includes("const critic = findCriticSpec(opts.team)") &&
    dispatch.includes("const modelId = critic ? opts.modelFor(critic.name)"));
  pin("direct tool execution enforces explicit personal deny-all",
    localTools.includes('if (allowedTools?.includes(PERSONAL_POLICY_MARKER))') &&
    localTools.includes("denied by the personal agent's fail-closed allowlist"));
  pin("tool catalog treats an empty personal allowlist as deny-all",
    localTools.includes("const allowSet = personalPolicy") &&
    localTools.includes("? new Set(effectiveAllowed ?? [])"));
  if (sourceFailures) throw new Error(`FAILED: ${sourceFailures} live-wiring source pin(s).`);
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}
