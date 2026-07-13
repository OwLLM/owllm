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
  // resumedFrom > 0 when hf_download continues a .partial via HTTP Range —
  // the bar starts at the real offset instead of flashing 0%.
  | { kind: "started"; total: number | null; resumedFrom: number }
  | { kind: "progress"; received: number; total: number | null }
  | { kind: "finished"; path: string; bytes: number }
  | { kind: "failed"; error: string };

// One interrupted download found on disk (a `.partial` file left by
// hf_download). The partial IS the persisted download state — model id,
// file (quant), destination and bytes received — surviving app restarts.
export type InterruptedDownload = {
  modelId: string;
  file: string;
  bytesOnDisk: number;
};

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

// Auto-resume runs once per app session — remounting the Models page must
// not re-trigger the scan (in-flight downloads are already guarded by
// `downloading`, this just avoids pointless disk scans).
let resumeScanStarted = false;

/// AUTO-RESUME: scan the models tree for `.partial` files and continue each
/// one via hf_download's HTTP-Range resume — straight into the progress
/// banner, never back through the quantization picker. Returns what it
/// resumed so the caller can refresh lists. Safe to call on every mount.
export async function resumeInterrupted(): Promise<InterruptedDownload[]> {
  if (resumeScanStarted) return [];
  resumeScanStarted = true;
  let rows: InterruptedDownload[] = [];
  try {
    rows = await invoke<InterruptedDownload[]>("models_interrupted_downloads");
  } catch {
    return []; // scan failure = nothing to resume; manual paths still work
  }
  const byModel = new Map<string, InterruptedDownload[]>();
  for (const r of rows) {
    if (downloading.has(r.modelId)) continue; // already in flight this session
    const list = byModel.get(r.modelId) ?? [];
    list.push(r);
    byModel.set(r.modelId, list);
  }
  for (const [modelId, parts] of byModel) {
    // Seed the progress row at the on-disk offset so the banner shows the
    // real resumed position immediately, before HTTP even connects (the
    // Started event then fills in the total).
    const next = new Map(progress);
    next.set(modelId, {
      file: parts[0].file,
      received: parts[0].bytesOnDisk,
      total: null,
      fileIndex: 0,
      fileCount: parts.length,
      done: false,
      error: null,
    });
    progress = next;
    commit();
    void startDownload(modelId, parts.map((p) => p.file));
  }
  return [...byModel.values()].flat();
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
          next.set(modelId, { ...base, file, total: ev.total, received: ev.resumedFrom ?? 0, fileIndex: i, fileCount: toFetch.length, done: false, error: null });
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
