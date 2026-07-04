// CodeSidePanel — the Code page's right column (user spec 2026-07-04):
// a RESIZABLE column (drag its left edge; default 15% of the window, min
// 300px) with a small utility header + TWO pages on a tab strip (the same
// tab pattern as TeamMemoryModal):
//   • header: agent MODE (plan / auto / chat) + Terminal popup toggle +
//     VS Code-style USAGE bars for the account behind the active model
//     (account_usage — Claude subscription today, "n/a" note otherwise).
//   • ⚡ Super User page — the SAME per-project directives the agentic team
//     uses (directives.rs; auto-seeded native best-practice set). When the
//     folder matches an agentic project the rules are stored under that
//     project's id, so the team page and the Code page edit ONE rule set.
//   • 📓 Notebook page — the shared RunNotebook rendered INLINE (passed in
//     as `notebook` by CodePage so all its wiring stays in one place).
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type Directive } from "./dispatch";

const KIND_COLOR: Record<Directive["kind"], string> = {
  must: "#ff9d7a",
  prefer: "#7fd4ff",
  avoid: "#ffd27a",
};

export type CodeAgentMode = "plan" | "auto" | "chat";

const WIDTH_KEY = "owllm:code:sidew";
const TAB_KEY = "owllm:code:sidetab";
const MIN_W = 300;

type UsageWindow = { label: string; usedPct: number; resetsAt?: string | null };
type AccountUsage = { available: boolean; provider: string; note: string; windows: UsageWindow[] };

/// "Resets in 3h" from an ISO timestamp — coarse on purpose (like VS Code).
function resetsIn(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const m = Math.round(ms / 60000);
  if (m < 60) return `Resets in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `Resets in ${h}h`;
  return `Resets in ${Math.round(h / 24)}d`;
}

type Props = {
  /// Directives + notebook scope: the matching agentic project id when the
  /// folder is a team project, else a stable per-folder key.
  scopeId: string;
  /// True when scopeId IS an agentic project (rules/notebook shared with the team).
  sharedWithTeam: boolean;
  directives: Directive[];
  onDirectivesChanged: () => void | Promise<void>;
  /// Agent mode — drives what the composer's primary button does.
  mode: CodeAgentMode;
  onModeChange: (m: CodeAgentMode) => void;
  /// Terminal popup (owned by CodePage; the button here just toggles it).
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  /// providerFor(modelId) for the active model — drives the usage fetch.
  usageProvider: string;
  /// The inline RunNotebook (CodePage owns its props/wiring).
  notebook: ReactNode;
};

export default function CodeSidePanel({ scopeId, sharedWithTeam, directives, onDirectivesChanged, mode, onModeChange, terminalOpen, onToggleTerminal, usageProvider, notebook }: Props) {
  // ---- Resizable width: default 15% of the window, floor at the original 300px ----
  const [width, setWidth] = useState<number>(() => {
    try {
      const saved = parseInt(localStorage.getItem(WIDTH_KEY) || "", 10);
      if (Number.isFinite(saved) && saved >= MIN_W) return saved;
    } catch { /* default below */ }
    return Math.max(MIN_W, Math.round(window.innerWidth * 0.15));
  });
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: width };
    const move = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const w = Math.min(Math.round(window.innerWidth * 0.6), Math.max(MIN_W, d.startW + (d.startX - ev.clientX)));
      setWidth(w);
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setWidth((w) => { try { localStorage.setItem(WIDTH_KEY, String(w)); } catch { } return w; });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // ---- Tabs (same strip pattern as TeamMemoryModal Facts/Worklog) ----
  const [tab, setTab] = useState<"super" | "notebook">(() => {
    try { return localStorage.getItem(TAB_KEY) === "notebook" ? "notebook" : "super"; } catch { return "super"; }
  });
  const pickTab = (t: "super" | "notebook") => { setTab(t); try { localStorage.setItem(TAB_KEY, t); } catch { } };

  // ---- Account usage (VS Code-style) — refreshed on provider change + every 5 min ----
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      invoke<AccountUsage>("account_usage", { provider: usageProvider || "" })
        .then((u) => { if (alive) setUsage(u); })
        .catch(() => { if (alive) setUsage(null); });
    };
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => { alive = false; clearInterval(t); };
  }, [usageProvider]);

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

  const sectionTitle: CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: 0.6, color: "var(--fg-muted)", textTransform: "uppercase" };
  const byKind = (k: Directive["kind"]) => directives.filter((d) => d.kind === k);

  const MODES: Array<{ id: CodeAgentMode; label: string; hint: string }> = [
    { id: "plan", label: "📋 Plan", hint: "Break the goal into ordered Kanban steps, then build them one by one." },
    { id: "auto", label: "⚡ Auto", hint: "Act directly — read, edit, create files and run commands to do the task." },
    { id: "chat", label: "💬 Chat", hint: "Discuss/review only — read-only tools, no edits, no state-changing commands." },
  ];

  const tabBtn = (t: "super" | "notebook", label: string) => (
    <button
      key={t}
      onClick={() => pickTab(t)}
      style={{
        height: 28, padding: "0 12px", cursor: "pointer", fontSize: 12, fontWeight: 600,
        border: "1px solid " + (tab === t ? "rgba(var(--accent-rgb),0.4)" : "var(--border)"),
        borderBottom: "none", borderRadius: "8px 8px 0 0",
        background: tab === t ? "rgba(var(--accent-rgb),0.12)" : "transparent",
        color: tab === t ? "var(--accent)" : "var(--fg-muted)",
      }}
    >{label}</button>
  );

  return (
    <div data-ui="CodeSidePanel" style={{ position: "relative", width, flexShrink: 0, minHeight: 0, display: "flex", flexDirection: "column", gap: 6, background: "linear-gradient(135deg, rgba(38,30,10,0.55) 0%, rgba(18,14,4,0.55) 100%)", border: "1px solid rgba(255,200,80,0.3)", borderRadius: 8, padding: "8px 10px 8px 12px" }}>
      {/* Drag handle — resize by dragging the column's left edge. */}
      <div
        onMouseDown={onDragStart}
        title="Drag to resize"
        style={{ position: "absolute", left: -2, top: 0, bottom: 0, width: 7, cursor: "col-resize", zIndex: 2 }}
      />

      {/* ---- Utility header: mode + terminal, then account usage ---- */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, border: "1px solid var(--border-strong)", borderRadius: 8, padding: "8px 10px", background: "var(--bg-input)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <div style={{ display: "flex", border: "1px solid var(--border-strong)", borderRadius: 7, overflow: "hidden" }}>
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => onModeChange(m.id)}
                title={m.hint}
                style={{
                  height: 26, padding: "0 9px", fontSize: 11, fontWeight: 700, cursor: "pointer", border: "none",
                  background: mode === m.id ? "rgba(var(--accent-rgb),0.22)" : "transparent",
                  color: mode === m.id ? "var(--accent)" : "var(--fg-muted)",
                }}
              >{m.label}</button>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          <button
            className="btn"
            onClick={onToggleTerminal}
            title="Open a terminal in the workspace folder — floats above the app (this app only)."
            style={{ fontSize: 11, padding: "3px 10px", ...(terminalOpen ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}) }}
          >🖥 Terminal</button>
        </div>
        {/* USAGE — like VS Code: label, % used, bar, reset time. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={{ ...sectionTitle, fontSize: 10 }}>Usage</span>
          {usage?.available ? usage.windows.map((w, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={{ display: "flex", alignItems: "baseline", fontSize: 11.5, color: "var(--fg)" }}>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.label}</span>
                <span style={{ fontWeight: 700 }}>{Math.round(w.usedPct)}%</span>
              </div>
              <div style={{ height: 4, borderRadius: 2, background: "var(--bg-surface)", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.min(100, Math.max(0, w.usedPct))}%`, borderRadius: 2, background: w.usedPct >= 90 ? "#ff8c8c" : w.usedPct >= 70 ? "#ffd27a" : "var(--accent)" }} />
              </div>
              {resetsIn(w.resetsAt) && <span style={{ fontSize: 10, color: "var(--fg-muted)" }}>{resetsIn(w.resetsAt)}</span>}
            </div>
          )) : (
            <span style={{ fontSize: 10.5, color: "var(--fg-muted)" }} title={usage?.note || ""}>
              {usage ? "no quota data for this account" : "…"}
            </span>
          )}
        </div>
      </div>

      {/* ---- Tab strip: ⚡ Super User | 📓 Notebook (two PAGES) ---- */}
      <div style={{ display: "flex", gap: 4, alignItems: "flex-end", borderBottom: "1px solid var(--border)", paddingTop: 2 }}>
        {tabBtn("super", "⚡ Super User")}
        {tabBtn("notebook", "📓 Notebook")}
        {sharedWithTeam && (
          <span title="This folder is also an agentic project — rules and notebook are SHARED with the team pages." style={{ marginLeft: "auto", marginBottom: 4, fontSize: 10, color: "var(--fg-muted)", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "1px 6px", whiteSpace: "nowrap" }}>shared with team</span>
        )}
      </div>

      {/* ---- Page: Notebook (kept mounted so notes/digest survive tab flips) ---- */}
      <div style={{ flex: 1, minHeight: 0, display: tab === "notebook" ? "flex" : "none", flexDirection: "column" }}>
        {notebook}
      </div>

      {/* ---- Page: Super User (project rules) ---- */}
      {tab === "super" && (
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, border: "1px solid var(--border-strong)", borderRadius: 8, padding: "8px 10px", background: "var(--bg-input)" }}>
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
      )}
    </div>
  );
}
