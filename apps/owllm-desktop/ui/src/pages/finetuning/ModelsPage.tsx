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
  compat?: { color: "green" | "orange" | "red" | "gray"; text: string } | null;
};

// Mirrors Rust TunedAdapter — list_tuned_adapters returns {name, path,
// sizeMib, modified, baseHint}. We map onto our TunedModelCard prop
// shape below in the render path.
type TunedAdapterRow = {
  name: string;
  path: string;
  sizeMib: number;
  modified: string | null;
  baseHint: string | null;
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

export default function ModelsPage() {
  const [tab, setTab] = React.useState<SubTab>("browse");
  const [downloaded, setDownloaded] = React.useState<DownloadedItem[]>([]);
  const [tuned, setTuned] = React.useState<TunedAdapterRow[]>([]);

  // Browse-tab state (real HF search).
  const [query, setQuery] = React.useState("");
  const [hits, setHits] = React.useState<HfModelHit[]>([]);
  const [loadingHits, setLoadingHits] = React.useState(false);
  const [hfError, setHfError] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null);
  const [downloading, setDownloading] = React.useState<Set<string>>(new Set());

  const runSearch = React.useCallback(async (q: string) => {
    setLoadingHits(true);
    setHfError(null);
    try {
      const r = await invoke<HfModelHit[]>("hf_search", {
        query: q,
        pipelineTag: null,
        limit: 30,
      });
      setHits(r);
    } catch (e) {
      setHfError(String(e));
      setHits([]);
    } finally {
      setLoadingHits(false);
    }
  }, []);

  // Initial load: empty search returns HF's "trending" set.
  React.useEffect(() => {
    if (tab === "browse" && hits.length === 0 && !loadingHits) {
      runSearch("text-generation");
    }
  }, [tab, hits.length, loadingHits, runSearch]);

  React.useEffect(() => {
    if (tab === "downloaded") {
      invoke<DownloadedItem[]>("models_list_downloaded")
        .then(setDownloaded)
        .catch(() => setDownloaded([]));
    } else if (tab === "tuned") {
      invoke<TunedAdapterRow[]>("list_tuned_adapters")
        .then(setTuned)
        .catch(() => setTuned([]));
    }
  }, [tab]);

  const startDownload = async (modelId: string) => {
    setDownloading((curr) => new Set(curr).add(modelId));
    try {
      await invoke("hf_download", { modelId, files: null });
    } catch (e) {
      setHfError(`Download failed: ${e}`);
    } finally {
      setDownloading((curr) => {
        const next = new Set(curr);
        next.delete(modelId);
        return next;
      });
    }
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
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") runSearch(query); }}
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
          title="Clear search"
          onClick={() => { setQuery(""); runSearch(""); }}
          style={{
            padding: "6px 10px",
            background: "#162033",
            border: "1px solid #243044",
            borderRadius: 6,
            color: "var(--fg)",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          ×
        </button>
        <button
          onClick={() => runSearch(query)}
          disabled={loadingHits}
          style={{
            padding: "6px 14px",
            background: "#1f6feb",
            border: "1px solid #1f6feb",
            borderRadius: 6,
            color: "#fff",
            fontSize: 12,
          }}
        >
          {loadingHits ? "…" : "Search"}
        </button>
      </div>
      </div>

      {hfError && (
        <div style={{
          padding: "8px 12px",
          marginBottom: 10,
          background: "rgba(244,67,54,0.12)",
          border: "1px solid rgba(244,67,54,0.4)",
          borderRadius: 6,
          color: "#ff8080",
          fontSize: 12,
        }}>
          ⚠ {hfError}
        </div>
      )}
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
        {loadingHits && hits.length === 0 ? (
          <div style={{
            gridColumn: "1 / span 2",
            padding: 40,
            textAlign: "center",
            color: "var(--fg-muted)",
            border: "1px dashed #2a3242",
            borderRadius: 8,
            fontSize: 13,
          }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>🔎</div>
            Searching Hugging Face…
          </div>
        ) : hits.length === 0 ? (
          <div style={{
            gridColumn: "1 / span 2",
            padding: 40,
            textAlign: "center",
            color: "var(--fg-muted)",
            border: "1px dashed #2a3242",
            borderRadius: 8,
            fontSize: 13,
          }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>🤷</div>
            No models matched "{query}". Try a broader query like "llama" or "qwen".
          </div>
        ) : hits.map((h) => {
          const dl = downloading.has(h.id);
          const isNew = h.lastModified
            ? (Date.now() - new Date(h.lastModified).getTime()) < 14 * 24 * 3600 * 1000
            : false;
          return (
            <ModelCard
              key={h.id}
              modelName={h.id.split("/").pop() ?? h.id}
              modelId={h.id}
              description={h.pipelineTag ? `Pipeline: ${h.pipelineTag}` : undefined}
              icons={iconsForTags(h.tags)}
              isNew={isNew}
              downloads={fmtCount(h.downloads)}
              likes={fmtCount(h.likes)}
              requiresToken={h.gated || h.private}
              isDownloaded={false}
              downloadProgress={dl ? undefined : undefined}
              selected={selectedId === h.id}
              onClick={(id) => setSelectedId((curr) => curr === id ? null : id)}
              onDownload={(id) => startDownload(id)}
            />
          );
        })}

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
              selected={selectedPath === d.path}
              onSelect={(p) => setSelectedPath((curr) => curr === p ? null : p)}
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
              baseModel={t.baseHint ?? "(base unknown)"}
              adapterPath={t.path}
              format={t.path.toLowerCase().endsWith(".gguf") ? "gguf" : "lora"}
              size={t.sizeMib >= 1024 ? `${(t.sizeMib / 1024).toFixed(1)} GB` : `${t.sizeMib} MB`}
              createdAt={t.modified ?? undefined}
              selected={selectedPath === t.path}
              onSelect={(p) => setSelectedPath((curr) => curr === p ? null : p)}
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
