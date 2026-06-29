// Structured per-agent prompt — the AgentEditorModal edits four labelled
// sections (General, Mission, Rules, Definition of Done) but STORAGE stays a
// single `extra_prompt` markdown string in the team template. These pure
// helpers are the parse/serialize bridge between the two.
//
// Kept in their own runtime-import-free module (no React/Tauri) so the
// colocated verifier can transpile + load them standalone — same pattern as
// teamConfig.ts ← routing.verify.run.mjs (this repo has no test framework).

export interface AgentPromptSections {
  general: string;
  mission: string;
  rules: string;
  dod: string;
}

// Canonical order — General FIRST. A line is a section boundary only when its
// trimmed text EXACTLY equals one of these headings (case-insensitive). Any
// other `##` line stays literal inside the current section.
const SECTIONS: { key: keyof AgentPromptSections; heading: string }[] = [
  { key: "general", heading: "General" },
  { key: "mission", heading: "Mission" },
  { key: "rules", heading: "Rules" },
  { key: "dod", heading: "Definition of Done" },
];

const HEADING_TO_KEY: Record<string, keyof AgentPromptSections> = {
  "## general": "general",
  "## mission": "mission",
  "## rules": "rules",
  "## definition of done": "dod",
};

// Drop only fully-blank leading/trailing lines (the blank a heading split or
// the section join introduces) — interior content is preserved verbatim.
function trimBlankEdges(s: string): string {
  const lines = s.split("\n");
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.join("\n");
}

export function parseAgentPrompt(raw: string): AgentPromptSections {
  const buckets: Record<keyof AgentPromptSections, string[]> = {
    general: [], mission: [], rules: [], dod: [],
  };
  // Text before the first recognized heading belongs to General.
  let current: keyof AgentPromptSections = "general";
  for (const line of (raw ?? "").split("\n")) {
    const key = HEADING_TO_KEY[line.trim().toLowerCase()];
    if (key) { current = key; continue; }
    buckets[current].push(line);
  }
  return {
    general: trimBlankEdges(buckets.general.join("\n")),
    mission: trimBlankEdges(buckets.mission.join("\n")),
    rules: trimBlankEdges(buckets.rules.join("\n")),
    dod: trimBlankEdges(buckets.dod.join("\n")),
  };
}

export function serializeAgentPrompt(s: AgentPromptSections): string {
  const nonEmpty = SECTIONS
    .map(({ key, heading }) => ({ key, heading, body: trimBlankEdges(s[key] ?? "") }))
    .filter(p => p.body !== "");
  if (nonEmpty.length === 0) return "";
  // Pure freeform (only General) → no heading, so legacy prompts stay clean and
  // round-trip byte-for-byte.
  if (nonEmpty.length === 1 && nonEmpty[0].key === "general") return nonEmpty[0].body;
  return nonEmpty.map(p => `## ${p.heading}\n${p.body}`).join("\n\n");
}
