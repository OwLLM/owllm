// State mirror (front-end half) — keeps a SQLite copy of the durable
// localStorage keys so a WebView profile change can never erase history.
//
// Why this exists: Agents-page chats survived every incident of 2026-07-18/19
// because they live in owllm_state.db; the Coding pages, notebook blobs and
// fine-tuning chat state vanished from the UI on every profile hop because
// they lived ONLY in the profile's Local Storage. This module gives those
// keys the same durability without rewriting their (hot, synchronous)
// localStorage read paths:
//
//   restore — at boot, BEFORE React renders, any mirrored key that is
//             MISSING from localStorage is written back. A key that exists
//             is never overwritten: the live profile stays the source of
//             truth; the mirror is disaster recovery, not sync.
//   mirror  — on a slow cadence (and on tab-hide/close) changed keys are
//             upserted to the DB and keys the user deleted are dropped.
//
// Deletion vs wipe: if localStorage still holds at least one durable key,
// a mirrored key that disappeared was deleted by the user → drop its row.
// If ALL durable keys are gone at once mid-session (a wiped/foreign
// profile), nothing is dropped — the next boot restores everything.

import { invoke } from "@tauri-apps/api/core";

// User-owned local state. This deliberately covers every `owllm:` key rather
// than a hand-picked subset: the narrow first version preserved Code chats and
// notebooks but still abandoned the page catalog, project bindings, model
// choices, brainstorm checkpoints, theme and other settings whenever WebView
// moved profiles. localStorage itself is quota-bounded and the per-key ceiling
// below still applies, so mirroring the namespace cannot grow without bound.
export const DURABLE_PREFIXES = [
  "owllm:",
];

// Per-key ceiling. Chromium caps a localStorage entry well below this; the
// guard only exists so a pathological value can't bloat the DB.
const MAX_VALUE_BYTES = 4 * 1024 * 1024;
const SWEEP_MS = 20_000;
const RESTORE_TIMEOUT_MS = 3_000;

type MirrorEntry = { key: string; value: string };

function isTauriContext(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as any;
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__ || w.__TAURI_METADATA__);
}

export function isDurableKey(key: string): boolean {
  return DURABLE_PREFIXES.some((p) => key.startsWith(p));
}

function readDurableSnapshot(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !isDurableKey(key)) continue;
      const value = localStorage.getItem(key);
      if (value !== null && value.length <= MAX_VALUE_BYTES) out.set(key, value);
    }
  } catch {
    /* storage unavailable — mirror stays idle */
  }
  return out;
}

// What the mirror held after the last restore/sweep. Lets the sweep send
// only deltas and distinguish "user deleted a key" from "never mirrored".
let lastMirrored = new Map<string, string>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/// Boot-time restore. Resolves fast and NEVER throws/hangs: a dead backend
/// falls through after a short timeout so app startup cannot be blocked.
export async function restoreStateMirror(): Promise<number> {
  if (!isTauriContext()) return 0;
  let entries: MirrorEntry[];
  try {
    entries = await Promise.race([
      invoke<MirrorEntry[]>("state_mirror_load"),
      new Promise<MirrorEntry[]>((resolve) =>
        setTimeout(() => resolve([]), RESTORE_TIMEOUT_MS),
      ),
    ]);
  } catch {
    entries = [];
  }
  let restored = 0;
  for (const { key, value } of entries) {
    if (!isDurableKey(key)) continue; // stale prefix no longer mirrored
    try {
      if (localStorage.getItem(key) === null) {
        localStorage.setItem(key, value);
        restored++;
      }
    } catch {
      /* quota/unavailable — skip, never block boot */
    }
    lastMirrored.set(key, value);
  }
  return restored;
}

async function sweep(): Promise<void> {
  const live = readDurableSnapshot();
  const sets: MirrorEntry[] = [];
  const deletes: string[] = [];
  for (const [key, value] of live) {
    if (lastMirrored.get(key) !== value) sets.push({ key, value });
  }
  if (live.size > 0) {
    // Storage is alive → missing mirrored keys are real user deletions.
    for (const key of lastMirrored.keys()) {
      if (!live.has(key)) deletes.push(key);
    }
  }
  if (sets.length === 0 && deletes.length === 0) return;
  try {
    await invoke("state_mirror_save", { input: { sets, deletes } });
    for (const { key, value } of sets) lastMirrored.set(key, value);
    for (const key of deletes) lastMirrored.delete(key);
  } catch {
    /* backend hiccup — deltas stay pending for the next sweep */
  }
}

/// Start the background mirror. Call once, after restoreStateMirror().
export function startStateMirror(): void {
  if (!isTauriContext() || sweepTimer !== null) return;
  sweepTimer = setInterval(() => void sweep(), SWEEP_MS);
  // Flush on hide/close so the last edits of a session aren't lost to the
  // 20s cadence. beforeunload can't await; the invoke is fire-and-forget
  // and usually completes because the Rust side outlives the webview.
  try {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void sweep();
    });
    window.addEventListener("beforeunload", () => void sweep());
  } catch {
    /* non-DOM context */
  }
}

// Test seam: reset module state between harness cases.
export function __resetStateMirrorForTests(): void {
  lastMirrored = new Map();
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

// Test seam: run one sweep synchronously awaitable.
export function __sweepOnceForTests(): Promise<void> {
  return sweep();
}
