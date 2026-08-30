export type Mode = "dark" | "light";

export type AccentKey = "cyan" | "indigo" | "amber" | "red" | "blue" | "emerald" | "slate";

export type AccentSelection = AccentKey | `#${string}`;

export interface AccentDef {
  key: AccentKey;
  label: string;
  color: `#${string}`;
}

export const ACCENTS: AccentDef[] = [
  { key: "cyan", label: "OWLLM cyan", color: "#5cf0ff" },
  { key: "indigo", label: "Indigo", color: "#667eea" },
  { key: "amber", label: "Amber", color: "#fbbf24" },
  { key: "red", label: "Red", color: "#ef4444" },
  { key: "blue", label: "Blue", color: "#3b82f6" },
  { key: "emerald", label: "Emerald", color: "#10b981" },
  { key: "slate", label: "Slate", color: "#6b7280" },
];

export const THEME_MODE_KEY = "owllm:site:theme:mode";
export const THEME_ACCENT_KEY = "owllm:site:theme:accent";
export const DEFAULT_MODE: Mode = "dark";
export const DEFAULT_ACCENT: AccentSelection = "cyan";

export function isHexColor(value: string): value is `#${string}` {
  return /^#[0-9a-f]{6}$/i.test(value);
}

export function resolveAccent(selection: AccentSelection): `#${string}` {
  if (isHexColor(selection)) return selection;
  return (ACCENTS.find((accent) => accent.key === selection) ?? ACCENTS[0]).color;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const normalized = hex.replace("#", "");
  if (!/^([0-9a-f]{6})$/i.test(normalized)) return null;
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
}

export function applyAccentToDocument(selection: AccentSelection, doc: Document = document) {
  const color = resolveAccent(selection);
  const rgb = hexToRgb(color);
  const root = doc.documentElement;
  if (rgb) {
    root.style.setProperty("--accent", color);
    root.style.setProperty("--accent-rgb", `${rgb.r}, ${rgb.g}, ${rgb.b}`);
    root.style.setProperty("--accent-soft", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.18)`);
    root.style.setProperty("--accent-strong", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.55)`);
    root.style.setProperty("--accent-glow-soft", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.35)`);
    root.style.setProperty("--accent-glow-strong", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.65)`);
  }
}

export function getInitialMode(): Mode {
  if (typeof window === "undefined") return DEFAULT_MODE;
  try {
    const stored = localStorage.getItem(THEME_MODE_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    /* ignore */
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : DEFAULT_MODE;
}

export function getInitialAccent(): AccentSelection {
  if (typeof window === "undefined") return DEFAULT_ACCENT;
  try {
    const stored = localStorage.getItem(THEME_ACCENT_KEY);
    if (stored) {
      if (ACCENTS.some((a) => a.key === stored)) return stored as AccentKey;
      if (isHexColor(stored)) return stored;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_ACCENT;
}
