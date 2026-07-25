// genStats.ts — live token-rate meter shared by every local streaming loop.
//
// Each local SSE consumer (the agentic streamLocalChat in dispatch.ts, the
// fine-tuning ChatPage, …) creates ONE meter per actual response stream,
// calls tick() once per generated delta, then stop() when that stream ends.
// Explicit stream boundaries keep tool execution and next-turn prompt prefill
// out of the generation-time denominator. Active parallel streams are summed
// so they cannot overwrite one another in the global badge.

export type GenMeter = ((count?: number) => void) & { stop: () => void };

type ActiveMeter = {
  tokens: number;
  toksPerSec: number;
};

const activeMeters = new Map<number, ActiveMeter>();
let nextMeterId = 1;

function broadcastActiveMeters(): void {
  if (activeMeters.size === 0) return;
  let tokens = 0;
  let toksPerSec = 0;
  for (const meter of activeMeters.values()) {
    tokens += meter.tokens;
    toksPerSec += meter.toksPerSec;
  }
  if (toksPerSec <= 0) return;
  try {
    window.dispatchEvent(
      new CustomEvent("owllm:gen-stats", {
        detail: { toksPerSec, tokens, streams: activeMeters.size },
      }),
    );
  } catch {
    /* never break the turn over a telemetry event */
  }
}

/// Returns a callable `tick(count=1)` meter with an explicit stop() method.
/// Pass the number of tokens in the delta (we approximate 1 per SSE chunk,
/// which is what llama-server token streaming emits). Safe for a hot loop.
export function makeGenMeter(): GenMeter {
  const id = nextMeterId++;
  let n = 0;
  let t0 = 0;
  let last = 0;
  let stopped = false;
  const tick = ((count = 1) => {
    if (stopped) return;
    if (t0 === 0) t0 = Date.now();
    n += count;
    const current = activeMeters.get(id) ?? { tokens: 0, toksPerSec: 0 };
    current.tokens = n;
    activeMeters.set(id, current);
    const now = Date.now();
    if (now - last > 200) {
      last = now;
      const secs = (now - t0) / 1000;
      if (secs > 0.1) {
        current.toksPerSec = n / secs;
        broadcastActiveMeters();
      }
    }
  }) as GenMeter;
  tick.stop = () => {
    if (stopped) return;
    stopped = true;
    activeMeters.delete(id);
    // If other streams are still generating, remove this stream from the
    // aggregate immediately instead of leaving its last rate in the badge.
    broadcastActiveMeters();
  };
  return tick;
}
