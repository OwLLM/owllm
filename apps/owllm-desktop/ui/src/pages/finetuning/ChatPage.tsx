// ChatPage — real chat against whatever model is running. Hits the
// local llama-server's OpenAI-compatible /v1/chat/completions
// endpoint directly from React; no Rust proxy needed.
//
// Qt: main.py::_build_test_tab (line 18310). The legacy app had three
// sub-tabs (free chat, tool-augmented chat, model-vs-model arena).
// This first cut ships free chat only — that's enough to verify the
// running model actually answers, which is what's blocking testing
// today.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const ICONS = "/Page_icons";

type ServerStatus = {
  running: boolean;
  model_id: string | null;
  port: number | null;
  message: string;
};

type Role = "user" | "assistant" | "system";
type ChatMsg = { role: Role; content: string };

export default function ChatPage() {
  const [status, setStatus] = useState<ServerStatus>({
    running: false, model_id: null, port: null, message: "",
  });
  const [system, setSystem] = useState("You are a helpful AI assistant.");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  // Poll the running server so we know which port + model to target.
  // 2 s matches the cadence used elsewhere in the shell.
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

    // llama-server's OpenAI shim accepts any string for "model" — it
    // serves whatever was passed via --model at spawn time. Send our
    // tracked model_id anyway so the request log is informative.
    const payload = {
      model: status.model_id ?? "local",
      messages: [
        { role: "system" as const, content: system },
        ...next,
      ],
      stream: true,
      temperature: 0.7,
    };

    let buffer = "";
    // Optimistically push an empty assistant message — we'll append
    // tokens to it as they stream in.
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
        // OpenAI SSE: lines start with "data: " and end with blank.
        // The terminating sentinel is "data: [DONE]".
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
    } catch (e: any) {
      if (e?.name === "AbortError") {
        setError("Stopped.");
      } else {
        setError(String(e?.message ?? e));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function reset() {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
  }

  const placeholder = status.running
    ? `Ask ${status.model_id ?? "the model"} something…  (Ctrl+Enter to send)`
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
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <img src={`${ICONS}/owl_chat.png`} alt="" style={{ width: 32, height: 32, objectFit: "contain" }} />
        <div style={{ fontSize: 24, fontWeight: 800, color: "var(--fg-strong)" }}>💬 Chat</div>
        <div style={{ flex: 1 }} />
        <span
          className="status-dot"
          style={{
            background: status.running ? "#22c55e" : "#888",
            color: status.running ? "#22c55e" : "#888",
          }}
        />
        <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
          {status.running
            ? `Server: ${status.model_id ?? "?"}${status.port ? ` · port ${status.port}` : ""}`
            : "Server: stopped"}
        </div>
      </div>

      <div style={{
        display: "flex", gap: 8, alignItems: "center",
        background: "var(--bg-elevated)",
        border: "1px solid rgba(127,223,255,0.20)",
        borderRadius: 8, padding: "6px 10px",
      }}>
        <span style={{ fontSize: 12, color: "var(--fg-muted)", whiteSpace: "nowrap" }}>System:</span>
        <input
          value={system}
          onChange={e => setSystem(e.target.value)}
          style={{
            flex: 1, height: 28, background: "transparent",
            border: "none", color: "var(--fg)", fontSize: 12, outline: "none",
          }}
          placeholder="System prompt (applied at the start of every conversation)"
        />
        <button className="ghost-btn" onClick={reset} title="Wipe the conversation and abort any in-flight stream.">
          🗑 New chat
        </button>
      </div>

      <div
        ref={transcriptRef}
        style={{
          flex: 1, overflowY: "auto", minHeight: 0,
          background: "var(--bg-elevated)",
          border: "1px solid var(--border)",
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
              color: m.role === "user" ? "var(--accent)" : "#a0e88a",
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

      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if ((e.key === "Enter" && (e.ctrlKey || e.metaKey)) ||
                (e.key === "Enter" && !e.shiftKey && !busy)) {
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
            background: "var(--bg-elevated)",
            color: "var(--fg)",
            border: "1px solid var(--border-strong)",
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
              color: "var(--fg-strong)", border: "none", borderRadius: 8,
              fontSize: 13, fontWeight: 700, cursor: "pointer",
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
                ? "rgba(127,223,255,0.20)"
                : "linear-gradient(180deg, #4a6cff, #3a55cc)",
              color: !status.running || !draft.trim() ? "#7a7f87" : "#fff",
              border: "none", borderRadius: 8,
              fontSize: 13, fontWeight: 700,
              cursor: (!status.running || !draft.trim()) ? "not-allowed" : "pointer",
              opacity: (!status.running || !draft.trim()) ? 0.55 : 1,
            }}
            title="Send the message (Enter, or Ctrl+Enter for a newline)."
          >Send ▶</button>
        )}
      </div>
    </div>
  );
}
