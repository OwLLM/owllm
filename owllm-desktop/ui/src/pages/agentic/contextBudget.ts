// contextBudget.ts — how much prior conversation may be folded into ONE prompt,
// sized to the model that is actually about to read it.
//
// Why this exists: the history fold was a FIXED 24 turns / 60,000 characters for
// every model. That single number is wrong in both directions at once —
//   * a local 8K-context GGUF: 60,000 chars is ~16,000 tokens of history on top
//     of a system prompt, tool specs and a memory snapshot. The prompt overflows
//     and llama-server silently truncates it, cutting the orchestrator's dispatch
//     list in half with no error anywhere.
//   * a 256K-window subscription model: 60,000 chars is ~6% of the window, so the
//     run throws away context it had ample room for and the team "forgets" what
//     it decided three turns ago.
//
// Everything here is data + pure arithmetic so it can be proved without a
// running app (see contextBudget.verify.run.mjs).

/// Characters per token, English prose mixed with code. Measured against a real
/// run recorded in the dispatch log: 778,606 characters folded into an
/// orchestrator prompt reported 210,669 input tokens = 3.70 chars/token. Rounded
/// DOWN to 3.5 so the estimate errs toward "this is bigger than you think".
export const CHARS_PER_TOKEN = 3.5;

/// Share of the context window history may claim. The rest is reserved for the
/// system prompt (role + operating contract + skills + memory snapshot), the
/// tool specs, the current user message, and the model's own output — all of
/// which are unbounded-ish and none of which this budget controls.
export const HISTORY_WINDOW_SHARE = 0.35;

/// Used when nothing else is known and the id does not look like a cloud model.
/// Matches the llama-server default the Rust side falls back to (server.rs), so
/// an unrecognised local GGUF is budgeted for the window it most likely got.
export const FALLBACK_LOCAL_CONTEXT_TOKENS = 8_192;

/// Used when nothing matches but the id carries a cloud prefix. Every current
/// cloud model is at least this large; being wrong here costs a little unused
/// window, never an overflow.
export const FALLBACK_CLOUD_CONTEXT_TOKENS = 128_000;

/// Context windows in TOKENS, keyed by a lowercase substring of the model id.
/// Ordered most-specific first — the first match wins. Values are the vendor's
/// documented standard window; where a larger window exists only behind a beta
/// header or a paid tier we deliberately keep the standard one, because
/// over-estimating overflows the prompt and under-estimating merely wastes room.
const CONTEXT_WINDOWS: Array<[string, number]> = [
  // --- OpenAI / Codex subscription -----------------------------------------
  // 258,400 measured live from this app's own session logs on gpt-5.6-sol.
  ["gpt-5", 258_400],
  ["codex", 258_400],
  ["o3", 200_000],
  ["o4", 200_000],
  ["gpt-4.1", 1_000_000],
  ["gpt-4o", 128_000],
  // --- Anthropic ------------------------------------------------------------
  ["opus", 200_000],
  ["sonnet", 200_000],
  ["haiku", 200_000],
  ["claude", 200_000],
  ["fable", 200_000],
  // --- Google ---------------------------------------------------------------
  ["gemini", 1_000_000],
  // --- xAI ------------------------------------------------------------------
  ["grok", 256_000],
  // --- Moonshot -------------------------------------------------------------
  ["kimi", 256_000],
  // --- Other cloud ----------------------------------------------------------
  ["deepseek", 128_000],
  ["mistral", 128_000],
  ["qwen", 32_768],
  ["llama-3", 128_000],
  ["llama3", 128_000],
  ["gemma", 8_192],
  ["phi", 16_384],
];

/// Does this id name a cloud/subscription model rather than a local GGUF?
/// The dispatcher prefixes cloud ids with `sub/` or `api/`; anything else is a
/// file on disk served by llama-server.
function looksCloud(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return id.startsWith("sub/") || id.startsWith("api/");
}

/// The context window, in tokens, of the model this prompt is going to.
///
/// `liveWindow` is the authoritative answer for a LOCAL model: it is the `-c`
/// value llama-server was actually granted (`server_status().context`), which
/// beats any guess from the file name — the same GGUF runs at 8K on one machine
/// and 128K on another purely because of VRAM.
export function contextWindowFor(modelId: string, liveWindow?: number | null): number {
  if (typeof liveWindow === "number" && Number.isFinite(liveWindow) && liveWindow > 0) {
    return Math.floor(liveWindow);
  }
  const id = (modelId || "").toLowerCase();
  for (const [needle, window] of CONTEXT_WINDOWS) {
    if (id.includes(needle)) return window;
  }
  return looksCloud(id) ? FALLBACK_CLOUD_CONTEXT_TOKENS : FALLBACK_LOCAL_CONTEXT_TOKENS;
}

export type HistoryBudget = {
  /// Newest turns to keep.
  turns: number;
  /// Total characters those turns may occupy.
  chars: number;
  /// The window the budget was derived from — for diagnostics.
  contextTokens: number;
};

/// How many prior turns, and how many characters of them, may be folded into a
/// prompt for this model.
///
/// The turn count scales with the window too: 24 turns of a long agentic
/// exchange cannot fit in 8K no matter how the characters are counted, and
/// capping a 1M-window model at 24 turns wastes the thing it was chosen for.
export function historyBudgetFor(modelId: string, liveWindow?: number | null): HistoryBudget {
  const contextTokens = contextWindowFor(modelId, liveWindow);
  const chars = Math.max(
    2_000,
    Math.floor((contextTokens * HISTORY_WINDOW_SHARE) * CHARS_PER_TOKEN),
  );
  const turns =
    contextTokens <= 16_384 ? 8
      : contextTokens <= 65_536 ? 16
        : contextTokens <= 400_000 ? 32
          : 64;
  return { turns, chars, contextTokens };
}
