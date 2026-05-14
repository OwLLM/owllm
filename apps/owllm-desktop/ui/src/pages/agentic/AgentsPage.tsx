// AgentsPage — agentic tab body. Frame + header + tabs come from
// AppShell. Layout: location strip, goal row, then the workspace
// (canvas + cards + orchestrator pane).
//
// All data is live: projects from list_projects (legacy SQLite), team
// templates + role definitions from agents.rs, bridge config from
// bridges.rs, server state via server_status. No hardcoded rosters.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import NewProjectDialog from "./NewProjectDialog";

const ICONS = "/Page_icons";

// ---------- Backend shapes ----------
type ProjectRow = {
  id: string; name: string; description: string; location: string;
  trust_writes: boolean; auto_approve_all: boolean;
  team: string[]; team_default_model_id: string;
  /// Routing graph blob — `{"edges": [{"source":"x","target":"y"}]}`.
  /// Empty string when the project hasn't customised routing yet.
  graph_json: string;
  updated_at: string;
};
type TeamTemplateBackend = { id: string; path: string; built_in: boolean; data: any };
type AgentRoleBackend    = { id: string; path: string; built_in: boolean; data: any };
type TelegramCfg = { bot_token: string; project_id: string; auto_approve?: boolean };
type WhatsAppCfg = { access_token: string; project_id: string; auto_approve?: boolean };
type BridgeConfigs = { telegram: TelegramCfg; whatsapp: WhatsAppCfg };
type ServerStatus = { running: boolean; model_id: string | null; port: number | null; message: string };

// ---------- Domain types ----------
type AgentSpec = {
  name: string;
  base: string;
  icon?: string | null;
  // The team JSON ships rich per-agent text — a short description
  // shown in cards and a longer extra_prompt that augments the role's
  // base system prompt during dispatch. Keep both around so the
  // specialist prompt builder can layer them.
  description?: string;
  extraPrompt?: string;
};
type Edge = { source: string; target: string };
type Team = {
  id: string;
  name: string;
  display: string;
  category: string;
  description: string;
  icon: string;
  agents: AgentSpec[];
  edges: Edge[];
};
type RoleData = {
  name: string;
  icon?: string;
  description?: string;
  /// Canonical role system prompt from the yaml file (the `|` block
  /// scalar that defines the agent's behaviour rules). Used by the
  /// specialist prompt builder during dispatch.
  systemPrompt?: string;
  /// Whether this role is allowed to dispatch (from `can_dispatch`).
  canDispatch?: boolean;
  /// Default sampling temperature from the yaml; used by the dispatch
  /// loop when an agent has no per-agent override.
  defaultTemperature?: number;
};
type GoalMsg = { role: string; color: string; text: string };

// ---------- Icon + label helpers ----------
// A handful of owl icons live in /Page_icons/ at the top level rather
// than in the /Page_icons/Agents/ subdir (used for team/category
// avatars). The "owl:" scheme is ambiguous — match the file location
// rather than guessing the wrong subdir.
const TOPLEVEL_OWLS = new Set([
  "owl_agentic", "owl_AgenticTeam", "owl_FineTuning", "owl_FineTuning2",
  "owl_Gamifier", "owl_Gamify", "owl_chat", "owl_chat2", "owl_chat3",
  "owl_coding", "owl_coding2", "owl_defence", "owl_download",
  "owl_llm_studio_transparent", "owl_models", "owl_ready", "owl_server",
  "owl_sleeping", "owl_startup", "owl_startup1", "owl_studio_square",
  "owl_studio_square1", "owl_thunder", "owl_tools", "owl_training",
]);
function owlSrc(iconRef?: string | null): string {
  if (!iconRef) return `${ICONS}/Agents/owl_asssitant.png`;
  if (iconRef.startsWith("owl:")) {
    const name = iconRef.slice(4);
    if (TOPLEVEL_OWLS.has(name)) return `${ICONS}/${name}.png`;
    return `${ICONS}/Agents/${name}.png`;
  }
  if (iconRef.startsWith("/")) return iconRef;
  return `${ICONS}/${iconRef}`;
}
// Base-role → default owl icon. Mirrors apply_to_label fallback when
// an agent spec has no explicit `icon`.
const BASE_OWL: Record<string, string> = {
  orchestrator:  "owl:owl_orchestrator1",
  coder:         "owl:owl_coder",
  critic:        "owl:owl_critic",
  researcher:    "owl:owl_researcher",
  operator:      "owl:owl_operator",
  documentation: "owl:owl_documentation",
  devops:        "owl:owl_SSH",
  webapp:        "owl:owl_webapp",
  assistant:     "owl:owl_asssitant",
};
function agentIconRef(spec: AgentSpec, roleByName: Map<string, RoleData>): string {
  if (spec.icon) return spec.icon;
  const role = roleByName.get(spec.base);
  if (role?.icon) return role.icon;
  if (BASE_OWL[spec.base]) return BASE_OWL[spec.base];
  return "owl:owl_asssitant";
}

const _ACRONYMS = new Set(["ux","ui","api","mcp","gpu","be","fe","qa","cli","sql","db"]);
function displayLabel(fullName: string): string {
  const short = fullName.includes(".") ? fullName.split(".").pop()! : fullName;
  if (!short) return fullName;
  const words: string[] = [];
  for (const raw of short.replace(/-/g, "_").split("_")) {
    const w = raw.trim();
    if (!w) continue;
    words.push(_ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1));
  }
  return words.join(" ") || fullName;
}

function toTeam(t: TeamTemplateBackend): Team {
  const d = t.data ?? {};
  const agents: AgentSpec[] = Array.isArray(d.agents)
    ? d.agents.map((a: any) => ({
        name: a.name,
        base: a.base,
        icon: a.icon ?? null,
        description: typeof a.description === "string" ? a.description : undefined,
        // Qt source spells this `extra_prompt`; we expose it camel-case
        // on the React side so usage doesn't pierce snake_case.
        extraPrompt: typeof a.extra_prompt === "string" ? a.extra_prompt : undefined,
      }))
    : [];
  const edges: Edge[] = Array.isArray(d.graph?.edges) ? d.graph.edges : [];
  return {
    id: t.id,
    name: d.name ?? t.id,
    display: d.display_name ?? t.id,
    category: d.category ?? "Other",
    icon: d.icon ?? "owl:owl_agentic",
    description: d.description ?? "",
    agents,
    edges,
  };
}

// Build a virtual Team from a project's raw agent-name list. If the
// project has a stored routing graph (graph_json), parse it; otherwise
// the diagram/graph view falls back to the star topology computed in
// computeDepths().
function projectToTeam(p: ProjectRow): Team {
  const agents: AgentSpec[] = p.team.map(n => ({ name: n, base: n }));
  let edges: Edge[] = [];
  if (p.graph_json && p.graph_json.trim().length > 0) {
    try {
      const parsed = JSON.parse(p.graph_json);
      if (Array.isArray(parsed?.edges)) {
        edges = parsed.edges
          .filter((e: any) => typeof e?.source === "string" && typeof e?.target === "string")
          .map((e: any) => ({ source: e.source, target: e.target }));
      }
    } catch {
      // Stale graph_json — silently fall back to empty.
    }
  }
  return {
    id: `project:${p.id}`,
    name: p.name,
    display: p.name,
    category: "Project",
    description: p.description || "Project — agents from the saved roster.",
    icon: "owl:owl_agentic",
    agents,
    edges,
  };
}

// BFS depth from orchestrator over the (undirected) routing graph.
// Returns depth=0 for the orchestrator, depth=1 for everyone if there
// are no edges. Unreachable agents land on max_depth+1.
function computeDepths(team: Team): Map<string, number> {
  const out = new Map<string, number>();
  if (!team.agents.length) return out;
  const orchName =
    team.agents.find(a => a.name === "orchestrator")?.name ??
    team.agents.find(a => a.base === "orchestrator")?.name ??
    team.agents[0].name;
  out.set(orchName, 0);
  if (team.edges.length === 0) {
    for (const a of team.agents) if (a.name !== orchName) out.set(a.name, 1);
    return out;
  }
  const adj = new Map<string, Set<string>>();
  for (const a of team.agents) adj.set(a.name, new Set());
  for (const e of team.edges) {
    adj.get(e.source)?.add(e.target);
    adj.get(e.target)?.add(e.source);
  }
  const queue: string[] = [orchName];
  while (queue.length) {
    const u = queue.shift()!;
    const du = out.get(u)!;
    for (const v of adj.get(u) ?? []) {
      if (!out.has(v)) {
        out.set(v, du + 1);
        queue.push(v);
      }
    }
  }
  let maxKnown = 0;
  for (const d of out.values()) if (d > maxKnown) maxKnown = d;
  for (const a of team.agents) if (!out.has(a.name)) out.set(a.name, maxKnown + 1);
  return out;
}

// LocationRow — mirrors _build_project_strip in agents_page.py:2845-3029.
// Sandbox/Bridge badges reflect real state; Team… opens a template picker.
function LocationRow({
  projects, selectedId, onChangeProject,
  teams, pickedTeamId, onPickTeam,
  location, onChangeLocation, onBrowse,
  trustWrites, onToggleTrustWrites,
  bridgeOn,
  onNewProject, onRenameProject, onDeleteProject,
}: {
  projects: ProjectRow[];
  selectedId: string;
  onChangeProject: (id: string) => void;
  teams: Team[];
  pickedTeamId: string | null;
  onPickTeam: (id: string | null) => void;
  location: string;
  onChangeLocation: (v: string) => void;
  onBrowse: () => void;
  trustWrites: boolean;
  onToggleTrustWrites: () => void;
  bridgeOn: boolean;
  onNewProject: () => void;
  onRenameProject: () => void;
  onDeleteProject: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  // Sandbox semantics: trust_writes=true → agent writes are trusted
  // (NOT sandboxed); trust_writes=false → sandbox mode is on.
  const sandboxText  = trustWrites ? "⚠️ Direct writes" : "🟢 Sandboxed";
  const sandboxColor = trustWrites ? "#ffb56a" : "#5af09c";
  const sandboxBg    = trustWrites ? "#241a0e" : "#0e2418";
  const sandboxBorder= trustWrites ? "#5a3c2c" : "#2c5a3c";
  const bridgeText   = bridgeOn ? "📱 Bridge: ON" : "📱 Bridge: OFF";
  const bridgeColor  = bridgeOn ? "var(--accent)" : "#7d8595";
  const bridgeBg     = bridgeOn ? "#0a2230" : "#1a1f2a";
  const bridgeBorder = bridgeOn ? "#2a5060" : "#2a3148";
  return (
    <div data-ui="ProjectStrip" style={{ height:52, padding:"10px 14px", background:"linear-gradient(180deg, #1f2632, #181c29)", borderRadius:10, margin:"0 23px", display:"flex", alignItems:"center", gap:10, position:"relative" }}>
      <div data-ui="LocationLabel" style={{ display:"inline-flex", alignItems:"center", height:32, fontSize:11, color:"var(--fg-muted)", textTransform:"uppercase", letterSpacing:0.6, marginRight:4 }}>LOCATION</div>
      <input data-ui="LocationInput" value={location} onChange={e => onChangeLocation(e.target.value)} placeholder="/path/to/repo · esp-flash · github.com/me/x" style={{ flex:2, minWidth:240, height:32, borderRadius:8, padding:"0 12px", fontSize:13, background:"var(--bg-input)", color:"var(--fg-strong)", border:"1px solid var(--border)" }} />
      <button data-ui="LocationBrowseBtn" className="ghost-btn" onClick={onBrowse} title="Pick a project folder" style={{ height:32, width:79 }}>Browse…</button>
      <label data-ui="TrustWritesCheckbox" style={{ display:"inline-flex", alignItems:"center", fontSize:12, color:"var(--fg)", padding:"0 6px" }}>
        <input type="checkbox" checked={trustWrites} onChange={onToggleTrustWrites} style={{ marginRight:6, width:13, height:13, accentColor:"var(--accent)" }} />
        Trust writes
      </label>
      <span data-ui="SandboxBadge" style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", height:24, padding:"2px 8px", background:sandboxBg, color:sandboxColor, border:`1px solid ${sandboxBorder}`, borderRadius:6, fontSize:11, fontWeight:600, whiteSpace:"nowrap" }}>{sandboxText}</span>
      <span data-ui="BridgeBadge" style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", height:24, padding:"2px 8px", background:bridgeBg, color:bridgeColor, border:`1px solid ${bridgeBorder}`, borderRadius:6, fontSize:11, fontWeight:600, whiteSpace:"nowrap" }}>{bridgeText}</span>
      <span style={{ display:"inline-flex", alignItems:"center", height:32, padding:"0 12px", fontSize:11, color:"var(--fg-muted)", textTransform:"uppercase", letterSpacing:0.6 }}>Project</span>
      <select data-ui="ProjectCombo" value={selectedId} onChange={e => onChangeProject(e.target.value)} style={{ flex:2, minWidth:200, height:32, padding:"0 12px", borderRadius:8, border:"none", background:"var(--bg-input)", color:"var(--fg-strong)", fontSize:13 }}>
        {projects.length === 0
          ? <option value="">(no projects — create one in Studio)</option>
          : projects.map(p => (<option key={p.id} value={p.id}>{p.name}</option>))
        }
      </select>
      <button className="ghost-btn" onClick={() => setPickerOpen(v => !v)} style={{ height:32, padding:"0 12px" }} title="Pick a team template to display on the canvas">Team…</button>
      <button className="ghost-btn" onClick={onNewProject} title="Create a new project from a team template" style={{ height:32, padding:"0 12px" }}>+ New</button>
      <button className="ghost-btn" onClick={onRenameProject} title="Rename the selected project" disabled={!selectedId} style={{ height:32, padding:"0 12px" }}>Rename</button>
      <button onClick={onDeleteProject} title="Delete the selected project" disabled={!selectedId} style={{ height:32, padding:"0 12px", background: selectedId ? "rgba(255,140,140,0.10)" : "var(--bg-surface)", color: selectedId ? "#ff8c8c" : "var(--fg-subtle)", border:"none", borderRadius:8, fontSize:12, fontWeight:600, cursor: selectedId ? "pointer" : "not-allowed" }}>Delete</button>
      {pickerOpen && (
        <div style={{ position:"absolute", top:60, right:14, background:"var(--bg-panel)", border:"1px solid var(--border-strong)", borderRadius:10, padding:8, zIndex:50, maxHeight:340, overflow:"auto", minWidth:280, boxShadow:"0 8px 30px rgba(0,0,0,0.6)" }}>
          <div style={{ fontSize:10, color:"var(--fg-muted)", letterSpacing:1, textTransform:"uppercase", padding:"6px 10px" }}>Team template</div>
          <button onClick={() => { onPickTeam(null); setPickerOpen(false); }} style={{ display:"block", width:"100%", textAlign:"left", padding:"8px 12px", border:"none", background: pickedTeamId === null ? "rgba(92,240,255,0.12)" : "transparent", color:"var(--fg)", fontSize:12, cursor:"pointer", borderRadius:6 }}>(use project roster)</button>
          {teams.map(t => (
            <button key={t.id} onClick={() => { onPickTeam(t.id); setPickerOpen(false); }} style={{ display:"flex", alignItems:"center", gap:8, width:"100%", textAlign:"left", padding:"8px 12px", border:"none", background: pickedTeamId === t.id ? "rgba(92,240,255,0.12)" : "transparent", color:"var(--fg)", fontSize:12, cursor:"pointer", borderRadius:6 }}>
              <img src={owlSrc(t.icon)} style={{ width:20, height:20, objectFit:"contain", flexShrink:0 }} />
              <div style={{ display:"flex", flexDirection:"column", minWidth:0, flex:1 }}>
                <span style={{ color:"var(--fg-strong)", fontWeight:600 }}>{t.display}</span>
                <span style={{ fontSize:10, color:"var(--fg-muted)" }}>{t.category.toUpperCase()} · {t.agents.length} agents</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// GoalRow — agents_page.py:1757-1910. 📎 attach, goal input, Run,
// Cancel, 📊 telemetry, 🔊 voice with ▾ menu caret.
function GoalRow({ goal, setGoal, onRun, onCancel, busy }: {
  goal: string; setGoal: (g: string) => void;
  onRun: () => void; onCancel: () => void; busy: boolean;
}) {
  return (
    <div style={{ height:38, padding:"0 23px", margin:"12px 0", background:"transparent", display:"flex", alignItems:"center", gap:10 }}>
      <button data-ui="GoalAttachBtn" title="Attach an image or audio file" style={{ height:38, minWidth:44, padding:"0 10px", border:"none", borderRadius:10, background:"var(--bg-surface)", color:"var(--fg)", fontSize:16 }}>📎</button>
      <input data-ui="GoalInput"
        value={goal}
        onChange={e => setGoal(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && !busy) onRun(); }}
        placeholder="Goal — e.g. 'summarise the last commit and propose a follow-up' (drop an image / audio here)"
        style={{ flex:1, height:38, borderRadius:10, padding:"0 14px", fontSize:13, background:"var(--bg-input)", color:"var(--fg-strong)", border:"none" }} />
      <button data-ui="GoalRunBtn" disabled={busy || !goal.trim()} onClick={onRun}
        style={{ height:38, padding:"0 24px", borderRadius:10, border:"none",
                 background: busy || !goal.trim() ? "rgba(74,108,255,0.25)" : "#4a6cff",
                 color: busy || !goal.trim() ? "#9aa0a6" : "#fff", fontWeight:600, fontSize:14,
                 cursor: busy || !goal.trim() ? "not-allowed" : "pointer" }}>
        {busy ? "Running…" : "Run"}
      </button>
      <button data-ui="GoalCancelBtn" disabled={!busy} onClick={onCancel}
        style={{ height:38, padding:"0 18px", borderRadius:10, border:"none",
                 background: busy ? "rgba(255,140,140,0.20)" : "rgba(255,140,140,0.10)",
                 color: busy ? "#ff8c8c" : "#555", fontWeight:600, fontSize:14,
                 cursor: busy ? "pointer" : "not-allowed" }}>Cancel</button>
      <button data-ui="GoalTelemetryBtn" title="Open the tool-call telemetry panel" style={{ height:38, width:44, padding:0, border:"none", borderRadius:8, background:"var(--bg-surface)", color:"var(--fg)", fontSize:16 }}>📊</button>
      <button data-ui="GoalVoiceBtn" title="Speak agent replies aloud — voice per agent. Click ▾ to switch engine." style={{ height:38, minWidth:64, padding:"0 6px", border:"none", borderRadius:8, background:"rgba(92,240,255,0.18)", color:"var(--accent)", fontSize:16, display:"inline-flex", alignItems:"center", justifyContent:"center", gap:4 }}>🔊<span style={{ fontSize:11, opacity:0.7 }}>▾</span></button>
    </div>
  );
}

// FlowHeader — canvas_header in agents_page.py:2540-2596.
// Action buttons operate on whichever edge is currently selected in
// the graph view. The view toggle flips between the orbital diagram
// and the editable graph (mirrors agents_page.py:_on_view_toggle).
function FlowHeader({
  viewMode, onToggleView,
  canEdit, onDeleteEdge, onReverseEdge, onResetLayout,
}: {
  viewMode: "diagram" | "graph"; onToggleView: () => void;
  canEdit: boolean;
  onDeleteEdge: () => void;
  onReverseEdge: () => void;
  onResetLayout: () => void;
}) {
  const toggleLabel = viewMode === "diagram" ? "◐ Graph view" : "◑ Diagram view";
  const toggleTitle = viewMode === "diagram"
    ? "Switch to the editable graph (top-down hierarchical layout)"
    : "Switch back to the live orbital diagram";
  return (
    <div style={{ display:"flex", alignItems:"center", padding:"6px 10px", gap:6, borderBottom:"1px solid var(--border)" }}>
      <div data-ui="FlowTitle" style={{ fontSize:16, fontWeight:700, color:"var(--fg-strong)", height:28, display:"flex", alignItems:"center", fontFamily:"Segoe UI", paddingRight:8 }}>Flow</div>
      <div style={{ flex:1 }} />
      <button
        data-ui="FlowDeleteEdgeBtn"
        className="ghost-btn"
        onClick={onDeleteEdge}
        disabled={!canEdit}
        title="Delete the selected edge (or press Delete)"
        style={{ height:28, padding:"0 8px", fontSize:11, opacity: canEdit ? 1 : 0.45, cursor: canEdit ? "pointer" : "not-allowed" }}
      >✕ Edge</button>
      <button
        data-ui="FlowReverseEdgeBtn"
        className="ghost-btn"
        onClick={onReverseEdge}
        disabled={!canEdit}
        title="Reverse the direction of the selected edge"
        style={{ height:28, padding:"0 8px", fontSize:11, opacity: canEdit ? 1 : 0.45, cursor: canEdit ? "pointer" : "not-allowed" }}
      >⇄ Reverse</button>
      <button
        data-ui="FlowLayoutBtn"
        className="ghost-btn"
        onClick={onResetLayout}
        title="Reset positions to the auto-layout (top-down hierarchical, orchestrator on top, then specialists in rows by dispatch distance)"
        style={{ height:28, padding:"0 8px", fontSize:11 }}
      >⟲ Layout</button>
      <button data-ui="FlowRefreshBtn" className="ghost-btn" title="Refresh model lists in every picker" style={{ height:28, width:30, padding:0, fontSize:11 }}>⟳</button>
      <button
        data-ui="FlowViewToggleBtn"
        className="ghost-btn"
        onClick={onToggleView}
        title={toggleTitle}
        style={{ height:28, padding:"0 8px", fontSize:11, background: viewMode === "graph" ? "rgba(120,220,255,0.18)" : undefined, color: viewMode === "graph" ? "var(--accent)" : undefined }}
      >{toggleLabel}</button>
    </div>
  );
}

// TeamInfoCard — agent_info_card.py:394-521. Driven by the active team.
function TeamInfoCard({ team }: { team: Team | null }) {
  const CARD_W = 320;
  const CARD_H = 264;
  if (!team) {
    return (
      <div data-ui="TeamInfoCard" style={{ width:CARD_W, height:CARD_H, borderRadius:12, background:"var(--bg-panel)", border:"1px dashed rgba(255,255,255,0.10)", display:"flex", alignItems:"center", justifyContent:"center", padding:20, textAlign:"center", color:"var(--fg-subtle)", fontSize:12 }}>
        Pick a project on the strip, or click <b style={{ margin:"0 4px" }}>Team…</b> to load a template onto the canvas.
      </div>
    );
  }
  const pic_x = 14, pic_y = 38, pic_size = 100;
  const info_x = pic_x + pic_size + 18;
  const info_y = pic_y - 4;
  const info_w = CARD_W - 14 - info_x;
  const stat_y = CARD_H - 38 - 44;
  const desc = team.description.length > 240 ? team.description.slice(0, 237) + "…" : team.description;
  return (
    <div data-ui="TeamInfoCard" style={{ position:"relative", width:CARD_W, height:CARD_H, borderRadius:12, background:"linear-gradient(135deg, rgba(18,22,34,0.90) 0%, rgba(8,11,18,0.90) 100%)", border:"1.6px solid transparent", overflow:"hidden" }}>
      <div style={{ position:"absolute", inset:0, borderRadius:12, padding:"1.6px", background:"linear-gradient(135deg, rgba(92,240,255,0.86) 0%, rgba(192,138,255,0.86) 100%)", WebkitMask:"linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)", WebkitMaskComposite:"xor", maskComposite:"exclude", pointerEvents:"none" }} />
      <div data-ui="TeamRibbon" style={{ position:"absolute", left:8, top:8, width:CARD_W - 16, height:22, borderRadius:6, background:"linear-gradient(90deg, rgba(92,240,255,0.235) 0%, rgba(192,138,255,0.039) 100%)", border:"1px solid rgba(92,240,255,0.47)", display:"flex", alignItems:"center", paddingLeft:10, fontSize:12, fontWeight:700, color:"var(--fg)", fontFamily:"Segoe UI", letterSpacing:0.2 }}>● {team.category.toUpperCase()}</div>
      <div style={{ position:"absolute", left:pic_x - 6, top:pic_y - 6, width:pic_size + 12, height:pic_size + 12, borderRadius:"50%", background:"radial-gradient(circle, rgba(92,240,255,0.43) 0%, rgba(92,240,255,0) 100%)", pointerEvents:"none" }} />
      <div style={{ position:"absolute", left:pic_x, top:pic_y, width:pic_size, height:pic_size, borderRadius:"50%", background:"#1e2434", border:"1.4px solid rgba(230,240,255,0.78)", display:"flex", alignItems:"center", justifyContent:"center", overflow:"hidden" }}>
        <img src={owlSrc(team.icon)} style={{ width:pic_size * 0.85, height:pic_size * 0.85, objectFit:"contain" }} />
      </div>
      <div style={{ position:"absolute", left:pic_x - 6, top:pic_y + pic_size + 6, width:pic_size + 12, height:20, textAlign:"center", fontSize:15, fontWeight:700, color:"var(--fg)", fontFamily:"Segoe UI", lineHeight:"20px" }}>{team.display}</div>
      <div style={{ position:"absolute", left:info_x, top:info_y, width:info_w, height:96, fontSize:12, color:"var(--fg)", fontFamily:"Segoe UI", lineHeight:1.35, overflow:"hidden" }}>
        {desc || <span style={{ color:"var(--fg-muted)" }}>(no description)</span>}
      </div>
      <div style={{ position:"absolute", left:info_x, top:stat_y, width:info_w, height:14, display:"flex", alignItems:"center", fontSize:11, fontWeight:700, color:"var(--fg-muted)", fontFamily:"Segoe UI", letterSpacing:0.4 }}>
        <span style={{ width:90 }}>AGENTS</span>
        <span>CONNECTIONS</span>
      </div>
      <div style={{ position:"absolute", left:info_x, top:stat_y + 14, width:info_w, height:18, display:"flex", alignItems:"center", fontSize:15, fontWeight:700, color:"var(--fg)", fontFamily:"Segoe UI" }}>
        <span style={{ width:90 }}>{team.agents.length}</span>
        <span>{team.edges.length}</span>
      </div>
    </div>
  );
}

// SuperUserCard — widgets/super_user_card.py::SuperUserCard. The chat
// pane is empty by default (no fake "You: …" / "Team: …" prefill).
function SuperUserCard({ team, roleByName, chat, onSend, autoApprove, onToggleAutoApprove }: {
  team: Team | null;
  roleByName: Map<string, RoleData>;
  chat: GoalMsg[];
  onSend: (text: string) => void;
  autoApprove: boolean;
  onToggleAutoApprove: () => void;
}) {
  const peekAgents = (team?.agents ?? []).slice(0, 6);
  const [draft, setDraft] = useState<string>("");
  const lastMessages = chat.slice(-4);  // most recent first-visible window
  const submit = () => {
    const t = draft.trim();
    if (!t) return;
    onSend(t);
    setDraft("");
  };
  return (
    <div data-ui="SuperUserCard" style={{ margin:"8px 10px", padding:"10px 12px", borderRadius:12, background:"var(--bg-elevated)", border:"1px solid var(--border)", width:320, minHeight:180, display:"flex", flexDirection:"column", gap:8 }}>
      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
        <div data-ui="suAvatar" style={{ width:28, height:28, borderRadius:16, background:"#1a2030", display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, color:"var(--fg)" }}>👤</div>
        <div style={{ flex:1, minWidth:0 }}>
          <div data-ui="suName" style={{ fontSize:16, fontWeight:700, color:"var(--fg)", lineHeight:"22px" }}>Super User</div>
          <div data-ui="suHint" style={{ fontSize:12, color:"var(--fg-subtle)", letterSpacing:0.4, textTransform:"uppercase", lineHeight:1.4 }}>
            {chat.length > 0 ? `${chat.length} message${chat.length === 1 ? "" : "s"} in this run` : "idle — team pings you here"}
          </div>
        </div>
        <button data-ui="suIconBtn" title="Open chat in a side panel (4:5, full window height, docked right)" style={{ width:30, height:26, padding:0, background:"#1a2030", color:"var(--fg)", border:"1px solid #2a3148", borderRadius:6, fontSize:14, fontWeight:700 }}>⇱⇲</button>
        <button data-ui="suIconBtn" title="Notification settings (Telegram, etc.)" style={{ width:26, height:26, padding:0, background:"#1a2030", color:"var(--fg)", border:"1px solid #2a3148", borderRadius:6, fontSize:16, fontWeight:700 }}>⚙</button>
      </div>
      {peekAgents.length > 0 && (
        <div data-ui="suTeamPeek" style={{ display:"flex", alignItems:"center", gap:4, padding:"0 2px" }}>
          {peekAgents.map((a, i) => (
            <img key={i} src={owlSrc(agentIconRef(a, roleByName))} title={displayLabel(a.name)} style={{ width:20, height:20, opacity:0.85, filter:"drop-shadow(0 1px 1px rgba(0,0,0,0.5))" }} />
          ))}
          <div style={{ fontSize:10, color:"var(--fg-subtle)", letterSpacing:0.4, textTransform:"uppercase", marginLeft:4 }}>{team?.agents.length ?? 0} agents on team</div>
        </div>
      )}
      <div data-ui="suChat" style={{ height:80, background:"var(--bg-elevated)", color:"var(--fg)", border:"1px solid var(--border)", borderRadius:8, padding:"8px 10px", fontSize:12, lineHeight:1.45, overflow:"auto", display:"flex", flexDirection:"column", gap:4 }}>
        {chat.length === 0 ? (
          <div style={{ color:"var(--fg-subtle)", fontStyle:"italic" }}>
            {team
              ? `${team.display} is idle. Type a message below or use the goal bar to dispatch.`
              : "Pick a project or team template to begin."}
          </div>
        ) : lastMessages.map((m, i) => (
          <div key={i}>
            <span style={{ color: m.color, fontWeight:700 }}>{m.role === "you" ? "You" : (m.role[0]?.toUpperCase() + m.role.slice(1))}:</span>{" "}
            <span style={{ color:"var(--fg)" }}>{m.text.length > 200 ? m.text.slice(0, 197) + "…" : m.text}</span>
          </div>
        ))}
      </div>
      <div data-ui="suInputRow" style={{ display:"flex", alignItems:"center", gap:8 }}>
        <input
          data-ui="suReply"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") submit(); }}
          placeholder="Reply to the team — Enter to send"
          style={{ flex:1, height:32, borderRadius:8, padding:"6px 10px", background:"var(--bg-elevated)", color:"var(--fg)", fontSize:14, border:"1px solid #2a3148" }}
        />
        <button
          data-ui="suSend"
          onClick={submit}
          disabled={!draft.trim()}
          style={{
            height:32, padding:"6px 14px", borderRadius:8,
            border:"1px solid #5cf0ff",
            background: draft.trim() ? "var(--accent)" : "rgba(92,240,255,0.25)",
            color: draft.trim() ? "var(--bg-elevated)" : "#7d8595",
            fontSize:13, fontWeight:700,
            cursor: draft.trim() ? "pointer" : "not-allowed",
          }}
        >Send</button>
      </div>
      <label data-ui="suTrust" style={{ display:"flex", alignItems:"center", gap:6, fontSize:13, color: autoApprove ? "#ff8c8c" : "#7888a8", cursor:"pointer" }}>
        <input type="checkbox" checked={autoApprove} onChange={onToggleAutoApprove} style={{ width:12, height:12, accentColor:"#ff6060" }} />
        <span>auto-approve tool requests</span>
      </label>
    </div>
  );
}

// TeamCanvas — agent_team_canvas.py's orbital diagram. Roster from
// the active team, depth from the routing graph.
function TeamCanvas({ width, height, team, roleByName, activeAgent }: {
  width: number; height: number; team: Team | null; roleByName: Map<string, RoleData>;
  activeAgent: string | null;
}) {
  const w = width, h = height;
  const card_reserve = Math.min(410, w * 0.35);
  const cx = card_reserve + (w - card_reserve) / 2;
  const cy = h / 2;
  const [arcPhase, setArcPhase] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      setArcPhase(((now - start) / 1000) * 36);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const LAYER_COLORS = [
    "#f1c44a", "#48d486", "#3aa0ff", "#ee5b5b",
    "#ff9a3a", "#9aa3b2", "#a578ff", "#ff79c4",
  ];

  type RosterRow = { name: string; label: string; iconRef: string; depth: number; active: boolean };
  const roster: RosterRow[] = useMemo(() => {
    if (!team || team.agents.length === 0) return [];
    const depths = computeDepths(team);
    return team.agents
      .filter(a => a.name !== "orchestrator" && a.base !== "orchestrator")
      .map(a => ({
        name: a.name,
        label: displayLabel(a.name),
        iconRef: agentIconRef(a, roleByName),
        depth: Math.max(1, depths.get(a.name) ?? 1),
        active: a.name === activeAgent,
      }));
  }, [team, roleByName, activeAgent]);

  const depthMap = useMemo(() => {
    const m = new Map<number, RosterRow[]>();
    for (const r of roster) {
      if (!m.has(r.depth)) m.set(r.depth, []);
      m.get(r.depth)!.push(r);
    }
    return m;
  }, [roster]);
  const sortedDepths = Array.from(depthMap.keys()).sort((a, b) => a - b);
  const max_depth = sortedDepths.length ? sortedDepths[sortedDepths.length - 1] : 1;

  const canvas_cap = Math.min(w - card_reserve, h) * 0.45;
  const max_radius = Math.min(canvas_cap, Math.min(w, h) * 0.45);
  const inner_offset = 130;
  let step = (max_radius - inner_offset) / Math.max(1, max_depth);
  if (step < 90) step = 90;
  const ring_radii = sortedDepths.map(d => inner_offset + step * d);
  const arc_span = (Math.PI * 2) * (340 / 360);

  type Node = { name: string; x: number; y: number; label: string; iconRef: string; active: boolean; depth: number };
  const nodes: Node[] = [];
  for (const depth of sortedDepths) {
    const ringAgents = depthMap.get(depth)!;
    const count = ringAgents.length;
    const r = inner_offset + step * depth;
    for (let i = 0; i < count; i++) {
      const a = ringAgents[i];
      const theta = count === 1 ? -Math.PI / 2 : (arc_span * (i + 1)) / count - Math.PI / 2;
      nodes.push({
        name: a.name,
        x: cx + r * Math.cos(theta),
        y: cy + r * Math.sin(theta),
        label: a.label,
        iconRef: a.iconRef,
        active: a.active,
        depth,
      });
    }
  }
  // Lookup by agent name so we can draw real routing edges from the
  // team's graph (vs the simple star spokes that radiate from the
  // orchestrator). The orchestrator's coords sit at the centre (cx,cy).
  const nodeByName = new Map<string, { x: number; y: number }>();
  for (const n of nodes) nodeByName.set(n.name, { x: n.x, y: n.y });
  const orchSpec = team?.agents.find(a => a.name === "orchestrator" || a.base === "orchestrator");
  if (orchSpec) nodeByName.set(orchSpec.name, { x: cx, y: cy });
  // Non-trivial routing edges (anything that isn't orchestrator → X,
  // because those are already drawn as star spokes). Drawing them on
  // top of the orbital diagram exposes the real flow without making
  // the picture too busy.
  const orchName = orchSpec?.name;
  const routingEdges = (team?.edges ?? []).filter(e =>
    e.source !== orchName &&
    nodeByName.has(e.source) &&
    nodeByName.has(e.target)
  );
  const NODE_R = 22;
  const orchestrator_r = Math.max(48, Math.min(w, h) * 0.10);
  const arc_r_out = orchestrator_r * 1.7;
  const arc_r_in  = orchestrator_r * 1.2;
  const pulse = 0.5 + 0.5 * Math.sin((arcPhase * Math.PI) / 180);
  const arcAlphaOut = 0.78 + 0.14 * pulse;
  const arcAlphaIn  = 0.70 + 0.16 * pulse;
  const coreInner = 0.43 + 0.27 * pulse;
  const coreMid   = 0.20 + 0.16 * pulse;
  const arcPath = (rad: number, startDeg: number, sweepDeg: number) => {
    const a0 = (startDeg * Math.PI) / 180;
    const a1 = ((startDeg + sweepDeg) * Math.PI) / 180;
    const sx = cx + rad * Math.cos(a0);
    const sy = cy + rad * Math.sin(a0);
    const ex = cx + rad * Math.cos(a1);
    const ey = cy + rad * Math.sin(a1);
    const large = sweepDeg > 180 ? 1 : 0;
    return `M ${sx} ${sy} A ${rad} ${rad} 0 ${large} 1 ${ex} ${ey}`;
  };

  return (
    <div data-ui="AgentTeamCanvas" style={{ position:"relative", width:w, height:h, background:`radial-gradient(ellipse at ${w/2}px ${h/2}px, rgba(192,138,255,0.10) 0%, rgba(116,164,255,0.06) 30%, rgba(40,60,110,0.04) 60%, rgba(0,0,0,0) 85%), linear-gradient(180deg, #101522 0%, #06080d 100%)`, overflow:"hidden" }}>
      <svg width={w} height={h} style={{ position:"absolute", left:0, top:0 }}>
        <defs>
          <radialGradient id="halo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(120,220,255,0.85)" />
            <stop offset="45%" stopColor="rgba(120,220,255,0.35)" />
            <stop offset="100%" stopColor="rgba(120,220,255,0)" />
          </radialGradient>
          <radialGradient id="haloActive" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(127,223,255,1)" />
            <stop offset="40%" stopColor="rgba(127,223,255,0.55)" />
            <stop offset="100%" stopColor="rgba(127,223,255,0)" />
          </radialGradient>
          <radialGradient id="orchHalo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(255,200,100,0.85)" />
            <stop offset="45%" stopColor="rgba(255,180,80,0.40)" />
            <stop offset="100%" stopColor="rgba(255,180,80,0)" />
          </radialGradient>
          <radialGradient id="orchCore" cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor={`rgba(255,215,106,${coreInner.toFixed(3)})`} />
            <stop offset="60%"  stopColor={`rgba(241,196,74,${coreMid.toFixed(3)})`} />
            <stop offset="100%" stopColor="rgba(10,13,20,0)" />
          </radialGradient>
          {nodes.map((n,i) => (
            <linearGradient key={"spg"+i} id={`spokeGrad${i}`} gradientUnits="userSpaceOnUse" x1={cx} y1={cy} x2={n.x} y2={n.y}>
              <stop offset="0%" stopColor="rgba(92,240,255,0.43)" />
              <stop offset="100%" stopColor="rgba(116,164,255,0.12)" />
            </linearGradient>
          ))}
        </defs>
        {ring_radii.map((r, idx) => {
          const layer = idx + 1;
          const col = LAYER_COLORS[layer % LAYER_COLORS.length];
          return (
            <circle key={"ring" + idx} cx={cx} cy={cy} r={r} fill="none" stroke={col} strokeOpacity={200 / 255} strokeWidth={1.6} strokeLinecap="round" />
          );
        })}
        {nodes.map((n,i) => (
          <line key={"sp"+i} x1={cx} y1={cy} x2={n.x} y2={n.y} stroke={n.active?"rgba(120,220,255,0.55)":`url(#spokeGrad${i})`} strokeWidth={n.active?1.6:1.3} />
        ))}
        {/* Routing edges between specialists — drawn as gentle curves
            with a violet tint so they read as the team's actual flow,
            not just radial spokes. Arrowhead via marker. */}
        <defs>
          <marker id="routeArrow" viewBox="0 0 10 10" refX="9" refY="5"
                  markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(192,138,255,0.85)" />
          </marker>
        </defs>
        {routingEdges.map((e, i) => {
          const a = nodeByName.get(e.source)!;
          const b = nodeByName.get(e.target)!;
          // Shorten so the arrowhead lands at the disc edge, not inside.
          const dx = b.x - a.x, dy = b.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          const ux = dx / len, uy = dy / len;
          const trim = 24;
          const sx = a.x + ux * trim, sy = a.y + uy * trim;
          const ex = b.x - ux * trim, ey = b.y - uy * trim;
          // Quadratic control point offset perpendicular to the line so
          // forward + reverse edges don't overlap exactly.
          const mx = (sx + ex) / 2, my = (sy + ey) / 2;
          const px = -uy, py = ux;
          const offset = 18;
          const qx = mx + px * offset, qy = my + py * offset;
          return (
            <path
              key={"edge"+i}
              d={`M ${sx} ${sy} Q ${qx} ${qy} ${ex} ${ey}`}
              stroke="rgba(192,138,255,0.65)"
              strokeWidth={1.4}
              fill="none"
              markerEnd="url(#routeArrow)"
            />
          );
        })}
        {nodes.map((n,i) => (
          <circle key={"h"+i} cx={n.x} cy={n.y} r={n.active?52:38} fill={n.active?"url(#haloActive)":"url(#halo)"} />
        ))}
        {nodes.map((n,i) => (
          <circle key={"d"+i} cx={n.x} cy={n.y} r={22} fill="#3b4a7a" stroke={n.active?"var(--accent)":"rgba(120,220,255,0.6)"} strokeWidth={n.active?2.4:1.6} />
        ))}
        {nodes.filter(n=>n.active).map((n,i) => (
          <circle key={"r"+i} cx={n.x} cy={n.y} r={28} fill="none" stroke="rgba(127,223,255,0.7)" strokeWidth="1.4" />
        ))}
        <circle cx={cx} cy={cy} r={orchestrator_r * 3.0} fill="url(#orchHalo)" />
        <circle cx={cx} cy={cy} r={orchestrator_r * 1.5} fill="url(#orchCore)" stroke="rgba(255,200,100,0.55)" strokeWidth="1.6" />
        {[0, 130, 240].map((off, i) => (
          <path key={"arcOut" + i} d={arcPath(arc_r_out, arcPhase + off, 60)} stroke="#f1c44a" strokeWidth={2.6} strokeLinecap="round" fill="none" opacity={arcAlphaOut} />
        ))}
        {[0, 110, 230].map((off, i) => (
          <path key={"arcIn" + i} d={arcPath(arc_r_in, -arcPhase * 1.3 + off, 70)} stroke="#ffd76a" strokeWidth={2.0} strokeLinecap="round" fill="none" opacity={arcAlphaIn} />
        ))}
      </svg>
      <img src={`${ICONS}/owl_agentic.png`} style={{ position:"absolute", left:cx - orchestrator_r * 1.12, top:cy - orchestrator_r * 1.12, width:orchestrator_r * 2.24, height:orchestrator_r * 2.24, pointerEvents:"none", filter:"drop-shadow(0 0 16px rgba(255,200,100,0.55)) drop-shadow(0 0 28px rgba(255,180,80,0.35))" }} />
      <div style={{ position:"absolute", left:cx-60, top:cy + orchestrator_r * 1.6, width:120, textAlign:"center", fontSize:11, fontWeight:700, color:"#ffd97a", textTransform:"uppercase", letterSpacing:0.8, textShadow:"0 1px 3px rgba(0,0,0,0.9)", pointerEvents:"none" }}>Orchestrator</div>
      {nodes.map((n,i) => (
        <img
          key={"i"+i}
          src={owlSrc(n.iconRef)}
          style={{
            position: "absolute",
            left: n.x - NODE_R,
            top:  n.y - NODE_R,
            width:  NODE_R * 2,
            height: NODE_R * 2,
            objectFit: "contain",
            pointerEvents: "none",
            filter: n.active
              ? "drop-shadow(0 0 6px rgba(127,223,255,0.85))"
              : "drop-shadow(0 1px 2px rgba(0,0,0,0.5))",
          }}
        />
      ))}
      {nodes.map((n,i) => (
        <div key={"l"+i} style={{ position:"absolute", left:n.x - 60, top:n.y + 30, width:120, textAlign:"center", fontSize:12, fontWeight:600, color:n.active?"#ffffff":"#e6e8eb", letterSpacing:0.4, pointerEvents:"none", textShadow:"0 1px 3px rgba(0,0,0,0.9)" }}>{n.label}</div>
      ))}
      {nodes.length === 0 && (
        <div style={{ position:"absolute", left:cx-180, top:cy + orchestrator_r * 2 + 20, width:360, textAlign:"center", fontSize:12, color:"var(--fg-subtle)", pointerEvents:"none" }}>
          No specialists on this team yet. Click <b>Team…</b> above to load a template.
        </div>
      )}
    </div>
  );
}

// GraphCanvas — editable graph view. Top-down hierarchical layout
// mirrors Qt agent_canvas.py:TeamGraphView. Cards are 180×220 (close
// to Qt's 220×340), draggable; each card has a blue output port on
// its right edge and an orange input port on its left. Drag from
// output port over a target card to create a directional edge. Click
// an edge to select it; ✕ Edge deletes, ⇄ Reverse flips.
//
// `positions` (optional) lets the parent persist manual placement
// across mode toggles; falls back to BFS-row auto-layout when null.
type GraphPos = Map<string, { x: number; y: number }>;

function GraphCanvas({
  width, height, team, roleByName,
  selectedNode, onSelectNode,
  activeAgent,
  edges, onEdgesChange,
  selectedEdgeIdx, onSelectEdge,
  positions, onPositionsChange,
}: {
  width: number; height: number;
  team: Team | null; roleByName: Map<string, RoleData>;
  selectedNode: string | null; onSelectNode: (name: string | null) => void;
  activeAgent: string | null;
  edges: Edge[]; onEdgesChange: (edges: Edge[]) => void;
  selectedEdgeIdx: number | null; onSelectEdge: (idx: number | null) => void;
  positions: GraphPos | null; onPositionsChange: (p: GraphPos) => void;
}) {
  const w = width, h = height;
  const containerRef = useRef<HTMLDivElement>(null);
  // Live mouse position for the rubber-band edge while dragging from a
  // port. Null when no drag is in flight.
  const [drag, setDrag] = useState<null | { from: string; x: number; y: number; over: string | null }>(null);
  // Live node-drag offset (anchor = mouse position when the body was
  // grabbed). null when no body drag is in flight.
  const [bodyDrag, setBodyDrag] = useState<null | { name: string; dx: number; dy: number }>(null);

  const LAYER_COLORS = [
    "#f1c44a", "#48d486", "#3aa0ff", "#ee5b5b",
    "#ff9a3a", "#9aa3b2", "#a578ff", "#ff79c4",
  ];

  const NODE_W = 180;
  const NODE_H = 220;
  const ROW_GAP = 60;
  const COL_GAP = 28;
  const TOP_PAD = 32;
  const SIDE_PAD = 24;
  const PORT_R = 9;

  // Compute auto-layout (BFS row-by-row, wrap rows that overflow).
  // Used both for the default placement and for the ⟲ Layout button.
  const autoLayout = useMemo<GraphPos>(() => {
    const out: GraphPos = new Map();
    if (!team || team.agents.length === 0) return out;
    const depths = computeDepths(team);
    const byDepth = new Map<number, AgentSpec[]>();
    for (const a of team.agents) {
      const d = depths.get(a.name) ?? 0;
      if (!byDepth.has(d)) byDepth.set(d, []);
      byDepth.get(d)!.push(a);
    }
    const sortedDepths = Array.from(byDepth.keys()).sort((a, b) => a - b);
    const availW = w - SIDE_PAD * 2;
    const perRow = Math.max(1, Math.floor((availW + COL_GAP) / (NODE_W + COL_GAP)));
    let curY = TOP_PAD;
    for (const depth of sortedDepths) {
      const agents = byDepth.get(depth)!;
      // Wrap groups that overflow into multiple sub-rows.
      for (let i = 0; i < agents.length; i += perRow) {
        const slice = agents.slice(i, i + perRow);
        const totalW = slice.length * NODE_W + Math.max(0, slice.length - 1) * COL_GAP;
        const startX = (w - totalW) / 2;
        for (let j = 0; j < slice.length; j++) {
          out.set(slice[j].name, { x: startX + j * (NODE_W + COL_GAP), y: curY });
        }
        curY += NODE_H + ROW_GAP;
      }
    }
    return out;
  }, [team, w]);

  // Effective positions: parent-supplied map overrides; otherwise auto-layout.
  const effective: GraphPos = positions && positions.size > 0 ? positions : autoLayout;

  // Drag handlers — listen on the container so we keep tracking the
  // cursor even when it leaves the source node body.
  const onContainerMove = (e: React.MouseEvent) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + containerRef.current.scrollLeft;
    const y = e.clientY - rect.top + containerRef.current.scrollTop;
    if (drag) {
      // Find the topmost node the cursor sits over (cheap O(n) hit-test).
      let over: string | null = null;
      for (const [name, p] of effective.entries()) {
        if (name === drag.from) continue;
        if (x >= p.x && x <= p.x + NODE_W && y >= p.y && y <= p.y + NODE_H) {
          over = name;
          break;
        }
      }
      setDrag({ ...drag, x, y, over });
    }
    if (bodyDrag) {
      const next: GraphPos = new Map(effective);
      next.set(bodyDrag.name, { x: x - bodyDrag.dx, y: y - bodyDrag.dy });
      onPositionsChange(next);
    }
  };

  const onContainerUp = () => {
    if (drag) {
      if (drag.over && drag.over !== drag.from && !edges.some(e => e.source === drag.from && e.target === drag.over)) {
        onEdgesChange([...edges, { source: drag.from, target: drag.over }]);
      }
      setDrag(null);
    }
    if (bodyDrag) setBodyDrag(null);
  };

  if (!team || team.agents.length === 0) {
    return (
      <div data-ui="GraphCanvas" style={{ position:"relative", width:w, height:h, background:"linear-gradient(180deg, #101522 0%, #06080d 100%)", display:"flex", alignItems:"center", justifyContent:"center", color:"var(--fg-subtle)", fontSize:13 }}>
        No agents on this team yet. Pick a template via <b style={{ margin:"0 4px" }}>Team…</b>.
      </div>
    );
  }

  const depths = computeDepths(team);
  const orchName =
    team.agents.find(a => a.name === "orchestrator")?.name ??
    team.agents.find(a => a.base === "orchestrator")?.name ??
    team.agents[0].name;

  // Resolve renderable nodes. Skip agents that don't have a position
  // (defensive — shouldn't happen given autoLayout fills everything).
  type GNode = { name: string; spec: AgentSpec; x: number; y: number; depth: number };
  const placed: GNode[] = team.agents
    .map(a => {
      const p = effective.get(a.name);
      if (!p) return null;
      return { name: a.name, spec: a, x: p.x, y: p.y, depth: depths.get(a.name) ?? 0 };
    })
    .filter((n): n is GNode => n !== null);

  // Canvas scroll bounds — fit content with padding.
  const contentBottom = placed.reduce((m, n) => Math.max(m, n.y + NODE_H), 0) + TOP_PAD;
  const contentRight  = placed.reduce((m, n) => Math.max(m, n.x + NODE_W), 0) + SIDE_PAD;
  const canvasH = Math.max(h, contentBottom);
  const canvasW = Math.max(w, contentRight);

  // Resolve edges into endpoints (skip stale references).
  const liveEdges = edges.filter(e => effective.has(e.source) && effective.has(e.target));

  // Output port (right edge centre) + input port (left edge centre).
  const outPort = (p: { x: number; y: number }) => ({ x: p.x + NODE_W, y: p.y + NODE_H / 2 });
  const inPort  = (p: { x: number; y: number }) => ({ x: p.x, y: p.y + NODE_H / 2 });

  const edgePath = (s: { x: number; y: number }, t: { x: number; y: number }) => {
    const sP = outPort(s);
    const tP = inPort(t);
    const dx = Math.max(60, Math.abs(tP.x - sP.x) * 0.5);
    return `M ${sP.x} ${sP.y} C ${sP.x + dx} ${sP.y}, ${tP.x - dx} ${tP.y}, ${tP.x} ${tP.y}`;
  };

  return (
    <div
      ref={containerRef}
      data-ui="GraphCanvas"
      onClick={() => { onSelectNode(null); onSelectEdge(null); }}
      onMouseMove={onContainerMove}
      onMouseUp={onContainerUp}
      onMouseLeave={() => { if (drag) setDrag(null); if (bodyDrag) setBodyDrag(null); }}
      style={{ position:"relative", width:w, height:h, background:"linear-gradient(180deg, #101522 0%, #06080d 100%)", overflow:"auto" }}
    >
      <div style={{ position:"relative", width:canvasW, height:canvasH }}>
        <svg width={canvasW} height={canvasH} style={{ position:"absolute", left:0, top:0, pointerEvents:"none" }}>
          <defs>
            <marker id="graphArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(120,220,255,0.85)" />
            </marker>
            <marker id="graphArrowSel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
            </marker>
          </defs>
          {/* Existing edges */}
          {liveEdges.map((e, i) => {
            const s = effective.get(e.source)!;
            const t = effective.get(e.target)!;
            const sel = selectedEdgeIdx === i;
            return (
              <g key={"ge"+i}>
                {/* Fat invisible hit-target so click is forgiving */}
                <path
                  d={edgePath(s, t)}
                  stroke="rgba(0,0,0,0)"
                  strokeWidth={14}
                  fill="none"
                  style={{ pointerEvents:"stroke", cursor:"pointer" }}
                  onClick={(ev) => { ev.stopPropagation(); onSelectEdge(i); onSelectNode(null); }}
                />
                <path
                  d={edgePath(s, t)}
                  stroke={sel ? "var(--accent)" : "rgba(120,220,255,0.55)"}
                  strokeWidth={sel ? 2.6 : 1.6}
                  fill="none"
                  markerEnd={sel ? "url(#graphArrowSel)" : "url(#graphArrow)"}
                />
              </g>
            );
          })}
          {/* Rubber-band while dragging from a port */}
          {drag && (() => {
            const src = effective.get(drag.from);
            if (!src) return null;
            const sP = outPort(src);
            const tx = drag.x, ty = drag.y;
            const dx = Math.max(40, Math.abs(tx - sP.x) * 0.5);
            return (
              <g>
                <path
                  d={`M ${sP.x} ${sP.y} C ${sP.x + dx} ${sP.y}, ${tx - dx} ${ty}, ${tx} ${ty}`}
                  stroke={drag.over ? "var(--accent)" : "rgba(120,220,255,0.55)"}
                  strokeWidth={drag.over ? 2.4 : 1.6}
                  strokeDasharray="6 4"
                  fill="none"
                />
                <circle cx={tx} cy={ty} r={6} fill={drag.over ? "var(--accent)" : "rgba(120,220,255,0.55)"} />
              </g>
            );
          })()}
        </svg>
        {placed.map(n => {
          const isOrch = n.name === orchName;
          const accent = isOrch ? "#ffd76a" : LAYER_COLORS[(n.depth + 1) % LAYER_COLORS.length];
          const sel = selectedNode === n.name;
          const isActive = activeAgent === n.name;
          const isDragTarget = drag?.over === n.name;
          return (
            <div
              key={n.name}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                if (!containerRef.current) return;
                const rect = containerRef.current.getBoundingClientRect();
                const x = e.clientX - rect.left + containerRef.current.scrollLeft;
                const y = e.clientY - rect.top + containerRef.current.scrollTop;
                setBodyDrag({ name: n.name, dx: x - n.x, dy: y - n.y });
              }}
              onClick={(e) => { e.stopPropagation(); onSelectNode(n.name); onSelectEdge(null); }}
              style={{
                position: "absolute", left: n.x, top: n.y,
                width: NODE_W, height: NODE_H, borderRadius: 14,
                background: sel || isActive
                  ? "linear-gradient(180deg, #232a3a 0%, #1a1f2c 100%)"
                  : isDragTarget
                  ? "linear-gradient(180deg, #1d2a32 0%, #11151e 100%)"
                  : "linear-gradient(180deg, #1a1f2c 0%, #11151e 100%)",
                border: `1.8px solid ${isActive ? "#3cf26b" : sel ? accent : isDragTarget ? "var(--accent)" : "rgba(255,255,255,0.07)"}`,
                boxShadow: isActive
                  ? "0 0 0 3px rgba(60,242,107,0.40), 0 6px 22px rgba(0,0,0,0.6)"
                  : sel
                  ? `0 0 0 2px ${accent}55, 0 6px 22px rgba(0,0,0,0.6)`
                  : isDragTarget
                  ? "0 0 0 2px rgba(92,240,255,0.40), 0 6px 22px rgba(0,0,0,0.6)"
                  : "0 4px 14px rgba(0,0,0,0.5)",
                padding: "12px 12px 10px",
                display: "flex", flexDirection: "column", alignItems: "stretch", gap: 6,
                cursor: bodyDrag?.name === n.name ? "grabbing" : "grab",
                userSelect: "none",
              }}
            >
              {/* Big icon row — mirrors Qt's ~180×180 top-of-card icon. */}
              <div style={{ width:"100%", height:120, display:"flex", alignItems:"center", justifyContent:"center", background:"rgba(255,255,255,0.025)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:10 }}>
                <img src={owlSrc(agentIconRef(n.spec, roleByName))} style={{ width:96, height:96, objectFit:"contain" }} />
              </div>
              <div style={{ color:"var(--fg-strong)", fontSize:13, fontWeight:700, textAlign:"center", lineHeight:1.2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                {displayLabel(n.name)}
              </div>
              <div style={{ color: accent, fontSize:10, fontWeight:600, textAlign:"center", letterSpacing:0.6, textTransform:"uppercase" }}>
                {n.spec.base}
              </div>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:6, marginTop:"auto" }}>
                {isOrch && (
                  <span style={{ color: accent, background: "rgba(255,215,106,0.12)", border: `1px solid ${accent}55`, borderRadius: 5, padding: "1px 7px", fontSize: 9, letterSpacing: 0.5, fontWeight: 700 }}>LEADER</span>
                )}
                <span style={{ color: "var(--fg-muted)", fontSize: 9, fontWeight: 600, letterSpacing: 0.4 }}>DEPTH {n.depth}</span>
              </div>

              {/* INPUT port — left edge centre, orange. Click target for incoming edges. */}
              <div
                title="Incoming connections land here"
                style={{
                  position:"absolute", left:-PORT_R, top: NODE_H/2 - PORT_R,
                  width: PORT_R * 2, height: PORT_R * 2, borderRadius:"50%",
                  background:"#ff9a3a", border:"2px solid #11151e",
                  boxShadow: isDragTarget ? "0 0 0 4px rgba(255,154,58,0.40)" : "0 0 8px rgba(255,154,58,0.55)",
                  pointerEvents:"none",
                }}
              />
              {/* OUTPUT port — right edge centre, blue. Drag from here to wire a new edge. */}
              <div
                title="Drag to another agent to create a dispatch edge"
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  e.stopPropagation();
                  e.preventDefault();
                  if (!containerRef.current) return;
                  const rect = containerRef.current.getBoundingClientRect();
                  const x = e.clientX - rect.left + containerRef.current.scrollLeft;
                  const y = e.clientY - rect.top + containerRef.current.scrollTop;
                  setDrag({ from: n.name, x, y, over: null });
                }}
                style={{
                  position:"absolute", left: NODE_W - PORT_R, top: NODE_H/2 - PORT_R,
                  width: PORT_R * 2, height: PORT_R * 2, borderRadius:"50%",
                  background:"#3aa0ff", border:"2px solid #11151e",
                  boxShadow:"0 0 10px rgba(58,160,255,0.70)",
                  cursor:"crosshair",
                }}
              />
            </div>
          );
        })}
      </div>
      {/* Empty-state hint */}
      {liveEdges.length === 0 && !drag && (
        <div style={{ position:"absolute", bottom:8, left:0, right:0, textAlign:"center", color:"var(--fg-subtle)", fontSize:11, pointerEvents:"none" }}>
          Drag from a blue output port → drop on another card to wire a dispatch edge. Click an edge to select it, then ✕ Edge / ⇄ Reverse.
        </div>
      )}
    </div>
  );
}

// OrchestratorPane — RIGHT pane. Now driven by the active agent's
// per-agent log buffer; click a node on the canvas to view its log
// (default = whichever agent the dispatcher is currently driving,
// fallback = orchestrator).
function OrchestratorPane({
  agentLogs, runError, serverState,
  selectedAgent, activeAgent,
  team, phase,
}: {
  agentLogs: Map<string, GoalMsg[]>;
  runError: string | null;
  serverState: ServerStatus;
  selectedAgent: string | null;
  activeAgent: string | null;
  team: Team | null;
  phase: DispatchPhase;
}) {
  const [activeTab, setActiveTab] = useState<"reply"|"thought">("reply");
  const modelLabel = serverState.running && serverState.model_id
    ? `${serverState.model_id} (port ${serverState.port})`
    : "(no model running)";
  // Pick which buffer to show: explicit selection > currently-active
  // agent > orchestrator (so the user sees the plan even if nothing
  // is selected yet) > "you" (which holds the goal echo).
  const orchName = team ? (findOrchestratorSpec(team)?.name ?? null) : null;
  const focus =
    selectedAgent ??
    activeAgent ??
    orchName ??
    "you";
  const focusLabel = focus === "you"
    ? "📜 You"
    : team
    ? `📜 ${displayLabel(focus)}`
    : `📜 ${focus}`;

  // Filter the focused agent's messages. The "you" buffer always
  // contains just the user goal echo; useful as a sanity check.
  const messages = agentLogs.get(focus) ?? [];

  // Phase indicator pill for the header.
  const phaseColor = phase === "idle" || phase === "done"
    ? "#7d8595"
    : phase === "planning"
    ? "#ffd97a"
    : phase === "dispatching"
    ? "#3cf26b"
    : "#c08aff"; // integrating
  const phaseText = phase === "idle"
    ? "Idle"
    : phase === "planning"
    ? "Planning…"
    : phase === "dispatching"
    ? `Dispatching${activeAgent ? `: ${displayLabel(activeAgent)}` : ""}`
    : phase === "integrating"
    ? "Integrating…"
    : "Done";

  return (
    <div data-ui="RosterRight" style={{ display:"flex", flexDirection:"column", height:"100%", background:"var(--bg-elevated)", padding:"0 0 0 8px" }}>
      <div data-ui="LogHeader" style={{ padding:"8px 12px 4px", display:"flex", alignItems:"center", gap:8 }}>
        <div style={{ fontSize:15, fontWeight:700, color:"var(--fg-strong)", letterSpacing:0.3, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 }}>
          {focusLabel}
        </div>
        <span style={{
          fontSize:10, fontWeight:700, letterSpacing:0.6, textTransform:"uppercase",
          color: phaseColor,
          background: `${phaseColor}22`,
          border: `1px solid ${phaseColor}55`,
          borderRadius:999, padding:"2px 8px",
          whiteSpace:"nowrap",
        }}>{phaseText}</span>
      </div>
      <div data-ui="PickerHost" style={{ padding:"0 12px 4px", display:"flex", alignItems:"center", gap:8 }}>
        <span style={{ fontSize:11, color:"var(--fg-muted)", letterSpacing:0.6, textTransform:"uppercase" }}>Model</span>
        <button style={{ flex:1, height:28, padding:"0 10px", background:"var(--bg-surface)", color: serverState.running ? "var(--fg)" : "var(--fg-subtle)", border:"1px solid var(--border)", borderRadius:6, fontSize:12, textAlign:"left" }} title={serverState.message}>{modelLabel}</button>
      </div>
      <div data-ui="VoiceHost" style={{ padding:"0 12px 8px", display:"flex", alignItems:"center", gap:8 }}>
        <span style={{ fontSize:11, color:"var(--fg-muted)", letterSpacing:0.6, textTransform:"uppercase" }}>Voice</span>
        <input type="checkbox" defaultChecked style={{ width:13, height:13, accentColor:"var(--accent)" }} title="Speak this agent's replies aloud" />
        <button style={{ flex:1, height:28, padding:"0 10px", background:"var(--bg-surface)", color:"var(--fg)", border:"1px solid var(--border)", borderRadius:6, fontSize:12, textAlign:"left" }}>Auto voice</button>
        <input type="number" defaultValue={0} style={{ width:78, height:28, padding:"0 8px", background:"var(--bg-surface)", color:"var(--fg)", border:"1px solid var(--border)", borderRadius:6, fontSize:12 }} title="Speaking rate (words per minute)" />
        <button style={{ width:28, height:28, padding:0, background:"var(--bg-surface)", color:"var(--fg)", border:"1px solid var(--border)", borderRadius:6, fontSize:12 }} title="Preview this voice">▶</button>
        <button style={{ width:28, height:28, padding:0, background:"var(--bg-surface)", color:"var(--fg)", border:"1px solid var(--border)", borderRadius:6, fontSize:14 }} title="Apply this voice to every agent on the team">➤</button>
      </div>
      <div data-ui="OrchestratorLogTabs" style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", padding:"0 0 8px" }}>
        <div style={{ display:"flex", alignItems:"center", padding:"0 12px", gap:0, borderBottom:"1px solid var(--border)" }}>
          <button onClick={() => setActiveTab("reply")} style={{ padding:"8px 14px", border:"none", background:"transparent", color: activeTab === "reply" ? "var(--accent)" : "var(--fg-muted)", fontSize:13, fontWeight:500, borderBottom: activeTab === "reply" ? "1.5px solid var(--accent)" : "1.5px solid transparent", display:"inline-flex", alignItems:"center", gap:4 }}>💬 Reply</button>
          <button onClick={() => setActiveTab("thought")} style={{ padding:"8px 14px", border:"none", background:"transparent", color: activeTab === "thought" ? "#dcb0ff" : "var(--fg-muted)", fontSize:13, fontWeight:500, borderBottom: activeTab === "thought" ? "1.5px solid #dcb0ff" : "1.5px solid transparent", display:"inline-flex", alignItems:"center", gap:4 }}>🧠 Thought</button>
          <div style={{ flex:1 }} />
        </div>
        <div data-ui="OrchestratorReplyView" style={{ flex:1, display: activeTab === "reply" ? "flex" : "none", flexDirection:"column", margin:"8px 10px 0", padding:10, gap:8, background:"var(--bg-panel)", border:"1px solid var(--border)", borderRadius:8, overflow:"auto", fontFamily:"Consolas, 'JetBrains Mono', monospace", fontSize:14, lineHeight:1.5, color:"var(--fg)" }}>
          {runError ? (<div style={{ border:"1px solid #ff9f9f", background:"rgba(255,80,80,0.10)", color:"#ffb0b0", borderRadius:6, padding:8, fontSize:12 }}>{runError}</div>) : null}
          {messages.length === 0 && !runError ? (
            <div style={{ color:"var(--fg-subtle)", fontSize:12 }}>
              {serverState.running && serverState.model_id
                ? `Ready. Type a goal above and press Run — the orchestrator will plan, dispatch, and integrate.`
                : "Start a model on the Server tab first, then type a goal above and click Run."}
            </div>
          ) : null}
          {messages.map((m, i) => (
            <div key={i} style={{ display:"flex", alignItems:"flex-start", gap:8 }}>
              <div style={{ width:28, height:28, flexShrink:0, borderRadius:14, background:m.color, opacity:0.85, display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:700, color:"#06080d", fontFamily:"Segoe UI, sans-serif" }}>{(m.role[0] || "?").toUpperCase()}</div>
              <div style={{ flex:1, background:"var(--bg-surface)", borderLeft:`3px solid ${m.color}`, borderRadius:8, padding:"4px 10px" }}>
                <div style={{ fontSize:10, fontWeight:700, color:m.color, textTransform:"uppercase", letterSpacing:0.5, marginBottom:2, fontFamily:"Segoe UI, sans-serif" }}>{m.role}</div>
                <div style={{ fontSize:12, color:"var(--fg)", lineHeight:1.4, fontFamily:"Segoe UI, sans-serif", whiteSpace:"pre-wrap" }}>{m.text || (m.role === focus || focus === orchName ? "…" : "")}</div>
              </div>
            </div>
          ))}
        </div>
        <div data-ui="OrchestratorThoughtView" style={{ flex:1, display: activeTab === "thought" ? "block" : "none", margin:"8px 10px 0", padding:10, background:"var(--bg-panel)", border:"1px solid var(--border)", borderRadius:8, overflow:"auto", fontFamily:"Consolas, 'JetBrains Mono', monospace", fontSize:14, lineHeight:1.5, color:"var(--fg)" }}>
          <div style={{ color:"var(--fg-subtle)", fontSize:11 }}>No thought traffic yet — tool calls, reasoning, and events land here while the team runs.</div>
        </div>
      </div>
    </div>
  );
}

// ---------- Main ----------
// ---------- Dispatch loop helpers ----------
//
// The agentic team runs entirely in React: it issues sequential
// /v1/chat/completions calls against the running llama-server, parses
// the orchestrator's reply for `@agent: instruction` directives, and
// dispatches each one to the matching specialist. After the
// specialists finish, the orchestrator gets one more turn to
// integrate their replies into a final answer for the user.
//
// No Python; no Rust dispatch worker. Cancellation goes through an
// AbortController on each fetch.

const ROLE_COLORS: Record<string, string> = {
  orchestrator: "#ffd97a",
  coder:        "#9ad9ff",
  critic:       "#ff8c8c",
  researcher:   "#c08aff",
  operator:     "#a8e6cf",
  documentation:"#ffc8a2",
  devops:       "#94a3b8",
  webapp:       "#82d4f1",
  assistant:    "#dadcdf",
};
function colorForAgent(spec: AgentSpec): string {
  return ROLE_COLORS[spec.base] ?? ROLE_COLORS[spec.name] ?? "#9ad9ff";
}

function findOrchestratorSpec(team: Team): AgentSpec | undefined {
  return (
    team.agents.find(a => a.name === "orchestrator") ??
    team.agents.find(a => a.base === "orchestrator") ??
    team.agents[0]
  );
}

function buildOrchestratorPrompt(
  team: Team,
  roleByName: Map<string, RoleData>,
  orch: AgentSpec,
): string {
  const specialists = team.agents.filter(a => a.name !== orch.name);
  // Prefer the spec's own description (team JSON, agent-specific) over
  // the base role's description; the team JSONs intentionally tailor
  // each agent's blurb for the team context.
  const roster = specialists.map(a => {
    const desc = a.description ?? roleByName.get(a.base)?.description ?? "";
    return `  - ${a.name} (${a.base}): ${desc}`;
  }).join("\n");
  const orchRole = roleByName.get(orch.base);
  // Layered guidance: prefer the role yaml's full system_prompt
  // (the canonical playbook), then the team-specific extra_prompt
  // appended below it, falling back to the role's one-line
  // description, then a hard-coded minimum if even that's missing.
  const orchBase =
    orchRole?.systemPrompt ??
    orchRole?.description ??
    "Plan the work, dispatch one task at a time, integrate the results.";
  const orchSystemPrompt = orch.extraPrompt
    ? `${orchBase}\n\n--- TEAM-SPECIFIC GUIDANCE ---\n${orch.extraPrompt}`
    : orchBase;
  return [
    `You are the orchestrator of the '${team.display}' team.`,
    "",
    orchSystemPrompt,
    "",
    `YOUR SPECIALISTS (use their EXACT names when dispatching):`,
    roster || "  (none — solo)",
    "",
    "HOW TO RESPOND:",
    "1. Start with a short paragraph that restates the user's goal in your own words.",
    "2. Sketch a brief plan (2-5 bullet points).",
    "3. Dispatch tasks using EXACTLY this format, ONE per line, ONE specialist per line:",
    "      @<agent_name>: <clear, specific instruction>",
    "4. Dispatch only the agents you actually need. Skip dispatches if the goal is trivial enough to answer yourself.",
    "5. After dispatches run, you'll be invoked again with the specialists' replies — produce the final answer for the user then.",
  ].join("\n");
}

function buildSpecialistPrompt(
  team: Team,
  spec: AgentSpec,
  roleByName: Map<string, RoleData>,
): string {
  const role = roleByName.get(spec.base);
  // Layer: role base prompt (from yaml) + team-specific spec
  // description + team-specific extra_prompt. All three are present
  // in well-curated teams like code_artisan; only the role base is
  // present for ad-hoc project rosters.
  const layers: string[] = [
    `You are ${displayLabel(spec.name)} (${spec.base}) on the '${team.display}' team.`,
    "",
  ];
  // Canonical role system prompt from the yaml file is the strongest
  // signal — fall back to the one-line description when missing.
  const roleBase = role?.systemPrompt ?? role?.description;
  if (roleBase) {
    layers.push(roleBase);
    layers.push("");
  }
  if (spec.description && spec.description !== role?.description) {
    layers.push(`Your job on this team: ${spec.description}`);
    layers.push("");
  }
  if (spec.extraPrompt) {
    layers.push(spec.extraPrompt);
    layers.push("");
  }
  layers.push("The orchestrator has dispatched the task below. Reply concisely and directly with your work.");
  layers.push("Do NOT dispatch further — only the orchestrator may dispatch. Stay in your role.");
  return layers.join("\n");
}

type Dispatch = { agentName: string; instruction: string };

function parseDispatches(text: string, team: Team, exclude: string): Dispatch[] {
  const known = new Set(team.agents.map(a => a.name));
  const lines = text.split(/\r?\n/);
  const out: Dispatch[] = [];
  // Accept `@coder: do X`, `- @coder: do X`, ` 1. @coder: do X` etc.
  const re = /^[\s\-\d.*•]*@([A-Za-z0-9._\-]+)\s*[:：]\s*(.+)$/;
  for (const raw of lines) {
    const m = raw.trim().match(re);
    if (!m) continue;
    const name = m[1];
    if (!known.has(name)) continue;
    if (name === exclude) continue;          // orchestrator never self-dispatches
    out.push({ agentName: name, instruction: m[2].trim() });
  }
  return out;
}

type StreamHandler = (delta: string) => void;

async function streamChatCompletion(
  port: number,
  modelId: string,
  systemPrompt: string,
  userMessage: string,
  temperature: number,
  signal: AbortSignal,
  onDelta: StreamHandler,
): Promise<string> {
  const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelId || "local",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      stream: true,
      temperature,
    }),
    signal,
  });
  if (!resp.ok || !resp.body) {
    throw new Error(await resp.text().catch(() => `HTTP ${resp.status}`));
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let acc = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const body = line.slice(5).trim();
      if (!body || body === "[DONE]") continue;
      try {
        const j = JSON.parse(body);
        const delta: string | undefined = j?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) {
          acc += delta;
          onDelta(delta);
        }
      } catch { /* skip malformed chunk */ }
    }
  }
  return acc;
}

// Strip any `@agent: …` directive lines from the orchestrator's reply
// so the final user-facing rendering doesn't double-show them.
function stripDispatchDirectives(text: string): string {
  const re = /^[\s\-\d.*•]*@[A-Za-z0-9._\-]+\s*[:：]/;
  return text.split(/\r?\n/).filter(l => !re.test(l.trim())).join("\n");
}

// Phase the dispatch loop is currently in. Used by the chrome to
// disable Run, show the activity hint, light up the busy spinner.
type DispatchPhase = "idle" | "planning" | "dispatching" | "integrating" | "done";

export default function AgentsPage() {
  const LEFT_W = 1014, RIGHT_W = 532, SPLITTER_W = 8;

  const [serverState, setServerState] = useState<ServerStatus>({ running: false, model_id: null, port: null, message: "" });

  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");

  const [teams, setTeams] = useState<Team[]>([]);
  const [roleByName, setRoleByName] = useState<Map<string, RoleData>>(new Map());
  const [pickedTeamId, setPickedTeamId] = useState<string | null>(null);

  const [bridges, setBridges] = useState<BridgeConfigs>({
    telegram: { bot_token: "", project_id: "" },
    whatsapp: { access_token: "", project_id: "" },
  });

  const [locationOverride, setLocationOverride] = useState<string>("");
  const [trustWritesOverride, setTrustWritesOverride] = useState<boolean | null>(null);

  const [goal, setGoal] = useState<string>("summarize the last commit and propose a follow-up");
  const [busy, setBusy] = useState<boolean>(false);
  const [runError, setRunError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Per-agent log buffers — keyed by agent.name (plus "you" for the
  // user goal echo and "system" for errors). OrchestratorPane filters
  // these by selectedNode; canvas highlights `activeAgent`.
  const [agentLogs, setAgentLogs] = useState<Map<string, GoalMsg[]>>(new Map());
  const [activeAgent, setActiveAgent] = useState<string | null>(null);
  const [phase, setPhase] = useState<DispatchPhase>("idle");

  // Diagram (orbital) ↔ Graph (top-down hierarchical) toggle. Mirrors
  // agents_page.py:_on_view_toggle_clicked. Selected node lives here
  // too so the toggle preserves the selection across views.
  const [viewMode, setViewMode] = useState<"diagram" | "graph">("diagram");
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  // Editable edges + manual node positions, both local-only for now.
  // They reset whenever the active team changes (see effect below).
  const [editedEdges, setEditedEdges] = useState<Edge[] | null>(null);
  const [selectedEdgeIdx, setSelectedEdgeIdx] = useState<number | null>(null);
  const [nodePositions, setNodePositions] = useState<GraphPos | null>(null);

  // Super User card chat (separate from the Run/Goal stream so users
  // can chat alongside a running plan). Auto-approve flag is local-
  // only for now; the runtime tool-call gate lands when agent
  // execution does.
  const [supChat, setSupChat] = useState<GoalMsg[]>([]);
  const [autoApprove, setAutoApprove] = useState<boolean>(false);

  async function onBrowseProjectFolder() {
    try {
      const picked = await invoke<string | null>("pick_folder", { title: "Pick a project folder" });
      if (picked) setLocationOverride(picked);
    } catch (e) {
      console.error("pick_folder failed", e);
    }
  }

  // + New / Rename / Delete project handlers — all write through the
  // create_project / update_project / delete_project Tauri commands.
  // After every mutation we refetch list_projects so the combo box +
  // selection stay accurate.
  const [newProjOpen, setNewProjOpen] = useState(false);
  const reloadProjects = async () => {
    try {
      const rows = await invoke<ProjectRow[]>("list_projects");
      setProjects(rows);
      return rows;
    } catch (e) {
      console.error("list_projects failed", e);
      return [] as ProjectRow[];
    }
  };
  const onNewProject = () => setNewProjOpen(true);
  const onProjectCreated = async (row: ProjectRow) => {
    const rows = await reloadProjects();
    // Select the freshly-created project. Fall back to id from the
    // returned row if list_projects raced.
    const target = rows.find(p => p.id === row.id) ?? row;
    setSelectedProjectId(target.id);
    setLocationOverride(target.location);
    setPickedTeamId(null);
    setTrustWritesOverride(null);
  };
  const onRenameProject = async () => {
    if (!selectedProject) return;
    const next = window.prompt(`Rename project '${selectedProject.name}' to:`, selectedProject.name);
    if (!next || next.trim() === "" || next.trim() === selectedProject.name) return;
    try {
      await invoke("update_project", { input: { id: selectedProject.id, name: next.trim() } });
      await reloadProjects();
    } catch (e: any) {
      alert(`Rename failed: ${e?.message ?? e}`);
    }
  };
  const onDeleteProject = async () => {
    if (!selectedProject) return;
    if (!window.confirm(`Delete project '${selectedProject.name}'?\n\nThis only removes the project row; the folder on disk stays.`)) return;
    try {
      await invoke("delete_project", { id: selectedProject.id });
      const rows = await reloadProjects();
      // Snap to the next project (if any).
      const fallback = rows[0]?.id ?? "";
      setSelectedProjectId(fallback);
      setPickedTeamId(null);
    } catch (e: any) {
      alert(`Delete failed: ${e?.message ?? e}`);
    }
  };

  // Initial load — projects, teams, roles, bridges in parallel.
  useEffect(() => {
    let dead = false;
    (async () => {
      const [rawProjects, rawTeams, rawRoles, rawBridges] = await Promise.all([
        invoke<ProjectRow[]>("list_projects").catch(() => [] as ProjectRow[]),
        invoke<TeamTemplateBackend[]>("list_team_templates").catch(() => [] as TeamTemplateBackend[]),
        invoke<AgentRoleBackend[]>("list_agent_roles").catch(() => [] as AgentRoleBackend[]),
        invoke<BridgeConfigs>("load_bridge_configs").catch(() => ({
          telegram: { bot_token: "", project_id: "" },
          whatsapp: { access_token: "", project_id: "" },
        } as BridgeConfigs)),
      ]);
      if (dead) return;
      setProjects(rawProjects);
      if (rawProjects.length > 0) {
        setSelectedProjectId(rawProjects[0].id);
        setLocationOverride(rawProjects[0].location || "");
        setTrustWritesOverride(null);
      }
      setTeams(rawTeams.map(toTeam));
      const m = new Map<string, RoleData>();
      for (const r of rawRoles) {
        const d = r.data ?? {};
        m.set(d.name ?? r.id, {
          name: d.name ?? r.id,
          icon: typeof d.icon === "string" ? d.icon : undefined,
          description: typeof d.description === "string" ? d.description : undefined,
          systemPrompt: typeof d.system_prompt === "string" ? d.system_prompt : undefined,
          canDispatch: d.can_dispatch === true,
          defaultTemperature: typeof d.default_temperature === "number" ? d.default_temperature : undefined,
        });
      }
      setRoleByName(m);
      setBridges(rawBridges);
    })();
    return () => { dead = true; };
  }, []);

  // Poll server status.
  useEffect(() => {
    let dead = false;
    const tick = async () => {
      try {
        const s = await invoke<ServerStatus>("server_status");
        if (!dead) setServerState(s);
      } catch { /* keep last good value */ }
    };
    tick();
    const id = window.setInterval(tick, 3000);
    return () => { dead = true; window.clearInterval(id); };
  }, []);

  const selectedProject = projects.find(p => p.id === selectedProjectId) ?? null;

  // Sync editable fields when project selection changes.
  useEffect(() => {
    if (selectedProject) {
      setLocationOverride(selectedProject.location || "");
      setTrustWritesOverride(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProject?.id]);

  // Active team: pickedTeamId wins; else project roster; else first
  // built-in template so the canvas is never empty.
  const activeTeam: Team | null = useMemo(() => {
    if (pickedTeamId) return teams.find(t => t.id === pickedTeamId) ?? null;
    if (selectedProject && selectedProject.team.length > 0) return projectToTeam(selectedProject);
    return teams[0] ?? null;
  }, [pickedTeamId, teams, selectedProject]);

  // Reset edge edits + node positions whenever the active team flips.
  // Without this, edges/positions from a previous team would leak onto
  // the next one and reference agents that don't exist.
  useEffect(() => {
    setEditedEdges(null);
    setSelectedEdgeIdx(null);
    setNodePositions(null);
    setSelectedNode(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTeam?.id]);

  // Persist edge edits back to the project's graph_json so the wiring
  // survives across app restarts. Only fires when the user is editing
  // a project's own roster (no template override active) and they've
  // actually touched the edges (editedEdges !== null). Debounced so
  // rapid drags don't hammer SQLite.
  useEffect(() => {
    if (!selectedProject) return;
    if (pickedTeamId !== null) return;
    if (editedEdges === null) return;
    const id = window.setTimeout(async () => {
      try {
        await invoke("update_project", {
          input: {
            id: selectedProject.id,
            graph_json: JSON.stringify({ edges: editedEdges }),
          },
        });
        await reloadProjects();
      } catch (e) {
        console.error("persist edges failed", e);
      }
    }, 600);
    return () => window.clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editedEdges, selectedProject?.id, pickedTeamId]);

  // Persist trust_writes toggles too. Same debounce shape.
  useEffect(() => {
    if (!selectedProject) return;
    if (trustWritesOverride === null) return;
    if (trustWritesOverride === selectedProject.trust_writes) return;
    const id = window.setTimeout(async () => {
      try {
        await invoke("update_project", {
          input: { id: selectedProject.id, trust_writes: trustWritesOverride },
        });
        await reloadProjects();
      } catch (e) {
        console.error("persist trust_writes failed", e);
      }
    }, 400);
    return () => window.clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trustWritesOverride, selectedProject?.id]);

  // Persist location edits the same way.
  useEffect(() => {
    if (!selectedProject) return;
    if (locationOverride === selectedProject.location) return;
    const id = window.setTimeout(async () => {
      try {
        await invoke("update_project", {
          input: { id: selectedProject.id, location: locationOverride },
        });
        await reloadProjects();
      } catch (e) {
        console.error("persist location failed", e);
      }
    }, 700);
    return () => window.clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationOverride, selectedProject?.id]);

  // Effective edges: edited copy if present, otherwise the template's.
  const currentEdges: Edge[] = editedEdges ?? (activeTeam?.edges ?? []);

  // The activeTeam passed to canvases should reflect edge edits so the
  // diagram view's overlay arrows + the graph view's lines stay in sync.
  const renderTeam: Team | null = activeTeam
    ? { ...activeTeam, edges: currentEdges }
    : null;

  const deleteSelectedEdge = () => {
    if (selectedEdgeIdx == null) return;
    const next = currentEdges.slice();
    next.splice(selectedEdgeIdx, 1);
    setEditedEdges(next);
    setSelectedEdgeIdx(null);
  };
  const reverseSelectedEdge = () => {
    if (selectedEdgeIdx == null) return;
    const next = currentEdges.slice();
    const e = next[selectedEdgeIdx];
    next[selectedEdgeIdx] = { source: e.target, target: e.source };
    setEditedEdges(next);
  };
  const resetGraphLayout = () => setNodePositions(null);

  // ----- Per-agent log mutation helpers -----
  // Append a fresh entry to a given agent's buffer.
  const appendLog = (agent: string, msg: GoalMsg) => {
    setAgentLogs(prev => {
      const next = new Map(prev);
      const cur = next.get(agent) ?? [];
      next.set(agent, [...cur, msg]);
      return next;
    });
  };
  // Stream a delta into the LAST message of an agent's buffer (used by
  // the live SSE stream so each token lands in the right pane).
  const streamLog = (agent: string, delta: string) => {
    setAgentLogs(prev => {
      const next = new Map(prev);
      const cur = next.get(agent) ?? [];
      if (cur.length === 0) return prev;
      const last = cur[cur.length - 1];
      const updated = [...cur];
      updated[updated.length - 1] = { ...last, text: last.text + delta };
      next.set(agent, updated);
      return next;
    });
  };

  // SuperUserCard Send — drops a one-off message into the Super User
  // log buffer. The dispatch loop above handles the orchestrator-led
  // flow; this lets the user sneak in a side note without re-running.
  const onSupSend = async (text: string) => {
    const userMsg: GoalMsg = { role: "you", color: "#9ad9ff", text };
    setSupChat(prev => [...prev, userMsg]);
    appendLog("you", userMsg);
    if (!serverState.running || !serverState.port) {
      const errMsg: GoalMsg = { role: "system", color: "#ff8c8c", text: "No model server is running — start one on the Server tab to dispatch this." };
      setSupChat(prev => [...prev, errMsg]);
      appendLog("system", errMsg);
      return;
    }
    const replyMsg: GoalMsg = { role: "orchestrator", color: "#ffd97a", text: "" };
    setSupChat(prev => [...prev, replyMsg]);
    appendLog("orchestrator", replyMsg);
    try {
      const sys = activeTeam
        ? `You are the orchestrator of '${activeTeam.display}'. Answer the user concisely.`
        : "You are the team's orchestrator.";
      await streamChatCompletion(
        serverState.port,
        serverState.model_id ?? "local",
        sys,
        text,
        0.5,
        new AbortController().signal,
        (delta) => {
          setSupChat(curr => {
            const out = curr.slice();
            const last = out[out.length - 1];
            if (last) out[out.length - 1] = { ...last, text: last.text + delta };
            return out;
          });
          streamLog("orchestrator", delta);
        },
      );
    } catch (e: any) {
      const errMsg: GoalMsg = { role: "system", color: "#ff8c8c", text: String(e?.message ?? e) };
      setSupChat(prev => [...prev, errMsg]);
      appendLog("system", errMsg);
    }
  };

  const trustWrites = trustWritesOverride ?? (selectedProject?.trust_writes ?? false);

  const bridgeOn = useMemo(() => {
    if (!selectedProject) return false;
    const t = bridges.telegram;
    const w = bridges.whatsapp;
    const tOn = !!t?.bot_token && t?.project_id === selectedProject.id;
    const wOn = !!w?.access_token && w?.project_id === selectedProject.id;
    return tOn || wOn;
  }, [bridges, selectedProject]);

  // ===== Dispatch loop =====
  // Run a multi-agent dispatch end-to-end:
  //   1. Plan      — orchestrator streams its plan + dispatch directives
  //   2. Dispatch  — one specialist per parsed `@agent: instruction` line
  //   3. Integrate — orchestrator gets one more turn with all replies
  // Each phase streams into the matching per-agent log buffer; the
  // canvas's `activeAgent` highlights whichever agent is on stage.
  async function dispatchGoal() {
    setRunError(null);
    const text = goal.trim();
    if (!text) return;
    if (!serverState.running || !serverState.port) {
      setRunError("No model server is running. Go to the Server tab and start a model first.");
      return;
    }
    if (!activeTeam || activeTeam.agents.length === 0) {
      setRunError("No team is loaded. Pick a team via 'Team…' or select a project with a roster.");
      return;
    }

    // Wipe the per-run log buffers but keep the SuperUserCard chat
    // (which represents the user-facing thread of the conversation).
    setAgentLogs(new Map());
    setRunError(null);
    setBusy(true);
    setPhase("planning");
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const orch = findOrchestratorSpec(activeTeam)!;
    const port = serverState.port;
    const modelId = serverState.model_id ?? "local";

    // Anchor the goal in the user log first.
    appendLog("you", { role: "you", color: "#9ad9ff", text });

    // Each role yaml ships a default_temperature; honour it instead of
    // a hardcoded 0.4/0.5 split. Orchestrator base = 0.3, specialists
    // vary (coder=0.2, critic=0.2, researcher=0.3, …).
    const tempFor = (spec: AgentSpec, fallback: number) =>
      roleByName.get(spec.base)?.defaultTemperature ?? fallback;

    try {
      // ----- Phase 1: orchestrator plan + dispatches -----
      setActiveAgent(orch.name);
      const orchPrompt = buildOrchestratorPrompt(activeTeam, roleByName, orch);
      appendLog(orch.name, { role: orch.name, color: "#ffd97a", text: "" });
      const orchReply = await streamChatCompletion(
        port, modelId, orchPrompt, text, tempFor(orch, 0.4), ctrl.signal,
        (delta) => streamLog(orch.name, delta),
      );

      // Mirror to the SuperUserCard so the user-facing thread shows
      // the orchestrator's plan + (later) the integrated answer.
      setSupChat(prev => [
        ...prev,
        { role: "you", color: "#9ad9ff", text },
      ]);

      // ----- Phase 2: parse + dispatch -----
      const dispatches = parseDispatches(orchReply, activeTeam, orch.name);

      // If the orchestrator didn't dispatch anything, its first reply
      // IS the final answer — surface it to the user and stop.
      if (dispatches.length === 0) {
        const clean = stripDispatchDirectives(orchReply).trim();
        setSupChat(prev => [...prev, { role: "orchestrator", color: "#ffd97a", text: clean || orchReply }]);
        setPhase("done");
        setActiveAgent(null);
        return;
      }

      setPhase("dispatching");
      const specialistReplies: Array<{ name: string; text: string }> = [];
      for (const d of dispatches) {
        if (ctrl.signal.aborted) throw new DOMException("aborted", "AbortError");
        const spec = activeTeam.agents.find(a => a.name === d.agentName);
        if (!spec) continue;
        setActiveAgent(spec.name);
        const specPrompt = buildSpecialistPrompt(activeTeam, spec, roleByName);
        // Anchor the dispatch instruction in the agent's log so the
        // user can see what was asked of them.
        appendLog(spec.name, { role: "dispatch", color: "#9aa0a6", text: `📩 ${d.instruction}` });
        appendLog(spec.name, { role: spec.name, color: colorForAgent(spec), text: "" });
        const specText = await streamChatCompletion(
          port, modelId, specPrompt, d.instruction, tempFor(spec, 0.5), ctrl.signal,
          (delta) => streamLog(spec.name, delta),
        );
        specialistReplies.push({ name: spec.name, text: specText.trim() });
      }

      if (specialistReplies.length === 0) {
        setPhase("done");
        setActiveAgent(null);
        return;
      }

      // ----- Phase 3: orchestrator integration -----
      setPhase("integrating");
      setActiveAgent(orch.name);
      const integrationInput = [
        `The user's original goal:\n${text}`,
        "",
        "Your specialists' replies:",
        ...specialistReplies.map(r => `\n— ${displayLabel(r.name)} —\n${r.text}`),
        "",
        "Now write the FINAL answer for the user. Be concise, structured, and quote the relevant specialist when useful. Do not dispatch again.",
      ].join("\n");
      appendLog(orch.name, { role: orch.name, color: "#ffd97a", text: "" });
      const finalReply = await streamChatCompletion(
        port, modelId, buildOrchestratorPrompt(activeTeam, roleByName, orch), integrationInput, tempFor(orch, 0.4), ctrl.signal,
        (delta) => streamLog(orch.name, delta),
      );
      setSupChat(prev => [...prev, { role: "orchestrator", color: "#ffd97a", text: finalReply.trim() }]);

      setPhase("done");
    } catch (e: any) {
      if (e?.name === "AbortError") {
        setRunError("Stopped.");
        appendLog("system", { role: "system", color: "#ff8c8c", text: "⏹ Stopped by user." });
      } else {
        setRunError(String(e?.message ?? e));
        appendLog("system", { role: "system", color: "#ff8c8c", text: `⚠ ${String(e?.message ?? e)}` });
      }
      setPhase("idle");
    } finally {
      setBusy(false);
      setActiveAgent(null);
      abortRef.current = null;
    }
  }

  const onRun = dispatchGoal;

  function onCancel() {
    abortRef.current?.abort();
  }

  return (
    <>
      <LocationRow
        projects={projects}
        selectedId={selectedProjectId}
        onChangeProject={(id) => { setSelectedProjectId(id); setPickedTeamId(null); }}
        teams={teams}
        pickedTeamId={pickedTeamId}
        onPickTeam={setPickedTeamId}
        location={locationOverride}
        onChangeLocation={setLocationOverride}
        onBrowse={onBrowseProjectFolder}
        trustWrites={trustWrites}
        onToggleTrustWrites={() => setTrustWritesOverride(v => !(v ?? selectedProject?.trust_writes ?? false))}
        bridgeOn={bridgeOn}
        onNewProject={onNewProject}
        onRenameProject={onRenameProject}
        onDeleteProject={onDeleteProject}
      />
      <NewProjectDialog
        open={newProjOpen}
        onClose={() => setNewProjOpen(false)}
        onCreated={onProjectCreated}
        teams={teams}
        defaultTeamName={pickedTeamId ? teams.find(t => t.id === pickedTeamId)?.name : undefined}
      />
      <GoalRow goal={goal} setGoal={setGoal} onRun={onRun} onCancel={onCancel} busy={busy} />
      <div data-ui="WorkspaceStack" style={{ height:665, width:1554, margin:"0 23px", display:"flex", overflow:"hidden", background:"var(--bg-app)", padding:0 }}>
        <div data-ui="RosterLeft" style={{ width:LEFT_W, display:"flex", flexDirection:"column", background:"var(--bg-elevated)" }}>
          <FlowHeader
            viewMode={viewMode}
            onToggleView={() => setViewMode(v => v === "diagram" ? "graph" : "diagram")}
            canEdit={viewMode === "graph" && selectedEdgeIdx != null}
            onDeleteEdge={deleteSelectedEdge}
            onReverseEdge={reverseSelectedEdge}
            onResetLayout={resetGraphLayout}
          />
          <div data-ui="CanvasStack" style={{ height:607, position:"relative" }}>
            {viewMode === "diagram" ? (
              <>
                <TeamCanvas
                  width={LEFT_W}
                  height={607}
                  team={renderTeam}
                  roleByName={roleByName}
                  activeAgent={activeAgent}
                />
                {/* Overlay only on the orbital diagram — the graph
                    view needs the full canvas for its cards. */}
                <div style={{ position:"absolute", top:8, left:8, width:360 }}>
                  <TeamInfoCard team={renderTeam} />
                  <SuperUserCard
                    team={renderTeam}
                    roleByName={roleByName}
                    chat={supChat}
                    onSend={onSupSend}
                    autoApprove={autoApprove}
                    onToggleAutoApprove={() => setAutoApprove(v => !v)}
                  />
                </div>
              </>
            ) : (
              <GraphCanvas
                width={LEFT_W}
                height={607}
                team={renderTeam}
                roleByName={roleByName}
                selectedNode={selectedNode}
                onSelectNode={setSelectedNode}
                activeAgent={activeAgent}
                edges={currentEdges}
                onEdgesChange={(es) => { setEditedEdges(es); setSelectedEdgeIdx(null); }}
                selectedEdgeIdx={selectedEdgeIdx}
                onSelectEdge={setSelectedEdgeIdx}
                positions={nodePositions}
                onPositionsChange={setNodePositions}
              />
            )}
          </div>
        </div>
        <div data-ui="RosterSplitter" style={{ width:SPLITTER_W, background:"var(--bg-card)" }} />
        <div style={{ width:RIGHT_W }}>
          <OrchestratorPane
            agentLogs={agentLogs}
            runError={runError}
            serverState={serverState}
            selectedAgent={selectedNode}
            activeAgent={activeAgent}
            team={renderTeam}
            phase={phase}
          />
        </div>
      </div>
    </>
  );
}
