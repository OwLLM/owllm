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

  const handle = async (chatId: number, text: string, attachments: Attachment[] = []) => {
    const tgCfg = cfgRef.current;
    if (!tgCfg) return;
    const project = projectsRef.current.find(p => p.id === tgCfg.project_id) ?? null;
    const projectId = project?.id ?? tgCfg.project_id ?? "";

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

    // Model resolution — project default → server fallback → "local"
    const teamDefault = (project?.team_default_model_id || "").trim();
    const serverFallback = serverRef.current.model_id ?? "local";
    const baseModel = teamDefault || serverFallback;
    const modelFor = (_agent: string) => baseModel;

    // ---- 3. Hook events: every phase, dispatch, agent reply maps
    //         to a CustomEvent the agentic tab subscribes to. The
    //         persisted chat_json gets the user-facing turns only.
    const projectCwd = (project?.location ?? "").trim();
    const auto = !!tgCfg.auto_approve;

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
          goal: text || "(see attached media)",
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
          // Mirror to the SuperUserCard chat AND to Telegram so the
          // phone sees each agent talking, matching legacy chatty mode.
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
            // Phone mirror: prefix the agent's display name so the user
            // can tell who's talking even when 3+ specialists chime in.
            sendTelegram(tgCfg.bot_token, chatId, `💬 ${displayLabel(agent)}: ${reply}`);
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

    // ---- 4. Wrap with the legacy "✅ Done." sentinel so the user
    //         knows the run finished, not that the assistant is
    //         still streaming.
    if (finalForTelegram.trim()) {
      await sendTelegram(tgCfg.bot_token, chatId, `✅ Done.\n\n${finalForTelegram}`);
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
      if (detail.projectId !== cfg.project_id) return;
      const msgs = Array.isArray(detail.messages) ? detail.messages : [];
      for (const m of msgs) {
        if (!m || !m.text || !m.text.trim()) continue;
        if (m.role === "you") continue;
        for (const chatId of allow) {
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
