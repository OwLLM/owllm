// WSL isolation — frontend bindings.
//
// Strong isolation: tool-using surfaces (Code, agentic teams, fine-tuning
// chat) run their tools inside a WSL/Ubuntu distro instead of on Windows, so a
// model can't touch the C: drive. A project is "isolated" when its workspace
// path is a \\wsl.localhost\<distro>\... UNC path — the Rust shell tool routes
// such paths into the distro automatically, and file tools write into the
// distro FS over the UNC path. See src-tauri/src/wsl.rs.

import { invoke } from "@tauri-apps/api/core";

export type WslStatus = {
  available: boolean;
  distros: string[];
  defaultDistro: string | null;
};

export type WslProject = {
  name: string;
  distro: string;
  linuxPath: string;
  uncPath: string;
};

export type WslIsolation = {
  enabled: boolean;
  distro: string | null;
};

/// True when a workspace path lives inside a WSL distro (i.e. is isolated).
export function isWslPath(p: string | null | undefined): boolean {
  if (!p) return false;
  const n = p.replace(/\//g, "\\").toLowerCase();
  return n.startsWith("\\\\wsl.localhost\\") || n.startsWith("\\\\wsl$\\");
}

export async function wslStatus(): Promise<WslStatus> {
  try {
    return await invoke<WslStatus>("wsl_status");
  } catch {
    return { available: false, distros: [], defaultDistro: null };
  }
}

export async function wslIsolationGet(): Promise<WslIsolation> {
  try {
    return await invoke<WslIsolation>("wsl_isolation_get");
  } catch {
    return { enabled: false, distro: null };
  }
}

export async function wslIsolationSet(enabled: boolean, distro?: string | null): Promise<WslIsolation> {
  return invoke<WslIsolation>("wsl_isolation_set", { enabled, distro: distro ?? null });
}

export async function wslCreateProject(name: string, distro?: string | null): Promise<WslProject> {
  return invoke<WslProject>("wsl_create_project", { name, distro: distro ?? null });
}

export async function wslListProjects(distro?: string | null): Promise<WslProject[]> {
  try {
    return await invoke<WslProject[]>("wsl_list_projects", { distro: distro ?? null });
  } catch {
    return [];
  }
}
