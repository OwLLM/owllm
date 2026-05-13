// BridgesPage — ported from LLM/desktop_app/pages/bridges_page.py
// (BridgesPage._build_ui, line 589). Two cards side by side:
//
//   ┌─ ✈ Telegram ─────────┐  ┌─ 🟢 WhatsApp ─────────┐
//   │ icon + title + status│  │ icon + title + status │
//   │ Bot token            │  │ Phone number ID       │
//   │ Allowed chat IDs     │  │ Access token          │
//   │ Project select       │  │ Webhook verify token  │
//   │ Auto-approve         │  │ Webhook URL           │
//   │ ▶ Start              │  │ ▶ Start               │
//   └──────────────────────┘  └───────────────────────┘
//
// Inputs are visual-only for now; saving runs through
// load_bridge_configs / save_telegram_config / save_whatsapp_config
// in the PySide6 version — those'll become /v1/bridges endpoints.
import React, { useState } from "react";

type BridgeStatus = "stopped" | "running" | "error";

function StatusDot({ state }: { state: BridgeStatus }) {
  const color = state === "running" ? "#22c55e"
              : state === "error"   ? "#ef4444"
              : "#9aa0a6";
  return (
    <span style={{
      width: 10, height: 10, borderRadius: 5,
      background: color, boxShadow: `0 0 6px ${color}`,
      flexShrink: 0,
    }} />
  );
}

function SectionLabel({ text }: { text: string }) {
  return (
    <div style={{
      color: "#9aa0a6", fontSize: 11, fontWeight: 600,
      letterSpacing: 0.6, textTransform: "uppercase",
      marginTop: 8,
    }}>
      {text}
    </div>
  );
}

function BridgeInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        height: 36, padding: "0 12px",
        borderRadius: 8, border: "1px solid rgba(255,255,255,0.10)",
        background: "rgba(0,0,0,0.30)",
        color: "#dadcdf", fontSize: 13,
        ...props.style,
      }}
    />
  );
}

function TelegramCard() {
  const [token, setToken] = useState("");
  const [chatIds, setChatIds] = useState("");
  const [project, setProject] = useState("psm");
  const [autoApprove, setAutoApprove] = useState(false);
  const [status, setStatus] = useState<BridgeStatus>("stopped");
  const accent = "#52b4ff";
  return (
    <div style={{
      flex: 1,
      background: "linear-gradient(180deg, #1c2540 0%, #131726 60%, #0e1220 100%)",
      borderRadius: 16,
      padding: "18px 20px",
      boxShadow: "0 4px 24px rgba(0,0,0,0.40)",
      display: "flex",
      flexDirection: "column",
      gap: 6,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ fontSize: 26, color: accent }}>✈</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: accent }}>Telegram</div>
          <div style={{ fontSize: 11, color: "#9aa0a6" }}>
            Bot token from @BotFather · long-poll · no public URL needed
          </div>
        </div>
        <StatusDot state={status} />
      </div>

      <SectionLabel text="Bot token" />
      <BridgeInput type="password" placeholder="123456:ABCdefGhi…" value={token} onChange={e => setToken(e.target.value)} />

      <SectionLabel text="Allowed chat IDs (optional)" />
      <BridgeInput
        placeholder="(leave empty = any chat allowed) · 123456789, 987654321"
        value={chatIds}
        onChange={e => setChatIds(e.target.value)}
      />

      <SectionLabel text="Project" />
      <select
        value={project}
        onChange={e => setProject(e.target.value)}
        style={{
          height: 36, padding: "0 12px",
          borderRadius: 8, border: "1px solid rgba(255,255,255,0.10)",
          background: "rgba(0,0,0,0.30)", color: "#fff", fontSize: 13,
        }}
      >
        <option value="psm">Product Studio Test</option>
        <option value="bug_hunter">Bug Hunter — esp-flash</option>
      </select>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#dadcdf", marginTop: 8 }}>
        <input
          type="checkbox"
          checked={autoApprove}
          onChange={e => setAutoApprove(e.target.checked)}
          style={{ accentColor: accent }}
        />
        Auto-approve every tool call (only for personal bots)
      </label>

      <div style={{ flex: 1 }} />
      <div style={{ fontSize: 11, color: "#9aa0a6", marginTop: 4 }}>
        {status === "running" ? "Running. Listening for messages." : "Stopped."}
      </div>
      <button
        onClick={() => setStatus(status === "running" ? "stopped" : "running")}
        style={{
          height: 38, marginTop: 6,
          background: status === "running"
            ? "rgba(239,68,68,0.18)"
            : "linear-gradient(180deg, #4CAF50, #388E3C)",
          color: status === "running" ? "#ff8c8c" : "#fff",
          border: status === "running" ? "1px solid rgba(239,68,68,0.55)" : "none",
          borderRadius: 8,
          fontSize: 13, fontWeight: 700,
          cursor: "pointer",
        }}
      >
        {status === "running" ? "⏹ Stop" : "▶ Start"}
      </button>
    </div>
  );
}

function WhatsAppCard() {
  const [phoneId,     setPhoneId]     = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [webhookUrl,  setWebhookUrl]  = useState("");
  const [project,     setProject]     = useState("psm");
  const [autoApprove, setAutoApprove] = useState(false);
  const [status,      setStatus]      = useState<BridgeStatus>("stopped");
  const accent = "#25d366";
  return (
    <div style={{
      flex: 1,
      background: "linear-gradient(180deg, #103027 0%, #15211c 60%, #0e1614 100%)",
      borderRadius: 16,
      padding: "18px 20px",
      boxShadow: "0 4px 24px rgba(0,0,0,0.40)",
      display: "flex",
      flexDirection: "column",
      gap: 6,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ fontSize: 26, color: accent }}>🟢</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: accent }}>WhatsApp Cloud API</div>
          <div style={{ fontSize: 11, color: "#9aa0a6" }}>
            Public webhook · point cloudflared / ngrok at the local port
          </div>
        </div>
        <StatusDot state={status} />
      </div>

      <SectionLabel text="Phone number ID" />
      <BridgeInput placeholder="From Meta App → WhatsApp → API setup" value={phoneId} onChange={e => setPhoneId(e.target.value)} />

      <SectionLabel text="Access token" />
      <BridgeInput type="password" placeholder="EAAB…" value={accessToken} onChange={e => setAccessToken(e.target.value)} />

      <SectionLabel text="Webhook verify token" />
      <BridgeInput placeholder="any-shared-secret" value={verifyToken} onChange={e => setVerifyToken(e.target.value)} />

      <SectionLabel text="Webhook URL (paste back into Meta App)" />
      <BridgeInput placeholder="https://your-tunnel.example.com/webhook" value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} />

      <SectionLabel text="Project" />
      <select
        value={project}
        onChange={e => setProject(e.target.value)}
        style={{
          height: 36, padding: "0 12px",
          borderRadius: 8, border: "1px solid rgba(255,255,255,0.10)",
          background: "rgba(0,0,0,0.30)", color: "#fff", fontSize: 13,
        }}
      >
        <option value="psm">Product Studio Test</option>
        <option value="customer_support">Customer Support — support</option>
      </select>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#dadcdf", marginTop: 8 }}>
        <input
          type="checkbox"
          checked={autoApprove}
          onChange={e => setAutoApprove(e.target.checked)}
          style={{ accentColor: accent }}
        />
        Auto-approve every tool call (only for personal bots)
      </label>

      <div style={{ flex: 1 }} />
      <div style={{ fontSize: 11, color: "#9aa0a6", marginTop: 4 }}>
        {status === "running" ? "Running. Webhook receiving." : "Stopped."}
      </div>
      <button
        onClick={() => setStatus(status === "running" ? "stopped" : "running")}
        style={{
          height: 38, marginTop: 6,
          background: status === "running"
            ? "rgba(239,68,68,0.18)"
            : "linear-gradient(180deg, #4CAF50, #388E3C)",
          color: status === "running" ? "#ff8c8c" : "#fff",
          border: status === "running" ? "1px solid rgba(239,68,68,0.55)" : "none",
          borderRadius: 8,
          fontSize: 13, fontWeight: 700,
          cursor: "pointer",
        }}
      >
        {status === "running" ? "⏹ Stop" : "▶ Start"}
      </button>
    </div>
  );
}

export default function BridgesPage() {
  return (
    <div style={{ padding: "24px 28px", height: "100%", display: "flex", flexDirection: "column", gap: 14, overflow: "auto" }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: "#fff" }}>Bridges</div>
      <div style={{ fontSize: 12, color: "#9aa0a6", maxWidth: 900, lineHeight: 1.5 }}>
        Drive your agent team from a phone. Telegram needs only a bot
        token; WhatsApp Cloud API needs a public webhook URL — point a
        tunnel (cloudflared / ngrok) at the local port and copy that
        URL into the Meta App webhook config.
      </div>
      <div style={{ flex: 1, display: "flex", gap: 18, minHeight: 0 }}>
        <TelegramCard />
        <WhatsAppCard />
      </div>
    </div>
  );
}
