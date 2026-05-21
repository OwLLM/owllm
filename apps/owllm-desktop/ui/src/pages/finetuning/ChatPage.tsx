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

const ICONS = "/Page_icons";
const LS_KEY = "owllm:chat:v3";

type ServerStatus = {
  running: boolean;
  model_id: string | null;
  port: number | null;
  message: string;
};

type Role = "user" | "assistant" | "system";
type ChatMsg = { role: Role; content: string };

// One side-by-side column. Each carries its own system prompt and
// sampling params so the user can A/B without leaving the page.
type Column = {
  id: "A" | "B" | "C";
  color: string;        // header gradient + label tint
  emoji: string;        // 🔵 🟢 🟣
  system: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  messages: ChatMsg[];
  busy: boolean;
  error: string | null;
};

const DEFAULT_COL = (id: "A" | "B" | "C"): Column => {
  const palettes = {
    A: { color: "#4a6cff", emoji: "🔵" },
    B: { color: "#22c55e", emoji: "🟢" },
    C: { color: "#9C27B0", emoji: "🟣" },
  };
  return {
    id,
    color: palettes[id].color,
    emoji: palettes[id].emoji,
    system: "You are a helpful AI assistant.",
    temperature: id === "A" ? 0.5 : id === "B" ? 0.9 : 1.2,
    topP: 0.9,
    maxTokens: 1024,
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
  const [paramsOpenFor, setParamsOpenFor] = useState<"A" | "B" | "C" | null>(null);
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

  function loadJson() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "application/json,.json";
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try {
        const text = await f.text();
        const j = JSON.parse(text);
        if (j.count) setCount(j.count);
        if (Array.isArray(j.columns)) setColumns(j.columns);
        if (typeof j.converse === "boolean") setConverse(j.converse);
        if (typeof j.maxTurns === "number") setMaxTurns(j.maxTurns);
      } catch { /* ignore */ }
    };
    inp.click();
  }

  const anyBusy = columns.some((c) => c.busy);
  const placeholder = status.running
    ? `Ask the ${count > 1 ? `${count} models` : "model"} something… (Enter to send · Shift+Enter for newline)`
    : "Start a server on the Server tab to enable chat.";

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
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <img src={`${ICONS}/owl_chat.png`} alt="" style={{ width: 32, height: 32, objectFit: "contain" }} />
        <div style={{ fontSize: 24, fontWeight: 800, color: "var(--fg-strong)" }}>💬 Chat</div>

        <div style={{ marginLeft: 12, display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--fg-muted)" }}>
          <span>Number of chats:</span>
          {[1, 2, 3].map((n) => (
            <label key={n} style={{
              display: "inline-flex", alignItems: "center", gap: 3,
              padding: "3px 8px",
              background: count === n ? "rgba(102,126,234,0.18)" : "transparent",
              border: `1px solid ${count === n ? "rgba(102,126,234,0.5)" : "#2a3242"}`,
              borderRadius: 4,
              cursor: "pointer",
              fontWeight: count === n ? 700 : 400,
              color: count === n ? "var(--fg)" : "var(--fg-muted)",
            }}>
              <input
                type="radio"
                name="chat-count"
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
          fontSize: 12, color: count < 2 ? "#555" : "var(--fg-muted)",
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
          <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--fg-muted)" }}>
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
                borderRadius: 4, color: "var(--fg)", fontSize: 12,
              }}
            />
          </label>
        )}

        <div style={{ flex: 1 }} />
        <span style={{
          width: 8, height: 8, borderRadius: 4,
          background: status.running ? "#22c55e" : "#888",
          boxShadow: status.running ? "0 0 8px #22c55e" : "none",
        }} />
        <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
          {status.running
            ? `Server: ${status.model_id ?? "?"}${status.port ? ` · port ${status.port}` : ""}`
            : "Server: stopped"}
        </div>
        <button onClick={loadJson} style={btnGhost} title="Load chat JSON">📂</button>
        <button onClick={saveJson} style={btnGhost} title="Save chat JSON">💾</button>
        <button onClick={resetAll} style={btnGhost} title="Clear all transcripts">🗑</button>
      </div>

      {/* Columns row */}
      <div style={{
        display: "grid",
        gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`,
        gap: 10,
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
            {/* Column header */}
            <div style={{
              padding: "10px 12px",
              background: `linear-gradient(180deg, ${col.color}88, ${col.color}44)`,
              borderBottom: `1px solid ${col.color}88`,
              display: "flex", alignItems: "center", gap: 8,
            }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>
                {col.emoji} Model {col.id}
              </div>
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.7)" }}>
                {status.running ? `port ${status.port}` : "—"}
              </span>
              <span style={{ flex: 1 }} />
              <button
                onClick={() => setParamsOpenFor((curr) => curr === col.id ? null : col.id)}
                style={{
                  padding: "3px 8px",
                  background: "rgba(0,0,0,0.25)",
                  border: "1px solid rgba(255,255,255,0.2)",
                  borderRadius: 4,
                  color: "#fff", fontSize: 11, cursor: "pointer",
                }}
                title="Per-column generation parameters"
              >⚙ T={col.temperature.toFixed(1)}</button>
            </div>

            {/* Params drawer */}
            {paramsOpenFor === col.id && (
              <div style={{
                padding: "10px 12px",
                background: "#0b1020",
                borderBottom: "1px solid #1c2434",
                display: "flex", flexDirection: "column", gap: 8,
              }}>
                <select
                  onChange={(e) => applyTemplate(col.id, e.target.value)}
                  style={{
                    background: "#162033", border: "1px solid #243044",
                    color: "var(--fg)", fontSize: 11, padding: "4px 6px",
                    borderRadius: 4,
                  }}
                >
                  <option value="">— Pick a system-prompt template —</option>
                  {TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                </select>
                <textarea
                  value={col.system}
                  onChange={(e) => updateCol(col.id, { system: e.target.value })}
                  placeholder="System prompt for this column"
                  style={{
                    minHeight: 50, padding: 6,
                    background: "#0b1020", border: "1px solid #1c2434",
                    borderRadius: 4, color: "var(--fg)", fontSize: 11,
                    resize: "vertical", fontFamily: "inherit",
                  }}
                />
                <Slider label="Temperature" value={col.temperature} min={0} max={2} step={0.05} onChange={(v) => updateCol(col.id, { temperature: v })} />
                <Slider label="Top-p"       value={col.topP}        min={0.05} max={1} step={0.05} onChange={(v) => updateCol(col.id, { topP: v })} />
                <NumberInput label="Max tokens" value={col.maxTokens} min={1} max={32768} step={64} onChange={(v) => updateCol(col.id, { maxTokens: v })} />
              </div>
            )}

            {/* Transcript */}
            <div
              ref={(el) => { transcriptRefs.current[col.id] = el; }}
              style={{
                flex: 1, overflowY: "auto", minHeight: 0,
                padding: 12,
                display: "flex", flexDirection: "column", gap: 10,
                fontSize: 13, lineHeight: 1.5,
              }}
            >
              {col.messages.length === 0 ? (
                <div style={{ fontSize: 11, color: "#7a7f87" }}>
                  {status.running ? "Send a message below — this column will reply." : "Waiting for server."}
                </div>
              ) : col.messages.map((m, i) => (
                <div key={i} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <div style={{
                    fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
                    color: m.role === "user" ? "#7aa2ff" : col.color,
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

      {/* Composer */}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !anyBusy) {
              e.preventDefault();
              sendAll();
            }
          }}
          placeholder={placeholder}
          disabled={!status.running || anyBusy}
          style={{
            flex: 1, minHeight: 60, maxHeight: 180,
            resize: "vertical",
            padding: 10, borderRadius: 8,
            background: "#0b1020",
            color: "var(--fg)",
            border: "1px solid #1c2434",
            fontFamily: "inherit", fontSize: 13, lineHeight: 1.5,
            outline: "none",
          }}
        />
        {anyBusy ? (
          <button
            onClick={stopAll}
            style={{
              height: 60, padding: "0 18px",
              background: "linear-gradient(180deg, #f44336, #d32f2f)",
              color: "#fff", border: "none", borderRadius: 8,
              fontSize: 13, fontWeight: 700, cursor: "pointer",
              boxShadow: "0 0 16px -4px #f4433688",
            }}
          >⏹ Stop all</button>
        ) : (
          <button
            onClick={sendAll}
            disabled={!status.running || !draft.trim()}
            style={{
              height: 60, padding: "0 18px",
              background: !status.running || !draft.trim()
                ? "rgba(102,126,234,0.12)"
                : "linear-gradient(180deg, #4a6cff, #3a55cc)",
              color: !status.running || !draft.trim() ? "#7a7f87" : "#fff",
              border: "none", borderRadius: 8,
              fontSize: 13, fontWeight: 700,
              cursor: (!status.running || !draft.trim()) ? "not-allowed" : "pointer",
              opacity: (!status.running || !draft.trim()) ? 0.55 : 1,
              boxShadow: !status.running || !draft.trim() ? "none" : "0 0 16px -4px #4a6cff88",
            }}
          >{converse && count >= 2 ? "▶ Start conversation" : count > 1 ? `▶ Send to all ${count}` : "▶ Send"}</button>
        )}
      </div>
    </div>
  );
}

const btnGhost: React.CSSProperties = {
  padding: "4px 8px",
  background: "#162033",
  border: "1px solid #243044",
  color: "var(--fg)",
  borderRadius: 4,
  fontSize: 12,
  cursor: "pointer",
};

function Slider(p: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--fg-muted)" }}>
        <span>{p.label}</span>
        <span style={{ color: "var(--fg)", fontVariantNumeric: "tabular-nums" }}>{p.value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={p.min} max={p.max} step={p.step}
        value={p.value}
        onChange={(e) => p.onChange(parseFloat(e.target.value))}
        style={{ accentColor: "#667eea" }}
      />
    </div>
  );
}

function NumberInput(p: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 10, color: "var(--fg-muted)" }}>{p.label}</span>
      <input
        type="number"
        min={p.min} max={p.max} step={p.step}
        value={p.value}
        onChange={(e) => p.onChange(parseInt(e.target.value, 10) || p.min)}
        style={{
          padding: "4px 6px",
          background: "#0b1020", border: "1px solid #1c2434",
          color: "var(--fg)", borderRadius: 4, fontSize: 11,
        }}
      />
    </label>
  );
}
