// GitHub account connection — frontend bindings.
//
// The agents run inside the sandbox (WSL/Lima/bwrap) for isolated projects, and
// the host's GitHub credentials don't cross that boundary. Connecting a GitHub
// account writes the user's token into the SANDBOX's git credential store (and
// the host's), so an isolated agent can clone private repos and push commits.
// See src-tauri/src/github.rs.

import { invoke } from "@tauri-apps/api/core";

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
  return invoke<GithubConnect>("github_connect", { token, distro: distro ?? null });
}

export async function githubDisconnect(distro?: string | null): Promise<void> {
  await invoke("github_disconnect", { distro: distro ?? null });
}

/// Deep link to create a token with the right scope pre-selected. Classic PAT
/// with `repo` scope works everywhere (private clone + push); fine-grained
/// tokens also work with Contents read/write on the target repos.
export const GITHUB_TOKEN_URL =
  "https://github.com/settings/tokens/new?scopes=repo&description=OwLLM%20Desktop";
