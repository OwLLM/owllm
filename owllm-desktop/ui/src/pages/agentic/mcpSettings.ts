// MCP advertising settings — frontend-persisted (localStorage) controls
// that gate which MCP tools reach the model's native `tools` array.
//
// Why localStorage and not the Rust config: per-server *enabled* (auto-start)
// already lives in mcp_config.json and drives the backend. These two knobs
// are purely about what the dispatch loop ADVERTISES to the model, read at
// request time by formatToolsForOpenAI():
//
//   - master switch — one flip to drop ALL MCP tools from the tools array
//     (local tools stay). Doubles as the A/B lever: if agentic tool-calling
//     misbehaves, turn MCP off and re-run; if it now works, an MCP tool
//     schema was the culprit.
//   - per-tool disable — silence one flaky/poisoning MCP tool without
//     killing its whole server.
//
// Both are intentionally cheap and synchronous so the hot dispatch path
// doesn't await anything.

const MASTER_KEY = "owllm.mcp.master";          // "off" disables MCP tool advertising
const DISABLED_KEY = "owllm.mcp.disabledTools";  // JSON array of qualifiedName strings

/// True unless the user has explicitly turned MCP advertising off. Default
/// on so a fresh install behaves as before (servers auto-start, tools show).
export function isMcpMasterEnabled(): boolean {
  try { return localStorage.getItem(MASTER_KEY) !== "off"; } catch { return true; }
}

export function setMcpMasterEnabled(on: boolean): void {
  try { localStorage.setItem(MASTER_KEY, on ? "on" : "off"); } catch { /* private mode / quota */ }
}

/// Set of `mcp:<server>:<tool>` qualified names the user has switched off.
export function getDisabledMcpTools(): Set<string> {
  try {
    const raw = localStorage.getItem(DISABLED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch { return new Set(); }
}

export function isMcpToolDisabled(qualifiedName: string): boolean {
  return getDisabledMcpTools().has(qualifiedName);
}

export function setMcpToolDisabled(qualifiedName: string, disabled: boolean): void {
  const s = getDisabledMcpTools();
  if (disabled) s.add(qualifiedName);
  else s.delete(qualifiedName);
  try { localStorage.setItem(DISABLED_KEY, JSON.stringify([...s])); } catch { /* best-effort */ }
}
