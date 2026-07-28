// Where new projects get created.
//
// Onboarding asks once: point OwLLM at the folder you already sync with GitHub,
// or accept OwLLM's own `~/OwLLM/Projects`. The answer is stored PER DEVICE
// (`~/.owllm/projects_root.json`) because a folder path is never portable
// across machines — the vault deliberately never syncs project locations.
//
// Everything that creates a project derives its folder from here, so the user
// stops hand-typing a path for every single project.
import { invoke } from "@tauri-apps/api/core";

export type ProjectsRoot = {
  /// Absolute folder new projects are created under.
  path: string;
  /// False while OwLLM is still falling back to its own default — onboarding
  /// uses this to tell "never asked" from "user accepted the default".
  configured: boolean;
};

/// Resolved root (configured, else OwLLM's default). Never writes to disk.
export async function projectsRootGet(): Promise<ProjectsRoot> {
  return invoke<ProjectsRoot>("projects_root_get");
}

/// Persist the choice and create the folder. `null` accepts OwLLM's default.
export async function projectsRootSet(path: string | null): Promise<ProjectsRoot> {
  return invoke<ProjectsRoot>("projects_root_set", { path });
}

/// Folder-safe leaf name for a project. Kept here (not inline at a call site)
/// so the picker and the prefill can never derive different folders for the
/// same project name.
export function projectFolderSlug(name: string): string {
  return name.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "new-project";
}

/// Next free "<seed> N" for a project kind, so creating a project is two
/// clicks: pick the card, press Create. Numbering continues from the highest
/// existing number rather than the count, so deleting "Personal Assistant 2"
/// never makes the next one collide with "Personal Assistant 3".
export function nextProjectName(seed: string, existing: readonly string[]): string {
  const base = seed.trim() || "Project";
  const numbered = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(\\d+)$`, "i");
  let highest = 0;
  for (const candidate of existing) {
    const match = String(candidate ?? "").trim().match(numbered);
    if (match) highest = Math.max(highest, Number(match[1]) || 0);
  }
  return `${base} ${highest + 1}`;
}

/// Join a parent folder and a project name using the parent's own separator,
/// so a Windows path stays backslashed and a POSIX/WSL path stays forward-
/// slashed. Returns "" for an empty parent so callers can fall back to asking.
export function projectPathUnder(parent: string, name: string): string {
  const base = parent.trim().replace(/[\\/]+$/, "");
  if (!base) return "";
  const sep = base.includes("\\") ? "\\" : "/";
  return `${base}${sep}${projectFolderSlug(name)}`;
}
