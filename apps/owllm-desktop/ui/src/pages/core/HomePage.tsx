// HomePage — ported from LLM/desktop_app/main.py::_build_home_tab.
// Layout: 2×2 grid (launchers on top, status panels on bottom) with a
// "Welcome to OWLLM" circle floating over the centre.
//
// Each launcher card dispatches the `owllm:navigate` CustomEvent that
// AppShell listens for, so clicking "Fine Tuning" jumps to Models and
// "Agentic Team" jumps to Agents (the firstTab of each mode).
//
// System Status reads live data from the native `hardware_info` and
// `vram_status` commands — vram_status is preferred for accuracy
// since wmic AdapterRAM caps at 4 GB on Win10 (the 32-bit limit).
// Software Requirements rows are placeholders until each gets its
// own probe.
import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

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
type VramStatus = { gpus: VramGpu[]; message: string };

const ICONS = "/Page_icons";

function navTo(key: string) {
  window.dispatchEvent(new CustomEvent("owllm:navigate", { detail: { key } }));
}

type LauncherSpec = {
  key: string;
  title: string;
  iconPng: string;
  tagline: string;
  blurb: string;
  accentTop: string;
  accentBottom: string;
  accentLine: string;
  /// AppShell page key this launcher jumps to.
  navKey: string;
};

const LAUNCHERS: LauncherSpec[] = [
  {
    key: "finetuning",
    title: "Fine Tuning",
    iconPng: "owl_FineTuning.png",
    tagline: "Models · Train · Test",
    blurb: "Download base models, fine-tune adapters, and test prompts.",
    accentTop: "#23304a",
    accentBottom: "#161c2c",
    accentLine: "#7989ff",
    navKey: "models",
  },
  {
    key: "agentic",
    title: "Agentic Team",
    iconPng: "owl_AgenticTeam.png",
    tagline: "Agents · Studio · Code · Characters",
    blurb: "Design agents, give them models and tools, and run multi-agent projects.",
    accentTop: "#1f3a3a",
    accentBottom: "#16252a",
    accentLine: "#56d3c8",
    navKey: "agents",
  },
];

function LauncherCard({ spec }: { spec: LauncherSpec }) {
  return (
    <div
      data-ui={`LauncherCard:${spec.key}`}
      onClick={() => navTo(spec.navKey)}
      style={{
        background: `linear-gradient(180deg, ${spec.accentTop} 0%, ${spec.accentBottom} 100%)`,
        borderLeft: `6px solid ${spec.accentLine}`,
        borderRadius: 18,
        padding: "26px 34px",
        minHeight: 290,
        display: "flex",
        alignItems: "center",
        gap: 26,
        cursor: "pointer",
        transition: "transform 0.12s, box-shadow 0.12s",
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        el.style.transform = "translateY(-2px)";
        el.style.boxShadow = `0 10px 26px rgba(0,0,0,0.45), 0 0 0 1px ${spec.accentLine}55`;
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        el.style.transform = "translateY(0)";
        el.style.boxShadow = "none";
      }}
    >
      <img
        src={`${ICONS}/${spec.iconPng}`}
        style={{ height: 270, width: "auto", flexShrink: 0 }}
        alt={spec.title}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
        <div style={{ color: spec.accentLine, fontSize: 26, fontWeight: 700 }}>{spec.title}</div>
        <div style={{ color: "#9aa0a6", fontSize: 12, letterSpacing: 0.6, textTransform: "uppercase" }}>{spec.tagline}</div>
        <div style={{ color: "#dadcdf", fontSize: 14, lineHeight: 1.5, marginTop: 4 }}>{spec.blurb}</div>
        <div style={{ marginTop: "auto" }}>
          <span style={{ color: spec.accentLine, fontSize: 12, fontWeight: 700, letterSpacing: 1 }}>
            OPEN  →
          </span>
        </div>
      </div>
    </div>
  );
}

function PanelHeader({ icon, label, action }: {
  icon: string; label: string; action?: React.ReactNode;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", marginBottom: 14, gap: 12,
    }}>
      <div style={{
        flex: 1, fontSize: 22, fontWeight: 700, color: "#e6e8eb",
      }}>{icon} {label}</div>
      {action}
    </div>
  );
}

function GridPanel({ children, accent }: { children: React.ReactNode; accent: string }) {
  return (
    <div style={{
      background: "linear-gradient(180deg, rgba(60,60,80,0.4), rgba(40,40,60,0.4))",
      border: `1px solid ${accent}`,
      borderRadius: 12,
      padding: 18,
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
    }}>{children}</div>
  );
}

function WelcomeCircle() {
  const D = 240;
  return (
    <div style={{
      position: "absolute",
      left: "50%", top: "50%",
      transform: "translate(-50%, -50%)",
      width: D, height: D, borderRadius: D / 2,
      border: "3px solid #7fdfff",
      background: "radial-gradient(circle at 50% 50%, rgba(74,108,255,0.95) 0%, rgba(28,38,72,0.96) 70%, rgba(10,14,28,0.98) 100%)",
      color: "#fff",
      fontSize: 30, fontWeight: 700, letterSpacing: 1, textAlign: "center",
      display: "flex", alignItems: "center", justifyContent: "center",
      whiteSpace: "pre-line", pointerEvents: "none", zIndex: 2,
    }}>{"Welcome\nto\nOWLLM"}</div>
  );
}

// ----- System Status -----

// One row per detected GPU. Name on the left, VRAM total on the right
// inside a chip. Uses live nvidia-smi totals when available (so a 24 GB
// 4090 doesn't show up as 4 GB — wmic AdapterRAM caps at 4 GB on Win10).
function GpuStatRow({
  index, name, vramTotalGb, vramUsedGb,
}: {
  index: number; name: string; vramTotalGb: number | null; vramUsedGb: number | null;
}) {
  const accent = "#7fdfff";
  const vramLabel =
    vramTotalGb != null
      ? vramUsedGb != null
        ? `${vramUsedGb.toFixed(1)} / ${vramTotalGb.toFixed(1)} GiB`
        : `${vramTotalGb.toFixed(1)} GiB`
      : "VRAM N/A";
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "auto 1fr auto",
      alignItems: "center",
      gap: 12,
      background: "rgba(127,223,255,0.06)",
      border: "1px solid rgba(127,223,255,0.14)",
      borderRadius: 10,
      padding: "10px 14px",
    }}>
      <span style={{
        background: "rgba(127,223,255,0.18)",
        color: accent,
        borderRadius: 6,
        padding: "2px 8px",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.6,
      }}>GPU {index}</span>
      <span style={{
        color: "#dadcdf",
        fontSize: 13,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        minWidth: 0,
      }}>{name}</span>
      <span style={{
        background: "rgba(60,60,80,0.55)",
        color: "#fff",
        borderRadius: 8,
        padding: "4px 10px",
        fontSize: 12,
        fontWeight: 700,
        fontFamily: "Consolas, monospace",
        whiteSpace: "nowrap",
      }}>💾 {vramLabel}</span>
    </div>
  );
}

function CpuStatRow({ cpu, cores, ramGb }: { cpu: string; cores: number; ramGb: number }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "auto 1fr auto",
      alignItems: "center",
      gap: 12,
      background: "rgba(120,140,200,0.06)",
      border: "1px solid rgba(120,140,200,0.14)",
      borderRadius: 10,
      padding: "10px 14px",
    }}>
      <span style={{
        background: "rgba(120,140,200,0.18)",
        color: "#a8b8ff",
        borderRadius: 6,
        padding: "2px 8px",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.6,
      }}>CPU</span>
      <span style={{
        color: "#dadcdf",
        fontSize: 13,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        minWidth: 0,
      }}>{cpu}</span>
      <span style={{
        display: "flex",
        gap: 6,
        whiteSpace: "nowrap",
      }}>
        <span style={{
          background: "rgba(60,60,80,0.55)",
          color: "#fff",
          borderRadius: 8,
          padding: "4px 10px",
          fontSize: 12,
          fontWeight: 700,
          fontFamily: "Consolas, monospace",
        }}>{cores} cores</span>
        {ramGb > 0 && (
          <span style={{
            background: "rgba(60,60,80,0.55)",
            color: "#fff",
            borderRadius: 8,
            padding: "4px 10px",
            fontSize: 12,
            fontWeight: 700,
            fontFamily: "Consolas, monospace",
          }}>💾 {ramGb} GiB</span>
        )}
      </span>
    </div>
  );
}

// ----- Software Requirements -----

type SoftRow = {
  emoji: string;
  name: string;
  ok: boolean | "warn";
  detail: string;
};

function statusBadge(ok: boolean | "warn") {
  if (ok === true) return { fg: "#22c55e", bg: "rgba(34,197,94,0.14)", border: "rgba(34,197,94,0.35)", glyph: "✅" };
  if (ok === "warn") return { fg: "#FF9800", bg: "rgba(255,152,0,0.12)", border: "rgba(255,152,0,0.35)", glyph: "⚠️" };
  return { fg: "#ef4444", bg: "rgba(239,68,68,0.14)", border: "rgba(239,68,68,0.35)", glyph: "❌" };
}

function SoftRowView({ row }: { row: SoftRow }) {
  const b = statusBadge(row.ok);
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "auto 1fr auto",
      alignItems: "center",
      gap: 12,
      background: "rgba(255,255,255,0.025)",
      border: `1px solid ${b.border}`,
      borderRadius: 10,
      padding: "10px 14px",
    }}>
      <span style={{ fontSize: 18 }}>{row.emoji}</span>
      <span style={{
        color: "#e6e8eb",
        fontSize: 14,
        fontWeight: 600,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        minWidth: 0,
      }}>{row.name}</span>
      <span style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        whiteSpace: "nowrap",
      }}>
        <span style={{
          background: b.bg,
          color: b.fg,
          border: `1px solid ${b.border}`,
          borderRadius: 999,
          padding: "2px 10px",
          fontSize: 11,
          fontWeight: 700,
          fontFamily: "Consolas, monospace",
        }}>{b.glyph} {row.detail}</span>
      </span>
    </div>
  );
}

// ----- Main -----

export default function HomePage() {
  const [hw, setHw] = useState<HardwareInfo | null>(null);
  const [vram, setVram] = useState<VramStatus>({ gpus: [], message: "" });

  const refreshHw = () => {
    invoke<HardwareInfo>("hardware_info").then(setHw).catch(() => setHw(null));
    invoke<VramStatus>("vram_status")
      .then(setVram)
      .catch(() => setVram({ gpus: [], message: "" }));
  };
  useEffect(() => { refreshHw(); }, []);

  // Merge wmic-detected GPUs with the nvidia-smi totals so each card
  // shows accurate VRAM (wmic caps at 4 GB on Win10).
  const vramByIndex = new Map(vram.gpus.map(g => [g.index, g]));
  const gpus = (hw?.gpus ?? []).map(g => {
    const live = vramByIndex.get(g.index);
    return {
      index: g.index,
      name: g.name,
      // Prefer live nvidia-smi total when available; fall back to wmic.
      totalGb: live ? live.total_mib / 1024 : g.vram_gb,
      usedGb: live ? live.used_mib / 1024 : null,
    };
  });
  const gpuOk = gpus.length > 0;

  const cpuName = hw?.cpu_name || "—";
  const cpuCores = hw?.cpu_cores || hw?.cpu_threads || 0;
  const ramGb = hw ? Math.round(hw.ram_total_gb) : 0;

  // Software requirements (placeholders until each gets a real probe).
  const softRows: SoftRow[] = [
    { emoji: "🐍", name: "Python 3.8+",    ok: true, detail: "Version 3.11.13" },
    { emoji: "🔥", name: "PyTorch (CUDA)", ok: true, detail: "2.5.1+cu121" },
    { emoji: "🎮", name: "CUDA Drivers",   ok: true, detail: "Version 12.6" },
    { emoji: "📦", name: "Dependencies",   ok: true, detail: "Core packages found" },
  ];
  const showFixBtn = softRows.some(r => r.ok !== true);

  return (
    <div style={{ padding: "30px 40px", height: "100%", overflow: "auto" }}>
      <div
        data-ui="HomeGrid"
        style={{
          position: "relative",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gridTemplateRows: "auto 1fr",
          gap: 28,
          minHeight: 720,
        }}
      >
        <LauncherCard spec={LAUNCHERS[0]} />
        <LauncherCard spec={LAUNCHERS[1]} />

        <GridPanel accent="rgba(127,223,255,0.30)">
          <PanelHeader
            icon="📊"
            label="System Status"
            action={
              <button
                data-ui="RefreshGpuBtn"
                onClick={refreshHw}
                style={{
                  background: "linear-gradient(180deg, rgba(60,60,80,0.4), rgba(40,40,60,0.4))",
                  border: "1px solid rgba(127,223,255,0.30)",
                  borderRadius: 10,
                  padding: "6px 12px",
                  color: "#fff",
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >🔄 Refresh</button>
            }
          />

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{
              color: gpuOk ? "#22c55e" : "#FF9800",
              fontWeight: 700,
              fontSize: 13,
              letterSpacing: 0.4,
              textTransform: "uppercase",
            }}>
              {gpuOk ? `✅ ${gpus.length} GPU${gpus.length > 1 ? "s" : ""} detected` : "⚠️ No GPUs detected — training will use CPU (slower)"}
            </div>
            {gpus.map(g => (
              <GpuStatRow
                key={g.index}
                index={g.index}
                name={g.name}
                vramTotalGb={g.totalGb}
                vramUsedGb={g.usedGb}
              />
            ))}
            <CpuStatRow cpu={cpuName} cores={cpuCores} ramGb={ramGb} />
            <div style={{
              marginTop: 6,
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 12px",
              borderRadius: 10,
              background: "rgba(34,197,94,0.10)",
              border: "1px solid rgba(34,197,94,0.30)",
            }}>
              <span style={{
                display: "inline-block",
                width: 10, height: 10, borderRadius: "50%",
                background: "#22c55e",
                boxShadow: "0 0 8px rgba(34,197,94,0.7)",
              }} />
              <span style={{ color: "#dadcdf", fontWeight: 600, fontSize: 13 }}>Status</span>
              <span style={{ flex: 1 }} />
              <span style={{ color: "#22c55e", fontWeight: 800, fontSize: 14, letterSpacing: 0.5 }}>READY</span>
            </div>
          </div>
        </GridPanel>

        <GridPanel accent="rgba(127,223,255,0.30)">
          <PanelHeader icon="⚙️" label="Software Requirements & Setup" />
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {softRows.map((r, i) => <SoftRowView key={i} row={r} />)}
          </div>
          <div style={{ flex: 1 }} />
          {showFixBtn && (
            <button
              data-ui="FixIssuesBtn"
              style={{
                marginTop: 12,
                minHeight: 42,
                padding: "10px 18px",
                borderRadius: 12,
                border: "2px solid #f093fb",
                background: "linear-gradient(180deg, rgba(240,147,251,0.6), rgba(245,87,108,0.6))",
                color: "#fff",
                fontSize: 16,
                fontWeight: 700,
                alignSelf: "flex-start",
                cursor: "pointer",
              }}
            >🛠️ Fix Issues (Recommended)</button>
          )}
        </GridPanel>

        <WelcomeCircle />
      </div>
    </div>
  );
}
