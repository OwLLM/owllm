// updateAvailability.ts — "a newer version is on the server", app-wide.
//
// The updater used to be a one-shot modal: check once, 2.5s after launch, and
// interrupt with a dialog. That is both too loud (a modal in front of your work)
// and too quiet (leave the app running for a week and you are never told again,
// which is measurably why installs sit on old versions). This module splits the
// two concerns:
//
//   UpdateController  — finds the update (now on a repeating check) and owns the
//                       download/install modal, which is opened ON DEMAND.
//   this store        — carries "version X is available" to the chrome, so the
//                       announcement can be a friendly owl bubble and then a
//                       small persistent badge instead of a blocking dialog.
//
// Module singleton (like runActivity/chatRuntime) because both ends live in
// different subtrees and the fact outlives any page.

/// Window event the chrome (and the Info page badge) fire to bring the real
/// update modal up. UpdateController listens for it.
export const OPEN_UPDATE_EVENT = "owllm:update:open";

/// Set once per session, per version, when the owl has already said its line —
/// so a webview reload (vault-sync adoption) doesn't re-announce.
const ANNOUNCED_KEY = "owllm:update:announced";

export type UpdateAvailability = {
  /// The newer version on the server, or null when we are up to date.
  version: string | null;
};

let state: UpdateAvailability = { version: null };
const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of Array.from(listeners)) {
    try { cb(); } catch { /* a bad listener must never break the update check */ }
  }
}

export function getUpdateAvailability(): UpdateAvailability {
  return state;
}

export function subscribeUpdateAvailability(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/// Called by UpdateController when a check finds (or stops finding) a newer
/// version. Idempotent — the repeating check re-reports the same version every
/// few hours and must not re-render or re-announce anything.
export function setUpdateAvailable(version: string | null): void {
  const next = version && version.trim() ? version.trim() : null;
  if (next === state.version) return;
  state = { version: next };
  notify();
}

/// True when the owl has NOT yet said its line for this version in this
/// session. Reading it does not consume it — call markUpdateAnnounced() for
/// that — so a re-render can't skip the announcement.
export function shouldAnnounceUpdate(version: string): boolean {
  try {
    return sessionStorage.getItem(ANNOUNCED_KEY) !== version;
  } catch {
    // Storage blocked: announce. A duplicate greeting is better than silence,
    // which is the failure this whole module exists to fix.
    return true;
  }
}

export function markUpdateAnnounced(version: string): void {
  try { sessionStorage.setItem(ANNOUNCED_KEY, version); } catch { /* best effort */ }
}

/// Ask UpdateController to show the download/install modal.
export function requestUpdateInstall(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_UPDATE_EVENT));
}
