// GitHub account connection — frontend bindings.
//
// The agents run inside the sandbox (WSL/Lima/bwrap) for isolated projects, and
// the host's GitHub credentials don't cross that boundary. Connecting a GitHub
// account writes the user's token into the SANDBOX's git credential store (and
// the host's), so an isolated agent can clone private repos and push commits.
// See src-tauri/src/github.rs.

import { invoke } from "@tauri-apps/api/core";

/// Fired whenever the GitHub/vault connection changes (connect, disconnect, or a
/// device-flow authorization completes) — from ANY surface. Passive consumers of
/// `githubStatus()`/`vaultStatus()` listen for this so an in-window change is
/// reflected immediately, instead of only on the next `window` focus.
export const GITHUB_CHANGED_EVENT = "owllm:github-changed";

/// Broadcast a connection change. Dispatched centrally from the mutation helpers
/// below so every connect/disconnect/authorize path notifies, with no call site
/// to forget. Read-only `githubStatus()`/`vaultStatus()` never dispatch (no loop).
function notifyGithubChanged(): void {
  try { window.dispatchEvent(new CustomEvent(GITHUB_CHANGED_EVENT)); } catch { /* no DOM */ }
}

export type GithubStatus = {
  connected: boolean;
  login: string | null;
};

export type GithubConnect = {
  login: string;
  email: string;
  sandboxConfigured: boolean;
  hostConfigured: boolean;
  ghConfigured: boolean;
};

export async function githubStatus(): Promise<GithubStatus> {
  try {
    return await invoke<GithubStatus>("github_status");
  } catch {
    return { connected: false, login: null };
  }
}

/// Validate + store the token and wire git/gh credentials into the sandbox.
export async function githubConnect(token: string, distro?: string | null): Promise<GithubConnect> {
  const r = await invoke<GithubConnect>("github_connect", { token, distro: distro ?? null });
  notifyGithubChanged();
  return r;
}

export async function githubDisconnect(distro?: string | null): Promise<void> {
  await invoke("github_disconnect", { distro: distro ?? null });
  notifyGithubChanged();
}

// ---- OAuth Device Flow ("Sign in with GitHub" — no token paste) ----------

/// Public OAuth App client id (safe to embed — Device Flow uses no secret).
/// Owned by the OWLLM org; Device Flow enabled.
export const GITHUB_CLIENT_ID = "Ov23lilBGQ0Di6rzrrSX";

export type DeviceCodeStart = {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  interval: number;
  expiresIn: number;
};
export type DevicePollResult = {
  status: "pending" | "slowDown" | "authorized" | "denied" | "expired" | "error";
  login: string | null;
  detail: string | null;
};

export async function githubDeviceStart(): Promise<DeviceCodeStart> {
  return invoke<DeviceCodeStart>("github_device_start", { clientId: GITHUB_CLIENT_ID });
}
export async function githubDevicePoll(deviceCode: string): Promise<DevicePollResult> {
  const r = await invoke<DevicePollResult>("github_device_poll", { clientId: GITHUB_CLIENT_ID, deviceCode });
  if (r.status === "authorized") notifyGithubChanged();
  return r;
}

// ---- Sync vault (the user's private owllm-vault repo) --------------------

export type VaultStatus = {
  connected: boolean;
  login: string | null;
  repoExists: boolean;
  cloned: boolean;
  path: string | null;
  repoUrl: string | null;
};

export async function vaultStatus(): Promise<VaultStatus> {
  try {
    return await invoke<VaultStatus>("vault_status");
  } catch {
    return { connected: false, login: null, repoExists: false, cloned: false, path: null, repoUrl: null };
  }
}

/// Create (if missing) + clone the private owllm-vault repo. Idempotent.
export async function vaultEnsure(): Promise<VaultStatus> {
  const v = await invoke<VaultStatus>("vault_ensure");
  notifyGithubChanged();
  return v;
}

/// Deep link to create a token with the right scope pre-selected. Classic PAT
/// with `repo` scope works everywhere (private clone + push); fine-grained
/// tokens also work with Contents read/write on the target repos.
export const GITHUB_TOKEN_URL =
  "https://github.com/settings/tokens/new?scopes=repo&description=OwLLM%20Desktop";
