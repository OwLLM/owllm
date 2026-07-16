// Theme — mode (dark/light) + accent (a named swatch or custom colour).
//
// The hook owns React state, persists to localStorage, and writes the
// `data-theme` attribute + an `--accent` / `--accent-rgb` /
// `--accent-soft` / `--accent-strong` / `--accent-glow-*` set of CSS
// custom properties on <html>. Components read those values via
// `var(--token)`. styles.css carries the rest of the token table
// (--bg-panel, --fg-muted, etc) keyed off `data-theme`.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type Mode = "dark" | "light";

export type AccentKey =
  | "indigo" | "amber" | "red" | "blue" | "emerald" | "slate";

// Named swatches stay stable for the compact selector, while the full-palette
// control persists its concrete colour in the same key. Keeping one persisted
// value means the main window, browser chrome, and overlay frame cannot drift.
export type AccentSelection = AccentKey | `#${string}`;

export type AccentDef = { key: AccentKey; label: string; color: string };

// The six squares in the header. The first is the canonical default
// (matches the old `#5cf0ff` cyan vibe in feel, just slightly muted).
export const ACCENTS: AccentDef[] = [
  { key: "indigo",  label: "Indigo",  color: "#667eea" },
  { key: "amber",   label: "Amber",   color: "#fbbf24" },
  { key: "red",     label: "Red",     color: "#ef4444" },
  { key: "blue",    label: "Blue",    color: "#3b82f6" },
  { key: "emerald", label: "Emerald", color: "#10b981" },
  { key: "slate",   label: "Slate",   color: "#6b7280" },
];

const LS_MODE = "owllm:theme:mode";
const LS_ACCENT = "owllm:theme:accent";

function readMode(): Mode {
  try {
    const v = localStorage.getItem(LS_MODE);
    if (v === "dark" || v === "light") return v;
  } catch { /* localStorage blocked */ }
  return "dark";
}
function isHexAccent(value: string): value is `#${string}` {
  return /^#[0-9a-f]{6}$/i.test(value);
}

function readAccent(): AccentSelection {
  try {
    const v = localStorage.getItem(LS_ACCENT);
    if (v && ACCENTS.some(a => a.key === v)) return v as AccentKey;
    if (v && isHexAccent(v)) return v;
  } catch { /* ignore */ }
  return "indigo";
}

function hexToRgb(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

// sRGB-style relative luminance for an "is this colour bright?" check.
function luminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function hexToRgbTriplet(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

// Pick a readable foreground on top of the PURE accent fill. Buttons
// that use `--accent` as background read this as their text colour so
// the label stays legible whether the accent is amber or slate.
function pickAccentFg(hex: string): string {
  const { r, g, b } = hexToRgbTriplet(hex);
  return luminance(r, g, b) > 0.55 ? "#06080d" : "#ffffff";
}

// Pick a readable foreground on top of --bg-header. The header
// background recipe differs per theme mode:
//   dark  → color-mix(in srgb, var(--accent) 70%, #1c2244)  (mostly accent + navy)
//   light → color-mix(in srgb, var(--accent) 35%, #e4e7ec)  (mostly grey + accent tint)
// We compute BOTH foreground values and let CSS pick the right one
// per data-theme, so the dark-mode header keeps WHITE labels even on
// amber (the bronze bg is dark enough that white reads cleanly), while
// the light-mode header gets BLACK labels on the much brighter tinted
// grey. Was a single threshold that mis-fired on amber dark.
const NAVY_R = 28,  NAVY_G = 34,  NAVY_B = 68;   // #1c2244 — dark-mode bg-header base
const LITE_R = 228, LITE_G = 231, LITE_B = 236;  // #e4e7ec — light-mode bg-header base

function pickHeaderFgForBg(accentHex: string, baseR: number, baseG: number, baseB: number, accentMixPct: number): string {
  const a = hexToRgbTriplet(accentHex);
  const r = accentMixPct * a.r + (1 - accentMixPct) * baseR;
  const g = accentMixPct * a.g + (1 - accentMixPct) * baseG;
  const b = accentMixPct * a.b + (1 - accentMixPct) * baseB;
  // Cut-off 0.55 — pure-white-readable up to mid-bright; only on
  // genuinely bright backgrounds (≥ 0.55) does the label flip to
  // black for contrast.
  return luminance(r, g, b) > 0.55 ? "#06080d" : "#ffffff";
}

// Resolve the `--bg-header` recipe (70 % accent over the #1c2244 navy base —
// same in both theme modes, see styles.css) to a concrete hex. The agent
// browser paints its NATIVE window title bar with this so its popup window
// wears the same chrome as the app.
function resolveHeaderHex(accentHex: string): string {
  const a = hexToRgbTriplet(accentHex);
  const mix = (c: number, base: number) => Math.round(0.70 * c + 0.30 * base)
    .toString(16).padStart(2, "0");
  return `#${mix(a.r, NAVY_R)}${mix(a.g, NAVY_G)}${mix(a.b, NAVY_B)}`;
}

function applyAccent(hex: string) {
  const root = document.documentElement;
  const rgb = hexToRgb(hex);
  root.style.setProperty("--accent", hex);
  root.style.setProperty("--accent-rgb", rgb);
  root.style.setProperty("--accent-fg", pickAccentFg(hex));
  root.style.setProperty("--accent-soft", `rgba(${rgb}, 0.18)`);
  root.style.setProperty("--accent-strong", `rgba(${rgb}, 0.55)`);
  root.style.setProperty("--accent-glow-soft", `rgba(${rgb}, 0.35)`);
  root.style.setProperty("--accent-glow-strong", `rgba(${rgb}, 0.65)`);
  // Header fg per theme mode — set BOTH and let styles.css route
  // --bg-header-fg to the right one via data-theme. Dark-mode header
  // stays white-on-tinted-navy for every accent; only the bright
  // light-mode header (mostly grey + accent) flips to black on amber
  // / blue / etc.
  root.style.setProperty("--bg-header-fg-dark",
    pickHeaderFgForBg(hex, NAVY_R, NAVY_G, NAVY_B, 0.70));
  root.style.setProperty("--bg-header-fg-light",
    pickHeaderFgForBg(hex, LITE_R, LITE_G, LITE_B, 0.35));
  // Push the resolved chrome colour to the backend so the agent-browser
  // window's native title bar matches the app (applied live if it's open,
  // stored for the next open otherwise). Cosmetic — swallow failures
  // (non-Tauri ctx, or a backend older than this UI).
  try {
    invoke("browser_set_chrome", { bg: resolveHeaderHex(hex) })
      .catch(() => { /* ignore */ });
  } catch { /* not in Tauri ctx */ }
}

function applyMode(mode: Mode) {
  document.documentElement.setAttribute("data-theme", mode);
}

export function useTheme() {
  const [mode, setModeState] = useState<Mode>(() => readMode());
  const [accentKey, setAccentKeyState] = useState<AccentSelection>(() => readAccent());

  const accent = isHexAccent(accentKey)
    ? { key: accentKey, label: "Custom", color: accentKey }
    : (ACCENTS.find(a => a.key === accentKey) ?? ACCENTS[0]);

  useEffect(() => {
    applyMode(mode);
    try { localStorage.setItem(LS_MODE, mode); } catch { /* ignore */ }
  }, [mode]);

  useEffect(() => {
    applyAccent(accent.color);
    try { localStorage.setItem(LS_ACCENT, accentKey); } catch { /* ignore */ }
    // Push to the overlay-frame webview so its cyan corners flip
    // immediately on a picker click (cold-boot is handled by the
    // overlay's own localStorage read).
    try {
      const tauri = (window as any).__TAURI__;
      if (tauri?.event?.emit) {
        tauri.event.emit("owllm:accent-changed", accentKey);
      }
    } catch { /* not in Tauri ctx */ }
  }, [accentKey, accent.color]);

  return {
    mode, accentKey, accent,
    setMode: setModeState,
    setAccentKey: setAccentKeyState,
    toggleMode: () => setModeState(m => m === "dark" ? "light" : "dark"),
  };
}

// Bootstrap apply — call once before React mounts so the very first
// frame paints with the correct theme (no flash of unstyled content).
export function bootstrapTheme() {
  const mode = readMode();
  const accentKey = readAccent();
  const accent = ACCENTS.find(a => a.key === accentKey) ?? ACCENTS[0];
  applyMode(mode);
  applyAccent(accent.color);
}
