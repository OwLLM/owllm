// TunedModelCard — fine-tuned adapters grid card. Shares the same
// CardShell as ModelCard/DownloadedModelCard; adds:
//   • LoRA / GGUF format pill in the title row
//   • steps / loss / created-at sub-row
//   • Test / Export GGUF / Delete actions
//   • a green "TUNED" corner ribbon so the LoRA adapters read at a
//     glance vs. base models

import React from "react";
import { invoke } from "@tauri-apps/api/core";
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
  /// Highest available GPU VRAM in GB — drives the per-quant
  /// fits-in-VRAM coloring on the Export GGUF picker. When undefined
  /// or zero, every quant is rendered neutral (no red marks).
  vramGb?: number;
  onTest?: (path: string) => void;
  /// outtype is the GGUF quant the user picked from the dropdown
  /// (one of f16 / bf16 / q8_0 / q6_k / q5_k_m / q4_k_m / q4_k_s /
  /// q3_k_m / q2_k / f32). The parent forwards it to export_gguf.
  onExportGguf?: (path: string, outtype: string) => void;
  onDelete?: (path: string) => void;
  onSelect?: (path: string) => void;
};

// Quant menu definitions. bytesPerParam is the empirical mean over
// representative llama-family models — within ±5 % of the real GGUF
// file size for any 1-70B model, which is plenty for "will it fit"
// coloring on a card.
type QuantSpec = {
  id: string;
  label: string;
  bytesPerParam: number;
  quality: string;
};
const QUANTS: QuantSpec[] = [
  { id: "q2_k",   label: "Q2_K",    bytesPerParam: 0.40, quality: "Smallest · heavy lossy" },
  { id: "q3_k_m", label: "Q3_K_M",  bytesPerParam: 0.46, quality: "Compact · lossy" },
  { id: "q4_k_s", label: "Q4_K_S",  bytesPerParam: 0.54, quality: "Smaller Q4" },
  { id: "q4_k_m", label: "Q4_K_M",  bytesPerParam: 0.58, quality: "Good · recommended" },
  { id: "q5_k_m", label: "Q5_K_M",  bytesPerParam: 0.69, quality: "Very good" },
  { id: "q6_k",   label: "Q6_K",    bytesPerParam: 0.82, quality: "Excellent" },
  { id: "q8_0",   label: "Q8_0",    bytesPerParam: 1.07, quality: "Near-lossless" },
  { id: "bf16",   label: "BF16",    bytesPerParam: 2.04, quality: "Lossless · brain float" },
  { id: "f16",    label: "F16",     bytesPerParam: 2.04, quality: "Lossless" },
  { id: "f32",    label: "F32",     bytesPerParam: 4.04, quality: "Lossless · full precision" },
];

function fmtBytes(n: number): string {
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

// Per-quant GGUF size from source weight bytes. Source is assumed
// fp16 (2 bytes/param) — true for every modern abliterate / LoRA
// export. Includes a 3 % metadata overhead.
function estGgufBytes(sourceBytes: number, q: QuantSpec): number {
  const params = sourceBytes / 2;
  return params * q.bytesPerParam * 1.03;
}

// Will this quant survive on the user's GPU at single-batch inference?
// Reserve a 1.5 GB pad for the KV cache, context, and CUDA bookkeeping
// — empirically what an 8 K context costs on llama.cpp.
function fitsInVram(gguBytes: number, vramGb: number): "ok" | "tight" | "no" {
  if (!vramGb || vramGb <= 0) return "ok"; // no probe → don't penalise
  const totalNeeded = gguBytes + 1.5 * 1024 ** 3;
  const vramBytes = vramGb * 1024 ** 3;
  if (totalNeeded <= vramBytes * 0.85) return "ok";
  if (totalNeeded <= vramBytes) return "tight";
  return "no";
}

export default function TunedModelCard(props: TunedModelCardProps) {
  const {
    adapterName, baseModel, adapterPath, size, format = "lora",
    createdAt, steps, finalLoss, selected = false, vramGb,
    onExportGguf, onDelete, onSelect,
  } = props;

  // Export-GGUF dropdown state. Opens on the 📦 button click, fetches
  // the source dir's safetensor bytes once, then renders QUANTS with
  // size estimates and red-marks anything that won't fit in VRAM.
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [sourceBytes, setSourceBytes] = React.useState<number | null>(null);
  const [loadingSize, setLoadingSize] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);

  React.useEffect(() => {
    if (!menuOpen) return;
    if (sourceBytes !== null || loadingSize) return;
    setLoadingSize(true);
    invoke<number>("hf_dir_weight_bytes", { path: adapterPath })
      .then((b) => setSourceBytes(b || 0))
      .catch(() => setSourceBytes(0))
      .finally(() => setLoadingSize(false));
  }, [menuOpen, adapterPath, sourceBytes, loadingSize]);

  // Close menu on outside click.
  React.useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

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
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", position: "relative" }}>
          {!isGguf && (
            <button
              ref={triggerRef}
              style={btn}
              onClick={(e) => { e.stopPropagation(); setMenuOpen(v => !v); }}
            >📦 Export GGUF ▾</button>
          )}
          <button style={dangerBtn} onClick={(e) => { e.stopPropagation(); onDelete?.(adapterPath); }}>🗑️ Delete</button>

          {menuOpen && !isGguf && (
            <div
              ref={menuRef}
              onClick={(e) => e.stopPropagation()}
              style={{
                position: "absolute",
                top: "100%", left: 0, marginTop: 6,
                zIndex: 100,
                width: 320,
                background: "var(--bg-panel)",
                border: "1px solid rgba(102,126,234,0.5)",
                borderRadius: 8,
                boxShadow: "0 10px 30px rgba(0,0,0,0.55)",
                padding: 6,
              }}
            >
              <div style={{ padding: "6px 8px", fontSize: 10, color: "#9aa0aa", lineHeight: 1.4 }}>
                Pick a quantization.
                {vramGb ? <> Your GPU has <b style={{ color: "#cfd4e1" }}>{vramGb.toFixed(1)} GB</b>; rows in red won't fit.</> : null}
                {loadingSize ? " · scanning…" : null}
              </div>
              <div style={{ maxHeight: 320, overflowY: "auto" }}>
                {QUANTS.map((q) => {
                  const eb = sourceBytes ? estGgufBytes(sourceBytes, q) : 0;
                  const fit = sourceBytes ? fitsInVram(eb, vramGb ?? 0) : "ok";
                  const color =
                    fit === "no"    ? "#ff8080" :
                    fit === "tight" ? "#f5d76e" :
                                      "var(--fg)";
                  const bg =
                    fit === "no"    ? "rgba(244,67,54,0.10)" :
                    fit === "tight" ? "rgba(255,193,7,0.10)" :
                                      "transparent";
                  const isRecommended = q.id === "q4_k_m";
                  return (
                    <button
                      key={q.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuOpen(false);
                        onExportGguf?.(adapterPath, q.id);
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        width: "100%",
                        padding: "6px 10px",
                        background: bg,
                        border: "none",
                        borderRadius: 4,
                        color,
                        textAlign: "left",
                        fontSize: 12,
                        cursor: "pointer",
                      }}
                      onMouseEnter={(ev) => { (ev.currentTarget as HTMLElement).style.outline = "1px solid rgba(102,126,234,0.5)"; }}
                      onMouseLeave={(ev) => { (ev.currentTarget as HTMLElement).style.outline = "none"; }}
                    >
                      <span style={{ width: 70, fontWeight: 700 }}>{q.label}</span>
                      <span style={{ flex: 1, fontSize: 10, color: fit === "ok" ? "#9aa0aa" : color }}>
                        {q.quality}
                        {isRecommended ? <span style={{ marginLeft: 6, color: "#10a37f" }}>★</span> : null}
                      </span>
                      <span style={{ width: 70, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {sourceBytes ? fmtBytes(eb) : "—"}
                      </span>
                      <span style={{ width: 14, textAlign: "right" }}>
                        {fit === "no" ? "❌" : fit === "tight" ? "⚠" : "✅"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      }
    />
  );
}
