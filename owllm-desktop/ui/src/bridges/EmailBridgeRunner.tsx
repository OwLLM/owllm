// EmailBridgeRunner — top-level IMAP/SMTP bridge.
//
// Lives in AppShell so it survives navigation. There's no webview transport
// (a browser can't speak IMAP/SMTP), so BOTH directions are Rust commands:
// this polls email_poll on the configured interval and replies via email_send.
// Each inbound mail is dispatched through the SHARED bridge core
// (useBridgeDispatch); chatId is the sender's address. Replies thread by
// reusing the sender's last subject as "Re: …".

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  useBridgeDispatch, useBridgeMirror,
  type BridgeTransport, type BridgeConfigLite,
} from "./bridgeCore";

type EmailMsg = { from: string; subject: string; body: string; messageId: string };

type EmailConfig = {
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  username: string;
  password: string;
  from_addr: string;
  allowed_senders: string[];
  poll_seconds: number;
  project_id: string;
  auto_approve: boolean;
};
type BridgeConfigs = { email: EmailConfig };

const STARTED_KEY = "owllm:email:started";
function getStartedFlag(): boolean {
  try { return sessionStorage.getItem(STARTED_KEY) === "1"; } catch { return false; }
}
function emitRuntimeStatus(detail: { status: "running" | "stopped" | "error"; lastError?: string; seenFrom?: string }) {
  try { window.dispatchEvent(new CustomEvent("owllm:email:runtime", { detail })); } catch {}
}

export default function EmailBridgeRunner() {
  const [started, setStarted] = useState<boolean>(() => getStartedFlag());
  const [cfg, setCfg] = useState<EmailConfig | null>(null);
  const cfgRef = useRef(cfg); cfgRef.current = cfg;
  // Last subject seen per sender, so replies can thread as "Re: …".
  const lastSubject = useRef<Record<string, string>>({});

  const { handleMessage } = useBridgeDispatch();

  const rawSend = async (to: string, text: string) => {
    const c = cfgRef.current;
    if (!c) return;
    const prev = lastSubject.current[to] || "";
    const subject = prev ? (/^re:/i.test(prev) ? prev : `Re: ${prev}`) : "OWLLM reply";
    await invoke("email_send", {
      smtpHost: c.smtp_host, smtpPort: c.smtp_port,
      username: c.username, password: c.password,
      from: c.from_addr, to, subject, body: text,
    });
  };
  // Email bodies are long-form — don't chunk them like a chat message.
  const transport: BridgeTransport = { name: "email", tag: "Email", maxLen: 100000, send: rawSend };

  const toLite = (c: EmailConfig | null): BridgeConfigLite => ({
    allowed: Array.isArray(c?.allowed_senders) ? c!.allowed_senders.map((s) => s.toLowerCase()) : [],
    project_id: c?.project_id ?? "",
    auto_approve: !!c?.auto_approve,
  });

  useBridgeMirror(transport, started ? toLite(cfg) : null, started, rawSend);

  useEffect(() => {
    const onStatus = (e: Event) => {
      const running = (e as CustomEvent).detail === "running";
      setStarted(running);
      if (running) invoke<BridgeConfigs>("load_bridge_configs").then(c => setCfg(c.email)).catch(() => {});
    };
    window.addEventListener("owllm:email:status", onStatus as EventListener);
    return () => window.removeEventListener("owllm:email:status", onStatus as EventListener);
  }, []);

  useEffect(() => {
    const sync = () => {
      const running = getStartedFlag();
      setStarted(running);
      if (running) invoke<BridgeConfigs>("load_bridge_configs").then(c => setCfg(c.email)).catch(() => {});
    };
    sync();
    const id = window.setInterval(sync, 2000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    invoke<BridgeConfigs>("load_bridge_configs").then(c => setCfg(c.email)).catch(() => {});
  }, []);

  // ---- Poll loop — gated on started + IMAP config ----
  useEffect(() => {
    if (!started) { emitRuntimeStatus({ status: "stopped" }); return; }
    if (!cfg?.imap_host || !cfg?.username || !cfg?.password) {
      emitRuntimeStatus({ status: "error", lastError: "Need IMAP host, username and password. Save the config, then Start." });
      return;
    }

    let dead = false;
    let inFlight = false;
    const seen = new Set<string>();
    const everyMs = Math.max(10, cfg.poll_seconds || 30) * 1000;

    const poll = async () => {
      if (dead || inFlight) return;
      inFlight = true;
      try {
        const c = cfgRef.current!;
        const msgs = await invoke<EmailMsg[]>("email_poll", {
          imapHost: c.imap_host, imapPort: c.imap_port,
          username: c.username, password: c.password, max: 10,
        });
        if (dead) return;
        emitRuntimeStatus({ status: "running" });
        const allow = (c.allowed_senders || []).map((s) => s.toLowerCase());
        for (const m of msgs) {
          const from = (m.from || "").trim();
          if (!from) continue;
          if (m.messageId && seen.has(m.messageId)) continue;
          if (m.messageId) seen.add(m.messageId);
          if (allow.length > 0 && !allow.includes(from.toLowerCase())) continue;
          lastSubject.current[from] = m.subject || "";
          emitRuntimeStatus({ status: "running", seenFrom: from });
          const text = [m.subject ? `Subject: ${m.subject}` : "", m.body || ""].filter(Boolean).join("\n\n");
          await handleMessage(transport, toLite(c), from, text, []);
        }
      } catch (e: any) {
        if (!dead) emitRuntimeStatus({ status: "error", lastError: String(e?.message ?? e) });
      } finally {
        inFlight = false;
      }
    };

    poll();
    const id = window.setInterval(poll, everyMs);
    console.log(`[email] bridge polling every ${everyMs / 1000}s (${cfg.imap_host})`);
    return () => {
      dead = true;
      window.clearInterval(id);
      emitRuntimeStatus({ status: "stopped" });
      console.log("[email] bridge stopped");
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, cfg?.imap_host, cfg?.username, cfg?.password, cfg?.poll_seconds, cfg?.project_id, (cfg?.allowed_senders ?? []).join(",")]);

  return null;
}
