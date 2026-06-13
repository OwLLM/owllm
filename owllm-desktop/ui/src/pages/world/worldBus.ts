// worldBus — the 2.5D HQ's view of the EXISTING agentic event stream
// (P0-1 / Appendix A.4). The Agents page already emits these moments
// through its dispatch hooks (addActive/removeActive/appendThought/
// setPhase); this bus just broadcasts them as window CustomEvents so the
// HQ can animate. It is a TAP on the existing stream, never a second one.

export type WorldEvent =
  | { kind: "agent-start"; agent: string }
  | { kind: "agent-end"; agent: string }
  | { kind: "thought"; agent: string; text: string; role?: string }
  | { kind: "run-finish" };

const EVENT = "owllm:world:event";

export function worldEmit(e: WorldEvent): void {
  try {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: e }));
  } catch { /* world animation must never break a dispatch */ }
}

export function worldSubscribe(cb: (e: WorldEvent) => void): () => void {
  const handler = (ev: Event) => {
    const d = (ev as CustomEvent).detail as WorldEvent | undefined;
    if (d && typeof d.kind === "string") cb(d);
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
