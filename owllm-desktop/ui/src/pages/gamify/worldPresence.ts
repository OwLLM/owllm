export const WORLD_PRESENCE_ENABLED_KEY = "owllm:world-map:presence-enabled";
export const WORLD_MAP_MODE_KEY = "owllm:world-map:mode";
export const WORLD_PRESENCE_CHANGED_EVENT = "owllm:world-presence-changed";
export const WORLD_PRESENCE_RECONNECT_BASE_MS = 1_000;
export const WORLD_PRESENCE_RECONNECT_MAX_MS = 30_000;

// Production endpoint for OWLLM's anonymous, ephemeral presence service. The
// Vite variable remains available for staging and self-hosted deployments.
export const DEFAULT_WORLD_PRESENCE_URL = "https://owllm-world-presence.mc-9fa.workers.dev";

const LEGACY_WORLD_PRESENCE_TOKEN_KEY = "owllm:world-map:presence-token";

export type WorldMapMode = "world" | "fleet";
export type PresenceSocketRole = "presence" | "viewer";

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
  nodes: PublicPresenceNode[];
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

export function worldPresenceSocketUrl(role: PresenceSocketRole, baseUrl = worldPresenceEndpoint()): string {
  const normalized = baseUrl.trim().replace(/\/$/, "");
  if (!normalized) return "";
  try {
    const url = new URL(`${normalized}/v1/presence/connect`);
    if (url.protocol === "https:") url.protocol = "wss:";
    else if (url.protocol === "http:") url.protocol = "ws:";
    else if (url.protocol !== "wss:" && url.protocol !== "ws:") return "";
    url.searchParams.set("role", role);
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

function reconnectDelay(attempt: number): number {
  return Math.min(WORLD_PRESENCE_RECONNECT_MAX_MS, WORLD_PRESENCE_RECONNECT_BASE_MS * (2 ** Math.min(attempt, 5)));
}

function createReconnectingSocket(role: PresenceSocketRole, options: ConnectionOptions = {}): () => void {
  const url = worldPresenceSocketUrl(role, options.baseUrl ?? worldPresenceEndpoint());
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
  const emit = (updatedAt: unknown) => options.onSnapshot({
    nodes: [...nodes.values()],
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

/** Maintain one anonymous presence socket while this installation is opted in. */
export function installWorldPresenceConnection(options: PresenceRunnerOptions = {}): () => void {
  const storage = options.storage ?? availableStorage();
  const baseUrl = options.baseUrl ?? worldPresenceEndpoint();
  let stopSocket: (() => void) | undefined;
  let disposed = false;

  // D1-era opaque tokens are obsolete and must never sync or affect identity.
  try { storage?.removeItem(LEGACY_WORLD_PRESENCE_TOKEN_KEY); }
  catch { /* storage unavailable */ }

  const sync = () => {
    stopSocket?.();
    stopSocket = undefined;
    if (disposed || !readPresenceEnabled(storage) || !worldPresenceSocketUrl("presence", baseUrl)) return;
    stopSocket = createReconnectingSocket("presence", { ...options, baseUrl });
  };
  const onPreferenceChanged = () => sync();
  const onStorage = (event: StorageEvent) => {
    if (event.key === WORLD_PRESENCE_ENABLED_KEY) sync();
  };
  const onOnline = () => sync();

  if (typeof window !== "undefined") {
    window.addEventListener(WORLD_PRESENCE_CHANGED_EVENT, onPreferenceChanged);
    window.addEventListener("storage", onStorage);
    window.addEventListener("online", onOnline);
  }
  sync();
  return () => {
    disposed = true;
    stopSocket?.();
    if (typeof window !== "undefined") {
      window.removeEventListener(WORLD_PRESENCE_CHANGED_EVENT, onPreferenceChanged);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("online", onOnline);
    }
  };
}
