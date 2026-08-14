// Verify script (repo pattern — see modelPickerCollapse.verify.run.mjs):
// proves the bridge dispatch path's prompt builders actually inject the
// SKILL block after the fix (dispatch.ts previously hardcoded `undefined`
// for specialists and had no skill param on the orchestrator builder).
//
// Run from ui/:  node src/pages/agentic/dispatchSkillBlock.verify.run.mjs
// (bundles dispatch.ts with esbuild, stubbing the Tauri runtime).

import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const stubPlugin = {
  name: "stub-tauri",
  setup(b) {
    b.onResolve({ filter: /^@tauri-apps\// }, (args) => ({
      path: args.path,
      namespace: "tauri-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "tauri-stub" }, () => ({
      contents: `
        export const invoke = async () => { throw new Error("no tauri in verify"); };
        export class Channel { set onmessage(_) {} }
        export const listen = async () => () => {};
        export default {};
      `,
      loader: "js",
    }));
  },
};

const outDir = mkdtempSync(path.join(tmpdir(), "dispatch-verify-"));
const outFile = path.join(outDir, "dispatch.bundle.mjs");

await build({
  entryPoints: [new URL("./dispatch.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: outFile,
  plugins: [stubPlugin],
  jsx: "automatic",
  logLevel: "silent",
});

// Browser globals some transitive modules expect at call time.
globalThis.window = globalThis.window ?? globalThis;
globalThis.localStorage = globalThis.localStorage ?? {
  getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0, clear: () => {},
};
if (!globalThis.navigator) {
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "verify" }, configurable: true });
}

const mod = await import(pathToFileURL(outFile).href);
const { buildOrchestratorPrompt, buildSpecialistPrompt } = mod;

const roleByName = new Map([
  ["orchestrator", { id: "orchestrator", name: "orchestrator", systemPrompt: "Plan the work.", defaultTemperature: 0.3, skillAllowlist: [] }],
  ["coder", { id: "coder", name: "coder", systemPrompt: "You are the Coder.", defaultTemperature: 0.2, skillAllowlist: [] }],
]);
const team = {
  id: "t1", display: "Verify Team",
  agents: [
    { name: "orchestrator", base: "orchestrator", description: "plans" },
    { name: "coder", base: "coder", description: "codes" },
  ],
};
const orch = team.agents[0];
const spec = team.agents[1];

const SKILL_MARKER = "--- YOUR SKILLS (capability packs available to you — use them when relevant) ---\n### Skill: verify-skill\nVERIFY_SKILL_BODY_MARKER";

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? (pass++, console.log("ok  ", name)) : (fail++, console.log("FAIL", name)); };

// Orchestrator builder: new trailing skillBlock param is injected verbatim.
const withBlock = buildOrchestratorPrompt(team, roleByName, orch, undefined, false, "", null, SKILL_MARKER);
check("orchestrator prompt contains the skill block", withBlock.includes("VERIFY_SKILL_BODY_MARKER"));
check("orchestrator skill block precedes the roster", withBlock.indexOf("VERIFY_SKILL_BODY_MARKER") < withBlock.indexOf("YOUR SPECIALISTS"));

// Omitting it (old call shape) stays clean — no "undefined", no marker.
const without = buildOrchestratorPrompt(team, roleByName, orch, undefined, false, "", null);
check("orchestrator prompt w/o block has no marker", !without.includes("VERIFY_SKILL_BODY_MARKER"));
check("orchestrator prompt w/o block has no stray 'undefined' line", !/^undefined$/m.test(without));

// Specialist builder: skillBlock param (5th) is injected.
const specWith = buildSpecialistPrompt(team, spec, roleByName, undefined, SKILL_MARKER, null, true);
check("specialist prompt contains the skill block", specWith.includes("VERIFY_SKILL_BODY_MARKER"));

const specWithout = buildSpecialistPrompt(team, spec, roleByName, undefined, undefined, null, true);
check("specialist prompt w/o block has no marker", !specWithout.includes("VERIFY_SKILL_BODY_MARKER"));
check("specialist role prompt still present", specWithout.includes("You are the Coder."));

// Empty/whitespace block is dropped, not injected as blank section.
const specBlank = buildSpecialistPrompt(team, spec, roleByName, undefined, "   ", null, true);
check("whitespace-only block is not injected", !specBlank.includes("--- YOUR SKILLS"));

// ── Skill redundancy + staging spam (2026-08-14 audit) ──────────────────────
// The parallel-dispatch pack used to be injected TWICE into one orchestrator
// prompt (its own PARALLEL DISPATCH section AND again via the skill block when
// equipped or auto-selected by goal keywords); and the "🧩 N skills staged"
// notice printed on EVERY send (81× in one project chat).
{
  const { readFileSync } = await import("node:fs");
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const skillRuntime = readFileSync(path.join(here, "skillRuntime.ts"), "utf8");
  const agentsPage = readFileSync(path.join(here, "AgentsPage.tsx"), "utf8");
  check("buildSoloSkillBlock supports a dedicated-section exclude list",
    /excludeIds: string\[\] = \[\]/.test(skillRuntime)
      && skillRuntime.includes(".filter(id => !excluded.has(id))"));
  check("the exclusion covers auto-selected ids too, not just equipped ones",
    (skillRuntime.match(/\.filter\(id => !excluded\.has\(id\)\)/g) || []).length >= 2);
  check("parallel mode keeps the parallel-dispatch pack out of the skill block",
    agentsPage.includes('parallelMode ? ["owllm__parallel-dispatch"] : []'));
  check("skill staging announces only when the outcome CHANGES",
    agentsPage.includes("skillSyncAnnouncedRef")
      && (agentsPage.match(/announced\.get\(effectiveRunCwd\) !== outcome/g) || []).length >= 2);
}

// ── Card skills picker (2026-08-14): deny-aware per-agent grant ─────────────
// The tile's skill ribbon opens a 4-column picker; toggles ride the project
// grant, where "-id" entries DENY a role/template skill. One resolver
// (resolveEquippedSkillIds) backs the badge, the picker AND every dispatch
// injection site — executed here, not just grepped.
{
  const { readFileSync } = await import("node:fs");
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const agentsPage = readFileSync(path.join(here, "AgentsPage.tsx"), "utf8");

  const srOut = path.join(outDir, "skillRuntime.bundle.mjs");
  await build({
    entryPoints: [new URL("./skillRuntime.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
    bundle: true, format: "esm", platform: "node", outfile: srOut,
    plugins: [stubPlugin], logLevel: "silent",
  });
  const sr = await import(pathToFileURL(srOut).href);
  const { resolveEquippedSkillIds, toggleSkillGrant } = sr;

  // Guard so a missing export FAILS the executed checks instead of crashing
  // the whole gate (a crash on old sources is a weak instrument).
  const helpersExist = typeof resolveEquippedSkillIds === "function" && typeof toggleSkillGrant === "function";
  check("skillRuntime exports the deny-aware grant helpers", helpersExist);
  if (helpersExist) {
    check("legacy additive grants keep their exact meaning",
      JSON.stringify(resolveEquippedSkillIds(["a"], ["x"])) === '["a","x"]');
    let g = toggleSkillGrant([], ["a", "b"], "a");
    check("unequipping a role skill writes a deny entry", JSON.stringify(g) === '["-a"]');
    check("denied role skill is no longer equipped",
      !resolveEquippedSkillIds(["a", "b"], g).includes("a")
        && resolveEquippedSkillIds(["a", "b"], g).includes("b"));
    g = toggleSkillGrant(g, ["a", "b"], "a");
    check("re-equipping a role skill just clears the deny (no debris)", g.length === 0);
    g = toggleSkillGrant(g, ["a", "b"], "c");
    check("equipping an extra skill appends a grant", JSON.stringify(g) === '["c"]');
    g = toggleSkillGrant(g, ["a", "b"], "c");
    check("unequipping a granted extra removes it (no deny debris)", g.length === 0);
  } else {
    for (const name of [
      "legacy additive grants keep their exact meaning",
      "unequipping a role skill writes a deny entry",
      "denied role skill is no longer equipped",
      "re-equipping a role skill just clears the deny (no debris)",
      "equipping an extra skill appends a grant",
      "unequipping a granted extra removes it (no deny debris)",
    ]) check(name, false);
  }

  check("card badge shares the ONE resolver with dispatch",
    agentsPage.includes("resolveEquippedSkillIds(baseAgentSkillIds(a, roleByName)"));
  check("specialist injection uses the deny-aware resolver",
    agentsPage.includes("const skillIds = resolveAgentSkillIds(spec, roleByName, perAgentSkills)"));
  check("orchestrator injection uses the deny-aware resolver",
    agentsPage.includes("const orchSkillIds = resolveAgentSkillIds(orch, roleByName, perAgentSkills)"));
  check("solo + doc lanes use the deny-aware resolver",
    agentsPage.includes("const sIds = resolveAgentSkillIds(coder, roleByName, perAgentSkills)")
      && agentsPage.includes("const docSkillIds = resolveAgentSkillIds(docSpec, roleByName, perAgentSkills)"));
  check("skill ribbon click opens the picker popup",
    agentsPage.includes("onClick={(e) => { e.stopPropagation(); onOpenSkills(); }}")
      && agentsPage.includes('data-ui="AgentSkillsModal"'));
  check("picker lays the skills out in 4 overflow-proof columns",
    // minmax(0,1fr): plain 1fr lets nowrap titles force the grid wider than
    // the modal — the 4th column rendered clipped behind a horizontal scrollbar.
    agentsPage.includes('gridTemplateColumns: "repeat(4, minmax(0, 1fr))"')
      && !agentsPage.includes('gridTemplateColumns: "repeat(4, 1fr)"'));
  check("each picker cell carries the skill icon + short description",
    /skillIcon\(p\.id\)/.test(agentsPage)
      && agentsPage.includes('{p.description || "(no description)"}'));
  check("a picker toggle rides the per-project grant (toggleSkillGrant)",
    agentsPage.includes("toggleSkillGrant(prev.get(agentName), baseIds, skillId)"));
  check("old hover-only skill list is gone (one control per setting)",
    !agentsPage.includes("showSkills"));
  check("ribbon renders even with zero skills so the picker stays reachable",
    agentsPage.includes("No skills equipped — click to add"));

  // ── Picker presentation (2026-08-15): dedup, search, sections, real names ──
  const { organizeSkillPacks, prettySkillName, skillPackLabel, skillPackSource } = sr;
  const presenterExists = typeof organizeSkillPacks === "function"
    && typeof prettySkillName === "function" && typeof skillPackLabel === "function";
  check("skillRuntime exports the picker presentation helpers", presenterExists);
  if (presenterExists) {
    const P = (id, name, description = "", ctx_estimate = 100) => ({ id, name, description, ctx_estimate });
    // Same pack surfaced from two skills homes → ONE card (first home wins).
    const dup = organizeSkillPacks([P("pdf", "pdf"), P("pdf", "pdf"), P("art", "art")], []);
    check("picker dedups same-id packs from multiple homes",
      dup.available.length === 2 && dup.equipped.length === 0);
    // Equipped packs split into their own section; both sections label-sorted.
    const org = organizeSkillPacks(
      [P("zeta", "zeta"), P("alpha", "alpha"), P("mid", "mid")], ["mid"]);
    check("equipped packs get their own section",
      org.equipped.length === 1 && org.equipped[0].id === "mid");
    check("sections are sorted by display label",
      org.available.map(p => p.id).join(",") === "alpha,zeta");
    // Search matches name AND description, case-insensitive.
    const found = organizeSkillPacks(
      [P("a", "a", "slide decks"), P("b", "b", "spreadsheets")], [], "SLIDE");
    check("search filters by name/description case-insensitively",
      found.available.length === 1 && found.available[0].id === "a");
    check("acronym slugs render as real names (PDF, MCP Builder)",
      prettySkillName("anthropics__pdf") === "PDF"
        && prettySkillName("mcp-builder") === "MCP Builder");
    check("frontmatter display names win over slug prettifying",
      skillPackLabel({ id: "x", name: "Brand Guidelines" }) === "Brand Guidelines"
        && skillPackLabel({ id: "algorithmic-art", name: "algorithmic-art" }) === "Algorithmic Art");
    check("namespace chip derives from the id prefix",
      skillPackSource("anthropics__pdf") === "anthropics" && skillPackSource("code-review") === null);
  } else {
    for (const name of [
      "picker dedups same-id packs from multiple homes",
      "equipped packs get their own section",
      "sections are sorted by display label",
      "search filters by name/description case-insensitively",
      "acronym slugs render as real names (PDF, MCP Builder)",
      "frontmatter display names win over slug prettifying",
      "namespace chip derives from the id prefix",
    ]) check(name, false);
  }
  check("picker renders the pure organizer (search + sections wired)",
    agentsPage.includes("organizeSkillPacks(packs, equipped, query)")
      && agentsPage.includes("Search skills by name or description"));

  // Rust side of the duplicate fix: list_skill_packs dedups by id, and the
  // homes are enumerated user → legacy → bundled so a user-installed/edited
  // pack shadows the read-only bundled copy (writes always target the user
  // home — seeding promises never to clobber a customization).
  const agentsRs = readFileSync(path.join(here, "..", "..", "..", "..", "src-tauri", "src", "agents.rs"), "utf8");
  const pathsRs = readFileSync(path.join(here, "..", "..", "..", "..", "src-tauri", "src", "paths.rs"), "utf8");
  const lsp = agentsRs.slice(agentsRs.indexOf("pub async fn list_skill_packs"));
  check("Rust list_skill_packs dedups same-id packs across homes",
    lsp.slice(0, lsp.indexOf("\n}")).includes("seen.insert(id.clone())"));
  const sdr = pathsRs.slice(pathsRs.indexOf("pub fn skills_dirs_read"));
  const sdrBody = sdr.slice(0, sdr.indexOf("\n}"));
  check("skills homes enumerate user-first so user packs shadow bundled",
    sdrBody.indexOf("skills_dir()") !== -1
      && sdrBody.indexOf("resources_root()") !== -1
      && sdrBody.indexOf("skills_dir()") < sdrBody.indexOf("resources_root()"));
}

console.log(fail === 0 ? `\nall ${pass} checks passed` : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
