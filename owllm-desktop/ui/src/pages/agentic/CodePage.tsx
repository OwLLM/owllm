// CodePage — OWLLM-native coding agent.
//
// Rebuilt 2026-06-06 from a mock VSCodium/Cline launcher into a REAL
// coding agent on OWLLM's own engine. No bundled IDE, no Cline embed —
// it drives the shared `streamLocalChat` loop (native GGUF tool-calling)
// against the user's chosen workspace, so the local model can read,
// search, edit and create files and run shell commands in that folder.
// Cline's card-based UX is inspiration for later phases (file tree, live
// diffs, task Kanban); Phase 1 is the working agent core.
import { useEffect, useRef, useState, type CSSProperties, type ClipboardEvent, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChatBubble, ToolEventCard } from "../../components/ChatBubble";
import PublishCards from "./PublishCards";
import ModelPicker, { type AccountsStatusLite } from "./ModelPicker";
import { getSetting, setSetting, scope, SettingKey } from "../../state/pageSettings";
import { getServerCtx } from "../core/serverContext";
import { chatRuntime } from "../../runtime/chatRuntime";
import { setRunActivity } from "../../runtime/runActivity";
import { continuousUiAnimation } from "../../runtime/renderingPolicy";
import { useChatSession } from "../../runtime/useChatSession";
import { useStickyScroll } from "../../hooks/useStickyScroll";
import { streamLocalChat, streamChatCompletion, providerFor, openaiUserContent, imageAttachments, fileToChatAttachment, appendDocumentAttachmentText, CHAT_ATTACHMENT_ACCEPT, formatDirectivesBlock, CliPreflightError, type Directive, type Attachment, type ModelInfo, type ServerStatus, type HistoryItem } from "./dispatch";
import { WorktreePreflightError } from "./worktreeIsolation";
import type { ToolCall, ToolExecResult } from "./localTools";
import { getBrowserStateLine, refreshBrowserState, retrieveScopedTeamMemoryPack, logScopedTeamWork, setTeamMemoryScope, setTeamMemoryGoal, refreshTeamMemorySnapshot, harvestMemoryWrites, stripMemoryDirectives, type TeamMemoryPack } from "./localTools";
import { enrichInstructionWithMemory } from "./teamMemoryFormat";
import CodeSidePanel, { type CodeAgentMode } from "./CodeSidePanel";
import RunNotebook, { continueNotebookAutoFeed, autoFeedWouldRun, consumeAutoFeedArm, notebookPendingStepCount, settleNotebookStep, type NotebookRunOutcome } from "./RunNotebook";
import { RunTimerChip, runTimingFooter } from "./RunTimer";
import { translateUiText } from "../../localization";
import { projectAvailability, projectOriginLabel } from "./projectPortability";
import { chooseProjectOpenTarget, savedPageIdsForLocalProject } from "./codeProjectPages";
import { openWebUrl } from "../../utils/openWebUrl";
import PtyTerminal from "../advanced/PtyTerminal";
import BrowserPanel from "./BrowserPanel";
import TeamMemoryModal, { fmtAgo } from "./TeamMemoryModal";
import {
  wslStatus, wslIsolationGet, wslIsolationSet, wslCreateProject, wslListProjects,
  wslToolchainStatus, wslProvision, wslInstall, toolchainReady,
  isWslPath, type WslStatus, type WslIsolation, type WslProject, type WslToolchain,
} from "./wslIsolation";
import { isolationBadge } from "./isolationBadge";
import { githubStatus, githubConnect, githubDisconnect, githubListRepositories, GITHUB_TOKEN_URL, GITHUB_CHANGED_EVENT, type GithubRepository, type GithubStatus } from "./github";
import { openSyncOnboarding } from "../core/AccountSyncModal";
import {
  sandboxSyncLogins, sandboxStatus, sandboxCreateProject, sandboxListProjects,
  sandboxProvision, sandboxLoginStatus, sandboxConvertProject,
  engineLabel, mirrorReportLines, type SandboxStatus, type SandboxProject,
} from "./isolation";

type Msg = {
  role: "user" | "assistant" | "tool";
  content: string;
  /// Model-facing content can differ from the visible bubble (for example,
  /// document text is kept here while the bubble shows attachment names).
  context?: string;
  thinking?: string;
  /// "meta" = page-generated notice (run timing footer, auto-feed pause note):
  /// rendered as a muted line, never sent to the model as history, and never
  /// treated as the agent's answer (no Forward button).
  kind?: "tool" | "terminal" | "meta";
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
  /// Attached images shown as clickable thumbnails in the bubble (user uploads
  /// or results), stored so they persist and can be re-viewed by clicking.
  images?: { src: string; alt?: string }[];
};

// Turn chat image attachments into ChatBubble thumbnails (data URIs the webview
// can always render), so uploaded images stay visible and clickable in history.
function attachmentThumbs(atts: { mime: string; data_b64: string; filename?: string }[]): { src: string; alt?: string }[] {
  return atts.map((a) => ({ src: `data:${a.mime};base64,${a.data_b64}`, alt: a.filename }));
}

// JSON replacer that drops `images` (base64 data URIs) when persisting to
// localStorage — thumbnails are for in-session re-view only; embedding megabytes
// of base64 would blow the localStorage quota and silently lose the session.
const dropImages = (k: string, v: unknown) => (k === "images" ? undefined : v);

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
  /// Portable project identity + origin label. The absolute workspace remains
  /// local to this device and is denied from vault sync.
  projectId?: string;
  repoUrl?: string;
  createdDeviceId?: string;
  createdDeviceName?: string;
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
  // True while this page shows the "Just chat" (no project) view — persisted so
  // navigating away and back returns to the conversation, not the Start screen.
  chatMode?: boolean;
  // Optional per-page label (the header rename box). Shown in the tab title as
  // "folder(rename)" — e.g. LocaLLM(GUI_fix) — so two pages open on the SAME
  // project stay tellable apart. Empty = the tab shows the folder name only.
  pageRename?: string;
};
const DEFAULT_CODE_STATE: CodeState = {
  messages: [], tasks: [], workspace: "", modelId: "", draft: "", busy: false,
  status: "Pick a folder and a local model, then describe what to build or fix.",
};
// Hydration migration: older sessions saved page notices (the run timing
// footer, the auto-feed pause note) as plain assistant answers, which let them
// own the Forward button and re-enter the model's history. Stamp them as meta.
function stampLegacyMetaNotices(s: CodeState | null): CodeState | null {
  if (!s) return s;
  const fix = (list?: Msg[]) => list?.map((m) =>
    m.role === "assistant" && !m.kind && (m.content.startsWith("⏱ ") || m.content.startsWith("📓 Auto-feed paused"))
      ? { ...m, kind: "meta" as const }
      : m);
  // Publisher results used to be persisted in the composer status. Clear the
  // exact stale sync-success message during hydration now that PublisherCards
  // owns it in the left Git container.
  const status = s.status === "✓ Up to date. Local and origin/main are already the same commit."
    ? (s.workspace ? `Coding in ${s.workspace}` : DEFAULT_CODE_STATE.status)
    : s.status;
  return { ...s, status, messages: fix(s.messages) ?? [], secondaryMessages: fix(s.secondaryMessages) };
}

// Worktree command outcomes — serde-tagged "status", camelCase. Mirror of the
// Rust enum for fleet_worktree_create, reused AS-IS for the Code page.
type WtCreate =
  | { status: "ready"; path: string; branch: string; baseSha: string }
  | { status: "notAGitRepo" }
  | { status: "dirtyWorkingTree"; details: string }
  | { status: "error"; message: string };

// ---- Multi-page shell state (the tab strip) --------------------------------
type CodePageMeta = { id: string; title: string };
type ProjectCatalogRow = {
  id: string; name: string; description: string; location: string;
  repo_url: string; created_device_id: string; created_device_name: string;
  team: string[]; trust_writes: boolean; auto_approve_all: boolean;
  team_default_model_id: string; graph_json: string; chat_json: string;
  agent_logs_json: string; updated_at: string;
};
type OpenProjectPagesDetail = {
  project: Pick<ProjectCatalogRow, "id" | "name" | "location">;
  currentPageIsBlank: boolean;
  handled: boolean;
};
const OPEN_PROJECT_PAGES_EVENT = "owllm:code:open-project-pages";
type ProjectScopeRow = { id: string; location: string; repo_url?: string };
const PAGES_KEY = "owllm:code:pages";
const ACTIVE_PAGE_KEY = "owllm:code:activePage";
const PAGE_SESSION_PREFIX = "owllm:code:page:";
function newPageId(): string { return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }

function hasRecoverablePageState(s: Partial<CodeState>): boolean {
  return Boolean(
    s.workspace
    || s.projectRoot
    || s.chatMode
    || s.pageRename
    || s.draft
    || (Array.isArray(s.messages) && s.messages.length > 0)
    || (Array.isArray(s.secondaryMessages) && s.secondaryMessages.length > 0)
    || (Array.isArray(s.tasks) && s.tasks.length > 0)
  );
}

function recoveredPageTitle(s: Partial<CodeState>): string {
  const parts = (s.projectRoot || s.workspace || "").split(/[\\/]/).filter(Boolean);
  // An isolated worktree ends in <project>/<page>/code. Older records may not
  // carry projectRoot, so recover the project name from that stable layout.
  const folder = s.projectRoot
    ? parts[parts.length - 1]
    : parts[parts.length - 1] === "code" && parts.length >= 3
      ? parts[parts.length - 3]
      : parts[parts.length - 1];
  const rename = (s.pageRename || "").trim();
  return folder ? (rename ? `${folder}(${rename})` : folder) : rename || "Recovered page";
}

function loadPages(): CodePageMeta[] {
  let pages: CodePageMeta[] = [];
  try {
    const a = JSON.parse(localStorage.getItem(PAGES_KEY) || "[]");
    pages = Array.isArray(a) ? a.filter((p) => p && typeof p.id === "string") : [];
  } catch { /* rebuild from the per-page records below */ }

  // The catalog and the sessions are separate localStorage writes. A crash,
  // profile migration or old narrow state mirror can therefore leave complete
  // sessions orphaned behind an empty/partial catalog. Reconstruct missing tabs
  // from every substantive per-page record before React gets a chance to save a
  // default one-page catalog over the evidence.
  try {
    const known = new Set(pages.map((p) => p.id));
    const recovered: CodePageMeta[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(PAGE_SESSION_PREFIX)) continue;
      const id = key.slice(PAGE_SESSION_PREFIX.length);
      if (!id || known.has(id)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const state = JSON.parse(raw) as Partial<CodeState>;
      if (!hasRecoverablePageState(state)) continue;
      known.add(id);
      recovered.push({ id, title: recoveredPageTitle(state) });
    }
    recovered.sort((a, b) => a.id.localeCompare(b.id));
    pages = [...pages, ...recovered];
  } catch { /* one malformed record must not block the Code page */ }
  return pages;
}
function savePages(pages: CodePageMeta[]): void {
  try { localStorage.setItem(PAGES_KEY, JSON.stringify(pages)); } catch { /* best effort */ }
}

// Project rows and Coding tabs are persisted separately. Opening a project
// should restore every saved page that belongs to this device's checkout, not
// replace the current page with a blank worktree. Exact local-path matching is
// intentional: a repo URL/project id may refer to a different PC's checkout,
// whose absolute paths must never become runnable here.
function savedPageMetasForLocalProject(project: Pick<ProjectCatalogRow, "location">): CodePageMeta[] {
  const catalog = new Map(loadPages().map((page) => [page.id, page]));
  return savedPageIdsForLocalProject(localStorage, project.location, PAGE_SESSION_PREFIX)
    .map((id) => {
      const known = catalog.get(id);
      if (known) return known;
      try {
        const state = JSON.parse(localStorage.getItem(pageSessionKey(id)) || "{}") as Partial<CodeState>;
        return { id, title: recoveredPageTitle(state) };
      } catch {
        return { id, title: "Recovered page" };
      }
    });
}

const PSYCHEDELIC_AURA_STOPS = "#3cf26b, #ffd93c, #ff9a3c, #ff5c8a, #b07cff, #7fd4ff, #3cf26b";
const PSYCHEDELIC_AURA_RING = `conic-gradient(from var(--owllm-aura-angle), ${PSYCHEDELIC_AURA_STOPS}) border-box`;
const PSYCHEDELIC_AURA_DOT = `conic-gradient(from 0deg, ${PSYCHEDELIC_AURA_STOPS})`;
// A solid colour followed by `padding-box` is not a valid multi-layer CSS
// background, so WebView dropped the rainbow layer and showed only the pale
// shadow. Wrap the colour in a gradient, matching AgentChatTile's valid shape.
const PSYCHEDELIC_AURA_FILL = "linear-gradient(var(--bg-input), var(--bg-input)) padding-box";
const PSYCHEDELIC_AURA_BACKGROUND = `${PSYCHEDELIC_AURA_FILL}, ${PSYCHEDELIC_AURA_RING}`;
// Colour-cycling spin only — the halo itself is a constant soft box-shadow
// (no breathe pulse), so the aura reads as a subtle shifting glow.
const PSYCHEDELIC_AURA_ANIMATION = continuousUiAnimation("owllm-aura-spin 4s linear infinite");
const PSYCHEDELIC_AURA_HALO = "0 0 12px rgba(176,124,255,.22), 0 0 20px rgba(127,212,255,.14)";

// ---- Cross-page activity signal (tab-strip glow + "done" badge) -------------
// Lets the tab strip show WHERE work is happening even when you've switched to
// another page. The primary coder's `busy` already lives per-page in
// chatRuntime and keeps updating after the page unmounts (module singleton), so
// a run started on page A stays visible while you work on page B — the parent
// reads it straight from chatRuntime. The MOUNTED page additionally reports its
// aggregate busy (coder OR second agent OR just-chat) here so the visible tab
// glows for ANY active agent; that extra signal is cleared on unmount (the
// second agent is aborted on unmount anyway, so it can't run in the background).
// `done` marks a page whose run FINISHED while you were on another tab — a badge
// that persists on its tab until you open it.
const pageBusyExtra = new Map<string, boolean>();
const pageDone = new Set<string>();
const activityListeners = new Set<() => void>();
function notifyActivity(): void { for (const cb of activityListeners) cb(); }
const pageActivity = {
  subscribe(cb: () => void): () => void {
    activityListeners.add(cb);
    return () => { activityListeners.delete(cb); };
  },
  reportExtra(pageId: string, busy: boolean): void {
    if ((pageBusyExtra.get(pageId) ?? false) === busy) return;
    if (busy) pageBusyExtra.set(pageId, true); else pageBusyExtra.delete(pageId);
    notifyActivity();
  },
  extraBusy(pageId: string): boolean { return pageBusyExtra.get(pageId) ?? false; },
  markDone(pageId: string): void { if (!pageDone.has(pageId)) { pageDone.add(pageId); notifyActivity(); } },
  clearDone(pageId: string): void { if (pageDone.delete(pageId)) notifyActivity(); },
  isDone(pageId: string): boolean { return pageDone.has(pageId); },
};
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
    const st = closeStaleTimer({ ...DEFAULT_CODE_STATE, ...s, busy: false });
    // The chosen model lives in the sync-ready settings layer (owllm:settings),
    // NOT only in this blob: this blob carries the machine-specific workspace
    // path and is denied from vault sync, so a model kept only here could never
    // follow the user to another PC. A synced value wins over the blob copy.
    const m = getSetting<string>(scope.page(pageId), SettingKey.model);
    if (m != null) st.modelId = m;
    const m2 = getSetting<string>(scope.page(pageId), SettingKey.secondaryModel);
    if (m2 != null) st.secondaryModelId = m2;
    return st;
  } catch { return null; }
}
function savePageSession(pageId: string, s: CodeState | null | undefined): void {
  if (!s) return;
  try { localStorage.setItem(pageSessionKey(pageId), JSON.stringify({ ...s, busy: false }, dropImages)); }
  catch { /* quota / unavailable */ }
  // Mirror the model choice into the sync-ready settings layer (see load).
  // setSetting treats ""/undefined as "clear", and no-op writes short-circuit,
  // so this neither persists an empty pick nor churns on unrelated state saves.
  setSetting(scope.page(pageId), SettingKey.model, s.modelId || undefined);
  setSetting(scope.page(pageId), SettingKey.secondaryModel, s.secondaryModelId || undefined);
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
type ChatMsg = { role: "user" | "assistant"; content: string; context?: string; thinking?: string; images?: { src: string; alt?: string }[] };
type ChatThread = {
  id: string; title: string; ts: number; messages: ChatMsg[];
  createdDeviceId?: string; createdDeviceName?: string;
};
const CHATS_KEY = "owllm:code:chats";
const CHATS_MAX = 60;
// The just-chat surface is GLOBAL (one thread list shared by every page). Its
// LIVE state (threads, active thread, draft, busy) lives in chatRuntime — not
// component useState — so a streaming reply keeps flowing and lands in history
// even when the user switches pages/tabs mid-stream, exactly like the project
// chats. Which VIEW a page shows (`chatMode`) stays per page in CodeState.
type JustChatState = { chats: ChatThread[]; chatId: string; draft: string; busy: boolean };
const CHAT_SID = "code:justchat";
const CHAT_ACTIVE_KEY = "owllm:code:chats:active";
const DEFAULT_JUSTCHAT: JustChatState = { chats: [], chatId: "", draft: "", busy: false };
// The in-flight stream's abort handle — module-level (like the session) so
// Stop still works after the component remounts mid-stream.
let justChatAbort: AbortController | null = null;
function loadChats(): ChatThread[] {
  try {
    const a = JSON.parse(localStorage.getItem(CHATS_KEY) || "[]");
    return Array.isArray(a) ? a.filter((c) => c && typeof c.id === "string" && Array.isArray(c.messages)) : [];
  } catch { return []; }
}
function saveChats(chats: ChatThread[]): void {
  try { localStorage.setItem(CHATS_KEY, JSON.stringify(chats.slice(0, CHATS_MAX), dropImages)); } catch { /* private mode / quota */ }
}
/// Bucket threads by recency for the conversation sidebar, newest first. A pure
/// read of the existing thread list — the sidebar is a second VIEW of
/// `owllm:code:chats`, never a second copy of it.
function groupChatsByDate(list: ChatThread[]): Array<{ label: string; items: ChatThread[] }> {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 86_400_000;
  const buckets = [
    { label: "Today", min: startOfToday },
    { label: "Yesterday", min: startOfToday - DAY },
    { label: "Previous 7 days", min: startOfToday - 7 * DAY },
    { label: "Previous 30 days", min: startOfToday - 30 * DAY },
    { label: "Older", min: -Infinity },
  ];
  const out = buckets.map((b) => ({ label: b.label, items: [] as ChatThread[] }));
  for (const c of [...list].sort((a, b) => (b.ts || 0) - (a.ts || 0))) {
    const i = buckets.findIndex((b) => (c.ts || 0) >= b.min);
    out[i < 0 ? out.length - 1 : i].items.push(c);
  }
  return out.filter((g) => g.items.length > 0);
}
const CHAT_SIDEBAR_KEY = "owllm:code:chat-sidebar";
/// Reading-column width for the chat transcript and composer. Full-bleed text
/// on a wide window is hard to read and left the empty state adrift in a void.
const CHAT_COLUMN_MAX = 760;
/// Opening prompts for an empty conversation. Deliberately about what THIS
/// surface can actually do (no folder, no tools beyond the model's own), so a
/// starter never promises something the no-project chat can't deliver.
const CHAT_STARTERS = [
  "Explain this error message",
  "Summarise the text I paste next",
  "Help me draft a message",
  "Talk me through an idea",
];
function newThreadId(): string { return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }
function threadTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t ? (t.length > 44 ? t.slice(0, 44) + "…" : t) : "New chat";
}
// 🧠 Each folderless conversation gets its OWN durable memory scope, so the
// everyday chat remembers across restarts exactly like a project does. It is
// the SAME store the project/team RAG uses (team_memory + team_memory_search) —
// only the scope string differs, so nothing about memory is reimplemented here.
// Without this a no-folder chat resolved to scope "" and every enrich/log call
// was a silent no-op: the chat could never remember anything.
function chatMemoryScope(threadId: string | null | undefined): string {
  const id = (threadId ?? "").trim();
  return id ? `chat:${id}` : "";
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
    return closeStaleTimer({
      ...DEFAULT_CODE_STATE,
      ...s,
      projectRoot: s.projectRoot || ws,
      busy: false,
    });
  } catch { return null; }
}

function saveCodeSession(s: CodeState | null | undefined): void {
  const root = (s?.projectRoot || s?.workspace || "").trim();
  if (!s || !root) return; // no folder → nothing to save (onboarding state)
  try {
    localStorage.setItem(codeSessionKey(root), JSON.stringify({ ...s, busy: false }, dropImages));
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
      const s = await sandboxStatus();
      // Sandbox present + isolation off → enable it once (every new project is
      // isolated by default; the user can still opt out per project).
      return { st, iso: iso0, s };
    })();
    _sandboxProbe.catch(() => { _sandboxProbe = null; });
  }
  return _sandboxProbe;
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
  const secondaryAbortRef = useRef<AbortController | null>(null);

  // ---- Right column: Super User (rules + notebook) — user spec 2026-07-04 ----
  // Rules/notebook scope: reuse the AGENTIC project's id when this folder is
  // also a team project (one shared rule set + notebook across both pages);
  // otherwise a stable per-folder key. directives_list auto-seeds the native
  // best-practice defaults on first use — the same "suggested" set the team gets.
  const [ruleScope, setRuleScope] = useState<{ id: string; shared: boolean }>({ id: "", shared: false });
  const ruleScopeRef = useRef(ruleScope);
  ruleScopeRef.current = ruleScope;
  // Last folder we resolved scope for — so a folder switch resets the notebook/
  // rules SYNCHRONOUSLY (see the scope effect) instead of leaving the previous
  // project's memory on screen while the async project lookup is in flight.
  const lastScopeFolderRef = useRef<string>("");
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
  const notebookStepRef = useRef<string | null>(null);
  const notebookSteerStepIdsRef = useRef<string[]>([]);
  const notebookSteerInFlightIdsRef = useRef<string[]>([]);
  const drainSteer = () => {
    const q = steerRef.current;
    // Guard BEFORE taking the ids: draining an empty text queue must not empty
    // the id list, or those cards would be silently detached from their text.
    if (!q.length) return "";
    const ids = notebookSteerStepIdsRef.current.splice(0, notebookSteerStepIdsRef.current.length);
    if (ids.length) notebookSteerInFlightIdsRef.current.push(...ids);
    return q.splice(0, q.length).join("\n\n");
  };
  const busySendRef = useRef(false);
  // Live port for the notebook's digest agent (refreshed when the notebook opens).
  const [srvPort, setSrvPort] = useState(0);

  // Plain "just chat" mode (no project) — opened from the Start screen's "New
  // chat" action. Reuses the same model picker + streaming as the coder, but
  // with no tools and no workspace. Threads live in the global chatRuntime
  // session (hydrated from / persisted to localStorage), so history survives
  // tab switches AND app restarts, and a mid-stream reply keeps going when the
  // user navigates away (the old useState version silently dropped it).
  const chatSess = useChatSession<JustChatState>(CHAT_SID);
  const chatHydratedRef = useRef(false);
  if (!chatHydratedRef.current) {
    chatHydratedRef.current = true;
    let activeThread = "";
    try { activeThread = localStorage.getItem(CHAT_ACTIVE_KEY) || ""; } catch { /* best effort */ }
    chatRuntime.hydrateIfIdle(CHAT_SID, { ...DEFAULT_JUSTCHAT, chats: loadChats(), chatId: activeThread });
    chatRuntime.registerPersister(CHAT_SID, (p) => {
      const jc = p as JustChatState;
      saveChats(jc.chats);
      try { localStorage.setItem(CHAT_ACTIVE_KEY, jc.chatId); } catch { /* best effort */ }
    });
  }
  const jc: JustChatState = chatSess.payload ?? DEFAULT_JUSTCHAT;
  const { chats, chatId, draft: chatDraft, busy: chatBusy } = jc;
  const setChatField = <K extends keyof JustChatState>(k: K, v: JustChatState[K] | ((p: JustChatState[K]) => JustChatState[K])) =>
    chatRuntime.setPayload(CHAT_SID, (prev) => {
      const cur = (prev as JustChatState) ?? DEFAULT_JUSTCHAT;
      const nv = typeof v === "function" ? (v as (p: JustChatState[K]) => JustChatState[K])(cur[k]) : v;
      return { ...cur, [k]: nv };
    });
  const setChats = (v: ChatThread[] | ((c: ChatThread[]) => ChatThread[])) => setChatField("chats", v);
  const setChatId = (v: string) => setChatField("chatId", v);
  const setChatDraft = (v: string) => setChatField("draft", v);
  const setChatBusy = (v: boolean) => setChatField("busy", v);
  // Conversation sidebar visibility. The thread list used to hide behind a
  // popover, so the list you need to switch conversations vanished the moment
  // you were in one. It is ambient now; this only remembers a deliberate
  // collapse. Device-local UI (the "owllm:code:" prefix is denied from sync).
  const [chatSidebarOpen, setChatSidebarOpenState] = useState(() => {
    try { return localStorage.getItem(CHAT_SIDEBAR_KEY) !== "0"; } catch { return true; }
  });
  const setChatSidebarOpen = (v: boolean) => {
    setChatSidebarOpenState(v);
    try { localStorage.setItem(CHAT_SIDEBAR_KEY, v ? "1" : "0"); } catch { /* private mode */ }
  };
  // How many memory entries the last chat turn actually recalled — shown on the
  // 🧠 button so "it remembered" is visible rather than something you infer.
  const [chatMemHits, setChatMemHits] = useState(0);
  const [chatAttachments, setChatAttachments] = useState<Attachment[]>([]);
  const chatFileRef = useRef<HTMLInputElement | null>(null);
  // Project-coding composer image attachments (paste / drag-drop / picker) — the
  // same capability the just-chat box and the agentic/fine-tuning chats have, so
  // every chat behaves the same. Sent with the next message, then cleared.
  const [codeAttachments, setCodeAttachments] = useState<Attachment[]>([]);
  const codeFileRef = useRef<HTMLInputElement | null>(null);
  // Composer textareas — refs so "Forward" can drop the text into the target
  // agent's draft and focus it for editing before Send (compose-then-send).
  const codeDraftRef = useRef<HTMLTextAreaElement | null>(null);
  const secondaryDraftRef = useRef<HTMLTextAreaElement | null>(null);
  // Forward a reply into an agent's composer as an EDITABLE draft (not a
  // committed message) — appends under any existing draft, then focuses the
  // box with the cursor at the end so the user can add comments / tweak it
  // before pressing Send.
  const forwardToDraft = (
    setter: (v: string | ((s: string) => string)) => void,
    ref: RefObject<HTMLTextAreaElement | null>,
    block: string,
  ) => {
    setter((d) => (d && d.trim() ? `${d.replace(/\s*$/, "")}\n\n${block}` : block));
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) { el.focus(); const end = el.value.length; el.setSelectionRange(end, end); }
    });
  };
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
  // truth); the chatRuntime persister saves the list on every mutation.
  const chatMsgs: ChatMsg[] = chats.find((c) => c.id === chatId)?.messages ?? [];
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
    setChats((cs) => [{
      id, title: "New chat", ts: Date.now(), messages: [],
      createdDeviceId: deviceIdentity.device_id,
      createdDeviceName: deviceIdentity.name,
    }, ...cs]);
    setChatId(id); setChatAttachments([]); setChatDraft(""); setChatMemHits(0);
  };
  // Switch to an existing conversation. The memory badge counts the LAST turn,
  // so it belongs to the thread you were in — clear it when you leave.
  const openThread = (id: string) => { setChatId(id); setChatAttachments([]); setChatMemHits(0); setChatMode(true); };
  const deleteThread = (id: string) => {
    setChats((cs) => cs.filter((c) => c.id !== id));
    if (chatId === id) { setChatId(""); setChatMemHits(0); }
    // Drop the thread's memory with it. Same store and same commands the memory
    // viewer uses — a deleted chat must not leave unreachable rows behind in
    // team_memory (nothing else can ever address a dead chat: scope again).
    void purgeChatMemory(id);
  };
  const purgeChatMemory = async (threadId: string): Promise<void> => {
    const scope = chatMemoryScope(threadId);
    if (!scope) return;
    try {
      const rows = await invoke<{ id: number }[]>("team_memory_search", { scope, query: "", limit: 500 });
      for (const r of rows) await invoke<number>("team_memory_delete", { scope, id: r.id });
    } catch { /* best effort — the thread is gone either way */ }
  };
  // 🧠 Open the SHARED memory viewer on this conversation's own scope. Same
  // modal, same store the project/team memory uses — only the scope differs.
  const openChatMemory = (): void => {
    const scope = chatMemoryScope(chatId);
    if (!scope) { setStatus("Send a message first — the conversation's memory starts with it."); return; }
    window.dispatchEvent(new CustomEvent("owllm:open-code-memory", { detail: { projectId: scope } }));
  };

  // Paste/drop/pick images and documents. Documents are parsed locally before
  // they enter state, so corrupt/unsupported files surface immediately.
  const addChatFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      try { const a = await fileToChatAttachment(f); setChatAttachments((x) => [...x, a]); }
      catch (e: any) { setStatus(String(e?.message ?? e)); }
    }
  };
  const onChatPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return; // let normal text paste through
    e.preventDefault();
    void addChatFiles(files);
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
    const restored = stampLegacyMetaNotices(loadPageSession(pageId)
      ?? (pageId === "main" ? loadCodeSession(getLastCodeProject()) : null));
    chatRuntime.hydrateIfIdle(SID, restored ?? DEFAULT_CODE_STATE);
    // Persist EVERY mutation (debounced) under this page id, with a final flush
    // after unmount / stream-end — the "coded for an hour, closed the app,
    // nothing saved" fix, now per page.
    chatRuntime.registerPersister(SID, (payload) => {
      const state = payload as CodeState;
      savePageSession(pageId, state);
      // A second, project-root keyed copy makes "Recent projects → reopen"
      // restore the conversation even when its old page catalog was lost.
      saveCodeSession(state);
    });
  }
  // Recent projects, for the onboarding screen shown when no folder is open.
  const [recents, setRecents] = useState<string[]>(getCodeRecents);
  const [recentsMeta, setRecentsMeta] = useState<Record<string, RecentMeta>>(getRecentsMeta);
  const [catalogProjects, setCatalogProjects] = useState<ProjectCatalogRow[]>([]);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [ghostProjectId, setGhostProjectId] = useState("");
  const [deviceIdentity, setDeviceIdentity] = useState<{ device_id: string; name: string }>({ device_id: "", name: "This PC" });
  const refreshProjectCatalog = () =>
    invoke<ProjectCatalogRow[]>("list_projects")
      .then((rows) => { setCatalogProjects(rows); return rows; })
      .catch(() => [] as ProjectCatalogRow[]);
  useEffect(() => {
    void refreshProjectCatalog();
    void invoke<{ device_id: string; name: string }>("device_get_identity")
      .then((d) => setDeviceIdentity(d))
      .catch(() => {});
    const refresh = () => { void refreshProjectCatalog(); };
    window.addEventListener("owllm:projects:refresh", refresh);
    return () => window.removeEventListener("owllm:projects:refresh", refresh);
  }, []);
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
  const chatMode: boolean = stx.chatMode ?? false;
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
  // `chatBusy` belongs to the global no-project Just Chat surface. Including it
  // here made every project chat glow while an unrelated chat was running (and
  // could look permanently active after navigation). This pane is the coder.
  const primaryAuraActive = busy;
  // One-step undo for per-agent "Clear history": each pane keeps its OWN
  // snapshot of the transcript it last cleared, so clearing one agent never
  // touches the other and each ↩ Undo restores exactly what that pane wiped.
  // Transient (component state) — the undo is a safety net for the click that
  // just happened, not a persisted feature.
  const [primaryUndo, setPrimaryUndo] = useState<Msg[] | null>(null);
  const [secondaryUndo, setSecondaryUndo] = useState<Msg[] | null>(null);
  // Terminal popup (right-column 🖥 button) — floats above THIS app's UI only.
  const [termOpen, setTermOpen] = useState(false);
  // Terminal popup chrome: hide (— keeps the shell alive, just display:none)
  // and drag (title bar). null pos = default docked bottom-right.
  const [termHidden, setTermHidden] = useState(false);
  const [termPos, setTermPos] = useState<{ x: number; y: number } | null>(null);
  // Docked (default) → the shell renders in-column right above the composer,
  // where the input box lives. Popped out → the old floating draggable popup.
  const [termDocked, setTermDocked] = useState(true);
  // Agent Browser popup (right-column 🌐 button) — viewer for the shared daemon.
  const [browserOpen, setBrowserOpen] = useState(false);
  useEffect(() => () => { secondaryAbortRef.current?.abort(); }, []);
  // Tell the tab strip this page has an agent running (coder, second agent, or
  // just-chat) so its tab glows for ANY active agent while it's the visible
  // page. The coder's cross-page glow comes from chatRuntime directly; this
  // extra is cleared on unmount, so a background page never falsely glows for a
  // second-agent/just-chat run it can no longer sustain.
  useEffect(() => {
    pageActivity.reportExtra(pageId, busy || secondaryBusy || chatBusy);
  }, [pageId, busy, secondaryBusy, chatBusy]);
  useEffect(() => () => { pageActivity.reportExtra(pageId, false); }, [pageId]);
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
  const normProjectPath = (p: string) => p.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
  const fallbackProjectScope = (folder: string) => `code:${normProjectPath(folder)}`;
  const resolveFolderProjectScope = async (folder: string, apply = true): Promise<string> => {
    const clean = folder.trim();
    if (!clean) return "";
    const name = clean.replace(/^.*[\\/]/, "") || "Code project";
    const row = await invoke<ProjectScopeRow>("resolve_project_for_location", {
      input: { location: clean, name },
    });
    const id = row.id || fallbackProjectScope(clean);
    if (apply) {
      setRuleScope((prev) => (prev.id === id && prev.shared ? prev : { id, shared: true }));
      try { setDirectives(await invoke<Directive[]>("directives_list", { projectId: id })); }
      catch { setDirectives([]); }
    }
    return id;
  };
  // Resolve the rules/notebook scope whenever the folder changes: prefer the
  // matching AGENTIC project id (shared rule set + notebook with the team),
  // fall back to a stable per-folder key.
  useEffect(() => {
    const folder = (projectRoot || workspace || "").trim();
    if (!folder) { lastScopeFolderRef.current = ""; setRuleScope({ id: "", shared: false }); setDirectives([]); return; }
    const nf = normProjectPath(folder);
    const fallbackId = fallbackProjectScope(folder);
    // Folder switched → drop the previous project's scope IMMEDIATELY so its
    // notebook and rules can never linger on screen while the async project
    // lookup runs (or if it hangs). The lookup below only UPGRADES this to the
    // shared team-project id when the folder matches a registered project —
    // that shared id is what makes the Agent and Code pages load, update, and
    // see one notebook + rule set for the same repo.
    if (lastScopeFolderRef.current !== nf) {
      lastScopeFolderRef.current = nf;
      setRuleScope({ id: fallbackId, shared: false });
      setDirectives([]);
    }
    let alive = true;
    (async () => {
      let id = fallbackId;
      let shared = false;
      try {
        id = await resolveFolderProjectScope(folder, false);
        shared = true;
      } catch { /* no projects table reachable — per-folder scope */ }
      if (!alive) return;
      setRuleScope((prev) => (prev.id === id && prev.shared === shared ? prev : { id, shared }));
      try { setDirectives(await invoke<Directive[]>("directives_list", { projectId: id })); }
      catch { setDirectives([]); }
    })();
    return () => { alive = false; };
  }, [projectRoot, workspace]);
  const reloadDirectives = async () => {
    if (!ruleScope.id) return;
    try { setDirectives(await invoke<Directive[]>("directives_list", { projectId: ruleScope.id })); } catch { /* keep last */ }
  };
  // Keep the shell's tab label in sync with this page's project. A per-page
  // rename (header box) renders as "folder(rename)"; unrenamed pages show the
  // folder name only.
  useEffect(() => {
    const folder = projectRoot ? projectRoot.replace(/^.*[\\/]/, "")
      : workspace ? workspace.replace(/^.*[\\/]/, "")
      : "";
    const rename = (stx.pageRename ?? "").trim();
    onTitle(folder ? (rename ? `${folder}(${rename})` : folder) : "New page");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot, workspace, stx.pageRename]);
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
    // Keep the imperative send gate in sync immediately; waiting for the
    // chatRuntime update to trigger a React render can strand auto-follow-ups.
    busySendRef.current = v;
    // Header "running" aura: code runs (incl. CLI paths that never touch
    // chatRuntime.startStream) count as run activity too.
    setRunActivity(`code:${SID}`, v);
    chatRuntime.setPayload(SID, (prev) => {
      const cur = (prev as CodeState) ?? DEFAULT_CODE_STATE;
      if (v) return { ...cur, busy: true, runStartedAt: Date.now(), runEndedAt: undefined };
      const live = cur.runStartedAt != null && cur.runEndedAt == null;
      return { ...cur, busy: false, runEndedAt: live ? Date.now() : cur.runEndedAt };
    });
  };
  const setStatus = (v: string) => setField("status", v);
  const setAgentMode = (v: CodeAgentMode) => setField("agentMode", v);
  const setChatMode = (v: boolean) => setField("chatMode", v);
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

  const ensureCatalogProject = async (dir: string, preferredName?: string): Promise<ProjectCatalogRow | null> => {
    const norm = (p: string) => p.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
    const rows = await invoke<ProjectCatalogRow[]>("list_projects").catch(() => catalogProjects);
    const existing = rows.find((p) => p.location && norm(p.location) === norm(dir));
    let repoUrl = await invoke<string>("github_repo_url", { cwd: dir }).catch(() => "");
    if (existing) {
      if (repoUrl && repoUrl !== existing.repo_url) {
        await invoke("update_project", { input: { id: existing.id, repo_url: repoUrl } });
      }
      const next = { ...existing, repo_url: repoUrl || existing.repo_url };
      setCatalogProjects(rows.map((p) => p.id === next.id ? next : p));
      return next;
    }
    try {
      const row = await invoke<ProjectCatalogRow>("create_project", {
        input: {
          name: preferredName || dir.replace(/^.*[\\/]/, "") || "Coding project",
          description: "Coding workspace",
          location: dir,
          repo_url: repoUrl,
          create_location: false,
          project_kind: "coding",
          team: [],
          graph_json: "",
          team_default_model_id: "",
          trust_writes: true,
          auto_approve_all: false,
        },
      });
      setCatalogProjects((prev) => [row, ...prev.filter((p) => p.id !== row.id)]);
      return row;
    } catch {
      return null;
    }
  };

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
    const catalogProject = await ensureCatalogProject(dir, name);
    const normPath = (p: string | undefined) =>
      (p || "").replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
    const reopeningCurrent = normPath(stx.projectRoot || stx.workspace) === normPath(dir);
    const openingBlankPage = !hasRecoverablePageState(stx);
    // Prefer the live page when it already owns this project. Otherwise recover
    // the latest project-root copy written by the persister. This is evaluated
    // BEFORE the preparing state so opening a folder can never blank the chat.
    // A deliberately-created blank page must start a fresh conversation and
    // worktree, even when another page already uses this same project.
    const recovered = reopeningCurrent ? stx : openingBlankPage ? null : loadCodeSession(dir);
    const base = recovered ?? DEFAULT_CODE_STATE;
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
    // Re-opening the SAME project (worktree self-heal / re-pick) keeps the
    // page's rename; switching to a different project starts unnamed.
    const keepRename = reopeningCurrent ? stx.pageRename : undefined;
    chatRuntime.setPayload(SID, () => ({
      ...base,
      projectId: catalogProject?.id || base.projectId,
      repoUrl: catalogProject?.repo_url || base.repoUrl,
      createdDeviceId: catalogProject?.created_device_id || base.createdDeviceId || deviceIdentity.device_id,
      createdDeviceName: catalogProject?.created_device_name || base.createdDeviceName || deviceIdentity.name,
      projectRoot: dir,
      workspace: "",
      modelId: base.modelId || modelId,
      pageRename: keepRename,
      busy: false,
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
      chatRuntime.setPayload(SID, (p) => ({
        ...((p as CodeState) ?? base),
        preparing: false,
        status: `"${name}" has uncommitted changes — commit or stash them first, then reopen so the worktree includes them.\n${outcome.details.split("\n").slice(0, 3).join("\n")}`,
      }));
    } else {
      chatRuntime.setPayload(SID, (p) => ({
        ...((p as CodeState) ?? base),
        preparing: false,
        status: `Couldn't create the worktree: ${outcome.message}`,
      }));
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
      const dir = await open({ directory: true, multiple: false, title: translateUiText("Pick a project folder") });
      if (typeof dir === "string" && dir) openWorkspace(dir);
    } catch (e) {
      setStatus(`Folder picker failed: ${e}`);
    }
  };

  const openCatalogProject = async (project: ProjectCatalogRow) => {
    setCatalogError("");
    setGhostProjectId(project.id);
    if (project.location.trim()) {
      const detail: OpenProjectPagesDetail = {
        project,
        currentPageIsBlank: !hasRecoverablePageState(stx),
        handled: false,
      };
      window.dispatchEvent(new CustomEvent<OpenProjectPagesDetail>(OPEN_PROJECT_PAGES_EVENT, { detail }));
      if (detail.handled) return;
      await openWorkspace(project.location);
      return;
    }
    if (!project.repo_url) return; // stays ghosted with the source-PC guidance.
    setCatalogBusy(true);
    try {
      const parent = await invoke<string | null>("pick_folder", {
        title: `Choose where to clone ${project.name} on this computer`,
      });
      if (!parent) return;
      const location = await invoke<string>("github_clone_project", {
        repoUrl: project.repo_url,
        parent,
      });
      await invoke("update_project", { input: { id: project.id, location } });
      await refreshProjectCatalog();
      await openWorkspace(location);
    } catch (e: any) {
      setCatalogError(String(e?.message ?? e));
    } finally {
      setCatalogBusy(false);
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
          translateUiText(`Close this project? Unmerged changes in its worktree (${stx.branch}) will be discarded. Merge to main first to keep them.`),
          { title: translateUiText("Close project"), kind: "warning" },
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
  // Onboarding lists (WSL/sandbox projects + toolchain) only populate the PICKER
  // screen, so fetch them ONLY when this page has no project — a page with one
  // open skips these extra wsl.exe calls.
  useEffect(() => {
    if (workspace) return;
    let dead = false;
    probeSandboxOnce().then(({ st, iso, s }) => {
      if (dead) return;
      setWslStat(st);
      setIsolation(iso);
      setSbox(s);
      refreshWslProjects(iso, st);
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
  const [importRepoUrl, setImportRepoUrl] = useState("");
  const [githubRepos, setGithubRepos] = useState<GithubRepository[]>([]);
  const [githubReposBusy, setGithubReposBusy] = useState(false);
  const [selectedGithubRepo, setSelectedGithubRepo] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importMsg, setImportMsg] = useState("");
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
  useEffect(() => {
    if (!gh?.connected) {
      setGithubRepos([]);
      setSelectedGithubRepo("");
      return;
    }
    let dead = false;
    setGithubReposBusy(true);
    githubListRepositories()
      .then((repos) => {
        if (dead) return;
        setGithubRepos(repos);
        setSelectedGithubRepo((cur) => cur || repos[0]?.fullName || "");
      })
      .catch((e) => {
        if (!dead) setImportMsg(`Could not load GitHub repositories: ${String((e as Error)?.message ?? e)}`);
      })
      .finally(() => { if (!dead) setGithubReposBusy(false); });
    return () => { dead = true; };
  }, [gh?.connected, gh?.login]);
  const refreshGithubRepositories = async () => {
    if (!gh?.connected || githubReposBusy) return;
    setGithubReposBusy(true);
    setImportMsg("Refreshing your GitHub repositories...");
    try {
      const repos = await githubListRepositories();
      setGithubRepos(repos);
      setSelectedGithubRepo((cur) => cur || repos[0]?.fullName || "");
      setImportMsg(repos.length ? `Loaded ${repos.length} GitHub repositories.` : "No repositories are visible to this GitHub account.");
    } catch (e) {
      setImportMsg(`Could not load GitHub repositories: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setGithubReposBusy(false);
    }
  };
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
      setGhMsg("Disconnected — remote sync stopped and OWLLM credentials scrubbed. Local projects and chats remain available offline.");
    } catch (e) {
      setGhMsg(`Couldn't disconnect: ${e}`);
    } finally {
      setGhBusy(false);
    }
  };

  const importGithubProject = async () => {
    const selectedRepo = gh?.connected ? githubRepos.find((repo) => repo.fullName === selectedGithubRepo) : null;
    const repoUrl = selectedRepo?.cloneUrl || importRepoUrl.trim();
    if (importBusy) return;
    if (!repoUrl) {
      setImportMsg(gh?.connected ? "Select one of your GitHub repositories first." : "Sign in with GitHub, or paste a public repository URL.");
      return;
    }
    setImportBusy(true);
    setImportMsg("Choose the local parent folder for this clone…");
    try {
      const parent = await invoke<string | null>("pick_folder", {
        title: selectedRepo ? `Choose where to clone ${selectedRepo.fullName}` : "Choose where to clone this GitHub project",
      });
      if (!parent) {
        setImportMsg("Import cancelled — no local folder was changed.");
        return;
      }
      setImportMsg("Cloning from GitHub and creating the local project binding…");
      const location = await invoke<string>("github_clone_project", { repoUrl, parent });
      setImportRepoUrl("");
      setSelectedGithubRepo("");
      setImportMsg(`Imported to ${location}`);
      await refreshProjectCatalog();
      await openWorkspace(location);
    } catch (e) {
      setImportMsg(`Import failed: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setImportBusy(false);
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
    setNpIsolate(false); // host folders are instant; isolation is an explicit choice
    setNpCreateRepo(!!gh?.connected);
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
      if (createdPath) await ensureCatalogProject(createdPath, npName.trim() || undefined);
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
    const scope = await resolveMemoryScope();
    const empty: TeamMemoryPack = { scope, query: user, block: "", total: 0, factCount: 0, worklogCount: 0 };
    if (!scope || !user.trim()) return { text: user, pack: empty };
    setTeamMemoryScope(scope);
    setTeamMemoryGoal(user);
    await refreshTeamMemorySnapshot();
    const pack = await retrieveScopedTeamMemoryPack(scope, user, 8, false);
    return { text: enrichInstructionWithMemory(pack.block, user), pack };
  };

  const memoryScope = () => ruleScopeRef.current.id || ((projectRoot || workspace) ? fallbackProjectScope(projectRoot || workspace) : "");
  const resolveMemoryScope = async (): Promise<string> => {
    const current = ruleScopeRef.current;
    if (current.shared && current.id) return current.id;
    const folder = (projectRoot || workspace || "").trim();
    if (!folder) return current.id || "";
    try {
      return await resolveFolderProjectScope(folder);
    } catch {
      return current.id || fallbackProjectScope(folder);
    }
  };
  const openProjectMemory = async (): Promise<void> => {
    const scope = await resolveMemoryScope();
    if (!scope) {
      setStatus("Open a project before viewing Project Memory.");
      return;
    }
    window.dispatchEvent(new CustomEvent("owllm:open-code-memory", {
      detail: { projectId: scope },
    }));
  };

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

  // `scopeOverride` lets a caller PIN the scope it captured when the turn
  // started (the just-chat surface pins its thread's chat: scope). The chat
  // stream outlives the page — resolving the scope again at reply time would
  // read whatever project the user has since navigated to.
  const enrichCodePromptWithMemory = async (user: string, scopeOverride?: string): Promise<{ text: string; pack: TeamMemoryPack }> => {
    const scope = scopeOverride ?? await resolveMemoryScope();
    const empty: TeamMemoryPack = { scope, query: user, block: "", total: 0, factCount: 0, worklogCount: 0 };
    if (!scope || !user.trim()) return { text: user, pack: empty };
    setTeamMemoryScope(scope);
    setTeamMemoryGoal(user);
    await refreshTeamMemorySnapshot();
    const pack = await retrieveScopedTeamMemoryPack(scope, user, 8, false);
    return { text: enrichInstructionWithMemory(pack.block, user), pack };
  };

  const logCodeWork = async (agent: string, instruction: string, result: string, scopeOverride?: string) => {
    const scope = scopeOverride ?? await resolveMemoryScope();
    if (!scope || !result.trim()) return;
    setTeamMemoryScope(scope);
    setTeamMemoryGoal(instruction);
    await harvestMemoryWrites(result);
    await logScopedTeamWork(scope, agent, instruction, stripMemoryDirectives(result));
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
    opts?: { silent?: boolean; withEvents?: boolean; attachments?: Attachment[] },
  ): Promise<string> => {
    const provider = providerFor(modelId, availableModels);
    const isLocal = provider === "local" || provider === "tuned";
    const dDelta = opts?.silent ? () => {} : onDelta;
    const dThought = opts?.silent ? () => {} : onThought;
    const attachments = opts?.attachments ?? [];
    const imgs = imageAttachments(attachments);
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
    const { text: enrichedUser, pack } = await enrichCodePromptWithMemory(appendDocumentAttachmentText(user, attachments));
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
    const attachments = fromComposer ? codeAttachments : [];
    const images = imageAttachments(attachments);
    if (!text && attachments.length === 0) return;
    if (busySendRef.current) {
      // Coder is mid-turn → the message becomes a ⚡ steer (VS Code-style),
      // injected between tool calls on local models, at turn end otherwise —
      // never silently dropped. Extracted documents are text and can ride the
      // steer; image bytes still cannot.
      const steerText = appendDocumentAttachmentText(text, attachments);
      if (steerText.trim()) {
        steerRef.current.push(steerText);
        if (fromComposer) { setDraft(""); setCodeAttachments([]); }
        const names = attachments.filter((a) => a.kind === "document").map((a) => a.filename ?? "document");
        const visible = names.length ? `${text}${text ? " · " : ""}📄 ${names.join(", ")}` : text;
        setMessages((msgs) => [...msgs, { role: "user", content: `⚡ queued to steer the run → ${visible}`, context: steerText, ts: Date.now() }]);
      }
      return;
    }
    // Guard failures on PROGRAMMATIC sends (fix-with-agent, notebook auto-feed,
    // pane cross-feed) get a visible transcript bubble — a status-line note is
    // invisible when the user isn't watching the composer, and a silently
    // dropped task looks like "the agent ignored me".
    const blockSend = (why: string) => {
      setStatus(why);
      if (!fromComposer) setMessages((msgs) => [...msgs, { role: "assistant", content: `⚠ ${why}\n\nDropped task:\n${text.length > 400 ? text.slice(0, 400) + "…" : text}`, ts: Date.now() }]);
    };
    if (!workspace) { blockSend(preparing ? "Workspace still preparing — Send unlocks in a moment." : "Pick a workspace folder first (Browse)."); return; }
    if (!modelId) { blockSend("No model selected — pick one in the Coder header."); return; }
    if (fromComposer) { setDraft(""); setCodeAttachments([]); autoFeedHopsRef.current = 0; }
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const history: HistoryItem[] = messages
      .filter((m) => m.role === "user" || (m.role === "assistant" && !m.kind && !m.placeholder && m.content.trim()))
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.context || m.content }));
    // The bubble shows the actual images as clickable thumbnails; the same
    // images also ride to the model via runTurn.
    const attachmentNames = attachments.filter((a) => a.kind === "document").map((a) => a.filename ?? "document");
    const visibleText = attachmentNames.length ? `${text}${text ? "\n\n" : ""}📄 ${attachmentNames.join(", ")}` : text;
    setMessages((msgs) => [...msgs, { role: "user", content: visibleText, context: appendDocumentAttachmentText(text, attachments), ts: Date.now(), images: images.length ? attachmentThumbs(images) : undefined }]);
    // Immediately show the user that something is happening, so the timer is not
    // the only visible change. The placeholder is replaced by real tokens/tools.
    setMessages((msgs) => [...msgs, { role: "assistant", content: "⏳ Starting…", placeholder: true, ts: Date.now() }]);
    setRunPhase("starting");
    let ok = false;
    let aborted = false;
    /// A preflight refused before the agent started (no CLI installed, no
    /// isolated worktree). Nothing ran, so the card must stay pending and
    /// retryable rather than being recorded as a failed delivery.
    let stoppedAtPreflight = false;
    let failureReason = "The run ended with an error.";
    let replyText = "";
    try {
      // Workspace path now lives at the top of the PublishCards rail — no need
      // to echo it in the composer status line every turn.
      setStatus("Coding…");
      const reply = await runTurn(CODING_SYSTEM(workspace), text || "(read the attached file)", history, ctrl.signal, { withEvents: true, attachments });
      await logCodeWork("code", text || "(read the attached file)", reply);
      replyText = reply;
      ok = true;
    } catch (e) {
      const err = e as { name?: string; message?: string };
      aborted = err.name === "AbortError";
      stoppedAtPreflight = e instanceof CliPreflightError || e instanceof WorktreePreflightError;
      failureReason = aborted ? "The run was stopped." : (err.message ?? String(e));
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
      // 📓 Stamp notebook step timing and append a concise run timing footer
      // after the agent's answer so the user sees start/finish for every run.
      const now = Date.now();
      const payload = chatRuntime.getSnapshot(SID).payload as CodeState | undefined;
      // One outcome for every card this run carried, decided in the shared
      // helper so this page and the Agents page cannot diverge again.
      const outcome: NotebookRunOutcome = ok
        ? { kind: "clean" }
        : stoppedAtPreflight ? { kind: "preflight" } : { kind: "failed", reason: failureReason };
      // Did the QUEUE dispatch this run? Captured before the refs are cleared
      // below, because it decides whether the chain may advance. A plain typed
      // message must never pop a card: `autoFeed` is sticky across restarts, so
      // an unrelated clean turn used to resume a queue switched on days ago and
      // the step arrived looking exactly like something the user had asked for.
      const ranFromNotebook = notebookStepRef.current != null || notebookSteerInFlightIdsRef.current.length > 0;
      if (notebookStepRef.current) {
        settleNotebookStep(ruleScopeRef.current.id, notebookStepRef.current, outcome, now);
        notebookStepRef.current = null;
      }
      for (const sid of notebookSteerInFlightIdsRef.current.splice(0, notebookSteerInFlightIdsRef.current.length)) {
        settleNotebookStep(ruleScopeRef.current.id, sid, outcome, now);
      }
      if (payload?.runStartedAt) {
        setMessages((msgs) => [...msgs, { role: "assistant", kind: "meta", content: runTimingFooter(payload.runStartedAt!, now), ts: now }]);
      }
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
        if (leftover) {
          // Stopped with steers still queued. drainSteer just moved their cards
          // into the in-flight list, but the run they belonged to is over — left
          // there they would be stamped with an UNRELATED later run's outcome.
          // Hand them back to the queue as pending instead.
          for (const sid of notebookSteerInFlightIdsRef.current.splice(0, notebookSteerInFlightIdsRef.current.length)) {
            settleNotebookStep(ruleScopeRef.current.id, sid, { kind: "preflight" });
          }
        }
        // Advance the chain only from a run the queue itself dispatched, or
        // from the one run the user explicitly armed with ▶ Start queue while
        // the agent was busy. Checking the arm second keeps it unconsumed while
        // the chain is already self-sustaining.
        if (ok && (ranFromNotebook || consumeAutoFeedArm(ruleScopeRef.current.id, notebookSurfaceId))) {
          const result = continueNotebookAutoFeed(ruleScopeRef.current.id, notebookSurfaceId, (st) => {
            notebookStepRef.current = st.id;
            void sendRef.current?.(`📓 Next step from the Notebook (auto-fed):\n${st.text}`);
          });
          // Discarding this result is how a stalled queue stayed silent, and
          // autoFeedWouldRun can't report it (it is false for exactly this
          // reason). Say it directly.
          if (result === "inactive" && notebookPendingStepCount(ruleScopeRef.current.id) > 0) {
            setMessages((msgs) => [...msgs, { role: "assistant", kind: "meta", content: "📓 Auto-feed idle here — another open window on this project is driving the queue. Use “Take over here” in the Notebook to drive it from this page.", ts: Date.now() }]);
          }
        } else if (!ok && ranFromNotebook && autoFeedWouldRun(ruleScopeRef.current.id, notebookSurfaceId)) {
          // Only a broken QUEUE run is worth reporting. A failed message the
          // user typed themselves has nothing to do with the notebook, and the
          // wording no longer offers "send a message" as a way to resume —
          // that is exactly the accident this gate removes.
          setMessages((msgs) => [...msgs, { role: "assistant", kind: "meta", content: `📓 Auto-feed paused — the turn ${aborted ? "was stopped" : "ended with an error"}. Pending steps stay in the Notebook queue; press ▶ Start queue in the Notebook to continue.`, ts: Date.now() }]);
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
    // A new second-agent turn supersedes its pending clear-undo (see setBusy).
    setSecondaryUndo(null);
    setSecondaryBusy(true);
    const ctrl = new AbortController();
    secondaryAbortRef.current = ctrl;
    const history: HistoryItem[] = secondaryMessages
      .filter((m) => m.role === "user" || (m.role === "assistant" && !m.kind && !m.placeholder && m.content.trim()))
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.context || m.content }));
    setSecondaryMessages((m) => [...m, { role: "user", content: text, ts: Date.now() }]);
    setSecondaryMessages((m) => [...m, { role: "assistant", content: "⏳ Starting…", placeholder: true, ts: Date.now() }]);
    let aborted = false;
    let replyText = "";
    try {
      setStatus("Second agent working…");
      replyText = await runSecondaryTurn(CODING_SYSTEM(workspace), text, history, ctrl.signal, { withEvents: true });
      await logCodeWork("code_second", text, replyText);
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

  const toggleWorkspaceTerminal = () => {
    // Hidden shells re-open; visible shells hide. Both agent composers control
    // the same workspace terminal, so a second shell/process is never created.
    if (!termOpen) {
      setTermOpen(true);
      setTermHidden(false);
    } else {
      setTermHidden((hidden) => !hidden);
    }
  };

  const renderTerminalButton = (owner: "primary" | "secondary") => (
    <button
      data-ui={owner === "primary" ? "CodePrimaryTerminalButton" : "CodeSecondaryTerminalButton"}
      onClick={toggleWorkspaceTerminal}
      title="Open the workspace terminal"
      aria-label={`Open terminal for the ${owner} agent`}
      style={{ ...btn, height: 24, padding: "0 10px", fontSize: 11, ...(termOpen && !termHidden ? { borderColor: "var(--accent)", color: "var(--accent-ink)" } : {}) }}
    >Terminal</button>
  );

  // The second agent's composer — ONE definition, rendered in two homes:
  // inside the pane when the panes are STACKED (narrow), or in the divided
  // bottom composer row aligned under its pane when side-by-side (wide) —
  // the fine-tuning-chat layout: columns above, inputs divided below.
  const renderSecondaryComposer = () => (
    <div data-ui="CodeSecondaryComposer" style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0, flexShrink: 0 }}>
      <div data-ui="CodeSecondaryComposerToolbar" style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span style={{ fontSize: 11, color: "var(--fg-muted)", flexShrink: 0 }}>Model</span>
        <div data-ui="CodeSecondaryComposerModelPicker" style={{ flex: 1, minWidth: 0 }}>
          <ModelPicker
            value={secondaryModelId}
            onChange={setSecondaryModelId}
            models={availableModels}
            status={accountsStatus}
            disabled={secondaryBusy}
            fallbackLabel="Same as 1st agent"
            placement="top"
          />
        </div>
        {renderTerminalButton("secondary")}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "flex-end", minWidth: 0 }}>
        <textarea
          ref={secondaryDraftRef}
          value={secondaryDraft}
          onChange={(e) => setSecondaryDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendSecondary(); } }}
          placeholder="Message the second agent… (same workspace, its own conversation & model)"
          rows={2}
          disabled={secondaryBusy}
          style={{ flex: 1, resize: "vertical", minHeight: 44, maxHeight: 120, padding: 8, background: "var(--bg-input)", border: "1px solid var(--border-strong)", borderRadius: 8, color: "var(--fg)", fontSize: "var(--chat-font-size, 13px)", lineHeight: 1.5, fontFamily: "inherit", boxSizing: "border-box", opacity: secondaryBusy ? 0.6 : 1 }}
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
    </div>
  );

  // Notebook → coder: idle = dispatch now; busy = mid-run steer (drained
  // between tool calls on local models, at turn end otherwise).
  const feedFromNotebook = (text: string, stepId?: string): "queued" | "dispatched" | "no-team" => {
    if (!workspace || !modelId) return "no-team";
    if (busySendRef.current) {
      steerRef.current.push(text);
      if (stepId) notebookSteerStepIdsRef.current.push(stepId);
      return "queued";
    }
    notebookStepRef.current = stepId ?? null;
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
  // The hub card's primary button. Unlike startChat (which RESUMES the latest
  // thread) this always opens an empty one — the card lists the recent threads
  // right below it, so resuming is a click away and "New" can mean new.
  const startNewChat = () => { newChat(); setChatMode(true); };
  const sendChat = async () => {
    const text = chatDraft.trim();
    const attachments = chatAttachments;
    const images = imageAttachments(attachments);
    if ((!text && attachments.length === 0) || chatBusy) return;
    if (!modelId) { setStatus("Pick a model in the Coder header first."); return; }
    setChatDraft("");
    setChatAttachments([]);
    setChatBusy(true);
    const ctrl = new AbortController();
    justChatAbort = ctrl;
    // The visible bubble shows the actual images as clickable thumbnails; the
    // same images also ride to the model via the multimodal content below.
    const documentNames = attachments.filter((a) => a.kind === "document").map((a) => a.filename ?? "document");
    const visibleText = documentNames.length ? `${text}${text ? "\n\n" : ""}📄 ${documentNames.join(", ")}` : text;
    const userMsg: ChatMsg = { role: "user", content: visibleText, context: appendDocumentAttachmentText(text, attachments), images: images.length ? attachmentThumbs(images) : undefined };
    const asstMsg: ChatMsg = { role: "assistant", content: "" };
    // Resolve/create the active thread; history = its current messages.
    let tid = chatId;
    const existing = chats.find((c) => c.id === tid);
    const history: HistoryItem[] = (existing?.messages ?? []).map((m) => ({ role: m.role, content: m.context || m.content }));
    if (existing) {
      updateThread(tid, (m) => [...m, userMsg, asstMsg], threadTitle(text || "Image"));
    } else {
      tid = newThreadId();
      setChatId(tid);
      setChats((cs) => [{
        id: tid, title: threadTitle(text || "Image"), ts: Date.now(), messages: [userMsg, asstMsg],
        createdDeviceId: deviceIdentity.device_id,
        createdDeviceName: deviceIdentity.name,
      }, ...cs]);
    }
    const onD = (d: string) => updateThread(tid, (m) => {
      const c = [...m];
      const last = c[c.length - 1];
      if (last && last.role === "assistant") c[c.length - 1] = { ...last, content: last.content + d };
      return c;
    });
    // Thinking stream — shown collapsed in the bubble, like every other chat.
    const onT = (d: string) => updateThread(tid, (m) => {
      const c = [...m];
      const last = c[c.length - 1];
      if (last && last.role === "assistant") c[c.length - 1] = { ...last, thinking: (last.thinking ?? "") + d };
      return c;
    });
    try {
      const provider = providerFor(modelId, availableModels);
      // 🧠 Pin THIS thread's memory scope for the whole turn. Captured from the
      // resolved thread id, never re-resolved after the await, so a reply that
      // lands after the user navigated away still reads and writes the chat it
      // belongs to instead of whatever project is on screen by then.
      const chatScope = chatMemoryScope(tid);
      const { text: enrichedText, pack } = await enrichCodePromptWithMemory(appendDocumentAttachmentText(text, attachments), chatScope);
      setChatMemHits(pack.total);
      if (provider === "local" || provider === "tuned") {
        const port = await ensureServer(modelId);
        if (!port) throw new Error("Local engine didn't come up — check the Server tab / install Local Inference.");
        const reply = await streamLocalChat({ port, modelId, systemPrompt: "You are a helpful, concise assistant.", userContent: openaiUserContent(enrichedText, images), temperature: 0.4, signal: ctrl.signal, onDelta: onD, onThought: onT, history });
        await logCodeWork("code_chat", text || "(see attached image)", reply, chatScope);
      } else {
        // Pass a working dir so pasted images can be saved into it for the model
        // to read (codex -i / claude file-ref). Use the workspace if one is
        // selected, else the WSL scratch — without ANY cwd the image is dropped
        // ("I can't inspect the image"), which is the bug on a no-folder chat.
        const chatCwd = workspace || chatScratchRef.current || undefined;
        const reply = await streamChatCompletion(0, modelId, provider, "You are a helpful, concise assistant.", enrichedText, 0.4, ctrl.signal, onD, chatCwd, history, false, () => {}, undefined, images);
        await logCodeWork("code_chat", text || "(see attached image)", reply, chatScope);
      }
    } catch (e) {
      const err = e as { name?: string; message?: string };
      if (err.name !== "AbortError") onD(`\n\n⚠ ${err.message ?? e}`);
    } finally {
      setChatBusy(false);
      justChatAbort = null;
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
          const stepReply = await runTurn(
            CODING_SYSTEM(workspace),
            `Overall goal: ${goal}\n\nDo THIS step now (only this step): ${plan[i].title}`,
            [], ctrl.signal, { withEvents: true },
          );
          await logCodeWork("code", plan[i].title, stepReply);
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
  // Per-agent "Clear history": clears ONLY the pane it belongs to and stashes a
  // snapshot for that pane's ↩ Undo. No confirm dialog — the undo is the safety
  // net, and each agent is fully independent (clearing the Coder leaves the
  // Second agent's transcript, and its undo, untouched, and vice versa).
  const clearPrimaryHistory = () => {
    if (busy || messages.length === 0) return;
    setPrimaryUndo(messages);
    setMessages([]);
  };
  const undoPrimaryHistory = () => {
    const snap = primaryUndo;
    if (!snap) return;
    setMessages(snap);
    setPrimaryUndo(null);
  };
  const clearSecondaryHistory = () => {
    if (secondaryBusy || secondaryMessages.length === 0) return;
    setSecondaryUndo(secondaryMessages);
    setSecondaryMessages([]);
  };
  const undoSecondaryHistory = () => {
    const snap = secondaryUndo;
    if (!snap) return;
    setSecondaryMessages(snap);
    setSecondaryUndo(null);
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
  // Project-composer attachments — mirror addChatFiles (just-chat box).
  const addCodeFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      try { const a = await fileToChatAttachment(f); setCodeAttachments((x) => [...x, a]); }
      catch (e: any) { setStatus(String(e?.message ?? e)); }
    }
  };

  const wsShort = (projectRoot || workspace) ? (projectRoot || workspace)!.replace(/^.*[\\/]/, "") : "No folder";

  // ---- Just-chat mode (no folder): the everyday-chat surface --------------
  if (!workspace && chatMode) {
    return (
      <div style={{ height: "100%", display: "flex", background: "var(--bg-panel)", color: "var(--fg)" }}>
        {/* ── Conversation sidebar (left, ambient) ─────────────────────────
            The list lives here rather than behind a popover: switching
            conversations is the primary action of a chat surface, so it must
            be permanently visible and one click away. */}
        {chatSidebarOpen && (
          <aside style={{ width: 262, flex: "0 0 262px", minWidth: 0, display: "flex", flexDirection: "column", background: "var(--bg-card)", borderRight: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 8px 6px 10px" }}>
              <button onClick={() => setChatMode(false)} title="Back to Start" style={{ ...btn, height: 28, padding: "0 9px", fontSize: 12 }}>← Start</button>
              <div style={{ flex: 1 }} />
              <button onClick={() => setChatSidebarOpen(false)} title="Hide conversation list" aria-label="Hide conversation list" style={{ ...btn, height: 28, width: 28, padding: 0, justifyContent: "center", color: "var(--fg-muted)" }}>⟨</button>
            </div>
            <div style={{ padding: "0 10px 8px" }}>
              <button onClick={newChat} title="Start a new conversation" style={{ ...btn, width: "100%", height: 36, justifyContent: "center", gap: 7, fontWeight: 700, fontSize: 13, background: "var(--bg-input)", borderColor: "var(--border-strong)", color: "var(--fg-strong)" }}>＋ New conversation</button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 6px 10px" }}>
              {chats.length === 0 && (
                <div style={{ fontSize: 12, color: "var(--fg-subtle)", padding: "10px 8px", lineHeight: 1.6 }}>No conversations yet. Your chats appear here.</div>
              )}
              {groupChatsByDate(chats).map((group) => (
                <div key={group.label} style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: "var(--fg-subtle)", padding: "4px 8px" }}>{group.label}</div>
                  {group.items.map((c) => {
                    const active = c.id === chatId;
                    return (
                      <div key={c.id} onClick={() => openThread(c.id)} title={c.title || "Chat"}
                        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-input)"; const x = e.currentTarget.querySelector("[data-del]") as HTMLElement | null; if (x) x.style.opacity = "1"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = active ? "var(--bg-input)" : "transparent"; const x = e.currentTarget.querySelector("[data-del]") as HTMLElement | null; if (x) x.style.opacity = "0"; }}
                        style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 8px", borderRadius: 8, cursor: "pointer", background: active ? "var(--bg-input)" : "transparent", borderLeft: `2px solid ${active ? "var(--accent)" : "transparent"}` }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12.5, color: active ? "var(--fg-strong)" : "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.title || "Chat"}</div>
                          <div style={{ fontSize: 10, color: "var(--fg-subtle)", marginTop: 1 }}>{fmtAgo(c.ts)} · {c.messages.length} msg</div>
                        </div>
                        {/* Delete reveals on hover — a permanent ✕ next to every
                            row invites the misclick it can't undo. */}
                        <button data-del onClick={(e) => { e.stopPropagation(); deleteThread(c.id); }} title="Delete conversation and its memory" style={{ ...btn, height: 22, width: 22, padding: 0, justifyContent: "center", color: "var(--fg-muted)", fontSize: 11, opacity: 0, transition: "opacity .12s" }}>✕</button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </aside>
        )}
        {/* ── Conversation ─────────────────────────────────────────────── */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
            {!chatSidebarOpen && (
              <button onClick={() => setChatSidebarOpen(true)} title="Show conversation list" aria-label="Show conversation list" style={{ ...btn, height: 30, padding: "0 9px" }}>☰{chats.length ? ` ${chats.length}` : ""}</button>
            )}
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--fg-strong)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 320 }}>{chats.find((c) => c.id === chatId)?.title || "New chat"}</span>
            <span title="This no-project chat is stored on its creator computer." style={{ fontSize: 10.5, color: "var(--fg-muted)", border: "1px solid var(--border)", borderRadius: 7, padding: "4px 7px", whiteSpace: "nowrap" }}>
              🖥 {chats.find((c) => c.id === chatId)?.createdDeviceName || deviceIdentity.name}
            </span>
            <div style={{ flex: 1 }} />
            <div style={{ width: 240, maxWidth: "40%" }}>
              <ModelPicker value={modelId} onChange={setModelId} models={availableModels} status={accountsStatus} fallbackLabel="Pick a model" />
            </div>
            {/* 🧠 This conversation's own memory — the SAME viewer and the same
                team_memory store the projects use, scoped to this thread. */}
            <button data-ui="ChatThreadMemory" onClick={openChatMemory} title="What this conversation remembers (searchable, editable)" style={{ ...btn, height: 30, padding: "0 10px", color: chatMemHits > 0 ? "var(--accent-ink)" : "var(--fg-muted)" }}>🧠 Memory{chatMemHits > 0 ? ` (${chatMemHits})` : ""}</button>
            {chatMsgs.length > 0 && <button onClick={() => chatId && updateThread(chatId, () => [])} title="Clear this conversation" style={{ ...btn, height: 30, padding: "0 10px", color: "var(--fg-muted)" }}>Clear</button>}
          </div>
          <div ref={chatSticky.ref} onScroll={chatSticky.onScroll} data-selectall-scope style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "20px 18px" }}>
            {/* Reading column: full-bleed text on a wide window is unreadable,
                and left the empty state floating in a void. */}
            <div style={{ maxWidth: CHAT_COLUMN_MAX, margin: "0 auto", display: "flex", flexDirection: "column", gap: 12, minHeight: "100%" }}>
              {chatMsgs.length === 0 && (
                <div style={{ margin: "auto 0", paddingBottom: 24 }}>
                  <div style={{ fontSize: 26, fontWeight: 700, color: "var(--fg-strong)", letterSpacing: -0.3 }}>What can I help with?</div>
                  <div style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 8, lineHeight: 1.6 }}>
                    Ask anything — no project, no setup. Answers come from the model picked above. To have it work inside a folder, use ← Start and open a project.
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 18 }}>
                    {CHAT_STARTERS.map((s) => (
                      <button key={s} onClick={() => setChatDraft(s)} style={{ ...btn, height: "auto", minHeight: 34, padding: "8px 12px", fontSize: 12.5, borderRadius: 10, color: "var(--fg)", textAlign: "left", whiteSpace: "normal" }}>{s}</button>
                    ))}
                  </div>
                </div>
              )}
              {chatMsgs.map((m, i) => {
                const isUser = m.role === "user";
                return (
                  <ChatBubble key={i} avatar={isUser ? "U" : "C"} sender={isUser ? "You" : "Assistant"} accent={isUser ? "#7aa2ff" : "#7ff0c5"} isUser={isUser} isStreaming={chatBusy && i === chatMsgs.length - 1 && !isUser} content={m.content} thinking={m.thinking} images={m.images} />
                );
              })}
            </div>
          </div>
          <div style={{ borderTop: "1px solid var(--border)", padding: "10px 18px 12px", display: "flex", flexDirection: "column", gap: 8, maxWidth: CHAT_COLUMN_MAX, width: "100%", margin: "0 auto", boxSizing: "border-box" }}>
          {chatAttachments.length > 0 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {chatAttachments.map((a, i) => (
                <div key={i} style={{ position: "relative", minWidth: a.kind === "image" ? 56 : 150, height: 56, borderRadius: 8, overflow: "hidden", border: "1px solid var(--border-strong)", background: "var(--bg-input)", display: "flex", alignItems: "center", justifyContent: "center", padding: a.kind === "image" ? 0 : "0 24px 0 10px", boxSizing: "border-box", color: "var(--fg)", fontSize: 11, fontWeight: 700 }}>
                  {a.kind === "image" ? <img src={`data:${a.mime};base64,${a.data_b64}`} alt={a.filename} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span>📄 {a.filename ?? "document"}</span>}
                  <button onClick={() => setChatAttachments((x) => x.filter((_, j) => j !== i))} title="Remove" style={{ position: "absolute", top: 2, right: 2, width: 16, height: 16, borderRadius: 8, border: "none", background: "rgba(0,0,0,0.65)", color: "#fff", fontSize: 11, lineHeight: 1, cursor: "pointer", padding: 0 }}>×</button>
                </div>
              ))}
            </div>
          )}
          {/* One composer card rather than a bare edge-to-edge row, aligned to
              the same reading column as the transcript. */}
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", background: "var(--bg-input)", border: "1px solid var(--border-strong)", borderRadius: 14, padding: 6 }}>
            <input ref={chatFileRef} type="file" accept={CHAT_ATTACHMENT_ACCEPT} multiple style={{ display: "none" }} onChange={(e) => { if (e.target.files) void addChatFiles(e.target.files); e.target.value = ""; }} />
            <button onClick={() => chatFileRef.current?.click()} title="Attach images or documents" style={{ ...btn, height: 34, width: 34, justifyContent: "center", padding: 0, fontSize: 15, borderRadius: 10, background: "transparent", border: "none", color: "var(--fg-muted)" }}>📎</button>
            <textarea
              value={chatDraft}
              onChange={(e) => setChatDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
              onPaste={onChatPaste}
              placeholder="Message…  (paste or attach images/documents, Enter to send)"
              rows={1}
              style={{ flex: 1, resize: "none", minHeight: 34, maxHeight: 200, background: "transparent", border: "none", outline: "none", color: "var(--fg)", fontSize: "var(--chat-font-size, 13px)", padding: "8px 4px", lineHeight: 1.5 }}
            />
            {chatBusy ? (
              <button onClick={() => { justChatAbort?.abort(); void invoke("cli_cancel_all").catch(() => { /* best-effort */ }); }} style={{ ...btn, height: 34, padding: "0 14px", borderRadius: 10, color: "var(--error)" }}>Stop</button>
            ) : (
              <button onClick={sendChat} disabled={!chatDraft.trim() && chatAttachments.length === 0} style={{ ...btn, height: 34, padding: "0 16px", borderRadius: 10, fontWeight: 700, background: "var(--accent)", color: "var(--accent-fg)", border: "none", opacity: (chatDraft.trim() || chatAttachments.length) ? 1 : 0.5 }}>Send</button>
            )}
          </div>
          </div>
        </div>
        {/* This branch returns EARLY, so the project-scoped modal further down
            never mounts here — the chat needs its own instance to answer the
            same event with this thread's scope. */}
        <TeamMemoryModal
          openEvent="owllm:open-code-memory"
          projectId={chatMemoryScope(chatId) || null}
          projectName={chats.find((c) => c.id === chatId)?.title || "Chat"}
        />
      </div>
    );
  }

  // ---- Onboarding: no folder open -----------------------------------------
  // The coding agent does nothing without a workspace, so instead of showing
  // the full (dead) IDE chrome that silently ignores input, show a real
  // get-started screen: open a folder, or reopen a recent project.
  if (!workspace && !preparing) {
    return (
      <div data-ui="CodingProjectHub" style={{ padding: "8px 10px 10px", height: "100%", display: "flex", flexDirection: "column", background: "var(--bg-panel)", color: "var(--fg)" }}>
        <div style={{ flex: 1, minHeight: 0, display: "flex", justifyContent: "center", overflowY: "auto" }}>
          <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 30, padding: "36px 36px" }}>
            <div>
              <div style={{ color: "var(--accent-ink)", fontSize: 12, fontWeight: 900, letterSpacing: 1.8, textTransform: "uppercase" }}>Portable coding command center</div>
              <div style={{ fontSize: "clamp(30px,4vw,48px)", fontWeight: 850, color: "var(--fg-strong)", letterSpacing: -0.8, lineHeight: 1.05, marginTop: 7 }}>OwLLM Coding</div>
              <div style={{ fontSize: 13.5, color: "var(--fg-muted)", marginTop: 5, lineHeight: 1.5 }}>
                GitHub is the project identity. Each computer creates its own local clone; OwLLM never reuses another PC's absolute folder.
              </div>
            </div>

            <div data-ui="GitHubConnectionStatus" style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", padding: "14px 16px", borderRadius: 15, border: `1px solid ${gh?.connected ? "rgba(77,224,155,.58)" : "rgba(255,105,120,.58)"}`, background: gh?.connected ? "linear-gradient(120deg,rgba(77,224,155,.15),var(--bg-card))" : "linear-gradient(120deg,rgba(255,105,120,.13),var(--bg-card))", boxShadow: gh?.connected ? "0 0 34px rgba(77,224,155,.10)" : "0 0 34px rgba(255,105,120,.08)" }}>
              <span aria-hidden="true" style={{ width: 12, height: 12, borderRadius: 999, background: gh?.connected ? "#4de09b" : "#ff6978", boxShadow: gh?.connected ? "0 0 14px rgba(77,224,155,.9)" : "0 0 14px rgba(255,105,120,.8)" }} />
              <div style={{ flex: 1, minWidth: 260 }}>
                <b style={{ color: "var(--fg-strong)", fontSize: 14 }}>{gh?.connected ? `GitHub connected as ${gh.login}` : "GitHub not connected"}</b>
                <div style={{ color: "var(--fg-muted)", fontSize: 11.5, lineHeight: 1.5, marginTop: 3 }}>{gh?.connected ? "Repository access is ready for imports, managed projects and sandbox pushes." : "Public repositories can still be imported. Connect GitHub for private repositories and pushes."}</div>
              </div>
              <button onClick={() => { if (gh?.connected) void disconnectGithub(); else { setGhOpen((v) => !v); setGhMsg(""); } }} disabled={ghBusy} style={{ border: "none", background: "transparent", color: gh?.connected ? "#4de09b" : "#ff8792", fontSize: 11.5, fontWeight: 750, cursor: ghBusy ? "wait" : "pointer", textDecoration: "underline", padding: 4 }}>{gh?.connected ? "Disconnect" : "Connect GitHub"}</button>
            </div>

            <div data-ui="CodingProjectColumns" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", alignItems: "start", gap: 22, width: "100%", minWidth: 0 }}>
            <section style={{ gridColumn: 2, gridRow: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: "var(--fg-strong)", flex: 1 }}>Managed projects</div>
                <span style={{ color: "var(--fg-subtle)", fontSize: 11 }}>{deviceIdentity.name}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr)", gap: 13 }}>
                {catalogProjects.map((project) => {
                  const local = projectAvailability(project) === "local";
                  const selectedGhost = ghostProjectId === project.id && !local;
                  return (
                    <button key={project.id} onClick={() => { void openCatalogProject(project); }} disabled={catalogBusy} style={{
                      minHeight: 150, padding: 16, borderRadius: 15, textAlign: "left",
                      border: `1px solid ${selectedGhost ? "var(--warn)" : local ? "var(--border)" : "var(--border-strong)"}`,
                      background: selectedGhost ? "rgba(var(--warn-rgb),.09)" : "var(--bg-card)",
                      opacity: local ? 1 : .58, filter: local ? "none" : "saturate(.55)",
                      cursor: catalogBusy ? "wait" : "pointer", boxShadow: local ? "0 10px 28px rgba(0,0,0,.12)" : "none",
                    }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span style={{ fontSize: 21 }}>{local ? "⌁" : "◌"}</span>
                        <b style={{ color: "var(--fg-strong)", fontSize: 15, flex: 1 }}>{project.name}</b>
                        <span style={{ color: local ? "var(--ok)" : "var(--warn)", fontSize: 10, fontWeight: 900 }}>{local ? "READY" : "GHOSTED"}</span>
                      </div>
                      <div style={{ color: "var(--fg-muted)", fontSize: 11.5, lineHeight: 1.45, marginTop: 9 }}>
                        {local ? project.location : `Created on ${projectOriginLabel(project)} · no local folder on ${deviceIdentity.name}`}
                      </div>
                      <div style={{ color: project.repo_url ? "var(--accent-ink)" : "var(--warn)", fontSize: 11, marginTop: 9 }}>
                        {project.repo_url ? `🐙 ${project.repo_url.replace(/^https?:\/\//, "")}` : "No GitHub repo · available only on its creator PC"}
                      </div>
                      {!local && <div style={{ color: "var(--fg-strong)", fontSize: 11.5, fontWeight: 750, marginTop: 10 }}>{project.repo_url ? "Click to clone into a new folder on this PC →" : "Create the repo on the source PC before opening here"}</div>}
                    </button>
                  );
                })}
                {catalogProjects.length === 0 && <div style={{ padding: 20, border: "1px dashed var(--border-strong)", borderRadius: 14, color: "var(--fg-muted)", fontSize: 12.5 }}>No managed projects yet. Create one or open an existing GitHub checkout below.</div>}
              </div>
              {catalogError && <div style={{ color: "var(--error)", fontSize: 12, marginTop: 9 }}>{catalogError}</div>}
            </section>
            <div style={{ gridColumn: 1, gridRow: 1, display: "flex", flexDirection: "column", gap: 24, width: "100%", minWidth: 0 }}>
              {/* START — VS Code-style action rows */}
              <div style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: "var(--fg-strong)", marginBottom: 10 }}>Local actions</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 10, width: "100%", alignItems: "stretch" }}>
                  {/* LEFT — the two project actions, stacked. Deliberately the
                      quieter violet card: opening a folder is the occasional
                      task, chatting is the daily one. */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
                    {([
                      { icon: "✦", label: "New project", detail: "Create or bind a folder, optionally with isolation and a GitHub repository.", onClick: openNewProject },
                      { icon: "⌁", label: "Open local folder", detail: "Turn an existing folder into a project binding on this computer.", onClick: pickWorkspace },
                    ]).map((a) => (
                      <button key={a.label} onClick={a.onClick}
                        style={{ flex: 1, minHeight: 118, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8, minWidth: 0, padding: 14, borderRadius: 14, cursor: "pointer", textAlign: "left", color: "var(--fg)", border: "1px solid rgba(154,140,255,.34)", background: "radial-gradient(circle at 100% 0%,rgba(154,140,255,.15),transparent 52%),var(--bg-card)", boxShadow: "inset 0 1px 0 rgba(255,255,255,.04),0 10px 26px rgba(0,0,0,.12)" }}>
                        <span style={{ fontSize: 20, color: "#b9aeff", textShadow: "0 0 14px rgba(154,140,255,.75)" }}>{a.icon}</span>
                        <span style={{ color: "var(--fg-strong)", fontWeight: 800, fontSize: 13.5 }}>{a.label}</span>
                        <span style={{ color: "var(--fg-muted)", fontSize: 11, lineHeight: 1.45 }}>{a.detail}</span>
                      </button>
                    ))}
                  </div>

                  {/* RIGHT — the everyday chat. Full height of the left column,
                      mint (the assistant colour used in every chat bubble) so
                      the daily-use surface reads as the primary one, with its
                      recent conversations listed inline the way ChatGPT/Claude
                      do it — no extra click through a History dropdown. */}
                  <div data-ui="NormalChatCard" style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0, padding: 16, borderRadius: 14, border: "1px solid rgba(127,240,197,.42)", background: "radial-gradient(circle at 100% 0%,rgba(127,240,197,.16),transparent 55%),var(--bg-card)", boxShadow: "inset 0 1px 0 rgba(255,255,255,.05),0 12px 30px rgba(0,0,0,.16)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      <span style={{ fontSize: 21, color: "#7ff0c5", textShadow: "0 0 15px rgba(127,240,197,.8)" }}>💬</span>
                      <b style={{ color: "var(--fg-strong)", fontSize: 15 }}>Normal chat</b>
                      <span style={{ fontSize: 9.5, fontWeight: 900, letterSpacing: 1, textTransform: "uppercase", color: "#7ff0c5", border: "1px solid rgba(127,240,197,.45)", borderRadius: 999, padding: "2px 7px" }}>Everyday</span>
                    </div>
                    <div style={{ color: "var(--fg-muted)", fontSize: 11.5, lineHeight: 1.5 }}>
                      Ask anything — no folder, no setup. Each conversation keeps its own memory, so it remembers what you told it.
                    </div>
                    <button onClick={startNewChat}
                      style={{ height: 40, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, borderRadius: 10, cursor: "pointer", fontWeight: 800, fontSize: 13, border: "none", background: "linear-gradient(135deg,#7ff0c5,#4de09b)", color: "#04241a", boxShadow: "0 8px 20px rgba(77,224,155,.25)" }}>
                      ＋ New conversation
                    </button>
                    {/* Recent conversations — the SAME persisted thread list the
                        chat surface uses (owllm:code:chats), so this is a second
                        view of it, not a second store. */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 2 }}>
                      <span style={{ fontSize: 10, fontWeight: 900, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--fg-subtle)" }}>Recent conversations</span>
                      {chats.length > 0 && <span style={{ fontSize: 10.5, color: "var(--fg-subtle)" }}>{chats.length}</span>}
                    </div>
                    <div data-ui="RecentChatList" style={{ display: "flex", flexDirection: "column", gap: 5, minHeight: 0, maxHeight: 268, overflowY: "auto", paddingRight: 2 }}>
                      {chats.length === 0 && (
                        <div style={{ fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.5, padding: "8px 2px" }}>
                          No conversations yet — start one above and it will be listed here.
                        </div>
                      )}
                      {chats.map((c) => (
                        <div key={c.id} onClick={() => openThread(c.id)} title={c.title || "Chat"}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(127,240,197,.09)")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = "var(--bg-input)")}
                          style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 9, cursor: "pointer", background: "var(--bg-input)", border: "1px solid var(--border)" }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12.5, fontWeight: 650, color: "var(--fg-strong)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.title || "Chat"}</div>
                            <div style={{ fontSize: 10, color: "var(--fg-subtle)", marginTop: 2 }}>{fmtAgo(c.ts)} · {c.messages.length} message{c.messages.length === 1 ? "" : "s"}</div>
                          </div>
                          <button onClick={(e) => { e.stopPropagation(); deleteThread(c.id); }} title="Delete conversation and its memory"
                            style={{ ...btn, height: 22, padding: "0 6px", color: "var(--fg-muted)", fontSize: 11 }}>✕</button>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div data-ui="ImportFromGitHubCard" style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 9, minWidth: 0, padding: 15, borderRadius: 14, border: "1px solid rgba(126,231,255,.38)", background: "radial-gradient(circle at 100% 0%,rgba(126,231,255,.16),transparent 48%),var(--bg-card)", boxShadow: "inset 0 1px 0 rgba(255,255,255,.04),0 10px 28px rgba(0,0,0,.14)" }}>
                    <div style={{ display: "flex", gap: 9, alignItems: "center" }}><span style={{ color: "#7ee7ff", fontSize: 20, textShadow: "0 0 14px rgba(126,231,255,.8)" }}>⇣</span><b style={{ color: "var(--fg-strong)", fontSize: 13.5 }}>Import from GitHub</b></div>
                    <div style={{ color: "var(--fg-muted)", fontSize: 11, lineHeight: 1.45 }}>
                      {gh?.connected
                        ? `Choose one of @${gh.login}'s GitHub repositories, then choose the local folder where this PC should clone it.`
                        : "Sign in with GitHub to choose from your repositories. Public URL import stays available as a fallback."}
                    </div>
                    {gh?.connected ? (
                      <div data-ui="GitHubRepositoryPicker" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <select value={selectedGithubRepo} onChange={(e) => setSelectedGithubRepo(e.target.value)} disabled={githubReposBusy || githubRepos.length === 0} aria-label="GitHub repository" style={{ flex: 1, minWidth: 0, height: 34, padding: "0 10px", borderRadius: 8, border: "1px solid var(--border-strong)", background: "var(--bg-surface)", color: "var(--fg)", fontSize: 12 }}>
                            {githubRepos.length === 0 && <option value="">{githubReposBusy ? "Loading GitHub repositories..." : "No repositories found"}</option>}
                            {githubRepos.map((repo) => (
                              <option key={repo.fullName} value={repo.fullName}>{repo.fullName}{repo.private ? " (private)" : ""}</option>
                            ))}
                          </select>
                          <button onClick={refreshGithubRepositories} disabled={githubReposBusy} style={{ ...btn, height: 34, padding: "0 11px", color: "#7ee7ff" }}>{githubReposBusy ? "Loading..." : "Refresh"}</button>
                        </div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <button onClick={() => void importGithubProject()} disabled={importBusy || !selectedGithubRepo} style={{ ...btn, height: 34, padding: "0 13px", borderColor: "rgba(126,231,255,.5)", color: "#7ee7ff", opacity: importBusy || !selectedGithubRepo ? .5 : 1 }}>{importBusy ? "Importing..." : "Choose folder & import selected repo"}</button>
                          <button onClick={() => openWebUrl(`https://github.com/${gh.login}?tab=repositories`).catch(() => {})} style={{ ...btn, height: 34, padding: "0 11px", color: "var(--fg-muted)" }}>Open GitHub repositories</button>
                        </div>
                      </div>
                    ) : (
                      <div data-ui="SignedOutGithubImport" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <button onClick={openSyncOnboarding} style={{ ...btn, height: 34, justifyContent: "center", borderColor: "rgba(126,231,255,.5)", color: "#7ee7ff" }}>Sign in with GitHub to select a repository</button>
                        <div style={{ display: "flex", gap: 8 }}>
                          <input value={importRepoUrl} onChange={(e) => setImportRepoUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void importGithubProject(); }} placeholder="Public fallback: https://github.com/owner/repository" aria-label="Public GitHub repository URL" style={{ flex: 1, minWidth: 0, height: 34, padding: "0 10px", borderRadius: 8, border: "1px solid var(--border-strong)", background: "var(--bg-surface)", color: "var(--fg)", fontSize: 12 }} />
                          <button onClick={() => void importGithubProject()} disabled={importBusy || !importRepoUrl.trim()} style={{ ...btn, height: 34, padding: "0 13px", color: "var(--fg-muted)", opacity: importBusy || !importRepoUrl.trim() ? .5 : 1 }}>{importBusy ? "Importing..." : "Import public URL"}</button>
                        </div>
                      </div>
                    )}
                    {importMsg && <div style={{ color: importMsg.startsWith("Import failed") ? "var(--error)" : "var(--fg-muted)", fontSize: 10.5, lineHeight: 1.4 }}>{importMsg}</div>}
                  </div>
                </div>
                {/* GitHub connect form (inline, opens under the row) */}
                {ghOpen && !gh?.connected && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8, maxWidth: 520, padding: "10px 12px", background: "var(--bg-input)", border: "1px solid var(--border-strong)", borderRadius: 8 }}>
                    <div style={{ fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.5 }}>Paste a GitHub token so agents can clone private repos and push from inside the sandbox.</div>
                    <button onClick={() => { openWebUrl(GITHUB_TOKEN_URL).catch(() => {}); }} style={{ ...btn, height: 28, justifyContent: "center", color: "var(--accent-ink)" }}>↗ Create a token (repo scope)</button>
                    <input type="password" value={ghToken} onChange={(e) => setGhToken(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") connectGithub(); }} placeholder="ghp_… or github_pat_…" style={{ height: 32, background: "var(--bg-surface)", border: "1px solid var(--border-strong)", borderRadius: 6, color: "var(--fg)", fontSize: 13, padding: "0 10px" }} />
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={connectGithub} disabled={ghBusy || !ghToken.trim()} style={{ ...btn, height: 32, flex: 1, justifyContent: "center", fontWeight: 700, background: "var(--accent)", color: "var(--accent-fg)", border: "none", opacity: ghBusy || !ghToken.trim() ? 0.6 : 1 }}>{ghBusy ? "⏳ Connecting…" : "Connect"}</button>
                      <button onClick={() => { setGhOpen(false); setGhMsg(""); }} disabled={ghBusy} style={{ ...btn, height: 32, padding: "0 12px", color: "var(--fg-muted)" }}>Cancel</button>
                    </div>
                  </div>
                )}
                {ghMsg && <div style={{ marginTop: 6, fontSize: 11, color: ghMsg.startsWith("✓") || ghMsg.startsWith("Disconnected") ? "#7ff0c5" : "var(--fg-muted)" }}>{ghMsg}</div>}
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
              <div style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
                <div style={{ fontSize: 19, fontWeight: 300, color: "var(--fg-strong)", marginBottom: 8 }}>Projects</div>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr)", gap: 8, maxHeight: 420, overflowY: "auto", paddingRight: 2 }}>
                  {orderedRecents.length === 0 && (!isolation.enabled || sboxProjects.filter(p => !recents.includes(p.path)).length === 0) && (
                    <div style={{ gridColumn: "1 / -1", fontSize: 12, color: "var(--fg-muted)" }}>No projects yet — use Local actions above to get started.</div>
                  )}
                  {/* Isolated projects that aren't already in recents */}
                  {isolation.enabled && sboxProjects.filter((p) => !recents.includes(p.path)).map((p) => (
                    <button
                      key={p.path}
                      onClick={() => openWorkspace(p.path)}
                      title={p.innerPath}
                        style={{ display: "block", minWidth: 0, textAlign: "left", background: "var(--bg-input)", border: "1px solid var(--border-strong)", borderRadius: 8, padding: "8px 10px", color: "var(--fg)", cursor: "pointer" }}
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
                        style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 8, background: "var(--bg-input)", border: `1px solid ${pinned ? "var(--accent)" : "var(--border-strong)"}`, borderRadius: 8, padding: "8px 10px" }}
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
                        <button onClick={() => togglePin(ws)} title={pinned ? "Unpin" : "Pin to top"} style={{ ...btn, height: 26, padding: "0 8px", color: pinned ? "var(--accent-ink)" : "var(--fg-muted)" }}>📌</button>
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
                  style={{ height: 38, padding: "0 22px", border: "none", borderRadius: 9, background: "var(--accent)", color: "var(--accent-fg)", fontWeight: 700, fontSize: 14, cursor: npBusy ? "not-allowed" : "pointer", opacity: npBusy || (!npIsolate && !npFolder.trim()) ? 0.6 : 1 }}
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
      {/* Rainbow agent "aura": a conic-gradient ring painted on each chat
          pane's border-box (spun by the --owllm-aura-angle @property, shared
          with the Agents page). The pane's solid fill sits on padding-box so
          the message/input area keeps its background — the glow reads only
          OUTSIDE the container. Houdini-less browsers fall back to a static
          rainbow, still on-brand. */}
      <style>{`
        @property --owllm-aura-angle { syntax: "<angle>"; initial-value: 0deg; inherits: false; }
        @keyframes owllm-aura-spin { to { --owllm-aura-angle: 360deg; } }
      `}</style>
      {/* Header: workspace · model · status */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={closeProject} disabled={busy} title="Back to the project list (your files stay on disk)" style={btn}>← Projects</button>
        <button onClick={pickWorkspace} disabled={busy} title={workspace ? `Current: ${workspace}\nClick to switch to another folder` : "Open a project folder"} style={{ ...btn, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis" }}>📁 {wsShort} ⇄</button>
        <span title={`This chat was created on ${stx.createdDeviceName || deviceIdentity.name}. Its active folder belongs only to this computer.`} style={{ fontSize: 10.5, fontWeight: 750, color: "var(--fg-muted)", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 7, padding: "4px 7px", whiteSpace: "nowrap" }}>
          🖥 {stx.createdDeviceName || deviceIdentity.name}
        </span>
        {stx.repoUrl && <span title={stx.repoUrl} style={{ fontSize: 10.5, fontWeight: 750, color: "var(--accent-ink)", whiteSpace: "nowrap" }}>🐙 GitHub</span>}
        {/* Per-page rename — tab shows "folder(rename)" so two pages on the
            same project stay tellable apart. Empty = folder name only. */}
        <input
          value={stx.pageRename ?? ""}
          onChange={(e) => setField("pageRename", e.target.value)}
          onBlur={(e) => setField("pageRename", e.target.value.trim() || undefined)}
          placeholder="Rename page…"
          title={`Optional page name — the tab shows ${wsShort}(name), e.g. ${wsShort}(GUI_fix). Leave empty to show the folder name only.`}
          style={{ ...btn, width: 110, padding: "0 8px", cursor: "text", fontWeight: 500, background: "var(--bg-input)" }}
        />
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
        <button onClick={clearWorkspace} disabled={busy || (tasks.length === 0 && draft === "" && secondaryDraft === "" && runStartedAt == null && runEndedAt == null)} title="Clear the current run (tasks, drafts and run state) but keep the chat" style={btn}>Clear</button>
        {/* Clear history is now PER AGENT — each pane's own button lives in that
            pane's header (below), with an independent ↩ Undo. */}
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
            <button
              data-ui="CodeProjectMemory"
              onClick={() => { void openProjectMemory(); }}
              title="Project Memory — the same shared facts and worklog used by this project's Agents page and synced through the vault."
              style={{ ...btn, width: "100%", height: 30, marginBottom: 4, justifyContent: "flex-start", color: "var(--accent-ink)", borderColor: "rgba(var(--accent-rgb),0.42)" }}
            >
              🧠 Project Memory
            </button>
            <TreeDir path={workspace} name={wsShort} depth={0} defaultOpen onOpenFile={openFile} />
            <PublishCards
              repoDir={projectRoot || workspace}
              gitDir={workspace}
              branch={branch}
              projectRoot={projectRoot}
              isolated={isolated}
              disabled={busy}
              // Failed release actions become a coder task; send() queues it
              // as a ⚡ steer when a run is already in flight. Pre-check the
              // guards send() would trip so the card reports the truth instead
              // of claiming "sent" while the task was silently dropped.
              onFixIssues={(task) => {
                if (busySendRef.current) { void sendRef.current?.(task); return "queued"; }
                if (!workspace) return "no-workspace";
                if (!modelId) { setStatus("No model selected — pick one in the Coder header."); return "no-model"; }
                void sendRef.current?.(task);
                return "sent";
              }}
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
        {/* Primary pane — same box anatomy as the second-agent pane: each header
            owns its agent name, wide model picker, feed control and history
            actions. No separate page-level agent-control row. */}
        <div style={{
          flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", gap: 8, padding: 12,
          // Solid fill on padding-box keeps the message/input area's background;
          // the rainbow ring paints border-box only, so the aura reads OUTSIDE
          // the chat container. It exists only while this coder is running.
          background: primaryAuraActive ? PSYCHEDELIC_AURA_BACKGROUND : "var(--bg-input)",
          border: primaryAuraActive ? "2px solid transparent" : "1px solid var(--border)", borderRadius: 8,
          boxShadow: primaryAuraActive ? PSYCHEDELIC_AURA_HALO : undefined,
          animation: primaryAuraActive ? PSYCHEDELIC_AURA_ANIMATION : undefined,
        }}>
          <div data-ui="code-primary-agent-header" style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--fg-muted)" }}>Coder</span>
            {secondaryOpen && (
              <label title="When the 1st agent finishes a reply, automatically feed it to the 2nd agent as its next turn." style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, color: feedPrimaryToSecondary ? "#7ff0c5" : "var(--fg-muted)", cursor: "pointer", whiteSpace: "nowrap" }}>
                <input type="checkbox" checked={feedPrimaryToSecondary} onChange={(e) => setFeedPrimaryToSecondary(e.target.checked)} />
                ⇄ to 2nd
              </label>
            )}
            <span style={{ flex: 1 }} />
            {primaryUndo && (
              <button onClick={undoPrimaryHistory} title="Restore the messages you just cleared" style={{ ...btn, height: 24, padding: "0 10px", fontSize: 11, color: "var(--fg-muted)" }}>↩ Undo</button>
            )}
            <button onClick={clearPrimaryHistory} disabled={busy || messages.length === 0} title="Clear this agent's conversation (undoable)" style={{ ...btn, height: 24, padding: "0 10px", fontSize: 11, color: "var(--fg-muted)" }}>Clear history</button>
            {!secondaryOpen && (
              <button
                onClick={() => setSecondaryOpen(true)}
                title="Open a second independent agent chat for this workspace"
                style={{ ...btn, height: 24, padding: "0 10px", fontSize: 11, color: "var(--fg-muted)", whiteSpace: "nowrap" }}
              >
                + 2nd agent
              </button>
            )}
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
            // Page-generated notices (timing footer, auto-feed pause) are not
            // agent answers: muted line, no bubble, no Forward button.
            if (m.kind === "meta") {
              return (
                <div key={i} style={{ alignSelf: "center", textAlign: "center", color: "var(--fg-muted)", fontSize: 11.5, padding: "2px 8px" }}>
                  {m.content}
                </div>
              );
            }
            if (m.role === "tool") {
              return <ToolEventCard key={i} kind={m.kind ?? "tool"} title={m.title ?? "tool"} status={m.status} content={m.content} />;
            }
            const isUser = m.role === "user";
            const isStreaming = busy && i === messages.length - 1 && m.role === "assistant";
            // Forward targets the last real answer — trailing meta notices
            // (e.g. the run timing footer) must not steal the button.
            const canForward = m.role === "assistant" && !m.kind && !isStreaming && !!m.content?.trim() && messages.slice(i + 1).every((n) => n.kind === "meta");
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
                  images={m.images}
                />
                {canForward && (
                  <div style={{ display: "flex", justifyContent: "flex-end", paddingRight: 4 }}>
                    <button
                      onClick={() => {
                        setSecondaryOpen(true);
                        forwardToDraft(setSecondaryDraft, secondaryDraftRef, `Forwarded from primary agent:\n\n${m.content}`);
                      }}
                      title="Forward this reply into the second agent's composer to edit before sending"
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
          <div style={{
            flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", gap: 8, padding: 12,
            // Same rainbow aura as the primary pane: rainbow ring on border-box,
            // solid var(--bg-input) fill on padding-box so the message/input
            // area stays solid. Spins while the second agent is running.
            background: secondaryBusy ? PSYCHEDELIC_AURA_BACKGROUND : "var(--bg-input)",
            border: secondaryBusy ? "2px solid transparent" : "1px solid var(--border)", borderRadius: 8,
            boxShadow: secondaryBusy ? PSYCHEDELIC_AURA_HALO : undefined,
            animation: secondaryBusy ? PSYCHEDELIC_AURA_ANIMATION : undefined,
          }}>
            <div data-ui="code-secondary-agent-header" style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--fg-muted)" }}>Second agent</span>
              <label title="When the 2nd agent finishes a reply, automatically feed it to the 1st agent as its next turn." style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, color: feedSecondaryToPrimary ? "#c7a8ff" : "var(--fg-muted)", cursor: "pointer", whiteSpace: "nowrap" }}>
                <input type="checkbox" checked={feedSecondaryToPrimary} onChange={(e) => setFeedSecondaryToPrimary(e.target.checked)} />
                ⇄ to 1st
              </label>
              <span style={{ flex: 1 }} />
              {secondaryUndo && (
                <button onClick={undoSecondaryHistory} title="Restore the messages you just cleared" style={{ ...btn, height: 24, padding: "0 8px", fontSize: 11, color: "var(--fg-muted)" }}>↩ Undo</button>
              )}
              <button onClick={clearSecondaryHistory} disabled={secondaryBusy || secondaryMessages.length === 0} title="Clear this agent's conversation (undoable)" style={{ ...btn, height: 24, padding: "0 8px", fontSize: 11, color: "var(--fg-muted)" }}>Clear history</button>
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
                if (m.kind === "meta") {
                  return (
                    <div key={i} style={{ alignSelf: "center", textAlign: "center", color: "var(--fg-muted)", fontSize: 11.5, padding: "2px 8px" }}>
                      {m.content}
                    </div>
                  );
                }
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
                      images={m.images}
                    />
                    {canForwardToPrimary && (
                      <div style={{ display: "flex", justifyContent: "flex-end", paddingRight: 4 }}>
                        <button
                          onClick={() => {
                            forwardToDraft(setDraft, codeDraftRef, `Forwarded from second agent:\n\n${m.content}`);
                          }}
                          title="Forward this reply into the primary agent's composer to edit before sending"
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

      {/* Docked terminal — a real PTY shell in the workspace, sitting right
          above the message box (user spec). Same shell as the popup; ⤢ moves
          it out to the floating window. Kept mounted while hidden so the shell
          survives a hide/show. */}
      {termOpen && workspace && termDocked && (
        <div style={{ display: termHidden ? "none" : "flex", flexDirection: "column", height: 240, flexShrink: 0,
          background: "var(--bg-panel)", border: "1px solid var(--border-strong)", borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", borderBottom: "1px solid var(--border)", userSelect: "none" }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)" }}>🖥 Terminal — {wsShort}</span>
            <span style={{ flex: 1 }} />
            <button className="ghost-btn" onClick={() => setTermDocked(false)} title="Pop out to a floating window" style={{ height: 24, width: 26, padding: 0, fontSize: 13 }}>⤢</button>
            <button className="ghost-btn" onClick={() => setTermHidden(true)} title="Hide (shell keeps running — reopen from the ⌨ Terminal button)" style={{ height: 24, width: 26, padding: 0, fontSize: 13 }}>—</button>
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
        onDrop={(e) => { const files = Array.from(e.dataTransfer?.files ?? []); if (files.length) { e.preventDefault(); void addCodeFiles(files); } }}
        style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}
      >
        {/* Each agent owns a toolbar immediately above — and exactly aligned
            with — its own textarea. Both Terminal buttons address the same
            workspace shell; the model selections remain independent. */}
        <div data-ui="CodePrimaryComposerToolbar" style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <div style={status.includes("\n")
            ? { flex: 1, minWidth: 0, fontSize: 11, color: "var(--fg-muted)", whiteSpace: "pre-line", lineHeight: 1.6 }
            : { flex: 1, minWidth: 0, fontSize: 11, color: "var(--fg-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{status}</div>
          <span style={{ fontSize: 11, color: "var(--fg-muted)", flexShrink: 0 }}>Model</span>
          <div data-ui="CodePrimaryComposerModelPicker" style={{ width: "min(300px, 48%)", minWidth: 180 }}>
            <ModelPicker
              value={modelId}
              onChange={setModelId}
              models={availableModels}
              status={accountsStatus}
              disabled={busy}
              fallbackLabel="(pick a model)"
              placement="top"
            />
          </div>
          {renderTerminalButton("primary")}
        </div>
        {codeAttachments.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {codeAttachments.map((attachment, i) => (
              <div key={i} style={{ position: "relative", minWidth: attachment.kind === "image" ? 48 : 150, height: 48, borderRadius: 6, overflow: "hidden", border: "1px solid var(--border-strong)", background: "var(--bg-input)", display: "flex", alignItems: "center", justifyContent: "center", padding: attachment.kind === "image" ? 0 : "0 24px 0 10px", boxSizing: "border-box", color: "var(--fg)", fontSize: 11, fontWeight: 700 }}>
                {attachment.kind === "image" ? <img src={`data:${attachment.mime};base64,${attachment.data_b64}`} alt={attachment.filename} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span>📄 {attachment.filename ?? "document"}</span>}
                <button onClick={() => setCodeAttachments((x) => x.filter((_, j) => j !== i))} title="Remove" style={{ position: "absolute", top: 2, right: 2, width: 16, height: 16, borderRadius: 8, border: "none", background: "rgba(0,0,0,0.65)", color: "#fff", fontSize: 11, lineHeight: 1, cursor: "pointer", padding: 0 }}>×</button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <input ref={codeFileRef} type="file" accept={CHAT_ATTACHMENT_ACCEPT} multiple style={{ display: "none" }}
                 onChange={(e) => { if (e.target.files) void addCodeFiles(e.target.files); e.target.value = ""; }} />
          <button onClick={() => codeFileRef.current?.click()} title="Attach images or documents" style={{ ...btn, height: 44, padding: "0 12px" }}>📎</button>
          <textarea
            ref={codeDraftRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => { const files = Array.from(e.clipboardData?.files ?? []); if (files.length) { e.preventDefault(); void addCodeFiles(files); } }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (agentMode === "plan" && !busy) { void planAndExecute(); } else { void send(); } } }}
            placeholder={preparing ? "Type your request while the workspace finishes preparing…" : workspace ? (agentMode === "chat" ? "Ask, discuss, review — nothing is modified in chat mode…" : "Describe the change, bug, or feature… (paste/drop images too)") : "Pick a workspace folder first…"}
            rows={3}
            style={{ flex: 1, resize: "vertical", minHeight: 82, maxHeight: 142, padding: 10, background: "var(--bg-input)", border: "1px solid var(--border-strong)", borderRadius: 8, color: "var(--fg)", fontSize: "var(--chat-font-size, 13px)", lineHeight: 1.5, fontFamily: "inherit", boxSizing: "border-box" }}
          />
          {busy ? (
            <button onClick={stop} style={{ ...btn, background: "rgba(180,60,60,0.85)", color: "#fff", border: "none", height: 44, padding: "0 16px" }}>Stop</button>
          ) : (
            /* One primary button — what it does follows the right-column MODE:
               plan → Kanban plan/act, auto → act directly, chat → discuss only. */
            <button
              onClick={() => { if (agentMode === "plan") { void planAndExecute(); } else { void send(); } }}
              disabled={(!draft.trim() && (agentMode === "plan" || codeAttachments.length === 0)) || preparing}
              title={preparing ? "Preparing the workspace — unlocks in a moment"
                : agentMode === "plan" ? "Break the goal into ordered steps, then build them one by one (Kanban)"
                : agentMode === "chat" ? "Discuss/review only — no edits, no state-changing commands"
                : "Act directly — read, edit and run in the workspace"}
              style={{ ...btn, background: "var(--accent)", color: "var(--accent-fg)", border: "none", height: 44, padding: "0 16px", fontWeight: 700, opacity: ((draft.trim() || (agentMode !== "plan" && codeAttachments.length)) && !preparing) ? 1 : 0.5 }}
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
          above THIS app's UI only (fixed overlay, no OS always-on-top). Only
          when popped out (⤢); the docked variant renders above the composer. */}
      {termOpen && workspace && !termDocked && (
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

      {/* 🧠 Project Memory — the SAME shared surface the Agents page opens,
          scoped by the SAME id both code agents use for memory (memoryScope():
          ruleScope.id ?? projectRoot ?? workspace), so what you see here is
          exactly what the primary and secondary code agents read and write.
          Opens on the page-scoped event from the header 🧠 Memory button. */}
      <TeamMemoryModal
        openEvent="owllm:open-code-memory"
        projectId={ruleScope.id || null}
        projectName={(projectRoot || workspace || "").replace(/^.*[\\/]/, "") || undefined}
      />

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
  useEffect(() => {
    const openSavedProjectPages = (event: Event) => {
      const detail = (event as CustomEvent<OpenProjectPagesDetail>).detail;
      if (!detail?.project?.location) return;
      const saved = savedPageMetasForLocalProject(detail.project);
      const target = chooseProjectOpenTarget(saved.map((page) => page.id), detail.currentPageIsBlank);
      if (target.kind === "current") return;
      detail.handled = true;
      setPages((current) => {
        const known = new Set(current.map((page) => page.id));
        return [...current, ...saved.filter((page) => !known.has(page.id))];
      });
      setActiveId(target.pageId);
    };
    window.addEventListener(OPEN_PROJECT_PAGES_EVENT, openSavedProjectPages);
    return () => window.removeEventListener(OPEN_PROJECT_PAGES_EVENT, openSavedProjectPages);
  }, []);

  const setTitle = (id: string, title: string) =>
    setPages((ps) => ps.map((p) => (p.id === id ? (p.title === title ? p : { ...p, title }) : p)));

  const newPage = () => {
    // A new page always starts on the generic Start/onboarding screen (user
    // spec 2026-07-11): pick or create any project — including the same one
    // again for a parallel worktree — or just chat. It no longer auto-clones
    // the active page's project.
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
          translateUiText(`Close this page? Its private worktree (${st.branch}) and any unmerged changes are removed. Merge first to keep them.`),
          { title: translateUiText("Close page"), kind: "warning" },
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
    pageActivity.clearDone(id);   // drop any lingering finished-badge for the closed page
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

  // ---- Per-page activity: glow the working tab, badge finished-while-away ----
  // Re-render the tab strip whenever any page's coder busy (chatRuntime, updates
  // even after the page unmounts) or the visible page's aggregate busy / badges
  // change. Subscribing per-page id also covers a run that outlives its tab.
  const [, setActivityTick] = useState(0);
  const bumpActivity = () => setActivityTick((n) => n + 1);
  useEffect(() => {
    const unsubs = pages.map((p) => chatRuntime.subscribe(sidForPage(p.id), bumpActivity));
    unsubs.push(pageActivity.subscribe(bumpActivity));
    return () => { for (const u of unsubs) u(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages.map((p) => p.id).join(",")]);

  // A page is "working" if its coder is busy (read straight from chatRuntime, so
  // background pages stay lit) OR the mounted page reports a second-agent/chat run.
  const pageWorking = (id: string): boolean => {
    const snap = chatRuntime.getSnapshot(sidForPage(id)).payload as CodeState | null;
    return !!snap?.busy || pageActivity.extraBusy(id);
  };

  // Badge a page whose run FINISHED while you were on another tab (busy→idle on a
  // non-active page); the active tab is always "seen", so it never carries a badge.
  const prevWorkingRef = useRef<Map<string, boolean>>(new Map());
  useEffect(() => {
    for (const p of pages) {
      const now = pageWorking(p.id);
      const was = prevWorkingRef.current.get(p.id) ?? false;
      if (was && !now && p.id !== active?.id) pageActivity.markDone(p.id);
      prevWorkingRef.current.set(p.id, now);
    }
    if (active) pageActivity.clearDone(active.id);
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg-panel)" }}>
      {/* Keyframes for the working-tab glow pulse (parent is always mounted). */}
      <style>{`
        @keyframes owllm-tab-working {
          0%, 100% {
            box-shadow:
              0 0 0 1px rgba(255,255,255,0.08),
              0 0 8px rgba(176,124,255,0.28),
              0 0 12px rgba(127,212,255,0.18);
          }
          50% {
            box-shadow:
              0 0 0 1px rgba(255,255,255,0.20),
              0 0 18px rgba(176,124,255,0.90),
              0 0 28px rgba(127,212,255,0.55);
          }
        }
      `}</style>
      {/* Tab strip */}
      <div style={{ display: "flex", alignItems: "center", gap: 2, padding: "5px 6px 0", flexShrink: 0, overflowX: "auto" }}>
        {pages.map((p) => {
          const on = p.id === active?.id;
          const working = pageWorking(p.id);   // an agent is running on this page
          const done = pageActivity.isDone(p.id); // finished while you were away
          return (
            <div
              key={p.id}
              onClick={() => setActiveId(p.id)}
              title={working ? `${p.title} — agent working…` : done ? `${p.title} — finished (unseen)` : p.title}
              style={{
                display: "flex", alignItems: "center", gap: 6, padding: "5px 10px",
                borderRadius: "7px 7px 0 0", cursor: "pointer", maxWidth: 200, flexShrink: 0,
                background: on ? "var(--bg-input)" : "transparent",
                border: "1px solid", borderColor: on ? "var(--border-strong)" : "transparent", borderBottom: "none",
                color: on ? "var(--fg-strong)" : "var(--fg-muted)", fontSize: 12, fontWeight: on ? 700 : 500,
                // Glow while an agent runs on this page — visible even from
                // another tab, so you can see WHERE work is happening.
                animation: working ? continuousUiAnimation("owllm-tab-working 1.4s ease-in-out infinite") : undefined,
              }}
            >
              {/* Live rainbow dot while working (matches the agentic aura). */}
              {working && (
                <span title="Agent working" style={{ flexShrink: 0, width: 8, height: 8, borderRadius: "50%", background: PSYCHEDELIC_AURA_DOT, boxShadow: "0 0 0 1px rgba(255,255,255,0.20), 0 0 8px rgba(176,124,255,0.85), 0 0 12px rgba(127,212,255,0.45)" }} />
              )}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title || "New page"}</span>
              {/* Finished-while-away badge (psychedelic check) — cleared when you open the page. */}
              {done && !working && (
                <span title="Finished — click to view" style={{
                  flexShrink: 0,
                  fontSize: 12,
                  fontWeight: 900,
                  lineHeight: 1,
                  color: "transparent",
                  background: PSYCHEDELIC_AURA_DOT,
                  WebkitBackgroundClip: "text",
                  backgroundClip: "text",
                  filter: "drop-shadow(0 0 5px rgba(176,124,255,0.85)) drop-shadow(0 0 8px rgba(127,212,255,0.45))",
                }}>✓</span>
              )}
              <span
                onClick={(e) => { e.stopPropagation(); void closePage(p.id); }}
                title="Close this page (its worktree is removed)"
                style={{ opacity: 0.55, fontSize: 14, lineHeight: 1, padding: "0 2px" }}
              >×</span>
            </div>
          );
        })}
        <button onClick={newPage} title="Open a new page — pick or create a project (each page gets its own branch/worktree), or just chat" style={{ ...btn, height: 26, padding: "0 10px", marginLeft: 4 }}>＋ New page</button>
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
