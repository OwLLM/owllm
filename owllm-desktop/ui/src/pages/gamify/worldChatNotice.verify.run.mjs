// World Chat push notice — the owl announces an arriving message.
//
// A chat you only hear about while you happen to be looking at the World Map
// is not a chat, so an incoming line raises a notice on the app chrome. The
// properties that must not regress:
//
//   * the store tells its host about a message from someone else;
//   * it does NOT announce our own echoes — we typed those;
//   * it does NOT announce a relay replay of a line already in the thread,
//     which would pop the bubble twice for one message;
//   * the runtime turns that into a window event, so any page can hear it;
//   * the chrome renders the bubble and clears it again.
//
// The store half is executed for real (esbuild + a fake crypto), because a
// source-text check cannot tell "fires once" from "fires twice". The chrome
// half is pinned by source, because AppShell cannot be mounted here.
//
// Reports EVERY failure rather than throwing on the first.

import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1)));
const UI = path.resolve(HERE, "../../..");

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

// --- the chrome: the bubble exists, and it is wired to the event -----------

const appShell = read(path.join(UI, "src/AppShell.tsx"));
check("AppShell exists", appShell.length > 0);
// The chrome subscribes to the inbox rather than to the arrival event: an
// event fires once and is gone, so a notice built on it could not survive a
// page change or a restart with the message still unread.
check("the chrome watches the inbox",
  /subscribeWorldChat\(\(state\) =>/.test(appShell));
check("a chat bubble is rendered beside the owl",
  /data-ui="WorldChatNotice"/.test(appShell));
check("the bubble says a message arrived",
  /Got a message/.test(appShell));
check("the bubble names the sender",
  /chatNotice\.label/.test(appShell));
// A notice on a dwell timer took the message with it: you were left knowing
// something had arrived, with no way back to it.
check("the notice is NOT dismissed by a timer",
  !/setTimeout\([^)]*setChatNotice/.test(appShell));
check("the notice is derived from the unread counts",
  /worldChatUnreadCount\(state\)/.test(appShell) && /subscribeWorldChat\(/.test(appShell));
check("the notice is passed to the header",
  /chatNotice=\{chatNotice\}/.test(appShell));
check("clicking the bubble opens that very conversation",
  /const openChatNotice = \(\) => \{[\s\S]{0,200}?openWorldChatThread\(chatNotice\.key\)/.test(appShell));
// The placement must survive prefers-reduced-motion, which drops the animation.
check("the bubble's position is a style, not a keyframe",
  /data-ui="WorldChatNotice"[\s\S]{0,700}?transform: "translateX\(/.test(appShell));

// --- the store: fires once, for other people's lines only ------------------

let esbuild = null;
try { esbuild = await import("esbuild"); }
catch (reason) { check("esbuild is available to run the store", false, String(reason).slice(0, 120)); }

if (esbuild) {
  try {
    const built = await esbuild.build({
      entryPoints: [path.join(UI, "src/pages/gamify/worldChat.ts")],
      bundle: true, write: false, format: "esm", platform: "neutral",
    });
    const module = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

    const seen = [];
    const store = module.createWorldChatStore({
      crypto: {
        seal: async (_ed, _x, text) => `box:${text}`,
        // The envelope carries its own verified sender; the box is the text.
        open: async (envelope) => ({ from: "peer-a", text: String(envelope).replace(/^box:/, "") }),
      },
      onChange: () => {},
      onIncoming: (message) => seen.push(message),
      now: () => "2026-01-01T00:00:00.000Z",
    });

    store.onFrame({ type: "chat_message", id: 7, from: "peer-a", box: "box:hello" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    check("an arriving message is announced",
      seen.length === 1 && seen[0].text === "hello" && seen[0].from === "peer-a",
      `announced ${seen.length}: ${JSON.stringify(seen)}`);
    check("the announced message is not marked as ours", seen[0]?.mine === false);

    // A reconnect replays anything the relay still holds unacknowledged.
    store.onFrame({ type: "chat_message", id: 7, from: "peer-a", box: "box:hello" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    check("a replayed message is not announced twice",
      seen.length === 1, `announced ${seen.length} times`);

    // Our own outgoing line lands in the same thread, and must stay silent.
    store.setTransport(() => true);
    store.onFrame({
      type: "chat_peers",
      peers: [{ id: "peer-a", nick: "A", xPub: "x", edPub: "e", reachable: true }],
    });
    await store.say("peer-a", "mine");
    check("our own message is not announced", seen.length === 1, `announced ${seen.length}`);

    // --- the inbox: unread survives, and only reading clears it -------------
    check("the arriving message left an unread count",
      store.state().unread["peer-a"] === 1, JSON.stringify(store.state().unread));
    check("our own reply did not raise the unread count",
      store.state().unread["peer-a"] === 1);

    const conversations = module.worldChatConversations(store.state());
    check("the conversation appears in the inbox",
      conversations.length === 1 && conversations[0].key === "peer-a",
      JSON.stringify(conversations.map((entry) => entry.key)));
    check("the inbox row carries the label, the last line and its time",
      conversations[0]?.label === "A"
      && conversations[0]?.last?.text === "mine"
      && Boolean(conversations[0]?.last?.ts),
      JSON.stringify(conversations[0]));
    check("the inbox row reports how many are unread", conversations[0]?.unread === 1);
    check("the unread total is summed across conversations",
      module.worldChatUnreadCount(store.state()) === 1);

    store.markRead("peer-a");
    check("reading the conversation clears its unread count",
      module.worldChatUnreadCount(store.state()) === 0, JSON.stringify(store.state().unread));
    check("the history itself is NOT cleared by reading it",
      (store.state().threads["peer-a"] ?? []).length === 2,
      String((store.state().threads["peer-a"] ?? []).length));

    // Restored from disk on the next launch: a missed message stays missed.
    const restored = module.createWorldChatStore({
      crypto: { seal: async () => "", open: async () => ({ from: "", text: "" }) },
      onChange: () => {},
      initialThreads: { "peer-a": [{ id: 9, kind: "message", from: "peer-a", room: "", text: "hi", ts: "2026-01-01T00:00:00.000Z", mine: false }] },
      initialUnread: { "peer-a": 3, "bad": 0, "worse": -2 },
    });
    check("unread counts survive a restart",
      restored.state().unread["peer-a"] === 3, JSON.stringify(restored.state().unread));
    check("a junk unread count is dropped rather than rendered",
      restored.state().unread.bad === undefined && restored.state().unread.worse === undefined);
    check("the restored history is browsable",
      module.worldChatConversations(restored.state())[0]?.last?.text === "hi");
  } catch (reason) {
    check("the chat store can be executed", false, String(reason).slice(0, 200));
  }
}

// --- the runtime: the bridge from store to window --------------------------

const runtime = read(path.join(UI, "src/pages/gamify/worldChatRuntime.ts"));
check("the runtime exports the event name",
  /export const WORLD_CHAT_MESSAGE_EVENT = "owllm:world-chat:message"/.test(runtime));
check("the runtime subscribes to incoming messages",
  /onIncoming: \(message\) => announceIncoming\(message\)/.test(runtime));
check("the runtime dispatches the event on the window",
  /dispatchEvent\(new CustomEvent\(WORLD_CHAT_MESSAGE_EVENT/.test(runtime));
check("unread counts are persisted, not just held in memory",
  /WORLD_CHAT_UNREAD_KEY/.test(runtime)
  && /saveWorldChatUnread\(state\.unread\)/.test(runtime)
  && /initialUnread: restoredUnread/.test(runtime));
check("the runtime can open one conversation from anywhere",
  /export function openWorldChatThread/.test(runtime)
  && /WORLD_CHAT_OPEN_EVENT/.test(runtime));
check("subscribing restores the saved inbox even before the map is opened",
  /export function subscribeWorldChat[\s\S]{0,400}?worldChatStore\(\);/.test(runtime));

// --- the panel: a real chat, not a one-shot notice -------------------------

const panel = read(path.join(UI, "src/pages/gamify/WorldChatPanel.tsx"));
check("WorldChatPanel exists", panel.length > 0);
check("the panel lists every conversation",
  /data-ui="WorldChat:inbox"/.test(panel) && /worldChatConversations\(chat\)/.test(panel));
check("each conversation row is clickable and shows its unread count",
  /data-ui="WorldChat:conversation"/.test(panel) && /data-ui="WorldChat:unread"/.test(panel));
check("a conversation can be opened without finding its dot on the globe",
  /const \[pickedPeer, setPickedPeer\] = useState\(""\)/.test(panel)
  && /pickedPeer \|\| selectedNodeId/.test(panel));
check("the panel opens the conversation the notice points at",
  /addEventListener\(WORLD_CHAT_OPEN_EVENT/.test(panel));
check("looking at a thread marks it read",
  /store\.markRead\(key\)/.test(panel));
check("every message shows who said it and when",
  /data-ui="WorldChat:message-meta"/.test(panel) && /messageStamp\(message\.ts\)/.test(panel));
check("an older message is stamped with its date, not just a clock time",
  /sameDay \? clock :/.test(panel));

if (failures.length) {
  console.error(`world chat notice verification: ${failures.length} of ${checks} checks FAILED`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`world chat notice verification: ${checks}/${checks} checks passed`);
