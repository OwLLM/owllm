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
import WeightPickerDialog from "./widgets/WeightPickerDialog";
import { invoke, Channel } from "@tauri-apps/api/core";

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

// Shared grid layout for every card-bearing surface (Browse,
// Downloaded, Tuned). Auto-fill with minmax(290, 390) so cards cap at
// 390 px wide and reflow on narrow viewports — same on every tab.
const CARD_GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(290px, 390px))",
  gap: 10,
};

const emptyState: React.CSSProperties = {
  gridColumn: "1 / span 2",
  padding: 40,
  textAlign: "center",
  color: "var(--fg-muted)",
  border: "1px dashed #2a3242",
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

// Kick the Rust export_gguf command against a tuned transformers dir.
// Lightweight wrapper: spawn, log progress to console + show the user
// a banner via setError, refresh the tuned list on completion so the
// new .gguf file appears as a sibling row.
function exportTunedToGguf(
  sourceDir: string,
  setError: (msg: string | null) => void,
  refreshTuned: () => void,
  setLogs: (updater: (prev: string[]) => string[]) => void,
  setLogsOpen: (v: boolean) => void,
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
  const pushLog = (s: string) => setLogs((prev) => {
    const next = [...prev, s];
    return next.length > 300 ? next.slice(next.length - 300) : next;
  });
  channel.onmessage = (ev) => {
    console.log("[export-gguf] event", ev);
    if (ev.kind === "log") {
      pushLog(`${ev.stream === "stderr" ? "⚠ " : ""}${ev.line}`);
      // Update the banner only on signal lines so it doesn't churn on
      // every INFO log; the full tail is in the logs panel.
      const low = ev.line.toLowerCase();
      if (low.includes("error") || low.includes("traceback") || low.includes("notimplemented")) {
        setError(`GGUF export: ${ev.line}`);
      }
    } else if (ev.kind === "finished") {
      setError(`✅ GGUF written → ${ev.outputDir}`);
      refreshTuned();
    } else if (ev.kind === "failed") {
      setError(`❌ GGUF export failed: ${ev.error} — see logs below`);
      setLogsOpen(true);
    }
  };
  invoke<void>("export_gguf", {
    config: { sourceDir, outtype: "f16" },
    channel,
  })
    .then(() => console.log("[export-gguf] invoke returned ok (script running in background)"))
    .catch((e) => {
      console.error("[export-gguf] invoke rejected", e);
      setError(`GGUF export start failed: ${e}`);
      pushLog(`invoke rejected: ${e}`);
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

// "Test" a tuned model: for transformers dirs the user needs to GGUF
// first; for .gguf files we hand off to the Server start path so the
// Chat page can talk to it. Cheap & honest — surface the situation
// instead of pretending to do something.
function testTunedAdapter(path: string, setError: (msg: string | null) => void) {
  console.log("[test-tuned] →", path);
  if (path.toLowerCase().endsWith(".gguf")) {
    // Start the server pointing at this .gguf so the Chat page can use it.
    setError(`▶ Starting server with ${path.split(/[\\/]/).pop()}…`);
    invoke<void>("server_start", { modelId: path })
      .then(() => setError(`✅ Server starting — open the Chat page.`))
      .catch((e) => setError(`❌ Server start failed: ${e}`));
  } else {
    setError(
      "ℹ Transformers-dir models can't be served by llama-server directly. Click 📦 Export GGUF first, then 💬 Test the resulting .gguf.",
    );
  }
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
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null);
  const [downloading, setDownloading] = React.useState<Set<string>>(new Set());
  // Weight-picker modal: when set, opens for that model id.
  const [pickerFor, setPickerFor] = React.useState<string | null>(null);
  // Cached total VRAM in GB for picker color rules.
  const [vramGb, setVramGb] = React.useState<number>(8);

  React.useEffect(() => {
    invoke<{ gpus: Array<{ totalMib: number }> }>("vram_status")
      .then((s) => {
        const max = Math.max(0, ...s.gpus.map((g) => g.totalMib));
        if (max > 0) setVramGb(max / 1024);
      })
      .catch(() => { /* keep 8 GB fallback */ });
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
        .then(setDownloaded)
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

  // Step 1: clicking Download opens the WeightPickerDialog so the
  // user can choose which files to fetch (Q4/Q5/Q6/Q8 etc) instead of
  // pulling every variant blindly.
  const startDownload = (modelId: string) => {
    setPickerFor(modelId);
  };

  // Step 2: picker resolves with a list. Empty = "download all".
  const confirmDownload = async (modelId: string, files: string[]) => {
    setPickerFor(null);
    setDownloading((curr) => new Set(curr).add(modelId));
    try {
      await invoke("hf_download", { modelId, files: files.length > 0 ? files : null });
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
          { key: "cache",      dataUi: "cacheTabBtn",      label: "💽 Cache"          },
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
                color: on ? "#fff" : "#dadcdf",
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
      <div
        data-ui="searchContainer"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginLeft: "auto",
          width: 430,
          flexShrink: 0,
        }}
      >
        <select
          data-ui="sortSelector"
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
          title="Sort by"
          style={{
            padding: "6px 8px",
            background: "#0b1020",
            border: "1px solid #1c2434",
            borderRadius: 6,
            color: "var(--fg)",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          <option value="downloads">↓ Downloads</option>
          <option value="likes">❤ Likes</option>
          <option value="lastModified">🕓 Uploaded</option>
        </select>
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
        <div
          onClick={() => setHfError(null)}
          title="click to dismiss"
          style={{
            position: "sticky",
            top: 0,
            zIndex: 50,
            padding: "8px 12px",
            marginBottom: 10,
            // Colour by content: green for finished, red for errors,
            // blue for in-progress / informational.
            background: hfError.startsWith("✅")
              ? "rgba(76,175,80,0.18)"
              : hfError.startsWith("❌") || hfError.includes("failed")
                ? "rgba(244,67,54,0.18)"
                : "rgba(102,126,234,0.18)",
            border: `1px solid ${hfError.startsWith("✅")
              ? "rgba(76,175,80,0.5)"
              : hfError.startsWith("❌") || hfError.includes("failed")
                ? "rgba(244,67,54,0.5)"
                : "rgba(102,126,234,0.5)"}`,
            borderRadius: 6,
            color: hfError.startsWith("✅")
              ? "#a5e6a5"
              : hfError.startsWith("❌") || hfError.includes("failed")
                ? "#ff8080"
                : "#cfd4e1",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          {hfError.startsWith("✅") || hfError.startsWith("❌") || hfError.startsWith("📦") ? "" : "⚠ "}{hfError}
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
                  description={h.pipelineTag ? `Pipeline: ${h.pipelineTag}` : undefined}
                  icons={iconsForTags(h.tags)}
                  isNew={isNewFlag}
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
              description={`${r.description}  ·  ${r.paramsB.toFixed(1)}B params · inference ≈${r.inferenceGb.toFixed(1)} GB · LoRA ≈${r.loraTrainGb.toFixed(1)} GB`}
              size={`${r.paramsB.toFixed(1)}B params`}
              icons={iconsForTags(r.tags)}
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

      {tab === "downloaded" && (
        <div style={CARD_GRID}>
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
        </div>
      )}

      {tab === "tuned" && (
        <div style={CARD_GRID}>
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
              onTest={(path) => testTunedAdapter(path, setHfError)}
              onExportGguf={(path) => exportTunedToGguf(path, setHfError, refreshTuned, setExportLogs, setExportLogsOpen)}
              onDelete={(path) => deleteTunedAdapter(path, t.name, setHfError, refreshTuned)}
            />
          ))}
        </div>
      )}
      </div>
      {/* Shared right rail — tokens/info panel up top, GGUF export
          logs below. Same column for all three tabs. */}
      <div style={{ width: 280, flexShrink: 0, position: "sticky", top: 0, display: "flex", flexDirection: "column", gap: 10 }}>
        <AccessTokensPane selectedModel={selectedModelForInfo} />
        {exportLogs.length > 0 && (
          <div>
            <button
              onClick={() => setExportLogsOpen((v) => !v)}
              style={{
                padding: "4px 10px",
                background: "rgba(102,126,234,0.18)",
                border: "1px solid rgba(102,126,234,0.4)",
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
              <div style={{
                maxHeight: 320,
                overflowY: "auto",
                background: "rgba(0,0,0,0.55)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 4,
                padding: 6,
                fontFamily: "Consolas, monospace",
                fontSize: 10,
                color: "#cfd4e1",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}>
                {exportLogs.map((l, i) => (
                  <div
                    key={i}
                    style={{ color: l.startsWith("⚠ ") ? "#ffb3b3" : undefined }}
                  >{l}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      </div>
      )}

      {tab === "cache" && (
        <CacheTab setBanner={setHfError} />
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

      {pickerFor && (
        <WeightPickerDialog
          modelId={pickerFor}
          vramGb={vramGb}
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

function CacheTab({ setBanner }: { setBanner: (msg: string | null) => void }) {
  const [summary, setSummary] = React.useState<HfCacheSummary | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);

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

  const toggleOne = (path: string) =>
    setSelected((curr) => {
      const next = new Set(curr);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const toggleAll = () => {
    if (!summary) return;
    if (selected.size === summary.entries.length) setSelected(new Set());
    else setSelected(new Set(summary.entries.map((e) => e.path)));
  };

  const selectedSizeBytes = React.useMemo(() => {
    if (!summary) return 0;
    return summary.entries
      .filter((e) => selected.has(e.path))
      .reduce((a, e) => a + e.sizeBytes, 0);
  }, [selected, summary]);

  const deleteSelected = async () => {
    if (!summary || selected.size === 0) return;
    const paths = Array.from(selected);
    const repoNames = summary.entries
      .filter((e) => selected.has(e.path))
      .map((e) => e.repoId);
    const ok = window.confirm(
      `Delete ${paths.length} cached model${paths.length === 1 ? "" : "s"} ` +
        `(${fmtBytes(selectedSizeBytes)})?\n\n` +
        repoNames.slice(0, 8).join("\n") +
        (repoNames.length > 8 ? `\n…and ${repoNames.length - 8} more` : "") +
        `\n\nThis is permanent. Anything still in use will be re-downloaded on demand.`,
    );
    if (!ok) return;
    setBusy(true);
    setBanner(`🧹 Deleting ${paths.length} cached model(s)…`);
    let freed = 0;
    let failures: string[] = [];
    for (const p of paths) {
      try {
        const f = await invoke<number>("hf_cache_delete", { path: p });
        freed += f;
      } catch (e) {
        failures.push(`${p}: ${e}`);
      }
    }
    setBusy(false);
    if (failures.length === 0) {
      setBanner(`✅ Freed ${fmtBytes(freed)} (${paths.length} models)`);
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
        background: "rgba(102,126,234,0.08)",
        border: "1px solid rgba(102,126,234,0.3)",
        borderRadius: 6,
        fontSize: 12,
        color: "var(--fg)",
      }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>
          💽 HuggingFace cache —{" "}
          <span style={{ color: "#9cc3ff" }}>
            {summary ? fmtBytes(summary.totalBytes) : "scanning…"}
          </span>{" "}
          across {summary?.entries.length ?? 0} model
          {summary?.entries.length === 1 ? "" : "s"}
        </div>
        <div style={{ fontSize: 10, color: "var(--fg-muted)", lineHeight: 1.5 }}>
          Abliterate / Train / GGUF export read source models from these
          dirs. Deleting one here doesn't break anything currently loaded —
          HuggingFace will just re-download next time you ask for it.
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

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          onClick={refresh}
          disabled={loading || busy}
          style={btnGhost(loading || busy)}
        >🔄 {loading ? "Scanning…" : "Refresh"}</button>
        <button
          onClick={toggleAll}
          disabled={!summary || summary.entries.length === 0 || busy}
          style={btnGhost(busy)}
        >{summary && selected.size === summary.entries.length ? "Clear" : "Select all"}</button>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>
          {selected.size} selected · {fmtBytes(selectedSizeBytes)}
        </div>
        <button
          onClick={deleteSelected}
          disabled={selected.size === 0 || busy}
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
            cursor: selected.size === 0 || busy ? "not-allowed" : "pointer",
            opacity: selected.size === 0 || busy ? 0.6 : 1,
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
          <div style={{ flex: 2 }}>Model</div>
          <div style={{ width: 100, textAlign: "right" }}>Size</div>
          <div style={{ width: 100 }}>Last used</div>
          <div style={{ width: 90 }}>Cache</div>
        </div>
        {!summary || summary.entries.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: "var(--fg-muted)", fontSize: 12 }}>
            {loading ? "Scanning…" : "No cached models found."}
          </div>
        ) : summary.entries.map((e) => (
          <div key={e.path} style={cacheRow(false, selected.has(e.path))} title={e.path}>
            <div style={{ width: 28 }}>
              <input
                type="checkbox"
                checked={selected.has(e.path)}
                onChange={() => toggleOne(e.path)}
                disabled={busy}
              />
            </div>
            <div style={{ flex: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {e.repoId}
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
        ))}
      </div>
    </div>
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

const cacheRow = (isHeader: boolean, isSelected = false): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 10px",
  fontSize: 12,
  background: isHeader
    ? "rgba(0,0,0,0.4)"
    : isSelected
      ? "rgba(102,126,234,0.10)"
      : "transparent",
  borderBottom: isHeader ? "1px solid #2a3242" : "1px solid rgba(255,255,255,0.05)",
  color: isHeader ? "var(--fg-muted)" : "var(--fg)",
  fontWeight: isHeader ? 700 : 400,
});
