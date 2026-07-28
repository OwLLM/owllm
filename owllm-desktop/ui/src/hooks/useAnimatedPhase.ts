import { useEffect, useState } from "react";
import { continuousUiMotionEnabled } from "../runtime/renderingPolicy";

/**
 * Drives a monotonically-increasing animation phase (degrees, 36°/s) at ~30fps
 * for halo/arc pulses — but ONLY while `active` is true AND the document is
 * visible. When paused it cancels the rAF entirely (zero re-renders) and freezes
 * the phase; it resumes seamlessly when work returns or the window is shown.
 *
 * Why this exists: the agentic views (TeamCanvas / GraphCanvas / the card rail)
 * each ran an unconditional 30fps rAF that called setState forever — re-rendering
 * heavy SVG even when the team was idle AND even when the window was hidden. Left
 * open, that pegged a CPU core and (via per-render allocation) leaked memory at
 * hundreds of MB/min until the renderer froze. Gating the loop on real activity +
 * visibility means an idle or backgrounded page does no work at all.
 *
 * Pass `active` = "is there anything worth animating" (e.g. activeAgents.size > 0).
 */
export function useAnimatedPhase(active: boolean): number {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (!active || !continuousUiMotionEnabled()) return;
    let raf = 0;
    let lastEmit = 0;
    let running = false;
    const start = performance.now();
    const tick = (now: number) => {
      if (!running) return;
      if (now - lastEmit >= 33) {
        setPhase(((now - start) / 1000) * 36);
        lastEmit = now;
      }
      raf = requestAnimationFrame(tick);
    };
    const startLoop = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(tick);
    };
    const stopLoop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };
    const onVisibility = () => {
      if (document.hidden) stopLoop();
      else startLoop();
    };
    if (!document.hidden) startLoop();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopLoop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active]);
  return phase;
}
