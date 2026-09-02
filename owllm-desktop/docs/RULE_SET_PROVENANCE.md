# Rule-set provenance — sources, rationale and limits

Where every built-in rule-set template comes from, what its sources actually say,
and — the part that matters most — where those sources stop and OWLLM's own
judgement begins.

- **Catalogue review date: 2026-09-02.** Every URL below was opened on that date
  and confirmed to still say what the rule claims. This is a *review* date, not a
  publication date.
- **Machine-readable copy:** `ui/src/pages/agentic/agentRuleSets.ts`
  (`RULE_SET_SOURCES`, `RULE_SET_TEMPLATE_PROVENANCE`, `RULE_PROVENANCE`).
  This document and that catalogue are the same content; the gate
  `ruleSetProvenance.verify.run.mjs` fails if a shipped source URL is missing here.
- **Gate:** `npm run test:rulesets` (both rule-set gates).

## How to read a citation

Each source declares a **kind**, and the kind bounds what a rule may claim:

| Kind | What it means | Example |
|---|---|---|
| `regulation` | Binding law inside its stated scope | 16 CFR Part 465; EU AI Act Art. 50 |
| `standard` | Formal specification from a standards body | NIST SP 800-218; WCAG 2.2; CWE |
| `guideline` | Issued by a named body, not itself binding | FTC Endorsement Guides; TOP; CONSORT |
| `peer-reviewed` | A paper | ASA p-values statement; Altman & Bland |
| `practice` | Documented industry practice, no body behind it | Fowler; Google SRE book |

Each also declares a **scope** — the jurisdiction or discipline it binds. A US
rule is not a worldwide obligation, and the panel shows the scope next to the
title so it cannot be read as one.

## Three design decisions

**1. Provenance is documentation, never instruction.** Rationale, citations and
limitations are shown in the configuration UI and are *never* sent to a model.
The agent is bound by the rule bodies alone. Three reasons: a citation copied
into a saved document freezes at save time, whereas the catalogue always shows
the currently reviewed source; feeding an agent the caveats behind its own
instructions invites it to argue with them; and 21 rules' worth of citations is
prompt weight no run asked for.

**2. Provenance is keyed by position, not by rule id.** The key is
`topic::stance` — what a source can actually back. Edit either and the link
drops, because the citation backed the *original* position. That is why a
hand-edited rule reads "No cited source … carries your authority, not a reviewed
one" instead of keeping a citation that no longer applies.

**3. Uncited rules are allowed, and say so.** Six of the 21 built-in rules have
no external authority. Padding them with weak citations to make the set look
rigorous is exactly the failure this feature exists to prevent, so they are
labelled as OWLLM operating practice and their limitation names them.

## Template versions

| Template | Version | Rules | Cited | Uncited |
|---|---|---|---|---|
| Software development | v1 | 7 | 5 | 2 |
| Scientific research | v1 | 7 | 7 | 0 |
| Social media / influencer | v1 | 7 | 4 | 3 |

`templateVersion` is stamped onto every set seeded from a template and bumps
whenever a rule's topic, stance or body changes. Sets stored before the field
existed load as `0` and have their edition re-derived from the positions they
still take (`templateEditionOf`), so a customised old set is honestly reported as
"no longer matches any built-in edition" rather than claiming the current one.

> **Limitation of the edition check:** it compares `topic::stance` keys only. Two
> editions differing solely in a rule *body* are indistinguishable to it. A match
> means "same positions", not "same words".

---

## 🛠 Software development (v1)

*Prove the mechanism, make the smallest correct change, leave a check behind.*

### Sources

| Source | Publisher | Edition | Kind |
|---|---|---|---|
| [Self Testing Code](https://martinfowler.com/bliki/SelfTestingCode.html) | Martin Fowler | 2014-05-01 | practice |
| [Postmortem Culture: Learning from Failure](https://sre.google/sre-book/postmortem-culture/) | Lunney & Lueder, Google / O'Reilly | 2017 | practice |
| [NIST SP 800-218, SSDF v1.1](https://csrc.nist.gov/pubs/sp/800/218/final) | NIST | 2022-02-03 (Final) | standard |
| [CWE-798: Use of Hard-coded Credentials](https://cwe.mitre.org/data/definitions/798.html) | MITRE | CWE 4.20; #13 in the 2024 CWE Top 25 | standard |
| [DORA DevOps capabilities](https://docs.cloud.google.com/architecture/devops) | DORA / Google Cloud | continuously updated | guideline |

### Rules → sources

| Rule (`topic::stance`) | Backed by | Where the source stops |
|---|---|---|
| `root-cause::prove-mechanism-then-fix` | Google SRE postmortem | Written for *incident review*, not every code change, and it emphasises multiple contributing causes over a single "root cause". Demanding a named mechanism on routine changes is OWLLM's extension. |
| `verification::execute-before-claiming` | DORA | DORA validates test automation as a delivery capability. "Confirm the artifact you observed is the one you changed" has **no external source** — it is this project's own lesson from concluding a fix worked while running a stale build. |
| `regression-guard::check-fails-on-old-code` | Fowler; DORA | Fowler states the practice directly — teams "first write a test that exposes the bug, and only then to try to fix it" — but assumes a human team with an existing suite. "Wire it into the gate that actually runs" is OWLLM's addition, after guards that existed but were never executed. |
| `change-size::smallest-correct-change` | DORA | DORA measures *deployable batch size and lead time*, not diff hygiene within one change. Reading it as "keep unrelated refactors out" is extrapolation, and "smallest" must never be traded against "fully resolves". |
| `secrets::never-embed` | CWE-798; NIST SSDF | CWE-798 prescribes storing credentials "outside of the code"; it does not describe a build pipeline sweeping a developer's key into an installer, which is the failure this project actually had. SSDF practices are organisational. |
| `sourcing::cite-code-locations` | *(none)* | **No external authority claimed.** OWLLM operating practice: file:line references are cheap to produce and immediately falsifiable. |
| `tone::plain-technical` | *(none)* | **No external authority claimed.** House style — which is why it declares the `tone` axis and can be deliberately overridden. |

### Template limitations

- Only SSDF and CWE come from a standards body, and neither prescribes a workflow. No cited source is a certification standard.
- Two rules carry no external citation.
- DORA's evidence is survey-based and correlational.
- Nothing here addresses regulated software (medical, avionics, automotive), which needs its own rule set.

---

## 🧪 Scientific research (v1)

*Name the falsifier first, report size and uncertainty, publish the nulls.*

### Sources

| Source | Publisher | Edition | Kind |
|---|---|---|---|
| [The ASA Statement on p-Values](https://doi.org/10.1080/00031305.2016.1154108) | Wasserstein & Lazar, *The American Statistician* 70(2):129–133 | 2016 | peer-reviewed |
| [Absence of evidence is not evidence of absence](https://doi.org/10.1136/bmj.311.7003.485) | Altman & Bland, *BMJ* 1995;311:485 | 1995-08-19 | peer-reviewed |
| [TOP 2025 Guidelines](https://doi.org/10.1186/s41073-026-00223-0) | Center for Open Science; *Research Integrity and Peer Review* | TOP 2025 (supersedes TOP 2015) | guideline |
| [FAIR Guiding Principles](https://doi.org/10.1038/sdata.2016.18) | Wilkinson et al., *Scientific Data* 3:160018 | 2016 | peer-reviewed |
| [CONSORT 2025 statement](https://doi.org/10.1136/bmj-2024-081123) | CONSORT Group, *The BMJ* | 2025-04-14 | guideline |
| [ICMJE Recommendations](https://www.icmje.org/recommendations/) | ICMJE | updated January 2025 | guideline |

### Rules → sources

| Rule (`topic::stance`) | Backed by | Where the source stops |
|---|---|---|
| `hypothesis::state-falsifier-first` | TOP 2025 | TOP is a **journal and funder policy** framework: it asks that preregistration be required and reported, not that an individual analyst write down a falsifier. No force outside participating journals. Exploratory work is legitimate when labelled. |
| `sourcing::cite-primary-sources` | ICMJE (Jan 2025) | The January 2025 update added an explicit author responsibility for the *accuracy* of cited references. That is not a general prohibition on citing reviews, and ICMJE binds only participating medical journals. |
| `uncertainty::effect-size-with-interval` | ASA; CONSORT 2025 | The ASA statement is principles, not a template. CONSORT item 26 asks for "the estimated effect size and its precision (such as 95% confidence interval)" — but for *randomised trials*. Most agent work is not a trial. |
| `instrument::validate-before-trusting-a-null` | Altman & Bland | They prescribe reporting confidence intervals, **not** a positive control. "Show the instrument could have detected one" is OWLLM's operational restatement, generalised to debugging where a positive control is the cheaper move. |
| `negative-results::report-them-fully` | TOP 2025; CONSORT 2025 | Both address *publication of studies*, where the reporting-bias evidence was gathered. Applying them to a working log is a judgement call. |
| `reproducibility::record-method-and-environment` | FAIR; TOP 2025 | FAIR is about machine-actionable **published data**, not working notes. The mapping is OWLLM's, and deliberately asks for less: no persistent identifier, no metadata schema. |
| `tone::precise-and-hedged` | ASA | Derived from the principle that no single index substitutes for scientific reasoning. The ASA statement says nothing about vocabulary; the writing guidance is OWLLM's, and over-hedging is its own failure. |

### Template limitations

- The reporting-reform literature cited here is overwhelmingly biomedical and psychological. Engineering measurement, simulation and qualitative work inherit the spirit, not the checklists.
- TOP and ICMJE are policies for journals and their authors. **Nothing in them binds an agent**, and adopting this template is not a claim of compliance.
- These rules improve how a result is *reported*; they cannot make an underpowered study informative.
- Frequentist framing throughout. Bayesian projects should fork the `uncertainty` rule.

---

## 📣 Social media / influencer (v1)

*Disclose the money and the synthetic media, never invent proof, review before publishing.*

> **This template is not legal advice.** It cites three regimes with different
> triggers, geography and force, and states the strictest common denominator so
> that following it is unlikely to breach any one of them. That is not the same
> as compliance with the one that actually applies to you.

### Sources

| Source | Publisher | Edition | Kind |
|---|---|---|---|
| [16 CFR Part 255 — Endorsement Guides](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-B/part-255) | US FTC | revised 2023 (Fed. Reg. 2023-07-26) | guideline |
| [16 CFR Part 465 — Consumer Reviews and Testimonials Rule](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-D/part-465) | US FTC | effective 2024-10-21 | **regulation** |
| [EU AI Act Art. 50 — transparency](https://digital-strategy.ec.europa.eu/en/faqs/transparency-obligations-under-article-50-ai-act) | European Union | applicable from 2026-08-02 | **regulation** |
| [Influencers' guide to making clear that ads are ads (3rd ed.)](https://www.asa.org.uk/resource/influencers-guide.html) | UK ASA / CAP, with the CMA | 2023-03-23 | guideline |
| [WCAG 2.2](https://www.w3.org/TR/WCAG22/) | W3C | Recommendation 2024-12-12 | standard |

### Rules → sources

| Rule (`topic::stance`) | Backed by | Where the source stops |
|---|---|---|
| `disclosure::label-paid-and-synthetic` | FTC Guides; ASA/CAP; EU AI Act Art. 50 | Three regimes, three triggers. The FTC Guides are guidance, not a rule; the CAP Code is UK self-regulation (rule 2.1 — ads must be "obviously identifiable"); Art. 50 reaches deepfakes (Art. 3(60)) and certain public-interest AI text, **not** every AI-assisted edit. "In the post itself, not only a platform toggle" is the only formulation satisfying all three. |
| `claims::no-fabricated-proof` | FTC Part 465; FTC Guides | Part 465 is binding in the US and expressly reaches AI-generated reviews and bought indicators of influence — but it is US-only and aimed at businesses, insiders and review brokers. Applying it unconditionally is **OWLLM policy, stricter than the cited law**. |
| `sourcing::attribute-once-in-post` | *(none)* | **No cited authority**, and one important gap: **attribution is not a licence.** Crediting a photographer does not create a right to use the photograph. "Once per post" is editorial convention. |
| `tone::hook-led-conversational` | ASA/CAP | The citation supports only the *constraint* — a disclosure the audience cannot see up front is inadequate. No source is claimed for hook-led writing being effective; that half is editorial convention. |
| `format::native-per-platform` | WCAG 2.2 | WCAG 2.2 makes text alternatives (SC 1.1.1) and captions for prerecorded media (SC 1.2.2) level-A requirements — but it is a W3C Recommendation for *web content*, and social platforms are not bound by it. Length, aspect ratio and hashtags have no standards body. |
| `brand-safety::review-before-publish` | FTC Guides; FTC Part 465; EU AI Act Art. 50 | The cited regimes give the review something to check against, but **none mandates a pre-publication review step** — the workflow is OWLLM's. Platform terms and usage rights are a separate obligation with no source listed. |
| `cadence::sustainable-schedule` | *(none)* | **No cited authority.** Published claims about optimal posting frequency are platform-, niche- and era-specific, and none was verified. Treat as an operational preference, not a finding. |

### Template limitations

- Not legal advice; strictest common denominator across three regimes.
- Obligations usually follow the **audience**, not the creator. A post made outside the EU that reaches EU users can still engage Article 50.
- Platform terms of service are a separate, unlisted obligation, change without notice, and are frequently stricter than any cited law.
- Three rules carry no external citation and are editorial convention.

---

## Maintaining this

When a source is amended, or the review date goes stale:

1. Re-open every URL and confirm it still supports the rule.
2. Update `reviewedAt` on the affected entries in `RULE_SET_SOURCES` *and*
   `RULE_SET_PROVENANCE_REVIEWED_AT` — the gate requires them to agree, so a
   partial re-review fails loudly instead of leaving a mixed-vintage catalogue.
3. If a rule's `topic` or `stance` changes, bump that template's
   `templateVersion`. Existing sets keep the edition they were seeded from and
   are reported as customised rather than silently re-badged.
4. Update the tables above; the gate asserts every shipped source URL appears here.

**Known staleness risks at the 2026-09-02 review:** EU AI Act Article 50 became
applicable on 2026-08-02 and its Code of Practice on Transparency of AI-generated
Content is recent, so enforcement practice is not yet settled; TOP was updated to
TOP 2025 and further guidance may follow; CWE is versioned continuously (the
cited entry is CWE 4.20).
