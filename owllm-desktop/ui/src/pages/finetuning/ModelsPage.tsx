// ModelsPage — skeleton for the TwinForge replication loop.
//
// HOW THIS FILE EVOLVES
// =====================
// The TwinForge loop compares this against the Qt Models tab
// (`LLM/desktop_app/main.py:7997` `_build_models_tab`) and applies
// Claude-Code patches per iteration. Anchors below match Qt
// objectNames so the structural diff aligns regions:
//
//   data-ui="formatFilterContainer" → Qt filter grid frame
//   data-ui="searchContainer"       → Qt search bar frame
//   data-ui="browseTabBtn"          → Qt browse_tab_btn
//   data-ui="downloadedTabBtn"      → Qt downloaded_tab_btn
//   data-ui="tunedTabBtn"           → Qt tuned_tab_btn

import React from "react";
import { LogBox } from "../../components/LogBox";
import ModelCard from "./widgets/ModelCard";
import DownloadedModelCard from "./widgets/DownloadedModelCard";
import { recordDownloadedModels, ghostedModels } from "./modelLibrary";
import TunedModelCard from "./widgets/TunedModelCard";
import AccessTokensPane from "./widgets/AccessTokensPane";
import WeightPickerDialog from "./widgets/WeightPickerDialog";
import { invoke, Channel } from "@tauri-apps/api/core";
import * as downloadStore from "./downloadStore";
import { chip, INPUT, BUTTON, banner } from "../../theme/styles";

type SubTab = "browse" | "downloaded" | "tuned" | "cache";

// Mirrors Rust HfModelHit in src-tauri/src/huggingface.rs.
type HfModelHit = {
  id: string;
  author: string | null;
  downloads: number;
  likes: number;
  pipelineTag: string | null;
  tags: string[];
  lastModified: string | null;
  gated: boolean;
  private: boolean;
  // GPU-fit badge computed Rust-side (parse_params_b + the user's VRAM), so a
  // searched/filtered result is colour-coded by size like a recommended one (#25).
  compat?: { color: "green" | "orange" | "red" | "gray"; text: string; tooltip?: string } | null;
};

// Mirrors Rust RecommendedModel in src-tauri/src/recommendations.rs.
type RecommendedModel = {
  id: string;
  name: string;
  family: string;
  description: string;
  paramsB: number;
  inferenceGb: number;
  loraTrainGb: number;
  qloraGb: number;
  downloads: number;
  likes: number;
  isNew: boolean;
  gated: boolean;
  tags: string[];
  category: string;
  compat: { color: "green" | "orange" | "red" | "gray"; text: string; tooltip: string } | null;
};

// Filter set IDs match the formatFilterContainer checkbox labels.
// "abliterated" replaces the old "chat" key — abliterated variants
// (refusal-stripped) are what users actually search for when checking
// this box. Generic chat tuning is implicit in most instruct models.
type FilterKey =
  | "trainable" | "gguf" | "instruct" | "abliterated"
  | "adapter"   | "quantized" | "reasoning" | "vision";

// HF query that "broadens" the result set when this filter is on.
// When ANY filter is checked, we run an hf_search with the combined
// query so the user sees fresh/newest matches from the full Hub —
// not just the curated 20.
const FILTER_HF_QUERY: Record<FilterKey, string> = {
  trainable:   "instruct",   // proxy: trainable bases are typically -instruct
  gguf:        "gguf",
  instruct:    "instruct",
  abliterated: "abliterated",
  adapter:     "lora",
  quantized:   "AWQ",
  reasoning:   "reasoning",
  vision:      "vision",
};

// Mirrors Rust DownloadedModel — serde renames fields to camelCase
// automatically via tauri::command's #[serde(rename_all="camelCase")]
// on the underlying struct. The Rust struct uses snake_case (env_key,
// is_incomplete) and they arrive here as envKey/isIncomplete.
type DownloadedItem = {
  name: string;
  path: string;
  size?: string;
  icons?: string;
  envKey?: string | null;
  isIncomplete?: boolean;
  onboarding?: "READY" | "BUILDING" | "BROKEN" | "NEW";
  compat?: { color: "green" | "orange" | "red" | "gray"; text: string; tooltip?: string } | null;
};

// One weight file on disk inside a downloaded model (a GGUF quant variant or a
// safetensors/bin shard). Mirrors Rust huggingface::ModelWeightFile.
type ModelWeightFile = { path: string; name: string; sizeBytes: number };

// Mirrors Rust TunedAdapter — list_tuned_adapters returns {name, path,
// sizeMib, modified, baseHint, compat}. compat is computed Rust-side
// from base_hint + the user's detected VRAM, mirroring what Browse
// cards get for the same base model. We map onto our TunedModelCard
// prop shape below in the render path.
type TunedAdapterRow = {
  name: string;
  path: string;
  sizeMib: number;
  modified: string | null;
  baseHint: string | null;
  compat?: { color: "green" | "orange" | "red" | "gray"; text: string; tooltip?: string } | null;
};

// Shared grid layout for every card-bearing surface (Browse,
// Downloaded, Tuned). Auto-fill with minmax(290, 390) so cards cap at
// 390 px wide and reflow on narrow viewports — same on every tab.
const CARD_GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(290px, 390px))",
  gap: 10,
  // Every card in a row is the SAME height (grid's default `stretch`): cards
  // stretch to the tallest one in their row, and CardShell keeps the Download
  // button pinned to the bottom (flex:1 spacer), so a row reads as a clean,
  // even strip instead of ragged cards. Shared by Browse / Downloaded / Tuned.
  alignItems: "stretch",
};

const emptyState: React.CSSProperties = {
  gridColumn: "1 / span 2",
  padding: 40,
  textAlign: "center",
  color: "var(--fg-muted)",
  border: "1px dashed var(--border-strong)",
  borderRadius: 8,
  fontSize: 13,
};

// Format a downloads / likes count as 1.2K / 45.8K / 1.2M for display.
function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// Derive a sensible icon set from HF tags so the cards aren't blank.
function iconsForTags(tags: string[]): string {
  const s = new Set(tags.map((t) => t.toLowerCase()));
  const out: string[] = [];
  if (s.has("conversational") || s.has("chat") || tags.some((t) => /chat|dialog/i.test(t))) out.push("💬");
  if (tags.some((t) => /instruct/i.test(t))) out.push("💡");
  if (tags.some((t) => /vision|llava|vl/i.test(t))) out.push("👁");
  if (tags.some((t) => /reasoning|cot|thinking/i.test(t))) out.push("🧠");
  if (tags.some((t) => /gguf/i.test(t))) out.push("📦");
  if (tags.some((t) => /lora|adapter|peft/i.test(t))) out.push("🧩");
  return out.join(" ");
}

// Same tag taxonomy as the filter checkboxes — produces a colored chip
// per matching tag so the user can see at a glance which filter labels
// each card satisfies. Colors match the filter row's emoji semantics:
// green=trainable, blue=GGUF, yellow=instruct, red=abliterated,
// teal=LoRA, orange=quantized, purple=reasoning, magenta=vision.
type TagChip = { key: string; label: string; color: string };
export function tagChipsForTags(tags: string[]): TagChip[] {
  const lower = tags.map((t) => t.toLowerCase());
  const out: TagChip[] = [];
  const has = (re: RegExp) => lower.some((t) => re.test(t));
  // Order matches the filter row top→bottom so visual scanning is consistent.
  if (has(/^transformers$|trainable/)) out.push({ key: "trainable", label: "✅ Trainable", color: "#22c55e" });
  if (has(/gguf/)) out.push({ key: "gguf", label: "📦 GGUF", color: "#3b82f6" });
  if (has(/instruct|^it$|-it$/)) out.push({ key: "instruct", label: "💡 Instruct", color: "#eab308" });
  if (has(/abliterat|uncensor/)) out.push({ key: "abliterated", label: "🚫 Abliterated", color: "#ef4444" });
  if (has(/lora|adapter|peft/)) out.push({ key: "adapter", label: "🧩 LoRA", color: "#14b8a6" });
  if (has(/awq|gptq|quantiz/)) out.push({ key: "quantized", label: "⚡ Quantized", color: "#f97316" });
  if (has(/reasoning|cot|thinking|r1|o1|qwq/)) out.push({ key: "reasoning", label: "🧠 Reasoning", color: "#a855f7" });
  if (has(/vision|llava|^vl-|-vl$|multimodal/)) out.push({ key: "vision", label: "👁️ Vision", color: "#ec4899" });
  return out;
}

// "Which lab cooked this model" badge (#25). The org is the HF id prefix
// (google/gemma-2-9b → google). Well-known labs get a recognisable glyph +
// brand colour + tidy display name; everything else falls back to a colour-
// hashed monogram so the chip is always deterministic and needs no bundled art.
export type OrgBadge = { name: string; glyph: string; color: string };
const ORG_BRAND: Record<string, OrgBadge> = {
  "google":        { name: "Google",        glyph: "G",  color: "#4285F4" },
  "deepseek-ai":   { name: "DeepSeek",      glyph: "🐋", color: "#4D6BFE" },
  "deepseek":      { name: "DeepSeek",      glyph: "🐋", color: "#4D6BFE" },
  "meta-llama":    { name: "Meta",          glyph: "🦙", color: "#0866FF" },
  "facebook":      { name: "Meta",          glyph: "🦙", color: "#0866FF" },
  "mistralai":     { name: "Mistral AI",    glyph: "🌬️", color: "#FA520F" },
  "qwen":          { name: "Qwen · Alibaba",glyph: "Q",  color: "#615CED" },
  "microsoft":     { name: "Microsoft",     glyph: "🪟", color: "#00A4EF" },
  "openai":        { name: "OpenAI",        glyph: "O",  color: "#10A37F" },
  "nvidia":        { name: "NVIDIA",        glyph: "N",  color: "#76B900" },
  "01-ai":         { name: "01.AI",         glyph: "0",  color: "#2563EB" },
  "huggingfaceh4": { name: "Hugging Face",  glyph: "🤗", color: "#FF9D00" },
  "huggingface":   { name: "Hugging Face",  glyph: "🤗", color: "#FF9D00" },
  "stabilityai":   { name: "Stability AI",  glyph: "S",  color: "#9333EA" },
  "tiiuae":        { name: "Falcon · TII",  glyph: "🦅", color: "#0EA5E9" },
  "bigcode":       { name: "BigCode",       glyph: "B",  color: "#F59E0B" },
  "ibm-granite":   { name: "IBM Granite",   glyph: "I",  color: "#0F62FE" },
  "cohereforai":   { name: "Cohere",        glyph: "C",  color: "#39594D" },
  "allenai":       { name: "Allen AI",      glyph: "A",  color: "#B11116" },
  "xai-org":       { name: "xAI",           glyph: "X",  color: "#111111" },
  "internlm":      { name: "InternLM",      glyph: "I",  color: "#2563EB" },
  "thudm":         { name: "Zhipu · THUDM", glyph: "Z",  color: "#3B82F6" },
};
const ORG_HUES = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#a855f7", "#ec4899", "#14b8a6"];
export function orgFromId(id: string, author: string | null): OrgBadge | null {
  const slug = (id.includes("/") ? id.split("/")[0] : (author ?? "")).trim().toLowerCase();
  if (!slug) return null;
  const known = ORG_BRAND[slug];
  if (known) return known;
  // Prettify: "some-lab_ai" → "Some Lab Ai"; colour-hash for a stable monogram.
  const name = slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return { name, glyph: slug[0].toUpperCase(), color: ORG_HUES[h % ORG_HUES.length] };
}

// Kick the Rust export_gguf command against a tuned transformers dir.
// Lightweight wrapper: spawn, log progress to console + show the user
// a banner via setError, refresh the tuned list on completion so the
// new .gguf file appears as a sibling row.
// Classify a log line so the UI can colour real errors red, real
// warnings yellow, and everything else (INFO) plain. Stream alone
// isn't enough — Python's logging module writes INFO to stderr by
// default, so "is stderr" ≠ "is an error".
function classifyLogSeverity(line: string): "err" | "warn" | "info" {
  const low = line.toLowerCase();
  if (
    low.includes("traceback") ||
    /\berror\b/.test(low) ||
    low.includes("exception") ||
    low.includes("fatal") ||
    low.includes("notimplemented")
  ) {
    return "err";
  }
  if (
    low.includes("warning:") ||
    low.includes("futurewarning") ||
    low.includes("userwarning") ||
    low.includes("deprecat") ||
    low.startsWith("warn") ||
    low.startsWith("warning") ||
    low.startsWith("⚠")
  ) {
    return "warn";
  }
  return "info";
}

// Pluck a human-readable status from a single convert_hf_to_gguf.py
// line. The script doesn't emit a structured progress channel, but it
// logs enough breadcrumbs (blk.N.*, "Set model tokenizer", "Writing
// the following files", total_size=X) that we can show the user what
// phase they're in instead of a wall of mysterious stderr.
function deriveExportStatus(line: string): string | null {
  // Block processing — keep the highest block number seen so we can
  // show "block N" even while later attn/ffn lines for the same
  // block scroll by.
  const blk = line.match(/blk\.(\d+)\./);
  if (blk) return `🔄 Processing layer ${blk[1]}`;
  if (line.includes("Set model parameters")) return "⚙️ Reading model parameters";
  if (line.includes("Set model tokenizer") || line.includes("vocab")) return "🔤 Reading tokenizer / vocab";
  if (line.includes("Set model quantization")) return "📐 Setting quantization metadata";
  // gguf_writer: ".../X.gguf: n_tensors = N, total_size = X"
  const writing = line.match(/total_size\s*=\s*([\d.]+\s*[KMGT]?)/i);
  if (writing) return `💾 Writing GGUF to disk — ${writing[1]} (this can take several minutes)`;
  if (line.match(/Loading model.*part/) || line.includes("model-")) return "📥 Reading source weights";
  if (line.includes("Model conversion") && line.includes("success")) return "✅ Done";
  return null;
}

function exportTunedToGguf(
  sourceDir: string,
  outtype: string,
  setError: (msg: string | null) => void,
  refreshTuned: () => void,
  setLogs: (updater: (prev: string[]) => string[]) => void,
  setLogsOpen: (v: boolean) => void,
  setStatus: (s: string) => void,
  setExportingPath: (p: string | null) => void,
  setExportProgress: (p: number | null) => void,
  setPhantomExport: (p: { sourceDir: string; outtype: string; baseName: string } | null) => void,
) {
  type Evt =
    | { kind: "progress"; stage: string; step?: number; total?: number; detail?: string }
    | { kind: "log"; stream: string; line: string }
    | { kind: "finished"; outputDir: string }
    | { kind: "failed"; error: string };
  console.log("[export-gguf] click → sourceDir =", sourceDir);
  const channel = new Channel<Evt>();
  setError(`📦 Exporting GGUF from ${sourceDir.split(/[\\/]/).pop()}…`);
  setLogs(() => []);
  setLogsOpen(true);
  setStatus("🚀 Starting…");
  setExportingPath(sourceDir);
  setExportProgress(0);
  // Synthesise the phantom output card. Filename matches the Rust
  // side: <basename>-<QUANT>.gguf inside the source dir. Cleared on
  // Finished (real card takes over) or Failed (no orphan card).
  const phantomBase = sourceDir.split(/[\\/]/).pop() ?? "model";
  setPhantomExport({ sourceDir, outtype, baseName: phantomBase });
  // Progress mapping. Three phases, each takes a slice of the bar:
  //   Convert  (load HF + iterate blocks):    0.00 .. 0.30
  //   Write    (one big GGUF dump, no signal): 0.30 .. 0.40
  //   Quantize (only when K-quant target;
  //             llama-quantize iterates every
  //             tensor and prints `[N/M] …`):  0.40 .. 1.00
  // For native targets (f16/bf16/q8_0/auto) the Quantize phase
  // doesn't run; the Write slice carries through to 1.0 on Finished.
  let maxBlk = -1;
  let blkTotal: number | null = null;
  let quantTotal: number | null = null;
  let quantSeen = 0;
  let phase: "convert" | "write" | "quantize" = "convert";
  const pushLog = (s: string) => setLogs((prev) => {
    const next = [...prev, s];
    return next.length > 300 ? next.slice(next.length - 300) : next;
  });
  channel.onmessage = (ev) => {
    console.log("[export-gguf] event", ev);
    if (ev.kind === "log") {
      const sev = classifyLogSeverity(ev.line);
      const tag = sev === "err" ? "[ERR]" : sev === "warn" ? "[WRN]" : "[INF]";
      pushLog(`${tag} ${ev.line}`);
      const newStatus = deriveExportStatus(ev.line);
      if (newStatus) setStatus(newStatus);

      // ----- Convert phase progress (0 .. 0.30) -----
      // Detect block count from the convert script's metadata line
      // ("block_count = N") when it's emitted; fall back to 40 as a
      // reasonable upper bound for 13-14B models. Once a higher blk
      // index than that appears, we lift the projected total to
      // match (architecture is larger than expected).
      const blkCountMatch = ev.line.match(/block_count\s*=\s*(\d+)/i);
      if (blkCountMatch) {
        blkTotal = parseInt(blkCountMatch[1], 10);
      }
      const blk = ev.line.match(/blk\.(\d+)\./);
      if (blk && phase === "convert") {
        const n = parseInt(blk[1], 10);
        if (!isNaN(n) && n > maxBlk) {
          maxBlk = n;
          const total = blkTotal ?? Math.max(maxBlk + 1, 40);
          setExportProgress(Math.min(0.30, ((maxBlk + 1) / total) * 0.30));
        }
      }

      // ----- Write phase (0.30 .. 0.40) -----
      // "total_size = X" from gguf_writer means the convert pass is
      // done collecting metadata and is now streaming bytes to disk.
      // There's no incremental signal — jump to the start of the
      // Write slice. If we never see a quantize line afterwards
      // (native target), Finished closes the bar to 1.0.
      if (/total_size\s*=/.test(ev.line) && phase === "convert") {
        phase = "write";
        setExportProgress(0.30);
      }

      // ----- Quantize phase (0.40 .. 1.00) -----
      // llama-quantize prints lines like:
      //   `[   1/ 579]                 token_embd.weight - …`
      // The first number is the current tensor; the second is the
      // total. Use those for real progress through this slice. The
      // "[N/M]" pattern is space-padded so the regex tolerates that.
      const qm = ev.line.match(/^\s*\[\s*(\d+)\s*\/\s*(\d+)\s*\]/);
      if (qm) {
        const cur = parseInt(qm[1], 10);
        const total = parseInt(qm[2], 10);
        if (!isNaN(cur) && !isNaN(total) && total > 0) {
          if (phase !== "quantize") phase = "quantize";
          quantTotal = total;
          quantSeen = cur;
          // Map cur/total into 0.40 .. 1.00. Cap at 0.99 — Finished
          // is what bumps to 1.00 so the user knows it's truly done.
          setExportProgress(0.40 + Math.min(0.99 - 0.40, (cur / total) * (0.99 - 0.40)));
        }
      } else if (/quantizing/i.test(ev.line) && phase === "write") {
        // First quantize-phase line that ISN'T [N/M] yet — bump into
        // the quantize slice so the bar moves visibly while we wait
        // for the per-tensor lines.
        phase = "quantize";
        setExportProgress(0.42);
      }

      if (sev === "err") {
        setError(`GGUF export: ${ev.line}`);
      }
    } else if (ev.kind === "finished") {
      setError(`✅ GGUF written → ${ev.outputDir}`);
      setStatus("✅ Done");
      setExportProgress(1);
      // Keep the status row visible for a moment, then clear it so
      // the card returns to its normal layout.
      window.setTimeout(() => {
        setExportingPath(null);
        setExportProgress(null);
        setPhantomExport(null);
      }, 2500);
      refreshTuned();
    } else if (ev.kind === "failed") {
      setError(`❌ GGUF export failed: ${ev.error} — see logs below`);
      setStatus(`❌ Failed: ${ev.error}`);
      setLogsOpen(true);
      // Leave the failure status visible — user needs to read the
      // logs. Clear exportingPath so they can retry from the same
      // card without re-triggering progress state.
      setExportingPath(null);
      setExportProgress(null);
      setPhantomExport(null);
    }
    // Silence "unused" warnings for tracking state used in future
    // sub-phase work (quantSeen / quantTotal will drive an
    // ETA estimate next).
    void quantSeen; void quantTotal;
  };
  invoke<void>("export_gguf", {
    config: { sourceDir, outtype },
    channel,
  })
    .then(() => console.log("[export-gguf] invoke returned ok (script running in background)"))
    .catch((e) => {
      console.error("[export-gguf] invoke rejected", e);
      setError(`GGUF export start failed: ${e}`);
      setStatus("❌ Failed to start");
      pushLog(`[ERR] invoke rejected: ${e}`);
    });
}

// Delete a tuned adapter dir from disk after confirmation. Rust side
// is path-gated to <llm_root>/fine_tuned/ so a typo can't nuke a
// system dir. Refreshes the tile list on success.
function deleteTunedAdapter(
  path: string,
  name: string,
  setError: (msg: string | null) => void,
  refreshTuned: () => void,
) {
  const confirmed = window.confirm(
    `Delete tuned model "${name}"?\n\nPath: ${path}\n\nThis is permanent — the directory and all its files will be removed.`,
  );
  if (!confirmed) return;
  console.log("[delete-tuned] confirmed →", path);
  setError(`🗑️ Deleting ${name}…`);
  invoke<void>("delete_tuned_adapter", { path })
    .then(() => {
      setError(`✅ Deleted ${name}`);
      refreshTuned();
    })
    .catch((e) => {
      console.error("[delete-tuned] failed", e);
      setError(`❌ Delete failed: ${e}`);
    });
}

// DownloadedModelDetail — right-rail panel shown when a DOWNLOADED model is
// selected. Fixes "clicking a downloaded model shows nothing": it surfaces the
// model's info AND every weight file on disk, with per-file delete (a model
// often holds several GGUF quants — Q4_K_M / Q5_K_M / Q8_0 …) plus an
// Add-weights shortcut.
function DownloadedModelDetail({ item, onAddWeights, onChanged }: {
  item: DownloadedItem;
  onAddWeights: () => void;
  onChanged: () => void;
}) {
  const [weights, setWeights] = React.useState<ModelWeightFile[] | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [confirmPath, setConfirmPath] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    setErr(null);
    invoke<ModelWeightFile[]>("model_weight_files", { dir: item.path })
      .then(setWeights)
      .catch((e) => { setWeights([]); setErr(String(e)); });
  }, [item.path]);
  React.useEffect(() => { setWeights(null); setConfirmPath(null); load(); }, [item.path, load]);

  const del = async (path: string) => {
    setDeleting(path); setErr(null);
    try {
      await invoke("delete_model_weight", { path });
      setConfirmPath(null);
      load();
      onChanged();   // refresh the grid — size / onboarding may change
    } catch (e) { setErr(String(e)); }
    finally { setDeleting(null); }
  };

  const ob = item.onboarding ?? "NEW";
  const obColor = ob === "READY" ? "#4CAF50" : ob === "BUILDING" ? "#f0a832" : ob === "BROKEN" ? "#f44336" : "#9aa0aa";
  const totalBytes = (weights ?? []).reduce((s, w) => s + w.sizeBytes, 0);
  const lbl: React.CSSProperties = { fontSize: 10, color: "var(--fg-muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 };

  return (
    <div style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 20 }}>📦</span>
        <div style={{ fontSize: 13.5, fontWeight: 800, color: "var(--fg-strong)", wordBreak: "break-all", lineHeight: 1.2, minWidth: 0, flex: 1 }}>{item.name}</div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
        <span style={{ fontSize: 10, fontWeight: 800, color: obColor, border: `1px solid ${obColor}66`, background: `${obColor}1a`, borderRadius: 999, padding: "1px 7px" }}>{ob}</span>
        {item.compat && <span title={item.compat.tooltip} style={{ fontSize: 10, fontWeight: 700, color: "var(--fg)", border: "1px solid var(--border)", borderRadius: 999, padding: "1px 7px" }}>{item.compat.text}</span>}
        {item.envKey && <span style={{ fontSize: 10, color: "var(--fg-muted)" }}>⚙ {item.envKey}</span>}
        {item.isIncomplete && <span style={{ fontSize: 10, fontWeight: 700, color: "#ffb56a" }}>⚠ incomplete download</span>}
      </div>
      <div style={{ fontSize: 10, color: "var(--fg-subtle)", wordBreak: "break-all" }} title={item.path}>📁 {item.path}</div>

      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={lbl}>Weights on disk</span>
          {weights && weights.length > 0 && <span style={{ fontSize: 9.5, color: "var(--fg-subtle)" }}>{weights.length} · {fmtBytes(totalBytes)}</span>}
        </div>
        {err && <div style={{ fontSize: 11, color: "#ff8080", marginTop: 4 }}>{err}</div>}
        {weights === null ? (
          <div style={{ fontSize: 11, color: "var(--fg-subtle)", marginTop: 6 }}>Loading…</div>
        ) : weights.length === 0 ? (
          <div style={{ fontSize: 11, color: "var(--fg-subtle)", marginTop: 6, fontStyle: "italic" }}>No weight files found in this folder.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 6 }}>
            {weights.map((w) => {
              const confirming = confirmPath === w.path;
              return (
                <div key={w.path} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 7px", borderRadius: 6, background: "var(--bg-surface)", border: "1px solid var(--border)" }}>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span title={w.name} style={{ display: "block", fontSize: 11, color: "var(--fg)", fontFamily: "ui-monospace, monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.name}</span>
                    <span style={{ fontSize: 9.5, color: "var(--fg-subtle)" }}>{fmtBytes(w.sizeBytes)}</span>
                  </span>
                  {confirming ? (
                    <>
                      <button onClick={() => del(w.path)} disabled={deleting === w.path} style={{ fontSize: 10, fontWeight: 800, color: "#fff", background: "#d23b3b", border: "none", borderRadius: 5, padding: "3px 8px", cursor: "pointer" }}>{deleting === w.path ? "…" : "Delete"}</button>
                      <button onClick={() => setConfirmPath(null)} style={{ fontSize: 10, color: "var(--fg-muted)", background: "transparent", border: "1px solid var(--border-strong)", borderRadius: 5, padding: "3px 7px", cursor: "pointer" }}>✕</button>
                    </>
                  ) : (
                    <button onClick={() => setConfirmPath(w.path)} title="Delete this weight file" style={{ fontSize: 13, color: "#ff8c8c", background: "transparent", border: "none", cursor: "pointer", padding: "2px 4px" }}>🗑</button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <button onClick={onAddWeights} style={{ marginTop: 8, width: "100%", height: 28, borderRadius: 7, border: "1px dashed var(--accent)", background: "rgba(var(--accent-rgb),0.10)", color: "var(--accent)", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>➕ Add / download more weights…</button>
      </div>
    </div>
  );
}

export default function ModelsPage() {
  const [tab, setTab] = React.useState<SubTab>("browse");
  const [downloaded, setDownloaded] = React.useState<DownloadedItem[]>([]);
  const [tuned, setTuned] = React.useState<TunedAdapterRow[]>([]);

  // Browse-tab state. Recommended = curated, hardware-aware. Hits =
  // live HF search results when the user actually types a query.
  const [query, setQuery] = React.useState("");
  // Sort: matches HF API sort= keys for live searches AND drives the
  // local sort of the curated recommendations list when not searching.
  const [sortBy, setSortBy] = React.useState<"downloads" | "likes" | "lastModified">("downloads");
  const [recommended, setRecommended] = React.useState<RecommendedModel[]>([]);
  const [loadingRecommended, setLoadingRecommended] = React.useState(false);
  const [hits, setHits] = React.useState<HfModelHit[]>([]);
  const [loadingHits, setLoadingHits] = React.useState(false);
  const [hfError, setHfError] = React.useState<string | null>(null);
  // Rolling tail of GGUF export stdout/stderr — convert_hf_to_gguf.py
  // talks to stderr and the banner only shows the last setError() line,
  // so a silent crash leaves the user with no clue what happened.
  const [exportLogs, setExportLogs] = React.useState<string[]>([]);
  const [exportLogsOpen, setExportLogsOpen] = React.useState(false);
  // Live human-readable status derived from log lines. Shown above the
  // panel so the user knows what phase the export is in without having
  // to read the wall of INFO lines.
  const [exportStatus, setExportStatus] = React.useState<string>("");
  // Per-card progress: when an export is running this holds the
  // SOURCE adapter path. The matching TunedModelCard renders a
  // progress bar inline so the user sees activity on the card they
  // clicked instead of having to dig through the right-rail logs.
  const [exportingPath, setExportingPath] = React.useState<string | null>(null);
  const [exportProgress, setExportProgress] = React.useState<number | null>(null);
  // Phantom output card. When an export starts we synthesise a card
  // representing the .gguf that's about to land on disk and prepend
  // it to the Tuned list, so the user gets immediate visual feedback
  // ("the new model just appeared, and it's building"). The phantom
  // is keyed by sourceDir+outtype; cleared on Finished/Failed and
  // replaced by the real card via refreshTuned().
  const [phantomExport, setPhantomExport] = React.useState<{ sourceDir: string; outtype: string; baseName: string } | null>(null);
  // (export-log scrolling handled by the shared LogBox)
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null);
  // Download state lives in a MODULE-LEVEL store (downloadStore.ts) so the
  // progress bar survives leaving the Models page and coming back — the
  // download keeps running in Rust regardless of this component's lifecycle.
  // Subscribing here re-reads the in-flight progress on every (re)mount.
  const dlSnap = React.useSyncExternalStore(downloadStore.subscribe, downloadStore.getSnapshot);
  const downloading = dlSnap.downloading;
  const downloadProgress = dlSnap.progress;
  // Weight-picker modal: when set, opens for that model id.
  const [pickerFor, setPickerFor] = React.useState<string | null>(null);
  // VRAM + GPU name resolved from the same source the rest of the
  // app already uses (hardware_info). vram_status returns LIVE used /
  // total but its snake_case fields collide with our camelCase reader
  // — and worse, picking max-of-all GPUs ignores the user's explicit
  // selection in gpu_config.json. hardware_info returns the curated
  // list with a `selected` flag per GPU, so we pick THE GPU the user
  // told the app to use, surface its real name, and stop pretending
  // the fallback "8 GB" is real data.
  type GpuInfo = { index: number; name: string; vram_gb: number; uuid: string; selected: boolean };
  type HardwareInfo = { cpu_name: string; cpu_cores: number; cpu_threads: number; ram_total_gb: number; ram_used_gb: number; gpus: GpuInfo[] };
  const [vramGb, setVramGb] = React.useState<number | null>(null);
  const [gpuName, setGpuName] = React.useState<string>("");

  React.useEffect(() => {
    invoke<HardwareInfo>("hardware_info")
      .then((hw) => {
        if (!hw.gpus || hw.gpus.length === 0) {
          setVramGb(null);
          setGpuName("no GPU detected");
          return;
        }
        // Prefer the GPU the user marked selected (gpu_config.json).
        // Fall back to the largest one when nothing is marked — that's
        // the most permissive default for fit calculations.
        const selected = hw.gpus.find((g) => g.selected)
          ?? [...hw.gpus].sort((a, b) => b.vram_gb - a.vram_gb)[0];
        setVramGb(selected.vram_gb);
        setGpuName(selected.name);
      })
      .catch(() => {
        setVramGb(null);
        setGpuName("VRAM probe failed");
      });
  }, []);
  const [filters, setFilters] = React.useState<Set<FilterKey>>(new Set());
  // "search mode" = render `hits` instead of curated. We enter it when
  // the user types a query OR when at least one filter checkbox is on
  // (filters trigger a broad HF search via the effect below).
  const inSearchMode = (query.trim().length > 0 || filters.size > 0) && hits.length > 0;

  // Look up the currently selected card so the right-rail Info tab
  // has something to render. We resolve in priority order: hit > rec
  // (search results override curated when the same id appears).
  const selectedModelForInfo = React.useMemo(() => {
    if (!selectedId) return null;
    const hit = hits.find((h) => h.id === selectedId);
    if (hit) return {
      id: hit.id,
      name: hit.id.split("/").pop() ?? hit.id,
      description: hit.pipelineTag ? `Pipeline: ${hit.pipelineTag}` : "",
      downloads: hit.downloads,
      likes: hit.likes,
      lastModified: hit.lastModified,
      tags: hit.tags,
      gated: hit.gated || hit.private,
      paramsB: null as number | null,
      inferenceGb: null as number | null,
      loraTrainGb: null as number | null,
      compat: null as RecommendedModel["compat"],
    };
    const rec = recommended.find((r) => r.id === selectedId);
    if (rec) return {
      id: rec.id,
      name: rec.name,
      description: rec.description,
      downloads: rec.downloads,
      likes: rec.likes,
      lastModified: null,
      tags: rec.tags,
      gated: rec.gated,
      paramsB: rec.paramsB,
      inferenceGb: rec.inferenceGb,
      loraTrainGb: rec.loraTrainGb,
      compat: rec.compat,
    };
    return null;
  }, [selectedId, hits, recommended]);

  // Filter predicate. An empty filter set means "show everything".
  // Otherwise we OR-match across selected filters using tag heuristics.
  const matchesFilters = React.useCallback(
    (tags: string[], idOrName: string): boolean => {
      if (filters.size === 0) return true;
      const t = new Set(tags.map((x) => x.toLowerCase()));
      const s = (idOrName || "").toLowerCase();
      const has = (k: FilterKey): boolean => {
        switch (k) {
          case "trainable":   return t.has("trainable") || (!s.includes(".gguf") && !s.includes("lora") && !s.includes("awq") && !s.includes("gptq"));
          case "gguf":        return t.has("gguf") || s.includes("gguf");
          case "instruct":    return t.has("instruct") || /instruct|-it\b/.test(s);
          case "abliterated": return /abliterated|uncensored/.test(s);
          case "adapter":     return t.has("lora") || t.has("adapter") || t.has("peft") || /lora|adapter|peft/.test(s);
          case "quantized":   return t.has("quantized") || /awq|gptq|q4|q5|q8/.test(s);
          case "reasoning":   return t.has("reasoning") || /r1|reasoning|thinking|qwq|deepseek-r/.test(s);
          case "vision":      return t.has("vision") || /vl\b|llava|vision/.test(s);
        }
      };
      for (const k of filters) if (has(k)) return true;
      return false;
    },
    [filters]
  );

  const runSearch = React.useCallback(async (q: string, sort?: typeof sortBy) => {
    setLoadingHits(true);
    setHfError(null);
    try {
      const r = await invoke<HfModelHit[]>("hf_search", {
        query: q,
        pipelineTag: null,
        limit: 30,
        sort: sort ?? sortBy,
      });
      setHits(r);
    } catch (e) {
      setHfError(String(e));
      setHits([]);
    } finally {
      setLoadingHits(false);
    }
  }, [sortBy]);

  // Load the curated recommendations on first browse mount.
  React.useEffect(() => {
    if (tab === "browse" && recommended.length === 0 && !loadingRecommended) {
      setLoadingRecommended(true);
      invoke<RecommendedModel[]>("models_recommended")
        .then((r) => setRecommended(r))
        .catch((e) => setHfError(`Recommendations failed: ${e}`))
        .finally(() => setLoadingRecommended(false));
    }
  }, [tab, recommended.length, loadingRecommended]);

  // When any filter is checked AND the user hasn't typed a search,
  // auto-run an HF search with the combined filter query so the user
  // sees real fresh/popular hits instead of just the 20 curated ones.
  // Empty filter set returns the curated view.
  React.useEffect(() => {
    if (tab !== "browse") return;
    if (query.trim().length > 0) return; // explicit search wins
    if (filters.size === 0) {
      setHits([]); // back to recommended view
      return;
    }
    const parts = [...filters].map((k) => FILTER_HF_QUERY[k]).filter(Boolean);
    const q = parts.join(" ");
    runSearch(q);
  }, [filters, tab, query, runSearch]);

  // Re-run the active search whenever the sort key changes so the user
  // gets fresh server-sorted results.
  React.useEffect(() => {
    if (tab !== "browse") return;
    const q = query.trim();
    if (q.length > 0 || filters.size > 0) {
      const parts = q.length > 0
        ? [q]
        : [...filters].map((k) => FILTER_HF_QUERY[k]).filter(Boolean);
      runSearch(parts.join(" "), sortBy);
    }
  }, [sortBy]); // intentionally only when sortBy flips

  React.useEffect(() => {
    if (tab === "downloaded") {
      invoke<DownloadedItem[]>("models_list_downloaded")
        .then((d) => { setDownloaded(d); recordDownloadedModels(d.map((x) => x.name)); })
        .catch(() => setDownloaded([]));
    } else if (tab === "tuned") {
      invoke<TunedAdapterRow[]>("list_tuned_adapters")
        .then(setTuned)
        .catch(() => setTuned([]));
    }
  }, [tab]);

  // Re-fetch the tuned list (called after a GGUF export finishes so
  // the new .gguf file shows up immediately).
  const refreshTuned = React.useCallback(() => {
    invoke<TunedAdapterRow[]>("list_tuned_adapters")
      .then(setTuned)
      .catch(() => { /* keep prior */ });
  }, []);

  // Re-fetch the downloaded list (after deleting a weight / adding weights) so
  // the Downloaded grid + the detail panel reflect what's on disk now.
  const refreshDownloaded = React.useCallback(() => {
    invoke<DownloadedItem[]>("models_list_downloaded")
      .then((d) => { setDownloaded(d); recordDownloadedModels(d.map((x) => x.name)); })
      .catch(() => { /* keep prior */ });
  }, []);

  // Step 1: clicking Download opens the WeightPickerDialog so the
  // user can choose which files to fetch (Q4/Q5/Q6/Q8 etc) instead of
  // pulling every variant blindly.
  const startDownload = (modelId: string) => {
    setPickerFor(modelId);
  };

  // Step 2: picker resolves with a list. Empty = "download all" — in
  // which case we expand it via hf_model_files first. hf_download is
  // a SINGLE-FILE Tauri command (takes `file: String`, not `files`),
  // so we loop on the React side; each call gets its own Channel for
  // progress events. The previous code was passing `files` as if the
  // Rust side accepted a Vec — that's why every download instantly
  // errored with "missing required key file".
  // Delegates to the module-level store so the download (and its progress
  // bar) survive navigating away from this page and back. All the channel /
  // looping / progress logic now lives in downloadStore.ts.
  const confirmDownload = async (modelId: string, files: string[]) => {
    setPickerFor(null);
    await downloadStore.startDownload(modelId, files);
  };

  // Resume an interrupted download from its on-disk .partial file(s) —
  // straight back into hf_download (which continues via HTTP Range), WITHOUT
  // re-opening the quantization picker. The picker only appears as a fallback
  // when there's no partial left to resume (e.g. the user deleted it).
  const resumeDownload = async (name: string, dirPath: string) => {
    const hfId = name.replace(/__/g, "/");
    try {
      const parts = await invoke<Array<{ file: string; bytesOnDisk: number }>>(
        "models_partial_files", { dir: dirPath },
      );
      if (parts.length > 0) {
        await downloadStore.startDownload(hfId, parts.map((p) => p.file));
        // Re-scan so the card drops its "incomplete" badge once done.
        refreshDownloaded();
        return;
      }
    } catch { /* fall through to the picker */ }
    setPickerFor(hfId);
  };

  return (
    <div
      data-ui="modelsPageRoot"
      style={{
        height: "100%",
        padding: 14,
        background: "var(--bg-panel)",
        color: "var(--fg)",
        overflow: "auto",
      }}
    >
      {/* Sticky toolbar — tabs + filters + order-by + search live in
          one block at the top of the page that doesn't scroll with
          the cards. Per user spec 2026-05-29: filter bar common to
          Browse / Downloaded / Tuned (was Browse-only); the meaningless
          'X Downloaded / Y Tuned / 0 Free / 0 Quantized' counts that
          used to live on the right are gone; Order-by + search row
          moves up to fill that space. */}
      <div data-ui="modelsToolbarSticky" style={{
        position: "sticky", top: 0, zIndex: 40,
        background: "var(--bg-panel)",
        paddingBottom: 8,
        marginBottom: 10,
      }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
        {([
          { key: "browse",     dataUi: "browseTabBtn",     label: "🚀 Browse Models" },
          { key: "downloaded", dataUi: "downloadedTabBtn", label: "💾 Downloaded"    },
          { key: "tuned",      dataUi: "tunedTabBtn",      label: "🎯 Tuned Models"  },
          // 💽 Cache moved to the Info page (next to Sandbox disk).
        ] as const).map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              data-ui={t.dataUi}
              onClick={() => setTab(t.key)}
              // Centralised in theme/styles.chip — height 50 (matches
              // formatFilterContainer), fontSize 15 (matches SubTabs),
              // active state pulls from --accent so light/dark + accent
              // picker all flow through one source of truth.
              style={chip(active)}
            >
              {t.label}
            </button>
          );
        })}
        {/* Filter checkbox container — now visible across Browse /
            Downloaded / Tuned. Cache tab has no concept of these
            filters so it still skips the block. */}
        {tab !== "cache" && (
        <div
          data-ui="formatFilterContainer"
          style={{
            width: 513,
            height: 50,
            padding: "4px 10px",
            background: "rgba(var(--accent-rgb), 0.08)",
            border: "1px solid rgba(var(--accent-rgb), 0.25)",
            borderRadius: 8,
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gridTemplateRows: "1fr 1fr",
            columnGap: 14,
            rowGap: 0,
            alignItems: "center",
            flexShrink: 0,
          }}
        >
          {([
            { key: "trainable"   as const, label: "✅ Trainable",   tip: "Transformers-format models with full weights — what the Train tab can fine-tune. Checking pulls newest instruct models from Hugging Face." },
            { key: "gguf"        as const, label: "📦 GGUF",        tip: "llama.cpp inference format. Checking searches Hugging Face for newest popular GGUF builds." },
            { key: "instruct"    as const, label: "💡 Instruct",    tip: "Instruction-tuned base models (-instruct, -it). Checking pulls newest instruct from Hugging Face." },
            { key: "abliterated" as const, label: "🚫 Abliterated", tip: "Refusal-stripped variants — checking searches Hugging Face for the newest abliterated/uncensored builds." },
            { key: "adapter"     as const, label: "🧩 LoRA",        tip: "PEFT / LoRA adapters — small overlays that need a base model to load. Checking searches for popular adapters." },
            { key: "quantized"   as const, label: "⚡ Quantized",    tip: "Inference-only weight-quantized checkpoints (AWQ / GPTQ). Checking searches for popular AWQ/GPTQ builds." },
            { key: "reasoning"   as const, label: "🧠 Reasoning",   tip: "Chain-of-thought reasoning models (R1, o1-style, deepseek-r1, QwQ). Checking searches for newest reasoning models." },
            { key: "vision"      as const, label: "👁️ Vision",      tip: "Multimodal vision-language models. Checking searches for newest vision-language builds." },
          ]).map((f) => {
            const on = filters.has(f.key);
            return (
              <label
                key={f.key}
                title={f.tip}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  color: on ? "var(--fg-strong)" : "var(--fg)",
                  fontWeight: on ? 700 : 400,
                  fontSize: "10pt",
                  background: "transparent",
                  cursor: "pointer",
                  userSelect: "none",
                  minWidth: 0,
                  overflow: "hidden",
                }}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => setFilters((curr) => {
                    const next = new Set(curr);
                    if (e.target.checked) next.add(f.key); else next.delete(f.key);
                    return next;
                  })}
                  style={{ width: 14, height: 14, margin: 0, flexShrink: 0 }}
                />
                <span style={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  minWidth: 0,
                }}>{f.label}</span>
              </label>
            );
          })}
        </div>
        )}
        {/* Order-by row (top) + Search row (below), stacked vertically
            to fit the SAME 50 px height the checkbox container uses
            on its left. Width is fully flexible (no minWidth so the
            container can shrink past 260 px when the row would
            otherwise wrap to two lines — the user complained the
            search was 'going to next row' even with plenty of
            horizontal space, because the previous min-width was
            forcing the wrap). */}
        {tab !== "cache" && (
        <div style={{
          marginLeft: "auto",
          display: "grid",
          gridTemplateRows: "1fr 1fr",
          gap: 4,
          height: 50,
          flex: "1 1 180px",
          minWidth: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, minHeight: 0 }}>
            <span style={{ fontSize: 9, color: "var(--fg-muted)", textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 700, whiteSpace: "nowrap" }}>Order by:</span>
            <select
              data-ui="sortSelector"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
              title="Sort by"
              style={{ ...INPUT.field, flex: 1, minWidth: 0, padding: "2px 6px", height: "100%", cursor: "pointer", fontSize: 11 }}
            >
              <option value="downloads">↓ Downloads</option>
              <option value="likes">❤ Likes</option>
              <option value="lastModified">🕓 Uploaded</option>
            </select>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4, minHeight: 0 }}>
            <input
              placeholder={tab === "browse" ? "Search Hugging Face…" : "Filter…"}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && tab === "browse") runSearch(query); }}
              style={{ ...INPUT.field, flex: 1, minWidth: 0, padding: "2px 8px", height: "100%", fontSize: 11 }}
            />
            <button
              title="Clear search"
              onClick={() => { setQuery(""); if (tab === "browse") runSearch(""); }}
              style={{ ...BUTTON.ghost, padding: "2px 8px", height: "100%", flexShrink: 0, fontSize: 11 }}
            >×</button>
            {tab === "browse" && (
              <button
                onClick={() => runSearch(query)}
                disabled={loadingHits}
                style={{ ...BUTTON.primary, padding: "2px 12px", height: "100%", flexShrink: 0, fontSize: 11 }}
              >
                {loadingHits ? "…" : "Search"}
              </button>
            )}
          </div>
        </div>
        )}
      </div>
      {/* The status/error banner lives INSIDE the sticky toolbar so it stacks
          BELOW the tabs instead of overlapping them. (It used to be a separate
          sticky top:0 sibling at a higher z-index, so a long "Deleting … cache"
          message painted over the tab row — bug #7.) */}
      {hfError && (
        <div
          onClick={() => setHfError(null)}
          title="click to dismiss"
          style={{
            // banner() reads accent + status tokens so the colours
            // adapt across themes. Tone is derived from the message
            // prefix the rest of the page emits.
            ...banner(
              hfError.startsWith("✅")
                ? "success"
                : (hfError.startsWith("❌") || hfError.includes("failed"))
                  ? "error"
                  : "info"
            ),
            marginTop: 2,
            cursor: "pointer",
          }}
        >
          {hfError.startsWith("✅") || hfError.startsWith("❌") || hfError.startsWith("📦") ? "" : "⚠ "}{hfError}
        </div>
      )}
      </div>

      {downloadProgress.size > 0 && (
        <div data-ui="DownloadProgressBanner" style={{
          position:"sticky", top: hfError ? 56 : 0, zIndex:49,
          marginBottom:10,
          display:"flex", flexDirection:"column", gap:6,
          padding:"10px 12px",
          background:"linear-gradient(135deg, rgba(38,30,10,0.96) 0%, rgba(18,14,4,0.96) 100%)",
          border:"1px solid rgba(255,200,80,0.45)",
          borderRadius:10,
          color:"var(--fg)",
        }}>
          <div style={{ fontSize:11, fontWeight:700, letterSpacing:1, textTransform:"uppercase", color:"#ffd97a" }}>
            ⬇ Downloads ({downloadProgress.size})
          </div>
          {Array.from(downloadProgress.entries()).map(([id, p]) => {
            const pct = p.total ? Math.min(100, (p.received / p.total) * 100) : null;
            const fmt = (n: number) => n >= 1024 ** 3
              ? `${(n / 1024 ** 3).toFixed(2)} GiB`
              : n >= 1024 ** 2
                ? `${(n / 1024 ** 2).toFixed(1)} MiB`
                : `${(n / 1024).toFixed(0)} KiB`;
            return (
              <div key={id} style={{ display:"flex", flexDirection:"column", gap:4 }}>
                <div style={{ display:"flex", alignItems:"baseline", gap:8, fontSize:12 }}>
                  <span style={{ fontWeight:700, color:"#fafafa" }}>{id}</span>
                  <span style={{ color:"var(--fg-muted)" }}>· file {p.fileIndex + 1}/{p.fileCount}: {p.file}</span>
                  <span style={{ flex:1 }} />
                  {p.error
                    ? <span style={{ color:"#ff8c8c", fontWeight:600 }}>✗ {p.error.slice(0, 120)}</span>
                    : p.done
                      ? <span style={{ color:"#5af09c", fontWeight:600 }}>✓ Done</span>
                      : <span style={{ color:"var(--fg-muted)" }}>
                          {fmt(p.received)}{p.total ? ` / ${fmt(p.total)}` : ""}
                          {pct !== null ? ` · ${pct.toFixed(1)}%` : ""}
                        </span>}
                </div>
                <div style={{
                  width:"100%", height:6, borderRadius:3,
                  background:"rgba(255,255,255,0.08)",
                  overflow:"hidden",
                }}>
                  <div style={{
                    width: pct !== null ? `${pct}%` : "100%",
                    height:"100%",
                    background: p.error ? "#ff8c8c" : p.done ? "#5af09c" : "#ffd97a",
                    transition:"width 200ms linear",
                    opacity: pct === null && !p.done && !p.error ? 0.5 : 1,
                  }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
      {tab === "browse" && <>
      {/* Qt main.py:8257-8289 — "📚 Recommended Models" at 16pt bold #667eea,
          followed inline (no stretch) by a 3-colour legend row. Dots are
          14pt; labels are 10pt #9aa0a6. legend_row contentsMargins (16,0,0,0)
          and spacing 14. */}
      <div style={{ display: "flex", alignItems: "center", gap: 0, marginBottom: 8 }}>
        <span
          style={{
            fontSize: 21,
            fontWeight: "bold",
            color: "#667eea",
            background: "transparent",
          }}
        >
          {inSearchMode ? "🔎 Search Results" : "📚 Recommended Models"}
        </span>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            marginLeft: 16,
          }}
        >
          {([
            { color: "#22c55e", label: "Fits comfortably (inference + fine-tuning)" },
            { color: "#f59e0b", label: "Tight fit (inference; fine-tuning may struggle)" },
            { color: "#ef4444", label: "Too large for your GPU (search only)" },
          ]).map((d) => (
            <React.Fragment key={d.color}>
              <span
                style={{
                  color: d.color,
                  fontSize: 19,
                  background: "transparent",
                  padding: 0,
                  margin: 0,
                  lineHeight: 1,
                }}
              >
                ●
              </span>
              <span
                style={{
                  color: "#9aa0a6",
                  fontSize: 13,
                  background: "transparent",
                }}
              >
                {d.label}
              </span>
            </React.Fragment>
          ))}
        </div>
      </div>
      </>}

      {/* Shared flex row across browse/downloaded/tuned: cards on the
          left, a sticky right rail holding the tokens/info panel and
          the GGUF export logs panel. The cache tab has its own
          full-width layout below. */}
      {tab !== "cache" && (
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
      {tab === "browse" && (
      <div style={CARD_GRID}>
        {(() => {
          // Choose which list to render: live search results when the
          // user has searched, otherwise the curated recommendations.
          if (inSearchMode) {
            const filtered = hits.filter((h) => matchesFilters(h.tags, h.id));
            if (filtered.length === 0) {
              return (
                <div style={emptyState}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>🤷</div>
                  No models matched "{query}" with the current filters.
                </div>
              );
            }
            return filtered.map((h) => {
              const dl = downloading.has(h.id);
              const isNewFlag = h.lastModified
                ? (Date.now() - new Date(h.lastModified).getTime()) < 14 * 24 * 3600 * 1000
                : false;
              return (
                <ModelCard
                  key={h.id}
                  modelName={h.id.split("/").pop() ?? h.id}
                  modelId={h.id}
                  org={orgFromId(h.id, h.author)}
                  description={h.pipelineTag ? `Pipeline: ${h.pipelineTag}` : undefined}
                  icons={iconsForTags(h.tags)}
                  tagChips={tagChipsForTags(h.tags)}
                  isNew={isNewFlag}
                  downloads={fmtCount(h.downloads)}
                  likes={fmtCount(h.likes)}
                  compatibilityBadge={h.compat ?? undefined}
                  requiresToken={h.gated || h.private}
                  isDownloaded={false}
                  downloadProgress={dl ? undefined : undefined}
                  selected={selectedId === h.id}
                  onClick={(id) => setSelectedId((curr) => curr === id ? null : id)}
                  onDownload={(id) => startDownload(id)}
                />
              );
            });
          }

          // Recommended mode.
          if (loadingRecommended && recommended.length === 0) {
            return (
              <div style={emptyState}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>🔎</div>
                Loading recommended models…
              </div>
            );
          }
          const filtered = recommended
            .filter((r) => matchesFilters(r.tags, r.id))
            .slice()
            .sort((a, b) => {
              if (sortBy === "likes")        return b.likes - a.likes;
              if (sortBy === "lastModified") return Number(b.isNew) - Number(a.isNew); // proxy
              return b.downloads - a.downloads;
            });
          if (filtered.length === 0) {
            return (
              <div style={emptyState}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>🤷</div>
                No recommended models match these filters. Clear them or run a search.
              </div>
            );
          }
          return filtered.map((r) => (
            <ModelCard
              key={r.id}
              modelName={r.name}
              modelId={r.id}
              org={orgFromId(r.id, null)}
              description={`${r.description}  ·  ${r.paramsB.toFixed(1)}B params · inference ≈${r.inferenceGb.toFixed(1)} GB · LoRA ≈${r.loraTrainGb.toFixed(1)} GB`}
              size={`${r.paramsB.toFixed(1)}B params`}
              icons={iconsForTags(r.tags)}
              tagChips={tagChipsForTags(r.tags)}
              isNew={r.isNew}
              downloads={fmtCount(r.downloads)}
              likes={fmtCount(r.likes)}
              requiresToken={r.gated}
              compatibilityBadge={r.compat ?? undefined}
              selected={selectedId === r.id}
              onClick={(id) => setSelectedId((curr) => curr === id ? null : id)}
              onDownload={(id) => startDownload(id)}
            />
          ));
        })()}
      </div>
      )}

      {tab === "downloaded" && (() => {
        // Live filter: substring match on the model name + apply the
        // top filter checkboxes (gguf / quantized / vision / etc.) so
        // the user can narrow down a long Downloaded list.
        const q = query.trim().toLowerCase();
        const list = downloaded.filter(d => {
          if (q && !d.name.toLowerCase().includes(q)) return false;
          if (filters.size > 0) {
            const nameL = d.name.toLowerCase();
            for (const f of filters) {
              const matched = (
                (f === "gguf"        && (nameL.includes("gguf") || d.envKey === "llama.cpp")) ||
                (f === "instruct"    && /(\binstruct\b|-it\b|-it-)/.test(nameL)) ||
                (f === "abliterated" && /(abliter|uncensored|heretic)/.test(nameL)) ||
                (f === "adapter"     && /(lora|adapter)/.test(nameL)) ||
                (f === "quantized"   && /(awq|gptq|q[2-8]_)/.test(nameL)) ||
                (f === "reasoning"   && /(r1\b|qwq|reasoning|thinking)/.test(nameL)) ||
                (f === "vision"      && /(vision|vl\b|-vl-)/.test(nameL)) ||
                (f === "trainable"   && d.onboarding === "RAW")
              );
              if (!matched) return false;
            }
          }
          return true;
        });
        // Ghosted: models in the user's synced library (downloaded on another
        // device) whose weights aren't on THIS disk. Shown dimmed with a
        // Download button so the library follows the user across devices.
        const ghosts = ghostedModels(downloaded.map((d) => d.name))
          .filter((n) => !q || n.toLowerCase().includes(q));
        return (
        <div style={CARD_GRID}>
          {downloaded.length === 0 && ghosts.length === 0 ? (
            <div style={{
              gridColumn: "1 / -1",
              padding: 40,
              textAlign: "center",
              color: "var(--fg-muted)",
              border: "1px dashed #2a3242",
              borderRadius: 8,
            }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>💾</div>
              <div style={{ fontSize: 14 }}>No models downloaded yet.</div>
              <div style={{ fontSize: 11, marginTop: 6 }}>
                Switch to the Browse tab and click Download on a model card to add one here.
              </div>
            </div>
          ) : list.length === 0 && ghosts.length === 0 ? (
            <div style={{
              gridColumn: "1 / -1",
              padding: 24,
              textAlign: "center",
              color: "var(--fg-muted)",
              border: "1px dashed #2a3242",
              borderRadius: 8,
            }}>
              <div style={{ fontSize: 13 }}>No downloaded models match the current filter / search.</div>
            </div>
          ) : (
            <>
              {list.map((d) => (
                <DownloadedModelCard
                  key={d.path}
                  modelName={d.name}
                  modelPath={d.path}
                  size={d.size}
                  icons={d.icons}
                  envKey={d.envKey}
                  isIncomplete={d.isIncomplete}
                  isActiveDownload={downloadStore.isActive(d.name.replace(/__/g, "/"))}
                  onboardingStatus={d.onboarding}
                  compatibilityBadge={d.compat ?? undefined}
                  selected={selectedPath === d.path}
                  onSelect={(p) => setSelectedPath((curr) => curr === p ? null : p)}
                  onRepair={() => { void resumeDownload(d.name, d.path); }}
                  onAddWeights={() => {
                    // Local dir convention from huggingface-cli / hf_hub:
                    // <author>/<repo> becomes <author>__<repo> on disk
                    // because Windows can't have '/' in a folder name.
                    // Reverse the convention to recover the HF id so
                    // hf_model_files doesn't 404/401 on the picker open.
                    const hfId = d.name.replace(/__/g, "/");
                    setPickerFor(hfId);
                  }}
                />
              ))}
              {/* Ghosted: in your synced library, not on this device's disk.
                  Dimmed card + one-click re-download. */}
              {ghosts.map((name) => {
                const hfId = name.replace(/__/g, "/");
                return (
                  <div
                    key={`ghost:${name}`}
                    title="In your model library (downloaded on another device) — not on this PC yet"
                    style={{
                      border: "1px dashed var(--border-strong)", borderRadius: 12,
                      padding: 14, background: "var(--bg-card)", opacity: 0.62,
                      display: "flex", flexDirection: "column", gap: 10, minHeight: 120,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 18 }}>☁️</span>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg-strong)", wordBreak: "break-all" }}>
                        {hfId}
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>
                      In your library — not downloaded on this device.
                    </div>
                    <div style={{ flex: 1 }} />
                    <button
                      onClick={() => startDownload(hfId)}
                      style={{
                        padding: "8px 12px", borderRadius: 8, border: "none",
                        background: "linear-gradient(180deg, color-mix(in srgb, var(--accent) 88%, #fff), var(--accent))",
                        color: "var(--accent-fg)", fontSize: 12.5, fontWeight: 800, cursor: "pointer",
                      }}
                    >⬇ Download to this PC</button>
                  </div>
                );
              })}
            </>
          )}
        </div>
        );
      })()}

      {tab === "tuned" && (
        <div style={CARD_GRID}>
          {/* Phantom output card — appears the instant the user clicks
              Export, so they get a visible "the new GGUF is being
              built" tile immediately instead of having to wait for
              refreshTuned() at the end. Lives at the top of the grid;
              cleared on Finished (real card takes over) or Failed. */}
          {phantomExport && (
            <TunedModelCard
              key={`phantom:${phantomExport.sourceDir}:${phantomExport.outtype}`}
              adapterName={`${phantomExport.baseName}-${phantomExport.outtype.toUpperCase()}.gguf`}
              baseModel={phantomExport.baseName}
              adapterPath={`${phantomExport.sourceDir}\\${phantomExport.baseName}-${phantomExport.outtype.toUpperCase()}.gguf`}
              format="gguf"
              size="(building…)"
              createdAt={undefined}
              vramGb={vramGb ?? undefined}
              gpuName={gpuName}
              exportStatus={exportStatus || "🚀 Starting…"}
              exportProgress={exportProgress}
            />
          )}
          {tuned.length === 0 && !phantomExport ? (
            <div style={{
              gridColumn: "1 / -1",
              padding: 40,
              textAlign: "center",
              color: "var(--fg-muted)",
              border: "1px dashed #2a3242",
              borderRadius: 8,
            }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>🎯</div>
              <div style={{ fontSize: 14 }}>No tuned adapters yet.</div>
              <div style={{ fontSize: 11, marginTop: 6 }}>
                Start a training run from the Train tab to produce a LoRA adapter.
              </div>
            </div>
          ) : tuned.map((t) => (
            <TunedModelCard
              key={t.path}
              adapterName={t.name}
              baseModel={t.baseHint ?? "(base unknown)"}
              adapterPath={t.path}
              format={t.path.toLowerCase().endsWith(".gguf") ? "gguf" : "lora"}
              size={t.sizeMib >= 1024 ? `${(t.sizeMib / 1024).toFixed(1)} GB` : `${t.sizeMib} MB`}
              createdAt={t.modified ?? undefined}
              selected={selectedPath === t.path}
              onSelect={(p) => setSelectedPath((curr) => curr === p ? null : p)}
              vramGb={vramGb ?? undefined}
              gpuName={gpuName}
              compatibilityBadge={t.compat ?? undefined}
              onExportGguf={(path, outtype) => {
                setTab("tuned");
                setExportLogsOpen(true);
                exportTunedToGguf(path, outtype, setHfError, refreshTuned, setExportLogs, setExportLogsOpen, setExportStatus, setExportingPath, setExportProgress, setPhantomExport);
              }}
              onDelete={(path) => deleteTunedAdapter(path, t.name, setHfError, refreshTuned)}
              exportStatus={exportingPath === t.path ? (exportStatus || "🚀 Starting…") : null}
              exportProgress={exportingPath === t.path ? exportProgress : null}
            />
          ))}
        </div>
      )}
      </div>
      {/* Shared right rail — tokens/info panel up top, GGUF export
          logs below. Same column for all three tabs. */}
      <div style={{ width: 280, flexShrink: 0, position: "sticky", top: 0, display: "flex", flexDirection: "column", gap: 10 }}>
        {(() => {
          // A DOWNLOADED model is selected via selectedPath (separate from the
          // browse-card selectedId). Show its detail + weights here; otherwise
          // fall back to the access-tokens / browse-info pane.
          const dl = selectedPath ? downloaded.find(d => d.path === selectedPath) : null;
          return dl ? (
            <DownloadedModelDetail
              item={dl}
              onChanged={refreshDownloaded}
              onAddWeights={() => setPickerFor(dl.name.replace(/__/g, "/"))}
            />
          ) : (
            <AccessTokensPane selectedModel={selectedModelForInfo} />
          );
        })()}
        {(exportLogs.length > 0 || exportStatus) && (
          <div>
            {/* Live status — single line, biggest emoji clue first.
                Updates as we parse layer/phase markers out of convert
                logs (not driven by line count). */}
            {exportStatus && (
              <div style={{
                padding: "6px 10px",
                background: exportStatus.startsWith("✅")
                  ? "rgba(76,175,80,0.18)"
                  : exportStatus.startsWith("❌")
                    ? "rgba(244,67,54,0.18)"
                    : "rgba(var(--accent-rgb),0.18)",
                border: `1px solid ${exportStatus.startsWith("✅")
                  ? "rgba(76,175,80,0.5)"
                  : exportStatus.startsWith("❌")
                    ? "rgba(244,67,54,0.5)"
                    : "rgba(var(--accent-rgb),0.4)"}`,
                borderRadius: 4,
                color: exportStatus.startsWith("✅")
                  ? "#a5e6a5"
                  : exportStatus.startsWith("❌")
                    ? "#ff8080"
                    : "#cfd4e1",
                fontSize: 11,
                marginBottom: 6,
                wordBreak: "break-word",
              }}>{exportStatus}</div>
            )}
            <button
              onClick={() => setExportLogsOpen((v) => !v)}
              style={{
                padding: "4px 10px",
                background: "rgba(var(--accent-rgb),0.10)",
                border: "1px solid rgba(var(--accent-rgb),0.3)",
                borderRadius: 4,
                color: "#9cc3ff",
                fontSize: 11,
                cursor: "pointer",
                marginBottom: 4,
                width: "100%",
                textAlign: "left",
              }}
            >{exportLogsOpen ? "▼" : "▶"} GGUF export logs ({exportLogs.length})</button>
            {exportLogsOpen && (
              <LogBox lines={exportLogs} title="GGUF export log" height={320} />
            )}
          </div>
        )}
      </div>
      </div>
      )}

      {/* 💽 Cache moved to the Info page (CacheTab is exported + rendered there). */}

      {tab === "browse" && (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: 10,
          padding: "6px 8px",
          background: "var(--bg-card)",
          border: "1px solid var(--border-strong)",
          borderRadius: 6,
          fontSize: 11,
        }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--fg)" }}>
          <input type="checkbox" /> Change res VRAM
        </label>
        <span style={{ flex: 1, color: "var(--fg-muted)" }}>
          ✓ Restart Memory Hugging Face — C:\Users\mc\.cache\huggingface
        </span>
        <button
          style={{
            padding: "4px 12px",
            background: "var(--bg-elevated)",
            color: "var(--fg)",
            border: "1px solid var(--border-strong)",
            borderRadius: 4,
            fontSize: 11,
          }}
        >
          Browse
        </button>
      </div>
      )}

      {pickerFor && (
        <WeightPickerDialog
          modelId={pickerFor}
          vramGb={vramGb ?? undefined}
          onCancel={() => setPickerFor(null)}
          onConfirm={(files) => confirmDownload(pickerFor, files)}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// CacheTab — surfaces every "models--owner--name" dir under the
// known HF cache roots so the user can see where disk is going and
// reclaim it. Without this, abliterate/train/GGUF runs silently grow
// $HF_HOME/$TRANSFORMERS_CACHE forever (see hf_cache_list in Rust).
// ──────────────────────────────────────────────────────────────────
type HfCacheEntry = {
  repoId: string;
  path: string;
  cacheRoot: string;
  sizeBytes: number;
  modifiedAt: number | null;
};
type HfCacheSummary = {
  roots: string[];
  totalBytes: number;
  entries: HfCacheEntry[];
};
type DeleteProgress = {
  total: number;
  done: number;
  freedBytes: number;
  currentName: string | null;
  currentPath: string | null;
  currentBytes: number;
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
function fmtAge(unixSeconds: number | null): string {
  if (!unixSeconds) return "—";
  const ageDays = (Date.now() / 1000 - unixSeconds) / 86400;
  if (ageDays < 1) return "today";
  if (ageDays < 30) return `${Math.round(ageDays)}d ago`;
  if (ageDays < 365) return `${Math.round(ageDays / 30)}mo ago`;
  return `${(ageDays / 365).toFixed(1)}y ago`;
}

function isProtectedStorageEntry(e: HfCacheEntry): boolean {
  return e.cacheRoot === "owllm-models" || e.cacheRoot === "owllm-fine-tuned";
}

function sumCacheEntries(entries: HfCacheEntry[]): number {
  return entries.reduce((a, e) => a + e.sizeBytes, 0);
}

type CleanupBucket = "safe" | "env" | "runtime" | "other";
type StorageBucket = "models" | "fineTuned" | CleanupBucket;

function cleanupBucket(e: HfCacheEntry): CleanupBucket {
  const root = e.cacheRoot || "";
  const name = e.repoId || "";
  if (name.startsWith(".tmp") || root === "pip-cache" || root === "npm-cache" || root === "hf-user-cache" || root.startsWith("hf-") || root === "owllm-wheelhouse") {
    return "safe";
  }
  if (root === "owllm-envs") {
    return "env";
  }
  if (root === "owllm-runtime" || root === "owllm-python-runtime" || root === "owllm-vendor") {
    return "runtime";
  }
  return "other";
}

function cleanupBucketLabel(bucket: CleanupBucket): string {
  switch (bucket) {
    case "safe": return "Safe cleanup";
    case "env": return "Rebuildable environments";
    case "runtime": return "Runtime tools";
    default: return "Other cleanup";
  }
}

function cleanupBucketHint(bucket: CleanupBucket): string {
  switch (bucket) {
    case "safe": return "Disposable caches; downloads may be recreated later.";
    case "env": return "Large Python/CUDA envs; models stay, but use may require rebuild.";
    case "runtime": return "Shared binaries and tool runtimes; delete only to force reinstall.";
    default: return "Review path before deleting.";
  }
}

function storageBucketLabel(bucket: StorageBucket): string {
  if (bucket === "models") return "Downloaded models";
  if (bucket === "fineTuned") return "Fine-tuned outputs";
  return cleanupBucketLabel(bucket);
}

function storageBucketHint(bucket: StorageBucket): string {
  if (bucket === "models") return "Protected storage; inspect only.";
  if (bucket === "fineTuned") return "Protected outputs; inspect only.";
  return cleanupBucketHint(bucket);
}

function isCleanupBucket(bucket: StorageBucket): bucket is CleanupBucket {
  return bucket !== "models" && bucket !== "fineTuned";
}

export function CacheTab({ setBanner }: { setBanner: (msg: string | null) => void }) {
  const [summary, setSummary] = React.useState<HfCacheSummary | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [deleteProgress, setDeleteProgress] = React.useState<DeleteProgress | null>(null);
  const [activeBucket, setActiveBucket] = React.useState<StorageBucket>("safe");

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await invoke<HfCacheSummary>("hf_cache_list");
      setSummary(s);
      setSelected(new Set());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  const storageEntries = React.useMemo(
    () => (summary?.entries || []).filter(isProtectedStorageEntry),
    [summary],
  );
  const cleanupEntries = React.useMemo(
    () => (summary?.entries || []).filter((e) => !isProtectedStorageEntry(e)),
    [summary],
  );
  const modelEntries = React.useMemo(
    () => storageEntries.filter((e) => e.cacheRoot === "owllm-models"),
    [storageEntries],
  );
  const fineTuneEntries = React.useMemo(
    () => storageEntries.filter((e) => e.cacheRoot === "owllm-fine-tuned"),
    [storageEntries],
  );
  const safeCleanupEntries = React.useMemo(
    () => cleanupEntries.filter((e) => cleanupBucket(e) === "safe"),
    [cleanupEntries],
  );
  const envCleanupEntries = React.useMemo(
    () => cleanupEntries.filter((e) => cleanupBucket(e) === "env"),
    [cleanupEntries],
  );
  const runtimeCleanupEntries = React.useMemo(
    () => cleanupEntries.filter((e) => cleanupBucket(e) === "runtime"),
    [cleanupEntries],
  );
  const otherCleanupEntries = React.useMemo(
    () => cleanupEntries.filter((e) => cleanupBucket(e) === "other"),
    [cleanupEntries],
  );
  const modelStorageBytes = React.useMemo(() => sumCacheEntries(modelEntries), [modelEntries]);
  const fineTuneStorageBytes = React.useMemo(() => sumCacheEntries(fineTuneEntries), [fineTuneEntries]);
  const safeCleanupBytes = React.useMemo(() => sumCacheEntries(safeCleanupEntries), [safeCleanupEntries]);
  const envCleanupBytes = React.useMemo(() => sumCacheEntries(envCleanupEntries), [envCleanupEntries]);
  const runtimeCleanupBytes = React.useMemo(() => sumCacheEntries(runtimeCleanupEntries), [runtimeCleanupEntries]);
  const otherCleanupBytes = React.useMemo(() => sumCacheEntries(otherCleanupEntries), [otherCleanupEntries]);

  const activeEntries = React.useMemo(() => {
    switch (activeBucket) {
      case "models": return modelEntries;
      case "fineTuned": return fineTuneEntries;
      case "safe": return safeCleanupEntries;
      case "env": return envCleanupEntries;
      case "runtime": return runtimeCleanupEntries;
      default: return otherCleanupEntries;
    }
  }, [activeBucket, envCleanupEntries, fineTuneEntries, modelEntries, otherCleanupEntries, runtimeCleanupEntries, safeCleanupEntries]);
  const activeBytes = React.useMemo(() => sumCacheEntries(activeEntries), [activeEntries]);
  const activeCanDelete = isCleanupBucket(activeBucket);
  const activeCleanupEntries = React.useMemo(
    () => activeCanDelete ? activeEntries : [],
    [activeCanDelete, activeEntries],
  );

  React.useEffect(() => {
    setSelected(new Set());
  }, [activeBucket]);

  const activateBucket = (bucket: StorageBucket) => {
    setActiveBucket(bucket);
  };

  const toggleOne = (path: string) =>
    setSelected((curr) => {
      const next = new Set(curr);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const toggleAll = () => {
    if (!summary) return;
    if (!activeCanDelete) {
      setSelected(new Set());
      return;
    }
    if (selected.size === activeCleanupEntries.length) setSelected(new Set());
    else setSelected(new Set(activeCleanupEntries.map((e) => e.path)));
  };

  const selectSafeCleanup = () => {
    setActiveBucket("safe");
    setSelected(new Set(safeCleanupEntries.map((e) => e.path)));
  };

  const selectedSizeBytes = React.useMemo(() => {
    if (!summary) return 0;
    return activeCleanupEntries
      .filter((e) => selected.has(e.path))
      .reduce((a, e) => a + e.sizeBytes, 0);
  }, [activeCleanupEntries, selected, summary]);

  const deleteSelected = async () => {
    if (!summary || selected.size === 0 || !activeCanDelete) return;
    const items = activeCleanupEntries.filter((e) => selected.has(e.path));
    const paths = items.map((e) => e.path);
    const repoNames = items.map((e) => e.repoId);
    const ok = window.confirm(
      `Delete ${paths.length} cache/trash entr${paths.length === 1 ? "y" : "ies"} ` +
        `(${fmtBytes(selectedSizeBytes)})?\n\n` +
        repoNames.slice(0, 8).join("\n") +
        (repoNames.length > 8 ? `\n…and ${repoNames.length - 8} more` : "") +
        `\n\nThis is permanent. Cache may need to be downloaded again; environments may need to be rebuilt.`,
    );
    if (!ok) return;
    setBusy(true);
    setDeleteProgress({
      total: items.length,
      done: 0,
      freedBytes: 0,
      currentName: null,
      currentPath: null,
      currentBytes: 0,
    });
    setBanner(`🧹 Deleting ${paths.length} cache/trash item(s)…`);
    let freed = 0;
    let failures: string[] = [];
    let done = 0;
    for (const item of items) {
      setDeleteProgress({
        total: items.length,
        done,
        freedBytes: freed,
        currentName: item.repoId,
        currentPath: item.path,
        currentBytes: item.sizeBytes,
      });
      setBanner(
        `🧹 Deleting ${done + 1}/${items.length}: ${item.repoId} (${fmtBytes(item.sizeBytes)})`,
      );
      try {
        const f = await invoke<number>("hf_cache_delete", { path: item.path });
        freed += f;
        setSummary((curr) => curr
          ? {
              ...curr,
              totalBytes: Math.max(0, curr.totalBytes - f),
              entries: curr.entries.filter((e) => e.path !== item.path),
            }
          : curr,
        );
        setSelected((curr) => {
          const next = new Set(curr);
          next.delete(item.path);
          return next;
        });
      } catch (e) {
        failures.push(`${item.path}: ${e}`);
      }
      done += 1;
      setDeleteProgress({
        total: items.length,
        done,
        freedBytes: freed,
        currentName: done < items.length ? null : item.repoId,
        currentPath: done < items.length ? null : item.path,
        currentBytes: done < items.length ? 0 : item.sizeBytes,
      });
    }
    setBusy(false);
    setDeleteProgress(null);
    if (failures.length === 0) {
      setBanner(`✅ Freed ${fmtBytes(freed)} (${paths.length} cache/trash item(s))`);
    } else {
      setBanner(
        `⚠ Freed ${fmtBytes(freed)} but ${failures.length} delete(s) failed — ${failures[0]}`,
      );
    }
    await refresh();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{
        padding: "10px 12px",
        background: "rgba(var(--accent-rgb),0.08)",
        border: "1px solid rgba(var(--accent-rgb),0.3)",
        borderRadius: 6,
        fontSize: 12,
        color: "var(--fg)",
      }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>
          Storage audit{" "}
          <span style={{ color: "#9cc3ff" }}>
            {summary ? fmtBytes(summary.totalBytes) : "scanning…"}
          </span>{" "}
          across {summary?.entries.length ?? 0} entr
          {summary?.entries.length === 1 ? "y" : "ies"}
        </div>
        <div style={{ fontSize: 10, color: "var(--fg-muted)", lineHeight: 1.5 }}>
          Models and fine-tunes are protected storage. Cleanup is split by how safe it is to remove.
        </div>
        {summary && summary.roots.length > 0 && (
          <div style={{ fontSize: 10, color: "var(--fg-muted)", marginTop: 6, wordBreak: "break-all" }}>
            <b>Roots:</b> {summary.roots.join("   ·   ")}
          </div>
        )}
      </div>

      {error && (
        <div style={{ padding: 8, color: "#ffb3b3", border: "1px solid rgba(244,67,54,0.4)", borderRadius: 4 }}>
          {error}
        </div>
      )}

      {deleteProgress && (
        <DeleteProgressPanel progress={deleteProgress} />
      )}

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: 10,
      }}>
        <StorageSummaryCard
          title="Downloaded models"
          count={modelEntries.length}
          bytes={modelStorageBytes}
          entries={modelEntries}
          active={activeBucket === "models"}
          onClick={() => activateBucket("models")}
        />
        <StorageSummaryCard
          title="Fine-tuned outputs"
          count={fineTuneEntries.length}
          bytes={fineTuneStorageBytes}
          entries={fineTuneEntries}
          active={activeBucket === "fineTuned"}
          onClick={() => activateBucket("fineTuned")}
        />
        <StorageSummaryCard
          title="Safe cleanup"
          count={safeCleanupEntries.length}
          bytes={safeCleanupBytes}
          entries={safeCleanupEntries}
          cleanup
          active={activeBucket === "safe"}
          onClick={() => activateBucket("safe")}
        />
        <StorageSummaryCard
          title="Rebuildable environments"
          count={envCleanupEntries.length}
          bytes={envCleanupBytes}
          entries={envCleanupEntries}
          caution
          active={activeBucket === "env"}
          onClick={() => activateBucket("env")}
        />
        <StorageSummaryCard
          title="Runtime tools"
          count={runtimeCleanupEntries.length}
          bytes={runtimeCleanupBytes}
          entries={runtimeCleanupEntries}
          caution
          active={activeBucket === "runtime"}
          onClick={() => activateBucket("runtime")}
        />
        {otherCleanupEntries.length > 0 && (
          <StorageSummaryCard
            title="Other cleanup"
            count={otherCleanupEntries.length}
            bytes={otherCleanupBytes}
            entries={otherCleanupEntries}
            caution
            active={activeBucket === "other"}
            onClick={() => activateBucket("other")}
          />
        )}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          onClick={refresh}
          disabled={loading || busy}
          style={btnGhost(loading || busy)}
        >🔄 {loading ? "Scanning…" : "Refresh"}</button>
        <button
          onClick={toggleAll}
          disabled={!summary || !activeCanDelete || activeCleanupEntries.length === 0 || busy}
          style={btnGhost(busy)}
        >{activeCleanupEntries.length > 0 && selected.size === activeCleanupEntries.length ? "Clear" : "Select all"}</button>
        <button
          onClick={selectSafeCleanup}
          disabled={!summary || safeCleanupEntries.length === 0 || busy}
          style={btnGhost(busy)}
        >Select safe</button>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>
          {activeCanDelete ? `${selected.size} selected · ${fmtBytes(selectedSizeBytes)}` : "Protected · inspect only"}
        </div>
        <button
          onClick={deleteSelected}
          disabled={!activeCanDelete || selected.size === 0 || busy}
          style={{
            padding: "6px 14px",
            background: selected.size > 0
              ? "linear-gradient(180deg, #c84a4a 0%, #8c2828 100%)"
              : "rgba(244,67,54,0.10)",
            border: "1px solid rgba(244,67,54,0.5)",
            color: "white",
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 700,
            cursor: !activeCanDelete || selected.size === 0 || busy ? "not-allowed" : "pointer",
            opacity: !activeCanDelete || selected.size === 0 || busy ? 0.6 : 1,
          }}
        >🗑️ Delete selected</button>
      </div>

      <div style={{
        border: "1px solid #2a3242",
        borderRadius: 6,
        overflow: "hidden",
      }}>
        <div style={cacheRow(true)}>
          <div style={{ width: 28 }}></div>
          <div style={{ flex: 2 }}>Entry</div>
          <div style={{ width: 100, textAlign: "right" }}>Size</div>
          <div style={{ width: 100 }}>Last used</div>
          <div style={{ width: 90 }}>Cache</div>
        </div>
        <div style={cacheSectionRow(activeBucket)}>
          <div style={{ width: 28 }}></div>
          <div style={{ flex: 2, minWidth: 0 }}>
            <span style={{ fontWeight: 800 }}>{storageBucketLabel(activeBucket)}</span>
            <span style={{ color: "var(--fg-muted)", marginLeft: 8, fontSize: 10 }}>
              {storageBucketHint(activeBucket)}
            </span>
          </div>
          <div style={{ width: 100, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
            {fmtBytes(activeBytes)}
          </div>
          <div style={{ width: 100, color: "var(--fg-muted)" }}>
            {activeEntries.length} item{activeEntries.length === 1 ? "" : "s"}
          </div>
          <div style={{ width: 90 }}></div>
        </div>
        {!summary || activeEntries.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: "var(--fg-muted)", fontSize: 12 }}>
            {loading ? "Scanning…" : `No entries in ${storageBucketLabel(activeBucket)}.`}
          </div>
        ) : activeEntries.map((e) => {
          const isDeleting = deleteProgress?.currentPath === e.path;
          return (
              <div key={e.path} style={cacheRow(false, selected.has(e.path), isDeleting)} title={e.path}>
                <div style={{ width: 28 }}>
                  {activeCanDelete && (
                    <input
                      type="checkbox"
                      checked={selected.has(e.path)}
                      onChange={() => toggleOne(e.path)}
                      disabled={busy}
                    />
                  )}
                </div>
                <div style={{ flex: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {e.repoId}
                  {isDeleting && (
                    <span style={{ marginLeft: 8, color: "#9FE6B8", fontSize: 10, fontWeight: 800 }}>
                      Deleting...
                    </span>
                  )}
                </div>
                <div style={{ width: 100, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {fmtBytes(e.sizeBytes)}
                </div>
                <div style={{ width: 100, color: "var(--fg-muted)" }}>
                  {fmtAge(e.modifiedAt)}
                </div>
                <div style={{ width: 90, color: "var(--fg-muted)", fontSize: 10 }}>
                  {e.cacheRoot}
                </div>
              </div>
          );
        })}
      </div>
    </div>
  );
}

function DeleteProgressPanel({ progress }: { progress: DeleteProgress }) {
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <div style={{
      border: "1px solid rgba(159,230,184,0.35)",
      background: "rgba(60,160,92,0.12)",
      borderRadius: 6,
      padding: "10px 12px",
      display: "flex",
      flexDirection: "column",
      gap: 8,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 900, color: "var(--fg)" }}>
          Deleting cache/trash
        </div>
        <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>
          {progress.done}/{progress.total} complete · {fmtBytes(progress.freedBytes)} freed
        </div>
      </div>
      <div style={{
        height: 8,
        borderRadius: 999,
        background: "rgba(0,0,0,0.35)",
        overflow: "hidden",
      }}>
        <div style={{
          width: `${pct}%`,
          height: "100%",
          background: "linear-gradient(90deg, #4fc47a, #9FE6B8)",
          transition: "width 180ms ease",
        }} />
      </div>
      <div style={{ fontSize: 11, color: "var(--fg-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {progress.currentName
          ? `Working on ${progress.currentName} (${fmtBytes(progress.currentBytes)})`
          : "Preparing next item..."}
      </div>
    </div>
  );
}

function StorageSummaryCard({
  title,
  count,
  bytes,
  entries,
  cleanup = false,
  caution = false,
  active = false,
  onClick,
}: {
  title: string;
  count: number;
  bytes: number;
  entries: HfCacheEntry[];
  cleanup?: boolean;
  caution?: boolean;
  active?: boolean;
  onClick?: () => void;
}) {
  const topEntries = entries.slice(0, 4);
  const accent = cleanup ? "#9FE6B8" : caution ? "#F7C948" : "#9cc3ff";
  return (
    <button type="button" onClick={onClick} style={{
      background: "var(--bg-card)",
      border: active
        ? `1px solid ${accent}`
        : cleanup
          ? "1px solid rgba(159,230,184,0.35)"
          : caution
            ? "1px solid rgba(247,201,72,0.35)"
            : "1px solid rgba(var(--accent-rgb),0.22)",
      borderRadius: 6,
      padding: "10px 12px",
      minHeight: 118,
      display: "flex",
      flexDirection: "column",
      gap: 8,
      cursor: "pointer",
      textAlign: "left",
      boxShadow: active ? `0 0 0 1px ${accent}33 inset` : "none",
      opacity: count === 0 ? 0.75 : 1,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: "var(--fg)" }}>{title}</div>
        <div style={{ fontSize: 10, color: "var(--fg-muted)" }}>{count} item{count === 1 ? "" : "s"}</div>
      </div>
      <div style={{ fontSize: 20, fontWeight: 900, color: accent }}>
        {fmtBytes(bytes)}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minHeight: 48 }}>
        {topEntries.length === 0 ? (
          <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>Empty</div>
        ) : topEntries.map((e) => (
          <div key={e.path} title={e.path} style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            fontSize: 11,
            color: "var(--fg-muted)",
            minWidth: 0,
          }}>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {e.repoId}
            </span>
            <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--fg)" }}>
              {fmtBytes(e.sizeBytes)}
            </span>
          </div>
        ))}
        {entries.length > topEntries.length && (
          <div style={{ fontSize: 10, color: "var(--fg-muted)" }}>
            +{entries.length - topEntries.length} more
          </div>
        )}
      </div>
    </button>
  );
}

const btnGhost = (disabled: boolean): React.CSSProperties => ({
  padding: "6px 12px",
  background: "transparent",
  border: "1px solid #2a3242",
  color: "var(--fg)",
  borderRadius: 6,
  fontSize: 11,
  cursor: disabled ? "not-allowed" : "pointer",
  opacity: disabled ? 0.6 : 1,
});

const cacheRow = (isHeader: boolean, isSelected = false, isDeleting = false): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 10px",
  fontSize: 12,
  background: isHeader
    ? "rgba(0,0,0,0.4)"
    : isDeleting
      ? "rgba(60,160,92,0.20)"
    : isSelected
      ? "rgba(var(--accent-rgb),0.10)"
      : "transparent",
  borderBottom: isHeader ? "1px solid #2a3242" : "1px solid rgba(255,255,255,0.05)",
  color: isHeader ? "var(--fg-muted)" : "var(--fg)",
  fontWeight: isHeader ? 700 : 400,
});

const cacheSectionRow = (bucket: StorageBucket): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "9px 10px",
  fontSize: 12,
  background: bucket === "models" || bucket === "fineTuned"
    ? "rgba(var(--accent-rgb),0.12)"
    : bucket === "safe"
    ? "rgba(60,160,92,0.16)"
    : bucket === "env"
      ? "rgba(247,201,72,0.14)"
      : bucket === "runtime"
        ? "rgba(120,150,190,0.14)"
        : "rgba(255,255,255,0.08)",
  borderBottom: "1px solid rgba(255,255,255,0.08)",
  color: "var(--fg)",
});
