// toolNormalizer.ts — the "tolerant parser / repair layer" of the
// universal tool-calling system.
//
//   model output (any dialect)
//        ↓
//   normalizeToolCalls()   ← THIS FILE
//        ↓
//   canonical ToolCall[]  (registry names + arg names, validated)
//        ↓
//   executeToolCall()
//
// The golden rule (see memory local-model-native-tool-protocol): do NOT
// trust the model to follow one exact format. Every local family emits a
// different tool dialect; this layer accepts all of them and normalises
// to one boring internal shape. Tolerant parser, strict executor.
//
// Dialects handled:
//   1. Native delta.tool_calls (already structured — just canonicalize)
//   2. XML  <tool_call name="x"><arg name="y">v</arg></tool_call>
//   3. Llama native  <|tool_call>call:name{...}<tool_call|>
//   4. Bare JSON     {"name":"x","arguments":{...}}
//      + aliases     {"tool":"x","input":{...}} / {"function":{...}}
//   5. ReAct         Action: x\nAction Input: {...}
//   6. Python-call   search({"query":"cats"})  /  search(query="cats")
//   7. Fenced        any of the above inside ```json ... ``` fences
//
// Each parsed call is run through canonicalToolName + resolveArgAliases
// so "web-search"/"search"/"browser.search" all become "web_search" and
// q/search_query/text all become "query".

import {
  type ToolCall,
  parseToolCalls,
  canonicalToolName,
  resolveArgAliases,
} from "./localTools";

/// A native tool_call harvested from delta.tool_calls — name + a parsed
/// (or raw) arguments object.
export type RawNativeCall = { name: string; args: Record<string, unknown> };

// ---- JSON repair helpers -------------------------------------------

/// Strip Markdown code fences (```json … ``` / ``` … ```) so the JSON
/// inside is parseable. Returns the de-fenced text; harmless on text
/// with no fences.
function stripCodeFences(text: string): string {
  return text.replace(/```[a-zA-Z0-9_]*\s*\n?/g, "").replace(/```/g, "");
}

/// Best-effort coerce a loose JSON-ish blob to valid JSON, then parse.
/// Applies only SAFE repairs: quote unquoted keys, convert single- to
/// double-quotes when no double-quotes are already present, drop trailing
/// commas. Returns null on failure (never throws).
function tryParseLooseJson(blob: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  const trimmed = blob.trim();
  candidates.push(trimmed);
  // Quote unquoted keys: {key: 1} → {"key": 1}
  candidates.push(trimmed.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":'));
  // Single → double quotes, but only if there are no existing double
  // quotes (otherwise we'd corrupt strings containing apostrophes).
  if (!trimmed.includes('"') && trimmed.includes("'")) {
    candidates.push(trimmed.replace(/'/g, '"'));
    candidates.push(
      trimmed.replace(/'/g, '"').replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":'),
    );
  }
  // Drop trailing commas: {"a":1,} → {"a":1}
  candidates.push(trimmed.replace(/,(\s*[}\]])/g, "$1"));
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch { /* try next candidate */ }
  }
  return null;
}

/// Extract the first balanced {...} JSON object starting at or after
/// `from`. Returns [objectText, endIndex] or null. Brace-counting so we
/// don't stop at a nested object's first }.
function extractFirstJsonObject(text: string, from = 0): [string, number] | null {
  const start = text.indexOf("{", from);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return [text.slice(start, i + 1), i + 1];
    }
  }
  return null;
}

// ---- Dialect parsers (each returns RawNativeCall[]; empty if no hit)--

/// 4. Bare / aliased JSON objects: {"name"|"tool"|"function.name", …}.
/// Scans the WHOLE text for every balanced top-level object and keeps
/// the ones that look like a tool call. This catches a model that
/// emits one JSON object, several, or JSON embedded in prose.
function parseJsonCalls(text: string): RawNativeCall[] {
  const out: RawNativeCall[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const found = extractFirstJsonObject(text, cursor);
    if (!found) break;
    const [objText, end] = found;
    cursor = end;
    const obj = tryParseLooseJson(objText);
    if (!obj) continue;
    // name aliases: name | tool | tool_name | function.name
    let name: string | undefined =
      (typeof obj.name === "string" && obj.name) ||
      (typeof obj.tool === "string" && obj.tool) ||
      (typeof obj.tool_name === "string" && obj.tool_name) ||
      undefined;
    let argsRaw: unknown =
      obj.arguments ?? obj.args ?? obj.input ?? obj.parameters ?? obj.params;
    // OpenAI nested shape: {"function":{"name":…,"arguments":"{...}"}}
    if (!name && obj.function && typeof obj.function === "object") {
      const fn = obj.function as Record<string, unknown>;
      if (typeof fn.name === "string") name = fn.name;
      argsRaw = argsRaw ?? fn.arguments ?? fn.args;
    }
    if (!name) continue;
    let args: Record<string, unknown> = {};
    if (typeof argsRaw === "string") {
      args = tryParseLooseJson(argsRaw) ?? {};
    } else if (argsRaw && typeof argsRaw === "object") {
      args = argsRaw as Record<string, unknown>;
    }
    out.push({ name, args });
  }
  return out;
}

/// 5. ReAct: `Action: tool_name` followed by `Action Input: {json|text}`.
/// Common in older Llama/Mistral fine-tunes and LangChain-style prompts.
function parseReActCalls(text: string): RawNativeCall[] {
  const out: RawNativeCall[] = [];
  const re = /Action\s*:\s*([a-zA-Z0-9_.\-]+)\s*[\r\n]+\s*Action\s*Input\s*:\s*(.+?)(?=(?:[\r\n]+\s*(?:Action|Observation|Thought)\s*:)|$)/gis;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].trim();
    const inputRaw = m[2].trim();
    let args: Record<string, unknown> = {};
    const obj = tryParseLooseJson(inputRaw);
    if (obj) {
      args = obj;
    } else {
      // Plain-text input → best-guess single positional arg. We can't
      // know the arg name here; leave a sentinel the canonicaliser maps
      // via the tool's FIRST required arg (handled in mapPositional).
      args = { __positional__: inputRaw.replace(/^["']|["']$/g, "") };
    }
    out.push({ name, args });
  }
  return out;
}

/// 6. Python-style call: `tool_name({...})` or `tool_name(key="val", …)`.
/// We only treat it as a tool call when the callee resolves to a known
/// tool (via canonicalToolName) to avoid grabbing random `print(...)`.
function parsePythonCalls(text: string): RawNativeCall[] {
  const out: RawNativeCall[] = [];
  const re = /\b([a-zA-Z_][a-zA-Z0-9_.]*)\s*\(\s*([\s\S]*?)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    if (!canonicalToolName(name)) continue; // not one of our tools
    const inner = m[2].trim();
    if (!inner) { out.push({ name, args: {} }); continue; }
    // (a) single JSON object argument: tool({"query":"x"})
    if (inner.startsWith("{")) {
      const obj = tryParseLooseJson(inner);
      if (obj) { out.push({ name, args: obj }); continue; }
    }
    // (b) kwargs: tool(query="x", n=5)
    const kwargs: Record<string, unknown> = {};
    const kwRe = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^,)\s]+))/g;
    let kw: RegExpExecArray | null;
    let any = false;
    while ((kw = kwRe.exec(inner)) !== null) {
      any = true;
      kwargs[kw[1]] = kw[2] ?? kw[3] ?? kw[4];
    }
    if (any) { out.push({ name, args: kwargs }); continue; }
    // (c) single positional string: tool("x")
    const positional = inner.replace(/^["']|["']$/g, "");
    out.push({ name, args: { __positional__: positional } });
  }
  return out;
}

// ---- Canonicalisation ----------------------------------------------

/// Turn a RawNativeCall into a canonical ToolCall: resolve the tool name
/// to the registry, map arg aliases, and bind any `__positional__`
/// sentinel to the tool's first required arg. Returns null when the tool
/// name can't be resolved (caller may surface "unknown tool").
function canonicalize(raw: RawNativeCall, firstRequiredArg: (tool: string) => string | null): ToolCall | null {
  const name = canonicalToolName(raw.name);
  if (!name) return null;
  let args = { ...raw.args };
  // Bind positional sentinel to the first required arg of the tool.
  if ("__positional__" in args) {
    const val = args.__positional__;
    delete args.__positional__;
    const firstArg = firstRequiredArg(name);
    if (firstArg && !(firstArg in args)) args[firstArg] = val;
  }
  return { name, args: resolveArgAliases(name, args) };
}

/// Dedup by name + JSON(args). Models sometimes emit the same call twice
/// (once in prose, once in a fence); we don't want to run it twice.
function dedup(calls: ToolCall[]): ToolCall[] {
  const seen = new Set<string>();
  const out: ToolCall[] = [];
  for (const c of calls) {
    const key = `${c.name}::${JSON.stringify(c.args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/// THE universal entry point. Given the model's streamed reply text and
/// any natively-harvested delta.tool_calls, return the canonical list of
/// calls to execute. Resolution order:
///   1. Native structured calls (most reliable) — canonicalize + return.
///   2. XML <tool_call> blocks (our primary text protocol).
///   3. Llama native <|tool_call> tokens (handled inside parseToolCalls).
///   4. Bare/aliased JSON, ReAct, Python-call dialects (tolerant fallback).
/// We STOP at the first dialect tier that yields calls, except native +
/// XML which are both authoritative and merged. The looser dialects
/// (3-tier JSON/ReAct/Python) only run when the structured paths found
/// nothing — they're the safety net for models that ignore every
/// protocol we advertised.
export function normalizeToolCalls(
  rawText: string,
  nativeCalls: RawNativeCall[],
  opts: { firstRequiredArg: (tool: string) => string | null },
): ToolCall[] {
  const canon = (r: RawNativeCall) => canonicalize(r, opts.firstRequiredArg);

  // Tier 1: native structured calls.
  if (nativeCalls.length > 0) {
    const mapped = nativeCalls.map(canon).filter((c): c is ToolCall => c !== null);
    if (mapped.length > 0) return dedup(mapped);
  }

  // Tier 2: XML <tool_call> + Llama native tokens (parseToolCalls covers
  // both). These are our advertised protocols, so trust them next.
  const xml = parseToolCalls(rawText);
  if (xml.length > 0) {
    const mapped = xml
      .map((c) => canon({ name: c.name, args: c.args }))
      .filter((c): c is ToolCall => c !== null);
    if (mapped.length > 0) return dedup(mapped);
  }

  // Tier 3: loose dialects, on the de-fenced text. Try each; keep the
  // first that produces a resolvable call. Order by reliability.
  const defenced = stripCodeFences(rawText);
  for (const parser of [parseJsonCalls, parseReActCalls, parsePythonCalls]) {
    const hits = parser(defenced)
      .map(canon)
      .filter((c): c is ToolCall => c !== null);
    if (hits.length > 0) return dedup(hits);
  }

  return [];
}
