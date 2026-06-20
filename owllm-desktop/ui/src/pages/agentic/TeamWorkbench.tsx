// TeamWorkbench — "The Outfitter Inspector". The redesigned, full-area team
// editor that opens from the Studio Teams view. Three panes inside one shell:
//
//   LEFT   roster bench — loadout cards (⚙ tools · 📚 skills · ctx bar), select.
//   CENTER derived tier-layout graph (read-only, click a node to select) +
//          a tabbed catalog (Skills | Tools) with search and click-to-equip.
//   RIGHT  a polymorphic Inspector that rebinds to the current selection
//          (team | agent), with real editable fields (no native dialogs).
//
// Skills are equipped per-agent into the team TEMPLATE's `extra_skills` (which
// dispatch already reads as spec.extraSkills, v0.5.72). Project-level per-agent
// skills live separately in graph_json (the Agents page). Save round-trips
// through save_team_template, preserving unknown JSON fields. The team
// normalizer (teamConfig) runs live as a co-author: its changes[] surface as
// "done for you" and warnings[] as "review", never blocking Save.
//
// Inline-styled, no graph lib, no new deps — consistent with the rest of Studio.

import React, { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ModelPicker, { type ModelInfo, type AccountsStatusLite } from "./ModelPicker";
import { normalizeTeam } from "./teamConfig";
import type { RoleData, Edge, Team as DispatchTeam, AgentSpec as DispatchAgentSpec } from "./dispatch";
import { owlSrc, resolveAgentIcon, displayLabel } from "./StudioPage";

// ---- shapes the workbench consumes (structurally satisfied by StudioPage) ----

/// A role/skill definition as the catalog + inspector need it. StudioPage's
/// AgentDef is structurally assignable to this.
export type WorkbenchRole = {
  name: string;
  icon: string;
  description?: string;
  tools?: string[] | null;
  mcpTools?: string[] | null;
  systemPrompt?: string;
  temperature?: number;
  canDispatch?: boolean;
  isSkill?: boolean;
  builtIn?: boolean;
};

export type SkillPackBackend = { id: string; path: string; dir: string; frontmatter: any; body: string };
export type TeamTemplateBackend = { id: string; path: string; built_in: boolean; data: any };

/// One agent on the team, in editable working form. `orig` preserves the raw
/// JSON object so unknown per-agent fields survive the save round-trip.
type WAgent = {
  name: string;
  base: string;
  icon?: string | null;
  description?: string;
  extraPrompt?: string;
  extraSkills: string[];
  modelId?: string;
  temperature?: number;
  canDispatch?: boolean;
  orig: any;
};

type Selection =
  | { kind: "team" }
  | { kind: "agent"; name: string }
  | { kind: "edge"; source: string; target: string };

// ---- helpers ----------------------------------------------------------------

const ACCENT = "var(--accent)";
const SKILL_GREEN = "rgba(160,232,138,0.30)";
const SKILL_GREEN_BG = "rgba(160,232,138,0.12)";

/// chars/4 — a LABELLED budget estimate, never an exact token count.
function ctxEstimate(body: string | undefined): number {
  return Math.round((body?.length ?? 0) / 4);
}
function kLabel(chars: number): string {
  return `~${Math.max(1, Math.round(chars / 1000))}k`;
}

function skillName(p: SkillPackBackend): string {
  const fm = p.frontmatter ?? {};
  return (typeof fm.name === "string" && fm.name) || p.id;
}
function skillDesc(p: SkillPackBackend): string {
  const fm = p.frontmatter ?? {};
  return (typeof fm.description === "string" && fm.description) || "";
}

/// Read the raw template JSON into editable working agents.
function agentsFromData(data: any): WAgent[] {
  const arr = Array.isArray(data?.agents) ? data.agents : [];
  return arr.map((a: any) => ({
    name: a?.name ?? "",
    base: a?.base ?? "",
    icon: a?.icon ?? null,
    description: a?.description ?? "",
    extraPrompt: a?.extra_prompt ?? "",
    extraSkills: Array.isArray(a?.extra_skills) ? a.extra_skills.filter((x: any) => typeof x === "string") : [],
    modelId: typeof a?.default_model_id === "string" ? a.default_model_id : undefined,
    temperature: typeof a?.default_temperature === "number" ? a.default_temperature : undefined,
    canDispatch: a?.can_dispatch === true,
    orig: a ?? {},
  }));
}
function edgesFromData(data: any): Edge[] {
  const e = data?.graph?.edges;
  return Array.isArray(e) ? e.filter((x: any) => x && typeof x.source === "string" && typeof x.target === "string") : [];
}

/// BFS tier per agent: orchestrator = 0, depth from it = tier; unreachable
/// agents drop to maxTier+1 so they render in their own row.
function computeTiers(agents: WAgent[], edges: Edge[], orchName: string | null): Map<string, number> {
  const tier = new Map<string, number>();
  if (!orchName) { agents.forEach(a => tier.set(a.name, 0)); return tier; }
  tier.set(orchName, 0);
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }
  const queue = [orchName];
  while (queue.length) {
    const cur = queue.shift()!;
    const d = tier.get(cur)!;
    for (const t of adj.get(cur) ?? []) {
      if (!tier.has(t)) { tier.set(t, d + 1); queue.push(t); }
    }
  }
  let maxT = 0;
  tier.forEach(v => { maxT = Math.max(maxT, v); });
  for (const a of agents) if (!tier.has(a.name)) tier.set(a.name, maxT + 1);
  return tier;
}

// =============================================================================

export default function TeamWorkbench({
  backend, roleDefs, skillPacks, models, accountsStatus,
  onClose, onSaved, onOpenSkillLibrary,
}: {
  backend: TeamTemplateBackend;
  roleDefs: WorkbenchRole[];
  skillPacks: SkillPackBackend[];
  models: ModelInfo[];
  accountsStatus: AccountsStatusLite | null;
  onClose: () => void;
  onSaved: (newName: string) => void;
  onOpenSkillLibrary: () => void;
}) {
  const d0 = backend.data ?? {};
  const [display, setDisplay] = useState<string>(d0.display_name ?? backend.id);
  const [category, setCategory] = useState<string>(d0.category ?? "Custom");
  const [description, setDescription] = useState<string>(d0.description ?? "");
  const [agents, setAgents] = useState<WAgent[]>(() => agentsFromData(d0));
  const [edges, setEdges] = useState<Edge[]>(() => edgesFromData(d0));
  const [selection, setSelection] = useState<Selection>({ kind: "team" });
  const [dirty, setDirty] = useState(false);
  const [catalogTab, setCatalogTab] = useState<"skills" | "tools">("skills");
  const [catalogQuery, setCatalogQuery] = useState("");
  const [showNotices, setShowNotices] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const builtIn = backend.built_in;

  const mark = () => setDirty(true);

  // role lookup (for tools / temp / dispatch defaults + the normalizer)
  const roleByName = useMemo(() => {
    const m = new Map<string, RoleData>();
    for (const r of roleDefs) {
      m.set(r.name, {
        name: r.name,
        description: r.description,
        systemPrompt: r.systemPrompt,
        canDispatch: r.canDispatch,
        defaultTemperature: r.temperature,
        toolAllowlist: Array.isArray(r.tools) ? r.tools : undefined,
      });
    }
    return m;
  }, [roleDefs]);
  const roleNames = useMemo(() => roleDefs.filter(r => !r.isSkill).map(r => r.name).sort(), [roleDefs]);
  const skillById = useMemo(() => new Map(skillPacks.map(p => [p.id, p])), [skillPacks]);

  // the team as the normalizer wants it (dispatch shape)
  const dispatchTeam: DispatchTeam = useMemo(() => ({
    id: backend.id,
    name: d0.name ?? backend.id,
    display, category, description,
    icon: d0.icon ?? "owl:owl_asssitant",
    agents: agents.map<DispatchAgentSpec>(a => ({
      name: a.name, base: a.base, icon: a.icon ?? undefined,
      description: a.description, extraPrompt: a.extraPrompt, extraSkills: a.extraSkills,
    })),
    edges,
  }), [backend.id, d0.name, d0.icon, display, category, description, agents, edges]);

  // live normalizer co-author — runs on every render of the working team
  const report = useMemo(() => normalizeTeam(dispatchTeam, roleByName), [dispatchTeam, roleByName]);
  const noticeCount = report.changes.length + report.warnings.length;

  const orch = useMemo(() => {
    // findOrchestrator semantics, mirrored locally for layout
    return (
      agents.find(a => a.name === "orchestrator") ??
      agents.find(a => a.base === "orchestrator") ??
      agents.find(a => roleByName.get(a.base)?.canDispatch) ??
      agents.find(a => /\borchestrator\b/i.test(`${a.name} ${a.base}`)) ??
      null
    );
  }, [agents, roleByName]);
  const orchName = orch?.name ?? null;

  const tiers = useMemo(() => computeTiers(agents, edges, orchName), [agents, edges, orchName]);
  const rows = useMemo(() => {
    let mx = 0; tiers.forEach(v => { mx = Math.max(mx, v); }); return mx + 1;
  }, [tiers]);
  // group agents by tier for x-positioning
  const tierGroups = useMemo(() => {
    const g = new Map<number, string[]>();
    for (const a of agents) {
      const t = tiers.get(a.name) ?? 0;
      if (!g.has(t)) g.set(t, []);
      g.get(t)!.push(a.name);
    }
    return g;
  }, [agents, tiers]);
  const nodePos = useMemo(() => {
    const pos = new Map<string, { x: number; y: number }>();
    tierGroups.forEach((names, t) => {
      names.forEach((n, i) => {
        pos.set(n, { x: ((i + 1) / (names.length + 1)) * 100, y: ((t + 0.5) / rows) * 100 });
      });
    });
    return pos;
  }, [tierGroups, rows]);

  // ---- mutations ----
  const patchAgent = (name: string, patch: Partial<WAgent>) => {
    setAgents(as => as.map(a => (a.name === name ? { ...a, ...patch } : a)));
    mark();
  };
  const renameAgent = (oldName: string, newName: string) => {
    const nn = newName.trim();
    if (!nn || nn === oldName) return;
    setAgents(as => as.map(a => (a.name === oldName ? { ...a, name: nn } : a)));
    setEdges(es => es.map(e => ({
      source: e.source === oldName ? nn : e.source,
      target: e.target === oldName ? nn : e.target,
    })));
    if (selection.kind === "agent" && selection.name === oldName) setSelection({ kind: "agent", name: nn });
    mark();
  };
  const removeAgent = (name: string) => {
    setAgents(as => as.filter(a => a.name !== name));
    setEdges(es => es.filter(e => e.source !== name && e.target !== name));
    setConfirmRemove(null);
    setSelection({ kind: "team" });
    mark();
  };
  const addAgent = (base: string) => {
    // unique name from the base; the normalizer will offer to wire it.
    let n = base, i = 2;
    const taken = new Set(agents.map(a => a.name));
    while (taken.has(n)) n = `${base}_${i++}`;
    const role = roleByName.get(base);
    setAgents(as => [...as, {
      name: n, base, icon: null, description: role?.description ?? "",
      extraPrompt: "", extraSkills: [], temperature: undefined, canDispatch: role?.canDispatch, orig: {},
    }]);
    setSelection({ kind: "agent", name: n });
    setAddOpen(false);
    mark();
  };
  const equipSkill = (agentName: string, skillId: string) => {
    setAgents(as => as.map(a => {
      if (a.name !== agentName) return a;
      if (a.extraSkills.includes(skillId)) return a;
      return { ...a, extraSkills: [...a.extraSkills, skillId] };
    }));
    mark();
  };
  const unequipSkill = (agentName: string, skillId: string) => {
    setAgents(as => as.map(a => (a.name === agentName ? { ...a, extraSkills: a.extraSkills.filter(s => s !== skillId) } : a)));
    mark();
  };
  const removeEdge = (source: string, target: string) => {
    setEdges(es => es.filter(e => !(e.source === source && e.target === target)));
    setSelection({ kind: "team" });
    mark();
  };
  const swapEdge = (source: string, target: string) => {
    setEdges(es => es.map(e => (e.source === source && e.target === target ? { source: target, target: source } : e)));
    setSelection({ kind: "edge", source: target, target: source });
    mark();
  };
  const applyAutoWire = () => {
    // apply exactly what the normalizer would: take its normalized edges
    setEdges(report.team.edges);
    mark();
  };

  // ---- save ----
  const doSave = async () => {
    setSaving(true);
    setSaveErr(null);
    try {
      // Normalize once at save for idempotency (wires orphans, drops dead edges).
      const normalized = normalizeTeam(dispatchTeam, roleByName).team;
      const data: any = JSON.parse(JSON.stringify(backend.data ?? {}));
      data.display_name = display.trim() || backend.id;
      data.category = category.trim() || "Custom";
      data.description = description.trim();
      data.agents = agents.map(a => {
        const out: any = { ...(a.orig ?? {}) };
        out.name = a.name.trim();
        out.base = a.base;
        if (a.icon) out.icon = a.icon; else delete out.icon;
        if (a.description?.trim()) out.description = a.description.trim(); else delete out.description;
        if (a.extraPrompt?.trim()) out.extra_prompt = a.extraPrompt; else delete out.extra_prompt;
        if (a.extraSkills.length) out.extra_skills = a.extraSkills; else delete out.extra_skills;
        if (a.modelId?.trim()) out.default_model_id = a.modelId.trim(); else delete out.default_model_id;
        if (a.temperature != null) out.default_temperature = a.temperature; else delete out.default_temperature;
        if (a.canDispatch) out.can_dispatch = true; else delete out.can_dispatch;
        return out;
      });
      data.graph = { ...(data.graph ?? {}), edges: normalized.edges };
      if (!data.icon) data.icon = "owl:owl_asssitant";

      let fileStem = backend.id;
      if (builtIn) {
        // built-ins are read-only on disk — Save creates a custom copy.
        const copyName = `${display.trim() || backend.id} copy`;
        data.display_name = copyName;
        delete data.visibility;
        delete data.workflow_rank;
        fileStem = copyName;
      }
      const saved = await invoke<TeamTemplateBackend>("save_team_template", { fileStem, data });
      invoke("vault_sync_teams").catch(() => {});
      setDirty(false);
      onSaved((saved.data?.name ?? saved.id) as string);
    } catch (e: any) {
      setSaveErr(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  const selectedAgent = selection.kind === "agent" ? agents.find(a => a.name === selection.name) ?? null : null;

  // ---- styles ----
  const card: React.CSSProperties = {
    background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 10,
  };
  const lbl: React.CSSProperties = { fontSize: 10, color: "var(--fg-muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 };
  const input: React.CSSProperties = {
    width: "100%", height: 30, borderRadius: 7, padding: "0 10px", fontSize: 12.5, boxSizing: "border-box",
    background: "var(--bg-input)", color: "var(--fg-strong)", border: "1px solid var(--border)",
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, gap: 8 }}>
      {/* ---- top bar ---- */}
      <div style={{ ...card, display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", flexWrap: "wrap" }}>
        <button onClick={onClose} title="Back to all teams"
          style={{ background: "var(--bg-elevated)", border: "1px solid var(--border-strong)", color: "var(--fg)", borderRadius: 8, height: 30, padding: "0 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
          ← Teams
        </button>
        <img src={owlSrc(d0.icon ?? "owl:owl_asssitant")} alt="" width={26} height={26} style={{ borderRadius: 6 }} />
        <button onClick={() => setSelection({ kind: "team" })}
          title="Edit team identity"
          style={{ background: "none", border: "none", color: "var(--fg-strong)", fontSize: 16, fontWeight: 800, cursor: "pointer", padding: 0 }}>
          {display || backend.id}
        </button>
        {builtIn && <span style={{ fontSize: 10, color: "#ffd97a", border: "1px solid rgba(255,217,122,0.4)", background: "rgba(255,217,122,0.1)", borderRadius: 999, padding: "1px 7px", fontWeight: 700 }}>built-in · Save makes a copy</span>}
        <div style={{ flex: 1 }} />
        {noticeCount > 0 && (
          <button onClick={() => setShowNotices(v => !v)} title="Configuration notices from the team normalizer"
            style={{ background: report.warnings.length ? "rgba(255,200,80,0.12)" : "rgba(108,210,142,0.12)",
              border: `1px solid ${report.warnings.length ? "rgba(255,200,80,0.45)" : "rgba(108,210,142,0.4)"}`,
              color: report.warnings.length ? "#ffd97a" : "#9ee6b0", borderRadius: 999, height: 28, padding: "0 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>
            ◇ Notices ({noticeCount})
          </button>
        )}
        {dirty && <span style={{ fontSize: 11, color: "#ffcaa8", fontWeight: 700 }}>• unsaved</span>}
        <button onClick={doSave} disabled={saving}
          style={{ background: "linear-gradient(180deg, color-mix(in srgb, var(--accent) 88%, #fff), var(--accent))", color: "var(--accent-fg)", border: "none", borderRadius: 8, height: 30, padding: "0 18px", fontSize: 12.5, fontWeight: 800, cursor: saving ? "wait" : "pointer" }}>
          {saving ? "Saving…" : builtIn ? "Save as copy" : "Save"}
        </button>
      </div>
      {saveErr && <div style={{ color: "#ff8c8c", fontSize: 12, padding: "0 4px" }}>Save failed: {saveErr}</div>}

      {/* ---- notices drawer ---- */}
      {showNotices && noticeCount > 0 && (
        <div style={{ ...card, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
          {report.changes.map((c, i) => (
            <div key={`c${i}`} style={{ fontSize: 12, color: "#9ee6b0", display: "flex", gap: 8 }}>
              <span>✓ done for you:</span><span style={{ color: "var(--fg)" }}>{c}</span>
            </div>
          ))}
          {report.warnings.map((w, i) => (
            <div key={`w${i}`} style={{ fontSize: 12, color: "#ffd97a", display: "flex", gap: 8 }}>
              <span>⚠ review:</span><span style={{ color: "var(--fg)" }}>{w}</span>
            </div>
          ))}
          {report.changes.length > 0 && (
            <button onClick={applyAutoWire} style={{ alignSelf: "flex-start", marginTop: 2, background: "rgba(108,210,142,0.14)", border: "1px solid rgba(108,210,142,0.4)", color: "#9ee6b0", borderRadius: 7, height: 26, padding: "0 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
              Apply auto-fixes now
            </button>
          )}
        </div>
      )}

      {/* ---- 3 panes ---- */}
      <div style={{ flex: 1, display: "flex", gap: 10, minHeight: 0 }}>
        {/* LEFT — roster bench */}
        <div style={{ flex: 3, display: "flex", flexDirection: "column", gap: 8, minWidth: 0, overflow: "auto" }}>
          <div style={lbl}>Roster · loadout</div>
          {agents.map(a => {
            const role = roleByName.get(a.base);
            const toolN = role?.toolAllowlist?.length;
            const toolLabel = toolN == null ? "all" : String(toolN);
            const ctx = a.extraSkills.reduce((s, id) => s + ctxEstimate(skillById.get(id)?.body), 0);
            const sel = selection.kind === "agent" && selection.name === a.name;
            const isOrch = a.name === orchName;
            const warn = report.warnings.some(w => w.includes(`"${a.name}"`));
            return (
              <button key={a.name} onClick={() => setSelection({ kind: "agent", name: a.name })}
                style={{ ...card, textAlign: "left", cursor: "pointer", padding: "8px 10px", display: "flex", gap: 9, alignItems: "center",
                  borderColor: sel ? "var(--accent)" : warn ? "rgba(255,200,80,0.5)" : "var(--border)",
                  boxShadow: sel ? "0 0 0 1px var(--accent)" : undefined,
                  background: sel ? "rgba(var(--accent-rgb),0.08)" : "var(--bg-surface)" }}>
                <img src={owlSrc(resolveAgentIcon(a.icon, a.base))} alt="" width={30} height={30} style={{ borderRadius: 7, flexShrink: 0 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg-strong)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {displayLabel(a.name)} {isOrch && <span style={{ fontSize: 9, color: ACCENT }}>◆ orch</span>}
                  </div>
                  <div style={{ fontSize: 10.5, color: "var(--fg-muted)", display: "flex", gap: 8, marginTop: 2 }}>
                    <span title="tools (from role)">⚙ {toolLabel}</span>
                    <span title="skills equipped">📚 {a.extraSkills.length}</span>
                    {ctx > 0 && <span title="equipped skill context" style={{ color: ctx > 6000 ? "#ffd97a" : "var(--fg-subtle)" }}>{kLabel(ctx)} ctx</span>}
                  </div>
                </div>
                {warn && <span title="see notices" style={{ color: "#ffd97a", fontSize: 13 }}>⚠</span>}
              </button>
            );
          })}
          {addOpen ? (
            <div style={{ ...card, padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={lbl}>Add agent from role</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 180, overflow: "auto" }}>
                {roleNames.map(r => (
                  <button key={r} onClick={() => addAgent(r)}
                    style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--fg)", borderRadius: 7, padding: "4px 9px", fontSize: 11.5, cursor: "pointer" }}>
                    {displayLabel(r)}
                  </button>
                ))}
              </div>
              <button onClick={() => setAddOpen(false)} style={{ alignSelf: "flex-start", background: "none", border: "none", color: "var(--fg-muted)", fontSize: 11, cursor: "pointer" }}>cancel</button>
            </div>
          ) : (
            <button onClick={() => setAddOpen(true)}
              style={{ alignSelf: "stretch", height: 32, borderRadius: 8, border: "1px dashed var(--border-strong)", background: "transparent", color: "var(--fg)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
              + add agent
            </button>
          )}
        </div>

        {/* CENTER — derived graph + catalog */}
        <div style={{ flex: 5, display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
          {/* derived graph */}
          <div style={{ ...card, position: "relative", height: Math.max(150, rows * 78), overflow: "hidden", flexShrink: 0 }}>
            <div style={{ ...lbl, position: "absolute", top: 6, left: 10, zIndex: 2 }}>Derived graph · click a node</div>
            <svg width="100%" height="100%" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
              <defs>
                <marker id="wb-arrow" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto">
                  <path d="M0,0 L7,3 L0,6 Z" fill="rgba(150,160,180,0.7)" />
                </marker>
              </defs>
              {edges.map((e, i) => {
                const s = nodePos.get(e.source), t = nodePos.get(e.target);
                if (!s || !t) return null;
                const selEdge = selection.kind === "edge" && selection.source === e.source && selection.target === e.target;
                return (
                  <line key={i} x1={`${s.x}%`} y1={`${s.y}%`} x2={`${t.x}%`} y2={`${t.y}%`}
                    stroke={selEdge ? "var(--accent)" : "rgba(150,160,180,0.55)"} strokeWidth={selEdge ? 2.5 : 1.5}
                    markerEnd="url(#wb-arrow)" style={{ pointerEvents: "stroke", cursor: "pointer" }}
                    onClick={() => setSelection({ kind: "edge", source: e.source, target: e.target })} />
                );
              })}
            </svg>
            {agents.map(a => {
              const p = nodePos.get(a.name); if (!p) return null;
              const isOrch = a.name === orchName;
              const sel = selection.kind === "agent" && selection.name === a.name;
              const unreach = (tiers.get(a.name) ?? 0) === rows - 1 && !isOrch && rows > 1 && report.changes.some(c => c.includes(`→ ${a.name}`));
              return (
                <button key={a.name} onClick={() => setSelection({ kind: "agent", name: a.name })}
                  title={a.name}
                  style={{ position: "absolute", left: `${p.x}%`, top: `${p.y}%`, transform: "translate(-50%,-50%)", zIndex: 2,
                    display: "flex", alignItems: "center", gap: 5, cursor: "pointer",
                    background: sel ? "rgba(var(--accent-rgb),0.18)" : isOrch ? "rgba(var(--accent-rgb),0.12)" : "var(--bg-elevated)",
                    border: `1.5px solid ${sel ? "var(--accent)" : unreach ? "#ffd97a" : isOrch ? "var(--accent)" : "var(--border-strong)"}`,
                    borderRadius: 999, padding: "3px 10px 3px 4px", maxWidth: "44%" }}>
                  <img src={owlSrc(resolveAgentIcon(a.icon, a.base))} alt="" width={20} height={20} style={{ borderRadius: 5 }} />
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--fg-strong)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{displayLabel(a.name)}</span>
                  {a.extraSkills.length > 0 && <span style={{ fontSize: 9, color: "#9ee6b0" }}>📚{a.extraSkills.length}</span>}
                </button>
              );
            })}
          </div>

          {/* catalog */}
          <div style={{ ...card, flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
              {(["skills", "tools"] as const).map(t => (
                <button key={t} onClick={() => setCatalogTab(t)}
                  style={{ background: catalogTab === t ? "rgba(var(--accent-rgb),0.14)" : "transparent",
                    border: catalogTab === t ? "1px solid var(--accent)" : "1px solid var(--border)",
                    color: catalogTab === t ? "var(--fg-strong)" : "var(--fg-muted)", borderRadius: 7, height: 26, padding: "0 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", textTransform: "capitalize" }}>
                  {t === "skills" ? "📚 Skills" : "⚙ Tools"}
                </button>
              ))}
              <input value={catalogQuery} onChange={e => setCatalogQuery(e.target.value)} placeholder="Search…"
                style={{ ...input, height: 26, flex: 1, maxWidth: 220 }} />
              <div style={{ flex: 1 }} />
              {!selectedAgent && <span style={{ fontSize: 11, color: "var(--fg-subtle)", fontStyle: "italic" }}>select an agent to equip</span>}
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: 10 }}>
              {catalogTab === "skills" ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 8 }}>
                  {skillPacks.filter(p => {
                    const q = catalogQuery.trim().toLowerCase();
                    return !q || skillName(p).toLowerCase().includes(q) || skillDesc(p).toLowerCase().includes(q);
                  }).map(p => {
                    const equipped = !!selectedAgent && selectedAgent.extraSkills.includes(p.id);
                    return (
                      <div key={p.id} style={{ ...card, background: "var(--bg-elevated)", padding: "8px 9px", display: "flex", flexDirection: "column", gap: 5,
                        borderColor: equipped ? SKILL_GREEN : "var(--border)" }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--fg-strong)", display: "flex", alignItems: "center", gap: 5 }}>
                          <span>📚</span><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{skillName(p)}</span>
                        </div>
                        <div style={{ fontSize: 10.5, color: "var(--fg-muted)", lineHeight: 1.35, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                          {skillDesc(p) || "—"}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 2 }}>
                          <span style={{ fontSize: 9.5, color: "var(--fg-subtle)" }}>{kLabel(ctxEstimate(p.body))} ctx</span>
                          <button disabled={!selectedAgent || equipped}
                            onClick={() => selectedAgent && equipSkill(selectedAgent.name, p.id)}
                            style={{ background: equipped ? "transparent" : SKILL_GREEN_BG, border: `1px solid ${SKILL_GREEN}`,
                              color: equipped ? "var(--fg-subtle)" : "#9ee6b0", borderRadius: 6, height: 22, padding: "0 9px", fontSize: 10.5, fontWeight: 700,
                              cursor: !selectedAgent || equipped ? "default" : "pointer", opacity: !selectedAgent ? 0.5 : 1 }}>
                            {equipped ? "equipped" : "+ equip"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {skillPacks.length === 0 && <div style={{ gridColumn: "1/-1", fontSize: 12, color: "var(--fg-subtle)", fontStyle: "italic" }}>No skills installed yet.</div>}
                  <button onClick={onOpenSkillLibrary}
                    style={{ ...card, background: "transparent", border: "1px dashed var(--border-strong)", color: "var(--fg)", minHeight: 70, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                    ＋ Get more skills…
                  </button>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.6 }}>
                  Tools are inherited from each agent's <b>role</b> (cheap, one function each) and shown read-only in the Inspector.
                  Per-agent tool grants beyond the role are a project-level setting on the Agents page.
                  {selectedAgent && (() => {
                    const t = roleByName.get(selectedAgent.base)?.toolAllowlist;
                    return (
                      <div style={{ marginTop: 8 }}>
                        <div style={lbl}>{displayLabel(selectedAgent.name)} · role '{selectedAgent.base}' tools</div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 5 }}>
                          {!t || t.length === 0 ? <span style={{ fontSize: 11, color: "var(--fg-subtle)" }}>all builtins</span>
                            : t.filter(x => !catalogQuery || x.toLowerCase().includes(catalogQuery.toLowerCase())).map(x => (
                              <span key={x} style={{ fontSize: 11, background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 6, padding: "2px 7px", color: "var(--fg)" }}>⚙ {x}</span>
                            ))}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* RIGHT — inspector */}
        <div style={{ flex: 4, display: "flex", flexDirection: "column", minWidth: 0, overflow: "auto" }}>
          <div key={selection.kind === "agent" ? selection.name : selection.kind} style={{ ...card, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            {selection.kind === "team" && (
              <>
                <div style={{ fontSize: 13, fontWeight: 800, color: "var(--fg-strong)" }}>Team</div>
                <div><div style={lbl}>Name</div><input style={input} value={display} onChange={e => { setDisplay(e.target.value); mark(); }} /></div>
                <div><div style={lbl}>Category</div><input style={input} value={category} onChange={e => { setCategory(e.target.value); mark(); }} /></div>
                <div><div style={lbl}>Description</div>
                  <textarea value={description} onChange={e => { setDescription(e.target.value); mark(); }} rows={3}
                    style={{ ...input, height: "auto", padding: "8px 10px", fontFamily: "inherit", resize: "vertical" }} />
                </div>
                <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                  <div style={lbl}>Normalizer report</div>
                  {noticeCount === 0 ? (
                    <div style={{ fontSize: 12, color: "#9ee6b0", marginTop: 4 }}>✓ Structurally valid — every agent reachable, all bases resolve.</div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 5 }}>
                      {report.changes.map((c, i) => <div key={i} style={{ fontSize: 11.5, color: "#9ee6b0" }}>✓ {c}</div>)}
                      {report.warnings.map((w, i) => <div key={i} style={{ fontSize: 11.5, color: "#ffd97a" }}>⚠ {w}</div>)}
                    </div>
                  )}
                </div>
              </>
            )}

            {selection.kind === "edge" && (
              <>
                <div style={{ fontSize: 13, fontWeight: 800, color: "var(--fg-strong)" }}>Connection</div>
                <div style={{ fontSize: 13, color: "var(--fg)", textAlign: "center", padding: "8px 0" }}>
                  {displayLabel(selection.source)} <span style={{ color: ACCENT }}>→</span> {displayLabel(selection.target)}
                </div>
                <div style={{ fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.5 }}>
                  This arrow lets <b>{displayLabel(selection.source)}</b> dispatch to (or hand output to) <b>{displayLabel(selection.target)}</b>.
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => swapEdge(selection.source, selection.target)}
                    style={{ flex: 1, height: 30, borderRadius: 7, border: "1px solid var(--border-strong)", background: "var(--bg-elevated)", color: "var(--fg)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>⇄ Swap direction</button>
                  <button onClick={() => removeEdge(selection.source, selection.target)}
                    style={{ flex: 1, height: 30, borderRadius: 7, border: "none", background: "rgba(255,140,140,0.12)", color: "#ff8c8c", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Remove</button>
                </div>
              </>
            )}

            {selection.kind === "agent" && selectedAgent && (() => {
              const a = selectedAgent;
              const role = roleByName.get(a.base);
              const roleTools = role?.toolAllowlist;
              const ctx = a.extraSkills.reduce((s, id) => s + ctxEstimate(skillById.get(id)?.body), 0);
              const budgetPct = Math.min(100, (ctx / 8000) * 100);
              return (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <img src={owlSrc(resolveAgentIcon(a.icon, a.base))} alt="" width={28} height={28} style={{ borderRadius: 7 }} />
                    {/* uncontrolled + key so typing works and the field resets
                        to the new defaultValue when the selection changes. */}
                    <input style={{ ...input, fontWeight: 700 }} key={`name-${a.name}`} defaultValue={a.name}
                      onBlur={e => renameAgent(a.name, e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <div><div style={lbl}>Role base</div>
                      <select style={{ ...input, height: 30 }} value={a.base} onChange={e => patchAgent(a.name, { base: e.target.value })}>
                        {roleNames.map(r => <option key={r} value={r}>{r}</option>)}
                        {!roleNames.includes(a.base) && <option value={a.base}>{a.base}</option>}
                      </select>
                    </div>
                    <div><div style={lbl}>Temp</div>
                      <input type="number" step={0.05} min={0} max={1.5} style={input}
                        value={a.temperature ?? ""} placeholder={role?.defaultTemperature != null ? String(role.defaultTemperature) : "auto"}
                        onChange={e => patchAgent(a.name, { temperature: e.target.value === "" ? undefined : Number(e.target.value) })} />
                    </div>
                  </div>
                  <div><div style={lbl}>Model</div>
                    <ModelPicker value={a.modelId ?? ""} onChange={id => patchAgent(a.name, { modelId: id })}
                      models={models} status={accountsStatus} fallbackLabel="(Auto · per-task selection)" />
                  </div>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--fg)", cursor: "pointer" }}>
                    <input type="checkbox" checked={!!a.canDispatch} onChange={e => patchAgent(a.name, { canDispatch: e.target.checked })} />
                    can dispatch (acts as an orchestrator)
                  </label>

                  {/* TOOLS — cheap, role-inherited, read-only */}
                  <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                    <div style={lbl}>Tools · inherited from role '{a.base}'</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 5 }}>
                      {!roleTools || roleTools.length === 0
                        ? <span style={{ fontSize: 11, color: "var(--fg-subtle)" }}>all builtins</span>
                        : roleTools.map(t => <span key={t} style={{ fontSize: 10.5, background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 6, padding: "2px 7px", color: "var(--fg)" }}>⚙ {t}</span>)}
                    </div>
                  </div>

                  {/* SKILLS — heavy, equipped, costed */}
                  <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8, borderLeft: `3px solid ${SKILL_GREEN}`, paddingLeft: 9, marginLeft: -1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={lbl}>📚 Skills · loaded on demand</div>
                      <span style={{ fontSize: 10, color: ctx > 6000 ? "#ffd97a" : "var(--fg-subtle)" }}>Σ {a.extraSkills.length} · {kLabel(ctx)}</span>
                    </div>
                    {a.extraSkills.length > 0 && (
                      <div style={{ height: 4, borderRadius: 3, background: "var(--bg-elevated)", marginTop: 6, overflow: "hidden" }}>
                        <div style={{ width: `${budgetPct}%`, height: "100%", background: ctx > 6000 ? "#ffd97a" : "#6cd28e" }} />
                      </div>
                    )}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 7 }}>
                      {a.extraSkills.map(id => {
                        const p = skillById.get(id);
                        return (
                          <span key={id} title={p ? skillDesc(p) : id}
                            style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, background: SKILL_GREEN_BG, border: `1px solid ${SKILL_GREEN}`, borderRadius: 999, padding: "2px 4px 2px 8px", color: "var(--fg)" }}>
                            📚 {p ? skillName(p) : id}
                            {p && <span style={{ fontSize: 9, color: "var(--fg-subtle)" }}>{kLabel(ctxEstimate(p.body))}</span>}
                            <button onClick={() => unequipSkill(a.name, id)} title="Unequip"
                              style={{ background: "none", border: "none", color: "#ff8c8c", cursor: "pointer", fontSize: 11, lineHeight: 1, padding: "0 2px" }}>✕</button>
                          </span>
                        );
                      })}
                      {a.extraSkills.length === 0 && <span style={{ fontSize: 11, color: "var(--fg-subtle)", fontStyle: "italic" }}>none — equip from the catalog ◂</span>}
                    </div>
                  </div>

                  {/* extra prompt (collapsible) */}
                  <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                    <button onClick={() => setPromptOpen(v => !v)} style={{ background: "none", border: "none", color: "var(--fg-muted)", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, cursor: "pointer", padding: 0 }}>
                      {promptOpen ? "▾" : "▸"} Extra instructions (appended to role prompt)
                    </button>
                    {promptOpen && (
                      <textarea value={a.extraPrompt ?? ""} onChange={e => patchAgent(a.name, { extraPrompt: e.target.value })} rows={4}
                        placeholder="Optional — refines the base role for this team."
                        style={{ ...input, height: "auto", marginTop: 6, padding: "8px 10px", fontFamily: "inherit", resize: "vertical" }} />
                    )}
                  </div>

                  {/* remove */}
                  <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                    {confirmRemove === a.name ? (
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span style={{ fontSize: 12, color: "var(--fg)" }}>Remove {displayLabel(a.name)}?</span>
                        <button onClick={() => removeAgent(a.name)} style={{ height: 26, borderRadius: 6, border: "none", background: "rgba(255,140,140,0.18)", color: "#ff8c8c", fontSize: 11.5, fontWeight: 700, padding: "0 10px", cursor: "pointer" }}>Remove</button>
                        <button onClick={() => setConfirmRemove(null)} style={{ height: 26, borderRadius: 6, border: "1px solid var(--border-strong)", background: "var(--bg-elevated)", color: "var(--fg)", fontSize: 11.5, padding: "0 10px", cursor: "pointer" }}>Keep</button>
                      </div>
                    ) : (
                      <button onClick={() => setConfirmRemove(a.name)} style={{ background: "none", border: "none", color: "#ff8c8c", fontSize: 11.5, cursor: "pointer", padding: 0 }}>Remove agent</button>
                    )}
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}
