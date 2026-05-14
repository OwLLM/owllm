// Theme — mode (dark/light) + accent (one of six named colours).
//
// The hook owns React state, persists to localStorage, and writes the
// `data-theme` attribute + an `--accent` / `--accent-rgb` /
// `--accent-soft` / `--accent-strong` / `--accent-glow-*` set of CSS
// custom properties on <html>. Components read those values via
// `var(--token)`. styles.css carries the rest of the token table
// (--bg-panel, --fg-muted, etc) keyed off `data-theme`.

import { useEffect, useState } from "react";

export type Mode = "dark" | "light";

export type AccentKey =
  | "indigo" | "amber" | "red" | "blue" | "emerald" | "slate";

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
function readAccent(): AccentKey {
  try {
    const v = localStorage.getItem(LS_ACCENT);
    if (v && ACCENTS.some(a => a.key === v)) return v as AccentKey;
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

// Pick a readable foreground on top of the accent fill. Buttons that
// use `--accent` as background read this as their text colour so the
// label stays legible whether the accent is amber or slate.
function pickAccentFg(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  // Relative luminance — simple sRGB approximation.
  const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return L > 0.55 ? "#06080d" : "#ffffff";
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
}

function applyMode(mode: Mode) {
  document.documentElement.setAttribute("data-theme", mode);
}

export function useTheme() {
  const [mode, setModeState] = useState<Mode>(() => readMode());
  const [accentKey, setAccentKeyState] = useState<AccentKey>(() => readAccent());

  const accent = ACCENTS.find(a => a.key === accentKey) ?? ACCENTS[0];

  useEffect(() => {
    applyMode(mode);
    try { localStorage.setItem(LS_MODE, mode); } catch { /* ignore */ }
  }, [mode]);

  useEffect(() => {
    applyAccent(accent.color);
    try { localStorage.setItem(LS_ACCENT, accentKey); } catch { /* ignore */ }
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
