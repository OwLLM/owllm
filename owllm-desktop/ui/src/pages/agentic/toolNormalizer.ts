// toolNormalizer.ts — canonicalisation of NATIVE tool calls.
//
// Local tool-calling uses ONE protocol: the model's own chat template
// (llama-server `--jinja`) renders the OpenAI `tools` array into whatever
// special tokens the model was trained on (Qwen3 <tool_call>, Llama 3.1
// <|python_tag|>, Hermes/Mistral/Gemma native), and llama-server parses
// the model's output back into structured `delta.tool_calls`. We read
// those directly — no XML protocol injected into the prompt, no regex
// dialect parsing of the visible reply. (The older approach injected a
// foreign XML catalog, which fought the model's training and made small
// models invent a third format; see git history + memory
// local-model-native-tool-protocol.)
//
// This module's only job: take the structured native calls and resolve
// each to a canonical registry tool + arg names, so harmless naming
// drift (web-search vs web_search, q vs query, mcp__x__y vs mcp:x:y)
// doesn't reach the executor.

import {
  type ToolCall,
  canonicalToolName,
  resolveArgAliases,
} from "./localTools";

/// A native tool_call harvested from delta.tool_calls — name + a parsed
/// arguments object (the SSE consumer JSON-parses the streamed args
/// fragments before handing them here).
export type RawNativeCall = { name: string; args: Record<string, unknown> };

/// Resolve a batch of native calls to canonical ToolCalls. Drops any
/// whose tool name can't be resolved to the registry (validateCall then
/// surfaces a structured "unknown tool" error to the model). `opts
/// .firstRequiredArg` binds a lone positional value to the tool's first
/// required arg on the rare model that emits one. Identical (name, args)
/// pairs are de-duplicated.
export function canonicalizeNativeCalls(
  nativeCalls: RawNativeCall[],
  opts: { firstRequiredArg: (tool: string) => string | null },
): ToolCall[] {
  const out: ToolCall[] = [];
  const seen = new Set<string>();
  for (const raw of nativeCalls) {
    const name = canonicalToolName(raw.name);
    if (!name) continue;
    const args = { ...raw.args };
    if ("__positional__" in args) {
      const val = args.__positional__;
      delete args.__positional__;
      const firstArg = opts.firstRequiredArg(name);
      if (firstArg && !(firstArg in args)) args[firstArg] = val;
    }
    const call: ToolCall = { name, args: resolveArgAliases(name, args) };
    const key = `${call.name}::${JSON.stringify(call.args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(call);
  }
  return out;
}
