// Shared bridge dispatch core.
//
// The transport-agnostic guts extracted from TelegramBridgeRunner so EVERY
// bridge (Telegram, Discord, Slack, Email, WhatsApp, LINE…) routes
// inbound messages through the SAME orchestrator → specialists → integrate
// loop, with the SAME project routing, model-help commands, chat persistence
// and desktop-canvas event mirroring. A bridge supplies only a
// `BridgeTransport` (how to send a reply on that platform) + per-message
// config; all the dispatch logic lives here exactly once.
//
// History: this is a behaviour-preserving extraction of the Telegram runner
// (the bridge that already shipped). The Telegram runner now owns only its
// transport (HTTP getUpdates/sendMessage/download) + the long-poll loop and
// delegates message handling to useBridgeDispatch().handleMessage().

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  GoalMsg, ModelInfo, ServerStatus, Team, RoleData,
  ProjectRow, TeamTemplateBackend, AgentRoleBackend,
  toTeam, projectToTeam, rolesFromBackend,
  chatToHistory, findOrchestratorSpec,
  runDispatchLoop, DispatchPhase,
  type Attachment,
} from "../pages/agentic/dispatch";
import { buildEntries, type AccountsStatusLite, type ModelPickerEntry } from "../pages/agentic/ModelPicker";

/// How a bridge sends a reply on its platform. The ONLY transport coupling the
/// dispatch core needs — everything inbound (receiving/download) lives in each
/// bridge's own runner, which then calls handleMessage().
export type BridgeTransport = {
  /// Stable lowercase id: "telegram" | "discord" | "slack" | "email" | …
  /// Used to namespace per-chat routing in localStorage and to tag canvas
  /// events. NOTE: "telegram" keeps its legacy key shape (see keyFor) so the
  /// existing Telegram bridge's per-chat routing survives this refactor.
  name: string;
  /// Short label for the desktop canvas inbound chip, e.g. "TG", "Discord".
  tag: string;
  /// Safe per-message length (chars). Replies longer than this are split into
  /// "(1/3) …" chunks. Telegram = 4000 (API hard cap 4096).
  maxLen: number;
  /// Send a plain-text reply to a chat/channel/thread id on this platform.
  send: (chatId: string, text: string) => Promise<void>;
};

/// The slice of a bridge's saved config the core needs. Each bridge maps its
/// own config shape (bot_token, allowed_chat_ids: number[], …) onto this.
export type BridgeConfigLite = {
  /// Allow-list of chat/channel ids ([] = allow everyone). Strings so every
  /// platform (numeric Telegram ids, string Discord snowflakes) fits.
  allowed: string[];
  /// Default project id for this bridge when a chat has no active project.
  project_id: string;
  /// Pass-through to runDispatchLoop (auto-approve tool calls).
  auto_approve: boolean;
};

// Shared global inbox. Kept under its historical name so existing Telegram
// users' inbox project is not orphaned; all bridges share this one inbox.
const BRAINSTORM_PROJECT_NAME = "Telegram Brainstorm Inbox";

// ---- pure helpers (no refs) -------------------------------------------------

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function shortNameFromText(text: string): string {
  const words = text
    .replace(/^\/new\b/i, "")
    .replace(/^new project\b/i, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  return words.length ? words.join(" ") : "Bridge idea";
}

function scoreProject(text: string, project: ProjectRow): number {
  const hay = norm(text);
  const name = norm(project.name);
  if (!hay || !name) return 0;
  if (hay.includes(name)) return 100 + name.length;
  const tokens = name.split(/\s+/).filter(t => t.length >= 3);
  if (!tokens.length) return 0;
  const hits = tokens.filter(t => hay.includes(t)).length;
  return hits >= Math.min(2, tokens.length) ? hits * 20 : 0;
}

// Per-chat active-project routing key. Telegram keeps its original key so the
// refactor doesn't reset existing users' routing; new bridges are namespaced.
function keyFor(name: string, chatId: string): string {
  return name === "telegram"
    ? `owllm:telegram:active-project:${chatId}`
    : `owllm:bridge:${name}:active-project:${chatId}`;
}
function getChatProject(name: string, chatId: string): string {
  try { return localStorage.getItem(keyFor(name, chatId)) || ""; } catch { return ""; }
}
function setChatProject(name: string, chatId: string, projectId: string) {
  try { localStorage.setItem(keyFor(name, chatId), projectId); } catch {}
}
/// Clear every per-chat project mapping for a bridge. Called when the user
/// changes the bridge's configured default project in the UI, so a STALE
/// auto-mapping can't keep overriding their choice (the "I picked RED but
/// messages go to an old project" bug). After this, the configured default
/// applies until the user explicitly runs /project in a chat.
export function clearChatProjects(name: string): void {
  const prefix = name === "telegram"
    ? "owllm:telegram:active-project:"
    : `owllm:bridge:${name}:active-project:`;
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) stale.push(k);
    }
    for (const k of stale) localStorage.removeItem(k);
  } catch { /* ignore */ }
}

// Split a reply into platform-safe chunks on paragraph/line boundaries.
function splitForLen(body: string, maxLen: number): string[] {
  if (body.length <= maxLen) return [body];
  const out: string[] = [];
  let rest = body;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf("\n\n", maxLen);
    if (cut < maxLen / 2) cut = rest.lastIndexOf("\n", maxLen);
    if (cut < maxLen / 2) cut = maxLen;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

type RouteDecision =
  | { kind: "ping" }
  | { kind: "list-projects" }
  | { kind: "list-models" }
  | { kind: "set-model"; project: ProjectRow; modelId: string }
  | { kind: "switch-project"; project: ProjectRow }
  | { kind: "new-brainstorm"; idea: string }
  | { kind: "dispatch"; project: ProjectRow; reason: string };

// ---- the hook ---------------------------------------------------------------

export function useBridgeDispatch() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [accountsStatus, setAccountsStatus] = useState<AccountsStatusLite | null>(null);
  const [server, setServer] = useState<ServerStatus>({ running: false, model_id: null, port: null });
  const [teams, setTeams] = useState<Team[]>([]);
  const [roleByName, setRoleByName] = useState<Map<string, RoleData>>(new Map());

  const projectsRef = useRef(projects); projectsRef.current = projects;
  const modelsRef = useRef(models); modelsRef.current = models;
  const accountsStatusRef = useRef(accountsStatus); accountsStatusRef.current = accountsStatus;
  const serverRef = useRef(server); serverRef.current = server;
  const teamsRef = useRef(teams); teamsRef.current = teams;
  const roleByNameRef = useRef(roleByName); roleByNameRef.current = roleByName;

  // Initial config + auxiliary data load on mount.
  useEffect(() => {
    invoke<ProjectRow[]>("list_projects").then(setProjects).catch(() => {});
    invoke<ModelInfo[]>("list_models").then(setModels).catch(() => {});
    invoke<AccountsStatusLite>("accounts_status").then(setAccountsStatus).catch(() => {});
    invoke<TeamTemplateBackend[]>("list_team_templates").then(rows => setTeams(rows.map(toTeam))).catch(() => {});
    invoke<AgentRoleBackend[]>("list_agent_roles").then(rows => setRoleByName(rolesFromBackend(rows))).catch(() => {});
  }, []);

  // Periodic refresh — server status + projects so the bridge sees a freshly
  // created project and up-to-date chat_json even when the desktop's been
  // writing in parallel.
  useEffect(() => {
    const tick = async () => {
      try { setServer(await invoke<ServerStatus>("server_status")); } catch {}
      try { setProjects(await invoke<ProjectRow[]>("list_projects")); } catch {}
      try { setAccountsStatus(await invoke<AccountsStatusLite>("accounts_status")); } catch {}
    };
    tick();
    const id = window.setInterval(tick, 5000);
    return () => window.clearInterval(id);
  }, []);

  // Send (with platform-safe chunking + best-effort failure notice).
  const send = async (transport: BridgeTransport, chatId: string, body: string) => {
    if (!body || !body.trim()) return;
    const chunks = splitForLen(body, transport.maxLen);
    const total = chunks.length;
    for (let i = 0; i < total; i++) {
      const prefix = total > 1 ? `(${i + 1}/${total}) ` : "";
      try {
        await transport.send(chatId, prefix + chunks[i]);
      } catch (e) {
        const msg = `[${transport.name}] send failed (chunk ${i + 1}/${total}): ${String((e as any)?.message ?? e)}`;
        console.error(msg, e);
        try {
          await transport.send(chatId, `(reply send failed: ${String((e as any)?.message ?? e).slice(0, 200)})`);
        } catch { /* truly offline */ }
        return;
      }
    }
  };

  // Atomic merge — read fresh chat_json from DB, append, write back.
  const persistChat = async (projectId: string, toAppend: GoalMsg[]): Promise<void> => {
    try {
      const rows = await invoke<ProjectRow[]>("list_projects");
      setProjects(rows);
      const fresh = rows.find(p => p.id === projectId);
      let chat: GoalMsg[] = [];
      try {
        if (fresh?.chat_json) {
          const parsed = JSON.parse(fresh.chat_json);
          if (Array.isArray(parsed)) chat = parsed as GoalMsg[];
        }
      } catch { /* fall back */ }
      const next = [...chat, ...toAppend];
      await invoke("update_project", { input: { id: projectId, chat_json: JSON.stringify(next) } });
    } catch (e) {
      console.error("[bridge] persistChat failed", e);
    }
  };

  const resolveTeam = (project: ProjectRow | null): Team | null => {
    if (project && Array.isArray(project.team) && project.team.length > 0) {
      return projectToTeam(project);
    }
    if (teamsRef.current.length > 0) return teamsRef.current[0];
    return null;
  };

  const createProjectFromText = async (name: string, description: string): Promise<ProjectRow> => {
    const fallbackTeam = teamsRef.current[0];
    const team = fallbackTeam ? fallbackTeam.agents.map(a => a.name) : [];
    const project = await invoke<ProjectRow>("create_project", {
      input: {
        name, description, location: "", team, graph_json: "",
        team_default_model_id: "", trust_writes: false, auto_approve_all: false,
      },
    });
    const rows = await invoke<ProjectRow[]>("list_projects").catch(() => [...projectsRef.current, project]);
    setProjects(rows);
    return project;
  };

  const refreshProjects = async (): Promise<ProjectRow[]> => {
    const rows = await invoke<ProjectRow[]>("list_projects");
    setProjects(rows);
    return rows;
  };

  const ensureBrainstormProject = async (): Promise<ProjectRow> => {
    const existing = projectsRef.current.find(p => p.name === BRAINSTORM_PROJECT_NAME);
    if (existing) return existing;
    return createProjectFromText(
      BRAINSTORM_PROJECT_NAME,
      "Global bridge inbox for brainstorming, project discovery, and dispatch routing before a dedicated project exists.",
    );
  };

  const findProjectByQuery = (query: string): ProjectRow | null => {
    const q = norm(query);
    if (!q) return null;
    let best: { project: ProjectRow; score: number } | null = null;
    for (const p of projectsRef.current) {
      const score = scoreProject(q, p);
      if (!best || score > best.score) best = { project: p, score };
    }
    return best && best.score >= 20 ? best.project : null;
  };

  const currentProjectForChat = async (name: string, cfg: BridgeConfigLite, chatId: string): Promise<ProjectRow> => {
    const projectsNow = projectsRef.current;
    const activeId = getChatProject(name, chatId);
    const active = activeId ? projectsNow.find(p => p.id === activeId) : null;
    if (active) return active;
    const configured = cfg.project_id ? projectsNow.find(p => p.id === cfg.project_id) : null;
    if (configured) return configured;
    return ensureBrainstormProject();
  };

  const modelChoices = (): ModelPickerEntry[] => {
    return buildEntries(modelsRef.current, accountsStatusRef.current)
      .filter(e => e.available && !e.id.startsWith("auto/"));
  };

  const modelChoiceIdAt = (n: number): string => modelChoices()[n - 1]?.id ?? "";

  const modelHelp = (projectName?: string): string => {
    const entries = modelChoices().slice(0, 20);
    const target = projectName ? ` for "${projectName}"` : "";
    const choices = entries.length
      ? entries.map((e, i) => `${i + 1}. ${e.id}`).join("\n")
      : "(no available models detected yet)";
    return [
      `Choose a model${target} before the agents can run.`,
      "",
      choices,
      "",
      "Reply with the number only, for example: 3",
      "Full id also works: /model <model-id>",
      "",
      "You can also set the team model in the Agentic Team page.",
    ].join("\n");
  };

  const normalizeModelId = (text: string): string => {
    const raw = text.trim().replace(/^<(.+)>$/, "$1");
    if (!raw) return "";
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return modelChoiceIdAt(n);
    const ids = modelChoices().map(e => e.id);
    const exact = ids.find(id => id.toLowerCase() === raw.toLowerCase());
    if (exact) return exact;
    const byBare = ids.find(id => norm(id).includes(norm(raw)));
    return byBare || raw;
  };

  const saveProjectModel = async (projectId: string, modelId: string): Promise<ProjectRow | null> => {
    await invoke("update_project", { input: { id: projectId, team_default_model_id: modelId } });
    const rows = await refreshProjects().catch(() => projectsRef.current);
    return rows.find(p => p.id === projectId) ?? null;
  };

  const routeMessage = async (name: string, cfg: BridgeConfigLite, chatId: string, text: string): Promise<RouteDecision> => {
    const trimmed = text.trim();
    const projectsNow = projectsRef.current;
    if (/^\/ping\b/i.test(trimmed)) return { kind: "ping" };
    if (/^\/projects\b/i.test(trimmed)) return { kind: "list-projects" };
    if (/^\/models\b/i.test(trimmed)) return { kind: "list-models" };

    const numberOnly = trimmed.match(/^\d+$/);
    if (numberOnly) {
      const project = await currentProjectForChat(name, cfg, chatId);
      if (!(project.team_default_model_id || "").trim()) {
        return { kind: "set-model", project, modelId: normalizeModelId(trimmed) };
      }
    }

    const modelMatch = trimmed.match(/^\/model\s*<?(.+?)>?$/i)
      ?? trimmed.match(/^model\s*:\s*(.+)$/i);
    if (modelMatch) {
      const project = await currentProjectForChat(name, cfg, chatId);
      return { kind: "set-model", project, modelId: normalizeModelId(modelMatch[1]) };
    }

    const switchMatch = trimmed.match(/^\/(?:project|use|switch)\s+(.+)$/i)
      ?? trimmed.match(/^project\s*:\s*(.+)$/i);
    if (switchMatch) {
      const project = findProjectByQuery(switchMatch[1]);
      if (project) return { kind: "switch-project", project };
      const inbox = await ensureBrainstormProject();
      return { kind: "dispatch", project: inbox, reason: "project-not-found" };
    }

    const newMatch = trimmed.match(/^\/new(?:\s+(.+))?$/i)
      ?? trimmed.match(/^new project\s*:?\s*(.+)$/i);
    if (newMatch) {
      return { kind: "new-brainstorm", idea: (newMatch[1] || trimmed).trim() };
    }

    const explicit = findProjectByQuery(trimmed);
    if (explicit && explicit.name !== BRAINSTORM_PROJECT_NAME) {
      return { kind: "dispatch", project: explicit, reason: "mentioned-project" };
    }

    const activeId = getChatProject(name, chatId);
    const active = activeId ? projectsNow.find(p => p.id === activeId) : null;
    if (active) return { kind: "dispatch", project: active, reason: "chat-active-project" };

    const configured = cfg.project_id ? projectsNow.find(p => p.id === cfg.project_id) : null;
    if (configured) return { kind: "dispatch", project: configured, reason: "configured-default" };

    const inbox = await ensureBrainstormProject();
    return { kind: "dispatch", project: inbox, reason: "brainstorm-inbox" };
  };

  // The shared message handler. A bridge calls this for each inbound message
  // (after its own allow-list gating + attachment download). chatId is a
  // string (numeric platform ids are stringified by the caller).
  const handleMessage = async (
    transport: BridgeTransport,
    cfg: BridgeConfigLite,
    chatId: string,
    text: string,
    attachments: Attachment[] = [],
  ) => {
    const name = transport.name;
    const route = await routeMessage(name, cfg, chatId, text);
    if (route.kind === "ping") {
      await send(transport, chatId, "OWLLM bridge is awake.");
      return;
    }
    if (route.kind === "list-projects") {
      const lines = projectsRef.current.slice(0, 20).map((p, i) => `${i + 1}. ${p.name}`);
      await send(transport, chatId, lines.length
        ? `Projects:\n${lines.join("\n")}\n\nUse /project <name> to choose one, /models to see model IDs, or /new <idea> to start brainstorming.`
        : "No projects yet. Send /new <idea> to start brainstorming.");
      return;
    }
    if (route.kind === "list-models") {
      const project = await currentProjectForChat(name, cfg, chatId);
      await send(transport, chatId, modelHelp(project.name));
      return;
    }
    if (route.kind === "set-model") {
      if (!route.modelId) {
        await send(transport, chatId, modelHelp(route.project.name));
        return;
      }
      const updated = await saveProjectModel(route.project.id, route.modelId);
      setChatProject(name, chatId, route.project.id);
      await send(transport, chatId,
        `Model associated with ${updated?.name ?? route.project.name}: ${route.modelId}`);
      return;
    }
    if (route.kind === "switch-project") {
      setChatProject(name, chatId, route.project.id);
      await send(transport, chatId, `Routing this chat to project: ${route.project.name}`);
      return;
    }
    if (route.kind === "new-brainstorm") {
      const np = await createProjectFromText(
        `Brainstorm - ${shortNameFromText(route.idea)}`,
        `Bridge brainstorm seed:\n${route.idea || "(empty)"}`,
      );
      setChatProject(name, chatId, np.id);
      await send(transport, chatId,
        `Created brainstorm project: ${np.name}\n\n${modelHelp(np.name)}`);
      return;
    }
    // route.kind === "dispatch" here. Deliberately NOT auto-pinning the chat to
    // this project. Auto-pinning made a stale per-chat mapping override the
    // user's configured default project (they pick RED in the UI but messages
    // keep routing to an old/auto project). The per-chat mapping is now set ONLY
    // by an explicit /project (switch), /new, or set-model command; otherwise
    // the configured default applies.
    const project = route.project;
    const projectId = project.id;

    // ---- 1. INBOUND VISIBLE IMMEDIATELY ----
    const attachTag = attachments.length > 0
      ? ` [+${attachments.filter(a => a.kind === "image").length}🖼 ${attachments.filter(a => a.kind === "audio").length}🎵]`
      : "";
    const inMsg: GoalMsg = { role: "you", color: "#9ad9ff", text: `📱 [${transport.tag}] ${text || "(media only)"}${attachTag}` };
    try {
      window.dispatchEvent(new CustomEvent("owllm:chat:appended", {
        detail: { projectId, messages: [inMsg], source: name },
      }));
    } catch {}
    if (projectId) await persistChat(projectId, [inMsg]);

    // ---- 2. Resolve team + history ----
    const team = resolveTeam(project);
    if (!team || team.agents.length === 0) {
      const note = "(no team configured for this project — set a team on the agentic tab)";
      await send(transport, chatId, note);
      const sysMsg: GoalMsg = { role: "system", color: "#ff8c8c", text: note };
      try {
        window.dispatchEvent(new CustomEvent("owllm:chat:appended", {
          detail: { projectId, messages: [sysMsg], source: name },
        }));
      } catch {}
      if (projectId) await persistChat(projectId, [sysMsg]);
      return;
    }

    let priorHistory = chatToHistory(
      (() => {
        try {
          if (!project?.chat_json) return [];
          const parsed = JSON.parse(project.chat_json);
          return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
      })()
    );

    const orch = findOrchestratorSpec(team);
    const orchName = orch?.name ?? "orchestrator";

    // Resolve the model the SAME way the desktop does: the orchestrator's
    // PER-AGENT override (set on the team card, stored per project in
    // localStorage) wins over the team default. The bridge used to read
    // team_default_model_id ONLY, so a per-agent model — e.g. a local gemma on
    // the orchestrator — was ignored: a Telegram message replied with the wrong
    // (team-default) model and never loaded gemma into RAM. That's bug #23.
    const orchOverride = (() => {
      try { return (localStorage.getItem(`owllm:agent-model:${projectId}:${orchName}`) || "").trim(); }
      catch { return ""; }
    })();
    const teamDefault = (project?.team_default_model_id || "").trim();
    const baseModel = orchOverride || teamDefault;
    if (!baseModel) {
      const note = modelHelp(project.name);
      await send(transport, chatId, note);
      const sysMsg: GoalMsg = { role: "system", color: "#ffd166", text: note };
      try {
        window.dispatchEvent(new CustomEvent("owllm:chat:appended", {
          detail: { projectId, messages: [sysMsg], source: name },
        }));
      } catch {}
      if (projectId) await persistChat(projectId, [sysMsg]);
      return;
    }
    const modelFor = (_agent: string) => baseModel;

    // ---- 2b. Lazy local-server start (local models only) ----
    const baseModelInfo = modelsRef.current.find(m => m.model_id === baseModel);
    const isLocalModel = !!baseModelInfo && (baseModelInfo.provider === "local" || baseModelInfo.provider === "tuned");
    if (isLocalModel) {
      const alreadyOk =
        serverRef.current.running &&
        serverRef.current.model_id === baseModel &&
        !!serverRef.current.port;
      if (!alreadyOk) {
        try {
          if (serverRef.current.running) await invoke("server_stop").catch(() => {});
          await invoke("server_start", { modelId: baseModel });
        } catch (e) {
          const msg = `(failed to start local model '${baseModel}': ${String((e as any)?.message ?? e)})`;
          await send(transport, chatId, msg);
          const sysMsg: GoalMsg = { role: "system", color: "#ff8c8c", text: msg };
          try {
            window.dispatchEvent(new CustomEvent("owllm:chat:appended", {
              detail: { projectId, messages: [sysMsg], source: name },
            }));
          } catch {}
          if (projectId) await persistChat(projectId, [sysMsg]);
          return;
        }
        const t0 = Date.now();
        let ready = false;
        while (Date.now() - t0 < 120_000) {
          try {
            const s = await invoke<ServerStatus>("server_status");
            if (s.running && s.model_id === baseModel && s.port) {
              (serverRef as any).current = s;
              ready = true;
              break;
            }
          } catch { /* ignore, retry */ }
          await new Promise(r => setTimeout(r, 500));
        }
        if (!ready) {
          const msg = `(local model '${baseModel}' did not become ready within 120 s — start it manually on the Server tab and retry)`;
          await send(transport, chatId, msg);
          const sysMsg: GoalMsg = { role: "system", color: "#ff8c8c", text: msg };
          try {
            window.dispatchEvent(new CustomEvent("owllm:chat:appended", {
              detail: { projectId, messages: [sysMsg], source: name },
            }));
          } catch {}
          if (projectId) await persistChat(projectId, [sysMsg]);
          return;
        }
      }
    }

    // ---- 3. Dispatch ----
    const projectCwd = (project?.location ?? "").trim();
    const auto = !!cfg.auto_approve;
    const isBrainstormProject =
      project.name === BRAINSTORM_PROJECT_NAME || project.name.startsWith("Brainstorm -");
    const goalForDispatch = isBrainstormProject
      ? [
          "You are OWLLM's global bridge brainstormer and project dispatcher.",
          "Brainstorm conversationally with the user before forming a team.",
          "Create or refine a compact project brief with goal, constraints, unknowns, risks, suggested team, and next milestone.",
          "Ask clarifying questions when the project is not ready.",
          "Use the Critical Thinker as an explicit reviewer: have them challenge assumptions, scope, and readiness before launch.",
          "",
          `User message: ${text || "(see attached media)"}`,
        ].join("\n")
      : text || "(see attached media)";

    let directives: any[] = [];
    let directorMode = false;
    try {
      const [list, mode] = await Promise.all([
        invoke<any[]>("directives_list", { projectId }),
        invoke<boolean>("project_get_director_mode", { projectId }),
      ]);
      directives = list;
      directorMode = mode;
    } catch (e) {
      console.warn("bridge: directives/director_mode load failed", e);
    }

    const fireAgentStart = (agent: string) => {
      try { window.dispatchEvent(new CustomEvent("owllm:agent:active", { detail: { agent, action: "start", projectId } })); } catch {}
    };
    const fireAgentEnd = (agent: string) => {
      try { window.dispatchEvent(new CustomEvent("owllm:agent:active", { detail: { agent, action: "end", projectId } })); } catch {}
    };
    const fireActiveClear = () => {
      try { window.dispatchEvent(new CustomEvent("owllm:agent:active", { detail: { agent: null, projectId } })); } catch {}
    };
    const fireThought = (agent: string, msg: GoalMsg) => {
      try { window.dispatchEvent(new CustomEvent("owllm:thought:appended", { detail: { projectId, agent, message: msg, source: name } })); } catch {}
    };
    const fireLog = (agent: string, msg: GoalMsg) => {
      try { window.dispatchEvent(new CustomEvent("owllm:log:appended", { detail: { projectId, agent, message: msg, source: name } })); } catch {}
    };
    const fireLogDelta = (agent: string, delta: string) => {
      try { window.dispatchEvent(new CustomEvent("owllm:log:delta", { detail: { projectId, agent, delta, source: name } })); } catch {}
    };

    let finalForBridge = "";

    try {
      const finalReply = await runDispatchLoop(
        {
          team,
          roleByName: roleByNameRef.current,
          goal: goalForDispatch,
          modelFor,
          models: modelsRef.current,
          port: serverRef.current.port ?? 0,
          projectCwd,
          projectId,
          history: priorHistory,
          autoApprove: auto,
          signal: new AbortController().signal,
          directives,
          directorMode,
          attachments: attachments.length > 0 ? attachments : undefined,
        },
        {
          onPhase: (_phase: DispatchPhase) => { /* could mirror to the bridge if chatty */ },
          onAgentStart: fireAgentStart,
          onAgentEnd: fireAgentEnd,
          onLog: fireLog,
          onLogDelta: fireLogDelta,
          onThought: fireThought,
          onThoughtDelta: (agent: string, channel: string, role: string, delta: string) => {
            try {
              window.dispatchEvent(new CustomEvent("owllm:thought:delta", {
                detail: { projectId, agent, channel, role, delta, source: name },
              }));
            } catch {}
          },
          onAgentReply: (agent: string, reply: string) => {
            const isOrch = agent === orchName;
            const msg: GoalMsg = {
              role: isOrch ? orchName : agent,
              color: isOrch ? "#ffd97a" : "#9ad9ff",
              text: reply,
            };
            try {
              window.dispatchEvent(new CustomEvent("owllm:chat:appended", {
                detail: { projectId, messages: [msg], source: name },
              }));
            } catch {}
            if (projectId) persistChat(projectId, [msg]).catch(() => {});
            if (isOrch) finalForBridge = reply;
          },
          onSystemWarning: (warning: string) => {
            const msg: GoalMsg = { role: "system", color: "#ffd97a", text: warning };
            try {
              window.dispatchEvent(new CustomEvent("owllm:chat:appended", {
                detail: { projectId, messages: [msg], source: name },
              }));
            } catch {}
            if (projectId) persistChat(projectId, [msg]).catch(() => {});
            send(transport, chatId, warning).catch(() => {});
          },
          onTranscript: (_filename: string, text: string) => {
            const msg: GoalMsg = { role: "you", color: "#9af0a8", text: `🎤 ${text}` };
            try {
              window.dispatchEvent(new CustomEvent("owllm:chat:appended", {
                detail: { projectId, messages: [msg], source: name },
              }));
            } catch {}
            if (projectId) persistChat(projectId, [msg]).catch(() => {});
          },
        }
      );
      finalForBridge = finalForBridge || finalReply;
    } catch (e: any) {
      const errMsg: GoalMsg = { role: "system", color: "#ff8c8c", text: `(dispatch error: ${String(e?.message ?? e)})` };
      try {
        window.dispatchEvent(new CustomEvent("owllm:chat:appended", {
          detail: { projectId, messages: [errMsg], source: name },
        }));
      } catch {}
      if (projectId) await persistChat(projectId, [errMsg]);
      await send(transport, chatId, errMsg.text);
      fireActiveClear();
      return;
    }

    // ---- 4. Send ONE summary message. ----
    const summary = finalForBridge.trim();
    if (summary) {
      const isQuestion = /\?\s*$/.test(summary) || /^❓/.test(summary);
      const prefix = isQuestion ? "❓" : "✅";
      await send(transport, chatId, `${prefix} ${summary}`);
    } else {
      await send(transport, chatId, "✅ Done.");
    }
    fireActiveClear();
  };

  return { handleMessage, modelChoices, getChatProject, setChatProject };
}

/// Desktop → bridge mirror. When AgentsPage fires a chat-appended event with
/// source==="desktop", forward assistant turns to every allowed chat whose
/// active project matches — so the phone/channel sees desktop sends too.
/// Generic across bridges; each runner calls this with its own transport+cfg.
export function useBridgeMirror(
  transport: BridgeTransport,
  cfg: BridgeConfigLite | null,
  started: boolean,
  rawSend: (chatId: string, text: string) => Promise<void>,
) {
  useEffect(() => {
    if (!started || !cfg) return;
    const allow = cfg.allowed;
    if (!allow || allow.length === 0) return;

    const handler = async (e: Event) => {
      const detail = (e as CustomEvent<{ projectId: string; messages: GoalMsg[]; source?: string }>).detail;
      if (!detail || detail.source !== "desktop") return;
      const msgs = Array.isArray(detail.messages) ? detail.messages : [];
      for (const m of msgs) {
        if (!m || !m.text || !m.text.trim()) continue;
        if (m.role === "you") continue;
        for (const chatId of allow) {
          const activeProjectId = getChatProject(transport.name, chatId) || cfg.project_id || "";
          if (detail.projectId !== activeProjectId) continue;
          for (const chunk of splitForLen(m.text, transport.maxLen)) {
            await rawSend(chatId, chunk);
          }
        }
      }
    };
    window.addEventListener("owllm:chat:appended", handler as EventListener);
    return () => window.removeEventListener("owllm:chat:appended", handler as EventListener);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, transport.name, cfg?.project_id, (cfg?.allowed ?? []).join(",")]);
}
