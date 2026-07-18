// WeightPickerDialog — port of LLM/desktop_app/main.py:11750 GGUF
// chooser. When a model has multiple weight files (typically GGUF
// quantization variants Q4_K_M / Q5_K_M / Q6_K / Q8_0), this modal
// lists them with size + GPU-fit coloring and lets the user pick which
// to download.
//
// Coloring rules (mirror the Qt path):
//   • Known size: green if size <= vram_gb, red otherwise.
//   • Unknown size: heuristic on the quant string — Q8/F16/F32 → red,
//     anything lighter → green.
// Empty selection is rejected (the Qt dialog also blocks accept until
// the user picks at least one).

import React from "react";
import { invoke } from "@tauri-apps/api/core";

export type HfFile = {
  path: string;
  size: number | null;
  lfs: boolean;
};

export type WeightPickerDialogProps = {
  modelId: string;
  /** GPU VRAM in GB, used to colour each quant green (fits) / red (won't
   *  load). Optional: undefined when no GPU probe is available, in which
   *  case nothing is constrained and the fit hint is dropped. */
  vramGb?: number;
  onCancel: () => void;
  /** Receives the list of selected file paths (subset of the repo's
   *  .gguf or .safetensors files). Pass through to hf_download as the
   *  `files` argument. */
  onConfirm: (selected: string[]) => void;
};

// Match Qt's `_guess_gguf_quant` regex set.
function guessQuant(name: string): string {
  const m = name.toLowerCase();
  // Order matters — match the most specific first.
  const patterns = [
    "iq1_s", "iq1_m", "iq2_xxs", "iq2_xs", "iq2_s", "iq2_m",
    "iq3_xxs", "iq3_xs", "iq3_s", "iq3_m",
    "iq4_xs", "iq4_nl",
    "q2_k_s", "q2_k",
    "q3_k_s", "q3_k_m", "q3_k_l", "q3_k_xl",
    "q4_0", "q4_1", "q4_k_s", "q4_k_m", "q4_k_l",
    "q5_0", "q5_1", "q5_k_s", "q5_k_m",
    "q6_k_s", "q6_k",
    "q8_0", "q8_k",
    "f16", "fp16", "bf16", "f32", "fp32",
  ];
  for (const p of patterns) {
    if (m.includes(p)) return p.toUpperCase();
  }
  return "?";
}

// Approximate VRAM cost ordering for unknown sizes. Used only when we
// don't have a bytes count from the HF tree (rare).
function quantWeight(quant: string): number {
  const q = quant.toLowerCase();
  if (q.includes("f32") || q.includes("fp32")) return 100;
  if (q.includes("f16") || q.includes("fp16") || q.includes("bf16")) return 90;
  if (q.startsWith("q8")) return 85;
  if (q.startsWith("q6")) return 70;
  if (q.startsWith("q5")) return 60;
  if (q.startsWith("q4")) return 50;
  if (q.startsWith("q3")) return 40;
  if (q.startsWith("q2")) return 30;
  if (q.startsWith("iq")) return 35;
  return 50;
}

function fmtSize(bytes: number | null): string {
  if (!bytes) return "size?";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export default function WeightPickerDialog(p: WeightPickerDialogProps) {
  const [files, setFiles] = React.useState<HfFile[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [downloadAll, setDownloadAll] = React.useState(false);

  React.useEffect(() => {
    let dead = false;
    setLoading(true);
    invoke<HfFile[]>("hf_model_files", { modelId: p.modelId, branch: null })
      .then((all) => {
        if (dead) return;
        // Only show GGUFs when there are multiple — that's the case
        // the Qt dialog handles. For HF transformers models the React
        // caller can use this same dialog with all .safetensors files.
        const ggufs = all.filter((f) => f.path.toLowerCase().endsWith(".gguf"));
        const list = ggufs.length > 0 ? ggufs : all.filter((f) =>
          f.path.toLowerCase().endsWith(".safetensors") || f.path.toLowerCase().endsWith(".bin")
        );
        // Sort heaviest → lightest like Qt does.
        list.sort((a, b) => {
          const av = a.size ?? quantWeight(guessQuant(a.path)) * 1e8;
          const bv = b.size ?? quantWeight(guessQuant(b.path)) * 1e8;
          return bv - av;
        });
        setFiles(list);
      })
      .catch((e) => { if (!dead) setError(String(e)); })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [p.modelId]);

  // No VRAM probe → don't constrain anything (every quant "fits").
  const vramBytes = p.vramGb ? p.vramGb * 1024 ** 3 : Infinity;

  const fits = (f: HfFile): boolean => {
    if (f.size && f.size > 0) return f.size <= vramBytes;
    return quantWeight(guessQuant(f.path)) < 80;
  };

  const toggle = (path: string) =>
    setPicked((curr) => {
      const next = new Set(curr);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });

  const submit = () => {
    if (downloadAll) {
      p.onConfirm([]); // empty means "download all" downstream
      return;
    }
    if (picked.size === 0) {
      setError("Pick at least one file, or check 'Download all'.");
      return;
    }
    p.onConfirm([...picked]);
  };

  return (
    <div
      onClick={p.onCancel}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.62)",
        display: "flex", alignItems: "center", justifyContent: "center",
        backdropFilter: "blur(2px)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 620, maxHeight: "85vh",
          background: "linear-gradient(180deg, #1a1d2e 0%, #16213e 100%)",
          border: "2px solid #667eea",
          borderRadius: 12,
          color: "#fafafa",
          display: "flex", flexDirection: "column",
          boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
        }}
      >
        <div style={{ padding: "14px 18px", borderBottom: "1px solid rgba(var(--accent-rgb),0.3)" }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Choose weights to download</div>
          <div style={{ fontSize: 12, color: "var(--fg-muted)", marginTop: 4 }}>
            {p.vramGb != null
              ? <><b>{p.modelId}</b> · Green = fits your {p.vramGb.toFixed(1)} GB VRAM · Red = won't load</>
              : <><b>{p.modelId}</b> · Pick the quant that fits your GPU</>}
          </div>
        </div>

        <div style={{ padding: "10px 18px", overflowY: "auto", flex: 1 }}>
          {loading && <div style={{ color: "var(--fg-muted)", padding: 20 }}>Loading file list…</div>}
          {error && (
            <div style={{
              background: "rgba(244,67,54,0.1)", border: "1px solid rgba(244,67,54,0.4)",
              borderRadius: 6, padding: 10, color: "#ff8080", fontSize: 12,
            }}>{error}</div>
          )}
          {!loading && !error && files.length === 0 && (
            <div style={{ color: "var(--fg-muted)", padding: 20 }}>
              No quantization variants found — this repo ships a single weight set, just hit "Download all".
            </div>
          )}

          {!loading && !error && files.length > 0 && (
            <>
              <label style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "8px 10px",
                background: "rgba(var(--accent-rgb),0.08)",
                border: "1px solid rgba(var(--accent-rgb),0.25)",
                borderRadius: 6,
                marginBottom: 10,
                cursor: "pointer",
              }}>
                <input
                  type="checkbox"
                  checked={downloadAll}
                  onChange={(e) => setDownloadAll(e.target.checked)}
                />
                <span style={{ fontWeight: 700 }}>📥 Download all weights</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>{files.length} files</span>
              </label>

              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {files.map((f) => {
                  const ok = fits(f);
                  const quant = guessQuant(f.path);
                  const sel = picked.has(f.path);
                  return (
                    <label
                      key={f.path}
                      title={ok ? "Fits your VRAM" : "Likely won't load"}
                      style={{
                        display: "flex", alignItems: "center", gap: 10,
                        padding: "6px 10px",
                        background: sel ? "rgba(var(--accent-rgb),0.12)" : "transparent",
                        border: `1px solid ${sel ? "rgba(var(--accent-rgb),0.5)" : "var(--border-strong)"}`,
                        borderRadius: 6,
                        cursor: downloadAll ? "default" : "pointer",
                        opacity: downloadAll ? 0.55 : 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        disabled={downloadAll}
                        checked={sel}
                        onChange={() => toggle(f.path)}
                      />
                      <span style={{
                        width: 8, height: 8, borderRadius: 4,
                        background: ok ? "#4CAF50" : "#f44336",
                        flexShrink: 0,
                      }} />
                      <span style={{ flex: 1, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12, color: ok ? "#d6f5d6" : "#ffb3b3", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {f.path}
                      </span>
                      <span style={{
                        fontSize: 10, padding: "2px 6px", borderRadius: 3,
                        background: "rgba(var(--accent-rgb),0.18)",
                        color: "#9cc3ff",
                      }}>{quant}</span>
                      <span style={{ fontSize: 11, color: "var(--fg-muted)", minWidth: 70, textAlign: "right" }}>
                        {fmtSize(f.size)}
                      </span>
                    </label>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <div style={{
          padding: "12px 18px",
          borderTop: "1px solid rgba(var(--accent-rgb),0.3)",
          display: "flex", justifyContent: "flex-end", gap: 8,
        }}>
          <button
            onClick={p.onCancel}
            style={{
              padding: "8px 16px",
              background: "transparent", border: "1px solid #2a3242",
              color: "var(--fg)", borderRadius: 6, fontSize: 12, cursor: "pointer",
            }}
          >Cancel</button>
          <button
            onClick={submit}
            disabled={loading || !!error}
            style={{
              padding: "8px 18px",
              background: "linear-gradient(180deg, var(--accent) 0%, var(--accent) 100%)",
              border: "none", color: "#fff",
              borderRadius: 6, fontSize: 13, fontWeight: 700, cursor: "pointer",
              boxShadow: "0 0 14px -4px var(--accent)88",
            }}
          >Download {picked.size > 0 && !downloadAll ? `(${picked.size})` : ""}</button>
        </div>
      </div>
    </div>
  );
}
