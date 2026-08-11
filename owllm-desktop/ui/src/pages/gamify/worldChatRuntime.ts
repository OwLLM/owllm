// One World Chat client per running app, wired to the native keys.
//
// It is a module singleton on purpose. The inbox has to outlive the World Map
// page — pages unmount on every tab switch, and an inbox that only exists while
// you are looking at it is not an inbox. The presence socket that carries it is
// already app-wide, so the two have the same lifetime.
//
// On/off, nickname and reachability are persisted, and so is the conversation
// history — a chat that forgets every line on quit is not a chat, and the relay
// only ever replays what it still holds *undelivered*. History goes to
// localStorage deliberately: it is per-renderer and silent, unlike the shared
// state store, which would broadcast every keystroke's worth of thread to every
// other window and process on the machine.

import { invoke } from "@tauri-apps/api/core";

import { getIdentity, listDevices } from "../advanced/remoteDevices";
import {
  createWorldChatStore,
  emptyWorldChatState,
  githubAvatarUrl,
  sanitizeChatAvatar,
  sanitizeWorldChatThreads,
  sanitizeWorldChatUnread,
  threadKey,
  worldChatLabel,
  type WorldChatMessage,
  type WorldChatState,
  type WorldChatStore,
} from "./worldChat";
import { presenceNodeIdForDevice, type WorldChatHooks } from "./worldPresence";

export const WORLD_CHAT_ENABLED_KEY = "owllm:world-chat:enabled";
export const WORLD_CHAT_NICK_KEY = "owllm:world-chat:nick";
export const WORLD_CHAT_AVATAR_KEY = "owllm:world-chat:avatar";
/** The answer to the "use your GitHub name and picture?" question. */
export const WORLD_CHAT_GITHUB_KEY = "owllm:world-chat:github";
export const WORLD_CHAT_REACHABLE_KEY = "owllm:world-chat:reachable";
export const WORLD_CHAT_THREADS_KEY = "owllm:world-chat:threads";
export const WORLD_CHAT_UNREAD_KEY = "owllm:world-chat:unread";

/**
 * Fired on the window whenever a message arrives from someone else, so the app
 * chrome can announce it from anywhere — the World Map is one tab among many,
 * and a chat you only hear about while you are looking at it is not a chat.
 * A window event and not the shared state store on purpose: this is a
 * per-renderer nudge, not data other processes should be woken for.
 */
export const WORLD_CHAT_MESSAGE_EVENT = "owllm:world-chat:message";

export type WorldChatMessageEventDetail = {
  from: string;
  /** Nickname when the sender is already known, else their short id. */
  label: string;
  room: string;
  text: string;
  ts: string;
  /** The thread this line belongs to, so a notice can open exactly it. */
  key: string;
};

/**
 * Asks the World Map to open one conversation. Raised by the chrome's notice:
 * "you have a message" is only useful if the thing it points at is the message,
 * so the notice carries the thread and the panel opens it.
 */
export const WORLD_CHAT_OPEN_EVENT = "owllm:world-chat:open";

export type WorldChatOpenEventDetail = { key: string };

/** Navigate to the World Map and open one conversation there. */
export function openWorldChatThread(key: string) {
  try {
    window.dispatchEvent(new CustomEvent("owllm:navigate", { detail: { key: "world-map" } }));
    // After the navigate, so the panel is mounted and listening by the time it
    // is told which thread to show.
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent<WorldChatOpenEventDetail>(WORLD_CHAT_OPEN_EVENT, { detail: { key } }));
    }, 0);
  } catch { /* no window (tests) */ }
}

/** Conversations from the last run, or nothing if none were kept. */
export function loadWorldChatThreads(): Record<string, WorldChatMessage[]> {
  try { return sanitizeWorldChatThreads(JSON.parse(localStorage.getItem(WORLD_CHAT_THREADS_KEY) ?? "null")); }
  catch { return {}; }
}

export function saveWorldChatThreads(threads: Record<string, WorldChatMessage[]>) {
  try {
    // An empty history is stored as a removal so that turning chat off leaves
    // nothing behind rather than an empty object nobody prunes.
    if (!Object.keys(threads).length) localStorage.removeItem(WORLD_CHAT_THREADS_KEY);
    else localStorage.setItem(WORLD_CHAT_THREADS_KEY, JSON.stringify(threads));
  } catch { /* storage unavailable or full */ }
}

/** Unread counts from the last run: a missed message stays missed across a quit. */
export function loadWorldChatUnread(): Record<string, number> {
  try { return sanitizeWorldChatUnread(JSON.parse(localStorage.getItem(WORLD_CHAT_UNREAD_KEY) ?? "null")); }
  catch { return {}; }
}

export function saveWorldChatUnread(unread: Record<string, number>) {
  try {
    if (!Object.keys(unread).length) localStorage.removeItem(WORLD_CHAT_UNREAD_KEY);
    else localStorage.setItem(WORLD_CHAT_UNREAD_KEY, JSON.stringify(unread));
  } catch { /* storage unavailable or full */ }
}

/**
 * Read a persisted on/off choice, tri-state.
 *
 * `getItem(key) === "1"` cannot express this: it reads "never chosen" and
 * "the user switched it off" as the same value, so a flag written that way can
 * only ever default to off. Absent means nobody has chosen yet, so the caller's
 * default applies; a stored "1"/"0" is the user's own word and is obeyed in
 * both directions, including across restarts.
 */
function readFlag(key: string, fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? fallback : stored === "1";
  } catch { return fallback; }
}

function writeFlag(key: string, value: boolean) {
  try { localStorage.setItem(key, value ? "1" : "0"); }
  catch { /* storage unavailable */ }
}

/**
 * On unless the user turned it off. World Chat is the point of the World Map —
 * a map of dots you cannot talk to is a poster — and every identity on it is
 * already anonymous (a derived presence id, no account, no name), so there is
 * nothing to opt into. Turning it off is one click and it sticks.
 */
export function worldChatEnabled(): boolean {
  return readFlag(WORLD_CHAT_ENABLED_KEY, true);
}

export function worldChatNick(): string {
  try { return (localStorage.getItem(WORLD_CHAT_NICK_KEY) ?? "").slice(0, 32); }
  catch { return ""; }
}

/** On by default too: a chat nobody may open a conversation on is not a chat. */
export function worldChatReachable(): boolean {
  return readFlag(WORLD_CHAT_REACHABLE_KEY, true);
}

/** The picture published with this device's messages; "" for none. */
export function worldChatAvatar(): string {
  try { return sanitizeChatAvatar(localStorage.getItem(WORLD_CHAT_AVATAR_KEY)); }
  catch { return ""; }
}

/**
 * What the user answered when asked about their GitHub identity.
 *
 * Tri-state on purpose. "" is *not yet asked* — the question is only worth
 * putting on screen once, and only to someone who has never answered it. A
 * stored "yes"/"no" is their word and is never re-asked; changing it is the
 * settings row's job.
 */
export type WorldChatGithubChoice = "" | "yes" | "no";

export function worldChatGithubChoice(): WorldChatGithubChoice {
  try {
    const stored = localStorage.getItem(WORLD_CHAT_GITHUB_KEY);
    return stored === "yes" || stored === "no" ? stored : "";
  } catch { return ""; }
}

export function setWorldChatGithubChoice(choice: WorldChatGithubChoice) {
  try {
    if (choice) localStorage.setItem(WORLD_CHAT_GITHUB_KEY, choice);
    else localStorage.removeItem(WORLD_CHAT_GITHUB_KEY);
  } catch { /* storage unavailable */ }
}

export type GithubChatIdentity = { login: string; avatar: string };

/**
 * The connected GitHub account, or null when none is connected. The picture is
 * derived from the login rather than stored, so it follows the account when the
 * user changes it on GitHub instead of freezing whatever it was on the day the
 * question was answered.
 */
export async function githubChatIdentity(): Promise<GithubChatIdentity | null> {
  try {
    const status = await invoke<{ connected?: boolean; login?: string | null }>("github_status");
    const login = String(status?.login ?? "").trim();
    if (!status?.connected || !login) return null;
    return { login: login.slice(0, 32), avatar: githubAvatarUrl(login) };
  } catch {
    return null;
  }
}

let store: WorldChatStore | undefined;
let snapshot: WorldChatState = emptyWorldChatState();
const listeners = new Set<(state: WorldChatState) => void>();
/** Presence ids of this user's own machines; a request from one auto-accepts. */
let ownDeviceIds: string[] = [];

async function loadOwnDeviceIds() {
  try {
    const devices = await listDevices();
    ownDeviceIds = await Promise.all(devices.map((device) => presenceNodeIdForDevice(device.device_id)));
  } catch {
    ownDeviceIds = [];
  }
}

/**
 * Tell the rest of the app that a message landed. The sender's nickname is
 * often still in flight (a lookup is a round trip), so the short id stands in
 * until it arrives rather than the notice waiting for it.
 */
function announceIncoming(message: WorldChatMessage) {
  try {
    const detail: WorldChatMessageEventDetail = {
      from: message.from,
      label: worldChatLabel(snapshot.peers[message.from], message.from),
      room: message.room,
      text: message.text,
      ts: message.ts,
      key: threadKey(message.from, message.room),
    };
    window.dispatchEvent(new CustomEvent(WORLD_CHAT_MESSAGE_EVENT, { detail }));
  } catch { /* no window (tests) — the inbox itself is unaffected */ }
}

export function worldChatStore(): WorldChatStore {
  if (!store) {
    // The store does not announce its own construction, so the restored
    // conversations are seeded into the snapshot here — otherwise a panel that
    // mounts before the first frame arrives would render an empty history and
    // look like nothing was remembered.
    const restored = loadWorldChatThreads();
    const restoredUnread = loadWorldChatUnread();
    snapshot = { ...emptyWorldChatState(), threads: restored, unread: restoredUnread };
    store = createWorldChatStore({
      crypto: {
        seal: (toEdPub, toXPub, text) => invoke<string>("world_chat_seal", { toEd25519Pub: toEdPub, toX25519Pub: toXPub, text }),
        open: async (envelope) => {
          const opened = await invoke<{ from: string; text: string }>("world_chat_open", { envelope });
          return { from: String(opened.from ?? ""), text: String(opened.text ?? "") };
        },
      },
      ownDeviceIds: () => ownDeviceIds,
      initialThreads: restored,
      initialUnread: restoredUnread,
      onIncoming: (message) => announceIncoming(message),
      onChange: (state) => {
        // Only rewrite storage when the conversation itself moved: status and
        // peer-lookup churn every few seconds and must not cost a serialize.
        if (state.threads !== snapshot.threads) saveWorldChatThreads(state.threads);
        if (state.unread !== snapshot.unread) saveWorldChatUnread(state.unread);
        snapshot = state;
        for (const listener of listeners) listener(state);
      },
    });
    void loadOwnDeviceIds();
  }
  return store;
}

export function worldChatSnapshot(): WorldChatState {
  return snapshot;
}

export function subscribeWorldChat(listener: (state: WorldChatState) => void): () => void {
  // Constructing the store is what restores the saved history and the unread
  // counts, so a subscriber that arrives before the World Map has ever been
  // opened — the app chrome does — still sees what was waiting from last run.
  worldChatStore();
  listeners.add(listener);
  listener(snapshot);
  return () => { listeners.delete(listener); };
}

/** Turn chat on or off. Off drops the identity and clears the local history. */
export function setWorldChatEnabled(enabled: boolean) {
  writeFlag(WORLD_CHAT_ENABLED_KEY, enabled);
  worldChatStore().setEnabled(enabled);
}

export function saveWorldChatProfile(nick: string, reachable: boolean, avatar = worldChatAvatar()) {
  const picture = sanitizeChatAvatar(avatar);
  try {
    localStorage.setItem(WORLD_CHAT_NICK_KEY, nick.slice(0, 32));
    if (picture) localStorage.setItem(WORLD_CHAT_AVATAR_KEY, picture);
    else localStorage.removeItem(WORLD_CHAT_AVATAR_KEY);
  } catch { /* storage unavailable */ }
  writeFlag(WORLD_CHAT_REACHABLE_KEY, reachable);
  worldChatStore().setProfile(nick.slice(0, 32), reachable, picture);
}

/**
 * Answer the GitHub question.
 *
 * "yes" adopts the login and picture as this device's chat identity right away —
 * the point of asking is that the user does not then have to go and type their
 * own name in. "no" is remembered so the question is not asked again, and it
 * also *withdraws* an identity that was previously adopted: the same answer has
 * to work whether it is given to the first-time question or to the settings row
 * that undoes it. A name the user typed themselves is left alone.
 */
export function applyGithubChatIdentity(choice: "yes" | "no", identity: GithubChatIdentity | null) {
  setWorldChatGithubChoice(choice);
  if (!identity) return;
  if (choice === "yes") {
    saveWorldChatProfile(identity.login, worldChatReachable(), identity.avatar);
    return;
  }
  if (worldChatNick() === identity.login || worldChatAvatar() === identity.avatar) {
    saveWorldChatProfile(worldChatNick() === identity.login ? "" : worldChatNick(), worldChatReachable(), "");
  }
}

/**
 * Hooks handed to the presence socket. Returns undefined when chat is off, so
 * the socket never asks for a challenge and presence stays anonymous.
 */
export function worldChatHooks(): WorldChatHooks | undefined {
  if (!worldChatEnabled()) return undefined;
  const chat = worldChatStore();
  return {
    identity: async () => {
      const identity = await getIdentity();
      if (!identity.ed25519_pub || !identity.x25519_pub) return null;
      return { publicKey: identity.ed25519_pub, xPub: identity.x25519_pub };
    },
    sign: (nonce) => invoke<string>("world_chat_sign", { nonce }),
    profile: () => ({ nick: worldChatNick(), avatar: worldChatAvatar(), reachable: worldChatReachable() }),
    onFrame: (frame) => chat.onFrame(frame),
    onTransport: (send) => chat.setTransport(send),
    onError: (error) => chat.onFrame({ type: "chat_error", error }),
  };
}
