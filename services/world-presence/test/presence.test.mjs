import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { Miniflare } from "miniflare";
import { buildSnapshot, coarseLocation, publicNode, sanitizeNodeId } from "../src/index.js";

const KR = { country: "KR", regionCode: "11", latitude: "37.5665", longitude: "126.9780" };
const IT = { country: "IT", regionCode: "62", latitude: "41.9", longitude: "12.5" };

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for WebSocket message")), 2_000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      resolve(JSON.parse(String(event.data)));
    }, { once: true });
  });
}

async function withService(run) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: new URL("../src/index.js", import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1)),
    compatibilityDate: "2026-07-21",
    durableObjects: { WORLD_PRESENCE: { className: "WorldPresence", useSQLite: true } },
  });
  try { await run(mf); }
  finally { await mf.dispose(); }
}

async function connect(mf, role, cf = {}, id = "") {
  const query = id ? `?role=${role}&id=${id}` : `?role=${role}`;
  const response = await mf.dispatchFetch(`https://presence.example/v1/presence/connect${query}`, {
    headers: { Upgrade: "websocket" },
    cf,
  });
  assert.equal(response.status, 101);
  assert.ok(response.webSocket);
  response.webSocket.accept();
  return response.webSocket;
}

test("coarse location is stable, bounded, and never exposes exact coordinates", () => {
  const input = { country: "KR", regionCode: "11", latitude: 37.5665, longitude: 126.978 };
  const first = coarseLocation(input, "node-a");
  const second = coarseLocation(input, "node-a");
  assert.deepEqual(first, second);
  assert.equal(first.region, "KR · 11");
  assert.notEqual(first.latitude, input.latitude);
  assert.notEqual(first.longitude, input.longitude);
  assert.ok(first.latitude >= -85 && first.latitude <= 85);
  assert.ok(first.longitude >= -180 && first.longitude <= 180);
});

test("client node ids are reduced to an opaque, bounded, anonymous token", () => {
  assert.equal(sanitizeNodeId("Abc-123"), "abc-123");
  assert.equal(sanitizeNodeId("../evil path;DROP TABLE"), "evilpathdroptable");
  assert.equal(sanitizeNodeId("x".repeat(200)).length, 64);
  assert.equal(sanitizeNodeId(""), "");
});

test("snapshots expose only anonymous public fields, mark online, and count them", () => {
  const rows = [
    { id: "good", region: "KR", latitude: 36, longitude: 128, firstSeen: "t0", lastSeen: "t1", secret: "no" },
    { id: "ghost", region: "IT", latitude: 42, longitude: 12, firstSeen: "t0", lastSeen: "t1" },
    { id: "bad", region: "bad", latitude: 190, longitude: 0, firstSeen: "t0", lastSeen: "t1" },
  ];
  const snapshot = buildSnapshot(rows, new Set(["good"]), Date.parse("2026-07-21T12:00:00Z"));
  assert.equal(snapshot.type, "snapshot");
  assert.equal(snapshot.nodes.length, 2);
  assert.deepEqual(Object.keys(snapshot.nodes[0]).sort(), ["firstSeen", "id", "lastSeen", "latitude", "longitude", "online", "region"]);
  assert.equal(snapshot.nodes.find((node) => node.id === "good").online, true);
  assert.equal(snapshot.nodes.find((node) => node.id === "ghost").online, false);
  assert.deepEqual(snapshot.counts, { total: 2, online: 1 });
});

test("public node shape carries no leaked fields", () => {
  const node = publicNode({ id: "n", region: "EU", latitude: 48, longitude: 9, first_seen: "a", last_seen: "b", github_login: "leak" }, true);
  assert.deepEqual(Object.keys(node).sort(), ["firstSeen", "id", "lastSeen", "latitude", "longitude", "online", "region"]);
});

test("health endpoint identifies the persistent hibernating-WebSocket transport", async () => {
  await withService(async (mf) => {
    const response = await mf.dispatchFetch("https://presence.example/health");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      service: "owllm-world-presence",
      transport: "hibernating-websocket",
      retention: "persistent-anonymous",
    });
  });
});

test("viewer receives an empty initial snapshot with zero counts", async () => {
  await withService(async (mf) => {
    const viewer = await connect(mf, "viewer");
    const snapshot = await nextMessage(viewer);
    assert.equal(snapshot.type, "snapshot");
    assert.deepEqual(snapshot.nodes, []);
    assert.deepEqual(snapshot.counts, { total: 0, online: 0 });
    viewer.close(1000, "done");
  });
});

test("first sighting records the node and broadcasts an online upsert with counts", async () => {
  await withService(async (mf) => {
    const viewer = await connect(mf, "viewer");
    await nextMessage(viewer);
    const update = nextMessage(viewer);
    const presence = await connect(mf, "presence", KR, "installa");
    const change = await update;
    assert.equal(change.type, "upsert");
    assert.equal(change.node.id, "installa");
    assert.equal(change.node.region, "KR · 11");
    assert.equal(change.node.online, true);
    assert.notEqual(change.node.latitude, 37.5665);
    assert.deepEqual(Object.keys(change.node).sort(), ["firstSeen", "id", "lastSeen", "latitude", "longitude", "online", "region"]);
    assert.deepEqual(change.counts, { total: 1, online: 1 });
    presence.close(1000, "invisible");
    viewer.close(1000, "done");
  });
});

test("going offline keeps the node forever and broadcasts a ghost, not a removal", async () => {
  await withService(async (mf) => {
    const presence = await connect(mf, "presence", IT, "ghostid");
    const viewer = await connect(mf, "viewer");
    const first = await nextMessage(viewer);
    assert.equal(first.nodes.length, 1);
    assert.equal(first.nodes[0].online, true);
    const update = nextMessage(viewer);
    presence.close(1000, "invisible");
    const change = await update;
    assert.equal(change.type, "upsert");
    assert.equal(change.node.id, "ghostid");
    assert.equal(change.node.online, false);
    assert.deepEqual(change.counts, { total: 1, online: 0 });
    // A brand-new viewer still sees the recorded ghost after the socket is gone.
    const later = await connect(mf, "viewer");
    const snapshot = await nextMessage(later);
    assert.equal(snapshot.nodes.length, 1);
    assert.equal(snapshot.nodes[0].id, "ghostid");
    assert.equal(snapshot.nodes[0].online, false);
    assert.deepEqual(snapshot.counts, { total: 1, online: 0 });
    later.close(1000, "done");
    viewer.close(1000, "done");
  });
});

test("the same installation reconnecting stays one recorded node", async () => {
  await withService(async (mf) => {
    const first = await connect(mf, "presence", KR, "stable");
    first.close(1000, "invisible");
    const second = await connect(mf, "presence", KR, "stable");
    const viewer = await connect(mf, "viewer");
    const snapshot = await nextMessage(viewer);
    assert.equal(snapshot.counts.total, 1);
    assert.equal(snapshot.nodes.length, 1);
    assert.equal(snapshot.nodes[0].id, "stable");
    assert.equal(snapshot.nodes[0].online, true);
    second.close(1000, "done");
    viewer.close(1000, "done");
  });
});

test("counts report total recorded and online now as membership changes", async () => {
  await withService(async (mf) => {
    const a = await connect(mf, "presence", KR, "aaa");
    const b = await connect(mf, "presence", IT, "bbb");
    const viewer = await connect(mf, "viewer");
    const snapshot = await nextMessage(viewer);
    assert.deepEqual(snapshot.counts, { total: 2, online: 2 });
    const update = nextMessage(viewer);
    a.close(1000, "invisible");
    const change = await update;
    assert.equal(change.node.online, false);
    assert.deepEqual(change.counts, { total: 2, online: 1 });
    b.close(1000, "done");
    viewer.close(1000, "done");
  });
});

test("HTTP presence calls and invalid roles fail closed", async () => {
  await withService(async (mf) => {
    const plain = await mf.dispatchFetch("https://presence.example/v1/presence/connect?role=viewer");
    assert.equal(plain.status, 426);
    const invalid = await mf.dispatchFetch("https://presence.example/v1/presence/connect?role=admin", { headers: { Upgrade: "websocket" } });
    assert.equal(invalid.status, 400);
  });
});

test("service keeps privacy invariants while intentionally retaining anonymous nodes", async () => {
  const source = await fs.readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const config = await fs.readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  // Privacy invariants preserved: never read the IP or any identity, never cron.
  assert.doesNotMatch(source, /CF-Connecting-IP|x-forwarded-for|github|device_name|project|prompt/i);
  assert.doesNotMatch(source, /scheduled\s*\(|expires_at/i);
  assert.doesNotMatch(config, /d1_databases|crons/i);
  // Retention is now intentional: anonymous nodes live in free-tier DO SQLite.
  assert.match(source, /CREATE TABLE IF NOT EXISTS nodes/);
  assert.match(source, /first_seen/);
  assert.match(source, /acceptWebSocket/);
  assert.match(config, /new_sqlite_classes/);
});
