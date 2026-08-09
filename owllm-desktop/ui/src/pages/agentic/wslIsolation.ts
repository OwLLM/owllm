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
  /** The best REAL Linux distro to run the sandbox in (never docker-desktop).
   *  Map isolated projects through THIS — the raw default can be a busybox
   *  system distro where every shell (incl. Verify) fails. null if none. */
  bestDistro: string | null;
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

/// Map a Windows path to its WSL drive-mount UNC form so the SAME shell router
/// runs agents INSIDE the distro on the user's REAL Windows folder — no copy.
/// `C:\Users\me\proj` → `\\wsl.localhost\<distro>\mnt\c\Users\me\proj`
/// (WSL mounts the Windows drives at /mnt/<drive>). Returns null if the input
/// isn't a plain Windows drive path or no distro is known. This is "isolate in
/// place": Linux process + toolchain + write-jail, operating on the live repo.
export function winToWslMountUnc(winPath: string | null | undefined, distro: string | null | undefined): string | null {
  if (!winPath || !distro) return null;
  const m = winPath.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!m) return null;
  const drive = m[1].toLowerCase();
  const rest = m[2].replace(/\//g, "\\").replace(/^\\+/, "").replace(/\\+$/, "");
  return rest
    ? `\\\\wsl.localhost\\${distro}\\mnt\\${drive}\\${rest}`
    : `\\\\wsl.localhost\\${distro}\\mnt\\${drive}`;
}

// Session cache for the WSL probe. wsl_status shells out to wsl.exe twice
// (`-l -q` plus a bash round-trip), and both AgentsPage and CodePage probe it
// on mount — with a fresh body mounted per tab, that re-ran the spawn on every
// page/tab open. Which distros exist does not change while the app runs unless
// the user installs or provisions one, and those paths invalidate below.
//
// ONLY a positive result is cached. A negative ("no WSL") can be a cold
// service that hasn't warmed yet, and caching that would make the app claim
// WSL is missing for the rest of the session — the same trap CodePage's
// probeSandboxOnce documents. A miss therefore always re-probes.
let cachedWslStatus: WslStatus | null = null;

/// Drop the cached probe. Call after anything that can change which distros
/// exist (install / provision), so the next reader sees the new truth.
export function invalidateWslStatus(): void {
  cachedWslStatus = null;
}

export async function wslStatus(force = false): Promise<WslStatus> {
  if (!force && cachedWslStatus) return cachedWslStatus;
  try {
    const status = await invoke<WslStatus>("wsl_status");
    if (status.available) cachedWslStatus = status;
    return status;
  } catch {
    return { available: false, distros: [], defaultDistro: null, bestDistro: null };
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
  try {
    return await invoke<string>("wsl_provision", { distro: distro ?? null });
  } finally {
    // Provisioning can create the distro that the cached probe said was
    // missing — re-validate rather than serve the pre-install answer.
    invalidateWslStatus();
  }
}

/// Launch `wsl --install` (elevated; needs a reboot). For PCs without WSL.
export async function wslInstall(): Promise<string> {
  try {
    return await invoke<string>("wsl_install");
  } finally {
    invalidateWslStatus();
  }
}

/// Core toolchain ready = node + git present (the minimum for agent tooling).
export function toolchainReady(t: WslToolchain | null): boolean {
  return !!t && t.node && t.git;
}
