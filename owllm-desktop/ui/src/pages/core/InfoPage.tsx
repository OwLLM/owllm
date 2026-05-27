// InfoPage — app/build summary plus a live hardware probe. Pulls
// everything from native commands so this view never lies.
//
// Qt: main.py::_build_info_tab (line 27273) was a tall list of
// dependency versions sourced from SystemDetector. The Rust runtime
// doesn't carry that catalog; we show the things we actually know:
// hardware, GPU memory, llama-server path, model count.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

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
type ModelInfo = { model_id: string; port?: number | null; base_model?: string | null; size_mib?: number | null };

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "180px 1fr",
      gap: 12,
      padding: "6px 0",
      borderBottom: "1px solid var(--border)",
      fontSize: 12,
    }}>
      <div style={{ color: "var(--fg-muted)" }}>{label}</div>
      <div style={{ color: "var(--fg)", fontFamily: "Consolas, monospace", fontSize: 12 }}>{value}</div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: "linear-gradient(180deg, rgba(60,60,80,0.4), rgba(40,40,60,0.4))",
      border: "1px solid rgba(var(--accent-rgb),0.20)",
      borderRadius: 10,
      padding: "14px 18px",
      display: "flex",
      flexDirection: "column",
      gap: 4,
    }}>
      <div style={{
        fontSize: 14, fontWeight: 700, color: "var(--fg)",
        borderBottom: "1px solid rgba(var(--accent-rgb),0.10)",
        paddingBottom: 6, marginBottom: 6,
      }}>{title}</div>
      {children}
    </div>
  );
}

export default function InfoPage() {
  const [hw, setHw] = useState<HardwareInfo | null>(null);
  const [vram, setVram] = useState<VramStatus>({ gpus: [] });
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    try {
      const [h, v, m] = await Promise.all([
        invoke<HardwareInfo>("hardware_info"),
        invoke<VramStatus>("vram_status"),
        invoke<ModelInfo[]>("list_models"),
      ]);
      setHw(h);
      setVram(v);
      setModels(m);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    refresh();
    const id = window.setInterval(async () => {
      try {
        const v = await invoke<VramStatus>("vram_status");
        setVram(v);
      } catch { /* ignore */ }
    }, 3000);
    return () => window.clearInterval(id);
  }, []);

  const totalGgufGiB = models.reduce(
    (acc, m) => acc + (m.size_mib ?? 0) / 1024,
    0,
  );

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
        <button className="ghost-btn" onClick={refresh}>🔄 Refresh</button>
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
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 14,
      }}>
        <Card title="📦 Application">
          <Row label="Product" value="OwLLM Desktop" />
          <Row label="Version" value="0.1.0" />
          <Row label="Runtime" value="Tauri 2 · Rust + React" />
          <Row label="Python" value="Invited on-demand only (fine-tuning)" />
        </Card>

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

        <Card title="📁 Models">
          <Row label="Discovered GGUFs" value={`${models.length}`} />
          <Row label="Total on disk" value={`${totalGgufGiB.toFixed(1)} GiB`} />
          <Row
            label="Root"
            value={<code style={{ color: "var(--accent)" }}>LLM/models/</code>}
          />
          <Row
            label="Runtime"
            value={<code style={{ color: "var(--accent)" }}>LLM/runtime/llama.cpp/llama-server.exe</code>}
          />
        </Card>

        <Card title="📜 What this app does">
          <div style={{ fontSize: 12, color: "var(--fg)", lineHeight: 1.6 }}>
            Native Rust supervises every subprocess with <code>CREATE_NO_WINDOW</code> — no
            console popups. React talks to Rust via Tauri commands; there is
            no embedded Python HTTP server. Python is invoked one-shot only
            for the fine-tuning workflow and for per-model virtualenv bootstrap.
          </div>
        </Card>

        <Card title="🔗 Where to go next">
          <div style={{ fontSize: 12, color: "var(--fg)", lineHeight: 1.6 }}>
            <strong style={{ color: "var(--accent)" }}>Server</strong> — start / stop a model.<br />
            <strong style={{ color: "var(--accent)" }}>Models</strong> (under Fine Tuning) — browse discovered GGUFs.<br />
            <strong style={{ color: "var(--accent)" }}>Chat</strong> (under Fine Tuning) — talk to the running model.<br />
            <strong style={{ color: "var(--accent)" }}>Advanced ⚙</strong> — MCP, Environment, Accounts, Logs.
          </div>
        </Card>
      </div>
    </div>
  );
}
