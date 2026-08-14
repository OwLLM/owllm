// Per-agent SKILL runtime — the ONE place that resolves equipped skills and
// builds the prompt injection, imported by BOTH dispatch copies (dispatch.ts +
// AgentsPage.tsx) so the "two dispatch paths drift" bug can't recur.
//
// Progressive disclosure, budgeted: a specialist's equipped skills are shown by
// name + description (cheap), and full SKILL.md bodies are inlined smallest-first
// up to a char budget — so one or two small skills load fully while a fat library
// degrades to descriptions only, never blowing the context window. (The on-demand
// load_skill tool is a planned refinement on top of this.)
//
// Backed by the pre-existing `list_skill_packs` Rust command (agents.rs), which
// already enumerates every installed pack across the new + legacy skills homes
// and returns the full body in the same call — so resolving an equipped skill's
// instructions needs no second round-trip.

import { invoke } from "@tauri-apps/api/core";

/// Raw shape returned by the `list_skill_packs` command (agents.rs::SkillPack).
type RawSkillPack = {
  id: string;
  path: string;
  dir: string;
  frontmatter: Record<string, unknown> | null;
  body: string;
};

/// Cheap metadata tier for the equip picker / Studio catalog.
export type SkillPack = { id: string; name: string; description: string; ctx_estimate: number };
/// Full tier — metadata + body, ready to inject at dispatch.
export type ResolvedSkill = { id: string; name: string; description: string; body: string };

let _rawCache: RawSkillPack[] | null = null;

function fmString(fm: Record<string, unknown> | null, key: string): string {
  const v = fm?.[key];
  return typeof v === "string" ? v : "";
}

async function rawPacks(force = false): Promise<RawSkillPack[]> {
  if (_rawCache && !force) return _rawCache;
  try { _rawCache = await invoke<RawSkillPack[]>("list_skill_packs"); }
  catch { _rawCache = []; }
  return _rawCache;
}

/// Cheap metadata for every installed skill pack (cached; call invalidate after
/// install/uninstall). Drives the Studio catalog AND the per-agent equip picker.
export async function listSkillPacks(force = false): Promise<SkillPack[]> {
  const raw = await rawPacks(force);
  return raw.map(p => ({
    id: p.id,
    name: fmString(p.frontmatter, "name") || p.id,
    description: fmString(p.frontmatter, "description"),
    // Labelled estimate (chars/4), never an exact token count — drives the "~Xk" badge.
    ctx_estimate: Math.round((p.body?.length ?? 0) / 4),
  }));
}
export function invalidateSkillPackCache(): void { _rawCache = null; }

/// Resolve equipped skill ids → metadata + full bodies, ready to inject.
/// Skips ids that aren't installed. Bodies come from the same cached list call,
/// so this is a pure in-memory lookup (no extra round-trip).
export async function resolveAgentSkills(ids: string[]): Promise<ResolvedSkill[]> {
  const uniq = [...new Set((ids ?? []).filter(Boolean))];
  if (uniq.length === 0) return [];
  const raw = await rawPacks();
  const byId = new Map(raw.map(p => [p.id, p]));
  const out: ResolvedSkill[] = [];
  for (const id of uniq) {
    const p = byId.get(id);
    if (!p) continue;
    out.push({
      id,
      name: fmString(p.frontmatter, "name") || id,
      description: fmString(p.frontmatter, "description"),
      body: p.body ?? "",
    });
  }
  return out;
}

/// Normalise a skill reference (display name OR id) to a comparable slug, so
/// `load_skill("PDF Processing")`, `"pdf-processing"`, `"pdf_processing"` all
/// resolve to the same pack.
function skillSlug(s: string): string {
  return (s ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "");
}

/// On-demand skill loader for the `load_skill` tool: resolve a model-supplied
/// name/id to the pack's full body. Searches EVERY installed pack (not just
/// equipped ones) so an agent can pull any bundled skill it judges relevant —
/// the user's "the agent picks/switches its own skills" model. Returns null if
/// nothing matches.
export async function loadSkillByRef(ref: string, allowedIds?: string[]): Promise<ResolvedSkill | null> {
  const want = skillSlug(ref);
  if (!want) return null;
  const raw = await rawPacks();
  const allowed = allowedIds === undefined ? null : new Set(allowedIds);
  const visible = allowed ? raw.filter(p => allowed.has(p.id)) : raw;
  const match = visible.find(p => {
    const name = fmString(p.frontmatter, "name");
    return skillSlug(p.id) === want || skillSlug(name) === want;
  }) ?? visible.find(p => {
    // looser contains-match as a fallback ("brand" → "brand-guidelines")
    const name = fmString(p.frontmatter, "name");
    return skillSlug(p.id).includes(want) || skillSlug(name).includes(want);
  });
  if (!match) return null;
  return {
    id: match.id,
    name: fmString(match.frontmatter, "name") || match.id,
    description: fmString(match.frontmatter, "description"),
    body: match.body ?? "",
  };
}

/// Brief catalog of EVERY installed skill (name + description), for the
/// `list_skills` tool so an agent can discover skills beyond the ones equipped
/// on it. Equipped ids are flagged so the agent knows what's already on it.
export async function skillCatalogBrief(equippedIds: string[] = [], allowedIds?: string[]): Promise<string> {
  const allowed = allowedIds === undefined ? null : new Set(allowedIds);
  const packs = (await listSkillPacks()).filter(pack => !allowed || allowed.has(pack.id));
  if (packs.length === 0) return "(no skills installed)";
  const equipped = new Set(equippedIds.filter(Boolean));
  return packs
    .map(p => `- ${p.name}${equipped.has(p.id) ? " (equipped)" : ""}: ${p.description || "(no description)"}`)
    .join("\n");
}

/// True if at least one skill pack is installed — gates whether the skill
/// tools are advertised at all.
export async function anySkillInstalled(): Promise<boolean> {
  return (await rawPacks()).length > 0;
}

const SKILL_BODY_BUDGET = 8000; // chars (~2k tokens) of inlined skill instructions

/// Tokens too generic or structural to be useful matching signals.
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "by", "can", "could", "did", "do",
  "does", "for", "from", "had", "has", "have", "i", "if", "in", "into", "is", "it",
  "its", "me", "my", "of", "on", "or", "out", "shall", "should", "that", "the", "this",
  "to", "up", "was", "we", "were", "will", "with", "would", "you", "your",
]);

/// Extract lowercase alphanumeric tokens from free text, dropping stop words.
function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of (text || "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 2 && !STOP_WORDS.has(raw)) out.add(raw);
  }
  return out;
}

/// Read the optional `triggers:` frontmatter array as normalised tokens.
function readTriggers(fm: Record<string, unknown> | null): Set<string> {
  const out = new Set<string>();
  const t = fm?.triggers;
  if (Array.isArray(t)) {
    for (const item of t) {
      if (typeof item === "string") {
        for (const tok of tokenize(item)) out.add(tok);
      }
    }
  }
  return out;
}

/// Tokens from the skill's name + description, used as a low-weight fallback
/// when no explicit triggers are declared or when they don't overlap.
function skillKeywords(p: RawSkillPack): Set<string> {
  const out = new Set<string>();
  const name = fmString(p.frontmatter, "name");
  const desc = fmString(p.frontmatter, "description");
  for (const tok of tokenize(`${name} ${desc}`)) out.add(tok);
  return out;
}

/// Auto-select the installed skills most relevant to the user's goal.
/// Scores by explicit `triggers:` matches (weight 3) and name/description
/// keyword matches (weight 1). Returns the top-N ids above the threshold.
export async function selectRelevantSkillIds(
  goalText: string,
  opts: { max?: number; allowedIds?: string[]; threshold?: number } = {},
): Promise<string[]> {
  const { max = 2, allowedIds, threshold = 1 } = opts;
  const want = tokenize(goalText);
  if (want.size === 0) return [];
  const raw = await rawPacks();
  const visible = allowedIds ? raw.filter(p => allowedIds.includes(p.id)) : raw;
  const scored = visible
    .map(p => {
      const triggers = readTriggers(p.frontmatter);
      const keywords = skillKeywords(p);
      let score = 0;
      for (const w of want) {
        if (triggers.has(w)) score += 3;
        else if (keywords.has(w)) score += 1;
      }
      return { id: p.id, score };
    })
    .filter(s => s.score >= threshold)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map(s => s.id);
}

/// Build a Solo-mode skill block that merges the agent's equipped skills with
/// automatically selected skills based on the user's goal. Returns the block
/// plus the list of ids that were auto-loaded so the caller can log/audit them.
export async function buildSoloSkillBlock(
  equippedIds: string[],
  goalText: string,
  strict = false,
  /// Ids already injected into the SAME prompt through a dedicated section
  /// (e.g. `owllm__parallel-dispatch` rides the PARALLEL DISPATCH block when
  /// parallel mode is on). Excluded here so one skill's body can never sit in
  /// the prompt twice — equipped, granted, or auto-selected.
  excludeIds: string[] = [],
): Promise<{ block: string; autoLoaded: string[] }> {
  const excluded = new Set(excludeIds);
  const autoLoaded = (strict ? [] : await selectRelevantSkillIds(goalText, { max: 2 }))
    .filter(id => !excluded.has(id));
  const merged = [...new Set([...equippedIds, ...autoLoaded])].filter(id => !excluded.has(id));
  const block = await buildAgentSkillBlock(merged, strict);
  return { block, autoLoaded };
}

/// Build the SKILL block for a specialist prompt. Descriptions always shown;
/// bodies inlined smallest-first within SKILL_BODY_BUDGET. Whatever isn't
/// inlined this turn, the agent can pull on demand with the `load_skill` tool
/// (and discover more via `list_skills`) — and it may switch skills mid-task.
export function buildSkillBlock(skills: ResolvedSkill[]): string {
  if (!skills || skills.length === 0) return "";
  // pick which bodies to inline (smallest-first within budget)
  const inlined = new Set<string>();
  let used = 0;
  for (const s of [...skills].sort((a, b) => a.body.length - b.body.length)) {
    if (s.body && used + s.body.length <= SKILL_BODY_BUDGET) { used += s.body.length; inlined.add(s.id); }
  }
  const lines: string[] = ["--- YOUR SKILLS (capability packs available to you — use them when relevant) ---"];
  for (const s of skills) {
    if (inlined.has(s.id) && s.body) {
      lines.push(`\n### Skill: ${s.name}\n${s.body.trim()}`);
    } else {
      lines.push(`- ${s.name}: ${s.description || "(no description)"} — read \`.owllm/skills/${s.id}/SKILL.md\` for its full instructions.`);
    }
  }
  lines.push(
    "",
    "SELF-LOAD ANY SKILL (works on every model): the full skill library is mirrored " +
    "into `.owllm/skills/` in your working directory. Read `.owllm/skills/INDEX.md` " +
    "to see every available skill (not just the ones above), then read " +
    "`.owllm/skills/<id>/SKILL.md` with your file-read tool to pull a skill's full " +
    "instructions into context — load as many as the task needs, and read another to " +
    "switch. (Local models may also use the load_skill / list_skills tools.)",
  );
  lines.push("--- END SKILLS ---");
  return lines.join("\n");
}

/// The ONE entry point dispatch should use to build an agent's skill block.
/// - Has equipped skills → full block (descriptions + budgeted bodies + the
///   load/switch guidance).
/// - No equipped skills but packs ARE installed → a short discovery note so
///   the agent still knows it can pull skills itself (the user's "every agent
///   sees the catalog and picks its own" model).
/// - No skills installed at all → empty string.
/// Resolves everything async so call sites stay one-liners.
export async function buildAgentSkillBlock(ids: string[], strict = false): Promise<string> {
  const equipped = await resolveAgentSkills(ids);
  if (equipped.length > 0) {
    const block = buildSkillBlock(equipped);
    if (!strict) return block;
    return block
      .replace(
        /SELF-LOAD ANY SKILL[\s\S]*?\(Local models may also use the load_skill \/ list_skills tools\.\)/,
        "ONLY the skills listed above are attached to this personal agent. Do not load or read any other skill pack.",
      );
  }
  if (strict) return "";
  if (!(await anySkillInstalled())) return "";
  const brief = await skillCatalogBrief(ids);
  return [
    "--- SKILLS (available to you on demand) ---",
    "You can load a capability pack yourself when a task calls for it:",
    brief,
    "",
    "SELF-LOAD (works on every model): the full library is mirrored into " +
    "`.owllm/skills/` in your working directory. Read `.owllm/skills/INDEX.md` for " +
    "the catalog, then read `.owllm/skills/<id>/SKILL.md` with your file-read tool to " +
    "load a skill's full instructions. (Local models may also use load_skill / list_skills.)",
    "--- END SKILLS ---",
  ].join("\n");
}
