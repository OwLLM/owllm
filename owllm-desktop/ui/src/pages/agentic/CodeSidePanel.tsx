// CodeSidePanel — the Code page's right column (user spec 2026-07-04):
// ⚡ Super User options for the solo coding agent. Two sections:
//   1. RULES — the SAME per-project directives the agentic team uses
//      (directives.rs; auto-seeded with the native best-practice set).
//      When the folder matches an agentic project the rules are stored
//      under that project's id, so the team page and the Code page edit
//      ONE rule set. Rules are injected into every coder turn.
//   2. NOTEBOOK — the Run Notebook (brainstorm + next steps + digest
//      agent), shared with the Agents page on the same project. The
//      panel shows a live pending-steps summary + the auto-feed toggle;
//      the full notebook opens as the usual popup.
import { useEffect, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type Directive } from "./dispatch";
import { loadNotebook, saveNotebook, NOTEBOOK_EVENT, type NotebookState } from "./RunNotebook";

const KIND_COLOR: Record<Directive["kind"], string> = {
  must: "#ff9d7a",
  prefer: "#7fd4ff",
  avoid: "#ffd27a",
};

type Props = {
  /// Directives + notebook scope: the matching agentic project id when the
  /// folder is a team project, else a stable per-folder key.
  scopeId: string;
  /// True when scopeId IS an agentic project (rules/notebook shared with the team).
  sharedWithTeam: boolean;
  directives: Directive[];
  onDirectivesChanged: () => void | Promise<void>;
  /// Coder turn in flight — feeding a step becomes a mid-run steer.
  busy: boolean;
  onOpenNotebook: () => void;
};

export default function CodeSidePanel({ scopeId, sharedWithTeam, directives, onDirectivesChanged, busy, onOpenNotebook }: Props) {
  // ---- Rules editing (same add/edit/delete/restore logic as the team's SuperUserCard) ----
  const [newKind, setNewKind] = useState<Directive["kind"]>("must");
  const [newText, setNewText] = useState("");
  const [rulesBusy, setRulesBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const addRule = async () => {
    const text = newText.trim();
    if (!text || !scopeId) return;
    setRulesBusy(true);
    try {
      await invoke("directives_add", { input: { projectId: scopeId, kind: newKind, text } });
      setNewText("");
      await onDirectivesChanged();
    } catch (e) { console.error("directives_add failed", e); }
    finally { setRulesBusy(false); }
  };
  const saveEdit = async () => {
    if (!editingId) return;
    const text = editText.trim();
    if (!text) return;
    setRulesBusy(true);
    try {
      await invoke("directives_update", { input: { id: editingId, text } });
      setEditingId(null);
      await onDirectivesChanged();
    } catch (e) { console.error("directives_update failed", e); }
    finally { setRulesBusy(false); }
  };
  const deleteRule = async (id: string) => {
    setRulesBusy(true);
    try {
      await invoke("directives_delete", { id });
      await onDirectivesChanged();
    } catch (e) { console.error("directives_delete failed", e); }
    finally { setRulesBusy(false); }
  };
  const restoreDefaults = async () => {
    if (!scopeId) return;
    setRulesBusy(true);
    try {
      await invoke<number>("directives_restore_defaults", { projectId: scopeId });
      await onDirectivesChanged();
    } catch (e) { console.error("directives_restore_defaults failed", e); }
    finally { setRulesBusy(false); }
  };

  // ---- Notebook summary (live against the shared per-project blob) ----
  const [nb, setNb] = useState<NotebookState>(() => loadNotebook(scopeId));
  useEffect(() => { setNb(loadNotebook(scopeId)); }, [scopeId]);
  useEffect(() => {
    const onChanged = (e: Event) => {
      const pid = (e as CustomEvent).detail?.projectId;
      if (!pid || pid === scopeId) setNb(loadNotebook(scopeId));
    };
    window.addEventListener(NOTEBOOK_EVENT, onChanged as EventListener);
    return () => window.removeEventListener(NOTEBOOK_EVENT, onChanged as EventListener);
  }, [scopeId]);
  const pending = nb.steps.filter((s) => s.status === "pending");
  const toggleAutoFeed = () => {
    const next = { ...nb, autoFeed: !nb.autoFeed };
    setNb(next);
    saveNotebook(scopeId, next);
  };

  const sectionTitle: CSSProperties ={ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, color: "var(--fg-muted)", textTransform: "uppercase" };
  const byKind = (k: Directive["kind"]) => directives.filter((d) => d.kind === k);

  return (
    <div data-ui="CodeSidePanel" style={{ width: 300, flexShrink: 0, minHeight: 0, display: "flex", flexDirection: "column", gap: 8, overflowY: "auto", background: "linear-gradient(135deg, rgba(38,30,10,0.55) 0%, rgba(18,14,4,0.55) 100%)", border: "1px solid rgba(255,200,80,0.3)", borderRadius: 8, padding: "8px 10px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "#ffd27a" }}>⚡ Super User</span>
        {sharedWithTeam && (
          <span title="This folder is also an agentic project — rules and notebook are SHARED with the team pages." style={{ fontSize: 10, color: "var(--fg-muted)", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "1px 6px" }}>shared with team</span>
        )}
      </div>

      {/* ---- Notebook ---- */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, border: "1px solid var(--border-strong)", borderRadius: 8, padding: "8px 10px", background: "var(--bg-input)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={sectionTitle}>📓 Notebook</span>
          <span style={{ flex: 1 }} />
          <button className="btn" style={{ fontSize: 11, padding: "2px 10px" }} onClick={onOpenNotebook}>Open</button>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.45 }}>
          {pending.length === 0
            ? "No pending next steps. Brainstorm + plan in the notebook; steps feed the coder."
            : <>Next up{busy ? " (feeds as a mid-run steer)" : ""}:</>}
        </div>
        {pending.slice(0, 4).map((s) => (
          <div key={s.id} style={{ fontSize: 12, color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={s.text}>• {s.text}</div>
        ))}
        {pending.length > 4 && <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>… +{pending.length - 4} more</div>}
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--fg)", cursor: "pointer" }} title="When the coder finishes a turn cleanly, the next pending step is sent by itself.">
          <input type="checkbox" checked={nb.autoFeed} onChange={toggleAutoFeed} />
          Auto-feed next step
        </label>
      </div>

      {/* ---- Rules ---- */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, border: "1px solid var(--border-strong)", borderRadius: 8, padding: "8px 10px", background: "var(--bg-input)", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={sectionTitle}>📐 Project rules</span>
          <span style={{ flex: 1 }} />
          <button className="btn" style={{ fontSize: 10.5, padding: "2px 8px" }} onClick={() => void restoreDefaults()} disabled={rulesBusy} title="Re-add any built-in best-practice rules you deleted.">Restore defaults</button>
        </div>
        <div style={{ fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.4 }}>
          Applied to every coder turn — the same rule set the agentic team follows.
        </div>
        {(["must", "prefer", "avoid"] as const).map((kind) => {
          const rules = byKind(kind);
          if (rules.length === 0) return null;
          return (
            <div key={kind} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: KIND_COLOR[kind], letterSpacing: 0.5 }}>{kind.toUpperCase()}</span>
              {rules.map((d) => (
                <div key={d.id} style={{ display: "flex", alignItems: "flex-start", gap: 5 }}>
                  {editingId === d.id ? (
                    <>
                      <input value={editText} onChange={(e) => setEditText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") void saveEdit(); if (e.key === "Escape") setEditingId(null); }}
                        autoFocus
                        style={{ flex: 1, fontSize: 11.5, background: "var(--bg-panel)", color: "var(--fg)", border: "1px solid var(--border-strong)", borderRadius: 5, padding: "2px 6px" }} />
                      <button className="btn" style={{ fontSize: 10, padding: "1px 6px" }} onClick={() => void saveEdit()} disabled={rulesBusy}>✓</button>
                    </>
                  ) : (
                    <>
                      <span style={{ flex: 1, fontSize: 11.5, color: "var(--fg)", lineHeight: 1.4 }}>{d.text}</span>
                      <button title="Edit" onClick={() => { setEditingId(d.id); setEditText(d.text); }} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--fg-muted)", fontSize: 10, padding: 0 }}>✏️</button>
                      <button title="Delete" onClick={() => void deleteRule(d.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#ff8c8c", fontSize: 10, padding: 0 }}>🗑</button>
                    </>
                  )}
                </div>
              ))}
            </div>
          );
        })}
        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
          <select value={newKind} onChange={(e) => setNewKind(e.target.value as Directive["kind"])}
            style={{ fontSize: 11, background: "var(--bg-panel)", color: KIND_COLOR[newKind], border: "1px solid var(--border-strong)", borderRadius: 5, padding: "2px 4px" }}>
            <option value="must">must</option>
            <option value="prefer">prefer</option>
            <option value="avoid">avoid</option>
          </select>
          <input value={newText} onChange={(e) => setNewText(e.target.value)} placeholder="Add a rule…"
            onKeyDown={(e) => { if (e.key === "Enter") void addRule(); }}
            style={{ flex: 1, fontSize: 11.5, background: "var(--bg-panel)", color: "var(--fg)", border: "1px solid var(--border-strong)", borderRadius: 5, padding: "3px 6px" }} />
          <button className="btn" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => void addRule()} disabled={rulesBusy || !newText.trim()}>+ Add</button>
        </div>
      </div>
    </div>
  );
}
