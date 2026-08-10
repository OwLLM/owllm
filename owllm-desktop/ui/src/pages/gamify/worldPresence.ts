export const WORLD_MAP_MODE_KEY = "owllm:world-map:mode";
// Obsolete: a *random* per-webview-profile id. It was minted whenever the native
// device identity was unavailable, so an installation whose localStorage moved
// (a WebView profile hop) or whose identity failed to decrypt was recorded as a
// brand-new World Map node on every single launch — one device became dozens.
// The recorded id is now ONLY the device-derived token; this key is purged.
export const WORLD_PRESENCE_NODE_ID_KEY = "owllm:world-map:node-id";
export const WORLD_PRESENCE_RECONNECT_BASE_MS = 1_000;
export const WORLD_PRESENCE_RECONNECT_MAX_MS = 30_000;

// Production endpoint for OWLLM's anonymous presence service. The Vite variable
// remains available for staging and self-hosted deployments.
export const DEFAULT_WORLD_PRESENCE_URL = "https://owllm-world-presence.mc-9fa.workers.dev";

const LEGACY_WORLD_PRESENCE_TOKEN_KEY = "owllm:world-map:presence-token";

const DEVICE_PRESENCE_DOMAIN = "owllm-world-presence-device-v1\0";

/**
 * Derive the anonymous public-presence token from OwLLM's stable native device
 * identity. The domain-separated one-way hash lets the owner's private Fleet
 * records reconcile with Live World without sending the native device id.
 */
export async function presenceNodeIdForDevice(deviceId: string): Promise<string> {
  const normalized = deviceId.trim().toLowerCase();
  if (!normalized) return "";
  const bytes = new TextEncoder().encode(`${DEVICE_PRESENCE_DOMAIN}${normalized}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Stable short label for a public node; unlike a row index it never changes. */
export function presenceServerCode(nodeId: string): string {
  let hash = 2166136261;
  for (let index = 0; index < nodeId.length; index += 1) {
    hash = Math.imul(hash ^ nodeId.charCodeAt(index), 16777619);
  }
  return `OW-${(hash >>> 0).toString(36).toUpperCase().padStart(7, "0")}`;
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
  /** OwLLM release this installation last connected with; "" for older clients. */
  appVersion: string;
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

export function isFleetDeviceLiveInWorld(
  deviceId: string,
  presenceIds: ReadonlyMap<string, string>,
  nodes: Pick<PublicPresenceNode, "id" | "online">[],
): boolean {
  const presenceId = presenceIds.get(deviceId);
  return Boolean(presenceId && nodes.some((node) => node.id === presenceId && node.online));
}

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
  send(data: string): void;
  addEventListener(type: SocketEventName, listener: (event: SocketEvent) => void): void;
};

/** A live connection: stop it, or write a frame back up the same socket. */
export type PresenceSocketHandle = {
  stop: () => void;
  /** False when there is no open socket right now — the caller must retry. */
  send: (value: unknown) => boolean;
};

type ConnectionOptions = {
  baseUrl?: string;
  nodeId?: string;
  os?: PresenceOs;
  appVersion?: string;
  /** Ask the service for an identity challenge so this socket can carry chat. */
  chat?: boolean;
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

/** Release string reduced to the characters a version can legitimately contain. */
export function normalizePresenceVersion(value: unknown): string {
  return String(value ?? "").trim().replace(/[^0-9A-Za-z.+-]/g, "").slice(0, 24);
}

export function worldPresenceSocketUrl(
  role: PresenceSocketRole,
  baseUrl = worldPresenceEndpoint(),
  nodeId = "",
  os: PresenceOs | "" = "",
  appVersion = "",
  chat = false,
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
    // Release string only — shown beside the anonymous dot so an install's
    // version is visible without exposing anything device-identifying.
    const version = role === "presence" ? normalizePresenceVersion(appVersion) : "";
    if (version) url.searchParams.set("v", version);
    // Only asked for when the user has turned chat on. Without it the service
    // never issues a challenge, so no key is presented and presence stays as
    // anonymous as it was before chat existed.
    if (role === "presence" && nodeId && chat) url.searchParams.set("chat", "1");
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
      appVersion: normalizePresenceVersion(row.appVersion ?? (row as { app_version?: unknown }).app_version),
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

function createReconnectingSocket(role: PresenceSocketRole, options: ConnectionOptions = {}): PresenceSocketHandle {
  const url = worldPresenceSocketUrl(role, options.baseUrl ?? worldPresenceEndpoint(), options.nodeId ?? "", options.os ?? "", options.appVersion ?? "", options.chat ?? false);
  if (!url) return { stop: () => {}, send: () => false };
  const socketFactory = options.socketFactory ?? ((target) => new WebSocket(target));
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  let socket: SocketLike | undefined;
  let open = false;
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
      open = true;
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
      open = false;
      options.onDisconnect?.("World presence connection closed");
      schedule();
    });
  };

  connect();
  return {
    stop: () => {
      disposed = true;
      generation += 1;
      cancelTimer();
      try { socket?.close(1000, "disabled"); }
      catch { /* already closed */ }
      socket = undefined;
      open = false;
    },
    send: (value: unknown) => {
      if (disposed || !socket || !open) return false;
      try {
        socket.send(typeof value === "string" ? value : JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
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
  }).stop;
}

/**
 * Everything the presence socket needs in order to also carry chat. The keys
 * stay in Rust: this side only asks for a signature over the relay's challenge.
 */
export type WorldChatHooks = {
  /** Public halves of this device's identity, or null when chat is off. */
  identity: () => Promise<{ publicKey: string; xPub: string } | null>;
  /** Sign the relay's 64-hex challenge with the native device key. */
  sign: (nonce: string) => Promise<string>;
  /** Display name, picture, and whether strangers may send a first contact. */
  profile: () => { nick: string; avatar: string; reachable: boolean };
  /** Every chat and room frame the relay sends. */
  onFrame: (frame: Record<string, unknown>) => void;
  /** Called with a writer when authenticated, and with null when it drops. */
  onTransport: (send: ((value: unknown) => boolean) | null) => void;
  /** Surfaced so a failed handshake is visible instead of silently doing nothing. */
  onError?: (error: string) => void;
};

type PresenceRunnerOptions = ConnectionOptions & { storage?: PresenceStorage; chatHooks?: WorldChatHooks };

/**
 * Maintain one anonymous presence socket for this installation.
 *
 * Presence is ALWAYS on: it shares only an opaque device-derived id, a
 * normalized OS family, the release string, and a coarse server-derived region.
 * Every install is counted on the board; no opt-in flag gates this.
 *
 * There is no polling and no status heartbeat: opening the socket IS the
 * sign-in event and closing it IS the sign-off event. `pagehide` closes it
 * explicitly on quit so the map updates immediately instead of waiting for the
 * transport to time out.
 *
 * `nodeId` is the device-derived token and NOTHING else. When it is missing the
 * socket still connects, but without an id — the service then shows the dot
 * while it is live and never writes a row, so a device that cannot identify
 * itself can never accumulate one recorded node per launch.
 */
export function installWorldPresenceConnection(options: PresenceRunnerOptions = {}): () => void {
  const storage = options.storage ?? availableStorage();
  const baseUrl = options.baseUrl ?? worldPresenceEndpoint();
  let stopSocket: (() => void) | undefined;
  let disposed = false;

  // D1-era opaque tokens and the random per-profile node id are obsolete: both
  // minted a fresh identity whenever local storage moved, which is what
  // recorded one installation as many nodes. Purge them.
  for (const key of [LEGACY_WORLD_PRESENCE_TOKEN_KEY, WORLD_PRESENCE_NODE_ID_KEY]) {
    try { storage?.removeItem(key); }
    catch { /* storage unavailable */ }
  }

  const nodeId = options.nodeId ?? "";
  const os = options.os ?? currentPresenceOs();
  const appVersion = normalizePresenceVersion(options.appVersion);
  const chatHooks = options.chatHooks;
  const chat = Boolean(chatHooks) && Boolean(nodeId);

  /**
   * Answer the relay's challenge. The signature is produced natively, so a
   * webview without `crypto.subtle` still authenticates — and a device that
   * cannot sign simply stays a plain anonymous dot instead of guessing.
   */
  const answerChallenge = async (nonce: string, send: (value: unknown) => boolean) => {
    if (!chatHooks) return;
    try {
      const identity = await chatHooks.identity();
      if (!identity) return;
      const profile = chatHooks.profile();
      send({
        type: "chat_auth",
        publicKey: identity.publicKey,
        xPub: identity.xPub,
        signature: await chatHooks.sign(nonce),
        nick: profile.nick,
        avatar: profile.avatar,
        reachable: profile.reachable,
      });
    } catch (reason) {
      chatHooks.onError?.(String(reason));
    }
  };

  const sync = () => {
    stopSocket?.();
    stopSocket = undefined;
    chatHooks?.onTransport(null);
    if (disposed || !worldPresenceSocketUrl("presence", baseUrl, nodeId, os, appVersion, chat)) return;
    const handle = createReconnectingSocket("presence", {
      ...options,
      baseUrl,
      nodeId,
      os,
      appVersion,
      chat,
      onDisconnect: (error) => {
        chatHooks?.onTransport(null);
        options.onDisconnect?.(error);
      },
      onMessage: (value) => {
        options.onMessage?.(value);
        if (!chatHooks || !value || typeof value !== "object") return;
        const frame = value as Record<string, unknown>;
        const type = typeof frame.type === "string" ? frame.type : "";
        if (type === "chat_challenge" && typeof frame.nonce === "string") {
          void answerChallenge(frame.nonce, handle.send);
          return;
        }
        if (!type.startsWith("chat_") && !type.startsWith("room_")) return;
        // The writer is handed over only once the relay has accepted the
        // identity, so nothing can be sent on a socket that is not yet bound.
        if (type === "chat_ready") chatHooks.onTransport(handle.send);
        if (type === "chat_error") chatHooks.onError?.(String(frame.error ?? "chat error"));
        chatHooks.onFrame(frame);
      },
    });
    stopSocket = handle.stop;
  };
  const onOnline = () => sync();
  const signOff = () => {
    stopSocket?.();
    stopSocket = undefined;
    chatHooks?.onTransport(null);
  };

  if (typeof window !== "undefined") {
    window.addEventListener("online", onOnline);
    window.addEventListener("pagehide", signOff);
  }
  sync();
  return () => {
    disposed = true;
    signOff();
    if (typeof window !== "undefined") {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pagehide", signOff);
    }
  };
}
