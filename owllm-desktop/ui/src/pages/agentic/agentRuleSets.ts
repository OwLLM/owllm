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

/// The date a maintainer last opened every URL in RULE_SET_SOURCES and confirmed
/// it still says what the rule claims. This is a REVIEW date, not a publication
/// date: sources are amended and links rot, so a stale review is itself a finding
/// the panel surfaces rather than something only a reader would notice.
export const RULE_SET_PROVENANCE_REVIEWED_AT = "2026-09-02";

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

export type RuleSetSourceId = `src:${string}`;

/// One cited work. `published` is the source's own edition date; `reviewedAt` is
/// when WE last read it. Keeping both is the point — a 2016 paper reviewed today
/// is current, a 2026 regulation last reviewed two years ago is not.
export type RuleSetCitation = {
  id: RuleSetSourceId;
  title: string;
  publisher: string;
  url: string;
  published: string;
  reviewedAt: string;
  /// How much weight the rule may claim. `regulation` binds by law in its scope,
  /// `standard` is a formal specification, `guideline` is issued by a named body,
  /// `peer-reviewed` is a paper, `practice` is documented industry practice.
  kind: "regulation" | "standard" | "guideline" | "peer-reviewed" | "practice";
  /// Where it actually applies. The panel shows this next to the title so a US
  /// rule is never read as a worldwide obligation.
  scope: string;
};

/// Why one rule says what it says. Deliberately NOT part of RuleSetDoc: see
/// RULE_PROVENANCE for why provenance is documentation, not prompt payload.
export type RuleProvenance = {
  /// The failure this rule prevents, in one sentence.
  rationale: string;
  /// Ids into RULE_SET_SOURCES. EMPTY IS LEGAL AND MEANINGFUL: it means no
  /// external authority was found, and `limitation` then says whose judgement
  /// the rule is. Padding this list with weak citations would be the lie.
  sources: RuleSetSourceId[];
  /// Where the cited source stops and OWLLM's own extrapolation begins.
  limitation: string;
};

export type RuleSetTemplateProvenance = {
  templateId: RuleSetTemplateId;
  /// Bumped whenever a rule's topic, stance or body changes. Stamped onto every
  /// set seeded from the template, so a stored set can say which edition it came
  /// from — and `templateEditionOf` can tell when it no longer matches any.
  templateVersion: number;
  reviewedAt: string;
  sources: RuleSetSourceId[];
  /// What this template does NOT establish. Shown in the panel, not buried here.
  limitations: string[];
};

export type RuleSetDoc = {
  schemaVersion: 1;
  id: `ruleset:${string}`;
  revision: number;
  templateId: RuleSetTemplateId | "custom";
  /// Edition of the built-in template this set was seeded from. 0 means unknown
  /// — either a hand-built set, or one stored before provenance existed and not
  /// recognisable as any current edition.
  templateVersion: number;
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
  templateVersion: number;
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
    templateVersion: 1,
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
    templateVersion: 1,
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
    templateVersion: 1,
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

// ── Provenance ──────────────────────────────────────────────────────────────
// Where each built-in rule comes from, and — just as important — where its
// source stops and our own judgement starts.
//
// Provenance is deliberately NOT a field on RuleSetDoc and is NEVER sent to a
// model. Three reasons, in order of weight:
//   1. Honesty. A citation copied into a saved doc freezes at save time. Keeping
//      provenance in the catalogue means the panel always shows the CURRENTLY
//      reviewed source, and a re-review corrects every set at once instead of
//      only the ones created afterwards.
//   2. Correctness of the prompt. The agent is bound by the rule body. Feeding
//      it rationale and caveats invites it to argue with its own instructions.
//   3. Cost. 21 rules × citations is prompt weight no run asked for.
// It is linked to a rule by its `topic::stance` key, which is what actually
// identifies a position; edit either and the link honestly drops (see
// `provenanceForRule`), because the rule is then the user's, not the source's.

export const RULE_SET_SOURCES: Record<RuleSetSourceId, RuleSetCitation> = {
  // — software development —
  "src:fowler-self-testing-code": {
    id: "src:fowler-self-testing-code",
    title: "Self Testing Code",
    publisher: "Martin Fowler (martinfowler.com)",
    url: "https://martinfowler.com/bliki/SelfTestingCode.html",
    published: "2014-05-01",
    reviewedAt: RULE_SET_PROVENANCE_REVIEWED_AT,
    kind: "practice",
    scope: "General software practice; no standards body behind it.",
  },
  "src:google-sre-postmortem": {
    id: "src:google-sre-postmortem",
    title: "Postmortem Culture: Learning from Failure (Site Reliability Engineering)",
    publisher: "Lunney & Lueder, Google / O'Reilly Media",
    url: "https://sre.google/sre-book/postmortem-culture/",
    published: "2017",
    reviewedAt: RULE_SET_PROVENANCE_REVIEWED_AT,
    kind: "practice",
    scope: "Incident review at one company; published as industry practice, not a standard.",
  },
  "src:nist-ssdf-800-218": {
    id: "src:nist-ssdf-800-218",
    title: "NIST SP 800-218, Secure Software Development Framework (SSDF) Version 1.1",
    publisher: "US National Institute of Standards and Technology",
    url: "https://csrc.nist.gov/pubs/sp/800/218/final",
    published: "2022-02-03",
    reviewedAt: RULE_SET_PROVENANCE_REVIEWED_AT,
    kind: "standard",
    scope: "US federal software producers; advisory elsewhere. Status confirmed Final on review.",
  },
  "src:cwe-798": {
    id: "src:cwe-798",
    title: "CWE-798: Use of Hard-coded Credentials (CWE 4.20)",
    publisher: "MITRE",
    url: "https://cwe.mitre.org/data/definitions/798.html",
    published: "CWE 4.20; entry listed #13 in the 2024 CWE Top 25",
    reviewedAt: RULE_SET_PROVENANCE_REVIEWED_AT,
    kind: "standard",
    scope: "Weakness taxonomy — classifies the defect, does not impose a process.",
  },
  "src:dora-capabilities": {
    id: "src:dora-capabilities",
    title: "DORA DevOps capabilities — Test Automation, Small Batch Size, Continuous Delivery",
    publisher: "DORA / Google Cloud",
    url: "https://docs.cloud.google.com/architecture/devops",
    published: "Continuously updated; research programme running since 2014",
    reviewedAt: RULE_SET_PROVENANCE_REVIEWED_AT,
    kind: "guideline",
    scope: "Survey-based research on delivery performance; correlational, self-reported.",
  },

  // — scientific research —
  "src:asa-p-values": {
    id: "src:asa-p-values",
    title: "The ASA Statement on p-Values: Context, Process, and Purpose",
    publisher: "Wasserstein & Lazar, The American Statistician 70(2):129–133",
    url: "https://doi.org/10.1080/00031305.2016.1154108",
    published: "2016",
    reviewedAt: RULE_SET_PROVENANCE_REVIEWED_AT,
    kind: "peer-reviewed",
    scope: "Statistical inference generally; a statement of principles, not a reporting template.",
  },
  "src:altman-bland-1995": {
    id: "src:altman-bland-1995",
    title: "Statistics Notes: Absence of evidence is not evidence of absence",
    publisher: "Altman & Bland, BMJ 1995;311:485",
    url: "https://doi.org/10.1136/bmj.311.7003.485",
    published: "1995-08-19",
    reviewedAt: RULE_SET_PROVENANCE_REVIEWED_AT,
    kind: "peer-reviewed",
    scope: "Interpretation of non-significant results; written for clinical research.",
  },
  "src:top-2025": {
    id: "src:top-2025",
    title: "TOP 2025: An update to the Transparency and Openness Promotion Guidelines",
    publisher: "Center for Open Science; Research Integrity and Peer Review",
    url: "https://doi.org/10.1186/s41073-026-00223-0",
    published: "TOP 2025 (supersedes TOP 2015)",
    reviewedAt: RULE_SET_PROVENANCE_REVIEWED_AT,
    kind: "guideline",
    scope: "Journal and funder POLICY framework — binds participating journals, not individuals.",
  },
  "src:fair-2016": {
    id: "src:fair-2016",
    title: "The FAIR Guiding Principles for scientific data management and stewardship",
    publisher: "Wilkinson et al., Scientific Data 3:160018",
    url: "https://doi.org/10.1038/sdata.2016.18",
    published: "2016",
    reviewedAt: RULE_SET_PROVENANCE_REVIEWED_AT,
    kind: "peer-reviewed",
    scope: "Machine-actionable data publication; about published datasets, not working notes.",
  },
  "src:consort-2025": {
    id: "src:consort-2025",
    title: "CONSORT 2025 statement: updated guideline for reporting randomised trials",
    publisher: "CONSORT Group (BMJ, Lancet, JAMA, Nature Medicine, PLOS Medicine)",
    url: "https://doi.org/10.1136/bmj-2024-081123",
    published: "2025-04-14",
    reviewedAt: RULE_SET_PROVENANCE_REVIEWED_AT,
    kind: "guideline",
    scope: "Randomised trials only. A 30-item reporting checklist, not a method.",
  },
  "src:icmje-2025": {
    id: "src:icmje-2025",
    title: "ICMJE Recommendations for the Conduct, Reporting, Editing, and Publication of Scholarly Work in Medical Journals",
    publisher: "International Committee of Medical Journal Editors",
    url: "https://www.icmje.org/recommendations/",
    published: "Updated January 2025",
    reviewedAt: RULE_SET_PROVENANCE_REVIEWED_AT,
    kind: "guideline",
    scope: "Medical-journal submissions at participating journals.",
  },

  // — social media / influencer —
  "src:ftc-endorsement-guides": {
    id: "src:ftc-endorsement-guides",
    title: "16 CFR Part 255 — Guides Concerning Use of Endorsements and Testimonials in Advertising",
    publisher: "US Federal Trade Commission",
    url: "https://www.ecfr.gov/current/title-16/chapter-I/subchapter-B/part-255",
    published: "Revised 2023 (published in the Federal Register 2023-07-26)",
    reviewedAt: RULE_SET_PROVENANCE_REVIEWED_AT,
    kind: "guideline",
    scope: "US. Administrative GUIDES, not a rule — they state how the FTC reads existing law.",
  },
  "src:ftc-reviews-rule": {
    id: "src:ftc-reviews-rule",
    title: "16 CFR Part 465 — Rule on the Use of Consumer Reviews and Testimonials",
    publisher: "US Federal Trade Commission",
    url: "https://www.ecfr.gov/current/title-16/chapter-I/subchapter-D/part-465",
    published: "Final rule effective 2024-10-21",
    reviewedAt: RULE_SET_PROVENANCE_REVIEWED_AT,
    kind: "regulation",
    scope: "US, binding. Expressly reaches AI-generated reviews and bought indicators of influence.",
  },
  "src:eu-ai-act-art50": {
    id: "src:eu-ai-act-art50",
    title: "EU AI Act (Regulation (EU) 2024/1689), Article 50 — transparency obligations",
    publisher: "European Union",
    url: "https://digital-strategy.ec.europa.eu/en/faqs/transparency-obligations-under-article-50-ai-act",
    published: "Article 50 applicable from 2026-08-02",
    reviewedAt: RULE_SET_PROVENANCE_REVIEWED_AT,
    kind: "regulation",
    scope: "EU, binding. Deepfakes (Art. 3(60)) and AI text published on matters of public interest.",
  },
  "src:asa-cap-influencers": {
    id: "src:asa-cap-influencers",
    title: "Influencers' guide to making clear that ads are ads (3rd edition)",
    publisher: "UK Advertising Standards Authority / CAP, with the CMA",
    url: "https://www.asa.org.uk/resource/influencers-guide.html",
    published: "2023-03-23",
    reviewedAt: RULE_SET_PROVENANCE_REVIEWED_AT,
    kind: "guideline",
    scope: "UK. Guidance to the CAP Code (rule 2.1: ads must be obviously identifiable).",
  },
  "src:wcag22": {
    id: "src:wcag22",
    title: "Web Content Accessibility Guidelines (WCAG) 2.2 — SC 1.1.1 Non-text Content, SC 1.2.2 Captions (both level A)",
    publisher: "W3C",
    url: "https://www.w3.org/TR/WCAG22/",
    published: "W3C Recommendation 2024-12-12",
    reviewedAt: RULE_SET_PROVENANCE_REVIEWED_AT,
    kind: "standard",
    scope: "Web content. Legally referenced in some jurisdictions; social platforms are not bound by it.",
  },
};

export const RULE_SET_TEMPLATE_PROVENANCE: Record<RuleSetTemplateId, RuleSetTemplateProvenance> = {
  softwareDevelopment: {
    templateId: "softwareDevelopment",
    templateVersion: 1,
    reviewedAt: RULE_SET_PROVENANCE_REVIEWED_AT,
    sources: [
      "src:fowler-self-testing-code",
      "src:google-sre-postmortem",
      "src:nist-ssdf-800-218",
      "src:cwe-798",
      "src:dora-capabilities",
    ],
    limitations: [
      "No cited source is a certification standard: only SSDF and CWE are issued by a standards body, and neither prescribes a development workflow.",
      "Two rules — cite-code-locations and plain-technical — carry NO external citation. They are OWLLM operating practice, kept because they are enforceable and cheap, not because a body endorses them.",
      "DORA's evidence is survey-based and correlational. It supports 'small batches ship better', not any particular diff.",
      "The sources are Anglophone industry practice; they say nothing about regulated software (medical, avionics, automotive), which needs its own rule set.",
    ],
  },
  scientificResearch: {
    templateId: "scientificResearch",
    templateVersion: 1,
    reviewedAt: RULE_SET_PROVENANCE_REVIEWED_AT,
    sources: [
      "src:asa-p-values",
      "src:altman-bland-1995",
      "src:top-2025",
      "src:fair-2016",
      "src:consort-2025",
      "src:icmje-2025",
    ],
    limitations: [
      "The reporting-reform literature cited here is overwhelmingly biomedical and psychological. CONSORT covers randomised trials only; ICMJE binds medical-journal submissions. Engineering measurement, simulation and qualitative work inherit the spirit, not the checklists.",
      "TOP and ICMJE are policies for JOURNALS and their authors. Nothing in them binds an agent, and adopting this template is not a claim of compliance with either.",
      "These rules improve how a result is reported. They cannot make an underpowered or badly designed study informative.",
      "Frequentist framing throughout. A Bayesian or decision-theoretic project will want to fork the uncertainty rule rather than inherit it.",
    ],
  },
  socialMedia: {
    templateId: "socialMedia",
    templateVersion: 1,
    reviewedAt: RULE_SET_PROVENANCE_REVIEWED_AT,
    sources: [
      "src:ftc-endorsement-guides",
      "src:ftc-reviews-rule",
      "src:eu-ai-act-art50",
      "src:asa-cap-influencers",
      "src:wcag22",
    ],
    limitations: [
      "NOT LEGAL ADVICE. Three regimes are cited — US, UK and EU — with different triggers, different geography and different force. The rules state the strictest common denominator so that following them is unlikely to breach any one of them; that is not the same as compliance with the one that actually applies to you.",
      "Obligations usually follow the AUDIENCE, not the creator. A post made outside the EU that reaches EU users can still engage Article 50.",
      "Platform terms of service are a separate, unlisted obligation, change without notice, and are frequently stricter than any of the cited law.",
      "Three rules — attribute-once-in-post, hook-led-conversational and sustainable-schedule — carry no external citation and are editorial convention. In particular, attribution is not a licence and does not discharge copyright.",
    ],
  },
};

/// Keyed by `topic::stance`, which is what identifies a POSITION — the thing a
/// source can actually back. Every key here is unique across the three
/// templates, and the gate proves it: a collision would silently attach one
/// domain's citations to another domain's rule.
export const RULE_PROVENANCE: Record<string, RuleProvenance> = {
  // — software development —
  "root-cause::prove-mechanism-then-fix": {
    rationale:
      "A fix aimed at a mechanism nobody demonstrated is a guess, and it will be mistaken for a solved problem. Postmortem practice makes understanding the contributing cause the precondition for the action item, not a nicety after it.",
    sources: ["src:google-sre-postmortem"],
    limitation:
      "The SRE chapter is about reviewing incidents, not about every code change; it also emphasises multiple contributing causes over a single 'root cause'. Demanding a named mechanism on routine changes is OWLLM's extension, and it is overhead on a typo-level fix.",
  },
  "verification::execute-before-claiming": {
    rationale:
      "Reasoning about whether a change works is not evidence that it works; DORA treats automated verification as the capability that lets teams ship without breaking things.",
    sources: ["src:dora-capabilities"],
    limitation:
      "DORA validates test automation as a delivery capability. It says nothing about confirming that the artifact you observed is the one you changed — that clause has no external source and comes from this project's own history of concluding a fix worked while running a stale build.",
  },
  "regression-guard::check-fails-on-old-code": {
    rationale:
      "A test written after the fix can pass for the wrong reason. Fowler describes the standard practice directly: teams 'first write a test that exposes the bug, and only then try to fix it', which is what proves the check would have caught it.",
    sources: ["src:fowler-self-testing-code", "src:dora-capabilities"],
    limitation:
      "Fowler assumes a human team with an existing self-testing suite. The second half of the rule — wire it into the gate that actually runs, and confirm the gate discovers it — is OWLLM's addition, written after guards that existed in the tree but were never executed.",
  },
  "change-size::smallest-correct-change": {
    rationale:
      "Small batches shorten feedback and make a failure attributable to one change; DORA finds small batch size among the capabilities that predict better delivery outcomes.",
    sources: ["src:dora-capabilities"],
    limitation:
      "DORA measures batch size in terms of deployable units and lead time, not diff hygiene inside a single change. Reading it as 'keep unrelated refactors out of this commit' is an extrapolation, and 'smallest' must never be traded against 'fully resolves'.",
  },
  "secrets::never-embed": {
    rationale:
      "Credentials compiled into a product cannot be rotated by the people they endanger. MITRE classes this as CWE-798 and it sat at #13 in the 2024 CWE Top 25; SSDF asks that credentials be protected as part of producing well-secured software.",
    sources: ["src:cwe-798", "src:nist-ssdf-800-218"],
    limitation:
      "CWE-798 addresses credentials inside the product and prescribes storing them 'outside of the code' — it does not describe a build pipeline that sweeps a developer's key into an installer, which is the failure this project actually had. SSDF practices are organisational and need local interpretation.",
  },
  "sourcing::cite-code-locations": {
    rationale:
      "A claim about code that points at a file and line can be checked in seconds; one that comes from recollection cannot be checked at all, and plausible-sounding recollection is the most expensive kind of wrong.",
    sources: [],
    limitation:
      "No external authority is claimed. This is OWLLM operating practice, adopted because file:line references are cheap to produce and immediately falsifiable.",
  },
  "tone::plain-technical": {
    rationale:
      "Promotional framing of an engineering result hides the part the reader needs — what was not done, and what was not verified.",
    sources: [],
    limitation:
      "No external authority is claimed; this is a house style. It is also the rule most likely to be overridden deliberately, which is why it declares the `tone` axis rather than applying unconditionally.",
  },

  // — scientific research —
  "hypothesis::state-falsifier-first": {
    rationale:
      "An explanation chosen after seeing the data describes that data rather than predicting anything. TOP exists to make the commitment — registration, protocol, analysis plan — visible before the result is known.",
    sources: ["src:top-2025"],
    limitation:
      "TOP 2025 is a policy framework for journals and funders: it asks that preregistration be required and reported, not that an individual analyst write down a falsifier. It has no force outside participating journals, and exploratory work is legitimate as long as it is labelled as such.",
  },
  "sourcing::cite-primary-sources": {
    rationale:
      "A summary can drop the caveat that mattered. ICMJE's January 2025 update added an explicit author responsibility for the accuracy of cited references.",
    sources: ["src:icmje-2025"],
    limitation:
      "ICMJE binds submissions to participating medical journals, and its reference rules concern accuracy and verification rather than a general prohibition on citing reviews. Secondary sources are legitimate when the primary is inaccessible — the requirement is that the layer is visible.",
  },
  "uncertainty::effect-size-with-interval": {
    rationale:
      "The ASA statement is explicit that a p-value does not measure the size or importance of an effect, and that no single index substitutes for scientific reasoning; the magnitude with its interval is what a reader can act on.",
    sources: ["src:asa-p-values", "src:consort-2025"],
    limitation:
      "The ASA statement is a set of principles, not a reporting template. CONSORT's 'estimate with precision' item is written for randomised trials; most agent work is not a trial, and an interval computed on a convenience sample carries assumptions the interval itself does not display.",
  },
  "instrument::validate-before-trusting-a-null": {
    rationale:
      "Altman & Bland's point is that a non-significant result is not proof of no effect. A measurement that could not have detected the effect is not evidence against it — it is no evidence at all.",
    sources: ["src:altman-bland-1995"],
    limitation:
      "Altman & Bland prescribe reporting confidence intervals; they do not prescribe a positive control. 'Show the instrument could have detected one' is OWLLM's operational restatement, generalised from clinical statistics to debugging and measurement, where a positive control is usually the cheaper move.",
  },
  "negative-results::report-them-fully": {
    rationale:
      "Selectively reporting what worked biases the record for everyone who reads it next, including your future self repeating the failed attempt. TOP's transparency standards and CONSORT's requirement to report all outcomes both exist to close that gap.",
    sources: ["src:top-2025", "src:consort-2025"],
    limitation:
      "Both sources address publication of studies, where the reporting-bias evidence was gathered. Applying them to a working log is a judgement call, and 'same detail as successful ones' is a house standard rather than anything either source specifies.",
  },
  "reproducibility::record-method-and-environment": {
    rationale:
      "A number nobody can reproduce is an anecdote. FAIR articulates what makes a result reusable by someone other than its author, and TOP's materials, code and data standards ask for the same artifacts.",
    sources: ["src:fair-2016", "src:top-2025"],
    limitation:
      "FAIR is about machine-actionable PUBLISHED data — findable, accessible, interoperable, reusable — not about capturing seeds and environments in a working note. That mapping is OWLLM's, and it deliberately asks for less than FAIR does: no persistent identifier, no metadata schema.",
  },
  "tone::precise-and-hedged": {
    rationale:
      "Confidence that outruns the evidence is the failure mode this whole template exists to prevent; the ASA statement's closing principle is that contextual reasoning, not a single index, carries the claim.",
    sources: ["src:asa-p-values"],
    limitation:
      "Derived from a principle about statistical inference. The ASA statement says nothing about vocabulary or promotional framing — the writing guidance is OWLLM's, and over-hedging is its own failure.",
  },

  // — social media / influencer —
  "disclosure::label-paid-and-synthetic": {
    rationale:
      "The audience cannot discount what it cannot see. The FTC Guides require a material connection to be disclosed clearly and conspicuously, the CAP Code requires ads to be obviously identifiable (rule 2.1), and EU AI Act Article 50 requires deepfakes to be labelled — so 'in the post itself, not only a platform toggle' is the only formulation that satisfies all three.",
    sources: ["src:ftc-endorsement-guides", "src:asa-cap-influencers", "src:eu-ai-act-art50"],
    limitation:
      "Three regimes, three different triggers and geographies, and different force: the FTC Guides are guidance rather than a rule, the CAP Code is UK self-regulation, and Article 50 became applicable on 2026-08-02 and reaches deepfakes and certain public-interest AI text — not every AI-assisted edit. This is the strictest common denominator, not legal advice.",
  },
  "claims::no-fabricated-proof": {
    rationale:
      "Invented social proof is the one thing in this domain that is squarely illegal rather than merely inadvisable: 16 CFR Part 465 has been binding in the US since 2024-10-21 and expressly reaches AI-generated reviews and bought indicators of influence.",
    sources: ["src:ftc-reviews-rule", "src:ftc-endorsement-guides"],
    limitation:
      "Part 465 is US-only and is aimed at businesses, insiders and review brokers; it does not by its terms govern a private individual's organic post outside the US. The rule applies the prohibition unconditionally as OWLLM policy, which is stricter than the cited law.",
  },
  "sourcing::attribute-once-in-post": {
    rationale:
      "Credit that the audience can actually see is what distinguishes reuse from appropriation, and putting it in the post survives the caption being cropped or re-shared.",
    sources: [],
    limitation:
      "No cited authority, and one important gap: ATTRIBUTION IS NOT A LICENCE. Crediting a photographer does not create a right to use the photograph. The 'once per post' formulation is editorial convention.",
  },
  "tone::hook-led-conversational": {
    rationale:
      "Attention is allocated in the first line, and a post nobody reads helps nobody. The constraint is that the hook must not displace the disclosure — ASA guidance treats a label the audience cannot see up front as inadequate.",
    sources: ["src:asa-cap-influencers"],
    limitation:
      "The citation supports only the constraint, not the style: no source is claimed for hook-led writing being effective. That half is editorial convention and is platform- and niche-dependent.",
  },
  "format::native-per-platform": {
    rationale:
      "One asset cross-posted unchanged is illegible somewhere. Alt text and captions are the part of this that is not taste: WCAG 2.2 makes text alternatives (SC 1.1.1) and captions for prerecorded media (SC 1.2.2) level-A requirements.",
    sources: ["src:wcag22"],
    limitation:
      "WCAG 2.2 is a W3C Recommendation for web content; social platforms are not bound by it, and it constrains only the accessibility clauses. Length, aspect ratio and hashtag conventions have no standards body and change whenever a platform changes.",
  },
  "cadence::sustainable-schedule": {
    rationale:
      "A cadence that collapses under one bad week costs more reach than the smaller cadence it replaced, and recovery is slower than the gap.",
    sources: [],
    limitation:
      "No cited authority. Published claims about optimal posting frequency are platform-, niche- and era-specific, and none was verified for this template; treat this as an operational preference, not a finding.",
  },
  "brand-safety::review-before-publish": {
    rationale:
      "Publishing is not reversible — content is cached, screenshotted and indexed before a deletion propagates — and every legal obligation in this template attaches at the moment of publication, when a review can still change the outcome.",
    sources: ["src:ftc-endorsement-guides", "src:ftc-reviews-rule", "src:eu-ai-act-art50"],
    limitation:
      "The cited regimes give the review something to check against, but none of them mandates a pre-publication review step; the workflow is OWLLM's. Platform terms and usage rights are a separate obligation with no source listed here.",
  },
};

/// The key a rule's provenance is filed under. A rule with no topic declares no
/// position, so it can have no cited position either.
export function provenanceKeyOf(rule: Pick<RuleSetRule, "topic" | "stance">): string {
  const topic = rule.topic.trim();
  const stance = rule.stance.trim();
  return topic && stance ? `${topic}::${stance}` : "";
}

/// Provenance for a rule, or null when the rule takes a position no built-in
/// template does. Editing the topic or the stance drops the link ON PURPOSE:
/// the citation backed the original position, and continuing to show it against
/// a changed one would be the fabrication this whole module exists to prevent.
export function provenanceForRule(rule: Pick<RuleSetRule, "topic" | "stance">): RuleProvenance | null {
  const key = provenanceKeyOf(rule);
  return key ? RULE_PROVENANCE[key] ?? null : null;
}

export function citationsFor(provenance: RuleProvenance | null): RuleSetCitation[] {
  if (!provenance) return [];
  return provenance.sources.flatMap(id => {
    const citation = RULE_SET_SOURCES[id];
    return citation ? [citation] : [];
  });
}

export function templateProvenanceOf(templateId: string): RuleSetTemplateProvenance | null {
  return isRuleSetTemplateId(templateId) ? RULE_SET_TEMPLATE_PROVENANCE[templateId] : null;
}

export function templateCitationsOf(templateId: string): RuleSetCitation[] {
  const provenance = templateProvenanceOf(templateId);
  if (!provenance) return [];
  return provenance.sources.flatMap(id => {
    const citation = RULE_SET_SOURCES[id];
    return citation ? [citation] : [];
  });
}

/// Which built-in edition a stored set still matches, by the POSITIONS it takes.
/// Returns 0 for "no current edition" — a fork that changed a stance, a set built
/// from scratch, or one stored before templateVersion existed and since diverged.
/// Limitation, stated because the UI reports this number: it can only distinguish
/// editions that differ in their topic/stance keys. Two editions that changed only
/// a rule BODY are indistinguishable here, so a match means "same positions",
/// not "same words".
export function templateEditionOf(doc: Pick<RuleSetDoc, "templateId" | "rules">): number {
  if (!isRuleSetTemplateId(doc.templateId)) return 0;
  const template = RULE_SET_TEMPLATES[doc.templateId];
  const expected = new Set(template.rules.map(rule => provenanceKeyOf(rule)));
  const actual = doc.rules.map(rule => provenanceKeyOf(rule));
  if (actual.length !== expected.size) return 0;
  return actual.every(key => key && expected.has(key)) ? template.templateVersion : 0;
}

/// Forward-migrate a stored set. Sets written before provenance existed have no
/// `templateVersion`; rather than assume, we re-derive it from the positions the
/// set actually takes, so a customised old set is honestly reported as edition 0
/// instead of claiming a provenance it no longer matches.
export function migrateRuleSetDoc(stored: Partial<RuleSetDoc> & Pick<RuleSetDoc, "id">): RuleSetDoc {
  const rules = (stored.rules ?? []).map(rule => ({ ...rule }));
  const templateId = stored.templateId ?? "custom";
  const base = {
    ...stored,
    schemaVersion: RULE_SET_SCHEMA_VERSION,
    revision: stored.revision ?? 1,
    templateId,
    name: stored.name ?? "Untitled rule set",
    summary: stored.summary ?? "",
    priority: stored.priority ?? 50,
    rules,
    projectId: (stored.projectId ?? "").trim(),
    private: stored.private ?? true,
    status: stored.status ?? "draft",
    createdAt: stored.createdAt ?? "",
    updatedAt: stored.updatedAt ?? "",
  } as RuleSetDoc;
  return {
    ...base,
    templateVersion:
      typeof stored.templateVersion === "number" && stored.templateVersion > 0
        ? stored.templateVersion
        : templateEditionOf(base),
  };
}

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
    templateVersion: template.templateVersion,
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
    // The fork keeps the edition it was taken FROM. It is no longer a built-in,
    // but "forked from software development v1" is a true and useful statement,
    // and templateEditionOf still reports 0 the moment a stance is changed.
    templateVersion: source.templateVersion,
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
    templateVersion: 0,
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
    templateVersion: Math.max(0, Math.floor(Number(doc.templateVersion) || 0)),
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
