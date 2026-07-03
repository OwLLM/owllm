// RunNotebook — the user's live scratchpad WHILE agents work.
//
// Three jobs in one popup (opens from the AgentsPage header, 📓 Notebook):
//   1. Brainstorm — a freeform notes pane the user writes in during a run
//      (ideas, refactors, feature thoughts). Autosaved per project.
//   2. Next steps — an ordered to-do list. Each step can be fed to the
//      team: mid-run it becomes a ⚡ steer (picked up at the next agent
//      boundary — or between tool calls on local models); when the team is
//      idle it dispatches as a new goal. With AUTO-FEED on, the moment a
//      run finishes cleanly the next pending step is dispatched by itself —
//      write the roadmap, let the team walk it.
//   3. Digest agent — a small chat that rewrites raw notes into clear,
//      self-contained, implementable steps. ADDITIVE by design: it only
//      proposes NEW steps (never rewrites the list); the user adds the ones
//      they like with one click.
//
// State is one localStorage blob per project (owllm:agents:notebook:<pid>).
// AgentsPage reads the same blob at run-end for auto-feed via the exported
// helpers, and both sides broadcast NOTEBOOK_EVENT so the open modal and the
// page never go stale against each other.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useStickyScroll } from "../../hooks/useStickyScroll";
import { type ModelInfo, streamChatCompletion, providerFor } from "./dispatch";

export type NotebookStep = {
  id: string;
  text: string;
  /// pending = written, not fed yet · sent = fed to the team · done = user checked it off
  status: "pending" | "sent" | "done";
  ts: number;
};

export type NotebookState = {
  text: string;
  steps: NotebookStep[];
  autoFeed: boolean;
  digest: Array<{ role: "you" | "digest"; text: string }>;
};

export const NOTEBOOK_EVENT = "owllm:notebook-changed";
const EMPTY: NotebookState = { text: "", steps: [], autoFeed: false, digest: [] };
const keyFor = (projectId: string) => `owllm:agents:notebook:${projectId}`;

export function loadNotebook(projectId: string | null | undefined): NotebookState {
  if (!projectId) return { ...EMPTY };
  try {
    const raw = localStorage.getItem(keyFor(projectId));
    if (!raw) return { ...EMPTY };
    const p = JSON.parse(raw);
    return {
      text: typeof p.text === "string" ? p.text : "",
      steps: Array.isArray(p.steps) ? p.steps.filter((s: NotebookStep) => s && typeof s.text === "string") : [],
      autoFeed: p.autoFeed === true,
      digest: Array.isArray(p.digest) ? p.digest.slice(-12) : [],
    };
  } catch { return { ...EMPTY }; }
}

export function saveNotebook(projectId: string | null | undefined, nb: NotebookState): void {
  if (!projectId) return;
  try {
    localStorage.setItem(keyFor(projectId), JSON.stringify({ ...nb, digest: nb.digest.slice(-12) }));
    window.dispatchEvent(new CustomEvent(NOTEBOOK_EVENT, { detail: { projectId } }));
  } catch { /* best effort */ }
}

/// Run-end auto-feed helper (used by AgentsPage): pop the first pending step
/// — marks it "sent" and persists — or null when auto-feed is off / nothing
/// is pending.
export function takeNextAutoStep(projectId: string | null | undefined): NotebookStep | null {
  const nb = loadNotebook(projectId);
  if (!nb.autoFeed) return null;
  const next = nb.steps.find((s) => s.status === "pending");
  if (!next) return null;
  next.status = "sent";
  saveNotebook(projectId, nb);
  return next;
}

const newStepId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/// Parse "- step" / "1. step" lines out of a digest reply.
function parseProposedSteps(reply: string): string[] {
  const out: string[] = [];
  for (const line of reply.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.{3,})$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

const DIGEST_SYSTEM = [
  "You are the Notebook Digest agent inside OWLLM. An agent team is working on the user's project;",
  "the user brainstorms alongside it. Your ONLY job: turn their raw notes/requests into clear,",
  "self-contained, implementable NEXT STEPS for that team.",
  "Rules:",
  "- ADDITIVE: never rewrite, merge or remove the existing steps you are shown — only propose NEW ones.",
  "- Each step must stand alone: an agent receives it with no other context, so name the feature/file/behavior explicitly.",
  "- Small and actionable beats big and vague; split compound ideas into separate steps.",
  "- Output: one short line of reasoning at most, then EVERY proposed step on its own line starting with '- '.",
].join("\n");

type Props = {
  projectId: string | null | undefined;
  projectName?: string;
  /// Multi-tab gate — only the visible Agents tab reacts to the open event.
  active?: boolean;
  /// Is a team run in progress right now (steers queue vs new dispatch).
  running: boolean;
  /// Feed one step to the team. Returns what happened so the UI can say it.
  onFeed: (text: string) => "queued" | "dispatched" | "no-team";
  /// Digest model routing (same trio the BrainstormPanel takes).
  modelId: string;
  port: number;
  models: ModelInfo[];
};

export default function RunNotebook({ projectId, projectName, active = true, running, onFeed, modelId, port, models }: Props) {
  const [open, setOpen] = useState(false);
  const [nb, setNb] = useState<NotebookState>(() => loadNotebook(projectId));
  const [newStep, setNewStep] = useState("");
  const [digestInput, setDigestInput] = useState("");
  const [digestBusy, setDigestBusy] = useState(false);
  const [proposed, setProposed] = useState<string[]>([]);
  const digestScroll = useStickyScroll<HTMLDivElement>([nb.digest, proposed, digestBusy]);
  const activeRef = useRef(active);
  activeRef.current = active;
  const projRef = useRef(projectId);
  projRef.current = projectId;

  useEffect(() => {
    const onOpen = () => { if (activeRef.current) { setNb(loadNotebook(projRef.current)); setOpen(true); } };
    window.addEventListener("owllm:open-run-notebook", onOpen as EventListener);
    return () => window.removeEventListener("owllm:open-run-notebook", onOpen as EventListener);
  }, []);
  // Reload when the page (auto-feed) or another tab touches the same blob.
  useEffect(() => {
    const onChanged = (e: Event) => {
      const pid = (e as CustomEvent).detail?.projectId;
      if (pid && pid === projRef.current) setNb(loadNotebook(pid));
    };
    window.addEventListener(NOTEBOOK_EVENT, onChanged as EventListener);
    return () => window.removeEventListener(NOTEBOOK_EVENT, onChanged as EventListener);
  }, []);
  // Project switch → swap to that project's notebook.
  useEffect(() => { setNb(loadNotebook(projectId)); setProposed([]); }, [projectId]);

  const update = (patch: Partial<NotebookState>) => {
    setNb((prev) => {
      const next = { ...prev, ...patch };
      saveNotebook(projRef.current, next);
      return next;
    });
  };

  const addStep = (text: string) => {
    const t = text.trim();
    if (!t) return;
    update({ steps: [...nb.steps, { id: newStepId(), text: t, status: "pending", ts: Date.now() }] });
  };
  const setStep = (id: string, patch: Partial<NotebookStep>) =>
    update({ steps: nb.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  const removeStep = (id: string) => update({ steps: nb.steps.filter((s) => s.id !== id) });
  const moveStep = (id: string, dir: -1 | 1) => {
    const i = nb.steps.findIndex((s) => s.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= nb.steps.length) return;
    const steps = [...nb.steps];
    [steps[i], steps[j]] = [steps[j], steps[i]];
    update({ steps });
  };
  const feedStep = (s: NotebookStep) => {
    const res = onFeed(s.text);
    if (res === "no-team") return;
    setStep(s.id, { status: "sent" });
  };

  const runDigest = async () => {
    const ask = digestInput.trim();
    const notes = nb.text.trim();
    if ((!ask && !notes) || digestBusy) return;
    setDigestBusy(true);
    setProposed([]);
    const youText = ask || "(digest my notebook notes into next steps)";
    const history = [...nb.digest, { role: "you" as const, text: youText }];
    update({ digest: history });
    setDigestInput("");
    try {
      const user = [
        nb.steps.length ? `EXISTING STEPS (do not repeat or rewrite):\n${nb.steps.map((s) => `- ${s.text}`).join("\n")}` : "",
        notes ? `NOTEBOOK NOTES:\n${notes}` : "",
        ask ? `USER REQUEST:\n${ask}` : "",
      ].filter(Boolean).join("\n\n");
      let reply = "";
      const ctrl = new AbortController();
      await streamChatCompletion(
        port, modelId, providerFor(modelId, models),
        DIGEST_SYSTEM, user, 0.3, ctrl.signal,
        (d) => { reply += d; },
      );
      const steps = parseProposedSteps(reply);
      update({ digest: [...history, { role: "digest", text: reply.trim() || "(no reply)" }] });
      setProposed(steps);
    } catch (e: any) {
      update({ digest: [...history, { role: "digest", text: `(error: ${String(e?.message ?? e)})` }] });
    } finally {
      setDigestBusy(false);
    }
  };

  const pendingCount = useMemo(() => nb.steps.filter((s) => s.status === "pending").length, [nb.steps]);
  // Human-readable digest model: the raw id with any file path stripped.
  const digestModelLabel = useMemo(() => {
    const raw = (modelId || "").trim();
    return raw ? (raw.split(/[\\/]/).pop() || raw) : "server model";
  }, [modelId]);
  if (!open) return null;

  const statusIcon = (s: NotebookStep) => (s.status === "done" ? "✓" : s.status === "sent" ? "⚡" : "○");
  const statusColor = (s: NotebookStep) => (s.status === "done" ? "#7ff0c5" : s.status === "sent" ? "#ffd97a" : "var(--fg-muted)");

  return (
    <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(8,12,20,0.6)", zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "min(1060px, 94vw)", height: "min(680px, 90vh)", display: "flex", flexDirection: "column",
        background: "var(--bg-panel)", border: "1px solid var(--border-strong)", borderRadius: 12,
        boxShadow: "0 18px 60px rgba(0,0,0,0.55)", overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ fontSize: 17 }}>📓</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--fg-strong)" }}>Notebook{projectName ? ` — ${projectName}` : ""}</span>
          <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>
            {running ? "team is running — fed steps steer it live" : "team idle — fed steps start a run"}
          </span>
          <div style={{ flex: 1 }} />
          <label title="When a run finishes cleanly, the next pending step is dispatched automatically — write the roadmap, the team walks it." style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: nb.autoFeed ? "#7ff0c5" : "var(--fg-muted)", cursor: "pointer" }}>
            <input type="checkbox" checked={nb.autoFeed} onChange={(e) => update({ autoFeed: e.target.checked })} />
            Auto-feed next step
          </label>
          <button className="ghost-btn" onClick={() => setOpen(false)} style={{ height: 26, width: 28, padding: 0, fontSize: 13 }}>✕</button>
        </div>

        {/* Body: notes | steps */}
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {/* Brainstorm notes */}
          <div style={{ flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", borderRight: "1px solid var(--border)" }}>
            <div style={{ padding: "8px 14px 4px", fontSize: 11, fontWeight: 700, letterSpacing: 0.6, color: "var(--fg-muted)", textTransform: "uppercase" }}>Brainstorm</div>
            <textarea
              value={nb.text}
              onChange={(e) => update({ text: e.target.value })}
              placeholder={"Think out loud while the agents work — ideas, refactors, features…\nThen 🪄 Digest turns this into feedable steps."}
              style={{ flex: 1, margin: "4px 14px 12px", padding: 10, resize: "none", background: "var(--bg-input)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12.5, lineHeight: 1.5, outline: "none" }}
            />
          </div>

          {/* Next steps */}
          <div style={{ flex: "1.15 1 0", minWidth: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "8px 14px 4px", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, color: "var(--fg-muted)", textTransform: "uppercase" }}>Next steps</span>
              <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>{pendingCount} pending</span>
            </div>
            <div style={{ display: "flex", gap: 6, padding: "2px 14px 8px" }}>
              <input
                value={newStep}
                onChange={(e) => setNewStep(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { addStep(newStep); setNewStep(""); } }}
                placeholder="Write a step and press Enter…"
                style={{ flex: 1, height: 30, padding: "0 10px", background: "var(--bg-input)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: 7, fontSize: 12.5, outline: "none" }}
              />
              <button className="ghost-btn" onClick={() => { addStep(newStep); setNewStep(""); }} style={{ height: 30, padding: "0 12px", fontSize: 12 }}>＋ Add</button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 14px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
              {nb.steps.length === 0 && (
                <div style={{ padding: 18, textAlign: "center", fontSize: 12, color: "var(--fg-muted)" }}>
                  No steps yet — add one above, or 🪄 digest your notes below.
                </div>
              )}
              {nb.steps.map((s) => (
                <div key={s.id} style={{
                  display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px",
                  background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8,
                  opacity: s.status === "done" ? 0.55 : 1,
                }}>
                  <button
                    onClick={() => setStep(s.id, { status: s.status === "done" ? "pending" : "done" })}
                    title={s.status === "done" ? "Re-open this step" : "Mark done"}
                    style={{ border: "none", background: "transparent", cursor: "pointer", color: statusColor(s), fontSize: 13, lineHeight: "18px", width: 18, padding: 0 }}
                  >{statusIcon(s)}</button>
                  <span style={{ flex: 1, fontSize: 12.5, lineHeight: 1.45, color: "var(--fg)", textDecoration: s.status === "done" ? "line-through" : "none", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    {s.text}
                    {s.status === "sent" && <span style={{ marginLeft: 6, fontSize: 10, color: "#ffd97a" }}>fed to team</span>}
                  </span>
                  <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                    {s.status === "pending" && (
                      <button
                        onClick={() => feedStep(s)}
                        title={running ? "Feed now — steers the running team at its next boundary" : "Feed now — dispatches this step as a new goal"}
                        style={{ height: 22, padding: "0 8px", border: "1px solid rgba(255,217,122,0.5)", borderRadius: 6, background: "rgba(38,30,10,0.6)", color: "#ffd97a", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                      >⚡ Feed</button>
                    )}
                    <button className="ghost-btn" onClick={() => moveStep(s.id, -1)} title="Move up" style={{ height: 22, width: 20, padding: 0, fontSize: 10 }}>▲</button>
                    <button className="ghost-btn" onClick={() => moveStep(s.id, 1)} title="Move down" style={{ height: 22, width: 20, padding: 0, fontSize: 10 }}>▼</button>
                    <button className="ghost-btn" onClick={() => removeStep(s.id)} title="Delete step" style={{ height: 22, width: 22, padding: 0, fontSize: 11, color: "#ff8c8c" }}>🗑</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Digest agent strip */}
        <div style={{ borderTop: "1px solid var(--border)", padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8, maxHeight: 220 }}>
          {(nb.digest.length > 0 || digestBusy) && (
            <div ref={digestScroll.ref} onScroll={digestScroll.onScroll} style={{ overflowY: "auto", maxHeight: 110, display: "flex", flexDirection: "column", gap: 4 }}>
              {nb.digest.map((m, i) => (
                <div key={i} style={{ fontSize: 12, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word", color: m.role === "you" ? "#9ad9ff" : "var(--fg)" }}>
                  <b style={{ fontSize: 10, opacity: 0.8 }}>{m.role === "you" ? "YOU" : "🪄 DIGEST"}</b> {m.text}
                </div>
              ))}
              {digestBusy && <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>🪄 digesting…</div>}
            </div>
          )}
          {proposed.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              {proposed.map((t, i) => (
                <button
                  key={i}
                  onClick={() => setProposed((ps) => { addStep(t); return ps.filter((_, j) => j !== i); })}
                  title="Add this step to the list"
                  style={{ maxWidth: 340, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", height: 24, padding: "0 10px", border: "1px solid rgba(127,240,197,0.45)", borderRadius: 999, background: "rgba(16,36,28,0.7)", color: "#7ff0c5", fontSize: 11, cursor: "pointer" }}
                >＋ {t}</button>
              ))}
              <button
                onClick={() => { proposed.forEach(addStep); setProposed([]); }}
                style={{ height: 24, padding: "0 10px", border: "none", borderRadius: 999, background: "#2f7d5b", color: "#eafff5", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
              >Add all</button>
            </div>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span
              title="The digest agent runs on the team's default model (pending override → project's team model → the loaded server model). Change it in Team settings."
              style={{ flexShrink: 0, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", height: 22, lineHeight: "22px", padding: "0 9px", border: "1px solid var(--border)", borderRadius: 999, background: "var(--bg-surface)", color: "var(--fg-muted)", fontSize: 10.5 }}
            >🪄 {digestModelLabel}</span>
            <input
              value={digestInput}
              onChange={(e) => setDigestInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !digestBusy) void runDigest(); }}
              placeholder="🪄 Digest — describe what you want (or leave empty to digest the notes) and press Enter…"
              style={{ flex: 1, height: 30, padding: "0 10px", background: "var(--bg-input)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: 7, fontSize: 12.5, outline: "none" }}
            />
            <button
              onClick={() => void runDigest()}
              disabled={digestBusy}
              style={{ height: 30, padding: "0 14px", border: "none", borderRadius: 7, background: digestBusy ? "var(--bg-surface)" : "rgba(var(--accent-rgb),0.2)", color: digestBusy ? "var(--fg-muted)" : "var(--accent)", fontSize: 12, fontWeight: 700, cursor: digestBusy ? "wait" : "pointer" }}
            >🪄 Digest</button>
          </div>
        </div>
      </div>
    </div>
  );
}
