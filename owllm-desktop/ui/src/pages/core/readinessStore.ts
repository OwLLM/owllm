// Session-level cache for the Home page's readiness probe.
//
// WHY: app_readiness shells out to wsl.exe (with a cold-service retry
// sleep), nvidia-smi, and the env probe. Running it on every HomePage
// mount made navigating back to Home sluggish — especially right after a
// WSL install when the WSL service is cold and each wsl.exe call stalls.
//
// Two layers:
//   1. Module-scope session cache (outside React, survives tab-switch
//      unmounts) — probe once per session, Refresh forces a re-check.
//   2. localStorage persistence ACROSS launches: hardware/WSL state rarely
//      changes between runs, so the panel renders last launch's snapshot
//      instantly on a cold start while ONE background probe refreshes it.
//      This is what makes app start feel fast on machines where the WSL /
//      nvidia-smi probes take seconds.

import { invoke } from "@tauri-apps/api/core";

export type ReadinessRow = { ok: boolean; warn: boolean; detail: string };
export type AppReadiness = {
  wsl: ReadinessRow;
  gpu: ReadinessRow;
  env: ReadinessRow;
  runtime: ReadinessRow;
};

const PERSIST_KEY = "owllm:readiness:v1";

function isRow(r: unknown): r is ReadinessRow {
  return !!r && typeof r === "object" && typeof (r as ReadinessRow).ok === "boolean";
}
function loadPersisted(): AppReadiness | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (isRow(p?.wsl) && isRow(p?.gpu) && isRow(p?.env) && isRow(p?.runtime)) return p as AppReadiness;
  } catch { /* corrupt/blocked — probe cold */ }
  return null;
}
function savePersisted(r: AppReadiness): void {
  try { localStorage.setItem(PERSIST_KEY, JSON.stringify(r)); } catch { /* quota — non-fatal */ }
}

// Seeded from the previous launch: rows render instantly, marked stale so the
// first fetch this session still runs one real probe in the background.
let cached: AppReadiness | null = loadPersisted();
let cacheIsStale = cached != null;
let loading = false;
let inflight: Promise<AppReadiness | null> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function subscribeReadiness(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getCachedReadiness(): AppReadiness | null {
  return cached;
}

export function isReadinessLoading(): boolean {
  return loading;
}

function probe(): Promise<AppReadiness | null> {
  if (inflight) return inflight;
  loading = true;
  emit();
  inflight = invoke<AppReadiness>("app_readiness")
    .then((r) => { cached = r; cacheIsStale = false; savePersisted(r); return r; })
    .catch(() => cached) // keep last good value on transient failure
    .finally(() => { loading = false; inflight = null; emit(); });
  return inflight;
}

/// Return the cached readiness, fetching once if we've never probed (or if
/// `force` is set, e.g. the Refresh button / a post-setup re-check). Concurrent
/// callers share one in-flight probe. A snapshot persisted from a previous
/// launch is served IMMEDIATELY while one real probe refreshes it in the
/// background (subscribers re-render when it lands).
export function fetchReadiness(force = false): Promise<AppReadiness | null> {
  if (!force && cached && !cacheIsStale) return Promise.resolve(cached);
  if (!force && cached && cacheIsStale) {
    void probe();
    return Promise.resolve(cached);
  }
  return probe();
}
