export const WORLD_MAP_MODE_KEY = "owllm:world-map:mode";
// Stable, opaque, device-local id so the same installation is one recorded node
// across reconnects instead of inflating the recorded-users total every time it
// comes online. Never synced (see vaultSync DENY_EXACT) — it identifies nothing.
export const WORLD_PRESENCE_NODE_ID_KEY = "owllm:world-map:node-id";
export const WORLD_PRESENCE_RECONNECT_BASE_MS = 1_000;
export const WORLD_PRESENCE_RECONNECT_MAX_MS = 30_000;

// Production endpoint for OWLLM's anonymous presence service. The Vite variable
// remains available for staging and self-hosted deployments.
export const DEFAULT_WORLD_PRESENCE_URL = "https://owllm-world-presence.mc-9fa.workers.dev";

const LEGACY_WORLD_PRESENCE_TOKEN_KEY = "owllm:world-map:presence-token";

function randomNodeId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID().replace(/-/g, "");
    }
  } catch { /* fall through to a non-crypto id */ }
  return `n${Math.abs(Math.floor(Math.random() * 1e15)).toString(36)}${Date.now().toString(36)}`;
}

/** Read the stable anonymous node id for this installation, creating it once. */
export function readOrCreateNodeId(storage: PresenceStorage | undefined = availableStorage()): string {
  try {
    const existing = storage?.getItem(WORLD_PRESENCE_NODE_ID_KEY);
    const sanitized = typeof existing === "string" ? existing.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 64) : "";
    if (sanitized) return sanitized;
  } catch { /* storage unavailable */ }
  const created = randomNodeId();
  try { storage?.setItem(WORLD_PRESENCE_NODE_ID_KEY, created); }
  catch { /* storage unavailable — id stays session-local */ }
  return created;
}

export type WorldMapMode = "world" | "fleet";
export type PresenceSocketRole = "presence" | "viewer";
export type PresenceOs = "Windows" | "macOS" | "Linux" | "Other";

export function includeSelfDevice<T extends { device_id: string }>(self: T, devices: T[]): T[] {
  return devices.some((device) => device.device_id === self.device_id) ? devices : [self, ...devices];
}

export type PublicPresenceNode = {
  id: string;
  region: string;
  os: PresenceOs;
  latitude: number;
  longitude: number;
  firstSeen: string;
  lastSeen: string;
  // Recorded nodes stay on the map forever; `online` is false for ghosts that
  // were seen before but have no live presence socket right now.
  online: boolean;
};

export type PresenceCounts = {
  total: number;
  online: number;
};

export type PresenceSnapshot = {
  nodes: PublicPresenceNode[];
  counts: PresenceCounts;
  updatedAt: string | null;
};

export type PresenceConnectionStatus = {
  configured: boolean;
  connected: boolean;
  error: string;
};

type PresenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type TimerHandle = ReturnType<typeof setTimeout>;
type SocketEventName = "open" | "message" | "close" | "error";
type SocketEvent = Event | MessageEvent<unknown>;

type SocketLike = {
  close(code?: number, reason?: string): void;
  addEventListener(type: SocketEventName, listener: (event: SocketEvent) => void): void;
};

type ConnectionOptions = {
  baseUrl?: string;
  nodeId?: string;
  os?: PresenceOs;
  socketFactory?: (url: string) => SocketLike;
  setTimer?: (callback: () => void, delay: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  onOpen?: () => void;
  onMessage?: (value: unknown) => void;
  onDisconnect?: (error: string) => void;
};

function availableStorage(): PresenceStorage | undefined {
  try { return typeof localStorage === "undefined" ? undefined : localStorage; }
  catch { return undefined; }
}

export function worldPresenceEndpoint(): string {
  const meta = import.meta as ImportMeta & { env?: Record<string, unknown> };
  return String(meta.env?.VITE_OWLLM_WORLD_PRESENCE_URL ?? DEFAULT_WORLD_PRESENCE_URL).trim().replace(/\/$/, "");
}

export function normalizePresenceOs(value: unknown): PresenceOs {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (text.includes("windows") || /\bwin(?:32|64)?\b/.test(text)) return "Windows";
  if (text.includes("macintosh") || text.includes("mac os") || text.includes("darwin") || text === "macos") return "macOS";
  if (text.includes("linux") || text.includes("x11")) return "Linux";
  return "Other";
}

export function currentPresenceOs(): PresenceOs {
  try {
    return normalizePresenceOs(typeof navigator === "undefined" ? "" : `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`);
  } catch {
    return "Other";
  }
}

export function presenceCountryCode(region: string): string {
  const match = /^([A-Za-z]{2})(?:\s*\u00b7|$)/.exec(region.trim());
  return match?.[1]?.toUpperCase() ?? "";
}

export function presenceCity(region: string): string {
  const match = /^[A-Za-z]{2}\s*\u00b7\s*(.+)$/.exec(region.trim());
  return match?.[1]?.trim() ?? "";
}

export type CountryPresenceGroup = {
  countryCode: string;
  nodes: PublicPresenceNode[];
  onlineCount: number;
  osCounts: Record<PresenceOs, { total: number; online: number }>;
};

export function groupPresenceByCountry(nodes: PublicPresenceNode[]): CountryPresenceGroup[] {
  const groups = new Map<string, CountryPresenceGroup>();
  for (const node of nodes) {
    const countryCode = presenceCountryCode(node.region);
    const key = countryCode || "unknown";
    let group = groups.get(key);
    if (!group) {
      group = {
        countryCode,
        nodes: [],
        onlineCount: 0,
        osCounts: {
          Windows: { total: 0, online: 0 },
          macOS: { total: 0, online: 0 },
          Linux: { total: 0, online: 0 },
          Other: { total: 0, online: 0 },
        },
      };
      groups.set(key, group);
    }
    group.nodes.push(node);
    group.osCounts[node.os].total += 1;
    if (node.online) {
      group.onlineCount += 1;
      group.osCounts[node.os].online += 1;
    }
  }
  return [...groups.values()].sort((a, b) =>
    b.onlineCount - a.onlineCount
      || b.nodes.length - a.nodes.length
      || a.countryCode.localeCompare(b.countryCode)
  );
}

export function worldPresenceSocketUrl(
  role: PresenceSocketRole,
  baseUrl = worldPresenceEndpoint(),
  nodeId = "",
  os: PresenceOs | "" = "",
): string {
  const normalized = baseUrl.trim().replace(/\/$/, "");
  if (!normalized) return "";
  try {
    const url = new URL(`${normalized}/v1/presence/connect`);
    if (url.protocol === "https:") url.protocol = "wss:";
    else if (url.protocol === "http:") url.protocol = "ws:";
    else if (url.protocol !== "wss:" && url.protocol !== "ws:") return "";
    url.searchParams.set("role", role);
    // Only presence sockets carry the stable anonymous id; viewers stay generic.
    if (role === "presence" && nodeId) url.searchParams.set("id", nodeId);
    if (role === "presence" && os) url.searchParams.set("os", os);
    return url.toString();
  } catch {
    return "";
  }
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
      os: normalizePresenceOs(row.os),
      firstSeen: typeof row.firstSeen === "string" ? row.firstSeen : "",
      lastSeen: typeof row.lastSeen === "string" ? row.lastSeen : "",
      // Missing `online` (e.g. an older upsert) is treated as online.
      online: row.online !== false,
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

function reconnectDelay(attempt: number): number {
  return Math.min(WORLD_PRESENCE_RECONNECT_MAX_MS, WORLD_PRESENCE_RECONNECT_BASE_MS * (2 ** Math.min(attempt, 5)));
}

function createReconnectingSocket(role: PresenceSocketRole, options: ConnectionOptions = {}): () => void {
  const url = worldPresenceSocketUrl(role, options.baseUrl ?? worldPresenceEndpoint(), options.nodeId ?? "", options.os ?? "");
  if (!url) return () => {};
  const socketFactory = options.socketFactory ?? ((target) => new WebSocket(target));
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  let socket: SocketLike | undefined;
  let timer: TimerHandle | undefined;
  let attempt = 0;
  let disposed = false;
  let generation = 0;

  const cancelTimer = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };
  const schedule = () => {
    cancelTimer();
    if (disposed) return;
    const delay = reconnectDelay(attempt);
    attempt += 1;
    timer = setTimer(connect, delay);
  };
  const connect = () => {
    if (disposed) return;
    cancelTimer();
    const ownGeneration = ++generation;
    let next: SocketLike;
    try { next = socketFactory(url); }
    catch (reason) {
      options.onDisconnect?.(String(reason));
      schedule();
      return;
    }
    socket = next;
    next.addEventListener("open", () => {
      if (disposed || generation !== ownGeneration) return;
      attempt = 0;
      options.onOpen?.();
    });
    next.addEventListener("message", (event) => {
      if (disposed || generation !== ownGeneration) return;
      try { options.onMessage?.(JSON.parse(String((event as MessageEvent).data))); }
      catch { /* Ignore malformed public data. */ }
    });
    next.addEventListener("error", () => {
      if (!disposed && generation === ownGeneration) options.onDisconnect?.("World presence connection failed");
    });
    next.addEventListener("close", () => {
      if (disposed || generation !== ownGeneration) return;
      socket = undefined;
      options.onDisconnect?.("World presence connection closed");
      schedule();
    });
  };

  connect();
  return () => {
    disposed = true;
    generation += 1;
    cancelTimer();
    try { socket?.close(1000, "disabled"); }
    catch { /* already closed */ }
    socket = undefined;
  };
}

type PresenceSubscriptionOptions = ConnectionOptions & {
  onSnapshot: (snapshot: PresenceSnapshot) => void;
  onStatus?: (status: PresenceConnectionStatus) => void;
};

/** Subscribe the open World Map to live snapshots from the global object. */
export function subscribeWorldPresence(options: PresenceSubscriptionOptions): () => void {
  const baseUrl = options.baseUrl ?? worldPresenceEndpoint();
  if (!worldPresenceSocketUrl("viewer", baseUrl)) {
    options.onStatus?.({ configured: false, connected: false, error: "" });
    return () => {};
  }
  const nodes = new Map<string, PublicPresenceNode>();
  // Derive counts from the retained node set so total (recorded) and online
  // stay correct even between the server's authoritative count messages.
  const derivedCounts = (): PresenceCounts => {
    let online = 0;
    for (const node of nodes.values()) if (node.online) online += 1;
    return { total: nodes.size, online };
  };
  const emit = (updatedAt: unknown) => options.onSnapshot({
    nodes: [...nodes.values()],
    counts: derivedCounts(),
    updatedAt: typeof updatedAt === "string" ? updatedAt : null,
  });
  options.onStatus?.({ configured: true, connected: false, error: "" });
  return createReconnectingSocket("viewer", {
    ...options,
    baseUrl,
    onOpen: () => options.onStatus?.({ configured: true, connected: true, error: "" }),
    onDisconnect: (error) => options.onStatus?.({ configured: true, connected: false, error }),
    onMessage: (value) => {
      if (!value || typeof value !== "object") return;
      const message = value as { type?: unknown; nodes?: unknown; node?: unknown; id?: unknown; updatedAt?: unknown };
      if (message.type === "snapshot") {
        nodes.clear();
        for (const node of sanitizePresenceNodes(message.nodes)) nodes.set(node.id, node);
        emit(message.updatedAt);
      } else if (message.type === "upsert") {
        // A recorded node going offline arrives here as online:false and is
        // kept as a ghost; only a hard eviction (remove) deletes it.
        const [node] = sanitizePresenceNodes([message.node]);
        if (!node) return;
        nodes.set(node.id, node);
        emit(message.updatedAt);
      } else if (message.type === "remove" && typeof message.id === "string") {
        nodes.delete(message.id.trim().slice(0, 96));
        emit(message.updatedAt);
      }
    },
  });
}

type PresenceRunnerOptions = ConnectionOptions & { storage?: PresenceStorage };

/**
 * Maintain one anonymous presence socket for this installation.
 *
 * Presence is ALWAYS on: it shares only an opaque device-local id, a normalized
 * OS family, and a coarse server-derived region. Every install is counted on
 * the board; no opt-in flag gates this.
 */
export function installWorldPresenceConnection(options: PresenceRunnerOptions = {}): () => void {
  const storage = options.storage ?? availableStorage();
  const baseUrl = options.baseUrl ?? worldPresenceEndpoint();
  let stopSocket: (() => void) | undefined;
  let disposed = false;

  // D1-era opaque tokens are obsolete and must never sync or affect identity.
  try { storage?.removeItem(LEGACY_WORLD_PRESENCE_TOKEN_KEY); }
  catch { /* storage unavailable */ }

  // Stable, device-local id so this installation is one recorded node forever
  // instead of a new "user" on every reconnect.
  const nodeId = options.nodeId ?? readOrCreateNodeId(storage);
  const os = options.os ?? currentPresenceOs();

  const sync = () => {
    stopSocket?.();
    stopSocket = undefined;
    if (disposed || !worldPresenceSocketUrl("presence", baseUrl, nodeId, os)) return;
    stopSocket = createReconnectingSocket("presence", { ...options, baseUrl, nodeId, os });
  };
  const onOnline = () => sync();

  if (typeof window !== "undefined") window.addEventListener("online", onOnline);
  sync();
  return () => {
    disposed = true;
    stopSocket?.();
    if (typeof window !== "undefined") window.removeEventListener("online", onOnline);
  };
}
