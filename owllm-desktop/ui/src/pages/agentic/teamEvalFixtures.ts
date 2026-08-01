// Team eval fixtures — the per-team "what SHOULD happen" catalog that Layer 2
// grades live runs against (see runTrace.ts / team.eval.run.mjs).
//
// Each fixture is one (team, goal) scenario plus the OBJECTIVE expectations for
// it. A fixture only asserts what it cares about; omitted fields aren't checked.
//
// Since the profile conversion, every bundled team runs the same generic
// roster: orchestrator + generalist (solo_generalist, all tools) +
// critical_thinker (advisory). The canonical behaviors these fixtures protect
// are therefore: execution work must land on the WRITE-CAPABLE generalist
// (never the read-only orchestrator or the advisory critic), code goals must
// actually change files, and trivial questions must stay slim. The old
// per-lane routing fixtures (frontend vs backend coder, docs lane) died with
// the specialist rosters — lane routing still has synthetic-roster coverage in
// routing.verify.run.mjs for user-authored custom teams.

import type { TeamExpectation } from "./runTrace";

export const TEAM_FIXTURES: TeamExpectation[] = [
  // ── product_studio — the design-led profile the "Product Owner did my bug
  //    fix" bug kept appearing on. Code work must reach the generalist and ship.
  {
    team: "product_studio",
    goal: "fix the image-paste bug in CodePage and commit it",
    note: "small code fix on a design-led profile — must reach the write-capable generalist, not the critic, and actually change a file",
    expectKind: "code", expectAgent: "generalist",
    expectWrote: true, expectDone: true, maxHops: 12,
  },
  {
    team: "product_studio",
    goal: "fix the broken /publish API endpoint on the server and commit it",
    note: "backend code work — same generalist owns every lane now; must write",
    expectKind: "code", expectAgent: "generalist",
    expectWrote: true, expectDone: true, maxHops: 12,
  },
  {
    team: "product_studio",
    goal: "who is on this team and what do you do?",
    note: "trivial question — a slim, fast round; no code, no design work",
    expectKind: "general", expectWrote: false, expectDone: true, forbidDomain: "design", maxHops: 4,
  },
  {
    team: "product_studio",
    goal: "design a brand-new onboarding screen from scratch",
    note: "genuine greenfield design — lands on the generalist (design phase gated on approval per the profile prompt)",
    expectKind: "design", expectAgent: "generalist", expectDone: true,
  },

  // ── dev_squad — a code profile; a refactor must reach the generalist and ship.
  {
    team: "dev_squad",
    goal: "refactor the dispatch module and run the tests",
    note: "code work on a code profile",
    expectKind: "code", expectAgent: "generalist",
    expectWrote: true, expectDone: true, maxHops: 12,
  },

  // ── bug_hunter — reproduce + fix; a code goal must write a real patch.
  {
    team: "bug_hunter",
    goal: "the orchestrator crashes after a few seconds — find and fix it",
    note: "crash report (inflected) — must classify as code and produce a write",
    expectKind: "code", expectAgent: "generalist", expectWrote: true, expectDone: true, maxHops: 14,
  },

  // ── data_analyst — code-classified analytics work must reach the generalist.
  {
    team: "data_analyst",
    goal: "fix the monthly-revenue SQL query and commit it",
    note: "code-classified analytics work must reach the write-capable generalist",
    expectKind: "code", expectAgent: "generalist",
    expectWrote: true, expectDone: true, maxHops: 10,
  },

  // ── writers_room — docs goal must not be write-gated like code.
  {
    team: "writers_room",
    goal: "update the README and changelog for the v0.7 release",
    note: "docs goal (changelog must NOT read as code) — reaches the generalist",
    expectKind: "docs", expectAgent: "generalist", expectDone: true, maxHops: 10,
  },

  // ── research_lab — analysis profile; a summary is general + needs no write.
  {
    team: "research_lab",
    goal: "summarize the latest research on model abliteration",
    note: "pure analysis — must NOT be gated on file writes",
    expectKind: "general", expectWrote: false, expectDone: true, maxHops: 10,
  },
];
