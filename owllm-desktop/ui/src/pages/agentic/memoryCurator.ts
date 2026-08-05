// Memory Curator — one bounded post-run extraction pass that keeps durable
// facts flowing WITHOUT reviving the promote-everything firehose that was
// killed on 2026-07-26 (84e6be57: 103 auto-curated rows polluted retrieval).
//
// After a run completes, ONE cheap LLM call reads the goal + final answer and
// emits AT MOST 2 novel `[REMEMBER key=… tags=…] fact` lines, deduped against
// the facts the scope already holds. The output rides the existing
// model-agnostic write path (parseMemoryDirectives → harvestMemoryWrites), so
// there is no second write channel to keep in sync.
//
// COST CONTROL (the user's explicit requirement): the curator's model is a
// per-project setting (Team Memory modal) so a cheap model can do this job.
// Default is `auto/cheapest`, which prefers the FREE running local model and
// only falls back to the cheapest connected cloud model. "off" disables the
// pass entirely. Fire-and-forget at every call site — it must never delay the
// final answer or hold the GUI.

import { invoke } from "@tauri-apps/api/core";
import { providerFor, streamChatCompletion, type ModelInfo } from "./dispatch";
import { harvestMemoryWrites, parseMemoryDirectives } from "./localTools";

/// Sentinel stored when the user disables the curator for a project.
export const CURATOR_OFF = "off";
/// Used when no explicit model is stored — free local model first.
export const CURATOR_DEFAULT_MODEL = "auto/cheapest";
/// Hard cap on facts per run — selective curation, never a firehose.
export const CURATOR_MAX_FACTS = 2;

// Per-project persistence follows the established per-project localStorage
// scheme (agent model overrides: `owllm:agent-model:${pid}:${agent}`).
const curatorKey = (scope: string) => `owllm:memory-curator:${scope}`;

/// Raw stored setting: "" = unset (default model), "off" = disabled, else a
/// ModelPicker id ("<gguf>", "sub/claude-…", "api/gpt-…", "auto/…").
export function getCuratorModel(scope: string): string {
  if (!scope) return "";
  try { return localStorage.getItem(curatorKey(scope)) ?? ""; } catch { return ""; }
}

export function setCuratorModel(scope: string, modelId: string): void {
  if (!scope) return;
  try {
    if (modelId.trim()) localStorage.setItem(curatorKey(scope), modelId.trim());
    else localStorage.removeItem(curatorKey(scope));
  } catch { /* private mode */ }
}

/// The model the pass will actually run on — null when disabled.
export function effectiveCuratorModel(scope: string): string | null {
  const raw = getCuratorModel(scope);
  if (raw === CURATOR_OFF) return null;
  return raw || CURATOR_DEFAULT_MODEL;
}

type MemoryRow = { id: number; key: string; content: string; kind: string };

function clip(s: string, max: number): string {
  const t = (s || "").trim();
  return t.length <= max ? t : t.slice(0, max) + " …";
}

function curatorSystemPrompt(): string {
  return [
    "You are a team's Memory Curator. A run just finished; decide whether it established",
    "any DURABLE knowledge worth keeping for future runs.",
    "",
    "Output rules — follow them exactly:",
    `- At most ${CURATOR_MAX_FACTS} facts. Zero is the normal outcome; be selective.`,
    "- Each fact on its own line, exactly:  [REMEMBER key=<stable-kebab-id> tags=<a,b>] <the fact>",
    "- If nothing qualifies, output the single word: NONE",
    "- No other text, no explanations, no markdown.",
    "",
    "A fact QUALIFIES only if it is: still true next month (a decision, a constraint,",
    "where something lives, how something is built/run) AND specific AND not already",
    "covered by the existing keys listed in the input.",
    "A fact NEVER qualifies if it is: run narration ('did X', 'fixed Y'), a result or",
    "status of this one run, a TODO, or a restatement of the user's request — the",
    "worklog already records those.",
  ].join("\n");
}

/// Run the post-run curation pass. Best-effort and self-contained: never
/// throws, never blocks the caller's answer (call sites fire it with `void`).
/// Returns the number of facts written (0 = disabled / skipped / none found).
export async function runMemoryCurator(opts: {
  scope: string;
  goal: string;
  finalAnswer: string;
  port: number;
  /// Surfaces the outcome (and the Auto model pick, which may cost money) as
  /// a system line in the caller's chat log.
  onNote?: (text: string) => void;
}): Promise<number> {
  const { scope, goal, finalAnswer, port, onNote } = opts;
  try {
    if (!scope) return 0;
    const model = effectiveCuratorModel(scope);
    if (!model) return 0;
    // A short answer holds nothing durable — skip the call entirely (free).
    if ((finalAnswer || "").trim().length < 300) return 0;

    // Existing facts (keys + a snippet) so the model can dedupe. Worklog rows
    // are excluded — they are exactly what the curator must NOT re-record.
    const rows = await invoke<MemoryRow[]>("team_memory_search", { scope, query: "", limit: 200 }).catch(() => [] as MemoryRow[]);
    const facts = rows.filter((r) => r.kind !== "worklog").slice(0, 50);
    const existing = facts.length
      ? facts.map((f) => `  - ${f.key ? `[${f.key}] ` : ""}${clip(f.content, 90)}`).join("\n")
      : "  (none yet)";

    const models = await invoke<ModelInfo[]>("list_models").catch(() => [] as ModelInfo[]);
    const userMessage = [
      "The run's goal:",
      clip(goal, 1200),
      "",
      "The team's final answer:",
      clip(finalAnswer, 7000),
      "",
      "Facts this project already remembers (do NOT re-record these):",
      clip(existing, 4000),
    ].join("\n");

    // Bounded: one call, no tools, no history, hard timeout so a hung
    // provider can never leak a permanent background task.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 180_000);
    let reply = "";
    try {
      reply = await streamChatCompletion(
        port, model, providerFor(model, models),
        curatorSystemPrompt(), userMessage, 0.2, ctrl.signal,
        () => { /* not user-facing — only the harvested facts matter */ },
        undefined, undefined, undefined, undefined,
        [],        // allowedTools: the curator needs none on any path
        undefined, undefined,
        onNote,    // surfaces the "⚡ Auto → …" pick when it costs money
      );
    } finally {
      clearTimeout(timer);
    }

    // Enforce the cap in CODE, not just in the prompt: keep the first
    // CURATOR_MAX_FACTS directives and re-render only those for harvesting.
    const dirs = parseMemoryDirectives(reply).slice(0, CURATOR_MAX_FACTS);
    if (!dirs.length) return 0;
    const directiveText = dirs
      .map((d) => `[REMEMBER${d.key ? ` key=${d.key}` : ""}${d.tags ? ` tags=${d.tags}` : ""}] ${d.content}`)
      .join("\n");
    const written = await harvestMemoryWrites(directiveText, scope, "curator");
    if (written > 0) onNote?.(`🧠 Curator: +${written} durable fact${written === 1 ? "" : "s"} → Team Memory`);
    return written;
  } catch {
    return 0; // curation must never surface as a run failure
  }
}
