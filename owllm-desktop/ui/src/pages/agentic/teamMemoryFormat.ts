// Pure formatters for the shared team WORK-STATE (the RAG done right). No Tauri/
// React imports, so they unit-test standalone (harness.verify). The dispatch
// loops use these to (a) auto-record what each agent DID as shared work-state and
// (b) inject the work RELEVANT to a specialist's task into its instruction — so
// every agent is synchronized on the team's actual work, retrieved by relevance,
// not handed a recency feed of opt-in trivia.

export function oneLine(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim();
}

function clip(s: string, max: number): string {
  const t = oneLine(s);
  return t.length <= max ? t : t.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

/// One auto-captured work record: what an agent was asked + what it did. Compact
/// and keyword-rich (task terms + outcome terms) so the term-hit ranker can
/// surface it for a later task that touches the same files/feature/decision.
export function formatWorkLogEntry(agent: string, instruction: string, result: string): string {
  return `@${agent} — TASK: ${clip(instruction, 240)}\nDID: ${clip(result, 700)}`;
}

type WorkEntry = { content: string; author?: string; tags?: string; key?: string };

/// Render retrieved work entries into the block prepended to a specialist's task,
/// framed as "what teammates already did, relevant to YOUR task". Empty → "".
export function renderRelevantWork(entries: WorkEntry[]): string {
  if (!entries.length) return "";
  const lines = entries.map((e) => `  • ${clip(e.content, 500)}`);
  return [
    "RELEVANT TEAM WORK SO FAR (what teammates already did on this — build on it, do NOT redo it or contradict it):",
    ...lines,
  ].join("\n");
}

/// Prepend the relevant-work block to a specialist's instruction, clearly fenced
/// so the model knows which part is its actual task. No block → instruction as-is.
export function enrichInstructionWithMemory(memBlock: string, instruction: string): string {
  const m = (memBlock || "").trim();
  if (!m) return instruction;
  return `${m}\n\n--- YOUR TASK ---\n${instruction}`;
}
