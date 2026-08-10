// Turn a CLI's own excuse into a reason the user can act on.
//
// A subscription CLI that cannot do something rarely FAILS — it answers
// normally and explains itself in prose ("the permission to use
// mcp__owllm__browser_tabs hasn't been granted yet"). That text lands in the
// agent thread looking like a considered decision, so the user re-asks, gets
// the same non-answer, and never learns that a single toggle in THIS app is
// what stands in the way.
//
// This module recognises those replies and maps them to a plain-language cause
// plus one imperative step. It is deliberately pure — no React, no Tauri — so
// the mapping is testable on its own (runBlockers.verify.run.mjs).

export type RunBlockerCode = "cli_tool_permission";

export type RunBlocker = {
  /// Stable id, so a notice can key off the cause rather than the wording.
  code: RunBlockerCode;
  /// Why it really happened, in the app's terms — never the CLI's phrasing.
  why: string;
  /// The ONE thing the user should do. Imperative, single step.
  action: string;
  /// Tools the reply named, when it named any (`mcp__owllm__browser_open`, …).
  tools: string[];
};

/// A reply is a permission block when it says, in any of the CLI's usual
/// phrasings, that permission for something was never granted or was refused.
/// Each pattern requires "permission" AND a granted/denied verdict within the
/// same clause, so an agent merely DISCUSSING permissions doesn't trip it.
const PERMISSION_PATTERNS: RegExp[] = [
  /permissions?\b[^.\n]{0,120}?\b(?:has|have)\s*(?:n[o']?t|not)\s+been\s+granted/i,
  /\b(?:you|we|i)\s+(?:have|haven'?t|has)?\s*n[o']?t\s+granted\b[^.\n]{0,80}permission/i,
  /\brequested\s+permissions?\b[^.\n]{0,80}\b(?:were|was|been)\s+denied/i,
  /\bpermission\s+denied\b[^.\n]{0,80}\bmcp__/i,
  /\bneeds?\s+permission\s+to\s+use\b[^.\n]{0,80}\bmcp__/i,
];

/// Tool ids as the CLI prints them. MCP tools are the ones that matter here —
/// they are the tools OwLLM itself supplies (browser, devices, KVM), so a user
/// reading "the browser is blocked" inside the app that OWNS the browser is
/// exactly the confusion this notice exists to end.
const TOOL_PATTERN = /\bmcp__[a-z0-9_]+/gi;

function namedTools(text: string): string[] {
  const seen: string[] = [];
  for (const m of text.match(TOOL_PATTERN) ?? []) {
    if (!seen.includes(m)) seen.push(m);
  }
  return seen;
}

/// Inspect one CLI reply. Returns null for the overwhelmingly common case of a
/// reply that isn't blocked — callers run this on every turn, so it must stay
/// cheap and must never guess.
export function detectRunBlocker(reply: string | null | undefined): RunBlocker | null {
  const text = (reply ?? "").trim();
  if (!text) return null;
  if (!/permission/i.test(text)) return null; // cheap gate before the regexes
  if (!PERMISSION_PATTERNS.some((re) => re.test(text))) return null;
  const tools = namedTools(text);
  const what = tools.length
    ? tools.length === 1 ? `\`${tools[0]}\`` : `${tools.length} of its tools`
    : "one of its tools";
  return {
    code: "cli_tool_permission",
    why:
      `The CLI refused ${what} because it asks permission per tool, and the run ` +
      `is non-interactive — there is no prompt for you to answer, so it gives up ` +
      `instead of asking. Nothing is wrong with your account, the tool, or the model.`,
    action:
      "Turn Auto mode ON for this project — the ⚡ toggle next to the composer, " +
      "or type /auto — then send the same request again.",
    tools,
  };
}
