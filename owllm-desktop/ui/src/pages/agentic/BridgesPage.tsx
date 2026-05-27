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

type BridgeStatus = "stopped" | "running" | "error";

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
type BridgeConfigs = { telegram: TelegramConfig; whatsapp: WhatsAppConfig };

// Qt: 10x10 dot, running color #4caf50, stopped color #5a6376
// (bridges_page.py:350-352).
function StatusDot({ state }: { state: BridgeStatus }) {
  const color = state === "running" ? "#4caf50"
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
  const [lastUpdateId] = useState<number>(0);
  const [lastError] = useState<string>("");
  // Chats that have actually messaged the bot since start — Qt line
  // 307-335 renders these as clickable chips that add to the allow-list.
  const [seenIds] = useState<number[]>([]);

  // Qt accent for Telegram (#52b4ff, lines 106/112/186).
  const accent = "#52b4ff";

  const running = status === "running";
  const existingIds = new Set(
    chatIds.split(",").map(s => s.trim()).filter(Boolean).map(Number).filter(n => !Number.isNaN(n))
  );
  const allowListActive = existingIds.size > 0;

  // Status text — mirrors _TelegramCard.refresh_status (Qt 270-294).
  const statusText = running
    ? `Running — last update_id ${lastUpdateId}.${allowListActive ? " · allow-list active" : " · open (any chat)"}`
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
      minWidth: 0,
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
          disabled={running}
          onClick={async () => {
            // Save first so the bridge has fresh config to read.
            await persist();
            setStatus("running");
            setTelegramStartedInStorage(true);
          }}
          style={startButtonStyle(accent, "#62c4ff", running)}
        >
          Start
        </button>
        <button
          disabled={!running}
          onClick={() => {
            setStatus("stopped");
            setTelegramStartedInStorage(false);
          }}
          style={stopButtonStyle(!running)}
        >
          Stop
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// WhatsApp card — Qt _WhatsAppCard (bridges_page.py:360)
// ---------------------------------------------------------------------
function WhatsAppCard() {
  const [token, setToken] = useState("");
  const [phoneId, setPhoneId] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [senders, setSenders] = useState("");
  // Qt port range 1024-65535, default 8911 (bridges_page.py:430-431).
  const [port, setPort] = useState<number>(8911);
  const [project, setProject] = useState("");
  const [autoApprove, setAutoApprove] = useState(false);
  const [status, setStatus] = useState<BridgeStatus>("stopped");
  const [lastError] = useState<string>("");
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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

  // Status text mirrors _WhatsAppCard.refresh_status (Qt 535-551).
  const bind = `0.0.0.0:${port}`;
  const statusText = running
    ? `Listening on ${bind} — point your tunnel at this port and use it as the webhook callback URL in Meta.`
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
      minWidth: 0,
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
            <option value="psm">Product Studio Test</option>
            <option value="customer_support">Customer Support — support</option>
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
          disabled={running}
          onClick={() => setStatus("running")}
          style={startButtonStyle(accent, "#22b88f", running)}
        >
          Start
        </button>
        <button
          disabled={!running}
          onClick={() => setStatus("stopped")}
          style={stopButtonStyle(!running)}
        >
          Stop
        </button>
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

      {/* Two cards side by side, spacing 18 (Qt 610-616). */}
      <div style={{ flex: 1, display: "flex", gap: 18, minHeight: 0 }}>
        <TelegramCard />
        <WhatsAppCard />
      </div>
    </div>
  );
}
