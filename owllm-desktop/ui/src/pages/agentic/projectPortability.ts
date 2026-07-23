export type PortableProjectIdentity = {
  location?: string | null;
  repo_url?: string | null;
  created_device_id?: string | null;
  created_device_name?: string | null;
};

export type ProjectAvailability = "local" | "clone-required" | "source-device-only";

/**
 * One rule shared by Coding and Agentic:
 * - absolute folders are usable only when the backend returned this device's binding;
 * - a GitHub identity can be materialized by cloning into a new local folder;
 * - without either, the remote project is visible but never runnable.
 */
export function projectAvailability(project: PortableProjectIdentity): ProjectAvailability {
  if ((project.location || "").trim()) return "local";
  if ((project.repo_url || "").trim()) return "clone-required";
  return "source-device-only";
}

export function projectCanRun(project: PortableProjectIdentity): boolean {
  return projectAvailability(project) === "local";
}

export function projectOriginLabel(project: PortableProjectIdentity): string {
  return (project.created_device_name || "").trim() || "legacy/unknown device";
}
