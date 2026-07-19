export type StorageReader = Pick<Storage, "length" | "key" | "getItem">;

function normalizedLocalProjectPath(path: unknown): string {
  return typeof path === "string"
    ? path.trim().replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase()
    : "";
}

function hasSavedProjectPageContent(state: Record<string, unknown>): boolean {
  return Boolean(
    state.workspace
    || state.pageRename
    || state.draft
    || (Array.isArray(state.messages) && state.messages.length > 0)
    || (Array.isArray(state.secondaryMessages) && state.secondaryMessages.length > 0)
    || (Array.isArray(state.tasks) && state.tasks.length > 0)
  );
}

/**
 * Find page records belonging to the exact checkout bound on this computer.
 * Repo/project identities are deliberately insufficient: the same repository
 * can have a different absolute folder on every PC.
 */
export function savedPageIdsForLocalProject(
  storage: StorageReader,
  projectLocation: string,
  pagePrefix = "owllm:code:page:",
): string[] {
  const root = normalizedLocalProjectPath(projectLocation);
  if (!root) return [];
  const found: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(pagePrefix)) continue;
    const id = key.slice(pagePrefix.length);
    const raw = storage.getItem(key);
    if (!id || !raw) continue;
    try {
      const state = JSON.parse(raw) as Record<string, unknown>;
      const stateRoot = normalizedLocalProjectPath(
        state.projectRoot || (!state.isolated ? state.workspace : ""),
      );
      if (stateRoot === root && hasSavedProjectPageContent(state)) found.push(id);
    } catch {
      continue;
    }
  }
  return found.sort((a, b) => a.localeCompare(b));
}
