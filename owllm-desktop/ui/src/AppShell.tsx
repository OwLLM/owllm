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
import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ALL_MODULES,
  ADVANCED,
  AGENTIC,
  CORE,
  getInstalledModes,
  ModeId,
  PageDef,
} from "./core/modules";
import { ACCENTS, AccentSelection, Mode, TextColorSelection, useTheme } from "./theme";
import { headerPill } from "./theme/styles";
import TelegramBridgeRunner from "./bridges/TelegramBridgeRunner";
import DiscordBridgeRunner from "./bridges/DiscordBridgeRunner";
import SlackBridgeRunner from "./bridges/SlackBridgeRunner";
import EmailBridgeRunner from "./bridges/EmailBridgeRunner";
import WebhookBridgeRunner from "./bridges/WebhookBridgeRunner";
import ServerPage from "./pages/core/ServerPage";
import { setLocalServerKey } from "./pages/agentic/inferenceEndpoint";
import BridgesPage from "./pages/agentic/BridgesPage";
import TutorialRecorder, { toggleTutorialRecorder } from "./tutorial/TutorialRecorder";
import ModuleWizard, { useNeedsFirstRunWizard } from "./pages/modules/ModuleWizard";
import AccountSyncModal, { openSyncOnboarding } from "./pages/core/AccountSyncModal";
import { githubStatus, GITHUB_CHANGED_EVENT } from "./pages/agentic/github";
import WatcherDrawer from "./support/WatcherDrawer";
import GenSpeedBadge from "./components/GenSpeedBadge";
import { installScopedSelectAll } from "./utils/scopedSelectAll";
import { bumpActivity } from "./support/activityStats";
import { APP_LANGUAGES, useLocalization } from "./localization";
import { readKeepFrameVisible, saveKeepFrameVisible } from "./framePreferences";
import { isRunActive, subscribeRunActivity } from "./runtime/runActivity";
import {
  CHAT_FONT_MIN_STEP, chatFontSizePx, clampChatFontStep,
  readChatFontStep, saveChatFontStep,
} from "./chatFontPreferences";
import ActionIcon from "./components/ActionIcon";

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

const FRAME_VISIBILITY_STATE_KEY = "owllm:window-frame:visibility";
const FRAME_IDLE_HIDE_MS = 1800;
const FRAME_LEAVE_HIDE_MS = 700;

function startDrag(e: React.MouseEvent) {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement).closest("button, input, select, textarea, a, [data-no-drag]")) return;
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
    background: "transparent", color: "var(--bg-header-fg)",
    fontSize: 20, fontWeight: 700, padding: 0,
    cursor: tauri ? "pointer" : "default", userSelect: "none",
    display: "flex", alignItems: "center", justifyContent: "center",
    borderRadius: 4,
  };
  // Close glyph stays neutral (same colour as minimize/maximize) and
  // only flushes red on hover — a permanently bright red ✕ read as an
  // alarm next to the muted siblings.
  const closeBtn: React.CSSProperties = {
    ...fsBtn,
    color: "var(--bg-header-fg)",
    fontSize: 16,
  };
  const tinyBtn: React.CSSProperties = { ...fsBtn, fontSize: 16 };
  return (
    <div data-ui="HeaderWindowControls" style={{ display: "flex", gap: 6, marginLeft: 8 }}>
      {/* ─ Minimize — standard "tuck away" button. Was missing on the
          chromeless build (Tauri 2 default decorations stripped them).
          Tray-hiding is a separate slice (would need a tray icon to
          restore); meanwhile minimize covers the user's expected
          'get this out of my way' action. */}
      <button
        data-ui="MinimizeBtn"
        title={tauri ? "Minimize" : undefined}
        style={tinyBtn}
        onClick={tauri ? async () => {
          try { await (w as any).minimize?.(); } catch { /* swallow */ }
        } : undefined}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.20)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
      >─</button>
      {/* ⛶ Maximize/restore — Tauri 2 toggleMaximize is the reliable
          path; setFullscreen() didn't survive across the chromeless
          window setup (user reported the button stopped working). */}
      <button
        data-ui="FullscreenBtn"
        title={tauri ? "Maximize / restore" : undefined}
        style={fsBtn}
        onClick={tauri ? async () => {
          try {
            const win = w as any;
            if (typeof win.toggleMaximize === "function") {
              await win.toggleMaximize();
            } else {
              const isMax = await win.isMaximized?.();
              if (isMax) await win.unmaximize?.();
              else await win.maximize?.();
            }
          } catch { /* swallow */ }
        } : undefined}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.20)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
      >⛶</button>
      <button
        data-ui="HeaderCloseBtn"
        title={tauri ? "Close" : undefined}
        style={closeBtn}
        onClick={tauri ? () => w!.close() : undefined}
        onMouseEnter={(e) => {
          const b = e.currentTarget as HTMLButtonElement;
          b.style.background = "rgba(244,67,54,0.85)";
          b.style.color = "#ffffff";
        }}
        onMouseLeave={(e) => {
          const b = e.currentTarget as HTMLButtonElement;
          b.style.background = "transparent";
          b.style.color = "var(--bg-header-fg)";
        }}
      >✕</button>
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

// Model ids commonly include the organisation, fine-tune recipe and quant.
// Keeping the tail is useful because it usually carries the quant, while a
// middle ellipsis prevents one unusually descriptive id from taking over the
// header. The full id remains available on hover in SysInfoBlock.
function abbreviateModelId(modelId: string, maxLength = 42): string {
  if (modelId.length <= maxLength) return modelId;
  const tailLength = Math.min(14, Math.floor((maxLength - 1) / 2));
  const headLength = maxLength - tailLength - 1;
  return `${modelId.slice(0, headLength)}…${modelId.slice(-tailLength)}`;
}

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
    // Mirror the local server's required api-key (set when the user EXPOSES the
    // server on the network — llama-server then enforces --api-key on 127.0.0.1
    // too) so local inference attaches it instead of 401-ing.
    invoke<{ enabled: boolean; apiKey: string }>("inference_expose_get")
      .then((c) => setLocalServerKey(c.enabled ? c.apiKey : ""))
      .catch(() => {});
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
// Bottom matches top padding behaviour — TwinForge had added 11 px
// here to keep corner PNGs from clipping flush, but the user reads
// the resulting band as "the bottom is longer now". Reverted to 0
// so L/R/B are symmetric against the SHIFT_OUT + CORNER_OUTSET base.
const EXTRA_BOTTOM = 0;
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
//
// FRAME_COLOR / FRAME_ACCENT pull from --accent so the cyan border
// follows the colour-picker squares in the header — pick amber and
// the whole frame turns amber, pick red and it turns red, etc. Was
// previously hardcoded `rgba(200, 240, 255, 0.86)` (cyan) regardless
// of accent. FRAME_BG (the fill behind the cyan bars at the four
// edges) is now also accent-driven via --bg-header — that's the
// heavily-tinted version of the dark navy chrome. Without this the
// 18 px frame band stayed identical navy no matter which colour the
// user picked, which is exactly what the user yelled about.
const FRAME_COLOR  = "rgba(var(--accent-rgb), 0.86)";
const FRAME_ACCENT = "rgba(var(--accent-rgb), 0.78)";
const FRAME_BG     = "var(--bg-header)";

const ICONS = "/Page_icons";
const CORNERS = `${ICONS}/CornersNew`;

// Shared by HybridFrame (the real full-window chrome) and
// MiniFrameReplica (the Settings "Keep frame" control) so the miniature
// is a true scaled copy of the live frame rather than a drifting sketch.
function computeFrameGeometry(outerW: number, outerH: number) {
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
  return {
    parent_x, parent_y, parent_w, parent_h,
    outerL, outerT, outerW2, outerH2, outerR, outerB,
    innerL, innerT, innerW, innerH,
    topBar, botBar, leftBar, rightBar,
    brkL, bxL, bxR, byT, byB,
    tckL, tckI, midx, midy,
    cnTL, cnTR, cnBL, cnBR,
    badgeX, badgeY,
  };
}

function HybridFrame({ children, outerW, outerH, showWatcherHint, frameVisible }: {
  children: React.ReactNode; outerW: number; outerH: number;
  /// Periodic "The Watcher" satellite label around the owl (until first open).
  showWatcherHint?: boolean;
  frameVisible: boolean;
}) {
  const {
    parent_x, parent_y, parent_w, parent_h,
    outerL, outerT, outerW2, outerH2, outerR, outerB,
    innerL, innerT, innerW, innerH,
    topBar, botBar, leftBar, rightBar,
    brkL, bxL, bxR, byT, byB,
    tckL, tckI, midx, midy,
    cnTL, cnTR, cnBL, cnBR,
    badgeX, badgeY,
  } = computeFrameGeometry(outerW, outerH);
  // The 18px fill bands give the neon frame a solid chrome backing on the
  // OPAQUE Windows/macOS window. On Linux the window is TRANSPARENT and the
  // bands straddle the panel edge (SHIFT_OUT px hang OUTSIDE the content into
  // the see-through margin), so FRAME_BG (var(--bg-header), opaque dark) paints
  // solid black bars over the desktop every time the frame reveals — that IS
  // the "becomes solid black sometimes" flash. Drop the fill on Linux so only
  // the neon strokes + corner art remain (the intended glass look); the bands
  // stay on opaque platforms where they read as chrome, not black.
  const bandBg = LINUX_TRANSPARENT_WINDOW ? "transparent" : FRAME_BG;
  return (
    <div data-ui="hybrid-frame-root" style={{ position:"relative", width:outerW, height:outerH, background:"transparent" }}>
      <div style={{ position:"absolute", left:parent_x, top:parent_y, width:parent_w, height:parent_h, background:"var(--bg-panel)", overflow:"hidden" }}>{children}</div>
      <div data-ui="DecorativeWindowFrame" style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        opacity: frameVisible ? 1 : 0,
        transition: `opacity ${frameVisible ? 220 : 360}ms ease`,
      }}>
        <div style={{ position:"absolute", left:topBar.x,   top:topBar.y,   width:topBar.w,   height:topBar.h,   background:bandBg }} />
        <div style={{ position:"absolute", left:botBar.x,   top:botBar.y,   width:botBar.w,   height:botBar.h,   background:bandBg }} />
        <div style={{ position:"absolute", left:leftBar.x,  top:leftBar.y,  width:leftBar.w,  height:leftBar.h,  background:bandBg }} />
        <div style={{ position:"absolute", left:rightBar.x, top:rightBar.y, width:rightBar.w, height:rightBar.h, background:bandBg }} />
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
      {/* The Watcher (P0-8): the owl art is DECORATIVE here, exactly like the
          overlay-window owl on Windows — its full 300×195 rect used to be
          clickable, which swallowed clicks over the header center ("the
          watcher clickable area is too large"). The summon point is the
          compact ModeBar hotspot beneath the owl's body in BOTH modes. */}
        <img
          src={`${ICONS}/owl_studio_square.png`}
          style={{
            position:"absolute", left:badgeX, top:badgeY, width:BADGE_W, height:BADGE_H,
            pointerEvents: "none",
          }}
        />
        {showWatcherHint && (
        <>
          <style>{`
            @keyframes owllm-watcher-orbit {
              0%   { opacity: 0; transform: translate(-18px, 6px) scale(0.92); }
              12%  { opacity: 1; transform: translate(0, 0) scale(1); }
              50%  { opacity: 1; transform: translate(10px, -4px) scale(1); }
              88%  { opacity: 1; transform: translate(20px, 2px) scale(1); }
              100% { opacity: 0; transform: translate(34px, 8px) scale(0.92); }
            }
          `}</style>
          <div style={{
            position:"absolute",
            left: badgeX + BADGE_W - 26,
            top: badgeY + Math.round(BADGE_H * 0.42),
            padding: "3px 10px", borderRadius: 999,
            background: "rgba(var(--accent-rgb),0.22)",
            border: "1px solid rgba(var(--accent-rgb),0.65)",
            color: "var(--fg-strong)", fontSize: 11.5, fontWeight: 800,
            letterSpacing: 0.4, whiteSpace: "nowrap",
            pointerEvents: "none",
            animation: "owllm-watcher-orbit 6s ease-in-out 1 both",
          }}>
            The Watcher
          </div>
        </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// MiniFrameReplica — the Settings "Keep frame" control: a miniature of
// the real HybridFrame drawn from the SAME computeFrameGeometry() at the
// app's reference 1600×960 window, scaled down through an SVG viewBox so
// proportions, bars, corner art, and the owl badge match the live frame.
// Children (the keep-visible checkbox + label) render inside the mini
// content panel, exactly where the real app content sits.
// ---------------------------------------------------------------------
const MINI_FRAME_REF_W = 1600;
const MINI_FRAME_REF_H = 960;

function MiniFrameReplica({ width, active, children }: {
  width: number;
  /// Mirrors the real frame's fade: chrome at full strength while the
  /// user keeps the frame visible, dimmed like the idle fade when not.
  active: boolean;
  children: React.ReactNode;
}) {
  const g = computeFrameGeometry(MINI_FRAME_REF_W, MINI_FRAME_REF_H);
  const height = Math.round(width * MINI_FRAME_REF_H / MINI_FRAME_REF_W);
  // viewBox-unit stroke that renders as a crisp 1px line at mini scale.
  const hairline = MINI_FRAME_REF_W / width;
  const px = (v: number) => `${(v / MINI_FRAME_REF_W) * 100}%`;
  const py = (v: number) => `${(v / MINI_FRAME_REF_H) * 100}%`;
  return (
    <span data-ui="MiniFrameReplica" style={{ position: "relative", width, height, display: "block", flex: "none" }}>
      <svg viewBox={`0 0 ${MINI_FRAME_REF_W} ${MINI_FRAME_REF_H}`} width={width} height={height} aria-hidden="true" style={{ position: "absolute", inset: 0, display: "block" }}>
        <rect x={g.parent_x} y={g.parent_y} width={g.parent_w} height={g.parent_h} fill="var(--bg-panel)" />
        <g opacity={active ? 1 : 0.3} style={{ transition: "opacity 220ms ease" }}>
          <rect x={g.topBar.x}   y={g.topBar.y}   width={g.topBar.w}   height={g.topBar.h}   fill={FRAME_BG} />
          <rect x={g.botBar.x}   y={g.botBar.y}   width={g.botBar.w}   height={g.botBar.h}   fill={FRAME_BG} />
          <rect x={g.leftBar.x}  y={g.leftBar.y}  width={g.leftBar.w}  height={g.leftBar.h}  fill={FRAME_BG} />
          <rect x={g.rightBar.x} y={g.rightBar.y} width={g.rightBar.w} height={g.rightBar.h} fill={FRAME_BG} />
          <rect x={g.outerL + 1} y={g.outerT + 1} width={g.outerW2 - 2} height={g.outerH2 - 2} rx={14} ry={14} fill="none" stroke={FRAME_COLOR} strokeWidth={hairline} />
          <rect x={g.innerL} y={g.innerT} width={g.innerW} height={g.innerH} rx={10} ry={10} fill="none" stroke={FRAME_ACCENT} strokeWidth={hairline} />
          <g stroke={FRAME_ACCENT} strokeWidth={hairline}>
            <line x1={g.bxL} y1={g.byT} x2={g.bxL + g.brkL} y2={g.byT} />
            <line x1={g.bxL} y1={g.byT} x2={g.bxL} y2={g.byT + g.brkL} />
            <line x1={g.bxR} y1={g.byT} x2={g.bxR - g.brkL} y2={g.byT} />
            <line x1={g.bxR} y1={g.byT} x2={g.bxR} y2={g.byT + g.brkL} />
            <line x1={g.bxL} y1={g.byB} x2={g.bxL + g.brkL} y2={g.byB} />
            <line x1={g.bxL} y1={g.byB} x2={g.bxL} y2={g.byB - g.brkL} />
            <line x1={g.bxR} y1={g.byB} x2={g.bxR - g.brkL} y2={g.byB} />
            <line x1={g.bxR} y1={g.byB} x2={g.bxR} y2={g.byB - g.brkL} />
          </g>
          <g stroke={FRAME_ACCENT} strokeWidth={hairline}>
            <line x1={g.midx - g.tckL / 2} y1={g.outerT + g.tckI} x2={g.midx + g.tckL / 2} y2={g.outerT + g.tckI} />
            <line x1={g.midx - g.tckL / 2} y1={g.outerB - g.tckI} x2={g.midx + g.tckL / 2} y2={g.outerB - g.tckI} />
            <line x1={g.outerL + g.tckI}   y1={g.midy - g.tckL / 2} x2={g.outerL + g.tckI} y2={g.midy + g.tckL / 2} />
            <line x1={g.outerR - g.tckI}   y1={g.midy - g.tckL / 2} x2={g.outerR - g.tckI} y2={g.midy + g.tckL / 2} />
          </g>
          <image href={`${CORNERS}/corner_ul.png`} x={g.cnTL.x} y={g.cnTL.y} width={CORNER_PNG_W} height={CORNER_PNG_H_TL} />
          <image href={`${CORNERS}/corner_ur.png`} x={g.cnTR.x} y={g.cnTR.y} width={CORNER_PNG_W} height={CORNER_PNG_H_TR} />
          <image href={`${CORNERS}/corner_bl.png`} x={g.cnBL.x} y={g.cnBL.y} width={CORNER_PNG_W} height={CORNER_PNG_H_BL} />
          <image href={`${CORNERS}/corner_br.png`} x={g.cnBR.x} y={g.cnBR.y} width={CORNER_PNG_W} height={CORNER_PNG_H_BR} />
          <image href={`${ICONS}/owl_studio_square.png`} x={g.badgeX} y={g.badgeY} width={BADGE_W} height={BADGE_H} />
        </g>
      </svg>
      <span style={{
        position: "absolute",
        left: px(g.parent_x), top: py(g.parent_y),
        width: px(g.parent_w), height: py(g.parent_h),
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2,
      }}>
        {children}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------
// ModeBar — top dark-blue header with theme controls, mode toggles,
// title, and SysInfo. Mode toggles drive the active mode state.
// ---------------------------------------------------------------------
type ActiveMode = "home" | "finetuning" | "agentic" | "gamify";

// True while ANY run is in flight anywhere in the app (team dispatch, code
// run, chat stream). Drives the header bars' "running" aura — the same
// rotating conic-gradient border the active agent tiles show.
function useRunActive(): boolean {
  return React.useSyncExternalStore(subscribeRunActivity, isRunActive);
}

// The header aura reuses the agent tiles' rainbow ring verbatim (same stops,
// same 4s linear spin) but anchors its start/end stop on the SELECTED GUI
// accent so the effect visibly carries the user's colour instead of a
// hardcoded green. Painted padding-box/border-box exactly like the tiles.
const HEADER_AURA_GRADIENT =
  `conic-gradient(from var(--owllm-aura-angle),`
  + ` var(--accent), #ffd93c, #ff9a3c, #ff5c8a, #b07cff, #7fd4ff, var(--accent))`;
const HEADER_AURA_ANIMATION = "owllm-aura-spin 4s linear infinite";

function ModeBar({
  mode, setMode, installed,
  themeMode, onToggleThemeMode, accentKey, onPickAccent, textColorKey, textColor, onPickTextColor, onOpenServer,
  onWatcher, watcherHint, keepFrameVisible, onKeepFrameVisible,
  chatFontStep, onChatFontStep,
  onFrameWatcherEnter, onFrameWatcherLeave,
}: {
  mode: ActiveMode;
  setMode: (m: ActiveMode) => void;
  installed: ModeId[];
  themeMode: Mode;
  onToggleThemeMode: () => void;
  accentKey: AccentSelection;
  onPickAccent: (k: AccentSelection) => void;
  textColorKey: TextColorSelection;
  textColor: string;
  onPickTextColor: (color: TextColorSelection) => void;
  onOpenServer: () => void;
  /// The Watcher (P0-8): in overlay-frame mode the decorative owl window is
  /// click-through, so the centered OWLLM title (directly beneath the owl)
  /// doubles as the summon point.
  onWatcher?: () => void;
  watcherHint?: boolean;
  keepFrameVisible: boolean;
  onKeepFrameVisible: (checked: boolean) => void;
  chatFontStep: number;
  onChatFontStep: (step: number) => void;
  onFrameWatcherEnter: () => void;
  onFrameWatcherLeave: () => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { language, setLanguage } = useLocalization();
  const settingsRef = useRef<HTMLDivElement>(null);
  const runActive = useRunActive();

  // GitHub / sync account state for the Settings sign-in row (relocated here
  // from the Home page). Reloads on mount, on the in-window `github-changed`
  // broadcast (immediate after a connect from any surface), and on window
  // focus (out-of-window browser device-flow). The sign-in / sign-out flow
  // itself lives in the globally-mounted AccountSyncModal, opened below.
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

  useEffect(() => {
    if (!settingsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!settingsRef.current?.contains(event.target as Node)) setSettingsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [settingsOpen]);
  // The header is always the dark blue band so the cyan frame +
  // OWLLM title read consistently across themes. Buttons therefore
  // stay light-on-dark regardless of mode — we don't drive their
  // colours from the theme.
  // Header pills (Advanced / Fine Tuning / Agentic Team / Gamify):
  // single source of truth lives in theme/styles.headerPill so this
  // file no longer carries duplicate button CSS. The pill is chrome —
  // it stays white-on-dark in BOTH themes by design.
  const baseBtn = headerPill(false);
  const active  = headerPill(true);

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
      position: "relative", zIndex: 50,
      // Geometry is constant across idle/running: border-box height equals
      // the old 80px content + 20px padding, and the 2px aura border is
      // always present (transparent when idle) so a run starting never
      // shifts the layout below.
      height: 100, boxSizing: "border-box",
      display: "grid", gridTemplateColumns: "auto 1fr auto auto",
      alignItems: "center", padding: "10px 18px 10px 20px", gap: 16,
      // Language changes text, never the physical header/control order.
      direction: "ltr",
      // Header surface — now uses --bg-header so the accent picker
      // visibly repaints the band (amber → golden header, red → red
      // header, emerald → green header). Was hardcoded #1c2244.
      // RUNNING: the band keeps its accent-driven fill (padding-box) while
      // the rotating aura gradient paints the border ring (border-box) —
      // the same technique as the active agent tiles.
      background: runActive
        ? `linear-gradient(var(--bg-header), var(--bg-header)) padding-box, ${HEADER_AURA_GRADIENT} border-box`
        : "var(--bg-header)",
      border: "2px solid transparent",
      animation: runActive ? HEADER_AURA_ANIMATION : undefined,
      cursor: "default",
    }}>
      {/* @property makes the conic angle animatable (Houdini); non-supporting
          browsers fall back to a static rainbow ring — same as the tiles.
          Declared here (ModeBar never unmounts) for BOTH header bars. */}
      <style>{`
        @property --owllm-aura-angle { syntax: "<angle>"; initial-value: 0deg; inherits: false; }
        @keyframes owllm-aura-spin { to { --owllm-aura-angle: 360deg; } }
      `}</style>
      <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
        <div ref={settingsRef} data-no-drag style={{ position: "relative" }}>
          <button
            data-ui="HeaderSettingsBtn"
            aria-expanded={settingsOpen}
            aria-haspopup="dialog"
            onClick={() => setSettingsOpen(open => !open)}
            title="Appearance and language settings"
            style={{
              width: 50, height: 50, borderRadius: 7, padding: 0,
              display: "grid", placeItems: "center",
              background: "linear-gradient(180deg, color-mix(in srgb, var(--header-pill-base) 82%, var(--accent)), var(--header-pill-base))",
              border: settingsOpen ? "1px solid var(--accent)" : "1px solid var(--border-strong)",
              color: "var(--bg-header-fg)", fontSize: 25, cursor: "pointer",
              boxShadow: settingsOpen ? "0 0 0 2px rgba(var(--accent-rgb),0.2)" : "none",
            }}
          >⚙</button>

          {settingsOpen && (
            <div
              data-ui="HeaderSettingsPopup"
              role="dialog"
              aria-label="Appearance and language settings"
              style={{
                position: "absolute", left: 0, top: 58, width: 344,
                padding: 12, borderRadius: 10,
                background: "var(--bg-panel)", color: "var(--fg)",
                border: "1px solid rgba(var(--accent-rgb),0.65)",
                boxShadow: "0 12px 32px rgba(0,0,0,0.48)",
              }}
            >
              <div data-ui="SettingsRow1" style={{ display: "flex", justifyContent: "center", gap: 8 }}>
                <button
                  data-ui="DarkModeBtn"
                  onClick={onToggleThemeMode}
                  title={themeMode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                  style={{
                    width: 70, height: 50, borderRadius: 6, padding: 0,
                    background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
                    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                    color: "var(--fg)", cursor: "pointer", lineHeight: 1,
                  }}
                >
                  <span style={{ fontSize: 24 }}>{themeMode === "dark" ? "🌙" : "☀"}</span>
                  <span style={{ fontSize: 11, fontWeight: 700 }}>{themeMode === "dark" ? "Dark" : "Light"}</span>
                </button>

                <div data-ui="ColorSelector" style={{
                  width: 70, height: 50, padding: 4, boxSizing: "border-box",
                  display: "grid", gridTemplateColumns: "repeat(3, 18px)", gridTemplateRows: "repeat(2, 18px)",
                  placeContent: "center", gap: 3, background: "var(--bg-elevated)",
                  border: "1px solid var(--border-strong)", borderRadius: 6,
                }}>
                  {ACCENTS.map(accent => {
                    const selected = accent.key === accentKey;
                    return (
                      <button
                        key={accent.key}
                        aria-label={accent.label}
                        aria-pressed={selected}
                        onClick={() => onPickAccent(accent.key)}
                        title={accent.label}
                        style={{
                          width: 18, height: 18, borderRadius: 3, padding: 0,
                          background: accent.color,
                          border: selected ? "2px solid #fff" : "1px solid rgba(255,255,255,0.15)",
                          boxShadow: selected ? `0 0 0 1px ${accent.color}, 0 0 6px ${accent.color}` : "none",
                          cursor: "pointer", transform: selected ? "scale(1.08)" : "scale(1)",
                        }}
                      />
                    );
                  })}
                </div>

                <label
                  data-ui="GuiColorPalette"
                  title="Choose GUI color"
                  style={{
                    position: "relative", width: 70, height: 50, borderRadius: 6,
                    boxSizing: "border-box", overflow: "hidden", cursor: "pointer",
                    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3,
                    background: "conic-gradient(from 45deg, #ef4444, #fbbf24, #10b981, #3b82f6, #8b5cf6, #ef4444)",
                    border: "2px solid var(--accent)", boxShadow: "0 0 0 1px var(--border-strong), 0 0 7px rgba(var(--accent-rgb),0.45)",
                  }}
                >
                  <span aria-hidden="true" style={{ width: 18, height: 18, borderRadius: 4, background: "var(--accent)", border: "2px solid #fff", boxShadow: "0 1px 4px #000" }} />
                  <span style={{ fontSize: 9, fontWeight: 800, color: "#fff", textShadow: "0 1px 3px #000" }}>GUI color</span>
                  <input
                    type="color"
                    aria-label="GUI color palette"
                    value={accentKey.startsWith("#")
                      ? accentKey
                      : (ACCENTS.find(accent => accent.key === accentKey)?.color ?? ACCENTS[0].color)}
                    onChange={(event) => onPickAccent(event.target.value as `#${string}`)}
                    style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer" }}
                  />
                </label>

                <label
                  data-ui="TextColorPalette"
                  title="Choose text color"
                  style={{
                    position: "relative", width: 70, height: 50, borderRadius: 6,
                    boxSizing: "border-box", overflow: "hidden", cursor: "pointer",
                    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3,
                    background: "conic-gradient(from 45deg, #ef4444, #fbbf24, #10b981, #3b82f6, #8b5cf6, #ef4444)",
                    border: "2px solid var(--text-color-selected)", boxShadow: "0 0 0 1px var(--border-strong)",
                  }}
                >
                  <span aria-hidden="true" style={{ width: 18, height: 18, borderRadius: 4, background: "var(--text-color-selected)", border: "2px solid #fff", boxShadow: "0 1px 4px #000" }} />
                  <span style={{ fontSize: 9, fontWeight: 800, color: "#fff", textShadow: "0 1px 3px #000" }}>Text color</span>
                  <input
                    type="color"
                    aria-label="Text color palette"
                    value={textColorKey === "auto" ? textColor : textColorKey}
                    onChange={(event) => onPickTextColor(event.target.value as `#${string}`)}
                    style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer" }}
                  />
                </label>

              </div>

              <div data-ui="SettingsRow2" style={{
                display: "flex", alignItems: "stretch", gap: 10,
                marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)",
              }}>
                <div data-ui="LanguageSelector" style={{
                  display: "grid", gridTemplateColumns: "repeat(4, 46px)", gridTemplateRows: "repeat(2, 29px)", gap: 4,
                }}>
                  {APP_LANGUAGES.map(option => {
                    const selected = language === option.code;
                    return (
                      <button
                        key={option.code}
                        aria-label={option.label}
                        aria-pressed={selected}
                        onClick={() => setLanguage(option.code)}
                        title={option.label}
                        style={{
                          width: 46, height: 29, padding: 2, borderRadius: 5,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          background: selected ? "rgba(var(--accent-rgb),0.2)" : "var(--bg-elevated)",
                          border: selected ? "1px solid var(--accent)" : "1px solid var(--border-strong)",
                          cursor: "pointer",
                        }}
                      >
                        <img
                          src={option.flagSrc}
                          alt={option.label}
                          data-no-localize
                          style={{
                            width: "100%", height: "100%", objectFit: "cover", borderRadius: 3,
                            opacity: selected ? 1 : 0.82, display: "block",
                          }}
                        />
                      </button>
                    );
                  })}
                </div>

                <label
                  data-ui="KeepFrameVisible"
                  title="Prevent the decorative window frame from fading while you work"
                  style={{
                    flex: 1, minWidth: 110, borderRadius: 6,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
                    color: "var(--fg)", fontSize: 9, fontWeight: 700, cursor: "pointer", textAlign: "center",
                  }}
                >
                  <MiniFrameReplica width={104} active={keepFrameVisible}>
                    <input
                      type="checkbox"
                      checked={keepFrameVisible}
                      onChange={(event) => onKeepFrameVisible(event.target.checked)}
                      style={{ width: 12, height: 12, margin: 0, accentColor: "var(--accent)" }}
                    />
                    <span style={{ lineHeight: 1.1 }}>Keep frame</span>
                  </MiniFrameReplica>
                </label>
              </div>

              <div data-ui="SettingsRow3" style={{
                display: "flex", alignItems: "center", gap: 10,
                minHeight: 42, marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)",
              }}>
                <span style={{ fontSize: 11, fontWeight: 700 }}>Chat text size</span>
                {(() => {
                  const stepBtn = (delta: number, name: "text-smaller" | "text-larger", label: string) => {
                    const next = clampChatFontStep(chatFontStep + delta);
                    const disabled = next === chatFontStep;
                    return (
                      <button
                        aria-label={label}
                        title={label}
                        onClick={() => onChatFontStep(next)}
                        disabled={disabled}
                        style={{
                          width: 42, height: 32, borderRadius: 6, padding: 0,
                          display: "grid", placeItems: "center",
                          background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
                          color: "var(--fg)", cursor: disabled ? "default" : "pointer",
                          opacity: disabled ? 0.4 : 1,
                        }}
                      >
                        <ActionIcon name={name} size={20} label={label} />
                      </button>
                    );
                  };
                  return (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
                      {stepBtn(-1, "text-smaller", "Decrease chat text size")}
                      <span aria-hidden="true" style={{
                        minWidth: 26, textAlign: "center", fontSize: 11, fontWeight: 800,
                        fontVariantNumeric: "tabular-nums", color: "var(--fg-muted)",
                      }}>{chatFontStep === 0 ? "A" : chatFontStep > 0 ? `+${chatFontStep}` : `${chatFontStep}`}</span>
                      {stepBtn(+1, "text-larger", "Increase chat text size")}
                    </div>
                  );
                })()}
              </div>

              {/* GitHub account / sync — relocated here from the Home page and
                  given a highlighted card (accent-tinted container, badge icon,
                  bigger label, CTA pill) so signing in stands out. Opens the
                  global AccountSyncModal, which owns the actual login / vault /
                  disconnect flow. */}
              <button
                data-ui="SettingsAccountRow"
                onClick={() => { setSettingsOpen(false); openSyncOnboarding(); }}
                title={account.connected ? "Manage sync / account" : "Sign in to sync your chats & settings across devices"}
                style={{
                  display: "flex", alignItems: "center", gap: 12, width: "100%",
                  marginTop: 14, padding: "12px 14px", borderRadius: 12, boxSizing: "border-box",
                  background: account.connected
                    ? "linear-gradient(135deg, rgba(34,197,94,0.16), rgba(34,197,94,0.04))"
                    : "linear-gradient(135deg, var(--accent-soft), rgba(var(--accent-rgb), 0.04))",
                  border: `1px solid ${account.connected ? "rgba(34,197,94,0.45)" : "var(--accent-strong)"}`,
                  boxShadow: account.connected ? "0 2px 14px rgba(34,197,94,0.18)" : "0 2px 14px var(--accent-glow-soft)",
                  cursor: "pointer", textAlign: "left", color: "var(--fg)",
                }}
              >
                <span style={{
                  width: 38, height: 38, flexShrink: 0, borderRadius: "50%",
                  display: "grid", placeItems: "center", fontSize: 20,
                  background: account.connected ? "rgba(34,197,94,0.18)" : "rgba(var(--accent-rgb), 0.18)",
                  border: `1px solid ${account.connected ? "rgba(34,197,94,0.5)" : "var(--accent-strong)"}`,
                }}>
                  {account.connected ? "☁️" : "🐙"}
                </span>
                <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  {account.connected ? (
                    <span style={{ fontWeight: 800, fontSize: 14.5, color: "var(--ok)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Synced as @{account.login}</span>
                  ) : (
                    <span style={{ fontWeight: 800, fontSize: 14.5, color: "var(--fg-strong)" }}>Sign in with GitHub</span>
                  )}
                </span>
                <span style={{
                  fontSize: 12.5, fontWeight: 800, flexShrink: 0,
                  padding: "6px 12px", borderRadius: 999,
                  background: account.connected ? "rgba(34,197,94,0.18)" : "var(--accent)",
                  color: account.connected ? "#22c55e" : "var(--accent-fg)",
                }}>{account.connected ? "Manage →" : "Sign in →"}</span>
              </button>
            </div>
          )}
        </div>

        {/* Advanced toggle removed — MCP/Accounts are always visible in the
            SubTabs right cluster, and Record moved there too. */}

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

      {/* The Watcher summon hotspot (P0-8). Sized + placed to match the
          OWL ICON ITSELF (top-centre), not the broad title beneath it: the
          decorative owl lives in a CLICK-THROUGH overlay window, so clicks
          on its lower body fall to this compact zone in the main window.
          Narrow + short so the hover affordance reads as "the owl", and the
          OWLLM text below is no longer a trigger. */}
      {onWatcher && (
        <button
          data-ui="WatcherSummon"
          // CRITICAL: stop the mousedown from bubbling to AppHeader's
          // startDrag — otherwise pressing the owl starts a window-drag and
          // the click never fires (that was why the owl "did nothing").
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onWatcher(); }}
          onMouseEnter={onFrameWatcherEnter}
          onMouseLeave={onFrameWatcherLeave}
          title="The Watcher — OWLLM's support assistant"
          className="owllm-watcher-summon"
          style={{
            position: "absolute",
            left: "50%", top: 0,
            transform: "translateX(-50%)",
            // The owl art is ~150px wide and its hoverable body sits in the
            // top strip of the header (its face peeks above the window).
            width: 150, height: 50,
            borderRadius: "0 0 50% 50%",
            border: "none", background: "transparent",
            cursor: "pointer", zIndex: 7, padding: 0,
          }}
        />
      )}
      <style>{`.owllm-watcher-summon:hover { background: radial-gradient(ellipse at 50% 0%, rgba(var(--accent-rgb),0.30), transparent 72%) !important; }`}</style>

      {/* The OWLLM title stays a drag surface, and hovering it restores the
          decorative frame. Clicking the compact owl hotspot above still
          summons the Watcher drawer. */}
      <div
        data-ui="AppTitle"
        onMouseEnter={onFrameWatcherEnter}
        onMouseLeave={onFrameWatcherLeave}
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
          width: 200,
          height: 54,
          fontSize: 35, fontWeight: 700, color: "var(--bg-header-fg)",
          letterSpacing: 2, lineHeight: "54px",
          textAlign: "center",
          pointerEvents: "auto",
        }}
      >OWLLM</div>
      {watcherHint && (
        <>
          <style>{`
            @keyframes owllm-watcher-orbit {
              0%   { opacity: 0; transform: translate(-14px, 4px) scale(0.92); }
              12%  { opacity: 1; transform: translate(0, 0) scale(1); }
              50%  { opacity: 1; transform: translate(8px, -3px) scale(1); }
              88%  { opacity: 1; transform: translate(16px, 2px) scale(1); }
              100% { opacity: 0; transform: translate(28px, 6px) scale(0.92); }
            }
          `}</style>
          <div style={{
            position: "absolute",
            left: "50%", top: "50%",
            transform: "translate(64px, -50%)",
            padding: "2px 9px", borderRadius: 999,
            background: "rgba(var(--accent-rgb),0.22)",
            border: "1px solid rgba(var(--accent-rgb),0.65)",
            color: "var(--bg-header-fg)", fontSize: 11, fontWeight: 800,
            letterSpacing: 0.4, whiteSpace: "nowrap",
            pointerEvents: "none",
            animation: "owllm-watcher-orbit 6s ease-in-out 1 both",
            zIndex: 5,
          }}>
            The Watcher ↑
          </div>
        </>
      )}

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
  const fullModelId = server.model_id ?? "?";
  const serverLine = server.running
    ? `🟢 Servers: 1 (${abbreviateModelId(fullModelId)})`
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
      title={server.running
        ? `Model: ${fullModelId}\nOpen Server Control`
        : "Open Server Control"}
      style={{
        width: "min(420px, 31vw)", minWidth: 0, height: 60,
        display: "flex", flexDirection: "column",
        alignItems: "stretch", justifyContent: "center", gap: 3,
        fontSize: 12, fontWeight: 700, color: "var(--bg-header-fg)", textAlign: "right",
        // Trimmed from the Qt-port's hard 543px to free room for the
        // inline WindowControls 4th grid column. overflow:hidden +
        // text-overflow on the children below keeps long model ids
        // from pushing the layout.
        overflow: "hidden",
        cursor: "pointer",
      }}
    >
      <div data-ui="HeaderServersLabel" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {serverLine}
      </div>
      <div data-ui="HeaderApiKeyLabel" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <span style={{ marginRight: 4 }}>🔑</span>
        API key: owllm-local
        <GenSpeedBadge variant="header" />
      </div>
      <div data-ui="HeaderVramLabel" title={server.message || undefined} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <span style={{ marginRight: 4 }}>💾</span>{vramLine}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// SubTabs — composed dynamically from the visible page list.
// ---------------------------------------------------------------------
// Page keys that should be right-aligned in the SubTabs row: Info
// (from CORE), Server (a modal trigger the user wants parked on the
// right next to Info), plus everything contributed by ADVANCED. They're
// the "utility" pages, visually separated from the work surfaces by a
// flex spacer.
const RIGHT_ALIGNED_KEYS = new Set(["info", "server", "mcp", "environment", "accounts", "devices", "logs"]);

function SubTabs({
  pages, activeKey, onChange,
}: {
  pages: PageDef[];
  activeKey: string;
  onChange: (key: string) => void;
}) {
  const runActive = useRunActive();
  const renderTab = (p: PageDef) => {
    const active = p.key === activeKey;
    return (
      <div
        key={p.key}
        onClick={() => onChange(p.key)}
        style={{
          padding: "5px 14px",
          background: active ? "rgba(var(--accent-rgb),0.28)" : "transparent",
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
  const rightRaw  = pages.filter(p =>  RIGHT_ALIGNED_KEYS.has(p.key));
  // Fixed right-cluster order: utilities (MCP, Accounts) first, then
  // Server, then Info pinned last. Final cluster: ● Record · MCP ·
  // Accounts · Server · Info.
  const rightTabs = [
    ...rightRaw.filter(p => p.key !== "info" && p.key !== "server"),
    ...rightRaw.filter(p => p.key === "server"),
    ...rightRaw.filter(p => p.key === "info"),
  ];

  return (
    <div data-ui="SubTabsBar" style={{
      // Constant geometry: border-box height covers the old 48px + 1px
      // separator, and the 2px aura border is always reserved so the bar
      // doesn't jump when a run starts. Idle keeps the bottom separator
      // (drawn by the transparent border's bottom colour).
      height: 49, boxSizing: "border-box", background: runActive
        ? `linear-gradient(var(--bg-card), var(--bg-card)) padding-box, ${HEADER_AURA_GRADIENT} border-box`
        : "var(--bg-card)",
      display: "flex", alignItems: "center",
      padding: "0 24px", gap: 6, fontSize: 15, color: "var(--fg)",
      border: "2px solid transparent",
      borderBottomColor: runActive ? "transparent" : "var(--border)",
      animation: runActive ? HEADER_AURA_ANIMATION : undefined,
    }}>
      {leftTabs.map(renderTab)}
      <div style={{ flex: 1 }} />
      <div
        data-ui="TutorialRecorderToggle"
        onClick={toggleTutorialRecorder}
        title="Tutorial recorder"
        style={{
          padding: "5px 12px", borderRadius: 8, fontWeight: 600,
          color: "var(--fg-muted)", cursor: "pointer", userSelect: "none",
          display: "flex", alignItems: "center", gap: 6,
        }}
      >
        <span style={{ fontSize: 12, color: "#e0556a" }}>●</span> Record
      </div>
      {rightTabs.map(renderTab)}
    </div>
  );
}

// ---------------------------------------------------------------------
// PageModal — popup wrapper around a full Page component. Used for
// Server and Bridges so the user can pop them open from any mode
// without losing their current tab. Centered modal styled like the
// app (cyan border, dark-blue title strip, panel body). Closes on
// backdrop click, Esc, or the ✕ button.
// ---------------------------------------------------------------------
function PageModal({
  title, dataUi, onClose, children,
}: {
  title: string;
  dataUi: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      data-ui={`${dataUi}Backdrop`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 9000,
        background: "rgba(0,0,0,0.62)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        data-ui={dataUi}
        style={{
          width: "92%", height: "88%",
          background: "var(--bg-panel)",
          border: "2px solid rgba(var(--accent-rgb), 0.78)",
          borderRadius: 14,
          boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
          display: "flex", flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div style={{
          height: 56,
          background: "var(--bg-header)",
          color: "var(--bg-header-fg)",
          display: "flex", alignItems: "center",
          padding: "0 20px",
          borderBottom: "1px solid rgba(var(--accent-rgb), 0.30)",
        }}>
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: 1 }}>
            {title}
          </div>
          <div style={{ flex: 1 }} />
          <button
            data-ui={`${dataUi}Close`}
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
        <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
          {children}
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

// Vault sync can legitimately reload the webview once after it imports newer
// state from another device. Keep the user's navigation separate from synced
// state and restore it after that reload; otherwise an async boot task can
// dump someone working in Code/Agents back onto Home without any action from
// them. sessionStorage is intentionally used so this is per-window and never
// leaks a machine-local navigation choice into the vault.
const NAV_RESTORE_KEY = "owllm:nav-restore";
function readSavedNavigation(): { mode: ActiveMode; activeKey: string } | null {
  try {
    const raw = sessionStorage.getItem(NAV_RESTORE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { activeKey?: unknown };
    return typeof saved.activeKey === "string" ? resolveDeepLink(saved.activeKey) : null;
  } catch {
    return null;
  }
}

function OverlayContentPanel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      position: "fixed",
      inset: 0,
      background: "var(--bg-panel)",
      overflow: "hidden",
    }}>
      {children}
    </div>
  );
}

function WindowAccentEdge() {
  return (
    <div data-ui="WindowAccentEdge" aria-hidden="true" style={{
      position: "fixed", inset: 0, zIndex: 9999,
      border: "3px solid var(--accent)", boxSizing: "border-box",
      pointerEvents: "none",
    }} />
  );
}

// The accent edge hugs the WINDOW boundary, which is only the visible app
// edge when the window is opaque (Windows/macOS, or overlay-frame mode).
// Linux ships a TRANSPARENT window that is LARGER than the in-page
// HybridFrame (owl headroom + see-through margins) — there the border drew
// a floating orange rectangle in mid-air around the invisible window rect,
// slicing through the owl badge. Same UA check index.html uses for the
// boot splash: only webkit2gtk on Linux reports "Linux".
const LINUX_TRANSPARENT_WINDOW =
  typeof navigator !== "undefined" && navigator.userAgent.indexOf("Linux") !== -1;

export default function AppShell() {
  const installed = useMemo(() => getInstalledModes(), []);
  // Resolve the URL's ?page= once on mount so TwinForge can deep-link
  // straight to the page it wants to diff (e.g. ?page=train).
  const initialDeep = useMemo(() => {
    const k = readPageFromUrl();
    return k ? resolveDeepLink(k) : null;
  }, []);
  const initialNavigation = useMemo(
    () => initialDeep ?? readSavedNavigation() ?? { mode: "home" as ActiveMode, activeKey: CORE.firstTab },
    [initialDeep],
  );
  const [mode, setMode] = useState<ActiveMode>(initialNavigation.mode);
  const [serverModalOpen, setServerModalOpen] = useState<boolean>(false);
  const [bridgesModalOpen, setBridgesModalOpen] = useState<boolean>(false);
  const [overlayFrame, setOverlayFrame] = useState<boolean>(false);
  const theme = useTheme();
  const [keepFrameVisible, setKeepFrameVisible] = useState<boolean>(() => readKeepFrameVisible());
  const [chatFontStep, setChatFontStep] = useState<number>(() => readChatFontStep());
  const [frameVisible, setFrameVisible] = useState<boolean>(true);
  const frameHideTimer = useRef<number | undefined>(undefined);

  const clearFrameHideTimer = () => {
    if (frameHideTimer.current !== undefined) {
      window.clearTimeout(frameHideTimer.current);
      frameHideTimer.current = undefined;
    }
  };
  const revealFrame = () => {
    clearFrameHideTimer();
    setFrameVisible(true);
  };
  const hideFrameAfter = (delay: number) => {
    clearFrameHideTimer();
    if (keepFrameVisible) return;
    frameHideTimer.current = window.setTimeout(() => {
      setFrameVisible(false);
      frameHideTimer.current = undefined;
    }, delay);
  };

  useEffect(() => {
    saveKeepFrameVisible(keepFrameVisible);
    if (keepFrameVisible) revealFrame();
    else hideFrameAfter(FRAME_IDLE_HIDE_MS);
    return clearFrameHideTimer;
  }, [keepFrameVisible]);

  // Chat body font size — persist the step and expose it as the
  // `--chat-font-size` CSS variable the shared chat renderers read.
  useEffect(() => {
    saveChatFontStep(chatFontStep);
    document.documentElement.style.setProperty("--chat-font-size", `${chatFontSizePx(chatFontStep)}px`);
  }, [chatFontStep]);

  // Windows draws the decorative art in a separate click-through webview.
  // Broadcast the same visibility state there; the storage message is a
  // reliable cross-webview fallback and the Tauri event handles it instantly.
  useEffect(() => {
    const payload = { visible: frameVisible, nonce: Date.now() };
    try { localStorage.setItem(FRAME_VISIBILITY_STATE_KEY, JSON.stringify(payload)); }
    catch { /* localStorage blocked */ }
    if (isTauri()) emit("owllm:frame-visibility", frameVisible).catch(() => {});
  }, [frameVisible]);

  // The Watcher (P0-8): summoned from the top-center owl. A small animated
  // "The Watcher" satellite label appears periodically around the owl to
  // suggest the click — and stops forever once the user has opened it.
  const [watcherOpen, setWatcherOpen] = useState<boolean>(false);
  const [watcherHint, setWatcherHint] = useState<boolean>(false);
  const [frameIntroVisible, setFrameIntroVisible] = useState<boolean>(true);
  const [watcherNear, setWatcherNear] = useState<boolean>(false);

  // Show the complete decorative frame as a short opening flourish. It then
  // gets out of the way; moving near the compact top-centre Watcher target
  // reveals only the owl. The generous proximity zone makes discovery easy
  // without restoring the old oversized clickable region.
  useEffect(() => {
    const timer = window.setTimeout(() => setFrameIntroVisible(false), 3000);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    const update = (e: PointerEvent) => {
      const near = Math.abs(e.clientX - window.innerWidth / 2) <= 210 && e.clientY <= 135;
      setWatcherNear(current => current === near ? current : near);
    };
    const leave = () => setWatcherNear(false);
    window.addEventListener("pointermove", update, { passive: true });
    window.addEventListener("blur", leave);
    document.documentElement.addEventListener("pointerleave", leave);
    return () => {
      window.removeEventListener("pointermove", update);
      window.removeEventListener("blur", leave);
      document.documentElement.removeEventListener("pointerleave", leave);
    };
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    // The Windows frame is a separate click-through webview, so it cannot
    // sense the pointer itself. Broadcast only state transitions to it.
    emit("owllm:watcher-proximity", watcherNear).catch(() => {});
  }, [watcherNear]);
  useEffect(() => {
    try { if (localStorage.getItem("owllm:watcher:discovered") === "1") return; } catch { return; }
    let hideTimer: number | undefined;
    const tick = () => {
      try { if (localStorage.getItem("owllm:watcher:discovered") === "1") return; } catch { return; }
      setWatcherHint(true);
      hideTimer = window.setTimeout(() => setWatcherHint(false), 6500);
    };
    const first = window.setTimeout(tick, 8000); // first nudge shortly after launch
    const iv = window.setInterval(tick, 60_000); // then once per minute
    return () => {
      window.clearTimeout(first);
      window.clearInterval(iv);
      if (hideTimer !== undefined) window.clearTimeout(hideTimer);
    };
  }, []);
  const openWatcher = () => {
    try { localStorage.setItem("owllm:watcher:discovered", "1"); } catch { /* ignore */ }
    setWatcherHint(false);
    setWatcherOpen(true);
  };
  // The always-visible "🦉 Watcher" chrome button (and any other surface)
  // summons via this window event, so it never depends on the click-through
  // owl's geometry.
  useEffect(() => {
    const h = () => openWatcher();
    window.addEventListener("owllm:open-watcher", h as EventListener);
    return () => window.removeEventListener("owllm:open-watcher", h as EventListener);
  }, []);

  // Scope Ctrl/Cmd+A to the chat/log region the user is reading instead of
  // grabbing the whole app window (which made a copy pull every panel's text).
  // Regions opt in via `data-selectall-scope` on their scroll container.
  useEffect(() => installScopedSelectAll(), []);

  useEffect(() => {
    if (!isTauri()) return;
    invoke<boolean>("overlay_frame_enabled")
      .then(setOverlayFrame)
      .catch(() => setOverlayFrame(false));
  }, []);

  // First-run MCP provisioning: give the app a keyless web-search tool out of
  // the box. DuckDuckGo (`uvx duckduckgo-mcp-server`) needs no API key and no
  // card, so web search "just works" without the user wiring up Brave. Runs
  // ONCE (guarded), in the background, and only when NO search server is
  // configured yet — it never clobbers a user's own MCP setup. mcp_install_pack
  // installs `uv` if missing; the server itself lazy-starts on first tool use.
  // On failure (offline, etc.) the guard is left unset so the next launch
  // retries; the user can always add a search server on the MCP page.
  useEffect(() => {
    if (!isTauri()) return;
    const GUARD = "owllm:mcp:default_search_provisioned";
    try { if (localStorage.getItem(GUARD)) return; } catch { /* ignore */ }
    let cancelled = false;
    (async () => {
      try {
        const cfg = await invoke<{ servers?: Array<{ name?: string; args?: string[] }> }>("mcp_load_config");
        if (cancelled) return;
        const servers = cfg?.servers ?? [];
        const hasSearch = servers.some((s) => {
          const hay = `${s.name ?? ""} ${(s.args ?? []).join(" ")}`.toLowerCase();
          return /(search|duckduckgo|ddg|brave|tavily|exa)/.test(hay);
        });
        if (!hasSearch) {
          await invoke("mcp_install_pack", {
            servers: [{ name: "duckduckgo", command: "uvx", args: ["duckduckgo-mcp-server"], env: {}, enabled: true }],
          });
        }
        try { localStorage.setItem(GUARD, "1"); } catch { /* ignore */ }
      } catch { /* best-effort — retry next launch */ }
    })();
    return () => { cancelled = true; };
  }, []);

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
    // Advanced pages (MCP / Accounts) are ALWAYS visible now — the old
    // ⚙ Advanced toggle is gone; they live in the right cluster of SubTabs.
    if (installed.includes("advanced")) {
      out.push(...ADVANCED.pages);
    }
    return out;
  }, [mode, installed]);

  // When mode changes, jump to that mode's firstTab. When mode is
  // 'home' (no group active), default to the Core firstTab ('home').
  const defaultKeyForMode = (m: ActiveMode): string => {
    if (m === "home") return CORE.firstTab;
    const mod = ALL_MODULES.find(x => x.id === m);
    return mod?.firstTab ?? CORE.firstTab;
  };
  const [activeKey, setActiveKey] = useState<string>(
    () => initialNavigation.activeKey,
  );
  useEffect(() => {
    try {
      sessionStorage.setItem(NAV_RESTORE_KEY, JSON.stringify({ mode, activeKey }));
    } catch { /* storage unavailable: a reload falls back to Home as before */ }
  }, [mode, activeKey]);
  // Local-only activity stats (P0-8 Slice 4): count page visits by KEY
  // (a product id, never content). Viewed/cleared inside The Watcher.
  useEffect(() => {
    try { bumpActivity(`page:${activeKey}`); } catch { /* never break nav */ }
  }, [activeKey]);

  // Whenever mode changes, snap to that mode's first tab. (Qt
  // _activate_navbar_group does the same.)
  const handleSetMode = (m: ActiveMode) => {
    setMode(m);
    setActiveKey(defaultKeyForMode(m));
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
      // "server" / "bridges" are modals — intercept here so external
      // nav requests open the popup instead of trying to switch to a
      // (no-longer-rendered-inline) tab.
      if (key === "server") { setServerModalOpen(true); return; }
      if (key === "bridges") { setBridgesModalOpen(true); return; }
      // Find which module owns this page key so we can light up the
      // matching ModeBar toggle alongside the SubTabs row.
      for (const m of ALL_MODULES) {
        if (m.pages.some(p => p.key === key) && m.id !== "core" && m.id !== "advanced") {
          if (m.id === "finetuning" || m.id === "agentic" || m.id === "gamify") setMode(m.id);
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
    if (key === "bridges") { setBridgesModalOpen(true); return; }
    setActiveKey(key);
  };

  // Resolve the active page's component.
  const activePage = visiblePages.find(p => p.key === activeKey)
                  ?? visiblePages[0];
  const PageBody = activePage?.component;

  // ----- Keep-alive pages: Agents + Code -----
  // A running team dispatch lives ENTIRELY inside AgentsPage (the
  // dispatchGoal loop, its AbortController, and all the streaming state
  // are component-local), and the Code page re-pays its whole mount cost
  // (model list, per-page probes, worktree self-heal, file tree) on every
  // visit. The normal page swap below unmounts the active page on every
  // tab/mode change, which tore down an in-flight run and made reopening
  // these pages slow. So once the user has visited one of them we mount it
  // ONCE and keep it alive, toggling visibility with `display` instead of
  // unmounting. Every other page still swaps.
  const keepAliveDefs = useMemo(
    () => (installed.includes("agentic")
      ? AGENTIC.pages.filter(p => p.key === "agents" || p.key === "code")
      : []),
    [installed],
  );
  const [aliveMounted, setAliveMounted] = useState<Record<string, boolean>>({});
  const keepAliveActive = keepAliveDefs.some(p => p.key === activeKey);
  useEffect(() => {
    if (keepAliveActive) setAliveMounted(m => (m[activeKey] ? m : { ...m, [activeKey]: true }));
  }, [activeKey, keepAliveActive]);

  const vp = useViewportSize();
  const appContent = (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <ModeBar
            mode={mode}
            setMode={handleSetMode}
            installed={installed}
            themeMode={theme.mode}
            onToggleThemeMode={theme.toggleMode}
            accentKey={theme.accentKey}
            onPickAccent={theme.setAccentKey}
            textColorKey={theme.textColorKey}
            textColor={theme.textColor}
            onPickTextColor={theme.setTextColor}
            onOpenServer={() => setServerModalOpen(true)}
            onWatcher={openWatcher}
            watcherHint={watcherHint && overlayFrame}
            keepFrameVisible={keepFrameVisible}
            onKeepFrameVisible={setKeepFrameVisible}
            chatFontStep={chatFontStep}
            onChatFontStep={setChatFontStep}
            onFrameWatcherEnter={revealFrame}
            onFrameWatcherLeave={() => hideFrameAfter(FRAME_LEAVE_HIDE_MS)}
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
          <div style={{ flex: 1, overflow: "hidden", minHeight: 0, position: "relative" }}>
            {/* Normal page swap for everything except the keep-alive pages —
                when one of them is active its persistent instance below shows
                instead, so we don't double-mount it. */}
            {keepAliveActive ? null : (PageBody ? <PageBody /> : null)}
            {/* Persistent Agents/Code pages: mounted once visited, kept alive
                so an in-flight run survives navigation and reopening them is
                instant. Hidden (not unmounted) when another page is active. */}
            {keepAliveDefs.filter(p => aliveMounted[p.key]).map(p => (
              <div key={p.key} style={{
                position: "absolute", inset: 0,
                display: activeKey === p.key ? "block" : "none",
              }}>
                <p.component />
              </div>
            ))}
          </div>
    </div>
  );

  return (
    <>
      <TelegramBridgeRunner />
      <DiscordBridgeRunner />
      <SlackBridgeRunner />
      <EmailBridgeRunner />
      <WebhookBridgeRunner />
      <ResizeEdges />
      {(overlayFrame || !LINUX_TRANSPARENT_WINDOW) && <WindowAccentEdge />}
      {overlayFrame
        ? <OverlayContentPanel>{appContent}</OverlayContentPanel>
        : <HybridFrame
            outerW={vp.w}
            outerH={vp.h}
            showWatcherHint={watcherHint}
            frameVisible={frameVisible}
          >{appContent}</HybridFrame>}
      <WatcherDrawer
        open={watcherOpen}
        onClose={() => setWatcherOpen(false)}
        mode={mode}
        activeKey={activeKey}
      />
      {serverModalOpen && (
        <PageModal
          title="🖧 Server Control"
          dataUi="ServerModal"
          onClose={() => setServerModalOpen(false)}
        >
          <ServerPage />
        </PageModal>
      )}
      {bridgesModalOpen && (
        <PageModal
          title="📱 Bridges"
          dataUi="BridgesModal"
          onClose={() => setBridgesModalOpen(false)}
        >
          <BridgesPage />
        </PageModal>
      )}
      <TutorialRecorder enabled={true} />
      <FirstRunWizardMount />
      {/* Account/Sync onboarding — self-gates to first run + the
          `owllm:open-sync` event. Invites GitHub sign-in so chats/settings
          follow the user across devices (their own private owllm-vault). */}
      <AccountSyncModal />
    </>
  );
}

// First-run module wizard — gated by useNeedsFirstRunWizard. Renders an
// overlay above the rest of the app on first launch when no modules are
// installed yet. Dismissing it (Skip or Install) records `wizard.completed`
// in localStorage so subsequent launches stay clean.
function FirstRunWizardMount() {
  const { needed, setDismissed } = useNeedsFirstRunWizard();
  if (!needed) return null;
  return <ModuleWizard mode="first-run" onClose={setDismissed} />;
}
