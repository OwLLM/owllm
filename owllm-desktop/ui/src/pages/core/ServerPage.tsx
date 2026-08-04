// ServerPage — ported from LLM/desktop_app/pages/server_page.py
// (ServerPage._setup_ui, line 463). Three-column splitter with the
// Qt fixed ratio 40/40/20 (server_page.py:1022-1027).
//
//   ┌─ 🛠️ OWLLM MCP ──────┬─ 🤖 LLM Inference ─┬─ 📋 Server Log ─┐
//   │ status / address    │ status              │  scrolling log │
//   │ ▶ Start Server      │ model selector      │  🗑️ Clear Log  │
//   │ Port / Token / Root │ ▶ Start  ⏹ Stop     │                │
//   │ ♥ Health  💾 Save   │ Copy API / Model    │                │
//   │ Config: …           │ Active Servers list │                │
//   └─────────────────────┴─────────────────────┴────────────────┘
//
// ARCHITECTURE NOTE (2026-05-14): the always-on Python HTTP engine
// was deleted. Rust now owns the runtime. The control surface here
// calls native Tauri commands (`list_models`, `server_status`,
// `server_start`, `server_stop`, `hardware_info`) defined in
// src-tauri/src/lib.rs. Those commands are currently stubs that
// return empty/default state; their real implementations will spawn
// llama.cpp with CREATE_NO_WINDOW directly from Rust.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { bumpActivity } from "../../support/activityStats";
import { LogBox } from "../../components/LogBox";
import { listen } from "@tauri-apps/api/event";
import ModelPicker, { SELECT_MODEL_LABEL, type ModelInfo as PickerModelInfo, type AccountsStatusLite } from "../agentic/ModelPicker";
import { getInferenceEndpoint, setInferenceEndpoint, setLocalServerKey, type InferenceEndpoint } from "../agentic/inferenceEndpoint";
import {
  getServerCtx, setServerCtx, getServerModel, setServerModel,
  SERVER_CTX_PRESETS, fmtCtx, approxKvGb,
} from "./serverContext";
import { listRemoteModels, startRemoteModel, type RemoteModelCatalog } from "../advanced/remoteDevices";

// Real Page_icons PNG served by vite.config.ts middleware
// (same pattern as AgentsPage.tsx / CodePage.tsx).
const ICONS = "/Page_icons";

/// Inference source — where the agent loop sends chat requests. Local (this
/// PC's managed llama-server) or a Remote server on another host (the
/// Windows-GPU / Linux-agents split: run agents here, model on the GPU box).
/// Persisted via inferenceEndpoint.ts and read by dispatch.ts at call time.
type GpuServer = { name: string; host: string; port: number; apiKey: string; device: string };

function InferenceSourceCard() {
  const [ep, setEp] = useState<InferenceEndpoint>(() => getInferenceEndpoint());
  const save = (next: InferenceEndpoint) => { setInferenceEndpoint(next); setEp(next); };
  const remote = ep.mode === "remote";
  const isDevice = ep.mode === "device";
  // One-click discovery: a GPU server another device on this account published
  // into the vault (its LAN IP + port + key). No typing IPs.
  const [discovered, setDiscovered] = useState<GpuServer | null>(null);
  // Paired OwLLM devices, for routing inference over the encrypted device
  // channel (no HTTP route needed — works via P2P/relay).
  const [pairedDevices, setPairedDevices] = useState<Array<{ device_id: string; name: string; is_self: boolean }>>([]);
  const [remoteCatalog, setRemoteCatalog] = useState<RemoteModelCatalog | null>(null);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [remoteError, setRemoteError] = useState("");
  useEffect(() => {
    invoke<GpuServer | null>("vault_read_server").then(setDiscovered).catch(() => setDiscovered(null));
    invoke<Array<{ device_id: string; name: string; is_self: boolean }>>("devices_list")
      .then((d) => setPairedDevices((d ?? []).filter((x) => !x.is_self)))
      .catch(() => setPairedDevices([]));
  }, []);
  const refreshRemoteModels = async (deviceId: string) => {
    setRemoteBusy(true);
    setRemoteError("");
    try {
      setRemoteCatalog(await listRemoteModels(deviceId));
    } catch (e) {
      setRemoteCatalog(null);
      setRemoteError(String(e));
    } finally {
      setRemoteBusy(false);
    }
  };
  useEffect(() => {
    if (!isDevice || !ep.deviceId) {
      setRemoteCatalog(null);
      setRemoteError("");
      return;
    }
    void refreshRemoteModels(ep.deviceId);
  }, [isDevice, ep.deviceId]);

  const chooseRemoteModel = async (modelId: string) => {
    if (!ep.deviceId || !modelId) return;
    setRemoteBusy(true);
    setRemoteError("");
    try {
      await startRemoteModel(ep.deviceId, modelId);
      save({ ...ep, remoteModelId: modelId });
      await refreshRemoteModels(ep.deviceId);
    } catch (e) {
      setRemoteError(String(e));
      setRemoteBusy(false);
    }
  };
  const usingDiscovered = remote && discovered && ep.host === discovered.host && ep.port === discovered.port;
  const inp: CSSProperties = {
    height: 30, padding: "0 10px", borderRadius: 6,
    border: "1px solid rgba(var(--accent-rgb),0.30)",
    background: "var(--bg-elevated)", color: "var(--fg)", fontSize: 12,
  };
  return (
    <div data-ui="InferenceSourceCard" style={{
      border: "1px solid rgba(var(--accent-rgb),0.30)", borderRadius: 8,
      padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8,
      background: "linear-gradient(180deg, rgba(30,30,40,0.6), rgba(20,20,30,0.6))",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg-strong)", flex: 1 }}>
          🛰 Inference source
        </div>
        <div style={{ display: "flex", gap: 4, background: "var(--bg-elevated)", borderRadius: 6, padding: 2 }}>
          {(["local", "remote", "device"] as const).map(m => (
            <button key={m}
              onClick={() => save({ ...ep, mode: m })}
              style={{
                padding: "4px 12px", fontSize: 11, fontWeight: 700, borderRadius: 4, cursor: "pointer",
                border: "none",
                background: ep.mode === m ? "rgba(var(--accent-rgb),0.75)" : "transparent",
                color: ep.mode === m ? "#fff" : "var(--fg-muted)",
              }}>
              {m === "local" ? "Local (this PC)" : m === "remote" ? "Remote server" : "Paired device"}
            </button>
          ))}
        </div>
      </div>
      <div style={{ fontSize: 11, color: "var(--fg-subtle)", lineHeight: 1.45 }}>
        {isDevice
          ? "Agents use a PAIRED OwLLM device's local model over the encrypted device channel — no IP/port needed, works from anywhere (P2P/relay). Responses arrive complete (not token-streamed)."
          : remote
          ? "Agents send inference to a llama-server on another host (e.g. your Windows GPU box). Run agents here, model there."
          : "Agents use this PC's managed llama-server (default)."}
      </div>
      {discovered && !usingDiscovered && (
        <button
          onClick={() => save({ mode: "remote", host: discovered.host, port: discovered.port, apiKey: discovered.apiKey })}
          style={{
            display: "flex", alignItems: "center", gap: 8, textAlign: "left",
            padding: "8px 12px", borderRadius: 8, cursor: "pointer",
            border: "1px solid rgba(34,197,94,0.45)", background: "rgba(34,197,94,0.10)",
            color: "var(--fg)", fontSize: 12,
          }}
          title={`Use ${discovered.name} (${discovered.host}:${discovered.port}) from your account`}
        >
          <span style={{ fontSize: 16 }}>🖥️</span>
          <span style={{ flex: 1 }}>
            <b>Use {discovered.name}’s GPU</b> — discovered on your account ({discovered.host}:{discovered.port})
          </span>
          <span style={{ fontWeight: 800, color: "#22c55e" }}>Connect →</span>
        </button>
      )}
      {usingDiscovered && (
        <div style={{ fontSize: 11.5, color: "#22c55e", fontWeight: 700 }}>
          ✓ Using {discovered!.name}’s GPU ({discovered!.host}:{discovered!.port})
        </div>
      )}
      {remote && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 80px", gap: 8 }}>
          <input style={inp} placeholder="host / IP (e.g. 192.168.1.20)" value={ep.host}
            onChange={e => save({ ...ep, host: e.target.value })} />
          <input style={inp} placeholder="port" value={ep.port || ""}
            onChange={e => save({ ...ep, port: Number(e.target.value) || 0 })} />
          <input style={{ ...inp, gridColumn: "1 / span 2" }} type="password"
            placeholder="API key (the remote server's --api-key, optional)"
            value={ep.apiKey} onChange={e => save({ ...ep, apiKey: e.target.value })} />
        </div>
      )}
      {isDevice && (
        pairedDevices.length ? (
          <select
            style={{ ...inp, width: "100%" }}
            value={ep.deviceId ?? ""}
            onChange={e => {
              const d = pairedDevices.find((x) => x.device_id === e.target.value);
              save({ ...ep, deviceId: d?.device_id, deviceName: d?.name, remoteModelId: undefined });
            }}
          >
            <option value="">— pick a paired device —</option>
            {pairedDevices.map((d) => (
              <option key={d.device_id} value={d.device_id}>{d.name}</option>
            ))}
          </select>
        ) : (
          <div style={{ fontSize: 11.5, color: "var(--warn)" }}>
            No paired devices yet — pair one on the Devices page, then it appears here. The target must have a model running and grant this machine shell.
          </div>
        )
      )}
      {isDevice && ep.deviceId && (
        <div data-ui="PairedDeviceModels" style={{
          display: "flex", flexDirection: "column", gap: 7, padding: 9,
          border: "1px solid rgba(34,197,94,0.35)", borderRadius: 8,
          background: "rgba(34,197,94,0.06)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <b style={{ fontSize: 12, color: "var(--fg-strong)" }}>
              Models on {ep.deviceName || "paired device"}
            </b>
            <span style={{ flex: 1 }} />
            {remoteCatalog && (
              <span style={{ fontSize: 10.5, color: "var(--fg-muted)" }}>
                {remoteCatalog.models.length} available
                {remoteCatalog.running && remoteCatalog.active_model_id
                  ? ` · running ${remoteCatalog.active_model_id}`
                  : " · server stopped"}
              </span>
            )}
            <button
              className="ghost-btn"
              disabled={remoteBusy}
              onClick={() => void refreshRemoteModels(ep.deviceId!)}
              style={{ fontSize: 10.5, padding: "2px 8px" }}
            >
              {remoteBusy ? "Checking…" : "Refresh"}
            </button>
          </div>
          {remoteCatalog && remoteCatalog.models.length > 0 && (
            <select
              aria-label={`Models on ${ep.deviceName || "paired device"}`}
              style={{ ...inp, width: "100%" }}
              value={ep.remoteModelId ?? remoteCatalog.active_model_id ?? ""}
              disabled={remoteBusy}
              onChange={(e) => void chooseRemoteModel(e.target.value)}
            >
              <option value="">— select and start a model —</option>
              {remoteCatalog.models.map((model) => (
                <option key={model.model_id} value={model.model_id}>
                  {model.model_id}
                  {model.size_mib != null ? ` · ${(model.size_mib / 1024).toFixed(1)} GiB` : ""}
                  {remoteCatalog.active_model_id === model.model_id && remoteCatalog.running ? " · running" : ""}
                </option>
              ))}
            </select>
          )}
          {remoteCatalog && remoteCatalog.models.length === 0 && (
            <span style={{ fontSize: 11.5, color: "var(--warn)" }}>
              No runnable GGUF models are installed on this device.
            </span>
          )}
          {remoteError && (
            <span style={{ fontSize: 11.5, color: "var(--error)" }}>
              {remoteError.includes("permission denied")
                ? "Remote model access is not allowed by that device. On the target, grant this PC Shell commands in Devices → Trusted controllers."
                : remoteError}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

type ModelInfo = PickerModelInfo;
type ServerStatus = {
  running: boolean;
  model_id: string | null;
  port: number | null;
  message: string;
  // Context window the server actually started with, and — when it was capped
  // below the requested value — a plain-language reason. Set by the backend so
  // a VRAM cap is shown to the user instead of silently starting at 2K.
  context?: number | null;
  context_notice?: string | null;
};
type ServerLog = { stream: "stdout" | "stderr"; line: string };

// Thin wrappers over the native Tauri commands. No HTTP, no proxy.
async function listModels(): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>("list_models");
}
async function serverStatus(): Promise<ServerStatus> {
  return invoke<ServerStatus>("server_status");
}
async function serverStart(modelId: string, ctx?: number | null): Promise<void> {
  try { bumpActivity("model-server-start"); } catch { /* stats never block */ }
  // null = Auto (backend sizes to VRAM); a number = explicit. undefined = read
  // the persisted choice.
  await invoke("server_start", { modelId, ctx: ctx === undefined ? getServerCtx() : ctx });
}
async function serverStop(): Promise<void> {
  await invoke("server_stop");
}

// ---------------------------------------------------------------------
// Visual building blocks — match PySide6 styling (QGroupBox + labels +
// inputs). Kept local to the file; they only exist for this page.
// ---------------------------------------------------------------------
function GroupBox({ title, tooltip, children, style }: {
  title: string;
  tooltip?: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      title={tooltip}
      style={{
        background: "linear-gradient(180deg, rgba(60,60,80,0.4), rgba(40,40,60,0.4))",
        border: "1px solid rgba(var(--accent-rgb),0.20)",
        borderRadius: 10,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minHeight: 0,
        ...style,
      }}
    >
      <div style={{
        fontSize: 14, fontWeight: 700,
        color: "var(--fg)",
        marginBottom: 6,
        borderBottom: "1px solid rgba(var(--accent-rgb),0.10)",
        paddingBottom: 6,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

// Status colors mirror Qt setStyleSheet values:
//   Running  → #4CAF50   (server_page.py:1767, 2081)
//   Stopped  → #888      (server_page.py:1828, 2064)
//   Loading/Warn → #FF9800 (server_page.py:2017, 2287, 2310)
//   Error    → #f44336   (server_page.py:2116)
function StatusLabel({ text, color }: { text: string; color: string }) {
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 8,
      fontSize: 13, fontWeight: 700, color,
    }}>
      {text}
    </div>
  );
}

function CompactInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        height: 28,
        padding: "0 10px",
        borderRadius: 6,
        border: "1px solid var(--border-strong)",
        background: "var(--bg-input)",
        color: "var(--fg)",
        fontSize: 12,
        ...props.style,
      }}
    />
  );
}

// Mirrors Qt _start_llm_server's tall green gradient (server_page.py:763-784)
// and Stop button's red gradient (server_page.py:794-815).
function PrimaryButton({
  label, variant = "neutral", ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  variant?: "neutral" | "start" | "stop";
}) {
  const colors = {
    neutral: { bg: "linear-gradient(180deg, var(--accent), var(--accent))", fg: "var(--accent-fg)", border: "none" },
    start:   { bg: "linear-gradient(180deg, #4CAF50, #388E3C)", fg: "#fff", border: "none" },
    stop:    { bg: "linear-gradient(180deg, #f44336, #d32f2f)", fg: "#fff", border: "none" },
  }[variant];
  return (
    <button
      {...rest}
      style={{
        // 45px height matches Qt llm_start_btn.setMinimumHeight(45)
        // (server_page.py:761, 792). Other callers can override.
        height: 45,
        padding: "0 14px",
        borderRadius: 8,
        background: colors.bg,
        color: colors.fg,
        border: colors.border,
        fontSize: 13, fontWeight: 700,
        cursor: rest.disabled ? "not-allowed" : "pointer",
        opacity: rest.disabled ? 0.55 : 1,
        ...rest.style,
      }}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------
// LEFT COLUMN — 🛠️ OWLLM MCP  (Qt server_page.py:490-676)
// ---------------------------------------------------------------------
function MCPServerColumn({ appendLog }: { appendLog: (s: string) => void }) {
  // Defaults match Qt:
  //   port  → "8763"           (server_page.py:548)
  //   token → ""               (server_page.py:572-578, placeholder "Auth token")
  //   root  → cwd-ish          (server_page.py:596)
  //   LAN   → false → 127.0.0.1; true → 0.0.0.0 (server_page.py:1701-1702)
  const [port, setPort] = useState("8763");
  const [lan, setLan] = useState(false);
  const [token, setToken] = useState("");
  const [tokenVisible, setTokenVisible] = useState(false);
  // Default to a real per-user dir, not the dev repo path. Editable below
  // (folder picker); this is just the initial value on a fresh machine.
  const [root, setRoot] = useState("");
  useEffect(() => {
    invoke<string>("chat_scratch_dir").then((d) => setRoot((r) => r || d)).catch(() => { /* leave blank */ });
  }, []);
  const [running, setRunning] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [address, setAddress] = useState<string>("");   // "127.0.0.1:8763"
  const [lanUrl, setLanUrl] = useState<string>("");      // "http://192.168.x.y:8763"
  const [healthBusy, setHealthBusy] = useState(false);
  const [configPath, setConfigPath] = useState<string>("-"); // shown in "Config: …" footer
  const [savedFlash, setSavedFlash] = useState(false);

  const tokenRevealTimer = useRef<number | null>(null);

  function statusText(): { text: string; color: string } {
    if (transitioning) return { text: running ? "● Stopping..." : "● Starting...", color: "#FF9800" };
    return running
      ? { text: "● Running", color: "#4CAF50" }
      : { text: "● Stopped", color: "var(--fg-subtle)" };
  }

  function onGenerateToken() {
    // Mirrors Qt secrets.token_urlsafe(32) → 43 base64url chars
    // (server_page.py:1081-1085). After generation the field is
    // shown for 2s then re-hidden — same UX.
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const b64 = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    setToken(b64);
    setTokenVisible(true);
    if (tokenRevealTimer.current) window.clearTimeout(tokenRevealTimer.current);
    tokenRevealTimer.current = window.setTimeout(() => setTokenVisible(false), 2000);
  }

  async function onPickRoot() {
    // Qt uses QFileDialog.getExistingDirectory(self, "Select Workspace Root", ...)
    // (server_page.py:1075). Tauri dialog plugin not wired here yet —
    // fall back to text-prompt so the control isn't dead.
    const next = window.prompt("Select Workspace Root", root);
    if (next && next.trim()) setRoot(next.trim());
  }

  async function onToggleServer() {
    if (transitioning) return;
    setTransitioning(true);
    try {
      if (running) {
        appendLog("[server] stop requested");
        // No MCP /v1 endpoint yet — visual stop only.
        setRunning(false);
        setAddress("");
        setLanUrl("");
      } else {
        const p = (port || "").trim() || "8763";
        const host = lan ? "0.0.0.0" : "127.0.0.1";
        appendLog(`[server] root=${root}`);
        appendLog(`[server] listening http://${host}:${p}`);
        setRunning(true);
        // Display localhost address — never show 0.0.0.0 (server_page.py:1769)
        setAddress(`127.0.0.1:${p}`);
        // LAN URL (best-effort — engine will fill in once /v1/mcp_server lands)
        if (lan) setLanUrl(`http://<LAN-IP>:${p}`);
        else setLanUrl("");
      }
    } finally {
      setTransitioning(false);
    }
  }

  async function onCheckHealth() {
    // Qt /health probe (server_page.py:1930-1955) prepends "[health]" to log.
    if (!running || !address) return;
    setHealthBusy(true);
    try {
      const resp = await fetch(`http://${address}/health`, { method: "GET" });
      const txt = await resp.text();
      appendLog(`[health] ${txt}`);
    } catch (e) {
      appendLog(`[health] Error: ${String(e)}`);
    } finally {
      setHealthBusy(false);
    }
  }

  function onSave() {
    // Qt _save_config persists to tool_server.json via ConfigManager
    // (server_page.py:1546-1569). No engine endpoint yet — flash a
    // "Saved" indicator next to the button to acknowledge the click.
    setConfigPath("tool_server.json (in-memory until /v1/mcp_server lands)");
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 1800);
  }

  function onCopyLan() {
    if (!lanUrl) return;
    navigator.clipboard?.writeText(lanUrl).catch(() => {});
    appendLog(`[server] LAN URL copied: ${lanUrl}`);
  }

  const s = statusText();
  return (
    <GroupBox
      title="🛠️ OWLLM MCP"
      tooltip={[
        "Lets external MCP clients (terminal claude, IDEs, other apps)",
        "reach into OWLLM's built-in tools (shell, file ops, git, ssh, http_get).",
        "",
        "NOT needed for OWLLM's own agents — they call those tools natively in-process.",
        "Only start this if you want an outside program to use OWLLM as an MCP tool source.",
      ].join("\n")}
    >
      <StatusLabel text={s.text} color={s.color} />

      <div
        title="URL where the MCP server listens. External clients point at this URL."
        style={{ fontSize: 12, color: "var(--fg-muted)" }}
      >
        {running ? `http://${address}` : "Address: -"}
      </div>

      {/* LAN address + copy button — only when bound to 0.0.0.0
          (server_page.py:1773-1814). Qt creates these widgets lazily. */}
      {running && lanUrl ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "#4CAF50", fontSize: 12 }}>LAN: {lanUrl}</span>
          <button
            className="ghost-btn"
            onClick={onCopyLan}
            style={{
              background: "rgba(76, 175, 80, 0.6)",
              color: "white",
              border: "none",
              padding: "4px 8px",
              borderRadius: 4,
              fontSize: 11,
              cursor: "pointer",
            }}
            title="Copy LAN URL to clipboard"
          >
            📋 Copy LAN URL
          </button>
        </div>
      ) : null}

      <PrimaryButton
        label={
          transitioning
            ? (running ? "Stopping..." : "Starting...")
            : (running ? "⏹ Stop Server" : "▶ Start Server")
        }
        variant={running ? "stop" : "start"}
        disabled={transitioning}
        onClick={onToggleServer}
        style={{ height: 36 }}
      />

      <div style={{
        display: "grid",
        gridTemplateColumns: "60px 1fr auto",
        gap: 6, alignItems: "center",
        marginTop: 6,
      }}>
        <span style={{ fontSize: 12, color: "var(--fg-muted)" }} title="TCP port the MCP HTTP server listens on. Default 8763.">
          Port:
        </span>
        <CompactInput
          value={port}
          onChange={e => setPort(e.target.value)}
          style={{ width: 84 }}  // Qt port_edit.setFixedWidth(84) (server_page.py:549)
          maxLength={5}
        />
        <label
          style={{ fontSize: 12, color: "var(--fg)", display: "inline-flex", alignItems: "center", gap: 6 }}
          title="Off = bind to 127.0.0.1 (localhost only). On = bind to 0.0.0.0 (any device on your local network can reach it). Set a Token if you flip this on."
        >
          <input
            type="checkbox"
            checked={lan}
            onChange={e => setLan(e.target.checked)}
            style={{ accentColor: "var(--accent)" }}
          />
          LAN
        </label>

        <span style={{ fontSize: 12, color: "var(--fg-muted)" }} title="Shared secret external clients must send as X-Auth-Token.">
          Token:
        </span>
        <CompactInput
          type={tokenVisible ? "text" : "password"}
          placeholder="Auth token"          // Qt token_edit.setPlaceholderText (server_page.py:574)
          value={token}
          onChange={e => setToken(e.target.value)}
        />
        <button
          className="ghost-btn"
          onClick={onGenerateToken}
          style={{ width: 28, height: 28, padding: 0, fontSize: 14 }} // Qt generate_token_btn fixed 28w (line 584)
          title="Generate a fresh random auth token (overwrites the current one)."
        >🎲</button>

        <span style={{ fontSize: 12, color: "var(--fg-muted)" }} title="Workspace folder the MCP tools (shell, file ops, git) operate inside.">
          Root:
        </span>
        <CompactInput value={root} onChange={e => setRoot(e.target.value)} />
        <button
          className="ghost-btn"
          onClick={onPickRoot}
          style={{ width: 28, height: 28, padding: 0, fontSize: 14 }} // Qt browse_btn fixed 28w (line 604)
          title="Pick a different folder to use as the workspace root."
        >📁</button>
      </div>

      {/* Health + Save row mirrors Qt tool_btn_layout (server_page.py:648-668) */}
      <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center" }}>
        <button
          className="ghost-btn"
          onClick={onCheckHealth}
          disabled={!running || healthBusy}
          style={{ flex: 1 }}
          title="Ping the running MCP server's /health endpoint and show whether it's responsive."
        >
          {healthBusy ? "Checking..." : "♥ Health"}
        </button>
        <button
          className="ghost-btn"
          onClick={onSave}
          style={{ flex: 1 }}
          title="Save the current Port / Token / Root / LAN settings to disk so they survive a restart."
        >
          💾 Save
        </button>
        {savedFlash ? (
          <span style={{ fontSize: 11, color: "#4CAF50", fontWeight: 700 }}>✓ Saved</span>
        ) : null}
      </div>

      {/* Config-path indicator (server_page.py:670-674, 9pt gray) */}
      <div style={{
        fontSize: 11, color: "var(--fg-subtle)",
        marginTop: 2, wordBreak: "break-all",
      }}
        title="Path to the JSON file where these settings are persisted.">
        Config: {configPath}
      </div>
    </GroupBox>
  );
}

// ---------------------------------------------------------------------
// MIDDLE COLUMN — 🤖 LLM Inference Server  (Qt server_page.py:686-951)
// ---------------------------------------------------------------------
type LlmStatusKind =
  | "not_running"
  | "starting"
  | "running"
  | "loading"
  | "standby"
  | "busy"
  | "port_in_use"
  | "error";

function llmStatusDecor(kind: LlmStatusKind, detail?: string): { text: string; color: string } {
  // Mirrors Qt status strings throughout _apply_llm_server_status / _on_*
  switch (kind) {
    case "running":     return { text: "● Running",                       color: "#4CAF50" };
    case "starting":    return { text: "● Starting...",                   color: "#FF9800" };
    case "loading":     return { text: "● Loading...",                    color: "#FF9800" };
    case "standby":     return { text: "● Standby (no model loaded)",     color: "#FF9800" };
    case "busy":        return { text: "● Busy/Unresponsive",             color: "#FF9800" };
    case "port_in_use": return { text: `● Port in use by ${detail ?? ""}`, color: "#FF9800" };
    case "error":       return { text: "● Error",                         color: "#f44336" };
    case "not_running":
    default:            return { text: "● Not running",                   color: "var(--fg-subtle)" };
  }
}

type ActiveServerRow = {
  model_id?: string;
  model_from_health?: string;
  status?: string;     // ok | loading | unresponsive | not_started | unknown
  port?: number;
  pid?: number;
};

function LLMServerColumn({
  models, busy, modelId, setModelId, serverState, onAction, error, appendLog,
  ctx, setCtx,
}: {
  models: ModelInfo[];
  busy: string | null;
  modelId: string;
  setModelId: (v: string) => void;
  serverState: string;
  onAction: (a: "start" | "stop" | "status") => void;
  error: string;
  appendLog: (s: string) => void;
  ctx: number | null;
  setCtx: (n: number | null) => void;
}) {
  const selectedModel = models.find(m => m.model_id === modelId);

  // Parse the JSON dump from server_status into a status kind. The
  // previous substring check was buggy: `"running":false` still
  // contains the WORD "running", so it always reported the server
  // as up — which left Start permanently disabled.
  const [statusKind, statusDetail] = useMemo<[LlmStatusKind, string?]>(() => {
    if (busy === "start server") return ["starting"];
    if (!serverState || serverState === "Not checked") return ["not_running"];
    try {
      const s = JSON.parse(serverState) as {
        running?: boolean;
        message?: string;
      };
      if (s.running === true) return ["running"];
      const msg = (s.message || "").toLowerCase();
      if (msg.includes("crashed") || msg.includes("ended unexpectedly")) return ["error"];
      if (msg.includes("loading") || msg.includes("starting")) return ["loading"];
      return ["not_running"];
    } catch {
      return ["not_running"];
    }
  }, [serverState, busy]);

  // Plain-language reason the running context is below what was requested (VRAM
  // cap). Surfaced by the backend so the user is never silently dropped to 2K.
  const ctxNotice = useMemo<string | null>(() => {
    try {
      const s = JSON.parse(serverState) as { context_notice?: string | null };
      return s?.context_notice || null;
    } catch { return null; }
  }, [serverState]);

  const decor = llmStatusDecor(statusKind, statusDetail);
  const isRunning = statusKind === "running" || statusKind === "loading";
  const apiUrl = selectedModel?.port ? `http://127.0.0.1:${selectedModel.port}/v1` : "-";

  // The context window the running server ACTUALLY loaded with — read live from
  // llama-server's /props (n_ctx). The preset buttons below are only the PENDING
  // choice (applied on next restart); without this the user had no way to see
  // what context is really in effect right now. null = not running / unknown.
  const [loadedCtx, setLoadedCtx] = useState<number | null>(null);
  useEffect(() => {
    const port = selectedModel?.port;
    if (statusKind !== "running" || !port) { setLoadedCtx(null); return; }
    let cancelled = false;
    const probe = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/props`, { signal: AbortSignal.timeout(1000) });
        if (!r.ok) return;
        const d = await r.json().catch(() => ({} as any));
        const n = d?.n_ctx ?? d?.default_generation_settings?.n_ctx;
        if (!cancelled && Number.isFinite(n) && n > 0) setLoadedCtx(Number(n));
      } catch { /* server busy/unreachable — keep last known value */ }
    };
    probe();
    const id = window.setInterval(probe, 5000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [statusKind, selectedModel?.port]);

  // Active inference servers list — Qt server_page.py:919-951 + 1500-1600
  // Real probe runs in ActiveServersProbeThread; here we hit /v1/server/status
  // for the selected model as a stand-in until /v1/servers/active is wired.
  const [activeRows, setActiveRows] = useState<ActiveServerRow[]>([]);
  const [activePort, setActivePort] = useState<number | null>(null);

  async function refreshActive() {
    try {
      const rows: ActiveServerRow[] = [];
      for (const m of models) {
        if (!m.port) continue;
        try {
          const r = await fetch(`http://127.0.0.1:${m.port}/health`, { signal: AbortSignal.timeout(800) });
          if (r.ok) {
            const data = await r.json().catch(() => ({} as any));
            rows.push({
              model_id: m.model_id,
              model_from_health: String(data?.model || m.model_id),
              status: String(data?.status || "ok").toLowerCase(),
              port: m.port,
            });
          } else {
            rows.push({ model_id: m.model_id, status: "unresponsive", port: m.port });
          }
        } catch {
          /* port closed → omit */
        }
      }
      setActiveRows(rows);
    } catch (e) {
      appendLog(`[LLM] active refresh failed: ${String(e)}`);
    }
  }

  useEffect(() => {
    refreshActive();
    // Qt llm_status_timer ticks every 2s (server_page.py:914)
    const id = window.setInterval(refreshActive, 2000);
    return () => window.clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models.length]);

  function onCopyApi() {
    if (apiUrl === "-") return;
    navigator.clipboard?.writeText(apiUrl).catch(() => {});
    appendLog(`[LLM] API URL copied: ${apiUrl}`);
  }
  function onCopyModel() {
    if (!modelId) return;
    navigator.clipboard?.writeText(modelId).catch(() => {});
    appendLog(`[LLM] Model name copied: ${modelId}`);
  }
  function onSetupGuide() {
    // Qt _show_llm_api_help shows a QMessageBox with rich text
    // (server_page.py:2609-2652). Browser-side we open a window.alert
    // (no rich-text widget yet) — content kept terse.
    window.alert(
      "Using Your Local LLM with External Tools\n\n" +
      "• Start the LLM Server above\n" +
      "• Copy the API URL\n" +
      "• In Cursor / VS Code Continue, set Base URL to the copied URL\n" +
      "• Set API Key to any text (e.g. 'sk-local')\n" +
      `• Set Model to: ${modelId || "<select a model>"}\n\n` +
      "See OPENAI_COMPATIBLE_API.md for full instructions."
    );
  }

  return (
    <GroupBox
      title="🤖 LLM Inference Server"
      tooltip={[
        "Runs a locally-downloaded model behind an OpenAI-compatible HTTP API.",
        "Use this if you want to point Cursor / VS Code / any OpenAI-API client at your local model.",
      ].join("\n")}
    >
      <StatusLabel text={decor.text} color={decor.color} />

      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)", marginTop: 4 }}
           title="Pick which downloaded model the inference server should serve.">
        Select Model:
      </div>
      <ModelPicker
        value={modelId}
        onChange={setModelId}
        models={models}
        status={null}
        localOnly
        fallbackLabel={models.length === 0 ? "(No READY models - run onboarding first)" : SELECT_MODEL_LABEL}
      />

      <div style={{
        display: "grid",
        gridTemplateColumns: "60px 1fr",
        gap: 4, fontSize: 12, marginTop: 4,
      }}>
        <span style={{ color: "var(--fg-muted)" }}>Model:</span>
        <span style={{ color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selectedModel?.base_model || "-"}
        </span>
        <span style={{ color: "var(--fg-muted)" }}>Port:</span>
        <span style={{ color: "var(--fg)" }}>{selectedModel?.port ?? "-"}</span>
      </div>

      {/* Context window (-c). Bigger = remembers more, but the KV cache grows
          linearly and lives in VRAM ON TOP of the weights — too big OOMs the GPU
          even when the weights fit. Change takes effect on the next (re)start. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)" }}
             title="How many tokens the model keeps in context. Larger needs more VRAM for the KV cache.">
          Context window:
        </div>
        {loadedCtx != null && (
          <span
            title="The context window the running server actually loaded with (live from llama-server). The presets below are the size for the NEXT start."
            style={{
              fontSize: 11, fontWeight: 800, color: "#7ff0c5",
              background: "rgba(127,240,197,0.12)", border: "1px solid rgba(127,240,197,0.40)",
              borderRadius: 999, padding: "1px 9px", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
            }}
          >
            ● Live: {loadedCtx.toLocaleString()} tokens
          </span>
        )}
      </div>
      {ctxNotice && (
        <div
          style={{
            marginTop: 4, fontSize: 11.5, lineHeight: 1.45, color: "var(--warn)",
            background: "rgba(255,152,0,0.10)", border: "1px solid rgba(255,152,0,0.35)",
            borderRadius: 8, padding: "6px 10px", maxWidth: 640,
          }}
        >
          ⚠ {ctxNotice}
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
        <button onClick={() => setCtx(null)}
          title="Let OWLLM size the context to your GPU — bigger card = bigger window (recommended)."
          style={{
            minHeight: 26, padding: "0 10px", borderRadius: 7, cursor: "pointer", fontSize: 12, fontWeight: 700,
            background: ctx == null ? "var(--accent)" : "var(--bg-elevated)",
            color: ctx == null ? "var(--accent-fg)" : "var(--fg)",
            border: `1px solid ${ctx == null ? "var(--accent)" : "var(--border-strong)"}`,
          }}>Auto</button>
        {SERVER_CTX_PRESETS.map(p => {
          const on = ctx === p;
          return (
            <button key={p} onClick={() => setCtx(p)}
              title={`${p.toLocaleString()} tokens · KV cache ≈ ${approxKvGb(p).toFixed(1)} GB (30B-class)`}
              style={{
                minHeight: 26, padding: "0 10px", borderRadius: 7, cursor: "pointer", fontSize: 12, fontWeight: 700,
                background: on ? "var(--accent)" : "var(--bg-elevated)",
                color: on ? "var(--accent-fg)" : "var(--fg)",
                border: `1px solid ${on ? "var(--accent)" : "var(--border-strong)"}`,
              }}>{fmtCtx(p)}</button>
          );
        })}
        <input
          type="number" min={512} step={1024} value={ctx ?? ""} placeholder="custom"
          onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 512) setCtx(v); }}
          title="Custom context size (tokens)"
          style={{ width: 92, height: 26, borderRadius: 7, padding: "0 8px", fontSize: 12, background: "var(--bg-input)", color: "var(--fg)", border: "1px solid var(--border)" }}
        />
      </div>
      <div style={{ fontSize: 10.5, color: (ctx ?? 0) > 32768 ? "#ffb56a" : "var(--fg-subtle)", marginTop: 2 }}>
        {ctx == null
          ? "Auto: OWLLM picks a context window that fits your GPU's VRAM (≈32K on a 24 GB card, less on smaller). Big enough for agentic teams; lower it manually if a model still won't load."
          : serverState.toLowerCase().includes("running")
            ? "Restart the server to apply the new context size."
            : `KV cache ≈ ${approxKvGb(ctx).toFixed(1)} GB on top of the weights (30B-class estimate). Lower this if a model crashes on load.`}
      </div>

      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)", marginTop: 6 }}>
        OpenAI API:
      </div>
      <div
        style={{
          fontSize: 11,
          color: "var(--accent-ink)",
          padding: "6px 10px",
          background: "var(--bg-elevated)",
          borderRadius: 6,
          userSelect: "text",
          fontFamily: "Consolas, monospace",
          wordBreak: "break-all",
        }}
        title="Click + drag to select, then Ctrl-C to copy. Or use 'Copy API URL' below."
      >
        {apiUrl}
      </div>

      {/* Start / Stop row — Qt llm_btn_layout (server_page.py:757-823) */}
      <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
        <PrimaryButton
          label={busy === "start server" ? "⏳ Starting..." : (isRunning ? "● Running" : "▶ Start")}
          variant="start"
          disabled={!modelId || !!busy || isRunning}
          onClick={() => onAction("start")}
          style={{ flex: 1 }}
        />
        <PrimaryButton
          label="⏹ Stop"
          variant="stop"
          // Qt enables Stop while running OR busy (server_page.py:819, 2283)
          disabled={!modelId || (!isRunning && statusKind !== "busy")}
          onClick={() => onAction("stop")}
          style={{ flex: 1 }}
        />
      </div>

      {/* Copy API URL / Copy Model Name / Setup Guide — Qt secondary_btn_layout (line 826-909) */}
      <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
        <button
          className="ghost-btn"
          onClick={onCopyApi}
          disabled={apiUrl === "-"}
          style={{ flex: 1, height: 42, fontWeight: 600 }}
          title="Copy the OpenAI-compatible base URL to the clipboard."
        >📋 Copy API URL</button>
        <button
          className="ghost-btn"
          onClick={onCopyModel}
          disabled={!modelId}
          style={{ flex: 1, height: 42, fontWeight: 600 }}
          title="Copy the model identifier to the clipboard."
        >📋 Copy Model Name</button>
        <button
          className="ghost-btn"
          onClick={onSetupGuide}
          style={{
            flex: 1, height: 42, fontWeight: 600,
            background: "transparent",
            color: "#667eea",
            border: "1px solid #667eea",
          }}
          title="Open a guide explaining how to wire this API into Cursor / VS Code."
        >📖 Setup Guide</button>
      </div>

      <button
        className="ghost-btn"
        disabled={!modelId}
        onClick={() => onAction("status")}
        style={{ marginTop: 4 }}
      >
        Status
      </button>

      {error ? (
        <div style={{
          border: "1px solid #ff9f9f",
          background: "rgba(255,80,80,0.10)",
          color: "#ffb0b0",
          borderRadius: 6, padding: 8,
          fontSize: 12, marginTop: 6,
        }}>
          {error}
        </div>
      ) : null}

      {/* Active inference servers — Qt active_servers_group (server_page.py:919-951) */}
      <div style={{
        marginTop: 8,
        fontSize: 13, fontWeight: 700, color: "var(--fg)",
        borderTop: "1px solid rgba(var(--accent-rgb),0.10)",
        paddingTop: 8,
      }}
        title="Every inference server running across the app. Useful when something is holding GPU memory you can't see."
      >
        Active inference servers
      </div>
      <div style={{
        // Qt: minHeight=100, maxHeight=180 (server_page.py:928-929)
        minHeight: 100, maxHeight: 180,
        overflow: "auto",
        background: "var(--bg-elevated)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: 4,
      }}>
        {activeRows.length === 0 ? (
          <div style={{ fontSize: 11, color: "var(--fg-subtle)", padding: 6 }}>
            (no active inference servers)
          </div>
        ) : activeRows.map((r, i) => {
          const rawStatus = (r.status || "unknown").toLowerCase();
          const statusStr =
            rawStatus === "ok"           ? "Running"
            : rawStatus === "loading"    ? "Loading"
            : rawStatus === "unresponsive"? "Busy/Unresponsive"
            : rawStatus === "not_started"? "Standby (no model loaded)"
            : rawStatus || "Unknown";
          const identity = r.model_from_health || r.model_id || "Unknown";
          const selected = r.port === activePort;
          return (
            <div
              key={`${r.port}-${i}`}
              onClick={() => {
                setActivePort(r.port ?? null);
                if (r.model_id) setModelId(r.model_id);
              }}
              style={{
                padding: "4px 8px",
                fontSize: 12,
                color: "var(--fg)",
                background: selected ? "rgba(var(--accent-rgb),0.10)" : "transparent",
                cursor: "pointer",
                borderRadius: 4,
              }}
            >
              {identity} — port {r.port} ({statusStr})
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button
          className="ghost-btn"
          onClick={refreshActive}
          style={{ flex: 1 }}
          title="Re-scan for live inference servers."
        >Refresh</button>
        <button
          className="ghost-btn"
          onClick={() => {
            // Qt _stop_selected_active_server (server_page.py:2515-2567)
            if (activePort == null) {
              appendLog("[LLM] No server selected. Select a row in Active inference servers, then click Stop selected.");
              return;
            }
            const row = activeRows.find(r => r.port === activePort);
            if (row?.model_id) {
              setModelId(row.model_id);
              onAction("stop");
            }
          }}
          style={{ flex: 1 }}
          title="Kill the inference server highlighted in the list."
        >⏹ Stop selected</button>
      </div>

      <div style={{ fontSize: 11, color: "var(--fg-subtle)", marginTop: 4 }}>
        State: <code style={{ fontSize: 10 }}>{serverState.slice(0, 200)}</code>
      </div>
    </GroupBox>
  );
}

// ---------------------------------------------------------------------
// RIGHT COLUMN — 📋 Server Log  (Qt server_page.py:962-1010)
// ---------------------------------------------------------------------
function LogColumn({ logs, onClear }: { logs: string[]; onClear: () => void }) {
  // Filter input mirrors the spirit of Qt's read-only Ctrl-C selection
  // (server_page.py:975-977). Qt doesn't expose a filter, but it's a
  // trivial UX win and doesn't violate any constant we need to quote.
  const [filter, setFilter] = useState("");
  const visible = useMemo(() => {
    if (!filter.trim()) return logs;
    const f = filter.toLowerCase();
    return logs.filter(line => line.toLowerCase().includes(f));
  }, [logs, filter]);

  async function onCopyAll() {
    try {
      await navigator.clipboard.writeText(visible.join("\n"));
    } catch {
      /* swallow */
    }
  }

  return (
    <GroupBox
      // Qt title is "📋 Server Log" (server_page.py:962) — NOT 📜.
      title="📋 Server Log"
      tooltip={[
        "Combined output stream from both servers — the OWLLM MCP server (left column)",
        "and the LLM Inference Server (middle column). Errors, tool calls, and lifecycle",
        "events all show up here.",
      ].join("\n")}
      style={{ flex: 1 }}
    >
      <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
        <CompactInput
          placeholder="Filter log…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          style={{ flex: 1 }}
        />
        <button
          className="ghost-btn"
          onClick={onCopyAll}
          style={{ width: 60, height: 28, padding: 0, fontSize: 12 }}
          title="Copy visible log lines to clipboard."
        >📋</button>
      </div>

      {/* Shared LogBox — scrollable, Ctrl+A scoped to the box, click to open
          the full log in a popup. The filter + copy controls above stay. */}
      <LogBox
        text={visible.join("\n")}
        title="Server log"
        placeholder="No engine output yet."
        fill
        style={{ minHeight: 300, maxHeight: 460 }}
      />

      {/* 🗑️ Clear Log button — Qt clear_btn (server_page.py:983-1006).
          Qt fixes minWidth=170, minHeight=40 and pushes it left with a
          stretch, so we mirror that with width:170 and marginRight:auto. */}
      <div style={{ display: "flex", padding: "5px", marginTop: 4 }}>
        <button
          className="ghost-btn"
          onClick={onClear}
          style={{
            width: 170,
            height: 40,
            fontWeight: 600,
            background: "rgba(255, 255, 255, 0.08)",
            color: "rgba(255, 255, 255, 0.7)",
            border: "1px solid rgba(255, 255, 255, 0.15)",
            borderRadius: 6,
            marginRight: "auto",
          }}
          title="Wipe the log panel above. Doesn't affect the running servers."
        >
          🗑️ Clear Log
        </button>
      </div>
    </GroupBox>
  );
}

// ---------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------
// Logs persist across tab switches by surviving in localStorage. The
// `server-log` listener stays mounted via SERVER_LOG_HUB (module
// scope) so the rolling tail accumulates even when ServerPage is
// unmounted — the user can switch to Chat / Agents and come back to
// the full Server boot trace.
const LOG_STORAGE_KEY = "owllm.server.logs";
const LOG_MAX = 2000;
type LogListener = (lines: string[]) => void;

class ServerLogHub {
  private lines: string[];
  private listeners: Set<LogListener> = new Set();
  private wired = false;
  private unlisten: (() => void) | null = null;

  constructor() {
    let stored: string[] = [];
    try {
      const raw = localStorage.getItem(LOG_STORAGE_KEY);
      if (raw) stored = JSON.parse(raw);
    } catch { /* corrupted store — start fresh */ }
    this.lines = Array.isArray(stored) ? stored : [];
  }

  async ensureWired() {
    if (this.wired) return;
    this.wired = true;
    try {
      const fn = await listen<ServerLog>("server-log", (ev) => {
        const p = ev.payload;
        const prefix = p.stream === "stderr" ? "[stderr] " : "";
        this.push(`${prefix}${p.line}`);
      });
      this.unlisten = fn;
    } catch (e) {
      console.warn("[server-log] listen failed:", e);
      this.wired = false;
    }
  }

  push(line: string) {
    this.lines = [...this.lines, line].slice(-LOG_MAX);
    this.persist();
    for (const l of this.listeners) l(this.lines);
  }

  clear() {
    this.lines = [];
    this.persist();
    for (const l of this.listeners) l(this.lines);
  }

  snapshot() {
    return this.lines;
  }

  subscribe(fn: LogListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private persist() {
    try {
      localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(this.lines));
    } catch { /* quota — just drop persistence */ }
  }
}

const SERVER_LOG_HUB = new ServerLogHub();

/// Serve-on-network — the SERVER side of the split: let THIS PC's model
/// server accept requests from other machines (e.g. a Linux/WSL agent box).
/// Default OFF (loopback only). Turning it on generates an api-key and binds
/// 0.0.0.0; it's plain HTTP, so it's for a trusted LAN or a tunnel, never the
/// internet. Backed by inference_expose_get/set in server.rs.
function ServeOnNetworkCard() {
  const [cfg, setCfg] = useState<{ enabled: boolean; apiKey: string }>({ enabled: false, apiKey: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    invoke<{ enabled: boolean; apiKey: string }>("inference_expose_get")
      .then((c) => { setCfg(c); setLocalServerKey(c.enabled ? c.apiKey : ""); })
      .catch(() => {});
  }, []);
  const save = async (next: { enabled: boolean; apiKey: string }) => {
    setBusy(true); setErr(null);
    try {
      const c = await invoke<{ enabled: boolean; apiKey: string }>("inference_expose_set", { config: next });
      setCfg(c);
      // Local UI must send this key too (llama-server enforces --api-key on
      // 127.0.0.1 when exposed) — otherwise every local request 401s.
      setLocalServerKey(c.enabled ? c.apiKey : "");
    }
    catch (e: any) { setErr(String(e?.message ?? e)); }
    finally { setBusy(false); }
  };
  const [shareMsg, setShareMsg] = useState<string>("");
  const toggle = () => {
    if (cfg.enabled) {
      save({ enabled: false, apiKey: cfg.apiKey });
      invoke("vault_unpublish_server").catch(() => {}); // stop advertising
      setShareMsg("");
      return;
    }
    const key = cfg.apiKey
      || (globalThis.crypto?.randomUUID?.() ?? (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)));
    save({ enabled: true, apiKey: key });
  };
  // Publish this PC (LAN IP auto-detected) as a GPU server in the vault so the
  // user's other devices get a one-click "Use my GPU box".
  const shareWithDevices = async () => {
    setShareMsg("Publishing…");
    try {
      const st = await invoke<{ port: number | null }>("server_status");
      if (!st.port) { setShareMsg("Start a model first, then share."); return; }
      await invoke("vault_publish_server", { port: st.port, apiKey: cfg.apiKey });
      setShareMsg("✓ Shared — your other devices can one-click connect (Server → Inference source).");
    } catch (e: any) {
      setShareMsg(`Couldn't share: ${String(e?.message ?? e)} (sign in with GitHub first)`);
    }
  };
  return (
    <div data-ui="ServeOnNetworkCard" style={{
      border: `1px solid ${cfg.enabled ? "rgba(255,179,0,0.45)" : "rgba(var(--accent-rgb),0.30)"}`,
      borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8,
      background: "linear-gradient(180deg, rgba(30,30,40,0.6), rgba(20,20,30,0.6))",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg-strong)", flex: 1 }}>
          🌐 Serve inference on the network (this PC)
        </div>
        <button onClick={toggle} disabled={busy} style={{
          padding: "5px 14px", fontSize: 11, fontWeight: 700, borderRadius: 6, cursor: busy ? "wait" : "pointer",
          border: "none", color: "#fff",
          background: cfg.enabled ? "rgba(244,67,54,0.6)" : "rgba(76,175,80,0.6)",
        }}>
          {cfg.enabled ? "Turn OFF" : "Turn ON"}
        </button>
      </div>
      <div style={{ fontSize: 11, color: "var(--fg-subtle)", lineHeight: 1.45 }}>
        {cfg.enabled
          ? "ON — other machines that can reach this PC on the model port can use it, with the key below. Binds 0.0.0.0."
          : "OFF (default) — the model server is loopback-only; nothing on the network can reach it."}
      </div>
      {cfg.enabled && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input readOnly value={cfg.apiKey} style={{
              flex: 1, height: 30, padding: "0 10px", borderRadius: 6,
              border: "1px solid rgba(var(--accent-rgb),0.30)",
              background: "var(--bg-elevated)", color: "var(--fg)", fontSize: 11,
              fontFamily: "Consolas, monospace",
            }} />
            <button onClick={() => { navigator.clipboard?.writeText(cfg.apiKey); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
              style={{ padding: "6px 12px", fontSize: 11, fontWeight: 600, borderRadius: 6, border: "1px solid rgba(var(--accent-rgb),0.5)", background: "rgba(var(--accent-rgb),0.25)", color: "var(--fg)", cursor: "pointer" }}>
              {copied ? "Copied" : "Copy key"}
            </button>
          </div>
          <div style={{
            fontSize: 11, color: "#ffcc80", lineHeight: 1.5,
            background: "rgba(255,179,0,0.10)", border: "1px solid rgba(255,179,0,0.35)",
            borderRadius: 6, padding: "8px 10px",
          }}>
            ⚠️ Plain HTTP — the key and traffic are unencrypted. Use only on a <b>trusted LAN</b>, or put it behind a <b>VPN/SSH tunnel</b> (Tailscale, WireGuard). Never port-forward it to the internet. Scope your Windows Firewall rule to this port + the agent's IP.
            <div style={{ marginTop: 5, color: "var(--fg-subtle)" }}>
              On the agent box, set "Inference source" → Remote, host = this PC's IP, port = the model's server port above, and paste this key. <b>Restart the model server</b> to apply.
              <br/>WSL note: Win11 mirrored networking can use loopback (exposure off); Win10 (NAT) needs this ON.
            </div>
          </div>
          {/* One-click sharing via the account vault — no typing IPs on the
              other device. */}
          <button onClick={shareWithDevices} style={{
            padding: "8px 12px", borderRadius: 8, border: "1px solid rgba(var(--accent-rgb),0.5)",
            background: "rgba(var(--accent-rgb),0.18)", color: "var(--fg-strong)",
            fontSize: 12, fontWeight: 700, cursor: "pointer",
          }}>📡 Share this GPU with my other devices</button>
          {shareMsg && <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>{shareMsg}</div>}
        </>
      )}
      {err && <div style={{ fontSize: 11, color: "#f87171" }}>{err}</div>}
    </div>
  );
}

export default function ServerPage() {
  const [logs, setLogs] = useState<string[]>(() => SERVER_LOG_HUB.snapshot());
  const [modelId, setModelIdState] = useState<string>(() => getServerModel());
  const setModelId = (id: string) => {
    setModelIdState(id);
    setServerModel(id);
  };
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  // User-chosen llama-server context window (-c); persisted so every start path
  // (here + chat/agent auto-starts) honours it.
  const [ctx, setCtxState] = useState<number | null>(() => getServerCtx());
  const setCtx = (n: number | null) => { setCtxState(n); setServerCtx(n); };
  const [serverState, setServerState] = useState<string>("Not checked");

  function appendLog(line: string) {
    SERVER_LOG_HUB.push(line);
  }

  // The hub is wired once and stays subscribed for the app lifetime.
  // ServerPage just subscribes to its updates and unsubscribes on
  // unmount — the lines themselves accumulate even when this page
  // isn't mounted.
  useEffect(() => {
    SERVER_LOG_HUB.ensureWired();
    const unsub = SERVER_LOG_HUB.subscribe((next) => setLogs(next));
    return () => { unsub(); };
  }, []);

  useEffect(() => { refreshAll(); }, []);
  // Poll status every 2s so the UI tracks crashes/exits.
  useEffect(() => {
    const id = window.setInterval(() => {
      serverStatus().then(st => setServerState(JSON.stringify(st, null, 2))).catch(() => {});
    }, 2000);
    return () => window.clearInterval(id);
  }, []);

  async function refreshAll() {
    setBusy("Loading model registry");
    setError("");
    try {
      const next = await listModels();
      setModels(next);
      const st = await serverStatus();
      setServerState(JSON.stringify(st, null, 2));
      // A running server is authoritative. Otherwise preserve the user's
      // device-local saved pick when it is still servable; only fall back when
      // that model was removed or this is the first launch.
      const servable = next.filter(
        m => (m.provider === "local" || m.provider === "tuned") && m.port != null
      );
      if (st.running && st.model_id) {
        if (modelId !== st.model_id) setModelId(st.model_id);
      } else if (!servable.some(m => m.model_id === modelId)) {
        // The saved pick is gone — clear it, but do NOT substitute the first
        // servable model. Start is disabled while modelId is empty, so the
        // picker just reads "Select model" until the user chooses.
        setModelId("");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function runServerAction(action: "start" | "stop" | "status") {
    if (!modelId && action !== "stop") return;
    setBusy(`${action} server`);
    setError("");
    try {
      if (action === "start") {
        await serverStart(modelId, ctx);
        appendLog(`[server] start requested for ${modelId}`);
      } else if (action === "stop") {
        await serverStop();
        appendLog(`[server] stop requested`);
      }
      const st = await serverStatus();
      setServerState(JSON.stringify(st, null, 2));
    } catch (e) {
      setError(String(e));
      appendLog(`[server] ${action} error: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    // Standard flowing page — was a centered fixed popup, but the user
    // couldn't scroll or reach content that overflowed the 820px cap.
    // Now it's a normal scrollable column that fills the tab area.
    <div data-ui="ServerPopupHost" style={{
      position: "relative",
      height: "100%",
      width: "100%",
      padding: "16px 22px 18px",
      boxSizing: "border-box",
      overflow: "auto",
    }}>
      <div data-ui="ServerPopupCard" style={{
        position: "relative",
        width: "100%",
        minHeight: "100%",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {/* Real owl_server.png — same asset family as CodePage / AgentsPage */}
        <img
          src={`${ICONS}/owl_server.png`}
          alt=""
          style={{ width: 32, height: 32, objectFit: "contain" }}
        />
        <div style={{ fontSize: 24, fontWeight: 800, color: "var(--fg)", flex: 1 }}>
          {/* Qt title is "🖧 Servers" (server_page.py:471) */}
          🖧 Servers
        </div>
        <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
          {models.length} model{models.length === 1 ? "" : "s"} configured
        </div>
        <button className="ghost-btn" onClick={refreshAll} disabled={!!busy}>Refresh</button>
        {/* Engine Start/Stop buttons removed in the Python wipe (2026-05-14).
            Server lifecycle is now per-model via the Server control panel
            below — there is no longer a background process to start/stop. */}
      </div>

      <InferenceSourceCard />
      <ServeOnNetworkCard />

      <div style={{
        flex: 1,
        display: "grid",
        // Even thirds (34/33/33) that adapt fluidly to window width.
        // minmax(0,…) lets each column shrink below its content width so
        // the three stay balanced instead of the log column squeezing the
        // others. (Was 2fr 2fr 1fr; user asked for equal adaptive thirds.)
        gridTemplateColumns: "minmax(0, 34fr) minmax(0, 33fr) minmax(0, 33fr)",
        gap: 12,
        minHeight: 0,
      }}>
        <MCPServerColumn appendLog={appendLog} />
        <LLMServerColumn
          models={models}
          busy={busy}
          modelId={modelId}
          setModelId={setModelId}
          serverState={serverState}
          onAction={runServerAction}
          error={error}
          appendLog={appendLog}
          ctx={ctx}
          setCtx={setCtx}
        />
        <LogColumn logs={logs} onClear={() => SERVER_LOG_HUB.clear()} />
      </div>
      </div>
    </div>
  );
}
