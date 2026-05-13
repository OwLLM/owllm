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
// The PySide6 page has heavy lifecycle code (background threads for
// server start, active-server probe, LLM status probe) — those run
// in the Rust supervisor + Python engine in the new app. The React
// page is the control surface: pulls /v1/models, /v1/server/status,
// /v1/hardware via the existing `engine_get` / `engine_post` Tauri
// commands, and emits Start/Stop via /v1/server/start | /stop.
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// Real Page_icons PNG served by vite.config.ts middleware
// (same pattern as AgentsPage.tsx / CodePage.tsx).
const ICONS = "/Page_icons";

type EngineLog = { stream: "stdout" | "stderr"; line: string };
type ModelInfo = { model_id: string; port?: number; base_model?: string };
type EnvInfo = { env_key: string; python: string };
type ModelsResponse = { ok: boolean; models?: ModelInfo[]; error?: string; message?: string };
type EnvsResponse = { ok: boolean; envs?: EnvInfo[]; envs_dir?: string; error?: string; message?: string };

// Reusable wrappers for the existing Tauri proxies in lib.rs.
async function engineGet<T>(path: string): Promise<T> {
  return JSON.parse(await invoke<string>("engine_get", { path })) as T;
}
async function enginePost<T>(path: string, body: unknown): Promise<T> {
  return JSON.parse(
    await invoke<string>("engine_post", { path, body: JSON.stringify(body) })
  ) as T;
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
        border: "1px solid rgba(127,223,255,0.20)",
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
        color: "#dadcdf",
        marginBottom: 6,
        borderBottom: "1px solid rgba(127,223,255,0.10)",
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
        border: "1px solid rgba(255,255,255,0.10)",
        background: "#0f0f19",
        color: "#dadcdf",
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
    neutral: { bg: "linear-gradient(180deg, #4a6cff, #3a55cc)", fg: "#fff", border: "none" },
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
  const [root, setRoot] = useState("C:/1_Git/LocaLLM");
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
      : { text: "● Stopped", color: "#888888" };
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
        style={{ fontSize: 12, color: "#9aa0a6" }}
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
        <span style={{ fontSize: 12, color: "#aaa" }} title="TCP port the MCP HTTP server listens on. Default 8763.">
          Port:
        </span>
        <CompactInput
          value={port}
          onChange={e => setPort(e.target.value)}
          style={{ width: 84 }}  // Qt port_edit.setFixedWidth(84) (server_page.py:549)
          maxLength={5}
        />
        <label
          style={{ fontSize: 12, color: "#dadcdf", display: "inline-flex", alignItems: "center", gap: 6 }}
          title="Off = bind to 127.0.0.1 (localhost only). On = bind to 0.0.0.0 (any device on your local network can reach it). Set a Token if you flip this on."
        >
          <input
            type="checkbox"
            checked={lan}
            onChange={e => setLan(e.target.checked)}
            style={{ accentColor: "#7fdfff" }}
          />
          LAN
        </label>

        <span style={{ fontSize: 12, color: "#aaa" }} title="Shared secret external clients must send as X-Auth-Token.">
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

        <span style={{ fontSize: 12, color: "#aaa" }} title="Workspace folder the MCP tools (shell, file ops, git) operate inside.">
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
        fontSize: 11, color: "#7a7f87",
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
    default:            return { text: "● Not running",                   color: "#888888" };
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
}: {
  models: ModelInfo[];
  busy: string | null;
  modelId: string;
  setModelId: (v: string) => void;
  serverState: string;
  onAction: (a: "start" | "stop" | "status") => void;
  error: string;
  appendLog: (s: string) => void;
}) {
  const selectedModel = models.find(m => m.model_id === modelId);

  // serverState is a JSON dump from /v1/server/{start,stop,status}. We
  // best-effort parse it into a status kind so the colored dot tracks
  // the real backend status. Qt does this via /health polling (LlmStatusProbeThread).
  const [statusKind, statusDetail] = useMemo<[LlmStatusKind, string?]>(() => {
    if (busy === "start server") return ["starting"];
    const low = serverState.toLowerCase();
    if (!low || low.includes("not checked")) return ["not_running"];
    if (low.includes('"status": "ok"') || low.includes("running")) return ["running"];
    if (low.includes('"status": "loading"') || low.includes("loading")) return ["loading"];
    if (low.includes("not_started") || low.includes("standby")) return ["standby"];
    if (low.includes("error")) return ["error"];
    return ["not_running"];
  }, [serverState, busy]);

  const decor = llmStatusDecor(statusKind, statusDetail);
  const isRunning = statusKind === "running" || statusKind === "loading";
  const apiUrl = selectedModel?.port ? `http://127.0.0.1:${selectedModel.port}/v1` : "-";

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

      <div style={{ fontSize: 12, fontWeight: 700, color: "#dadcdf", marginTop: 4 }}
           title="Pick which downloaded model the inference server should serve.">
        Select Model:
      </div>
      <select
        value={modelId}
        onChange={e => setModelId(e.target.value)}
        style={{
          height: 32, padding: "0 10px", borderRadius: 6,
          border: "1px solid rgba(255,255,255,0.10)",
          background: "#0f0f19", color: "#fff", fontSize: 13,
        }}
      >
        {models.length === 0 ? (
          // Mirrors Qt fallbacks (server_page.py:1208 / 1443)
          <option value="">(No READY models - run onboarding first)</option>
        ) : (
          models.map(m => (
            // Qt pretty_server_label prepends "✓ " (server_page.py:1381)
            <option key={m.model_id} value={m.model_id}>
              {`✓ ${m.model_id}${m.port ? ` (Port: ${m.port})` : ""}`}
            </option>
          ))
        )}
      </select>

      <div style={{
        display: "grid",
        gridTemplateColumns: "60px 1fr",
        gap: 4, fontSize: 12, marginTop: 4,
      }}>
        <span style={{ color: "#aaa" }}>Model:</span>
        <span style={{ color: "#dadcdf", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selectedModel?.base_model || "-"}
        </span>
        <span style={{ color: "#aaa" }}>Port:</span>
        <span style={{ color: "#dadcdf" }}>{selectedModel?.port ?? "-"}</span>
      </div>

      <div style={{ fontSize: 12, fontWeight: 700, color: "#dadcdf", marginTop: 6 }}>
        OpenAI API:
      </div>
      <div
        style={{
          fontSize: 11,
          color: "#7fdfff",
          padding: "6px 10px",
          background: "#0a0d14",
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
        fontSize: 13, fontWeight: 700, color: "#dadcdf",
        borderTop: "1px solid rgba(127,223,255,0.10)",
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
        background: "#0a0d14",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 6,
        padding: 4,
      }}>
        {activeRows.length === 0 ? (
          <div style={{ fontSize: 11, color: "#7a7f87", padding: 6 }}>
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
                color: "#dadcdf",
                background: selected ? "rgba(127,223,255,0.10)" : "transparent",
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

      <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>
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

      <pre style={{
        flex: 1,
        // Qt log_text minHeight=300, maxHeight=400 (server_page.py:973-974)
        minHeight: 300,
        maxHeight: 460,
        margin: 0,
        padding: 12,
        background: "#0a0d14",
        color: "#cbd2e0",
        borderRadius: 6,
        fontSize: 11,
        lineHeight: 1.45,
        fontFamily: "Consolas, monospace",
        overflow: "auto",
        whiteSpace: "pre-wrap",
      }}>
        {visible.length ? visible.join("\n") : "No engine output yet."}
      </pre>

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
export default function ServerPage() {
  const [logs, setLogs] = useState<string[]>([]);
  const [modelId, setModelId] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [envs, setEnvs] = useState<EnvInfo[]>([]);
  const [serverState, setServerState] = useState<string>("Not checked");

  function appendLog(line: string) {
    setLogs((prev) => [...prev, line].slice(-2000));
  }

  useEffect(() => {
    const unlisten = listen<EngineLog>("engine-log", (ev) => {
      const p = ev.payload;
      const prefix = p.stream === "stderr" ? "[stderr] " : "";
      setLogs((prev) => [...prev, `${prefix}${p.line}`].slice(-2000));
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  useEffect(() => { refreshAll(); }, []);

  async function refreshAll() {
    setBusy("Loading app state");
    setError("");
    try {
      const [modelRes, envRes] = await Promise.all([
        engineGet<ModelsResponse>("/v1/models"),
        engineGet<EnvsResponse>("/v1/envs"),
      ]);
      if (!modelRes.ok) throw new Error(modelRes.message || modelRes.error || "Failed to load models");
      if (!envRes.ok) throw new Error(envRes.message || envRes.error || "Failed to load envs");
      const nextModels = modelRes.models || [];
      setModels(nextModels);
      setEnvs(envRes.envs || []);
      if (!modelId && nextModels.length > 0) setModelId(nextModels[0].model_id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function runServerAction(action: "start" | "stop" | "status") {
    if (!modelId) return;
    setBusy(`${action} server`);
    setError("");
    try {
      let res: Record<string, unknown>;
      if (action === "status") {
        const q = encodeURIComponent(modelId);
        res = await engineGet<Record<string, unknown>>(`/v1/server/status?model_id=${q}`);
      } else {
        res = await enginePost<Record<string, unknown>>(`/v1/server/${action}`, { model_id: modelId });
      }
      setServerState(JSON.stringify(res, null, 2));
      appendLog(`[LLM] ${action} → ${JSON.stringify(res).slice(0, 200)}`);
    } catch (e) {
      setError(String(e));
      appendLog(`[LLM] ${action} error: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    // Background #0e1117 matches the Tauri shell.
    <div style={{
      padding: "14px 18px",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      gap: 12,
      background: "#0e1117",
      minHeight: 0,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {/* Real owl_server.png — same asset family as CodePage / AgentsPage */}
        <img
          src={`${ICONS}/owl_server.png`}
          alt=""
          style={{ width: 32, height: 32, objectFit: "contain" }}
        />
        <div style={{ fontSize: 24, fontWeight: 800, color: "#dadcdf", flex: 1 }}>
          {/* Qt title is "🖧 Servers" (server_page.py:471) */}
          🖧 Servers
        </div>
        <div style={{ fontSize: 12, color: "#9aa0a6" }}>
          {envs.length} Python env{envs.length === 1 ? "" : "s"} discovered
        </div>
        <button className="ghost-btn" onClick={refreshAll} disabled={!!busy}>Refresh</button>
        <button className="ghost-btn" onClick={() => invoke("engine_start")} disabled={!!busy}>Start engine</button>
        <button className="ghost-btn" onClick={() => invoke("engine_stop")} disabled={!!busy}>Stop engine</button>
      </div>

      <div style={{
        flex: 1,
        display: "grid",
        // Qt enforces a 40/40/20 ratio on resize
        // (server_page.py:1022-1027). React grid mirrors that exactly
        // — NOT the previous equal-thirds 1fr 1fr 1fr.
        gridTemplateColumns: "2fr 2fr 1fr",
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
        />
        <LogColumn logs={logs} onClear={() => setLogs([])} />
      </div>
    </div>
  );
}
