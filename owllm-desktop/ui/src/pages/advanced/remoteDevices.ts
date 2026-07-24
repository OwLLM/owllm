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
  endpoint: string | null;
  endpoints: string[];
  listening: boolean;
  public_endpoint: string | null;
  relay_url: string | null;
  relay_client: boolean;
  relay_serving: boolean;
  /// Embedded P2P (iroh) endpoint id — peers can dial it from anywhere, no setup.
  p2p_node_id: string | null;
  p2p_running: boolean;
  agents_allowed: boolean;
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
  endpoint: string | null;
  /// All dialable addresses (public → overlay → LAN). Empty = the device has
  /// never published while its listener was up → Pair can't dial it yet.
  endpoints?: string[];
  relay?: boolean;
  /// Embedded P2P (iroh) endpoint id — dialable from anywhere when set.
  p2p_node_id?: string | null;
  published_at?: string | null;
  last_seen: string | null;
  is_self: boolean;
};

export type PendingApproval = {
  request_id: string;
  controller_id: string;
  controller_name: string;
  kind: string;
  command: string;
  requested_at: string;
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
  session?: string | null;
  data?: string | null;
  exited?: boolean;
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

// ---- Listener / discovery / WAN ----
export const listenerStatus = () => invoke<{ listening: boolean; endpoint: string | null; endpoints: string[] }>("device_listener_status");
export const syncDiscovery = () => invoke<boolean>("device_sync_discovery");
export const setPublicEndpoint = (endpoint: string | null) => invoke<void>("device_set_public_endpoint", { endpoint });
export const setRelay = (url: string | null) => invoke<void>("device_set_relay", { url });
export const relayServe = (bind?: string | null) => invoke<{ serving: boolean; bind: string }>("device_relay_serve", { bind: bind ?? null });
export const relayStop = () => invoke<{ serving: boolean }>("device_relay_stop");
export const relayStatus = () => invoke<{ url: string | null; client: boolean; serving: boolean }>("device_relay_status");

// ---- Trust / pairing ----
export const listTrusted = () => invoke<TrustedController[]>("device_trust_list");
export const requestPairing = (toDevice: string) => invoke<void>("device_request_pairing", { toDevice });
export const pairByAddress = (endpoint: string) => invoke<DeviceRecord>("device_pair_by_address", { endpoint });
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
  payload?: string | null,
  timeoutMs?: number,
) => invoke<CommandResult>("device_send", { toDevice, kind, command, payload: payload ?? null, timeoutMs: timeoutMs ?? null });
export const controlState = () => invoke<ControlState>("device_control_state");
export const stopRemoteControl = () => invoke<{ cancelled: number }>("device_stop_remote_control");
export const auditTail = (limit?: number) => invoke<unknown[]>("device_audit_tail", { limit: limit ?? 200 });
export const selfTest = () => invoke<SelfTestResult>("device_selftest");

// ---- Interactive remote shell sessions ----
export const sessionOpen = (toDevice: string, shell?: string | null, cols?: number, rows?: number) =>
  invoke<CommandResult>("device_session_open", { toDevice, shell: shell ?? null, cols: cols ?? null, rows: rows ?? null });
export const sessionWrite = (toDevice: string, session: string, dataB64: string) =>
  invoke<CommandResult>("device_session_write", { toDevice, session, data: dataB64 });
export const sessionRead = (toDevice: string, session: string) =>
  invoke<CommandResult>("device_session_read", { toDevice, session });
export const sessionResize = (toDevice: string, session: string, cols: number, rows: number) =>
  invoke<CommandResult>("device_session_resize", { toDevice, session, cols, rows });
export const sessionClose = (toDevice: string, session: string) =>
  invoke<CommandResult>("device_session_close", { toDevice, session });

// ---- Agent remote access ----
export const agentsAllowedGet = () => invoke<boolean>("device_agents_allowed_get");
export const setAgentsAllowed = (allowed: boolean) => invoke<void>("device_set_agents_allowed", { allowed });

// ---- Dangerous-action approval (target side) ----
export const pendingApprovals = () => invoke<{ pending: PendingApproval[] }>("device_pending_approvals");
export const approveAction = (requestId: string) => invoke<boolean>("device_approve_action", { requestId });
export const denyAction = (requestId: string) => invoke<boolean>("device_deny_action", { requestId });
