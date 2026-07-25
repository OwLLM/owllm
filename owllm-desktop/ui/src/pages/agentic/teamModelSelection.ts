export type AgentModelStorage = Pick<Storage, "length" | "key" | "removeItem">;

export function resolveAgentModel(
  agentName: string,
  liveTeamModel: string | null,
  savedTeamModel: string,
  perAgentModels: ReadonlyMap<string, string>,
  serverModel: string | null,
  agentDefaultModel = "",
): string {
  // A live team-picker choice is an explicit "assign to every agent" action.
  // It must win immediately, even while stale per-agent overrides are being
  // removed from persistence. An empty live choice explicitly means server.
  if (liveTeamModel !== null) return liveTeamModel.trim() || serverModel || "local";
  const perAgent = perAgentModels.get(agentName)?.trim();
  if (perAgent) return perAgent;
  if (agentDefaultModel.trim()) return agentDefaultModel.trim();
  return savedTeamModel.trim() || serverModel || "local";
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

export function graphJsonWithoutAgentModels(raw: string | null | undefined): string {
  let graph: Record<string, unknown> = {};
  if (raw?.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) graph = parsed;
    } catch {
      // Preserve a usable graph envelope even if an old row is malformed.
    }
  }
  return JSON.stringify({ ...graph, agentModels: {} });
}
