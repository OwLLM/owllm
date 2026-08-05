export type NotebookDigestVisualState = "idle" | "active" | "completed" | "interrupted";

export const NOTEBOOK_DIGEST_AURA_STOPS = "#3cf26b, #ffd93c, #ff9a3c, #ff5c8a, #b07cff, #7fd4ff, #3cf26b";
export const NOTEBOOK_DIGEST_AURA_RING = `conic-gradient(from var(--owllm-aura-angle), ${NOTEBOOK_DIGEST_AURA_STOPS}) border-box`;
export const NOTEBOOK_DIGEST_AURA_FILL = "linear-gradient(var(--bg-card), var(--bg-card)) padding-box";
export const NOTEBOOK_DIGEST_AURA_BACKGROUND = `${NOTEBOOK_DIGEST_AURA_FILL}, ${NOTEBOOK_DIGEST_AURA_RING}`;
export const NOTEBOOK_DIGEST_AURA_HALO = "0 0 10px rgba(176,124,255,.20), 0 0 18px rgba(127,212,255,.12)";

export function notebookDigestVisualState(
  digestBusy: boolean,
  digestError: string,
  hasDigestReply: boolean,
): NotebookDigestVisualState {
  if (digestBusy) return "active";
  if (digestError.trim()) return "interrupted";
  if (hasDigestReply) return "completed";
  return "idle";
}

export function notebookDigestCardStyle(active: boolean, animation?: string): Record<string, string | undefined> {
  if (!active) {
    return {
      border: "1px solid var(--border)",
      background: "var(--bg-card)",
      boxShadow: undefined,
      animation: undefined,
    };
  }
  return {
    border: "1px solid transparent",
    background: NOTEBOOK_DIGEST_AURA_BACKGROUND,
    boxShadow: NOTEBOOK_DIGEST_AURA_HALO,
    animation,
  };
}
