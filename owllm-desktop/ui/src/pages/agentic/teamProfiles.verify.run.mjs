// Regression verifier for the standard-six team roster.
//
// History: commit 89d864a0 (2026-08-01) collapsed all bundled rosters to one
// generic 3-agent shape and this gate was written to ENFORCE that collapse —
// which made the parallel dispatch engine permanently idle (one worker can
// never fan out). On 2026-08-03 the rosters were re-standardized to SIX slots:
//   orchestrator + scout[researcher] + worker_a/worker_b[solo_generalist]
//   + critical_thinker[critic] + producer[publisher]
// Same faces on every team; what differs per template is DATA (required_mcp /
// mcp_pack, worker skill seeds, domain prompt hints). Solo mode elevates the
// same orchestrator identity to generalist power, plus critic/rule-based producer. The full hierarchical Product
// Studio survives as `product_studio_classic` (category Custom) and is the one
// deliberate exemption from the standard shape. This gate protects:
//   1. the standard six-slot roster + its parallel-lane edges,
//   2. the safety-relevant profile data (approval gates, publish honesty
//      rules, source privacy) — incl. the [PUBLISH] protocol living on the
//      producer, the only base the host publish bridge accepts,
//   3. structural validity via the real normalizeTeam(),
//   4. the classic Product Studio's hierarchical shape.
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
check("bundled team profiles present (19 standard + classic)", teamFiles.length >= 20);

const teams = new Map();
for (const f of teamFiles) {
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(path.join(TEAMS_ROOT, f), "utf8"));
  } catch { /* fall through to the check below */ }
  check(`${f} parses as JSON`, data !== null);
  if (data) teams.set(data.name ?? f.replace(/\.json$/, ""), data);
}

// --- standard six-slot roster ------------------------------------------------
const STANDARD = [
  { name: "orchestrator", base: "orchestrator" },
  { name: "scout", base: "researcher" },
  { name: "worker_a", base: "solo_generalist" },
  { name: "worker_b", base: "solo_generalist" },
  { name: "critical_thinker", base: "critic" },
  { name: "producer", base: "publisher" },
];
const STANDARD_EDGES = [
  ["orchestrator", "scout"],
  ["orchestrator", "worker_a"],
  ["orchestrator", "worker_b"],
  ["orchestrator", "critical_thinker"],
  ["orchestrator", "producer"],
  ["scout", "worker_a"],
  ["scout", "worker_b"],
  ["worker_a", "critical_thinker"],
  ["worker_b", "critical_thinker"],
];
// The hierarchical classic studio is the one deliberate exemption.
const STANDARD_EXEMPT = new Set(["product_studio_classic"]);
const skillIds = new Set(
  fs.readdirSync(SKILLS_ROOT).filter((d) => fs.existsSync(path.join(SKILLS_ROOT, d, "SKILL.md"))),
);
const workerPrompts = new Set();
for (const [name, t] of teams) {
  if (STANDARD_EXEMPT.has(name)) continue;
  const agents = Array.isArray(t.agents) ? t.agents : [];
  check(
    `${name}: standard six-slot roster (orchestrator + scout + worker_a/b + critical_thinker + producer)`,
    agents.length === 6 && STANDARD.every((g, i) => agents[i]?.name === g.name && agents[i]?.base === g.base),
  );
  const edges = t.graph?.edges ?? [];
  const hasEdge = (s, d) => edges.some((e) => e.source === s && e.target === d);
  check(
    `${name}: canonical parallel-lane edges`,
    STANDARD_EDGES.every(([s, d]) => hasEdge(s, d)),
  );
  const wa = agents.find((a) => a?.name === "worker_a");
  const wb = agents.find((a) => a?.name === "worker_b");
  const seeds = wa?.extra_skills ?? [];
  check(
    `${name}: worker skill seeds exist as bundled packs`,
    seeds.every((s) => skillIds.has(s)),
  );
  check(
    `${name}: worker lanes are interchangeable (same skills, both carry the profile prompt)`,
    JSON.stringify(wa?.extra_skills ?? []) === JSON.stringify(wb?.extra_skills ?? [])
      && (wa?.extra_prompt ?? "").length > 0 && (wb?.extra_prompt ?? "").length > 0,
  );
  workerPrompts.add(wa?.extra_prompt ?? "");
  const producer = agents.find((a) => a?.name === "producer");
  check(
    `${name}: producer is rule-based (approval-gated, never fabricates completion)`,
    (producer?.extra_prompt ?? "").includes("never fabricate completion")
      && /approval/i.test(producer?.extra_prompt ?? ""),
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
// Same six faces everywhere would be the old collapse all over again if the
// profiles stopped differing — every template must keep a distinct worker
// profile prompt.
check(
  "templates genuinely differ (every worker profile prompt is distinct)",
  workerPrompts.size === teams.size - [...teams.keys()].filter((n) => STANDARD_EXEMPT.has(n)).length,
);

// --- roles behind the standard roster ship with the app ----------------------
for (const base of ["orchestrator", "researcher", "solo_generalist", "critic", "publisher"]) {
  check(`role '${base}' ships in resources/agents/roles`, fs.existsSync(path.join(ROLES_ROOT, `${base}.yaml`)));
}

// --- migrated safety invariants ----------------------------------------------
const sec = teams.get("secretary");
const secText = JSON.stringify(sec ?? {});
check("secretary: outbound-message approval gate survives", /approve|approval/i.test(secText) && /never auto-send/i.test(secText));
check("secretary: keeps email+calendar connectors", (sec?.required_mcp ?? []).includes("mcp.email") && (sec?.required_mcp ?? []).includes("mcp.calendar"));

const owllm = teams.get("owllm_team");
const owllmProd = owllm?.agents?.find((a) => a.name === "producer")?.extra_prompt ?? "";
const owllmWorker = owllm?.agents?.find((a) => a.name === "worker_a")?.extra_prompt ?? "";
const owllmAll = JSON.stringify(owllm ?? {});
check(
  "owllm_team: [PUBLISH] host-sentinel protocol lives on the producer (the only base the host bridge accepts)",
  owllmProd.includes("[PUBLISH dry notes=") && owllmProd.includes("PUBLISH_OK") && owllmProd.includes("PUBLISH_DRYRUN_OK"),
);
check(
  "owllm_team: worker lanes do NOT carry the publish protocol (their base can't trigger the bridge)",
  !owllmWorker.includes("[PUBLISH dry notes="),
);
check("owllm_team: SHIPPED ≠ COMMITTED honesty rule survives", /SHIPPED\s*[≠!]=?\s*COMMITTED|Committing \+ tagging is NOT shipping/i.test(owllmAll));
check("owllm_team: never-push-source-public rule survives", /NEVER push source/i.test(owllmAll));
check("owllm_team: verify-gate honesty survives", owllmAll.includes(".owllm/verify.json"));

const conc = teams.get("concierge");
const concText = JSON.stringify(conc ?? {});
check("concierge: payment stop + no-stored-payment rules survive", /Never store payment details/i.test(concText) && /confirm/i.test(concText));

// --- classic Product Studio: the hierarchical exemption ----------------------
const classic = teams.get("product_studio_classic");
check("product_studio_classic ships (category Custom)", classic?.category === "Custom");
const classicAgents = classic?.agents ?? [];
check("classic: full 10-agent hierarchical roster", classicAgents.length === 10);
const po = classicAgents.find((a) => a.name === "product_owner");
check("classic: product_owner is the design sub-team leader", po?.role === "leader" && po?.base === "operator");
const cEdges = classic?.graph?.edges ?? [];
const cHas = (s, d) => cEdges.some((e) => e.source === s && e.target === d);
check(
  "classic: sub-orchestrator wiring intact (product_owner → design members, orchestrator → build lanes)",
  cHas("orchestrator", "product_owner")
    && ["ux_designer", "backend_arch", "whitepaper_writer", "design_critic"].every((m) => cHas("product_owner", m))
    && ["frontend_coder", "backend_coder", "code_critic", "publisher"].every((m) => cHas("orchestrator", m)),
);
const classicText = JSON.stringify(classic ?? {});
check("classic: whitepaper.json contract + FE/BE lane ownership survive", classicText.includes("whitepaper.json") && /LAYER OWNERSHIP \(HARD RULE\)/.test(classicText));

// --- template identity survives identical standard rosters -------------------
// All standard teams share one roster, so roster-shape matching can no longer
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
  ["researcher", { toolAllowlist: ["read_file", "list_dir", "grep", "glob", "browser"] }],
  ["solo_generalist", { toolAllowlist: ["all"] }],
  ["critic", { toolAllowlist: ["read_file", "shell"] }],
  ["publisher", { toolAllowlist: ["read_file", "shell", "write_file_with_diff"] }],
  // classic-studio bases
  ["operator", { toolAllowlist: ["read_file", "list_dir", "grep"] }],
  ["coder", { toolAllowlist: ["read_file", "write_file_with_diff", "shell"] }],
  ["documentation", { toolAllowlist: ["read_file", "write_file_with_diff", "shell"] }],
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
  // Solo mode keeps the Workflow lead's identity but swaps its runtime base to
  // solo_generalist. This preserves one conversation/model/memory identity.
  const solo = soloGeneralistForTeam(team);
  const lead = team.agents.find((agent) => agent.base === "orchestrator")
    ?? team.agents.find((agent) => agent.role === "leader")
    ?? team.agents[0];
  check(`${name}: Solo mode keeps lead identity with generalist power`,
    solo.name === lead?.name && solo.base === "solo_generalist" && solo.role === "agent");
}

console.log(`\nteamProfiles.verify: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
