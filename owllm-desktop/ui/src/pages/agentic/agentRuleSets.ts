// Rule-set profiles for personal agents — the catalogue and the client shape.
//
// A rule set is a named, versioned, PROJECT-SCOPED bundle of behavioural rules.
// This module owns the three built-in templates and the draft-time validation
// the editor shows inline. It deliberately does NOT re-implement precedence:
// the resolver lives once, in src-tauri/src/personal_agent_rule_sets.rs, and the
// preview panel calls it through `personal_agent_preview_rule_sets` so what the
// user reads before saving is produced by the same code that runs the agent.
//
// Pure: no React, no Tauri. Sibling of personalAgentConfig.ts.

export const RULE_SET_SCHEMA_VERSION = 1 as const;

export type RuleSetTemplateId = "softwareDevelopment" | "scientificResearch" | "socialMedia";
export type RuleSetStatus = "draft" | "active" | "archived";
export type RuleSetLayer = "agent" | "project";
export type RuleKind = "fact" | "preference" | "constraint" | "workflow" | "conditional";

/// Conflict axes. Two rules collide only when they name the same topic; an
/// empty topic declares no axis and always applies. Mirrors RULE_SET_TOPICS in
/// personal_agent_rule_sets.rs — the gate compares both lists.
export const RULE_SET_TOPICS = [
  "brand-safety",
  "cadence",
  "change-size",
  "claims",
  "disclosure",
  "format",
  "hypothesis",
  "instrument",
  "negative-results",
  "regression-guard",
  "reproducibility",
  "root-cause",
  "secrets",
  "sourcing",
  "tone",
  "uncertainty",
  "verification",
] as const;
export type RuleSetTopic = (typeof RULE_SET_TOPICS)[number];

/// Catalogue order — also the last deterministic tie-break in the resolver, so
/// it must match RULE_SET_TEMPLATE_IDS in personal_agent_rule_sets.rs.
export const RULE_SET_TEMPLATE_IDS: RuleSetTemplateId[] = [
  "softwareDevelopment",
  "scientificResearch",
  "socialMedia",
];

export type RuleSetRule = {
  id: `rule:${string}`;
  kind: RuleKind;
  topic: RuleSetTopic | "";
  stance: string;
  title: string;
  body: string;
};

export type RuleSetDoc = {
  schemaVersion: 1;
  id: `ruleset:${string}`;
  revision: number;
  templateId: RuleSetTemplateId | "custom";
  name: string;
  summary: string;
  /// Lower wins inside a layer. Template defaults are spaced so a user can slot
  /// a fork between two built-ins without renumbering anything.
  priority: number;
  rules: RuleSetRule[];
  projectId: string;
  private: boolean;
  status: RuleSetStatus;
  createdAt: string;
  updatedAt: string;
};

export type ResolvedRuleSetRef = {
  id: string;
  revision: number;
  name: string;
  templateId: string;
  layer: RuleSetLayer;
  priority: number;
  order: number;
};

export type AppliedRuleSetRule = {
  rule: RuleSetRule;
  setId: string;
  setRevision: number;
  setName: string;
  layer: RuleSetLayer;
};

export type SupersededRuleSetRule = {
  rule: RuleSetRule;
  setId: string;
  setRevision: number;
  layer: RuleSetLayer;
  reason: "conflict" | "duplicate";
  winningSetId: string;
  winningRuleId: string;
  explanation: string;
};

export type RuleSetResolution = {
  sets: ResolvedRuleSetRef[];
  applied: AppliedRuleSetRule[];
  superseded: SupersededRuleSetRule[];
  errors: string[];
};

type RuleSetTemplate = {
  id: RuleSetTemplateId;
  icon: string;
  label: string;
  hint: string;
  summary: string;
  priority: number;
  rules: Omit<RuleSetRule, "id">[];
};

// ── The catalogue ───────────────────────────────────────────────────────────
// Each template states what its field already holds itself to, so the rules read
// as working practice rather than as generic advice:
//   • software development — root cause before fix, a regression check that
//     fails on the old code, verify the artifact you actually changed;
//   • scientific research  — falsification named before the result is seen,
//     effect size with uncertainty rather than significance alone, negative
//     results reported, the instrument validated before a null is believed;
//   • social media         — material connections and synthetic media disclosed
//     up front, no fabricated metrics or testimonials, per-platform format, a
//     cadence the team can hold, review before an irreversible publish.
//
// The three overlap on `sourcing` and `tone` on purpose: those are the axes
// where a real multi-discipline project has to choose, and the resolver makes
// that choice visible instead of letting whichever set loaded last win.
const RULE_SET_TEMPLATES: Record<RuleSetTemplateId, RuleSetTemplate> = {
  softwareDevelopment: {
    id: "softwareDevelopment",
    icon: "🛠",
    label: "Software development",
    hint: "Root-cause fixes, executed verification, guarded regressions.",
    summary:
      "Engineering practice: prove the mechanism, make the smallest correct change, and leave a check behind that would catch the bug coming back.",
    priority: 10,
    rules: [
      {
        kind: "constraint",
        topic: "root-cause",
        stance: "prove-mechanism-then-fix",
        title: "Prove the mechanism before fixing it",
        body: "Name the cause and show the measurement, log line or failing test that confirms it, then fix that cause. A workaround is allowed only when necessary, must be labelled temporary, and must state the remaining risk.",
      },
      {
        kind: "constraint",
        topic: "verification",
        stance: "execute-before-claiming",
        title: "Verify by running, not by reasoning",
        body: "A change is done when it has been run, tested or inspected — and when the artifact observed is confirmed to be the one that was changed. Anything that could not be verified is named explicitly, with the reason.",
      },
      {
        kind: "workflow",
        topic: "regression-guard",
        stance: "check-fails-on-old-code",
        title: "Ship the fix with a check that would have caught it",
        body: "Add a check that fails against the previous code and passes against the new one, and wire it into the gate that actually runs before release. Confirm the gate discovers it; an unrun guard is not protection.",
      },
      {
        kind: "preference",
        topic: "change-size",
        stance: "smallest-correct-change",
        title: "Smallest change that fully resolves it",
        body: "Fix the whole problem and nothing beyond it. Match the surrounding naming, structure and conventions, and keep unrelated refactors out of the diff.",
      },
      {
        kind: "constraint",
        topic: "secrets",
        stance: "never-embed",
        title: "No credentials in builds or version control",
        body: "Never commit or ship keys, tokens, vaults or user account data. Secrets stay in per-user runtime storage; the repository and the installer must work with none embedded.",
      },
      {
        kind: "preference",
        topic: "sourcing",
        stance: "cite-code-locations",
        title: "Cite file and line, not recollection",
        body: "Every claim about how the code behaves points at the file and line it came from. Do not describe behaviour that has not been read or executed.",
      },
      {
        kind: "preference",
        topic: "tone",
        stance: "plain-technical",
        title: "Report plainly",
        body: "State what changed, what was verified, and what was left out. No hedging on failures and no promotional framing of a result.",
      },
    ],
  },
  scientificResearch: {
    id: "scientificResearch",
    icon: "🧪",
    label: "Scientific research",
    hint: "Falsification first, uncertainty reported, negatives published.",
    summary:
      "Research practice: commit to what would prove you wrong before you look, report the size and the uncertainty of what you found, and publish the nulls.",
    priority: 20,
    rules: [
      {
        kind: "workflow",
        topic: "hypothesis",
        stance: "state-falsifier-first",
        title: "Name the falsifier before seeing the result",
        body: "Write down the hypothesis and the specific observation that would refute it before running the analysis. An explanation invented after the data is a description, not a finding.",
      },
      {
        kind: "constraint",
        topic: "sourcing",
        stance: "cite-primary-sources",
        title: "Cite primary sources and separate the layers",
        body: "Cite the primary source rather than a summary of it, and keep direct observation, cited finding and your own inference visibly distinct.",
      },
      {
        kind: "constraint",
        topic: "uncertainty",
        stance: "effect-size-with-interval",
        title: "Report effect size and uncertainty",
        body: "Give the magnitude with its interval, sample size and assumptions — not a significance verdict alone. Absence of evidence is not evidence of absence.",
      },
      {
        kind: "workflow",
        topic: "instrument",
        stance: "validate-before-trusting-a-null",
        title: "Validate the instrument before believing a negative",
        body: "Before reporting no effect, show the measurement could have detected one — a positive control, a known signal, or a sensitivity bound. An instrument that cannot distinguish the competing explanations is not evidence.",
      },
      {
        kind: "constraint",
        topic: "negative-results",
        stance: "report-them-fully",
        title: "Report negative and inconclusive results",
        body: "Give failed and inconclusive attempts the same detail as successful ones, including what was tried and why it was abandoned.",
      },
      {
        kind: "workflow",
        topic: "reproducibility",
        stance: "record-method-and-environment",
        title: "Record enough to reproduce it",
        body: "Capture method, parameters, data version, seeds and environment alongside the result, so someone else can obtain the same number.",
      },
      {
        kind: "preference",
        topic: "tone",
        stance: "precise-and-hedged",
        title: "Write precisely and hedge honestly",
        body: "Plain prose, claims scaled to the evidence behind them, and no promotional vocabulary. Confidence is stated, not performed.",
      },
    ],
  },
  socialMedia: {
    id: "socialMedia",
    icon: "📣",
    label: "Social media / influencer",
    hint: "Disclosed, sourced, per-platform, reviewed before publishing.",
    summary:
      "Creator practice: disclose the money and the synthetic media, never invent proof, write native to each platform, and review before an irreversible publish.",
    priority: 30,
    rules: [
      {
        kind: "constraint",
        topic: "disclosure",
        stance: "label-paid-and-synthetic",
        title: "Disclose material connections and synthetic media",
        body: "Any paid, gifted or affiliate relationship is disclosed clearly and up front, in the post itself and not only in a platform toggle. Label AI-generated or materially altered media the same way.",
      },
      {
        kind: "constraint",
        topic: "claims",
        stance: "no-fabricated-proof",
        title: "Never invent metrics, testimonials or endorsements",
        body: "Every number, quote, review and result traces to a real source. Do not manufacture social proof, and do not imply an endorsement that was not given.",
      },
      {
        kind: "preference",
        topic: "sourcing",
        stance: "attribute-once-in-post",
        title: "Attribute creative work and data in the post",
        body: "Credit quotes, data and reused creative work where the audience can see it, once per post, without turning the caption into a reference list.",
      },
      {
        kind: "preference",
        topic: "tone",
        stance: "hook-led-conversational",
        title: "Lead with the hook, write like a person",
        body: "Say what the audience gets in the first line and keep the voice conversational for the platform. Persuasive is fine; misleading is not.",
      },
      {
        kind: "workflow",
        topic: "format",
        stance: "native-per-platform",
        title: "Adapt the asset to each platform",
        body: "Length, aspect ratio, captions, alt text and hashtags are set per platform. Do not cross-post one asset unchanged.",
      },
      {
        kind: "preference",
        topic: "cadence",
        stance: "sustainable-schedule",
        title: "Plan a cadence the team can hold",
        body: "Choose a posting rhythm that survives a bad week. A shorter post on schedule beats a missed slot.",
      },
      {
        kind: "workflow",
        topic: "brand-safety",
        stance: "review-before-publish",
        title: "Review before publishing — it is not reversible",
        body: "Check platform policy, usage rights, and brand and legal safety before posting. Published content is cached and indexed even if it is deleted afterwards.",
      },
    ],
  },
};

export const RULE_SET_TEMPLATE_LIST: RuleSetTemplate[] = RULE_SET_TEMPLATE_IDS.map(
  id => RULE_SET_TEMPLATES[id],
);

export function isRuleSetTemplateId(value: unknown): value is RuleSetTemplateId {
  return typeof value === "string" && (RULE_SET_TEMPLATE_IDS as string[]).includes(value);
}

function uid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/// Build a project-scoped draft from a template. Every rule gets its own stable
/// uuid at creation, so customising a rule later keeps its identity — and so the
/// same set attached at both layers dedupes by rule id rather than by text.
export function ruleSetFromTemplate(
  templateId: RuleSetTemplateId,
  projectId: string,
  now = new Date().toISOString(),
): RuleSetDoc {
  const template = RULE_SET_TEMPLATES[templateId];
  return {
    schemaVersion: RULE_SET_SCHEMA_VERSION,
    id: `ruleset:${uid()}`,
    revision: 1,
    templateId,
    name: template.label,
    summary: template.summary,
    priority: template.priority,
    rules: template.rules.map(rule => ({ ...rule, id: `rule:${uid()}` })),
    projectId: projectId.trim(),
    private: true,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
}

/// A fork keeps the parent's rule ids so the two dedupe instead of colliding,
/// and drops to `custom` so it sorts after every built-in at equal priority.
export function forkRuleSet(
  source: RuleSetDoc,
  projectId: string,
  now = new Date().toISOString(),
): RuleSetDoc {
  return {
    ...source,
    id: `ruleset:${uid()}`,
    revision: 1,
    templateId: "custom",
    name: `${source.name} (copy)`,
    projectId: projectId.trim() || source.projectId,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
}

export function emptyRuleSet(projectId: string, now = new Date().toISOString()): RuleSetDoc {
  return {
    schemaVersion: RULE_SET_SCHEMA_VERSION,
    id: `ruleset:${uid()}`,
    revision: 1,
    templateId: "custom",
    name: "New rule set",
    summary: "",
    priority: 50,
    rules: [],
    projectId: projectId.trim(),
    private: true,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
}

export function emptyRuleSetRule(): RuleSetRule {
  return {
    id: `rule:${uid()}`,
    kind: "preference",
    topic: "",
    stance: "",
    title: "New rule",
    body: "",
  };
}

export function ruleSetForSave(doc: RuleSetDoc, now = new Date().toISOString()): RuleSetDoc {
  return {
    ...doc,
    schemaVersion: RULE_SET_SCHEMA_VERSION,
    name: doc.name.trim() || "Untitled rule set",
    summary: doc.summary.trim(),
    priority: Math.max(0, Math.floor(Number(doc.priority) || 0)),
    projectId: doc.projectId.trim(),
    private: true,
    rules: doc.rules.map(rule => ({
      ...rule,
      topic: rule.topic,
      stance: rule.stance.trim(),
      title: rule.title.trim(),
      body: rule.body.trim(),
    })),
    updatedAt: now,
  };
}

/// Mirror of rule_set_validation_errors in personal_agent_rule_sets.rs so the
/// editor can show the same message the backend would reject with.
export function validateRuleSetDraft(doc: RuleSetDoc): string[] {
  const errors: string[] = [];
  if (doc.schemaVersion !== RULE_SET_SCHEMA_VERSION) errors.push("rule set schemaVersion must be 1");
  if (!(doc.revision > 0)) errors.push("rule set revision must be positive");
  if (!doc.id.startsWith("ruleset:")) errors.push("rule set id must start with ruleset:");
  if (!doc.name.trim()) errors.push("rule set name is required");
  if (!doc.projectId.trim()) errors.push("rule sets are project-scoped and need a project id");
  if (!["draft", "active", "archived"].includes(doc.status)) errors.push(`invalid rule set status ${doc.status}`);
  if (doc.status === "active") {
    if (!doc.summary.trim()) errors.push("summary is required before a rule set can be activated");
    if (!doc.rules.length) errors.push("an active rule set needs at least one rule");
  }
  const seen = new Set<string>();
  for (const rule of doc.rules) {
    if (!rule.id.startsWith("rule:")) errors.push(`rule id ${rule.id} must start with rule:`);
    if (seen.has(rule.id)) errors.push(`duplicate rule id ${rule.id} inside the set`);
    seen.add(rule.id);
    if (!["fact", "preference", "constraint", "workflow", "conditional"].includes(rule.kind)) {
      errors.push(`invalid rule kind ${rule.kind}`);
    }
    if (!rule.title.trim() || !rule.body.trim()) errors.push(`rule ${rule.id} needs a title and a body`);
    if (rule.topic && !(RULE_SET_TOPICS as readonly string[]).includes(rule.topic)) {
      errors.push(`rule ${rule.id} uses unknown conflict topic ${rule.topic}`);
    }
    if (rule.topic && !rule.stance.trim()) {
      errors.push(`rule ${rule.id} names topic ${rule.topic} but takes no stance on it`);
    }
  }
  return [...new Set(errors)].sort();
}

/// The only definition of "usable here" the UI is allowed to apply: a set is
/// offered for assignment when it belongs to THIS project and is active. Sets
/// from another project are never listed, so their bodies never reach a prompt
/// or an assignment picker in the wrong place.
export function assignableRuleSets(sets: RuleSetDoc[], projectId: string): RuleSetDoc[] {
  const pid = projectId.trim();
  if (!pid) return [];
  return sets
    .filter(set => set.projectId === pid && set.status === "active")
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
}

export function visibleRuleSets(sets: RuleSetDoc[], projectId: string): RuleSetDoc[] {
  const pid = projectId.trim();
  if (!pid) return [];
  return sets.filter(set => set.projectId === pid);
}

/// Renders the ordered stack the backend resolved, for the preview panel and for
/// the summary line under the assignment pickers.
export function describeRuleSetStack(resolution: RuleSetResolution): string {
  if (!resolution.sets.length) {
    return "No rule set assigned — only this project's individual rule cards apply.";
  }
  const order = resolution.sets.map(set => `${set.name} (${set.layer})`).join(" › ");
  const conflicts = resolution.superseded.filter(entry => entry.reason === "conflict").length;
  const duplicates = resolution.superseded.length - conflicts;
  const tail = [
    conflicts ? `${conflicts} conflict${conflicts === 1 ? "" : "s"} resolved by precedence` : "",
    duplicates ? `${duplicates} duplicate${duplicates === 1 ? "" : "s"} deduped` : "",
  ].filter(Boolean).join(", ");
  return `${resolution.applied.length} rules apply, in order: ${order}${tail ? ` — ${tail}` : ""}.`;
}

export function ruleSetRefsOf(sets: RuleSetDoc[]): { id: string; revision: number }[] {
  return sets.map(set => ({ id: set.id, revision: set.revision }));
}
