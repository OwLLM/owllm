// InfoPage — the app's "everything I actually know about this machine" view.
// Every number comes from a native Rust command so this page never lies:
//   hardware_info · vram_status · app_readiness · server_status · list_models ·
//   paths_debug · llama_server_path · sandbox_disk_usage (via SandboxDiskCard).
//
// Qt: main.py::_build_info_tab (line 27273) was a tall list of dependency
// versions from SystemDetector. The Rust runtime doesn't carry that catalog;
// we show what we genuinely measure: build, environment readiness, hardware,
// live GPU memory, the model server, the model library, and sandbox disk.

import { useEffect, useReducer, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { Card, Row } from "./infoCards";
import SandboxDiskCard from "./SandboxDiskCard";
import { CacheTab } from "../finetuning/ModelsPage";
import {
  fetchReadiness,
  getCachedReadiness,
  isReadinessLoading,
  subscribeReadiness,
  type ReadinessRow,
} from "./readinessStore";

const ICONS = "/Page_icons";

type GpuInfo = { index: number; name: string; vram_gb: number };
type HardwareInfo = {
  cpu_name: string;
  cpu_cores: number;
  cpu_threads: number;
  ram_total_gb: number;
  ram_used_gb: number;
  gpus: GpuInfo[];
};
type VramGpu = { index: number; used_mib: number; total_mib: number };
type VramStatus = { gpus: VramGpu[] };
type ModelInfo = {
  model_id: string;
  port?: number | null;
  base_model?: string | null;
  size_mib?: number | null;
  provider?: string;
};
type PathsDebug = {
  models_dirs_read?: string[];
  runtime_root?: string | null;
};
type ServerStatus = {
  running: boolean;
  model_id: string | null;
  port: number | null;
  message: string;
};

// One readiness signal as a glyph + detail. warn (⚠️ orange) = optional/degraded;
// ok (✅ green) = ready; neither (❌ red) = missing + needed.
function ReadyLine({ label, row }: { label: string; row?: ReadinessRow }) {
  const glyph = !row ? "…" : row.warn ? "⚠️" : row.ok ? "✅" : "❌";
  const color = !row ? "var(--fg-muted)" : row.warn ? "#FF9800" : row.ok ? "#22c55e" : "#ef4444";
  return (
    <Row
      label={label}
      value={
        <span>
          <span style={{ color, fontWeight: 700 }}>{glyph}</span>{"  "}
          <span style={{ color: "var(--fg)" }}>{row?.detail ?? "Checking…"}</span>
        </span>
      }
    />
  );
}

export default function InfoPage() {
  const [hw, setHw] = useState<HardwareInfo | null>(null);
  const [vram, setVram] = useState<VramStatus>({ gpus: [] });
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [version, setVersion] = useState<string>("…");
  const [paths, setPaths] = useState<PathsDebug | null>(null);
  const [llamaPath, setLlamaPath] = useState<string | null>(null);
  const [server, setServer] = useState<ServerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cacheMsg, setCacheMsg] = useState<string | null>(null);

  // Environment readiness shares the session cache with Home (readinessStore),
  // so opening Info doesn't re-shell wsl.exe/nvidia-smi unless you press Refresh.
  const [, forceReady] = useReducer((x: number) => x + 1, 0);
  useEffect(() => subscribeReadiness(forceReady), []);
  const ready = getCachedReadiness();
  const readyLoading = isReadinessLoading();

  async function refresh() {
    setError(null);
    fetchReadiness(true);
    try {
      const [h, v, m, ver, pd, lp, srv] = await Promise.all([
        invoke<HardwareInfo>("hardware_info"),
        invoke<VramStatus>("vram_status"),
        invoke<ModelInfo[]>("list_models"),
        getVersion().catch(() => "unknown"),
        invoke<PathsDebug>("paths_debug").catch(() => null),
        invoke<string | null>("llama_server_path").catch(() => null),
        invoke<ServerStatus>("server_status").catch(() => null),
      ]);
      setHw(h);
      setVram(v);
      setModels(m);
      setVersion(ver);
      setPaths(pd);
      setLlamaPath(lp);
      setServer(srv);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    refresh();
    fetchReadiness(false);
    const id = window.setInterval(async () => {
      try {
        const [v, srv] = await Promise.all([
          invoke<VramStatus>("vram_status"),
          invoke<ServerStatus>("server_status").catch(() => null),
        ]);
        setVram(v);
        if (srv) setServer(srv);
      } catch { /* ignore */ }
    }, 3000);
    return () => window.clearInterval(id);
  }, []);

  const localModels = models.filter(m => m.provider === "local" || m.provider === "tuned");
  const cloudModels = models.filter(m => m.provider && m.provider !== "local" && m.provider !== "tuned");
  const totalGgufGiB = localModels.reduce(
    (acc, m) => acc + (m.size_mib ?? 0) / 1024,
    0,
  );
  const modelsRoot = paths?.models_dirs_read?.[0] ?? "(not detected — first-run install pending)";
  const llamaRuntime = llamaPath ?? "(module 'local-inference' not installed yet)";

  return (
    <div style={{
      padding: "20px 28px",
      height: "100%",
      overflowY: "auto",
      display: "flex",
      flexDirection: "column",
      gap: 14,
      background: "var(--bg-panel)",
      color: "var(--fg)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <img src={`${ICONS}/owl_startup.png`} alt="" style={{ width: 32, height: 32, objectFit: "contain" }} />
        <div style={{ fontSize: 24, fontWeight: 800, color: "var(--fg-strong)" }}>ℹ️ Info</div>
        <div style={{ flex: 1 }} />
        <button className="ghost-btn" onClick={refresh} disabled={readyLoading}>
          {readyLoading ? "⏳ Checking…" : "🔄 Refresh"}
        </button>
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
        columnCount: 2,
        columnGap: 14,
      }}>
        {/* Multi-column layout: cards flow DOWN each column at their natural
            heights (not strict left-to-right rows), so wildly different card
            sizes pack cleanly instead of being locked into an equal-height grid.
            Cache + Sandbox disk are the two disk-reclaim panels — they read
            adjacent down the first column rather than side-by-side on a row.
            Each card is wrapped break-safe so it is never split across columns. */}
        <div style={{ breakInside: "avoid", marginBottom: 14 }}>
        <Card title="💽 Cache">
          {cacheMsg && (
            <div style={{
              fontSize: 11, color: "var(--fg)", marginBottom: 8, padding: "6px 8px",
              borderRadius: 6, background: "rgba(var(--accent-rgb),0.10)",
              border: "1px solid rgba(var(--accent-rgb),0.3)", wordBreak: "break-word",
            }}>{cacheMsg}</div>
          )}
          <CacheTab setBanner={setCacheMsg} />
        </Card>
        </div>

        <div style={{ breakInside: "avoid", marginBottom: 14 }}>
        <SandboxDiskCard />
        </div>

        <div style={{ breakInside: "avoid", marginBottom: 14 }}>
        <Card title="📦 Application">
          <Row label="Product" value="OwLLM Desktop" />
          <Row label="Version" value={version} />
          <Row label="Runtime" value="Tauri 2 · Rust + React" />
          <Row label="Update channel" value="GitHub Releases (auto-update)" />
          <Row label="Python" value="Invited on-demand only (fine-tuning)" />
        </Card>
        </div>

        <div style={{ breakInside: "avoid", marginBottom: 14 }}>
        <Card title="✅ Environment readiness">
          <ReadyLine label="WSL / Ubuntu"      row={ready?.wsl} />
          <ReadyLine label="GPU & CUDA driver" row={ready?.gpu} />
          <ReadyLine label="Fine-tuning env"   row={ready?.env} />
          <ReadyLine label="Local LLM runtime" row={ready?.runtime} />
        </Card>
        </div>

        <div style={{ breakInside: "avoid", marginBottom: 14 }}>
        <Card title="🖥 Hardware">
          {hw ? (
            <>
              <Row label="CPU" value={hw.cpu_name || "(unknown)"} />
              <Row label="Cores / Threads" value={`${hw.cpu_cores} / ${hw.cpu_threads}`} />
              <Row label="RAM" value={`${hw.ram_used_gb.toFixed(1)} / ${hw.ram_total_gb.toFixed(1)} GiB`} />
              <Row label="GPUs" value={hw.gpus.length === 0 ? "(none detected)" : `${hw.gpus.length}`} />
            </>
          ) : (
            <div style={{ fontSize: 12, color: "#7a7f87" }}>Probing…</div>
          )}
        </Card>
        </div>

        <div style={{ breakInside: "avoid", marginBottom: 14 }}>
        <Card title="🎮 GPU detail">
          {hw && hw.gpus.length > 0 ? (
            hw.gpus.map(g => {
              const live = vram.gpus.find(v => v.index === g.index);
              return (
                <Row
                  key={g.index}
                  label={`GPU${g.index}`}
                  value={
                    <span>
                      {g.name}
                      {live ? (
                        <span style={{ color: "#a0e88a" }}>
                          {"  "}·  {(live.used_mib / 1024).toFixed(1)} / {(live.total_mib / 1024).toFixed(1)} GiB live
                        </span>
                      ) : (
                        <span style={{ color: "#7a7f87" }}>{"  "}·  {g.vram_gb.toFixed(1)} GiB</span>
                      )}
                    </span>
                  }
                />
              );
            })
          ) : (
            <div style={{ fontSize: 12, color: "#7a7f87" }}>No GPUs visible — nvidia-smi unreachable.</div>
          )}
        </Card>
        </div>

        <div style={{ breakInside: "avoid", marginBottom: 14 }}>
        <Card title="🦙 Model server">
          <Row
            label="State"
            value={
              <span style={{ color: server?.running ? "#22c55e" : "var(--fg-muted)", fontWeight: 700 }}>
                {server ? (server.running ? "🟢 Running" : "⚪ Stopped") : "…"}
              </span>
            }
          />
          <Row label="Model" value={server?.model_id ?? "—"} />
          <Row label="Port" value={server?.port ? String(server.port) : "—"} />
          <Row label="Detail" value={server?.message ?? "…"} />
        </Card>
        </div>

        <div style={{ breakInside: "avoid", marginBottom: 14 }}>
        <Card title="📁 Models">
          <Row label="Local GGUFs" value={`${localModels.length}`} />
          <Row label="Cloud peers" value={`${cloudModels.length}`} />
          <Row label="Total on disk" value={`${totalGgufGiB.toFixed(1)} GiB`} />
          <Row
            label="Root"
            value={<code style={{ color: "var(--accent)", fontSize: 11, wordBreak: "break-all" }}>{modelsRoot}</code>}
          />
          <Row
            label="Runtime"
            value={<code style={{ color: "var(--accent)", fontSize: 11, wordBreak: "break-all" }}>{llamaRuntime}</code>}
          />
        </Card>
        </div>

        <div style={{ breakInside: "avoid", marginBottom: 14 }}>
        <Card title="📜 About OwLLM">
          <div style={{ fontSize: 12, color: "var(--fg)", lineHeight: 1.6 }}>
            Native Rust supervises every subprocess with <code>CREATE_NO_WINDOW</code> — no
            console popups. React talks to Rust via Tauri commands; there is no
            embedded Python HTTP server. Python is invoked one-shot only for the
            fine-tuning workflow and per-model virtualenv bootstrap.
          </div>
          <div style={{ fontSize: 12, color: "var(--fg)", lineHeight: 1.6, marginTop: 10 }}>
            <strong style={{ color: "var(--accent)" }}>Server</strong> — start / stop a model.<br />
            <strong style={{ color: "var(--accent)" }}>Models</strong> (under Fine Tuning) — browse discovered GGUFs.<br />
            <strong style={{ color: "var(--accent)" }}>Chat</strong> (under Fine Tuning) — talk to the running model.<br />
            <strong style={{ color: "var(--accent)" }}>Advanced ⚙</strong> — MCP, Environment, Accounts, Logs.
          </div>
        </Card>
        </div>
      </div>
    </div>
  );
}
