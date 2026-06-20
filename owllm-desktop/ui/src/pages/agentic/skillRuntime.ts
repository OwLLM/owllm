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

const SKILL_BODY_BUDGET = 8000; // chars (~2k tokens) of inlined skill instructions

/// Build the SKILL block for a specialist prompt. Descriptions always shown;
/// bodies inlined smallest-first within SKILL_BODY_BUDGET.
export function buildSkillBlock(skills: ResolvedSkill[]): string {
  if (!skills || skills.length === 0) return "";
  // pick which bodies to inline (smallest-first within budget)
  const inlined = new Set<string>();
  let used = 0;
  for (const s of [...skills].sort((a, b) => a.body.length - b.body.length)) {
    if (s.body && used + s.body.length <= SKILL_BODY_BUDGET) { used += s.body.length; inlined.add(s.id); }
  }
  const lines: string[] = ["--- YOUR SKILLS (capability packs equipped on you — use them when relevant) ---"];
  for (const s of skills) {
    if (inlined.has(s.id) && s.body) {
      lines.push(`\n### Skill: ${s.name}\n${s.body.trim()}`);
    } else {
      lines.push(`- ${s.name}: ${s.description || "(no description)"} — full instructions not loaded this turn.`);
    }
  }
  lines.push("--- END SKILLS ---");
  return lines.join("\n");
}
