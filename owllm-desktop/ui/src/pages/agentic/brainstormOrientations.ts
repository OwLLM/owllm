// Brainstorm orientations — WHAT THE IDEA IS FOR, which is a different question
// from the mode in brainstormModes.ts (that one picks the TRACK: new product /
// improvement / research / open).
//
// The mode alone left one thing unsaid: even TRACK C and TRACK D briefs came
// back written like a pitch, because the co-founder wrapper's own vocabulary is
// commercial. A hobby project got an ICP paragraph, a science question got
// "unlock" and "game-changing". Orientation fixes the framing and the WORDING
// without touching which track runs.
//
// Multiple orientations can be checked at once — an idea can be a business AND
// a social-media play — so this is a set, not a radio choice. When nothing is
// checked the balanced fallback applies: no orientation is invented, and the
// commercial angle gets no more room than any other.
//
// Pure module: no React, no Tauri. brainstormOrientations.verify.run.mjs imports
// it directly.

export type BrainstormOrientationId = "business" | "science" | "fun" | "social";

export type BrainstormOrientation = {
  id: BrainstormOrientationId;
  icon: string;
  label: string;
  /// One line next to the checkbox: what checking it changes.
  hint: string;
  /// Injected as a bullet under the orientation header when checked.
  directive: string;
};

export const BRAINSTORM_ORIENTATIONS: BrainstormOrientation[] = [
  {
    id: "business",
    icon: "💼",
    label: "Business / Product",
    hint: "Users, value, positioning and money are in scope.",
    directive: [
      "BUSINESS / PRODUCT — commercial framing is wanted here: who the users are, what they would",
      "actually pay for, how this sits against the alternatives, and what value each step buys.",
      "Keep it evidence-backed and concrete rather than aspirational.",
    ].join(" "),
  },
  {
    id: "science",
    icon: "🧪",
    label: "Scientific research",
    hint: "Hypothesis, method, evidence and what would falsify it.",
    directive: [
      "SCIENTIFIC RESEARCH — frame this as an investigation: state the question or hypothesis, the",
      "method, the data or sources it rests on, and what result would falsify it. Quantify uncertainty,",
      "cite what you rely on, and keep what is measured separate from what is assumed.",
    ].join(" "),
  },
  {
    id: "fun",
    icon: "🎉",
    label: "Just for fun",
    hint: "No business case needed — delight, novelty, quick to try.",
    directive: [
      "JUST FOR FUN — this does not have to earn money, scale, or be defensible to anyone. Optimise for",
      "delight, novelty and how fast it can be tried. Do not ask for a business case, a market size or a",
      "monetisation plan, and do not treat 'nobody would pay for this' as an objection.",
    ].join(" "),
  },
  {
    id: "social",
    icon: "📣",
    label: "Social media",
    hint: "Audience, platform, format, hook and cadence.",
    directive: [
      "SOCIAL MEDIA — think in audience, platform, format, hook and cadence. Name the specific platforms",
      "and the post/video shapes, and say what makes someone stop scrolling. This is about the content",
      "itself, not about running an ad campaign.",
    ].join(" "),
  },
];

/// Header for the injected block. It says out loud that orientation is
/// orthogonal to the TRACK, so a model that already has a mode directive cannot
/// read this as a second, competing mode.
const ORIENTATION_HEADER =
  "ORIENTATION (the user checked these — they tune the framing and the wording of the brief; they do NOT change which TRACK you follow):";

/// What goes in when the user checked nothing. It must not silently fall back to
/// the commercial framing that made every brief read like a pitch.
export const NEUTRAL_ORIENTATION_DIRECTIVE = [
  "ORIENTATION: BALANCED — the user checked no orientation, so do not invent one.",
  "Weigh the idea on its own terms and give the practical, human and technical angles equal room; the",
  "commercial angle gets no more space than any other. If knowing what this is FOR would actually change",
  "your answer, ask the user instead of assuming.",
].join(" ");

/// The tone guard. Applied whenever Business/Product is NOT checked — including
/// the balanced fallback. It bans pitch VOCABULARY and unrequested commercial
/// sections, but deliberately leaves the track's own required sections alone: a
/// TRACK A brief still owes its ICP table, it just states it factually.
export const NO_SALES_TONE_DIRECTIVE = [
  "TONE: no sales language. Business/Product is not checked, so write plain factual prose —",
  "no pitch or marketing copy, and none of the hype vocabulary (revolutionary, game-changing, seamless,",
  "unlock, supercharge, 10x, must-have, cutting-edge). Keep whatever sections your track requires, but",
  "do not add commercial framing — positioning, monetisation, pricing, growth — that the track does not",
  "already ask for.",
].join(" ");

/// Only meaningful when more than one is checked: they compose, and a real
/// conflict (fun vs. business) is surfaced rather than silently resolved.
export const BLENDED_ORIENTATION_DIRECTIVE = [
  "These orientations apply TOGETHER — satisfy every one of them in the same brief instead of picking a",
  "favourite. Where two of them pull in different directions, name the tension in one line and let the",
  "user decide.",
].join(" ");

export function isBrainstormOrientationId(value: unknown): value is BrainstormOrientationId {
  return typeof value === "string" && BRAINSTORM_ORIENTATIONS.some((o) => o.id === value);
}

/// Anything → a clean, deduplicated set in catalogue order. Checkpoints written
/// by older builds have no `orientations` field at all, and a hand-edited
/// .owllm/brainstorm.json can hold junk; both must land on "nothing checked"
/// rather than throwing on open.
export function normalizeOrientations(value: unknown): BrainstormOrientationId[] {
  if (!Array.isArray(value)) return [];
  const picked = new Set(value.filter(isBrainstormOrientationId));
  return BRAINSTORM_ORIENTATIONS.filter((o) => picked.has(o.id)).map((o) => o.id);
}

export function toggleOrientation(
  current: readonly BrainstormOrientationId[],
  id: BrainstormOrientationId,
): BrainstormOrientationId[] {
  const has = current.includes(id);
  return normalizeOrientations(has ? current.filter((x) => x !== id) : [...current, id]);
}

/// Sales/marketing vocabulary is allowed only when the user asked for the
/// commercial lens. This is the single predicate the prompt builder and the UI
/// both read, so they can't disagree about it.
export function allowsSalesLanguage(ids: readonly BrainstormOrientationId[]): boolean {
  return normalizeOrientations(ids).includes("business");
}

/// The block appended to the co-founder system prompt and to the opening turn.
/// Never empty — "nothing checked" is itself an instruction.
export function orientationDirective(ids: readonly BrainstormOrientationId[]): string {
  const chosen = normalizeOrientations(ids);
  const parts: string[] = [];
  if (chosen.length === 0) {
    parts.push(NEUTRAL_ORIENTATION_DIRECTIVE);
  } else {
    parts.push(ORIENTATION_HEADER);
    for (const id of chosen) {
      const o = BRAINSTORM_ORIENTATIONS.find((x) => x.id === id)!;
      parts.push(`• ${o.directive}`);
    }
    if (chosen.length > 1) parts.push(BLENDED_ORIENTATION_DIRECTIVE);
  }
  if (!allowsSalesLanguage(chosen)) parts.push(NO_SALES_TONE_DIRECTIVE);
  return parts.join("\n");
}

/// The line under the checkboxes.
export function orientationSummary(ids: readonly BrainstormOrientationId[]): string {
  const chosen = normalizeOrientations(ids);
  if (chosen.length === 0) {
    return "Balanced — no orientation chosen, so no angle is assumed and the brief stays free of sales language.";
  }
  const labels = chosen.map((id) => BRAINSTORM_ORIENTATIONS.find((o) => o.id === id)!.label).join(" + ");
  return allowsSalesLanguage(chosen)
    ? `${labels} — commercial framing is allowed.`
    : `${labels} — plain factual wording, no sales language.`;
}

/// Per-project preference key. The checkpoint carries the orientations of the
/// conversation in progress; this remembers the user's choice for the NEXT one,
/// so it survives 🆕 Start fresh, a new project open, and an app restart the
/// same way the brainstorm model does.
export function orientationPrefKey(projectId?: string): string {
  return projectId ? `owllm:brainstorm-orientations:${projectId}` : "";
}

export function readOrientationPref(
  storage: Pick<Storage, "getItem">,
  projectId?: string,
): BrainstormOrientationId[] {
  const key = orientationPrefKey(projectId);
  if (!key) return [];
  try {
    return normalizeOrientations(JSON.parse(storage.getItem(key) ?? "[]"));
  } catch {
    return [];
  }
}

export function writeOrientationPref(
  storage: Pick<Storage, "setItem">,
  projectId: string | undefined,
  ids: readonly BrainstormOrientationId[],
): void {
  const key = orientationPrefKey(projectId);
  if (!key) return;
  try {
    storage.setItem(key, JSON.stringify(normalizeOrientations(ids)));
  } catch {
    /* private mode / quota — the checkpoint still carries the live set */
  }
}
