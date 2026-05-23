// TelegramBridgeRunner — top-level long-poll bridge.
//
// Lives directly inside AppShell so the loop survives page navigation;
// AgentsPage used to host it, but the bridge died the moment the user
// clicked away to another tab. Polls Telegram with `getUpdates?timeout=20`,
// gates inbound messages on the persisted `owllm:telegram:started`
// flag (toggled by BridgesPage Start/Stop), matches them against the
// saved allowed_chat_ids, and dispatches each text through the same
// orchestrator → specialists → integrate loop the desktop Run button
// drives. Each phase pushes events the agentic tab can pick up live,
// AND streams each agent's reply back to Telegram so the user sees
// the team work on their phone the same way they would on the canvas.

import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  GoalMsg, ModelInfo, ServerStatus, Team, RoleData,
  ProjectRow, TeamTemplateBackend, AgentRoleBackend,
  toTeam, projectToTeam, rolesFromBackend,
  chatToHistory, findOrchestratorSpec, displayLabel,
  runDispatchLoop, DispatchPhase,
  type Attachment,
} from "../pages/agentic/dispatch";

/// Shape returned by the Rust telegram_download_file command. Mirrors
/// telegram::TelegramFileDownload on the Rust side.
type TelegramFileDownload = { mime: string; data_b64: string; size: number };

/// Pick the largest photo size Telegram offered and resolve it to an
/// Attachment by downloading the bytes. Returns null on failure so a
/// busted attachment doesn't blow up the whole inbound message.
async function downloadPhoto(token: string, photos: Array<{ file_id: string; file_size?: number }>): Promise<Attachment | null> {
  if (!photos.length) return null;
  const sorted = [...photos].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0));
  const pick = sorted[0];
  try {
    const dl = await invoke<TelegramFileDownload>("telegram_download_file", { token, fileId: pick.file_id, expectedMime: null });
    return { kind: "image", mime: dl.mime, data_b64: dl.data_b64, filename: `photo.${dl.mime.split("/")[1] || "jpg"}` };
  } catch (e) {
    console.error("[telegram] photo download failed", e);
    return null;
  }
}

/// Download an audio-like attachment (voice / audio / audio document).
async function downloadAudio(token: string, fileId: string, mimeHint: string | null, filename?: string): Promise<Attachment | null> {
  try {
    const dl = await invoke<TelegramFileDownload>("telegram_download_file", { token, fileId, expectedMime: mimeHint });
    return { kind: "audio", mime: dl.mime, data_b64: dl.data_b64, filename: filename ?? `audio.${dl.mime.split("/")[1] || "ogg"}` };
  } catch (e) {
    console.error("[telegram] audio download failed", e);
    return null;
  }
}

/// Download an image-as-document. We only call this when mime_type
/// starts with "image/" — Telegram routes original-quality photos here
/// instead of `photo` to skip its server-side compression.
async function downloadImageDocument(token: string, fileId: string, mime: string, filename?: string): Promise<Attachment | null> {
  try {
    const dl = await invoke<TelegramFileDownload>("telegram_download_file", { token, fileId, expectedMime: mime });
    return { kind: "image", mime: dl.mime, data_b64: dl.data_b64, filename: filename ?? `image.${dl.mime.split("/")[1] || "bin"}` };
  } catch (e) {
    console.error("[telegram] document download failed", e);
    return null;
  }
}

const STARTED_KEY = "owllm:telegram:started";

type TelegramConfig = {
  bot_token: string;
  allowed_chat_ids: number[];
  project_id: string;
  auto_approve: boolean;
};
type BridgeConfigs = { telegram: TelegramConfig; whatsapp: unknown };

const BRAINSTORM_PROJECT_NAME = "Telegram Brainstorm Inbox";

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
  return words.length ? words.join(" ") : "Telegram idea";
}

function chatProjectKey(chatId: number): string {
  return `owllm:telegram:active-project:${chatId}`;
}

function getChatProject(chatId: number): string {
  try { return localStorage.getItem(chatProjectKey(chatId)) || ""; } catch { return ""; }
}

function setChatProject(chatId: number, projectId: string) {
  try { localStorage.setItem(chatProjectKey(chatId), projectId); } catch {}
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

type RouteDecision =
  | { kind: "ping" }
  | { kind: "list-projects" }
  | { kind: "list-models" }
  | { kind: "set-model"; project: ProjectRow; modelId: string }
  | { kind: "switch-project"; project: ProjectRow }
  | { kind: "new-brainstorm"; idea: string }
  | { kind: "dispatch"; project: ProjectRow; reason: string };

export default function TelegramBridgeRunner() {
  const [started, setStarted] = useState<boolean>(() => {
    try { return localStorage.getItem(STARTED_KEY) === "1"; } catch { return false; }
  });
  const [cfg, setCfg] = useState<TelegramConfig | null>(null);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [server, setServer] = useState<ServerStatus>({ running: false, model_id: null, port: null });
  const [teams, setTeams] = useState<Team[]>([]);
  const [roleByName, setRoleByName] = useState<Map<string, RoleData>>(new Map());

  const projectsRef = useRef(projects); projectsRef.current = projects;
  const modelsRef = useRef(models); modelsRef.current = models;
  const serverRef = useRef(server); serverRef.current = server;
  const teamsRef = useRef(teams); teamsRef.current = teams;
  const roleByNameRef = useRef(roleByName); roleByNameRef.current = roleByName;
  const cfgRef = useRef(cfg); cfgRef.current = cfg;

  useEffect(() => {
    const onStatus = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const running = detail === "running";
      setStarted(running);
      if (running) {
        invoke<BridgeConfigs>("load_bridge_configs").then(c => setCfg(c.telegram)).catch(() => {});
      }
    };
    window.addEventListener("owllm:telegram:status", onStatus as EventListener);
    return () => window.removeEventListener("owllm:telegram:status", onStatus as EventListener);
  }, []);

  // Belt-and-suspenders sync: the Bridges page persists the start flag
  // in localStorage, but a same-window event can be missed during hot
  // reloads, remounts, or early startup. Poll the persisted flag and
  // config so the runner cannot look "running" in UI while asleep.
  useEffect(() => {
    const sync = () => {
      let running = false;
      try { running = localStorage.getItem(STARTED_KEY) === "1"; } catch {}
      setStarted(running);
      if (running) {
        invoke<BridgeConfigs>("load_bridge_configs")
          .then(c => setCfg(c.telegram))
          .catch(e => console.error("[telegram] config sync failed", e));
      }
    };
    sync();
    const id = window.setInterval(sync, 2000);
    return () => window.clearInterval(id);
  }, []);

  // Initial config + auxiliary data load on mount.
  useEffect(() => {
    invoke<BridgeConfigs>("load_bridge_configs").then(c => setCfg(c.telegram)).catch(() => {});
    invoke<ProjectRow[]>("list_projects").then(setProjects).catch(() => {});
    invoke<ModelInfo[]>("list_models").then(setModels).catch(() => {});
    invoke<TeamTemplateBackend[]>("list_team_templates").then(rows => setTeams(rows.map(toTeam))).catch(() => {});
    invoke<AgentRoleBackend[]>("list_agent_roles").then(rows => setRoleByName(rolesFromBackend(rows))).catch(() => {});
  }, []);

  // Periodic refresh — server status + projects so the bridge sees a
  // freshly-created project and so the merge below reads up-to-date
  // chat_json even when the desktop's been writing in parallel.
  useEffect(() => {
    const tick = async () => {
      try { setServer(await invoke<ServerStatus>("server_status")); } catch {}
      try { setProjects(await invoke<ProjectRow[]>("list_projects")); } catch {}
    };
    tick();
    const id = window.setInterval(tick, 5000);
    return () => window.clearInterval(id);
  }, []);

  // ---- Telegram helpers (HTTP via Rust, bypasses webview CORS) ----
  const sendTelegram = async (token: string, chatId: number, body: string) => {
    if (!body || !body.trim()) return;
    try {
      await invoke("telegram_send_message", { token, chatId, text: body });
    } catch (e) {
      console.error("telegram_send_message failed", e);
    }
  };

  // Atomic merge — read fresh chat_json from DB, append, write back.
  // The stale-cache version overwrote concurrent desktop edits, which
  // was the "history disappears until reply arrives" bug.
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
      console.error("[telegram] persistChat failed", e);
    }
  };

  // Resolve the team for the bridge: prefer the project's own roster,
  // fall back to the first template so the bridge still works on an
  // empty project.
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
        name,
        description,
        location: "",
        team,
        graph_json: "",
        team_default_model_id: "",
        trust_writes: false,
        auto_approve_all: false,
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
      "Global Telegram inbox for brainstorming, project discovery, and dispatch routing before a dedicated project exists.",
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

  const currentProjectForChat = async (chatId: number): Promise<ProjectRow> => {
    const projectsNow = projectsRef.current;
    const activeId = getChatProject(chatId);
    const active = activeId ? projectsNow.find(p => p.id === activeId) : null;
    if (active) return active;
    const configured = cfgRef.current?.project_id
      ? projectsNow.find(p => p.id === cfgRef.current?.project_id)
      : null;
    if (configured) return configured;
    return ensureBrainstormProject();
  };

  const usableModelIds = (): string[] => {
    const local = modelsRef.current
      .filter(m => (m.provider === "local" || m.provider === "tuned") && m.port != null)
      .map(m => m.model_id);
    return [
      ...local,
      "sub/claude-opus-4-5-20251101:high",
      "sub/gpt-5.5:high",
      "api/gpt-5.5",
    ];
  };

  const modelHelp = (projectName?: string): string => {
    const ids = usableModelIds().slice(0, 15);
    const target = projectName ? ` for "${projectName}"` : "";
    const choices = ids.length
      ? ids.map((id, i) => `${i + 1}. ${id}`).join("\n")
      : "(no local models detected yet)";
    return [
      `Choose a model${target} before the agents can run.`,
      "",
      choices,
      "",
      "Reply with:",
      "/model <model-id>",
      "",
      "You can also set the team model in the Agentic Team page.",
    ].join("\n");
  };

  const normalizeModelId = (text: string): string => {
    const raw = text.trim();
    if (!raw) return "";
    const exact = usableModelIds().find(id => id.toLowerCase() === raw.toLowerCase());
    if (exact) return exact;
    const byBare = usableModelIds().find(id => norm(id).includes(norm(raw)));
    return byBare || raw;
  };

  const saveProjectModel = async (projectId: string, modelId: string): Promise<ProjectRow | null> => {
    await invoke("update_project", { input: { id: projectId, team_default_model_id: modelId } });
    const rows = await refreshProjects().catch(() => projectsRef.current);
    return rows.find(p => p.id === projectId) ?? null;
  };

  const routeTelegram = async (chatId: number, text: string): Promise<RouteDecision> => {
    const trimmed = text.trim();
    const projectsNow = projectsRef.current;
    if (/^\/ping\b/i.test(trimmed)) return { kind: "ping" };
    if (/^\/projects\b/i.test(trimmed)) return { kind: "list-projects" };
    if (/^\/models\b/i.test(trimmed)) return { kind: "list-models" };

    const modelMatch = trimmed.match(/^\/model\s+(.+)$/i)
      ?? trimmed.match(/^model\s*:\s*(.+)$/i);
    if (modelMatch) {
      const project = await currentProjectForChat(chatId);
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

    const activeId = getChatProject(chatId);
    const active = activeId ? projectsNow.find(p => p.id === activeId) : null;
    if (active) return { kind: "dispatch", project: active, reason: "chat-active-project" };

    const configured = cfgRef.current?.project_id
      ? projectsNow.find(p => p.id === cfgRef.current?.project_id)
      : null;
    if (configured) return { kind: "dispatch", project: configured, reason: "configured-default" };

    const inbox = await ensureBrainstormProject();
    return { kind: "dispatch", project: inbox, reason: "brainstorm-inbox" };
  };

  const handle = async (chatId: number, text: string, attachments: Attachment[] = []) => {
    const tgCfg = cfgRef.current;
    if (!tgCfg) return;
    const route = await routeTelegram(chatId, text);
    if (route.kind === "ping") {
      await sendTelegram(tgCfg.bot_token, chatId, "OWLLM bridge is awake.");
      return;
    }
    if (route.kind === "list-projects") {
      const lines = projectsRef.current.slice(0, 20).map((p, i) => `${i + 1}. ${p.name}`);
      await sendTelegram(tgCfg.bot_token, chatId, lines.length
        ? `Projects:\n${lines.join("\n")}\n\nUse /project <name> to choose one, /models to see model IDs, or /new <idea> to start brainstorming.`
        : "No projects yet. Send /new <idea> to start brainstorming.");
      return;
    }
    if (route.kind === "list-models") {
      const project = await currentProjectForChat(chatId);
      await sendTelegram(tgCfg.bot_token, chatId, modelHelp(project.name));
      return;
    }
    if (route.kind === "set-model") {
      if (!route.modelId) {
        await sendTelegram(tgCfg.bot_token, chatId, modelHelp(route.project.name));
        return;
      }
      const updated = await saveProjectModel(route.project.id, route.modelId);
      setChatProject(chatId, route.project.id);
      await sendTelegram(tgCfg.bot_token, chatId,
        `Model associated with ${updated?.name ?? route.project.name}: ${route.modelId}`);
      return;
    }
    if (route.kind === "switch-project") {
      setChatProject(chatId, route.project.id);
      await sendTelegram(tgCfg.bot_token, chatId, `Routing this chat to project: ${route.project.name}`);
      return;
    }
    let project = route.project;
    if (route.kind === "new-brainstorm") {
      project = await createProjectFromText(
        `Brainstorm - ${shortNameFromText(route.idea)}`,
        `Telegram brainstorm seed:\n${route.idea || "(empty)"}`,
      );
      setChatProject(chatId, project.id);
      await sendTelegram(tgCfg.bot_token, chatId,
        `Created brainstorm project: ${project.name}\n\n${modelHelp(project.name)}`);
      return;
    } else {
      setChatProject(chatId, project.id);
    }
    const projectId = project.id;

    // ---- 1. INBOUND VISIBLE IMMEDIATELY ----
    // Fire the chat-append event right when the message arrives so
    // the agentic tab shows the user's prompt instantly — not after
    // the 30 s the orchestrator takes to think. Tag the chip count
    // so the canvas reader knows media rode in too.
    const attachTag = attachments.length > 0
      ? ` [+${attachments.filter(a => a.kind === "image").length}🖼 ${attachments.filter(a => a.kind === "audio").length}🎵]`
      : "";
    const inMsg: GoalMsg = { role: "you", color: "#9ad9ff", text: `📱 [TG] ${text || "(media only)"}${attachTag}` };
    try {
      window.dispatchEvent(new CustomEvent("owllm:chat:appended", {
        detail: { projectId, messages: [inMsg], source: "telegram" },
      }));
    } catch {}
    if (projectId) {
      // Persist the inbound on its own (atomic merge) so even if the
      // dispatch crashes the message survives.
      await persistChat(projectId, [inMsg]);
    }

    // ---- 2. Resolve team + history + dispatch ----
    const team = resolveTeam(project);
    if (!team || team.agents.length === 0) {
      const note = "(no team configured for this project — set a team on the agentic tab)";
      await sendTelegram(tgCfg.bot_token, chatId, note);
      const sysMsg: GoalMsg = { role: "system", color: "#ff8c8c", text: note };
      try {
        window.dispatchEvent(new CustomEvent("owllm:chat:appended", {
          detail: { projectId, messages: [sysMsg], source: "telegram" },
        }));
      } catch {}
      if (projectId) await persistChat(projectId, [sysMsg]);
      return;
    }

    // Build the prior history from the project's persisted chat
    // transcript so the bot has memory across app restarts.
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

    // Model resolution — Telegram-created projects must get an
    // explicit team default before dispatch. Falling back to "local"
    // made fresh agent teams look valid while they had no runnable model.
    const teamDefault = (project?.team_default_model_id || "").trim();
    if (!teamDefault) {
      const note = modelHelp(project.name);
      await sendTelegram(tgCfg.bot_token, chatId, note);
      const sysMsg: GoalMsg = { role: "system", color: "#ffd166", text: note };
      try {
        window.dispatchEvent(new CustomEvent("owllm:chat:appended", {
          detail: { projectId, messages: [sysMsg], source: "telegram" },
        }));
      } catch {}
      if (projectId) await persistChat(projectId, [sysMsg]);
      return;
    }
    const baseModel = teamDefault;
    const modelFor = (_agent: string) => baseModel;

    // ---- 3. Hook events: every phase, dispatch, agent reply maps
    //         to a CustomEvent the agentic tab subscribes to. The
    //         persisted chat_json gets the user-facing turns only.
    const projectCwd = (project?.location ?? "").trim();
    const auto = !!tgCfg.auto_approve;
    const isBrainstormProject =
      project.name === BRAINSTORM_PROJECT_NAME || project.name.startsWith("Brainstorm -");
    const goalForDispatch = isBrainstormProject
      ? [
          "You are OWLLM's global Telegram brainstormer and project dispatcher.",
          "Brainstorm conversationally with the user before forming a team.",
          "Create or refine a compact project brief with goal, constraints, unknowns, risks, suggested team, and next milestone.",
          "Ask clarifying questions when the project is not ready.",
          "Use the Critical Thinker as an explicit reviewer: have them challenge assumptions, scope, and readiness before launch.",
          "",
          `User Telegram message: ${text || "(see attached media)"}`,
        ].join("\n")
      : text || "(see attached media)";

    // Load directives + director_mode fresh per dispatch so changes
    // made in the desktop DirectivesPanel take effect on the very next
    // Telegram message without restarting the bridge. Both fetches are
    // cheap (single SQLite query each) so per-dispatch is fine for v1.
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

    // Multi-active aware. Bridge runs specialists in PARALLEL during
    // phase 2 of the dispatch loop, so the canvas needs to track each
    // agent individually. Pair-matched start/end events let the
    // listener maintain a Set<active>.
    const fireAgentStart = (agent: string) => {
      try {
        window.dispatchEvent(new CustomEvent("owllm:agent:active", {
          detail: { agent, action: "start", projectId },
        }));
      } catch {}
    };
    const fireAgentEnd = (agent: string) => {
      try {
        window.dispatchEvent(new CustomEvent("owllm:agent:active", {
          detail: { agent, action: "end", projectId },
        }));
      } catch {}
    };
    const fireActiveClear = () => {
      try {
        window.dispatchEvent(new CustomEvent("owllm:agent:active", {
          detail: { agent: null, projectId },
        }));
      } catch {}
    };
    const fireThought = (agent: string, msg: GoalMsg) => {
      try {
        window.dispatchEvent(new CustomEvent("owllm:thought:appended", {
          detail: { projectId, agent, message: msg, source: "telegram" },
        }));
      } catch {}
    };
    const fireLog = (agent: string, msg: GoalMsg) => {
      try {
        window.dispatchEvent(new CustomEvent("owllm:log:appended", {
          detail: { projectId, agent, message: msg, source: "telegram" },
        }));
      } catch {}
    };
    const fireLogDelta = (agent: string, delta: string) => {
      try {
        window.dispatchEvent(new CustomEvent("owllm:log:delta", {
          detail: { projectId, agent, delta, source: "telegram" },
        }));
      } catch {}
    };

    // Track the final orchestrator reply so we can send a clean wrap
    // to Telegram once the dispatch finishes (the legacy bridge
    // sent "✅ Done.\n\n<final>" — we match that vocabulary).
    let finalForTelegram = "";

    try {
      const finalReply = await runDispatchLoop(
        {
          team,
          roleByName: roleByNameRef.current,
          // Empty text + media-only message: substitute a minimal goal
          // so the orchestrator still has something to plan against.
          // Without this the model sees "" and refuses to act.
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
          onPhase: (_phase: DispatchPhase) => { /* could mirror to Telegram if chatty */ },
          onAgentStart: fireAgentStart,
          onAgentEnd: fireAgentEnd,
          onLog: fireLog,
          onLogDelta: fireLogDelta,
          onThought: fireThought,
          // Streaming thought / tool-call channel — fire the same window
          // event the desktop AgentsPage listens on. Frontend consumer
          // keeps a per-(agent,channel) cursor and appends in place.
          onThoughtDelta: (agent: string, channel: string, role: string, delta: string) => {
            try {
              window.dispatchEvent(new CustomEvent("owllm:thought:delta", {
                detail: { projectId, agent, channel, role, delta, source: "telegram" },
              }));
            } catch {}
          },
          // Every full reply from an agent (orchestrator's plan, each
          // specialist's answer, the integrated final) lands here.
          // We mirror to the SuperUserCard chat (the desktop canvas
          // still shows every agent talking) but DO NOT push to
          // Telegram per-agent — the user wants ONE clean message on
          // their phone, not a stream of mid-stream replies that get
          // rate-limited and arrive as half-messages. The final
          // orchestrator reply is captured here and sent ONCE below
          // in the "✅ Done." wrap.
          onAgentReply: (agent: string, reply: string) => {
            const isOrch = agent === orchName;
            const msg: GoalMsg = {
              role: isOrch ? orchName : agent,
              color: isOrch ? "#ffd97a" : "#9ad9ff",
              text: reply,
            };
            try {
              window.dispatchEvent(new CustomEvent("owllm:chat:appended", {
                detail: { projectId, messages: [msg], source: "telegram" },
              }));
            } catch {}
            if (projectId) {
              // Fire and forget — persist serially in the background
              // so the dispatch doesn't block on SQLite round-trips.
              persistChat(projectId, [msg]).catch(() => {});
            }
            // Capture the orchestrator's last reply so we know what to
            // send. Specialists are not relayed to the phone.
            if (isOrch) finalForTelegram = reply;
          },
        }
      );
      finalForTelegram = finalForTelegram || finalReply;
    } catch (e: any) {
      const errMsg: GoalMsg = {
        role: "system",
        color: "#ff8c8c",
        text: `(dispatch error: ${String(e?.message ?? e)})`,
      };
      try {
        window.dispatchEvent(new CustomEvent("owllm:chat:appended", {
          detail: { projectId, messages: [errMsg], source: "telegram" },
        }));
      } catch {}
      if (projectId) await persistChat(projectId, [errMsg]);
      await sendTelegram(tgCfg.bot_token, chatId, errMsg.text);
      fireActiveClear();
      return;
    }

    // ---- 4. Send ONE summary message. If the orchestrator embedded a
    //         clarifying question (director mode), prefix with "❓"
    //         so the user knows they need to answer. Otherwise just
    //         the final synthesis.
    const summary = finalForTelegram.trim();
    if (summary) {
      const isQuestion = /\?\s*$/.test(summary) || /^❓/.test(summary);
      const prefix = isQuestion ? "❓" : "✅";
      await sendTelegram(tgCfg.bot_token, chatId, `${prefix} ${summary}`);
    } else {
      await sendTelegram(tgCfg.bot_token, chatId, "✅ Done.");
    }
    fireActiveClear();
  };

  // ---- 5. Long-poll loop itself — gated on started + valid cfg ----
  //
  // Message handling is strictly SERIAL: a chained handlerQueue
  // promise ensures only one dispatch runs at a time, even when the
  // user fires several messages in quick succession. Parallel
  // handle() calls would each spawn their own `claude --print`
  // subprocess (the user reported the app "crashed while coding" —
  // we suspect resource exhaustion from N concurrent CLI children
  // each doing heavy file IO under --permission-mode bypassPermissions).
  // Telegram's getUpdates queues server-side, so we don't lose any
  // inbound by serializing.
  useEffect(() => {
    if (!started) return;
    if (!cfg?.bot_token) return;

    let dead = false;
    let offset = 0;
    let handlerQueue: Promise<void> = Promise.resolve();
    const sleep = (ms: number) => new Promise(r => window.setTimeout(r, ms));

    (async () => {
      while (!dead) {
        try {
          const updates: Array<any> = await invoke("telegram_get_updates", {
            token: cfg.bot_token,
            offset,
            timeout: 20,
          });
          if (dead) return;
          for (const upd of (updates || [])) {
            if (typeof upd.update_id === "number") {
              offset = Math.max(offset, upd.update_id + 1);
            }
            const msg = upd.message;
            const chatId: number | undefined = msg?.chat?.id;
            if (typeof chatId !== "number") continue;
            const allow = Array.isArray(cfg.allowed_chat_ids) ? cfg.allowed_chat_ids : [];
            if (allow.length > 0 && !allow.includes(chatId)) {
              console.warn(`[telegram] chat ${chatId} not on allow-list — ignored.`);
              continue;
            }
            // Accept either text OR media. `text` is the plain-message
            // field; `caption` rides alongside photo/voice/document.
            // Drop only when there's truly nothing actionable.
            const text: string = msg?.text || msg?.caption || "";
            const hasPhoto = Array.isArray(msg?.photo) && msg.photo.length > 0;
            const hasVoice = !!msg?.voice?.file_id;
            const hasAudio = !!msg?.audio?.file_id;
            const docMime: string = msg?.document?.mime_type || "";
            const docIsImage = !!msg?.document?.file_id && docMime.startsWith("image/");
            const docIsAudio = !!msg?.document?.file_id && docMime.startsWith("audio/");
            const hasMedia = hasPhoto || hasVoice || hasAudio || docIsImage || docIsAudio;
            if (!text && !hasMedia) continue;
            console.log(`[telegram] inbound from ${chatId}: text="${text.slice(0, 60)}" photo=${hasPhoto} voice=${hasVoice} audio=${hasAudio} doc=${docMime || "-"}`);
            const immediateCommand = !hasMedia && /^\/(?:ping|projects|project|use|switch|models|model)\b/i.test(text.trim());

            // Snapshot the file_ids + mime hints NOW (msg ref will be
            // out of scope by the time the queued task runs). Downloads
            // themselves happen inside the queued task so they're
            // serialized too — keeps Telegram from rate-limiting and
            // matches the existing "one dispatch at a time" semantics.
            const photoArr = hasPhoto ? msg.photo : [];
            const voiceId = hasVoice ? msg.voice.file_id : null;
            const voiceMime = hasVoice ? (msg.voice.mime_type || null) : null;
            const audioId = hasAudio ? msg.audio.file_id : null;
            const audioMime = hasAudio ? (msg.audio.mime_type || null) : null;
            const audioName = hasAudio ? (msg.audio.file_name || undefined) : undefined;
            const docId = (docIsImage || docIsAudio) ? msg.document.file_id : null;
            const docName = (docIsImage || docIsAudio) ? (msg.document.file_name || undefined) : undefined;

            if (immediateCommand) {
              handle(chatId, text, []).catch(e => console.error("[telegram] command failed", e));
              continue;
            }

            handlerQueue = handlerQueue
              .then(async () => {
                const attachments: Attachment[] = [];
                if (photoArr.length > 0) {
                  const a = await downloadPhoto(cfg.bot_token, photoArr);
                  if (a) attachments.push(a);
                }
                if (voiceId) {
                  const a = await downloadAudio(cfg.bot_token, voiceId, voiceMime, "voice.ogg");
                  if (a) attachments.push(a);
                }
                if (audioId) {
                  const a = await downloadAudio(cfg.bot_token, audioId, audioMime, audioName);
                  if (a) attachments.push(a);
                }
                if (docId && docIsImage) {
                  const a = await downloadImageDocument(cfg.bot_token, docId, docMime, docName);
                  if (a) attachments.push(a);
                }
                if (docId && docIsAudio) {
                  const a = await downloadAudio(cfg.bot_token, docId, docMime, docName);
                  if (a) attachments.push(a);
                }
                await handle(chatId, text, attachments);
              })
              .catch(e => console.error("[telegram] handle failed", e));
          }
        } catch (e: any) {
          console.error("[telegram] poll loop error", e);
          if (dead) return;
          await sleep(5000);
        }
      }
    })();

    console.log(`[telegram] bridge polling started for token …${cfg.bot_token.slice(-6)} project=${cfg.project_id || "(any)"}`);
    return () => {
      dead = true;
      console.log("[telegram] bridge polling stopped");
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, cfg?.bot_token, cfg?.project_id, (cfg?.allowed_chat_ids ?? []).join(",")]);

  // ---- 6. Desktop → Telegram mirror — when AgentsPage fires a
  //         chat-appended event with source=desktop, forward
  //         assistant turns to every allowed chat so the phone sees
  //         desktop sends too.
  useEffect(() => {
    if (!started) return;
    if (!cfg?.bot_token) return;
    const allow = Array.isArray(cfg.allowed_chat_ids) ? cfg.allowed_chat_ids : [];
    if (allow.length === 0) return;

    const handler = async (e: Event) => {
      const detail = (e as CustomEvent<{ projectId: string; messages: GoalMsg[]; source?: string }>).detail;
      if (!detail || detail.source !== "desktop") return;
      const msgs = Array.isArray(detail.messages) ? detail.messages : [];
      for (const m of msgs) {
        if (!m || !m.text || !m.text.trim()) continue;
        if (m.role === "you") continue;
        for (const chatId of allow) {
          const activeProjectId = getChatProject(chatId) || cfg.project_id || "";
          if (detail.projectId !== activeProjectId) continue;
          await sendTelegram(cfg.bot_token, chatId, m.text);
        }
      }
    };
    window.addEventListener("owllm:chat:appended", handler as EventListener);
    return () => window.removeEventListener("owllm:chat:appended", handler as EventListener);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, cfg?.bot_token, cfg?.project_id, (cfg?.allowed_chat_ids ?? []).join(",")]);

  return null;
}
