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
  /** Folder-confinement is active: agents see ONLY the project folder, not the
   *  rest of the C: drive / distro home. On Windows needs bubblewrap (Harden). */
  confined: boolean;
  targets: string[];
  defaultTarget: string | null;
  /** Why the engine is unavailable, when the reason is actionable (e.g. the
   *  kernel blocks unprivileged user namespaces, cured once per machine by
   *  Harden). Null when available or when it's simply not installed. */
  detail?: string | null;
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
    return { available: false, kind: "none", strong: false, beta: false, confined: false, targets: [], defaultTarget: null, detail: null };
  }
}

/// Turn ON folder-confinement: install the isolation engine (bubblewrap on
/// Windows/Linux) so agents see ONLY the project folder, not the rest of the C:
/// drive / distro home. Returns the refreshed status (check `confined`).
/// Blocking (apt) — the Rust side keeps the UI responsive. Idempotent.
export async function sandboxHarden(distro?: string | null): Promise<SandboxStatus> {
  return invoke<SandboxStatus>("sandbox_harden", { distro: distro ?? null });
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

/// Per-credential mirror outcome (P1-2): deterministic + observable —
/// what mirrored, what didn't, and why.
export type MirrorStatus = {
  provider: string;
  onHost: boolean;
  inSandbox: boolean;
  detail: string;
};

/// What a login sync did: `synced` = providers now present INSIDE the
/// sandbox; `found_on_host` = providers detected on the Windows side (the
/// source); `report` = one status row per provider with the why.
export type SyncResult = { synced: string[]; found_on_host: string[]; report: MirrorStatus[] };

/// Render the per-credential report as display lines ("✓ claude — mirrored…").
export function mirrorReportLines(r: SyncResult): string[] {
  return (r.report ?? []).map((m) => {
    const icon = m.inSandbox ? "✓" : m.onHost ? "✗" : "·";
    return `${icon} ${m.provider} — ${m.detail}`;
  });
}

/// Mirror the host's CLI logins (codex/claude/gemini) + API keys into the
/// sandbox so isolated agents are authenticated. WSL (Windows) only for now.
export async function sandboxSyncLogins(distro?: string | null): Promise<SyncResult> {
  return invoke<SyncResult>("sandbox_sync_logins", { distro: distro ?? null });
}

/// Which provider logins are present INSIDE the sandbox now (e.g.
/// ["codex","claude","keys"]). Used for account status + to confirm a sync.
export async function sandboxLoginStatus(distro?: string | null): Promise<string[]> {
  try {
    return await invoke<string[]>("sandbox_login_status", { distro: distro ?? null });
  } catch {
    return [];
  }
}

/// Convert a project between isolated and host (copies the files across the
/// boundary and returns the new project to open; the original is left intact).
export async function sandboxConvertProject(current: string): Promise<SandboxProject> {
  return invoke<SandboxProject>("sandbox_convert_project", { current });
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
