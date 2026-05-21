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
  A: "#4a6cff",
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
type ChatMsg = { role: Role; content: string };

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
  useEffect(() => {
    let dead = false;
    invoke<ModelInfo[]>("list_models")
      .then((m) => { if (!dead) setAvailableModels(Array.isArray(m) ? m : []); })
      .catch(() => { /* leave empty */ });
    invoke<AccountsStatusLite>("accounts_status")
      .then((s) => { if (!dead) setAccountsStatus(s); })
      .catch(() => { /* leave null */ });
    return () => { dead = true; };
  }, []);

  // Auto-start the global llama-server when column A picks a local
  // GGUF — server.rs holds one Child today, so we treat column A's
  // selection as the active server's model. Cloud / non-GGUF
  // entries (no port, provider != local-gguf) are skipped here and
  // routed through dispatch.ts on send. If a different model is
  // already running, swap (stop then start).
  const [autoStarting, setAutoStarting] = useState<string | null>(null);
  useEffect(() => {
    const driver = columns[0]; // column A
    if (!driver?.selectedModel) return;
    // Only auto-start local GGUF entries (have a port, no prefix).
    const m = availableModels.find((x) => x.model_id === driver.selectedModel);
    if (!m || m.provider !== "local" || m.port == null) return;
    if (status.running && status.model_id === driver.selectedModel) return;
    if (autoStarting === driver.selectedModel) return;

    let dead = false;
    (async () => {
      setAutoStarting(driver.selectedModel);
      try {
        if (status.running) {
          await invoke("server_stop").catch(() => {});
        }
        await invoke("server_start", { modelId: driver.selectedModel });
      } catch (e) {
        if (!dead) updateCol("A", { error: `Failed to start server: ${e}` });
      } finally {
        if (!dead) setAutoStarting(null);
      }
    })();
    return () => { dead = true; };
  }, [columns[0]?.selectedModel, status.running, status.model_id, availableModels]);

  // Auto-scroll each column's transcript when new tokens land.
  useEffect(() => {
    for (const col of columns) {
      const el = transcriptRefs.current[col.id];
      if (el) el.scrollTop = el.scrollHeight;
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
        out[out.length - 1] = { ...last, content: last.content + delta };
      }
      return { ...c, messages: out };
    }));

  // Send the same user text to one column. Returns the assistant
  // reply when the stream completes (used by the M2M loop).
  async function sendOne(col: Column, userText: string): Promise<string> {
    if (!status.running || !status.port) {
      updateCol(col.id, { error: "No server running. Start one on the Server tab." });
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

    const payload = {
      model: status.model_id ?? "local",
      messages: [{ role: "system" as const, content: col.system }, ...next],
      stream: true,
      temperature: col.temperature,
      top_p: col.topP,
      max_tokens: col.maxTokens,
    };

    let reply = "";
    let buffer = "";
    try {
      const resp = await fetch(`http://127.0.0.1:${status.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!resp.ok || !resp.body) {
        throw new Error(await resp.text().catch(() => `HTTP ${resp.status}`));
      }
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, "");
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const body = line.slice(5).trim();
          if (!body || body === "[DONE]") continue;
          try {
            const j = JSON.parse(body);
            const delta = j?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta) {
              reply += delta;
              appendAssistant(col.id, delta);
            }
          } catch { /* skip malformed */ }
        }
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
    for (const a of abortersRef.current.values()) a.abort();
    abortersRef.current.clear();
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
        <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 14, color: "var(--fg-muted)" }}>
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
          <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 14, color: "var(--fg-muted)" }}>
            Max turns:
            <input
              type="number"
              value={maxTurns}
              min={1}
              max={200}
              onChange={(e) => setMaxTurns(Number(e.target.value) || 1)}
              style={{
                width: 60, padding: "2px 6px",
                background: "#0b1020", border: "1px solid #1c2434",
                borderRadius: 4, color: "var(--fg)", fontSize: 14,
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
                background: "#0e1320",
                border: "1px solid #1c2434",
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
                    background: "#0b1020",
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
              disabled={!status.running || anyBusy}
              style={{
                flex: 1, minHeight: 90, maxHeight: 90,
                resize: "none",
                padding: 10, borderRadius: 8,
                background: "#0b1020",
                color: "var(--fg)",
                border: "1px solid #1c2434",
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
                  disabled={!status.running || !draft.trim()}
                  style={{
                    height: 40,
                    background: "linear-gradient(180deg, #4a6cff, #3a55cc)",
                    color: "#fff",
                    border: "none", borderRadius: 8,
                    fontSize: 12, fontWeight: 700,
                    cursor: (!status.running || !draft.trim()) ? "not-allowed" : "pointer",
                    opacity: (!status.running || !draft.trim()) ? 0.75 : 1,
                    boxShadow: !status.running || !draft.trim() ? "none" : "0 0 16px -4px #4a6cff88",
                  }}
                >📤 Send</button>
              )}
              <button
                onClick={resetAll}
                style={{
                  height: 40,
                  background: "#162033",
                  border: "1px solid #243044",
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
                  background: "#162033",
                  border: "1px solid #243044",
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
                          background: "#0b1020",
                          border: "1px solid #1c2434",
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
                        background: "#0b1020",
                        border: "1px solid #1c2434",
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
            <div style={{ color: "#fff", fontWeight: 700, fontSize: 13, marginBottom: 4 }}>
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
              border: `1px solid ${rightTab === "logs" ? "rgba(102,126,234,0.3)" : "rgba(210,140,100,0.35)"}`,
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
  background: "#0b1020",
  border: "1px solid #1c2434",
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

