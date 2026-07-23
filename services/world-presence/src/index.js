const MAX_PRESENCE_NODES = 5_000;
const MAX_VIEWERS = 1_000;
const PRESENCE_TAG = "presence";
const VIEWER_TAG = "viewer";

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finite(value) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function stableFraction(seed, salt) {
  let hash = 2166136261;
  for (const character of `${salt}:${seed}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function randomId(cryptoApi = crypto) {
  return cryptoApi.randomUUID().replaceAll("-", "").slice(0, 24);
}

/**
 * Reduce Cloudflare edge metadata to a deliberately coarse map point.
 * Source IP and exact request coordinates are never read, returned, or stored.
 */
export function coarseLocation(cf, publicId) {
  const latitude = finite(cf?.latitude);
  const longitude = finite(cf?.longitude);
  if (latitude == null || longitude == null) return null;

  const roundedLatitude = Math.round(latitude / 4) * 4;
  const roundedLongitude = Math.round(longitude / 4) * 4;
  const jitterLatitude = (stableFraction(publicId, "lat") - 0.5) * 3;
  const jitterLongitude = (stableFraction(publicId, "lon") - 0.5) * 3;
  const country = String(cf?.country ?? "").trim().slice(0, 2).toUpperCase();
  const region = String(cf?.regionCode ?? cf?.region ?? "").trim().slice(0, 24);

  return {
    region: [country, region].filter(Boolean).join(" · ") || "Cloudflare edge",
    latitude: Number(clamp(roundedLatitude + jitterLatitude, -85, 85).toFixed(2)),
    longitude: Number(clamp(roundedLongitude + jitterLongitude, -180, 180).toFixed(2)),
  };
}

function attachment(socket) {
  try { return socket.deserializeAttachment?.() ?? null; }
  catch { return null; }
}

function nodeFromSocket(socket) {
  const data = attachment(socket);
  if (!data || data.role !== PRESENCE_TAG) return null;
  return {
    id: String(data.id ?? "").slice(0, 96),
    region: String(data.region ?? "").slice(0, 80),
    latitude: finite(data.latitude),
    longitude: finite(data.longitude),
    lastSeen: String(data.connectedAt ?? ""),
  };
}

export function snapshotFromSockets(sockets, now = Date.now()) {
  const seen = new Set();
  const nodes = [];
  for (const socket of sockets) {
    const node = nodeFromSocket(socket);
    if (!node?.id || seen.has(node.id) || node.latitude == null || node.longitude == null) continue;
    if (node.latitude < -90 || node.latitude > 90 || node.longitude < -180 || node.longitude > 180) continue;
    seen.add(node.id);
    nodes.push(node);
  }
  return {
    type: "snapshot",
    nodes: nodes.slice(0, MAX_PRESENCE_NODES),
    updatedAt: new Date(now).toISOString(),
  };
}

function safeSend(socket, value) {
  try {
    socket.send(typeof value === "string" ? value : JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function socketRole(request) {
  const role = new URL(request.url).searchParams.get("role");
  return role === PRESENCE_TAG || role === VIEWER_TAG ? role : "";
}

function isWebSocketUpgrade(request) {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

export class WorldPresence {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  presenceSockets() {
    return this.state.getWebSockets(PRESENCE_TAG);
  }

  viewerSockets() {
    return this.state.getWebSockets(VIEWER_TAG);
  }

  snapshot(excludedSocket) {
    return snapshotFromSockets(this.presenceSockets().filter((socket) => socket !== excludedSocket));
  }

  broadcast(value) {
    const payload = JSON.stringify(value);
    for (const viewer of this.viewerSockets()) safeSend(viewer, payload);
  }

  async fetch(request) {
    if (!isWebSocketUpgrade(request)) return json({ error: "websocket_upgrade_required" }, 426);
    const role = socketRole(request);
    if (!role) return json({ error: "invalid_socket_role" }, 400);
    if (role === PRESENCE_TAG && this.presenceSockets().length >= MAX_PRESENCE_NODES) {
      return json({ error: "presence_capacity_reached" }, 503);
    }
    if (role === VIEWER_TAG && this.viewerSockets().length >= MAX_VIEWERS) {
      return json({ error: "viewer_capacity_reached" }, 503);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const connectedAt = new Date().toISOString();
    if (role === PRESENCE_TAG) {
      const id = randomId();
      const location = coarseLocation({
        country: request.headers.get("X-OWLLM-Country"),
        regionCode: request.headers.get("X-OWLLM-Region"),
        latitude: request.headers.get("X-OWLLM-Latitude"),
        longitude: request.headers.get("X-OWLLM-Longitude"),
      }, id);
      if (!location) return json({ error: "coarse_location_unavailable" }, 503);
      server.serializeAttachment({ role, id, ...location, connectedAt });
    } else {
      server.serializeAttachment({ role, connectedAt });
    }
    this.state.acceptWebSocket(server, [role]);

    if (role === VIEWER_TAG) {
      safeSend(server, this.snapshot());
    } else {
      this.broadcast({ type: "upsert", node: nodeFromSocket(server), updatedAt: new Date().toISOString() });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, message) {
    if (message === "snapshot" && attachment(socket)?.role === VIEWER_TAG) safeSend(socket, this.snapshot());
  }

  async webSocketClose(socket) {
    const data = attachment(socket);
    try { socket.close(1000, "closed"); }
    catch { /* already closed */ }
    if (data?.role === PRESENCE_TAG) {
      this.broadcast({ type: "remove", id: String(data.id ?? "").slice(0, 96), updatedAt: new Date().toISOString() });
    }
  }

  async webSocketError(socket) {
    const data = attachment(socket);
    if (data?.role === PRESENCE_TAG) {
      this.broadcast({ type: "remove", id: String(data.id ?? "").slice(0, 96), updatedAt: new Date().toISOString() });
    }
  }
}

function durableRequest(request, env) {
  const id = env.WORLD_PRESENCE.idFromName("global");
  return env.WORLD_PRESENCE.get(id).fetch(request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "owllm-world-presence", transport: "hibernating-websocket" });
    }
    if (url.pathname !== "/v1/presence/connect") return json({ error: "not_found" }, 404);
    if (!isWebSocketUpgrade(request)) return json({ error: "websocket_upgrade_required" }, 426);

    const headers = new Headers(request.headers);
    headers.set("X-OWLLM-Country", String(request.cf?.country ?? ""));
    headers.set("X-OWLLM-Region", String(request.cf?.regionCode ?? request.cf?.region ?? ""));
    headers.set("X-OWLLM-Latitude", String(request.cf?.latitude ?? ""));
    headers.set("X-OWLLM-Longitude", String(request.cf?.longitude ?? ""));
    return durableRequest(new Request(request, { headers }), env);
  },
};
