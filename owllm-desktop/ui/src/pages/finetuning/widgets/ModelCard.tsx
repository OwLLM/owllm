// ModelCard — Browse-tab card. Composes the shared CardShell with
// HF-search-shaped data (downloads/likes, NEW badge, gated state,
// download button with inline progress).

import React from "react";
import CardShell, { compatBg } from "./CardShell";
import type { CompatColor, CompatibilityBadge } from "./modelCardShared";

export type { CompatColor, CompatibilityBadge };

export type TagChip = { key: string; label: string; color: string };

export type ModelCardProps = {
  modelName: string;
  modelId: string;
  description?: string;
  size?: string;
  icons?: string;
  tagChips?: TagChip[];
  /// Subset of tagChips whose keys are currently in the active filter
  /// set — used to draw the matched chips with extra emphasis and to
  /// paint a glow border around the whole card so the user can see at
  /// a glance which cards a freshly-checked filter has surfaced.
  matchedChipKeys?: string[];
  isDownloaded?: boolean;
  isNew?: boolean;
  downloads?: string;
  likes?: string;
  compatibilityBadge?: CompatibilityBadge;
  requiresToken?: boolean;
  downloadProgress?: number;
  selected?: boolean;
  onDownload?: (modelId: string) => void;
  onClick?: (modelId: string) => void;
};

export function ModelCard(props: ModelCardProps) {
  const {
    modelName, modelId, description, size, icons, tagChips, matchedChipKeys,
    isDownloaded = false, isNew = false,
    downloads, likes, compatibilityBadge, requiresToken = false,
    downloadProgress, selected = false, onDownload, onClick,
  } = props;
  const matchedSet = new Set(matchedChipKeys ?? []);
  const hasFilterMatch = matchedSet.size > 0;
  const matchGlowColor = hasFilterMatch
    ? (tagChips?.find((c) => matchedSet.has(c.key))?.color ?? "var(--accent)")
    : "transparent";

  const [btnHover, setBtnHover] = React.useState(false);
  const [btnPressed, setBtnPressed] = React.useState(false);

  const modelIdDisplay = modelId.replace(/\//g, "/ ").replace(/-/g, "- ").replace(/_/g, "_ ");
  const downloading = typeof downloadProgress === "number" && !isDownloaded;
  const pct = downloading ? Math.max(0, Math.min(1, downloadProgress!)) : 0;
  const btnLabel = isDownloaded ? "✓ Downloaded" : downloading ? `${Math.round(pct * 100)}%` : "📥 Download";

  const btnBg = isDownloaded
    ? "rgba(150,150,150,0.05)"
    : btnPressed ? "rgba(var(--accent-rgb),0.35)"
    : btnHover  ? "rgba(var(--accent-rgb),0.25)"
    :              "rgba(var(--accent-rgb),0.15)";
  const btnBorder = isDownloaded
    ? "1px solid rgba(150,150,150,0.1)"
    : btnHover  ? "1px solid rgba(var(--accent-rgb),0.6)"
    :              "1px solid rgba(var(--accent-rgb),0.4)";

  return (
    <div style={{
      // Filter-match glow ring. Drawn outside the card so it doesn't
      // disturb CardShell's internal border/shadow logic. The colour
      // matches the first matched chip so a checked-GGUF filter halos
      // GGUF cards in blue, checked-LoRA halos in teal, etc.
      borderRadius: 12,
      padding: 0,
      boxShadow: hasFilterMatch
        ? `0 0 0 3px ${matchGlowColor}, 0 0 18px -2px ${matchGlowColor}`
        : "none",
      transition: "box-shadow 200ms ease",
    }}>
    <CardShell
      dataUi="ModelCard"
      iconKey={modelId}
      title={modelName}
      titleBadges={<>
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
              whiteSpace: "normal",
              lineHeight: 1.2,
            }}
          >{compatibilityBadge.text}</span>
        )}
        {isNew && (
          <span style={{
            background: "linear-gradient(90deg, #ff6b6b 0%, #ee5a6f 100%)",
            color: "white", padding: "3px 8px", borderRadius: 4,
            fontSize: 13, fontWeight: "bold",
            boxShadow: "0 0 8px -2px #ff6b6b",
          }}>NEW</span>
        )}
      </>}
      subline={(downloads || likes) ? (
        <div style={{ display: "flex", gap: 15, marginTop: 2 }}>
          {downloads && <span style={{ color: "#9aa0aa", fontSize: 11 }}>📥 {downloads} downloads</span>}
          {likes     && <span style={{ color: "#9aa0aa", fontSize: 11 }}>❤️ {likes} likes</span>}
        </div>
      ) : null}
      compat={compatibilityBadge}
      requiresToken={requiresToken}
      selected={selected}
      onClick={onClick ? () => onClick(modelId) : undefined}
      body={<>
        {description && (
          <div style={{ fontSize: 13, color: "#d6d8de", lineHeight: 1.35 }}>{description}</div>
        )}
        {tagChips && tagChips.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 }}>
            {tagChips.map((c) => {
              const matched = matchedSet.has(c.key);
              // When some filters are active, dim chips that don't
              // match those filters and emphasise the ones that do
              // (subtle ring + slight scale). When no filters are
              // active, every chip renders at full intensity.
              const dim = hasFilterMatch && !matched;
              return (
                <span
                  key={c.key}
                  style={{
                    background: c.color,
                    color: "white",
                    padding: "2px 7px",
                    borderRadius: 10,
                    fontSize: 10,
                    fontWeight: 700,
                    lineHeight: 1.4,
                    whiteSpace: "nowrap",
                    opacity: dim ? 0.35 : 1,
                    boxShadow: matched ? `0 0 0 2px white, 0 0 8px ${c.color}` : "none",
                    transform: matched ? "scale(1.05)" : "scale(1)",
                    transition: "opacity 150ms ease, transform 150ms ease, box-shadow 150ms ease",
                  }}
                >{c.label}</span>
              );
            })}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center" }}>
          {size && <span style={{ fontSize: 13, color: "#fafafa" }}>📦 {size}</span>}
          <span style={{ flex: 1 }} />
          {icons && <span style={{ fontSize: 18, letterSpacing: 2 }}>{icons}</span>}
        </div>
        <div style={{ fontSize: 11, color: "#888", wordBreak: "break-word", lineHeight: 1.3 }}>
          📂 {modelIdDisplay}
        </div>
      </>}
      actions={
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
              <span aria-hidden style={{
                position: "absolute", inset: 0,
                width: `${pct * 100}%`,
                background: "linear-gradient(90deg, rgba(var(--accent-rgb),0.55), rgba(var(--accent-rgb),0.85))",
                transition: "width 200ms linear",
                pointerEvents: "none",
              }} />
            )}
            <span style={{ position: "relative", zIndex: 1 }}>{btnLabel}</span>
          </button>
        </div>
      }
    />
    </div>
  );
}

export default ModelCard;
