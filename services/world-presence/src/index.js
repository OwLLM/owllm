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
// rounded to a coarse geographic grid). The only client attribute exposed is a
// normalized OS
// family (Windows/macOS/Linux/Other) plus the release string; no account or
// workspace data is accepted. The stable node id is an opaque one-way hash of
// the client's own device key; it identifies nothing but "the same anonymous
// dot across visits", and a client that cannot produce one sends no id at all
// rather than inventing a random one (which recorded one install many times).

import {
  MAX_INBOX_PER_PEER,
  MAX_ROOMS_PER_PEER,
  MAX_ROOM_MEMBERS,
  INBOX_TTL_MS,
  REPORT_SUSPEND_THRESHOLD,
  STRANGER_REQUESTS_PER_DAY,
  allowSend,
  publicPeer,
  randomNonce,
  sanitizeAvatar,
  sanitizeBox,
  sanitizeChatId,
  sanitizeNick,
  sanitizeRoomId,
  verifyPresenceAuth,
} from "./chat.js";

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

function randomId(cryptoApi = crypto) {
  return cryptoApi.randomUUID().replaceAll("-", "").slice(0, 24);
}

/** Opaque, device-local node id supplied by the client. Identifies nothing. */
export function sanitizeNodeId(raw) {
  return String(raw ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 64);
}

/** Release string only — never a build path, user agent, or free-form text. */
export function sanitizeAppVersion(raw) {
  return String(raw ?? "").trim().replace(/[^0-9A-Za-z.+-]/g, "").slice(0, 24);
}

/** Reduce platform data to the four anonymous families shown on the map. */
export function normalizeOsFamily(raw) {
  const text = String(raw ?? "").toLowerCase();
  if (text.includes("windows") || /\bwin(?:32|64)?\b/.test(text)) return "Windows";
  if (text.includes("macintosh") || text.includes("mac os") || text.includes("darwin") || text === "macos") return "macOS";
  if (text.includes("linux") || text.includes("x11")) return "Linux";
  return "Other";
}

/**
 * Reduce Cloudflare edge metadata to a deliberately coarse map point and city.
 * Source IP and exact request coordinates are never read, returned, or stored.
 */
export function coarseLocation(cf) {
  const latitude = finite(cf?.latitude);
  const longitude = finite(cf?.longitude);
  if (latitude == null || longitude == null) return null;

  const roundedLatitude = Math.round(latitude / 4) * 4;
  const roundedLongitude = Math.round(longitude / 4) * 4;
  const country = String(cf?.country ?? "").trim().slice(0, 2).toUpperCase();
  const city = String(cf?.city || cf?.region || "").trim().slice(0, 64);

  return {
    region: [country, city].filter(Boolean).join(" · ") || "Cloudflare edge",
    latitude: Number(clamp(roundedLatitude, -85, 85).toFixed(2)),
    longitude: Number(clamp(roundedLongitude, -180, 180).toFixed(2)),
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
    os: normalizeOsFamily(row.os),
    appVersion: sanitizeAppVersion(row.appVersion ?? row.app_version),
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
    const nodeColumns = this.sql.exec("PRAGMA table_info(nodes)").toArray();
    if (!nodeColumns.some((column) => String(column.name) === "os")) {
      // Preserve every recorded node while extending the anonymous history.
      // Older rows remain truthfully "Other" until that installation reconnects.
      this.sql.exec("ALTER TABLE nodes ADD COLUMN os TEXT NOT NULL DEFAULT 'Other'");
    }
    if (!nodeColumns.some((column) => String(column.name) === "app_version")) {
      // Added without a schema_version bump on purpose: bumping wipes the table,
      // and every recorded install must survive gaining a column. Rows written
      // by older clients stay truthfully blank until that install reconnects.
      this.sql.exec("ALTER TABLE nodes ADD COLUMN app_version TEXT NOT NULL DEFAULT ''");
    }
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
    this.createChatTables();
    // Per-identity flood window. Deliberately in memory: it is reset by
    // hibernation, which only happens when the object has been idle.
    this.sendWindows = new Map();
  }

  /**
   * Chat state. Created with CREATE TABLE IF NOT EXISTS and never behind a
   * schema_version bump — that branch deletes every recorded node, and gaining
   * a feature must not cost an installation its history.
   */
  createChatTables() {
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS peers (chat_id TEXT PRIMARY KEY, ed_pub TEXT NOT NULL DEFAULT '', " +
      "x_pub TEXT NOT NULL DEFAULT '', nick TEXT NOT NULL DEFAULT '', avatar TEXT NOT NULL DEFAULT '', " +
      "reachable INTEGER NOT NULL DEFAULT 0, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL)",
    );
    // The table above already exists in production without `avatar`, and
    // CREATE TABLE IF NOT EXISTS will not add a column to it. Adding one is the
    // whole migration: it is additive, defaulted, and an object that already
    // has the column simply throws "duplicate column name", which is the
    // success case on every run after the first.
    try { this.sql.exec("ALTER TABLE peers ADD COLUMN avatar TEXT NOT NULL DEFAULT ''"); }
    catch { /* already migrated */ }
    // One row per (owner, peer) holding OWNER's stance toward PEER:
    // 'requested' (owner asked), 'accepted' (mutual), 'blocked' (owner refuses).
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS links (owner TEXT NOT NULL, peer TEXT NOT NULL, state TEXT NOT NULL, " +
      "updated_at TEXT NOT NULL, PRIMARY KEY (owner, peer))",
    );
    // Undelivered ciphertext. `body` is a sealed envelope the service cannot read.
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS inbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, to_id TEXT NOT NULL, " +
      "from_id TEXT NOT NULL, room TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, body TEXT NOT NULL, ts TEXT NOT NULL)",
    );
    this.sql.exec("CREATE INDEX IF NOT EXISTS inbox_to ON inbox (to_id, seq)");
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS rooms (room_id TEXT NOT NULL, chat_id TEXT NOT NULL, " +
      "joined_at TEXT NOT NULL, PRIMARY KEY (room_id, chat_id))",
    );
    // One report per (target, reporter) so a single account cannot pile on.
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS reports (target TEXT NOT NULL, reporter TEXT NOT NULL, ts TEXT NOT NULL, " +
      "PRIMARY KEY (target, reporter))",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS quota (chat_id TEXT PRIMARY KEY, day TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0)",
    );
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

  /** Normalized OS family and release for each live installation. */
  onlineOs(excludedSocket) {
    const live = new Map();
    for (const socket of this.presenceSockets()) {
      if (socket === excludedSocket) continue;
      const data = attachment(socket);
      if (data?.role === PRESENCE_TAG && data.id) {
        live.set(String(data.id), { os: normalizeOsFamily(data.os), appVersion: sanitizeAppVersion(data.appVersion) });
      }
    }
    return live;
  }

  storedRows() {
    return this.sql
      .exec("SELECT id, region, os, app_version AS appVersion, latitude, longitude, first_seen AS firstSeen, last_seen AS lastSeen FROM nodes ORDER BY first_seen ASC LIMIT ?", MAX_NODES)
      .toArray();
  }

  storedRow(id) {
    return this.sql
      .exec("SELECT id, region, os, app_version AS appVersion, latitude, longitude, first_seen AS firstSeen, last_seen AS lastSeen FROM nodes WHERE id = ?", id)
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
    const live = this.onlineOs(excludedSocket);
    const rows = this.storedRows().map((row) => {
      const now = live.get(String(row.id ?? ""));
      return { ...row, os: now?.os ?? row.os, appVersion: now?.appVersion || row.appVersion };
    });
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

  /** Record a first sighting or refresh its anonymous city, OS, and map point. */
  recordNode(id, location, os, appVersion, now) {
    this.sql.exec(
      "INSERT INTO nodes (id, region, os, app_version, latitude, longitude, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET region = excluded.region, os = excluded.os, app_version = excluded.app_version, " +
      "latitude = excluded.latitude, longitude = excluded.longitude, last_seen = excluded.last_seen",
      id, location.region, os, appVersion, location.latitude, location.longitude, now, now,
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
      const url = new URL(request.url);
      const stableId = sanitizeNodeId(url.searchParams.get("id"));
      const id = stableId || randomId();
      // New clients provide a normalized family explicitly. The user-agent
      // fallback classifies older releases so the country breakdown works
      // immediately without exposing browser/version details to viewers.
      const os = normalizeOsFamily(url.searchParams.get("os") || request.headers.get("User-Agent"));
      const appVersion = sanitizeAppVersion(url.searchParams.get("v"));
      const location = coarseLocation({
        country: request.headers.get("X-OWLLM-Country"),
        city: request.headers.get("X-OWLLM-City"),
        region: request.headers.get("X-OWLLM-Region"),
        latitude: request.headers.get("X-OWLLM-Latitude"),
        longitude: request.headers.get("X-OWLLM-Longitude"),
      });
      if (!location) return json({ error: "coarse_location_unavailable" }, 503);
      // Only installations that supply a stable client id are recorded forever.
      // A connection without one (pre-stable-id clients) is shown online while
      // connected but never persisted — otherwise every reconnect would mint a
      // new permanent node and the total would grow without bound.
      const ephemeral = !stableId;
      const row = ephemeral
        ? { id, region: location.region, os, appVersion, latitude: location.latitude, longitude: location.longitude, firstSeen: now, lastSeen: now }
        : this.recordNode(id, location, os, appVersion, now);
      // A client that wants chat asks for a challenge here. Presence itself
      // stays anonymous: without ?chat=1 no key is ever presented, and the
      // socket behaves exactly as it did before chat existed.
      const wantsChat = url.searchParams.get("chat") === "1" && !ephemeral;
      const nonce = wantsChat ? randomNonce() : "";
      server.serializeAttachment({ role, id, os, appVersion, ephemeral, node: ephemeral ? row : undefined, connectedAt: now, nonce, chatId: "" });
      this.state.acceptWebSocket(server, [role]);
      if (nonce) safeSend(server, { type: "chat_challenge", nonce });
      this.broadcast({ type: "upsert", node: publicNode(row, true), counts: this.counts(), updatedAt: new Date().toISOString() });
    } else {
      server.serializeAttachment({ role, connectedAt: now });
      this.state.acceptWebSocket(server, [role]);
      safeSend(server, this.snapshot());
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  // ----------------------------------------------------------------
  // Chat state helpers
  // ----------------------------------------------------------------

  updateAttachment(socket, patch) {
    const next = { ...(attachment(socket) ?? {}), ...patch };
    try { socket.serializeAttachment(next); }
    catch { /* socket already gone */ }
    return next;
  }

  /** Live sockets belonging to one verified identity (a person may run several). */
  chatSockets(chatId) {
    const sockets = [];
    if (!chatId) return sockets;
    for (const socket of this.presenceSockets()) {
      if (attachment(socket)?.chatId === chatId) sockets.push(socket);
    }
    return sockets;
  }

  peerRow(chatId) {
    return this.sql.exec("SELECT * FROM peers WHERE chat_id = ?", chatId).toArray()[0] ?? null;
  }

  linkState(owner, peer) {
    return String(this.sql.exec("SELECT state FROM links WHERE owner = ? AND peer = ?", owner, peer).toArray()[0]?.state ?? "");
  }

  setLink(owner, peer, state, now) {
    this.sql.exec(
      "INSERT INTO links (owner, peer, state, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(owner, peer) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
      owner, peer, state, now,
    );
  }

  reportCount(target) {
    return Number(this.sql.exec("SELECT COUNT(*) AS c FROM reports WHERE target = ?", target).toArray()[0]?.c ?? 0);
  }

  /** Day-bounded first-contact quota, so one identity cannot spray the map. */
  consumeRequestQuota(chatId, now) {
    const day = now.slice(0, 10);
    const row = this.sql.exec("SELECT day, requests FROM quota WHERE chat_id = ?", chatId).toArray()[0];
    const used = row && String(row.day) === day ? Number(row.requests) : 0;
    if (used >= STRANGER_REQUESTS_PER_DAY) return false;
    this.sql.exec(
      "INSERT INTO quota (chat_id, day, requests) VALUES (?, ?, 1) " +
      "ON CONFLICT(chat_id) DO UPDATE SET day = excluded.day, requests = CASE WHEN quota.day = excluded.day THEN quota.requests + 1 ELSE 1 END",
      chatId, day,
    );
    return true;
  }

  /**
   * Queue first, then attempt live delivery. Storing before sending is what
   * makes an offline recipient and a recipient whose socket dies mid-send
   * behave identically — the row survives until the client acknowledges it.
   */
  enqueue(toId, fromId, room, kind, body, now) {
    this.sql.exec("DELETE FROM inbox WHERE ts < ?", new Date(Date.parse(now) - INBOX_TTL_MS).toISOString());
    this.sql.exec(
      "INSERT INTO inbox (to_id, from_id, room, kind, body, ts) VALUES (?, ?, ?, ?, ?, ?)",
      toId, fromId, room, kind, body, now,
    );
    const seq = Number(this.sql.exec("SELECT last_insert_rowid() AS seq").toArray()[0]?.seq ?? 0);
    this.sql.exec(
      "DELETE FROM inbox WHERE to_id = ? AND seq NOT IN (SELECT seq FROM inbox WHERE to_id = ? ORDER BY seq DESC LIMIT ?)",
      toId, toId, MAX_INBOX_PER_PEER,
    );
    const payload = { type: "chat_message", id: seq, kind, from: fromId, room, box: body, ts: now };
    let delivered = false;
    for (const socket of this.chatSockets(toId)) delivered = safeSend(socket, payload) || delivered;
    return { seq, delivered };
  }

  flushInbox(chatId, socket) {
    const rows = this.sql
      .exec("SELECT seq, to_id, from_id, room, kind, body, ts FROM inbox WHERE to_id = ? ORDER BY seq ASC LIMIT ?", chatId, MAX_INBOX_PER_PEER)
      .toArray();
    for (const row of rows) {
      safeSend(socket, { type: "chat_message", id: Number(row.seq), kind: String(row.kind), from: String(row.from_id), room: String(row.room), box: String(row.body), ts: String(row.ts) });
    }
    return rows.length;
  }

  chatState(chatId) {
    const links = this.sql.exec("SELECT peer, state FROM links WHERE owner = ?", chatId).toArray();
    const rooms = this.sql.exec("SELECT room_id FROM rooms WHERE chat_id = ?", chatId).toArray().map((row) => String(row.room_id));
    return {
      type: "chat_state",
      contacts: links.filter((row) => row.state === "accepted").map((row) => String(row.peer)),
      requests: links.filter((row) => row.state === "pending").map((row) => String(row.peer)),
      requested: links.filter((row) => row.state === "requested").map((row) => String(row.peer)),
      blocked: links.filter((row) => row.state === "blocked").map((row) => String(row.peer)),
      rooms,
    };
  }

  // ----------------------------------------------------------------
  // Chat protocol
  // ----------------------------------------------------------------

  async handleChatAuth(socket, data, message, now) {
    if (data.chatId) return safeSend(socket, { type: "chat_error", error: "auth_already_done" });
    const verdict = await verifyPresenceAuth({ nonce: data.nonce, publicKey: message.publicKey, signature: message.signature });
    if (!verdict.ok) return safeSend(socket, { type: "chat_error", error: verdict.error });
    // A valid signature only proves the client holds SOME key. The dot it may
    // speak for is the one that key derives to — never the one it asked for.
    if (verdict.chatId !== String(data.id ?? "")) {
      return safeSend(socket, { type: "chat_error", error: "auth_identity_mismatch" });
    }
    const chatId = verdict.chatId;
    const nick = sanitizeNick(message.nick);
    const avatar = sanitizeAvatar(message.avatar);
    const reachable = message.reachable === true ? 1 : 0;
    const xPub = String(message.xPub ?? "").slice(0, 64);
    const edPub = String(message.publicKey ?? "").slice(0, 64);
    this.sql.exec(
      "INSERT INTO peers (chat_id, ed_pub, x_pub, nick, avatar, reachable, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(chat_id) DO UPDATE SET ed_pub = excluded.ed_pub, x_pub = excluded.x_pub, " +
      "nick = excluded.nick, avatar = excluded.avatar, reachable = excluded.reachable, last_seen = excluded.last_seen",
      chatId, edPub, xPub, nick, avatar, reachable, now, now,
    );
    this.updateAttachment(socket, { chatId, nonce: "" });
    safeSend(socket, { type: "chat_ready", id: chatId, nick, avatar, reachable: Boolean(reachable) });
    safeSend(socket, this.chatState(chatId));
    this.flushInbox(chatId, socket);
  }

  handleChatMessage(socket, data, message, now) {
    const chatId = String(data.chatId ?? "");
    if (!chatId) return safeSend(socket, { type: "chat_error", error: "not_authenticated" });
    if (!allowSend(this.sendWindows, chatId, Date.parse(now))) {
      return safeSend(socket, { type: "chat_error", error: "rate_limited" });
    }

    switch (message.type) {
      case "chat_profile": {
        const nick = sanitizeNick(message.nick);
        const avatar = sanitizeAvatar(message.avatar);
        this.sql.exec(
          "UPDATE peers SET nick = ?, avatar = ?, reachable = ?, last_seen = ? WHERE chat_id = ?",
          nick, avatar, message.reachable === true ? 1 : 0, now, chatId,
        );
        return safeSend(socket, { type: "chat_profile_ok", nick, avatar, reachable: message.reachable === true });
      }
      case "chat_lookup": {
        // Public keys only. Knowing a key lets you encrypt TO someone, never
        // read from them, and every node id is already public on the map — so
        // consent is enforced at send time, not by hiding the key.
        const ids = Array.isArray(message.ids) ? message.ids.slice(0, 200).map(sanitizeChatId).filter(Boolean) : [];
        const peers = ids.map((id) => this.peerRow(id)).filter(Boolean).map(publicPeer);
        // Echo what was asked for, so a client can tell "no chat key" apart
        // from "the answer has not arrived yet".
        return safeSend(socket, { type: "chat_peers", ids, peers });
      }
      case "chat_request": {
        const to = sanitizeChatId(message.to);
        const box = sanitizeBox(message.box);
        if (!to || to === chatId || !box) return safeSend(socket, { type: "chat_error", error: "chat_request_invalid" });
        const target = this.peerRow(to);
        if (!target) return safeSend(socket, { type: "chat_error", error: "peer_unknown" });
        if (this.linkState(to, chatId) === "blocked") return safeSend(socket, { type: "chat_error", error: "peer_blocked" });
        if (this.linkState(to, chatId) !== "accepted") {
          if (!Number(target.reachable)) return safeSend(socket, { type: "chat_error", error: "peer_not_reachable" });
          if (this.reportCount(chatId) >= REPORT_SUSPEND_THRESHOLD) return safeSend(socket, { type: "chat_error", error: "sender_suspended" });
          if (!this.consumeRequestQuota(chatId, now)) return safeSend(socket, { type: "chat_error", error: "request_quota_exhausted" });
        }
        if (this.linkState(to, chatId) !== "accepted") {
          this.setLink(to, chatId, "pending", now);
          this.setLink(chatId, to, "requested", now);
        }
        const { seq, delivered } = this.enqueue(to, chatId, "", "request", box, now);
        for (const peerSocket of this.chatSockets(to)) safeSend(peerSocket, this.chatState(to));
        return safeSend(socket, { type: "chat_sent", id: seq, to, delivered });
      }
      case "chat_accept": {
        const peer = sanitizeChatId(message.id);
        if (!peer || this.linkState(chatId, peer) !== "pending") {
          return safeSend(socket, { type: "chat_error", error: "no_pending_request" });
        }
        this.setLink(chatId, peer, "accepted", now);
        this.setLink(peer, chatId, "accepted", now);
        for (const peerSocket of this.chatSockets(peer)) safeSend(peerSocket, this.chatState(peer));
        return safeSend(socket, this.chatState(chatId));
      }
      case "chat_block":
      case "chat_unblock": {
        const peer = sanitizeChatId(message.id);
        if (!peer) return safeSend(socket, { type: "chat_error", error: "peer_unknown" });
        if (message.type === "chat_block") {
          this.setLink(chatId, peer, "blocked", now);
          // A block also drops anything that peer already queued for us.
          this.sql.exec("DELETE FROM inbox WHERE to_id = ? AND from_id = ?", chatId, peer);
        } else {
          this.sql.exec("DELETE FROM links WHERE owner = ? AND peer = ? AND state = 'blocked'", chatId, peer);
        }
        return safeSend(socket, this.chatState(chatId));
      }
      case "chat_report": {
        // The body is ciphertext this service cannot read, so a report is a
        // signal and nothing more: enough distinct reporters and the reported
        // identity loses the ability to reach people who have not accepted it.
        const peer = sanitizeChatId(message.id);
        if (!peer || peer === chatId) return safeSend(socket, { type: "chat_error", error: "peer_unknown" });
        this.sql.exec("INSERT OR IGNORE INTO reports (target, reporter, ts) VALUES (?, ?, ?)", peer, chatId, now);
        if (this.reportCount(peer) >= REPORT_SUSPEND_THRESHOLD) {
          this.sql.exec("UPDATE peers SET reachable = 0 WHERE chat_id = ?", peer);
        }
        this.setLink(chatId, peer, "blocked", now);
        return safeSend(socket, this.chatState(chatId));
      }
      case "chat_send": {
        const to = sanitizeChatId(message.to);
        const box = sanitizeBox(message.box);
        if (!to || !box) return safeSend(socket, { type: "chat_error", error: "chat_send_invalid" });
        if (this.linkState(to, chatId) === "blocked") return safeSend(socket, { type: "chat_error", error: "peer_blocked" });
        if (this.linkState(to, chatId) !== "accepted") return safeSend(socket, { type: "chat_error", error: "not_a_contact" });
        const { seq, delivered } = this.enqueue(to, chatId, "", "message", box, now);
        return safeSend(socket, { type: "chat_sent", id: seq, to, delivered });
      }
      case "chat_ack": {
        const ids = Array.isArray(message.ids) ? message.ids.slice(0, MAX_INBOX_PER_PEER).map(Number).filter(Number.isInteger) : [];
        for (const id of ids) this.sql.exec("DELETE FROM inbox WHERE seq = ? AND to_id = ?", id, chatId);
        return safeSend(socket, { type: "chat_acked", ids });
      }
      case "room_join": {
        const room = sanitizeRoomId(message.room);
        if (!room) return safeSend(socket, { type: "chat_error", error: "room_invalid" });
        const mine = Number(this.sql.exec("SELECT COUNT(*) AS c FROM rooms WHERE chat_id = ?", chatId).toArray()[0]?.c ?? 0);
        const size = Number(this.sql.exec("SELECT COUNT(*) AS c FROM rooms WHERE room_id = ?", room).toArray()[0]?.c ?? 0);
        if (mine >= MAX_ROOMS_PER_PEER) return safeSend(socket, { type: "chat_error", error: "room_limit_reached" });
        if (size >= MAX_ROOM_MEMBERS) return safeSend(socket, { type: "chat_error", error: "room_full" });
        this.sql.exec("INSERT OR IGNORE INTO rooms (room_id, chat_id, joined_at) VALUES (?, ?, ?)", room, chatId, now);
        return safeSend(socket, this.roomMembers(room));
      }
      case "room_leave": {
        const room = sanitizeRoomId(message.room);
        this.sql.exec("DELETE FROM rooms WHERE room_id = ? AND chat_id = ?", room, chatId);
        return safeSend(socket, this.chatState(chatId));
      }
      case "room_members": {
        const room = sanitizeRoomId(message.room);
        if (!this.inRoom(room, chatId)) return safeSend(socket, { type: "chat_error", error: "not_a_member" });
        return safeSend(socket, this.roomMembers(room));
      }
      case "room_send": {
        // One sealed box per recipient: the sender encrypts to each member's
        // key, so a room is still end-to-end and the relay still holds only
        // ciphertext. The server never learns the room's invite secret.
        const room = sanitizeRoomId(message.room);
        if (!this.inRoom(room, chatId)) return safeSend(socket, { type: "chat_error", error: "not_a_member" });
        const boxes = Array.isArray(message.boxes) ? message.boxes.slice(0, MAX_ROOM_MEMBERS) : [];
        let sent = 0;
        for (const entry of boxes) {
          const to = sanitizeChatId(entry?.to);
          const box = sanitizeBox(entry?.box);
          if (!to || !box || to === chatId || !this.inRoom(room, to)) continue;
          if (this.linkState(to, chatId) === "blocked") continue;
          this.enqueue(to, chatId, room, "room", box, now);
          sent += 1;
        }
        return safeSend(socket, { type: "chat_sent", room, to: "", delivered: sent > 0, fanout: sent });
      }
      default:
        return safeSend(socket, { type: "chat_error", error: "unknown_message" });
    }
  }

  inRoom(room, chatId) {
    if (!room || !chatId) return false;
    return this.sql.exec("SELECT 1 AS ok FROM rooms WHERE room_id = ? AND chat_id = ?", room, chatId).toArray().length > 0;
  }

  roomMembers(room) {
    const ids = this.sql.exec("SELECT chat_id FROM rooms WHERE room_id = ?", room).toArray().map((row) => String(row.chat_id));
    const members = ids.map((id) => this.peerRow(id)).filter(Boolean).map(publicPeer);
    return { type: "room_roster", room, members };
  }

  async webSocketMessage(socket, message) {
    const data = attachment(socket);
    if (message === "snapshot" && data?.role === VIEWER_TAG) return safeSend(socket, this.snapshot());
    if (data?.role !== PRESENCE_TAG) return;
    let parsed;
    try { parsed = JSON.parse(String(message)); }
    catch { return; }
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") return;
    const now = new Date().toISOString();
    if (parsed.type === "chat_auth") return this.handleChatAuth(socket, data, parsed, now);
    if (parsed.type.startsWith("chat_") || parsed.type.startsWith("room_")) {
      return this.handleChatMessage(socket, data, parsed, now);
    }
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
    headers.set("X-OWLLM-City", String(request.cf?.city ?? ""));
    headers.set("X-OWLLM-Region", String(request.cf?.regionCode ?? request.cf?.region ?? ""));
    headers.set("X-OWLLM-Latitude", String(request.cf?.latitude ?? ""));
    headers.set("X-OWLLM-Longitude", String(request.cf?.longitude ?? ""));
    return durableRequest(new Request(request, { headers }), env);
  },
};
