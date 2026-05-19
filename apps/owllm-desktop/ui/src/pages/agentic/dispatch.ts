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
    onEvent: ch,
  });
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
): string {
  const specialists = team.agents.filter(a => a.name !== orch.name);
  const roster = specialists.map(a => {
    const desc = a.description ?? roleByName.get(a.base)?.description ?? "";
    return `  - ${a.name} (${a.base}): ${desc}`;
  }).join("\n");
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
  return [
    `You are the orchestrator of the '${team.display}' team.`,
    "",
    orchSystemPrompt,
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

export function parseDispatches(text: string, team: Team, exclude: string): Dispatch[] {
  const known = new Set(team.agents.map(a => a.name));
  const lines = text.split(/\r?\n/);
  const out: Dispatch[] = [];
  const re = /^[\s\-\d.*•]*@([A-Za-z0-9._\-]+)\s*[:：]\s*(.+)$/;
  for (const raw of lines) {
    const m = raw.trim().match(re);
    if (!m) continue;
    const name = m[1];
    if (!known.has(name)) continue;
    if (name === exclude) continue;
    out.push({ agentName: name, instruction: m[2].trim() });
  }
  return out;
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

// ---------- Attachment helpers ----------

export function imageAttachments(atts?: Attachment[]): Attachment[] {
  return (atts ?? []).filter(a => a.kind === "image");
}
export function audioAttachments(atts?: Attachment[]): Attachment[] {
  return (atts ?? []).filter(a => a.kind === "audio");
}

/// Transcribe every audio attachment via OpenAI Whisper and fold the
/// transcripts into the user message. Returns the rewritten user
/// message (unchanged when there are no audio parts). Requires
/// OPENAI_API_KEY — there is no provider-agnostic local fallback. If
/// no key is saved the audio parts are surfaced as a `[no transcript]`
/// note so the model still knows audio was attached, and dispatch
/// continues.
export async function transcribeAudioAttachments(
  userMessage: string,
  attachments: Attachment[] | undefined,
): Promise<string> {
  const auds = audioAttachments(attachments);
  if (auds.length === 0) return userMessage;
  const key = await invoke<string | null>("accounts_get_secret", { name: "OPENAI_API_KEY" });
  if (!key) {
    const note = auds.map(a => `[Audio attached: ${a.filename ?? a.mime} — no transcript: save OPENAI_API_KEY on the Accounts page to enable Whisper.]`).join("\n");
    return userMessage ? `${userMessage}\n\n${note}` : note;
  }
  const transcripts: string[] = [];
  for (const a of auds) {
    try {
      const bin = base64ToBytes(a.data_b64);
      // Slice into a fresh ArrayBuffer copy — Blob constructor's
      // BlobPart type rejects Uint8Array<SharedArrayBuffer>, and TS
      // can't prove our buffer is the non-shared variant.
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
        transcripts.push(`[Audio "${filename}" — Whisper error: ${err.slice(0, 200)}]`);
        continue;
      }
      const text = (await resp.text()).trim();
      transcripts.push(`[Audio "${filename}" transcript]\n${text}`);
    } catch (e: any) {
      transcripts.push(`[Audio "${a.filename ?? a.mime}" — transcribe failed: ${String(e?.message ?? e).slice(0, 200)}]`);
    }
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
): Promise<string> {
  const forceSub = modelId.startsWith("sub/");
  const forceApi = modelId.startsWith("api/");
  const bareId = forceSub || forceApi || modelId.startsWith("auto/")
    ? modelId.slice(modelId.indexOf("/") + 1)
    : modelId;

  // Transcribe any audio parts first (Whisper, one-shot). After this,
  // `effectiveText` carries the original prompt + transcript blocks
  // and we only need to worry about image parts per provider.
  const effectiveText = await transcribeAudioAttachments(userMessage, attachments);
  const images = imageAttachments(attachments);

  if (provider === "auto") {
    throw new Error(`Auto routing (${modelId}) is not implemented yet — pick a specific model.`);
  }
  if (provider === "anthropic") {
    return streamAnthropic(bareId, { forceSub, forceApi }, systemPrompt, effectiveText, temperature, signal, onDelta, projectCwd, history, autoApprove, onThought, allowedTools, images);
  }
  if (provider === "openai") {
    return streamOpenAI(bareId, { forceSub, forceApi }, systemPrompt, effectiveText, temperature, signal, onDelta, history, onThought, images);
  }
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
  // Local llama-server is OpenAI-compatible; route through the same
  // parser so reasoning_content + <think> tag stripping works for it too.
  return consumeOpenAISse(resp, onDelta, onThought);
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
): Promise<string> {
  const wantSub = route.forceSub === true;
  const wantApi = route.forceApi === true;
  const imgList = images ?? [];
  // The Claude CLI binding is text-only. When the user routed via the
  // subscription path AND attached images, prefix a note so they're
  // not silently dropped. Users on the API path get full inline images.
  const cliUserMessage = imgList.length > 0
    ? `${userMessage}\n\n[${imgList.length} image attachment(s) dropped — switch to the API row to send images to Claude.]`
    : userMessage;
  const cliPrompt = foldHistoryIntoPrompt(cliUserMessage, history);
  if (wantSub) {
    const status = await invoke<{ claude_cli: boolean }>("accounts_status");
    if (!status?.claude_cli) {
      throw new Error("Claude Code CLI not detected — run `claude /login` first.");
    }
    // Stream when the consumer wants thought traffic (AgentsPage); fall
    // back to one-shot --print blob otherwise (the bridge runner that
    // doesn't display a Thought tab).
    if (onThought) {
      return await runClaudeCliStream({
        systemPrompt, userMessage: cliPrompt, cwd: projectCwd ?? null,
        autoApprove: autoApprove ?? false, allowedTools,
        onDelta, onThought,
      });
    }
    const reply = await invoke<string>("claude_cli_complete", { systemPrompt, userMessage: cliPrompt, cwd: projectCwd ?? null, autoApprove: autoApprove ?? false });
    if (reply) onDelta(reply);
    return reply;
  }
  const key = await invoke<string | null>("accounts_get_secret", { name: "ANTHROPIC_API_KEY" });
  if (!key) {
    if (wantApi) throw new Error("No ANTHROPIC_API_KEY saved — set it on the Accounts page.");
    try {
      const status = await invoke<{ claude_cli: boolean }>("accounts_status");
      if (status?.claude_cli) {
        if (onThought) {
          return await runClaudeCliStream({
            systemPrompt, userMessage: cliPrompt, cwd: projectCwd ?? null,
            autoApprove: autoApprove ?? false, allowedTools,
            onDelta, onThought,
          });
        }
        const reply = await invoke<string>("claude_cli_complete", {
          systemPrompt, userMessage: cliPrompt, cwd: projectCwd ?? null,
          autoApprove: autoApprove ?? false,
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
    body: JSON.stringify({
      model: modelId,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        ...(history ?? []).map(h => ({ role: h.role, content: h.content })),
        { role: "user", content: anthropicUserContent(userMessage, imgList) },
      ],
      stream: true,
      temperature,
    }),
    signal,
  });
  if (!resp.ok || !resp.body) {
    throw new Error(await resp.text().catch(() => `HTTP ${resp.status}`));
  }
  return consumeAnthropicSse(resp, onDelta, onThought);
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
  _route: CloudRoute,
  systemPrompt: string,
  userMessage: string,
  temperature: number,
  signal: AbortSignal,
  onDelta: StreamHandler,
  history?: HistoryItem[],
  onThought?: ThoughtHandler,
  /// Image attachments only — audio is transcribed in streamChatCompletion.
  images?: Attachment[],
): Promise<string> {
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
): Promise<string> {
  if (!resp.ok || !resp.body) {
    throw new Error(await resp.text().catch(() => `HTTP ${resp.status}`));
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let acc = "";
  // Track <think> tag state across deltas — content can split across chunks.
  let inThink = false;
  // Per-tool-call-index → resolved tool name; the model streams the
  // function name in the first chunk(s) and arguments in later ones.
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
        // DeepSeek-R1 / o-series reasoning channel — separate field.
        const reasoning: string | undefined = delta?.reasoning_content ?? delta?.reasoning;
        if (typeof reasoning === "string" && reasoning) {
          onThought?.("thinking", "🧠 thinking", reasoning);
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
          if (thought) onThought?.("thinking", "🧠 thinking", thought);
          if (reply)   { acc += reply; onDelta(reply); }
        }
      } catch { /* skip malformed chunk */ }
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
};

export type DispatchInput = {
  team: Team;
  roleByName: Map<string, RoleData>;
  goal: string;
  modelFor: (agentName: string) => string;
  models: ModelInfo[];
  port: number;
  projectCwd: string;
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

/// Parse [NEED_USER_INPUT] markers out of an orchestrator reply. We only
/// honour the FIRST marker per turn — a single dispatch shouldn't spawn
/// multiple critic calls (paralysis-by-committee). Returns the question
/// text + the cleaned reply (marker line removed) so the orchestrator's
/// own log doesn't show the marker verbatim.
export function extractUserInputRequest(text: string): { question: string | null; cleaned: string } {
  const m = text.match(NEED_USER_INPUT_RE);
  if (!m) return { question: null, cleaned: text };
  const question = m[1].trim();
  const cleaned = text.replace(NEED_USER_INPUT_RE, "").trim();
  return { question, cleaned };
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
  const { team, roleByName, goal, modelFor, models, port, projectCwd, history, autoApprove, signal, directives, directorMode, attachments } = opts;
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

  const orchPrompt = buildOrchestratorPrompt(team, roleByName, orch, directives, directorMode);
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
  if (directorMode) {
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
        );
      } finally {
        hooks.onAgentEnd(orch.name);
      }
    }
  }

  // Push parsed dispatches into the orchestrator's Thought log so the
  // routing decision is visible separately from the user-facing reply.
  const dispatches = parseDispatches(orchReply, team, orch.name);
  for (const d of dispatches) {
    hooks.onThought(orch.name, {
      role: "dispatch",
      color: "#a578ff",
      text: `📤 @${d.agentName}: ${d.instruction}`,
    });
  }

  // No specialists fired → the orchestrator's reply IS the final
  // answer. Strip stray directives (defensive) and return.
  if (dispatches.length === 0) {
    const clean = stripDispatchDirectives(orchReply).trim() || orchReply;
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
  const settled = await Promise.allSettled(dispatches.map(async (d) => {
    const spec = team.agents.find(a => a.name === d.agentName);
    if (!spec) return null;
    hooks.onAgentStart(spec.name);
    hooks.onThought(spec.name, {
      role: "dispatch",
      color: "#a578ff",
      text: `📩 ${d.instruction}`,
    });
    hooks.onLog(spec.name, { role: spec.name, color: colorForAgent(spec), text: "" });
    const specPrompt = buildSpecialistPrompt(team, spec, roleByName, directives);
    const specModel = modelFor(spec.name);
    const specProvider = providerFor(specModel, models);
    try {
      const specText = await streamChatCompletion(
        port, specModel, specProvider,
        specPrompt, d.instruction, tempFor(spec, 0.5), signal,
        (delta) => hooks.onLogDelta(spec.name, delta),
        projectCwd, [], autoApprove,
        (channel, role, delta) => hooks.onThoughtDelta(spec.name, channel, role, delta),
        roleByName.get(spec.base)?.toolAllowlist,
      );
      const cleaned = specText.trim();
      hooks.onAgentReply(spec.name, cleaned);
      return { name: spec.name, text: cleaned };
    } catch (e: any) {
      // Surface the failure into the agent's own log so the user
      // sees which specialist died.
      const errMsg = `(error: ${String(e?.message ?? e)})`;
      hooks.onLogDelta(spec.name, "\n\n" + errMsg);
      hooks.onAgentReply(spec.name, errMsg);
      return { name: spec.name, text: errMsg };
    } finally {
      hooks.onAgentEnd(spec.name);
    }
  }));
  const specialistReplies: Array<{ name: string; text: string }> = [];
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) specialistReplies.push(r.value);
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
    );
  } finally {
    hooks.onAgentEnd(orch.name);
  }
  const final = finalReply.trim();
  hooks.onAgentReply(orch.name, final);
  hooks.onPhase("done");
  return final;
}
