#!/usr/bin/env node
// Why this gate exists — a real team run died like this:
//   1. The orchestrator was told "You are READ-ONLY", but codex ran under
//      `--sandbox workspace-write`, so it edited the shared checkout anyway.
//   2. Every specialist worktree then refused to cut from a dirty checkout, the
//      dispatch aborted before a single specialist started, and the Notebook
//      queue idled forever with no recovery.
//   3. The dispatch that started it all was 778,606 characters — 210,669 input
//      tokens against a 258,400-token window — because the entire project
//      transcript was inlined uncapped.
// Each of the three is asserted here so none can come back silently.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1)));
const UI = path.resolve(HERE, "../..");
const APP = path.resolve(UI, "../..");
const read = (relative) => fs.readFileSync(path.join(UI, relative), "utf8").replace(/\r\n/g, "\n");
const checks = [];
function check(name, condition) {
  checks.push({ name, ok: Boolean(condition) });
  if (!condition) throw new Error(`FAIL ${name}`);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-team-continuity-"));
try {
  const load = async (source, name) => {
    const modulePath = path.join(temp, name);
    fs.writeFileSync(modulePath, ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    }).outputText);
    return await import(pathToFileURL(modulePath).href);
  };
  // agentSandbox decides whether an agent's process may write, so it carries no
  // imports and is proved on its own.
  const sandbox = await load(read("pages/agentic/agentSandbox.ts"), "agentSandbox.mjs");
  const runtimeSource = read("pages/agentic/personalAgentRuntime.ts");
  check("The personal-policy marker convention agentSandbox matches still holds",
    /PERSONAL_POLICY_MARKER = "__owllm_[a-z_]+__"/.test(runtimeSource)
      && /PERSONAL_SKILL_PREFIX = "__owllm_[a-z_]+__:/.test(runtimeSource)
      && /PERSONAL_MEMORY_PREFIX = "__owllm_[a-z_]+__:/.test(runtimeSource));

  // ---- 1. read-only is derived from the allowlist the dispatcher builds ----
  check("The orchestrator's read tool set is classified read-only",
    sandbox.isReadOnlyToolAllowlist(sandbox.READONLY_LOCAL_TOOLS) === true);
  check("A narrowed read-only orchestrator is still read-only",
    sandbox.isReadOnlyToolAllowlist(["read_file", "grep"]) === true);
  check("A personal-policy orchestrator is read-only through its markers",
    sandbox.isReadOnlyToolAllowlist([
      "__owllm_personal_policy__", "__owllm_memory__:orch", "__owllm_skill__:planning",
      "read_file", "list_dir",
    ]) === true);
  check("A specialist that can write is never downgraded to read-only",
    sandbox.isReadOnlyToolAllowlist(["read_file", "write_file_with_diff", "shell"]) === false);
  check("A specialist holding only shell is not read-only",
    sandbox.isReadOnlyToolAllowlist(["shell"]) === false);
  check("An unrestricted agent keeps its writable workspace",
    sandbox.isReadOnlyToolAllowlist(undefined) === false
      && sandbox.isReadOnlyToolAllowlist([]) === false);
  check("A browser agent is never classified read-only",
    sandbox.isReadOnlyToolAllowlist(["read_file", "mcp__owllm__browser_click"]) === false);

  // ---- 2. the flag actually reaches the process sandbox ----
  const dispatch = read("pages/agentic/dispatch.ts");
  // readOnly used to be an ordinary caller-supplied argument, and exactly ONE of
  // the CLI invoke sites ever passed it — so the Codex path looked fixed while
  // every Claude and Kimi orchestrator still ran with no write boundary. Each
  // stream runner now DERIVES it from the allowlist it was handed, which is the
  // real invariant: a runner that forgets to ask cannot exist.
  check("Read-only intent is derived from the allowlist, not left to the caller",
    sandbox.isAgentReadOnly({ allowedTools: ["read_file", "grep"] }) === true
      && sandbox.isAgentReadOnly({ allowedTools: ["shell"] }) === false
      && sandbox.isAgentReadOnly({}) === false);
  check("An explicit readOnly from a caller is never downgraded",
    sandbox.isAgentReadOnly({ readOnly: true, allowedTools: ["shell"] }) === true);
  check("Every CLI stream runner derives readOnly rather than trusting its caller",
    (dispatch.match(/readOnly: isAgentReadOnly\(args\)/g) || []).length === 3);
  check("The chat/bridge codex path derives readOnly from the allowlist",
    dispatch.includes("readOnly: isReadOnlyToolAllowlist(allowedTools)"));
  const page = read("pages/agentic/AgentsPage.tsx");
  // AgentsPage's ~1000-line dispatch copy was collapsed onto dispatch.ts
  // (2026-08-14). The read-only invariant now has exactly ONE home — and the
  // copy must never come back: a page-local CLI invoke would dodge every
  // derivation below.
  check("The agentic page carries NO private CLI invoke (the copy stays dead)",
    !page.includes('invoke<string>("claude_cli_complete"')
      && !page.includes('invoke<string>("claude_cli_stream"')
      && !page.includes('invoke<string>("codex_cli_complete"')
      && !page.includes("async function streamChatCompletion")
      && !page.includes("async function streamAnthropic"));
  check("The agentic page routes through the ONE shared dispatch stack",
    page.includes("streamChatCompletion,") && page.includes('from "./dispatch"'));
  // Two capabilities that previously existed ONLY in the AgentsPage copy and
  // would silently vanish if the shared stack regressed:
  // (a) user-consented home access reaches every Claude CLI invoke;
  check("grantHome rides every Claude CLI invoke in the shared stack",
    (dispatch.match(/grantHome: grantHomeThisRun/g) || []).length >= 3
      && dispatch.includes("export function setGrantHomeThisRun"));
  // (b) an image attached to a text-only CLI sub path warns instead of
  //     silently dropping (Kimi/Gemini CLIs have no image channel).
  check("CLI image drop warns the user in the shared router",
    dispatch.includes("can't be sent via the ${providerName} CLI subscription path"));
  check("The one-shot claude_cli_complete paths carry it as well",
    (dispatch.match(/readOnly: isReadOnlyToolAllowlist\(allowedTools\)/g) || []).length >= 3);
  check("AgentsPage no longer keeps a private copy of the read-only tool set",
    !page.includes("const READONLY_LOCAL_TOOLS: string[] = [")
      && page.includes('from "./agentSandbox"'));
  const accounts = fs.readFileSync(path.join(APP, "src-tauri/src/accounts.rs"), "utf8").replace(/\r\n/g, "\n");
  check("codex_cli_stream accepts the read-only flag",
    accounts.includes("read_only: Option<bool>"));
  check("A read-only agent gets --sandbox read-only, ahead of any escalation",
    /let sandbox_mode = if agent_read_only \{\s*"read-only"\s*\} else if gateway_wired \{\s*"danger-full-access"/.test(accounts));
  // Codex is not the only CLI that ships its own write tools. Claude Code owns
  // Edit/Write/Bash and Kimi's --print mode auto-approves every call, so each
  // needs its own boundary or a read-only role is read-only in name only.
  check("Both Claude CLI entry points strip the write tools for a read-only agent",
    (accounts.match(/args\.push\("--disallowedTools"\.into\(\)\);\s*\n\s*args\.push\("Edit Write NotebookEdit Bash"\.into\(\)\);/g) || []).length === 2);
  // This check used to assert the OPPOSITE — that a read-only agent must never
  // get bypassPermissions — and so certified the bug. `claude -p` is
  // non-interactive: in any mode but bypass it hard-denies every tool outside
  // --allowedTools ("Claude requested permissions to use WebSearch, but you
  // haven't granted it yet"), and no prompt can ever be answered. The write
  // boundary is the disallow list, which outranks the mode — verified against
  // Claude Code 2.1.197: bypassPermissions + --disallowedTools removes Write from
  // the session ("No such tool available: Write") and writes no file.
  check("Neither Claude entry point can leave an agent in a promptless default mode",
    (accounts.match(/if agent_read_only \|\| auto_approve\.unwrap_or\(false\) \{\s*\n\s*args\.push\("--permission-mode"\.into\(\)\);/g) || []).length === 2);
  check("No Claude path makes the permission mode an else-branch of read-only",
    !/--disallowedTools[\s\S]{0,160}?\} else if auto_approve/.test(accounts));
  // web_search/web_fetch read the outside world and write nothing. Omitting them
  // silently deleted orchestrator.yaml's explicit read-only web grant, because
  // runtimeReadOnlyTools narrows a role by intersecting with this exact list.
  check("The read-only tool set keeps the read-only web tools",
    sandbox.READONLY_LOCAL_TOOLS.includes("web_search")
      && sandbox.READONLY_LOCAL_TOOLS.includes("web_fetch")
      && sandbox.isReadOnlyToolAllowlist(["read_file", "web_search", "web_fetch"]) === true);
  check("Granting web access does not make a writing allowlist look read-only",
    sandbox.isReadOnlyToolAllowlist(["read_file", "web_search", "write_file_with_diff"]) === false);
  check("Kimi's read-only agent runs in plan mode",
    /if read_only\.unwrap_or\(false\) \{\s*args\.push\("--plan"\.into\(\)\);/.test(accounts));
  // The filesystem SCOPE is a separate axis from the tool allowlist: --add-dir
  // hands the CLI the whole %USERPROFILE%. claude_cli_stream accepted grant_home
  // and never read it, widening on EVERY dispatch — so the consent modal decided
  // nothing on the path the desktop UI actually takes.
  check("Both Claude entry points widen the filesystem scope only on consent",
    (accounts.match(/if grant_home\.unwrap_or\(false\) \{\s*\n\s*for dir in crate::sandbox::extra_allowed_dirs/g) || []).length === 2);
  check("No Claude path widens to the home profile unconditionally",
    !/\n {8}for dir in crate::sandbox::extra_allowed_dirs/.test(accounts));

  // ---- 3. a dirty checkout no longer aborts a run ----
  const fleet = fs.readFileSync(path.join(APP, "src-tauri/src/fleet.rs"), "utf8").replace(/\r\n/g, "\n");
  check("Worktree creation can checkpoint uncommitted work",
    fleet.includes("fn checkpoint_uncommitted(")
      && fleet.includes("checkpoint_dirty: Option<bool>"));
  check("The checkpoint stages tracked work only and drops app scratch",
    /fn checkpoint_uncommitted[\s\S]*?"add", "-u"[\s\S]*?unstage_app_scratch\(cwd\)/.test(fleet));
  check("The checkpoint cannot be wedged by a repo pre-commit hook",
    /fn checkpoint_uncommitted[\s\S]*?"commit", "--no-verify"/.test(fleet));
  check("A dirty checkout still stops when no run asked for a checkpoint",
    fleet.includes("if !checkpoint_dirty.unwrap_or(false) {"));
  check("Agent runs opt in to the checkpoint",
    page.match(/checkpointDirty: true/g)?.length >= 3);
  const codePage = read("pages/agentic/CodePage.tsx");
  const codeOpenStart = codePage.indexOf("const openWorkspace = async");
  const codeOpenEnd = codePage.indexOf("const removeWorktree = async", codeOpenStart);
  const codeOpen = codeOpenStart >= 0 && codeOpenEnd > codeOpenStart
    ? codePage.slice(codeOpenStart, codeOpenEnd) : "";
  check("Opening a Code page never opts in",
    !!codeOpen && !codeOpen.includes("checkpointDirty"));
  check("An explicit second-agent run checkpoints the first pane before branching",
    /agentName: "code-2"[\s\S]{0,160}?checkpointDirty: true/.test(codePage));
  check("The native suite proves both the run and page-open behaviours",
    fleet.includes("agent_run_checkpoints_uncommitted_work_instead_of_deadlocking")
      && fleet.includes("opening_a_page_never_commits_on_the_users_behalf"));
  const isolation = read("pages/agentic/worktreeIsolation.ts");
  check("A checkpoint is disclosed to the user with an undo",
    isolation.includes("export function worktreeCheckpointNotice(")
      && isolation.includes("git reset --soft HEAD~1"));
  check("The run surfaces that notice instead of committing silently",
    page.includes("worktreeCheckpointNotice(res)")
      && page.includes("worktreeCheckpointNotice(soloCreate)"));

  // ---- 4. the folded transcript is bounded ----
  const fold = dispatch.slice(dispatch.indexOf("export const MAX_FOLDED_HISTORY_TURNS"));
  const folder = await load(fold.slice(0, fold.indexOf("function buildKimiCliPrompt")), "fold.mjs");
  check("The fold budget is declared and bounded",
    folder.MAX_FOLDED_HISTORY_TURNS > 0 && folder.MAX_FOLDED_HISTORY_CHARS <= 100_000);
  check("An empty history still yields the bare user message",
    folder.foldHistoryIntoPrompt("do the thing", []) === "do the thing"
      && folder.foldHistoryIntoPrompt("do the thing", undefined) === "do the thing");
  const shortHistory = [
    { role: "user", content: "first ask" },
    { role: "assistant", content: "first answer" },
  ];
  const shortFold = folder.foldHistoryIntoPrompt("next ask", shortHistory);
  check("A short history is folded whole, newest last",
    shortFold.includes("User: first ask")
      && shortFold.includes("Assistant: first answer")
      && shortFold.indexOf("first ask") < shortFold.indexOf("next ask")
      && !shortFold.includes("older turn(s) omitted"));
  // The measured failure: 245 assistant turns of project transcript inlined raw.
  const hugeHistory = [];
  for (let i = 0; i < 300; i += 1) {
    hugeHistory.push({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i} ${"x".repeat(3000)}` });
  }
  const hugeFold = folder.foldHistoryIntoPrompt("the current step", hugeHistory);
  check("A months-long transcript can no longer fill the context window",
    hugeFold.length <= folder.MAX_FOLDED_HISTORY_CHARS + 5_000);
  check("The newest turns survive and the oldest are the ones dropped",
    hugeFold.includes("turn 299") && !hugeFold.includes("turn 0 "));
  check("Truncation is stated so the model does not assume it saw everything",
    hugeFold.includes("older turn(s) omitted"));
  check("The current request is still the last thing the model reads",
    hugeFold.trimEnd().endsWith("the current step"));
  check("The codex path uses the budgeted fold instead of an ad-hoc join",
    !page.includes('.join("\\n\\n");\n    const prompt = convo')
      && dispatch.includes("const prompt = foldHistoryIntoPrompt(userMessage, history, modelId)"));
  // The two constants above are now only the FALLBACK. Naming the model sizes the
  // budget to its real window — see contextBudget.verify.run.mjs for that half.
  check("The fold accepts the model it is budgeting for",
    /export function foldHistoryIntoPrompt\(\s*userMessage: string,\s*history\?: HistoryItem\[\],\s*modelId\?: string \| null,/
      .test(dispatch));

  console.log(`PASS team run continuity (${checks.length}/${checks.length})`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
