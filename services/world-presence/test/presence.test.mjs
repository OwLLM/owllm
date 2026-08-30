import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { Miniflare } from "miniflare";
import { buildSnapshot, coarseLocation, normalizeOsFamily, publicNode, sanitizeNodeId } from "../src/index.js";

const KR = { country: "KR", city: "Seoul", regionCode: "11", latitude: "37.5665", longitude: "126.9780" };
const IT = { country: "IT", city: "Rome", regionCode: "62", latitude: "41.9", longitude: "12.5" };

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
    // index.js imports ./chat.js; without this rule miniflare loads the
    // sibling as CommonJS and every test fails on its export statements.
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    compatibilityDate: "2026-07-21",
    durableObjects: { WORLD_PRESENCE: { className: "WorldPresence", useSQLite: true } },
  });
  try { await run(mf); }
  finally { await mf.dispose(); }
}

async function connect(mf, role, cf = {}, id = "", os = "", appVersion = "") {
  const params = new URLSearchParams({ role });
  if (id) params.set("id", id);
  if (os) params.set("os", os);
  if (appVersion) params.set("v", appVersion);
  const query = `?${params.toString()}`;
  const response = await mf.dispatchFetch(`https://presence.example/v1/presence/connect${query}`, {
    headers: { Upgrade: "websocket" },
    cf,
  });
  assert.equal(response.status, 101);
  assert.ok(response.webSocket);
  response.webSocket.accept();
  return response.webSocket;
}

test("coarse location uses the real geographic grid without per-node random displacement", () => {
  const input = { country: "KR", city: "Seoul", regionCode: "11", latitude: 37.5665, longitude: 126.978 };
  const first = coarseLocation(input, "node-a");
  const second = coarseLocation(input, "node-b");
  assert.deepEqual(first, second);
  assert.equal(first.region, "KR · Seoul");
  assert.equal(first.latitude, 36);
  assert.equal(first.longitude, 128);
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

test("operating systems are reduced to coarse anonymous families", () => {
  assert.equal(normalizeOsFamily("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "Windows");
  assert.equal(normalizeOsFamily("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)"), "macOS");
  assert.equal(normalizeOsFamily("Mozilla/5.0 (X11; Linux x86_64)"), "Linux");
  assert.equal(normalizeOsFamily("unrecognized-client"), "Other");
});

test("snapshots expose only anonymous public fields, mark online, and count them", () => {
  const rows = [
    { id: "good", region: "KR", os: "Windows", latitude: 36, longitude: 128, firstSeen: "t0", lastSeen: "t1", secret: "no" },
    { id: "ghost", region: "IT", latitude: 42, longitude: 12, firstSeen: "t0", lastSeen: "t1" },
    { id: "bad", region: "bad", latitude: 190, longitude: 0, firstSeen: "t0", lastSeen: "t1" },
  ];
  const snapshot = buildSnapshot(rows, new Set(["good"]), Date.parse("2026-07-21T12:00:00Z"));
  assert.equal(snapshot.type, "snapshot");
  assert.equal(snapshot.nodes.length, 2);
  assert.deepEqual(Object.keys(snapshot.nodes[0]).sort(), ["appVersion", "firstSeen", "id", "lastSeen", "latitude", "longitude", "online", "os", "region"]);
  assert.equal(snapshot.nodes.find((node) => node.id === "good").os, "Windows");
  assert.equal(snapshot.nodes.find((node) => node.id === "good").online, true);
  assert.equal(snapshot.nodes.find((node) => node.id === "ghost").online, false);
  assert.deepEqual(snapshot.counts, { total: 2, online: 1 });
});

test("public node shape carries no leaked fields", () => {
  const node = publicNode({ id: "n", region: "EU", os: "Linux", latitude: 48, longitude: 9, first_seen: "a", last_seen: "b", github_login: "leak" }, true);
  assert.deepEqual(Object.keys(node).sort(), ["appVersion", "firstSeen", "id", "lastSeen", "latitude", "longitude", "online", "os", "region"]);
  assert.equal(node.os, "Linux");
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
    assert.equal(change.node.region, "KR · Seoul");
    assert.equal(change.node.online, true);
    assert.notEqual(change.node.latitude, 37.5665);
    assert.deepEqual(Object.keys(change.node).sort(), ["appVersion", "firstSeen", "id", "lastSeen", "latitude", "longitude", "online", "os", "region"]);
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

test("coarse OS family persists when a recorded installation goes offline", async () => {
  await withService(async (mf) => {
    const presence = await connect(mf, "presence", KR, "windows-node", "Windows");
    const viewer = await connect(mf, "viewer");
    const online = await nextMessage(viewer);
    assert.equal(online.nodes[0].os, "Windows");
    const update = nextMessage(viewer);
    presence.close(1000, "offline");
    const change = await update;
    assert.equal(change.node.online, false);
    assert.equal(change.node.os, "Windows");

    const later = await connect(mf, "viewer");
    const snapshot = await nextMessage(later);
    assert.equal(snapshot.nodes[0].online, false);
    assert.equal(snapshot.nodes[0].os, "Windows");
    later.close(1000, "done");
    viewer.close(1000, "done");
  });
});

test("the same installation reconnecting stays one recorded node", async () => {
  await withService(async (mf) => {
    const first = await connect(mf, "presence", KR, "stable");
    first.close(1000, "invisible");
    const second = await connect(mf, "presence", { ...KR, city: "Busan", latitude: "35.1796", longitude: "129.0756" }, "stable");
    const viewer = await connect(mf, "viewer");
    const snapshot = await nextMessage(viewer);
    assert.equal(snapshot.counts.total, 1);
    assert.equal(snapshot.nodes.length, 1);
    assert.equal(snapshot.nodes[0].id, "stable");
    assert.equal(snapshot.nodes[0].region, "KR · Busan");
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

test("a connection without a stable id is online-only and never recorded", async () => {
  await withService(async (mf) => {
    const viewer = await connect(mf, "viewer");
    await nextMessage(viewer);
    const update = nextMessage(viewer);
    const presence = await connect(mf, "presence", KR); // no stable id — legacy client
    const change = await update;
    assert.equal(change.type, "upsert");
    assert.equal(change.node.online, true);
    // Online counts the live socket; total counts recorded installations only.
    assert.deepEqual(change.counts, { total: 0, online: 1 });
    // A fresh viewer sees the ephemeral node while it is connected.
    const during = await connect(mf, "viewer");
    const snapshotDuring = await nextMessage(during);
    assert.equal(snapshotDuring.nodes.length, 1);
    assert.deepEqual(snapshotDuring.counts, { total: 0, online: 1 });
    const removal = nextMessage(viewer);
    presence.close(1000, "gone");
    const removed = await removal;
    assert.equal(removed.type, "remove");
    assert.deepEqual(removed.counts, { total: 0, online: 0 });
    during.close(1000, "done");
    viewer.close(1000, "done");
  });
});

test("repeated no-id reconnects never grow the recorded total", async () => {
  await withService(async (mf) => {
    for (let round = 0; round < 3; round += 1) {
      const presence = await connect(mf, "presence", KR);
      presence.close(1000, "flap");
    }
    const viewer = await connect(mf, "viewer");
    const snapshot = await nextMessage(viewer);
    assert.deepEqual(snapshot.counts, { total: 0, online: 0 });
    assert.deepEqual(snapshot.nodes, []);
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
  assert.match(source, /ALTER TABLE nodes ADD COLUMN os TEXT NOT NULL DEFAULT 'Other'/);
  assert.match(source, /os = excluded\.os/);
  assert.match(source, /acceptWebSocket/);
  assert.match(config, /new_sqlite_classes/);
  // Regression pins for the additive-count bug: only stable ids are recorded,
  // and the v2 migration purged the per-connection random-id duplicates.
  assert.match(source, /const ephemeral = !stableId/);
  assert.match(source, /schema_version', '3'/);
  // The release column must be added WITHOUT bumping schema_version, which
  // deletes every recorded node.
  assert.match(source, /ALTER TABLE nodes ADD COLUMN app_version TEXT NOT NULL DEFAULT ''/);
  assert.doesNotMatch(source, /schema_version', '[4-9]'/);
});

test("the app release is recorded, broadcast, and refreshed on reconnect", async () => {
  await withService(async (mf) => {
    const viewer = await connect(mf, "viewer");
    await nextMessage(viewer);

    const upsert = nextMessage(viewer);
    const first = await connect(mf, "presence", KR, "release-node", "Linux", "1.0.5");
    assert.equal((await upsert).node.appVersion, "1.0.5");

    const ghost = nextMessage(viewer);
    first.close();
    assert.equal((await ghost).node.online, false, "sign-off is the socket close, not a timeout");

    // Reconnecting after an update refreshes the release on the SAME node.
    const updated = nextMessage(viewer);
    const second = await connect(mf, "presence", KR, "release-node", "Linux", "1.0.6");
    assert.equal((await updated).node.appVersion, "1.0.6");

    const snapshot = await (async () => {
      const observer = await connect(mf, "viewer");
      return nextMessage(observer);
    })();
    const nodes = snapshot.nodes.filter((node) => node.id === "release-node");
    assert.equal(nodes.length, 1, "one install stays one recorded node across releases");
    assert.equal(nodes[0].appVersion, "1.0.6");
    second.close();
    viewer.close();
  });
});

test("a hostile version string cannot smuggle anything onto the map", async () => {
  await withService(async (mf) => {
    const viewer = await connect(mf, "viewer");
    await nextMessage(viewer);
    const upsert = nextMessage(viewer);
    const socket = await connect(mf, "presence", IT, "hostile-node", "Windows", "<script>1.0.6</script>");
    assert.equal((await upsert).node.appVersion, "script1.0.6script");
    socket.close();
    viewer.close();
  });
});
