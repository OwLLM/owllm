// TrainPage — port of LLM/desktop_app/main.py:14511 `_build_train_tab`.
// Composes the training widgets (MetricCard, RunModeSelector,
// CheckpointToggle, StatusPill, StartTrainingPanel) with the form
// inputs Qt exposes (base model, run name, dataset, epochs, lr,
// max_seq, batch). All commands flow through Tauri invokes
// (train_start / train_stop / train_status) defined in src-tauri/finetuning.rs.

import React from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  MetricCard,
  RunModeSelector,
  RunMode,
  CheckpointToggle,
  StartTrainingPanel,
  StatusKind,
} from "./widgets/TrainingWidgets";

// Mirrors Rust TrainStatus (finetuning.rs). All numeric fields can be
// null when the run hasn't reported them yet — every read site must
// guard with `!= null` before calling .toFixed() etc.
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
};

const cfgCard: React.CSSProperties = {
  background: "linear-gradient(180deg, #1e2336 0%, #161a2a 100%)",
  border: "1px solid rgba(102,126,234,0.25)",
  borderRadius: 10,
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "#9aa0aa",
  textTransform: "uppercase",
  letterSpacing: 0.6,
};

const inputStyle: React.CSSProperties = {
  padding: "7px 10px",
  background: "#0b1020",
  border: "1px solid #1c2434",
  borderRadius: 6,
  color: "var(--fg)",
  fontSize: 12,
  width: "100%",
};

const sectionTitle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  color: "#667eea",
  marginBottom: 6,
};

const grid2: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 10,
};

async function tryInvoke<T>(cmd: string, args: Record<string, unknown>, fallback: T): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch {
    return fallback;
  }
}

export default function TrainPage() {
  const [baseModel, setBaseModel] = React.useState("meta-llama/Llama-3.1-8B-Instruct");
  const [runName, setRunName] = React.useState("llama31-customer-support-v1");
  const [datasetPath, setDatasetPath] = React.useState("datasets/customer_support.jsonl");
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
    await tryInvoke<void>("train_start", {
      args: {
        baseModel, runName, datasetPath, mode,
        epochs, lr, maxSeq, batchSize, gradAccum, warmupSteps,
        loraR, loraAlpha, loraDropout,
        ckptEnabled, ckptEvery,
      },
    }, undefined);
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

  const canStart = Boolean(baseModel && runName && datasetPath);
  const totalSteps = status.totalSteps ?? 1;
  const pct = status.step ? Math.min(100, Math.round((status.step / totalSteps) * 100)) : 0;

  return (
    <div
      data-ui="trainPageRoot"
      style={{
        height: "100%",
        padding: 14,
        background: "var(--bg-panel)",
        color: "var(--fg)",
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {/* Live metrics strip — always present so users see what the run is doing.
          Rust returns null for unset Option<f32>; use loose-equality null check
          so both null and undefined render the em-dash placeholder instead of
          crashing on .toFixed(). */}
      <div style={{ display: "flex", gap: 10 }}>
        <MetricCard title="Step"      icon="🔁" value={status.step      != null ? `${status.step} / ${status.totalSteps ?? "?"}` : "—"} />
        <MetricCard title="Loss"      icon="📉" value={status.loss      != null ? status.loss.toFixed(4)            : "—"} accent="#FF9800" />
        <MetricCard title="Eval loss" icon="🎯" value={status.evalLoss  != null ? status.evalLoss.toFixed(4)        : "—"} accent="#4CAF50" />
        <MetricCard title="LR"        icon="⚡" value={status.learningRate != null ? status.learningRate.toExponential(2)  : "—"} accent="#9C27B0" />
        <MetricCard title="VRAM"      icon="🧠" value={status.vramUsedGb   != null ? `${status.vramUsedGb.toFixed(1)} GB` : "—"} accent="#00A4EF" />
      </div>

      {/* Two-column form: model+dataset+mode on left, params on right. */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div data-ui="cfgCard" style={cfgCard}>
          <div style={sectionTitle}>🧠 Model & dataset</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={labelStyle}>Base model</span>
            <input data-ui="train_base_model" style={inputStyle} value={baseModel} onChange={(e) => setBaseModel(e.target.value)} placeholder="hf-org/model-id or local path" />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={labelStyle}>Run name</span>
            <input data-ui="train_model_name" style={inputStyle} value={runName} onChange={(e) => setRunName(e.target.value)} placeholder="my-finetune-v1" />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={labelStyle}>Dataset path</span>
            <div style={{ display: "flex", gap: 6 }}>
              <input data-ui="train_data_path" style={{ ...inputStyle, flex: 1, width: "auto" }} value={datasetPath} onChange={(e) => setDatasetPath(e.target.value)} placeholder="datasets/my.jsonl" />
              <button
                style={{ padding: "0 14px", background: "#162033", border: "1px solid #243044", borderRadius: 6, color: "var(--fg)", fontSize: 12, cursor: "pointer" }}
                onClick={async () => {
                  const picked = await tryInvoke<string | null>("dialog_pick_file", { filters: ["jsonl", "json", "csv", "parquet"] }, null);
                  if (picked) setDatasetPath(picked);
                }}
              >Browse…</button>
            </div>
          </div>
          <div style={{ marginTop: 4 }}>
            <span style={labelStyle}>Run mode</span>
            <div style={{ marginTop: 6 }}>
              <RunModeSelector value={mode} onChange={setMode} />
            </div>
          </div>
        </div>

        <div data-ui="cfgCard" style={cfgCard}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={sectionTitle}>⚙ Hyperparameters</div>
            <button
              data-ui="use_recommended_btn"
              onClick={useRecommended}
              style={{
                padding: "4px 10px",
                background: "rgba(102,126,234,0.18)",
                border: "1px solid rgba(102,126,234,0.4)",
                color: "#fff",
                borderRadius: 6,
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >🪄 Use recommended</button>
          </div>

          <div style={grid2}>
            <Field label="Epochs"           value={epochs}      onChange={(v) => setEpochs(Number(v) || 1)} />
            <Field label="Learning rate"    value={lr}          onChange={(v) => setLr(Number(v) || 0)} step="0.0001" />
            <Field label="Max seq length"   value={maxSeq}      onChange={(v) => setMaxSeq(Number(v) || 1)} />
            <Field label="Batch size"       value={batchSize}   onChange={(v) => setBatchSize(Number(v) || 1)} />
            <Field label="Grad accum steps" value={gradAccum}   onChange={(v) => setGradAccum(Number(v) || 1)} />
            <Field label="Warmup steps"     value={warmupSteps} onChange={(v) => setWarmupSteps(Number(v) || 0)} />
          </div>

          {mode !== "full" && (
            <>
              <div style={{ ...sectionTitle, marginTop: 4 }}>🪶 LoRA</div>
              <div style={grid2}>
                <Field label="LoRA r"       value={loraR}       onChange={(v) => setLoraR(Number(v) || 1)} />
                <Field label="LoRA alpha"   value={loraAlpha}   onChange={(v) => setLoraAlpha(Number(v) || 1)} />
                <Field label="LoRA dropout" value={loraDropout} onChange={(v) => setLoraDropout(Number(v) || 0)} step="0.01" />
              </div>
            </>
          )}

          <CheckpointToggle
            enabled={ckptEnabled}
            everySteps={ckptEvery}
            onEnabledChange={setCkptEnabled}
            onStepsChange={setCkptEvery}
          />
        </div>
      </div>

      {/* Progress bar (only meaningful while running). */}
      {(status.state === "running" || status.step != null) && (
        <div style={{ height: 8, background: "#0b1020", border: "1px solid #1c2434", borderRadius: 4, overflow: "hidden" }}>
          <div style={{
            height: "100%",
            width: `${pct}%`,
            background: "linear-gradient(90deg, #667eea, #9C27B0)",
            transition: "width 300ms ease",
          }} />
        </div>
      )}

      <StartTrainingPanel
        status={status.state}
        canStart={canStart}
        onStart={start}
        onStop={stop}
      />
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
