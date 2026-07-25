export type WorktreeCreateState =
  | { status: "ready"; path: string; branch: string; baseSha: string }
  | { status: "notAGitRepo" }
  | { status: "dirtyWorkingTree"; details: string }
  | { status: "error"; message: string };

export function requiresAgentWorktree(projectCwd: string): boolean {
  return projectCwd.trim().length > 0;
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
      "Project has uncommitted tracked changes, so OWLLM cannot cut a complete isolated worktree.",
      "Commit or stash them, then retry. The run was stopped before the agent started.",
      result.details,
    ].filter(Boolean).join("\n\n");
  }
  return [
    `Could not create the required isolated worktree for @${agentName}: ${result.message}.`,
    "The run was stopped instead of falling back to the shared project folder.",
  ].join(" ");
}
