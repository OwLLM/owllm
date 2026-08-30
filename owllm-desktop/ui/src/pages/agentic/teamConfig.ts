// Team configuration normalizer — the single source of truth that keeps a
// team's parameters internally consistent. It is PURE and IDEMPOTENT, so it can
// run at BOTH save-time (Studio) and run-time (dispatch) without surprises.
//
// Why this exists: every agentic bug we chased traced back to a team whose
// parameters disagreed with each other — an orchestrator wired to no one, a
// specialist with no incoming edge (so its @dispatch was silently dropped), a
// role with no skills, a base that maps to no role. There was no layer that
// enforced "these parameters must agree". This is that layer.
//
// It does NOT invent agents or guess intent (that's the goal-aware
// auto-architect, a separate layer that builds ON this one). It takes whatever
// team you give it and makes it STRUCTURALLY VALID + RUNNABLE, reporting every
// adjustment so the UI can show the user what changed.

import type { Team, Edge, AgentSpec, RoleData } from "./dispatch";

export type RoleKind = "orchestrator" | "critic" | "specialist";

/// Normalize the backend's YAML-shaped tool allowlist into the runtime contract.
/// Most roles use a YAML list, while unrestricted roles use the supported
/// shorthand `tool_allowlist: all`, which arrives from Rust as a string.
/// Dropping that scalar to `undefined` loses the explicit sentinel before it
/// reaches subscription CLIs, so isolated Solo/Operator runs never receive the
/// host browser relay.
export function normalizeRoleToolAllowlist(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((tool): tool is string => typeof tool === "string");
  }
  if (typeof value === "string" && value.trim().toLowerCase() === "all") {
    return ["all"];
  }
  return undefined;
}

export type TeamNormalizeReport<T extends Team = Team> = {
  /// The normalized team — safe to run / save. Preserves the caller's exact
  /// team type (AgentsPage's Team carries extra fields like visibility), since
  /// normalizeTeam only ever rewrites `agents`/`edges`.
  team: T;
  /// Auto-fixes that were applied (edges wired, dead edges dropped, …).
  changes: string[];
  /// Things the user should look at; non-fatal but may not be what they meant.
  warnings: string[];
};

/// Skills a role grants, resolved from its tool_allowlist. `["all"]`,
/// `undefined`, and `[]` all mean "unrestricted" (the legacy sentinel used by
/// formatToolsForOpenAI). A role with concrete tools is scoped to exactly those.
export function roleSkills(role: RoleData | undefined): { unrestricted: boolean; tools: string[] } {
  const t = role?.toolAllowlist;
  if (!t || t.length === 0 || t.some((s) => s.toLowerCase() === "all")) {
    return { unrestricted: true, tools: [] };
  }
  return { unrestricted: false, tools: t };
}

const WRITE_SKILL = /write|edit|shell|create|ssh|patch|apply/i;

/// True if a role can mutate the world (write files, run shell, …) — used to
/// warn when a team that clearly needs to produce artifacts has no agent that
/// can. Unrestricted roles count as writers (they hold the full tool set).
export function roleCanWrite(role: RoleData | undefined): boolean {
  const { unrestricted, tools } = roleSkills(role);
  return unrestricted || tools.some((s) => WRITE_SKILL.test(s));
}

/// Every team has the same deterministic SOLO runtime agent. It is synthetic:
/// the authored team stays domain-specific in orchestrated mode, while Solo
/// never inherits a narrow specialist prompt/tool allowlist by accident.
///
/// The backing `solo_generalist` role is unrestricted, so every connected tool
/// is available (execution-time auth, sandbox and approval gates still apply).
/// Skill instructions remain progressive/on-demand.
export const SOLO_GENERALIST_BASE = "solo_generalist";
export const SOLO_GENERALIST_NAME = "solo_generalist";
export function soloGeneralistForTeam(team: Pick<Team, "agents">): AgentSpec {
  const explicit = team.agents.find((agent) => agent.base === SOLO_GENERALIST_BASE);
  if (explicit) return explicit;
  const names = new Set(team.agents.map((agent) => agent.name));
  let name = SOLO_GENERALIST_NAME;
  for (let suffix = 2; names.has(name); suffix++) name = `${SOLO_GENERALIST_NAME}_${suffix}`;
  return {
    name,
    base: SOLO_GENERALIST_BASE,
    icon: "owl:owl_operator",
    description: "Solo generalist with every connected tool available; loads task-specific skills on demand.",
  };
}

/// Classify an agent's topology role from its role data + name/base heuristics,
/// so unknown/custom roles still get sensible wiring.
export function roleKind(spec: AgentSpec, roles: Map<string, RoleData>): RoleKind {
  const role = roles.get(spec.base);
  const hay = `${spec.name} ${spec.base}`.toLowerCase();
  if (role?.canDispatch || /\borchestrator\b/.test(hay)) return "orchestrator";
  if (/\bcritic\b|critical[\s_]?thinker/.test(hay)) return "critic";
  return "specialist";
}

// ---------------------------------------------------------------------------
// Deterministic routing — control flow in the HARNESS, not the prompt.
// The orchestrator (an LLM) still PLANS, but the code decides who is actually
// CAPABLE of a kind of work, so a code task can never be force-routed to a
// read-only design leader (the recurring "Product Owner did my bug fix" bug).
// ---------------------------------------------------------------------------

export type GoalKind = "design" | "code" | "docs" | "ops" | "general";

/// Classify the user's goal from its text. Pure heuristic — deliberately blunt:
/// it only needs to separate "make something NEW (design)" from "change existing
/// code / fix / ship (code)" reliably enough to keep routing honest.
export function classifyGoal(text: string): GoalKind {
  const t = (text || "").toLowerCase();
  if (/\b(design|wireframe|mock-?up|greenfield|brand-?new|from scratch|new (app|product|feature|screen|page|ui|ux)|whitepaper)\b/.test(t)) return "design";
  // Stems (leading \b, no trailing \b) so inflections match: crash→crashes/crashed,
  // chang→change/changed/changing, fix→fixes/fixed, fail→fails/failed/failure,
  // releas→release/released. (The trailing \b previously made "crashes" miss.)
  if (/\b(fix|bug|crash|error|broke|broken|stack ?trace|edit|chang(?!elog)|implement|refactor|rewrite|patch|commit|push|publish|releas|\btag\b|build|test|regress|fail)/i.test(t)) return "code";
  if (/\b(readme|changelog|api ref|document(ation)?|write-?up)\b/.test(t)) return "docs";
  if (/\b(deploy|provision|install|configure|pipeline|ci\b|set ?up the (server|env|sandbox))\b/.test(t)) return "ops";
  return "general";
}

/// True when the goal explicitly asks to PUBLISH/RELEASE/SHIP — the gate for the
/// SOLO path's rule-based host publish, so the host only auto-releases when the
/// user actually asked for it (never an unrequested public release).
export function goalRequiresPublish(text: string): boolean {
  return /\b(publish|releas\w*|ship\s+it|deploy)\b/i.test(text || "");
}

/// Classify a CANDIDATE agent's domain from its name/base — coder vs design vs
/// docs vs ops — so routing can match a goal to the right kind of specialist.
export type AgentDomain = "coder" | "design" | "docs" | "ops" | "other";
export function agentDomain(spec: AgentSpec): AgentDomain {
  const hay = `${spec.name} ${spec.base}`.toLowerCase();
  if (/coder|engineer|developer|programmer|backend|frontend|fullstack|refactor/.test(hay)) return "coder";
  if (/design|\bux\b|\bui\b|architect|researcher|product[_\s-]?owner|whitepaper|wireframe/.test(hay)) return "design";
  if (/\bdoc|writer|scribe|changelog/.test(hay)) return "docs";
  if (/operator|devops|\bops\b|release|deploy|schedul|publish/.test(hay)) return "ops";
  return "other";
}

/// Review agents are read-only judges, not terminal reporters. Keep this
/// deliberately name/base based so custom Red Team and reviewer agents get the
/// same control-flow guarantees as the built-in Critical Thinker.
export function isReviewAgent(spec: Pick<AgentSpec, "name" | "base">): boolean {
  const hay = `${spec.name} ${spec.base}`.toLowerCase().replace(/[_-]+/g, " ");
  return /\b(critic|critical thinker|red team|reviewer|code review|security audit|tester)\b/.test(hay);
}

/// Deterministic signal that a review found an actionable defect. Structured
/// verdicts are preferred, but P0/P1 and failed-gate output are accepted because
/// external/custom reviewers do not all use the built-in verdict contract.
export function reviewRequiresRepair(output: string): boolean {
  const text = output || "";
  const structuredFailure = /^\s*(?:VERDICT:\s*)?(?:CONCERN|REVISE|REJECT|FAIL(?:ED)?)\b/im.test(text)
    || /^\s*P[01](?:\s|:|-)/im.test(text)
    || /\[lane verify:\s*failed\]/i.test(text)
    || /\b(?:blocking|must[- ]fix|should[- ]fix)\b/i.test(text)
    || /\b(?:actionable|material|serious)\s+(?:issue|defect|finding)s?\b/i.test(text);
  if (structuredFailure) return true;
  const explicitlyClean = /\b(?:no|zero)\s+(?:actionable\s+)?(?:issues?|defects?|bugs?|findings?|vulnerabilit(?:y|ies))\b/i.test(text);
  const reportsFindings = /\b(?:found|identified|detected|uncovered|reports?)\s+(?:an?\s+|\d+\s+|several\s+|multiple\s+|these\s+)?(?:issues?|defects?|bugs?|findings?|vulnerabilit(?:y|ies))\b/i.test(text)
    || /^\s*(?:issue|defect|bug|finding|vulnerability)s?\s*:/im.test(text);
  return reportsFindings && !explicitlyClean;
}

/// A reviewer repairs through the agent(s) that actually handed work to it.
/// This derives the bounded reverse path from the authored worker→review edge;
/// users do not need to draw a cycle merely to make review findings actionable.
export function reviewRepairTargets(
  team: Pick<Team, "agents" | "edges">,
  reviewerName: string,
  output: string,
  runCount: ReadonlyMap<string, number>,
): string[] {
  const reviewer = team.agents.find((agent) => agent.name === reviewerName);
  if (!reviewer || !isReviewAgent(reviewer) || !reviewRequiresRepair(output)) return [];
  const names = new Set(team.agents.map((agent) => agent.name));
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const edge of team.edges ?? []) {
    if (edge.target !== reviewerName || !names.has(edge.source) || seen.has(edge.source)) continue;
    const source = team.agents.find((agent) => agent.name === edge.source);
    if (!source || isReviewAgent(source) || (runCount.get(source.name) ?? 0) === 0) continue;
    const hay = `${source.name} ${source.base}`.toLowerCase();
    if (/orchestrator|publisher|producer/.test(hay)) continue;
    seen.add(source.name);
    targets.push(source.name);
  }
  return targets;
}

/// A repaired worker must go through its reviewer again. Legacy graph flow is
/// run-once, so explicitly permit this one bounded re-review when the worker is
/// itself on a repair run.
export function shouldRepeatReview(
  team: Pick<Team, "agents">,
  agentName: string,
  targetName: string,
  runCount: ReadonlyMap<string, number>,
  maxRuns: number,
): boolean {
  const target = team.agents.find((agent) => agent.name === targetName);
  return (runCount.get(agentName) ?? 0) > 1
    && !!target
    && isReviewAgent(target)
    && (runCount.get(targetName) ?? 0) < maxRuns;
}

/// Classify a CODER agent's lane — frontend vs backend vs full-stack — from its
/// name/base, so a code goal can be routed to the matching lane instead of blindly
/// taking the first coder in roster order. Mirrors the gate-scope signal used to
/// pick the verify command in AgentsPage, kept here so agent SELECTION and command
/// SCOPING agree on what "frontend"/"backend" means.
export type CoderLane = "frontend" | "backend" | "full";
export function coderLane(spec: AgentSpec): CoderLane {
  const hay = `${spec.name} ${spec.base}`.toLowerCase();
  if (/front|\bui\b|web|client|css|react|vue|svelte/.test(hay)) return "frontend";
  if (/back|api|server|\bdb\b|database|data|rust|tauri|engine|infra/.test(hay)) return "backend";
  return "full";
}

/// Infer which lane a GOAL wants from its text — same vocabulary as `coderLane`.
/// Returns "full" when the goal gives no clear frontend/backend signal so the
/// caller falls back to roster order rather than guessing.
export function goalLane(goal: string): CoderLane {
  const t = (goal || "").toLowerCase();
  const fe = /\b(front-?end|\bui\b|css|style|layout|page|header|button|icon|component|react|vue|svelte|client|web ?view|screen|modal|render)\b/.test(t);
  const be = /\b(back-?end|api|server|endpoint|route|database|\bdb\b|sql|schema|migration|rust|tauri|engine|daemon|service|queue|worker|infra|auth|token)\b/.test(t);
  if (fe && !be) return "frontend";
  if (be && !fe) return "backend";
  return "full";
}

/// From a set of coders, pick the one whose lane matches the goal's lane. When
/// the goal has no clear lane, or only one coder exists, returns the first in
/// roster order (preserving prior behavior). This is what stops every code goal
/// from always landing on the frontend coder simply because it is listed first.
function pickCoderForGoal(coders: AgentSpec[], goal: string): AgentSpec | undefined {
  if (coders.length <= 1) return coders[0];
  const want = goalLane(goal);
  if (want !== "full") {
    const match = coders.find((c) => coderLane(c) === want);
    if (match) return match;
  }
  return coders[0];
}

/// Pick the best specialist for a goal, deterministically. For a code/fix/ship
/// goal it returns a CODER (or any write-capable NON-design agent) and NEVER a
/// read-only design leader; design goals prefer a designer. Used by the
/// solo-fallback and the route-correction guard so the harness — not the
/// orchestrator's prose — decides capability fit. Returns undefined only when
/// there are no candidates at all.
export function bestAgentForGoal(
  candidates: AgentSpec[],
  goal: string,
  roles: Map<string, RoleData>,
): AgentSpec | undefined {
  const kind = classifyGoal(goal);
  const writable = candidates.filter((a) => roleCanWrite(roles.get(a.base)));
  const inDomain = (list: AgentSpec[], d: AgentDomain) => list.filter((a) => agentDomain(a) === d);
  const nonDesign = (list: AgentSpec[]) => list.filter((a) => agentDomain(a) !== "design");
  const first = (...lists: AgentSpec[][]) => { for (const l of lists) if (l.length) return l[0]; return undefined; };
  switch (kind) {
    case "code": {
      // Lane-aware: when multiple coders exist, route to the one whose lane
      // (frontend/backend) matches the goal instead of always the first coder.
      const laneCoder = pickCoderForGoal(inDomain(writable, "coder"), goal);
      if (laneCoder) return laneCoder;
      return first(nonDesign(writable), writable, inDomain(candidates, "coder"), candidates);
    }
    case "docs":
      return first(inDomain(writable, "docs"), inDomain(writable, "coder"), nonDesign(writable), writable, candidates);
    case "ops":
      return first(inDomain(writable, "ops"), inDomain(writable, "coder"), nonDesign(writable), writable, candidates);
    case "design":
      return first(inDomain(candidates, "design"), writable, candidates);
    default:
      return first(nonDesign(writable), writable, candidates);
  }
}

// ---------------------------------------------------------------------------
// Run-control predicates — the other half of "control flow in the HARNESS, not
// the prompt". These are the deterministic signals the dispatch loop terminates
// and judges itself on (critic verdict, done-gate, no-progress), pulled out of
// AgentsPage so they are (a) the SAME on every model path and (b) testable as
// pure functions with no React/Tauri in the way (harness.verify covers them).
// ---------------------------------------------------------------------------

/// The critic is ADVISORY and can NEVER gate the team; these detect the two ways
/// a critic ROUND should end the consult loop so the team proceeds regardless.
/// `criticIsSatisfied` — nothing left to add ("no concerns", "lgtm").
export function criticIsSatisfied(t: string): boolean {
  return /\bno (further |major |remaining |other |real |significant |additional )?(concerns?|issues?|objections?|changes?|problems?|blockers?)\b|\blooks? (good|solid|fine|reasonable|right)\b|\bready to (dispatch|proceed|go|build|start|ship)\b|\blgtm\b|\bapproved?\b|\bno changes? (needed|required)\b|\bproceed as planned\b|\bgo ahead\b|\bnothing (else |further |more )?to add\b/i.test(t);
}
/// `criticRefused` — it declined the task (a non-abliterated critic objecting to
/// a sanctioned Red-Team / abliterate job). A refusal is NOT a veto: we note it
/// and proceed; the code caps the rounds and never gates dispatch on approval.
export function criticRefused(t: string): boolean {
  return /\bI (can'?t|cannot|can not|won'?t|will not|am unable to|must decline|refuse|am not (going|willing|able) to)\b|\b(against|violates?) (my|the|our|its) (guidelines?|policy|policies|principles?|values?|terms)\b|\bnot (comfortable|able|willing) to\b|\bas an ai\b[^.]*\b(can'?t|cannot|won'?t|unable)\b|\bI('| a)?m not able to (help|assist|comply|continue|support)\b|\bI do not (feel )?(comfortable|able) (with|to)\b/i.test(t);
}
/// Parse the critic's STRUCTURED verdict line (the deterministic signal the loop
/// terminates on, instead of regex-guessing free-text prose — which let
/// "no concerns about X, but Y is broken" read as approval).
export function parseCriticVerdict(t: string): "ship" | "concern" | null {
  const m = /^\s*VERDICT:\s*(SHIP|CONCERN)\b/im.exec(t || "");
  if (!m) return null;
  return m[1].toUpperCase() === "SHIP" ? "ship" : "concern";
}
/// True when the critic round should END the consult loop (explicit SHIP, or no
/// structured verdict but the prose is satisfied / a refusal we defer past).
export function criticConcluded(t: string): boolean {
  const v = parseCriticVerdict(t);
  if (v === "ship") return true;      // explicit go → stop consulting the critic
  if (v === "concern") return false;  // explicit concern → let the orchestrator address it
  // No structured verdict (older / misaligned critic) → fall back to prose heuristics.
  return criticIsSatisfied(t) || criticRefused(t);
}

/// True if a streamed TOOL-CALL role represents real world-mutation (write/edit/
/// shell/git), i.e. "the team actually did something". `role` looks like
/// "🛠 Edit" / "🛠 Bash" / "🛠 write_file". This is the signal the done-gate reads.
export function toolRoleIsWrite(role: string): boolean {
  return /🛠/.test(role) && /\b(edit|write|multiedit|notebookedit|bash|shell|str_replace|apply_patch|create_file|patch|commit|git)\b/i.test(role);
}

/// True if a goal of this kind is expected to MUTATE the world (produce/ship an
/// artifact), so a run that fired zero write tools did NOT actually do the work.
/// Matches the done-gate: code & ops require artifacts; design/docs/general don't.
export function goalRequiresWrite(goal: string): boolean {
  const k = classifyGoal(goal);
  return k === "code" || k === "ops";
}

/// The done-gate, as a pure predicate: did the run produce the work its goal
/// requires? A code/ops goal that fired no write tool is NOT done (the team only
/// analyzed/planned). Everything else is considered done by this gate.
export function runIsDone(goal: string, ranWriteTool: boolean): boolean {
  return goalRequiresWrite(goal) ? ranWriteTool : true;
}

/// Domains whose presence in a run means the task was meant to MUTATE the world
/// (produce/ship an artifact). If one of these specialists ran, a zero-write run
/// did not deliver — even when the GOAL TEXT had no code verb.
const DOER_DOMAINS = new Set<AgentDomain>(["coder", "ops"]);

/// The done-gate that also accounts for WHO ran — the robust version. A run did
/// NOT deliver if it was supposed to mutate the world (a code/ops goal, OR a
/// coder/operator specialist was actually dispatched) but fired zero write
/// tools. This catches UI/code tasks phrased without code verbs — e.g. "put the
/// agents in order, add a purple container" — which classifyGoal alone labels
/// "general", so runIsDone wrongly passed them. `ranDomains` = the domains of
/// the specialists that ran this turn.
export function runDelivered(goal: string, ranWriteTool: boolean, ranDomains: Iterable<AgentDomain>): boolean {
  if (ranWriteTool) return true;            // something was written/executed → delivered
  if (goalRequiresWrite(goal)) return false; // code/ops goal but nothing written
  for (const d of ranDomains) if (DOER_DOMAINS.has(d)) return false; // a doer ran but wrote nothing
  return true;                              // analysis/Q&A/design with no doer → fine as-is
}

/// Normalize an agent's output for no-progress comparison: collapse whitespace,
/// lowercase, cap length so trivial reformatting doesn't read as "new work".
export function normalizeRunOutput(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 2000);
}

/// No-progress / oscillation guard (deterministic): an agent that just repeated
/// its previous (normalized) output is in a stuck loop, not making progress, so
/// its chain should stop. `prev`/`cur` are already normalizeRunOutput()'d.
export function isNoProgress(prev: string | undefined, cur: string): boolean {
  return prev !== undefined && cur.length > 40 && cur === prev;
}

/// Find the one orchestrator. Exact name → exact base → any can_dispatch role →
/// any name/base containing "orchestrator". Mirrors AgentsPage.orchestratorOf so
/// the canvas, dispatch, and normalizer all agree on the same agent.
export function findOrchestrator(team: Team, roles: Map<string, RoleData>): AgentSpec | null {
  const a = team.agents;
  return (
    a.find((x) => x.name === "orchestrator") ??
    a.find((x) => x.base === "orchestrator") ??
    a.find((x) => roles.get(x.base)?.canDispatch) ??
    a.find((x) => /\borchestrator\b/i.test(`${x.name} ${x.base}`)) ??
    null
  );
}

/// Agents reachable from the orchestrator by following dispatch edges. An agent
/// not in this set would never run (its @dispatch line gets filtered by the
/// wiring), so the normalizer wires it directly to the orchestrator.
function reachableFrom(start: string, edges: Edge[]): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const t of adj.get(cur) ?? []) {
      if (!seen.has(t)) { seen.add(t); stack.push(t); }
    }
  }
  return seen;
}

/// Normalize a team into a structurally-valid, runnable configuration.
/// Idempotent: normalizeTeam(normalizeTeam(t)) === normalizeTeam(t).
export function normalizeTeam<T extends Team>(team: T, roles: Map<string, RoleData>): TeamNormalizeReport<T> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const agents = [...team.agents];
  let edges: Edge[] = Array.isArray(team.edges) ? [...team.edges] : [];

  // --- unique names (dispatch resolves by name; dupes are ambiguous) ---
  const counts = new Map<string, number>();
  for (const a of agents) counts.set(a.name, (counts.get(a.name) ?? 0) + 1);
  for (const [n, c] of counts) {
    if (c > 1) warnings.push(`Agent name "${n}" is used ${c}× — names must be unique so @dispatch can resolve them.`);
  }
  const names = new Set(agents.map((a) => a.name));

  // --- every base must map to a known role (skills + prompt come from it) ---
  // The synthetic Critical Thinker (roleKind "critic") DELIBERATELY has no yaml
  // role — it runs from a code-built prompt and an inline spec — so don't flag
  // it as an "unknown role". Only real specialists need a backing role file.
  for (const a of agents) {
    if (roleKind(a, roles) === "critic") continue;
    if (!roles.has(a.base)) {
      warnings.push(`Agent "${a.name}" uses role base "${a.base}", which isn't a known role — its skills and prompt can't be resolved.`);
    }
  }

  // --- orchestrator must exist ---
  const orch = findOrchestrator({ ...team, agents }, roles);
  if (!orch) {
    warnings.push("This team has no orchestrator — add an agent whose role plans and dispatches (base 'orchestrator'). Until then it can't run as a team.");
    return { team: { ...team, agents, edges } as T, changes, warnings };
  }
  const orchCount = agents.filter((a) => roleKind(a, roles) === "orchestrator").length;
  if (orchCount > 1) {
    warnings.push(`${orchCount} agents look like orchestrators — only "${orch.name}" will dispatch; the others are treated as specialists.`);
  }

  // --- drop edges whose endpoints no longer exist (renamed/deleted agents) ---
  const liveEdges = edges.filter((e) => names.has(e.source) && names.has(e.target));
  if (liveEdges.length !== edges.length) {
    changes.push(`Removed ${edges.length - liveEdges.length} dangling edge(s) pointing at agents that don't exist.`);
    edges = liveEdges;
  }

  // --- de-duplicate edges ---
  // Tab separator — agent names can contain spaces ("Orchi the orchestrator"),
  // so a space would make "a b"+"c" collide with "a"+"b c"; a tab cannot appear
  // in a name.
  const edgeKey = (e: Edge) => `${e.source}\t${e.target}`;
  const uniq = new Map<string, Edge>();
  for (const e of edges) uniq.set(edgeKey(e), e);
  if (uniq.size !== edges.length) {
    changes.push(`Merged ${edges.length - uniq.size} duplicate edge(s).`);
    edges = [...uniq.values()];
  }

  // --- wire every UNREACHABLE agent directly to the orchestrator ---
  // Only the unreachable ones: this fixes orphans and no-edge teams WITHOUT
  // clobbering intentional chains (e.g. triager → responder stays; responder is
  // reachable via triager, so it does NOT get a redundant orchestrator edge).
  const reachable = reachableFrom(orch.name, edges);
  for (const a of agents) {
    if (a.name === orch.name) continue;
    if (!reachable.has(a.name)) {
      edges.push({ source: orch.name, target: a.name });
      reachable.add(a.name);
      changes.push(`Wired orchestrator → ${a.name} (it was unreachable, so its dispatches would have been dropped).`);
    }
  }

  // --- skills sanity: warn if nobody can produce artifacts ---
  const specialists = agents.filter((a) => roleKind(a, roles) === "specialist");
  if (specialists.length === 0) {
    warnings.push("This team has an orchestrator but no specialists to dispatch to — add at least one specialist.");
  } else if (!specialists.some((a) => roleCanWrite(roles.get(a.base)))) {
    warnings.push("No specialist on this team has write/edit/shell skills — it can analyze and draft, but can't create or change files. Add a coder/operator-type agent if you want artifacts produced.");
  }

  return { team: { ...team, agents, edges }, changes, warnings };
}
