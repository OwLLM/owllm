// RunTrace + scorecard — Layer 2 of judging the agentic teams.
//
// Layer 1 (harness.verify / routing.verify.run.mjs) proves the deterministic
// CONTROL FLOW is correct with no model. Layer 2 judges an actual RUN: it records
// the objective signals of one dispatch (who ran, did anyone write, did the critic
// ship, did it terminate, did the done-gate pass) into a RunTrace, then scoreRun()
// grades that trace against a per-team EXPECTATION fixture. Same idea as a test
// assertion, but over a live run instead of a pure function.
//
// This file is PURE (no React/Tauri) so the node runner (team.eval.run.mjs) can
// transpile+import it and self-test scoreRun on synthetic traces, and so the app
// can build a trace and render it the same way the grader reads it.

import { classifyGoal } from "./teamConfig";
import type { GoalKind, AgentDomain } from "./teamConfig";

/// One agent's participation in a run.
export type AgentRun = { name: string; domain: AgentDomain; runs: number };

/// A structured, machine-readable record of ONE agentic run. Everything here is
/// an OBJECTIVE signal the harness already computes — no LLM judgment.
export type RunTrace = {
  team: string;               // team id/name
  goal: string;               // the user's goal text
  goalKind: GoalKind;         // classifyGoal(goal) at run time
  agents: AgentRun[];         // specialists that executed (first-run order), with domain + run count
  hops: number;               // total agent executions this run
  routeCorrections: number;   // times the HARNESS overrode the orchestrator's routing
  wroteFiles: boolean;        // a write/edit/shell/git tool fired at least once
  criticVerdict: "ship" | "concern" | null; // parsed from the critic's VERDICT line
  capHit: boolean;            // hit MAX_CHAIN_HOPS or a per-agent rerun cap
  oscillationStops: number;   // chains stopped for repeating their own output
  done: boolean;              // runIsDone(goal, wroteFiles) — the done-gate result
  durationMs: number;
  finalAnswer: string;        // the orchestrator's closing text (truncated)
  ts: number;                 // run end (epoch ms) — stamped by the caller
};

/// What a given (team, goal) run SHOULD look like. Any omitted field is not
/// checked, so a fixture only asserts what it cares about.
export type TeamExpectation = {
  team: string;
  goal: string;
  note?: string;                      // human description of the scenario
  expectKind?: GoalKind;              // classifyGoal(goal) must equal this
  expectDomain?: AgentDomain;         // ≥1 agent of this domain must have run
  expectAgent?: string;              // this specific agent must have run
  expectWrote?: boolean;             // a write tool must (not) have fired
  expectDone?: boolean;              // the done-gate result
  expectCritic?: "ship" | "concern" | "any"; // critic verdict ("any" = some verdict present)
  maxHops?: number;                  // must terminate within this many hops
  forbidDomain?: AgentDomain;        // NO agent of this domain may have run (e.g. design on a tiny code fix)
};

export type CheckResult = { name: string; pass: boolean; detail: string };
export type Scorecard = {
  team: string; goal: string;
  checks: CheckResult[];
  passed: number; failed: number; ok: boolean;
};

/// Grade a trace against an expectation. Pure + deterministic — the same grader
/// the node runner uses, so an in-app score and a CI score agree exactly.
export function scoreRun(trace: RunTrace, exp: TeamExpectation): Scorecard {
  const checks: CheckResult[] = [];
  const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });
  const ranDomains = new Set(trace.agents.map((a) => a.domain));
  const ranNames = new Set(trace.agents.map((a) => a.name));

  if (exp.expectKind !== undefined) {
    const got = classifyGoal(exp.goal);
    add("goal-classification", got === exp.expectKind, `want ${exp.expectKind}, got ${got}`);
  }
  if (exp.expectAgent !== undefined) {
    add("expected-agent-ran", ranNames.has(exp.expectAgent), `want @${exp.expectAgent}; ran ${[...ranNames].map((n) => "@" + n).join(", ") || "(none)"}`);
  }
  if (exp.expectDomain !== undefined) {
    add(`domain-${exp.expectDomain}-ran`, ranDomains.has(exp.expectDomain), `want a ${exp.expectDomain}; ran domains ${[...ranDomains].join(", ") || "(none)"}`);
  }
  if (exp.forbidDomain !== undefined) {
    add(`no-${exp.forbidDomain}-domain`, !ranDomains.has(exp.forbidDomain), `${exp.forbidDomain} must NOT run; ran domains ${[...ranDomains].join(", ") || "(none)"}`);
  }
  if (exp.expectWrote !== undefined) {
    add("wrote-files", trace.wroteFiles === exp.expectWrote, `want wrote=${exp.expectWrote}, got ${trace.wroteFiles}`);
  }
  if (exp.expectDone !== undefined) {
    add("done-gate", trace.done === exp.expectDone, `want done=${exp.expectDone}, got ${trace.done}`);
  }
  if (exp.expectCritic !== undefined) {
    const ok = exp.expectCritic === "any" ? trace.criticVerdict !== null : trace.criticVerdict === exp.expectCritic;
    add("critic-verdict", ok, `want ${exp.expectCritic}, got ${trace.criticVerdict ?? "(none)"}`);
  }
  if (exp.maxHops !== undefined) {
    add("terminated", trace.hops <= exp.maxHops && !trace.capHit, `hops=${trace.hops} (max ${exp.maxHops})${trace.capHit ? " — HIT CAP" : ""}`);
  }

  const passed = checks.filter((c) => c.pass).length;
  const failed = checks.length - passed;
  return { team: exp.team, goal: exp.goal, checks, passed, failed, ok: failed === 0 };
}

/// One-line human summary of a run — what the in-app Run Report shows at a glance.
export function summarizeTrace(t: RunTrace): string {
  const who = t.agents.length ? t.agents.map((a) => `@${a.name}${a.runs > 1 ? "×" + a.runs : ""}`).join(" ") : "(no specialist ran)";
  const bits = [
    who,
    `${t.hops} hops`,
    t.wroteFiles ? "wrote files" : "no writes",
    t.criticVerdict ? `critic:${t.criticVerdict}` : "critic:—",
    t.routeCorrections ? `${t.routeCorrections} route-fix` : null,
    t.oscillationStops ? `${t.oscillationStops} loop-stop` : null,
    t.capHit ? "CAP HIT" : null,
    t.done ? "✓ done" : "✗ NOT done",
    `${Math.round(t.durationMs / 1000)}s`,
  ].filter(Boolean);
  return bits.join(" · ");
}
