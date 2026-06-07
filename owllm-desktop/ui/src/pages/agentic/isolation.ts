// Cross-platform sandbox isolation — frontend bindings.
//
// One UI, three engines (Rust picks per-OS): WSL2 on Windows, Lima on macOS,
// bubblewrap on Linux. These wrap the generic `sandbox_*` Tauri commands; on
// Windows they delegate to the original WSL backend, so behaviour there is
// unchanged. See src-tauri/src/sandbox.rs.

import { invoke } from "@tauri-apps/api/core";

export type SandboxStatus = {
  available: boolean;
  /** "wsl" | "lima" | "bubblewrap" | "none" */
  kind: string;
  /** VM-grade boundary (WSL/Lima) vs namespace (bubblewrap). */
  strong: boolean;
  /** Engine not yet runtime-verified on real hardware (Lima/bwrap). */
  beta: boolean;
  targets: string[];
  defaultTarget: string | null;
};

export type SandboxProject = {
  name: string;
  /** Host path the UI uses as the workspace. */
  path: string;
  /** Path inside the sandbox (== path on Linux/macOS). */
  innerPath: string;
  kind: string;
};

export async function sandboxStatus(): Promise<SandboxStatus> {
  try {
    return await invoke<SandboxStatus>("sandbox_status");
  } catch {
    return { available: false, kind: "none", strong: false, beta: false, targets: [], defaultTarget: null };
  }
}

export async function sandboxCreateProject(name: string): Promise<SandboxProject> {
  return invoke<SandboxProject>("sandbox_create_project", { name });
}

export async function sandboxListProjects(): Promise<SandboxProject[]> {
  try {
    return await invoke<SandboxProject[]>("sandbox_list_projects");
  } catch {
    return [];
  }
}

export async function sandboxProvision(): Promise<string> {
  return invoke<string>("sandbox_provision");
}

/// Human label for an engine kind.
export function engineLabel(kind: string): string {
  switch (kind) {
    case "wsl": return "WSL (Ubuntu)";
    case "lima": return "Lima VM";
    case "bubblewrap": return "bubblewrap";
    default: return "sandbox";
  }
}

/// Short strength descriptor for the badge/tooltip.
export function strengthLabel(s: SandboxStatus): string {
  if (!s.available) return "not available";
  return s.strong ? "strong (VM)" : "namespace";
}
