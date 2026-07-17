// DatasetBuilderPage — turn documents + URLs into a fine-tuning dataset.
//
// Self-contained pipeline so the app never needs an external tool to make
// training data:
//   1. INGEST  — the bundled, GPU-free dataset_ingest.py extracts clean text
//                from PDF/DOCX/TXT/MD/URL and splits it into overlapping chunks
//                (Rust command `dataset_ingest`).
//   2. GENERATE — for each chunk, the user's PICKED model writes a few
//                {instruction, output} pairs grounded only in that chunk
//                (reuses the shared streamChatCompletion dispatch — local OR
//                cloud).
//   3. SAVE    — the pairs are written as {instruction, output} JSONL (the exact
//                shape finetune.py / dataset_check accept), ready for the Train
//                page.
//
// The generated pairs are AI-written, so the page is explicit about that and
// shows every pair for review before training.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import ModelPicker, { type AccountsStatusLite } from "../agentic/ModelPicker";
import { getServerCtx } from "../core/serverContext";
import { streamChatCompletion, providerFor, type ModelInfo } from "../agentic/dispatch";
import { LogBox } from "../../components/LogBox";
import { chatRuntime } from "../../runtime/chatRuntime";
import { useChatSession } from "../../runtime/useChatSession";
import { translateUiText } from "../../localization";

type Source = { id: string; kind: "file" | "url"; value: string; name: string };
type Pair = { instruction: string; output: string; source?: string };
type DSState = {
  sources: Source[];
  urlDraft: string;
  chunkSize: number;
  chunkOverlap: number;
  pairsPerChunk: number;
  maxChunks: number;
  modelId: string;
  pairs: Pair[];
  log: string[];
  busy: boolean;
  status: string;
  savedPath: string;
};

const SID = "finetuning:dataset-builder";
const DEFAULT_STATE: DSState = {
  sources: [], urlDraft: "", chunkSize: 1200, chunkOverlap: 150, pairsPerChunk: 3, maxChunks: 0,
  modelId: "", pairs: [], log: [], busy: false,
  status: "Add documents or URLs, pick a model, then Generate.", savedPath: "",
};

// Result shape from dataset_ingest.py.
type IngestSource = {
  type: string; value: string; ok: boolean; chars: number; chunks: number;
  error: string | null; text?: string; chunkList?: string[];
};
type IngestResult = { sources: IngestSource[]; chunkSize: number; chunkOverlap: number; totalChunks: number };

const GEN_SYSTEM =
  "You generate high-quality supervised fine-tuning data. Given a passage, you write diverse, " +
  "self-contained instruction/response pairs grounded ONLY in the passage. Never invent facts " +
  "that are not supported by the passage.";

function genUser(chunk: string, n: number): string {
  return [
    `From the PASSAGE below, write up to ${n} instruction/output training pairs.`,
    "Rules:",
    '- Each "instruction" is a clear task or question answerable from the passage ALONE.',
    '- Each "output" is accurate, complete and self-contained (do NOT say "as the passage states").',
    "- Vary the instruction style (questions, \"Explain…\", \"Summarize…\", \"How…\").",
    '- Return ONLY a JSON array, no prose, no code fences: [{"instruction":"...","output":"..."}]',
    "",
    "PASSAGE:",
    chunk,
  ].join("\n");
}

// Tolerant parse — models wrap JSON in prose or code fences. Pull the first
// array; if that fails, salvage individual {…} objects.
function parsePairs(text: string): Pair[] {
  let arr: unknown = null;
  const m = text.match(/\[[\s\S]*\]/);
  if (m) { try { arr = JSON.parse(m[0]); } catch { /* fall through */ } }
  if (!Array.isArray(arr)) {
    const objs = text.match(/\{[^{}]*"instruction"[\s\S]*?\}/g) ?? [];
    arr = objs.map((o) => { try { return JSON.parse(o); } catch { return null; } }).filter(Boolean);
  }
  if (!Array.isArray(arr)) return [];
  return (arr as Array<Record<string, unknown>>)
    .map((x) => ({
      instruction: String(x?.instruction ?? x?.input ?? x?.prompt ?? "").trim(),
      output: String(x?.output ?? x?.response ?? x?.completion ?? "").trim(),
    }))
    .filter((p) => p.instruction && p.output);
}

const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SERVABLE = new Set(["local", "tuned", "gguf"]);

export default function DatasetBuilderPage() {
  const sess = useChatSession<DSState>(SID);
  const hydrated = useRef(false);
  if (!hydrated.current) {
    hydrated.current = true;
    chatRuntime.hydrateIfIdle(SID, DEFAULT_STATE);
  }
  const st = sess.payload ?? DEFAULT_STATE;
  function set<K extends keyof DSState>(k: K, v: DSState[K] | ((p: DSState[K]) => DSState[K])) {
    chatRuntime.setPayload(SID, (prev) => {
      const cur = (prev as DSState) ?? DEFAULT_STATE;
      const nv = typeof v === "function" ? (v as (p: DSState[K]) => DSState[K])(cur[k]) : v;
      return { ...cur, [k]: nv };
    });
  }
  const { sources, urlDraft, chunkSize, chunkOverlap, pairsPerChunk, maxChunks, modelId, pairs, log, busy, status, savedPath } = st;

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [accounts, setAccounts] = useState<AccountsStatusLite | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let dead = false;
    const reload = () => {
      invoke<ModelInfo[]>("list_models")
        .then((all) => { if (!dead) { setModels(all); if (!modelId) set("modelId", all.find((m) => SERVABLE.has(m.provider))?.model_id || all[0]?.model_id || ""); } })
        .catch(() => {});
      invoke<AccountsStatusLite>("accounts_status").then((s) => { if (!dead) setAccounts(s); }).catch(() => {});
    };
    reload();
    window.addEventListener("owllm:models:refresh", reload as EventListener);
    return () => { dead = true; window.removeEventListener("owllm:models:refresh", reload as EventListener); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addLog = (line: string) => set("log", (l) => [...l, line].slice(-400));
  const setStatus = (s: string) => set("status", s);

  // ---- source management ----
  const addFiles = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: true,
        title: translateUiText("Add documents"),
        filters: [{ name: translateUiText("Documents"), extensions: ["pdf", "docx", "txt", "md", "markdown", "text"] }],
      });
      const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
      if (list.length === 0) return;
      set("sources", (cur) => {
        const have = new Set(cur.map((s) => s.value));
        const add = list.filter((p) => !have.has(p)).map((p) => ({ id: newId(), kind: "file" as const, value: p, name: p.replace(/^.*[\\/]/, "") }));
        return [...cur, ...add];
      });
    } catch (e) { setStatus(`Couldn't add files: ${e}`); }
  };
  const addUrl = () => {
    const u = urlDraft.trim();
    if (!u) return;
    const url = /^https?:\/\//i.test(u) ? u : `https://${u}`;
    set("sources", (cur) => cur.some((s) => s.value === url) ? cur : [...cur, { id: newId(), kind: "url", value: url, name: url }]);
    set("urlDraft", "");
  };
  const removeSource = (id: string) => set("sources", (cur) => cur.filter((s) => s.id !== id));

  // Resolve a usable port for the picked model — start the local server if the
  // model is servable and not already running; cloud models need no port.
  const resolvePort = async (): Promise<number> => {
    const m = models.find((x) => x.model_id === modelId);
    const provider = m?.provider ?? providerFor(modelId, models);
    type S = { running: boolean; port: number | null; model_id: string };
    const status0 = await invoke<S>("server_status");
    if (!SERVABLE.has(provider)) return status0.port ?? 0;
    if (status0.running && status0.model_id === modelId && status0.port) return status0.port;
    addLog(`Starting local server for ${modelId}…`);
    if (status0.running) await invoke("server_stop").catch(() => {});
    await invoke("server_start", { modelId, ctx: getServerCtx() });
    for (let i = 0; i < 90; i++) {
      if (abortRef.current?.signal.aborted) throw new Error("cancelled");
      await new Promise((r) => setTimeout(r, 1000));
      const s = await invoke<S>("server_status").catch(() => null);
      if (s?.running && s.port && s.model_id === modelId) return s.port;
    }
    throw new Error("the local model didn't come up — start it on the Server tab, then retry.");
  };

  // ---- the pipeline ----
  const generate = async () => {
    if (busy) return;
    if (sources.length === 0) { setStatus("Add at least one document or URL first."); return; }
    if (!modelId) { setStatus("Pick a model to generate the pairs."); return; }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    set("busy", true);
    set("pairs", []);
    set("savedPath", "");
    set("log", []);
    try {
      // 1. INGEST
      setStatus(`Extracting text from ${sources.length} source(s)…`);
      addLog(`Ingesting ${sources.length} source(s) (chunk ${chunkSize}/${chunkOverlap})…`);
      const manifest = JSON.stringify({
        sources: sources.map((s) => ({ type: s.kind, value: s.value })),
        chunkSize, chunkOverlap,
      });
      const resultJson = await invoke<string>("dataset_ingest", { manifestJson: manifest });
      if (ctrl.signal.aborted) throw new Error("cancelled");
      const result = JSON.parse(resultJson) as IngestResult;
      // Collect chunks (tagged with their source name) + report per source.
      const chunks: { text: string; source: string }[] = [];
      for (const src of result.sources) {
        const label = src.value.replace(/^.*[\\/]/, "");
        if (src.ok) { addLog(`✓ ${label} — ${src.chars.toLocaleString()} chars, ${src.chunks} chunk(s)`); for (const c of src.chunkList ?? []) chunks.push({ text: c, source: label }); }
        else addLog(`✗ ${label} — ${src.error ?? "failed"}`);
      }
      if (chunks.length === 0) { setStatus("No text could be extracted — check the sources (PDFs need readable text; some need 'pypdf')."); set("busy", false); abortRef.current = null; return; }
      const limited = maxChunks > 0 ? chunks.slice(0, maxChunks) : chunks;
      if (limited.length < chunks.length) addLog(`Capping at ${limited.length}/${chunks.length} chunks (max-chunks setting).`);

      // 2. GENERATE
      const port = await resolvePort();
      addLog(`Generating with ${modelId} — up to ${pairsPerChunk} pair(s) per chunk over ${limited.length} chunk(s).`);
      let made = 0;
      for (let i = 0; i < limited.length; i++) {
        if (ctrl.signal.aborted) throw new Error("cancelled");
        setStatus(`Generating pairs — chunk ${i + 1}/${limited.length} · ${made} pair(s) so far…`);
        let reply = "";
        try {
          reply = await streamChatCompletion(
            port, modelId, providerFor(modelId, models),
            GEN_SYSTEM, genUser(limited[i].text, pairsPerChunk),
            0.7, ctrl.signal,
            () => { /* no live stream — we parse the final reply */ },
          );
        } catch (e: unknown) {
          if (ctrl.signal.aborted) throw e;
          addLog(`⚠ chunk ${i + 1}: ${(e as { message?: string })?.message ?? e}`);
          continue;
        }
        const got = parsePairs(reply).map((p) => ({ ...p, source: limited[i].source }));
        if (got.length === 0) { addLog(`· chunk ${i + 1}: model returned no usable pairs`); continue; }
        made += got.length;
        set("pairs", (cur) => [...cur, ...got]);
      }
      setStatus(`Done — ${made} pair(s) from ${limited.length} chunk(s). Review below, then Save.`);
      addLog(`Finished: ${made} pair(s).`);
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message ?? String(e);
      if (msg === "cancelled" || ctrl.signal.aborted) { setStatus("Stopped."); addLog("Stopped by user."); }
      else { setStatus(`Failed: ${msg}`); addLog(`Failed: ${msg}`); }
    } finally {
      set("busy", false);
      abortRef.current = null;
    }
  };

  const stop = () => { abortRef.current?.abort(); };

  const removePair = (idx: number) => set("pairs", (cur) => cur.filter((_, i) => i !== idx));

  const saveDataset = async () => {
    if (pairs.length === 0) { setStatus("Nothing to save yet — generate pairs first."); return; }
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      let defaultDir = "";
      try { defaultDir = await invoke<string>("dataset_default_dir"); } catch { /* no default */ }
      const stamp = new Date().toISOString().slice(0, 10);
      const defPath = defaultDir ? `${defaultDir}/dataset_${stamp}.jsonl` : `dataset_${stamp}.jsonl`;
      const target = await save({ title: translateUiText("Save dataset (JSONL)"), defaultPath: defPath, filters: [{ name: "JSONL", extensions: ["jsonl"] }] });
      if (!target) return;
      const jsonl = pairs.map((p) => JSON.stringify({ instruction: p.instruction, output: p.output })).join("\n") + "\n";
      const written = await invoke<string>("dataset_save", { path: target, content: jsonl });
      set("savedPath", written);
      setStatus(`✓ Saved ${pairs.length} pair(s) → ${written}. Pick it on the Train page as your dataset.`);
      addLog(`Saved ${pairs.length} pair(s) to ${written}`);
    } catch (e) { setStatus(`Save failed: ${e}`); }
  };

  const okSources = sources.length;

  return (
    <div style={{ padding: "8px 10px 10px", height: "100%", display: "flex", flexDirection: "column", gap: 8, background: "var(--bg-panel)", color: "var(--fg)", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 16 }}>📚</span>
        <span style={{ fontWeight: 700, fontSize: 14, color: "var(--fg-strong)" }}>Dataset Builder</span>
        <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>documents + URLs → instruction/output JSONL</span>
      </div>

      {/* AI-assisted notice */}
      <div style={{ flexShrink: 0, fontSize: 11.5, lineHeight: 1.5, color: "#ffd97a", background: "rgba(255,217,122,0.08)", border: "1px solid rgba(255,217,122,0.30)", borderRadius: 8, padding: "7px 10px" }}>
        ⚠ <b>AI-assisted</b>: the pairs are written by the model you pick, from your sources. They can contain
        mistakes or hallucinations — review them below before training.
      </div>

      <div style={{ display: "flex", gap: 8, flex: 1, minHeight: 0 }}>
        {/* Left: sources + settings */}
        <div style={{ width: 340, flexShrink: 0, display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
          <div style={{ background: "var(--bg-input)", border: "1px solid var(--border-strong)", borderRadius: 8, padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-muted)", letterSpacing: 0.4 }}>SOURCES ({okSources})</div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={addFiles} disabled={busy} style={btn}>📄 Add documents…</button>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                value={urlDraft}
                onChange={(e) => set("urlDraft", e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addUrl(); } }}
                placeholder="Paste a URL and press Enter…"
                disabled={busy}
                style={{ flex: 1, minWidth: 0, ...inputStyle }}
              />
              <button onClick={addUrl} disabled={busy || !urlDraft.trim()} style={btn}>＋</button>
            </div>
            <div style={{ maxHeight: 150, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
              {sources.length === 0 ? (
                <div style={{ fontSize: 11.5, color: "var(--fg-subtle)", fontStyle: "italic", padding: "4px 2px" }}>PDF, DOCX, TXT, MD or web pages. They never leave your machine.</div>
              ) : sources.map((s) => (
                <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 6, padding: "3px 6px" }}>
                  <span>{s.kind === "url" ? "🌐" : "📄"}</span>
                  <span title={s.value} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                  <span onClick={() => !busy && removeSource(s.id)} title="Remove" style={{ cursor: busy ? "default" : "pointer", opacity: 0.6, fontSize: 13 }}>×</span>
                </div>
              ))}
            </div>
          </div>

          {/* Settings */}
          <div style={{ background: "var(--bg-input)", border: "1px solid var(--border-strong)", borderRadius: 8, padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-muted)", letterSpacing: 0.4 }}>GENERATION</div>
            <label style={rowStyle}><span>Model</span></label>
            <ModelPicker value={modelId} onChange={(id) => set("modelId", id)} models={models} status={accounts} disabled={busy} fallbackLabel="(pick a model)" />
            <label style={rowStyle}><span title="Max characters per chunk">Chunk size</span><input type="number" min={200} max={8000} value={chunkSize} disabled={busy} onChange={(e) => set("chunkSize", Math.max(200, +e.target.value || 1200))} style={numStyle} /></label>
            <label style={rowStyle}><span title="Characters carried between chunks">Overlap</span><input type="number" min={0} max={2000} value={chunkOverlap} disabled={busy} onChange={(e) => set("chunkOverlap", Math.max(0, +e.target.value || 0))} style={numStyle} /></label>
            <label style={rowStyle}><span title="How many pairs to ask the model for per chunk">Pairs / chunk</span><input type="number" min={1} max={10} value={pairsPerChunk} disabled={busy} onChange={(e) => set("pairsPerChunk", Math.min(10, Math.max(1, +e.target.value || 3)))} style={numStyle} /></label>
            <label style={rowStyle}><span title="Stop after this many chunks (0 = all). Useful to preview cost first.">Max chunks</span><input type="number" min={0} max={9999} value={maxChunks} disabled={busy} onChange={(e) => set("maxChunks", Math.max(0, +e.target.value || 0))} style={numStyle} /></label>
          </div>

          {/* Run */}
          <div style={{ display: "flex", gap: 6 }}>
            {busy ? (
              <button onClick={stop} style={{ ...btn, flex: 1, background: "rgba(180,60,60,0.85)", color: "#fff", border: "none", height: 38 }}>■ Stop</button>
            ) : (
              <button onClick={generate} disabled={sources.length === 0 || !modelId} style={{ ...btn, flex: 1, height: 38, background: "var(--accent)", color: "var(--accent-fg)", border: "none", fontWeight: 700, opacity: (sources.length && modelId) ? 1 : 0.5 }}>⚙ Generate dataset</button>
            )}
          </div>
          <LogBox lines={log} title="Dataset Builder log" height={120} placeholder="Extraction + generation progress appears here." />
        </div>

        {/* Right: generated pairs */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6, minHeight: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 700 }}>Generated pairs <span style={{ color: "var(--fg-muted)", fontWeight: 400 }}>({pairs.length})</span></span>
            <div style={{ flex: 1 }} />
            <button onClick={saveDataset} disabled={pairs.length === 0} style={{ ...btn, opacity: pairs.length ? 1 : 0.5 }}>💾 Save JSONL…</button>
          </div>
          {savedPath ? (
            <div style={{ flexShrink: 0, fontSize: 11.5, color: "#7ff0c5", background: "rgba(127,240,197,0.08)", border: "1px solid rgba(127,240,197,0.30)", borderRadius: 6, padding: "5px 8px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={savedPath}>✓ Saved → {savedPath} — open the Train page and pick it as your dataset.</div>
          ) : null}
          <div className="selectable-chat" style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, padding: 8, background: "var(--bg-input)", border: "1px solid var(--border-strong)", borderRadius: 8 }}>
            {pairs.length === 0 ? (
              <div style={{ margin: "auto", textAlign: "center", color: "var(--fg-muted)", fontSize: 13, maxWidth: 460, lineHeight: 1.6 }}>
                <div style={{ fontSize: 30, marginBottom: 8 }}>📚</div>
                Add your documents/URLs on the left, choose a model, and click <b>Generate dataset</b>.<br />
                <span style={{ fontSize: 12 }}>Each generated instruction/output pair will appear here for review.</span>
              </div>
            ) : pairs.map((p, i) => (
              <div key={i} style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "7px 9px", fontSize: 12.5, lineHeight: 1.5 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "#7aa2ff" }}>INSTRUCTION</span>
                  {p.source ? <span style={{ fontSize: 10, color: "var(--fg-subtle)" }}>· {p.source}</span> : null}
                  <div style={{ flex: 1 }} />
                  <span onClick={() => removePair(i)} title="Drop this pair" style={{ cursor: "pointer", opacity: 0.5, fontSize: 13 }}>×</span>
                </div>
                <div style={{ whiteSpace: "pre-wrap", marginBottom: 5 }}>{p.instruction}</div>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#7ff0c5" }}>OUTPUT</div>
                <div style={{ whiteSpace: "pre-wrap", color: "var(--fg)" }}>{p.output}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Status */}
      <div style={{ flexShrink: 0, fontSize: 11.5, color: "var(--fg-muted)", whiteSpace: "pre-line" }}>{status}</div>
    </div>
  );
}

const btn: CSSProperties = {
  height: 30, padding: "0 10px", borderRadius: 6, border: "1px solid var(--border-strong)",
  background: "var(--bg-surface)", color: "var(--fg)", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
};
const inputStyle: CSSProperties = {
  height: 30, padding: "0 8px", borderRadius: 6, border: "1px solid var(--border-strong)",
  background: "var(--bg-surface)", color: "var(--fg)", fontSize: 12, boxSizing: "border-box",
};
const rowStyle: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 12, color: "var(--fg-muted)" };
const numStyle: CSSProperties = { width: 80, ...inputStyle, textAlign: "right" };
