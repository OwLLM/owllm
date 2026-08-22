// listenerBus — the one safe way to fan a change out to registered watchers.
//
// WHY: every store in the app hand-rolled the same loop, and most wrote it the
// unsafe way:
//
//     for (const l of listeners) l();      // or listeners.forEach(l => l())
//
// Two real failures come out of that:
//  1. NO ERROR ISOLATION — one subscriber that throws aborts the whole loop, so
//     every listener registered after it silently never hears about the change
//     (and the emitting code path — a download progress tick, a stream delta —
//     unwinds with it). The symptom is "my component stopped updating", with no
//     error anywhere near the component that broke.
//  2. MUTATION DURING ITERATION — a listener that unsubscribes (or subscribes)
//     while the loop is running mutates the live Set mid-iteration. A listener
//     added during the pass gets called in that same pass (a duplicate
//     callback); a disposed one may still be called after its owner is gone.
//
// `notifyListeners` fixes all of it: iterate a SNAPSHOT (so mid-notify
// registration can't produce a duplicate call), re-check membership before each
// call (so a disposal during the same pass is honoured), and isolate each
// listener behind try/catch so a bad one can never starve the others. The
// throw is reported once, with the source, instead of vanishing.
//
// This is the pattern moduleUpdates.ts/pageSettings.ts already used correctly;
// it is now shared so no store can regress to the unsafe loop.
// Guarded by ui/src/runtime/listenerBus.verify.run.mjs (`npm run test:watchers`).

type Listener<A extends unknown[]> = (...args: A) => void;

/// Fan `args` out to every listener currently in `listeners`.
///
/// `label` names the store in the console when a listener throws — without it
/// a bad watcher is impossible to attribute.
export function notifyListeners<A extends unknown[]>(
  listeners: Set<Listener<A>>,
  label: string,
  ...args: A
): void {
  // Snapshot first: a listener that subscribes during this pass must wait for
  // the NEXT change, not get called twice for this one.
  for (const cb of Array.from(listeners)) {
    // Honour a disposal that happened earlier in this same pass.
    if (!listeners.has(cb)) continue;
    try {
      cb(...args);
    } catch (err) {
      // Never rethrow: one broken watcher must not stop the rest, and must not
      // unwind the emitter (a stream delta, a progress tick, a save).
      console.error(`[owllm] watcher for "${label}" threw; other watchers still notified`, err);
    }
  }
}
