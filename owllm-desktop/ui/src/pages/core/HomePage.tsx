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
import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import WslSetupModal from "./WslSetupModal";
import { openSyncOnboarding } from "./AccountSyncModal";
import { githubStatus, GITHUB_CHANGED_EVENT } from "../agentic/github";
import {
  fetchReadiness,
  getCachedReadiness,
  isReadinessLoading,
  subscribeReadiness,
} from "./readinessStore";

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

// Mirrors src-tauri/src/readiness.rs. ok=false + warn=true → ⚠️ orange
// (optional/degraded); ok=false + warn=false → ❌ red (missing + needed).
type ReadinessRow = { ok: boolean; warn: boolean; detail: string };
type AppReadiness = {
  wsl: ReadinessRow;
  gpu: ReadinessRow;
  env: ReadinessRow;
  runtime: ReadinessRow;
};

const ICONS = "/Page_icons";

// One of the four quick-actions revealed in the 2x2 hover overlay.
// `icon` is a placeholder glyph for now — the user is supplying real
// icon art later; swap the emoji for an <img> when those arrive.
type TileAction = {
  label: string;
  // Page key dispatched via owllm:navigate — AppShell flips the
  // matching ModeBar toggle AND switches the SubTab in one step.
  targetPage: string;
  icon: string;
  // Real icon art under /Page_icons/. When set, the action cell renders
  // this image (the art already includes its label) instead of the emoji.
  iconPng?: string;
};

type LauncherSpec = {
  key: string;
  title: string;
  iconPng: string;
  accentLine: string;
  // Four quick-actions shown in a 2x2 grid when the tile is hovered.
  actions: TileAction[];
};

const LAUNCHERS: LauncherSpec[] = [
  {
    key: "finetuning",
    title: "Local Models",
    iconPng: "owl_fine_tuning_home.png",
    accentLine: "#7989ff",
    // The local-model pipeline, with the user's supplied icon art: explore a
    // model → abliterate (uncensor) → build a dataset → fine-tune.
    actions: [
      { label: "Explore Models", targetPage: "models", icon: "📦", iconPng: "ExploreModels.png" },
      { label: "Abliterate",     targetPage: "models", icon: "🚫", iconPng: "Abliterate.png" },
      { label: "Create Dataset", targetPage: "train",  icon: "🗂", iconPng: "CreateDataset.png" },
      { label: "Fine Tune",      targetPage: "train",  icon: "🎯", iconPng: "FineTune.png" },
    ],
  },
  {
    key: "agentic",
    title: "Agentic Team",
    iconPng: "owl_agentic_team_home.png",
    accentLine: "#56d3c8",
    // TODO(icons): replace `icon` emojis with the supplied art, and
    // confirm the Personal Assistant / Red Team target pages once those
    // surfaces exist (currently pointed at the closest live page).
    actions: [
      { label: "Coding Agent",      targetPage: "code",    icon: "💻" },
      { label: "Orchestrated Team", targetPage: "agents",  icon: "🤖" },
      { label: "Personal Assistant", targetPage: "bridges", icon: "📱" },
      { label: "Red Team",          targetPage: "studio",  icon: "🛡️" },
    ],
  },
  {
    key: "gamify",
    title: "Gamify",
    iconPng: "owl_Gamify.png",
    accentLine: "#c084fc",
    // TODO(icons): real art + final 2x2 labels/targets from the user.
    // Placeholders wired to the three live Gamify pages for now.
    actions: [
      { label: "Play",       targetPage: "gamify",     icon: "🎮" },
      { label: "Characters", targetPage: "characters", icon: "🧙" },
      { label: "Arena",      targetPage: "arena",      icon: "🏟" },
      { label: "Quests",     targetPage: "gamify",     icon: "⭐" },
    ],
  },
];

function navTo(key: string) {
  window.dispatchEvent(new CustomEvent("owllm:navigate", { detail: { key } }));
}

// Square, image-only launcher tile. At rest it shows just the owl art
// with a soft drop shadow. On hover the shadow turns off, the art dims,
// and a 2x2 matrix of quick-action buttons fades in over it. Each cell
// is a placeholder (emoji + label) until the real icon art lands.
function LauncherTile({ spec }: { spec: LauncherSpec }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      data-ui={`LauncherTile:${spec.key}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "relative",
        aspectRatio: "1 / 1",
        width: "100%",
        borderRadius: 18,
        overflow: "hidden",
        border: `1px solid ${hover ? spec.accentLine : "var(--border-strong)"}`,
        // Shadow ON at rest, OFF on hover (per the spec).
        boxShadow: hover ? "none" : "var(--shadow-lg)",
        background: "var(--bg-elevated)",
        transition: "box-shadow 0.2s, border-color 0.2s",
        cursor: "default",
      }}
    >
      <img
        src={`${ICONS}/${spec.iconPng}`}
        alt={spec.title}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          // contain, NOT cover: the art files differ in aspect ratio (the
          // center "Agentic Team" png is 635x690 = portrait, the others are
          // ~square). cover fills the square tile by cropping the overflow,
          // which sliced the top/bottom off the narrower center image. contain
          // fits the whole image inside the tile (no crop) — a non-square image
          // just gets a thin letterbox against the tile background.
          objectFit: "contain",
          // Picture only — render the owl art at 90% of its size, centered.
          // The tile/container keeps its full size; just the image shrinks.
          transform: "scale(0.9)",
          // Dim the art on hover so the action grid reads clearly.
          filter: hover ? "brightness(0.32) saturate(0.85)" : "none",
          transition: "filter 0.2s",
          pointerEvents: "none",
        }}
      />
      {/* 2x2 action matrix — fades/scales in on hover. pointer-events
          gated so it can't intercept anything while invisible. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gridTemplateRows: "1fr 1fr",
          gap: 14,
          padding: 18,
          opacity: hover ? 1 : 0,
          transform: hover ? "scale(1)" : "scale(0.96)",
          transition: "opacity 0.18s ease, transform 0.18s ease",
          pointerEvents: hover ? "auto" : "none",
        }}
      >
        {spec.actions.map((a) => (
          <button
            key={a.label}
            data-ui={`TileAction:${spec.key}:${a.targetPage}`}
            onClick={() => navTo(a.targetPage)}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              borderRadius: 14,
              border: `1px solid ${spec.accentLine}`,
              background: "rgba(10,14,28,0.62)",
              color: "#fafafa",
              cursor: "pointer",
              transition: "background 0.12s, transform 0.12s",
            }}
            onMouseEnter={(e) => {
              const b = e.currentTarget as HTMLButtonElement;
              b.style.background = `color-mix(in srgb, ${spec.accentLine} 38%, rgba(10,14,28,0.62))`;
              b.style.transform = "translateY(-2px)";
            }}
            onMouseLeave={(e) => {
              const b = e.currentTarget as HTMLButtonElement;
              b.style.background = "rgba(10,14,28,0.62)";
              b.style.transform = "translateY(0)";
            }}
          >
            {a.iconPng ? (
              // Real art (label is baked into the image) — fill the cell.
              <img
                src={`${ICONS}/${a.iconPng}`}
                alt={a.label}
                style={{ width: "100%", height: "100%", objectFit: "contain", padding: 4, pointerEvents: "none" }}
              />
            ) : (
              <>
                <span style={{ fontSize: 30, lineHeight: 1 }}>{a.icon}</span>
                <span style={{ fontSize: 14, fontWeight: 700, textAlign: "center", padding: "0 6px" }}>
                  {a.label}
                </span>
              </>
            )}
          </button>
        ))}
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
  // "Ready" now matches the "Status:" label size (was an oversized 22px
  // that dominated the panel) — same 14px, just green + bold.
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      marginTop: 6,
      fontSize: 14,
    }}>
      <span style={{ color: "var(--fg)", fontWeight: 700 }}>Status:</span>
      <span style={{
        color: "#22c55e", // _get_status_color(True) — main.py:7748
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

  // Software requirements — REAL readiness from the native app_readiness
  // command (src-tauri/src/readiness.rs). Replaces the old hardcoded
  // Python/PyTorch/CUDA/Deps rows that printed the same fake versions on
  // every machine and described a host-Python world the app no longer
  // uses (fine-tuning runs in a WSL/uv env now).
  // Cached at module scope (readinessStore) so navigating back to Home is
  // instant: we probe ONCE per session and only re-check when the user
  // presses Refresh or finishes a setup action. `forceReady` re-renders
  // this component when the shared cache changes.
  const [, forceReady] = useReducer((x: number) => x + 1, 0);
  useEffect(() => subscribeReadiness(forceReady), []);
  useEffect(() => { fetchReadiness(false); }, []);
  const ready = getCachedReadiness();
  const readyLoading = isReadinessLoading();
  // Stable identity: this is passed as `onChanged` to WslSetupModal /
  // EnvironmentModal, which feed it into effect deps. An inline (per-render)
  // function there causes an infinite refresh loop. fetchReadiness is a stable
  // module import, so [] deps are safe.
  const refreshReady = useCallback(() => { fetchReadiness(true); }, []);

  // Self-heal a post-upgrade cold start: if WSL reads as not-ready on the
  // first probe (the WSL service is still warming after the app restarted),
  // force ONE re-check a few seconds later before trusting "not installed".
  const wslRetried = useRef(false);
  useEffect(() => {
    if (ready && !ready.wsl.ok && !wslRetried.current) {
      wslRetried.current = true;
      const t = setTimeout(() => fetchReadiness(true), 4000);
      return () => clearTimeout(t);
    }
  }, [ready]);

  // GitHub / sync account state for the top sign-in bar. Reloads on mount, on
  // the in-window `github-changed` broadcast (immediate after a connect from
  // any surface), and on window focus (out-of-window browser device-flow).
  const [account, setAccount] = useState<{ connected: boolean; login: string | null }>({ connected: false, login: null });
  useEffect(() => {
    let dead = false;
    const load = () => { githubStatus().then((s) => { if (!dead) setAccount(s); }).catch(() => {}); };
    load();
    window.addEventListener("focus", load);
    window.addEventListener(GITHUB_CHANGED_EVENT, load);
    return () => {
      dead = true;
      window.removeEventListener("focus", load);
      window.removeEventListener(GITHUB_CHANGED_EVENT, load);
    };
  }, []);
  // Guided WSL setup modal — opened from the WSL row when it's not ready,
  // and from other pages (e.g. the Environment popup) via the
  // `owllm:open-wsl-setup` event after they navigate Home.
  const [wslSetupOpen, setWslSetupOpen] = useState(false);
  useEffect(() => {
    const open = () => setWslSetupOpen(true);
    window.addEventListener("owllm:open-wsl-setup", open);
    return () => window.removeEventListener("owllm:open-wsl-setup", open);
  }, []);
  // Build the four display rows from the live signal. While loading
  // (ready === null) show neutral "Checking…" rows.
  const reqRows: StatusRow[] = ready
    ? [
        { icon: "🐧", name: "WSL / Ubuntu",     ok: ready.wsl.warn ? "warn" : ready.wsl.ok,         value: ready.wsl.detail },
        { icon: "🎮", name: "GPU & CUDA driver", ok: ready.gpu.warn ? "warn" : ready.gpu.ok,         value: ready.gpu.detail },
        { icon: "🐍", name: "Fine-tuning env",   ok: ready.env.warn ? "warn" : ready.env.ok,         value: ready.env.detail },
        { icon: "🦙", name: "Local LLM runtime", ok: ready.runtime.warn ? "warn" : ready.runtime.ok, value: ready.runtime.detail },
      ]
    : [
        { icon: "🐧", name: "WSL / Ubuntu",     ok: "warn", value: "Checking…" },
        { icon: "🎮", name: "GPU & CUDA driver", ok: "warn", value: "Checking…" },
        { icon: "🐍", name: "Fine-tuning env",   ok: "warn", value: "Checking…" },
        { icon: "🦙", name: "Local LLM runtime", ok: "warn", value: "Checking…" },
      ];

  // The fine-tuning env is the one row a user can act on from here —
  // surface a "Set up" button that jumps to the Train page when it's
  // not ready yet.
  const envNeedsSetup = !!ready && !ready.env.ok;
  // WSL not ready → offer the guided setup (install Ubuntu + Python, or
  // the one-time BIOS step). The Coder still works on the host meanwhile.
  const wslNeedsSetup = !!ready && !ready.wsl.ok;
  // Local LLM runtime (llama.cpp) missing → one-click install the
  // local-inference module instead of making the user discover that it
  // only auto-installs when you first start a model. module_install picks
  // the cuda/cpu variant from the detected hardware.
  const runtimeNeedsSetup = !!ready && !ready.runtime.ok;
  const [installingEngine, setInstallingEngine] = useState(false);
  const installEngine = () => {
    setInstallingEngine(true);
    invoke("module_install", { id: "local-inference" })
      .then(() => refreshReady())
      .catch((e) => console.error("engine install failed", e))
      .finally(() => setInstallingEngine(false));
  };

  return (
    <div style={{ padding: "30px 40px", height: "100%", overflow: "auto" }}>
      <div
        data-ui="HomeGrid"
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          gap: 28,
        }}
      >
        {/* Account / sync bar — sign in with GitHub so chats & settings
            follow you across devices. Opens the onboarding popup. */}
        <button
          data-ui="SyncAccountBar"
          onClick={openSyncOnboarding}
          title={account.connected ? "Manage sync / account" : "Sign in to sync your chats & settings across devices"}
          style={{
            display: "flex", alignItems: "center", gap: 12,
            padding: "12px 18px", borderRadius: 14, cursor: "pointer", textAlign: "left",
            border: `1px solid ${account.connected ? "rgba(34,197,94,0.45)" : "var(--accent-strong)"}`,
            background: account.connected ? "rgba(34,197,94,0.08)" : "var(--bg-elevated)",
            color: "var(--fg)",
          }}
        >
          {account.connected
            ? <span style={{ fontSize: 22, lineHeight: 1 }}>☁️</span>
            : <img src={`${ICONS}/owllm_main.png`} alt="OWLLM" style={{ height: 26, width: "auto", flexShrink: 0 }} />}
          <span style={{ flex: 1 }}>
            {account.connected ? (
              <>
                <span style={{ fontWeight: 800, color: "#22c55e" }}>Synced as @{account.login}</span>
                <span style={{ color: "var(--fg-muted)", fontSize: 12.5 }}> — your chats &amp; settings follow you across devices</span>
              </>
            ) : (
              <>
                <span style={{ fontWeight: 800, color: "var(--fg-strong)" }}>Sign in with GitHub</span>
                <span style={{ color: "var(--fg-muted)", fontSize: 12.5 }}> — take your chats, settings &amp; agent teams to every device</span>
              </>
            )}
          </span>
          <span style={{
            fontSize: 12.5, fontWeight: 800,
            color: account.connected ? "#22c55e" : "var(--accent)",
          }}>{account.connected ? "Manage →" : "Sign in →"}</span>
        </button>

        {/* "Why?" teaser — opens the same popup, for users who want to read the
            benefits before committing to sign-in. Hidden once connected. */}
        {!account.connected && (
          <button
            onClick={openSyncOnboarding}
            title="See everything you unlock with a free GitHub account"
            style={{
              alignSelf: "flex-start", marginLeft: 6, marginTop: -2,
              background: "none", border: "none", cursor: "pointer",
              color: "var(--accent)", fontSize: 12, fontWeight: 700, padding: "2px 2px",
            }}
          >✨ Why connect GitHub? — see what you unlock</button>
        )}

        {/* Square, image-only launcher tiles. Three equal columns that
            stretch to the full window width (1fr each) so the row never
            leaves dead space on the sides; each tile stays square via
            aspectRatio and reveals a 2x2 quick-action matrix on hover. */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 28,
        }}>
          <LauncherTile spec={LAUNCHERS[0]} />
          <LauncherTile spec={LAUNCHERS[1]} />
          <LauncherTile spec={LAUNCHERS[2]} />
        </div>

        {/* Status panels — equal height (alignItems:stretch makes both
            match the taller one) so the row reads as a balanced pair
            instead of two mismatched boxes. */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 28,
          alignItems: "stretch",
        }}>

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
          <PanelHeader
            icon="⚙️"
            label="Software Requirements & Setup"
            action={
              <button
                data-ui="RefreshReadyBtn"
                onClick={refreshReady}
                disabled={readyLoading}
                title="Re-check WSL / GPU / environment / runtime"
                style={{
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--accent-strong)",
                  borderRadius: 12,
                  padding: "8px 15px",
                  color: "var(--fg-strong)",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: readyLoading ? "wait" : "pointer",
                  opacity: readyLoading ? 0.6 : 1,
                }}
              >
                {readyLoading ? "⏳ Checking…" : "🔄 Refresh"}
              </button>
            }
          />
          {/* Four LIVE readiness signals (readiness.rs): WSL, GPU+CUDA
              driver, fine-tuning env, llama runtime. ⚠️ = optional/degraded
              (e.g. CPU-only, env not set up yet); ❌ = missing + needed. */}
          <StatusList rows={reqRows} />
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 12 }}>
            {wslNeedsSetup && (
              <button
                data-ui="SetupWslBtn"
                onClick={() => setWslSetupOpen(true)}
                title="Guided WSL setup — install Ubuntu + Python automatically"
                style={{
                  minHeight: 42,
                  padding: "10px 18px",
                  borderRadius: 12,
                  border: "2px solid var(--accent-strong)",
                  background: "var(--bg-elevated)",
                  color: "var(--fg-strong)",
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                🐧 Set up WSL
              </button>
            )}
            {envNeedsSetup && (
              <button
                data-ui="SetupEnvBtn"
                onClick={() => {
                  // Jump to Train, then pop the Environment dialog open (small
                  // delay so TrainPage has mounted + attached its listener).
                  navTo("train");
                  setTimeout(() => window.dispatchEvent(new CustomEvent("owllm:open-env")), 180);
                }}
                title="Open the fine-tuning environments dialog"
                style={{
                  minHeight: 42,
                  padding: "10px 18px",
                  borderRadius: 12,
                  border: "2px solid var(--accent-strong)",
                  background: "var(--bg-elevated)",
                  color: "var(--fg-strong)",
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                🛠️ Set up Fine-tuning Environment
              </button>
            )}
            {runtimeNeedsSetup && (
              <button
                data-ui="InstallEngineBtn"
                onClick={installEngine}
                disabled={installingEngine}
                title="Download + install the local llama.cpp inference engine for your GPU"
                style={{
                  minHeight: 42,
                  padding: "10px 18px",
                  borderRadius: 12,
                  border: "2px solid var(--accent-strong)",
                  background: "var(--bg-elevated)",
                  color: "var(--fg-strong)",
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: installingEngine ? "wait" : "pointer",
                  opacity: installingEngine ? 0.6 : 1,
                }}
              >
                {installingEngine ? "⏳ Installing engine…" : "🦙 Install LLM engine"}
              </button>
            )}
          </div>
        </GridPanel>
        </div>
      </div>

      <WslSetupModal
        open={wslSetupOpen}
        onClose={() => setWslSetupOpen(false)}
        onChanged={refreshReady}
      />
    </div>
  );
}
