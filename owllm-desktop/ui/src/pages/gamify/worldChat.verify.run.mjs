// World Chat — the invariants that must not silently regress.
//
// The behavioural proof lives in services/world-presence/test/chat.test.mjs
// (real Durable Object, real Ed25519). This gate pins the properties that a
// behavioural test cannot see because they are about what the code is ALLOWED
// to do at all:
//
//   * a node id is only ever accepted when it is derived from the presented
//     signing key — the map's ids are public, so an inbox keyed on an
//     unverified id is readable by anyone who can read the map;
//   * presence without chat presents no key, so the anonymous map is unchanged;
//   * the relay stores ciphertext and never a plaintext message body;
//   * the three implementations of the domain separators agree byte for byte;
//   * chat history never reaches localStorage, which broadcasts every write to
//     every other renderer.
//
// Reports EVERY failure rather than throwing on the first, so one regression
// cannot mask the rest.

import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1)));
const UI = path.resolve(HERE, "../../..");
const ROOT = path.resolve(HERE, "../../../../..");
const SERVICE = path.join(ROOT, "services/world-presence/src");
const TAURI = path.join(ROOT, "owllm-desktop/src-tauri/src");

const failures = [];
let checks = 0;

function check(label, condition, detail = "") {
  checks += 1;
  if (!condition) failures.push(detail ? `${label} — ${detail}` : label);
}

function read(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch { return ""; }
}

/**
 * Code only. A "must not appear" check has to ignore prose, or the comment
 * explaining the rule becomes a violation of it.
 */
function codeOnly(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** A missing file is a failed check, never a crash that hides the rest. */
function source(label, file) {
  const text = read(file);
  check(`${label} exists`, text.length > 0, `expected a file at ${file}`);
  return text;
}

const chatJs = source("service chat module", path.join(SERVICE, "chat.js"));
const indexJs = source("service worker", path.join(SERVICE, "index.js"));
const worldChatTs = source("client chat store", path.join(UI, "src/pages/gamify/worldChat.ts"));
const runtimeTs = source("client chat runtime", path.join(UI, "src/pages/gamify/worldChatRuntime.ts"));
const presenceTs = source("presence client", path.join(UI, "src/pages/gamify/worldPresence.ts"));
const panelTsx = source("chat panel", path.join(UI, "src/pages/gamify/WorldChatPanel.tsx"));
const mapTsx = source("world map page", path.join(UI, "src/pages/gamify/WorldMapPage.tsx"));
const rustChat = source("rust chat commands", path.join(TAURI, "remote_devices/world_chat.rs"));
const rustIdentity = source("rust identity", path.join(TAURI, "remote_devices/identity.rs"));
const libRs = source("tauri command registry", path.join(TAURI, "lib.rs"));

// ------------------------------------------------------------------
// 1. Identity is derived, never asserted
// ------------------------------------------------------------------

check("the service derives a chat id from the presented key",
  /presenceIdFromEdPub/.test(chatJs) && /crypto\.subtle\.verify/.test(chatJs) && /Ed25519/.test(chatJs));

check("a claimed id that does not match the key is refused",
  /auth_identity_mismatch/.test(indexJs),
  "an id is only proof of ownership when the server re-derives it from the key");

check("the derived id is compared against the id the socket connected with",
  /verdict\.chatId !== String\(data\.id/.test(indexJs));

check("the challenge nonce is server-generated, not client-supplied",
  /randomNonce\(\)/.test(chatJs) && /nonce = wantsChat \? randomNonce\(\)/.test(indexJs));

check("chat traffic is refused before authentication",
  /not_authenticated/.test(indexJs));

check("the signature is domain-separated",
  /CHAT_AUTH_DOMAIN/.test(chatJs) && /CHAT_AUTH_DOMAIN/.test(rustChat));

check("Rust refuses to sign anything that is not a relay challenge",
  /is_ascii_hexdigit/.test(rustChat) && /nonce\.len\(\) != 64/.test(rustChat),
  "otherwise the signing command is an oracle for attacker-chosen bytes");

// ------------------------------------------------------------------
// 2. The anonymous map is unchanged unless the user opts in
// ------------------------------------------------------------------

check("no challenge is issued unless the client asks for chat",
  /searchParams\.get\("chat"\) === "1"/.test(indexJs));

check("the client only asks for chat when it is enabled",
  /chat\) url\.searchParams\.set\("chat", "1"\)/.test(presenceTs));

check("chat hooks are absent while chat is off",
  /if \(!worldChatEnabled\(\)\) return undefined/.test(runtimeTs));

check("being messageable by strangers is opt-in",
  /peer_not_reachable/.test(indexJs) && /reachable/.test(chatJs));

check("an unrecorded (no-id) connection can never carry chat",
  /&& !ephemeral/.test(indexJs),
  "an ephemeral dot has no stable identity to bind an inbox to");

// ------------------------------------------------------------------
// 3. The relay never holds readable messages
// ------------------------------------------------------------------

check("message bodies are only length-checked, never parsed",
  chatJs.length > 0 && indexJs.length > 0
  && /sanitizeBox/.test(chatJs) && !/JSON\.parse\(\s*box/.test(indexJs));

check("the offline queue stores the sealed body",
  /INSERT INTO inbox/.test(indexJs) && /body TEXT NOT NULL/.test(indexJs));

check("sealing and opening stay in Rust, where the private keys are",
  /crypto::seal/.test(rustChat) && /crypto::open/.test(rustChat));

check("a group message is sealed once per member rather than shared with the relay",
  /room_send/.test(indexJs) && /boxes/.test(indexJs) && /sayToRoom/.test(worldChatTs));

check("the room id is a hash of the invite secret, which never leaves the client",
  /ROOM_DOMAIN/.test(worldChatTs) && /roomIdFromInvite/.test(worldChatTs));

check("a sender is attributed from the signed envelope, not the relay's label",
  /opened\.from !== claimed/.test(worldChatTs),
  "otherwise a relay could put anyone's name on any message");

// ------------------------------------------------------------------
// 4. Consent, refusal, and abuse limits actually exist
// ------------------------------------------------------------------

for (const [label, needle] of [
  ["consent is required before ordinary messages", "not_a_contact"],
  ["blocking is enforced server-side", "peer_blocked"],
  ["reporting exists", "chat_report"],
  ["a flood window bounds one identity's sends", "rate_limited"],
  ["first contact is quota-bounded", "request_quota_exhausted"],
  ["room membership is enforced", "not_a_member"],
]) check(label, new RegExp(needle).test(indexJs));

check("enough reports remove stranger reach",
  /REPORT_SUSPEND_THRESHOLD/.test(indexJs) && /UPDATE peers SET reachable = 0/.test(indexJs));

check("blocking also drops what that peer already queued",
  /DELETE FROM inbox WHERE to_id = \? AND from_id = \?/.test(indexJs));

// ------------------------------------------------------------------
// 5. Storage discipline
// ------------------------------------------------------------------

check("chat state is added without a schema_version bump",
  /createChatTables/.test(indexJs) && !/schema_version', '4'/.test(indexJs),
  "bumping schema_version deletes every recorded node");

check("the offline queue is bounded and expires",
  /MAX_INBOX_PER_PEER/.test(indexJs) && /INBOX_TTL_MS/.test(indexJs));

// Negated checks must also require the file to be present, otherwise a deleted
// or moved module would read as "clean" instead of as a failure.
check("message history is never written to localStorage",
  runtimeTs.length > 0 && worldChatTs.length > 0
  && !/localStorage[\s\S]{0,80}(threads|messages|history)/i.test(codeOnly(runtimeTs))
  && !/localStorage/.test(codeOnly(worldChatTs)),
  "history is rewritten constantly and would be broadcast to every renderer");

check("only small scalars are persisted",
  /WORLD_CHAT_ENABLED_KEY/.test(runtimeTs) && /WORLD_CHAT_NICK_KEY/.test(runtimeTs));

// ------------------------------------------------------------------
// 6. The three implementations agree, and the UI is actually mounted
// ------------------------------------------------------------------

function literal(text, name) {
  const line = text.split(/\r?\n/).find((row) => row.includes(name) && row.includes('"'));
  if (!line) return null;
  const start = line.indexOf('"');
  const end = line.lastIndexOf('"');
  return end > start ? line.slice(start + 1, end) : null;
}

const authJs = literal(chatJs, "CHAT_AUTH_DOMAIN");
const authRs = literal(rustChat, "CHAT_AUTH_DOMAIN");
check("the auth domain matches between the service and Rust", Boolean(authJs) && authJs === authRs,
  `service=${JSON.stringify(authJs)} rust=${JSON.stringify(authRs)}`);

const presenceJs = literal(chatJs, "PRESENCE_DOMAIN");
const presenceRs = literal(rustIdentity, "PRESENCE_DOMAIN");
check("the presence domain matches between the service and Rust", Boolean(presenceJs) && presenceJs === presenceRs,
  `service=${JSON.stringify(presenceJs)} rust=${JSON.stringify(presenceRs)}`);

for (const command of ["world_chat_sign", "world_chat_seal", "world_chat_open"]) {
  check(`${command} is registered with Tauri`, new RegExp(`world_chat::${command}`).test(libRs));
}

check("the chat panel is mounted on the World Map", /<WorldChatPanel/.test(mapTsx));
check("a fleet dot is addressed by its presence id, not its device id",
  /fleetPresenceIds\.get\(selected\.id\)/.test(mapTsx),
  "chatting to a raw device id would address a dot the relay has never heard of");
check("the panel offers accept, block and report on a request",
  /WorldChat:accept/.test(panelTsx) && /WorldChat:block/.test(panelTsx) && /WorldChat:report/.test(panelTsx));
check("the panel exposes the reachable opt-in", /WorldChat:reachable/.test(panelTsx));
check("the thread uses the shared sticky-scroll hook", /useStickyScroll/.test(panelTsx));

// ------------------------------------------------------------------
// 7. Execute the real helpers, rather than only reading them
// ------------------------------------------------------------------

// An unloadable module is a failed check, not a stack trace that hides every
// other finding.
let chat = null;
try { chat = await import(new URL("../../../../../services/world-presence/src/chat.js", import.meta.url)); }
catch (reason) { check("the service chat module can be imported", false, String(reason).slice(0, 120)); }

if (chat) {

  check("a non-hex id is rejected", chat.sanitizeChatId("z".repeat(64)) === "");
  check("a short id is rejected", chat.sanitizeChatId("a".repeat(63)) === "");
  check("an id is normalized to lowercase hex", chat.sanitizeChatId("A".repeat(64)) === "a".repeat(64));
  check("an oversized body is refused rather than truncated", chat.sanitizeBox("x".repeat(24_001)) === "");
  check("control characters cannot be smuggled into a nickname",
    chat.sanitizeNick("Ada ‮evil") === "Adaevil");

  const derived = await chat.presenceIdFromEdPub(new Uint8Array(32).fill(7));
  check("a 32-byte key derives a 64-hex id", /^[0-9a-f]{64}$/.test(derived));
  check("a malformed key derives nothing", (await chat.presenceIdFromEdPub(new Uint8Array(31))) === "");

  const windows = new Map();
  for (let index = 0; index < chat.SEND_WINDOW_LIMIT; index += 1) chat.allowSend(windows, "peer", 1_000);
  check("the flood window closes after its limit", chat.allowSend(windows, "peer", 1_000) === false);
  check("the flood window reopens", chat.allowSend(windows, "peer", 1_000 + chat.SEND_WINDOW_MS) === true);

  // A signature over the wrong nonce must not authenticate.
  const badNonce = await chat.verifyPresenceAuth({ nonce: "nope", publicKey: "", signature: "" });
  check("a malformed nonce is refused", badNonce.ok === false && badNonce.error === "auth_nonce_invalid");
  const badKey = await chat.verifyPresenceAuth({ nonce: "a".repeat(64), publicKey: "AAAA", signature: "AAAA" });
  check("a malformed key is refused", badKey.ok === false && badKey.error === "auth_key_invalid");
}

if (failures.length) {
  console.error(`world chat verification: ${failures.length} of ${checks} checks FAILED`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`world chat verification: ${checks}/${checks} checks passed`);
