// TunedModelCard — fine-tuned adapters grid card. Shares the same
// CardShell as ModelCard/DownloadedModelCard; adds:
//   • LoRA / GGUF format pill in the title row
//   • steps / loss / created-at sub-row
//   • Test / Export GGUF / Delete actions
//   • a green "TUNED" corner ribbon so the LoRA adapters read at a
//     glance vs. base models

import React from "react";
import CardShell from "./CardShell";
import CornerRibbon from "./CornerRibbon";
import type { CompatibilityBadge } from "./modelCardShared";

export type TunedModelCardProps = {
  adapterName: string;
  baseModel: string;
  adapterPath: string;
  size?: string;
  format?: "lora" | "gguf";
  createdAt?: string;
  steps?: number;
  finalLoss?: number;
  selected?: boolean;
  onTest?: (path: string) => void;
  onExportGguf?: (path: string) => void;
  onDelete?: (path: string) => void;
  onSelect?: (path: string) => void;
};

export default function TunedModelCard(props: TunedModelCardProps) {
  const {
    adapterName, baseModel, adapterPath, size, format = "lora",
    createdAt, steps, finalLoss, selected = false,
    onTest, onExportGguf, onDelete, onSelect,
  } = props;

  const isGguf = format === "gguf";
  const compat: CompatibilityBadge = isGguf
    ? { color: "orange", text: "GGUF" }
    : { color: "green",  text: "LoRA" };

  const btn: React.CSSProperties = {
    background: "rgba(102,126,234,0.15)",
    border: "1px solid rgba(102,126,234,0.4)",
    color: "white", borderRadius: 6, padding: "6px 15px",
    fontWeight: "bold", cursor: "pointer", fontSize: 12,
  };
  const dangerBtn: React.CSSProperties = {
    ...btn,
    background: "rgba(244,67,54,0.15)",
    border: "1px solid rgba(244,67,54,0.4)",
  };

  return (
    <CardShell
      dataUi="TunedModelCard"
      iconKey={baseModel}
      title={adapterName}
      titleBadges={<span style={{
        background: isGguf ? "#9C27B0" : "#667eea",
        color: "white", padding: "3px 8px", borderRadius: 4,
        fontSize: 11, fontWeight: "bold",
      }}>{isGguf ? "GGUF" : "LoRA"}</span>}
      subline={
        <div style={{ fontSize: 11, color: "#9aa0aa", marginTop: 4 }}>
          base: <span style={{ color: "#d6d8de" }}>{baseModel}</span>
        </div>
      }
      compat={compat}
      selected={selected}
      onClick={onSelect ? () => onSelect(adapterPath) : undefined}
      ribbon={<CornerRibbon text={isGguf ? "GGUF" : "TUNED"} bg={isGguf ? "#9C27B0" : "#667eea"} />}
      body={<>
        {(steps !== undefined || finalLoss !== undefined || createdAt) && (
          <div style={{ display: "flex", gap: 16, fontSize: 11, color: "#9aa0aa", flexWrap: "wrap" }}>
            {steps !== undefined     && <span>🔁 {steps} steps</span>}
            {finalLoss !== undefined && <span>📉 loss {finalLoss.toFixed(4)}</span>}
            {createdAt               && <span>🕓 {createdAt}</span>}
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
      </>}
      actions={
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={btn} onClick={(e) => { e.stopPropagation(); onTest?.(adapterPath); }}>💬 Test</button>
          {!isGguf && (
            <button style={btn} onClick={(e) => { e.stopPropagation(); onExportGguf?.(adapterPath); }}>📦 Export GGUF</button>
          )}
          <button style={dangerBtn} onClick={(e) => { e.stopPropagation(); onDelete?.(adapterPath); }}>🗑️ Delete</button>
        </div>
      }
    />
  );
}
