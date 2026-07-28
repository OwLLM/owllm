// cloudCatalogue.ts — DATA-DRIVEN cloud / subscription / API model list.
//
// Why this file exists (memory project_post_ship_model_updates): the
// set of pickable Claude / GPT / Gemini / … models must be updatable
// AFTER ship, without editing code and rebuilding the .exe. When
// Anthropic releases Opus 4.8, a user should be able to select it the
// same day. So the catalogue is data, with three resolution layers:
//
//   1. BUNDLED defaults (this file) — works offline on day one.
//   2. LOCAL override — `owllm:cloud-models` in localStorage, a partial
//      catalogue the user (or a settings pane) edits to add/replace
//      models per provider without a rebuild.
//   3. REMOTE registry — a signed JSON the app can fetch + cache so we
//      ship new-model support the way antivirus ships signatures.
//      (Hook present; wiring is a follow-up — see setRemoteCloudCatalogue.)
//
// Keep this PURE DATA + thin merge logic. No React, no network at import.

export type CloudModelDef = {
  /// Bare model id (no sub//api/ prefix; the picker adds that).
  id: string;
  display: string;
  /// Show a "(subscription)" row routed via the provider's CLI.
  sub?: boolean;
  /// Show an "(API)" row routed via the provider's API key.
  api?: boolean;
  /// Expose one row per reasoning-effort tier (encoded as `<id>:<level>`).
  effort?: readonly string[];
};

export type CloudProvider =
  | "anthropic" | "openai" | "kimi" | "deepseek" | "xai"
  | "groq" | "perplexity" | "mistral" | "together" | "gemini";

export type CloudCatalogue = Record<CloudProvider, CloudModelDef[]>;

// Bundled defaults. Anthropic/OpenAI rows can carry an effort tier; the
// rest are flat. Update this list when a new flagship ships AND it's the
// safe default for fresh installs — but users no longer have to wait for
// a rebuild (they can add it via the localStorage override below).
export const BUNDLED_CLOUD_CATALOGUE: CloudCatalogue = {
  anthropic: [
    // Fable 5 — newest Claude generation (alongside the 4.X family).
    { id: "claude-fable-5",    display: "Claude Fable 5",    effort: ["low", "medium", "high", "extra_high"] },
    // Opus 5 — current Opus flagship (GA). A step-change over 4.8 on
    // agentic coding + long-horizon work, at 4.8's pricing. Default-on so
    // fresh installs get it without an override.
    { id: "claude-opus-5",     display: "Claude Opus 5",     effort: ["low", "medium", "high", "extra_high"] },
    // Sonnet 5 — the balanced gen-5 tier: near-flagship quality at a fraction of
    // Opus pricing, so it's the sensible default for high-volume agent work.
    { id: "claude-sonnet-5",   display: "Claude Sonnet 5",   effort: ["low", "medium", "high", "extra_high"] },
    { id: "claude-opus-4-8",   display: "Claude Opus 4.8",   effort: ["low", "medium", "high", "extra_high"] },
    { id: "claude-opus-4-7",   display: "Claude Opus 4.7",   effort: ["low", "medium", "high", "extra_high"] },
    { id: "claude-sonnet-4-6", display: "Claude Sonnet 4.6", effort: ["low", "medium", "high", "extra_high"] },
    { id: "claude-haiku-4-5-20251001", display: "Claude Haiku 4.5" },
  ],
  openai: [
    // GPT-5.6 family — current flagship line (July 2026). Sol is the
    // frontier tier; Terra balances cost; Luna is the budget tier.
    { id: "gpt-5.6-sol",   display: "GPT-5.6 Sol",    sub: true, api: true, effort: ["low", "medium", "high", "extra_high"] },
    { id: "gpt-5.6-terra", display: "GPT-5.6 Terra",  sub: true, api: true, effort: ["low", "medium", "high", "extra_high"] },
    { id: "gpt-5.6-luna",  display: "GPT-5.6 Luna",   sub: true, api: true },
    { id: "gpt-5.5",       display: "GPT-5.5 Codex",  sub: true, api: true, effort: ["low", "medium", "high", "extra_high"] },
    { id: "gpt-5.4",       display: "GPT-5.4",        api: true, effort: ["low", "medium", "high", "extra_high"] },
    { id: "gpt-5.4-mini",  display: "GPT-5.4 mini",   api: true },
    { id: "gpt-4o",        display: "GPT-4o",         api: true },
    { id: "gpt-4o-mini",   display: "GPT-4o mini",    api: true },
  ],
  kimi: [
    { id: "kimi-k3",          display: "Kimi K3",                sub: true, api: true },
    { id: "kimi-k2.7",        display: "Kimi K2.7",              sub: true, api: true },
    { id: "kimi-k2.6",        display: "Kimi K2.6",              sub: true, api: true },
    { id: "kimi-k2.5",        display: "Kimi K2.5 (multimodal)", sub: true, api: true },
    { id: "moonshot-v1-128k", display: "Moonshot V1 · 128K",     api: true },
  ],
  deepseek: [
    { id: "deepseek-v4-pro",   display: "DeepSeek V4 Pro",   api: true },
    { id: "deepseek-v4-flash", display: "DeepSeek V4 Flash", api: true },
  ],
  xai: [
    // Grok 4.5 — current flagship (July 2026). Subscription rows route
    // via the Grok Build CLI (SuperGrok / X Premium+); API via XAI_API_KEY.
    { id: "grok-4.5",      display: "Grok 4.5",      sub: true, api: true },
    { id: "grok-4.3",      display: "Grok 4.3",      sub: true, api: true },
    { id: "grok-4.20",     display: "Grok 4.20",     sub: true, api: true },
    { id: "grok-4.1-fast", display: "Grok 4.1 Fast", api: true },
  ],
  groq: [
    { id: "llama-3.3-70b-versatile",       display: "Llama 3.3 70B (fast)",    api: true },
    { id: "llama-4-scout",                 display: "Llama 4 Scout",           api: true },
    { id: "qwen3-32b",                     display: "Qwen 3 32B",              api: true },
    { id: "deepseek-r1-distill-llama-70b", display: "DeepSeek R1 Distill 70B", api: true },
    { id: "gpt-oss-120b",                  display: "gpt-oss 120B",            api: true },
  ],
  perplexity: [
    { id: "sonar-pro",       display: "Sonar Pro (search)", api: true },
    { id: "sonar",           display: "Sonar (search)",     api: true },
    { id: "sonar-reasoning", display: "Sonar Reasoning",    api: true },
  ],
  mistral: [
    { id: "mistral-large-latest",    display: "Mistral Large",         api: true },
    { id: "magistral-medium-latest", display: "Magistral (reasoning)", api: true },
    { id: "codestral-latest",        display: "Codestral",             api: true },
    { id: "mistral-small-latest",    display: "Mistral Small",         api: true },
  ],
  together: [
    { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", display: "Llama 3.3 70B Turbo", api: true },
    { id: "Qwen/Qwen2.5-72B-Instruct-Turbo",         display: "Qwen 2.5 72B Turbo",  api: true },
    { id: "deepseek-ai/DeepSeek-V3",                 display: "DeepSeek V3",         api: true },
    { id: "mistralai/Mixtral-8x22B-Instruct-v0.1",   display: "Mixtral 8x22B",       api: true },
  ],
  gemini: [
    { id: "gemini-2.5-pro",        display: "Gemini 2.5 Pro",        sub: true, api: true },
    { id: "gemini-2.5-flash",      display: "Gemini 2.5 Flash",      sub: true, api: true },
    { id: "gemini-2.5-flash-lite", display: "Gemini 2.5 Flash-Lite", api: true },
  ],
};

const PROVIDERS: CloudProvider[] = [
  "anthropic", "openai", "kimi", "deepseek", "xai",
  "groq", "perplexity", "mistral", "together", "gemini",
];

let _remote: Partial<CloudCatalogue> | null = null;
let _localCache: Partial<CloudCatalogue> | null | undefined = undefined;

// Subscribers (e.g. the open ModelPicker) re-render when the catalogue
// changes. Without this, the async remote refresh updates `_remote` but no
// component knows — so a brand-new remote model (Fable 5) only appeared on
// the NEXT app launch, once it was cached + applied synchronously. Now it
// shows the same session the fetch completes.
const _listeners = new Set<() => void>();
function _emit(): void { for (const l of _listeners) l(); }

/// Subscribe to catalogue changes; returns an unsubscribe fn.
export function subscribeCloudCatalogue(cb: () => void): () => void {
  _listeners.add(cb);
  return () => { _listeners.delete(cb); };
}

/// Hook for the remote signed registry. Call once at startup with the
/// fetched partial catalogue; merge precedence is remote > local > bundled.
export function setRemoteCloudCatalogue(cat: Partial<CloudCatalogue> | null): void {
  _remote = cat;
  _emit();
}

/// Drop the cached localStorage override so a settings-pane edit takes
/// effect without an app reload.
export function invalidateCloudCatalogueCache(): void {
  _localCache = undefined;
  _emit();
}

function loadLocalOverride(): Partial<CloudCatalogue> | null {
  if (_localCache !== undefined) return _localCache;
  try {
    const raw = localStorage.getItem("owllm:cloud-models");
    _localCache = raw ? (JSON.parse(raw) as Partial<CloudCatalogue>) : null;
  } catch (e) {
    console.warn("[cloudCatalogue] bad owllm:cloud-models override, ignoring", e);
    _localCache = null;
  }
  return _localCache;
}

/// Merge one provider's override list over the base: an override entry
/// with an existing id REPLACES it (lets users fix a display name or
/// effort tiers); a new id is APPENDED to the front (newest first).
function mergeProvider(base: CloudModelDef[], over: CloudModelDef[] | undefined): CloudModelDef[] {
  if (!over || over.length === 0) return base;
  const out = base.slice();
  const prepend: CloudModelDef[] = [];
  for (const m of over) {
    const idx = out.findIndex((b) => b.id === m.id);
    if (idx >= 0) out[idx] = m;
    else prepend.push(m);
  }
  return [...prepend, ...out];
}

/// The effective catalogue: bundled, with local-override then remote
/// merged on top per provider.
export function getCloudCatalogue(): CloudCatalogue {
  const local = loadLocalOverride();
  const out = {} as CloudCatalogue;
  for (const p of PROVIDERS) {
    let list = BUNDLED_CLOUD_CATALOGUE[p];
    if (local) list = mergeProvider(list, local[p]);
    if (_remote) list = mergeProvider(list, _remote[p]);
    out[p] = list;
  }
  return out;
}

// ---- Remote registry (post-ship model updates) ----
//
// The app pulls a JSON catalogue from a URL you host (default: a raw file
// in the repo) at startup. Push one JSON update and every user gets new
// models — e.g. Claude Opus 4.9 the day it ships — with no rebuild and no
// per-user localStorage editing. The last good fetch is cached so it
// still applies offline.

const REMOTE_CACHE_KEY = "owllm:cloud-models-remote";
const REMOTE_URL_KEY = "owllm:cloud-models-url";
const DEFAULT_REMOTE_URL =
  "https://raw.githubusercontent.com/ruigro/LLM-Studio/main/model-catalogue.json";

function remoteUrl(): string {
  try { return localStorage.getItem(REMOTE_URL_KEY) || DEFAULT_REMOTE_URL; }
  catch { return DEFAULT_REMOTE_URL; }
}

/// Apply the cached remote catalogue immediately (sync, offline-safe).
/// Call once at startup BEFORE the async refresh so the picker shows the
/// last-known models even with no network.
export function applyCachedRemoteCatalogue(): void {
  try {
    const raw = localStorage.getItem(REMOTE_CACHE_KEY);
    if (raw) { _remote = JSON.parse(raw) as Partial<CloudCatalogue>; _emit(); }
  } catch (e) {
    console.warn("[cloudCatalogue] bad cached remote catalogue", e);
  }
}

/// Fetch the remote catalogue via the Rust fetch_remote_text command
/// (avoids WebView CORS/CSP), validate it's an object, cache + apply it.
/// Fire-and-forget at startup; failures are logged and ignored (we keep
/// the cached/bundled catalogue). `invoke` is injected so this module
/// stays free of a hard @tauri-apps dependency at import time.
export async function refreshRemoteCatalogue(
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>,
): Promise<boolean> {
  try {
    const body = await invoke<string>("fetch_remote_text", { url: remoteUrl() });
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn("[cloudCatalogue] remote catalogue is not an object — ignoring");
      return false;
    }
    _remote = parsed as Partial<CloudCatalogue>;
    _emit(); // tell open pickers to re-render with the new models
    try { localStorage.setItem(REMOTE_CACHE_KEY, JSON.stringify(parsed)); } catch { /* quota */ }
    return true;
  } catch (e) {
    // Offline / 404 / bad JSON — keep cached + bundled. Not an error worth
    // bothering the user with.
    console.info("[cloudCatalogue] remote refresh skipped:", String(e));
    return false;
  }
}
