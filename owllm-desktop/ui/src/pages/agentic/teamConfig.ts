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
  if (/\b(fix|bug|crash|error|broken|stack ?trace|edit|change|implement|refactor|rewrite|patch|commit|push|publish|release|tag|build|test|regress)\b/.test(t)) return "code";
  if (/\b(readme|changelog|api ref|document(ation)?|write-?up)\b/.test(t)) return "docs";
  if (/\b(deploy|provision|install|configure|pipeline|ci\b|set ?up the (server|env|sandbox))\b/.test(t)) return "ops";
  return "general";
}

/// Classify a CANDIDATE agent's domain from its name/base — coder vs design vs
/// docs vs ops — so routing can match a goal to the right kind of specialist.
export type AgentDomain = "coder" | "design" | "docs" | "ops" | "other";
export function agentDomain(spec: AgentSpec): AgentDomain {
  const hay = `${spec.name} ${spec.base}`.toLowerCase();
  if (/coder|engineer|developer|programmer|backend|frontend|fullstack|refactor/.test(hay)) return "coder";
  if (/design|\bux\b|\bui\b|architect|researcher|product[_\s-]?owner|whitepaper|wireframe/.test(hay)) return "design";
  if (/\bdoc|writer|scribe|changelog/.test(hay)) return "docs";
  if (/operator|devops|\bops\b|release|deploy|schedul/.test(hay)) return "ops";
  return "other";
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
    case "code":
      return first(inDomain(writable, "coder"), nonDesign(writable), writable, inDomain(candidates, "coder"), candidates);
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
