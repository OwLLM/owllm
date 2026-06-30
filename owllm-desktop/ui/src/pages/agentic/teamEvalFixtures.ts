// Team eval fixtures — the per-team "what SHOULD happen" catalog that Layer 2
// grades live runs against (see runTrace.ts / team.eval.run.mjs).
//
// Each fixture is one (team, goal) scenario plus the OBJECTIVE expectations for
// it. A fixture only asserts what it cares about; omitted fields aren't checked.
// These are the canonical behaviors per team: a small code fix must reach a coder
// and actually change files; a trivial question must stay slim; real design work
// must engage the design lane. Add scenarios here as teams grow — the grader and
// the in-app Run Report both read this same shape.

import type { TeamExpectation } from "./runTrace";

export const TEAM_FIXTURES: TeamExpectation[] = [
  // ── product_studio — the design-led team the "Product Owner did my bug fix"
  //    bug kept appearing on. Code work must land on @frontend_coder and ship.
  {
    team: "product_studio",
    goal: "fix the image-paste bug in CodePage and commit it",
    note: "small code fix on a design-led team — must reach a coder, not the product owner, and actually change a file",
    expectKind: "code", expectDomain: "coder", expectAgent: "frontend_coder",
    expectWrote: true, expectDone: true, maxHops: 12,
  },
  {
    team: "product_studio",
    goal: "fix the broken /publish API endpoint on the server and commit it",
    note: "backend code work on a team with both coders — must reach the BACKEND coder, not the frontend coder that is listed first in roster order",
    expectKind: "code", expectDomain: "coder", expectAgent: "backend_coder",
    expectWrote: true, expectDone: true, maxHops: 12,
  },
  {
    team: "product_studio",
    goal: "who is on this team and what do you do?",
    note: "trivial question — a slim, fast round; no code, no design lane",
    expectKind: "general", expectWrote: false, expectDone: true, forbidDomain: "design", maxHops: 4,
  },
  {
    team: "product_studio",
    goal: "design a brand-new onboarding screen from scratch",
    note: "genuine greenfield design — the design lane SHOULD engage",
    expectKind: "design", expectDomain: "design", expectDone: true,
  },

  // ── dev_squad — a code team; a refactor must reach the coder and ship.
  {
    team: "dev_squad",
    goal: "refactor the dispatch module and run the tests",
    note: "code work on a code team",
    expectKind: "code", expectDomain: "coder", expectAgent: "coder",
    expectWrote: true, expectDone: true, maxHops: 12,
  },

  // ── bug_hunter — reproduce + fix; a code goal must reach the reproducer/coder.
  {
    team: "bug_hunter",
    goal: "the orchestrator crashes after a few seconds — find and fix it",
    note: "crash report (inflected) — must classify as code and reach a coder",
    expectKind: "code", expectDomain: "coder", expectWrote: true, expectDone: true, maxHops: 14,
  },

  // ── data_analyst — has a coder lane (@sql_writer).
  {
    team: "data_analyst",
    goal: "fix the monthly-revenue SQL query and commit it",
    note: "code-classified analytics work must reach the SQL coder",
    expectKind: "code", expectDomain: "coder", expectAgent: "sql_writer",
    expectWrote: true, expectDone: true, maxHops: 10,
  },

  // ── writers_room — docs goal stays in the docs lane; no write-gate.
  {
    team: "writers_room",
    goal: "update the README and changelog for the v0.7 release",
    note: "docs goal (changelog must NOT read as code) routes to the docs lane",
    expectKind: "docs", expectDomain: "docs", expectDone: true, maxHops: 10,
  },

  // ── research_lab — analysis team, no coder; a summary is general + needs no write.
  {
    team: "research_lab",
    goal: "summarize the latest research on model abliteration",
    note: "pure analysis — must NOT be gated on file writes",
    expectKind: "general", expectWrote: false, expectDone: true, maxHops: 10,
  },
];
