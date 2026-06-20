// serverContext.ts — the user-chosen llama-server context window (-c tokens),
// shared by EVERY place that starts the local server (Server page load + the
// chat / code / agentic / bridge auto-starts) so the choice is honoured no
// matter how the model comes up. Persisted in localStorage.
//
// Why a chooser exists: llama-server's KV cache scales linearly with context;
// the model's full trained window (Qwen3 256K, Llama 3 128K) OOMs the GPU even
// when the weights fit (see server.rs). 8192 is the safe default that loads on
// most GPUs; a bigger card can push it higher — that's what this controls.
const KEY = "owllm:server:ctx";
export const SERVER_CTX_PRESETS = [4096, 8192, 16384, 32768, 65536, 131072];
const MIN = 512;
const MAX = 1_048_576;

/// The chosen context window, or `null` for "Auto" — let the backend pick a size
/// that fits the GPU (server.rs scales by detected VRAM). null is the default so
/// a big card gets a roomy window (agentic prompts overflow a fixed 8192) while
/// a small card stays conservative. Pass straight to server_start as `ctx`.
export function getServerCtx(): number | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null || raw === "auto") return null;
    const v = Number(raw);
    if (Number.isFinite(v) && v >= MIN && v <= MAX) return v;
  } catch { /* ignore */ }
  return null;
}

export function setServerCtx(n: number | null): void {
  try {
    localStorage.setItem(KEY, n == null ? "auto" : String(Math.max(MIN, Math.min(MAX, Math.round(n)))));
  } catch { /* ignore */ }
}

/// "8192" → "8K", "131072" → "128K"; leaves non-round values as-is.
export function fmtCtx(n: number): string {
  return n >= 1024 && n % 1024 === 0 ? `${n / 1024}K` : String(n);
}

/// Rough KV-cache VRAM estimate for a context size, GB. A LABELLED ballpark for
/// a ~30B model (chars/4-style heuristic, not exact): linear in context. Used
/// only to warn the user a big context costs VRAM on top of the weights.
export function approxKvGb(ctx: number): number {
  // ~0.2 GB per 1K tokens for a 30B-class GQA model in fp16 — order-of-magnitude.
  return (ctx / 1024) * 0.2;
}
