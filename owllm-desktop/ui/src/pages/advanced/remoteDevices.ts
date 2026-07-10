// Typed bindings to the remote_devices Rust module. Keep these shapes in sync
// with src-tauri/src/remote_devices/protocol.rs.
import { invoke } from "@tauri-apps/api/core";

export type Capabilities = { shell: boolean; wsl: boolean };

export type PermissionPolicy = {
  allow_shell: boolean;
  allow_wsl: boolean;
  allow_file_writes: boolean;
  allow_admin: boolean;
};

export const READ_ONLY_POLICY: PermissionPolicy = {
  allow_shell: false,
  allow_wsl: false,
  allow_file_writes: false,
  allow_admin: false,
};

export type DeviceIdentity = {
  device_id: string;
  name: string;
  os: string;
  arch: string;
  app_version: string;
  ed25519_pub: string;
  x25519_pub: string;
  github_login: string | null;
  capabilities: Capabilities;
  enabled: boolean;
  env_override: boolean;
};

export type DeviceRecord = {
  device_id: string;
  name: string;
  ed25519_pub: string;
  x25519_pub: string;
  os: string;
  arch: string;
  app_version: string;
  github_login: string | null;
  capabilities: Capabilities;
  last_seen: string | null;
  is_self: boolean;
};

export type TrustState = "pending" | "trusted" | "revoked";

export type TrustedController = {
  device_id: string;
  name: string;
  ed25519_pub: string;
  x25519_pub: string;
  state: TrustState;
  policy: PermissionPolicy;
  requested_at: string;
  decided_at: string | null;
};

export type CommandKind = "diagnostics" | "shell" | "wsl" | "file_write" | "admin";

export type CommandResult = {
  request_id: string;
  ok: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  error: string | null;
  decision: string;
  duration_ms: number;
};

export type ControlSession = {
  controller_id: string;
  controller_name: string;
  request_id: string;
  kind: string;
  started_at: string;
};

export type ControlState = { active: boolean; sessions: ControlSession[] };

export type SelfTestResult = {
  ok: boolean;
  sealed_opaque: boolean;
  signature_verified: boolean;
  decision: string;
  device_id: string;
  diagnostics: string;
};

// ---- Identity ----
export const getIdentity = () => invoke<DeviceIdentity>("device_get_identity");
export const setDeviceName = (name: string) => invoke<void>("device_set_name", { name });

// ---- Master enable ----
export const getEnabled = () => invoke<boolean>("device_remote_enabled_get");
export const setEnabled = (enabled: boolean) => invoke<void>("device_remote_enabled_set", { enabled });

// ---- Registry ----
export const listDevices = () => invoke<DeviceRecord[]>("devices_list");
export const forgetDevice = (deviceId: string) => invoke<void>("device_forget", { deviceId });

// ---- Trust / pairing ----
export const listTrusted = () => invoke<TrustedController[]>("device_trust_list");
export const requestPairing = (toDevice: string) => invoke<void>("device_request_pairing", { toDevice });
export const approvePairing = (deviceId: string, policy: PermissionPolicy) =>
  invoke<void>("device_pairing_approve", { deviceId, policy });
export const denyPairing = (deviceId: string) => invoke<void>("device_pairing_deny", { deviceId });
export const revokeTrust = (deviceId: string) => invoke<void>("device_trust_revoke", { deviceId });
export const removeTrust = (deviceId: string) => invoke<void>("device_trust_remove", { deviceId });
export const setPolicy = (deviceId: string, policy: PermissionPolicy) =>
  invoke<void>("device_trust_set_policy", { deviceId, policy });

// ---- Control ----
export const sendCommand = (
  toDevice: string,
  kind: CommandKind,
  command: string,
  timeoutMs?: number,
) => invoke<CommandResult>("device_send", { toDevice, kind, command, timeoutMs: timeoutMs ?? null });
export const controlState = () => invoke<ControlState>("device_control_state");
export const stopRemoteControl = () => invoke<{ cancelled: number }>("device_stop_remote_control");
export const auditTail = (limit?: number) => invoke<unknown[]>("device_audit_tail", { limit: limit ?? 200 });
export const selfTest = () => invoke<SelfTestResult>("device_selftest");
