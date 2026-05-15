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

import { invoke } from "@tauri-apps/api/core";

// ---------- Domain types (mirrors AgentsPage.tsx) ----------
export type GoalMsg = { role: string; color: string; text: string };
export type HistoryItem = { role: "user" | "assistant"; content: string };
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
    });
  }
  return m;
}

// ---------- Prompt builders ----------
export function buildOrchestratorPrompt(team: Team, roleByName: Map<string, RoleData>, orch: AgentSpec): string {
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

export function buildSpecialistPrompt(team: Team, spec: AgentSpec, roleByName: Map<string, RoleData>): string {
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
  layers.push("The orchestrator has dispatched the task below. Reply concisely and directly with your work.");
  layers.push("Do NOT dispatch further — only the orchestrator may dispatch. Stay in your role.");
  return layers.join("\n");
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
type CloudRoute = { forceSub?: boolean; forceApi?: boolean };

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
): Promise<string> {
  const forceSub = modelId.startsWith("sub/");
  const forceApi = modelId.startsWith("api/");
  const bareId = forceSub || forceApi || modelId.startsWith("auto/")
    ? modelId.slice(modelId.indexOf("/") + 1)
    : modelId;

  if (provider === "auto") {
    throw new Error(`Auto routing (${modelId}) is not implemented yet — pick a specific model.`);
  }
  if (provider === "anthropic") {
    return streamAnthropic(bareId, { forceSub, forceApi }, systemPrompt, userMessage, temperature, signal, onDelta, projectCwd, history, autoApprove);
  }
  if (provider === "openai") {
    return streamOpenAI(bareId, { forceSub, forceApi }, systemPrompt, userMessage, temperature, signal, onDelta, history);
  }
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: systemPrompt },
    ...(history ?? []),
    { role: "user", content: userMessage },
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
  return consumeOpenAISse(resp, onDelta);
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
): Promise<string> {
  const wantSub = route.forceSub === true;
  const wantApi = route.forceApi === true;
  const cliPrompt = foldHistoryIntoPrompt(userMessage, history);
  if (wantSub) {
    const status = await invoke<{ claude_cli: boolean }>("accounts_status");
    if (!status?.claude_cli) {
      throw new Error("Claude Code CLI not detected — run `claude /login` first.");
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
        const reply = await invoke<string>("claude_cli_complete", { systemPrompt, userMessage: cliPrompt, cwd: projectCwd ?? null, autoApprove: autoApprove ?? false });
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
      if (!body) continue;
      try {
        const j = JSON.parse(body);
        if (j?.type === "content_block_delta") {
          const txt: string | undefined = j?.delta?.text;
          if (typeof txt === "string" && txt) { acc += txt; onDelta(txt); }
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
): Promise<string> {
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
        { role: "user", content: userMessage },
      ],
      stream: true,
      temperature,
    }),
    signal,
  });
  return consumeOpenAISse(resp, onDelta);
}

async function consumeOpenAISse(resp: Response, onDelta: StreamHandler): Promise<string> {
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
};

export async function runDispatchLoop(opts: DispatchInput, hooks: DispatchHooks): Promise<string> {
  const { team, roleByName, goal, modelFor, models, port, projectCwd, history, autoApprove, signal } = opts;
  const tempFor = (spec: AgentSpec, fallback: number) =>
    roleByName.get(spec.base)?.defaultTemperature ?? fallback;

  // ---- Phase 1: orchestrator plans ----
  hooks.onPhase("planning");
  const orch = findOrchestratorSpec(team);
  if (!orch) throw new Error("Team has no orchestrator (and no agents at all).");
  hooks.onAgentStart(orch.name);
  hooks.onLog(orch.name, { role: orch.name, color: "#ffd97a", text: "" });

  const orchPrompt = buildOrchestratorPrompt(team, roleByName, orch);
  const orchModel = modelFor(orch.name);
  const orchProvider = providerFor(orchModel, models);
  let orchReply: string;
  try {
    orchReply = await streamChatCompletion(
      port, orchModel, orchProvider,
      orchPrompt, goal, tempFor(orch, 0.4), signal,
      (delta) => hooks.onLogDelta(orch.name, delta),
      projectCwd, history, autoApprove,
    );
  } finally {
    hooks.onAgentEnd(orch.name);
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
    const specPrompt = buildSpecialistPrompt(team, spec, roleByName);
    const specModel = modelFor(spec.name);
    const specProvider = providerFor(specModel, models);
    try {
      const specText = await streamChatCompletion(
        port, specModel, specProvider,
        specPrompt, d.instruction, tempFor(spec, 0.5), signal,
        (delta) => hooks.onLogDelta(spec.name, delta),
        projectCwd, [], autoApprove,
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
      projectCwd, history, autoApprove,
    );
  } finally {
    hooks.onAgentEnd(orch.name);
  }
  const final = finalReply.trim();
  hooks.onAgentReply(orch.name, final);
  hooks.onPhase("done");
  return final;
}
