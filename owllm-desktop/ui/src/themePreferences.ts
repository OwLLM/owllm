export type Mode = "dark" | "light";

export type AccentKey =
  | "indigo" | "amber" | "red" | "blue" | "emerald" | "slate";

export type AccentSelection = AccentKey | `#${string}`;
export type TextColorSelection = "auto" | `#${string}`;
export type AccentDef = { key: AccentKey; label: string; color: string };

export const ACCENTS: AccentDef[] = [
  { key: "indigo",  label: "Indigo",  color: "#667eea" },
  { key: "amber",   label: "Amber",   color: "#fbbf24" },
  { key: "red",     label: "Red",     color: "#ef4444" },
  { key: "blue",    label: "Blue",    color: "#3b82f6" },
  { key: "emerald", label: "Emerald", color: "#10b981" },
  { key: "slate",   label: "Slate",   color: "#6b7280" },
];

export const THEME_MODE_KEY = "owllm:theme:mode";
export const THEME_GUI_COLOR_KEY = "owllm:theme:accent";
export const THEME_TEXT_COLOR_KEY = "owllm:theme:text-color";
export const DEFAULT_MODE: Mode = "dark";
export const DEFAULT_GUI_COLOR: AccentSelection = "indigo";
export const DEFAULT_TEXT_COLOR: TextColorSelection = "auto";
export const MODE_TEXT_DEFAULTS: Record<Mode, `#${string}`> = {
  dark: "#e6e8eb",
  light: "#1a1f2c",
};

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(storage?: ThemeStorage): ThemeStorage | null {
  if (storage) return storage;
  try { return typeof localStorage === "undefined" ? null : localStorage; }
  catch { return null; }
}

export function isHexColor(value: string): value is `#${string}` {
  return /^#[0-9a-f]{6}$/i.test(value);
}

export function readMode(storage?: ThemeStorage): Mode {
  try {
    const value = browserStorage(storage)?.getItem(THEME_MODE_KEY);
    if (value === "dark" || value === "light") return value;
  } catch { /* storage unavailable */ }
  return DEFAULT_MODE;
}

export function readGuiColor(storage?: ThemeStorage): AccentSelection {
  try {
    const value = browserStorage(storage)?.getItem(THEME_GUI_COLOR_KEY);
    if (value && ACCENTS.some(accent => accent.key === value)) return value as AccentKey;
    if (value && isHexColor(value)) return value;
  } catch { /* storage unavailable */ }
  return DEFAULT_GUI_COLOR;
}

export function readTextColor(storage?: ThemeStorage): TextColorSelection {
  try {
    const value = browserStorage(storage)?.getItem(THEME_TEXT_COLOR_KEY);
    if (value === "auto" || (value && isHexColor(value))) return value;
  } catch { /* storage unavailable */ }
  return DEFAULT_TEXT_COLOR;
}

export function saveMode(value: Mode, storage?: ThemeStorage) {
  try { browserStorage(storage)?.setItem(THEME_MODE_KEY, value); }
  catch { /* storage unavailable */ }
}

export function saveGuiColor(value: AccentSelection, storage?: ThemeStorage) {
  try { browserStorage(storage)?.setItem(THEME_GUI_COLOR_KEY, value); }
  catch { /* storage unavailable */ }
}

export function saveTextColor(value: TextColorSelection, storage?: ThemeStorage) {
  try { browserStorage(storage)?.setItem(THEME_TEXT_COLOR_KEY, value); }
  catch { /* storage unavailable */ }
}

export function resolveGuiColor(selection: AccentSelection): `#${string}` {
  if (isHexColor(selection)) return selection;
  return (ACCENTS.find(accent => accent.key === selection) ?? ACCENTS[0]).color as `#${string}`;
}

export function resolveTextColor(selection: TextColorSelection, mode: Mode): `#${string}` {
  return selection === "auto" ? MODE_TEXT_DEFAULTS[mode] : selection;
}

type Rgb = { r: number; g: number; b: number };
export type TextThemeTokens = {
  base: `#${string}`;
  strong: `#${string}`;
  muted: `#${string}`;
  subtle: `#${string}`;
  dim: `#${string}`;
};

function rgb(hex: string): Rgb {
  const value = hex.slice(1);
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function hex(value: Rgb): `#${string}` {
  const channel = (part: number) => Math.round(part).toString(16).padStart(2, "0");
  return `#${channel(value.r)}${channel(value.g)}${channel(value.b)}`;
}

function mix(foreground: string, background: string, amount: number): `#${string}` {
  const fg = rgb(foreground);
  const bg = rgb(background);
  return hex({
    r: amount * fg.r + (1 - amount) * bg.r,
    g: amount * fg.g + (1 - amount) * bg.g,
    b: amount * fg.b + (1 - amount) * bg.b,
  });
}

function relativeLuminance(color: string): number {
  const value = rgb(color);
  const linear = (channel: number) => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(value.r) + 0.7152 * linear(value.g) + 0.0722 * linear(value.b);
}

export function contrastRatio(first: string, second: string): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function themeSurfaces(mode: Mode, guiColor: string): `#${string}`[] {
  const recipes = mode === "dark"
    ? [["#06080d", 0.22], ["#0e1117", 0.25], ["#11151e", 0.30], ["#1a1f2c", 0.32], ["#0f0f19", 0.18]] as const
    : [["#f0f2f5", 0.15], ["#ffffff", 0.12], ["#f7f8fa", 0.18], ["#ffffff", 0.12], ["#ffffff", 0.10]] as const;
  return recipes.map(([neutral, accentAmount]) => mix(guiColor, neutral, accentAmount));
}

export function minimumThemeContrast(textColor: string, mode: Mode, guiColor: string): number {
  return Math.min(...themeSurfaces(mode, guiColor).map(surface => contrastRatio(textColor, surface)));
}

function ensureContrast(preferred: string, surfaces: string[], targetRatio: number, mode: Mode): `#${string}` {
  const anchor = mode === "dark" ? "#ffffff" : "#06080d";
  for (let step = 0; step <= 100; step += 1) {
    const candidate = mix(anchor, preferred, step / 100);
    if (surfaces.every(surface => contrastRatio(candidate, surface) >= targetRatio)) return candidate;
  }
  return anchor;
}

// Derive the semantic foreground family from the user's preferred colour.
// The preference (and therefore its hue) is retained whenever it is readable;
// otherwise it is moved only as far as necessary toward the mode's contrast
// anchor. Accent-filled controls keep using --accent-fg independently.
export function buildTextThemeTokens(preferred: string, mode: Mode, guiColor: string): TextThemeTokens {
  const surfaces = themeSurfaces(mode, guiColor);
  const surfaceAverage = mode === "dark" ? "#151a24" : "#f5f6f8";
  return {
    strong: ensureContrast(preferred, surfaces, 7, mode),
    // Keep body copy above the minimum tier so the 4.5:1 muted token remains
    // visibly distinct even when an extreme preference must be corrected.
    base: ensureContrast(preferred, surfaces, 5.5, mode),
    muted: ensureContrast(mix(surfaceAverage, preferred, 0.24), surfaces, 4.5, mode),
    subtle: ensureContrast(mix(surfaceAverage, preferred, 0.38), surfaces, 3.5, mode),
    dim: ensureContrast(mix(surfaceAverage, preferred, 0.48), surfaces, 3, mode),
  };
}
