// HomePage — ported from LLM/desktop_app/main.py::_build_home_tab
// (lines 7484-7994). Layout:
//
//   ┌─ 2x2 grid (28px gap) ───────────────────────────────────────┐
//   │  [0,0] Fine Tuning launcher │ [0,1] Agentic Team launcher  │
//   │       (owl_FineTuning.png)   │ (owl_AgenticTeam.png)         │
//   ├─────────────────────────────────────────────────────────────┤
//   │  [1,0] System Status         │ [1,1] Software Requirements   │
//   │       hardware detection     │ Python / PyTorch / CUDA       │
//   └─────────────────────────────────────────────────────────────┘
//          "Welcome to OWLLM" 240px circle floats over grid centre
//
// Launcher card specs are the literal _LAUNCHER_CARDS tuple at
// main.py:4143-4166 (same accents, owl PNGs, taglines, blurbs).
// System status + requirement rows are static placeholders for
// now — they'll wire to invoke('engine_get', '/v1/hardware') when
// the backend story for that lands.
import React from "react";

const ICONS = "/Page_icons";

type LauncherSpec = {
  key: string;
  title: string;
  iconPng: string;
  tagline: string;
  blurb: string;
  accentTop: string;
  accentBottom: string;
  accentLine: string;
};

// Verbatim from main.py:4143-4166.
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
  },
];

function LauncherCard({ spec }: { spec: LauncherSpec }) {
  // Card sized minimally to fit the 270-px PNG (main.py:4187,4234).
  return (
    <div
      data-ui={`LauncherCard:${spec.key}`}
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
        transition: "background 0.15s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.background =
          `linear-gradient(180deg, ${spec.accentTop}, ${spec.accentTop})`;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.background =
          `linear-gradient(180deg, ${spec.accentTop} 0%, ${spec.accentBottom} 100%)`;
      }}
    >
      <img
        src={`${ICONS}/${spec.iconPng}`}
        style={{ height: 270, width: "auto", flexShrink: 0 }}
        alt={spec.title}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
        <div style={{
          color: spec.accentLine,
          fontSize: 26,
          fontWeight: 700,
        }}>
          {spec.title}
        </div>
        <div style={{
          color: "#9aa0a6",
          fontSize: 12,
          letterSpacing: 0.6,
          textTransform: "uppercase",
        }}>
          {spec.tagline}
        </div>
        <div style={{
          color: "#dadcdf",
          fontSize: 14,
          lineHeight: 1.5,
          marginTop: 4,
        }}>
          {spec.blurb}
        </div>
      </div>
    </div>
  );
}

// _create_status_row equivalent — main.py uses these for both
// System Status (CPU/GPU/RAM) and Software Requirements (Python/
// PyTorch/CUDA). Same visual shape: emoji + name + ok/x dot + value.
type StatusRow = { icon: string; name: string; ok: boolean | "warn"; value: string };

function StatusList({ rows }: { rows: StatusRow[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {rows.map((r, i) => (
        <div key={i} style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 12px",
          background: "rgba(255,255,255,0.03)",
          borderRadius: 8,
          fontSize: 13,
        }}>
          <span style={{ fontSize: 18 }}>{r.icon}</span>
          <span style={{ color: "#dadcdf", fontWeight: 600, flex: 1 }}>{r.name}</span>
          <span style={{ color: "#9aa0a6", fontSize: 12 }}>{r.value}</span>
          <span style={{
            display: "inline-block",
            width: 10, height: 10,
            borderRadius: 5,
            background: r.ok === true ? "#22c55e"
                      : r.ok === "warn" ? "#fbbf24"
                      : "#ef4444",
            boxShadow: `0 0 6px ${
              r.ok === true ? "#22c55e"
              : r.ok === "warn" ? "#fbbf24"
              : "#ef4444"
            }`,
          }} />
        </div>
      ))}
    </div>
  );
}

function PanelHeader({ icon, label, action }: {
  icon: string; label: string; action?: React.ReactNode;
}) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      marginBottom: 14,
    }}>
      <div style={{
        flex: 1,
        fontSize: 22,
        fontWeight: 700,
        color: "#e6e8eb",
      }}>
        {icon} {label}
      </div>
      {action}
    </div>
  );
}

function GridPanel({ children, accent }: {
  children: React.ReactNode; accent: string;
}) {
  return (
    <div style={{
      background: "linear-gradient(180deg, rgba(60,60,80,0.4), rgba(40,40,60,0.4))",
      border: `1px solid ${accent}`,
      borderRadius: 12,
      padding: 18,
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
    }}>
      {children}
    </div>
  );
}

function WelcomeCircle() {
  const D = 240;  // circle_d in main.py:7969
  return (
    <div style={{
      position: "absolute",
      left: "50%",
      top: "50%",
      transform: "translate(-50%, -50%)",
      width: D,
      height: D,
      borderRadius: D / 2,
      border: "3px solid #7fdfff",
      background: "radial-gradient(circle at 50% 50%, rgba(74,108,255,0.95) 0%, rgba(28,38,72,0.96) 70%, rgba(10,14,28,0.98) 100%)",
      color: "#fff",
      fontSize: 30,
      fontWeight: 700,
      letterSpacing: 1,
      textAlign: "center",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      whiteSpace: "pre-line",
      pointerEvents: "none",
      zIndex: 2,
    }}>
      {"Welcome\nto\nOWLLM"}
    </div>
  );
}

export default function HomePage() {
  // Static placeholders — will wire to engine_get('/v1/hardware') in
  // a follow-up. The structure matches the Qt page so the visual
  // port is faithful even before the data is live.
  const systemStatus: StatusRow[] = [
    { icon: "💻", name: "CPU",  ok: true,   value: "AMD Ryzen 9 · 16 cores" },
    { icon: "🎮", name: "GPU",  ok: true,   value: "NVIDIA RTX 4090 · 24 GB" },
    { icon: "🧠", name: "RAM",  ok: true,   value: "64 GB / 128 GB" },
    { icon: "💾", name: "Disk", ok: "warn", value: "412 GB free" },
  ];
  const requirements: StatusRow[] = [
    { icon: "🐍", name: "Python 3.8+",   ok: true,  value: "3.12.7" },
    { icon: "🔥", name: "PyTorch (CUDA)", ok: true,  value: "2.5.1+cu121" },
    { icon: "⚡", name: "CUDA drivers",   ok: true,  value: "12.6" },
    { icon: "📦", name: "llama.cpp",     ok: true,  value: "bundled" },
  ];
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
              <button className="ghost-btn" style={{ height: 32 }}>
                🔄 Refresh Hardware Detection
              </button>
            }
          />
          <StatusList rows={systemStatus} />
        </GridPanel>

        <GridPanel accent="rgba(127,223,255,0.30)">
          <PanelHeader icon="⚙️" label="Software Requirements & Setup" />
          <StatusList rows={requirements} />
          <div style={{ flex: 1 }} />
          <button
            data-ui="FixIssuesBtn"
            style={{
              marginTop: 12,
              height: 38,
              padding: "0 18px",
              borderRadius: 10,
              border: "none",
              background: "linear-gradient(180deg, #4a6cff, #3a55cc)",
              color: "#fff",
              fontSize: 14,
              fontWeight: 700,
              alignSelf: "flex-start",
              cursor: "pointer",
            }}
          >
            🛠 Fix Issues
          </button>
        </GridPanel>

        <WelcomeCircle />
      </div>
    </div>
  );
}
