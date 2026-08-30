// chatRuntime.ts — the chat stream store that lives ABOVE the router.
//
// Problem it solves: when the user navigates away from a chat page
// mid-generation, the page component unmounts, its AbortController +
// ReadableStream reader (held in refs) are dropped, and setState becomes
// a no-op — the in-flight LLM stream is orphaned and the rest of the
// tokens are lost. VS Code's Copilot chat doesn't have this problem
// because its runtime lives in the workbench, not the editor pane.
//
// This is that workbench: a module-level store, created once at the
// AppShell level (which does NOT remount on page change). Pages SUBSCRIBE
// to a session via useSyncExternalStore; the stream itself runs here and
// keeps mutating the session even with zero subscribers. When the page
// remounts, it re-subscribes and instantly re-paints the (still-growing)
// buffer.
//
// Two parallel maps per session:
//   - `snapshots`: the serialisable ChatStreamState React reads. ONE
//     cached object per id, replaced only on mutation (the cardinal
//     useSyncExternalStore rule — getSnapshot must return a stable ref).
//   - `live`: the non-serialisable handles (AbortController, reader,
//     persister, debounce timer). React never reads these, so they never
//     trigger renders and survive page unmount.

import { setRunActivity } from "./runActivity";
import { notifyListeners } from "./listenerBus";

export type ChatStreamStatus =
  | "idle"
  | "loading"      // cold-load / slot warmup
  | "streaming"
  | "tool"         // running a tool mid-loop
  | "error"
  | "aborted"
  | "done";

/// The React-visible snapshot. Generic over `payload` so ChatPage can
/// store ChatMsg[] and AgentsPage GoalMsg[] without the store knowing
/// their shapes. `version` bumps on every mutation — cheap identity for
/// getSnapshot consumers.
export type ChatStreamState = {
  id: string;
  status: ChatStreamStatus;
  payload: unknown;
  error: string | null;
  loadingBanner: { sec: number; reason: string } | null;
  version: number;
};

/// Non-React live handles. Module-scoped; outlive component unmount.
type LiveHandles = {
  abort: AbortController | null;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  busy: boolean;
  persister: ((payload: unknown) => void) | null;
  persistTimer: ReturnType<typeof setTimeout> | null;
};

/// What a page hands startStream: a runner that does the actual fetch +
/// SSE loop, driving the session through the supplied controls. The
/// runner gets the AbortSignal (already wired into the session's
/// AbortController) and a small control surface that writes back into
/// the store. It resolves when the stream is fully done.
export type StreamRunner = (ctrl: StreamRunnerControls) => Promise<void>;

export type StreamRunnerControls = {
  signal: AbortSignal;
  /// Register the live reader so stopStream can force-cancel it
  /// (WebView2 sometimes won't wake reader.read() from a signal-only
  /// abort). Safe to call multiple times (each turn opens a new reader).
  onReader: (reader: ReadableStreamDefaultReader<Uint8Array> | null) => void;
  /// Immutably replace the payload (messages). Schedules a debounced
  /// persist and notifies subscribers.
  mutate: (fn: (prev: unknown) => unknown) => void;
  /// Read the current payload (for runners that need to append).
  getPayload: () => unknown;
  setStatus: (status: ChatStreamStatus) => void;
  setError: (error: string | null) => void;
};

const PERSIST_DEBOUNCE_MS = 250;

export class ChatRuntimeStore {
  private snapshots = new Map<string, ChatStreamState>();
  private live = new Map<string, LiveHandles>();
  private listeners = new Map<string, Set<() => void>>();

  // ---- session lifecycle ----

  /// Create the session if absent. `initialPayload` seeds it (e.g. the
  /// persisted messages a page loads on mount). If the session already
  /// exists (stream kept running while the page was away), the existing
  /// snapshot is preserved and initialPayload is ignored.
  ensureSession(id: string, initialPayload: unknown = null): ChatStreamState {
    let snap = this.snapshots.get(id);
    if (!snap) {
      snap = { id, status: "idle", payload: initialPayload, error: null, loadingBanner: null, version: 0 };
      this.snapshots.set(id, snap);
    }
    if (!this.live.has(id)) {
      this.live.set(id, { abort: null, reader: null, busy: false, persister: null, persistTimer: null });
    }
    return snap;
  }

  /// Seed a session's payload only if the session is fresh (never had a
  /// stream and is still idle). Lets a page restore persisted messages on
  /// mount without clobbering an in-flight/finished buffer it left behind.
  hydrateIfIdle(id: string, payload: unknown): void {
    const snap = this.ensureSession(id, payload);
    const handles = this.live.get(id)!;
    if (snap.status === "idle" && !handles.busy && (snap.payload == null)) {
      this.replaceSnapshot(id, { payload });
    }
  }

  // ---- useSyncExternalStore wiring ----

  subscribe = (id: string, cb: () => void): (() => void) => {
    let set = this.listeners.get(id);
    if (!set) { set = new Set(); this.listeners.set(id, set); }
    set.add(cb);
    return () => {
      const s = this.listeners.get(id);
      if (s) { s.delete(cb); if (s.size === 0) this.listeners.delete(id); }
    };
  };

  /// MUST return a stable reference until the next mutation, or
  /// useSyncExternalStore loops. We return the cached snapshot object.
  getSnapshot = (id: string): ChatStreamState => {
    return this.snapshots.get(id) ?? this.ensureSession(id);
  };

  private notify(id: string): void {
    const set = this.listeners.get(id);
    if (set) notifyListeners(set, `chatRuntime:${id}`);
  }

  /// Replace the cached snapshot with a NEW object (so Object.is sees a
  /// change), bump version, schedule persist, notify.
  private replaceSnapshot(id: string, patch: Partial<ChatStreamState>): void {
    const cur = this.snapshots.get(id) ?? this.ensureSession(id);
    const next: ChatStreamState = { ...cur, ...patch, version: cur.version + 1 };
    this.snapshots.set(id, next);
    if ("payload" in patch) this.schedulePersist(id, next.payload);
    this.notify(id);
  }

  // ---- mutation surface ----

  appendUser(id: string, makePayload: (prev: unknown) => unknown): void {
    const cur = this.getSnapshot(id);
    this.replaceSnapshot(id, { payload: makePayload(cur.payload) });
  }

  /// Public payload mutation (for writes outside an active stream, e.g.
  /// seeding the user turn before startStream, or a clear). During a
  /// stream the runner uses controls.mutate instead.
  setPayload(id: string, fn: (prev: unknown) => unknown): void {
    this.replaceSnapshot(id, { payload: fn(this.getSnapshot(id).payload) });
  }

  /// Public error setter (for pre-stream failures like server start).
  setError(id: string, error: string | null): void {
    this.replaceSnapshot(id, { error });
  }

  setLoadingBanner(id: string, banner: { sec: number; reason: string } | null): void {
    this.replaceSnapshot(id, { loadingBanner: banner });
  }

  // ---- persistence ----

  /// Register the page's persister (SQLite update_project for agents,
  /// localStorage for chat). The store owns the debounce timer so a save
  /// fires even AFTER the page unmounts — closing the lost-tokens window.
  registerPersister(id: string, persister: ((payload: unknown) => void) | null): void {
    const handles = this.live.get(id) ?? (this.ensureSession(id), this.live.get(id)!);
    handles.persister = persister;
  }

  private schedulePersist(id: string, payload: unknown): void {
    const handles = this.live.get(id);
    if (!handles || !handles.persister) return;
    if (handles.persistTimer) clearTimeout(handles.persistTimer);
    const persister = handles.persister;
    handles.persistTimer = setTimeout(() => {
      handles.persistTimer = null;
      try { persister(payload); } catch (e) { console.warn("[chatRuntime] persist failed", id, e); }
    }, PERSIST_DEBOUNCE_MS);
  }

  /// Force a synchronous persist now (e.g. on stream completion).
  flushPersister(id: string): void {
    const handles = this.live.get(id);
    if (!handles) return;
    if (handles.persistTimer) { clearTimeout(handles.persistTimer); handles.persistTimer = null; }
    const snap = this.snapshots.get(id);
    if (handles.persister && snap) {
      try { handles.persister(snap.payload); } catch (e) { console.warn("[chatRuntime] flush failed", id, e); }
    }
  }

  // ---- streaming ----

  isBusy(id: string): boolean {
    return this.live.get(id)?.busy ?? false;
  }

  /// True when the in-flight stream's AbortController has been aborted
  /// (Stop pressed) but the runner hasn't unwound yet. Lets a runner's
  /// inner poll loops bail out promptly.
  isAborted(id: string): boolean {
    return this.live.get(id)?.abort?.signal.aborted ?? false;
  }

  /// Start a stream for `id`. No-op if one is already running for this
  /// session (single in-flight stream per session). The runner does the
  /// fetch + SSE loop via the controls; the store owns the lifecycle.
  async startStream(id: string, runner: StreamRunner): Promise<void> {
    this.ensureSession(id);
    const handles = this.live.get(id)!;
    if (handles.busy) { console.warn("[chatRuntime] startStream ignored — busy", id); return; }
    const abort = new AbortController();
    handles.abort = abort;
    handles.reader = null;
    handles.busy = true;
    // Header "running" aura: every streamed chat counts as run activity.
    setRunActivity(`stream:${id}`, true);
    this.replaceSnapshot(id, { status: "streaming", error: null });
    const controls: StreamRunnerControls = {
      signal: abort.signal,
      onReader: (reader) => { handles.reader = reader; },
      mutate: (fn) => this.replaceSnapshot(id, { payload: fn(this.getSnapshot(id).payload) }),
      getPayload: () => this.getSnapshot(id).payload,
      setStatus: (status) => this.replaceSnapshot(id, { status }),
      setError: (error) => this.replaceSnapshot(id, { error }),
    };
    try {
      await runner(controls);
      if (this.getSnapshot(id).status !== "error") this.replaceSnapshot(id, { status: "done" });
    } catch (e: any) {
      const aborted = e?.name === "AbortError";
      this.replaceSnapshot(id, {
        status: aborted ? "aborted" : "error",
        error: aborted ? null : String(e?.message ?? e),
      });
    } finally {
      handles.busy = false;
      setRunActivity(`stream:${id}`, false);
      handles.abort = null;
      handles.reader = null;
      this.setLoadingBanner(id, null);
      this.flushPersister(id);
    }
  }

  /// Stop the in-flight stream: abort the controller AND force-cancel the
  /// reader (belt + suspenders for WebView2).
  stopStream(id: string): void {
    const handles = this.live.get(id);
    if (!handles) return;
    try { handles.abort?.abort(); } catch { /* ignore */ }
    try { handles.reader?.cancel("stopStream"); } catch { /* ignore */ }
  }

  /// Stop every in-flight stream (e.g. global dispatch-abort event).
  stopAll(): void {
    for (const id of this.live.keys()) this.stopStream(id);
  }
}

// The one app-wide instance. Module singleton so it survives every page
// unmount (it's never re-created). The provider exposes it via context.
export const chatRuntime = new ChatRuntimeStore();
