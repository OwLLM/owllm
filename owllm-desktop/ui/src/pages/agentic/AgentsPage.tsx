// AgentsPage — agentic tab body. Frame + header + tabs come from
// AppShell. Layout: location strip, goal row, then the workspace
// (canvas + cards + orchestrator pane).
//
// All data is live: projects from list_projects (legacy SQLite), team
// templates + role definitions from agents.rs, bridge config from
// bridges.rs, server state via server_status. No hardcoded rosters.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import MarkdownLink from "../../components/MarkdownLink";
import { useAnimatedPhase } from "../../hooks/useAnimatedPhase";
import ProjectSettingsDialog from "./ProjectSettingsDialog";
import BrainstormPanel from "./BrainstormPanel";
import TeamWorkbenchModal from "./TeamWorkbenchModal";
import TeamMemoryModal from "./TeamMemoryModal";
import IconPickerDialog, {
  getAgentIconOverride,
  setAgentIconOverride,
  loadOverridesForProject,
} from "./IconPickerDialog";
import ModelPicker, { AccountsStatusLite } from "./ModelPicker";
import {
  type VoiceConfig,
  DEFAULT_VOICE,
  listVoices as listTtsVoices,
  onVoicesChanged as onTtsVoicesChanged,
  speak as ttsSpeak,
  preview as ttsPreview,
  stopAll as ttsStopAll,
  ttsAvailable,
} from "./voice";
import {
  type Attachment,
  type Directive,
  formatDirectivesBlock,
  buildCriticPrompt,
  buildAskUserBubble,
  extractUserInputRequest,
  transcribeAudioAttachments,
  imageAttachments,
  appendImageAttachmentNotes,
  appendCliImageFiles,
  saveCliImages,
  resolveImageCwd,
  fileToImageAttachment,
  openaiUserContent,
  anthropicUserContent,
  parseClaudeModelId,
  mapClaudeEffort,
  getClaudeSession,
  resetClaudeSession,
  clearAllClaudeSessions,
  loadAgentMemory,
  appendAgentMemory,
  streamLocalChat,
  runCodexCliStream,
  ensureCliWarm,
  clearCliWarm,
  parseDispatchesDetailed,
  unresolvedCorrectionMessage,
  resolveAutoModel,
  wiredDispatchTargets,
  unwiredCorrectionMessage,
  MAX_CHAIN_HOPS,
  MAX_AGENT_RERUNS,
  routingHint,
  nextHandoffs,
  loopExhaustedNotice,
  fetchNetRetry,
  TEAM_OPERATING_CONTRACT,
  TEAM_MEMORY_HINT,
  projectWorkspaceBlock,
} from "./dispatch";
// The local-model tool-use loop now lives in ONE shared place
// (streamLocalChat in dispatch.ts). AgentsPage's local streamChatCompletion
// keeps only the cloud/sub/API routing and delegates the GGUF path to
// streamLocalChat. stripFabricatedToolOutput is still used to clean the
// SuperUser orchestrator's streamed reply.
import { stripFabricatedToolOutput, LOCAL_TOOL_SPECS, setTeamMemoryScope, getTeamMemorySnapshot, refreshTeamMemorySnapshot, harvestMemoryWrites, retrieveTeamMemory, logTeamWork, runGate } from "./localTools";
import { enrichInstructionWithMemory } from "./teamMemoryFormat";
import { renderGateLine, type GateResult, type GateScope } from "./gate";
import { normalizeTeam, roleCanWrite, classifyGoal, bestAgentForGoal, agentDomain,
  criticIsSatisfied, criticRefused, criticConcluded, parseCriticVerdict, toolRoleIsWrite,
  goalRequiresWrite, runDelivered, normalizeRunOutput, isNoProgress } from "./teamConfig";
import type { AgentDomain } from "./teamConfig";
import { scoreRun, summarizeTrace, type RunTrace } from "./runTrace";
import { TEAM_FIXTURES } from "./teamEvalFixtures";
import { resolveAgentSkills, buildAgentSkillBlock } from "./skillRuntime";
import { getServerCtx } from "../core/serverContext";
import { isolationBadge } from "./isolationBadge";
import { wslIsolationGet, isWslPath, wslStatus, winToWslMountUnc } from "./wslIsolation";
import { sandboxSyncLogins, sandboxConvertProject, sandboxHarden } from "./isolation";
import { bundleOffsets } from "./edgeRouter";
import { worldEmit } from "../world/worldBus";
import { ChatBubble, ChatMarkdown, ToolEventCard, ThinkingBlock, fmtTime } from "../../components/ChatBubble";
import { chatRuntime } from "../../runtime/chatRuntime";
import { useChatSession } from "../../runtime/useChatSession";

// Native tool_call shape harvested by consumeOpenAISse from
// delta.tool_calls (used by the cloud streaming display path).
type NativeToolCall = { name: string; args: Record<string, string> };

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

// Per-agent MODEL overrides persist per project in localStorage — the SAME
// per-project-per-agent scheme the icon overrides use (IconPickerDialog). They
// were ephemeral useState, so a project never kept its model and the orchestrator
// silently fell back to a default (e.g. Claude) on reload — bug #16/#17.2.
const agentModelKey = (pid: string, agent: string) => `owllm:agent-model:${pid}:${agent}`;
function setAgentModelOverride(pid: string, agent: string, modelId: string): void {
  if (!pid || !agent) return;
  try {
    if (modelId.trim()) localStorage.setItem(agentModelKey(pid, agent), modelId);
    else localStorage.removeItem(agentModelKey(pid, agent));
  } catch { /* private mode */ }
}
function loadAgentModelsForProject(pid: string, graphJson?: string | null): Map<string, string> {
  const m = new Map<string, string>();
  if (!pid) return m;
  // BASE layer: the project's DB graph_json. It survives an app reinstall/update
  // (which wipes WebView2 localStorage), so it's the fallback that keeps picks
  // across reinstalls.
  if (graphJson && graphJson.trim()) {
    try {
      const am = JSON.parse(graphJson)?.agentModels;
      if (am && typeof am === "object") {
        for (const k of Object.keys(am)) {
          const v = (am as Record<string, unknown>)[k];
          if (typeof v === "string" && v.trim()) m.set(k, v);
        }
      }
    } catch { /* malformed graph_json → fall through to localStorage */ }
  }
  // OVERLAY: localStorage is written SYNCHRONOUSLY on every pick, so it is the
  // FRESHEST source on a normal restart. It must WIN over graph_json, whose
  // writer is debounced + guarded (skips while a template is active) and can lag
  // behind — the stale graph_json overwriting the fresh pick is exactly the
  // "old models come back at restart" bug. On a reinstall localStorage is empty,
  // so the graph_json base above stands.
  const prefix = `owllm:agent-model:${pid}:`;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      const v = localStorage.getItem(k);
      if (v && v.trim()) m.set(k.slice(prefix.length), v);
    }
  } catch { /* private mode */ }
  return m;
}

// Per-agent VOICE picks persist the same way the model picks do — project- and
// agent-scoped localStorage — so an agent's TTS voice/rate survives a restart
// instead of resetting to default ("everything random on restart"). Was
// in-memory only: set on change but never saved and wiped to {} on every
// project/team change.
const agentVoiceKey = (pid: string, agent: string) => `owllm:agent-voice:${pid}:${agent}`;
function setAgentVoiceOverride(pid: string, agent: string, voice: VoiceConfig): void {
  if (!pid || !agent) return;
  try { localStorage.setItem(agentVoiceKey(pid, agent), JSON.stringify(voice)); }
  catch { /* private mode */ }
}
function loadAgentVoicesForProject(pid: string, graphJson?: string | null): Map<string, VoiceConfig> {
  const m = new Map<string, VoiceConfig>();
  if (!pid) return m;
  // BASE: DB graph_json (survives reinstall). OVERLAY: localStorage wins (freshest
  // per-pick write). Same precedence + reasoning as loadAgentModelsForProject.
  if (graphJson && graphJson.trim()) {
    try {
      const av = JSON.parse(graphJson)?.agentVoices;
      if (av && typeof av === "object") {
        for (const k of Object.keys(av)) {
          const v = (av as Record<string, unknown>)[k];
          if (v && typeof v === "object") m.set(k, v as VoiceConfig);
        }
      }
    } catch { /* malformed graph_json → fall through to localStorage */ }
  }
  const prefix = `owllm:agent-voice:${pid}:`;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      const v = localStorage.getItem(k);
      if (!v) continue;
      try { m.set(k.slice(prefix.length), JSON.parse(v) as VoiceConfig); }
      catch { /* skip a corrupt entry */ }
    }
  } catch { /* private mode */ }
  return m;
}
// Per-agent SKILL packs + per-agent tool grants persist the same way models do:
// project-scoped, DB graph_json authoritative (survives reinstall). Both are
// string[] per agent. See [[project_chat_vs_run_dispatch_paths]] for the
// graph_json blob convention.
function loadAgentListMapForProject(
  graphJson: string | null | undefined,
  key: "agentSkills" | "agentToolExtras",
): Map<string, string[]> {
  const m = new Map<string, string[]>();
  if (!graphJson || !graphJson.trim()) return m;
  try {
    const obj = JSON.parse(graphJson)?.[key];
    if (obj && typeof obj === "object") {
      for (const k of Object.keys(obj)) {
        const v = (obj as Record<string, unknown>)[k];
        if (Array.isArray(v)) m.set(k, v.filter((x): x is string => typeof x === "string"));
      }
    }
  } catch { /* malformed graph_json → empty */ }
  return m;
}
const loadAgentSkillsForProject = (gj?: string | null) => loadAgentListMapForProject(gj, "agentSkills");
const loadAgentToolExtrasForProject = (gj?: string | null) => loadAgentListMapForProject(gj, "agentToolExtras");

// THE single graph_json serializer. Every persist site must go through this so
// a partial write (e.g. an edge edit) can never clobber sibling keys (models,
// voices, skills, tool-extras) — the exact bug class the per-agent persistence
// comments warn about. Writes the FULL blob every time.
function buildGraphJson(opts: {
  edges: Edge[];
  agents: AgentSpec[];
  agentModels: Map<string, string>;
  agentVoices: Map<string, VoiceConfig>;
  agentSkills: Map<string, string[]>;
  agentToolExtras: Map<string, string[]>;
}): string {
  return JSON.stringify({
    edges: opts.edges,
    roster: opts.agents.map(a => ({ name: a.name, base: a.base })),
    agentModels: Object.fromEntries(opts.agentModels),
    agentVoices: Object.fromEntries(opts.agentVoices),
    agentSkills: Object.fromEntries(opts.agentSkills),
    agentToolExtras: Object.fromEntries(opts.agentToolExtras),
  });
}

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
  /// Team-structure role set in the Workbench (left column): "leader" = this agent
  /// may dispatch to its own members (a sub-orchestrator); "agent" = a worker that
  /// only takes a job and does it. Drives the dispatch engine's leader detection
  /// REGARDLESS of base role, so any agent the user marks as a leader can direct a
  /// sub-team. The orchestrator is always a leader (via its base).
  role?: "leader" | "agent";
  // The team JSON ships rich per-agent text — a short description
  // shown in cards and a longer extra_prompt that augments the role's
  // base system prompt during dispatch. Keep both around so the
  // specialist prompt builder can layer them.
  description?: string;
  extraPrompt?: string;
  // Per-agent SKILL.md packs equipped on this agent (skill ids). Skills are
  // instruction packs loaded on demand at dispatch (progressive disclosure),
  // distinct from `tool_allowlist` function calls. Kept in sync with the
  // dispatch.ts AgentSpec copy.
  extraSkills?: string[];
};
type Edge = { source: string; target: string };
type TeamVisibility = "recommended" | "more" | "examples" | "legacy" | "custom";
type Team = {
  id: string;
  name: string;
  display: string;
  category: string;
  description: string;
  icon: string;
  agents: AgentSpec[];
  edges: Edge[];
  visibility: TeamVisibility;
  workflowRank: number;
  requiredMcp: string[];
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
  /// SKILL.md pack ids associated with this role on the AGENT itself (Studio
  /// agent card → Skills). Merged with the team template's per-agent
  /// `extra_skills` and the per-project graph_json grant at dispatch.
  skillAllowlist?: string[];
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
  /// Epoch ms when the entry was created — shown next to the role in the
  /// shared ChatBubble. Stamped at creation; deltas don't re-stamp.
  ts?: number;
  /// Optional inline recovery action rendered as a one-click button under the
  /// bubble. "wsl-restart" → "⟳ Restart WSL networking" (fires owllm:wsl-restart).
  /// Set on network-failure system messages so users never type a terminal cmd.
  action?: "wsl-restart";
};

// Module-scoped monotonic sequence — assigns a chronological id to
// every entry so the Full Chat tab can interleave the reply + thought
// streams in arrival order regardless of which Map they're stored in.
let _entrySeq = 0;
function nextSeq(): number { return ++_entrySeq; }
// Advance the sequence floor past anything restored from disk. CRITICAL:
// _entrySeq restarts at 0 on every app launch, but entries rehydrated from the
// DB (chat_json / agent_logs_json) keep LAST session's seq values (1..N). Without
// this, the first new entries after a restart get seq 1,2,3… and collide with the
// restored ones — which (a) scrambled the Full Chat's seq-sort so a focused
// agent showed its messages in random order, and (b) duplicated the React keys
// (`r-${seq}` / `u-${seq}`) so colliding entries silently dropped from the render
// ("not everything appears"). Call on every rehydrate so new entries always sort
// AFTER — and key uniquely against — everything restored.
function ensureSeqAbove(n: number): void { if (n > _entrySeq) _entrySeq = n; }
function maxSeqOf(entries: Iterable<GoalMsg>): number {
  let mx = 0;
  for (const e of entries) if (typeof e.seq === "number" && e.seq > mx) mx = e.seq;
  return mx;
}

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
function agentIconRef(
  spec: AgentSpec,
  roleByName: Map<string, RoleData>,
  // Per-(project, agent) icon overrides from localStorage. When the
  // map has an entry for spec.name, that wins over every other source.
  // Passing {} or omitting falls back to the legacy resolution chain
  // (spec.icon → role.icon → BASE_OWL[base] → assistant).
  overrides?: Record<string, string>,
): string {
  if (overrides && overrides[spec.name]) return overrides[spec.name];
  if (spec.icon) return spec.icon;
  const role = roleByName.get(spec.base);
  if (role?.icon) return role.icon;
  if (BASE_OWL[spec.base]) return BASE_OWL[spec.base];
  return "owl:owl_asssitant";
}

const _ACRONYMS = new Set(["ux","ui","api","mcp","gpu","be","fe","qa","cli","sql","db"]);
const RECOMMENDED_TEAM_RANK: Record<string, number> = {
  code_artisan: 10,
  product_studio: 20,
  research_lab: 30,
  secretary: 40,
  n8n_workflow_builder: 50,
  data_analyst: 60,
  writers_room: 70,
};
function normalizeTeamVisibility(value: unknown, teamName: string): TeamVisibility {
  if (value === "recommended" || value === "more" || value === "examples" || value === "legacy") return value;
  return RECOMMENDED_TEAM_RANK[teamName] ? "recommended" : "examples";
}

/// Collapse a raw agent/CLI failure into ONE clean line for the chat. A failed
/// cloud CLI (e.g. codex) throws an error whose message is its entire raw
/// stdout — the `Reconnecting 2/5…`, the `ERROR codex_api::…` walls, the session
/// banner. Dumping that verbatim is the "trash" users reported. Name the common
/// causes plainly (network/DNS, usage limit, not-signed-in) and otherwise show
/// only the first meaningful line — never the dump.
/// True when an agent failure is a network/DNS reachability problem (vs. a model
/// or auth error). Drives the one-click "Restart WSL networking" recovery button.
function isNetworkAgentError(raw: unknown): boolean {
  const low = String((raw as { message?: string })?.message ?? raw ?? "").toLowerCase();
  return low.includes("failed to lookup address") || low.includes("getaddrinfo") ||
    low.includes("stream disconnected") || low.includes("failed to connect to websocket") ||
    low.includes("error sending request") || low.includes("dns");
}
function cleanAgentError(raw: unknown): string {
  const s = String((raw as { message?: string })?.message ?? raw ?? "").trim();
  const low = s.toLowerCase();
  if (isNetworkAgentError(raw) || low.includes("dns")) {
    // Plain language + a button does the fix — no terminal commands in the user's
    // face. The button (rendered under this bubble) runs `wsl --shutdown` for them.
    return "couldn't reach the network from the sandbox — usually a VPN or a WSL networking hiccup, not the model. Click “Restart WSL networking” below, then send your message again.";
  }
  if (low.includes("usage limit") || low.includes("quota") || low.includes("rate limit") || low.includes("429") || low.includes("insufficient_quota")) {
    return "the cloud model hit its usage limit (provider-side) — pick another model and try again.";
  }
  if (low.includes("not logged in") || low.includes("unauthorized") || low.includes("401")) {
    return "that model isn't signed in — connect it on the Accounts page, then retry.";
  }
  const noise = /^(reconnecting|openai codex|reading additional input|workdir|model:|provider:|approval|sandbox:|reasoning|session id|user$|<stdin>|----|key facts|•|error codex|error rmcp|error [a-z_]+::|\d{4}-\d\d-\d\d)/i;
  const first = s.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0 && !noise.test(l));
  return (first ?? s).slice(0, 220);
}
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

// Enforce the unique-agent-name invariant at the data boundary. Agent names
// are identities: @dispatch resolves by exact name and every render surface
// (chat grid, diagram, graph) keys nodes by name. A roster that carries the
// same name twice — from an older/edited project record or a hand-touched
// custom team — otherwise renders as duplicate cards with colliding React
// keys ("agent cards repeated over and over"). Keep the FIRST occurrence
// (the authored one) and drop later collisions. Order is preserved.
function dedupeAgentsByName(agents: AgentSpec[]): AgentSpec[] {
  const seen = new Set<string>();
  const out: AgentSpec[] = [];
  for (const a of agents) {
    if (!a || typeof a.name !== "string") continue;
    if (seen.has(a.name)) continue;
    seen.add(a.name);
    out.push(a);
  }
  return out;
}

function toTeam(t: TeamTemplateBackend): Team {
  const d = t.data ?? {};
  const agents: AgentSpec[] = dedupeAgentsByName(Array.isArray(d.agents)
    ? d.agents.map((a: any) => ({
        name: a.name,
        base: a.base,
        icon: a.icon ?? null,
        description: typeof a.description === "string" ? a.description : undefined,
        // Qt source spells this `extra_prompt`; we expose it camel-case
        // on the React side so usage doesn't pierce snake_case.
        extraPrompt: typeof a.extra_prompt === "string" ? a.extra_prompt : undefined,
        extraSkills: Array.isArray(a.extra_skills) ? a.extra_skills.filter((s: any) => typeof s === "string") : undefined,
        role: a.role === "leader" ? "leader" : a.role === "agent" ? "agent" : undefined,
      }))
    : []);
  const edges: Edge[] = Array.isArray(d.graph?.edges) ? d.graph.edges : [];
  const name = d.name ?? t.id;
  return {
    id: t.id,
    name,
    display: d.display_name ?? t.id,
    category: d.category ?? "Other",
    icon: d.icon ?? "owl:owl_agentic",
    description: d.description ?? "",
    agents,
    edges,
    visibility: normalizeTeamVisibility(d.visibility, name),
    workflowRank: typeof d.workflow_rank === "number" ? d.workflow_rank : (RECOMMENDED_TEAM_RANK[name] ?? 999),
    requiredMcp: Array.isArray(d.required_mcp) ? d.required_mcp : [],
  };
}

// Build a virtual Team from a project's raw agent-name list. If the
// project has a stored routing graph (graph_json), parse it; otherwise
// the diagram/graph view falls back to the star topology computed in
// computeDepths().
function projectToTeam(p: ProjectRow): Team {
  let edges: Edge[] = [];
  // Recover each agent's ROLE (base). The project's `team` is just NAMES, so a
  // renamed lead like "Orchi the orchestrator" otherwise loses base="orchestrator"
  // (base=name). We persist the roster's {name, base} into graph_json on save, so
  // read it back here. Older projects (no roster stored) fall back to base=name —
  // the name-contains rule in orchestratorOf still catches a renamed orchestrator.
  const baseByName = new Map<string, string>();
  if (p.graph_json && p.graph_json.trim().length > 0) {
    try {
      const parsed = JSON.parse(p.graph_json);
      if (Array.isArray(parsed?.edges)) {
        edges = parsed.edges
          .filter((e: any) => typeof e?.source === "string" && typeof e?.target === "string")
          .map((e: any) => ({ source: e.source, target: e.target }));
      }
      if (Array.isArray(parsed?.roster)) {
        for (const r of parsed.roster) {
          if (r && typeof r.name === "string" && typeof r.base === "string" && r.base.trim()) {
            baseByName.set(r.name, r.base);
          }
        }
      }
    } catch {
      // Stale graph_json — silently fall back to empty.
    }
  }
  const agents: AgentSpec[] = dedupeAgentsByName(
    p.team.map(n => ({ name: n, base: baseByName.get(n) ?? n })),
  );
  return {
    id: `project:${p.id}`,
    name: p.name,
    display: p.name,
    category: "Project",
    description: p.description || "Project — agents from the saved roster.",
    icon: "owl:owl_agentic",
    // Projects are user-created teams: not part of the curated roster, no
    // workflow ranking, no MCP requirement of their own.
    visibility: "custom",
    workflowRank: 999,
    requiredMcp: [],
    agents,
    edges,
  };
}

/// The Workbench edits team TEMPLATES, but a project stores only its roster (no
/// template id). Recover the template the project is running so the header chip
/// can NAME the team (not the project) and the Workbench can open it. Match
/// strategy, most reliable first: the active team is already a template (the
/// user picked one) → use it; else exact agent-NAME set; else exact base-ROLE
/// multiset (survives per-agent renames); else best name overlap ≥ 60%.
/// Returns null for a genuinely custom roster that matches no template.
function teamTemplateForActive(active: Team | null, teams: Team[]): Team | null {
  if (!active) return null;
  if (!active.id.startsWith("project:")) return active; // already a real template
  const projNames = active.agents.map(a => a.name).filter(Boolean);
  if (projNames.length === 0) return null;
  const nameSet = new Set(projNames);
  const baseKey = (ags: { base: string }[]) => ags.map(a => a.base).filter(Boolean).sort().join("|");
  const projBaseKey = baseKey(active.agents);

  // 1) exact agent-NAME set.
  const byName = teams.find(t => {
    const tn = t.agents.map(a => a.name);
    return tn.length === nameSet.size && tn.every(n => nameSet.has(n));
  });
  if (byName) return byName;
  // 2) exact base-ROLE multiset (renamed agents still match).
  if (projBaseKey) {
    const byBase = teams.find(t => baseKey(t.agents) === projBaseKey);
    if (byBase) return byBase;
  }
  // 3) best agent-name overlap (Jaccard) ≥ 0.6.
  let best: Team | null = null, bestScore = 0;
  for (const t of teams) {
    const tn = t.agents.map(a => a.name);
    if (tn.length === 0) continue;
    const inter = tn.filter(n => nameSet.has(n)).length;
    const union = new Set([...tn, ...projNames]).size;
    const score = union ? inter / union : 0;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return bestScore >= 0.6 ? best : null;
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
// Identify a team's orchestrator CONSISTENTLY everywhere:
//   1) exact role/name "orchestrator"
//   2) a RENAMED orchestrator that keeps "orchestrator" in its name/base
//      (e.g. "Orchi the orchestrator") — projects persist only agent NAMES, so a
//      renamed lead loses its base="orchestrator" on reload (projectToTeam sets
//      base=name); without this the next step wrongly crowned whatever card sat
//      first (e.g. "Coder").
//   3) the first agent — true last resort only.
// (Step 2 is the stopgap; the durable fix is preserving each agent's base in the
// project so the rename keeps base="orchestrator". Returns null for an empty roster.)
function orchestratorOf(agents: AgentSpec[]): AgentSpec | null {
  if (!agents.length) return null;
  return agents.find(a => a.name === "orchestrator")
      ?? agents.find(a => a.base === "orchestrator")
      ?? agents.find(a => /\borchestrator\b/i.test(a.name) || /\borchestrator\b/i.test(a.base))
      ?? agents[0];
}

function computeDepths(team: Team): Map<string, number> {
  const out = new Map<string, number>();
  if (!team.agents.length) return out;
  const orchName = orchestratorOf(team.agents)?.name ?? team.agents[0].name;
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

// GoalRow — agents_page.py:1757-1910. 📎 attach, goal input, Run,
// Cancel, 📊 telemetry, 🔊 voice with ▾ menu caret. Images + audio
// can be attached via the 📎 button (file picker) or dropped onto the
// input. Each attachment becomes a chip rendered just under the row.

const MAX_ATTACH_BYTES = 20 * 1024 * 1024; // 20 MB per file, in-memory base64

function mimeFromFilename(name: string): string | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "heic") return "image/heic";
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "wav") return "audio/wav";
  if (ext === "ogg" || ext === "oga" || ext === "opus") return "audio/ogg";
  if (ext === "m4a" || ext === "aac") return "audio/aac";
  if (ext === "webm") return "audio/webm";
  if (ext === "flac") return "audio/flac";
  return null;
}

/// Browser File -> Attachment. Reads as base64 via FileReader. Throws
/// when the MIME isn't image/* or audio/*, or when the file exceeds
/// MAX_ATTACH_BYTES (would balloon the request body unmanageably).
async function fileToAttachment(file: File): Promise<Attachment> {
  if (file.size > MAX_ATTACH_BYTES) {
    throw new Error(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB — limit is ${MAX_ATTACH_BYTES / 1024 / 1024} MB.`);
  }
  const mime = file.type || mimeFromFilename(file.name) || "application/octet-stream";
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

function GoalRow({ goal, setGoal, onRun, onCancel, busy, attachments, setAttachments, onBrainstorm, hasBrief, brainstormReady, leftSlot }: {
  goal: string; setGoal: (g: string) => void;
  onRun: () => void; onCancel: () => void; busy: boolean;
  attachments: Attachment[]; setAttachments: (a: Attachment[]) => void;
  /// Compact project cluster (project dropdown + ⚙ settings + New) rendered at
  /// the START of the run row, so the whole top is a SINGLE line.
  leftSlot?: React.ReactNode;
  /// Opens the BrainstormPanel modal — OR, when the project has no folder yet,
  /// opens Project settings so the user can set one (never a dead button).
  onBrainstorm: (() => void) | null;
  /// Whether BRIEF.md exists in this project's location. Drives the
  /// 🧠 button's tint (green = brief locked, neutral = brief missing).
  hasBrief: boolean;
  /// True when the project has a folder set (so brainstorm can run straight
  /// away). False → the 🧠 button opens Project settings instead.
  brainstormReady?: boolean;
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
        {leftSlot}
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
          onPaste={e => { const imgs = Array.from(e.clipboardData?.files ?? []).filter(f => f.type.startsWith("image/")); if (imgs.length) { e.preventDefault(); addFiles(imgs); } }}
          placeholder="Goal — e.g. 'summarise the last commit and propose a follow-up' (paste or drop an image / audio)"
          style={{ flex:1, height:38, borderRadius:10, padding:"0 14px", fontSize:13, background:"var(--bg-input)", color:"var(--fg-strong)", border: dragOver ? "1px dashed rgba(124,196,255,0.85)" : "1px solid transparent" }} />
        <button
          data-ui="GoalBrainstormBtn"
          onClick={() => onBrainstorm?.()}
          disabled={!onBrainstorm || busy}
          title={!brainstormReady
            ? "Brainstorm needs a project folder — click to open Project settings and set one"
            : (hasBrief
                ? "Re-run brainstorm (BRIEF.md exists — will be overwritten)"
                : "Brainstorm: co-founder chat → research → BRIEF.md before the team runs")}
          style={{
            height: 38, minWidth: 44, padding: "0 10px",
            border: "none", borderRadius: 10,
            background: hasBrief ? "rgba(80, 200, 120, 0.18)" : "var(--bg-surface)",
            color: hasBrief ? "#a0f0c0" : "var(--fg)",
            fontSize: 16,
            // Always clickable (unless busy): with no folder it opens Settings
            // to set one, instead of sitting there ghosted with no way forward.
            cursor: (onBrainstorm && !busy) ? "pointer" : "not-allowed",
            opacity: busy ? 0.5 : (brainstormReady ? 1 : 0.8),
          }}
        >🧠</button>
        <button data-ui="GoalRunBtn" disabled={busy || !goal.trim()} onClick={onRun}
          style={{ height:38, padding:"0 24px", borderRadius:10, border:"none",
                   background: busy || !goal.trim() ? "rgba(var(--accent-rgb),0.25)" : "var(--accent)",
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
        <button data-ui="GoalVoiceBtn" title="Speak agent replies aloud — voice per agent. Click ▾ to switch engine." style={{ height:38, minWidth:64, padding:"0 6px", border:"none", borderRadius:8, background:"rgba(var(--accent-rgb),0.18)", color:"var(--accent)", fontSize:16, display:"inline-flex", alignItems:"center", justifyContent:"center", gap:4 }}>🔊<span style={{ fontSize:11, opacity:0.7 }}>▾</span></button>
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

// ---- Run timers (team-wide + per-agent) ----
// h:mm:ss once past an hour, else m:ss. For the header stopwatch + per-agent cards.
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
/// Force a 1-s re-render while `active` so a running stopwatch ticks live; stops
/// the interval (no churn) once the clock freezes. Each timer ticks itself.
function useTick(active: boolean): void {
  const [, force] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => force(x => (x + 1) % 1_000_000), 1000);
    return () => clearInterval(id);
  }, [active]);
}
/// Per-agent active timing: cumulative working time, ticking while active.
export type AgentTiming = { activeSince: number | null; accumMs: number };
function agentElapsedMs(t: AgentTiming | undefined): number {
  if (!t) return 0;
  return t.accumMs + (t.activeSince != null ? Date.now() - t.activeSince : 0);
}

// FlowHeader — canvas_header in agents_page.py:2540-2596.
// Action buttons operate on whichever edge is currently selected in
// the graph view. The view toggle flips between the orbital diagram
// and the editable graph (mirrors agents_page.py:_on_view_toggle).
function FlowHeader({
  viewMode, onSetView,
  canEdit, onDeleteEdge, onReverseEdge, onResetLayout,
  teamLabel, onOpenWorkbench,
  runStartedAt, runEndedAt,
}: {
  viewMode: "diagram" | "graph" | "chat";
  /// Three-state segmented switch — caller passes the target mode the
  /// user clicked. Replaces the binary toggle the page had before the
  /// 2026-05-28 restructure that added the per-agent chat grid as a
  /// canvas mode.
  onSetView: (m: "diagram" | "graph" | "chat") => void;
  canEdit: boolean;
  onDeleteEdge: () => void;
  onReverseEdge: () => void;
  onResetLayout: () => void;
  /// The team this project runs. Rendered as a clickable chip next to the
  /// title that opens the full Team Workbench (roles + arrows + skills).
  teamLabel?: string | null;
  onOpenWorkbench?: () => void;
  /// Team stopwatch: when the current/last run started and ended. Ticks live
  /// while endedAt is null; freezes on the final duration when the run stops.
  runStartedAt?: number | null;
  runEndedAt?: number | null;
}) {
  const runActive = runStartedAt != null && runEndedAt == null;
  useTick(runActive);
  const seg = (id: "diagram" | "graph" | "chat", label: string, title: string) => {
    const on = viewMode === id;
    return (
      <button
        key={id}
        data-ui={`FlowViewBtn-${id}`}
        className="ghost-btn"
        onClick={() => onSetView(id)}
        title={title}
        style={{
          height:28, padding:"0 10px", fontSize:11,
          background: on ? "rgba(var(--accent-rgb),0.22)" : undefined,
          color: on ? "var(--accent)" : undefined,
          borderRadius:0,
        }}
      >{label}</button>
    );
  };
  // Edge-edit buttons only make sense in graph mode; collapse them
  // to invisible in the other modes so the toolbar reads cleaner.
  const showEditBtns = viewMode === "graph";
  return (
    <div style={{ position:"relative", display:"flex", alignItems:"center", padding:"6px 10px", gap:6, borderBottom:"1px solid var(--border)" }}>
      <div data-ui="FlowTitle" style={{ fontSize:16, fontWeight:700, color:"var(--fg-strong)", height:28, display:"flex", alignItems:"center", fontFamily:"Segoe UI", paddingRight:8 }}>Orchestrated Workflow</div>
      {/* Team stopwatch — absolute-centered so it sits in the middle of the header
          regardless of the buttons on either side. Shows how long the team has run
          autonomously; green + ⏱ while live, muted + ✓ once the run stops. */}
      {runStartedAt != null && (
        <div
          data-ui="FlowRunTimer"
          title={runActive ? "The team is running — elapsed time" : "How long the last run took"}
          style={{
            position:"absolute", left:"50%", top:"50%", transform:"translate(-50%,-50%)",
            display:"flex", alignItems:"center", gap:6, height:24, padding:"0 12px",
            borderRadius:999, fontSize:13, fontWeight:700, fontVariantNumeric:"tabular-nums",
            color: runActive ? "#5af09c" : "var(--fg-muted)",
            background: runActive ? "rgba(60,242,107,0.12)" : "rgba(255,255,255,0.05)",
            border: `1px solid ${runActive ? "rgba(60,242,107,0.45)" : "var(--border)"}`,
            pointerEvents:"none",
          }}
        >
          <span style={{ fontSize:12 }}>{runActive ? "⏱" : "✓"}</span>
          {formatDuration((runEndedAt ?? Date.now()) - runStartedAt)}
        </div>
      )}
      {teamLabel && (
        <button
          data-ui="FlowTeamChip"
          onClick={onOpenWorkbench}
          title="Open the Team Workbench — assign leaders, wire who dispatches to whom, equip skills"
          style={{
            display:"flex", alignItems:"center", gap:6, height:28, padding:"0 11px",
            borderRadius:999, fontSize:12, fontWeight:700, cursor:"pointer",
            background:"rgba(var(--accent-rgb),0.12)", border:"1px solid rgba(var(--accent-rgb),0.45)",
            color:"var(--accent)",
          }}
        >
          <span style={{ fontSize:13 }}>👥</span>
          <span style={{ maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{teamLabel}</span>
          <span style={{ fontSize:10, opacity:0.8 }}>⚙ edit team</span>
        </button>
      )}
      <div style={{ flex:1 }} />
      {showEditBtns && (
        <>
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
        </>
      )}
      <button
        data-ui="FlowMemoryBtn"
        className="ghost-btn"
        onClick={() => window.dispatchEvent(new CustomEvent("owllm:open-team-memory"))}
        title="Team Memory — the shared knowledge base your agents read and write (build commands, decisions, file maps). Syncs across your PCs via the vault."
        style={{ height:28, padding:"0 8px", fontSize:11 }}
      >🧠 Memory</button>
      <button data-ui="FlowRefreshBtn" className="ghost-btn" title="Refresh model lists in every picker" style={{ height:28, width:30, padding:0, fontSize:11 }}>⟳</button>
      {/* 3-way segmented view switch. Diagram = live orbital,
          Graph = editable top-down hierarchy, Chat = per-agent grid
          replacing the canvas entirely. */}
      <div data-ui="FlowViewSeg" style={{ display:"flex", border:"1px solid var(--border)", borderRadius:6, overflow:"hidden" }}>
        {seg("diagram", "◑ Diagram", "Live orbital diagram (animated)")}
        {seg("graph",   "◐ Graph",   "Editable top-down hierarchical graph")}
        {seg("chat",    "▦ Chat",    "Per-agent chat grid (replaces the canvas with one live transcript per agent)")}
      </div>
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
  const borderGrad = "linear-gradient(135deg, rgba(var(--accent-rgb),0.86) 0%, rgba(192,138,255,0.86) 100%)";
  return (
    <div data-ui="TeamInfoCard" style={{ position:"relative", width:CARD_W, height:CARD_H, borderRadius:12, background:cardBg, border:"1.6px solid transparent", overflow:"hidden" }}>
      <div style={{ position:"absolute", inset:0, borderRadius:12, padding:"1.6px", background:borderGrad, WebkitMask:"linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)", WebkitMaskComposite:"xor", maskComposite:"exclude", pointerEvents:"none" }} />
      {/* Header — team name in place of the old "● CATEGORY" ribbon
          (user spec 2026-05-20). Category survives as a small cyan chip
          inline so the user still sees what kind of team it is. */}
      <div data-ui="TeamHeader" style={{ position:"absolute", left:8, top:8, width:CARD_W - 16, height:28, display:"flex", alignItems:"center", gap:8, paddingLeft:8, fontSize:14, fontWeight:700, color:"var(--fg)", overflow:"hidden" }}>
        <span style={{ flex:"0 1 auto", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }} title={team.display}>{team.display}</span>
        <span style={{
          background: "rgba(var(--accent-rgb),0.18)",
          color: "#a8e8ff",
          border: "1px solid rgba(var(--accent-rgb),0.45)",
          fontSize: 9, fontWeight: 800, letterSpacing: 0.4,
          padding: "2px 7px", borderRadius: 8,
          textTransform:"uppercase", whiteSpace:"nowrap", flexShrink:0,
        }}>{team.category}</span>
      </div>
      <div style={{ position:"absolute", left:pic_x - 6, top:pic_y - 6, width:pic_size + 12, height:pic_size + 12, borderRadius:"50%", background:"radial-gradient(circle, rgba(var(--accent-rgb),0.43) 0%, rgba(var(--accent-rgb),0) 100%)", pointerEvents:"none" }} />
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
  onClose, iconOverrides, onPickIcon,
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
  // Per-(project, agent) icon overrides. Empty when no project loaded.
  iconOverrides: Record<string, string>;
  // Open the IconPickerDialog for THIS agent. Parent owns the modal.
  onPickIcon: (agentName: string) => void;
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
      <button
        onClick={() => onPickIcon(spec.name)}
        title="Click to pick a different icon for this agent"
        style={{
          position:"absolute", left:pic_x, top:pic_y,
          width:pic_size, height:pic_size, borderRadius:"50%",
          background:"#1e2434",
          border:"1.4px solid rgba(230,240,255,0.78)",
          display:"flex", alignItems:"center", justifyContent:"center",
          overflow:"hidden", padding:0, cursor:"pointer",
          // Subtle hover affordance — slight glow so the user notices
          // it's clickable without us shouting about it.
          transition:"box-shadow 120ms, transform 120ms",
        }}
        onMouseEnter={e => { e.currentTarget.style.boxShadow = "0 0 0 3px rgba(140,180,255,0.35)"; }}
        onMouseLeave={e => { e.currentTarget.style.boxShadow = "none"; }}
      >
        <img src={owlSrc(agentIconRef(spec, roleByName, iconOverrides))} style={{ width:pic_size * 0.85, height:pic_size * 0.85, objectFit:"contain", pointerEvents:"none" }} />
      </button>
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

// Tile accent colour — pulled from the SAME tintForGroup() palette
// the canvas cards use, so a green Design Critic tile in the grid
// matches the green Design Critic card on the canvas. Orchestrator
// and critic get distinct dedicated colours since they sit OUTSIDE
// the design/build split.
function tileAccentFor(spec: AgentSpec): string {
  const shortName = spec.name.includes(".") ? spec.name.split(".").pop()! : spec.name;
  const shortBase = spec.base.includes(".") ? spec.base.split(".").pop()! : spec.base;
  if (shortBase === "orchestrator" || shortName === "orchestrator") return "#ffd97a";
  if (spec.name === CRITIC_AGENT_NAME) return "#ff9aa3";
  const group = groupForAgent(spec);
  if (group === "design") return "#7ae0a8";
  if (group === "critic") return "#ffb84c";
  return "#78b4ff";   // build
}

// Tile arrangement for a 4-column grid. Spatial layout the user spec'd:
//
//   Row 0:  Orchestrator | Critic | Design Lead | Design[1]
//   Row N:  Build[2N-2]  | Build[2N-1] | Design[2N] | Design[2N+1]
//
// Build fills the LEFT two columns (or null when build runs out);
// design fills the RIGHT two columns. Empty slots are kept as nulls so
// the grid spacing stays consistent — without explicit cell placement
// CSS auto-flow would back-fill design members into the left columns
// on later rows, which is what was happening in the screenshot.
function arrangeTilesFourCol(team: Team | null): (AgentSpec | null)[] {
  if (!team) return [];
  const agents = team.agents;
  const orch = orchestratorOf(agents);
  let critic = agents.find(a => a.name === CRITIC_AGENT_NAME) ?? null;
  // Auto-inject synthetic Critic when the team has an orchestrator —
  // same rule the canvas applies so the two views show the same roster.
  if (!critic && orch) {
    critic = { name: CRITIC_AGENT_NAME, base: "critic", icon: null };
  }
  const designs = agents
    .filter(a => a !== orch && a.name !== CRITIC_AGENT_NAME && groupForAgent(a) === "design")
    .sort((a, b) => {
      const aShortName = a.name.includes(".") ? a.name.split(".").pop()! : a.name;
      const aShortBase = a.base.includes(".") ? a.base.split(".").pop()! : a.base;
      const bShortName = b.name.includes(".") ? b.name.split(".").pop()! : b.name;
      const bShortBase = b.base.includes(".") ? b.base.split(".").pop()! : b.base;
      const aPo = aShortName === "product_owner" || aShortBase === "product_owner";
      const bPo = bShortName === "product_owner" || bShortBase === "product_owner";
      if (aPo !== bPo) return aPo ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  const builds = agents
    .filter(a => a !== orch && a.name !== CRITIC_AGENT_NAME && groupForAgent(a) === "build")
    .sort((a, b) => a.name.localeCompare(b.name));

  const out: (AgentSpec | null)[] = [];
  let di = 0, bi = 0;
  // Row 0 — orch, critic, design[0], design[1]
  out.push(orch, critic, designs[di++] ?? null, designs[di++] ?? null);
  // Subsequent rows — build, build, design, design
  while (di < designs.length || bi < builds.length) {
    out.push(builds[bi++] ?? null);
    out.push(builds[bi++] ?? null);
    out.push(designs[di++] ?? null);
    out.push(designs[di++] ?? null);
  }
  // Trim trailing all-null tail (won't happen with above loop but cheap to defend).
  while (out.length > 0 && out[out.length - 1] === null && out[out.length - 2] === null
         && out[out.length - 3] === null && out[out.length - 4] === null) {
    out.length -= 4;
  }
  return out;
}
function hexToRgbStr(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r},${g},${b}`;
}

// AgentChatGrid — per-agent chat windows tiled into a square grid in
// the right half of the page. Opened from the ▦ button on the left
// of the SuperUserCard header. Each tile is a mini live log for one
// agent and lights up with the same green pulsing ring used on the
// diagram + graph nodes whenever the agent is mid-stream. Clicking a
// tile selects that agent in the left workspace (same effect as
// clicking the canvas node), so the OrchestratorPane updates too.
function AgentChatGrid({
  team, roleByName, agentLogs, activeAgents, agentIconOverrides,
  selectedAgent, onSelectAgent, agentTiming,
}: {
  team: Team | null;
  roleByName: Map<string, RoleData>;
  agentLogs: Map<string, GoalMsg[]>;
  activeAgents: Set<string>;
  agentIconOverrides: Record<string, string>;
  selectedAgent: string | null;
  onSelectAgent: (name: string) => void;
  /// Per-agent working-time map (name → cumulative timing), for the card clocks.
  agentTiming?: Map<string, AgentTiming>;
}) {
  // Same pulse generator used by the canvas so the ring beat matches
  // the diagram + graph active-state visuals (30 fps, ~1.5 Hz pulse).
  // Gated on real activity + visibility so an idle/backgrounded page does
  // ZERO work (was an unconditional 30fps rAF that pegged a core + leaked).
  const pulsePhase = useAnimatedPhase(activeAgents.size > 0);
  const pulse = 0.5 + 0.5 * Math.sin((pulsePhase * Math.PI) / 180 * 3);

  // 4-column spatial layout. Build fills cols 1-2, design fills cols
  // 3-4 (with the team-leader first), orchestrator + critic anchor the
  // top-left of row 0. Slots can be null when build/design ranks are
  // uneven — we render those as empty grid cells so the placement
  // doesn't drift. Tiny teams (<6 agents) fall back to the original
  // densely-packed square grid.
  const filledArr = useMemo(() => team?.agents ?? [], [team]);
  const fourCol = useMemo(() => arrangeTilesFourCol(team), [team]);
  // Only use the 4-column build/design SPLIT when the team actually HAS a design
  // sub-team. A single team with no design agents (e.g. an ops team like RED)
  // was still forced into 4 columns, leaving the right two columns as empty
  // cells — the cards only filled the LEFT HALF. With no design agents, fall
  // through to the dense-packed grid below so cards expand to fill the full
  // width. Design teams (product_studio, …) keep the reserved split.
  const orchForLayout = orchestratorOf(filledArr);
  const hasDesignAgents = filledArr.some(a =>
    a.name !== orchForLayout?.name && a.name !== CRITIC_AGENT_NAME && groupForAgent(a) === "design");
  const useFourCol = filledArr.length >= 6 && hasDesignAgents;
  const arranged: (AgentSpec | null)[] = useFourCol
    ? fourCol
    : (() => {
      // Small team: order [orch, critic, design(PO first), build] and
      // pack with no nulls.
      const orch = orchestratorOf(filledArr) ?? undefined;
      let critic = filledArr.find(a => a.name === CRITIC_AGENT_NAME);
      if (!critic && orch) critic = { name: CRITIC_AGENT_NAME, base: "critic", icon: null };
      const designs = filledArr
        .filter(a => a !== orch && a.name !== CRITIC_AGENT_NAME && groupForAgent(a) === "design")
        .sort((a, b) => {
          const ap = (a.name.split(".").pop() === "product_owner" || a.base.split(".").pop() === "product_owner");
          const bp = (b.name.split(".").pop() === "product_owner" || b.base.split(".").pop() === "product_owner");
          if (ap !== bp) return ap ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      const builds = filledArr
        .filter(a => a !== orch && a.name !== CRITIC_AGENT_NAME && groupForAgent(a) === "build")
        .sort((a, b) => a.name.localeCompare(b.name));
      return [orch, critic, ...designs, ...builds].filter(Boolean) as AgentSpec[];
    })();
  const n = Math.max(1, arranged.length);
  const cols = useFourCol ? 4 : Math.ceil(Math.sqrt(n));
  return (
    <div style={{
      width: "100%", height: "100%",
      background: "var(--bg-app)",
      borderLeft: "1px solid var(--border)",
      padding: 8,
      display: "grid",
      gridTemplateColumns: `repeat(${cols}, 1fr)`,
      gridAutoRows: "1fr",
      gap: 8,
      overflow: "hidden",
    }}>
      {arranged.length === 0 && (
        <div style={{
          gridColumn: "1 / -1",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "var(--fg-subtle)", fontSize: 12, padding: 24, textAlign: "center",
        }}>
          No team picked yet. Start a project from the Studio to populate the per-agent chat grid.
        </div>
      )}
      {arranged.map((a, idx) => {
        if (!a) {
          // Empty grid cell — keeps design in cols 3-4 even when build
          // ranks are shorter (or vice versa). No visual; just spacer.
          return <div key={`empty-${idx}`} />;
        }
        const isActive = activeAgents.has(a.name);
        const icon = agentIconRef(a, roleByName, agentIconOverrides);
        const log = agentLogs.get(a.name) ?? [];
        const lastMessages = log.slice(-20);
        // Accent is per-agent (group colour), matching the canvas cards.
        const accent = tileAccentFor(a);
        const ringPx = isActive ? 3 + 3 * pulse : 0;
        const outerPx = isActive ? 14 + 12 * pulse : 0;
        const alphaA = 0.65 + 0.30 * pulse;
        const alphaB = 0.40 + 0.30 * pulse;
        return (
          <AgentChatTile
            key={a.name}
            name={a.name}
            icon={icon}
            messages={lastMessages}
            isActive={isActive}
            isSelected={selectedAgent === a.name}
            accent={accent}
            onClick={() => onSelectAgent(a.name)}
            ringPx={ringPx}
            outerPx={outerPx}
            alphaA={alphaA}
            alphaB={alphaB}
            timing={agentTiming?.get(a.name)}
          />
        );
      })}
    </div>
  );
}

// Single chat-tile in the AgentChatGrid. Pulled out so each tile can
// own its scroll-pin effect — the parent grid would re-fire the effect
// for every other tile otherwise.
function AgentChatTile({
  name, icon, messages,
  isActive, isSelected, accent, onClick,
  ringPx, outerPx, alphaA, alphaB,
  timing,
}: {
  name: string;
  icon: string;
  messages: GoalMsg[];
  isActive: boolean;
  /// This agent's cumulative working time this run (ticks while active).
  timing?: AgentTiming;
  /// True when this agent is the one selected on the left workspace —
  /// drawn with the team-accent ring so the user can see at a glance
  /// which tile maps to the right-pane chat column.
  isSelected: boolean;
  /// Team's category colour (Software=#7ad3ff, Personal=#74a4ff …).
  /// Drives the tile border + LIVE chip + selected-state ring so each
  /// project's tiles carry the team's identity colour.
  accent: string;
  /// Click anywhere on the tile selects this agent in the left
  /// workspace — same effect as clicking the canvas node.
  onClick: () => void;
  ringPx: number;
  outerPx: number;
  alphaA: number;
  alphaB: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useTick(timing?.activeSince != null); // tick this card's clock while it's working
  const elapsedMs = agentElapsedMs(timing);
  const tailSig = `${messages.length}:${messages[messages.length - 1]?.text?.length ?? 0}`;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Auto-scroll to the latest line by default. ONLY suppress
    // while the user is mid-selection inside this container.
    const sel = window.getSelection?.();
    if (sel && !sel.isCollapsed && el.contains(sel.anchorNode)) return;
    el.scrollTop = el.scrollHeight;
  }, [tailSig]);
  const rgb = hexToRgbStr(accent);
  // Only show this agent's own reply lines. The user's "you" turn and
  // any system errors live on the SuperUserCard / OrchestratorPane,
  // not in the per-agent grid (user spec: "they only plot their own
  // reply"). Thoughts / dispatches / tool calls also get filtered out
  // — the tile is the agent's voice, nothing else.
  const replyMessages = useMemo(() => messages.filter(m =>
    m.role !== "you" && m.role !== "system" && !m.kind
  ), [messages]);
  return (
    <div
      title={`Click to view ${displayLabel(name)}'s chat in the workspace pane`}
      onClick={onClick}
      style={{
        minWidth: 0, minHeight: 0,
        // Body fill: was rgba(rgb, 0.06); +10% to 0.16, then +20% to
        // 0.36 per user request "20% less transparent". The team
        // colour now clearly reads through the tile while message text
        // stays legible against the darker bottom of the gradient.
        background: `linear-gradient(180deg, rgba(${rgb},0.36) 0%, rgba(20,23,31,0.95) 100%)`,
        border: isActive
          ? "1px solid rgba(60,242,107,0.85)"
          : isSelected
            ? `1.5px solid rgba(${rgb},0.85)`
            : `1px solid rgba(${rgb},0.40)`,
        borderRadius: 10,
        boxShadow: isActive
          ? `0 0 0 ${ringPx}px rgba(60,242,107,${alphaA}), 0 0 ${outerPx}px rgba(60,242,107,${alphaB})`
          : isSelected
            ? `0 0 0 2px rgba(${rgb},0.45), 0 4px 14px rgba(0,0,0,0.5)`
            : "0 2px 6px rgba(0,0,0,0.4)",
        display: "flex", flexDirection: "column",
        overflow: "hidden",
        cursor: "pointer",
        transition: "border-color 120ms, box-shadow 120ms",
      }}
    >
      {/* Header — small icon + name + (optional) LIVE chip. Identifies
          the tile; this is NOT the sender chip for each message (those
          are stripped per user spec — the tile is one agent's voice,
          its messages are just the body text). Header tint: was black
          rgba(0,0,0,0.25), then bumped to 0.30, now 0.50 with the
          "20 % less transparent" request so the team-colour band is a
          decisive visual identifier instead of a faint wash. */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "6px 10px",
        borderBottom: `1px solid rgba(${rgb},0.55)`,
        background: `rgba(${rgb},0.50)`,
        flexShrink: 0,
      }}>
        <img src={owlSrc(icon)} style={{ width: 22, height: 22, objectFit: "contain" }} />
        <div style={{
          flex: 1, minWidth: 0,
          color: "var(--fg-strong)", fontSize: 12, fontWeight: 700,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{displayLabel(name)}</div>
        {/* Per-agent working time — to the RIGHT of the name. Green while this
            agent is active, muted once it's done; shows cumulative work time. */}
        {elapsedMs > 0 && (
          <span
            title="How long this agent has worked (cumulative)"
            style={{
              fontSize: 10, fontWeight: 700, fontVariantNumeric: "tabular-nums",
              color: timing?.activeSince != null ? "#3cf26b" : "var(--fg-muted)",
              background: "rgba(0,0,0,0.25)", borderRadius: 4, padding: "1px 5px",
              flexShrink: 0,
            }}
          >⏱ {formatDuration(elapsedMs)}</span>
        )}
        {isActive && (
          <span style={{
            color: "#3cf26b", fontSize: 9, fontWeight: 800,
            letterSpacing: 0.6, textTransform: "uppercase",
            background: "rgba(60,242,107,0.12)",
            border: "1px solid rgba(60,242,107,0.50)",
            borderRadius: 4, padding: "1px 5px",
          }}>LIVE</span>
        )}
      </div>
      {/* Log scroll pane — the agent's reply text only, plain pre-wrap
          so mouse-selection survives streaming token updates (the
          previous MarkdownBody renderer rebuilt the DOM per token and
          unhighlighted any drag the user was making). */}
      <div
        ref={scrollRef}
        style={{
          flex: 1, minHeight: 0, overflowY: "auto",
          padding: 10,
          color: "var(--fg)",
          display: "flex", flexDirection: "column", gap: 6,
          fontFamily: "Segoe UI, sans-serif",
          userSelect: "text",
          WebkitUserSelect: "text",
          cursor: "text",
        }}
      >
        {replyMessages.length === 0 ? (
          <div style={{ color: "var(--fg-subtle)", fontStyle: "italic", textAlign: "center", marginTop: 12 }}>
            (no messages yet)
          </div>
        ) : (
          replyMessages.map((m, i) => {
            // Reuse the SAME ChatBubble as the Code page + the Full Chat view —
            // avatar, sender, and timestamp — so the agentic chat isn't a
            // different-looking fork (no date). isStreaming handles the live one.
            const streaming = isActive && i === replyMessages.length - 1;
            const isUser = m.role === "you";
            return (
              <ChatBubble
                key={i}
                avatar={isUser ? "Y" : (m.role || "?").charAt(0).toUpperCase()}
                sender={displayLabel(m.role)}
                accent={isUser ? "#ffd97a" : (m.color ?? "#9ad9ff")}
                isUser={isUser}
                isStreaming={streaming}
                content={m.text}
                ts={m.ts}
              />
            );
          })
        )}
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
function SuperUserCard({ team, roleByName, chat, onSend, sendBusy, autoApprove, onToggleAutoApprove, projectId, directives, onDirectivesChanged, directorMode, onToggleDirectorMode, mode }: {
  team: Team | null;
  roleByName: Map<string, RoleData>;
  chat: GoalMsg[];
  onSend: (text: string) => void;
  sendBusy: boolean;
  autoApprove: boolean;
  onToggleAutoApprove: () => void;
  projectId: string;
  directives: Directive[];
  /// Trigger a re-fetch of the project's rules after an inline add /
  /// edit / delete so the list updates without remounting the card.
  onDirectivesChanged: () => Promise<void> | void;
  directorMode: boolean;
  onToggleDirectorMode: () => void;
  /// Which face of the card to render. The card now lives inside the
  /// right-column `RightColumnTabs`; the "Super User" tab passes
  /// `super` (chat + settings) and the "Rules" tab passes `rules`
  /// (directives list + explanation). The card no longer ships its
  /// own internal Chat/Rules tab strip — that's promoted up to the
  /// right-column-level tabs.
  mode: "super" | "rules";
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
    if (!el) return;
    // Auto-scroll to latest. ONLY suppress mid-selection so the
    // user can highlight to copy. No 'near bottom' gate.
    const sel = window.getSelection?.();
    if (sel && !sel.isCollapsed && el.contains(sel.anchorNode)) return;
    el.scrollTop = el.scrollHeight;
  }, [suTailSig, projectId]);
  const submit = () => {
    if (sendBusy) return;
    const t = draft.trim();
    if (!t) return;
    onSend(t);
    setDraft("");
  };
  // The card used to host its own internal Chat/Rules tab strip; the
  // 2026-05-28 restructure promoted those to right-column-level tabs
  // (RightColumnTabs in AgentsPage). The face to render is now driven
  // by the parent via the `mode` prop. `activeTab` retained as a local
  // alias to minimise downstream churn.
  const activeTab = mode === "rules" ? "rules" : "chat";
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
  // Re-add any built-in best-practice rules the user deleted (no duplicates).
  const restoreDefaults = async () => {
    if (!projectId) return;
    setRulesBusy(true);
    try {
      await invoke<number>("directives_restore_defaults", { projectId });
      await onDirectivesChanged();
    } catch (e) { console.error("directives_restore_defaults failed", e); }
    finally { setRulesBusy(false); }
  };
  return (
    // Width: fills the 450 px overlay column; height: fills the
    // available canvas vertical space (parent passes flex:1) so the
    // card occupies roughly the right ~half of the canvas now that the
    // AgentInfo/TeamInfo cards have been removed below it.
    <div data-ui="SuperUserCard" style={{ flex:1, padding:"10px 12px", borderRadius:12, background:"linear-gradient(135deg, rgba(38,30,10,0.92) 0%, rgba(18,14,4,0.92) 100%)", border:"1px solid rgba(255,200,80,0.35)", width:"100%", minHeight:0, display:"flex", flexDirection:"column", gap:8 }}>
      {/* Header — title strip for the card's current face. The ▦ chat-
          split toggle that used to live here moved to the canvas top-
          right (the "big button" per user spec 2026-05-28). The card
          itself sits inside RightColumnTabs now, so we don't need any
          inner mode switcher; just a clear title. */}
      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
        <div data-ui="suAvatar" style={{ width:28, height:28, borderRadius:16, background:"#2a2410", display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, color:"var(--fg)" }}>{mode === "rules" ? "📋" : "👤"}</div>
        <div style={{ flex:1, minWidth:0 }}>
          <div data-ui="suName" style={{ fontSize:16, fontWeight:700, color: mode === "rules" ? "#ff6b6b" : "var(--fg)", lineHeight:"22px" }}>
            {mode === "rules" ? "Rules" : "Super User"}
          </div>
          <div data-ui="suHint" style={{ fontSize:12, color:"var(--fg-subtle)", letterSpacing:0.4, textTransform:"uppercase", lineHeight:1.4 }}>
            {mode === "rules"
              ? `${directives.length} project rule${directives.length === 1 ? "" : "s"}`
              : chat.length > 0 ? `${chat.length} message${chat.length === 1 ? "" : "s"} in this run` : "idle — team pings you here"}
          </div>
        </div>
      </div>
      {mode === "super" && peekAgents.length > 0 && (
        <div data-ui="suTeamPeek" style={{ display:"flex", alignItems:"center", gap:4, padding:"0 2px" }}>
          {peekAgents.map((a, i) => (
            <img key={i} src={owlSrc(agentIconRef(a, roleByName))} title={displayLabel(a.name)} style={{ width:20, height:20, opacity:0.85, filter:"drop-shadow(0 1px 1px rgba(0,0,0,0.5))" }} />
          ))}
          <div style={{ fontSize:10, color:"var(--fg-subtle)", letterSpacing:0.4, textTransform:"uppercase", marginLeft:4 }}>{team?.agents.length ?? 0} agents on team</div>
        </div>
      )}
      {/* Settings strip — auto-approve + director-mode. Only relevant
          on the "super" face (the user's own controls); hidden on the
          "rules" face because those flags are user-state, not rule-
          state. Sits under the header so it visually parallels the
          Orchestrator / Team tab settings strips per user spec
          2026-05-28. */}
      {mode === "super" && (
        <div data-ui="suSettings" style={{ display:"flex", flexDirection:"column", gap:4, padding:"4px 2px", borderTop:"1px solid rgba(255,200,80,0.15)", borderBottom:"1px solid rgba(255,200,80,0.15)" }}>
          <label style={{ display:"flex", alignItems:"center", gap:6, fontSize:13, color: autoApprove ? "#ff8c8c" : "#7888a8", cursor:"pointer" }}>
            <input type="checkbox" checked={autoApprove} onChange={onToggleAutoApprove} style={{ width:12, height:12, accentColor:"#ff6060" }} />
            <span>auto-approve tool requests</span>
          </label>
          <label style={{ display:"flex", alignItems:"center", gap:6, fontSize:13, color: directorMode ? "#9af0a8" : "#7888a8", cursor:"pointer" }}>
            <input type="checkbox" checked={directorMode} onChange={onToggleDirectorMode} style={{ width:12, height:12, accentColor:"#60ff80" }} />
            <span>director mode (critic stands in for me)</span>
          </label>
        </div>
      )}
      {activeTab === "chat" ? (
        <>
          {/* Sent-by-you log — a read-only view of the user's own
              past messages. The textarea+Send button that used to live
              here was promoted to the Orchestrator pane's bottom dock
              (user spec 2026-05-28: merge the Super User card with
              the chat box). This panel is now purely a record of what
              the user has said; replies appear in the Orchestrator
              Clear Chat tab. */}
          {(() => {
            const sentByMe = lastMessages.filter(m => m.role === "you");
            return (
              <div ref={suChatRef} data-ui="suChat" style={{ flex:1, minHeight:120, background:"rgba(20,16,4,0.6)", color:"var(--fg)", border:"1px solid rgba(255,200,80,0.20)", borderRadius:8, padding:"8px 10px", fontSize:13, lineHeight:1.5, overflow:"auto", display:"flex", flexDirection:"column", gap:6, userSelect:"text", WebkitUserSelect:"text", cursor:"text" }}>
                {sentByMe.length === 0 ? (
                  <div style={{ color:"var(--fg-subtle)", fontStyle:"italic" }}>
                    {team
                      ? "Your sent messages will appear here. Type them in the Orchestrator's User Input dock below."
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
        </>
      ) : (
        // Rules tab — full inline add / edit / delete UI. No more
        // popup modal: the user manages project rules right inside
        // the card (user spec 2026-05-20).
        <div data-ui="suRules" style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {/* Explanation block — three kinds of rule, each with a
              one-line meaning. The closing sentence states the scope:
              every agent on the active team sees every rule, so users
              don't have to wonder whether a rule attached to the
              orchestrator also reaches the specialists. */}
          <div data-ui="suRulesHelp" style={{
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
            <div style={{ color:"var(--fg-muted)", marginTop:2 }}>
              Rules are injected into every agent on the active team
              ({team?.agents.length ?? 0} {team?.agents.length === 1 ? "agent" : "agents"}) — orchestrator, specialists, and the critic all see them on every turn.
            </div>
          </div>
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
            style={{ width:28, height:28, padding:0, borderRadius:6, border:"1px solid var(--border-strong)", background:"#1a2030", color:"var(--fg)", cursor:"pointer", fontSize:14 }}
            title="Close"
          >✕</button>
        </div>

        {/* Add row */}
        <div style={{ display:"flex", gap:6, alignItems:"stretch" }}>
          <select
            value={newKind}
            onChange={e => setNewKind(e.target.value as any)}
            style={{ width:90, padding:"4px 6px", borderRadius:6, border:"1px solid var(--border-strong)", background:"var(--bg-input)", color:"var(--fg)", fontSize:12 }}
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
            style={{ flex:1, padding:"4px 8px", borderRadius:6, border:"1px solid var(--border-strong)", background:"var(--bg-input)", color:"var(--fg)", fontSize:13 }}
          />
          <button
            onClick={submit}
            disabled={busy || !newText.trim()}
            style={{
              padding:"4px 14px", borderRadius:6,
              border:"1px solid var(--accent)",
              background: newText.trim() ? "var(--accent)" : "rgba(var(--accent-rgb),0.25)",
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
                <div key={d.id} style={{ display:"flex", gap:6, alignItems:"flex-start", padding:"6px 8px", borderRadius:6, background:"var(--bg-input)", border:"1px solid var(--border)" }}>
                  {editingId === d.id ? (
                    <>
                      <select
                        value={editKind}
                        onChange={e => setEditKind(e.target.value as any)}
                        style={{ width:80, padding:"2px 4px", borderRadius:4, border:"1px solid var(--border-strong)", background:"var(--bg-input)", color:"var(--fg)", fontSize:11 }}
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
                        style={{ flex:1, padding:"2px 6px", borderRadius:4, border:"1px solid var(--border-strong)", background:"var(--bg-input)", color:"var(--fg)", fontSize:13 }}
                      />
                      <button onClick={saveEdit} disabled={busy} style={{ padding:"2px 8px", fontSize:11, fontWeight:700, borderRadius:4, border:"1px solid var(--accent)", background:"var(--accent)", color:"var(--bg-elevated)", cursor:"pointer" }}>Save</button>
                      <button onClick={() => setEditingId(null)} disabled={busy} style={{ padding:"2px 6px", fontSize:11, borderRadius:4, border:"1px solid var(--border-strong)", background:"#1a2030", color:"var(--fg)", cursor:"pointer" }}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <div style={{ flex:1, fontSize:13, color:"var(--fg)", lineHeight:1.4 }}>{d.text}</div>
                      <button onClick={() => beginEdit(d)} title="Edit" style={{ width:24, height:22, padding:0, fontSize:11, borderRadius:4, border:"1px solid var(--border-strong)", background:"#1a2030", color:"#9aa6c0", cursor:"pointer" }}>✎</button>
                      <button onClick={() => doDelete(d.id)} title="Delete" style={{ width:24, height:22, padding:0, fontSize:11, borderRadius:4, border:"1px solid var(--border-strong)", background:"#1a2030", color:"#ff8c8c", cursor:"pointer" }}>✕</button>
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
  // Orbital halo/arc pulse — ~30fps, but ONLY while agents are active and the
  // window is visible. An idle or backgrounded diagram now animates nothing
  // (the unconditional loop here was the runaway-renderer / freeze cause).
  const arcPhase = useAnimatedPhase(activeAgents.size > 0);

  const LAYER_COLORS = [
    "#f1c44a", "#48d486", "#3aa0ff", "#ee5b5b",
    "#ff9a3a", "#9aa3b2", "#a578ff", "#ff79c4",
  ];

  type RosterRow = { name: string; label: string; iconRef: string; depth: number; active: boolean; group: TeamGroup };
  const roster: RosterRow[] = useMemo(() => {
    if (!team || team.agents.length === 0) return [];
    const depths = computeDepths(team);
    // Exclude the SAME agent the centre hub uses (orchestratorOf), not a
    // hard-coded name==="orchestrator". orchestratorOf matches case-
    // insensitively / by "contains orchestrator" / falls back to agents[0],
    // so a lead named "Orchestrator" (capital) or "Orchi the orchestrator"
    // used to slip past this filter and render TWICE — once as the hub and
    // once as a ring node (the "two orchestrators" bug).
    const orchName = orchestratorOf(team.agents)?.name;
    return team.agents
      // Exclude the orchestrator (rendered at center) AND the synthetic
      // critic (rendered as a peer next to the orchestrator, not on an arc).
      .filter(a => a.name !== orchName && a.name !== CRITIC_AGENT_NAME)
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
  const arc_span = (Math.PI * 2) * (340 / 360);
  // Orchestrator hub size — hoisted up here (was below) so the Critic
  // node can position itself OUTSIDE the hub artwork. The owl image is
  // drawn at orchestrator_r * 1.12 from centre; placing the critic at
  // orchestrator_r * 1.6 puts it clearly past the hub edge.
  const NODE_R = 22;
  // Center hub size. Everything in the hub (owl icon 1.9×, core 1.5×, halo 3×,
  // arcs, the critic peer offset, the label) scales from this, so shrinking it
  // shrinks the whole center cluster. Kept well inside the inner ring (130px),
  // so a smaller hub just opens up breathing room — no overlap.
  const orchestrator_r = Math.max(38, Math.min(w, h) * 0.07);

  // Ring distances are FIXED per layer — NOT stretched to fill the canvas.
  // The old formula sized the gap as (max_radius − inner_offset) / max_depth,
  // so a single-layer team (max_depth = 1) had its one ring flung all the way
  // out to max_radius — i.e. parked at the OUTER (2nd-layer) distance. Now:
  //   • layer 1 always sits at FIRST_RING — just clear of the hub's 3× halo
  //     plus the node's own inward halo, so it reads close to the orchestrator;
  //   • each deeper layer adds a fixed RING_GAP.
  // A team with only one layer therefore uses the layer-1 distance, never the
  // layer-2 one. On a small window we shrink ONLY the gap between deeper layers
  // (never layer 1, so it can't be squeezed into the hub) so the outer ring
  // still fits. d starts at 1.
  const FIRST_RING = Math.min(max_radius, Math.max(190, orchestrator_r * 3.0 + HALO_R * 0.6));
  let RING_GAP = 150;
  if (max_depth > 1) {
    const gapRoom = (max_radius - FIRST_RING) / (max_depth - 1);
    RING_GAP = Math.max(70, Math.min(RING_GAP, gapRoom));
  }
  const ringR = (d: number) => FIRST_RING + (d - 1) * RING_GAP;
  const ring_radii = sortedDepths.map(ringR);

  type Node = { name: string; x: number; y: number; label: string; iconRef: string; active: boolean; depth: number; group: TeamGroup };
  const nodes: Node[] = [];
  for (const depth of sortedDepths) {
    const ringAgents = depthMap.get(depth)!;
    const count = ringAgents.length;
    const r = ringR(depth);
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
  // 1.4 (was 1.6) nudges it a little closer to centre — the hub artwork
  // is now smaller (drawn at orchestrator_r * 0.95), so 1.4 still clears it.
  const criticNode: Node | null = criticSpec ? {
    name: criticSpec.name,
    x: cx + orchestrator_r * 1.4,
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
  const orchSpec = team ? orchestratorOf(team.agents) : null;
  if (orchSpec) nodeByName.set(orchSpec.name, { x: cx, y: cy });
  // Non-trivial routing edges (anything that isn't orchestrator → X,
  // because those are already drawn as star spokes). Drawing them on
  // top of the orbital diagram exposes the real flow without making
  // the picture too busy.
  const orchName = orchSpec?.name;
  // Whether the orchestrator itself is mid-stream. The diagram used to
  // render the central owl as a static image with no active-state
  // change, so the user saw nothing happen when the orchestrator was
  // running (only the orbital specialists carry an active flag). We
  // surface a pulsing ring around the hub when this is true.
  const orchActive = orchName ? activeAgents.has(orchName) : false;
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
      <svg width={w} height={h} style={{ position:"absolute", left:0, top:0, pointerEvents:"none", overflow:"visible" }}>
        <defs>
          <radialGradient id="halo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(var(--accent-rgb),0.85)" />
            <stop offset="45%" stopColor="rgba(var(--accent-rgb),0.35)" />
            <stop offset="100%" stopColor="rgba(var(--accent-rgb),0)" />
          </radialGradient>
          <radialGradient id="haloActive" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(var(--accent-rgb),1)" />
            <stop offset="40%" stopColor="rgba(var(--accent-rgb),0.55)" />
            <stop offset="100%" stopColor="rgba(var(--accent-rgb),0)" />
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
              <stop offset="0%" stopColor="rgba(var(--accent-rgb),0.43)" />
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
          <line key={"sp"+i} x1={cx} y1={cy} x2={n.x} y2={n.y} stroke={n.active?"rgba(var(--accent-rgb),0.55)":`url(#spokeGrad${i})`} strokeWidth={n.active?1.6:1.3} />
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
      {/* Orchestrator active-state ring: pulsing green annulus around
          the central owl. Only rendered while the orchestrator is mid-
          stream, so the user can SEE the orchestrator working — the
          static-image hub previously gave zero visual feedback. */}
      {orchActive && (() => {
        const ringR = orchestrator_r * 1.30;
        const ringPad = 14 + 8 * pulse;
        return (
          <div style={{
            position: "absolute",
            left: cx - ringR - ringPad,
            top:  cy - ringR - ringPad,
            width:  (ringR + ringPad) * 2,
            height: (ringR + ringPad) * 2,
            borderRadius: "50%",
            pointerEvents: "none",
            border: `3px solid rgba(60,242,107,${0.65 + 0.30 * pulse})`,
            boxShadow: `0 0 ${24 + 16 * pulse}px rgba(60,242,107,${0.45 + 0.25 * pulse})`,
            zIndex: 0,
          }} />
        );
      })()}
      <img src={orchSpec ? owlSrc(agentIconRef(orchSpec, roleByName)) : `${ICONS}/owl_agentic.png`} style={{ position:"absolute", left:cx - orchestrator_r * 0.95, top:cy - orchestrator_r * 0.95, width:orchestrator_r * 1.9, height:orchestrator_r * 1.9, objectFit:"contain", pointerEvents:"none", filter: orchActive ? "drop-shadow(0 0 22px rgba(60,242,107,0.85)) drop-shadow(0 0 40px rgba(60,242,107,0.55))" : "drop-shadow(0 0 16px rgba(255,200,100,0.55)) drop-shadow(0 0 28px rgba(255,180,80,0.35))" }} />
      <div style={{ position:"absolute", left:cx-60, top:cy + orchestrator_r * 1.6, width:120, textAlign:"center", fontSize:11, fontWeight:700, color:"#ffd97a", textTransform:"uppercase", letterSpacing:0.8, textShadow:"0 1px 3px rgba(0,0,0,0.9)", pointerEvents:"none" }}>Orchestrator</div>
      {nodes.map((n,i) => {
        const col = LAYER_COLORS[n.depth % LAYER_COLORS.length];
        const pulse = 0.5 + 0.5 * Math.sin((arcPhase * Math.PI) / 180 * 3);
        const glow = n.active ? 12 + 10 * pulse : 4;
        const tint = tintForGroup(n.group);
        const isCritic = n.group === "critic";
        // Visible active-state ring around each specialist node. The
        // drop-shadow alone (4→22 px on the icon) was too subtle against
        // the dark gradient background — users couldn't tell which
        // specialist was streaming. A 3-px green halo with a soft outer
        // glow makes the active node unmistakable.
        const activeRingPad = 5 + 4 * pulse;
        const activeR = NODE_R + 6 + activeRingPad;
        // Critic gets a SHARP rainbow ring around the icon — full
        // opacity, no blur. The previous blurred 0.55-opacity disc
        // disappeared into the background; this version uses a
        // conic-gradient circle masked with a radial-gradient to carve
        // out the centre, leaving a crisp rainbow annulus. Other groups
        // get a semi-transparent tinted disc behind the icon as before.
        const RING_PAD = 9;
        return (
          <React.Fragment key={"node" + i}>
            {n.active && (
              <div style={{
                position: "absolute",
                left: n.x - activeR,
                top:  n.y - activeR,
                width:  activeR * 2,
                height: activeR * 2,
                borderRadius: "50%",
                pointerEvents: "none",
                border: `3px solid rgba(60,242,107,${0.70 + 0.25 * pulse})`,
                boxShadow: `0 0 ${16 + 14 * pulse}px rgba(60,242,107,${0.45 + 0.30 * pulse})`,
                zIndex: 1,
              }} />
            )}
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
                // Icon drawn a touch larger than the NODE_R disc so the
                // agent artwork reads better (overflows the disc slightly).
                left: n.x - (NODE_R + 6),
                top:  n.y - (NODE_R + 6),
                width:  (NODE_R + 6) * 2,
                height: (NODE_R + 6) * 2,
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
            left: cx - orchestrator_r * 0.95,
            top:  cy - orchestrator_r * 0.95,
            width:  orchestrator_r * 1.9,
            height: orchestrator_r * 1.9,
            borderRadius:"50%",
            cursor:"pointer",
            background:"transparent",
            boxShadow: selectedNode === orchSpec.name ? "0 0 0 3px rgba(var(--accent-rgb),0.85)" : "none",
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
            boxShadow: selectedNode === n.name ? "0 0 0 3px rgba(var(--accent-rgb),0.85)" : "none",
          }}
        />
      ))}
      {nodes.length === 0 && (
        <div style={{ position:"absolute", left:cx-180, top:cy + orchestrator_r * 2 + 20, width:360, textAlign:"center", fontSize:12, color:"var(--fg-subtle)", pointerEvents:"none" }}>
          No specialists on this team yet — open project settings (the <b>⚙</b> at the top) to pick a team template, or start a fresh one with <b>+ New</b>.
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
  modelFor,
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
  /// Resolved model id per agent name. Drives the model strip on each
  /// graph card so the user can see at a glance which model each
  /// agent is wired to.
  modelFor: (agentName: string) => string;
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

  // Active-state pulse so the green ring on a streaming node breathes
  // (static 40 %-opacity ring used to be easy to miss against the dark
  // gradient). ~30 fps, gated on activity + visibility — an idle/hidden
  // graph runs no rAF at all (was a permanent 30fps re-render loop).
  const pulsePhase = useAnimatedPhase(activeAgents.size > 0);
  const activePulse = 0.5 + 0.5 * Math.sin((pulsePhase * Math.PI) / 180 * 3);

  const LAYER_COLORS = [
    "#f1c44a", "#48d486", "#3aa0ff", "#ee5b5b",
    "#ff9a3a", "#9aa3b2", "#a578ff", "#ff79c4",
  ];

  // Card geometry — bumped 2026-05-28 to fit a wrapped full name +
  // a per-agent info block (base · temp + resolved model id + short
  // description). Was 130x150 — too tight for the new payload.
  const NODE_W = 200;
  const NODE_H = 230;
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
  const orchName = orchestratorOf(team.agents)?.name ?? team.agents[0].name;

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

  // Cluster bounding regions (Design / Build). Computed ONCE here so the
  // translucent backdrop can be drawn as an SVG <rect> INSIDE the edge svg
  // (before the edges) — SVG document order then guarantees edges paint OVER
  // the backdrop. (Cross-element z-index between an HTML backdrop div and the
  // svg proved unreliable: edges kept hiding behind the cluster boxes.) The
  // labels stay as HTML badges, rendered above.
  const clusterRegions: Array<{ group: TeamGroup; label: string; x: number; y: number; w: number; h: number }> = (() => {
    const byGroup: Record<TeamGroup, GNode[]> = { design: [], build: [], critic: [] };
    for (const n of placed) {
      if (n.name === orchName) continue;
      if (n.name === CRITIC_AGENT_NAME) continue;
      if (n.spec.base === "orchestrator") continue;
      byGroup[groupForAgent(n.spec)].push(n);
    }
    const PAD = 18, LABEL_TOP = 22;
    const out: Array<{ group: TeamGroup; label: string; x: number; y: number; w: number; h: number }> = [];
    const add = (group: TeamGroup, nodes: GNode[], label: string) => {
      if (nodes.length === 0) return;
      const minX = Math.min(...nodes.map(n => n.x)) - PAD;
      const minY = Math.min(...nodes.map(n => n.y)) - PAD - LABEL_TOP;
      const maxX = Math.max(...nodes.map(n => n.x + NODE_W)) + PAD;
      const maxY = Math.max(...nodes.map(n => n.y + NODE_H)) + PAD;
      out.push({ group, label, x: minX, y: minY, w: maxX - minX, h: maxY - minY });
    };
    add("design", byGroup.design, "Design Team");
    add("build", byGroup.build, "Build Team");
    return out;
  })();

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

  // Click a card to VERIFY its real connections: its incident edges + the
  // nodes on the other end light up, everything else dims. This is how you
  // confirm the graph is drawn from the actual team config (graph_json /
  // template) and not invented — selecting design_lead lights up exactly its
  // 5 members + its 1 parent, nothing more.
  const selNeighbors = new Set<string>();
  if (selectedNode) {
    selNeighbors.add(selectedNode);
    for (const e of liveEdges) {
      if (e.source === selectedNode) selNeighbors.add(e.target);
      if (e.target === selectedNode) selNeighbors.add(e.source);
    }
  }

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
  const edgePath = (sName: string, tName: string, s: { x: number; y: number }, t: { x: number; y: number }, bundleShift = 0) => {
    const sP = outPortFor(sName, s);
    const tP = inPortFor(tName, t);
    const sCtl = ctlFor(sP, tP, 0.55);
    const tCtl = ctlFor(tP, sP, 0.55);
    // Fan parallel edges apart laterally (perpendicular to the s→t line) so
    // duplicate source→target pairs don't draw on top of each other.
    if (bundleShift) {
      const dx = tP.x - sP.x, dy = tP.y - sP.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      sCtl.x += nx * bundleShift; sCtl.y += ny * bundleShift;
      tCtl.x += nx * bundleShift; tCtl.y += ny * bundleShift;
    }
    return `M ${sP.x} ${sP.y} C ${sCtl.x} ${sCtl.y}, ${tCtl.x} ${tCtl.y}, ${tP.x} ${tP.y}`;
  };

  // Edges are drawn as clean bottom→top Bezier connectors (edgePath below).
  // We deliberately DON'T run the obstacle-avoiding router here anymore: in a
  // dense tiered layout it swung edges far around the card clusters (and out
  // to the canvas edge via the Manhattan-lane fallback), which read as
  // spaghetti. A gentle curve that may graze a card is far more legible than
  // a giant detour — same approach as the Team Workbench graph. Parallel
  // edges between the same pair get a small lateral fan so they don't overlap.
  const routeOffsets = bundleOffsets(liveEdges);

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
        <svg width={canvasW} height={canvasH} style={{ position:"absolute", left:0, top:0, pointerEvents:"none", zIndex:1, overflow:"visible" }}>
          <defs>
            <marker id="graphArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(var(--accent-rgb),0.85)" />
            </marker>
            <marker id="graphArrowSel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
            </marker>
          </defs>
          {/* Cluster backdrops — drawn FIRST inside the svg so the edges below
              paint over them (was an HTML div that covered the edges). */}
          {clusterRegions.map(r => {
            const t = tintForGroup(r.group);
            return (
              <rect key={"clusterbg-" + r.group} x={r.x} y={r.y} width={r.w} height={r.h} rx={18}
                fill={t.bg} stroke={t.border} strokeWidth={1.5} strokeDasharray="6 4" />
            );
          })}
          {/* Existing edges. Synthetic edges (orchestrator ↔ critical_thinker)
              get a softer dashed style and are NOT clickable — they aren't
              in the project's graph_json, so selecting them for delete/reverse
              would either no-op or corrupt the index mapping for real edges. */}
          {/* Animated flow for ACTIVE dispatch edges (P0-2b): while the
              target agent is running, its inbound edge pulses. */}
          <style>{`@keyframes owllm-edge-flow { to { stroke-dashoffset: -22; } }`}</style>
          {liveEdges.map((e, i) => {
            const s = effective.get(e.source)!;
            const t = effective.get(e.target)!;
            const synthetic = (e as any).synthetic === true;
            const sel = !synthetic && selectedEdgeIdx === i;
            // Clean bottom→top Bezier (with a small fan for parallel edges).
            const d = edgePath(e.source, e.target, s, t, routeOffsets[i]);
            const live = activeAgents.has(e.target) && activeAgents.has(e.source);
            // Node-selection highlight: when a card is selected, only the edges
            // touching it stay bright — the rest fade so its true wiring is
            // unmistakable against a busy graph.
            const incident = selectedNode != null && (e.source === selectedNode || e.target === selectedNode);
            const dimEdge = selectedNode != null && !incident;
            const baseStroke = live ? "#7ff0c5" : sel ? "var(--accent)" : synthetic ? "rgba(200,180,255,0.55)" : "rgba(var(--accent-rgb),0.55)";
            return (
              <g key={"ge"+i} opacity={dimEdge ? 0.08 : 1} style={{ transition: "opacity .15s" }}>
                {!synthetic && (
                  /* Fat invisible hit-target so click is forgiving. */
                  <path
                    d={d}
                    stroke="rgba(0,0,0,0)"
                    strokeWidth={14}
                    fill="none"
                    style={{ pointerEvents:"stroke", cursor:"pointer" }}
                    onClick={(ev) => { ev.stopPropagation(); onSelectEdge(i); onSelectNode(null); }}
                  />
                )}
                <path
                  d={d}
                  stroke={incident ? (synthetic ? "rgba(200,180,255,0.9)" : "var(--accent)") : baseStroke}
                  strokeWidth={incident ? 2.8 : live ? 2.8 : sel ? 2.6 : synthetic ? 1.4 : 1.6}
                  strokeDasharray={live ? "10 6" : synthetic ? "5 4" : undefined}
                  style={live ? { animation: "owllm-edge-flow 0.7s linear infinite" } : undefined}
                  fill="none"
                  markerEnd={sel || incident ? "url(#graphArrowSel)" : "url(#graphArrow)"}
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
                  stroke={drag.over ? "var(--accent)" : "rgba(var(--accent-rgb),0.55)"}
                  strokeWidth={drag.over ? 2.4 : 1.6}
                  strokeDasharray="6 4"
                  fill="none"
                />
                <circle cx={tx} cy={ty} r={6} fill={drag.over ? "var(--accent)" : "rgba(var(--accent-rgb),0.55)"} />
              </g>
            );
          })()}
        </svg>
        {/* Cluster LABEL badges only — the translucent backdrop itself is now
            an SVG <rect> drawn inside the edge svg above (so edges paint over
            it). zIndex 2 keeps the badge above the svg backdrop. */}
        {clusterRegions.map(r => {
          const labelBg = r.group === "design" ? "rgba(64, 168, 96, 0.95)" : "rgba(58, 120, 220, 0.95)";
          return (
            <div key={"cluster-label-" + r.group} data-ui={`Cluster-${r.group}`} style={{
              position: "absolute", left: r.x + 16, top: r.y - 11,
              padding: "2px 10px", background: labelBg, color: "#0a1208",
              fontSize: 11, fontWeight: 800, letterSpacing: 0.7,
              borderRadius: 7, textTransform: "uppercase",
              pointerEvents: "none", zIndex: 2,
            }}>{r.label}</div>
          );
        })}
        {placed.map(n => {
          const isOrch = n.name === orchName;
          const accent = isOrch ? "#ffd76a" : LAYER_COLORS[(n.depth + 1) % LAYER_COLORS.length];
          const sel = selectedNode === n.name;
          // Dim cards not connected to the selected one (verify-connections mode).
          const dimNode = selectedNode != null && !selNeighbors.has(n.name);
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
          // Pulsed shadow size and alpha for the active state — beat at
          // ~1.5 Hz so the user catches it even from peripheral vision.
          const activeRingPx = 4 + 4 * activePulse;
          const activeOuterPx = 18 + 14 * activePulse;
          const activeAlphaA = 0.65 + 0.30 * activePulse;
          const activeAlphaB = 0.40 + 0.30 * activePulse;
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
                // zIndex 2 keeps cards above the edge SVG (zIndex 1), which is
                // itself above the cluster backdrops (zIndex 0) so edges are no
                // longer hidden behind the DESIGN/BUILD TEAM boxes.
                zIndex: 2,
                width: NODE_W, height: NODE_H, borderRadius: 14,
                opacity: dimNode ? 0.3 : 1, transition: "opacity .15s",
                background: baseBg,
                border: `1.8px solid ${borderColor}`,
                boxShadow: isActive
                  ? `0 0 0 ${activeRingPx}px rgba(60,242,107,${activeAlphaA}), 0 0 ${activeOuterPx}px rgba(60,242,107,${activeAlphaB}), 0 6px 22px rgba(0,0,0,0.6)`
                  : sel
                  ? `0 0 0 2px ${accent}55, 0 6px 22px rgba(0,0,0,0.6)`
                  : isDragTarget
                  ? "0 0 0 2px rgba(var(--accent-rgb),0.40), 0 6px 22px rgba(0,0,0,0.6)"
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
              {/* Icon — fixed compact square; the card now also has to
                  fit a 2-line name + a 3-line info block below. */}
              <div style={{ width:78, height:78, display:"flex", alignItems:"center", justifyContent:"center", background:"rgba(255,255,255,0.025)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:10, alignSelf:"center", flexShrink:0 }}>
                <img src={owlSrc(agentIconRef(n.spec, roleByName))} style={{ width:60, height:60, objectFit:"contain" }} />
              </div>
              {/* Full name — wraps to 2 lines (user spec 2026-05-28). */}
              <div style={{
                color:"var(--fg-strong)", fontSize:13, fontWeight:700,
                textAlign:"center", lineHeight:1.2,
                display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical",
                overflow:"hidden", wordBreak:"break-word",
                minHeight:"2.4em",
              }} title={teamMemberLabel(n.name, group)}>
                {teamMemberLabel(n.name, group)}
              </div>
              {isOrch && (
                <div style={{ display:"flex", alignItems:"center", justifyContent:"center" }}>
                  <span style={{ color: accent, background: "rgba(255,215,106,0.12)", border: `1px solid ${accent}55`, borderRadius: 5, padding: "1px 7px", fontSize: 10, letterSpacing: 0.5, fontWeight: 700 }}>LEADER</span>
                </div>
              )}
              {/* Per-agent info — base · default-temp + resolved model
                  id + short description. Replaces the right-column
                  "second line" settings panel. */}
              {(() => {
                const role = roleByName.get(n.spec.base);
                const temp = (role?.defaultTemperature ?? 0.4).toFixed(2);
                const desc = (n.spec.description?.trim() || role?.description?.trim() || "").trim();
                const shortDesc = desc.length > 70 ? desc.slice(0, 67) + "…" : desc;
                const modelId = modelFor(n.name);
                const modelShort = modelId.length > 28 ? modelId.slice(0, 25) + "…" : modelId;
                return (
                  <div style={{ display:"flex", flexDirection:"column", gap:3, marginTop:2, paddingTop:6, borderTop:"1px solid rgba(255,255,255,0.06)" }}>
                    <div style={{ display:"flex", justifyContent:"space-between", gap:6, fontSize:10, color:"var(--fg-muted)", letterSpacing:0.3 }}>
                      <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", textTransform:"capitalize" }} title={n.spec.base}>{n.spec.base}</span>
                      <span style={{ flexShrink:0 }}>· {temp} temp</span>
                    </div>
                    <div style={{ fontSize:10, color:"var(--fg)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }} title={modelId || "(no model)"}>
                      🧠 {modelShort || "(no model)"}
                    </div>
                    {shortDesc && (
                      <div style={{ fontSize:10, color:"var(--fg-subtle)", lineHeight:1.3, display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical", overflow:"hidden" }} title={desc}>
                        {shortDesc}
                      </div>
                    )}
                  </div>
                );
              })()}

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
          a: MarkdownLink,
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

// Render a reply-stream entry. Reuses the SAME shared ChatBubble the
// fine-tuning ChatPage uses, so agentic replies look identical: avatar +
// sender + generating/done indicator + timestamp, markdown when finished,
// plain pre-wrap while streaming. `isStreaming` is the live in-flight
// reply (passed by the caller from supSendBusy && last entry).
function renderReplyEntry(m: GoalMsg, i: number, focus: string, orchName: string | null, isStreaming = false) {
  const isUser = m.role === "you";
  const isOrch = orchName != null && m.role === orchName;
  const accent = isUser ? "#ffd97a" : isOrch ? "#9ad9ff" : m.color;
  const avatar = isUser ? "Y" : (m.role || "?").charAt(0).toUpperCase();
  return (
    <div key={`r-${m.seq ?? i}`}>
      <ChatBubble
        avatar={avatar}
        sender={displayLabel(m.role)}
        accent={accent}
        isUser={isUser}
        // Drive the generating/done indicator off the BUSY state alone,
        // NOT off `!!m.text`. While the model is in its thinking phase the
        // visible reply is still empty, and gating on m.text flipped the
        // bubble to "done" exactly when the model was hardest at work.
        // Empty + streaming renders just the blink cursor, which reads as
        // "working" — correct.
        isStreaming={isStreaming}
        content={m.text}
        ts={m.ts}
      />
      {m.action === "wsl-restart" ? (
        // One-click recovery for a network/DNS failure — runs `wsl --shutdown`
        // for the user (handled by the owllm:wsl-restart listener) so they never
        // touch a terminal. Module-level renderer, so it talks to the component
        // via a window event rather than a prop.
        <button
          data-ui="WslRestartBtn"
          onClick={() => window.dispatchEvent(new CustomEvent("owllm:wsl-restart"))}
          style={{
            marginLeft: 28, marginTop: 6, padding: "5px 12px", fontSize: 12, fontWeight: 700,
            borderRadius: 6, border: "1px solid var(--accent)", background: "rgba(var(--accent-rgb),0.16)",
            color: "var(--accent)", cursor: "pointer",
          }}
        >
          ⟳ Restart WSL networking
        </button>
      ) : null}
    </div>
  );
}

// Render ONE entry of the unified Clear Chat stream so it looks exactly
// like the fine-tuning ChatPage: thinking → collapsible 💭 block, tool /
// tool-result → expandable ToolEventCard (terminal-styled for shell), and
// a normal reply → ChatBubble. Uses the SAME shared components as ChatPage
// (no fork). `isStreaming` marks the live in-flight reply.
function renderUnifiedEntry(m: GoalMsg, i: number, orchName: string | null, isStreaming = false) {
  if (m.kind === "thinking") {
    return <div key={`u-${m.seq ?? i}`}><ThinkingBlock text={m.text} /></div>;
  }
  if (m.kind === "tool") {
    // Agentic tool entries: role is "🛠 <tool>" (call) or "↩ <tool>"
    // (result). Shell-ish calls get the terminal console look, matching
    // ChatPage's terminalish detection. Status is inferred from the
    // result text when present (exit_code / error markers).
    const label = m.role || "Tool call";
    const isTerminal = /shell|bash|command|terminal|powershell|cmd|exec/i.test(label);
    const txt = m.text || "";
    // Prefer the EXPLICIT status the streamers set on a result entry: "↩ error"
    // (the tool's real is_error flag) vs "↩ result" (success). Do NOT infer
    // failure from the result TEXT for normal tools — a grep/read whose output
    // contains "error"/"failed"/"denied" (often because that's what it searched
    // for) was being false-flagged "Failed". The exit_code/traceback text
    // heuristic stays ONLY for shell/terminal output, where it IS the real signal.
    const status: "ok" | "error" | "running" | undefined =
      m.role.startsWith("↩")
        ? (/error|✗/i.test(m.role) ? "error" : "ok")
        : isTerminal && /\b(error|failed|traceback|exit_code:\s*[1-9])/i.test(txt) ? "error"
        : isTerminal && /exit_code:\s*0|completed/i.test(txt) ? "ok"
        : "running";
    return (
      <div key={`u-${m.seq ?? i}`}>
        <ToolEventCard kind={isTerminal ? "terminal" : "tool"} title={label} status={status} content={txt || "…"} />
      </div>
    );
  }
  // dispatch directives + plain replies → normal chat bubble.
  return renderReplyEntry(m, i, "", orchName, isStreaming);
}

// (renderThoughtEntry removed — the Thought / Tool / Full Chat tabs now all go
// through renderUnifiedEntry, which uses the SAME shared ChatBubble /
// ThinkingBlock / ToolEventCard components as the fine-tuning ChatPage. One
// renderer, no per-page fork.)

// ChatInputDock — VS Code Claude Code-style composer (user spec 2026-05-29
// "make the text input like in VS Code here? included functionality and
// droplist of functions"). Replaces the old textarea+Send button row:
//
//   ┌──────────────────────────────────────────────┐
//   │  Queue another message…              🎤      │  ← textarea + mic
//   ├──────────────────────────────────────────────┤
//   │  + /                       ⚡ Auto mode  ▶   │  ← toolbar
//   └──────────────────────────────────────────────┘
//
// Working functionality:
//   * "/" — slash-command droplist. Typing / as the first char (or via
//     the toolbar button) opens a menu of in-app commands. Picking
//     one fires its action (switch sub-tab, clear chat, focus search,
//     etc.) instead of inserting the slash literally.
//   * 🎤 — Web Speech API recognition. Browser-side (WebView2 ships
//     the Edge SpeechRecognition impl on Windows). Toggles on/off;
//     transcribed text streams into the textarea.
//   * ⚡ Auto mode — wires to the project's autoApprove flag. Same
//     toggle previously surfaced on the Super User settings.
//   * +    — attach file. Opens the OS picker; the path is appended
//     to the draft as a markdown link so the user can describe it.
//     Image / audio attachment routing through dispatch.ts comes via
//     the Telegram bridge today; the desktop path is text-only.
//   * Send / Stop — Send when text is present, replaced by a stop
//     square (orange) while the dispatch is in flight. Tomorrow we
//     wire the stop button to an AbortController; for now it just
//     reflects state.
function ChatInputDock({
  draft, setDraft, inputRef, onSend, busy,
  autoApprove, onToggleAutoApprove,
  onSwitchTab,
  needsLoad, loadingModel, onLoadModel,
}: {
  draft: string;
  setDraft: (v: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  onSend: (images: Attachment[]) => void;
  busy: boolean;
  autoApprove: boolean;
  onToggleAutoApprove: () => void;
  onSwitchTab: (tab: "rules"|"userinput"|"reply"|"thought"|"tools"|"full") => void;
  /// True when the team's currently-resolved model is local AND
  /// llama-server isn't already serving it. The send button label
  /// flips to '⚡ Load' so the user knows the first click will
  /// trigger the cold-load. Once load completes the button reverts
  /// to '▶ Send' (next click sends normally).
  needsLoad: boolean;
  /// True while the explicit load-then-send is in flight. Renders a
  /// spinner glyph so the user doesn't double-click.
  loadingModel: boolean;
  /// Called when the button is clicked in 'Load' state. Starts the
  /// server, waits for the model to actually be ready, then dispatches
  /// the draft as a normal send.
  onLoadModel: () => void;
}) {
  // Slash-command catalog. Each command exposes a name (the trigger),
  // a one-line description for the droplist, and an action invoked
  // when picked. Adding a command = one entry here — no plumbing.
  type SlashCmd = {
    name: string;
    description: string;
    action: () => void;
  };
  const slashCommands: SlashCmd[] = useMemo(() => [
    { name: "/rules",     description: "Open the Rules sub-tab (Super User page)", action: () => onSwitchTab("rules") },
    { name: "/input",     description: "Show the User Input history",       action: () => onSwitchTab("userinput") },
    { name: "/thought",   description: "Show the Thought tab",              action: () => onSwitchTab("thought") },
    { name: "/tools",     description: "Show the Tool Calls tab",           action: () => onSwitchTab("tools") },
    { name: "/full",      description: "Show the Full Chat tab",            action: () => onSwitchTab("full") },
    { name: "/bridges",   description: "Open the Bridges configurator",     action: () => window.dispatchEvent(new CustomEvent("owllm:navigate", { detail: { key: "bridges" } })) },
    { name: "/server",    description: "Open the Server modal",             action: () => window.dispatchEvent(new CustomEvent("owllm:navigate", { detail: { key: "server" } })) },
    { name: "/auto",      description: autoApprove ? "Turn Auto mode OFF"   : "Turn Auto mode ON", action: onToggleAutoApprove },
    { name: "/clear",     description: "Clear the draft text",              action: () => setDraft("") },
  ], [autoApprove, onSwitchTab, onToggleAutoApprove, setDraft]);

  // Pasted images for the team chat (parity with the Code + fine-tuning chats).
  // Sent on the next message via onSend(images); cleared after. Same shared
  // fileToImageAttachment + Attachment shape used everywhere.
  const [images, setImages] = useState<Attachment[]>([]);
  const onDockPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter(f => f.type.startsWith("image/"));
    if (files.length === 0) return;
    e.preventDefault();
    files.forEach(async (f) => {
      try { const a = await fileToImageAttachment(f); setImages(x => [...x, a]); }
      catch (err) { console.warn("[agentic chat] image paste failed", err); }
    });
  };

  // Droplist state — open whenever the draft is exactly "/" or starts
  // with "/<token>" (matched against command names). We also open
  // explicitly when the toolbar "/" button is clicked.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const trimmedFirstLine = draft.split("\n")[0] ?? "";
  const slashQuery = trimmedFirstLine.startsWith("/") ? trimmedFirstLine.trim() : "";
  const showPalette = paletteOpen || slashQuery.length > 0;
  const filteredCmds = useMemo(() => {
    if (!showPalette) return [];
    const q = slashQuery.toLowerCase();
    return slashCommands.filter(c =>
      !q || c.name.toLowerCase().startsWith(q) || c.description.toLowerCase().includes(q.slice(1))
    );
  }, [showPalette, slashQuery, slashCommands]);

  const runCommand = (c: SlashCmd) => {
    c.action();
    setDraft("");
    setPaletteOpen(false);
  };

  // Web Speech API — toggle dictation. Only used on the desktop;
  // Telegram path uses the bundled whisper.cpp pipeline already.
  // WebView2 ships SpeechRecognition only when the Edge runtime has
  // it enabled, which is NOT universal — when it's missing we keep
  // the button visible but flash a tooltip via dockNote so the user
  // doesn't think the button is broken.
  const recogRef = useRef<any>(null);
  const [recording, setRecording] = useState(false);
  const [dockNote, setDockNote] = useState<string | null>(null);
  const flashNote = (msg: string) => {
    setDockNote(msg);
    setTimeout(() => setDockNote(null), 3500);
  };
  const toggleMic = () => {
    if (recording) {
      try { recogRef.current?.stop?.(); } catch {}
      setRecording(false);
      return;
    }
    const Ctor = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
    if (!Ctor) {
      flashNote("Mic dictation unavailable in this WebView. Use the Telegram bridge for voice messages.");
      return;
    }
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    const baseline = draft;
    rec.onresult = (ev: any) => {
      let partial = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        partial += ev.results[i][0].transcript;
      }
      setDraft((baseline ? baseline.trimEnd() + " " : "") + partial);
    };
    rec.onend = () => { setRecording(false); };
    rec.onerror = (ev: any) => {
      setRecording(false);
      flashNote(`Mic error: ${ev?.error ?? "unknown"}`);
    };
    try { rec.start(); recogRef.current = rec; setRecording(true); }
    catch (e) {
      flashNote(`Mic start failed: ${String(e)}`);
    }
  };

  // + attach — opens the OS file picker via the rfd-backed Tauri
  // command we already use elsewhere (Browse… on the LocationRow).
  // The desktop dispatch path is text-only today, so we drop the
  // path into the draft as a hint; the orchestrator can read the
  // file via its read_file tool.
  const onAttach = async () => {
    try {
      const path = await invoke<string | null>("pick_file", { title: "Attach a file", filters: null });
      if (path && typeof path === "string") {
        const sep = draft.endsWith("\n") || draft.length === 0 ? "" : "\n";
        setDraft(`${draft}${sep}Attached file: \`${path}\``);
        flashNote(`Attached: ${path.split(/[/\\]/).pop()}`);
      }
    } catch (e) {
      flashNote(`File picker failed: ${String(e)}`);
    }
  };

  // Send / Stop: when idle, send the draft (slash commands run
  // inline). When busy, fire owllm:dispatch-abort which AgentsPage
  // listens for to call .abort() on the active dispatch's
  // AbortController — that cancels every in-flight fetch and the
  // finally{} clears supSendBusy so the dock returns to ready.
  // Previously this branch did nothing on busy, which is what the
  // user mistook for "the stop button crashed the app" — the dock
  // froze with busy stuck on, and the next click looked like a
  // crash.
  const handleSend = () => {
    if (busy) {
      try {
        window.dispatchEvent(new CustomEvent("owllm:dispatch-abort"));
      } catch { /* event dispatch never throws in practice */ }
      return;
    }
    const t = draft.trim();
    if (!t && images.length === 0) return;
    if (t.startsWith("/")) {
      const exact = slashCommands.find(c => c.name.toLowerCase() === t.toLowerCase());
      if (exact) { runCommand(exact); return; }
    }
    // Deterministic local-model path (user spec 2026-05-30): when
    // the team's local llama-server isn't already serving the
    // resolved model, the button is in 'Load' mode. First click
    // boots the server, waits for ready, THEN auto-sends. Once
    // loaded the next click is a plain Send — no more 503 retry
    // dance on the user's first message.
    if (needsLoad) {
      // Park the draft on a window event so AgentsPage can pick it
      // up and auto-send once the model finishes loading. Clear the
      // textarea so the user knows we accepted it.
      try {
        window.dispatchEvent(new CustomEvent("owllm:dock:park-draft", { detail: { text: t } }));
      } catch {}
      setDraft("");
      onLoadModel();
      return;
    }
    onSend(images);
    setImages([]);
  };

  return (
    <div data-ui="UserInputDock" style={{
      borderTop:"1px solid var(--border)",
      padding:"10px 12px 12px",
      background:"var(--bg-elevated)",
      flexShrink:0, minWidth:0, position:"relative",
    }}>
      {showPalette && filteredCmds.length > 0 && (
        <div data-ui="SlashPalette" style={{
          position:"absolute", left:12, right:12, bottom:"calc(100% - 4px)",
          background:"var(--bg-panel)",
          border:"1px solid var(--border-strong)",
          borderRadius:10,
          boxShadow:"0 -8px 30px rgba(0,0,0,0.55)",
          maxHeight:260, overflowY:"auto",
          zIndex:30, padding:"6px 0",
        }}>
          <div style={{ padding:"4px 12px 6px", fontSize:10, color:"var(--fg-muted)", letterSpacing:1, textTransform:"uppercase" }}>
            Slash commands
          </div>
          {filteredCmds.map(c => (
            <button
              key={c.name}
              type="button"
              onClick={() => runCommand(c)}
              style={{
                display:"flex", alignItems:"baseline", gap:10, width:"100%",
                padding:"6px 12px", background:"transparent", border:"none",
                color:"var(--fg)", textAlign:"left", cursor:"pointer", fontSize:12,
              }}
              onMouseEnter={ev => { (ev.currentTarget as HTMLElement).style.background = "var(--bg-surface)"; }}
              onMouseLeave={ev => { (ev.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              <span style={{ fontWeight:700, color:"#ffd97a", fontFamily:"Consolas, monospace" }}>{c.name}</span>
              <span style={{ color:"var(--fg-muted)", fontSize:11 }}>{c.description}</span>
            </button>
          ))}
        </div>
      )}
      <div style={{
        display:"flex", flexDirection:"column",
        background:"var(--bg-surface)",
        border:"1px solid rgba(255,200,80,0.40)",
        borderRadius:12,
        overflow:"hidden",
      }}>
        {images.length > 0 && (
          <div style={{ display:"flex", gap:6, flexWrap:"wrap", padding:"8px 12px 0" }}>
            {images.map((a, i) => (
              <span key={i} style={{ display:"inline-flex", alignItems:"center", gap:6, border:"1px solid rgba(122,162,255,0.35)", background:"rgba(122,162,255,0.12)", color:"#9ad9ff", borderRadius:12, padding:"2px 6px 2px 8px", fontSize:11, fontWeight:700 }}>
                🖼 {a.filename ?? "image"}
                <button onClick={() => setImages(x => x.filter((_, j) => j !== i))} title="Remove" style={{ border:"none", background:"transparent", color:"#9ad9ff", cursor:"pointer", fontSize:13, lineHeight:1, padding:0 }}>×</button>
              </span>
            ))}
          </div>
        )}
        <div style={{ display:"flex", alignItems:"flex-start", padding:"10px 12px 6px", gap:8 }}>
          <textarea
            ref={inputRef}
            data-ui="UserInputArea"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onPaste={onDockPaste}
            onKeyDown={e => {
              if (e.key === "Escape") { setPaletteOpen(false); return; }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Queue another message…"
            rows={1}
            style={{
              flex:1, minWidth:0, minHeight:24, maxHeight:240,
              padding:0,
              background:"transparent",
              color:"var(--fg)",
              border:"none",
              fontSize:13, lineHeight:1.45,
              fontFamily:"Segoe UI, sans-serif",
              resize:"none",
              outline:"none",
              overflowY:"auto",
            }}
          />
          <button
            type="button"
            onClick={toggleMic}
            title={recording ? "Stop dictation" : "Start dictation (Web Speech)"}
            style={{
              flexShrink:0, width:28, height:28,
              background: recording ? "rgba(255,140,140,0.20)" : "transparent",
              border:"none", borderRadius:6,
              color: recording ? "#ff8c8c" : "var(--fg-muted)",
              cursor:"pointer", fontSize:16,
              display:"flex", alignItems:"center", justifyContent:"center",
            }}
          >🎤</button>
        </div>
        {dockNote && (
          <div style={{
            padding:"4px 12px",
            fontSize:11, color:"#ffd97a",
            background:"rgba(255,217,122,0.08)",
            borderTop:"1px solid rgba(255,217,122,0.20)",
          }}>{dockNote}</div>
        )}
        <div style={{
          display:"flex", alignItems:"center", gap:6,
          padding:"4px 8px 8px",
          borderTop:"1px solid rgba(255,255,255,0.04)",
        }}>
          <button
            type="button"
            onClick={onAttach}
            title="Attach a file"
            style={{
              width:28, height:28, background:"transparent",
              border:"1px solid var(--border)", borderRadius:6,
              color:"var(--fg-muted)", cursor:"pointer", fontSize:15,
              display:"flex", alignItems:"center", justifyContent:"center",
            }}
          >+</button>
          <button
            type="button"
            onClick={() => setPaletteOpen(v => !v)}
            title="Slash commands"
            style={{
              width:28, height:28, background: showPalette ? "rgba(255,217,122,0.18)" : "transparent",
              border:"1px solid var(--border)", borderRadius:6,
              color: showPalette ? "#ffd97a" : "var(--fg-muted)", cursor:"pointer", fontSize:13, fontWeight:700,
              display:"flex", alignItems:"center", justifyContent:"center",
            }}
          >/</button>
          <div style={{ flex:1 }} />
          <button
            type="button"
            onClick={onToggleAutoApprove}
            title={autoApprove ? "Auto mode is ON — agents auto-accept tool calls" : "Auto mode is OFF — agents wait for approval"}
            style={{
              height:28, padding:"0 10px",
              display:"flex", alignItems:"center", gap:6,
              background: autoApprove ? "rgba(255,217,122,0.18)" : "transparent",
              border: `1px solid ${autoApprove ? "rgba(255,217,122,0.55)" : "var(--border)"}`,
              borderRadius:6,
              color: autoApprove ? "#ffd97a" : "var(--fg-muted)",
              cursor:"pointer", fontSize:11, fontWeight:600,
            }}
          >
            <span style={{ fontSize:13 }}>⚡</span>
            <span>Auto mode</span>
          </button>
          <button
            type="button"
            onClick={handleSend}
            disabled={!busy && !loadingModel && !draft.trim()}
            title={busy
              ? "Stop the in-flight dispatch"
              : loadingModel
                ? "Loading model into VRAM — click sends as soon as ready"
                : needsLoad
                  ? "First click loads the local model, then auto-sends. Subsequent clicks send immediately."
                  : (draft.trim() ? "Send message" : "Type something to send")}
            style={{
              width: (needsLoad || loadingModel) ? 76 : 32, height:28,
              background: busy ? "#ff8c4a" : loadingModel ? "rgba(255,217,122,0.40)" : needsLoad ? "#3cf26b" : (draft.trim() ? "#ffd97a" : "rgba(255,217,122,0.18)"),
              color: busy ? "#1a0e04" : (loadingModel || needsLoad) ? "#0a1505" : (draft.trim() ? "#1a1404" : "#7d6f4b"),
              border:"1px solid " + (busy ? "#ff8c4a" : needsLoad ? "#3cf26b" : "rgba(255,217,122,0.55)"),
              borderRadius:6,
              cursor: (busy || loadingModel || draft.trim()) ? "pointer" : "not-allowed",
              fontSize: (needsLoad || loadingModel) ? 11 : 14, fontWeight:800,
              display:"flex", alignItems:"center", justifyContent:"center", gap: 4,
            }}
          >
            {busy
              ? "■"
              : loadingModel
                ? <><span>⏳</span><span>Loading</span></>
                : needsLoad
                  ? <><span>⚡</span><span>Load</span></>
                  : "▶"}
          </button>
        </div>
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
  team, isSuperUser,
  projectId, directives, onDirectivesChanged,
  supChat, onSupSend, supSendBusy,
  autoApprove, onToggleAutoApprove,
  needsLoad, loadingModel, onLoadModel,
}: {
  agentLogs: Map<string, GoalMsg[]>;
  agentThoughts: Map<string, GoalMsg[]>;
  runError: string | null;
  serverState: ServerStatus;
  selectedAgent: string | null;
  activeAgent: string | null;
  team: Team | null;
  /// True only on the Super User top page — gates the Rules sub-tab so rules
  /// are visible ONLY there (per user request).
  isSuperUser: boolean;
  /// Project + directives wiring for the Rules sub-tab.
  projectId: string;
  directives: Directive[];
  onDirectivesChanged: () => Promise<void> | void;
  /// Super-User chat — feeds the User Input sub-tab's HISTORY view
  /// (filtered to role="you"). The bottom input dock writes to this
  /// stream via onSupSend.
  supChat: GoalMsg[];
  onSupSend: (text: string, images?: Attachment[]) => void;
  supSendBusy: boolean;
  /// VS Code-style dock's "Auto mode" toggle — wires to the project's
  /// autoApprove flag (drives the dispatch's auto-accept of tool calls).
  autoApprove: boolean;
  onToggleAutoApprove: () => void;
  /// Send-button → Load-button state. True when the team uses a
  /// local model that isn't currently served by llama-server.
  needsLoad: boolean;
  loadingModel: boolean;
  onLoadModel: () => void;
}) {
  // Sub-tab strip. "Clear Chat" (reply) was removed in favour of "Full Chat"
  // as the single chat view (per user request), which is now the default so the
  // whole run is visible at startup. Rules shows ONLY on the Super User page.
  const [activeTab, setActiveTab] = useState<"rules"|"userinput"|"reply"|"thought"|"tools"|"full">("full");
  // Effective (displayed) tab: gracefully fold away tabs that no longer exist
  // or aren't allowed here — the removed "reply" tab, and "rules" when we're not
  // on the Super User page — both fall back to Full Chat. Keeps slash commands
  // and stale state from showing a blank/forbidden pane.
  const effTab = (activeTab === "reply" || (activeTab === "rules" && !isSuperUser)) ? "full" : activeTab;
  // Pick which buffer to show: explicit selection > currently-active
  // agent > orchestrator (so the user sees the plan even if nothing
  // is selected yet) > "you" (which holds the goal echo).
  const orchName = team ? (findOrchestratorSpec(team)?.name ?? null) : null;
  const agentFocus =
    selectedAgent ??
    // Skip the transient Critical-Thinker pre-review so it can't steal the
    // pane: it runs before the orchestrator and ends on its own note, which
    // made the orchestrator's actual answer look missing from the chat column
    // (#29). Click the critic node to inspect it explicitly.
    (activeAgent && activeAgent !== CRITIC_AGENT_NAME ? activeAgent : null) ??
    orchName ??
    "you";
  // The pane only operates in agent mode now. "focus" maps directly
  // to the agentFocus computed above; the model/voice/info section
  // (where mode used to matter) lives in OrchestratorSettings.
  const focus = agentFocus;

  // The main conversation view = the canonical supChat thread. onSupSend AND
  // the Telegram bridge BOTH reliably append the user turn, every agent reply,
  // and any "model produced only tool-call output" notice to supChat. The pane
  // used to read agentLogs[focus], which silently desynced: the orchestrator's
  // reply landed under an agent key the focused view wasn't reading, and when a
  // local model's whole output was stripped tool-junk, agentLogs[orch] stayed
  // empty while the explanatory notice went only to supChat — so a fresh turn
  // looked like it produced NOTHING in the right column (#29/#30). Only an
  // EXPLICIT drill into a specific non-orchestrator specialist shows that
  // agent's private buffer.
  const isSpecialistFocus =
    !!selectedAgent && selectedAgent !== orchName && selectedAgent !== "you";
  const messages = isSpecialistFocus ? (agentLogs.get(focus) ?? []) : supChat;
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
  const thoughtRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const fullRef = useRef<HTMLDivElement>(null);
  // Sticky-scroll gate (user spec): land on the latest message when the view
  // OPENS/switches, but NEVER yank the user back down once they've scrolled UP to
  // read. true = following the bottom (auto-scroll on); false = reading above.
  const pinnedRef = useRef(true);
  const tailSig = (
    `${messages.length}:${messages[messages.length - 1]?.text?.length ?? 0}|` +
    `${thoughts.length}:${thoughts[thoughts.length - 1]?.text?.length ?? 0}|` +
    `${toolCalls.length}:${toolCalls[toolCalls.length - 1]?.text?.length ?? 0}|` +
    `${fullChat.length}:${fullChat[fullChat.length - 1]?.text?.length ?? 0}`
  );
  // OPEN / switch tab or focus → re-pin so the freshly-shown pane jumps to the
  // latest message. Runs before the streaming effect below (declaration order).
  useLayoutEffect(() => { pinnedRef.current = true; }, [effTab, focus]);
  useLayoutEffect(() => {
    if (effTab === "rules" || effTab === "userinput") return; // no log to scroll
    const ref =
      effTab === "thought" ? thoughtRef :
      effTab === "tools"   ? toolsRef   :
                             fullRef;
    const el = ref.current;
    if (!el) return;
    const isSelecting = () => {
      const sel = window.getSelection?.();
      return !!(sel && !sel.isCollapsed && el.contains(sel.anchorNode));
    };
    // Follow the bottom ONLY while pinned (user is near the bottom) and not
    // selecting text. This is the gate the old code deliberately lacked — which
    // is exactly why scrolling up to read got fought by the per-token re-scroll.
    const toBottom = () => { if (pinnedRef.current && !isSelecting()) el.scrollTop = el.scrollHeight; };
    // Track scroll position: leaving the bottom stops following; returning to it
    // resumes. ~48px slack so a near-bottom position still counts as following.
    const onScroll = () => { pinnedRef.current = (el.scrollHeight - el.scrollTop - el.clientHeight) <= 48; };
    el.addEventListener("scroll", onScroll, { passive: true });
    toBottom();
    // Streamed tokens + late-committing markdown/images keep growing the height
    // after this layout pass; a MutationObserver re-follows on every DOM change —
    // but still GATED by pinnedRef, so a user who scrolled up is left alone.
    const mo = new MutationObserver(() => toBottom());
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    const r1 = requestAnimationFrame(toBottom);
    return () => { el.removeEventListener("scroll", onScroll); mo.disconnect(); cancelAnimationFrame(r1); };
  }, [effTab, focus, tailSig]);

  // ---- User-Input dock (bottom of the pane, 2026-05-28 restructure) ----
  // Persistent draft per project (localStorage); auto-resize textarea
  // grows with content up to a max height; Enter sends, Shift+Enter
  // inserts a newline.
  const draftKey = projectId ? `owllm:supdraft:${projectId}` : "";
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  const [draft, setDraftState] = useState<string>(() => {
    if (!draftKey) return "";
    try { return localStorage.getItem(draftKey) ?? ""; } catch { return ""; }
  });
  useEffect(() => {
    if (!draftKey) { setDraftState(""); return; }
    try { setDraftState(localStorage.getItem(draftKey) ?? ""); } catch { setDraftState(""); }
  }, [draftKey]);
  const setDraft = (v: string) => {
    setDraftState(v);
    const k = draftKeyRef.current;
    if (k) { try { localStorage.setItem(k, v); } catch {} }
  };
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Auto-resize: reset to "auto" so the textarea can shrink, then set
  // height to its content's scrollHeight up to a cap. Runs on every
  // draft change so the box grows as the user types.
  useLayoutEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const next = Math.min(ta.scrollHeight, 240);
    ta.style.height = `${Math.max(36, next)}px`;
  }, [draft]);
  const submitInput = (images: Attachment[] = []) => {
    if (supSendBusy) return;
    const t = draft.trim();
    if (!t && images.length === 0) return;
    onSupSend(t, images);
    setDraft("");
  };

  // ---- Rules sub-tab state (inline CRUD, mirrors the SuperUserCard
  // rules tab; the rules surface lives here now per user spec) ----
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
    setEditingId(d.id); setEditText(d.text); setEditKind(d.kind);
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

  // Phase pill moved to OrchestratorSettings (top of RightColumnTabs);
  // this pane is purely the chat container now.

  return (
    <div data-ui="RosterRight" className="selectable-chat" style={{ display:"flex", flexDirection:"column", flex:"1 1 0", minWidth:0, height:"100%", background:"var(--bg-elevated)" }}>
      <div data-ui="OrchestratorLogTabs" style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", padding:"0 0 8px" }}>
        {/* Sub-tab strip — overflowX:auto so a narrow right column
            scrolls horizontally instead of wrapping labels into 2-line
            buttons (user reported this happening when the window was
            smaller than full-screen). flexShrink:0 + whiteSpace:nowrap
            on each button keeps the labels on one line. */}
        <div style={{ display:"flex", alignItems:"center", padding:"0 12px", gap:0, borderBottom:"1px solid var(--border)", flexShrink:0, overflowX:"auto", overflowY:"hidden" }}>
          {([
            // Rules shows ONLY on the Super User page. "Clear Chat" was removed;
            // Full Chat is the single chat view (per user request).
            ...(isSuperUser
              ? [{ id:"rules" as const, label:"📋 Rules", accent:"#ff6b6b", count: directives.length }]
              : []),
            { id:"userinput" as const, label:"✏ User Input",  accent:"#ffd97a",       count: 0                  },
            { id:"full"      as const, label:"📜 Full Chat",  accent:"var(--accent)", count: fullChat.length    },
            { id:"thought"   as const, label:"🧠 Thought",    accent:"#dcb0ff",       count: thoughts.length    },
            { id:"tools"     as const, label:"🛠 Tool Calls", accent:"#7ff0c5",       count: toolCalls.length   },
          ]).map(tab => {
            const active = effTab === tab.id;
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
                  whiteSpace:"nowrap", flexShrink:0,
                  cursor:"pointer",
                }}
              >
                {tab.label}
                {tab.count > 0 ? (
                  <span style={{ fontSize:10, fontWeight:700, opacity:0.7, background:"var(--bg-surface)", borderRadius:8, padding:"1px 6px" }}>{tab.count}</span>
                ) : null}
              </button>
            );
          })}
        </div>
        {/* Rules — first sub-tab; project directives with inline CRUD.
            Mirrors the previous SuperUserCard rules face but lives in
            the chat container per user spec 2026-05-28. */}
        <div data-ui="OrchestratorRulesView" style={{ flex:1, display: effTab ==="rules" ? "flex" : "none", flexDirection:"column", margin:"8px 10px 0", padding:10, gap:8, background:"var(--bg-panel)", border:"1px solid var(--border)", borderRadius:8, overflow:"auto" }}>
          <div style={{ background:"rgba(255,107,107,0.08)", border:"1px solid rgba(255,107,107,0.25)", borderRadius:8, padding:"8px 10px", fontSize:11, lineHeight:1.5, color:"var(--fg)", display:"flex", flexDirection:"column", gap:4 }}>
            <div style={{ fontSize:10, fontWeight:800, letterSpacing:0.8, color:"#ff6b6b", textTransform:"uppercase" }}>About rules</div>
            <div><b style={{ color:"#ff8c8c" }}>MUST</b> — hard requirement; the team should refuse the goal if it can't comply.</div>
            <div><b style={{ color:"#9af0a8" }}>PREFER</b> — soft hint; bias the plan toward this when there's a choice.</div>
            <div><b style={{ color:"#ffd97a" }}>AVOID</b> — anti-pattern; do NOT do this unless the goal is impossible without it.</div>
            <div style={{ color:"var(--fg-muted)", marginTop:2 }}>
              Rules are injected into every agent on the active team
              ({team?.agents.length ?? 0} {team?.agents.length === 1 ? "agent" : "agents"}) — orchestrator, specialists, and the critic all see them on every turn.
            </div>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
            <select
              value={newKind}
              onChange={e => setNewKind(e.target.value as any)}
              disabled={rulesBusy || !projectId}
              style={{ height:28, borderRadius:6, padding:"0 6px", background:"var(--bg-surface)", color:"var(--fg)", border:"1px solid var(--border)", fontSize:11, fontWeight:700 }}
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
              style={{ flex:1, height:28, borderRadius:6, padding:"0 8px", background:"var(--bg-surface)", color:"var(--fg)", border:"1px solid var(--border)", fontSize:13 }}
            />
            <button
              onClick={addRule}
              disabled={rulesBusy || !projectId || !newText.trim()}
              title="Add rule"
              style={{
                width:28, height:28, borderRadius:6,
                border:"1px solid #ff6b6b",
                background: newText.trim() && projectId ? "#ff6b6b" : "rgba(255,107,107,0.25)",
                color: newText.trim() && projectId ? "#1a0a0a" : "#7d4b4b",
                fontSize:16, fontWeight:700,
                cursor: newText.trim() && projectId ? "pointer" : "not-allowed",
              }}
            >+</button>
          </div>
          <div style={{ flex:1, background:"rgba(20,16,16,0.4)", border:"1px solid rgba(255,107,107,0.18)", borderRadius:8, padding:"8px 10px", fontSize:12, color:"var(--fg)", display:"flex", flexDirection:"column", gap:6, overflow:"auto" }}>
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
                          style={{ height:24, borderRadius:4, padding:"0 4px", background:"var(--bg-surface)", color:"var(--fg)", border:"1px solid var(--border)", fontSize:10, fontWeight:700 }}
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
                          style={{ flex:1, height:24, borderRadius:4, padding:"0 6px", background:"var(--bg-surface)", color:"var(--fg)", border:"1px solid var(--border)", fontSize:12 }}
                        />
                      </div>
                      <div style={{ display:"flex", gap:4, justifyContent:"flex-end" }}>
                        <button onClick={() => setEditingId(null)} disabled={rulesBusy} style={{ height:22, padding:"0 8px", borderRadius:4, border:"1px solid var(--border)", background:"transparent", color:"var(--fg-muted)", fontSize:10, cursor:"pointer" }}>Cancel</button>
                        <button onClick={saveEdit} disabled={rulesBusy || !editText.trim()} style={{ height:22, padding:"0 10px", borderRadius:4, border:"1px solid #ff6b6b", background:"#ff6b6b", color:"#1a0a0a", fontSize:10, fontWeight:700, cursor:"pointer" }}>Save</button>
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
        {/* User Input — second sub-tab. HISTORY of the user's own
            messages (filtered to role==="you"). Per user spec
            2026-05-28: "the user input page means that the chat
            history is the user input only. It does not mean the input
            text is available only in that page." So this is a
            read-only log of what the user has sent; new sends happen
            via the bottom dock (UserInputDock) which is always
            visible. */}
        <div data-ui="OrchestratorUserInputView" data-selectall-scope style={{ flex:1, display: effTab ==="userinput" ? "flex" : "none", flexDirection:"column", margin:"8px 10px 0", padding:10, gap:8, background:"var(--bg-panel)", border:"1px solid var(--border)", borderRadius:8, overflow:"auto" }}>
          <div style={{ fontSize:10, fontWeight:800, letterSpacing:0.8, color:"#ffd97a", textTransform:"uppercase" }}>User Input history</div>
          {(() => {
            const sentByMe = supChat.filter(m => m.role === "you");
            if (sentByMe.length === 0) {
              return (
                <div style={{ color:"var(--fg-subtle)", fontStyle:"italic", fontSize:12 }}>
                  Nothing sent yet. Type below in the input dock and
                  press Enter — every message you send to the team
                  will land here as a log.
                </div>
              );
            }
            return (
              <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                {sentByMe.map((m, i) => (
                  <div key={i} style={{
                    background:"rgba(255,217,122,0.06)",
                    border:"1px solid rgba(255,217,122,0.20)",
                    borderRadius:6,
                    padding:"6px 10px",
                    color:"var(--fg)",
                    fontSize:13, lineHeight:1.5,
                    whiteSpace:"pre-wrap",
                    fontFamily:"Segoe UI, sans-serif",
                  }}>
                    {m.ts ? (
                      <div style={{ fontSize:10, color:"var(--fg-subtle)", marginBottom:3, fontVariantNumeric:"tabular-nums" }}>{fmtTime(m.ts)}</div>
                    ) : null}
                    {m.text}
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
        {/* Clear Chat — the unified stream, rendered EXACTLY like the
            fine-tuning chat: thinking (💭 collapsible), tool calls/results
            (expandable cards), and replies (avatar bubbles), interleaved in
            arrival order via the shared ChatBubble / ToolEventCard /
            ThinkingBlock components. */}
        {/* Thought — reasoning + dispatch directives. Tool entries excluded. */}
        <div ref={thoughtRef} data-ui="OrchestratorThoughtView" data-selectall-scope style={{ flex:1, display: effTab ==="thought" ? "flex" : "none", flexDirection:"column", margin:"8px 10px 0", padding:10, gap:6, background:"var(--bg-panel)", border:"1px solid var(--border)", borderRadius:8, overflow:"auto", fontFamily:"Segoe UI, sans-serif", fontSize:13, lineHeight:1.5, color:"var(--fg)", userSelect:"text", WebkitUserSelect:"text", cursor:"text" }}>
          {thoughts.length === 0 ? (
            <div style={{ color:"var(--fg-subtle)", fontSize:11 }}>
              No reasoning yet — the model's thinking blocks land here
              while the team runs.
            </div>
          ) : thoughts.map((t, i) => renderUnifiedEntry(t, i, orchName))}
        </div>
        {/* Tool Calls — every command the agent ran + its result. */}
        <div ref={toolsRef} data-ui="OrchestratorToolsView" data-selectall-scope style={{ flex:1, display: effTab ==="tools" ? "flex" : "none", flexDirection:"column", margin:"8px 10px 0", padding:10, gap:6, background:"var(--bg-panel)", border:"1px solid var(--border)", borderRadius:8, overflow:"auto", fontFamily:"Consolas, 'JetBrains Mono', monospace", fontSize:13, lineHeight:1.45, color:"var(--fg)", userSelect:"text", WebkitUserSelect:"text", cursor:"text" }}>
          {toolCalls.length === 0 ? (
            <div style={{ color:"var(--fg-subtle)", fontSize:11 }}>
              No tool calls yet — every command the agent runs (Bash,
              Read, Write, Edit, etc.) appears here with its arguments
              and the result it returned.
            </div>
          ) : toolCalls.map((t, i) => renderUnifiedEntry(t, i, orchName))}
        </div>
        {/* Full Chat — replies + thoughts + tools, interleaved by arrival. */}
        <div ref={fullRef} data-ui="OrchestratorFullView" data-selectall-scope style={{ flex:1, display: effTab ==="full" ? "flex" : "none", flexDirection:"column", margin:"8px 10px 0", padding:10, gap:8, background:"var(--bg-panel)", border:"1px solid var(--border)", borderRadius:8, overflow:"auto", fontFamily:"Segoe UI, sans-serif", fontSize:13, lineHeight:1.5, color:"var(--fg)", userSelect:"text", WebkitUserSelect:"text", cursor:"text" }}>
          {fullChat.length === 0 ? (
            <div style={{ color:"var(--fg-subtle)", fontSize:11 }}>
              Empty — replies, reasoning, and tool calls will all appear
              here in chronological order once the team runs.
            </div>
          ) : fullChat.map((m, i) =>
            // ONE shared renderer for every entry — thinking → 💭 ThinkingBlock,
            // tool → ToolEventCard, reply → ChatBubble — identical to the
            // fine-tuning ChatPage. No fork. (Same chrono order via `seq`.)
            renderUnifiedEntry(m, i, orchName, supSendBusy && i === fullChat.length - 1)
          )}
        </div>
      </div>
      <ChatInputDock
        draft={draft}
        setDraft={setDraft}
        inputRef={inputRef}
        onSend={submitInput}
        busy={supSendBusy}
        autoApprove={autoApprove}
        onToggleAutoApprove={onToggleAutoApprove}
        onSwitchTab={setActiveTab}
        needsLoad={needsLoad}
        loadingModel={loadingModel}
        onLoadModel={onLoadModel}
      />
    </div>
  );
}

// ---------- RightColumnTabs ----------
// 4-tab wrapper that replaces the standalone OrchestratorPane in the
// right column (user spec 2026-05-28). Each tab is colour-coded:
//   Super User   — yellow #ffd97a  → SuperUserCard mode="super"
//   Orchestrator — blue   #74a4ff  → existing OrchestratorPane
//   Team         — green  #6cd28e  → TeamPanel (inline; description +
//                                    agent grid + team-level model picker)
//   Rules        — red    #ff6b6b  → SuperUserCard mode="rules"
//
// The card's old internal Chat/Rules tab strip is gone; its mode is
// now driven by which top-level tab is open. The SuperUserCard canvas
// overlay is gone too — the card lives entirely inside this column.

// Rules is no longer a top-level tab — the user spec 2026-05-28
// places it as a sub-tab inside the Orchestrator (chat container).
// Three top-level pages remain: Super User (Y), Orchestrator (B),
// Team (G).
type RightTabId = "super" | "orch" | "team";
const RIGHT_TAB_COLOR: Record<RightTabId, string> = {
  super: "#ffd97a",
  orch:  "#74a4ff",
  team:  "#6cd28e",
};
const RIGHT_TAB_BG_ON: Record<RightTabId, string> = {
  super: "rgba(255,217,122,0.18)",
  orch:  "rgba(116,164,255,0.18)",
  team:  "rgba(108,210,142,0.18)",
};
const RIGHT_TAB_LABEL: Record<RightTabId, string> = {
  super: "👤 Super User",
  orch:  "📜 Orchestrator",
  team:  "🏷 Team",
};

function RightColumnTabs(props: {
  team: Team | null;
  roleByName: Map<string, RoleData>;
  supChat: GoalMsg[];
  onSupSend: (text: string, images?: Attachment[]) => void;
  supSendBusy: boolean;
  autoApprove: boolean;
  onToggleAutoApprove: () => void;
  projectId: string;
  directives: Directive[];
  onDirectivesChanged: () => Promise<void> | void;
  directorMode: boolean;
  onToggleDirectorMode: () => void;
  parallelMode: boolean;
  onToggleParallel: () => void;
  agentLogs: Map<string, GoalMsg[]>;
  agentThoughts: Map<string, GoalMsg[]>;
  runError: string | null;
  serverState: ServerStatus;
  selectedAgent: string | null;
  activeAgent: string | null;
  phase: DispatchPhase;
  models: ModelInfo[];
  modelFor: (agentName: string) => string;
  onPickAgentModel: (agentName: string, modelId: string) => void;
  accountsStatus: AccountsStatusLite | null;
  effectiveTeamModel: string;
  onPickTeamModel: (id: string) => void;
  voiceFor: (agentName: string) => VoiceConfig;
  onPickAgentVoice: (agentName: string, partial: Partial<VoiceConfig>) => void;
  ttsVoices: SpeechSynthesisVoice[];
  needsLoad: boolean;
  loadingModel: boolean;
  onLoadModel: () => void;
}) {
  // The 3 top "pages" are small info containers (~20% of available
  // height) per user spec 2026-05-28. They swap above the chat
  // container — which stays put. So the chat is ALWAYS visible no
  // matter which top tab is active.
  const [tab, setTab] = useState<RightTabId>("orch");

  // Dynamic label for the middle (Orchestrator) tab. The pane *is*
  // the generic agent page: when the user clicks the orchestrator
  // node, it reads "Orchestrator"; when they click another agent, it
  // reads that agent's display name. No more second-line title strip
  // below the tabs — the title lives on the tab itself.
  const orchName = props.team ? (findOrchestratorSpec(props.team)?.name ?? null) : null;
  const focusAgent =
    props.selectedAgent ??
    props.activeAgent ??
    orchName ??
    null;
  const orchTabLabel =
    focusAgent && focusAgent !== orchName && focusAgent !== "you" && props.team
      ? `📜 ${displayLabel(focusAgent)}`
      : "📜 Orchestrator";

  return (
    <div data-ui="RightColumnTabs" className="selectable-chat" style={{
      display:"flex", flexDirection:"column", height:"100%",
      background:"var(--bg-elevated)",
    }}>
      {/* Tab strip — 3 small coloured "page selectors". */}
      <div data-ui="RightTabs" style={{
        display:"flex", gap:0,
        borderBottom: `1px solid ${RIGHT_TAB_COLOR[tab]}55`,
        background: `linear-gradient(180deg, ${RIGHT_TAB_COLOR[tab]}10 0%, transparent 100%)`,
        flexShrink:0,
      }}>
        {(["super","orch","team"] as const).map(id => {
          const on = tab === id;
          const c  = RIGHT_TAB_COLOR[id];
          const bg = RIGHT_TAB_BG_ON[id];
          const label = id === "orch" ? orchTabLabel : RIGHT_TAB_LABEL[id];
          return (
            <button
              key={id}
              data-ui={`RightTab-${id}`}
              onClick={() => setTab(id)}
              style={{
                flex:1, height:34, padding:"0 10px",
                background: on ? bg : "transparent",
                color: on ? c : "var(--fg-muted)",
                border:"none",
                borderBottom: on ? `2.5px solid ${c}` : "2.5px solid transparent",
                fontSize:12, fontWeight:700, cursor:"pointer",
                letterSpacing:0.3,
                overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
              }} title={label}>{label}</button>
          );
        })}
      </div>
      {/* Top settings panel — only the Orchestrator face is gone now
          (its per-agent info — Model / Voice / Info — lives on each
          graph card). Super User and Team are project / team scope
          and still belong here. The panel is sized to ~22 % of the
          right column when active; collapses to 0 px when the
          Orchestrator tab is open. */}
      <div data-ui="RightSettingsPanel" style={{
        flex:"0 0 auto",
        maxHeight:"22%",
        // Natural height (no forced minHeight) so Team + Orch panels
        // hug their 2-row content. The old 120 px minimum on Team
        // produced a visible empty gap below the voice row that the
        // Orch panel didn't have, breaking the symmetric look.
        minHeight: 0,
        overflow:"auto",
        // Orch + Team get matching padding so the model/voice rows sit
        // identically on both tabs (used to be 0 on Orch because the
        // pane rendered nothing; now it has content too).
        padding: tab === "super" ? "8px 12px" : "8px 12px",
        borderBottom: "1px solid var(--border)",
        background:"var(--bg-elevated)",
      }}>
        {tab === "super" && (
          <SuperUserSettings
            autoApprove={props.autoApprove}
            onToggleAutoApprove={props.onToggleAutoApprove}
            directorMode={props.directorMode}
            onToggleDirectorMode={props.onToggleDirectorMode}
            parallelMode={props.parallelMode}
            onToggleParallel={props.onToggleParallel}
            team={props.team}
            roleByName={props.roleByName}
          />
        )}
        {tab === "team" && (
          <TeamSettings
            team={props.team}
            models={props.models}
            effectiveTeamModel={props.effectiveTeamModel}
            onPickTeamModel={props.onPickTeamModel}
            serverModelId={props.serverState.model_id}
            accountsStatus={props.accountsStatus}
            voiceFor={props.voiceFor}
            onPickAgentVoice={props.onPickAgentVoice}
            voices={props.ttsVoices}
          />
        )}
        {tab === "orch" && (
          // Per user spec 2026-05-29: the Orchestrator/agent tab mirrors
          // the Team tab — two rows: model picker + voice picker. The
          // focus agent is whatever the user has selected (or the
          // orchestrator by default), and the model + voice apply to
          // that agent specifically.
          <OrchAgentSettings
            team={props.team}
            selectedAgent={props.selectedAgent}
            activeAgent={props.activeAgent}
            models={props.models}
            modelFor={props.modelFor}
            onPickAgentModel={props.onPickAgentModel}
            accountsStatus={props.accountsStatus}
            effectiveTeamModel={props.effectiveTeamModel}
            serverState={props.serverState}
            voiceFor={props.voiceFor}
            onPickAgentVoice={props.onPickAgentVoice}
            voices={props.ttsVoices}
          />
        )}
      </div>
      {/* Chat container — ALWAYS visible. Sub-tabs Rules | User Input |
          Clear Chat | Thought | Tool Calls | Full Chat. Does NOT swap
          when the top tab changes. */}
      <div data-ui="RightChatHost" className="selectable-chat" style={{ flex:1, minHeight:0, display:"flex", overflow:"hidden" }}>
        <OrchestratorPane
          agentLogs={props.agentLogs}
          agentThoughts={props.agentThoughts}
          runError={props.runError}
          serverState={props.serverState}
          selectedAgent={props.selectedAgent}
          activeAgent={props.activeAgent}
          team={props.team}
          isSuperUser={tab === "super"}
          projectId={props.projectId}
          directives={props.directives}
          onDirectivesChanged={props.onDirectivesChanged}
          supChat={props.supChat}
          onSupSend={props.onSupSend}
          supSendBusy={props.supSendBusy}
          autoApprove={props.autoApprove}
          onToggleAutoApprove={props.onToggleAutoApprove}
          needsLoad={props.needsLoad}
          loadingModel={props.loadingModel}
          onLoadModel={props.onLoadModel}
        />
      </div>
    </div>
  );
}

// ---------- SuperUserSettings ----------
// Compact yellow info container for the Super User top tab. Shows the
// avatar + auto-approve + director-mode controls. Sized to ~18% of
// the right column's available height.
function SuperUserSettings({
  autoApprove, onToggleAutoApprove,
  directorMode, onToggleDirectorMode,
  parallelMode, onToggleParallel,
  team, roleByName,
}: {
  autoApprove: boolean;
  onToggleAutoApprove: () => void;
  directorMode: boolean;
  onToggleDirectorMode: () => void;
  parallelMode: boolean;
  onToggleParallel: () => void;
  team: Team | null;
  roleByName: Map<string, RoleData>;
}) {
  const peekAgents = (team?.agents ?? []).slice(0, 6);
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
        <div style={{ width:28, height:28, borderRadius:16, background:"#2a2410", display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, color:"var(--fg)" }}>👤</div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:14, fontWeight:700, color:"#ffd97a", lineHeight:"18px" }}>Super User</div>
          <div style={{ fontSize:10, color:"var(--fg-subtle)", letterSpacing:0.4, textTransform:"uppercase" }}>
            {team?.agents.length ?? 0} agents on team
          </div>
        </div>
        {peekAgents.length > 0 && (
          <div style={{ display:"flex", alignItems:"center", gap:4 }}>
            {peekAgents.map((a, i) => (
              <img key={i} src={owlSrc(agentIconRef(a, roleByName))} title={displayLabel(a.name)} style={{ width:18, height:18, opacity:0.85 }} />
            ))}
          </div>
        )}
      </div>
      <label style={{ display:"flex", alignItems:"center", gap:6, fontSize:12, color: autoApprove ? "#ff8c8c" : "#7888a8", cursor:"pointer" }}>
        <input type="checkbox" checked={autoApprove} onChange={onToggleAutoApprove} style={{ width:12, height:12, accentColor:"#ff6060" }} />
        <span>auto-approve tool requests</span>
      </label>
      {/* The ONE critic-authority control (formerly two: "director mode" +
          "critic = super user" — merged per user, they meant the same thing).
          OFF (default): the Critical Thinker is advisory — it reviews in bounded
          loops but can NEVER block the team (so a guarded critic can't stall a
          Red-Team run). ON: it is the Super User and decides in your place —
          answers the orchestrator's mid-run decisions AND approves/rejects the
          plan + final answer, with higher (still capped) round limits. Backed by
          the director_mode flag, which already drives the "answer my decisions"
          prompt block. */}
      <label style={{ display:"flex", alignItems:"flex-start", gap:6, fontSize:12, color: directorMode ? "#ffb3e6" : "#7888a8", cursor:"pointer" }}>
        <input type="checkbox" checked={directorMode} onChange={onToggleDirectorMode} style={{ width:12, height:12, marginTop:2, accentColor:"#ff79d2" }} />
        <span>critic = super user (decides for me)
          <span style={{ display:"block", fontSize:10, color:"var(--fg-subtle)", lineHeight:"13px" }}>
            {directorMode ? "answers my decisions + approves/rejects the plan + answer" : "off: advisory only — never blocks the team"}
          </span>
        </span>
      </label>
      {/* Parallel dispatch — lets the orchestrator fan out INDEPENDENT tasks in
          one turn; the team already runs them concurrently in isolated worktrees. */}
      <label style={{ display:"flex", alignItems:"flex-start", gap:6, fontSize:12, color: parallelMode ? "#7fd4ff" : "#7888a8", cursor:"pointer" }}>
        <input type="checkbox" checked={parallelMode} onChange={onToggleParallel} style={{ width:12, height:12, marginTop:2, accentColor:"#3aa0ff" }} />
        <span>parallel dispatch (run independent agents at once)
          <span style={{ display:"block", fontSize:10, color:"var(--fg-subtle)", lineHeight:"13px" }}>
            {parallelMode ? "orchestrator batches independent tasks into one wave" : "off: one task at a time (sequential)"}
          </span>
        </span>
      </label>
    </div>
  );
}

// ---------- AgentVoiceRow ----------
// Compact TTS row inside OrchestratorSettings — mirrors the
// _AgentVoiceRow Qt widget from python-app/desktop_app/pages/agents_page.py:172.
// Renders: 🔊 enabled checkbox · voice <select> · rate number · ▶ preview.
// All four are bound to the parent's per-agent VoiceConfig via
// onChange(partial). When `disabled` is true (focus is "you" or
// "system") the controls grey out but still render so the row
// doesn't pop in/out as the user clicks around the canvas.
function AgentVoiceRow({
  agent, cfg, voices, onChange, disabled,
}: {
  agent: string;
  cfg: VoiceConfig;
  voices: SpeechSynthesisVoice[];
  onChange: (partial: Partial<VoiceConfig>) => void;
  disabled: boolean;
}) {
  const noVoices = voices.length === 0;
  const effectiveDisabled = disabled || noVoices;
  const ctlBg = "var(--bg-surface)";
  const ctlBase = {
    background: ctlBg, color: "var(--fg)", border: "1px solid var(--border)",
    borderRadius: 6, fontSize: 11,
  } as const;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 10, color: "var(--fg-muted)", letterSpacing: 0.6, textTransform: "uppercase", width: 44 }}>Voice</span>
      <input
        type="checkbox"
        checked={cfg.enabled}
        disabled={effectiveDisabled}
        onChange={(e) => onChange({ enabled: e.target.checked })}
        style={{ width: 12, height: 12, accentColor: "var(--accent)" }}
        title={noVoices ? "No TTS voices installed on this system" : "Speak this agent's replies aloud"}
      />
      <select
        value={cfg.voiceURI}
        disabled={effectiveDisabled}
        onChange={(e) => onChange({ voiceURI: e.target.value })}
        style={{ ...ctlBase, flex: 1, height: 24, padding: "0 8px", textAlign: "left" }}
        title="Pick a voice"
      >
        <option value="">Auto voice</option>
        {voices.map(v => (
          <option key={v.voiceURI} value={v.voiceURI}>
            {v.name}{v.lang ? ` · ${v.lang}` : ""}
          </option>
        ))}
      </select>
      <input
        type="number"
        min={0}
        max={400}
        step={10}
        value={cfg.rate}
        disabled={effectiveDisabled}
        onChange={(e) => onChange({ rate: Number(e.target.value) || 0 })}
        style={{ ...ctlBase, width: 58, height: 24, padding: "0 6px" }}
        title="Speaking rate (words per minute, 0 = default)"
      />
      <button
        type="button"
        disabled={noVoices}
        onClick={() => ttsPreview(cfg, agent)}
        style={{ ...ctlBase, width: 24, height: 24, padding: 0, cursor: noVoices ? "default" : "pointer" }}
        title={noVoices ? "Install a system voice to enable preview" : "Preview this voice"}
      >▶</button>
    </div>
  );
}

// ---------- OrchestratorSettings ----------
// Compact blue info container for the Orchestrator (or focused agent)
// top tab. Model picker + Voice + Info description. The selected
// agent's name lives in the tab label itself, not here — so there's
// no duplicate title strip.
function OrchestratorSettings({
  team, roleByName, selectedAgent, activeAgent,
  models, modelFor, onPickAgentModel, accountsStatus,
  effectiveTeamModel, serverState, phase,
  voiceFor, onPickAgentVoice, voices,
}: {
  team: Team | null;
  roleByName: Map<string, RoleData>;
  selectedAgent: string | null;
  activeAgent: string | null;
  models: ModelInfo[];
  modelFor: (agentName: string) => string;
  onPickAgentModel: (agentName: string, modelId: string) => void;
  accountsStatus: AccountsStatusLite | null;
  effectiveTeamModel: string;
  serverState: ServerStatus;
  phase: DispatchPhase;
  voiceFor: (agentName: string) => VoiceConfig;
  onPickAgentVoice: (agentName: string, partial: Partial<VoiceConfig>) => void;
  voices: SpeechSynthesisVoice[];
}) {
  const orchName = team ? (findOrchestratorSpec(team)?.name ?? null) : null;
  const focus = selectedAgent ?? activeAgent ?? orchName ?? "you";
  const focusSpec = team?.agents.find(a => a.name === focus) ?? null;
  const focusRole = focusSpec ? roleByName.get(focusSpec.base) : null;
  const focusDescription = focusSpec
    ? ((focusSpec.description && focusSpec.description.trim()) ||
       (focusRole?.description && focusRole.description.trim()) ||
       "No description provided.")
    : "";
  const focusTint = focusSpec ? tintForGroup(groupForAgent(focusSpec)) : null;
  const focusModel = modelFor(focus);

  const phaseColor = phase === "idle" || phase === "done" ? "#7d8595"
    : phase === "planning" ? "#ffd97a"
    : phase === "dispatching" ? "#3cf26b"
    : "#c08aff";
  const phaseText = phase === "idle" ? "Idle"
    : phase === "planning" ? "Planning…"
    : phase === "dispatching" ? `Dispatching${activeAgent ? `: ${displayLabel(activeAgent)}` : ""}`
    : phase === "integrating" ? "Integrating…"
    : "Done";

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
      {/* Phase pill — top-right of the panel since the tab itself
          shows the focus identity. */}
      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
        <div style={{ flex:1, minWidth:0, fontSize:10, color:"var(--fg-muted)", letterSpacing:0.6, textTransform:"uppercase" }}>
          Agent settings · {focus === "you" ? "no focus" : focusSpec ? `${focusSpec.base} base · ${(focusRole?.defaultTemperature ?? 0.4).toFixed(2)} temp` : "—"}
        </div>
        <span style={{
          fontSize:10, fontWeight:700, letterSpacing:0.6, textTransform:"uppercase",
          color: phaseColor, background: `${phaseColor}22`,
          border: `1px solid ${phaseColor}55`,
          borderRadius:999, padding:"2px 8px", whiteSpace:"nowrap",
        }}>{phaseText}</span>
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
        <span style={{ fontSize:10, color:"var(--fg-muted)", letterSpacing:0.6, textTransform:"uppercase", width:44 }}>Model</span>
        <ModelPicker
          value={focusModel}
          onChange={(id) => onPickAgentModel(focus, id)}
          models={models}
          status={accountsStatus}
          disabled={focus === "you" || focus === "system"}
          fallbackLabel={
            effectiveTeamModel
              ? `(use team model · ${effectiveTeamModel})`
              : serverState.model_id
                ? `(use team / server model · ${serverState.model_id})`
                : "(use team / server model — none running)"
          }
        />
      </div>
      <AgentVoiceRow
        agent={focus}
        cfg={voiceFor(focus)}
        voices={voices}
        onChange={(partial) => onPickAgentVoice(focus, partial)}
        disabled={focus === "you" || focus === "system"}
      />
      <div style={{
        background: focusTint ? `linear-gradient(135deg, ${focusTint.bg} 0%, rgba(18,22,34,0.85) 100%)` : "var(--bg-surface)",
        border: focusTint ? `1px solid ${focusTint.border}` : "1px solid var(--border)",
        borderRadius:6, padding:"6px 8px",
        fontSize:11, color:"var(--fg)", lineHeight:1.4,
      }}>
        {focusDescription
          ? (focusDescription.length > 180 ? focusDescription.slice(0, 177) + "…" : focusDescription)
          : <span style={{ color:"var(--fg-subtle)", fontStyle:"italic" }}>Click an agent on the canvas to see its info here.</span>}
      </div>
    </div>
  );
}

// ---------- TeamSettings ----------
// Compact green info container for the Team top tab. Team identity +
// team-wide model picker.
// OrchAgentSettings — minimal two-row settings panel for the
// Orchestrator tab. Same shape as TeamSettings (model + voice), but
// scoped to whichever agent the user has focused on the canvas.
// Tab label is handled in RightColumnTabs (it flips to the focus
// agent's display name when an agent other than the orchestrator
// is selected).
function OrchAgentSettings({
  team, selectedAgent, activeAgent,
  models, modelFor, onPickAgentModel, accountsStatus,
  effectiveTeamModel, serverState,
  voiceFor, onPickAgentVoice, voices,
}: {
  team: Team | null;
  selectedAgent: string | null;
  activeAgent: string | null;
  models: ModelInfo[];
  modelFor: (agentName: string) => string;
  onPickAgentModel: (agentName: string, modelId: string) => void;
  accountsStatus: AccountsStatusLite | null;
  effectiveTeamModel: string;
  serverState: ServerStatus;
  voiceFor: (agentName: string) => VoiceConfig;
  onPickAgentVoice: (agentName: string, partial: Partial<VoiceConfig>) => void;
  voices: SpeechSynthesisVoice[];
}) {
  const orchName = team ? (findOrchestratorSpec(team)?.name ?? null) : null;
  const focus = selectedAgent ?? activeAgent ?? orchName ?? "you";
  const disabled = focus === "you" || focus === "system";
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
        <span style={{ fontSize:10, color:"var(--fg-muted)", letterSpacing:0.6, textTransform:"uppercase", width:74 }}>Model</span>
        <ModelPicker
          value={modelFor(focus)}
          onChange={(id) => onPickAgentModel(focus, id)}
          models={models}
          status={accountsStatus}
          disabled={disabled}
          fallbackLabel={
            effectiveTeamModel
              ? `(use team model · ${effectiveTeamModel})`
              : serverState.model_id
                ? `(use team / server model · ${serverState.model_id})`
                : "(use team / server model — none running)"
          }
        />
      </div>
      <AgentVoiceRow
        agent={focus}
        cfg={voiceFor(focus)}
        voices={voices}
        onChange={(partial) => onPickAgentVoice(focus, partial)}
        disabled={disabled}
      />
      {/* Skills are NOT selected here. They are associated with the AGENT
          itself (Studio → Agents → the agent's 📚 Skills checklist, or a
          team's Workbench). At dispatch the runtime gives each agent its
          associated skills and loads only the ones a task needs (progressive
          disclosure) — the user doesn't hand-pick skills per chat. */}
    </div>
  );
}

function TeamSettings({
  team, models, effectiveTeamModel, onPickTeamModel,
  serverModelId, accountsStatus,
  voiceFor, onPickAgentVoice, voices,
}: {
  team: Team | null;
  models: ModelInfo[];
  effectiveTeamModel: string;
  onPickTeamModel: (id: string) => void;
  serverModelId: string | null;
  accountsStatus: AccountsStatusLite | null;
  voiceFor: (agentName: string) => VoiceConfig;
  onPickAgentVoice: (agentName: string, partial: Partial<VoiceConfig>) => void;
  voices: SpeechSynthesisVoice[];
}) {
  if (!team) {
    return (
      <div style={{ fontSize:11, color:"var(--fg-subtle)", fontStyle:"italic" }}>
        Pick a project on the strip up top, or load a team template.
      </div>
    );
  }
  // Per user spec 2026-05-29: this panel keeps ONLY the team model
  // selection + a team voice selection. Identity header, description,
  // and category/agent/connection counts are dropped (the project strip
  // up top already shows the project name; users objected to the
  // duplication). Team voice piggybacks on the orchestrator's voice —
  // the orchestrator is the agent that addresses the user, so its
  // voice IS the team's voice for TTS purposes.
  const orchName = findOrchestratorSpec(team)?.name ?? "orchestrator";
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
        <span style={{ fontSize:10, color:"var(--fg-muted)", letterSpacing:0.6, textTransform:"uppercase", width:74 }}>Team model</span>
        <ModelPicker
          value={effectiveTeamModel}
          onChange={onPickTeamModel}
          models={models}
          status={accountsStatus}
          fallbackLabel={serverModelId ? `(use server model · ${serverModelId})` : "(no server model running)"}
        />
      </div>
      <AgentVoiceRow
        agent={orchName}
        cfg={voiceFor(orchName)}
        voices={voices}
        onChange={(partial) => onPickAgentVoice(orchName, partial)}
        disabled={false}
      />
    </div>
  );
}

// TeamPanel — minimal two-row settings panel for the right-column
// "Team" tab. Per user spec 2026-05-29, EVERYTHING except the Team
// Model selection has been stripped from this panel and a Voice
// selection row added below. The agent panel (OrchestratorSettings)
// mirrors the same two-row layout so both tabs feel symmetric. Identity
// header / description / agent-roster grid are gone — the strip up top
// already shows the project name; users don't need it duplicated here.
function TeamPanel({
  team, models, effectiveTeamModel, onPickTeamModel,
  serverModelId, accountsStatus,
  voiceFor, onPickAgentVoice, voices,
}: {
  team: Team | null;
  roleByName: Map<string, RoleData>;
  models: ModelInfo[];
  effectiveTeamModel: string;
  onPickTeamModel: (id: string) => void;
  serverModelId: string | null;
  accountsStatus: AccountsStatusLite | null;
  voiceFor: (agentName: string) => VoiceConfig;
  onPickAgentVoice: (agentName: string, partial: Partial<VoiceConfig>) => void;
  voices: SpeechSynthesisVoice[];
}) {
  if (!team) {
    return (
      <div style={{ flex:1, padding:24, color:"var(--fg-subtle)", fontSize:12, display:"flex", alignItems:"center", justifyContent:"center", textAlign:"center" }}>
        Pick a project on the strip up top, or click <b style={{ margin:"0 4px" }}>Team…</b> to load a template.
      </div>
    );
  }
  // Team-wide voice is wired to the orchestrator's voice — the
  // orchestrator is the agent that addresses the user directly, so its
  // voice IS the team's voice as far as TTS playback is concerned.
  const orchName = findOrchestratorSpec(team)?.name ?? "orchestrator";
  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", padding:"10px 12px", gap:8, overflow:"auto" }}>
      <div data-ui="teamSettings" style={{
        display:"flex", flexDirection:"column", gap:8,
        padding:"8px 10px",
        background:"rgba(108,210,142,0.06)",
        border:"1px solid rgba(108,210,142,0.30)",
        borderRadius:10,
      }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontSize:10, color:"var(--fg-muted)", letterSpacing:0.6, textTransform:"uppercase", width:74 }}>Team model</span>
          <ModelPicker
            value={effectiveTeamModel}
            onChange={onPickTeamModel}
            models={models}
            status={accountsStatus}
            fallbackLabel={serverModelId ? `(use server model · ${serverModelId})` : "(no server model running)"}
          />
        </div>
        <AgentVoiceRow
          agent={orchName}
          cfg={voiceFor(orchName)}
          voices={voices}
          onChange={(partial) => onPickAgentVoice(orchName, partial)}
          disabled={false}
        />
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

// Planner/reviewer roles (orchestrator + critic) are READ-ONLY: they
// investigate local context and advise; they never write / edit / shell.
// On the local GGUF path the tool array is otherwise unrestricted —
// formatToolsForOpenAI treats `undefined` as "every tool", so the
// orchestrator was handed write_file_with_diff and called it ITSELF instead
// of dispatching, dead-ending the run (a tool reply has no @agent: lines).
// Scope: LOCAL read tools only — NO web_search/web_fetch. Web research is a
// specialist's job; listing those tools made the orchestrator try to
// "@web_search:" dispatch them as if they were teammates. Specialists keep
// the full tool set.
const READONLY_LOCAL_TOOLS: string[] = [
  "read_file", "list_dir", "grep", "glob",
];

// Weak local models routinely emit a dispatch line for a TOOL — "@read_file:",
// "@web_search:" — instead of either calling the tool or naming a teammate.
// The orchestrator already owns those tools, so such lines are noise: drop any
// @name that is a known tool so it neither runs nor spams "names no agent on
// this team" / burns a correction round. The real specialist dispatches survive.
const DISPATCH_TOOL_NAMES = new Set(LOCAL_TOOL_SPECS.map((t) => t.name));

function needsCriticalThinkerReview(text: string): boolean {
  // `critical[\s_]+thinker` covers "critical thinker", "critical_thinker"
  // and "@critical_thinker" — the underscore is a word char, so the
  // previous `\bcritical\s+thinker\b` rejected the very form users
  // were typing to explicitly invoke the agent.
  // Only an EXPLICIT mention pulls in the Critical Thinker. The old broad
  // keyword list (api, schema, runtime, workflow, decision, mcp, …) fired on
  // ordinary requests, so the critic pre-empted the orchestrator and the
  // user's message looked "forwarded to the critic instead of the
  // orchestrator" (#29). The critic stays opt-in; say "critic"/"critical
  // thinker" (or @critical_thinker) to bring it in.
  return /\b(critical[\s_]+thinker|critic)\b/i.test(text);
}
function buildCriticalThinkerReviewPrompt(team: Team | null, directives?: Directive[]): string {
  const directivesBlock = formatDirectivesBlock(directives);
  return [
    `You are Critical Thinker${team ? ` for the '${team.display}' team` : ""}.`,
    "",
    "You are a separate reviewer agent, not a mood and not the orchestrator.",
    "Your DEFAULT is YES. Treat the user's intent and the orchestrator's plan as the chosen direction and help SHIP it. The question is never 'should we do this?' — it's 'what is the sharpest way to do EXACTLY this?'",
    "Embrace the goal first, then optimize it: tighten the approach, surface a hidden assumption, or offer a simpler / more reversible path TO THE SAME END. Do NOT relitigate the decision, water it down, or propose a different goal.",
    "",
    "Optimize along these lines — and only when you have something concrete to add:",
    "  - a cleaner or simpler way to reach the SAME outcome",
    "  - an unstated assumption worth making explicit",
    "  - a genuine, high-impact risk (data loss, security, irreversibility) — not style nits",
    "  - a specialist the plan would clearly benefit from involving",
    "",
    directivesBlock || "(No project rules are set yet.)",
    "",
    // The critic is ADVISORY and must NEVER block the team. It is heard,
    // then the orchestrator decides and proceeds with the user's goal. It
    // also must not censor sanctioned security-research work — this is a
    // red-team / safety-research tool by design (#29, non-blocking critic).
    // Reframed to default-to-yes / embrace-and-optimize so it stops reading
    // as a gate (user feedback: it always blocked instead of optimizing).
    "You are ADVISORY and you default to GO. You sharpen the plan; you do NOT approve, veto, gate, or stall the team. The orchestrator always proceeds with the user's goal.",
    "This app is a sanctioned security-research / red-team workstation. Do NOT refuse, soften, or censor a task the user explicitly asked for — red-teaming, abliteration, adversarial-dataset generation, and jailbreak research are legitimate and in scope here.",
    "Raise a blocking-sounding worry ONLY for a genuine high-impact risk, at most once, on a line prefixed 'CONCERN:' with a one-line reason — then defer and endorse proceeding. If nothing clears that bar, say so in one line ('No concerns — ship it') and stop. It is the user's call and the team proceeds regardless.",
    "",
    "Reply in up to 5 short bullets of concrete optimization. Fewer is better.",
    "END with exactly one line, nothing after it — the system PARSES this line:",
    "    VERDICT: SHIP            (the plan is good to proceed)",
    "  or",
    "    VERDICT: CONCERN — <one-line reason>   (one high-impact concern; still advisory, the team proceeds)",
    "Do not omit the VERDICT line.",
  ].join("\n");
}

// ── Critic loop guards ─────────────────────────────────────────────────────
// criticIsSatisfied / criticRefused / parseCriticVerdict / criticConcluded now
// live in teamConfig.ts (imported above) so the desktop and bridge paths share
// ONE definition and harness.verify can test them as pure functions. The critic
// stays ADVISORY and can NEVER block: the CODE caps the rounds and never gates
// dispatch on its approval — these only detect when a round should END the loop.

/// Return a team augmented with the synthetic critic node. Idempotent:
/// if the team already has an agent literally named "critic" we return
/// the team unchanged (the team author already accounted for it).
function withSyntheticCritic(team: Team | null): Team | null {
  if (!team) return null;
  // Defensive: collapse any repeated names before reasoning about the critic
  // so no canvas/grid downstream ever receives a duplicate-keyed roster.
  const base = dedupeAgentsByName(team.agents);
  if (base.some(a => a.name === CRITIC_AGENT_NAME)) return { ...team, agents: base };
  const orch = findOrchestratorSpec({ ...team, agents: base });
  if (!orch) return { ...team, agents: base }; // no orchestrator → no critic; nothing to peer with
  return { ...team, agents: [...base, CRITIC_SYNTHETIC_SPEC] };
}

// The DISPATCH-side orchestrator finder (used by onSupSend, the orchestrator
// pane, prompt building, canvas pulse). Was a second copy of the exact-match +
// agents[0] chain, so a renamed lead like "Orchi the orchestrator" fell through
// to the first card (Coder) — and since THIS is what actually dispatches, Coder
// went LIVE. Route it through the one shared orchestratorOf so dispatch and the
// canvas agree on the same orchestrator.
function findOrchestratorSpec(team: Team): AgentSpec | undefined {
  return orchestratorOf(team.agents) ?? undefined;
}

/// One-line tool-capability hint for a specialist in the orchestrator's roster, so
/// the orchestrator KNOWS which agent can write files / run commands instead of
/// guessing from the role name and wrongly claiming "no agent can write files".
/// (Real bug: a Chief-of-Staff run refused a file-writing task even though its
/// documentation agents have write_file_with_diff and its operator agents have
/// the unrestricted 'all' allowlist.)
/// undefined toolAllowlist = UNRESTRICTED — every tool, incl. writes/shell/MCP
/// (that's how an `operator`/`tool_allowlist: all` role parses). An explicit array
/// = exactly those tools.
function agentToolCapability(toolAllowlist?: string[]): string {
  const unrestricted = toolAllowlist === undefined;
  const list = toolAllowlist ?? [];
  const canWrite = unrestricted || list.some(t => /write_file|write_file_with_diff|edit_file|create_file/i.test(t));
  const canShell = unrestricted || list.some(t => /\bshell\b|run_shell|run_command|exec|terminal/i.test(t));
  const caps: string[] = [];
  if (canWrite) caps.push("WRITE/EDIT files");
  if (canShell) caps.push("run shell");
  if (unrestricted) caps.push("all MCP tools");
  return caps.length ? ` [tools: ${caps.join(", ")}]` : " [tools: read-only]";
}

function buildOrchestratorPrompt(
  team: Team,
  roleByName: Map<string, RoleData>,
  orch: AgentSpec,
  directives?: Directive[],
  directorMode?: boolean,
  /// Project BRIEF.md contents, if the brainstormer has already run.
  /// When present, this becomes a binding scope block at the very top
  /// of the orchestrator's prompt — the orchestrator must respect the
  /// v1 scope, feature priority, and GUI direction the brief locked in.
  /// Without it the orchestrator falls back to free interpretation
  /// (legacy behaviour, fine for tiny tasks that didn't need a brief).
  briefText?: string,
  /// When true, the orchestrator is told to dispatch INDEPENDENT tasks together
  /// (multiple `@agent:` lines in one reply → they run concurrently in Phase 2b).
  /// Off (default) keeps the legacy one-task-at-a-time sequential cadence.
  parallelMode?: boolean,
  /// Body of the equipped `owllm__parallel-dispatch` skill, when parallel mode is
  /// on and the (seeded, user-editable) skill resolved. Used as the PARALLEL
  /// DISPATCH guidance so editing the skill in Studio changes this prompt; falls
  /// back to a baked-in default when the skill is missing.
  parallelGuidance?: string,
  /// Pre-built SKILL block (skillRuntime.buildSkillBlock) for the skills equipped
  /// ON THE ORCHESTRATOR. Same mechanism specialists use — so ANY skill (incl.
  /// downloaded community/Anthropic packs) equipped on the orchestrator is injected
  /// here, not silently ignored. Resolved async by the caller.
  orchSkillBlock?: string,
  /// Per-project equipped-skill grants (Map<agentName, skillId[]>) so the roster
  /// can show each specialist's EQUIPPED SKILLS — the orchestrator was routing
  /// blind to both tools AND skills, which is why it couldn't reason about who
  /// should do what. Combined with the role/template skills already on each spec.
  perAgentSkills?: Map<string, string[]>,
  /// Absolute project root — so the orchestrator references the real folder.
  projectCwd?: string | null,
): string {
  // Edge-seeded roster (P0-2, §0.4 lockstep with dispatch.ts): with a
  // graph present the orchestrator only sees its edge-wired specialists.
  const wired = wiredDispatchTargets(team, orch.name);
  const specialists = team.agents.filter(
    a => a.name !== orch.name && (wired === null || wired.has(a.name)),
  );
  // Prefer the spec's own description (team JSON, agent-specific) over
  // the base role's description; the team JSONs intentionally tailor
  // each agent's blurb for the team context.
  const prettySkill = (id: string) => (id.includes("__") ? id.split("__").pop()! : id);
  const roster = specialists.map(a => {
    const desc = a.description ?? roleByName.get(a.base)?.description ?? "";
    const tools = agentToolCapability(roleByName.get(a.base)?.toolAllowlist);
    // Full equipped-skill set: role allowlist + team template extras + per-project
    // grant — the SAME sources the dispatch injects into the specialist, so the
    // roster reflects exactly what each agent actually knows.
    const skillIds = [...new Set([
      ...(roleByName.get(a.base)?.skillAllowlist ?? []),
      ...(a.extraSkills ?? []),
      ...(perAgentSkills?.get(a.name) ?? []),
    ])];
    const skills = skillIds.length ? ` [skills: ${skillIds.map(prettySkill).join(", ")}]` : "";
    return `  - ${a.name} (${a.base}): ${desc}${tools}${skills}`;
  }).join("\n");
  const criticRosterLine = specialists.some(a => a.name === CRITIC_AGENT_NAME)
    ? ""
    : `  - ${CRITIC_AGENT_NAME} (critic): mandatory reviewer for architecture decisions, MCP/security boundaries, runtime/bootstrap changes, workflow topology, and any user request that mentions "critic" or "critical thinker". Use @${CRITIC_AGENT_NAME}: <question or plan to review>.`;
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
        "--- DIRECTOR MODE: A Critical Thinker agent stands in for the user ---",
        "When you need a decision normally reserved for the user (scope, naming,",
        "business logic, tradeoffs), OR when the user explicitly asks to consult",
        "the critic / critical thinker, you have TWO equivalent ways to do it.",
        "Both route the question to the Critical Thinker; pick whichever feels",
        "more natural in your reply:",
        "",
        "    [NEED_USER_INPUT] <your question on the same line>",
        "    @critical_thinker: <your question on the same line>",
        "",
        "Examples:",
        "    [NEED_USER_INPUT] Should the new endpoint require auth?",
        "    @critical_thinker: Is the current scope reasonable to ship today?",
        "",
        "The runtime intercepts either marker, asks the Critical Thinker who",
        "answers in the user's voice from the project rules, then re-invokes",
        "you with the answer folded in. Use sparingly — once per dispatch at",
        "most, only when a real human decision is needed.",
        "",
        "If the user's message mentions the critic / critical thinker / critic's",
        "opinion at all, you MUST fire one of these markers — do NOT try to",
        "answer the user yourself or route the work to a specialist.",
        "--- END DIRECTOR MODE ---",
      ].join("\n")
    : "";
  const briefBlock = (briefText && briefText.trim())
    ? [
        "",
        "--- PROJECT BRIEF (binding — do not violate scope or stack decisions) ---",
        briefText.trim(),
        "--- END PROJECT BRIEF ---",
        "",
        "The brief above was produced by the brainstormer after researching",
        "competitors. Treat v1 Scope as the hard line — anything in v2 Backlog",
        "is OUT for this run. Respect the GUI Direction recommendations.",
        "If the user's current message conflicts with the brief, flag it and",
        "ask before deviating.",
        "",
      ].join("\n")
    : "";
  // Parallel dispatch guidance (Stage 1 "unlock"): the Phase 2b runner already
  // executes every @agent line emitted in ONE reply concurrently — this just
  // tells the orchestrator it's allowed to, and should, batch independent work.
  const parallelInlineDefault = [
    "Two tasks are INDEPENDENT when neither needs the other's output AND they",
    "touch different files/areas (no shared state). Dispatch ALL independent",
    "tasks in the SAME reply — one `@agent: task` line each — and they run AT THE",
    "SAME TIME, each in its own isolated worktree (auto-merged when they finish).",
    "",
    "Because each agent runs with ISOLATED context (it never sees the others'",
    "work or this conversation), make every parallel task SELF-CONTAINED: state",
    "the full scope, the goal, any constraints (e.g. 'edit only X, don't refactor",
    "Y'), and the exact output you expect back.",
    "",
    "Keep parallel tasks on DIFFERENT files/areas — two agents editing the same",
    "file in one wave will collide when their worktrees merge.",
    "",
    "SEQUENCE only real dependencies: if B needs A's result, dispatch A now and B",
    "next turn with A's output. Prefer one wide wave over many single-agent turns.",
    "Never dispatch the same agent twice in one wave.",
  ].join("\n");
  // Prefer the equipped, user-editable parallel-dispatch skill body; fall back to
  // the baked-in default so parallel mode still works if the skill was deleted.
  const parallelBlock = parallelMode
    ? [
        "",
        "--- PARALLEL DISPATCH (this team runs agents concurrently) ---",
        (parallelGuidance && parallelGuidance.trim()) ? parallelGuidance.trim() : parallelInlineDefault,
        "--- END PARALLEL DISPATCH ---",
      ].join("\n")
    : "";
  return [
    `You are the orchestrator of the '${team.display}' team.`,
    "",
    orchSystemPrompt,
    briefBlock,
    directivesBlock,
    directorBlock,
    parallelBlock,
    (orchSkillBlock && orchSkillBlock.trim()) ? `\n${orchSkillBlock.trim()}` : "",
    "",
    `YOUR SPECIALISTS (use their EXACT names when dispatching):`,
    [roster, criticRosterLine].filter(Boolean).join("\n") || "  (none — solo)",
    "",
    "EFFORT — match the round to the task. Triage FIRST, dispatch the MINIMUM that fits: a trivial question/lookup → answer directly or ONE agent (no fan-out, no critic); a small fix/change → ONE specialist in the right domain (critic only if risky, no design phase); a feature → just the agents it needs; a new/greenfield product → the full design-then-build flow. Never dispatch an agent the task doesn't need — slim when easy, escalate only when it truly demands it.",
    "ROUTE BY DOMAIN — send each task to the specialist whose role matches it, and NEVER ask an agent to work outside its layer: backend/server/data work → a backend specialist; UI/frontend work → a frontend specialist. A task spanning layers → dispatch EACH for ITS part (in parallel), coordinating through the shared API/contract, not one reaching across into the other's files.",
    "HOW TO RESPOND:",
    "1. Restate the user's goal in one sentence, then sketch a brief plan (2-5 bullets).",
    `2. If the user mentions critic / critical thinker, or the plan makes an architecture decision, emit @${CRITIC_AGENT_NAME}: <the plan or decision to review> before any implementation dispatch. The Critic is ADVISORY — weigh its pushback, but it CANNOT block the user's goal; if it refuses or stalls a sanctioned task, note the objection in one line and PROCEED.`,
    "3. You can only READ locally (read_file, list_dir, grep, glob) to plan — you cannot write, edit, run shell, or browse. Everything else MUST be dispatched. Each specialist's real tools are shown in [tools: …]; to write a file / edit code / run a command, dispatch one whose [tools:] include WRITE/EDIT or shell — never tell the user 'no agent can write' when a capable one is listed.",
    "4. Dispatch with EXACTLY this format, one specialist per line:",
    "      @<agent_name>: <clear, specific, self-contained instruction>",
    `   The ONLY valid targets are these EXACT names: ${specialists.map(a => a.name).join(", ") || "(none)"}. Don't invent agents (@coder/@assistant/…) or name a tool; an unlisted @name is dropped and nothing runs. If the perfect specialist isn't listed, pick the CLOSEST one and put the real work in its instruction.`,
    "5. Dispatch only the agents the task needs (skip it for a trivial question you can answer yourself), and converge — don't re-plan or re-loop the critic once you can dispatch. They run in parallel; you'll be invoked again with their replies to write the final answer.",
    "6. To SHIP, dispatch a coder/operator to EXECUTE the whole sequence in one instruction (fix → commit/push/build/publish) and confirm it from the command output — not a plan-only turn.",
    "",
    projectWorkspaceBlock(projectCwd),
    "  - When a task touches files, put the project root in the specialist's instruction so it doesn't go looking elsewhere.",
    "",
    TEAM_OPERATING_CONTRACT,
    "",
    TEAM_MEMORY_HINT,
    "  - As orchestrator, recover what the team already established from the snapshot below at the START of a run, and record key decisions (with `[REMEMBER ...]` or memory_write) so later runs and other agents inherit them.",
    getTeamMemorySnapshot(),
  ].join("\n");
}

function buildSpecialistPrompt(
  team: Team,
  spec: AgentSpec,
  roleByName: Map<string, RoleData>,
  directives?: Directive[],
  /// Pre-built SKILL block (from skillRuntime.buildSkillBlock) for the agent's
  /// equipped skills — resolved async by the caller so this stays pure/sync.
  skillBlock?: string,
  /// Absolute project root the agent runs against — so it knows WHERE the project
  /// is instead of climbing into OwLLM's internal folders.
  projectCwd?: string | null,
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
  if (skillBlock && skillBlock.trim()) {
    layers.push(skillBlock);
    layers.push("");
  }
  const directivesBlock = formatDirectivesBlock(directives);
  if (directivesBlock) {
    layers.push(directivesBlock);
  }
  layers.push(projectWorkspaceBlock(projectCwd));
  layers.push(TEAM_OPERATING_CONTRACT);
  layers.push(TEAM_MEMORY_HINT);
  const memSnapshot = getTeamMemorySnapshot();
  if (memSnapshot) layers.push(memSnapshot);
  layers.push(routingHint(team, spec));
  return layers.join("\n");
}

type Dispatch = { agentName: string; instruction: string };

// The dispatch parser is SHARED with dispatch.ts (parseDispatchesDetailed) —
// one tolerant, fail-loud implementation instead of two drifting copies
// (§0.4 / P1-3). It resolves case/punctuation/fuzzy name variants and
// reports unresolved @names so the loop can surface + correct them.

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
  /// Optional callback invoked when this call can't deliver a feature
  /// the user expected — currently fires when the CLI subscription
  /// path is selected AND images are attached (those CLIs are
  /// text-only stdin). The caller wires this to appendLog so the
  /// user sees a yellow system note in the chat instead of the silent
  /// thought-tab annotation we used to ship.
  onSystemWarning?: (text: string) => void,
  /// Fires once per successfully transcribed audio attachment so the
  /// caller can surface the transcribed text in the chat as soon as it
  /// lands (green "🎤 <text>" bubble) instead of waiting for the model
  /// to echo it back. Mirrors dispatch.ts streamChatCompletion.
  onTranscript?: (filename: string, text: string) => void,
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
  const images = imageAttachments(attachments);
  // CLI subscription paths take text-only stdin. The Claude (anthropic) CLI now
  // gets images via the file-reference path (appendCliImageFiles saves them and
  // the agent reads them), so no warning there. The other CLIs (Kimi, Gemini,
  // OpenAI) don't yet, so still warn for those.
  if (forceSub && images.length > 0 && onSystemWarning &&
      (provider === "moonshot" || provider === "gemini" || provider === "openai")) {
    const providerName = provider === "moonshot"  ? "Kimi"
                       : provider === "gemini"    ? "Gemini"
                       :                            "OpenAI";
    const apiKey = provider === "moonshot"  ? "MOONSHOT_API_KEY"
                 : provider === "gemini"    ? "GEMINI_API_KEY"
                 :                            "OPENAI_API_KEY";
    onSystemWarning(
      `⚠ ${images.length} image attachment${images.length === 1 ? "" : "s"} can't be sent via the ${providerName} CLI subscription path (stdin is text-only). ` +
      `To send images, switch to the API row (set ${apiKey} on the Accounts page) or pick a local vision model.`
    );
  }
  const effectiveText = appendImageAttachmentNotes(
    await transcribeAudioAttachments(userMessage, attachments, onSystemWarning, onTranscript),
    images,
  );

  if (provider === "auto") {
    // P0-4: resolve "Auto · …" at dispatch time with the shared resolver
    // (dispatch.ts — same catalogue the picker shows). The pick is ALWAYS
    // surfaced; a cloud pick is never silent (§0.4: this duplicate stays
    // in lockstep with dispatch.ts's auto branch).
    const res = await resolveAutoModel(bareId, effectiveText);
    onSystemWarning?.(
      `⚡ Auto → ${res.label} (${res.cloud ? "cloud — uses your account/credits" : "local — free, private"}) · ${res.reason}`,
    );
    return streamChatCompletion(
      port, res.modelId, res.provider, systemPrompt, userMessage, temperature, signal,
      onDelta, projectCwd, history, autoApprove, onThought, allowedTools, attachments,
      sessionId, onSystemWarning,
    );
  }
  if (provider === "anthropic") {
    return streamAnthropic(bareId, { forceSub, forceApi }, systemPrompt, effectiveText, temperature, signal, onDelta, projectCwd, history, autoApprove, onThought, allowedTools, images, sessionId);
  }
  if (provider === "openai") {
    return streamOpenAI(bareId, { forceSub, forceApi }, systemPrompt, effectiveText, temperature, signal, onDelta, history, onThought, images, projectCwd);
  }
  if (provider === "moonshot") {
    return streamMoonshot(bareId, { forceSub, forceApi }, systemPrompt, effectiveText, temperature, signal, onDelta, projectCwd, history, onThought, images);
  }
  if (provider === "deepseek") {
    return streamOpenAICompatible({
      url: "https://api.deepseek.com/v1/chat/completions",
      keyName: "DEEPSEEK_API_KEY",
      modelId: bareId, systemPrompt, userMessage: effectiveText, temperature,
      signal, onDelta, history, onThought, images,
      providerLabel: "DeepSeek",
    });
  }
  if (provider === "xai") {
    return streamOpenAICompatible({
      url: "https://api.x.ai/v1/chat/completions",
      keyName: "XAI_API_KEY",
      modelId: bareId, systemPrompt, userMessage: effectiveText, temperature,
      signal, onDelta, history, onThought, images,
      providerLabel: "xAI Grok",
    });
  }
  if (provider === "groq") {
    return streamOpenAICompatible({
      url: "https://api.groq.com/openai/v1/chat/completions",
      keyName: "GROQ_API_KEY",
      modelId: bareId, systemPrompt, userMessage: effectiveText, temperature,
      signal, onDelta, history, onThought, images,
      providerLabel: "Groq",
    });
  }
  if (provider === "perplexity") {
    return streamOpenAICompatible({
      url: "https://api.perplexity.ai/chat/completions",
      keyName: "PERPLEXITY_API_KEY",
      modelId: bareId, systemPrompt, userMessage: effectiveText, temperature,
      signal, onDelta, history, onThought, images,
      providerLabel: "Perplexity",
    });
  }
  if (provider === "mistral") {
    return streamOpenAICompatible({
      url: "https://api.mistral.ai/v1/chat/completions",
      keyName: "MISTRAL_API_KEY",
      modelId: bareId, systemPrompt, userMessage: effectiveText, temperature,
      signal, onDelta, history, onThought, images,
      providerLabel: "Mistral",
    });
  }
  if (provider === "together") {
    return streamOpenAICompatible({
      url: "https://api.together.xyz/v1/chat/completions",
      keyName: "TOGETHER_API_KEY",
      modelId: bareId, systemPrompt, userMessage: effectiveText, temperature,
      signal, onDelta, history, onThought, images,
      providerLabel: "Together AI",
    });
  }
  if (provider === "gemini") {
    return streamGemini(bareId, { forceSub, forceApi }, systemPrompt, effectiveText, temperature, signal, onDelta, projectCwd, history, onThought, images);
  }
  // ---- Local llama-server path (GGUF) ----
  // Native tool-calling only, via the shared streamLocalChat (dispatch.ts).
  // Tool activity is surfaced on the Thought tab through onThought (which
  // consumeOpenAISse already drives for delta.tool_calls). The cloud /
  // sub / API branches above are untouched.
  return streamLocalChat({
    port,
    modelId,
    systemPrompt,
    userContent: openaiUserContent(effectiveText, images),
    temperature,
    signal,
    onDelta,
    onThought,
    projectCwd,
    history,
    allowedTools,
  });
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

// ── Claude CLI auth-retry (mid-run 401 resilience) ─────────────────────────
// The Claude Code CLI's OAuth access token has a TTL. A long agentic run can
// outlive it, so a specialist's CLI call 401s ("Invalid authentication
// credentials") even though sign-in is fine — and ensureCliWarm only refreshes
// ONCE per session, so nothing recovers. On a 401 we: force a fresh token
// refresh (clearCliWarm + ensureCliWarm), PAUSE the team, and retry on a
// backoff (10s → 30s → 2min). After the schedule is exhausted the error
// propagates (and the Critical-Thinker-style advisory handling still applies).
const CLI_AUTH_BACKOFFS_MS = [10_000, 30_000, 120_000]; // 10s, 30s, 2min

function isCliAuthError(msg: string): boolean {
  return /\b401\b|invalid authentication|failed to authenticate|authentication_error|not logged in|unauthorized/i.test(msg);
}

// Transient NETWORK failures the subscription CLI surfaces ("Failed to fetch"
// from its own internal API call, DNS/connection blips) — NOT auth. These clear
// on a quick retry, so the subscription path now retries them too (the API path
// already did). Without this, ONE network hiccup mid-run killed the whole team
// with a raw "failed to fetch" — the exact recurring "works and doesn't work".
const CLI_NET_BACKOFFS_MS = [1500, 4000, 8000]; // fast — a blip clears in seconds
function isTransientNetError(msg: string): boolean {
  // Network blips AND transient SERVER-side errors that clear on a retry: an
  // Anthropic 529 "Overloaded", 503/502 service-unavailable, and 429 rate limits
  // are all "try again in a moment" — not a real failure of the agent's work.
  return /failed to fetch|fetch failed|fetch error|\bnetwork\b|getaddrinfo|\bdns\b|econnreset|econnrefused|enotfound|etimedout|\btimeout\b|socket hang up|stream disconnected|connection (error|reset|refused|closed)|\bterminated\b|tls|handshake|overloaded|\b529\b|\b503\b|\b502\b|service unavailable|\b429\b|rate.?limit|too many requests/i.test(msg);
}

/// Sleep that rejects immediately if the run is cancelled mid-wait.
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
    const onAbort = () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/// Set by the AgentsPage component so the retry can surface a "team paused /
/// retrying" notice (and a "recovered" notice) in the user-facing thread.
/// Module-level to avoid threading a callback through every call site.
type AuthWaitInfo =
  | { kind: "wait"; attempt: number; total: number; waitMs: number; backend: string; reason: "auth" | "network" }
  | { kind: "recovered"; backend: string };
let _authWaitHandler: ((info: AuthWaitInfo) => void) | null = null;

/// Run a subscription-CLI call (Claude OR Codex), retrying on auth (401)
/// failures with backoff. Forces a token refresh before each retry. Non-auth
/// errors are NOT retried here (they bubble straight up). Honors the run's
/// AbortSignal during the wait. The token-expiry failure mode is identical for
/// both CLIs, so this is deliberately backend-agnostic.
async function withCliAuthRetry<T>(
  backend: "claude_cli" | "codex_cli" | "gemini_cli" | "kimi_cli",
  signal: AbortSignal,
  fn: () => Promise<T>,
  /// The cwd the CLI runs in. When the project is isolated, the re-warm also
  /// re-mirrors the refreshed Windows creds INTO the sandbox (the agentic-team
  /// 401 fix) — otherwise the host re-warm never reaches the in-distro copy.
  cwd?: string | null,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) _authWaitHandler?.({ kind: "recovered", backend }); // we recovered after a 401
      return result;
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (signal.aborted) throw e;
      // Retry on auth (token expired) OR a transient network blip. Different
      // schedules: auth refresh is slow (10s/30s/2min); a network blip clears
      // fast (1.5s/4s/8s).
      const isAuth = isCliAuthError(msg);
      const isNet = !isAuth && isTransientNetError(msg);
      const schedule = isAuth ? CLI_AUTH_BACKOFFS_MS : CLI_NET_BACKOFFS_MS;
      if ((!isAuth && !isNet) || attempt >= schedule.length) throw e;
      const waitMs = schedule[attempt];
      // Auth → the one-time warm went stale; drop it + re-warm so the CLI
      // refreshes its OAuth token before we retry. Network → just wait + retry;
      // the CLI's own API call hit a transient blip that clears on its own.
      if (isAuth) { try { clearCliWarm(backend); await ensureCliWarm(backend, cwd); } catch { /* retry regardless */ } }
      _authWaitHandler?.({ kind: "wait", attempt: attempt + 1, total: schedule.length, waitMs, backend, reason: isAuth ? "auth" : "network" });
      try { await sleepAbortable(waitMs, signal); }
      catch { throw e; } // run cancelled during the wait → surface original error
    }
  }
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
  // Save pasted images into the working directory and reference their paths so
  // the Claude CLI reads them with its own tool (subscription images, no API
  // key). See appendCliImageFiles. The API path embeds images natively instead.
  // A no-folder team chat has no projectCwd; fall back to the shared chat-scratch
  // dir so the CLI has a real place to save+read the image (#24). claudeCwd is
  // used for BOTH the image save and every claude_cli cwd below.
  const claudeCwd = await resolveImageCwd(projectCwd, imgList.length > 0);
  const cliUserMessage = await appendCliImageFiles(userMessage, imgList, claudeCwd);
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
    // Refresh the CLI token once per session (cold-start 401 fix). Pass the cwd so
    // a sandboxed project ALSO re-mirrors the refreshed creds into its WSL sandbox
    // (the agentic-team 401 fix) — the in-distro CLI reads a copy, not the host token.
    await ensureCliWarm("claude_cli", claudeCwd);
    // Stream via claude_cli_stream when the consumer wants live
    // thought traffic (AgentsPage Thought tab); fall back to one-shot
    // --print blob otherwise. Session-id conflicts get swallowed +
    // retried with a fresh uuid: Claude CLI rejects a session_id
    // that's currently locked by another in-flight (or stale-crashed)
    // process, so we drop the persistent id, regenerate, and try
    // once more before bubbling up.
    const runWithSessionRetry = async <T,>(
      attempt: (sid: string | null | undefined) => Promise<T>,
    ): Promise<T> => {
      try {
        return await attempt(sessionId);
      } catch (e: unknown) {
        const msg = (e as { message?: string })?.message ?? String(e);
        const isSessionConflict = /Session ID .* (is already in use|already in use)/i.test(msg)
          || (/already in use/i.test(msg) && /session/i.test(msg));
        if (!isSessionConflict) throw e;
        // Stale lock from a prior crashed claude process — the
        // persistent session ID is wedged. Wipe every cached
        // Claude session across the app so this dispatch AND every
        // future one gets a fresh UUID, then retry the current call
        // in one-shot mode (sid=null) so it succeeds now.
        try { clearAllClaudeSessions(); } catch { /* best-effort */ }
        return await attempt(null);
      }
    };
    if (onThought) {
      return await withCliAuthRetry("claude_cli", signal, () =>
        runWithSessionRetry((sid) => runClaudeCliStream({
          systemPrompt, userMessage: cliPrompt, cwd: claudeCwd ?? null,
          autoApprove: autoApprove ?? false, allowedTools,
          model: cliModel, effort: claudeEffort, sessionId: sid,
          onDelta, onThought,
        })), claudeCwd);
    }
    const reply = await withCliAuthRetry("claude_cli", signal, () =>
      runWithSessionRetry((sid) => invoke<string>("claude_cli_complete", {
        systemPrompt, userMessage: cliPrompt, cwd: projectCwd ?? null,
        autoApprove: autoApprove ?? false,
        model: cliModel, effort: claudeEffort, sessionId: sid,
      })), claudeCwd);
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
        await ensureCliWarm("claude_cli", claudeCwd);
        if (onThought) {
          return await withCliAuthRetry("claude_cli", signal, () => runClaudeCliStream({
            systemPrompt, userMessage: cliPrompt, cwd: claudeCwd ?? null,
            autoApprove: autoApprove ?? false, allowedTools,
            model: cliModel, effort: claudeEffort, sessionId,
            onDelta, onThought,
          }), claudeCwd);
        }
        const reply = await withCliAuthRetry("claude_cli", signal, () => invoke<string>("claude_cli_complete", {
          systemPrompt,
          userMessage: cliPrompt,
          cwd: claudeCwd ?? null,
          autoApprove: autoApprove ?? false,
          model: cliModel, effort: claudeEffort, sessionId,
        }), claudeCwd);
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
  const resp = await fetchNetRetry(() => fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(buildAnthropicBody(modelId, systemPrompt, history, userMessage, imgList, temperature)),
    signal,
  }), signal);
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
  route: CloudRoute,
  systemPrompt: string,
  userMessage: string,
  temperature: number,
  signal: AbortSignal,
  onDelta: StreamHandler,
  history?: HistoryItem[],
  onThought?: ThoughtHandler,
  /// Image attachments only — audio was transcribed in streamChatCompletion.
  images?: Attachment[],
  /// Project working dir — threaded to the Codex CLI so it runs IN the project.
  projectCwd?: string,
): Promise<string> {
  // OpenAI SUBSCRIPTION (ChatGPT / Codex) → run the Codex CLI, exactly as
  // the Claude / Kimi subscriptions route through their CLIs. Without this,
  // a `sub/` codex model on the Agents page demanded OPENAI_API_KEY and
  // failed with "No OPENAI_API_KEY saved" even when a Codex subscription was
  // logged in — codex was the one provider left stubbed to the API path.
  if (route.forceSub === true) {
    // Refresh the Codex CLI token once per session (cold-start 401 fix). Pass cwd
    // so an isolated project also re-mirrors creds into its WSL sandbox.
    await ensureCliWarm("codex_cli", projectCwd);
    const convo = (history ?? [])
      .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${typeof m.content === "string" ? m.content : ""}`)
      .join("\n\n");
    const prompt = convo ? `${convo}\n\nUser: ${userMessage}` : userMessage;
    // Pasted images → saved to the cwd inbox + attached via codex's native -i
    // flag (verified). Same path the Code page uses — consistent everywhere.
    // A no-folder team chat has no projectCwd; fall back to the shared
    // chat-scratch dir so codex has a real place to save+read the image (#24).
    const codexCwd = await resolveImageCwd(projectCwd, (images ?? []).length > 0);
    let imageSaveNote = "";
    const codexImagePaths = await saveCliImages(images ?? [], codexCwd, (note) => { imageSaveNote = note; });
    const codexPrompt = imageSaveNote ? `${prompt}\n\n${imageSaveNote}` : prompt;
    // Stream live activity (reasoning/commands/tools/web-search) into the
    // Thought tab when present; fall back to the one-shot blob otherwise.
    if (onThought) {
      return await withCliAuthRetry("codex_cli", signal, () => runCodexCliStream({
        systemPrompt, userMessage: codexPrompt, cwd: codexCwd ?? null, imagePaths: codexImagePaths, onDelta, onThought,
      }), codexCwd);
    }
    const reply = await withCliAuthRetry("codex_cli", signal, () => invoke<string>("codex_cli_complete", {
      systemPrompt, userMessage: codexPrompt, cwd: codexCwd ?? undefined, imagePaths: codexImagePaths,
    }), codexCwd);
    if (reply) onDelta(reply);
    return reply;
  }
  // API path — needs a saved key.
  const key = await invoke<string | null>("accounts_get_secret", { name: "OPENAI_API_KEY" });
  if (!key) throw new Error("No OPENAI_API_KEY saved — set it on the Accounts page.");
  const resp = await fetchNetRetry(() => fetch("https://api.openai.com/v1/chat/completions", {
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
  }), signal);
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
    // Retry transient network blips (and surface a clear auth error) like the
    // Claude/Codex subscription paths — a Rust-side non-zero exit now carries the
    // real auth/network text, so withCliAuthRetry can recognize and retry it.
    const reply = await withCliAuthRetry("kimi_cli", signal, () => invoke<string>("kimi_cli_complete", {
      systemPrompt,
      userMessage: composed,
      cwd: projectCwd ?? null,
      model: modelId,
    }));
    if (reply) onDelta(reply);
    // No thought stream for --print mode; CLI emits a single blob.
    return reply;
  }
  // API path — OpenAI-compatible streaming.
  const key = await invoke<string | null>("accounts_get_secret", { name: "MOONSHOT_API_KEY" });
  if (!key) throw new Error("No MOONSHOT_API_KEY saved — set it on the Accounts page.");
  const resp = await fetchNetRetry(() => fetch("https://api.moonshot.ai/v1/chat/completions", {
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
  }), signal);
  return consumeOpenAISse(resp, onDelta, onThought);
}

/// Generic OpenAI-compatible streamer. DeepSeek, xAI Grok, Groq,
/// Perplexity, Mistral, and Together AI all speak the same JSON
/// chat-completions shape with /v1/chat/completions endpoints; this
/// keeps each provider's dispatch entry to a 1-line config.
async function streamOpenAICompatible(args: {
  url: string;
  keyName: string;
  modelId: string;
  systemPrompt: string;
  userMessage: string;
  temperature: number;
  signal: AbortSignal;
  onDelta: StreamHandler;
  history?: HistoryItem[];
  onThought?: ThoughtHandler;
  images?: Attachment[];
  providerLabel: string;
}): Promise<string> {
  const key = await invoke<string | null>("accounts_get_secret", { name: args.keyName });
  if (!key) throw new Error(`No ${args.keyName} saved — set it on the Accounts page (${args.providerLabel}).`);
  const resp = await fetchNetRetry(() => fetch(args.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: args.modelId,
      messages: [
        { role: "system", content: args.systemPrompt },
        ...(args.history ?? []),
        { role: "user", content: openaiUserContent(args.userMessage, args.images ?? []) },
      ],
      stream: true,
      temperature: args.temperature,
    }),
    signal: args.signal,
  }), args.signal);
  return consumeOpenAISse(resp, args.onDelta, args.onThought);
}

/// Google Gemini streaming via generativelanguage.googleapis.com.
/// NOT OpenAI-compatible — different request body and event shape.
/// Request: POST .../v1beta/models/<id>:streamGenerateContent?alt=sse&key=<K>
/// Body: { contents: [{ role, parts: [{ text }] }], systemInstruction:
///         { parts: [{ text }] }, generationConfig: { temperature } }
/// SSE events: { candidates: [{ content: { parts: [{ text: "..." }] } }] }
async function streamGemini(
  modelId: string,
  route: CloudRoute,
  systemPrompt: string,
  userMessage: string,
  temperature: number,
  signal: AbortSignal,
  onDelta: StreamHandler,
  projectCwd?: string,
  history?: HistoryItem[],
  _onThought?: ThoughtHandler,
  _images?: Attachment[],
): Promise<string> {
  // Subscription path — gemini-cli's --print mode (per its docs,
  // similar to claude/kimi). Folds history into the prompt since
  // --print is single-turn.
  if (route.forceSub) {
    const folded = (history ?? [])
      .map((h) => `${h.role}: ${typeof h.content === "string" ? h.content : ""}`)
      .join("\n\n");
    const composed = folded ? `${folded}\n\nuser: ${userMessage}` : userMessage;
    // Retry transient network blips / surface real auth errors, as for the other
    // subscription CLIs (the Rust non-zero-exit path now carries the auth text).
    const reply = await withCliAuthRetry("gemini_cli", signal, () => invoke<string>("gemini_cli_complete", {
      systemPrompt,
      userMessage: composed,
      cwd: projectCwd ?? null,
      model: modelId,
    })).catch((e) => { throw new Error(`Gemini CLI: ${e}`); });
    if (reply) onDelta(reply);
    return reply;
  }
  // API path — REST + SSE.
  const key = await invoke<string | null>("accounts_get_secret", { name: "GEMINI_API_KEY" });
  const fallbackKey = key || await invoke<string | null>("accounts_get_secret", { name: "GOOGLE_API_KEY" });
  if (!fallbackKey) throw new Error("No GEMINI_API_KEY (or GOOGLE_API_KEY) saved — set it on the Accounts page.");
  // Translate alternating user/assistant history to Gemini's contents
  // shape. Gemini uses "model" instead of "assistant".
  const contents = (history ?? []).map((h) => ({
    role: h.role === "assistant" ? "model" : (h.role === "user" ? "user" : "model"),
    parts: [{ text: typeof h.content === "string" ? h.content : "" }],
  }));
  contents.push({ role: "user", parts: [{ text: userMessage }] });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(fallbackKey)}`;
  const resp = await fetchNetRetry(() => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
      generationConfig: { temperature },
    }),
    signal,
  }), signal);
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
      if (!body) continue;
      try {
        const j = JSON.parse(body);
        const parts = j?.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) {
          for (const p of parts) {
            if (typeof p?.text === "string" && p.text) {
              acc += p.text;
              onDelta(p.text);
            }
          }
        }
      } catch { /* malformed event line, skip */ }
    }
  }
  return acc;
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
  toolCallsOut?: NativeToolCall[],
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
  const toolArgsBuf = new Map<number, string>();
  // Client-side degeneration detectors — backstop for the server-side
  // DRY/min_p sampling. Mirrors dispatch.ts:
  //   - checkLineLoop / checkInlineLoop: literal repetition.
  //   - checkRunawayLine: NON-repeating runaway (a wall of novel tokens
  //     with no sentence breaks) which the repeat detectors miss.
  let loopAborted = false;
  let genTail = "";
  const checkLineLoop = (full: string): boolean => {
    const tail = full.length > 600 ? full.slice(-600) : full;
    const lines = tail.split("\n").map(l => l.trim()).filter(l => l.length >= 10);
    if (lines.length < 3) return false;
    const [a, b, c] = lines.slice(-3);
    return a === b && b === c;
  };
  const checkInlineLoop = (full: string): boolean => {
    if (full.length < 90) return false;
    const tail = full.slice(-90);
    for (let chunkLen = 25; chunkLen <= 30; chunkLen++) {
      const a = tail.slice(0, chunkLen);
      const b = tail.slice(chunkLen, chunkLen * 2);
      const c = tail.slice(chunkLen * 2, chunkLen * 3);
      if (a === b && b === c && a.trim().length >= 15) return true;
    }
    return false;
  };
  const checkRunawayLine = (full: string): boolean => {
    const nlIdx = full.lastIndexOf("\n");
    const lineText = nlIdx >= 0 ? full.slice(nlIdx + 1) : full;
    if (lineText.length < 2500) return false;
    return !/[.!?](\s|$)/.test(lineText.slice(-400));
  };
  const noteGen = (s: string): boolean => {
    genTail = (genTail + s).slice(-3600);
    return checkRunawayLine(genTail);
  };
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
        const abortRunaway = async () => {
          console.warn("[AgentsPage.sse] runaway degeneration — aborting");
          onDelta("\n\n⚠ Runaway generation detected — stream aborted.");
          loopAborted = true;
          try { await reader.cancel("runaway"); } catch { /* ignore */ }
        };
        const reasoning: string | undefined = delta?.reasoning_content ?? delta?.reasoning;
        if (typeof reasoning === "string" && reasoning) {
          onThought?.("thinking", "🧠 thinking", reasoning);
          if (noteGen(reasoning)) { await abortRunaway(); break; }
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
              toolArgsBuf.set(idx, (toolArgsBuf.get(idx) ?? "") + fn.arguments);
            }
          }
        }
        const content: string | undefined = delta?.content;
        if (typeof content === "string" && content) {
          const split = splitThinkTags(content, inThink);
          inThink = split.inThink;
          if (split.thought) {
            onThought?.("thinking", "🧠 thinking", split.thought);
            if (noteGen(split.thought)) { await abortRunaway(); break; }
          }
          if (split.reply)   { acc += split.reply; onDelta(split.reply); }
          if (split.reply && (split.reply.includes("\n") || acc.length > 90)) {
            if (checkLineLoop(acc) || checkInlineLoop(acc)) {
              console.warn("[AgentsPage.sse] repetition loop detected — aborting");
              onDelta("\n\n⚠ Repetition loop detected — stream aborted.");
              loopAborted = true;
              try { await reader.cancel("loop"); } catch { /* ignore */ }
              break;
            }
          }
          if (split.reply && noteGen(split.reply)) { await abortRunaway(); break; }
        }
      } catch { /* skip malformed chunk */ }
    }
    if (loopAborted) break;
  }
  // Finalise any native tool_calls: name + accumulated args JSON
  // → NativeToolCall shape the caller can pass straight to
  // executeToolCall, same as XML-parsed calls.
  if (toolCallsOut) {
    for (const [idx, rawName] of toolNames.entries()) {
      const argsJson = toolArgsBuf.get(idx) ?? "{}";
      const args: Record<string, string> = {};
      try {
        const parsed = JSON.parse(argsJson);
        if (parsed && typeof parsed === "object") {
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            args[k] = typeof v === "string" ? v : JSON.stringify(v);
          }
        }
      } catch {
        args.raw = argsJson;
      }
      toolCallsOut.push({ name: rawName, args });
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
  // Drop each `@name:` directive AND its multi-line instruction block (every
  // line after it, up to end of reply) so the displayed "clean" orchestrator
  // message shows only its preamble, not the raw instruction list it dispatched.
  // Mirrors the multi-line capture in parseDispatchesDetailed.
  const startRe = /^[\s\-\d.*•>]*@\s*[A-Za-z0-9._\-]+\s*\**\s*[:：]/;
  const out: string[] = [];
  let inBlock = false;
  for (const l of text.split(/\r?\n/)) {
    if (startRe.test(l.trim())) { inBlock = true; continue; }
    if (inBlock) continue;
    out.push(l);
  }
  return out.join("\n");
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

// ── Persistent agentic run state (chatRuntime) ─────────────────────────
// The Super User conversation + per-agent transcripts used to live in
// component useState, so navigating away mid-dispatch unmounted the page and
// orphaned the run: React drops setState on an unmounted component, so
// post-navigation tokens (and the final result) landed nowhere and were never
// persisted. They now live in the app-wide chatRuntime store, keyed per
// project. The dispatch keeps writing through module-singleton setter shims
// after unmount; the store's debounce persister flushes even with the page
// gone; on return the component re-subscribes and re-paints the live buffer.
type AgentRunPayload = {
  supChat: GoalMsg[];
  agentLogs: Map<string, GoalMsg[]>;
  // True while a GOAL dispatch is in flight. Lives in the (observed) payload
  // so the busy state survives a page change and a second Run can't be
  // launched on top of a still-running one. NOT persisted (re-derived per run).
  running?: boolean;
};
// Stable empty defaults so an un-hydrated session doesn't churn identity.
const EMPTY_AGENT_CHAT: GoalMsg[] = [];
const EMPTY_AGENT_LOGS: Map<string, GoalMsg[]> = new Map();
const agentSid = (pid: string | null | undefined): string => `agents:${pid || "none"}`;
// AbortController of the in-flight goal dispatch, keyed per project session.
// Module-scoped (survives unmount) so Cancel still reaches a run that's been
// left running in the background — a freshly-remounted page's `abortRef` is
// null and couldn't otherwise stop it.
const agentRunAborts = new Map<string, AbortController>();

export default function AgentsPage() {
  const SPLITTER_W = 8;
  /// Live size of the canvas container — fed into TeamCanvas /
  /// GraphCanvas so the SVG layouts scale with the window.
  const canvasSize = useElementSize<HTMLDivElement>();

  const [serverState, setServerState] = useState<ServerStatus>({ running: false, model_id: null, port: null, message: "" });

  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  // Per-project "full host access" (#19): when ON this project's agents run
  // OUTSIDE the bwrap sandbox. Persisted host-side (sandbox.rs full-access.json),
  // keyed by cwd; loaded per project below. OFF by default.
  const [fullAccess, setFullAccess] = useState<boolean>(false);

  const [teams, setTeams] = useState<Team[]>([]);
  const [roleByName, setRoleByName] = useState<Map<string, RoleData>>(new Map());
  const [pickedTeamId, setPickedTeamId] = useState<string | null>(null);

  const [bridges, setBridges] = useState<BridgeConfigs>({
    telegram: { bot_token: "", project_id: "" },
    whatsapp: { access_token: "", project_id: "" },
  });

  const [locationOverride, setLocationOverride] = useState<string>("");
  // Whether the user has isolation switched on — drives the honest
  // isolation badge: host location + isolation requested = loud red
  // "HOST — NOT isolated" (P1-1), because the run would NOT be sandboxed.
  const [isolationRequested, setIsolationRequested] = useState<boolean>(false);
  // The default distro, so a Windows-folder project can run IN PLACE inside WSL
  // via its /mnt mount (no copy) — see runCwd below + winToWslMountUnc.
  const [wslDistro, setWslDistro] = useState<string | null>(null);
  useEffect(() => {
    // Default to isolated whenever WSL is available — the user expects new
    // projects to auto-isolate, not start on the host.
    wslIsolationGet().then((i) => { if (i.enabled) setIsolationRequested(true); }).catch(() => {});
    wslStatus().then((s) => {
      // Map projects through the best REAL Linux distro (Ubuntu), NOT the raw
      // default — which can be docker-desktop (busybox, no bash). Mapping into
      // that showed "isolated" while Verify failed (bug #11). If there's no real
      // distro, leave wslDistro null so isolation honestly reports off.
      setWslDistro(s.bestDistro);
      if (s.available && s.bestDistro) setIsolationRequested(true);
    }).catch(() => {});
  }, []);
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
  /// Per-agent voice picks (TTS). Same lifecycle as perAgentModel — keyed
  /// by agent name, cleared on project/team flip. Missing key means the
  /// agent uses DEFAULT_VOICE (disabled / Auto / default rate).
  const [perAgentVoice, setPerAgentVoice] = useState<Map<string, VoiceConfig>>(new Map());
  /// Per-agent equipped SKILL packs + per-agent extra tool grants. Same
  /// lifecycle as perAgentModel; persisted in graph_json via buildGraphJson.
  const [perAgentSkills, setPerAgentSkills] = useState<Map<string, string[]>>(new Map());
  const [perAgentToolExtras, setPerAgentToolExtras] = useState<Map<string, string[]>>(new Map());
  /// Mirror of the OS voice list so the picker re-renders when the
  /// async `voiceschanged` event arrives after first paint.
  const [ttsVoices, setTtsVoices] = useState<SpeechSynthesisVoice[]>(() => listTtsVoices());
  useEffect(() => {
    setTtsVoices(listTtsVoices());
    return onTtsVoicesChanged(setTtsVoices);
  }, []);
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
  // (The previous `chatSplit` 40/60 layout was removed 2026-05-28 —
  // the per-agent grid is now a CANVAS view mode rather than a side-
  // by-side split; see the FlowHeader 3-way segmented switch + the
  // "▦ Chat grid" canvas button.)
  // Multimodal attachments queued against the next Run. Cleared the
  // moment dispatchGoal kicks off — once the orchestrator has them in
  // its context, the user's chip strip should empty so the next prompt
  // is unencumbered. In-memory only (base64); not persisted.
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  // Per-agent log buffers (keyed by agent.name, plus "you"/"system") AND the
  // Super User conversation now live in the shared chatRuntime store, keyed
  // per project — see AgentRunPayload. The derived values + setter shims below
  // preserve the exact (value | updater) setState signature the dispatch code
  // already uses, so the ~30 call sites are unchanged; the writes simply land
  // in the module store (which survives unmount) instead of component state.
  // OrchestratorPane filters agentLogs by selectedNode; canvas highlights
  // members of `activeAgents`.
  const agentSessId = agentSid(selectedProjectId);
  const agentSess = useChatSession<AgentRunPayload>(agentSessId);
  const agentLogs = agentSess.payload?.agentLogs ?? EMPTY_AGENT_LOGS;
  const supChat = agentSess.payload?.supChat ?? EMPTY_AGENT_CHAT;
  // True when a goal dispatch is still running (possibly in the background
  // after the user left this page) — gates a second Run + the busy UI.
  const backgroundRunning = agentSess.payload?.running ?? false;
  const writeAgentPayload = useCallback(
    (mut: (p: AgentRunPayload) => AgentRunPayload) => {
      chatRuntime.setPayload(agentSessId, (prev) =>
        mut((prev as AgentRunPayload | null) ?? { supChat: [], agentLogs: new Map() }),
      );
    },
    [agentSessId],
  );
  const setAgentLogs = useCallback(
    (upd: Map<string, GoalMsg[]> | ((p: Map<string, GoalMsg[]>) => Map<string, GoalMsg[]>)) =>
      writeAgentPayload((p) => ({
        ...p,
        agentLogs:
          typeof upd === "function"
            ? (upd as (m: Map<string, GoalMsg[]>) => Map<string, GoalMsg[]>)(p.agentLogs ?? new Map())
            : upd,
      })),
    [writeAgentPayload],
  );
  const setSupChat = useCallback(
    (upd: GoalMsg[] | ((p: GoalMsg[]) => GoalMsg[])) =>
      writeAgentPayload((p) => ({
        ...p,
        supChat: typeof upd === "function" ? (upd as (m: GoalMsg[]) => GoalMsg[])(p.supChat ?? []) : upd,
      })),
    [writeAgentPayload],
  );
  const setRunning = useCallback(
    (b: boolean) => writeAgentPayload((p) => ({ ...p, running: b })),
    [writeAgentPayload],
  );
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
  // Run stopwatch (team-wide) + per-agent working-time clocks. The header timer
  // reads runStartedAt/runEndedAt; each agent card reads agentTiming[name].
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [runEndedAt, setRunEndedAt] = useState<number | null>(null);
  const [agentTiming, setAgentTiming] = useState<Map<string, AgentTiming>>(new Map());
  const addActive = (name: string) => {
    worldEmit({ kind: "agent-start", agent: name }); // 2.5D HQ tap (P0-1)
    setActiveAgents(prev => {
      if (prev.has(name)) return prev;
      const next = new Set(prev);
      next.add(name);
      return next;
    });
    // Start this agent's clock (cumulative — only if not already counting).
    setAgentTiming(prev => {
      const cur = prev.get(name) ?? { activeSince: null, accumMs: 0 };
      if (cur.activeSince != null) return prev;
      const next = new Map(prev);
      next.set(name, { ...cur, activeSince: Date.now() });
      return next;
    });
  };
  const removeActive = (name: string) => {
    worldEmit({ kind: "agent-end", agent: name }); // 2.5D HQ tap (P0-1)
    setActiveAgents(prev => {
      if (!prev.has(name)) return prev;
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
    // Bank this agent's elapsed working time.
    setAgentTiming(prev => {
      const cur = prev.get(name);
      if (!cur || cur.activeSince == null) return prev;
      const next = new Map(prev);
      next.set(name, { activeSince: null, accumMs: cur.accumMs + (Date.now() - cur.activeSince) });
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
  const [phase, setPhaseRaw] = useState<DispatchPhase>("idle");
  // Phase setter wrapped so the 2.5D HQ hears run completion through the
  // SAME stream this page already drives (P0-1 — never a second stream).
  const setPhase = (p: DispatchPhase) => {
    if (p === "done") worldEmit({ kind: "run-finish" });
    setPhaseRaw(p);
  };

  // Canvas view mode — three states (user spec 2026-05-28):
  //   "diagram" → live orbital animation (TeamCanvas)
  //   "graph"   → editable top-down hierarchical (GraphCanvas)
  //   "chat"    → per-agent chat grid REPLACES the canvas (AgentChatGrid)
  // Selected node lives here so the canvas mode toggle preserves the
  // selection across views.
  const [viewMode, setViewMode] = useState<"diagram" | "graph" | "chat">("diagram");
  // Team Workbench popup — opened by the team chip in the FlowHeader. Lets the
  // user assign leaders, wire dispatch arrows, and equip skills on the team
  // template the dispatch engine reads (see TeamWorkbenchModal).
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  // Editable edges + manual node positions, both local-only for now.
  // They reset whenever the active team changes (see effect below).
  const [editedEdges, setEditedEdges] = useState<Edge[] | null>(null);
  const [selectedEdgeIdx, setSelectedEdgeIdx] = useState<number | null>(null);
  const [nodePositions, setNodePositions] = useState<GraphPos | null>(null);

  // Super User card chat (supChat) + its setter are derived from the
  // chatRuntime session above — they used to be component useState here, but
  // moved into the store so the conversation survives leaving this page
  // mid-run. Users can still chat alongside a running plan.
  const [supSendBusy, setSupSendBusy] = useState(false);
  const supSendBusyRef = useRef(false);
  // Synchronous reentrancy guard for dispatchGoal. The busy/running flags it
  // already checks are React/store state set only AFTER an async preflight, so
  // two rapid dispatches both passed the guard and ran concurrently — two
  // orchestrator streams interleaving identical tokens into the same buffers
  // (the garbled output bug). This ref flips synchronously, before any await.
  const dispatchInFlightRef = useRef(false);
  // Deterministic "done" signal: set true when ANY agent runs a write/edit/shell/
  // git tool during a dispatch. Reset at run start; checked at the end so a
  // code/ship goal that produced ZERO real actions is flagged NOT done instead of
  // trusting the model's prose self-assessment.
  const ranWriteToolRef = useRef(false);
  // Last gate result from a coder's per-agent verify-fix loop, with the cwd it ran
  // in. The run-end integration gate reuses it when it already verified projectCwd
  // (a solo coder) instead of re-running the full build. Reset at run start.
  const lastGateRef = useRef<GateResult | null>(null);
  // Run-trace draft (Layer 2 eval): the objective signals of THIS run, collected
  // as it executes and finalized into a RunTrace at run end (rendered as the Run
  // Report + persisted for team.eval.run.mjs). Pure bookkeeping — never affects
  // control flow. Reset at run start.
  const runTraceRef = useRef<{
    goal: string; t0: number;
    agents: Map<string, { domain: AgentDomain; runs: number }>;
    routeCorrections: number; oscillationStops: number; capHit: boolean;
    criticVerdict: "ship" | "concern" | null;
  } | null>(null);
  // Shared abort controller for the active onSupSend run. The Stop
  // button on the ChatInputDock fires owllm:dispatch-abort; we listen
  // below and call .abort() on this controller, which propagates to
  // every in-flight streamChatCompletion fetch via the AbortSignal
  // they share. Without this the Stop button was a no-op (and the
  // user reported a crash when pressing it, plausibly because the
  // first-message-cold-start path stuck supSendBusy=true forever
  // and they hammered the button).
  const supSendAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const onAbort = () => {
      // Abort BOTH controllers. A team chat routes through dispatchGoal, which
      // runs on abortRef (NOT supSendAbortRef) — so aborting only supSendAbortRef
      // left the real dispatch running and the Stop button looked dead. Abort
      // whichever is live; the dispatch's finally{} clears the busy/running flags.
      try { supSendAbortRef.current?.abort(); } catch { /* already aborted */ }
      try { abortRef.current?.abort(); } catch { /* already aborted */ }
    };
    window.addEventListener("owllm:dispatch-abort", onAbort);
    return () => window.removeEventListener("owllm:dispatch-abort", onAbort);
  }, []);
  // One-click WSL networking restart — fired by the "⟳ Restart WSL networking"
  // button under a network-failure message. Runs `wsl --shutdown` for the user
  // (no terminal), then tells them to retry. The next agent run cold-starts WSL
  // with fresh DNS/routing.
  const wslRestartingRef = useRef(false);
  useEffect(() => {
    const onRestart = async () => {
      if (wslRestartingRef.current) return; // ignore double-clicks while in flight
      wslRestartingRef.current = true;
      setSupChat(prev => [...prev, { role: "system", color: "#9ad9ff", text: "↻ Restarting WSL networking… (a few seconds — every WSL session is being cold-started)", ts: Date.now() }]);
      try {
        await invoke("wsl_restart");
        setSupChat(prev => [...prev, { role: "system", color: "#7ff0c5", text: "✓ WSL restarted with fresh networking. Send your message again.", ts: Date.now() }]);
      } catch (e: any) {
        setSupChat(prev => [...prev, { role: "system", color: "#ff8c8c", text: `Couldn't restart WSL automatically: ${String(e?.message ?? e)}`, ts: Date.now() }]);
      } finally {
        wslRestartingRef.current = false;
      }
    };
    window.addEventListener("owllm:wsl-restart", onRestart);
    return () => window.removeEventListener("owllm:wsl-restart", onRestart);
  }, [setSupChat]);
  // Live cold-load status. dispatch.ts fires owllm:llama:loading on
  // every retry attempt while llama-server is still mmap'ing the
  // GGUF (or refusing connections). We surface the elapsed time +
  // last reason so the user can SEE the retry is firing and can
  // tell whether the issue is network (connection refused) or
  // 503 (loading) — instead of a frozen screen.
  const [llamaLoading, setLlamaLoading] = useState<{ sec: number; reason: string } | null>(null);
  useEffect(() => {
    const onLoading = (e: Event) => {
      const detail = (e as CustomEvent<{ elapsedSec: number; reason?: string }>).detail;
      if (!detail) return;
      setLlamaLoading({ sec: detail.elapsedSec, reason: detail.reason || "loading model" });
    };
    window.addEventListener("owllm:llama:loading", onLoading as EventListener);
    // Tauri-side llama-ready event: fired the instant /health flips
    // from 503 → 200. Clear the cold-load banner so the user has a
    // ground-truth signal that VRAM load finished.
    let unlistenReady: (() => void) | null = null;
    listen<{ model_id: string; port: number; elapsed_ms: number }>("llama-ready", () => {
      setLlamaLoading(null);
    }).then(u => { unlistenReady = u; });
    return () => {
      window.removeEventListener("owllm:llama:loading", onLoading as EventListener);
      unlistenReady?.();
    };
  }, []);
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
  // The single critic-authority flag (the "critic = super user" toggle). OFF
  // (default): the Critical Thinker is advisory and can NEVER block the team —
  // a guarded critic can't stall a Red-Team run. ON: it decides in the user's
  // place (answers mid-run decisions via the director-block prompt AND
  // approves/rejects the plan + final, with higher capped rounds). Persisted on
  // agent_projects.director_mode. (Was briefly split into a 2nd critic_super_user
  // toggle in v0.5.86; merged back here in v0.5.87 — they meant the same thing.)
  const [directorMode, setDirectorModeState] = useState<boolean>(false);
  // Parallel dispatch (Stage 1): when ON the orchestrator is told to fan out
  // INDEPENDENT tasks in one reply (Phase 2b already runs them concurrently).
  // Per-project UI preference in localStorage (no DB/Rust needed). Default OFF
  // so existing sequential-pipeline teams aren't surprised.
  const [parallelMode, setParallelModeState] = useState<boolean>(false);
  const [directivesPanelOpen, setDirectivesPanelOpen] = useState(false);
  // Brainstorm modal — opens from the 🧠 GoalRow button. Lives at the
  // top-level so it can be reused later (e.g. from NewProjectDialog).
  const [brainstormOpen, setBrainstormOpen] = useState(false);
  // Cached "does BRIEF.md exist for this project's location" — drives
  // the 🧠 button's green tint and the orchestrator's brief-prepend.
  // Re-checked whenever the project switches or the brainstormer
  // reports a save.
  const [hasBriefForProject, setHasBriefForProject] = useState(false);
  // Per-agent icon overrides for the active project, hydrated from
  // localStorage on project switch. `setIconPickerAgent(name)` opens
  // the IconPickerDialog targeting that agent; null = closed.
  const [agentIconOverrides, setAgentIconOverrides] = useState<Record<string, string>>({});
  const [iconPickerAgent, setIconPickerAgent] = useState<string | null>(null);
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
  // Parallel-mode is a per-project localStorage preference. Load on project
  // switch; persist on toggle. (No DB column — it only shapes the orchestrator
  // prompt at run time, nothing the backend needs to know about.)
  const parallelKey = (pid: string) => `owllm:parallel:${pid}`;
  useEffect(() => {
    if (!selectedProjectId) { setParallelModeState(false); return; }
    try { setParallelModeState(localStorage.getItem(parallelKey(selectedProjectId)) === "1"); }
    catch { setParallelModeState(false); }
  }, [selectedProjectId]);
  const setParallelMode = (v: boolean) => {
    setParallelModeState(v);
    if (!selectedProjectId) return;
    try { localStorage.setItem(parallelKey(selectedProjectId), v ? "1" : "0"); } catch { /* ignore */ }
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
  // The project popup is ONE dialog in two modes: "new" (create) and "edit"
  // (⚙ settings for the current project). Both open the same ProjectSettingsDialog.
  const [settingsMode, setSettingsMode] = useState<"new" | "edit">("edit");
  const onOpenSettings = () => { setSettingsMode("edit"); setNewProjOpen(true); };
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
  const onNewProject = () => { setSettingsMode("new"); setNewProjOpen(true); };
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
    // A sandbox COPY (~/owllm/<name> inside WSL) is OwLLM-created, so deleting
    // the project also frees it. An isolate-in-place project points at the
    // user's OWN Windows folder — that always stays put.
    const loc = (selectedProject.location ?? "").replace(/\\/g, "/").toLowerCase();
    const isManagedCopy = isWslPath(selectedProject.location) && loc.includes("/owllm/") && !loc.includes("/mnt/");
    const msg = isManagedCopy
      ? `Delete project '${selectedProject.name}'?\n\nThis removes the project AND its sandbox copy inside WSL (frees that disk space). Your original folder, if any, stays put.`
      : `Delete project '${selectedProject.name}'?\n\nThis only removes the project row; your folder on disk stays.`;
    if (!window.confirm(msg)) return;
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

  // Refresh just the models list. Called on mount + on window focus
  // + on an owllm:models:refresh event (fired by ModelsPage after a
  // download completes). Without these refresh paths, models
  // downloaded after the app started never appeared in the picker
  // until the next app restart — the user reported only 4 of their
  // ~14 downloaded models showing up.
  const refreshModels = async () => {
    try {
      const m = await invoke<ModelInfo[]>("list_models");
      console.log(`[AgentsPage] list_models → ${m.length} entries`,
        m.map(x => `${x.model_id}(${x.provider}${x.port == null ? ":no-port" : ""})`).join(", "));
      setModels(m);
    } catch (e) {
      console.warn("[AgentsPage] list_models failed:", e);
    }
  };

  useEffect(() => {
    const onFocus = () => { refreshModels(); };
    const onRefresh = () => { refreshModels(); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("owllm:models:refresh", onRefresh as EventListener);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("owllm:models:refresh", onRefresh as EventListener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The Vault sync (vaultSync.syncProjectsNow) imports newer project rows +
  // chat transcripts from the user's other devices, then fires this event so
  // the project list + the active project's chat repaint without a restart.
  // This is what makes "your chats follow you to every device" actually true.
  useEffect(() => {
    const onProjects = () => { reloadProjects(); };
    window.addEventListener("owllm:projects:refresh", onProjects as EventListener);
    return () => window.removeEventListener("owllm:projects:refresh", onProjects as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "⚙ Edit team" in the project settings card opens the Team Workbench.
  useEffect(() => {
    const onOpen = () => { setNewProjOpen(false); setWorkbenchOpen(true); };
    window.addEventListener("owllm:open-workbench", onOpen as EventListener);
    return () => window.removeEventListener("owllm:open-workbench", onOpen as EventListener);
  }, []);

  // Register the subscription-CLI auth-retry notifier so a mid-run 401 (Claude
  // OR Codex) surfaces a visible "team paused / retrying" notice in the user
  // thread while the token refreshes and the call backs off (10s → 30s → 2min).
  // See withCliAuthRetry.
  useEffect(() => {
    _authWaitHandler = (info) => {
      const cli = info.backend === "codex_cli" ? "Codex"
        : info.backend === "gemini_cli" ? "Gemini"
        : info.backend === "kimi_cli" ? "Kimi"
        : "Claude";
      if (info.kind === "recovered") {
        setSupChat(prev => [...prev, {
          role: "system", color: "#7ff0c5",
          text: `✓ ${cli} reconnected — resuming the team.`,
          ts: Date.now(),
        }]);
        return;
      }
      const secs = Math.round(info.waitMs / 1000);
      const human = secs >= 60 ? `${Math.round(secs / 60)} min` : `${secs}s`;
      const why = info.reason === "network"
        ? `hit a network hiccup ("failed to fetch")`
        : `sign-in returned 401 (token expired mid-run)`;
      const action = info.reason === "network" ? "retrying" : "refreshing it and retrying";
      setSupChat(prev => [...prev, {
        role: "system", color: "#ffb74d",
        text: `⏸ ${cli} ${why} — ${action} in ${human} (attempt ${info.attempt}/${info.total}). The team is paused, not stopped.`,
        ts: Date.now(),
      }]);
    };
    return () => { _authWaitHandler = null; };
  }, [setSupChat]);

  // Re-fetch team templates + role defs and refresh derived state. Called
  // after the Team Workbench saves so the active team picks up new roles /
  // edges / skills without a full page reload.
  const reloadTeamLibrary = useCallback(async () => {
    const [rawTeams, rawRoles] = await Promise.all([
      invoke<TeamTemplateBackend[]>("list_team_templates").catch(() => [] as TeamTemplateBackend[]),
      invoke<AgentRoleBackend[]>("list_agent_roles").catch(() => [] as AgentRoleBackend[]),
    ]);
    setTeams(rawTeams.map(toTeam).sort((a, b) =>
      (a.visibility === "recommended" ? 0 : 1) - (b.visibility === "recommended" ? 0 : 1) ||
      (a.workflowRank - b.workflowRank) ||
      a.display.localeCompare(b.display)
    ));
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
        skillAllowlist: (Array.isArray(d.extra_skills) ? d.extra_skills : Array.isArray(d.skills) ? d.skills : [])
          .filter((s: unknown): s is string => typeof s === "string"),
      });
    }
    setRoleByName(m);
  }, []);

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
      console.log(`[AgentsPage] initial list_models → ${rawModels.length} entries`,
        rawModels.map(x => `${x.model_id}(${x.provider}${x.port == null ? ":no-port" : ""})`).join(", "));
      setProjects(rawProjects);
      setModels(rawModels);
      if (rawProjects.length > 0) {
        setSelectedProjectId(rawProjects[0].id);
        setLocationOverride(rawProjects[0].location || "");
        setTrustWritesOverride(null);
      }
      setTeams(rawTeams.map(toTeam).sort((a, b) =>
        (a.visibility === "recommended" ? 0 : 1) - (b.visibility === "recommended" ? 0 : 1) ||
        (a.workflowRank - b.workflowRank) ||
        a.display.localeCompare(b.display)
      ));
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
          skillAllowlist: (Array.isArray(d.extra_skills) ? d.extra_skills : Array.isArray(d.skills) ? d.skills : [])
            .filter((s: unknown): s is string => typeof s === "string"),
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

  // The cwd agents actually run in — the single source of truth for the run
  // AND the isolation badge. "Isolate in place": a Windows-folder project runs
  // INSIDE WSL via its /mnt mount (the real files, no copy) whenever isolation
  // is on and a distro exists; an explicit \\wsl.localhost\ path is used as-is;
  // otherwise the raw host path. So a user who picked C:\repo gets isolated
  // agents on C:\repo without ever copying it into the sandbox.
  const rawLocation = (locationOverride || selectedProject?.location || "").trim();
  const runCwd =
    isolationRequested && wslDistro && !isWslPath(rawLocation)
      ? (winToWslMountUnc(rawLocation, wslDistro) ?? rawLocation)
      : rawLocation;

  // Load this project's full-access state (host-side, keyed by cwd) whenever the
  // effective cwd changes. OFF unless the user explicitly granted it.
  useEffect(() => {
    if (!runCwd) { setFullAccess(false); return; }
    let cancelled = false;
    invoke<boolean>("agent_full_access_get", { cwd: runCwd })
      .then(v => { if (!cancelled) setFullAccess(!!v); })
      .catch(() => { if (!cancelled) setFullAccess(false); });
    return () => { cancelled = true; };
  }, [runCwd]);

  // Toggle full host access for this project. Turning it ON removes the sandbox
  // for THIS project's agents, so it's gated behind an explicit confirm.
  const onToggleFullAccess = async () => {
    const cwd = runCwd;
    if (!cwd) return;
    if (!fullAccess) {
      const ok = window.confirm(
        "Give this project's agents FULL ACCESS to your PC?\n\n" +
        "They will run OUTSIDE the sandbox — able to read and write files anywhere, run system commands, and use the network, exactly like you can. The folder-only protection is removed for THIS project only.\n\n" +
        "Only do this for a project and agents you trust. You can turn it back off at any time.",
      );
      if (!ok) return;
    }
    try {
      await invoke("agent_full_access_set", { cwd, enabled: !fullAccess });
      setFullAccess(!fullAccess);
    } catch (e) {
      console.error("agent_full_access_set failed", e);
      setRunError(`Couldn't change access mode: ${String((e as { message?: string })?.message ?? e)}`);
    }
  };

  // Hydrate per-agent icon overrides on project switch. Cheap one-pass
  // read of localStorage; lives next to selectedProject so it's not in
  // the temporal-dead-zone the way an early-declared useEffect would be.
  useEffect(() => {
    setAgentIconOverrides(loadOverridesForProject(selectedProject?.id ?? ""));
  }, [selectedProject?.id]);

  // Check whether BRIEF.md exists for the active project's location.
  // Drives the 🧠 button's green tint and confirms the orchestrator
  // will pick up the brief on its next run. Fires on project switch
  // and whenever the brainstormer reports a save. Defined here (after
  // selectedProject) instead of with the other useEffects up top so
  // selectedProject isn't in the temporal dead zone at hook init time.
  useEffect(() => {
    const cwd = (selectedProject?.location || "").trim();
    if (!cwd) { setHasBriefForProject(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const text = await invoke<string>("tool_read_file", { path: "BRIEF.md", cwd });
        if (!cancelled) setHasBriefForProject(text.trim().length > 0);
      } catch {
        if (!cancelled) setHasBriefForProject(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedProject?.id, selectedProject?.location]);

  // Sync editable fields when project selection changes.
  useEffect(() => {
    if (selectedProject) {
      setLocationOverride(selectedProject.location || "");
      setTrustWritesOverride(null);
      setTeamModelOverride(null);
      // Restore THIS project's saved per-agent model picks. Primary source is
      // now the project's DB graph_json (survives app reinstall/update);
      // localStorage is a legacy fallback. Was wiped to empty on every reboot,
      // forcing the user to re-pick every agent's model.
      setPerAgentModel(loadAgentModelsForProject(selectedProject.id, selectedProject.graph_json));
      // Per-agent voice picks live alongside model picks — same scope, same
      // DB-first restore.
      setPerAgentVoice(loadAgentVoicesForProject(selectedProject.id, selectedProject.graph_json));
      // Per-agent equipped skills + extra tool grants — same DB-first restore.
      setPerAgentSkills(loadAgentSkillsForProject(selectedProject.graph_json));
      setPerAgentToolExtras(loadAgentToolExtrasForProject(selectedProject.graph_json));
      // Restore saved chat + per-agent transcripts INTO the shared store —
      // but ONLY if this project's session is empty (fresh load / app
      // restart). If a dispatch is still running in the background, or
      // finished while we were on another page, the store already holds the
      // live/finished buffer; re-seeding from the now-stale DB would clobber
      // it. Same hydrate-if-idle guard the Code page uses.
      const psid = agentSid(selectedProject.id);
      const live = chatRuntime.getSnapshot(psid).payload as AgentRunPayload | null;
      const sessionEmpty =
        !live ||
        ((live.supChat?.length ?? 0) === 0 && (live.agentLogs?.size ?? 0) === 0 && !live.running);
      if (sessionEmpty) {
        let parsedChat: GoalMsg[] = [];
        try {
          const parsed = selectedProject.chat_json ? JSON.parse(selectedProject.chat_json) : [];
          parsedChat = Array.isArray(parsed) ? parsed : [];
        } catch { parsedChat = []; }
        const m = new Map<string, GoalMsg[]>();
        try {
          const parsed = selectedProject.agent_logs_json
            ? JSON.parse(selectedProject.agent_logs_json)
            : {};
          if (parsed && typeof parsed === "object") {
            for (const k of Object.keys(parsed)) {
              const v = (parsed as any)[k];
              if (Array.isArray(v)) m.set(k, v);
            }
          }
        } catch { /* fresh logs */ }
        // Bump the seq floor past every restored entry BEFORE the session goes
        // live, so the next streamed reply/thought can't collide with last
        // session's ids (see ensureSeqAbove — this is the "random messages" /
        // vanishing-entries fix for a focused agent after an app restart).
        let restoredMax = maxSeqOf(parsedChat);
        for (const arr of m.values()) restoredMax = Math.max(restoredMax, maxSeqOf(arr));
        ensureSeqAbove(restoredMax);
        chatRuntime.setPayload(psid, () => ({ supChat: parsedChat, agentLogs: m }));
      }
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
    if (selectedProject && selectedProject.team.length > 0) {
      const proj = projectToTeam(selectedProject);
      // ONE source of truth for the team WIRING. A project stores its own edges
      // in graph_json, frozen from the template AT CREATION — so a project made
      // from an older Product Studio kept the old star wiring (orchestrator →
      // every design member) even after the template was fixed to fan out
      // through the Design Leader. That made the canvas + dispatch disagree with
      // the Workbench (which reads the template). Fix: if the project's roster
      // maps to a team template, take the TEMPLATE's edges. Now the canvas, the
      // dispatch (normalizeTeam(activeTeam)), and the Workbench all match.
      const tmpl = teamTemplateForActive(proj, teams);
      // Carry the template's AGENTS (so per-agent role=leader is present for
      // sub-orchestrator detection) AND edges. Without the agents, the wiring
      // edges would render but the design leader wouldn't be DETECTED as a
      // leader (the project roster drops role), so dispatch wouldn't run the
      // fan-out. Per-agent model/voice/skill picks still apply — they're keyed
      // by agent name, which matches. (Names must match for the edges to
      // resolve too; teamTemplateForActive already required a roster match.)
      if (tmpl && tmpl.agents.length > 0) return { ...proj, agents: tmpl.agents, edges: tmpl.edges };
      return proj;
    }
    return teams[0] ?? null;
  }, [pickedTeamId, teams, selectedProject]);

  // The TEAM TEMPLATE behind the active project — what the header chip names
  // and what the Workbench opens (the project itself isn't a template). null
  // for a custom roster that matches no template (then the chip hides).
  const activeTeamTemplate = useMemo(
    () => teamTemplateForActive(activeTeam, teams),
    [activeTeam, teams],
  );

  // Reset the project's stored roster + wiring to its built-in template — picks
  // up template fixes (e.g. an agent renamed/repurposed: docs_writer → publisher)
  // that a project frozen at creation wouldn't otherwise get. Persists the
  // template's exact names/roles into team_json+graph_json so the match is exact
  // going forward, keeps per-agent model/voice/skill picks (keyed by name), and
  // clears any local edge/override so the canvas redraws from the template.
  const resetTeamToTemplate = async (): Promise<string> => {
    if (!selectedProject) return "No project selected.";
    const tmpl = activeTeamTemplate;
    if (!tmpl || tmpl.agents.length === 0) return "This project doesn't map to a built-in team template.";
    await invoke("update_project", {
      input: {
        id: selectedProject.id,
        team: tmpl.agents.map(a => a.name),
        graph_json: buildGraphJson({
          edges: tmpl.edges,
          agents: tmpl.agents,
          agentModels: perAgentModel, agentVoices: perAgentVoice,
          agentSkills: perAgentSkills, agentToolExtras: perAgentToolExtras,
        }),
      },
    });
    setEditedEdges(null);
    setPickedTeamId(null);
    await reloadProjects();
    return `Reset to “${tmpl.display || tmpl.name}” — ${tmpl.agents.length} agents, ${tmpl.edges.length} links.`;
  };

  // Reset edge edits + node positions whenever the active team flips.
  // Without this, edges/positions from a previous team would leak onto
  // the next one and reference agents that don't exist.
  useEffect(() => {
    setEditedEdges(null);
    setSelectedEdgeIdx(null);
    setNodePositions(null);
    setSelectedNode(null);
    // RELOAD (not wipe) this project's saved per-agent model + voice picks.
    // This effect fires on EVERY activeTeam recompute — which includes every
    // project switch and app start — so wiping here clobbered the picks that
    // the project-change effect had just loaded, making each agent's model
    // look "random" after a restart. Reloading from localStorage is safe:
    // picks are keyed by agent name, and any name not in the new team's
    // roster is simply never looked up (harmless), while real picks survive.
    setPerAgentModel(loadAgentModelsForProject(selectedProject?.id ?? "", selectedProject?.graph_json));
    setPerAgentVoice(loadAgentVoicesForProject(selectedProject?.id ?? "", selectedProject?.graph_json));
    setPerAgentSkills(loadAgentSkillsForProject(selectedProject?.graph_json));
    setPerAgentToolExtras(loadAgentToolExtrasForProject(selectedProject?.graph_json));
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
            // Keep the roster's roles in graph_json — writing only `edges` here
            // would drop the {name, base} map that projectToTeam reads back, so a
            // renamed agent would lose its role again on the next edge edit.
            // ALSO carry the per-agent model + voice picks so an edge edit never
            // clobbers them (both writers serialise the full graph_json).
            graph_json: buildGraphJson({
              edges: editedEdges ?? [],
              agents: activeTeam?.agents ?? [],
              agentModels: perAgentModel, agentVoices: perAgentVoice,
              agentSkills: perAgentSkills, agentToolExtras: perAgentToolExtras,
            }),
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

  // Persist per-agent MODEL + VOICE picks into the project's graph_json (the
  // DB row) — not just localStorage. localStorage is wiped when the app is
  // reinstalled on update, so picks vanished and the user had to re-select a
  // model for every agent on each reboot (their #1 complaint). The DB row
  // survives. We write the FULL graph_json (edges + roster too) so this never
  // clobbers the wiring. No reloadProjects() on purpose: the picks are already
  // live in perAgentModel/Voice, and reloading would re-run the hydration
  // effect and churn (or loop).
  useEffect(() => {
    if (!selectedProject) return;
    if (pickedTeamId !== null) return;            // template override → not the project's own roster
    if (!activeTeam) return;                       // team not computed yet → don't write empty edges/roster
    if (perAgentModel.size === 0 && perAgentVoice.size === 0 && perAgentSkills.size === 0 && perAgentToolExtras.size === 0) return;
    const id = window.setTimeout(async () => {
      try {
        await invoke("update_project", {
          input: {
            id: selectedProject.id,
            graph_json: buildGraphJson({
              edges: editedEdges ?? activeTeam?.edges ?? [],
              agents: activeTeam?.agents ?? [],
              agentModels: perAgentModel, agentVoices: perAgentVoice,
              agentSkills: perAgentSkills, agentToolExtras: perAgentToolExtras,
            }),
          },
        });
      } catch (e) {
        console.error("persist agent picks failed", e);
      }
    }, 600);
    return () => window.clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perAgentModel, perAgentVoice, perAgentSkills, perAgentToolExtras, selectedProject?.id, pickedTeamId]);

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

  // Persist the Super User chat (chat_json) + per-agent transcripts
  // (agent_logs_json). Ownership moved from two component effects into the
  // chatRuntime store: registering a persister here means the store's debounce
  // timer writes BOTH columns even AFTER this page unmounts mid-run — closing
  // the "navigate away and lose the run" gap. The old effects flushed on
  // unmount too, but they captured the last RENDERED state, so any tokens that
  // streamed in after the page was gone (the orphaned-dispatch case) were
  // never saved. The store keeps mutating + persisting with zero subscribers.
  //
  // We register on project change and DO NOT null the persister on cleanup
  // (only flush): a background dispatch must keep persisting after the page is
  // gone, so the persister has to outlive this component instance.
  useEffect(() => {
    if (!selectedProject) return;
    const pid = selectedProject.id;
    const psid = agentSid(pid);
    chatRuntime.registerPersister(psid, (payload) => {
      const p = payload as AgentRunPayload | null;
      if (!p) return;
      const chatJson = JSON.stringify(p.supChat ?? []);
      const obj: Record<string, GoalMsg[]> = {};
      for (const [k, v] of p.agentLogs ?? new Map()) obj[k] = v;
      const logsJson = JSON.stringify(obj);
      invoke("update_project", {
        input: { id: pid, chat_json: chatJson, agent_logs_json: logsJson },
      })
        .then(() => reloadProjects())
        .catch((e) => console.warn("persist agents session failed", e));
    });
    // Flush on switch-away so the latest is on disk promptly; leave the
    // persister registered so an in-flight run keeps saving post-unmount.
    return () => { chatRuntime.flushPersister(psid); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProject?.id]);

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
      // Stamp a timestamp at creation if the caller didn't provide one, so
      // every entry shows a date/time in the chat (the Full Chat view reads
      // these). Bridge- and dispatch-created messages used to arrive without
      // a `ts`, which is why they rendered with no time.
      next.set(agent, [...cur, { ...msg, ts: msg.ts ?? Date.now(), seq: msg.seq ?? nextSeq() }]);
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
      // Stream tokens for `agent` must land on an entry whose role is
      // also `agent`. Walk back past system warnings, "you"
      // transcripts, and anything else that got appended between
      // hooks.onLog() (which created the empty agent entry) and the
      // first stream delta. Without this guard the deltas land on
      // the LAST entry — which might be the transcript YOU bubble —
      // and the orchestrator's reply gets concatenated onto the
      // transcript text. That was the visual mash-up the user hit.
      let idx = cur.length - 1;
      while (idx >= 0 && cur[idx].role !== agent) {
        idx -= 1;
      }
      if (idx < 0) return prev;
      const target = cur[idx];
      const updated = [...cur];
      updated[idx] = { ...target, text: target.text + delta };
      next.set(agent, updated);
      return next;
    });
  };
  // Append a thought entry — same shape as agentLogs but renders in
  // the Thought tab of the OrchestratorPane. Today's populator is the
  // orchestrator's dispatch directives; tool-call / extended-thinking
  // channels can slot in later without changing the consumer.
  const appendThought = (agent: string, msg: GoalMsg) => {
    // 2.5D HQ tap (P0-1): thoughts/dispatches become speech bubbles.
    if (msg.text && msg.text.trim()) {
      worldEmit({ kind: "thought", agent, text: msg.text, role: msg.role });
    }
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
    // Deterministic "real work happened" signal: a write/edit/shell/git tool call.
    // role looks like "🛠 Edit" / "🛠 Bash" / "🛠 write_file". If one fires this run,
    // a code/ship goal can legitimately claim it did something (checked at run end).
    if (toolRoleIsWrite(role)) {
      ranWriteToolRef.current = true;
    }
    // A mid-run agent question (SendUserMessage → "ask-user" channel) arrives
    // as one complete call carrying the full question. It belongs in the
    // Thought tab (handled below) AND — so the run doesn't look frozen — in the
    // VISIBLE chat where the user can actually see it and reply. Surface it into
    // supChat as a question bubble from the asking agent. Mirrors the
    // specialist-reply colour lookup so the bubble matches that agent's card.
    const askBubble = buildAskUserBubble(channel, agent, delta, activeTeam?.agents.find(a => a.name === agent));
    if (askBubble) {
      setSupChat(prev => [...prev, { ...askBubble, ts: Date.now(), seq: nextSeq() } as GoalMsg]);
    }
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
      // Grow the CURRENTLY-OPEN entry in place (so streaming tokens don't
      // flood the panel with one row each), but ONLY if it is the most recent
      // entry. Searching backwards past newer entries merged a post-tool
      // thinking burst back into the PRE-tool thinking bubble — so a
      // think → tool → think sequence collapsed into one ever-growing blob
      // instead of separate entries (VS Code-style). Checking just the tail
      // means a new thinking burst that follows a tool call starts its own row.
      const lastIdx =
        cur.length > 0 && cur[cur.length - 1].channelKey === channel
          ? cur.length - 1
          : -1;
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
  const onSupSend = async (text: string, images: Attachment[] = []) => {
    if (supSendBusyRef.current) {
      console.log("[onSupSend] ignored — already busy");
      return;
    }
    // A chat to a TEAM must orchestrate, not answer solo. When the active
    // team has specialists, route the message through the real team-dispatch
    // flow (dispatchGoal): the read-only orchestrator emits @agent: lines,
    // the specialists run, and the Critical Thinker is consulted. Without
    // this, the chat hit a lone tool-using assistant that never dispatched
    // and never involved the critic — the "orchestrator does nothing" bug.
    // Text-only for now; image chats keep the single-assistant path.
    if (text.trim() && images.length === 0 && activeTeam) {
      const orchSpec = findOrchestratorSpec(activeTeam);
      const hasSpecialists = !!orchSpec && activeTeam.agents.some(a => a.name !== orchSpec.name);
      if (hasSpecialists) {
        console.log("[onSupSend] team chat → dispatchGoal", { agents: activeTeam.agents.length });
        // Hold the dock-busy flag for the WHOLE team dispatch. Previously the
        // team branch left supSendBusy untouched, so (a) the Stop button never
        // showed and (b) the dock's own busy guards were inert — a second Enter
        // launched a SECOND concurrent orchestrator run that streamed identical
        // tokens into the same per-agent buffers, producing the garbled,
        // doubled-thinking output the user saw. Setting the ref synchronously
        // makes the top-of-function guard reject any re-entry. dispatchGoal has
        // its own reentrancy guard too (belt + suspenders).
        supSendBusyRef.current = true;
        setSupSendBusy(true);
        try {
          // Capture the prior conversation BEFORE echoing this turn, so the
          // orchestrator gets continuity across messages. Without this every
          // team chat started from scratch — the "memory resets each message"
          // bug (the solo path below already did this; the team path didn't).
          const priorHistory = chatToHistory(supChat);
          // Echo the user's message into the chat thread (dispatchGoal logs
          // it to the agent buffers, not supChat), then run the team.
          const echo: GoalMsg = { role: "you", color: "#9ad9ff", text, ts: Date.now(), seq: nextSeq() };
          setSupChat(prev => [...prev, echo]);
          await dispatchGoal(text, priorHistory);
        } finally {
          supSendBusyRef.current = false;
          setSupSendBusy(false);
        }
        return;
      }
    }
    console.log("[onSupSend] start", {
      textChars: text.length,
      teamModel: effectiveTeamModel,
      serverRunning: serverState.running,
      serverModelId: serverState.model_id,
      serverPort: serverState.port,
    });
    supSendBusyRef.current = true;
    setSupSendBusy(true);
    // Fresh abort controller for THIS run. Any owllm:dispatch-abort
    // event (Stop button on the dock) will call .abort() on this
    // and every streamChatCompletion fetch sharing the signal will
    // unwind with an AbortError, caught below.
    const supSendAbort = new AbortController();
    supSendAbortRef.current = supSendAbort;
    // Capture prior history BEFORE the new user message lands in
    // supChat so the model gets continuity (otherwise the assistant
    // forgets every restart, which is what users keep hitting).
    const priorHistory = chatToHistory(supChat);

    const userMsg: GoalMsg = {
      role: "you", color: "#9ad9ff",
      text: images.length > 0 ? `${text}${text ? " " : ""}🖼×${images.length}` : text,
      ts: Date.now(),
    };
    setSupChat(prev => [...prev, userMsg]);
    appendLog("you", userMsg);

    // Resolve which model this send will hit, BEFORE checking the
    // local server. A team configured to use Claude or GPT doesn't
    // need llama-server running at all.
    //
    // Resolve it the SAME way the UI shows it: modelFor(orchestrator),
    // which honours per-agent override > team default > running-server
    // model. The old code used effectiveTeamModel alone, which ignored
    // a per-orchestrator model change — so after switching the model
    // the chat kept dispatching to the previously-set one.
    const orchKeyForModel = activeTeam ? (findOrchestratorSpec(activeTeam)?.name ?? "orchestrator") : "orchestrator";
    const supModelId = modelFor(orchKeyForModel);
    const supProvider = providerFor(supModelId);

    // Echo the user message into the orchestrator's buffer too so the
    // right-pane Reply tab reads as a conversation thread, not just
    // the assistant side.
    {
      const orchSpec = activeTeam ? findOrchestratorSpec(activeTeam) : null;
      if (orchSpec) appendLog(orchSpec.name, userMsg);
    }

    try {
    // Lazy local-server start. If the resolved model is a llama-
    // server-backed local model AND the server isn't running on it,
    // auto-start it and poll until ready — user spec is "start
    // automatically when the user sends a message; no manual Server-
    // tab dance". Cloud models (claude-*, gpt-*) skip this block;
    // their dispatch hits api.anthropic.com / api.openai.com.
    if (supProvider === "local") {
      const alreadyOk =
        serverState.running &&
        serverState.model_id === supModelId &&
        !!serverState.port;
      if (!alreadyOk) {
        // Show a visible system message so the user knows we're
        // working (cold-load of a 7B+ GGUF on first send is 20-60 s;
        // without this the SuperUserCard just looked frozen and the
        // user thought their first message had been lost).
        const startMsg: GoalMsg = {
          role: "system", color: "#9ad9ff",
          text: `(starting local model '${supModelId}' — first send may take 20-60 s for cold-load)`,
        };
        setSupChat(prev => [...prev, startMsg]);
        appendLog("system", startMsg);
        const ok = await ensureLocalServer(supModelId);
        if (!ok) {
          const errMsg: GoalMsg = {
            role: "system", color: "#ff8c8c",
            text: `(failed to start local model '${supModelId}' — check the Server tab and retry)`,
          };
          setSupChat(prev => [...prev, errMsg]);
          appendLog("system", errMsg);
          return;
        }
      }
    }

    // Resolve the orchestrator's actual agent-name (varies per team)
    // so the OrchestratorPane / canvas pulse key off the same string
    // we route the message through.
    const orchSpec = activeTeam ? findOrchestratorSpec(activeTeam) : null;
    const orchKey = orchSpec?.name ?? "orchestrator";
    // serverState in the React closure is stale after the awaited
    // ensureLocalServer call above. Pull a fresh status so the port
    // we hand to streamChatCompletion is the just-started server's
    // port, not whatever was set when this handler started.
    const freshServerState = supProvider === "local"
      ? await invoke<ServerStatus>("server_status").catch(() => serverState)
      : serverState;
    console.log("[onSupSend] about to dispatch", {
      provider: supProvider,
      modelId: supModelId,
      orchKey,
      freshPort: freshServerState.port,
      freshRunning: freshServerState.running,
      freshModelId: freshServerState.model_id,
    });
    let criticReview = "";
    if (needsCriticalThinkerReview(text)) {
      const CRITIC_NAME = CRITIC_AGENT_NAME;
      addActive(CRITIC_NAME);
      appendLog(CRITIC_NAME, { role: CRITIC_NAME, color: "#ff9ad9", text: "" });
      appendThought(orchKey, {
        role: "dispatch",
        color: "#ff9ad9",
        text: `critical thinker review requested before orchestrator reply`,
      });
      try {
        criticReview = await streamChatCompletion(
          freshServerState.port ?? 0,
          supModelId,
          supProvider,
          buildCriticalThinkerReviewPrompt(activeTeam, directives),
          [
            "User message:",
            text,
            "",
            "Review what the orchestrator should not miss before it answers.",
          ].join("\n"),
          0.3,
          supSendAbort.signal,
          (delta) => { criticReview += delta; streamLog(CRITIC_NAME, delta); },
          runCwd,
          priorHistory,
          autoApprove,
          (channel, role, delta) => streamThought(CRITIC_NAME, channel, role, delta),
          READONLY_LOCAL_TOOLS,
          undefined,
          getClaudeSession(selectedProjectId, CRITIC_NAME),
        );
        criticReview = criticReview.trim();
      } catch (e: any) {
        criticReview = `(critical thinker failed: ${String(e?.message ?? e)})`;
        appendLog(CRITIC_NAME, { role: "system", color: "#ff8c8c", text: criticReview });
      } finally {
        removeActive(CRITIC_NAME);
      }
      speakAgentReply(CRITIC_NAME, criticReview);
    }

    // Visible diagnostic — the user reported "no info appearing, no
    // card highlighting, nothing" because they don't open DevTools
    // and the empty orchestrator entry just looks like "…". Surface
    // the routing decision as a system bubble so the user can SEE
    // which model / port / agent the message is going to BEFORE
    // streamChatCompletion fires. If the stream fails silently, this
    // bubble + the error bubble that follows give us a paper trail.
    const traceMsg: GoalMsg = {
      role: "system", color: "#9ad9ff",
      text: `→ dispatching to ${orchKey} · model=${supModelId} · provider=${supProvider}${supProvider === "local" ? ` · port=${freshServerState.port ?? 0}` : ""}`,
      ts: Date.now(),
    };
    setSupChat(prev => [...prev, traceMsg]);
    appendLog("system", traceMsg);
    const replyMsg: GoalMsg = { role: orchKey, color: "#ffd97a", text: "", ts: Date.now() };
    setSupChat(prev => [...prev, replyMsg]);
    appendLog(orchKey, replyMsg);
    // Active state — drives the per-node pulse in the canvas.
    console.log("[onSupSend] activating orchestrator", { orchKey });
    addActive(orchKey);
    // Track the streamed reply so we can forward it to Telegram once
    // the stream completes (desktop → phone mirror, opposite direction
    // of the Telegram → desktop mirror the bridge already does).
    let streamedReply = "";
    try {
      const sys = [
        activeTeam
          ? `You are the orchestrator of '${activeTeam.display}'.`
          : "You are the team's orchestrator.",
        "Answer the user concisely.",
        // Tool-use directive. Small local models tend to DESCRIBE their
        // toolbox and say "now let me test them" without ever emitting the
        // structured tool call, so the turn ends with no action taken (the
        // user sees a tool list, not results). Spell out that an action
        // request must be fulfilled BY CALLING THE TOOLS — one step at a
        // time, using each real result — and closed with a short report.
        "You have real, working tools: read/write/edit files, list directories, run Windows shell commands, and search/fetch the web. " +
        "When the user asks you to DO something (create or read a file, run a command, search the web), you MUST actually call the appropriate tool and use its REAL returned result — never just list your tools or describe what you would do. " +
        "Perform the request one step at a time: call a tool, wait for its result, then move to the next step. When every step is done, give the user a short report of what each tool actually returned.",
        `Critical Thinker is a real peer agent named ${CRITIC_AGENT_NAME}, not a mode of operation.`,
        "If the user's message mentions the critic or critical thinker, acknowledge whether that agent was invoked. Never say you are merely doing it implicitly.",
        criticReview ? `\nCritical Thinker review already produced:\n${criticReview}` : "",
      ].filter(Boolean).join("\n");
      // Live-strip the native `<|tool_call>…<tool_call|>` blocks and
      // the fabricated `_tool_output` chunks the small Llama-/Gemma-
      // trained models hallucinate. Without this, every streamed
      // token leaked the model's fake transcript into the chat — the
      // user's last paste showed `<tool_call name="glob">…<|tool_call>
      // call:web_search{…}<tool_call|><|tool_response>…_end_tool_output`
      // all rendered raw. We track how much CLEAN text has already
      // been pushed to the UI; on each delta we recompute the clean
      // view of streamedReply and emit only the new tail.
      let displayedClean = "";
      const liveStrip = (delta: string) => {
        // First real token means the model finished loading — clear
        // the "still loading" banner.
        setLlamaLoading(null);
        streamedReply += delta;
        const cleanFull = stripFabricatedToolOutput(streamedReply);
        if (cleanFull === displayedClean) return;  // pure noise stripped
        const diff = cleanFull.slice(displayedClean.length);
        displayedClean = cleanFull;
        // Always SET the entry's text to cleanFull (not append) so
        // when later chunks complete a `<|tool_call>` block we can
        // RETROACTIVELY remove it from the visible chat. The
        // previous append-only approach left partial tool markers
        // on screen forever.
        setSupChat(curr => {
          const out = curr.slice();
          const last = out[out.length - 1];
          if (last) out[out.length - 1] = { ...last, text: cleanFull };
          return out;
        });
        // Same for the agent-log buffer that drives the right pane.
        setAgentLogs(prev => {
          const cur = prev.get(orchKey) ?? [];
          if (cur.length === 0) return prev;
          let idx = cur.length - 1;
          while (idx >= 0 && cur[idx].role !== orchKey) idx -= 1;
          if (idx < 0) return prev;
          const next = new Map(prev);
          const updated = [...cur];
          updated[idx] = { ...updated[idx], text: cleanFull };
          next.set(orchKey, updated);
          return next;
        });
        // streamLog kept for any side-effects (active-set bookkeeping,
        // bridge mirroring) but now receives the diff for completeness.
        if (diff) streamLog(orchKey, "");  // no-op append; cleanFull set above
      };
      const returned = await streamChatCompletion(
        freshServerState.port ?? 0,
        supModelId,
        supProvider,
        sys,
        text,
        0.5,
        supSendAbort.signal,
        liveStrip,
        // Pin the Claude CLI subscription path (and any future tool-
        // capable backend) to the user's project location instead of
        // letting it inherit the desktop install dir.
        runCwd,
        priorHistory,
        autoApprove,
        // Surface thinking + tool-call deltas to the right-pane Thought
        // tab so the user can see the orchestrator reasoning + the
        // commands it asks tools to run (Anthropic API thinking blocks
        // & tool_use, OpenAI tool_calls, local <think> tags).
        (channel, role, delta) => streamThought(orchKey, channel, role, delta),
        undefined,        // allowedTools
        images,           // pasted images → native vision (API) / codex -i / claude file-ref
        // SuperUser orchestrator chat uses the same persistent session
        // as the team-Run orchestrator — they're the same logical agent.
        getClaudeSession(selectedProjectId, orchKey),
      );
      // Judge "did the user get an answer?" on the CLEAN, VISIBLE text — not
      // the raw stream. Small local models (e.g. abliterated Gemma) often emit
      // ONLY a hallucinated <tool_call>/_tool_output block; liveStrip correctly
      // removes it, so the visible reply is empty even though `streamedReply`
      // is non-empty raw junk. The old check tested the raw text, so neither
      // the reply NOR the "empty" notice showed — the chat just sat there doing
      // nothing. That's the "starts the model, then nothing happens" report.
      const cleanReply = stripFabricatedToolOutput(streamedReply).trim();
      const cleanReturned = stripFabricatedToolOutput(returned || "").trim();
      if (!cleanReply && cleanReturned) {
        // The clean blob came back on the function return rather than the
        // delta channel — show it.
        setSupChat(curr => {
          const out = curr.slice();
          const last = out[out.length - 1];
          if (last) out[out.length - 1] = { ...last, text: cleanReturned };
          return out;
        });
        streamLog(orchKey, cleanReturned);
      } else if (!cleanReply) {
        // Nothing readable. Distinguish "all output was stripped tool/format
        // junk" from "genuinely empty" so the user knows WHY and what to try.
        const emptyMsg = streamedReply.trim()
          ? "(the model produced only tool-call / formatting output with no readable answer — try rephrasing, or set a stronger model for this team's orchestrator on the card)"
          : "(the model returned an empty response — no answer was produced)";
        setSupChat(curr => [...curr, { role: "system", color: "#ff8c8c", text: emptyMsg, ts: Date.now() }]);
        appendLog("system", { role: "system", color: "#ff8c8c", text: emptyMsg });
      }
    } catch (e: any) {
      // Loud, on-screen error — the user has been hitting silent
      // failures on the first message and missing the cause because
      // it never reached the chat. Now both supChat (left/main) AND
      // the agent log (right pane) get the error in red.
      console.error("[onSupSend] streamChatCompletion threw", String(e?.message ?? e));
      const errMsg: GoalMsg = {
        role: "system", color: "#ff8c8c", text: `✗ Dispatch failed: ${cleanAgentError(e)}`,
        ts: Date.now(),
        // Attach the one-click WSL-restart recovery when it's a network failure.
        action: isNetworkAgentError(e) ? "wsl-restart" : undefined,
      };
      setSupChat(prev => [...prev, errMsg]);
      appendLog("system", errMsg);
      appendLog(orchKey, errMsg);
    } finally {
      removeActive(orchKey);
    }
    speakAgentReply(orchKey, streamedReply);
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
    } finally {
      supSendBusyRef.current = false;
      setSupSendBusy(false);
      setLlamaLoading(null);
      if (supSendAbortRef.current === supSendAbort) {
        supSendAbortRef.current = null;
      }
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
    // Persist so the pick survives tab switches AND restarts (#17.2).
    setAgentModelOverride(selectedProject?.id ?? "", agentName, modelId);
  };

  /// Resolve voice config for an agent. Falls back to DEFAULT_VOICE
  /// (disabled / Auto / default rate) when the user hasn't touched
  /// the controls yet.
  const voiceFor = (agentName: string): VoiceConfig =>
    perAgentVoice.get(agentName) ?? DEFAULT_VOICE;

  /// Patch a single agent's voice config. Partial so the checkbox /
  /// voice picker / rate input can all funnel through one setter.
  const onPickAgentVoice = (agentName: string, partial: Partial<VoiceConfig>) => {
    const merged = { ...(perAgentVoice.get(agentName) ?? DEFAULT_VOICE), ...partial };
    setPerAgentVoice(prev => {
      const next = new Map(prev);
      next.set(agentName, merged);
      return next;
    });
    // Persist so the agent's voice + rate survive tab switches AND restarts.
    setAgentVoiceOverride(selectedProject?.id ?? "", agentName, merged);
  };

  /// Speak an agent's full reply if voice is enabled for that agent.
  /// Called by dispatchGoal after each streamChatCompletion settles
  /// with the final assistant text. Empty strings and disabled voices
  /// are no-ops inside ttsSpeak — call sites don't need to guard.
  const speakAgentReply = (agentName: string, reply: string) => {
    ttsSpeak(voiceFor(agentName), agentName, reply);
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
      await invoke("server_start", { modelId: wanted, ctx: getServerCtx() });
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

  // Dock Load→Send moved below providerFor definition (see comment
  // there) to avoid the temporal-dead-zone crash the user hit
  // ('Cannot access "sn" before initialization').
  const [dockLoadingModel, setDockLoadingModel] = useState(false);
  const pendingSendRef = useRef<string>("");
  useEffect(() => {
    const onPark = (e: Event) => {
      const detail = (e as CustomEvent<{ text: string }>).detail;
      if (detail && typeof detail.text === "string") {
        pendingSendRef.current = detail.text;
      }
    };
    window.addEventListener("owllm:dock:park-draft", onPark as EventListener);
    return () => window.removeEventListener("owllm:dock:park-draft", onPark as EventListener);
  }, []);

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
      // Pure cloud entries — decide which provider by id prefix.
      if (bareId.startsWith("claude-")) return "anthropic";
      if (bareId.startsWith("gpt-") || bareId === "o3") return "openai";
      if (bareId.startsWith("kimi-") || bareId.startsWith("moonshot-")) return "moonshot";
      if (bareId.startsWith("gemini-")) return "gemini";
      if (bareId.startsWith("deepseek-")) return "deepseek";
      if (bareId.startsWith("grok-")) return "xai";
      // Groq's catalog overlaps with open-weight names (llama-*, qwen3-*,
      // gpt-oss-*). Match by exact id against the registry instead.
      const m = models.find(x => x.model_id === bareId);
      if (m?.provider) return m.provider;
      if (bareId.startsWith("sonar")) return "perplexity";
      if (bareId.startsWith("mistral-") || bareId.startsWith("magistral-") || bareId.startsWith("codestral-")) return "mistral";
      if (bareId.includes("/")) return "together"; // Together uses "owner/model" ids.
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

  // ====== Deterministic Load → Send (user spec 2026-05-30) ======
  // Placed after providerFor/modelFor/effectiveTeamModel so const
  // refs resolve at module-init time. The previous placement up by
  // ensureLocalServer triggered a temporal-dead-zone crash
  // ('Cannot access "sn" before initialization') when React rendered
  // the right column.
  // Resolve the dock's model the SAME way onSupSend dispatches it —
  // modelFor(orchestrator), which honours per-agent override > team
  // default > server model. (Was effectiveTeamModel-first, which
  // ignored a per-orchestrator override, so the Load button and the
  // send could disagree on which model to use.)
  const dockModelId = (activeTeam
    ? modelFor(findOrchestratorSpec(activeTeam)?.name ?? "orchestrator")
    : effectiveTeamModel
    || "").trim();
  const dockProvider = dockModelId ? providerFor(dockModelId) : "local";
  const dockNeedsLoad =
    dockProvider === "local" &&
    dockModelId.length > 0 &&
    !(serverState.running && serverState.model_id === dockModelId && !!serverState.port);
  const dockLoadModel = async () => {
    if (dockLoadingModel) return;
    if (!dockModelId) return;
    setDockLoadingModel(true);
    try {
      const startMsg: GoalMsg = {
        role: "system", color: "#9ad9ff",
        text: `⚡ Loading local model '${dockModelId}' — first send will fire when it's ready.`,
      };
      setSupChat(prev => [...prev, startMsg]);
      // Attach the llama-ready listener BEFORE starting the server so
      // we can't miss the event if the model loads very fast. The
      // backend emits {model_id, port, elapsed_ms} the instant
      // /health flips 503 → 200.
      const readyPromise = new Promise<number>((resolve, reject) => {
        let unlisten: (() => void) | null = null;
        const t = window.setTimeout(() => {
          unlisten?.();
          reject(new Error("Timed out waiting for /health (10 min)"));
        }, 600_000);
        listen<{ model_id: string; port: number; elapsed_ms: number }>("llama-ready", (evt) => {
          if (evt.payload.model_id !== dockModelId) return;
          window.clearTimeout(t);
          unlisten?.();
          resolve(evt.payload.elapsed_ms);
        }).then(u => { unlisten = u; });
      });
      const ok = await ensureLocalServer(dockModelId, 180_000);
      if (!ok) {
        const errMsg: GoalMsg = {
          role: "system", color: "#ff8c8c",
          text: `✗ Failed to start local model '${dockModelId}' — check the Server tab and retry.`,
        };
        setSupChat(prev => [...prev, errMsg]);
        return;
      }
      let readyMs = 0;
      try {
        readyMs = await readyPromise;
      } catch (e) {
        const errMsg: GoalMsg = {
          role: "system", color: "#ff8c8c",
          text: `✗ Model '${dockModelId}' did not become ready: ${String(e)}`,
        };
        setSupChat(prev => [...prev, errMsg]);
        return;
      }
      const ready: GoalMsg = {
        role: "system", color: "#5af09c",
        text: `✓ Model '${dockModelId}' ready in ${(readyMs / 1000).toFixed(1)}s.`,
      };
      setSupChat(prev => [...prev, ready]);
      const text = pendingSendRef.current.trim();
      pendingSendRef.current = "";
      if (text) onSupSend(text);
    } finally {
      setDockLoadingModel(false);
    }
  };

  const [tgStarted, setTgStarted] = useState<boolean>(false);

  const bridgeOn = useMemo(() => {
    if (!selectedProject) return false;
    const t = bridges.telegram;
    return tgStarted && !!t?.bot_token && t?.project_id === selectedProject.id;
  }, [bridges, selectedProject, tgStarted]);

  // ===== Dispatch loop =====
  // Run a multi-agent dispatch end-to-end:
  //   1. Plan      — orchestrator streams its plan + dispatch directives
  //   2. Dispatch  — one specialist per parsed `@agent: instruction` line
  //   3. Integrate — orchestrator gets one more turn with all replies
  // Each phase streams into the matching per-agent log buffer; the
  // canvas's `activeAgent` highlights whichever agent is on stage.
  async function dispatchGoal(overrideText?: string, priorHistory?: HistoryItem[]) {
    setRunError(null);
    // overrideText is passed when the SuperUser CHAT routes a message
    // through the team flow (so the orchestrator dispatches instead of
    // answering solo). Guard against React handing this a click Event
    // when it's wired directly as the onRun handler.
    const text = (typeof overrideText === "string" ? overrideText : goal).trim();
    if (!text) return;
    // Key the shared team memory by this project's stable ID so it matches across
    // machines (and syncs via the vault) rather than by the per-PC folder path.
    setTeamMemoryScope(selectedProjectId);
    // Warm the shared-memory snapshot so it's injected into the orchestrator's and
    // every specialist's prompt this run (readable on every model path).
    await refreshTeamMemorySnapshot();
    // A goal dispatch is heavy (worktrees, commits, fan-out). Refuse to start
    // a second on top of one already running for THIS project — including one
    // still running in the background after the user changed pages. We read
    // the live store snapshot (not the captured render value) so the guard
    // holds even on a freshly-remounted page whose local `busy` reset to false.
    const liveRun = chatRuntime.getSnapshot(agentSessId).payload as AgentRunPayload | null;
    if (dispatchInFlightRef.current || busy || liveRun?.running) {
      setRunError("A run is already in progress for this project.");
      return;
    }
    // Claim the slot synchronously — closes the check-then-await race that let
    // two concurrent dispatches slip through before setBusy/setRunning fired.
    // Cleared in the finally below AND on every pre-flight early return.
    dispatchInFlightRef.current = true;
    // PRE-FLIGHT: warm WSL + verify the project folder is actually reachable before
    // we dispatch. After a PC reboot WSL comes back COLD (distro not started, /mnt
    // not mounted), so an isolated project's folder — reached through WSL — is
    // temporarily unreachable. Without this the run would silently fall into an
    // empty scratch dir and the agents would report "can't find the code" (a real
    // regression after a reboot). The check itself STARTS the distro / mounts /mnt,
    // so a single retry usually recovers it; if it's still unreachable we STOP with
    // a clear message instead of sending agents into an empty box. Files on disk are
    // never touched — this is only about reachability.
    if (runCwd && runCwd.trim()) {
      let reachable = await invoke<boolean>("sandbox_warm_and_check", { cwd: runCwd }).catch(() => true);
      if (!reachable) {
        // The first call started the distro / mounted /mnt — try once more.
        reachable = await invoke<boolean>("sandbox_warm_and_check", { cwd: runCwd }).catch(() => true);
      }
      if (!reachable) {
        setRunError(
          `Project folder isn't reachable yet: ${rawLocation || runCwd}. ` +
          `If you just rebooted, WSL is still starting up — wait a few seconds and run again. ` +
          `Your files on disk are safe.`,
        );
        dispatchInFlightRef.current = false;
        return;
      }
    }
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
      // Fallback chain so Send always works when local is needed:
      //   1. Explicit pick (per-agent / team-default / orchestrator).
      //   2. Whatever the local server is already serving (lets the
      //      user re-use a model loaded by Chat / Server tabs).
      //   3. First servable local/tuned model in the registry — auto-
      //      pick so a fresh team with no model_id assigned still runs.
      let wantedLocal = localCandidates[0]?.trim() || "";
      if (!wantedLocal && serverState.model_id && isLocallyServed(providerFor(serverState.model_id))) {
        wantedLocal = serverState.model_id;
      }
      if (!wantedLocal) {
        const fallback = models.find(m => isLocallyServed(m.provider) && m.port != null);
        if (fallback) wantedLocal = fallback.model_id;
      }
      if (!wantedLocal) {
        setRunError("This team uses local model(s) but none are installed. Open the Models tab and add a local or tuned model first.");
        dispatchInFlightRef.current = false;
        return;
      }
      if (!serverState.running || !serverState.port || serverState.model_id !== wantedLocal) {
        setPhase("planning");
        setRunError(`Starting local server (${wantedLocal})…`);
        const ok = await ensureLocalServer(wantedLocal);
        if (!ok) {
          setRunError(`Local server failed to start for "${wantedLocal}" within 90s — try the Server tab manually.`);
          dispatchInFlightRef.current = false;
          return;
        }
        setRunError(null);
      }
    }
    if (!activeTeam || activeTeam.agents.length === 0) {
      setRunError("No team is loaded. Pick a team via 'Team…' or select a project with a roster.");
      dispatchInFlightRef.current = false;
      return;
    }

    // Wipe the per-agent card/thought buffers ONLY for a fresh Run-button
    // dispatch. A CHAT message (onSupSend passes priorHistory — even [] for the
    // first turn) is a CONTINUATION of the SAME conversation: wiping there
    // deleted every agent's prior reply from its card on each send (the "all
    // the history is deleted when I send a message" bug, and why clicking an
    // agent right after a send showed only system notices). Keep the buffers so
    // the cards build a running conversation. supChat is preserved either way.
    if (priorHistory === undefined) {
      setAgentLogs(new Map());
      setAgentThoughts(new Map());
    }
    setRunError(null);
    setBusy(true);
    ranWriteToolRef.current = false; // reset the "real work happened" signal for this run
    lastGateRef.current = null;      // reset the per-agent gate result for this run
    runTraceRef.current = { goal: text, t0: Date.now(), agents: new Map(),
      routeCorrections: 0, oscillationStops: 0, capHit: false, criticVerdict: null };
    setRunning(true); // store-backed: survives a page change so the run isn't orphaned
    // Start the team stopwatch + reset per-agent clocks for this run.
    setRunStartedAt(Date.now());
    setRunEndedAt(null);
    setAgentTiming(new Map());
    setPhase("planning");
    // Snapshot + clear the chip strip now. The orchestrator owns these
    // bytes for the rest of the run; the UI strip should feel "spent".
    const runAttachments = attachments;
    if (attachments.length > 0) setAttachments([]);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    agentRunAborts.set(agentSessId, ctrl); // reachable by Cancel after a page change

    const orch = findOrchestratorSpec(activeTeam)!;

    // Auto-adjust the team into a structurally-valid config before running:
    // wire any agent that's unreachable from the orchestrator (its dispatches
    // would otherwise be silently dropped), drop dead/duplicate edges, and
    // surface what changed + what's missing (e.g. "no specialist can write
    // files"). Pure + idempotent — see teamConfig.normalizeTeam. The run uses
    // `runTeam` for all edge-driven logic (roster, wiring, hand-offs).
    const { team: runTeam, changes: teamFixes, warnings: teamWarnings } =
      normalizeTeam(activeTeam, roleByName);
    for (const c of teamFixes) {
      appendThought(orch.name, { role: "system", color: "#7ff0c5", text: `🧩 auto-config: ${c}` });
    }
    for (const w of teamWarnings) {
      appendThought(orch.name, { role: "system", color: "#ffb74d", text: `⚠ team config: ${w}` });
      setSupChat(prev => [...prev, { role: "system", color: "#ffb74d", text: `⚠ ${w}`, ts: Date.now() }]);
    }

    // Cloud calls don't need a port; only the local fallback does. Pull a FRESH
    // server status here — `serverState` is the render-time closure value and is
    // still STALE right after ensureLocalServer started the server, so the FIRST
    // run read port 0 and every request "Failed to fetch" → the run finished
    // empty ("Done with no output"). It only "worked the second time" because the
    // component had re-rendered with the real port by then. onSupSend already did
    // this fresh-pull; dispatchGoal didn't.
    const freshStatus = await invoke<ServerStatus>("server_status").catch(() => serverState);
    setServerState(freshStatus);
    const port = freshStatus.port ?? 0;

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
    let projectCwd = runCwd;
    // Host-path reachability fallback. ONLY for non-WSL paths: a WSL isolation
    // path (`\\wsl.localhost\...`) runs via wsl.exe, and Windows can't reliably
    // stat that UNC even when the distro is perfectly healthy — checking it here
    // wrongly downgraded WORKING isolation to host/no-sandbox (the "isolated but
    // system sees different" bug). For a plain host folder that genuinely doesn't
    // exist, fall back to no cwd with one clear note.
    if (projectCwd && !isWslPath(projectCwd)) {
      const reachable = await invoke<boolean>("path_is_dir", { path: projectCwd }).catch(() => false);
      if (!reachable) {
        const hostLoc = (locationOverride || selectedProject?.location || "").trim();
        const hostOk = !!hostLoc && hostLoc !== projectCwd
          && await invoke<boolean>("path_is_dir", { path: hostLoc }).catch(() => false);
        if (hostOk) {
          appendThought(orch.name, { role: "system", color: "#ffb74d",
            text: `🛡 WSL isolation path not reachable — running on the host folder ${hostLoc} (no sandbox this run).` });
          projectCwd = hostLoc;
        } else {
          appendThought(orch.name, { role: "system", color: "#ffb74d",
            text: `📁 Project folder "${projectCwd}" not found — agents run without a project directory.` });
          projectCwd = "";
        }
      }
    }

    // Load BRIEF.md if the brainstormer wrote one for this project.
    // Best-effort: missing file is silent (legacy behaviour), so
    // pre-brainstorm projects keep working. Read via tool_read_file
    // so the path resolution matches what the agents see.
    let briefText = "";
    if (projectCwd) {
      try {
        briefText = await invoke<string>("tool_read_file", {
          path: "BRIEF.md", cwd: projectCwd,
        });
      } catch { /* no brief yet — proceed without */ }
    }

    try {
      // ----- Phase 1: orchestrator plan + dispatches -----
      addActive(orch.name);
      // Parallel mode: load the (seeded, user-editable) parallel-dispatch skill so
      // its body drives the orchestrator's PARALLEL DISPATCH guidance. If the user
      // edited it in Studio, that's what the orchestrator follows; if it's missing,
      // buildOrchestratorPrompt falls back to its baked-in default.
      let parallelGuidance: string | undefined;
      if (parallelMode) {
        try {
          const pp = await resolveAgentSkills(["owllm__parallel-dispatch"]);
          if (pp.length && pp[0].body.trim()) parallelGuidance = pp[0].body;
        } catch { /* fall back to the baked-in default */ }
      }
      // The orchestrator consumes its OWN equipped skills exactly like specialists
      // do — so any skill (incl. downloaded community/Anthropic packs) equipped on
      // the orchestrator is injected, not silently dropped. Same id sources as the
      // specialist path: role allowlist + team extras + per-project grant.
      const orchSkillIds = [
        ...(roleByName.get(orch.base)?.skillAllowlist ?? []),
        ...(orch.extraSkills ?? []),
        ...(perAgentSkills.get(orch.name) ?? []),
      ];
      const orchSkillBlock = await buildAgentSkillBlock(orchSkillIds);
      const orchPrompt = buildOrchestratorPrompt(runTeam, roleByName, orch, directives, directorMode, briefText, parallelMode, parallelGuidance, orchSkillBlock, perAgentSkills, projectCwd);
      appendLog(orch.name, { role: orch.name, color: "#ffd97a", text: "" });
      const orchModel = modelFor(orch.name);
      let orchReply: string;
      try {
        orchReply = await streamChatCompletion(
          port, orchModel, providerFor(orchModel),
          orchPrompt, text, tempFor(orch, 0.4), ctrl.signal,
          (delta) => streamLog(orch.name, delta),
          projectCwd,
          // history: prior turns so the orchestrator remembers the conversation
          // (essential for local-model orchestrators, which have no session memory).
          priorHistory, undefined,
          (channel, role, delta) => streamThought(orch.name, channel, role, delta),
          READONLY_LOCAL_TOOLS,
          // User-attached images/audio ride with the orchestrator only.
          // Specialists receive the orchestrator's reply (text), so they
          // don't need the raw bytes.
          runAttachments.length > 0 ? runAttachments : undefined,
          // Persistent CLI session for the orchestrator across dispatches.
          getClaudeSession(selectedProjectId, orch.name),
          // Visible warning when CLI subscription path + images — emits
          // a yellow system note in the orchestrator's chat log so the
          // user sees exactly why their image didn't make it to the
          // model and how to fix it.
          (warning) => {
            appendLog(orch.name, { role: "system", color: "#ffd97a", text: warning });
            setSupChat(curr => [...curr, { role: "system", color: "#ffd97a", text: warning }]);
          },
          // Transcription ready — show what the user actually said in
          // their chat right after the audio attachment placeholder.
          // Green YOU bubble so it visually parallels their own input.
          (_filename, text) => {
            const tMsg: GoalMsg = { role: "you", color: "#9af0a8", text: `🎤 ${text}` };
            setSupChat(curr => [...curr, tMsg]);
            appendLog("you", tMsg);
            appendLog(orch.name, tMsg);
          },
        );
      } finally {
        removeActive(orch.name);
      }
      speakAgentReply(orch.name, orchReply);
      // Persist any `[REMEMBER ...]` facts the orchestrator wrote while planning.
      await harvestMemoryWrites(orchReply);

      // Critical-thinker interception: if the orchestrator asks for
      // @critical_thinker or [NEED_USER_INPUT], route it to the real
      // Critical Thinker agent and then re-run the orchestrator with
      // that answer folded in. This must NOT be gated by Director
      // Mode; explicit critical-thinker requests should always fire.
      let criticWasConsulted = false;
      {
        const { question, cleaned } = extractUserInputRequest(orchReply);
        if (question) {
          criticWasConsulted = true;
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
              READONLY_LOCAL_TOOLS,
            );
            criticReply = (criticReply || "(no answer)").trim();
          } catch (e: any) {
            criticReply = `(critic error: ${String(e?.message ?? e)} — proceeding with best guess)`;
            appendLog(CRITIC_NAME, { role: "system", color: "#ff8c8c", text: criticReply });
          } finally {
            removeActive(CRITIC_NAME);
          }
          speakAgentReply(CRITIC_NAME, criticReply);
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
              READONLY_LOCAL_TOOLS,
              undefined,
              getClaudeSession(selectedProjectId, orch.name),
            );
          } finally {
            removeActive(orch.name);
          }
          speakAgentReply(orch.name, orchReply);
          // Silence unused-warning for cleaned in non-debug builds —
          // we intentionally don't surface it (the cleaned plan is
          // already in the orchestrator's log via streamLog deltas).
          void cleaned;
        }
      }

      // Critical Thinker — pre-dispatch review. It brainstorms the orchestrator's
      // plan and the orchestrator re-plans after each round. Two modes:
      //   • Advisory (default): up to 2 rounds, then dispatch NO MATTER WHAT. It
      //     can never block — a refusal or a "no concerns" verdict just ends the
      //     loop. This is the Red-Team safety guarantee: a guarded (non-abliterated)
      //     critic cannot stall a sanctioned abliterate / red-team run.
      //   • Critic = Super User: the user delegated the decision to the critic, so
      //     it gets up to 3 rounds to gate the plan and the orchestrator is told to
      //     satisfy it. Still hard-capped so it can't loop forever.
      // Director mode forces a review even if the orchestrator never says "critic".
      if (!criticWasConsulted && (directorMode || needsCriticalThinkerReview(`${text}\n${orchReply}`))) {
        const CRITIC_NAME = CRITIC_AGENT_NAME;
        const MAX_PRE_ROUNDS = directorMode ? 3 : 2;
        for (let round = 0; round < MAX_PRE_ROUNDS && !ctrl.signal.aborted; round++) {
          appendThought(orch.name, {
            role: "dispatch", color: "#ff9ad9",
            text: round === 0
              ? `critical thinker review before specialist dispatch${directorMode ? " (super user — it decides)" : ""}`
              : `critical thinker follow-up (round ${round + 1}/${MAX_PRE_ROUNDS})`,
          });
          addActive(CRITIC_NAME);
          appendLog(CRITIC_NAME, { role: CRITIC_NAME, color: "#ff9ad9", text: "" });
          let criticReview = "";
          let criticFailed = false;
          try {
            const criticModel = modelFor(CRITIC_NAME);
            criticReview = await streamChatCompletion(
              port, criticModel, providerFor(criticModel),
              buildCriticalThinkerReviewPrompt(activeTeam, directives),
              [
                "The user's goal:",
                text,
                "",
                "The orchestrator's current plan:",
                orchReply,
                "",
                directorMode
                  ? "You are the Super User — the user delegated this decision to you. Approve the plan, or list the concrete changes you require. If it is ready, say 'no concerns' plainly."
                  : "Brainstorm with the orchestrator before implementation. Challenge architecture decisions, missing specialists, hidden assumptions, and safer alternatives. If you have no remaining concerns, say 'no concerns'.",
              ].join("\n"),
              0.3, ctrl.signal,
              (delta) => { criticReview += delta; streamLog(CRITIC_NAME, delta); },
              projectCwd,
              undefined, undefined,
              (channel, role, delta) => streamThought(CRITIC_NAME, channel, role, delta),
              READONLY_LOCAL_TOOLS,
              undefined,
              getClaudeSession(selectedProjectId, CRITIC_NAME),
            );
          } catch (e: any) {
            if (ctrl.signal.aborted) throw e; // user cancelled → stop the run
            // The Critical Thinker is ADVISORY — if its model fails (e.g. an
            // expired Claude subscription → 401) the run must NOT crash. Note it
            // and dispatch anyway, exactly as if the critic had nothing to add.
            const msg = cleanAgentError(e);
            appendThought(orch.name, { role: "system", color: "#ff8c8c", text: `⚠ Critical Thinker unavailable (${msg}) — proceeding without its review.` });
            appendLog(CRITIC_NAME, { role: "system", color: "#ff8c8c", text: `⚠ ${msg}` });
            setSupChat(prev => [...prev, { role: "system", color: "#ffb74d", text: `⚠ Critical Thinker skipped: ${msg} (check the model on its card / re-auth the subscription).`, ts: Date.now() }]);
            criticReview = "";
            criticFailed = true;
          } finally {
            removeActive(CRITIC_NAME);
          }
          if (criticFailed) break; // advisory — proceed without it
          speakAgentReply(CRITIC_NAME, criticReview);
          const review = criticReview.trim();
          // The critic CANNOT hard-block: a refusal (a guarded critic objecting to
          // a sanctioned Red-Team task) or a satisfied verdict ends the loop and the
          // team dispatches regardless. A refusal is noted, never treated as a veto.
          if (!review) break;
          if (criticRefused(review)) {
            appendThought(orch.name, { role: "system", color: "#ffb74d", text: `Critical Thinker declined to engage — proceeding (it is advisory, not a gate).` });
            break;
          }
          if (criticIsSatisfied(review)) break; // approved / nothing to change
          // Substantive feedback → orchestrator incorporates, then we loop and the
          // critic reviews the UPDATED plan (until satisfied or the round cap).
          addActive(orch.name);
          appendLog(orch.name, { role: orch.name, color: "#ffd97a", text: "" });
          try {
            orchReply = await streamChatCompletion(
              port, orchModel, providerFor(orchModel),
              orchPrompt,
              directorMode
                ? `${text}\n\nThe Critic (acting as Super User — the user delegated the decision to it) requires these changes before dispatch:\n${review}\n\nApply them, then dispatch specialists.`
                : `${text}\n\nCritical Thinker review (advisory — you decide what to use; you dispatch regardless):\n${review}\n\nRevise your plan if useful, then dispatch specialists.`,
              tempFor(orch, 0.4), ctrl.signal,
              (delta) => streamLog(orch.name, delta),
              projectCwd,
              undefined, undefined,
              (channel, role, delta) => streamThought(orch.name, channel, role, delta),
              READONLY_LOCAL_TOOLS,
              undefined,
              getClaudeSession(selectedProjectId, orch.name),
            );
          } finally {
            removeActive(orch.name);
          }
          speakAgentReply(orch.name, orchReply);
        }
      }

      // Mirror to the SuperUserCard so the user-facing thread shows
      // the orchestrator's plan + (later) the integrated answer.
      setSupChat(prev => [
        ...prev,
        { role: "you", color: "#9ad9ff", text },
      ]);

      // ----- Phase 2: parse + dispatch -----
      // Parse @agent: lines, then drop any that name a known TOOL (weak models
      // emit "@read_file:" / "@web_search:" by mistake) so they don't dispatch
      // or trigger a noisy correction round — the real specialists survive.
      const parseTeamDispatches = (reply: string) => {
        const p = parseDispatchesDetailed(reply, runTeam, orch.name);
        return {
          dispatches: p.dispatches.filter(d => !DISPATCH_TOOL_NAMES.has(d.agentName)),
          unresolved: p.unresolved.filter(u => !DISPATCH_TOOL_NAMES.has(u.name)),
        };
      };
      let parse = parseTeamDispatches(orchReply);

      // Unresolved @names: fail LOUD (P1-3) — surface each one, and when
      // they cost us ALL dispatches, feed a correction back to the
      // orchestrator for ONE re-emit round instead of silently
      // under-delivering.
      if (parse.unresolved.length > 0) {
        for (const u of parse.unresolved) {
          appendThought(orch.name, {
            role: "system", color: "#ff8c8c",
            text: `⚠ "@${u.name}:" names no agent on this team${u.suggestion ? ` — did you mean '@${u.suggestion}:'?` : ""} (line NOT dispatched)`,
          });
        }
        if (parse.dispatches.length === 0) {
          const correction = unresolvedCorrectionMessage(parse.unresolved, activeTeam, orch.name);
          appendLog("system", { role: "system", color: "#ff8c8c", text: `⚠ Dispatch lines named unknown agents — asking the orchestrator to re-emit with real names.` });
          addActive(orch.name);
          appendLog(orch.name, { role: orch.name, color: "#ffd97a", text: "" });
          try {
            orchReply = await streamChatCompletion(
              port, orchModel, providerFor(orchModel),
              orchPrompt,
              correction,
              tempFor(orch, 0.3), ctrl.signal,
              (delta) => streamLog(orch.name, delta),
              projectCwd,
              undefined, undefined,
              (channel, role, delta) => streamThought(orch.name, channel, role, delta),
              READONLY_LOCAL_TOOLS,
              undefined,
              getClaudeSession(selectedProjectId, orch.name),
            );
          } finally {
            removeActive(orch.name);
          }
          parse = parseTeamDispatches(orchReply);
          for (const u of parse.unresolved) {
            appendThought(orch.name, {
              role: "system", color: "#ff8c8c",
              text: `⚠ still unresolved after correction: "@${u.name}:"${u.suggestion ? ` (nearest: '${u.suggestion}')` : ""}`,
            });
          }
        }
      }

      // Edges drive dispatch (P0-2, §0.4 lockstep with dispatch.ts): with a
      // graph present only edge-wired targets run; unwired-but-real names
      // surface loudly + one correction round when they cost us everything.
      let dispatches = parse.dispatches;
      const wiredSet = wiredDispatchTargets(runTeam, orch.name);
      if (wiredSet !== null) {
        const unwiredD = dispatches.filter(d => !wiredSet.has(d.agentName));
        dispatches = dispatches.filter(d => wiredSet.has(d.agentName));
        for (const d of unwiredD) {
          appendThought(orch.name, {
            role: "system", color: "#ffb74d",
            text: `⚠ @${d.agentName} is on the team but NOT WIRED to the orchestrator — line not dispatched. Draw the edge in the graph to enable it.`,
          });
        }
        if (dispatches.length === 0 && unwiredD.length > 0) {
          const correction = unwiredCorrectionMessage(unwiredD, wiredSet);
          appendLog("system", { role: "system", color: "#ffb74d", text: "⚠ Dispatches blocked by the team graph — asking the orchestrator to re-emit with wired agents only." });
          addActive(orch.name);
          appendLog(orch.name, { role: orch.name, color: "#ffd97a", text: "" });
          try {
            orchReply = await streamChatCompletion(
              port, orchModel, providerFor(orchModel),
              orchPrompt,
              correction,
              tempFor(orch, 0.3), ctrl.signal,
              (delta) => streamLog(orch.name, delta),
              projectCwd,
              undefined, undefined,
              (channel, role, delta) => streamThought(orch.name, channel, role, delta),
              READONLY_LOCAL_TOOLS,
              undefined,
              getClaudeSession(selectedProjectId, orch.name),
            );
          } finally {
            removeActive(orch.name);
          }
          const reparse = parseTeamDispatches(orchReply);
          dispatches = reparse.dispatches.filter(d => wiredSet.has(d.agentName));
          for (const d of reparse.dispatches.filter(x => !wiredSet.has(x.agentName))) {
            appendThought(orch.name, {
              role: "system", color: "#ffb74d",
              text: `⚠ still unwired after correction: @${d.agentName} — not dispatched.`,
            });
          }
        }
      }

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
        // FALLBACK (one hop, can't recurse — this runs once from the initial
        // parse and dispatches a SPECIALIST, never the orchestrator again).
        // A weak orchestrator that answered solo or named only bogus agents
        // would otherwise dead-end the whole team. Rather than give up, auto-
        // route the user's goal to the single best available specialist so the
        // team actually DOES something. Prefer one that can produce artifacts
        // (write/edit/shell) over a read-only one.
        const wired = wiredDispatchTargets(runTeam, orch.name); // null = no graph → all dispatchable
        const candidates = runTeam.agents.filter(a =>
          a.name !== orch.name &&
          a.name !== CRITIC_AGENT_NAME &&
          (wired === null || wired.has(a.name)));
        // Deterministic capability match (HARNESS, not prose): for a code/fix/ship
        // goal this returns a coder / write-capable non-design agent and NEVER the
        // read-only design leader. Was a positional "first writable" pick, which in
        // a design-led team grabbed the Product Owner for a bug fix.
        const best = bestAgentForGoal(candidates, text, roleByName) ?? candidates[0];
        if (best) {
          appendThought(orch.name, { role: "system", color: "#ffb74d",
            text: `⚠ Orchestrator didn't route to anyone — auto-dispatching the goal to @${best.name} so the team acts (it answered solo / named no real agent).` });
          setSupChat(prev => [...prev, { role: "system", color: "#ffb74d",
            text: `⚠ Orchestrator answered solo — auto-routed the goal to @${best.name}.`, ts: Date.now() }]);
          dispatches = [{ agentName: best.name, instruction:
            `The orchestrator did not route this to a specialist. Carry out the user's goal yourself, directly and concretely:\n\n${text}` }];
          if (runTraceRef.current) runTraceRef.current.routeCorrections++;
          // fall through to Phase 2 with this single dispatch.
        } else {
          // Genuinely no specialist to route to → keep the loud solo notice.
          const clean = stripDispatchDirectives(orchReply).trim();
          const noteText = parse.unresolved.length > 0
            ? `🚫 0 dispatches ran — the orchestrator named agents that don't exist (${parse.unresolved.map(u => "@" + u.name).join(", ")}) and there's no specialist to fall back to.`
            : "🚫 0 dispatches parsed — orchestrator answered solo, and this team has no specialist to route to. Add a specialist or rephrase the goal.";
          appendThought(orch.name, { role: "system", color: "#ff8c8c", text: noteText });
          appendLog("system", { role: "system", color: "#ff8c8c", text: noteText });
          setSupChat(prev => [
            ...prev,
            { role: "system", color: "#ff8c8c", text: "⚠ Specialists did not run — orchestrator answered solo. See system log.", ts: Date.now() },
            { role: "orchestrator", color: "#ffd97a", text: clean || orchReply, ts: Date.now() },
          ]);
          setPhase("done");
          return;
        }
      }

      // HARNESS ROUTE-CORRECTION (control flow in code, not prose): a code / docs /
      // ops goal MUST reach a write-capable, non-design specialist. If the
      // orchestrator only dispatched design/read-only agents (the recurring
      // "Product Owner got my bug fix and nothing shipped" failure), deterministically
      // add the right specialist so the actual work gets done. Design/general goals
      // are left exactly as the orchestrator planned.
      {
        const goalKind = classifyGoal(text);
        if (goalKind === "code" || goalKind === "docs" || goalKind === "ops") {
          const dispatchedNames = new Set(dispatches.map(d => d.agentName));
          const hasCapable = dispatches.some(d => {
            const spec = runTeam.agents.find(a => a.name === d.agentName);
            return spec && roleCanWrite(roleByName.get(spec.base)) && agentDomain(spec) !== "design";
          });
          if (!hasCapable) {
            const wiredC = wiredDispatchTargets(runTeam, orch.name);
            const pool = runTeam.agents.filter(a =>
              a.name !== orch.name && a.name !== CRITIC_AGENT_NAME &&
              !dispatchedNames.has(a.name) &&
              (wiredC === null || wiredC.has(a.name)));
            const writer = bestAgentForGoal(pool, text, roleByName);
            if (writer && roleCanWrite(roleByName.get(writer.base)) && agentDomain(writer) !== "design") {
              const note = `⚙ Routed the actual ${goalKind} work to @${writer.name} — the orchestrator dispatched only design/read-only agents, which can't change code.`;
              appendThought(orch.name, { role: "system", color: "#ffb74d", text: note });
              setSupChat(prev => [...prev, { role: "system", color: "#ffb74d", text: note, ts: Date.now() }]);
              dispatches.push({ agentName: writer.name, instruction:
                `Carry out the user's goal directly and concretely — make the change, run it/verify it, and report exactly what you did (commands + result):\n\n${text}` });
              if (runTraceRef.current) runTraceRef.current.routeCorrections++;
            }
          }
        }
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
      // Per-agent git worktrees are a Windows-side operation; they can't be
      // created on a `\\wsl.localhost\...` path (Windows can't reach it). For a
      // WSL-isolated project the agents already run sealed inside the distro via
      // wsl.exe — so skip the worktree step entirely and run them shared in the
      // WSL folder. Isolation is preserved; we just don't sub-isolate per agent.
      const wslShared = isWslPath(projectCwd);
      if (wslShared) {
        appendThought(orch.name, { role: "fleet", color: "#7ff0c5",
          text: `🗂 WSL-isolated project — agents run sealed inside the distro (shared worktree).` });
      }
      // Per-agent worktrees exist ONLY to stop CONCURRENT agents from colliding on
      // the same files. A sequential run (the default) has no concurrency, so it
      // needs none — running in the project dir directly avoids cutting a full
      // working-tree copy per agent on every run (the leftover-folders the user
      // hit). Only a parallel run with >1 agent actually needs isolation.
      const needWorktrees = !wslShared && parallelMode && dispatches.length > 1;
      // Reclaim any worktrees a PAST/crashed run left behind before making new
      // ones — per-run cleanup misses a run that crashed before its finally{}.
      if (!wslShared) {
        try {
          const n = await invoke<number>("fleet_cleanup_orphans", { projectCwd });
          if (n > 0) appendThought(orch.name, { role: "fleet", color: "#7ff0c5", text: `🧹 reclaimed ${n} leftover worktree(s) from a previous run.` });
        } catch { /* best-effort */ }
      }
      // Surface a "🗂 isolated" or "🗂 shared" line in the orchestrator's
      // Thought tab per dispatch so the user can see what happened.
      for (const d of dispatches) {
        if (!needWorktrees) { worktreeBySpec.set(d.agentName, null); continue; }
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
      // Surface a parallel wave in the user thread so concurrency is visible
      // (Stage 1 "surface"). A single dispatch reads as the usual sequential step.
      if (dispatches.length > 1) {
        setSupChat(prev => [...prev, {
          role: "system", color: "#7fd4ff",
          text: `▶ Running ${dispatches.length} agents in parallel: ${dispatches.map(d => "@" + d.agentName).join(", ")}`,
          ts: Date.now(),
        }]);
      }
      type SpecOutcome = {
        name: string;                                   // START agent (owns the worktree/branch)
        replies: { name: string; text: string }[];      // terminal results from the whole fan-out tree
        worktree: WorktreeBinding | null;
        finalize: FleetFinalizeResult | null;
      };
      const settled = await Promise.allSettled<SpecOutcome | null>(dispatches.map(async (d) => {
        const startSpec = activeTeam.agents.find(a => a.name === d.agentName);
        if (!startSpec) return null;
        // FAN-OUT: an agent hands its output to EVERY agent its arrows point to —
        // the run follows the graph the user drew. The whole tree from this
        // dispatch shares the START agent's worktree (so its agents see each
        // other's edits) and commits ONCE at the end. A team with no agent→agent
        // arrows runs exactly one agent here — today's behavior, unchanged.
        const wt = worktreeBySpec.get(startSpec.name) ?? null;
        const chainCwd = wt ? wt.path : projectCwd;
        // Function DECLARATIONS (hoisted) so runAgent / runLeaderUnit / runFrom can
        // mutually recurse: a leader runs its members via runFrom, which runs each
        // via runAgent, which may itself be another leader.
        async function runAgent(spec: AgentSpec, instruction: string): Promise<{ name: string; text: string }> {
          // SUB-LEADER: a can_dispatch agent that has its OWN member edges acts as a
          // sub-orchestrator — it plans, dispatches its members, and hands ONE
          // consolidated reply up. This is what makes "only the leader talks to the
          // orchestrator" real. Non-leaders run plain, exactly as before.
          const isLeader =
            (spec.role === "leader" || !!roleByName.get(spec.base)?.canDispatch) && spec.name !== orch.name &&
            (wiredDispatchTargets(runTeam, spec.name)?.size ?? 0) > 0;
          if (isLeader) return await runLeaderUnit(spec, instruction);
          if (!activeTeam) return { name: spec.name, text: "" };

          addActive(spec.name);
          appendThought(spec.name, { role: "dispatch", color: "#a578ff", text: `📩 ${instruction}` });
          appendLog(spec.name, { role: spec.name, color: colorForAgent(spec), text: "" });
          const specModel = modelFor(spec.name);
          const allowed = roleByName.get(spec.base)?.toolAllowlist;
          // Resolve this agent's equipped skills (template extra_skills + the
          // per-project graph_json grant) and inject them (budgeted progressive
          // disclosure). Skills not installed are skipped.
          const skillIds = [
            ...(roleByName.get(spec.base)?.skillAllowlist ?? []),  // Studio agent-card skills
            ...(spec.extraSkills ?? []),                           // team template extra_skills
            ...(perAgentSkills.get(spec.name) ?? []),              // per-project grant
          ];
          const skillBlock = await buildAgentSkillBlock(skillIds);
          // Per-agent memory: fold THIS agent's own prior turns (across dispatches
          // and across runs of this project) into its history so it's no longer a
          // stateless one-shot. Model-agnostic — feeds the universal history param.
          const specMemory = await loadAgentMemory(selectedProjectId, spec.name);
          // Shared work-state (RAG): pull what teammates already did RELEVANT to
          // this task (term-hit ranked) and prepend it to the instruction, so the
          // specialist is synchronized on the team's actual work instead of acting
          // on a context-free sticky note. Model-agnostic (rides the instruction).
          const taskMem = await retrieveTeamMemory(instruction);
          const enrichedInstruction = enrichInstructionWithMemory(taskMem, instruction);
          const sysPrompt = buildSpecialistPrompt(activeTeam, spec, roleByName, directives, skillBlock, chainCwd);
          // PER-AGENT VERIFY-FIX LOOP (Build Shape slice 1, step 5+6): a coder does
          // not return one-shot. After it edits, the GATE runs the project's check
          // in the coder's own cwd; on a real FAILURE it gets the captured error and
          // one more bounded attempt; it stops on pass (done), unverified (no check
          // to loop on), the budget, or no-progress (same failure twice → escalate,
          // never thrash). "Done" for this agent is grounded in the gate, not its
          // say-so. Non-coders + no-verify.json run exactly once (today's behavior).
          const isCoder = agentDomain(spec) === "coder";
          const scope: GateScope = /front|\bui\b|web/i.test(spec.name) ? "frontend"
            : /back|api|server|\bdb\b|data/i.test(spec.name) ? "backend" : "full";
          const MAX_FIX = 3;
          let specText = "";
          let finalGate: GateResult | null = null;
          let prevFailNorm = "";
          for (let attempt = 1; attempt <= MAX_FIX; attempt++) {
            const turn = attempt === 1
              ? enrichedInstruction
              : `Your previous change did NOT pass the project's verification:\n${renderGateLine(finalGate!)}\n\nFix it so the check passes — change the approach if needed. Original task:\n${instruction}`;
            try {
              specText = (await streamChatCompletion(
                port, specModel, providerFor(specModel),
                sysPrompt, turn,
                tempFor(spec, 0.5), ctrl.signal,
                (delta) => streamLog(spec.name, delta),
                chainCwd,
                specMemory.length > 0 ? specMemory : undefined,
                // autoApprove: thread the user's GUI toggle through so a Claude/Codex
                // CLI specialist actually gets --permission-mode bypassPermissions and
                // can WRITE. Was hardcoded undefined → every team-dispatched agent ran
                // gated regardless of the toggle (the "blocked on write permissions" bug).
                autoApprove,
                (channel, role, delta) => streamThought(spec.name, channel, role, delta),
                allowed,
                undefined,
                getClaudeSession(selectedProjectId, spec.name),
              )).trim();
            } catch (e: any) {
              specText = `(error: ${cleanAgentError(e)})`;
              streamLog(spec.name, "\n\n" + specText);
              break; // a thrown error isn't a verify failure — stop the loop
            }
            if (!isCoder) break;                         // only coders loop on the gate
            finalGate = await runGate(chainCwd, scope);
            lastGateRef.current = finalGate;             // let run-end reuse it (solo coder)
            if (finalGate.status !== "failed") break;    // passed (done) or unverified (nothing to loop on)
            if (attempt >= MAX_FIX) {                    // out of budget — leave it failed, loudly
              appendThought(spec.name, { role: "system", color: "#ff8c8c", text: `⚠ verify still failing after ${MAX_FIX} attempts — escalating to the orchestrator.` });
              break;
            }
            const failNorm = normalizeRunOutput((finalGate.stderr || finalGate.stdout || "") + finalGate.exitCode);
            if (failNorm === prevFailNorm) {             // no progress — don't thrash
              appendThought(spec.name, { role: "system", color: "#ff8c8c", text: `⚠ same verify failure twice — no progress; escalating instead of retrying.` });
              break;
            }
            prevFailNorm = failNorm;
            appendThought(spec.name, { role: "system", color: "#ffb74d", text: `🔁 verify failed — re-attempting fix (${attempt + 1}/${MAX_FIX})` });
          }
          removeActive(spec.name);
          // Persist this exchange so the next dispatch remembers it (per-agent).
          await appendAgentMemory(selectedProjectId, spec.name, instruction, specText);
          // STRUCTURED HANDOFF (step 6): record what the agent did AND its grounded
          // lane-verify result (not the agent's claim) into the shared work-state, so
          // the next agent / the run report inherit the real outcome.
          const laneTag = finalGate && finalGate.status !== "unverified" ? `\n[lane verify: ${finalGate.status}]` : "";
          await logTeamWork(spec.name, instruction, specText + laneTag);
          speakAgentReply(spec.name, specText);
          return { name: spec.name, text: specText };
        }
        // SUB-ORCHESTRATOR for a team leader: it plans over its OWN members (its
        // wired targets), dispatches them through the SAME runFrom handoff (so the
        // sub-team's internal arrows still work), then integrates ONE reply for the
        // top orchestrator. buildOrchestratorPrompt with the leader as "orch" makes
        // its roster exactly its members (with their real [tools:]/[skills:]).
        async function runLeaderUnit(leader: AgentSpec, instruction: string): Promise<{ name: string; text: string }> {
          if (!runTeam) return { name: leader.name, text: "" };
          const members = wiredDispatchTargets(runTeam, leader.name) ?? new Set<string>();
          const leaderModel = modelFor(leader.name);
          const leaderPrompt = buildOrchestratorPrompt(
            runTeam, roleByName, leader, directives, false, undefined, false, undefined, undefined, perAgentSkills, projectCwd,
          );
          // 1. Leader plans + emits @member dispatches.
          addActive(leader.name);
          appendThought(leader.name, { role: "dispatch", color: "#a578ff", text: `📩 (sub-team lead) ${instruction}` });
          appendLog(leader.name, { role: leader.name, color: colorForAgent(leader), text: "" });
          let plan = "";
          try {
            plan = (await streamChatCompletion(
              port, leaderModel, providerFor(leaderModel),
              leaderPrompt, instruction, tempFor(leader, 0.4), ctrl.signal,
              (delta) => streamLog(leader.name, delta),
              chainCwd, undefined, undefined,
              (channel, role, delta) => streamThought(leader.name, channel, role, delta),
              READONLY_LOCAL_TOOLS, undefined,
              getClaudeSession(selectedProjectId, leader.name),
            )).trim();
          } catch (e: any) {
            appendLog(leader.name, { role: "system", color: "#ff8c8c", text: `⚠ ${cleanAgentError(e)}` });
          }
          removeActive(leader.name);
          // 2. Dispatch its members through runFrom (sub-team handoff honored).
          const parsed = parseDispatchesDetailed(plan, runTeam, leader.name);
          const memberDispatches = parsed.dispatches.filter(d => members.has(d.agentName));
          const subReplies: { name: string; text: string }[] = [];
          for (const md of memberDispatches) subReplies.push(...await runFrom(md.agentName, md.instruction));
          // 3. Leader integrates ONE consolidated reply for the orchestrator.
          addActive(leader.name);
          appendLog(leader.name, { role: leader.name, color: colorForAgent(leader), text: "" });
          let synthesis = subReplies.map(r => r.text).join("\n\n").trim() || plan;
          if (subReplies.length > 0) {
            const integrationInput = [
              `Your sub-team handled this task:\n${instruction}`,
              "",
              "Their replies:",
              ...subReplies.map(r => `\n— ${displayLabel(r.name)} —\n${r.text}`),
              "",
              "Consolidate this into ONE result to hand back to the orchestrator. Be concise; quote what matters.",
            ].join("\n");
            try {
              synthesis = (await streamChatCompletion(
                port, leaderModel, providerFor(leaderModel),
                leaderPrompt, integrationInput, tempFor(leader, 0.4), ctrl.signal,
                (delta) => streamLog(leader.name, delta),
                chainCwd, undefined, undefined,
                (channel, role, delta) => streamThought(leader.name, channel, role, delta),
                undefined, undefined,
                getClaudeSession(selectedProjectId, leader.name),
              )).trim();
            } catch { /* keep the concatenated fallback */ }
          }
          removeActive(leader.name);
          speakAgentReply(leader.name, synthesis);
          return { name: leader.name, text: synthesis };
        }
        // Walk the graph: each node runs, then hands its output to ALL its
        // non-orchestrator arrow targets. `ran` (claimed before each await) +
        // MAX_CHAIN_HOPS dedupe fan-in and guarantee termination on cycles.
        const runCount = new Map<string, number>();
        const lastOutput = new Map<string, string>();   // no-progress detection
        const capNoticed = { global: false };            // emit the cap notice once
        async function runFrom(name: string, input: string): Promise<{ name: string; text: string }[]> {
          if (!activeTeam) return [];
          const total = Array.from(runCount.values()).reduce((a, b) => a + b, 0);
          if (total >= MAX_CHAIN_HOPS) {                                // global backstop — LOUD
            if (runTraceRef.current) runTraceRef.current.capHit = true;
            if (!capNoticed.global) {
              capNoticed.global = true;
              const m = `⚠ Stopped: hit the dispatch-chain limit (${MAX_CHAIN_HOPS} hops). The result may be INCOMPLETE — not every step ran.`;
              appendLog("system", { role: "system", color: "#ffb74d", text: m });
              setSupChat(prev => [...prev, { role: "system", color: "#ffb74d", text: m, ts: Date.now() }]);
            }
            return [];
          }
          if ((runCount.get(name) ?? 0) >= MAX_AGENT_RERUNS) {          // per-agent cap — LOUD
            if (runTraceRef.current) runTraceRef.current.capHit = true;
            appendThought(name, { role: "system", color: "#ffb74d", text: `⚠ @${name} hit its re-run limit (${MAX_AGENT_RERUNS}); not running again — its part may be incomplete.` });
            return [];
          }
          runCount.set(name, (runCount.get(name) ?? 0) + 1);
          const spec = activeTeam.agents.find(a => a.name === name);
          if (!spec) return [];
          const out = await runAgent(spec, input);
          // Run-trace bookkeeping (Layer 2): record who ran (+ domain + count) and,
          // if this was the critic, its parsed verdict. Pure observation.
          if (runTraceRef.current) {
            const rt = runTraceRef.current;
            const prev = rt.agents.get(name);
            rt.agents.set(name, { domain: agentDomain(spec), runs: (prev?.runs ?? 0) + 1 });
            if (name === CRITIC_AGENT_NAME) {
              const v = parseCriticVerdict(out.text);
              if (v) rt.criticVerdict = v;
            }
          }
          // No-progress / oscillation guard (harness, deterministic): if this agent
          // just repeated its previous output, stop its chain — that's a stuck loop
          // (e.g. critic<->coder ping-pong), not progress.
          {
            const cur = normalizeRunOutput(out.text);
            const prevOut = lastOutput.get(name);
            lastOutput.set(name, cur);
            if (isNoProgress(prevOut, cur)) {
              if (runTraceRef.current) runTraceRef.current.oscillationStops++;
              appendThought(name, { role: "system", color: "#ffb74d", text: `⚠ @${name} repeated its previous output — no progress; stopping this chain to avoid a loop.` });
              return [out];
            }
          }
          // A sub-leader already ran its members inside runLeaderUnit — treat it as
          // a leaf so we don't ALSO handoff to (and double-run) those same members.
          const ranAsLeader =
            (spec.role === "leader" || !!roleByName.get(spec.base)?.canDispatch) && name !== orch.name &&
            (wiredDispatchTargets(runTeam, name)?.size ?? 0) > 0;
          if (ranAsLeader) return [out];
          // Agent-decided routing: the agent's reply picks where its output goes next
          // (explicit @target among its allowed edges), else legacy run-once auto-flow.
          const { hands, capped } = nextHandoffs(runTeam, name, out.text, runCount);
          const results: { name: string; text: string }[] = [];
          if (hands.length > 0) {
            appendThought(name, { role: "dispatch", color: "#a578ff", text: `➡ ${hands.map(h => "@" + h.name + (h.explicit ? "" : " (auto)")).join(", ")}` });
            for (const h of hands) results.push(...await runFrom(h.name, h.input));
          }
          if (capped.length > 0) {
            // P2 supervision: exhausted loop → surface a digest the orchestrator integrates.
            const notice = loopExhaustedNotice(name, capped, runCount);
            appendThought(name, { role: "dispatch", color: "#ffb45a", text: notice });
            results.push({ name, text: notice });
          }
          return results.length ? results : [out];
        }
        const replies = await runFrom(startSpec.name, d.instruction);
        if (replies.length === 0) return null;
        // Finalize the tree's worktree ONCE — captures the whole branch's edits.
        let finalize: FleetFinalizeResult | null = null;
        if (wt) {
          try {
            finalize = await invoke<FleetFinalizeResult>("fleet_worktree_finalize", {
              worktreePath: wt.path, agentName: startSpec.name, summary: d.instruction,
            });
            if (finalize.status === "committed") {
              appendThought(startSpec.name, {
                role: "fleet", color: "#7ff0c5",
                text: `📦 committed ${finalize.commitSha.slice(0,7)} · ${finalize.filesChanged} file${finalize.filesChanged === 1 ? "" : "s"}\n${finalize.files.slice(0, 12).join("\n")}`,
              });
            } else if (finalize.status === "noChanges") {
              appendThought(startSpec.name, { role: "fleet", color: "#8a92a3", text: "📦 no changes to commit" });
            } else {
              appendThought(startSpec.name, { role: "fleet", color: "#ff8c8c", text: `📦 finalize failed: ${finalize.message}` });
            }
          } catch (e: any) {
            finalize = { status: "error", message: String(e?.message ?? e) };
            appendThought(startSpec.name, { role: "fleet", color: "#ff8c8c", text: `📦 finalize errored: ${String(e?.message ?? e)}` });
          }
        }
        return { name: startSpec.name, replies, worktree: wt, finalize };
      }));
      const outcomes: SpecOutcome[] = [];
      for (const r of settled) {
        if (r.status === "fulfilled" && r.value) outcomes.push(r.value);
      }
      const specialistReplies = outcomes.flatMap(o => o.replies);

      // Surface each specialist's reply in the UNIFIED conversation (Full Chat),
      // not only on its per-agent card. Before this, a team chat's Full Chat
      // showed just the user turn, system notices, and the orchestrator's final
      // answer — the specialists looked skipped. seq orders them after the
      // orchestrator's planning thoughts and before its final integration.
      if (specialistReplies.length > 0) {
        setSupChat(prev => [
          ...prev,
          ...specialistReplies.map(r => {
            const spec = activeTeam.agents.find(a => a.name === r.name);
            return {
              role: r.name,
              color: spec ? colorForAgent(spec) : "#cbd5e1",
              text: r.text,
              ts: Date.now(),
              seq: nextSeq(),
            } as GoalMsg;
          }),
        ]);
      }

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
          buildOrchestratorPrompt(runTeam, roleByName, orch, directives, directorMode, briefText, parallelMode, parallelGuidance, orchSkillBlock, perAgentSkills, projectCwd), integrationInput,
          tempFor(orch, 0.4), ctrl.signal,
          (delta) => streamLog(orch.name, delta),
          projectCwd,
          priorHistory, undefined,   // history: continuity for the final answer
          (channel, role, delta) => streamThought(orch.name, channel, role, delta),
          undefined,
          undefined,
          getClaudeSession(selectedProjectId, orch.name),
        );
      } finally {
        removeActive(orch.name);
      }
      speakAgentReply(orch.name, finalReply);
      // Persist any `[REMEMBER ...]` facts the orchestrator wrote in its final answer.
      await harvestMemoryWrites(finalReply);
      // ----- Phase 3b: Critical Thinker post-review of the FINAL answer -----
      // The critic reviews the assembled answer and the orchestrator may revise.
      // Modes mirror the pre-dispatch loop:
      //   • Advisory (default): one review → at most one revision → ship.
      //   • Critic = Super User: up to 2 revise rounds until the critic signs off.
      // STRICTLY NON-BLOCKING in both: a refusal, a satisfied verdict, or any
      // error ships the current answer as-is. The critic can improve the output,
      // never withhold it.
      if (directorMode || needsCriticalThinkerReview(`${text}\n${finalReply}`)) {
        const CRITIC_NAME = CRITIC_AGENT_NAME;
        const MAX_POST_ROUNDS = directorMode ? 2 : 1;
        for (let round = 0; round < MAX_POST_ROUNDS && !ctrl.signal.aborted; round++) {
          addActive(CRITIC_NAME);
          appendLog(CRITIC_NAME, { role: CRITIC_NAME, color: "#ff9ad9", text: "" });
          let postReview = "";
          let reviewFailed = false;
          try {
            const criticModel = modelFor(CRITIC_NAME);
            postReview = await streamChatCompletion(
              port, criticModel, providerFor(criticModel),
              buildCriticalThinkerReviewPrompt(activeTeam, directives),
              [
                "The user's goal:",
                text,
                "",
                "The team's FINAL answer (about to be delivered to the user):",
                finalReply,
                "",
                directorMode
                  ? "You are the Super User. Approve this answer, or list the concrete fixes it needs before it ships. If it is solid, say 'no concerns'."
                  : "Review the FINAL answer for correctness, gaps, unsupported claims, and anything that would mislead the user. If it is solid, say 'no concerns'. Otherwise give concrete fixes — advisory only; the answer ships regardless.",
              ].join("\n"),
              0.3, ctrl.signal,
              (delta) => { postReview += delta; streamLog(CRITIC_NAME, delta); },
              projectCwd,
              undefined, undefined,
              (channel, role, delta) => streamThought(CRITIC_NAME, channel, role, delta),
              READONLY_LOCAL_TOOLS,
              undefined,
              getClaudeSession(selectedProjectId, CRITIC_NAME),
            );
          } catch (e: any) {
            if (ctrl.signal.aborted) throw e;
            const msg = cleanAgentError(e);
            appendThought(orch.name, { role: "system", color: "#ff8c8c", text: `⚠ Critical Thinker post-review unavailable (${msg}) — shipping the answer as-is.` });
            postReview = "";
            reviewFailed = true;
          } finally {
            removeActive(CRITIC_NAME);
          }
          if (reviewFailed) break;
          speakAgentReply(CRITIC_NAME, postReview);
          const pr = postReview.trim();
          if (runTraceRef.current) { const v = parseCriticVerdict(pr); if (v) runTraceRef.current.criticVerdict = v; }
          // Satisfied or refused → ship what we have. The critic never blocks.
          if (!pr || criticConcluded(pr)) break;
          // Substantive feedback → orchestrator revises ONCE this round. Still
          // non-blocking: if the revision errors or returns empty, the prior
          // answer ships unchanged.
          addActive(orch.name);
          appendLog(orch.name, { role: orch.name, color: "#ffd97a", text: "" });
          try {
            const revised = await streamChatCompletion(
              port, finalModel, providerFor(finalModel),
              buildOrchestratorPrompt(runTeam, roleByName, orch, directives, directorMode, briefText, parallelMode, parallelGuidance, orchSkillBlock, perAgentSkills, projectCwd),
              [
                "Your final answer:",
                finalReply,
                "",
                directorMode ? "Critical Thinker (Super User) requires these fixes:" : "Critical Thinker post-review (advisory):",
                pr,
                "",
                "Revise the final answer to address the valid points, then output the improved final answer only. Do not dispatch again.",
              ].join("\n"),
              tempFor(orch, 0.4), ctrl.signal,
              (delta) => streamLog(orch.name, delta),
              projectCwd,
              priorHistory, undefined,
              (channel, role, delta) => streamThought(orch.name, channel, role, delta),
              undefined,
              undefined,
              getClaudeSession(selectedProjectId, orch.name),
            );
            if (revised.trim()) { finalReply = revised; speakAgentReply(orch.name, finalReply); }
          } catch (e: any) {
            if (ctrl.signal.aborted) throw e;
            // revision failed → keep the prior finalReply (non-blocking)
          } finally {
            removeActive(orch.name);
          }
        }
      }
      setSupChat(prev => [...prev, { role: "orchestrator", color: "#ffd97a", text: finalReply.trim(), ts: Date.now(), seq: nextSeq() }]);

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
        const docSkillIds = [...(roleByName.get(docSpec.base)?.skillAllowlist ?? []), ...(docSpec.extraSkills ?? []), ...(perAgentSkills.get(docSpec.name) ?? [])];
        const docSkillBlock = await buildAgentSkillBlock(docSkillIds);
        try {
          await streamChatCompletion(
            port, modelFor(docSpec.name), providerFor(modelFor(docSpec.name)),
            buildSpecialistPrompt(activeTeam, docSpec, roleByName, directives, docSkillBlock, docCwd),
            docInstruction, tempFor(docSpec, 0.3), ctrl.signal,
            (delta) => streamLog(docSpec.name, delta),
            docCwd,
            undefined, autoApprove, // autoApprove: let the doc writer's CLI write (was undefined)
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

      // ── RUN REPORT + DONE-GATE (Layer 2 eval): finalize the objective trace of
      // this run, decide if it actually DELIVERED (robust: a code/ops goal OR a
      // coder/operator that was dispatched, but zero writes → NOT done — catches
      // UI tasks classifyGoal labels "general"), warn loudly if not, show a
      // one-line report (PASS/FAIL vs the matching fixture), and persist it for
      // team.eval.run.mjs. Pure observation — wrapped so it can NEVER break a run.
      try {
        const rt = runTraceRef.current;
        if (rt) {
          const gk = classifyGoal(text);
          const agents = [...rt.agents.entries()].map(([name, v]) => ({ name, domain: v.domain, runs: v.runs }));
          const wrote = ranWriteToolRef.current;
          const delivered = runDelivered(text, wrote, agents.map(a => a.domain));
          // VERIFICATION GATE (slice 1 — first-class, gate.ts/runGate): when files
          // changed on a code/ops goal, "done" is decided by the project's OWN check
          // (exit code), never the agents' say-so. runGate returns passed | failed |
          // unverified with the captured output. unverified (no .owllm/verify.json)
          // falls back to the write proxy and says so — never a false "passed".
          // Only runs when something was written, so a no-op run is never slowed.
          let gate: GateResult | null = null;
          if (wrote && goalRequiresWrite(text)) {
            // Reuse a solo coder's own full-scope gate (it already verified
            // projectCwd in its loop) instead of re-running the build; otherwise
            // run the integration gate on the merged tree.
            const reuse = lastGateRef.current && lastGateRef.current.cwd === projectCwd && lastGateRef.current.scope === "full"
              ? lastGateRef.current : null;
            if (reuse) {
              gate = reuse;
            } else {
              appendLog("system", { role: "system", color: "#7ff0c5", text: "🔍 verification gate…" });
              gate = await runGate(projectCwd, "full");
            }
            const line = renderGateLine(gate);
            const col = gate.status === "passed" ? "#7ff0c5" : gate.status === "failed" ? "#ff8c8c" : "#ffb74d";
            appendLog("system", { role: "system", color: col, text: line });
            if (gate.status !== "unverified") setSupChat(prev => [...prev, { role: "system", color: col, text: line, ts: Date.now() }]);
          }
          // passed → done; failed → not done; unverified/none → fall back to the write proxy.
          const done = gate ? (gate.status === "passed" ? true : gate.status === "failed" ? false : delivered) : delivered;
          if (!done && (!gate || gate.status !== "failed")) {
            // Gate FAILED already printed its own loud line above; only add the
            // "nothing was written / analyzed-only" message for the non-gate case.
            const doer = agents.find(a => a.domain === "coder" || a.domain === "ops");
            const why = goalRequiresWrite(text)
              ? `this was a ${gk} task but no file was edited and no command was run — the team only analyzed/planned.`
              : `@${doer?.name ?? "a specialist"} (a coder/operator) was dispatched but nothing was written.`;
            const m = `⚠ NOT done: ${why}`;
            appendLog("system", { role: "system", color: "#ff8c8c", text: m });
            setSupChat(prev => [...prev, { role: "system", color: "#ff8c8c", text: m, ts: Date.now() }]);
          }
          const trace: RunTrace = {
            team: activeTeam?.name ?? "team", goal: text, goalKind: gk, agents,
            hops: agents.reduce((a, b) => a + b.runs, 0),
            routeCorrections: rt.routeCorrections, wroteFiles: wrote,
            criticVerdict: rt.criticVerdict, capHit: rt.capHit, oscillationStops: rt.oscillationStops,
            done,
            durationMs: Date.now() - rt.t0, finalAnswer: (finalReply || "").slice(0, 2000), ts: Date.now(),
          };
          const fx = TEAM_FIXTURES.find(f => f.team === trace.team && f.expectKind === gk);
          let report = `🧪 Run report — ${summarizeTrace(trace)}`;
          if (fx) {
            const card = scoreRun(trace, fx);
            const misses = card.checks.filter(c => !c.pass).map(c => c.name);
            report += `\n   eval vs "${fx.note ?? fx.goal}": ${card.ok ? "✓ PASS" : "✗ FAIL"} (${card.passed}/${card.checks.length})${misses.length ? " — failed: " + misses.join(", ") : ""}`;
          }
          setSupChat(prev => [...prev, { role: "system", color: trace.done ? "#7ff0c5" : "#ffb74d", text: report, ts: Date.now() }]);
          // Persist (append, keep last 200) for the node scorecard. Best-effort.
          try {
            let prior = "";
            try { prior = await invoke<string>("tool_read_file", { path: ".owllm/eval-traces.jsonl", cwd: projectCwd }); } catch { prior = ""; }
            const kept = (prior ? prior.split(/\r?\n/).filter(Boolean) : []).slice(-199);
            await invoke("tool_write_file", { path: ".owllm/eval-traces.jsonl", content: [...kept, JSON.stringify(trace)].join("\n") + "\n", cwd: projectCwd });
          } catch { /* disk persistence is optional — the in-app report still shows */ }
        }
      } catch { /* tracing must never break a run */ }

      setPhase("done");
    } catch (e: any) {
      if (e?.name === "AbortError") {
        setRunError("Stopped.");
        appendLog("system", { role: "system", color: "#ff8c8c", text: "⏹ Stopped by user." });
      } else {
        const clean = cleanAgentError(e);
        setRunError(clean);
        // Network failures get the one-click WSL-restart recovery button.
        appendLog("system", {
          role: "system", color: "#ff8c8c", text: `⚠ ${clean}`,
          action: isNetworkAgentError(e) ? "wsl-restart" : undefined,
        });
      }
      setPhase("idle");
    } finally {
      dispatchInFlightRef.current = false; // release the reentrancy slot
      setBusy(false);
      setRunning(false); // clear the store-backed in-flight flag (mirrors setBusy)
      setRunEndedAt(Date.now()); // freeze the team stopwatch on the final duration
      clearActive();
      abortRef.current = null;
      agentRunAborts.delete(agentSessId);
    }
  }

  const onRun = dispatchGoal;

  function onCancel() {
    abortRef.current?.abort();
    // Also abort via the module-scoped registry: if this run was started
    // before a page change, the remounted page's `abortRef` is null but the
    // original controller is still in the registry, so Cancel can reach it.
    agentRunAborts.get(agentSessId)?.abort();
    // Kill any in-flight TTS — if the user cancelled the dispatch
    // they don't want the agent to keep talking from a queued reply.
    ttsStopAll();
  }

  // ===== Telegram bridge — long-poll =====
  // The actual long-poll loop runs at AppShell level via
  // <TelegramBridgeRunner /> so it survives navigation away from this
  // page. What stays here is the optional courtesy of echoing inbound
  // text into the SuperUser chat WHEN the user is on the agentic tab,
  // bound to the same project the bridge is configured for. The
  // runner handles the actual reply path; this just adds local UX.
  useEffect(() => {
    const onStatus = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const running = detail === "running";
      if (!running) setTgStarted(false);
      // Re-fetch bridge config from disk so the local echo gate picks
      // up the new project_id when the user starts the bridge while
      // the agentic tab is mounted.
      if (running) {
        invoke<BridgeConfigs>("load_bridge_configs").then(c => setBridges(c)).catch(() => {});
      }
    };
    const onRuntime = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      setTgStarted(detail.status === "running");
      if (detail.status === "running") {
        invoke<BridgeConfigs>("load_bridge_configs").then(c => setBridges(c)).catch(() => {});
      }
    };
    window.addEventListener("owllm:telegram:status", onStatus as EventListener);
    window.addEventListener("owllm:telegram:runtime", onRuntime as EventListener);
    return () => {
      window.removeEventListener("owllm:telegram:status", onStatus as EventListener);
      window.removeEventListener("owllm:telegram:runtime", onRuntime as EventListener);
    };
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
      // De-duplication: the bridge streams the orchestrator reply token
      // by token via owllm:log:delta (which mutates the LAST agentLogs
      // entry in place), then fires owllm:chat:appended at the end with
      // the full text. Without this guard we'd APPEND a second
      // identical entry — that's the "orchestrator replied twice" bug
      // the user reported.
      for (const m of msgs) {
        // Voice transcripts arrive as role="you" with the 🎤 prefix.
        // They need to slot in BEFORE the empty orchestrator entry
        // hooks.onLog() created (so the user reads "they sent voice
        // → here's what was said → here's the orchestrator's reply"
        // in that order). Detection is by emoji prefix because
        // there's no kind tag on GoalMsg yet.
        const isTranscript = m.role === "you" && m.text.startsWith("🎤 ");
        if (isTranscript) {
          appendLog("you", m);
          setAgentLogs(prev => {
            const cur = prev.get(orchKey) ?? [];
            let insertIdx = cur.length;
            for (let i = cur.length - 1; i >= 0; i -= 1) {
              const entry = cur[i];
              if (entry.role === orchKey && entry.text === "") {
                insertIdx = i;
                break;
              }
            }
            const next = new Map(prev);
            next.set(orchKey, [...cur.slice(0, insertIdx), m, ...cur.slice(insertIdx)]);
            return next;
          });
        } else if (m.role === "you") {
          appendLog("you", m);
          appendLog(orchKey, m);
        } else if (m.role === "system") {
          // System warning (transcribe failure, CLI image drop). Insert
          // it BEFORE the in-flight orchestrator entry so the user sees
          // the warning ABOVE the reply that explains it, not below.
          // The empty entry that hooks.onLog created during the stream
          // is the marker — splice the warning in just before it.
          setAgentLogs(prev => {
            const cur = prev.get(orchKey) ?? [];
            let insertIdx = cur.length;
            for (let i = cur.length - 1; i >= 0; i -= 1) {
              const entry = cur[i];
              if (entry.role !== "system" && entry.text === "") {
                insertIdx = i;
                break;
              }
            }
            const next = new Map(prev);
            next.set(orchKey, [...cur.slice(0, insertIdx), m, ...cur.slice(insertIdx)]);
            return next;
          });
        } else {
          // Agent reply (orchestrator / specialist / critic). Dedup
          // against the last NON-system entry — the streamed text — so
          // the final blob doesn't append a second copy of itself.
          setAgentLogs(prev => {
            const cur = prev.get(orchKey) ?? [];
            let idx = cur.length - 1;
            while (idx >= 0 && cur[idx].role === "system") {
              idx -= 1;
            }
            const last = idx >= 0 ? cur[idx] : null;
            const incoming = m.text.trim();
            const lastText = last ? last.text.trim() : "";
            if (last && lastText === incoming) {
              return prev;                              // already streamed
            }
            // Suffix / contained-in case: multi-turn dispatches (e.g.
            // brainstorm critic) stream turn1 + turn2 into the SAME
            // entry (when hooks.onLog for turn2 raced the stream), then
            // onAgentReply fires with ONLY turn2's text. Without this
            // check the dedup misses and we get a second bubble that's
            // a suffix of the first. Skip if the streamed entry already
            // contains the incoming text anywhere.
            if (last && lastText.length > 0 && lastText.includes(incoming)) {
              return prev;
            }
            if (last && incoming.startsWith(lastText) && lastText.length > 0) {
              // Streaming ended with the in-place entry holding a strict
              // prefix of the final blob (last few tokens missed by the
              // delta channel). Replace the streamed entry with the full
              // text instead of appending a new one.
              const next = new Map(prev);
              const updated = [...cur];
              updated[idx] = { ...last, text: m.text };
              next.set(orchKey, updated);
              return next;
            }
            const next = new Map(prev);
            next.set(orchKey, [...cur, { ...m, role: orchKey }]);
            return next;
          });
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
      <ProjectSettingsDialog
        open={newProjOpen}
        mode={settingsMode}
        onClose={() => setNewProjOpen(false)}
        teams={teams}
        pickedTeamId={pickedTeamId}
        onPickTeam={setPickedTeamId}
        resolvedTeamLabel={activeTeamTemplate?.display ?? null}
        onResetTeam={resetTeamToTemplate}
        defaultTeamName={pickedTeamId ? teams.find(t => t.id === pickedTeamId)?.name : undefined}
        onCreated={onProjectCreated}
        project={selectedProject}
        location={locationOverride}
        effectiveCwd={runCwd}
        onChangeLocation={setLocationOverride}
        trustWrites={trustWrites}
        onToggleTrustWrites={() => setTrustWritesOverride(v => !(v ?? selectedProject?.trust_writes ?? false))}
        fullAccess={fullAccess}
        onToggleFullAccess={onToggleFullAccess}
        bridgeOn={bridgeOn}
        isolationRequested={isolationRequested}
        onAfterRename={() => { reloadProjects(); }}
        onAfterDelete={() => { reloadProjects().then(rows => { setSelectedProjectId(rows[0]?.id ?? ""); setPickedTeamId(null); }); }}
      />
      <GoalRow
        goal={goal} setGoal={setGoal} onRun={onRun} onCancel={onCancel} busy={busy || backgroundRunning}
        attachments={attachments} setAttachments={setAttachments}
        // Single-line top: the compact project cluster (dropdown + ⚙ settings +
        // New) renders at the start of the run row. Everything else that used to
        // crowd the old project strip now lives in the ⚙ ProjectSettingsDialog.
        leftSlot={
          <div style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
            <span style={{ fontSize:15 }} title="Project">📁</span>
            <select
              data-ui="ProjectCombo"
              value={selectedProjectId}
              onChange={e => { setSelectedProjectId(e.target.value); setPickedTeamId(null); }}
              title="Switch project"
              style={{ height:38, maxWidth:190, padding:"0 10px", borderRadius:10, border:"none", background:"var(--bg-input)", color:"var(--fg-strong)", fontSize:13 }}
            >
              {projects.length === 0
                ? <option value="">(no projects — + New)</option>
                : projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button
              data-ui="ProjectSettingsBtn"
              onClick={onOpenSettings}
              disabled={!selectedProjectId}
              title="Project settings — folder, security, team, bridge, rename, delete"
              style={{ height:38, minWidth:40, padding:"0 10px", border:"none", borderRadius:10, background:"var(--bg-surface)", color:"var(--fg)", fontSize:16, cursor: selectedProjectId ? "pointer":"not-allowed", opacity: selectedProjectId?1:0.5 }}
            >⚙</button>
            <button
              data-ui="NewProjectBtn"
              onClick={onNewProject}
              title="Create a new project"
              style={{ height:38, padding:"0 12px", border:"none", borderRadius:10, background:"var(--bg-surface)", color:"var(--fg)", fontSize:13, fontWeight:700, cursor:"pointer" }}
            >+ New</button>
            <div style={{ width:1, height:24, background:"var(--border-strong)", margin:"0 2px" }} />
          </div>
        }
        // Brainstorm needs a project folder to anchor BRIEF.md + brainstorm/<png>.
        // If there's no folder yet, don't dead-end the button — open Project
        // settings so the user can set one (the folder field moved into that
        // popup in v0.5.26, so a bare "set a location" hint had nowhere to point).
        onBrainstorm={() => {
          if (runCwd && runCwd.trim()) { setBrainstormOpen(true); }
          else { setSettingsMode("edit"); setNewProjOpen(true); }
        }}
        brainstormReady={!!(runCwd && runCwd.trim())}
        hasBrief={hasBriefForProject}
      />
      <IconPickerDialog
        open={iconPickerAgent != null}
        agentName={iconPickerAgent ?? ""}
        currentRef={iconPickerAgent
          ? agentIconRef(
              (renderTeam?.agents.find(a => a.name === iconPickerAgent)
                ?? { name: iconPickerAgent, base: iconPickerAgent } as AgentSpec),
              roleByName,
              agentIconOverrides,
            )
          : ""}
        onCancel={() => setIconPickerAgent(null)}
        onPick={(ref) => {
          if (!iconPickerAgent || !selectedProjectId) { setIconPickerAgent(null); return; }
          setAgentIconOverride(selectedProjectId, iconPickerAgent, ref);
          setAgentIconOverrides(prev => ({ ...prev, [iconPickerAgent]: ref }));
          setIconPickerAgent(null);
        }}
        onReset={() => {
          if (!iconPickerAgent || !selectedProjectId) { setIconPickerAgent(null); return; }
          setAgentIconOverride(selectedProjectId, iconPickerAgent, null);
          setAgentIconOverrides(prev => {
            const next = { ...prev };
            delete next[iconPickerAgent];
            return next;
          });
          setIconPickerAgent(null);
        }}
      />
      <BrainstormPanel
        open={brainstormOpen}
        onClose={() => setBrainstormOpen(false)}
        projectCwd={runCwd}
        brainstormerRole={roleByName.get("brainstormer") ?? null}
        // Use the team's default model. Fallback to the orchestrator's
        // model, which respects per-agent overrides. Brainstormer is
        // research-heavy; users should pick Opus 4.7 medium for best
        // results but anything that handles tool calls works.
        modelId={(teamModelOverride || (activeTeam ? modelFor(findOrchestratorSpec(activeTeam)?.name ?? "") : "") || "").trim()}
        port={serverState.port ?? 0}
        models={models}
        onBriefSaved={() => setHasBriefForProject(true)}
        projectId={selectedProjectId}
        // Apply the assembled roster to THIS project (persists), then clear any
        // template override + reload so the canvas shows the new team.
        onTeamApplied={() => { setPickedTeamId(null); reloadProjects(); }}
      />
      {workbenchOpen && activeTeamTemplate && (
        <TeamWorkbenchModal
          teamName={activeTeamTemplate.name}
          models={models}
          accountsStatus={accountsStatus}
          onClose={() => setWorkbenchOpen(false)}
          onSaved={async () => { setWorkbenchOpen(false); await reloadTeamLibrary(); }}
        />
      )}
      <TeamMemoryModal projectId={selectedProjectId} projectName={activeTeam?.display} />
      {llamaLoading !== null && (
        <div data-ui="LlamaLoadingBanner" style={{
          margin: "0 23px 6px",
          padding: "6px 12px",
          background: "linear-gradient(135deg, rgba(38,30,10,0.95) 0%, rgba(18,14,4,0.95) 100%)",
          border: "1px solid rgba(255,217,122,0.55)",
          borderRadius: 8,
          color: "#ffd97a",
          fontSize: 12, fontWeight: 600,
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <span style={{ fontSize: 16 }}>⏳</span>
          <span>llama-server still warming up · {llamaLoading.sec}s · last: <code style={{ background:"rgba(0,0,0,0.3)", padding:"1px 4px", borderRadius:3 }}>{llamaLoading.reason}</code> · Press Stop to abort.</span>
        </div>
      )}
      <div data-ui="WorkspaceStack" style={{
        flex:1, minHeight:0, margin:"0 23px",
        display:"flex", overflow:"hidden", background:"var(--bg-app)", padding:0,
      }}>
        {/* Canvas column — TeamCanvas / GraphCanvas / AgentChatGrid
            depending on viewMode. The chat-grid is now a CANVAS MODE
            (third option in the FlowHeader segmented switch), not a
            side-by-side split. The "big" chat-toggle button sits on
            the canvas top-right where the SuperUserCard used to live;
            it's the shortcut into chat mode without going to the
            toolbar (user spec 2026-05-28). */}
        <div data-ui="RosterLeft" style={{ flex:"2 1 0", minWidth:0, display:"flex", flexDirection:"column", background:"var(--bg-elevated)" }}>
          <FlowHeader
            viewMode={viewMode}
            onSetView={setViewMode}
            canEdit={viewMode === "graph" && selectedEdgeIdx != null}
            onDeleteEdge={deleteSelectedEdge}
            onReverseEdge={reverseSelectedEdge}
            onResetLayout={resetGraphLayout}
            teamLabel={activeTeamTemplate?.display ?? null}
            onOpenWorkbench={() => setWorkbenchOpen(true)}
            runStartedAt={runStartedAt}
            runEndedAt={runEndedAt}
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
            ) : viewMode === "graph" ? (
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
                modelFor={modelFor}
              />
            ) : (
              <AgentChatGrid
                team={renderTeam}
                roleByName={roleByName}
                agentLogs={agentLogs}
                activeAgents={activeAgents}
                agentIconOverrides={agentIconOverrides}
                selectedAgent={selectedNode}
                onSelectAgent={(name) => setSelectedNode(name)}
                agentTiming={agentTiming}
              />
            )}
            {/* (The bottom-left canvas voice overlay was removed — the
                per-agent voice control already lives in the chat-column
                Super User / Team settings panel, so it was redundant.) */}
            {/* Big chat-mode toggle — sits on the canvas top-right
                where SuperUserCard used to be (user spec 2026-05-28).
                ONLY shown in diagram / graph modes — in chat mode the
                user is already in the grid, so the shortcut button is
                redundant (the FlowHeader tabs at the top handle the
                way back). Without this guard the user reads it as
                clutter sitting on top of the chat tiles. */}
            {viewMode !== "chat" && (
              <button
                data-ui="CanvasChatToggleBtn"
                onClick={() => setViewMode("chat")}
                title="Open the per-agent chat grid in this canvas (every agent gets its own live transcript window)"
                style={{
                  position:"absolute", top:12, right:12,
                  width:120, height:84,
                  display:"flex", flexDirection:"column",
                  alignItems:"center", justifyContent:"center",
                  gap:4, padding:"6px 8px",
                  background:"linear-gradient(135deg, rgba(38,30,10,0.96) 0%, rgba(18,14,4,0.96) 100%)",
                  border:"1px solid rgba(255,200,80,0.65)",
                  borderRadius:12,
                  color:"#ffd97a",
                  fontSize:11, fontWeight:700, letterSpacing:0.4,
                  cursor:"pointer",
                  boxShadow:"0 4px 14px rgba(0,0,0,0.55)",
                  zIndex:50,
                }}
              >
                <span style={{ fontSize:32, lineHeight:1 }}>▦</span>
                <span style={{ textTransform:"uppercase" }}>Chat grid</span>
              </button>
            )}
          </div>
        </div>
        <div data-ui="RosterSplitter" style={{ width:SPLITTER_W, flexShrink:0, background:"var(--bg-card)" }} />
        <div style={{ flex:"1 1 0", minWidth:360 }}>
          <RightColumnTabs
            team={renderTeam}
            roleByName={roleByName}
            supChat={supChat}
            onSupSend={onSupSend}
            supSendBusy={supSendBusy}
            autoApprove={autoApprove}
            onToggleAutoApprove={() => setAutoApprove(v => !v)}
            projectId={selectedProjectId}
            directives={directives}
            onDirectivesChanged={reloadDirectives}
            directorMode={directorMode}
            onToggleDirectorMode={() => setDirectorMode(!directorMode)}
            parallelMode={parallelMode}
            onToggleParallel={() => setParallelMode(!parallelMode)}
            agentLogs={agentLogs}
            agentThoughts={agentThoughts}
            runError={runError}
            serverState={serverState}
            selectedAgent={selectedNode}
            activeAgent={activeAgent}
            phase={phase}
            models={models}
            modelFor={modelFor}
            onPickAgentModel={onPickAgentModel}
            accountsStatus={accountsStatus}
            effectiveTeamModel={effectiveTeamModel}
            onPickTeamModel={onPickTeamModel}
            needsLoad={dockNeedsLoad}
            loadingModel={dockLoadingModel}
            onLoadModel={dockLoadModel}
            voiceFor={voiceFor}
            onPickAgentVoice={onPickAgentVoice}
            ttsVoices={ttsVoices}
          />
        </div>
      </div>
    </div>
  );
}
