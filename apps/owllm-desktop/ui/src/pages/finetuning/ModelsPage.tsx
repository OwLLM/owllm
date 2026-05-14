// ModelsPage — browses every GGUF found under LLM/models/ via the
// native list_models scanner. Read-only for now: each row shows the
// model id, size, port the server would bind, and the full path. A
// Start button hands the model off to server_start so the user
// doesn't have to bounce to the Server tab.
//
// Qt: main.py::_build_models_tab (line 7997) was a full catalog +
// downloader. That's intentionally out of scope here — the value of
// this first cut is making the discovered models visible and one-
// click runnable.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const ICONS = "/Page_icons";

type ModelInfo = {
  model_id: string;
  port?: number | null;
  base_model?: string | null;
  size_mib?: number | null;
};

type ServerStatus = {
  running: boolean;
  model_id: string | null;
  port: number | null;
  message: string;
};

function formatSize(mib?: number | null): string {
  if (mib == null) return "—";
  if (mib < 1024) return `${mib} MiB`;
  return `${(mib / 1024).toFixed(2)} GiB`;
}

export default function ModelsPage() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [status, setStatus] = useState<ServerStatus>({
    running: false, model_id: null, port: null, message: "",
  });
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    setBusy("scanning");
    try {
      const [m, s] = await Promise.all([
        invoke<ModelInfo[]>("list_models"),
        invoke<ServerStatus>("server_status"),
      ]);
      setModels(m);
      setStatus(s);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    refresh();
    // 5s status poll so the "RUNNING" highlight tracks reality
    // even if the user starts/stops from another tab.
    const id = window.setInterval(async () => {
      try {
        const s = await invoke<ServerStatus>("server_status");
        setStatus(s);
      } catch { /* ignore */ }
    }, 5000);
    return () => window.clearInterval(id);
  }, []);

  async function startModel(modelId: string) {
    setError(null);
    setBusy(`starting ${modelId}`);
    try {
      await invoke("server_start", { modelId });
      const s = await invoke<ServerStatus>("server_status");
      setStatus(s);
    } catch (e) {
      setError(`Start failed: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  async function stopServer() {
    setError(null);
    setBusy("stopping");
    try {
      await invoke("server_stop");
      const s = await invoke<ServerStatus>("server_status");
      setStatus(s);
    } catch (e) {
      setError(`Stop failed: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return models;
    return models.filter(m => m.model_id.toLowerCase().includes(f));
  }, [models, filter]);

  return (
    <div style={{
      padding: "14px 18px",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      gap: 12,
      background: "#0e1117",
      color: "#dadcdf",
      minHeight: 0,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <img
          src={`${ICONS}/owl_training.png`}
          alt=""
          style={{ width: 32, height: 32, objectFit: "contain" }}
        />
        <div style={{ fontSize: 24, fontWeight: 800, color: "#fff" }}>📦 Models</div>
        <div style={{ flex: 1 }} />
        <input
          placeholder="Filter…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          style={{
            height: 30, padding: "0 10px", borderRadius: 6,
            border: "1px solid rgba(255,255,255,0.10)",
            background: "#0a0d14", color: "#dadcdf", fontSize: 12,
            minWidth: 220,
          }}
        />
        <button className="ghost-btn" onClick={refresh} disabled={!!busy}>
          {busy === "scanning" ? "Scanning…" : "🔄 Refresh"}
        </button>
        {status.running ? (
          <button
            onClick={stopServer}
            disabled={!!busy}
            style={{
              height: 30, padding: "0 14px", borderRadius: 6,
              background: "linear-gradient(180deg, #f44336, #d32f2f)",
              color: "#fff", border: "none",
              fontSize: 12, fontWeight: 700, cursor: "pointer",
            }}
            title="Stop the running model server."
          >⏹ Stop server</button>
        ) : null}
      </div>

      <div style={{ fontSize: 12, color: "#9aa0a6" }}>
        {models.length} GGUF{models.length === 1 ? "" : "s"} discovered under{" "}
        <code style={{ color: "#7fdfff" }}>LLM/models/</code>
        {status.running ? (
          <> · Active: <span style={{ color: "#a0e88a", fontWeight: 700 }}>{status.model_id}</span> on port {status.port}</>
        ) : null}
      </div>

      {error ? (
        <div style={{
          border: "1px solid #ff9f9f",
          background: "rgba(255,80,80,0.10)",
          color: "#ffb0b0",
          borderRadius: 6, padding: 8,
          fontSize: 12,
        }}>{error}</div>
      ) : null}

      <div style={{
        flex: 1, minHeight: 0, overflowY: "auto",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 8, background: "#0a0d14",
      }}>
        {visible.length === 0 ? (
          <div style={{ padding: 24, fontSize: 12, color: "#7a7f87", textAlign: "center" }}>
            {models.length === 0
              ? "No GGUF files found under LLM/models/. Drop a model file there and click Refresh."
              : "No models match the filter."}
          </div>
        ) : (
          <table style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 12,
          }}>
            <thead>
              <tr style={{
                fontSize: 11, color: "#9aa0a6", textAlign: "left",
                borderBottom: "1px solid rgba(255,255,255,0.10)",
                background: "#0e1117",
              }}>
                <th style={{ padding: "8px 12px", fontWeight: 600 }}>Model ID</th>
                <th style={{ padding: "8px 12px", fontWeight: 600, width: 110 }}>Size</th>
                <th style={{ padding: "8px 12px", fontWeight: 600, width: 80 }}>Port</th>
                <th style={{ padding: "8px 12px", fontWeight: 600 }}>Path</th>
                <th style={{ padding: "8px 12px", fontWeight: 600, width: 130 }}></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((m, i) => {
                const isRunning = status.running && status.model_id === m.model_id;
                const startBusy = busy === `starting ${m.model_id}`;
                return (
                  <tr key={m.model_id} style={{
                    borderBottom: "1px solid rgba(255,255,255,0.05)",
                    background: isRunning
                      ? "rgba(127,223,255,0.06)"
                      : (i % 2 === 1 ? "rgba(255,255,255,0.015)" : "transparent"),
                  }}>
                    <td style={{ padding: "8px 12px", color: isRunning ? "#7fdfff" : "#dadcdf", fontWeight: isRunning ? 700 : 400 }}>
                      {isRunning ? "▶ " : ""}{m.model_id}
                    </td>
                    <td style={{ padding: "8px 12px", color: "#9aa0a6", whiteSpace: "nowrap" }}>
                      {formatSize(m.size_mib)}
                    </td>
                    <td style={{ padding: "8px 12px", color: "#9aa0a6" }}>
                      {m.port ?? "—"}
                    </td>
                    <td style={{
                      padding: "8px 12px",
                      color: "#7a7f87",
                      fontFamily: "Consolas, monospace",
                      fontSize: 11,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: 0,
                    }}
                      title={m.base_model ?? ""}
                    >
                      {m.base_model ?? "—"}
                    </td>
                    <td style={{ padding: "6px 12px", textAlign: "right" }}>
                      {isRunning ? (
                        <button
                          onClick={stopServer}
                          disabled={!!busy}
                          style={{
                            height: 26, padding: "0 12px", borderRadius: 5,
                            background: "linear-gradient(180deg, #f44336, #d32f2f)",
                            color: "#fff", border: "none",
                            fontSize: 11, fontWeight: 700, cursor: "pointer",
                          }}
                        >⏹ Stop</button>
                      ) : (
                        <button
                          onClick={() => startModel(m.model_id)}
                          disabled={!!busy}
                          style={{
                            height: 26, padding: "0 12px", borderRadius: 5,
                            background: startBusy
                              ? "rgba(127,223,255,0.20)"
                              : "linear-gradient(180deg, #4CAF50, #388E3C)",
                            color: "#fff", border: "none",
                            fontSize: 11, fontWeight: 700,
                            cursor: busy ? "not-allowed" : "pointer",
                            opacity: busy && !startBusy ? 0.5 : 1,
                          }}
                          title={`Start llama-server on ${m.base_model}`}
                        >{startBusy ? "Starting…" : "▶ Start"}</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
