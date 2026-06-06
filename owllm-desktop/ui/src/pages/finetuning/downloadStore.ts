// Module-level model-download store.
//
// WHY: download state used to live in ModelsPage component state, and the
// hf_download progress Channel closed over its setters. Navigating away from
// the Models page unmounted the component, so the progress bar vanished (and
// the channel updates hit a dead component) even though the Rust download kept
// running. Hoisting the state here — outside any component — makes the progress
// survive navigation; ModelsPage just subscribes via useSyncExternalStore and
// re-reads the in-flight progress whenever it remounts.
import { invoke, Channel } from "@tauri-apps/api/core";

export type DownloadProgress = {
  file: string;
  received: number;
  total: number | null;
  fileIndex: number;
  fileCount: number;
  done: boolean;
  error: string | null;
};

type DownloadEvent =
  | { kind: "started"; total: number | null }
  | { kind: "progress"; received: number; total: number | null }
  | { kind: "finished"; path: string; bytes: number }
  | { kind: "failed"; error: string };

let downloading: Set<string> = new Set();
let progress: Map<string, DownloadProgress> = new Map();
// Immutable snapshot; replaced on every commit so useSyncExternalStore sees a
// new reference and re-renders, but stays stable between commits.
let snapshot: { downloading: Set<string>; progress: Map<string, DownloadProgress> } = { downloading, progress };
const listeners = new Set<() => void>();

function commit() {
  snapshot = { downloading, progress };
  listeners.forEach((l) => l());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getSnapshot() {
  return snapshot;
}

export function isActive(modelId: string): boolean {
  return downloading.has(modelId);
}

/// Download one HF model (all `files`, or every file when empty). Idempotent
/// per model id — a second call while one is in flight is a no-op. Progress
/// streams into the store and survives page navigation.
export async function startDownload(modelId: string, files: string[]): Promise<void> {
  if (downloading.has(modelId)) return;
  downloading = new Set(downloading);
  downloading.add(modelId);
  commit();
  try {
    let toFetch = files;
    if (toFetch.length === 0) {
      const all = await invoke<Array<{ path: string }>>("hf_model_files", { modelId });
      toFetch = all.map((f) => f.path);
    }
    let failed: string | null = null;
    for (let i = 0; i < toFetch.length; i++) {
      const file = toFetch[i];
      const ch = new Channel<DownloadEvent>();
      ch.onmessage = (ev) => {
        const cur = progress.get(modelId);
        const base: DownloadProgress = cur ?? {
          file, received: 0, total: null, fileIndex: i, fileCount: toFetch.length, done: false, error: null,
        };
        const next = new Map(progress);
        if (ev.kind === "started") {
          next.set(modelId, { ...base, file, total: ev.total, received: 0, fileIndex: i, fileCount: toFetch.length, done: false, error: null });
        } else if (ev.kind === "progress") {
          next.set(modelId, { ...base, received: ev.received, total: ev.total });
        } else if (ev.kind === "finished") {
          next.set(modelId, { ...base, received: ev.bytes, total: ev.bytes, done: i + 1 >= toFetch.length });
        } else if (ev.kind === "failed") {
          next.set(modelId, { ...base, error: ev.error });
        }
        progress = next;
        commit();
      };
      try {
        // eslint-disable-next-line no-await-in-loop
        await invoke("hf_download", { modelId, file, branch: null, channel: ch });
      } catch (e) {
        failed = String(e);
        break;
      }
    }
    if (failed) throw new Error(failed);
    // Tell the rest of the app a new model landed so the pickers re-list.
    window.dispatchEvent(new CustomEvent("owllm:models:refresh"));
  } catch (e) {
    const cur = progress.get(modelId);
    const next = new Map(progress);
    next.set(modelId, {
      ...(cur ?? { file: "", received: 0, total: null, fileIndex: 0, fileCount: 1, done: false, error: null }),
      error: String(e),
    });
    progress = next;
    commit();
  } finally {
    downloading = new Set(downloading);
    downloading.delete(modelId);
    commit();
    // Clear the row after a beat so the user sees "Done"; keep errors visible.
    setTimeout(() => {
      const cur = progress.get(modelId);
      if (!cur || cur.error) return;
      const next = new Map(progress);
      next.delete(modelId);
      progress = next;
      commit();
    }, 4000);
  }
}
