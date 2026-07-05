// Local tool registry + native tool-array builder for llama-server.
//
// THE LIVE PROTOCOL IS NATIVE GGUF TOOL-CALLING (see CLAUDE.md). The model
// gets an OpenAI `tools` array on /v1/chat/completions; llama-server --jinja
// renders it through the GGUF's own template and parses the trained tool
// tokens back into structured delta.tool_calls. There is NO XML protocol in
// the live path — the old XML `<tool_call>` parser was deleted from the React
// app (commit 129bcb13) and its Python twin quarantined to _legacy/.
//
// This module owns:
//   - LOCAL_TOOL_SPECS — the built-in tools, each mapping to a Tauri command
//     in agent_tools.rs.
//   - formatToolsForOpenAI() — builds the `tools` array: local tools + MCP
//     tools, gated by the MCP master switch / per-tool toggles, with every
//     MCP inputSchema run through a SAFETY GATE so one malformed schema can't
//     poison llama-server's tool grammar and break ALL tool-calling.
//   - executeToolCall() — runs one native call against the Rust commands.
//   - stripFabricatedToolOutput() — scrubs tool scaffolding some models still
//     leak into visible content even though llama-server parsed the real call.

import { invoke } from "@tauri-apps/api/core";
import {
  isMcpMasterEnabled,
  getDisabledMcpTools,
} from "./mcpSettings";
import { bumpActivity } from "../../support/activityStats";
import { loadSkillByRef, skillCatalogBrief, anySkillInstalled } from "./skillRuntime";
import { formatWorkLogEntry, renderRelevantWork } from "./teamMemoryFormat";
import { parseVerifyConfig, parseCardVerify, pickGateCommand, classifyGateStatus, detectVerifyCommand, type GateResult, type GateScope } from "./gate";
import { parseProjectCard, lintProjectCard, type CardFinding, type CardFacts } from "./cardLint";

/// Built-in tools that let an agent manage its OWN skills at runtime. These
/// bypass the role tool_allowlist (skills are a separate capability axis from
/// file/shell tools) and are advertised only when at least one skill pack is
/// installed. Kept in LOCAL_TOOL_SPECS so the name normalizer + validator know
/// them; force-added in formatToolsForOpenAI so an allowlist can't hide them.
export const SKILL_TOOL_NAMES = new Set(["load_skill", "list_skills"]);

/// Shared team-memory tools — a RAG-like store every agent can read/write so the
/// team builds a common, durable knowledge base (decisions, build commands,
/// gotchas, file maps) scoped to the project. Like skills, memory is a
/// cross-cutting capability: NEVER gated by a role's tool_allowlist, always
/// advertised. Backed by SQLite (memory.rs) and scoped by the project cwd.
export const MEMORY_TOOL_NAMES = new Set(["memory_search", "memory_write", "memory_read"]);

/// Shared agent-browser tools are also cross-cutting (never allowlist-gated);
/// see BROWSER_TOOL_NAMES below LOCAL_TOOL_SPECS (it derives from the specs,
/// which aren't initialized yet at this point in the module).

/// Scope key for the shared team memory. We key it by the stable PROJECT ID
/// (not the project cwd, which differs per machine: C:\foo vs /home/you/foo) so
/// the store matches across PCs and can sync through the GitHub vault. The
/// dispatch entry points set this at run start; the memory_* tools read it.
/// Falls back to the cwd passed to executeToolCall when unset (e.g. ad-hoc use).
let _teamMemoryScope = "";
/// The current run's goal, cached module-side so EVERY snapshot refresh (run
/// start, after logTeamWork, after memory_write, after harvest) stays
/// goal-relevant instead of silently reverting to recency mid-run.
let _teamMemoryGoal = "";
/// Cached, prompt-ready snapshot of the shared memory for the current scope:
/// goal-relevant FACTS + a short recency tail of LATEST TEAM ACTIVITY (worklog),
/// so both "what do we know" and "what just happened" survive. The dispatch loops
/// inject this into EVERY agent's system prompt (buildOrchestratorPrompt /
/// buildSpecialistPrompt) so team memory is READABLE on every model path —
/// including the cloud CLI / API agents that can't host the memory_* native
/// tools. Refreshed at run start and after each write; "" if empty.
let _teamMemorySnapshot = "";
/// Row ids currently in the snapshot — retrieveTeamMemory excludes them so the
/// per-task RAG block never duplicates what the system prompt already carries.
let _snapshotIds = new Set<number>();

export function setTeamMemoryScope(projectId: string | null | undefined): void {
  const next = (projectId ?? "").trim();
  // Scope changed (different project) → the cached snapshot + goal are stale;
  // drop them so a builder can't splice another project's memory in before the
  // next refresh.
  if (next !== _teamMemoryScope) {
    _teamMemorySnapshot = "";
    _teamMemoryGoal = "";
    _snapshotIds = new Set();
  }
  _teamMemoryScope = next;
}

/// Set the current run's goal (dispatch entry points, right after
/// setTeamMemoryScope) so snapshot refreshes rank facts by relevance to it.
export function setTeamMemoryGoal(goal: string | null | undefined): void {
  _teamMemoryGoal = (goal ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
}

/// The current rendered team-memory snapshot block (or "" when empty/unloaded).
/// SYNC by design so the (sync) prompt builders can splice it in directly. The
/// dispatch loops keep it warm via refreshTeamMemorySnapshot().
export function getTeamMemorySnapshot(): string {
  return _teamMemorySnapshot;
}

type RawTeamMemEntry = { id: number; key: string; content: string; tags: string; author: string; ts: number; kind: string };

/// Render the two-section snapshot the model reads directly — the READ half of
/// "memory usable on every model path". Facts are the curated knowledge base
/// (goal-relevant first); the activity tail is the newest worklog so intra-run
/// handoff and "what happened last session" survive relevance ranking. Pure;
/// both lists empty → "".
export function renderTeamMemorySnapshot(facts: RawTeamMemEntry[], worklog: RawTeamMemEntry[] = []): string {
  if (!facts.length && !worklog.length) return "";
  const line = (e: RawTeamMemEntry, max: number) => {
    const k = e.key ? `[${e.key}] ` : "";
    const tg = e.tags && e.tags !== "worklog" ? `  (tags: ${e.tags})` : "";
    return `  • ${k}${truncate(e.content, max).replace(/\s*\n+\s*/g, " ")}${tg}`;
  };
  const out: string[] = [];
  if (facts.length) {
    out.push(
      "TEAM MEMORY — durable shared knowledge (most relevant first), injected so you can",
      "read it WITHOUT any tool call. Consult it before re-deriving or asking:",
      ...facts.map((e) => line(e, 400)),
    );
  }
  if (worklog.length) {
    out.push(
      "LATEST TEAM ACTIVITY (newest first — what teammates just did):",
      ...worklog.map((e) => line(e, 300)),
    );
  }
  return out.join("\n");
}

/// Refresh the cached snapshot for the current scope: goal-relevant facts,
/// back-filled with the newest facts (so a brand-new goal with zero term overlap
/// still surfaces the knowledge base), plus a short recency tail of worklog.
/// Best-effort: any failure leaves the previous snapshot intact and never throws
/// — memory must not break a run. The dispatch loops call this at run start and
/// after writes.
export async function refreshTeamMemorySnapshot(limit = 12): Promise<void> {
  const scope = _teamMemoryScope || "";
  const factLim = Math.max(4, Math.round((limit * 2) / 3));
  const logLim = Math.max(2, limit - factLim);
  try {
    const [relevant, recent, worklog] = await Promise.all([
      _teamMemoryGoal
        ? invoke<RawTeamMemEntry[]>("team_memory_search", { scope, query: _teamMemoryGoal, limit: factLim, kinds: ["fact"] })
        : Promise.resolve([] as RawTeamMemEntry[]),
      invoke<RawTeamMemEntry[]>("team_memory_search", { scope, query: "", limit: factLim, kinds: ["fact"] }),
      invoke<RawTeamMemEntry[]>("team_memory_search", { scope, query: "", limit: logLim, kinds: ["worklog"] }),
    ]);
    const seen = new Set<number>();
    const facts: RawTeamMemEntry[] = [];
    for (const e of [...relevant, ...recent]) {
      if (facts.length >= factLim) break;
      if (!seen.has(e.id)) { seen.add(e.id); facts.push(e); }
    }
    _teamMemorySnapshot = renderTeamMemorySnapshot(facts, worklog);
    _snapshotIds = new Set([...facts, ...worklog].map((e) => e.id));
  } catch { /* keep the last good snapshot */ }
  // Piggyback: keep the browser-state line warm on the same cadence (run start,
  // after every logTeamWork/memory write) so prompts built for ANY model path —
  // including CLI agents that never call formatToolsForOpenAI — carry it.
  void refreshBrowserState();
}

/// Cached one-line state of the shared agent browser, spliced into every
/// prompt (like the memory snapshot) so agents KNOW the window the user is
/// looking at exists and is theirs to inspect. "" when no window is open.
/// Without this line a model asked "what do you see on the page I opened?"
/// truthfully answers "I can't see your browser" — the tools alone don't tell
/// it there is a live shared session.
let _browserStateLine = "";

/// Best-effort refresh of the cached line from browser_status (cheap: reads
/// window presence + URL, no page round-trip). Never throws.
export async function refreshBrowserState(): Promise<void> {
  // STANDING capability line — injected into EVERY agent turn regardless of whether
  // a window is open. Load-bearing: without an authoritative assertion here, an
  // agent falls back to team memory, and a single stale "browser tools not in CLI"
  // fact (written when the gateway path was briefly broken pre-v0.7.62) made whole
  // teams recite "I have no browser" instead of loading the tools that are wired.
  // Subscription-CLI agents receive these via the MCP gateway renamed mcp__owllm__<tool>;
  // a bare `browser_snapshot` lookup then finds nothing, so name the prefix + how to
  // surface them (ToolSearch query 'browser' — verified to load all 12).
  const CAP =
    "AGENT BROWSER — you CAN drive a real in-app browser: open pages (incl. localhost + live sites), " +
    "read them, and click/fill/select to complete tasks and forms. Tools: browser_open, browser_navigate, " +
    "browser_snapshot (indexed element list), browser_get_text, browser_click, browser_fill, browser_select, " +
    "browser_press, browser_device. If you run via a subscription CLI they are prefixed mcp__owllm__ " +
    "(e.g. mcp__owllm__browser_snapshot); if not already in your tool list, load them with ToolSearch query " +
    "'browser'. DISREGARD any team-memory note claiming browser tools are unavailable from the CLI/team — " +
    "that is STALE and false; the tools are wired. Never claim you cannot see the browser — snapshot it first.";
  try {
    const st = await invoke<{ running: boolean; url: string; device: string }>("browser_status");
    if (st && st.running) {
      const dev = st.device && st.device !== "desktop" ? ` (emulating ${st.device})` : "";
      _browserStateLine =
        "SHARED AGENT BROWSER: an in-app browser window is OPEN" +
        (st.url ? ` at ${st.url}` : "") + dev + ". " +
        "The user sees this same window — it is your shared screen. " + CAP;
    } else {
      _browserStateLine = CAP;
    }
  } catch { _browserStateLine = CAP; }
}

/// SYNC accessor for the (sync) prompt builders, same pattern as
/// getTeamMemorySnapshot(). Kept warm by refreshTeamMemorySnapshot and
/// formatToolsForOpenAI.
export function getBrowserStateLine(): string {
  return _browserStateLine;
}

/// Retrieve the shared work-state RELEVANT to a task (BM25-lite ranked by
/// team_memory_search) and render it as a prompt block. This is the RAG READ path
/// done right: query BY THE TASK, not by recency — so a specialist sees what
/// teammates already did on this exact thing. Rows already carried by the injected
/// snapshot are excluded (no double token spend). Empty/failed → "". The dispatch
/// loops prepend this to each specialist's instruction (enrichInstructionWithMemory).
export async function retrieveTeamMemory(task: string, limit = 8): Promise<string> {
  const scope = _teamMemoryScope || "";
  try {
    // Overfetch: up to `limit` of the top hits may already sit in the snapshot.
    const entries = await invoke<RawTeamMemEntry[]>("team_memory_search", { scope, query: task, limit: limit + 12 });
    const fresh = entries.filter((e) => !_snapshotIds.has(e.id)).slice(0, limit);
    return renderRelevantWork(fresh);
  } catch { return ""; /* memory must never break a run */ }
}

/// Auto-capture what an agent just did as shared work-state (the WRITE path done
/// right: the harness records the WORK, not opt-in trivia), so the next agent is
/// synchronized on it. Bounded server-side (team_memory_log prunes old worklog
/// rows). Best-effort, never throws.
export async function logTeamWork(agent: string, instruction: string, result: string): Promise<void> {
  if (!result || !result.trim()) return;
  // Don't record FAILED turns into the shared work-state. The loop research is
  // clear that an agent re-conditions on its own errors when they accumulate in
  // context (it repeats the failed approach), so a `(error: …)` reply must not be
  // re-injected into the next agent's instruction. Errors surface in the live log,
  // not the durable memory.
  if (/^\(error:/i.test(result.trim())) return;
  const scope = _teamMemoryScope || "";
  try {
    await invoke<number>("team_memory_log", { scope, agent, content: formatWorkLogEntry(agent, instruction, result) });
    await refreshTeamMemorySnapshot();
  } catch { /* memory must never break a run */ }
}

/// Run the Verification Gate at `cwd` for a scope (the wired half of gate.ts).
/// Reads .owllm/verify.json, runs the scoped command via the SANDBOX-AWARE shell
/// (tool_shell_exec), captures stdout/stderr/exit, and returns a GateResult whose
/// status is decided from the EXIT CODE — never from any agent's claim. No command
/// configured → status "unverified" (honest). Best-effort; never throws.
/// Best-effort read of a project marker file (relative to cwd). Returns its
/// text, or null when it's absent/unreadable — never throws.
async function probeRead(path: string, cwd: string): Promise<string | null> {
  try { return await invoke<string>("tool_read_file", { path, cwd }); } catch { return null; }
}

export async function runGate(cwd: string, scope: GateScope = "full"): Promise<GateResult> {
  const startedAt = new Date().toISOString();
  let cfgText = "";
  try { cfgText = await invoke<string>("tool_read_file", { path: ".owllm/verify.json", cwd }); } catch { /* none */ }
  let command = pickGateCommand(parseVerifyConfig(cfgText), scope);
  let detected = false;
  // Next: the Project Card (.owllm/project.json) `verify` section — the single
  // committed place a project declares its rules. Same {command,lanes} shape; the
  // dedicated verify.json still wins if both exist (more specific, purpose-built).
  if (!command) {
    const cardText = await probeRead(".owllm/project.json", cwd);
    command = pickGateCommand(parseCardVerify(cardText), scope);
  }
  // No explicit config → sniff the project's marker files and infer a cheap
  // check, so the gate works out-of-the-box instead of sitting "unverified"
  // forever (which is what made the loop never engage by default).
  if (!command) {
    const [packageJson, cargo, pyproject, pytestIni, goMod] = await Promise.all([
      probeRead("package.json", cwd),
      probeRead("Cargo.toml", cwd),
      probeRead("pyproject.toml", cwd),
      probeRead("pytest.ini", cwd),
      probeRead("go.mod", cwd),
    ]);
    command = detectVerifyCommand({
      packageJson,
      hasCargo: cargo != null,
      hasPyproject: pyproject != null,
      hasPytestIni: pytestIni != null,
      hasGoMod: goMod != null,
    });
    detected = !!command;
  }
  if (!command) {
    return { status: "unverified", cwd, scope, startedAt, finishedAt: new Date().toISOString(), captured: true };
  }
  let exitCode: number | undefined;
  let stdout = "";
  let stderr = "";
  try {
    const r = await invoke<{ stdout: string; stderr: string; exitCode: number }>("tool_shell_exec", { command, cwd });
    exitCode = r.exitCode; stdout = r.stdout; stderr = r.stderr;
  } catch (e: any) {
    exitCode = -1; stderr = String(e?.message ?? e);
  }
  return {
    status: classifyGateStatus(true, exitCode),
    command, cwd, scope, exitCode, stdout, stderr, detected,
    startedAt, finishedAt: new Date().toISOString(), captured: true,
  };
}

/// Run the Project Card linter at `cwd` (the wired half of cardLint.ts). Reads
/// .owllm/project.json, gathers the repo facts the pure linter needs — but only the
/// ones it can determine CONFIDENTLY (unknowns stay null so the linter skips them,
/// never warning on a guess) — and returns the findings. Best-effort; never throws.
/// This is the Steward's deterministic backbone: detection is rule-based here, the
/// agent only proposes fixes the user approves.
export async function runCardLint(cwd: string): Promise<{ findings: CardFinding[]; cardText: string | null }> {
  const cardText = await probeRead(".owllm/project.json", cwd);
  const card = parseProjectCard(cardText);
  const facts: CardFacts = {};

  if (card?.release?.versionFile) {
    facts.versionFileExists = (await probeRead(card.release.versionFile, cwd)) != null;
  }
  if (card?.release?.stagePath) {
    try { await invoke("tool_list_dir", { path: card.release.stagePath, cwd }); facts.stagePathExists = true; }
    catch { facts.stagePathExists = false; }
  }

  // Toolchain markers: only assert them when NO verify command cd's into a subdir —
  // otherwise the marker really lives elsewhere (e.g. OwLLM's verify cds into
  // owllm-desktop/) and a root-level check would false-positive. cd present → leave
  // the facts null so toolchainMismatch is skipped.
  const cmds: string[] = [];
  if (card?.verify?.command) cmds.push(card.verify.command);
  if (card?.verify?.lanes) for (const k of Object.keys(card.verify.lanes)) cmds.push(card.verify.lanes[k]);
  const anyCd = cmds.some(c => /(^|\s|&&|;)\s*cd\s+/.test(c || ""));
  if (cmds.length && !anyCd) {
    const [pkg, cargo, py, pyini, go] = await Promise.all([
      probeRead("package.json", cwd), probeRead("Cargo.toml", cwd),
      probeRead("pyproject.toml", cwd), probeRead("pytest.ini", cwd), probeRead("go.mod", cwd),
    ]);
    facts.hasPackageJson = pkg != null;
    facts.hasCargo = cargo != null;
    facts.hasPyproject = py != null || pyini != null;
    facts.hasGoMod = go != null;
  }

  // Public/private of the origin remote — best-effort via gh (cross-platform). Only
  // used by the #1 standing rule (private source must never sit on a public remote),
  // so ONLY pay the network call when the card actually claims "private" — otherwise
  // skip it (no gh latency on the common run). Unknown/unavailable → null → the rule
  // is skipped (honest, never a guess).
  const claimsPrivate = /\bprivate\b/i.test(
    `${card?.goal ?? ""}\n${Array.isArray(card?.rules) ? card!.rules.join("\n") : (card?.rules ?? "")}`);
  if (claimsPrivate) {
    try {
      const r = await invoke<{ stdout: string; stderr: string; exitCode: number }>(
        "tool_shell_exec", { command: "gh repo view --json visibility -q .visibility", cwd });
      const vis = (r?.stdout || "").trim().toUpperCase();
      if (vis === "PUBLIC") facts.remoteIsPublic = true;
      else if (vis === "PRIVATE" || vis === "INTERNAL") facts.remoteIsPublic = false;
    } catch { /* gh missing/offline → leave null */ }
  }

  return { findings: lintProjectCard(card, facts), cardText };
}

/// One-time-per-install auto-install of the FULL curated skill library, so a
/// fresh setup ships with every pack present — no need to open the Skill Library
/// dialog. Idempotent: discover_skills reports `installed`, so we only install
/// the missing ones. Fail-safe: if git is absent or the network is down, a fetch
/// throws and we DON'T set the done-flag, so it simply retries next launch (the
/// git-missing check returns instantly, so the retry is cheap). The bundled
/// OwLLM packs are always available regardless (read from resources) — this only
/// fills in the external curated sources (Anthropic, superpowers).
export async function ensureAllSkillsInstalled(): Promise<{ installed: number; ok: boolean }> {
  const FLAG = "owllm:skills-autoinstall-v1";
  try { if (localStorage.getItem(FLAG) === "done") return { installed: 0, ok: true }; } catch { return { installed: 0, ok: true }; }
  let installed = 0;
  let hadError = false;
  try {
    const sources = await invoke<{ key: string; git_url: string }[]>("list_skill_sources");
    for (const src of sources) {
      try {
        await invoke("fetch_skill_source", { key: src.key, gitUrl: src.git_url, force: false });
        const found = await invoke<{ relative_dir: string; installed: boolean }[]>("discover_skills", { key: src.key });
        for (const sk of found) {
          if (sk.installed) continue;
          try { await invoke("install_skill", { sourceKey: src.key, relativeDir: sk.relative_dir }); installed++; }
          catch { hadError = true; } // one bad pack shouldn't abort the rest
        }
      } catch { hadError = true; } // git missing / offline → retry next launch
    }
  } catch { hadError = true; }
  // Mark done only on a clean pass, so transient git/network failures retry.
  if (!hadError) { try { localStorage.setItem(FLAG, "done"); } catch { /* private mode */ } }
  return { installed, ok: !hadError };
}

export type MemoryDirective = { content: string; key: string; tags: string };

/// A fresh `[REMEMBER ...]` matcher each call — a global regex carries lastIndex
/// state, so we never share one instance between exec-loops and .replace().
function rememberRe(): RegExp {
  // Inter-token gaps are [ \t] only (NOT \s) so a content-less `[REMEMBER]` line
  // can't swallow the next line's text across the newline. Content is same-line.
  return /^[ \t>*\-]*\[REMEMBER\b([^\]]*)\][ \t]*(.+?)[ \t]*$/gim;
}

/// Parse universal `[REMEMBER ...]` write directives out of an agent's reply. This
/// is the MODEL-AGNOSTIC write path: a cloud CLI / API agent that can't call the
/// memory_write tool instead emits a plain line such as
///   [REMEMBER key=build_command tags=ci] Build with `npm run build` at repo root.
/// Pure + exported for tests. One entry per matched line (blank content skipped).
export function parseMemoryDirectives(text: string): MemoryDirective[] {
  if (!text) return [];
  const out: MemoryDirective[] = [];
  const re = rememberRe();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const attrs = m[1] ?? "";
    const content = (m[2] ?? "").trim();
    if (!content) continue;
    const key = (/\bkey=([^\s\]]+)/i.exec(attrs)?.[1] ?? "").trim();
    const tags = (/\btags=([^\s\]]+)/i.exec(attrs)?.[1] ?? "").trim();
    out.push({ content, key, tags });
  }
  return out;
}

/// Remove `[REMEMBER ...]` directive lines from a reply (e.g. before storing it in
/// per-agent history) so the control syntax doesn't accumulate. Pure.
export function stripMemoryDirectives(text: string): string {
  return text.replace(rememberRe(), "").replace(/\n{3,}/g, "\n\n").trim();
}

/// Parse + persist any `[REMEMBER ...]` directives in an agent's reply to the shared
/// team memory for the current scope, then refresh the snapshot so later agents in
/// the SAME run see them. Best-effort, never throws. Returns how many were written.
/// Works on every model path — the directive is just text in the reply.
export async function harvestMemoryWrites(reply: string): Promise<number> {
  const dirs = parseMemoryDirectives(reply);
  if (!dirs.length) return 0;
  const scope = _teamMemoryScope || "";
  let written = 0;
  for (const d of dirs) {
    try {
      await invoke<number>("team_memory_write", {
        scope, content: d.content, key: d.key, tags: d.tags, author: "",
      });
      written++;
    } catch { /* best-effort per directive */ }
  }
  if (written > 0) await refreshTeamMemorySnapshot();
  return written;
}

/// A publish request the Publisher emits in its reply text, e.g.
///   [PUBLISH notes="v0.6.89: fix X"]        — build → sign → gh release (real)
///   [PUBLISH dry notes="..."]               — rehearse (build+sign, no release)
/// We HARVEST it from the text (not as a tool call) because that is the ONE path
/// that works for sandboxed CLI agents (Claude/Codex/Gemini) — their native
/// tools never reach executeToolCall, so the publish_release tool is unreachable
/// to them; the host reads the sentinel and runs the release ITSELF.
export type PublishRequest = { notes: string; dryRun: boolean; draft: boolean };
export function parsePublishRequest(reply: string): PublishRequest | null {
  const m = /\[PUBLISH\b([^\]]*)\]/i.exec(reply || "");
  if (!m) return null;
  const attrs = m[1] || "";
  const notesM = /notes\s*=\s*"([^"]*)"/i.exec(attrs) || /notes\s*=\s*'([^']*)'/i.exec(attrs);
  return {
    notes: notesM ? notesM[1].trim() : "",
    dryRun: /\bdry(?:[-_]?run)?\b/i.test(attrs),
    draft: /\bdraft\b/i.test(attrs),
  };
}

/// Run a harvested publish request on the HOST via the publish_release command
/// (which shells the vetted scripts/publish-release.sh: build → minisign →
/// latest.json → gh release → verify). Returns the publish log (contains
/// PUBLISH_OK / PUBLISH_DRYRUN_OK / PUBLISH_FAILED) or null when there was no
/// request. Never throws — a failure comes back as PUBLISH_FAILED text so the
/// agent/orchestrator can read it and react.
export async function harvestPublishRequest(reply: string, cwd: string | null | undefined): Promise<string | null> {
  const req = parsePublishRequest(reply);
  if (!req) return null;
  if (!cwd) return "PUBLISH_FAILED: no project folder set — cannot run the host release.";
  try {
    return await invoke<string>("publish_release", {
      repoDir: cwd,
      notes: req.notes || null,
      dryRun: req.dryRun,
      draft: req.draft,
    });
  } catch (e: any) {
    return `PUBLISH_FAILED: ${String(e?.message ?? e)}`;
  }
}

export type ToolCall = {
  name: string;
  args: Record<string, string>;
};

// Native special-token tool soup (`<|tool_call>call:NAME{…}<tool_call|>`)
// and fabricated `<|tool_response>…` blocks that some models still leak
// into the VISIBLE content even when llama-server parsed the real call
// natively. stripFabricatedToolOutput scrubs these so the user never
// sees raw scaffolding. (We no longer PARSE these for execution — that's
// llama-server's job via the native delta.tool_calls.)
const NATIVE_CALL_RE = /<\|?\s*tool_call\b[^>]*>?\s*(?:call\s*:\s*)?([a-zA-Z_][a-zA-Z0-9_]*)\s*(\{[\s\S]*?\})\s*<\/?\s*tool_call\s*\|?>/gi;
const FABRICATED_RESPONSE_RE = /<\|?\s*tool_response\s*\|?>[\s\S]*?(?:_end_tool_output|<\/?\s*tool_response\s*\|?>|<eos>)/gi;
const STRAY_EOS_RE = /<eos>|<\|?\s*eos\s*\|?>/gi;

/// Strip fabricated tool-output blocks and stray native-format
/// tokens from a model reply before it's shown to the user / fed
/// back into history. Small models that fabricate tool results
/// after their own tool_calls leak nonsense JSON into the visible
/// chat without this filter.
export function stripFabricatedToolOutput(text: string): string {
  let out = text;
  out = out.replace(FABRICATED_RESPONSE_RE, "");
  out = out.replace(STRAY_EOS_RE, "");
  // Drop the dangling `<|tool_call>...<tool_call|>` blocks once
  // we've parsed them — they're noise in the visible reply.
  out = out.replace(NATIVE_CALL_RE, "");
  // Drop the well-formed XML tool_call blocks too. parseToolCalls
  // extracts them from the raw reply and the runtime executes
  // them; the user shouldn't see the raw '<tool_call name="…">…
  // </tool_call>' XML rendered as plain text. The previous strip
  // missed this case and the user saw the whole 'create_dir / shell
  // / web_search / write_file' XML pasted into the chat.
  out = out.replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, "");
  // Half-formed / nested tool_call openings the model emits when
  // it confuses itself — single </tool_call>, lone <tool_call ...>
  // without close, stray <arg> tags. Remove these so the user
  // doesn't see the leftover XML scaffolding.
  out = out.replace(/<\/?\s*tool_call\b[^>]*\/?>/gi, "");
  out = out.replace(/<\/?\s*arg\b[^>]*\/?>/gi, "");
  return out.trim();
}

/// OpenAI function-spec tool list — THE tool protocol. Passed as the
/// `tools` parameter on /v1/chat/completions so llama-server's --jinja
/// renders it through the GGUF's own chat template; the model emits its
/// trained tool-call tokens (Llama 3.1+ <|python_tag|>, Qwen3 <tool_call>,
/// Hermes/Mistral/Gemma native) and llama-server parses them back into
/// structured `delta.tool_calls`. No XML catalog, no prompt injection.
/// MCP tools are merged in; their `mcp:<server>:<tool>` names are
/// rewritten to `mcp__server__tool` to satisfy the OpenAI name regex and
/// reversed by unmangleMcpName on the way out.
export async function formatToolsForOpenAI(allowed?: string[]): Promise<unknown[]> {
  const out: unknown[] = [];
  // Allowlist sentinel: undefined / empty / ["all"] = unrestricted (the
  // orchestrator passes undefined → every tool). A concrete list restricts
  // to exactly those names (local names like "shell" or MCP qualified names
  // like "mcp:github:create_issue"), honouring the role's tool_allowlist.
  const allowSet = (allowed && allowed.length > 0 && !allowed.some((a) => a.toLowerCase() === "all"))
    ? new Set(allowed)
    : null;

  // MCP master switch — when off, drop ALL MCP tools from the array (local
  // tools stay). The schema gate below isolates bad schemas regardless, but
  // this is the user's one-flip A/B lever from the MCP page.
  const masterOn = isMcpMasterEnabled();
  const disabled = getDisabledMcpTools();
  const allMcp = masterOn ? await listAvailableMcpTools() : [];
  const activeMcp = allMcp.filter((m) =>
    !disabled.has(m.qualifiedName) && (!allowSet || allowSet.has(m.qualifiedName)),
  );

  const searchMcpTools = activeMcp.filter(isMcpSearchTool);
  // Skill tools are a separate capability axis — never gated by the role
  // tool_allowlist. They're added unconditionally below (when skills exist),
  // so drop them from the allowlist-gated set here to avoid double-adding.
  const localTools = (searchMcpTools.length > 0
    ? LOCAL_TOOL_SPECS.filter((t) => t.name !== "web_search")
    : LOCAL_TOOL_SPECS
  ).filter((t) =>
    !SKILL_TOOL_NAMES.has(t.name) &&
    !MEMORY_TOOL_NAMES.has(t.name) &&
    !BROWSER_TOOL_NAMES.has(t.name) &&
    (!allowSet || allowSet.has(t.name)),
  );
  // Advertise the skill tools (load_skill / list_skills) regardless of the
  // allowlist, but only when at least one skill pack is installed.
  if (await anySkillInstalled()) {
    for (const t of LOCAL_TOOL_SPECS.filter((t) => SKILL_TOOL_NAMES.has(t.name))) {
      localTools.push(t);
    }
  }
  // Shared team-memory tools — always advertised (cross-cutting, never
  // allowlist-gated) so any agent can consult / contribute to the team's
  // common knowledge base.
  for (const t of LOCAL_TOOL_SPECS.filter((t) => MEMORY_TOOL_NAMES.has(t.name))) {
    localTools.push(t);
  }
  // Shared agent-browser tools — same rule. The browser is ONE window shared
  // with the user; an agent must always be able to look at it (browser_snapshot)
  // or open a page, regardless of its role allowlist.
  for (const t of LOCAL_TOOL_SPECS.filter((t) => BROWSER_TOOL_NAMES.has(t.name))) {
    localTools.push(t);
  }
  // Keep the browser-state prompt line warm on every tool-catalog build (i.e.
  // before every local/API model turn) so mid-run browser opens are noticed.
  void refreshBrowserState();
  for (const t of localTools) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const a of t.args) {
      properties[a.name] = { type: "string", description: a.description };
      if (a.required) required.push(a.name);
    }
    out.push({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: "object",
          properties,
          required,
        },
      },
    });
  }
  // MCP tools — pulled at request time so the catalog stays in sync as
  // servers start/stop. Each inputSchema is run through sanitizeToolParameters
  // FIRST: an MCP server can ship a schema with $ref / oneOf / deep nesting /
  // a non-object root that llama-server's --jinja tool grammar can't render —
  // and a single bad schema in the array makes the model emit NO native calls
  // at all (it falls back to narrating). The gate coerces such schemas to a
  // safe object shape so one tool can never poison the whole array.
  // mcp:<server>:<tool> → mcp__server__tool to satisfy the OpenAI name regex
  // (^[a-zA-Z0-9_-]+$); reversed by unmangleMcpName on the way out.
  // Server-level quarantine (P1-5): a tool whose NAME can't be advertised
  // has no safe rewrite (it must round-trip for execution) and would poison
  // the grammar for every tool — drop that server's tools with a loud
  // notice; everything else keeps working.
  const { ok: advertisable, quarantined } = partitionMcpTools(activeMcp);
  announceQuarantine(quarantined);
  for (const m of advertisable) {
    const safeName = m.qualifiedName.replace(/:/g, "__");
    out.push({
      type: "function",
      function: {
        name: safeName,
        description: typeof m.description === "string" && m.description
          ? m.description
          : `MCP tool ${m.qualifiedName}`,
        parameters: sanitizeToolParameters(m.inputSchema).schema,
      },
    });
  }
  return out;
}

// ---- MCP schema safety gate --------------------------------------------
//
// llama-server (--jinja) builds a constrained grammar from each tool's
// `parameters` JSON Schema. It handles the common object-of-scalars shape
// fine, but chokes on $ref / $defs / oneOf|anyOf|allOf unions / array-typed
// `type` / deeply-nested or recursive schemas — and when grammar build fails
// for ANY tool, the model stops emitting native tool_calls entirely (the
// agentic "it just narrates Step 1…" failure). This gate rewrites any schema
// into a safe, lossless-enough object shape: unsupported constructs collapse
// to `{type:"string"}` (the arg still works, just as a string) rather than
// dropping the tool. A per-call shape mismatch is a graceful single-tool
// error; a poisoned grammar silently kills every tool. We choose the former.

const SAFE_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object", "null"]);
const MAX_SCHEMA_DEPTH = 5;

export type SchemaGateResult = {
  schema: Record<string, unknown>;
  /// True when the input was rewritten (display as "sanitized" in the UI).
  changed: boolean;
  /// Short human reason(s) for the rewrite, for the MCP page badge.
  reason: string;
};

function sanitizeSchemaNode(node: unknown, depth: number, notes: Set<string>): Record<string, unknown> {
  if (depth > MAX_SCHEMA_DEPTH || node == null || typeof node !== "object" || Array.isArray(node)) {
    if (node != null) notes.add("collapsed unsupported node to string");
    return { type: "string" };
  }
  const n = node as Record<string, unknown>;
  // References / compositions the grammar can't resolve → collapse to a
  // string arg, preserving the description so the model still knows intent.
  if ("$ref" in n || "oneOf" in n || "anyOf" in n || "allOf" in n || "$defs" in n || "definitions" in n || "not" in n) {
    notes.add("collapsed $ref/union to string");
    const out: Record<string, unknown> = { type: "string" };
    if (typeof n.description === "string") out.description = n.description;
    return out;
  }
  let type: unknown = n.type;
  if (Array.isArray(type)) {
    type = type.map(String).find((t) => SAFE_TYPES.has(t) && t !== "null") ?? "string";
    notes.add("narrowed union type");
  }
  if (typeof type !== "string" || !SAFE_TYPES.has(type)) {
    type = (n.properties && typeof n.properties === "object") ? "object" : "string";
    if (n.type != null) notes.add("replaced unsupported type");
  }
  const out: Record<string, unknown> = { type };
  if (typeof n.description === "string") out.description = n.description;
  if (Array.isArray(n.enum)) {
    const safe = n.enum.filter((v) => ["string", "number", "boolean"].includes(typeof v));
    if (safe.length > 0) out.enum = safe;
  }
  if (type === "object") {
    const props = (n.properties && typeof n.properties === "object" && !Array.isArray(n.properties))
      ? n.properties as Record<string, unknown> : {};
    const sp: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) sp[k] = sanitizeSchemaNode(v, depth + 1, notes);
    out.properties = sp;
    if (Array.isArray(n.required)) {
      const req = n.required.filter((r): r is string => typeof r === "string" && r in sp);
      if (req.length > 0) out.required = req;
    }
    out.additionalProperties = false;
  } else if (type === "array") {
    out.items = sanitizeSchemaNode(n.items ?? { type: "string" }, depth + 1, notes);
  }
  return out;
}

/// Run an MCP tool's raw inputSchema through the safety gate. Always returns
/// a usable object-rooted schema; `changed`/`reason` report what was rewritten.
export function sanitizeToolParameters(input: unknown): SchemaGateResult {
  const notes = new Set<string>();
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      schema: { type: "object", properties: {} },
      changed: input != null,
      reason: input != null ? "non-object schema replaced with empty object" : "",
    };
  }
  let root = sanitizeSchemaNode(input, 0, notes);
  // OpenAI function parameters MUST be an object at the root.
  if (root.type !== "object") {
    notes.add("non-object root replaced with empty object");
    root = { type: "object", properties: {} };
  }
  return { schema: root, changed: notes.size > 0, reason: [...notes].join("; ") };
}

/// One row of MCP-tool advertising status, for the MCP page. Combines the
/// live aggregated tools with the schema-gate verdict and the per-tool
/// disabled flag so the page can show toggles + "sanitized" badges.
export type McpToolReportRow = {
  qualifiedName: string;
  server: string;
  tool: string;
  description: string;
  disabled: boolean;
  schemaChanged: boolean;
  schemaReason: string;
  /// Whole-server quarantine (P1-5): this tool is NOT advertised because
  /// its server shipped unadvertisable tool names.
  quarantined: boolean;
  quarantineReason: string;
};

/// Build the advertising report for the MCP page (master switch + per-tool
/// toggles + schema-gate verdicts + quarantine). Read-only.
export async function getMcpToolReport(): Promise<McpToolReportRow[]> {
  const tools = await listAvailableMcpTools();
  const disabled = getDisabledMcpTools();
  const { quarantined } = partitionMcpTools(tools);
  const qByServer = new Map(quarantined.map((q) => [q.server, q.reason]));
  return tools.map((m) => {
    const gate = sanitizeToolParameters(m.inputSchema);
    const qReason = qByServer.get(m.server) ?? "";
    return {
      qualifiedName: m.qualifiedName,
      server: m.server,
      tool: m.tool,
      description: m.description,
      disabled: disabled.has(m.qualifiedName),
      schemaChanged: gate.changed,
      schemaReason: gate.reason,
      quarantined: qReason !== "",
      quarantineReason: qReason,
    };
  });
}

/// Reverse the MCP name rewrite from formatToolsForOpenAI. Used by the
/// dispatch loop so it can route native tool_calls back to executeToolCall
/// which expects mcp:<server>:<tool>.
export function unmangleMcpName(name: string): string {
  return name.startsWith("mcp__") ? name.replace(/__/g, ":") : name;
}

export type AggregatedMcpTool = {
  qualifiedName: string;
  server: string;
  tool: string;
  description: string;
  inputSchema: unknown;
};

// ---- MCP server quarantine (P1-5) ----------------------------------------
//
// The schema gate above fixes what's FIXABLE (bad inputSchema → safe shape).
// A tool whose NAME can't be advertised is different: the OpenAI tools array
// requires ^[a-zA-Z0-9_-]+$ and the name must round-trip back through
// unmangleMcpName to execute — there is no safe rewrite. One such tool
// poisons the grammar for EVERY tool (the model stops emitting native calls
// entirely). A server shipping unadvertisable names is quarantined as a
// unit — its tools are dropped with a clear notice — and every other
// server's tools keep working.

export type McpQuarantine = { server: string; reason: string; tools: number };

const OPENAI_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/// Split aggregated MCP tools into advertisable ones and per-server
/// quarantine notices. Pure — unit-probed.
export function partitionMcpTools(
  tools: AggregatedMcpTool[],
): { ok: AggregatedMcpTool[]; quarantined: McpQuarantine[] } {
  const byServer = new Map<string, AggregatedMcpTool[]>();
  for (const t of tools) {
    const s = typeof t?.server === "string" ? t.server : "";
    if (!byServer.has(s)) byServer.set(s, []);
    byServer.get(s)!.push(t);
  }
  const ok: AggregatedMcpTool[] = [];
  const quarantined: McpQuarantine[] = [];
  for (const [server, ts] of byServer) {
    let reason: string | null = null;
    if (!server.trim()) {
      reason = "server reported no name";
    } else {
      for (const t of ts) {
        const qn = t?.qualifiedName;
        const mangled = typeof qn === "string" ? qn.replace(/:/g, "__") : "";
        if (!OPENAI_TOOL_NAME_RE.test(mangled)) {
          reason = `tool name ${JSON.stringify(String(qn ?? ""))} can't be advertised (must be letters/digits/_/- and round-trip back for execution)`;
          break;
        }
      }
    }
    if (reason) quarantined.push({ server, reason, tools: ts.length });
    else ok.push(...ts);
  }
  return { ok, quarantined };
}

/// Surface a quarantine loudly (console + a window event the MCP page /
/// status surfaces can listen to). Never throws.
function announceQuarantine(quarantined: McpQuarantine[]): void {
  for (const q of quarantined) {
    const msg = `MCP server '${q.server}' quarantined — ${q.tools} tool(s) NOT advertised: ${q.reason}. Other tools keep working.`;
    try { console.warn(`[mcp] ${msg}`); } catch { /* never break the turn */ }
    try {
      window.dispatchEvent(new CustomEvent("owllm:mcp:quarantine", { detail: q }));
    } catch { /* non-browser context */ }
  }
}

async function listAvailableMcpTools(): Promise<AggregatedMcpTool[]> {
  try {
    await invoke("mcp_autostart_all");
  } catch { /* best-effort: listing may still work if servers are already running */ }
  try {
    return await invoke<AggregatedMcpTool[]>("mcp_list_all_tools");
  } catch {
    return [];
  }
}

function isMcpSearchTool(tool: AggregatedMcpTool): boolean {
  const haystack = `${tool.qualifiedName} ${tool.server} ${tool.tool} ${tool.description}`.toLowerCase();
  return /\b(search|web_search|duckduckgo|brave)\b/.test(haystack);
}

async function findPreferredMcpSearchTool(): Promise<AggregatedMcpTool | null> {
  const mcpTools = await listAvailableMcpTools();
  const searchTools = mcpTools.filter(isMcpSearchTool);
  if (searchTools.length === 0) return null;
  return searchTools.find((t) => /duckduckgo/i.test(`${t.qualifiedName} ${t.description}`))
    ?? searchTools.find((t) => !/brave/i.test(`${t.qualifiedName} ${t.description}`))
    ?? searchTools[0];
}

function buildMcpSearchArgs(tool: AggregatedMcpTool, call: ToolCall): Record<string, unknown> {
  const query = call.args.query ?? call.args.q ?? "";
  const maxRaw = call.args.max_results ?? call.args.maxResults ?? call.args.limit ?? call.args.count;
  const max = maxRaw ? Math.max(1, Math.min(20, Number(maxRaw) || 5)) : 5;
  const schema = tool.inputSchema && typeof tool.inputSchema === "object"
    ? tool.inputSchema as Record<string, unknown>
    : {};
  const props = schema.properties && typeof schema.properties === "object"
    ? schema.properties as Record<string, unknown>
    : {};
  const hasProp = (name: string) => Object.prototype.hasOwnProperty.call(props, name);
  const out: Record<string, unknown> = {};
  out[hasProp("q") && !hasProp("query") ? "q" : "query"] = query;
  for (const key of ["max_results", "maxResults", "limit", "count", "num_results"]) {
    if (hasProp(key) || key === "max_results") {
      out[key] = max;
      break;
    }
  }
  if (call.args.region && hasProp("region")) out.region = call.args.region;
  if (call.args.safe_search && hasProp("safe_search")) out.safe_search = call.args.safe_search;
  return out;
}

type ToolArg = {
  name: string;
  required: boolean;
  description: string;
  /// Other names models commonly use for this arg. The normalizer maps
  /// any of these back to `name` before execution. E.g. web_search's
  /// `query` accepts `q`, `search_query`, `text`.
  aliases?: string[];
};
type ToolSpec = {
  name: string;
  description: string;
  args: ToolArg[];
  /// Other names models commonly call this tool. The normalizer maps
  /// any alias back to `name`. E.g. `web_search` accepts `search`,
  /// `search_web`, `google`, `browser.search`.
  aliases?: string[];
};

/// Tool spec the system prompt advertises. Names match the legacy
/// Python builtin_registry (LLM/core/agents/tools/builtin.py) so any
/// role yaml's tool_allowlist filter resolves correctly. Each entry
/// maps to a Tauri command in src-tauri/src/agent_tools.rs.
export const LOCAL_TOOL_SPECS: ToolSpec[] = [
  {
    name: "read_file",
    aliases: ["file_read", "open_file", "readfile", "cat", "view_file", "get_file"],
    description: "Read a UTF-8 text file from disk. Returns the contents as a string.",
    args: [{ name: "path", required: true, description: "Absolute or project-relative file path.", aliases: ["file", "filename", "file_path", "filepath"] }],
  },
  {
    name: "write_file_with_diff",
    aliases: ["write_file", "writefile", "create_file", "save_file", "put_file", "new_file"],
    description:
      "Create a NEW file or fully rewrite an existing one. Parent dirs are " +
      "created automatically. Use this when writing fresh code / configs / " +
      "READMEs that don't exist yet.",
    args: [
      { name: "path", required: true, description: "Absolute or project-relative file path.", aliases: ["file", "filename", "file_path", "filepath"] },
      { name: "content", required: true, description: "The full file contents to write.", aliases: ["contents", "text", "data", "body"] },
    ],
  },
  {
    name: "edit_file",
    aliases: ["edit", "replace_in_file", "str_replace", "modify_file", "patch_file"],
    description:
      "Modify an EXISTING file by replacing an exact substring with new " +
      "content. Use for surgical edits — preserves the rest of the file. " +
      "old_string must match the file byte-for-byte (whitespace included).",
    args: [
      { name: "path", required: true, description: "Absolute or project-relative file path.", aliases: ["file", "filename", "file_path", "filepath"] },
      { name: "old_string", required: true, description: "Exact text to find and replace.", aliases: ["old_str", "old", "find", "search", "old_text", "from"] },
      { name: "new_string", required: true, description: "Replacement text.", aliases: ["new_str", "new", "replace", "replacement", "new_text", "to"] },
    ],
  },
  {
    name: "list_dir",
    aliases: ["ls", "listdir", "list_directory", "list_files", "dir", "readdir"],
    description: "List the entries (files + subfolders) of a directory.",
    args: [{ name: "path", required: true, description: "Absolute or project-relative directory path.", aliases: ["dir", "directory", "folder", "dir_path"] }],
  },
  {
    name: "publish_release",
    aliases: ["release", "ship_release", "publish", "cut_release"],
    description:
      "Build, sign, and publish a signed OwLLM release on the HOST (runs the vetted " +
      "publish-release.sh: build → minisign → latest.json → gh release → verify). " +
      "Bump the version in tauri.conf.json, commit, push and tag FIRST, then call this. " +
      "Returns the script log; success ends with PUBLISH_OK. Use dry_run='true' first " +
      "for a safe rehearsal (build+sign, no publish). Publisher role only.",
    args: [
      { name: "notes", required: false, description: "Release notes shown on GitHub + in the updater.", aliases: ["release_notes", "changelog", "message"] },
      { name: "dry_run", required: false, description: "'true' = build+sign+latest.json but DO NOT publish (rehearsal).", aliases: ["dryrun", "dry"] },
      { name: "draft", required: false, description: "'true' = publish as a DRAFT for a human to flip public.", aliases: [] },
    ],
  },
  {
    name: "create_dir",
    aliases: ["mkdir", "makedir", "make_directory", "create_directory", "new_dir"],
    description: "Create a directory (and any missing parent dirs).",
    args: [{ name: "path", required: true, description: "Absolute or project-relative directory path.", aliases: ["dir", "directory", "folder", "dir_path"] }],
  },
  {
    name: "shell",
    aliases: ["shell_exec", "bash", "sh", "run_command", "run_shell", "exec", "terminal", "cmd", "command", "execute"],
    description:
      "Run a shell command. On Windows uses cmd.exe /c, elsewhere sh -c. " +
      "Returns stdout, stderr, exit_code. Use for git, npm install, python " +
      "scripts, etc.",
    args: [{ name: "command", required: true, description: "The shell command line to run.", aliases: ["cmd", "cmd_line", "commandline", "script", "code", "input"] }],
  },
  {
    name: "ssh_exec",
    aliases: ["ssh", "ssh_run", "remote_shell", "ssh_command", "remote_exec", "run_remote"],
    description:
      "Run a shell command on a REMOTE host over SSH, using the user's existing " +
      "SSH keys (no passwords). Returns stdout/stderr/exit_code. Use to operate, " +
      "configure or program another machine — a server, Raspberry Pi, or another PC.",
    args: [
      { name: "host", required: true, description: "Remote host/IP, or an alias from ~/.ssh/config.", aliases: ["hostname", "server", "ip", "address", "target"] },
      { name: "command", required: true, description: "The shell command to run on the remote host.", aliases: ["cmd", "script", "run", "command_line"] },
      { name: "user", required: false, description: "SSH username (omit to use ssh config / current user).", aliases: ["username", "login"] },
      { name: "port", required: false, description: "SSH port (default 22).", aliases: ["p", "ssh_port"] },
    ],
  },
  {
    name: "ssh_upload",
    aliases: ["scp_upload", "upload_file", "ssh_put", "scp_put", "send_file", "scp"],
    description: "Copy a LOCAL file to a REMOTE host over SSH/SCP using the user's SSH keys.",
    args: [
      { name: "host", required: true, description: "Remote host/IP, or a ~/.ssh/config alias.", aliases: ["hostname", "server", "ip", "address", "target"] },
      { name: "local_path", required: true, description: "Path to the local file to send.", aliases: ["local", "source", "src", "from", "localPath"] },
      { name: "remote_path", required: true, description: "Destination path on the remote host.", aliases: ["remote", "dest", "destination", "to", "remotePath"] },
      { name: "user", required: false, description: "SSH username.", aliases: ["username", "login"] },
      { name: "port", required: false, description: "SSH port (default 22).", aliases: ["p", "ssh_port"] },
    ],
  },
  {
    name: "ssh_download",
    aliases: ["scp_download", "download_file", "ssh_get", "scp_get", "fetch_file"],
    description: "Copy a REMOTE file to the LOCAL machine over SSH/SCP using the user's SSH keys.",
    args: [
      { name: "host", required: true, description: "Remote host/IP, or a ~/.ssh/config alias.", aliases: ["hostname", "server", "ip", "address", "target"] },
      { name: "remote_path", required: true, description: "Path to the file on the remote host.", aliases: ["remote", "source", "src", "from", "remotePath"] },
      { name: "local_path", required: true, description: "Destination path on this machine.", aliases: ["local", "dest", "destination", "to", "localPath"] },
      { name: "user", required: false, description: "SSH username.", aliases: ["username", "login"] },
      { name: "port", required: false, description: "SSH port (default 22).", aliases: ["p", "ssh_port"] },
    ],
  },
  {
    name: "grep",
    aliases: ["search_files", "search_content", "rg", "ripgrep", "find_in_files", "content_search"],
    description:
      "Regex content search across files under a directory. Returns " +
      "matching {path, line, text} hits. Skips .git / node_modules / " +
      "target / dist / __pycache__ / venv / python_runtime so vendor " +
      "noise is filtered out. Use this to find symbols, callers, " +
      "TODOs, configuration references, anything by content.",
    args: [
      { name: "pattern", required: true, description: "Rust regex to match against each line.", aliases: ["query", "regex", "search", "text", "q"] },
      { name: "path", required: false, description: "Directory to search under. Defaults to '.' (project cwd).", aliases: ["dir", "directory", "folder"] },
      { name: "glob", required: false, description: "Filename glob filter, e.g. '*.rs' or '*.{ts,tsx}'.", aliases: ["filter", "include", "file_pattern"] },
    ],
  },
  {
    name: "glob",
    aliases: ["find_files", "find", "glob_files", "file_search"],
    description:
      "Find files by filename pattern. Walks the tree under `path` " +
      "and returns every file whose name matches `pattern`. Supports " +
      "* (any chars except /), ** (any depth incl. /), ? (one char). " +
      "Use this to discover files when you don't yet know their content.",
    args: [
      { name: "pattern", required: true, description: "Glob pattern, e.g. 'src/**/*.tsx' or '*.py'.", aliases: ["query", "glob", "name", "filename", "q"] },
      { name: "path", required: false, description: "Directory root for the search. Defaults to '.' (project cwd).", aliases: ["dir", "directory", "folder", "root"] },
    ],
  },
  {
    name: "web_search",
    aliases: ["search", "search_web", "websearch", "google", "duckduckgo", "ddg", "brave_search", "internet_search", "web"],
    description:
      "Search the web. Returns up to 5 results (title, url, snippet). " +
      "Automatically uses whichever search backend is configured — an " +
      "installed search MCP server (e.g. DuckDuckGo, which needs no key) is " +
      "preferred, falling back to Brave Search when a key is saved. Use this " +
      "to find competitor products, prior art, documentation, or research.",
    args: [
      { name: "query", required: true, description: "Search query string.", aliases: ["q", "search_query", "text", "search", "term", "keywords"] },
      { name: "max_results", required: false, description: "How many results to return (1-20, default 5).", aliases: ["maxResults", "limit", "count", "num_results", "n", "top_k"] },
    ],
  },
  {
    name: "web_fetch",
    aliases: ["fetch_url", "fetch", "get_url", "open_url", "browse", "http_get", "curl", "visit"],
    description:
      "Fetch a URL and return its readable text (HTML stripped, " +
      "script/style removed, whitespace collapsed). Capped at 60 KB. " +
      "Use this on URLs returned by web_search to extract feature lists, " +
      "documentation, etc.",
    args: [{ name: "url", required: true, description: "Absolute URL to fetch.", aliases: ["link", "address", "uri", "href", "u"] }],
  },
  {
    name: "screenshot_url",
    aliases: ["screenshot", "capture_url", "snapshot_url", "render_url"],
    description:
      "Screenshot a URL via headless Chromium (TwinForge web_adapter). " +
      "Returns the saved PNG path. Use this to capture competitor GUIs " +
      "for the brainstorm GUI-direction synthesis. Output PNG should " +
      "go under <project>/brainstorm/.",
    args: [
      { name: "url", required: true, description: "Absolute URL to screenshot.", aliases: ["link", "address", "uri", "u"] },
      { name: "out_png", required: true, description: "Absolute filesystem path for the output PNG.", aliases: ["out", "output", "output_path", "out_path", "png", "path"] },
    ],
  },
  {
    name: "list_skills",
    aliases: ["skills", "available_skills", "show_skills", "discover_skills"],
    description:
      "List every SKILL pack available to you (name + one-line description). " +
      "Skills are named capability guides bundled with the app. Use this to " +
      "discover a skill you can load_skill() into context for the current task.",
    args: [],
  },
  {
    name: "load_skill",
    aliases: ["use_skill", "open_skill", "skill", "get_skill", "read_skill", "switch_skill", "equip_skill"],
    description:
      "Load the FULL instructions for one SKILL pack into context, by name. " +
      "Call this when the task matches a skill whose body you haven't loaded " +
      "yet — then follow its instructions. You may call it again with a " +
      "different skill to switch skills mid-task, as many times as needed. " +
      "Run list_skills first if you're unsure what's available.",
    args: [
      { name: "name", required: true, description: "The skill's name or id (e.g. 'pdf-processing').", aliases: ["skill", "skill_name", "id", "skill_id", "pack", "ref", "query"] },
    ],
  },
  {
    name: "memory_search",
    aliases: ["recall", "remember", "search_memory", "memory_recall", "query_memory", "lookup_memory", "memory_lookup"],
    description:
      "Search the SHARED TEAM MEMORY — a durable knowledge base the whole team " +
      "writes to (decisions, conventions, build/run commands, file locations, " +
      "gotchas, prior findings). Call this BEFORE asking the user or re-deriving " +
      "something that may already be known. Returns the most relevant entries. " +
      "Pass an empty query to see the most recent entries.",
    args: [
      { name: "query", required: false, description: "Keywords to look up (e.g. 'build command', 'auth flow'). Empty = most recent.", aliases: ["q", "search", "text", "terms", "keywords", "topic"] },
      { name: "limit", required: false, description: "Max entries to return (1-50, default 8).", aliases: ["max", "count", "n", "top_k", "max_results"] },
    ],
  },
  {
    name: "memory_write",
    aliases: ["remember_this", "save_memory", "store_memory", "note", "memorize", "memory_save", "memory_store"],
    description:
      "Save a durable fact to the SHARED TEAM MEMORY so you and other agents can " +
      "recall it later (across dispatches AND future runs). Use for stable, reusable " +
      "knowledge — NOT transient chatter. Provide a short 'key' to UPDATE a known " +
      "fact in place (e.g. key='build_command') instead of duplicating it.",
    args: [
      { name: "content", required: true, description: "The fact/decision to remember, stated plainly and self-contained.", aliases: ["text", "value", "fact", "note", "body", "memory", "data"] },
      { name: "key", required: false, description: "Optional stable id to upsert in place (e.g. 'build_command', 'api_base_url').", aliases: ["name", "id", "slug", "label", "topic"] },
      { name: "tags", required: false, description: "Optional comma-separated tags to aid later search.", aliases: ["tag", "labels", "categories", "keywords"] },
    ],
  },
  {
    name: "memory_read",
    aliases: ["get_memory", "memory_get", "read_memory", "fetch_memory"],
    description:
      "Read ONE shared-memory entry by its exact key (the precise complement to " +
      "memory_search). Returns the stored content, or nothing if that key is unset.",
    args: [
      { name: "key", required: true, description: "The exact key the fact was saved under (e.g. 'build_command').", aliases: ["name", "id", "slug", "label", "query"] },
    ],
  },
  {
    name: "browser_open",
    aliases: ["open_browser", "browser_launch", "start_browser", "browse_to"],
    description:
      "Open a URL in the REAL persistent browser — a native OwLLM browser window " +
      "that keeps the user's cookies/logins across calls (not a headless scrape). " +
      "Works for the public web AND local dev servers (localhost:5173, 127.0.0.1:3000 " +
      "default to http) — use it to check a web app you are building. " +
      "Starts the browser if needed, then navigates. After this, call browser_snapshot " +
      "to get the indexed list of interactive elements before clicking or filling.",
    args: [{ name: "url", required: true, description: "URL to open (e.g. https://example.com or localhost:5173).", aliases: ["link", "address", "uri", "href", "u"] }],
  },
  {
    name: "browser_navigate",
    aliases: ["browser_goto", "navigate", "goto_url", "browser_go"],
    description:
      "Navigate the already-open persistent browser to a new URL (same logged-in " +
      "session; localhost URLs default to http). Call browser_snapshot afterward " +
      "to re-read the interactive elements.",
    args: [{ name: "url", required: true, description: "URL to navigate to (web or localhost).", aliases: ["link", "address", "uri", "href", "u"] }],
  },
  {
    name: "browser_device",
    aliases: ["set_device", "browser_viewport", "mobile_view", "device_mode"],
    description:
      "Switch the browser's device emulation: 'desktop', 'iphone', 'android' or " +
      "'tablet'. Mobile presets resize the viewport to real phone/tablet dimensions " +
      "AND send a mobile user-agent, so responsive layouts and UA-sniffing sites " +
      "behave as on a real device — use it to test how a web app looks on mobile. " +
      "The page reloads; call browser_snapshot afterward for fresh element indexes.",
    args: [{ name: "device", required: true, description: "One of: desktop, iphone, android, tablet.", aliases: ["mode", "preset", "viewport", "d"] }],
  },
  {
    name: "browser_snapshot",
    aliases: ["snapshot", "browser_dom", "browser_elements", "page_snapshot"],
    description:
      "Snapshot the current page and return the INDEXED list of interactive elements " +
      "(links, buttons, inputs) with their index numbers. You act on elements BY INDEX " +
      "with browser_click / browser_fill / browser_select — ALWAYS call this first to " +
      "get fresh indexes before interacting, and again after the page changes.",
    args: [],
  },
  {
    name: "browser_click",
    aliases: ["click", "browser_press_element", "click_element"],
    description:
      "Click the interactive element at the given index from the latest browser_snapshot. " +
      "Snapshot first to get the index; the page may change, so snapshot again after.",
    args: [{ name: "index", required: true, description: "Element index from the latest browser_snapshot.", aliases: ["idx", "i", "element", "element_index", "n"] }],
  },
  {
    name: "browser_fill",
    aliases: ["fill", "type_text", "browser_type", "fill_input"],
    description:
      "Type text into the input/textarea element at the given index from the latest " +
      "browser_snapshot. Snapshot first to get the index.",
    args: [
      { name: "index", required: true, description: "Input element index from the latest browser_snapshot.", aliases: ["idx", "i", "element", "element_index", "n"] },
      { name: "text", required: true, description: "The text to type into the field.", aliases: ["value", "content", "input", "str"] },
    ],
  },
  {
    name: "browser_press",
    aliases: ["press", "browser_key", "press_key", "keypress"],
    description:
      "Press a keyboard key in the persistent browser (e.g. 'Enter', 'Tab', 'Escape', " +
      "'ArrowDown'). Use after browser_fill to submit a form or trigger a handler.",
    args: [{ name: "key", required: true, description: "Key name to press, e.g. 'Enter' or 'Escape'.", aliases: ["k", "keyname", "button"] }],
  },
  {
    name: "browser_select",
    aliases: ["select", "select_option", "browser_choose", "choose_option"],
    description:
      "Select an option (by value) in the <select> dropdown at the given index from the " +
      "latest browser_snapshot. Snapshot first to get the index.",
    args: [
      { name: "index", required: true, description: "Select element index from the latest browser_snapshot.", aliases: ["idx", "i", "element", "element_index", "n"] },
      { name: "value", required: true, description: "The option value to select.", aliases: ["option", "val", "choice"] },
    ],
  },
  {
    name: "browser_screenshot",
    aliases: ["browser_capture", "capture_page", "page_screenshot"],
    description:
      "Report the current page (URL + title + load state) of the persistent browser. " +
      "The browser is a visible window; use browser_snapshot for the element list and " +
      "browser_get_text to read page content.",
    args: [],
  },
  {
    name: "browser_get_text",
    aliases: ["get_text", "browser_text", "page_text", "read_page"],
    description:
      "Return the visible text content of the current page in the persistent browser. " +
      "Use to read article/body content rather than the interactive-element list.",
    args: [],
  },
  {
    name: "browser_back",
    aliases: ["go_back", "browser_history_back", "navigate_back"],
    description: "Go back one entry in the persistent browser's history. Snapshot afterward to re-read elements.",
    args: [],
  },
  {
    name: "browser_reload",
    aliases: ["reload", "browser_refresh", "refresh_page"],
    description: "Reload the current page in the persistent browser. Snapshot afterward to re-read elements.",
    args: [],
  },
  {
    name: "browser_close",
    aliases: ["close_browser", "browser_stop", "stop_browser", "quit_browser"],
    description: "Close/stop the persistent browser session. Reopen later with browser_open.",
    args: [],
  },
  // ---- kvm_node — drive a networked Sipeed NanoKVM as target eyes+hands ----
  // SCOPE: host / local-agent ONLY. This routes through the Tauri `invoke`
  // host command `kvm_node_exec`; subscription-CLI agents (Claude/Codex CLI)
  // run outside the Tauri shell and CANNOT reach the host executor, so the
  // tool is a no-op for them by construction. Gated by the SAME backend
  // feature flag as `kvm_node_exec`; when the flag is off (or the host
  // command isn't built yet) the executor just surfaces the backend's error.
  //
  // The spec framework advertises every arg as a JSON-schema `string`
  // (formatToolsForOpenAI, ~line 543 — llama-server's --jinja grammar only
  // renders scalar-string args), so the nested `target` object and per-action
  // `params` object are passed as JSON *strings* and documented inline below;
  // the executor JSON-parses them before handing to `kvm_node_exec`.
  {
    name: "kvm_node",
    aliases: ["kvm", "nanokvm", "kvm_exec", "kvm_control"],
    description:
      "Control a networked KVM node (Sipeed NanoKVM) as the target machine's eyes + hands. " +
      "Actions: 'screenshot' (capture the target's live video — returns an absolute saved PNG " +
      "path you then view via the normal screenshot/vision path), 'type' (type a text string via " +
      "emulated USB-HID keyboard), 'keys' (press a key chord/sequence, e.g. 'ctrl+alt+del' or " +
      "'Enter'), 'mouse' (move/click the emulated USB-HID mouse), 'boot_key' (tap a boot/BIOS key " +
      "such as F2/F12/Del during POST). Documented STUBS (backend may return not-implemented): " +
      "'mount_iso' (attach a virtual USB ISO), 'power' (press the target's power/reset line). " +
      "Take a 'screenshot' first to see the target before acting.",
    args: [
      {
        name: "action",
        required: true,
        description:
          "One of: screenshot | type | keys | mouse | boot_key | mount_iso | power.",
        aliases: ["op", "command", "cmd", "verb"],
      },
      {
        name: "target",
        required: true,
        description:
          "JSON object identifying the KVM node: " +
          '{ "host": string, "port"?: number, "auth": { "sshKeyPath"?: string, "token"?: string }, ' +
          '"transport": "ssh" | "http" }. Provide EXACTLY one of auth.sshKeyPath or auth.token.',
        aliases: ["node", "device", "kvm_target", "endpoint"],
      },
      {
        name: "params",
        required: false,
        description:
          "JSON object of action-specific params. screenshot: {} — type: {\"text\": string} — " +
          "keys: {\"combo\": string} (e.g. \"ctrl+alt+del\") — mouse: {\"x\"?: number, \"y\"?: number, " +
          "\"button\"?: \"left\"|\"right\"|\"middle\", \"op\"?: \"move\"|\"click\"|\"down\"|\"up\"} — " +
          "boot_key: {\"key\": string} — mount_iso: {\"isoPath\": string} — power: {\"line\": \"power\"|\"reset\"}.",
        aliases: ["arguments", "options", "opts", "payload"],
      },
    ],
  },
];

/// Shared agent-browser tools — the native in-app browser window is ONE session
/// shared by the user and every agent, so (like memory) it's a cross-cutting
/// capability: NEVER gated by a role's tool_allowlist, always advertised.
/// Without this, specialists with a concrete allowlist (none of the role YAMLs
/// list browser_*) could not see the page the user just opened — the exact
/// "I can't see your browser" failure. Derived from the specs so a new
/// browser_* tool is automatically included.
export const BROWSER_TOOL_NAMES = new Set(
  LOCAL_TOOL_SPECS.filter((t) => t.name.startsWith("browser_")).map((t) => t.name),
);

// ---- Canonical-name + arg-alias resolution (the "normalize" half of
// the universal tool layer). Built once from LOCAL_TOOL_SPECS so the
// lookups are O(1) and stay in sync with the registry automatically.

const _toolNameIndex: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const spec of LOCAL_TOOL_SPECS) {
    m.set(spec.name.toLowerCase(), spec.name);
    for (const a of spec.aliases ?? []) m.set(a.toLowerCase(), spec.name);
  }
  return m;
})();

// Per-canonical-tool map of { argAlias → canonicalArgName }.
const _argAliasIndex: Map<string, Map<string, string>> = (() => {
  const m = new Map<string, Map<string, string>>();
  for (const spec of LOCAL_TOOL_SPECS) {
    const inner = new Map<string, string>();
    for (const arg of spec.args) {
      inner.set(arg.name.toLowerCase(), arg.name);
      for (const a of arg.aliases ?? []) inner.set(a.toLowerCase(), arg.name);
    }
    m.set(spec.name, inner);
  }
  return m;
})();

/// Resolve a model-emitted tool name to its canonical registry name.
/// Handles case, dotted namespaces (`browser.search` → `search`),
/// hyphen/underscore drift (`web-search` → `web_search`), and the
/// MCP `mcp:server:tool` / `mcp__server__tool` forms (passed through).
/// Returns null when nothing matches — caller surfaces a structured
/// "unknown tool" error back to the model.
export function canonicalToolName(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  // MCP tools route by their own qualified name — leave intact.
  if (trimmed.startsWith("mcp:")) return trimmed;
  if (trimmed.startsWith("mcp__")) return trimmed.replace(/__/g, ":");
  const lower = trimmed.toLowerCase();
  // Direct / alias hit.
  if (_toolNameIndex.has(lower)) return _toolNameIndex.get(lower)!;
  // Strip a dotted namespace prefix: `browser.search` → `search`.
  const lastDot = lower.lastIndexOf(".");
  if (lastDot >= 0) {
    const tail = lower.slice(lastDot + 1);
    if (_toolNameIndex.has(tail)) return _toolNameIndex.get(tail)!;
  }
  // Normalise hyphen/space → underscore and retry.
  const normalized = lower.replace(/[-\s]+/g, "_");
  if (_toolNameIndex.has(normalized)) return _toolNameIndex.get(normalized)!;
  return null;
}

/// Map an args object's keys from whatever the model used to the
/// canonical arg names for `toolName`. Unknown keys are kept as-is
/// (some MCP tools have args we don't model) but logged. Values are
/// coerced to strings to match executeToolCall's Record<string,string>.
export function resolveArgAliases(toolName: string, rawArgs: Record<string, unknown>): Record<string, string> {
  const inner = _argAliasIndex.get(toolName);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawArgs)) {
    const canonical = inner?.get(k.toLowerCase()) ?? k;
    out[canonical] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

/// The first required arg name for a tool, or null. Used by the
/// normalizer to bind a positional value (ReAct `Action Input: foo`,
/// Python `tool("foo")`) to the right key.
export function firstRequiredArg(toolName: string): string | null {
  const spec = LOCAL_TOOL_SPECS.find((s) => s.name === toolName);
  if (!spec) return null;
  return spec.args.find((a) => a.required)?.name ?? spec.args[0]?.name ?? null;
}

export type ValidationResult = {
  ok: boolean;
  /// Human-readable, schema-shaped error the model can self-correct
  /// from. Empty when ok.
  error: string;
};

/// Validate a (canonical) call against the registry schema. Checks the
/// tool exists and every required arg is present + non-empty. Returns a
/// structured error string (listing the expected schema) so the dispatch
/// loop can hand it back to the model instead of silently failing or
/// executing a half-formed call. MCP tools skip arg validation (their
/// schema lives server-side).
export function validateCall(call: ToolCall): ValidationResult {
  if (call.name.startsWith("mcp:")) return { ok: true, error: "" };
  const spec = LOCAL_TOOL_SPECS.find((s) => s.name === call.name);
  if (!spec) {
    const known = LOCAL_TOOL_SPECS.map((s) => s.name).join(", ");
    return { ok: false, error: `Unknown tool "${call.name}". Available tools: ${known}.` };
  }
  const missing = spec.args
    .filter((a) => a.required && !(call.args[a.name] && String(call.args[a.name]).trim()))
    .map((a) => a.name);
  if (missing.length > 0) {
    const schema = spec.args
      .map((a) => `${a.name}${a.required ? "" : "?"}: string  // ${a.description}`)
      .join("\n  ");
    return {
      ok: false,
      error:
        `Tool "${call.name}" is missing required argument${missing.length > 1 ? "s" : ""}: ` +
        `${missing.join(", ")}.\nExpected arguments:\n  ${schema}`,
    };
  }
  return { ok: true, error: "" };
}

export type ToolExecResult = {
  ok: boolean;
  output: string;
};

/// Execute one tool call against the Rust agent_tools commands. Returns
/// a (truncated) human-readable string for splicing back into the
/// conversation as a synthetic user turn. Failures come back with ok:false
/// and the error message — the model decides whether to retry/give up.
/// Run one native tool call. Thin wrapper that also counts failures into
/// The Watcher's local activity stats (product telemetry: tool NAME only,
/// never arguments or output — P0-8 Slice 4).
export async function executeToolCall(call: ToolCall, projectCwd: string): Promise<ToolExecResult> {
  const r = await executeToolCallInner(call, projectCwd);
  if (!r.ok) {
    try { bumpActivity(`tool-fail:${call.name}`); } catch { /* stats must never break a turn */ }
  }
  return r;
}

async function executeToolCallInner(call: ToolCall, projectCwd: string): Promise<ToolExecResult> {
  const cwd = projectCwd || undefined;
  // MCP-routed call: name is `mcp:<server>:<tool>`. Split, pass the
  // args dict through as the arguments object — most MCP tools use
  // a flat schema so the dict matches. Failures come back from the
  // MCP server with the right context.
  if (call.name.startsWith("mcp:")) {
    const rest = call.name.slice(4);
    const sep = rest.indexOf(":");
    if (sep <= 0) {
      return { ok: false, output: `bad MCP tool name (expected mcp:<server>:<tool>): ${call.name}` };
    }
    const server = rest.slice(0, sep);
    const tool = rest.slice(sep + 1);
    try {
      const text = await invoke<string>("mcp_call_tool", {
        server, tool, arguments: call.args,
      });
      return { ok: true, output: truncate(text, 8000) };
    } catch (e) {
      return { ok: false, output: String(e) };
    }
  }
  try {
    switch (call.name) {
      case "read_file": {
        const text = await invoke<string>("tool_read_file", { path: call.args.path, cwd });
        return { ok: true, output: truncate(text, 8000) };
      }
      case "write_file_with_diff":
      case "write_file": { // accept legacy alias too
        await invoke("tool_write_file", {
          path: call.args.path,
          content: call.args.content ?? "",
          cwd,
        });
        return { ok: true, output: `wrote ${call.args.path}` };
      }
      case "edit_file": {
        // String-replace semantics: read, replace exact old_string with
        // new_string, write back. Matches the legacy edit_file tool.
        const text = await invoke<string>("tool_read_file", { path: call.args.path, cwd });
        const old_s = call.args.old_string ?? "";
        const new_s = call.args.new_string ?? "";
        if (!old_s) return { ok: false, output: "edit_file: old_string is required" };
        if (!text.includes(old_s)) {
          return { ok: false, output: `edit_file: old_string not found in ${call.args.path}` };
        }
        const updated = text.replace(old_s, new_s);
        await invoke("tool_write_file", { path: call.args.path, content: updated, cwd });
        return { ok: true, output: `edited ${call.args.path}` };
      }
      case "list_dir": {
        const entries = await invoke<Array<{ name: string; kind: string; size?: number }>>(
          "tool_list_dir", { path: call.args.path, cwd },
        );
        const lines = entries.map((e) =>
          e.kind === "dir" ? `📁 ${e.name}/` : `📄 ${e.name}${e.size != null ? ` (${e.size}b)` : ""}`,
        );
        return { ok: true, output: lines.join("\n") || "(empty)" };
      }
      case "create_dir": {
        await invoke("tool_create_dir", { path: call.args.path, cwd });
        return { ok: true, output: `created ${call.args.path}` };
      }
      case "shell":
      case "shell_exec": { // accept legacy alias too
        const r = await invoke<{ stdout: string; stderr: string; exitCode: number }>(
          "tool_shell_exec", { command: call.args.command, cwd },
        );
        const parts: string[] = [];
        if (r.stdout.trim()) parts.push(`stdout:\n${truncate(r.stdout, 4000)}`);
        if (r.stderr.trim()) parts.push(`stderr:\n${truncate(r.stderr, 2000)}`);
        parts.push(`exit_code: ${r.exitCode}`);
        return { ok: r.exitCode === 0, output: parts.join("\n\n") };
      }
      case "publish_release": {
        // Host-side build+sign+publish. cwd is the project root (the repo to ship).
        const log = await invoke<string>("publish_release", {
          repoDir: cwd ?? ".",
          notes: call.args.notes ?? null,
          dryRun: /^(true|1|yes)$/i.test(String(call.args.dry_run ?? "")),
          draft: /^(true|1|yes)$/i.test(String(call.args.draft ?? "")),
        });
        return { ok: true, output: truncate(log, 6000) };
      }
      case "ssh_exec":
      case "ssh": {
        const r = await invoke<{ stdout: string; stderr: string; exitCode: number }>(
          "tool_ssh_exec", {
            host: call.args.host,
            command: call.args.command,
            user: call.args.user ?? null,
            port: call.args.port ? Number(call.args.port) : null,
            identity: null,
          },
        );
        const parts: string[] = [];
        if (r.stdout.trim()) parts.push(`stdout:\n${truncate(r.stdout, 4000)}`);
        if (r.stderr.trim()) parts.push(`stderr:\n${truncate(r.stderr, 2000)}`);
        parts.push(`exit_code: ${r.exitCode}`);
        return { ok: r.exitCode === 0, output: parts.join("\n\n") };
      }
      case "ssh_upload": {
        const r = await invoke<{ stdout: string; stderr: string; exitCode: number }>(
          "tool_ssh_upload", {
            host: call.args.host,
            localPath: call.args.local_path,
            remotePath: call.args.remote_path,
            user: call.args.user ?? null,
            port: call.args.port ? Number(call.args.port) : null,
            identity: null,
          },
        );
        return {
          ok: r.exitCode === 0,
          output: r.exitCode === 0
            ? `uploaded ${call.args.local_path} → ${call.args.host}:${call.args.remote_path}`
            : `scp failed (exit ${r.exitCode})\n${truncate(r.stderr, 2000)}`,
        };
      }
      case "ssh_download": {
        const r = await invoke<{ stdout: string; stderr: string; exitCode: number }>(
          "tool_ssh_download", {
            host: call.args.host,
            remotePath: call.args.remote_path,
            localPath: call.args.local_path,
            user: call.args.user ?? null,
            port: call.args.port ? Number(call.args.port) : null,
            identity: null,
          },
        );
        return {
          ok: r.exitCode === 0,
          output: r.exitCode === 0
            ? `downloaded ${call.args.host}:${call.args.remote_path} → ${call.args.local_path}`
            : `scp failed (exit ${r.exitCode})\n${truncate(r.stderr, 2000)}`,
        };
      }
      case "grep": {
        const hits = await invoke<Array<{ path: string; line: number; text: string }>>(
          "tool_grep", {
            pattern: call.args.pattern ?? "",
            path: call.args.path ?? null,
            glob: call.args.glob ?? null,
            cwd,
          },
        );
        if (hits.length === 0) return { ok: true, output: "(no matches)" };
        const lines = hits.map(h => `${h.path}:${h.line}: ${h.text}`);
        return { ok: true, output: truncate(lines.join("\n"), 8000) };
      }
      case "glob": {
        const paths = await invoke<string[]>("tool_glob", {
          pattern: call.args.pattern ?? "",
          path: call.args.path ?? null,
          cwd,
        });
        if (paths.length === 0) return { ok: true, output: "(no files matched)" };
        return { ok: true, output: truncate(paths.join("\n"), 8000) };
      }
      case "web_search": {
        const mcpSearch = await findPreferredMcpSearchTool();
        if (mcpSearch) {
          const text = await invoke<string>("mcp_call_tool", {
            server: mcpSearch.server,
            tool: mcpSearch.tool,
            arguments: buildMcpSearchArgs(mcpSearch, call),
          });
          return { ok: true, output: truncate(text, 8000) };
        }
        const maxRaw = call.args.max_results;
        const max = maxRaw ? Math.max(1, Math.min(20, Number(maxRaw) || 5)) : 5;
        const hits = await invoke<Array<{ title: string; url: string; description: string }>>(
          "tool_web_search", { query: call.args.query ?? "", maxResults: max },
        );
        if (hits.length === 0) return { ok: true, output: "(no results)" };
        const lines = hits.map((h, i) =>
          `${i + 1}. ${h.title}\n   ${h.url}\n   ${truncate(h.description, 200)}`
        );
        return { ok: true, output: lines.join("\n\n") };
      }
      case "web_fetch": {
        const text = await invoke<string>("tool_web_fetch", { url: call.args.url ?? "" });
        return { ok: true, output: truncate(text, 12000) };
      }
      case "screenshot_url": {
        const saved = await invoke<string>("tool_screenshot_url", {
          url: call.args.url ?? "",
          outPng: call.args.out_png ?? "",
        });
        return { ok: true, output: `screenshot saved: ${saved}` };
      }
      case "list_skills": {
        const brief = await skillCatalogBrief();
        return { ok: true, output: `Available skills:\n${brief}\n\nLoad one with load_skill("<name>").` };
      }
      case "load_skill": {
        const ref = call.args.name ?? call.args.skill ?? "";
        if (!ref.trim()) return { ok: false, output: "load_skill: 'name' is required (the skill name or id)." };
        const skill = await loadSkillByRef(ref);
        if (!skill) {
          const brief = await skillCatalogBrief();
          return { ok: false, output: `No skill matching "${ref}". Available skills:\n${brief}` };
        }
        if (!skill.body.trim()) {
          return { ok: true, output: `Skill "${skill.name}" has no instructions body.` };
        }
        return {
          ok: true,
          output: `Loaded skill "${skill.name}". Follow these instructions for the current task:\n\n${truncate(skill.body.trim(), 12000)}`,
        };
      }
      case "memory_search": {
        // Shared team memory, scoped to the stable project ID (Rust maps "" → "global").
        const memScope = _teamMemoryScope || projectCwd || "";
        const entries = await invoke<RawTeamMemEntry[]>(
          "team_memory_search",
          { scope: memScope, query: call.args.query ?? "", limit: clampInt(call.args.limit, 8, 1, 50) },
        );
        if (!entries.length) {
          return { ok: true, output: "Team memory: no matching entries. (Save useful facts with memory_write.)" };
        }
        const rendered = entries.map((e) => {
          const k = e.key ? `[${e.key}] ` : "";
          const tg = e.tags && e.tags !== "worklog" ? `  (tags: ${e.tags})` : "";
          const wl = e.kind === "worklog" ? " (worklog)" : "";
          return `• ${k}${e.content}${tg}${wl}`;
        }).join("\n");
        return { ok: true, output: `Team memory (${entries.length}):\n${rendered}` };
      }
      case "memory_write": {
        const content = call.args.content ?? "";
        if (!content.trim()) return { ok: false, output: "memory_write: 'content' is required." };
        const id = await invoke<number>("team_memory_write", {
          scope: _teamMemoryScope || projectCwd || "",
          content,
          key: call.args.key ?? "",
          tags: call.args.tags ?? "",
          author: "",
        });
        // Keep the injected snapshot warm so later agents in this run see it.
        await refreshTeamMemorySnapshot();
        const k = call.args.key ? ` under key "${call.args.key}"` : "";
        return { ok: true, output: `Saved to team memory${k} (#${id}).` };
      }
      case "memory_read": {
        const key = call.args.key ?? "";
        if (!key.trim()) return { ok: false, output: "memory_read: 'key' is required." };
        const entry = await invoke<{ id: number; key: string; content: string; tags: string; author: string; ts: number } | null>(
          "team_memory_read",
          { scope: _teamMemoryScope || projectCwd || "", key },
        );
        if (!entry) return { ok: true, output: `Team memory: nothing stored under key "${key}".` };
        return { ok: true, output: entry.content };
      }
      case "browser_open": {
        // Real persistent logged-in browser: ensure the daemon, start it, then navigate.
        await invoke("browser_ensure");
        await invoke("browser_start");
        const result = await invoke<string>("browser_cmd", { action: "navigate", params: { url: call.args.url } });
        return { ok: true, output: truncate(result, 8000) };
      }
      case "browser_navigate": {
        const result = await invoke<string>("browser_cmd", { action: "navigate", params: { url: call.args.url } });
        return { ok: true, output: truncate(result, 8000) };
      }
      case "browser_device": {
        const result = await invoke<string>("browser_set_device", { device: String(call.args.device ?? "") });
        return { ok: true, output: truncate(result, 8000) };
      }
      case "browser_snapshot": {
        const result = await invoke<string>("browser_cmd", { action: "snapshot", params: {} });
        return { ok: true, output: truncate(result, 8000) };
      }
      case "browser_click": {
        const result = await invoke<string>("browser_cmd", { action: "click", params: { index: Number(call.args.index) } });
        return { ok: true, output: truncate(result, 8000) };
      }
      case "browser_fill": {
        const result = await invoke<string>("browser_cmd", { action: "fill", params: { index: Number(call.args.index), text: call.args.text } });
        return { ok: true, output: truncate(result, 8000) };
      }
      case "browser_press": {
        const result = await invoke<string>("browser_cmd", { action: "press", params: { key: call.args.key } });
        return { ok: true, output: truncate(result, 8000) };
      }
      case "browser_select": {
        const result = await invoke<string>("browser_cmd", { action: "select", params: { index: Number(call.args.index), value: call.args.value } });
        return { ok: true, output: truncate(result, 8000) };
      }
      case "browser_screenshot": {
        const result = await invoke<string>("browser_cmd", { action: "screenshot", params: {} });
        return { ok: true, output: truncate(result, 8000) };
      }
      case "browser_get_text": {
        const result = await invoke<string>("browser_cmd", { action: "get_text", params: {} });
        return { ok: true, output: truncate(result, 8000) };
      }
      case "browser_back": {
        const result = await invoke<string>("browser_cmd", { action: "back", params: {} });
        return { ok: true, output: truncate(result, 8000) };
      }
      case "browser_reload": {
        const result = await invoke<string>("browser_cmd", { action: "reload", params: {} });
        return { ok: true, output: truncate(result, 8000) };
      }
      case "browser_close": {
        const result = await invoke<string>("browser_stop");
        return { ok: true, output: truncate(result, 8000) };
      }
      case "kvm_node": {
        // Host/local-agent ONLY — routes to the Tauri host command
        // `kvm_node_exec` exactly like the browser tools route to `browser_cmd`.
        // Subscription-CLI agents run outside the Tauri shell and can't reach it.
        // The nested `target` / `params` objects arrive as JSON strings (the
        // spec framework coerces every arg to a string); parse them here.
        const action = (call.args.action ?? "").trim();
        if (!action) return { ok: false, output: "kvm_node: 'action' is required (screenshot|type|keys|mouse|boot_key|mount_iso|power)." };
        let target: unknown;
        try {
          target = call.args.target ? JSON.parse(call.args.target) : undefined;
        } catch {
          return { ok: false, output: "kvm_node: 'target' must be a JSON object {host, port?, auth{sshKeyPath?|token?}, transport}." };
        }
        if (!target || typeof target !== "object") {
          return { ok: false, output: "kvm_node: 'target' is required — a JSON object {host, port?, auth{sshKeyPath?|token?}, transport}." };
        }
        let params: unknown = {};
        if (call.args.params) {
          try { params = JSON.parse(call.args.params); }
          catch { return { ok: false, output: "kvm_node: 'params' must be a JSON object for the chosen action." }; }
        }
        // Frozen envelope shape from the backend contract: {ok, action, data?, error?}.
        const env = await invokeKvmNode(target, action, params);
        if (!env.ok) {
          return { ok: false, output: env.error ?? `kvm_node ${action} failed.` };
        }
        if (action === "screenshot") {
          // Path-based hand-off — mirror screenshot_url/browser_screenshot: surface
          // the ABSOLUTE saved PNG path as text so the existing vision path picks it
          // up. NO base64, NO second image pipeline.
          const imagePath = (env.data as { imagePath?: string } | undefined)?.imagePath;
          if (!imagePath) return { ok: false, output: "kvm_node screenshot: backend returned no imagePath." };
          return { ok: true, output: `screenshot saved: ${imagePath}` };
        }
        return { ok: true, output: truncate(JSON.stringify(env.data ?? { ok: true }), 8000) };
      }
      default:
        return { ok: false, output: `unknown tool: ${call.name}` };
    }
  } catch (e) {
    return { ok: false, output: String(e) };
  }
}

/// Frozen `kvm_node_exec` return envelope (Rust: Result<serde_json::Value,String>
/// whose Ok value is this object). data is action-specific (screenshot →
/// { imagePath }); error is set when ok is false.
type KvmNodeEnvelope = { ok: boolean; action: string; data?: unknown; error?: string };

/// Invoke the `kvm_node_exec` host command, mirroring how the browser tools
/// invoke `browser_cmd`. If the command isn't registered yet in this build
/// (backend not shipped), `invoke` rejects — we fall back to the FROZEN
/// envelope shape { ok, action, error } so the tool degrades to a clear
/// "unavailable" error instead of an opaque crash. No fabricated success.
async function invokeKvmNode(target: unknown, action: string, params: unknown): Promise<KvmNodeEnvelope> {
  try {
    return await invoke<KvmNodeEnvelope>("kvm_node_exec", { target, action, params });
  } catch (e) {
    return { ok: false, action, error: `kvm_node_exec host command unavailable: ${String(e)}` };
  }
}

/// Parse a model-supplied integer arg (they often send strings), clamping to
/// [min,max] with a default when absent/garbage. Used by memory_search.limit.
function clampInt(v: string | undefined, def: number, min: number, max: number): number {
  const n = parseInt(String(v ?? "").trim(), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated, ${s.length - max} more chars]`;
}

/// Render a batch of tool results as a single synthetic user turn the
/// model gets back. Matches the Python loop's "tool results follow"
/// envelope so the model knows what's user vs assistant.
export function renderToolResultsForModel(
  calls: ToolCall[],
  results: ToolExecResult[],
): string {
  const lines = ["[tool results — continue when ready; emit no tool_call blocks to end]"];
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    const r = results[i];
    const argsRender = Object.entries(c.args)
      .map(([k, v]) => `${k}=${truncate(v, 120).replace(/\n/g, " ")}`)
      .join(", ");
    lines.push("");
    lines.push(`▶ ${c.name}(${argsRender}) → ${r.ok ? "ok" : "error"}`);
    lines.push(r.output);
  }
  return lines.join("\n");
}

/// Render a batch of VALIDATION errors (calls that failed schema check
/// before execution) as a synthetic user turn. Unlike a runtime error,
/// this tells the model exactly what shape it should have emitted so it
/// can self-correct on the next turn — the "return structured errors to
/// the model" half of the universal layer.
export function renderValidationErrorsForModel(
  errors: Array<{ name: string; error: string }>,
): string {
  const lines = [
    "[tool call rejected — the call(s) below were malformed and NOT executed.",
    "Fix the arguments and emit the tool_call again, or give your final answer.]",
  ];
  for (const e of errors) {
    lines.push("");
    lines.push(`✗ ${e.name}: ${e.error}`);
  }
  return lines.join("\n");
}
