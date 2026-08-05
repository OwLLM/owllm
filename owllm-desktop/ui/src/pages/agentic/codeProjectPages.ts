export type StorageReader = Pick<Storage, "length" | "key" | "getItem">;
export type ProjectOpenTarget =
  | { kind: "current" }
  | { kind: "saved"; pageId: string };

function normalizedLocalProjectPath(path: unknown): string {
  return typeof path === "string"
    ? path.trim().replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase()
    : "";
}

type CatalogLocation = { id: string; location: string; repo_url?: string };
type CatalogBoundPage = {
  workspace?: string;
  projectRoot?: string;
  projectId?: string;
  repoUrl?: string;
  isolated?: boolean;
  busy?: boolean;
  preparing?: boolean;
};

/**
 * Keep a direct Coding page attached to the stable project it was opened from.
 * The catalog and page session are persisted independently, so changing a
 * project's local checkout used to leave an already-open page operating on the
 * obsolete folder forever. Isolated/running pages are deliberately left alone:
 * their worktree cannot be moved safely underneath an active agent.
 */
export function reconcileCatalogProjectLocation<T extends CatalogBoundPage>(
  state: T,
  project: CatalogLocation | null | undefined,
): T {
  const location = project?.location?.trim() || "";
  if (!location || !state.projectId || state.projectId !== project?.id ||
      state.isolated || state.busy || state.preparing) return state;
  const samePath = normalizedLocalProjectPath(state.workspace) === normalizedLocalProjectPath(location);
  const repoUrl = project?.repo_url || state.repoUrl;
  if (samePath && repoUrl === state.repoUrl && !state.projectRoot) return state;
  return { ...state, workspace: location, projectRoot: undefined, repoUrl };
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

/**
 * A deliberately-created blank Coding page owns the next project selection,
 * even when another tab already has a saved page for that checkout. Recovery
 * is only appropriate when the current page already carries user state.
 */
export function chooseProjectOpenTarget(
  savedPageIds: string[],
  currentPageIsBlank: boolean,
): ProjectOpenTarget {
  if (currentPageIsBlank || savedPageIds.length === 0) return { kind: "current" };
  return { kind: "saved", pageId: savedPageIds[0] };
}
