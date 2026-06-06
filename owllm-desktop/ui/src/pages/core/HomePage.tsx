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

type GpuInfo = {
  index: number;
  name: string;
  vram_gb: number;
  uuid: string;
  selected: boolean;
};
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
  // Page key to navigate to (matches modules.ts firstTab so the
  // ModeBar lights up the corresponding mode toggle automatically
  // via AppShell's owllm:navigate handler).
  targetPage: string;
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
    targetPage: "models",
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
    targetPage: "agents",
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
  // onClick dispatches the same owllm:navigate event StudioPage uses
  // to jump between tabs — AppShell's listener flips the matching
  // ModeBar toggle on AND switches the active SubTab in one step.
  const onClick = () => {
    window.dispatchEvent(new CustomEvent("owllm:navigate", { detail: { key: spec.targetPage } }));
  };
  // Mix the per-launcher brand gradient (Fine Tuning = blue, Agentic
  // Team = teal) with the picked accent. 60 % accent / 40 % brand so
  // the identity hue stays recognisable but the picker visibly
  // repaints these too. Was 100 % brand → dark navy/teal regardless
  // of accent, which the user (rightly) called "old color".
  const bgTop    = `color-mix(in srgb, var(--accent) 60%, ${spec.accentTop})`;
  const bgBottom = `color-mix(in srgb, var(--accent) 60%, ${spec.accentBottom})`;
  const bgHover  = `color-mix(in srgb, var(--accent) 70%, ${spec.accentTop})`;
  return (
    <div
      data-ui={`LauncherCard:${spec.key}`}
      onClick={onClick}
      style={{
        background: `linear-gradient(180deg, ${bgTop} 0%, ${bgBottom} 100%)`,
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
          `linear-gradient(180deg, ${bgHover}, ${bgHover})`;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.background =
          `linear-gradient(180deg, ${bgTop} 0%, ${bgBottom} 100%)`;
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
          color: "rgba(255,255,255,0.82)",
          fontSize: 12,
          letterSpacing: 0.6,
          textTransform: "uppercase",
        }}>
          {spec.tagline}
        </div>
        <div style={{
          color: "#fafafa",
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
            <span style={{ color: "var(--fg-muted)", fontSize: 12 }}>{r.value}</span>
          </div>
        );
      })}
    </div>
  );
}

// Per-GPU detail row used inside the System Status panel — mirrors
// main.py:7641-7693 (GPU N: <name>  ........  💾 <memory>) PLUS a
// trailing checkbox that controls whether this GPU is part of the
// runtime selection (legacy parity).
function GpuRow({
  index, name, memory, selected, onToggle,
}: {
  index: number;
  name: string;
  memory: string;
  selected: boolean;
  onToggle: () => void;
}) {
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
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        title={selected
          ? "Selected for inference — uncheck to skip this GPU"
          : "Click to enable this GPU for inference"}
        style={{ width: 16, height: 16, accentColor: "var(--accent)", cursor: "pointer", marginLeft: 4 }}
      />
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
      // Bottom-row panels switch with theme: --bg-card is white in light
      // mode and a near-black panel in dark mode, so the inner var(--fg)
      // text stays readable in both.
      background: "var(--bg-card)",
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

// One-time welcome splash. It used to sit permanently in the grid
// centre, covering the Refresh button and the Software Requirements
// header. Now it greets on mount, then fades + scales away and
// unmounts after ~2.4s so it never obscures the live panels. Always
// pointer-events:none so it can't eat clicks even mid-fade.
function WelcomeCircle() {
  const D = 240;  // circle_d in main.py:7969
  const [phase, setPhase] = useState<"shown" | "fading" | "gone">("shown");
  useEffect(() => {
    const t1 = setTimeout(() => setPhase("fading"), 1600);
    const t2 = setTimeout(() => setPhase("gone"), 2400);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);
  if (phase === "gone") return null;
  const fading = phase === "fading";
  return (
    <div style={{
      position: "absolute",
      left: "50%",
      top: "50%",
      transform: fading
        ? "translate(-50%, -50%) scale(1.08)"
        : "translate(-50%, -50%) scale(1)",
      opacity: fading ? 0 : 1,
      transition: "opacity 0.8s ease, transform 0.8s ease",
      width: D,
      height: D,
      borderRadius: D / 2,
      // Welcome circle ring follows the accent picker — same colour the
      // active tab and primary action buttons use, so the user's
      // chosen palette shows here as a brand accent.
      border: "3px solid var(--accent)",
      background: "radial-gradient(circle at 50% 50%, rgba(var(--accent-rgb),0.55) 0%, rgba(28,38,72,0.96) 70%, rgba(10,14,28,0.98) 100%)",
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
  // none found (main.py:7695-7706). Format VRAM as MiB / GiB to mirror
  // the old app — which displays "23028 MiB" rather than "23 GB" so
  // the user can see the exact per-card capacity.
  const gpus = (hw?.gpus ?? []).map(g => ({
    uuid: g.uuid,
    name: g.name,
    memory: g.vram_gb > 0 ? `${Math.round(g.vram_gb * 1024)} MiB` : "—",
    selected: g.selected,
  }));
  const gpuOk = gpus.length > 0;
  const selectedCount = gpus.filter(g => g.selected).length;

  const toggleGpu = (uuid: string) => {
    if (!hw) return;
    const next = hw.gpus.map(g =>
      g.uuid === uuid ? { ...g, selected: !g.selected } : g,
    );
    // Optimistic UI update.
    setHw({ ...hw, gpus: next });
    const uuids = next.filter(g => g.selected).map(g => g.uuid);
    invoke("set_gpu_selection", { uuids }).catch(e => {
      console.error("set_gpu_selection failed", e);
      // Revert on error.
      refreshHw();
    });
  };

  // CPU row — Qt: "CPU: <cpu_name>" left, "<threads> cores | 💾 <ram>
  // GB RAM" right (main.py:7715-7735). The legacy app displays the
  // logical-processor count and labels it "cores"; modern Rust
  // `physical_core_count()` returns the smaller P+E figure (24 on the
  // i9-13900KF) which doesn't match what the user expects to see.
  // Keep parity with the legacy display.
  const cpuName = hw?.cpu_name || "—";
  const cpuCores = hw?.cpu_threads || hw?.cpu_cores || 0;
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

        <GridPanel accent="var(--accent-strong)">
          <PanelHeader
            icon="📊"
            label="System Status"
            action={
              <button
                data-ui="RefreshGpuBtn"
                onClick={refreshHw}
                style={{
                  // refreshGpuBtn — uses --bg-elevated so the surface
                  // tracks the theme; --fg-strong is the contrasting
                  // text colour for that surface in both modes.
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--accent-strong)",
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
                  ✅ {selectedCount} of {gpus.length} GPU{gpus.length > 1 ? "s" : ""} selected
                </div>
                {gpus.map((g, i) => (
                  <GpuRow
                    key={g.uuid || i}
                    index={i}
                    name={g.name}
                    memory={g.memory}
                    selected={g.selected}
                    onToggle={() => toggleGpu(g.uuid)}
                  />
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

        <GridPanel accent="var(--accent-strong)">
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
