// TunedModelCard — fine-tuned adapters grid card. Shares the same
// CardShell as ModelCard/DownloadedModelCard; adds:
//   • LoRA / GGUF format pill in the title row
//   • steps / loss / created-at sub-row
//   • Test / Export GGUF / Delete actions
//   • a green "TUNED" corner ribbon so the LoRA adapters read at a
//     glance vs. base models

import React from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import CardShell, { compatBg } from "./CardShell";
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
  /// GPU-fit compatibility badge for the base model this adapter
  /// rides on top of. Same shape Browse + Downloaded cards use —
  /// drives the border colour and a corner pill so all three card
  /// families read identically for the same model. Undefined → fall
  /// back to a neutral indigo border (used when the base model can't
  /// be parsed out of the adapter directory name).
  compatibilityBadge?: CompatibilityBadge;
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
    compatibilityBadge, onExportGguf, onDelete, onSelect,
  } = props;

  // Export-GGUF dropdown state. Opens on the 📦 button click, fetches
  // the source dir's safetensor bytes once, then renders QUANTS with
  // size estimates and red-marks anything that won't fit in VRAM.
  //
  // The menu uses position:fixed (not absolute) so it escapes the
  // CardShell's overflow-clipping container. menuPos is computed from
  // the trigger's getBoundingClientRect() at open time, plus refreshed
  // on scroll/resize so the menu tracks the card if the user scrolls
  // while it's open.
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [menuPos, setMenuPos] = React.useState<{ top: number; left: number } | null>(null);
  const [sourceBytes, setSourceBytes] = React.useState<number | null>(null);
  const [loadingSize, setLoadingSize] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);

  const recomputeMenuPos = React.useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    // Open BELOW the trigger by default; flip ABOVE if there isn't
    // ~340 px of room left between the trigger and the viewport bottom.
    const menuH = 360;
    const wantTop = r.bottom + 6;
    const top = (wantTop + menuH > window.innerHeight) ? Math.max(8, r.top - menuH - 6) : wantTop;
    // Clamp horizontally so a card near the right edge doesn't push
    // the 320 px menu off-screen.
    const menuW = 320;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - menuW - 8);
    setMenuPos({ top, left });
  }, []);

  React.useEffect(() => {
    if (!menuOpen) return;
    if (sourceBytes !== null || loadingSize) return;
    setLoadingSize(true);
    invoke<number>("hf_dir_weight_bytes", { path: adapterPath })
      .then((b) => setSourceBytes(b || 0))
      .catch(() => setSourceBytes(0))
      .finally(() => setLoadingSize(false));
  }, [menuOpen, adapterPath, sourceBytes, loadingSize]);

  // Close menu on outside click + keep its position glued to the
  // trigger when the user scrolls/resizes while it's open.
  React.useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setMenuOpen(false);
    };
    const onScroll = () => recomputeMenuPos();
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true); // capture so nested scrollers also trigger
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [menuOpen, recomputeMenuPos]);

  const isGguf = format === "gguf";
  // Border colour is driven by GPU-fit compat, same as Browse and
  // Downloaded cards. Falls back to the default indigo when we can't
  // parse the base model's parameter count out of the adapter
  // directory name. (Format — LoRA vs GGUF — is shown as a separate
  // badge in the title row so it doesn't fight with the GPU-fit pill
  // for the border colour.)
  const compat: CompatibilityBadge | undefined = compatibilityBadge;

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
      titleBadges={<>
        <span style={{
          background: isGguf ? "#9C27B0" : "#667eea",
          color: "white", padding: "3px 8px", borderRadius: 4,
          fontSize: 11, fontWeight: "bold",
        }}>{isGguf ? "GGUF" : "LoRA"}</span>
        {compatibilityBadge && (
          <span
            title={compatibilityBadge.tooltip}
            style={{
              background: compatBg(compatibilityBadge.color),
              color: "white", padding: "3px 8px", borderRadius: 4,
              fontSize: 11, fontWeight: "bold",
              maxWidth: 180,
              whiteSpace: "normal",
              lineHeight: 1.2,
            }}
          >{compatibilityBadge.text}</span>
        )}
      </>}
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
          {!isGguf && (
            <button
              ref={triggerRef}
              style={btn}
              onClick={(e) => {
                e.stopPropagation();
                if (!menuOpen) recomputeMenuPos();
                setMenuOpen(v => !v);
              }}
            >📦 Export GGUF ▾</button>
          )}
          <button style={dangerBtn} onClick={(e) => { e.stopPropagation(); onDelete?.(adapterPath); }}>🗑️ Delete</button>

          {/* Portal the menu directly under document.body to escape the
              CardShell's transformed ancestor. CardShell uses
              `transform: translateY(-1px)` on hover, which creates a
              containing block for position:fixed descendants — the
              dropdown was rendering inside the card's coordinate
              space and getting clipped by its overflow:hidden. Portal
              mounts the menu outside that subtree entirely. */}
          {menuOpen && !isGguf && menuPos && createPortal(
            <div
              ref={menuRef}
              onClick={(e) => e.stopPropagation()}
              style={{
                position: "fixed",
                top: menuPos.top,
                left: menuPos.left,
                zIndex: 9999,
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
            </div>,
            document.body
          )}
        </div>
      }
    />
  );
}
