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
import { ChatBubble, ToolEventCard } from "../../components/ChatBubble";
import GitBar from "./GitBar";
import ModelPicker, { type AccountsStatusLite } from "./ModelPicker";
import { getServerCtx } from "../core/serverContext";
import { chatRuntime } from "../../runtime/chatRuntime";
import { useChatSession } from "../../runtime/useChatSession";
import { useStickyScroll } from "../../hooks/useStickyScroll";
import { streamLocalChat, streamChatCompletion, providerFor, openaiUserContent, imageAttachments, fileToImageAttachment, type Attachment, type ModelInfo, type ServerStatus, type HistoryItem } from "./dispatch";
import type { ToolCall, ToolExecResult } from "./localTools";
import {
  wslStatus, wslIsolationGet, wslIsolationSet, wslCreateProject, wslListProjects,
  wslToolchainStatus, wslProvision, wslInstall, toolchainReady,
  isWslPath, type WslStatus, type WslIsolation, type WslProject, type WslToolchain,
} from "./wslIsolation";
import { isolationBadge } from "./isolationBadge";
import { githubStatus, githubConnect, githubDisconnect, GITHUB_TOKEN_URL, type GithubStatus } from "./github";
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
};
const DEFAULT_CODE_STATE: CodeState = {
  messages: [], tasks: [], workspace: "", modelId: "", draft: "", busy: false,
  status: "Pick a folder and a local model, then describe what to build or fix.",
};

// Worktree command outcomes — serde-tagged "status", camelCase. Mirror of the
// Rust enums in fleet.rs (fleet_worktree_create / _merge / _finalize), reused
// AS-IS for the Code page (zero new Rust commands).
type WtCreate =
  | { status: "ready"; path: string; branch: string; baseSha: string }
  | { status: "notAGitRepo" }
  | { status: "dirtyWorkingTree"; details: string }
  | { status: "error"; message: string };
type WtMerge =
  | { status: "merged"; commitSha: string; filesChanged: number }
  | { status: "conflict"; files: string[] }
  | { status: "noChanges" }
  | { status: "error"; message: string };
type WtFinalize =
  | { status: "committed"; commitSha: string; filesChanged: number; files: string[] }
  | { status: "noChanges" }
  | { status: "error"; message: string };

// ---- Multi-page shell state (the tab strip) --------------------------------
type CodePageMeta = { id: string; title: string };
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
function loadPageSession(pageId: string): CodeState | null {
  try {
    const raw = localStorage.getItem(pageSessionKey(pageId));
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<CodeState>;
    return { ...DEFAULT_CODE_STATE, ...s, busy: false };
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
    return { ...DEFAULT_CODE_STATE, ...s, workspace: ws, busy: false };
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

function CodeWorkspace({ pageId, onTitle }: {
  pageId: string;
  /// Report this page's display title (folder name) to the shell so the tab
  /// label stays in sync.
  onTitle: (title: string) => void;
}) {
  const SID = sidForPage(pageId);
  // The model LIST is re-fetched on mount, so it stays plain component state.
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [accountsStatus, setAccountsStatus] = useState<AccountsStatusLite | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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
  const { messages, tasks, workspace, modelId, draft, busy, status, projectRoot, branch, isolated } = stx;
  const [mergeBusy, setMergeBusy] = useState(false);
  // Keep the shell's tab label in sync with this page's project.
  useEffect(() => {
    const label = projectRoot ? projectRoot.replace(/^.*[\\/]/, "")
      : workspace ? workspace.replace(/^.*[\\/]/, "")
      : "New page";
    onTitle(label);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot, workspace]);
  function setField<K extends keyof CodeState>(k: K, v: CodeState[K] | ((p: CodeState[K]) => CodeState[K])) {
    chatRuntime.setPayload(SID, (prev) => {
      const cur = (prev as CodeState) ?? DEFAULT_CODE_STATE;
      const nv = typeof v === "function" ? (v as (p: CodeState[K]) => CodeState[K])(cur[k]) : v;
      return { ...cur, [k]: nv };
    });
  }
  const setMessages = (v: Msg[] | ((m: Msg[]) => Msg[])) => setField("messages", v);
  const setTasks = (v: Task[] | ((t: Task[]) => Task[])) => setField("tasks", v);
  const setWorkspace = (v: string) => setField("workspace", v);
  const setModelId = (v: string | ((s: string) => string)) => setField("modelId", v);
  const setDraft = (v: string | ((s: string) => string)) => setField("draft", v);
  const setBusy = (v: boolean) => setField("busy", v);
  const setStatus = (v: string) => setField("status", v);

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
    // Switching THIS page to a different project: drop the old worktree first so
    // we don't leak it. (Unmerged work is the user's to merge before switching.)
    if (stx.isolated && stx.workspace && stx.projectRoot && stx.workspace !== dir) {
      await removeWorktree(stx);
    }
    setStatus(`Creating an isolated worktree for ${dir.replace(/^.*[\\/]/, "")}…`);
    let outcome: WtCreate;
    try {
      outcome = await invoke<WtCreate>("fleet_worktree_create", {
        projectCwd: dir, agentName: "code", runId: pageId,
      });
    } catch (e: any) {
      outcome = { status: "error", message: String(e?.message ?? e) };
    }
    if (outcome.status === "ready") {
      chatRuntime.setPayload(SID, () => ({
        ...DEFAULT_CODE_STATE, workspace: outcome.path, modelId,
        projectRoot: dir, branch: outcome.branch, baseSha: outcome.baseSha, isolated: true,
        status: `Isolated on ${outcome.branch} — edits stay in this page until you Merge to ${dir.replace(/^.*[\\/]/, "")}.`,
      }));
      setRecents(rememberCodeProject(dir));
    } else if (outcome.status === "notAGitRepo") {
      chatRuntime.setPayload(SID, () => ({
        ...DEFAULT_CODE_STATE, workspace: dir, modelId, isolated: false,
        status: `Not a git repo — editing this folder directly (no isolation). Run "git init" in it to enable per-page worktrees.`,
      }));
      setRecents(rememberCodeProject(dir));
    } else if (outcome.status === "dirtyWorkingTree") {
      setStatus(`"${dir.replace(/^.*[\\/]/, "")}" has uncommitted changes — commit or stash them first, then reopen so the worktree includes them.\n${outcome.details.split("\n").slice(0, 3).join("\n")}`);
    } else {
      setStatus(`Couldn't create the worktree: ${outcome.message}`);
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

  // Merge to main: commit whatever's pending in the worktree, then squash-merge
  // the page's branch back into the REAL project. This is the only moment the
  // user's actual folder changes. Conflicts abort cleanly (nothing touched).
  const mergeToMain = async () => {
    if (!stx.isolated || !stx.projectRoot || !stx.branch || mergeBusy || busy) return;
    setMergeBusy(true);
    try {
      const fin = await invoke<WtFinalize>("fleet_worktree_finalize", {
        worktreePath: stx.workspace, agentName: "code", summary: "Code page session",
      });
      if (fin.status === "error") { setStatus(`Merge aborted — commit failed: ${fin.message}`); return; }
      const mg = await invoke<WtMerge>("fleet_worktree_merge", {
        projectCwd: stx.projectRoot, agentName: "code", branch: stx.branch,
      });
      const root = stx.projectRoot.replace(/^.*[\\/]/, "");
      if (mg.status === "merged") setStatus(`✓ Merged ${mg.filesChanged} file(s) into ${root} (commit ${mg.commitSha.slice(0, 7)}). Keep working — Merge again anytime.`);
      else if (mg.status === "noChanges") setStatus(`Nothing new to merge — ${root} is already up to date with this page.`);
      else if (mg.status === "conflict") setStatus(`⚠ Merge conflict in: ${mg.files.join(", ")}. Your project was NOT changed. Resolve on branch ${stx.branch} in your git tool, or adjust this page and retry.`);
      else setStatus(`Merge failed: ${mg.message}`);
    } catch (e: any) {
      setStatus(`Merge failed: ${String(e?.message ?? e)}`);
    } finally {
      setMergeBusy(false);
    }
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
      await removeWorktree(stx);
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
  useEffect(() => {
    let dead = false;
    (async () => {
      const [st, iso0] = await Promise.all([wslStatus(), wslIsolationGet()]);
      if (dead) return;
      // Probe the sandbox, retrying while it reports "not available" — the first
      // wsl.exe call after boot can transiently miss the distro while the WSL
      // service warms up. `sbox` stays null (UI shows "Checking…") until a
      // definitive answer, so we never flash the "not installed" warning.
      let s = await sandboxStatus();
      for (let i = 0; i < 3 && !s.available && !dead; i++) {
        await new Promise((r) => setTimeout(r, 800));
        s = await sandboxStatus();
      }
      if (dead) return;
      // If a sandbox engine is present, isolation is ON by default — every new
      // project is isolated automatically (the user can still opt out per
      // project in the New-project dialog).
      let iso = iso0;
      if (s.available && !iso0.enabled) {
        try { iso = await wslIsolationSet(true, s.defaultTarget ?? null); } catch { iso = iso0; }
        if (dead) return;
      }
      setWslStat(st);
      setIsolation(iso);
      setSbox(s);
      refreshWslProjects(iso, st);
      refreshToolchain(st);
      refreshSboxProjects(iso, s);
    })();
    return () => { dead = true; };
  }, []);

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
  useEffect(() => {
    let dead = false;
    githubStatus().then((s) => { if (!dead) setGh(s); });
    return () => { dead = true; };
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

  const openNewProject = () => {
    setNpName("");
    setNpFolder("");
    setNpIsolate(!!sbox?.available); // default isolated whenever an engine exists
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
      if (npIsolate && sbox?.available) {
        const p = await sandboxCreateProject(npName.trim() || "project");
        setNpOpen(false);
        openWorkspace(p.path);
      } else if (npFolder.trim()) {
        setNpOpen(false);
        openWorkspace(npFolder.trim());
      } else {
        setNpBusy(false);
        return;
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

  // One agent turn against the SELECTED model. Routes by provider exactly like
  // ChatPage/AgentsPage: local/tuned → streamLocalChat (renders tool cards);
  // cloud/subscription → the shared streamChatCompletion. `silent` suppresses
  // streaming for the planning turn.
  const runTurn = async (
    system: string,
    user: string,
    history: HistoryItem[],
    signal: AbortSignal,
    opts?: { silent?: boolean; withEvents?: boolean },
  ): Promise<string> => {
    const provider = providerFor(modelId, availableModels);
    const isLocal = provider === "local" || provider === "tuned";
    const dDelta = opts?.silent ? () => {} : onDelta;
    const dThought = opts?.silent ? () => {} : onThought;
    if (isLocal) {
      const port = await ensureServer(modelId);
      if (!port) throw new Error("Local engine didn't come up — check the Server tab / install Local Inference.");
      return streamLocalChat({
        port, modelId, systemPrompt: system, userContent: user, temperature: 0.3,
        signal, onDelta: dDelta, onThought: dThought, projectCwd: workspace,
        history, events: opts?.withEvents ? { onToolCall, onToolResult } : undefined,
      });
    }
    return streamChatCompletion(0, modelId, provider, system, user, 0.3, signal, dDelta, workspace, history, true, dThought);
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    if (!workspace) { setStatus("Pick a workspace folder first (Browse)."); return; }
    if (!modelId) { setStatus("No model selected — pick one above."); return; }
    setDraft("");
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const history: HistoryItem[] = messages
      .filter((m) => m.role === "user" || (m.role === "assistant" && !m.kind && m.content.trim()))
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    setMessages((msgs) => [...msgs, { role: "user", content: text, ts: Date.now() }]);
    try {
      setStatus(`Coding in ${workspace}`);
      await runTurn(CODING_SYSTEM(workspace), text, history, ctrl.signal, { withEvents: true });
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
      if (provider === "local" || provider === "tuned") {
        const port = await ensureServer(modelId);
        if (!port) throw new Error("Local engine didn't come up — check the Server tab / install Local Inference.");
        await streamLocalChat({ port, modelId, systemPrompt: "You are a helpful, concise assistant.", userContent: openaiUserContent(text, images), temperature: 0.4, signal: ctrl.signal, onDelta: onD, onThought: () => {}, history });
      } else {
        // Pass a working dir so pasted images can be saved into it for the model
        // to read (codex -i / claude file-ref). Use the workspace if one is
        // selected, else the WSL scratch — without ANY cwd the image is dropped
        // ("I can't inspect the image"), which is the bug on a no-folder chat.
        const chatCwd = workspace || chatScratchRef.current || undefined;
        await streamChatCompletion(0, modelId, provider, "You are a helpful, concise assistant.", text, 0.4, ctrl.signal, onD, chatCwd, history, false, () => {}, undefined, images);
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
    if (!workspace) { setStatus("Pick a workspace folder first (Browse)."); return; }
    if (!modelId) { setStatus("No local model available — load one on the Models page."); return; }
    setDraft("");
    setBusy(true);
    setTasks([]);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setMessages((m) => [...m, { role: "user", content: `📋 Plan & build: ${goal}`, ts: Date.now() }]);
    try {
      // 1) PLAN — ordered step list (silent; no tool execution / streaming).
      setStatus("Planning…");
      const planReply = await runTurn(PLAN_SYSTEM(workspace, goal), "Return the JSON array of steps now.", [], ctrl.signal, { silent: true });
      const steps = parseSteps(planReply);
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
      setBusy(false);
      abortRef.current = null;
    }
  };

  const stop = () => { abortRef.current?.abort(); setBusy(false); };
  const clear = () => { if (!busy) { setMessages([]); setTasks([]); setStatus(`Workspace: ${workspace || "(none)"}`); } };

  // Clicking a file in the tree drops an @-reference into the composer so the
  // user can point the agent at it ("fix the bug in @src/foo.ts").
  const openFile = (abs: string) => {
    const rel = workspace && abs.startsWith(workspace) ? abs.slice(workspace.length).replace(/^[\\/]+/, "") : abs;
    setDraft((d) => (d.trim() ? `${d.replace(/\s*$/, "")} @${rel} ` : `@${rel} `));
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
        <div ref={chatSticky.ref} onScroll={chatSticky.onScroll} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
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
              <button onClick={() => abortRef.current?.abort()} style={{ ...btn, height: 38, padding: "0 14px", color: "#ff8c8c" }}>Stop</button>
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
  if (!workspace) {
    return (
      <div style={{ padding: "8px 10px 10px", height: "100%", display: "flex", flexDirection: "column", background: "var(--bg-panel)", color: "var(--fg)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 16 }}>🦉</span>
          <span style={{ fontWeight: 700, fontSize: 14, color: "var(--fg-strong)" }}>Code</span>
        </div>
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
                    <div style={{ fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.5 }}>Lets the agent clone private repos and push from inside the sandbox.</div>
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
        <span style={{ fontSize: 16 }}>🦉</span>
        <span style={{ fontWeight: 700, fontSize: 14, color: "var(--fg-strong)" }}>Code</span>
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
        <GitBar workspace={workspace} busy={busy} />
        {isolated && (
          <>
            <span
              title={`Isolated git worktree branch, cut from ${projectRoot}. Your real folder is untouched until you Merge.`}
              style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 6, whiteSpace: "nowrap", background: "rgba(127,240,197,0.12)", color: "#7ff0c5", border: "1px solid rgba(127,240,197,0.35)" }}
            >
              ⎇ {branch ? branch.replace(/^owllm-fleet\//, "") : "isolated"}
            </span>
            <button
              onClick={mergeToMain}
              disabled={mergeBusy || busy}
              title={`Commit this page's work and squash-merge it into ${projectRoot}. Your real folder changes ONLY when you click this.`}
              style={{ ...btn, height: 26, padding: "0 8px", fontSize: 11, whiteSpace: "nowrap", color: "#7ff0c5", fontWeight: 700, opacity: mergeBusy ? 0.6 : 1 }}
            >
              {mergeBusy ? "⏳ Merging…" : `⤴ Merge to ${projectRoot ? projectRoot.replace(/^.*[\\/]/, "") : "main"}`}
            </button>
          </>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>Model</span>
        <div style={{ minWidth: 260, maxWidth: 360 }}>
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
        <button onClick={clear} disabled={busy || (messages.length === 0 && tasks.length === 0)} style={btn}>Clear</button>
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

      {/* Body: file-tree rail + transcript */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 8 }}>
        {workspace && (
          <div style={{ width: 220, flexShrink: 0, overflowY: "auto", overflowX: "hidden", background: "var(--bg-input)", border: "1px solid var(--border-strong)", borderRadius: 8, padding: 4 }}>
            <TreeDir path={workspace} name={wsShort} depth={0} defaultOpen onOpenFile={openFile} />
          </div>
        )}
      <div
        ref={transcriptSticky.ref}
        onScroll={transcriptSticky.onScroll}
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

      {/* Status line — expands to multiple lines for the per-credential
          sync report (P1-2); stays a single ellipsized line otherwise. */}
      <div style={status.includes("\n")
        ? { fontSize: 11, color: "var(--fg-muted)", whiteSpace: "pre-line", lineHeight: 1.6 }
        : { fontSize: 11, color: "var(--fg-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{status}</div>

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
          <>
            <button onClick={planAndExecute} disabled={!draft.trim()} title="Break the goal into ordered steps, then build them one by one (Kanban)" style={{ ...btn, height: 44, padding: "0 14px", opacity: draft.trim() ? 1 : 0.5 }}>📋 Plan</button>
            <button onClick={send} disabled={!draft.trim()} style={{ ...btn, background: "var(--accent)", color: "#06080d", border: "none", height: 44, padding: "0 16px", fontWeight: 700, opacity: draft.trim() ? 1 : 0.5 }}>Send</button>
          </>
        )}
      </div>
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
    const id = newPageId();
    setPages((ps) => [...ps, { id, title: "New page" }]);
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
          `Close this page? Its isolated worktree (${st.branch}) and any unmerged changes are removed. Merge to main first to keep them.`,
          { title: "Close page", kind: "warning" },
        );
        if (!ok) return;
      } catch { /* dialog unavailable — proceed */ }
      try {
        await invoke("fleet_worktree_remove", {
          args: { projectCwd: st.projectRoot, worktreePath: st.workspace, branch: st.branch ?? "", keep: false },
        });
      } catch { /* best-effort */ }
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
        <button onClick={newPage} title="Open another page on its own isolated worktree" style={{ ...btn, height: 26, padding: "0 10px", marginLeft: 4 }}>＋ New page</button>
      </div>
      {/* Active page — keyed so each page is an isolated component instance. */}
      <div style={{ flex: 1, minHeight: 0 }}>
        {active && (
          <CodeWorkspace
            key={active.id}
            pageId={active.id}
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
