// OWLLM World Presence — anonymous, persistent map of OWLLM installations.
//
// Design: a single hibernating-WebSocket Durable Object holds every live
// connection AND retains each anonymous node in the object's free-tier SQLite
// storage. The socket is the *online* signal; the SQLite row is the *recorded*
// signal. When an installation first opts in it is recorded forever with its
// first coarse position; when its socket drops (offline or turned invisible)
// the node is kept and re-broadcast as a ghost (online:false) rather than
// removed. This yields two counts the map shows: total recorded and online now.
//
// Privacy is unchanged from the ephemeral design: the source IP is never read
// or stored, only Cloudflare's deliberately coarse edge lat/lon is used (then
// rounded + jittered), and no account or workspace data is accepted at all.
// The stable node id is an opaque, per-installation random string supplied by
// the client; it identifies nothing but "the same anonymous dot across visits".

const MAX_NODES = 20_000; // recorded-forever cap; oldest offline node is evicted past this.
const MAX_ONLINE = 10_000; // concurrent presence sockets on the single global object.
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

/** Opaque, device-local node id supplied by the client. Identifies nothing. */
export function sanitizeNodeId(raw) {
  return String(raw ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 64);
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

/** Public, anonymous shape for one recorded node. `online` is derived live. */
export function publicNode(row, online) {
  return {
    id: String(row.id ?? "").slice(0, 96),
    region: String(row.region ?? "").slice(0, 80),
    latitude: finite(row.latitude),
    longitude: finite(row.longitude),
    firstSeen: String(row.firstSeen ?? row.first_seen ?? ""),
    lastSeen: String(row.lastSeen ?? row.last_seen ?? ""),
    online: Boolean(online),
  };
}

/** Build a full snapshot from stored rows plus the set of currently-online ids. */
export function buildSnapshot(rows, onlineIds, now = Date.now()) {
  const seen = new Set();
  const nodes = [];
  for (const row of rows) {
    const node = publicNode(row, onlineIds.has(String(row.id ?? "")));
    if (!node.id || seen.has(node.id) || node.latitude == null || node.longitude == null) continue;
    if (node.latitude < -90 || node.latitude > 90 || node.longitude < -180 || node.longitude > 180) continue;
    seen.add(node.id);
    nodes.push(node);
  }
  return {
    type: "snapshot",
    nodes: nodes.slice(0, MAX_NODES),
    counts: { total: nodes.length, online: onlineIds.size },
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
    this.sql = state.storage.sql;
    // Recorded-forever anonymous nodes. Survives hibernation so a node that
    // first appeared weeks ago still shows as a ghost when it is offline.
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS nodes (" +
      "id TEXT PRIMARY KEY, region TEXT NOT NULL, latitude REAL NOT NULL, " +
      "longitude REAL NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL)",
    );
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // v1 recorded a server-random id for every connection that arrived without a
    // stable client id, so each reconnect of a pre-stable-id client became a new
    // permanent "user" and the total count grew additively. Those rows are
    // duplicates of a handful of installations, not real users — purge them once.
    const version = this.sql.exec("SELECT value FROM meta WHERE key = 'schema_version'").toArray()[0]?.value;
    if (version !== "3") {
      this.sql.exec("DELETE FROM nodes");
      this.sql.exec(
        "INSERT INTO meta (key, value) VALUES ('schema_version', '3') " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      );
    }
  }

  presenceSockets() {
    return this.state.getWebSockets(PRESENCE_TAG);
  }

  viewerSockets() {
    return this.state.getWebSockets(VIEWER_TAG);
  }

  /** Ids of installations with at least one live presence socket right now. */
  onlineIds(excludedSocket) {
    const ids = new Set();
    for (const socket of this.presenceSockets()) {
      if (socket === excludedSocket) continue;
      const data = attachment(socket);
      if (data?.role === PRESENCE_TAG && data.id) ids.add(String(data.id));
    }
    return ids;
  }

  storedRows() {
    return this.sql
      .exec("SELECT id, region, latitude, longitude, first_seen AS firstSeen, last_seen AS lastSeen FROM nodes ORDER BY first_seen ASC LIMIT ?", MAX_NODES)
      .toArray();
  }

  storedRow(id) {
    return this.sql
      .exec("SELECT id, region, latitude, longitude, first_seen AS firstSeen, last_seen AS lastSeen FROM nodes WHERE id = ?", id)
      .toArray()[0] ?? null;
  }

  totalCount() {
    return Number(this.sql.exec("SELECT COUNT(*) AS c FROM nodes").toArray()[0]?.c ?? 0);
  }

  counts(excludedSocket) {
    return { total: this.totalCount(), online: this.onlineIds(excludedSocket).size };
  }

  snapshot(excludedSocket) {
    // Recorded rows plus live ephemeral (no stable id) connections. Ephemerals
    // render as online dots but are never persisted, so `total` stays honest:
    // it counts recorded installations only, while `online` counts live sockets.
    const rows = this.storedRows();
    const seen = new Set(rows.map((row) => String(row.id ?? "")));
    for (const socket of this.presenceSockets()) {
      if (socket === excludedSocket) continue;
      const data = attachment(socket);
      if (data?.role === PRESENCE_TAG && data.ephemeral && data.node && !seen.has(String(data.node.id))) {
        seen.add(String(data.node.id));
        rows.push(data.node);
      }
    }
    return { ...buildSnapshot(rows, this.onlineIds(excludedSocket)), counts: this.counts(excludedSocket) };
  }

  broadcast(value) {
    const payload = JSON.stringify(value);
    for (const viewer of this.viewerSockets()) safeSend(viewer, payload);
  }

  /** Record a first sighting or refresh last_seen; the first position is kept. */
  recordNode(id, location, now) {
    this.sql.exec(
      "INSERT INTO nodes (id, region, latitude, longitude, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen",
      id, location.region, location.latitude, location.longitude, now, now,
    );
    // Bounded footprint: past the cap, drop the oldest offline nodes.
    const overflow = this.totalCount() - MAX_NODES;
    if (overflow > 0) {
      const online = this.onlineIds();
      for (const victim of this.sql.exec("SELECT id FROM nodes ORDER BY last_seen ASC LIMIT ?", overflow + online.size).toArray()) {
        if (online.has(String(victim.id)) || String(victim.id) === id) continue;
        this.sql.exec("DELETE FROM nodes WHERE id = ?", victim.id);
        this.broadcast({ type: "remove", id: String(victim.id), counts: this.counts(), updatedAt: new Date().toISOString() });
      }
    }
    return this.storedRow(id);
  }

  async fetch(request) {
    if (!isWebSocketUpgrade(request)) return json({ error: "websocket_upgrade_required" }, 426);
    const role = socketRole(request);
    if (!role) return json({ error: "invalid_socket_role" }, 400);
    if (role === PRESENCE_TAG && this.presenceSockets().length >= MAX_ONLINE) {
      return json({ error: "presence_capacity_reached" }, 503);
    }
    if (role === VIEWER_TAG && this.viewerSockets().length >= MAX_VIEWERS) {
      return json({ error: "viewer_capacity_reached" }, 503);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const now = new Date().toISOString();
    if (role === PRESENCE_TAG) {
      const stableId = sanitizeNodeId(new URL(request.url).searchParams.get("id"));
      const id = stableId || randomId();
      const location = coarseLocation({
        country: request.headers.get("X-OWLLM-Country"),
        regionCode: request.headers.get("X-OWLLM-Region"),
        latitude: request.headers.get("X-OWLLM-Latitude"),
        longitude: request.headers.get("X-OWLLM-Longitude"),
      }, id);
      if (!location) return json({ error: "coarse_location_unavailable" }, 503);
      // Only installations that supply a stable client id are recorded forever.
      // A connection without one (pre-stable-id clients) is shown online while
      // connected but never persisted — otherwise every reconnect would mint a
      // new permanent node and the total would grow without bound.
      const ephemeral = !stableId;
      const row = ephemeral
        ? { id, region: location.region, latitude: location.latitude, longitude: location.longitude, firstSeen: now, lastSeen: now }
        : this.recordNode(id, location, now);
      server.serializeAttachment({ role, id, ephemeral, node: ephemeral ? row : undefined, connectedAt: now });
      this.state.acceptWebSocket(server, [role]);
      this.broadcast({ type: "upsert", node: publicNode(row, true), counts: this.counts(), updatedAt: new Date().toISOString() });
    } else {
      server.serializeAttachment({ role, connectedAt: now });
      this.state.acceptWebSocket(server, [role]);
      safeSend(server, this.snapshot());
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, message) {
    if (message === "snapshot" && attachment(socket)?.role === VIEWER_TAG) safeSend(socket, this.snapshot());
  }

  markOffline(socket) {
    const data = attachment(socket);
    if (data?.role !== PRESENCE_TAG) return;
    const id = String(data.id ?? "");
    // Another window/socket for the same installation may still be online.
    if (this.onlineIds(socket).has(id)) return;
    const row = this.storedRow(id);
    const updatedAt = new Date().toISOString();
    if (row) this.broadcast({ type: "upsert", node: publicNode(row, false), counts: this.counts(socket), updatedAt });
    else this.broadcast({ type: "remove", id: id.slice(0, 96), counts: this.counts(socket), updatedAt });
  }

  async webSocketClose(socket) {
    try { socket.close(1000, "closed"); }
    catch { /* already closed */ }
    this.markOffline(socket);
  }

  async webSocketError(socket) {
    this.markOffline(socket);
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
      return json({ ok: true, service: "owllm-world-presence", transport: "hibernating-websocket", retention: "persistent-anonymous" });
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
