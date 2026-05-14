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
// System status reads from the native Rust `hardware_info` command
// (src-tauri/src/hardware.rs) — no Python, no console popups.
// Software requirements remain placeholders until they have their
// own native probes (Python interpreter / PyTorch / CUDA / deps).
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
          color: "var(--fg-muted)",
          fontSize: 12,
          letterSpacing: 0.6,
          textTransform: "uppercase",
        }}>
          {spec.tagline}
        </div>
        <div style={{
          color: "var(--fg)",
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

// _create_status_row equivalent — main.py:4845-4867. Visual shape:
//   "<emoji> <bold label>"  ......(stretch)......  "<detail>"
// Label color = green when ok, red when not (Qt _get_status_color);
// detail color = #888 in dark mode (main.py:4862).
type StatusRow = {
  // Leading emoji from Qt (e.g. 🐍, 🔥, 🎮, 📦). Empty string means
  // the label itself already starts with one (e.g. GPU rows).
  icon: string;
  // The full label text after the emoji prefix.
  name: string;
  // true = ✅ green; false = ❌ red; "warn" = orange (Qt fallback path
  // in the "No GPUs detected" branch uses #FF9800 — main.py:7697).
  ok: boolean | "warn";
  // Right-aligned detail string (e.g. "Version 3.12.7").
  value: string;
};

function statusColor(ok: boolean | "warn"): string {
  // Qt _get_status_color(True/False) returns theme green/red; "warn"
  // mirrors the No-GPU fallback at main.py:7697 (#FF9800).
  if (ok === true) return "#22c55e";
  if (ok === "warn") return "#FF9800";
  return "#ef4444";
}

function StatusList({ rows }: { rows: StatusRow[] }) {
  // No row backgrounds in Qt — sys_frame is "background: transparent"
  // (main.py:7606). Spacing 6-8 px (main.py:7608, 7779).
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {rows.map((r, i) => {
        const okStr = r.ok === true ? "✅" : r.ok === "warn" ? "⚠️" : "❌";
        return (
          <div key={i} style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 14,
          }}>
            <span style={{
              color: statusColor(r.ok),
              fontWeight: 700,
            }}>
              {okStr} {r.icon ? `${r.icon} ` : ""}{r.name}
            </span>
            <span style={{ flex: 1 }} />
            <span style={{ color: "var(--fg-subtle)", fontSize: 12 }}>{r.value}</span>
          </div>
        );
      })}
    </div>
  );
}

// Per-GPU detail row used inside the System Status panel — mirrors
// main.py:7641-7693 (GPU N: <name>  ........  💾 <memory>).
function GpuRow({ index, name, memory }: { index: number; name: string; memory: string }) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      fontSize: 13,
      paddingLeft: 22, // align under the ✅ in the parent header
    }}>
      <span style={{ color: "var(--fg)" }}>
        <b>GPU {index}:</b> {name}
      </span>
      <span style={{ flex: 1 }} />
      <span style={{ color: "var(--fg)" }}>
        💾 <b>{memory}</b>
      </span>
    </div>
  );
}

function PanelHeader({ icon, label, action }: {
  icon: string; label: string; action?: React.ReactNode;
}) {
  // Qt header is 18pt bold (main.py:7566, 7769). 18pt ≈ 24 px.
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      marginBottom: 14,
      gap: 12,
    }}>
      <div style={{
        flex: 1,
        fontSize: 24,
        fontWeight: 700,
        color: "var(--fg)",
      }}>
        {icon} {label}
      </div>
      {action}
    </div>
  );
}

// Status: Ready row at the bottom of the System Status panel —
// main.py:7739-7758. "Status:" in normal weight + "Ready" in large
// bold green (16pt) on the right.
function ReadyRow() {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      marginTop: 6,
    }}>
      <span style={{ color: "var(--fg)", fontWeight: 700 }}>Status:</span>
      <span style={{
        color: "#22c55e", // _get_status_color(True) — main.py:7748
        fontSize: 22,     // 16pt ≈ 22 px (main.py:7749)
        fontWeight: 700,
      }}>
        Ready
      </span>
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
      color: "var(--fg-strong)",
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
  // Live hardware from native Rust (src-tauri/src/hardware.rs). The
  // command always returns Ok with a default if probing fails, so we
  // never need an error-path UI here.
  const [hw, setHw] = useState<HardwareInfo | null>(null);
  const refreshHw = () => {
    invoke<HardwareInfo>("hardware_info")
      .then(setHw)
      .catch(() => setHw(null));
  };
  useEffect(() => { refreshHw(); }, []);

  // Qt format: "✅ N GPUs detected" + per-GPU rows (main.py:7621-7693)
  // or "⚠️ No GPUs detected" + "Training will use CPU (slower)" when
  // none found (main.py:7695-7706). Format VRAM as integer GB to match
  // Qt's "💾 N GB" rendering.
  const gpus = (hw?.gpus ?? []).map(g => ({
    name: g.name,
    memory: g.vram_gb > 0 ? `${Math.round(g.vram_gb)} GB` : "—",
  }));
  const gpuOk = gpus.length > 0;

  // CPU row — Qt: "CPU: <cpu_name>" left, "<cores> cores | 💾 <ram> GB
  // RAM" right (main.py:7715-7735).
  const cpuName = hw?.cpu_name || "—";
  const cpuCores = hw?.cpu_cores || hw?.cpu_threads || 0;
  const ramGb = hw ? Math.round(hw.ram_total_gb) : 0;

  // Software requirements — Qt builds exactly four rows:
  //   Python 3.8+  / PyTorch (CUDA) / CUDA Drivers / Dependencies
  // (main.py:7788-7873). The Fix Issues button only renders when
  // pytorch_ok is False OR deps_ok is False (main.py:7876).
  const pythonOk = true;
  const pythonVer = "3.11.13";
  const pytorchOk = true;
  const pytorchVer = "2.5.1+cu121";
  const cudaOk = true;
  const cudaVer = "12.6";
  const depsOk = true;
  const depsMsg = depsOk
    ? "Core packages found (full validation runs via Fix Issues)" // main.py:7862
    : "Missing: torch, transformers"; // main.py:7864 shape

  const showFixBtn = !pytorchOk || !depsOk;

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
                  // refreshGpuBtn styling — main.py:7577-7597.
                  background: "linear-gradient(180deg, rgba(60,60,80,0.4), rgba(40,40,60,0.4))",
                  border: "1px solid rgba(127,223,255,0.30)",
                  borderRadius: 12,
                  padding: "8px 15px",
                  color: "var(--fg-strong)",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                🔄 Refresh Hardware Detection
              </button>
            }
          />

          {/* GPU detection block — mirrors main.py:7621-7706 */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {gpuOk ? (
              <>
                <div style={{ color: "#22c55e", fontWeight: 700, fontSize: 14 }}>
                  ✅ {gpus.length} GPU{gpus.length > 1 ? "s" : ""} detected
                </div>
                {gpus.map((g, i) => (
                  <GpuRow key={i} index={i} name={g.name} memory={g.memory} />
                ))}
              </>
            ) : (
              <>
                <div style={{ color: "#FF9800", fontWeight: 700, fontSize: 14 }}>
                  ⚠️ No GPUs detected
                </div>
                <div style={{ color: "var(--fg)", fontSize: 13 }}>
                  Training will use CPU (slower)
                </div>
              </>
            )}

            {/* CPU row — main.py:7714-7736 */}
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
              marginTop: 4,
            }}>
              <span style={{ color: "var(--fg)" }}>
                <b>CPU:</b> {cpuName}
              </span>
              <span style={{ flex: 1 }} />
              <span style={{ color: "var(--fg)" }}>
                <b>{cpuCores} cores</b>
                {ramGb ? <> | <b>💾 {ramGb} GB RAM</b></> : null}
              </span>
            </div>

            <ReadyRow />
          </div>
        </GridPanel>

        <GridPanel accent="rgba(127,223,255,0.30)">
          <PanelHeader icon="⚙️" label="Software Requirements & Setup" />
          {/* Four rows in Qt order — main.py:7788-7873.
              Detail strings reproduce Qt's f-strings verbatim. */}
          <StatusList rows={[
            {
              icon: "🐍",
              name: "Python 3.8+",
              ok: pythonOk,
              value: pythonOk ? `Version ${pythonVer}` : "Not found",
            },
            {
              icon: "🔥",
              name: "PyTorch (CUDA)",
              ok: pytorchOk,
              value: pytorchOk
                ? `Version ${pytorchVer}`
                : "CPU-only version installed", // or "Not installed"
            },
            {
              icon: "🎮",
              name: "CUDA Drivers",
              ok: cudaOk,
              value: cudaOk ? `Version ${cudaVer}` : "Not found",
            },
            {
              icon: "📦",
              name: "Dependencies",
              ok: depsOk,
              value: depsMsg,
            },
          ]} />
          <div style={{ flex: 1 }} />
          {showFixBtn && (
            <button
              data-ui="FixIssuesBtn"
              style={{
                // Magenta gradient from main.py:7878-7900.
                marginTop: 12,
                minHeight: 42,
                padding: "10px 18px",
                borderRadius: 12,
                border: "2px solid #f093fb",
                background: "linear-gradient(180deg, rgba(240,147,251,0.6), rgba(245,87,108,0.6))",
                color: "var(--fg-strong)",
                fontSize: 17, // 13pt ≈ 17 px (main.py:7886)
                fontWeight: 700,
                alignSelf: "flex-start",
                cursor: "pointer",
              }}
            >
              🛠️ Fix Issues (Recommended)
            </button>
          )}
        </GridPanel>

        <WelcomeCircle />
      </div>
    </div>
  );
}
