#!/usr/bin/env node
// Why this gate exists — two failures that looked nothing alike had one cause:
//   1. A local 8K-window GGUF orchestrator kept "losing" half its dispatch list.
//      The history fold was a FIXED 60,000 characters (~16,000 tokens), so the
//      prompt overran the window and llama-server truncated it silently — no
//      error surfaced anywhere, the run just did less than it was told.
//   2. A 256K-window subscription model kept "forgetting" decisions three turns
//      old, because that same 60,000 characters was 6% of what it could hold.
// One constant cannot serve both. This proves the budget tracks the model, that
// every provider path is actually bounded, and that an unknown model fails
// conservatively rather than optimistically.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1)));
const UI = path.resolve(HERE, "../..");
const read = (relative) => fs.readFileSync(path.join(UI, relative), "utf8").replace(/\r\n/g, "\n");
const checks = [];
function check(name, condition) {
  checks.push({ name, ok: Boolean(condition) });
  if (!condition) throw new Error(`FAIL ${name}`);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-context-budget-"));
try {
  const load = async (source, name) => {
    const modulePath = path.join(temp, name);
    fs.writeFileSync(modulePath, ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    }).outputText);
    return await import(pathToFileURL(modulePath).href);
  };
  // contextBudget is pure data + arithmetic, so it proves in isolation.
  const budget = await load(read("pages/agentic/contextBudget.ts"), "contextBudget.mjs");

  // --- the window lookup -----------------------------------------------------
  check("A live llama-server grant outranks any guess from the model id",
    budget.contextWindowFor("some-random-8b-q4.gguf", 131_072) === 131_072);
  check("A zero / negative / non-finite live grant is ignored, not trusted",
    budget.contextWindowFor("gemma-2b", 0) === 8_192
      && budget.contextWindowFor("gemma-2b", -1) === 8_192
      && budget.contextWindowFor("gemma-2b", Number.NaN) === 8_192);
  check("The Codex window matches what this app measured live (258,400)",
    budget.contextWindowFor("gpt-5.6-sol") === 258_400
      && budget.contextWindowFor("sub/gpt-5.1-codex") === 258_400);
  check("Known cloud families resolve to their documented windows",
    budget.contextWindowFor("sub/claude-opus-5") === 200_000
      && budget.contextWindowFor("sub/kimi-k3") === 256_000
      && budget.contextWindowFor("api/gemini-3-pro") === 1_000_000);
  check("An UNKNOWN local id falls back to the llama-server default, not to a cloud-sized window",
    budget.contextWindowFor("mystery-model-v9.gguf") === budget.FALLBACK_LOCAL_CONTEXT_TOKENS
      && budget.FALLBACK_LOCAL_CONTEXT_TOKENS === 8_192);
  check("An unknown CLOUD id falls back to a cloud-sized window",
    budget.contextWindowFor("sub/some-new-model") === budget.FALLBACK_CLOUD_CONTEXT_TOKENS);

  // --- the budget itself -----------------------------------------------------
  const tiny = budget.historyBudgetFor("mystery-model-v9.gguf");
  const codex = budget.historyBudgetFor("gpt-5.6-sol");
  const huge = budget.historyBudgetFor("api/gemini-3-pro");
  check("An 8K model gets a budget that fits inside 8K, unlike the old fixed 60,000",
    tiny.chars < 60_000 && tiny.chars > 0);
  check("The budget is a strict fraction of the window, never the whole thing",
    tiny.chars < tiny.contextTokens * budget.CHARS_PER_TOKEN
      && codex.chars < codex.contextTokens * budget.CHARS_PER_TOKEN);
  check("A bigger window earns a bigger budget (chars AND turns)",
    codex.chars > tiny.chars && huge.chars > codex.chars
      && codex.turns > tiny.turns && huge.turns > codex.turns);
  check("A 256K model is no longer capped at the old 60,000 characters",
    codex.chars > 60_000);
  check("Every budget keeps at least a couple of turns, however small the window",
    budget.historyBudgetFor("gemma-2b", 512).chars >= 2_000
      && budget.historyBudgetFor("gemma-2b", 512).turns >= 1);

  // --- every provider path is actually bounded -------------------------------
  // The original bug was not the budget being wrong, it was the budget existing
  // on 3 of 11 paths. These assert the remaining eight are wired too.
  const dispatch = read("pages/agentic/dispatch.ts");
  const page = read("pages/agentic/AgentsPage.tsx");
  check("dispatch.ts imports the budget rather than re-deriving one",
    dispatch.includes('from "./contextBudget"') && page.includes('from "./contextBudget"'));
  check("No provider path spreads raw history into a request any more",
    !/\.\.\.\(history \?\? \[\]\)/.test(dispatch)
      && !/\.\.\.\(history \?\? \[\]\)/.test(page)
      && !/\.\.\.\(p\.history \?\? \[\]\)/.test(dispatch)
      && !/\.\.\.\(args\.history \?\? \[\]\)/.test(dispatch));
  check("No provider path joins the whole transcript by hand any more",
    !/const convo = \(history \?\? \[\]\)/.test(dispatch)
      && !/const folded = \(history \?\? \[\]\)/.test(page));
  check("The Gemini contents[] builders are bounded on both copies",
    /recentTextHistory\(history, geminiBudget\.turns, geminiBudget\.chars\)/.test(dispatch)
      && /recentTextHistory\(history, geminiBudget\.turns, geminiBudget\.chars\)/.test(page));
  check("The Anthropic messages[] builders are bounded on both copies",
    /recentTextHistory\(history, anthropicBudget\.turns, anthropicBudget\.chars\)/.test(page)
      && /recentTextHistory\(history, budgetForModel\.turns, budgetForModel\.chars\)/.test(dispatch));
  check("The local llama-server path asks for the window it was actually granted",
    dispatch.includes("grantedLocalContextWindow")
      && /server_status/.test(dispatch));
  check("The CLI folds name the model they are budgeting for",
    /foldHistoryIntoPrompt\(cliUserMessage, history, cliModel\)/.test(dispatch)
      && /foldHistoryIntoPrompt\(userMessage, history, modelId\)/.test(dispatch)
      && /foldHistoryIntoPrompt\(cliUserMessage, history, cliModel\)/.test(page)
      && /foldHistoryIntoPrompt\(userMessage, history, modelId\)/.test(page));

  for (const c of checks) console.log(`  ok  ${c.name}`);
  console.log(`\ncontextBudget.verify: ${checks.length} checks passed`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
