// AgentsPage — agentic tab body. Frame + header + tabs come from
// AppShell. Layout: location strip, goal row, then the workspace
// (canvas + cards + orchestrator pane).
//
// All data is live: projects from list_projects (legacy SQLite), team
// templates + role definitions from agents.rs, bridge config from
// bridges.rs, server state via server_status. No hardcoded rosters.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import NewProjectDialog from "./NewProjectDialog";
import ModelPicker, { AccountsStatusLite } from "./ModelPicker";
import {
  type Attachment,
  type Directive,
  formatDirectivesBlock,
  buildCriticPrompt,
  extractUserInputRequest,
  transcribeAudioAttachments,
  imageAttachments,
  openaiUserContent,
  anthropicUserContent,
  parseClaudeModelId,
  mapClaudeEffort,
  getClaudeSession,
  resetClaudeSession,
} from "./dispatch";

const ICONS = "/Page_icons";

// ---------- Backend shapes ----------
type ProjectRow = {
  id: string; name: string; description: string; location: string;
  trust_writes: boolean; auto_approve_all: boolean;
  team: string[]; team_default_model_id: string;
  /// Routing graph blob — `{"edges": [{"source":"x","target":"y"}]}`.
  /// Empty string when the project hasn't customised routing yet.
  graph_json: string;
  /// Super User chat transcript (JSON array of GoalMsg). Empty = fresh.
  chat_json: string;
  /// Per-agent transcripts (JSON object keyed by agent name). Empty = fresh.
  agent_logs_json: string;
  updated_at: string;
};
type TeamTemplateBackend = { id: string; path: string; built_in: boolean; data: any };
type AgentRoleBackend    = { id: string; path: string; built_in: boolean; data: any };
type TelegramCfg = { bot_token: string; project_id: string; auto_approve?: boolean };
type WhatsAppCfg = { access_token: string; project_id: string; auto_approve?: boolean };
type BridgeConfigs = { telegram: TelegramCfg; whatsapp: WhatsAppCfg };
type ServerStatus = { running: boolean; model_id: string | null; port: number | null; message: string };
type ModelInfo = {
  model_id: string;
  port: number | null;
  base_model: string | null;
  size_mib: number | null;
  /// "local" | "anthropic" | "openai". Drives which endpoint the
  /// dispatch loop hits for this model.
  provider: string;
};

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
  /// OWLLM tool names this role may call (read_file, shell, …). The
  /// Claude CLI sub path translates these to --allowedTools so the
  /// runtime hard-rejects anything outside the allowlist. ["all"] /
  /// undefined / empty = unrestricted.
  toolAllowlist?: string[];
};
type GoalMsg = {
  role: string;
  color: string;
  text: string;
  /// Renderer hint. "thinking" → italic block, "tool" → monospace
  /// command-style block, undefined / "dispatch" / etc. → default reply look.
  kind?: "thinking" | "tool" | "dispatch";
  /// Stable per-(agent, stream) id used by streamThought to coalesce
  /// successive deltas into the same entry instead of appending a new
  /// line for every chunk. Only set on entries created by streamThought.
  channelKey?: string;
  /// Monotonic per-creation id from nextSeq(). Lets the Full Chat tab
  /// merge reply + thought streams in arrival order across two Maps.
  /// Stamped at first creation only; streaming deltas don't re-stamp.
  seq?: number;
};

// Module-scoped monotonic sequence — assigns a chronological id to
// every entry so the Full Chat tab can interleave the reply + thought
// streams in arrival order regardless of which Map they're stored in.
let _entrySeq = 0;
function nextSeq(): number { return ++_entrySeq; }

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
/// Display label with a special case for the design-team Product Owner,
/// who appears in the canvas as "Team Leader (Design Team)" instead of
/// the bare role name. Falls through to displayLabel for everything
/// else, including the design Product Owner of a non-design team
/// (unlikely but handled — the group classifier guards it).
function teamMemberLabel(name: string, group: TeamGroup): string {
  const short = name.includes(".") ? name.split(".").pop()! : name;
  if (group === "design" && short === "product_owner") return "Team Leader (Design Team)";
  return displayLabel(name);
}
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

// Layered depth computation:
//
//   layer(orchestrator) = 0  — the hub sits at the centre and can
//                              dispatch to anyone, so it doesn't
//                              constrain anyone else's position.
//   layer(X)            = 1 + max(layer of every specialist that
//                                 feeds X via a directed edge)
//                       = 1  when X has no specialist feeder (i.e. it
//                            only receives work from the orchestrator).
//
// Edges from the orchestrator are deliberately IGNORED for layering —
// otherwise every reachable agent would collapse to layer 1. What
// actually matters is the chain of specialist→specialist hand-offs:
// an agent that depends on another's output should sit one ring
// further out, so the diagram reads like a real flow.
function computeDepths(team: Team): Map<string, number> {
  const out = new Map<string, number>();
  if (!team.agents.length) return out;
  const orchName =
    team.agents.find(a => a.name === "orchestrator")?.name ??
    team.agents.find(a => a.base === "orchestrator")?.name ??
    team.agents[0].name;
  out.set(orchName, 0);
  // Synthetic Critic — when present in the augmented team, it sits at
  // the same layer as the orchestrator. They are peers: the critic
  // reviews orchestrator output and stands in for the user when
  // Director Mode is on, so it never depends on a specialist.
  if (team.agents.some(a => a.name === CRITIC_AGENT_NAME && a.name !== orchName)) {
    out.set(CRITIC_AGENT_NAME, 0);
  }

  // Predecessor set per agent, EXCLUDING orchestrator-originated edges.
  // (e.source === orchName) is skipped because the orchestrator is a
  // universal source — it doesn't tell us where the target sits in the
  // specialist-to-specialist flow.
  const preds = new Map<string, Set<string>>();
  for (const a of team.agents) preds.set(a.name, new Set());
  for (const e of team.edges) {
    if (e.source === orchName) continue;
    if (preds.has(e.target)) preds.get(e.target)!.add(e.source);
  }

  // Seed every non-orchestrator (and non-critic — the critic is a
  // layer-0 peer, not a specialist) at layer 1, then relax: layer of
  // node = max(layer of predecessors) + 1. Bounded iteration so a
  // cyclic routing graph (rare but legal) can't spin forever — N+5
  // passes is plenty to converge for any topology that fits on the
  // canvas.
  const specialists = team.agents.map(a => a.name).filter(n => n !== orchName && n !== CRITIC_AGENT_NAME);
  for (const n of specialists) out.set(n, 1);
  let changed = true;
  let iter = 0;
  while (changed && iter < specialists.length + 5) {
    changed = false;
    iter++;
    for (const n of specialists) {
      const ps = preds.get(n)!;
      let maxPred = 0;
      for (const p of ps) {
        const pd = out.get(p) ?? 0;
        if (pd > maxPred) maxPred = pd;
      }
      const wanted = maxPred + 1;
      if (wanted > (out.get(n) ?? 1)) {
        out.set(n, wanted);
        changed = true;
      }
    }
  }

  // Layered post-processing — 4 fixed rows:
  //   0: orchestrator + synthetic Critical Thinker (peers at the top)
  //   1: team leader (product_owner) — alone on this row
  //   2: non-critic specialists from any team (design + build)
  //   3: critics (design_critic, code_critic) — one layer below the
  //      specialists whose work they review
  // The natural predecessor chain already handles row 3 (a critic
  // whose predecessors are at depth 2 lands at depth 3). What we need
  // to fix is the build-team direct reports who'd naturally land at
  // depth 1 (under the orchestrator) but should sit visually at the
  // specialist row alongside the design team. So we pin EVERY
  // non-leader, non-critic agent to depth 2.
  const isCriticBase = (base: string): boolean => {
    const short = base.includes(".") ? base.split(".").pop()! : base;
    return short === "design_critic" || short === "code_critic" || short === "critic";
  };
  for (const a of team.agents) {
    const name = a.name;
    if (name === orchName) continue;
    if (name === CRITIC_AGENT_NAME) continue;
    const shortBase = a.base.includes(".") ? a.base.split(".").pop()! : a.base;
    const shortName = name.includes(".") ? name.split(".").pop()! : name;
    const isTeamLeader = shortBase === "product_owner" || shortName === "product_owner";
    if (isTeamLeader) {
      out.set(name, 1);
    } else if (isCriticBase(a.base) || isCriticBase(name)) {
      // Critic: keep its natural depth from the predecessor chain (so
      // a design_critic whose inputs are at depth 2 ends up at 3). If
      // it somehow has no predecessors, default to 3.
      const natural = out.get(name) ?? 1;
      out.set(name, Math.max(natural, 3));
    } else {
      // Every other specialist sits on row 2, regardless of whether
      // its team has a leader or it reports directly to the
      // orchestrator. This is what makes design and build specialists
      // share a row.
      out.set(name, 2);
    }
  }
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
// Cancel, 📊 telemetry, 🔊 voice with ▾ menu caret. Images + audio
// can be attached via the 📎 button (file picker) or dropped onto the
// input. Each attachment becomes a chip rendered just under the row.

const MAX_ATTACH_BYTES = 20 * 1024 * 1024; // 20 MB per file, in-memory base64

/// Browser File -> Attachment. Reads as base64 via FileReader. Throws
/// when the MIME isn't image/* or audio/*, or when the file exceeds
/// MAX_ATTACH_BYTES (would balloon the request body unmanageably).
async function fileToAttachment(file: File): Promise<Attachment> {
  if (file.size > MAX_ATTACH_BYTES) {
    throw new Error(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB — limit is ${MAX_ATTACH_BYTES / 1024 / 1024} MB.`);
  }
  const mime = file.type || "application/octet-stream";
  const kind: "image" | "audio" =
    mime.startsWith("image/") ? "image"
    : mime.startsWith("audio/") ? "audio"
    : (() => { throw new Error(`Unsupported file type: ${mime || "(unknown)"} — pick an image or audio file.`); })();
  // FileReader.readAsDataURL → "data:<mime>;base64,<payload>". We only
  // want the base64 payload so the carrier stays uniform across
  // browser-attached files and Telegram-downloaded bytes.
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error ?? new Error("read failed"));
    fr.readAsDataURL(file);
  });
  const comma = dataUrl.indexOf(",");
  const data_b64 = comma >= 0 ? dataUrl.slice(comma + 1) : "";
  return { kind, mime, data_b64, filename: file.name };
}

function GoalRow({ goal, setGoal, onRun, onCancel, busy, attachments, setAttachments }: {
  goal: string; setGoal: (g: string) => void;
  onRun: () => void; onCancel: () => void; busy: boolean;
  attachments: Attachment[]; setAttachments: (a: Attachment[]) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);

  const addFiles = async (files: FileList | File[] | null | undefined) => {
    if (!files || (Array.isArray(files) ? files.length : files.length) === 0) return;
    setAttachError(null);
    const arr = Array.isArray(files) ? files : Array.from(files);
    const next: Attachment[] = [];
    for (const f of arr) {
      try {
        next.push(await fileToAttachment(f));
      } catch (e: any) {
        setAttachError(String(e?.message ?? e));
      }
    }
    if (next.length > 0) setAttachments([...attachments, ...next]);
  };

  const onPickClick = () => fileInputRef.current?.click();
  const onPickChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(e.target.files);
    // Reset value so picking the same file twice still fires onChange.
    e.target.value = "";
  };
  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setDragOver(true); };
  const onDragLeave = () => setDragOver(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    addFiles(e.dataTransfer?.files);
  };
  const removeAttachment = (i: number) => {
    const next = attachments.slice();
    next.splice(i, 1);
    setAttachments(next);
  };

  return (
    <div style={{ padding:"0 23px", margin:"12px 0", background:"transparent" }}>
      <div style={{ height:38, display:"flex", alignItems:"center", gap:10 }}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,audio/*"
          multiple
          style={{ display:"none" }}
          onChange={onPickChange}
        />
        <button
          data-ui="GoalAttachBtn"
          onClick={onPickClick}
          title="Attach images or audio (also: drop files onto the input)"
          style={{ height:38, minWidth:44, padding:"0 10px", border:"none", borderRadius:10, background:"var(--bg-surface)", color:"var(--fg)", fontSize:16, cursor:"pointer" }}
        >📎</button>
        <input data-ui="GoalInput"
          value={goal}
          onChange={e => setGoal(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !busy) onRun(); }}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          placeholder="Goal — e.g. 'summarise the last commit and propose a follow-up' (drop an image / audio here)"
          style={{ flex:1, height:38, borderRadius:10, padding:"0 14px", fontSize:13, background:"var(--bg-input)", color:"var(--fg-strong)", border: dragOver ? "1px dashed rgba(124,196,255,0.85)" : "1px solid transparent" }} />
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
      {(attachments.length > 0 || attachError) && (
        <div data-ui="GoalAttachStrip" style={{ marginTop:6, display:"flex", flexWrap:"wrap", gap:6 }}>
          {attachments.map((a, i) => (
            <span
              key={i}
              title={`${a.mime} · ${Math.round(a.data_b64.length * 3 / 4 / 1024)} KB`}
              style={{ display:"inline-flex", alignItems:"center", gap:6, padding:"2px 6px 2px 8px", borderRadius:14, fontSize:11, background:"rgba(124,196,255,0.12)", color:"var(--fg-strong)", border:"1px solid rgba(124,196,255,0.30)" }}
            >
              <span style={{ opacity:0.7 }}>{a.kind === "image" ? "🖼" : "🎵"}</span>
              <span style={{ maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{a.filename ?? a.mime}</span>
              <button
                onClick={() => removeAttachment(i)}
                title="Remove"
                style={{ border:"none", background:"transparent", color:"var(--fg-muted)", cursor:"pointer", padding:0, lineHeight:1, fontSize:14 }}
              >×</button>
            </span>
          ))}
          {attachError && (
            <span style={{ fontSize:11, color:"#ff8c8c" }}>{attachError}</span>
          )}
        </div>
      )}
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
// Now with a "TEAM MODEL" row at the bottom: a single select that
// assigns the model to EVERY agent on the team at once (clears per-
// agent overrides so the team genuinely runs on one model again).
function TeamInfoCard({
  team, models, teamModel, onChangeTeamModel, serverModelId, accountsStatus,
}: {
  team: Team | null;
  models: ModelInfo[];
  teamModel: string;
  onChangeTeamModel: (id: string) => void;
  serverModelId: string | null;
  accountsStatus: AccountsStatusLite | null;
}) {
  // +90 px wide / +100 px tall over the previous 320×312 — matches
  // AgentInfoCard so the two variants swap in place without a layout
  // shift (user spec 2026-05-20).
  const CARD_W = 410;
  const CARD_H = 412;
  if (!team) {
    return (
      <div data-ui="TeamInfoCard" style={{ width:CARD_W, height:CARD_H, borderRadius:12, background:"var(--bg-panel)", border:"1px dashed rgba(255,220,90,0.20)", display:"flex", alignItems:"center", justifyContent:"center", padding:20, textAlign:"center", color:"var(--fg-subtle)", fontSize:12 }}>
        Pick a project on the strip, or click <b style={{ margin:"0 4px" }}>Team…</b> to load a template onto the canvas.
      </div>
    );
  }
  const pic_x = 14, pic_y = 46, pic_size = 100;
  const info_x = pic_x + pic_size + 18;
  const info_y = pic_y - 4;
  const info_w = CARD_W - 14 - info_x;
  // AGENTS / CONNECTIONS now live below the picture as full-width
  // rows so they stay readable when long values appear (and to mirror
  // the BASE/TEMP layout on AgentInfoCard).
  const stat_y = pic_y + pic_size + 14;
  const model_y = stat_y + 22 * 2 + 18;
  const desc = team.description.length > 200 ? team.description.slice(0, 197) + "…" : team.description;
  // Original cyan→purple palette — yellow tones live on the SuperUserCard
  // only (user clarified 2026-05-20).
  const cardBg = "linear-gradient(135deg, rgba(18,22,34,0.90) 0%, rgba(8,11,18,0.90) 100%)";
  const borderGrad = "linear-gradient(135deg, rgba(92,240,255,0.86) 0%, rgba(192,138,255,0.86) 100%)";
  return (
    <div data-ui="TeamInfoCard" style={{ position:"relative", width:CARD_W, height:CARD_H, borderRadius:12, background:cardBg, border:"1.6px solid transparent", overflow:"hidden" }}>
      <div style={{ position:"absolute", inset:0, borderRadius:12, padding:"1.6px", background:borderGrad, WebkitMask:"linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)", WebkitMaskComposite:"xor", maskComposite:"exclude", pointerEvents:"none" }} />
      {/* Header — team name in place of the old "● CATEGORY" ribbon
          (user spec 2026-05-20). Category survives as a small cyan chip
          inline so the user still sees what kind of team it is. */}
      <div data-ui="TeamHeader" style={{ position:"absolute", left:8, top:8, width:CARD_W - 16, height:28, display:"flex", alignItems:"center", gap:8, paddingLeft:8, fontSize:14, fontWeight:700, color:"var(--fg)", overflow:"hidden" }}>
        <span style={{ flex:"0 1 auto", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }} title={team.display}>{team.display}</span>
        <span style={{
          background: "rgba(92,240,255,0.18)",
          color: "#a8e8ff",
          border: "1px solid rgba(92,240,255,0.45)",
          fontSize: 9, fontWeight: 800, letterSpacing: 0.4,
          padding: "2px 7px", borderRadius: 8,
          textTransform:"uppercase", whiteSpace:"nowrap", flexShrink:0,
        }}>{team.category}</span>
      </div>
      <div style={{ position:"absolute", left:pic_x - 6, top:pic_y - 6, width:pic_size + 12, height:pic_size + 12, borderRadius:"50%", background:"radial-gradient(circle, rgba(92,240,255,0.43) 0%, rgba(92,240,255,0) 100%)", pointerEvents:"none" }} />
      <div style={{ position:"absolute", left:pic_x, top:pic_y, width:pic_size, height:pic_size, borderRadius:"50%", background:"#1e2434", border:"1.4px solid rgba(230,240,255,0.78)", display:"flex", alignItems:"center", justifyContent:"center", overflow:"hidden" }}>
        <img src={owlSrc(team.icon)} style={{ width:pic_size * 0.85, height:pic_size * 0.85, objectFit:"contain" }} />
      </div>
      <div style={{ position:"absolute", left:info_x, top:info_y, width:info_w, height:pic_size + 8, fontSize:12, color:"var(--fg)", fontFamily:"Segoe UI", lineHeight:1.35, overflow:"hidden" }}>
        {desc || <span style={{ color:"var(--fg-muted)" }}>(no description)</span>}
      </div>
      {/* AGENTS row — full card width. */}
      <div style={{ position:"absolute", left:14, top:stat_y, width:CARD_W - 28, height:22, display:"flex", alignItems:"center", gap:8, fontSize:13, color:"var(--fg)", fontFamily:"Segoe UI" }}>
        <span style={{ fontSize:11, fontWeight:700, color:"var(--fg-muted)", letterSpacing:0.4, width:86 }}>AGENTS</span>
        <span style={{ flex:1, fontWeight:700 }}>{team.agents.length}</span>
      </div>
      {/* CONNECTIONS row — same shape, on its own line. */}
      <div style={{ position:"absolute", left:14, top:stat_y + 22, width:CARD_W - 28, height:22, display:"flex", alignItems:"center", gap:8, fontSize:13, color:"var(--fg)", fontFamily:"Segoe UI" }}>
        <span style={{ fontSize:11, fontWeight:700, color:"var(--fg-muted)", letterSpacing:0.4, width:86 }}>CONNECTIONS</span>
        <span style={{ flex:1, fontWeight:700 }}>{team.edges.length}</span>
      </div>
      {/* MODEL row — applies to every agent on the team. */}
      <div style={{ position:"absolute", left:14, top:model_y, width:CARD_W - 28, height:14, display:"flex", alignItems:"center", fontSize:11, fontWeight:700, color:"var(--fg-muted)", fontFamily:"Segoe UI", letterSpacing:0.4 }}>
        <span style={{ flex:1 }}>TEAM MODEL · assigns to every agent</span>
      </div>
      <div style={{ position:"absolute", left:14, top:model_y + 16, width:CARD_W - 28, display:"flex" }}>
        <ModelPicker
          value={teamModel}
          onChange={onChangeTeamModel}
          models={models}
          status={accountsStatus}
          fallbackLabel={
            serverModelId
              ? `(use server model · ${serverModelId})`
              : "(use server model — start one on the Server tab)"
          }
        />
      </div>
    </div>
  );
}

// AgentInfoCard — mirrors agent_info_card.py::paint_agent_card. Shown
// in place of TeamInfoCard when an agent is selected on the canvas
// (orbital OR graph view). Status ribbon → name → portrait + desc →
// model picker for that agent. Click the canvas background OR press X
// here to deselect.
function AgentInfoCard({
  team, spec, roleByName, status,
  models, modelId, onPickModel, accountsStatus, fallbackLabel,
  onClose,
}: {
  team: Team | null;
  spec: AgentSpec;
  roleByName: Map<string, RoleData>;
  status: "idle" | "active" | "pending" | "error";
  models: ModelInfo[];
  modelId: string;
  onPickModel: (id: string) => void;
  accountsStatus: AccountsStatusLite | null;
  fallbackLabel: string;
  onClose: () => void;
}) {
  // +90 px over the previous 320 (user spec 2026-05-20) — more room
  // for BASE values, description, and the model picker.
  const CARD_W = 410;
  // +100 px over the previous 312 (same spec). The extra vertical
  // space lets BASE/TEMP live as full-width ROWS instead of two
  // columns (where the BASE model id used to get truncated).
  const CARD_H = 412;
  const role = roleByName.get(spec.base);
  const desc =
    (spec.description && spec.description.trim()) ||
    (role?.description && role.description.trim()) ||
    "No description provided.";
  const trimmed = desc.length > 200 ? desc.slice(0, 197) + "…" : desc;
  const statusDot = status === "active" ? "#3cf26b" : status === "pending" ? "#ffc060" : status === "error" ? "#ff7878" : "#9aa8c2";
  const pic_x = 14, pic_y = 46, pic_size = 100;
  const info_x = pic_x + pic_size + 18;
  const info_y = pic_y - 4;
  const info_w = CARD_W - 14 - info_x;
  // BASE / TEMP now live below the picture as full-width rows so long
  // model ids don't get clipped. stat_y = below the picture; model_y =
  // below the two rows. Each row is 22 px tall.
  const stat_y = pic_y + pic_size + 14;
  const model_y = stat_y + 22 * 2 + 18;
  const group = groupForAgent(spec);
  const tint = tintForGroup(group);
  // Card body picks up the agent's group tint so design / build /
  // critic each read at a glance. Critic keeps its rainbow border
  // overlay; the others get the original cyan→purple border gradient.
  // (Yellow tones live on the SuperUserCard only — user clarified
  // 2026-05-20.)
  const cardBg = group === "critic"
    ? "linear-gradient(135deg, rgba(18,22,34,0.90) 0%, rgba(8,11,18,0.90) 100%)"
    : `linear-gradient(135deg, ${tint.bg} 0%, rgba(8,11,18,0.90) 100%)`;
  // teamMemberLabel was used both below the pic AND for the badge
  // text — now the agent name lives in the top header strip, so the
  // below-pic centred label is dropped to remove the duplicate.
  const headerName = teamMemberLabel(spec.name, group);
  return (
    <div data-ui="AgentInfoCard" style={{ position:"relative", width:CARD_W, height:CARD_H, borderRadius:12, background:cardBg, border:"1.6px solid transparent", overflow:"hidden" }}>
      {group === "critic" ? (
        <div style={{ position:"absolute", inset:0, borderRadius:12, padding:"1.6px", background:"conic-gradient(from 0deg, #ff5e7e, #ffb84c, #ffe14c, #6cff5e, #5ec6ff, #b86cff, #ff5e7e)", WebkitMask:"linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)", WebkitMaskComposite:"xor", maskComposite:"exclude", pointerEvents:"none" }} />
      ) : (
        <div style={{ position:"absolute", inset:0, borderRadius:12, padding:"1.6px", background:`linear-gradient(135deg, ${tint.border} 0%, rgba(192,138,255,0.50) 100%)`, WebkitMask:"linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)", WebkitMaskComposite:"xor", maskComposite:"exclude", pointerEvents:"none" }} />
      )}
      {/* Header — agent name + team badge on one line. Replaces the
          old "● STANDBY/ACTIVE/PENDING/ERROR" status ribbon (user spec
          2026-05-20). Status survives as a small coloured dot tucked
          to the right of the name; team badge sits inline next to it. */}
      <div data-ui="AgentHeader" style={{ position:"absolute", left:8, top:8, width:CARD_W - 16 - 28, height:28, display:"flex", alignItems:"center", gap:6, paddingLeft:8, fontSize:14, fontWeight:700, color:"var(--fg)", overflow:"hidden" }}>
        <span style={{ width:8, height:8, borderRadius:4, background:statusDot, flexShrink:0 }} title={status} />
        <span style={{ flex:"0 1 auto", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }} title={headerName}>{headerName}</span>
        {tint.badge && (
          <span data-ui="AgentGroupBadge" style={{
            background: group === "design" ? "rgba(64, 168, 96, 0.95)" : "rgba(58, 120, 220, 0.95)",
            color: "#0a1208",
            fontSize: 9, fontWeight: 800, letterSpacing: 0.4,
            padding: "2px 7px", borderRadius: 8,
            textTransform:"uppercase", whiteSpace:"nowrap", flexShrink:0,
          }}>{tint.badge}</span>
        )}
      </div>
      <button onClick={onClose} title="Close (or click empty canvas)" style={{ position:"absolute", right:8, top:8, width:22, height:22, padding:0, border:"none", background:"rgba(255,255,255,0.06)", color:"var(--fg)", borderRadius:6, fontSize:12, cursor:"pointer", zIndex:2 }}>✕</button>
      <div style={{ position:"absolute", left:pic_x - 6, top:pic_y - 6, width:pic_size + 12, height:pic_size + 12, borderRadius:"50%", background:`radial-gradient(circle, ${statusDot}55 0%, ${statusDot}00 100%)`, pointerEvents:"none" }} />
      <div style={{ position:"absolute", left:pic_x, top:pic_y, width:pic_size, height:pic_size, borderRadius:"50%", background:"#1e2434", border:"1.4px solid rgba(230,240,255,0.78)", display:"flex", alignItems:"center", justifyContent:"center", overflow:"hidden" }}>
        <img src={owlSrc(agentIconRef(spec, roleByName))} style={{ width:pic_size * 0.85, height:pic_size * 0.85, objectFit:"contain" }} />
      </div>
      <div style={{ position:"absolute", left:info_x, top:info_y, width:info_w, height:pic_size + 8, fontSize:12, color:"var(--fg)", lineHeight:1.35, overflow:"hidden" }}>
        {trimmed}
      </div>
      {/* BASE row — full card width. Long model ids no longer get
          clipped to the 90-px column they used to share with TEMP. */}
      <div style={{ position:"absolute", left:14, top:stat_y, width:CARD_W - 28, height:22, display:"flex", alignItems:"center", gap:8, fontSize:13, color:"var(--fg)", fontFamily:"Segoe UI" }}>
        <span style={{ fontSize:11, fontWeight:700, color:"var(--fg-muted)", letterSpacing:0.4, width:46 }}>BASE</span>
        <span style={{ flex:1, fontWeight:700, textTransform:"capitalize", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{spec.base}</span>
      </div>
      {/* TEMP row — same shape, on its own line. */}
      <div style={{ position:"absolute", left:14, top:stat_y + 22, width:CARD_W - 28, height:22, display:"flex", alignItems:"center", gap:8, fontSize:13, color:"var(--fg)", fontFamily:"Segoe UI" }}>
        <span style={{ fontSize:11, fontWeight:700, color:"var(--fg-muted)", letterSpacing:0.4, width:46 }}>TEMP</span>
        <span style={{ flex:1, fontWeight:700 }}>{(role?.defaultTemperature ?? 0.4).toFixed(2)}</span>
      </div>
      <div style={{ position:"absolute", left:14, top:model_y, width:CARD_W - 28, height:14, display:"flex", alignItems:"center", fontSize:11, fontWeight:700, color:"var(--fg-muted)", letterSpacing:0.4 }}>
        <span style={{ flex:1 }}>MODEL · this agent only</span>
      </div>
      <div style={{ position:"absolute", left:14, top:model_y + 16, width:CARD_W - 28, display:"flex" }}>
        <ModelPicker
          value={modelId}
          onChange={onPickModel}
          models={models}
          status={accountsStatus}
          fallbackLabel={fallbackLabel}
        />
      </div>
    </div>
  );
}

// SuperUserCard — widgets/super_user_card.py::SuperUserCard. The chat
// pane is empty by default (no fake "You: …" / "Team: …" prefill).
//
// Draft persistence: AgentsPage unmounts whenever the user switches tabs
// (Server, Studio, etc.), so the in-progress message in the input box
// would otherwise be wiped. Keying by projectId so each project keeps
// its own draft.
function SuperUserCard({ team, roleByName, chat, onSend, autoApprove, onToggleAutoApprove, projectId, directives, onDirectivesChanged, directorMode, onToggleDirectorMode }: {
  team: Team | null;
  roleByName: Map<string, RoleData>;
  chat: GoalMsg[];
  onSend: (text: string) => void;
  autoApprove: boolean;
  onToggleAutoApprove: () => void;
  projectId: string;
  directives: Directive[];
  /// Trigger a re-fetch of the project's rules after an inline add /
  /// edit / delete so the list updates without remounting the card.
  onDirectivesChanged: () => Promise<void> | void;
  directorMode: boolean;
  onToggleDirectorMode: () => void;
}) {
  const peekAgents = (team?.agents ?? []).slice(0, 6);
  const draftKey = projectId ? `owllm:supdraft:${projectId}` : "";
  // Hold the storage key in a ref so the keystroke handler can write
  // synchronously without going through a useEffect (the previous
  // version had a race: when projectId arrived asynchronously, the
  // load-effect and the write-effect both fired in the same render
  // cycle and the write fired with the stale empty draft, wiping the
  // saved value before the load-effect's setDraft re-rendered).
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  const [draft, setDraftState] = useState<string>(() => {
    if (!draftKey) return "";
    try { return localStorage.getItem(draftKey) ?? ""; } catch { return ""; }
  });
  // Reload draft when projectId changes (e.g., user picks a different
  // project on the strip while the page is mounted). Pure load — no
  // write side-effect, so no race with setDraft.
  useEffect(() => {
    if (!draftKey) { setDraftState(""); return; }
    try { setDraftState(localStorage.getItem(draftKey) ?? ""); } catch { setDraftState(""); }
  }, [draftKey]);
  // Write through to localStorage on every keystroke — synchronous, no
  // useEffect. Survives page navigation immediately.
  const setDraft = (v: string) => {
    setDraftState(v);
    const k = draftKeyRef.current;
    if (k) {
      try { localStorage.setItem(k, v); } catch {}
    }
  };
  // Show the last 30 turns in the scroll pane so a long conversation
  // still fits while extremely old turns get GC'd from the visible UI.
  const lastMessages = chat.slice(-30);
  // Autoscroll the SuperUserCard chat pane to its bottom on every new
  // message AND on each streamed delta (we hash the tail length so the
  // effect re-fires per-chunk while the LLM is still producing). Also
  // fires on project switch so the saved chat lands at its bottom.
  const suChatRef = useRef<HTMLDivElement>(null);
  const suTailSig = `${lastMessages.length}:${lastMessages[lastMessages.length - 1]?.text?.length ?? 0}`;
  useLayoutEffect(() => {
    const el = suChatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [suTailSig, projectId]);
  const submit = () => {
    const t = draft.trim();
    if (!t) return;
    onSend(t);
    setDraft("");
  };
  // Two embedded "pages" inside the card (user spec 2026-05-20):
  //   Chat  — the multi-line input + sent log
  //   Rules — full inline add / edit / delete UI for project rules
  // Default to Chat so the SEND-first ergonomics stay intact.
  const [activeTab, setActiveTab] = useState<"chat" | "rules">("chat");
  // Inline-rules state — ports the DirectivesPanel modal's add / edit
  // logic into the card so the user never leaves the canvas to manage
  // the project's rules (user spec 2026-05-20).
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
      await onDirectivesChanged();
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
  return (
    // Width:320 + margin:"8px 0 0 0" so the card lines up flush left
    // with the info card above it (both sit at the container's left
    // edge — user spec 2026-05-20). Yellow tones to match the info
    // card; subtle amber border instead of the previous neutral one.
    <div data-ui="SuperUserCard" style={{ margin:"8px 0 0 0", padding:"10px 12px", borderRadius:12, background:"linear-gradient(135deg, rgba(38,30,10,0.92) 0%, rgba(18,14,4,0.92) 100%)", border:"1px solid rgba(255,200,80,0.35)", width:410, minHeight:180, display:"flex", flexDirection:"column", gap:8 }}>
      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
        <div data-ui="suAvatar" style={{ width:28, height:28, borderRadius:16, background:"#2a2410", display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, color:"var(--fg)" }}>👤</div>
        <div style={{ flex:1, minWidth:0 }}>
          <div data-ui="suName" style={{ fontSize:16, fontWeight:700, color:"var(--fg)", lineHeight:"22px" }}>Super User</div>
          <div data-ui="suHint" style={{ fontSize:12, color:"var(--fg-subtle)", letterSpacing:0.4, textTransform:"uppercase", lineHeight:1.4 }}>
            {chat.length > 0 ? `${chat.length} message${chat.length === 1 ? "" : "s"} in this run` : "idle — team pings you here"}
          </div>
        </div>
        <button data-ui="suIconBtn" title="Open chat in a side panel (4:5, full window height, docked right)" style={{ width:30, height:26, padding:0, background:"#2a2410", color:"var(--fg)", border:"1px solid #3a3018", borderRadius:6, fontSize:14, fontWeight:700 }}>⇱⇲</button>
        <button data-ui="suIconBtn" title="Notification settings (Telegram, etc.)" style={{ width:26, height:26, padding:0, background:"#2a2410", color:"var(--fg)", border:"1px solid #3a3018", borderRadius:6, fontSize:16, fontWeight:700 }}>⚙</button>
      </div>
      {peekAgents.length > 0 && (
        <div data-ui="suTeamPeek" style={{ display:"flex", alignItems:"center", gap:4, padding:"0 2px" }}>
          {peekAgents.map((a, i) => (
            <img key={i} src={owlSrc(agentIconRef(a, roleByName))} title={displayLabel(a.name)} style={{ width:20, height:20, opacity:0.85, filter:"drop-shadow(0 1px 1px rgba(0,0,0,0.5))" }} />
          ))}
          <div style={{ fontSize:10, color:"var(--fg-subtle)", letterSpacing:0.4, textTransform:"uppercase", marginLeft:4 }}>{team?.agents.length ?? 0} agents on team</div>
        </div>
      )}
      {/* Tab strip — Chat / Rules. Always rendered so the user sees
          the count of rules even without opening the tab. */}
      <div data-ui="suTabs" style={{ display:"flex", gap:4, borderBottom:"1px solid rgba(255,200,80,0.22)" }}>
        {([
          { id: "chat" as const,  label: "💬 Chat" },
          { id: "rules" as const, label: `📋 Rules (${directives.length})` },
        ]).map(t => {
          const on = activeTab === t.id;
          return (
            <button
              key={t.id}
              data-ui={`suTab-${t.id}`}
              onClick={() => setActiveTab(t.id)}
              style={{
                flex:1, height:26, padding:"0 10px",
                background: on ? "rgba(255,200,80,0.18)" : "transparent",
                color: on ? "#ffd97a" : "var(--fg-muted)",
                border: "none",
                borderBottom: on ? "2px solid #ffd97a" : "2px solid transparent",
                fontSize:12, fontWeight:700, cursor:"pointer",
              }}
            >{t.label}</button>
          );
        })}
      </div>
      {activeTab === "chat" ? (
        <>
          {/* Sent-by-you log — replies from the orchestrator/agents are NOT
              shown here (user spec 2026-05-18). The card is just for SENDING
              input now; replies are visible elsewhere (the agent info panel,
              the Run log). Empty filter result yields a brief idle hint so
              the card doesn't collapse to zero height. */}
          {(() => {
            const sentByMe = lastMessages.filter(m => m.role === "you");
            return (
              <div ref={suChatRef} data-ui="suChat" style={{ height: 120, background:"rgba(20,16,4,0.6)", color:"var(--fg)", border:"1px solid rgba(255,200,80,0.20)", borderRadius:8, padding:"8px 10px", fontSize:13, lineHeight:1.5, overflow:"auto", display:"flex", flexDirection:"column", gap:6 }}>
                {sentByMe.length === 0 ? (
                  <div style={{ color:"var(--fg-subtle)", fontStyle:"italic" }}>
                    {team
                      ? "Type below — your input lands here. Replies appear in the agent panel."
                      : "Pick a project or team template to begin."}
                  </div>
                ) : sentByMe.map((m, i) => (
                  <div key={i} style={{ color:"var(--fg)", whiteSpace:"pre-wrap", fontFamily:"Segoe UI, sans-serif" }}>
                    {m.text}
                  </div>
                ))}
              </div>
            );
          })()}
          {/* Multi-line input — textarea instead of input so long
              prompts wrap and stay fully visible. Enter sends; Shift+
              Enter inserts a newline. Vertical resize lets the user
              expand if their prompt is huge; the default 3 rows + auto
              overflow keeps short prompts compact. */}
          <div data-ui="suInputRow" style={{ display:"flex", alignItems:"flex-end", gap:8 }}>
            <textarea
              data-ui="suReply"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Reply to the team — Enter to send, Shift+Enter for new line"
              rows={3}
              style={{
                flex:1, minHeight:64, maxHeight:200,
                borderRadius:8, padding:"8px 10px",
                background:"rgba(20,16,4,0.6)", color:"var(--fg)",
                fontSize:14, lineHeight:1.4,
                border:"1px solid rgba(255,200,80,0.25)",
                resize:"vertical",
                fontFamily:"Segoe UI, sans-serif",
                outline:"none",
              }}
            />
            <button
              data-ui="suSend"
              onClick={submit}
              disabled={!draft.trim()}
              style={{
                height:32, padding:"6px 14px", borderRadius:8,
                border:"1px solid #ffd97a",
                background: draft.trim() ? "#ffd97a" : "rgba(255,217,122,0.25)",
                color: draft.trim() ? "#1a1404" : "#7d6f4b",
                fontSize:13, fontWeight:700,
                cursor: draft.trim() ? "pointer" : "not-allowed",
              }}
            >Send</button>
          </div>
          <label data-ui="suTrust" style={{ display:"flex", alignItems:"center", gap:6, fontSize:13, color: autoApprove ? "#ff8c8c" : "#7888a8", cursor:"pointer" }}>
            <input type="checkbox" checked={autoApprove} onChange={onToggleAutoApprove} style={{ width:12, height:12, accentColor:"#ff6060" }} />
            <span>auto-approve tool requests</span>
          </label>
          {/* Director Mode lives here because it's a per-run toggle that
              belongs next to the chat input. The full add/edit panel is
              reachable from the Rules tab. */}
          <div data-ui="suDirectorRow" style={{ display:"flex", alignItems:"center", gap:8, justifyContent:"space-between" }}>
            <label style={{ display:"flex", alignItems:"center", gap:6, fontSize:13, color: directorMode ? "#9af0a8" : "#7888a8", cursor:"pointer" }}>
              <input type="checkbox" checked={directorMode} onChange={onToggleDirectorMode} style={{ width:12, height:12, accentColor:"#60ff80" }} />
              <span>director mode (critic stands in for me)</span>
            </label>
          </div>
        </>
      ) : (
        // Rules tab — full inline add / edit / delete UI. No more
        // popup modal: the user manages project rules right inside
        // the card (user spec 2026-05-20).
        <div data-ui="suRules" style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {/* Add-rule row — kind dropdown + text input + + button. */}
          <div data-ui="suRulesAdd" style={{ display:"flex", alignItems:"center", gap:6 }}>
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
                flex:1, height:28, borderRadius:6, padding:"0 8px",
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
          {/* Rule list — grouped by kind, each row has Edit + Delete
              inline. While editing, the row swaps to inline form. */}
          <div style={{ background:"rgba(20,16,4,0.6)", border:"1px solid rgba(255,200,80,0.20)", borderRadius:8, padding:"8px 10px", maxHeight:220, overflow:"auto", fontSize:12, color:"var(--fg)", display:"flex", flexDirection:"column", gap:6 }}>
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
                          style={{ flex:1, height:24, borderRadius:4, padding:"0 6px", background:"rgba(20,16,4,0.6)", color:"var(--fg)", border:"1px solid rgba(255,200,80,0.25)", fontSize:12 }}
                        />
                      </div>
                      <div style={{ display:"flex", gap:4, justifyContent:"flex-end" }}>
                        <button onClick={() => setEditingId(null)} disabled={rulesBusy} style={{ height:22, padding:"0 8px", borderRadius:4, border:"1px solid rgba(255,255,255,0.15)", background:"transparent", color:"var(--fg-muted)", fontSize:10, cursor:"pointer" }}>Cancel</button>
                        <button onClick={saveEdit} disabled={rulesBusy || !editText.trim()} style={{ height:22, padding:"0 10px", borderRadius:4, border:"1px solid #ffd97a", background:"#ffd97a", color:"#1a1404", fontSize:10, fontWeight:700, cursor:"pointer" }}>Save</button>
                      </div>
                    </div>
                  ) : (
                    <div key={d.id} style={{ display:"flex", alignItems:"flex-start", gap:6, paddingLeft:8, borderLeft:`2px solid ${kc}`, lineHeight:1.4 }}>
                      <span style={{ flex:1 }}>{d.text}</span>
                      <button onClick={() => beginEdit(d)} disabled={rulesBusy} title="Edit" style={{ width:22, height:22, padding:0, borderRadius:4, border:"none", background:"transparent", color:"var(--fg-muted)", fontSize:12, cursor:"pointer" }}>✏️</button>
                      <button onClick={() => deleteRule(d.id)} disabled={rulesBusy} title="Delete" style={{ width:22, height:22, padding:0, borderRadius:4, border:"none", background:"transparent", color:"#ff8c8c", fontSize:12, cursor:"pointer" }}>🗑</button>
                    </div>
                  )),
                ];
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/// Modal overlay listing the project's directives with inline add /
/// edit / delete. Mounted once at the AgentsPage level via the open
/// state held there; the SuperUserCard chip toggles that state.
function DirectivesPanel({ projectId, directives, onChanged, onClose }: {
  projectId: string;
  directives: Directive[];
  onChanged: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [newKind, setNewKind] = useState<"must" | "prefer" | "avoid">("must");
  const [newText, setNewText] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [editKind, setEditKind] = useState<"must" | "prefer" | "avoid">("must");

  const submit = async () => {
    const text = newText.trim();
    if (!text || !projectId) return;
    setBusy(true);
    try {
      await invoke("directives_add", { input: { projectId, kind: newKind, text } });
      setNewText("");
      await onChanged();
    } catch (e) {
      console.error("directives_add failed", e);
    } finally {
      setBusy(false);
    }
  };
  const beginEdit = (d: Directive) => {
    setEditingId(d.id);
    setEditText(d.text);
    setEditKind(d.kind);
  };
  const saveEdit = async () => {
    if (!editingId) return;
    setBusy(true);
    try {
      await invoke("directives_update", { input: { id: editingId, kind: editKind, text: editText } });
      setEditingId(null);
      await onChanged();
    } catch (e) {
      console.error("directives_update failed", e);
    } finally {
      setBusy(false);
    }
  };
  const doDelete = async (id: string) => {
    setBusy(true);
    try {
      await invoke("directives_delete", { id });
      await onChanged();
    } catch (e) {
      console.error("directives_delete failed", e);
    } finally {
      setBusy(false);
    }
  };

  const kindColor = (k: string) =>
    k === "must" ? "#ff8c8c" : k === "prefer" ? "#9af0a8" : "#ffd97a";
  const kindLabel = (k: string) => k.toUpperCase();
  const groups: Array<{ k: "must" | "prefer" | "avoid"; items: Directive[] }> = [
    { k: "must", items: directives.filter(d => d.kind === "must") },
    { k: "prefer", items: directives.filter(d => d.kind === "prefer") },
    { k: "avoid", items: directives.filter(d => d.kind === "avoid") },
  ];

  return (
    <div
      data-ui="DirectivesPanelOverlay"
      onClick={onClose}
      style={{
        position:"fixed", inset:0, background:"rgba(8,12,20,0.55)",
        display:"flex", alignItems:"center", justifyContent:"center",
        zIndex:1000,
      }}
    >
      <div
        data-ui="DirectivesPanel"
        onClick={e => e.stopPropagation()}
        style={{
          width: 560, maxHeight: "80vh", overflow:"auto",
          background:"var(--bg-elevated)", border:"1px solid var(--border)",
          borderRadius:12, padding:"16px 18px",
          display:"flex", flexDirection:"column", gap:12,
          boxShadow:"0 12px 40px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div>
            <div style={{ fontSize:16, fontWeight:700, color:"var(--fg)" }}>Project rules</div>
            <div style={{ fontSize:11, color:"var(--fg-subtle)", marginTop:2 }}>
              Applied to every agent's system prompt + the critic when director mode is on.
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ width:28, height:28, padding:0, borderRadius:6, border:"1px solid #2a3148", background:"#1a2030", color:"var(--fg)", cursor:"pointer", fontSize:14 }}
            title="Close"
          >✕</button>
        </div>

        {/* Add row */}
        <div style={{ display:"flex", gap:6, alignItems:"stretch" }}>
          <select
            value={newKind}
            onChange={e => setNewKind(e.target.value as any)}
            style={{ width:90, padding:"4px 6px", borderRadius:6, border:"1px solid #2a3148", background:"#0e1320", color:"var(--fg)", fontSize:12 }}
          >
            <option value="must">MUST</option>
            <option value="prefer">PREFER</option>
            <option value="avoid">AVOID</option>
          </select>
          <input
            value={newText}
            onChange={e => setNewText(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") submit(); }}
            placeholder="e.g. never mock data — always real DB calls"
            style={{ flex:1, padding:"4px 8px", borderRadius:6, border:"1px solid #2a3148", background:"#0e1320", color:"var(--fg)", fontSize:13 }}
          />
          <button
            onClick={submit}
            disabled={busy || !newText.trim()}
            style={{
              padding:"4px 14px", borderRadius:6,
              border:"1px solid #5cf0ff",
              background: newText.trim() ? "var(--accent)" : "rgba(92,240,255,0.25)",
              color: newText.trim() ? "var(--bg-elevated)" : "#7d8595",
              fontSize:12, fontWeight:700,
              cursor: newText.trim() ? "pointer" : "not-allowed",
            }}
          >Add</button>
        </div>

        {directives.length === 0 ? (
          <div style={{ padding:"24px 8px", textAlign:"center", color:"var(--fg-subtle)", fontStyle:"italic", fontSize:13 }}>
            No rules yet — add one above. Examples: "keep modules under 500 lines", "never use mocks in tests", "ship as production-ready, not prototype".
          </div>
        ) : (
          groups.filter(g => g.items.length > 0).map(g => (
            <div key={g.k} style={{ display:"flex", flexDirection:"column", gap:4 }}>
              <div style={{ fontSize:10, fontWeight:700, color: kindColor(g.k), letterSpacing:0.6 }}>{kindLabel(g.k)}</div>
              {g.items.map(d => (
                <div key={d.id} style={{ display:"flex", gap:6, alignItems:"flex-start", padding:"6px 8px", borderRadius:6, background:"#0e1320", border:"1px solid #1c2333" }}>
                  {editingId === d.id ? (
                    <>
                      <select
                        value={editKind}
                        onChange={e => setEditKind(e.target.value as any)}
                        style={{ width:80, padding:"2px 4px", borderRadius:4, border:"1px solid #2a3148", background:"#0e1320", color:"var(--fg)", fontSize:11 }}
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
                        style={{ flex:1, padding:"2px 6px", borderRadius:4, border:"1px solid #2a3148", background:"#0e1320", color:"var(--fg)", fontSize:13 }}
                      />
                      <button onClick={saveEdit} disabled={busy} style={{ padding:"2px 8px", fontSize:11, fontWeight:700, borderRadius:4, border:"1px solid #5cf0ff", background:"var(--accent)", color:"var(--bg-elevated)", cursor:"pointer" }}>Save</button>
                      <button onClick={() => setEditingId(null)} disabled={busy} style={{ padding:"2px 6px", fontSize:11, borderRadius:4, border:"1px solid #2a3148", background:"#1a2030", color:"var(--fg)", cursor:"pointer" }}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <div style={{ flex:1, fontSize:13, color:"var(--fg)", lineHeight:1.4 }}>{d.text}</div>
                      <button onClick={() => beginEdit(d)} title="Edit" style={{ width:24, height:22, padding:0, fontSize:11, borderRadius:4, border:"1px solid #2a3148", background:"#1a2030", color:"#9aa6c0", cursor:"pointer" }}>✎</button>
                      <button onClick={() => doDelete(d.id)} title="Delete" style={{ width:24, height:22, padding:0, fontSize:11, borderRadius:4, border:"1px solid #2a3148", background:"#1a2030", color:"#ff8c8c", cursor:"pointer" }}>✕</button>
                    </>
                  )}
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// TeamCanvas — agent_team_canvas.py's orbital diagram. Roster from
// the active team, depth from the routing graph.
//
// Pan + zoom: hold the mouse on empty space to drag the diagram around,
// scroll-wheel to zoom in/out (0.4×..3.0×, ~10% per notch). Mirrors the
// Shared canvas gesture model — used by BOTH the orbital diagram and
// the editable graph so pan/zoom feel identical across the two views.
//
// Bindings:
//   * Middle-mouse-button drag  → pan (anywhere on the canvas).
//     Left-button is reserved for the consumer (node-drag in graph
//     view, click-to-deselect in diagram view), so left-drag NEVER
//     pans here. The mousemove listener lives on document, not on the
//     container, so the drag survives the cursor leaving the canvas.
//   * Plain wheel                → zoom anchored on the cursor (content
//     point under the pointer stays put as the canvas scales).
//
// Returns ready-to-spread props + the transform string and pan/zoom
// state so consumers can reset on team/data change.
function useCanvasGestures(opts?: { minZoom?: number; maxZoom?: number; factor?: number }) {
  const minZoom = opts?.minZoom ?? 0.25;
  const maxZoom = opts?.maxZoom ?? 3.0;
  const factor = opts?.factor ?? 1.12;
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<null | { sx: number; sy: number; ox: number; oy: number }>(null);
  const [dragTick, setDragTick] = useState(0);

  // Mousedown on the container. Middle-button = start pan. Left and
  // right are passed through so the consumer's handlers (clicks,
  // node-drag) keep working unmodified.
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 1) return;
    e.preventDefault();
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y };
    setDragTick(t => t + 1);
  };

  // Move + up listeners ride on document so leaving the canvas mid-
  // drag doesn't freeze the pan. dragTick re-installs the listeners
  // whenever a fresh drag starts so they capture the latest closure.
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setPan({ x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) });
    };
    const up = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      setDragTick(t => t + 1);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
  }, [dragTick]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    const f = e.deltaY < 0 ? factor : 1 / factor;
    const newZoom = Math.max(minZoom, Math.min(maxZoom, zoom * f));
    if (!rect) { setZoom(newZoom); return; }
    const cx = (e.clientX - rect.left - pan.x) / zoom;
    const cy = (e.clientY - rect.top - pan.y) / zoom;
    setPan({
      x: e.clientX - rect.left - cx * newZoom,
      y: e.clientY - rect.top - cy * newZoom,
    });
    setZoom(newZoom);
  };

  return {
    pan, zoom,
    setPan, setZoom,
    panDragging: dragRef.current !== null,
    containerRef,
    onMouseDown,
    onWheel,
    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
  };
}

// gesture set in agent_team_canvas.py::wheelEvent. Click an agent to
// select it (drives the top-left info card); click empty space to
// deselect.
function TeamCanvas({ width, height, team, roleByName, activeAgents, selectedNode, onSelectNode }: {
  width: number; height: number; team: Team | null; roleByName: Map<string, RoleData>;
  /// Set of currently-running agents (specialists run in parallel during
  /// phase 2, so this can hold multiple names simultaneously). The
  /// canvas pulses every member, so the user sees the team work as a
  /// fan-out, not a serial conveyor.
  activeAgents: Set<string>;
  selectedNode: string | null;
  onSelectNode: (name: string | null) => void;
}) {
  // Pan + zoom via the shared gesture hook so the diagram and graph
  // views behave IDENTICALLY: middle-mouse-drag pans, plain wheel
  // zooms anchored on the cursor. Reset on team change.
  const view = useCanvasGestures({ minZoom: 0.4, maxZoom: 3.0, factor: 1.1 });
  const { pan, zoom, setPan, setZoom, panDragging, containerRef: canvasRef, onMouseDown: onCanvasMouseDown, onWheel } = view;
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [team?.id]);
  const w = width, h = height;
  // Reserve space for the info-card overlay on the RIGHT side of the
  // canvas (used to be left). The orbital diagram then centres in the
  // left portion. Mirrors the page-layout change that pushed the
  // info/super-user cards from left-of-canvas to right-of-canvas.
  const card_reserve = Math.min(410, w * 0.35);
  const cx = (w - card_reserve) / 2;
  const cy = h / 2;
  const [arcPhase, setArcPhase] = useState(0);
  useEffect(() => {
    let raf = 0;
    let lastEmit = 0;
    const start = performance.now();
    // Throttle re-renders to ~30 fps. The previous loop fired setState
    // every frame (60 fps), which re-rendered the whole canvas — at
    // 8-12 agents the orbital math + SVG layout took >16 ms and the
    // animation visibly stuttered. 30 fps is plenty for a halo pulse
    // and halves the React reconciliation cost.
    const tick = (now: number) => {
      if (now - lastEmit >= 33) {
        setArcPhase(((now - start) / 1000) * 36);
        lastEmit = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const LAYER_COLORS = [
    "#f1c44a", "#48d486", "#3aa0ff", "#ee5b5b",
    "#ff9a3a", "#9aa3b2", "#a578ff", "#ff79c4",
  ];

  type RosterRow = { name: string; label: string; iconRef: string; depth: number; active: boolean; group: TeamGroup };
  const roster: RosterRow[] = useMemo(() => {
    if (!team || team.agents.length === 0) return [];
    const depths = computeDepths(team);
    return team.agents
      // Exclude both the orchestrator (rendered at center) AND the
      // synthetic critic (rendered as a peer next to the orchestrator,
      // not on a specialist arc).
      .filter(a => a.name !== "orchestrator" && a.base !== "orchestrator" && a.name !== CRITIC_AGENT_NAME)
      .map(a => {
        const group = groupForAgent(a);
        // Orbital depth is capped at 2. The orbital diagram is a
        // hub-and-spokes composition — leader on the inner ring, every
        // other specialist on the outer ring. Deeper graph layers
        // (e.g. critics at depth 3) collapse onto the outer ring here;
        // their real depth chain still shows in GraphCanvas. Without
        // this cap, a depth-3 ring overruns max_radius once `step` hits
        // its 90-px floor, and edges pointing at those nodes shoot off
        // the canvas into empty space (the purple-arrow bug).
        const rawDepth = Math.max(1, depths.get(a.name) ?? 1);
        return {
          name: a.name,
          label: teamMemberLabel(a.name, group),
          iconRef: agentIconRef(a, roleByName),
          depth: Math.min(2, rawDepth),
          active: activeAgents.has(a.name),
          group,
        };
      });
  }, [team, roleByName, activeAgents]);
  // Separate critic ref so the renderer can place it at depth-0 next
  // to the orchestrator (peer position, not on a specialist arc).
  const criticSpec = useMemo(
    () => team?.agents.find(a => a.name === CRITIC_AGENT_NAME) ?? null,
    [team],
  );

  const depthMap = useMemo(() => {
    const m = new Map<number, RosterRow[]>();
    for (const r of roster) {
      if (!m.has(r.depth)) m.set(r.depth, []);
      m.get(r.depth)!.push(r);
    }
    // Same ordering as GraphCanvas: Design first (Product Owner leading),
    // then Build, then Critic — so the orbital arc reads with the
    // design cluster swept around the top-right of the ring.
    const GORDER: Record<TeamGroup, number> = { design: 0, build: 1, critic: 2 };
    for (const row of m.values()) {
      row.sort((a, b) => {
        if (a.group !== b.group) return GORDER[a.group] - GORDER[b.group];
        if (a.group === "design") {
          const sa = a.name.includes(".") ? a.name.split(".").pop()! : a.name;
          const sb = b.name.includes(".") ? b.name.split(".").pop()! : b.name;
          if (sa === "product_owner" && sb !== "product_owner") return -1;
          if (sb === "product_owner" && sa !== "product_owner") return 1;
        }
        return 0;
      });
    }
    return m;
  }, [roster]);
  const sortedDepths = Array.from(depthMap.keys()).sort((a, b) => a - b);
  const max_depth = sortedDepths.length ? sortedDepths[sortedDepths.length - 1] : 1;

  // Outer ring needs room for: node disc (r=22) + active halo (≈58
  // radius at full pulse) + label below (drops 30px + ~16px text =
  // ~46px). Subtract those from the half-canvas so a max-depth node
  // doesn't clip the edges of the available area. Previous formula
  // (0.45 × min(canvas size)) ignored label width entirely and the
  // outer ring slid off-screen on smaller windows.
  const HALF_LABEL_W = 70;          // labels are 120px wide, centered
  const HALO_R = 58;                // active-pulse halo extent
  const LABEL_DROP = 46;            // label baseline below node centre
  const avail_w = (w - card_reserve) - HALF_LABEL_W * 2;
  const avail_h = h - HALO_R - LABEL_DROP - 40;
  const max_radius = Math.max(120, Math.min(avail_w / 2, avail_h / 2));
  const inner_offset = 130;
  let step = (max_radius - inner_offset) / Math.max(1, max_depth);
  if (step < 90) step = 90;
  const ring_radii = sortedDepths.map(d => inner_offset + step * d);
  const arc_span = (Math.PI * 2) * (340 / 360);
  // Orchestrator hub size — hoisted up here (was below) so the Critic
  // node can position itself OUTSIDE the hub artwork. The owl image is
  // drawn at orchestrator_r * 1.12 from centre; placing the critic at
  // orchestrator_r * 1.6 puts it clearly past the hub edge.
  const NODE_R = 22;
  const orchestrator_r = Math.max(48, Math.min(w, h) * 0.10);

  type Node = { name: string; x: number; y: number; label: string; iconRef: string; active: boolean; depth: number; group: TeamGroup };
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
        group: a.group,
      });
    }
  }
  // Place the synthetic Critic as a peer of the orchestrator: same
  // depth (0), positioned PAST the orchestrator's owl hub artwork on
  // the right so it doesn't disappear under the owl image. Scales with
  // orchestrator_r so it stays outside the hub at any canvas size.
  const criticNode: Node | null = criticSpec ? {
    name: criticSpec.name,
    x: cx + orchestrator_r * 1.6,
    y: cy,
    label: displayLabel(criticSpec.name),
    iconRef: agentIconRef(criticSpec, roleByName),
    active: activeAgents.has(criticSpec.name),
    depth: 0,
    group: "critic",
  } : null;
  if (criticNode) nodes.push(criticNode);
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

  // Click an agent → select it; click background → deselect. Pan is
  // owned by the shared gesture hook (middle-mouse-drag), so left-
  // button events are free for selection without pan-drag interference.
  const onBgClick = (e: React.MouseEvent) => {
    if (panDragging) return;
    onSelectNode(null);
    e.stopPropagation();
  };

  return (
    <div
      data-ui="AgentTeamCanvas"
      ref={canvasRef}
      onMouseDown={onCanvasMouseDown}
      onClick={onBgClick}
      onWheel={onWheel}
      style={{ position:"relative", width:w, height:h, background:`radial-gradient(ellipse at ${w/2}px ${h/2}px, rgba(192,138,255,0.10) 0%, rgba(116,164,255,0.06) 30%, rgba(40,60,110,0.04) 60%, rgba(0,0,0,0) 85%), linear-gradient(180deg, #101522 0%, #06080d 100%)`, overflow:"hidden", cursor: panDragging ? "grabbing" : "default", userSelect: "none" }}
    >
      <div style={{ position:"absolute", left:0, top:0, width:w, height:h, transform:`translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin:"0 0" }}>
      <svg width={w} height={h} style={{ position:"absolute", left:0, top:0, pointerEvents:"none" }}>
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
        {/* Per-agent halo, tinted by the agent's layer colour so the
            ring colour the user sees radiating around a disc matches
            the orbit it sits on. */}
        {nodes.map((n,i) => {
          const col = LAYER_COLORS[n.depth % LAYER_COLORS.length];
          // Active halo is bigger AND pulses with arcPhase so the
          // currently-working agent visibly "lights up" against its
          // idle siblings (sin-wave pulse, ~0.7s period).
          const haloPulse = 0.5 + 0.5 * Math.sin((arcPhase * Math.PI) / 180 * 3);
          const haloR = n.active ? 46 + 12 * haloPulse : 38;
          return (
            <circle
              key={"h" + i}
              cx={n.x}
              cy={n.y}
              r={haloR}
              fill="none"
              stroke={col}
              strokeOpacity={n.active ? 0.55 + 0.35 * haloPulse : 0.18}
              strokeWidth={n.active ? 3.2 : 1.4}
            />
          );
        })}
        {/* Disc + outline coloured by layer. Active agents get a
            brighter fill (mix toward white) and the layer colour as
            the outline so "this one is working" reads at a glance. */}
        {nodes.map((n,i) => {
          const col = LAYER_COLORS[n.depth % LAYER_COLORS.length];
          return (
            <circle
              key={"d" + i}
              cx={n.x}
              cy={n.y}
              r={22}
              fill={n.active ? col : "#1a2030"}
              fillOpacity={n.active ? 0.92 : 1}
              stroke={col}
              strokeOpacity={n.active ? 1 : 0.78}
              strokeWidth={n.active ? 3 : 1.8}
            />
          );
        })}
        {/* Extra rotating arc on the active agent — same idea as the
            orchestrator's halo but scoped per-node so the user sees
            exactly which specialist is on stage right now. */}
        {nodes.filter(n=>n.active).map((n,i) => {
          const col = LAYER_COLORS[n.depth % LAYER_COLORS.length];
          // 3 short arcs spaced 120° apart, rotating with arcPhase.
          const arcs = [0, 120, 240].map(off => {
            const a0 = ((arcPhase + off) * Math.PI) / 180;
            const a1 = ((arcPhase + off + 50) * Math.PI) / 180;
            const r = 34;
            const sx = n.x + r * Math.cos(a0);
            const sy = n.y + r * Math.sin(a0);
            const ex = n.x + r * Math.cos(a1);
            const ey = n.y + r * Math.sin(a1);
            return `M ${sx} ${sy} A ${r} ${r} 0 0 1 ${ex} ${ey}`;
          }).join(" ");
          return (
            <path
              key={"r" + i}
              d={arcs}
              stroke={col}
              strokeWidth={2.4}
              strokeLinecap="round"
              fill="none"
              opacity={0.95}
            />
          );
        })}
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
      {nodes.map((n,i) => {
        const col = LAYER_COLORS[n.depth % LAYER_COLORS.length];
        const pulse = 0.5 + 0.5 * Math.sin((arcPhase * Math.PI) / 180 * 3);
        const glow = n.active ? 12 + 10 * pulse : 4;
        const tint = tintForGroup(n.group);
        const isCritic = n.group === "critic";
        // Critic gets a SHARP rainbow ring around the icon — full
        // opacity, no blur. The previous blurred 0.55-opacity disc
        // disappeared into the background; this version uses a
        // conic-gradient circle masked with a radial-gradient to carve
        // out the centre, leaving a crisp rainbow annulus. Other groups
        // get a semi-transparent tinted disc behind the icon as before.
        const RING_PAD = 9;
        return (
          <React.Fragment key={"node" + i}>
            {isCritic ? (
              <div
                style={{
                  position: "absolute",
                  left: n.x - NODE_R - RING_PAD,
                  top:  n.y - NODE_R - RING_PAD,
                  width:  (NODE_R + RING_PAD) * 2,
                  height: (NODE_R + RING_PAD) * 2,
                  borderRadius: "50%",
                  pointerEvents: "none",
                  background: "conic-gradient(from 0deg, #ff5e7e, #ffb84c, #ffe14c, #6cff5e, #5ec6ff, #b86cff, #ff5e7e)",
                  WebkitMask: `radial-gradient(circle, transparent ${(NODE_R + 1) / (NODE_R + RING_PAD) * 100}%, #000 ${(NODE_R + 3) / (NODE_R + RING_PAD) * 100}%)`,
                  mask: `radial-gradient(circle, transparent ${(NODE_R + 1) / (NODE_R + RING_PAD) * 100}%, #000 ${(NODE_R + 3) / (NODE_R + RING_PAD) * 100}%)`,
                }}
              />
            ) : (
              <div
                style={{
                  position: "absolute",
                  left: n.x - NODE_R - 6,
                  top:  n.y - NODE_R - 6,
                  width:  NODE_R * 2 + 12,
                  height: NODE_R * 2 + 12,
                  borderRadius: "50%",
                  pointerEvents: "none",
                  background: tint.bg,
                  border: `1.5px solid ${tint.border}`,
                }}
              />
            )}
            <img
              src={owlSrc(n.iconRef)}
              style={{
                position: "absolute",
                left: n.x - NODE_R,
                top:  n.y - NODE_R,
                width:  NODE_R * 2,
                height: NODE_R * 2,
                objectFit: "contain",
                pointerEvents: "none",
                filter: `drop-shadow(0 0 ${glow}px ${col}${n.active ? "ee" : "55"})`,
              }}
            />
            {n.group === "design" && (
              <div style={{
                position: "absolute",
                left: n.x + NODE_R - 8,
                top:  n.y - NODE_R - 8,
                background: "rgba(64, 168, 96, 0.95)",
                color: "#0a1208",
                fontSize: 8,
                fontWeight: 800,
                letterSpacing: 0.4,
                padding: "1px 5px",
                borderRadius: 8,
                pointerEvents: "none",
                whiteSpace: "nowrap",
                textTransform: "uppercase",
              }}>Design</div>
            )}
          </React.Fragment>
        );
      })}
      {nodes.map((n,i) => {
        const col = LAYER_COLORS[n.depth % LAYER_COLORS.length];
        return (
          <div
            key={"l" + i}
            style={{
              position: "absolute",
              left: n.x - 70,
              top:  n.y + 30,
              width: 140,
              textAlign: "center",
              fontSize: 14, // +2 (was 12) to match the graph-view bump
              fontWeight: 700,
              color: n.active ? col : "#e6e8eb",
              letterSpacing: 0.4,
              pointerEvents: "none",
              textShadow: "0 1px 3px rgba(0,0,0,0.9)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {n.label}
          </div>
        );
      })}
      {/* Clickable hit-targets — transparent circles centred on each node
          + the orchestrator disc. Sit ABOVE the imgs (which have
          pointerEvents:none) so clicks register cleanly. Stops bubbling
          to the background so a node click doesn't deselect. */}
      {orchSpec && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            const name = orchSpec.name;
            onSelectNode(selectedNode === name ? null : name);
          }}
          title={displayLabel(orchSpec.name)}
          style={{
            position:"absolute",
            left: cx - orchestrator_r * 1.12,
            top:  cy - orchestrator_r * 1.12,
            width:  orchestrator_r * 2.24,
            height: orchestrator_r * 2.24,
            borderRadius:"50%",
            cursor:"pointer",
            background:"transparent",
            boxShadow: selectedNode === orchSpec.name ? "0 0 0 3px rgba(127,223,255,0.85)" : "none",
          }}
        />
      )}
      {nodes.map((n,i) => (
        <div
          key={"hit"+i}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onSelectNode(selectedNode === n.name ? null : n.name);
          }}
          title={n.label}
          style={{
            position:"absolute",
            left: n.x - NODE_R - 6,
            top:  n.y - NODE_R - 6,
            width: NODE_R * 2 + 12,
            height: NODE_R * 2 + 12,
            borderRadius:"50%",
            cursor:"pointer",
            background:"transparent",
            boxShadow: selectedNode === n.name ? "0 0 0 3px rgba(127,223,255,0.85)" : "none",
          }}
        />
      ))}
      {nodes.length === 0 && (
        <div style={{ position:"absolute", left:cx-180, top:cy + orchestrator_r * 2 + 20, width:360, textAlign:"center", fontSize:12, color:"var(--fg-subtle)", pointerEvents:"none" }}>
          No specialists on this team yet. Click <b>Team…</b> above to load a template.
        </div>
      )}
      </div>
      {/* Zoom HUD — top-LEFT corner. Outside the transform layer so it
          stays anchored regardless of pan / zoom. Lives on the left so
          the right side stays free for the agent info card overlay. */}
      <div style={{ position:"absolute", left:8, top:8, display:"flex", alignItems:"center", gap:4, background:"rgba(10,15,25,0.65)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:8, padding:"2px 4px", fontSize:11, color:"var(--fg-muted)" }} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
        <button onClick={() => setZoom(z => Math.max(0.4, z / 1.15))} title="Zoom out" style={{ width:22, height:22, border:"none", background:"transparent", color:"var(--fg)", cursor:"pointer", fontSize:14 }}>−</button>
        <span style={{ minWidth:34, textAlign:"center" }}>{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom(z => Math.min(3, z * 1.15))} title="Zoom in" style={{ width:22, height:22, border:"none", background:"transparent", color:"var(--fg)", cursor:"pointer", fontSize:14 }}>+</button>
        <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} title="Reset zoom + pan" style={{ width:30, height:22, border:"none", background:"transparent", color:"var(--fg)", cursor:"pointer", fontSize:12 }}>⟲</button>
      </div>
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
  activeAgents,
  edges, onEdgesChange,
  selectedEdgeIdx, onSelectEdge,
  positions, onPositionsChange,
}: {
  width: number; height: number;
  team: Team | null; roleByName: Map<string, RoleData>;
  selectedNode: string | null; onSelectNode: (name: string | null) => void;
  /// Set of agents currently working — node borders glow green for
  /// every member, so a parallel fan-out shows all specialists at
  /// once instead of one-at-a-time.
  activeAgents: Set<string>;
  edges: Edge[]; onEdgesChange: (edges: Edge[]) => void;
  selectedEdgeIdx: number | null; onSelectEdge: (idx: number | null) => void;
  positions: GraphPos | null; onPositionsChange: (p: GraphPos) => void;
}) {
  const w = width, h = height;
  // Live mouse position for the rubber-band edge while dragging from a
  // port. Null when no drag is in flight.
  const [drag, setDrag] = useState<null | { from: string; x: number; y: number; over: string | null }>(null);
  // Live node-drag offset (anchor = mouse position when the body was
  // grabbed). null when no body drag is in flight. We mirror it into a
  // ref so the document-level listener registered below can read the
  // latest value without re-binding on every state change.
  const [bodyDrag, setBodyDrag] = useState<null | { name: string; dx: number; dy: number }>(null);
  const bodyDragRef = useRef(bodyDrag);
  useEffect(() => { bodyDragRef.current = bodyDrag; }, [bodyDrag]);

  // Pan + zoom via the shared gesture hook so the graph and diagram
  // views behave IDENTICALLY: middle-mouse-drag pans, plain wheel
  // zooms anchored on the cursor. Node-drag and port-rubber-band
  // (below) still own left-button behaviour on their own elements via
  // stopPropagation, so they don't fight with the hook.
  const view = useCanvasGestures({ minZoom: 0.25, maxZoom: 3.0, factor: 1.12 });
  const { pan, zoom, setPan, containerRef, onMouseDown: onContainerMouseDown, onWheel: onContainerWheel, panDragging } = view;

  const LAYER_COLORS = [
    "#f1c44a", "#48d486", "#3aa0ff", "#ee5b5b",
    "#ff9a3a", "#9aa3b2", "#a578ff", "#ff79c4",
  ];

  // Card geometry — smaller than before (was 180x220) so more of the
  // team fits on one screen without scrolling. Removed the third text
  // row (the base-role identifier) so the card can be shorter without
  // squeezing legibility. Name + team-leader sub-label stay, both at
  // a larger font size.
  const NODE_W = 130;
  const NODE_H = 150;
  const ROW_GAP = 70;
  const COL_GAP = 22;
  // Wider gap at group boundaries (design ↔ build ↔ critic) so the
  // cluster bounding boxes drawn under the nodes don't overlap. With
  // PAD=18 around each cluster, anything below ~40 still produces
  // intersecting boxes — 80 gives a clear, readable channel between
  // teams.
  const CLUSTER_GAP = 80;
  const TOP_PAD = 36;
  const SIDE_PAD = 24;
  const PORT_R = 8;

  // Compute auto-layout. Two-column model: design members ride the
  // left column, build members the right, separated by CLUSTER_GAP.
  // The column widths are fixed globally from whichever row has the
  // most members of each group, so a build critic landing in row 3
  // CANNOT stretch the build cluster across the design column. The
  // orchestrator and synthetic critical_thinker are "outside-team"
  // and ride centred across the full canvas at their depth.
  //
  // Used both for the default placement and for the ⟲ Layout button.
  const autoLayout = useMemo<GraphPos>(() => {
    const out: GraphPos = new Map();
    if (!team || team.agents.length === 0) return out;
    const depths = computeDepths(team);

    // Outside-team predicate: orchestrator and the synthetic critical
    // thinker don't belong to either design or build. They render with
    // their own visual style and DO NOT participate in cluster boxes.
    const isOutsideTeam = (a: AgentSpec): boolean => {
      const name = a.name.includes(".") ? a.name.split(".").pop()! : a.name;
      const base = a.base.includes(".") ? a.base.split(".").pop()! : a.base;
      return base === "orchestrator" || name === "orchestrator" || name === CRITIC_AGENT_NAME;
    };

    const byDepth = new Map<number, AgentSpec[]>();
    for (const a of team.agents) {
      const d = depths.get(a.name) ?? 0;
      if (!byDepth.has(d)) byDepth.set(d, []);
      byDepth.get(d)!.push(a);
    }
    for (const row of byDepth.values()) row.sort(rosterCompare);
    const sortedDepths = Array.from(byDepth.keys()).sort((a, b) => a - b);

    // Determine the global column widths from the widest design row
    // and the widest build row across the whole roster. Outside-team
    // agents are excluded so a misclassified orchestrator can't pad
    // either column.
    let maxDesign = 0;
    let maxBuild = 0;
    for (const row of byDepth.values()) {
      const teamMembers = row.filter(a => !isOutsideTeam(a));
      const d = teamMembers.filter(a => groupForAgent(a) === "design").length;
      const b = teamMembers.filter(a => groupForAgent(a) === "build").length;
      if (d > maxDesign) maxDesign = d;
      if (b > maxBuild) maxBuild = b;
    }
    const designColW = maxDesign > 0 ? maxDesign * NODE_W + (maxDesign - 1) * COL_GAP : 0;
    const buildColW  = maxBuild  > 0 ? maxBuild  * NODE_W + (maxBuild  - 1) * COL_GAP : 0;
    const interGap   = (designColW > 0 && buildColW > 0) ? CLUSTER_GAP : 0;
    const totalColsW = designColW + interGap + buildColW;
    const designStartX = (w - totalColsW) / 2;
    const buildStartX  = designStartX + designColW + interGap;

    /// Centre `members` horizontally within `[startX, startX+colW]` and
    /// drop them at `y`. No-op when members is empty.
    const placeRow = (members: AgentSpec[], startX: number, colW: number, y: number) => {
      if (members.length === 0) return;
      const rowW = members.length * NODE_W + Math.max(0, members.length - 1) * COL_GAP;
      const offset = (colW - rowW) / 2;
      for (let j = 0; j < members.length; j++) {
        out.set(members[j].name, { x: startX + offset + j * (NODE_W + COL_GAP), y });
      }
    };

    let curY = TOP_PAD;
    for (const depth of sortedDepths) {
      const agents = byDepth.get(depth)!;
      const outsiders     = agents.filter(a => isOutsideTeam(a));
      const designMembers = agents.filter(a => !isOutsideTeam(a) && groupForAgent(a) === "design");
      const buildMembers  = agents.filter(a => !isOutsideTeam(a) && groupForAgent(a) === "build");
      placeRow(designMembers, designStartX, designColW, curY);
      placeRow(buildMembers,  buildStartX,  buildColW,  curY);
      // Outsiders (orchestrator + critical_thinker) ride centred over
      // the full canvas at the same depth so they read as "above the
      // teams" instead of belonging to either column.
      placeRow(outsiders, 0, w, curY);
      curY += NODE_H + ROW_GAP;
    }
    return out;
  }, [team, w]);

  // Effective positions. Parent-supplied positions WIN where present;
  // any agent missing from `positions` (notably the synthetic Critical
  // Thinker, which can't be persisted to graph_json because it isn't
  // in team_json) falls back to its auto-layout slot. Without this
  // merge, the rainbow critic would silently disappear whenever the
  // user has manually placed any other card.
  const effective: GraphPos = (() => {
    if (!positions || positions.size === 0) return autoLayout;
    const out = new Map(autoLayout);
    for (const [k, v] of positions.entries()) out.set(k, v);
    return out;
  })();

  // Convert a client-space (mouse event) coordinate to inner-content
  // coordinates accounting for pan + zoom. Used by every interaction
  // that needs to know "what content point is the cursor over".
  const clientToContent = (clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - pan.x) / zoom,
      y: (clientY - rect.top - pan.y) / zoom,
    };
  };

  // BODY DRAG — listens on the DOCUMENT, not the container. Cursor can
  // leave the canvas, sweep over the title bar, anything; the drag
  // survives until mouseup. Previously the container's onMouseLeave
  // cancelled the drag the moment the cursor crossed an edge.
  useEffect(() => {
    if (!bodyDrag) return;
    const onMove = (e: MouseEvent) => {
      const bd = bodyDragRef.current;
      if (!bd) return;
      const c = clientToContent(e.clientX, e.clientY);
      const next: GraphPos = new Map(effective);
      next.set(bd.name, { x: c.x - bd.dx, y: c.y - bd.dy });
      onPositionsChange(next);
    };
    const onUp = () => setBodyDrag(null);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  // We deliberately depend on `bodyDrag` truthiness only — the latest
  // `effective`/`pan`/`zoom` are read at event time via closures that
  // are recreated each render anyway. effective is recomputed every
  // render so closing over it captures the freshest map.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodyDrag, pan.x, pan.y, zoom]);

  // PORT DRAG — rubber-band edge while dragging from a node's output
  // port. Container-level move/up because the rubber band needs canvas
  // coords, and a port drag is short — no edge-of-window issues.
  const onContainerMove = (e: React.MouseEvent) => {
    if (!drag) return;
    const c = clientToContent(e.clientX, e.clientY);
    let over: string | null = null;
    for (const [name, p] of effective.entries()) {
      if (name === drag.from) continue;
      if (c.x >= p.x && c.x <= p.x + NODE_W && c.y >= p.y && c.y <= p.y + NODE_H) {
        over = name;
        break;
      }
    }
    setDrag({ ...drag, x: c.x, y: c.y, over });
  };

  const onContainerUp = () => {
    if (drag) {
      if (drag.over && drag.over !== drag.from && !edges.some(e => e.source === drag.from && e.target === drag.over)) {
        onEdgesChange([...edges, { source: drag.from, target: drag.over }]);
      }
      setDrag(null);
    }
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

  // Resolve edges into endpoints (skip stale references). The synthetic
  // Critical Thinker isn't in the project's team_json, so persisted edges
  // can't reference it — we inject a virtual orchestrator ↔ critical_thinker
  // pair here whenever both are present. Marked `synthetic: true` so the
  // click/delete/reverse code paths in the parent never try to persist
  // these to graph_json (they'd just round-trip get filtered out).
  const hasSyntheticCritic = effective.has(CRITIC_AGENT_NAME);
  const baseLive = edges.filter(e => effective.has(e.source) && effective.has(e.target));
  const liveEdges: (Edge & { synthetic?: boolean })[] = hasSyntheticCritic && effective.has(orchName)
    ? [...baseLive,
       { source: orchName, target: CRITIC_AGENT_NAME, synthetic: true } as any,
       { source: CRITIC_AGENT_NAME, target: orchName, synthetic: true } as any]
    : baseLive;

  // Port geometry:
  //   - Orchestrator + synthetic Critical Thinker: output on BOTTOM
  //     (matches every other card so dispatch flows visibly down) and
  //     input on the RIGHT side (per 2026-05-19 spec: the peer side
  //     where orch ↔ critic exchanges happen).
  //   - Every other specialist: input on TOP, output on BOTTOM so
  //     dispatch reads top-to-bottom through the tree.
  const isPeerNode = (name: string): boolean =>
    name === orchName || name === CRITIC_AGENT_NAME;
  type PortSide = "left" | "right" | "top" | "bottom";
  type Port = { x: number; y: number; side: PortSide };
  const outPortFor = (_name: string, p: { x: number; y: number }): Port =>
    // Output is bottom for everyone (orch+critic included).
    ({ x: p.x + NODE_W / 2, y: p.y + NODE_H, side: "bottom" });
  const inPortFor  = (name: string, p: { x: number; y: number }): Port =>
    isPeerNode(name)
      ? { x: p.x + NODE_W,     y: p.y + NODE_H / 2, side: "right" }
      : { x: p.x + NODE_W / 2, y: p.y,              side: "top" };

  // Cubic Bezier between two ports, with control points pulled in the
  // direction the port faces so the curve leaves/enters perpendicular
  // to the card edge. Mixed orientations (e.g., bottom → top) look
  // natural this way; everything-horizontal cases reduce to the old
  // path the file used to draw.
  const ctlFor = (p: Port, other: Port, k: number): { x: number; y: number } => {
    if (p.side === "right")  return { x: p.x + Math.max(40, Math.abs(other.x - p.x) * k), y: p.y };
    if (p.side === "left")   return { x: p.x - Math.max(40, Math.abs(other.x - p.x) * k), y: p.y };
    if (p.side === "bottom") return { x: p.x, y: p.y + Math.max(40, Math.abs(other.y - p.y) * k) };
    return                          { x: p.x, y: p.y - Math.max(40, Math.abs(other.y - p.y) * k) };
  };
  const edgePath = (sName: string, tName: string, s: { x: number; y: number }, t: { x: number; y: number }) => {
    const sP = outPortFor(sName, s);
    const tP = inPortFor(tName, t);
    const sCtl = ctlFor(sP, tP, 0.55);
    const tCtl = ctlFor(tP, sP, 0.55);
    return `M ${sP.x} ${sP.y} C ${sCtl.x} ${sCtl.y}, ${tCtl.x} ${tCtl.y}, ${tP.x} ${tP.y}`;
  };

  return (
    <div
      ref={containerRef}
      data-ui="GraphCanvas"
      onClick={() => { onSelectNode(null); onSelectEdge(null); }}
      onMouseMove={onContainerMove}
      onMouseUp={onContainerUp}
      onMouseDown={onContainerMouseDown}
      onWheel={onContainerWheel}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position:"relative", width:w, height:h,
        background:"linear-gradient(180deg, #101522 0%, #06080d 100%)",
        overflow:"hidden",
        // Middle-click on Windows triggers an "auto-scroll" wheel cursor.
        // Suppress that so our pan handler is the only consumer.
        userSelect: "none",
        cursor: panDragging ? "grabbing" : "default",
      }}
    >
      {/* Pan + zoom wrapper. The whole inner canvas (SVG edges, cluster
          regions, cards) lives inside this transform so a single
          translate(pan)·scale(zoom) drives the view. */}
      <div style={{
        position: "absolute", left: 0, top: 0,
        width: canvasW, height: canvasH,
        transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        transformOrigin: "0 0",
      }}>
        <svg width={canvasW} height={canvasH} style={{ position:"absolute", left:0, top:0, pointerEvents:"none" }}>
          <defs>
            <marker id="graphArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(120,220,255,0.85)" />
            </marker>
            <marker id="graphArrowSel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
            </marker>
          </defs>
          {/* Existing edges. Synthetic edges (orchestrator ↔ critical_thinker)
              get a softer dashed style and are NOT clickable — they aren't
              in the project's graph_json, so selecting them for delete/reverse
              would either no-op or corrupt the index mapping for real edges. */}
          {liveEdges.map((e, i) => {
            const s = effective.get(e.source)!;
            const t = effective.get(e.target)!;
            const synthetic = (e as any).synthetic === true;
            const sel = !synthetic && selectedEdgeIdx === i;
            return (
              <g key={"ge"+i}>
                {!synthetic && (
                  /* Fat invisible hit-target so click is forgiving. */
                  <path
                    d={edgePath(e.source, e.target, s, t)}
                    stroke="rgba(0,0,0,0)"
                    strokeWidth={14}
                    fill="none"
                    style={{ pointerEvents:"stroke", cursor:"pointer" }}
                    onClick={(ev) => { ev.stopPropagation(); onSelectEdge(i); onSelectNode(null); }}
                  />
                )}
                <path
                  d={edgePath(e.source, e.target, s, t)}
                  stroke={sel ? "var(--accent)" : synthetic ? "rgba(200,180,255,0.55)" : "rgba(120,220,255,0.55)"}
                  strokeWidth={sel ? 2.6 : synthetic ? 1.4 : 1.6}
                  strokeDasharray={synthetic ? "5 4" : undefined}
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
            const sP = outPortFor(drag.from, src);
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
        {/* Cluster bounding regions — translucent backdrops behind the
            Design and Build cards so each group reads as one block. Goes
            before the cards so it sits underneath in stacking order. */}
        {(() => {
          const byGroup: Record<TeamGroup, GNode[]> = { design: [], build: [], critic: [] };
          for (const n of placed) {
            // Outsiders (orchestrator + synthetic critic) sit ABOVE the
            // teams — they're not part of either cluster, so excluding
            // them keeps the bounding boxes tight.
            if (n.name === orchName) continue;
            if (n.name === CRITIC_AGENT_NAME) continue;
            if (n.spec.base === "orchestrator") continue;
            byGroup[groupForAgent(n.spec)].push(n);
          }
          const PAD = 18;
          const LABEL_TOP = 22;
          const regions: Array<{ group: TeamGroup; nodes: GNode[]; label: string }> = [];
          if (byGroup.design.length > 0) regions.push({ group: "design", nodes: byGroup.design, label: "Design Team" });
          if (byGroup.build.length  > 0) regions.push({ group: "build",  nodes: byGroup.build,  label: "Build Team" });
          return regions.map(r => {
            const minX = Math.min(...r.nodes.map(n => n.x)) - PAD;
            const minY = Math.min(...r.nodes.map(n => n.y)) - PAD - LABEL_TOP;
            const maxX = Math.max(...r.nodes.map(n => n.x + NODE_W)) + PAD;
            const maxY = Math.max(...r.nodes.map(n => n.y + NODE_H)) + PAD;
            const t = tintForGroup(r.group);
            const labelBg = r.group === "design" ? "rgba(64, 168, 96, 0.95)" : "rgba(58, 120, 220, 0.95)";
            return (
              <div key={"cluster-" + r.group} data-ui={`Cluster-${r.group}`} style={{
                position: "absolute",
                left: minX, top: minY,
                width: maxX - minX, height: maxY - minY,
                borderRadius: 18,
                background: t.bg,
                border: `1.5px dashed ${t.border}`,
                pointerEvents: "none",
                zIndex: 0,
              }}>
                <div style={{
                  position: "absolute", top: -11, left: 16, padding: "2px 10px",
                  background: labelBg, color: "#0a1208",
                  fontSize: 11, fontWeight: 800, letterSpacing: 0.7,
                  borderRadius: 7, textTransform: "uppercase",
                }}>{r.label}</div>
              </div>
            );
          });
        })()}
        {placed.map(n => {
          const isOrch = n.name === orchName;
          const accent = isOrch ? "#ffd76a" : LAYER_COLORS[(n.depth + 1) % LAYER_COLORS.length];
          const sel = selectedNode === n.name;
          const isActive = activeAgents.has(n.name);
          const isDragTarget = drag?.over === n.name;
          const group = groupForAgent(n.spec);
          const tint = tintForGroup(group);
          const isCritic = group === "critic";
          // Outsider agents (orchestrator + synthetic critical_thinker)
          // sit ABOVE the design/build teams — they don't belong to
          // either, so suppress the team badge to avoid the misleading
          // "BUILD TEAM" tag on the orch card (which falls through to
          // "build" by default in groupForAgent).
          const isOutsider =
            isOrch ||
            n.name === CRITIC_AGENT_NAME ||
            n.spec.base === "orchestrator";
          // Base background mixes the group tint into the existing
          // gradient so the card stays legible AND its team affiliation
          // reads at a glance. Critic gets a rainbow conic-gradient
          // border layered on top of the regular border.
          const baseBg = `linear-gradient(180deg, ${tint.bg} 0%, rgba(17,21,30,0.92) 100%)`;
          // Critic: solid border is transparent so the rainbow overlay
          // (rendered as a mask-border ON TOP of the card) is the only
          // visible border. Selection/active state is shown via box-shadow
          // ring OUTSIDE the rainbow instead of by recolouring the border.
          const borderColor = isCritic
            ? "transparent"
            : isActive ? "#3cf26b" : sel ? accent : isDragTarget ? "var(--accent)" : tint.border;
          return (
            <div
              key={n.name}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                const c = clientToContent(e.clientX, e.clientY);
                setBodyDrag({ name: n.name, dx: c.x - n.x, dy: c.y - n.y });
              }}
              onClick={(e) => { e.stopPropagation(); onSelectNode(n.name); onSelectEdge(null); }}
              style={{
                position: "absolute", left: n.x, top: n.y,
                width: NODE_W, height: NODE_H, borderRadius: 14,
                background: baseBg,
                border: `1.8px solid ${borderColor}`,
                boxShadow: isActive
                  ? "0 0 0 3px rgba(60,242,107,0.40), 0 6px 22px rgba(0,0,0,0.6)"
                  : sel
                  ? `0 0 0 2px ${accent}55, 0 6px 22px rgba(0,0,0,0.6)`
                  : isDragTarget
                  ? "0 0 0 2px rgba(92,240,255,0.40), 0 6px 22px rgba(0,0,0,0.6)"
                  : isCritic
                  ? "0 0 16px rgba(255,180,80,0.35), 0 4px 14px rgba(0,0,0,0.5)"
                  : "0 4px 14px rgba(0,0,0,0.5)",
                padding: "12px 12px 10px",
                display: "flex", flexDirection: "column", alignItems: "stretch", gap: 6,
                cursor: bodyDrag?.name === n.name ? "grabbing" : "grab",
                userSelect: "none",
              }}
            >
              {/* Sharp rainbow mask-border for the Critical Thinker.
                  ON TOP of the card (zIndex 3) so neither the card body
                  nor the per-state border can hide it. Uses the
                  composite-mask trick to carve out the centre, leaving
                  only the 3px outer ring with the conic gradient. */}
              {isCritic && (
                <div style={{
                  position: "absolute", inset: -2, borderRadius: 16,
                  padding: 3, pointerEvents: "none", zIndex: 3,
                  background: "conic-gradient(from 0deg, #ff5e7e, #ffb84c, #ffe14c, #6cff5e, #5ec6ff, #b86cff, #ff5e7e)",
                  WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
                  WebkitMaskComposite: "xor",
                  maskComposite: "exclude",
                }} />
              )}
              {/* Group badge — top-right corner. Design = green, Build = blue.
                  Skipped for outsider agents (orchestrator + critic) so
                  they don't carry a misleading team tag. */}
              {tint.badge && !isOutsider && (
                <div style={{
                  position:"absolute", top:6, right:6, zIndex:4,
                  background: group === "design" ? "rgba(64, 168, 96, 0.95)" : "rgba(58, 120, 220, 0.95)",
                  color: "#0a1208",
                  fontSize: 11, fontWeight: 800, letterSpacing: 0.4,
                  padding: "2px 7px", borderRadius: 8,
                  pointerEvents:"none", textTransform:"uppercase", whiteSpace:"nowrap",
                }}>{tint.badge}</div>
              )}
              {/* Icon row — smaller now that the card is 130x150. */}
              <div style={{ width:"100%", flex:1, minHeight:0, display:"flex", alignItems:"center", justifyContent:"center", background:"rgba(255,255,255,0.025)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:10 }}>
                <img src={owlSrc(agentIconRef(n.spec, roleByName))} style={{ width:64, height:64, objectFit:"contain" }} />
              </div>
              {/* Name (was 13px, now 15px = +2 as requested). The base-role
                  line was removed — it duplicated info already visible in
                  the team-group badge + the info panel on the right. */}
              <div style={{ color:"var(--fg-strong)", fontSize:15, fontWeight:700, textAlign:"center", lineHeight:1.2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                {teamMemberLabel(n.name, group)}
              </div>
              {isOrch && (
                <div style={{ display:"flex", alignItems:"center", justifyContent:"center", marginTop: 2 }}>
                  <span style={{ color: accent, background: "rgba(255,215,106,0.12)", border: `1px solid ${accent}55`, borderRadius: 5, padding: "1px 7px", fontSize: 10, letterSpacing: 0.5, fontWeight: 700 }}>LEADER</span>
                </div>
              )}

              {/* Ports.
                  - Every card has its OUTPUT on the BOTTOM so dispatch
                    flows visibly down the tree.
                  - Specialists have INPUT on TOP (parent dispatches in).
                  - Orchestrator + Critical Thinker (peers) have INPUT
                    on the RIGHT — the side where the orch ↔ critic
                    exchange happens visually. */}
              {(() => {
                const isPeer = isOrch || isCritic;
                const inX  = isPeer ? NODE_W - PORT_R      : NODE_W / 2 - PORT_R;
                const inY  = isPeer ? NODE_H / 2 - PORT_R  : -PORT_R;
                const outX = NODE_W / 2 - PORT_R;
                const outY = NODE_H - PORT_R;
                return (
                  <>
                    <div
                      title="Incoming connections land here"
                      style={{
                        position:"absolute", left: inX, top: inY,
                        width: PORT_R * 2, height: PORT_R * 2, borderRadius:"50%",
                        background:"#ff9a3a", border:"2px solid #11151e",
                        boxShadow: isDragTarget ? "0 0 0 4px rgba(255,154,58,0.40)" : "0 0 8px rgba(255,154,58,0.55)",
                        pointerEvents:"none",
                      }}
                    />
                    <div
                      title="Drag to another agent to create a dispatch edge"
                      onMouseDown={(e) => {
                        if (e.button !== 0) return;
                        e.stopPropagation();
                        e.preventDefault();
                        const c = clientToContent(e.clientX, e.clientY);
                        setDrag({ from: n.name, x: c.x, y: c.y, over: null });
                      }}
                      style={{
                        position:"absolute", left: outX, top: outY,
                        width: PORT_R * 2, height: PORT_R * 2, borderRadius:"50%",
                        background:"#3aa0ff", border:"2px solid #11151e",
                        boxShadow:"0 0 10px rgba(58,160,255,0.70)",
                        cursor:"crosshair",
                      }}
                    />
                  </>
                );
              })()}
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

// Mirror of fleet.rs Tauri command return shapes. The discriminator
// is the `status` field (serde tag).
type FleetCreateResult =
  | { status: "ready"; path: string; branch: string; baseSha: string }
  | { status: "notAGitRepo" }
  | { status: "dirtyWorkingTree"; details: string }
  | { status: "error"; message: string };
type FleetFinalizeResult =
  | { status: "committed"; commitSha: string; filesChanged: number; files: string[] }
  | { status: "noChanges" }
  | { status: "error"; message: string };
type FleetMergeResult =
  | { status: "merged"; commitSha: string; filesChanged: number }
  | { status: "conflict"; files: string[] }
  | { status: "noChanges" }
  | { status: "error"; message: string };

// File extensions the auto-doc trigger considers "code" — touching any
// of these in a merged commit dispatches the documentation agent on
// the way out. Markdown / config / images intentionally excluded so a
// pure-docs run doesn't loop on itself.
const _CODE_EXTS = new Set([
  ".py", ".ts", ".tsx", ".js", ".jsx", ".rs", ".go", ".java", ".kt",
  ".rb", ".cs", ".cpp", ".cc", ".h", ".hpp", ".swift", ".sh", ".ps1",
  ".sql", ".vue", ".svelte",
]);
function isCodeFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return _CODE_EXTS.has(path.slice(dot).toLowerCase());
}

// MarkdownBody — render an agent's text as proper markdown so headings,
// lists, code blocks, tables, and inline code look like a chat client
// instead of a notepad. Tool-call JSON keeps the plain monospace
// renderer; this is for prose (replies + thinking blocks).
function MarkdownBody({ text }: { text: string }) {
  return (
    <div className="md-body" style={{ fontFamily: "Segoe UI, sans-serif", fontSize: 13, lineHeight: 1.55, color: "var(--fg)" }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Inline `code` → small monospace pill; fenced ```code``` →
          // panel with optional language label across the top edge.
          code({ className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || "");
            const lang = match?.[1];
            const isBlock = !!match || (typeof children === "string" && children.includes("\n"));
            if (!isBlock) {
              return (
                <code style={{ background: "rgba(127,140,160,0.18)", padding: "0.12em 0.38em", borderRadius: 3, fontFamily: "Consolas, 'JetBrains Mono', monospace", fontSize: "0.92em" }} {...props}>{children}</code>
              );
            }
            return (
              <div style={{ background: "rgba(20,28,40,0.6)", border: "1px solid var(--border)", borderRadius: 6, margin: "8px 0", overflow: "hidden" }}>
                {lang ? (
                  <div style={{ padding: "3px 10px", fontSize: 10, color: "var(--fg-subtle)", fontFamily: "Segoe UI, sans-serif", borderBottom: "1px solid var(--border)", letterSpacing: 0.5, textTransform: "uppercase" }}>{lang}</div>
                ) : null}
                <pre style={{ margin: 0, padding: 10, fontFamily: "Consolas, 'JetBrains Mono', monospace", fontSize: 12, overflowX: "auto", color: "var(--fg)", lineHeight: 1.45 }}>
                  <code className={className} {...props}>{children}</code>
                </pre>
              </div>
            );
          },
          h1: (p) => <h2 style={{ fontSize: 18, fontWeight: 700, margin: "14px 0 6px", color: "var(--fg-strong)", borderBottom: "1px solid var(--border)", paddingBottom: 3 }} {...(p as any)} />,
          h2: (p) => <h3 style={{ fontSize: 16, fontWeight: 700, margin: "12px 0 5px", color: "var(--fg-strong)" }} {...(p as any)} />,
          h3: (p) => <h4 style={{ fontSize: 14, fontWeight: 700, margin: "10px 0 4px", color: "var(--fg-strong)" }} {...(p as any)} />,
          h4: (p) => <h5 style={{ fontSize: 13, fontWeight: 700, margin: "8px 0 3px", color: "var(--fg-strong)" }} {...(p as any)} />,
          p: (p) => <p style={{ margin: "6px 0" }} {...(p as any)} />,
          ul: (p) => <ul style={{ margin: "6px 0", paddingLeft: 22 }} {...(p as any)} />,
          ol: (p) => <ol style={{ margin: "6px 0", paddingLeft: 22 }} {...(p as any)} />,
          li: (p) => <li style={{ margin: "2px 0" }} {...(p as any)} />,
          a: (p) => <a style={{ color: "var(--accent)", textDecoration: "underline" }} target="_blank" rel="noopener noreferrer" {...(p as any)} />,
          blockquote: (p) => <blockquote style={{ borderLeft: "3px solid var(--accent)", margin: "8px 0", padding: "2px 0 2px 12px", color: "var(--fg-muted)" }} {...(p as any)} />,
          table: (p) => <div style={{ overflowX: "auto", margin: "8px 0" }}><table style={{ borderCollapse: "collapse", fontSize: 12, minWidth: "100%" }} {...(p as any)} /></div>,
          th: (p) => <th style={{ border: "1px solid var(--border)", padding: "5px 9px", background: "var(--bg-surface)", textAlign: "left", fontWeight: 600 }} {...(p as any)} />,
          td: (p) => <td style={{ border: "1px solid var(--border)", padding: "5px 9px" }} {...(p as any)} />,
          hr: () => <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "12px 0" }} />,
          strong: (p) => <strong style={{ fontWeight: 700, color: "var(--fg-strong)" }} {...(p as any)} />,
          em: (p) => <em style={{ fontStyle: "italic" }} {...(p as any)} />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

// Render a reply-stream entry (avatar + role chip + body). Shared by
// the Clear Chat tab and the reply slots inside Full Chat so a single
// look is used everywhere.
function renderReplyEntry(m: GoalMsg, i: number, focus: string, orchName: string | null) {
  const isUser = m.role === "you";
  const placeholder = m.role === focus || focus === orchName ? "…" : "";
  return (
    <div key={`r-${m.seq ?? i}`} style={{ display:"flex", alignItems:"flex-start", gap:8 }}>
      <div style={{ width:28, height:28, flexShrink:0, borderRadius:14, background:m.color, opacity:0.85, display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:700, color:"#06080d", fontFamily:"Segoe UI, sans-serif" }}>{(m.role[0] || "?").toUpperCase()}</div>
      <div style={{ flex:1, background:"var(--bg-surface)", borderLeft:`3px solid ${m.color}`, borderRadius:8, padding:"6px 12px", minWidth:0 }}>
        <div style={{ fontSize:10, fontWeight:700, color:m.color, textTransform:"uppercase", letterSpacing:0.5, marginBottom:3, fontFamily:"Segoe UI, sans-serif" }}>{m.role}</div>
        {m.text
          // User messages stay literal — they just typed it, don't
          // re-interpret '*' as italics.
          ? (isUser
            ? <div style={{ fontSize:13, color:"var(--fg)", lineHeight:1.5, fontFamily:"Segoe UI, sans-serif", whiteSpace:"pre-wrap" }}>{m.text}</div>
            : <MarkdownBody text={m.text} />)
          : <div style={{ fontSize:12, color:"var(--fg-subtle)" }}>{placeholder}</div>}
      </div>
    </div>
  );
}

// Render a thought-stream entry (rail + role label + kind-styled body).
// Same widget used by the Thought, Tool Calls, and Full Chat tabs so
// styling stays consistent across the three views.
function renderThoughtEntry(t: GoalMsg, i: number) {
  const isThinking = t.kind === "thinking";
  const isTool = t.kind === "tool";
  return (
    <div key={`t-${t.seq ?? i}`} style={{ display:"flex", alignItems:"flex-start", gap:8 }}>
      <div style={{ width:6, alignSelf:"stretch", borderRadius:3, background: t.color, opacity:0.85, flexShrink:0 }} />
      <div style={{ flex:1, background:"var(--bg-surface)", borderRadius:6, padding:"5px 10px", minWidth:0 }}>
        <div style={{ fontSize:9, fontWeight:700, color:t.color, textTransform:"uppercase", letterSpacing:0.5, marginBottom:3, fontFamily:"Segoe UI, sans-serif" }}>{t.role}</div>
        {isThinking
          // Thinking is prose — markdown gives lists, headings, code
          // blocks. Wrap in italic outer style so the "I'm reasoning"
          // signal stays.
          ? (t.text ? <div style={{ fontStyle:"italic", color:"var(--fg-muted)" }}><MarkdownBody text={t.text} /></div> : <div style={{ fontSize:12, color:"var(--fg-subtle)" }}>…</div>)
          : isTool
            // Tool calls / results are raw JSON or shell output — keep
            // monospace verbatim, never markdown (curly braces would
            // mangle).
            ? <div style={{ fontSize:12, color:"var(--fg)", whiteSpace:"pre-wrap", fontFamily:"Consolas, 'JetBrains Mono', monospace", lineHeight:1.4, background:"rgba(127,240,197,0.06)", padding:"4px 6px", borderRadius:4 }}>{t.text || "…"}</div>
            // Dispatches / fleet status / system → plain mono (short)
            : <div style={{ fontSize:12, color:"var(--fg)", whiteSpace:"pre-wrap", fontFamily:"Consolas, 'JetBrains Mono', monospace" }}>{t.text}</div>
        }
      </div>
    </div>
  );
}

// OrchestratorPane — RIGHT pane. Now driven by the active agent's
// per-agent log buffer; click a node on the canvas to view its log
// (default = whichever agent the dispatcher is currently driving,
// fallback = orchestrator).
function OrchestratorPane({
  agentLogs, agentThoughts, runError, serverState,
  selectedAgent, activeAgent,
  team, phase,
  models, modelFor, onPickAgentModel,
  accountsStatus,
}: {
  agentLogs: Map<string, GoalMsg[]>;
  agentThoughts: Map<string, GoalMsg[]>;
  runError: string | null;
  serverState: ServerStatus;
  selectedAgent: string | null;
  activeAgent: string | null;
  team: Team | null;
  phase: DispatchPhase;
  models: ModelInfo[];
  /// Resolved model id for the agent (per-agent → team default → server fallback).
  modelFor: (agentName: string) => string;
  /// Set the per-agent model override. Pass an empty string to clear.
  onPickAgentModel: (agentName: string, modelId: string) => void;
  /// Account status drives sub/API enabled flags in ModelPicker.
  accountsStatus: AccountsStatusLite | null;
}) {
  const [activeTab, setActiveTab] = useState<"reply"|"thought"|"tools"|"full">("reply");
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
  // All thought-tab traffic for this agent (thinking + tool calls +
  // tool results + dispatch directives). Split per-tab below.
  const allThoughts = agentThoughts.get(focus) ?? [];
  // Clear Chat = the reply stream as-is. Thought = reasoning + routing
  // decisions (drop tool entries — those have their own tab). Tools =
  // tool_use + tool_result. Full = everything merged in chronological
  // arrival order via the per-entry `seq` stamp.
  const thoughts = allThoughts.filter(t => t.kind !== "tool");
  const toolCalls = allThoughts.filter(t => t.kind === "tool");
  const fullChat: GoalMsg[] = [...messages, ...allThoughts]
    .slice()
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

  // Autoscroll-to-bottom — one ref per tab. Triggered on:
  //   1. tab switch (scroll the freshly-shown tab to bottom)
  //   2. content change (new entry OR last entry's text grew during a
  //      stream — we hash the tail length so the effect re-fires per
  //      character chunk while the LLM is mid-reply)
  //   3. focus change (jumping to a different agent's pane)
  // useLayoutEffect runs before paint so the user never sees the
  // scroll jump.
  const replyRef = useRef<HTMLDivElement>(null);
  const thoughtRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const fullRef = useRef<HTMLDivElement>(null);
  const tailSig = (
    `${messages.length}:${messages[messages.length - 1]?.text?.length ?? 0}|` +
    `${thoughts.length}:${thoughts[thoughts.length - 1]?.text?.length ?? 0}|` +
    `${toolCalls.length}:${toolCalls[toolCalls.length - 1]?.text?.length ?? 0}|` +
    `${fullChat.length}:${fullChat[fullChat.length - 1]?.text?.length ?? 0}`
  );
  useLayoutEffect(() => {
    const ref =
      activeTab === "reply"   ? replyRef   :
      activeTab === "thought" ? thoughtRef :
      activeTab === "tools"   ? toolsRef   :
                                fullRef;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeTab, focus, tailSig]);

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
        <ModelPicker
          value={modelFor(focus)}
          onChange={id => onPickAgentModel(focus, id)}
          models={models}
          status={accountsStatus}
          disabled={focus === "you" || focus === "system"}
          fallbackLabel={
            serverState.running && serverState.model_id
              ? `(use team / server model · ${serverState.model_id})`
              : "(use team / server model — none running)"
          }
        />
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
          {([
            { id:"reply",   label:"💬 Clear Chat", accent:"var(--accent)", count: messages.length },
            { id:"thought", label:"🧠 Thought",    accent:"#dcb0ff",       count: thoughts.length },
            { id:"tools",   label:"🛠 Tool Calls", accent:"#7ff0c5",       count: toolCalls.length },
            { id:"full",    label:"📜 Full Chat",  accent:"#ffd97a",       count: fullChat.length },
          ] as const).map(tab => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  padding:"8px 14px", border:"none", background:"transparent",
                  color: active ? tab.accent : "var(--fg-muted)",
                  fontSize:13, fontWeight:500,
                  borderBottom: active ? `1.5px solid ${tab.accent}` : "1.5px solid transparent",
                  display:"inline-flex", alignItems:"center", gap:6,
                }}
              >
                {tab.label}
                {tab.count > 0 ? (
                  <span style={{ fontSize:10, fontWeight:700, opacity:0.7, background:"var(--bg-surface)", borderRadius:8, padding:"1px 6px" }}>{tab.count}</span>
                ) : null}
              </button>
            );
          })}
          <div style={{ flex:1 }} />
        </div>
        {/* Clear Chat — the user-facing reply stream only, nothing else. */}
        <div ref={replyRef} data-ui="OrchestratorReplyView" style={{ flex:1, display: activeTab === "reply" ? "flex" : "none", flexDirection:"column", margin:"8px 10px 0", padding:10, gap:8, background:"var(--bg-panel)", border:"1px solid var(--border)", borderRadius:8, overflow:"auto", fontFamily:"Segoe UI, sans-serif", fontSize:13, lineHeight:1.5, color:"var(--fg)" }}>
          {runError ? (<div style={{ border:"1px solid #ff9f9f", background:"rgba(255,80,80,0.10)", color:"#ffb0b0", borderRadius:6, padding:8, fontSize:12 }}>{runError}</div>) : null}
          {messages.length === 0 && !runError ? (
            <div style={{ color:"var(--fg-subtle)", fontSize:12 }}>
              {serverState.running && serverState.model_id
                ? `Ready. Type a goal above and press Run — the orchestrator will plan, dispatch, and integrate.`
                : "Start a model on the Server tab first, then type a goal above and click Run."}
            </div>
          ) : null}
          {messages.map((m, i) => renderReplyEntry(m, i, focus, orchName))}
        </div>
        {/* Thought — reasoning + dispatch directives. Tool entries excluded. */}
        <div ref={thoughtRef} data-ui="OrchestratorThoughtView" style={{ flex:1, display: activeTab === "thought" ? "flex" : "none", flexDirection:"column", margin:"8px 10px 0", padding:10, gap:6, background:"var(--bg-panel)", border:"1px solid var(--border)", borderRadius:8, overflow:"auto", fontFamily:"Segoe UI, sans-serif", fontSize:13, lineHeight:1.5, color:"var(--fg)" }}>
          {thoughts.length === 0 ? (
            <div style={{ color:"var(--fg-subtle)", fontSize:11 }}>
              No reasoning yet — the model's thinking blocks land here
              while the team runs.
            </div>
          ) : thoughts.map((t, i) => renderThoughtEntry(t, i))}
        </div>
        {/* Tool Calls — every command the agent ran + its result. */}
        <div ref={toolsRef} data-ui="OrchestratorToolsView" style={{ flex:1, display: activeTab === "tools" ? "flex" : "none", flexDirection:"column", margin:"8px 10px 0", padding:10, gap:6, background:"var(--bg-panel)", border:"1px solid var(--border)", borderRadius:8, overflow:"auto", fontFamily:"Consolas, 'JetBrains Mono', monospace", fontSize:13, lineHeight:1.45, color:"var(--fg)" }}>
          {toolCalls.length === 0 ? (
            <div style={{ color:"var(--fg-subtle)", fontSize:11 }}>
              No tool calls yet — every command the agent runs (Bash,
              Read, Write, Edit, etc.) appears here with its arguments
              and the result it returned.
            </div>
          ) : toolCalls.map((t, i) => renderThoughtEntry(t, i))}
        </div>
        {/* Full Chat — replies + thoughts + tools, interleaved by arrival. */}
        <div ref={fullRef} data-ui="OrchestratorFullView" style={{ flex:1, display: activeTab === "full" ? "flex" : "none", flexDirection:"column", margin:"8px 10px 0", padding:10, gap:8, background:"var(--bg-panel)", border:"1px solid var(--border)", borderRadius:8, overflow:"auto", fontFamily:"Segoe UI, sans-serif", fontSize:13, lineHeight:1.5, color:"var(--fg)" }}>
          {fullChat.length === 0 ? (
            <div style={{ color:"var(--fg-subtle)", fontSize:11 }}>
              Empty — replies, reasoning, and tool calls will all appear
              here in chronological order once the team runs.
            </div>
          ) : fullChat.map((m, i) =>
            // Reply entries (no `kind`) get the avatar-style render,
            // everything else uses the thought renderer. Same chrono
            // order either way thanks to the `seq` stamp.
            m.kind ? renderThoughtEntry(m, i) : renderReplyEntry(m, i, focus, orchName)
          )}
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

// ---------- Team-group classification ----------
//
// Three visual groups appear on the canvas / graph / agent cards:
//
//   "design"  — the Phase-1 (Design) members of product_studio + any
//               other team that uses the same base roles. Green tint,
//               "Design Team" badge top-right.
//   "critic"  — the synthetic Director-Mode Critic. Always rendered at
//               orchestrator's row, never stored in the team's agent
//               list (so it stays orthogonal to team yamls). Rainbow.
//   "build"   — Phase-2 / generic specialists (coders, docs, code
//               critic). Blue tint, "Build Team" badge top-right.
//
// Classification is by base role. The product_studio yaml lists
// `product_owner / ux_designer / backend_arch / whitepaper_writer /
// design_critic` as its Phase-1 roster, so those are the design
// signature. Keep this in sync with any new design-phase roles teams
// add to LLM/core/agents/teams/*.json.
export type TeamGroup = "design" | "critic" | "build";
const DESIGN_TEAM_BASES = new Set<string>([
  "product_owner",
  "ux_designer",
  "backend_arch",
  "whitepaper_writer",
  "design_critic",
]);
/// Stable comparator for ordering agents WITHIN a depth row. Drives both
/// the orbital arc position and the graph-row horizontal slot. Design
/// cluster leads (with product_owner first as the team leader), build
/// cluster follows, critic sits at the tail. Returning 0 for equal
/// groups preserves the team's authored order as a stable tie-breaker.
export function rosterCompare(a: AgentSpec, b: AgentSpec): number {
  const GORDER: Record<TeamGroup, number> = { design: 0, build: 1, critic: 2 };
  const ga = groupForAgent(a);
  const gb = groupForAgent(b);
  if (ga !== gb) return GORDER[ga] - GORDER[gb];
  if (ga === "design") {
    const sa = a.name.includes(".") ? a.name.split(".").pop()! : a.name;
    const sb = b.name.includes(".") ? b.name.split(".").pop()! : b.name;
    if (sa === "product_owner" && sb !== "product_owner") return -1;
    if (sb === "product_owner" && sa !== "product_owner") return 1;
  }
  return 0;
}

function groupForAgent(spec: AgentSpec): TeamGroup {
  if (spec.name === CRITIC_AGENT_NAME) return "critic";
  // Team JSONs use fully-qualified ids like "product_studio.product_owner";
  // DESIGN_TEAM_BASES has bare role names. Strip the dotted prefix on
  // both spec fields before checking, or every design member silently
  // falls through to "build" and the design tint/badge never renders.
  const shortName = spec.name.includes(".") ? spec.name.split(".").pop()! : spec.name;
  const shortBase = spec.base.includes(".") ? spec.base.split(".").pop()! : spec.base;
  if (DESIGN_TEAM_BASES.has(shortBase) || DESIGN_TEAM_BASES.has(shortName)) return "design";
  return "build";
}
/// Background tint + border colour for a group. Semi-transparent so the
/// existing card chrome (#1a2030 base) still reads. The "critic" tint
/// is a single colour here — the rainbow effect is layered as a
/// conic-gradient border in the renderer, see RainbowBorder below.
export function tintForGroup(group: TeamGroup): { bg: string; border: string; badge?: string } {
  switch (group) {
    case "design":
      // Bumped from 0.13 → 0.22 fill + 0.85 border. Below the 0.20
      // floor the design tint was washed out next to the build tint and
      // the two clusters read as the same colour.
      return { bg: "rgba(122, 224, 168, 0.22)", border: "rgba(122, 224, 168, 0.85)", badge: "Design Team" };
    case "critic":
      // No badge — the rainbow border IS the visual identity for the
      // Critical Thinker node. Card body stays neutral so the rainbow
      // ring around it doesn't have to fight a coloured fill.
      return { bg: "rgba(255, 240, 200, 0.10)", border: "rgba(255, 220, 120, 0.55)" };
    case "build":
    default:
      // Bumped from 0.10 → 0.22 to match the design cluster opacity so
      // the two read as equally-strong visual groups instead of the
      // build cluster looking like the "default / unclassified" cards.
      return { bg: "rgba(120, 180, 255, 0.22)", border: "rgba(120, 180, 255, 0.70)", badge: "Build Team" };
  }
}

// ---------- Synthetic Critic node ----------
//
// The Director-Mode Critic is a runtime concept (dispatch.ts spins it
// up on demand to answer [NEED_USER_INPUT] markers). It's not part of
// any team yaml. But the user expects to SEE it on the canvas so they
// understand the structure. We inject a virtual AgentSpec at render
// time whenever a team has an orchestrator. Its name is reserved —
// no real team agent may use `critic` as its `name` (only as `base`),
// so the synthetic node stays unambiguous.
// Internal agent id for the synthetic Critic node. The visible label
// ("Critical Thinker") comes from displayLabel(name) — keep this id
// snake_case so that helper produces the right display string.
export const CRITIC_AGENT_NAME = "critical_thinker";
const CRITIC_SYNTHETIC_SPEC: AgentSpec = {
  name: CRITIC_AGENT_NAME,
  // Base matches the agent id so the small base-role text on the card
  // ("CRITICAL_THINKER") matches the displayed name. No role yaml is
  // required — roleByName.get() falls through and the spec's inline
  // description is used.
  base: "critical_thinker",
  description: "Voice of the user. Reviews the orchestrator's plan, answers [NEED_USER_INPUT] when Director Mode is on.",
  icon: "owl:owl_critic",
};
/// Return a team augmented with the synthetic critic node. Idempotent:
/// if the team already has an agent literally named "critic" we return
/// the team unchanged (the team author already accounted for it).
function withSyntheticCritic(team: Team | null): Team | null {
  if (!team) return null;
  if (team.agents.some(a => a.name === CRITIC_AGENT_NAME)) return team;
  const orch = findOrchestratorSpec(team);
  if (!orch) return team; // no orchestrator → no critic; nothing to peer with
  return { ...team, agents: [...team.agents, CRITIC_SYNTHETIC_SPEC] };
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
  directives?: Directive[],
  directorMode?: boolean,
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
  const directivesBlock = formatDirectivesBlock(directives);
  const directorBlock = directorMode
    ? [
        "",
        "--- DIRECTOR MODE: A Critic agent stands in for the user ---",
        "If you need a decision normally reserved for the user (scope, naming, business logic, tradeoffs),",
        "emit a line beginning with `[NEED_USER_INPUT]` followed by your question on the same line.",
        "Example:  [NEED_USER_INPUT] Should the new endpoint require auth?",
        "The runtime will route that to the Critic, who answers in the user's voice from the project rules,",
        "and re-invoke you with the answer folded in. Use sparingly — once or twice per dispatch at most.",
        "--- END DIRECTOR MODE ---",
      ].join("\n")
    : "";
  return [
    `You are the orchestrator of the '${team.display}' team.`,
    "",
    orchSystemPrompt,
    directivesBlock,
    directorBlock,
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
  directives?: Directive[],
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
  const directivesBlock = formatDirectivesBlock(directives);
  if (directivesBlock) {
    layers.push(directivesBlock);
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
type HistoryItem = { role: "user" | "assistant"; content: string };

// Convert the SuperUser transcript (or project.chat_json) into the
// alternating user/assistant turns every model API expects. Skips
// system/error notes ("role: system") and empty messages so the
// history stays clean. Used for both desktop SuperUser sends and the
// Telegram bridge so a restarted app — or a fresh Telegram message —
// can pick up where the previous turn left off.
function chatToHistory(chat: GoalMsg[]): HistoryItem[] {
  const out: HistoryItem[] = [];
  for (const m of chat) {
    if (!m || typeof m.text !== "string" || !m.text.trim()) continue;
    if (m.role === "system" || m.role === "error" || m.role === "dispatch") continue;
    out.push({
      role: m.role === "you" ? "user" : "assistant",
      content: m.text,
    });
  }
  return out;
}

/// Route the SSE chat-completion to whichever backend serves the
/// model. The signature stays the same so the dispatch loop doesn't
/// care which provider it's talking to — only the resolver layer
/// (modelFor + provider lookup) does.
// Channel-keyed thinking/tool stream. Mirrors dispatch.ts ThoughtHandler.
// `channel` is a stable per-block id ("thinking", "tool:Write:abc"),
// `role` is the human label ("🧠 thinking", "🛠 Write"), `delta` the chunk.
type ThoughtHandler = (channel: string, role: string, delta: string) => void;

// Mirror of accounts.rs ClaudeStreamEvent (Tauri ipc::Channel payload).
type ClaudeStreamEvent =
  | { kind: "text"; delta: string }
  | { kind: "thinking"; delta: string }
  | { kind: "toolUse"; toolUseId: string; name: string; input: string }
  | { kind: "toolResult"; toolUseId: string; content: string }
  | { kind: "error"; message: string };

// Streaming variant of claude_cli_complete — uses claude --print
// --output-format stream-json --verbose so the Thought tab gets live
// thinking blocks + tool_use commands as the CLI emits them. Returns
// the assembled assistant text.
async function runClaudeCliStream(args: {
  systemPrompt: string;
  userMessage: string;
  cwd?: string | null;
  autoApprove?: boolean;
  /// Per-role tool allowlist (OWLLM-style names — read_file, shell,
  /// edit_file, …). Forwarded to the CLI as --allowedTools after the
  /// Rust side translates to Claude tool names. Omit / pass empty to
  /// run unrestricted (operator behaviour).
  allowedTools?: string[];
  /// Bare Claude model id (no ":effort" suffix). Forwards as --model.
  model?: string | null;
  /// Effort tier: "low"|"medium"|"high"|"xhigh"|"max". Forwards as --effort.
  effort?: string | null;
  /// Persistent session UUID for multi-turn memory.
  sessionId?: string | null;
  briefMode?: boolean;
  /// Called when the agent emits a SendUserMessage tool call. Caller
  /// shows the question to the user (modal, inline prompt, chat
  /// entry). Phase C v1: not yet wired to bidirectional reply.
  onAskUser?: (question: string) => void;
  onDelta: (delta: string) => void;
  onThought: ThoughtHandler;
}): Promise<string> {
  const ch = new Channel<ClaudeStreamEvent>();
  ch.onmessage = (msg) => {
    switch (msg.kind) {
      case "text":
        args.onDelta(msg.delta);
        break;
      case "thinking":
        args.onThought("thinking", "🧠 thinking", msg.delta);
        break;
      case "toolUse": {
        if (msg.name === "SendUserMessage") {
          let q = msg.input || "";
          try {
            const parsed = JSON.parse(msg.input);
            if (parsed && typeof parsed.message === "string") q = parsed.message;
            else if (parsed && typeof parsed.text === "string") q = parsed.text;
          } catch { /* raw input */ }
          if (args.onAskUser) args.onAskUser(q);
          args.onThought("ask-user", "❓ agent asks", q);
          break;
        }
        const channel = `tool:${msg.name}:${msg.toolUseId}`;
        args.onThought(channel, `🛠 ${msg.name}`, msg.input || "");
        break;
      }
      case "toolResult": {
        const channel = `tool-result:${msg.toolUseId}`;
        const snippet = msg.content.length > 800
          ? msg.content.slice(0, 800) + "\n…(truncated)"
          : msg.content;
        args.onThought(channel, "↩ result", snippet);
        break;
      }
      case "error":
        args.onThought("cli-error", "⚠ cli", msg.message);
        break;
    }
  };
  return await invoke<string>("claude_cli_stream", {
    systemPrompt: args.systemPrompt,
    userMessage: args.userMessage,
    cwd: args.cwd ?? null,
    autoApprove: args.autoApprove ?? false,
    allowedTools: args.allowedTools && args.allowedTools.length > 0 ? args.allowedTools : null,
    model: args.model ?? null,
    effort: args.effort ?? null,
    sessionId: args.sessionId ?? null,
    // Default --brief on — matches VS Code Claude Code. The agent can
    // always ask via SendUserMessage; question lands in the chat as a
    // prominent "❓ agent asks" entry.
    briefMode: args.briefMode ?? true,
    onEvent: ch,
  });
}

// Per-role tool allowlist (OWLLM-style names) forwarded into the
// Claude CLI subscription path as --allowedTools. See accounts.rs::
// map_owllm_tool_to_cli for the name translation. Optional on every
// layer so non-CLI providers (OpenAI / local) ignore it.
type AllowedTools = string[] | undefined;

async function streamChatCompletion(
  port: number,
  modelId: string,
  provider: string,
  systemPrompt: string,
  userMessage: string,
  temperature: number,
  signal: AbortSignal,
  onDelta: StreamHandler,
  /// Project location, threaded into the Claude Code CLI when the
  /// dispatch resolves to the subscription path. Without it the CLI
  /// inherits the desktop app's install dir and ends up reasoning
  /// about the wrong tree.
  projectCwd?: string,
  /// Prior conversation turns. For API paths this becomes the
  /// `messages` array preceding the current user turn; for the
  /// Claude CLI subscription path it's folded into the user prompt
  /// (the CLI's --print mode is one-shot and has no inherent memory).
  history?: HistoryItem[],
  /// When true and the dispatch resolves to the Claude CLI sub path,
  /// the CLI is invoked with --dangerously-skip-permissions so file
  /// writes / bash runs don't stall on permission prompts. Honoured
  /// only when the user has opted in via the SuperUserCard checkbox
  /// or the Telegram bridge's auto_approve flag.
  autoApprove?: boolean,
  /// Streaming reasoning + tool-call channel. Fires for Anthropic
  /// thinking / tool_use blocks, OpenAI reasoning_content + tool_calls,
  /// and local <think>/<thinking> tag content. Skipped for the Claude
  /// CLI subscription path (--print mode emits one final blob — see TODO).
  onThought?: ThoughtHandler,
  /// Per-role tool allowlist. Only meaningful on the Claude CLI sub
  /// path; ignored elsewhere.
  allowedTools?: AllowedTools,
  /// Multimodal attachments. Audio is transcribed up-front (Whisper);
  /// images ride to the provider's native image part shape.
  attachments?: Attachment[],
  /// Claude CLI session UUID for multi-turn memory (Phase B). Only
  /// used by CLI subscription branches; OpenAI/local/API paths ignore.
  sessionId?: string | null,
): Promise<string> {
  // Strip the optional route prefix encoded by the ModelPicker before
  // handing the bare model id to the provider-specific call.
  const forceSub = modelId.startsWith("sub/");
  const forceApi = modelId.startsWith("api/");
  const bareId = forceSub || forceApi || modelId.startsWith("auto/")
    ? modelId.slice(modelId.indexOf("/") + 1)
    : modelId;

  // Audio attachments collapse into the user message via Whisper.
  // Images stay on the side and get a provider-specific encoding.
  const effectiveText = await transcribeAudioAttachments(userMessage, attachments);
  const images = imageAttachments(attachments);

  if (provider === "auto") {
    // Future slot. For now resolve to a local model when one exists,
    // otherwise fail with an actionable message.
    throw new Error(`Auto routing (${modelId}) is not implemented yet — pick a specific model.`);
  }
  if (provider === "anthropic") {
    return streamAnthropic(bareId, { forceSub, forceApi }, systemPrompt, effectiveText, temperature, signal, onDelta, projectCwd, history, autoApprove, onThought, allowedTools, images, sessionId);
  }
  if (provider === "openai") {
    return streamOpenAI(bareId, { forceSub, forceApi }, systemPrompt, effectiveText, temperature, signal, onDelta, history, onThought, images);
  }
  if (provider === "moonshot") {
    return streamMoonshot(bareId, { forceSub, forceApi }, systemPrompt, effectiveText, temperature, signal, onDelta, projectCwd, history, onThought, images);
  }
  // Local llama-server. OpenAI-compatible SSE. History (when present)
  // becomes the alternating user/assistant turns preceding the new
  // user message — gives the model continuity across restarts.
  const messages: Array<{ role: string; content: unknown }> = [
    { role: "system", content: systemPrompt },
    ...(history ?? []),
    { role: "user", content: openaiUserContent(effectiveText, images) },
  ];
  const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelId || "local",
      messages,
      stream: true,
      temperature,
    }),
    signal,
  });
  return consumeOpenAISse(resp, onDelta, onThought);
}

/// Anthropic Messages API streaming. Format:
///   event: content_block_delta
///   data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}
/// We only care about text_delta entries; everything else (ping, stop
/// events) is ignored for plain-text streaming.
///
/// Fallback: when no ANTHROPIC_API_KEY is saved but the user's Claude
/// Code CLI subscription is connected, we shell out to `claude --print`
/// instead of hitting api.anthropic.com directly. This works without
/// the user paying for API credits — they use the same subscription
/// that powers their normal Claude Code sessions. Trade-off: --print
/// mode emits the full reply at the end (no token streaming).
type CloudRoute = { forceSub?: boolean; forceApi?: boolean };

// Embed prior conversation turns into a single user prompt — used by
// the Claude CLI subscription path because `claude --print` is one-shot
// and has no native session/history input. Each turn is labelled so
// the model knows who said what.
function foldHistoryIntoPrompt(userMessage: string, history?: HistoryItem[]): string {
  if (!history || history.length === 0) return userMessage;
  const lines: string[] = ["--- Previous conversation ---"];
  for (const h of history) {
    lines.push(`${h.role === "user" ? "User" : "Assistant"}: ${h.content}`);
    lines.push("");
  }
  lines.push("--- Current user message ---");
  lines.push(userMessage);
  return lines.join("\n");
}

async function streamAnthropic(
  modelId: string,
  route: CloudRoute,
  systemPrompt: string,
  userMessage: string,
  temperature: number,
  signal: AbortSignal,
  onDelta: StreamHandler,
  projectCwd?: string,
  history?: HistoryItem[],
  autoApprove?: boolean,
  onThought?: ThoughtHandler,
  allowedTools?: AllowedTools,
  /// Image attachments only — audio was transcribed in streamChatCompletion.
  /// API path embeds images natively. CLI subscription path is text-only;
  /// we surface a note so silently-dropped attachments don't confuse the user.
  images?: Attachment[],
  /// Claude CLI session UUID for multi-turn memory (Phase B). Only
  /// used by CLI subscription branches.
  sessionId?: string | null,
): Promise<string> {
  const wantSub = route.forceSub === true;
  const wantApi = route.forceApi === true;
  const imgList = images ?? [];
  // Split ":effort" off the model id so both the CLI (--model + --effort)
  // and the API (thinking budget in buildAnthropicBody) get clean inputs.
  const { wireModel: cliModel, effort: cliEffortRaw } = parseClaudeModelId(modelId);
  const claudeEffort = mapClaudeEffort(cliEffortRaw);
  const cliUserMessage = imgList.length > 0
    ? `${userMessage}\n\n[${imgList.length} image attachment(s) dropped — switch to the API row to send images to Claude.]`
    : userMessage;
  // Claude CLI's --print mode is one-shot — no inherent memory across
  // calls — so fold the prior conversation into the user prompt the
  // CLI sees. The CLI then has everything it needs to continue.
  const cliPrompt = foldHistoryIntoPrompt(cliUserMessage, history);
  // forceSub: skip the API path entirely and go straight to the CLI.
  if (wantSub) {
    const status = await invoke<{ claude_cli: boolean }>("accounts_status");
    if (!status?.claude_cli) {
      throw new Error("Claude Code CLI not detected — run `claude /login` first.");
    }
    // Stream via claude_cli_stream when the consumer wants live
    // thought traffic (AgentsPage Thought tab); fall back to one-shot
    // --print blob otherwise.
    if (onThought) {
      return await runClaudeCliStream({
        systemPrompt, userMessage: cliPrompt, cwd: projectCwd ?? null,
        autoApprove: autoApprove ?? false, allowedTools,
        model: cliModel, effort: claudeEffort, sessionId,
        onDelta, onThought,
      });
    }
    const reply = await invoke<string>("claude_cli_complete", {
      systemPrompt, userMessage: cliPrompt, cwd: projectCwd ?? null,
      autoApprove: autoApprove ?? false,
      model: cliModel, effort: claudeEffort, sessionId,
    });
    if (reply) onDelta(reply);
    return reply;
  }
  const key = await invoke<string | null>("accounts_get_secret", { name: "ANTHROPIC_API_KEY" });
  if (!key) {
    if (wantApi) throw new Error("No ANTHROPIC_API_KEY saved — set it on the Accounts page.");
    // Default (unforced) path: try CLI subscription as a fallback.
    try {
      const status = await invoke<{ claude_cli: boolean }>("accounts_status");
      if (status?.claude_cli) {
        if (onThought) {
          return await runClaudeCliStream({
            systemPrompt, userMessage: cliPrompt, cwd: projectCwd ?? null,
            autoApprove: autoApprove ?? false, allowedTools,
            model: cliModel, effort: claudeEffort, sessionId,
            onDelta, onThought,
          });
        }
        const reply = await invoke<string>("claude_cli_complete", {
          systemPrompt,
          userMessage: cliPrompt,
          cwd: projectCwd ?? null,
          autoApprove: autoApprove ?? false,
          model: cliModel, effort: claudeEffort, sessionId,
        });
        if (reply) onDelta(reply);
        return reply;
      }
    } catch (e) {
      console.error("claude_cli_complete failed", e);
    }
    throw new Error(
      "No ANTHROPIC_API_KEY saved and Claude Code CLI not detected. " +
      "Either save a key on the Accounts page OR install + sign in to Claude Code (`claude /login`)."
    );
  }
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(buildAnthropicBody(modelId, systemPrompt, history, userMessage, imgList, temperature)),
    signal,
  });
  if (!resp.ok || !resp.body) {
    throw new Error(await resp.text().catch(() => `HTTP ${resp.status}`));
  }
  return consumeAnthropicSse(resp, onDelta, onThought);
}

/// Parse the optional ":<effort>" suffix off the Anthropic model id
/// (set by ModelPicker for Opus 4.7 / Sonnet 4.6) and translate the
/// tier into extended-thinking parameters. Mirrors the same helper in
/// dispatch.ts — kept in lockstep until the two streams collapse to
/// one in a future refactor.
///
/// Tier → (budget_tokens, max_tokens, forced temperature):
///   low (or none) → 0    / 4096  / caller's temp
///   medium        → 4000 / 8192  / 1 (Anthropic mandates temp=1 with thinking)
///   high          → 8000 / 16384 / 1
///   extra_high    → 16000/ 24576 / 1
function buildAnthropicBody(
  modelId: string,
  systemPrompt: string,
  history: HistoryItem[] | undefined,
  userMessage: string,
  imgList: Attachment[],
  temperature: number,
): unknown {
  const sep = modelId.indexOf(":");
  const wireModel = sep === -1 ? modelId : modelId.slice(0, sep);
  const effort = sep === -1 ? null : modelId.slice(sep + 1);
  const budget = effort === "extra_high" ? 16000
              : effort === "high" ? 8000
              : effort === "medium" ? 4000
              : 0;
  const thinkingOn = budget > 0;
  const maxTokens = thinkingOn ? budget + 4096 : 4096;
  const reqTemp = thinkingOn ? 1 : temperature;
  return {
    model: wireModel,
    max_tokens: maxTokens,
    ...(thinkingOn ? { thinking: { type: "enabled", budget_tokens: budget } } : {}),
    system: systemPrompt,
    messages: [
      ...(history ?? []).map(h => ({ role: h.role, content: h.content })),
      { role: "user", content: anthropicUserContent(userMessage, imgList) },
    ],
    stream: true,
    temperature: reqTemp,
  };
}

// Anthropic Messages SSE consumer — splits the stream into three
// channels: text deltas → onDelta, thinking deltas → onThought
// ("thinking:<idx>"), tool_use blocks → onThought("tool:<name>:<id>").
async function consumeAnthropicSse(
  resp: Response,
  onDelta: StreamHandler,
  onThought?: ThoughtHandler,
): Promise<string> {
  const reader = resp.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let acc = "";
  const blocks = new Map<number, { kind: "text" | "thinking" | "tool"; channel: string; role: string }>();
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
      if (!body) continue;
      try {
        const j = JSON.parse(body);
        if (j?.type === "content_block_start") {
          const idx: number = j.index;
          const block = j.content_block;
          if (block?.type === "thinking") {
            blocks.set(idx, { kind: "thinking", channel: `thinking:${idx}`, role: "🧠 thinking" });
          } else if (block?.type === "tool_use") {
            const name = String(block?.name ?? "tool");
            const id = String(block?.id ?? idx);
            const channel = `tool:${name}:${id}`;
            blocks.set(idx, { kind: "tool", channel, role: `🛠 ${name}` });
            onThought?.(channel, `🛠 ${name}`, "");
          } else {
            blocks.set(idx, { kind: "text", channel: "", role: "" });
          }
        } else if (j?.type === "content_block_delta") {
          const idx: number = j.index;
          const meta = blocks.get(idx);
          const delta = j.delta;
          if (meta?.kind === "thinking" && typeof delta?.thinking === "string") {
            onThought?.(meta.channel, meta.role, delta.thinking);
          } else if (meta?.kind === "tool" && typeof delta?.partial_json === "string") {
            onThought?.(meta.channel, meta.role, delta.partial_json);
          } else if (typeof delta?.text === "string" && delta.text) {
            acc += delta.text;
            onDelta(delta.text);
          }
        }
      } catch { /* skip malformed chunk */ }
    }
  }
  return acc;
}

/// OpenAI chat-completions streaming. Same SSE shape as llama-server.
async function streamOpenAI(
  modelId: string,
  _route: CloudRoute,
  systemPrompt: string,
  userMessage: string,
  temperature: number,
  signal: AbortSignal,
  onDelta: StreamHandler,
  history?: HistoryItem[],
  onThought?: ThoughtHandler,
  /// Image attachments only — audio was transcribed in streamChatCompletion.
  images?: Attachment[],
): Promise<string> {
  // Codex CLI subscription support is a future slot — for now both
  // forceSub and the default flow route through the API path, so this
  // throws cleanly when no key is saved.
  const key = await invoke<string | null>("accounts_get_secret", { name: "OPENAI_API_KEY" });
  if (!key) throw new Error("No OPENAI_API_KEY saved — set it on the Accounts page.");
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: "system", content: systemPrompt },
        ...(history ?? []),
        { role: "user", content: openaiUserContent(userMessage, images ?? []) },
      ],
      stream: true,
      temperature,
    }),
    signal,
  });
  return consumeOpenAISse(resp, onDelta, onThought);
}

/// Moonshot AI / Kimi streaming. Two routes:
///   * subscription — shell out to Moonshot's `kimi --print` CLI.
///     Used when the picker resolved to a `sub/<id>` row AND the
///     user is logged into the Kimi CLI. Non-streaming: the CLI emits
///     one final reply, which we flush via a single onDelta call.
///   * API — OpenAI-compatible REST at api.moonshot.ai/v1, same SSE
///     shape so we reuse consumeOpenAISse.
async function streamMoonshot(
  modelId: string,
  route: CloudRoute,
  systemPrompt: string,
  userMessage: string,
  temperature: number,
  signal: AbortSignal,
  onDelta: StreamHandler,
  projectCwd?: string,
  history?: HistoryItem[],
  onThought?: ThoughtHandler,
  images?: Attachment[],
): Promise<string> {
  // Subscription path — shell to `kimi --print`. Fold history into the
  // user prompt because the CLI's --print mode is single-turn.
  if (route.forceSub) {
    const folded = (history ?? [])
      .map((h) => `${h.role}: ${typeof h.content === "string" ? h.content : ""}`)
      .join("\n\n");
    const composed = folded ? `${folded}\n\nuser: ${userMessage}` : userMessage;
    const reply = await invoke<string>("kimi_cli_complete", {
      systemPrompt,
      userMessage: composed,
      cwd: projectCwd ?? null,
      model: modelId,
    });
    if (reply) onDelta(reply);
    // No thought stream for --print mode; CLI emits a single blob.
    return reply;
  }
  // API path — OpenAI-compatible streaming.
  const key = await invoke<string | null>("accounts_get_secret", { name: "MOONSHOT_API_KEY" });
  if (!key) throw new Error("No MOONSHOT_API_KEY saved — set it on the Accounts page.");
  const resp = await fetch("https://api.moonshot.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: "system", content: systemPrompt },
        ...(history ?? []),
        { role: "user", content: openaiUserContent(userMessage, images ?? []) },
      ],
      stream: true,
      temperature,
    }),
    signal,
  });
  return consumeOpenAISse(resp, onDelta, onThought);
}

/// Shared SSE consumer for OpenAI-compatible endpoints (llama-server,
/// api.openai.com). Routes:
///   - delta.content (with <think>/<thinking> stripped) → onDelta
///   - text inside <think> tags → onThought("thinking", …)
///   - delta.reasoning_content (DeepSeek-R1, o-series) → onThought("thinking", …)
///   - delta.tool_calls[] → onThought("tool:<name>:<i>", "🛠 <name>", …)
async function consumeOpenAISse(
  resp: Response,
  onDelta: StreamHandler,
  onThought?: ThoughtHandler,
): Promise<string> {
  if (!resp.ok || !resp.body) {
    throw new Error(await resp.text().catch(() => `HTTP ${resp.status}`));
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let acc = "";
  let inThink = false;
  const toolNames = new Map<number, string>();
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
        const delta = j?.choices?.[0]?.delta;
        if (!delta) continue;
        const reasoning: string | undefined = delta?.reasoning_content ?? delta?.reasoning;
        if (typeof reasoning === "string" && reasoning) {
          onThought?.("thinking", "🧠 thinking", reasoning);
        }
        const toolCalls: any[] | undefined = delta?.tool_calls;
        if (Array.isArray(toolCalls)) {
          for (const tc of toolCalls) {
            const idx: number = typeof tc?.index === "number" ? tc.index : 0;
            const fn = tc?.function ?? {};
            if (typeof fn?.name === "string" && fn.name) {
              toolNames.set(idx, fn.name);
              const channel = `tool:${fn.name}:${idx}`;
              onThought?.(channel, `🛠 ${fn.name}`, "");
            }
            if (typeof fn?.arguments === "string" && fn.arguments) {
              const name = toolNames.get(idx) ?? "tool";
              const channel = `tool:${name}:${idx}`;
              onThought?.(channel, `🛠 ${name}`, fn.arguments);
            }
          }
        }
        const content: string | undefined = delta?.content;
        if (typeof content === "string" && content) {
          const split = splitThinkTags(content, inThink);
          inThink = split.inThink;
          if (split.thought) onThought?.("thinking", "🧠 thinking", split.thought);
          if (split.reply)   { acc += split.reply; onDelta(split.reply); }
        }
      } catch { /* skip malformed chunk */ }
    }
  }
  return acc;
}

// Streaming-safe <think> / <thinking> tag splitter — see dispatch.ts
// for the full notes. Tags split across chunks fall through as literal
// text; full-tag-in-one-chunk (the common case) routes correctly.
function splitThinkTags(chunk: string, inThink: boolean): { reply: string; thought: string; inThink: boolean } {
  let reply = "";
  let thought = "";
  let i = 0;
  const open = /<think(?:ing)?>/i;
  const close = /<\/think(?:ing)?>/i;
  while (i < chunk.length) {
    const rest = chunk.slice(i);
    if (inThink) {
      const m = rest.match(close);
      if (!m) { thought += rest; break; }
      thought += rest.slice(0, m.index!);
      i += m.index! + m[0].length;
      inThink = false;
    } else {
      const m = rest.match(open);
      if (!m) { reply += rest; break; }
      reply += rest.slice(0, m.index!);
      i += m.index! + m[0].length;
      inThink = true;
    }
  }
  return { reply, thought, inThink };
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

// Hook: track a ref'd element's rendered width + height via
// ResizeObserver. Used to feed dynamic dimensions into the SVG-based
// TeamCanvas / GraphCanvas, which can't compute their own layout
// from CSS.
function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const rect = e.contentRect;
        setSize({ w: Math.floor(rect.width), h: Math.floor(rect.height) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, size };
}

export default function AgentsPage() {
  const SPLITTER_W = 8;
  /// Live size of the canvas container — fed into TeamCanvas /
  /// GraphCanvas so the SVG layouts scale with the window.
  const canvasSize = useElementSize<HTMLDivElement>();

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
  /// Optional override of the project's team_default_model_id. When
  /// null we render the saved value; when non-null we render this and
  /// persist it on a debounce.
  const [teamModelOverride, setTeamModelOverride] = useState<string | null>(null);
  /// Per-agent model picks. Keys are agent names (matching team.agents);
  /// values are the model_id chosen on the OrchestratorPane Model
  /// dropdown. Empty string means "no override" (fall back to the team
  /// default → server model).
  const [perAgentModel, setPerAgentModel] = useState<Map<string, string>>(new Map());
  /// Discovered GGUFs from the model registry. Loaded once on mount;
  /// refreshed when the user re-opens the Server tab (the registry
  /// itself is disk-backed and stable for a given session).
  const [models, setModels] = useState<ModelInfo[]>([]);
  /// Account presence flags driving the ModelPicker's enabled / dimmed
  /// states. Polled every 4s so the picker flips live when the user
  /// saves / removes credentials on the Accounts page.
  const [accountsStatus, setAccountsStatus] = useState<AccountsStatusLite | null>(null);

  // Goal input — persisted per-project to localStorage so the text the
  // user typed survives page navigation. Same pattern as the SuperUser
  // draft (sync write through a ref, no useEffect race).
  const GOAL_DEFAULT = "summarize the last commit and propose a follow-up";
  const goalKey = selectedProjectId ? `owllm:goal:${selectedProjectId}` : "";
  const goalKeyRef = useRef(goalKey);
  goalKeyRef.current = goalKey;
  const [goal, setGoalState] = useState<string>(() => {
    if (!goalKey) return GOAL_DEFAULT;
    try { return localStorage.getItem(goalKey) ?? GOAL_DEFAULT; } catch { return GOAL_DEFAULT; }
  });
  useEffect(() => {
    if (!goalKey) { setGoalState(GOAL_DEFAULT); return; }
    try {
      const stored = localStorage.getItem(goalKey);
      setGoalState(stored !== null ? stored : GOAL_DEFAULT);
    } catch { setGoalState(GOAL_DEFAULT); }
  }, [goalKey]);
  const setGoal = (v: string) => {
    setGoalState(v);
    const k = goalKeyRef.current;
    if (k) {
      try { localStorage.setItem(k, v); } catch {}
    }
  };
  const [busy, setBusy] = useState<boolean>(false);
  const [runError, setRunError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Multimodal attachments queued against the next Run. Cleared the
  // moment dispatchGoal kicks off — once the orchestrator has them in
  // its context, the user's chip strip should empty so the next prompt
  // is unencumbered. In-memory only (base64); not persisted.
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  // Per-agent log buffers — keyed by agent.name (plus "you" for the
  // user goal echo and "system" for errors). OrchestratorPane filters
  // these by selectedNode; canvas highlights members of `activeAgents`.
  const [agentLogs, setAgentLogs] = useState<Map<string, GoalMsg[]>>(new Map());
  // Thought buffers — parallel to agentLogs but holds the agent's
  // INTERNAL traffic instead of the conversational reply. Today's
  // populator is the orchestrator's @agent: dispatch directives; the
  // OpenAI tool-calls + Anthropic thinking-block channels can slot in
  // later without touching the consumer-side UI.
  const [agentThoughts, setAgentThoughts] = useState<Map<string, GoalMsg[]>>(new Map());
  // Active agents — a SET because specialists run in parallel during
  // dispatch (orchestrator plan dispatches @A + @B + @C, all three
  // light up at once and the canvas pulses every member). Started as
  // a single string; the change is essential for the parallel flow.
  const [activeAgents, setActiveAgents] = useState<Set<string>>(new Set());
  const addActive = (name: string) => {
    setActiveAgents(prev => {
      if (prev.has(name)) return prev;
      const next = new Set(prev);
      next.add(name);
      return next;
    });
  };
  const removeActive = (name: string) => {
    setActiveAgents(prev => {
      if (!prev.has(name)) return prev;
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
  };
  const clearActive = () => setActiveAgents(new Set());
  // OrchestratorPane focus needs a single "primary" — pick whichever
  // agent went active most recently (Sets preserve insertion order in
  // modern JS, so .values().next() gives the oldest, but for the
  // primary we want the newest — Array.from + last).
  const activeAgent: string | null = activeAgents.size > 0
    ? Array.from(activeAgents)[activeAgents.size - 1]
    : null;
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
  // can chat alongside a running plan).
  const [supChat, setSupChat] = useState<GoalMsg[]>([]);
  // Auto-approve flag — persisted per project to localStorage so a
  // user who checks "auto-approve every tool call" doesn't have to
  // re-check it after every app restart (which would otherwise
  // silently revert and the next bot run would stall on permission
  // prompts).
  const autoApproveKey = selectedProjectId ? `owllm:autoapprove:${selectedProjectId}` : "";
  const autoApproveKeyRef = useRef(autoApproveKey);
  autoApproveKeyRef.current = autoApproveKey;
  const [autoApprove, setAutoApproveState] = useState<boolean>(() => {
    if (!autoApproveKey) return false;
    try { return localStorage.getItem(autoApproveKey) === "1"; } catch { return false; }
  });
  useEffect(() => {
    if (!autoApproveKey) { setAutoApproveState(false); return; }
    try { setAutoApproveState(localStorage.getItem(autoApproveKey) === "1"); }
    catch { setAutoApproveState(false); }
  }, [autoApproveKey]);
  const setAutoApprove = (v: boolean | ((prev: boolean) => boolean)) => {
    setAutoApproveState(prev => {
      const next = typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v;
      const k = autoApproveKeyRef.current;
      if (k) {
        try { localStorage.setItem(k, next ? "1" : "0"); } catch {}
      }
      return next;
    });
  };

  // ---------- Directives + Director Mode ----------
  // Directives = project-scoped natural-language rules ("never mock
  // data", "keep modules under 500 lines", …). Persisted server-side
  // via the directives_* Tauri commands; loaded once per project and
  // refetched whenever the user adds / edits / deletes one via the
  // DirectivesPanel.
  //
  // Director Mode = a flag on the SuperUserCard. When ON, orchestrator
  // [NEED_USER_INPUT] markers route to the Critic agent (voice-of-user)
  // instead of stalling. Persisted on agent_projects.director_mode so
  // it survives restarts.
  const [directives, setDirectives] = useState<Directive[]>([]);
  const [directorMode, setDirectorModeState] = useState<boolean>(false);
  const [directivesPanelOpen, setDirectivesPanelOpen] = useState(false);
  // Reload directives + director_mode whenever the active project
  // changes. Both fetches run in parallel; errors fall back to empty /
  // false so a fresh DB before the table exists doesn't break the UI.
  useEffect(() => {
    if (!selectedProjectId) { setDirectives([]); setDirectorModeState(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const [list, mode] = await Promise.all([
          invoke<Directive[]>("directives_list", { projectId: selectedProjectId }),
          invoke<boolean>("project_get_director_mode", { projectId: selectedProjectId }),
        ]);
        if (cancelled) return;
        setDirectives(list);
        setDirectorModeState(mode);
      } catch (e) {
        if (cancelled) return;
        console.warn("directives load failed", e);
        setDirectives([]);
        setDirectorModeState(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedProjectId]);
  const reloadDirectives = async () => {
    if (!selectedProjectId) return;
    try {
      const list = await invoke<Directive[]>("directives_list", { projectId: selectedProjectId });
      setDirectives(list);
    } catch (e) { console.warn("directives reload failed", e); }
  };
  const setDirectorMode = async (v: boolean) => {
    setDirectorModeState(v);
    if (!selectedProjectId) return;
    try {
      await invoke("project_set_director_mode", { projectId: selectedProjectId, enabled: v });
    } catch (e) {
      console.warn("set director_mode failed", e);
    }
  };

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
      const [rawProjects, rawTeams, rawRoles, rawBridges, rawModels] = await Promise.all([
        invoke<ProjectRow[]>("list_projects").catch(() => [] as ProjectRow[]),
        invoke<TeamTemplateBackend[]>("list_team_templates").catch(() => [] as TeamTemplateBackend[]),
        invoke<AgentRoleBackend[]>("list_agent_roles").catch(() => [] as AgentRoleBackend[]),
        invoke<BridgeConfigs>("load_bridge_configs").catch(() => ({
          telegram: { bot_token: "", project_id: "" },
          whatsapp: { access_token: "", project_id: "" },
        } as BridgeConfigs)),
        invoke<ModelInfo[]>("list_models").catch(() => [] as ModelInfo[]),
      ]);
      if (dead) return;
      setProjects(rawProjects);
      setModels(rawModels);
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
          toolAllowlist: Array.isArray(d.tool_allowlist)
            ? d.tool_allowlist.filter((t: unknown): t is string => typeof t === "string")
            : undefined,
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

  // Poll Accounts presence — drives the ModelPicker's available /
  // dimmed states for the (subscription) + (API) variants of each
  // cloud model. 4s cadence: cheap and not latency-critical.
  useEffect(() => {
    let dead = false;
    const tick = async () => {
      try {
        const s = await invoke<AccountsStatusLite>("accounts_status");
        if (!dead) setAccountsStatus(s);
      } catch { /* keep last good value */ }
    };
    tick();
    const id = window.setInterval(tick, 4000);
    return () => { dead = true; window.clearInterval(id); };
  }, []);

  const selectedProject = projects.find(p => p.id === selectedProjectId) ?? null;

  // Sync editable fields when project selection changes.
  useEffect(() => {
    if (selectedProject) {
      setLocationOverride(selectedProject.location || "");
      setTrustWritesOverride(null);
      setTeamModelOverride(null);
      // Wipe per-agent model picks too — they belong to a single
      // project session, not across projects.
      setPerAgentModel(new Map());
      // Restore saved chat + per-agent transcripts. Empty strings or
      // malformed JSON fall back to a fresh chat for the project.
      try {
        const parsed = selectedProject.chat_json
          ? JSON.parse(selectedProject.chat_json)
          : [];
        setSupChat(Array.isArray(parsed) ? parsed : []);
      } catch { setSupChat([]); }
      try {
        const parsed = selectedProject.agent_logs_json
          ? JSON.parse(selectedProject.agent_logs_json)
          : {};
        if (parsed && typeof parsed === "object") {
          const m = new Map<string, GoalMsg[]>();
          for (const k of Object.keys(parsed)) {
            const v = (parsed as any)[k];
            if (Array.isArray(v)) m.set(k, v);
          }
          setAgentLogs(m);
        } else {
          setAgentLogs(new Map());
        }
      } catch { setAgentLogs(new Map()); }
      // Thought traffic is ephemeral per-run (dispatches + tool calls
      // from the active dispatch) — reset whenever the user switches
      // project so stale @dispatch lines from a previous team don't
      // bleed into the new project's pane.
      setAgentThoughts(new Map());
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
    // Per-agent model picks reference agent NAMES from the previous
    // team — those names may not exist in the new team. Drop them.
    setPerAgentModel(new Map());
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

  // Persist the Super User chat transcript when it changes. 200 ms
  // debounce — short enough that closing the app right after a reply
  // still saves the turn, long enough that we don't write SQLite on
  // every token during a stream. Was 800 ms; user lost a conversation
  // by closing within the debounce window.
  useEffect(() => {
    if (!selectedProject) return;
    const next = JSON.stringify(supChat);
    if (next === (selectedProject.chat_json || "[]")) return;
    const id = window.setTimeout(async () => {
      try {
        await invoke("update_project", {
          input: { id: selectedProject.id, chat_json: next },
        });
        await reloadProjects();
      } catch (e) {
        console.error("persist chat_json failed", e);
      }
    }, 200);
    return () => window.clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supChat, selectedProject?.id]);

  // Persist per-agent transcripts (agentLogs Map → JSON object). Same
  // 800 ms debounce — and only when the snapshot actually differs from
  // what's already on disk.
  useEffect(() => {
    if (!selectedProject) return;
    const obj: Record<string, GoalMsg[]> = {};
    for (const [k, v] of agentLogs) obj[k] = v;
    const next = JSON.stringify(obj);
    if (next === (selectedProject.agent_logs_json || "{}")) return;
    const id = window.setTimeout(async () => {
      try {
        await invoke("update_project", {
          input: { id: selectedProject.id, agent_logs_json: next },
        });
        await reloadProjects();
      } catch (e) {
        console.error("persist agent_logs_json failed", e);
      }
    }, 800);
    return () => window.clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentLogs, selectedProject?.id]);

  // Persist the team default model id when the user picks one on the
  // TeamInfoCard. Same debounced shape as location/trust_writes.
  useEffect(() => {
    if (!selectedProject) return;
    if (teamModelOverride === null) return;
    if (teamModelOverride === selectedProject.team_default_model_id) return;
    const id = window.setTimeout(async () => {
      try {
        await invoke("update_project", {
          input: { id: selectedProject.id, team_default_model_id: teamModelOverride },
        });
        await reloadProjects();
      } catch (e) {
        console.error("persist team_default_model_id failed", e);
      }
    }, 400);
    return () => window.clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamModelOverride, selectedProject?.id]);

  // Effective edges: edited copy if present, otherwise the template's.
  const currentEdges: Edge[] = editedEdges ?? (activeTeam?.edges ?? []);

  // Selected agent (for the overlay info card). Resolved against the
  // active team so a stale selection from a previous team doesn't
  // surface a phantom card.
  const selectedAgentSpec: AgentSpec | null = useMemo(() => {
    if (!selectedNode || !activeTeam) return null;
    return activeTeam.agents.find(a => a.name === selectedNode) ?? null;
  }, [selectedNode, activeTeam]);

  // The activeTeam passed to canvases should reflect edge edits so the
  // diagram view's overlay arrows + the graph view's lines stay in sync.
  // Also augment with the synthetic Critic (peer of orchestrator) so
  // every canvas / graph / card list sees it as a first-class node
  // without having to know about Director Mode plumbing.
  const renderTeam: Team | null = useMemo(() => {
    if (!activeTeam) return null;
    return withSyntheticCritic({ ...activeTeam, edges: currentEdges });
  }, [activeTeam, currentEdges]);

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
      next.set(agent, [...cur, { ...msg, seq: msg.seq ?? nextSeq() }]);
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
  // Append a thought entry — same shape as agentLogs but renders in
  // the Thought tab of the OrchestratorPane. Today's populator is the
  // orchestrator's dispatch directives; tool-call / extended-thinking
  // channels can slot in later without changing the consumer.
  const appendThought = (agent: string, msg: GoalMsg) => {
    setAgentThoughts(prev => {
      const next = new Map(prev);
      const cur = next.get(agent) ?? [];
      next.set(agent, [...cur, { ...msg, seq: msg.seq ?? nextSeq() }]);
      return next;
    });
  };

  // Streaming thought / tool-call append. Looks for the latest entry
  // tagged with the same channelKey and appends the delta into it; if
  // none exists yet (first chunk), creates a new entry with the
  // role-derived kind. Lets the Anthropic thinking + tool_use streams
  // and OpenAI tool_calls land as growing blocks instead of one log
  // line per delta.
  const streamThought = (agent: string, channel: string, role: string, delta: string) => {
    // Tool-use AND tool-result entries both belong to the Tools tab —
    // the result is the response to the call, conceptually part of the
    // same "command" stream. The 🛠 / ↩ prefixes are how the streamers
    // signal which is which without us threading kind through.
    const kind: "thinking" | "tool" =
      (role.startsWith("🛠") || role.startsWith("↩")) ? "tool" : "thinking";
    const color = kind === "tool" ? "#7ff0c5" : "#dcb0ff";
    setAgentThoughts(prev => {
      const next = new Map(prev);
      const cur = next.get(agent) ?? [];
      // Find an existing open entry with the same channel key and grow
      // it in place. Without this every SSE chunk would spawn a new
      // entry and the panel would flood with single-token rows.
      const lastIdx = (() => {
        for (let i = cur.length - 1; i >= 0; i--) {
          if (cur[i].channelKey === channel) return i;
        }
        return -1;
      })();
      if (lastIdx >= 0) {
        const updated = [...cur];
        const prevMsg = updated[lastIdx];
        updated[lastIdx] = { ...prevMsg, text: prevMsg.text + delta };
        next.set(agent, updated);
      } else {
        next.set(agent, [...cur, { role, color, text: delta, kind, channelKey: channel, seq: nextSeq() }]);
      }
      return next;
    });
  };

  // SuperUserCard Send — drops a one-off message into the Super User
  // log buffer. The dispatch loop above handles the orchestrator-led
  // flow; this lets the user sneak in a side note without re-running.
  const onSupSend = async (text: string) => {
    // Capture prior history BEFORE the new user message lands in
    // supChat so the model gets continuity (otherwise the assistant
    // forgets every restart, which is what users keep hitting).
    const priorHistory = chatToHistory(supChat);

    const userMsg: GoalMsg = { role: "you", color: "#9ad9ff", text };
    setSupChat(prev => [...prev, userMsg]);
    appendLog("you", userMsg);

    // Resolve which model this send will hit, BEFORE checking the
    // local server. A team configured to use Claude or GPT doesn't
    // need llama-server running at all.
    const supModelId = effectiveTeamModel.trim() || (serverState.model_id ?? "local");
    const supProvider = providerFor(supModelId);

    // Echo the user message into the orchestrator's buffer too so the
    // right-pane Reply tab reads as a conversation thread, not just
    // the assistant side.
    {
      const orchSpec = activeTeam ? findOrchestratorSpec(activeTeam) : null;
      if (orchSpec) appendLog(orchSpec.name, userMsg);
    }

    if (supProvider === "local" && (!serverState.running || !serverState.port)) {
      const errMsg: GoalMsg = { role: "system", color: "#ff8c8c", text: "No model server is running — start one on the Server tab to dispatch this." };
      setSupChat(prev => [...prev, errMsg]);
      appendLog("system", errMsg);
      return;
    }

    // Resolve the orchestrator's actual agent-name (varies per team)
    // so the OrchestratorPane / canvas pulse key off the same string
    // we route the message through.
    const orchSpec = activeTeam ? findOrchestratorSpec(activeTeam) : null;
    const orchKey = orchSpec?.name ?? "orchestrator";

    const replyMsg: GoalMsg = { role: orchKey, color: "#ffd97a", text: "" };
    setSupChat(prev => [...prev, replyMsg]);
    appendLog(orchKey, replyMsg);
    // Active state — drives the per-node pulse in the canvas.
    addActive(orchKey);
    // Track the streamed reply so we can forward it to Telegram once
    // the stream completes (desktop → phone mirror, opposite direction
    // of the Telegram → desktop mirror the bridge already does).
    let streamedReply = "";
    try {
      const sys = activeTeam
        ? `You are the orchestrator of '${activeTeam.display}'. Answer the user concisely.`
        : "You are the team's orchestrator.";
      await streamChatCompletion(
        serverState.port ?? 0,
        supModelId,
        supProvider,
        sys,
        text,
        0.5,
        new AbortController().signal,
        (delta) => {
          streamedReply += delta;
          setSupChat(curr => {
            const out = curr.slice();
            const last = out[out.length - 1];
            if (last) out[out.length - 1] = { ...last, text: last.text + delta };
            return out;
          });
          streamLog(orchKey, delta);
        },
        // Pin the Claude CLI subscription path (and any future tool-
        // capable backend) to the user's project location instead of
        // letting it inherit the desktop install dir.
        (locationOverride || selectedProject?.location || "").trim(),
        priorHistory,
        autoApprove,
        // Surface thinking + tool-call deltas to the right-pane Thought
        // tab so the user can see the orchestrator reasoning + the
        // commands it asks tools to run (Anthropic API thinking blocks
        // & tool_use, OpenAI tool_calls, local <think> tags).
        (channel, role, delta) => streamThought(orchKey, channel, role, delta),
        undefined,
        undefined,
        // SuperUser orchestrator chat uses the same persistent session
        // as the team-Run orchestrator — they're the same logical agent.
        getClaudeSession(selectedProjectId, orchKey),
      );
    } catch (e: any) {
      const errMsg: GoalMsg = { role: "system", color: "#ff8c8c", text: String(e?.message ?? e) };
      setSupChat(prev => [...prev, errMsg]);
      appendLog("system", errMsg);
    } finally {
      removeActive(orchKey);
    }
    // Dispatch a chat-appended event with source=desktop so the
    // top-level TelegramBridgeRunner can forward the assistant reply
    // back to the user's phone. The bridge's listener filters on
    // source=desktop; AgentsPage's own listener skips it to avoid
    // double-merging into supChat.
    if (streamedReply.trim()) {
      try {
        window.dispatchEvent(new CustomEvent("owllm:chat:appended", {
          detail: {
            projectId: selectedProjectId,
            messages: [userMsg, { role: orchKey, color: "#ffd97a", text: streamedReply }],
            source: "desktop",
          },
        }));
      } catch { /* event dispatch failed — desktop UI already shows it, only phone misses */ }
    }
  };

  const trustWrites = trustWritesOverride ?? (selectedProject?.trust_writes ?? false);

  // Effective team default: pending override > saved on project >
  // empty string (which means "use the server model fallback").
  const effectiveTeamModel =
    teamModelOverride ?? selectedProject?.team_default_model_id ?? "";

  // Resolve the model id we should send for a given agent. Priority:
  //   per-agent override > team default > server's running model > "local"
  // Empty-string overrides fall through to the next layer. The string
  // we return is the `model` field in /v1/chat/completions; llama-server
  // ignores it today but the multi-server path will use it to route.
  const modelFor = (agentName: string): string => {
    const per = perAgentModel.get(agentName);
    if (per && per.trim()) return per;
    if (effectiveTeamModel.trim()) return effectiveTeamModel;
    return serverState.model_id ?? "local";
  };
  const onPickAgentModel = (agentName: string, modelId: string) => {
    setPerAgentModel(prev => {
      const next = new Map(prev);
      if (modelId.trim() === "") next.delete(agentName);
      else next.set(agentName, modelId);
      return next;
    });
  };
  // Lazy server-start state. The local llama-server is no longer
  // pre-launched when the user opens this page or picks a model —
  // dispatchGoal() starts it on the first message instead, so
  // browsing the Agents tab doesn't spin up a 7B model the user may
  // not actually use.
  const [serverAutoStarting, setServerAutoStarting] = useState<string | null>(null);

  // Start the llama-server for `wanted` and poll server_status until
  // it's actually running on that model, or until `timeoutMs` elapses.
  // Returns true when ready, false on timeout. Used by dispatchGoal
  // so the first user message waits for the server before fanning
  // out to specialists.
  async function ensureLocalServer(wanted: string, timeoutMs = 90_000): Promise<boolean> {
    if (serverState.running && serverState.model_id === wanted) return true;
    setServerAutoStarting(wanted);
    try {
      if (serverState.running) await invoke("server_stop").catch(() => {});
      await invoke("server_start", { modelId: wanted });
    } catch (e) {
      console.warn("[agents] lazy server start failed:", e);
      setServerAutoStarting(null);
      return false;
    }
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const s = await invoke<ServerStatus>("server_status");
        setServerState(s);
        if (s.running && s.model_id === wanted && s.port) {
          setServerAutoStarting(null);
          return true;
        }
      } catch {
        // ignore, retry
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    setServerAutoStarting(null);
    return false;
  }

  const onPickTeamModel = (modelId: string) => {
    setTeamModelOverride(modelId);
    // Picking a team-wide model implies "every agent uses this one" —
    // wipe per-agent overrides so the UI behaviour matches the intent.
    setPerAgentModel(new Map());
  };

  // Look up the provider for a resolved model id. The ModelPicker
  // encodes routing as prefixes:
  //   "sub/claude-..."  → anthropic, subscription only
  //   "api/claude-..."  → anthropic, API only
  //   "sub/gpt-..."     → openai, subscription only
  //   "api/gpt-..."     → openai, API only
  //   "auto/<flavour>"  → auto routing (resolved at dispatch time)
  //   else              → local (or fall back when unrecognized)
  const providerFor = (modelId: string): string => {
    if (!modelId) return "local";
    if (modelId.startsWith("auto/")) return "auto";
    const bareId = stripModelPrefix(modelId);
    if (modelId.startsWith("sub/") || modelId.startsWith("api/")) {
      // Pure cloud entries — decide between anthropic / openai / moonshot by id.
      if (bareId.startsWith("claude-")) return "anthropic";
      if (bareId.startsWith("gpt-") || bareId === "o3") return "openai";
      if (bareId.startsWith("kimi-") || bareId.startsWith("moonshot-")) return "moonshot";
    }
    const m = models.find(x => x.model_id === bareId);
    return m?.provider || "local";
  };
  // Encoded id → bare model id (strips sub/, api/, auto/ prefixes).
  function stripModelPrefix(id: string): string {
    for (const p of ["sub/", "api/", "auto/"]) {
      if (id.startsWith(p)) return id.slice(p.length);
    }
    return id;
  }

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
    // Require the local server only when the orchestrator (or any
    // dispatched specialist) actually resolves to a local model. Cloud-
    // only teams should run without one.
    const orchModelId = activeTeam ? modelFor(findOrchestratorSpec(activeTeam)!.name) : "";
    // "tuned" models live in LLM/fine_tuned/ and are served by the
    // same llama-server, so they need the local server up too.
    const isLocallyServed = (p: string) => p === "local" || p === "tuned";
    const needsLocal = isLocallyServed(providerFor(orchModelId))
      || (activeTeam?.agents ?? []).some(a => isLocallyServed(providerFor(modelFor(a.name))));
    if (needsLocal) {
      // Decide which model the local server should be running. The
      // orchestrator's model wins; if it's not local we look for any
      // locally-served agent in the team. A blank model means "we
      // can't infer which weights to load" — that's user error.
      const localCandidates: string[] = [];
      if (isLocallyServed(providerFor(orchModelId))) localCandidates.push(orchModelId);
      for (const a of activeTeam?.agents ?? []) {
        const id = modelFor(a.name);
        if (id && isLocallyServed(providerFor(id))) localCandidates.push(id);
      }
      const wantedLocal = localCandidates[0]?.trim();
      if (!wantedLocal) {
        setRunError("This team uses local model(s) but no model is picked. Choose one in the picker.");
        return;
      }
      if (!serverState.running || !serverState.port || serverState.model_id !== wantedLocal) {
        setPhase("planning");
        setRunError(`Starting local server (${wantedLocal})…`);
        const ok = await ensureLocalServer(wantedLocal);
        if (!ok) {
          setRunError(`Local server failed to start for "${wantedLocal}" within 90s — try the Server tab manually.`);
          return;
        }
        setRunError(null);
      }
    }
    if (!activeTeam || activeTeam.agents.length === 0) {
      setRunError("No team is loaded. Pick a team via 'Team…' or select a project with a roster.");
      return;
    }

    // Wipe the per-run log buffers but keep the SuperUserCard chat
    // (which represents the user-facing thread of the conversation).
    setAgentLogs(new Map());
    setAgentThoughts(new Map());
    setRunError(null);
    setBusy(true);
    setPhase("planning");
    // Snapshot + clear the chip strip now. The orchestrator owns these
    // bytes for the rest of the run; the UI strip should feel "spent".
    const runAttachments = attachments;
    if (attachments.length > 0) setAttachments([]);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const orch = findOrchestratorSpec(activeTeam)!;
    // Cloud calls don't need a port; only the local fallback does.
    const port = serverState.port ?? 0;

    // Anchor the goal in the user log AND the orchestrator's log so
    // the Reply tab reads as a conversation thread when the user
    // focuses on the orchestrator.
    const goalMsg: GoalMsg = { role: "you", color: "#9ad9ff", text };
    appendLog("you", goalMsg);
    appendLog(orch.name, goalMsg);

    // Each role yaml ships a default_temperature; honour it instead of
    // a hardcoded 0.4/0.5 split. Orchestrator base = 0.3, specialists
    // vary (coder=0.2, critic=0.2, researcher=0.3, …).
    const tempFor = (spec: AgentSpec, fallback: number) =>
      roleByName.get(spec.base)?.defaultTemperature ?? fallback;

    // Project location feeds the Claude CLI's --cwd so the bot runs
    // against the directory the user picked in the LocationRow, not
    // the desktop app's install dir. Empty / unset → CLI inherits cwd.
    const projectCwd = (locationOverride || selectedProject?.location || "").trim();

    try {
      // ----- Phase 1: orchestrator plan + dispatches -----
      addActive(orch.name);
      const orchPrompt = buildOrchestratorPrompt(activeTeam, roleByName, orch, directives, directorMode);
      appendLog(orch.name, { role: orch.name, color: "#ffd97a", text: "" });
      const orchModel = modelFor(orch.name);
      let orchReply: string;
      try {
        orchReply = await streamChatCompletion(
          port, orchModel, providerFor(orchModel),
          orchPrompt, text, tempFor(orch, 0.4), ctrl.signal,
          (delta) => streamLog(orch.name, delta),
          projectCwd,
          undefined, undefined,
          (channel, role, delta) => streamThought(orch.name, channel, role, delta),
          undefined,
          // User-attached images/audio ride with the orchestrator only.
          // Specialists receive the orchestrator's reply (text), so they
          // don't need the raw bytes.
          runAttachments.length > 0 ? runAttachments : undefined,
          // Persistent CLI session for the orchestrator across dispatches.
          getClaudeSession(selectedProjectId, orch.name),
        );
      } finally {
        removeActive(orch.name);
      }

      // Director-mode interception: if the orchestrator asked the user
      // a question ([NEED_USER_INPUT] marker), route it to the Critic
      // (voice-of-user), fold the answer back into context, and re-run
      // the orchestrator. Only one hop per dispatch to avoid loops.
      if (directorMode) {
        const { question, cleaned } = extractUserInputRequest(orchReply);
        if (question) {
          appendThought(orch.name, {
            role: "dispatch", color: "#ff9ad9",
            text: `❓ → critic: ${question}`,
          });
          const CRITIC_NAME = CRITIC_AGENT_NAME;
          addActive(CRITIC_NAME);
          appendLog(CRITIC_NAME, { role: CRITIC_NAME, color: "#ff9ad9", text: "" });
          let criticReply = "";
          try {
            const criticSys = buildCriticPrompt(activeTeam, directives);
            criticReply = await streamChatCompletion(
              port, orchModel, providerFor(orchModel),
              criticSys, question, 0.3, ctrl.signal,
              (delta) => { criticReply += delta; streamLog(CRITIC_NAME, delta); },
              projectCwd,
              undefined, undefined,
              () => {},
            );
            criticReply = (criticReply || "(no answer)").trim();
          } catch (e: any) {
            criticReply = `(critic error: ${String(e?.message ?? e)} — proceeding with best guess)`;
            appendLog(CRITIC_NAME, { role: "system", color: "#ff8c8c", text: criticReply });
          } finally {
            removeActive(CRITIC_NAME);
          }
          // Replan with the resolved decision in context. The cleaned
          // first reply + critic answer get pushed into the user-input
          // explicitly so the orchestrator sees a coherent thread.
          addActive(orch.name);
          appendLog(orch.name, { role: orch.name, color: "#ffd97a", text: "" });
          try {
            orchReply = await streamChatCompletion(
              port, orchModel, providerFor(orchModel),
              orchPrompt,
              `${text}\n\n(the critic just answered "${criticReply}" to your "${question}" — incorporate this and dispatch now)`,
              tempFor(orch, 0.4), ctrl.signal,
              (delta) => streamLog(orch.name, delta),
              projectCwd,
              undefined, undefined,
              (channel, role, delta) => streamThought(orch.name, channel, role, delta),
              undefined,
              undefined,
              getClaudeSession(selectedProjectId, orch.name),
            );
          } finally {
            removeActive(orch.name);
          }
          // Silence unused-warning for cleaned in non-debug builds —
          // we intentionally don't surface it (the cleaned plan is
          // already in the orchestrator's log via streamLog deltas).
          void cleaned;
        }
      }

      // Mirror to the SuperUserCard so the user-facing thread shows
      // the orchestrator's plan + (later) the integrated answer.
      setSupChat(prev => [
        ...prev,
        { role: "you", color: "#9ad9ff", text },
      ]);

      // ----- Phase 2: parse + dispatch -----
      const dispatches = parseDispatches(orchReply, activeTeam, orch.name);

      // Drop the parsed directives into the orchestrator's THOUGHT
      // log — that's the routing decision, not part of the user-
      // facing reply. The Reply tab kept clean; Thought tab shows
      // the plan.
      for (const d of dispatches) {
        appendThought(orch.name, {
          role: "dispatch",
          color: "#a578ff",
          text: `📤 @${d.agentName}: ${d.instruction}`,
        });
      }

      // Surface a "📤 N dispatches parsed" header so the user sees
      // the routing decision at a glance — distinguishes "orchestrator
      // dispatched 3 specialists" from "orchestrator answered alone".
      appendThought(orch.name, {
        role: "dispatch", color: "#a578ff",
        text: `📊 ${dispatches.length} dispatch${dispatches.length === 1 ? "" : "es"} parsed → ${dispatches.map(d => "@" + d.agentName).join(", ") || "none"}`,
      });

      // If the orchestrator didn't dispatch anything, its first reply
      // IS the final answer. This is usually the WRONG outcome (Claude
      // answered solo instead of routing to specialists) so make it
      // loudly visible everywhere — Thought tab, system log AND user
      // chat — instead of silently treating it as "done".
      if (dispatches.length === 0) {
        const clean = stripDispatchDirectives(orchReply).trim();
        const noteText = "🚫 0 dispatches parsed — orchestrator answered solo. Specialists DID NOT run. If you expected the team to fan out, the orchestrator's reply is missing `@<agent>: instruction` lines (check the Reply tab). Try rephrasing with an explicit goal that requires file edits / shell / external systems.";
        appendThought(orch.name, { role: "system", color: "#ff8c8c", text: noteText });
        appendLog("system", { role: "system", color: "#ff8c8c", text: noteText });
        setSupChat(prev => [
          ...prev,
          { role: "system", color: "#ff8c8c", text: "⚠ Specialists did not run — orchestrator answered solo. See system log." },
          { role: "orchestrator", color: "#ffd97a", text: clean || orchReply },
        ]);
        setPhase("done");
        return;
      }

      // Short, sortable run id used by fleet.rs to bucket per-agent
      // worktrees under <fleet_root>/<repo>/<run_id>/<agent>. Visible
      // in the system thought entries so the user can correlate
      // worktrees on disk back to a specific dispatch.
      const runId = Date.now().toString(36).slice(-6);

      // ----- Phase 2a: pre-create one git worktree per specialist -----
      // Serial loop on purpose — concurrent `git worktree add` from the
      // same source repo can race on `.git/worktrees/` index. After
      // this loop every dispatch.agent has either: a per-agent worktree
      // path to use as cwd (isolated), or null (fall back to projectCwd
      // — happens when projectCwd isn't a git repo at all, e.g.
      // research-only teams against a plain folder).
      setPhase("dispatching");
      if (ctrl.signal.aborted) throw new DOMException("aborted", "AbortError");
      type WorktreeBinding = { path: string; branch: string; baseSha: string };
      const worktreeBySpec = new Map<string, WorktreeBinding | null>();
      // Surface a "🗂 isolated" or "🗂 shared" line in the orchestrator's
      // Thought tab per dispatch so the user can see what happened.
      for (const d of dispatches) {
        const spec = activeTeam.agents.find(a => a.name === d.agentName);
        if (!spec) continue;
        let res: FleetCreateResult;
        try {
          res = await invoke<FleetCreateResult>("fleet_worktree_create", {
            projectCwd, agentName: spec.name, runId,
          });
        } catch (e: any) {
          res = { status: "error", message: String(e?.message ?? e) };
        }
        if (res.status === "ready") {
          worktreeBySpec.set(spec.name, { path: res.path, branch: res.branch, baseSha: res.baseSha });
          appendThought(orch.name, {
            role: "fleet", color: "#7ff0c5",
            text: `🗂 ${spec.name} → ${res.branch}\n   ${res.path}`,
          });
        } else if (res.status === "notAGitRepo") {
          worktreeBySpec.set(spec.name, null);
          appendThought(orch.name, {
            role: "fleet", color: "#8a92a3",
            text: `🗂 ${spec.name}: project is not a git repo — running shared in ${projectCwd || "(no cwd)"}`,
          });
        } else if (res.status === "dirtyWorkingTree") {
          // Abort the whole run with a clear, fixable error rather than
          // silently giving the agent a stale base. The user can commit
          // / stash and re-run.
          throw new Error(
            `Project has uncommitted changes — commit or stash before running a multi-agent dispatch so each agent works from a clean base.\n\n${res.details}`
          );
        } else {
          worktreeBySpec.set(spec.name, null);
          appendThought(orch.name, {
            role: "fleet", color: "#ff8c8c",
            text: `🗂 ${spec.name}: worktree creation failed — ${res.message}. Falling back to shared cwd.`,
          });
        }
      }

      // ----- Phase 2b: parallel specialist dispatch -----
      // Each task runs the CLI in its own worktree path (or the shared
      // projectCwd if none was created), then finalizes (commits) any
      // edits the agent made before resolving.
      type SpecOutcome = {
        name: string;
        spec: AgentSpec;
        text: string;
        ok: boolean;
        worktree: WorktreeBinding | null;
        finalize: FleetFinalizeResult | null;
      };
      const settled = await Promise.allSettled<SpecOutcome | null>(dispatches.map(async (d) => {
        const spec = activeTeam.agents.find(a => a.name === d.agentName);
        if (!spec) return null;
        addActive(spec.name);
        const specPrompt = buildSpecialistPrompt(activeTeam, spec, roleByName, directives);
        appendThought(spec.name, { role: "dispatch", color: "#a578ff", text: `📩 ${d.instruction}` });
        appendLog(spec.name, { role: spec.name, color: colorForAgent(spec), text: "" });
        const specModel = modelFor(spec.name);
        const wt = worktreeBySpec.get(spec.name) ?? null;
        const specCwd = wt ? wt.path : projectCwd;
        // Per-role tool allowlist from the loaded role yaml.
        const allowed = roleByName.get(spec.base)?.toolAllowlist;
        let ok = false;
        let specText = "";
        try {
          specText = (await streamChatCompletion(
            port, specModel, providerFor(specModel),
            specPrompt, d.instruction, tempFor(spec, 0.5), ctrl.signal,
            (delta) => streamLog(spec.name, delta),
            specCwd,
            undefined, undefined,
            (channel, role, delta) => streamThought(spec.name, channel, role, delta),
            allowed,
            undefined,
            getClaudeSession(selectedProjectId, spec.name),
          )).trim();
          ok = true;
        } catch (e: any) {
          const errMsg = `(error: ${String(e?.message ?? e)})`;
          streamLog(spec.name, "\n\n" + errMsg);
          specText = errMsg;
        }
        // Finalize: commit anything the agent wrote in its worktree.
        // Skip when there's no worktree (non-git project — shared cwd
        // path, no isolation, no commit boundary either).
        let finalize: FleetFinalizeResult | null = null;
        if (wt) {
          try {
            finalize = await invoke<FleetFinalizeResult>("fleet_worktree_finalize", {
              worktreePath: wt.path, agentName: spec.name, summary: d.instruction,
            });
            if (finalize.status === "committed") {
              appendThought(spec.name, {
                role: "fleet", color: "#7ff0c5",
                text: `📦 committed ${finalize.commitSha.slice(0,7)} · ${finalize.filesChanged} file${finalize.filesChanged === 1 ? "" : "s"}\n${finalize.files.slice(0, 12).join("\n")}`,
              });
            } else if (finalize.status === "noChanges") {
              appendThought(spec.name, { role: "fleet", color: "#8a92a3", text: "📦 no changes to commit" });
            } else {
              appendThought(spec.name, { role: "fleet", color: "#ff8c8c", text: `📦 finalize failed: ${finalize.message}` });
            }
          } catch (e: any) {
            finalize = { status: "error", message: String(e?.message ?? e) };
            appendThought(spec.name, { role: "fleet", color: "#ff8c8c", text: `📦 finalize errored: ${String(e?.message ?? e)}` });
          }
        }
        removeActive(spec.name);
        return { name: spec.name, spec, text: specText, ok, worktree: wt, finalize };
      }));
      const outcomes: SpecOutcome[] = [];
      for (const r of settled) {
        if (r.status === "fulfilled" && r.value) outcomes.push(r.value);
      }
      const specialistReplies = outcomes.map(o => ({ name: o.name, text: o.text }));

      if (specialistReplies.length === 0) {
        // Cleanup any worktrees we did create even though no spec ran.
        for (const wt of worktreeBySpec.values()) {
          if (!wt) continue;
          try { await invoke("fleet_worktree_remove", { args: { projectCwd, worktreePath: wt.path, branch: wt.branch, keep: false } }); } catch { /* best-effort */ }
        }
        setPhase("done");
        return;
      }

      // ----- Phase 3: orchestrator integration (text only, unchanged) -----
      setPhase("integrating");
      addActive(orch.name);
      const integrationInput = [
        `The user's original goal:\n${text}`,
        "",
        "Your specialists' replies:",
        ...specialistReplies.map(r => `\n— ${displayLabel(r.name)} —\n${r.text}`),
        "",
        "Now write the FINAL answer for the user. Be concise, structured, and quote the relevant specialist when useful. Do not dispatch again.",
      ].join("\n");
      appendLog(orch.name, { role: orch.name, color: "#ffd97a", text: "" });
      const finalModel = modelFor(orch.name);
      let finalReply: string;
      try {
        finalReply = await streamChatCompletion(
          port, finalModel, providerFor(finalModel),
          buildOrchestratorPrompt(activeTeam, roleByName, orch, directives, directorMode), integrationInput,
          tempFor(orch, 0.4), ctrl.signal,
          (delta) => streamLog(orch.name, delta),
          projectCwd,
          undefined, undefined,
          (channel, role, delta) => streamThought(orch.name, channel, role, delta),
          undefined,
          undefined,
          getClaudeSession(selectedProjectId, orch.name),
        );
      } finally {
        removeActive(orch.name);
      }
      setSupChat(prev => [...prev, { role: "orchestrator", color: "#ffd97a", text: finalReply.trim() }]);

      // ----- Phase 4: serial squash-merge each committed branch back -----
      // Conflicts here are real (two agents touched the same file) —
      // we abort that branch's merge, KEEP its worktree on disk, and
      // surface the conflict path so the user can resolve manually.
      const codeFilesChanged = new Set<string>();
      const keepOnDisk = new Set<string>();
      for (const o of outcomes) {
        if (!o.worktree || !o.finalize || o.finalize.status !== "committed") continue;
        let merge: FleetMergeResult;
        try {
          merge = await invoke<FleetMergeResult>("fleet_worktree_merge", {
            projectCwd, agentName: o.name, branch: o.worktree.branch,
          });
        } catch (e: any) {
          merge = { status: "error", message: String(e?.message ?? e) };
        }
        if (merge.status === "merged") {
          appendThought(orch.name, {
            role: "fleet", color: "#7ff0c5",
            text: `🔀 merged ${o.name} → ${merge.commitSha.slice(0,7)} · ${merge.filesChanged} file${merge.filesChanged === 1 ? "" : "s"}`,
          });
          for (const f of o.finalize.files) {
            // files entries are "STATUS\tpath" — take the path part.
            const tab = f.indexOf("\t");
            const p = tab >= 0 ? f.slice(tab + 1).trim() : f.trim();
            if (isCodeFile(p)) codeFilesChanged.add(p);
          }
        } else if (merge.status === "conflict") {
          keepOnDisk.add(o.name);
          appendThought(orch.name, {
            role: "fleet", color: "#ffb86c",
            text: `⚠ conflict merging ${o.name} (branch ${o.worktree.branch} kept on disk for resolution):\n${merge.files.join("\n")}`,
          });
        } else if (merge.status === "noChanges") {
          appendThought(orch.name, { role: "fleet", color: "#8a92a3", text: `🔀 ${o.name}: nothing to merge` });
        } else {
          keepOnDisk.add(o.name);
          appendThought(orch.name, { role: "fleet", color: "#ff8c8c", text: `⚠ merge ${o.name} failed: ${merge.message}` });
        }
      }

      // ----- Phase 5: auto-doc — if code changed AND team has docs -----
      const docSpec = activeTeam.agents.find(
        a => a.base === "documentation" || a.name === "documentation" || a.base === "docs" || a.name === "docs"
      );
      if (docSpec && codeFilesChanged.size > 0 && !ctrl.signal.aborted) {
        appendThought(docSpec.name, {
          role: "fleet", color: "#7ff0c5",
          text: `📚 auto-dispatch: ${codeFilesChanged.size} code file${codeFilesChanged.size === 1 ? "" : "s"} changed — updating docs`,
        });
        addActive(docSpec.name);
        appendLog(docSpec.name, { role: docSpec.name, color: colorForAgent(docSpec), text: "" });
        const docInstruction = [
          "The team just landed these code changes. Read each file, decide what user-facing documentation needs to be added or updated (README sections, changelog, docstrings), and make the edits.",
          "",
          "Files changed in this dispatch:",
          ...Array.from(codeFilesChanged).map(f => `  - ${f}`),
        ].join("\n");
        // Doc agent runs in its OWN worktree so its edits get the same
        // commit-and-merge attribution as the code specialists.
        let docWt: WorktreeBinding | null = null;
        try {
          const wtRes = await invoke<FleetCreateResult>("fleet_worktree_create", {
            projectCwd, agentName: docSpec.name, runId: `${runId}-docs`,
          });
          if (wtRes.status === "ready") {
            docWt = { path: wtRes.path, branch: wtRes.branch, baseSha: wtRes.baseSha };
            appendThought(docSpec.name, { role: "fleet", color: "#7ff0c5", text: `🗂 ${docSpec.name} → ${wtRes.branch}` });
          }
        } catch { /* fall back to shared cwd */ }
        const docCwd = docWt ? docWt.path : projectCwd;
        const docAllowed = roleByName.get(docSpec.base)?.toolAllowlist;
        try {
          await streamChatCompletion(
            port, modelFor(docSpec.name), providerFor(modelFor(docSpec.name)),
            buildSpecialistPrompt(activeTeam, docSpec, roleByName, directives),
            docInstruction, tempFor(docSpec, 0.3), ctrl.signal,
            (delta) => streamLog(docSpec.name, delta),
            docCwd,
            undefined, undefined,
            (channel, role, delta) => streamThought(docSpec.name, channel, role, delta),
            docAllowed,
            undefined,
            getClaudeSession(selectedProjectId, docSpec.name),
          );
          if (docWt) {
            const docFinalize = await invoke<FleetFinalizeResult>("fleet_worktree_finalize", {
              worktreePath: docWt.path, agentName: docSpec.name, summary: "auto-doc after merge",
            });
            if (docFinalize.status === "committed") {
              appendThought(docSpec.name, {
                role: "fleet", color: "#7ff0c5",
                text: `📦 committed ${docFinalize.commitSha.slice(0,7)} · ${docFinalize.filesChanged} file${docFinalize.filesChanged === 1 ? "" : "s"}`,
              });
              const docMerge = await invoke<FleetMergeResult>("fleet_worktree_merge", {
                projectCwd, agentName: docSpec.name, branch: docWt.branch,
              });
              if (docMerge.status === "merged") {
                appendThought(orch.name, {
                  role: "fleet", color: "#7ff0c5",
                  text: `🔀 merged ${docSpec.name} → ${docMerge.commitSha.slice(0,7)} · ${docMerge.filesChanged} file${docMerge.filesChanged === 1 ? "" : "s"}`,
                });
              } else if (docMerge.status === "conflict") {
                keepOnDisk.add(docSpec.name);
                appendThought(orch.name, { role: "fleet", color: "#ffb86c", text: `⚠ docs merge conflict — branch ${docWt.branch} kept` });
              }
            }
          }
        } catch (e: any) {
          appendThought(docSpec.name, { role: "fleet", color: "#ff8c8c", text: `📚 auto-doc errored: ${String(e?.message ?? e)}` });
        } finally {
          removeActive(docSpec.name);
          if (docWt) {
            try { await invoke("fleet_worktree_remove", { args: { projectCwd, worktreePath: docWt.path, branch: docWt.branch, keep: keepOnDisk.has(docSpec.name) } }); } catch { /* best-effort */ }
          }
        }
      }

      // ----- Cleanup: drop the per-spec worktrees (keep conflicted ones) -----
      for (const o of outcomes) {
        if (!o.worktree) continue;
        const keep = keepOnDisk.has(o.name);
        try {
          await invoke("fleet_worktree_remove", {
            args: { projectCwd, worktreePath: o.worktree.path, branch: o.worktree.branch, keep },
          });
        } catch { /* best-effort — worktree is recoverable on disk */ }
      }

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
      clearActive();
      abortRef.current = null;
    }
  }

  const onRun = dispatchGoal;

  function onCancel() {
    abortRef.current?.abort();
  }

  // ===== Telegram bridge — long-poll =====
  // The actual long-poll loop runs at AppShell level via
  // <TelegramBridgeRunner /> so it survives navigation away from this
  // page. What stays here is the optional courtesy of echoing inbound
  // text into the SuperUser chat WHEN the user is on the agentic tab,
  // bound to the same project the bridge is configured for. The
  // runner handles the actual reply path; this just adds local UX.
  const TELEGRAM_STARTED_KEY = "owllm:telegram:started";
  const [tgStarted, setTgStarted] = useState<boolean>(() => {
    try { return localStorage.getItem(TELEGRAM_STARTED_KEY) === "1"; }
    catch { return false; }
  });
  useEffect(() => {
    const onStatus = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const running = detail === "running";
      setTgStarted(running);
      // Re-fetch bridge config from disk so the local echo gate picks
      // up the new project_id when the user starts the bridge while
      // the agentic tab is mounted.
      if (running) {
        invoke<BridgeConfigs>("load_bridge_configs").then(c => setBridges(c)).catch(() => {});
      }
    };
    window.addEventListener("owllm:telegram:status", onStatus as EventListener);
    return () => window.removeEventListener("owllm:telegram:status", onStatus as EventListener);
  }, []);

  // (The actual long-poll lives in <TelegramBridgeRunner /> at
  // AppShell level so it survives this page unmounting.)

  // Live mirror — when the AppShell runner dispatches a chat append
  // event for the currently-selected project, splice the new messages
  // into the SuperUser thread AND the per-agent OrchestratorPane logs
  // so the desktop UI shows both the inbound text and the bot's reply
  // without waiting for a project reload. The runner has already
  // persisted to chat_json, so the supChat persist effect's next
  // write is just an idempotent round-trip.
  //
  // Only handles source=telegram events. Desktop sends are handled
  // inline by onSupSend / dispatchGoal; dispatching an event for them
  // and letting THIS listener re-merge would duplicate every reply.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId: string; messages: GoalMsg[]; source?: string }>).detail;
      if (!detail) return;
      if (detail.source === "desktop") return;
      if (detail.projectId !== selectedProjectId) return;
      const msgs = Array.isArray(detail.messages) ? detail.messages : [];
      if (msgs.length === 0) return;
      setSupChat(prev => [...prev, ...msgs]);

      // Mirror into agentLogs so the Reply tab on the right-hand
      // OrchestratorPane shows the same content. User messages get
      // pushed to BOTH the "you" buffer AND the orchestrator's buffer
      // so the orchestrator's Reply tab reads as a conversation
      // thread (user → orchestrator → user → …), not just one side.
      const orchSpec = activeTeam ? findOrchestratorSpec(activeTeam) : null;
      const orchKey = orchSpec?.name ?? "orchestrator";
      for (const m of msgs) {
        if (m.role === "you") {
          appendLog("you", m);
          appendLog(orchKey, m);
        } else {
          appendLog(orchKey, { ...m, role: orchKey });
        }
      }
      reloadProjects();
    };
    window.addEventListener("owllm:chat:appended", handler as EventListener);
    return () => window.removeEventListener("owllm:chat:appended", handler as EventListener);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId, activeTeam?.id]);

  // Active-agent lighting — Telegram-driven dispatches fire from the
  // AppShell runner, so the local dispatchGoal / onSupSend setters
  // never run. Listen for an explicit event so the orbital pulse +
  // OrchestratorPane phase chip reflect "the bridge is thinking".
  // Bridge fires `start` events to add an agent to the active set and
  // `end` events to remove it; null agent + no action → clear all
  // (back-compat for the old event shape).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ agent: string | null; action?: "start" | "end"; projectId?: string }>).detail;
      if (!detail) return;
      if (detail.projectId && detail.projectId !== selectedProjectId) return;
      // Resolve the agent name through the local team so Telegram's
      // generic "orchestrator" label maps to whatever this team
      // actually named its orchestrator.
      let resolved = detail.agent;
      if (resolved && activeTeam) {
        const spec = activeTeam.agents.find(a => a.name === resolved || a.base === resolved);
        if (spec) resolved = spec.name;
      }
      if (!resolved) {
        clearActive();
        return;
      }
      if (detail.action === "end") {
        removeActive(resolved);
      } else {
        addActive(resolved);
      }
    };
    window.addEventListener("owllm:agent:active", handler as EventListener);
    return () => window.removeEventListener("owllm:agent:active", handler as EventListener);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId, activeTeam?.id]);

  // Thought events — the bridge runner fires one per dispatch
  // directive parsed from the orchestrator's plan, plus one per
  // specialist's incoming task. Surfaces the routing decision in the
  // Thought tab while the run is in flight.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId: string; agent: string; message: GoalMsg }>).detail;
      if (!detail || !detail.message) return;
      if (detail.projectId !== selectedProjectId) return;
      const agent = detail.agent || "orchestrator";
      appendThought(agent, detail.message);
    };
    window.addEventListener("owllm:thought:appended", handler as EventListener);
    return () => window.removeEventListener("owllm:thought:appended", handler as EventListener);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId]);

  // Streaming thought / tool-call deltas — fired by the Telegram bridge
  // dispatch loop for every Anthropic thinking / tool_use chunk and
  // every OpenAI tool_calls / reasoning chunk. Coalesce per (agent,
  // channel) into one growing entry, same as the desktop streamThought.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId: string; agent: string; channel: string; role: string; delta: string }>).detail;
      if (!detail || typeof detail.delta !== "string") return;
      if (detail.projectId !== selectedProjectId) return;
      const agent = detail.agent || "orchestrator";
      streamThought(agent, detail.channel || "thinking", detail.role || "🧠 thinking", detail.delta);
    };
    window.addEventListener("owllm:thought:delta", handler as EventListener);
    return () => window.removeEventListener("owllm:thought:delta", handler as EventListener);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId]);

  // Log events — bridge fires one per agent that gets seeded with an
  // empty reply slot (so the OrchestratorPane Reply tab can stream
  // tokens into it). Mirrors appendLog from the desktop dispatch.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId: string; agent: string; message: GoalMsg }>).detail;
      if (!detail || !detail.message) return;
      if (detail.projectId !== selectedProjectId) return;
      const agent = detail.agent || "orchestrator";
      appendLog(agent, detail.message);
    };
    window.addEventListener("owllm:log:appended", handler as EventListener);
    return () => window.removeEventListener("owllm:log:appended", handler as EventListener);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId]);

  // Log-delta events — bridge fires one per streamed token. Append
  // the delta into the last message of the agent's buffer so the
  // OrchestratorPane Reply tab streams live, not "all at once" when
  // the run finishes.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId: string; agent: string; delta: string }>).detail;
      if (!detail || typeof detail.delta !== "string") return;
      if (detail.projectId !== selectedProjectId) return;
      const agent = detail.agent || "orchestrator";
      streamLog(agent, detail.delta);
    };
    window.addEventListener("owllm:log:delta", handler as EventListener);
    return () => window.removeEventListener("owllm:log:delta", handler as EventListener);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId]);

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", minHeight:0 }}>
      {directivesPanelOpen && selectedProjectId && (
        <DirectivesPanel
          projectId={selectedProjectId}
          directives={directives}
          onChanged={reloadDirectives}
          onClose={() => setDirectivesPanelOpen(false)}
        />
      )}
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
      <GoalRow goal={goal} setGoal={setGoal} onRun={onRun} onCancel={onCancel} busy={busy} attachments={attachments} setAttachments={setAttachments} />
      <div data-ui="WorkspaceStack" style={{ flex:1, minHeight:0, margin:"0 23px", display:"flex", overflow:"hidden", background:"var(--bg-app)", padding:0 }}>
        <div data-ui="RosterLeft" style={{ flex:"2 1 0", minWidth:0, display:"flex", flexDirection:"column", background:"var(--bg-elevated)" }}>
          <FlowHeader
            viewMode={viewMode}
            onToggleView={() => setViewMode(v => v === "diagram" ? "graph" : "diagram")}
            canEdit={viewMode === "graph" && selectedEdgeIdx != null}
            onDeleteEdge={deleteSelectedEdge}
            onReverseEdge={reverseSelectedEdge}
            onResetLayout={resetGraphLayout}
          />
          <div ref={canvasSize.ref} data-ui="CanvasStack" style={{ flex:1, minHeight:0, position:"relative" }}>
            {viewMode === "diagram" ? (
              <TeamCanvas
                width={canvasSize.size.w || 800}
                height={canvasSize.size.h || 600}
                team={renderTeam}
                roleByName={roleByName}
                activeAgents={activeAgents}
                selectedNode={selectedNode}
                onSelectNode={setSelectedNode}
              />
            ) : (
              <GraphCanvas
                width={canvasSize.size.w || 800}
                height={canvasSize.size.h || 600}
                team={renderTeam}
                roleByName={roleByName}
                selectedNode={selectedNode}
                onSelectNode={setSelectedNode}
                activeAgents={activeAgents}
                edges={currentEdges}
                onEdgesChange={(es) => { setEditedEdges(es); setSelectedEdgeIdx(null); }}
                selectedEdgeIdx={selectedEdgeIdx}
                onSelectEdge={setSelectedEdgeIdx}
                positions={nodePositions}
                onPositionsChange={setNodePositions}
              />
            )}
            {/* Info-card overlay — moved from left to RIGHT side (user
                spec 2026-05-18). Rendered in BOTH views so the page
                stays consistent and selection state survives a view
                toggle. When an agent is selected its info card replaces
                the team card; the Super User input sits below either way. */}
            <div style={{ position:"absolute", top:8, right:8, width:450, pointerEvents:"none" }}>
              <div style={{ pointerEvents:"auto" }}>
                {selectedAgentSpec ? (
                  <AgentInfoCard
                    team={renderTeam}
                    spec={selectedAgentSpec}
                    roleByName={roleByName}
                    status={activeAgents.has(selectedAgentSpec.name) ? "active" : "idle"}
                    models={models}
                    modelId={(perAgentModel.get(selectedAgentSpec.name) ?? "")}
                    onPickModel={(id) => onPickAgentModel(selectedAgentSpec.name, id)}
                    accountsStatus={accountsStatus}
                    fallbackLabel={
                      effectiveTeamModel
                        ? `(use team model · ${effectiveTeamModel})`
                        : serverState.model_id
                          ? `(use server model · ${serverState.model_id})`
                          : "(use team / server fallback)"
                    }
                    onClose={() => setSelectedNode(null)}
                  />
                ) : (
                  <TeamInfoCard
                    team={renderTeam}
                    models={models}
                    teamModel={effectiveTeamModel}
                    onChangeTeamModel={onPickTeamModel}
                    serverModelId={serverState.model_id}
                    accountsStatus={accountsStatus}
                  />
                )}
                <SuperUserCard
                  team={renderTeam}
                  roleByName={roleByName}
                  chat={supChat}
                  onSend={onSupSend}
                  autoApprove={autoApprove}
                  onToggleAutoApprove={() => setAutoApprove(v => !v)}
                  projectId={selectedProjectId}
                  directives={directives}
                  onDirectivesChanged={reloadDirectives}
                  directorMode={directorMode}
                  onToggleDirectorMode={() => setDirectorMode(!directorMode)}
                />
              </div>
            </div>
          </div>
        </div>
        <div data-ui="RosterSplitter" style={{ width:SPLITTER_W, flexShrink:0, background:"var(--bg-card)" }} />
        <div style={{ flex:"1 1 0", minWidth:360 }}>
          <OrchestratorPane
            agentLogs={agentLogs}
            agentThoughts={agentThoughts}
            runError={runError}
            serverState={serverState}
            selectedAgent={selectedNode}
            activeAgent={activeAgent}
            team={renderTeam}
            phase={phase}
            models={models}
            modelFor={modelFor}
            onPickAgentModel={onPickAgentModel}
            accountsStatus={accountsStatus}
          />
        </div>
      </div>
    </div>
  );
}
