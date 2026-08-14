import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1)));
const UI = path.resolve(HERE, "../..");
const ROOT = path.resolve(UI, "../../..");
const read = (relative) => fs.readFileSync(path.join(UI, relative), "utf8").replace(/\r\n/g, "\n");
const checks = [];
function check(name, condition) {
  checks.push({ name, ok: Boolean(condition) });
  if (!condition) throw new Error(`FAIL ${name}`);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-team-model-"));
try {
  const source = read("pages/agentic/teamModelSelection.ts");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modulePath = path.join(temp, "teamModelSelection.mjs");
  fs.writeFileSync(modulePath, compiled);
  const model = await import(pathToFileURL(modulePath).href);

  const stale = new Map([
    ["coder", "sub/gpt-5.5"],
    ["critical_thinker", "sub/claude-opus-4-7"],
  ]);
  check("An explicit per-agent selection wins over live and persisted team choices",
    model.resolveAgentModel("coder", "sub/kimi-k3", "sub/kimi-k3", stale, null) === "sub/gpt-5.5"
      && model.resolveAgentModel("critical_thinker", "sub/kimi-k3", "sub/kimi-k3", stale, null) === "sub/claude-opus-4-7");
  check("A template agent pin remains agent-specific and wins over the team fallback",
    model.resolveAgentModel("publisher", "sub/kimi-k3", "sub/kimi-k3", new Map(), "local-model", "api/deepseek-chat") === "api/deepseek-chat");
  check("The team choice is the fallback when an agent has no specific model",
    model.resolveAgentModel("researcher", "sub/kimi-k3", "sub/gpt-5.5", stale, "local-model") === "sub/kimi-k3"
      && model.resolveAgentModel("researcher", null, "sub/gpt-5.5", stale, "local-model") === "sub/gpt-5.5");
  check("The running server is used only when neither agent nor team selected a model",
    model.resolveAgentModel("researcher", null, "", new Map(), "local-model") === "local-model");

  const bulk = model.assignTeamModelToAgents(
    ["orchestrator", "coder", "researcher", "coder"],
    "sub/kimi-k3",
  );
  check("The Team picker materializes one assignment for every current agent",
    bulk.size === 3
      && bulk.get("orchestrator") === "sub/kimi-k3"
      && bulk.get("coder") === "sub/kimi-k3"
      && bulk.get("researcher") === "sub/kimi-k3");
  const selective = new Map(bulk);
  selective.set("coder", "sub/gpt-5.5");
  check("An individual selection after a bulk assignment changes only that agent",
    model.resolveAgentModel("coder", "sub/kimi-k3", "sub/kimi-k3", selective, null) === "sub/gpt-5.5"
      && model.resolveAgentModel("researcher", "sub/kimi-k3", "sub/kimi-k3", selective, null) === "sub/kimi-k3");

  const graph = model.graphJsonWithAgentModels(JSON.stringify({
    edges: [{ source: "orchestrator", target: "coder" }],
    agentModels: { coder: "sub/claude-opus-4-7" },
    agentVoices: { coder: { enabled: true } },
  }), bulk);
  const parsed = JSON.parse(graph);
  check("Bulk assignment persists every model while preserving unrelated graph settings",
    parsed.agentModels?.coder === "sub/kimi-k3"
      && parsed.agentModels?.researcher === "sub/kimi-k3"
      && parsed.edges.length === 1
      && parsed.agentVoices.coder.enabled === true);

  const keys = [
    "owllm:agent-model:p1:coder",
    "owllm:agent-model:p1:critical_thinker",
    "owllm:agent-model:p2:coder",
    "unrelated",
  ];
  const storage = {
    get length() { return keys.length; },
    key(index) { return keys[index] ?? null; },
    removeItem(key) { const index = keys.indexOf(key); if (index >= 0) keys.splice(index, 1); },
  };
  model.clearStoredAgentModelOverrides("p1", storage);
  check("Team selection clears every local override for only the active project",
    keys.join(",") === "owllm:agent-model:p2:coder,unrelated");

  const page = read("pages/agentic/AgentsPage.tsx");
  const dispatch = read("pages/agentic/dispatch.ts");
  const lib = fs.readFileSync(path.join(ROOT, "owllm-desktop/src-tauri/src/lib.rs"), "utf8");
  const accounts = fs.readFileSync(path.join(ROOT, "owllm-desktop/src-tauri/src/accounts.rs"), "utf8");
  check("A saved team choice can never short-circuit an explicit agent model",
    !source.includes("if (savedTeamModel.trim()) return savedTeamModel.trim()")
      && source.indexOf("const perAgent =") < source.indexOf("liveTeamModel?.trim()"));
  check("Agent cards and dispatch share the agent-first resolver",
    page.includes("return resolveAgentModel(") && page.includes("teamModelOverride,"));
  check("Template default_model_id is loaded and participates in dispatch",
    page.includes("defaultModelId?: string")
      && page.includes("a.default_model_id")
      && page.includes("agentTemplateModelFor(agentName)"));
  // The right column's per-agent settings face was removed with its tab (user
  // spec 2026-08-14); the agent editor is now the ONLY per-agent model picker.
  // Same invariant, pinned on the surviving surface: the picker's VALUE is the
  // explicit override (or the template default), never a resolved inherited
  // model — inheritance is disclosed in the fallback label instead.
  check("Agent settings picker shows only explicit overrides, not resolved inherited models",
    page.includes("const agentModelOverrideFor = (agentName: string): string =>")
      && page.includes("value={model}")
      && page.includes("`(use team model · ${effectiveTeamModel})`")
      && !page.includes("value={explicitModel}"));
  check("Agent editor does not materialize inherited team/server models as overrides",
    page.includes("initialModel={agentModelOverrideFor(name) || spec.defaultModelId || \"\"}"));
  check("Team picker bulk-assigns all agents in local and DB persistence",
    page.includes("assignTeamModelToAgents(")
      && page.includes("setPerAgentModel(assignedModels)")
      && page.includes("graphJsonWithAgentModels(project.graph_json, assignedModels)"));
  check("Chat persistence cannot reset the live team selection",
    page.includes("const projectChanged = hydratedProjectIdRef.current !== selectedProject.id")
      && page.includes("if (projectChanged) {")
      && page.includes("setTeamModelOverride(null);"));
  check("All open Agents windows receive both bulk and selective model changes",
    page.includes('new CustomEvent("owllm:team-model-changed"')
      && page.includes('window.addEventListener("owllm:team-model-changed"')
      && page.includes('new CustomEvent("owllm:agent-model-changed"')
      && page.includes('window.addEventListener("owllm:agent-model-changed"')
      && page.includes("agentModels: Array.from(assignedModels.entries())"));
  // The kimi branch moved into the shared dispatch.ts when AgentsPage's
  // duplicated cloud stack collapsed (2026-08-14) — same invariant, one copy.
  check("Agentic Kimi path runs the execution-environment preflight",
    /if \(route\.forceSub === true\) \{\s+await ensureCliWarm\("kimi_cli", projectCwd\);/.test(dispatch)
      && !/ensureCliWarm\("kimi_cli"/.test(page));
  check("Shared CLI warm-up prepares the actual project environment",
    dispatch.includes('"accounts_prepare_cli_for_cwd"')
      && dispatch.includes('{ kind: "prepare", backend }')
      && dispatch.includes("throw new CliPreflightError"));
  check("Native command is registered and installs isolated CLIs without blocking the GUI thread",
    lib.includes("accounts::accounts_prepare_cli_for_cwd")
      && accounts.includes("pub async fn accounts_prepare_cli_for_cwd")
      && accounts.includes("tokio::task::spawn_blocking")
      && accounts.includes("uv tool install --force --python 3.13 kimi-cli"));
  check("WSL CLI provisioning verifies executability and serializes npm mutations",
    accounts.includes("wsl_cli_provision_lock")
      && accounts.includes("flock -w 600")
      && accounts.includes("codex --version")
      && accounts.includes("NPM_CLEAN_STALE_SNIPPET"));
  check("Codex startup failure is collected instead of masked by broken stdin",
    accounts.includes("let stdin_write_error = match child.stdin.take()")
      && accounts.includes("return Err(match stdin_write_error"));

  for (const row of checks) console.log(`  PASS ${row.name}`);
  console.log(`team model selection verification: ${checks.length}/${checks.length} passed`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
