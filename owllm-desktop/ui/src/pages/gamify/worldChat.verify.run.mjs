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
// The original rule here was "history never reaches localStorage", justified as
// "it would be broadcast to every renderer". That justification belongs to the
// SHARED state mirror, which really does replicate every write across windows,
// processes and devices — localStorage is per-renderer and silent. History is
// now kept, because a chat that forgets every line on quit is not a chat, so
// the invariant is restated as what actually protects the machine: it must not
// reach the broadcasting store, and it must stay bounded.
check("chat history never reaches the shared/broadcasting state store",
  runtimeTs.length > 0 && worldChatTs.length > 0
  && !/stateMirror|vaultSync|pageSettings/.test(codeOnly(runtimeTs))
  && !/stateMirror|vaultSync|pageSettings|localStorage/.test(codeOnly(worldChatTs)),
  "replicating a thread per keystroke costs every other window and device");

check("history is only serialized when the conversation actually moved",
  /state\.threads\s*!==\s*snapshot\.threads/.test(codeOnly(runtimeTs)),
  "status and peer-lookup churn every few seconds; serializing on those is waste");

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
check("the panel exposes the reachable toggle", /WorldChat:reachable/.test(panelTsx));
check("the thread uses the shared sticky-scroll hook", /useStickyScroll/.test(panelTsx));

// ------------------------------------------------------------------
// 6a. It has to read as a conversation, not a settings form
// ------------------------------------------------------------------
// The card shipped as a nickname row, a reachability checkbox, a Save button,
// an invite box and a Join button stacked above a ONE-LINE input and a button
// labelled "Ask" — so the surface was mostly setup and the part you actually
// talk with was the smallest thing on it. Each of these guards one of those.

const composerAt = panelTsx.indexOf('data-ui="WorldChat:draft"');
const composerTagAt = panelTsx.lastIndexOf("<", composerAt);
check("the composer is a multi-line textarea, not a one-line input",
  panelTsx.slice(composerTagAt, composerAt).includes("textarea"),
  "a single-line input cannot hold a message worth sending");
check("Enter sends and Shift+Enter keeps writing",
  /event\.key === "Enter" && !event\.shiftKey/.test(panelTsx));
check('the send button never says "Ask"',
  !/t\("Ask"\)/.test(panelTsx),
  "'Ask' made the user wonder what they were asking for");

check("profile and group setup are folded behind a toggle",
  /data-ui="WorldChat:settings"/.test(panelTsx) && /settingsOpen && \(/.test(panelTsx),
  "setup controls must not outweigh the conversation");
// Anchor on the opening of the folded block AND its close. Comparing against a
// bare indexOf would read -1 as "before everything" when the block is absent,
// so every control would score as folded on a card that folds nothing.
const settingsAt = panelTsx.search(/\{!collapsed && settingsOpen && \(/);
const settingsEndsAt = panelTsx.indexOf("\n      )}", settingsAt);
check("the folded settings block is a complete element",
  settingsAt > 0 && settingsEndsAt > settingsAt,
  `open=${settingsAt} close=${settingsEndsAt}`);
for (const folded of ["WorldChat:nick", "WorldChat:invite", "WorldChat:join", "WorldChat:save-profile"]) {
  const at = panelTsx.indexOf(`data-ui="${folded}"`);
  check(`${folded} lives inside the folded settings block`,
    settingsAt > 0 && at > settingsAt && at < settingsEndsAt,
    `at=${at} block=${settingsAt}..${settingsEndsAt}`);
}

// The card floats over the globe and takes pointer events, so while it is open
// it is also a hole in the map — every dot behind it is unclickable, which the
// user experiences as "the chat is stuck on whoever I picked first".
check("the chat card can be folded away to free the globe underneath",
  /data-ui="WorldChat:collapse"/.test(panelTsx) && /setCollapsed\(\(value\) => !value\)/.test(panelTsx),
  "with no way to fold it, dots behind the card can never be selected");
check("the conversation body is gated on the card being open",
  /\{!collapsed && \(/.test(panelTsx),
  "a collapse that leaves the body rendered frees no space at all");
check("picking a new dot re-opens a folded card",
  /setCollapsed\(false\)/.test(panelTsx),
  "silently re-addressing a folded card is worse than not changing it");
check("the overlay does not span most of the globe",
  /width: "min\(3\d\dpx, [1-4]\d%\)"/.test(mapTsx),
  "the wider the card, the more of the map is unreachable");

check("an empty thread explains what to do instead of showing a blank box",
  /data-ui="WorldChat:thread-empty"/.test(panelTsx));
check("the thread is given real height rather than collapsing to nothing",
  /minHeight: 1\d\d/.test(panelTsx.slice(panelTsx.indexOf('data-ui="WorldChat:thread"'))));

// ------------------------------------------------------------------
// 6b. Chat lives on the canvas, and a click on a dot is the send action
// ------------------------------------------------------------------

// The chat card must sit inside the globe <section>, top-right, rather than in
// the side rail: the dot you click and the box you type in have to be one
// glance apart. Containment is only visible from here as position-in-file, so
// anchor on the overlay marker and the section tag that closes after it.
const overlayAt = mapTsx.indexOf('data-ui="WorldMap:top-right"');
const panelAt = mapTsx.indexOf("<WorldChatPanel");
const sectionEndsAt = mapTsx.indexOf("</section>");
check("the chat card is inside the globe canvas, not the side rail",
  overlayAt > 0 && panelAt > overlayAt && sectionEndsAt > panelAt,
  `overlay=${overlayAt} panel=${panelAt} sectionEnd=${sectionEndsAt}`);
check("the chat card is anchored to the TOP RIGHT of the canvas",
  /data-ui="WorldMap:top-right"[\s\S]{0,400}?position: "absolute"[\s\S]{0,200}?top: 13, right: 13/.test(mapTsx));
check("the overlay column is click-through so a drag still orbits the globe",
  /data-ui="WorldMap:top-right"[\s\S]{0,600}?pointerEvents: "none"/.test(mapTsx));
check("the chat card itself still takes clicks",
  /pointerEvents: "auto"[\s\S]{0,200}?<WorldChatPanel/.test(mapTsx));
check("only one chat card is mounted",
  mapTsx.split("<WorldChatPanel").length - 1 === 1,
  "two cards would mean two carets and two drafts for the same thread");

check("selecting a dot puts the caret in the message box",
  // Focus moved into its own effect once the card became collapsible: the box
  // does not exist to receive the caret until the expanded body has rendered.
  /draftRef\.current\?\.focus\(\);[\s\S]{0,80}?\}, \[enabled, collapsed, openRoom, target\]\)/.test(panelTsx)
  && /ref=\{draftRef\}/.test(panelTsx),
  "clicking a user IS the 'message them' action; there is no second button");
check("focus is never stolen without a selection",
  /if \(!enabled \|\| openRoom \|\| !target\) return;/.test(panelTsx),
  "target starts empty, so merely opening the map must not grab the caret");

// ------------------------------------------------------------------
// 6c. The panel must not let the user send to a node that cannot receive
// ------------------------------------------------------------------

check("the panel detects when the selected dot is the user's own",
  /const isSelf = Boolean\(target && target === chat\.selfId\)/.test(panelTsx),
  "messaging yourself only produces a confusing server error");
check("the panel checks that a peer has published chat keys",
  /const hasKeys = Boolean\(peer\?\.edPub && peer\?\.xPub\)/.test(panelTsx),
  "without keys there is nothing to seal a message to");
check("the composer is hidden for the user's own dot",
  /!isSelf/.test(panelTsx) && /\(openRoom \|\| hasKeys\)/.test(panelTsx));
check("the panel explains why a node cannot be messaged",
  /data-ui="WorldChat:hint"/.test(panelTsx));
check("chat errors are surfaced as readable text",
  /chatErrorText/.test(worldChatTs) && /chat_request_invalid/.test(worldChatTs));
// A bare /catch \(reason\)[\s\S]*?commit\(\{ error:/ would match the unrelated
// decode catch that has always been there, so count the seal-failure handlers
// themselves: request, say and sayToRoom must each report instead of dropping.
check("a seal failure is reported instead of silently dropping the message",
  (worldChatTs.match(/\} catch \(reason\) \{\s*commit\(\{ error: chatErrorText\(String\(reason\)\) \}\);\s*\}/g) || []).length >= 3,
  "sealFor throws when a peer has no keys — all three send paths must surface that");

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

// ------------------------------------------------------------------
// 8. Chat is ON out of the box — measured by running the real module
// ------------------------------------------------------------------
//
// Static text cannot tell a default apart from a coincidence, so this loads the
// real worldChatRuntime with a working localStorage and asks it. The deps it
// pulls in (Tauri, the device list, the store) are stubbed: none of them are
// consulted to answer "is chat on".

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    reads: 0,
    getItem(key) { this.reads += 1; return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
    raw: map,
  };
}

const runtimeStubs = {
  name: "world-chat-runtime-stubs",
  setup(build) {
    // worldChat.ts is deliberately NOT stubbed: it has no imports of its own,
    // and the history round-trip below has to exercise the real sanitizer —
    // a stubbed one would only prove the stub works.
    build.onResolve({ filter: /(@tauri-apps\/api\/core|remoteDevices|\/worldPresence)$/ },
      (args) => ({ path: args.path, namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      loader: "js",
      contents: `export const invoke = async () => "";
           export const getIdentity = async () => ({});
           export const listDevices = async () => [];
           export const presenceNodeIdForDevice = async () => "";`,
    }));
  },
};

/** A fresh module instance over the given storage — i.e. an app restart. */
async function bootRuntime(storage, tag) {
  const built = await esbuild.build({
    entryPoints: [path.join(UI, "src/pages/gamify/worldChatRuntime.ts")],
    bundle: true, write: false, format: "esm", platform: "neutral",
    plugins: [runtimeStubs],
  });
  globalThis.localStorage = storage;
  return import(`data:text/javascript;base64,${Buffer.from(`${built.outputFiles[0].text}\n//${tag}`).toString("base64")}`);
}

let esbuild = null;
try { esbuild = await import("esbuild"); }
catch (reason) { check("esbuild is available to run the runtime", false, String(reason).slice(0, 120)); }

if (esbuild) {
  const previousStorage = globalThis.localStorage;
  try {
    // --- out of the box -------------------------------------------------
    const fresh = fakeStorage();
    const first = await bootRuntime(fresh, "fresh");
    check("World Chat is ON for a user who has never chosen", first.worldChatEnabled() === true,
      "a map of dots you cannot talk to is a poster");
    check("strangers may open a conversation out of the box", first.worldChatReachable() === true);
    check("the default is read from storage, not hardcoded", fresh.reads > 0,
      "a check that never consults storage would pass even if the toggle were ignored");

    // --- the user's own choice wins, in both directions ------------------
    first.setWorldChatEnabled(false);
    check("turning it off is persisted as an explicit no", fresh.raw.get(first.WORLD_CHAT_ENABLED_KEY) === "0");
    check("turning it off is obeyed", first.worldChatEnabled() === false);

    const afterRestart = await bootRuntime(fresh, "restart");
    check("an explicit off survives a restart and is not re-defaulted on",
      afterRestart.worldChatEnabled() === false,
      "'never chosen' and 'switched off' must not read as the same value");

    afterRestart.setWorldChatEnabled(true);
    check("turning it back on is obeyed", afterRestart.worldChatEnabled() === true);
    check("turning it back on is persisted", fresh.raw.get(afterRestart.WORLD_CHAT_ENABLED_KEY) === "1");

    const shy = await bootRuntime(fakeStorage({ "owllm:world-chat:reachable": "0" }), "shy");
    check("an explicit 'do not let strangers ask' is obeyed", shy.worldChatReachable() === false);
    check("...while chat itself stays on", shy.worldChatEnabled() === true);

    // --- the presence socket must actually carry it ----------------------
    check("chat hooks exist by default, so the socket asks for a challenge",
      Boolean(shy.worldChatHooks()),
      "a default that never reaches the socket is a default in name only");

    // --- conversations survive a restart, measured across two instances ---
    const kept = fakeStorage();
    const before = await bootRuntime(kept, "before-restart");
    before.saveWorldChatThreads({
      "peer-a": [{ id: 4, kind: "message", from: "peer-a", room: "", text: "hello", ts: "t", mine: false }],
    });
    const after = await bootRuntime(kept, "after-restart");
    const restored = after.loadWorldChatThreads();
    check("a conversation is still there after a restart",
      restored["peer-a"]?.[0]?.text === "hello",
      "the relay only replays what it still holds undelivered, so this is the client's job");
    check("restored lines keep which side sent them",
      restored["peer-a"][0].mine === false && restored["peer-a"][0].id === 4);

    // A store that keeps garbage would crash the panel that renders it, and
    // storage is user-writable and outlives any single app version.
    const junk = fakeStorage({ "owllm:world-chat:threads": '{"peer-b":[{"text":""},7,null,{"text":"ok"}]}' });
    const salvaged = (await bootRuntime(junk, "junk")).loadWorldChatThreads();
    check("malformed stored history is salvaged, not fatal",
      salvaged["peer-b"]?.length === 1 && salvaged["peer-b"][0].text === "ok");
    const corrupt = fakeStorage({ "owllm:world-chat:threads": "{not json" });
    check("unparseable stored history yields an empty history",
      Object.keys((await bootRuntime(corrupt, "corrupt")).loadWorldChatThreads()).length === 0);

    // Storage that grows without bound eventually throws on write and takes the
    // whole history with it, so the restore path must cap what it accepts.
    const flood = fakeStorage({
      "owllm:world-chat:threads": JSON.stringify({
        "peer-c": Array.from({ length: 640 }, (_, index) => ({ id: index + 1, text: `line ${index}` })),
      }),
    });
    const capped = (await bootRuntime(flood, "flood")).loadWorldChatThreads()["peer-c"];
    check("restored history is capped, keeping the most recent lines",
      capped.length === 500 && capped[capped.length - 1].text === "line 639",
      `restored ${capped.length}`);

    // Turning chat off must leave nothing behind, not an empty husk.
    const cleared = fakeStorage({ "owllm:world-chat:threads": '{"p":[{"text":"x"}]}' });
    (await bootRuntime(cleared, "cleared")).saveWorldChatThreads({});
    check("an emptied history is removed from storage",
      cleared.raw.has("owllm:world-chat:threads") === false);
  } catch (reason) {
    check("the chat runtime can be executed", false, String(reason).slice(0, 200));
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
}

if (failures.length) {
  console.error(`world chat verification: ${failures.length} of ${checks} checks FAILED`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`world chat verification: ${checks}/${checks} checks passed`);
