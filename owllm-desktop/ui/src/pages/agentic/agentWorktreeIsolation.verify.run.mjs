#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1)));
const UI = path.resolve(HERE, "../..");
const APP = path.resolve(UI, "../..");
const read = (relative) => fs.readFileSync(path.join(UI, relative), "utf8").replace(/\r\n/g, "\n");
const checks = [];
function check(name, condition) {
  checks.push({ name, ok: Boolean(condition) });
  if (!condition) throw new Error(`FAIL ${name}`);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-agent-isolation-"));
try {
  const source = read("pages/agentic/worktreeIsolation.ts");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modulePath = path.join(temp, "worktreeIsolation.mjs");
  fs.writeFileSync(modulePath, compiled);
  const policy = await import(pathToFileURL(modulePath).href);

  check("Single-agent runs require isolation",
    policy.requiresAgentWorktree("C:\\repo") === true);
  check("Sequential runs use the same project isolation policy",
    policy.requiresAgentWorktree("/home/user/repo") === true);
  check("WSL runs require isolation instead of sharing the distro folder",
    policy.requiresAgentWorktree("\\\\wsl.localhost\\Ubuntu\\home\\user\\repo") === true);
  check("A run with no project filesystem needs no worktree",
    policy.requiresAgentWorktree("  ") === false);
  check("Browser-first environments are not gated on code isolation",
    policy.requiresAgentWorktree("C:\\assistant", { presetId: "personal-operations" }) === false
      && policy.requiresAgentWorktree("C:\\research", { presetId: "research-desk" }) === false);
  check("Code environments still isolate",
    policy.requiresAgentWorktree("C:\\repo", { presetId: "web-live" }) === true
      && policy.requiresAgentWorktree("C:\\repo", { presetId: "software-workbench" }) === true);

  // Self-heal: OWLLM must not create a folder it then refuses to run in.
  const callsFor = (initResult) => {
    const calls = [];
    let created = false;
    const invoker = async (command, args) => {
      calls.push({ command, args });
      if (command === "fleet_repo_init") {
        if (initResult instanceof Error) throw initResult;
        created = initResult;
        return initResult;
      }
      return created ? { status: "ready", path: "C:\\wt", branch: "b", baseSha: "s" } : { status: "notAGitRepo" };
    };
    return { calls, invoker };
  };
  const healed = callsFor(true);
  const healedResult = await policy.createAgentWorktree(healed.invoker,
    { projectCwd: "C:\\owllm-made", agentName: "triager", runId: "r1" });
  check("An OWLLM-created folder is initialized and the worktree retried",
    healedResult.status === "ready"
      && healed.calls.map(c => c.command).join(",")
        === "fleet_worktree_create,fleet_repo_init,fleet_worktree_create");
  const userFolder = callsFor(false);
  const userResult = await policy.createAgentWorktree(userFolder.invoker,
    { projectCwd: "C:\\user-picked", agentName: "triager", runId: "r2" });
  check("A folder the user chose is never silently turned into a repository",
    userResult.status === "notAGitRepo"
      && userFolder.calls.filter(c => c.command === "fleet_worktree_create").length === 1);
  const failedInit = callsFor(new Error("git init: permission denied"));
  const failedResult = await policy.createAgentWorktree(failedInit.invoker,
    { projectCwd: "C:\\owllm-made", agentName: "triager", runId: "r3" });
  check("A failed initialization surfaces the real git error",
    failedResult.status === "error" && failedResult.message.includes("permission denied"));

  const creation = policy.worktreeCreationFailure("coder", "C:\\repo", {
    status: "error",
    message: "simulated lock",
  });
  check("Creation failures explicitly stop instead of falling back",
    creation.includes("stopped instead of falling back") && creation.includes("simulated lock"));
  const retryable = policy.worktreePreflightError("coder", "C:\\repo", {
    status: "error",
    message: "simulated WSL outage",
  });
  check("Worktree setup failures retain a typed preflight boundary",
    retryable.name === "WorktreePreflightError" && retryable.message.includes("simulated WSL outage"));
  const nonGit = policy.worktreeCreationFailure("coder", "C:\\plain", {
    status: "notAGitRepo",
  });
  check("Non-Git filesystem runs fail closed with an actionable instruction",
    nonGit.includes("not a Git repository") && nonGit.includes("Initialize Git"));
  const dirty = policy.worktreeCreationFailure("coder", "C:\\repo", {
    status: "dirtyWorkingTree",
    details: " M source.ts",
  });
  check("Dirty tracked files stop before dispatch and remain visible",
    dirty.includes("stopped before the agent started") && dirty.includes("source.ts"));

  const page = read("pages/agentic/AgentsPage.tsx");
  check("Isolation no longer depends on parallel mode or agent count",
    page.includes("const needWorktrees = requiresAgentWorktree(projectCwd, runEnvironment)")
      && !page.includes("parallelMode && dispatches.length > 1"));
  check("Every worktree create goes through the self-healing helper",
    page.match(/await createAgentWorktree\(invoke, \{/g)?.length === 3
      && !page.includes('invoke<FleetCreateResult>("fleet_worktree_create"'));
  check("Agent worktree failure is fail-closed",
    page.includes("throw worktreePreflightError(spec.name, projectCwd, res)")
      && !page.includes("Falling back to shared cwd"));
  check("Solo filesystem work runs and verifies inside a private worktree",
    page.includes("const soloCwd = soloWt.path")
      && page.includes("runGate(soloCwd, sScope)")
      && page.includes("worktreePath: soloWt.path"));
  check("Failed solo work is preserved instead of contaminating the project",
    page.includes("keepSoloWorktree = true")
      && page.includes("isolated work kept at ${soloWt.path}"));
  check("Auto-doc never silently downgrades to shared cwd",
    page.includes("auto-doc stopped before dispatch")
      && page.includes("const docCwd = docWt.path"));
  check("The orchestrator cannot regain write tools against the shared checkout",
    !page.includes("effectiveToolsFor(orch)")
      && page.match(/runtimeReadOnlyTools\(orch, roleByName\)/g)?.length >= 3);

  const fleet = fs.readFileSync(path.join(APP, "src-tauri/src/fleet.rs"), "utf8").replace(/\r\n/g, "\n");
  check("Fleet Git commands route WSL paths through the distro",
    fleet.includes("crate::wsl::parse_wsl_unc(&dir_text)")
      && fleet.includes("crate::wsl::wsl_program_command"));
  check("WSL worktrees live under the distro user's fleet root",
    fleet.includes('format!("{home}/.owllm/fleet")')
      && fleet.includes("linux_path_to_wsl_unc"));
  check("Fleet filesystem operations route WSL paths through the distro",
    fleet.includes("fn path_is_dir_native(")
      && fleet.includes("fn create_dir_all_native(")
      && fleet.includes("fn rename_native(")
      && fleet.includes("crate::wsl::run_in_distro(&distro"));
  check("Create, finalize, diff, and merge avoid host is_dir on WSL paths",
    !fleet.includes("if !cwd.is_dir()")
      && !fleet.includes("if !wt.is_dir()"));
  check("The native suite covers the full WSL worktree lifecycle",
    fleet.includes("wsl_unc_worktree_lifecycle_uses_the_distro_boundary")
      && fleet.includes("fleet_worktree_merge_blocking(project_unc.clone()"));
  check("Repository init is guarded by the card OWLLM writes for folders it creates",
    fleet.includes("pub fn ensure_owned_git_repo(")
      && fleet.includes('path_is_dir_native(&dir.join(".owllm"))')
      && fleet.includes("pub async fn fleet_repo_init("));
  const projects = fs.readFileSync(path.join(APP, "src-tauri/src/projects.rs"), "utf8").replace(/\r\n/g, "\n");
  check("A project folder OWLLM creates is a repository agents can run in",
    projects.includes("crate::fleet::ensure_owned_git_repo(&workspace)"));

  // Wire-shape guard: on a #[serde(tag = ...)] enum, rename_all renames only
  // the VARIANT names — struct-variant fields still serialize snake_case
  // unless rename_all_fields (or a per-field rename) is present. The TS types
  // are all camelCase, so a leaked snake_case field means `commitSha` etc. is
  // undefined at runtime and the run crashes at the merge-announce line.
  {
    const tagged = [...fleet.matchAll(/#\[serde\(tag = "status"[^\]]*\)\]\s*\npub enum (\w+) \{\n([\s\S]*?)\n\}/g)];
    check("fleet.rs declares tagged outcome enums to inspect", tagged.length >= 4);
    for (const [attrAndBody, name, body] of tagged) {
      if (attrAndBody.includes('rename_all_fields = "camelCase"')) continue;
      const lines = body.split("\n");
      const leaked = lines.filter((line, i) =>
        /^\s+[a-z][a-z0-9]*(?:_[a-z0-9]+)+:/.test(line)
        && !/#\[serde\(rename = "/.test(lines[i - 1] ?? ""));
      check(`${name} does not leak snake_case fields onto the wire`, leaked.length === 0);
    }
  }
  check("A crashed run cannot leave an agent card ticking forever",
    /const clearActive = \(\) => \{[\s\S]*?setAgentTiming\(/.test(page));
  check("Slow pre-dispatch worktree/CLI prep is announced, not silent",
    page.includes("Preparing an isolated workspace and warming the CLI")
      && page.includes("isolated workspace(s) — first agent activity"));

  check("Notebook worktree preflight failures remain pending and retryable",
    page.includes("e instanceof WorktreePreflightError")
      && page.includes("markNotebookStepPending(selectedProjectId"));

  const repo = path.join(temp, "repo");
  const worktree = path.join(temp, "single-agent");
  fs.mkdirSync(repo);
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "isolation@owllm.local");
  git(repo, "config", "user.name", "OwLLM Isolation Gate");
  fs.writeFileSync(path.join(repo, "feature.txt"), "shared checkout\n");
  git(repo, "add", "feature.txt");
  git(repo, "commit", "-m", "base");
  git(repo, "worktree", "add", "-b", "owllm-fleet/test/single", worktree, "HEAD");
  fs.writeFileSync(path.join(worktree, "feature.txt"), "isolated agent edit\n");
  check("A real single-agent worktree cannot mutate the shared checkout",
    fs.readFileSync(path.join(repo, "feature.txt"), "utf8") === "shared checkout\n"
      && fs.readFileSync(path.join(worktree, "feature.txt"), "utf8") === "isolated agent edit\n");
  git(repo, "worktree", "remove", "--force", worktree);
  git(repo, "branch", "-D", "owllm-fleet/test/single");

  // Isolation is pure LOCAL git: a folder OWLLM creates, initialized offline
  // with no remote at all, supports the full per-agent worktree cut.
  const offline = path.join(temp, "owllm-made");
  fs.mkdirSync(path.join(offline, ".owllm"), { recursive: true });
  fs.writeFileSync(path.join(offline, ".owllm", "project.json"), "{}\n");
  git(offline, "init", "-q", "-b", "main");
  git(offline, "config", "user.email", "agent@owllm.local");
  git(offline, "config", "user.name", "OWLLM");
  git(offline, "add", "-A");
  git(offline, "commit", "-q", "--allow-empty", "-m", "OWLLM project init");
  const offlineWt = path.join(temp, "offline-agent");
  git(offline, "worktree", "add", "-b", "owllm-fleet/test/offline", offlineWt, "HEAD");
  check("An offline, remote-less OWLLM project still isolates agents",
    execFileSync("git", ["remote"], { cwd: offline, encoding: "utf8" }).trim() === ""
      && fs.existsSync(path.join(offlineWt, ".owllm", "project.json")));
  git(offline, "worktree", "remove", "--force", offlineWt);
  git(offline, "branch", "-D", "owllm-fleet/test/offline");

  console.log(`PASS mandatory agent worktree isolation (${checks.length}/${checks.length})`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
