// BrainstormPanel — pre-project-execution scoping pass.
//
// The user drops a generic idea ("Gmail CRM for myself", "spreadsheet
// for gym tracking"); the brainstormer agent searches the web, fetches
// 3-5 competitor landing pages, screenshots them via TwinForge, builds
// a feature-frequency table (≥3/5 = v1 must-have), and writes BRIEF.md
// into the project's location. The orchestrator then picks BRIEF.md up
// automatically on its next run (see buildOrchestratorPrompt's
// briefBlock injection).
//
// This panel is a modal — opens on demand from the AgentsPage header,
// streams the brainstormer's progress live, and closes when BRIEF.md
// is on disk.

import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  type RoleData,
  type ModelInfo,
  streamChatCompletion,
  providerFor,
} from "./dispatch";

type Props = {
  open: boolean;
  onClose: () => void;
  /// Project location on disk — where BRIEF.md and brainstorm/<png>
  /// files get written. Required: if the project has no location set,
  /// the brainstormer can't anchor its files, so this panel refuses to
  /// run with a clear message.
  projectCwd: string;
  /// Brainstormer role definition (loaded via list_agent_roles in
  /// AgentsPage and passed in). The system_prompt comes from this.
  brainstormerRole: RoleData | null;
  /// Model + provider routing. Brainstormer can be heavy on the LLM
  /// (5 competitor scans + synthesis), so users should pick a strong
  /// model — Claude Opus 4.7 medium is the sweet spot. We use whatever
  /// the parent passed (typically the team's default).
  modelId: string;
  /// llama-server port for local-model paths. Pass 0 if the model is
  /// cloud (anthropic/openai/etc.) — providerFor decides.
  port: number;
  /// Available models registry; lets providerFor route correctly when
  /// the model id is unprefixed (e.g. "local-qwen3-14b").
  models: ModelInfo[];
  /// Called after BRIEF.md is verified on disk so the parent can
  /// refresh its UI (show "brief: ✓" badge, etc.). Optional.
  onBriefSaved?: () => void;
};

type LogLine = { kind: "text" | "tool" | "system"; text: string };

export default function BrainstormPanel(props: Props) {
  const { open, onClose, projectCwd, brainstormerRole, modelId, port, models, onBriefSaved } = props;

  const [idea, setIdea] = useState("");
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Sticky auto-scroll on new lines.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  // Reset when reopened.
  useEffect(() => {
    if (open) {
      setRunning(false);
      setDone(false);
      setError(null);
      setLines([]);
    }
  }, [open]);

  if (!open) return null;

  const append = (kind: LogLine["kind"], text: string) =>
    setLines((prev) => {
      const out = prev.slice();
      const last = out[out.length - 1];
      if (last && last.kind === "text" && kind === "text") {
        out[out.length - 1] = { kind: "text", text: last.text + text };
      } else {
        out.push({ kind, text });
      }
      return out;
    });

  const runBrainstorm = async () => {
    const trimmed = idea.trim();
    if (!trimmed) {
      setError("Enter a generic idea first (one or two sentences is enough).");
      return;
    }
    if (!projectCwd) {
      setError("This project has no location set. Pick a folder in the Location row first so the brainstormer can save BRIEF.md.");
      return;
    }
    if (!brainstormerRole?.systemPrompt) {
      setError("Brainstormer role not loaded. Make sure LLM/core/agents/roles/brainstormer.yaml is present.");
      return;
    }
    if (!modelId) {
      setError("No model picked. Set a team default model first.");
      return;
    }

    setRunning(true);
    setError(null);
    setDone(false);
    setLines([{ kind: "system", text: `🧠 Starting brainstorm in ${projectCwd} using ${modelId}…` }]);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const onDelta = (delta: string) => append("text", delta);
    const onThought = (channel: string, role: string, _delta: string) => {
      // Tool-call channels look like `tool:<name>:<turn>`; surface
      // them as inline banners so the user sees what's happening.
      if (channel.startsWith("tool:")) {
        append("tool", `🛠 ${role}`);
      }
    };

    // The brainstormer asks the user (us — the panel) to write BRIEF.md
    // to `<project_cwd>/BRIEF.md`. We seed the user message with the
    // idea + the project_cwd anchor so the agent knows where to save.
    const userMessage = [
      `Project location (where BRIEF.md and brainstorm/<png> should be saved):`,
      projectCwd,
      "",
      `My generic idea:`,
      trimmed,
      "",
      "Run the full STRICT WORKFLOW from your role: clarify → search → per-competitor scan → feature aggregation → GUI direction → write BRIEF.md → wrap.",
    ].join("\n");

    try {
      await streamChatCompletion(
        port,
        modelId,
        providerFor(modelId, models),
        brainstormerRole.systemPrompt,
        userMessage,
        brainstormerRole.defaultTemperature ?? 0.4,
        ctrl.signal,
        onDelta,
        projectCwd,
        undefined, undefined,
        onThought,
      );
      // Verify BRIEF.md actually landed on disk before declaring success.
      // The model can claim it wrote a file when it didn't (or wrote it
      // to the wrong path) — better to check than trust.
      let briefOnDisk = false;
      try {
        const text = await invoke<string>("tool_read_file", {
          path: "BRIEF.md", cwd: projectCwd,
        });
        briefOnDisk = text.trim().length > 0;
      } catch { /* missing or unreadable */ }
      if (briefOnDisk) {
        setDone(true);
        append("system", `\n✓ BRIEF.md saved to ${projectCwd}\\BRIEF.md. Close this panel — the orchestrator will pick it up on the next Run.`);
        onBriefSaved?.();
      } else {
        setError("Brainstormer finished but BRIEF.md was not written. Check the log for what went wrong — likely a tool error (missing BRAVE_API_KEY, network, etc.).");
      }
    } catch (e: any) {
      if (e?.name === "AbortError") {
        append("system", "\n⏹ Cancelled.");
      } else {
        setError(String(e?.message ?? e));
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
  };

  // ---- Render ----
  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9000,
        background: "rgba(8, 10, 18, 0.78)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 24,
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !running) onClose(); }}
    >
      <div
        style={{
          width: "min(960px, 95vw)",
          maxHeight: "90vh",
          display: "flex", flexDirection: "column",
          background: "rgba(20, 24, 36, 0.98)",
          border: "1px solid rgba(140, 160, 220, 0.35)",
          borderRadius: 12,
          boxShadow: "0 18px 60px rgba(0, 0, 0, 0.6)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{
          padding: "14px 18px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 22 }}>🧠</span>
            <div>
              <div style={{ color: "#fff", fontWeight: 700, fontSize: 15 }}>Project Brainstorm</div>
              <div style={{ color: "#aab2c8", fontSize: 11, marginTop: 2 }}>
                Researches competitors → ranks features by frequency → writes BRIEF.md
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={running}
            style={{
              padding: "6px 12px", fontSize: 12,
              background: "transparent",
              color: running ? "#5a6175" : "#cfd4e1",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 6,
              cursor: running ? "not-allowed" : "pointer",
            }}
          >
            Close
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14, flex: 1, minHeight: 0 }}>
          {/* Idea input */}
          <div>
            <label style={{ color: "#cfd4e1", fontSize: 12, fontWeight: 600, display: "block", marginBottom: 6 }}>
              Your idea (one or two sentences — be generic, the brainstormer fills in the rest)
            </label>
            <textarea
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              disabled={running || done}
              placeholder="e.g. A Gmail-native CRM I can use for my own business contacts. Or: a workout tracker that learns from my history and suggests next week's plan."
              rows={3}
              style={{
                width: "100%",
                padding: 10,
                background: "rgba(10,14,22,0.8)",
                color: "#e6ebf7",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 6,
                fontSize: 13,
                resize: "vertical",
                fontFamily: "inherit",
              }}
            />
          </div>

          {/* Status / context strip */}
          <div style={{
            fontSize: 11, color: "#8a92a3",
            display: "flex", gap: 12, flexWrap: "wrap",
          }}>
            <span>📂 {projectCwd || <em style={{ color: "#ff9f9f" }}>no project location set</em>}</span>
            <span>🤖 {modelId || <em style={{ color: "#ff9f9f" }}>no model</em>}</span>
            <span>🔑 Brave Search key required (set in Accounts page)</span>
          </div>

          {/* Action row */}
          <div style={{ display: "flex", gap: 8 }}>
            {!running && !done && (
              <button
                onClick={runBrainstorm}
                disabled={!idea.trim() || !projectCwd || !modelId || !brainstormerRole?.systemPrompt}
                style={{
                  padding: "8px 16px", fontSize: 13, fontWeight: 700,
                  background: "linear-gradient(180deg, #6b7fff, #4a5fd9)",
                  color: "#fff",
                  border: "none", borderRadius: 6,
                  cursor: (idea.trim() && projectCwd && modelId) ? "pointer" : "not-allowed",
                  opacity: (idea.trim() && projectCwd && modelId) ? 1 : 0.5,
                }}
              >
                🚀 Run Brainstorm
              </button>
            )}
            {running && (
              <button
                onClick={cancel}
                style={{
                  padding: "8px 16px", fontSize: 13, fontWeight: 700,
                  background: "rgba(255,80,80,0.18)",
                  color: "#ffb0b0",
                  border: "1px solid rgba(255,140,140,0.4)", borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                ⏹ Stop
              </button>
            )}
            {done && (
              <button
                onClick={onClose}
                style={{
                  padding: "8px 16px", fontSize: 13, fontWeight: 700,
                  background: "rgba(80, 200, 120, 0.18)",
                  color: "#a0f0c0",
                  border: "1px solid rgba(100, 220, 140, 0.4)", borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                ✓ Done — Close
              </button>
            )}
          </div>

          {/* Error */}
          {error ? (
            <div style={{
              padding: 10, fontSize: 12,
              background: "rgba(255,80,80,0.10)",
              border: "1px solid rgba(255,140,140,0.4)",
              color: "#ffb0b0", borderRadius: 6,
            }}>
              {error}
            </div>
          ) : null}

          {/* Log viewer */}
          <div
            ref={logRef}
            style={{
              flex: 1, minHeight: 200, maxHeight: "50vh", overflowY: "auto",
              padding: 12,
              background: "rgba(8,11,18,0.92)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 6,
              fontFamily: "Consolas, 'Cascadia Code', monospace",
              fontSize: 12, lineHeight: 1.55,
              color: "#cfd4e1",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {lines.length === 0 && !running ? (
              <div style={{ color: "#5a6175", fontStyle: "italic" }}>
                Output will appear here once you click Run Brainstorm.
              </div>
            ) : (
              lines.map((l, i) => {
                if (l.kind === "tool") {
                  return (
                    <div key={i} style={{ color: "#9ad9ff", margin: "4px 0", fontWeight: 600 }}>
                      {l.text}
                    </div>
                  );
                }
                if (l.kind === "system") {
                  return (
                    <div key={i} style={{ color: "#ffd97a", margin: "4px 0", fontStyle: "italic" }}>
                      {l.text}
                    </div>
                  );
                }
                return <span key={i}>{l.text}</span>;
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
