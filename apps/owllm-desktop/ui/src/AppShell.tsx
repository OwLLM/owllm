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
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ALL_MODULES,
  ADVANCED,
  CORE,
  getInstalledModes,
  ModeId,
  PageDef,
} from "./core/modules";
import { ACCENTS, AccentKey, Mode, useTheme } from "./theme";
import TelegramBridgeRunner from "./bridges/TelegramBridgeRunner";
import ServerPage from "./pages/core/ServerPage";

// tauri.conf.json now sets decorations:false again — the OS title
// bar is completely hidden so the desktop shows through the cyan
// HybridFrame corners cleanly. That means we own drag, resize, and
// min/max/close ourselves.

/// True when the page is loaded inside the actual Tauri webview
/// (i.e. has __TAURI_INTERNALS__ injected). In plain Chromium under
/// `vite dev` — including TwinForge's Playwright captures — every
/// `getCurrentWindow()` / `invoke()` call would throw synchronously
/// and crash the whole AppShell render. Callers gate on this.
function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as any;
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__ || w.__TAURI_METADATA__);
}

function startDrag(e: React.MouseEvent) {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement).closest("button, input, select, textarea, a")) return;
  if (!isTauri()) return; // dev / TwinForge: no native window to drag
  e.preventDefault();
  getCurrentWindow().startDragging().catch(() => { /* not in Tauri ctx */ });
}

type ResizeDir =
  | "North" | "South" | "East" | "West"
  | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";

function ResizeEdges() {
  if (!isTauri()) return null; // no native resize in vite dev / Playwright
  const start = (dir: ResizeDir) => (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (getCurrentWindow() as any).startResizeDragging(dir).catch?.(() => {});
  };
  const T = 6;
  const C = 14;
  const base: React.CSSProperties = { position: "fixed", zIndex: 10000, background: "transparent" };
  return (
    <>
      <div onMouseDown={start("North")}      style={{ ...base, top: 0, left: C, right: C, height: T, cursor: "ns-resize" }} />
      <div onMouseDown={start("South")}      style={{ ...base, bottom: 0, left: C, right: C, height: T, cursor: "ns-resize" }} />
      <div onMouseDown={start("West")}       style={{ ...base, left: 0, top: C, bottom: C, width: T, cursor: "ew-resize" }} />
      <div onMouseDown={start("East")}       style={{ ...base, right: 0, top: C, bottom: C, width: T, cursor: "ew-resize" }} />
      <div onMouseDown={start("NorthWest")}  style={{ ...base, top: 0, left: 0,  width: C, height: C, cursor: "nwse-resize" }} />
      <div onMouseDown={start("NorthEast")}  style={{ ...base, top: 0, right: 0, width: C, height: C, cursor: "nesw-resize" }} />
      <div onMouseDown={start("SouthWest")}  style={{ ...base, bottom: 0, left: 0,  width: C, height: C, cursor: "nesw-resize" }} />
      <div onMouseDown={start("SouthEast")}  style={{ ...base, bottom: 0, right: 0, width: C, height: C, cursor: "nwse-resize" }} />
    </>
  );
}

function WindowControls() {
  // Qt main.py:3349-3387 — the header-right cluster is just two
  // chromeless 30x30 buttons: fullscreen ⛶ (white, 20pt) and close
  // ❌ (red #f44336, 16pt) with transparent backgrounds and a 4px
  // hover tint. We previously rendered 3 buttons (—/▢/✕) with a
  // grey pill style, which didn't match the Qt source the VLM was
  // comparing against. Port the two glyphs and the transparent
  // styling verbatim.
  //
  // !isTauri(): plain Chromium has no getCurrentWindow() — calling it
  // would throw and tank the whole AppShell render. We still need to
  // emit the visual chrome though, otherwise TwinForge's vite-dev
  // captures will keep flagging "missing right-edge glyphs" against
  // the Tauri source. Render the same two glyphs with no handlers so
  // captures match exactly while dev mode stays click-safe.
  const tauri = isTauri();
  const w = tauri ? getCurrentWindow() : null;
  const fsBtn: React.CSSProperties = {
    width: 30, height: 30, border: "none",
    background: "transparent", color: "#ffffff",
    fontSize: 20, fontWeight: 700, padding: 0,
    cursor: tauri ? "pointer" : "default", userSelect: "none",
    display: "flex", alignItems: "center", justifyContent: "center",
    borderRadius: 4,
  };
  const closeBtn: React.CSSProperties = {
    ...fsBtn,
    color: "#f44336",
    fontSize: 16,
  };
  return (
    <div data-ui="HeaderWindowControls" style={{ display: "flex", gap: 6, marginLeft: 8 }}>
      <button
        data-ui="FullscreenBtn"
        title={tauri ? "Toggle fullscreen" : undefined}
        style={fsBtn}
        onClick={tauri ? () => { (w as any).setFullscreen?.(true).catch?.(() => {}); } : undefined}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.20)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
      >⛶</button>
      <button
        data-ui="HeaderCloseBtn"
        title={tauri ? "Close" : undefined}
        style={closeBtn}
        onClick={tauri ? () => w!.close() : undefined}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(244,67,54,0.20)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
      >❌</button>
    </div>
  );
}

// Live state shown in the header SysInfoBlock — polled every 2s
// from the same Rust commands the ServerPage uses, so the two views
// can't disagree.
type ServerStatusLite = {
  running: boolean;
  model_id: string | null;
  port: number | null;
  message: string;
};
type VramGpu = { index: number; used_mib: number; total_mib: number };
type VramStatusLite = { gpus: VramGpu[] };
function useLiveSysInfo() {
  const [server, setServer] = useState<ServerStatusLite>({
    running: false, model_id: null, port: null, message: "",
  });
  const [vram, setVram] = useState<VramStatusLite>({ gpus: [] });
  useEffect(() => {
    if (!isTauri()) return; // no invoke() in vite dev / Playwright
    let dead = false;
    const tick = async () => {
      try {
        const [s, v] = await Promise.all([
          invoke<ServerStatusLite>("server_status"),
          invoke<VramStatusLite>("vram_status"),
        ]);
        if (!dead) { setServer(s); setVram(v); }
      } catch { /* keep last good values */ }
    };
    tick();
    const id = window.setInterval(tick, 2000);
    return () => { dead = true; window.clearInterval(id); };
  }, []);
  return { server, vram };
}

// Track the live viewport so HybridFrame fills the window instead
// of being clipped to a fixed 1600x960 box. On display scaling /
// resize, the fluid math keeps the inner content sized correctly.
function useViewportSize() {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
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
// EXTRA_TOP bumps the top padding from the 19 px baseline (SHIFT_OUT
// + CORNER_OUTSET) up to 54 px total — leaving 35 px of extra
// breathing room above the HybridFrame for the peeking owl badge.
// Do not raise this to match Qt's badge_h/2 (97 px) — that adds
// visible empty chrome above the header that the user does not want
// on the Tauri build. EXTRA_RIGHT stays 0 so right padding is symmetric.
const EXTRA_TOP = 35;
const EXTRA_RIGHT = 0;
// EXTRA_BOTTOM reserves 11 px of clearance below outerB so the
// bottom-corner PNGs (height ≈ CORNER_PNG_H_BR=153, offset by
// CORNER_OUTSET+1) fit inside the viewport instead of poking 1 px
// past it. Without this, the bottom cyan strip reads thinner/dimmer
// than the source because the corner crest art is clipped flush
// against the window edge.
const EXTRA_BOTTOM = 11;
const CORNER_PNG_W = 160;
const CORNER_PNG_H_TL = Math.round(CORNER_PNG_W * 513 / 486);
const CORNER_PNG_H_TR = Math.round(CORNER_PNG_W * 484 / 516);
const CORNER_PNG_H_BL = Math.round(CORNER_PNG_W * 512 / 488);
const CORNER_PNG_H_BR = Math.round(CORNER_PNG_W * 488 / 512);
const PARENT_X = SHIFT_OUT + CORNER_OUTSET;
const PARENT_Y = EXTRA_TOP + SHIFT_OUT + CORNER_OUTSET;
// The cyan glass frame stays the same in both modes — it reads as
// app chrome rather than content. The inner content background
// switches via var(--bg-panel) so dark/light affects what's inside
// the frame.
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
  const parent_h = Math.max(MIN_PARENT_H, outerH - EXTRA_TOP - EXTRA_BOTTOM - 2 * SHIFT_OUT - 2 * CORNER_OUTSET);
  const parent_x = PARENT_X;
  const parent_y = PARENT_Y;
  const t = BORDER_T;
  const so = SHIFT_OUT;
  const outerL = parent_x - so;
  const outerT = parent_y - so;
  // Outer cyan rect spans symmetrically around the content panel.
  // Old code added `+ t / 2` here (and to innerW below), pushing the
  // right edge 9 px beyond the symmetric layout — that's why the
  // right padding rendered ~1 px while the other three sides were
  // ~10 px. With this off, all four outer edges are 10 px from the
  // window edge.
  const outerW2 = parent_w + 2 * so;
  const outerH2 = parent_h + 2 * so;
  const outerR = outerL + outerW2;
  const outerB = outerT + outerH2;
  const innerL = parent_x - so + t;
  const innerT = parent_y - so + t;
  // Same asymmetric `+ t / 2` was here — drop it so the inner accent
  // rect is centered like the outer one.
  const innerW = parent_w + 2 * so - 2 * t;
  const innerH = parent_h + 2 * so - 2 * t;
  // All four cyan bars are now centered on the content rectangle's
  // edges. leftBar straddles x=parent_x (so half-in, half-out by t/2),
  // and rightBar mirrors it around parent_x+parent_w. Previously the
  // right bar started AT parent_x+parent_w and extended outward by
  // the full t — pushing it ~9 px further right than the left bar
  // was left, which compounded the outerW2 asymmetry.
  const topBar   = { x: parent_x - so, y: parent_y - so, w: parent_w + 2 * so, h: t };
  const botBar   = { x: parent_x - so, y: parent_y + parent_h - t / 2, w: parent_w + 2 * so, h: t };
  const leftBar  = { x: parent_x - so, y: parent_y - so, w: t, h: parent_h + 2 * so };
  const rightBar = { x: parent_x + parent_w - so, y: parent_y - so, w: t, h: parent_h + 2 * so };
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
  // Original geometry: badge straddles the top frame line, half
  // peeking out into the EXTRA_TOP headroom, half overlapping the
  // ModeBar inside the inner content.
  const badgeY = parent_y - BADGE_H / 2;
  return (
    <div style={{ position:"relative", width:outerW, height:outerH, background:"transparent" }}>
      <div style={{ position:"absolute", left:parent_x, top:parent_y, width:parent_w, height:parent_h, background:"var(--bg-panel)", overflow:"hidden" }}>{children}</div>
      <div style={{ position:"absolute", left:topBar.x,   top:topBar.y,   width:topBar.w,   height:topBar.h,   background:FRAME_BG }} />
      <div style={{ position:"absolute", left:botBar.x,   top:botBar.y,   width:botBar.w,   height:botBar.h,   background:FRAME_BG }} />
      <div style={{ position:"absolute", left:leftBar.x,  top:leftBar.y,  width:leftBar.w,  height:leftBar.h,  background:FRAME_BG }} />
      <div style={{ position:"absolute", left:rightBar.x, top:rightBar.y, width:rightBar.w, height:rightBar.h, background:FRAME_BG }} />
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
  themeMode, onToggleThemeMode, accentKey, onPickAccent, onOpenServer,
}: {
  mode: ActiveMode;
  setMode: (m: ActiveMode) => void;
  advancedOpen: boolean;
  setAdvancedOpen: (v: boolean) => void;
  installed: ModeId[];
  themeMode: Mode;
  onToggleThemeMode: () => void;
  accentKey: AccentKey;
  onPickAccent: (k: AccentKey) => void;
  onOpenServer: () => void;
}) {
  // The header is always the dark blue band so the cyan frame +
  // OWLLM title read consistently across themes. Buttons therefore
  // stay light-on-dark regardless of mode — we don't drive their
  // colours from the theme.
  const baseBtn: React.CSSProperties = {
    height: 50, padding: "0 14px",
    background: "linear-gradient(180deg, rgba(60,60,80,0.85), rgba(40,40,60,0.85))",
    color: "#fff",
    border: "1px solid rgba(255,255,255,0.20)",
    borderRadius: 6, fontSize: 13, fontWeight: 700,
    display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center",
    lineHeight: 1.05, gap: 0,
    cursor: "pointer", userSelect: "none",
  };
  // Qt :checked QPushButton — gold border + warm dark gradient.
  // (main.py:3137-3141 style applied to the group toggles.)
  const active: React.CSSProperties = {
    ...baseBtn,
    border: "1px solid #ffd080",
    background: "linear-gradient(180deg, rgba(80,70,50,0.85), rgba(60,50,30,0.85))",
  };

  // Filter the three mode toggles to only those installed.
  // ActiveMode excludes "home" / "core" / "advanced" — only the three
  // group toggles. Each id is also a valid ModeId so `installed`
  // (ModeId[]) can include() them; narrow with a typed cast.
  type ToggleId = Exclude<ActiveMode, "home">;
  // dataUi values must match the Qt `setObjectName` calls verbatim so
  // TwinForge's region-diff aligns these toggles instead of leaving
  // them in the "unmatched" bucket. Qt: FineTuningToggle / AgenticTeamToggle
  // / GamifyToggle (main.py:3191-3200).
  type ToggleSpec = { id: ToggleId; dataUi: string; emoji: string; label: string; width: number };
  const TOGGLES: ToggleSpec[] = [
    { id: "finetuning", dataUi: "FineTuningToggle",  emoji: "🛠",  label: "Fine Tuning", width: 129 },
    { id: "agentic",    dataUi: "AgenticTeamToggle", emoji: "🎭", label: "Agentic Team", width: 147 },
    { id: "gamify",     dataUi: "GamifyToggle",      emoji: "🎮", label: "Gamify",       width: 91  },
  ];
  const visibleToggles = TOGGLES.filter(t => installed.includes(t.id as ModeId));

  return (
    <div data-ui="AppHeader" onMouseDown={startDrag} style={{
      position: "relative",
      height: 80,
      display: "grid", gridTemplateColumns: "auto 1fr auto auto",
      alignItems: "center", padding: "10px 18px 10px 20px", gap: 16,
      background: "#1c2244",
      cursor: "default",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {/* Dark/Light toggle. Persists via theme.ts. */}
        <button
          data-ui="DarkModeBtn"
          onClick={onToggleThemeMode}
          title={themeMode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          style={{
            width: 70, height: 50, borderRadius: 6,
            background: "linear-gradient(180deg, rgba(60,60,80,0.8), rgba(40,40,60,0.8))",
            border: "1px solid rgba(255,255,255,0.20)",
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", lineHeight: 1.0,
            cursor: "pointer", padding: 0,
          }}
        >
          <div style={{ fontSize: 29, color: "#fff" }}>{themeMode === "dark" ? "🌙" : "☀"}</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>
            {themeMode === "dark" ? "Dark" : "Light"}
          </div>
        </button>
        {/* Six accent-colour squares. Active square gets a white ring. */}
        <div data-ui="ColorSelector" style={{
          width: 70, height: 50, padding: 4,
          display: "grid", gridTemplateColumns: "repeat(3, 18px)", gridTemplateRows: "repeat(2, 18px)",
          gap: 3, background: "rgba(60,60,80,0.4)", borderRadius: 6,
        }}>
          {ACCENTS.map(a => {
            const selected = a.key === accentKey;
            return (
              <button
                key={a.key}
                onClick={() => onPickAccent(a.key)}
                title={a.label}
                style={{
                  width: 18, height: 18, borderRadius: 3,
                  background: a.color,
                  border: selected ? "2px solid #fff" : "1px solid rgba(255,255,255,0.15)",
                  boxShadow: selected ? `0 0 0 1px ${a.color}, 0 0 6px ${a.color}` : "none",
                  padding: 0,
                  cursor: "pointer",
                  transition: "transform 0.08s",
                  transform: selected ? "scale(1.08)" : "scale(1)",
                }}
              />
            );
          })}
        </div>

        {/* Advanced toggle — independent. Reveals advanced pages. */}
        <button
          data-ui="AdvancedToggle"
          onClick={() => setAdvancedOpen(!advancedOpen)}
          style={{ ...(advancedOpen ? active : baseBtn), width: 114 }}
        >
          <span style={{ fontSize: 14 }}>⚙</span>
          <span>Advanced</span>
        </button>

        {/* Mode toggles — single-active. Click toggles back to "home" if
            the same mode is clicked twice. Hidden when the mode isn't
            installed (per getInstalledModes() in modules.ts). */}
        {visibleToggles.map(t => (
          <button
            key={t.id}
            data-ui={t.dataUi}
            onClick={() => setMode(mode === t.id ? "home" : t.id)}
            style={{ ...(mode === t.id ? active : baseBtn), width: t.width }}
          >
            <span style={{ fontSize: 14 }}>{t.emoji}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* Spacer for the grid column so the layout still flows; the
          actual OWLLM title is position:absolute centered against the
          ModeBar so the left button cluster width doesn't push it
          off-axis. */}
      <div />

      {/* OWLLM title — absolutely positioned to the window centre.
          Pointer events disabled so it doesn't intercept drag clicks. */}
      <div
        data-ui="AppTitle"
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
          width: 200,
          height: 54,
          fontSize: 35, fontWeight: 700, color: "#fff",
          letterSpacing: 2, lineHeight: "54px",
          textAlign: "center",
          pointerEvents: "none",
        }}
      >OWLLM</div>

      <SysInfoBlock onOpenServer={onOpenServer} />
      <WindowControls />
    </div>
  );
}

// Header right-block — live status. Replaces the hardcoded Qt
// mock-up that pretended a "Quagenmed-K4" server was always
// running and VRAM was "N/A".
// Clicking the block opens the Server modal (same trigger as the
// "Server" tab) so the user can spin a model up/down from anywhere.
function SysInfoBlock({ onOpenServer }: { onOpenServer: () => void }) {
  const { server, vram } = useLiveSysInfo();
  // Mirrors Qt main.py:28564/28573 — pluralised "Servers", count-based.
  // Stopped → "🟢 Servers: 0"; running → "🟢 Servers: N (modelSummary)".
  // ServerStatusLite carries only one server, so N is 0 or 1.
  const serverLine = server.running
    ? `🟢 Servers: 1 (${server.model_id ?? "?"})`
    : "🟢 Servers: 0";
  const vramLine = vram.gpus.length === 0
    ? "VRAM: N/A"
    : vram.gpus
        .map(g => `GPU${g.index}: ${(g.used_mib / 1024).toFixed(1)} / ${(g.total_mib / 1024).toFixed(1)} GiB`)
        .join("   ");
  // API key label echoes the local-only convention from the Qt app
  // (server_page.py:1093). Real per-user keys land alongside the
  // Accounts page wiring.
  return (
    <div
      data-ui="SysInfoBlock"
      onClick={onOpenServer}
      title="Open Server Control"
      style={{
        maxWidth: 420, height: 60,
        display: "flex", flexDirection: "column",
        alignItems: "stretch", justifyContent: "center", gap: 3,
        fontSize: 12, fontWeight: 700, color: "#fff", textAlign: "right",
        // Trimmed from the Qt-port's hard 543px to free room for the
        // inline WindowControls 4th grid column. overflow:hidden +
        // text-overflow on the children below keeps long model ids
        // from pushing the layout.
        overflow: "hidden",
        cursor: "pointer",
      }}
    >
      <div data-ui="HeaderServersLabel">
        {serverLine}
      </div>
      <div data-ui="HeaderApiKeyLabel">
        <span style={{ marginRight: 4 }}>🔑</span>
        API key: owllm-local
      </div>
      <div data-ui="HeaderVramLabel" title={server.message || undefined}>
        <span style={{ marginRight: 4 }}>💾</span>{vramLine}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// SubTabs — composed dynamically from the visible page list.
// ---------------------------------------------------------------------
// Page keys that should be right-aligned in the SubTabs row: Info
// (from CORE) plus everything contributed by ADVANCED. They're the
// "utility" pages, visually separated from the work surfaces by a
// flex spacer.
const RIGHT_ALIGNED_KEYS = new Set(["info", "mcp", "environment", "accounts", "logs"]);

function SubTabs({
  pages, activeKey, onChange,
}: {
  pages: PageDef[];
  activeKey: string;
  onChange: (key: string) => void;
}) {
  const renderTab = (p: PageDef) => {
    const active = p.key === activeKey;
    return (
      <div
        key={p.key}
        onClick={() => onChange(p.key)}
        style={{
          padding: "5px 14px",
          background: active ? "rgba(102,126,234,0.28)" : "transparent",
          color: active ? "#fafafa" : "var(--fg-muted)",
          borderRadius: 8,
          fontWeight: 600,
          borderBottom: active ? "3px solid var(--accent)" : "3px solid transparent",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        {p.label}
      </div>
    );
  };

  const leftTabs  = pages.filter(p => !RIGHT_ALIGNED_KEYS.has(p.key));
  const rightTabs = pages.filter(p =>  RIGHT_ALIGNED_KEYS.has(p.key));

  return (
    <div style={{
      height: 48, background: "var(--bg-card)",
      display: "flex", alignItems: "center",
      padding: "0 24px", gap: 6, fontSize: 15, color: "var(--fg)",
      borderBottom: "1px solid var(--border)",
    }}>
      {leftTabs.map(renderTab)}
      <div style={{ flex: 1 }} />
      {rightTabs.map(renderTab)}
    </div>
  );
}

// ---------------------------------------------------------------------
// ServerModal — popup wrapper around ServerPage. Replaces the old
// "Server" SubTab: same content, but in a centered modal styled like
// the app (cyan border, dark-blue title strip, panel body). Closes
// on backdrop click, Esc, or the ✕ button.
// ---------------------------------------------------------------------
function ServerModal({ onClose }: { onClose: () => void }) {
  // Esc to close — registered once on mount.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      data-ui="ServerModalBackdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 9000,
        background: "rgba(0,0,0,0.62)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        data-ui="ServerModal"
        style={{
          width: "92%", height: "88%",
          background: "var(--bg-panel)",
          // Same cyan accent the HybridFrame uses internally — keeps
          // the modal visually consistent with the app chrome without
          // duplicating corner PNGs etc.
          border: "2px solid rgba(120,220,255,0.78)",
          borderRadius: 14,
          boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
          display: "flex", flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Title strip — same #1c2244 the ModeBar uses for chrome parity. */}
        <div style={{
          height: 56,
          background: "#1c2244",
          color: "#fff",
          display: "flex", alignItems: "center",
          padding: "0 20px",
          borderBottom: "1px solid rgba(120,220,255,0.30)",
        }}>
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: 1 }}>
            🖧 Server Control
          </div>
          <div style={{ flex: 1 }} />
          <button
            data-ui="ServerModalClose"
            onClick={onClose}
            title="Close (Esc)"
            style={{
              width: 36, height: 28, border: "none",
              background: "rgba(244,67,54,0.18)",
              color: "#ff8080",
              fontSize: 13, cursor: "pointer",
              borderRadius: 5,
            }}
          >✕</button>
        </div>
        {/* Body — full ServerPage, scrolls on its own. */}
        <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
          <ServerPage />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// AppShell — top-level state machine.
// ---------------------------------------------------------------------
// Deep-link helper — TwinForge points its web adapter at
// `http://localhost:5173/?page=train` (or models / chat / agents) so it
// can compare specific pages against the Qt original without simulating
// clicks. Reads window.location.search once on mount; doesn't watch for
// changes (the loop driver always opens a fresh tab per compare).
function readPageFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const sp = new URLSearchParams(window.location.search);
  const p = sp.get("page");
  return p && p.trim() ? p.trim().toLowerCase() : null;
}

// Map a deep-link page key to (mode, activeTab). Returns null when the
// key isn't recognised so AppShell falls back to the home default.
function resolveDeepLink(key: string): { mode: ActiveMode; activeKey: string } | null {
  for (const m of ALL_MODULES) {
    const hit = m.pages.find(p => p.key === key);
    if (!hit) continue;
    if (m.id === "core") return { mode: "home", activeKey: key };
    if (m.id === "finetuning" || m.id === "agentic" || m.id === "gamify") {
      return { mode: m.id, activeKey: key };
    }
    if (m.id === "advanced") return { mode: "home", activeKey: key }; // caller flips advancedOpen
  }
  return null;
}

export default function AppShell() {
  const installed = useMemo(() => getInstalledModes(), []);
  // Resolve the URL's ?page= once on mount so TwinForge can deep-link
  // straight to the page it wants to diff (e.g. ?page=train).
  const initialDeep = useMemo(() => {
    const k = readPageFromUrl();
    return k ? resolveDeepLink(k) : null;
  }, []);
  const initialAdvanced = useMemo(() => {
    const k = readPageFromUrl();
    if (!k) return false;
    return ADVANCED.pages.some(p => p.key === k);
  }, []);
  const [mode, setMode] = useState<ActiveMode>(initialDeep?.mode ?? "home");
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(initialAdvanced);
  const [serverModalOpen, setServerModalOpen] = useState<boolean>(false);
  const theme = useTheme();

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
  const [activeKey, setActiveKey] = useState<string>(
    () => initialDeep?.activeKey ?? defaultKeyForMode("home"),
  );

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

  // Cross-page navigation hook. StudioPage etc. dispatch
  // `new CustomEvent('owllm:navigate', { detail: { key } })` to jump
  // between tabs (e.g. "+ New project from <team>" → Agents). We also
  // flip the mode toggle when the target page belongs to one.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ key?: string }>).detail;
      const key = detail?.key;
      if (typeof key !== "string") return;
      // "server" is now a modal — intercept here so external nav
      // requests open the popup instead of trying to switch to a
      // (no-longer-rendered-inline) tab.
      if (key === "server") { setServerModalOpen(true); return; }
      // Find which module owns this page key so we can light up the
      // matching ModeBar toggle alongside the SubTabs row.
      for (const m of ALL_MODULES) {
        if (m.pages.some(p => p.key === key) && m.id !== "core") {
          if (m.id === "advanced") setAdvancedOpen(true);
          else if (m.id === "finetuning" || m.id === "agentic" || m.id === "gamify") setMode(m.id);
          break;
        }
      }
      setActiveKey(key);
    };
    window.addEventListener("owllm:navigate", handler as EventListener);
    return () => window.removeEventListener("owllm:navigate", handler as EventListener);
  }, []);

  // SubTabs nav — intercept "server" so clicking the tab opens the
  // popup instead of switching the inline page (the tab is kept in
  // SubTabs as a visible affordance; we just override the action).
  const handleTabChange = (key: string) => {
    if (key === "server") { setServerModalOpen(true); return; }
    setActiveKey(key);
  };

  // Resolve the active page's component.
  const activePage = visiblePages.find(p => p.key === activeKey)
                  ?? visiblePages[0];
  const PageBody = activePage?.component;

  const vp = useViewportSize();

  return (
    <>
      <TelegramBridgeRunner />
      <ResizeEdges />
      <HybridFrame outerW={vp.w} outerH={vp.h}>
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <ModeBar
            mode={mode}
            setMode={handleSetMode}
            advancedOpen={advancedOpen}
            setAdvancedOpen={handleSetAdvanced}
            installed={installed}
            themeMode={theme.mode}
            onToggleThemeMode={theme.toggleMode}
            accentKey={theme.accentKey}
            onPickAccent={theme.setAccentKey}
            onOpenServer={() => setServerModalOpen(true)}
          />
          {/* SubTabs always render — Qt's page list is unconditional.
              The earlier `mode !== 'finetuning'` guard hid the row when
              Fine Tuning was active, which made the Train capture look
              like it was missing the nav strip. */}
          <SubTabs
            pages={visiblePages}
            activeKey={activeKey}
            onChange={handleTabChange}
          />
          {/* TODO(finding[3]): Train/Models/Agents workspace controls
              (Team / + New / Rename / Delete) are not in AppShell — they
              live inside the per-page bodies (or are missing entirely).
              Locate the Qt source for these affordances (search main.py
              for 'Rename' / '+ New' / 'workspace') and fix in the owning
              page file (e.g. TrainPage.tsx), not here in AppShell. */}
          <div style={{ flex: 1, overflow: "hidden", minHeight: 0 }}>
            {PageBody ? <PageBody /> : null}
          </div>
        </div>
      </HybridFrame>
      {serverModalOpen && <ServerModal onClose={() => setServerModalOpen(false)} />}
    </>
  );
}
