// TelegramBridgeRunner — top-level long-poll bridge.
//
// Lives directly inside AppShell so the loop survives page navigation;
// AgentsPage used to host it, but the bridge would silently die the
// moment the user clicked away to another tab. Polls Telegram with
// `getUpdates?timeout=20`, gates inbound messages on the persisted
// `owllm:telegram:started` flag (toggled by BridgesPage's Start/Stop),
// matches them against the saved allowed_chat_ids, and forwards each
// text to the bound project's team-default model. The reply travels
// back via /sendMessage so the user's phone sees the answer.
//
// The bridge is deliberately simple: one shot of streamChatCompletion
// per inbound message, no full orchestrator dispatch graph. The team's
// `team_default_model_id` decides the provider (local llama-server,
// Anthropic API, Anthropic CLI subscription, OpenAI). If that field is
// blank we fall back to whatever's running on the local server.

import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const STARTED_KEY = "owllm:telegram:started";

type TelegramConfig = {
  bot_token: string;
  allowed_chat_ids: number[];
  project_id: string;
  auto_approve: boolean;
};
type BridgeConfigs = { telegram: TelegramConfig; whatsapp: unknown };

type ProjectRow = {
  id: string;
  name: string;
  team_default_model_id: string;
  /// Project working directory — fed into claude_cli_complete so the
  /// Claude Code CLI runs against the user's chosen repo, not the
  /// desktop app's install dir.
  location: string;
  /// Existing SuperUser transcript — runner reads this to merge new
  /// Telegram-driven messages, then writes back via update_project so
  /// the agentic tab's history stays consistent.
  chat_json: string;
};

type GoalMsg = { role: string; color: string; text: string };
type ModelInfo = {
  model_id: string;
  provider: string; // "local" | "anthropic" | "openai"
};
type ServerStatus = {
  running: boolean;
  model_id: string | null;
  port: number | null;
};

// --- Provider routing copied from AgentsPage; the bridge runs without
//     access to that file's local helpers, so it duplicates the small
//     amount of logic it needs. The "sub/" prefix on cloud model ids
//     forces the Claude CLI subscription path (free-with-claude-subscribe).
function stripPrefix(id: string): string {
  for (const p of ["sub/", "api/", "auto/"]) if (id.startsWith(p)) return id.slice(p.length);
  return id;
}
function providerFor(modelId: string, models: ModelInfo[]): string {
  if (!modelId) return "local";
  if (modelId.startsWith("auto/")) return "auto";
  const bare = stripPrefix(modelId);
  if (modelId.startsWith("sub/") || modelId.startsWith("api/")) {
    if (bare.startsWith("claude-")) return "anthropic";
    if (bare.startsWith("gpt-") || bare === "o3") return "openai";
  }
  const m = models.find(x => x.model_id === bare);
  return m?.provider || "local";
}

type HistoryItem = { role: "user" | "assistant"; content: string };

// Convert the persisted GoalMsg transcript into the alternating
// user/assistant turns the model APIs expect. System/error/dispatch
// rows are excluded.
function chatToHistory(chat: GoalMsg[]): HistoryItem[] {
  const out: HistoryItem[] = [];
  for (const m of chat) {
    if (!m || typeof m.text !== "string" || !m.text.trim()) continue;
    if (m.role === "system" || m.role === "error" || m.role === "dispatch") continue;
    out.push({ role: m.role === "you" ? "user" : "assistant", content: m.text });
  }
  return out;
}

// Claude --print is one-shot — no memory across calls. Fold the prior
// turns into the user prompt so the CLI sees the full thread.
function foldHistoryIntoPrompt(userMessage: string, history: HistoryItem[]): string {
  if (history.length === 0) return userMessage;
  const lines: string[] = ["--- Previous conversation ---"];
  for (const h of history) {
    lines.push(`${h.role === "user" ? "User" : "Assistant"}: ${h.content}`);
    lines.push("");
  }
  lines.push("--- Current user message ---");
  lines.push(userMessage);
  return lines.join("\n");
}

async function streamOnce(
  modelId: string,
  systemPrompt: string,
  userMessage: string,
  models: ModelInfo[],
  server: ServerStatus,
  signal: AbortSignal,
  cwd: string,
  history: HistoryItem[],
  autoApprove: boolean,
): Promise<string> {
  const provider = providerFor(modelId, models);
  const forceSub = modelId.startsWith("sub/");
  const forceApi = modelId.startsWith("api/");
  const bareId = forceSub || forceApi || modelId.startsWith("auto/") ? stripPrefix(modelId) : modelId;
  const cliPrompt = foldHistoryIntoPrompt(userMessage, history);

  if (provider === "anthropic") {
    // Subscription path: shell out to claude-code CLI.
    if (forceSub) {
      const status = await invoke<{ claude_cli: boolean }>("accounts_status");
      if (!status?.claude_cli) throw new Error("Claude Code CLI not detected — run `claude /login` first.");
      return await invoke<string>("claude_cli_complete", { systemPrompt, userMessage: cliPrompt, cwd: cwd || null, autoApprove });
    }
    const key = await invoke<string | null>("accounts_get_secret", { name: "ANTHROPIC_API_KEY" });
    if (!key) {
      if (forceApi) throw new Error("No ANTHROPIC_API_KEY saved — set it on the Accounts page.");
      // Default: prefer CLI if available.
      try {
        const status = await invoke<{ claude_cli: boolean }>("accounts_status");
        if (status?.claude_cli) {
          return await invoke<string>("claude_cli_complete", { systemPrompt, userMessage: cliPrompt, cwd: cwd || null, autoApprove });
        }
      } catch { /* fall through */ }
      throw new Error("No ANTHROPIC_API_KEY and no Claude CLI — Telegram bridge can't dispatch.");
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
        model: bareId,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [
          ...history.map(h => ({ role: h.role, content: h.content })),
          { role: "user", content: userMessage },
        ],
        stream: false,
      }),
      signal,
    });
    if (!resp.ok) throw new Error(await resp.text().catch(() => `HTTP ${resp.status}`));
    const j: any = await resp.json();
    const blocks: any[] = Array.isArray(j?.content) ? j.content : [];
    return blocks.filter(b => b?.type === "text").map(b => b.text).join("");
  }

  if (provider === "openai") {
    const key = await invoke<string | null>("accounts_get_secret", { name: "OPENAI_API_KEY" });
    if (!key) throw new Error("No OPENAI_API_KEY saved — set it on the Accounts page.");
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: bareId,
        messages: [
          { role: "system", content: systemPrompt },
          ...history,
          { role: "user", content: userMessage },
        ],
        stream: false,
      }),
      signal,
    });
    if (!resp.ok) throw new Error(await resp.text().catch(() => `HTTP ${resp.status}`));
    const j: any = await resp.json();
    return j?.choices?.[0]?.message?.content ?? "";
  }

  // Local llama-server path.
  if (!server.running || !server.port) {
    throw new Error("No local model server is running — start one on the Server tab.");
  }
  const resp = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelId || "local",
      messages: [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: userMessage },
      ],
      stream: false,
    }),
    signal,
  });
  if (!resp.ok) throw new Error(await resp.text().catch(() => `HTTP ${resp.status}`));
  const j: any = await resp.json();
  return j?.choices?.[0]?.message?.content ?? "";
}

export default function TelegramBridgeRunner() {
  // Track the persisted "started" flag, the loaded config, projects,
  // models, server state. Each lives in a ref-backed signal so the
  // long-poll loop reads fresh data without React having to re-mount
  // the loop on every state change.
  const [started, setStarted] = useState<boolean>(() => {
    try { return localStorage.getItem(STARTED_KEY) === "1"; } catch { return false; }
  });
  const [cfg, setCfg] = useState<TelegramConfig | null>(null);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [server, setServer] = useState<ServerStatus>({ running: false, model_id: null, port: null });

  const projectsRef = useRef(projects); projectsRef.current = projects;
  const modelsRef = useRef(models); modelsRef.current = models;
  const serverRef = useRef(server); serverRef.current = server;
  const cfgRef = useRef(cfg); cfgRef.current = cfg;

  // Listen for the BridgesPage Start/Stop event so we react immediately
  // (no page reload needed). Also re-fetch the config on every status
  // flip so the loop always has the freshly-saved token / project_id.
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
  }, []);

  // Light periodic refresh — server status (for local fallback) and
  // projects (in case the user creates / deletes one while the bridge
  // is running). Keep the cadence quiet (every 5s) so it doesn't burn
  // CPU when nothing's happening.
  useEffect(() => {
    const tick = async () => {
      try {
        const s = await invoke<ServerStatus>("server_status");
        setServer(s);
      } catch { /* keep last */ }
      try {
        const ps = await invoke<ProjectRow[]>("list_projects");
        setProjects(ps);
      } catch { /* keep last */ }
    };
    tick();
    const id = window.setInterval(tick, 5000);
    return () => window.clearInterval(id);
  }, []);

  // The long-poll loop itself. Gated on started + a usable config.
  // Reads token from cfg directly (not via ref) so it re-mounts when
  // the token / project_id actually changes.
  useEffect(() => {
    if (!started) return;
    if (!cfg?.bot_token) return;

    let dead = false;
    let offset = 0;
    const ctrl = new AbortController();

    const sleep = (ms: number) => new Promise(r => window.setTimeout(r, ms));

    // All Telegram HTTP goes through Rust commands — api.telegram.org
    // doesn't speak CORS, so fetch() from the webview is blocked by
    // the browser engine before the request even leaves. invoke()
    // sidesteps that by routing the call through reqwest on the
    // backend.
    const sendReply = async (chatId: number, body: string) => {
      try {
        await invoke("telegram_send_message", {
          token: cfg.bot_token,
          chatId: chatId,
          text: body || "(empty)",
        });
      } catch (e) {
        console.error("telegram_send_message failed", e);
      }
    };

    const handle = async (chatId: number, text: string) => {
      // Resolve the project + its team-default model. Falls back to
      // the running local server's model if the project doesn't have
      // one pinned. Empty model id → use "local" tag for the server.
      const project = projectsRef.current.find(p => p.id === cfg.project_id) ?? null;
      const fallback = serverRef.current.model_id ?? "local";
      const modelId = (project?.team_default_model_id || "").trim() || fallback;
      const sys = project
        ? `You are the orchestrator of the '${project.name}' team. Reply concisely.`
        : "You are a helpful assistant. Reply concisely.";

      // Build the prior history from the project's persisted chat
      // transcript so the bot has memory across app restarts (without
      // this it forgets everything every launch and asks the user
      // "what are we working on?" every time).
      let priorHistory: HistoryItem[] = [];
      if (project?.chat_json) {
        try {
          const parsed = JSON.parse(project.chat_json);
          if (Array.isArray(parsed)) priorHistory = chatToHistory(parsed as GoalMsg[]);
        } catch { /* corrupt blob — ignore */ }
      }

      // Light up the canvas pulse while the bridge is thinking.
      const dispatchActive = (agent: string | null) => {
        try {
          window.dispatchEvent(new CustomEvent("owllm:agent:active", {
            detail: { agent, projectId: project?.id ?? cfg.project_id },
          }));
        } catch { /* event dispatch failed — UI just won't pulse */ }
      };
      dispatchActive("orchestrator");

      const projectCwd = (project?.location ?? "").trim();
      // cfg.auto_approve is the "Auto-approve every tool call" checkbox
      // from the Bridges page. When true we pass --dangerously-skip-
      // permissions to Claude CLI so the bot doesn't stall waiting for
      // a Y/N at the user's desktop — the user is on their phone and
      // can't approve anyway.
      const auto = !!cfg.auto_approve;
      let reply = "";
      try {
        reply = await streamOnce(
          modelId, sys, text,
          modelsRef.current, serverRef.current,
          new AbortController().signal, projectCwd, priorHistory, auto,
        );
      } catch (e: any) {
        reply = `(bridge error: ${String(e?.message ?? e)})`;
      } finally {
        dispatchActive(null);
      }
      await sendReply(chatId, reply);

      // Mirror into the project's chat history so the agentic tab
      // shows what came in from the phone (next time it loads the
      // project) AND so a currently-mounted AgentsPage can render it
      // live via the dispatched event below. Without this the desktop
      // UI has no idea the bridge replied — exactly the "no history"
      // gap users hit after the bridge started working.
      if (project) {
        let chat: GoalMsg[] = [];
        try {
          if (project.chat_json) {
            const parsed = JSON.parse(project.chat_json);
            if (Array.isArray(parsed)) chat = parsed as GoalMsg[];
          }
        } catch { /* ignore corrupt blob */ }
        const inMsg:  GoalMsg = { role: "you",          color: "#9ad9ff", text: `📱 [TG] ${text}` };
        const outMsg: GoalMsg = { role: "orchestrator", color: "#ffd97a", text: reply };
        const next = [...chat, inMsg, outMsg];
        try {
          await invoke("update_project", { input: { id: project.id, chat_json: JSON.stringify(next) } });
          // Refresh local cache so the next inbound message merges
          // against the up-to-date transcript instead of overwriting
          // it with a stale base.
          try {
            const rows = await invoke<ProjectRow[]>("list_projects");
            setProjects(rows);
          } catch { /* keep last cache */ }
        } catch (e) {
          console.error("[telegram] persist chat_json failed", e);
        }
        try {
          window.dispatchEvent(new CustomEvent("owllm:chat:appended", {
            detail: { projectId: project.id, messages: [inMsg, outMsg] },
          }));
        } catch { /* dispatch failed — UI just won't refresh live */ }
      }
    };

    (async () => {
      while (!dead) {
        try {
          // Long-poll via the Rust command — bypasses webview CORS.
          // The Rust side waits up to 20s + 10s buffer, so we don't
          // need our own AbortController-driven cancellation for the
          // hot loop; we just stop calling invoke when `dead` flips.
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
            const text: string | undefined = msg?.text;
            const chatId: number | undefined = msg?.chat?.id;
            if (!text || typeof chatId !== "number") continue;
            // allow-list gate: empty list means "open to anyone" (we
            // match the BridgesPage placeholder, not the original
            // Python docstring — the placeholder is what the user
            // actually reads when they leave the field blank).
            const allow = Array.isArray(cfg.allowed_chat_ids) ? cfg.allowed_chat_ids : [];
            if (allow.length > 0 && !allow.includes(chatId)) {
              console.warn(`[telegram] chat ${chatId} not on allow-list — ignored.`);
              continue;
            }
            console.log(`[telegram] inbound from ${chatId}: ${text.slice(0, 80)}`);
            await handle(chatId, text);
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
      ctrl.abort();
      console.log("[telegram] bridge polling stopped");
    };
  }, [started, cfg?.bot_token, cfg?.project_id, (cfg?.allowed_chat_ids ?? []).join(",")]);

  // Desktop → Telegram mirror. When the agentic tab dispatches a
  // chat-appended event with source=desktop for the bound project,
  // forward the ASSISTANT messages (skip the user's own typing — it
  // already left their phone) to every chat on the allow-list. Keeps
  // the phone-side conversation in sync with the desktop sends so the
  // user sees the full thread on both screens.
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
        if (m.role === "you") continue; // user typed on desktop — their phone already has the prompt
        for (const chatId of allow) {
          try {
            await invoke("telegram_send_message", {
              token: cfg.bot_token,
              chatId,
              text: m.text,
            });
          } catch (err) {
            console.error("[telegram] forward desktop reply failed", err);
          }
        }
      }
    };
    window.addEventListener("owllm:chat:appended", handler as EventListener);
    return () => window.removeEventListener("owllm:chat:appended", handler as EventListener);
  }, [started, cfg?.bot_token, cfg?.project_id, (cfg?.allowed_chat_ids ?? []).join(",")]);

  // The component renders nothing visible — it's a pure side-effect
  // host. AppShell mounts it once.
  return null;
}
