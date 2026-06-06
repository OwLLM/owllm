// CodePage — OWLLM-native coding agent.
//
// Rebuilt 2026-06-06 from a mock VSCodium/Cline launcher into a REAL
// coding agent on OWLLM's own engine. No bundled IDE, no Cline embed —
// it drives the shared `streamLocalChat` loop (native GGUF tool-calling)
// against the user's chosen workspace, so the local model can read,
// search, edit and create files and run shell commands in that folder.
// Cline's card-based UX is inspiration for later phases (file tree, live
// diffs, task Kanban); Phase 1 is the working agent core.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChatBubble, ToolEventCard } from "../../components/ChatBubble";
import { streamLocalChat, type ModelInfo, type ServerStatus, type HistoryItem } from "./dispatch";
import type { ToolCall, ToolExecResult } from "./localTools";

type Msg = {
  role: "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  kind?: "tool" | "terminal";
  title?: string;
  status?: "ok" | "error" | "running";
  ts: number;
};

const CODING_SYSTEM = (ws: string) =>
  `You are OWLLM's coding agent, working directly inside the user's project at:\n${ws}\n\n` +
  `You have real tools: read_file, grep, glob, list_dir, edit_file, write_file_with_diff, ` +
  `create_dir and shell. Use them — do NOT ask the user to paste files or run commands you can run yourself. ` +
  `Read and search before you edit. Make the smallest correct change that satisfies the request, keep the ` +
  `surrounding code's style, and after editing briefly state what you changed and why. Paths may be given ` +
  `relative to the workspace.`;

export default function CodePage() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelId, setModelId] = useState<string>("");
  const [workspace, setWorkspace] = useState<string>("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Pick a folder and a local model, then describe what to build or fix.");
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Real local/tuned models (the coding agent runs against a served GGUF).
  useEffect(() => {
    invoke<ModelInfo[]>("list_models")
      .then((all) => {
        const local = all.filter((m) => m.provider === "local" || m.provider === "tuned");
        setModels(local);
        setModelId((cur) => cur || local[0]?.model_id || "");
      })
      .catch((e) => setStatus(`Couldn't load models: ${e}`));
  }, []);

  // Auto-scroll the transcript as tokens / tool events land.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const pickWorkspace = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true, multiple: false, title: "Pick a project folder" });
      if (typeof dir === "string" && dir) {
        setWorkspace(dir);
        setStatus(`Workspace: ${dir}`);
      }
    } catch (e) {
      setStatus(`Folder picker failed: ${e}`);
    }
  };

  // Start (or reuse) the llama-server for the chosen model; return its port.
  async function ensureServer(id: string): Promise<number | null> {
    const s = await invoke<ServerStatus>("server_status").catch(() => null);
    if (s && s.running && s.model_id === id && s.port) return s.port;
    setStatus(`Starting ${id}…`);
    await invoke("server_start", { modelId: id });
    for (let i = 0; i < 120 && !abortRef.current?.signal.aborted; i++) {
      const st = await invoke<ServerStatus>("server_status").catch(() => null);
      if (st && st.running && st.port) return st.port;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  // ----- streaming sinks (newline-safe append; same lesson as ChatPage) -----
  const onDelta = (d: string) =>
    setMessages((msgs) => {
      const out = msgs.slice();
      const last = out[out.length - 1];
      if (last && last.role === "assistant" && !last.kind) {
        out[out.length - 1] = { ...last, content: last.content + d };
      } else {
        out.push({ role: "assistant", content: d, ts: Date.now() });
      }
      return out;
    });

  const onThought = (channel: string, _role: string, delta: string) => {
    if (channel !== "thinking") return;
    setMessages((msgs) => {
      const out = msgs.slice();
      const last = out[out.length - 1];
      if (last && last.role === "assistant" && !last.kind) {
        out[out.length - 1] = { ...last, thinking: (last.thinking ?? "") + delta };
      } else {
        out.push({ role: "assistant", content: "", thinking: delta, ts: Date.now() });
      }
      return out;
    });
  };

  const onToolCall = (call: ToolCall) => {
    const firstArg = Object.values(call.args)[0] ?? "";
    setMessages((msgs) => [
      ...msgs,
      {
        role: "tool",
        kind: call.name === "shell" ? "terminal" : "tool",
        title: `${call.name}${firstArg ? `(${String(firstArg)})` : ""}`.slice(0, 100),
        content: "",
        status: "running",
        ts: Date.now(),
      },
    ]);
  };

  const onToolResult = (call: ToolCall, result: ToolExecResult) =>
    setMessages((msgs) => {
      const out = msgs.slice();
      // Live diff: edit_file carries old/new in the call itself, so render a
      // real -/+ diff instead of the terse "edited" string. write_file_with_diff
      // shows whatever diff the backend returned (its output).
      const content =
        result.ok && call.name === "edit_file"
          ? formatEditDiff(call.args.old_string ?? "", call.args.new_string ?? "")
          : result.output;
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].role === "tool" && out[i].status === "running") {
          out[i] = { ...out[i], status: result.ok ? "ok" : "error", content };
          break;
        }
      }
      return out;
    });

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    if (!workspace) { setStatus("Pick a workspace folder first (Browse)."); return; }
    if (!modelId) { setStatus("No local model available — load one on the Models page."); return; }
    setDraft("");
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const history: HistoryItem[] = messages
      .filter((m) => m.role === "user" || (m.role === "assistant" && !m.kind && m.content.trim()))
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    setMessages((msgs) => [...msgs, { role: "user", content: text, ts: Date.now() }]);
    try {
      const port = await ensureServer(modelId);
      if (!port) { setStatus("Model server didn't come up — check the Server tab."); return; }
      setStatus(`Coding in ${workspace}`);
      await streamLocalChat({
        port,
        modelId,
        systemPrompt: CODING_SYSTEM(workspace),
        userContent: text,
        temperature: 0.3,
        signal: ctrl.signal,
        onDelta,
        onThought,
        projectCwd: workspace,
        history,
        events: { onToolCall, onToolResult },
      });
    } catch (e) {
      const err = e as { name?: string; message?: string };
      if (err.name !== "AbortError") {
        setMessages((msgs) => [...msgs, { role: "assistant", content: `⚠ ${err.message ?? e}`, ts: Date.now() }]);
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const stop = () => { abortRef.current?.abort(); setBusy(false); };
  const clear = () => { if (!busy) { setMessages([]); setStatus(`Workspace: ${workspace || "(none)"}`); } };

  // Clicking a file in the tree drops an @-reference into the composer so the
  // user can point the agent at it ("fix the bug in @src/foo.ts").
  const openFile = (abs: string) => {
    const rel = workspace && abs.startsWith(workspace) ? abs.slice(workspace.length).replace(/^[\\/]+/, "") : abs;
    setDraft((d) => (d.trim() ? `${d.replace(/\s*$/, "")} @${rel} ` : `@${rel} `));
  };

  const wsShort = workspace ? workspace.replace(/^.*[\\/]/, "") : "No folder";

  return (
    <div style={{ padding: "8px 10px 10px", height: "100%", display: "flex", flexDirection: "column", gap: 8, background: "var(--bg-panel)", color: "var(--fg)" }}>
      {/* Header: workspace · model · status */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 16 }}>🦉</span>
        <span style={{ fontWeight: 700, fontSize: 14, color: "var(--fg-strong)" }}>Code</span>
        <button onClick={pickWorkspace} title={workspace || "Pick a project folder"} style={btn}>📁 {wsShort}</button>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>Model</span>
        <select
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          disabled={busy}
          style={{ background: "var(--bg-input)", color: "var(--fg)", border: "1px solid var(--border-strong)", borderRadius: 6, fontSize: 12, padding: "6px 8px", maxWidth: 280 }}
        >
          {models.length === 0 && <option value="">No local models</option>}
          {models.map((m) => <option key={m.model_id} value={m.model_id}>{m.model_id}</option>)}
        </select>
        <button onClick={clear} disabled={busy || messages.length === 0} style={btn}>Clear</button>
      </div>

      {/* Body: file-tree rail + transcript */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 8 }}>
        {workspace && (
          <div style={{ width: 220, flexShrink: 0, overflowY: "auto", overflowX: "hidden", background: "var(--bg-input)", border: "1px solid var(--border-strong)", borderRadius: 8, padding: 4 }}>
            <TreeDir path={workspace} name={wsShort} depth={0} defaultOpen onOpenFile={openFile} />
          </div>
        )}
      <div
        ref={scrollRef}
        className="selectable-chat"
        style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, padding: 12, background: "var(--bg-input)", border: "1px solid var(--border-strong)", borderRadius: 8 }}
      >
        {messages.length === 0 ? (
          <div style={{ margin: "auto", textAlign: "center", color: "var(--fg-muted)", fontSize: 13, maxWidth: 460, lineHeight: 1.6 }}>
            <div style={{ fontSize: 30, marginBottom: 8 }}>🛠️</div>
            Your local model codes directly in <b>{workspace || "a folder you pick"}</b>.<br />
            It can read, search, edit and create files and run commands there.<br />
            <span style={{ fontSize: 12 }}>Pick a folder, choose a model, and describe the change.</span>
          </div>
        ) : (
          messages.map((m, i) => {
            if (m.role === "tool") {
              return <ToolEventCard key={i} kind={m.kind ?? "tool"} title={m.title ?? "tool"} status={m.status} content={m.content} />;
            }
            const isUser = m.role === "user";
            const isStreaming = busy && i === messages.length - 1 && m.role === "assistant";
            return (
              <ChatBubble
                key={i}
                avatar={isUser ? "U" : "C"}
                sender={isUser ? "You" : "Coder"}
                accent={isUser ? "#7aa2ff" : "#7ff0c5"}
                isUser={isUser}
                isStreaming={isStreaming}
                content={m.content}
                thinking={m.thinking}
                ts={m.ts}
              />
            );
          })
        )}
        </div>
      </div>

      {/* Status line */}
      <div style={{ fontSize: 11, color: "var(--fg-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{status}</div>

      {/* Composer */}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={workspace ? "Describe the change, bug, or feature…  (Enter to send, Shift+Enter for newline)" : "Pick a workspace folder first…"}
          rows={2}
          style={{ flex: 1, resize: "vertical", minHeight: 44, maxHeight: 160, padding: 10, background: "var(--bg-input)", border: "1px solid var(--border-strong)", borderRadius: 8, color: "var(--fg)", fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }}
        />
        {busy ? (
          <button onClick={stop} style={{ ...btn, background: "rgba(180,60,60,0.85)", color: "#fff", border: "none", height: 44, padding: "0 16px" }}>Stop</button>
        ) : (
          <button onClick={send} disabled={!draft.trim()} style={{ ...btn, background: "var(--accent)", color: "#06080d", border: "none", height: 44, padding: "0 16px", fontWeight: 700, opacity: draft.trim() ? 1 : 0.5 }}>Send</button>
        )}
      </div>
    </div>
  );
}

const btn: CSSProperties = {
  height: 30,
  padding: "0 10px",
  borderRadius: 6,
  border: "1px solid var(--border-strong)",
  background: "var(--bg-surface)",
  color: "var(--fg)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

// Render an edit_file change as a -/+ diff for the tool card. old/new come
// straight from the tool call, so this is the actual change the agent made.
function formatEditDiff(oldStr: string, newStr: string): string {
  const minus = oldStr.split("\n").map((l) => `- ${l}`);
  const plus = newStr.split("\n").map((l) => `+ ${l}`);
  return [...minus, ...plus].join("\n");
}

type TreeEntry = { name: string; kind: string };

// Lazy file-tree node. Reuses the existing tool_list_dir command (the same
// one the coding agent uses), so no new backend. Folders expand on click and
// load their children once; files insert an @-reference into the composer.
function TreeDir({ path, name, depth, defaultOpen, onOpenFile }: {
  path: string; name: string; depth: number; defaultOpen?: boolean;
  onOpenFile: (absPath: string) => void;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [entries, setEntries] = useState<TreeEntry[] | null>(null);
  useEffect(() => {
    if (open && entries === null) {
      invoke<Array<{ name: string; kind: string; size?: number }>>("tool_list_dir", { path, cwd: undefined })
        .then((e) =>
          setEntries(
            e
              .filter((x) => !x.name.startsWith(".") && x.name !== "node_modules" && x.name !== "target")
              .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1)),
          ),
        )
        .catch(() => setEntries([]));
    }
  }, [open, entries, path]);
  const rowStyle: CSSProperties = {
    display: "flex", alignItems: "center", gap: 4, padding: "2px 4px",
    paddingLeft: 4 + depth * 12, fontSize: 12, cursor: "pointer", borderRadius: 4,
    color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
  };
  return (
    <div>
      <div style={rowStyle} onClick={() => setOpen((o) => !o)} title={path}>
        <span style={{ width: 12, color: "var(--fg-muted)" }}>{open ? "▾" : "▸"}</span>
        <span>📁 {name}</span>
      </div>
      {open && entries === null && <div style={{ ...rowStyle, color: "var(--fg-muted)" }}>…</div>}
      {open && entries?.map((e) => {
        const child = `${path}/${e.name}`;
        if (e.kind === "dir") {
          return <TreeDir key={child} path={child} name={e.name} depth={depth + 1} onOpenFile={onOpenFile} />;
        }
        return (
          <div key={child} style={{ ...rowStyle, paddingLeft: 4 + (depth + 1) * 12 }} title={child}
               onClick={() => onOpenFile(child)}>
            <span style={{ width: 12 }} />
            <span style={{ color: "var(--fg-muted)" }}>📄 {e.name}</span>
          </div>
        );
      })}
    </div>
  );
}
