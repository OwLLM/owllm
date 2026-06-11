// Session-level cache for the Home page's readiness probe.
//
// WHY: app_readiness shells out to wsl.exe (with a cold-service retry
// sleep), nvidia-smi, and the env probe. Running it on every HomePage
// mount made navigating back to Home sluggish — especially right after a
// WSL install when the WSL service is cold and each wsl.exe call stalls.
//
// The fix: probe ONCE per session and cache the result here, at module
// scope (outside React, so it survives the page unmount that happens on
// every tab switch). Pages read the cache instantly; a real re-check only
// happens when the user presses Refresh (force) or after a setup action.

import { invoke } from "@tauri-apps/api/core";

export type ReadinessRow = { ok: boolean; warn: boolean; detail: string };
export type AppReadiness = {
  wsl: ReadinessRow;
  gpu: ReadinessRow;
  env: ReadinessRow;
  runtime: ReadinessRow;
};

let cached: AppReadiness | null = null;
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

/// Return the cached readiness, fetching once if we've never probed (or if
/// `force` is set, e.g. the Refresh button / a post-setup re-check). Concurrent
/// callers share one in-flight probe.
export function fetchReadiness(force = false): Promise<AppReadiness | null> {
  if (!force && cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  loading = true;
  emit();
  inflight = invoke<AppReadiness>("app_readiness")
    .then((r) => { cached = r; return r; })
    .catch(() => cached) // keep last good value on transient failure
    .finally(() => { loading = false; inflight = null; emit(); });
  return inflight;
}
