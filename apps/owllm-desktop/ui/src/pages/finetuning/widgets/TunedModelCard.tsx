// TunedModelCard — port of LLM/desktop_app/main.py:10309 `_build_tuned_model_card`.
// Tuned adapters look similar to DownloadedModelCard but emphasise the
// "base + adapter" pairing and add Test / Export GGUF / Delete actions.

import React from "react";
import { familyIcon } from "./modelCardShared";

export type TunedModelCardProps = {
  adapterName: string;
  baseModel: string;
  adapterPath: string;
  size?: string;
  format?: "lora" | "gguf";
  createdAt?: string; // ISO date or human-readable
  steps?: number;
  finalLoss?: number;
  onTest?: (path: string) => void;
  onExportGguf?: (path: string) => void;
  onDelete?: (path: string) => void;
  onSelect?: (path: string) => void;
};

export default function TunedModelCard(props: TunedModelCardProps) {
  const {
    adapterName, baseModel, adapterPath, size, format = "lora",
    createdAt, steps, finalLoss,
    onTest, onExportGguf, onDelete, onSelect,
  } = props;

  const fam = familyIcon(baseModel);
  const [hover, setHover] = React.useState(false);
  const isGguf = format === "gguf";
  const border = isGguf ? "#9C27B0" : "#667eea";

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
      data-ui="TunedModelCard"
      onClick={() => onSelect?.(adapterPath)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        minHeight: 220,
        padding: "15px 20px",
        background: `linear-gradient(180deg, ${hover ? "#262740" : "#1a1d2e"} 0%, ${hover ? "#1a2540" : "#16213e"} 100%)`,
        border: `2px solid ${border}`,
        borderRadius: 10,
        display: "flex", flexDirection: "column", gap: 8,
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

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ fontSize: 14, fontWeight: "bold", maxWidth: 350, wordBreak: "break-word" }}>{adapterName}</div>
            <span style={{
              background: isGguf ? "#9C27B0" : "#667eea",
              color: "white", padding: "3px 8px", borderRadius: 4,
              fontSize: 11, fontWeight: "bold",
            }}>{isGguf ? "GGUF" : "LoRA"}</span>
          </div>
          <div style={{ fontSize: 11, color: "#9aa0aa", marginTop: 4 }}>
            base: <span style={{ color: "#d6d8de" }}>{baseModel}</span>
          </div>
        </div>
      </div>

      {(steps !== undefined || finalLoss !== undefined || createdAt) && (
        <div style={{ display: "flex", gap: 16, fontSize: 11, color: "#9aa0aa", flexWrap: "wrap" }}>
          {steps !== undefined && <span>🔁 {steps} steps</span>}
          {finalLoss !== undefined && <span>📉 loss {finalLoss.toFixed(4)}</span>}
          {createdAt && <span>🕓 {createdAt}</span>}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center" }}>
        {size && <span style={{ fontSize: 13, color: "#fafafa" }}>📦 {size}</span>}
      </div>

      <div style={{ fontSize: 11, color: "#9aa0aa", wordBreak: "break-all", lineHeight: 1.3 }}>
        📂 <a
          href={`file:///${adapterPath.replace(/\\/g, "/")}`}
          style={{ color: "#667eea", textDecoration: "none" }}
          onClick={(e) => e.stopPropagation()}
        >{adapterPath}</a>
      </div>

      <div style={{ flex: 1 }} />

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button style={btn} onClick={(e) => { e.stopPropagation(); onTest?.(adapterPath); }}>💬 Test</button>
        {!isGguf && (
          <button style={btn} onClick={(e) => { e.stopPropagation(); onExportGguf?.(adapterPath); }}>📦 Export GGUF</button>
        )}
        <button style={dangerBtn} onClick={(e) => { e.stopPropagation(); onDelete?.(adapterPath); }}>🗑️ Delete</button>
      </div>
    </div>
  );
}
