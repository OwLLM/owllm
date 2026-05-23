// Centralised, theme-aware style helpers.
//
// Everywhere in the React UI that needs a surface / chip / input / button
// should import from here instead of writing the same inline style at the
// call site. The helpers ONLY reference CSS variables defined in styles.css,
// so they flip correctly when the user toggles dark / light.
//
// Naming convention:
//   • SURFACE.<name>  → page / panel / card backgrounds + matching text.
//   • TEXT.<name>     → text-only tokens (fg, muted, subtle, on-accent).
//   • BORDER.<name>   → border-only tokens.
//   • CHIP.tab(active)→ tab-pill shaped buttons (Browse / Downloaded / …).
//   • BUTTON.<name>(state?) → standalone button styles by intent.
//   • INPUT.field     → text input / select / textarea base style.
//
// Add a NEW token here, not at the call site, when you find yourself
// repeating an inline style across files. That's the whole point of the
// file — when a future theme tweak lands, ONE edit cascades to every
// page that imported the same helper.

import type React from "react";

// ---------------------------------------------------------------------
// Surfaces — backgrounds + matching foreground for content panels.
// ---------------------------------------------------------------------
export const SURFACE = {
  /** Page root — fills the area below the SubTabs row. */
  page:    { background: "var(--bg-panel)",   color: "var(--fg)" } as React.CSSProperties,
  /** Slightly raised container inside a page (sidebar, side rail). */
  panel:   { background: "var(--bg-elevated)", color: "var(--fg)" } as React.CSSProperties,
  /** Card body — used by anything that draws a bordered card. */
  card:    { background: "var(--bg-card)",     color: "var(--fg)", border: "1px solid var(--border)" } as React.CSSProperties,
  /** Chrome strip (ModeBar / modal title bars). Always dark; ignores
   *  theme mode by design — header reads as chrome above the page. */
  chrome:  { background: "var(--bg-header)",   color: "#ffffff" } as React.CSSProperties,
  /** Translucent surface for hovered ghost areas, etc. */
  hover:   { background: "var(--bg-surface-hover)" } as React.CSSProperties,
} as const;

// ---------------------------------------------------------------------
// Text — colour-only tokens. Use SURFACE.* when you also need a bg.
// ---------------------------------------------------------------------
export const TEXT = {
  fg:        { color: "var(--fg)" } as React.CSSProperties,
  strong:    { color: "var(--fg-strong)" } as React.CSSProperties,
  muted:     { color: "var(--fg-muted)" } as React.CSSProperties,
  subtle:    { color: "var(--fg-subtle)" } as React.CSSProperties,
  /** Foreground over the accent fill — paired with `background:
   *  var(--accent)`. Stays readable whether the accent is amber or slate. */
  onAccent:  { color: "var(--accent-fg)" } as React.CSSProperties,
} as const;

// ---------------------------------------------------------------------
// Borders — width is the caller's choice; this just picks the colour.
// ---------------------------------------------------------------------
export const BORDER = {
  subtle: "1px solid var(--border)",
  strong: "1px solid var(--border-strong)",
  accent: "1px solid var(--border-accent)",
} as const;

// ---------------------------------------------------------------------
// Tab/chip pill — used by ModelsPage's Browse/Downloaded/Tuned/Cache
// buttons plus any future tab strip. Active state pulls the accent so
// the user's colour pick lights up the active tab.
// ---------------------------------------------------------------------
export function chip(active: boolean, opts: { height?: number; fontSize?: number } = {}): React.CSSProperties {
  const { height = 50, fontSize = 15 } = opts;
  return {
    height,
    padding: "0 10px",
    background: active ? "rgba(var(--accent-rgb), 0.28)" : "transparent",
    color: active ? "var(--fg-strong)" : "var(--fg)",
    border: `1px solid ${active ? "var(--accent)" : "var(--border-strong)"}`,
    borderRadius: 6,
    fontSize,
    cursor: "pointer",
    transition: "background 120ms ease, border-color 120ms ease, color 120ms ease",
  };
}

// ---------------------------------------------------------------------
// Input — text fields, search bars, selects. Uses --bg-input so light
// mode shows a white field with dark text, dark mode shows a near-black
// field with light text.
// ---------------------------------------------------------------------
export const INPUT = {
  field: {
    background: "var(--bg-input)",
    color: "var(--fg)",
    border: BORDER.strong,
    borderRadius: 6,
    padding: "6px 10px",
    fontSize: 12,
  } as React.CSSProperties,
} as const;

// ---------------------------------------------------------------------
// Buttons — three intents: primary (accent-filled), ghost (transparent
// with hover tint), and danger (red-tinged for destructive actions).
// ---------------------------------------------------------------------
export const BUTTON = {
  primary: {
    background: "var(--accent)",
    color: "var(--accent-fg)",
    border: "1px solid var(--accent)",
    borderRadius: 6,
    padding: "6px 14px",
    fontSize: 12,
    cursor: "pointer",
    fontWeight: 700,
  } as React.CSSProperties,
  ghost: {
    background: "var(--ghost-bg)",
    color: "var(--ghost-fg)",
    border: BORDER.strong,
    borderRadius: 6,
    padding: "6px 14px",
    fontSize: 12,
    cursor: "pointer",
    fontWeight: 700,
  } as React.CSSProperties,
  danger: {
    background: "rgba(244,67,54,0.18)",
    color: "var(--error)",
    border: "1px solid rgba(244,67,54,0.45)",
    borderRadius: 6,
    padding: "6px 14px",
    fontSize: 12,
    cursor: "pointer",
    fontWeight: 700,
  } as React.CSSProperties,
} as const;

// ---------------------------------------------------------------------
// Header pill — used by AppShell.ModeBar. Sits on the accent-tinted
// header band, so the pill ALSO uses the accent (a darker mix of it)
// instead of a fixed dark-grey gradient. That way amber-header sees
// amber pills, red-header sees red pills, etc. — same colour family
// across the whole top bar. Active state inverts: pill fills with the
// accent itself and the label flips to the accent's foreground colour.
// ---------------------------------------------------------------------
export function headerPill(active: boolean, width?: number): React.CSSProperties {
  const base: React.CSSProperties = {
    height: 50,
    padding: "0 6px",
    // Pill background mixes accent + --header-pill-base. The base is
    // a theme-aware token (#14172a in dark mode, #d4d8e0 in light
    // mode) so the pill stays close to the header surface in BOTH
    // modes instead of looking like a dark navy hole punched into a
    // bright light-mode header.
    background: "color-mix(in srgb, var(--accent) 35%, var(--header-pill-base))",
    // Text follows --bg-header-fg, which CSS routes per data-theme
    // (white on dark headers regardless of accent; auto-flips on the
    // brighter light-mode tinted-grey header).
    color: "var(--bg-header-fg)",
    border: "1px solid rgba(255,255,255,0.20)",
    borderRadius: 6,
    fontSize: 15,
    fontWeight: 700,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1.05,
    gap: 0,
    cursor: "pointer",
    userSelect: "none",
    ...(width !== undefined ? { width } : null),
  };
  if (!active) return base;
  return {
    ...base,
    // Active pill: filled with the accent so it pops against the
    // less-saturated header band, and the label flips to the accent
    // foreground (var(--accent-fg) picks black-on-amber/yellow but
    // white-on-red/blue/etc.). The yellow ring stays as a focus
    // affordance that reads against every accent.
    border: "1px solid #ffd080",
    background: "var(--accent)",
    color: "var(--accent-fg)",
  };
}

// ---------------------------------------------------------------------
// Banner — sticky in-page notice (errors, in-progress messages, etc).
// `tone` picks the colour family; the helper composes bg + border + fg.
// ---------------------------------------------------------------------
export type BannerTone = "info" | "success" | "error";

export function banner(tone: BannerTone): React.CSSProperties {
  const palettes: Record<BannerTone, { bg: string; bd: string; fg: string }> = {
    info:    { bg: "rgba(var(--accent-rgb), 0.18)", bd: "rgba(var(--accent-rgb), 0.50)", fg: "var(--fg)" },
    success: { bg: "rgba(34,197,94,0.18)",          bd: "rgba(34,197,94,0.50)",          fg: "var(--ok)" },
    error:   { bg: "rgba(244,67,54,0.18)",          bd: "rgba(244,67,54,0.50)",          fg: "var(--error)" },
  };
  const p = palettes[tone];
  return {
    background: p.bg,
    border: `1px solid ${p.bd}`,
    color: p.fg,
    padding: "8px 12px",
    borderRadius: 6,
    fontSize: 12,
  };
}
