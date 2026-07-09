// RunNotebook — the user's live scratchpad WHILE agents work.
//
// Three jobs in one surface:
//   1. Working notes — one freeform place the user writes in during a run
//      (ideas, refactors, feature thoughts). Autosaved per project.
//   2. Plan — a small Kanban board distilled from the notes and edited freely.
//   3. Next steps — an ordered to-do list. Each step can be fed to the
//      team: mid-run it becomes a steer; when idle it dispatches as a new
//      goal. With AUTO-FEED on, a cleanly finished run pushes the next
//      pending step automatically.
//
// The digest agent is intentionally not a second chat box. It reads the
// working notes + current plan + existing steps, then proposes plan/step
// changes for one-click apply/add. The raw digest transcript is retained as
// a collapsible log for debugging only.
//
// The component renders inline in the Code page's right column and as a
// modal from the Agents page. Both modes share the same vertical,
// content-sized cards: every text area and step card grows with its content
// so long notes and long steps are always readable without popups.
//
// State is one localStorage blob per project (owllm:agents:notebook:<pid>).
// AgentsPage reads the same blob at run-end for auto-feed via the exported
// helpers, and both sides broadcast NOTEBOOK_EVENT so the open surface and
// the page never go stale against each other.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useAutoResize } from "../../hooks/useAutoResize";
import { useStickyScroll } from "../../hooks/useStickyScroll";
import { type ModelInfo, streamChatCompletion, providerFor } from "./dispatch";
import ModelPicker, { type AccountsStatusLite } from "./ModelPicker";

export type NotebookStep = {
  id: string;
  text: string;
  /// pending = written, not fed yet · sent = fed to the team · done = user checked it off
  status: "pending" | "sent" | "done";
  ts: number;
};

export type NotebookState = {
  text: string;
  /// The PLAN — a living document the digest agent drafts from the
  /// brainstorm (objective, approach, ordered milestones) and the user
  /// edits freely. Steps are the feedable units cut from it.
  plan: string;
  steps: NotebookStep[];
  autoFeed: boolean;
  digest: Array<{ role: "you" | "digest"; text: string }>;
  /// User-picked digest model (per project). Empty/undefined = inherit the
  /// surface's default (team model → server model), same rule as before.
  digestModel?: string;
};

export const NOTEBOOK_EVENT = "owllm:notebook-changed";
const EMPTY: NotebookState = { text: "", plan: "", steps: [], autoFeed: false, digest: [] };
const keyFor = (projectId: string) => `owllm:agents:notebook:${projectId}`;

export function loadNotebook(projectId: string | null | undefined): NotebookState {
  if (!projectId) return { ...EMPTY };
  try {
    const raw = localStorage.getItem(keyFor(projectId));
    if (!raw) return { ...EMPTY };
    const p = JSON.parse(raw);
    return {
      text: typeof p.text === "string" ? p.text : "",
      plan: typeof p.plan === "string" ? p.plan : "",
      steps: Array.isArray(p.steps) ? p.steps.filter((s: NotebookStep) => s && typeof s.text === "string") : [],
      autoFeed: p.autoFeed === true,
      digest: Array.isArray(p.digest) ? p.digest.slice(-12) : [],
      digestModel: typeof p.digestModel === "string" && p.digestModel ? p.digestModel : undefined,
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

type KanbanPlan = { now: string; next: string; later: string };
const EMPTY_KANBAN: KanbanPlan = { now: "", next: "", later: "" };
const KANBAN_COLUMNS: Array<{ key: keyof KanbanPlan; label: string; hint: string; color: string }> = [
  { key: "now", label: "Now", hint: "active implementation batch", color: "#9ad9ff" },
  { key: "next", label: "Next", hint: "queued after Now", color: "#7ff0c5" },
  { key: "later", label: "Later", hint: "parked / optional", color: "#ffd97a" },
];

function parseKanbanPlan(plan: string): KanbanPlan {
  const out: KanbanPlan = { ...EMPTY_KANBAN };
  let current: keyof KanbanPlan | null = null;
  let sawHeading = false;
  for (const line of plan.split(/\r?\n/)) {
    const heading = line.trim().match(/^(?:#{1,3}\s*)?(now|doing|current|next|later|backlog)\s*:?\s*$/i);
    if (heading) {
      sawHeading = true;
      const h = heading[1].toLowerCase();
      current = h === "now" || h === "doing" || h === "current" ? "now" : h === "next" ? "next" : "later";
      continue;
    }
    if (current) out[current] = `${out[current]}${out[current] ? "\n" : ""}${line}`.trimEnd();
  }
  if (!sawHeading && plan.trim()) out.now = plan.trim();
  return out;
}

function formatKanbanPlan(plan: KanbanPlan): string {
  return [
    `NOW:\n${plan.now.trim()}`,
    `NEXT:\n${plan.next.trim()}`,
    `LATER:\n${plan.later.trim()}`,
  ].join("\n\n").trim();
}

function normalizeKanbanPlan(plan: string): string {
  return formatKanbanPlan(parseKanbanPlan(plan));
}

/// Split a digest reply into the updated PLAN block (between "PLAN:" and
/// "STEPS:") and the proposed "- step" lines. Replies without a PLAN:
/// header keep the old shape — steps only.
function parseDigestReply(reply: string): { plan: string; steps: string[] } {
  let planLines: string[] | null = null;
  const steps: string[] = [];
  let inPlan = false;
  for (const line of reply.split(/\r?\n/)) {
    const t = line.trim();
    if (/^PLAN\s*:?\s*$/i.test(t)) { inPlan = true; planLines = planLines ?? []; continue; }
    if (/^(NEXT\s+)?STEPS\s*:?\s*$/i.test(t)) { inPlan = false; continue; }
    if (inPlan) { planLines!.push(line); continue; }
    const m = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.{3,})$/);
    if (m) steps.push(m[1].trim());
  }
  return { plan: (planLines ?? []).join("\n").trim(), steps };
}

const DIGEST_SYSTEM = [
  "You are the Notebook Digest agent inside OWLLM. An agent team is working on the user's project;",
  "the user brainstorms alongside it. Your job: turn their raw notes/requests into (1) an updated",
  "Kanban PLAN and (2) clear, self-contained, implementable NEXT STEPS for that team.",
  "Rules:",
  "- PLAN is a Kanban board, not prose. Use exactly these lanes inside PLAN: NOW, NEXT, LATER.",
  "- NOW = the coherent implementation batch that should happen first. NEXT = follow-up batch.",
  "  LATER = optional/parked work. Keep only useful cards; remove duplication and stale wording.",
  "- You are shown the CURRENT PLAN; refine it (keep what still holds, never silently drop the user's decisions).",
  "  If the notes add nothing plan-worthy, omit the PLAN section entirely.",
  "- STEPS are ADDITIVE: never rewrite, merge or remove the existing steps you are shown — only propose NEW ones.",
  "- Each step must stand alone: an agent receives it with no other context, so name the feature/file/behavior explicitly.",
  "- Do NOT create tiny painful micro-steps. Prefer 1-4 larger implementation chunks that a good agent can complete in one run.",
  "- Merge related UI/code/test work into one step when it belongs together. Split only when the work truly needs separate runs.",
  "- Output format, nothing else:",
  "  PLAN:",
  "  NOW:",
  "  - <card>",
  "  NEXT:",
  "  - <card>",
  "  LATER:",
  "  - <card>",
  "  STEPS:",
  "  - <each proposed larger implementation chunk on its own line starting with '- '>",
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
  /// Window event that opens this instance. The Agents pages listen on the
  /// default; the Code page mounts its own instance on a separate event so
  /// the two surfaces never open each other's modal.
  openEvent?: string;
  /// Needed by the digest-model ModelPicker (which providers are signed in).
  accountsStatus?: AccountsStatusLite | null;
  /// Render the notebook INLINE (fills its parent, stacked vertically) instead
  /// of as a modal — used by the Code page's right-column Notebook tab.
  inline?: boolean;
};

export default function RunNotebook({ projectId, projectName, active = true, running, onFeed, modelId, port, models, openEvent = "owllm:open-run-notebook", accountsStatus = null, inline = false }: Props) {
  const [open, setOpen] = useState(false);
  const [nb, setNb] = useState<NotebookState>(() => loadNotebook(projectId));
  const [newStep, setNewStep] = useState("");
  const [digestBusy, setDigestBusy] = useState(false);
  const [digestLogOpen, setDigestLogOpen] = useState(false);
  const [digestError, setDigestError] = useState("");
  const [proposed, setProposed] = useState<string[]>([]);
  /// Digest-drafted plan awaiting the user's one-click apply (mirrors the
  /// propose→add pattern steps use — the digest never overwrites silently).
  const [proposedPlan, setProposedPlan] = useState<string>("");
  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const digestScroll = useStickyScroll<HTMLDivElement>([nb.digest, proposed, digestBusy]);
  const activeRef = useRef(active);
  activeRef.current = active;
  const projRef = useRef(projectId);
  projRef.current = projectId;

  const kanbanPlan = useMemo(() => parseKanbanPlan(nb.plan), [nb.plan]);
  const brainstormRef = useAutoResize<HTMLTextAreaElement>(nb.text, { minRows: 4, maxRows: 16 });
  const nowPlanRef = useAutoResize<HTMLTextAreaElement>(kanbanPlan.now, { minRows: 3, maxRows: 10 });
  const nextPlanRef = useAutoResize<HTMLTextAreaElement>(kanbanPlan.next, { minRows: 3, maxRows: 10 });
  const laterPlanRef = useAutoResize<HTMLTextAreaElement>(kanbanPlan.later, { minRows: 3, maxRows: 10 });
  const newStepRef = useAutoResize<HTMLTextAreaElement>(newStep, { minRows: 1, maxRows: 6 });
  const editStepRef = useAutoResize<HTMLTextAreaElement>(editingText, { minRows: 1, maxRows: 8 });

  useEffect(() => {
    if (inline) return; // inline instances are always visible — no open event
    const onOpen = () => { if (activeRef.current) { setNb(loadNotebook(projRef.current)); setOpen(true); } };
    window.addEventListener(openEvent, onOpen as EventListener);
    return () => window.removeEventListener(openEvent, onOpen as EventListener);
  }, [openEvent, inline]);
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
  useEffect(() => {
    setNb(loadNotebook(projectId));
    setProposed([]);
    setProposedPlan("");
    setDigestError("");
    setEditingStepId(null);
  }, [projectId]);

  const updateNotebook = (makeNext: (prev: NotebookState) => NotebookState) => {
    setNb((prev) => {
      const next = makeNext(prev);
      saveNotebook(projRef.current, next);
      return next;
    });
  };

  const update = (patch: Partial<NotebookState>) => {
    updateNotebook((prev) => ({ ...prev, ...patch }));
  };
  const updateKanbanLane = (key: keyof KanbanPlan, value: string) => {
    update({ plan: formatKanbanPlan({ ...kanbanPlan, [key]: value }) });
  };

  const addStep = (text: string) => {
    const t = text.trim();
    if (!t) return;
    updateNotebook((prev) => ({
      ...prev,
      steps: [...prev.steps, { id: newStepId(), text: t, status: "pending", ts: Date.now() }],
    }));
  };
  const addSteps = (texts: string[]) => {
    const clean = texts.map((t) => t.trim()).filter(Boolean);
    if (!clean.length) return;
    const now = Date.now();
    updateNotebook((prev) => ({
      ...prev,
      steps: [
        ...prev.steps,
        ...clean.map((text, i) => ({ id: newStepId(), text, status: "pending" as const, ts: now + i })),
      ],
    }));
  };
  const setStep = (id: string, patch: Partial<NotebookStep>) =>
    updateNotebook((prev) => ({ ...prev, steps: prev.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  const removeStep = (id: string) => updateNotebook((prev) => ({ ...prev, steps: prev.steps.filter((s) => s.id !== id) }));
  const moveStep = (id: string, dir: -1 | 1) => {
    const i = nb.steps.findIndex((s) => s.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= nb.steps.length) return;
    const steps = [...nb.steps];
    [steps[i], steps[j]] = [steps[j], steps[i]];
    updateNotebook((prev) => ({ ...prev, steps }));
  };
  const feedStep = (s: NotebookStep) => {
    const res = onFeed(s.text);
    if (res === "no-team") return;
    setStep(s.id, { status: "sent" });
  };

  const startEdit = (s: NotebookStep) => { setEditingStepId(s.id); setEditingText(s.text); };
  const saveEdit = () => {
    if (!editingStepId) return;
    const t = editingText.trim();
    if (t) setStep(editingStepId, { text: t });
    else removeStep(editingStepId);
    setEditingStepId(null);
    setEditingText("");
  };
  const cancelEdit = () => { setEditingStepId(null); setEditingText(""); };

  const runDigest = async () => {
    const notes = nb.text.trim();
    const currentPlan = nb.plan.trim();
    if (digestBusy) return;
    if (!notes && !currentPlan && nb.steps.length === 0) {
      setDigestError("Write working notes first, or add an existing plan/step for the digest to refine.");
      return;
    }
    setDigestBusy(true);
    setDigestError("");
    setProposed([]);
    setProposedPlan("");
    const youText = "Digest the current notebook into a clearer plan and new feedable steps.";
    const history = [...nb.digest, { role: "you" as const, text: youText }];
    update({ digest: history });
    try {
      const user = [
        currentPlan ? `CURRENT PLAN (extend/refine additively):\n${currentPlan}` : "",
        nb.steps.length ? `EXISTING STEPS (do not repeat or rewrite):\n${nb.steps.map((s) => `- ${s.text}`).join("\n")}` : "",
        notes ? `NOTEBOOK NOTES:\n${notes}` : "",
      ].filter(Boolean).join("\n\n");
      let reply = "";
      const ctrl = new AbortController();
      // User override (persisted per project) wins; else the inherited default.
      const dm = nb.digestModel || modelId;
      if (!dm.trim()) throw new Error("No digest model is selected or loaded.");
      await streamChatCompletion(
        port, dm, providerFor(dm, models),
        DIGEST_SYSTEM, user, 0.3, ctrl.signal,
        (d) => { reply += d; },
      );
      const parsed = parseDigestReply(reply);
      update({ digest: [...history, { role: "digest", text: reply.trim() || "(no reply)" }] });
      setProposed(parsed.steps);
      if (parsed.plan && normalizeKanbanPlan(parsed.plan) !== normalizeKanbanPlan(currentPlan)) {
        setProposedPlan(normalizeKanbanPlan(parsed.plan));
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      setDigestError(msg);
      setDigestLogOpen(true);
      update({ digest: [...history, { role: "digest", text: `(error: ${msg})` }] });
    } finally {
      setDigestBusy(false);
    }
  };

  const pendingCount = useMemo(() => nb.steps.filter((s) => s.status === "pending").length, [nb.steps]);
  // Human-readable INHERITED digest model (the default when no override is
  // picked): the raw id with any file path stripped.
  const digestModelLabel = useMemo(() => {
    const raw = (modelId || "").trim();
    return raw ? (raw.split(/[\\/]/).pop() || raw) : "server model";
  }, [modelId]);
  if (!inline && !open) return null;

  const statusIcon = (s: NotebookStep) => (s.status === "done" ? "✓" : s.status === "sent" ? "⚡" : "○");
  const statusColor = (s: NotebookStep) => (s.status === "done" ? "#7ff0c5" : s.status === "sent" ? "#ffd97a" : "var(--fg-muted)");

  const card: React.CSSProperties = {
    display: "flex", flexDirection: "column", gap: 8,
    background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 10,
    padding: "10px 12px",
  };
  const sectionHeader: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 8,
    fontSize: 11, fontWeight: 800, letterSpacing: 0.8,
    color: "var(--fg-strong)", textTransform: "uppercase",
    paddingBottom: 6, borderBottom: "1px solid var(--border)",
  };
  const textareaBase: React.CSSProperties = {
    width: "100%", resize: "none", overflow: "hidden",
    background: "var(--bg-input)", color: "var(--fg)",
    border: "1px solid var(--border-strong)", borderRadius: 8,
    padding: 10, fontSize: 12.5, lineHeight: 1.55, outline: "none",
  };

  const panel = (
      <div onClick={(e) => e.stopPropagation()} style={inline ? {
        width: "100%", height: "100%", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden",
      } : {
        width: "min(820px, 94vw)", height: "min(820px, 90vh)", display: "flex", flexDirection: "column",
        background: "var(--bg-panel)", border: "1px solid var(--border-strong)", borderRadius: 12,
        boxShadow: "0 18px 60px rgba(0,0,0,0.55)", overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: inline ? "8px 12px" : "12px 16px", borderBottom: "1px solid var(--border)", flexWrap: "wrap", flexShrink: 0 }}>
          <span style={{ fontSize: inline ? 15 : 18 }}>📓</span>
          {!inline && <span style={{ fontSize: 14, fontWeight: 700, color: "var(--fg-strong)" }}>Notebook{projectName ? ` — ${projectName}` : ""}</span>}
          <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>
            {running ? (inline ? "run live — steps steer it" : "team is running — fed steps steer it live") : (inline ? "idle — steps start a run" : "team idle — fed steps start a run")}
          </span>
          <div style={{ flex: 1 }} />
          <label title="When a run finishes cleanly, the next pending step is dispatched automatically — write the roadmap, the team walks it." style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: nb.autoFeed ? "#7ff0c5" : "var(--fg-muted)", cursor: "pointer" }}>
            <input type="checkbox" checked={nb.autoFeed} onChange={(e) => update({ autoFeed: e.target.checked })} />
            Auto-feed next step
          </label>
          {!inline && <button className="ghost-btn" onClick={() => setOpen(false)} style={{ height: 26, width: 28, padding: 0, fontSize: 13 }}>✕</button>}
        </div>

        {/* Body: scrollable column of cards */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, padding: "12px 14px" }}>
          {/* Working notes and digest controls */}
          <div style={card}>
            <div style={sectionHeader}>
              <span>💡</span>
              <span>Working notes</span>
              <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 500, textTransform: "none", color: "var(--fg-muted)" }}>single source for digest</span>
            </div>
            <textarea
              ref={brainstormRef}
              value={nb.text}
              onChange={(e) => update({ text: e.target.value })}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !digestBusy) {
                  e.preventDefault();
                  void runDigest();
                }
              }}
              placeholder={"Think out loud here while the agents work: decisions, bugs, UI ideas, files to touch.\nPress Ctrl+Enter or use Digest notes to turn this into a plan and feedable steps."}
              style={textareaBase}
            />
            {digestError && (
              <div style={{ padding: "8px 10px", border: "1px solid rgba(255,140,140,0.45)", borderRadius: 8, background: "rgba(70,20,28,0.35)", color: "#ffb4b4", fontSize: 12, lineHeight: 1.4 }}>
                {digestError}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <div title="Digest agent model. Default: the team's model (pending override -> project's team model -> loaded server model)." style={{ width: inline ? 170 : 220, flexShrink: 0 }}>
                <ModelPicker
                  value={nb.digestModel || ""}
                  onChange={(id) => update({ digestModel: id })}
                  models={models}
                  status={accountsStatus}
                  fallbackLabel={`🪄 ${digestModelLabel}`}
                />
              </div>
              {nb.digestModel && (
                <button className="ghost-btn" onClick={() => update({ digestModel: undefined })} title="Back to the default team model" style={{ height: 28, width: 28, padding: 0, fontSize: 11, flexShrink: 0 }}>✕</button>
              )}
              <button
                onClick={() => void runDigest()}
                disabled={digestBusy}
                title="Digest the working notes, current plan, and existing steps"
                style={{ height: 32, padding: "0 14px", border: "none", borderRadius: 7, background: digestBusy ? "var(--bg-surface)" : "rgba(var(--accent-rgb),0.2)", color: digestBusy ? "var(--fg-muted)" : "var(--accent)", fontSize: 12, fontWeight: 700, cursor: digestBusy ? "wait" : "pointer", flexShrink: 0 }}
              >{digestBusy ? "Digesting..." : "🪄 Digest notes"}</button>
              {nb.digest.length > 0 && (
                <button className="ghost-btn" onClick={() => setDigestLogOpen((v) => !v)} title="Show or hide the raw digest transcript" style={{ height: 28, padding: "0 10px", fontSize: 11 }}>
                  {digestLogOpen ? "Hide log" : "Show log"}
                </button>
              )}
              {nb.text.trim() && (
                <button className="ghost-btn" onClick={() => update({ text: "" })} title="Clear working notes and start a fresh note" style={{ height: 28, padding: "0 10px", fontSize: 11 }}>
                  Clear notes
                </button>
              )}
              <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--fg-muted)" }}>
                {digestBusy ? "reading notebook..." : "Ctrl+Enter digests"}
              </span>
            </div>
            {digestLogOpen && (nb.digest.length > 0 || digestBusy) && (
              <div ref={digestScroll.ref} onScroll={digestScroll.onScroll} style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 180, overflowY: "auto", padding: 10, background: "var(--bg-input)", borderRadius: 8, border: "1px solid var(--border)" }}>
                {nb.digest.map((m, i) => (
                  <div key={i} style={{ fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", color: m.role === "you" ? "#9ad9ff" : "var(--fg)" }}>
                    <b style={{ fontSize: 10, opacity: 0.8 }}>{m.role === "you" ? "REQUEST" : "DIGEST"}</b> {m.text}
                  </div>
                ))}
                {digestBusy && <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>Digesting...</div>}
              </div>
            )}
          </div>

          {(proposedPlan || proposed.length > 0) && (
            <div style={{ ...card, borderColor: "rgba(127,240,197,0.35)" }}>
              <div style={sectionHeader}>
                <span>🪄</span>
                <span>Proposed update</span>
                <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 500, textTransform: "none", color: "var(--fg-muted)" }}>review before applying</span>
              </div>
              {proposedPlan && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 10, background: "rgba(14,28,40,0.5)", border: "1px solid rgba(154,217,255,0.35)", borderRadius: 8 }}>
                  <div style={{ fontSize: 11, color: "#9ad9ff", fontWeight: 700 }}>Proposed plan</div>
                  <div style={{ fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--fg)" }}>{proposedPlan}</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={() => { update({ plan: normalizeKanbanPlan(proposedPlan), text: "" }); setProposedPlan(""); }}
                      style={{ height: 26, padding: "0 12px", border: "1px solid rgba(154,217,255,0.45)", borderRadius: 6, background: "rgba(14,28,40,0.7)", color: "#9ad9ff", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                    >Save plan + clear notes</button>
                    <button className="ghost-btn" onClick={() => setProposedPlan("")} title="Discard the proposed plan" style={{ height: 26, padding: "0 10px", fontSize: 11 }}>Discard</button>
                  </div>
                </div>
              )}
              {proposed.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ fontSize: 11, color: "#7ff0c5", fontWeight: 700 }}>Proposed steps</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {proposed.map((t, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: 8, background: "rgba(16,36,28,0.45)", border: "1px solid rgba(127,240,197,0.28)", borderRadius: 8 }}>
                        <div style={{ flex: 1, fontSize: 12, lineHeight: 1.45, color: "var(--fg)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{t}</div>
                        <button
                          onClick={() => setProposed((ps) => { addStep(t); return ps.filter((_, j) => j !== i); })}
                          title="Add this step to the list"
                          style={{ height: 26, padding: "0 10px", border: "1px solid rgba(127,240,197,0.45)", borderRadius: 6, background: "rgba(16,36,28,0.7)", color: "#7ff0c5", fontSize: 11, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}
                        >Add</button>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={() => { addSteps(proposed); setProposed([]); if (!proposedPlan) update({ text: "" }); }}
                      style={{ height: 28, padding: "0 12px", border: "none", borderRadius: 7, background: "#2f7d5b", color: "#eafff5", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                    >Add all + clear notes</button>
                    <button className="ghost-btn" onClick={() => setProposed([])} title="Discard proposed steps" style={{ height: 28, padding: "0 10px", fontSize: 11 }}>Discard steps</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Kanban plan */}
          <div style={card}>
            <div style={sectionHeader}>
              <span>📋</span>
              <span>Plan board</span>
              <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 500, textTransform: "none", color: "var(--fg-muted)" }}>Kanban</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: inline ? "1fr" : "repeat(3, minmax(0, 1fr))", gap: 8 }}>
              {KANBAN_COLUMNS.map((col) => {
                const ref = col.key === "now" ? nowPlanRef : col.key === "next" ? nextPlanRef : laterPlanRef;
                return (
                  <div key={col.key} style={{ display: "flex", flexDirection: "column", gap: 7, minWidth: 0, background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, padding: 9 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 7, height: 7, borderRadius: 999, background: col.color, flexShrink: 0 }} />
                      <span style={{ fontSize: 11, fontWeight: 800, color: "var(--fg-strong)", textTransform: "uppercase" }}>{col.label}</span>
                      <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--fg-muted)" }}>{col.hint}</span>
                    </div>
                    <textarea
                      ref={ref}
                      value={kanbanPlan[col.key]}
                      onChange={(e) => updateKanbanLane(col.key, e.target.value)}
                      placeholder={col.key === "now" ? "- Ship the coherent first batch..." : col.key === "next" ? "- Follow-up batch..." : "- Optional or parked work..."}
                      style={{ ...textareaBase, minHeight: 92, fontSize: 12, background: "var(--bg-input)" }}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Next steps */}
          <div style={card}>
            <div style={{ ...sectionHeader, borderBottom: "none", paddingBottom: 0 }}>
              <span>🎯</span>
              <span>Next steps</span>
              <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 700, color: pendingCount ? "#7ff0c5" : "var(--fg-muted)", border: "1px solid var(--border)", borderRadius: 999, padding: "1px 8px" }}>{pendingCount} pending</span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <textarea
                  ref={newStepRef}
                  value={newStep}
                  onChange={(e) => setNewStep(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addStep(newStep); setNewStep(""); } }}
                  placeholder="Write a step and press Enter…"
                  style={{ ...textareaBase, flex: 1, minHeight: 32 }}
                />
                <button className="ghost-btn" onClick={() => { addStep(newStep); setNewStep(""); }} style={{ height: 32, padding: "0 12px", fontSize: 12, flexShrink: 0 }}>＋ Add</button>
              </div>

              {nb.steps.length === 0 && (
                <div style={{ padding: 14, textAlign: "center", fontSize: 12, color: "var(--fg-muted)", background: "var(--bg-input)", borderRadius: 8, border: "1px dashed var(--border)" }}>
                  No steps yet — add one above, or 🪄 digest your notes below.
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {nb.steps.map((s) => (
                  <div key={s.id} style={{
                    display: "flex", flexDirection: "column", gap: 8,
                    padding: 10,
                    background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8,
                    opacity: s.status === "done" ? 0.6 : 1,
                  }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                      <button
                        onClick={() => setStep(s.id, { status: s.status === "done" ? "pending" : "done" })}
                        title={s.status === "done" ? "Re-open this step" : "Mark done"}
                        style={{ border: "none", background: "transparent", cursor: "pointer", color: statusColor(s), fontSize: 15, lineHeight: "20px", width: 20, padding: 0, flexShrink: 0 }}
                      >{statusIcon(s)}</button>

                      {editingStepId === s.id ? (
                        <textarea
                          ref={editStepRef}
                          value={editingText}
                          onChange={(e) => setEditingText(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEdit(); } else if (e.key === "Escape") { cancelEdit(); } }}
                          onBlur={saveEdit}
                          style={{ ...textareaBase, flex: 1, minHeight: 28 }}
                          autoFocus
                        />
                      ) : (
                        <div
                          onClick={() => startEdit(s)}
                          title="Click to edit"
                          style={{ flex: 1, fontSize: 12.5, lineHeight: 1.5, color: "var(--fg)", textDecoration: s.status === "done" ? "line-through" : "none", whiteSpace: "pre-wrap", wordBreak: "break-word", cursor: "text" }}
                        >
                          {s.text}
                          {s.status === "sent" && <span style={{ display: "inline-block", marginLeft: 8, fontSize: 10, color: "#ffd97a", border: "1px solid rgba(255,217,122,0.45)", borderRadius: 999, padding: "1px 7px" }}>fed to team</span>}
                        </div>
                      )}
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", paddingLeft: 28 }}>
                      {s.status === "pending" && (
                        <button
                          onClick={() => feedStep(s)}
                          title={running ? "Feed now — steers the running team at its next boundary" : "Feed now — dispatches this step as a new goal"}
                          style={{ height: 24, padding: "0 10px", border: "1px solid rgba(255,217,122,0.5)", borderRadius: 6, background: "rgba(38,30,10,0.6)", color: "#ffd97a", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                        >⚡ Feed</button>
                      )}
                      <button className="ghost-btn" onClick={() => moveStep(s.id, -1)} title="Move up" style={{ height: 24, width: 24, padding: 0, fontSize: 10 }}>▲</button>
                      <button className="ghost-btn" onClick={() => moveStep(s.id, 1)} title="Move down" style={{ height: 24, width: 24, padding: 0, fontSize: 10 }}>▼</button>
                      <div style={{ flex: 1 }} />
                      <button className="ghost-btn" onClick={() => removeStep(s.id)} title="Delete step" style={{ height: 24, width: 24, padding: 0, fontSize: 11, color: "#ff8c8c" }}>🗑</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

        </div>
      </div>
  );

  if (inline) return panel;
  return (
    <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(8,12,20,0.6)", zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center" }}>
      {panel}
    </div>
  );
}
