// XML-tag tool-call protocol for local llama-server.
//
// Direct TypeScript port of LLM/core/agents/tools/parser.py — the
// legacy Python desktop app uses this exact protocol because most
// local GGUF models (GLM / Llama / Qwen / Gemma variants) don't
// reliably support OpenAI-style function calling. An in-text XML
// scheme is robust across every model and easy to teach via the
// system prompt.
//
// Protocol:
//
//   <tool_call name="write_file">
//     <arg name="path">project/src/main.py</arg>
//     <arg name="content">...</arg>
//   </tool_call>
//
// The dispatch loop appends a tool-listing block to the system
// prompt, streams a model turn, parses every <tool_call> out, runs
// each one against the Rust commands in agent_tools.rs, appends the
// results back into the conversation, and re-streams. Loop ends
// when the model produces a turn with no tool_call blocks — that
// turn is the final answer.

import { invoke } from "@tauri-apps/api/core";

export type ToolCall = {
  name: string;
  args: Record<string, string>;
};

// Match a whole <tool_call ...>...</tool_call> block (lazy). DOTALL
// behavior comes from [\s\S]*? to span newlines without `s` flag
// support concerns.
const CALL_RE = /<tool_call\b([^>]*)>([\s\S]*?)<\/tool_call>/gi;
const NAME_ATTR_RE = /\bname\s*=\s*"([^"]+)"/i;
const ARG_RE = /<arg\b[^>]*\bname\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/arg>/gi;

/// Extract every well-formed <tool_call> block from a model response.
/// Malformed blocks are skipped (logged) rather than throwing — bad
/// model output shouldn't crash the dispatch loop.
export function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  let m: RegExpExecArray | null;
  // Reset the lastIndex on each call since CALL_RE is the same
  // module-scoped /g RegExp.
  CALL_RE.lastIndex = 0;
  while ((m = CALL_RE.exec(text)) !== null) {
    const attrs = m[1];
    const body = m[2];
    const nameMatch = NAME_ATTR_RE.exec(attrs);
    if (!nameMatch) {
      console.warn("[localTools] tool_call without name attr — skipping");
      continue;
    }
    const name = nameMatch[1].trim();
    const args: Record<string, string> = {};
    ARG_RE.lastIndex = 0;
    let am: RegExpExecArray | null;
    while ((am = ARG_RE.exec(body)) !== null) {
      args[am[1]] = am[2].trim();
    }
    calls.push({ name, args });
  }
  return calls;
}

/// Tools that actually MUTATE the world. Used to gate whether the
/// XML protocol block is even worth showing to a given agent. The
/// orchestrator's allowlist is just [dispatch, read_file, list_dir]
/// — pure read-only investigation tools. Telling it the XML format
/// would just compete with the @agent: dispatch convention its
/// system prompt already teaches, and Gemma-class local models then
/// produce neither dispatch lines nor tool_calls. Specialists with
/// write_file_with_diff / edit_file / shell / create_dir get the
/// block; orchestrators don't.
const WRITE_TOOL_NAMES = new Set([
  "write_file_with_diff",
  "write_file",
  "edit_file",
  "shell",
  "shell_exec",
  "create_dir",
]);

/// Render the tools the agent is allowed to call as a system-prompt
/// block. Matches the format parseToolCalls reads, with one worked
/// example so the model has a tight reference + example in one place.
/// Mirrors format_for_prompt in LLM/core/agents/tools/parser.py:69.
///
/// If `allowed` is given but doesn't overlap our registry (e.g. the
/// legacy yaml lists tools we haven't ported yet), fall through to
/// the full registry rather than emitting nothing — otherwise the
/// model sees zero tools and silently degrades to text-only answers.
export function formatToolsForPrompt(allowed?: string[]): string {
  let tools = LOCAL_TOOL_SPECS;
  if (allowed && allowed.length > 0) {
    const filtered = LOCAL_TOOL_SPECS.filter((t) => allowed.includes(t.name));
    if (filtered.length > 0) tools = filtered;
    // else: fall through to all tools — allowlist names didn't match
    // any port. Better to expose extra than nothing.
  }
  if (tools.length === 0) return "";
  // GATE: skip the XML protocol block for read-only roles
  // (orchestrators, researchers in read mode, etc). They have their
  // own @agent: dispatch convention; adding a competing tool_call
  // protocol confuses small local models and they emit neither.
  const hasWrite = tools.some((t) => WRITE_TOOL_NAMES.has(t.name));
  if (!hasWrite) return "";
  const lines: string[] = [
    "",
    "--- TOOL PROTOCOL ---",
    "You can invoke tools by emitting blocks of the form:",
    "",
    '  <tool_call name="TOOL_NAME">',
    '    <arg name="ARG_NAME">VALUE</arg>',
    "    ...",
    "  </tool_call>",
    "",
    "Emit one or more blocks per turn. The runtime executes each, replies",
    "with the tool output in a synthetic user turn, then asks you to",
    "continue. When you have nothing left to do, respond with your final",
    "answer and NO tool_call blocks — that ends the loop.",
    "",
    "Available tools:",
    "",
  ];
  for (const t of tools) {
    lines.push(`- ${t.name}: ${t.description}`);
    for (const a of t.args) {
      lines.push(`    - ${a.name} (${a.required ? "required" : "optional"}): ${a.description}`);
    }
    lines.push("");
  }
  lines.push("--- END TOOL PROTOCOL ---");
  return lines.join("\n");
}

type ToolArg = { name: string; required: boolean; description: string };
type ToolSpec = { name: string; description: string; args: ToolArg[] };

/// Tool spec the system prompt advertises. Names match the legacy
/// Python builtin_registry (LLM/core/agents/tools/builtin.py) so any
/// role yaml's tool_allowlist filter resolves correctly. Each entry
/// maps to a Tauri command in src-tauri/src/agent_tools.rs.
export const LOCAL_TOOL_SPECS: ToolSpec[] = [
  {
    name: "read_file",
    description: "Read a UTF-8 text file from disk. Returns the contents as a string.",
    args: [{ name: "path", required: true, description: "Absolute or project-relative file path." }],
  },
  {
    name: "write_file_with_diff",
    description:
      "Create a NEW file or fully rewrite an existing one. Parent dirs are " +
      "created automatically. Use this when writing fresh code / configs / " +
      "READMEs that don't exist yet.",
    args: [
      { name: "path", required: true, description: "Absolute or project-relative file path." },
      { name: "content", required: true, description: "The full file contents to write." },
    ],
  },
  {
    name: "edit_file",
    description:
      "Modify an EXISTING file by replacing an exact substring with new " +
      "content. Use for surgical edits — preserves the rest of the file. " +
      "old_string must match the file byte-for-byte (whitespace included).",
    args: [
      { name: "path", required: true, description: "Absolute or project-relative file path." },
      { name: "old_string", required: true, description: "Exact text to find and replace." },
      { name: "new_string", required: true, description: "Replacement text." },
    ],
  },
  {
    name: "list_dir",
    description: "List the entries (files + subfolders) of a directory.",
    args: [{ name: "path", required: true, description: "Absolute or project-relative directory path." }],
  },
  {
    name: "create_dir",
    description: "Create a directory (and any missing parent dirs).",
    args: [{ name: "path", required: true, description: "Absolute or project-relative directory path." }],
  },
  {
    name: "shell",
    description:
      "Run a shell command. On Windows uses cmd.exe /c, elsewhere sh -c. " +
      "Returns stdout, stderr, exit_code. Use for git, npm install, python " +
      "scripts, etc.",
    args: [{ name: "command", required: true, description: "The shell command line to run." }],
  },
];

export type ToolExecResult = {
  ok: boolean;
  output: string;
};

/// Execute one tool call against the Rust agent_tools commands. Returns
/// a (truncated) human-readable string for splicing back into the
/// conversation as a synthetic user turn. Failures come back with ok:false
/// and the error message — the model decides whether to retry/give up.
export async function executeToolCall(call: ToolCall, projectCwd: string): Promise<ToolExecResult> {
  const cwd = projectCwd || undefined;
  try {
    switch (call.name) {
      case "read_file": {
        const text = await invoke<string>("tool_read_file", { path: call.args.path, cwd });
        return { ok: true, output: truncate(text, 8000) };
      }
      case "write_file_with_diff":
      case "write_file": { // accept legacy alias too
        await invoke("tool_write_file", {
          path: call.args.path,
          content: call.args.content ?? "",
          cwd,
        });
        return { ok: true, output: `wrote ${call.args.path}` };
      }
      case "edit_file": {
        // String-replace semantics: read, replace exact old_string with
        // new_string, write back. Matches the legacy edit_file tool.
        const text = await invoke<string>("tool_read_file", { path: call.args.path, cwd });
        const old_s = call.args.old_string ?? "";
        const new_s = call.args.new_string ?? "";
        if (!old_s) return { ok: false, output: "edit_file: old_string is required" };
        if (!text.includes(old_s)) {
          return { ok: false, output: `edit_file: old_string not found in ${call.args.path}` };
        }
        const updated = text.replace(old_s, new_s);
        await invoke("tool_write_file", { path: call.args.path, content: updated, cwd });
        return { ok: true, output: `edited ${call.args.path}` };
      }
      case "list_dir": {
        const entries = await invoke<Array<{ name: string; kind: string; size?: number }>>(
          "tool_list_dir", { path: call.args.path, cwd },
        );
        const lines = entries.map((e) =>
          e.kind === "dir" ? `📁 ${e.name}/` : `📄 ${e.name}${e.size != null ? ` (${e.size}b)` : ""}`,
        );
        return { ok: true, output: lines.join("\n") || "(empty)" };
      }
      case "create_dir": {
        await invoke("tool_create_dir", { path: call.args.path, cwd });
        return { ok: true, output: `created ${call.args.path}` };
      }
      case "shell":
      case "shell_exec": { // accept legacy alias too
        const r = await invoke<{ stdout: string; stderr: string; exitCode: number }>(
          "tool_shell_exec", { command: call.args.command, cwd },
        );
        const parts: string[] = [];
        if (r.stdout.trim()) parts.push(`stdout:\n${truncate(r.stdout, 4000)}`);
        if (r.stderr.trim()) parts.push(`stderr:\n${truncate(r.stderr, 2000)}`);
        parts.push(`exit_code: ${r.exitCode}`);
        return { ok: r.exitCode === 0, output: parts.join("\n\n") };
      }
      default:
        return { ok: false, output: `unknown tool: ${call.name}` };
    }
  } catch (e) {
    return { ok: false, output: String(e) };
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated, ${s.length - max} more chars]`;
}

/// Render a batch of tool results as a single synthetic user turn the
/// model gets back. Matches the Python loop's "tool results follow"
/// envelope so the model knows what's user vs assistant.
export function renderToolResultsForModel(
  calls: ToolCall[],
  results: ToolExecResult[],
): string {
  const lines = ["[tool results — continue when ready; emit no tool_call blocks to end]"];
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    const r = results[i];
    const argsRender = Object.entries(c.args)
      .map(([k, v]) => `${k}=${truncate(v, 120).replace(/\n/g, " ")}`)
      .join(", ");
    lines.push("");
    lines.push(`▶ ${c.name}(${argsRender}) → ${r.ok ? "ok" : "error"}`);
    lines.push(r.output);
  }
  return lines.join("\n");
}
