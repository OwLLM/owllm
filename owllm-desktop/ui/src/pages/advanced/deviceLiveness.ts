export const REMOTE_DEVICE_RECENT_MS = 5 * 60 * 1000;

export type DeviceLivenessRecord = {
  is_self: boolean;
  last_seen: string | null;
  published_at?: string | null;
  endpoint: string | null;
  endpoints?: string[];
  p2p_node_id?: string | null;
  relay?: boolean;
};

export function hasDialableDeviceMetadata(device: Pick<DeviceLivenessRecord, "endpoint" | "endpoints" | "p2p_node_id" | "relay">): boolean {
  return Boolean(
    device.p2p_node_id ||
    device.relay ||
    device.endpoint ||
    (device.endpoints ?? []).some((endpoint) => endpoint.trim().length > 0),
  );
}

export function hasRecentDeviceFrame(device: Pick<DeviceLivenessRecord, "last_seen">, now = Date.now()): boolean {
  if (!device.last_seen) return false;
  const seen = Date.parse(device.last_seen);
  return Number.isFinite(seen) && now - seen < REMOTE_DEVICE_RECENT_MS;
}

export function hasRecentDevicePublication(device: Pick<DeviceLivenessRecord, "published_at">, now = Date.now()): boolean {
  if (!device.published_at) return false;
  const published = Date.parse(device.published_at);
  return Number.isFinite(published) && now - published < REMOTE_DEVICE_RECENT_MS;
}

export function isDeviceOnline(device: DeviceLivenessRecord, now = Date.now()): boolean {
  if (device.is_self || hasRecentDeviceFrame(device, now)) return true;
  const hasDialPath = hasDialableDeviceMetadata(device);
  if (!hasDialPath) return false;
  // Online requires a FRESH vault heartbeat. A record with no published_at (or
  // a stale one) is offline: the old "legacy records count as online" grace
  // made powered-off machines immortal-online, because a heartbeat-less record
  // re-ingests unchanged forever. The native backend republishes every 150
  // seconds, independent of backgrounded/suspended WebView timers.
  return hasRecentDevicePublication(device, now);
}
