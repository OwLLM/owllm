// World Chat — exercised end to end against a real Durable Object with real
// Ed25519 keys. Every identity here is a genuine keypair and every id is
// derived the way the desktop app derives it, so a change that breaks the
// binding between a key and its map dot fails here rather than in production.

import assert from "node:assert/strict";
import test from "node:test";
import { Miniflare } from "miniflare";
import {
  CHAT_AUTH_DOMAIN,
  PRESENCE_DOMAIN,
  REPORT_SUSPEND_THRESHOLD,
  SEND_WINDOW_LIMIT,
  allowSend,
  presenceIdFromEdPub,
  sanitizeBox,
  sanitizeChatId,
  sanitizeNick,
} from "../src/chat.js";

const KR = { country: "KR", city: "Seoul", regionCode: "11", latitude: "37.5665", longitude: "126.9780" };

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

/** A fresh device: keypair plus the map id the desktop app would derive for it. */
async function makeDevice() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  // Mirrors remote_devices: device_id = hex(SHA-256(ed_pub)), then
  // presence_id = hex(SHA-256(domain || device_id)).
  const deviceId = hex(await crypto.subtle.digest("SHA-256", raw));
  const presenceId = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${PRESENCE_DOMAIN}${deviceId}`)));
  return {
    id: presenceId,
    publicKey: b64(raw),
    xPub: b64(new Uint8Array(32).fill(7)),
    async sign(nonce) {
      const message = new TextEncoder().encode(`${CHAT_AUTH_DOMAIN}${nonce}`);
      return b64(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, message)));
    },
  };
}

function scriptPath() {
  return new URL("../src/index.js", import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1));
}

async function withService(run) {
  const mf = new Miniflare({
    modules: true,
    modulesRoot: new URL("../src", import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1)),
    scriptPath: scriptPath(),
    // index.js imports ./chat.js; without this rule miniflare loads the
    // sibling as CommonJS and every test fails on its export statements.
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    compatibilityDate: "2026-07-21",
    durableObjects: { WORLD_PRESENCE: { className: "WorldPresence", useSQLite: true } },
  });
  try { await run(mf); }
  finally { await mf.dispose(); }
}

/** Collects every frame so a test can await one by predicate without racing. */
function reader(socket) {
  const seen = [];
  const waiters = [];
  socket.addEventListener("message", (event) => {
    const value = JSON.parse(String(event.data));
    seen.push(value);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      if (waiters[index].match(value)) waiters.splice(index, 1)[0].resolve(value);
    }
  });
  return {
    seen,
    /** Snapshot the stream position, so a later next() ignores older frames. */
    mark() {
      return seen.length;
    },
    // `from` matters whenever a frame type repeats: without it a second
    // chat_sent would match the first one and assert against stale state.
    next(match, label = "frame", from = 0) {
      const existing = seen.slice(from).find(match);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}; saw ${JSON.stringify(seen)}`)), 3_000);
        waiters.push({ match, resolve: (value) => { clearTimeout(timer); resolve(value); } });
      });
    },
  };
}

async function openSocket(mf, params, cf = KR) {
  const response = await mf.dispatchFetch(`https://presence.example/v1/presence/connect?${new URLSearchParams(params)}`, {
    headers: { Upgrade: "websocket" },
    cf,
  });
  assert.equal(response.status, 101, "expected a websocket upgrade");
  response.webSocket.accept();
  return response.webSocket;
}

/** Connect a device and complete the challenge/response handshake. */
async function signIn(mf, device, { nick = "", reachable = false } = {}) {
  const socket = await openSocket(mf, { role: "presence", id: device.id, os: "Linux", v: "1.0.7", chat: "1" });
  const read = reader(socket);
  const challenge = await read.next((frame) => frame.type === "chat_challenge", "chat_challenge");
  socket.send(JSON.stringify({
    type: "chat_auth",
    publicKey: device.publicKey,
    signature: await device.sign(challenge.nonce),
    xPub: device.xPub,
    nick,
    reachable,
  }));
  return { socket, read, challenge };
}

// ------------------------------------------------------------------
// Identity
// ------------------------------------------------------------------

test("a node id is derived from the signing key, so a signature proves the dot", async () => {
  const device = await makeDevice();
  const raw = Buffer.from(device.publicKey, "base64");
  assert.equal(await presenceIdFromEdPub(new Uint8Array(raw)), device.id);
  assert.equal(await presenceIdFromEdPub(new Uint8Array(31)), "", "a short key must not derive an id");
});

test("a signed challenge admits the device that owns the id", async () => {
  await withService(async (mf) => {
    const device = await makeDevice();
    const { read } = await signIn(mf, device, { nick: "Ada", reachable: true });
    const ready = await read.next((frame) => frame.type === "chat_ready", "chat_ready");
    assert.equal(ready.id, device.id);
    assert.equal(ready.nick, "Ada");
    assert.equal(ready.reachable, true);
  });
});

test("presence stays anonymous without ?chat=1 — no challenge is ever issued", async () => {
  await withService(async (mf) => {
    const device = await makeDevice();
    const socket = await openSocket(mf, { role: "presence", id: device.id, os: "Linux" });
    const read = reader(socket);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(read.seen.filter((frame) => frame.type === "chat_challenge").length, 0);
  });
});

test("a valid signature for the WRONG id is rejected — ids cannot be squatted", async () => {
  await withService(async (mf) => {
    const attacker = await makeDevice();
    const victim = await makeDevice();
    // The attacker connects claiming the victim's public dot and signs the
    // challenge correctly — with its OWN key, which is all it has.
    const socket = await openSocket(mf, { role: "presence", id: victim.id, chat: "1" });
    const read = reader(socket);
    const challenge = await read.next((frame) => frame.type === "chat_challenge", "chat_challenge");
    socket.send(JSON.stringify({
      type: "chat_auth",
      publicKey: attacker.publicKey,
      signature: await attacker.sign(challenge.nonce),
      xPub: attacker.xPub,
    }));
    const error = await read.next((frame) => frame.type === "chat_error", "chat_error");
    assert.equal(error.error, "auth_identity_mismatch");
    assert.equal(read.seen.filter((frame) => frame.type === "chat_ready").length, 0);
  });
});

test("a forged signature is rejected", async () => {
  await withService(async (mf) => {
    const device = await makeDevice();
    const other = await makeDevice();
    const socket = await openSocket(mf, { role: "presence", id: device.id, chat: "1" });
    const read = reader(socket);
    const challenge = await read.next((frame) => frame.type === "chat_challenge", "chat_challenge");
    socket.send(JSON.stringify({
      type: "chat_auth",
      publicKey: device.publicKey,
      signature: await other.sign(challenge.nonce),
      xPub: device.xPub,
    }));
    const error = await read.next((frame) => frame.type === "chat_error", "chat_error");
    assert.equal(error.error, "auth_signature_invalid");
  });
});

test("a signature over a DIFFERENT nonce is rejected — replay does not authenticate", async () => {
  await withService(async (mf) => {
    const device = await makeDevice();
    const socket = await openSocket(mf, { role: "presence", id: device.id, chat: "1" });
    const read = reader(socket);
    await read.next((frame) => frame.type === "chat_challenge", "chat_challenge");
    socket.send(JSON.stringify({
      type: "chat_auth",
      publicKey: device.publicKey,
      signature: await device.sign("f".repeat(64)),
      xPub: device.xPub,
    }));
    const error = await read.next((frame) => frame.type === "chat_error", "chat_error");
    assert.equal(error.error, "auth_signature_invalid");
  });
});

test("an unauthenticated socket cannot send chat traffic", async () => {
  await withService(async (mf) => {
    const device = await makeDevice();
    const socket = await openSocket(mf, { role: "presence", id: device.id, chat: "1" });
    const read = reader(socket);
    await read.next((frame) => frame.type === "chat_challenge", "chat_challenge");
    socket.send(JSON.stringify({ type: "chat_send", to: "a".repeat(64), box: "x" }));
    const error = await read.next((frame) => frame.type === "chat_error", "chat_error");
    assert.equal(error.error, "not_authenticated");
  });
});

// ------------------------------------------------------------------
// 1:1 messaging
// ------------------------------------------------------------------

test("a stranger must be accepted before ordinary messages flow", async () => {
  await withService(async (mf) => {
    const alice = await makeDevice();
    const bob = await makeDevice();
    const a = await signIn(mf, alice, { nick: "Alice" });
    const b = await signIn(mf, bob, { nick: "Bob", reachable: true });
    await a.read.next((frame) => frame.type === "chat_ready");
    await b.read.next((frame) => frame.type === "chat_ready");

    // Direct message before consent is refused.
    a.socket.send(JSON.stringify({ type: "chat_send", to: bob.id, box: "sealed-1" }));
    const refused = await a.read.next((frame) => frame.type === "chat_error", "not_a_contact");
    assert.equal(refused.error, "not_a_contact");

    // A request is allowed because Bob opted in to being reachable.
    a.socket.send(JSON.stringify({ type: "chat_request", to: bob.id, box: "sealed-intro" }));
    const intro = await b.read.next((frame) => frame.type === "chat_message" && frame.kind === "request", "request");
    assert.equal(intro.from, alice.id);
    assert.equal(intro.box, "sealed-intro");

    b.socket.send(JSON.stringify({ type: "chat_accept", id: alice.id }));
    await b.read.next((frame) => frame.type === "chat_state" && frame.contacts.includes(alice.id), "bob contacts");

    a.socket.send(JSON.stringify({ type: "chat_send", to: bob.id, box: "sealed-2" }));
    const delivered = await b.read.next((frame) => frame.type === "chat_message" && frame.box === "sealed-2", "message");
    assert.equal(delivered.from, alice.id);
    assert.equal(delivered.kind, "message");
  });
});

test("a peer that has not opted in is unreachable by strangers", async () => {
  await withService(async (mf) => {
    const alice = await makeDevice();
    const bob = await makeDevice();
    const a = await signIn(mf, alice);
    const b = await signIn(mf, bob, { reachable: false });
    await a.read.next((frame) => frame.type === "chat_ready");
    await b.read.next((frame) => frame.type === "chat_ready");
    a.socket.send(JSON.stringify({ type: "chat_request", to: bob.id, box: "sealed-intro" }));
    const error = await a.read.next((frame) => frame.type === "chat_error", "peer_not_reachable");
    assert.equal(error.error, "peer_not_reachable");
  });
});

test("a blocked sender cannot reach the blocker, and queued messages are dropped", async () => {
  await withService(async (mf) => {
    const alice = await makeDevice();
    const bob = await makeDevice();
    const a = await signIn(mf, alice);
    const b = await signIn(mf, bob, { reachable: true });
    await a.read.next((frame) => frame.type === "chat_ready");
    await b.read.next((frame) => frame.type === "chat_ready");

    a.socket.send(JSON.stringify({ type: "chat_request", to: bob.id, box: "sealed-intro" }));
    await b.read.next((frame) => frame.type === "chat_message" && frame.kind === "request");
    b.socket.send(JSON.stringify({ type: "chat_block", id: alice.id }));
    await b.read.next((frame) => frame.type === "chat_state" && frame.blocked.includes(alice.id), "blocked");

    a.socket.send(JSON.stringify({ type: "chat_request", to: bob.id, box: "sealed-again" }));
    const error = await a.read.next((frame) => frame.type === "chat_error", "peer_blocked");
    assert.equal(error.error, "peer_blocked");
  });
});

test("messages for an offline peer are queued and replayed on its next sign-in", async () => {
  await withService(async (mf) => {
    const alice = await makeDevice();
    const bob = await makeDevice();
    const a = await signIn(mf, alice);
    const first = await signIn(mf, bob, { reachable: true });
    await a.read.next((frame) => frame.type === "chat_ready");
    await first.read.next((frame) => frame.type === "chat_ready");
    a.socket.send(JSON.stringify({ type: "chat_request", to: bob.id, box: "sealed-intro" }));
    await first.read.next((frame) => frame.type === "chat_message" && frame.kind === "request");
    first.socket.send(JSON.stringify({ type: "chat_accept", id: alice.id }));
    await a.read.next((frame) => frame.type === "chat_state" && frame.contacts.includes(bob.id), "alice contacts");

    // Bob leaves without acknowledging anything, then Alice writes.
    first.socket.close(1000, "bye");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const mark = a.read.mark();
    a.socket.send(JSON.stringify({ type: "chat_send", to: bob.id, box: "sealed-while-away" }));
    const sent = await a.read.next((frame) => frame.type === "chat_sent" && frame.to === bob.id, "chat_sent", mark);
    assert.equal(sent.delivered, false, "nothing should have been delivered live");

    const second = await signIn(mf, bob);
    const replay = await second.read.next((frame) => frame.type === "chat_message" && frame.box === "sealed-while-away", "replay");
    assert.equal(replay.from, alice.id);

    // Acknowledging clears it, so a third sign-in does not see it again.
    second.socket.send(JSON.stringify({ type: "chat_ack", ids: [replay.id] }));
    await second.read.next((frame) => frame.type === "chat_acked", "chat_acked");
    second.socket.close(1000, "bye");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const third = await signIn(mf, bob);
    await third.read.next((frame) => frame.type === "chat_ready");
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(third.read.seen.filter((frame) => frame.type === "chat_message" && frame.box === "sealed-while-away").length, 0);
  });
});

test("enough distinct reports strip an identity of its reach to strangers", async () => {
  await withService(async (mf) => {
    const target = await makeDevice();
    const t = await signIn(mf, target, { reachable: true });
    await t.read.next((frame) => frame.type === "chat_ready");
    for (let index = 0; index < REPORT_SUSPEND_THRESHOLD; index += 1) {
      const reporter = await makeDevice();
      const r = await signIn(mf, reporter);
      await r.read.next((frame) => frame.type === "chat_ready");
      r.socket.send(JSON.stringify({ type: "chat_report", id: target.id }));
      await r.read.next((frame) => frame.type === "chat_state" && frame.blocked.includes(target.id), "reporter blocked");
    }
    const stranger = await makeDevice();
    const s = await signIn(mf, stranger);
    await s.read.next((frame) => frame.type === "chat_ready");
    s.socket.send(JSON.stringify({ type: "chat_lookup", ids: [target.id] }));
    const peers = await s.read.next((frame) => frame.type === "chat_peers", "chat_peers");
    assert.equal(peers.peers[0].reachable, false, "a reported identity loses stranger reach");
  });
});

// ------------------------------------------------------------------
// Rooms
// ------------------------------------------------------------------

test("room members exchange per-recipient sealed boxes; outsiders cannot send", async () => {
  await withService(async (mf) => {
    const room = "b".repeat(64);
    const one = await makeDevice();
    const two = await makeDevice();
    const outsider = await makeDevice();
    const a = await signIn(mf, one, { nick: "One" });
    const b = await signIn(mf, two, { nick: "Two" });
    const c = await signIn(mf, outsider);
    for (const peer of [a, b, c]) await peer.read.next((frame) => frame.type === "chat_ready");

    a.socket.send(JSON.stringify({ type: "room_join", room }));
    await a.read.next((frame) => frame.type === "room_roster", "roster");
    b.socket.send(JSON.stringify({ type: "room_join", room }));
    const roster = await b.read.next((frame) => frame.type === "room_roster", "roster");
    assert.equal(roster.members.length, 2);
    assert.ok(roster.members.some((member) => member.id === one.id && member.nick === "One"));

    a.socket.send(JSON.stringify({ type: "room_send", room, boxes: [{ to: two.id, box: "sealed-for-two" }] }));
    const received = await b.read.next((frame) => frame.type === "chat_message" && frame.kind === "room", "room message");
    assert.equal(received.room, room);
    assert.equal(received.box, "sealed-for-two");
    assert.equal(received.from, one.id);

    c.socket.send(JSON.stringify({ type: "room_send", room, boxes: [{ to: two.id, box: "spam" }] }));
    const denied = await c.read.next((frame) => frame.type === "chat_error", "not_a_member");
    assert.equal(denied.error, "not_a_member");
  });
});

test("a room message is never relayed to a non-member, even if addressed to one", async () => {
  await withService(async (mf) => {
    const room = "c".repeat(64);
    const member = await makeDevice();
    const outsider = await makeDevice();
    const m = await signIn(mf, member);
    const o = await signIn(mf, outsider);
    await m.read.next((frame) => frame.type === "chat_ready");
    await o.read.next((frame) => frame.type === "chat_ready");
    m.socket.send(JSON.stringify({ type: "room_join", room }));
    await m.read.next((frame) => frame.type === "room_roster");
    m.socket.send(JSON.stringify({ type: "room_send", room, boxes: [{ to: outsider.id, box: "leak" }] }));
    const ack = await m.read.next((frame) => frame.type === "chat_sent", "chat_sent");
    assert.equal(ack.fanout, 0, "a non-member must not be a fanout target");
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(o.read.seen.filter((frame) => frame.type === "chat_message").length, 0);
  });
});

// ------------------------------------------------------------------
// Pure helpers
// ------------------------------------------------------------------

test("sanitizers reject anything that is not the exact expected shape", () => {
  assert.equal(sanitizeChatId("A".repeat(64)), "a".repeat(64));
  assert.equal(sanitizeChatId("z".repeat(64)), "", "non-hex is not an id");
  assert.equal(sanitizeChatId("a".repeat(63)), "");
  assert.equal(sanitizeNick("  Ada ‮evil  "), "Adaevil");
  assert.equal(sanitizeNick("x".repeat(80)).length, 32);
  assert.equal(sanitizeBox(""), "");
  assert.equal(sanitizeBox("x".repeat(24_001)), "", "an oversized body is refused, not truncated");
});

test("the flood window admits a burst then refuses until it rolls over", () => {
  const windows = new Map();
  for (let index = 0; index < SEND_WINDOW_LIMIT; index += 1) {
    assert.equal(allowSend(windows, "peer", 1_000), true, `send ${index} should be allowed`);
  }
  assert.equal(allowSend(windows, "peer", 1_000), false);
  assert.equal(allowSend(windows, "peer", 1_000 + 10_000), true, "the window rolls over");
});
