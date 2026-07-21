export const WORLD_PRESENCE_ENABLED_KEY = "owllm:world-map:presence-enabled";
export const WORLD_MAP_MODE_KEY = "owllm:world-map:mode";
export const WORLD_PRESENCE_TOKEN_KEY = "owllm:world-map:presence-token";
export const WORLD_PRESENCE_CHANGED_EVENT = "owllm:world-presence-changed";
export const WORLD_PRESENCE_HEARTBEAT_MS = 5 * 60 * 1_000;

// Filled with the deployed workers.dev URL for production releases. The Vite
// environment variable remains available for staging/self-hosted deployments.
export const DEFAULT_WORLD_PRESENCE_URL = "";

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
type PresenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function availableStorage(): PresenceStorage | undefined {
  try { return typeof localStorage === "undefined" ? undefined : localStorage; }
  catch { return undefined; }
}

export function worldPresenceEndpoint(): string {
  const meta = import.meta as ImportMeta & { env?: Record<string, unknown> };
  return String(meta.env?.VITE_OWLLM_WORLD_PRESENCE_URL ?? DEFAULT_WORLD_PRESENCE_URL).trim().replace(/\/$/, "");
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

export function readPresenceEnabled(storage: Pick<Storage, "getItem"> | undefined = availableStorage()): boolean {
  try { return storage?.getItem(WORLD_PRESENCE_ENABLED_KEY) === "1"; }
  catch { return false; }
}

export function savePresenceEnabled(enabled: boolean, storage: Pick<Storage, "setItem"> = localStorage) {
  try { storage.setItem(WORLD_PRESENCE_ENABLED_KEY, enabled ? "1" : "0"); }
  catch { /* storage unavailable */ }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(WORLD_PRESENCE_CHANGED_EVENT, { detail: { enabled } }));
}

export async function loadWorldPresence(
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
  baseUrl = worldPresenceEndpoint(),
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
  baseUrl = worldPresenceEndpoint(),
  storage: PresenceStorage | undefined = availableStorage(),
): Promise<boolean> {
  if (!baseUrl) return false;
  const token = storage?.getItem(WORLD_PRESENCE_TOKEN_KEY)?.trim() ?? "";
  if (!enabled && !token) return true;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (enabled) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetcher(`${baseUrl.replace(/\/$/, "")}/v1/presence`, {
    method: enabled ? "POST" : "DELETE",
    cache: "no-store",
    signal,
    headers,
    // Deliberately no identity, coordinates, device name, account, or content.
    body: enabled ? "{}" : undefined,
  });
  if (!response.ok) throw new Error(`World presence service returned HTTP ${response.status}`);
  if (enabled) {
    const body = await response.json() as { token?: unknown };
    const issuedToken = typeof body.token === "string" && /^[a-f0-9]{64}$/i.test(body.token) ? body.token.toLowerCase() : "";
    if (!issuedToken) throw new Error("World presence service returned no anonymous token");
    try { storage?.setItem(WORLD_PRESENCE_TOKEN_KEY, issuedToken); }
    catch { /* storage unavailable; the node will expire naturally */ }
  } else {
    try { storage?.removeItem(WORLD_PRESENCE_TOKEN_KEY); }
    catch { /* storage unavailable */ }
  }
  return true;
}

type PresenceHeartbeatOptions = {
  storage?: PresenceStorage;
  fetcher?: FetchLike;
  baseUrl?: string;
  setTimer?: (callback: () => void, delay: number) => number;
  clearTimer?: (timer: number) => void;
};

/** Keep an opted-in installation present even when World Map is not open. */
export function installWorldPresenceHeartbeat(options: PresenceHeartbeatOptions = {}): () => void {
  const storage = options.storage ?? availableStorage();
  const fetcher = options.fetcher ?? fetch;
  const baseUrl = options.baseUrl ?? worldPresenceEndpoint();
  const setTimer = options.setTimer ?? ((callback, delay) => window.setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? ((timer) => window.clearTimeout(timer));
  let timer: number | undefined;
  let disposed = false;
  let controller: AbortController | undefined;

  const cancelTimer = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };
  const schedule = () => {
    cancelTimer();
    if (!disposed && baseUrl && readPresenceEnabled(storage)) timer = setTimer(() => void heartbeat(), WORLD_PRESENCE_HEARTBEAT_MS);
  };
  const heartbeat = async () => {
    if (disposed || !baseUrl || !readPresenceEnabled(storage)) return;
    controller?.abort();
    controller = new AbortController();
    try { await sendAnonymousHeartbeat(true, controller.signal, fetcher, baseUrl, storage); }
    catch { /* World Map surfaces service errors; background presence retries. */ }
    finally { schedule(); }
  };
  const onPreferenceChanged = () => {
    // World Map sends the immediate POST/DELETE; reset the background cadence.
    if (readPresenceEnabled(storage)) schedule();
    else cancelTimer();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === WORLD_PRESENCE_ENABLED_KEY) void heartbeat();
  };

  if (typeof window !== "undefined") {
    window.addEventListener(WORLD_PRESENCE_CHANGED_EVENT, onPreferenceChanged);
    window.addEventListener("storage", onStorage);
  }
  void heartbeat();
  return () => {
    disposed = true;
    cancelTimer();
    controller?.abort();
    if (typeof window !== "undefined") {
      window.removeEventListener(WORLD_PRESENCE_CHANGED_EVENT, onPreferenceChanged);
      window.removeEventListener("storage", onStorage);
    }
  };
}
