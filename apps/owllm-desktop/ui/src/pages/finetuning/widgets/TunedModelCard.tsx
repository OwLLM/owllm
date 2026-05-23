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
  /// VRAM (in GiB) of the GPU the user actually selected in
  /// gpu_config.json — drives the per-quant fits-in-VRAM coloring on
  /// the Export GGUF picker. When undefined or zero, every quant is
  /// rendered neutral (no red marks) and the dropdown header tells
  /// the user we couldn't probe the GPU.
  vramGb?: number;
  /// Human-readable GPU name from hardware_info (e.g. "NVIDIA GeForce
  /// RTX 4090"). Shown in the dropdown header so the user can see at
  /// a glance which card the fit math is being computed against,
  /// rather than assuming we hardcoded something.
  gpuName?: string;
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
  /// Live progress status while THIS card's export is running. Two
  /// bits of feedback: a one-line status ("Writing GGUF · 12.4 GB",
  /// "Quantizing → Q4_K_M", "❌ Failed: …") and an optional 0..1
  /// progress fraction from log-derived hints. Both null = no export
  /// in flight. The parent (ModelsPage) tracks per-path state and
  /// passes it down only for the currently-exporting card.
  exportStatus?: string | null;
  exportProgress?: number | null;
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
// Reserve a 1.0 GiB pad for the KV cache, context, and CUDA bookkeeping.
// Previous value of 1.5 GiB was tuned for an 8K-context 70B-class model
// — way too pessimistic for typical 4-8K contexts on 7-14B GGUFs where
// the real KV cache lives around 500-800 MiB. With 1.5 the on-the-edge
// quants (Q2_K, Q3_K_M for a 14B on an 8 GB GPU) were getting flagged
// red even though llama-server runs them fine.
function fitsInVram(gguBytes: number, vramGb: number): "ok" | "tight" | "no" {
  if (!vramGb || vramGb <= 0) return "ok"; // no probe → don't penalise
  const totalNeeded = gguBytes + 1.0 * 1024 ** 3;
  const vramBytes = vramGb * 1024 ** 3;
  if (totalNeeded <= vramBytes * 0.85) return "ok";
  if (totalNeeded <= vramBytes) return "tight";
  return "no";
}

export default function TunedModelCard(props: TunedModelCardProps) {
  const {
    adapterName, baseModel, adapterPath, size, format = "lora",
    createdAt, steps, finalLoss, selected = false, vramGb, gpuName,
    compatibilityBadge, onExportGguf, onDelete, onSelect,
    exportStatus = null, exportProgress = null,
  } = props;

  // Pending quant pick inside the dropdown. Highlighted row, but the
  // export doesn't fire until the user clicks the bottom Export
  // button. Previous behaviour was click-row = start export, which
  // surprised users who wanted to compare sizes side-by-side before
  // committing. Default starts at q4_k_m and gets adjusted to the
  // largest VRAM-fitting quant once the size probe completes — see
  // the useEffect below.
  const [pendingQuant, setPendingQuant] = React.useState<string>("q4_k_m");
  // Track whether the user has manually picked a row. If they have,
  // we don't override their choice when the VRAM-aware "best fit"
  // computes (otherwise picking Q5_K_M on a beefy machine would
  // immediately get overwritten to Q4_K_M).
  const userPickedRef = React.useRef(false);

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

  // VRAM-aware "best quant for this hardware". Prefer quality
  // (largest bytesPerParam) while still fitting in the user's VRAM —
  // walk QUANTS in DESCENDING quality order and grab the first one
  // that reads as "ok". Falls back to "tight" if nothing fits cleanly,
  // then to the smallest if even that's too big. Used both for the
  // ★ marker and the default pendingQuant.
  const recommendedQuantId: string = React.useMemo(() => {
    if (!sourceBytes || !vramGb) return "q4_k_m";
    const sorted = [...QUANTS].sort((a, b) => b.bytesPerParam - a.bytesPerParam);
    const okPick = sorted.find((q) => fitsInVram(estGgufBytes(sourceBytes, q), vramGb) === "ok");
    if (okPick) return okPick.id;
    const tightPick = sorted.find((q) => fitsInVram(estGgufBytes(sourceBytes, q), vramGb) === "tight");
    if (tightPick) return tightPick.id;
    // Nothing fits — bias to the smallest so the user at least sees a
    // viable choice. They can still pick a bigger one manually for
    // CPU-offload runs.
    return QUANTS[0].id;
  }, [sourceBytes, vramGb]);

  // Auto-select the recommended quant ONCE per dropdown open, only
  // while the user hasn't manually picked anything yet. Resets the
  // user-picked flag when the dropdown closes.
  React.useEffect(() => {
    if (!menuOpen) {
      userPickedRef.current = false;
      return;
    }
    if (!userPickedRef.current && sourceBytes != null) {
      setPendingQuant(recommendedQuantId);
    }
  }, [menuOpen, sourceBytes, recommendedQuantId]);

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
        {exportStatus && (
          <div style={{
            marginTop: 6,
            padding: "8px 10px",
            background: "rgba(var(--accent-rgb),0.10)",
            border: "1px solid rgba(var(--accent-rgb),0.35)",
            borderRadius: 6,
            fontSize: 11,
            color: "#dcdfe7",
            display: "flex", flexDirection: "column", gap: 6,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span>{exportStatus}</span>
            </div>
            {/* Progress bar: indeterminate-shimmer when progress is
                null (early phase, no total known); proportional fill
                once the convert script starts emitting tensor counts. */}
            <div style={{
              height: 4, width: "100%",
              background: "rgba(0,0,0,0.30)",
              borderRadius: 2, overflow: "hidden",
              position: "relative",
            }}>
              {exportProgress != null ? (
                <div style={{
                  height: "100%",
                  width: `${Math.max(2, Math.min(100, exportProgress * 100))}%`,
                  background: "#667eea",
                  transition: "width 180ms ease",
                }} />
              ) : (
                // CSS shimmer via background-position animation
                <div style={{
                  position: "absolute", inset: 0,
                  background: "linear-gradient(90deg, transparent 0%, #667eea 40%, #667eea 60%, transparent 100%)",
                  backgroundSize: "200% 100%",
                  animation: "owllm-shimmer 1.4s linear infinite",
                }} />
              )}
            </div>
          </div>
        )}
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
                border: "1px solid rgba(var(--accent-rgb),0.5)",
                borderRadius: 8,
                boxShadow: "0 10px 30px rgba(0,0,0,0.55)",
                padding: 6,
              }}
            >
              <div style={{ padding: "6px 8px", fontSize: 10, color: "#9aa0aa", lineHeight: 1.4 }}>
                Pick a quantization, then click Export.
                {vramGb ? (
                  <> Detected GPU:{" "}
                    <b style={{ color: "#cfd4e1" }}>{gpuName || "GPU"}</b>{" "}
                    <span style={{ color: "#cfd4e1" }}>({vramGb.toFixed(1)} GB)</span>;
                    ❌ rows won't fit, ⚠ rows are tight (will fit but no headroom for context).
                  </>
                ) : (
                  <span style={{ color: "#f5d76e" }}>
                    {" "}GPU not detected ({gpuName || "no probe"}) — fit
                    colours disabled. Confirm your selected GPU on the
                    main page header / Advanced › Hardware tab.
                  </span>
                )}
                {loadingSize ? " · scanning…" : null}
                <div style={{ marginTop: 4, color: "#7a8094" }}>
                  Output: <code style={{ color: "#c8cde0" }}>{adapterName}-&lt;QUANT&gt;.gguf</code> next to the source. Each quant lands as its own card so you can keep several at once.
                </div>
              </div>
              <div style={{ maxHeight: 320, overflowY: "auto" }}>
                {QUANTS.map((q) => {
                  const eb = sourceBytes ? estGgufBytes(sourceBytes, q) : 0;
                  const fit = sourceBytes ? fitsInVram(eb, vramGb ?? 0) : "ok";
                  // Row background + label colour driven by GPU fit.
                  // Previous opacities (0.10) made everything look
                  // identical — the icons ✅⚠❌ carried the whole
                  // signal. Stronger fills + a coloured left edge
                  // make the three states pop side-by-side.
                  const color =
                    fit === "no"    ? "#ffb0b0" :
                    fit === "tight" ? "#f5d76e" :
                                      "#b8f0c0";
                  const bg =
                    fit === "no"    ? "rgba(244,67,54,0.18)" :
                    fit === "tight" ? "rgba(255,193,7,0.16)" :
                                      "rgba(76,175,80,0.16)";
                  const edge =
                    fit === "no"    ? "#f44336" :
                    fit === "tight" ? "#f5b400" :
                                      "#4caf50";
                  // Recommendation is VRAM-aware now: largest quant
                  // that fits the user's GPU rather than a hardcoded
                  // q4_k_m. So on an 8 GB card with a 14B model the
                  // ★ moves to Q2_K / Q3_K_M (whichever's the largest
                  // green/tight quant) instead of taunting the user
                  // with Q4_K_M that doesn't fit.
                  const isRecommended = q.id === recommendedQuantId;
                  const isPicked = pendingQuant === q.id;
                  return (
                    <button
                      key={q.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        // Select-then-confirm: clicking a row just
                        // updates the pending pick. Bottom Export
                        // button is what actually fires the export.
                        userPickedRef.current = true;
                        setPendingQuant(q.id);
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        width: "100%",
                        padding: "6px 10px",
                        // Stack the GPU-fit bg with a left edge in the
                        // matching colour so each row has TWO redundant
                        // visual signals. When picked, swap the
                        // border to the selection blue but keep the
                        // GPU-fit edge so the user still sees red/
                        // yellow/green for the picked row.
                        background: isPicked
                          ? `linear-gradient(90deg, ${edge}40 0 4px, rgba(var(--accent-rgb),0.20) 4px 100%)`
                          : `linear-gradient(90deg, ${edge} 0 3px, ${bg} 3px 100%)`,
                        border: isPicked ? "1px solid #7fb8ff" : `1px solid ${edge}55`,
                        borderRadius: 4,
                        color,
                        textAlign: "left",
                        fontSize: 12,
                        cursor: "pointer",
                        marginBottom: 2,
                      }}
                      onMouseEnter={(ev) => { if (!isPicked) (ev.currentTarget as HTMLElement).style.outline = "1px solid rgba(var(--accent-rgb),0.5)"; }}
                      onMouseLeave={(ev) => { if (!isPicked) (ev.currentTarget as HTMLElement).style.outline = "none"; }}
                    >
                      <span style={{ width: 16, textAlign: "center", color: isPicked ? "#7fb8ff" : "#5a6376" }}>
                        {isPicked ? "●" : "○"}
                      </span>
                      <span style={{ width: 64, fontWeight: 700 }}>{q.label}</span>
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
              {/* Confirm row — only the click on THIS button actually
                  starts the export. Disabled while the size probe is
                  still in flight (we want the fit-warning visible
                  before committing). */}
              <div style={{
                display: "flex", alignItems: "center", gap: 8,
                marginTop: 6, padding: "6px 4px 0 4px",
                borderTop: "1px solid rgba(255,255,255,0.06)",
              }}>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    onExportGguf?.(adapterPath, pendingQuant);
                  }}
                  disabled={loadingSize || !pendingQuant}
                  style={{
                    flex: 1,
                    minHeight: 30, padding: "0 14px",
                    background: loadingSize ? "rgba(var(--accent-rgb),0.20)" : "#667eea",
                    color: "white",
                    border: "none",
                    borderRadius: 6,
                    fontSize: 12, fontWeight: 700,
                    cursor: loadingSize ? "default" : "pointer",
                  }}
                >📦 Export {pendingQuant.toUpperCase()}</button>
                <button
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); }}
                  style={{
                    minHeight: 30, padding: "0 12px",
                    background: "transparent",
                    color: "#9aa0a6",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 6,
                    fontSize: 11,
                    cursor: "pointer",
                  }}
                >Cancel</button>
              </div>
            </div>,
            document.body
          )}
        </div>
      }
    />
  );
}
