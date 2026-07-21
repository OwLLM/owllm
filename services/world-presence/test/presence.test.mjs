import assert from "node:assert/strict";
import test from "node:test";
import { coarseLocation, createMemoryPresenceStore, handlePresenceRequest } from "../src/index.js";

const NOW = Date.parse("2026-07-21T12:00:00.000Z");

function locatedRequest(method, token = "") {
  const request = new Request("https://presence.example/v1/presence", {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  Object.defineProperty(request, "cf", {
    value: { country: "KR", regionCode: "11", latitude: "37.5665", longitude: "126.9780" },
  });
  return request;
}

async function body(response) {
  return response.status === 204 ? null : response.json();
}

test("coarse location is stable, bounded, and does not expose exact coordinates", () => {
  const first = coarseLocation({ country: "KR", regionCode: "11", latitude: 37.5665, longitude: 126.978 }, "node-a");
  const second = coarseLocation({ country: "KR", regionCode: "11", latitude: 37.5665, longitude: 126.978 }, "node-a");
  assert.deepEqual(first, second);
  assert.equal(first.region, "KR · 11");
  assert.notEqual(first.latitude, 37.5665);
  assert.notEqual(first.longitude, 126.978);
  assert.ok(first.latitude >= -85 && first.latitude <= 85);
  assert.ok(first.longitude >= -180 && first.longitude <= 180);
});

test("anonymous heartbeat issues a token and refreshes one public node", async () => {
  const store = createMemoryPresenceStore();
  const runtime = { now: () => NOW };
  const createdResponse = await handlePresenceRequest(locatedRequest("POST"), store, runtime);
  const created = await body(createdResponse);
  assert.equal(createdResponse.status, 200);
  assert.match(created.token, /^[a-f0-9]{64}$/);
  assert.equal(Object.keys(created.node).sort().join(","), "id,lastSeen,latitude,longitude,region");
  assert.equal(store.records.size, 1);

  const refreshedResponse = await handlePresenceRequest(locatedRequest("POST", created.token), store, { now: () => NOW + 60_000 });
  const refreshed = await body(refreshedResponse);
  assert.equal(refreshed.token, created.token);
  assert.equal(refreshed.node.id, created.node.id);
  assert.equal(store.records.size, 1);
});

test("snapshot contains active public fields only and expiry removes stale nodes", async () => {
  const store = createMemoryPresenceStore();
  const created = await body(await handlePresenceRequest(locatedRequest("POST"), store, { now: () => NOW }));
  const live = await body(await handlePresenceRequest(new Request("https://presence.example/v1/presence"), store, { now: () => NOW + 10 * 60_000 }));
  assert.equal(live.nodes.length, 1);
  assert.equal(live.nodes[0].id, created.node.id);
  assert.equal(Object.hasOwn(live.nodes[0], "token"), false);

  const expired = await body(await handlePresenceRequest(new Request("https://presence.example/v1/presence"), store, { now: () => NOW + 16 * 60_000 }));
  assert.equal(expired.nodes.length, 0);
  assert.equal(store.records.size, 0);
});

test("delete is immediate, authenticated by opaque token, and idempotent", async () => {
  const store = createMemoryPresenceStore();
  const created = await body(await handlePresenceRequest(locatedRequest("POST"), store, { now: () => NOW }));
  assert.equal(store.records.size, 1);
  const deleted = await handlePresenceRequest(new Request("https://presence.example/v1/presence", {
    method: "DELETE",
    headers: { Authorization: `Bearer ${created.token}` },
  }), store, { now: () => NOW });
  assert.equal(deleted.status, 204);
  assert.equal(store.records.size, 0);
});

test("new anonymous nodes are capacity-bounded", async () => {
  const store = createMemoryPresenceStore();
  store.count = async () => 5_000;
  const response = await handlePresenceRequest(locatedRequest("POST"), store, { now: () => NOW });
  assert.equal(response.status, 429);
  assert.deepEqual(await body(response), { error: "presence_capacity_reached" });
});

test("service exposes CORS preflight and rejects missing edge geolocation", async () => {
  const store = createMemoryPresenceStore();
  const preflight = await handlePresenceRequest(new Request("https://presence.example/v1/presence", { method: "OPTIONS" }), store);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "*");
  assert.match(preflight.headers.get("Access-Control-Allow-Headers"), /Authorization/);

  const unavailable = await handlePresenceRequest(new Request("https://presence.example/v1/presence", { method: "POST" }), store);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await body(unavailable), { error: "coarse_location_unavailable" });
});

test("source never reads or stores IP or client identity fields", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/index.js", import.meta.url), "utf8"));
  assert.doesNotMatch(source, /CF-Connecting-IP|x-forwarded-for|github|device_name|project|prompt/i);
  assert.match(source, /sha256\(token/);
});
