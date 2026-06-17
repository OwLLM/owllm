// Shared card + row primitives for the Info page and anything that wants to
// match its look (e.g. the Sandbox disk card moved off Home). Extracted so both
// InfoPage and SandboxDiskCard render the same gradient card without a circular
// import between them.
import React from "react";

export function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "180px 1fr",
      gap: 12,
      padding: "6px 0",
      borderBottom: "1px solid var(--border)",
      fontSize: 12,
    }}>
      <div style={{ color: "var(--fg-muted)" }}>{label}</div>
      <div style={{ color: "var(--fg)", fontFamily: "Consolas, monospace", fontSize: 12 }}>{value}</div>
    </div>
  );
}

// Optional `action` renders on the right of the title bar (used for a per-card
// Refresh button). Existing InfoPage cards just omit it.
export function Card({ title, action, children }: {
  title: string; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div style={{
      background: "linear-gradient(180deg, rgba(60,60,80,0.4), rgba(40,40,60,0.4))",
      border: "1px solid rgba(var(--accent-rgb),0.20)",
      borderRadius: 10,
      padding: "14px 18px",
      display: "flex",
      flexDirection: "column",
      gap: 4,
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        borderBottom: "1px solid rgba(var(--accent-rgb),0.10)",
        paddingBottom: 6,
        marginBottom: 6,
      }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg)", flex: 1 }}>{title}</div>
        {action}
      </div>
      {children}
    </div>
  );
}
