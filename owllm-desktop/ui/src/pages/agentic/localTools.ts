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

// Fallback: many small models (Gemma / Llama 3.x / Qwen 2.5 variants)
// were trained on Llama-3-style native tool tokens and emit
//   <|tool_call>call:NAME{key:"val",key2:"val2"}<tool_call|>
// or close variants regardless of system-prompt instructions. The
// user hit this on a Gemma-class model emitting fabricated `_tool_output`
// blocks right after each `<|tool_call>` — the model thinks it has
// already executed the tool. We catch the native format here so the
// real runtime executes the call and the fabricated output gets
// stripped before the user sees the reply.
const NATIVE_CALL_RE = /<\|?\s*tool_call\b[^>]*>?\s*(?:call\s*:\s*)?([a-zA-Z_][a-zA-Z0-9_]*)\s*(\{[\s\S]*?\})\s*<\/?\s*tool_call\s*\|?>/gi;
// Strip fabricated `<|tool_response>...<_end_tool_output>` blocks
// from the visible reply. The model invents these to look like it
// executed the call; the real runtime appends real results in a
// separate synthetic user turn, so the visible reply should never
// contain them. Cover the common variants the user has seen.
const FABRICATED_RESPONSE_RE = /<\|?\s*tool_response\s*\|?>[\s\S]*?(?:_end_tool_output|<\/?\s*tool_response\s*\|?>|<eos>)/gi;
const STRAY_EOS_RE = /<eos>|<\|?\s*eos\s*\|?>/gi;

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
  // Fallback: Llama-3-native tool-token format. Only scan if the XML
  // parser didn't find anything — avoids double-executing when a model
  // somehow emits both protocols.
  if (calls.length === 0) {
    NATIVE_CALL_RE.lastIndex = 0;
    while ((m = NATIVE_CALL_RE.exec(text)) !== null) {
      const name = m[1].trim();
      const argsBlob = m[2];
      const args: Record<string, string> = {};
      // The args blob looks like JSON but small models emit it with
      // unquoted keys and stray whitespace. Try JSON.parse first; on
      // failure fall back to a key-by-key regex sweep.
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(argsBlob) as Record<string, unknown>;
      } catch {
        // Try to coerce to valid JSON: quote unquoted keys.
        try {
          const coerced = argsBlob.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
          parsed = JSON.parse(coerced) as Record<string, unknown>;
        } catch {
          // Regex sweep — captures `key:"value"` pairs even if the
          // surrounding JSON is malformed.
          const KV_RE = /([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*"((?:[^"\\]|\\.)*)"/g;
          let kv: RegExpExecArray | null;
          while ((kv = KV_RE.exec(argsBlob)) !== null) {
            args[kv[1]] = kv[2];
          }
        }
      }
      if (parsed) {
        for (const [k, v] of Object.entries(parsed)) {
          args[k] = typeof v === "string" ? v : JSON.stringify(v);
        }
      }
      // Push even with empty args — some tools (list_dir on cwd)
      // legitimately have no args, and an unparseable args blob
      // still tells us which tool the model wanted to call.
      calls.push({ name, args });
    }
  }
  return calls;
}

/// Strip fabricated tool-output blocks and stray native-format
/// tokens from a model reply before it's shown to the user / fed
/// back into history. Small models that fabricate tool results
/// after their own tool_calls leak nonsense JSON into the visible
/// chat without this filter.
export function stripFabricatedToolOutput(text: string): string {
  let out = text;
  out = out.replace(FABRICATED_RESPONSE_RE, "");
  out = out.replace(STRAY_EOS_RE, "");
  // Drop the dangling `<|tool_call>...<tool_call|>` blocks once
  // we've parsed them — they're noise in the visible reply.
  out = out.replace(NATIVE_CALL_RE, "");
  // Drop the well-formed XML tool_call blocks too. parseToolCalls
  // extracts them from the raw reply and the runtime executes
  // them; the user shouldn't see the raw '<tool_call name="…">…
  // </tool_call>' XML rendered as plain text. The previous strip
  // missed this case and the user saw the whole 'create_dir / shell
  // / web_search / write_file' XML pasted into the chat.
  out = out.replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, "");
  // Half-formed / nested tool_call openings the model emits when
  // it confuses itself — single </tool_call>, lone <tool_call ...>
  // without close, stray <arg> tags. Remove these so the user
  // doesn't see the leftover XML scaffolding.
  out = out.replace(/<\/?\s*tool_call\b[^>]*\/?>/gi, "");
  out = out.replace(/<\/?\s*arg\b[^>]*\/?>/gi, "");
  return out.trim();
}

/// Render the tools the agent is allowed to call as a system-prompt
/// block. Matches the format parseToolCalls reads, with one worked
/// example so the model has a tight reference + example in one place.
/// Mirrors format_for_prompt in LLM/core/agents/tools/parser.py:69.
///
/// Local models get the FULL tool registry — no allowlist filtering,
/// no read-only gate, no per-role pruning. Matches the Claude Code /
/// Codex model where every agent has every tool and the role's system
/// prompt (not the runtime) decides what the agent should do with them.
/// The `allowed` parameter is accepted for API-compat with the Claude
/// CLI subscription path (which forwards it as --allowedTools) but is
/// IGNORED here on purpose.
///
/// MCP tools from connected servers are merged in dynamically — every
/// `mcp_list_all_tools` entry becomes a tool advertised as
/// `mcp:<server>:<tool>` so models can discover and call them via the
/// same XML protocol they use for built-in tools.
export async function formatToolsForPrompt(_allowed?: string[]): Promise<string> {
  const tools = LOCAL_TOOL_SPECS;
  // Pull MCP tools at request time so the catalog stays in sync when
  // the user starts/stops servers mid-session. mcp_list_all_tools is
  // a cheap in-memory aggregation on the Rust side; safe to call per
  // dispatch. Failures fall back to "no MCP tools" — never block the
  // dispatch on an MCP enumeration error.
  let mcpTools: AggregatedMcpTool[] = [];
  try {
    mcpTools = await invoke<AggregatedMcpTool[]>("mcp_list_all_tools");
  } catch { /* MCP unavailable — proceed with built-ins only */ }
  if (tools.length === 0 && mcpTools.length === 0) return "";
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
  if (mcpTools.length > 0) {
    lines.push("MCP tools (from connected Model Context Protocol servers):");
    lines.push("");
    for (const m of mcpTools) {
      lines.push(`- ${m.qualifiedName}: ${m.description}`);
      // Render top-level JSON Schema properties as args. Most MCP tools
      // use a flat object schema, which maps cleanly to our <arg> tags.
      const props = (m.inputSchema && typeof m.inputSchema === "object")
        ? (m.inputSchema as Record<string, unknown>).properties as Record<string, unknown> | undefined
        : undefined;
      const required = (m.inputSchema && typeof m.inputSchema === "object")
        ? (m.inputSchema as Record<string, unknown>).required as string[] | undefined
        : undefined;
      if (props && typeof props === "object") {
        for (const [k, v] of Object.entries(props)) {
          const desc = (v && typeof v === "object")
            ? ((v as Record<string, unknown>).description as string | undefined) ?? ""
            : "";
          const req = required?.includes(k) ? "required" : "optional";
          lines.push(`    - ${k} (${req}): ${desc}`);
        }
      }
      lines.push("");
    }
  }
  lines.push("--- END TOOL PROTOCOL ---");
  return lines.join("\n");
}

/// OpenAI function-spec tool list — passed as the `tools` parameter on
/// /v1/chat/completions so llama.cpp activates the model's native chat
/// template tool-calling. Models with native support (Llama 3.1+, Qwen
/// 2.5+, Hermes, Mistral Nemo+, Gemma 3) emit clean `delta.tool_calls`
/// chunks instead of corrupted `<|tool_call|>` special-token soup.
/// Older / template-less models ignore the field and the XML protocol
/// in formatToolsForPrompt still applies as the fallback path.
export async function formatToolsForOpenAI(_allowed?: string[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const t of LOCAL_TOOL_SPECS) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const a of t.args) {
      properties[a.name] = { type: "string", description: a.description };
      if (a.required) required.push(a.name);
    }
    out.push({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: "object",
          properties,
          required,
        },
      },
    });
  }
  // MCP tools — pull at request time so the catalog stays in sync as
  // servers start/stop. Their inputSchema is already JSON Schema, so we
  // can pass it through almost verbatim. Tool name has to be a valid
  // OpenAI identifier (^[a-zA-Z0-9_-]+$); colons in mcp:<server>:<tool>
  // get rewritten to underscores and back on the way out.
  let mcpTools: AggregatedMcpTool[] = [];
  try {
    mcpTools = await invoke<AggregatedMcpTool[]>("mcp_list_all_tools");
  } catch { /* MCP unavailable */ }
  for (const m of mcpTools) {
    const safeName = m.qualifiedName.replace(/:/g, "__");
    out.push({
      type: "function",
      function: {
        name: safeName,
        description: m.description || `MCP tool ${m.qualifiedName}`,
        parameters: (m.inputSchema && typeof m.inputSchema === "object")
          ? m.inputSchema
          : { type: "object", properties: {} },
      },
    });
  }
  return out;
}

/// Reverse the MCP name rewrite from formatToolsForOpenAI. Used by the
/// dispatch loop so it can route native tool_calls back to executeToolCall
/// which expects mcp:<server>:<tool>.
export function unmangleMcpName(name: string): string {
  return name.startsWith("mcp__") ? name.replace(/__/g, ":") : name;
}

type AggregatedMcpTool = {
  qualifiedName: string;
  server: string;
  tool: string;
  description: string;
  inputSchema: unknown;
};

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
  {
    name: "grep",
    description:
      "Regex content search across files under a directory. Returns " +
      "matching {path, line, text} hits. Skips .git / node_modules / " +
      "target / dist / __pycache__ / venv / python_runtime so vendor " +
      "noise is filtered out. Use this to find symbols, callers, " +
      "TODOs, configuration references, anything by content.",
    args: [
      { name: "pattern", required: true, description: "Rust regex to match against each line." },
      { name: "path", required: false, description: "Directory to search under. Defaults to '.' (project cwd)." },
      { name: "glob", required: false, description: "Filename glob filter, e.g. '*.rs' or '*.{ts,tsx}'." },
    ],
  },
  {
    name: "glob",
    description:
      "Find files by filename pattern. Walks the tree under `path` " +
      "and returns every file whose name matches `pattern`. Supports " +
      "* (any chars except /), ** (any depth incl. /), ? (one char). " +
      "Use this to discover files when you don't yet know their content.",
    args: [
      { name: "pattern", required: true, description: "Glob pattern, e.g. 'src/**/*.tsx' or '*.py'." },
      { name: "path", required: false, description: "Directory root for the search. Defaults to '.' (project cwd)." },
    ],
  },
  {
    name: "web_search",
    description:
      "Web search via Brave Search API. Returns up to 5 results " +
      "(title + url + description). Requires BRAVE_API_KEY saved in " +
      "Accounts. Use this to find competitor products, prior art, " +
      "documentation, or background research.",
    args: [
      { name: "query", required: true, description: "Search query string." },
      { name: "max_results", required: false, description: "How many results to return (1-20, default 5)." },
    ],
  },
  {
    name: "web_fetch",
    description:
      "Fetch a URL and return its readable text (HTML stripped, " +
      "script/style removed, whitespace collapsed). Capped at 60 KB. " +
      "Use this on URLs returned by web_search to extract feature lists, " +
      "documentation, etc.",
    args: [{ name: "url", required: true, description: "Absolute URL to fetch." }],
  },
  {
    name: "screenshot_url",
    description:
      "Screenshot a URL via headless Chromium (TwinForge web_adapter). " +
      "Returns the saved PNG path. Use this to capture competitor GUIs " +
      "for the brainstorm GUI-direction synthesis. Output PNG should " +
      "go under <project>/brainstorm/.",
    args: [
      { name: "url", required: true, description: "Absolute URL to screenshot." },
      { name: "out_png", required: true, description: "Absolute filesystem path for the output PNG." },
    ],
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
  // MCP-routed call: name is `mcp:<server>:<tool>`. Split, pass the
  // args dict through as the arguments object — most MCP tools use
  // a flat schema so the dict matches. Failures come back from the
  // MCP server with the right context.
  if (call.name.startsWith("mcp:")) {
    const rest = call.name.slice(4);
    const sep = rest.indexOf(":");
    if (sep <= 0) {
      return { ok: false, output: `bad MCP tool name (expected mcp:<server>:<tool>): ${call.name}` };
    }
    const server = rest.slice(0, sep);
    const tool = rest.slice(sep + 1);
    try {
      const text = await invoke<string>("mcp_call_tool", {
        server, tool, arguments: call.args,
      });
      return { ok: true, output: truncate(text, 8000) };
    } catch (e) {
      return { ok: false, output: String(e) };
    }
  }
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
      case "grep": {
        const hits = await invoke<Array<{ path: string; line: number; text: string }>>(
          "tool_grep", {
            pattern: call.args.pattern ?? "",
            path: call.args.path ?? null,
            glob: call.args.glob ?? null,
            cwd,
          },
        );
        if (hits.length === 0) return { ok: true, output: "(no matches)" };
        const lines = hits.map(h => `${h.path}:${h.line}: ${h.text}`);
        return { ok: true, output: truncate(lines.join("\n"), 8000) };
      }
      case "glob": {
        const paths = await invoke<string[]>("tool_glob", {
          pattern: call.args.pattern ?? "",
          path: call.args.path ?? null,
          cwd,
        });
        if (paths.length === 0) return { ok: true, output: "(no files matched)" };
        return { ok: true, output: truncate(paths.join("\n"), 8000) };
      }
      case "web_search": {
        const maxRaw = call.args.max_results;
        const max = maxRaw ? Math.max(1, Math.min(20, Number(maxRaw) || 5)) : 5;
        const hits = await invoke<Array<{ title: string; url: string; description: string }>>(
          "tool_web_search", { query: call.args.query ?? "", maxResults: max },
        );
        if (hits.length === 0) return { ok: true, output: "(no results)" };
        const lines = hits.map((h, i) =>
          `${i + 1}. ${h.title}\n   ${h.url}\n   ${truncate(h.description, 200)}`
        );
        return { ok: true, output: lines.join("\n\n") };
      }
      case "web_fetch": {
        const text = await invoke<string>("tool_web_fetch", { url: call.args.url ?? "" });
        return { ok: true, output: truncate(text, 12000) };
      }
      case "screenshot_url": {
        const saved = await invoke<string>("tool_screenshot_url", {
          url: call.args.url ?? "",
          outPng: call.args.out_png ?? "",
        });
        return { ok: true, output: `screenshot saved: ${saved}` };
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
