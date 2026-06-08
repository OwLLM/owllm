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
import GitBar from "./GitBar";
import ModelPicker, { type AccountsStatusLite } from "./ModelPicker";
import { chatRuntime } from "../../runtime/chatRuntime";
import { useChatSession } from "../../runtime/useChatSession";
import { streamLocalChat, streamChatCompletion, providerFor, type ModelInfo, type ServerStatus, type HistoryItem } from "./dispatch";
import type { ToolCall, ToolExecResult } from "./localTools";
import {
  wslStatus, wslIsolationGet, wslIsolationSet, wslCreateProject, wslListProjects,
  wslToolchainStatus, wslProvision, wslInstall, toolchainReady,
  isWslPath, type WslStatus, type WslIsolation, type WslProject, type WslToolchain,
} from "./wslIsolation";
import { githubStatus, githubConnect, githubDisconnect, GITHUB_TOKEN_URL, type GithubStatus } from "./github";
import {
  sandboxSyncLogins, sandboxStatus, sandboxCreateProject, sandboxListProjects,
  sandboxProvision, sandboxLoginStatus, sandboxConvertProject,
  engineLabel, type SandboxStatus, type SandboxProject,
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

// The whole Code-page session lives in the shared chatRuntime store under this
// id, so it survives navigating away and back (same mechanism the Chat page
// uses — the store keeps the snapshot in memory across unmount/remount).
const SID = "code:main";
type CodeState = {
  messages: Msg[];
  tasks: Task[];
  workspace: string;
  modelId: string;
  draft: string;
  busy: boolean;
  status: string;
};
const DEFAULT_CODE_STATE: CodeState = {
  messages: [], tasks: [], workspace: "", modelId: "", draft: "", busy: false,
  status: "Pick a folder and a local model, then describe what to build or fix.",
};

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

export default function CodePage() {
  // The model LIST is re-fetched on mount, so it stays plain component state.
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [accountsStatus, setAccountsStatus] = useState<AccountsStatusLite | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // SESSION state (conversation, Kanban, workspace, model, draft) lives in the
  // shared chatRuntime store so it survives leaving this page and coming back.
  // Setter shims keep the same signatures as useState so the rest of the file
  // is unchanged.
  const sess = useChatSession<CodeState>(SID);
  const hydratedRef = useRef(false);
  if (!hydratedRef.current) {
    hydratedRef.current = true;
    // Restore the last project the user had open (its saved conversation,
    // Kanban, draft, model) — or fall back to the empty onboarding state.
    const restored = loadCodeSession(getLastCodeProject());
    chatRuntime.hydrateIfIdle(SID, restored ?? DEFAULT_CODE_STATE);
    // Register the persister so EVERY mutation is debounce-saved to
    // localStorage (per workspace), and a final flush fires even after the
    // page unmounts or a stream ends. This is the fix for "I coded for an
    // hour, closed the app, and nothing was saved".
    chatRuntime.registerPersister(SID, (payload) => saveCodeSession(payload as CodeState));
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
  const { messages, tasks, workspace, modelId, draft, busy, status } = stx;
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

  // Auto-scroll the transcript as tokens / tool events land.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Switch the page to a project folder: save whatever's open now, then load
  // THAT folder's saved session (conversation + Kanban + draft + model), or
  // start a fresh one carrying the current model selection over. Updates the
  // recent-projects list so the onboarding screen can offer it next time.
  const openWorkspace = (dir: string) => {
    if (!dir || busy) return;
    saveCodeSession(stx); // flush the outgoing project before we swap it out
    const restored = loadCodeSession(dir);
    chatRuntime.setPayload(SID, () =>
      restored ?? { ...DEFAULT_CODE_STATE, workspace: dir, modelId, status: `Workspace: ${dir}` },
    );
    setRecents(rememberCodeProject(dir));
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
  const closeProject = () => {
    if (busy) return;
    saveCodeSession(stx);
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
      const [st, iso0, s] = await Promise.all([wslStatus(), wslIsolationGet(), sandboxStatus()]);
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
        const synced = await sandboxSyncLogins(wslStat?.defaultDistro ?? null);
        setStatus(synced.length
          ? `Agent tools installed; synced logins: ${synced.join(", ")}.`
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
      const synced = await sandboxSyncLogins(wslStat?.defaultDistro ?? null);
      setStatus(synced.length
        ? `✓ Synced logins: ${synced.join(", ")} — isolated agents are authenticated.`
        : "No host logins found. Log in to a provider via Accounts first, then retry.");
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
    // Account status inside the sandbox (which logins are synced).
    if (sbox?.available) sandboxLoginStatus(wslStat?.defaultDistro ?? null).then(setNpLogins).catch(() => setNpLogins([]));
    else setNpLogins([]);
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
      .then((s) => {
        if (s.length) setStatus(`🔑 Synced cloud logins into the sandbox: ${s.join(", ")}.`);
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

  const wsShort = workspace ? workspace.replace(/^.*[\\/]/, "") : "No folder";

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
        <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto" }}>
          <div style={{ width: "100%", maxWidth: 880, display: "flex", flexDirection: "column", gap: 18, padding: 24 }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 40, marginBottom: 8 }}>🛠️</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "var(--fg-strong)" }}>Open a project to start coding</div>
              <div style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 8, lineHeight: 1.6 }}>
                Your model works directly inside a folder — reading, searching, editing and
                creating files and running commands there. Each folder is a saved project:
                its conversation and plan come back when you reopen it.
              </div>
            </div>
            {/* Isolation is automatic when an engine is present; the toolchain
                installs itself in the background. A manual prompt appears only
                when no engine exists. */}
            {sbox?.available ? (
              <div style={{ fontSize: 12, color: "#7ff0c5", textAlign: "center", lineHeight: 1.5 }}>
                🛡 Isolation on — new projects run inside {engineLabel(sbox.kind)}{sbox.strong ? " (VM)" : ""}{sbox.beta ? " · beta" : ""}, off your {isWsl ? "Windows" : "host"} files.
                {isWsl && provisionLog === "running" ? " Installing agent tools…" : ""}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, color: "#06080d", background: "#ffd97a", border: "1px solid #d9b24a", borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontSize: 12, lineHeight: 1.5 }}>
                  ⚠ <b>No isolation engine installed</b> — agents would run on the host (guards still apply, but not sandboxed).{" "}
                  {isWsl ? "Install WSL + Ubuntu to sandbox them." : "Install the sandbox engine (Lima/bubblewrap)."}
                </div>
                {isWsl ? (
                  <button onClick={installWsl} style={{ ...btn, height: 36, justifyContent: "center", background: "#06080d", color: "#ffd97a", border: "none", fontWeight: 700 }}>⬇ Install WSL (needs admin + reboot)</button>
                ) : (
                  <button onClick={provisionTools} disabled={provisionLog === "running"} style={{ ...btn, height: 36, justifyContent: "center", background: "#06080d", color: "#ffd97a", border: "none", fontWeight: 700, opacity: provisionLog === "running" ? 0.6 : 1 }}>{provisionLog === "running" ? "⏳ Installing…" : "⬇ Install sandbox engine + agent tools"}</button>
                )}
              </div>
            )}

            {/* Two columns: primary actions (left) · recent projects + GitHub (right). */}
            <div style={{ display: "flex", gap: 16, alignItems: "stretch", width: "100%" }}>
              {/* LEFT — start a project */}
              <div style={{ flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                <button
                  onClick={openNewProject}
                  style={{ ...btn, height: 48, fontSize: 14, fontWeight: 700, background: "var(--accent)", color: "#06080d", border: "none", justifyContent: "center" }}
                >
                  {sbox?.available ? "🛡 New project" : "＋ New project"}
                </button>
                <button
                  onClick={pickWorkspace}
                  title="Open an existing folder on your drive"
                  style={{ ...btn, height: 44, justifyContent: "center" }}
                >
                  📁 Open a project folder…
                </button>
                <div style={{ fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.6, marginTop: 2 }}>
                  Your model reads, searches, edits and runs commands directly inside the project.
                  {sbox?.available ? ` New projects are created inside ${engineLabel(sbox.kind)} and isolated from your ${isWsl ? "Windows" : "host"} system.` : ""}
                </div>
              </div>

              {/* RIGHT — recent projects (scrollable) + GitHub underneath */}
              <div style={{ flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>Recent projects</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 300, overflowY: "auto", paddingRight: 2 }}>
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

                {/* GitHub — under the recents list. Lets isolated agents clone
                    private repos + push (host creds don't cross the sandbox). */}
                <div style={{ display: "flex", flexDirection: "column", gap: 8, background: "var(--bg-input)", border: "1px solid var(--border-strong)", borderRadius: 8, padding: "10px 12px" }}>
                  {gh?.connected ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 13, color: "var(--fg-strong)", flex: 1, minWidth: 0 }}>🐙 GitHub connected as <b>{gh.login}</b></span>
                      <button onClick={disconnectGithub} disabled={ghBusy} style={{ ...btn, height: 28, padding: "0 10px", color: "var(--fg-muted)" }}>Disconnect</button>
                    </div>
                  ) : ghOpen ? (
                    <>
                      <div style={{ fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.5 }}>
                        Paste a GitHub token so agents can clone private repos and push from inside the sandbox.
                      </div>
                      <button onClick={() => { invoke("shell_open_url", { url: GITHUB_TOKEN_URL }).catch(() => {}); }} style={{ ...btn, height: 30, justifyContent: "center", color: "var(--accent)" }}>
                        ↗ Create a token on GitHub (repo scope)
                      </button>
                      <input
                        type="password"
                        value={ghToken}
                        onChange={(e) => setGhToken(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") connectGithub(); }}
                        placeholder="ghp_… or github_pat_…"
                        style={{ height: 34, background: "var(--bg-surface)", border: "1px solid var(--border-strong)", borderRadius: 6, color: "var(--fg)", fontSize: 13, padding: "0 10px" }}
                      />
                      <div style={{ display: "flex", gap: 8 }}>
                        <button onClick={connectGithub} disabled={ghBusy || !ghToken.trim()} style={{ ...btn, height: 34, flex: 1, justifyContent: "center", fontWeight: 700, background: "var(--accent)", color: "#06080d", border: "none", opacity: ghBusy || !ghToken.trim() ? 0.6 : 1 }}>
                          {ghBusy ? "⏳ Connecting…" : "Connect GitHub"}
                        </button>
                        <button onClick={() => { setGhOpen(false); setGhMsg(""); }} disabled={ghBusy} style={{ ...btn, height: 34, padding: "0 12px", color: "var(--fg-muted)" }}>Cancel</button>
                      </div>
                    </>
                  ) : (
                    <button onClick={() => { setGhOpen(true); setGhMsg(""); }} style={{ ...btn, height: 34, justifyContent: "center", color: "var(--fg-strong)" }}>
                      🐙 Connect GitHub — clone &amp; push from inside the sandbox
                    </button>
                  )}
                  {ghMsg && <div style={{ fontSize: 11, color: ghMsg.startsWith("✓") || ghMsg.startsWith("Disconnected") ? "#7ff0c5" : "var(--fg-muted)" }}>{ghMsg}</div>}
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

                  {/* Cloud account status inside the sandbox (#8) */}
                  {sbox?.available && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <label style={{ fontSize: 11, color: "var(--fg-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>Cloud accounts in sandbox</label>
                      {npLogins.filter((l) => l !== "keys").length > 0 ? (
                        <div style={{ fontSize: 12, color: "#7ff0c5" }}>
                          ✓ {npLogins.filter((l) => l !== "keys").join(", ")} synced{npLogins.includes("keys") ? " · API keys synced" : ""}
                        </div>
                      ) : (
                        <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
                          {npLogins.includes("keys") ? "API keys synced — no CLI logins yet." : "No cloud logins synced yet."}
                        </div>
                      )}
                      <button
                        onClick={async () => { const s = await sandboxSyncLogins(wslStat?.defaultDistro ?? null); setNpLogins(await sandboxLoginStatus(wslStat?.defaultDistro ?? null)); setStatus(s.length ? `🔑 Synced: ${s.join(", ")}.` : "No host logins found to sync."); }}
                        style={{ ...btn, height: 30, justifyContent: "center", color: "var(--fg-strong)" }}
                      >
                        🔑 Sync my cloud logins now
                      </button>
                      <div style={{ fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.5 }}>
                        Your Accounts logins are mirrored into the sandbox once and persist — isolated agents use them automatically.
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
        <span
          title={isolatedNow
            ? "Isolated: tools run inside Linux (WSL) and cannot touch your Windows files."
            : "Not isolated: tools run on Windows (write-jail + dangerous-command guard still apply)."}
          style={{
            fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 6, whiteSpace: "nowrap",
            background: isolatedNow ? "rgba(127,240,197,0.15)" : "rgba(255,217,122,0.15)",
            color: isolatedNow ? "#7ff0c5" : "#ffd97a",
            border: `1px solid ${isolatedNow ? "#7ff0c5" : "#ffd97a"}55`,
          }}
        >
          {isolatedNow ? "🛡 Isolated" : "⚠ Not isolated"}
        </span>
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
          <>
            <button onClick={planAndExecute} disabled={!draft.trim()} title="Break the goal into ordered steps, then build them one by one (Kanban)" style={{ ...btn, height: 44, padding: "0 14px", opacity: draft.trim() ? 1 : 0.5 }}>📋 Plan</button>
            <button onClick={send} disabled={!draft.trim()} style={{ ...btn, background: "var(--accent)", color: "#06080d", border: "none", height: 44, padding: "0 16px", fontWeight: 700, opacity: draft.trim() ? 1 : 0.5 }}>Send</button>
          </>
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
