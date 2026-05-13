// AppShell — the persistent chrome wrapping every page: HybridFrame
// (corners + badge), the top ModeBar, and the SubTabs nav. Owns
// active-tab state; renders the matching page in the body.
//
// Pages are intentionally framework-light: each one is just a React
// component that returns the body content (LocationRow + workspace
// for Agents, the server controls for Server, etc.). The frame +
// header + tabs come from here.
import React, { useState } from "react";
import AgentsPage from "./pages/AgentsPage";
import AccountsPage from "./pages/AccountsPage";
import BridgesPage from "./pages/BridgesPage";
import CodePage from "./pages/CodePage";
import HomePage from "./pages/HomePage";
import MCPPage from "./pages/MCPPage";
import ServerPage from "./pages/ServerPage";
import StubPage from "./pages/StubPage";
import StudioPage from "./pages/StudioPage";

const INNER_W = 1600, INNER_H = 960;

// Tab order + display labels mirror the PySide6 nav: 🏠 Home,
// 🖥 Server, 🔌 Bridges, 🎭 Agents, 🛠 Studio, 💻 Code, 🔐 Accounts,
// 🔧 MCP. The key is what we route on internally; the label is what
// renders in SubTabs.
type TabKey =
  | "home" | "server" | "bridges" | "agents"
  | "studio" | "code" | "accounts" | "mcp";

const TABS: { key: TabKey; label: string }[] = [
  { key: "home",     label: "🏠 Home" },
  { key: "server",   label: "🖥 Server" },
  { key: "bridges",  label: "🔌 Bridges" },
  { key: "agents",   label: "🎭 Agents" },
  { key: "studio",   label: "🛠 Studio" },
  { key: "code",     label: "💻 Code" },
  { key: "accounts", label: "🔐 Accounts" },
  { key: "mcp",      label: "🔧 MCP" },
];

const ICONS = "/Page_icons";
const CORNERS = `${ICONS}/CornersNew`;

// ---------------------------------------------------------------------
// HybridFrame — faithful port of
// LLM/ui_frame/hybrid_frame/hybrid_frame_window.py::paintEvent.
//
// Geometry constants mirror the Qt source 1:1. Do NOT change without
// reading paintEvent there side-by-side. The previous React version
// (96px corners, 58px badge, cyan gradient bars only) was a sketch —
// this is the real thing: 160px corner PNGs, 300x195 owl badge,
// dark-filled border bars + cyan outer/inner rounded outlines +
// corner brackets + edge ticks.
// ---------------------------------------------------------------------
const BADGE_W = 300;
const BADGE_H = 195;                          // = BADGE_W * 0.65
const BORDER_T = 18;                          // border_thickness
const CORNER_OUTSET = 10;                     // CORNER_OUTSET
const SHIFT_OUT = BORDER_T / 2;               // shift_out = t//2 = 9
const EXTRA_TOP = BADGE_H / 2;                // 97.5
const EXTRA_RIGHT = 75;                       // extra_right
const CORNER_PNG_W = 160;                     // corner_width (visible draw size)
// Per-corner heights — Qt's get_corner_height(pixmap) computes a unique
// height for each pixmap from its own aspect ratio, so each owl PNG
// renders without vertical squish/stretch. Hard-coding one height
// for all four corners (the previous behaviour) vertically stretched
// corner_br.png (512x488 → wide) and corner_ur.png by ~7%, which
// reads in the VLM diff as a dimmer / less-defined bottom-right owl.
// Source dimensions verified on disk 2026-05-13:
//   corner_ul.png 486x513, corner_ur.png 516x484,
//   corner_bl.png 488x512, corner_br.png 512x488.
const CORNER_PNG_H_TL = Math.round(CORNER_PNG_W * 513 / 486); // 169
const CORNER_PNG_H_TR = Math.round(CORNER_PNG_W * 484 / 516); // 150
const CORNER_PNG_H_BL = Math.round(CORNER_PNG_W * 512 / 488); // 168
const CORNER_PNG_H_BR = Math.round(CORNER_PNG_W * 488 / 512); // 152

// Position of the parent (inner content) rect inside the outer overlay.
const PARENT_X = SHIFT_OUT + CORNER_OUTSET;                  // 19
const PARENT_Y = EXTRA_TOP + SHIFT_OUT + CORNER_OUTSET;      // 116.5

// Colours — Qt's QColor(primary).setAlpha(220) / accent.setAlpha(200)
// rendered as teal/cyan in the source screenshot; lifted from the PNG.
// frame_bg is QColor(primary).darker(300) — very dark navy.
const FRAME_COLOR  = "rgba(200, 240, 255, 0.86)"; // outer outline
const FRAME_ACCENT = "rgba(120, 220, 255, 0.78)"; // inner outline + brackets + ticks
const FRAME_BG     = "rgba(8, 12, 24, 0.95)";     // border bar fill

function HybridFrame({ children, width, height }: {
  children: React.ReactNode; width: number; height: number;
}) {
  // parent_w / parent_h are the dimensions of the inner content area
  // (matches the Qt MainWindow's own rect inside the overlay).
  const parent_w = width;
  const parent_h = height;
  const parent_x = PARENT_X;
  const parent_y = PARENT_Y;
  const t = BORDER_T;
  const so = SHIFT_OUT;

  // Outer overlay total size (mirrors eventFilter's Resize handler).
  const outerW = parent_w + EXTRA_RIGHT + 2 * so + 2 * CORNER_OUTSET;
  const outerH = parent_h + EXTRA_TOP + 2 * so + 2 * CORNER_OUTSET;

  // Outer rounded-rect bounds (port of `outer = QRect(...)` in paintEvent).
  const outerL = parent_x - so;
  const outerT = parent_y - so;
  const outerW2 = parent_w + 2 * so + t / 2;      // matches Qt's +t//2 quirk
  const outerH2 = parent_h + 2 * so;
  const outerR = outerL + outerW2;
  const outerB = outerT + outerH2;

  // Inner rounded-rect bounds (port of `inner = QRect(...)`).
  const innerL = parent_x - so + t;
  const innerT = parent_y - so + t;
  const innerW = parent_w + 2 * so - 2 * t + t / 2;
  const innerH = parent_h + 2 * so - 2 * t;

  // Border bar fills (port of the four p.fillRect calls). They straddle
  // the parent edge by ±so on each side, thickness t.
  const topBar    = { x: parent_x - so, y: parent_y - so,            w: parent_w + 2 * so, h: t };
  const botBar    = { x: parent_x - so, y: parent_y + parent_h - t / 2, w: parent_w + 2 * so, h: t };
  const leftBar   = { x: parent_x - so, y: parent_y - so,            w: t, h: parent_h + 2 * so };
  const rightBar  = { x: parent_x + parent_w, y: parent_y - so,      w: t, h: parent_h + 2 * so };

  // Corner brackets — L-shapes inset 14px from the outer rect, 36px long.
  const brkL = 36, brkI = 14;
  const bxL = outerL + brkI, bxR = outerR - brkI;
  const byT = outerT + brkI, byB = outerB - brkI;

  // Edge ticks — short 18px marks at midpoints of each edge, inset 10px.
  const tckL = 18, tckI = 10;
  const midx = (outerL + outerR) / 2;
  const midy = (outerT + outerB) / 2;

  // Corner PNG rects (port of corner_tl/tr/bl/br QRects). Bottom corners
  // anchor to outerB using their own per-pixmap height — matches Qt's
  // `outer.bottom() - corner_bl_height + 1 + corner_outset`.
  const cnTL = { x: outerL - CORNER_OUTSET,                          y: outerT - CORNER_OUTSET };
  const cnTR = { x: outerR - CORNER_PNG_W + 1 + CORNER_OUTSET,       y: outerT - CORNER_OUTSET };
  const cnBL = { x: outerL - CORNER_OUTSET,                          y: outerB - CORNER_PNG_H_BL + 1 + CORNER_OUTSET };
  const cnBR = { x: outerR - CORNER_PNG_W + 1 + CORNER_OUTSET,       y: outerB - CORNER_PNG_H_BR + 1 + CORNER_OUTSET };

  // Top-centre owl badge — center horizontally on parent, place vertical
  // center at parent's top edge (so half above, half below).
  const badgeX = parent_x + (parent_w - BADGE_W) / 2;
  const badgeY = parent_y - BADGE_H / 2;

  return (
    <div style={{ position:"relative", width:outerW, height:outerH, background:"transparent" }}>
      {/* Inner content area (parent rect — the dark workspace fills this) */}
      <div style={{ position:"absolute", left:parent_x, top:parent_y, width:parent_w, height:parent_h, background:"#0e1117", overflow:"hidden" }}>
        {children}
      </div>

      {/* Dark filled border bars — straddle each parent edge by ±so */}
      <div style={{ position:"absolute", left:topBar.x,   top:topBar.y,   width:topBar.w,   height:topBar.h,   background:FRAME_BG }} />
      <div style={{ position:"absolute", left:botBar.x,   top:botBar.y,   width:botBar.w,   height:botBar.h,   background:FRAME_BG }} />
      <div style={{ position:"absolute", left:leftBar.x,  top:leftBar.y,  width:leftBar.w,  height:leftBar.h,  background:FRAME_BG }} />
      <div style={{ position:"absolute", left:rightBar.x, top:rightBar.y, width:rightBar.w, height:rightBar.h, background:FRAME_BG }} />

      {/* Outer + inner rounded-rect outlines, corner brackets, edge ticks */}
      <svg width={outerW} height={outerH} style={{ position:"absolute", left:0, top:0, pointerEvents:"none" }}>
        {/* Outer outline (frame_color, radius 14) — adjusted (1,1,-2,-2) */}
        <rect x={outerL + 1} y={outerT + 1} width={outerW2 - 2} height={outerH2 - 2} rx={14} ry={14}
              fill="none" stroke={FRAME_COLOR} strokeWidth={1} />
        {/* Inner outline (frame_accent, radius 10) */}
        <rect x={innerL} y={innerT} width={innerW} height={innerH} rx={10} ry={10}
              fill="none" stroke={FRAME_ACCENT} strokeWidth={1} />

        {/* Corner brackets — TL/TR/BL/BR L-shapes */}
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

        {/* Edge ticks — short marks at edge midpoints */}
        <g stroke={FRAME_ACCENT} strokeWidth={1}>
          <line x1={midx - tckL / 2} y1={outerT + tckI} x2={midx + tckL / 2} y2={outerT + tckI} />
          <line x1={midx - tckL / 2} y1={outerB - tckI} x2={midx + tckL / 2} y2={outerB - tckI} />
          <line x1={outerL + tckI}   y1={midy - tckL / 2} x2={outerL + tckI} y2={midy + tckL / 2} />
          <line x1={outerR - tckI}   y1={midy - tckL / 2} x2={outerR - tckI} y2={midy + tckL / 2} />
        </g>
      </svg>

      {/* Corner PNGs — drawn LAST so they sit on top of outlines/brackets.
          corner_br is just the static CornersNew/corner_br.png (Qt has a
          per-tab owl overlay too; not needed in the React port until we
          wire dynamic tabs). */}
      <img src={`${CORNERS}/corner_br.png`} style={{ position:"absolute", left:cnBR.x, top:cnBR.y, width:CORNER_PNG_W, height:CORNER_PNG_H_BR, pointerEvents:"none" }} />
      <img src={`${CORNERS}/corner_ul.png`} style={{ position:"absolute", left:cnTL.x, top:cnTL.y, width:CORNER_PNG_W, height:CORNER_PNG_H_TL, pointerEvents:"none" }} />
      <img src={`${CORNERS}/corner_ur.png`} style={{ position:"absolute", left:cnTR.x, top:cnTR.y, width:CORNER_PNG_W, height:CORNER_PNG_H_TR, pointerEvents:"none" }} />
      <img src={`${CORNERS}/corner_bl.png`} style={{ position:"absolute", left:cnBL.x, top:cnBL.y, width:CORNER_PNG_W, height:CORNER_PNG_H_BL, pointerEvents:"none" }} />

      {/* Top-centre owl badge — 300x195, center vertically at parent.top */}
      <img src={`${ICONS}/owl_studio_square.png`} style={{ position:"absolute", left:badgeX, top:badgeY, width:BADGE_W, height:BADGE_H, pointerEvents:"none" }} />
    </div>
  );
}

function ModeBar() {
  const buttonStyle: React.CSSProperties = { height:50, padding:"0 14px", background:"linear-gradient(180deg, rgba(60,60,80,0.8), rgba(40,40,60,0.8))", color:"#fff", border:"1px solid rgba(120,220,255,0.0)", borderRadius:6, fontSize:13, fontWeight:700, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", lineHeight:1.05, gap:2 };
  const activeButton: React.CSSProperties = { ...buttonStyle, border:"1px solid #ffd080", background:"linear-gradient(180deg, rgba(80,70,50,0.85), rgba(60,50,30,0.85))" };
  const colorBtn = (c: string): React.CSSProperties => ({ width:18, height:18, borderRadius:3, background:c, border:"none", padding:0 });
  return (
    <div data-ui="AppHeader" style={{ height:80, display:"grid", gridTemplateColumns:"auto 1fr auto", alignItems:"center", padding:"10px 50px 10px 20px", gap:16, background:"#1c2244" }}>
      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
        <div data-ui="DarkModeBtn" style={{ width:70, height:50, borderRadius:6, background:"linear-gradient(180deg, rgba(60,60,80,0.8), rgba(40,40,60,0.8))", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", lineHeight:1.0 }}>
          <div style={{ fontSize:22 }}>🌙</div>
          <div style={{ fontSize:11, fontWeight:700, color:"#fff" }}>Dark</div>
        </div>
        <div data-ui="ColorSelector" style={{ width:70, height:50, padding:4, display:"grid", gridTemplateColumns:"repeat(3, 18px)", gridTemplateRows:"repeat(2, 18px)", gap:3, background:"rgba(60,60,80,0.4)", borderRadius:6 }}>
          {["#667eea","#fbbf24","#ef4444","#3b82f6","#10b981","#6b7280"].map(c => <button key={c} style={colorBtn(c)} />)}
        </div>
        <button data-ui="AdvancedToggle" style={{...buttonStyle, width:114}}><span style={{fontSize:18}}>⚙</span><span>Advanced</span></button>
        <button data-ui="FineTuningToggle" style={{...buttonStyle, width:129}}><span style={{fontSize:18}}>🛠</span><span>Fine Tuning</span></button>
        <button data-ui="AgenticTeamToggle" style={{...activeButton, width:147}}><span style={{fontSize:18}}>🎭</span><span>Agentic Team</span></button>
        <button data-ui="GamifyToggle" style={{...buttonStyle, width:91}}><span style={{fontSize:18}}>🎮</span><span>Gamify</span></button>
      </div>
      <div style={{ display:"flex", justifyContent:"center" }}>
        <div data-ui="AppTitle" style={{ textAlign:"center", width:128, height:45, fontSize:29, fontWeight:700, color:"#fff", letterSpacing:2, lineHeight:"45px" }}>OWLLM</div>
      </div>
      <div data-ui="SysInfoBlock" style={{ minWidth:543, width:543, height:60, display:"flex", flexDirection:"column", alignItems:"stretch", justifyContent:"center", gap:3, fontSize:12, fontWeight:700, color:"#fff", textAlign:"right" }}>
        <div data-ui="HeaderServersLabel"><span className="status-dot" style={{ background:"#22c55e", color:"#22c55e" }} />Servers: 1 [Quagenmed-K4] Abbreviated Q4_K_M GGUF…</div>
        <div data-ui="HeaderApiKeyLabel"><span className="status-dot" style={{ background:"#22c55e", color:"#22c55e" }} />API key: owllm-local</div>
        <div data-ui="HeaderVramLabel"><span style={{ marginRight:4 }}>💾</span>VRAM: 8.4 / 24.0 GB</div>
      </div>
    </div>
  );
}

function SubTabs({ activeTab, onChange }: {
  activeTab: TabKey; onChange: (k: TabKey) => void;
}) {
  return (
    <div style={{ height:76, background:"#1a1f2c", display:"flex", alignItems:"center", padding:"0 24px", gap:6, fontSize:13, color:"#dadcdf" }}>
      {TABS.map(t => {
        const active = t.key === activeTab;
        return (
          <div
            key={t.key}
            onClick={() => onChange(t.key)}
            style={{
              padding:"10px 16px",
              background:active?"rgba(120,220,255,0.20)":"transparent",
              color:active?"#7fdfff":"#9aa0a6",
              borderRadius:8,
              fontWeight:600,
              borderBottom:active?"2px solid #7fdfff":"2px solid transparent",
              cursor:"pointer",
              userSelect:"none",
            }}
          >
            {t.label}
          </div>
        );
      })}
      <div style={{ flex:1 }} />
      <div style={{ color:"#888", fontSize:11 }}>Product Studio Test ▾</div>
      <button className="ghost-btn">Team</button>
      <button className="ghost-btn">+ New</button>
      <button className="ghost-btn">Rename</button>
      <button className="ghost-btn">Delete</button>
    </div>
  );
}

export default function AppShell() {
  const [tab, setTab] = useState<TabKey>("agents");
  let body: React.ReactNode;
  switch (tab) {
    case "agents":   body = <AgentsPage />; break;
    case "server":   body = <ServerPage />; break;
    case "home":     body = <HomePage />; break;
    case "bridges":  body = <BridgesPage />; break;
    case "studio":   body = <StudioPage />; break;
    case "code":     body = <CodePage />; break;
    case "accounts": body = <AccountsPage />; break;
    case "mcp":      body = <MCPPage />; break;
  }
  return (
    <HybridFrame width={INNER_W} height={INNER_H}>
      <div style={{ display:"flex", flexDirection:"column", height:"100%" }}>
        <ModeBar />
        <SubTabs activeTab={tab} onChange={setTab} />
        <div style={{ flex:1, overflow:"auto" }}>
          {body}
        </div>
      </div>
    </HybridFrame>
  );
}
