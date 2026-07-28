// Dispatch parser — PURE, no React/Tauri/runtime imports, so it can be unit
// tested standalone (harness.verify transpiles + imports it directly) and shared
// verbatim by BOTH dispatch loops (desktop AgentsPage + the Telegram bridge in
// dispatch.ts) with no drifting second copy. dispatch.ts re-exports everything
// here, so existing `import { … } from "./dispatch"` call sites are unchanged.

export type Dispatch = { agentName: string; instruction: string };

/// A dispatch line that produced NO specialist run, with the nearest real name
/// as a suggestion. Surfaced to the user AND fed back to the orchestrator
/// (P1-3: fail loud, never silently drop a specialist).
///
/// `reason` distinguishes the two ways that happens. "empty-instruction" used to
/// be dropped by a bare `continue` — the agent existed, but the orchestrator gave
/// it no body, so it simply never ran and nothing anywhere said so.
export type UnresolvedReason = "unknown-agent" | "empty-instruction";
export type UnresolvedDispatch = {
  name: string;
  instruction: string;
  suggestion: string | null;
  reason: UnresolvedReason;
};

export type DispatchParse = { dispatches: Dispatch[]; unresolved: UnresolvedDispatch[] };

/// Structural team shape the parser needs — keeps it shareable with
/// AgentsPage's own Team type (§0.4: ONE parser, not two drifting copies).
export type TeamLike = { agents: Array<{ name: string }> };

/// Levenshtein distance — small inputs (agent names), no need for anything fancier.
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

/// Normalize an agent name for tolerant matching: lowercase, strip
/// separators/punctuation. "Data-Analyst." → "dataanalyst".
function normName(s: string): string {
  return s.toLowerCase().replace(/[\s._\-]+/g, "");
}

/// Resolve a model-emitted @name to a real team member. Steps: exact →
/// case-insensitive → normalized (case + punctuation + separators) →
/// fuzzy (edit distance ≤ 2 on the normalized form, but never more than
/// half the name — "codr" finds "coder"; "designer" must NOT find "coder").
/// Returns the canonical team name, or null.
function resolveAgentName(raw: string, teamNames: string[]): string | null {
  if (teamNames.includes(raw)) return raw;
  const lower = raw.toLowerCase();
  const ci = teamNames.find(n => n.toLowerCase() === lower);
  if (ci) return ci;
  const norm = normName(raw);
  if (!norm) return null;
  const nn = teamNames.find(n => normName(n) === norm);
  if (nn) return nn;
  let best: { name: string; d: number } | null = null;
  for (const n of teamNames) {
    const d = editDistance(norm, normName(n));
    if (best === null || d < best.d) best = { name: n, d };
  }
  if (best && best.d <= 2 && best.d <= Math.floor(normName(best.name).length / 2)) {
    return best.name;
  }
  return null;
}

/// Nearest team name for a "did you mean …?" hint (looser than resolution).
function nearestAgentName(raw: string, teamNames: string[]): string | null {
  const norm = normName(raw);
  let best: { name: string; d: number } | null = null;
  for (const n of teamNames) {
    const d = editDistance(norm, normName(n));
    if (best === null || d < best.d) best = { name: n, d };
  }
  return best && best.d <= 3 ? best.name : null;
}

/// Tolerant dispatch parse. Accepts `@coder: task`, `- @Coder: task`,
/// `1. @ coder : task`, `**@coder:** task`, fuzzy names (`@codr:`), and
/// reports every line that named NO resolvable agent in `unresolved` so the
/// caller can fail loud instead of dropping it (P1-3).
export function parseDispatchesDetailed(text: string, team: TeamLike, exclude: string): DispatchParse {
  const teamNames = team.agents.map(a => a.name);
  const lines = text.split(/\r?\n/);
  const dispatches: Dispatch[] = [];
  const unresolved: UnresolvedDispatch[] = [];
  // A dispatch directive line: `@name:` with optional list/bold/quote prefixes,
  // a space after @, bold asterisks, and a fullwidth colon. `(.*)` (not `.+`) so
  // `@coder:` with the body starting on the NEXT line still counts as a start.
  const startRe = /^[\s\-\d.*•>]*@\s*([A-Za-z0-9._\-]+)\s*\**\s*[:：]\s*(.*)$/;
  // The instruction is everything after the colon on the directive line PLUS
  // every following line, UNTIL the next dispatch directive (or end of text).
  // Capturing those continuation lines is the whole point: an orchestrator's
  // instruction is almost always multi-line — a numbered change list, steps, a
  // code block — and the previous single-line `(.+)$` capture silently dropped
  // everything after line one, so the specialist received only a truncated
  // header (e.g. "Make these changes to the Curated section:") and refused to
  // guess. Each directive owns the block of lines up to the next directive.
  type Hit = { idx: number; name: string; head: string };
  const hits: Hit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(startRe);
    if (m) hits.push({ idx: i, name: m[1], head: m[2] });
  }
  for (let h = 0; h < hits.length; h++) {
    const hit = hits[h];
    const end = h + 1 < hits.length ? hits[h + 1].idx : lines.length;
    const instruction = [hit.head, ...lines.slice(hit.idx + 1, end)]
      .join("\n").replace(/^[\s*]+/, "").trim();
    const name = hit.name;
    // critical_thinker is a synthetic agent (not in team.agents); it's
    // routed via extractUserInputRequest's CRITIC_DISPATCH_RE branch
    // instead. Skip here so we don't fall through to the unknown-agent
    // path.
    if (/^critical[_\s-]?thinker$/i.test(name)) continue;
    // `@coder:` with nothing after it. Dispatching an empty instruction is
    // pointless, but silently dropping it is worse: the user watched a named
    // specialist never run and got no reason. Report it like any other dispatch
    // that produced no run, so the orchestrator is asked to re-emit it.
    if (!instruction) {
      unresolved.push({ name, instruction: "", suggestion: null, reason: "empty-instruction" });
      continue;
    }
    const resolved = resolveAgentName(name, teamNames);
    if (resolved === null) {
      unresolved.push({
        name,
        instruction,
        suggestion: nearestAgentName(name, teamNames),
        reason: "unknown-agent",
      });
      continue;
    }
    if (resolved === exclude) continue; // orchestrator never self-dispatches
    dispatches.push({ agentName: resolved, instruction });
  }
  return { dispatches, unresolved };
}

export function parseDispatches(text: string, team: TeamLike, exclude: string): Dispatch[] {
  return parseDispatchesDetailed(text, team, exclude).dispatches;
}

/// One model-visible correction message for unresolved dispatch lines —
/// fed back to the orchestrator so it can re-emit with real names.
export function unresolvedCorrectionMessage(unresolved: UnresolvedDispatch[], team: TeamLike, exclude: string): string {
  const roster = team.agents.map(a => a.name).filter(n => n !== exclude).join(", ");
  const lines = unresolved.map(u =>
    u.reason === "empty-instruction"
      ? `- "@${u.name}:" was given no instruction, so there was nothing to dispatch`
      : `- "@${u.name}:" names no agent on this team${u.suggestion ? ` — did you mean '@${u.suggestion}:'?` : ""}`);
  return [
    "[dispatch error — fix and re-emit]",
    "These dispatch lines produced NO specialist run:",
    ...lines,
    `Your team is exactly: ${roster}.`,
    "Re-emit the dispatch lines now, one per line, as `@<exact-agent-name>: <instruction>`. Do not apologize or explain.",
  ].join("\n");
}

export function stripDispatchDirectives(text: string): string {
  // Drop each `@name:` directive AND its multi-line instruction block (every
  // line after it, up to end of reply) so the displayed "clean" orchestrator
  // message shows only its preamble, not the raw instruction it dispatched.
  // Mirrors the multi-line capture in parseDispatchesDetailed.
  const startRe = /^[\s\-\d.*•>]*@\s*[A-Za-z0-9._\-]+\s*\**\s*[:：]/;
  const out: string[] = [];
  let inBlock = false;
  for (const l of text.split(/\r?\n/)) {
    if (startRe.test(l.trim())) { inBlock = true; continue; }
    if (inBlock) continue;
    out.push(l);
  }
  return out.join("\n");
}
