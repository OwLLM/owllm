#!/usr/bin/env node
// Regression guard for rule-set PROVENANCE — the citations, review dates,
// limitations and template versions behind every built-in rule.
//
// The sibling gate (agentRuleSets.verify.run.mjs) proves the rules resolve
// correctly. This one proves they are HONEST about where they come from:
//
//   • every built-in rule states why it exists and what its source does not say;
//   • every citation is checkable — publisher, edition date, review date, the
//     scope it actually binds, and a URL;
//   • a rule with no external authority SAYS SO instead of borrowing a nearby
//     citation, and the UI renders that state differently;
//   • citations stay in their domain: no US advertising rule backing an
//     engineering rule, no software blog backing a scientific-integrity rule;
//   • editing a rule's position DROPS its citation, because the source backed
//     the original position;
//   • provenance never becomes prompt payload, never widens what one project can
//     see, and never changes which rule wins a conflict;
//   • sets stored before templateVersion existed migrate without claiming an
//     edition they no longer match;
//   • with no rule set assigned, the fallback is stated rather than silent.
//
// The executable half runs the REAL catalogue through the REAL Rust resolver
// (src-tauri/rulesets-harness) and mounts the REAL panel in jsdom.
//
// Run from owllm-desktop/:  node ui/src/pages/agentic/ruleSetProvenance.verify.run.mjs
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
// where provenance does not exist yet, this gate must still report every gap.
const missing = [];
const readOr = (p) => {
  try { return readLF(p); } catch { missing.push(path.relative(APP, p)); return ""; }
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rule-provenance-"));
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

/// Stand-ins so a tree without provenance evaluates every assertion to false
/// instead of throwing on the first missing export.
const STUB = {
  RULE_SET_PROVENANCE_REVIEWED_AT: "",
  RULE_SET_SOURCES: {},
  RULE_SET_TEMPLATE_PROVENANCE: {},
  RULE_PROVENANCE: {},
  RULE_SET_TEMPLATE_LIST: [],
  RULE_SET_TEMPLATE_IDS: [],
  provenanceKeyOf: () => "",
  provenanceForRule: () => null,
  citationsFor: () => [],
  templateProvenanceOf: () => null,
  templateCitationsOf: () => [],
  templateEditionOf: () => 0,
  migrateRuleSetDoc: (doc) => doc,
  ruleSetFromTemplate: () => ({ rules: [], templateId: "", templateVersion: 0 }),
  forkRuleSet: (doc) => doc,
  emptyRuleSet: () => ({ rules: [], templateId: "custom", templateVersion: 0 }),
  ruleSetForSave: (doc) => doc,
};

let pass = 0;
const fails = [];
const check = (name, cond) => { if (cond) pass++; else fails.push(name); };
const section = (s) => console.log(`\n${s}`);

const rs = { ...STUB, ...((await loadTs("agentRuleSets.ts")) ?? {}) };
const panel = readOr(path.join(HERE, "RuleSetsPanel.tsx"));
const rust = readOr(path.join(APP, "src-tauri/src/personal_agent_rule_sets.rs"));
const doc = readOr(path.join(APP, "docs/RULE_SET_PROVENANCE.md"));
for (const file of missing) fails.push(`missing file: ${file}`);

const TEMPLATE_IDS = rs.RULE_SET_TEMPLATE_IDS.length
  ? rs.RULE_SET_TEMPLATE_IDS
  : ["softwareDevelopment", "scientificResearch", "socialMedia"];
const built = Object.fromEntries(TEMPLATE_IDS.map((id) =>
  [id, rs.ruleSetFromTemplate(id, "proj-a", "2026-01-01T00:00:00Z")]));
const allBuiltRules = TEMPLATE_IDS.flatMap((id) => built[id].rules ?? []);

// ── 1) every built-in rule is accounted for ─────────────────────────────────
section("1) every built-in rule states its rationale, sources and limitation");

check("the catalogue produced rules to check at all", allBuiltRules.length >= 21);
check("a review date for the whole catalogue is recorded",
  /^\d{4}-\d{2}-\d{2}$/.test(rs.RULE_SET_PROVENANCE_REVIEWED_AT));

for (const id of TEMPLATE_IDS) {
  for (const rule of built[id].rules ?? []) {
    const p = rs.provenanceForRule(rule);
    check(`${id}/${rule.topic}: has provenance`, !!p);
    if (!p) continue;
    check(`${id}/${rule.topic}: rationale is a real sentence, not a restatement of the rule`,
      typeof p.rationale === "string" && p.rationale.trim().length >= 60
      && p.rationale.trim() !== (rule.body ?? "").trim());
    check(`${id}/${rule.topic}: records a limitation`,
      typeof p.limitation === "string" && p.limitation.trim().length >= 60);
    check(`${id}/${rule.topic}: every cited id resolves to a real citation`,
      Array.isArray(p.sources)
      && p.sources.every((sid) => !!rs.RULE_SET_SOURCES[sid])
      && rs.citationsFor(p).length === p.sources.length);
  }
}

// Padding a rule with weak citations to look rigorous is the exact failure this
// module exists to prevent, so uncited rules are EXPECTED — but they must be
// uncited on purpose, and their limitation must say whose judgement they are.
const uncited = allBuiltRules.filter((r) => (rs.provenanceForRule(r)?.sources ?? []).length === 0);
check("uncited rules exist and are labelled as OWLLM practice rather than left ambiguous",
  uncited.length > 0 && uncited.every((r) => {
    const p = rs.provenanceForRule(r);
    return p && /no (cited |external )?(authority|source)/i.test(p.limitation);
  }));
check("uncited rules are the minority — most built-in rules carry a real citation",
  uncited.length < allBuiltRules.length / 2);

// ── 2) citations are checkable ──────────────────────────────────────────────
section("2) every citation is checkable and dated");

const SOURCES = Object.values(rs.RULE_SET_SOURCES);
check("the source pool is populated", SOURCES.length >= 15);
check("every source id matches the key it is filed under",
  Object.entries(rs.RULE_SET_SOURCES).every(([key, s]) => s.id === key && key.startsWith("src:")));
check("every source has a title, publisher, edition date and scope",
  SOURCES.every((s) => s.title?.trim() && s.publisher?.trim() && s.published?.trim() && s.scope?.trim()));
check("every source URL is absolute https — a bare title cannot be re-checked",
  SOURCES.every((s) => /^https:\/\/\S+$/.test(s.url ?? "")));
check("every source carries an ISO review date",
  SOURCES.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.reviewedAt ?? "")));
check("no source claims a review date in a different epoch from the catalogue's",
  SOURCES.every((s) => s.reviewedAt === rs.RULE_SET_PROVENANCE_REVIEWED_AT));
check("every source declares how much weight it carries",
  SOURCES.every((s) => ["regulation", "standard", "guideline", "peer-reviewed", "practice"].includes(s.kind)));
check("no source is defined but never cited by any rule or template",
  SOURCES.every((s) =>
    Object.values(rs.RULE_PROVENANCE).some((p) => p.sources.includes(s.id))
    || Object.values(rs.RULE_SET_TEMPLATE_PROVENANCE).some((t) => t.sources.includes(s.id))));

// The claim a citation makes must match what the source can support. A binding
// regulation and a personal blog are both legitimate; conflating them is not.
const kindOf = (id) => rs.RULE_SET_SOURCES[id]?.kind;
check("binding law is classed as regulation, not as guidance",
  kindOf("src:ftc-reviews-rule") === "regulation" && kindOf("src:eu-ai-act-art50") === "regulation");
check("the FTC Endorsement GUIDES are not overclaimed as a binding rule",
  kindOf("src:ftc-endorsement-guides") === "guideline"
  && /guide/i.test(rs.RULE_SET_SOURCES["src:ftc-endorsement-guides"]?.scope ?? ""));
check("an industry blog post is classed as practice, not as a standard",
  kindOf("src:fowler-self-testing-code") === "practice"
  && kindOf("src:google-sre-postmortem") === "practice");
check("journal papers are classed as peer-reviewed",
  kindOf("src:asa-p-values") === "peer-reviewed" && kindOf("src:altman-bland-1995") === "peer-reviewed");
check("jurisdictional sources name their jurisdiction in scope",
  /US/.test(rs.RULE_SET_SOURCES["src:ftc-reviews-rule"]?.scope ?? "")
  && /EU/.test(rs.RULE_SET_SOURCES["src:eu-ai-act-art50"]?.scope ?? "")
  && /UK/.test(rs.RULE_SET_SOURCES["src:asa-cap-influencers"]?.scope ?? ""));

// ── 3) role-appropriate: citations stay in their domain ─────────────────────
section("3) role-appropriate behaviour — each domain is backed by its own field");

// Restated independently of the catalogue on purpose: if someone re-files a
// source under the wrong template, this map is what disagrees with them.
const DOMAIN_OF = {
  "src:fowler-self-testing-code": "softwareDevelopment",
  "src:google-sre-postmortem": "softwareDevelopment",
  "src:nist-ssdf-800-218": "softwareDevelopment",
  "src:cwe-798": "softwareDevelopment",
  "src:dora-capabilities": "softwareDevelopment",
  "src:asa-p-values": "scientificResearch",
  "src:altman-bland-1995": "scientificResearch",
  "src:top-2025": "scientificResearch",
  "src:fair-2016": "scientificResearch",
  "src:consort-2025": "scientificResearch",
  "src:icmje-2025": "scientificResearch",
  "src:ftc-endorsement-guides": "socialMedia",
  "src:ftc-reviews-rule": "socialMedia",
  "src:eu-ai-act-art50": "socialMedia",
  "src:asa-cap-influencers": "socialMedia",
  "src:wcag22": "socialMedia",
};

check("the gate's expected source map covers exactly the shipped source pool",
  SOURCES.length === Object.keys(DOMAIN_OF).length
  && SOURCES.every((s) => !!DOMAIN_OF[s.id]));

for (const id of TEMPLATE_IDS) {
  const cited = new Set((built[id].rules ?? []).flatMap((r) => rs.provenanceForRule(r)?.sources ?? []));
  check(`${id}: cites no source belonging to another domain`,
    [...cited].every((sid) => DOMAIN_OF[sid] === id));
  check(`${id}: template-level sources also stay in domain`,
    (rs.templateProvenanceOf(id)?.sources ?? []).every((sid) => DOMAIN_OF[sid] === id));
  check(`${id}: every source the template lists is actually used by one of its rules, or vice versa`,
    (rs.templateProvenanceOf(id)?.sources ?? []).every((sid) => cited.has(sid))
    && [...cited].every((sid) => (rs.templateProvenanceOf(id)?.sources ?? []).includes(sid)));
}

// The domain-defining rules must be backed by the sources that actually govern
// them — this is what makes each template role-appropriate rather than generic.
const sourcesOfTopic = (id, topic) =>
  rs.provenanceForRule((built[id].rules ?? []).find((r) => r.topic === topic) ?? { topic: "", stance: "" })?.sources ?? [];
check("the software 'secrets' rule is backed by the weakness taxonomy and secure-development standard",
  sourcesOfTopic("softwareDevelopment", "secrets").includes("src:cwe-798")
  && sourcesOfTopic("softwareDevelopment", "secrets").includes("src:nist-ssdf-800-218"));
check("the software 'regression-guard' rule cites the practice that describes writing the failing test first",
  sourcesOfTopic("softwareDevelopment", "regression-guard").includes("src:fowler-self-testing-code"));
check("the research 'uncertainty' rule cites the ASA statement on p-values",
  sourcesOfTopic("scientificResearch", "uncertainty").includes("src:asa-p-values"));
check("the research 'instrument' rule cites the absence-of-evidence paper",
  sourcesOfTopic("scientificResearch", "instrument").includes("src:altman-bland-1995"));
check("the research 'hypothesis' and 'negative-results' rules cite the open-science framework",
  sourcesOfTopic("scientificResearch", "hypothesis").includes("src:top-2025")
  && sourcesOfTopic("scientificResearch", "negative-results").includes("src:top-2025"));
check("the social 'disclosure' rule cites all three regimes — US, UK and EU",
  ["src:ftc-endorsement-guides", "src:asa-cap-influencers", "src:eu-ai-act-art50"]
    .every((sid) => sourcesOfTopic("socialMedia", "disclosure").includes(sid)));
check("the social 'claims' rule cites the binding fake-reviews rule",
  sourcesOfTopic("socialMedia", "claims").includes("src:ftc-reviews-rule"));
check("the social 'format' rule cites the accessibility standard behind alt text and captions",
  sourcesOfTopic("socialMedia", "format").includes("src:wcag22"));

// ── 4) honesty invariants ───────────────────────────────────────────────────
section("4) provenance cannot overclaim, and cannot become an instruction");

const keys = allBuiltRules.map((r) => rs.provenanceKeyOf(r));
check("every built-in rule has a topic and a stance, so it can be filed at all",
  keys.every((k) => !!k));
check("no two built-in rules share a provenance key — one domain's citations can never attach to another's rule",
  new Set(keys).size === keys.length);
check("every provenance entry corresponds to a real built-in rule — no orphaned citations",
  Object.keys(rs.RULE_PROVENANCE).every((k) => keys.includes(k)));

// Editing the position must drop the citation. A source backed the ORIGINAL
// stance; showing it against a changed one is the fabrication this prevents.
const secrets = (built.softwareDevelopment.rules ?? []).find((r) => r.topic === "secrets");
check("a rule keeps its provenance while its topic and stance are untouched",
  !!rs.provenanceForRule(secrets));
check("changing the stance drops the citation instead of carrying it over",
  rs.provenanceForRule({ ...secrets, stance: "embed-if-convenient" }) === null);
check("changing the topic drops the citation too",
  rs.provenanceForRule({ ...secrets, topic: "tone" }) === null);
check("clearing the topic drops it — a rule with no axis takes no citable position",
  rs.provenanceForRule({ ...secrets, topic: "" }) === null);
check("whitespace around a stance does not silently unlink a rule",
  !!rs.provenanceForRule({ ...secrets, stance: ` ${secrets.stance} ` }));

// Provenance is documentation. If it reached the prompt it would both cost
// tokens and invite the model to argue with its own instructions.
check("provenance is not a field on the persisted document",
  (built.softwareDevelopment.rules ?? []).every((r) =>
    !("provenance" in r) && !("sources" in r) && !("rationale" in r)));
check("the saved shape carries no provenance either",
  JSON.stringify(rs.ruleSetForSave(built.softwareDevelopment)).indexOf("rationale") === -1);
check("the Rust rule document has no provenance field, so it can never reach a prompt",
  rust.includes("pub struct RuleSetRuleDoc")
  && !/rationale|citation|provenance/i.test(rust.split("pub struct RuleSetDoc")[0] ?? ""));

// ── 5) template versions and limitations ────────────────────────────────────
section("5) template versions and limitations are recorded");

for (const id of TEMPLATE_IDS) {
  const tp = rs.templateProvenanceOf(id);
  check(`${id}: has template provenance`, !!tp);
  if (!tp) continue;
  check(`${id}: template version is a positive integer`,
    Number.isInteger(tp.templateVersion) && tp.templateVersion >= 1);
  check(`${id}: the seeded document is stamped with that version`,
    built[id].templateVersion === tp.templateVersion);
  check(`${id}: carries an ISO review date`, /^\d{4}-\d{2}-\d{2}$/.test(tp.reviewedAt ?? ""));
  check(`${id}: records at least three limitations, each substantive`,
    Array.isArray(tp.limitations) && tp.limitations.length >= 3
    && tp.limitations.every((l) => l.trim().length >= 60));
  check(`${id}: cites at least four sources`, (tp.sources ?? []).length >= 4);
}

// The limitations are where a template refuses to overclaim; these are the
// specific admissions that must survive an edit.
const limitsOf = (id) => (rs.templateProvenanceOf(id)?.limitations ?? []).join(" ");
check("the social template says plainly that it is not legal advice",
  /not legal advice/i.test(limitsOf("socialMedia")));
check("the social template warns that platform terms are a separate obligation",
  /platform terms/i.test(limitsOf("socialMedia")));
check("the research template admits its sources are biomedical and do not bind an agent",
  /biomedical/i.test(limitsOf("scientificResearch"))
  && /bind|binds/i.test(limitsOf("scientificResearch")));
check("the software template admits which of its rules have no external citation",
  /no external citation/i.test(limitsOf("softwareDevelopment")));

// ── 6) migration of sets stored before provenance existed ───────────────────
section("6) migration — stored sets predate templateVersion and must not overclaim");

// Seeded ONCE: ruleSetFromTemplate mints fresh uuids per call, and an identity
// check against a re-seeded document would compare two different sets.
const LEGACY_SEED = (() => {
  const seed = rs.ruleSetFromTemplate("scientificResearch", "proj-a", "2026-01-01T00:00:00Z");
  const { templateVersion, ...withoutVersion } = seed;      // exactly what an old doc looks like
  return withoutVersion;
})();
const legacy = (over = {}) => ({ ...LEGACY_SEED, ...over });
// -1, never 0: on a tree with no provenance this must not accidentally equal the
// "unknown edition" sentinel and report a pass.
const versionOf = (id) => rs.templateProvenanceOf(id)?.templateVersion ?? -1;

const migratedIntact = rs.migrateRuleSetDoc(legacy());
check("a legacy set with untouched positions is recognised as the current edition",
  migratedIntact.templateVersion === versionOf("scientificResearch"));
check("migration preserves the rules and the identity of a legacy set",
  migratedIntact.rules.length === legacy().rules.length && migratedIntact.id === legacy().id);
check("migration normalises the schema version",
  migratedIntact.schemaVersion === 1);

const divergedRules = legacy().rules.map((r, i) =>
  (i === 0 ? { ...r, stance: "hand-edited-stance" } : r));
const migratedDiverged = rs.migrateRuleSetDoc(legacy({ rules: divergedRules }));
check("a legacy set whose position was hand-edited reports edition 0, not a borrowed one",
  migratedDiverged.templateVersion === 0);
check("a legacy set missing a rule reports edition 0",
  rs.migrateRuleSetDoc(legacy({ rules: legacy().rules.slice(1) })).templateVersion === 0);
check("a legacy set with an extra rule reports edition 0",
  rs.migrateRuleSetDoc(legacy({
    rules: [...legacy().rules, { id: "rule:extra", kind: "preference", topic: "", stance: "", title: "x", body: "y" }],
  })).templateVersion === 0);
check("a hand-built custom set never claims a built-in edition",
  rs.migrateRuleSetDoc({ ...rs.emptyRuleSet("proj-a", "2026-01-01T00:00:00Z") }).templateVersion === 0);
check("migration is idempotent — running it twice changes nothing",
  JSON.stringify(rs.migrateRuleSetDoc(migratedIntact)) === JSON.stringify(migratedIntact));
check("an explicit stored version is trusted over re-derivation",
  rs.migrateRuleSetDoc(legacy({ templateVersion: 7 })).templateVersion === 7);
check("a fork records the edition it was taken from, but stops matching once a stance changes",
  rs.forkRuleSet(built.socialMedia, "proj-a", "2026-01-01T00:00:00Z").templateVersion
    === versionOf("socialMedia")
  && rs.templateEditionOf({
       templateId: "socialMedia",
       rules: (built.socialMedia.rules ?? []).map((r, i) => (i === 0 ? { ...r, stance: "changed" } : r)),
     }) === 0);
check("the Rust document defaults templateVersion, so an old stored file still parses",
  /#\[serde\(default\)\]\s*\n\s*pub template_version: u32/.test(rust));

// ── 7) provenance changes nothing about project isolation ───────────────────
section("7) provenance never widens what a project can see");

check("no source, rationale or limitation names a project id",
  [...SOURCES.map((s) => `${s.title} ${s.publisher} ${s.scope} ${s.url}`),
   ...Object.values(rs.RULE_PROVENANCE).map((p) => `${p.rationale} ${p.limitation}`)]
    .every((text) => !/proj-a|projectId|project:/i.test(text)));
check("the provenance catalogue is static — it takes no project argument anywhere",
  typeof rs.provenanceForRule === "function" && rs.provenanceForRule.length === 1
  && typeof rs.templateProvenanceOf === "function" && rs.templateProvenanceOf.length === 1);
check("the panel still scopes every read to one project id",
  /personal_agent_list_rule_sets"\s*,\s*\{\s*projectId: pid\s*\}/.test(panel));
check("migration on load does not reach across projects",
  rs.migrateRuleSetDoc(legacy({ projectId: "proj-b" })).projectId === "proj-b");

// ── 8) conflict resolution, through the real resolver ───────────────────────
section("8) conflict resolution keeps the losing rule's provenance visible");

const manifest = path.join(APP, "src-tauri/rulesets-harness/Cargo.toml");
const cargo = (args, binArgs = []) => spawnSync(
  "cargo",
  [...args, "--manifest-path", manifest, ...(binArgs.length ? ["--", ...binArgs] : [])],
  { encoding: "utf8", shell: process.platform === "win32" },
);
const requestPath = path.join(TMP, "resolve.json");
const resolve = (agent, project) => {
  fs.writeFileSync(requestPath, JSON.stringify({
    projectId: "proj-a",
    agent: agent.map((id) => ({ ...built[id], status: "active" })),
    project: project.map((id) => ({ ...built[id], status: "active" })),
  }));
  const run = cargo(["run", "--quiet"], ["--resolve", requestPath]);
  if (run.status !== 0) {
    fails.push(`resolve failed:\n${(run.stdout || "") + (run.stderr || "")}`);
    return null;
  }
  return JSON.parse(run.stdout.trim().split("\n").pop());
};

const probe = cargo(["run", "--quiet"]);
if (probe.error && probe.error.code === "ENOENT") {
  fails.push("cargo is not on PATH — the executed provenance/resolver proof cannot run");
} else {
  const all = resolve([], TEMPLATE_IDS);
  if (all) {
    check("every applied rule can still be traced to its provenance after resolution",
      all.applied.length > 0
      && all.applied.every((e) => !e.rule.topic || !!rs.provenanceForRule(e.rule)));
    check("every SUPERSEDED rule keeps its provenance — a loser is auditable, not erased",
      all.superseded.length > 0
      && all.superseded.every((e) => !!rs.provenanceForRule(e.rule)));
    check("the resolver round-trips topic and stance intact, which is what the citation is keyed on",
      all.applied.every((e) => {
        const source = allBuiltRules.find((r) => r.id === e.rule.id);
        return source && source.topic === e.rule.topic && source.stance === e.rule.stance;
      }));
    check("the resolver carries templateVersion through instead of dropping it on the wire",
      all.sets.length === TEMPLATE_IDS.length);
    check("provenance does not influence the outcome — the contested axes resolve on precedence alone",
      all.applied.find((e) => e.rule.topic === "tone")?.rule.stance === "plain-technical"
      && all.applied.find((e) => e.rule.topic === "sourcing")?.rule.stance === "cite-code-locations");
    // A regulation-backed rule losing to a house-style preference would be a real
    // finding for the user; the point is that the panel can now SHOW that.
    const supersededKinds = all.superseded.flatMap((e) =>
      (rs.provenanceForRule(e.rule)?.sources ?? []).map((sid) => rs.RULE_SET_SOURCES[sid]?.kind));
    check("at least one superseded rule carries a citation the panel can surface",
      supersededKinds.length > 0);
  }

  // With nothing assigned there is nothing to resolve — and that must be an
  // explicit, safe state rather than an empty panel the user misreads.
  section("9) safe fallback when no rule set is selected");
  const none = resolve([], []);
  if (none) {
    check("resolving with no assigned set yields an empty stack, not an error",
      none.sets.length === 0 && none.applied.length === 0
      && none.superseded.length === 0 && none.errors.length === 0);
    check("the fallback is described in words, naming what still governs the agent",
      /no rule set/i.test(rs.describeRuleSetStack?.(none) ?? "")
      && /rule cards/i.test(rs.describeRuleSetStack?.(none) ?? ""));
  }
  check("an unassigned project inherits no template by default — nothing is applied implicitly",
    (rs.assignableRuleSets?.([], "proj-a") ?? []).length === 0);
}

// ── 10) the configuration UI exposes it ─────────────────────────────────────
section("10) the configuration UI exposes provenance");

check("the panel renders per-rule provenance",
  panel.includes("RuleProvenanceBlock") && panel.includes('data-ui="ruleProvenance"'));
check("the panel renders template-level provenance",
  panel.includes("TemplateProvenancePanel") && panel.includes('data-ui="templateProvenance"'));
check("citations render as clickable links, opened safely",
  /href=\{source\.url\}/.test(panel) && /rel="noreferrer noopener"/.test(panel));
check("the panel shows publisher, edition date, kind and review date together",
  /source\.publisher/.test(panel) && /source\.published/.test(panel)
  && /source\.kind/.test(panel) && /source\.reviewedAt/.test(panel));
check("scope is shown, so a US rule is not read as a worldwide obligation",
  /source\.scope/.test(panel));
check("source kind is conveyed in text as well as colour",
  panel.includes("KIND_COLOR") && /\{source\.kind\}/.test(panel));
check("template limitations are rendered, not collapsed behind a toggle",
  /provenance\.limitations\.map/.test(panel));
check("the template gallery shows the edition and source count before a template is adopted",
  /templateVersion\}/.test(panel) && /templateCitationsOf\(template\.id\)\.length/.test(panel));
check("the panel states that provenance is never sent to the model",
  /never sent to the model/i.test(panel));
check("the panel migrates stored sets on load",
  /\.map\(migrateRuleSetDoc\)/.test(panel));
check("the resolved preview carries an attribution trail",
  panel.includes("ProvenanceTrail") && panel.includes('data-ui="provenanceTrail"'));

check("the research write-up exists and is not a stub",
  doc.length > 4000 && /## /.test(doc));
check("the write-up records the review date the catalogue uses",
  doc.includes(rs.RULE_SET_PROVENANCE_REVIEWED_AT));
check("the write-up lists every shipped source URL, so the citations can be re-checked from one place",
  SOURCES.every((s) => doc.includes(s.url)));
check("the write-up names its own limitations section",
  /limitation/i.test(doc));

// ── 11) the real panel, mounted ─────────────────────────────────────────────
section("11) the real panel, mounted, showing real provenance");
await mountedChecks();

async function mountedChecks() {
  const req = createRequire(path.join(APP, "package.json"));
  let JSDOM;
  try { ({ JSDOM } = req("jsdom")); } catch {
    fails.push("jsdom is required for the mounted section (npm i --no-save jsdom)");
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

  fs.writeFileSync(path.join(SANDBOX, "agentRuleSets.js"), toCjs("agentRuleSets.ts"));
  fs.writeFileSync(path.join(SANDBOX, "personalAgentConfig.js"), toCjs("personalAgentConfig.ts"));

  // The store is seeded with a LEGACY set — no templateVersion — so the mount
  // exercises the migration path the way a real upgrade would.
  fs.writeFileSync(path.join(SANDBOX, "stubs.js"), `
    const stores = {};
    const scope = (projectId) => (stores[projectId] ||= { sets: [], config: null });
    module.exports = {
      __esModule: true,
      __stores: stores,
      __seed: (projectId, sets) => { scope(projectId).sets = sets; },
      invoke: async (cmd, args) => {
        if (cmd === "personal_agent_list_rule_sets") return scope(args.projectId).sets.map((s) => ({ ...s }));
        if (cmd === "personal_agent_get_project_config") return scope(args.projectId).config;
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
        if (cmd === "personal_agent_preview_rule_sets") return { sets: [], applied: [], superseded: [], errors: [] };
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
  const catalogue = reqBox("./agentRuleSets.js");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const PID = "verify-provenance";
  // A set stored before templateVersion existed, with one stance hand-edited —
  // the case that must NOT be reported as a current edition.
  const seed = catalogue.ruleSetFromTemplate("socialMedia", PID, "2026-01-01T00:00:00Z");
  const { templateVersion, ...legacyStored } = seed;
  stubs.__seed(PID, [{
    ...legacyStored,
    status: "active",
    rules: seed.rules.map((r, i) => (i === 0 ? { ...r, stance: "hand-edited" } : r)),
  }]);

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(Panel, {
      projectId: PID,
      onProjectIdChange: () => {},
      profiles: [{ id: "agent:alice", displayName: "Alice", revision: 1 }],
    }));
  });
  await act(async () => {});

  const text = () => host.textContent;
  const buttonWith = (needle) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent.includes(needle));
  const click = async (node) => {
    await act(async () => { node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    await act(async () => {});
  };

  check("mounted: the template gallery advertises editions and source counts",
    /v1 · \d+ sources · reviewed \d{4}-\d{2}-\d{2}/.test(text()));
  check("mounted: the legacy set loaded and its provenance panel rendered",
    !!host.querySelector('[data-ui="templateProvenance"]'));
  check("mounted: the hand-edited legacy set is reported as customised, not as a current edition",
    host.querySelector('[data-ui="templateProvenance"]')?.getAttribute("data-edition") === "0"
    && /no longer matches any built-in edition/i.test(text()));
  check("mounted: the template's limitations are visible without opening anything",
    /not legal advice/i.test(text()) && /platform terms/i.test(text()));
  check("mounted: template citations render as links to the real sources",
    [...host.querySelectorAll("a")].some((a) => a.getAttribute("href")?.includes("ecfr.gov"))
    && [...host.querySelectorAll("a")].some((a) => a.getAttribute("href")?.includes("asa.org.uk")));

  const blocks = [...host.querySelectorAll('[data-ui="ruleProvenance"]')];
  check("mounted: every rule in the editor carries a provenance block",
    blocks.length === seed.rules.length);
  check("mounted: the hand-edited rule is shown as unlinked from its source",
    blocks.some((b) => b.getAttribute("data-state") === "unlinked"));
  check("mounted: untouched rules are shown as cited",
    blocks.some((b) => b.getAttribute("data-state") === "cited"));
  check("mounted: rules with no external source are labelled uncited, not cited",
    blocks.some((b) => b.getAttribute("data-state") === "uncited"));

  const why = buttonWith("Why this rule");
  check("mounted: a per-rule provenance toggle exists", !!why);
  if (why) {
    check("mounted: rationale is collapsed until asked for", !/Limitation:/.test(text()));
    await click(why);
    check("mounted: opening it reveals the rationale, the citation and the limitation",
      /Limitation:/.test(text())
      && [...host.querySelectorAll('[data-ui="ruleProvenance"] a')].length > 0);
  }

  // Re-seed a pristine set in a SECOND project: provenance must be identical,
  // and nothing from the first project may appear.
  const other = catalogue.ruleSetFromTemplate("scientificResearch", "other-project", "2026-01-01T00:00:00Z");
  stubs.__seed("other-project", [{ ...other, status: "active" }]);
  await act(async () => { root.unmount(); });
  host.remove();

  const host2 = document.createElement("div");
  document.body.appendChild(host2);
  const root2 = createRoot(host2);
  await act(async () => {
    root2.render(React.createElement(Panel, {
      projectId: "other-project",
      onProjectIdChange: () => {},
      profiles: [],
    }));
  });
  await act(async () => {});
  check("mounted: a second project shows its own provenance and none of the first project's",
    /biomedical/i.test(host2.textContent) && !/not legal advice/i.test(host2.textContent));
  check("mounted: an untouched set in the second project IS recognised as the current edition",
    host2.querySelector('[data-ui="templateProvenance"]')?.getAttribute("data-edition") === "1");
  await act(async () => { root2.unmount(); });
  host2.remove();
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(`\n${pass} checks passed`);
if (fails.length) {
  console.error(`\n${fails.length} FAILED:`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("rule-set provenance: OK");
