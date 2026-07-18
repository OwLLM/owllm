// Shared run stopwatch — the header timer used by BOTH the Agents page (team
// run) and the Code page (agent turn). One source of truth so the two surfaces
// tick, format, and freeze identically. h:mm:ss past an hour, else m:ss.
import { useEffect, useState } from "react";
import { readAppLanguage, translateUiText } from "../../localization";

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/// Human-readable local clock time (e.g. "11:50:37").
export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(readAppLanguage(), { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

/// Footer appended after a run answer: duration + start/finish wall-clock times.
export function runTimingFooter(startedAt: number, finishedAt: number = Date.now()): string {
  return translateUiText(`⏱ ${formatDuration(finishedAt - startedAt)} — started ${formatClock(startedAt)}, finished ${formatClock(finishedAt)}`);
}

/// Force a 1-s re-render while `active` so a running stopwatch ticks live; stops
/// the interval (no churn) once the clock freezes. Each timer ticks itself.
export function useTick(active: boolean): void {
  const [, force] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => force(x => (x + 1) % 1_000_000), 1000);
    return () => clearInterval(id);
  }, [active]);
}

/// The stopwatch pill (no positioning — the caller places it). Green + ⏱ while
/// the run is live, muted + ✓ once it stops. Renders nothing until a run starts.
export function RunTimerChip({
  runStartedAt, runEndedAt, active, title,
}: {
  runStartedAt?: number | null;
  runEndedAt?: number | null;
  /// True while the run is in flight — drives the live tick + green styling.
  active: boolean;
  title?: string;
}) {
  useTick(active);
  if (runStartedAt == null) return null;
  return (
    <div
      data-ui="RunTimer"
      title={title ?? (active ? "Running — elapsed time" : "How long the last run took")}
      style={{
        display: "flex", alignItems: "center", gap: 6, height: 24, padding: "0 12px",
        borderRadius: 999, fontSize: 13, fontWeight: 700, fontVariantNumeric: "tabular-nums",
        color: active ? "#5af09c" : "var(--fg-muted)",
        background: active ? "rgba(60,242,107,0.12)" : "rgba(255,255,255,0.05)",
        border: `1px solid ${active ? "rgba(60,242,107,0.45)" : "var(--border)"}`,
      }}
    >
      <span style={{ fontSize: 12 }}>{active ? "⏱" : "✓"}</span>
      {formatDuration((runEndedAt ?? Date.now()) - runStartedAt)}
    </div>
  );
}
