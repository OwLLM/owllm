// SlackBridgeRunner — top-level Socket Mode bridge.
//
// Lives in AppShell so it survives navigation. Opens a Socket Mode WebSocket
// (URL fetched via the Rust slack_open_connection, which needs the app-level
// token) and connects to it in the webview (WebSocket isn't CORS-gated). Each
// inbound message event is ACKed (Slack retries otherwise) and dispatched
// through the SHARED bridge core (useBridgeDispatch). Replies + file downloads
// go through Rust (slack.rs) because slack.com/api has no CORS for the webview.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type Attachment } from "../pages/agentic/dispatch";
import {
  useBridgeDispatch, useBridgeMirror,
  type BridgeTransport, type BridgeConfigLite,
} from "./bridgeCore";

type SlackFileDownload = { mime: string; data_b64: string; size: number };

type SlackConfig = {
  app_token: string;
  bot_token: string;
  allowed_channel_ids: string[];
  project_id: string;
  auto_approve: boolean;
};
type BridgeConfigs = { slack: SlackConfig };

const STARTED_KEY = "owllm:slack:started";
function getStartedFlag(): boolean {
  try { return sessionStorage.getItem(STARTED_KEY) === "1"; } catch { return false; }
}
function emitRuntimeStatus(detail: { status: "running" | "stopped" | "error"; lastError?: string; seenChannelId?: string }) {
  try { window.dispatchEvent(new CustomEvent("owllm:slack:runtime", { detail })); } catch {}
}

async function downloadFile(url: string, botToken: string, mimetype?: string): Promise<Attachment | null> {
  const ct = mimetype || "";
  const kind: "image" | "audio" | null = ct.startsWith("image/") ? "image" : ct.startsWith("audio/") ? "audio" : null;
  if (!kind) return null;
  try {
    const dl = await invoke<SlackFileDownload>("slack_download_file", { url, botToken, expectedMime: mimetype ?? null });
    return { kind, mime: dl.mime, data_b64: dl.data_b64, filename: `attachment.${dl.mime.split("/")[1] || "bin"}` };
  } catch (e) {
    console.error("[slack] file download failed", e);
    return null;
  }
}

export default function SlackBridgeRunner() {
  const [started, setStarted] = useState<boolean>(() => getStartedFlag());
  const [cfg, setCfg] = useState<SlackConfig | null>(null);
  const cfgRef = useRef(cfg); cfgRef.current = cfg;

  const { handleMessage } = useBridgeDispatch();

  const rawSend = async (channel: string, text: string) => {
    await invoke("slack_send_message", { botToken: cfgRef.current?.bot_token ?? "", channel, text });
  };
  const transport: BridgeTransport = { name: "slack", tag: "Slack", maxLen: 3500, send: rawSend };

  const toLite = (c: SlackConfig | null): BridgeConfigLite => ({
    allowed: Array.isArray(c?.allowed_channel_ids) ? c!.allowed_channel_ids.map(String) : [],
    project_id: c?.project_id ?? "",
    auto_approve: !!c?.auto_approve,
  });

  useBridgeMirror(transport, started ? toLite(cfg) : null, started, rawSend);

  useEffect(() => {
    const onStatus = (e: Event) => {
      const running = (e as CustomEvent).detail === "running";
      setStarted(running);
      if (running) invoke<BridgeConfigs>("load_bridge_configs").then(c => setCfg(c.slack)).catch(() => {});
    };
    window.addEventListener("owllm:slack:status", onStatus as EventListener);
    return () => window.removeEventListener("owllm:slack:status", onStatus as EventListener);
  }, []);

  useEffect(() => {
    const sync = () => {
      const running = getStartedFlag();
      setStarted(running);
      if (running) invoke<BridgeConfigs>("load_bridge_configs").then(c => setCfg(c.slack)).catch(() => {});
    };
    sync();
    const id = window.setInterval(sync, 2000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    invoke<BridgeConfigs>("load_bridge_configs").then(c => setCfg(c.slack)).catch(() => {});
  }, []);

  // ---- Socket Mode connection — gated on started + tokens ----
  useEffect(() => {
    if (!started) { emitRuntimeStatus({ status: "stopped" }); return; }
    if (!cfg?.app_token || !cfg?.bot_token) {
      emitRuntimeStatus({ status: "error", lastError: "Need both an app-level token (xapp-) and a bot token (xoxb-). Save the config, then Start." });
      return;
    }

    let dead = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let handlerQueue: Promise<void> = Promise.resolve();
    const lite = () => toLite(cfgRef.current);

    const scheduleReconnect = () => {
      if (dead) return;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(connect, 5000);
    };

    const connect = async () => {
      if (dead) return;
      let url: string;
      try {
        url = await invoke<string>("slack_open_connection", { appToken: cfgRef.current?.app_token ?? "" });
      } catch (e) {
        emitRuntimeStatus({ status: "error", lastError: `open connection failed: ${String((e as any)?.message ?? e)}` });
        scheduleReconnect();
        return;
      }
      if (dead) return;
      try { ws = new WebSocket(url); } catch (e) {
        emitRuntimeStatus({ status: "error", lastError: `socket open failed: ${String((e as any)?.message ?? e)}` });
        scheduleReconnect();
        return;
      }

      ws.onmessage = (ev) => {
        if (dead) return;
        let pkt: any;
        try { pkt = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }

        if (pkt.type === "hello") { emitRuntimeStatus({ status: "running" }); return; }
        if (pkt.type === "disconnect") { try { ws?.close(); } catch {} return; }

        // Every envelope that carries an envelope_id MUST be acked.
        if (pkt.envelope_id) {
          try { ws?.send(JSON.stringify({ envelope_id: pkt.envelope_id })); } catch {}
        }
        if (pkt.type !== "events_api") return;

        const event = pkt.payload?.event;
        if (!event || event.type !== "message") return;
        // Ignore bot messages (incl. our own echoes) and edits/joins/etc.
        if (event.bot_id || event.subtype) return;
        const channel: string = String(event.channel ?? "");
        if (!channel) return;
        const c = cfgRef.current;
        const allow = Array.isArray(c?.allowed_channel_ids) ? c!.allowed_channel_ids : [];
        if (allow.length > 0 && !allow.includes(channel)) return;
        const text: string = event.text ?? "";
        const files: Array<{ url_private?: string; mimetype?: string }> = Array.isArray(event.files) ? event.files : [];
        const mediaFiles = files.filter(f => (f.mimetype || "").startsWith("image/") || (f.mimetype || "").startsWith("audio/"));
        if (!text && mediaFiles.length === 0) return;
        emitRuntimeStatus({ status: "running", seenChannelId: channel });

        const immediateCommand = mediaFiles.length === 0 &&
          (/^\/(?:ping|projects|project|use|switch|models|model)\b/i.test(text.trim()) || /^\d+$/.test(text.trim()));
        if (immediateCommand) {
          handleMessage(transport, lite(), channel, text, []).catch(e => console.error("[slack] command failed", e));
          return;
        }
        handlerQueue = handlerQueue.then(async () => {
          const attachments: Attachment[] = [];
          for (const f of mediaFiles) {
            if (!f.url_private) continue;
            const dl = await downloadFile(f.url_private, cfgRef.current?.bot_token ?? "", f.mimetype);
            if (dl) attachments.push(dl);
          }
          await handleMessage(transport, lite(), channel, text, attachments);
        }).catch(e => console.error("[slack] handle failed", e));
      };

      ws.onerror = () => { if (!dead) emitRuntimeStatus({ status: "error", lastError: "socket error" }); };
      ws.onclose = () => { if (!dead) scheduleReconnect(); };
    };

    connect();
    console.log("[slack] bridge starting (Socket Mode)");
    return () => {
      dead = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      try { ws?.close(); } catch {}
      emitRuntimeStatus({ status: "stopped" });
      console.log("[slack] bridge stopped");
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, cfg?.app_token, cfg?.bot_token, cfg?.project_id, (cfg?.allowed_channel_ids ?? []).join(",")]);

  return null;
}
