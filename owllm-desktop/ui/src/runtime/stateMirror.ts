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

// ---- Hot blobs: durable, but NEVER through localStorage --------------------
//
// Blink replicates EVERY localStorage mutation into EVERY renderer process
// hosting the same origin — including documents that never touch storage and
// register no `storage` listener. Measured with three same-origin pages in
// separate renderers while one wrote a 1.4 MB value 8x/s: the writer held
// 55 MB; the two passive pages that never called localStorage at all reached
// 944 MB and 903 MB. The cost is paid by the OTHER renderers, and a passive
// window (the overlay frame) runs no tasks, so nothing ever drains it.
//
// The Code page re-persists its whole conversation on a 250 ms debounce under
// two keys at ~1 MB each — ~8 MB/s of replicated traffic, which grew the idle
// overlay renderer to 4 GB in one session. These keys therefore live in SQLite
// ONLY: restoreStateMirror() hydrates them into the synchronous cache below
// before React renders (see main.tsx), and writes go straight to the DB.
//
// Rule for new code: anything large, or rewritten on a hot path, belongs here
// and not in localStorage. Enforced by hotBlobStorage.verify.run.mjs.
export const HOT_BLOB_PREFIXES = [
  "owllm:code:page:",
  "owllm:code:session:",
  // The Code page's chat threads (and their active-thread pointer) are written
  // by the same 250 ms persister and grow with use — the identical pattern.
  "owllm:code:chats",
  // The fine-tuning chat persists all three columns' full transcripts through
  // the SAME chatRuntime 250 ms persister. It was missed when the Code page was
  // moved here, which is how the hazard survived the first fix: the rule is per
  // WRITE PATTERN, not per page. Any chat that streams tokens belongs here.
  "owllm:chat:v3",
];

export function isHotBlobKey(key: string): boolean {
  return HOT_BLOB_PREFIXES.some((p) => key.startsWith(p));
}

// Per-key ceiling. Chromium caps a localStorage entry well below this; the
// guard only exists so a pathological value can't bloat the DB.
const MAX_VALUE_BYTES = 4 * 1024 * 1024;
const SWEEP_MS = 20_000;
const RESTORE_TIMEOUT_MS = 3_000;

type MirrorEntry = { key: string; value: string; pending_recovery?: boolean };

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
      // Hot blobs are owned by the cache below, not by localStorage. If one is
      // still present it is a pre-upgrade leftover being migrated out, and the
      // sweep must ignore it — otherwise its "missing from localStorage" state
      // would later read as a user deletion and drop the row.
      if (!key || !isDurableKey(key) || isHotBlobKey(key)) continue;
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

// ---- Hot blob cache -------------------------------------------------------
// Authoritative in-memory copy, hydrated from SQLite before the first render.
// Reads are synchronous so existing useState initializers keep working; writes
// are debounced to the DB. Nothing here ever reaches localStorage.
const hotBlobs = new Map<string, string>();
const hotDirty = new Set<string>();
const hotDeleted = new Set<string>();
// Pre-upgrade keys whose localStorage copy still exists. It is dropped only
// AFTER the DB has acknowledged the value — deleting it up front would destroy
// the user's history if the backend were down or slow to answer at boot.
const hotLegacy = new Set<string>();
let hotFlushTimer: ReturnType<typeof setTimeout> | null = null;
// Slower than the 250 ms UI debounce: these payloads are ~1 MB and durability
// is already covered by the final flush on hide/close.
const HOT_FLUSH_MS = 1_500;

export function readHotBlob(key: string): string | null {
  const cached = hotBlobs.get(key);
  if (cached !== undefined) return cached;
  // Pre-upgrade profiles (and non-Tauri contexts) may still hold the value.
  try { return localStorage.getItem(key); } catch { return null; }
}

export function writeHotBlob(key: string, value: string): void {
  if (value.length > MAX_VALUE_BYTES) {
    // Never drop a user's history silently — the old localStorage path failed
    // the same way on quota, and that is how "it stopped saving" goes unnoticed.
    console.warn(
      `[stateMirror] ${key} is ${Math.round(value.length / 1048576)} MB, over the ` +
      `${MAX_VALUE_BYTES / 1048576} MB ceiling — not persisted.`,
    );
    return;
  }
  if (hotBlobs.get(key) === value) return; // no-op writes must not churn the DB
  hotBlobs.set(key, value);
  hotDirty.add(key);
  hotDeleted.delete(key);
  scheduleHotFlush();
}

export function deleteHotBlob(key: string): void {
  hotBlobs.delete(key);
  hotDirty.delete(key);
  hotDeleted.add(key);
  try { localStorage.removeItem(key); } catch { /* legacy copy may be absent */ }
  scheduleHotFlush();
}

export function hotBlobKeys(): string[] {
  return [...hotBlobs.keys()];
}

/// localStorage-shaped read-only view, so callers that enumerate saved pages
/// (savedPageIdsForLocalProject) work unchanged.
export const hotBlobStorage = {
  get length(): number { return hotBlobs.size; },
  key(i: number): string | null { return hotBlobKeys()[i] ?? null; },
  getItem(k: string): string | null { return readHotBlob(k); },
};

function scheduleHotFlush(): void {
  if (hotFlushTimer !== null) return;
  hotFlushTimer = setTimeout(() => {
    hotFlushTimer = null;
    void flushHotBlobs();
  }, HOT_FLUSH_MS);
}

/// Push pending hot-blob changes to SQLite. Safe to call at any time.
export async function flushHotBlobs(): Promise<void> {
  if (!isTauriContext()) return;
  if (hotDirty.size === 0 && hotDeleted.size === 0) return;
  const sets: MirrorEntry[] = [];
  for (const key of hotDirty) {
    const value = hotBlobs.get(key);
    if (value !== undefined) sets.push({ key, value });
  }
  const deletes = [...hotDeleted];
  try {
    await invoke("state_mirror_save", { input: { sets, deletes } });
    for (const { key } of sets) hotDirty.delete(key);
    for (const key of deletes) hotDeleted.delete(key);
    // The DB now holds it, so the pre-upgrade localStorage copy is safe to drop.
    for (const key of [...hotLegacy]) {
      if (hotDirty.has(key)) continue; // a newer value is still unsaved
      try { localStorage.removeItem(key); } catch { /* already gone */ }
      hotLegacy.delete(key);
    }
  } catch {
    /* backend hiccup — the entries stay dirty and retry on the next flush */
  }
}

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
  const recoveryApplied: string[] = [];
  for (const { key, value, pending_recovery } of entries) {
    if (!isDurableKey(key)) continue; // stale prefix no longer mirrored
    if (isHotBlobKey(key)) {
      // Hydrate the synchronous cache instead of localStorage. A pre-upgrade
      // profile may still hold a newer copy (the sweep ran on a 20s cadence),
      // so the live localStorage value wins and is then migrated out.
      let legacy: string | null = null;
      try { legacy = localStorage.getItem(key); } catch { /* unavailable */ }
      hotBlobs.set(key, legacy ?? value);
      if (legacy !== null) {
        if (legacy === value) {
          // The DB already holds exactly this — dropping the copy loses nothing.
          try { localStorage.removeItem(key); } catch { /* best effort */ }
        } else {
          // Live profile is newer; keep its copy until the DB has accepted it.
          hotDirty.add(key);
          hotLegacy.add(key);
        }
      }
      continue;
    }
    try {
      if (pending_recovery || localStorage.getItem(key) === null) {
        localStorage.setItem(key, value);
        restored++;
        if (pending_recovery) recoveryApplied.push(key);
      }
    } catch {
      /* quota/unavailable — skip, never block boot */
    }
    lastMirrored.set(key, value);
  }
  // Adopt hot blobs the DB has never seen (written since the last 20s sweep, or
  // mirrored under an older build). The localStorage copy is kept until the DB
  // acknowledges it — see hotLegacy.
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !isHotBlobKey(key) || hotBlobs.has(key)) continue;
      const value = localStorage.getItem(key);
      if (value === null) continue;
      hotBlobs.set(key, value);
      hotDirty.add(key);
      hotLegacy.add(key);
    }
  } catch {
    /* storage unavailable — nothing to migrate */
  }
  if (hotDirty.size > 0) scheduleHotFlush();

  if (recoveryApplied.length > 0) {
    try {
      await invoke("state_mirror_ack_recovery", { keys: recoveryApplied });
    } catch {
      // Marker remains and the recovered value is retried next launch.
    }
  }
  return restored;
}

// Any localStorage value above this is a broadcast hazard: every write to it is
// replicated into every renderer hosting the origin, including passive windows
// that never drain. Warn by name so the next one is caught at the source rather
// than months later as "the app eats 9 GB".
const BROADCAST_HAZARD_BYTES = 256 * 1024;
const hazardWarned = new Set<string>();

function warnOversizedLocalStorage(live: Map<string, string>): void {
  for (const [key, value] of live) {
    if (value.length <= BROADCAST_HAZARD_BYTES || hazardWarned.has(key)) continue;
    hazardWarned.add(key);
    console.warn(
      `[stateMirror] ${key} is ${Math.round(value.length / 1024)} KB in localStorage. ` +
      "Every write is replicated into every same-origin renderer, including passive " +
      "windows that never release it. Move it to the hot-blob store (HOT_BLOB_PREFIXES).",
    );
  }
}

async function sweep(): Promise<void> {
  const live = readDurableSnapshot();
  warnOversizedLocalStorage(live);
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
      if (document.visibilityState === "hidden") { void sweep(); void flushHotBlobs(); }
    });
    window.addEventListener("beforeunload", () => { void sweep(); void flushHotBlobs(); });
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
  hotBlobs.clear();
  hotDirty.clear();
  hotDeleted.clear();
  hotLegacy.clear();
  if (hotFlushTimer !== null) {
    clearTimeout(hotFlushTimer);
    hotFlushTimer = null;
  }
}

// Test seam: run one sweep synchronously awaitable.
export function __sweepOnceForTests(): Promise<void> {
  return sweep();
}
