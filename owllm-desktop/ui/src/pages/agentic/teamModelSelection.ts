export type AgentModelStorage = Pick<Storage, "length" | "key" | "removeItem">;

export function resolveAgentModel(
  agentName: string,
  liveTeamModel: string | null,
  savedTeamModel: string,
  perAgentModels: ReadonlyMap<string, string>,
  serverModel: string | null,
  agentDefaultModel = "",
): string {
  // Per-agent choices are the most specific user intent and must always win.
  // The Team picker is a bulk assignment convenience, not a permanent lock:
  // it materializes one project override per current agent (see
  // assignTeamModelToAgents), after which the user can change any agent alone.
  const perAgent = perAgentModels.get(agentName)?.trim();
  if (perAgent) return perAgent;
  // A model pinned on the team template's agent row is also agent-specific.
  if (agentDefaultModel.trim()) return agentDefaultModel.trim();
  return liveTeamModel?.trim() || savedTeamModel.trim() || serverModel || "local";
}

export function assignTeamModelToAgents(
  agentNames: Iterable<string>,
  modelId: string,
): Map<string, string> {
  const assigned = new Map<string, string>();
  const selected = modelId.trim();
  if (!selected) return assigned;
  for (const rawName of agentNames) {
    const name = rawName.trim();
    if (name) assigned.set(name, selected);
  }
  return assigned;
}

export function clearStoredAgentModelOverrides(
  projectId: string,
  storage: AgentModelStorage = localStorage,
): void {
  if (!projectId) return;
  const prefix = `owllm:agent-model:${projectId}:`;
  // Collect first: removing entries while walking Storage by index can skip the
  // item that shifts into the removed slot.
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}

export function graphJsonWithAgentModels(
  raw: string | null | undefined,
  agentModels: ReadonlyMap<string, string>,
): string {
  let graph: Record<string, unknown> = {};
  if (raw?.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) graph = parsed;
    } catch {
      // Preserve a usable graph envelope even if an old row is malformed.
    }
  }
  return JSON.stringify({ ...graph, agentModels: Object.fromEntries(agentModels) });
}
