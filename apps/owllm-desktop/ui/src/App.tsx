import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type EngineLog = { stream: "stdout" | "stderr"; line: string };
type ModelInfo = { model_id: string; port?: number; base_model?: string };
type EnvInfo = { env_key: string; python: string };
type ModelsResponse = { ok: boolean; models?: ModelInfo[]; error?: string; message?: string };
type EnvsResponse = { ok: boolean; envs?: EnvInfo[]; envs_dir?: string; error?: string; message?: string };

export function App() {
  const [logs, setLogs] = useState<string[]>([]);
  const [modelId, setModelId] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [envs, setEnvs] = useState<EnvInfo[]>([]);
  const [hardware, setHardware] = useState<string>("Not loaded");
  const [serverState, setServerState] = useState<string>("Not checked");

  const logPanel = useMemo(() => logs.join("\n"), [logs]);
  const selectedModel = models.find((m) => m.model_id === modelId);

  useEffect(() => {
    const unlisten = listen<EngineLog>("engine-log", (ev) => {
      const p = ev.payload;
      const prefix = p.stream === "stderr" ? "[stderr] " : "";
      setLogs((prev) => [...prev, `${prefix}${p.line}`].slice(-2000));
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    refreshAll();
  }, []);

  async function engineGet<T>(path: string): Promise<T> {
    return JSON.parse(await invoke<string>("engine_get", { path })) as T;
  }

  async function enginePost<T>(path: string, body: unknown): Promise<T> {
    return JSON.parse(await invoke<string>("engine_post", { path, body: JSON.stringify(body) })) as T;
  }

  async function refreshAll() {
    setBusy("Loading app state");
    setError("");
    try {
      const [modelRes, envRes, hwRes] = await Promise.all([
        engineGet<ModelsResponse>("/v1/models"),
        engineGet<EnvsResponse>("/v1/envs"),
        engineGet<Record<string, unknown>>("/v1/hardware")
      ]);

      if (!modelRes.ok) throw new Error(modelRes.message || modelRes.error || "Failed to load models");
      if (!envRes.ok) throw new Error(envRes.message || envRes.error || "Failed to load envs");

      const nextModels = modelRes.models || [];
      setModels(nextModels);
      setEnvs(envRes.envs || []);
      setHardware(JSON.stringify(hwRes, null, 2));
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
      if (action === "status") {
        const q = encodeURIComponent(modelId);
        const res = await engineGet<Record<string, unknown>>(`/v1/server/status?model_id=${q}`);
        setServerState(JSON.stringify(res, null, 2));
      } else {
        const res = await enginePost<Record<string, unknown>>(`/v1/server/${action}`, { model_id: modelId });
        setServerState(JSON.stringify(res, null, 2));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ fontFamily: "system-ui", padding: 18, display: "grid", gap: 14, color: "#111" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "start" }}>
        <div>
          <div style={{ fontSize: 24, fontWeight: 800 }}>OwLLM Desktop</div>
          <div style={{ opacity: 0.75, marginTop: 4 }}>
            Rust desktop shell with a supervised Python engine. Select a configured model and manage its server.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button onClick={refreshAll} disabled={!!busy}>Refresh</button>
          <button onClick={() => invoke("engine_start")} disabled={!!busy}>Start engine</button>
          <button onClick={() => invoke("engine_stop")} disabled={!!busy}>Stop engine</button>
        </div>
      </div>

      {error ? (
        <div style={{ border: "1px solid #ff9f9f", background: "#fff3f3", color: "#9b1c1c", borderRadius: 8, padding: 12 }}>
          {error}
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(340px, 440px) 1fr", gap: 14 }}>
        <section style={{ border: "1px solid #ddd", borderRadius: 10, padding: 14, background: "#fff" }}>
          <div style={{ fontWeight: 800, marginBottom: 10 }}>Configured models</div>
          <div style={{ display: "grid", gap: 8, maxHeight: 390, overflow: "auto" }}>
            {models.length === 0 ? <div style={{ opacity: 0.7 }}>No models found in llm_backends.yaml.</div> : null}
            {models.map((m) => (
              <button
                key={m.model_id}
                onClick={() => setModelId(m.model_id)}
                style={{
                  textAlign: "left",
                  border: modelId === m.model_id ? "2px solid #2557d6" : "1px solid #ddd",
                  borderRadius: 8,
                  padding: 10,
                  background: modelId === m.model_id ? "#eef3ff" : "#fafafa",
                  cursor: "pointer"
                }}
              >
                <div style={{ fontWeight: 700 }}>{m.model_id}</div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>port {m.port || "?"}</div>
                <div style={{ fontSize: 12, opacity: 0.72, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {m.base_model || "No base_model"}
                </div>
              </button>
            ))}
          </div>
        </section>

        <section style={{ border: "1px solid #ddd", borderRadius: 10, padding: 14, background: "#fff" }}>
          <div style={{ fontWeight: 800, marginBottom: 10 }}>Server control</div>
          <div style={{ display: "grid", gap: 10 }}>
          <label>
            Model ID{" "}
            <input
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder="from llm_backends.yaml"
              style={{ width: "min(720px, 100%)", padding: 8 }}
            />
          </label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button disabled={!modelId || !!busy} onClick={() => runServerAction("start")}>Start server</button>
              <button disabled={!modelId || !!busy} onClick={() => runServerAction("status")}>Status</button>
              <button disabled={!modelId || !!busy} onClick={() => runServerAction("stop")}>Stop server</button>
              {busy ? <span style={{ opacity: 0.7 }}>busy: {busy}</span> : null}
            </div>
            <div style={{ fontSize: 13, opacity: 0.75 }}>
              Selected base model: {selectedModel?.base_model || "none"}
            </div>
            <pre style={{ height: 210, overflow: "auto", background: "#0b1020", color: "#d7e0ff", padding: 12, borderRadius: 8 }}>
              {serverState}
            </pre>
          </div>
        </section>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Hardware</div>
          <pre
            style={{
              height: 240,
              overflow: "auto",
              background: "#0b1020",
              color: "#d7e0ff",
              padding: 12,
              borderRadius: 8
            }}
          >
            {hardware}
          </pre>
        </div>
        <div>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Python envs ({envs.length}) / engine log</div>
          <pre
            style={{
              height: 240,
              overflow: "auto",
              background: "#111",
              color: "#eee",
              padding: 12,
              borderRadius: 8
            }}
          >
            {envs.map((e) => `${e.env_key}  ${e.python}`).join("\n")}
            {envs.length ? "\n\n--- engine log ---\n" : ""}
            {logPanel || "No engine output yet."}
          </pre>
        </div>
      </div>
    </div>
  );
}
