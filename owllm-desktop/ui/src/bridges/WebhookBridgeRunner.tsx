// WebhookBridgeRunner — the three INBOUND webhook bridges (WhatsApp, LINE,
// KakaoTalk) sharing one Rust HTTP listener.
//
// Unlike the outbound bridges these receive over HTTP, so they need a public
// URL (the user runs a tunnel and pastes it as the webhook callback in each
// provider). The Rust webhook server (webhook.rs) emits owllm:webhook:inbound
// for every message; here we route each through the SHARED bridge core and
// reply via the platform's REST command. The server is started on the shared
// port (WhatsApp's webhook_port) whenever ANY of the three is enabled.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  useBridgeDispatch,
  type BridgeTransport, type BridgeConfigLite,
} from "./bridgeCore";

type WhatsAppConfig = { access_token: string; phone_number_id: string; verify_token: string; webhook_port: number; allowed_senders: string[]; project_id: string; auto_approve: boolean };
type LineConfig = { channel_access_token: string; channel_secret: string; allowed_users: string[]; project_id: string; auto_approve: boolean };
type KakaoConfig = { allowed_users: string[]; project_id: string; auto_approve: boolean };
type BridgeConfigs = { whatsapp: WhatsAppConfig; line: LineConfig; kakao: KakaoConfig };

type Platform = "whatsapp" | "line" | "kakao";
type Inbound = { platform: Platform; from: string; text: string; callbackUrl: string };

const STARTED_KEYS: Record<Platform, string> = {
  whatsapp: "owllm:whatsapp:started",
  line: "owllm:line:started",
  kakao: "owllm:kakao:started",
};
function flag(p: Platform): boolean {
  try { return sessionStorage.getItem(STARTED_KEYS[p]) === "1"; } catch { return false; }
}
function emitRuntime(p: Platform, detail: { status: "running" | "stopped" | "error"; lastError?: string; seenFrom?: string }) {
  try { window.dispatchEvent(new CustomEvent(`owllm:${p}:runtime`, { detail })); } catch {}
}

export default function WebhookBridgeRunner() {
  const [started, setStarted] = useState<Record<Platform, boolean>>(() => ({
    whatsapp: flag("whatsapp"), line: flag("line"), kakao: flag("kakao"),
  }));
  const [cfg, setCfg] = useState<BridgeConfigs | null>(null);
  const startedRef = useRef(started); startedRef.current = started;
  const cfgRef = useRef(cfg); cfgRef.current = cfg;
  const kakaoCb = useRef<Record<string, string>>({}); // per-user callbackUrl
  const queue = useRef<Promise<void>>(Promise.resolve());

  const { handleMessage } = useBridgeDispatch();

  // Load configs on mount + refresh when any card saves/toggles.
  useEffect(() => {
    const reload = () => invoke<BridgeConfigs>("load_bridge_configs").then(setCfg).catch(() => {});
    reload();
    const sync = () => {
      setStarted({ whatsapp: flag("whatsapp"), line: flag("line"), kakao: flag("kakao") });
      reload();
    };
    const onStatus = () => sync();
    (["whatsapp", "line", "kakao"] as Platform[]).forEach((p) =>
      window.addEventListener(`owllm:${p}:status`, onStatus as EventListener));
    const id = window.setInterval(sync, 2000);
    return () => {
      window.clearInterval(id);
      (["whatsapp", "line", "kakao"] as Platform[]).forEach((p) =>
        window.removeEventListener(`owllm:${p}:status`, onStatus as EventListener));
    };
  }, []);

  // Start/stop the shared listener as the enabled set / port changes.
  const anyOn = started.whatsapp || started.line || started.kakao;
  const port = cfg?.whatsapp?.webhook_port || 8911;
  const verifyToken = cfg?.whatsapp?.verify_token || "";
  useEffect(() => {
    if (!anyOn) {
      invoke("webhook_stop").catch(() => {});
      (["whatsapp", "line", "kakao"] as Platform[]).forEach((p) => emitRuntime(p, { status: "stopped" }));
      return;
    }
    invoke("webhook_start", { port, whatsappVerifyToken: verifyToken })
      .then(() => (["whatsapp", "line", "kakao"] as Platform[]).forEach((p) => { if (startedRef.current[p]) emitRuntime(p, { status: "running" }); }))
      .catch((e) => (["whatsapp", "line", "kakao"] as Platform[]).forEach((p) => { if (startedRef.current[p]) emitRuntime(p, { status: "error", lastError: String(e) }); }));
  }, [anyOn, port, verifyToken]);

  // Per-platform transport + lite config.
  const transportFor = (p: Platform): BridgeTransport => {
    const send = async (to: string, text: string) => {
      const c = cfgRef.current;
      if (!c) return;
      if (p === "whatsapp") {
        await invoke("whatsapp_send", { accessToken: c.whatsapp.access_token, phoneNumberId: c.whatsapp.phone_number_id, to, text });
      } else if (p === "line") {
        await invoke("line_push", { channelAccessToken: c.line.channel_access_token, to, text });
      } else {
        await invoke("kakao_callback", { callbackUrl: kakaoCb.current[to] || "", text });
      }
    };
    const maxLen = p === "kakao" ? 900 : p === "line" ? 4900 : 4000;
    const tag = p === "whatsapp" ? "WhatsApp" : p === "line" ? "LINE" : "Kakao";
    return { name: p, tag, maxLen, send };
  };
  const liteFor = (p: Platform): BridgeConfigLite => {
    const c = cfgRef.current;
    if (p === "whatsapp") return { allowed: c?.whatsapp.allowed_senders ?? [], project_id: c?.whatsapp.project_id ?? "", auto_approve: !!c?.whatsapp.auto_approve };
    if (p === "line") return { allowed: c?.line.allowed_users ?? [], project_id: c?.line.project_id ?? "", auto_approve: !!c?.line.auto_approve };
    return { allowed: c?.kakao.allowed_users ?? [], project_id: c?.kakao.project_id ?? "", auto_approve: !!c?.kakao.auto_approve };
  };

  // Inbound listener (Rust → here).
  useEffect(() => {
    const un = listen<Inbound>("owllm:webhook:inbound", (e) => {
      const { platform, from, text, callbackUrl } = e.payload;
      if (!startedRef.current[platform]) return;
      if (!from) return;
      if (platform === "kakao" && callbackUrl) kakaoCb.current[from] = callbackUrl;
      const lite = liteFor(platform);
      if (lite.allowed.length > 0 && !lite.allowed.includes(from)) return;
      emitRuntime(platform, { status: "running", seenFrom: from });
      const transport = transportFor(platform);
      queue.current = queue.current
        .then(() => handleMessage(transport, lite, from, text, []))
        .catch((err) => console.error(`[${platform}] handle failed`, err));
    });
    return () => { un.then((f) => f()).catch(() => {}); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
