// Brainstorm modes — WHAT KIND of thinking the co-founder does before it
// writes BRIEF.md.
//
// The brainstormer role used to infer this on its own (STEP 0: NEW vs
// IMPROVEMENT), which meant every brainstorm was framed as a product/market
// exercise: competitor scans, ICP, feature-frequency tables. That is one job
// out of several — a research question or an open "help me think" session got
// the same marketing scaffolding.
//
// The user now picks the mode up front. Each entry carries:
//   • the directive injected into the brainstormer's system prompt (it names
//     the TRACK in resources/agents/roles/brainstormer.yaml to follow, so the
//     prompt and the role can never disagree about which tracks exist),
//   • whether that track does web research — which is the only reason a Brave
//     Search key matters, so the UI stops demanding one unconditionally,
//   • the idea-box placeholder and opening question, so the panel reads like
//     the job the user actually chose.
//
// Pure module: no React, no Tauri. brainstormModes.verify.run.mjs imports it
// directly.

export type BrainstormModeId = "auto" | "product" | "improvement" | "research" | "open";

/// "always" → the track always searches the web; "maybe" → only some branches
/// do; "never" → it works from the repo and the conversation alone.
export type WebResearchNeed = "always" | "maybe" | "never";

export type BrainstormMode = {
  id: BrainstormModeId;
  icon: string;
  label: string;
  /// One line under the chip: what this mode produces.
  hint: string;
  webResearch: WebResearchNeed;
  placeholder: string;
  /// Appended to the co-founder wrapper. Empty for "auto" — that is exactly
  /// today's behaviour, where STEP 0 of the role decides.
  directive: string;
  /// What the first turn asks the user for.
  opening: string;
};

export const BRAINSTORM_MODES: BrainstormMode[] = [
  {
    id: "auto",
    icon: "🎯",
    label: "Auto",
    hint: "Let the co-founder read the idea and pick the right track.",
    webResearch: "maybe",
    placeholder: "e.g. A Gmail-native CRM I can use for my own business contacts. Or: make the project list load faster.",
    directive: "",
    opening: "Start as my co-founder: ask me your sharpest 1-3 questions (no tools yet).",
  },
  {
    id: "product",
    icon: "🚀",
    label: "New product",
    hint: "Market + competitor scan → v1 feature priority → build plan.",
    webResearch: "always",
    placeholder: "e.g. A Gmail-native CRM for solo consultants who live in their inbox.",
    directive: [
      "MODE: NEW PROJECT (the user chose it — do NOT re-decide the mode).",
      "Follow TRACK A of your role: clarify the ICP, scan 5 real competitors, gather open-source prior art and real user pain, build the feature-frequency table, and write the NEW-PROJECT brief.",
    ].join("\n"),
    opening: "Start as my co-founder on this new product: ask me your sharpest 1-3 questions (no tools yet).",
  },
  {
    id: "improvement",
    icon: "🛠",
    label: "Improve this app",
    hint: "Read the real code in this project → ordered change plan. No market research.",
    webResearch: "never",
    placeholder: "e.g. Make the brainstorm board work for improvement briefs, not just product ones.",
    directive: [
      "MODE: IMPROVEMENT (the user chose it — do NOT re-decide the mode).",
      "Follow TRACK B of your role: no competitor research at all. Inspect the code in this project with grep/glob/read_file, ground every step in real file paths and symbols you actually read, and write the IMPROVEMENT brief.",
    ].join("\n"),
    opening: "Start as my co-founder on this change: ask me your sharpest 1-3 questions (no tools yet).",
  },
  {
    id: "research",
    icon: "🔬",
    label: "Research",
    hint: "Answer a question from cited sources → compare options → recommend.",
    webResearch: "always",
    placeholder: "e.g. Which local model format gives the best tool-calling reliability on 16 GB VRAM, and why?",
    directive: [
      "MODE: RESEARCH (the user chose it — do NOT re-decide the mode).",
      "Follow TRACK C of your role: this is a question to answer, not a product to launch. No ICP, no competitor scan, no feature-priority table. Gather cited sources, compare the real options, give a recommendation you can defend, and write the RESEARCH brief.",
    ].join("\n"),
    opening: "Start as my research partner: ask me your sharpest 1-3 questions about what I actually need to decide (no tools yet).",
  },
  {
    id: "open",
    icon: "💬",
    label: "Open idea",
    hint: "Freeform thinking partner: diverge, then converge on one direction.",
    webResearch: "maybe",
    placeholder: "e.g. I keep losing track of what my agents did overnight. Help me think about what would actually fix that.",
    directive: [
      "MODE: OPEN (the user chose it — do NOT re-decide the mode).",
      "Follow TRACK D of your role: no competitor scan and no market framing. Think WITH the user — widen the option space first, then narrow it to one direction with honest trade-offs, and write the OPEN brief. Use tools only if the user's own project or a specific fact needs checking.",
    ].join("\n"),
    opening: "Start as my thinking partner: ask me your sharpest 1-3 questions (no tools yet).",
  },
];

const DEFAULT_MODE = BRAINSTORM_MODES[0];

export function brainstormMode(id: string | null | undefined): BrainstormMode {
  return BRAINSTORM_MODES.find((m) => m.id === id) ?? DEFAULT_MODE;
}

export function isBrainstormModeId(value: unknown): value is BrainstormModeId {
  return typeof value === "string" && BRAINSTORM_MODES.some((m) => m.id === value);
}

/// The Brave Search key only matters for tracks that call web_search. Returning
/// null means "don't show the requirement at all" — the old panel showed it
/// unconditionally, including for improvement briefs that never search.
export function webResearchNotice(mode: BrainstormMode): string | null {
  if (mode.webResearch === "always") return "🔑 Brave Search key required (set in Accounts page)";
  if (mode.webResearch === "maybe") return "🔑 Brave Search key needed only if this turns into web research";
  return null;
}

export type BriefFeature = { feature: string; priority: "v1" | "v2" | "opportunity" | "drop" };

/// Parse the "## Feature Priority" table out of BRIEF.md into structured rows so
/// the board view can show features as columns. Forgiving: returns [] when the
/// section/table isn't there (only TRACK A briefs have one).
export function parseBriefFeatures(brief: string): BriefFeature[] {
  const out: BriefFeature[] = [];
  if (!brief) return out;
  const lines = brief.replace(/\r\n/g, "\n").split("\n");
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^##\s+feature priority/i.test(line)) { inSection = true; continue; }
    if (inSection && /^##\s+/.test(line)) break; // next section ends it
    if (!inSection || !line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    const feature = cells[0];
    const prioRaw = cells[cells.length - 1].toLowerCase();
    if (!feature || /^feature$/i.test(feature) || /^[-:\s]+$/.test(feature)) continue; // header/separator
    const priority: BriefFeature["priority"] =
      prioRaw.includes("v1") ? "v1"
      : prioRaw.includes("opportunity") ? "opportunity"
      : prioRaw.includes("v2") ? "v2"
      : prioRaw.includes("drop") ? "drop"
      : "v2";
    out.push({ feature, priority });
  }
  return out;
}

/// The transcript is fully reconstructable from convHistory, so a checkpoint
/// that also carries every streamed line stores the conversation twice and
/// grows without bound — and it is rewritten to disk on nearly every keystroke.
/// Past this budget the lines are dropped from the checkpoint; hydration
/// rebuilds a readable transcript from the history instead.
export const CHECKPOINT_LINES_BUDGET = 40_000;

export function checkpointLines<T extends { text: string }>(lines: T[]): T[] {
  let total = 0;
  for (const line of lines) {
    total += line.text.length;
    if (total > CHECKPOINT_LINES_BUDGET) return [];
  }
  return lines;
}
