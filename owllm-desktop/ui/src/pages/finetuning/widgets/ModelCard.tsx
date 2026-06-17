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
  /// The lab/org that published the model (HF id prefix) — shown as a small
  /// brand chip on the stats line so the user can see who cooked it (#25).
  org?: { name: string; glyph: string; color: string } | null;
  description?: string;
  size?: string;
  icons?: string;
  tagChips?: TagChip[];
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
    modelName, modelId, org, description, size, icons, tagChips,
    isDownloaded = false, isNew = false,
    downloads, likes, compatibilityBadge, requiresToken = false,
    downloadProgress, selected = false, onDownload, onClick,
  } = props;

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
      subline={(org || downloads || likes) ? (
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 2, flexWrap: "wrap" }}>
          {org && (
            <span title={`Published by ${org.name}`} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              {/^[A-Z0-9]$/i.test(org.glyph) ? (
                // Monogram in a brand-coloured chip for labs without an iconic emoji.
                <span style={{
                  width: 16, height: 16, borderRadius: 8, background: org.color, color: "white",
                  fontSize: 10, fontWeight: 800, lineHeight: "16px", textAlign: "center", flexShrink: 0,
                }}>{org.glyph}</span>
              ) : (
                // Iconic brand glyph (🐋 DeepSeek, 🦙 Meta, 🤗 HF …) — no chip.
                <span style={{ fontSize: 14, lineHeight: 1 }}>{org.glyph}</span>
              )}
              <span style={{ color: "#c7cad1", fontSize: 11, fontWeight: 600 }}>{org.name}</span>
            </span>
          )}
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
          // Informational tag pills (GGUF / Instruct / LoRA / …). These describe
          // the model; they are NOT the card's compatibility colour and they do
          // NOT react to the filter checkboxes — the only card colour rule is the
          // VRAM-fit border on CardShell. Render every chip at steady intensity.
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 }}>
            {tagChips.map((c) => (
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
                }}
              >{c.label}</span>
            ))}
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
  );
}

export default ModelCard;
