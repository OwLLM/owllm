// RulesEditor — THE project-rules UI, extracted verbatim from the
// SuperUserCard "rules" face so every surface renders the SAME editor
// (user spec 2026-07-04: "do not recode the UI"). Consumers:
//   • AgentsPage → SuperUserCard mode="rules" (the team's Rules tab)
//   • CodePage  → CodeSidePanel ⚡ Super User tab
// All persistence goes through the directives_* Tauri commands; the
// parent owns the directives array and re-fetches via onChanged.
import { useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type Directive } from "./dispatch";

export default function RulesEditor({ projectId, directives, onChanged, scopeNote }: {
  projectId: string;
  directives: Directive[];
  /// Trigger a re-fetch of the project's rules after an inline add /
  /// edit / delete so the list updates without remounting.
  onChanged: () => Promise<void> | void;
  /// The closing line of the About block — states WHO sees these rules
  /// on this surface (team: "every agent…", code: "every coder turn…").
  scopeNote: ReactNode;
}) {
  const [newKind, setNewKind] = useState<"must" | "prefer" | "avoid">("must");
  const [newText, setNewText] = useState("");
  const [rulesBusy, setRulesBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [editKind, setEditKind] = useState<"must" | "prefer" | "avoid">("must");

  const addRule = async () => {
    const text = newText.trim();
    if (!text || !projectId) return;
    setRulesBusy(true);
    try {
      await invoke("directives_add", { input: { projectId, kind: newKind, text } });
      setNewText("");
      await onChanged();
    } catch (e) { console.error("directives_add failed", e); }
    finally { setRulesBusy(false); }
  };
  const beginEdit = (d: Directive) => {
    setEditingId(d.id);
    setEditText(d.text);
    setEditKind(d.kind);
  };
  const saveEdit = async () => {
    if (!editingId) return;
    setRulesBusy(true);
    try {
      await invoke("directives_update", { input: { id: editingId, kind: editKind, text: editText } });
      setEditingId(null);
      await onChanged();
    } catch (e) { console.error("directives_update failed", e); }
    finally { setRulesBusy(false); }
  };
  const deleteRule = async (id: string) => {
    setRulesBusy(true);
    try {
      await invoke("directives_delete", { id });
      await onChanged();
    } catch (e) { console.error("directives_delete failed", e); }
    finally { setRulesBusy(false); }
  };
  // Re-add any built-in best-practice rules the user deleted (no duplicates).
  const restoreDefaults = async () => {
    if (!projectId) return;
    setRulesBusy(true);
    try {
      await invoke<number>("directives_restore_defaults", { projectId });
      await onChanged();
    } catch (e) { console.error("directives_restore_defaults failed", e); }
    finally { setRulesBusy(false); }
  };

  return (
    <div data-ui="rulesEditor" style={{ display:"flex", flexDirection:"column", gap:8, minHeight:0 }}>
      {/* Explanation block — three kinds of rule, each with a one-line
          meaning, then the surface-specific scope note. */}
      <div data-ui="rulesHelp" style={{
        background:"rgba(255,107,107,0.08)",
        border:"1px solid rgba(255,107,107,0.25)",
        borderRadius:8,
        padding:"8px 10px",
        fontSize:11, lineHeight:1.5,
        color:"var(--fg)",
        display:"flex", flexDirection:"column", gap:4,
      }}>
        <div style={{ fontSize:10, fontWeight:800, letterSpacing:0.8, color:"#ff6b6b", textTransform:"uppercase" }}>About rules</div>
        <div><b style={{ color:"#ff8c8c" }}>MUST</b> — hard requirement; the team should refuse the goal if it can't comply.</div>
        <div><b style={{ color:"#9af0a8" }}>PREFER</b> — soft hint; bias the plan toward this when there's a choice.</div>
        <div><b style={{ color:"#ffd97a" }}>AVOID</b> — anti-pattern; do NOT do this unless the goal is impossible without it.</div>
        <div style={{ color:"var(--fg-muted)", marginTop:2 }}>{scopeNote}</div>
      </div>
      {/* Add-rule row — kind dropdown + text input + + button. */}
      <div data-ui="rulesAdd" style={{ display:"flex", alignItems:"center", gap:6 }}>
        <select
          value={newKind}
          onChange={e => setNewKind(e.target.value as any)}
          disabled={rulesBusy || !projectId}
          style={{
            height:28, borderRadius:6, padding:"0 6px",
            background:"rgba(20,16,4,0.6)", color:"var(--fg)",
            border:"1px solid rgba(255,200,80,0.25)",
            fontSize:11, fontWeight:700,
          }}
        >
          <option value="must">MUST</option>
          <option value="prefer">PREFER</option>
          <option value="avoid">AVOID</option>
        </select>
        <input
          value={newText}
          onChange={e => setNewText(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && newText.trim()) addRule(); }}
          placeholder={projectId ? "New rule — Enter to add" : "Pick a project first"}
          disabled={rulesBusy || !projectId}
          style={{
            flex:1, minWidth:0, height:28, borderRadius:6, padding:"0 8px",
            background:"rgba(20,16,4,0.6)", color:"var(--fg)",
            border:"1px solid rgba(255,200,80,0.25)",
            fontSize:13,
          }}
        />
        <button
          onClick={addRule}
          disabled={rulesBusy || !projectId || !newText.trim()}
          title="Add rule"
          style={{
            width:28, height:28, borderRadius:6,
            border:"1px solid #ffd97a",
            background: newText.trim() && projectId ? "#ffd97a" : "rgba(255,217,122,0.25)",
            color: newText.trim() && projectId ? "#1a1404" : "#7d6f4b",
            fontSize:16, fontWeight:700,
            cursor: newText.trim() && projectId ? "pointer" : "not-allowed",
          }}
        >+</button>
      </div>
      {/* Restore the native best-practice set (re-adds any you deleted; no
          duplicates). The defaults seed automatically on a new project; this
          is the "I deleted some and want them back" affordance. */}
      <div style={{ display:"flex", justifyContent:"flex-end" }}>
        <button
          onClick={restoreDefaults}
          disabled={rulesBusy || !projectId}
          title="Re-add the built-in best-practice rules you've deleted (won't duplicate ones you kept)"
          style={{ background:"none", border:"none", color:"var(--fg-muted)", fontSize:10.5, cursor: projectId ? "pointer" : "not-allowed", textDecoration:"underline", padding:"2px 0" }}
        >↺ Restore best-practices</button>
      </div>
      {/* Rule list — grouped by kind, each row has Edit + Delete
          inline. While editing, the row swaps to inline form. */}
      <div style={{ background:"rgba(20,16,4,0.6)", border:"1px solid rgba(255,200,80,0.20)", borderRadius:8, padding:"8px 10px", flex:"1 1 auto", minHeight:0, overflow:"auto", fontSize:12, color:"var(--fg)", display:"flex", flexDirection:"column", gap:6 }}>
        {directives.length === 0 ? (
          <div style={{ color:"var(--fg-subtle)", fontStyle:"italic" }}>
            No project rules yet — type one above to add.
          </div>
        ) : (
          (["must", "prefer", "avoid"] as const).flatMap(kind => {
            const items = directives.filter(d => d.kind === kind);
            if (items.length === 0) return [];
            const kc = kind === "must" ? "#ff8c8c" : kind === "prefer" ? "#9af0a8" : "#ffd97a";
            return [
              <div key={`h-${kind}`} style={{ fontSize:10, fontWeight:800, letterSpacing:0.6, color:kc, textTransform:"uppercase", marginTop:4 }}>{kind}</div>,
              ...items.map(d => editingId === d.id ? (
                <div key={d.id} style={{ display:"flex", flexDirection:"column", gap:4, paddingLeft:8, borderLeft:`2px solid ${kc}` }}>
                  <div style={{ display:"flex", gap:4 }}>
                    <select
                      value={editKind}
                      onChange={e => setEditKind(e.target.value as any)}
                      style={{ height:24, borderRadius:4, padding:"0 4px", background:"rgba(20,16,4,0.6)", color:"var(--fg)", border:"1px solid rgba(255,200,80,0.25)", fontSize:10, fontWeight:700 }}
                    >
                      <option value="must">MUST</option>
                      <option value="prefer">PREFER</option>
                      <option value="avoid">AVOID</option>
                    </select>
                    <input
                      value={editText}
                      onChange={e => setEditText(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditingId(null); }}
                      autoFocus
                      style={{ flex:1, minWidth:0, height:24, borderRadius:4, padding:"0 6px", background:"rgba(20,16,4,0.6)", color:"var(--fg)", border:"1px solid rgba(255,200,80,0.25)", fontSize:12 }}
                    />
                  </div>
                  <div style={{ display:"flex", gap:4, justifyContent:"flex-end" }}>
                    <button onClick={() => setEditingId(null)} disabled={rulesBusy} style={{ height:22, padding:"0 8px", borderRadius:4, border:"1px solid rgba(255,255,255,0.15)", background:"transparent", color:"var(--fg-muted)", fontSize:10, cursor:"pointer" }}>Cancel</button>
                    <button onClick={saveEdit} disabled={rulesBusy || !editText.trim()} style={{ height:22, padding:"0 10px", borderRadius:4, border:"1px solid #ffd97a", background:"#ffd97a", color:"#1a1404", fontSize:10, fontWeight:700, cursor:"pointer" }}>Save</button>
                  </div>
                </div>
              ) : (
                <div key={d.id} style={{ display:"flex", alignItems:"flex-start", gap:6, paddingLeft:8, borderLeft:`2px solid ${kc}`, lineHeight:1.4 }}>
                  <span style={{ flex:1 }}>
                    {d.text}
                    {d.source === "builtin" && (
                      <span title="Built-in best practice — edit or delete it like any rule" style={{ marginLeft:6, fontSize:9, fontWeight:700, letterSpacing:0.4, color:"var(--fg-subtle)", border:"1px solid var(--border)", borderRadius:4, padding:"0 4px", verticalAlign:"middle", textTransform:"uppercase" }}>native</span>
                    )}
                  </span>
                  <button onClick={() => beginEdit(d)} disabled={rulesBusy} title="Edit" style={{ width:22, height:22, padding:0, borderRadius:4, border:"none", background:"transparent", color:"var(--fg-muted)", fontSize:12, cursor:"pointer" }}>✏️</button>
                  <button onClick={() => deleteRule(d.id)} disabled={rulesBusy} title="Delete" style={{ width:22, height:22, padding:0, borderRadius:4, border:"none", background:"transparent", color:"#ff8c8c", fontSize:12, cursor:"pointer" }}>🗑</button>
                </div>
              )),
            ];
          })
        )}
      </div>
    </div>
  );
}
