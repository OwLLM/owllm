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

export type WslToolchain = {
  node: boolean;
  uv: boolean;
  git: boolean;
  claude: boolean;
  codex: boolean;
  gemini: boolean;
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

export async function wslToolchainStatus(distro?: string | null): Promise<WslToolchain> {
  try {
    return await invoke<WslToolchain>("wsl_toolchain_status", { distro: distro ?? null });
  } catch {
    return { node: false, uv: false, git: false, claude: false, codex: false, gemini: false };
  }
}

/// Install node/uv/git + the agent CLIs inside the distro. Long-running.
export async function wslProvision(distro?: string | null): Promise<string> {
  return invoke<string>("wsl_provision", { distro: distro ?? null });
}

/// Launch `wsl --install` (elevated; needs a reboot). For PCs without WSL.
export async function wslInstall(): Promise<string> {
  return invoke<string>("wsl_install");
}

/// Core toolchain ready = node + git present (the minimum for agent tooling).
export function toolchainReady(t: WslToolchain | null): boolean {
  return !!t && t.node && t.git;
}
