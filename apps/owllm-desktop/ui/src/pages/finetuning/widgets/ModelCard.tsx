// ModelCard — 1:1 port of LLM/desktop_app/model_card_widget.py (ModelCard),
// polished with React-native hover, smooth transitions, and a download
// button that gives proper feedback. The widget is fully self-contained:
// drop it inside a grid cell and it stretches to fill column width.

import React from "react";
import { familyIcon, CompatColor, CompatibilityBadge } from "./modelCardShared";

export type { CompatColor, CompatibilityBadge };

export type ModelCardProps = {
  modelName: string;
  modelId: string;
  description?: string;
  size?: string;
  icons?: string;
  isDownloaded?: boolean;
  isNew?: boolean;
  downloads?: string;
  likes?: string;
  compatibilityBadge?: CompatibilityBadge;
  requiresToken?: boolean;
  downloadProgress?: number; // 0–1, undefined = idle
  /** True when the user has clicked the card. Adds a gold ring around the border. */
  selected?: boolean;
  onDownload?: (modelId: string) => void;
  onClick?: (modelId: string) => void;
};

function compatBg(c: CompatColor): string {
  switch (c) {
    case "green":  return "#4CAF50";
    case "orange": return "#FF9800";
    case "red":    return "#f44336";
    default:       return "#888";
  }
}

// Border color = compat color or yellow if gated.
function borderColor(badge: CompatibilityBadge | undefined, requiresToken: boolean): string {
  if (requiresToken) return "#F7C948";
  if (!badge) return "#667eea";
  return compatBg(badge.color);
}

export function ModelCard(props: ModelCardProps) {
  const {
    modelName, modelId, description, size, icons,
    isDownloaded = false, isNew = false,
    downloads, likes, compatibilityBadge, requiresToken = false,
    downloadProgress, selected = false, onDownload, onClick,
  } = props;

  const fam = familyIcon(modelId);
  const border = borderColor(compatibilityBadge, requiresToken);
  const [hover, setHover] = React.useState(false);
  const [btnHover, setBtnHover] = React.useState(false);
  const [btnPressed, setBtnPressed] = React.useState(false);

  // Qt: req=True → bg gradient #2a2610 → #2a2610 (yellow-tinted),
  // else palette(base) → #16213e (cool dark). Hover brightens both stops.
  const bgStart = requiresToken
    ? (hover ? "#332a18" : "#2a2610")
    : (hover ? "#262740" : "#1a1d2e");
  const bgEnd = requiresToken
    ? (hover ? "#2a2540" : "#2a2610")
    : (hover ? "#1a2540" : "#16213e");

  // model_id formatted with break-friendly characters (model_card_widget.py:192).
  const modelIdDisplay = modelId
    .replace(/\//g, "/ ")
    .replace(/-/g, "- ")
    .replace(/_/g, "_ ");

  const downloading = typeof downloadProgress === "number" && !isDownloaded;
  const pct = downloading ? Math.max(0, Math.min(1, downloadProgress!)) : 0;

  const handleCardClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-card-action]")) return;
    onClick?.(modelId);
  };

  const btnLabel = isDownloaded
    ? "✓ Downloaded"
    : downloading ? `${Math.round(pct * 100)}%` : "📥 Download";

  const btnBg = isDownloaded
    ? "rgba(150,150,150,0.05)"
    : btnPressed ? "rgba(102,126,234,0.35)"
    : btnHover  ? "rgba(102,126,234,0.25)"
    :              "rgba(102,126,234,0.15)";

  const btnBorder = isDownloaded
    ? "1px solid rgba(150,150,150,0.1)"
    : btnHover  ? "1px solid rgba(102,126,234,0.6)"
    :              "1px solid rgba(102,126,234,0.4)";

  return (
    <div
      data-ui="ModelCard"
      onClick={handleCardClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        minHeight: 220,
        padding: "15px 20px",
        background: `linear-gradient(180deg, ${bgStart} 0%, ${bgEnd} 100%)`,
        border: `2px solid ${selected ? "#f3c34a" : border}`,
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        cursor: "pointer",
        color: "#fafafa",
        boxShadow: selected
          ? `0 0 0 2px #f3c34a55, 0 8px 22px -6px #f3c34a55`
          : hover
            ? `0 6px 18px -6px ${border}55, 0 2px 6px rgba(0,0,0,0.3)`
            : "0 1px 2px rgba(0,0,0,0.2)",
        transform: hover || selected ? "translateY(-1px)" : "translateY(0)",
        transition: "background 140ms ease, box-shadow 140ms ease, transform 140ms ease, border-color 140ms ease",
      }}
    >
      {/* Header: icon + (name + badges + stats) */}
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
          {/* Top row: name + compat + NEW */}
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div
              style={{
                fontSize: 14, fontWeight: "bold",
                color: "#fafafa",
                maxWidth: 350,
                wordBreak: "break-word",
                lineHeight: 1.25,
              }}
            >
              {modelName}
            </div>
            {compatibilityBadge && (
              <span
                title={compatibilityBadge.tooltip}
                style={{
                  background: compatBg(compatibilityBadge.color),
                  color: "white",
                  padding: "3px 8px",
                  borderRadius: 4,
                  fontSize: 11,
                  fontWeight: "bold",
                  maxWidth: 180,
                  display: "inline-block",
                  whiteSpace: "normal",
                  lineHeight: 1.2,
                }}
              >
                {compatibilityBadge.text}
              </span>
            )}
            {isNew && (
              <span
                style={{
                  background: "linear-gradient(90deg, #ff6b6b 0%, #ee5a6f 100%)",
                  color: "white",
                  padding: "3px 8px",
                  borderRadius: 4,
                  fontSize: 13,
                  fontWeight: "bold",
                  boxShadow: "0 0 8px -2px #ff6b6b",
                }}
              >
                NEW
              </span>
            )}
          </div>

          {/* Stats row */}
          {(downloads || likes) && (
            <div style={{ display: "flex", gap: 15, marginTop: 2 }}>
              {downloads && (
                <span style={{ color: "#9aa0aa", fontSize: 11 }}>📥 {downloads} downloads</span>
              )}
              {likes && (
                <span style={{ color: "#9aa0aa", fontSize: 11 }}>❤️ {likes} likes</span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Description (13pt = ~13px in Qt) */}
      {description && (
        <div style={{ fontSize: 13, color: "#d6d8de", lineHeight: 1.35 }}>
          {description}
        </div>
      )}

      {/* Middle row: size left, icons right */}
      <div style={{ display: "flex", alignItems: "center" }}>
        {size && (
          <span style={{ fontSize: 13, color: "#fafafa" }}>📦 {size}</span>
        )}
        <span style={{ flex: 1 }} />
        {icons && (
          <span style={{ fontSize: 18, letterSpacing: 2 }}>{icons}</span>
        )}
      </div>

      {/* Model ID */}
      <div style={{ fontSize: 11, color: "#888", wordBreak: "break-word", lineHeight: 1.3 }}>
        📂 {modelIdDisplay}
      </div>

      <div style={{ flex: 1 }} />

      {/* Button row — left aligned, fixed-width 140 × 38; while downloading
          a progress strip fills behind the label so users see momentum. */}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          data-card-action="download"
          disabled={isDownloaded}
          onClick={(e) => { e.stopPropagation(); onDownload?.(modelId); }}
          onMouseEnter={() => setBtnHover(true)}
          onMouseLeave={() => { setBtnHover(false); setBtnPressed(false); }}
          onMouseDown={() => setBtnPressed(true)}
          onMouseUp={() => setBtnPressed(false)}
          style={{
            position: "relative",
            overflow: "hidden",
            minWidth: 140,
            minHeight: 38,
            padding: "6px 15px",
            background: btnBg,
            border: btnBorder,
            color: isDownloaded ? "#888" : "white",
            fontWeight: "bold",
            borderRadius: 6,
            cursor: isDownloaded ? "default" : "pointer",
            transition: "background 120ms ease, border-color 120ms ease",
          }}
        >
          {downloading && (
            <span
              aria-hidden
              style={{
                position: "absolute",
                inset: 0,
                width: `${pct * 100}%`,
                background: "linear-gradient(90deg, rgba(102,126,234,0.55), rgba(102,126,234,0.85))",
                transition: "width 200ms linear",
                pointerEvents: "none",
              }}
            />
          )}
          <span style={{ position: "relative", zIndex: 1 }}>{btnLabel}</span>
        </button>
      </div>
    </div>
  );
}

export default ModelCard;
