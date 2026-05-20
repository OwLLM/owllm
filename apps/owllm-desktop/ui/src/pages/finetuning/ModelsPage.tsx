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
import AccessTokensPane from "./widgets/AccessTokensPane";

export default function ModelsPage() {
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
        <button
          data-ui="browseTabBtn"
          style={{
            padding: "6px 14px",
            background: "#1f6feb",
            color: "#fff",
            border: "1px solid #1f6feb",
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          🚀 Browse Models
        </button>
        <button
          data-ui="downloadedTabBtn"
          style={{
            padding: "6px 14px",
            background: "transparent",
            color: "var(--fg)",
            border: "1px solid #2a3242",
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          💾 Downloaded
        </button>
        <button
          data-ui="tunedTabBtn"
          style={{
            padding: "6px 14px",
            background: "transparent",
            color: "var(--fg)",
            border: "1px solid #2a3242",
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          🎯 Tuned Models
        </button>
        <div style={{ marginLeft: "auto", display: "flex", gap: 16, fontSize: 11, color: "var(--fg-muted)" }}>
          <span>0 Files Hosting</span>
          <span>0 Free Models</span>
          <span>0 Quantized (8bit / 4bit)</span>
          <span>0 Other</span>
        </div>
      </div>
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
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <span style={{ color: "#f3c34a" }}>★</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>Recommended Models</span>
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
    </div>
  );
}
