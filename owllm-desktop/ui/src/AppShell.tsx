// AppShell — the persistent chrome wrapping every page: HybridFrame
// (corners + badge), the top ModeBar, and the SubTabs nav.
//
// Architecture (2026-05-14): mirrors the Qt navbar groups from
// main.py:4284-4297 exactly. The ModeBar toggles (Fine Tuning /
// Agentic Team / Gamify) are a single-active state machine; only
// the active mode's pages plus the always-on Core pages render in
// SubTabs. Advanced page components remain globally reachable; compact
// destinations such as MCP and Accounts live in the Settings dropdown.
//
// All page definitions live in core/modules.ts so each mode is a
// self-contained installable feature. Adding/removing a page does
// not touch this file. Adding a brand-new mode = one entry in
// modules.ts plus a directory under pages/.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
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
import SigningPage from "./pages/advanced/SigningPage";
import TutorialRecorder, { toggleTutorialRecorder } from "./tutorial/TutorialRecorder";
import ModuleWizard, { useNeedsFirstRunWizard } from "./pages/modules/ModuleWizard";
import AccountSyncModal, { openSyncOnboarding } from "./pages/core/AccountSyncModal";
import { githubStatus, GITHUB_CHANGED_EVENT } from "./pages/agentic/github";
import WatcherDrawer from "./support/WatcherDrawer";
import GenSpeedBadge from "./components/GenSpeedBadge";
import { notify } from "./components/Toast";
import { installScopedSelectAll } from "./utils/scopedSelectAll";
import { bumpActivity } from "./support/activityStats";
import { APP_LANGUAGES, useLocalization } from "./localization";
import { readKeepFrameVisible, saveKeepFrameVisible } from "./framePreferences";
import { isRunActive, isRunActiveMatching, getRunActivityVersion, subscribeRunActivity } from "./runtime/runActivity";
import { continuousUiAnimation } from "./runtime/renderingPolicy";
import {
  getUpdateAvailability, markUpdateAnnounced, requestUpdateInstall,
  shouldAnnounceUpdate, subscribeUpdateAvailability,
} from "./runtime/updateAvailability";
import {
  getModuleUpdates, openModulesPage, OPEN_MODULES_EVENT, setModuleUpdates,
  subscribeModuleUpdates, type ModuleUpdate,
} from "./runtime/moduleUpdates";
import {
  initTabActivity, isWorkflowAwarePage, runPrefixesForPage, showFinishedBadge, stepTabActivity,
} from "./runtime/headerTabActivity";
import {
  CHAT_FONT_MIN_STEP, chatFontSizePx, clampChatFontStep,
  readChatFontStep, saveChatFontStep,
} from "./chatFontPreferences";
import { isChatZoomTarget, nextChatFontStep } from "./chatFontWheelZoom";
import ActionIcon from "./components/ActionIcon";
import { getVersion } from "@tauri-apps/api/app";
import { installWorldPresenceConnection, presenceNodeIdForDevice } from "./pages/gamify/worldPresence";
import {
  openWorldChatThread,
  subscribeWorldChat,
  worldChatHooks,
} from "./pages/gamify/worldChatRuntime";
import { worldChatConversations, worldChatUnreadCount } from "./pages/gamify/worldChat";
import { getIdentity } from "./pages/advanced/remoteDevices";
import { openWebUrl } from "./utils/openWebUrl";

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

const FRAME_IDLE_HIDE_MS = 1800;
const FRAME_LEAVE_HIDE_MS = 700;
const MARKETPLACE_URL = "https://marketplace.owllm.com/";

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

// Keep the local inference key in sync at startup, independently of whether the
// header status block is rendered. ServerPage refreshes it again whenever the
// user changes the network-exposure setting.
function useLocalServerKeySync() {
  useEffect(() => {
    if (!isTauri()) return;
    // Mirror the local server's required api-key (set when the user EXPOSES the
    // server on the network — llama-server then enforces --api-key on 127.0.0.1
    // too) so local inference attaches it instead of 401-ing.
    invoke<{ enabled: boolean; apiKey: string }>("inference_expose_get")
      .then((c) => setLocalServerKey(c.enabled ? c.apiKey : ""))
      .catch(() => {});
  }, []);
}

// If OwLLM died last time instead of closing, say so — once, on the launch that
// discovered it. Users who report "it keeps closing on its own" have no way to
// tell us what happened; the details are already attached to any support report
// they send from here, so the notice's job is just to prompt them to send one.
function useUncleanShutdownNotice() {
  const { t } = useLocalization();
  useEffect(() => {
    if (!isTauri()) return;
    invoke<{ newThisLaunch: number; reports: { reason: string }[] }>("session_health_pending")
      .then((health) => {
        if (health.newThisLaunch < 1) return;
        const last = health.reports[health.reports.length - 1];
        // The reason is a sentence fragment ("that session's process
        // disappeared…"), so join it with a dash and punctuate it here rather
        // than letting two half-sentences run together.
        const cause = last?.reason ? ` — ${t(last.reason)}.` : ".";
        notify(
          `${t("OwLLM closed unexpectedly last time")}${cause} ${t(
            "Sending a report from the Support page includes what we recorded.",
          )}`,
          "error",
          // Stays until clicked: this asks the user to do something, and the
          // 12s error timeout expires long before someone returning to their
          // desk would ever see it.
          { sticky: true },
        );
      })
      .catch(() => {});
  }, [t]);
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
type VramGpu = {
  index: number;
  used_mib: number;
  total_mib: number;
  unified?: boolean;
  model_scoped?: boolean;
};
type VramStatusLite = { gpus: VramGpu[] };

// Model ids commonly include the organisation, fine-tune recipe and quant.
// Keeping the tail is useful because it usually carries the quant, while a
// middle ellipsis prevents one unusually descriptive id from taking over the
// header. The full id remains available on hover in SysInfoBlock.
function abbreviateModelId(modelId: string, maxLength = 36): string {
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

// How long the owl's update balloon stays before handing over to the small
// badge under the OWLLM mark.
const UPDATE_NOTICE_MS = 10_000;
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
  const bandBg = FRAME_BG;
  return (
    <div data-ui="hybrid-frame-root" style={{ position:"relative", width:outerW, height:outerH, background:"transparent" }}>
      {/* zIndex:0 makes the content panel its OWN stacking context. Without it
          the panel is `z-index:auto`, so every positioned descendant with a
          positive z-index (the resize edges at 10000, menus, modals) competes
          directly with the frame below in the ROOT stacking context and paints
          OVER it — the frame then reads as sitting *behind* the window. Windows
          and Linux never hit this because their frame is a separate overlay
          window stacked by the window manager; macOS is the only platform that
          renders HybridFrame inline, which is why the frame only sank there. */}
      <div style={{ position:"absolute", left:parent_x, top:parent_y, width:parent_w, height:parent_h, background:"var(--bg-panel)", overflow:"hidden", zIndex:0 }}>{children}</div>
      <div data-ui="DecorativeWindowFrame" style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        zIndex: 1,
        opacity: frameVisible ? 1 : 0,
        transition: `opacity ${frameVisible ? 220 : 360}ms ease`,
      }}>
        {/* The four fill bands are plain rectangles, so their corners are square
            while the outer stroke below is rounded (rx=14) — the opaque fill
            juts past the border and reads as "solid colour corners". Clip them
            to the same rounded outer rect so the chrome backing follows the
            border radius. The bands sit exactly inside this rect by geometry
            (bottom/right bands end on outerB/outerR), so nothing is cropped. */}
        <div style={{ position:"absolute", left:outerL, top:outerT, width:outerW2, height:outerH2, borderRadius:14, overflow:"hidden" }}>
          <div style={{ position:"absolute", left:topBar.x - outerL,   top:topBar.y - outerT,   width:topBar.w,   height:topBar.h,   background:bandBg }} />
          <div style={{ position:"absolute", left:botBar.x - outerL,   top:botBar.y - outerT,   width:botBar.w,   height:botBar.h,   background:bandBg }} />
          <div style={{ position:"absolute", left:leftBar.x - outerL,  top:leftBar.y - outerT,  width:leftBar.w,  height:leftBar.h,  background:bandBg }} />
          <div style={{ position:"absolute", left:rightBar.x - outerL, top:rightBar.y - outerT, width:rightBar.w, height:rightBar.h, background:bandBg }} />
        </div>
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
// title, SysInfo, and window controls. Mode toggles drive the active mode state.
// ---------------------------------------------------------------------
type ActiveMode = "home" | "finetuning" | "agentic" | "gamify";

// True while ANY run is in flight anywhere in the app (team dispatch, code
// run, chat stream). Drives the header bars' "running" aura — the same
// rotating conic-gradient border the active agent tiles show.
function useRunActive(): boolean {
  return React.useSyncExternalStore(subscribeRunActivity, isRunActive);
}

// Re-renders on EVERY run-activity change (not just the aggregate on/off edge),
// so the per-page header glow clears the right button when one family stops
// while another keeps running. The version is a stable snapshot per change.
function useRunActivityVersion(): number {
  return React.useSyncExternalStore(subscribeRunActivity, getRunActivityVersion);
}

// The header aura reuses the agent tiles' rainbow ring verbatim (same stops,
// same 4s linear spin) but anchors its start/end stop on the SELECTED GUI
// accent so the effect visibly carries the user's colour instead of a
// hardcoded green. Painted padding-box/border-box exactly like the tiles.
const HEADER_AURA_GRADIENT =
  `conic-gradient(from var(--owllm-aura-angle),`
  + ` var(--accent), #ffd93c, #ff9a3c, #ff5c8a, #b07cff, #7fd4ff, var(--accent))`;
const HEADER_AURA_ANIMATION = continuousUiAnimation("owllm-aura-spin 4s linear infinite");

// The per-button "working" dot and finished "✓" check reuse the page tab-strip's
// psychedelic rainbow (CodePage PSYCHEDELIC_AURA_DOT / owllm-tab-working pulse)
// verbatim, so a workflow-aware second-header button reads as the SAME activity
// signal as the page's own tab.
const HEADER_TAB_AURA_STOPS = "#3cf26b, #ffd93c, #ff9a3c, #ff5c8a, #b07cff, #7fd4ff, #3cf26b";
const HEADER_TAB_AURA_DOT = `conic-gradient(from 0deg, ${HEADER_TAB_AURA_STOPS})`;
const HEADER_TAB_WORKING_ANIMATION = "owllm-tab-working 1.4s ease-in-out infinite";

function ModeBar({
  mode, setMode, installed,
  themeMode, onToggleThemeMode, accentKey, onPickAccent, textColorKey, textColor, onPickTextColor,
  onOpenMarketplace, onOpenSigning, onOpenSettingsPage,
  onWatcher, watcherHint, chatNotice, onOpenChatNotice,
  updateNotice, updateBadge, onOpenUpdate,
  moduleUpdates, onOpenModules,
  keepFrameVisible, onKeepFrameVisible,
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
  onOpenMarketplace: () => void;
  onOpenSigning: () => void;
  onOpenSettingsPage: (key: string) => void;
  /// The Watcher (P0-8): in overlay-frame mode the decorative owl window is
  /// click-through, so the centered OWLLM title (directly beneath the owl)
  /// doubles as the summon point.
  onWatcher?: () => void;
  watcherHint?: boolean;
  /// World Chat: a message just arrived, so the owl says so. Chat can land on
  /// any page, which is why the notice belongs to the chrome and not to the
  /// World Map.
  chatNotice?: { key: string; label: string; avatar: string; text: string; count: number } | null;
  onOpenChatNotice?: () => void;
  /// A new version is out: the owl says so once, in a comic speech bubble, for
  /// UPDATE_NOTICE_MS. After that the bubble is replaced by `updateBadge` — a
  /// small chip tucked under the OWLLM mark — so the offer never vanishes
  /// without a trace, and never blocks the app either.
  updateNotice?: string | null;
  updateBadge?: string | null;
  onOpenUpdate?: () => void;
  /// Installed modules with a newer build waiting. Drives the Settings row's
  /// dot and its own chrome chip — the app update badge can't carry these,
  /// because a module update ships without any new app version.
  moduleUpdates?: ModuleUpdate[];
  onOpenModules?: () => void;
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
      const target = event.target as Element | null;
      // Settings destinations (Assets / Bridges / MCP / Accounts / Signing)
      // open as popups that render OUTSIDE this dropdown. Working inside one
      // must not dismiss the dropdown behind it, so the dropdown is still
      // there when the popup closes — only a click on the app itself closes it.
      if (target?.closest?.("[data-owllm-overlay]")) return;
      if (!settingsRef.current?.contains(target as Node)) setSettingsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Esc belongs to the topmost popup while one is open.
      if (document.querySelector("[data-owllm-overlay]")) return;
      setSettingsOpen(false);
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
      // Geometry is constant across idle/running. The compact 88px height
      // keeps the requested 7px top / 1px bottom padding, and the 2px aura
      // border is always present (transparent when idle) so a run starting
      // never shifts the layout below.
      height: 88, boxSizing: "border-box",
      display: "grid", gridTemplateColumns: "auto 1fr auto auto",
      alignItems: "center", padding: "7px 18px 1px 20px", gap: 16,
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
        @keyframes owllm-tab-working {
          0%, 100% {
            box-shadow:
              0 0 0 1px rgba(255,255,255,0.08),
              0 0 8px rgba(176,124,255,0.28),
              0 0 12px rgba(127,212,255,0.18);
          }
          50% {
            box-shadow:
              0 0 0 1px rgba(255,255,255,0.20),
              0 0 18px rgba(176,124,255,0.90),
              0 0 28px rgba(127,212,255,0.55);
          }
        }
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
                maxHeight: "calc(100vh - 86px)", overflowY: "auto",
                // Reads as an extension of the second header: same surface
                // colour, wearing the header's rainbow ring painted
                // padding-box/border-box. Deliberately NOT animated — this is
                // chrome, not an activity signal, so it never spins or glows.
                boxSizing: "border-box",
                background: `linear-gradient(var(--bg-card), var(--bg-card)) padding-box, ${HEADER_AURA_GRADIENT} border-box`,
                color: "var(--fg)",
                border: "2px solid transparent",
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

              {/* Marketplace is a Settings destination, not permanent header
                  chrome. Keep it on a full-width line so the label remains
                  clear at every supported UI scale. */}
              <button
                data-ui="MarketplaceButton"
                onClick={() => { setSettingsOpen(false); onOpenMarketplace(); }}
                title="Open OWLLM Marketplace"
                style={{
                  display: "flex", alignItems: "center", gap: 10, width: "100%",
                  marginTop: 10, padding: "10px 14px", borderRadius: 10, boxSizing: "border-box",
                  background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
                  color: "var(--fg)", cursor: "pointer", textAlign: "left",
                }}
              >
                <span aria-hidden="true" style={{ fontSize: 18, flexShrink: 0 }}>🛍️</span>
                <span style={{ flex: 1, minWidth: 0, fontWeight: 700, fontSize: 13.5 }}>Marketplace</span>
                <span aria-hidden="true" style={{ fontSize: 12.5, fontWeight: 800, color: "var(--fg-muted)", flexShrink: 0 }}>→</span>
              </button>

              {/* Project resources and integrations belong together in one
                  dedicated navigation row instead of consuming workspace tabs. */}
              <div data-ui="SettingsNavigationRow" style={{
                display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 6,
                marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)",
              }}>
                {([
                  { key: "assets", icon: "🖼️", label: "Assets" },
                  { key: "bridges", icon: "🌉", label: "Bridges" },
                  { key: "mcp", icon: "🧩", label: "MCP" },
                  { key: "accounts", icon: "🔐", label: "Accounts" },
                ] as const).map(item => (
                  <button
                    key={item.key}
                    data-ui={`Settings${item.label}Button`}
                    onClick={() => onOpenSettingsPage(item.key)}
                    title={`Open ${item.label}`}
                    style={{
                      minWidth: 0, minHeight: 58, padding: "7px 3px", borderRadius: 8,
                      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4,
                      background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
                      color: "var(--fg)", cursor: "pointer",
                    }}
                  >
                    <span aria-hidden="true" style={{ fontSize: 18, lineHeight: 1 }}>{item.icon}</span>
                    <span style={{
                      maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis",
                      fontSize: 10.5, fontWeight: 700, lineHeight: 1.15,
                    }}>{item.label}</span>
                  </button>
                ))}
              </div>

              {/* Modules — install / update the local inference engine and the
                  other optional runtimes. The ONLY entry point: the wizard's
                  settings mode was unreachable after first run, so a published
                  engine update (the one that teaches llama.cpp a new GGUF
                  architecture) could not be installed at all. */}
              <button
                data-ui="SettingsModulesRow"
                onClick={() => { setSettingsOpen(false); onOpenModules?.(); }}
                title="Install or update the local inference engine and other optional modules"
                style={{
                  display: "flex", alignItems: "center", gap: 10, width: "100%",
                  marginTop: 10, padding: "10px 14px", borderRadius: 10, boxSizing: "border-box",
                  background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
                  color: "var(--fg)", cursor: "pointer", textAlign: "left",
                }}
              >
                <span aria-hidden="true" style={{ fontSize: 18, flexShrink: 0 }}>🧱</span>
                <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontWeight: 700, fontSize: 13.5 }}>Modules</span>
                  <span style={{ fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.35 }}>
                    Local inference engine, speech, and other optional runtimes
                  </span>
                </span>
                {moduleUpdates && moduleUpdates.length > 0 && (
                  <span style={{
                    flexShrink: 0, padding: "2px 8px", borderRadius: 999,
                    background: "rgba(var(--accent-rgb),0.9)", color: "var(--accent-fg)",
                    fontSize: 10.5, fontWeight: 900, whiteSpace: "nowrap",
                  }}>
                    {moduleUpdates.length} update{moduleUpdates.length === 1 ? "" : "s"}
                  </span>
                )}
                <span aria-hidden="true" style={{ fontSize: 12.5, fontWeight: 800, color: "var(--fg-muted)", flexShrink: 0 }}>→</span>
              </button>

              {/* Signing / credential hub entry — its own separate line.
                  Opens the Signing hub as a centered popup (PageModal); it is
                  no longer a header tab, so this dropdown row is its only entry. */}
              <button
                data-ui="SettingsSigningRow"
                onClick={() => onOpenSigning()}
                title="Certificates (Apple + Windows signing) and provider portal web-logins"
                style={{
                  display: "flex", alignItems: "center", gap: 10, width: "100%",
                  marginTop: 10, padding: "10px 14px", borderRadius: 10, boxSizing: "border-box",
                  background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
                  color: "var(--fg)", cursor: "pointer", textAlign: "left",
                }}
              >
                <span aria-hidden="true" style={{ fontSize: 18, flexShrink: 0 }}>🖊</span>
                <span style={{ flex: 1, minWidth: 0, fontWeight: 700, fontSize: 13.5 }}>Certificates and Logs in</span>
                <span aria-hidden="true" style={{ fontSize: 12.5, fontWeight: 800, color: "var(--fg-muted)", flexShrink: 0 }}>→</span>
              </button>

              {/* Keep the guided setup independently discoverable after GitHub
                  is connected. The account row below remains dedicated to
                  sync/account management. */}
              <button
                data-ui="SettingsOnboardingRow"
                onClick={() => { setSettingsOpen(false); openSyncOnboarding(); }}
                title="Open the guided GitHub and AI account setup"
                style={{
                  display: "flex", alignItems: "center", gap: 10, width: "100%",
                  marginTop: 10, padding: "10px 14px", borderRadius: 10, boxSizing: "border-box",
                  background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
                  color: "var(--fg)", cursor: "pointer", textAlign: "left",
                }}
              >
                <span aria-hidden="true" style={{ fontSize: 18, flexShrink: 0 }}>🧭</span>
                <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontWeight: 700, fontSize: 13.5 }}>Finish onboarding</span>
                  <span style={{ fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.35 }}>GitHub and AI account setup</span>
                </span>
                <span aria-hidden="true" style={{ fontSize: 12.5, fontWeight: 800, color: "var(--fg-muted)", flexShrink: 0 }}>→</span>
              </button>

              {/* The same guided first-run journey stays discoverable here when
                  identity is not connected. Once signed in this becomes the
                  compact account-management entry rather than advertising
                  onboarding the user has already completed. */}
              <button
                data-ui="SettingsAccountRow"
                onClick={() => { setSettingsOpen(false); openSyncOnboarding(); }}
                title={account.connected ? "Manage sync / account" : "Finish GitHub and AI account setup"}
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
                    <>
                      <span style={{ fontWeight: 800, fontSize: 14.5, color: "var(--fg-strong)" }}>Finish onboarding</span>
                      <span style={{ fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.35 }}>GitHub sign-in and AI subscription setup</span>
                    </>
                  )}
                </span>
                <span style={{
                  fontSize: 12.5, fontWeight: 800, flexShrink: 0,
                  padding: "6px 12px", borderRadius: 999,
                  background: account.connected ? "rgba(34,197,94,0.18)" : "var(--accent)",
                  color: account.connected ? "#22c55e" : "var(--accent-fg)",
                }}>{account.connected ? "Manage →" : "Continue →"}</span>
              </button>
            </div>
          )}
        </div>

        {/* Mode toggles — single-active. Click toggles back to "home" if
            the same mode is clicked twice. Hidden when the mode isn't
            installed (per getInstalledModes() in modules.ts). */}
        {visibleToggles.map(t => (
          <button
            key={t.id}
            data-ui={t.dataUi}
            onClick={() => {
              if (t.id === "gamify") {
                window.dispatchEvent(new CustomEvent("owllm:navigate", { detail: { key: "world-map" } }));
                return;
              }
              setMode(mode === t.id ? "home" : t.id);
            }}
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

      {/* World Chat push notice — a speech bubble beside the top-centre owl,
          so a message that arrives while the user is on any other page still
          announces itself. Clicking it goes to the conversation. It sits above
          the OWLLM title and to the right of the owl's head, clear of the
          Watcher satellite label (which is vertically centred). */}
      {chatNotice && (
        <>
          {/* The placement is a plain style and never a keyframe: with
              prefers-reduced-motion the animation is dropped, and a bubble
              whose position lived in the keyframes would land on the owl. */}
          <style>{`
            @keyframes owllm-chat-pop {
              0%   { opacity: 0; transform: scale(0.86); }
              100% { opacity: 1; transform: scale(1); }
            }
          `}</style>
          <button
            data-ui="WorldChatNotice"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onOpenChatNotice?.(); }}
            title={`World Chat — ${chatNotice.label}: ${chatNotice.text}`}
            style={{
              position: "absolute",
              left: "50%", top: 6,
              transform: "translateX(80px)",
              transformOrigin: "left center",
              padding: "3px 11px",
              borderRadius: "999px",
              background: "rgba(var(--accent-rgb),0.92)",
              border: "1px solid rgba(var(--accent-rgb),1)",
              color: "#fff", fontSize: 12, fontWeight: 800,
              letterSpacing: 0.3, whiteSpace: "nowrap",
              maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis",
              cursor: "pointer", zIndex: 8,
              boxShadow: "0 2px 10px rgba(0,0,0,0.35)",
            }}
          >
            {/* The sender's name, because "got a message" from nobody in
                particular is a riddle rather than a notification. */}
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              animation: continuousUiAnimation("owllm-chat-pop 220ms ease-out 1 both"),
            }}>
              {/* Their picture when they publish one. Only ever a GitHub
                  avatar URL — the relay refuses any other host — so the
                  bubble cannot be made to fetch from somewhere else. */}
              {chatNotice.avatar && (
                <span
                  data-ui="WorldChatNotice:avatar"
                  aria-hidden="true"
                  style={{
                    width: 16, height: 16, borderRadius: "50%",
                    backgroundImage: `url("${chatNotice.avatar}")`,
                    backgroundSize: "cover", backgroundPosition: "center",
                  }}
                />
              )}
              💬 Got a message{chatNotice.label ? ` from ${chatNotice.label}` : ""}{chatNotice.count > 1 ? ` (${chatNotice.count})` : ""}
            </span>
          </button>
        </>
      )}

      {/* Update announcement — the owl asks, comic-book style, from the LEFT
          edge of a balloon beside its head. It sits below the World Chat chip,
          so either notice can appear without covering the other. Ten seconds,
          clickable, then it hands over to the badge under the OWLLM mark.
          Deliberately not a modal: an update is an invitation, not an
          interruption. */}
      {updateNotice && (
        <>
          <style>{`
            @keyframes owllm-update-bubble-in {
              0%   { opacity: 0; transform: scale(0.7) rotate(-6deg); }
              60%  { opacity: 1; transform: scale(1.06) rotate(1.5deg); }
              100% { opacity: 1; transform: scale(1) rotate(-1.2deg); }
            }
            @keyframes owllm-update-bubble-nudge {
              0%, 100% { transform: rotate(-1.2deg) translateY(0); }
              50%      { transform: rotate(-1.2deg) translateY(-2.5px); }
            }
            .owllm-update-bubble:hover { filter: brightness(1.06); }
          `}</style>
          <button
            data-ui="UpdateNotice"
            className="owllm-update-bubble"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onOpenUpdate?.(); }}
            title={`OwLLM Desktop ${updateNotice} is available — click to update`}
            style={{
              position: "absolute",
              // Keep placement out of `transform`: the entrance/nudge
              // keyframes animate transform continuously and used to override
              // it, silently moving the balloon away from its intended side.
              left: "calc(50% + 92px)", top: 25,
              transformOrigin: "left 28px",
              zIndex: 9,
              width: 268, textAlign: "left",
              padding: "9px 13px 10px",
              // Manga speech balloon: paper-white, thick ink outline, hard
              // offset shadow — the comic vocabulary, not a UI toast.
              background: "#fdfdf7",
              border: "2.5px solid #14181f",
              borderRadius: "18px 18px 20px 18px",
              color: "#14181f",
              boxShadow: "3px 4px 0 rgba(20,24,31,0.85)",
              cursor: "pointer",
              animation: continuousUiAnimation(
                "owllm-update-bubble-in 320ms cubic-bezier(.2,1.4,.4,1) 1 both, owllm-update-bubble-nudge 2.4s ease-in-out 320ms infinite",
              ),
            }}
          >
            <span style={{ display: "block", fontSize: 13.5, fontWeight: 900, lineHeight: 1.28, letterSpacing: 0.1 }}>
              Please, update your app!
            </span>
            <span style={{ display: "block", marginTop: 2, fontSize: 12, fontWeight: 700, lineHeight: 1.3, color: "#2b3444" }}>
              We fixed a few bugs and added cool features!
            </span>
            <span style={{ display: "block", marginTop: 5, fontSize: 10.5, fontWeight: 900, letterSpacing: 0.6, textTransform: "uppercase", color: "#b8330f" }}>
              ⬆ Tap to install v{updateNotice}
            </span>
            {/* The tail, aimed at the owl's beak. Two stacked triangles so the
                ink outline reads as one continuous balloon edge. */}
            <span aria-hidden="true" style={{
              position: "absolute", left: -17, top: 20,
              width: 0, height: 0,
              borderTop: "8px solid transparent",
              borderBottom: "11px solid transparent",
              borderRight: "18px solid #14181f",
            }} />
            <span aria-hidden="true" style={{
              position: "absolute", left: -12, top: 21,
              width: 0, height: 0,
              borderTop: "6px solid transparent",
              borderBottom: "9px solid transparent",
              borderRight: "14px solid #fdfdf7",
            }} />
          </button>
        </>
      )}

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

      {/* Where the offer LIVES once the bubble has had its say: under the
          OWLLM mark, at its bottom-right. Small, quiet, and permanent until the
          update is installed — the previous design had no such resting place, so
          dismissing the dialog lost the update entirely. */}
      {updateBadge && (
        <button
          data-ui="UpdateBadge"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onOpenUpdate?.(); }}
          title={`OwLLM Desktop ${updateBadge} is available — click to update`}
          style={{
            position: "absolute",
            left: "50%", top: "50%",
            transform: "translate(38px, 22px)",
            padding: "2px 9px", borderRadius: 999,
            background: "rgba(var(--accent-rgb),0.9)",
            border: "1px solid rgba(var(--accent-rgb),1)",
            color: "#fff", fontSize: 10.5, fontWeight: 900,
            letterSpacing: 0.4, whiteSpace: "nowrap",
            cursor: "pointer", zIndex: 8,
            boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
          }}
        >
          ⬆ Update available
        </button>
      )}

      {/* Engine/module offer. Sits one line BELOW the app-update chip so the
          two can never overlap, and stands on its own when there is no app
          update at all — which is the normal case, since the module registry
          is republished without shipping a new app. */}
      {moduleUpdates && moduleUpdates.length > 0 && (
        <button
          data-ui="ModuleUpdateBadge"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onOpenModules?.(); }}
          title={moduleUpdates
            .map((m) => `${m.displayName}: ${m.installedVersion} → ${m.availableVersion}`)
            .join("\n")}
          style={{
            position: "absolute",
            left: "50%", top: "50%",
            transform: `translate(38px, ${updateBadge ? 40 : 22}px)`,
            padding: "2px 9px", borderRadius: 999,
            background: "rgba(var(--accent-rgb),0.75)",
            border: "1px solid rgba(var(--accent-rgb),1)",
            color: "var(--accent-fg)", fontSize: 10.5, fontWeight: 900,
            letterSpacing: 0.4, whiteSpace: "nowrap",
            cursor: "pointer", zIndex: 8,
            boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
          }}
        >
          🧱 Engine update
        </button>
      )}
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

      <SysInfoBlock />
      <WindowControls />
    </div>
  );
}

// Header right-block — a live status readout, and nothing more. It used to
// double as a link into the Server modal; that made an always-visible corner
// of the chrome navigate somewhere on any stray click. Server Control is
// reached from its own "Server" tab, which is where a destination belongs.
// Laid out for the 88px header: two compact lines.
function SysInfoBlock() {
  const { server, vram } = useLiveSysInfo();
  // Stopped → "🟢 Servers: 0"; running → "🟢 Servers: N (modelSummary)".
  // ServerStatusLite carries only one server, so N is 0 or 1.
  const fullModelId = server.model_id ?? "?";
  const serverLine = server.running
    ? `🟢 Servers: 1 (${abbreviateModelId(fullModelId)})`
    : "🟢 Servers: 0";
  const vramLine = vram.gpus.length === 0
    ? "VRAM: N/A"
    : vram.gpus
        .map(g => {
          const value = `${(g.used_mib / 1024).toFixed(1)} / ${(g.total_mib / 1024).toFixed(1)} GiB`;
          if (g.unified && g.model_scoped) return `Unified model: ${value}`;
          if (g.unified) return `Unified: ${value}`;
          return `GPU${g.index}: ${value}`;
        })
        .join("   ");
  return (
    <div
      data-ui="SysInfoBlock"
      title={server.running ? `Model: ${fullModelId}` : undefined}
      style={{
        // Narrower and shorter than the pre-0.9.90 block so it fits the
        // 88px header without crowding the mode toggles. overflow:hidden +
        // text-overflow on the children keeps long model ids from pushing
        // the layout.
        width: "min(340px, 26vw)", minWidth: 0, height: 44,
        display: "flex", flexDirection: "column",
        alignItems: "stretch", justifyContent: "center", gap: 2,
        fontSize: 11, fontWeight: 700, color: "var(--bg-header-fg)", textAlign: "right",
        overflow: "hidden",
      }}
    >
      <div data-ui="HeaderServersLabel" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {serverLine}
        <GenSpeedBadge variant="header" active={server.running} />
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
// Page keys that should be right-aligned in the SubTabs row: Info,
// Server, and remaining utility pages. Settings destinations are kept
// mounted in the page list but filtered from this workspace tab strip.
const RIGHT_ALIGNED_KEYS = new Set(["info", "server", "environment", "devices", "logs"]);
const SETTINGS_NAV_KEYS = new Set(["assets", "bridges", "mcp", "accounts"]);

function SubTabs({
  pages, activeKey, onChange,
}: {
  pages: PageDef[];
  activeKey: string;
  onChange: (key: string) => void;
}) {
  const runActive = useRunActive();
  const runVersion = useRunActivityVersion();

  // Per-page "working" from the live run tags — the Coding button lights for
  // "code:*"/"stream:code:*", the Agents button for "agents:*". Recomputed on
  // every run-activity change (runVersion) so one family stopping while another
  // runs still clears the right button; the aggregate `runActive` can't.
  const workingByKey = useMemo(() => {
    const m: Record<string, boolean> = {};
    for (const p of pages) {
      if (isWorkflowAwarePage(p.key)) m[p.key] = isRunActiveMatching(runPrefixesForPage(p.key));
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, runVersion]);

  // Working → finished-badge conversion: a run that ends while you're on
  // another tab leaves a "✓ finished (unseen)" badge on its button until you
  // open it. stepTabActivity returns prev unchanged when nothing moved, so this
  // updater can't loop.
  const [tabActivity, setTabActivity] = useState(initTabActivity);
  useEffect(() => {
    setTabActivity((prev) => stepTabActivity(prev, workingByKey, activeKey));
  }, [workingByKey, activeKey]);

  const renderTab = (p: PageDef) => {
    const active = p.key === activeKey;
    const working = workingByKey[p.key] ?? false;
    const done = showFinishedBadge(tabActivity, p.key, working);
    return (
      <div
        key={p.key}
        role="button"
        tabIndex={0}
        onClick={() => onChange(p.key)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onChange(p.key);
        }}
        title={working ? `${p.label} — working…` : done ? `${p.label} — finished (unseen)` : undefined}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "5px 14px",
          background: active ? "rgba(var(--accent-rgb),0.28)" : "transparent",
          color: active ? "#fafafa" : "var(--fg-muted)",
          borderRadius: 8,
          fontWeight: 600,
          borderBottom: active ? "3px solid var(--accent)" : "3px solid transparent",
          cursor: "pointer",
          userSelect: "none",
          // Same pulse the page's own tab strip uses while a run is live.
          animation: working ? HEADER_TAB_WORKING_ANIMATION : undefined,
        }}
      >
        {/* Live rainbow dot while this page is working (matches its tab strip). */}
        {working && (
          <span title="Working" style={{
            flexShrink: 0, width: 8, height: 8, borderRadius: "50%",
            background: HEADER_TAB_AURA_DOT,
            boxShadow: "0 0 0 1px rgba(255,255,255,0.20), 0 0 8px rgba(176,124,255,0.85), 0 0 12px rgba(127,212,255,0.45)",
          }} />
        )}
        <span>{p.label}</span>
        {/* Finished-while-away check — cleared when you open the page. Never
            shown while working, so the glow and badge can't collide. */}
        {done && (
          <span title="Finished — click to view" style={{
            flexShrink: 0, fontSize: 12, fontWeight: 900, lineHeight: 1,
            color: "transparent",
            background: HEADER_TAB_AURA_DOT,
            WebkitBackgroundClip: "text", backgroundClip: "text",
            filter: "drop-shadow(0 0 5px rgba(176,124,255,0.85)) drop-shadow(0 0 8px rgba(127,212,255,0.45))",
          }}>✓</span>
        )}
      </div>
    );
  };

  const tabPages = pages.filter(p => !SETTINGS_NAV_KEYS.has(p.key));
  const leftTabs  = tabPages.filter(p => !RIGHT_ALIGNED_KEYS.has(p.key));
  const rightRaw  = tabPages.filter(p =>  RIGHT_ALIGNED_KEYS.has(p.key));
  // Fixed right-cluster order: remaining utilities first, then Server,
  // then Info pinned last. Assets, Bridges, MCP, and Accounts live in
  // the dedicated Settings navigation row.
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
      // Marks the whole popup as an overlay so the Settings dropdown that
      // opened it treats clicks in here as "still working", not "dismiss".
      data-owllm-overlay="1"
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

// Linux uses one opaque WebKitGTK window. The transparent overlay is disabled
// there because it is unstable on NVIDIA/Jetson, but that must not make the
// opaque main window draw HybridFrame's formerly-transparent outer margin as a
// thick solid rectangle. Detect Linux once and render the app content directly.
const IS_LINUX = typeof navigator !== "undefined" && /Linux/i.test(navigator.userAgent);

export default function AppShell() {
  const installed = useMemo(() => getInstalledModes(), []);
  useLocalServerKeySync();
  useUncleanShutdownNotice();
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
  // Every Settings destination (Assets, Bridges, MCP, Accounts) opens as a
  // popup over the current workspace instead of stealing the active tab, so
  // opening one never disrupts the work in progress. One key drives them all.
  const [settingsModalKey, setSettingsModalKey] = useState<string | null>(null);
  const [signingModalOpen, setSigningModalOpen] = useState<boolean>(false);
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

  // Ctrl+mouse-wheel resizes the text in the currently focused/hovered chat,
  // notebook, brainstorm, or code text box — the same shared step the Settings
  // +/- buttons drive, so it clamps to the readable range and persists the same
  // way. Listener is non-passive so preventDefault can suppress the browser's
  // own Ctrl+wheel page zoom; it only fires when the gesture starts over a
  // zoomable text surface (or one is focused), never over the rest of the app.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      if (!isChatZoomTarget(e.target as Element | null) && !isChatZoomTarget(document.activeElement)) return;
      e.preventDefault();
      setChatFontStep((step) => nextChatFontStep(step, e.deltaY));
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, []);

  // Windows draws the decorative art in a separate click-through webview.
  // Rust relays the visibility there (CSS fade on Windows/macOS, native unmap
  // on Linux). It can be neither a Tauri event nor a localStorage write: no
  // capability covers the overlay window, and any localStorage access binds it
  // to the origin's storage area, replicating every same-origin mutation —
  // including the Code page's ~1.5 MB session blob, re-persisted on a 250ms
  // debounce — into a renderer that never drains them. That leaked ~45 MB/min.
  // See src-tauri/src/overlay_frame.rs.
  useEffect(() => {
    if (!isTauri()) return;
    invoke("overlay_frame_set_visible", { visible: frameVisible }).catch(() => {
      /* overlay disabled */
    });
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
  // World Chat push notice. A message can arrive on any page — the World Map
  // is one tab among many — so the owl in the top-centre of the frame is where
  // it is announced.
  //
  // It is derived from the unread counts and NOT from a timer: a notice that
  // faded after a few seconds took the message with it — you were left knowing
  // something had arrived and with no way back to it. This one names the
  // sender, survives a restart, and stays until the conversation is opened.
  const [chatNotice, setChatNotice] = useState<{ key: string; label: string; avatar: string; text: string; count: number } | null>(null);
  useEffect(() => subscribeWorldChat((state) => {
    const count = worldChatUnreadCount(state);
    const newest = count ? worldChatConversations(state).find((entry) => entry.unread > 0) : undefined;
    setChatNotice(newest ? { key: newest.key, label: newest.label, avatar: newest.avatar, text: newest.last?.text ?? "", count } : null);
  }), []);
  const openChatNotice = () => {
    if (chatNotice) openWorldChatThread(chatNotice.key);
  };

  // Update offer. The owl greets ONCE per version per session (the bubble), then
  // the badge under the OWLLM mark carries it for as long as the update stands.
  const updateVersion = React.useSyncExternalStore(
    subscribeUpdateAvailability,
    () => getUpdateAvailability().version,
  );
  const [updateNotice, setUpdateNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!updateVersion) { setUpdateNotice(null); return; }
    if (!shouldAnnounceUpdate(updateVersion)) return;
    markUpdateAnnounced(updateVersion);
    setUpdateNotice(updateVersion);
    const t = window.setTimeout(() => setUpdateNotice(null), UPDATE_NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [updateVersion]);

  // A balloon is the OWL talking, so the owl has to be on screen while it does.
  // The decorative frame — which is where the owl lives, inline in HybridFrame
  // on macOS and in the click-through overlay window on Windows — idles away
  // FRAME_IDLE_HIDE_MS after launch, long before the updater's first check
  // lands (2.5s) or a World Chat message arrives. The balloon then floated over
  // the header with its tail pointing at nothing. Reveal the frame for as long
  // as either notice is up, then hand back to the normal idle-hide (which
  // keepFrameVisible still overrides).
  const noticeShowing = Boolean(updateNotice || chatNotice);
  useEffect(() => {
    if (!noticeShowing) return;
    revealFrame();
    return () => hideFrameAfter(FRAME_LEAVE_HIDE_MS);
  }, [noticeShowing]);

  // Module offers (the local-inference engine above all). Separate from the app
  // update: the registry is republished on its own schedule, and an engine that
  // cannot load current models is worth its own badge rather than waiting for
  // the next app release to mention it.
  const moduleUpdates = React.useSyncExternalStore(subscribeModuleUpdates, getModuleUpdates);

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
    // Keep Advanced page components reachable regardless of active mode.
    // MCP and Accounts are opened from the Settings navigation row rather
    // than consuming persistent workspace tabs.
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
      // "server" / the Settings destinations are modals — intercept here so
      // external nav requests open the popup instead of trying to switch to a
      // (no-longer-rendered-inline) tab.
      if (key === "server") { setServerModalOpen(true); return; }
      if (SETTINGS_NAV_KEYS.has(key)) { setSettingsModalKey(key); return; }
      if (key === "signing") { setSigningModalOpen(true); return; }
      // Find which module owns this page key so the ModeBar and SubTabs stay
      // in the same workspace. Core pages must clear an active mode too;
      // otherwise a navigate-to-Home event leaves `mode=finetuning` with
      // `activeKey=home`, so the header and page content disagree.
      const owner = ALL_MODULES.find(m => m.pages.some(p => p.key === key));
      if (owner?.id === "core") setMode("home");
      else if (owner?.id === "finetuning" || owner?.id === "agentic" || owner?.id === "gamify") {
        setMode(owner.id);
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
    if (SETTINGS_NAV_KEYS.has(key)) { setSettingsModalKey(key); return; }
    setActiveKey(key);
  };

  // Resolve the Settings popup's page from the module registry rather than a
  // per-page import, so every destination stays reachable even when its owning
  // module is not the active mode.
  const settingsModalPage = useMemo(
    () => (settingsModalKey
      ? ALL_MODULES.flatMap(m => m.pages).find(p => p.key === settingsModalKey)
      : undefined),
    [settingsModalKey],
  );

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
            onOpenSigning={() => setSigningModalOpen(true)}
            onOpenMarketplace={() => {
              openWebUrl(MARKETPLACE_URL)
                .catch((error) => console.error("Could not open OWLLM Marketplace", error));
            }}
            onOpenSettingsPage={(key) => {
              window.dispatchEvent(new CustomEvent("owllm:navigate", { detail: { key } }));
            }}
            onWatcher={openWatcher}
            watcherHint={watcherHint && overlayFrame}
            chatNotice={chatNotice}
            onOpenChatNotice={openChatNotice}
            updateNotice={updateNotice}
            // The badge takes over the moment the bubble is done, and is the
            // only surface while a later session re-finds the same version.
            updateBadge={updateVersion && !updateNotice ? updateVersion : null}
            onOpenUpdate={requestUpdateInstall}
            moduleUpdates={moduleUpdates}
            onOpenModules={openModulesPage}
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
      <WorldPresenceRunner />
      <TelegramBridgeRunner />
      <DiscordBridgeRunner />
      <SlackBridgeRunner />
      <EmailBridgeRunner />
      <WebhookBridgeRunner />
      <ResizeEdges />
      {!IS_LINUX && <WindowAccentEdge />}
      {overlayFrame
        ? <OverlayContentPanel>{appContent}</OverlayContentPanel>
        : IS_LINUX
          ? <div data-ui="LinuxMainContent" style={{ width: "100%", height: "100%", background: "var(--bg-panel)" }}>{appContent}</div>
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
      {settingsModalPage && (
        <PageModal
          title={settingsModalPage.label}
          dataUi="SettingsPageModal"
          onClose={() => setSettingsModalKey(null)}
        >
          <settingsModalPage.component />
        </PageModal>
      )}
      {signingModalOpen && (
        <PageModal
          title="🖊 Signing & credentials"
          dataUi="SigningModal"
          onClose={() => setSigningModalOpen(false)}
        >
          <SigningPage />
        </PageModal>
      )}
      <TutorialRecorder enabled={true} />
      <FirstRunWizardMount />
      <ModulesPageMount />
      <ModuleUpdateWatcher />
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
function WorldPresenceRunner() {
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void getIdentity()
      .then(async (identity) => ({
        // Rust derives the same hash without needing `crypto.subtle`, which is
        // secure-context-only; the webview hash stays as the browser-dev path.
        nodeId: identity.presence_id || await presenceNodeIdForDevice(identity.device_id),
        appVersion: identity.app_version,
      }))
      .then(({ nodeId, appVersion }) => {
        // chatHooks is undefined unless the user turned World Chat on, in which
        // case no key is ever presented and the socket stays anonymous.
        if (!disposed) stop = installWorldPresenceConnection({ nodeId, appVersion, chatHooks: worldChatHooks() });
      })
      .catch(async () => {
        // No native identity (browser-only development, or a device that cannot
        // read its own keypair): connect with NO id. The service shows the dot
        // while it is live and records nothing, so repeated launches can never
        // become repeated "users" — that is what a random fallback id did.
        //
        // The VERSION is still sent. It does not come from the identity — the
        // app knows its own build without any keypair — and dropping it here was
        // the one code path that could put an ONLINE dot on the map with
        // "Version unknown" beside it.
        const appVersion = await getVersion().catch(() => undefined);
        if (!disposed) stop = installWorldPresenceConnection({ appVersion });
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  return null;
}

function FirstRunWizardMount() {
  const { needed, setDismissed } = useNeedsFirstRunWizard();
  if (!needed) return null;
  return <ModuleWizard mode="first-run" onClose={setDismissed} />;
}

// The Modules page, on demand — the ONLY route to it after first run.
//
// `useNeedsFirstRunWizard()` goes false as soon as anything is installed, so
// until this mount existed the settings mode of ModuleWizard was dead code and
// a published module update was uninstallable: no button, no menu entry, no
// route. The local-inference crash hint told users to go there by name.
function ModulesPageMount() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_MODULES_EVENT, show as EventListener);
    return () => window.removeEventListener(OPEN_MODULES_EVENT, show as EventListener);
  }, []);
  if (!open) return null;
  return <ModuleWizard mode="settings" onClose={() => { setOpen(false); void checkModuleUpdates(); }} />;
}

/// Ask the backend which installed modules have a newer build waiting and
/// publish the answer to runtime/moduleUpdates. Safe to call at any time; a
/// backend that isn't ready yet just leaves the previous answer standing.
async function checkModuleUpdates(): Promise<void> {
  try {
    const mods = await invoke<Array<{
      id: string; displayName: string; state: string;
      installedVersion: string | null; availableVersion: string | null;
    }>>("module_list");
    const pending: ModuleUpdate[] = mods
      .filter((m) => m.state === "update-available")
      .map((m) => ({
        id: m.id,
        displayName: m.displayName,
        installedVersion: m.installedVersion ?? "",
        availableVersion: m.availableVersion ?? "",
      }));
    setModuleUpdates(pending);
  } catch {
    // Module manager not up yet, or offline — the repeating check retries.
  }
}

// Same cadence as the app updater (UpdatePrompt): once shortly after launch,
// then every 6 hours. A one-shot check is how installs sit for months on an
// engine that cannot load current models — the registry is republished
// independently of the app, so "nothing new at launch" expires fast.
function ModuleUpdateWatcher() {
  useEffect(() => {
    if (typeof window === "undefined" || !(window as any).__TAURI_INTERNALS__) return;
    const first = window.setTimeout(() => { void checkModuleUpdates(); }, 4000);
    const iv = window.setInterval(() => { void checkModuleUpdates(); }, 6 * 60 * 60 * 1000);
    // The backend now installs these on its own (modules::spawn_auto_maintenance).
    // Re-check the moment one lands, or the badge would advertise an update
    // that is already installed for up to six more hours.
    let unlisten: UnlistenFn | null = null;
    let dropped = false;
    void listen<{ stage?: string }>("module-progress", (evt) => {
      if (evt.payload?.stage === "completed") void checkModuleUpdates();
    }).then((fn) => { if (dropped) { try { fn(); } catch {} } else { unlisten = fn; } });
    return () => {
      dropped = true;
      window.clearTimeout(first);
      window.clearInterval(iv);
      try { unlisten?.(); } catch {}
    };
  }, []);
  return null;
}
