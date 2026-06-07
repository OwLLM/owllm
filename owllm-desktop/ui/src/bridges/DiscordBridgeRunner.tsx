// DiscordBridgeRunner — top-level gateway bridge.
//
// Lives inside AppShell so it survives navigation. Connects OUTBOUND to the
// Discord gateway WebSocket (no public URL needed), handles the
// hello/identify/heartbeat handshake, and turns each inbound MESSAGE_CREATE
// into a dispatch through the SHARED bridge core (useBridgeDispatch). Replies
// + attachment downloads go through Rust REST commands (discord.rs) because
// discord.com/api has no CORS for the webview origin. WebSocket itself is not
// CORS-gated, so receiving can happen right here in React.
//
// Privileged intent note: reading message text requires the MESSAGE CONTENT
// intent to be enabled for the bot in the Discord Developer Portal. Without it
// `content` arrives empty and only attachments come through.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type Attachment } from "../pages/agentic/dispatch";
import {
  useBridgeDispatch, useBridgeMirror,
  type BridgeTransport, type BridgeConfigLite,
} from "./bridgeCore";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

// Intents: GUILD_MESSAGES (1<<9) | DIRECT_MESSAGES (1<<12) | MESSAGE_CONTENT (1<<15).
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15); // 37376

type DiscordFileDownload = { mime: string; data_b64: string; size: number };

type DiscordConfig = {
  bot_token: string;
  allowed_channel_ids: string[];
  project_id: string;
  auto_approve: boolean;
};
type BridgeConfigs = { discord: DiscordConfig };

const STARTED_KEY = "owllm:discord:started";
function getStartedFlag(): boolean {
  try { return sessionStorage.getItem(STARTED_KEY) === "1"; } catch { return false; }
}

function emitRuntimeStatus(detail: { status: "running" | "stopped" | "error"; lastError?: string; seenChannelId?: string }) {
  try { window.dispatchEvent(new CustomEvent("owllm:discord:runtime", { detail })); } catch {}
}

async function downloadAttachment(att: { url: string; content_type?: string }): Promise<Attachment | null> {
  const ct = att.content_type || "";
  const kind: "image" | "audio" | null = ct.startsWith("image/") ? "image" : ct.startsWith("audio/") ? "audio" : null;
  if (!kind) return null;
  try {
    const dl = await invoke<DiscordFileDownload>("discord_download_file", { url: att.url, expectedMime: att.content_type ?? null });
    return { kind, mime: dl.mime, data_b64: dl.data_b64, filename: `attachment.${dl.mime.split("/")[1] || "bin"}` };
  } catch (e) {
    console.error("[discord] attachment download failed", e);
    return null;
  }
}

export default function DiscordBridgeRunner() {
  const [started, setStarted] = useState<boolean>(() => getStartedFlag());
  const [cfg, setCfg] = useState<DiscordConfig | null>(null);
  const cfgRef = useRef(cfg); cfgRef.current = cfg;

  const { handleMessage } = useBridgeDispatch();

  const rawSend = async (channelId: string, content: string) => {
    await invoke("discord_send_message", {
      token: cfgRef.current?.bot_token ?? "",
      channelId,
      content,
    });
  };
  const transport: BridgeTransport = {
    name: "discord",
    tag: "Discord",
    maxLen: 1900, // hard cap is 2000
    send: rawSend,
  };

  const toLite = (c: DiscordConfig | null): BridgeConfigLite => ({
    allowed: Array.isArray(c?.allowed_channel_ids) ? c!.allowed_channel_ids.map(String) : [],
    project_id: c?.project_id ?? "",
    auto_approve: !!c?.auto_approve,
  });

  useBridgeMirror(transport, started ? toLite(cfg) : null, started, rawSend);

  // Status flag sync (same belt-and-suspenders pattern as Telegram).
  useEffect(() => {
    const onStatus = (e: Event) => {
      const running = (e as CustomEvent).detail === "running";
      setStarted(running);
      if (running) invoke<BridgeConfigs>("load_bridge_configs").then(c => setCfg(c.discord)).catch(() => {});
    };
    window.addEventListener("owllm:discord:status", onStatus as EventListener);
    return () => window.removeEventListener("owllm:discord:status", onStatus as EventListener);
  }, []);

  useEffect(() => {
    const sync = () => {
      const running = getStartedFlag();
      setStarted(running);
      if (running) invoke<BridgeConfigs>("load_bridge_configs").then(c => setCfg(c.discord)).catch(() => {});
    };
    sync();
    const id = window.setInterval(sync, 2000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    invoke<BridgeConfigs>("load_bridge_configs").then(c => setCfg(c.discord)).catch(() => {});
  }, []);

  // ---- Gateway connection — gated on started + valid token ----
  useEffect(() => {
    if (!started) { emitRuntimeStatus({ status: "stopped" }); return; }
    if (!cfg?.bot_token) {
      emitRuntimeStatus({ status: "error", lastError: "Missing Discord bot token. Save the config, then Start." });
      return;
    }

    let dead = false;
    let ws: WebSocket | null = null;
    let heartbeat: number | null = null;
    let lastSeq: number | null = null;
    let selfId = "";
    let reconnectTimer: number | null = null;
    let handlerQueue: Promise<void> = Promise.resolve();

    const lite = () => toLite(cfgRef.current);

    const clearTimers = () => {
      if (heartbeat !== null) { window.clearInterval(heartbeat); heartbeat = null; }
      if (reconnectTimer !== null) { window.clearTimeout(reconnectTimer); reconnectTimer = null; }
    };

    const connect = () => {
      if (dead) return;
      try {
        ws = new WebSocket(GATEWAY_URL);
      } catch (e) {
        emitRuntimeStatus({ status: "error", lastError: `gateway open failed: ${String((e as any)?.message ?? e)}` });
        scheduleReconnect();
        return;
      }

      ws.onopen = () => {
        if (!dead) emitRuntimeStatus({ status: "running" });
      };

      ws.onmessage = (ev) => {
        if (dead) return;
        let pkt: any;
        try { pkt = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
        if (typeof pkt?.s === "number") lastSeq = pkt.s;

        switch (pkt.op) {
          case 10: { // Hello → start heartbeating + identify
            const interval = pkt.d?.heartbeat_interval ?? 41250;
            heartbeat = window.setInterval(() => {
              try { ws?.send(JSON.stringify({ op: 1, d: lastSeq })); } catch {}
            }, interval);
            const token = cfgRef.current?.bot_token ?? "";
            try {
              ws?.send(JSON.stringify({
                op: 2,
                d: {
                  token,
                  intents: INTENTS,
                  properties: { os: "windows", browser: "owllm", device: "owllm" },
                },
              }));
            } catch {}
            break;
          }
          case 0: { // Dispatch
            if (pkt.t === "READY") {
              selfId = pkt.d?.user?.id ?? "";
              console.log(`[discord] ready as ${pkt.d?.user?.username ?? "?"} (${selfId})`);
              emitRuntimeStatus({ status: "running" });
            } else if (pkt.t === "MESSAGE_CREATE") {
              const m = pkt.d || {};
              // Ignore other bots AND our own echoes (bots are flagged bot=true).
              if (m.author?.bot) break;
              if (m.author?.id && m.author.id === selfId) break;
              const channelId: string = String(m.channel_id ?? "");
              if (!channelId) break;
              const c = cfgRef.current;
              const allow = Array.isArray(c?.allowed_channel_ids) ? c!.allowed_channel_ids : [];
              if (allow.length > 0 && !allow.includes(channelId)) break;
              const text: string = m.content ?? "";
              const atts: Array<{ url: string; content_type?: string }> = Array.isArray(m.attachments) ? m.attachments : [];
              const mediaAtts = atts.filter(a => (a.content_type || "").startsWith("image/") || (a.content_type || "").startsWith("audio/"));
              if (!text && mediaAtts.length === 0) break;
              emitRuntimeStatus({ status: "running", seenChannelId: channelId });

              const immediateCommand = mediaAtts.length === 0 &&
                (/^\/(?:ping|projects|project|use|switch|models|model)\b/i.test(text.trim()) || /^\d+$/.test(text.trim()));
              if (immediateCommand) {
                handleMessage(transport, lite(), channelId, text, [])
                  .catch(e => console.error("[discord] command failed", e));
                break;
              }
              handlerQueue = handlerQueue.then(async () => {
                const attachments: Attachment[] = [];
                for (const a of mediaAtts) {
                  const dl = await downloadAttachment(a);
                  if (dl) attachments.push(dl);
                }
                await handleMessage(transport, lite(), channelId, text, attachments);
              }).catch(e => console.error("[discord] handle failed", e));
            }
            break;
          }
          case 7:  // Reconnect requested
          case 9:  // Invalid session
            console.warn(`[discord] gateway op ${pkt.op} — reconnecting`);
            try { ws?.close(); } catch {}
            break;
          default:
            break; // op 11 (heartbeat ACK) etc.
        }
      };

      ws.onerror = () => {
        if (!dead) emitRuntimeStatus({ status: "error", lastError: "gateway socket error" });
      };

      ws.onclose = () => {
        clearTimers();
        if (!dead) scheduleReconnect();
      };
    };

    const scheduleReconnect = () => {
      if (dead) return;
      clearTimers();
      reconnectTimer = window.setTimeout(connect, 5000);
    };

    connect();
    console.log(`[discord] bridge starting (token …${cfg.bot_token.slice(-6)})`);
    return () => {
      dead = true;
      clearTimers();
      try { ws?.close(); } catch {}
      emitRuntimeStatus({ status: "stopped" });
      console.log("[discord] bridge stopped");
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, cfg?.bot_token, cfg?.project_id, (cfg?.allowed_channel_ids ?? []).join(",")]);

  return null;
}
