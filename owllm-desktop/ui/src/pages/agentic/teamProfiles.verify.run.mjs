// Regression verifier for the one-generic-team profile conversion.
//
// Every bundled team in resources/agents/teams/ is now a PROFILE over the same
// generic 3-agent roster (orchestrator + generalist[solo_generalist] +
// critical_thinker[critic]). What makes "secretary" different from "dev_squad"
// is DATA: required_mcp / mcp_pack (connectors + approval policy), extra_skills
// seeds on the generalist, and domain prompt hints. This gate protects:
//   1. the generic roster shape (so dispatch/solo/critic wiring always works),
//   2. the safety-relevant profile data migrated from the old rosters
//      (approval gates, publish honesty rules, source privacy),
//   3. structural validity via the real normalizeTeam().
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const TEAMS_ROOT = path.join(REPO, "resources/agents/teams");
const ROLES_ROOT = path.join(REPO, "resources/agents/roles");
const SKILLS_ROOT = path.join(REPO, "resources/agents/skills");
const ts = (await import(pathToFileURL(path.join(REPO, "node_modules/typescript/lib/typescript.js")).href)).default;

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

const teamFiles = fs.readdirSync(TEAMS_ROOT).filter((f) => f.endsWith(".json"));
check("bundled team profiles present", teamFiles.length >= 15);

const teams = new Map();
for (const f of teamFiles) {
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(path.join(TEAMS_ROOT, f), "utf8"));
  } catch { /* fall through to the check below */ }
  check(`${f} parses as JSON`, data !== null);
  if (data) teams.set(data.name ?? f.replace(/\.json$/, ""), data);
}

// --- generic roster shape ----------------------------------------------------
const GENERIC = [
  { name: "orchestrator", base: "orchestrator" },
  { name: "generalist", base: "solo_generalist" },
  { name: "critical_thinker", base: "critic" },
];
const skillIds = new Set(
  fs.readdirSync(SKILLS_ROOT).filter((d) => fs.existsSync(path.join(SKILLS_ROOT, d, "SKILL.md"))),
);
for (const [name, t] of teams) {
  const agents = Array.isArray(t.agents) ? t.agents : [];
  check(
    `${name}: generic 3-agent roster (orchestrator + generalist + critical_thinker)`,
    agents.length === 3 && GENERIC.every((g, i) => agents[i]?.name === g.name && agents[i]?.base === g.base),
  );
  const edges = t.graph?.edges ?? [];
  const hasEdge = (s, d) => edges.some((e) => e.source === s && e.target === d);
  check(
    `${name}: canonical profile edges`,
    hasEdge("orchestrator", "generalist") && hasEdge("orchestrator", "critical_thinker"),
  );
  const generalist = agents.find((a) => a?.name === "generalist");
  const seeds = generalist?.extra_skills ?? [];
  check(
    `${name}: generalist skill seeds exist as bundled packs`,
    seeds.every((s) => skillIds.has(s)),
  );
  // Approval policy is profile DATA — a pack that declares approval_required
  // risk must actually list the gated actions.
  if (t.mcp_pack?.risk === "approval_required") {
    check(
      `${name}: mcp_pack approval_required list preserved`,
      Array.isArray(t.mcp_pack.approval_required) && t.mcp_pack.approval_required.length > 0,
    );
  }
}

// --- roles behind the generic roster ship with the app -----------------------
for (const base of ["orchestrator", "solo_generalist", "critic"]) {
  check(`role '${base}' ships in resources/agents/roles`, fs.existsSync(path.join(ROLES_ROOT, `${base}.yaml`)));
}

// --- migrated safety invariants (were roster prompts; now profile prompts) ---
const sec = teams.get("secretary");
const secText = JSON.stringify(sec ?? {});
check("secretary: outbound-message approval gate survives", /approve|approval/i.test(secText) && /never auto-send/i.test(secText));
check("secretary: keeps email+calendar connectors", (sec?.required_mcp ?? []).includes("mcp.email") && (sec?.required_mcp ?? []).includes("mcp.calendar"));

const owllm = teams.get("owllm_team");
const owllmGen = owllm?.agents?.find((a) => a.name === "generalist")?.extra_prompt ?? "";
const owllmAll = JSON.stringify(owllm ?? {});
check("owllm_team: [PUBLISH] host-sentinel protocol survives", owllmGen.includes("[PUBLISH dry notes=") && owllmGen.includes("PUBLISH_OK") && owllmGen.includes("PUBLISH_DRYRUN_OK"));
check("owllm_team: SHIPPED ≠ COMMITTED honesty rule survives", /SHIPPED\s*[≠!]=?\s*COMMITTED|Committing \+ tagging is NOT shipping/i.test(owllmAll));
check("owllm_team: never-push-source-public rule survives", /NEVER push source/i.test(owllmAll));
check("owllm_team: verify-gate honesty survives", owllmAll.includes(".owllm/verify.json"));

const conc = teams.get("concierge");
const concText = JSON.stringify(conc ?? {});
check("concierge: payment stop + no-stored-payment rules survive", /Never store payment details/i.test(concText) && /confirm/i.test(concText));

// --- template identity survives identical generic rosters --------------------
// All profile teams share one roster, so roster-shape matching can no longer
// tell templates apart (every new project would resolve to the alphabetically
// first template). The template id must be persisted at creation and preferred
// during resolution — and re-persisted whenever the roster is rewritten from a
// template.
const agentsPageSrc = fs.readFileSync(path.join(HERE, "AgentsPage.tsx"), "utf8");
const dialogSrc = fs.readFileSync(path.join(HERE, "ProjectSettingsDialog.tsx"), "utf8");
check("project creation persists templateId", dialogSrc.includes("templateId: team.id"));
check("template resolution prefers the persisted id", agentsPageSrc.includes("active.templateId"));
check("graph_json serializer carries templateId", agentsPageSrc.includes("opts.templateId"));
check("reset/change-team re-stamp templateId", (agentsPageSrc.match(/templateId: (tmpl|t)\.id/g) ?? []).length >= 2);
check(
  "template adoption keeps project-provisioned extra agents (assistant browser)",
  agentsPageSrc.includes("const extras = proj.agents.filter(a => !tmplNames.has(a.name))"),
);
check(
  "synthetic critic edges are not injected over authored ones",
  agentsPageSrc.includes("!baseLive.some(e => e.source === se.source && e.target === se.target)"),
);
check("dead per-kind agentNames rosters removed", !dialogSrc.includes("agentNames"));

// --- structural validity through the REAL normalizeTeam ----------------------
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || "/tmp", "teamprofiles-verify-"));
function load(rel) {
  const out = path.join(tmp, rel.replace(/\.ts$/, ".cjs"));
  const js = ts.transpileModule(fs.readFileSync(path.join(HERE, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  fs.writeFileSync(out, js);
  return import(pathToFileURL(out).href);
}
const { normalizeTeam, soloGeneralistForTeam } = await load("teamConfig.ts");
const roles = new Map([
  ["orchestrator", { canDispatch: true, toolAllowlist: ["read_file", "list_dir", "grep", "glob"] }],
  ["solo_generalist", { toolAllowlist: ["all"] }],
  ["critic", { toolAllowlist: ["read_file", "shell"] }],
]);
for (const [name, t] of teams) {
  const team = {
    id: name,
    name,
    display: t.display_name ?? name,
    agents: (t.agents ?? []).map((a) => ({ name: a.name, base: a.base })),
    edges: t.graph?.edges ?? [],
  };
  const report = normalizeTeam(team, roles);
  check(`${name}: normalizeTeam clean (no auto-fixes, no warnings)`, report.changes.length === 0 && report.warnings.length === 0);
  // Solo mode must adopt the team's OWN generalist (so profile skill seeds and
  // prompt hints apply in Solo too), not synthesize a bare one.
  const solo = soloGeneralistForTeam(team);
  check(`${name}: Solo mode adopts the profile generalist`, solo.name === "generalist" && solo.base === "solo_generalist");
}

console.log(`\nteamProfiles.verify: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
