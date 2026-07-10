// CodePage — OWLLM-native coding agent.
//
// Rebuilt 2026-06-06 from a mock VSCodium/Cline launcher into a REAL
// coding agent on OWLLM's own engine. No bundled IDE, no Cline embed —
// it drives the shared `streamLocalChat` loop (native GGUF tool-calling)
// against the user's chosen workspace, so the local model can read,
// search, edit and create files and run shell commands in that folder.
// Cline's card-based UX is inspiration for later phases (file tree, live
// diffs, task Kanban); Phase 1 is the working agent core.
import { useEffect, useRef, useState, type CSSProperties, type ClipboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChatBubble, ToolEventCard } from "../../components/ChatBubble";
import PublishCards from "./PublishCards";
import ModelPicker, { type AccountsStatusLite } from "./ModelPicker";
import { getServerCtx } from "../core/serverContext";
import { chatRuntime } from "../../runtime/chatRuntime";
import { useChatSession } from "../../runtime/useChatSession";
import { useStickyScroll } from "../../hooks/useStickyScroll";
import { streamLocalChat, streamChatCompletion, providerFor, openaiUserContent, imageAttachments, fileToImageAttachment, formatDirectivesBlock, type Directive, type Attachment, type ModelInfo, type ServerStatus, type HistoryItem } from "./dispatch";
import type { ToolCall, ToolExecResult } from "./localTools";
import { getBrowserStateLine, refreshBrowserState, retrieveScopedTeamMemoryPack, logScopedTeamWork, type TeamMemoryPack } from "./localTools";
import { enrichInstructionWithMemory } from "./teamMemoryFormat";
import CodeSidePanel, { type CodeAgentMode } from "./CodeSidePanel";
import RunNotebook, { takeNextAutoStep, autoFeedWouldRun } from "./RunNotebook";
import { RunTimerChip } from "./RunTimer";
import PtyTerminal from "../advanced/PtyTerminal";
import BrowserPanel from "./BrowserPanel";
import {
  wslStatus, wslIsolationGet, wslIsolationSet, wslCreateProject, wslListProjects,
  wslToolchainStatus, wslProvision, wslInstall, toolchainReady,
  isWslPath, type WslStatus, type WslIsolation, type WslProject, type WslToolchain,
} from "./wslIsolation";
import { isolationBadge } from "./isolationBadge";
import { githubStatus, githubConnect, githubDisconnect, GITHUB_TOKEN_URL, GITHUB_CHANGED_EVENT, type GithubStatus } from "./github";
import {
  sandboxSyncLogins, sandboxStatus, sandboxCreateProject, sandboxListProjects,
  sandboxProvision, sandboxLoginStatus, sandboxConvertProject,
  engineLabel, mirrorReportLines, type SandboxStatus, type SandboxProject,
} from "./isolation";

type Msg = {
  role: "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  kind?: "tool" | "terminal";
  title?: string;
  status?: "ok" | "error" | "running";
  /// Which agent conversation owns this message. Stamped automatically at the
  /// setMessages / setSecondaryMessages choke points, so EVERY message carries
  /// its owner regardless of where it was created (send, tool card, forward,
  /// memory pack). The two conversations share the same project/session but keep
  /// fully independent, owner-tagged histories.
  owner?: "primary" | "secondary";
  /// Transient bubble shown immediately when a run starts so the user sees
  /// activity before the first token/tool arrives. Removed once real output
  /// begins or the turn ends.
  placeholder?: boolean;
  ts: number;
};

const CODING_SYSTEM = (ws: string) =>
  `You are OWLLM's coding agent, working directly inside the user's project at:\n${ws}\n\n` +
  `You have real tools: read_file, grep, glob, list_dir, edit_file, write_file_with_diff, ` +
  `create_dir and shell. Use them — do NOT ask the user to paste files or run commands you can run yourself. ` +
  `Read and search before you edit. Make the smallest correct change that satisfies the request, keep the ` +
  `surrounding code's style, and after editing briefly state what you changed and why. Paths may be given ` +
  `relative to the workspace.`;

// Phase 3 — plan/act Kanban. The model first breaks a goal into ordered steps
// (cards), then the agent executes each step in turn, moving its card across
// the board. Inspired by Cline's task UX, built on OWLLM's own engine.
type Task = { id: number; title: string; status: "pending" | "running" | "done" | "failed" };

// Each open Code PAGE has its own chatRuntime session, keyed by the page id, so
// pages are fully INDEPENDENT — separate conversation, workspace, and (when the
// folder is a git repo) a separate git worktree on its own branch. The shell
// (CodePages, the default export) owns the tab list; CodeWorkspace below is one
// page. Sessions survive navigating away/back via the in-memory store, and are
// debounce-persisted per page id (decoupled from the churning worktree path).
const sidForPage = (pageId: string) => `code:ws:${pageId}`;
type CodeState = {
  messages: Msg[];
  tasks: Task[];
  workspace: string;       // where edits happen — the worktree path when isolated
  modelId: string;
  draft: string;
  busy: boolean;
  status: string;
  // ---- per-page git-worktree isolation (every page = its own branch off HEAD) ----
  projectRoot?: string;    // the REAL repo the worktree was cut from (merge target)
  branch?: string;         // the worktree's branch
  baseSha?: string;        // base commit the branch was cut from (for diff/merge)
  isolated?: boolean;      // true when `workspace` is an OWLLM-managed worktree
  preparing?: boolean;     // worktree is being created in the background (page is
                           // shown immediately; Send is gated until it's ready)
  // Agent MODE (right-column selector): plan = Kanban plan/act, auto = act
  // directly (the old Send), chat = discuss only (read-only tools, no edits).
  agentMode?: CodeAgentMode;
  // Run stopwatch — stamped when an agent turn starts, frozen when it ends.
  // Mirrors the Agents-page team timer; rendered as the header RunTimerChip.
  runStartedAt?: number;
  runEndedAt?: number;
  // Second-agent chat pane — a parallel coder sharing the SAME project/session
  // (workspace, worktree, page id) as the primary chat, but with its OWN
  // independent, owner-tagged message history, draft, and model selection.
  secondaryOpen?: boolean;
  secondaryMessages?: Msg[];
  secondaryDraft?: string;
  /// Selectable last-reply auto-feed between the two panes (per direction):
  /// when on, an agent's finished reply is fed to the OTHER agent as its next
  /// user turn (labelled ⇄). Both on = agent-to-agent conversation, capped.
  feedPrimaryToSecondary?: boolean;
  feedSecondaryToPrimary?: boolean;
  // The second agent's own model. Empty = inherit the primary chat's model, so
  // by default both agents run the same model until the user picks a different
  // one for the second pane.
  secondaryModelId?: string;
};
const DEFAULT_CODE_STATE: CodeState = {
  messages: [], tasks: [], workspace: "", modelId: "", draft: "", busy: false,
  status: "Pick a folder and a local model, then describe what to build or fix.",
};

// Worktree command outcomes — serde-tagged "status", camelCase. Mirror of the
// Rust enum for fleet_worktree_create, reused AS-IS for the Code page.
type WtCreate =
  | { status: "ready"; path: string; branch: string; baseSha: string }
  | { status: "notAGitRepo" }
  | { status: "dirtyWorkingTree"; details: string }
  | { status: "error"; message: string };

// ---- Multi-page shell state (the tab strip) --------------------------------
type CodePageMeta = { id: string; title: string; seedProject?: string };
const PAGES_KEY = "owllm:code:pages";
const ACTIVE_PAGE_KEY = "owllm:code:activePage";
const PAGE_SESSION_PREFIX = "owllm:code:page:";
function newPageId(): string { return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }
function loadPages(): CodePageMeta[] {
  try {
    const a = JSON.parse(localStorage.getItem(PAGES_KEY) || "[]");
    return Array.isArray(a) ? a.filter((p) => p && typeof p.id === "string") : [];
  } catch { return []; }
}
function savePages(pages: CodePageMeta[]): void {
  try { localStorage.setItem(PAGES_KEY, JSON.stringify(pages)); } catch { /* best effort */ }
}
// Per-PAGE session persistence (keyed by page id, NOT the folder/worktree path,
// so an isolated page survives the worktree being re-created at a new path).
function pageSessionKey(pageId: string): string { return PAGE_SESSION_PREFIX + pageId; }
// A run interrupted by app-close persists busy:false with a runStartedAt but no
// runEndedAt — clear that half-open stopwatch on load so it doesn't render a
// bogus multi-hour "frozen" duration. A completed run (both stamps set) is kept.
function closeStaleTimer(s: CodeState): CodeState {
  if (s.runStartedAt != null && s.runEndedAt == null) {
    return { ...s, runStartedAt: undefined, runEndedAt: undefined };
  }
  return s;
}
function loadPageSession(pageId: string): CodeState | null {
  try {
    const raw = localStorage.getItem(pageSessionKey(pageId));
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<CodeState>;
    return closeStaleTimer({ ...DEFAULT_CODE_STATE, ...s, busy: false });
  } catch { return null; }
}
function savePageSession(pageId: string, s: CodeState | null | undefined): void {
  if (!s) return;
  try { localStorage.setItem(pageSessionKey(pageId), JSON.stringify({ ...s, busy: false })); }
  catch { /* quota / unavailable */ }
}
function dropPageSession(pageId: string): void {
  try { localStorage.removeItem(pageSessionKey(pageId)); } catch { /* best effort */ }
}

// ---- Per-project persistence (the thing that was missing) ------------------
//
// The Code page used to keep its whole conversation ONLY in the in-memory
// chatRuntime store, with no persister registered — so closing the app threw
// the session away. Now every workspace folder is its OWN saved project: the
// conversation, Kanban, draft and chosen model are written to localStorage
// keyed by the folder path, and restored when you reopen that folder (or
// relaunch the app onto the last folder you had open). `busy` is never
// persisted — an in-flight stream cannot survive a restart, so it's forced
// false on load to avoid a permanently-stuck Stop button.
const CODE_SESSION_PREFIX = "owllm:code:session:";
const CODE_LAST_KEY = "owllm:code:last";
const CODE_RECENTS_KEY = "owllm:code:recents";
const CODE_RECENTS_META_KEY = "owllm:code:recents:meta";
const CODE_RECENTS_MAX = 12;

// fileToImageAttachment + MAX_CHAT_IMAGE_BYTES now live in ./dispatch (shared by
// the Code, agentic, and fine-tuning chats — imported above).

// ---- Chat history -------------------------------------------------------
// The "New chat" surface keeps a list of past conversations in localStorage so
// they survive tab switches AND app restarts (the chat used to be plain useState
// that evaporated). Each thread is one conversation; the newest is first.
type ChatMsg = { role: "user" | "assistant"; content: string };
type ChatThread = { id: string; title: string; ts: number; messages: ChatMsg[] };
const CHATS_KEY = "owllm:code:chats";
const CHATS_MAX = 60;
function loadChats(): ChatThread[] {
  try {
    const a = JSON.parse(localStorage.getItem(CHATS_KEY) || "[]");
    return Array.isArray(a) ? a.filter((c) => c && typeof c.id === "string" && Array.isArray(c.messages)) : [];
  } catch { return []; }
}
function saveChats(chats: ChatThread[]): void {
  try { localStorage.setItem(CHATS_KEY, JSON.stringify(chats.slice(0, CHATS_MAX))); } catch { /* private mode / quota */ }
}
function newThreadId(): string { return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }
function threadTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t ? (t.length > 44 ? t.slice(0, 44) + "…" : t) : "New chat";
}

// Per-recent metadata: a friendly name and a pin flag. Stored separately from
// the recents array so the array stays a plain path list.
type RecentMeta = { name?: string; pinned?: boolean };
function getRecentsMeta(): Record<string, RecentMeta> {
  try {
    const m = JSON.parse(localStorage.getItem(CODE_RECENTS_META_KEY) || "{}");
    return m && typeof m === "object" ? (m as Record<string, RecentMeta>) : {};
  } catch { return {}; }
}
function patchRecentMeta(ws: string, patch: RecentMeta): Record<string, RecentMeta> {
  const all = getRecentsMeta();
  all[ws] = { ...all[ws], ...patch };
  // Drop empty entries so the store doesn't accumulate {} blobs.
  if (!all[ws].name && !all[ws].pinned) delete all[ws];
  try { localStorage.setItem(CODE_RECENTS_META_KEY, JSON.stringify(all)); } catch { /* best effort */ }
  return all;
}

function codeSessionKey(ws: string): string {
  return CODE_SESSION_PREFIX + encodeURIComponent(ws);
}

function loadCodeSession(ws: string): CodeState | null {
  if (!ws) return null;
  try {
    const raw = localStorage.getItem(codeSessionKey(ws));
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<CodeState>;
    return closeStaleTimer({ ...DEFAULT_CODE_STATE, ...s, workspace: ws, busy: false });
  } catch { return null; }
}

function saveCodeSession(s: CodeState | null | undefined): void {
  if (!s || !s.workspace) return; // no folder → nothing to save (onboarding state)
  try {
    localStorage.setItem(codeSessionKey(s.workspace), JSON.stringify({ ...s, busy: false }));
  } catch { /* quota / unavailable — best effort */ }
}

function getCodeRecents(): string[] {
  try {
    const r = JSON.parse(localStorage.getItem(CODE_RECENTS_KEY) || "[]");
    return Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

function rememberCodeProject(ws: string): string[] {
  if (!ws) return getCodeRecents();
  const next = [ws, ...getCodeRecents().filter((x) => x !== ws)].slice(0, CODE_RECENTS_MAX);
  try {
    localStorage.setItem(CODE_RECENTS_KEY, JSON.stringify(next));
    localStorage.setItem(CODE_LAST_KEY, ws);
  } catch { /* best effort */ }
  return next;
}

function forgetCodeProject(ws: string): string[] {
  const next = getCodeRecents().filter((x) => x !== ws);
  try {
    localStorage.setItem(CODE_RECENTS_KEY, JSON.stringify(next));
    localStorage.removeItem(codeSessionKey(ws));
    if ((localStorage.getItem(CODE_LAST_KEY) || "") === ws) localStorage.removeItem(CODE_LAST_KEY);
    patchRecentMeta(ws, {}); // drops name/pin for the forgotten project
  } catch { /* best effort */ }
  return next;
}

function getLastCodeProject(): string {
  try { return localStorage.getItem(CODE_LAST_KEY) || ""; } catch { return ""; }
}

const PLAN_SYSTEM = (ws: string, goal: string) =>
  `You are a senior engineer planning work in the project at ${ws}. Break the goal into 2-6 concrete, ` +
  `ordered implementation steps. Output ONLY a JSON array of short imperative step strings (one action each), ` +
  `nothing else — no prose, no code fences. Goal: ${goal}`;

// Tolerant parse: prefer a JSON array; fall back to numbered/bulleted lines.
function parseSteps(text: string): string[] {
  const m = text.match(/\[[\s\S]*\]/);
  if (m) {
    try {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter(Boolean).slice(0, 8);
    } catch { /* fall through to line parsing */ }
  }
  return text
    .split("\n")
    .map((l) => l.replace(/^\s*(\d+[.)]|[-*])\s*/, "").trim())
    .filter((l) => l.length > 3 && !l.startsWith("```"))
    .slice(0, 8);
}

// WSL/sandbox status is GLOBAL (not per-page) and a COLD wsl.exe probe can take
// 10-40s. The Code page now mounts a fresh body per tab, so without caching this
// re-ran the probe on EVERY new page / tab switch / close — THE cause of
// "opening (and closing) a page takes 40s". Cache the probe so only the FIRST
// page pays it; every later page reuses the resolved result instantly. Reset on
// hard failure so a transient wsl.exe miss can retry on the next page.
let _sandboxProbe: Promise<{ st: WslStatus; iso: WslIsolation; s: SandboxStatus }> | null = null;
function probeSandboxOnce(): Promise<{ st: WslStatus; iso: WslIsolation; s: SandboxStatus }> {
  if (!_sandboxProbe) {
    _sandboxProbe = (async () => {
      const [st, iso0] = await Promise.all([wslStatus(), wslIsolationGet()]);
      // Retry while the sandbox reports "not available" — the first wsl.exe call
      // after boot can transiently miss the distro while the service warms up.
      let s = await sandboxStatus();
      for (let i = 0; i < 3 && !s.available; i++) {
        await new Promise((r) => setTimeout(r, 800));
        s = await sandboxStatus();
      }
      // Sandbox present + isolation off → enable it once (every new project is
      // isolated by default; the user can still opt out per project).
      let iso = iso0;
      if (s.available && !iso0.enabled) {
        try { iso = await wslIsolationSet(true, s.defaultTarget ?? null); } catch { iso = iso0; }
      }
      return { st, iso, s };
    })();
    _sandboxProbe.catch(() => { _sandboxProbe = null; });
  }
  return _sandboxProbe;
}

function CodeWorkspace({ pageId, seedProject, onTitle }: {
  pageId: string;
  /// When set, this page auto-opens this project on first mount — used by
  /// "New page" to start ANOTHER isolated worktree of the SAME project so the
  /// user gets a parallel workspace instead of a blank folder picker.
  seedProject?: string;
  /// Report this page's display title (folder name) to the shell so the tab
  /// label stays in sync.
  onTitle: (title: string) => void;
}) {
  const SID = sidForPage(pageId);
  // The model LIST is re-fetched on mount, so it stays plain component state.
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [accountsStatus, setAccountsStatus] = useState<AccountsStatusLite | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const secondaryAbortRef = useRef<AbortController | null>(null);

  // ---- Right column: Super User (rules + notebook) — user spec 2026-07-04 ----
  // Rules/notebook scope: reuse the AGENTIC project's id when this folder is
  // also a team project (one shared rule set + notebook across both pages);
  // otherwise a stable per-folder key. directives_list auto-seeds the native
  // best-practice defaults on first use — the same "suggested" set the team gets.
  const [ruleScope, setRuleScope] = useState<{ id: string; shared: boolean }>({ id: "", shared: false });
  const ruleScopeRef = useRef(ruleScope);
  ruleScopeRef.current = ruleScope;
  // Auto-feed identity of THIS Code page — the notebook blob is per project,
  // so this is what stops a second page on the same project from popping the
  // queue when its own (unrelated) turn finishes.
  const notebookSurfaceId = `code:${pageId}`;
  const [directives, setDirectives] = useState<Directive[]>([]);
  const directivesRef = useRef<Directive[]>([]);
  directivesRef.current = directives;
  const sendRef = useRef<((textOverride?: string) => Promise<void>) | null>(null);
  // Mid-run steer queue (VS Code-style): notebook steps fed while the coder is
  // busy are drained between tool calls on local models (getSteer), or at the
  // end of the turn on CLI/API paths.
  const steerRef = useRef<string[]>([]);
  const drainSteer = () => steerRef.current.splice(0, steerRef.current.length).join("\n\n");
  const busySendRef = useRef(false);
  // Live port for the notebook's digest agent (refreshed when the notebook opens).
  const [srvPort, setSrvPort] = useState(0);

  // Plain "just chat" mode (no project) — opened from the Start screen's "New
  // chat" action. Reuses the same model picker + streaming as the coder, but
  // with no tools and no workspace. Conversations are PERSISTED (localStorage)
  // as a list of threads, so history survives tab switches and app restarts.
  const [chatMode, setChatMode] = useState(false);
  const [chats, setChats] = useState<ChatThread[]>(loadChats);
  const [chatId, setChatId] = useState<string>("");
  const [showHistory, setShowHistory] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatImages, setChatImages] = useState<Attachment[]>([]);
  const chatFileRef = useRef<HTMLInputElement | null>(null);
  // Project-coding composer image attachments (paste / drag-drop / picker) — the
  // same capability the just-chat box and the agentic/fine-tuning chats have, so
  // every chat behaves the same. Sent with the next message, then cleared.
  const [codeImages, setCodeImages] = useState<Attachment[]>([]);
  const codeFileRef = useRef<HTMLInputElement | null>(null);
  // Clicking a file in the tree OPENS it in a viewer (was: silently inserted an
  // @ref, which is why the tree felt "fake" — you couldn't see files). The viewer
  // is also editable: ✎ Edit turns the <pre> into a <textarea>, and once the text
  // is modified the button becomes 💾 Save (writes back via tool_write_file).
  // `content` is what's on disk; `draft` is the in-progress edit; dirty = draft≠content.
  // Open files are TABS — several can be open at once and you switch between
  // them. `tabs` holds every open file; `activeAbs` is the one shown. `viewer`
  // (derived) is the active tab, so all the viewer code below reads the same.
  type FileTab = { abs: string; rel: string; content: string; loading: boolean; editing: boolean; draft: string; saving: boolean; saveError?: string };
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [activeAbs, setActiveAbs] = useState<string | null>(null);
  const viewer = tabs.find((t) => t.abs === activeAbs) ?? null;
  // Patch one tab in place (partial or updater), keyed by its absolute path.
  const patchTab = (abs: string, patch: Partial<FileTab> | ((t: FileTab) => Partial<FileTab>)) =>
    setTabs((ts) => ts.map((t) => (t.abs === abs ? { ...t, ...(typeof patch === "function" ? patch(t) : patch) } : t)));
  // Remove a tab; if it was the active one, focus a neighbour (or close all).
  const dropTab = (abs: string) => {
    const idx = tabs.findIndex((t) => t.abs === abs);
    const next = tabs.filter((t) => t.abs !== abs);
    setTabs(next);
    if (activeAbs === abs) setActiveAbs(next[idx]?.abs ?? next[idx - 1]?.abs ?? null);
  };
  // Fallback working dir for chats with NO workspace folder selected. A pasted
  // image needs somewhere to be saved so a CLI/subscription model can READ it
  // (codex -i / claude file-ref) — without a cwd the image was silently dropped
  // ("I can't inspect the image"). Same WSL scratch the fine-tuning chat uses.
  const chatScratchRef = useRef<string>("");
  useEffect(() => {
    invoke<string>("chat_scratch_dir").then((d) => { chatScratchRef.current = d; }).catch(() => {});
  }, []);
  // The active conversation is derived from the thread list (single source of
  // truth); persist the whole list whenever it changes.
  const chatMsgs: ChatMsg[] = chats.find((c) => c.id === chatId)?.messages ?? [];
  useEffect(() => { saveChats(chats); }, [chats]);
  // Sticky auto-scroll for the "Just chat" transcript: land at the bottom when
  // the view opens or you switch threads (openKey = chatId), follow streaming
  // content only while the user is near the bottom (contentKey = message count).
  const chatSticky = useStickyScroll(chatMsgs.length, chatId);
  const updateThread = (id: string, fn: (m: ChatMsg[]) => ChatMsg[], title?: string) =>
    setChats((cs) => cs.map((c) => c.id === id
      ? { ...c, ts: Date.now(), title: (!c.title || c.title === "New chat") && title ? title : c.title, messages: fn(c.messages) }
      : c));
  const newChat = () => {
    const id = newThreadId();
    setChats((cs) => [{ id, title: "New chat", ts: Date.now(), messages: [] }, ...cs]);
    setChatId(id); setShowHistory(false); setChatImages([]); setChatDraft("");
  };
  const deleteThread = (id: string) => { setChats((cs) => cs.filter((c) => c.id !== id)); if (chatId === id) setChatId(""); };

  // Paste (Ctrl+V) an image from the clipboard into the chat, or pick files.
  const addChatFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith("image/")) continue;
      try { const a = await fileToImageAttachment(f); setChatImages((x) => [...x, a]); }
      catch (e: any) { setStatus(String(e?.message ?? e)); }
    }
  };
  const onChatPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const imgs = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (imgs.length === 0) return; // let normal text paste through
    e.preventDefault();
    void addChatFiles(imgs);
  };
  // SESSION state (conversation, Kanban, workspace, model, draft) lives in the
  // shared chatRuntime store so it survives leaving this page and coming back.
  // Setter shims keep the same signatures as useState so the rest of the file
  // is unchanged.
  const sess = useChatSession<CodeState>(SID);
  const hydratedRef = useRef(false);
  if (!hydratedRef.current) {
    hydratedRef.current = true;
    // Restore THIS page's saved session (conversation, Kanban, draft, model, and
    // its worktree meta) — keyed by page id so it's independent of every other
    // open page and survives the worktree path changing underneath it. On first
    // launch after upgrading, the default page also adopts the LEGACY per-folder
    // session so existing users don't see their Code history vanish.
    const restored = loadPageSession(pageId)
      ?? (pageId === "main" ? loadCodeSession(getLastCodeProject()) : null);
    chatRuntime.hydrateIfIdle(SID, restored ?? DEFAULT_CODE_STATE);
    // Persist EVERY mutation (debounced) under this page id, with a final flush
    // after unmount / stream-end — the "coded for an hour, closed the app,
    // nothing saved" fix, now per page.
    chatRuntime.registerPersister(SID, (payload) => savePageSession(pageId, payload as CodeState));
  }
  // Recent projects, for the onboarding screen shown when no folder is open.
  const [recents, setRecents] = useState<string[]>(getCodeRecents);
  const [recentsMeta, setRecentsMeta] = useState<Record<string, RecentMeta>>(getRecentsMeta);
  // Inline rename: which recent is being renamed + the draft text.
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // WSL isolation: when on, projects live inside Ubuntu and the model's tools
  // run there, off the Windows drive. `wslStat` reports availability.
  const [wslStat, setWslStat] = useState<WslStatus | null>(null);
  const [isolation, setIsolation] = useState<WslIsolation>({ enabled: false, distro: null });
  const [wslProjects, setWslProjects] = useState<WslProject[]>([]);
  const [toolchain, setToolchain] = useState<WslToolchain | null>(null);
  const [provisionLog, setProvisionLog] = useState<string>("");
  // Cross-platform sandbox status (WSL on Windows, Lima on macOS, bubblewrap on
  // Linux). Drives the onboarding availability/labels on every OS; on Windows
  // it mirrors wslStat (the Rust command delegates to wsl_status).
  const [sbox, setSbox] = useState<SandboxStatus | null>(null);
  const [sboxProjects, setSboxProjects] = useState<SandboxProject[]>([]);
  // True on Windows, where the WSL-specific toolchain probe + installer apply.
  const isWsl = sbox ? sbox.kind === "wsl" : true;
  const stx = sess.payload ?? DEFAULT_CODE_STATE;
  const { messages, tasks, workspace, modelId, draft, busy, status, projectRoot, branch, isolated, preparing, runStartedAt, runEndedAt } = stx;
  const agentMode: CodeAgentMode = stx.agentMode ?? "auto";
  const secondaryOpen: boolean = stx.secondaryOpen ?? false;
  const secondaryMessages: Msg[] = stx.secondaryMessages ?? [];
  const secondaryDraft: string = stx.secondaryDraft ?? "";
  const secondaryModelId: string = stx.secondaryModelId ?? "";
  const feedPrimaryToSecondary: boolean = stx.feedPrimaryToSecondary ?? false;
  const feedSecondaryToPrimary: boolean = stx.feedSecondaryToPrimary ?? false;
  // The model the second agent actually runs — its own pick, or the primary
  // model when it hasn't chosen one (empty = "same as 1st agent").
  const secondaryModelEffective = secondaryModelId || modelId;
  const [secondaryBusy, setSecondaryBusy] = useState(false);
  // Terminal popup (right-column 🖥 button) — floats above THIS app's UI only.
  const [termOpen, setTermOpen] = useState(false);
  // Terminal popup chrome: hide (— keeps the shell alive, just display:none)
  // and drag (title bar). null pos = default docked bottom-right.
  const [termHidden, setTermHidden] = useState(false);
  const [termPos, setTermPos] = useState<{ x: number; y: number } | null>(null);
  // Agent Browser popup (right-column 🌐 button) — viewer for the shared daemon.
  const [browserOpen, setBrowserOpen] = useState(false);
  useEffect(() => () => { secondaryAbortRef.current?.abort(); }, []);
  // Consecutive AUTOMATIC exchanges between the two panes (⇄ auto-feed).
  // Any manual send resets it; the cap stops a both-directions-on ping-pong
  // from looping forever (the user un-pauses by just sending a message).
  const autoFeedHopsRef = useRef(0);
  const AUTO_FEED_MAX_HOPS = 6;
  const sendSecondaryRef = useRef<((textOverride?: string) => Promise<void>) | null>(null);
  const termBoxRef = useRef<HTMLDivElement>(null);
  const termDragRef = useRef<{ dx: number; dy: number } | null>(null);
  const onTermDragStart = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return; // don't drag from the buttons
    const box = termBoxRef.current;
    if (!box) return;
    e.preventDefault();
    const r = box.getBoundingClientRect();
    termDragRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    const move = (ev: MouseEvent) => {
      const d = termDragRef.current;
      const b = termBoxRef.current;
      if (!d || !b) return;
      const w = b.offsetWidth, h = b.offsetHeight;
      setTermPos({
        x: Math.min(Math.max(0, ev.clientX - d.dx), Math.max(0, window.innerWidth - w)),
        y: Math.min(Math.max(0, ev.clientY - d.dy), Math.max(0, window.innerHeight - h)),
      });
    };
    const up = () => {
      termDragRef.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  // Live feedback for the current run: what phase the agent is in and whether
  // the local model is still being mmap'd (cold-load banner).
  const [runPhase, setRunPhase] = useState<string | null>(null);
  const [llamaLoading, setLlamaLoading] = useState<{ sec: number; reason: string } | null>(null);
  busySendRef.current = busy;
  // Wide enough to sit the second-agent pane beside the primary chat (row);
  // below the breakpoint they stack (column). matchMedia, listener cleaned up.
  const [wideView, setWideView] = useState<boolean>(() =>
    typeof window !== "undefined" && window.matchMedia("(min-width:1000px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width:1000px)");
    const onChange = (e: MediaQueryListEvent) => setWideView(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  // Resolve the rules/notebook scope whenever the folder changes: prefer the
  // matching AGENTIC project id (shared rule set + notebook with the team),
  // fall back to a stable per-folder key.
  useEffect(() => {
    const folder = (projectRoot || workspace || "").trim();
    if (!folder) { setRuleScope({ id: "", shared: false }); setDirectives([]); return; }
    const norm = (p: string) => p.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
    let alive = true;
    (async () => {
      let id = `code:${norm(folder)}`;
      let shared = false;
      try {
        const rows = await invoke<{ id: string; location: string }[]>("list_projects");
        const hit = (rows || []).find((r) => r.location && norm(r.location) === norm(folder));
        if (hit) { id = hit.id; shared = true; }
      } catch { /* no projects table reachable — per-folder scope */ }
      if (!alive) return;
      setRuleScope({ id, shared });
      try { setDirectives(await invoke<Directive[]>("directives_list", { projectId: id })); }
      catch { setDirectives([]); }
    })();
    return () => { alive = false; };
  }, [projectRoot, workspace]);
  const reloadDirectives = async () => {
    if (!ruleScope.id) return;
    try { setDirectives(await invoke<Directive[]>("directives_list", { projectId: ruleScope.id })); } catch { /* keep last */ }
  };
  // Keep the shell's tab label in sync with this page's project.
  useEffect(() => {
    const label = projectRoot ? projectRoot.replace(/^.*[\\/]/, "")
      : workspace ? workspace.replace(/^.*[\\/]/, "")
      : "New page";
    onTitle(label);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot, workspace]);
  // Stale-worktree self-heal: a restored session can point at a worktree that
  // was deleted or gutted underneath it (sweep, crash, manual cleanup). The
  // old behaviour was a silently EMPTY file tree that looked broken. Verify
  // the worktree is still a real checkout (its `.git` link exists); if not,
  // rebuild it from the project root — openWorkspace already handles every
  // failure with an explicit status message (dirty repo, missing folder, …).
  const healedRef = useRef(false);
  useEffect(() => {
    if (healedRef.current || !isolated || !workspace || !projectRoot || preparing) return;
    healedRef.current = true;
    invoke<Array<{ name: string; kind: string }>>("tool_list_dir", { path: workspace, cwd: undefined })
      .then((e) => {
        if (!e.some((x) => x.name === ".git")) void openWorkspace(projectRoot);
      })
      .catch(() => { void openWorkspace(projectRoot); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isolated, workspace, projectRoot, preparing]);
  // "New page on the same project": auto-open the seeded project once on mount,
  // but only if this page doesn't already have a workspace (restored session).
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !seedProject) return;
    seededRef.current = true;
    const cur = chatRuntime.getSnapshot(SID).payload as CodeState | null;
    if (!cur?.workspace) void openWorkspace(seedProject);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function setField<K extends keyof CodeState>(k: K, v: CodeState[K] | ((p: CodeState[K]) => CodeState[K])) {
    chatRuntime.setPayload(SID, (prev) => {
      const cur = (prev as CodeState) ?? DEFAULT_CODE_STATE;
      const nv = typeof v === "function" ? (v as (p: CodeState[K]) => CodeState[K])(cur[k]) : v;
      return { ...cur, [k]: nv };
    });
  }
  // Ownership choke point: every message written into a conversation is tagged
  // with its owner (unless it already carries one — e.g. a forwarded message
  // that should keep provenance-agnostic "user" ownership of the target pane).
  const stampOwner = (list: Msg[], owner: "primary" | "secondary"): Msg[] =>
    list.map((m) => (m.owner ? m : { ...m, owner }));
  const setMessages = (v: Msg[] | ((m: Msg[]) => Msg[])) =>
    setField("messages", (prev) => stampOwner(typeof v === "function" ? v(prev) : v, "primary"));
  const setTasks = (v: Task[] | ((t: Task[]) => Task[])) => setField("tasks", v);
  const setWorkspace = (v: string) => setField("workspace", v);
  const setModelId = (v: string | ((s: string) => string)) => setField("modelId", v);
  const setDraft = (v: string | ((s: string) => string)) => setField("draft", v);
  // Toggling busy also drives the header stopwatch: stamp runStartedAt fresh on
  // start, freeze runEndedAt on stop (only if a run was actually live, so a
  // double stop() doesn't move the frozen time).
  const setBusy = (v: boolean) => {
    chatRuntime.setPayload(SID, (prev) => {
      const cur = (prev as CodeState) ?? DEFAULT_CODE_STATE;
      if (v) return { ...cur, busy: true, runStartedAt: Date.now(), runEndedAt: undefined };
      const live = cur.runStartedAt != null && cur.runEndedAt == null;
      return { ...cur, busy: false, runEndedAt: live ? Date.now() : cur.runEndedAt };
    });
  };
  const setStatus = (v: string) => setField("status", v);
  const setAgentMode = (v: CodeAgentMode) => setField("agentMode", v);
  const setSecondaryOpen = (v: boolean) => setField("secondaryOpen", v);
  const setSecondaryMessages = (v: Msg[] | ((m: Msg[]) => Msg[])) =>
    setField("secondaryMessages", (prev) => {
      const base = (prev as Msg[] | undefined) ?? [];
      const next = typeof v === "function" ? (v as (m: Msg[]) => Msg[])(base) : v;
      return stampOwner(next, "secondary") as CodeState["secondaryMessages"];
    });
  const setSecondaryDraft = (v: string | ((s: string) => string)) => setField("secondaryDraft", v as CodeState["secondaryDraft"]);
  const setSecondaryModelId = (v: string | ((s: string) => string)) => setField("secondaryModelId", v as CodeState["secondaryModelId"]);
  const setFeedPrimaryToSecondary = (v: boolean) => setField("feedPrimaryToSecondary", v);
  const setFeedSecondaryToPrimary = (v: boolean) => setField("feedSecondaryToPrimary", v);

  // SAME model source as every other page — the full list_models result fed
  // to the shared ModelPicker (localOnly does the filtering). Refresh on focus
  // and on the app-wide models:refresh event (fired after a download) so newly
  // installed models appear without restart — identical to ChatPage.
  useEffect(() => {
    let dead = false;
    const reload = () => {
      invoke<ModelInfo[]>("list_models")
        .then((all) => {
          if (dead) return;
          setAvailableModels(all);
          setModelId((cur) => cur || all.find((m) => m.provider === "local" || m.provider === "tuned")?.model_id || "");
        })
        .catch((e) => setStatus(`Couldn't load models: ${e}`));
      invoke<AccountsStatusLite>("accounts_status")
        .then((s) => { if (!dead) setAccountsStatus(s); })
        .catch(() => { /* leave null */ });
    };
    reload();
    const onRefresh = () => reload();
    window.addEventListener("focus", onRefresh);
    window.addEventListener("owllm:models:refresh", onRefresh as EventListener);
    return () => {
      dead = true;
      window.removeEventListener("focus", onRefresh);
      window.removeEventListener("owllm:models:refresh", onRefresh as EventListener);
    };
  }, []);

  // Live cold-load status. dispatch.ts fires owllm:llama:loading while the
  // local server is still mmap'ing the GGUF; AgentsPage already surfaces this
  // banner, and CodePage was missing it — leaving only the header timer.
  useEffect(() => {
    const onLoading = (e: Event) => {
      const detail = (e as CustomEvent<{ elapsedSec: number; reason?: string }>).detail;
      if (!detail) return;
      setLlamaLoading({ sec: detail.elapsedSec, reason: detail.reason || "loading model" });
      setRunPhase("warming up model");
    };
    window.addEventListener("owllm:llama:loading", onLoading as EventListener);
    let unlistenReady: (() => void) | null = null;
    listen<{ model_id: string; port: number; elapsed_ms: number }>("llama-ready", () => {
      setLlamaLoading(null);
    }).then((u) => { unlistenReady = u; });
    return () => {
      window.removeEventListener("owllm:llama:loading", onLoading as EventListener);
      unlistenReady?.();
    };
  }, []);

  // Sticky auto-scroll for the project transcript: land at the bottom when a
  // project opens/switches (openKey = workspace), follow streaming tokens / tool
  // events only while the user is near the bottom (contentKey = message count).
  const transcriptSticky = useStickyScroll(messages.length, workspace);

  // Switch the page to a project folder: save whatever's open now, then load
  // THAT folder's saved session (conversation + Kanban + draft + model), or
  // start a fresh one carrying the current model selection over. Updates the
  // recent-projects list so the onboarding screen can offer it next time.
  // Open a project in THIS page. Per the user's choice EVERY page is isolated:
  // we cut a git worktree off the folder's HEAD and the page edits THAT, so the
  // real folder stays untouched until "Merge to main". A non-git folder can't be
  // isolated — fall back to editing it directly (old behaviour) with a notice.
  const openWorkspace = async (dir: string) => {
    if (!dir || busy) return;
    const name = dir.replace(/^.*[\\/]/, "");
    // Switching THIS page to a different project: drop the old worktree in the
    // BACKGROUND so it doesn't block (or leak). Unmerged work is the user's to
    // merge before switching.
    if (stx.isolated && stx.workspace && stx.projectRoot && stx.workspace !== dir) {
      void removeWorktree(stx);
    }
    // Show the page IMMEDIATELY in a "preparing" state — never make the user stare
    // at the picker while a (possibly large) checkout runs. The worktree is built
    // in the BACKGROUND; Send is gated until it's ready (see the composer). The
    // invoke below is async (runs on a Rust thread), so the UI stays responsive.
    chatRuntime.setPayload(SID, () => ({
      ...DEFAULT_CODE_STATE, projectRoot: dir, workspace: "", modelId,
      preparing: true,
      status: `⏳ Preparing a private workspace for ${name} on its own branch… (you can type your request now)`,
    }));
    setRecents(rememberCodeProject(dir));
    const t0 = Date.now();
    let outcome: WtCreate;
    try {
      // "owllm-page" namespace (NOT owllm-fleet) so the team-run sweep never
      // touches a Code page's worktree — it holds the user's unmerged edits.
      outcome = await invoke<WtCreate>("fleet_worktree_create", { projectCwd: dir, agentName: "code", runId: pageId, branchPrefix: "owllm-page" });
    } catch (e: any) {
      outcome = { status: "error", message: String(e?.message ?? e) };
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    // The user may have switched/closed this page mid-prep — only apply the
    // result if the page still wants THIS project.
    const cur = chatRuntime.getSnapshot(SID).payload as CodeState | null;
    if (cur && cur.projectRoot !== dir) return;
    if (outcome.status === "ready") {
      chatRuntime.setPayload(SID, (p) => ({
        ...((p as CodeState) ?? DEFAULT_CODE_STATE),
        workspace: outcome.path, projectRoot: dir, branch: outcome.branch, baseSha: outcome.baseSha,
        isolated: true, preparing: false,
        status: `On branch ${outcome.branch} — a private copy (ready in ${secs}s). Your edits stay in this page until you Merge to ${name}.`,
      }));
    } else if (outcome.status === "notAGitRepo") {
      chatRuntime.setPayload(SID, (p) => ({
        ...((p as CodeState) ?? DEFAULT_CODE_STATE),
        workspace: dir, projectRoot: undefined, branch: undefined, baseSha: undefined,
        isolated: false, preparing: false,
        status: `Not a git repo — editing this folder directly (no isolation). Run "git init" in it to enable per-page worktrees.`,
      }));
    } else if (outcome.status === "dirtyWorkingTree") {
      chatRuntime.setPayload(SID, () => ({
        ...DEFAULT_CODE_STATE,
        status: `"${name}" has uncommitted changes — commit or stash them first, then reopen so the worktree includes them.\n${outcome.details.split("\n").slice(0, 3).join("\n")}`,
      }));
    } else {
      chatRuntime.setPayload(SID, () => ({ ...DEFAULT_CODE_STATE, status: `Couldn't create the worktree: ${outcome.message}` }));
    }
  };

  // Best-effort: drop a page's worktree + branch. Discards uncommitted work in
  // the worktree, so callers warn the user first when there may be unmerged work.
  const removeWorktree = async (st: CodeState): Promise<void> => {
    if (!st.isolated || !st.workspace || !st.projectRoot) return;
    try {
      await invoke("fleet_worktree_remove", {
        args: { projectCwd: st.projectRoot, worktreePath: st.workspace, branch: st.branch ?? "", keep: false },
      });
    } catch { /* best-effort cleanup */ }
  };

  const pickWorkspace = async () => {
    if (busy) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true, multiple: false, title: "Pick a project folder" });
      if (typeof dir === "string" && dir) openWorkspace(dir);
    } catch (e) {
      setStatus(`Folder picker failed: ${e}`);
    }
  };

  // Close the current project back to the onboarding screen (its session stays
  // saved on disk and reappears in Recent projects).
  const closeProject = async () => {
    if (busy) return;
    if (stx.isolated && stx.workspace) {
      try {
        const { confirm } = await import("@tauri-apps/plugin-dialog");
        const ok = await confirm(
          `Close this project? Unmerged changes in its worktree (${stx.branch}) will be discarded. Merge to main first to keep them.`,
          { title: "Close project", kind: "warning" },
        );
        if (!ok) return;
      } catch { /* dialog unavailable — proceed */ }
      void removeWorktree(stx); // background cleanup — return to onboarding instantly
    }
    setRecents(getCodeRecents());
    chatRuntime.setPayload(SID, () => ({ ...DEFAULT_CODE_STATE }));
    try { localStorage.removeItem(CODE_LAST_KEY); } catch { /* best effort */ }
  };

  const removeRecent = (ws: string) => { setRecents(forgetCodeProject(ws)); setRecentsMeta(getRecentsMeta()); };
  const togglePin = (ws: string) => setRecentsMeta(patchRecentMeta(ws, { pinned: !recentsMeta[ws]?.pinned }));
  const startRename = (ws: string) => { setRenaming(ws); setRenameDraft(recentsMeta[ws]?.name ?? ""); };
  const commitRename = () => {
    if (renaming === null) return;
    setRecentsMeta(patchRecentMeta(renaming, { name: renameDraft.trim() || undefined }));
    setRenaming(null);
  };
  // Pinned projects float to the top; recency order is preserved within groups.
  const orderedRecents = [...recents].sort(
    (a, b) => Number(!!recentsMeta[b]?.pinned) - Number(!!recentsMeta[a]?.pinned),
  );
  const recentLabel = (ws: string) =>
    recentsMeta[ws]?.name || ws.replace(/^.*[\\/]/, "") || ws;

  // Load WSL availability + isolation setting on mount; refresh the isolated
  // project list when isolation is on so onboarding can offer them.
  const refreshWslProjects = (iso: WslIsolation, st: WslStatus | null) => {
    if (iso.enabled && st?.available) {
      wslListProjects(iso.distro ?? st.defaultDistro).then(setWslProjects).catch(() => setWslProjects([]));
    } else {
      setWslProjects([]);
    }
  };
  const refreshToolchain = (st: WslStatus | null) => {
    if (st?.available) {
      wslToolchainStatus(st.defaultDistro).then(setToolchain).catch(() => setToolchain(null));
    } else {
      setToolchain(null);
    }
  };
  // Cross-platform isolated-project list (used on macOS/Linux; on Windows it
  // returns the same WSL projects via delegation).
  const refreshSboxProjects = (iso: WslIsolation, s: SandboxStatus | null) => {
    if (iso.enabled && s?.available) {
      sandboxListProjects().then(setSboxProjects).catch(() => setSboxProjects([]));
    } else {
      setSboxProjects([]);
    }
  };
  // WSL/sandbox STATUS — from the app-wide cache, so a new page never re-pays
  // the cold wsl.exe probe (the 40s "opening a page" stall). See probeSandboxOnce.
  useEffect(() => {
    let dead = false;
    probeSandboxOnce().then(({ st, iso, s }) => {
      if (dead) return;
      setWslStat(st);
      setIsolation(iso);
      setSbox(s);
    }).catch(() => { /* leave UI in "checking" */ });
    return () => { dead = true; };
  }, []);
  // Onboarding lists (WSL/sandbox projects + toolchain) only populate the PICKER
  // screen, so fetch them ONLY when this page has no project and isn't about to
  // open one (seeded) — a page opening a project skips these extra wsl.exe calls.
  useEffect(() => {
    if (workspace || seedProject) return;
    let dead = false;
    probeSandboxOnce().then(({ st, iso, s }) => {
      if (dead) return;
      refreshWslProjects(iso, st);
      refreshToolchain(st);
      refreshSboxProjects(iso, s);
    }).catch(() => { /* onboarding lists are best-effort */ });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  // Install WSL itself (elevated; needs reboot) for PCs without it.
  const installWsl = async () => {
    try {
      setStatus("Launching WSL install — accept the UAC prompt, then reboot…");
      const msg = await wslInstall();
      setStatus(msg);
    } catch (e) {
      setStatus(`Couldn't launch WSL install: ${e}`);
    }
  };

  // Provision node/uv/git + the agent CLIs inside the sandbox (WSL/Lima/
  // bubblewrap). Long-running. Cross-platform via sandbox_provision.
  const provisionTools = async () => {
    if (provisionLog === "running") return;
    const eng = sbox ? engineLabel(sbox.kind) : "the sandbox";
    setProvisionLog("running");
    setStatus(`Installing agent tools in ${eng} (node, uv, git, CLIs)… this can take a few minutes.`);
    try {
      const log = await sandboxProvision();
      setProvisionLog("done");
      if (isWsl) refreshToolchain(wslStat);
      // Auto-mirror host CLI logins so cloud agents are authenticated inside
      // the sandbox without a separate login (best-effort, WSL only for now).
      try {
        const r = await sandboxSyncLogins(wslStat?.defaultDistro ?? null);
        setStatus(r.synced.length
          ? `Agent tools installed; synced logins: ${r.synced.join(", ")}.`
          : r.found_on_host.length
            ? `Agent tools installed. Found ${r.found_on_host.join(", ")} on Windows but couldn't copy into the sandbox — click 'Sync logins' to retry.`
            : (log && !isWsl ? log : "Agent tools installed. Log in via Accounts, then click 'Sync logins'."));
      } catch {
        setStatus(log && !isWsl ? log : `Agent tools installed in ${eng}.`);
      }
    } catch (e) {
      setProvisionLog("");
      setStatus(`Tool install failed: ${e}`);
    }
  };

  // Mirror host CLI logins (codex/claude/gemini) into the sandbox so isolated
  // cloud agents are authenticated — no separate in-WSL login needed.
  const syncLogins = async () => {
    setStatus("Mirroring your Windows logins into the sandbox…");
    try {
      const r = await sandboxSyncLogins(wslStat?.defaultDistro ?? null);
      // Per-credential report (P1-2): every provider's mirror status + why,
      // instead of a single summary the user has to interpret.
      const lines = mirrorReportLines(r);
      const summary = r.synced.length
        ? `✓ Synced into sandbox: ${r.synced.join(", ")} — isolated agents are authenticated.`
        : r.found_on_host.length
          ? `⚠ Found on Windows: ${r.found_on_host.join(", ")}, but nothing landed in the sandbox.`
          : "Nothing to sync — no CLI is logged in and no API keys are saved on this PC's Windows side (Accounts → Connect).";
      setStatus(lines.length ? `${summary}\n${lines.join("\n")}` : summary);
    } catch (e) {
      setStatus(`Login sync failed: ${e}`);
    }
  };

  // Convert the current project between isolated and host (copies files across
  // the boundary; the original is left intact). Opens the new copy.
  const [convertBusy, setConvertBusy] = useState(false);
  const convertProject = async () => {
    if (convertBusy || !workspace) return;
    const toIso = !isWslPath(workspace);
    const ok = window.confirm(
      toIso
        ? "Copy this project INTO the Linux sandbox (isolated) and open the copy?\n\nThe original folder stays where it is."
        : "Copy this isolated project OUT to a normal folder (NOT isolated) and open the copy?\n\nThe isolated original stays in the sandbox.",
    );
    if (!ok) return;
    setConvertBusy(true);
    setStatus(toIso ? "Copying into the sandbox…" : "Copying out of the sandbox…");
    try {
      const p = await sandboxConvertProject(workspace);
      setStatus(`Converted — opened ${p.name}.`);
      openWorkspace(p.path);
    } catch (e) {
      setStatus(`Convert failed: ${e}`);
    } finally {
      setConvertBusy(false);
    }
  };

  const toggleIsolation = async (on: boolean) => {
    try {
      const iso = await wslIsolationSet(on, wslStat?.defaultDistro ?? null);
      setIsolation(iso);
      refreshWslProjects(iso, wslStat);
      refreshSboxProjects(iso, sbox);
    } catch (e) {
      setStatus(`Couldn't change isolation: ${e}`);
    }
  };

  // ---- GitHub connection --------------------------------------------------
  // Agents run inside the sandbox; the host's GitHub creds don't cross in.
  // Connecting writes the token into the sandbox git/gh credential store so an
  // isolated agent can clone private repos and push.
  const [gh, setGh] = useState<GithubStatus | null>(null);
  const [ghToken, setGhToken] = useState("");
  const [ghBusy, setGhBusy] = useState(false);
  const [ghMsg, setGhMsg] = useState("");
  const [ghOpen, setGhOpen] = useState(false);
  // Reloads on mount, on the in-window `github-changed` broadcast (an
  // immediate connect/disconnect/authorize from ANY surface — the Account Sync
  // modal, the support drawer, the device-flow), and on window focus (covers
  // an out-of-window browser device-flow). The in-page connect/disconnect
  // handlers below also update `gh` directly.
  useEffect(() => {
    let dead = false;
    const load = () => { githubStatus().then((s) => { if (!dead) setGh(s); }).catch(() => {}); };
    load();
    window.addEventListener("focus", load);
    window.addEventListener(GITHUB_CHANGED_EVENT, load);
    return () => {
      dead = true;
      window.removeEventListener("focus", load);
      window.removeEventListener(GITHUB_CHANGED_EVENT, load);
    };
  }, []);
  const connectGithub = async () => {
    if (ghBusy || !ghToken.trim()) return;
    setGhBusy(true);
    setGhMsg("Validating token with GitHub…");
    try {
      const r = await githubConnect(ghToken.trim(), wslStat?.defaultDistro ?? null);
      setGh({ connected: true, login: r.login });
      setGhToken("");
      setGhOpen(false);
      const where = [r.sandboxConfigured && "WSL", r.hostConfigured && "Windows"].filter(Boolean).join(" + ");
      setGhMsg(`✓ Connected as ${r.login}${where ? ` — git ready in ${where}` : ""}${r.ghConfigured ? " (gh logged in)" : ""}.`);
    } catch (e) {
      setGhMsg(`Couldn't connect: ${e}`);
    } finally {
      setGhBusy(false);
    }
  };
  const disconnectGithub = async () => {
    setGhBusy(true);
    try {
      await githubDisconnect(wslStat?.defaultDistro ?? null);
      setGh({ connected: false, login: null });
      setGhMsg("Disconnected — token removed and credentials scrubbed.");
    } catch (e) {
      setGhMsg(`Couldn't disconnect: ${e}`);
    } finally {
      setGhBusy(false);
    }
  };

  // Auto-provision the in-WSL toolchain so an isolated project "just works"
  // without the user ever pressing "Install agent tools". Fires once per app
  // session, in the background, ONLY when isolation is ON, a distro exists, and
  // the core tools (node/git) are missing — so it never re-runs apt on a
  // healthy machine. A failed run (offline, apt lock) simply retries on the
  // next launch (the ref resets), and the manual button stays as a fallback.
  // WSL itself can't be auto-installed (needs UAC elevation + a reboot), so the
  // "Install WSL" button remains the one explicit step on PCs without it.
  const autoProvisionTried = useRef(false);
  useEffect(() => {
    if (autoProvisionTried.current) return;
    if (!isolation?.enabled || !wslStat?.available) return;
    if (toolchain === null) return;            // status not loaded yet
    if (toolchainReady(toolchain)) return;     // already provisioned
    if (provisionLog === "running") return;
    autoProvisionTried.current = true;
    void provisionTools();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isolation?.enabled, wslStat?.available, toolchain, provisionLog]);

  // ---- New-project modal --------------------------------------------------
  const [npOpen, setNpOpen] = useState(false);
  const [npName, setNpName] = useState("");
  const [npIsolate, setNpIsolate] = useState(true);
  const [npFolder, setNpFolder] = useState("");
  const [npBusy, setNpBusy] = useState(false);
  const [npLogins, setNpLogins] = useState<string[]>([]); // providers present in the sandbox
  // Create a private GitHub repo for the new project (origin wired + pushed).
  // The dialog used to just SAY "a repo is not created automatically — create
  // one yourself"; now it's a choice right in the onboarding.
  const [npCreateRepo, setNpCreateRepo] = useState(false);

  const openNewProject = () => {
    setNpName("");
    setNpFolder("");
    setNpIsolate(!!sbox?.available); // default isolated whenever an engine exists
    setNpCreateRepo(false);
    setNpBusy(false);
    setNpOpen(true);
    // Mirror Accounts logins into the sandbox, THEN show what's available —
    // automatically, no manual button. (No-op/instant if already synced.)
    if (sbox?.available) {
      sandboxSyncLogins(wslStat?.defaultDistro ?? null)
        .catch(() => {})
        .finally(() => {
          sandboxLoginStatus(wslStat?.defaultDistro ?? null).then(setNpLogins).catch(() => setNpLogins([]));
        });
    } else setNpLogins([]);
  };
  const npBrowseFolder = async () => {
    try {
      const picked = await invoke<string | null>("pick_folder", { title: "Pick a project folder" });
      if (picked) setNpFolder(picked);
    } catch (e) { setStatus(`Folder pick failed: ${e}`); }
  };
  // Create from the modal: isolated → fresh ~/owllm project in the sandbox;
  // otherwise open the chosen host folder (NOT isolated).
  const createNewProject = async () => {
    if (npBusy) return;
    setNpBusy(true);
    try {
      let createdPath = "";
      if (npIsolate && sbox?.available) {
        const p = await sandboxCreateProject(npName.trim() || "project");
        createdPath = p.path;
        setNpOpen(false);
        openWorkspace(p.path);
      } else if (npFolder.trim()) {
        createdPath = npFolder.trim();
        setNpOpen(false);
        openWorkspace(npFolder.trim());
      } else {
        setNpBusy(false);
        return;
      }
      // Opt-in GitHub repo creation — after the workspace exists, so a repo
      // failure never blocks the project itself. Best-effort with a loud
      // status either way (the repo-setup popup can retry: same command).
      if (npCreateRepo && createdPath) {
        try {
          const msg = await invoke<string>("github_create_repo", {
            cwd: createdPath,
            name: npName.trim() || null,
            private: true,
          });
          setStatus(`🐙 ${msg}`);
        } catch (e) {
          setStatus(`🐙 Project created, but the GitHub repo could not be set up: ${String((e as Error)?.message ?? e)} — retry from the Publisher card's ⚙ Set up repo.`);
        }
      }
    } catch (e) {
      setStatus(`Couldn't create project: ${e}`);
    } finally {
      setNpBusy(false);
    }
  };

  const isolatedNow = isWslPath(workspace);

  // Auto-sync host cloud logins (codex/claude/gemini/kimi OAuth + every API key)
  // into the sandbox PROACTIVELY — as soon as a sandbox engine is present and
  // isolation is on, not only once a project is open. So by the time you open
  // the New-project dialog the logins are already there (no manual "Sync"
  // needed). Once per session; cheap to re-run; best-effort, silent on failure.
  const autoSyncedRef = useRef(false);
  useEffect(() => {
    if (autoSyncedRef.current) return;
    const should = isolatedNow || (!!sbox?.available && isolation.enabled);
    if (!should) return;
    autoSyncedRef.current = true;
    sandboxSyncLogins(wslStat?.defaultDistro ?? null)
      .then((r) => {
        if (r.synced.length) setStatus(`🔑 Synced cloud logins into the sandbox: ${r.synced.join(", ")}.`);
        // Refresh the dialog's status if it's open.
        sandboxLoginStatus(wslStat?.defaultDistro ?? null).then(setNpLogins).catch(() => {});
      })
      .catch(() => { /* best-effort */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isolatedNow, sbox?.available, isolation.enabled, wslStat]);

  // Start (or reuse) the llama-server for the chosen model; return its port.
  async function ensureServer(id: string): Promise<number | null> {
    const s = await invoke<ServerStatus>("server_status").catch(() => null);
    if (s && s.running && s.model_id === id && s.port) return s.port;
    setStatus(`Starting ${id}…`);
    await invoke("server_start", { modelId: id, ctx: getServerCtx() });
    for (let i = 0; i < 120 && !abortRef.current?.signal.aborted; i++) {
      const st = await invoke<ServerStatus>("server_status").catch(() => null);
      if (st && st.running && st.port) return st.port;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  // ----- streaming sinks (newline-safe append; same lesson as ChatPage) -----
  const onDelta = (d: string) => {
    setRunPhase("thinking");
    setMessages((msgs) => {
      const out = msgs.slice();
      const last = out[out.length - 1];
      if (last && last.role === "assistant" && !last.kind) {
        // Replace the transient "Starting…" placeholder with real output.
        if (last.placeholder) {
          out[out.length - 1] = { ...last, content: d, placeholder: false };
        } else {
          out[out.length - 1] = { ...last, content: last.content + d };
        }
      } else {
        out.push({ role: "assistant", content: d, ts: Date.now() });
      }
      return out;
    });
  };

  const onThought = (channel: string, _role: string, delta: string) => {
    if (channel !== "thinking") return;
    setMessages((msgs) => {
      const out = msgs.slice();
      const last = out[out.length - 1];
      if (last && last.role === "assistant" && !last.kind) {
        if (last.placeholder) {
          out[out.length - 1] = { ...last, thinking: delta, placeholder: false };
        } else {
          out[out.length - 1] = { ...last, thinking: (last.thinking ?? "") + delta };
        }
      } else {
        out.push({ role: "assistant", content: "", thinking: delta, ts: Date.now() });
      }
      return out;
    });
  };

  const onToolCall = (call: ToolCall) => {
    setRunPhase(`running ${call.name}`);
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

  const onSecondaryDelta = (d: string) => {
    setSecondaryMessages((msgs) => {
      const out = msgs.slice();
      const last = out[out.length - 1];
      if (last && last.role === "assistant" && !last.kind) {
        if (last.placeholder) {
          out[out.length - 1] = { ...last, content: d, placeholder: false };
        } else {
          out[out.length - 1] = { ...last, content: last.content + d };
        }
      } else {
        out.push({ role: "assistant", content: d, ts: Date.now() });
      }
      return out;
    });
  };

  const onSecondaryThought = (channel: string, _role: string, delta: string) => {
    if (channel !== "thinking") return;
    setSecondaryMessages((msgs) => {
      const out = msgs.slice();
      const last = out[out.length - 1];
      if (last && last.role === "assistant" && !last.kind) {
        if (last.placeholder) {
          out[out.length - 1] = { ...last, thinking: delta, placeholder: false };
        } else {
          out[out.length - 1] = { ...last, thinking: (last.thinking ?? "") + delta };
        }
      } else {
        out.push({ role: "assistant", content: "", thinking: delta, ts: Date.now() });
      }
      return out;
    });
  };

  const onSecondaryToolCall = (call: ToolCall) => {
    const firstArg = Object.values(call.args)[0] ?? "";
    setSecondaryMessages((msgs) => [
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

  const onSecondaryToolResult = (call: ToolCall, result: ToolExecResult) =>
    setSecondaryMessages((msgs) => {
      const out = msgs.slice();
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

  const showSecondaryMemoryPack = (pack: TeamMemoryPack) => {
    if (pack.total <= 0) return;
    setSecondaryMessages((msgs) => {
      const card: Msg = {
        role: "tool",
        kind: "tool",
        title: `memory_context(${memoryLabel(pack)})`,
        content: pack.block,
        status: "ok",
        ts: Date.now(),
      };
      const out = msgs.slice();
      const last = out[out.length - 1];
      if (last && last.role === "assistant" && last.placeholder) out.splice(out.length - 1, 0, card);
      else out.push(card);
      return out;
    });
  };

  const enrichSecondaryCodePromptWithMemory = async (user: string): Promise<{ text: string; pack: TeamMemoryPack }> => {
    const scope = memoryScope();
    const empty: TeamMemoryPack = { scope, query: user, block: "", total: 0, factCount: 0, worklogCount: 0 };
    if (!scope || !user.trim()) return { text: user, pack: empty };
    const pack = await retrieveScopedTeamMemoryPack(scope, user, 8, false);
    return { text: enrichInstructionWithMemory(pack.block, user), pack };
  };

  const memoryScope = () => ruleScopeRef.current.id || projectRoot || workspace || "";

  const memoryLabel = (pack: TeamMemoryPack): string =>
    pack.total > 0 ? `${pack.factCount} fact${pack.factCount === 1 ? "" : "s"} · ${pack.worklogCount} worklog` : "no hits";

  const showMemoryPack = (pack: TeamMemoryPack) => {
    if (pack.total <= 0) return;
    setMessages((msgs) => {
      const card: Msg = {
        role: "tool",
        kind: "tool",
        title: `memory_context(${memoryLabel(pack)})`,
        content: pack.block,
        status: "ok",
        ts: Date.now(),
      };
      const out = msgs.slice();
      const last = out[out.length - 1];
      if (last && last.role === "assistant" && last.placeholder) out.splice(out.length - 1, 0, card);
      else out.push(card);
      return out;
    });
  };

  const enrichCodePromptWithMemory = async (user: string): Promise<{ text: string; pack: TeamMemoryPack }> => {
    const scope = memoryScope();
    const empty: TeamMemoryPack = { scope, query: user, block: "", total: 0, factCount: 0, worklogCount: 0 };
    if (!scope || !user.trim()) return { text: user, pack: empty };
    const pack = await retrieveScopedTeamMemoryPack(scope, user, 8, false);
    return { text: enrichInstructionWithMemory(pack.block, user), pack };
  };

  const logCodeWork = async (instruction: string, result: string) => {
    const scope = memoryScope();
    await logScopedTeamWork(scope, "code", instruction, result);
  };

  // One agent turn against the SELECTED model. Routes by provider exactly like
  // ChatPage/AgentsPage: local/tuned → streamLocalChat (renders tool cards);
  // cloud/subscription → the shared streamChatCompletion. `silent` suppresses
  // streaming for the planning turn.
  const runTurn = async (
    system: string,
    user: string,
    history: HistoryItem[],
    signal: AbortSignal,
    opts?: { silent?: boolean; withEvents?: boolean; images?: ReturnType<typeof imageAttachments> },
  ): Promise<string> => {
    const provider = providerFor(modelId, availableModels);
    const isLocal = provider === "local" || provider === "tuned";
    const dDelta = opts?.silent ? () => {} : onDelta;
    const dThought = opts?.silent ? () => {} : onThought;
    const imgs = opts?.images ?? [];
    // CHAT mode (right-column selector): discuss/review only — read-only
    // tools, and the system prompt forbids edits/state-changing commands.
    const chatOnly = agentMode === "chat";
    const roTools = ["read_file", "list_dir", "grep", "glob", "web_search", "web_fetch"];
    // Project rules ride every turn — the same directives the agentic team
    // follows (empty string when the scope has none yet).
    // Shared agent-browser awareness: refresh (cheap window probe) so the coder
    // knows a page the user just opened is there to snapshot.
    await refreshBrowserState();
    const browserLine = getBrowserStateLine();
    const sys = system + formatDirectivesBlock(directivesRef.current)
      + (browserLine ? `\n\n${browserLine}` : "")
      + (chatOnly ? "\n\nMODE: CHAT — discuss, review, plan and answer questions ONLY. Do NOT edit or create files, and do NOT run commands that change any state. You may read files and search to ground your answers." : "");
    const { text: enrichedUser, pack } = await enrichCodePromptWithMemory(user);
    if (!opts?.silent) showMemoryPack(pack);
    if (isLocal) {
      const port = await ensureServer(modelId);
      if (!port) throw new Error("Local engine didn't come up — check the Server tab / install Local Inference.");
      return streamLocalChat({
        port, modelId, systemPrompt: sys,
        userContent: imgs.length ? openaiUserContent(enrichedUser, imgs) : enrichedUser, temperature: 0.3,
        signal, onDelta: dDelta, onThought: dThought, projectCwd: workspace,
        history, events: opts?.withEvents ? { onToolCall, onToolResult } : undefined,
        allowedTools: chatOnly ? roTools : undefined,
        getSteer: drainSteer,
      });
    }
    return streamChatCompletion(0, modelId, provider, sys, enrichedUser, 0.3, signal, dDelta, workspace, history, true, dThought, chatOnly ? roTools : undefined, imgs.length ? imgs : undefined, undefined, undefined, undefined, drainSteer);
  };

  // Second-agent turn: same backend as the primary chat, but streams into the
  // secondary transcript and uses its own abort controller.
  const runSecondaryTurn = async (
    system: string,
    user: string,
    history: HistoryItem[],
    signal: AbortSignal,
    opts?: { withEvents?: boolean },
  ): Promise<string> => {
    // The second agent runs its OWN model (falling back to the primary's when
    // it hasn't picked one), independent of the primary chat.
    const secModel = secondaryModelEffective;
    const provider = providerFor(secModel, availableModels);
    const isLocal = provider === "local" || provider === "tuned";
    await refreshBrowserState();
    const browserLine = getBrowserStateLine();
    const sys = system + formatDirectivesBlock(directivesRef.current)
      + (browserLine ? `\n\n${browserLine}` : "");
    const { text: enrichedUser, pack } = await enrichSecondaryCodePromptWithMemory(user);
    showSecondaryMemoryPack(pack);
    if (isLocal) {
      const port = await ensureServer(secModel);
      if (!port) throw new Error("Local engine didn't come up — check the Server tab / install Local Inference.");
      return streamLocalChat({
        port, modelId: secModel, systemPrompt: sys,
        userContent: enrichedUser, temperature: 0.3,
        signal, onDelta: onSecondaryDelta, onThought: onSecondaryThought, projectCwd: workspace,
        history, events: opts?.withEvents ? { onToolCall: onSecondaryToolCall, onToolResult: onSecondaryToolResult } : undefined,
        getSteer: () => "",
      });
    }
    return streamChatCompletion(0, secModel, provider, sys, enrichedUser, 0.3, signal, onSecondaryDelta, workspace, history, true, onSecondaryThought, undefined, undefined, undefined, undefined, undefined, () => "");
  };

  // `textOverride` = a notebook step (or leftover steer) dispatched directly,
  // bypassing the composer draft. Composer sends pass nothing.
  const send = async (textOverride?: string) => {
    const fromComposer = textOverride === undefined;
    const text = (textOverride ?? draft).trim();
    const images = fromComposer ? imageAttachments(codeImages) : [];
    if (!text && images.length === 0) return;
    if (busy) {
      // Coder is mid-turn → the message becomes a ⚡ steer (VS Code-style),
      // injected between tool calls on local models, at turn end otherwise —
      // never silently dropped. (Images can't ride a steer — text only.)
      if (text) {
        steerRef.current.push(text);
        if (fromComposer) setDraft("");
        setMessages((msgs) => [...msgs, { role: "user", content: `⚡ queued to steer the run → ${text}`, ts: Date.now() }]);
      }
      return;
    }
    if (!workspace) { setStatus(preparing ? "Workspace still preparing — Send unlocks in a moment." : "Pick a workspace folder first (Browse)."); return; }
    if (!modelId) { setStatus("No model selected — pick one above."); return; }
    if (fromComposer) { setDraft(""); setCodeImages([]); autoFeedHopsRef.current = 0; }
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const history: HistoryItem[] = messages
      .filter((m) => m.role === "user" || (m.role === "assistant" && !m.kind && !m.placeholder && m.content.trim()))
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    // The bubble shows a 🖼 marker; the actual images ride to the model via runTurn.
    const label = images.length ? `${text}${text ? "\n\n" : ""}🖼 ${images.length} image${images.length > 1 ? "s" : ""}` : text;
    setMessages((msgs) => [...msgs, { role: "user", content: label, ts: Date.now() }]);
    // Immediately show the user that something is happening, so the timer is not
    // the only visible change. The placeholder is replaced by real tokens/tools.
    setMessages((msgs) => [...msgs, { role: "assistant", content: "⏳ Starting…", placeholder: true, ts: Date.now() }]);
    setRunPhase("starting");
    let ok = false;
    let aborted = false;
    let replyText = "";
    try {
      setStatus(`Coding in ${workspace}`);
      const reply = await runTurn(CODING_SYSTEM(workspace), text || "(see attached image)", history, ctrl.signal, { withEvents: true, images });
      await logCodeWork(text || "(see attached image)", reply);
      replyText = reply;
      ok = true;
    } catch (e) {
      const err = e as { name?: string; message?: string };
      aborted = err.name === "AbortError";
      if (!aborted) {
        setMessages((msgs) => {
          const out = msgs.slice();
          const last = out[out.length - 1];
          if (last && last.role === "assistant" && last.placeholder) out.pop();
          return [...out, { role: "assistant", content: `⚠ ${err.message ?? e}`, ts: Date.now() }];
        });
      }
    } finally {
      setRunPhase(null);
      setLlamaLoading(null);
      // Drop any leftover placeholder so it doesn't persist after the run stops.
      setMessages((msgs) => {
        const last = msgs[msgs.length - 1];
        if (last && last.role === "assistant" && last.placeholder) return msgs.slice(0, -1);
        return msgs;
      });
      setBusy(false);
      abortRef.current = null;
      // After state settles: steers queued on a path that can't inject
      // mid-turn (CLI/API) land as a follow-up turn — never silently dropped
      // (unless the user hit Stop). Then, on a clean finish, auto-feed the
      // next pending notebook step (opt-in toggle, and only when THIS page
      // drives it — a second page on the same project must not pop the queue).
      // A non-clean finish with steps still pending says so instead of
      // letting the queue stall silently.
      setTimeout(() => {
        if (busySendRef.current) return;
        const leftover = drainSteer();
        if (leftover && !aborted) { void sendRef.current?.(leftover); return; }
        if (ok) {
          const st = takeNextAutoStep(ruleScopeRef.current.id, notebookSurfaceId);
          if (st) void sendRef.current?.(st.text);
        } else if (autoFeedWouldRun(ruleScopeRef.current.id, notebookSurfaceId)) {
          setMessages((msgs) => [...msgs, { role: "assistant", content: `📓 Auto-feed paused — the turn ${aborted ? "was stopped" : "ended with an error"}. Pending steps stay in the Notebook queue; send a message or press ▶ Start queue to continue.`, ts: Date.now() }]);
        }
      }, 80);
    }
    // ⇄ Selectable auto-feed: hand this finished reply to the SECOND agent as
    // its next user turn. Independent of the primary's own follow-up chain
    // (the second pane has its own busy/abort), so it runs in parallel.
    if (ok && replyText.trim() && feedPrimaryToSecondary) feedAcross("secondary", replyText);
  };
  // Ref-dispatch so follow-ups (steers / auto-feed / notebook) always hit the
  // CURRENT closure — fresh messages history, fresh busy state.
  sendRef.current = send;

  // ⇄ Last-reply auto-feed between the panes, selectable per direction. The
  // receiving agent gets the reply as a labelled user turn and RUNS — that's
  // what makes it a two-agent conversation rather than a paste. The hop cap
  // (reset by any manual send) keeps both-directions-on from looping forever.
  const feedAcross = (to: "primary" | "secondary", reply: string) => {
    if (autoFeedHopsRef.current >= AUTO_FEED_MAX_HOPS) {
      const notice: Msg = { role: "assistant", content: `⏸ Auto-feed paused after ${AUTO_FEED_MAX_HOPS} automatic exchanges — send a message in either pane to continue.`, ts: Date.now() };
      if (to === "secondary") setSecondaryMessages((m) => [...m, notice]); else setMessages((m) => [...m, notice]);
      return;
    }
    autoFeedHopsRef.current += 1;
    const labeled = `⇄ From the ${to === "secondary" ? "1st" : "2nd"} agent:\n\n${reply}`;
    if (to === "secondary") {
      setSecondaryOpen(true);
      void sendSecondaryRef.current?.(labeled);
    } else {
      // send() steers if the primary is mid-turn — the feed is never dropped.
      void sendRef.current?.(labeled);
    }
  };

  // Send from the second-agent pane. Runs independently of the primary chat,
  // shares the workspace/model, and keeps its own transcript + abort controller.
  // `textOverride` = an ⇄ auto-fed reply from the primary; composer sends pass
  // nothing (and reset the auto-feed hop counter — a human is in the loop).
  const sendSecondary = async (textOverride?: string) => {
    const fromComposer = textOverride === undefined;
    const text = (textOverride ?? secondaryDraft).trim();
    if (!text) return;
    if (secondaryBusy) {
      // No steer queue on the second pane (yet) — say so instead of dropping.
      setSecondaryMessages((m) => [...m, { role: "assistant", content: "⏸ Second agent is mid-turn — this message was not delivered. Wait or press Stop, then resend.", ts: Date.now() }]);
      return;
    }
    if (!workspace) { setStatus(preparing ? "Workspace still preparing — Send unlocks in a moment." : "Pick a workspace folder first (Browse)."); return; }
    if (!secondaryModelEffective) { setStatus("No model for the second agent — pick one in the second-agent pane (or select a primary model)."); return; }
    if (fromComposer) { setSecondaryDraft(""); autoFeedHopsRef.current = 0; }
    setSecondaryBusy(true);
    const ctrl = new AbortController();
    secondaryAbortRef.current = ctrl;
    const history: HistoryItem[] = secondaryMessages
      .filter((m) => m.role === "user" || (m.role === "assistant" && !m.kind && !m.placeholder && m.content.trim()))
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    setSecondaryMessages((m) => [...m, { role: "user", content: text, ts: Date.now() }]);
    setSecondaryMessages((m) => [...m, { role: "assistant", content: "⏳ Starting…", placeholder: true, ts: Date.now() }]);
    let aborted = false;
    let replyText = "";
    try {
      setStatus(`Second agent working in ${workspace}`);
      replyText = await runSecondaryTurn(CODING_SYSTEM(workspace), text, history, ctrl.signal, { withEvents: true });
    } catch (e) {
      const err = e as { name?: string; message?: string };
      aborted = err.name === "AbortError";
      if (!aborted) {
        setSecondaryMessages((msgs) => {
          const out = msgs.slice();
          const last = out[out.length - 1];
          if (last && last.role === "assistant" && last.placeholder) out.pop();
          return [...out, { role: "assistant", content: `⚠ ${err.message ?? e}`, ts: Date.now() }];
        });
      }
    } finally {
      setSecondaryMessages((msgs) => {
        const last = msgs[msgs.length - 1];
        if (last && last.role === "assistant" && last.placeholder) return msgs.slice(0, -1);
        return msgs;
      });
      setSecondaryBusy(false);
      secondaryAbortRef.current = null;
    }
    // ⇄ Selectable auto-feed back to the primary (send() steers if it's busy).
    if (!aborted && replyText.trim() && feedSecondaryToPrimary) feedAcross("primary", replyText);
  };
  sendSecondaryRef.current = sendSecondary;

  // The second agent's composer — ONE definition, rendered in two homes:
  // inside the pane when the panes are STACKED (narrow), or in the divided
  // bottom composer row aligned under its pane when side-by-side (wide) —
  // the fine-tuning-chat layout: columns above, inputs divided below.
  const renderSecondaryComposer = () => (
    <div style={{ display: "flex", gap: 6, alignItems: "flex-end", flexShrink: 0 }}>
      <textarea
        value={secondaryDraft}
        onChange={(e) => setSecondaryDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendSecondary(); } }}
        placeholder="Message the second agent… (same workspace, its own conversation & model)"
        rows={2}
        disabled={secondaryBusy}
        style={{ flex: 1, resize: "vertical", minHeight: 44, maxHeight: 120, padding: 8, background: "var(--bg-input)", border: "1px solid var(--border-strong)", borderRadius: 8, color: "var(--fg)", fontSize: 12.5, lineHeight: 1.5, fontFamily: "inherit", boxSizing: "border-box", opacity: secondaryBusy ? 0.6 : 1 }}
      />
      {secondaryBusy ? (
        <button
          onClick={() => { secondaryAbortRef.current?.abort(); }}
          title="Stop the second agent"
          style={{ ...btn, height: 38, padding: "0 14px", color: "#ff8c8c" }}
        >Stop</button>
      ) : (
        <button
          onClick={() => { void sendSecondary(); }}
          disabled={!secondaryDraft.trim()}
          title="Send to the second agent"
          style={{ ...btn, height: 38, padding: "0 14px", fontWeight: 700, opacity: secondaryDraft.trim() ? 1 : 0.5 }}
        >Send</button>
      )}
    </div>
  );

  // Notebook → coder: idle = dispatch now; busy = mid-run steer (drained
  // between tool calls on local models, at turn end otherwise).
  const feedFromNotebook = (text: string): "queued" | "dispatched" | "no-team" => {
    if (!workspace || !modelId) return "no-team";
    if (busySendRef.current) { steerRef.current.push(text); return "queued"; }
    void sendRef.current?.(text);
    return "dispatched";
  };
  // The notebook now lives INLINE in the right column (always mounted), so its
  // digest agent's local port is kept fresh with a light poll instead of a
  // refresh-on-open (best-effort — 0 = server down).
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      invoke<ServerStatus>("server_status")
        .then((s) => { if (alive) setSrvPort(s && s.running && s.port ? s.port : 0); })
        .catch(() => { if (alive) setSrvPort(0); });
    };
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [workspace]);

  const startChat = () => {
    setChatMode(true);
    // Resume the most recent conversation; start a fresh one only if none exist.
    if (!chatId || !chats.some((c) => c.id === chatId)) {
      if (chats[0]) setChatId(chats[0].id);
      else newChat();
    }
  };
  const sendChat = async () => {
    const text = chatDraft.trim();
    const images = imageAttachments(chatImages);
    if ((!text && images.length === 0) || chatBusy) return;
    if (!modelId) { setStatus("Pick a model above first."); return; }
    setChatDraft("");
    setChatImages([]);
    setChatBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    // The visible bubble shows the text + an image marker; the actual images
    // ride to the model via the multimodal content / attachments below.
    const label = images.length ? `${text}${text ? "\n\n" : ""}🖼 ${images.length} image${images.length > 1 ? "s" : ""}` : text;
    const userMsg: ChatMsg = { role: "user", content: label };
    const asstMsg: ChatMsg = { role: "assistant", content: "" };
    // Resolve/create the active thread; history = its current messages.
    let tid = chatId;
    const existing = chats.find((c) => c.id === tid);
    const history: HistoryItem[] = (existing?.messages ?? []).map((m) => ({ role: m.role, content: m.content }));
    if (existing) {
      updateThread(tid, (m) => [...m, userMsg, asstMsg], threadTitle(text || "Image"));
    } else {
      tid = newThreadId();
      setChatId(tid);
      setChats((cs) => [{ id: tid, title: threadTitle(text || "Image"), ts: Date.now(), messages: [userMsg, asstMsg] }, ...cs]);
    }
    const onD = (d: string) => updateThread(tid, (m) => {
      const c = [...m];
      const last = c[c.length - 1];
      if (last && last.role === "assistant") c[c.length - 1] = { ...last, content: last.content + d };
      return c;
    });
    try {
      const provider = providerFor(modelId, availableModels);
      const { text: enrichedText, pack } = await enrichCodePromptWithMemory(text);
      showMemoryPack(pack);
      if (provider === "local" || provider === "tuned") {
        const port = await ensureServer(modelId);
        if (!port) throw new Error("Local engine didn't come up — check the Server tab / install Local Inference.");
        await streamLocalChat({ port, modelId, systemPrompt: "You are a helpful, concise assistant.", userContent: openaiUserContent(enrichedText, images), temperature: 0.4, signal: ctrl.signal, onDelta: onD, onThought: () => {}, history });
      } else {
        // Pass a working dir so pasted images can be saved into it for the model
        // to read (codex -i / claude file-ref). Use the workspace if one is
        // selected, else the WSL scratch — without ANY cwd the image is dropped
        // ("I can't inspect the image"), which is the bug on a no-folder chat.
        const chatCwd = workspace || chatScratchRef.current || undefined;
        await streamChatCompletion(0, modelId, provider, "You are a helpful, concise assistant.", enrichedText, 0.4, ctrl.signal, onD, chatCwd, history, false, () => {}, undefined, images);
      }
    } catch (e) {
      const err = e as { name?: string; message?: string };
      if (err.name !== "AbortError") onD(`\n\n⚠ ${err.message ?? e}`);
    } finally {
      setChatBusy(false);
      abortRef.current = null;
    }
  };

  // Phase 3: plan the goal into task cards, then execute each step in turn,
  // moving its card pending → running → done/failed on the Kanban board.
  const planAndExecute = async () => {
    const goal = draft.trim();
    if (!goal || busy) return;
    if (!workspace) { setStatus(preparing ? "Workspace still preparing — Send unlocks in a moment." : "Pick a workspace folder first (Browse)."); return; }
    if (!modelId) { setStatus("No local model available — load one on the Models page."); return; }
    setDraft("");
    setBusy(true);
    setTasks([]);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setMessages((m) => [...m, { role: "user", content: `📋 Plan & build: ${goal}`, ts: Date.now() }]);
    // Show immediate feedback; planning is silent so the placeholder stays until
    // the plan is parsed and the Kanban board appears.
    setMessages((m) => [...m, { role: "assistant", content: "⏳ Planning…", placeholder: true, ts: Date.now() }]);
    setRunPhase("planning");
    try {
      // 1) PLAN — ordered step list (silent; no tool execution / streaming).
      setStatus("Planning…");
      const planReply = await runTurn(PLAN_SYSTEM(workspace, goal), "Return the JSON array of steps now.", [], ctrl.signal, { silent: true });
      const steps = parseSteps(planReply);
      // Remove the planning placeholder now that real state exists.
      setMessages((msgs) => {
        const out = msgs.slice();
        const last = out[out.length - 1];
        if (last && last.role === "assistant" && last.placeholder) out.pop();
        return out;
      });
      if (steps.length === 0) {
        setMessages((m) => [...m, { role: "assistant", content: "Couldn't produce a plan — try rephrasing the goal, or use Send for a one-shot.", ts: Date.now() }]);
        return;
      }
      const plan: Task[] = steps.map((title, i) => ({ id: i, title, status: "pending" }));
      setTasks(plan);
      // 2) ACT — run each step through the coding agent in sequence.
      for (let i = 0; i < plan.length; i++) {
        if (ctrl.signal.aborted) break;
        setTasks((ts) => ts.map((t) => (t.id === i ? { ...t, status: "running" } : t)));
        setStatus(`Step ${i + 1}/${plan.length}: ${plan[i].title}`);
        setMessages((m) => [...m, { role: "assistant", content: `\n### Step ${i + 1}: ${plan[i].title}\n`, ts: Date.now() }]);
        try {
          await runTurn(
            CODING_SYSTEM(workspace),
            `Overall goal: ${goal}\n\nDo THIS step now (only this step): ${plan[i].title}`,
            [], ctrl.signal, { withEvents: true },
          );
          setTasks((ts) => ts.map((t) => (t.id === i ? { ...t, status: "done" } : t)));
        } catch (e) {
          const err = e as { name?: string };
          if (err.name === "AbortError") break;
          setTasks((ts) => ts.map((t) => (t.id === i ? { ...t, status: "failed" } : t)));
          setMessages((m) => [...m, { role: "assistant", content: `⚠ Step ${i + 1} failed: ${e}`, ts: Date.now() }]);
          break;
        }
      }
      setStatus("Plan complete.");
    } catch (e) {
      const err = e as { name?: string; message?: string };
      if (err.name !== "AbortError") setMessages((m) => [...m, { role: "assistant", content: `⚠ ${err.message ?? e}`, ts: Date.now() }]);
    } finally {
      setRunPhase(null);
      setLlamaLoading(null);
      setMessages((msgs) => {
        const last = msgs[msgs.length - 1];
        if (last && last.role === "assistant" && last.placeholder) return msgs.slice(0, -1);
        return msgs;
      });
      setBusy(false);
      abortRef.current = null;
    }
  };

  // Stop = abort the JS side AND kill any spawned CLI child — the abort alone
  // never reached a claude/codex/kimi/gemini process, which kept running to
  // completion while the button looked dead.
  const stop = () => {
    abortRef.current?.abort();
    void invoke("cli_cancel_all").catch(() => { /* best-effort */ });
    setRunPhase(null);
    setLlamaLoading(null);
    setBusy(false);
  };
  const clearWorkspace = () => {
    if (busy) return;
    chatRuntime.setPayload(SID, (prev) => {
      const cur = (prev as CodeState) ?? DEFAULT_CODE_STATE;
      // Clear = RUN STATE only (tasks, streaming drafts, run timestamps).
      // BOTH chat transcripts — primary and the second-agent pane — survive;
      // wiping conversations is "Clear history"'s explicitly-confirmed job.
      return { ...cur, tasks: [], draft: "", secondaryDraft: "", runStartedAt: undefined, runEndedAt: undefined, status: `Workspace: ${cur.workspace || "(none)"}` };
    });
  };
  const clearChatHistory = () => {
    if (busy || secondaryBusy) return;
    if (chats.length === 0 && messages.length === 0 && secondaryMessages.length === 0) return;
    if (window.confirm("Clear the chat window and all saved chat history? This cannot be undone.")) {
      // The visible workspace transcripts — this is what the button promises.
      setMessages([]);
      setSecondaryMessages([]);
      // …and the saved just-chat threads.
      setChats([]);
      setChatId("");
      setChatDraft("");
      setChatImages([]);
      setShowHistory(false);
    }
  };

  // Clicking a file in the tree drops an @-reference into the composer so the
  // user can point the agent at it ("fix the bug in @src/foo.ts").
  const relOf = (abs: string) =>
    workspace && abs.startsWith(workspace) ? abs.slice(workspace.length).replace(/^[\\/]+/, "") : abs;
  // Click a file → OPEN it in a viewer (read its real contents). This is what
  // makes the tree useful instead of decorative.
  const openFile = async (abs: string) => {
    const rel = relOf(abs);
    const alreadyOpen = tabs.some((t) => t.abs === abs);
    setActiveAbs(abs);
    if (alreadyOpen) return; // already a tab — just focus it, keep its state/edits
    setTabs((ts) => (ts.some((t) => t.abs === abs) ? ts : [...ts, { abs, rel, content: "", loading: true, editing: false, draft: "", saving: false }]));
    try {
      const content = await invoke<string>("tool_read_file", { path: abs, cwd: undefined });
      patchTab(abs, { content, loading: false, draft: content });
    } catch (e: any) {
      patchTab(abs, { content: `⚠ Couldn't open this file: ${String(e?.message ?? e)}\n\n(It may be binary, too large, or outside the workspace.)`, loading: false, draft: "" });
    }
  };
  // ✎ Edit → make the open file editable (seed the draft from the on-disk text).
  const startEdit = () => { if (activeAbs) patchTab(activeAbs, (t) => ({ editing: true, draft: t.content, saveError: undefined })); };
  // Leave edit mode, discarding any unsaved changes.
  const cancelEdit = () => { if (activeAbs) patchTab(activeAbs, (t) => ({ editing: false, draft: t.content, saveError: undefined })); };
  // 💾 Save → write the draft back to disk (cwd = workspace so it clears the
  // write-jail, which only allows writes inside the project/temp/~OwLLM).
  const saveFile = async () => {
    if (!viewer) return;
    const { abs, draft } = viewer;
    patchTab(abs, { saving: true, saveError: undefined });
    try {
      await invoke("tool_write_file", { path: abs, content: draft, cwd: workspace || undefined });
      patchTab(abs, { content: draft, editing: false, saving: false });
    } catch (e: any) {
      patchTab(abs, { saving: false, saveError: String(e?.message ?? e) });
    }
  };
  // Close a tab (default: the active one), but don't silently drop unsaved edits.
  const closeViewer = (abs?: string) => {
    const target = abs ?? activeAbs;
    if (!target) return;
    const t = tabs.find((x) => x.abs === target);
    if (t && t.editing && t.draft !== t.content && !window.confirm("Discard unsaved changes to this file?")) return;
    dropTab(target);
  };
  // Drop an @reference to the open file into the composer (so the model edits it),
  // then dismiss just that tab.
  const referenceInChat = (rel: string) => {
    setDraft((d) => (d.trim() ? `${d.replace(/\s*$/, "")} @${rel} ` : `@${rel} `));
    if (activeAbs) dropTab(activeAbs);
  };
  // Project-composer image attachments — mirror addChatFiles (just-chat box).
  const addCodeFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith("image/")) continue;
      try { const a = await fileToImageAttachment(f); setCodeImages((x) => [...x, a]); }
      catch (e: any) { setStatus(String(e?.message ?? e)); }
    }
  };

  const wsShort = (projectRoot || workspace) ? (projectRoot || workspace)!.replace(/^.*[\\/]/, "") : "No folder";

  // ---- Just-chat mode (no folder): the everyday-chat surface --------------
  if (!workspace && chatMode) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg-panel)", color: "var(--fg)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
          <button onClick={() => setChatMode(false)} title="Back to Start" style={{ ...btn, height: 30, padding: "0 10px" }}>← Start</button>
          <button onClick={newChat} title="New conversation" style={{ ...btn, height: 30, padding: "0 10px", fontWeight: 700 }}>＋ New</button>
          {/* History dropdown — past conversations (persisted) */}
          <div style={{ position: "relative" }}>
            <button onClick={() => setShowHistory((v) => !v)} title="Past conversations" style={{ ...btn, height: 30, padding: "0 10px", color: "var(--fg)" }}>🕘 History{chats.length ? ` (${chats.length})` : ""}</button>
            {showHistory && (
              <>
                <div onClick={() => setShowHistory(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
                <div style={{ position: "absolute", top: 34, left: 0, zIndex: 41, width: 320, maxHeight: 380, overflowY: "auto", background: "var(--bg-panel)", border: "1px solid var(--border-strong)", borderRadius: 10, boxShadow: "var(--shadow-lg)", padding: 6 }}>
                  {chats.length === 0 && <div style={{ fontSize: 12.5, color: "var(--fg-muted)", padding: "8px 10px" }}>No past chats yet.</div>}
                  {chats.map((c) => (
                    <div key={c.id} onClick={() => { setChatId(c.id); setShowHistory(false); }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-input)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = c.id === chatId ? "var(--bg-input)" : "transparent")}
                      style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 8px", borderRadius: 7, cursor: "pointer", background: c.id === chatId ? "var(--bg-input)" : "transparent" }}>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: "var(--fg-strong)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.title || "Chat"}</span>
                      <span style={{ fontSize: 10.5, color: "var(--fg-muted)", whiteSpace: "nowrap" }}>{c.messages.length}</span>
                      <button onClick={(e) => { e.stopPropagation(); deleteThread(c.id); }} title="Delete" style={{ ...btn, height: 22, padding: "0 6px", color: "var(--fg-muted)", fontSize: 11 }}>✕</button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ width: 260, maxWidth: "45%" }}>
            <ModelPicker value={modelId} onChange={setModelId} models={availableModels} status={accountsStatus} fallbackLabel="Pick a model" />
          </div>
          {chatMsgs.length > 0 && <button onClick={() => chatId && updateThread(chatId, () => [])} title="Clear this conversation" style={{ ...btn, height: 30, padding: "0 10px", color: "var(--fg-muted)" }}>Clear</button>}
        </div>
        <div ref={chatSticky.ref} onScroll={chatSticky.onScroll} data-selectall-scope style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
          {chatMsgs.length === 0 && (
            <div style={{ margin: "auto", textAlign: "center", color: "var(--fg-muted)", maxWidth: 440 }}>
              <div style={{ fontSize: 34, marginBottom: 8 }}>💬</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--fg-strong)" }}>Just chat</div>
              <div style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.6 }}>
                Ask anything — no project, no setup. Uses the model picked above (local or cloud). To have the model work inside a folder, go back and pick “New project” or “Open a project folder”.
              </div>
            </div>
          )}
          {chatMsgs.map((m, i) => {
            const isUser = m.role === "user";
            return (
              <ChatBubble key={i} avatar={isUser ? "U" : "C"} sender={isUser ? "You" : "Assistant"} accent={isUser ? "#7aa2ff" : "#7ff0c5"} isUser={isUser} isStreaming={chatBusy && i === chatMsgs.length - 1 && !isUser} content={m.content} />
            );
          })}
        </div>
        <div style={{ borderTop: "1px solid var(--border)", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          {chatImages.length > 0 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {chatImages.map((a, i) => (
                <div key={i} style={{ position: "relative", width: 56, height: 56, borderRadius: 8, overflow: "hidden", border: "1px solid var(--border-strong)" }}>
                  <img src={`data:${a.mime};base64,${a.data_b64}`} alt={a.filename} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  <button onClick={() => setChatImages((x) => x.filter((_, j) => j !== i))} title="Remove" style={{ position: "absolute", top: 2, right: 2, width: 16, height: 16, borderRadius: 8, border: "none", background: "rgba(0,0,0,0.65)", color: "#fff", fontSize: 11, lineHeight: 1, cursor: "pointer", padding: 0 }}>×</button>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <input ref={chatFileRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={(e) => { if (e.target.files) void addChatFiles(e.target.files); e.target.value = ""; }} />
            <button onClick={() => chatFileRef.current?.click()} title="Attach image (or just paste one)" style={{ ...btn, height: 38, width: 38, justifyContent: "center", padding: 0, fontSize: 16 }}>📎</button>
            <textarea
              value={chatDraft}
              onChange={(e) => setChatDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
              onPaste={onChatPaste}
              placeholder="Message…  (paste or attach an image, Enter to send, Shift+Enter for newline)"
              rows={1}
              style={{ flex: 1, resize: "none", minHeight: 38, maxHeight: 160, background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--fg)", fontSize: 13.5, padding: "9px 12px", lineHeight: 1.5 }}
            />
            {chatBusy ? (
              <button onClick={() => { abortRef.current?.abort(); void invoke("cli_cancel_all").catch(() => { /* best-effort */ }); }} style={{ ...btn, height: 38, padding: "0 14px", color: "#ff8c8c" }}>Stop</button>
            ) : (
              <button onClick={sendChat} disabled={!chatDraft.trim() && chatImages.length === 0} style={{ ...btn, height: 38, padding: "0 16px", fontWeight: 700, background: "var(--accent)", color: "#06080d", border: "none", opacity: (chatDraft.trim() || chatImages.length) ? 1 : 0.5 }}>Send</button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ---- Onboarding: no folder open -----------------------------------------
  // The coding agent does nothing without a workspace, so instead of showing
  // the full (dead) IDE chrome that silently ignores input, show a real
  // get-started screen: open a folder, or reopen a recent project.
  if (!workspace && !preparing) {
    return (
      <div style={{ padding: "8px 10px 10px", height: "100%", display: "flex", flexDirection: "column", background: "var(--bg-panel)", color: "var(--fg)" }}>
        <div style={{ flex: 1, minHeight: 0, display: "flex", justifyContent: "center", overflowY: "auto" }}>
          <div style={{ width: "100%", maxWidth: 760, display: "flex", flexDirection: "column", gap: 30, padding: "48px 36px" }}>
            <div>
              <div style={{ fontSize: 30, fontWeight: 800, color: "var(--fg-strong)", letterSpacing: -0.4 }}>OwLLM Code</div>
              <div style={{ fontSize: 13.5, color: "var(--fg-muted)", marginTop: 5, lineHeight: 1.5 }}>
                Your local AI coding workspace — open a folder and your model reads, searches, edits and runs commands right inside it.
              </div>
            </div>

            <div style={{ display: "flex", gap: 52, alignItems: "flex-start", width: "100%", flexWrap: "wrap" }}>
              {/* START — VS Code-style action rows */}
              <div style={{ flex: "1 1 250px", minWidth: 0, display: "flex", flexDirection: "column" }}>
                <div style={{ fontSize: 19, fontWeight: 300, color: "var(--fg-strong)", marginBottom: 8 }}>Start</div>
                {([
                  { icon: "🆕", label: "New project…", onClick: openNewProject },
                  { icon: "📁", label: "Open a project folder…", onClick: pickWorkspace },
                  { icon: "💬", label: "New chat (no project)", onClick: startChat },
                  { icon: "🐙", label: gh?.connected ? `GitHub — ${gh.login}` : "Connect GitHub…", onClick: () => { setGhOpen((v) => !v); setGhMsg(""); } },
                ]).map((a) => (
                  <button key={a.label} onClick={a.onClick}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-input)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    style={{ display: "flex", alignItems: "center", gap: 11, background: "transparent", border: "none", padding: "7px 8px", borderRadius: 6, cursor: "pointer", textAlign: "left" }}>
                    <span style={{ fontSize: 15, width: 18, textAlign: "center" }}>{a.icon}</span>
                    <span style={{ color: "var(--accent)", fontWeight: 500, fontSize: 13.5 }}>{a.label}</span>
                  </button>
                ))}
                {/* GitHub connect form (inline, opens under the row) */}
                {ghOpen && !gh?.connected && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "4px 0 0 28px", padding: "10px 12px", background: "var(--bg-input)", border: "1px solid var(--border-strong)", borderRadius: 8 }}>
                    <div style={{ fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.5 }}>Paste a GitHub token so agents can clone private repos and push from inside the sandbox.</div>
                    <button onClick={() => { invoke("shell_open_url", { url: GITHUB_TOKEN_URL }).catch(() => {}); }} style={{ ...btn, height: 28, justifyContent: "center", color: "var(--accent)" }}>↗ Create a token (repo scope)</button>
                    <input type="password" value={ghToken} onChange={(e) => setGhToken(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") connectGithub(); }} placeholder="ghp_… or github_pat_…" style={{ height: 32, background: "var(--bg-surface)", border: "1px solid var(--border-strong)", borderRadius: 6, color: "var(--fg)", fontSize: 13, padding: "0 10px" }} />
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={connectGithub} disabled={ghBusy || !ghToken.trim()} style={{ ...btn, height: 32, flex: 1, justifyContent: "center", fontWeight: 700, background: "var(--accent)", color: "#06080d", border: "none", opacity: ghBusy || !ghToken.trim() ? 0.6 : 1 }}>{ghBusy ? "⏳ Connecting…" : "Connect"}</button>
                      <button onClick={() => { setGhOpen(false); setGhMsg(""); }} disabled={ghBusy} style={{ ...btn, height: 32, padding: "0 12px", color: "var(--fg-muted)" }}>Cancel</button>
                    </div>
                  </div>
                )}
                {gh?.connected && <button onClick={disconnectGithub} disabled={ghBusy} style={{ ...btn, height: 24, width: "fit-content", margin: "2px 0 0 28px", padding: "0 10px", color: "var(--fg-muted)", fontSize: 11 }}>Disconnect</button>}
                {ghMsg && <div style={{ margin: "4px 0 0 28px", fontSize: 11, color: ghMsg.startsWith("✓") || ghMsg.startsWith("Disconnected") ? "#7ff0c5" : "var(--fg-muted)" }}>{ghMsg}</div>}
                {/* Isolation status — compact line */}
                <div style={{ marginTop: 18, fontSize: 11.5, lineHeight: 1.5, color: sbox?.available ? "#7ff0c5" : "var(--fg-muted)" }}>
                  {sbox === null ? "⏳ Checking isolation (WSL)…"
                    : sbox.available ? `🛡 Isolation on — projects run inside ${engineLabel(sbox.kind)}${sbox.strong ? " (VM)" : ""}, off your ${isWsl ? "Windows" : "host"} files.${isWsl && provisionLog === "running" ? " Installing agent tools…" : ""}`
                    : `⚠ No sandbox engine — agents would run on the host. ${isWsl ? "Install WSL to isolate them." : "Install Lima/bubblewrap."}`}
                </div>
                {sbox && !sbox.available && (isWsl
                  ? <button onClick={installWsl} style={{ ...btn, marginTop: 8, height: 32, width: "fit-content", justifyContent: "center" }}>⬇ Install WSL (admin + reboot)</button>
                  : <button onClick={provisionTools} disabled={provisionLog === "running"} style={{ ...btn, marginTop: 8, height: 32, width: "fit-content", justifyContent: "center", opacity: provisionLog === "running" ? 0.6 : 1 }}>{provisionLog === "running" ? "⏳ Installing…" : "⬇ Install sandbox engine"}</button>
                )}
              </div>

              {/* RECENT — projects (name + path), VS Code style */}
              <div style={{ flex: "1 1 320px", minWidth: 0, display: "flex", flexDirection: "column" }}>
                <div style={{ fontSize: 19, fontWeight: 300, color: "var(--fg-strong)", marginBottom: 8 }}>Recent</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 360, overflowY: "auto", paddingRight: 2 }}>
                  {orderedRecents.length === 0 && (!isolation.enabled || sboxProjects.filter(p => !recents.includes(p.path)).length === 0) && (
                    <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>No projects yet — create one on the left to get started.</div>
                  )}
                  {/* Isolated projects that aren't already in recents */}
                  {isolation.enabled && sboxProjects.filter((p) => !recents.includes(p.path)).map((p) => (
                    <button
                      key={p.path}
                      onClick={() => openWorkspace(p.path)}
                      title={p.innerPath}
                      style={{ display: "block", textAlign: "left", background: "var(--bg-input)", border: "1px solid var(--border-strong)", borderRadius: 8, padding: "8px 10px", color: "var(--fg)", cursor: "pointer" }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-strong)" }}>🐧 {p.name}</div>
                      <div style={{ fontSize: 11, color: "var(--fg-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.innerPath}</div>
                    </button>
                  ))}
                  {orderedRecents.map((ws) => {
                    const pinned = !!recentsMeta[ws]?.pinned;
                    const isRenaming = renaming === ws;
                    return (
                      <div
                        key={ws}
                        style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--bg-input)", border: `1px solid ${pinned ? "var(--accent)" : "var(--border-strong)"}`, borderRadius: 8, padding: "8px 10px" }}
                      >
                        {isRenaming ? (
                          <input
                            autoFocus
                            value={renameDraft}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setRenaming(null); }}
                            onBlur={commitRename}
                            placeholder={ws.replace(/^.*[\\/]/, "") || ws}
                            style={{ flex: 1, minWidth: 0, height: 30, background: "var(--bg-surface)", border: "1px solid var(--accent)", borderRadius: 6, color: "var(--fg)", fontSize: 13, padding: "0 8px" }}
                          />
                        ) : (
                          <button
                            onClick={() => openWorkspace(ws)}
                            title={ws}
                            style={{ flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none", color: "var(--fg)", cursor: "pointer", padding: 0 }}
                          >
                            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-strong)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                              {pinned ? "📌" : "📂"} {recentLabel(ws)}
                            </div>
                            <div style={{ fontSize: 11, color: "var(--fg-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ws}</div>
                          </button>
                        )}
                        <button onClick={() => togglePin(ws)} title={pinned ? "Unpin" : "Pin to top"} style={{ ...btn, height: 26, padding: "0 8px", color: pinned ? "var(--accent)" : "var(--fg-muted)" }}>📌</button>
                        <button onClick={() => startRename(ws)} title="Rename (display only — folder is unchanged)" style={{ ...btn, height: 26, padding: "0 8px", color: "var(--fg-muted)" }}>✎</button>
                        <button onClick={() => removeRecent(ws)} title="Remove from recent projects (keeps files on disk)" style={{ ...btn, height: 26, padding: "0 8px", color: "var(--fg-muted)" }}>✕</button>
                      </div>
                    );
                  })}
                </div>

              </div>
            </div>
          </div>
        </div>

        {npOpen && (
          <div onClick={() => { if (!npBusy) setNpOpen(false); }} style={{ position: "fixed", inset: 0, background: "var(--bg-overlay)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
            <div onClick={(e) => e.stopPropagation()} style={{ width: "min(760px, 94vw)", maxHeight: "92vh", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 14, padding: 22, display: "flex", flexDirection: "column", gap: 14, boxShadow: "var(--shadow-lg)", overflow: "auto" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: "var(--fg-strong)", flex: 1 }}>🛡 New project</div>
                <button onClick={() => setNpOpen(false)} title="Cancel" style={{ width: 32, height: 32, border: "none", background: "var(--bg-surface)", color: "var(--fg)", borderRadius: 8, fontSize: 16, cursor: "pointer" }}>✕</button>
              </div>

              <div style={{ display: "flex", gap: 18, alignItems: "flex-start" }}>
                {/* LEFT — name/folder, model, info */}
                <div style={{ flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
                  {npIsolate && sbox?.available ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <label style={{ fontSize: 11, color: "var(--fg-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>Project name</label>
                      <input autoFocus value={npName} onChange={(e) => setNpName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") createNewProject(); }} placeholder="e.g. my-app"
                        style={{ height: 38, padding: "0 12px", borderRadius: 8, background: "var(--bg-input)", color: "var(--fg)", border: "1px solid var(--border)", fontSize: 14 }} />
                      <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>Created inside {engineLabel(sbox.kind)} at ~/owllm/{npName.trim() || "…"}</div>
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <label style={{ fontSize: 11, color: "var(--fg-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>Folder</label>
                      <div style={{ display: "flex", gap: 8 }}>
                        <input value={npFolder} onChange={(e) => setNpFolder(e.target.value)} placeholder="Pick a folder on your drive…"
                          style={{ flex: 1, minWidth: 0, height: 38, padding: "0 12px", borderRadius: 8, background: "var(--bg-input)", color: "var(--fg)", border: "1px solid var(--border)", fontSize: 14 }} />
                        <button onClick={npBrowseFolder} style={{ ...btn, height: 38, padding: "0 14px" }}>Browse…</button>
                      </div>
                    </div>
                  )}

                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <label style={{ fontSize: 11, color: "var(--fg-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>Model</label>
                    <ModelPicker value={modelId} onChange={setModelId} models={availableModels} status={accountsStatus} fallbackLabel="Pick a model" />
                  </div>

                  <div style={{ fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.6, background: "var(--bg-input)", border: "1px solid var(--border-strong)", borderRadius: 8, padding: "10px 12px" }}>
                    Your model works directly in this project — reading, searching, editing files and running commands. The conversation and plan are saved and return when you reopen it.
                  </div>
                </div>

                {/* RIGHT — GitHub status + isolation */}
                <div style={{ flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <label style={{ fontSize: 11, color: "var(--fg-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>GitHub</label>
                    {gh?.connected ? (
                      <div style={{ fontSize: 13, color: "#7ff0c5" }}>🐙 Connected as <b>{gh.login}</b></div>
                    ) : (
                      <button onClick={() => { setNpOpen(false); setGhOpen(true); setGhMsg(""); }} style={{ ...btn, height: 34, justifyContent: "center", color: "var(--fg-strong)" }}>🐙 Connect GitHub</button>
                    )}
                    {gh?.connected ? (
                      <label title="Creates a PRIVATE repository on your GitHub account named after the project, wires it as origin, and pushes the initial branch — nothing else to set up. You can also do this later from the Publisher card's ⚙ Set up repo." style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, color: npCreateRepo ? "#7ff0c5" : "var(--fg)", cursor: "pointer", background: "var(--bg-input)", border: "1px solid var(--border-strong)", borderRadius: 8, padding: "8px 10px" }}>
                        <input type="checkbox" checked={npCreateRepo} onChange={(e) => setNpCreateRepo(e.target.checked)} style={{ marginTop: 2 }} />
                        <span>
                          <b>Create a private GitHub repo</b> for this project
                          <br /><span style={{ fontSize: 11, color: "var(--fg-muted)" }}>named after the project · origin wired · first branch pushed</span>
                        </span>
                      </label>
                    ) : (
                      <div style={{ fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.5 }}>
                        Connect GitHub to clone private repos, push from the sandbox — and have a repo <b>created for you</b> when the project is born.
                      </div>
                    )}
                  </div>

                  {/* Cloud accounts inside the sandbox — mirrored AUTOMATICALLY
                      from your Accounts logins when you connect them. No manual
                      sync step. */}
                  {sbox?.available && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <label style={{ fontSize: 11, color: "var(--fg-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>Cloud accounts in sandbox</label>
                      {npLogins.filter((l) => l !== "keys").length > 0 ? (
                        <div style={{ fontSize: 12, color: "#7ff0c5" }}>
                          ✓ {npLogins.filter((l) => l !== "keys").join(", ")} available{npLogins.includes("keys") ? " · API keys" : ""} — isolated agents are authenticated.
                        </div>
                      ) : npLogins.includes("keys") ? (
                        <div style={{ fontSize: 12, color: "#7ff0c5" }}>✓ API keys available to isolated agents.</div>
                      ) : (
                        <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
                          No cloud accounts connected yet — connect one on the <b>Accounts</b> page and it's mirrored here automatically.
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.5 }}>
                        Your Accounts logins sync into the sandbox automatically and persist.
                      </div>
                    </div>
                  )}

                  <div style={{ display: "flex", flexDirection: "column", gap: 6, background: "var(--bg-input)", border: `1px solid ${npIsolate ? "var(--border-strong)" : "#d9b24a"}`, borderRadius: 8, padding: "10px 12px" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: sbox?.available ? "pointer" : "default" }}>
                      <input type="checkbox" checked={npIsolate} disabled={!sbox?.available} onChange={(e) => setNpIsolate(e.target.checked)} />
                      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--fg-strong)" }}>🛡 Run isolated{sbox?.available ? "" : " (engine not installed)"}</span>
                    </label>
                    {npIsolate ? (
                      <div style={{ fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.5 }}>
                        The agent's tools run inside {sbox ? engineLabel(sbox.kind) : "a Linux sandbox"} and can't reach your {isWsl ? "Windows" : "host"} files — recommended.
                      </div>
                    ) : (
                      <div style={{ fontSize: 11, color: "#caa84a", lineHeight: 1.5 }}>
                        Heads up: without isolation the agent runs directly on your system and can read or modify any file your account can. The write-jail and dangerous-command guards still apply, and OWLLM is designed to be safely used by anyone — but unless you have a specific reason, we suggest keeping isolation on. The Linux VM adds a much stronger layer of protection.
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button onClick={() => setNpOpen(false)} disabled={npBusy} style={{ ...btn, height: 38, padding: "0 14px" }}>Cancel</button>
                <div style={{ flex: 1 }} />
                <button
                  onClick={createNewProject}
                  disabled={npBusy || (!npIsolate && !npFolder.trim())}
                  style={{ height: 38, padding: "0 22px", border: "none", borderRadius: 9, background: "var(--accent)", color: "#06080d", fontWeight: 700, fontSize: 14, cursor: npBusy ? "not-allowed" : "pointer", opacity: npBusy || (!npIsolate && !npFolder.trim()) ? 0.6 : 1 }}
                >
                  {npBusy ? "Creating…" : (npIsolate ? "Create isolated project" : "Open folder")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: "8px 10px 10px", height: "100%", display: "flex", flexDirection: "column", gap: 8, background: "var(--bg-panel)", color: "var(--fg)" }}>
      {/* Header: workspace · model · status */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={closeProject} disabled={busy} title="Back to the project list (your files stay on disk)" style={btn}>← Projects</button>
        <button onClick={pickWorkspace} disabled={busy} title={workspace ? `Current: ${workspace}\nClick to switch to another folder` : "Open a project folder"} style={{ ...btn, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis" }}>📁 {wsShort} ⇄</button>
        {/* Honest isolation badge (P1-1, shared helper): turns LOUD red when
            isolation is enabled but this workspace runs on the host. */}
        {(() => {
          const iso = isolationBadge(workspace, isolation.enabled);
          return (
            <span
              title={iso.title}
              style={{
                fontSize: 11, fontWeight: iso.hostFallback ? 800 : 700, padding: "3px 8px",
                borderRadius: 6, whiteSpace: "nowrap",
                background: iso.bg, color: iso.color, border: `1px solid ${iso.border}`,
              }}
            >
              {iso.text}
            </span>
          );
        })()}
        {isolatedNow && (
          <button
            onClick={syncLogins}
            title="Sync your cloud logins (codex/claude/gemini/kimi + API keys) from Windows into the sandbox. Runs automatically too — use this to re-sync after logging in to a new provider."
            style={{ ...btn, height: 26, padding: "0 8px", fontSize: 11, whiteSpace: "nowrap", color: "var(--fg-muted)" }}
          >
            🔑 Sync logins
          </button>
        )}
        {sbox?.available && (
          <button
            onClick={convertProject}
            disabled={convertBusy}
            title={isolatedNow
              ? "Copy this project OUT to a normal (not isolated) folder and open it"
              : "Copy this project INTO the Linux sandbox (isolated) and open it"}
            style={{ ...btn, height: 26, padding: "0 8px", fontSize: 11, whiteSpace: "nowrap", color: "var(--fg-muted)", opacity: convertBusy ? 0.6 : 1 }}
          >
            {convertBusy ? "⏳…" : isolatedNow ? "⇲ Make not-isolated" : "⇱ Make isolated"}
          </button>
        )}
        <div style={{ flex: 1 }} />
        {/* Run stopwatch — same component as the Agents-page team timer. Ticks
            green while the agent works this turn, freezes muted when it stops. */}
        <RunTimerChip
          runStartedAt={runStartedAt}
          runEndedAt={runEndedAt}
          active={busy}
          title={busy ? "The agent is working — elapsed time" : "How long the last turn took"}
        />
        {busy && runPhase && (
          <div
            data-ui="run-phase"
            style={{
              display: "flex", alignItems: "center", gap: 6, height: 24, padding: "0 10px",
              borderRadius: 999, fontSize: 11, fontWeight: 700, color: "#ffd97a",
              background: "rgba(255,217,122,0.12)", border: "1px solid rgba(255,217,122,0.35)",
            }}
          >
            <span className="owl-pulse-dot" style={{ width: 7, height: 7, borderRadius: 4, background: "#ffd97a", display: "inline-block" }} />
            {runPhase === "warming up model" && llamaLoading
              ? `⏳ Warming up model · ${llamaLoading.sec}s`
              : runPhase}
          </div>
        )}
        <div style={{ flex: 1 }} />
        {/* Model picker + Clear buttons live in the chat pane's own header
            below, aligned with the chat window (user spec 2026-07-10). */}
      </div>

      {/* Phase 3: Kanban plan/act board (only while a plan is active) */}
      {tasks.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          {([["pending", "📋 To do"], ["running", "⚙ Doing"], ["done", "✓ Done"]] as const).map(([col, label]) => {
            const inCol = tasks.filter((t) =>
              col === "done" ? (t.status === "done" || t.status === "failed") : t.status === col,
            );
            return (
              <div key={col} style={{ flex: 1, minWidth: 0, background: "var(--bg-input)", border: "1px solid var(--border-strong)", borderRadius: 8, padding: 6, display: "flex", flexDirection: "column", gap: 5 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-muted)", padding: "0 2px" }}>{label} ({inCol.length})</div>
                {inCol.map((t) => {
                  const c = t.status === "failed" ? "#ff8c8c" : t.status === "done" ? "#7ff0c5" : t.status === "running" ? "#ffd97a" : "var(--fg-muted)";
                  const mark = t.status === "failed" ? "✗" : t.status === "done" ? "✓" : t.status === "running" ? "⟳" : "•";
                  return (
                    <div key={t.id} title={t.title} style={{ fontSize: 11, lineHeight: 1.35, color: "var(--fg)", background: "var(--bg-surface)", border: `1px solid ${c}55`, borderLeft: `3px solid ${c}`, borderRadius: 5, padding: "5px 7px", overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" as const }}>
                      <span style={{ color: c, fontWeight: 700 }}>{mark}</span> {t.title}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {/* Second-agent pane toggle — a parallel/hand-off agent chat beside the
          primary one, with its own transcript and its own input area. Shown
          once a workspace is open. */}
      {workspace && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
          <button
            onClick={() => setSecondaryOpen(!secondaryOpen)}
            title="Show a second, independent agent chat pane beside this one — its own transcript and input, same workspace and model."
            style={{ ...btn, height: 26 }}
          >{secondaryOpen ? "◧ Hide 2nd agent" : "◨ Show 2nd agent"}</button>
          {/* ⇄ selectable last-reply auto-feed, PER DIRECTION. On = the finished
              reply is handed to the other agent as its next turn (labelled ⇄).
              Both on = agent-to-agent conversation, capped at 6 automatic
              exchanges (any manual send resets the cap). */}
          {secondaryOpen && (
            <>
              <label title="When the 1st agent finishes a reply, automatically feed it to the 2nd agent as its next turn." style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 600, color: feedPrimaryToSecondary ? "#7ff0c5" : "var(--fg-muted)", cursor: "pointer" }}>
                <input type="checkbox" checked={feedPrimaryToSecondary} onChange={(e) => setFeedPrimaryToSecondary(e.target.checked)} />
                ⇄ 1st → 2nd
              </label>
              <label title="When the 2nd agent finishes a reply, automatically feed it to the 1st agent as its next turn." style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 600, color: feedSecondaryToPrimary ? "#c7a8ff" : "var(--fg-muted)", cursor: "pointer" }}>
                <input type="checkbox" checked={feedSecondaryToPrimary} onChange={(e) => setFeedSecondaryToPrimary(e.target.checked)} />
                ⇄ 2nd → 1st
              </label>
              {feedPrimaryToSecondary && feedSecondaryToPrimary && (
                <span style={{ fontSize: 10.5, color: "#ffd97a" }}>agent↔agent conversation — pauses after {6} automatic exchanges</span>
              )}
            </>
          )}
        </div>
      )}

      {/* Cold-load banner — mirrors AgentsPage so the user can see WHY the
          run is taking time before any tokens appear. */}
      {llamaLoading && (
        <div
          style={{
            flexShrink: 0, display: "flex", alignItems: "center", gap: 10,
            padding: "8px 12px", borderRadius: 8, fontSize: 12,
            background: "rgba(255,217,122,0.12)", border: "1px solid rgba(255,217,122,0.35)",
            color: "#ffd97a",
          }}
        >
          <span style={{ fontSize: 14 }}>⏳</span>
          <span>
            <b>Local model is still warming up</b> · {llamaLoading.sec}s elapsed
            {llamaLoading.reason && (
              <> · last: <code style={{ background: "rgba(0,0,0,0.25)", padding: "1px 4px", borderRadius: 4 }}>{llamaLoading.reason}</code></>
            )}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, opacity: 0.85 }}>Press Stop to abort.</span>
        </div>
      )}

      {/* Body: file-tree rail + transcript */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 8 }}>
        {workspace && (
          <div style={{ width: 220, flexShrink: 0, display: "flex", flexDirection: "column", overflowY: "auto", overflowX: "hidden", background: "var(--bg-input)", border: "1px solid var(--border-strong)", borderRadius: 8, padding: 4 }}>
            <TreeDir path={workspace} name={wsShort} depth={0} defaultOpen onOpenFile={openFile} />
            <PublishCards
              repoDir={projectRoot || workspace}
              gitDir={workspace}
              branch={branch}
              projectRoot={projectRoot}
              isolated={isolated}
              disabled={busy}
              onStatus={setStatus}
            />
          </div>
        )}
      {/* Center column: chat panes on top, status + composer at the bottom of
          the SAME column — so the input box is exactly as wide as the chat
          window (the rail and the right panel run the full height beside it). */}
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Chat panes: the primary chat + an optional second-agent pane. Side by
          side when the viewport is wide (≥1000px), stacked when narrow; each
          pane owns its own scroll. With the second pane closed this wrapper has
          a single child, so the primary fills the width exactly as before. */}
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: wideView ? "row" : "column", gap: 8 }}>
        {/* Primary pane — same box anatomy as the second-agent pane: a slim
            header (model picker + Clear buttons, top-right of the chat window)
            over its own scrolling transcript. */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", gap: 8, padding: 12, background: "var(--bg-input)", border: "1px solid var(--border-strong)", borderRadius: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--fg-muted)" }}>Coder</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>Model</span>
            <div style={{ minWidth: 220, maxWidth: 320 }}>
              {/* THE shared model picker — same component, same list_models source,
                  and the SAME full set (local + cloud + subscriptions) as AgentsPage.
                  No localOnly: the agentic Code page offers every model the other
                  agentic surfaces do; execution routes by provider below. */}
              <ModelPicker
                value={modelId}
                onChange={setModelId}
                models={availableModels}
                status={accountsStatus}
                disabled={busy}
                fallbackLabel="(pick a model)"
              />
            </div>
            <button onClick={clearWorkspace} disabled={busy || (tasks.length === 0 && draft === "" && secondaryDraft === "" && runStartedAt == null && runEndedAt == null)} title="Clear the current run (tasks, drafts and run state) but keep the chat" style={{ ...btn, height: 26 }}>Clear</button>
            <button onClick={clearChatHistory} disabled={busy || secondaryBusy || (chats.length === 0 && messages.length === 0 && secondaryMessages.length === 0)} title="Clear the chat window and all saved chat history" style={{ ...btn, height: 26 }}>Clear history</button>
          </div>
      <div
        ref={transcriptSticky.ref}
        onScroll={transcriptSticky.onScroll}
        className="selectable-chat"
        data-selectall-scope
        style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}
      >
        {messages.length === 0 ? (
          preparing ? (
            <div style={{ margin: "auto", textAlign: "center", color: "var(--fg-muted)", fontSize: 13, maxWidth: 480, lineHeight: 1.6 }}>
              <div style={{ fontSize: 30, marginBottom: 8 }}>⏳</div>
              Preparing a private workspace for <b>{(projectRoot || "").replace(/^.*[\\/]/, "")}</b> on its own branch…<br />
              <span style={{ fontSize: 12 }}>A private git worktree is being checked out (a few seconds on a large repo). Your real folder stays untouched until you Merge. You can type your request now — Send unlocks the moment it's ready.</span>
            </div>
          ) : (
          <div style={{ margin: "auto", textAlign: "center", color: "var(--fg-muted)", fontSize: 13, maxWidth: 460, lineHeight: 1.6 }}>
            <div style={{ fontSize: 30, marginBottom: 8 }}>🛠️</div>
            Your local model codes directly in <b>{workspace || "a folder you pick"}</b>.<br />
            It can read, search, edit and create files and run commands there.<br />
            <span style={{ fontSize: 12 }}>Pick a folder, choose a model, and describe the change.</span>
          </div>
          )
        ) : (
          messages.map((m, i) => {
            if (m.role === "tool") {
              return <ToolEventCard key={i} kind={m.kind ?? "tool"} title={m.title ?? "tool"} status={m.status} content={m.content} />;
            }
            const isUser = m.role === "user";
            const isStreaming = busy && i === messages.length - 1 && m.role === "assistant";
            const canForward = m.role === "assistant" && i === messages.length - 1 && !isStreaming && !!m.content?.trim();
            return (
              <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <ChatBubble
                  avatar={isUser ? "U" : "C"}
                  sender={isUser ? "You" : "Coder"}
                  accent={isUser ? "#7aa2ff" : "#7ff0c5"}
                  isUser={isUser}
                  isStreaming={isStreaming}
                  content={m.content}
                  thinking={m.thinking}
                  ts={m.ts}
                />
                {canForward && (
                  <div style={{ display: "flex", justifyContent: "flex-end", paddingRight: 4 }}>
                    <button
                      onClick={() => {
                        const forwarded: Msg = {
                          role: "user",
                          content: `Forwarded from primary agent:\n\n${m.content}`,
                          ts: Date.now(),
                        };
                        setSecondaryMessages((prev) => [...((prev as Msg[] | undefined) ?? []), forwarded]);
                        setSecondaryOpen(true);
                      }}
                      title="Forward this reply to the second agent"
                      style={{ ...btn, height: 24, padding: "0 10px", fontSize: 11, fontWeight: 600, color: "var(--fg-muted)" }}
                    >
                      → Forward to second agent
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
        </div>
        </div>
        {/* Second-agent chat pane — parallel/hand-off coder using the same
            workspace and model as the primary chat, with its own transcript. */}
        {secondaryOpen && (
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", gap: 8, padding: 12, background: "var(--bg-input)", border: "1px solid var(--border-strong)", borderRadius: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--fg-muted)" }}>Second agent</span>
              {/* The second agent's OWN model — independent of the primary chat.
                  Empty falls back to the primary model ("Same as 1st agent"). */}
              <ModelPicker
                value={secondaryModelId}
                onChange={setSecondaryModelId}
                models={availableModels}
                status={accountsStatus}
                fallbackLabel="Same as 1st agent"
              />
              <span style={{ flex: 1 }} />
              <button onClick={() => setSecondaryOpen(false)} title="Close the second-agent pane" style={{ ...btn, height: 24, padding: "0 8px", fontSize: 11, color: "var(--fg-muted)" }}>✕ Close</button>
            </div>
            {/* Transcript — its own scroll column, mirrors the primary chat so the
                input never scrolls away with the messages. */}
            <div className="selectable-chat" data-selectall-scope style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
            {secondaryMessages.length === 0 ? (
              <div style={{ margin: "auto", textAlign: "center", color: "var(--fg-muted)", fontSize: 13, maxWidth: 460, lineHeight: 1.6 }}>
                Second agent — a parallel coder on the same workspace, with its own conversation and its own model (pick one above, or it uses the primary chat's model).
              </div>
            ) : (
              secondaryMessages.map((m, i) => {
                if (m.role === "tool") {
                  return <ToolEventCard key={i} kind={m.kind ?? "tool"} title={m.title ?? "tool"} status={m.status} content={m.content} />;
                }
                const isUser = m.role === "user";
                const isSecondaryStreaming = secondaryBusy && i === secondaryMessages.length - 1 && !isUser;
                const canForwardToPrimary = !isUser && !isSecondaryStreaming && m.content && m.content.trim().length > 0;
                return (
                  <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <ChatBubble
                      avatar={isUser ? "U" : "C2"}
                      sender={isUser ? "You" : "Coder 2"}
                      accent={isUser ? "#7aa2ff" : "#c7a8ff"}
                      isUser={isUser}
                      isStreaming={isSecondaryStreaming}
                      content={m.content}
                      thinking={m.thinking}
                      ts={m.ts}
                    />
                    {canForwardToPrimary && (
                      <div style={{ display: "flex", justifyContent: "flex-end", paddingRight: 4 }}>
                        <button
                          onClick={() => {
                            const forwarded: Msg = {
                              role: "user",
                              content: `Forwarded from second agent:\n\n${m.content}`,
                              ts: Date.now(),
                            };
                            setMessages((prev) => [...prev, forwarded]);
                          }}
                          title="Forward this reply to the primary agent"
                          style={{ ...btn, height: 24, padding: "0 10px", fontSize: 11, fontWeight: 600, color: "var(--fg-muted)" }}
                        >
                          ← Forward to primary agent
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
            </div>
            {/* Composer — in-pane only when the panes are STACKED (narrow view).
                Side-by-side, it moves to the divided bottom composer row so the
                two inputs sit aligned under their panes (fine-tune-chat style). */}
            {!wideView && renderSecondaryComposer()}
          </div>
        )}
      </div>

      {/* Status line — expands to multiple lines for the per-credential
          sync report (P1-2); stays a single ellipsized line otherwise. */}
      <div style={status.includes("\n")
        ? { fontSize: 11, color: "var(--fg-muted)", whiteSpace: "pre-line", lineHeight: 1.6, flexShrink: 0 }
        : { fontSize: 11, color: "var(--fg-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flexShrink: 0 }}>{status}</div>

      {/* Composer row — lives in the SAME column as the chat panes, so it is
          always exactly as wide as the chat window. DIVIDED (fine-tune-chat
          style) when the second agent is open side-by-side: primary composer
          left, second-agent composer right — same 1fr/1fr + gap as the panes
          above, so each input lines up under its pane. */}
      <div style={secondaryOpen && wideView
        ? { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, alignItems: "end", flexShrink: 0 }
        : { flexShrink: 0 }}>
      <div
        onDragOver={(e) => { if (Array.from(e.dataTransfer?.items ?? []).some((it) => it.kind === "file")) { e.preventDefault(); } }}
        onDrop={(e) => { const f = Array.from(e.dataTransfer?.files ?? []).filter((x) => x.type.startsWith("image/")); if (f.length) { e.preventDefault(); void addCodeFiles(f); } }}
        style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}
      >
        {codeImages.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {codeImages.map((img, i) => (
              <div key={i} style={{ position: "relative", width: 48, height: 48, borderRadius: 6, overflow: "hidden", border: "1px solid var(--border-strong)" }}>
                <img src={`data:${img.mime};base64,${img.data_b64}`} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                <button onClick={() => setCodeImages((x) => x.filter((_, j) => j !== i))} title="Remove" style={{ position: "absolute", top: 2, right: 2, width: 16, height: 16, borderRadius: 8, border: "none", background: "rgba(0,0,0,0.65)", color: "#fff", fontSize: 11, lineHeight: 1, cursor: "pointer", padding: 0 }}>×</button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <input ref={codeFileRef} type="file" accept="image/*" multiple style={{ display: "none" }}
                 onChange={(e) => { if (e.target.files) void addCodeFiles(e.target.files); e.target.value = ""; }} />
          <button onClick={() => codeFileRef.current?.click()} title="Attach image(s)" style={{ ...btn, height: 44, padding: "0 12px" }}>📎</button>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => { const imgs = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/")); if (imgs.length) { e.preventDefault(); void addCodeFiles(imgs); } }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (agentMode === "plan" && !busy) { void planAndExecute(); } else { void send(); } } }}
            placeholder={preparing ? "Type your request while the workspace finishes preparing…" : workspace ? (agentMode === "chat" ? "Ask, discuss, review — nothing is modified in chat mode…" : "Describe the change, bug, or feature… (paste/drop images too)") : "Pick a workspace folder first…"}
            rows={3}
            style={{ flex: 1, resize: "vertical", minHeight: 82, maxHeight: 142, padding: 10, background: "var(--bg-input)", border: "1px solid var(--border-strong)", borderRadius: 8, color: "var(--fg)", fontSize: 13, lineHeight: 1.5, fontFamily: "inherit", boxSizing: "border-box" }}
          />
          {busy ? (
            <button onClick={stop} style={{ ...btn, background: "rgba(180,60,60,0.85)", color: "#fff", border: "none", height: 44, padding: "0 16px" }}>Stop</button>
          ) : (
            /* One primary button — what it does follows the right-column MODE:
               plan → Kanban plan/act, auto → act directly, chat → discuss only. */
            <button
              onClick={() => { if (agentMode === "plan") { void planAndExecute(); } else { void send(); } }}
              disabled={(!draft.trim() && (agentMode === "plan" || codeImages.length === 0)) || preparing}
              title={preparing ? "Preparing the workspace — unlocks in a moment"
                : agentMode === "plan" ? "Break the goal into ordered steps, then build them one by one (Kanban)"
                : agentMode === "chat" ? "Discuss/review only — no edits, no state-changing commands"
                : "Act directly — read, edit and run in the workspace"}
              style={{ ...btn, background: "var(--accent)", color: "#06080d", border: "none", height: 44, padding: "0 16px", fontWeight: 700, opacity: ((draft.trim() || (agentMode !== "plan" && codeImages.length)) && !preparing) ? 1 : 0.5 }}
            >{preparing ? "⏳ Preparing…" : agentMode === "plan" ? "📋 Plan" : agentMode === "chat" ? "💬 Chat" : "Send"}</button>
          )}
        </div>
      </div>
      {/* Right cell of the divided composer row — the second agent's input,
          aligned under its pane. (In narrow view it lives inside the pane.) */}
      {secondaryOpen && wideView && (
        <div style={{ minWidth: 0 }}>{renderSecondaryComposer()}</div>
      )}
      </div>
      </div>
        {/* Right column (resizable): utility header (mode / terminal / usage)
            + two PAGES on a tab strip — ⚡ Super User (project rules, shared
            with the team) and 📓 Notebook (the shared RunNotebook, inline).
            User spec 2026-07-04. */}
        {workspace && ruleScope.id && (
          <CodeSidePanel
            scopeId={ruleScope.id}
            sharedWithTeam={ruleScope.shared}
            directives={directives}
            onDirectivesChanged={reloadDirectives}
            mode={agentMode}
            onModeChange={setAgentMode}
            terminalOpen={termOpen && !termHidden}
            onToggleTerminal={() => {
              // Closed → open. Hidden → re-show (shell was kept alive).
              // Visible → hide (shell stays alive; ✕ on the popup kills it).
              if (!termOpen) { setTermOpen(true); setTermHidden(false); }
              else setTermHidden((h) => !h);
            }}
            browserOpen={browserOpen}
            onToggleBrowser={() => setBrowserOpen((v) => !v)}
            usageProvider={providerFor(modelId, availableModels)}
            notebook={
              <RunNotebook
                inline
                projectId={ruleScope.id || null}
                surfaceId={notebookSurfaceId}
                projectName={(projectRoot || workspace || "").replace(/^.*[\\/]/, "")}
                running={busy}
                onFeed={feedFromNotebook}
                modelId={modelId}
                port={srvPort}
                models={availableModels}
                accountsStatus={accountsStatus}
              />
            }
          />
        )}
      </div>

      {/* 🖥 Terminal popup — a real PTY shell in the workspace folder, floating
          above THIS app's UI only (fixed overlay, no OS always-on-top). */}
      {termOpen && workspace && (
        <div
          ref={termBoxRef}
          style={{
            position: "fixed",
            ...(termPos ? { left: termPos.x, top: termPos.y } : { right: 24, bottom: 24 }),
            width: "min(720px, 80vw)", height: "min(440px, 70vh)", zIndex: 1200,
            display: termHidden ? "none" : "flex", flexDirection: "column",
            background: "var(--bg-panel)", border: "1px solid var(--border-strong)", borderRadius: 10,
            boxShadow: "0 18px 60px rgba(0,0,0,0.6)", overflow: "hidden",
          }}
        >
          {/* Title bar — drag to move the popup anywhere over the app. */}
          <div onMouseDown={onTermDragStart} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderBottom: "1px solid var(--border)", cursor: "move", userSelect: "none" }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)" }}>🖥 Terminal — {wsShort}</span>
            <span style={{ flex: 1 }} />
            <button className="ghost-btn" onClick={() => setTermHidden(true)} title="Hide (shell keeps running — reopen from the 🖥 Terminal button)" style={{ height: 24, width: 26, padding: 0, fontSize: 13 }}>—</button>
            <button className="ghost-btn" onClick={() => { setTermOpen(false); setTermHidden(false); }} title="Close (ends the shell)" style={{ height: 24, width: 26, padding: 0, fontSize: 12 }}>✕</button>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            <PtyTerminal
              cli={navigator.userAgent.includes("Windows") ? "powershell" : "bash"}
              args={[]}
              cwd={workspace}
              onExit={() => { setTermOpen(false); setTermHidden(false); }}
            />
          </div>
        </div>
      )}

      {/* 🌐 Agent Browser popup — remote/manager for the native embedded browser
          (a real OwLLM WebviewWindow) the agents drive with the browser_* tools.
          Shared component; also handles the password vault + browser import. */}
      <BrowserPanel open={browserOpen} onClose={() => setBrowserOpen(false)} />

      {/* File viewer — opening a file in the tree shows its real contents, and
          (via ✎ Edit → 💾 Save) lets you edit and write it back to disk. */}
      {viewer && (() => {
        const dirty = viewer.editing && viewer.draft !== viewer.content;
        const canEdit = !viewer.loading && !viewer.content.startsWith("⚠ Couldn't open");
        return (
        <div onClick={() => closeViewer()} style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "min(980px, 94vw)", maxHeight: "88vh", display: "flex", flexDirection: "column", background: "var(--bg-panel)", border: "1px solid var(--border-strong)", borderRadius: 12, overflow: "hidden", boxShadow: "var(--shadow-lg)" }}>
            {/* Tab strip — every open file. Click to switch, ✕ to close. Shown once
                more than one file is open. */}
            {tabs.length > 1 && (
              <div style={{ display: "flex", alignItems: "stretch", gap: 2, padding: "6px 8px 0", borderBottom: "1px solid var(--border)", overflowX: "auto", background: "var(--bg-panel)" }}>
                {tabs.map((t) => {
                  const active = t.abs === activeAbs;
                  const tdirty = t.editing && t.draft !== t.content;
                  return (
                    <div key={t.abs} onClick={() => setActiveAbs(t.abs)} title={t.abs}
                      style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px 6px 10px", cursor: "pointer", maxWidth: 220, flex: "0 0 auto", borderRadius: "8px 8px 0 0",
                        background: active ? "var(--bg-input)" : "transparent", borderTop: `2px solid ${active ? "#7ff0c5" : "transparent"}`, color: active ? "var(--fg)" : "var(--fg-muted)" }}>
                      <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>📄 {t.rel.split(/[\\/]/).pop()}{tdirty ? " •" : ""}</span>
                      <span onClick={(e) => { e.stopPropagation(); closeViewer(t.abs); }} title="Close tab"
                        style={{ fontSize: 12, lineHeight: 1, padding: "1px 4px", borderRadius: 4, color: "var(--fg-muted)" }}>✕</span>
                    </div>
                  );
                })}
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={viewer.abs}>📄 {viewer.rel}{dirty ? " •" : ""}</span>
              {/* ✎ Edit turns the file editable; once modified it becomes 💾 Save. */}
              {!viewer.editing ? (
                canEdit && <button onClick={startEdit} title="Edit this file" style={{ ...btn, height: 30, padding: "0 10px" }}>✎ Edit</button>
              ) : (
                <>
                  <button onClick={saveFile} disabled={!dirty || viewer.saving}
                    title={dirty ? "Save changes to disk" : "Make a change to enable saving"}
                    style={{ ...btn, height: 30, padding: "0 12px", fontWeight: 700,
                      borderColor: dirty ? "#7ff0c5" : "var(--border)", color: dirty ? "#7ff0c5" : "var(--fg-muted)",
                      opacity: dirty && !viewer.saving ? 1 : 0.6, cursor: dirty && !viewer.saving ? "pointer" : "default" }}>
                    {viewer.saving ? "Saving…" : dirty ? "💾 Save" : "✎ Editing…"}
                  </button>
                  <button onClick={cancelEdit} title="Discard changes and stop editing" style={{ ...btn, height: 30, padding: "0 10px" }}>Cancel</button>
                </>
              )}
              <button onClick={() => referenceInChat(viewer.rel)} title="Insert @reference into the composer so the model edits this file" style={{ ...btn, height: 30, padding: "0 10px" }}>↳ Reference in chat</button>
              <button onClick={() => closeViewer()} style={{ ...btn, height: 30, padding: "0 12px" }}>✕ Close</button>
            </div>
            {viewer.saveError && (
              <div style={{ padding: "8px 14px", fontSize: 12, color: "#ff8c8c", borderBottom: "1px solid var(--border)", background: "rgba(255,140,140,0.08)" }}>⚠ Couldn't save: {viewer.saveError}</div>
            )}
            <div style={{ flex: 1, minHeight: 0, overflow: "auto", background: "var(--bg-input)" }}>
              {viewer.loading ? (
                <div style={{ padding: 20, color: "var(--fg-muted)", fontSize: 13 }}>Loading…</div>
              ) : viewer.editing ? (
                <textarea value={viewer.draft} spellCheck={false}
                  onChange={(e) => { const val = e.target.value; if (viewer) patchTab(viewer.abs, { draft: val }); }}
                  style={{ display: "block", width: "100%", minHeight: "60vh", boxSizing: "border-box", margin: 0, padding: 14, border: "none", outline: "none", resize: "none", background: "var(--bg-input)", fontSize: 12.5, lineHeight: 1.5, fontFamily: "Consolas, 'JetBrains Mono', monospace", color: "var(--fg)", whiteSpace: "pre", overflowWrap: "normal" }} />
              ) : (
                <pre style={{ margin: 0, padding: 14, fontSize: 12.5, lineHeight: 1.5, fontFamily: "Consolas, 'JetBrains Mono', monospace", color: "var(--fg)", whiteSpace: "pre", overflowX: "auto" }}>{viewer.content}</pre>
              )}
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}

// ---- The Code page = a tab strip of independent CodeWorkspace pages ----------
// Each tab is its OWN page: separate conversation, model, and (for a git repo) a
// separate worktree on its own branch — so you can drive two lines of change on
// the same project at once without them colliding. Only the active page renders
// (keyed by id) so each page's state stays isolated; switching tabs preserves
// every page via chatRuntime + per-page localStorage.
export default function CodePage() {
  const [pages, setPages] = useState<CodePageMeta[]>(() => {
    const p = loadPages();
    return p.length ? p : [{ id: "main", title: "New page" }];
  });
  const [activeId, setActiveId] = useState<string>(() => {
    try { return localStorage.getItem(ACTIVE_PAGE_KEY) || ""; } catch { return ""; }
  });
  const active = pages.find((p) => p.id === activeId) ?? pages[0];
  useEffect(() => { savePages(pages); }, [pages]);
  useEffect(() => { try { if (active) localStorage.setItem(ACTIVE_PAGE_KEY, active.id); } catch { /* best effort */ } }, [active]);

  const setTitle = (id: string, title: string) =>
    setPages((ps) => ps.map((p) => (p.id === id ? (p.title === title ? p : { ...p, title }) : p)));

  const newPage = () => {
    // "New page" on the SAME project: seed the new page with the active page's
    // project so it spins up ANOTHER isolated worktree of it (a parallel
    // workspace) instead of a blank picker. No current project → a blank page.
    const cur = active ? (chatRuntime.getSnapshot(sidForPage(active.id)).payload as CodeState | null) : null;
    const seed = cur?.projectRoot || undefined;
    const id = newPageId();
    setPages((ps) => [...ps, { id, title: seed ? seed.replace(/^.*[\\/]/, "") : "New page", seedProject: seed }]);
    setActiveId(id);
  };

  const closePage = async (id: string) => {
    // Clean up the page's worktree (discards uncommitted work — Merge first to
    // keep it). Prefer the LIVE in-memory session (a just-created worktree may
    // not have hit the debounced localStorage yet); fall back to disk.
    const live = chatRuntime.getSnapshot(sidForPage(id)).payload as CodeState | null;
    const st = live ?? loadPageSession(id);
    if (st?.isolated && st.workspace && st.projectRoot) {
      try {
        const { confirm } = await import("@tauri-apps/plugin-dialog");
        const ok = await confirm(
          `Close this page? Its private worktree (${st.branch}) and any unmerged changes are removed. Merge first to keep them.`,
          { title: "Close page", kind: "warning" },
        );
        if (!ok) return;
      } catch { /* dialog unavailable — proceed */ }
      // Remove the worktree in the BACKGROUND — deleting a large checkout is slow,
      // and (like opening) the user shouldn't wait for cleanup. Fire-and-forget so
      // the tab vanishes instantly.
      void invoke("fleet_worktree_remove", {
        args: { projectCwd: st.projectRoot, worktreePath: st.workspace, branch: st.branch ?? "", keep: false },
      }).catch(() => { /* best-effort */ });
    }
    dropPageSession(id);
    setPages((ps) => {
      const next = ps.filter((p) => p.id !== id);
      if (next.length === 0) {
        const nid = newPageId();
        setActiveId(nid);
        return [{ id: nid, title: "New page" }];
      }
      if (id === activeId) setActiveId(next[next.length - 1].id);
      return next;
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg-panel)" }}>
      {/* Tab strip */}
      <div style={{ display: "flex", alignItems: "center", gap: 2, padding: "5px 6px 0", flexShrink: 0, overflowX: "auto" }}>
        {pages.map((p) => {
          const on = p.id === active?.id;
          return (
            <div
              key={p.id}
              onClick={() => setActiveId(p.id)}
              title={p.title}
              style={{
                display: "flex", alignItems: "center", gap: 6, padding: "5px 10px",
                borderRadius: "7px 7px 0 0", cursor: "pointer", maxWidth: 200, flexShrink: 0,
                background: on ? "var(--bg-input)" : "transparent",
                border: "1px solid", borderColor: on ? "var(--border-strong)" : "transparent", borderBottom: "none",
                color: on ? "var(--fg-strong)" : "var(--fg-muted)", fontSize: 12, fontWeight: on ? 700 : 500,
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title || "New page"}</span>
              <span
                onClick={(e) => { e.stopPropagation(); void closePage(p.id); }}
                title="Close this page (its worktree is removed)"
                style={{ opacity: 0.55, fontSize: 14, lineHeight: 1, padding: "0 2px" }}
              >×</span>
            </div>
          );
        })}
        <button onClick={newPage} title="Open another page on its own branch (a private worktree of the same project)" style={{ ...btn, height: 26, padding: "0 10px", marginLeft: 4 }}>＋ New page</button>
      </div>
      {/* Active page — keyed so each page is an isolated component instance. */}
      <div style={{ flex: 1, minHeight: 0 }}>
        {active && (
          <CodeWorkspace
            key={active.id}
            pageId={active.id}
            seedProject={active.seedProject}
            onTitle={(t) => setTitle(active.id, t)}
          />
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
  // A failed listing must SAY so — a silent empty tree is indistinguishable
  // from an empty folder, which is exactly how a dead worktree went unnoticed.
  const [err, setErr] = useState<string | null>(null);
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
        .catch((e) => { setErr(String(e)); setEntries([]); });
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
      {open && err && (
        <div style={{ ...rowStyle, paddingLeft: 4 + (depth + 1) * 12, color: "var(--danger, #ff7a7a)", whiteSpace: "normal" }} title={err}>
          ⚠ can’t read this folder — {err}
        </div>
      )}
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
