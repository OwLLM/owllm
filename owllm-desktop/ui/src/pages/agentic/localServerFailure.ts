// Decide, from one server_status poll, whether a local-model start has
// already FAILED — and say why in the user's words.
//
// WHY THIS EXISTS (measured 2026-08-11, meta-models/Muse-Glimmer-30B-GGUF):
// llama-server exited after 1.0 s with
//   `llama_model_load: error loading model: unknown model architecture: 'muse-glimmer'`
// The Rust side already reaps the dead child and turns that stderr into a
// classified, actionable sentence (server.rs `classify_crash` + `fatal_line`).
// The UI's wait loop then ignored `message` entirely and kept polling a corpse
// for the full 180 s timeout, after which every caller printed the same
// content-free "Failed to start … check the Server tab and retry."
//
// The distinction the loop must make:
//   • child ALIVE, /health not up yet  → still loading, keep waiting
//   • child GONE                       → terminal, stop waiting, report why
// `running` is exactly "the llama-server child is alive" (server_status reaps
// it with try_wait before answering), so it is the whole test. We only ever
// call this AFTER server_start resolved, so "not running" cannot mean "not
// started yet".

export type ServerStatusLike = {
  running: boolean;
  model_id?: string | null;
  port?: number | null;
  message?: string | null;
};

/** Messages that carry no information — never show these as "the reason". */
function isEmptyReason(message: string): boolean {
  const m = message.trim().toLowerCase();
  return (
    m.length === 0 ||
    m === "not running." ||
    m === "not running" ||
    m === "stopped." ||
    m === "stopped"
  );
}

/**
 * Terminal-failure reason for `wanted`, or null when the start is still in
 * progress and the caller should keep waiting.
 *
 * Returning a string means STOP WAITING — the process is not coming back.
 */
export function startupFailureReason(
  status: ServerStatusLike,
  wanted: string,
): string | null {
  if (status.running) return null; // alive: loading, or already serving
  const message = (status.message ?? "").trim();
  if (isEmptyReason(message)) {
    return `The local model server for '${wanted}' is no longer running, and it did not report why. The Server tab has the full log.`;
  }
  return message;
}

/**
 * One user-facing line for a failed local-model start. `reason` is whatever
 * startupFailureReason (or the server_start rejection) produced; when we have
 * nothing, we say so rather than inventing a cause.
 */
export function localStartFailureText(
  modelId: string,
  reason: string | null | undefined,
): string {
  const r = (reason ?? "").trim();
  if (!r) {
    return `✗ Could not start local model '${modelId}'. The Server tab has the engine log.`;
  }
  return `✗ Could not start local model '${modelId}'. ${r}`;
}
