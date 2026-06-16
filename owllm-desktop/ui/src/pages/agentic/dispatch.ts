// Shared dispatch primitives — used by both AgentsPage (desktop runs
// triggered from the SuperUserCard / Run button) and the AppShell-level
// TelegramBridgeRunner. Keeping them in one place means the bridge
// runs the SAME orchestrator → specialists → integrate flow the
// desktop runs, so phone-driven sessions look identical in the canvas
// (active-agent pulse, Thought tab, per-agent Reply log).
//
// This is a pure-data module — no React hooks, no state setters. The
// caller supplies hook callbacks (onLog, onThought, onActiveAgent,
// onPhase) so each consumer plugs its own state machine in.

import { Channel, invoke } from "@tauri-apps/api/core";
import {
  executeToolCall,
  formatToolsForOpenAI,
  unmangleMcpName,
  renderToolResultsForModel,
  renderValidationErrorsForModel,
  validateCall,
  firstRequiredArg,
  type ToolCall,
  type ToolExecResult,
} from "./localTools";
import { canonicalizeNativeCalls, type RawNativeCall } from "./toolNormalizer";
import { samplingFor } from "./modelProfiles";
import { resolveInferenceBase } from "./inferenceEndpoint";
// Auto routing (P0-4) resolves against the SAME catalogue the picker shows.
import { buildEntries } from "./ModelPicker";

// Mirror of accounts.rs ClaudeStreamEvent. Discriminated union keyed
// off `kind`; the field name comes from #[serde(tag = "kind")] on the
// Rust enum.
type ClaudeStreamEvent =
  | { kind: "text"; delta: string }
  | { kind: "thinking"; delta: string }
  | { kind: "toolUse"; toolUseId: string; name: string; input: string }
  | { kind: "toolResult"; toolUseId: string; content: string }
  | { kind: "error"; message: string };

// Run claude --print --output-format stream-json and route events to
// the user-facing reply (onDelta) + Thought tab (onThought). Returns
// the assembled assistant text on completion. Used whenever the
// Anthropic dispatch falls through to the Claude Code subscription
// path AND the caller cares about thinking / tool surfacing — i.e.
// the AgentsPage Thought tab. Falls back to claude_cli_complete (one
// final blob) when no onThought handler is supplied.
async function runClaudeCliStream(args: {
  systemPrompt: string;
  userMessage: string;
  cwd?: string | null;
  autoApprove?: boolean;
  allowedTools?: string[];
  /// Bare Claude model id (no "sub/"/"api/" prefix, no ":effort"
  /// suffix). Passes through to the CLI as `--model`.
  model?: string | null;
  /// Effort tier: "low"|"medium"|"high"|"xhigh"|"max". Passes as `--effort`.
  effort?: string | null;
  /// Persistent session UUID — same id across calls gives multi-turn memory.
  sessionId?: string | null;
  /// Enable SendUserMessage tool (--brief). The dispatch tap below
  /// surfaces those questions to the user via onAskUser if supplied,
  /// or falls back to a "❓ to user" entry in the Thought channel.
  /// Defaults to TRUE — same default as VS Code's Claude Code session.
  briefMode?: boolean;
  /// Called when the agent emits a SendUserMessage tool call. The
  /// caller can show a modal/inline prompt and (later) feed the
  /// answer back through stdin. For now (Phase C v1) we just route
  /// the question to the chat thread so the user sees it next turn.
  onAskUser?: (question: string) => void;
  onDelta: (delta: string) => void;
  onThought: (channel: string, role: string, delta: string) => void;
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
        // Special-case SendUserMessage — that's the agent asking the
        // user a question (enabled by --brief). Route to onAskUser
        // when the caller provides one; otherwise still surface it
        // distinctly in the Thought tab so it doesn't blend into
        // the generic 🛠 tool stream.
        if (msg.name === "SendUserMessage") {
          const question = parseUserMessageInput(msg.input);
          if (args.onAskUser) args.onAskUser(question);
          args.onThought("ask-user", "❓ agent asks", question);
          break;
        }
        // One Thought entry per tool invocation. Channel id encodes
        // the tool name + its tool_use_id so a follow-up tool_result
        // can land under the same block (see toolResult below).
        const channel = `tool:${msg.name}:${msg.toolUseId}`;
        const body = msg.input ? `${msg.input}` : "";
        args.onThought(channel, `🛠 ${msg.name}`, body);
        break;
      }
      case "toolResult": {
        // Surface the result under a sibling channel so the user sees
        // both request and outcome — but truncate giant outputs (file
        // dumps, full repo trees) to keep the panel readable.
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
    // Default ON — matches VS Code Claude Code where the agent can
    // always ask the user a question mid-turn. Callers can pass false
    // explicitly to disable when truly autonomous behaviour is wanted.
    briefMode: args.briefMode ?? true,
    onEvent: ch,
  });
}

/// Run `codex exec --json` and route its event stream to the reply
/// (onDelta) + Thought tab (onThought), mirroring runClaudeCliStream.
/// Codex does NOT stream assistant text token-by-token (the agent_message
/// arrives whole), but it DOES stream reasoning / command / MCP-tool /
/// web-search events — so the user sees live activity instead of a frozen
/// blank until the one-shot codex_cli_complete returned the whole blob.
/// Reuses the ClaudeStreamEvent wire shape (codex_cli_stream emits the
/// identical tagged JSON) so there's one handler for both CLIs.
export async function runCodexCliStream(args: {
  imagePaths?: string[];
  systemPrompt: string;
  userMessage: string;
  cwd?: string | null;
  onDelta: (delta: string) => void;
  onThought: (channel: string, role: string, delta: string) => void;
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
        const channel = `tool:${msg.name}:${msg.toolUseId}`;
        args.onThought(channel, `🛠 ${msg.name}`, msg.input ? `${msg.input}` : "");
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
  return await invoke<string>("codex_cli_stream", {
    systemPrompt: args.systemPrompt,
    userMessage: args.userMessage,
    cwd: args.cwd ?? null,
    imagePaths: args.imagePaths ?? null,
    onEvent: ch,
  });
}

/// Best-effort extraction of the message text from a SendUserMessage
/// tool call's input. The CLI stringifies the JSON input; the schema
/// is `{ message: string }` for this tool. Falls back to the raw
/// input when parsing fails so we never lose the question entirely.
function parseUserMessageInput(input: string): string {
  if (!input) return "(empty)";
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed.message === "string") return parsed.message;
    if (parsed && typeof parsed.text === "string") return parsed.text;
  } catch { /* not JSON, treat as raw */ }
  return input;
}

/// Map the picker's effort label to the Claude CLI's `--effort` vocabulary.
/// Picker uses "extra_high" for UI parity with the OpenAI side; the CLI
/// wants "xhigh". Returns null for "low" (no flag → default fast mode)
/// when callerWantsExplicitLow is false — the user only sees explicit
/// effort tiers on the picker for Opus/Sonnet so "low" effectively
/// means "don't pass --effort at all", which is fastest.
export function mapClaudeEffort(uiLevel: string | null | undefined): string | null {
  if (!uiLevel) return null;
  if (uiLevel === "extra_high") return "xhigh";
  if (["low", "medium", "high", "xhigh", "max"].includes(uiLevel)) return uiLevel;
  return null;
}

/// Pull the "<bareModel>" and "<effort>" parts out of a model id like
/// "claude-opus-4-7:high". Used by both the API and CLI subscription
/// paths in streamAnthropic.
export function parseClaudeModelId(modelId: string): { wireModel: string; effort: string | null } {
  const sep = modelId.indexOf(":");
  if (sep === -1) return { wireModel: modelId, effort: null };
  return { wireModel: modelId.slice(0, sep), effort: modelId.slice(sep + 1) };
}

// ---------- Claude CLI session management (Phase B) ----------
//
// Each (projectId, agentName) pair gets its own persistent CLI session
// UUID. Reusing the same id across dispatches means the Claude Code
// CLI loads the prior turn's context — the agent has real multi-turn
// memory without us re-feeding everything through foldHistoryIntoPrompt.
//
// Mirrors the VS Code Claude Code session model: each agent role has
// its own evolving conversation. Orchestrator remembers planning
// history; coder remembers code history; etc. Bypasses the one-shot
// nature of --print mode.
//
// Storage: localStorage when available (persists across app restarts);
// in-memory Map otherwise (bridge runner, tests). The mem cache fronts
// localStorage so we don't hammer it on every call.

const SESSION_KEY_PREFIX = "owllm:claude_session:";
const sessionMemCache = new Map<string, string>();

function sessionKey(projectId: string, agentName: string): string {
  return `${SESSION_KEY_PREFIX}${projectId}:${agentName}`;
}

/// Return (and create if missing) the Claude CLI session UUID for an
/// (agent, project) pair. Returns null when either arg is empty so a
/// caller without context just runs in stateless one-shot mode.
export function getClaudeSession(
  projectId: string | null | undefined,
  agentName: string | null | undefined,
): string | null {
  if (!projectId || !agentName) return null;
  const key = sessionKey(projectId, agentName);
  const cached = sessionMemCache.get(key);
  if (cached) return cached;
  try {
    const stored = localStorage.getItem(key);
    if (stored) { sessionMemCache.set(key, stored); return stored; }
  } catch { /* localStorage unavailable */ }
  // crypto.randomUUID is available in every Tauri webview (Edge/Chromium).
  const uuid = (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function")
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  sessionMemCache.set(key, uuid);
  try { localStorage.setItem(key, uuid); } catch {}
  return uuid;
}

/// Wipe every cached Claude session across every project. Used when
/// the CLI reports "Session ID … is already in use" — that means a
/// prior process crashed without releasing the lock, and the next
/// call will keep hitting the same stale id unless we evict it from
/// our cache too.
export function clearAllClaudeSessions(): void {
  for (const k of Array.from(sessionMemCache.keys())) {
    if (k.startsWith(SESSION_KEY_PREFIX)) sessionMemCache.delete(k);
  }
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(SESSION_KEY_PREFIX)) toRemove.push(k);
    }
    for (const k of toRemove) localStorage.removeItem(k);
  } catch { /* localStorage unavailable */ }
}

/// Clear the cached session id(s). Pass agentName to reset one agent;
/// omit it to reset every agent in the project. Forces the next call
/// to start a fresh CLI session — the agent forgets its prior turns.
export function resetClaudeSession(projectId: string, agentName?: string): void {
  if (agentName) {
    const key = sessionKey(projectId, agentName);
    sessionMemCache.delete(key);
    try { localStorage.removeItem(key); } catch {}
    return;
  }
  const prefix = `${SESSION_KEY_PREFIX}${projectId}:`;
  for (const k of Array.from(sessionMemCache.keys())) {
    if (k.startsWith(prefix)) sessionMemCache.delete(k);
  }
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) toRemove.push(k);
    }
    for (const k of toRemove) localStorage.removeItem(k);
  } catch {}
}

// ---------- Domain types (mirrors AgentsPage.tsx) ----------
export type GoalMsg = {
  role: string;
  color: string;
  text: string;
  /// Renderer hint: "thinking" italic, "tool" monospace command block,
  /// "dispatch" / undefined → default reply look. See AgentsPage for
  /// exact styling.
  kind?: "thinking" | "tool" | "dispatch";
  /// Stable per-(agent, stream) id used to coalesce successive deltas
  /// into one entry rather than spawning a new line per chunk.
  channelKey?: string;
  /// Monotonic per-creation id stamped by AgentsPage so the Full Chat
  /// tab can interleave reply + thought streams in arrival order. Set
  /// on receipt of cross-process events too (bridge runner → window
  /// events) so chronological ordering survives the IPC boundary.
  seq?: number;
};
export type HistoryItem = { role: "user" | "assistant"; content: string };

// Multimodal attachment carrier. Raw bytes ride as base64 strings so
// the same payload survives the JSON serialization on every provider
// hop (OpenAI image_url data: URIs, Anthropic image.source.base64,
// llama.cpp llava image_url). `mime` keeps the original content-type
// so we can pick the right format hint per provider.
//
// Audio attachments NEVER reach the chat-completions wire. They get
// transcribed via OpenAI Whisper up-front and the transcript is
// folded into userMessage. That removes a pile of format-coupling
// headaches (Telegram voice = ogg-opus, OpenAI input_audio = wav/mp3
// only, Anthropic + llama-server have no audio path at all) and gives
// every provider the same "I see the audio said X" experience.
export type Attachment = {
  kind: "image" | "audio";
  mime: string;
  data_b64: string;
  filename?: string;
};
export type AgentSpec = {
  name: string;
  base: string;
  icon?: string | null;
  description?: string;
  extraPrompt?: string;
};
export type Edge = { source: string; target: string };

// ---------- Edges drive dispatch (P0-2) ----------
//
// The drawn graph is an EXECUTION graph, not a picture. When a team has
// edges, an orchestrator `@agent:` line is honored only if an edge
// orchestrator→agent exists; the roster shown to the orchestrator is its
// outgoing edges. A team with NO edges keeps today's free-dispatch
// behavior so existing projects work unchanged.

/// The set of agents the orchestrator may dispatch to, derived from its
/// outgoing edges. `null` = the team has no edges at all → free dispatch.
export function wiredDispatchTargets(
  team: { agents: Array<{ name: string }>; edges?: Edge[] },
  orchName: string,
): Set<string> | null {
  const edges = Array.isArray(team.edges) ? team.edges : [];
  if (edges.length === 0) return null;
  const wired = new Set<string>();
  for (const e of edges) {
    if (e && e.source === orchName && typeof e.target === "string") wired.add(e.target);
  }
  return wired;
}

/// Tier-3 autonomous handoff (P0-2): the agents `agentName` hands its OUTPUT to,
/// i.e. its outgoing edges EXCLUDING the orchestrator and itself. Empty = this
/// agent is a chain SINK → its output returns to the orchestrator to integrate.
/// An arrow `coder → critic` makes the critic receive the coder's output; an
/// arrow back to the orchestrator just ends the chain. Pure + unit-tested.
export function downstreamTargets(
  team: { edges?: Edge[] },
  agentName: string,
  orchName: string,
): string[] {
  const edges = Array.isArray(team.edges) ? team.edges : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (
      e && e.source === agentName && typeof e.target === "string" &&
      e.target !== orchName && e.target !== agentName && !seen.has(e.target)
    ) {
      seen.add(e.target);
      out.push(e.target);
    }
  }
  return out;
}

/// The maximum number of agents a single handoff chain may run before it stops —
/// a hard backstop against cyclic graphs (critic→coder→critic→…). Combined with
/// a per-chain visited set this guarantees termination.
export const MAX_CHAIN_HOPS = 8;

/// Model-visible correction for dispatch lines that named REAL team members
/// the graph doesn't wire to the orchestrator. Distinct wording from the
/// no-such-agent case (P1-3) — the agent exists, the edge doesn't.
export function unwiredCorrectionMessage(unwired: Dispatch[], wired: Set<string>): string {
  const lines = unwired.map(d => `- "@${d.agentName}:" is on the team but NOT WIRED to you (no edge from you to it in the graph)`);
  const roster = [...wired].join(", ") || "(none — the graph wires no one to you)";
  return [
    "[dispatch blocked by the team graph — fix and re-emit]",
    "These dispatch lines were NOT executed:",
    ...lines,
    `Your wired specialists are exactly: ${roster}.`,
    wired.size > 0
      ? "Re-emit your dispatch lines now using only wired agents, one per line, as `@<agent>: <instruction>`."
      : "No agent is wired to you — answer the user yourself, and mention that the team graph has no edges from the orchestrator.",
  ].join("\n");
}
export type Team = {
  id: string;
  name: string;
  display: string;
  category: string;
  description: string;
  icon: string;
  agents: AgentSpec[];
  edges: Edge[];
};
export type RoleData = {
  name: string;
  icon?: string;
  description?: string;
  systemPrompt?: string;
  canDispatch?: boolean;
  defaultTemperature?: number;
  /// OWLLM tool names this role is allowed to use (read_file, shell,
  /// edit_file, …). Passed to the Claude CLI as --allowedTools after
  /// translation in accounts.rs. ["all"] / undefined / [] → unrestricted.
  toolAllowlist?: string[];
};
export type ModelInfo = {
  model_id: string;
  port: number | null;
  base_model: string | null;
  size_mib: number | null;
  provider: string; // "local" | "anthropic" | "openai"
};
export type ServerStatus = {
  running: boolean;
  model_id: string | null;
  port: number | null;
  message?: string;
};
export type DispatchPhase = "idle" | "planning" | "dispatching" | "integrating" | "done";

/// Why can't we reach the local llama-server? Ask the supervisor before
/// surfacing a generic network error: a crashed server carries a NAMED
/// cause (OOM / broken GGUF, classified from its stderr in server.rs) in
/// server_status.message (P1-4 legibility). Falls back to the given
/// message when the supervisor says the server is fine (true network
/// issue) or can't be reached itself.
async function localServerFailureMessage(fallback: string): Promise<string> {
  try {
    const s = await invoke<ServerStatus>("server_status");
    if (!s.running) {
      if (s.message && /crash|ended unexpectedly/i.test(s.message)) {
        return `The local model server crashed. ${s.message}`;
      }
      return "The local model server is not running — load a model on the Server page, wait for ready, then retry.";
    }
  } catch { /* supervisor unavailable — fall through */ }
  return fallback;
}

// ---------- Backend shapes (for team/role loading) ----------
export type TeamTemplateBackend = { id: string; path: string; built_in: boolean; data: any };
export type AgentRoleBackend    = { id: string; path: string; built_in: boolean; data: any };
export type ProjectRow = {
  id: string; name: string; description: string; location: string;
  trust_writes: boolean; auto_approve_all: boolean;
  team: string[]; team_default_model_id: string;
  graph_json: string;
  chat_json: string;
  agent_logs_json: string;
  updated_at: string;
};

// ---------- Helpers ----------
const _ACRONYMS = new Set(["ux","ui","api","mcp","gpu","be","fe","qa","cli","sql","db"]);
// Mirror of Rust `Directive` (src-tauri/src/directives.rs). Loaded from
// SQLite per-project; injected into every agent's system prompt so the
// orchestrator, specialists, AND the critic all see the same rules.
// `kind` drives the framing ("MUST", "Prefer", "Avoid") and the colour
// chip in the React panel.
export type Directive = {
  id: string;
  project_id: string;
  kind: "must" | "prefer" | "avoid";
  text: string;
  source: string;
  created_at: string;
  updated_at: string;
};

/// Render the directive list as a system-prompt block. Returns "" when
/// the project has no directives so the prompt stays clean. Grouping by
/// kind so a single read of the block produces the right mental model
/// for the agent ("things I cannot violate" / "preferences" / "things
/// to avoid").
export function formatDirectivesBlock(directives: Directive[] | null | undefined): string {
  if (!directives || directives.length === 0) return "";
  const must = directives.filter(d => d.kind === "must");
  const prefer = directives.filter(d => d.kind === "prefer");
  const avoid = directives.filter(d => d.kind === "avoid");
  const lines: string[] = ["", "--- PROJECT RULES (set by the user — apply to every turn) ---"];
  if (must.length > 0) {
    lines.push("MUST:");
    must.forEach(d => lines.push(`  - ${d.text}`));
  }
  if (prefer.length > 0) {
    lines.push("PREFER:");
    prefer.forEach(d => lines.push(`  - ${d.text}`));
  }
  if (avoid.length > 0) {
    lines.push("AVOID:");
    avoid.forEach(d => lines.push(`  - ${d.text}`));
  }
  lines.push("--- END PROJECT RULES ---", "");
  return lines.join("\n");
}

export function displayLabel(fullName: string): string {
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
export function colorForAgent(spec: AgentSpec): string {
  return ROLE_COLORS[spec.base] ?? ROLE_COLORS[spec.name] ?? "#9ad9ff";
}

export function findOrchestratorSpec(team: Team): AgentSpec | undefined {
  return (
    team.agents.find(a => a.name === "orchestrator") ??
    team.agents.find(a => a.base === "orchestrator") ??
    team.agents[0]
  );
}

/// Locate the Critic on the team, if present. Used by the brainstorm
/// phase that runs between the orchestrator's first plan and the
/// specialist dispatch — the critic reviews the plan and feeds back
/// before any work is delegated.
export function findCriticSpec(team: Team): AgentSpec | undefined {
  return (
    team.agents.find(a => a.name === "critical_thinker") ??
    team.agents.find(a => a.base === "critical_thinker") ??
    team.agents.find(a => a.name === "critic") ??
    team.agents.find(a => a.base === "critic")
  );
}

export function toTeam(t: TeamTemplateBackend): Team {
  const d = t.data ?? {};
  const agents: AgentSpec[] = Array.isArray(d.agents)
    ? d.agents.map((a: any) => ({
        name: a.name,
        base: a.base,
        icon: a.icon ?? null,
        description: typeof a.description === "string" ? a.description : undefined,
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

export function projectToTeam(p: ProjectRow): Team {
  const agents: AgentSpec[] = (p.team ?? []).map(n => ({ name: n, base: n }));
  let edges: Edge[] = [];
  if (p.graph_json && p.graph_json.trim().length > 0) {
    try {
      const parsed = JSON.parse(p.graph_json);
      if (Array.isArray(parsed?.edges)) {
        edges = parsed.edges
          .filter((e: any) => typeof e?.source === "string" && typeof e?.target === "string")
          .map((e: any) => ({ source: e.source, target: e.target }));
      }
    } catch { /* fall back to no edges */ }
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

export function rolesFromBackend(rows: AgentRoleBackend[]): Map<string, RoleData> {
  const m = new Map<string, RoleData>();
  for (const r of rows) {
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
  return m;
}

// ---------- Prompt builders ----------
export function buildOrchestratorPrompt(
  team: Team,
  roleByName: Map<string, RoleData>,
  orch: AgentSpec,
  directives?: Directive[],
  directorMode?: boolean,
  /// Project BRIEF.md contents (from the brainstormer). When present,
  /// becomes a binding scope block — orchestrator must respect v1
  /// scope, feature priority, and GUI direction. Missing = legacy
  /// free-interpretation behaviour.
  briefText?: string,
): string {
  // Edge-seeded roster (P0-2): when the team has a graph, the orchestrator
  // only SEES the specialists its outgoing edges reach — the drawn graph
  // defines who's reachable. No edges → whole team (legacy free dispatch).
  const wired = wiredDispatchTargets(team, orch.name);
  const specialists = team.agents.filter(
    a => a.name !== orch.name && (wired === null || wired.has(a.name)),
  );
  const rosterLines = specialists.map(a => {
    const desc = a.description ?? roleByName.get(a.base)?.description ?? "";
    return `  - ${a.name} (${a.base}): ${desc}`;
  });
  // The synthetic Critical Thinker is rendered on the canvas but never
  // listed in team.agents — so the orchestrator's roster used to omit
  // it entirely and @critical_thinker dispatches went nowhere. Always
  // expose it as a peer-reviewer / sanity-checker; the runtime handles
  // @critical_thinker calls via extractUserInputRequest (works in BOTH
  // director-mode AND regular mode now).
  const hasRealCritic = team.agents.some(a => a.name === "critical_thinker");
  if (!hasRealCritic) {
    rosterLines.push(
      "  - critical_thinker (critic): peer-reviewer for decisions you're unsure about. " +
      "Dispatch with `@critical_thinker: <question>` to get a single one-shot answer " +
      "before continuing. Use sparingly — designed for hard calls, not chitchat.",
    );
  }
  const roster = rosterLines.join("\n");
  const orchRole = roleByName.get(orch.base);
  const orchBase =
    orchRole?.systemPrompt ??
    orchRole?.description ??
    "Plan the work, dispatch one task at a time, integrate the results.";
  const orchSystemPrompt = orch.extraPrompt
    ? `${orchBase}\n\n--- TEAM-SPECIFIC GUIDANCE ---\n${orch.extraPrompt}`
    : orchBase;
  // Pick one specialist to use as a worked example so the dispatch
  // format is unambiguous. Falls back to a generic "@coder" stub when
  // no specialists are configured (solo team).
  const exampleAgent = specialists[0]?.name ?? "coder";
  const directivesBlock = formatDirectivesBlock(directives);
  // Director-mode framing: when the user has appointed a Critic agent
  // to stand in for them, the orchestrator should KNOW that "asking the
  // user" still gets a real answer (from the critic) so it should ask
  // when uncertain instead of guessing. The dispatch runtime intercepts
  // [NEED_USER_INPUT] markers and routes them to the critic.
  const directorBlock = directorMode
    ? [
        "",
        "--- DIRECTOR MODE: A Critic agent stands in for the user ---",
        "If you need a decision that is normally the user's call (scope, naming, business logic, tradeoffs),",
        "emit a line that begins with `[NEED_USER_INPUT]` followed by your question on the same line.",
        "Example:",
        "    [NEED_USER_INPUT] Should the new endpoint require auth? My instinct is yes.",
        "The runtime will route that to the Critic, who answers in the user's voice from the project rules.",
        "Their reply will be folded back into your context and you'll resume.",
        "Use this sparingly — once or twice per dispatch at most.",
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
  return [
    `You are the orchestrator of the '${team.display}' team.`,
    "",
    orchSystemPrompt,
    briefBlock,
    directivesBlock,
    directorBlock,
    "",
    `YOUR SPECIALISTS (use their EXACT names when dispatching — copy/paste from this list):`,
    roster || "  (none — solo)",
    "",
    "HOW TO RESPOND — READ CAREFULLY:",
    "  1. Restate the user's goal in one sentence.",
    "  2. Sketch a brief plan (2-5 bullets).",
    "  3. Emit one `@<agent_name>: <instruction>` line PER specialist you want to run. They run IN PARALLEL — dispatch every relevant agent in this same reply, do not wait.",
    "  4. After your reply ends the runtime runs the specialists, then invokes you AGAIN with their replies. That second turn is when you write the user-facing answer — not now.",
    "",
    "DISPATCH FORMAT — exact, case-sensitive:",
    "    @<agent_name>: <one clear, specific instruction>",
    "",
    "Example for this team (mirror this pattern with as many @-lines as you need):",
    `    @${exampleAgent}: <a concrete, scoped task for ${exampleAgent} — what to read, what to change, what success looks like>`,
    "",
    "DO NOT:",
    "  - Try to do the work yourself. Your tools are read-only on purpose.",
    "  - Ask the user clarifying questions in this turn — dispatch your best-guess plan; you can refine in the integration turn.",
    "  - Reply without any @<agent>: lines unless the goal is a pure no-edit, no-shell, no-external-call question. If you do, the user sees zero specialist activity and that is almost always wrong.",
  ].join("\n");
}

export function buildSpecialistPrompt(
  team: Team,
  spec: AgentSpec,
  roleByName: Map<string, RoleData>,
  directives?: Directive[],
): string {
  const role = roleByName.get(spec.base);
  const layers: string[] = [
    `You are ${displayLabel(spec.name)} (${spec.base}) on the '${team.display}' team.`,
    "",
  ];
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

/// Build the Critic agent's system prompt. The Critic answers in the
/// user's voice when the orchestrator emits [NEED_USER_INPUT]. It
/// leans heavily on the directive list because that IS the user's
/// distilled judgment for this project. No team roster — the Critic
/// is not part of the team, just a voice-of-user side-channel.
export function buildCriticPrompt(
  team: Team,
  directives?: Directive[],
): string {
  const directivesBlock = formatDirectivesBlock(directives);
  return [
    `You are the Critic — the user's voice-of-self for the '${team.display}' project.`,
    "",
    "The user has stepped away. The orchestrator hit a decision point that's normally the user's call and asked for input. Your job is to answer AS THE USER WOULD, grounded in the project rules below.",
    directivesBlock || "(The user hasn't set any project rules yet — fall back to your best judgment of standard production-quality engineering practice.)",
    "",
    "HOW TO RESPOND:",
    "  - Give a short, direct, decisive answer (1-3 sentences max).",
    "  - Don't hedge or list options. Pick. The orchestrator needs a directive, not a discussion.",
    "  - When the question conflicts with a project rule, cite the rule briefly: `(rule: never mock data)`.",
    "  - When the question is outside the rules, use the rules' spirit + production-engineering common sense.",
    "  - Do NOT preface with 'As the user, …' or 'Speaking for the user …'. Just answer.",
  ].join("\n");
}

// ---------- Dispatch parser ----------
export type Dispatch = { agentName: string; instruction: string };

/// A dispatch line whose @name resolved to NO team member, with the nearest
/// real name as a suggestion. Surfaced to the user AND fed back to the
/// orchestrator (P1-3: fail loud, never silently drop a specialist).
export type UnresolvedDispatch = { name: string; instruction: string; suggestion: string | null };

export type DispatchParse = { dispatches: Dispatch[]; unresolved: UnresolvedDispatch[] };

/// Structural team shape the parser needs — keeps it shareable with
/// AgentsPage's own Team type (§0.4: ONE parser, not two drifting copies).
type TeamLike = { agents: Array<{ name: string }> };

/// Levenshtein distance — small inputs (agent names), no need for anything fancier.
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

/// Normalize an agent name for tolerant matching: lowercase, strip
/// separators/punctuation. "Data-Analyst." → "dataanalyst".
function normName(s: string): string {
  return s.toLowerCase().replace(/[\s._\-]+/g, "");
}

/// Resolve a model-emitted @name to a real team member. Steps: exact →
/// case-insensitive → normalized (case + punctuation + separators) →
/// fuzzy (edit distance ≤ 2 on the normalized form, but never more than
/// half the name — "codr" finds "coder"; "designer" must NOT find "coder").
/// Returns the canonical team name, or null.
function resolveAgentName(raw: string, teamNames: string[]): string | null {
  if (teamNames.includes(raw)) return raw;
  const lower = raw.toLowerCase();
  const ci = teamNames.find(n => n.toLowerCase() === lower);
  if (ci) return ci;
  const norm = normName(raw);
  if (!norm) return null;
  const nn = teamNames.find(n => normName(n) === norm);
  if (nn) return nn;
  let best: { name: string; d: number } | null = null;
  for (const n of teamNames) {
    const d = editDistance(norm, normName(n));
    if (best === null || d < best.d) best = { name: n, d };
  }
  if (best && best.d <= 2 && best.d <= Math.floor(normName(best.name).length / 2)) {
    return best.name;
  }
  return null;
}

/// Nearest team name for a "did you mean …?" hint (looser than resolution).
function nearestAgentName(raw: string, teamNames: string[]): string | null {
  const norm = normName(raw);
  let best: { name: string; d: number } | null = null;
  for (const n of teamNames) {
    const d = editDistance(norm, normName(n));
    if (best === null || d < best.d) best = { name: n, d };
  }
  return best && best.d <= 3 ? best.name : null;
}

/// Tolerant dispatch parse. Accepts `@coder: task`, `- @Coder: task`,
/// `1. @ coder : task`, `**@coder:** task`, fuzzy names (`@codr:`), and
/// reports every line that named NO resolvable agent in `unresolved` so the
/// caller can fail loud instead of dropping it (P1-3).
export function parseDispatchesDetailed(text: string, team: TeamLike, exclude: string): DispatchParse {
  const teamNames = team.agents.map(a => a.name);
  const lines = text.split(/\r?\n/);
  const dispatches: Dispatch[] = [];
  const unresolved: UnresolvedDispatch[] = [];
  // `@ name` (optional space), list/bold/quote prefixes, fullwidth colon,
  // and leading markdown bold asterisks stripped off the instruction.
  const re = /^[\s\-\d.*•>]*@\s*([A-Za-z0-9._\-]+)\s*\**\s*[:：]\s*(.+)$/;
  for (const raw of lines) {
    const m = raw.trim().match(re);
    if (!m) continue;
    const name = m[1];
    const instruction = m[2].replace(/^[\s*]+/, "").trim();
    if (!instruction) continue;
    // critical_thinker is a synthetic agent (not in team.agents); it's
    // routed via extractUserInputRequest's CRITIC_DISPATCH_RE branch
    // instead. Skip here so we don't fall through to the unknown-agent
    // path.
    if (/^critical[_\s-]?thinker$/i.test(name)) continue;
    const resolved = resolveAgentName(name, teamNames);
    if (resolved === null) {
      unresolved.push({ name, instruction, suggestion: nearestAgentName(name, teamNames) });
      continue;
    }
    if (resolved === exclude) continue; // orchestrator never self-dispatches
    dispatches.push({ agentName: resolved, instruction });
  }
  return { dispatches, unresolved };
}

export function parseDispatches(text: string, team: TeamLike, exclude: string): Dispatch[] {
  return parseDispatchesDetailed(text, team, exclude).dispatches;
}

/// One model-visible correction message for unresolved dispatch lines —
/// fed back to the orchestrator so it can re-emit with real names.
export function unresolvedCorrectionMessage(unresolved: UnresolvedDispatch[], team: TeamLike, exclude: string): string {
  const roster = team.agents.map(a => a.name).filter(n => n !== exclude).join(", ");
  const lines = unresolved.map(u =>
    `- "@${u.name}:" names no agent on this team${u.suggestion ? ` — did you mean '@${u.suggestion}:'?` : ""}`);
  return [
    "[dispatch error — fix and re-emit]",
    "These dispatch lines named agents that do not exist, so NOTHING was dispatched for them:",
    ...lines,
    `Your team is exactly: ${roster}.`,
    "Re-emit the dispatch lines now, one per line, as `@<exact-agent-name>: <instruction>`. Do not apologize or explain.",
  ].join("\n");
}

export function stripDispatchDirectives(text: string): string {
  const re = /^[\s\-\d.*•]*@[A-Za-z0-9._\-]+\s*[:：]/;
  return text.split(/\r?\n/).filter(l => !re.test(l.trim())).join("\n");
}

// ---------- History helpers ----------
export function chatToHistory(chat: GoalMsg[]): HistoryItem[] {
  const out: HistoryItem[] = [];
  for (const m of chat) {
    if (!m || typeof m.text !== "string" || !m.text.trim()) continue;
    if (m.role === "system" || m.role === "error" || m.role === "dispatch") continue;
    out.push({ role: m.role === "you" ? "user" : "assistant", content: m.text });
  }
  return out;
}

export function foldHistoryIntoPrompt(userMessage: string, history?: HistoryItem[]): string {
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

// ---------- Model routing ----------
export function stripModelPrefix(id: string): string {
  for (const p of ["sub/", "api/", "auto/"]) {
    if (id.startsWith(p)) return id.slice(p.length);
  }
  return id;
}

export function providerFor(modelId: string, models: ModelInfo[]): string {
  if (!modelId) return "local";
  if (modelId.startsWith("auto/")) return "auto";
  const bare = stripModelPrefix(modelId);
  if (modelId.startsWith("sub/") || modelId.startsWith("api/")) {
    if (bare.startsWith("claude-")) return "anthropic";
    if (bare.startsWith("gpt-") || bare === "o3") return "openai";
  }
  const m = models.find(x => x.model_id === bare);
  return m?.provider || "local";
}

// ---------- Stream functions ----------
type StreamHandler = (delta: string) => void;
// Channel-keyed thought/tool stream. `channel` is a stable id so the
// consumer can route deltas to the right open block (e.g. "thinking",
// "tool:Write:abc123"). `role` is the human label shown on first append
// ("thinking", "🛠 Write", etc.). `delta` is the text chunk.
export type ThoughtHandler = (channel: string, role: string, delta: string) => void;
type CloudRoute = { forceSub?: boolean; forceApi?: boolean };

// One-time-per-session token warm-up for subscription CLIs.
//
// THE BUG THIS FIXES: the Claude/Codex CLI's FIRST authenticated call after
// app start can return "API Error: 401 Invalid authentication credentials"
// while it refreshes its OAuth access token in the background; the NEXT call
// succeeds. That's exactly why clicking "Test" on the Accounts page (a
// throwaway `claude --print ok`) made the first real chat work — Test
// absorbed the cold-start 401 and refreshed the token. We now do that
// warm-up automatically before the first subscription dispatch of each
// backend, so the user never has to hit Test first.
const _warmedCli = new Set<string>();
export async function ensureCliWarm(backend: "claude_cli" | "codex_cli"): Promise<void> {
  if (_warmedCli.has(backend)) return;
  _warmedCli.add(backend); // mark BEFORE awaiting so a slow warm can't double-fire
  try {
    // Same minimal CLI round-trip the Accounts "Test" button runs; it
    // refreshes the token as a side effect. Best-effort — if it fails we
    // still attempt the real call (which may itself succeed or surface a
    // clearer error).
    await invoke("accounts_test_probe_live", { backend });
  } catch {
    /* ignore — warm-up is best-effort */
  }
}

// ---------- Attachment helpers ----------

export function imageAttachments(atts?: Attachment[]): Attachment[] {
  return (atts ?? []).filter(a => a.kind === "image");
}
export function audioAttachments(atts?: Attachment[]): Attachment[] {
  return (atts ?? []).filter(a => a.kind === "audio");
}

export function appendImageAttachmentNotes(userMessage: string, images: Attachment[]): string {
  if (images.length === 0) return userMessage;
  const note = images
    .map((a, i) => `[Image ${i + 1} attached: ${a.filename ?? a.mime}. Vision-capable backends receive the image bytes; otherwise state that you cannot inspect the image instead of guessing.]`)
    .join("\n");
  return userMessage ? `${userMessage}\n\n${note}` : note;
}

/// Make pasted images visible to a subscription / CLI agent (Claude Code, Codex,
/// Gemini) that takes only text on stdin: SAVE the images into the agent's
/// working directory and reference the file paths in the prompt, so the agent
/// opens them with its own image/Read tool. This is the documented Claude Code
/// "file path reference" mechanism — images work on a subscription with no API
/// key. Falls back to a clear note if saving isn't possible (no WSL cwd). The
/// override line neutralises appendImageAttachmentNotes' "state you cannot
/// inspect" guidance, which only applies to text-only backends.
/// Save pasted images into the agent's working directory and return their
/// cwd-relative paths (".owllm-inbox/image_N.ext"). Used by the codex path,
/// which attaches them via codex's native `-i` flag. Returns undefined when
/// there's nothing to save or no working directory. Verified end-to-end.
export async function saveCliImages(
  images: Attachment[],
  cwd?: string,
): Promise<string[] | undefined> {
  if (images.length === 0 || !cwd || !cwd.trim()) return undefined;
  try {
    const paths = await invoke<string[]>("agent_save_inbox_images", {
      cwd,
      images: images.map((a) => ({ data_b64: a.data_b64, mime: a.mime })),
    });
    return paths && paths.length > 0 ? paths : undefined;
  } catch {
    return undefined;
  }
}

export async function appendCliImageFiles(
  userMessage: string,
  images: Attachment[],
  cwd?: string,
): Promise<string> {
  if (images.length === 0) return userMessage;
  if (!cwd || !cwd.trim()) {
    return `${userMessage}\n\n[${images.length} image(s) were attached but no project folder is set, so they couldn't be saved for the agent to read.]`;
  }
  try {
    const saved = await invoke<string[]>("agent_save_inbox_images", {
      cwd,
      images: images.map((a) => ({ data_b64: a.data_b64, mime: a.mime })),
    });
    if (!saved || saved.length === 0) throw new Error("no paths returned");
    const list = saved.map((p) => `- ${p}`).join("\n");
    return (
      `${userMessage}\n\n[The user attached ${saved.length} image${saved.length === 1 ? "" : "s"}, ` +
      `now saved in your working directory. You CAN see them — OPEN AND VIEW each file before answering ` +
      `(use your image/Read tool); they are part of the question. Ignore any earlier note saying you ` +
      `cannot inspect images — that applies only to text-only backends.\n${list}]`
    );
  } catch (e) {
    return `${userMessage}\n\n[${images.length} image attachment(s) couldn't be saved for the agent: ${String((e as { message?: string })?.message ?? e)}]`;
  }
}

/// Transcribe every audio attachment and fold transcripts into the
/// user message. The product path is native whisper.cpp via Rust
/// (`audio_transcribe_local`); OpenAI Whisper is only a fallback when
/// the native runtime is missing and the user has explicitly saved an
/// API key.
type LocalAudioTranscription = { text: string; duration_sec: number; model: string };

async function transcribeLocalAudio(a: Attachment): Promise<LocalAudioTranscription> {
  return invoke<LocalAudioTranscription>("audio_transcribe_local", {
    dataB64: a.data_b64,
    mime: a.mime,
    filename: a.filename ?? null,
  });
}

async function transcribeOpenAIAudio(a: Attachment, key: string): Promise<string> {
  const bin = base64ToBytes(a.data_b64);
  const blob = new Blob([bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer], { type: a.mime });
  const fd = new FormData();
  const filename = a.filename ?? `audio.${extForMime(a.mime)}`;
  fd.append("file", blob, filename);
  fd.append("model", "whisper-1");
  fd.append("response_format", "text");
  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}` },
    body: fd,
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => `HTTP ${resp.status}`);
    throw new Error(err.slice(0, 200));
  }
  return (await resp.text()).trim();
}

export async function transcribeAudioAttachments(
  userMessage: string,
  attachments: Attachment[] | undefined,
  /// Optional surface for transcription failures so the caller can
  /// render a visible warning (yellow system note in the chat).
  /// Without this callback the failure just gets folded into the
  /// user message and the orchestrator parrots "I can't transcribe…"
  /// without telling the user *why*. The caller passes an error
  /// string per failure (one per attachment).
  onWarn?: (text: string) => void,
  /// Fires once per successfully transcribed audio attachment so the
  /// caller can surface the transcribed text in the chat as soon as
  /// it lands — instead of waiting for the orchestrator to echo it
  /// back in its reply. Bridge/desktop wire this to a chat:appended
  /// event that drops a green "🎤 <text>" entry right after the
  /// user's placeholder.
  onTranscript?: (filename: string, text: string) => void,
): Promise<string> {
  const auds = audioAttachments(attachments);
  if (auds.length === 0) return userMessage;
  const transcripts: string[] = [];
  const key = await invoke<string | null>("accounts_get_secret", { name: "OPENAI_API_KEY" }).catch(() => null);
  for (const a of auds) {
    const filename = a.filename ?? `audio.${extForMime(a.mime)}`;
    let localError = "";
    try {
      const local = await transcribeLocalAudio(a);
      if (local.text.trim()) {
        transcripts.push(`[Audio "${filename}" transcript via local Whisper/${local.model}]\n${local.text.trim()}`);
        onTranscript?.(filename, local.text.trim());
        continue;
      }
      localError = "local Whisper returned an empty transcript";
    } catch (e: any) {
      localError = String(e?.message ?? e).slice(0, 240);
    }

    if (key) {
      try {
        const text = await transcribeOpenAIAudio(a, key);
        if (text) {
          transcripts.push(`[Audio "${filename}" transcript via OpenAI Whisper]\n${text}`);
          onTranscript?.(filename, text);
        } else {
          transcripts.push(`[Audio "${filename}" attached, but Whisper returned an empty transcript.]`);
        }
        continue;
      } catch (e: any) {
        const openaiErr = String(e?.message ?? e).slice(0, 200);
        const reason = `Local Whisper: ${localError}. OpenAI Whisper: ${openaiErr}.`;
        transcripts.push(`[Audio "${filename}" transcribe failed. ${reason}]`);
        onWarn?.(`⚠ Couldn't transcribe "${filename}". ${reason} — open Accounts → "Install voice runtime" if the local Whisper binary or model is missing.`);
        continue;
      }
    }

    transcripts.push(`[Audio "${filename}" attached, but local Whisper could not transcribe it: ${localError}.]`);
    onWarn?.(`⚠ Couldn't transcribe "${filename}" locally: ${localError}. Set OPENAI_API_KEY on the Accounts page for a cloud fallback, or open Accounts → "Install voice runtime" if the local binary/model is missing.`);
  }
  const block = transcripts.join("\n\n");
  return userMessage ? `${userMessage}\n\n${block}` : block;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function extForMime(mime: string): string {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("m4a") || mime.includes("aac")) return "m4a";
  if (mime.includes("flac")) return "flac";
  return "bin";
}

/// OpenAI-compatible user-message content: plain string if no images,
/// otherwise an array of `text` + `image_url` parts. Used for both the
/// public OpenAI API and the OpenAI-compatible local llama-server
/// (llava-class models accept data: URIs in image_url).
export function openaiUserContent(text: string, images: Attachment[]): unknown {
  if (images.length === 0) return text;
  const parts: any[] = [];
  if (text) parts.push({ type: "text", text });
  for (const img of images) {
    parts.push({ type: "image_url", image_url: { url: `data:${img.mime};base64,${img.data_b64}` } });
  }
  return parts;
}

/// Anthropic Messages user content. Same idea as OpenAI but the part
/// shape is different: `{type:"image", source:{type:"base64", media_type, data}}`.
export function anthropicUserContent(text: string, images: Attachment[]): unknown {
  if (images.length === 0) return text;
  const parts: any[] = [];
  for (const img of images) {
    parts.push({ type: "image", source: { type: "base64", media_type: img.mime, data: img.data_b64 } });
  }
  if (text) parts.push({ type: "text", text });
  return parts;
}

// ---------- Auto model routing (P0-4) ----------
//
// "Auto · …" entries resolve to a concrete model at dispatch time using the
// SAME availability discovery as the picker (buildEntries + accounts +
// server supervisor). The pick is split pure/impure: `pickAutoModel`
// (pure, unit-probed) decides; `resolveAutoModel` gathers availability.
// GUARDRAIL: callers must surface the resolution — a cloud pick is never
// silent (streamChatCompletion emits it through onSystemWarning).

export type AutoCandidates = {
  /// The model loaded in the RUNNING local server, if any.
  localRunning: { modelId: string; label: string } | null;
  /// Available cloud entries (sub = subscription CLI, api = key).
  cloud: Array<{ id: string; label: string; variant: "sub" | "api" }>;
};

export type AutoResolution = {
  modelId: string;
  provider: string;
  label: string;
  cloud: boolean;
  reason: string;
};

/// Rough task-difficulty estimate from the prompt alone. Deliberately
/// coarse — it only has to separate "what's 2+2" from "redesign my auth".
export function estimatePromptTier(text: string): "simple" | "standard" | "hard" {
  const t = text.trim();
  const words = t.split(/\s+/).filter(Boolean).length;
  // NOTE: everyday nouns stay out — "design" alone matched "the design
  // team" in normal prose and escalated summaries to the hard tier.
  const hardSignals =
    /(architect|redesign|refactor|prove|optimi[sz]e|debug|root.?cause|security|concurren|distributed|algorithm|complexit|migrat|trade.?off|implement|build me|end.to.end)/i;
  const codey = /```|\bfn\b|\bdef\b|\bclass\b|=>|;\s*$/m.test(t);
  if (words > 150 || hardSignals.test(t)) return "hard";
  if (words > 25 || codey) return "standard";
  return "simple";
}

/// Lower = cheaper to run. Effort suffixes (":low"/":high") nudge the rank.
function cheapScore(id: string): number {
  const s = id.toLowerCase();
  let n = 50;
  if (/haiku|mini|flash|lite|small|nano/.test(s)) n = 0;
  else if (/sonnet|deepseek|kimi|grok|gpt-4/.test(s)) n = 20;
  else if (/fable|opus|gpt-5|o3|pro/.test(s)) n = 40;
  if (/:low/.test(s)) n -= 5;
  if (/:extra_high/.test(s)) n += 8;
  else if (/:high/.test(s)) n += 5;
  return n;
}

/// Higher = more capable. The small-model markers are tested FIRST —
/// "gpt-5-mini" must rank as a mini, not as a gpt-5.
function premiumScore(id: string): number {
  const s = id.toLowerCase();
  let n = 40;
  if (/haiku|mini|flash|lite|small|nano/.test(s)) n = 10;
  else if (/fable|opus/.test(s)) n = 100;
  else if (/gpt-5|o3|grok-4|pro/.test(s)) n = 80;
  else if (/sonnet/.test(s)) n = 60;
  if (/:extra_high/.test(s)) n += 6;
  else if (/:high/.test(s)) n += 4;
  else if (/:low/.test(s)) n -= 5;
  return n;
}

/// Stable preference: subscriptions before API keys (the sub is already
/// paid for — "cheapest" is from the USER's wallet's point of view).
function bySubFirst(a: { variant: string }, b: { variant: string }): number {
  return (a.variant === "sub" ? 0 : 1) - (b.variant === "sub" ? 0 : 1);
}

/// Pure auto-pick. Throws a user-actionable error when nothing fits.
export function pickAutoModel(
  flavour: string,
  tier: "simple" | "standard" | "hard",
  c: AutoCandidates,
): Omit<AutoResolution, "provider"> {
  const local = (reason: string) =>
    c.localRunning && {
      modelId: c.localRunning.modelId,
      label: c.localRunning.label,
      cloud: false,
      reason,
    };
  const cheapestCloud = () =>
    [...c.cloud].sort((a, b) => cheapScore(a.id) - cheapScore(b.id) || bySubFirst(a, b))[0];
  const bestCloud = () =>
    [...c.cloud].sort((a, b) => premiumScore(b.id) - premiumScore(a.id) || bySubFirst(a, b))[0];

  switch (flavour) {
    case "cheapest-local": {
      const l = local("cheapest-local: the running local model is free and private");
      if (l) return l;
      throw new Error(
        "Auto · Cheapest Local: no local model is running — start one on the Server page (this mode never uses cloud).",
      );
    }
    case "cheapest": {
      const l = local("cheapest: the running local model is free");
      if (l) return l;
      const m = cheapestCloud();
      if (m) return { modelId: m.id, label: m.label, cloud: true, reason: "cheapest available cloud model (no local model is running)" };
      throw new Error("Auto: no usable model — start a local model or connect an account/key.");
    }
    case "premium": {
      const m = bestCloud();
      if (m) return { modelId: m.id, label: m.label, cloud: true, reason: "premium: most capable available model" };
      const l = local("premium: no cloud account available — using the running local model");
      if (l) return l;
      throw new Error("Auto · Premium: no cloud account/key connected and no local model running.");
    }
    // "balanced" and any future/unknown flavour.
    default: {
      if (tier === "hard") {
        const m = bestCloud();
        if (m) return { modelId: m.id, label: m.label, cloud: true, reason: "balanced: hard task → most capable model" };
        const l = local("balanced: hard task but no cloud available — using the running local model");
        if (l) return l;
      } else if (tier === "simple") {
        const l = local("balanced: simple task → free local model");
        if (l) return l;
        const m = cheapestCloud();
        if (m) return { modelId: m.id, label: m.label, cloud: true, reason: "balanced: simple task → cheapest cloud (no local model running)" };
      } else {
        const l = local("balanced: standard task → local model handles it (free, native tools)");
        if (l) return l;
        const mids = c.cloud.filter((x) => premiumScore(x.id) >= 55);
        const m = (mids.length ? mids : c.cloud)
          .sort((a, b) => cheapScore(a.id) - cheapScore(b.id) || bySubFirst(a, b))[0];
        if (m) return { modelId: m.id, label: m.label, cloud: true, reason: "balanced: standard task → mid-tier cloud model" };
      }
      throw new Error("Auto: no usable model — start a local model or connect an account/key.");
    }
  }
}

/// Gather availability (the app's own discovery) and resolve an auto id.
export async function resolveAutoModel(flavour: string, userMessage: string): Promise<AutoResolution> {
  const [models, accounts, server] = await Promise.all([
    invoke<ModelInfo[]>("list_models").catch(() => [] as ModelInfo[]),
    invoke<any>("accounts_status").catch(() => null),
    invoke<ServerStatus>("server_status").catch(() => null as ServerStatus | null),
  ]);
  const entries = buildEntries(models, accounts);
  const cloud = entries
    .filter((e) => e.available && (e.variant === "sub" || e.variant === "api"))
    .map((e) => ({ id: e.id, label: e.label, variant: e.variant as "sub" | "api" }));
  const localRunning = server?.running && server.model_id
    ? { modelId: server.model_id, label: `${server.model_id} (local)` }
    : null;
  const tier = estimatePromptTier(userMessage);
  const picked = pickAutoModel(flavour, tier, { localRunning, cloud });
  return { ...picked, provider: providerFor(picked.modelId, models) };
}

export async function streamChatCompletion(
  port: number,
  modelId: string,
  provider: string,
  systemPrompt: string,
  userMessage: string,
  temperature: number,
  signal: AbortSignal,
  onDelta: StreamHandler,
  projectCwd?: string,
  history?: HistoryItem[],
  autoApprove?: boolean,
  onThought?: ThoughtHandler,
  /// Per-role tool gate (OWLLM names). Only meaningful when the
  /// dispatch resolves to the Claude CLI subscription path; ignored
  /// for API + local llama-server paths (those don't expose tools).
  allowedTools?: string[],
  /// Multimodal attachments. Audio is transcribed up-front and folded
  /// into userMessage so every provider sees the same text shape;
  /// images ride to the provider's native image part shape.
  attachments?: Attachment[],
  /// Claude CLI session UUID for multi-turn memory. Computed by the
  /// caller via getClaudeSession(projectId, agentName). Ignored on
  /// non-Anthropic-CLI paths (OpenAI, local, Anthropic API).
  sessionId?: string | null,
  /// User-visible warning channel. Fires when something the user asked
  /// for can't be delivered (CLI image drop, audio transcribe failure).
  /// The bridge / AgentsPage caller wires this to a chat-log emitter so
  /// the actual reason surfaces instead of the LLM paraphrasing it as
  /// "I am still unable to transcribe…".
  onSystemWarning?: (text: string) => void,
  /// Fires once per successful audio transcription so the caller can
  /// drop the transcribed text into the chat AS the user's input
  /// (rather than waiting for the orchestrator to echo it back).
  onTranscript?: (filename: string, text: string) => void,
): Promise<string> {
  const forceSub = modelId.startsWith("sub/");
  const forceApi = modelId.startsWith("api/");
  const bareId = forceSub || forceApi || modelId.startsWith("auto/")
    ? modelId.slice(modelId.indexOf("/") + 1)
    : modelId;

  // Transcribe any audio parts first (Whisper, one-shot). After this,
  // `effectiveText` carries the original prompt + transcript blocks
  // and we only need to worry about image parts per provider.
  const images = imageAttachments(attachments);
  const effectiveText = appendImageAttachmentNotes(
    await transcribeAudioAttachments(userMessage, attachments, onSystemWarning, onTranscript),
    images,
  );

  if (provider === "auto") {
    // P0-4: resolve "Auto · …" at dispatch time. The pick is ALWAYS
    // surfaced (onSystemWarning) — especially when it costs money — and
    // we recurse with a concrete model id + provider.
    const res = await resolveAutoModel(bareId, effectiveText);
    onSystemWarning?.(
      `⚡ Auto → ${res.label} (${res.cloud ? "cloud — uses your account/credits" : "local — free, private"}) · ${res.reason}`,
    );
    return streamChatCompletion(
      port, res.modelId, res.provider, systemPrompt, userMessage, temperature, signal,
      onDelta, projectCwd, history, autoApprove, onThought, allowedTools, attachments,
      sessionId, onSystemWarning, onTranscript,
    );
  }
  if (provider === "anthropic") {
    return streamAnthropic(bareId, { forceSub, forceApi }, systemPrompt, effectiveText, temperature, signal, onDelta, projectCwd, history, autoApprove, onThought, allowedTools, images, sessionId);
  }
  if (provider === "openai") {
    return streamOpenAI(bareId, { forceSub, forceApi }, systemPrompt, effectiveText, temperature, signal, onDelta, history, onThought, images, projectCwd);
  }
  // ---- Local llama-server path (GGUF) ----
  // Native tool-calling ONLY: the model's own chat template (llama-server
  // --jinja) renders the `tools` array and parses the model's structured
  // delta.tool_calls back for us. No XML catalog injected, no dialect
  // parsing. Cloud/sub/API branches above are untouched.
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

/// Optional UI hooks so a rich caller (ChatPage) can render per-tool
/// events inline. AgentsPage/bridge leave these unset and surface tool
/// activity through onThought instead.
export type LocalToolEvents = {
  onToolCall?: (call: ToolCall, turn: number) => void;
  onToolResult?: (call: ToolCall, result: ToolExecResult, turn: number) => void;
  onValidationError?: (name: string, error: string) => void;
};

export type StreamLocalChatParams = {
  port: number;
  modelId: string;
  systemPrompt: string;
  /// Pre-built OpenAI user content (string, or multimodal parts array).
  userContent: unknown;
  temperature: number;
  signal: AbortSignal;
  onDelta: StreamHandler;
  onThought?: ThoughtHandler;
  projectCwd?: string;
  history?: HistoryItem[];
  allowedTools?: string[];
  /// Per-call sampling overrides (ChatPage's per-column temperature /
  /// top_p / max_tokens UI controls). Merged over the model-family
  /// profile from modelProfiles.ts.
  samplingOverride?: Partial<Record<string, number>>;
  events?: LocalToolEvents;
};

/// THE single local-model chat loop. Shared by dispatch.ts (bridge +
/// team dispatch), AgentsPage (SuperUser chat), and ChatPage. One code
/// path: native tools, model-family sampling, 503 slot-warmup retry,
/// validate → execute → feed results back → iterate until the model
/// answers with no tool calls.
export async function streamLocalChat(p: StreamLocalChatParams): Promise<string> {
  const openaiTools = await formatToolsForOpenAI(p.allowedTools);
  // Instrumentation: the exact tools advertised to llama-server this turn.
  // If agentic tool-calling misbehaves, open devtools — this shows whether
  // the model was even handed tools, and which (an MCP schema that poisons
  // the grammar will show up here before the model narrates instead of
  // calling). Kept at debug level so it's silent unless you're looking.
  try {
    console.debug(
      `[streamLocalChat] ${openaiTools.length} tools →`,
      openaiTools.map((t: any) => t?.function?.name).filter(Boolean),
    );
  } catch { /* logging must never break the turn */ }
  const liveMessages: Array<{ role: string; content: unknown }> = [
    { role: "system", content: p.systemPrompt },
    ...(p.history ?? []),
    { role: "user", content: p.userContent },
  ];
  // One tool round = one model turn. Models like Qwen call tools ONE
  // per turn, so a 6-step task (mkdir→write→read→list→shell→websearch)
  // needs 6 rounds JUST for the tools, plus a final turn to write the
  // answer. The old cap of 8 ran out mid-task and the loop returned with
  // the model still in tool-calling mode — the user saw only the opening
  // preamble and never got the report. 16 covers realistic multi-step
  // sequences; the forced-synthesis pass below guarantees a closing
  // answer even when the budget IS exhausted.
  const MAX_TOOL_TURNS = 16;
  let lastReply = "";
  // True once the model answers WITHOUT a tool call (the clean exit that
  // means lastReply already holds the user-facing answer). Stays false
  // if we burn through every turn with tools still pending → triggers the
  // forced-synthesis pass below.
  let answeredWithoutTools = false;
  // Per-family sampling from the data-driven profile, with optional
  // caller overrides (ChatPage per-column controls).
  const sampling = { ...samplingFor(p.modelId), ...(p.samplingOverride ?? {}) };
  // Where to send inference: the local managed server (default) or a remote
  // llama-server on another host (the Windows-GPU / Linux-agents split).
  // resolveInferenceBase() reads the persisted endpoint; local mode uses the
  // managed port passed in `p.port`, remote uses the configured host:port:key.
  const infer = resolveInferenceBase(p.port);
  const inferUrl = `${infer.baseUrl}/v1/chat/completions`;
  const inferHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...(infer.apiKey ? { Authorization: `Bearer ${infer.apiKey}` } : {}),
  };
  // 503/502 slot-warmup retry — cold model load is handled by server.rs's
  // /health poller; this only absorbs the few-second slot init after the
  // model is resident.
  const LOAD_RETRY_MS = 120_000;
  const LOAD_RETRY_DELAY = 1500;
  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    if (p.signal.aborted) throw new DOMException("aborted", "AbortError");
    let resp: Response | undefined;
    const loadDeadline = Date.now() + LOAD_RETRY_MS;
    while (true) {
      if (p.signal.aborted) throw new DOMException("aborted", "AbortError");
      try {
        resp = await fetch(inferUrl, {
          method: "POST",
          headers: inferHeaders,
          body: JSON.stringify({
            model: p.modelId || "local",
            messages: liveMessages,
            stream: true,
            temperature: p.temperature,
            ...sampling,
            tools: openaiTools.length > 0 ? openaiTools : undefined,
            // tool_choice:"auto" is what the (working) fine-tuning ChatPage
            // sends. Without it, some GGUF templates under --jinja never
            // arm the tool-call grammar, so the model just NARRATES ("I'll
            // create the file…") and ends its turn with no native call —
            // exactly the agentic-chat failure. Send the identical request
            // the proven path sends so the same model behaves the same.
            tool_choice: openaiTools.length > 0 ? "auto" : undefined,
          }),
          signal: p.signal,
        });
      } catch (e: any) {
        if (p.signal.aborted) throw e;
        if (Date.now() >= loadDeadline) {
          // Can't reach the server at all. Ask the supervisor WHY before
          // surfacing a generic network error — a crashed llama-server
          // (OOM / broken GGUF) has a named cause in server_status (P1-4).
          // Only for the LOCAL server; a remote endpoint has no supervisor.
          const generic = `network error after ${LOAD_RETRY_MS / 1000}s: ${String(e?.message ?? e)}`;
          throw new Error(infer.remote ? generic : await localServerFailureMessage(generic));
        }
        try {
          window.dispatchEvent(new CustomEvent("owllm:llama:loading", {
            detail: { elapsedSec: Math.round((Date.now() - (loadDeadline - LOAD_RETRY_MS)) / 1000), port: p.port, reason: `network: ${String(e?.message ?? e).slice(0, 80)}` },
          }));
        } catch {}
        await new Promise(r => setTimeout(r, LOAD_RETRY_DELAY));
        continue;
      }
      if (resp.ok) break;
      const errBody = await resp.text().catch(() => "");
      if (resp.status === 503 || resp.status === 502) {
        if (Date.now() < loadDeadline) {
          const elapsedSec = Math.round((Date.now() - (loadDeadline - LOAD_RETRY_MS)) / 1000);
          try {
            window.dispatchEvent(new CustomEvent("owllm:llama:loading", {
              detail: { elapsedSec, port: p.port, reason: `${resp.status}: ${(errBody.slice(0, 80)) || "loading"}` },
            }));
          } catch {}
          await new Promise(r => setTimeout(r, LOAD_RETRY_DELAY));
          continue;
        }
        // Still 503 after the whole retry budget → the model is genuinely
        // still WARMING UP (cold load), not crashed — say so by name (P1-4).
        throw new Error(
          `The local model is still warming up after ${LOAD_RETRY_MS / 1000}s (llama-server says it's loading). ` +
          `Very large models can take longer — watch the Server page and retry once it shows ready.`);
      }
      throw new Error(`llama-server ${resp.status}: ${errBody.slice(0, 500) || "(no body)"}`);
    }
    if (!resp) throw new Error("llama-server never responded — server may have crashed");
    // consumeOpenAISse streams visible deltas to onDelta, routes
    // reasoning/thinking to onThought, and harvests native
    // delta.tool_calls into nativeCalls.
    const nativeCalls: RawNativeCall[] = [];
    lastReply = await consumeOpenAISse(resp, p.onDelta, p.onThought, nativeCalls);
    // No tools available at all → single-shot, done.
    if (openaiTools.length === 0) { answeredWithoutTools = true; break; }
    // Canonicalise native calls to registry tool + arg names.
    const calls = canonicalizeNativeCalls(nativeCalls, { firstRequiredArg });
    if (calls.length === 0) { answeredWithoutTools = true; break; } // model answered with no tool call — final
    // Strict validation BEFORE execution. Bad calls are not run; a
    // structured schema error goes back so the model self-corrects.
    const valid: ToolCall[] = [];
    const invalid: Array<{ name: string; error: string }> = [];
    for (const c of calls) {
      const v = validateCall(c);
      if (v.ok) valid.push(c);
      else { invalid.push({ name: c.name, error: v.error }); p.events?.onValidationError?.(c.name, v.error); }
    }
    const results: ToolExecResult[] = [];
    for (const c of valid) {
      if (p.signal.aborted) throw new DOMException("aborted", "AbortError");
      p.events?.onToolCall?.(c, turn);
      // eslint-disable-next-line no-await-in-loop
      const r = await executeToolCall(c, p.projectCwd ?? "");
      results.push(r);
      p.events?.onToolResult?.(c, r, turn);
    }
    const parts: string[] = [];
    if (valid.length > 0) parts.push(renderToolResultsForModel(valid, results));
    if (invalid.length > 0) parts.push(renderValidationErrorsForModel(invalid));
    liveMessages.push({ role: "assistant", content: lastReply });
    liveMessages.push({ role: "user", content: parts.join("\n\n") });
  }
  // Forced synthesis: the loop exhausted MAX_TOOL_TURNS while the model
  // was still calling tools, so it never wrote a user-facing answer (the
  // bubble would freeze on the opening preamble). Do ONE more turn with
  // tools OMITTED — the model can't call anything, so it MUST write the
  // final report from everything it already gathered above. Streams
  // through onDelta so the answer appends to the visible bubble.
  if (!answeredWithoutTools && openaiTools.length > 0) {
    if (p.signal.aborted) throw new DOMException("aborted", "AbortError");
    liveMessages.push({
      role: "user",
      content:
        "You have reached your tool-call limit — do NOT request any more tools. " +
        "Using only the tool results already gathered above, write the final answer " +
        "for the user now: report what each tool returned and the overall outcome.",
    });
    try {
      const fresp = await fetch(inferUrl, {
        method: "POST",
        headers: inferHeaders,
        body: JSON.stringify({
          model: p.modelId || "local",
          messages: liveMessages,
          stream: true,
          temperature: p.temperature,
          ...sampling,
          // tools deliberately omitted — force a plain text answer.
        }),
        signal: p.signal,
      });
      if (fresp.ok) {
        const finalText = await consumeOpenAISse(fresp, p.onDelta, p.onThought, []);
        if (finalText.trim()) lastReply = finalText;
      }
    } catch (e) {
      // Best-effort — if the synthesis turn fails, keep whatever the
      // last tool turn produced rather than erroring the whole reply.
      if (p.signal.aborted) throw e;
    }
  }
  return lastReply;
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
  allowedTools?: string[],
  /// Image attachments only — audio has already been transcribed in
  /// streamChatCompletion. When the call resolves to the Claude CLI
  /// subscription path images are NOT forwarded (the CLI binding is
  /// text-only); we prefix the user message with a note so the user
  /// understands why an attached image didn't reach the model.
  images?: Attachment[],
  /// Claude CLI session UUID for multi-turn memory (Phase B). Only
  /// used by CLI subscription branches; API path ignores it.
  sessionId?: string | null,
): Promise<string> {
  const wantSub = route.forceSub === true;
  const wantApi = route.forceApi === true;
  const imgList = images ?? [];
  // Picker encodes effort tier as ":high"/":xhigh"/etc on the model id.
  // Split it out so both paths (CLI sub --effort, API thinking budget)
  // receive the clean wire-name + a normalised effort label.
  const { wireModel: cliModel, effort: cliEffort } = parseClaudeModelId(modelId);
  const claudeEffort = mapClaudeEffort(cliEffort);
  // The Claude CLI binding is text-only on stdin — but Claude Code READS image
  // files with its own tool. So save the pasted images into the working
  // directory and reference their paths; the agent opens them itself (works on
  // a subscription, no API key). Users on the API path get full inline vision.
  const cliUserMessage = await appendCliImageFiles(userMessage, imgList, projectCwd);
  const cliPrompt = foldHistoryIntoPrompt(cliUserMessage, history);
  // Wrap CLI invocations so a "Session ID already in use" failure
  // (a stale lock from a prior crashed claude process, or the same
  // session being in flight in the desktop UI) gets one automatic
  // retry with a fresh one-shot session. Without this the Telegram
  // bridge bubbled the conflict up to the user as
  // "(dispatch error: Session ID … is already in use)" the moment
  // OwLLM Desktop also had an active Claude CLI session for the same
  // (project, agent). AgentsPage.tsx has the same wrapper for its
  // in-page dispatches; bridges share the same recovery path now.
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
      try { clearAllClaudeSessions(); } catch { /* best-effort */ }
      return await attempt(null);
    }
  };
  if (wantSub) {
    const status = await invoke<{ claude_cli: boolean }>("accounts_status");
    if (!status?.claude_cli) {
      throw new Error("Claude Code CLI not detected — run `claude /login` first.");
    }
    // Refresh the CLI token once per session so the first chat doesn't hit
    // the cold-start 401 (what "Test" on the Accounts page worked around).
    await ensureCliWarm("claude_cli");
    // Stream when the consumer wants thought traffic (AgentsPage); fall
    // back to one-shot --print blob otherwise (the bridge runner that
    // doesn't display a Thought tab).
    if (onThought) {
      return await runWithSessionRetry((sid) => runClaudeCliStream({
        systemPrompt, userMessage: cliPrompt, cwd: projectCwd ?? null,
        autoApprove: autoApprove ?? false, allowedTools,
        model: cliModel, effort: claudeEffort, sessionId: sid,
        onDelta, onThought,
      }));
    }
    const reply = await runWithSessionRetry((sid) => invoke<string>("claude_cli_complete", {
      systemPrompt, userMessage: cliPrompt, cwd: projectCwd ?? null,
      autoApprove: autoApprove ?? false,
      model: cliModel, effort: claudeEffort, sessionId: sid,
    }));
    if (reply) onDelta(reply);
    return reply;
  }
  const key = await invoke<string | null>("accounts_get_secret", { name: "ANTHROPIC_API_KEY" });
  if (!key) {
    if (wantApi) throw new Error("No ANTHROPIC_API_KEY saved — set it on the Accounts page.");
    try {
      const status = await invoke<{ claude_cli: boolean }>("accounts_status");
      if (status?.claude_cli) {
        await ensureCliWarm("claude_cli");
        if (onThought) {
          return await runWithSessionRetry((sid) => runClaudeCliStream({
            systemPrompt, userMessage: cliPrompt, cwd: projectCwd ?? null,
            autoApprove: autoApprove ?? false, allowedTools,
            model: cliModel, effort: claudeEffort, sessionId: sid,
            onDelta, onThought,
          }));
        }
        const reply = await runWithSessionRetry((sid) => invoke<string>("claude_cli_complete", {
          systemPrompt, userMessage: cliPrompt, cwd: projectCwd ?? null,
          autoApprove: autoApprove ?? false,
          model: cliModel, effort: claudeEffort, sessionId: sid,
        }));
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

/// Build the Anthropic Messages request body. Splits "<id>:<level>"
/// out of modelId (set by ModelPicker for Opus 4.7 / Sonnet 4.6) and
/// translates the effort tier into extended-thinking parameters:
///   * low (or none)  → no thinking; max_tokens=4096; user's temperature
///   * medium         → thinking.budget_tokens=4000;  max_tokens=8192;  temp=1
///   * high           → thinking.budget_tokens=8000;  max_tokens=16384; temp=1
///   * extra_high     → thinking.budget_tokens=16000; max_tokens=24576; temp=1
///
/// Anthropic requires temperature=1 with extended thinking and
/// max_tokens > budget_tokens. The headroom (max_tokens - budget) is
/// the reply's own token budget on top of the reasoning budget.
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

// Anthropic Messages SSE consumer. Splits the stream into three
// channels:
//   - text deltas → onDelta (the user-facing reply)
//   - thinking deltas → onThought("thinking", …) (extended-thinking blocks)
//   - tool_use blocks → onThought("tool:<name>:<id>", "🛠 <name>", …)
//     (the model calling a tool — name + JSON input streamed as the
//     model produces it)
async function consumeAnthropicSse(
  resp: Response,
  onDelta: StreamHandler,
  onThought?: ThoughtHandler,
): Promise<string> {
  const reader = resp.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let acc = "";
  // Indexed by content block index; tracks what kind each block is so
  // the matching content_block_delta can be routed correctly.
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
            // Emit the tool name + opening brace so the user immediately
            // sees which tool is being invoked, even if the JSON input
            // hasn't started streaming yet.
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
            // Default text stream — the user-facing reply.
            acc += delta.text;
            onDelta(delta.text);
          }
        }
      } catch { /* skip malformed chunk */ }
    }
  }
  return acc;
}

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
  /// Image attachments only — audio is transcribed in streamChatCompletion.
  images?: Attachment[],
  /// Project working dir. Threaded to the Codex CLI so it runs IN the
  /// project (can read the codebase) instead of an arbitrary cwd.
  projectCwd?: string,
): Promise<string> {
  // OpenAI SUBSCRIPTION (ChatGPT / Codex) → run the Codex CLI, exactly as
  // the Claude subscription routes through claude_cli_complete. Without
  // this the chat demanded OPENAI_API_KEY even when a Codex subscription
  // was connected (this WAS the "chat page asks me for the API key" bug).
  // `api/` models and the default still use the HTTP API-key path below.
  if (route.forceSub === true) {
    // Refresh the Codex CLI token once per session (same cold-start 401
    // fix as Claude — see ensureCliWarm).
    await ensureCliWarm("codex_cli");
    // Fold prior turns into the prompt so the CLI has conversation context.
    const convo = (history ?? [])
      .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
      .join("\n\n");
    const prompt = convo ? `${convo}\n\nUser: ${userMessage}` : userMessage;
    // Pasted images → saved to the cwd inbox + attached via codex's native -i
    // flag (verified). Codex sees them as vision input; no API key needed.
    const codexImagePaths = await saveCliImages(images ?? [], projectCwd ?? undefined);
    // Stream live activity (reasoning, commands, tools, web searches) when
    // the caller wants thought traffic — AgentsPage / ChatPage / CodePage.
    // Bridge callers (no Thought pane) fall back to the one-shot blob.
    if (onThought) {
      return await runCodexCliStream({
        systemPrompt,
        userMessage: prompt,
        cwd: projectCwd ?? null,
        imagePaths: codexImagePaths,
        onDelta,
        onThought,
      });
    }
    const reply = await invoke<string>("codex_cli_complete", {
      systemPrompt,
      userMessage: prompt,
      cwd: projectCwd ?? undefined,
      imagePaths: codexImagePaths,
    });
    if (reply) onDelta(reply);
    return reply;
  }
  // ModelPicker encodes reasoning-effort variants as "<id>:<level>"
  // (e.g. "gpt-5.5:high"). Split it back out here so the wire model id
  // stays clean and the level rides as reasoning_effort. "extra_high"
  // is forwarded verbatim — it matches the VS Code Copilot Chat label
  // the user is mirroring; if the API rejects it we want the rejection
  // to surface, not be silently rewritten.
  const sep = modelId.indexOf(":");
  const wireModel = sep === -1 ? modelId : modelId.slice(0, sep);
  const effort = sep === -1 ? null : modelId.slice(sep + 1);
  const key = await invoke<string | null>("accounts_get_secret", { name: "OPENAI_API_KEY" });
  if (!key) throw new Error("No OPENAI_API_KEY saved — set it on the Accounts page.");
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: wireModel,
      ...(effort ? { reasoning_effort: effort } : {}),
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

// OpenAI-compatible SSE consumer (api.openai.com + llama-server).
// Routes:
//   - delta.content (with <think>/<thinking> stripped) → onDelta
//   - text inside <think>/<thinking> tags → onThought("thinking", …)
//   - delta.reasoning_content (DeepSeek-R1 / o-series) → onThought("thinking", …)
//   - delta.tool_calls[] → onThought("tool:<name>:<i>", "🛠 <name>", …)
async function consumeOpenAISse(
  resp: Response,
  onDelta: StreamHandler,
  onThought?: ThoughtHandler,
  /// When provided, completed native tool_calls are pushed here as the
  /// stream finalises. Modern local models (Llama 3.1+, Qwen 2.5+, Gemma
  /// 3, Hermes) emit these instead of inline content; the caller routes
  /// them through canonicalizeNativeCalls → executeToolCall.
  toolCallsOut?: RawNativeCall[],
): Promise<string> {
  if (!resp.ok || !resp.body) {
    throw new Error(await resp.text().catch(() => `HTTP ${resp.status}`));
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let acc = "";
  // Bounded tail of ALL generated text (visible + thinking) for the
  // runaway-degeneration detector. Kept short (sliced per chunk) so a
  // long stream doesn't grow this unbounded.
  let genTail = "";
  // Track <think> tag state across deltas — content can split across chunks.
  let inThink = false;
  // Per-tool-call-index → resolved tool name; the model streams the
  // function name in the first chunk(s) and arguments in later ones.
  const toolNames = new Map<number, string>();
  // Mirror map for the argument JSON. The model emits the arguments
  // string in several fragments — we concatenate so the caller can
  // JSON.parse the complete object when the stream ends.
  const toolArgs = new Map<number, string>();
  // Idle-token timeout. If llama-server stops shipping chunks for
  // STREAM_IDLE_MS, abort the read instead of blocking forever. The
  // user hit a 5+ min hang where the model degenerated mid-tool-loop
  // and llama-server kept churning without sending anything visible.
  // Race the reader against a setTimeout that throws.
  const STREAM_IDLE_MS = 90_000;
  const readWithTimeout = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    let to: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((_, rej) => {
          to = setTimeout(
            () => rej(new Error(`stream idle for ${STREAM_IDLE_MS / 1000}s — aborting`)),
            STREAM_IDLE_MS,
          );
        }),
      ]);
    } finally {
      if (to) clearTimeout(to);
    }
  };
  // Captured by the inner try/catch when llama-server emits an error
  // event in the SSE stream — the outer loop checks this AFTER the
  // catch swallows the throw so we can break + rethrow at the right
  // level instead of being silently skipped as "malformed chunk".
  let serverError: string | null = null;
  // Client-side loop detector. Server-side DRY + repeat_penalty
  // catches most cases; this is the backstop. Tracks the last few
  // non-empty lines of the visible reply; if the last 3 are byte-
  // identical and non-trivial (>=10 chars), we're in a loop like
  // "I will write the answer\nI will write the answer\n…". Abort
  // the stream so the user doesn't have to hit Stop.
  let loopAborted = false;
  const checkLineLoop = (full: string): boolean => {
    // Cheap: only the trailing chunk matters. 600 chars covers 3
    // copies of a ~200-char line; longer than that the DRY sampler
    // will have engaged anyway.
    const tail = full.length > 600 ? full.slice(-600) : full;
    const lines = tail.split("\n").map(l => l.trim()).filter(l => l.length >= 10);
    if (lines.length < 3) return false;
    const [a, b, c] = lines.slice(-3);
    return a === b && b === c;
  };
  // Detect dense intra-line repetition too (model loops without
  // newlines): if the last 90 chars contain 3 identical 25-char
  // substrings, that's a loop.
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
  // Runaway non-repeating degeneration: the model spews an endless
  // run-on of NOVEL tokens (e.g. a wall of unique proper nouns) with
  // no sentence breaks. DRY and the repeat detectors above miss it
  // because nothing repeats. Signal: the current line (text since the
  // last newline) has grown past 2500 chars with no sentence-ending
  // punctuation in its tail — real prose breaks into sentences /
  // paragraphs long before that.
  const checkRunawayLine = (full: string): boolean => {
    const nl = full.lastIndexOf("\n");
    const line = nl >= 0 ? full.slice(nl + 1) : full;
    if (line.length < 2500) return false;
    return !/[.!?](\s|$)/.test(line.slice(-400));
  };
  while (true) {
    let res: ReadableStreamReadResult<Uint8Array>;
    try {
      res = await readWithTimeout();
    } catch (e) {
      // Cancel the underlying body so llama-server stops generating.
      try { await reader.cancel(); } catch { /* ignore */ }
      // Return what we have so far instead of throwing — the caller's
      // tool loop will see "no tool_calls, no progress" and break out
      // gracefully, surfacing whatever the model managed to emit.
      console.warn("[dispatch] SSE timeout:", e);
      break;
    }
    const { done, value } = res;
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
        // llama-server can emit an error mid-stream as
        // `data: {"error": {"message": "...", "type": "..."}}` (or
        // similar). The previous code only read `choices[0].delta`
        // and silently skipped this — that's the "flashes a start
        // but produces nothing" the user kept hitting. Surface the
        // error to the caller via onDelta so it lands in the chat.
        if (j?.error) {
          const errMsg = typeof j.error === "string"
            ? j.error
            : (j.error?.message || JSON.stringify(j.error));
          console.warn("[dispatch.sse] server error event", errMsg);
          serverError = errMsg;
          continue;
        }
        const delta = j?.choices?.[0]?.delta;
        if (!delta) continue;
        // Feed ALL generated text (visible + thinking) into a bounded
        // tail so the runaway detector catches degeneration that
        // happens inside the <think> channel — which is where the
        // novel-token name-wall spiral occurred.
        const noteGen = (s: string): boolean => {
          genTail = (genTail + s).slice(-3600);
          return checkRunawayLine(genTail);
        };
        const abortRunaway = async () => {
          console.warn("[dispatch.sse] runaway degeneration — aborting");
          onDelta("\n\n⚠ Runaway generation detected — stream aborted.");
          loopAborted = true;
          try { await reader.cancel("runaway"); } catch { /* ignore */ }
        };
        // DeepSeek-R1 / o-series reasoning channel — separate field.
        const reasoning: string | undefined = delta?.reasoning_content ?? delta?.reasoning;
        if (typeof reasoning === "string" && reasoning) {
          onThought?.("thinking", "🧠 thinking", reasoning);
          if (noteGen(reasoning)) { await abortRunaway(); break; }
        }
        // Tool-calls channel — function name + arguments stream in chunks.
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
              toolArgs.set(idx, (toolArgs.get(idx) ?? "") + fn.arguments);
            }
          }
        }
        // Main content stream — also strip <think>/<thinking> tags and
        // route their interior to the thinking channel. Local thinking
        // models (DeepSeek-R1 distills, QwQ, etc.) emit reasoning that
        // way when they don't have a separate reasoning_content field.
        const content: string | undefined = delta?.content;
        if (typeof content === "string" && content) {
          const { reply, thought, inThink: nextInThink } = splitThinkTags(content, inThink);
          inThink = nextInThink;
          if (thought) {
            onThought?.("thinking", "🧠 thinking", thought);
            if (noteGen(thought)) { await abortRunaway(); break; }
          }
          if (reply)   { acc += reply; onDelta(reply); }
          // Repetition + runaway checks on the visible reply.
          if (reply && (reply.includes("\n") || acc.length > 90)) {
            if (checkLineLoop(acc) || checkInlineLoop(acc)) {
              console.warn("[dispatch.sse] repetition loop detected — aborting");
              onDelta("\n\n⚠ Repetition loop detected — stream aborted.");
              loopAborted = true;
              try { await reader.cancel("loop"); } catch { /* ignore */ }
              break;
            }
          }
          if (reply && noteGen(reply)) { await abortRunaway(); break; }
        }
      } catch { /* skip malformed chunk */ }
    }
    if (loopAborted) break;
  }
  if (serverError) {
    throw new Error(`llama-server returned an error: ${serverError}`);
  }
  // Finalise native tool_calls — convert each (name, accumulated args JSON)
  // into the same ToolCall shape parseToolCalls returns so the caller
  // can run both protocols through executeToolCall without branching.
  if (toolCallsOut) {
    for (const [idx, rawName] of toolNames.entries()) {
      const argsJson = toolArgs.get(idx) ?? "{}";
      const args: Record<string, string> = {};
      try {
        const parsed = JSON.parse(argsJson);
        if (parsed && typeof parsed === "object") {
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            args[k] = typeof v === "string" ? v : JSON.stringify(v);
          }
        }
      } catch {
        // Malformed JSON — surface the raw fragment under a single arg so
        // the caller sees what the model emitted instead of silently
        // dropping the call.
        args.raw = argsJson;
      }
      toolCallsOut.push({ name: unmangleMcpName(rawName), args });
    }
  }
  return acc;
}

// Streaming-safe <think> / <thinking> tag splitter. Takes a chunk and
// the prior in-think state, returns the user-facing reply text, the
// thinking text, and the new in-think state for the next chunk. Tags
// can split across chunk boundaries; we handle the common case where
// the FULL tag arrives in one chunk (true >99 % of the time for these
// models). Partial-tag splits fall through as literal text — fine
// because the user just sees one stray "<thi" in the reply.
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

// ---------- The dispatch loop itself ----------
//
// Runs the same orchestrator → specialists → integrate flow that
// AgentsPage's Run button drives, but with pluggable side-effect
// callbacks. Both desktop and Telegram dispatches funnel through
// here so the canvas, Thought tab, and per-agent log all see the
// same vocabulary regardless of which path triggered the run.
//
// Specialists run in PARALLEL during phase 2 — the orchestrator
// dispatches @agentA, @agentB, @agentC in one plan and all three
// fire concurrently. The hooks are designed for that: onAgentStart
// can be called from N tasks simultaneously, and onAgentEnd is
// called from each task as it finishes. Consumers track the set of
// currently-active agents (canvas pulse uses set-membership).
export type DispatchHooks = {
  onPhase: (phase: DispatchPhase) => void;
  /// Agent has just started a turn (orchestrator plan / specialist
  /// reply / orchestrator integration). May fire for multiple
  /// agents concurrently while specialists run in parallel.
  onAgentStart: (agent: string) => void;
  /// Agent has finished its turn. Pair-matched with onAgentStart so
  /// the consumer can maintain a Set<active>.
  onAgentEnd: (agent: string) => void;
  onLog: (agent: string, msg: GoalMsg) => void;
  onLogDelta: (agent: string, delta: string) => void;
  onThought: (agent: string, msg: GoalMsg) => void;
  /// Streaming thought / tool-call channel. `channel` is a stable id
  /// per open block (e.g. "thinking", "tool:Write:abc"). The consumer
  /// keeps a per-(agent,channel) cursor and appends deltas in place,
  /// or starts a new entry on first delta. `role` is the human label
  /// shown when a new entry is created.
  onThoughtDelta: (agent: string, channel: string, role: string, delta: string) => void;
  /// Fires once per agent reply that the bridge / UI should mirror
  /// outbound (e.g. Telegram /sendMessage). For the desktop runner
  /// this is a no-op.
  onAgentReply: (agent: string, text: string) => void;
  /// User-visible warning channel. Fires when a feature the user
  /// invoked can't be delivered (e.g. audio transcribe failure on
  /// the bridge path). The bridge wires this to:
  ///   1. Send a separate Telegram message so the user sees the
  ///      specific error on their phone instead of the orchestrator's
  ///      paraphrase.
  ///   2. Mirror to the desktop chat via owllm:chat:appended so the
  ///      React UI shows a yellow system note too.
  /// Optional — older callers can omit it; transcribe failures then
  /// silently fall back to the model-side paraphrase.
  onSystemWarning?: (text: string) => void;
  /// Fires once per successful voice-message transcription so the
  /// bridge / desktop can write the transcribed text into the chat
  /// AS the user's own input — surfacing what was said the moment it
  /// lands, instead of waiting for the orchestrator's reply to echo
  /// it. Called per attachment with (filename, text).
  onTranscript?: (filename: string, text: string) => void;
};

export type DispatchInput = {
  team: Team;
  roleByName: Map<string, RoleData>;
  goal: string;
  modelFor: (agentName: string) => string;
  models: ModelInfo[];
  port: number;
  projectCwd: string;
  /// Project UUID. Used as the namespace for per-agent Claude CLI
  /// session ids — multi-turn memory is scoped per (projectId, agent).
  /// Empty/missing → session memory disabled (one-shot dispatches).
  projectId?: string;
  history: HistoryItem[];
  autoApprove: boolean;
  signal: AbortSignal;
  /// Project rules — prepended to every agent's system prompt and used
  /// heavily by the Critic. Empty / undefined = no rules block injected.
  directives?: Directive[];
  /// When true, [NEED_USER_INPUT] markers in orchestrator output get
  /// intercepted and routed to the Critic instead of bubbling up to
  /// the user. The Critic's reply gets folded back into the dispatch
  /// as if the user had answered.
  directorMode?: boolean;
  /// Inbound images / audio attached to the user goal. The bridge
  /// runner downloads them via telegram_download_file and threads
  /// them through here; specialists receive only the orchestrator's
  /// text reply so the bytes ride to the orchestrator turn only.
  attachments?: Attachment[];
};

const NEED_USER_INPUT_RE = /^\s*\[NEED_USER_INPUT\][\s:]+(.+?)\s*$/im;
/// Also recognise the natural dispatch syntax the orchestrator gravitates
/// to: `@critical_thinker: <question>`. The synthetic critic isn't in
/// team.agents (parseDispatches would silently drop it), so without this
/// alias every `@critical_thinker:` line the orchestrator emits is a
/// dead letter — which is exactly the bug "I turned on Director Mode
/// and nothing happened" surfaces. Accept either prefix.
const CRITIC_DISPATCH_RE = /^[\s\-\d.*•]*@critical[_\s-]?thinker\s*[:：]\s*(.+?)\s*$/im;

/// Parse [NEED_USER_INPUT] / @critical_thinker: markers out of an
/// orchestrator reply. We only honour the FIRST marker per turn — a
/// single dispatch shouldn't spawn multiple critic calls (paralysis-
/// by-committee). Returns the question text + the cleaned reply
/// (marker line removed) so the orchestrator's own log doesn't show
/// the marker verbatim.
export function extractUserInputRequest(text: string): { question: string | null; cleaned: string } {
  const m1 = text.match(NEED_USER_INPUT_RE);
  if (m1) {
    return {
      question: m1[1].trim(),
      cleaned: text.replace(NEED_USER_INPUT_RE, "").trim(),
    };
  }
  const m2 = text.match(CRITIC_DISPATCH_RE);
  if (m2) {
    return {
      question: m2[1].trim(),
      cleaned: text.replace(CRITIC_DISPATCH_RE, "").trim(),
    };
  }
  return { question: null, cleaned: text };
}

/// Run a single Critic turn. Used by the dispatch loop when director
/// mode is on and the orchestrator emits [NEED_USER_INPUT]. Returns the
/// critic's answer (1-3 sentences in the user's voice). Failures
/// surface as a short fallback string instead of throwing — the
/// dispatch should keep moving rather than crash if the critic call
/// fails for transient reasons.
export async function runCriticDispatch(opts: {
  team: Team;
  question: string;
  history: HistoryItem[];
  directives?: Directive[];
  modelFor: (agentName: string) => string;
  models: ModelInfo[];
  port: number;
  projectCwd: string;
  autoApprove: boolean;
  signal: AbortSignal;
  onDelta?: (delta: string) => void;
}): Promise<string> {
  const sys = buildCriticPrompt(opts.team, opts.directives);
  // Use the same model the orchestrator uses so the critic's voice
  // stays consistent in tone. (Could be made user-configurable later.)
  const orch = findOrchestratorSpec(opts.team);
  const modelId = orch ? opts.modelFor(orch.name) : opts.modelFor("critical_thinker");
  const provider = providerFor(modelId, opts.models);
  try {
    const reply = await streamChatCompletion(
      opts.port, modelId, provider,
      sys, opts.question, 0.3, opts.signal,
      opts.onDelta ?? (() => {}),
      opts.projectCwd, opts.history, opts.autoApprove,
      () => {},
      undefined,
    );
    return reply.trim() || "(no answer)";
  } catch (e: any) {
    return `(critic error: ${String(e?.message ?? e)} — proceeding with best guess)`;
  }
}

export async function runDispatchLoop(opts: DispatchInput, hooks: DispatchHooks): Promise<string> {
  const { team, roleByName, goal, modelFor, models, port, projectCwd, projectId, history, autoApprove, signal, directives, directorMode, attachments } = opts;
  const tempFor = (spec: AgentSpec, fallback: number) =>
    roleByName.get(spec.base)?.defaultTemperature ?? fallback;
  // Local mutable history — when the Critic answers a [NEED_USER_INPUT]
  // we append (orchestrator_question, critic_answer) so the integration
  // turn sees the resolved decision in context.
  const liveHistory: HistoryItem[] = [...history];

  // ---- Phase 1: orchestrator plans ----
  hooks.onPhase("planning");
  const orch = findOrchestratorSpec(team);
  if (!orch) throw new Error("Team has no orchestrator (and no agents at all).");
  hooks.onAgentStart(orch.name);
  hooks.onLog(orch.name, { role: orch.name, color: "#ffd97a", text: "" });

  // Load BRIEF.md if the brainstormer wrote one. Best-effort: silent
  // miss means the orchestrator runs without binding scope (legacy).
  let briefText = "";
  if (projectCwd) {
    try {
      briefText = await invoke<string>("tool_read_file", {
        path: "BRIEF.md", cwd: projectCwd,
      });
    } catch { /* no brief yet — proceed without */ }
  }

  const orchPrompt = buildOrchestratorPrompt(team, roleByName, orch, directives, directorMode, briefText);
  const orchModel = modelFor(orch.name);
  const orchProvider = providerFor(orchModel, models);
  let orchReply: string;
  try {
    orchReply = await streamChatCompletion(
      port, orchModel, orchProvider,
      orchPrompt, goal, tempFor(orch, 0.4), signal,
      (delta) => hooks.onLogDelta(orch.name, delta),
      projectCwd, liveHistory, autoApprove,
      (channel, role, delta) => hooks.onThoughtDelta(orch.name, channel, role, delta),
      // Bridge dispatch uses tool gating now too — same per-role
      // allowlist as the desktop path. (Worktree isolation on this
      // path is a follow-up slice; bridge dispatches today are mostly
      // single-agent so the contention risk is lower.)
      roleByName.get(orch.base)?.toolAllowlist,
      // Inbound images/audio attached via Telegram. Audio gets
      // transcribed up-front (Whisper), images embed natively; both
      // ride only to the orchestrator turn.
      attachments && attachments.length > 0 ? attachments : undefined,
      // Persistent CLI session for the orchestrator — memory accumulates
      // across dispatches within the same project.
      getClaudeSession(projectId, orch.name),
      // Surface transcribe / CLI-image failures the user can act on
      // (open Accounts → Install voice runtime, or set OPENAI_API_KEY)
      // instead of letting the orchestrator paraphrase them as "I'm
      // still unable to transcribe…".
      hooks.onSystemWarning,
      hooks.onTranscript,
    );
  } finally {
    hooks.onAgentEnd(orch.name);
  }

  // Director-mode interception: if the orchestrator emitted a
  // [NEED_USER_INPUT] marker, route the question to the Critic, fold
  // the answer back into history as a user turn, and re-run the
  // orchestrator so it can replan with the decision resolved. Only one
  // hop — if the orchestrator emits another marker on the second pass
  // we let it through (extracted but not satisfied) to avoid loops.
  // Director mode WAS gating this critic round-trip; pulled the gate
  // so an explicit `@critical_thinker: <question>` dispatch always
  // works, whether or not director-mode is on. The orchestrator's
  // roster now lists the critic explicitly, so it'll do this on its
  // own initiative when it needs a peer review.
  {
    const { question, cleaned } = extractUserInputRequest(orchReply);
    if (question) {
      // Visible on the canvas + Thought tab so the user sees the
      // hand-off when reviewing the run after the fact.
      hooks.onThought(orch.name, {
        role: "dispatch",
        color: "#ff9ad9",
        text: `❓ → critic: ${question}`,
      });
      // Must match CRITIC_AGENT_NAME in AgentsPage.tsx — these hooks
      // key into the same per-agent UI state (active set, log buffer).
      const CRITIC_NAME = "critical_thinker";
      hooks.onAgentStart(CRITIC_NAME);
      hooks.onLog(CRITIC_NAME, { role: CRITIC_NAME, color: "#ff9ad9", text: "" });
      const criticReply = await runCriticDispatch({
        team, question, history: liveHistory, directives,
        modelFor, models, port, projectCwd, autoApprove, signal,
        onDelta: (d) => hooks.onLogDelta(CRITIC_NAME, d),
      });
      hooks.onAgentEnd(CRITIC_NAME);
      hooks.onAgentReply(CRITIC_NAME, criticReply);
      // Fold the Q+A into history as a user turn so the orchestrator's
      // replan sees a coherent conversation, not a dangling question.
      liveHistory.push({ role: "assistant", content: cleaned });
      liveHistory.push({ role: "user", content: `[critic, in your voice] ${criticReply}` });
      // Replan with the resolved decision in context.
      hooks.onAgentStart(orch.name);
      hooks.onLog(orch.name, { role: orch.name, color: "#ffd97a", text: "" });
      try {
        orchReply = await streamChatCompletion(
          port, orchModel, orchProvider,
          orchPrompt,
          `${goal}\n\n(the critic just answered "${criticReply}" to your "${question}" — incorporate this and dispatch now)`,
          tempFor(orch, 0.4), signal,
          (delta) => hooks.onLogDelta(orch.name, delta),
          projectCwd, liveHistory, autoApprove,
          (channel, role, delta) => hooks.onThoughtDelta(orch.name, channel, role, delta),
          roleByName.get(orch.base)?.toolAllowlist,
          undefined,
          getClaudeSession(projectId, orch.name),
        );
      } finally {
        hooks.onAgentEnd(orch.name);
      }
    }
  }

  // ---- Phase 1.5: BRAINSTORM with the critic before dispatching ----
  // If the team includes a critical_thinker (and director mode's
  // question-handshake didn't already fire above), have them review
  // the orchestrator's plan and feed back BEFORE work is delegated to
  // specialists. This is the "brainstorm" the user expects — not a
  // post-hoc review of the final synthesis, but a peer pass on the
  // plan itself. We re-run the orchestrator once with the critic's
  // notes folded in so the dispatch the specialists actually receive
  // reflects the joint thinking.
  const critic = findCriticSpec(team);
  // Whenever the orchestrator's first reply triggered a
  // @critical_thinker / [NEED_USER_INPUT] hand-off above (regardless
  // of director-mode), the orchestrator's SECOND reply already
  // reflects the critic's feedback — running another brainstorm pass
  // on top of that would just be a redundant peer review of itself.
  const skipBrainstorm = extractUserInputRequest(orchReply).question !== null;
  if (critic && critic.name !== orch.name && !skipBrainstorm) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    hooks.onThought(orch.name, {
      role: "dispatch",
      color: "#a578ff",
      text: `🧠 brainstorm → ${critic.name}`,
    });
    hooks.onAgentStart(critic.name);
    hooks.onLog(critic.name, { role: critic.name, color: "#ff9ad9", text: "" });
    const criticRole = roleByName.get(critic.base);
    const criticSysPrompt =
      criticRole?.systemPrompt ??
      criticRole?.description ??
      "You are the critical thinker. Briefly review the orchestrator's plan: flag missing edge cases, scope creep, missing roles, or alternative approaches. Be terse — 3-6 bullets max. Do not propose a different team; only critique the plan.";
    const criticBrainstormInput = [
      "The user's goal:",
      goal,
      "",
      "The orchestrator's proposed plan:",
      orchReply,
      "",
      "Review this plan. What is missing, risky, or worth challenging before specialists start work? 3-6 bullets max.",
    ].join("\n");
    const criticModelId = modelFor(critic.name);
    const criticProvider = providerFor(criticModelId, models);
    let criticBrainstormReply = "";
    try {
      criticBrainstormReply = await streamChatCompletion(
        port, criticModelId, criticProvider,
        criticSysPrompt, criticBrainstormInput,
        tempFor(critic, 0.3), signal,
        (delta) => hooks.onLogDelta(critic.name, delta),
        projectCwd, liveHistory, autoApprove,
        (channel, role, delta) => hooks.onThoughtDelta(critic.name, channel, role, delta),
        roleByName.get(critic.base)?.toolAllowlist,
        undefined,
        getClaudeSession(projectId, critic.name),
      );
    } catch (e) {
      // Brainstorm failure is non-fatal — continue with the original
      // plan rather than killing the whole dispatch.
      console.warn("[dispatch] brainstorm critic call failed:", e);
    } finally {
      hooks.onAgentEnd(critic.name);
    }

    if (criticBrainstormReply.trim()) {
      hooks.onAgentReply(critic.name, criticBrainstormReply);
      // Fold the critique into history and ask the orchestrator to
      // revise its plan. Only ONE revision pass — keeps the cost
      // bounded and avoids infinite back-and-forth.
      liveHistory.push({ role: "assistant", content: orchReply });
      liveHistory.push({
        role: "user",
        content: `[critical_thinker brainstorm — incorporate before dispatching]\n${criticBrainstormReply}`,
      });
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      hooks.onAgentStart(orch.name);
      hooks.onLog(orch.name, { role: orch.name, color: "#ffd97a", text: "" });
      try {
        orchReply = await streamChatCompletion(
          port, orchModel, orchProvider,
          orchPrompt,
          `${goal}\n\n(the critic raised these points — incorporate any that hold up, then dispatch)\n${criticBrainstormReply}`,
          tempFor(orch, 0.4), signal,
          (delta) => hooks.onLogDelta(orch.name, delta),
          projectCwd, liveHistory, autoApprove,
          (channel, role, delta) => hooks.onThoughtDelta(orch.name, channel, role, delta),
          roleByName.get(orch.base)?.toolAllowlist,
          undefined,
          getClaudeSession(projectId, orch.name),
        );
      } finally {
        hooks.onAgentEnd(orch.name);
      }
    }
  }

  // Push parsed dispatches into the orchestrator's Thought log so the
  // routing decision is visible separately from the user-facing reply.
  let parse = parseDispatchesDetailed(orchReply, team, orch.name);

  // Unresolved @names: fail LOUD (P1-3). Surface each one to the user, and
  // when they cost us dispatches, feed a correction back to the orchestrator
  // for ONE re-emit round instead of silently under-delivering.
  if (parse.unresolved.length > 0) {
    for (const u of parse.unresolved) {
      hooks.onThought(orch.name, {
        role: "system",
        color: "#ff8c8c",
        text: `⚠ "@${u.name}:" names no agent on this team${u.suggestion ? ` — did you mean '@${u.suggestion}:'?` : ""} (line NOT dispatched)`,
      });
    }
    if (parse.dispatches.length === 0) {
      const correction = unresolvedCorrectionMessage(parse.unresolved, team, orch.name);
      liveHistory.push({ role: "assistant", content: orchReply });
      liveHistory.push({ role: "user", content: correction });
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      hooks.onAgentStart(orch.name);
      hooks.onLog(orch.name, { role: orch.name, color: "#ffd97a", text: "" });
      try {
        orchReply = await streamChatCompletion(
          port, orchModel, orchProvider,
          orchPrompt, correction,
          tempFor(orch, 0.3), signal,
          (delta) => hooks.onLogDelta(orch.name, delta),
          projectCwd, liveHistory, autoApprove,
          (channel, role, delta) => hooks.onThoughtDelta(orch.name, channel, role, delta),
          roleByName.get(orch.base)?.toolAllowlist,
          undefined,
          getClaudeSession(projectId, orch.name),
        );
      } finally {
        hooks.onAgentEnd(orch.name);
      }
      parse = parseDispatchesDetailed(orchReply, team, orch.name);
      for (const u of parse.unresolved) {
        hooks.onThought(orch.name, {
          role: "system",
          color: "#ff8c8c",
          text: `⚠ still unresolved after correction: "@${u.name}:"${u.suggestion ? ` (nearest: '${u.suggestion}')` : ""}`,
        });
      }
    }
  }

  // Edges drive dispatch (P0-2): with a graph present, only edge-wired
  // targets run. Unwired-but-real names surface loudly and, when they cost
  // us everything, get ONE correction round naming the wired roster.
  let dispatches = parse.dispatches;
  const wired = wiredDispatchTargets(team, orch.name);
  if (wired !== null) {
    const unwiredD = dispatches.filter(d => !wired.has(d.agentName));
    dispatches = dispatches.filter(d => wired.has(d.agentName));
    for (const d of unwiredD) {
      hooks.onThought(orch.name, {
        role: "system",
        color: "#ffb74d",
        text: `⚠ @${d.agentName} is on the team but NOT WIRED to the orchestrator — line not dispatched. Draw the edge in the graph to enable it.`,
      });
    }
    if (dispatches.length === 0 && unwiredD.length > 0) {
      const correction = unwiredCorrectionMessage(unwiredD, wired);
      liveHistory.push({ role: "assistant", content: orchReply });
      liveHistory.push({ role: "user", content: correction });
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      hooks.onAgentStart(orch.name);
      hooks.onLog(orch.name, { role: orch.name, color: "#ffd97a", text: "" });
      try {
        orchReply = await streamChatCompletion(
          port, orchModel, orchProvider,
          orchPrompt, correction,
          tempFor(orch, 0.3), signal,
          (delta) => hooks.onLogDelta(orch.name, delta),
          projectCwd, liveHistory, autoApprove,
          (channel, role, delta) => hooks.onThoughtDelta(orch.name, channel, role, delta),
          roleByName.get(orch.base)?.toolAllowlist,
          undefined,
          getClaudeSession(projectId, orch.name),
        );
      } finally {
        hooks.onAgentEnd(orch.name);
      }
      const reparse = parseDispatchesDetailed(orchReply, team, orch.name);
      dispatches = reparse.dispatches.filter(d => wired.has(d.agentName));
      for (const d of reparse.dispatches.filter(x => !wired.has(x.agentName))) {
        hooks.onThought(orch.name, {
          role: "system",
          color: "#ffb74d",
          text: `⚠ still unwired after correction: @${d.agentName} — not dispatched.`,
        });
      }
    }
  }
  for (const d of dispatches) {
    hooks.onThought(orch.name, {
      role: "dispatch",
      color: "#a578ff",
      text: `📤 @${d.agentName}: ${d.instruction}`,
    });
  }

  // No specialists fired → the orchestrator's reply IS the final
  // answer. Strip stray directives (defensive) and return. If lines were
  // dropped as unresolved, say so instead of pretending this was a clean
  // solo answer.
  if (dispatches.length === 0) {
    const clean = stripDispatchDirectives(orchReply).trim() || orchReply;
    if (parse.unresolved.length > 0) {
      const names = parse.unresolved.map(u => `@${u.name}`).join(", ");
      hooks.onLog(orch.name, {
        role: "system",
        color: "#ff8c8c",
        text: `⚠ ${parse.unresolved.length} dispatch line(s) named unknown agents (${names}) and did NOT run — the answer below was produced without specialists.`,
      });
    }
    hooks.onAgentReply(orch.name, clean);
    hooks.onPhase("done");
    return clean;
  }

  // ---- Phase 2: dispatch every specialist IN PARALLEL ----
  // Promise.allSettled so one specialist failing doesn't kill the
  // others — partial results still get integrated. Each task pairs
  // its own onAgentStart / onAgentEnd so the canvas can light up
  // multiple agents simultaneously while they work concurrently.
  hooks.onPhase("dispatching");
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  // Run ONE agent on `instruction`; returns {name, text} (or an error reply).
  const runOneAgent = async (spec: AgentSpec, instruction: string): Promise<{ name: string; text: string }> => {
    hooks.onAgentStart(spec.name);
    hooks.onThought(spec.name, { role: "dispatch", color: "#a578ff", text: `📩 ${instruction}` });
    hooks.onLog(spec.name, { role: spec.name, color: colorForAgent(spec), text: "" });
    const specPrompt = buildSpecialistPrompt(team, spec, roleByName, directives);
    const specModel = modelFor(spec.name);
    const specProvider = providerFor(specModel, models);
    try {
      const specText = await streamChatCompletion(
        port, specModel, specProvider,
        specPrompt, instruction, tempFor(spec, 0.5), signal,
        (delta) => hooks.onLogDelta(spec.name, delta),
        projectCwd, [], autoApprove,
        (channel, role, delta) => hooks.onThoughtDelta(spec.name, channel, role, delta),
        roleByName.get(spec.base)?.toolAllowlist,
        undefined,
        getClaudeSession(projectId, spec.name),
      );
      const cleaned = specText.trim();
      hooks.onAgentReply(spec.name, cleaned);
      return { name: spec.name, text: cleaned };
    } catch (e: any) {
      const errMsg = `(error: ${String(e?.message ?? e)})`;
      hooks.onLogDelta(spec.name, "\n\n" + errMsg);
      hooks.onAgentReply(spec.name, errMsg);
      return { name: spec.name, text: errMsg };
    } finally {
      hooks.onAgentEnd(spec.name);
    }
  };
  // Tier-3 autonomous handoff: walk the linear pipeline from each initial
  // dispatch along non-orchestrator edges — `coder → critic` makes the critic
  // receive the coder's output, no orchestrator in between. A visited set +
  // MAX_CHAIN_HOPS guarantee termination on cyclic graphs. A team with no
  // agent→agent edges runs exactly one agent per dispatch (today's behavior).
  // FAN-OUT: an agent hands its output to EVERY agent its arrows point to (not
  // just the first) — the workflow follows the graph the user drew. A node with
  // 3 outgoing arrows runs all 3 downstream (sequentially, so each builds on the
  // last cleanly); leaves (no non-orchestrator arrow) are the terminal results
  // the orchestrator integrates. A per-tree `ran` set (claimed synchronously
  // before each await) + MAX_CHAIN_HOPS dedupe fan-in and guarantee termination.
  const runFrom = async (name: string, input: string, ran: Set<string>): Promise<Array<{ name: string; text: string }>> => {
    if (ran.has(name) || ran.size >= MAX_CHAIN_HOPS) return [];
    ran.add(name);
    const spec = team.agents.find(a => a.name === name);
    if (!spec) return [];
    const out = await runOneAgent(spec, input);
    const downstream = downstreamTargets(team, name, orch.name).filter(t => !ran.has(t));
    if (downstream.length === 0) return [out];      // leaf → a terminal result
    const handoff = `You are continuing a team workflow. @${out.name} produced the following — build on it for YOUR part of the task:\n\n${out.text}`;
    hooks.onThought(name, { role: "dispatch", color: "#a578ff",
      text: `➡ handing off to ${downstream.map(x => "@" + x).join(", ")}` });
    const results: Array<{ name: string; text: string }> = [];
    for (const t of downstream) results.push(...await runFrom(t, handoff, ran));
    return results.length ? results : [out];
  };
  const settled = await Promise.allSettled(dispatches.map(d => runFrom(d.agentName, d.instruction, new Set<string>())));
  const specialistReplies: Array<{ name: string; text: string }> = [];
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) specialistReplies.push(...r.value);
  }

  if (specialistReplies.length === 0) {
    hooks.onPhase("done");
    return "(no specialist replied)";
  }

  // ---- Phase 3: orchestrator integrates the specialist replies ----
  hooks.onPhase("integrating");
  hooks.onAgentStart(orch.name);
  const integrationInput = [
    `The user's original goal:\n${goal}`,
    "",
    "Your specialists' replies:",
    ...specialistReplies.map(r => `\n— ${displayLabel(r.name)} —\n${r.text}`),
    "",
    "Now write the FINAL answer for the user. Be concise, structured, and quote the relevant specialist when useful. Do not dispatch again.",
  ].join("\n");
  hooks.onLog(orch.name, { role: orch.name, color: "#ffd97a", text: "" });
  const finalModel = modelFor(orch.name);
  const finalProvider = providerFor(finalModel, models);
  let finalReply: string;
  try {
    finalReply = await streamChatCompletion(
      port, finalModel, finalProvider,
      orchPrompt, integrationInput, tempFor(orch, 0.4), signal,
      (delta) => hooks.onLogDelta(orch.name, delta),
      projectCwd, liveHistory, autoApprove,
      (channel, role, delta) => hooks.onThoughtDelta(orch.name, channel, role, delta),
      roleByName.get(orch.base)?.toolAllowlist,
      undefined,
      getClaudeSession(projectId, orch.name),
    );
  } finally {
    hooks.onAgentEnd(orch.name);
  }
  const final = finalReply.trim();
  hooks.onAgentReply(orch.name, final);
  hooks.onPhase("done");
  return final;
}
