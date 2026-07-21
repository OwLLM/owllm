export const WORLD_PRESENCE_ENABLED_KEY = "owllm:world-map:presence-enabled";
export const WORLD_MAP_MODE_KEY = "owllm:world-map:mode";

export type WorldMapMode = "world" | "fleet";

export function includeSelfDevice<T extends { device_id: string }>(self: T, devices: T[]): T[] {
  return devices.some((device) => device.device_id === self.device_id) ? devices : [self, ...devices];
}

export type PublicPresenceNode = {
  id: string;
  region: string;
  latitude: number;
  longitude: number;
  lastSeen: string;
};

export type PresenceSnapshot = {
  configured: boolean;
  nodes: PublicPresenceNode[];
  updatedAt: string | null;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;

function endpoint(): string {
  const meta = import.meta as ImportMeta & { env?: Record<string, unknown> };
  return String(meta.env?.VITE_OWLLM_WORLD_PRESENCE_URL ?? "").trim().replace(/\/$/, "");
}

function finiteCoordinate(value: unknown, min: number, max: number): number | null {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

export function sanitizePresenceNodes(value: unknown): PublicPresenceNode[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const nodes: PublicPresenceNode[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim().slice(0, 96) : "";
    const latitude = finiteCoordinate(row.latitude, -90, 90);
    const longitude = finiteCoordinate(row.longitude, -180, 180);
    if (!id || seen.has(id) || latitude == null || longitude == null) continue;
    seen.add(id);
    nodes.push({
      id,
      latitude,
      longitude,
      region: typeof row.region === "string" ? row.region.trim().slice(0, 80) : "",
      lastSeen: typeof row.lastSeen === "string" ? row.lastSeen : "",
    });
  }
  return nodes.slice(0, 5_000);
}

export function readWorldMapMode(storage: Pick<Storage, "getItem"> = localStorage): WorldMapMode {
  try { return storage.getItem(WORLD_MAP_MODE_KEY) === "fleet" ? "fleet" : "world"; }
  catch { return "world"; }
}

export function saveWorldMapMode(mode: WorldMapMode, storage: Pick<Storage, "setItem"> = localStorage) {
  try { storage.setItem(WORLD_MAP_MODE_KEY, mode); }
  catch { /* storage unavailable */ }
}

export function readPresenceEnabled(storage: Pick<Storage, "getItem"> = localStorage): boolean {
  try { return storage.getItem(WORLD_PRESENCE_ENABLED_KEY) === "1"; }
  catch { return false; }
}

export function savePresenceEnabled(enabled: boolean, storage: Pick<Storage, "setItem"> = localStorage) {
  try { storage.setItem(WORLD_PRESENCE_ENABLED_KEY, enabled ? "1" : "0"); }
  catch { /* storage unavailable */ }
}

export async function loadWorldPresence(
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
  baseUrl = endpoint(),
): Promise<PresenceSnapshot> {
  if (!baseUrl) return { configured: false, nodes: [], updatedAt: null };
  const response = await fetcher(`${baseUrl.replace(/\/$/, "")}/v1/presence`, {
    method: "GET",
    cache: "no-store",
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`World presence service returned HTTP ${response.status}`);
  const body = await response.json() as { nodes?: unknown; updatedAt?: unknown };
  return {
    configured: true,
    nodes: sanitizePresenceNodes(body.nodes),
    updatedAt: typeof body.updatedAt === "string" ? body.updatedAt : null,
  };
}

export async function sendAnonymousHeartbeat(
  enabled: boolean,
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
  baseUrl = endpoint(),
): Promise<boolean> {
  if (!baseUrl) return false;
  const response = await fetcher(`${baseUrl.replace(/\/$/, "")}/v1/presence`, {
    method: enabled ? "POST" : "DELETE",
    cache: "no-store",
    signal,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    // Deliberately no identity, IP, coordinates, device name, or account data.
    body: enabled ? "{}" : undefined,
  });
  if (!response.ok) throw new Error(`World presence service returned HTTP ${response.status}`);
  return true;
}
