#!/usr/bin/env node
// Regression guard for project-scoped rule-set profiles.
//
// What this pins:
//   • the three evidence-informed templates exist and say domain-specific things;
//   • the conflict-axis vocabulary is IDENTICAL in the TS catalogue and the Rust
//     resolver (drift there would make the preview lie about precedence);
//   • precedence is deterministic — agent layer over project layer, then
//     priority, then catalogue order, and never the caller's load order;
//   • combined sets decide each axis exactly once, and every loser is reported;
//   • a rule set is never visible, assignable or resolvable from another project;
//   • assignments persist on the project config, so they survive navigation and
//     restart, and pinning an old revision is honoured.
//
// The executable half runs the REAL templates from agentRuleSets.ts through the
// REAL resolver in personal_agent_rule_sets.rs, via ../../../src-tauri/rulesets-harness.
// There is only one precedence implementation; this gate proves the catalogue
// and the resolver agree on the same data.
//
// Run from owllm-desktop/:  node ui/src/pages/agentic/agentRuleSets.verify.run.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../../../..");                     // owllm-desktop
const ts = (await import(pathToFileURL(path.join(APP, "node_modules/typescript/lib/typescript.js")).href)).default;
const readLF = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
// A missing artifact is a FAILED CHECK, not a stack trace: run against a tree
// where the feature does not exist yet, this gate must still report what it
// wanted and why, one line per gap.
const missing = [];
const readOr = (p) => {
  try { return readLF(p); } catch { missing.push(path.relative(APP, p)); return ""; }
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rule-sets-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

function loadTs(rel) {
  const source = readOr(path.join(HERE, rel));
  if (!source) return null;
  const out = path.join(TMP, path.basename(rel).replace(/\.tsx?$/, ".cjs"));
  fs.writeFileSync(out, ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText);
  return import(pathToFileURL(out).href);
}

const safe = (fn, fallback) => { try { const value = fn(); return value ?? fallback; } catch { return fallback; } };

/// Stand-ins so a tree without the feature evaluates every assertion to false
/// instead of throwing on the first missing export. Real exports override these.
const EMPTY_SET = {
  id: "", revision: 0, templateId: "", name: "", summary: "",
  priority: 0, rules: [], projectId: "", private: false, status: "",
};
const CATALOGUE_STUB = {
  RULE_SET_TEMPLATE_LIST: [], RULE_SET_TEMPLATE_IDS: [], RULE_SET_TOPICS: [],
  ruleSetFromTemplate: () => EMPTY_SET,
  forkRuleSet: () => EMPTY_SET,
  emptyRuleSet: () => EMPTY_SET,
  ruleSetForSave: (doc) => doc,
  validateRuleSetDraft: () => [],
  assignableRuleSets: () => [EMPTY_SET],
  visibleRuleSets: () => [EMPTY_SET],
};

let pass = 0;
const fails = [];
const check = (name, cond) => { if (cond) pass++; else fails.push(name); };
const section = (s) => console.log(`\n${s}`);

const rs = { ...CATALOGUE_STUB, ...((await loadTs("agentRuleSets.ts")) ?? {}) };
const panel = readOr(path.join(HERE, "RuleSetsPanel.tsx"));
const dialog = readOr(path.join(HERE, "PersonalAgentsDialog.tsx"));
const config = readOr(path.join(HERE, "personalAgentConfig.ts"));
const core = readOr(path.join(APP, "src-tauri/src/personal_agent_rule_sets.rs"));
const backend = readOr(path.join(APP, "src-tauri/src/personal_agents.rs"));
const registry = readOr(path.join(APP, "src-tauri/src/lib.rs"));
for (const gap of missing) fails.push(`missing file: ${gap}`);

// ── 1) The three templates ───────────────────────────────────────────────────
section("1) three evidence-informed templates, one per domain");
const ids = rs.RULE_SET_TEMPLATE_LIST.map((t) => t.id);
check("software development, scientific research and social media are all offered",
  ["softwareDevelopment", "scientificResearch", "socialMedia"].every((id) => ids.includes(id)));
check("exactly three, with unique ids and a stable catalogue order",
  ids.length === 3 && new Set(ids).size === 3
  && JSON.stringify(ids) === JSON.stringify(rs.RULE_SET_TEMPLATE_IDS));
check("every template has an icon, label, hint, summary, priority and rules",
  rs.RULE_SET_TEMPLATE_LIST.every((t) =>
    t.icon.trim() && t.label.trim() && t.hint.trim() && t.summary.trim()
    && Number.isInteger(t.priority) && t.rules.length >= 5));
check("template priorities are distinct, so two untouched built-ins never tie",
  new Set(rs.RULE_SET_TEMPLATE_LIST.map((t) => t.priority)).size === 3);

const TEMPLATE_NAMES = ["softwareDevelopment", "scientificResearch", "socialMedia"];
const built = Object.fromEntries(TEMPLATE_NAMES.map((id) =>
  [id, safe(() => rs.ruleSetFromTemplate(id, "proj-a", "2026-01-01T00:00:00Z"), EMPTY_SET)]));
const bodyOf = (id) => built[id].rules.map((r) => `${r.title} ${r.body}`).join(" ");

check("software development demands a proven mechanism and a guarded regression",
  /prove the mechanism/i.test(bodyOf("softwareDevelopment"))
  && /fails against the previous code/i.test(bodyOf("softwareDevelopment"))
  && /smallest change/i.test(bodyOf("softwareDevelopment")));
check("software development bans embedded credentials",
  built.softwareDevelopment.rules.some((r) => r.topic === "secrets" && /never commit or ship/i.test(r.body)));
check("scientific research names the falsifier first and reports uncertainty",
  /falsif/i.test(bodyOf("scientificResearch"))
  && /effect size/i.test(bodyOf("scientificResearch"))
  && /absence of evidence/i.test(bodyOf("scientificResearch")));
check("scientific research validates the instrument before believing a null",
  built.scientificResearch.rules.some((r) => r.topic === "instrument" && /positive control|detect/i.test(r.body)));
check("scientific research requires negative results and reproducibility",
  ["negative-results", "reproducibility"].every((topic) =>
    built.scientificResearch.rules.some((r) => r.topic === topic)));
check("social media requires paid-partnership and synthetic-media disclosure",
  built.socialMedia.rules.some((r) => r.topic === "disclosure"
    && /paid, gifted or affiliate/i.test(r.body) && /AI-generated/i.test(r.body)));
check("social media forbids fabricated metrics, testimonials and endorsements",
  built.socialMedia.rules.some((r) => r.topic === "claims" && /never invent/i.test(r.title + r.body)));
check("social media covers per-platform format, cadence and pre-publish review",
  ["format", "cadence", "brand-safety"].every((topic) =>
    built.socialMedia.rules.some((r) => r.topic === topic)));
check("no template smuggles another template's rules in",
  TEMPLATE_NAMES.every((id) => built[id].rules.length > 0
    && TEMPLATE_NAMES.filter((other) => other !== id).every((other) =>
      !built[other].rules.some((r) => bodyOf(id).includes(r.body)))));

// ── 2) The shared conflict vocabulary ────────────────────────────────────────
section("2) the TS catalogue and the Rust resolver share one topic vocabulary");
const rustTopics = (/pub const RULE_SET_TOPICS: \[&str; \d+\] = \[([\s\S]*?)\];/.exec(core)?.[1] ?? "")
  .split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
check("RULE_SET_TOPICS is identical on both sides",
  JSON.stringify(rustTopics) === JSON.stringify([...rs.RULE_SET_TOPICS]));
check("the declared Rust array length matches its contents",
  new RegExp(`RULE_SET_TOPICS: \\[&str; ${rustTopics.length}\\]`).test(core));
const rustTemplates = (/pub const RULE_SET_TEMPLATE_IDS: \[&str; \d+\] = \[([\s\S]*?)\];/.exec(core)?.[1] ?? "")
  .split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
check("the template catalogue order is identical on both sides",
  JSON.stringify(rustTemplates) === JSON.stringify([...rs.RULE_SET_TEMPLATE_IDS]));
check("every topic a template uses is in the shared vocabulary",
  rustTopics.length > 0 && TEMPLATE_NAMES.every((id) => built[id].rules.length > 0
    && built[id].rules.every((r) => !r.topic || rs.RULE_SET_TOPICS.includes(r.topic))));
check("every topic-bearing rule takes a stance",
  TEMPLATE_NAMES.every((id) => built[id].rules.length > 0
    && built[id].rules.every((r) => !r.topic || r.stance.trim())));
check("the three templates genuinely disagree on sourcing and tone",
  ["sourcing", "tone"].every((topic) => {
    const stances = TEMPLATE_NAMES
      .map((id) => built[id].rules.find((r) => r.topic === topic)?.stance)
      .filter(Boolean);
    return stances.length === 3 && new Set(stances).size === 3;
  }));

// ── 3) Draft shape, versioning and forking ───────────────────────────────────
section("3) create, customise, version and fork");
check("a template draft is project-scoped, private and starts as a draft at r1",
  built.softwareDevelopment.projectId === "proj-a"
  && built.softwareDevelopment.private === true
  && built.softwareDevelopment.status === "draft"
  && built.softwareDevelopment.revision === 1);
check("every rule gets its own stable uuid-shaped id",
  built.socialMedia.rules.every((r) => /^rule:.+/.test(r.id))
  && new Set(built.socialMedia.rules.map((r) => r.id)).size === built.socialMedia.rules.length);
check("two drafts from the same template do not share ids",
  rs.ruleSetFromTemplate("socialMedia", "proj-a").id !== rs.ruleSetFromTemplate("socialMedia", "proj-a").id);
const fork = rs.forkRuleSet(built.scientificResearch, "proj-a");
check("a fork gets a new set id but keeps the parent's rule ids",
  fork.id !== built.scientificResearch.id
  && JSON.stringify(fork.rules.map((r) => r.id)) === JSON.stringify(built.scientificResearch.rules.map((r) => r.id)));
check("a fork drops to custom, restarts at revision 1 and reopens as a draft",
  fork.templateId === "custom" && fork.revision === 1 && fork.status === "draft");
check("validation rejects an unknown topic and a topic without a stance", (() => {
  const bad = { ...built.softwareDevelopment, rules: [
    { ...built.softwareDevelopment.rules[0], topic: "not-an-axis" },
    { ...built.softwareDevelopment.rules[1], stance: "  " },
  ] };
  const errors = rs.validateRuleSetDraft(bad);
  return errors.some((e) => /unknown conflict topic/.test(e)) && errors.some((e) => /takes no stance/.test(e));
})());
check("activating an empty set is refused",
  rs.validateRuleSetDraft({ ...rs.emptyRuleSet("proj-a"), status: "active" })
    .some((e) => /at least one rule/.test(e)));
check("a set without a project id is refused — there is no global tier",
  rs.validateRuleSetDraft(rs.ruleSetFromTemplate("socialMedia", ""))
    .some((e) => /project-scoped/.test(e)));
check("ruleSetForSave keeps it private and floors the priority",
  (() => { const saved = rs.ruleSetForSave({ ...built.socialMedia, private: false, priority: -4 });
    return saved.private === true && saved.priority === 0; })());

// ── 4) Nothing crosses a project boundary ────────────────────────────────────
section("4) rule sets never leak between projects");
const foreign = rs.ruleSetFromTemplate("socialMedia", "proj-b");
const activeIn = (set, project) => ({ ...set, status: "active", projectId: project });
check("assignableRuleSets offers only this project's active sets",
  rs.assignableRuleSets([activeIn(built.softwareDevelopment, "proj-a"), activeIn(foreign, "proj-b")], "proj-a")
    .map((s) => s.projectId).every((p) => p === "proj-a"));
check("a draft is not assignable until it is activated",
  rs.assignableRuleSets([built.softwareDevelopment], "proj-a").length === 0);
check("an empty project id offers nothing rather than everything",
  rs.assignableRuleSets([activeIn(built.softwareDevelopment, "proj-a")], "").length === 0
  && rs.visibleRuleSets([activeIn(built.softwareDevelopment, "proj-a")], "").length === 0);
check("the backend list command refuses an empty project id",
  /personal_agent_list_rule_sets[\s\S]{0,320}project_id\.trim\(\)\.is_empty\(\)[\s\S]{0,80}return Ok\(Vec::new\(\)\)/.test(backend));
check("the backend only ever loads the resolving project's own scope",
  /fn personal_agent_list_rule_sets[\s\S]{0,400}repo\.project_path\(&project_id\)/.test(backend)
  && !/rule_sets[\s\S]{0,40}global\.rule_sets/.test(backend));
check("the resolver filters candidates through visible_rule_sets before assigning",
  /let project_rule_sets = visible_rule_sets\(&project\.rule_sets, project_id\);[\s\S]{0,200}rule_set_assignments\(&project_rule_sets/.test(backend));
check("visible_rule_sets is a hard project filter in the core",
  /pub fn visible_rule_sets[\s\S]{0,400}doc\.project_id == project_id/.test(core));
check("the core refuses a foreign set instead of merging it",
  /belongs to project \{\} and cannot be assigned in \{\}/.test(core));
check("the per-agent layer lives on the project config, not on the global profile",
  /pub struct AgentProfileOverride[\s\S]{0,1400}pub rule_set_refs: Option<Vec<RevisionRef>>/.test(backend)
  && !/pub struct AgentProfileDoc[\s\S]*?\n\}/.exec(backend)?.[0].includes("rule_set_refs"));
check("the UI mirrors that: ruleSetRefs is on ProfileOverride and the project config only",
  /export type ProfileOverride[\s\S]{0,700}ruleSetRefs\?: RevisionRef\[\]/.test(config)
  && /export type ProjectAgentConfigDoc[\s\S]{0,400}ruleSetRefs: RevisionRef\[\]/.test(config)
  && !/export type AgentProfileDoc[\s\S]{0,700}ruleSetRefs/.test(config));
check("materialised set rules stay private and stamped with the project",
  /fn rule_set_rule_as_card[\s\S]{0,600}project_id: Some\(project_id\.to_string\(\)\)[\s\S]{0,120}private: true/.test(backend));

// ── 5) Persistence across navigation and restart ─────────────────────────────
section("5) assignment persists on the project config");
check("assignment writes to personal_agent_save_project_config immediately",
  /const assign = async[\s\S]{0,2200}invoke<ProjectAgentConfigDoc>\("personal_agent_save_project_config"/.test(panel));
check("assignments pin an id AND a revision",
  /const ref = \{ id: setId, revision: set\?\.revision \?\? 0 \}/.test(panel));
check("the panel re-reads sets and config from the backend whenever the project changes",
  /const load = useCallback\([\s\S]{0,700}personal_agent_list_rule_sets[\s\S]{0,300}personal_agent_get_project_config/.test(panel)
  && /useEffect\(\(\) => \{ void load\(\); \}, \[load\]\)/.test(panel));
check("the open draft is re-derived from stored state, never from stale component state",
  /setDraft\(found \? \{ \.\.\.found, rules: found\.rules\.map/.test(panel));
check("saving a set is append-only by revision in the backend",
  /fn save_rule_set_with[\s\S]{0,1400}doc\.revision = previous\.revision \+ 1/.test(backend));
check("a set's project id is immutable across revisions",
  /rule set projectId is immutable across revisions/.test(backend));
check("stale writes are rejected with a revision conflict",
  /rule set revision conflict at \{\}/.test(backend));
check("an older pinned revision stays resolvable — visible keeps every revision",
  /EVERY revision is kept/.test(core)
  && /pub fn latest_rule_sets/.test(core));
check("a dangling assignment is reported, not silently ignored",
  /missing pinned rule set \{id\}@\{revision\}/.test(core));

// ── 6) The preview cannot drift from the runtime ─────────────────────────────
section("6) one resolver, used by both the preview and the agent");
check("the panel previews through the backend command, not a local copy",
  /invoke<RuleSetResolution>\("personal_agent_preview_rule_sets"/.test(panel));
check("the preview command calls the same resolve_rule_set_stack the agent resolves with",
  /fn personal_agent_preview_rule_sets[\s\S]{0,1400}resolve_rule_set_stack\(&project_id, &assignments\)/.test(backend)
  && /fn resolve_with[\s\S]{0,20000}resolve_rule_set_stack\(project_id, &assignments\)/.test(backend));
check("agentRuleSets.ts does not reimplement precedence", (() => {
  const catalogue = readOr(path.join(HERE, "agentRuleSets.ts"));
  return !!catalogue && !/function\s+resolveRuleSetStack|precedenceKey|superseded\s*\.push/.test(catalogue);
})());
check("winning set rules reach the agent through the existing attachedRules path",
  /attached\.push\(rule_set_rule_as_card\(applied, project_id, set\)\)/.test(backend));
check("a rule card pinned directly still wins over the set's copy of the same id",
  /if already_attached\.contains\(&applied\.rule\.id\) \{[\s\S]{0,40}continue/.test(backend));
check("provenance records which set each injected rule came from",
  /ruleSets\.\{\}@\{\}[\s\S]{0,120}provenance\("rule-set"/.test(backend));
check("the four commands are registered with tauri",
  ["personal_agent_list_rule_sets", "personal_agent_get_rule_set",
   "personal_agent_save_rule_set", "personal_agent_preview_rule_sets"]
    .every((cmd) => registry.includes(`personal_agents::${cmd},`))
  && /^mod personal_agent_rule_sets;$/m.test(registry));

// ── 7) The panel is reachable and complete ───────────────────────────────────
section("7) the Rule sets tab exists and exposes every operation");
check("the dialog has a Rule sets tab that renders the panel",
  /\{nav\("rulesets", "Rule sets"\)\}/.test(dialog)
  && /tab === "rulesets" \? \([\s\S]{0,220}<RuleSetsPanel/.test(dialog)
  && /"rulesets"/.test(dialog.match(/type Tab = [^;]+;/)?.[0] ?? ""));
check("the panel offers all three templates plus an empty set",
  /RULE_SET_TEMPLATE_LIST\.map/.test(panel) && /\+ Empty rule set/.test(panel));
check("the panel can customise rules, fork, and save a new revision",
  /\+ Add rule/.test(panel) && /Fork as new set/.test(panel)
  && /Save \{persisted \? `as revision \$\{draft\.revision \+ 1\}`/.test(panel));
check("both assignment layers are offered, with the agent layer gated on a chosen agent",
  /assign\("project", set\.id/.test(panel) && /assign\("agent", set\.id/.test(panel)
  && /disabled=\{busy \|\| !config \|\| !agentId\}/.test(panel));
check("superseded rules are rendered rather than silently dropped",
  /Superseded — kept visible, never silently dropped/.test(panel));
check("draft validation errors are surfaced and block the save",
  /disabled=\{busy \|\| draftErrors\.length > 0\}/.test(panel));

// ── 8) The executed proof ────────────────────────────────────────────────────
section("8) executed against the real resolver");
const manifest = path.join(APP, "src-tauri/rulesets-harness/Cargo.toml");
// --manifest-path must stay on cargo's side of the `--` separator, otherwise it
// is handed to the harness binary and cargo looks for a manifest in the cwd.
const cargo = (args, binArgs = []) => spawnSync(
  "cargo",
  [...args, "--manifest-path", manifest, ...(binArgs.length ? ["--", ...binArgs] : [])],
  { encoding: "utf8", shell: process.platform === "win32" },
);

const harness = readOr(path.join(APP, "src-tauri/rulesets-harness/src/main.rs"));
if (!harness) fails.push("missing file: src-tauri/rulesets-harness/src/main.rs");
check("the harness compiles the exact core module the app ships",
  harness.includes('#[path = "../../src/personal_agent_rule_sets.rs"]'));
for (const scenario of [
  "control_pre_fix_behaviour_reproduces_the_bug",
  "project_and_agent_layers_compose",
  "an_agent_without_its_own_assignment_gets_the_project_stack",
  "three_templates_combine_with_one_winner_per_topic",
  "restart_reloads_the_same_stack",
  "a_second_project_sees_none_of_it",
  "pinning_an_older_revision_keeps_the_old_rules",
  "unassigning_removes_the_rules_and_survives_restart",
  "a_fork_of_a_template_dedupes_instead_of_double_counting",
  "an_invalid_set_is_reported_not_silently_accepted",
]) {
  check(`harness scenario missing: ${scenario}`, harness.includes(`fn ${scenario}`));
}

const probe = cargo(["run", "--quiet"]);
if (probe.error && probe.error.code === "ENOENT") {
  fails.push("cargo is not on PATH — the executed rule-set proof cannot run");
} else {
  const out = `${probe.stdout || ""}${probe.stderr || ""}`;
  if (probe.status !== 0) {
    fails.push(`rulesets-harness scenarios failed:\n${out.trim()}`);
  } else {
    pass += (out.match(/^PASS /gm) || []).length;
    console.log(out.trim());
  }
  const units = cargo(["test", "--quiet"]);
  const unitOut = `${units.stdout || ""}${units.stderr || ""}`;
  if (units.status !== 0) {
    fails.push(`personal_agent_rule_sets unit tests failed:\n${unitOut.trim()}`);
  } else {
    pass += Number(/(\d+) passed/.exec(unitOut)?.[1] ?? 0);
    console.log(unitOut.trim().split("\n").slice(-1)[0]);
  }

  // The real templates, through the real resolver. This is the check that the
  // catalogue and the precedence engine agree — not just that each works alone.
  section("9) the REAL templates through the REAL resolver");
  const active = (id, layer) => ({ ...built[id], status: "active" });
  const requestPath = path.join(TMP, "resolve.json");
  const resolve = (agent, project) => {
    fs.writeFileSync(requestPath, JSON.stringify({
      projectId: "proj-a",
      agent: agent.map((id) => active(id)),
      project: project.map((id) => active(id)),
    }));
    const run = cargo(["run", "--quiet"], ["--resolve", requestPath]);
    if (run.status !== 0) {
      fails.push(`resolve failed:\n${(run.stdout || "") + (run.stderr || "")}`);
      return null;
    }
    return JSON.parse(run.stdout.trim().split("\n").pop());
  };

  const all = resolve([], ["softwareDevelopment", "scientificResearch", "socialMedia"]);
  if (all) {
    const topicsOf = (r) => r.applied.filter((e) => e.rule.topic).map((e) => e.rule.topic);
    check("all three templates together decide every axis exactly once",
      topicsOf(all).length === new Set(topicsOf(all)).size);
    check("priority order puts software development first, then research, then social",
      JSON.stringify(all.sets.map((s) => s.templateId))
        === JSON.stringify(["softwareDevelopment", "scientificResearch", "socialMedia"]));
    check("the contested axes resolve to the highest-precedence set",
      all.applied.find((e) => e.rule.topic === "tone")?.rule.stance === "plain-technical"
      && all.applied.find((e) => e.rule.topic === "sourcing")?.rule.stance === "cite-code-locations");
    check("the four losing rules on those two axes are reported as conflicts, not dropped",
      all.superseded.length === 4
      && all.superseded.every((s) => s.reason === "conflict" && s.winningSetId && s.explanation));
    check("uncontested domain rules from every template still apply",
      ["secrets", "hypothesis", "disclosure", "cadence"].every((topic) =>
        all.applied.some((e) => e.rule.topic === topic)));
    check("no rule text is duplicated in the resolved stack",
      new Set(all.applied.map((e) => e.rule.id)).size === all.applied.length);
    check("resolving reports no errors for a legitimate three-template stack",
      all.errors.length === 0);
  }

  const agentWins = resolve(["socialMedia"], ["softwareDevelopment"]);
  if (agentWins) {
    check("an agent-layer set overrides the project layer on a shared axis",
      agentWins.sets[0].layer === "agent"
      && agentWins.applied.find((e) => e.rule.topic === "tone")?.rule.stance === "hook-led-conversational");
    check("the project layer still contributes its uncontested rules",
      agentWins.applied.some((e) => e.rule.topic === "secrets"));
  }

  // Load order must not change the outcome.
  const forward = resolve([], ["scientificResearch", "socialMedia"]);
  const reverse = resolve([], ["socialMedia", "scientificResearch"]);
  if (forward && reverse) {
    check("the order sets are listed in never changes the resolved stack",
      JSON.stringify(forward) === JSON.stringify(reverse));
  }
}

// ── 10) The real panel in jsdom ──────────────────────────────────────────────
section("10) the real RuleSetsPanel, mounted, against an in-memory backend");
await mountedPanelChecks();

async function mountedPanelChecks() {
  const req = createRequire(path.join(APP, "package.json"));
  let JSDOM;
  try { ({ JSDOM } = req("jsdom")); } catch {
    fails.push("jsdom is required for the mounted-panel section (npm i --no-save jsdom)");
    return;
  }
  if (!panel) { fails.push("RuleSetsPanel.tsx is missing — cannot mount it"); return; }

  const dom = new JSDOM("<!doctype html><html><body></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.Event = dom.window.Event;
  globalThis.getComputedStyle = dom.window.getComputedStyle;

  const SANDBOX = path.join(TMP, "panel");
  fs.mkdirSync(path.join(SANDBOX, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(SANDBOX, "package.json"), "{}");
  for (const m of ["react", "react-dom", "scheduler"]) {
    fs.cpSync(path.join(APP, "node_modules", m), path.join(SANDBOX, "node_modules", m), { recursive: true });
  }
  const toCjs = (file) => ts.transpileModule(readOr(path.join(HERE, file)), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    },
  }).outputText;

  // The catalogue and the config helpers are the REAL modules — the point of the
  // mount is that the panel and agentRuleSets.ts agree in a browser, not in a grep.
  fs.writeFileSync(path.join(SANDBOX, "agentRuleSets.js"), toCjs("agentRuleSets.ts"));
  fs.writeFileSync(path.join(SANDBOX, "personalAgentConfig.js"), toCjs("personalAgentConfig.ts"));

  // A minimal stand-in for the personal-agent repository: one store per project,
  // append-only by revision, exactly like save_rule_set_with / save_project_with.
  fs.writeFileSync(path.join(SANDBOX, "stubs.js"), `
    const stores = {};
    const scope = (projectId) => (stores[projectId] ||= { sets: [], config: null });
    const calls = [];
    module.exports = {
      __esModule: true,
      __stores: stores,
      __calls: calls,
      invoke: async (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === "personal_agent_list_rule_sets") {
          return scope(args.projectId).sets.map((s) => ({ ...s }));
        }
        if (cmd === "personal_agent_get_project_config") {
          return scope(args.projectId).config;
        }
        if (cmd === "personal_agent_save_rule_set") {
          const store = scope(args.doc.projectId);
          const previous = store.sets.find((s) => s.id === args.doc.id);
          const saved = { ...args.doc, revision: previous ? previous.revision + 1 : 1 };
          store.sets = [...store.sets.filter((s) => s.id !== saved.id), saved];
          return saved;
        }
        if (cmd === "personal_agent_save_project_config") {
          const store = scope(args.doc.projectId);
          const saved = { ...args.doc, revision: (store.config?.revision ?? 0) + 1 };
          store.config = saved;
          return saved;
        }
        if (cmd === "personal_agent_preview_rule_sets") {
          return { sets: [], applied: [], superseded: [], errors: [] };
        }
        throw new Error("unexpected command " + cmd);
      },
    };
  `);

  fs.writeFileSync(path.join(SANDBOX, "RuleSetsPanel.js"), toCjs("RuleSetsPanel.tsx")
    .replace(/require\("\.\/agentRuleSets"\)/g, 'require("./agentRuleSets.js")')
    .replace(/require\("\.\/personalAgentConfig"\)/g, 'require("./personalAgentConfig.js")')
    .replace(/require\("@tauri-apps\/api\/core"\)/g, 'require("./stubs.js")'));

  const reqBox = createRequire(path.join(SANDBOX, "RuleSetsPanel.js"));
  const React = reqBox("react");
  const { act } = reqBox("react");
  const { createRoot } = reqBox("react-dom/client");
  const Panel = reqBox("./RuleSetsPanel.js").default;
  const stubs = reqBox("./stubs.js");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const PID = "verify-rule-sets";
  const props = {
    projectId: PID,
    onProjectIdChange: () => {},
    profiles: [{ id: "agent:alice", displayName: "Alice", revision: 1 }],
  };
  let host = null;
  let root = null;
  const mount = async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root.render(React.createElement(Panel, props)); });
    await act(async () => {});
  };
  const unmount = async () => {
    await act(async () => { root.unmount(); });
    host.remove();
  };
  const texts = (sel) => [...host.querySelectorAll(sel)].map((n) => n.textContent);
  const buttonWith = (needle) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent.includes(needle));
  const click = async (node) => {
    await act(async () => { node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    await act(async () => {});
  };
  // node.click() runs jsdom's real activation behaviour, so the checkbox toggles
  // natively and React's value tracker sees the change. Assigning .checked by
  // hand bypasses that tracker and React silently skips onChange.
  const setChecked = async (node, value) => {
    if (node.checked === value) return;
    await act(async () => { node.click(); });
    await act(async () => {});
  };

  try {
    await mount();
    check("the mounted panel renders and offers all three templates",
      !!host.querySelector('[data-ui="ruleSetsPanel"]')
      && ["Software development", "Scientific research", "Social media"]
        .every((name) => !!buttonWith(name)));

    // Create the software-development set, activate it, save it.
    await click(buttonWith("Software development"));
    const statusSelect = [...host.querySelectorAll("select")]
      .find((s) => [...s.options].some((o) => o.value === "active"));
    check("a template draft opens in the editor with its rules",
      !!statusSelect && host.querySelectorAll("textarea").length > 5);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value").set;
      setter.call(statusSelect, "active");
      statusSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    // "persisted" must come from what the backend returned, not from the local
    // list — an unsaved draft that reads as persisted sends an expectedRevision
    // the backend correctly rejects, so its first save can never succeed.
    check("an unsaved draft offers a first save, not a revision bump",
      !!buttonWith("Save new rule set") && !buttonWith("Save as revision"));
    await click(buttonWith("Save new rule set"));
    check("saving persists the set into this project's store at revision 1",
      stubs.__stores[PID]?.sets.length === 1 && stubs.__stores[PID].sets[0].revision === 1
      && stubs.__stores[PID].sets[0].projectId === PID);
    check("nothing was written to any other project's store",
      Object.keys(stubs.__stores).filter((id) => stubs.__stores[id].sets.length).length === 1);
    check("the status control actually activates the set that gets saved",
      stubs.__stores[PID]?.sets[0]?.status === "active");
    check("the first save went out WITHOUT an expectedRevision",
      stubs.__calls.filter(([cmd]) => cmd === "personal_agent_save_rule_set")
        .every(([, args]) => args.expectedRevision === undefined));
    check("once saved, the button offers the next revision instead",
      !!buttonWith("Save as revision 2"));

    // Assign it at the project layer.
    const projectBoxes = [...host.querySelectorAll("input[type=checkbox]")];
    check("an active set becomes assignable at both layers",
      projectBoxes.length >= 2);
    await setChecked(projectBoxes[0], true);
    check("ticking Project writes the assignment straight to the project config",
      stubs.__stores[PID]?.config?.ruleSetRefs?.length === 1
      && stubs.__stores[PID].config.ruleSetRefs[0].revision === 1);
    check("the per-agent checkbox is disabled until an agent is chosen",
      projectBoxes[1].disabled === true);

    // Navigate away and back: the tick must come from the store, not from state.
    await unmount();
    await mount();
    const afterRemount = [...host.querySelectorAll("input[type=checkbox]")];
    check("the assignment is still ticked after a full unmount and remount",
      afterRemount[0]?.checked === true);
    check("the set list shows it as assigned at the project layer",
      texts("button").some((t) => t.includes("· project")));

    // Preview must go to the backend with the two layers separated.
    stubs.__calls.length = 0;
    await click(buttonWith("Resolve preview"));
    const previewCall = stubs.__calls.find(([cmd]) => cmd === "personal_agent_preview_rule_sets");
    check("Resolve preview calls the backend resolver with both layers and the project id",
      !!previewCall && previewCall[1].projectId === PID
      && Array.isArray(previewCall[1].agentRuleSets)
      && previewCall[1].projectRuleSets.length === 1);

    // Unassign, remount: it must stay unassigned.
    await setChecked([...host.querySelectorAll("input[type=checkbox]")][0], false);
    check("unticking removes the assignment but keeps the set itself",
      stubs.__stores[PID].config.ruleSetRefs.length === 0
      && stubs.__stores[PID].sets.length === 1);
    await unmount();
    await mount();
    check("the removal also survives a remount",
      [...host.querySelectorAll("input[type=checkbox]")][0]?.checked === false);
    await unmount();
  } catch (error) {
    fails.push(`mounted RuleSetsPanel threw: ${String(error?.stack || error)}`);
  }
}

// ---------------------------------------------------------------------------
if (fails.length) {
  console.error(`\nFAIL rule sets: ${fails.length} problem(s), ${pass} passed`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nPASS rule sets: ${pass} checks (catalogue + source contract + executed resolver)`);
