// Session-level cache for `accounts_status` — the "which providers are
// connected" probe.
//
// WHY: accounts_status is NOT free. accounts_status_blocking (accounts.rs)
// runs find_claude_cli / find_codex_cli / find_gemini_cli / find_kimi_cli /
// find_grok_cli, and each one walks PATH plus a long candidate-directory list
// with filesystem stats. Eight separate components fetched it on mount, so
// every page navigation re-ran the same scan and every page painted its
// provider badges twice — once empty, once resolved. That late-resolving
// state is a visible pop-in on each page open.
//
// AUDIT — what each accounts_status caller actually guards:
//
//   FUNCTIONAL GATING (must be fresh at the moment of use — NOT cached):
//     dispatch.ts (claude/codex CLI reachability before a dispatch),
//     AgentsPage's forceSub path. These run when the user actually sends
//     work, not on mount, and a stale "connected" there would surface as a
//     confusing CLI error instead of an honest "not detected" message.
//     They keep calling invoke() directly, by design.
//
//   INFORMATIONAL ONLY (badge / dimmed-picker feedback — cached here):
//     AgentsPage, CodePage, StudioPage, TeamMemoryModal, WatcherDrawer,
//     ChatPage, DatasetBuilderPage, bridgeCore. Nothing is blocked by these;
//     they only decide whether a model entry renders enabled or dimmed. They
//     read the cache and re-render when it changes.
//
//   LIVE (page-scoped, opt-in): AccountsPage — the one screen where an
//     external OAuth flow can complete while the user watches. It calls
//     startAccountsWatch() while mounted, which drives ONE shared poll that
//     every other subscriber gets for free. No other page polls.
//
// Two layers, matching readinessStore:
//   1. Module-scope session cache (outside React, survives tab-switch
//      unmounts) — probe once per session; a mutation or an explicit
//      re-check forces a fresh probe.
//   2. localStorage persistence ACROSS launches: connected providers rarely
//      change between runs, so the first paint of a cold start already shows
//      the previous snapshot while ONE background probe refreshes it.

import { invoke } from "@tauri-apps/api/core";
import type { AccountsStatusLite } from "../agentic/ModelPicker";

export type { AccountsStatusLite };

/// The whole `accounts_status` payload (accounts.rs::AccountsStatus). The
/// backend always returns this; AccountsStatusLite is just the narrower view
/// the model picker needs. The cache holds the full object so AccountsPage
/// reads the SAME snapshot every other consumer sees — one probe, one truth.
export type AccountsStatusFull = AccountsStatusLite & {
  host_os: string;
  claude_cli_installed: boolean;
  codex_cli_installed: boolean;
  kimi_cli_installed: boolean;
  kimi_cli_reauth_required: boolean;
  gemini_cli_installed: boolean;
  grok_cli_installed: boolean;
};

const PERSIST_KEY = "owllm:accounts:v1";
/// Cadence of the shared live poll, used ONLY while AccountsPage is mounted.
/// Matches the 3s loop that page ran before this store existed.
const WATCH_MS = 3000;

function isStatus(s: unknown): s is AccountsStatusFull {
  return !!s && typeof s === "object" && typeof (s as AccountsStatusLite).claude_cli === "boolean";
}
function loadPersisted(): AccountsStatusFull | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (isStatus(p)) return p;
  } catch { /* corrupt/blocked — probe cold */ }
  return null;
}
function savePersisted(s: AccountsStatusFull): void {
  try { localStorage.setItem(PERSIST_KEY, JSON.stringify(s)); } catch { /* quota — non-fatal */ }
}

// Seeded from the previous launch: badges render instantly, marked stale so
// the first fetch this session still runs one real probe in the background.
let cached: AccountsStatusFull | null = loadPersisted();
let cacheIsStale = cached != null;
let loading = false;
let inflight: Promise<AccountsStatusFull | null> | null = null;
const listeners = new Set<() => void>();

// Ref-counted so two AccountsPage instances (or a remount mid-teardown) share
// one interval instead of racing to create and clear it.
let watchers = 0;
let watchTimer: number | null = null;

function emit() {
  for (const l of listeners) l();
}

export function subscribeAccounts(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getCachedAccounts(): AccountsStatusFull | null {
  return cached;
}

export function isAccountsLoading(): boolean {
  return loading;
}

function probe(): Promise<AccountsStatusFull | null> {
  if (inflight) return inflight;
  loading = true;
  emit();
  inflight = invoke<AccountsStatusFull>("accounts_status")
    .then((s) => { cached = s; cacheIsStale = false; savePersisted(s); return s; })
    .catch(() => cached) // keep last good value on transient failure
    .finally(() => { loading = false; inflight = null; emit(); });
  return inflight;
}

/// Return the cached provider status, fetching once if we've never probed (or
/// if `force` is set — the explicit re-check button, or a post-connect
/// re-validation). Concurrent callers share one in-flight probe. A snapshot
/// persisted from a previous launch is served IMMEDIATELY while one real probe
/// refreshes it in the background (subscribers re-render when it lands).
export function fetchAccounts(force = false): Promise<AccountsStatusFull | null> {
  if (!force && cached && !cacheIsStale) return Promise.resolve(cached);
  if (!force && cached && cacheIsStale) {
    void probe();
    return Promise.resolve(cached);
  }
  return probe();
}

/// Something that CHANGES provider state just happened — a key was saved or
/// removed, a CLI login terminal exited, an account was disconnected. Drop the
/// freshness flag and re-probe so every subscriber converges on the new truth.
/// This is the "re-validate only when something relevant actually changed"
/// path: without it the cache would be correct but stale after a connect.
export function invalidateAccounts(): Promise<AccountsStatusFull | null> {
  cacheIsStale = true;
  return fetchAccounts(true);
}

/// Start the shared live poll. ONLY AccountsPage calls this, because it is the
/// only screen where state can change without the app being told (the user
/// completes an OAuth flow in the embedded login terminal, or in a browser).
/// Returns the stop function; the interval exists only while at least one
/// caller holds it, so no polling survives leaving the page.
export function startAccountsWatch(): () => void {
  watchers++;
  if (watchTimer == null) {
    watchTimer = window.setInterval(() => { void fetchAccounts(true); }, WATCH_MS);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    watchers--;
    if (watchers <= 0 && watchTimer != null) {
      window.clearInterval(watchTimer);
      watchTimer = null;
      watchers = 0;
    }
  };
}
