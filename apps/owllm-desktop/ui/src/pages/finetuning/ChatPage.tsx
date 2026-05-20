// ChatPage — full chat surface against the local llama-server.
//
// What's wired (all real, no mocks):
//   • Streams /v1/chat/completions from the running llama-server using
//     OpenAI SSE — same protocol Qt's test tab used.
//   • Polls server_status every 2s so the page knows whether to enable
//     the input and which model_id to send.
//   • Generation params (temperature, max_tokens, top_p) are passed to
//     the model on every send.
//   • System prompt + canned templates (Helpful / Coder / Persona /
//     Custom) so users don't have to re-type a system message every run.
//   • Conversation history persisted to localStorage so reopening the
//     tab restores the last conversation (matches Qt's auto-save).
//   • Save-as-JSON / Load-from-JSON buttons that work via the browser's
//     File picker so chats can be shared.
//   • Stop button aborts the in-flight stream cleanly.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const ICONS = "/Page_icons";
const LS_KEY = "owllm:chat:v2";

type ServerStatus = {
  running: boolean;
  model_id: string | null;
  port: number | null;
  message: string;
};

type Role = "user" | "assistant" | "system";
type ChatMsg = { role: Role; content: string };

type SavedState = {
  system: string;
  messages: ChatMsg[];
  temperature: number;
  maxTokens: number;
  topP: number;
};

// Templates that prefill the system prompt. Picked from the Qt Test
// tab's quick-template menu.
const TEMPLATES: Array<{ key: string; label: string; system: string }> = [
  { key: "helpful",   label: "🤖 Helpful assistant", system: "You are a helpful AI assistant. Answer directly and concisely." },
  { key: "coder",     label: "💻 Coding assistant",   system: "You are an expert software engineer. Provide working code, brief explanations, and call out edge cases. Use the user's stated language." },
  { key: "tutor",     label: "🎓 Patient tutor",      system: "You are a patient tutor. Break concepts into small steps, check understanding, and adapt your explanation to the user's level." },
  { key: "analyst",   label: "📊 Data analyst",       system: "You are a data analyst. Reason from the data the user shares. Show your assumptions. Prefer tables and bullet lists over prose." },
  { key: "writer",    label: "✍ Writing partner",     system: "You are a writing partner. Improve clarity, flow, and tone while preserving the user's voice. Suggest concrete edits." },
  { key: "translator",label: "🌐 Translator",         system: "You translate accurately between languages the user specifies, preserving register and meaning. Note ambiguities when relevant." },
  { key: "custom",    label: "✏ Custom",              system: "" },
];

function loadState(): Partial<SavedState> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveState(s: SavedState) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch { /* localStorage might be full or denied */ }
}

export default function ChatPage() {
  const persisted = loadState();
  const [status, setStatus] = useState<ServerStatus>({
    running: false, model_id: null, port: null, message: "",
  });
  const [system, setSystem] = useState(persisted.system ?? TEMPLATES[0].system);
  const [templateKey, setTemplateKey] = useState<string>("helpful");
  const [messages, setMessages] = useState<ChatMsg[]>(persisted.messages ?? []);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [temperature, setTemperature] = useState<number>(persisted.temperature ?? 0.7);
  const [maxTokens, setMaxTokens]     = useState<number>(persisted.maxTokens   ?? 1024);
  const [topP, setTopP]               = useState<number>(persisted.topP        ?? 0.9);
  const [paramsOpen, setParamsOpen] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  // Persist on any meaningful change.
  useEffect(() => {
    saveState({ system, messages, temperature, maxTokens, topP });
  }, [system, messages, temperature, maxTokens, topP]);

  // Poll the running server so we know which port + model to target.
  useEffect(() => {
    let dead = false;
    const tick = async () => {
      try {
        const s = await invoke<ServerStatus>("server_status");
        if (!dead) setStatus(s);
      } catch { /* keep last good values */ }
    };
    tick();
    const id = window.setInterval(tick, 2000);
    return () => { dead = true; window.clearInterval(id); };
  }, []);

  // Auto-scroll the transcript to the bottom when new tokens land.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  async function send() {
    setError(null);
    const text = draft.trim();
    if (!text) return;
    if (!status.running || !status.port) {
      setError("No server is running. Go to the Server tab and start a model first.");
      return;
    }
    const userMsg: ChatMsg = { role: "user", content: text };
    const next = [...messages, userMsg];
    setMessages(next);
    setDraft("");
    setBusy(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const payload = {
      model: status.model_id ?? "local",
      messages: [
        { role: "system" as const, content: system },
        ...next,
      ],
      stream: true,
      temperature,
      max_tokens: maxTokens,
      top_p: topP,
    };

    let buffer = "";
    setMessages(curr => [...curr, { role: "assistant", content: "" }]);

    try {
      const resp = await fetch(`http://127.0.0.1:${status.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!resp.ok || !resp.body) {
        const errText = await resp.text().catch(() => `HTTP ${resp.status}`);
        throw new Error(errText);
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
              setMessages(curr => {
                const out = curr.slice();
                const last = out[out.length - 1];
                if (last && last.role === "assistant") {
                  out[out.length - 1] = { ...last, content: last.content + delta };
                }
                return out;
              });
            }
          } catch { /* malformed chunk — skip */ }
        }
      }
    } catch (e: unknown) {
      const err = e as { name?: string; message?: string };
      if (err.name === "AbortError") {
        setError("Stopped.");
      } else {
        setError(String(err.message ?? e));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function stop() { abortRef.current?.abort(); }
  function reset() {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
  }

  function pickTemplate(key: string) {
    setTemplateKey(key);
    const t = TEMPLATES.find((x) => x.key === key);
    if (t && key !== "custom") setSystem(t.system);
  }

  function saveJson() {
    const blob = new Blob(
      [JSON.stringify({ system, messages, temperature, maxTokens, topP }, null, 2)],
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
        if (typeof j.system === "string") setSystem(j.system);
        if (Array.isArray(j.messages)) setMessages(j.messages);
        if (typeof j.temperature === "number") setTemperature(j.temperature);
        if (typeof j.maxTokens === "number") setMaxTokens(j.maxTokens);
        if (typeof j.topP === "number") setTopP(j.topP);
      } catch (e) {
        setError(`Load failed: ${String(e)}`);
      }
    };
    inp.click();
  }

  const placeholder = status.running
    ? `Ask ${status.model_id ?? "the model"} something…  (Enter to send · Shift+Enter for newline)`
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
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <img src={`${ICONS}/owl_chat.png`} alt="" style={{ width: 32, height: 32, objectFit: "contain" }} />
        <div style={{ fontSize: 24, fontWeight: 800, color: "var(--fg-strong)" }}>💬 Chat</div>
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
      </div>

      {/* Two-column body: chat on left, params on right */}
      <div style={{ display: "grid", gridTemplateColumns: paramsOpen ? "1fr 280px" : "1fr 36px", gap: 10, flex: 1, minHeight: 0 }}>
        {/* Chat column */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0 }}>
          {/* System + template row */}
          <div style={{
            display: "flex", gap: 8, alignItems: "center",
            background: "#0e1320",
            border: "1px solid #1c2434",
            borderRadius: 8, padding: "6px 10px",
            flexWrap: "wrap",
          }}>
            <select
              value={templateKey}
              onChange={(e) => pickTemplate(e.target.value)}
              style={{
                background: "#162033", border: "1px solid #243044",
                color: "var(--fg)", fontSize: 12, padding: "4px 6px",
                borderRadius: 4,
              }}
            >
              {TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
            <input
              value={system}
              onChange={e => { setSystem(e.target.value); setTemplateKey("custom"); }}
              style={{
                flex: 1, minWidth: 180, height: 26, background: "#0b1020",
                border: "1px solid #1c2434", color: "var(--fg)", fontSize: 12,
                padding: "0 8px", borderRadius: 4, outline: "none",
              }}
              placeholder="System prompt (applied to every conversation)"
            />
            <button onClick={loadJson} style={btnGhost} title="Load a chat from a JSON file.">📂 Load</button>
            <button onClick={saveJson} style={btnGhost} title="Download the current chat as JSON.">💾 Save</button>
            <button onClick={reset}    style={btnGhost} title="Clear and start fresh.">🗑 New</button>
          </div>

          {/* Transcript */}
          <div
            ref={transcriptRef}
            style={{
              flex: 1, overflowY: "auto", minHeight: 0,
              background: "#0e1320",
              border: "1px solid #1c2434",
              borderRadius: 8, padding: 14,
              display: "flex", flexDirection: "column", gap: 12,
              fontSize: 13, lineHeight: 1.55,
            }}
          >
            {messages.length === 0 ? (
              <div style={{ fontSize: 12, color: "#7a7f87" }}>
                {status.running
                  ? "Type a message below to start the conversation."
                  : "Start a server on the Server tab first, then come back here."}
              </div>
            ) : messages.map((m, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{
                  fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
                  color: m.role === "user" ? "#7aa2ff" : "#a0e88a",
                }}>
                  {m.role === "user" ? "YOU" : "ASSISTANT"}
                </div>
                <div style={{ whiteSpace: "pre-wrap", color: "var(--fg)" }}>
                  {m.content || (busy && i === messages.length - 1 ? "▍" : "")}
                </div>
              </div>
            ))}
            {error ? (
              <div style={{
                border: "1px solid #ff9f9f",
                background: "rgba(255,80,80,0.10)",
                color: "#ffb0b0",
                borderRadius: 6, padding: 8,
                fontSize: 12,
              }}>{error}</div>
            ) : null}
          </div>

          {/* Composer */}
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey && !busy) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={placeholder}
              disabled={!status.running || busy}
              style={{
                flex: 1, minHeight: 70, maxHeight: 200,
                resize: "vertical",
                padding: 10, borderRadius: 8,
                background: "#0b1020",
                color: "var(--fg)",
                border: "1px solid #1c2434",
                fontFamily: "inherit", fontSize: 13, lineHeight: 1.5,
                outline: "none",
              }}
            />
            {busy ? (
              <button
                onClick={stop}
                style={{
                  height: 70, padding: "0 18px",
                  background: "linear-gradient(180deg, #f44336, #d32f2f)",
                  color: "#fff", border: "none", borderRadius: 8,
                  fontSize: 13, fontWeight: 700, cursor: "pointer",
                  boxShadow: "0 0 16px -4px #f4433688",
                }}
                title="Abort the in-flight stream."
              >⏹ Stop</button>
            ) : (
              <button
                onClick={send}
                disabled={!status.running || !draft.trim()}
                style={{
                  height: 70, padding: "0 18px",
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
                title="Send the message (Enter, or Shift+Enter for a newline)."
              >Send ▶</button>
            )}
          </div>
        </div>

        {/* Params sidebar */}
        <div style={{
          background: "#0e1320",
          border: "1px solid #1c2434",
          borderRadius: 8,
          padding: paramsOpen ? 12 : 6,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          minHeight: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              onClick={() => setParamsOpen((v) => !v)}
              style={{ ...btnGhost, padding: "2px 6px", fontSize: 14 }}
              title={paramsOpen ? "Collapse parameters" : "Expand parameters"}
            >{paramsOpen ? "›" : "‹"}</button>
            {paramsOpen && <div style={{ fontWeight: 700, fontSize: 13, color: "#667eea" }}>⚙ Generation</div>}
          </div>

          {paramsOpen && (
            <>
              <RangeField label="Temperature"   value={temperature} min={0} max={2} step={0.05} onChange={setTemperature} help="Higher = more random. 0 = deterministic; 0.7 = balanced; 1.2 = creative." />
              <RangeField label="Top-p"         value={topP}        min={0.05} max={1} step={0.05} onChange={setTopP}     help="Nucleus sampling cutoff. 0.9 picks from the top 90% probability mass." />
              <NumField   label="Max tokens"    value={maxTokens}   min={1} max={32768} step={64}  onChange={setMaxTokens} help="Hard cap on the response length. 1024 ≈ 750 English words." />

              <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #1c2434" }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: "#667eea", marginBottom: 6 }}>📋 Conversation</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, fontSize: 11 }}>
                  <div style={{ color: "var(--fg-muted)" }}>Turns</div>
                  <div style={{ color: "var(--fg)" }}>{messages.length}</div>
                  <div style={{ color: "var(--fg-muted)" }}>Chars</div>
                  <div style={{ color: "var(--fg)" }}>{messages.reduce((n, m) => n + m.content.length, 0).toLocaleString()}</div>
                  <div style={{ color: "var(--fg-muted)" }}>Model</div>
                  <div style={{ color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={status.model_id ?? ""}>
                    {status.model_id ?? "—"}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const btnGhost: React.CSSProperties = {
  padding: "4px 10px",
  background: "#162033",
  border: "1px solid #243044",
  color: "var(--fg)",
  borderRadius: 4,
  fontSize: 11,
  cursor: "pointer",
};

function RangeField(p: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; help?: string }) {
  return (
    <div title={p.help} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--fg-muted)" }}>
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

function NumField(p: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; help?: string }) {
  return (
    <label title={p.help} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>{p.label}</span>
      <input
        type="number"
        min={p.min} max={p.max} step={p.step}
        value={p.value}
        onChange={(e) => p.onChange(parseInt(e.target.value, 10) || p.min)}
        style={{
          padding: "5px 8px",
          background: "#0b1020",
          border: "1px solid #1c2434",
          color: "var(--fg)",
          borderRadius: 4,
          fontSize: 12,
        }}
      />
    </label>
  );
}
