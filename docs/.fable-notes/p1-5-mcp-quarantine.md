# P1-5 · MCP schema sanitization / server quarantine — notes

Completed 2026-06-13. Probe: real localTools.ts bundled with esbuild,
10/10 node assertions — malformed server (tool name with spaces/emoji)
quarantined as a unit with a clear reason while the good server's 2 tools
stay advertised; nameless server quarantined; 6 hostile schemas ($ref
bomb, 12-deep nest, array/string/null roots, union types) all sanitize to
object-rooted grammar-safe shapes without throwing.

## What already existed vs what was added

The per-tool SCHEMA gate (sanitizeToolParameters, llama-grammar-safe
rewriting of $ref/oneOf/deep nesting) was already in localTools.ts and is
good — schemas are FIXABLE, so fixing beats dropping. The gap was NAMES:
the mangling only replaced colons, so a tool named "do stuff! 🚀" produced
an OpenAI-invalid name and poisoned the grammar for EVERY tool (the
"model narrates instead of calling" failure in
`project_agentic_tool_calling_probe`). A bad name has NO safe rewrite
(it must round-trip through unmangleMcpName for execution), hence
quarantine, per server:

- `partitionMcpTools(tools)` → { ok, quarantined } — pure; a server with
  ANY unadvertisable tool name (^[a-zA-Z0-9_-]{1,64}$ after mangling) or
  no server name is dropped whole.
- formatToolsForOpenAI announces each quarantine: console.warn +
  `owllm:mcp:quarantine` CustomEvent (UI surfaces can listen).
- getMcpToolReport rows now carry `quarantined` + `quarantineReason` for
  the MCP page.

## Lessons

- The colon-mangle (`:`→`__`) was the ONLY name validation before this —
  always re-check name constraints when a registry accepts third-party
  identifiers into a grammar/prompt.
- Quarantine is per-SERVER, not per-tool, by design: a server emitting
  garbage names is untrustworthy, and per-tool dropping would silently
  leave a half-working server.
- Possible cross-ref for the open `agentic_tool_calling_probe` memory: if
  agentic tool-calls still fail with MCP on, check the new quarantine
  console lines first — a quarantined-but-needed server is now visible.

## Remaining risks

- The MCP page doesn't yet RENDER the quarantined badge (data is in the
  report rows; MCPPage change deferred — the console + event notice
  satisfy "clear notice" minimally). Cheap follow-up when touching
  MCPPage.
- Duplicate mangled names across servers (a:b__c vs a__b:c collisions)
  are not deduped — astronomically unlikely, but a collision would
  misroute execution; revisit if custom servers proliferate.
