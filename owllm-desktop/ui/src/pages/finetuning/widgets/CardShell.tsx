// CardShell — the visual chassis shared by ModelCard /
// DownloadedModelCard / TunedModelCard. Each card variant supplies its
// own header badges, body, and actions; the shell owns:
//   • gradient frame + border (compat-tinted or yellow-gated)
//   • 50×50 circular family-aware icon
//   • title row (name + caller-supplied badges)
//   • hover lift + halo
//   • selected state (gold ring)
//   • optional corner ribbon for READY / NEW / etc.
//
// Reusing one shell keeps the three cards visually consistent and
// avoids the spaghetti from before where each card re-implemented the
// gradient / border / icon logic.

import React from "react";
import { familyIcon, CompatColor, CompatibilityBadge } from "./modelCardShared";

export type CardShellProps = {
  /** Used by familyIcon() to pick the emoji + color. Pass the HF id
   *  or model directory name. */
  iconKey: string;
  /** Override the family-derived icon. Useful for adapters that should
   *  always show 🪶 regardless of base name. */
  iconOverride?: { icon: string; bg: string };
  /** Card title — usually model name. */
  title: React.ReactNode;
  /** Right-of-title badges. Compat/NEW/format etc. Comes from the
   *  variant. */
  titleBadges?: React.ReactNode;
  /** Sub-line under the title (stats, base model, etc.). */
  subline?: React.ReactNode;
  /** Body content between header and actions. */
  body: React.ReactNode;
  /** Action button row at the bottom. */
  actions: React.ReactNode;
  /** Drives border color. Falls back to the indigo accent. */
  compat?: CompatibilityBadge;
  /** Gated repos get a yellow border to flag the token requirement. */
  requiresToken?: boolean;
  /** Click ring + lift. */
  selected?: boolean;
  /** Bottom-right corner ribbon (CornerRibbon component). */
  ribbon?: React.ReactNode;
  /** Forwarded to the root div. */
  onClick?: () => void;
  /** Identifier for the data-ui attribute (TwinForge anchor + tests). */
  dataUi?: string;
};

function borderColor(badge: CompatibilityBadge | undefined, requiresToken: boolean): string {
  if (requiresToken) return "#F7C948";
  if (!badge) return "#667eea";
  switch (badge.color) {
    case "green":  return "#4CAF50";
    case "orange": return "#FF9800";
    case "red":    return "#f44336";
    default:       return "#667eea";
  }
}

export default function CardShell(props: CardShellProps) {
  const {
    iconKey, iconOverride, title, titleBadges, subline,
    body, actions, compat, requiresToken = false,
    selected = false, ribbon, onClick, dataUi = "ModelCardShell",
  } = props;

  const [hover, setHover] = React.useState(false);
  const fam = iconOverride ?? familyIcon(iconKey);
  const border = borderColor(compat, requiresToken);

  // Card surface — mixes the picked accent into the dark base so the
  // Browse / Downloaded / Tuned grids visibly repaint with the picker
  // instead of staying permanently dark-navy. requiresToken keeps its
  // amber-warning tinge but ALSO gets the accent mix so the warning
  // colour still reads against any picked theme.
  const bgStart = requiresToken
    ? `color-mix(in srgb, var(--accent) ${hover ? 28 : 22}%, ${hover ? "#332a18" : "#2a2610"})`
    : `color-mix(in srgb, var(--accent) ${hover ? 38 : 32}%, ${hover ? "#262740" : "#1a1d2e"})`;
  const bgEnd = requiresToken
    ? `color-mix(in srgb, var(--accent) ${hover ? 28 : 22}%, ${hover ? "#2a2540" : "#2a2610"})`
    : `color-mix(in srgb, var(--accent) ${hover ? 38 : 32}%, ${hover ? "#1a2540" : "#16213e"})`;

  return (
    <div
      data-ui={dataUi}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "relative",
        minHeight: 220,
        padding: "15px 20px",
        background: `linear-gradient(180deg, ${bgStart} 0%, ${bgEnd} 100%)`,
        border: `2px solid ${selected ? "#f3c34a" : border}`,
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        cursor: onClick ? "pointer" : "default",
        color: "#fafafa",
        overflow: "hidden",
        boxShadow: selected
          ? `0 0 0 2px #f3c34a55, 0 8px 22px -6px #f3c34a55`
          : hover
            ? `0 6px 18px -6px ${border}55, 0 2px 6px rgba(0,0,0,0.3)`
            : "0 1px 2px rgba(0,0,0,0.2)",
        transform: hover || selected ? "translateY(-1px)" : "translateY(0)",
        transition: "background 140ms ease, box-shadow 140ms ease, transform 140ms ease, border-color 140ms ease",
      }}
    >
      {ribbon}

      {/* Header: icon + (title + badges + subline) */}
      <div style={{ display: "flex", gap: 15, alignItems: "flex-start" }}>
        <div
          style={{
            width: 50, height: 50,
            borderRadius: 25,
            background: fam.bg,
            color: "white",
            fontSize: 24,
            fontWeight: "bold",
            border: "2px solid rgba(255,255,255,0.2)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            boxShadow: hover ? `0 0 14px -2px ${fam.bg}` : "none",
            transition: "box-shadow 140ms ease",
          }}
        >
          {fam.icon}
        </div>

        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div style={{
              fontSize: 14, fontWeight: "bold",
              color: "var(--fg-strong)",
              maxWidth: 350,
              wordBreak: "break-word",
              lineHeight: 1.25,
            }}>{title}</div>
            {titleBadges}
          </div>
          {subline}
        </div>
      </div>

      {body}

      <div style={{ flex: 1 }} />

      {actions}
    </div>
  );
}

export function compatBg(c: CompatColor): string {
  switch (c) {
    case "green":  return "#4CAF50";
    case "orange": return "#FF9800";
    case "red":    return "#f44336";
    default:       return "#888";
  }
}
