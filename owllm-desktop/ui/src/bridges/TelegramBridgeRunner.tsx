// TelegramBridgeRunner — top-level long-poll bridge.
//
// Lives directly inside AppShell so the loop survives page navigation. Polls
// Telegram with `getUpdates?timeout=20`, gates inbound on the session
// `owllm:telegram:started` flag (toggled by BridgesPage Start/Stop), matches
// the saved allowed_chat_ids, downloads any media, then hands each message to
// the SHARED bridge core (useBridgeDispatch) which runs the orchestrator →
// specialists → integrate loop and replies. The only Telegram-specific code
// here is the transport (HTTP via Rust) + the long-poll receive loop; all
// dispatch/routing/persistence lives in bridgeCore.ts.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type Attachment } from "../pages/agentic/dispatch";
import {
  useBridgeDispatch, useBridgeMirror,
  type BridgeTransport, type BridgeConfigLite,
} from "./bridgeCore";

/// Shape returned by the Rust telegram_download_file command.
type TelegramFileDownload = { mime: string; data_b64: string; size: number };

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

async function downloadAudio(token: string, fileId: string, mimeHint: string | null, filename?: string): Promise<Attachment | null> {
  try {
    const dl = await invoke<TelegramFileDownload>("telegram_download_file", { token, fileId, expectedMime: mimeHint });
    return { kind: "audio", mime: dl.mime, data_b64: dl.data_b64, filename: filename ?? `audio.${dl.mime.split("/")[1] || "ogg"}` };
  } catch (e) {
    console.error("[telegram] audio download failed", e);
    return null;
  }
}

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

function getStartedFlag(): boolean {
  try { return sessionStorage.getItem(STARTED_KEY) === "1"; } catch { return false; }
}

type TelegramConfig = {
  bot_token: string;
  allowed_chat_ids: number[];
  project_id: string;
  auto_approve: boolean;
};
type BridgeConfigs = { telegram: TelegramConfig; whatsapp: unknown };

function mimeFromFilename(name?: string): string | null {
  const ext = (name ?? "").toLowerCase().split(".").pop() ?? "";
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

function emitRuntimeStatus(detail: { status: "running" | "stopped" | "error"; lastError?: string; lastUpdateId?: number; seenChatId?: number }) {
  try {
    window.dispatchEvent(new CustomEvent("owllm:telegram:runtime", { detail }));
  } catch {}
}

export default function TelegramBridgeRunner() {
  const [started, setStarted] = useState<boolean>(() => getStartedFlag());
  const [cfg, setCfg] = useState<TelegramConfig | null>(null);
  const cfgRef = useRef(cfg); cfgRef.current = cfg;

  const { handleMessage } = useBridgeDispatch();

  // Telegram transport: send a plain-text reply via the Rust HTTP command
  // (bypasses webview CORS). Reads the token from the live config ref.
  const rawSend = async (chatId: string, text: string) => {
    await invoke("telegram_send_message", {
      token: cfgRef.current?.bot_token ?? "",
      chatId: Number(chatId),
      text,
    });
  };
  const transport: BridgeTransport = {
    name: "telegram",
    tag: "TG",
    maxLen: 4000, // API hard cap is 4096
    send: rawSend,
  };

  // Map the Telegram config onto the core's BridgeConfigLite.
  const toLite = (c: TelegramConfig | null): BridgeConfigLite => ({
    allowed: Array.isArray(c?.allowed_chat_ids) ? c!.allowed_chat_ids.map(String) : [],
    project_id: c?.project_id ?? "",
    auto_approve: !!c?.auto_approve,
  });

  // Desktop → Telegram mirror (shared).
  useBridgeMirror(transport, started ? toLite(cfg) : null, started, rawSend);

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

  // Belt-and-suspenders sync: poll the persisted flag + config so the runner
  // cannot look "running" in UI while asleep. Intentionally sessionStorage,
  // not localStorage — auto-resuming a bot poller on every launch would steal
  // Telegram updates from the mobile app when both use the same bot token.
  useEffect(() => {
    const sync = () => {
      const running = getStartedFlag();
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

  // Initial config load on mount.
  useEffect(() => {
    invoke<BridgeConfigs>("load_bridge_configs").then(c => setCfg(c.telegram)).catch(() => {});
  }, []);

  // ---- Long-poll loop — gated on started + valid cfg ----
  //
  // Message handling is strictly SERIAL: a chained handlerQueue promise
  // ensures only one dispatch runs at a time even when the user fires several
  // messages quickly. Telegram's getUpdates queues server-side, so we don't
  // lose any inbound by serializing.
  useEffect(() => {
    if (!started) {
      emitRuntimeStatus({ status: "stopped" });
      return;
    }
    if (!cfg?.bot_token) {
      emitRuntimeStatus({ status: "error", lastError: "Missing Telegram bot token. Save the bridge config, then Start." });
      return;
    }

    let dead = false;
    let offset = 0;
    let handlerQueue: Promise<void> = Promise.resolve();
    const sleep = (ms: number) => new Promise(r => window.setTimeout(r, ms));
    const lite = () => toLite(cfgRef.current);

    (async () => {
      while (!dead) {
        try {
          const updates: Array<any> = await invoke("telegram_get_updates", {
            token: cfg.bot_token,
            offset,
            timeout: 20,
          });
          if (dead) return;
          emitRuntimeStatus({ status: "running", lastUpdateId: Math.max(0, offset - 1) });
          for (const upd of (updates || [])) {
            if (typeof upd.update_id === "number") {
              offset = Math.max(offset, upd.update_id + 1);
            }
            const msg = upd.message || upd.edited_message || upd.channel_post || upd.edited_channel_post;
            const chatId: number | undefined = msg?.chat?.id;
            if (typeof chatId !== "number") continue;
            emitRuntimeStatus({ status: "running", lastUpdateId: upd.update_id, seenChatId: chatId });
            const allow = Array.isArray(cfg.allowed_chat_ids) ? cfg.allowed_chat_ids : [];
            if (allow.length > 0 && !allow.includes(chatId)) {
              console.warn(`[telegram] chat ${chatId} not on allow-list — ignored.`);
              continue;
            }
            const text: string = msg?.text || msg?.caption || "";
            const hasPhoto = Array.isArray(msg?.photo) && msg.photo.length > 0;
            const hasVoice = !!msg?.voice?.file_id;
            const hasAudio = !!msg?.audio?.file_id;
            const rawDocName: string = msg?.document?.file_name || "";
            const docMime: string = msg?.document?.mime_type || mimeFromFilename(rawDocName) || "";
            const docIsImage = !!msg?.document?.file_id && docMime.startsWith("image/");
            const docIsAudio = !!msg?.document?.file_id && docMime.startsWith("audio/");
            const hasMedia = hasPhoto || hasVoice || hasAudio || docIsImage || docIsAudio;
            if (!text && !hasMedia) continue;
            console.log(`[telegram] inbound from ${chatId}: text="${text.slice(0, 60)}" photo=${hasPhoto} voice=${hasVoice} audio=${hasAudio} doc=${docMime || "-"}`);
            const immediateCommand = !hasMedia && (/^\/(?:ping|projects|project|use|switch|models|model)\b/i.test(text.trim()) || /^\d+$/.test(text.trim()));

            // Snapshot file refs NOW (msg goes out of scope by the time the
            // queued task runs). Downloads happen inside the queued task so
            // they're serialized too.
            const photoArr = hasPhoto ? msg.photo : [];
            const voiceId = hasVoice ? msg.voice.file_id : null;
            const voiceMime = hasVoice ? (msg.voice.mime_type || null) : null;
            const audioId = hasAudio ? msg.audio.file_id : null;
            const audioMime = hasAudio ? (msg.audio.mime_type || null) : null;
            const audioName = hasAudio ? (msg.audio.file_name || undefined) : undefined;
            const docId = (docIsImage || docIsAudio) ? msg.document.file_id : null;
            const docName = (docIsImage || docIsAudio) ? (rawDocName || undefined) : undefined;

            if (immediateCommand) {
              handleMessage(transport, lite(), String(chatId), text, [])
                .catch(e => console.error("[telegram] command failed", e));
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
                await handleMessage(transport, lite(), String(chatId), text, attachments);
              })
              .catch(e => console.error("[telegram] handle failed", e));
          }
        } catch (e: any) {
          console.error("[telegram] poll loop error", e);
          emitRuntimeStatus({ status: "error", lastError: String(e?.message ?? e) });
          if (dead) return;
          await sleep(5000);
        }
      }
    })();

    console.log(`[telegram] bridge polling started for token …${cfg.bot_token.slice(-6)} project=${cfg.project_id || "(any)"}`);
    return () => {
      dead = true;
      emitRuntimeStatus({ status: "stopped" });
      console.log("[telegram] bridge polling stopped");
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, cfg?.bot_token, cfg?.project_id, (cfg?.allowed_chat_ids ?? []).join(",")]);

  return null;
}
