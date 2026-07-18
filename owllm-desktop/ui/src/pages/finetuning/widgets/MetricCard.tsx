// MetricCard — direct port of training_widgets.py:16-99
// (LLM/desktop_app/training_widgets.py class MetricCard).
//
// Qt mapping:
//   QFrame.Box                                  → <div data-ui="MetricCard">
//   self.setMinimumHeight(160)                  → minHeight: 160
//   QVBoxLayout(margins 15/12/15/12, spacing 8) → outer flex column
//   title_layout: icon (14pt) + title (11pt bold) → header row
//   value_label (26pt bold, Qt.AlignCenter)     → centered value
//   addStretch(1) above + below value            → flex spacers
//
// Qt stylesheet (dark theme — the only theme this React app ships):
//   MetricCard {
//     background: qlineargradient(0,0,0,1 stop:0 #1e2936 stop:1 #16213e);
//     border: 1px solid #3a4a5a;
//     border-radius: 8px;
//   }
//   QLabel { background: transparent; color: #fafafa; border: none; }
//
// API parity:
//   MetricCard(title, icon, value="--").set_value(value)
//   → <MetricCard title icon value /> (parent re-renders to update)

import React from "react";

export type MetricCardProps = {
  /// "Loss", "Learning rate", "Step", etc.
  title: string;
  /// Emoji prefix shown left of the title at 14pt.
  icon: string;
  /// Pre-formatted value string. Defaults to "--" matching the Qt default.
  value?: string;
};

export default function MetricCard({ title, icon, value = "--" }: MetricCardProps) {
  return (
    <div
      data-ui="MetricCard"
      style={{
        // setMinimumHeight(160) — Qt.
        minHeight: 160,
        // qlineargradient(x1:0,y1:0,x2:0,y2:1 stop:0 #1e2936 stop:1 #16213e)
        background: "linear-gradient(180deg, #1e2936 0%, #16213e 100%)",
        // border: 1px solid #3a4a5a; border-radius: 8px;
        border: "1px solid #3a4a5a",
        borderRadius: 8,
        // QVBoxLayout(margins 15/12/15/12, spacing 8)
        padding: "12px 15px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        // QLabel { color: #fafafa } — applied per-element below so the
        // value label can stay bold-26pt regardless of parent overrides.
        color: "#fafafa",
      }}
    >
      {/* title_layout — icon (14pt) + title (11pt bold) */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 14 /* pt≈px at 100% DPI */ }}>{icon}</span>
        <span style={{ fontSize: 11, fontWeight: 700 }}>{title}</span>
        <div style={{ flex: 1 }} />
      </div>

      {/* layout.addStretch(1) above the value */}
      <div style={{ flex: 1 }} />

      {/* value_label (26pt bold, Qt.AlignCenter) */}
      <div
        style={{
          fontSize: 26,
          fontWeight: 700,
          textAlign: "center",
          color: "var(--fg-strong)",
        }}
      >{value}</div>

      {/* layout.addStretch(1) below the value */}
      <div style={{ flex: 1 }} />
    </div>
  );
}
