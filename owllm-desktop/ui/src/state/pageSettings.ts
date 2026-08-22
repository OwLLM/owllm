// pageSettings.ts — the saved-project/page settings layer.
//
// WHY THIS EXISTS
// ---------------
// Model picks and other per-page/per-project preferences used to be scattered
// across a dozen bespoke localStorage keys and blobs, each page rolling its own
// read/write. That made cross-PC sync impossible to reason about: the Code page
// buries its chosen model INSIDE the same blob as the machine-specific
// workspace path (owllm:code:*), and vaultSync DENIES that whole prefix — so a
// model choice could never follow the user to another machine. There was also
// no stable, device-independent identifier to hang a setting on.
//
// This module is the single home for those preferences:
//   • ONE synced document — localStorage key `owllm:settings:v1`. It carries the
//     `owllm:` prefix so runtime/vaultSync.ts already mirrors it to the user's
//     vault (last-write-wins per device), and it is NOT under the denied
//     `owllm:code:` prefix, so — unlike the Code page blob — settings stored
//     here DO sync. Keep this document free of machine-specific data (paths,
//     ports, device ids); those belong in their own device-local keys.
//   • STABLE scope identifiers (`scope.*`) that are device-independent (a
//     project's DB uuid, a page id, "global") rather than a filesystem path.
//   • A small local read/write API (get/set/delete/subscribe + a `useSetting`
//     React hook). Callers talk to this API, never to localStorage directly.
//
// FUTURE REMOTE SYNC WITHOUT TOUCHING PAGES
// -----------------------------------------
// The storage is reached only through `backend` (a SettingsBackend). Today that
// is localStorage (and thus vaultSync's git vault). A future dedicated remote
// store swaps in via `setSettingsBackend()` — pages that call getSetting/
// setSetting/useSetting never change. That is the whole point of this layer.

import { useEffect, useState } from "react";
import { hotBlobKeys, readHotBlob } from "../runtime/stateMirror";
import { notifyListeners } from "../runtime/listenerBus";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

export type SettingsDoc = {
  v: 1;
  /** scopeId -> { settingKey -> value } */
  scopes: Record<string, Record<string, JsonValue>>;
  /** one-shot migration markers, keyed by migration name */
  mig: Record<string, number>;
};

/** The single localStorage document. `owllm:`-prefixed ⇒ vaultSync mirrors it;
 *  not under `owllm:code:` ⇒ it is NOT excluded from sync. */
export const SETTINGS_STORAGE_KEY = "owllm:settings:v1";

/** Fired (window CustomEvent) after any write, so cross-store listeners and the
 *  vaultSync diff-poll notice the change promptly. */
export const SETTINGS_CHANGED_EVENT = "owllm:page-settings";

// ---- Stable scope identifiers ---------------------------------------------
// Device-INDEPENDENT ids only. `project` takes the agent_projects DB uuid (it
// already syncs cross-device via vault_sync_projects); `page` a page id; and
// `global` for app-wide, non-project prefs. Never encode a filesystem path here.
export const scope = {
  global: (): string => "global",
  project: (projectId: string): string => `project:${projectId}`,
  page: (pageId: string): string => `page:${pageId}`,
  agent: (projectId: string, agent: string): string => `agent:${projectId}:${agent}`,
  chatColumn: (columnId: string): string => `chatcol:${columnId}`,
} as const;

/** Well-known setting keys, so call sites don't drift on spelling. */
export const SettingKey = {
  model: "model",
  secondaryModel: "secondaryModel",
  watcherModel: "watcherModel",
} as const;

// ---- Backend seam ----------------------------------------------------------
export interface SettingsBackend {
  read(): SettingsDoc;
  write(doc: SettingsDoc): void;
}

function emptyDoc(): SettingsDoc {
  return { v: 1, scopes: {}, mig: {} };
}

function normalize(raw: unknown): SettingsDoc {
  if (!raw || typeof raw !== "object") return emptyDoc();
  const d = raw as Partial<SettingsDoc>;
  return {
    v: 1,
    scopes: d.scopes && typeof d.scopes === "object" ? (d.scopes as SettingsDoc["scopes"]) : {},
    mig: d.mig && typeof d.mig === "object" ? (d.mig as SettingsDoc["mig"]) : {},
  };
}

/** Default backend: the synced localStorage document. */
const localStorageBackend: SettingsBackend = {
  read(): SettingsDoc {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) return emptyDoc();
      return normalize(JSON.parse(raw));
    } catch {
      return emptyDoc();
    }
  },
  write(doc: SettingsDoc): void {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(doc));
    } catch {
      /* quota / private mode — non-fatal */
    }
  },
};

let backend: SettingsBackend = localStorageBackend;

/** Swap the storage backend (e.g. a future dedicated remote store). Pages that
 *  use get/set/useSetting need NO change when this is called. */
export function setSettingsBackend(b: SettingsBackend): void {
  backend = b;
  emit();
}

// ---- Change notification ---------------------------------------------------
const listeners = new Set<() => void>();

function emit(): void {
  notifyListeners(listeners, "pageSettings");
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT));
    }
  } catch { /* non-browser */ }
}

/** Subscribe to any settings change. Returns an unsubscribe fn. */
export function subscribeSettings(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

// Cross-tab: another tab writing the document fires a `storage` event. Same-tab
// writes are covered by emit() directly.
if (typeof window !== "undefined") {
  try {
    window.addEventListener("storage", (e: StorageEvent) => {
      if (e.key === SETTINGS_STORAGE_KEY) {
        notifyListeners(listeners, "pageSettings");
      }
    });
  } catch { /* non-browser */ }
}

// ---- Local read/write API --------------------------------------------------
/** Read one setting. Returns `fallback` (default undefined) when unset. */
export function getSetting<T extends JsonValue>(
  scopeId: string,
  key: string,
  fallback?: T,
): T | undefined {
  const doc = backend.read();
  const bag = doc.scopes[scopeId];
  if (bag && Object.prototype.hasOwnProperty.call(bag, key)) {
    return bag[key] as T;
  }
  return fallback;
}

/** Every setting under a scope (empty object when the scope is unset). */
export function getScopeSettings(scopeId: string): Record<string, JsonValue> {
  const doc = backend.read();
  return { ...(doc.scopes[scopeId] ?? {}) };
}

/** Write one setting. `null`/`undefined`/"" delete the key so an unset value is
 *  never persisted as a meaningless empty entry (keeps the doc — and the
 *  neutral "no saved model" state — clean). */
export function setSetting(scopeId: string, key: string, value: JsonValue | undefined): void {
  const doc = backend.read();
  const bag = doc.scopes[scopeId] ?? (doc.scopes[scopeId] = {});
  const prev = Object.prototype.hasOwnProperty.call(bag, key) ? bag[key] : undefined;
  if (value === undefined || value === null || value === "") {
    if (prev === undefined) return; // nothing to clear
    delete bag[key];
    if (Object.keys(bag).length === 0) delete doc.scopes[scopeId];
  } else {
    if (prev === value) return; // no-op write ⇒ no churn, no sync ping
    bag[key] = value;
  }
  backend.write(doc);
  emit();
}

/** Delete one setting (equivalent to setSetting(..., undefined)). */
export function deleteSetting(scopeId: string, key: string): void {
  setSetting(scopeId, key, undefined);
}

// ---- React hook ------------------------------------------------------------
/** `const [model, setModel] = useSetting(scope.page(id), SettingKey.model, "")`.
 *  Re-renders when the value changes here OR in another tab/device (sync). */
export function useSetting<T extends JsonValue>(
  scopeId: string,
  key: string,
  fallback: T,
): [T, (v: T | undefined) => void] {
  const [value, setValue] = useState<T>(() => getSetting<T>(scopeId, key, fallback) as T);
  useEffect(() => {
    const sync = () => setValue(getSetting<T>(scopeId, key, fallback) as T);
    sync(); // scope/key may have changed since mount
    return subscribeSettings(sync);
    // fallback intentionally excluded — a new object identity each render would
    // loop; the initial value already captured it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeId, key]);
  const set = (v: T | undefined) => setSetting(scopeId, key, v);
  return [value, set];
}

// ---- Migration -------------------------------------------------------------
// Lift the model-selection prefs that predate this layer INTO the synced
// document, keyed by stable scope ids. Idempotent (guarded per-migration in
// doc.mig) and NON-DESTRUCTIVE: legacy keys are left in place so nothing that
// still reads them breaks; this only ADDS the sync-ready copy. Safe to call on
// every launch.
function lsKeys(): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) out.push(k);
    }
  } catch { /* private mode */ }
  return out;
}
function lsGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function migratePageSettings(): void {
  const doc = backend.read();
  let changed = false;

  // 1) Watcher model (global) — was owllm:watcher:model.
  if (!doc.mig.watcherModel) {
    const v = lsGet("owllm:watcher:model");
    if (v) {
      (doc.scopes[scope.global()] ??= {})[SettingKey.watcherModel] = v;
    }
    doc.mig.watcherModel = 1;
    changed = true;
  }

  // 2) Code page model — lift out of the DENIED owllm:code:page:<id> blobs so
  //    the model choice can sync even though the workspace path (same blob)
  //    stays device-local.
  if (!doc.mig.codeModel) {
    const PREFIX = "owllm:code:page:";
    // These blobs live in the hot-blob store (SQLite), not localStorage — see
    // HOT_BLOB_PREFIXES. A pre-upgrade profile may still hold them inline, so
    // both sources are scanned. Runs after restoreStateMirror() hydrates them.
    for (const k of [...lsKeys(), ...hotBlobKeys()]) {
      if (!k.startsWith(PREFIX)) continue;
      const pageId = k.slice(PREFIX.length);
      const raw = lsGet(k) ?? readHotBlob(k);
      if (!raw) continue;
      try {
        const blob = JSON.parse(raw) as { modelId?: string; secondaryModelId?: string };
        const bag = (doc.scopes[scope.page(pageId)] ??= {});
        if (blob.modelId) bag[SettingKey.model] = blob.modelId;
        if (blob.secondaryModelId) bag[SettingKey.secondaryModel] = blob.secondaryModelId;
        if (Object.keys(bag).length === 0) delete doc.scopes[scope.page(pageId)];
      } catch { /* corrupt blob — skip */ }
    }
    doc.mig.codeModel = 1;
    changed = true;
  }

  if (changed) {
    backend.write(doc);
    emit();
  }
}
