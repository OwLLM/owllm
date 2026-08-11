// World Chat identity — "use your GitHub name and picture?"
//
// A map of dots labelled OW-3F91A2 is not a conversation, and nobody opens a
// settings pane to name themselves. So the chat ASKS, once, and only of someone
// who already has a GitHub account connected. The properties that must not
// regress:
//
//   * the question is asked in the chat, naming the account, with both answers;
//   * it is asked ONLY once — either answer is remembered across restarts;
//   * "yes" adopts the login and the picture without further typing;
//   * "no" is not a one-way door, and it withdraws an adopted identity;
//   * a picture may come from GitHub's avatar CDN and from nowhere else —
//     an arbitrary URL rendered by our renderer is a beacon, not an avatar;
//   * the picture reaches the other side: it is published on the socket, kept
//     by the relay, and handed back with every peer lookup and room roster;
//   * peers, the inbox, the thread and the chrome notice all draw it.
//
// The protocol half is executed for real (esbuild), because a source-text check
// cannot tell an accepted URL from a rejected one. The panel, the runtime and
// the relay are pinned by source — they need a DOM, Tauri and a Durable Object.
//
// Reports EVERY failure rather than throwing on the first.

import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1)));
const UI = path.resolve(HERE, "../../..");
const REPO = path.resolve(UI, "../..");

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

// --- the question ----------------------------------------------------------

const panel = read(path.join(UI, "src/pages/gamify/WorldChatPanel.tsx"));
check("the chat panel exists", panel.length > 0);
check("the chat asks about the GitHub identity",
  /data-ui="WorldChat:github-ask"/.test(panel));
check("the question is worded as a question",
  /Use your GitHub name and picture here\?/.test(panel));
check("the question names the connected account",
  /github\.login/.test(panel));
check("the question shows the picture it is offering",
  /WorldChat:github-ask[\s\S]{0,600}?<ChatAvatar src=\{github\.avatar\}/.test(panel));
check("both answers are offered",
  /data-ui="WorldChat:github-yes"/.test(panel) && /data-ui="WorldChat:github-no"/.test(panel));
// Asked of someone with no GitHub account, the question has no answer that
// helps: it would just be a dead prompt on every launch.
check("the question is only asked when an account is connected",
  /github && githubChoice === ""/.test(panel));
check("an answer is recorded, not just applied to the form",
  /applyGithubChatIdentity\(choice, github\)/.test(panel));
// "No thanks" must not be a door that locks behind you.
check("the choice can be changed later from the settings row",
  /data-ui="WorldChat:github-toggle"/.test(panel));

// --- the pictures are actually drawn ---------------------------------------

check("a picture (or its initial) is drawn",
  /data-ui="WorldChat:avatar"/.test(panel));
check("the inbox rows draw the sender's picture",
  /<ChatAvatar src=\{entry\.avatar\}/.test(panel));
check("each message draws whose it is",
  /WorldChat:message-meta[\s\S]{0,400}?<ChatAvatar/.test(panel));
check("the open conversation draws the other person",
  /WorldChat:thread-title[\s\S]{0,400}?<ChatAvatar/.test(panel));
// A missing picture must still occupy the same circle, or every row shifts
// depending on who happens to have published one.
check("someone without a picture still gets a circle",
  /chatAvatarInitial/.test(panel));

const appShell = read(path.join(UI, "src/AppShell.tsx"));
check("the chrome notice carries the sender's picture",
  /data-ui="WorldChatNotice:avatar"/.test(appShell));
check("the notice's picture comes from the conversation, not from a guess",
  /avatar: newest\.avatar/.test(appShell));

// --- the runtime: remembered, reversible, published ------------------------

const runtime = read(path.join(UI, "src/pages/gamify/worldChatRuntime.ts"));
check("the answer is persisted", /WORLD_CHAT_GITHUB_KEY = "owllm:world-chat:github"/.test(runtime));
check("the picture is persisted", /WORLD_CHAT_AVATAR_KEY = "owllm:world-chat:avatar"/.test(runtime));
// Two-state storage cannot express "not asked yet", so it could only ever
// default to asking again — or to never asking at all.
check("unanswered is distinct from answered-no",
  /stored === "yes" \|\| stored === "no" \? stored : ""/.test(runtime));
check("the account is read from the app, not typed in",
  /invoke<[^>]*>\("github_status"\)/.test(runtime));
check("\"yes\" adopts the name and picture without further typing",
  /choice === "yes"[\s\S]{0,200}?saveWorldChatProfile\(identity\.login, worldChatReachable\(\), identity\.avatar\)/.test(runtime));
check("\"no\" withdraws an identity that was previously adopted",
  /worldChatNick\(\) === identity\.login \|\| worldChatAvatar\(\) === identity\.avatar/.test(runtime));
check("the picture is published with this device's profile",
  /profile: \(\) => \(\{ nick: worldChatNick\(\), avatar: worldChatAvatar\(\)/.test(runtime));

const presence = read(path.join(UI, "src/pages/gamify/worldPresence.ts"));
check("the picture is sent when the socket proves who we are",
  /avatar: profile\.avatar/.test(presence));

// --- the relay keeps and returns it ----------------------------------------

const relayChat = read(path.join(REPO, "services/world-presence/src/chat.js"));
const relayIndex = read(path.join(REPO, "services/world-presence/src/index.js"));
check("the relay sanitizes pictures", /export function sanitizeAvatar/.test(relayChat));
check("the relay pins the picture host to GitHub's avatar CDN",
  /AVATAR_HOST = "avatars\.githubusercontent\.com"/.test(relayChat));
check("the relay hands the picture back with every peer",
  /avatar: sanitizeAvatar\(row\?\.avatar\)/.test(relayChat));
check("the relay stores the picture at sign-in",
  /INSERT INTO peers \(chat_id, ed_pub, x_pub, nick, avatar, reachable/.test(relayIndex));
check("the relay updates the picture on a profile change",
  /UPDATE peers SET nick = \?, avatar = \?/.test(relayIndex));
// CREATE TABLE IF NOT EXISTS does nothing to an object that already has the
// table, so without this every existing relay would reject the new column.
check("existing relays gain the column instead of losing their peers",
  /ALTER TABLE peers ADD COLUMN avatar TEXT NOT NULL DEFAULT ''/.test(relayIndex));

// --- the protocol, executed ------------------------------------------------

let esbuild = null;
try { esbuild = await import("esbuild"); }
catch (reason) { check("esbuild is available to run the protocol", false, String(reason).slice(0, 120)); }

if (esbuild) {
  try {
    const built = await esbuild.build({
      entryPoints: [path.join(UI, "src/pages/gamify/worldChat.ts")],
      bundle: true, write: false, format: "esm", platform: "neutral",
    });
    const chat = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

    // A picture URL is chosen by the other side and then fetched by OUR
    // renderer. Anything but the avatar CDN is a beacon with an image on it.
    check("a GitHub avatar is accepted",
      chat.sanitizeChatAvatar("https://avatars.githubusercontent.com/ruigro?size=64")
        === "https://avatars.githubusercontent.com/ruigro?size=64");
    for (const hostile of [
      "https://evil.example.com/track.png",
      "http://avatars.githubusercontent.com/x",
      "https://avatars.githubusercontent.com.evil.example/x",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      `https://avatars.githubusercontent.com/${"a".repeat(400)}`,
      42,
      null,
    ]) {
      check(`a picture from ${String(hostile).slice(0, 48)} is refused`,
        chat.sanitizeChatAvatar(hostile) === "", JSON.stringify(chat.sanitizeChatAvatar(hostile)));
    }
    check("the GitHub picture URL is built from the login",
      chat.githubAvatarUrl("ruigro").startsWith("https://avatars.githubusercontent.com/ruigro"));
    check("a login with URL punctuation cannot escape the host",
      new URL(chat.githubAvatarUrl("a/../../evil")).hostname === "avatars.githubusercontent.com",
      chat.githubAvatarUrl("a/../../evil"));
    check("someone with no picture falls back to an initial",
      chat.chatAvatarInitial("ruigro") === "R" && chat.chatAvatarInitial("OW-3F91A2") === "3"
      && chat.chatAvatarInitial("") === "?");

    const store = chat.createWorldChatStore({
      crypto: { seal: async () => "box", open: async () => ({ from: "peer-a", text: "hi" }) },
      onChange: () => {},
      now: () => "2026-01-01T00:00:00.000Z",
    });
    store.onFrame({
      type: "chat_peers",
      ids: ["peer-a", "peer-b"],
      peers: [
        { id: "peer-a", nick: "A", avatar: "https://avatars.githubusercontent.com/a", xPub: "x", edPub: "e", reachable: true },
        { id: "peer-b", nick: "B", avatar: "https://evil.example.com/beacon.png", xPub: "x", edPub: "e", reachable: true },
      ],
    });
    check("a peer's GitHub picture is kept",
      store.state().peers["peer-a"]?.avatar === "https://avatars.githubusercontent.com/a",
      JSON.stringify(store.state().peers["peer-a"]));
    check("a peer's hostile picture is dropped, and the peer still works",
      store.state().peers["peer-b"]?.avatar === "" && store.state().peers["peer-b"]?.nick === "B",
      JSON.stringify(store.state().peers["peer-b"]));

    // The same filtering has to hold on the room path, which builds peers
    // through its own branch.
    store.onFrame({
      type: "room_roster",
      room: "r",
      members: [{ id: "peer-c", nick: "C", avatar: "https://evil.example.com/x.png", xPub: "x", edPub: "e", reachable: true }],
    });
    check("a room member's hostile picture is dropped too",
      store.state().peers["peer-c"]?.avatar === "");

    store.onFrame({ type: "chat_ready", id: "self", nick: "me", avatar: "https://avatars.githubusercontent.com/me", reachable: true });
    check("our own published picture comes back on sign-in",
      store.state().avatar === "https://avatars.githubusercontent.com/me", store.state().avatar);
    store.onFrame({ type: "chat_profile_ok", nick: "me", avatar: "https://evil.example.com/me.png", reachable: true });
    check("even the relay cannot hand us a picture from elsewhere",
      store.state().avatar === "");

    const sent = [];
    store.setTransport((value) => { sent.push(value); return true; });
    store.setProfile("me", true, "https://avatars.githubusercontent.com/me");
    check("saving the profile publishes the picture",
      sent.some((frame) => frame.type === "chat_profile" && frame.avatar === "https://avatars.githubusercontent.com/me"),
      JSON.stringify(sent));
    store.setProfile("me", true, "https://evil.example.com/me.png");
    check("a hostile picture is not published either",
      sent.filter((frame) => frame.type === "chat_profile").at(-1)?.avatar === "");

    store.onFrame({ type: "chat_message", id: 3, from: "peer-a", box: "box" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const conversations = chat.worldChatConversations(store.state());
    check("the inbox row carries the sender's picture",
      conversations.find((entry) => entry.key === "peer-a")?.avatar === "https://avatars.githubusercontent.com/a",
      JSON.stringify(conversations));
  } catch (reason) {
    check("the chat protocol can be executed", false, String(reason).slice(0, 300));
  }
}

if (failures.length) {
  console.error(`world chat GitHub identity verification: ${failures.length}/${checks} checks FAILED`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`world chat GitHub identity verification: ${checks}/${checks} checks passed`);
