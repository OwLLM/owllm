// DownloadedModelCard — local-models grid card. Same visual shell as
// ModelCard via CardShell; adds:
//   • onboarding status badge (Building/Broken/Ready/Incomplete)
//   • environment chip (when an env is bound to the model)
//   • file:// link to the model path
//   • Repair / Finish-download / Env / Delete actions
//   • diagonal green "READY" ribbon when onboarding === "READY"
//     (mirrors LLM/desktop_app/model_card_widget.py RibbonWidget)

import React from "react";
import CardShell, { compatBg } from "./CardShell";
import CornerRibbon from "./CornerRibbon";
import type { CompatColor, CompatibilityBadge } from "./modelCardShared";

export type OnboardingStatus = "READY" | "BUILDING" | "BROKEN" | "NEW";

export type DownloadedModelCardProps = {
  modelName: string;
  modelPath: string;
  size?: string;
  icons?: string;
  isIncomplete?: boolean;
  isActiveDownload?: boolean;
  compatibilityBadge?: CompatibilityBadge;
  onboardingStatus?: OnboardingStatus;
  envKey?: string | null;
  selected?: boolean;
  onSelect?: (path: string) => void;
  onDelete?: (path: string) => void;
  onRepair?: (path: string) => void;
  onAddWeights?: (path: string) => void;
  onDedicatedEnv?: (path: string) => void;
};

function statusBadge(status: OnboardingStatus): { bg: string; text: string } | null {
  switch (status) {
    case "BUILDING": return { bg: "#FF9800", text: "⏳ Building…" };
    case "BROKEN":   return { bg: "#f44336", text: "❌ Broken" };
    case "NEW":      return { bg: "#888",    text: "⏬ Incomplete" };
    case "READY":    return null;  // surfaced via the corner ribbon
  }
}

export default function DownloadedModelCard(props: DownloadedModelCardProps) {
  const {
    modelName, modelPath, size, icons,
    isIncomplete = false, isActiveDownload = false,
    compatibilityBadge, onboardingStatus = "NEW", envKey,
    selected = false,
    onSelect, onDelete, onRepair, onAddWeights, onDedicatedEnv,
  } = props;

  const status = isIncomplete && onboardingStatus === "READY" ? "BROKEN" : onboardingStatus;
  const sb = statusBadge(status);

  // Local-file status pill on the left (always present): Downloaded /
  // Downloading / Incomplete.
  let local = { bg: "rgba(76,175,80,0.2)", fg: "#4CAF50", text: "💾 Downloaded" };
  if (isIncomplete) {
    if (size && (size.includes("Downloading") || size.includes("⏳"))) {
      local = { bg: "rgba(255,152,0,0.18)", fg: "#FF9800", text: "⏳ Downloading" };
    } else {
      local = { bg: "rgba(244,67,54,0.18)", fg: "#f44336", text: "⚠️ Incomplete" };
    }
  }

  const btn: React.CSSProperties = {
    background: "rgba(var(--accent-rgb),0.15)",
    border: "1px solid rgba(var(--accent-rgb),0.4)",
    color: "white", borderRadius: 6, padding: "6px 15px",
    fontWeight: "bold", cursor: "pointer", fontSize: 12,
  };
  const dangerBtn: React.CSSProperties = {
    ...btn,
    background: "rgba(244,67,54,0.15)",
    border: "1px solid rgba(244,67,54,0.4)",
  };

  // Border color: red if incomplete, otherwise driven by compat badge.
  const compatForBorder: CompatibilityBadge | undefined =
    isIncomplete
      ? { color: "red" as CompatColor, text: "Incomplete" }
      : compatibilityBadge;

  return (
    <CardShell
      dataUi="DownloadedModelCard"
      iconKey={modelName}
      title={modelName}
      titleBadges={<>
        {compatibilityBadge && !isIncomplete && (
          <span style={{
            background: compatBg(compatibilityBadge.color),
            color: "white", padding: "3px 8px", borderRadius: 4,
            fontSize: 11, fontWeight: "bold",
          }}>{compatibilityBadge.text}</span>
        )}
      </>}
      subline={
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 4 }}>
          <span style={{
            background: local.bg, color: local.fg,
            padding: "2px 6px", borderRadius: 3,
            fontSize: 10, fontWeight: "bold",
          }}>{local.text}</span>
          {envKey && (
            <span style={{
              background: "rgba(var(--accent-rgb),0.3)", color: "#667eea",
              padding: "2px 8px", borderRadius: 3,
              fontSize: 10, fontWeight: "bold",
            }}>🔧 {envKey}</span>
          )}
          {sb && (
            <span style={{
              background: sb.bg, color: "white",
              padding: "4px 10px", borderRadius: 4,
              fontSize: 11, fontWeight: "bold",
            }}>{sb.text}</span>
          )}
        </div>
      }
      compat={compatForBorder}
      selected={selected}
      onClick={onSelect ? () => onSelect(modelPath) : undefined}
      ribbon={status === "READY" ? <CornerRibbon text="READY" /> : null}
      body={<>
        <div style={{ display: "flex", alignItems: "center" }}>
          {size && (
            <span style={{
              fontSize: 13,
              color: isIncomplete ? "#ff6b6b" : "#fafafa",
              fontWeight: isIncomplete ? "bold" : "normal",
            }}>📦 {size}</span>
          )}
          <span style={{ flex: 1 }} />
          {icons && <span style={{ fontSize: 18, letterSpacing: 2 }}>{icons}</span>}
        </div>
        <div style={{ fontSize: 11, color: "#9aa0aa", wordBreak: "break-all", lineHeight: 1.3 }}>
          📂 <a
            href={`file:///${modelPath.replace(/\\/g, "/")}`}
            style={{ color: "#667eea", textDecoration: "none" }}
            onClick={(e) => e.stopPropagation()}
          >{modelPath}</a>
        </div>
      </>}
      actions={
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {isIncomplete && !isActiveDownload && (
            <button style={btn} onClick={(e) => { e.stopPropagation(); onRepair?.(modelPath); }}>🔧 Repair</button>
          )}
          {status === "NEW" && !isIncomplete && (
            <button style={btn} onClick={(e) => { e.stopPropagation(); onAddWeights?.(modelPath); }}>🚀 Finish download</button>
          )}
          {status === "READY" && (
            <button style={btn} onClick={(e) => { e.stopPropagation(); onAddWeights?.(modelPath); }}>➕ Edit weights</button>
          )}
          {envKey && (
            <button style={btn} onClick={(e) => { e.stopPropagation(); onDedicatedEnv?.(modelPath); }}>🛠️ Env</button>
          )}
          <button style={dangerBtn} onClick={(e) => { e.stopPropagation(); onDelete?.(modelPath); }}>🗑️ Delete</button>
        </div>
      }
    />
  );
}
