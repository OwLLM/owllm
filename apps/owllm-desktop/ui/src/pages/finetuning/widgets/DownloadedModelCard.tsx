// DownloadedModelCard — port of LLM/desktop_app/model_card_widget.py
// DownloadedModelCard. Same visual shell as ModelCard but with
// onboarding status badge (READY / BUILDING / BROKEN / NEW), local-file
// "💾 Downloaded" badge, env_key chip, model path with file:// link, and
// repair/onboard/delete/add-weights/dedicated-env actions in the button
// row when applicable.

import React from "react";
import { familyIcon, CompatColor, CompatibilityBadge } from "./modelCardShared";

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
  envKey?: string;
  onSelect?: (path: string) => void;
  onDelete?: (path: string) => void;
  onRepair?: (path: string) => void;
  onAddWeights?: (path: string) => void;
  onDedicatedEnv?: (path: string) => void;
};

function statusBadge(status: OnboardingStatus): { bg: string; text: string } {
  switch (status) {
    case "BUILDING": return { bg: "#FF9800", text: "⏳ Building..." };
    case "BROKEN":   return { bg: "#f44336", text: "❌ Broken" };
    case "NEW":      return { bg: "#888",    text: "🆕 Not Onboarded" };
    default:         return { bg: "",        text: "" }; // READY = no inline badge
  }
}

function compatBg(c: CompatColor): string {
  switch (c) {
    case "green":  return "#4CAF50";
    case "orange": return "#FF9800";
    case "red":    return "#f44336";
    default:       return "#888";
  }
}

export default function DownloadedModelCard(props: DownloadedModelCardProps) {
  const {
    modelName, modelPath, size, icons,
    isIncomplete = false, isActiveDownload = false,
    compatibilityBadge, onboardingStatus = "NEW", envKey,
    onSelect, onDelete, onRepair, onAddWeights, onDedicatedEnv,
  } = props;

  const fam = familyIcon(modelName);
  const status = isIncomplete && onboardingStatus === "READY" ? "BROKEN" : onboardingStatus;
  const [hover, setHover] = React.useState(false);

  // Local status: Downloaded / Downloading / Incomplete
  let local = { bg: "rgba(76,175,80,0.2)", fg: "#4CAF50", text: "💾 Downloaded" };
  if (isIncomplete) {
    if (size && (size.includes("Downloading") || size.includes("⏳"))) {
      local = { bg: "rgba(255,152,0,0.18)", fg: "#FF9800", text: "⏳ Downloading" };
    } else {
      local = { bg: "rgba(244,67,54,0.18)", fg: "#f44336", text: "⚠️ Incomplete" };
    }
  }

  const sb = statusBadge(status);
  const border = isIncomplete ? "#f44336" : compatibilityBadge ? compatBg(compatibilityBadge.color) : "#667eea";

  const btn: React.CSSProperties = {
    background: "rgba(102,126,234,0.15)",
    border: "1px solid rgba(102,126,234,0.4)",
    color: "white",
    borderRadius: 6,
    padding: "6px 15px",
    fontWeight: "bold",
    cursor: "pointer",
    fontSize: 12,
  };
  const dangerBtn: React.CSSProperties = {
    ...btn,
    background: "rgba(244,67,54,0.15)",
    border: "1px solid rgba(244,67,54,0.4)",
  };

  return (
    <div
      data-ui="DownloadedModelCard"
      onClick={() => onSelect?.(modelPath)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        minHeight: 220,
        padding: "15px 20px",
        background: `linear-gradient(180deg, ${hover ? "#262740" : "#1a1d2e"} 0%, ${hover ? "#1a2540" : "#16213e"} 100%)`,
        border: `2px solid ${border}`,
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        cursor: "pointer",
        color: "#fafafa",
        boxShadow: hover ? `0 6px 18px -6px ${border}55` : "0 1px 2px rgba(0,0,0,0.2)",
        transition: "all 140ms ease",
      }}
    >
      <div style={{ display: "flex", gap: 15 }}>
        <div style={{
          width: 50, height: 50, borderRadius: 25,
          background: fam.bg, color: "white",
          fontSize: 24, fontWeight: "bold",
          border: "2px solid rgba(255,255,255,0.2)",
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0,
        }}>{fam.icon}</div>

        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
            <div style={{ fontSize: 14, fontWeight: "bold", maxWidth: 350, wordBreak: "break-word" }}>{modelName}</div>
            {compatibilityBadge && !isIncomplete && (
              <span style={{
                background: compatBg(compatibilityBadge.color),
                color: "white", padding: "3px 8px", borderRadius: 4,
                fontSize: 11, fontWeight: "bold",
              }}>{compatibilityBadge.text}</span>
            )}
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{
              background: local.bg, color: local.fg,
              padding: "2px 6px", borderRadius: 3,
              fontSize: 10, fontWeight: "bold",
            }}>{local.text}</span>
            {envKey && (
              <span style={{
                background: "rgba(102,126,234,0.3)", color: "#667eea",
                padding: "2px 8px", borderRadius: 3,
                fontSize: 10, fontWeight: "bold",
              }}>🔧 {envKey}</span>
            )}
            {sb.text && (
              <span style={{
                background: sb.bg, color: "white",
                padding: "4px 10px", borderRadius: 4,
                fontSize: 11, fontWeight: "bold",
              }}>{sb.text}</span>
            )}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center" }}>
        {size && <span style={{ fontSize: 13, color: isIncomplete ? "#ff6b6b" : "#fafafa", fontWeight: isIncomplete ? "bold" : "normal" }}>📦 {size}</span>}
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

      <div style={{ flex: 1 }} />

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {isIncomplete && !isActiveDownload && (
          <button style={btn} onClick={(e) => { e.stopPropagation(); onRepair?.(modelPath); }}>🔧 Repair</button>
        )}
        {status === "NEW" && (
          <button style={btn} onClick={(e) => { e.stopPropagation(); onAddWeights?.(modelPath); }}>🚀 Onboard</button>
        )}
        {envKey && (
          <button style={btn} onClick={(e) => { e.stopPropagation(); onDedicatedEnv?.(modelPath); }}>🛠️ Env</button>
        )}
        <button style={dangerBtn} onClick={(e) => { e.stopPropagation(); onDelete?.(modelPath); }}>🗑️ Delete</button>
      </div>
    </div>
  );
}
