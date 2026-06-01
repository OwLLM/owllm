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
  /// llama.cpp native repeat penalty (1.0 = off).
  repeat_penalty: number;
  /// How many trailing tokens the repeat penalty considers.
  repeat_last_n: number;
  /// OpenAI-compat penalties (llama-server honours both).
  frequency_penalty: number;
  presence_penalty: number;
  /// llama.cpp DRY (Don't Repeat Yourself) sampler — multi-token loop
  /// suppression. dry_multiplier 0 = off.
  dry_multiplier: number;
  dry_base: number;
  dry_allowed_length: number;
  dry_penalty_last_n: number;
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

// Baseline sampling shared by most families — anti-degeneration on,
// generous token budget. Families override only what differs.
const BASE_SAMPLING: SamplingProfile = {
  max_tokens: 4096,
  repeat_penalty: 1.15,
  repeat_last_n: 256,
  frequency_penalty: 0.4,
  presence_penalty: 0.4,
  dry_multiplier: 0.8,
  dry_base: 1.75,
  dry_allowed_length: 4,
  dry_penalty_last_n: -1,
};

// Bundled default profiles. Ordered most-specific → most-generic.
// The DEFAULT_PROFILE at the end catches anything unmatched.
export const BUNDLED_PROFILES: ModelProfile[] = [
  {
    label: "Qwen 3 (thinking)",
    // Qwen3-Thinking / QwQ variants emit <think> tags and burn a lot
    // of tokens reasoning before the visible reply. They were the
    // family that exposed the whole tool-dialect problem.
    match: ["qwen3", "qwen-3", "qwq", "qwen2.5", "qwen-2.5"],
    sampling: { ...BASE_SAMPLING, max_tokens: 6144 },
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
