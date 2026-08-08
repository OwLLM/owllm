// The ONE notification surface — exactly like ChatBubble for messages, LogBox
// for logs and Composer for inputs.
//
// Transient user-facing messages ("workspace ready on branch X", "couldn't
// load models", mic/attachment failures) belong HERE and nowhere else. They
// must NEVER be rendered inside a chat composer: the composer container is the
// input box, and prose in its header wraps to several lines, grows the box and
// pushes the model picker off screen. That is why <Composer/> has no status or
// notice slot at all — the constraint is structural, and pinned by
// composerNoNotifications.verify.run.mjs.
//
// Usage: call `notify("…")` from anywhere; <ToastHost/> is mounted once at the
// app root and renders the stack.
import React, { useEffect, useRef, useState } from "react";

export type ToastKind = "info" | "error";
export type Toast = { id: number; kind: ToastKind; text: string };

/** Longest a toast stays up. Errors linger — they are the ones worth reading. */
const DISMISS_MS: Record<ToastKind, number> = { info: 6000, error: 12000 };
/** Older toasts drop off the bottom rather than filling the window. */
const MAX_VISIBLE = 4;

type Listener = (toasts: Toast[]) => void;
const listeners = new Set<Listener>();
let toasts: Toast[] = [];
let nextId = 1;

function publish() {
  const snapshot = toasts;
  listeners.forEach((fn) => fn(snapshot));
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  publish();
}

/**
 * Show a notification. Blank text is a no-op (pages clear their old status by
 * passing ""), and an identical message already on screen is not duplicated.
 */
export function notify(text: string, kind: ToastKind = "info"): void {
  const body = (text ?? "").trim();
  if (!body) return;
  if (toasts.some((t) => t.text === body)) return;
  const toast: Toast = { id: nextId++, kind, text: body };
  toasts = [...toasts, toast].slice(-MAX_VISIBLE);
  publish();
}

/** Test/inspection hook — the live stack, without subscribing. */
export function currentToasts(): Toast[] {
  return toasts;
}

export function ToastHost() {
  const [items, setItems] = useState<Toast[]>(toasts);
  const timers = useRef(new Map<number, number>());

  useEffect(() => {
    const fn: Listener = (next) => setItems(next);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);

  // One expiry timer per toast, armed when it first appears and cleared when it
  // leaves (by expiry or by the user clicking it).
  useEffect(() => {
    const live = new Set(items.map((t) => t.id));
    timers.current.forEach((handle, id) => {
      if (!live.has(id)) { window.clearTimeout(handle); timers.current.delete(id); }
    });
    items.forEach((t) => {
      if (timers.current.has(t.id)) return;
      timers.current.set(t.id, window.setTimeout(() => dismissToast(t.id), DISMISS_MS[t.kind]));
    });
  }, [items]);

  useEffect(() => () => {
    timers.current.forEach((handle) => window.clearTimeout(handle));
    timers.current.clear();
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="owl-toasts" data-ui="ToastHost">
      {items.map((t) => (
        <button
          key={t.id}
          type="button"
          data-ui="Toast"
          className={`owl-toast owl-toast--${t.kind}`}
          title="Dismiss"
          role={t.kind === "error" ? "alert" : "status"}
          onClick={() => dismissToast(t.id)}
        >
          {t.text}
        </button>
      ))}
    </div>
  );
}

export default ToastHost;
