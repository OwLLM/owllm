// Pure specialist-to-specialist routing. Kept outside dispatch.ts so the
// executable routing verifier can exercise the exact production decisions
// without loading Tauri, React, or provider clients.

import { parseDispatchesDetailed, type Dispatch } from "./dispatchParse";
import {
  isReviewAgent,
  reviewRepairTargets,
  shouldRepeatReview,
} from "./teamConfig";

export type HandoffAgent = { name: string; base: string; role?: "leader" | "agent" };
export type HandoffTeam = {
  agents: HandoffAgent[];
  edges: Array<{ source: string; target: string }>;
};

export type Handoff = { name: string; input: string; explicit: boolean };
export type HandoffPlan = {
  hands: Handoff[];
  capped: string[];
  diagnostics: string[];
};
export type HandoffResult = { name: string; text: string };

export const MAX_CHAIN_HOPS = 12;
export const MAX_AGENT_RERUNS = 3;

function orchestratorName(team: HandoffTeam): string {
  const agents = team.agents;
  return (
    agents.find((agent) => agent.name === "orchestrator") ??
    agents.find((agent) => agent.base === "orchestrator") ??
    agents.find((agent) => /\borchestrator\b/i.test(agent.name) || /\borchestrator\b/i.test(agent.base)) ??
    agents[0]
  )?.name ?? "orchestrator";
}

export function downstreamTargets(
  team: Pick<HandoffTeam, "edges">,
  agentName: string,
  orchName: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const edge of team.edges ?? []) {
    if (
      edge?.source === agentName && typeof edge.target === "string" &&
      edge.target !== orchName && edge.target !== agentName && !seen.has(edge.target)
    ) {
      seen.add(edge.target);
      out.push(edge.target);
    }
  }
  return out;
}

function mergeDuplicateDispatches(dispatches: Dispatch[]): Dispatch[] {
  const merged = new Map<string, string[]>();
  for (const dispatch of dispatches) {
    const instructions = merged.get(dispatch.agentName) ?? [];
    if (!instructions.includes(dispatch.instruction)) instructions.push(dispatch.instruction);
    merged.set(dispatch.agentName, instructions);
  }
  return Array.from(merged, ([agentName, instructions]) => ({
    agentName,
    instruction: instructions.join("\n\n"),
  }));
}

function unsupportedDiagnostic(agentName: string, target: string, allowed: string[]): string {
  const roster = allowed.length ? allowed.map((name) => `@${name}`).join(", ") : "no teammates";
  return `⚠ Unsupported handoff: @${agentName} tried to route to @${target}, but the team graph allows ${roster}. The handoff was not run.`;
}

export function nextHandoffs(
  team: HandoffTeam,
  agentName: string,
  agentOutput: string,
  runCount: ReadonlyMap<string, number>,
): HandoffPlan {
  const downstream = downstreamTargets(team, agentName, orchestratorName(team));
  const repairs = reviewRepairTargets(team, agentName, agentOutput, runCount);
  const allowed = [...new Set([...downstream, ...repairs])];
  const parsed = parseDispatchesDetailed(agentOutput, team, agentName);
  const explicit = mergeDuplicateDispatches(parsed.dispatches);
  const diagnostics = [
    ...explicit
      .filter((dispatch) => !allowed.includes(dispatch.agentName))
      .map((dispatch) => unsupportedDiagnostic(agentName, dispatch.agentName, allowed)),
    ...parsed.unresolved.map((dispatch) => dispatch.reason === "empty-instruction"
      ? `⚠ Unsupported handoff: @${agentName} routed to @${dispatch.name} without an instruction. The handoff was not run.`
      : `⚠ Unsupported handoff: @${agentName} tried to route to unknown agent @${dispatch.name}. The handoff was not run.`),
  ];

  const dispatched = explicit.filter((dispatch) => allowed.includes(dispatch.agentName));
  const reviewer = team.agents.find((agent) => agent.name === agentName) ?? { name: agentName, base: "" };
  if (explicit.length > 0 || parsed.unresolved.length > 0) {
    const hands: Handoff[] = [];
    const capped: string[] = [];
    for (const dispatch of dispatched) {
      if ((runCount.get(dispatch.agentName) ?? 0) < MAX_AGENT_RERUNS) {
        hands.push({ name: dispatch.agentName, input: dispatch.instruction, explicit: true });
      } else if (!capped.includes(dispatch.agentName)) {
        capped.push(dispatch.agentName);
      }
    }
    // A reviewer's bad route is diagnosed, but it cannot turn actionable
    // findings into a terminal report. Fall back to the deterministic repair
    // edge when none of the explicit directives could run.
    if (hands.length === 0 && capped.length === 0 && isReviewAgent(reviewer)) {
      for (const target of repairs) {
        if ((runCount.get(target) ?? 0) < MAX_AGENT_RERUNS) {
          hands.push({
            name: target,
            input: `Review found defects that must be fixed before completion. Fix every actionable finding below, add/run regression coverage, verify the result, then return it for re-review.\n\n${agentOutput}`,
            explicit: true,
          });
        } else {
          capped.push(target);
        }
      }
    }
    return { hands, capped, diagnostics };
  }

  if (isReviewAgent(reviewer)) {
    const hands: Handoff[] = [];
    const capped: string[] = [];
    for (const target of repairs) {
      if ((runCount.get(target) ?? 0) < MAX_AGENT_RERUNS) {
        hands.push({
          name: target,
          input: `Review found defects that must be fixed before completion. Fix every actionable finding below, add/run regression coverage, verify the result, then return it for re-review.\n\n${agentOutput}`,
          explicit: true,
        });
      } else {
        capped.push(target);
      }
    }
    return { hands, capped, diagnostics };
  }

  const handoff = `You are continuing a team workflow. @${agentName} produced the following — build on it for YOUR part of the task:\n\n${agentOutput}`;
  const hands = allowed
    .filter((target) => (runCount.get(target) ?? 0) === 0
      || shouldRepeatReview(team, agentName, target, runCount, MAX_AGENT_RERUNS))
    .map((target) => ({ name: target, input: handoff, explicit: false }));
  return { hands, capped: [], diagnostics };
}

export function loopExhaustedNotice(
  agentName: string,
  capped: string[],
  runCount: ReadonlyMap<string, number>,
): string {
  const who = capped.map((target) => `@${target} (ran ${runCount.get(target) ?? 0}×)`).join(", ");
  return [
    `⚠ SUPERVISOR — loop did not converge: @${agentName} tried to route back to ${who}, but they reached the ${MAX_AGENT_RERUNS}-round per-agent cap.`,
    "Orchestrator: decide the next step — ship what we have, give the agent fresh direction, or ask the user. Do NOT silently re-loop.",
  ].join("\n");
}

export function handoffSupplementalResults(
  output: HandoffResult,
  plan: Pick<HandoffPlan, "capped" | "diagnostics">,
  runCount: ReadonlyMap<string, number>,
): HandoffResult[] {
  if (plan.capped.length === 0 && plan.diagnostics.length === 0) return [];
  const results = [output];
  if (plan.capped.length > 0) {
    results.push({
      name: output.name,
      text: loopExhaustedNotice(output.name, plan.capped, runCount),
    });
  }
  results.push(...plan.diagnostics.map((text) => ({ name: output.name, text })));
  return results;
}

export function handoffStopReason(
  previousOutput: string | undefined,
  currentOutput: string,
  ranAsLeader: boolean,
): "no-progress" | "leader" | null {
  if (previousOutput !== undefined && currentOutput.length > 40 && previousOutput === currentOutput) return "no-progress";
  return ranAsLeader ? "leader" : null;
}

export function runsAsSubLeader(
  spec: Pick<HandoffAgent, "name" | "role">,
  roleCanDispatch: boolean,
  orchestrator: string,
  wiredMemberCount: number,
): boolean {
  return (spec.role === "leader" || roleCanDispatch)
    && spec.name !== orchestrator
    && wiredMemberCount > 0;
}
