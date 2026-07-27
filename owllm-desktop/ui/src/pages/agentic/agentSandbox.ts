/// The tools a READ-ONLY agent (orchestrator, sub-leader) may hold. Orchestrators
/// plan and route; specialists do every write. Kept here rather than in
/// AgentsPage so the CLI layer can prove read-only intent from the same list the
/// dispatcher builds it from.
export const READONLY_LOCAL_TOOLS: string[] = [
  "read_file", "list_dir", "grep", "glob",
];

/// True when this allowlist can only read.
///
/// Why this exists: telling the orchestrator "You are READ-ONLY" in its prompt is
/// not a boundary. `codex exec` carries its OWN shell/apply_patch tools that the
/// OWLLM allowlist does not gate, so a `--sandbox workspace-write` orchestrator
/// could — and did — edit the shared checkout, leaving it dirty and making every
/// specialist worktree impossible to cut. The sandbox has to match the allowlist.
///
/// Unrestricted (undefined/empty) stays writable: that is a specialist with no
/// per-role narrowing, and downgrading it would break real work.
export function isReadOnlyToolAllowlist(allowed?: string[] | null): boolean {
  if (!allowed || allowed.length === 0) return false;
  const tools = allowed
    .map(t => (typeof t === "string" ? t.trim() : ""))
    .filter(t => t.length > 0 && !isPersonalPolicyEntry(t));
  // Markers only = a policy-restricted agent that was granted no tools at all.
  // Handing that process write access to the project contradicts the grant.
  return tools.every(t => READONLY_LOCAL_TOOLS.includes(t));
}

/// Read-only intent for ONE CLI spawn, derived from the allowlist the dispatcher
/// already built.
///
/// Deriving it here rather than at each call site is the point: `readOnly` used to
/// be a plain caller-supplied argument, and only 1 of the 14 CLI invoke sites ever
/// passed it — so every Claude/Kimi orchestrator ran with no write boundary while
/// the Codex one looked fixed. A runner that forgets to ask can no longer exist.
/// An explicit `readOnly: true` from a caller still wins (never downgraded).
export function isAgentReadOnly(args: {
  readOnly?: boolean;
  allowedTools?: string[] | null;
}): boolean {
  return args.readOnly === true || isReadOnlyToolAllowlist(args.allowedTools);
}

/// `intersectRuntimeTools` prefixes a personal agent's allowlist with policy /
/// skill / memory markers, all of which use the reserved `__owllm_…__` form.
/// Matched by that shape rather than imported, so this module — the one that
/// decides whether a process may write — stays free of any Tauri-coupled
/// import and can be proved in isolation. `personalAgentRuntime.verify` pins
/// the naming convention.
const PERSONAL_POLICY_ENTRY = /^__owllm_[a-z_]+__/;

function isPersonalPolicyEntry(tool: string): boolean {
  return PERSONAL_POLICY_ENTRY.test(tool);
}
