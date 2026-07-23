import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { Miniflare } from "miniflare";
import { coarseLocation, snapshotFromSockets } from "../src/index.js";

function socketWithAttachment(value) {
  return { deserializeAttachment: () => value };
}

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

async function connect(mf, role, cf = {}) {
  const response = await mf.dispatchFetch(`https://presence.example/v1/presence/connect?role=${role}`, {
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

test("snapshots expose only anonymous public fields and reject invalid nodes", () => {
  const snapshot = snapshotFromSockets([
    socketWithAttachment({ role: "presence", id: "good", region: "KR", latitude: 36, longitude: 128, connectedAt: "now", secret: "no" }),
    socketWithAttachment({ role: "presence", id: "bad", region: "bad", latitude: 190, longitude: 0, connectedAt: "now" }),
    socketWithAttachment({ role: "viewer", id: "viewer" }),
  ], Date.parse("2026-07-21T12:00:00Z"));
  assert.equal(snapshot.type, "snapshot");
  assert.equal(snapshot.nodes.length, 1);
  assert.deepEqual(Object.keys(snapshot.nodes[0]).sort(), ["id", "lastSeen", "latitude", "longitude", "region"]);
});

test("health endpoint identifies the hibernating WebSocket transport", async () => {
  await withService(async (mf) => {
    const response = await mf.dispatchFetch("https://presence.example/health");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      service: "owllm-world-presence",
      transport: "hibernating-websocket",
    });
  });
});

test("viewer receives an empty initial snapshot", async () => {
  await withService(async (mf) => {
    const viewer = await connect(mf, "viewer");
    const snapshot = await nextMessage(viewer);
    assert.equal(snapshot.type, "snapshot");
    assert.deepEqual(snapshot.nodes, []);
    viewer.close(1000, "done");
  });
});

test("presence connection broadcasts one coarse anonymous upsert to viewers", async () => {
  await withService(async (mf) => {
    const viewer = await connect(mf, "viewer");
    await nextMessage(viewer);
    const update = nextMessage(viewer);
    const presence = await connect(mf, "presence", {
      country: "KR",
      regionCode: "11",
      latitude: "37.5665",
      longitude: "126.9780",
    });
    const change = await update;
    assert.equal(change.type, "upsert");
    assert.match(change.node.id, /^[a-f0-9]{24}$/);
    assert.equal(change.node.region, "KR · 11");
    assert.notEqual(change.node.latitude, 37.5665);
    assert.deepEqual(Object.keys(change.node).sort(), ["id", "lastSeen", "latitude", "longitude", "region"]);
    presence.close(1000, "invisible");
    viewer.close(1000, "done");
  });
});

test("closing a presence socket broadcasts its immediate removal", async () => {
  await withService(async (mf) => {
    const presence = await connect(mf, "presence", { country: "IT", regionCode: "62", latitude: "41.9", longitude: "12.5" });
    const viewer = await connect(mf, "viewer");
    assert.equal((await nextMessage(viewer)).nodes.length, 1);
    const update = nextMessage(viewer);
    presence.close(1000, "invisible");
    const change = await update;
    assert.equal(change.type, "remove");
    assert.match(change.id, /^[a-f0-9]{24}$/);
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

test("service has no database, heartbeat, IP, identity, or retained-presence path", async () => {
  const source = await fs.readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const config = await fs.readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.doesNotMatch(source, /CF-Connecting-IP|x-forwarded-for|github|device_name|project|prompt/i);
  assert.doesNotMatch(source, /INSERT INTO|CREATE TABLE|expires_at|scheduled\s*\(/i);
  assert.doesNotMatch(config, /d1_databases|crons/i);
  assert.match(source, /acceptWebSocket/);
  assert.match(config, /new_sqlite_classes/);
});
