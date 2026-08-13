import { useEffect, useRef, useState } from "react";

/// Live generation-speed readout. Shows "⚡ N tok/s" while a LOCAL model
/// streams — driven by the `owllm:gen-stats` events every local SSE loop
/// broadcasts (agentic streamLocalChat AND the fine-tuning chat) — and clears
/// Retains llama-server's authoritative final timing until the local server
/// stops; live estimates still fade if a stream stalls. tok/s reflects the
/// user's own hardware, which is the meaningful number; cloud generation
/// (network-bound) isn't metered.
///   • variant "header"   — compact inline span in the header's live server
///     status line.
///   • variant "floating" — fixed pill bottom-right (legacy global badge).
export default function GenSpeedBadge({
  variant = "floating",
  active = true,
}: {
  variant?: "header" | "floating";
  active?: boolean;
}) {
  const [tps, setTps] = useState<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  useEffect(() => {
    const onStats = (e: Event) => {
      const d = (e as CustomEvent<{ toksPerSec: number; complete?: boolean }>).detail;
      if (!d || typeof d.toksPerSec !== "number" || !isFinite(d.toksPerSec)) return;
      setTps(d.toksPerSec);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      hideTimer.current = d.complete
        ? null
        : window.setTimeout(() => setTps(null), 1500);
    };
    window.addEventListener("owllm:gen-stats", onStats as EventListener);
    return () => {
      window.removeEventListener("owllm:gen-stats", onStats as EventListener);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, []);
  useEffect(() => {
    if (!active) setTps(null);
  }, [active]);
  if (tps == null) return null;
  const label = `⚡ ${tps >= 100 ? Math.round(tps) : tps.toFixed(1)} tok/s`;
  if (variant === "header") {
    return (
      <span
        data-ui="HeaderGenSpeed"
        title="Local generation speed (tokens per second)"
        style={{
          marginLeft: 8, color: "#7ff0c5", fontWeight: 800,
          fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
    );
  }
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
      {label}
    </div>
  );
}
