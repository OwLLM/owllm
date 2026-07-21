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

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStickyScroll } from "../../hooks/useStickyScroll";
import ModelPicker, { type AccountsStatusLite } from "./ModelPicker";
import { seedNotebookFromBrief } from "./RunNotebook";
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
  accountsStatus: AccountsStatusLite | null;
  /// Seed supplied by goal-aware onboarding for a newly-created project.
  initialIdea?: string;
  /// Called after BRIEF.md is verified on disk so the parent can
  /// refresh its UI (show "brief: ✓" badge, etc.). Optional.
  onBriefSaved?: () => void;
  /// Project id — needed to persist an assembled team onto the project
  /// (update_project). Without it the "Assemble team" step is hidden.
  projectId?: string;
  /// Agent roles the team can be composed from (base + short description).
  /// Falls back to a sensible built-in set when not provided.
  availableRoles?: { base: string; description: string }[];
  /// Called after a team is applied to the project so the parent reloads
  /// the roster + canvas.
  onTeamApplied?: () => void;
  /// Existing projects already have a runnable team. Their brainstorm must
  /// finish in the Notebook, not ask the user to create another team.
  hasTeam?: boolean;
  /// Close the brainstorm and reveal this project's prepared Notebook.
  onOpenNotebook?: () => void;
};

type LogLine = { kind: "text" | "tool" | "system"; text: string };
type ProposedAgent = { name: string; base: string; why?: string };
type ConversationTurn = { role: "user" | "assistant"; content: string };

// Where a brainstorm's co-founder conversation is checkpointed on disk so a
// session that stops for any reason (crash, close, refresh) can be resumed
// instead of lost. Lives next to BRIEF.md, under the project's .owllm/ dir.
const BRAINSTORM_STATE_PATH = ".owllm/brainstorm.json";
type BrainstormState = {
  v: 2;
  idea: string;
  selectedModelId: string;
  convHistory: ConversationTurn[];
  chatInput: string;
  lines: LogLine[];
  done: boolean;
  proposedTeam: ProposedAgent[] | null;
  teamApplied: boolean;
  briefText: string;
  boardView: boolean;
  error: string | null;
  activeOperation: "brainstorm" | "team" | "apply" | null;
  updatedAt: number;
};
type BriefFeature = { feature: string; priority: "v1" | "v2" | "opportunity" | "drop" };

function brainstormStorageKey(projectId?: string, projectCwd?: string): string {
  return `owllm:brainstorm-state:${projectId || projectCwd || "unsaved-project"}`;
}

function parseSavedBrainstorm(raw: string | null): BrainstormState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Omit<BrainstormState, "v">> & { v?: number };
    if (!value || (value.v !== 1 && value.v !== 2)) return null;
    const convHistory = Array.isArray(value.convHistory)
      ? value.convHistory.filter((turn): turn is ConversationTurn =>
          !!turn && (turn.role === "user" || turn.role === "assistant") && typeof turn.content === "string")
      : [];
    const lines = Array.isArray(value.lines)
      ? value.lines.filter((line): line is LogLine =>
          !!line && (line.kind === "text" || line.kind === "tool" || line.kind === "system") && typeof line.text === "string")
      : [];
    const proposedTeam = Array.isArray(value.proposedTeam)
      ? value.proposedTeam.filter((agent): agent is ProposedAgent =>
          !!agent && typeof agent.name === "string" && typeof agent.base === "string")
      : null;
    return {
      v: 2,
      idea: typeof value.idea === "string" ? value.idea : "",
      selectedModelId: typeof value.selectedModelId === "string" ? value.selectedModelId : "",
      convHistory,
      chatInput: typeof value.chatInput === "string" ? value.chatInput : "",
      lines,
      done: value.done === true,
      proposedTeam,
      teamApplied: value.teamApplied === true,
      briefText: typeof value.briefText === "string" ? value.briefText : "",
      boardView: value.boardView === true,
      error: typeof value.error === "string" ? value.error : null,
      activeOperation: value.activeOperation === "brainstorm" || value.activeOperation === "team" || value.activeOperation === "apply"
        ? value.activeOperation
        : null,
      updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

// Parse the "## Feature Priority" table out of BRIEF.md into structured rows so
// the board view can show features as columns. Forgiving: returns [] when the
// section/table isn't there (board just stays empty, no crash).
function parseBriefFeatures(brief: string): BriefFeature[] {
  const out: BriefFeature[] = [];
  if (!brief) return out;
  const lines = brief.split("\n");
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^##\s+feature priority/i.test(line)) { inSection = true; continue; }
    if (inSection && /^##\s+/.test(line)) break; // next section ends it
    if (!inSection || !line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map(c => c.trim());
    if (cells.length < 2) continue;
    const feature = cells[0];
    const prioRaw = cells[cells.length - 1].toLowerCase();
    if (!feature || /^feature$/i.test(feature) || /^[-:\s]+$/.test(feature)) continue; // header/separator
    const priority: BriefFeature["priority"] =
      prioRaw.includes("v1") ? "v1"
      : prioRaw.includes("opportunity") ? "opportunity"
      : prioRaw.includes("v2") ? "v2"
      : prioRaw.includes("drop") ? "drop"
      : "v2";
    out.push({ feature, priority });
  }
  return out;
}

// Default building-block roles when the parent doesn't pass the live set.
const DEFAULT_ROLES: { base: string; description: string }[] = [
  { base: "orchestrator", description: "leads the team, plans, and dispatches work to specialists" },
  { base: "coder", description: "writes and edits code" },
  { base: "critic", description: "reviews work, challenges assumptions, catches problems early" },
  { base: "researcher", description: "investigates, gathers facts, reads docs/APIs" },
  { base: "operator", description: "runs tools + external actions (shell, web, integrations)" },
  { base: "documentation", description: "writes user-facing and developer docs" },
];

// Pull a JSON team array out of the model's reply (tolerates prose/fences around
// it). Guarantees exactly one orchestrator (promotes the first agent if none).
function parseProposedTeam(reply: string): ProposedAgent[] | null {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const arr = JSON.parse(reply.slice(start, end + 1));
    if (!Array.isArray(arr)) return null;
    const out: ProposedAgent[] = arr
      .filter((a: any) => a && typeof a.name === "string" && typeof a.base === "string" && a.name.trim() && a.base.trim())
      .map((a: any) => ({
        name: String(a.name).trim(),
        base: String(a.base).trim().toLowerCase(),
        why: typeof a.why === "string" ? a.why : undefined,
      }));
    if (out.length === 0) return null;
    if (!out.some(a => a.base === "orchestrator")) out[0].base = "orchestrator";
    return out;
  } catch { return null; }
}

export default function BrainstormPanel(props: Props) {
  const { open, onClose, projectCwd, brainstormerRole, modelId, port, models, accountsStatus,
    initialIdea, onBriefSaved, projectId, availableRoles, onTeamApplied, hasTeam = false, onOpenNotebook } = props;

  const [idea, setIdea] = useState("");
  const [selectedModelId, setSelectedModelId] = useState(modelId);
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Idea → team → launch (step 2 of the brainstorm evolution).
  const [proposing, setProposing] = useState(false);
  const [proposedTeam, setProposedTeam] = useState<ProposedAgent[] | null>(null);
  const [applying, setApplying] = useState(false);
  const [teamApplied, setTeamApplied] = useState(false);
  const [notebookStepCount, setNotebookStepCount] = useState(0);
  // Conversational co-founder (step 3): a back-and-forth before/around the brief.
  const [convHistory, setConvHistory] = useState<ConversationTurn[]>([]);
  const [chatInput, setChatInput] = useState("");
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  // Living visual brief (step 4): the current BRIEF.md text + a board/log toggle.
  const [briefText, setBriefText] = useState("");
  const [boardView, setBoardView] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const hydratedRef = useRef(false);
  const loadedTargetRef = useRef("");
  const persistTimerRef = useRef<number | null>(null);
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());
  const checkpointRef = useRef<{
    targetKey: string;
    storageKey: string;
    cwd: string;
    state: BrainstormState;
  } | null>(null);
  const targetKey = `${projectId ?? ""}\n${projectCwd}`;
  const storageKey = brainstormStorageKey(projectId, projectCwd);
  // Sticky auto-scroll: land at the bottom when the panel (re)opens (openKey =
  // open) and follow new log lines only while the user is near the bottom
  // (contentKey = line count) — never yank a user who scrolled up to read.
  const logSticky = useStickyScroll(lines.length, open);

  const liveState: BrainstormState = {
    v: 2,
    idea,
    selectedModelId,
    convHistory,
    chatInput,
    lines,
    done,
    proposedTeam,
    teamApplied,
    briefText,
    boardView,
    error,
    activeOperation: running ? "brainstorm" : proposing ? "team" : applying ? "apply" : null,
    updatedAt: Date.now(),
  };
  if (hydratedRef.current && loadedTargetRef.current === targetKey) {
    checkpointRef.current = { targetKey, storageKey, cwd: projectCwd, state: liveState };
  }

  // localStorage is synchronous, so even a fast page switch preserves the
  // latest draft. Project-disk writes are serialized to prevent an older,
  // slower write from overwriting a newer checkpoint.
  const queueCheckpoint = (checkpoint = checkpointRef.current): Promise<void> => {
    if (!checkpoint) return Promise.resolve();
    try { localStorage.setItem(checkpoint.storageKey, JSON.stringify(checkpoint.state)); } catch { /* best effort */ }
    if (!checkpoint.cwd) return Promise.resolve();
    writeChainRef.current = writeChainRef.current
      .catch(() => undefined)
      .then(async () => {
        try {
          await invoke("tool_write_file", {
            path: BRAINSTORM_STATE_PATH,
            content: JSON.stringify(checkpoint.state, null, 2),
            cwd: checkpoint.cwd,
          });
        } catch { /* best-effort checkpoint */ }
      });
    return writeChainRef.current;
  };

  // Match the other chat composers: start compact, grow with multiline input,
  // shrink again after Send, and cap the height before enabling inner scroll.
  useLayoutEffect(() => {
    const ta = chatInputRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.max(38, Math.min(ta.scrollHeight, 180))}px`;
  }, [chatInput]);

  // Reset when reopened, then restore the newest local/disk checkpoint. Version
  // 1 checkpoints are accepted, while version 2 restores every editable and
  // generated field even when no conversation turn has been completed yet.
  useEffect(() => {
    if (!open) {
      if (hydratedRef.current) void queueCheckpoint();
      hydratedRef.current = false;
      loadedTargetRef.current = "";
      setHydrated(false);
      return;
    }
    if (hydratedRef.current && loadedTargetRef.current !== targetKey) void queueCheckpoint();
    hydratedRef.current = false;
    loadedTargetRef.current = "";
    setHydrated(false);
    if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current);
    setRunning(false);
    setDone(false);
    setError(null);
    setLines([]);
    setProposing(false);
    setProposedTeam(null);
    setApplying(false);
    setTeamApplied(false);
    setNotebookStepCount(0);
    setConvHistory([]);
    setChatInput("");
    setBriefText("");
    setBoardView(false);
    const modelKey = projectId ? `owllm:brainstorm-model:${projectId}` : "";
    let savedModel = "";
    try { if (modelKey) savedModel = localStorage.getItem(modelKey) ?? ""; } catch { /* ignore */ }
    setSelectedModelId(savedModel || modelId);
    setIdea(initialIdea ?? "");
    let cancelled = false;
    (async () => {
      let localState: BrainstormState | null = null;
      try { localState = parseSavedBrainstorm(localStorage.getItem(storageKey)); } catch { /* ignore */ }
      let diskState: BrainstormState | null = null;
      if (projectCwd) {
        try {
          const raw = await invoke<string>("tool_read_file", { path: BRAINSTORM_STATE_PATH, cwd: projectCwd });
          diskState = parseSavedBrainstorm(raw);
        } catch { /* no checkpoint yet — fresh start */ }
      }
      if (cancelled) return;
      let st = localState;
      if (diskState && (!st || diskState.updatedAt > st.updatedAt)) st = diskState;

      const restoredHistory = st?.convHistory ?? [];
      let restoredLines = st?.lines ?? [];
      if (restoredLines.length === 0 && restoredHistory.length > 0) {
        restoredLines = [{
          kind: "system",
          text: "↩ Resumed your saved brainstorm — pick up below, or 🆕 start fresh to begin a new idea.",
        }];
        for (const turn of restoredHistory) {
          if (turn.role === "user") restoredLines.push({ kind: "system", text: `\n🧑 ${turn.content}\n` });
          else restoredLines.push({ kind: "text", text: turn.content });
        }
      }
      if (st?.activeOperation) {
        restoredLines = [...restoredLines, {
          kind: "system",
          text: "\n↩ The previous operation stopped when this page closed. Its input and partial output were saved; you can continue from here.",
        }];
      }

      let restoredBrief = st?.briefText ?? "";
      if (projectCwd && st?.done) {
        try {
          const brief = await invoke<string>("tool_read_file", { path: "BRIEF.md", cwd: projectCwd });
          if (brief.trim()) restoredBrief = brief;
        } catch { /* saved brief text remains available */ }
      }
      if (cancelled) return;
      setIdea(st?.idea ?? initialIdea ?? "");
      setSelectedModelId(st?.selectedModelId || savedModel || modelId);
      setConvHistory(restoredHistory);
      setChatInput(st?.chatInput ?? "");
      setLines(restoredLines);
      setDone(st?.done ?? false);
      setProposedTeam(st?.proposedTeam ?? null);
      setTeamApplied(st?.teamApplied ?? false);
      if (st?.done && restoredBrief && projectId && hasTeam) {
        setNotebookStepCount(seedNotebookFromBrief(projectId, restoredBrief));
      }
      setBriefText(restoredBrief);
      setBoardView(st?.boardView ?? false);
      setError(st?.error ?? null);
      loadedTargetRef.current = targetKey;
      hydratedRef.current = true;
      setHydrated(true);
    })();
    return () => { cancelled = true; };
  }, [open, projectCwd, projectId, initialIdea, modelId, storageKey, targetKey]);

  // Debounce normal edits, while the unmount cleanup and close buttons flush
  // synchronously to localStorage before navigation can destroy the component.
  useEffect(() => {
    if (!open || !hydrated || loadedTargetRef.current !== targetKey) return;
    if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      void queueCheckpoint();
    }, 300);
    return () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [open, hydrated, targetKey, idea, selectedModelId, convHistory, chatInput, lines, done,
    proposedTeam, teamApplied, briefText, boardView, error, running, proposing, applying]);

  useEffect(() => () => {
    if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current);
    if (hydratedRef.current) void queueCheckpoint();
  }, []);

  const closeAndSave = () => {
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    void queueCheckpoint();
    onClose();
  };

  if (!open) return null;

  const activeModelId = selectedModelId.trim();
  const selectBrainstormModel = (next: string) => {
    setSelectedModelId(next);
    if (!projectId) return;
    try { localStorage.setItem(`owllm:brainstorm-model:${projectId}`, next); } catch { /* ignore */ }
  };

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

  // Clear the current conversation AND its on-disk checkpoint so the next open
  // starts blank instead of resuming. (BRIEF.md is left alone — it's the brief,
  // not the transcript.)
  const startFresh = async () => {
    if (running) return;
    setConvHistory([]);
    setLines([]);
    setProposedTeam(null);
    setTeamApplied(false);
    setNotebookStepCount(0);
    setError(null);
    setIdea("");
    setChatInput("");
    setBriefText("");
    setBoardView(false);
    const fresh: BrainstormState = {
      v: 2,
      idea: "",
      selectedModelId,
      convHistory: [],
      chatInput: "",
      lines: [],
      done: false,
      proposedTeam: null,
      teamApplied: false,
      briefText: "",
      boardView: false,
      error: null,
      activeOperation: null,
      updatedAt: Date.now(),
    };
    const checkpoint = { targetKey, storageKey, cwd: projectCwd, state: fresh };
    checkpointRef.current = checkpoint;
    await queueCheckpoint(checkpoint);
  };

  // Conversational co-founder (step 3): wrap the brainstormer role so it FIRST
  // talks (clarifies + challenges like a co-founder/skeptic), then runs the
  // research workflow + writes BRIEF.md when the user is ready.
  const convSystemPrompt = brainstormerRole?.systemPrompt
    ? [
        "You are the user's CO-FOUNDER and a friendly SKEPTIC, scoping their idea before any code is written.",
        "Hold a short back-and-forth FIRST: ask 1-3 sharp questions per turn — clarify what they actually want and why, and challenge scope and assumptions. Be concise and direct, not a wall of text.",
        // Mode-neutral framing: the role's STEP 0 decides NEW vs IMPROVEMENT.
        // Do NOT presuppose competitor research or an ICP — an improvement to
        // THIS app needs neither (inspect the code and plan the change), and
        // forcing that framing here is what made the brainstormer web-search
        // even for simple improvements.
        "Before doing anything, decide the MODE per STEP 0 of your role below: is this a brand-NEW app, or an IMPROVEMENT to the app that already exists in this project? An improvement (add/fix/change a feature, 'the app', a named screen/button) needs NO competitor web research — inspect the codebase and plan the change. Only a brand-new product gets competitor research.",
        "Do NOT start any tools yet — wait until you've clarified enough, OR the user tells you to (e.g. 'go', 'run', 'proceed', 'looks good'). THEN follow the matching track in your role below and WRITE the ordered PLAN to BRIEF.md.",
        "After BRIEF.md exists, the user may keep talking to refine it — re-write BRIEF.md to reflect their changes.",
        "",
        "--- YOUR ROLE (follow it once you're ready) ---",
        brainstormerRole.systemPrompt,
      ].join("\n")
    : "";

  // One conversational turn: stream the reply with full history, remember it,
  // and re-check whether BRIEF.md now exists on disk.
  const runTurn = async (userText: string) => {
    if (!convSystemPrompt || !activeModelId || running) return;
    setRunning(true);
    setError(null);
    append("system", `\n🧑 ${userText}\n`);
    const priorHistory = convHistory;
    const historyWithUser: ConversationTurn[] = [
      ...priorHistory,
      { role: "user", content: userText },
    ];
    // Save the user's turn before starting the provider. If the page changes or
    // the provider fails, the prompt and any subsequently streamed text remain.
    setConvHistory(historyWithUser);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const onThought = (channel: string, role: string, _delta: string) => {
      if (channel.startsWith("tool:")) append("tool", `🛠 ${role}`);
    };
    let reply = "";
    const onDelta = (delta: string) => { reply += delta; append("text", delta); };
    try {
      await streamChatCompletion(
        port, activeModelId, providerFor(activeModelId, models),
        convSystemPrompt, userText, brainstormerRole?.defaultTemperature ?? 0.4,
        ctrl.signal, onDelta, projectCwd,
        priorHistory, undefined, onThought,
        // Pass the brainstormer's tool_allowlist so the Claude CLI sub path
        // gets `--allowedTools "WebSearch WebFetch Write Read Grep Glob Bash"`
        // and pre-approves the write — without this the CLI runs in default
        // permission mode and silently blocks writing BRIEF.md.
        brainstormerRole?.toolAllowlist,
      );
      const newHistory: ConversationTurn[] = [...historyWithUser, { role: "assistant", content: reply }];
      setConvHistory(newHistory);
      // Did the brief land (or get refined) this turn?
      let briefOnDisk = false;
      let briefTextOnDisk = "";
      try {
        const text = await invoke<string>("tool_read_file", { path: "BRIEF.md", cwd: projectCwd });
        briefOnDisk = text.trim().length > 0;
        if (briefOnDisk) {
          briefTextOnDisk = text;
          setBriefText(text);   // keep the live board in sync each turn
        }
      } catch { /* not yet */ }
      if (briefOnDisk) {
        if (projectId && hasTeam) setNotebookStepCount(seedNotebookFromBrief(projectId, briefTextOnDisk));
        if (!done) {
          setDone(true);
          append("system", hasTeam
            ? `\n✓ BRIEF.md saved and its implementation steps were added to this project's Notebook.`
            : `\n✓ BRIEF.md saved. This project has no team yet; assemble one below.`);
          onBriefSaved?.();
        }
      }
    } catch (e: any) {
      if (reply) setConvHistory([...historyWithUser, { role: "assistant", content: reply }]);
      if (e?.name === "AbortError") append("system", "\n⏹ Cancelled.");
      else setError(String(e?.message ?? e));
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const runBrainstorm = async () => {
    const trimmed = idea.trim();
    if (!trimmed) { setError("Enter a generic idea first (one or two sentences is enough)."); return; }
    if (!projectCwd) { setError("This project has no location set. Pick a folder first so the brainstormer can save BRIEF.md."); return; }
    if (!brainstormerRole?.systemPrompt) { setError("Brainstormer role not loaded (resources/agents/roles/brainstormer.yaml)."); return; }
    if (!activeModelId) { setError("Pick the model the Brainstorm agent should use."); return; }
    setDone(false);
    setConvHistory([]);
    setLines([{ kind: "system", text: `🧠 Brainstorm in ${projectCwd} using ${activeModelId}. I'll ask a couple of questions first — answer below, then say "go" when you want me to write the plan.` }]);
    await runTurn([
      `Project location (BRIEF.md goes here; for a brand-new app, brainstorm/<png> screenshots too): ${projectCwd}`,
      "",
      `My idea: ${trimmed}`,
      "",
      "Start as my co-founder: ask me your sharpest 1-3 questions (no tools yet).",
    ].join("\n"));
  };

  const sendFollowup = async () => {
    const t = chatInput.trim();
    if (!t || running) return;
    setChatInput("");
    await runTurn(t);
  };

  const cancel = () => {
    abortRef.current?.abort();
  };

  // ---- Idea → team → launch ----
  // Read the brief and propose a team to BUILD it. Output is a JSON roster the
  // user reviews before applying.
  const assembleTeam = async () => {
    if (proposing || applying) return;
    setProposing(true);
    setError(null);
    setProposedTeam(null);
    try {
      const brief = await invoke<string>("tool_read_file", { path: "BRIEF.md", cwd: projectCwd }).catch(() => "");
      const roles = (availableRoles && availableRoles.length ? availableRoles : DEFAULT_ROLES)
        .map(r => `- ${r.base}: ${r.description}`).join("\n");
      const sys = "You assemble a small agent team to BUILD a software project from a brief. You reply with ONLY a JSON array — no prose, no markdown fences.";
      const user = [
        "Compose a team of 4-7 agents to build the project described below.",
        'ALWAYS include EXACTLY ONE agent with base "orchestrator" (it leads + dispatches the others).',
        "Choose the rest from the available roles to cover what THIS project actually needs.",
        "Give each a short, friendly, project-specific name.",
        "",
        "Available roles (base: what it does):",
        roles,
        "",
        "BRIEF:",
        (brief.trim() ? brief.slice(0, 8000) : `(brief unavailable — infer from the idea: ${idea})`),
        "",
        "Reply with ONLY this shape:",
        '[{"name":"Atlas","base":"orchestrator","why":"plans and dispatches"},{"name":"API Coder","base":"coder","why":"backend + data model"}]',
      ].join("\n");
      let reply = "";
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      await streamChatCompletion(
        port, activeModelId, providerFor(activeModelId, models),
        sys, user, 0.3, ctrl.signal,
        (d) => { reply += d; },
        projectCwd,
      );
      const team = parseProposedTeam(reply);
      if (!team) {
        setError("Couldn't read a team from the model's reply — try again, or build the team on the canvas.");
      } else {
        setProposedTeam(team);
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") setError("Team assembly failed: " + String(e?.message ?? e));
    } finally {
      setProposing(false);
      abortRef.current = null;
    }
  };

  // Persist the proposed roster onto the project (names + roles + an
  // orchestrator→specialists graph) so it survives restart and is runnable.
  const applyTeam = async () => {
    if (!proposedTeam || applying || !projectId) return;
    setApplying(true);
    setError(null);
    try {
      const orch = proposedTeam.find(a => a.base === "orchestrator") ?? proposedTeam[0];
      const edges = proposedTeam
        .filter(a => a.name !== orch.name)
        .map(a => ({ source: orch.name, target: a.name }));
      await invoke("update_project", {
        input: {
          id: projectId,
          team: proposedTeam.map(a => a.name),
          graph_json: JSON.stringify({
            edges,
            roster: proposedTeam.map(a => ({ name: a.name, base: a.base })),
          }),
        },
      });
      setTeamApplied(true);
      onTeamApplied?.();
      append("system", `\n🤝 Team applied (${proposedTeam.length} agents). Close this panel — the canvas now shows your team. Hit Run to build.`);
    } catch (e: any) {
      setError("Apply failed: " + String(e?.message ?? e));
    } finally {
      setApplying(false);
    }
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
      onClick={(e) => { if (e.target === e.currentTarget && !running) closeAndSave(); }}
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
              <div style={{ color: "var(--fg-strong)", fontWeight: 700, fontSize: 15 }}>Project Brainstorm</div>
              <div style={{ color: "var(--fg-muted)", fontSize: 11, marginTop: 2 }}>
                {hasTeam
                  ? "Co-founder chat → BRIEF.md → implementation Notebook"
                  : "Co-founder chat → BRIEF.md → assemble the first team"}
              </div>
            </div>
          </div>
          <button
            onClick={closeAndSave}
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
            <label style={{ color: "var(--fg)", fontSize: 12, fontWeight: 600, display: "block", marginBottom: 6 }}>
              Your idea (one or two sentences — be generic, the brainstormer fills in the rest)
            </label>
            <textarea
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              disabled={running || convHistory.length > 0}
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

          <div>
            <label style={{ color: "var(--fg)", fontSize: 12, fontWeight: 600, display: "block", marginBottom: 6 }}>
              Brainstorm model
            </label>
            <ModelPicker
              value={activeModelId}
              onChange={selectBrainstormModel}
              models={models}
              status={accountsStatus}
              disabled={running}
              fallbackLabel="Pick a model for this brainstorm"
            />
            <div style={{ marginTop: 5, color: "var(--fg-muted)", fontSize: 11 }}>
              Saved for this project. It can be different from the team and orchestrator models.
            </div>
          </div>

          {/* Status / context strip */}
          <div style={{
            fontSize: 11, color: "var(--fg-muted)",
            display: "flex", gap: 12, flexWrap: "wrap",
          }}>
            <span>📂 {projectCwd || <em style={{ color: "#ff9f9f" }}>no project location set</em>}</span>
            <span>🤖 {activeModelId || <em style={{ color: "#ff9f9f" }}>no model</em>}</span>
            <span>🔑 Brave Search key required (set in Accounts page)</span>
          </div>

          {/* Action row */}
          <div style={{ display: "flex", gap: 8 }}>
            {!running && convHistory.length === 0 && (
              <button
                onClick={runBrainstorm}
                disabled={!idea.trim() || !projectCwd || !activeModelId || !brainstormerRole?.systemPrompt}
                style={{
                  padding: "8px 16px", fontSize: 13, fontWeight: 700,
                  background: "linear-gradient(180deg, #6b7fff, #4a5fd9)",
                  color: "#fff",
                  border: "none", borderRadius: 6,
                  cursor: (idea.trim() && projectCwd && activeModelId) ? "pointer" : "not-allowed",
                  opacity: (idea.trim() && projectCwd && activeModelId) ? 1 : 0.5,
                }}
              >
                🚀 Start brainstorm
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
            {!running && convHistory.length > 0 && (
              <button
                onClick={startFresh}
                title="Clear this conversation and its saved checkpoint to start a new idea"
                style={{
                  padding: "8px 16px", fontSize: 13, fontWeight: 700,
                  background: "transparent",
                  color: "var(--fg)",
                  border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                🆕 Start fresh
              </button>
            )}
            {done && !teamApplied && (
              <>
                {hasTeam ? (
                  <button
                    data-ui="BrainstormOpenNotebook"
                    onClick={() => { void queueCheckpoint(); onOpenNotebook?.(); }}
                    disabled={!projectId}
                    title="Open this project's implementation queue"
                    style={{
                      padding: "8px 16px", fontSize: 13, fontWeight: 700,
                      background: "linear-gradient(180deg, var(--accent), rgba(var(--accent-rgb),0.72))",
                      color: "var(--accent-fg)", border: "none", borderRadius: 6,
                      cursor: projectId ? "pointer" : "not-allowed", opacity: projectId ? 1 : 0.55,
                    }}
                  >📓 Open implementation Notebook{notebookStepCount > 0 ? ` · ${notebookStepCount} new` : ""}</button>
                ) : projectId && !proposedTeam && (
                  <button
                    onClick={assembleTeam}
                    disabled={proposing}
                    style={{
                      padding: "8px 16px", fontSize: 13, fontWeight: 700,
                      background: "linear-gradient(180deg, #36d27a, #1faa5c)",
                      color: "#062012", border: "none", borderRadius: 6,
                      cursor: proposing ? "wait" : "pointer", opacity: proposing ? 0.7 : 1,
                    }}
                  >{proposing ? "🤝 Assembling team…" : "🤝 Assemble first team from brief"}</button>
                )}
                <button
                  onClick={closeAndSave}
                  style={{
                    padding: "8px 16px", fontSize: 13, fontWeight: 700,
                    background: "rgba(80, 200, 120, 0.18)", color: "#a0f0c0",
                    border: "1px solid rgba(100, 220, 140, 0.4)", borderRadius: 6, cursor: "pointer",
                  }}
                >✓ Brief done — Close</button>
              </>
            )}
            {teamApplied && (
              <button
                onClick={closeAndSave}
                style={{
                  padding: "8px 16px", fontSize: 13, fontWeight: 700,
                  background: "rgba(80, 200, 120, 0.18)", color: "#a0f0c0",
                  border: "1px solid rgba(100, 220, 140, 0.4)", borderRadius: 6, cursor: "pointer",
                }}
              >✓ Team applied — Close &amp; open canvas</button>
            )}
          </div>

          {/* Proposed team — review before applying (idea → team → launch). */}
          {proposedTeam && !teamApplied && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, background: "rgba(10,30,20,0.5)", border: "1px solid rgba(100,220,140,0.3)", borderRadius: 8 }}>
              <div style={{ color: "#bfeed0", fontSize: 12, fontWeight: 700 }}>
                Proposed team — review, then apply. You can change each agent's model on the canvas before running.
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {proposedTeam.map((a, i) => (
                  <div key={i} style={{ minWidth: 160, flex: "1 1 200px", padding: "8px 10px", background: "rgba(8,11,18,0.85)", border: `1px solid ${a.base === "orchestrator" ? "rgba(255,210,120,0.55)" : "rgba(255,255,255,0.12)"}`, borderRadius: 6 }}>
                    <div style={{ color: "var(--fg-strong)", fontWeight: 700, fontSize: 12.5 }}>{a.base === "orchestrator" ? "⭐ " : ""}{a.name}</div>
                    <div style={{ color: "#8aa0c0", fontSize: 11, fontFamily: "Consolas, monospace" }}>{a.base}</div>
                    {a.why && <div style={{ color: "var(--fg-muted)", fontSize: 11, marginTop: 2 }}>{a.why}</div>}
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button onClick={applyTeam} disabled={applying} style={{ padding: "7px 14px", fontSize: 12.5, fontWeight: 700, background: "linear-gradient(180deg, #6b7fff, #4a5fd9)", color: "#fff", border: "none", borderRadius: 6, cursor: applying ? "wait" : "pointer", opacity: applying ? 0.7 : 1 }}>{applying ? "Applying…" : "✅ Apply to project & open"}</button>
                <button onClick={assembleTeam} disabled={proposing || applying} style={{ padding: "7px 14px", fontSize: 12.5, fontWeight: 600, background: "transparent", color: "var(--fg)", border: "1px solid rgba(255,255,255,0.18)", borderRadius: 6, cursor: (proposing || applying) ? "wait" : "pointer" }}>🔄 Re-propose</button>
              </div>
            </div>
          )}

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

          {/* View toggle — conversation log vs the living feature board. */}
          {done && (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ color: "var(--fg-muted)", fontSize: 11 }}>View:</span>
              <button onClick={() => setBoardView(false)} style={{ padding: "3px 10px", fontSize: 11, borderRadius: 5, border: "1px solid rgba(255,255,255,0.15)", background: boardView ? "transparent" : "rgba(107,127,255,0.25)", color: "#cfd4e1", cursor: "pointer" }}>📄 Conversation</button>
              <button onClick={() => setBoardView(true)} style={{ padding: "3px 10px", fontSize: 11, borderRadius: 5, border: "1px solid rgba(255,255,255,0.15)", background: boardView ? "rgba(107,127,255,0.25)" : "transparent", color: "#cfd4e1", cursor: "pointer" }}>📋 Board</button>
              {boardView && <span style={{ color: "var(--fg-dim)", fontSize: 10.5 }}>live — refine the brief in chat and it updates</span>}
            </div>
          )}

          {/* Living visual brief — feature columns parsed from BRIEF.md. */}
          {done && boardView && (() => {
            const features = parseBriefFeatures(briefText);
            const cols = [
              { key: "v1", title: "🟢 v1 — must have", color: "#36d27a", items: features.filter(f => f.priority === "v1") },
              { key: "opportunity", title: "💡 opportunity", color: "#ffd97a", items: features.filter(f => f.priority === "opportunity") },
              { key: "v2", title: "🟡 v2 — later", color: "var(--fg-muted)", items: features.filter(f => f.priority === "v2") },
            ];
            return (
              <div style={{ flex: 1, minHeight: 200, maxHeight: "50vh", overflowY: "auto", display: "flex", gap: 10 }}>
                {features.length === 0 ? (
                  <div style={{ color: "var(--fg-muted)", fontSize: 12, padding: 12 }}>
                    No Feature Priority table in BRIEF.md yet — ask the co-founder to add one, or use the Conversation view.
                  </div>
                ) : cols.map(col => (
                  <div key={col.key} style={{ flex: 1, minWidth: 0, background: "rgba(8,11,18,0.92)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ color: col.color, fontSize: 12, fontWeight: 700 }}>{col.title} · {col.items.length}</div>
                    {col.items.length === 0
                      ? <div style={{ color: "var(--fg-dim)", fontSize: 11, fontStyle: "italic" }}>—</div>
                      : col.items.map((f, i) => (
                        <div key={i} style={{ background: "rgba(20,26,40,0.9)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "7px 9px", fontSize: 12, color: "#e6ebf7" }}>{f.feature}</div>
                      ))}
                  </div>
                ))}
              </div>
            );
          })()}

          {/* Log viewer */}
          {!(done && boardView) && (
          <div
            ref={logSticky.ref}
            onScroll={logSticky.onScroll}
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
              <div style={{ color: "var(--fg-dim)", fontStyle: "italic" }}>
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
          )}

          {/* Conversational input — appears once the co-founder chat has started.
              The user answers questions, refines, or says "go" to research. */}
          {convHistory.length > 0 && (
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
              <textarea
                ref={chatInputRef}
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendFollowup(); } }}
                disabled={running}
                rows={1}
                placeholder={running ? "Co-founder is thinking…" : (done
                  ? (hasTeam ? "Refine the brief, or open its implementation Notebook above…" : "Refine the brief, or assemble the first team above…")
                  : "Answer, push back, or say ‘go’ to research + write the brief…")}
                style={{
                  flex: 1, minWidth: 0, minHeight: 38, maxHeight: 180,
                  padding: "9px 12px", background: "rgba(10,14,22,0.8)",
                  color: "#e6ebf7", border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 6, fontSize: 13, lineHeight: 1.45,
                  fontFamily: "inherit", resize: "none", outline: "none",
                  overflowY: "auto",
                }}
              />
              <button
                onClick={sendFollowup}
                disabled={running || !chatInput.trim()}
                style={{ padding: "0 18px", fontSize: 13, fontWeight: 700, background: "linear-gradient(180deg, #6b7fff, #4a5fd9)", color: "#fff", border: "none", borderRadius: 6, cursor: (running || !chatInput.trim()) ? "not-allowed" : "pointer", opacity: (running || !chatInput.trim()) ? 0.5 : 1 }}
              >Send</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
