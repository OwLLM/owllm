export type WorktreeCreateState =
  | {
      status: "ready"; path: string; branch: string; baseSha: string;
      /// Present when the shared checkout had uncommitted tracked work that
      /// OWLLM saved as a checkpoint commit so this worktree could be cut.
      checkpointSha?: string;
      checkpointFiles?: string[];
    }
  | { status: "notAGitRepo" }
  | { status: "dirtyWorkingTree"; details: string }
  | { status: "error"; message: string };

/// A worktree preflight stopped before a specialist received filesystem tools.
/// Notebook callers keep that card pending (rather than recording a completed
/// failed attempt) so the same isolated job can be retried after the underlying
/// project/WSL/Git condition is corrected.
export class WorktreePreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreePreflightError";
  }
}

/// Environments whose work happens in the browser and in documents rather than
/// in a source tree. Worktrees isolate concurrent edits to code; requiring one
/// here gated browser-only assistant work on repository isolation it never
/// needed, and stopped the run before the CLI even started.
const BROWSER_FIRST_PRESETS = new Set([
  "personal-operations",
  "research-desk",
  "writing-room",
  "campaign-desk",
]);

export function requiresAgentWorktree(
  projectCwd: string,
  environment?: { presetId?: string } | null,
): boolean {
  if (projectCwd.trim().length === 0) return false;
  return !BROWSER_FIRST_PRESETS.has(environment?.presetId ?? "");
}

export type WorktreeInvoker = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

/// Create a per-agent worktree, self-healing the one broken state OWLLM causes
/// itself: a project folder it created and never initialized as a repository.
/// `fleet_repo_init` is local git only — no remote, no GitHub — and refuses a
/// folder the user chose, so those keep the explicit "initialize Git" stop.
export async function createAgentWorktree(
  invokeCommand: WorktreeInvoker,
  args: { projectCwd: string; agentName: string; runId: string; checkpointDirty?: boolean },
): Promise<WorktreeCreateState> {
  const create = async () =>
    (await invokeCommand("fleet_worktree_create", args)) as WorktreeCreateState;
  const result = await create();
  if (result.status !== "notAGitRepo") return result;
  let initialized: unknown;
  try {
    initialized = await invokeCommand("fleet_repo_init", { projectCwd: args.projectCwd });
  } catch (e: any) {
    return {
      status: "error",
      message: `could not initialize Git in "${args.projectCwd}": ${String(e?.message ?? e)}`,
    };
  }
  if (initialized !== true) return result;
  return await create();
}

/// Human-readable note for a create that had to check in the user's open work
/// first. Silently committing on someone's behalf would be worse than the
/// deadlock it replaces, so every checkpoint says what it took and how to undo.
export function worktreeCheckpointNotice(
  result: Extract<WorktreeCreateState, { status: "ready" }>,
): string | null {
  if (!result.checkpointSha) return null;
  const files = result.checkpointFiles ?? [];
  const shown = files.slice(0, 10);
  const more = files.length > shown.length ? `\n   …and ${files.length - shown.length} more` : "";
  return [
    `📌 Checked in ${files.length} uncommitted file(s) as ${result.checkpointSha.slice(0, 8)} so agents could run in isolation.`,
    shown.length ? `   ${shown.join("\n   ")}${more}` : "",
    "   Undo with: git reset --soft HEAD~1",
  ].filter(Boolean).join("\n");
}

export function worktreePreflightError(
  agentName: string,
  projectCwd: string,
  result: Exclude<WorktreeCreateState, { status: "ready" }>,
): WorktreePreflightError {
  return new WorktreePreflightError(worktreeCreationFailure(agentName, projectCwd, result));
}

export function worktreeCreationFailure(
  agentName: string,
  projectCwd: string,
  result: Exclude<WorktreeCreateState, { status: "ready" }>,
): string {
  if (result.status === "notAGitRepo") {
    return [
      `OWLLM cannot safely run @${agentName} with filesystem access because`,
      `"${projectCwd}" is not a Git repository.`,
      "Initialize Git for this project, then retry. The run was stopped before the agent started.",
    ].join(" ");
  }
  if (result.status === "dirtyWorkingTree") {
    return [
      "Project has uncommitted tracked changes and OWLLM could not check them in automatically,",
      "so it cannot cut a complete isolated worktree. Commit or stash them, then retry.",
      "The run was stopped before the agent started.",
      result.details,
    ].filter(Boolean).join("\n\n");
  }
  return [
    `Could not create the required isolated worktree for @${agentName}: ${result.message}.`,
    "The run was stopped instead of falling back to the shared project folder.",
  ].join(" ");
}
