// ModelRequiredDialog — the rule-based popup shown when the user sends a
// message on a surface that has no model selected.
//
// Pickers used to auto-select the FIRST local model whenever a project had
// nothing saved, so a fresh page looked configured while running weights the
// user never chose. That auto-pick is gone: an unset picker now reads
// SELECT_MODEL_LABEL ("Select model") and the send is BLOCKED here.
//
// Pure UI — no LLM call, no backend. The calling page opens it and returns
// from its send path; `where` names the picker the user has to visit.
import React from "react";

export default function ModelRequiredDialog({
  open, where, detail, onClose,
}: {
  open: boolean;
  /// Where the picker lives, e.g. "the Coder header" or "the agent card".
  where: string;
  /// Optional extra line (which agent, which pane).
  detail?: string;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div
      data-ui="ModelRequiredDialog"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 10100,
        background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
      }}
    >
      <div style={{
        width: "min(460px, 92vw)", background: "var(--bg-panel)",
        border: "1px solid var(--border-strong)", borderRadius: 12,
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", borderBottom: "1px solid var(--border-strong)" }}>
          <span style={{ fontSize: 16 }}>🧠</span>
          <span style={{ fontWeight: 700, color: "var(--fg-strong)" }}>No model selected</span>
        </div>
        <div style={{ padding: "14px", fontSize: 13, lineHeight: 1.5, color: "var(--fg)" }}>
          Nothing was sent. Pick a model in <b>{where}</b> first — it still reads
          “Select model”.
          {detail && <div style={{ marginTop: 8, color: "var(--fg-muted)", fontSize: 12 }}>{detail}</div>}
          <div style={{ marginTop: 10, color: "var(--fg-muted)", fontSize: 12 }}>
            OwLLM never picks one for you, so a run can’t use — or bill — weights
            you didn’t choose.
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border-strong)" }}>
          <button
            data-ui="ModelRequiredDialogClose"
            onClick={onClose}
            style={{
              padding: "6px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600,
              background: "var(--accent-soft)", color: "var(--fg-strong)",
              border: "1px solid var(--border-strong)", cursor: "pointer",
            }}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
