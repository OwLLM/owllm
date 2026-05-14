// AppShell — the persistent chrome wrapping every page: HybridFrame
// (corners + badge), the top ModeBar, and the SubTabs nav.
//
// Architecture (2026-05-14): mirrors the Qt navbar groups from
// main.py:4284-4297 exactly. The ModeBar toggles (Fine Tuning /
// Agentic Team / Gamify) are a single-active state machine; only
// the active mode's pages plus the always-on Core pages render in
// SubTabs. The ⚙ Advanced toggle is independent and additive — when
// on, it appends the Advanced module's pages (MCP / Environment /
// Accounts / Logs) regardless of the active mode.
//
// All page definitions live in core/modules.ts so each mode is a
// self-contained installable feature. Adding/removing a page does
// not touch this file. Adding a brand-new mode = one entry in
// modules.ts plus a directory under pages/.
import React, { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ALL_MODULES,
  ADVANCED,
  CORE,
  getInstalledModes,
  ModeId,
  PageDef,
} from "./core/modules";

// Track the live viewport so HybridFrame fills the window instead
// of being clipped to a fixed 1600x960 box. With decorations:false
// any size mismatch (display scaling, future window resize) clips
// the chrome on the right/bottom.
function useViewportSize() {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

// The window is `decorations: false` (see tauri.conf.json) — the
// HybridFrame chrome IS the window border. These three buttons are
// the only system controls we provide; drag-to-move is wired via
// the data-tauri-drag-region attribute on the ModeBar.
function WindowControls() {
  const w = getCurrentWindow();
  const btn: React.CSSProperties = {
    width: 36, height: 28, border: "none", background: "transparent",
    color: "#dadcdf", fontSize: 14, cursor: "pointer", userSelect: "none",
    display: "flex", alignItems: "center", justifyContent: "center",
  };
  return (
    <div style={{
      position: "absolute", top: 8, right: 14, zIndex: 50,
      display: "flex", gap: 2,
    }}>
      <button title="Minimize" style={btn} onClick={() => w.minimize()}>—</button>
      <button title="Maximize" style={btn} onClick={() => w.toggleMaximize()}>▢</button>
      <button title="Close" style={{ ...btn, color: "#ff8080" }} onClick={() => w.close()}>✕</button>
    </div>
  );
}

// With decorations:false the native resize borders are gone, so we
// paint 8 invisible 6-pixel hot regions around the window edges and
// route mousedown into Tauri's startResizeDragging() — same model as
// VS Code, Discord, etc. Without this the window would be locked at
// its initial size.
type ResizeDir = "North" | "South" | "East" | "West" | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";
function ResizeEdges() {
  const w = getCurrentWindow();
  const begin = (dir: ResizeDir) => (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // Tauri 2 expects a string union; TS types here are loose since
    // @tauri-apps/api doesn't re-export ResizeDirection cleanly.
    (w as any).startResizeDragging(dir);
  };
  const T = 6;          // grab thickness (px) along straight edges
  const C = 14;         // grab size (px) of corner squares
  const base: React.CSSProperties = { position: "absolute", zIndex: 60, background: "transparent" };
  return (
    <>
      <div onMouseDown={begin("North")}      style={{ ...base, top: 0, left: C, right: C, height: T, cursor: "ns-resize" }} />
      <div onMouseDown={begin("South")}      style={{ ...base, bottom: 0, left: C, right: C, height: T, cursor: "ns-resize" }} />
      <div onMouseDown={begin("West")}       style={{ ...base, left: 0, top: C, bottom: C, width: T, cursor: "ew-resize" }} />
      <div onMouseDown={begin("East")}       style={{ ...base, right: 0, top: C, bottom: C, width: T, cursor: "ew-resize" }} />
      <div onMouseDown={begin("NorthWest")}  style={{ ...base, top: 0, left: 0, width: C, height: C, cursor: "nwse-resize" }} />
      <div onMouseDown={begin("NorthEast")}  style={{ ...base, top: 0, right: 0, width: C, height: C, cursor: "nesw-resize" }} />
      <div onMouseDown={begin("SouthWest")}  style={{ ...base, bottom: 0, left: 0, width: C, height: C, cursor: "nesw-resize" }} />
      <div onMouseDown={begin("SouthEast")}  style={{ ...base, bottom: 0, right: 0, width: C, height: C, cursor: "nwse-resize" }} />
    </>
  );
}

// Minimums match tauri.conf.json window.{minWidth,minHeight} so the
// frame math never goes negative under a small viewport.
const MIN_PARENT_W = 800;
const MIN_PARENT_H = 500;

// ---------------------------------------------------------------------
// HybridFrame — see hardware_window.py port comment. Unchanged.
// ---------------------------------------------------------------------
const BADGE_W = 300;
const BADGE_H = 195;
const BORDER_T = 18;
const CORNER_OUTSET = 10;
const SHIFT_OUT = BORDER_T / 2;
const EXTRA_TOP = BADGE_H / 2;
const EXTRA_RIGHT = 75;
const CORNER_PNG_W = 160;
const CORNER_PNG_H_TL = Math.round(CORNER_PNG_W * 513 / 486);
const CORNER_PNG_H_TR = Math.round(CORNER_PNG_W * 484 / 516);
const CORNER_PNG_H_BL = Math.round(CORNER_PNG_W * 512 / 488);
const CORNER_PNG_H_BR = Math.round(CORNER_PNG_W * 488 / 512);
const PARENT_X = SHIFT_OUT + CORNER_OUTSET;
const PARENT_Y = EXTRA_TOP + SHIFT_OUT + CORNER_OUTSET;
const FRAME_COLOR  = "rgba(200, 240, 255, 0.86)";
const FRAME_ACCENT = "rgba(120, 220, 255, 0.78)";
const FRAME_BG     = "rgba(8, 12, 24, 0.95)";

const ICONS = "/Page_icons";
const CORNERS = `${ICONS}/CornersNew`;

function HybridFrame({ children, outerW, outerH }: {
  children: React.ReactNode; outerW: number; outerH: number;
}) {
  // Invert the legacy formula: with `outerW = parent_w + EXTRA_RIGHT
  // + 2*so + 2*CORNER_OUTSET`, solve for parent_w given the live
  // viewport. Clamped to MIN_PARENT_* so frame edges never overlap.
  const parent_w = Math.max(MIN_PARENT_W, outerW - EXTRA_RIGHT - 2 * SHIFT_OUT - 2 * CORNER_OUTSET);
  const parent_h = Math.max(MIN_PARENT_H, outerH - EXTRA_TOP   - 2 * SHIFT_OUT - 2 * CORNER_OUTSET);
  const parent_x = PARENT_X;
  const parent_y = PARENT_Y;
  const t = BORDER_T;
  const so = SHIFT_OUT;
  const outerL = parent_x - so;
  const outerT = parent_y - so;
  const outerW2 = parent_w + 2 * so + t / 2;
  const outerH2 = parent_h + 2 * so;
  const outerR = outerL + outerW2;
  const outerB = outerT + outerH2;
  const innerL = parent_x - so + t;
  const innerT = parent_y - so + t;
  const innerW = parent_w + 2 * so - 2 * t + t / 2;
  const innerH = parent_h + 2 * so - 2 * t;
  const topBar   = { x: parent_x - so, y: parent_y - so, w: parent_w + 2 * so, h: t };
  const botBar   = { x: parent_x - so, y: parent_y + parent_h - t / 2, w: parent_w + 2 * so, h: t };
  const leftBar  = { x: parent_x - so, y: parent_y - so, w: t, h: parent_h + 2 * so };
  const rightBar = { x: parent_x + parent_w, y: parent_y - so, w: t, h: parent_h + 2 * so };
  const brkL = 36, brkI = 14;
  const bxL = outerL + brkI, bxR = outerR - brkI;
  const byT = outerT + brkI, byB = outerB - brkI;
  const tckL = 18, tckI = 10;
  const midx = (outerL + outerR) / 2;
  const midy = (outerT + outerB) / 2;
  const cnTL = { x: outerL - CORNER_OUTSET,                    y: outerT - CORNER_OUTSET };
  const cnTR = { x: outerR - CORNER_PNG_W + 1 + CORNER_OUTSET, y: outerT - CORNER_OUTSET };
  const cnBL = { x: outerL - CORNER_OUTSET,                    y: outerB - CORNER_PNG_H_BL + 1 + CORNER_OUTSET };
  const cnBR = { x: outerR - CORNER_PNG_W + 1 + CORNER_OUTSET, y: outerB - CORNER_PNG_H_BR + 1 + CORNER_OUTSET };
  const badgeX = parent_x + (parent_w - BADGE_W) / 2;
  const badgeY = parent_y - BADGE_H / 2;
  return (
    <div style={{ position:"relative", width:outerW, height:outerH, background:"transparent" }}>
      <div style={{ position:"absolute", left:parent_x, top:parent_y, width:parent_w, height:parent_h, background:"#0e1117", overflow:"hidden" }}>{children}</div>
      {/* The four chrome bars double as drag-regions: any visible
          part of the frame acts like a titlebar, the way the user
          intuitively expects on a frameless window. */}
      <div data-tauri-drag-region style={{ position:"absolute", left:topBar.x,   top:topBar.y,   width:topBar.w,   height:topBar.h,   background:FRAME_BG }} />
      <div data-tauri-drag-region style={{ position:"absolute", left:botBar.x,   top:botBar.y,   width:botBar.w,   height:botBar.h,   background:FRAME_BG }} />
      <div data-tauri-drag-region style={{ position:"absolute", left:leftBar.x,  top:leftBar.y,  width:leftBar.w,  height:leftBar.h,  background:FRAME_BG }} />
      <div data-tauri-drag-region style={{ position:"absolute", left:rightBar.x, top:rightBar.y, width:rightBar.w, height:rightBar.h, background:FRAME_BG }} />
      <svg width={outerW} height={outerH} style={{ position:"absolute", left:0, top:0, pointerEvents:"none" }}>
        <rect x={outerL + 1} y={outerT + 1} width={outerW2 - 2} height={outerH2 - 2} rx={14} ry={14} fill="none" stroke={FRAME_COLOR} strokeWidth={1} />
        <rect x={innerL} y={innerT} width={innerW} height={innerH} rx={10} ry={10} fill="none" stroke={FRAME_ACCENT} strokeWidth={1} />
        <g stroke={FRAME_ACCENT} strokeWidth={1}>
          <line x1={bxL} y1={byT} x2={bxL + brkL} y2={byT} />
          <line x1={bxL} y1={byT} x2={bxL} y2={byT + brkL} />
          <line x1={bxR} y1={byT} x2={bxR - brkL} y2={byT} />
          <line x1={bxR} y1={byT} x2={bxR} y2={byT + brkL} />
          <line x1={bxL} y1={byB} x2={bxL + brkL} y2={byB} />
          <line x1={bxL} y1={byB} x2={bxL} y2={byB - brkL} />
          <line x1={bxR} y1={byB} x2={bxR - brkL} y2={byB} />
          <line x1={bxR} y1={byB} x2={bxR} y2={byB - brkL} />
        </g>
        <g stroke={FRAME_ACCENT} strokeWidth={1}>
          <line x1={midx - tckL / 2} y1={outerT + tckI} x2={midx + tckL / 2} y2={outerT + tckI} />
          <line x1={midx - tckL / 2} y1={outerB - tckI} x2={midx + tckL / 2} y2={outerB - tckI} />
          <line x1={outerL + tckI}   y1={midy - tckL / 2} x2={outerL + tckI} y2={midy + tckL / 2} />
          <line x1={outerR - tckI}   y1={midy - tckL / 2} x2={outerR - tckI} y2={midy + tckL / 2} />
        </g>
      </svg>
      <img src={`${CORNERS}/corner_br.png`} style={{ position:"absolute", left:cnBR.x, top:cnBR.y, width:CORNER_PNG_W, height:CORNER_PNG_H_BR, pointerEvents:"none" }} />
      <img src={`${CORNERS}/corner_ul.png`} style={{ position:"absolute", left:cnTL.x, top:cnTL.y, width:CORNER_PNG_W, height:CORNER_PNG_H_TL, pointerEvents:"none" }} />
      <img src={`${CORNERS}/corner_ur.png`} style={{ position:"absolute", left:cnTR.x, top:cnTR.y, width:CORNER_PNG_W, height:CORNER_PNG_H_TR, pointerEvents:"none" }} />
      <img src={`${CORNERS}/corner_bl.png`} style={{ position:"absolute", left:cnBL.x, top:cnBL.y, width:CORNER_PNG_W, height:CORNER_PNG_H_BL, pointerEvents:"none" }} />
      <img src={`${ICONS}/owl_studio_square.png`} style={{ position:"absolute", left:badgeX, top:badgeY, width:BADGE_W, height:BADGE_H, pointerEvents:"none" }} />
    </div>
  );
}

// ---------------------------------------------------------------------
// ModeBar — top dark-blue header with theme controls, mode toggles,
// title, and SysInfo. Mode toggles drive the active mode state.
// ---------------------------------------------------------------------
type ActiveMode = "home" | "finetuning" | "agentic" | "gamify";

function ModeBar({
  mode, setMode, advancedOpen, setAdvancedOpen, installed,
}: {
  mode: ActiveMode;
  setMode: (m: ActiveMode) => void;
  advancedOpen: boolean;
  setAdvancedOpen: (v: boolean) => void;
  installed: ModeId[];
}) {
  const baseBtn: React.CSSProperties = {
    height: 50, padding: "0 14px",
    background: "linear-gradient(180deg, rgba(60,60,80,0.85), rgba(40,40,60,0.85))",
    color: "#fff",
    border: "1px solid rgba(255,255,255,0.20)",
    borderRadius: 6, fontSize: 13, fontWeight: 700,
    display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center",
    lineHeight: 1.05, gap: 2,
    cursor: "pointer", userSelect: "none",
  };
  // Qt :checked QPushButton — gold border + warm dark gradient.
  // (main.py:3137-3141 style applied to the group toggles.)
  const active: React.CSSProperties = {
    ...baseBtn,
    border: "1px solid #ffd080",
    background: "linear-gradient(180deg, rgba(80,70,50,0.85), rgba(60,50,30,0.85))",
  };
  const colorBtn = (c: string): React.CSSProperties => ({
    width: 18, height: 18, borderRadius: 3, background: c, border: "none", padding: 0,
  });

  // Filter the three mode toggles to only those installed.
  // ActiveMode excludes "home" / "core" / "advanced" — only the three
  // group toggles. Each id is also a valid ModeId so `installed`
  // (ModeId[]) can include() them; narrow with a typed cast.
  type ToggleId = Exclude<ActiveMode, "home">;
  type ToggleSpec = { id: ToggleId; emoji: string; label: string; width: number };
  const TOGGLES: ToggleSpec[] = [
    { id: "finetuning", emoji: "🛠",  label: "Fine Tuning", width: 129 },
    { id: "agentic",    emoji: "🎭", label: "Agentic Team", width: 147 },
    { id: "gamify",     emoji: "🎮", label: "Gamify",       width: 91  },
  ];
  const visibleToggles = TOGGLES.filter(t => installed.includes(t.id as ModeId));

  return (
    <div data-ui="AppHeader" data-tauri-drag-region style={{
      height: 80,
      display: "grid", gridTemplateColumns: "auto 1fr auto",
      alignItems: "center", padding: "10px 50px 10px 20px", gap: 16,
      background: "#1c2244",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div data-ui="DarkModeBtn" style={{
          width: 70, height: 50, borderRadius: 6,
          background: "linear-gradient(180deg, rgba(60,60,80,0.8), rgba(40,40,60,0.8))",
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", lineHeight: 1.0,
        }}>
          <div style={{ fontSize: 22 }}>🌙</div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#fff" }}>Dark</div>
        </div>
        <div data-ui="ColorSelector" style={{
          width: 70, height: 50, padding: 4,
          display: "grid", gridTemplateColumns: "repeat(3, 18px)", gridTemplateRows: "repeat(2, 18px)",
          gap: 3, background: "rgba(60,60,80,0.4)", borderRadius: 6,
        }}>
          {["#667eea","#fbbf24","#ef4444","#3b82f6","#10b981","#6b7280"].map(c =>
            <button key={c} style={colorBtn(c)} />
          )}
        </div>

        {/* Advanced toggle — independent. Reveals advanced pages. */}
        <button
          data-ui="AdvancedToggle"
          onClick={() => setAdvancedOpen(!advancedOpen)}
          style={{ ...(advancedOpen ? active : baseBtn), width: 114 }}
        >
          <span style={{ fontSize: 18 }}>⚙</span>
          <span>Advanced</span>
        </button>

        {/* Mode toggles — single-active. Click toggles back to "home" if
            the same mode is clicked twice. Hidden when the mode isn't
            installed (per getInstalledModes() in modules.ts). */}
        {visibleToggles.map(t => (
          <button
            key={t.id}
            data-ui={`${t.id}-toggle`}
            onClick={() => setMode(mode === t.id ? "home" : t.id)}
            style={{ ...(mode === t.id ? active : baseBtn), width: t.width }}
          >
            <span style={{ fontSize: 18 }}>{t.emoji}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      <div style={{ display: "flex", justifyContent: "center" }}>
        <div data-ui="AppTitle" style={{
          textAlign: "center", width: 128, height: 45,
          fontSize: 29, fontWeight: 700, color: "#fff",
          letterSpacing: 2, lineHeight: "45px",
        }}>OWLLM</div>
      </div>

      <div data-ui="SysInfoBlock" style={{
        minWidth: 543, width: 543, height: 60,
        display: "flex", flexDirection: "column",
        alignItems: "stretch", justifyContent: "center", gap: 3,
        fontSize: 12, fontWeight: 700, color: "#fff", textAlign: "right",
      }}>
        <div data-ui="HeaderServersLabel"><span className="status-dot" style={{ background: "#22c55e", color: "#22c55e" }} />Servers: 1 [Quagenmed-K4] Abbreviated Q4_K_M GGUF…</div>
        <div data-ui="HeaderApiKeyLabel"><span className="status-dot" style={{ background: "#22c55e", color: "#22c55e" }} />API key: owllm-local</div>
        <div data-ui="HeaderVramLabel"><span style={{ marginRight: 4 }}>💾</span>VRAM: N/A</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// SubTabs — composed dynamically from the visible page list.
// ---------------------------------------------------------------------
function SubTabs({
  pages, activeKey, onChange,
}: {
  pages: PageDef[];
  activeKey: string;
  onChange: (key: string) => void;
}) {
  return (
    <div style={{
      height: 76, background: "#1a1f2c",
      display: "flex", alignItems: "center",
      padding: "0 24px", gap: 6, fontSize: 13, color: "#dadcdf",
    }}>
      {pages.map(p => {
        const active = p.key === activeKey;
        return (
          <div
            key={p.key}
            onClick={() => onChange(p.key)}
            style={{
              padding: "10px 16px",
              background: active ? "rgba(120,220,255,0.20)" : "transparent",
              color: active ? "#7fdfff" : "#9aa0a6",
              borderRadius: 8,
              fontWeight: 600,
              borderBottom: active ? "2px solid #7fdfff" : "2px solid transparent",
              cursor: "pointer",
              userSelect: "none",
            }}
          >
            {p.label}
          </div>
        );
      })}
      <div style={{ flex: 1 }} />
      <div style={{ color: "#888", fontSize: 11 }}>Product Studio Test ▾</div>
      <button className="ghost-btn">Team</button>
      <button className="ghost-btn">+ New</button>
      <button className="ghost-btn">Rename</button>
      <button className="ghost-btn">Delete</button>
    </div>
  );
}

// ---------------------------------------------------------------------
// AppShell — top-level state machine.
// ---------------------------------------------------------------------
export default function AppShell() {
  const installed = useMemo(() => getInstalledModes(), []);
  const [mode, setMode] = useState<ActiveMode>("home");
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(false);

  // Compose the visible page list: Core always, plus the active
  // mode's pages, plus Advanced's pages when advancedOpen.
  // Order mirrors Qt: base buttons first, then group buttons, then
  // advanced buttons.
  const visiblePages: PageDef[] = useMemo(() => {
    const out: PageDef[] = [...CORE.pages];
    if (mode !== "home") {
      // mode is "finetuning" | "agentic" | "gamify", all of which are
      // valid ModeId values — narrow the type explicitly so the
      // includes() check below is well-typed.
      const modeId: ModeId = mode;
      const m = ALL_MODULES.find(x => x.id === modeId);
      if (m && installed.includes(modeId)) {
        out.push(...m.pages);
      }
    }
    if (advancedOpen && installed.includes("advanced")) {
      out.push(...ADVANCED.pages);
    }
    return out;
  }, [mode, advancedOpen, installed]);

  // When mode changes, jump to that mode's firstTab. When mode is
  // 'home' (no group active), default to the Core firstTab ('home').
  const defaultKeyForMode = (m: ActiveMode): string => {
    if (m === "home") return CORE.firstTab;
    const mod = ALL_MODULES.find(x => x.id === m);
    return mod?.firstTab ?? CORE.firstTab;
  };
  const [activeKey, setActiveKey] = useState<string>(() => defaultKeyForMode("home"));

  // Whenever mode changes, snap to that mode's first tab. (Qt
  // _activate_navbar_group does the same.)
  const handleSetMode = (m: ActiveMode) => {
    setMode(m);
    setActiveKey(defaultKeyForMode(m));
  };

  // If the user toggles Advanced off while looking at an Advanced
  // page, snap back to the mode's first tab so they're not stranded.
  const handleSetAdvanced = (v: boolean) => {
    setAdvancedOpen(v);
    if (!v) {
      const onAdvancedPage = ADVANCED.pages.some(p => p.key === activeKey);
      if (onAdvancedPage) setActiveKey(defaultKeyForMode(mode));
    }
  };

  // Resolve the active page's component.
  const activePage = visiblePages.find(p => p.key === activeKey)
                  ?? visiblePages[0];
  const PageBody = activePage?.component;

  const vp = useViewportSize();

  return (
    <div style={{ position: "relative", width: vp.w, height: vp.h, overflow: "hidden" }}>
      {/* ResizeEdges + WindowControls live OUTSIDE HybridFrame so
          their absolute coordinates are anchored to the real window
          (0,0)..(vp.w,vp.h), not to the inner clipped content area. */}
      <ResizeEdges />
      <WindowControls />
      <HybridFrame outerW={vp.w} outerH={vp.h}>
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <ModeBar
            mode={mode}
            setMode={handleSetMode}
            advancedOpen={advancedOpen}
            setAdvancedOpen={handleSetAdvanced}
            installed={installed}
          />
          <SubTabs
            pages={visiblePages}
            activeKey={activeKey}
            onChange={setActiveKey}
          />
          <div style={{ flex: 1, overflow: "hidden", minHeight: 0 }}>
            {PageBody ? <PageBody /> : null}
          </div>
        </div>
      </HybridFrame>
    </div>
  );
}
