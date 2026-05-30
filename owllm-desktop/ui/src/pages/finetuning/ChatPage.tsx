// ChatPage — multi-column chat surface, port of Qt _build_test_sub_tab
// (LLM/desktop_app/main.py:18399).
//
// Layout:
//   ┌──────────────────────────────────────────────────────────────┐
//   │ Number of chats: ☐1 ☑2 ☐3  · 🔄 Models talk     ⚙ params │
//   ├──────────────────────────────────────────────────────────────┤
//   │ 🔵 Model A    │ 🟢 Model B    │ 🟣 Model C  (when 3 active)  │
//   │ system: ...   │ system: ...   │ system: ...                 │
//   │ [transcript]  │ [transcript]  │ [transcript]                │
//   └──────────────────────────────────────────────────────────────┤
//   │ [draft textarea]              [▶ Send to all]               │
//   └──────────────────────────────────────────────────────────────┘
//
// All columns target the currently-running server (single-slot
// backend). Each column has its own system prompt + temperature so the
// user can A/B compare prompt or sampling variations of the same model
// — useful even when only one server is up. When the backend lands
// multi-server support, swap each column to its own port without
// changing this file's structure.
//
// "Models talk to each other" (M2M) takes columns A and B, alternates
// who speaks, feeds each model's output to the other as the next user
// message, until max_turns or Stop.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ModelPicker, { type ModelInfo as PickerModelInfo, type AccountsStatusLite } from "../agentic/ModelPicker";
// Tool-use loop, always-on. sendOne() appends the same XML <tool_call>
// catalog the Agentic Team page uses, then parses each streamed reply
// for tool_call blocks and runs them against agent_tools.rs. Shared
// with AgentsPage so the protocol is identical and a user who
// experiments in Chat can paste prompts that work the same way in the
// Agentic team.
import {
  formatToolsForPrompt,
  parseToolCalls,
  executeToolCall,
  renderToolResultsForModel,
  stripFabricatedToolOutput,
  type ToolExecResult,
} from "../agentic/localTools";

const LS_KEY = "owllm:chat:v3";

// Per-column identity colors — A=blue, B=green, C=purple. Used by
// the Model card header gradient, the A/B/C settings-tab button row,
// the settings panel background (60% alpha tint), and the sender
// label colour inside transcripts.
// Softer per-column gradients — desaturated mid-tone variants of the
// original A=blue / B=green / C=purple palette so the headers no
// longer scream against the dark chat body.
const COLUMN_GRADIENT: Record<"A" | "B" | "C", string> = {
  A: "linear-gradient(90deg, #3d4f8c, #2d3b6b)",
  B: "linear-gradient(90deg, #3d7a5a, #2b5c44)",
  C: "linear-gradient(90deg, #6b3d8c, #4f2a6b)",
};

const PANEL_TINT: Record<"A" | "B" | "C", string> = {
  A: "rgba(0, 100, 200, 0.6)",
  B: "rgba(0, 200, 100, 0.6)",
  C: "rgba(155, 89, 182, 0.6)",
};

const LABEL_TINT: Record<"A" | "B" | "C", string> = {
  A: "var(--accent)",
  B: "#22c55e",
  C: "#9C27B0",
};

type ServerStatus = {
  running: boolean;
  model_id: string | null;
  port: number | null;
  message: string;
};

type ModelInfo = PickerModelInfo;

type Role = "user" | "assistant" | "system";
type ChatMsg = {
  role: Role;
  content: string;
  /// Qwen 3 / DeepSeek-R1 / o-series reasoning text. Routed here
  /// instead of into `content` so the wall of "Let me think… Actually
  /// let me reconsider…" doesn't dump into the visible chat. Rendered
  /// as a collapsible '💭 Thinking' block above the answer, default
  /// collapsed.
  thinking?: string;
};

// One side-by-side column. Each carries its own system prompt and
// sampling params so the user can A/B without leaving the page.
type Column = {
  id: "A" | "B" | "C";
  emoji: string;            // 🔵 🟢 🟣
  selectedModel: string;    // per-column model_id from list_models
  system: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  repetitionPenalty: number;
  messages: ChatMsg[];
  busy: boolean;
  error: string | null;
};

const DEFAULT_COL = (id: "A" | "B" | "C"): Column => {
  const emojis = { A: "🔵", B: "🟢", C: "🟣" } as const;
  return {
    id,
    emoji: emojis[id],
    selectedModel: "",
    system: "",
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 1024,
    repetitionPenalty: 1.0,
    messages: [],
    busy: false,
    error: null,
  };
};

const TEMPLATES: Array<{ key: string; label: string; system: string }> = [
  { key: "helpful",   label: "🤖 Helpful assistant",  system: "You are a helpful AI assistant. Answer directly and concisely." },
  { key: "coder",     label: "💻 Coding assistant",    system: "You are an expert software engineer. Provide working code, brief explanations, and call out edge cases." },
  { key: "tutor",     label: "🎓 Patient tutor",       system: "You are a patient tutor. Break concepts into small steps, check understanding." },
  { key: "analyst",   label: "📊 Data analyst",        system: "You are a data analyst. Reason from the data the user shares. Show your assumptions." },
  { key: "writer",    label: "✍ Writing partner",      system: "You are a writing partner. Improve clarity, flow, and tone while preserving the user's voice." },
  { key: "translator",label: "🌐 Translator",          system: "You translate accurately between languages the user specifies, preserving register and meaning." },
  { key: "custom",    label: "✏ Custom",               system: "" },
];

type Persisted = {
  count: 1 | 2 | 3;
  columns: Column[];
  converse: boolean;
  maxTurns: number;
};

function loadState(): Partial<Persisted> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch { return {}; }
}
function saveState(s: Persisted) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export default function ChatPage() {
  const persisted = loadState();
  const [status, setStatus] = useState<ServerStatus>({
    running: false, model_id: null, port: null, message: "",
  });
  const [count, setCount] = useState<1 | 2 | 3>(persisted.count ?? 2);
  const [columns, setColumns] = useState<Column[]>(
    persisted.columns ?? [DEFAULT_COL("A"), DEFAULT_COL("B"), DEFAULT_COL("C")]
  );
  const [draft, setDraft] = useState("");
  const [converse, setConverse] = useState<boolean>(persisted.converse ?? false);
  const [maxTurns, setMaxTurns] = useState<number>(persisted.maxTurns ?? 20);
  // Right-side settings panel — Qt main.py:18667-18690 ships a
  // QStackedWidget driven by A/B/C toggle buttons. We mirror that
  // here so a single set of System Prompt / Generation Params
  // controls reconfigures whichever column is currently selected.
  const [activePanel, setActivePanel] = useState<"A" | "B" | "C">("A");
  const [rightTab, setRightTab] = useState<"logs" | "unfiltered">("logs");
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [accountsStatus, setAccountsStatus] = useState<AccountsStatusLite | null>(null);
  const abortersRef = useRef<Map<"A" | "B" | "C", AbortController>>(new Map());
  // Active SSE readers per column. stopAll cancels both the abort
  // controller AND these readers — WebView2 doesn't always wake the
  // reader from a signal-only abort, so we force-cancel from the
  // outside to make the Stop button actually stop the model.
  const readersRef = useRef<Map<"A" | "B" | "C", ReadableStreamDefaultReader<Uint8Array>>>(new Map());
  const transcriptRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const m2mRunningRef = useRef(false);

  // Persist on meaningful change.
  useEffect(() => {
    saveState({ count, columns, converse, maxTurns });
  }, [count, columns, converse, maxTurns]);

  // Poll server status every 2 s.
  useEffect(() => {
    let dead = false;
    const tick = async () => {
      try {
        const s = await invoke<ServerStatus>("server_status");
        if (!dead) setStatus(s);
      } catch { /* keep last */ }
    };
    tick();
    const id = window.setInterval(tick, 2000);
    return () => { dead = true; window.clearInterval(id); };
  }, []);

  // Load READY models + accounts status for the per-column pickers.
  // Same source the Agents page uses so the dropdown stays identical.
  // Also re-fetch on window focus + owllm:models:refresh so models
  // downloaded after the page mounted appear without an app restart
  // (the user reported only 4 of ~14 downloaded models showing up
  // because list_models only ran once at mount).
  useEffect(() => {
    let dead = false;
    const reloadModels = () => {
      invoke<ModelInfo[]>("list_models")
        .then((m) => {
          if (dead) return;
          const arr = Array.isArray(m) ? m : [];
          console.log(`[ChatPage] list_models → ${arr.length} entries`,
            arr.map(x => `${x.model_id}(${x.provider}${x.port == null ? ":no-port" : ""})`).join(", "));
          setAvailableModels(arr);
        })
        .catch(() => { /* leave empty */ });
    };
    reloadModels();
    invoke<AccountsStatusLite>("accounts_status")
      .then((s) => { if (!dead) setAccountsStatus(s); })
      .catch(() => { /* leave null */ });
    const onFocus = () => reloadModels();
    const onRefresh = () => reloadModels();
    window.addEventListener("focus", onFocus);
    window.addEventListener("owllm:models:refresh", onRefresh as EventListener);
    return () => {
      dead = true;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("owllm:models:refresh", onRefresh as EventListener);
    };
  }, []);

  // Lazy server-start state. The local llama-server is no longer
  // pre-launched when this page opens or column A's model changes —
  // sendOne() starts it on the FIRST send instead, so just browsing
  // the Chat tab doesn't spin a 7-14 B model into VRAM the user
  // never asked for.
  const [autoStarting, setAutoStarting] = useState<string | null>(null);

  // Start the llama-server for `wanted` and resolve once it's actually
  // serving that model. The 503-poll loop in sendOne handles the
  // "still loading weights" wait — this just kicks the spawn and
  // updates the local autoStarting flag for any UI that cares.
  async function ensureLocalServer(wanted: string): Promise<boolean> {
    if (status.running && status.model_id === wanted) return true;
    setAutoStarting(wanted);
    try {
      if (status.running) await invoke("server_stop").catch(() => {});
      await invoke("server_start", { modelId: wanted });
      return true;
    } catch (e) {
      updateCol("A", { error: `Failed to start server: ${e}` });
      return false;
    } finally {
      setAutoStarting(null);
    }
  }

  // Auto-scroll each column's transcript when new tokens land.
  useEffect(() => {
    for (const col of columns) {
      const el = transcriptRefs.current[col.id];
      if (!el) continue;
      // Always auto-scroll to bottom. ONLY skip while the user is
      // mid-selection inside this transcript — the unconditional
      // scrollTop jump used to break text highlighting.
      const sel = window.getSelection?.();
      if (sel && !sel.isCollapsed && el.contains(sel.anchorNode)) continue;
      el.scrollTop = el.scrollHeight;
    }
  }, [columns]);

  const updateCol = (id: "A" | "B" | "C", patch: Partial<Column>) =>
    setColumns((curr) => curr.map((c) => c.id === id ? { ...c, ...patch } : c));

  const appendAssistant = (id: "A" | "B" | "C", delta: string) =>
    setColumns((curr) => curr.map((c) => {
      if (c.id !== id) return c;
      const out = c.messages.slice();
      const last = out[out.length - 1];
      if (last && last.role === "assistant") {
        // Live-strip the native <|tool_call> / <|tool_response>
        // garbage many small models hallucinate. Strip applied to
        // the WHOLE accumulated text so partial blocks already
        // shown get retroactively removed once their close marker
        // arrives. Same pattern as the AgentsPage dispatch.
        const raw = last.content + delta;
        const cleaned = stripFabricatedToolOutput(raw);
        const newContent = raw.endsWith(" ") && !cleaned.endsWith(" ") ? cleaned + " " : cleaned;
        out[out.length - 1] = { ...last, content: newContent };
      }
      return { ...c, messages: out };
    }));
  /// Stream reasoning tokens into the LAST assistant message's
  /// `thinking` field. Rendered as a collapsible "💭 Thinking"
  /// block above the visible answer instead of dumping the wall
  /// of Qwen-3 'let me reconsider' into the chat.
  const appendThinking = (id: "A" | "B" | "C", delta: string) =>
    setColumns((curr) => curr.map((c) => {
      if (c.id !== id) return c;
      const out = c.messages.slice();
      const last = out[out.length - 1];
      if (last && last.role === "assistant") {
        out[out.length - 1] = { ...last, thinking: (last.thinking ?? "") + delta };
      }
      return { ...c, messages: out };
    }));

  // Quick check: did the user hit Stop on this column while we were
  // waiting for the server to come up? Read the aborter ref so the
  // boot poll exits cleanly.
  function ctrlAborted(id: "A" | "B" | "C"): boolean {
    const c = abortersRef.current.get(id);
    return !!c && c.signal.aborted;
  }

  // Send the same user text to one column. Returns the assistant
  // reply when the stream completes (used by the M2M loop).
  async function sendOne(col: Column, userText: string): Promise<string> {
    // Lazy server start. If the user picked a servable local/tuned
    // model on this column (or column A as the driver), spawn the
    // server now — first send is what kicks the load. The 503 retry
    // loop below then waits through the weights mapping. We track
    // port locally because the 3 s server_status poll hasn't fired
    // yet right after server_start — the stale `status.port` would
    // give 'Failed to fetch' against http://127.0.0.1:undefined.
    // Resolve which model the column wants. Priority:
    //   1. Column's own pick.
    //   2. Column A's pick (the "driver" column).
    //   3. Whatever the local server is already running (so a fresh
    //      column still works if the server is up from another column
    //      or the Server tab).
    //   4. First servable local/tuned model in the registry — auto-
    //      pick so the user can just hit Send on a fresh column
    //      without manually picking from the dropdown.
    const driver = columns[0];
    const isServableProvider = (p: string | undefined) =>
      p === "local" || p === "tuned";
    const runningLocalId = (status.running
      && status.model_id
      && isServableProvider(availableModels.find(x => x.model_id === status.model_id)?.provider))
      ? status.model_id
      : "";
    const fallbackLocalId = availableModels
      .find(m => isServableProvider(m.provider) && m.port != null)?.model_id ?? "";
    const wantedModelId = (
      col.selectedModel
      || driver?.selectedModel
      || runningLocalId
      || fallbackLocalId
      || ""
    ).trim();
    let activePort: number | null = status.port;
    if (wantedModelId) {
      const m = availableModels.find((x) => x.model_id === wantedModelId);
      const isServable = !!m && isServableProvider(m.provider) && m.port != null;
      const alreadyRight = status.running && status.model_id === wantedModelId;
      if (isServable && !alreadyRight) {
        updateCol(col.id, { error: `⏳ Starting server (${wantedModelId})…`, busy: true });
        const ok = await ensureLocalServer(wantedModelId);
        if (!ok) {
          updateCol(col.id, { busy: false });
          return "";
        }
        // Pull a fresh status so we have a real port BEFORE the POST.
        // Server may report running=true with the new port within a
        // few hundred ms even though weights are still mapping (the
        // 503 loop handles that part).
        for (let i = 0; i < 30; i++) {
          try {
            const s = await invoke<typeof status>("server_status");
            setStatus(s);
            if (s.running && s.port && s.model_id === wantedModelId) {
              activePort = s.port;
              break;
            }
          } catch {
            // ignore, retry
          }
          if (ctrlAborted(col.id)) return "";
          await new Promise((r) => setTimeout(r, 400));
        }
        if (!activePort) {
          updateCol(col.id, { error: "Server start timed out — check the Server tab logs.", busy: false });
          return "";
        }
      }
    }
    if (!activePort) {
      updateCol(col.id, { error: "No server running and no servable model picked. Pick a local/tuned model first." });
      return "";
    }
    const userMsg: ChatMsg = { role: "user", content: userText };
    const next = [...col.messages, userMsg];
    updateCol(col.id, {
      messages: [...next, { role: "assistant", content: "" }],
      busy: true, error: null,
    });

    const ctrl = new AbortController();
    abortersRef.current.set(col.id, ctrl);

    // Tools are always-on. System prompt gets the XML <tool_call>
    // catalog so the model knows how to invoke read_file / shell /
    // write_file etc. Loop runs up to 8 turns: stream a reply, parse
    // tool_calls, execute each, fold results back as a synthetic user
    // turn, re-stream. Loop ends when the model emits a turn with no
    // tool_call blocks — that's the final answer.
    const toolsBlock = await formatToolsForPrompt();
    const augmentedSystem = toolsBlock ? `${toolsBlock}\n\n${col.system}` : col.system;
    const liveMessages: Array<{ role: string; content: string }> = [
      { role: "system", content: augmentedSystem },
      ...next.map((m) => ({ role: m.role, content: m.content })),
    ];
    // 4 turns is plenty — small local models that don't actually
    // know the tool protocol will loop emitting fake calls + fake
    // outputs forever otherwise. Caps the runaway. The user can
    // raise it via the maxTurns control if they're running a real
    // tool-trained model that needs more legs.
    const MAX_TOOL_TURNS = 4;

    let reply = "";
    try {
      for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");

        const payload = {
          model: status.model_id ?? "local",
          messages: liveMessages,
          stream: true,
          temperature: col.temperature,
          top_p: col.topP,
          max_tokens: col.maxTokens,
        };

        // llama-server returns HTTP 503
        //   {"error":{"message":"Loading model","type":"unavailable_error","code":503}}
        // while it's still loading weights. A 29 GB f16 model can take
        // 60+ s to mmap + offload, so polling /health (or just retrying)
        // is the only way to know it's ready. Loop with 1.5 s backoff
        // for up to 180 s, surfacing a "Loading model" status to the
        // column so the user sees progress instead of one cryptic error.
        let resp: Response | null = null;
        const startedAt = Date.now();
        const READY_TIMEOUT_MS = 180_000;
        const PER_ATTEMPT_TIMEOUT_MS = 20_000;
        while (true) {
          if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");
          // Per-attempt timeout. If llama-server accepts the TCP
          // connection but never replies (we've seen this when the
          // GGUF is broken / not actually loading), a vanilla fetch
          // hangs forever and the elapsedSec counter never ticks
          // past 1 s — which is exactly what the user reported.
          // Race the fetch against a 20 s clock; on timeout we abort
          // that single attempt and re-enter the retry loop so the
          // status text + abort button stay responsive.
          const attemptCtrl = new AbortController();
          const tid = setTimeout(() => attemptCtrl.abort(), PER_ATTEMPT_TIMEOUT_MS);
          const onOuterAbort = () => attemptCtrl.abort();
          ctrl.signal.addEventListener("abort", onOuterAbort);
          try {
            resp = await fetch(`http://127.0.0.1:${activePort}/v1/chat/completions`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
              signal: attemptCtrl.signal,
            });
          } catch (e: any) {
            clearTimeout(tid);
            ctrl.signal.removeEventListener("abort", onOuterAbort);
            // Outer abort (user pressed Stop) — surface as-is.
            if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");
            const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
            updateCol(col.id, {
              error: `⏳ Waiting for llama-server to respond (no reply in ${PER_ATTEMPT_TIMEOUT_MS / 1000}s)… ${elapsedSec}s — check the Server tab logs.`,
            });
            if (Date.now() - startedAt > READY_TIMEOUT_MS) {
              throw new Error(`llama-server unresponsive for ${READY_TIMEOUT_MS / 1000}s — check the Server tab. Common causes: broken GGUF, GPU OOM, missing -ngl support.`);
            }
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          clearTimeout(tid);
          ctrl.signal.removeEventListener("abort", onOuterAbort);
          if (resp.status === 503) {
            // Drain + inspect the error body so an unexpected 503 (not
            // the loading one) doesn't get swallowed.
            const txt = await resp.text().catch(() => "");
            const isLoading = /loading model/i.test(txt) || /unavailable_error/i.test(txt);
            if (!isLoading) {
              throw new Error(txt || "HTTP 503");
            }
            const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
            updateCol(col.id, { error: `⏳ Loading model into VRAM… ${elapsedSec}s` });
            if (Date.now() - startedAt > READY_TIMEOUT_MS) {
              throw new Error("Model still loading after 3 minutes — likely OOM. Try a smaller quant (Q4_K_M).");
            }
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          break;
        }
        // Got past 503 — clear the loading banner and parse the stream.
        updateCol(col.id, { error: null });
        if (!resp.ok || !resp.body) {
          throw new Error(await resp.text().catch(() => `HTTP ${resp.status}`));
        }
        const reader = resp.body.getReader();
        // Register the reader so stopAll can force-cancel it. fetch
        // signal abort alone is not reliable in WebView2 — sometimes
        // the in-flight reader.read() never rejects. Cancelling the
        // reader from the outside breaks the stream synchronously.
        readersRef.current.set(col.id, reader);
        const dec = new TextDecoder();
        let turnReply = "";
        let buffer = "";
        // Track <think>…</think> state across deltas so we can ROUTE
        // reasoning into the 💭 channel even when the model wraps it
        // in tags inside `content` instead of using `reasoning_content`.
        let inThink = false;
        let serverError: string | null = null;
        while (true) {
          // Honor the abort flag inline — the user pressed Stop and
          // we should bail out of the read loop even if reader.read()
          // hasn't seen the abort yet.
          if (ctrl.signal.aborted) {
            try { await reader.cancel(); } catch {}
            throw new DOMException("Aborted", "AbortError");
          }
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch (e: any) {
            if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");
            throw e;
          }
          if (chunk.done) break;
          buffer += dec.decode(chunk.value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).replace(/\r$/, "");
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const body = line.slice(5).trim();
            if (!body || body === "[DONE]") continue;
            try {
              const j = JSON.parse(body);
              if (j?.error) {
                serverError = typeof j.error === "string"
                  ? j.error
                  : (j.error?.message || JSON.stringify(j.error));
                continue;
              }
              const deltaObj = j?.choices?.[0]?.delta;
              const reasoning: string | undefined = deltaObj?.reasoning_content ?? deltaObj?.reasoning;
              if (typeof reasoning === "string" && reasoning) {
                // Route reasoning to the SEPARATE thinking buffer
                // (collapsed by default in the UI). Do NOT mix into
                // turnReply — keeps the visible chat clean AND
                // keeps parseToolCalls from misreading reasoning as
                // a tool block.
                appendThinking(col.id, reasoning);
              }
              const delta = deltaObj?.content;
              if (typeof delta === "string" && delta) {
                // Split <think>…</think>: inside-tag goes to the
                // collapsed thinking buffer, outside-tag is the
                // visible answer. State machine survives chunk
                // boundaries via `inThink` declared above the loop.
                let buf = delta;
                while (buf.length > 0) {
                  if (inThink) {
                    const close = buf.indexOf("</think>");
                    const thoughtPart = close < 0 ? buf : buf.slice(0, close);
                    if (thoughtPart) appendThinking(col.id, thoughtPart);
                    if (close < 0) break;
                    inThink = false;
                    buf = buf.slice(close + "</think>".length);
                  } else {
                    const open = buf.indexOf("<think>");
                    const visiblePart = open < 0 ? buf : buf.slice(0, open);
                    if (visiblePart) {
                      turnReply += visiblePart; reply += visiblePart;
                      appendAssistant(col.id, visiblePart);
                    }
                    if (open < 0) break;
                    inThink = true;
                    buf = buf.slice(open + "<think>".length);
                  }
                }
              }
            } catch { /* skip malformed */ }
          }
        }
        readersRef.current.delete(col.id);
        if (serverError) {
          throw new Error(`llama-server stream error: ${serverError}`);
        }

        // Plain chat mode → one shot, done.
        if (!toolsBlock) break;
        const calls = parseToolCalls(turnReply);
        // Model produced no tool calls → that turn IS the final answer.
        if (calls.length === 0) break;

        // Execute every call sequentially so each result lands in
        // context before the next tool runs (matches AgentsPage +
        // legacy Python loop).
        const results: ToolExecResult[] = [];
        for (const c of calls) {
          if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");
          // Surface the tool call inline in the chat so the user sees
          // what the model's doing (formatted as a system message).
          const argLine = Object.entries(c.args)
            .map(([k, v]) => `${k}=${String(v).slice(0, 80).replace(/\n/g, " ")}`)
            .join(", ");
          appendAssistant(col.id, `\n\n🛠 ${c.name}(${argLine})\n`);
          // eslint-disable-next-line no-await-in-loop
          const r = await executeToolCall(c, "");
          results.push(r);
          const outSnippet = r.output.slice(0, 240) + (r.output.length > 240 ? "…" : "");
          appendAssistant(col.id, `${r.ok ? "✓" : "✗"} ${outSnippet}\n\n`);
        }
        // Append the assistant turn + synthetic user turn carrying
        // the tool results, then iterate.
        liveMessages.push({ role: "assistant", content: turnReply });
        liveMessages.push({ role: "user", content: renderToolResultsForModel(calls, results) });
      }
    } catch (e: unknown) {
      const err = e as { name?: string; message?: string };
      if (err.name !== "AbortError") {
        updateCol(col.id, { error: String(err.message ?? e) });
      }
    } finally {
      updateCol(col.id, { busy: false });
      abortersRef.current.delete(col.id);
    }
    return reply;
  }

  async function sendAll() {
    setColumns((curr) => curr.map((c) => ({ ...c, error: null })));
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (converse && count >= 2) {
      // Start the M2M loop instead of broadcasting to all columns.
      void runConverse(text);
      return;
    }
    const active = columns.slice(0, count);
    // Fire all columns concurrently. We snapshot the current
    // columns array (not state-after-setColumns) so each parallel call
    // starts from the same baseline.
    await Promise.all(active.map((c) => sendOne(c, text)));
  }

  // M2M: alternate A and B. C is ignored even when count===3 because
  // the legacy Qt M2M only used the first two columns.
  async function runConverse(opening: string) {
    if (m2mRunningRef.current) return;
    m2mRunningRef.current = true;
    let speaker: "A" | "B" = "A";
    let lastReply = opening;
    let turns = 0;
    while (turns < maxTurns && m2mRunningRef.current) {
      const col = columns.find((c) => c.id === speaker);
      if (!col) break;
      const reply = await sendOne(col, lastReply);
      if (!reply) break;
      lastReply = reply;
      speaker = speaker === "A" ? "B" : "A";
      turns += 1;
    }
    m2mRunningRef.current = false;
  }

  function stopAll() {
    m2mRunningRef.current = false;
    // Abort the controllers AND cancel any in-flight stream readers.
    // Belt-and-suspenders so the Stop button truly stops the model
    // even when WebView2 swallows the abort signal.
    for (const a of abortersRef.current.values()) {
      try { a.abort(); } catch {}
    }
    for (const r of readersRef.current.values()) {
      try { r.cancel("stopAll"); } catch {}
    }
    abortersRef.current.clear();
    readersRef.current.clear();
    setColumns((curr) => curr.map((c) => ({ ...c, busy: false })));
  }

  function resetAll() {
    stopAll();
    setColumns((curr) => curr.map((c) => ({ ...c, messages: [], error: null })));
  }

  function applyTemplate(colId: "A" | "B" | "C", key: string) {
    const t = TEMPLATES.find((x) => x.key === key);
    if (!t || key === "custom") return;
    updateCol(colId, { system: t.system });
  }

  function saveJson() {
    const blob = new Blob(
      [JSON.stringify({ count, columns, converse, maxTurns }, null, 2)],
      { type: "application/json" }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `owllm-chat-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const anyBusy = columns.some((c) => c.busy);

  return (
    <div style={{
      padding: "14px 18px",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      gap: 10,
      background: "var(--bg-panel)",
      color: "var(--fg)",
      minHeight: 0,
    }}>
      {/* Header — Qt main.py:18414-18418 explicitly drops the page
          title; the title_row starts directly with 'Number of chats:'. */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 16, color: "var(--fg-muted)" }}>
          <span>Number of chats:</span>
          {[1, 2, 3].map((n) => (
            <label key={n} style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              padding: "0 4px",
              cursor: "pointer",
              fontWeight: count === n ? 700 : 400,
              color: count === n ? "var(--fg)" : "var(--fg-muted)",
            }}>
              <input
                type="checkbox"
                checked={count === n}
                onChange={() => setCount(n as 1 | 2 | 3)}
                style={{ margin: 0 }}
              />
              {n}
            </label>
          ))}
        </div>

        <label style={{
          display: "inline-flex", alignItems: "center", gap: 4,
          fontSize: 14, color: count < 2 ? "#555" : "var(--fg-muted)",
          opacity: count < 2 ? 0.5 : 1,
        }}>
          <input
            type="checkbox"
            checked={converse}
            disabled={count < 2}
            onChange={(e) => setConverse(e.target.checked)}
          />
          🔄 Models talk to each other
        </label>
        {converse && (
          <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 16, color: "var(--fg-muted)" }}>
            Max turns:
            <input
              type="number"
              value={maxTurns}
              min={1}
              max={200}
              onChange={(e) => setMaxTurns(Number(e.target.value) || 1)}
              style={{
                width: 60, padding: "2px 6px",
                background: "var(--bg-input)", border: "1px solid var(--border-strong)",
                borderRadius: 4, color: "var(--fg)", fontSize: 16,
              }}
            />
          </label>
        )}

        {/* Server status + Save/Load/Clear were here in an earlier
            iteration; Qt main.py:18414-18503 keeps the title row
            uncluttered (chat-count + Models-talk + Max-turns only) and
            relies on the global ModeBar SysInfoBlock for server state.
            Save/Clear sit in the vertical button column under the
            composer; Qt has no Load button so we dropped it. */}
        <div style={{ flex: 1 }} />
      </div>

      {/* Body — Qt main.py:_build_test_sub_tab splits the chat into a
          LEFT widget (columns grid + composer) and a RIGHT widget
          (~540px settings/templates/logs stack). Mirror that here. */}
      <div style={{ display: "flex", gap: 12, flex: 1, minHeight: 0 }}>
        {/* LEFT: columns grid + composer */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10, minWidth: 0, minHeight: 0 }}>
          {/* Columns row */}
          <div style={{
            display: "grid",
            gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`,
            gap: 6,
            flex: 1,
            minHeight: 0,
          }}>
            {columns.slice(0, count).map((col) => (
              <div key={col.id} style={{
                display: "flex", flexDirection: "column",
                background: "var(--bg-card)",
                border: "1px solid var(--border-strong)",
                borderRadius: 8,
                minHeight: 0,
                overflow: "hidden",
              }}>
                {/* Column header — per-column identity gradient
                    (A=blue, B=green, C=purple). */}
                <div style={{
                  padding: 10,
                  background: COLUMN_GRADIENT[col.id],
                  borderRadius: 6,
                  display: "flex", alignItems: "center", gap: 6,
                  color: "#fff",
                }}>
                  <span style={{ fontSize: 16, fontWeight: 700 }}>
                    {col.emoji} Model {col.id}
                  </span>
                  <span style={{ fontSize: 16, color: "#000" }}>
                    (Port: {status.port ?? "-"})
                  </span>
                </div>

                {/* Per-column model selector — Qt main.py:18548-18557
                    adds a QComboBox (READY models from the Models tab)
                    immediately under each header. */}
                <div style={{ padding: "6px 0 0 0", display: "flex" }}>
                  <ModelPicker
                    value={col.selectedModel}
                    onChange={(id) => updateCol(col.id, { selectedModel: id })}
                    models={availableModels as PickerModelInfo[]}
                    status={accountsStatus}
                    fallbackLabel="— Select model —"
                  />
                </div>

                {/* Transcript */}
                <div
                  ref={(el) => { transcriptRefs.current[col.id] = el; }}
                  style={{
                    flex: 1, overflowY: "auto", minHeight: 0,
                    padding: 12, marginTop: 6,
                    display: "flex", flexDirection: "column", gap: 10,
                    fontSize: 13, lineHeight: 1.5,
                    background: "var(--bg-input)",
                    borderRadius: 6,
                  }}
                >
                  {col.messages.length === 0 ? (
                    <div style={{ fontSize: 11, color: "#7a7f87" }}>
                      {status.running
                        ? "Send a message below — this column will reply."
                        : autoStarting
                          ? `Starting server (${autoStarting})…`
                          : col.selectedModel
                            ? "Selected — server will start when you pick model A."
                            : "Pick a model above to start a server."}
                    </div>
                  ) : col.messages.map((m, i) => (
                    <div key={i} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <div style={{
                        fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
                        color: m.role === "user" ? "#7aa2ff" : LABEL_TINT[col.id],
                      }}>
                        {m.role === "user" ? "YOU" : `MODEL ${col.id}`}
                      </div>
                      {m.thinking && m.thinking.trim() && (
                        <details style={{
                          background: "rgba(192,138,255,0.06)",
                          border: "1px solid rgba(192,138,255,0.25)",
                          borderRadius: 6,
                          padding: "4px 8px",
                          marginBottom: 4,
                          fontSize: 11,
                          color: "var(--fg-muted)",
                        }}>
                          <summary style={{ cursor: "pointer", userSelect: "none", fontWeight: 600, color: "#c08aff" }}>
                            💭 Thinking ({m.thinking.length.toLocaleString()} chars)
                          </summary>
                          <div style={{ whiteSpace: "pre-wrap", marginTop: 4, fontFamily: "Consolas, monospace", fontSize: 10.5, lineHeight: 1.5 }}>
                            {m.thinking}
                          </div>
                        </details>
                      )}
                      <div style={{ whiteSpace: "pre-wrap", color: "var(--fg)" }}>
                        {m.content || (col.busy && i === col.messages.length - 1 ? "▍" : "")}
                      </div>
                    </div>
                  ))}
                  {col.error && (
                    <div style={{
                      border: "1px solid #ff9f9f",
                      background: "rgba(255,80,80,0.10)",
                      color: "#ffb0b0",
                      borderRadius: 6, padding: 8, fontSize: 11,
                    }}>{col.error}</div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Composer label — Qt main.py:18615 prompt_label */}
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg-strong)" }}>
            💬 Type your message:
          </div>

          {/* Composer row — textarea + vertical Send/Clear/Save stack
              (Qt main.py:18632-18657 btn_column). */}
          <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !anyBusy) {
                  e.preventDefault();
                  sendAll();
                }
              }}
              placeholder="Type your message here..."
              style={{
                flex: 1, minHeight: 90, maxHeight: 90,
                resize: "none",
                padding: 10, borderRadius: 8,
                background: "var(--bg-input)",
                color: "var(--fg)",
                border: "1px solid var(--border-strong)",
                fontFamily: "inherit", fontSize: 13, lineHeight: 1.5,
                outline: "none",
              }}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 8, width: 130 }}>
              {anyBusy ? (
                <button
                  onClick={stopAll}
                  style={{
                    height: 40,
                    background: "linear-gradient(180deg, #f44336, #d32f2f)",
                    color: "#fff", border: "none", borderRadius: 8,
                    fontSize: 12, fontWeight: 700, cursor: "pointer",
                    boxShadow: "0 0 16px -4px #f4433688",
                  }}
                >⏹ Stop</button>
              ) : (
                <button
                  onClick={sendAll}
                  disabled={!draft.trim()}
                  style={{
                    height: 40,
                    background: "linear-gradient(180deg, var(--accent), var(--accent))",
                    color: "#fff",
                    border: "none", borderRadius: 8,
                    fontSize: 12, fontWeight: 700,
                    cursor: !draft.trim() ? "not-allowed" : "pointer",
                    opacity: !draft.trim() ? 0.75 : 1,
                    boxShadow: !draft.trim() ? "none" : "0 0 16px -4px var(--accent)88",
                  }}
                >📤 Send</button>
              )}
              <button
                onClick={resetAll}
                style={{
                  height: 40,
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border-strong)",
                  color: "var(--fg)",
                  borderRadius: 8,
                  fontSize: 12, fontWeight: 600,
                  cursor: "pointer",
                }}
                title="Clear all transcripts"
              >🗑️ Clear</button>
              <button
                onClick={saveJson}
                style={{
                  height: 40,
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border-strong)",
                  color: "var(--fg)",
                  borderRadius: 8,
                  fontSize: 12, fontWeight: 600,
                  cursor: "pointer",
                }}
                title="Save chat as JSON"
              >💾 Save</button>
            </div>
          </div>
        </div>

        {/* RIGHT: Instruction Templates / System Prompt / Generation
            Params / Logs. Qt main.py:18666-19011 — min-width 540,
            stacked per-model settings driven by A/B/C toggles. */}
        <aside style={{
          width: 540,
          minWidth: 540,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          minHeight: 0,
        }}>
          {/* A/B/C toggle buttons (Qt main.py:18676-18690) — Qt
              QPushButtons have NO per-button color stylesheet, so all
              each one carries its own column identity colour. The
              active button is distinguished by a brighter border;
              disabled C (when chat-count < 3) is just opacity-dimmed. */}
          <div style={{ display: "flex", gap: 5 }}>
            {(["A", "B", "C"] as const).map((id) => {
              const emoji = { A: "🔵", B: "🟢", C: "🟣" }[id];
              const isActive = activePanel === id;
              const disabled = (id === "C" && count < 3) || (id === "B" && count < 2);
              return (
                <button
                  key={id}
                  onClick={() => !disabled && setActivePanel(id)}
                  disabled={disabled}
                  style={{
                    flex: 1, padding: "8px 12px",
                    background: COLUMN_GRADIENT[id],
                    color: "#fff",
                    border: `1px solid ${isActive ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.12)"}`,
                    borderRadius: 6,
                    fontSize: 13, fontWeight: 700,
                    cursor: disabled ? "not-allowed" : "pointer",
                    opacity: disabled ? 0.4 : 1,
                    boxShadow: isActive ? "0 0 0 1px rgba(255,255,255,0.25) inset" : "none",
                  }}
                >{emoji} {id}</button>
              );
            })}
          </div>

          {/* Per-model settings page (background tint mirrors Qt
              modelSettingsPage at 60% alpha). */}
          <div style={{
            flex: 1,
            display: "flex", flexDirection: "column", gap: 10,
            padding: 10,
            background: PANEL_TINT[activePanel],
            border: "1px solid rgba(255,255,255,0.18)",
            borderRadius: 8,
            minHeight: 0,
            overflowY: "auto",
          }}>
            {(() => {
              const col = columns.find((c) => c.id === activePanel)!;
              return (
                <>
                  {/* Instruction Templates group (Qt main.py:18770-18795) */}
                  <fieldset style={panelGroupStyle}>
                    <legend style={panelLegendStyle}>📋 Instruction Templates</legend>
                    <div style={{ display: "flex", gap: 6 }}>
                      <select
                        defaultValue=""
                        onChange={(e) => { applyTemplate(col.id, e.target.value); e.currentTarget.value = ""; }}
                        style={{
                          flex: 1,
                          background: "var(--bg-input)",
                          border: "1px solid var(--border-strong)",
                          color: "var(--fg)",
                          borderRadius: 4,
                          fontSize: 12, padding: "6px 8px",
                        }}
                      >
                        <option value="">None</option>
                        <option value="alpaca">Alpaca</option>
                        <option value="vicuna">Vicuna</option>
                        <option value="chatml">ChatML</option>
                        <option value="llama2">Llama-2</option>
                        <option value="custom">Custom</option>
                        <option disabled>──────</option>
                        {TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                      </select>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, width: 90 }}>
                        <button style={smallActionBtn} title="Save current system prompt">💾 Save</button>
                        <button style={smallActionBtn} title="Save as new template">Save as…</button>
                      </div>
                    </div>
                  </fieldset>

                  {/* System Prompt group (Qt main.py:18800-18807) */}
                  <fieldset style={panelGroupStyle}>
                    <legend style={panelLegendStyle}>📝 System Prompt</legend>
                    <textarea
                      value={col.system}
                      onChange={(e) => updateCol(col.id, { system: e.target.value })}
                      placeholder="Enter system instructions..."
                      style={{
                        width: "100%",
                        minHeight: 200,
                        maxHeight: 300,
                        padding: 8,
                        background: "var(--bg-input)",
                        border: "1px solid var(--border-strong)",
                        borderRadius: 4,
                        color: "var(--fg)",
                        fontSize: 12,
                        resize: "vertical",
                        fontFamily: "inherit",
                        boxSizing: "border-box",
                      }}
                    />
                  </fieldset>

                  {/* Generation Parameters group (Qt main.py:18809-18898) */}
                  <fieldset style={panelGroupStyle}>
                    <legend style={panelLegendStyle}>⚙️ Generation Parameters</legend>
                    <ParamRow label="Temperature:"      value={col.temperature.toFixed(1)} >
                      <input type="number" min={0} max={2} step={0.1} value={col.temperature}
                        onChange={(e) => updateCol(col.id, { temperature: parseFloat(e.target.value) || 0 })}
                        style={paramInputStyle} />
                    </ParamRow>
                    <ParamRow label="Max Tokens:"       value={formatMaxTokens(col.maxTokens)} >
                      <input type="number" min={1} step={32} value={col.maxTokens}
                        onChange={(e) => updateCol(col.id, { maxTokens: parseInt(e.target.value, 10) || 1 })}
                        style={paramInputStyle} />
                    </ParamRow>
                    <ParamRow label="Top-p:"            value={col.topP.toFixed(2)} >
                      <input type="number" min={0} max={1} step={0.05} value={col.topP}
                        onChange={(e) => updateCol(col.id, { topP: parseFloat(e.target.value) || 0 })}
                        style={paramInputStyle} />
                    </ParamRow>
                    <ParamRow label="Repetition Penalty:" value={col.repetitionPenalty.toFixed(1)} >
                      <input type="number" min={0} max={2} step={0.1} value={col.repetitionPenalty}
                        onChange={(e) => updateCol(col.id, { repetitionPenalty: parseFloat(e.target.value) || 0 })}
                        style={paramInputStyle} />
                    </ParamRow>
                  </fieldset>

                  <div style={{ fontSize: 10, color: "#bbb" }}>Tokens: 0</div>
                </>
              );
            })()}
          </div>

          {/* Right-panel tabs: Logs / Unfiltered Answer
              (Qt main.py:18948-19005). The "Right Panel" label above
              the tab strip mirrors Qt main.py:18948-18951 — 11pt bold
              white QLabel placed immediately before the tab widget. */}
          <div style={{ display: "flex", flexDirection: "column", minHeight: 200 }}>
            <div style={{ color: "var(--fg-strong)", fontWeight: 700, fontSize: 13, marginBottom: 4 }}>
              Right Panel
            </div>
            <div style={{ display: "flex", gap: 2 }}>
              {(["logs", "unfiltered"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setRightTab(t)}
                  style={{
                    padding: "8px 18px",
                    background: rightTab === t ? "rgba(70,85,130,0.9)" : "rgba(30,35,50,0.9)",
                    color: rightTab === t ? "#fff" : "#ccc",
                    border: "none",
                    borderTopLeftRadius: 6,
                    borderTopRightRadius: 6,
                    fontSize: 12, fontWeight: 600,
                    cursor: "pointer",
                  }}
                >{t === "logs" ? "Logs" : "Unfiltered Answer"}</button>
              ))}
            </div>
            <div style={{
              padding: 10,
              minHeight: 180,
              maxHeight: 240,
              overflowY: "auto",
              background: rightTab === "logs" ? "rgba(20,20,30,0.8)" : "rgba(24,16,16,0.85)",
              border: `1px solid ${rightTab === "logs" ? "rgba(var(--accent-rgb),0.3)" : "rgba(210,140,100,0.35)"}`,
              borderRadius: 8,
              color: rightTab === "logs" ? "#cccccc" : "#f0d0c0",
              fontFamily: "Consolas, 'Courier New', monospace",
              fontSize: 11,
              whiteSpace: "pre-wrap",
            }}>
              {rightTab === "logs"
                ? (status.message || "Server logs will appear here.")
                : (columns.find((c) => c.id === activePanel)?.messages.filter((m) => m.role === "assistant").map((m) => m.content).join("\n\n") || "Raw model output will appear here.")}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function formatMaxTokens(v: number): string {
  if (v < 1000) return String(v);
  if (v < 1_000_000) return v % 1000 === 0 ? `${v / 1000}K` : `${(v / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return v % 1_000_000 === 0 ? `${v / 1_000_000}M` : `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

const panelGroupStyle: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.18)",
  borderRadius: 8,
  padding: "12px 8px 8px 8px",
  background: "rgba(0,0,0,0.18)",
  color: "#fff",
};

const panelLegendStyle: React.CSSProperties = {
  padding: "0 8px",
  fontSize: 12,
  fontWeight: 700,
  color: "#fff",
};

const smallActionBtn: React.CSSProperties = {
  padding: "4px 6px",
  background: "rgba(0,0,0,0.3)",
  border: "1px solid rgba(255,255,255,0.2)",
  color: "#fff",
  borderRadius: 4,
  fontSize: 10,
  fontWeight: 600,
  cursor: "pointer",
};

const paramInputStyle: React.CSSProperties = {
  width: 80,
  padding: "3px 6px",
  background: "var(--bg-input)",
  border: "1px solid var(--border-strong)",
  color: "var(--fg)",
  borderRadius: 4,
  fontSize: 11,
};

function ParamRow(p: { label: string; value: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, padding: "3px 0" }}>
      <span style={{ fontSize: 11, color: "#fff" }}>{p.label}</span>
      <span style={{ fontSize: 11, color: "#fff", minWidth: 40, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{p.value}</span>
      {p.children}
    </div>
  );
}

