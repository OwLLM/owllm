// TrainPage — port of LLM/desktop_app/main.py:14511 `_build_train_tab`.
// Three-column layout matching Qt: LEFT = config inputs (Base Model card,
// Dataset card, Hyperparameters card); CENTER = dashboard (metrics strip,
// Loss-over-time chart, Training Logs); RIGHT = launch surface +
// Training History table. All commands flow through Tauri invokes
// (train_start / train_stop / train_status / train_history_list)
// defined in src-tauri/finetuning.rs.

import React from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import {
  MetricCard,
  RunMode,
  StartTrainingPanel,
  StatusKind,
} from "./widgets/TrainingWidgets";

// Mirrors Rust TrainStatus (finetuning.rs). All numeric fields can be
// null when the run hasn't reported them yet — every read site must
// guard with `!= null` before calling .toFixed() etc. `lossHistory`
// drives the Loss Over Time chart in the center column.
type TrainStatus = {
  running: boolean;
  state: StatusKind;
  runName: string | null;
  step: number | null;
  totalSteps: number | null;
  loss: number | null;
  evalLoss: number | null;
  learningRate: number | null;
  vramUsedGb: number | null;
  elapsedSec: number | null;
  message: string | null;
  lastLogTail: string[];
  lossHistory: { step: number; loss: number }[];
};

const EMPTY_STATUS: TrainStatus = {
  running: false,
  state: "idle",
  runName: null,
  step: null,
  totalSteps: null,
  loss: null,
  evalLoss: null,
  learningRate: null,
  vramUsedGb: null,
  elapsedSec: null,
  message: null,
  lastLogTail: [],
  lossHistory: [],
};

// Ported from LLM/core/models.py:17 DEFAULT_BASE_MODELS.
const DEFAULT_BASE_MODELS: string[] = [
  "unsloth/Qwen2.5-7B-Instruct-bnb-4bit",
  "unsloth/Qwen2.5-14B-Instruct-bnb-4bit",
  "unsloth/Qwen2.5-32B-Instruct-bnb-4bit",
  "unsloth/Mistral-Nemo-Instruct-2407-bnb-4bit",
  "unsloth/OpenHermes-2.5-Mistral-7B-bnb-4bit",
  "unsloth/Phi-3.5-mini-instruct-bnb-4bit",
  "unsloth/Phi-4-bnb-4bit",
  "unsloth/gemma-2-9b-it-bnb-4bit",
  "unsloth/gemma-2-27b-it-bnb-4bit",
];

// Static capability blurb shown under the base-model dropdown. Mirrors
// the wordwrap QLabel `model_info_label` at main.py:14677-14680.
function modelCapabilityBlurb(id: string): string {
  if (!id) return "Pick a base model to see capabilities.";
  const lo = id.toLowerCase();
  if (lo.includes("qwen2.5-32b"))  return "qwen 2.5 32B Instruct (4-bit) — HEROIC-UNCENSORED · Thinking · Function call · 23GB VRAM";
  if (lo.includes("qwen2.5-14b"))  return "qwen 2.5 14B Instruct (4-bit) — Thinking · Function call · 12GB VRAM";
  if (lo.includes("qwen2.5-7b"))   return "qwen 2.5 7B Instruct (4-bit) — Thinking · Function call · 7GB VRAM";
  if (lo.includes("mistral-nemo")) return "Mistral Nemo Instruct (4-bit) — 12B params · long context · 9GB VRAM";
  if (lo.includes("openhermes"))   return "OpenHermes 2.5 (Mistral-7B, 4-bit) — Function call · 6GB VRAM";
  if (lo.includes("phi-3.5"))      return "Phi-3.5 mini Instruct (4-bit) — tiny · CPU-friendly · 4GB VRAM";
  if (lo.includes("phi-4"))        return "Phi-4 (4-bit) — 14B reasoning · Thinking · 11GB VRAM";
  if (lo.includes("gemma-2-27b"))  return "Gemma 2 27B-it (4-bit) — long context · 21GB VRAM";
  if (lo.includes("gemma-2-9b"))   return "Gemma 2 9B-it (4-bit) — long context · 7GB VRAM";
  return "Custom model — capabilities resolved at load time.";
}

// Card style — port of `_CARD_STYLE` at main.py:14538-14593 (cfgCard).
const cfgCard: React.CSSProperties = {
  background: "rgba(20, 25, 40, 0.55)",
  border: "1px solid rgba(102,126,234,0.28)",
  borderRadius: 10,
  padding: "10px 14px 12px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

// Card title — port of `QLabel.cardTitle` at main.py:14546-14551.
const cardTitle: React.CSSProperties = {
  color: "#c08aff",
  fontSize: 14,
  fontWeight: 800,
  letterSpacing: 0.4,
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "#8595ad",
  letterSpacing: 0.4,
};

const inputStyle: React.CSSProperties = {
  padding: "6px 10px",
  background: "rgba(10,14,24,0.85)",
  border: "1px solid rgba(102,126,234,0.22)",
  borderRadius: 6,
  color: "#e8eef7",
  fontSize: 12,
  minHeight: 28,
  width: "100%",
  boxSizing: "border-box",
};

// "cardBtn" — port of QPushButton.cardBtn at main.py:14584-14591.
const cardBtn: React.CSSProperties = {
  background: "rgba(102,126,234,0.18)",
  border: "1px solid rgba(102,126,234,0.45)",
  borderRadius: 6,
  color: "#fafafa",
  padding: "6px 12px",
  fontWeight: 600,
  minHeight: 28,
  fontSize: 12,
  cursor: "pointer",
};

const grid2: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 10,
};

// After abliterate (or any HF-source-consuming flow) finishes, the
// original repo in the HF cache is redundant: we've written a new
// transformers dir locally. Walk the cache, find the entry matching
// the source repo id, and offer a one-click delete. Silent if not
// found (model came from disk, or cache was already cleared).
async function offerSourceCleanup(repoId: string, outputDir: string): Promise<void> {
  type Entry = { repoId: string; path: string; sizeBytes: number };
  type Summary = { entries: Entry[] };
  try {
    const s = await invoke<Summary>("hf_cache_list");
    const hit = s.entries.find((e) => e.repoId === repoId);
    if (!hit) return;
    const sizeGb = (hit.sizeBytes / 1024 ** 3).toFixed(2);
    const ok = window.confirm(
      `✅ Abliterated → ${outputDir}\n\n` +
        `The source download is still cached at:\n${hit.path}\n` +
        `(${sizeGb} GB)\n\n` +
        `Delete the source to reclaim disk? The abliterated copy stays.`,
    );
    if (!ok) return;
    await invoke<number>("hf_cache_delete", { path: hit.path });
  } catch {
    // Best-effort cleanup — never block the success path on it.
  }
}

async function tryInvoke<T>(cmd: string, args: Record<string, unknown>, fallback: T): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch {
    return fallback;
  }
}

// ──────────────────────────────────────────────────────────────────
// LossChart — SVG port of the matplotlib chart wired below
// main.py:16065 (loss_title='<b>📉 Loss Over Time</b>'). Draws a
// simple polyline of `lossHistory`. Stroke is #c08aff to match the
// Qt section header colour.
// ──────────────────────────────────────────────────────────────────
function LossChart({ data }: { data: { step: number; loss: number }[] }) {
  if (!data || data.length < 2) {
    return (
      <div style={{
        flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
        color: "#888", fontSize: 11, padding: "20px 0",
      }}>
        No loss data yet — start a run to see the curve.
      </div>
    );
  }
  const xs = data.map((d) => d.step);
  const ys = data.map((d) => d.loss);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const W = 400;
  const H = 160;
  const PX = 28;
  const PY = 14;
  const sx = (x: number) => PX + ((x - minX) / Math.max(maxX - minX, 1)) * (W - 2 * PX);
  const sy = (y: number) => H - PY - ((y - minY) / Math.max(maxY - minY, 1e-9)) * (H - 2 * PY);
  const path = data.map((d, i) => `${i === 0 ? "M" : "L"} ${sx(d.step).toFixed(1)} ${sy(d.loss).toFixed(1)}`).join(" ");
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: "block" }}>
      <rect x={PX} y={PY} width={W - 2 * PX} height={H - 2 * PY} fill="none" stroke="rgba(102,126,234,0.15)" />
      <text x={PX - 4} y={PY + 8}      fill="#6b7280" fontSize="9" textAnchor="end">{maxY.toFixed(3)}</text>
      <text x={PX - 4} y={H - PY}      fill="#6b7280" fontSize="9" textAnchor="end">{minY.toFixed(3)}</text>
      <text x={PX} y={H - 2}           fill="#6b7280" fontSize="9" textAnchor="start">{minX}</text>
      <text x={W - PX} y={H - 2}       fill="#6b7280" fontSize="9" textAnchor="end">{maxX}</text>
      <path d={path} stroke="#c08aff" strokeWidth="2" fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// ──────────────────────────────────────────────────────────────────
// Training History table — port of _build_training_history_panel at
// main.py:15225-15384.
// ──────────────────────────────────────────────────────────────────
type TrainHistoryRow = {
  when_pretty?: string | null;
  adapter?: string | null;
  base?: string | null;
  epochs?: number | null;
  steps?: number | null;
  final_loss?: number | null;
  status?: string | null;
};

function statusColour(s: string | null | undefined): string {
  switch ((s || "").toUpperCase()) {
    case "DONE":    return "#4caf50";
    case "PARTIAL": return "#ffb74d";
    case "FAILED":  return "#ef5350";
    case "RUNNING": return "#42a5f5";
    case "GGUF":    return "#ffc400";
    default:        return "#bdbdbd";
  }
}

function TrainingHistory() {
  const [rows, setRows] = React.useState<TrainHistoryRow[]>([]);
  const [loading, setLoading] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    const r = await tryInvoke<TrainHistoryRow[]>("train_history_list", {}, []);
    setRows(r);
    setLoading(false);
  }, []);

  React.useEffect(() => { refresh(); }, [refresh]);

  return (
    <div
      data-ui="trainingHistorySection"
      style={{
        background: "linear-gradient(180deg, rgba(15,15,26,0.6), rgba(25,25,36,0.8))",
        border: "1px solid rgba(102,126,234,0.3)",
        borderRadius: 12,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#c08aff", flex: 1 }}>📋 Training History</div>
        <button
          data-ui="train_history_refresh"
          onClick={refresh}
          style={{
            ...cardBtn,
            padding: "5px 14px",
            fontWeight: 700,
            opacity: loading ? 0.6 : 1,
          }}
        >🔄 Refresh</button>
      </div>
      <div style={{
        background: "rgba(10,10,15,0.8)",
        border: "1px solid rgba(102,126,234,0.2)",
        borderRadius: 6,
        overflow: "auto",
        maxHeight: 240,
      }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, color: "#e8eef7" }}>
          <thead>
            <tr>
              {["When", "Adapter", "Base", "Epochs", "Steps", "Final loss", "Status", "Actions"].map((h) => (
                <th key={h} style={{
                  background: "rgba(102,126,234,0.2)",
                  color: "#fafafa",
                  padding: 6,
                  border: "none",
                  fontWeight: 700,
                  textAlign: "left",
                  position: "sticky",
                  top: 0,
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={8} style={{ padding: 14, textAlign: "center", color: "#6b7280" }}>
                {loading ? "Loading…" : "No past runs found in fine_tuned/."}
              </td></tr>
            ) : rows.map((r, i) => (
              <tr key={i} style={{ borderTop: "1px solid rgba(102,126,234,0.12)" }}>
                <td style={{ padding: 6 }}>{r.when_pretty || "—"}</td>
                <td style={{ padding: 6, wordBreak: "break-all" }}>{r.adapter || "—"}</td>
                <td style={{ padding: 6, wordBreak: "break-all" }}>{r.base || "—"}</td>
                <td style={{ padding: 6 }}>{r.epochs ?? "—"}</td>
                <td style={{ padding: 6 }}>{r.steps ?? "—"}</td>
                <td style={{ padding: 6 }}>{typeof r.final_loss === "number" ? r.final_loss.toFixed(4) : "—"}</td>
                <td style={{ padding: 6, color: statusColour(r.status), fontWeight: 700 }}>{r.status || "—"}</td>
                <td style={{ padding: 6 }}>
                  <button style={{ ...cardBtn, padding: "2px 8px", fontSize: 10 }}>Open</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// TrainPage
// ──────────────────────────────────────────────────────────────────
export default function TrainPage() {
  const [baseModel, setBaseModel] = React.useState(DEFAULT_BASE_MODELS[0]);
  const [runName, setRunName] = React.useState("");
  const [datasetPath, setDatasetPath] = React.useState("");
  const [datasetStatus, setDatasetStatus] = React.useState("No dataset loaded");
  const [mode, setMode] = React.useState<RunMode>("lora");
  const [epochs, setEpochs] = React.useState(3);
  const [lr, setLr] = React.useState(2e-4);
  const [maxSeq, setMaxSeq] = React.useState(2048);
  const [batchSize, setBatchSize] = React.useState(4);
  const [gradAccum, setGradAccum] = React.useState(4);
  const [warmupSteps, setWarmupSteps] = React.useState(50);
  const [loraR, setLoraR] = React.useState(16);
  const [loraAlpha, setLoraAlpha] = React.useState(32);
  const [loraDropout, setLoraDropout] = React.useState(0.05);
  const [ckptEnabled, setCkptEnabled] = React.useState(true);
  const [ckptEvery, setCkptEvery] = React.useState(100);
  // batch_size_auto — port of main.py:14881-14900 (✅ Optimal batch size toggle).
  const [batchSizeAuto, setBatchSizeAuto] = React.useState(true);
  // Output dir — wrapping muted label below the params grid (main.py:14908-14935).
  const [outputDir] = React.useState(
    "C:/Users/mc/.owllm_studio/finetuned/unsloth_Qwen2.5-7B-Instruct-bnb-4bit_2026-05-21_finetune_qwen",
  );
  const [status, setStatus] = React.useState<TrainStatus>(EMPTY_STATUS);

  // Poll training status every 1.5s while a run is in flight.
  React.useEffect(() => {
    let dead = false;
    const tick = async () => {
      const s = await tryInvoke<TrainStatus>("train_status", {}, status);
      if (!dead) setStatus(s);
    };
    tick();
    const id = window.setInterval(tick, 1500);
    return () => { dead = true; window.clearInterval(id); };
  }, []);

  const start = async () => {
    setStatus({ ...EMPTY_STATUS, state: "running", running: true, message: "Starting…" });
    // Open a Tauri Channel — finetuning::train_start sends TrainEvents
    // (Started / Log / Metric / Finished / Failed) through it. Without
    // this the call would fail invariant validation in Rust.
    type TrainEvent =
      | { kind: "started"; runName: string }
      | { kind: "log"; stream: string; line: string }
      | { kind: "metric"; step: number; loss: number; learningRate: number }
      | { kind: "finished"; outputDir: string }
      | { kind: "failed"; error: string };
    const channel = new Channel<TrainEvent>();
    channel.onmessage = (ev) => {
      if (ev.kind === "log") {
        setStatus((s) => ({
          ...s,
          lastLogTail: [...(s.lastLogTail ?? []), ev.line].slice(-30),
        }));
      } else if (ev.kind === "metric") {
        setStatus((s) => ({
          ...s,
          step: ev.step,
          loss: ev.loss,
          learningRate: ev.learningRate,
          lossHistory: [...(s.lossHistory ?? []), { step: ev.step, loss: ev.loss }].slice(-500),
        }));
      } else if (ev.kind === "finished") {
        setStatus((s) => ({ ...s, running: false, state: "idle", message: `Finished → ${ev.outputDir}` }));
      } else if (ev.kind === "failed") {
        setStatus((s) => ({ ...s, running: false, state: "idle", message: `Failed: ${ev.error}` }));
      }
    };
    try {
      await invoke<void>("train_start", {
        config: {
          envProfile: "tf-cu121-t25-base-stable",
          baseModel,
          dataset: datasetPath,
          outputDir,
          runName: runName || `run_${Date.now()}`,
          epochs,
          learningRate: lr,
          loraR,
          maxSeqLen: maxSeq,
          gpus: [],
        },
        channel,
      });
    } catch (e) {
      // Surface the real error instead of swallowing — was masked by
      // tryInvoke and looked like "nothing happens".
      setStatus({ ...EMPTY_STATUS, state: "idle", running: false, message: `Start failed: ${e}` });
    }
  };

  const stop = async () => {
    await tryInvoke<void>("train_stop", {}, undefined);
    setStatus((s) => ({ ...s, state: "idle", running: false }));
  };

  const useRecommended = () => {
    setEpochs(3);
    setLr(2e-4);
    setMaxSeq(2048);
    setBatchSize(4);
    setGradAccum(4);
    setWarmupSteps(50);
    setLoraR(16);
    setLoraAlpha(32);
    setLoraDropout(0.05);
  };

  const browseDataset = async () => {
    // dialog::pick_file(title, filters) — filters is Vec<(label, Vec<ext>)>.
    const picked = await tryInvoke<string | null>("pick_file", {
      title: "Pick a training dataset",
      filters: [["Datasets", ["jsonl", "json", "csv", "parquet"]]],
    }, null);
    if (picked) setDatasetPath(picked);
  };

  const checkDataset = async () => {
    if (!datasetPath) { setDatasetStatus("No dataset loaded"); return; }
    setDatasetStatus("Checking…");
    try {
      const res = await invoke<{ count: number; format: string }>(
        "dataset_check", { path: datasetPath },
      );
      setDatasetStatus(`${res.count} examples · ${res.format}`);
    } catch (e) {
      setDatasetStatus(`Could not parse: ${e}`);
    }
  };

  const canStart = Boolean(baseModel && datasetPath);
  const totalSteps = status.totalSteps ?? 1;
  const pct = status.step ? Math.min(100, Math.round((status.step / totalSteps) * 100)) : 0;

  // Keep r and α linked the way Qt does (α = 2·r) — see main.py:14843.
  const onLoraR = (v: number) => { setLoraR(v); setLoraAlpha(v * 2); };

  return (
    <div
      data-ui="trainPageRoot"
      style={{
        height: "100%",
        padding: 14,
        background: "var(--bg-panel)",
        color: "var(--fg)",
        overflow: "auto",
        display: "grid",
        gridTemplateColumns: "minmax(280px, 1fr) minmax(320px, 1.3fr) minmax(300px, 1fr)",
        gridTemplateRows: "auto",
        gap: 12,
      }}
    >
      {/* ── LEFT COLUMN: Config inputs (Base Model / Dataset / Hyperparameters) ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {/* Card 1: Base Model — main.py:14651-14695 */}
        <div data-ui="cfgCard" style={cfgCard}>
          <div style={cardTitle}>🤖  BASE MODEL</div>
          <select
            data-ui="train_base_model"
            value={baseModel}
            onChange={(e) => setBaseModel(e.target.value)}
            style={inputStyle}
          >
            {DEFAULT_BASE_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <div style={{ color: "#8595ad", fontSize: 11, lineHeight: 1.4 }}>
            {modelCapabilityBlurb(baseModel)}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ ...labelStyle, fontSize: 11 }}>Run name</span>
            <input
              data-ui="train_model_name"
              style={{ ...inputStyle, flex: 1 }}
              value={runName}
              onChange={(e) => setRunName(e.target.value)}
              placeholder="auto-generated"
            />
          </div>
        </div>

        {/* Card 2: Dataset — main.py:14697-14745 */}
        <div data-ui="cfgCard" style={cfgCard}>
          <div style={cardTitle}>📊  DATASET</div>
          <input
            data-ui="train_data_path"
            style={inputStyle}
            value={datasetPath}
            onChange={(e) => setDatasetPath(e.target.value)}
            placeholder="Drag a .jsonl here, or browse..."
          />
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button style={cardBtn} onClick={browseDataset}>📁 Browse</button>
            <button style={cardBtn} onClick={checkDataset}>🔍 Check</button>
            <div style={{
              flex: 1,
              color: "#8595ad",
              fontSize: 11,
              padding: "0 6px",
              wordBreak: "break-all",
            }}>{datasetStatus}</div>
          </div>
        </div>

        {/* Card 3: Training parameters — main.py:14747-14908 */}
        <div data-ui="cfgCard" style={cfgCard}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={cardTitle}>⚙️  TRAINING PARAMETERS</div>
            <button data-ui="use_recommended_btn" onClick={useRecommended} style={cardBtn}>
              ✨ Use recommended
            </button>
          </div>

          <div style={grid2}>
            <Field label="Epochs"           value={epochs}      onChange={(v) => setEpochs(Number(v) || 1)} />
            <Field label="LoRA r"           value={loraR}       onChange={(v) => onLoraR(Number(v) || 1)} />
            <Field label="Learning rate"    value={lr}          onChange={(v) => setLr(Number(v) || 0)} step="0.0001" />
            <FieldStatic label="LoRA α"     value={loraAlpha} />
            <Field label="Max seq length"   value={maxSeq}      onChange={(v) => setMaxSeq(Number(v) || 1)} />
            {/* Optimal batch size toggle — port of main.py:14881-14900.
                Sits next to Max seq length the same way the Qt grid pairs
                them at (row 2, col 2-3 span). When checked, the launcher
                picks batch size from the GPU profile. */}
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={labelStyle}>&nbsp;</span>
              <button
                data-ui="batch_size_auto"
                onClick={() => setBatchSizeAuto((v) => !v)}
                style={{
                  background: batchSizeAuto
                    ? "rgba(76,175,80,0.40)"
                    : "rgba(76,175,80,0.18)",
                  border: "1px solid rgba(76,175,80,0.45)",
                  borderRadius: 6,
                  color: "#fafafa",
                  fontSize: 12,
                  fontWeight: 600,
                  padding: "6px 10px",
                  minHeight: 28,
                  cursor: "pointer",
                  textAlign: "center",
                }}
              >✅ Optimal batch size</button>
            </label>
            <Field label="Grad accum steps" value={gradAccum}   onChange={(v) => setGradAccum(Number(v) || 1)} />
            <Field label="Warmup steps"     value={warmupSteps} onChange={(v) => setWarmupSteps(Number(v) || 0)} />
            <Field label="LoRA dropout"     value={loraDropout} onChange={(v) => setLoraDropout(Number(v) || 0)} step="0.01" />
          </div>

          {/* Output row — port of main.py:14908-14935. A muted, wrapping
              path label that shows where the adapter will be written. */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 6, marginTop: 4 }}>
            <span style={{ color: "#8595ad", fontSize: 11, paddingTop: 4 }}>Output</span>
            <div
              data-ui="train_out_dir"
              style={{
                flex: 1,
                background: "rgba(8,10,16,0.85)",
                color: "#8595ad",
                fontSize: 10,
                padding: "4px 8px",
                borderRadius: 4,
                wordBreak: "break-all",
                lineHeight: 1.4,
              }}
              title={outputDir}
            >{outputDir}</div>
            <button
              data-ui="train_out_browse"
              style={{ ...cardBtn, maxWidth: 40, padding: "6px 8px" }}
              title="Browse output directory"
            >📁</button>
          </div>
        </div>
      </div>

      {/* ── CENTER COLUMN: Training Dashboard (metrics + chart + logs) ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: "#c08aff", textAlign: "center" }}>
          🚂 TRAINING DASHBOARD
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
          <MetricCard title="Step"      icon="🔁" value={status.step      != null ? `${status.step} / ${status.totalSteps ?? "?"}` : "—"} />
          <MetricCard title="Loss"      icon="📉" value={status.loss      != null ? status.loss.toFixed(4)            : "—"} accent="#FF9800" />
          <MetricCard title="Eval loss" icon="🎯" value={status.evalLoss  != null ? status.evalLoss.toFixed(4)        : "—"} accent="#4CAF50" />
          <MetricCard title="LR"        icon="⚡" value={status.learningRate != null ? status.learningRate.toExponential(2)  : "—"} accent="#9C27B0" />
          <MetricCard title="Speed"     icon="🚀" value={status.elapsedSec != null && status.step ? `${(status.step / Math.max(status.elapsedSec, 1)).toFixed(2)} s/s` : "— s/s"} accent="#00A4EF" />
          <MetricCard title="VRAM"      icon="🧠" value={status.vramUsedGb   != null ? `${status.vramUsedGb.toFixed(1)} GB` : "—"} accent="#00A4EF" />
        </div>

        {/* Progress bar (only meaningful while running). */}
        {(status.state === "running" || status.step != null) && (
          <div style={{ height: 8, background: "var(--bg-input)", border: "1px solid var(--border-strong)", borderRadius: 4, overflow: "hidden" }}>
            <div style={{
              height: "100%",
              width: `${pct}%`,
              background: "linear-gradient(90deg, #667eea, #9C27B0)",
              transition: "width 300ms ease",
            }} />
          </div>
        )}

        {/* Loss Over Time — main.py:16057-16082 */}
        <div data-ui="lossSection" style={{
          background: "linear-gradient(180deg, rgba(15,15,26,0.6), rgba(25,25,36,0.8))",
          border: "1px solid rgba(102,126,234,0.3)",
          borderRadius: 12,
          padding: "10px 15px",
          display: "flex",
          flexDirection: "column",
          gap: 5,
          minHeight: 220,
        }}>
          <div style={{ color: "#fff", fontSize: 13, fontWeight: 800 }}>📉 Loss Over Time</div>
          <LossChart data={status.lossHistory ?? []} />
        </div>

        {/* Training Logs — main.py:16084-16143 */}
        <div data-ui="logsSection" style={{
          background: "linear-gradient(180deg, rgba(15,15,26,0.6), rgba(25,25,36,0.8))",
          border: "1px solid rgba(102,126,234,0.3)",
          borderRadius: 12,
          padding: "10px 15px",
          display: "flex",
          flexDirection: "column",
          gap: 5,
          flex: 1,
          minHeight: 200,
        }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <div style={{ color: "#fff", fontSize: 13, fontWeight: 800, flex: 1 }}>📋 Training Logs</div>
            <button style={{ ...cardBtn, padding: "5px 15px", background: "rgba(102,126,234,0.3)", border: "none" }}>
              ▼ Show Logs
            </button>
          </div>
          <div data-ui="train_log" style={{
            flex: 1,
            background: "linear-gradient(180deg, rgba(10,10,15,0.9), rgba(20,20,25,0.9))",
            color: "#00ff00",
            fontFamily: "'Consolas', 'Courier New', monospace",
            fontSize: 11,
            border: "1px solid rgba(102,126,234,0.3)",
            borderRadius: 8,
            padding: 10,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            minHeight: 160,
          }}>
            {status.lastLogTail && status.lastLogTail.length > 0
              ? status.lastLogTail.join("\n")
              : "Waiting for training process to start..."}
          </div>
        </div>
      </div>

      {/* ── RIGHT COLUMN: Launch surface + History ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: "#c08aff", textAlign: "center" }}>
          🚀 START TRAINING
        </div>
        {status.message && (
          <div style={{
            padding: "8px 10px",
            background: status.message.startsWith("Failed") || status.message.startsWith("Start failed")
              ? "rgba(244,67,54,0.12)"
              : "rgba(102,126,234,0.12)",
            border: `1px solid ${status.message.startsWith("Failed") || status.message.startsWith("Start failed")
              ? "rgba(244,67,54,0.4)"
              : "rgba(102,126,234,0.4)"}`,
            borderRadius: 6,
            fontSize: 11,
            color: status.message.startsWith("Failed") || status.message.startsWith("Start failed") ? "#ffb3b3" : "#cfd4e1",
            wordBreak: "break-word",
          }}>{status.message}</div>
        )}
        <StartTrainingPanel
          status={status.state}
          canStart={canStart}
          onStart={start}
          onStop={stop}
        />
        {/* Standalone Stop button — port of main.py:15068-15099 (train_stop
            QPushButton). Sits between the launch tiles and Training
            History in the right column, centered, with a red-gradient
            fill and a soft red glow shadow. Disabled when no run is in
            flight; calls the existing `stop` handler. */}
        <div style={{ display: "flex", justifyContent: "center" }}>
          <button
            data-ui="train_stop"
            onClick={stop}
            disabled={!status.running}
            style={{
              minHeight: 50,
              padding: "0 18px",
              fontSize: 17,
              fontWeight: 800,
              color: status.running ? "white" : "#8595ad",
              background: status.running
                ? "linear-gradient(135deg, #dc2626 0%, #ef4444 50%, #dc2626 100%)"
                : "rgba(80,90,100,0.4)",
              border: "none",
              borderRadius: 12,
              boxShadow: status.running
                ? "0 0 18px rgba(239,68,68,0.55)"
                : "none",
              cursor: status.running ? "pointer" : "default",
              minWidth: 220,
            }}
          >⏹  Stop</button>
        </div>
        <AbliterateSection baseModel={baseModel} />
        <TrainingHistory />
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// AbliterateSection — single-button launcher for the FailSpy refusal-
// direction stripping recipe (LLM/tools/abliterate.py). Renders an
// info icon that pops up an explanation modal styled like the rest
// of the app's dialogs (WeightPickerDialog).
// ──────────────────────────────────────────────────────────────────
function AbliterateSection({ baseModel }: { baseModel: string }) {
  const [running, setRunning] = React.useState(false);
  const [message, setMessage] = React.useState<string>("");
  const [showInfo, setShowInfo] = React.useState(false);
  // Rolling tail of recent stdout/stderr lines so a crash can be
  // diagnosed without screenshots — exit code 1 is useless on its own.
  const [logLines, setLogLines] = React.useState<string[]>([]);
  const [showLogs, setShowLogs] = React.useState(false);
  // Rust derives the default output dir as
  //   <llm_root>/fine_tuned/<safe>__abliterated/
  // so the result auto-appears in the Models page Tuned tab. Display
  // the same shape here for clarity.
  const safeBase = baseModel
    ? baseModel.replace(/\//g, "__").replace(/[^a-zA-Z0-9._-]/g, "_")
    : "";
  const outputDir = safeBase
    ? `LLM/fine_tuned/${safeBase}__abliterated/`
    : "";

  const start = async () => {
    if (!baseModel) {
      setMessage("Pick a base model in the Base Model card above first.");
      return;
    }
    setRunning(true);
    setMessage("Starting…");
    setLogLines([]);
    setShowLogs(true);
    type Evt =
      | { kind: "progress"; stage: string; step?: number; total?: number; detail?: string }
      | { kind: "log"; stream: string; line: string }
      | { kind: "finished"; outputDir: string }
      | { kind: "failed"; error: string };
    const channel = new Channel<Evt>();
    // Python emits {"event":"failed","error":"..."} on stdout before
    // sys.exit(1). Capture that text so we can show it instead of the
    // generic "abliterate exited with code 1" that Rust emits next.
    let pythonError: string | null = null;
    const pushLog = (s: string) => setLogLines((prev) => {
      const next = [...prev, s];
      // Keep last 200 lines — enough for a Python traceback + context.
      return next.length > 200 ? next.slice(next.length - 200) : next;
    });
    channel.onmessage = (ev) => {
      if (ev.kind === "progress") {
        const pct = ev.total ? ` (${ev.step}/${ev.total})` : "";
        setMessage(`${ev.stage}${pct}${ev.detail ? ` · ${ev.detail}` : ""}`);
        pushLog(`[${ev.stage}]${pct}${ev.detail ? ` ${ev.detail}` : ""}`);
        if (ev.stage === "failed" && ev.detail) {
          pythonError = ev.detail.replace(/^error=/, "").replace(/^"|"$/g, "");
        }
      } else if (ev.kind === "log") {
        pushLog(`${ev.stream === "stderr" ? "⚠ " : ""}${ev.line}`);
      } else if (ev.kind === "finished") {
        setMessage(`✅ Done → ${ev.outputDir}`);
        setRunning(false);
        // The source bnb-4bit weights still sit in the HF cache (~5GB
        // for 7B, ~24GB for 70B). The abliterated dir we just wrote
        // is a complete copy, so the source is now redundant. Offer a
        // one-click cleanup — refusing leaves the cache alone.
        void offerSourceCleanup(baseModel, ev.outputDir);
      } else if (ev.kind === "failed") {
        const err = pythonError ?? ev.error;
        setMessage(`❌ ${err} — see logs below`);
        setShowLogs(true);
        setRunning(false);
      }
    };
    try {
      await invoke<void>("abliterate_start", {
        config: { model: baseModel },
        channel,
      });
    } catch (e) {
      setMessage(`Start failed: ${e}`);
      setRunning(false);
    }
  };

  return (
    <div style={{
      ...cfgCard,
      borderColor: "rgba(244,67,54,0.3)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ ...cardTitle, color: "#ff8c8c", flex: 1 }}>🚫 ABLITERATE</div>
        <button
          onClick={() => setShowInfo(true)}
          title="What is abliteration?"
          style={{
            width: 22, height: 22, borderRadius: 11,
            background: "rgba(102,126,234,0.18)",
            border: "1px solid rgba(102,126,234,0.4)",
            color: "#9cc3ff",
            fontSize: 12, fontWeight: 700,
            cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 0,
          }}
        >ⓘ</button>
      </div>
      <div style={{ fontSize: 11, color: "#9aa0aa", lineHeight: 1.4 }}>
        Strip refusal directions from the base model above. Output goes
        to a new transformers-format directory — quantize to GGUF or
        run directly afterward.
      </div>
      <div style={{ fontSize: 10, color: "#8595ad", wordBreak: "break-all" }}>
        Output: <span style={{ color: "#cfd4e1" }}>{outputDir || "(no model selected)"}</span>
      </div>
      <button
        onClick={start}
        disabled={running || !baseModel}
        style={{
          padding: "8px 16px",
          background: running
            ? "rgba(244,67,54,0.18)"
            : "linear-gradient(180deg, #c84a4a 0%, #8c2828 100%)",
          border: "1px solid rgba(244,67,54,0.5)",
          color: "white",
          borderRadius: 6,
          fontSize: 13, fontWeight: 700,
          cursor: running || !baseModel ? "not-allowed" : "pointer",
          opacity: running || !baseModel ? 0.7 : 1,
        }}
      >{running ? "Abliterating…" : "🚫 Abliterate model"}</button>
      {message && (
        <div style={{
          padding: "6px 8px",
          background: message.startsWith("❌") ? "rgba(244,67,54,0.12)" : "rgba(102,126,234,0.10)",
          border: `1px solid ${message.startsWith("❌") ? "rgba(244,67,54,0.4)" : "rgba(102,126,234,0.3)"}`,
          borderRadius: 4,
          fontSize: 10,
          color: message.startsWith("❌") ? "#ffb3b3" : "#cfd4e1",
          wordBreak: "break-word",
        }}>{message}</div>
      )}

      {logLines.length > 0 && (
        <div>
          <button
            onClick={() => setShowLogs((v) => !v)}
            style={{
              padding: "3px 8px",
              background: "rgba(102,126,234,0.10)",
              border: "1px solid rgba(102,126,234,0.3)",
              borderRadius: 4,
              color: "#9cc3ff",
              fontSize: 10,
              cursor: "pointer",
              marginBottom: 4,
            }}
          >{showLogs ? "▼" : "▶"} Logs ({logLines.length})</button>
          {showLogs && (
            <div style={{
              maxHeight: 220,
              overflowY: "auto",
              background: "rgba(0,0,0,0.35)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 4,
              padding: 6,
              fontFamily: "Consolas, monospace",
              fontSize: 10,
              color: "#cfd4e1",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}>
              {logLines.map((l, i) => (
                <div
                  key={i}
                  style={{ color: l.startsWith("⚠ ") ? "#ffb3b3" : undefined }}
                >{l}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {showInfo && <AbliterateInfoModal onClose={() => setShowInfo(false)} />}
    </div>
  );
}

function AbliterateInfoModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      onClick={onClose}
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
          width: 560, maxHeight: "85vh",
          background: "linear-gradient(180deg, #1a1d2e 0%, #16213e 100%)",
          border: "2px solid #c84a4a",
          borderRadius: 12,
          color: "#fafafa",
          display: "flex", flexDirection: "column",
          boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
        }}
      >
        <div style={{ padding: "14px 18px", borderBottom: "1px solid rgba(244,67,54,0.3)" }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>🚫 What is abliteration?</div>
          <div style={{ fontSize: 11, color: "#9aa0aa", marginTop: 4 }}>
            FailSpy's refusal-direction stripping recipe
          </div>
        </div>
        <div style={{ padding: "14px 18px", overflowY: "auto", flex: 1, fontSize: 12.5, lineHeight: 1.55, color: "#d6d8de" }}>
          <p>
            Abliteration finds and deletes the single direction in the
            model's residual stream that's most responsible for refusal
            ("Sorry, I can't help with that") behaviour, without retraining.
          </p>
          <p style={{ fontWeight: 700, color: "#fafafa", marginTop: 12 }}>How it works:</p>
          <ol style={{ paddingLeft: 22, margin: "6px 0" }}>
            <li>Loads the target model in transformers (HF format, fp16 on CUDA).</li>
            <li>Runs ~32 "harmful" + ~32 "harmless" prompts through it.</li>
            <li>Extracts last-token hidden states at every layer; finds the
              strongest activation-difference direction at the best layer
              (the "refusal direction").</li>
            <li>Orthogonalizes every <code>o_proj</code> + <code>down_proj</code> + <code>embed_tokens</code> weight matrix
              against that direction.</li>
            <li>Saves the modified weights to a fresh transformers
              directory — runnable / quantizable / fine-tunable like any
              other model.</li>
          </ol>
          <p style={{ fontWeight: 700, color: "#fafafa", marginTop: 12 }}>
            Runtime (RTX 4090-class GPU):
          </p>
          <ul style={{ paddingLeft: 22, margin: "6px 0" }}>
            <li>1-3B model: ~3-8 min</li>
            <li>7-8B model: ~10-20 min</li>
            <li>13B+ model: 30-60+ min (depends on VRAM headroom for fp16 forward passes)</li>
          </ul>
          <p style={{ marginTop: 12, color: "#9aa0aa" }}>
            This is the same technique that produced models like
            DavidAU's abliterated Gemma, NousResearch's variants, and
            the "supergemma4-abliterated" entry in your downloaded list.
          </p>
          <p style={{ marginTop: 8, color: "#ffb3b3" }}>
            Note: requires a transformers-format model directory (not
            GGUF). If you only have GGUF, download the original HF
            weights first via the Models page.
          </p>
        </div>
        <div style={{
          padding: "12px 18px",
          borderTop: "1px solid rgba(244,67,54,0.3)",
          display: "flex", justifyContent: "flex-end",
        }}>
          <button
            onClick={onClose}
            style={{
              padding: "8px 18px",
              background: "linear-gradient(180deg, #4a6cff 0%, #3a55cc 100%)",
              border: "none", color: "#fff",
              borderRadius: 6, fontSize: 13, fontWeight: 700, cursor: "pointer",
            }}
          >Got it</button>
        </div>
      </div>
    </div>
  );
}

function Field(p: { label: string; value: number; onChange: (v: string) => void; step?: string }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={labelStyle}>{p.label}</span>
      <input
        type="number"
        step={p.step ?? "1"}
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
        style={inputStyle}
      />
    </label>
  );
}

// LoRA α is derived from r (α = 2·r) — render it as a read-only chip
// styled like the green pill at main.py:14861-14868.
function FieldStatic(p: { label: string; value: number }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={labelStyle}>{p.label}</span>
      <div style={{
        textAlign: "center",
        color: "#4caf50",
        fontSize: 12,
        fontWeight: 700,
        background: "rgba(10,14,24,0.85)",
        border: "1px solid rgba(76,175,80,0.35)",
        borderRadius: 6,
        padding: 6,
        minHeight: 28,
      }} title="Derived as 2 × r (PEFT convention). Effective scaling = α / r.">
        {p.value}
      </div>
    </label>
  );
}
