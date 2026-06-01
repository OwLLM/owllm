// useChatSession — subscribe a component to one chat session's snapshot.
//
// useSyncExternalStore gives us tear-free reads that survive page
// unmount/remount: when a remounted page calls this, getSnapshot returns
// the session's CURRENT (still-accumulating) buffer synchronously on the
// first render, so the transcript instantly shows whatever streamed in
// while the page was away.

import { useSyncExternalStore } from "react";
import { useChatRuntime } from "./ChatRuntimeProvider";
import type { ChatStreamState } from "./chatRuntime";

export function useChatSession<T = unknown>(id: string): ChatStreamState & { payload: T } {
  const store = useChatRuntime();
  // ensureSession is idempotent; call it so the first getSnapshot has a
  // cached object to return (StrictMode-safe).
  store.ensureSession(id);
  const snap = useSyncExternalStore(
    (cb) => store.subscribe(id, cb),
    () => store.getSnapshot(id),
  );
  return snap as ChatStreamState & { payload: T };
}
