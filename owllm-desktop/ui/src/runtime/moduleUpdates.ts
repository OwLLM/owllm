// moduleUpdates.ts — "a newer build of an installed module is on the server",
// app-wide, plus the only way to REACH the Modules page after first run.
//
// Why this exists. `ModuleWizard` has always supported `mode="settings"`, and
// its own header even renders the title "Modules" for it — but nothing in the
// app ever mounted it that way. `useNeedsFirstRunWizard()` goes false the
// moment any module is installed, so after the first launch the page was
// unreachable. Every instruction that said "Home → Modules → reinstall Local
// Inference" (the local-inference crash hint among them) pointed at a route
// that did not exist, and a published engine update could not be installed by
// a user no matter how badly they wanted it.
//
// Two halves, mirroring runtime/updateAvailability.ts for the app updater:
//
//   openModulesPage()  — fires the event AppShell listens for to mount the
//                        wizard in settings mode.
//   this store         — carries "module X has version Y waiting" from the
//                        periodic check to the chrome badge, so an engine
//                        update announces itself instead of waiting to be
//                        stumbled upon.
//
// Module singleton (like updateAvailability/runActivity) because the checker
// and the chrome live in different subtrees and the fact outlives any page.

/// Window event that mounts the Modules page. AppShell listens for it.
import { notifyListeners } from "./listenerBus";

export const OPEN_MODULES_EVENT = "owllm:modules:open";

export type ModuleUpdate = {
  /// Module id, e.g. "local-inference".
  id: string;
  /// Human name for the badge tooltip, e.g. "Local Inference".
  displayName: string;
  /// Version currently installed, e.g. "b3850-cuda12.4".
  installedVersion: string;
  /// Version waiting on the server, e.g. "b10358-cuda12.4".
  availableVersion: string;
};

let state: ModuleUpdate[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  notifyListeners(listeners, "moduleUpdates");
}

export function getModuleUpdates(): ModuleUpdate[] {
  return state;
}

export function subscribeModuleUpdates(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/// Stable identity for a set of pending updates, so the repeating check can
/// re-report the same list every few hours without re-rendering the chrome.
function fingerprint(list: ModuleUpdate[]): string {
  return list.map((m) => `${m.id}@${m.availableVersion}`).sort().join("|");
}

/// Called by the periodic checker. Idempotent — same list in, no notify out.
export function setModuleUpdates(next: ModuleUpdate[]): void {
  if (fingerprint(next) === fingerprint(state)) return;
  state = next;
  notify();
}

/// Ask AppShell to open the Modules page.
export function openModulesPage(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_MODULES_EVENT));
}
