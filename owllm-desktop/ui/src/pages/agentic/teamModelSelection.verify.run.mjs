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
  check("A live team selection immediately wins over every stale per-agent model",
    model.resolveAgentModel("coder", "sub/kimi-k3", "sub/gpt-5.5", stale, null) === "sub/kimi-k3"
      && model.resolveAgentModel("critical_thinker", "sub/kimi-k3", "sub/gpt-5.5", stale, null) === "sub/kimi-k3");
  check("An explicit team fallback ignores stale agent models and uses the server",
    model.resolveAgentModel("coder", "", "sub/gpt-5.5", stale, "local-model") === "local-model");
  check("Normal per-agent precedence remains when no live team assignment is pending",
    model.resolveAgentModel("coder", null, "sub/kimi-k3", stale, null) === "sub/gpt-5.5");

  const graph = model.graphJsonWithoutAgentModels(JSON.stringify({
    edges: [{ source: "orchestrator", target: "coder" }],
    agentModels: { coder: "sub/gpt-5.5" },
    agentVoices: { coder: { enabled: true } },
  }));
  const parsed = JSON.parse(graph);
  check("Clearing model overrides preserves graph wiring and unrelated agent settings",
    parsed.agentModels && Object.keys(parsed.agentModels).length === 0
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
  check("Agent cards and dispatch share the team-first resolver",
    page.includes("return resolveAgentModel(") && page.includes("teamModelOverride,"));
  check("Team picker clears local and DB per-agent overrides",
    page.includes("clearStoredAgentModelOverrides(project.id)")
      && page.includes("graphJsonWithoutAgentModels(project.graph_json)"));
  check("Agentic Kimi path runs the execution-environment preflight",
    /if \(route\.forceSub\) \{\s+[\s\S]*?await ensureCliWarm\("kimi_cli", projectCwd\);/.test(page)
      && /\}\), projectCwd\);/.test(page));
  check("Shared CLI warm-up prepares the actual project environment",
    dispatch.includes('"accounts_prepare_cli_for_cwd"')
      && dispatch.includes('{ kind: "prepare", backend }'));
  check("Native command is registered and installs isolated CLIs without blocking the GUI thread",
    lib.includes("accounts::accounts_prepare_cli_for_cwd")
      && accounts.includes("pub async fn accounts_prepare_cli_for_cwd")
      && accounts.includes("tokio::task::spawn_blocking")
      && accounts.includes("uv tool install --force --python 3.13 kimi-cli"));

  for (const row of checks) console.log(`  PASS ${row.name}`);
  console.log(`team model selection verification: ${checks.length}/${checks.length} passed`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
