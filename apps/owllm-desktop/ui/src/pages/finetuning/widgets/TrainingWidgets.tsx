// Training widgets — React ports of LLM/desktop_app/training_widgets.py
// (MetricCard, RunModeSelector, CheckpointToggle, StatusPill, StartTrainingPanel).
// One file because the components only make sense as a set used by TrainPage.

import React from "react";

// ---------------------------------------------------------------------
// MetricCard — Qt training_widgets.py:16
// ---------------------------------------------------------------------
export type MetricCardProps = {
  title: string;
  icon: string;
  value: string;
  accent?: string;
};
export function MetricCard({ title, icon, value, accent = "#667eea" }: MetricCardProps) {
  return (
    <div
      data-ui="MetricCard"
      style={{
        background: "linear-gradient(180deg, #1e2336 0%, #161a2a 100%)",
        border: `1px solid ${accent}33`,
        borderRadius: 8,
        padding: "12px 14px",
        minWidth: 140,
        flex: 1,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 14, color: accent }}>{icon}</span>
        <span style={{ fontSize: 11, color: "#9aa0aa", textTransform: "uppercase", letterSpacing: 0.5 }}>{title}</span>
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: "#fafafa", lineHeight: 1.1 }}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------
// RunModeSelector — Qt training_widgets.py:192 (LoRA / Full / QLoRA pills)
// ---------------------------------------------------------------------
export type RunMode = "lora" | "full" | "qlora";
export type RunModeSelectorProps = {
  value: RunMode;
  onChange: (v: RunMode) => void;
};
export function RunModeSelector({ value, onChange }: RunModeSelectorProps) {
  const modes: { key: RunMode; label: string; accent: string; desc: string }[] = [
    { key: "lora",  label: "🪶 LoRA",  accent: "#667eea", desc: "Low-rank adapter — fast, small, 8–16 GB VRAM" },
    { key: "qlora", label: "⚡ QLoRA", accent: "#9C27B0", desc: "Quantized LoRA — 4-bit base, runs at 6 GB" },
    { key: "full",  label: "🏋 Full",  accent: "#FF9800", desc: "Full fine-tune — most VRAM, best results" },
  ];
  return (
    <div data-ui="RunModeSelector" style={{ display: "flex", gap: 8 }}>
      {modes.map((m) => {
        const active = value === m.key;
        return (
          <button
            key={m.key}
            onClick={() => onChange(m.key)}
            title={m.desc}
            style={{
              flex: 1,
              padding: "10px 14px",
              background: active ? `${m.accent}22` : "transparent",
              border: `1.5px solid ${active ? m.accent : "#2a3242"}`,
              borderRadius: 8,
              color: active ? "#fff" : "var(--fg-muted)",
              fontWeight: 700,
              fontSize: 13,
              cursor: "pointer",
              transition: "all 120ms ease",
              boxShadow: active ? `0 0 0 1px ${m.accent}44` : "none",
            }}
          >
            <div>{m.label}</div>
            <div style={{ fontSize: 10, marginTop: 4, fontWeight: 400, color: active ? "#d6d8de" : "#6b7280" }}>{m.desc}</div>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------
// CheckpointToggle — Qt training_widgets.py:280 (on/off + every N steps)
// ---------------------------------------------------------------------
export type CheckpointToggleProps = {
  enabled: boolean;
  everySteps: number;
  onEnabledChange: (v: boolean) => void;
  onStepsChange: (v: number) => void;
};
export function CheckpointToggle(p: CheckpointToggleProps) {
  return (
    <div data-ui="CheckpointToggle" style={{
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "8px 12px",
      background: "rgba(102,126,234,0.06)",
      border: "1px solid rgba(102,126,234,0.2)",
      borderRadius: 6,
    }}>
      <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
        <input type="checkbox" checked={p.enabled} onChange={(e) => p.onEnabledChange(e.target.checked)} />
        <span style={{ fontSize: 12, color: "var(--fg)" }}>💾 Save checkpoint</span>
      </label>
      <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>every</span>
      <input
        type="number"
        min={1}
        max={10000}
        value={p.everySteps}
        disabled={!p.enabled}
        onChange={(e) => p.onStepsChange(Number(e.target.value) || 1)}
        style={{
          width: 70,
          padding: "4px 6px",
          background: "#0b1020",
          border: "1px solid #1c2434",
          borderRadius: 4,
          color: "var(--fg)",
          fontSize: 12,
        }}
      />
      <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>steps</span>
    </div>
  );
}

// ---------------------------------------------------------------------
// StatusPill — Qt training_widgets.py:460 (pulsing dot + label)
// ---------------------------------------------------------------------
export type StatusKind = "idle" | "running" | "paused" | "error" | "done";
export type StatusPillProps = { status: StatusKind; detail?: string };
export function StatusPill({ status, detail }: StatusPillProps) {
  const styles: Record<StatusKind, { color: string; bg: string; label: string }> = {
    idle:    { color: "#9aa0aa", bg: "rgba(154,160,170,0.12)", label: "Idle" },
    running: { color: "#4CAF50", bg: "rgba(76,175,80,0.18)",   label: "Training" },
    paused:  { color: "#FF9800", bg: "rgba(255,152,0,0.18)",   label: "Paused" },
    error:   { color: "#f44336", bg: "rgba(244,67,54,0.18)",   label: "Error" },
    done:    { color: "#667eea", bg: "rgba(102,126,234,0.18)", label: "Complete" },
  };
  const s = styles[status];
  return (
    <div data-ui="StatusPill" style={{
      display: "inline-flex", alignItems: "center", gap: 8,
      padding: "6px 12px",
      background: s.bg,
      border: `1px solid ${s.color}44`,
      borderRadius: 999,
      color: s.color,
      fontSize: 12, fontWeight: 700,
    }}>
      <span
        style={{
          width: 8, height: 8, borderRadius: 4,
          background: s.color,
          animation: status === "running" ? "pulse 1.4s ease-in-out infinite" : "none",
        }}
      />
      {s.label}{detail ? ` · ${detail}` : ""}
      <style>{`@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }`}</style>
    </div>
  );
}

// ---------------------------------------------------------------------
// StartTrainingPanel — Qt training_widgets.py:703 (big primary Start tile)
// ---------------------------------------------------------------------
export type StartTrainingPanelProps = {
  status: StatusKind;
  canStart: boolean;
  onStart: () => void;
  onStop: () => void;
};
export function StartTrainingPanel({ status, canStart, onStart, onStop }: StartTrainingPanelProps) {
  const running = status === "running" || status === "paused";
  return (
    <div data-ui="StartTrainingPanel" style={{
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: 12,
      background: "linear-gradient(180deg, rgba(102,126,234,0.12) 0%, rgba(102,126,234,0.04) 100%)",
      border: "1px solid rgba(102,126,234,0.3)",
      borderRadius: 10,
    }}>
      <button
        onClick={running ? onStop : onStart}
        disabled={!running && !canStart}
        data-ui={running ? "train_stop" : "train_start"}
        style={{
          minWidth: 200,
          minHeight: 48,
          padding: "0 24px",
          background: running
            ? "linear-gradient(180deg, #f44336 0%, #c62828 100%)"
            : (canStart
                ? "linear-gradient(180deg, #4CAF50 0%, #2e7d32 100%)"
                : "rgba(150,150,150,0.1)"),
          color: running || canStart ? "#fff" : "#888",
          border: "none",
          borderRadius: 8,
          fontSize: 15,
          fontWeight: 700,
          cursor: running || canStart ? "pointer" : "not-allowed",
          boxShadow: running ? "0 0 18px -4px #f4433688" : canStart ? "0 0 18px -4px #4CAF5088" : "none",
          transition: "all 140ms ease",
        }}
      >
        {running ? "⏹ Stop training" : "▶ Start training"}
      </button>
      <StatusPill status={status} />
    </div>
  );
}
