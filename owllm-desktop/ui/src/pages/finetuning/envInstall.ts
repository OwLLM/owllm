// Module-level (singleton) store for fine-tuning env installs.
//
// WHY THIS EXISTS: OWLLM pages unmount on tab switch. If the install's
// progress + the Tauri Channel live in a component's useState, navigating
// away tears them down — the streamed install is orphaned and the UI snaps
// back to an "Install" button (and a second click would start a DUPLICATE
// install). The actual env_profile_install task keeps running in Rust, but
// the front-end loses it.
//
// The fix: own the install state and the Channel HERE, at module scope, so
// they outlive any component. Components subscribe and re-render; when they
// remount they reconnect to the live install instead of resetting. Mirrors
// the "persist via runtime, not component useState" rule used elsewhere.

import { invoke, Channel } from "@tauri-apps/api/core";
import { InstallEvent } from "./envProfiles";

export type EnvInstallState = {
  installing: boolean;
  log: string[];
  error: string | null;
  /** Set once after a successful finish so the UI can refresh status. */
  finishedAt: number | null;
};

const EMPTY: EnvInstallState = { installing: false, log: [], error: null, finishedAt: null };

const states = new Map<string, EnvInstallState>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function subscribeEnvInstall(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getEnvInstallState(name: string): EnvInstallState {
  return states.get(name) ?? EMPTY;
}

export function isInstalling(name: string): boolean {
  return states.get(name)?.installing ?? false;
}

export function anyInstalling(): boolean {
  for (const s of states.values()) if (s.installing) return true;
  return false;
}

/// Start an install. Idempotent per profile — if one is already running for
/// `name`, this is a no-op (so a duplicate click or a remount can't launch a
/// second concurrent install). The Channel + invoke promise are held in this
/// module's closure, so they survive component unmount/navigation.
export function startEnvInstall(name: string): void {
  const cur = states.get(name);
  if (cur?.installing) return;

  states.set(name, { installing: true, log: [`Installing ${name}…`], error: null, finishedAt: null });
  emit();

  const push = (line: string) => {
    const s = states.get(name);
    if (!s) return;
    s.log = [...s.log, line].slice(-800);
    emit();
  };

  const channel = new Channel<InstallEvent>();
  channel.onmessage = (ev) => {
    if (ev.kind === "step") push(`▸ ${ev.label}`);
    else if (ev.kind === "log") push(ev.line);
    else if (ev.kind === "failed") {
      push(`✖ ${ev.error}`);
      const s = states.get(name);
      if (s) s.error = ev.error;
    } else if (ev.kind === "finished") {
      push("✓ done");
    }
  };

  // Held by this closure → not GC'd, not tied to any component.
  invoke<void>("env_profile_install", { name, channel })
    .then(() => {
      const s = states.get(name);
      if (s) { s.installing = false; s.finishedAt = Date.now(); }
      emit();
    })
    .catch((e) => {
      const s = states.get(name);
      if (s) { s.installing = false; s.error = String(e); }
      emit();
    });
}
