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
  check("runCodexCliStream forwards readOnly to the Rust command",
    dispatch.includes("readOnly?: boolean")
      && dispatch.includes("readOnly: args.readOnly === true"));
  check("The chat/bridge codex path derives readOnly from the allowlist",
    dispatch.includes("readOnly: isReadOnlyToolAllowlist(allowedTools)"));
  const page = read("pages/agentic/AgentsPage.tsx");
  check("The agentic codex path derives readOnly from the allowlist",
    page.includes("readOnly: isReadOnlyToolAllowlist(allowedTools)"));
  check("AgentsPage no longer keeps a private copy of the read-only tool set",
    !page.includes("const READONLY_LOCAL_TOOLS: string[] = [")
      && page.includes('from "./agentSandbox"'));
  const accounts = fs.readFileSync(path.join(APP, "src-tauri/src/accounts.rs"), "utf8").replace(/\r\n/g, "\n");
  check("codex_cli_stream accepts the read-only flag",
    accounts.includes("read_only: Option<bool>"));
  check("A read-only agent gets --sandbox read-only, ahead of any escalation",
    /let sandbox_mode = if agent_read_only \{\s*"read-only"\s*\} else if gateway_wired \{\s*"danger-full-access"/.test(accounts));

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
  check("Opening a Code page never opts in",
    !read("pages/agentic/CodePage.tsx").includes("checkpointDirty"));
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
  check("Both codex paths use the budgeted fold instead of an ad-hoc join",
    !page.includes('.join("\\n\\n");\n    const prompt = convo')
      && page.includes("foldHistoryIntoPrompt(userMessage, history)")
      && dispatch.includes("const prompt = foldHistoryIntoPrompt(userMessage, history)"));

  console.log(`PASS team run continuity (${checks.length}/${checks.length})`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
