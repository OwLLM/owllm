// runActivity.ts — tiny app-wide "a run is in flight" signal.
//
// The rainbow "running" aura already lights active agent tiles/cards on the
// Agents page. The header bars (ModeBar + SubTabs) want the same treatment,
// but they live in AppShell, far away from every run loop. This module is the
// bridge: run owners flag their activity with a tag, AppShell subscribes to
// the aggregate. Tag-counted (a Set) because independent runs overlap —
// parallel dispatch lights several agents, a code run can overlap a chat
// stream — and the headers should stay lit until the LAST one finishes.
//
// Module singleton (like chatRuntime) so the signal survives page unmounts:
// dispatch loops keep calling in after AgentsPage navigates away, and the
// headers keep animating for the run that is still alive in the background.

const activeTags = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of Array.from(listeners)) {
    try { cb(); } catch { /* a bad listener must never break a run loop */ }
  }
}

/// Flag one run source on/off. Idempotent per tag — addActive-style callers
/// can re-flag the same agent without churning subscribers.
export function setRunActivity(tag: string, active: boolean): void {
  const had = activeTags.has(tag);
  if (active === had) return;
  if (active) activeTags.add(tag); else activeTags.delete(tag);
  notify();
}

/// Drop every tag under a prefix (e.g. "agents:" when a team run is cleared
/// wholesale) so a missed per-agent removal can't leave the headers spinning.
export function clearRunActivity(prefix: string): void {
  let changed = false;
  for (const tag of Array.from(activeTags)) {
    if (tag.startsWith(prefix)) { activeTags.delete(tag); changed = true; }
  }
  if (changed) notify();
}

/// True while ANY tagged run is in flight. Stable boolean — safe as a
/// useSyncExternalStore snapshot.
export function isRunActive(): boolean {
  return activeTags.size > 0;
}

export function subscribeRunActivity(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
