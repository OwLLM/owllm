import { useEffect, useRef, useState } from "react";

/// Floating live generation-speed badge. Shows "⚡ N tok/s" while a LOCAL model
/// streams — driven by the `owllm:gen-stats` events that streamLocalChat()
/// broadcasts — and fades out ~1.5s after generation stops. Global: a single
/// instance mounted in AppShell covers every page (Chat, Code, Agents, Dataset
/// Builder, …). tok/s reflects the user's own hardware, which is the meaningful
/// number; cloud generation (network-bound) isn't metered here.
export default function GenSpeedBadge() {
  const [tps, setTps] = useState<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  useEffect(() => {
    const onStats = (e: Event) => {
      const d = (e as CustomEvent<{ toksPerSec: number }>).detail;
      if (!d || typeof d.toksPerSec !== "number" || !isFinite(d.toksPerSec)) return;
      setTps(d.toksPerSec);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => setTps(null), 1500);
    };
    window.addEventListener("owllm:gen-stats", onStats as EventListener);
    return () => {
      window.removeEventListener("owllm:gen-stats", onStats as EventListener);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, []);
  if (tps == null) return null;
  return (
    <div
      title="Local generation speed (tokens per second)"
      style={{
        position: "fixed", bottom: 14, right: 16, zIndex: 9999,
        display: "flex", alignItems: "center", gap: 6,
        padding: "5px 11px", borderRadius: 999,
        background: "rgba(20,24,33,0.92)", border: "1px solid rgba(127,240,197,0.45)",
        color: "#7ff0c5", fontSize: 12, fontWeight: 800,
        fontFamily: "Consolas, 'JetBrains Mono', monospace",
        boxShadow: "0 4px 14px rgba(0,0,0,0.35)", pointerEvents: "none",
        backdropFilter: "blur(4px)",
      }}
    >
      ⚡ {tps >= 100 ? Math.round(tps) : tps.toFixed(1)} tok/s
    </div>
  );
}
