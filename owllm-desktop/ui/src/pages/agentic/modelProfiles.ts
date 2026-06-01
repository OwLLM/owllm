// modelProfiles.ts — DATA-DRIVEN per-model-family adaptation layer.
//
// Why this file exists (see memory project_post_ship_model_updates):
// every model family has its own tool-call dialect, thinking-tag style,
// degeneration pattern, and optimal sampling. Hardcoding those in the
// dispatch code means the app goes stale the moment a new model lands
// and forces a full .exe rebuild to fix. Instead, everything that
// varies per family lives HERE as data, keyed by a fingerprint of the
// model id, with three resolution layers:
//
//   1. BUNDLED defaults (this file) — works offline on day one.
//   2. LOCAL override — `owllm:model-profiles` in localStorage, a JSON
//      object the power-user (or a future settings pane) can edit to
//      tweak a family without a rebuild.
//   3. REMOTE registry — a signed JSON the app can fetch and cache so
//      we hot-fix the newest model the way antivirus ships signatures.
//      (Hook present; wiring is a follow-up — see loadRemoteProfiles.)
//
// Keep this file PURE DATA + thin resolution logic. No React, no
// network calls at import time, no tool execution.

export type ToolProtocol = "native" | "xml" | "both";
export type ThinkingChannel = "think_tags" | "reasoning_content" | "none" | "auto";

export type SamplingProfile = {
  /// Per-turn token budget. Thinking models need 4k+, plain chat 1k.
  max_tokens: number;
  /// llama.cpp native repeat penalty (1.0 = off). Kept MILD — a high
  /// value here, like high frequency/presence penalties, pushes the
  /// model toward rare tokens and can trigger novel-token degeneration
  /// (the "endless unique proper nouns" spiral). DRY does the heavy
  /// anti-loop work instead.
  repeat_penalty: number;
  /// How many trailing tokens the repeat penalty considers.
  repeat_last_n: number;
  /// OpenAI-compat penalties (llama-server honours both). DANGER: these
  /// penalise reusing ANY token, so when the model is uncertain they
  /// drive it toward ever-rarer tokens and it wanders into incoherent
  /// novel-token rambling. Default 0 — DRY + min_p handle degeneration
  /// without this side effect. Only raise for a model proven to need it.
  frequency_penalty: number;
  presence_penalty: number;
  /// llama.cpp DRY (Don't Repeat Yourself) sampler — multi-token loop
  /// suppression. dry_multiplier 0 = off. This is the PRIMARY anti-loop
  /// mechanism: it penalises repeated SEQUENCES, not individual tokens,
  /// so it kills "I will write the answer / I will write the answer"
  /// loops without pushing the model toward rare tokens.
  dry_multiplier: number;
  dry_base: number;
  dry_allowed_length: number;
  dry_penalty_last_n: number;
  /// Nucleus / tail cutoffs. min_p is the KEY defence against incoherent
  /// wandering: it drops every token below `min_p × P(top token)`, so
  /// once the model enters a degenerate state where no token dominates,
  /// the rare-token tail is cut and it's forced back toward coherent
  /// continuations or EOS. top_k caps the candidate set. top_p is the
  /// usual nucleus. (ChatPage's per-column top_p UI control overrides
  /// the top_p here; min_p/top_k still apply.)
  min_p: number;
  top_k: number;
  top_p: number;
};

export type ModelProfile = {
  /// Human label for logs / future settings UI.
  label: string;
  /// Substrings matched (case-insensitive) against the model id. First
  /// profile whose any-pattern matches wins. Order in PROFILES matters:
  /// most-specific families first, generic catch-alls last.
  match: string[];
  sampling: SamplingProfile;
  /// Which tool-call protocol to lean on. "both" sends the native
  /// `tools` array AND the XML system-prompt catalog (safest default).
  toolProtocol: ToolProtocol;
  /// Where the model puts its reasoning so we can route it to the
  /// collapsed thinking pane instead of the visible reply.
  thinking: ThinkingChannel;
};

// Baseline sampling shared by most families. Anti-degeneration strategy:
//   - DRY sampler kills repeated SEQUENCES (the "I will write the
//     answer ×100" loop) without favouring rare tokens.
//   - min_p cuts the rare-token tail so the model can't spiral into
//     incoherent novel-token rambling (the "endless unique names" wall).
//   - repeat_penalty kept MILD (1.1) and frequency/presence at ZERO,
//     because high values there CAUSE the novel-token spiral by
//     penalising reuse of common tokens.
const BASE_SAMPLING: SamplingProfile = {
  max_tokens: 4096,
  repeat_penalty: 1.1,
  repeat_last_n: 256,
  frequency_penalty: 0.0,
  presence_penalty: 0.0,
  dry_multiplier: 0.8,
  dry_base: 1.75,
  dry_allowed_length: 4,
  dry_penalty_last_n: -1,
  min_p: 0.05,
  top_k: 40,
  top_p: 0.95,
};

// Bundled default profiles. Ordered most-specific → most-generic.
// The DEFAULT_PROFILE at the end catches anything unmatched.
export const BUNDLED_PROFILES: ModelProfile[] = [
  {
    label: "Qwen 3 (thinking)",
    // Qwen3-Thinking / QwQ variants emit <think> tags and burn a lot
    // of tokens reasoning before the visible reply. They were the
    // family that exposed the whole tool-dialect problem AND the
    // catastrophic novel-token degeneration (a wall of unique proper
    // nouns). Qwen's own recommended sampling is temp 0.6 / top_p 0.95
    // / top_k 20 / min_p 0 — but min_p 0 lets the degeneration through,
    // so we floor it at 0.05. top_k 20 per Qwen's guidance tightens the
    // candidate set further.
    match: ["qwen3", "qwen-3", "qwq", "qwen2.5", "qwen-2.5"],
    sampling: { ...BASE_SAMPLING, max_tokens: 6144, top_k: 20, min_p: 0.05, top_p: 0.95 },
    toolProtocol: "both",
    thinking: "auto",
  },
  {
    label: "Llama 3.x",
    match: ["llama-3", "llama3", "llama_3"],
    sampling: { ...BASE_SAMPLING },
    toolProtocol: "both",
    thinking: "auto",
  },
  {
    label: "Hermes",
    match: ["hermes", "nous"],
    sampling: { ...BASE_SAMPLING },
    toolProtocol: "both",
    thinking: "auto",
  },
  {
    label: "Gemma 3",
    match: ["gemma-3", "gemma3", "gemma"],
    sampling: { ...BASE_SAMPLING },
    toolProtocol: "both",
    thinking: "auto",
  },
  {
    label: "Mistral / Nemo / Mixtral",
    match: ["mistral", "nemo", "mixtral", "ministral", "magistral"],
    sampling: { ...BASE_SAMPLING },
    toolProtocol: "both",
    thinking: "auto",
  },
  {
    label: "DeepSeek R1 / V3",
    match: ["deepseek", "r1-distill", "r1_distill"],
    sampling: { ...BASE_SAMPLING, max_tokens: 6144 },
    toolProtocol: "both",
    thinking: "auto",
  },
  {
    label: "Phi",
    match: ["phi-3", "phi3", "phi-4", "phi4"],
    sampling: { ...BASE_SAMPLING },
    toolProtocol: "both",
    thinking: "auto",
  },
  {
    label: "Command-R",
    match: ["command-r", "command_r", "c4ai"],
    sampling: { ...BASE_SAMPLING },
    toolProtocol: "both",
    thinking: "auto",
  },
];

// Catch-all for any model id that matches nothing above. Conservative
// but functional: native + XML tools, anti-degeneration on, auto
// thinking detection.
export const DEFAULT_PROFILE: ModelProfile = {
  label: "Generic local model",
  match: [],
  sampling: { ...BASE_SAMPLING },
  toolProtocol: "both",
  thinking: "auto",
};

// ---- Resolution ----

let _localOverrides: ModelProfile[] | null = null;
let _remoteProfiles: ModelProfile[] | null = null;

/// Parse a user-supplied override list from localStorage. Each entry is
/// a partial ModelProfile merged over the matched bundled profile (or
/// DEFAULT_PROFILE) — the user can override just `sampling.max_tokens`
/// for one family without restating the whole object. Returns null when
/// nothing is stored / the JSON is malformed (logged, never throws).
function loadLocalOverrides(): ModelProfile[] | null {
  if (_localOverrides !== null) return _localOverrides;
  try {
    const raw = localStorage.getItem("owllm:model-profiles");
    if (!raw) { _localOverrides = []; return _localOverrides; }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) { _localOverrides = []; return _localOverrides; }
    _localOverrides = parsed as ModelProfile[];
  } catch (e) {
    console.warn("[modelProfiles] bad owllm:model-profiles override, ignoring", e);
    _localOverrides = [];
  }
  return _localOverrides;
}

/// Hook for the remote signed registry. Call once at startup; it caches
/// the fetched profiles in-memory (and could persist to localStorage for
/// offline). Wiring the actual fetch is a follow-up — the resolver
/// already consults _remoteProfiles so flipping this on is a one-liner.
export function setRemoteProfiles(profiles: ModelProfile[] | null): void {
  _remoteProfiles = profiles;
}

/// Clear cached overrides so a settings-pane edit takes effect without
/// a reload.
export function invalidateProfileCache(): void {
  _localOverrides = null;
}

function deepMergeProfile(base: ModelProfile, over: Partial<ModelProfile>): ModelProfile {
  return {
    label: over.label ?? base.label,
    match: over.match ?? base.match,
    toolProtocol: over.toolProtocol ?? base.toolProtocol,
    thinking: over.thinking ?? base.thinking,
    sampling: { ...base.sampling, ...(over.sampling ?? {}) },
  };
}

function matchProfile(list: ModelProfile[], id: string): ModelProfile | null {
  const lower = id.toLowerCase();
  for (const p of list) {
    if (p.match.some((m) => m && lower.includes(m.toLowerCase()))) return p;
  }
  return null;
}

/// Resolve the effective profile for a model id. Precedence:
///   remote match → local-override match → bundled match → DEFAULT.
/// A local override that matches is deep-merged OVER the bundled match
/// (or DEFAULT) so partial overrides work.
export function resolveModelProfile(modelId: string): ModelProfile {
  const id = (modelId || "").trim();
  if (!id) return DEFAULT_PROFILE;

  // Strip the ModelPicker route prefix (sub/ api/ auto/) if present —
  // we want the bare model id for family matching.
  const bare = id.replace(/^(sub|api|auto)\//, "");

  const remote = _remoteProfiles ? matchProfile(_remoteProfiles, bare) : null;
  if (remote) return remote;

  const bundledMatch = matchProfile(BUNDLED_PROFILES, bare) ?? DEFAULT_PROFILE;

  const overrides = loadLocalOverrides();
  const overrideMatch = overrides ? matchProfile(overrides, bare) : null;
  if (overrideMatch) return deepMergeProfile(bundledMatch, overrideMatch);

  return bundledMatch;
}

/// Convenience: just the sampling block, ready to spread into a
/// /v1/chat/completions request body. This is the ONE place the
/// dispatch code reads sampling from — no inline literals anywhere else.
export function samplingFor(modelId: string): SamplingProfile {
  return resolveModelProfile(modelId).sampling;
}
