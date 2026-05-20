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
import ModelCard from "./widgets/ModelCard";
import DownloadedModelCard from "./widgets/DownloadedModelCard";
import TunedModelCard from "./widgets/TunedModelCard";
import AccessTokensPane from "./widgets/AccessTokensPane";
import { invoke } from "@tauri-apps/api/core";

type SubTab = "browse" | "downloaded" | "tuned";

type DownloadedItem = {
  name: string;
  path: string;
  size?: string;
  icons?: string;
  envKey?: string;
  isIncomplete?: boolean;
  onboarding?: "READY" | "BUILDING" | "BROKEN" | "NEW";
  compat?: { color: "green" | "orange" | "red" | "gray"; text: string };
};

type TunedItem = {
  name: string;
  base: string;
  path: string;
  format?: "lora" | "gguf";
  size?: string;
  steps?: number;
  loss?: number;
  createdAt?: string;
};

// Tauri-or-mock fallback: returns mock data when running under vite dev
// without a Tauri runtime so the page still shows something useful.
async function tryInvoke<T>(cmd: string, fallback: T): Promise<T> {
  try {
    return await invoke<T>(cmd);
  } catch {
    return fallback;
  }
}

export default function ModelsPage() {
  const [tab, setTab] = React.useState<SubTab>("browse");
  const [downloaded, setDownloaded] = React.useState<DownloadedItem[]>([]);
  const [tuned, setTuned] = React.useState<TunedItem[]>([]);

  React.useEffect(() => {
    if (tab === "downloaded") {
      tryInvoke<DownloadedItem[]>("models_list_downloaded", [
        { name: "Llama-3.1-8B-Instruct", path: "models/Llama-3.1-8B-Instruct", size: "16.0 GB", icons: "💬 💡", envKey: "transformers-cu121", onboarding: "READY", compat: { color: "green", text: "Fits" } },
        { name: "Qwen3-1.7B",            path: "models/Qwen3-1.7B",            size: "3.4 GB",  icons: "💡",     envKey: "transformers-cu121", onboarding: "NEW",   compat: { color: "green", text: "Fits" } },
        { name: "Mistral-7B-v0.3",       path: "models/Mistral-7B-v0.3",       size: "14.5 GB", icons: "💡 🧩", envKey: "transformers-cu121", onboarding: "BUILDING", compat: { color: "green", text: "Fits" } },
        { name: "Gemma-7B-IT (partial)", path: "models/gemma-7b-it",           size: "Downloading 6.2/16.8 GB", icons: "💎 💬", isIncomplete: true, onboarding: "BROKEN" },
      ]).then(setDownloaded);
    } else if (tab === "tuned") {
      tryInvoke<TunedItem[]>("models_list_tuned", [
        { name: "llama-3.1-finetune-customer-support-v1", base: "meta-llama/Llama-3.1-8B-Instruct", path: "adapters/llama31-cs-v1", format: "lora", size: "120 MB", steps: 1200, loss: 0.4231, createdAt: "2026-05-12" },
        { name: "qwen3-1p7b-summarizer",                  base: "Qwen/Qwen3-1.7B",                   path: "adapters/qwen3-summarizer", format: "lora", size: "62 MB",  steps: 800,  loss: 0.5874, createdAt: "2026-05-08" },
        { name: "mistral7b-merged.Q4_K_M.gguf",           base: "mistralai/Mistral-7B-v0.3",         path: "adapters/mistral7b-Q4.gguf", format: "gguf", size: "4.3 GB", createdAt: "2026-05-15" },
      ]).then(setTuned);
    }
  }, [tab]);

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
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        {([
          { key: "browse",     dataUi: "browseTabBtn",     label: "🚀 Browse Models" },
          { key: "downloaded", dataUi: "downloadedTabBtn", label: "💾 Downloaded"    },
          { key: "tuned",      dataUi: "tunedTabBtn",      label: "🎯 Tuned Models"  },
        ] as const).map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              data-ui={t.dataUi}
              onClick={() => setTab(t.key)}
              style={{
                padding: "6px 14px",
                background: active ? "#1f6feb" : "transparent",
                color: active ? "#fff" : "var(--fg)",
                border: `1px solid ${active ? "#1f6feb" : "#2a3242"}`,
                borderRadius: 6,
                fontSize: 12,
                cursor: "pointer",
                transition: "background 120ms ease, border-color 120ms ease",
              }}
            >
              {t.label}
            </button>
          );
        })}
        <div style={{ marginLeft: "auto", display: "flex", gap: 16, fontSize: 11, color: "var(--fg-muted)" }}>
          <span>{downloaded.length} Downloaded</span>
          <span>{tuned.length} Tuned</span>
          <span>0 Free Models</span>
          <span>0 Quantized (8bit / 4bit)</span>
        </div>
      </div>
      {tab === "browse" && <>
      {/* formatFilterContainer + searchContainer — Qt puts these side-by-side
          on the same row at y~275 (filter ~513 wide on left, search ~305
          wide on right). Wrap both in a flex row so the React layout
          matches Qt's geometry instead of stacking full-width strips. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
      <div
        data-ui="formatFilterContainer"
        style={{
          width: 513,
          height: 50,
          padding: "4px 10px",
          background: "rgba(102, 126, 234, 0.08)",
          border: "1px solid rgba(102, 126, 234, 0.25)",
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
        {[
          { label: "✅ Trainable", tip: "transformers-format models with full weights — what the Train tab can fine-tune." },
          { label: "📦 GGUF", tip: "llama.cpp / bundled-proxy inference format. Cannot be fine-tuned." },
          { label: "💡 Instruct", tip: "Instruction-tuned base models (-instruct, -it). Follow direct task prompts." },
          { label: "💬 Chat", tip: "Multi-turn chat / conversation tuned (-chat, -dialog, ChatML)." },
          { label: "🧩 Adapter (LoRA)", tip: "PEFT / LoRA adapters — small overlays that need a base model to load." },
          { label: "⚡ Quantized (AWQ / GPTQ)", tip: "Inference-only weight-quantized checkpoints (AWQ or GPTQ)." },
          { label: "🧠 Reasoning", tip: "Chain-of-thought reasoning models (R1, o1-style, deepseek-r1, thinking)." },
          { label: "👁️ Vision", tip: "Multimodal vision-language models (image input — VL, llava, vision)." },
        ].map((f) => (
          <label
            key={f.label}
            title={f.tip}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              color: "#dadcdf",
              fontSize: "10pt",
              background: "transparent",
              cursor: "pointer",
              userSelect: "none",
            }}
          >
            <input
              type="checkbox"
              style={{ width: 14, height: 14, margin: 0, flexShrink: 0 }}
            />
            <span>{f.label}</span>
          </label>
        ))}
      </div>
      <div
        data-ui="searchContainer"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginLeft: "auto",
          width: 305,
          flexShrink: 0,
        }}
      >
        <input
          placeholder="Search Hugging Face..."
          style={{
            flex: 1,
            minWidth: 0,
            padding: "6px 10px",
            background: "#0b1020",
            border: "1px solid #1c2434",
            borderRadius: 6,
            color: "var(--fg)",
            fontSize: 12,
          }}
        />
        <button
          style={{
            padding: "6px 10px",
            background: "#162033",
            border: "1px solid #243044",
            borderRadius: 6,
            color: "var(--fg)",
            fontSize: 12,
          }}
        >
          +
        </button>
        <button
          style={{
            padding: "6px 14px",
            background: "#1f6feb",
            border: "1px solid #1f6feb",
            borderRadius: 6,
            color: "#fff",
            fontSize: 12,
          }}
        >
          Search
        </button>
      </div>
      </div>
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
          📚 Recommended Models
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

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 280px", gap: 10 }}>
        {([
          { modelId: "nemotron-labs/diffustion-14b",         name: "Nemotron Labs DiffuStion 14B",  desc: "Diffusion-style text model from Nemotron Labs.",  size: "14B params", icons: "💡 🧠",   badge: { color: "orange" as const, text: "Tight fit" }, isNew: true,  downloads: "1.2K", likes: "84" },
          { modelId: "meta-llama/Llama-3.1-8B-Instruct",     name: "Llama 3.1 8B Instruct",         desc: "Meta Llama 3.1 8B Instruct — general purpose chat.", size: "8B params", icons: "💬 💡",   badge: { color: "green" as const, text: "Fits" }, downloads: "45.8K", likes: "1.2K" },
          { modelId: "webworld/webworld-8b",                 name: "WebWorld 8B",                   desc: "Web-tuned 8B model for browsing tasks.",          size: "8B params", icons: "🌐 💬",   badge: { color: "green" as const, text: "Fits" }, downloads: "812", likes: "42" },
          { modelId: "Qwen/Qwen3-1.7B",                       name: "Qwen3 1.7B",                    desc: "Qwen3 small instruct variant.",                  size: "1.7B params", icons: "💡",     badge: { color: "gray" as const, text: "Unknown" }, downloads: "3.4K", likes: "210" },
          { modelId: "nemotron-labs/nemotron-variant",       name: "Nemotron Labs ...",             desc: "Variant of Nemotron Labs model family.",         size: "70B params", icons: "🧠",      badge: { color: "red" as const, text: "Too large" } },
          { modelId: "mistralai/Mistral-7B-v0.3",            name: "Mistral 7B v0.3",               desc: "Mistral 7B base model.",                         size: "7B params", icons: "💡 🧩",   badge: { color: "green" as const, text: "Fits" }, isNew: true, downloads: "28.1K", likes: "950" },
        ]).map((m, i) => (
          <ModelCard
            key={m.modelId + ":" + i}
            modelName={m.name}
            modelId={m.modelId}
            description={m.desc}
            size={m.size}
            icons={m.icons}
            compatibilityBadge={m.badge}
            isNew={m.isNew}
            downloads={m.downloads}
            likes={m.likes}
          />
        ))}

        <AccessTokensPane />
      </div>
      </>}

      {tab === "downloaded" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {downloaded.length === 0 ? (
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
          ) : downloaded.map((d) => (
            <DownloadedModelCard
              key={d.path}
              modelName={d.name}
              modelPath={d.path}
              size={d.size}
              icons={d.icons}
              envKey={d.envKey}
              isIncomplete={d.isIncomplete}
              onboardingStatus={d.onboarding}
              compatibilityBadge={d.compat}
            />
          ))}
        </div>
      )}

      {tab === "tuned" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {tuned.length === 0 ? (
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
              baseModel={t.base}
              adapterPath={t.path}
              format={t.format}
              size={t.size}
              steps={t.steps}
              finalLoss={t.loss}
              createdAt={t.createdAt}
            />
          ))}
        </div>
      )}

      {tab === "browse" && (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: 10,
          padding: "6px 8px",
          background: "#0e1320",
          border: "1px solid #1c2434",
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
            background: "#162033",
            color: "var(--fg)",
            border: "1px solid #243044",
            borderRadius: 4,
            fontSize: 11,
          }}
        >
          Browse
        </button>
      </div>
      )}
    </div>
  );
}
