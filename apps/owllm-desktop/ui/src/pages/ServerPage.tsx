// ServerPage — ported from LLM/desktop_app/pages/server_page.py
// (ServerPage._setup_ui, line 463). Three-column splitter:
//
//   ┌─ 🛠️ OWLLM MCP ──────┬─ 🤖 LLM Inference ─┬─ 📜 Server Log ─┐
//   │ status / address    │ status              │  scrolling log │
//   │ ▶ Start Server      │ model selector      │                │
//   │ Port / Token / Root │ ▶ Start  ⏹ Stop     │                │
//   │ ♥ Health  💾 Save   │ Active Servers list │                │
//   └─────────────────────┴─────────────────────┴────────────────┘
//
// The PySide6 page has heavy lifecycle code (background threads for
// server start, active-server probe, LLM status probe) — those run
// in the Rust supervisor + Python engine in the new app. The React
// page is the control surface: pulls /v1/models, /v1/server/status,
// /v1/hardware via the existing `engine_get` / `engine_post` Tauri
// commands, and emits Start/Stop via /v1/server/start | /stop.
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
function GroupBox({ title, children }: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: "linear-gradient(180deg, rgba(60,60,80,0.4), rgba(40,40,60,0.4))",
        border: "1px solid rgba(127,223,255,0.20)",
        borderRadius: 10,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
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

function StatusDot({ state, label }: {
  state: "on" | "off" | "warn"; label: string;
}) {
  const color = state === "on" ? "#22c55e"
              : state === "warn" ? "#fbbf24"
              : "#9aa0a6";
  return (
    <div style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
      fontSize: 13, fontWeight: 700,
      color: "#dadcdf",
    }}>
      <span style={{
        width: 10, height: 10, borderRadius: 5,
        background: color, boxShadow: `0 0 6px ${color}`,
      }} />
      {label}
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

function PrimaryButton({
  label, variant = "neutral", ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  variant?: "neutral" | "start" | "stop";
}) {
  const colors = {
    neutral: { bg: "linear-gradient(180deg, #4a6cff, #3a55cc)", fg: "#fff", border: "none" },
    start:   { bg: "linear-gradient(180deg, #4CAF50, #388E3C)", fg: "#fff", border: "none" },
    stop:    { bg: "rgba(239,68,68,0.18)", fg: "#ff8c8c", border: "1px solid rgba(239,68,68,0.55)" },
  }[variant];
  return (
    <button
      {...rest}
      style={{
        height: 36,
        padding: "0 14px",
        borderRadius: 8,
        background: colors.bg,
        color: colors.fg,
        border: colors.border,
        fontSize: 13, fontWeight: 700,
        cursor: "pointer",
        ...rest.style,
      }}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------
// Columns. Each maps one PySide6 GroupBox in _setup_ui.
// ---------------------------------------------------------------------
function MCPServerColumn() {
  // Port / Token / Root state — visual only, no functional save yet
  // (PySide6 binds these into config_manager; the new app will once
  // we add a /v1/mcp_server endpoint).
  const [port,  setPort]  = useState("8763");
  const [lan,   setLan]   = useState(false);
  const [token, setToken] = useState("");
  const [root,  setRoot]  = useState("C:/1_Git/LocaLLM");
  const [running, setRunning] = useState(false);
  return (
    <GroupBox title="🛠️ OWLLM MCP">
      <StatusDot state={running ? "on" : "off"} label={running ? "● Running" : "● Stopped"} />
      <div style={{ fontSize: 12, color: "#9aa0a6" }}>
        Address: {running ? `http://127.0.0.1:${port}` : "-"}
      </div>
      <PrimaryButton
        label={running ? "⏹ Stop Server" : "▶ Start Server"}
        variant={running ? "stop" : "start"}
        onClick={() => setRunning(v => !v)}
      />

      <div style={{
        display: "grid",
        gridTemplateColumns: "60px 1fr auto",
        gap: 6, alignItems: "center",
        marginTop: 6,
      }}>
        <span style={{ fontSize: 12, color: "#aaa" }}>Port:</span>
        <CompactInput value={port} onChange={e => setPort(e.target.value)} style={{ width: 84 }} />
        <label style={{ fontSize: 12, color: "#dadcdf", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={lan}
            onChange={e => setLan(e.target.checked)}
            style={{ accentColor: "#7fdfff" }}
          />
          LAN
        </label>

        <span style={{ fontSize: 12, color: "#aaa" }}>Token:</span>
        <CompactInput type="password" placeholder="Auth token" value={token} onChange={e => setToken(e.target.value)} />
        <button
          className="ghost-btn"
          onClick={() => setToken(crypto.randomUUID().replace(/-/g, "").slice(0, 32))}
          style={{ width: 32, height: 28, padding: 0, fontSize: 14 }}
          title="Generate a fresh random token"
        >🎲</button>

        <span style={{ fontSize: 12, color: "#aaa" }}>Root:</span>
        <CompactInput value={root} onChange={e => setRoot(e.target.value)} />
        <button
          className="ghost-btn"
          style={{ width: 32, height: 28, padding: 0, fontSize: 14 }}
          title="Pick a workspace root"
        >📁</button>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        <button className="ghost-btn" disabled={!running}>♥ Health</button>
        <button className="ghost-btn">💾 Save</button>
      </div>
    </GroupBox>
  );
}

function LLMServerColumn({
  models, busy, modelId, setModelId, serverState, onAction, error,
}: {
  models: ModelInfo[];
  busy: string | null;
  modelId: string;
  setModelId: (v: string) => void;
  serverState: string;
  onAction: (a: "start" | "stop" | "status") => void;
  error: string;
}) {
  const selectedModel = models.find(m => m.model_id === modelId);
  return (
    <GroupBox title="🤖 LLM Inference Server">
      <StatusDot
        state={serverState.includes("running") ? "on" : "off"}
        label={serverState.includes("running") ? "● Running" : "● Not running"}
      />

      <div style={{ fontSize: 12, fontWeight: 700, color: "#dadcdf", marginTop: 4 }}>
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
          <option value="">(no models in llm_backends.yaml)</option>
        ) : (
          models.map(m => (
            <option key={m.model_id} value={m.model_id}>{m.model_id}</option>
          ))
        )}
      </select>

      <div style={{
        display: "grid",
        gridTemplateColumns: "60px 1fr",
        gap: 4, fontSize: 12, marginTop: 4,
      }}>
        <span style={{ color: "#aaa" }}>Model:</span>
        <span style={{ color: "#dadcdf", overflow: "hidden", textOverflow: "ellipsis" }}>
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
          fontSize: 11, color: "#7fdfff",
          padding: "6px 10px",
          background: "#0a0d14",
          borderRadius: 6,
          userSelect: "text",
          fontFamily: "Consolas, monospace",
        }}
      >
        {selectedModel?.port ? `http://127.0.0.1:${selectedModel.port}/v1` : "-"}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        <PrimaryButton
          label={busy ? `${busy}…` : "▶ Start"}
          variant="start"
          disabled={!modelId || !!busy}
          onClick={() => onAction("start")}
          style={{ flex: 1, minHeight: 42 }}
        />
        <PrimaryButton
          label="⏹ Stop"
          variant="stop"
          disabled={!modelId || !!busy}
          onClick={() => onAction("stop")}
          style={{ flex: 1, minHeight: 42 }}
        />
      </div>
      <button className="ghost-btn" disabled={!modelId} onClick={() => onAction("status")}>
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

      <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>
        State: <code>{serverState.slice(0, 200)}</code>
      </div>
    </GroupBox>
  );
}

function LogColumn({ logs }: { logs: string[] }) {
  return (
    <GroupBox title="📜 Server Log">
      <pre style={{
        flex: 1,
        minHeight: 460,
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
        {logs.length ? logs.join("\n") : "No engine output yet."}
      </pre>
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
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  // Engine-control header (Rust supervisor lifecycle).
  return (
    <div style={{ padding: "14px 18px", height: "100%", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ fontSize: 24, fontWeight: 800, color: "#dadcdf", flex: 1 }}>
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
        gridTemplateColumns: "1fr 1fr 1fr",
        gap: 12,
        minHeight: 0,
      }}>
        <MCPServerColumn />
        <LLMServerColumn
          models={models}
          busy={busy}
          modelId={modelId}
          setModelId={setModelId}
          serverState={serverState}
          onAction={runServerAction}
          error={error}
        />
        <LogColumn logs={logs} />
      </div>
    </div>
  );
}
