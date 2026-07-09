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

/// Render retrieved work entries into a compact context pack prepended to a
/// specialist's task. This is the deterministic Memory Curator layer: retrieved
/// memory is framed as reference material for the CURRENT task, never as a task
/// to continue or a proof that work is already complete.
export function renderRelevantWork(entries: WorkEntry[]): string {
  if (!entries.length) return "";
  const facts = entries.filter((e) => e.tags !== "worklog");
  const work = entries.filter((e) => e.tags === "worklog");
  const render = (e: WorkEntry) => {
    const k = e.key ? `[${e.key}] ` : "";
    return `  - ${k}${clip(e.content, 500)}`;
  };
  const lines: string[] = [
    "MEMORY CURATOR CONTEXT PACK",
    "Use this only as evidence/reference for the CURRENT task. If it conflicts with",
    "the user's current request or the files/tools you inspect now, trust the current",
    "request and live evidence. Do not report old completed work as today's result.",
  ];
  if (facts.length) {
    lines.push("", "Relevant durable facts:");
    lines.push(...facts.map(render));
  }
  if (work.length) {
    lines.push("", "Recent related worklog (reference-only; may be stale):");
    lines.push(...work.map(render));
  }
  lines.push("", "Current task follows.");
  return lines.join("\n");
}

/// Prepend the relevant-work block to a specialist's instruction, clearly fenced
/// so the model knows which part is its actual task. No block → instruction as-is.
export function enrichInstructionWithMemory(memBlock: string, instruction: string): string {
  const m = (memBlock || "").trim();
  if (!m) return instruction;
  return `${m}\n\n--- YOUR TASK ---\n${instruction}`;
}
