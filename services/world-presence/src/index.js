const PRESENCE_TTL_MS = 15 * 60 * 1000;
const MAX_PUBLIC_NODES = 5_000;
const TOKEN_BYTES = 32;
const PUBLIC_ID_BYTES = 12;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

const JSON_HEADERS = {
  ...CORS_HEADERS,
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const schemaReady = new WeakMap();

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function empty(status = 204) {
  return new Response(null, { status, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finite(value) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function randomToken(bytes = TOKEN_BYTES, cryptoApi = crypto) {
  const data = new Uint8Array(bytes);
  cryptoApi.getRandomValues(data);
  return Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value, cryptoApi = crypto) {
  const digest = await cryptoApi.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bearerToken(request) {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer ([a-f0-9]{64})$/i.exec(header);
  return match?.[1]?.toLowerCase() ?? "";
}

function stableFraction(seed, salt) {
  let hash = 2166136261;
  const source = `${salt}:${seed}`;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

/**
 * Reduce Cloudflare's edge geolocation to a deliberately coarse map point.
 * Exact request coordinates and IP addresses are never returned or persisted.
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

function publicNode(record) {
  return {
    id: record.publicId,
    region: record.region,
    latitude: record.latitude,
    longitude: record.longitude,
    lastSeen: record.lastSeen,
  };
}

export function createMemoryPresenceStore() {
  const records = new Map();
  return {
    async find(tokenHash) { return records.get(tokenHash) ?? null; },
    async upsert(record) { records.set(record.tokenHash, { ...record }); },
    async remove(tokenHash) { records.delete(tokenHash); },
    async cleanup(nowMs) {
      for (const [key, value] of records) if (value.expiresAt <= nowMs) records.delete(key);
    },
    async count(nowMs) {
      return [...records.values()].filter((record) => record.expiresAt > nowMs).length;
    },
    async list(nowMs, limit) {
      return [...records.values()]
        .filter((record) => record.expiresAt > nowMs)
        .sort((left, right) => right.lastSeen.localeCompare(left.lastSeen))
        .slice(0, limit);
    },
    records,
  };
}

export async function handlePresenceRequest(request, store, runtime = {}) {
  const now = runtime.now?.() ?? Date.now();
  const cryptoApi = runtime.crypto ?? crypto;
  const url = new URL(request.url);

  if (request.method === "OPTIONS") return empty();
  if (url.pathname === "/health" && request.method === "GET") {
    return json({ ok: true, service: "owllm-world-presence", now: new Date(now).toISOString() });
  }
  if (url.pathname !== "/v1/presence") return json({ error: "not_found" }, 404);

  if (request.method === "GET") {
    await store.cleanup(now);
    const records = await store.list(now, MAX_PUBLIC_NODES);
    return json({
      nodes: records.map(publicNode),
      updatedAt: new Date(now).toISOString(),
      expiresAfterSeconds: PRESENCE_TTL_MS / 1000,
    });
  }

  if (request.method === "POST") {
    let token = bearerToken(request);
    let tokenHash = token ? await sha256(token, cryptoApi) : "";
    let existing = tokenHash ? await store.find(tokenHash) : null;
    if (!token || !existing) {
      await store.cleanup(now);
      if (await store.count(now) >= MAX_PUBLIC_NODES) return json({ error: "presence_capacity_reached" }, 429);
      token = randomToken(TOKEN_BYTES, cryptoApi);
      tokenHash = await sha256(token, cryptoApi);
      existing = null;
    }

    const publicId = existing?.publicId ?? randomToken(PUBLIC_ID_BYTES, cryptoApi);
    const location = coarseLocation(request.cf, publicId);
    if (!location) return json({ error: "coarse_location_unavailable" }, 503);

    const record = {
      tokenHash,
      publicId,
      ...location,
      lastSeen: new Date(now).toISOString(),
      expiresAt: now + PRESENCE_TTL_MS,
    };
    await store.upsert(record);
    return json({ token, node: publicNode(record), expiresAfterSeconds: PRESENCE_TTL_MS / 1000 });
  }

  if (request.method === "DELETE") {
    const token = bearerToken(request);
    if (token) await store.remove(await sha256(token, cryptoApi));
    return empty();
  }

  return json({ error: "method_not_allowed" }, 405);
}

async function ensureSchema(db) {
  let pending = schemaReady.get(db);
  if (!pending) {
    pending = (async () => {
      await db.prepare(`CREATE TABLE IF NOT EXISTS presence (
        token_hash TEXT PRIMARY KEY,
        public_id TEXT NOT NULL UNIQUE,
        region TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        last_seen TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )`).run();
      await db.prepare("CREATE INDEX IF NOT EXISTS presence_expires_at ON presence(expires_at)").run();
    })();
    schemaReady.set(db, pending);
  }
  return pending;
}

function d1Store(db) {
  return {
    async find(tokenHash) {
      const row = await db.prepare(`SELECT token_hash AS tokenHash, public_id AS publicId,
        region, latitude, longitude, last_seen AS lastSeen, expires_at AS expiresAt
        FROM presence WHERE token_hash = ?`).bind(tokenHash).first();
      return row ?? null;
    },
    async upsert(record) {
      await db.prepare(`INSERT INTO presence
        (token_hash, public_id, region, latitude, longitude, last_seen, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(token_hash) DO UPDATE SET
          region = excluded.region,
          latitude = excluded.latitude,
          longitude = excluded.longitude,
          last_seen = excluded.last_seen,
          expires_at = excluded.expires_at`)
        .bind(record.tokenHash, record.publicId, record.region, record.latitude, record.longitude, record.lastSeen, record.expiresAt)
        .run();
    },
    async remove(tokenHash) {
      await db.prepare("DELETE FROM presence WHERE token_hash = ?").bind(tokenHash).run();
    },
    async cleanup(nowMs) {
      await db.prepare("DELETE FROM presence WHERE expires_at <= ?").bind(nowMs).run();
    },
    async count(nowMs) {
      const row = await db.prepare("SELECT COUNT(*) AS count FROM presence WHERE expires_at > ?").bind(nowMs).first();
      return Number(row?.count ?? 0);
    },
    async list(nowMs, limit) {
      const result = await db.prepare(`SELECT token_hash AS tokenHash, public_id AS publicId,
        region, latitude, longitude, last_seen AS lastSeen, expires_at AS expiresAt
        FROM presence WHERE expires_at > ? ORDER BY last_seen DESC LIMIT ?`)
        .bind(nowMs, limit)
        .all();
      return result.results ?? [];
    },
  };
}

export default {
  async fetch(request, env) {
    await ensureSchema(env.DB);
    return handlePresenceRequest(request, d1Store(env.DB));
  },
  async scheduled(_controller, env) {
    await ensureSchema(env.DB);
    await d1Store(env.DB).cleanup(Date.now());
  },
};
