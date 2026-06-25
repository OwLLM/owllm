// genStats.ts — live token-rate meter shared by every local streaming loop.
//
// Each local SSE consumer (the agentic streamLocalChat in dispatch.ts, the
// fine-tuning ChatPage, …) creates ONE meter per stream and calls tick()
// once per generated delta — visible reply, thinking, AND tool-call args all
// count, because they're all tokens the GPU produced (otherwise a thinking-
// or tool-heavy turn shows nothing and the badge looks broken). The meter
// throttles to ~5 emits/s and broadcasts an `owllm:gen-stats` CustomEvent so
// the header readout (GenSpeedBadge) can show "⚡ N tok/s".

/// Returns a `tick(count=1)` function. Pass the number of tokens in the
/// delta (we approximate 1 per SSE chunk, which is what llama-server token
/// streaming emits). Safe to call from a hot loop.
export function makeGenMeter(): (count?: number) => void {
  let n = 0;
  let t0 = 0;
  let last = 0;
  return (count = 1) => {
    if (t0 === 0) t0 = Date.now();
    n += count;
    const now = Date.now();
    if (now - last > 200) {
      last = now;
      const secs = (now - t0) / 1000;
      if (secs > 0.1) {
        try {
          window.dispatchEvent(
            new CustomEvent("owllm:gen-stats", { detail: { toksPerSec: n / secs, tokens: n } }),
          );
        } catch {
          /* never break the turn over a telemetry event */
        }
      }
    }
  };
}
