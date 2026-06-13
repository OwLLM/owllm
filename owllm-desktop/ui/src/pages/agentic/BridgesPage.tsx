// BridgesPage — ported from LLM/desktop_app/pages/bridges_page.py
// (BridgesPage._build_ui, line 589). Two cards side by side, one per
// bridge. Each card mirrors the Qt _TelegramCard / _WhatsAppCard:
// inputs, allow-list, project selector, auto-approve, separate Start
// and Stop buttons, live status text and a colored status dot.
//
// Inputs are visual-only for now; saving runs through
// load_bridge_configs / save_telegram_config / save_whatsapp_config
// in the PySide6 version — those'll become /v1/bridges endpoints.
//
// NOTE: the Qt source uses literal unicode glyphs for the brand icons
// (Telegram '✈' line 103, WhatsApp '💬' line 381), not PNGs — there
// is no owl_telegram.png / owl_whatsapp.png in icons/Page_icons/, so
// we keep the same glyphs.
import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type BridgeStatus = "stopped" | "starting" | "running" | "error";

// Shapes mirror src-tauri/src/bridges.rs
type TelegramConfig = {
  bot_token: string;
  allowed_chat_ids: number[];
  project_id: string;
  auto_approve: boolean;
};
type WhatsAppConfig = {
  access_token: string;
  phone_number_id: string;
  verify_token: string;
  webhook_port: number;
  webhook_host: string;
  allowed_senders: string[];
  project_id: string;
  auto_approve: boolean;
};
type DiscordConfig = {
  bot_token: string;
  allowed_channel_ids: string[];
  project_id: string;
  auto_approve: boolean;
};
type SlackConfig = {
  app_token: string;
  bot_token: string;
  allowed_channel_ids: string[];
  project_id: string;
  auto_approve: boolean;
};
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
type LineConfig = { channel_access_token: string; channel_secret: string; allowed_users: string[]; project_id: string; auto_approve: boolean };
type BridgeConfigs = { telegram: TelegramConfig; whatsapp: WhatsAppConfig; discord: DiscordConfig; slack: SlackConfig; email: EmailConfig; line: LineConfig };

// Qt: 10x10 dot, running color #4caf50, stopped color #5a6376
// (bridges_page.py:350-352).
function StatusDot({ state }: { state: BridgeStatus }) {
  const color = state === "running" ? "#4caf50"
              : state === "starting" ? "#f2c94c"
              : state === "error"   ? "#ef4444"
              : "#5a6376";
  return (
    <span style={{
      width: 10, height: 10, borderRadius: 5,
      background: color,
      flexShrink: 0,
      alignSelf: "flex-start",
    }} />
  );
}

// Qt _section_label (bridges_page.py:65): #9aa0a6, 11px, weight 600,
// letter-spacing 0.6, uppercase, margin-top 4.
function SectionLabel({ text }: { text: string }) {
  return (
    <div style={{
      color: "var(--fg-muted)", fontSize: 11, fontWeight: 600,
      letterSpacing: 0.6, textTransform: "uppercase",
      marginTop: 4,
    }}>
      {text}
    </div>
  );
}

// Qt _INPUT_STYLE (bridges_page.py:57): border-radius 8, padding 0/12,
// font-size 13, min-height 30.
function BridgeInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        height: 30, padding: "0 12px",
        borderRadius: 8, border: "1px solid var(--border-strong)",
        background: "rgba(0,0,0,0.30)",
        color: "var(--fg)", fontSize: 13,
        outline: "none",
        ...props.style,
      }}
    />
  );
}

// Qt project_combo (bridges_page.py:158): min-height 32, palette(base)
// background, 8px radius, 12px padding, 13px font.
function ProjectSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      style={{
        height: 32, padding: "0 12px",
        borderRadius: 8, border: "1px solid var(--border-strong)",
        background: "rgba(0,0,0,0.30)", color: "var(--fg-strong)", fontSize: 13,
        outline: "none",
        ...props.style,
      }}
    />
  );
}

// Qt button heights: setMinimumHeight(34) (bridges_page.py:185, 193).
const BTN_HEIGHT = 34;

// Telegram start button style — Qt line 186: background #52b4ff.
function startButtonStyle(accent: string, hoverAccent: string, disabled: boolean): React.CSSProperties {
  return {
    height: BTN_HEIGHT,
    background: disabled ? "#2c313c" : accent,
    color: disabled ? "#777" : "#fff",
    border: "none",
    borderRadius: 8,
    padding: "0 18px",
    fontWeight: 600,
    fontSize: 13,
    cursor: disabled ? "default" : "pointer",
    flex: 1,
    // hover handled inline via onMouseEnter/Leave below — kept simple
    // and inline to match the file's existing approach.
    transition: "background 120ms",
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ...(hoverAccent ? {} : {}),
  };
}

// Stop button style — Qt line 193-199: rgba(255,140,140,0.12) bg,
// #ff8c8c text, no border, 8px radius, 18px padding.
function stopButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    height: BTN_HEIGHT,
    background: disabled ? "transparent" : "rgba(255,140,140,0.12)",
    color: disabled ? "#555" : "#ff8c8c",
    border: "none",
    borderRadius: 8,
    padding: "0 18px",
    fontWeight: 600,
    fontSize: 13,
    cursor: disabled ? "default" : "pointer",
  };
}

// ---------------------------------------------------------------------
// Telegram card — Qt _TelegramCard (bridges_page.py:80)
// ---------------------------------------------------------------------
// Shared sessionStorage key driving the live Telegram bridge in
// AgentsPage. Persisted across tab navigations so the user's Start
// click sticks. AgentsPage listens for `owllm:telegram:status` events
// dispatched alongside writes here.
const TELEGRAM_STARTED_KEY = "owllm:telegram:started";

function isTelegramStartedFromStorage(): boolean {
  try { return sessionStorage.getItem(TELEGRAM_STARTED_KEY) === "1"; }
  catch { return false; }
}

function setTelegramStartedInStorage(running: boolean) {
  try { sessionStorage.setItem(TELEGRAM_STARTED_KEY, running ? "1" : "0"); } catch {}
  // Same-tab listeners don't get a "storage" event, so emit a custom
  // event AgentsPage can subscribe to.
  try {
    window.dispatchEvent(new CustomEvent("owllm:telegram:status", { detail: running ? "running" : "stopped" }));
  } catch {}
}

// Real project list, fetched on mount. Mirrors the SQLite-backed list
// the agentic tab uses, so the bridge always binds to a real project id.
type ProjectLite = { id: string; name: string };

function TelegramCard() {
  const [token, setToken] = useState("");
  const [chatIds, setChatIds] = useState("");
  const [project, setProject] = useState("");
  const [autoApprove, setAutoApprove] = useState(false);
  // Initialize from persisted flag so navigating back to the page
  // doesn't reset the "Started" indicator.
  const [status, setStatus] = useState<BridgeStatus>(() =>
    isTelegramStartedFromStorage() ? "running" : "stopped"
  );
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectLite[]>([]);

  // Load persisted config from ~/.owllm/bridge_config.json so user
  // doesn't re-enter the bot token every launch.
  useEffect(() => {
    let dead = false;
    invoke<BridgeConfigs>("load_bridge_configs").then(c => {
      if (dead) return;
      const t = c.telegram;
      setToken(t.bot_token || "");
      setChatIds((t.allowed_chat_ids || []).join(", "));
      setProject(t.project_id || "");
      setAutoApprove(!!t.auto_approve);
    }).catch(() => { /* keep blank defaults */ });
    invoke<ProjectLite[]>("list_projects").then(rows => {
      if (dead) return;
      setProjects(rows.map(r => ({ id: r.id, name: r.name })));
    }).catch(() => { /* keep empty */ });
    return () => { dead = true; };
  }, []);

  async function persist() {
    setSaveError(null);
    const ids = chatIds.split(",")
      .map(s => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter(n => Number.isFinite(n));
    try {
      await invoke("save_telegram_config", {
        cfg: {
          bot_token: token,
          allowed_chat_ids: ids,
          project_id: project,
          auto_approve: autoApprove,
        } as TelegramConfig,
      });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1600);
    } catch (e) {
      setSaveError(String(e));
    }
  }
  // Last update_id surfaced in the running status text (Qt line 277-279).
  const [lastUpdateId, setLastUpdateId] = useState<number>(0);
  const [lastError, setLastError] = useState<string>("");
  // Chats that have actually messaged the bot since start — Qt line
  // 307-335 renders these as clickable chips that add to the allow-list.
  const [seenIds, setSeenIds] = useState<number[]>([]);

  useEffect(() => {
    const onRuntime = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      if (d.status === "running" || d.status === "stopped" || d.status === "error") {
        setStatus(d.status);
      }
      if (typeof d.lastUpdateId === "number") setLastUpdateId(d.lastUpdateId);
      if (typeof d.lastError === "string") setLastError(d.lastError);
      if (typeof d.seenChatId === "number") {
        setSeenIds(prev => prev.includes(d.seenChatId) ? prev : [...prev, d.seenChatId]);
      }
      if (d.status === "running") setLastError("");
    };
    window.addEventListener("owllm:telegram:runtime", onRuntime as EventListener);
    return () => window.removeEventListener("owllm:telegram:runtime", onRuntime as EventListener);
  }, []);

  // Qt accent for Telegram (#52b4ff, lines 106/112/186).
  const accent = "#52b4ff";

  const running = status === "running";
  const active = status === "starting" || status === "running";
  const existingIds = new Set(
    chatIds.split(",").map(s => s.trim()).filter(Boolean).map(Number).filter(n => !Number.isNaN(n))
  );
  const allowListActive = existingIds.size > 0;

  // Status text — mirrors _TelegramCard.refresh_status (Qt 270-294).
  const statusText = running
    ? `Running — last update_id ${lastUpdateId}.${allowListActive ? " · allow-list active" : " · open (any chat)"}`
    : status === "starting"
      ? "Starting — waiting for Telegram getUpdates to succeed."
    : status === "error"
      ? `Error — ${lastError || "Telegram polling is not connected."}`
      : (lastError ? `Stopped — last error: ${lastError}` : "Stopped.");

  function addSeenId(cid: number) {
    if (existingIds.has(cid)) return;
    const next = [...existingIds, cid].map(String).join(", ");
    setChatIds(next);
  }

  return (
    <div style={{
      flex: 1,
      // Qt gradient: stop:0 #1c2540 → stop:0.6 palette(base) → stop:1 palette(base)
      // palette(base) under dark theme is roughly #0e1117 (page bg).
      background: "linear-gradient(180deg, #1c2540 0%, #0e1117 60%, #0e1117 100%)",
      border: "none",
      borderRadius: 16,
      // Qt outer margins (20, 18, 20, 18), spacing 10.
      padding: "18px 20px",
      // Qt _add_shadow: blur 24, y-offset 4, alpha 110.
      boxShadow: "0 4px 24px rgba(0,0,0,0.43)",
      display: "flex",
      flexDirection: "column",
      gap: 10,
      minWidth: 320,
    }}>
      {/* Header — icon + title + subtitle + dot (Qt 101-121). */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ fontSize: 26, color: accent, lineHeight: 1, fontFamily: "Segoe UI Symbol, sans-serif" }}>✈</div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: accent }}>Telegram</div>
          <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>
            Bot token from @BotFather · long-poll · no public URL needed
          </div>
        </div>
        <StatusDot state={status} />
      </div>

      {/* Bot token (Qt 124-129). */}
      <SectionLabel text="Bot token" />
      <BridgeInput
        type="password"
        placeholder="123456:ABCdefGhi…"
        value={token}
        onChange={e => setToken(e.target.value)}
      />

      {/* Allowed chat IDs — OPTIONAL with explicit empty hint (Qt 133-139). */}
      <SectionLabel text="Allowed chat IDs (optional)" />
      <BridgeInput
        placeholder="(leave empty = any chat allowed) · 123456789, 987654321"
        value={chatIds}
        onChange={e => setChatIds(e.target.value)}
      />

      {/* Seen-chat-ID chip row — hidden until at least one ID is
          discovered (Qt 144-154, 307-335). Caps at first 5 chips. */}
      {seenIds.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ color: "var(--fg-muted)", fontSize: 11 }}>Seen chats:</span>
          {seenIds.slice(0, 5).map(cid => {
            const known = existingIds.has(cid);
            return (
              <button
                key={cid}
                disabled={known}
                onClick={() => addSeenId(cid)}
                style={{
                  // Qt chip: rgba(82,180,255,0.15) bg, #52b4ff text,
                  // 10px radius, padding 2/8, font-size 10 (Qt 322-326).
                  background: "rgba(82,180,255,0.15)",
                  color: accent,
                  border: "none",
                  borderRadius: 10,
                  padding: "2px 8px",
                  fontSize: 10,
                  cursor: known ? "default" : "pointer",
                  opacity: known ? 0.6 : 1,
                }}
              >
                {cid}{known ? "  ✓" : "  + add"}
              </button>
            );
          })}
        </div>
      )}

      {/* Project (Qt 156-163). Real list from list_projects so the
          bridge binds to a project that actually exists. */}
      <SectionLabel text="Project" />
      <ProjectSelect value={project} onChange={e => setProject(e.target.value)}>
        <option value="">(no project)</option>
        {projects.map(p => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </ProjectSelect>

      {/* Auto-approve — Qt label verbatim (line 167). */}
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--fg)" }}>
        <input
          type="checkbox"
          checked={autoApprove}
          onChange={e => setAutoApprove(e.target.checked)}
          style={{ accentColor: accent }}
        />
        Auto-approve every tool call (only for personal bots)
      </label>

      <div style={{ flex: 1 }} />

      {/* Status text — Qt 174-179. */}
      <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>{statusText}</div>
      {saveError ? (
        <div style={{ fontSize: 11, color: "#ffb0b0" }}>{saveError}</div>
      ) : null}

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          onClick={persist}
          style={{
            height: BTN_HEIGHT, padding: "0 14px",
            background: "var(--bg-surface)",
            color: "var(--fg)",
            border: "1px solid var(--border-strong)",
            borderRadius: 8, fontWeight: 600, fontSize: 12,
            cursor: "pointer",
          }}
          title="Persist these settings to ~/.owllm/bridge_config.json"
        >💾 Save</button>
        {savedFlash ? (
          <span style={{ fontSize: 11, color: "#4caf50", fontWeight: 700 }}>✓ Saved</span>
        ) : null}
        <div style={{ flex: 1 }} />
        <button
          disabled={active}
          onClick={async () => {
            // Save first so the bridge has fresh config to read.
            await persist();
            setStatus("starting");
            setTelegramStartedInStorage(true);
          }}
          style={startButtonStyle(accent, "#62c4ff", active)}
        >
          Start
        </button>
        <button
          disabled={!active}
          onClick={() => {
            setStatus("stopped");
            setTelegramStartedInStorage(false);
          }}
          style={stopButtonStyle(!active)}
        >
          Stop
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// WhatsApp card — Qt _WhatsAppCard (bridges_page.py:360). Inbound webhook,
// driven by the shared WebhookBridgeRunner via owllm:whatsapp:started/status.
// ---------------------------------------------------------------------
const WHATSAPP_STARTED_KEY = "owllm:whatsapp:started";
function isWhatsappStartedFromStorage(): boolean {
  try { return sessionStorage.getItem(WHATSAPP_STARTED_KEY) === "1"; } catch { return false; }
}
function setWhatsappStartedInStorage(running: boolean) {
  try { sessionStorage.setItem(WHATSAPP_STARTED_KEY, running ? "1" : "0"); } catch {}
  try { window.dispatchEvent(new CustomEvent("owllm:whatsapp:status", { detail: running ? "running" : "stopped" })); } catch {}
}

function WhatsAppCard() {
  const [token, setToken] = useState("");
  const [phoneId, setPhoneId] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [senders, setSenders] = useState("");
  // Qt port range 1024-65535, default 8911 (bridges_page.py:430-431).
  const [port, setPort] = useState<number>(8911);
  const [project, setProject] = useState("");
  const [autoApprove, setAutoApprove] = useState(false);
  const [status, setStatus] = useState<BridgeStatus>(() => isWhatsappStartedFromStorage() ? "running" : "stopped");
  const [lastError, setLastError] = useState<string>("");
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectLite[]>([]);

  useEffect(() => {
    let dead = false;
    invoke<ProjectLite[]>("list_projects").then(rows => { if (!dead) setProjects(rows.map(r => ({ id: r.id, name: r.name }))); }).catch(() => {});
    const onRuntime = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      if (d.status === "running" || d.status === "stopped" || d.status === "error") setStatus(d.status);
      if (typeof d.lastError === "string") setLastError(d.lastError);
      if (d.status === "running") setLastError("");
    };
    window.addEventListener("owllm:whatsapp:runtime", onRuntime as EventListener);
    return () => { dead = true; window.removeEventListener("owllm:whatsapp:runtime", onRuntime as EventListener); };
  }, []);

  useEffect(() => {
    let dead = false;
    invoke<BridgeConfigs>("load_bridge_configs").then(c => {
      if (dead) return;
      const w = c.whatsapp;
      setToken(w.access_token || "");
      setPhoneId(w.phone_number_id || "");
      setVerifyToken(w.verify_token || "");
      setSenders((w.allowed_senders || []).join(", "));
      setPort(w.webhook_port || 8911);
      setProject(w.project_id || "");
      setAutoApprove(!!w.auto_approve);
    }).catch(() => { /* keep blank defaults */ });
    return () => { dead = true; };
  }, []);

  async function persist() {
    setSaveError(null);
    const allow = senders.split(",").map(s => s.trim()).filter(Boolean);
    try {
      await invoke("save_whatsapp_config", {
        cfg: {
          access_token: token,
          phone_number_id: phoneId,
          verify_token: verifyToken,
          webhook_port: port,
          webhook_host: "0.0.0.0",
          allowed_senders: allow,
          project_id: project,
          auto_approve: autoApprove,
        } as WhatsAppConfig,
      });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1600);
    } catch (e) {
      setSaveError(String(e));
    }
  }

  // Qt accent for WhatsApp (#10a37f, lines 390/460).
  const accent = "#10a37f";

  const running = status === "running";
  const active = status === "starting" || status === "running";

  // Status text mirrors _WhatsAppCard.refresh_status (Qt 535-551).
  const bind = `0.0.0.0:${port}`;
  const statusText = running
    ? `Listening on ${bind} — point your tunnel at this port; webhook callback URL = <tunnel>/whatsapp.`
    : status === "starting" ? "Starting — binding the webhook listener."
    : status === "error" ? `Error — ${lastError || "Could not bind the webhook port."}`
    : (lastError ? `Stopped — last error: ${lastError}` : "Stopped.");

  return (
    <div style={{
      flex: 1,
      // Qt gradient: stop:0 #16322a → stop:0.6 palette(base) → stop:1 palette(base) (line 364-370).
      background: "linear-gradient(180deg, #16322a 0%, #0e1117 60%, #0e1117 100%)",
      border: "none",
      borderRadius: 16,
      padding: "18px 20px",
      boxShadow: "0 4px 24px rgba(0,0,0,0.43)",
      display: "flex",
      flexDirection: "column",
      gap: 10,
      minWidth: 320,
    }}>
      {/* Header — Qt 380-399. WhatsApp uses the 💬 glyph (no color tint
          on the icon — Qt line 384). */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ fontSize: 26, lineHeight: 1, fontFamily: "Segoe UI Emoji, sans-serif" }}>💬</div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: accent }}>WhatsApp</div>
          <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>
            Meta Cloud API · webhook needs a public URL (cloudflared/ngrok)
          </div>
        </div>
        <StatusDot state={status} />
      </div>

      {/* Qt uses a QGridLayout from line 402 for the WhatsApp fields:
          Row 0-1: Access token (full width)
          Row 2-3: Phone number ID | Verify token
          Row 4-5: Allowed senders (full width)
          Row 6-7: Webhook port | Project */}

      {/* Access token (Qt 406-410). */}
      <SectionLabel text="Access token" />
      <BridgeInput
        type="password"
        value={token}
        onChange={e => setToken(e.target.value)}
      />

      {/* Phone number ID + Verify token side by side (Qt 412-419). */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <SectionLabel text="Phone number ID" />
          <BridgeInput value={phoneId} onChange={e => setPhoneId(e.target.value)} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <SectionLabel text="Verify token" />
          <BridgeInput value={verifyToken} onChange={e => setVerifyToken(e.target.value)} />
        </div>
      </div>

      {/* Allowed senders — comma-separated E.164 (Qt 421-425). */}
      <SectionLabel text="Allowed senders (comma E.164)" />
      <BridgeInput
        placeholder="393331234567, 14155551234"
        value={senders}
        onChange={e => setSenders(e.target.value)}
      />

      {/* Webhook port + Project (Qt 427-440). */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <SectionLabel text="Webhook port" />
          <BridgeInput
            type="number"
            min={1024}
            max={65535}
            value={port}
            onChange={e => {
              const n = parseInt(e.target.value, 10);
              if (!Number.isNaN(n)) setPort(Math.max(1024, Math.min(65535, n)));
            }}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <SectionLabel text="Project" />
          <ProjectSelect value={project} onChange={e => setProject(e.target.value)}>
            <option value="">(no project)</option>
            {projects.map(p => (<option key={p.id} value={p.id}>{p.name}</option>))}
          </ProjectSelect>
        </div>
      </div>

      {/* Auto-approve — Qt label verbatim (line 443). No parenthetical
          here, unlike Telegram. */}
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--fg)" }}>
        <input
          type="checkbox"
          checked={autoApprove}
          onChange={e => setAutoApprove(e.target.checked)}
          style={{ accentColor: accent }}
        />
        Auto-approve every tool call
      </label>

      <div style={{ flex: 1 }} />

      <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>{statusText}</div>
      {saveError ? (
        <div style={{ fontSize: 11, color: "#ffb0b0" }}>{saveError}</div>
      ) : null}

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          onClick={persist}
          style={{
            height: BTN_HEIGHT, padding: "0 14px",
            background: "var(--bg-surface)",
            color: "var(--fg)",
            border: "1px solid var(--border-strong)",
            borderRadius: 8, fontWeight: 600, fontSize: 12,
            cursor: "pointer",
          }}
          title="Persist these settings to ~/.owllm/bridge_config.json"
        >💾 Save</button>
        {savedFlash ? (
          <span style={{ fontSize: 11, color: "#4caf50", fontWeight: 700 }}>✓ Saved</span>
        ) : null}
        <div style={{ flex: 1 }} />
        <button
          disabled={active}
          onClick={async () => { await persist(); setStatus("starting"); setWhatsappStartedInStorage(true); }}
          style={startButtonStyle(accent, "#22b88f", active)}
        >
          Start
        </button>
        <button
          disabled={!active}
          onClick={() => { setStatus("stopped"); setWhatsappStartedInStorage(false); }}
          style={stopButtonStyle(!active)}
        >
          Stop
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Discord card — connects outbound via the gateway WebSocket (no public URL).
// Drives DiscordBridgeRunner the same way TelegramCard drives its runner:
// a sessionStorage flag + an "owllm:discord:status" event, with live state
// fed back via "owllm:discord:runtime".
// ---------------------------------------------------------------------
const DISCORD_STARTED_KEY = "owllm:discord:started";

function isDiscordStartedFromStorage(): boolean {
  try { return sessionStorage.getItem(DISCORD_STARTED_KEY) === "1"; } catch { return false; }
}
function setDiscordStartedInStorage(running: boolean) {
  try { sessionStorage.setItem(DISCORD_STARTED_KEY, running ? "1" : "0"); } catch {}
  try { window.dispatchEvent(new CustomEvent("owllm:discord:status", { detail: running ? "running" : "stopped" })); } catch {}
}

function DiscordCard() {
  const [token, setToken] = useState("");
  const [channelIds, setChannelIds] = useState("");
  const [project, setProject] = useState("");
  const [autoApprove, setAutoApprove] = useState(false);
  const [status, setStatus] = useState<BridgeStatus>(() =>
    isDiscordStartedFromStorage() ? "running" : "stopped"
  );
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [lastError, setLastError] = useState<string>("");
  const [seenIds, setSeenIds] = useState<string[]>([]);

  useEffect(() => {
    let dead = false;
    invoke<BridgeConfigs>("load_bridge_configs").then(c => {
      if (dead) return;
      const d = c.discord;
      setToken(d.bot_token || "");
      setChannelIds((d.allowed_channel_ids || []).join(", "));
      setProject(d.project_id || "");
      setAutoApprove(!!d.auto_approve);
    }).catch(() => {});
    invoke<ProjectLite[]>("list_projects").then(rows => {
      if (dead) return;
      setProjects(rows.map(r => ({ id: r.id, name: r.name })));
    }).catch(() => {});
    return () => { dead = true; };
  }, []);

  useEffect(() => {
    const onRuntime = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      if (d.status === "running" || d.status === "stopped" || d.status === "error") setStatus(d.status);
      if (typeof d.lastError === "string") setLastError(d.lastError);
      if (typeof d.seenChannelId === "string") {
        setSeenIds(prev => prev.includes(d.seenChannelId) ? prev : [...prev, d.seenChannelId]);
      }
      if (d.status === "running") setLastError("");
    };
    window.addEventListener("owllm:discord:runtime", onRuntime as EventListener);
    return () => window.removeEventListener("owllm:discord:runtime", onRuntime as EventListener);
  }, []);

  async function persist() {
    setSaveError(null);
    const ids = channelIds.split(",").map(s => s.trim()).filter(Boolean);
    try {
      await invoke("save_discord_config", {
        cfg: {
          bot_token: token,
          allowed_channel_ids: ids,
          project_id: project,
          auto_approve: autoApprove,
        } as DiscordConfig,
      });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1600);
    } catch (e) {
      setSaveError(String(e));
    }
  }

  // Discord blurple.
  const accent = "#5865F2";
  const running = status === "running";
  const active = status === "starting" || status === "running";
  const existingIds = new Set(channelIds.split(",").map(s => s.trim()).filter(Boolean));
  const allowListActive = existingIds.size > 0;

  const statusText = running
    ? `Running — gateway connected.${allowListActive ? " · allow-list active" : " · open (any channel the bot sees)"}`
    : status === "starting"
      ? "Starting — connecting to the Discord gateway."
    : status === "error"
      ? `Error — ${lastError || "Gateway not connected."}`
      : (lastError ? `Stopped — last error: ${lastError}` : "Stopped.");

  function addSeenId(cid: string) {
    if (existingIds.has(cid)) return;
    const next = [...existingIds, cid].join(", ");
    setChannelIds(next);
  }

  return (
    <div style={{
      flex: 1,
      background: "linear-gradient(180deg, #2b2d52 0%, #0e1117 60%, #0e1117 100%)",
      border: "none",
      borderRadius: 16,
      padding: "18px 20px",
      boxShadow: "0 4px 24px rgba(0,0,0,0.43)",
      display: "flex",
      flexDirection: "column",
      gap: 10,
      minWidth: 320,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ fontSize: 26, color: accent, lineHeight: 1, fontFamily: "Segoe UI Emoji, sans-serif" }}>🎮</div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: accent }}>Discord</div>
          <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>
            Bot token · gateway WebSocket · no public URL needed
          </div>
        </div>
        <StatusDot state={status} />
      </div>

      <SectionLabel text="Bot token" />
      <BridgeInput
        type="password"
        placeholder="Bot token from the Developer Portal"
        value={token}
        onChange={e => setToken(e.target.value)}
      />

      <SectionLabel text="Allowed channel IDs (optional)" />
      <BridgeInput
        placeholder="(leave empty = any channel) · 112233445566778899, …"
        value={channelIds}
        onChange={e => setChannelIds(e.target.value)}
      />

      {seenIds.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ color: "var(--fg-muted)", fontSize: 11 }}>Seen channels:</span>
          {seenIds.slice(0, 5).map(cid => {
            const known = existingIds.has(cid);
            return (
              <button
                key={cid}
                disabled={known}
                onClick={() => addSeenId(cid)}
                style={{
                  background: "rgba(88,101,242,0.18)",
                  color: accent, border: "none", borderRadius: 10,
                  padding: "2px 8px", fontSize: 10,
                  cursor: known ? "default" : "pointer", opacity: known ? 0.6 : 1,
                }}
              >
                {cid}{known ? "  ✓" : "  + add"}
              </button>
            );
          })}
        </div>
      )}

      <SectionLabel text="Project" />
      <ProjectSelect value={project} onChange={e => setProject(e.target.value)}>
        <option value="">(no project)</option>
        {projects.map(p => (<option key={p.id} value={p.id}>{p.name}</option>))}
      </ProjectSelect>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--fg)" }}>
        <input type="checkbox" checked={autoApprove} onChange={e => setAutoApprove(e.target.checked)} style={{ accentColor: accent }} />
        Auto-approve every tool call (only for personal bots)
      </label>

      <div style={{ fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.4 }}>
        Enable the <b>Message Content</b> intent for this bot in the Discord
        Developer Portal, or message text arrives empty.
      </div>

      <div style={{ flex: 1 }} />

      <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>{statusText}</div>
      {saveError ? (<div style={{ fontSize: 11, color: "#ffb0b0" }}>{saveError}</div>) : null}

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          onClick={persist}
          style={{
            height: BTN_HEIGHT, padding: "0 14px",
            background: "var(--bg-surface)", color: "var(--fg)",
            border: "1px solid var(--border-strong)", borderRadius: 8,
            fontWeight: 600, fontSize: 12, cursor: "pointer",
          }}
          title="Persist these settings to ~/.owllm/bridge_config.json"
        >💾 Save</button>
        {savedFlash ? (<span style={{ fontSize: 11, color: "#4caf50", fontWeight: 700 }}>✓ Saved</span>) : null}
        <div style={{ flex: 1 }} />
        <button
          disabled={active}
          onClick={async () => { await persist(); setStatus("starting"); setDiscordStartedInStorage(true); }}
          style={startButtonStyle(accent, "#6b78f5", active)}
        >Start</button>
        <button
          disabled={!active}
          onClick={() => { setStatus("stopped"); setDiscordStartedInStorage(false); }}
          style={stopButtonStyle(!active)}
        >Stop</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Slack card — connects outbound via Socket Mode (no public URL). Drives
// SlackBridgeRunner via the owllm:slack:started flag + status/runtime events.
// ---------------------------------------------------------------------
const SLACK_STARTED_KEY = "owllm:slack:started";
function isSlackStartedFromStorage(): boolean {
  try { return sessionStorage.getItem(SLACK_STARTED_KEY) === "1"; } catch { return false; }
}
function setSlackStartedInStorage(running: boolean) {
  try { sessionStorage.setItem(SLACK_STARTED_KEY, running ? "1" : "0"); } catch {}
  try { window.dispatchEvent(new CustomEvent("owllm:slack:status", { detail: running ? "running" : "stopped" })); } catch {}
}

function SlackCard() {
  const [appToken, setAppToken] = useState("");
  const [botToken, setBotToken] = useState("");
  const [channelIds, setChannelIds] = useState("");
  const [project, setProject] = useState("");
  const [autoApprove, setAutoApprove] = useState(false);
  const [status, setStatus] = useState<BridgeStatus>(() => isSlackStartedFromStorage() ? "running" : "stopped");
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [lastError, setLastError] = useState<string>("");

  useEffect(() => {
    let dead = false;
    invoke<BridgeConfigs>("load_bridge_configs").then(c => {
      if (dead) return;
      const s = c.slack;
      setAppToken(s.app_token || "");
      setBotToken(s.bot_token || "");
      setChannelIds((s.allowed_channel_ids || []).join(", "));
      setProject(s.project_id || "");
      setAutoApprove(!!s.auto_approve);
    }).catch(() => {});
    invoke<ProjectLite[]>("list_projects").then(rows => { if (!dead) setProjects(rows.map(r => ({ id: r.id, name: r.name }))); }).catch(() => {});
    return () => { dead = true; };
  }, []);

  useEffect(() => {
    const onRuntime = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      if (d.status === "running" || d.status === "stopped" || d.status === "error") setStatus(d.status);
      if (typeof d.lastError === "string") setLastError(d.lastError);
      if (d.status === "running") setLastError("");
    };
    window.addEventListener("owllm:slack:runtime", onRuntime as EventListener);
    return () => window.removeEventListener("owllm:slack:runtime", onRuntime as EventListener);
  }, []);

  async function persist() {
    setSaveError(null);
    const ids = channelIds.split(",").map(s => s.trim()).filter(Boolean);
    try {
      await invoke("save_slack_config", {
        cfg: { app_token: appToken, bot_token: botToken, allowed_channel_ids: ids, project_id: project, auto_approve: autoApprove } as SlackConfig,
      });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1600);
    } catch (e) { setSaveError(String(e)); }
  }

  const accent = "#8a4ea3"; // Slack aubergine (lightened for dark theme)
  const active = status === "starting" || status === "running";
  const running = status === "running";
  const allowListActive = channelIds.split(",").map(s => s.trim()).filter(Boolean).length > 0;
  const statusText = running
    ? `Running — Socket Mode connected.${allowListActive ? " · allow-list active" : " · open (any channel the bot is in)"}`
    : status === "starting" ? "Starting — opening Socket Mode connection."
    : status === "error" ? `Error — ${lastError || "Not connected."}`
    : (lastError ? `Stopped — last error: ${lastError}` : "Stopped.");

  return (
    <div style={{
      flex: 1,
      background: "linear-gradient(180deg, #2e1b33 0%, #0e1117 60%, #0e1117 100%)",
      border: "none", borderRadius: 16, padding: "18px 20px",
      boxShadow: "0 4px 24px rgba(0,0,0,0.43)", display: "flex", flexDirection: "column", gap: 10, minWidth: 320,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ fontSize: 26, color: accent, lineHeight: 1, fontWeight: 800 }}>#</div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: accent }}>Slack</div>
          <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>
            Socket Mode · app + bot token · no public URL needed
          </div>
        </div>
        <StatusDot state={status} />
      </div>

      <SectionLabel text="App-level token (xapp-…)" />
      <BridgeInput type="password" placeholder="xapp-… (Socket Mode, connections:write)" value={appToken} onChange={e => setAppToken(e.target.value)} />

      <SectionLabel text="Bot token (xoxb-…)" />
      <BridgeInput type="password" placeholder="xoxb-… (chat:write, files:read)" value={botToken} onChange={e => setBotToken(e.target.value)} />

      <SectionLabel text="Allowed channel IDs (optional)" />
      <BridgeInput placeholder="(leave empty = any channel the bot is in) · C0123…, D0456…" value={channelIds} onChange={e => setChannelIds(e.target.value)} />

      <SectionLabel text="Project" />
      <ProjectSelect value={project} onChange={e => setProject(e.target.value)}>
        <option value="">(no project)</option>
        {projects.map(p => (<option key={p.id} value={p.id}>{p.name}</option>))}
      </ProjectSelect>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--fg)" }}>
        <input type="checkbox" checked={autoApprove} onChange={e => setAutoApprove(e.target.checked)} style={{ accentColor: accent }} />
        Auto-approve every tool call (only for personal bots)
      </label>

      <div style={{ fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.4 }}>
        In your Slack app: turn on <b>Socket Mode</b>, and under Event Subscriptions
        subscribe the bot to <code>message.channels</code> / <code>message.im</code>.
      </div>

      <div style={{ flex: 1 }} />

      <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>{statusText}</div>
      {saveError ? (<div style={{ fontSize: 11, color: "#ffb0b0" }}>{saveError}</div>) : null}

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={persist} style={{ height: BTN_HEIGHT, padding: "0 14px", background: "var(--bg-surface)", color: "var(--fg)", border: "1px solid var(--border-strong)", borderRadius: 8, fontWeight: 600, fontSize: 12, cursor: "pointer" }} title="Persist to ~/.owllm/bridge_config.json">💾 Save</button>
        {savedFlash ? (<span style={{ fontSize: 11, color: "#4caf50", fontWeight: 700 }}>✓ Saved</span>) : null}
        <div style={{ flex: 1 }} />
        <button disabled={active} onClick={async () => { await persist(); setStatus("starting"); setSlackStartedInStorage(true); }} style={startButtonStyle(accent, "#a165bb", active)}>Start</button>
        <button disabled={!active} onClick={() => { setStatus("stopped"); setSlackStartedInStorage(false); }} style={stopButtonStyle(!active)}>Stop</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Email card — IMAP receive + SMTP send (no public URL). Drives
// EmailBridgeRunner via owllm:email:started + status/runtime events.
// ---------------------------------------------------------------------
const EMAIL_STARTED_KEY = "owllm:email:started";
function isEmailStartedFromStorage(): boolean {
  try { return sessionStorage.getItem(EMAIL_STARTED_KEY) === "1"; } catch { return false; }
}
function setEmailStartedInStorage(running: boolean) {
  try { sessionStorage.setItem(EMAIL_STARTED_KEY, running ? "1" : "0"); } catch {}
  try { window.dispatchEvent(new CustomEvent("owllm:email:status", { detail: running ? "running" : "stopped" })); } catch {}
}

function EmailCard() {
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState<number>(993);
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState<number>(587);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fromAddr, setFromAddr] = useState("");
  const [senders, setSenders] = useState("");
  const [pollSeconds, setPollSeconds] = useState<number>(30);
  const [project, setProject] = useState("");
  const [autoApprove, setAutoApprove] = useState(false);
  const [status, setStatus] = useState<BridgeStatus>(() => isEmailStartedFromStorage() ? "running" : "stopped");
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [lastError, setLastError] = useState<string>("");

  useEffect(() => {
    let dead = false;
    invoke<BridgeConfigs>("load_bridge_configs").then(c => {
      if (dead) return;
      const e = c.email;
      setImapHost(e.imap_host || ""); setImapPort(e.imap_port || 993);
      setSmtpHost(e.smtp_host || ""); setSmtpPort(e.smtp_port || 587);
      setUsername(e.username || ""); setPassword(e.password || "");
      setFromAddr(e.from_addr || "");
      setSenders((e.allowed_senders || []).join(", "));
      setPollSeconds(e.poll_seconds || 30);
      setProject(e.project_id || ""); setAutoApprove(!!e.auto_approve);
    }).catch(() => {});
    invoke<ProjectLite[]>("list_projects").then(rows => { if (!dead) setProjects(rows.map(r => ({ id: r.id, name: r.name }))); }).catch(() => {});
    return () => { dead = true; };
  }, []);

  useEffect(() => {
    const onRuntime = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      if (d.status === "running" || d.status === "stopped" || d.status === "error") setStatus(d.status);
      if (typeof d.lastError === "string") setLastError(d.lastError);
      if (d.status === "running") setLastError("");
    };
    window.addEventListener("owllm:email:runtime", onRuntime as EventListener);
    return () => window.removeEventListener("owllm:email:runtime", onRuntime as EventListener);
  }, []);

  async function persist() {
    setSaveError(null);
    const allow = senders.split(",").map(s => s.trim()).filter(Boolean);
    try {
      await invoke("save_email_config", {
        cfg: {
          imap_host: imapHost, imap_port: imapPort, smtp_host: smtpHost, smtp_port: smtpPort,
          username, password, from_addr: fromAddr, allowed_senders: allow,
          poll_seconds: pollSeconds, project_id: project, auto_approve: autoApprove,
        } as EmailConfig,
      });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1600);
    } catch (e) { setSaveError(String(e)); }
  }

  const accent = "#e0884a"; // amber/envelope
  const active = status === "starting" || status === "running";
  const running = status === "running";
  const allowListActive = senders.split(",").map(s => s.trim()).filter(Boolean).length > 0;
  const statusText = running
    ? `Running — polling ${imapHost} every ${pollSeconds}s.${allowListActive ? " · sender allow-list active" : " · any sender"}`
    : status === "starting" ? "Starting — connecting to IMAP."
    : status === "error" ? `Error — ${lastError || "Not connected."}`
    : (lastError ? `Stopped — last error: ${lastError}` : "Stopped.");

  return (
    <div style={{
      flex: 1,
      background: "linear-gradient(180deg, #33271a 0%, #0e1117 60%, #0e1117 100%)",
      border: "none", borderRadius: 16, padding: "18px 20px",
      boxShadow: "0 4px 24px rgba(0,0,0,0.43)", display: "flex", flexDirection: "column", gap: 10, minWidth: 320,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ fontSize: 26, lineHeight: 1 }}>✉️</div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: accent }}>Email</div>
          <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>IMAP + SMTP · use a dedicated mailbox · no public URL</div>
        </div>
        <StatusDot state={status} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <SectionLabel text="IMAP host" />
          <BridgeInput placeholder="imap.gmail.com" value={imapHost} onChange={e => setImapHost(e.target.value)} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <SectionLabel text="IMAP port" />
          <BridgeInput type="number" value={imapPort} onChange={e => { const n = parseInt(e.target.value, 10); if (!Number.isNaN(n)) setImapPort(n); }} />
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <SectionLabel text="SMTP host" />
          <BridgeInput placeholder="smtp.gmail.com" value={smtpHost} onChange={e => setSmtpHost(e.target.value)} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <SectionLabel text="SMTP port" />
          <BridgeInput type="number" value={smtpPort} onChange={e => { const n = parseInt(e.target.value, 10); if (!Number.isNaN(n)) setSmtpPort(n); }} />
        </div>
      </div>

      <SectionLabel text="Username / email" />
      <BridgeInput placeholder="bot@example.com" value={username} onChange={e => setUsername(e.target.value)} />

      <SectionLabel text="Password (app password recommended)" />
      <BridgeInput type="password" value={password} onChange={e => setPassword(e.target.value)} />

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <SectionLabel text="Allowed senders (optional)" />
          <BridgeInput placeholder="(empty = any) alice@x.com, bob@y.com" value={senders} onChange={e => setSenders(e.target.value)} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <SectionLabel text="Poll (sec)" />
          <BridgeInput type="number" min={10} value={pollSeconds} onChange={e => { const n = parseInt(e.target.value, 10); if (!Number.isNaN(n)) setPollSeconds(Math.max(10, n)); }} />
        </div>
      </div>

      <SectionLabel text="Project" />
      <ProjectSelect value={project} onChange={e => setProject(e.target.value)}>
        <option value="">(no project)</option>
        {projects.map(p => (<option key={p.id} value={p.id}>{p.name}</option>))}
      </ProjectSelect>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--fg)" }}>
        <input type="checkbox" checked={autoApprove} onChange={e => setAutoApprove(e.target.checked)} style={{ accentColor: accent }} />
        Auto-approve every tool call (only for personal bots)
      </label>

      <div style={{ fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.4 }}>
        Use a <b>dedicated mailbox</b> — the bridge marks inbound mail as read as
        it processes it. For Gmail/Outlook, create an <b>app password</b>.
      </div>

      <div style={{ flex: 1 }} />

      <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>{statusText}</div>
      {saveError ? (<div style={{ fontSize: 11, color: "#ffb0b0" }}>{saveError}</div>) : null}

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={persist} style={{ height: BTN_HEIGHT, padding: "0 14px", background: "var(--bg-surface)", color: "var(--fg)", border: "1px solid var(--border-strong)", borderRadius: 8, fontWeight: 600, fontSize: 12, cursor: "pointer" }} title="Persist to ~/.owllm/bridge_config.json">💾 Save</button>
        {savedFlash ? (<span style={{ fontSize: 11, color: "#4caf50", fontWeight: 700 }}>✓ Saved</span>) : null}
        <div style={{ flex: 1 }} />
        <button disabled={active} onClick={async () => { await persist(); setStatus("starting"); setEmailStartedInStorage(true); }} style={startButtonStyle(accent, "#ec9b5f", active)}>Start</button>
        <button disabled={!active} onClick={() => { setStatus("stopped"); setEmailStartedInStorage(false); }} style={stopButtonStyle(!active)}>Stop</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// LINE card — inbound webhook sharing the WhatsApp webhook port. Needs a public
// URL (tunnel); callback path = <tunnel>/line. The shared WebhookBridgeRunner
// starts the listener whenever any webhook bridge is enabled.
// ---------------------------------------------------------------------
function makeStartedHelpers(platform: "line") {
  const key = `owllm:${platform}:started`;
  return {
    isStarted: () => { try { return sessionStorage.getItem(key) === "1"; } catch { return false; } },
    setStarted: (running: boolean) => {
      try { sessionStorage.setItem(key, running ? "1" : "0"); } catch {}
      try { window.dispatchEvent(new CustomEvent(`owllm:${platform}:status`, { detail: running ? "running" : "stopped" })); } catch {}
    },
  };
}

function useWebhookCardCommon(platform: "line") {
  const helpers = makeStartedHelpers(platform);
  const [status, setStatus] = useState<BridgeStatus>(() => helpers.isStarted() ? "running" : "stopped");
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [lastError, setLastError] = useState<string>("");
  useEffect(() => {
    let dead = false;
    invoke<ProjectLite[]>("list_projects").then(rows => { if (!dead) setProjects(rows.map(r => ({ id: r.id, name: r.name }))); }).catch(() => {});
    const onRuntime = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      if (d.status === "running" || d.status === "stopped" || d.status === "error") setStatus(d.status);
      if (typeof d.lastError === "string") setLastError(d.lastError);
      if (d.status === "running") setLastError("");
    };
    window.addEventListener(`owllm:${platform}:runtime`, onRuntime as EventListener);
    return () => { dead = true; window.removeEventListener(`owllm:${platform}:runtime`, onRuntime as EventListener); };
  }, [platform]);
  return { helpers, status, setStatus, projects, lastError };
}

function LineCard() {
  const { helpers, status, setStatus, projects, lastError } = useWebhookCardCommon("line");
  const [accessToken, setAccessToken] = useState("");
  const [secret, setSecret] = useState("");
  const [users, setUsers] = useState("");
  const [project, setProject] = useState("");
  const [autoApprove, setAutoApprove] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    invoke<BridgeConfigs>("load_bridge_configs").then(c => {
      if (dead) return;
      const l = c.line;
      setAccessToken(l.channel_access_token || ""); setSecret(l.channel_secret || "");
      setUsers((l.allowed_users || []).join(", ")); setProject(l.project_id || ""); setAutoApprove(!!l.auto_approve);
    }).catch(() => {});
    return () => { dead = true; };
  }, []);

  async function persist() {
    setSaveError(null);
    const allow = users.split(",").map(s => s.trim()).filter(Boolean);
    try {
      await invoke("save_line_config", { cfg: { channel_access_token: accessToken, channel_secret: secret, allowed_users: allow, project_id: project, auto_approve: autoApprove } });
      setSavedFlash(true); window.setTimeout(() => setSavedFlash(false), 1600);
    } catch (e) { setSaveError(String(e)); }
  }

  const accent = "#06C755";
  const active = status === "starting" || status === "running";
  const statusText = status === "running" ? "Running — webhook callback URL = <tunnel>/line."
    : status === "starting" ? "Starting — binding the shared webhook listener."
    : status === "error" ? `Error — ${lastError || "Not connected."}`
    : (lastError ? `Stopped — last error: ${lastError}` : "Stopped.");

  return (
    <div style={{ flex: 1, background: "linear-gradient(180deg, #163a26 0%, #0e1117 60%, #0e1117 100%)", border: "none", borderRadius: 16, padding: "18px 20px", boxShadow: "0 4px 24px rgba(0,0,0,0.43)", display: "flex", flexDirection: "column", gap: 10, minWidth: 320 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ fontSize: 26, color: accent, lineHeight: 1, fontWeight: 800 }}>L</div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: accent }}>LINE</div>
          <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>Messaging API · inbound webhook · needs a public URL (tunnel)</div>
        </div>
        <StatusDot state={status} />
      </div>
      <SectionLabel text="Channel access token" />
      <BridgeInput type="password" value={accessToken} onChange={e => setAccessToken(e.target.value)} />
      <SectionLabel text="Channel secret (optional)" />
      <BridgeInput type="password" value={secret} onChange={e => setSecret(e.target.value)} />
      <SectionLabel text="Allowed user IDs (optional)" />
      <BridgeInput placeholder="(empty = any) U0123…, U0456…" value={users} onChange={e => setUsers(e.target.value)} />
      <SectionLabel text="Project" />
      <ProjectSelect value={project} onChange={e => setProject(e.target.value)}>
        <option value="">(no project)</option>
        {projects.map(p => (<option key={p.id} value={p.id}>{p.name}</option>))}
      </ProjectSelect>
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--fg)" }}>
        <input type="checkbox" checked={autoApprove} onChange={e => setAutoApprove(e.target.checked)} style={{ accentColor: accent }} />
        Auto-approve every tool call (only for personal bots)
      </label>
      <div style={{ fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.4 }}>Set the webhook URL in the LINE Developers console to <code>&lt;tunnel&gt;/line</code>.</div>
      <div style={{ flex: 1 }} />
      <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>{statusText}</div>
      {saveError ? (<div style={{ fontSize: 11, color: "#ffb0b0" }}>{saveError}</div>) : null}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={persist} style={{ height: BTN_HEIGHT, padding: "0 14px", background: "var(--bg-surface)", color: "var(--fg)", border: "1px solid var(--border-strong)", borderRadius: 8, fontWeight: 600, fontSize: 12, cursor: "pointer" }} title="Persist to ~/.owllm/bridge_config.json">💾 Save</button>
        {savedFlash ? (<span style={{ fontSize: 11, color: "#4caf50", fontWeight: 700 }}>✓ Saved</span>) : null}
        <div style={{ flex: 1 }} />
        <button disabled={active} onClick={async () => { await persist(); setStatus("starting"); helpers.setStarted(true); }} style={startButtonStyle(accent, "#22d96b", active)}>Start</button>
        <button disabled={!active} onClick={() => { setStatus("stopped"); helpers.setStarted(false); }} style={stopButtonStyle(!active)}>Stop</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Page — Qt BridgesPage._build_ui (bridges_page.py:589)
// ---------------------------------------------------------------------
export default function BridgesPage() {
  return (
    <div style={{
      // Qt margins (28, 24, 28, 24), outer spacing 18 (bridges_page.py:591-592).
      padding: "24px 28px",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      gap: 18,
      overflow: "auto",
      background: "var(--bg-panel)",
    }}>
      {/* Title — Qt 594-598: 22pt bold #fff. */}
      <div style={{ fontSize: 22, fontWeight: 700, color: "var(--fg-strong)" }}>Bridges</div>

      {/* Subtitle — Qt 600-608 verbatim. */}
      <div style={{ fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.5 }}>
        Drive your agent team from a phone. Telegram needs only a bot
        token; WhatsApp Cloud API needs a public webhook URL — point a
        tunnel (cloudflared / ngrok) at the local port and copy that
        URL into the Meta App webhook config.
      </div>

      {/* Bridge cards — wrap so more than two fit on narrow widths. */}
      <div style={{ flex: 1, display: "flex", flexWrap: "wrap", gap: 18, minHeight: 0, alignContent: "flex-start" }}>
        <TelegramCard />
        <DiscordCard />
        <SlackCard />
        <EmailCard />
        <WhatsAppCard />
        <LineCard />
      </div>
    </div>
  );
}
