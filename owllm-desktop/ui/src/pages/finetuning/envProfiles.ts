// Typed bindings for the fine-tuning Python-environment profiles
// (Rust: src-tauri/src/env_manager.rs). On Windows these envs are built
// and run INSIDE WSL; on native Linux they're local venvs. The Train page
// uses this to let the user pick + install the env a run needs before it
// can start.

import { invoke, Channel } from "@tauri-apps/api/core";

export type PackageSpec = {
  name: string;
  version: string;
  index_url?: string | null;
  cuda_wheel?: boolean;
};

export type EnvProfile = {
  name: string;
  display: string;
  description: string;
  python: string;
  packages: PackageSpec[];
  probe: string;
};

// Mirrors Rust EnvProfileState (#[serde(tag="kind", rename_all="camelCase")]).
// Struct-variant fields keep their snake_case names.
export type EnvProfileState =
  | { kind: "notInstalled" }
  | { kind: "installing" }
  | { kind: "ready"; python_exe: string }
  | { kind: "stale"; python_exe: string; installed_hash: string; current_hash: string }
  | { kind: "broken"; python_exe: string; probe_error: string };

// Mirrors Rust InstallEvent.
export type InstallEvent =
  | { kind: "started"; profile: string; hash: string }
  | { kind: "step"; label: string }
  | { kind: "log"; stream: string; line: string }
  | { kind: "finished"; python_exe: string }
  | { kind: "failed"; error: string };

export const listEnvProfiles = () => invoke<EnvProfile[]>("env_profiles_list");

export const envProfileStatus = (name: string) =>
  invoke<EnvProfileState>("env_profile_status", { name });

export const envProfileUninstall = (name: string) =>
  invoke<void>("env_profile_uninstall", { name });

// Mirrors Rust DoctorCheck / EnvDoctorReport (#[serde(rename_all="camelCase")]).
export type DoctorCheck = {
  id: string;
  label: string;
  ok: boolean;
  warn: boolean;
  detail: string;
  fix?: string | null;
};

export type EnvDoctorReport = {
  profile: string;
  checks: DoctorCheck[];
  healthy: boolean;
  repairRecommended: boolean;
  diagnosis: string;
};

/// Run the environment doctor: targeted probes (sandbox, uv, venv, GPU,
/// torch-vs-GPU-architecture, every package) with named diagnoses. Repair is
/// the existing install/reinstall (hardware-adaptive + atomic).
export const envProfileDoctor = (name: string) =>
  invoke<EnvDoctorReport>("env_profile_doctor", { name });

/// Kick off an install and stream progress. Resolves when the install
/// finishes (or rejects on failure — the Failed event also fires first).
export function installEnvProfile(
  name: string,
  onEvent: (e: InstallEvent) => void,
): Promise<void> {
  const channel = new Channel<InstallEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("env_profile_install", { name, channel });
}

/// A short, human label + colour for an env state pill.
export function envStateLabel(s: EnvProfileState | null): { text: string; color: string } {
  switch (s?.kind) {
    case "ready":   return { text: "✓ ready", color: "#7ff0c5" };
    case "installing": return { text: "installing…", color: "#d9b24a" };
    case "stale":   return { text: "⟳ update available", color: "#d9b24a" };
    case "broken":  return { text: "⚠ broken", color: "#f08a7f" };
    case "notInstalled": return { text: "not installed", color: "var(--fg-muted)" };
    default:        return { text: "—", color: "var(--fg-muted)" };
  }
}
