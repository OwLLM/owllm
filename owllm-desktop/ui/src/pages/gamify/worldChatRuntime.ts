// One World Chat client per running app, wired to the native keys.
//
// It is a module singleton on purpose. The inbox has to outlive the World Map
// page — pages unmount on every tab switch, and an inbox that only exists while
// you are looking at it is not an inbox. The presence socket that carries it is
// already app-wide, so the two have the same lifetime.
//
// Only three small scalars are persisted (on/off, nickname, reachable). Message
// history stays in memory: it is rewritten constantly and would otherwise be
// broadcast to every other renderer on every line.

import { invoke } from "@tauri-apps/api/core";

import { getIdentity, listDevices } from "../advanced/remoteDevices";
import {
  createWorldChatStore,
  emptyWorldChatState,
  type WorldChatState,
  type WorldChatStore,
} from "./worldChat";
import { presenceNodeIdForDevice, type WorldChatHooks } from "./worldPresence";

export const WORLD_CHAT_ENABLED_KEY = "owllm:world-chat:enabled";
export const WORLD_CHAT_NICK_KEY = "owllm:world-chat:nick";
export const WORLD_CHAT_REACHABLE_KEY = "owllm:world-chat:reachable";

function readFlag(key: string): boolean {
  try { return localStorage.getItem(key) === "1"; }
  catch { return false; }
}

function writeFlag(key: string, value: boolean) {
  try { localStorage.setItem(key, value ? "1" : "0"); }
  catch { /* storage unavailable */ }
}

export function worldChatEnabled(): boolean {
  return readFlag(WORLD_CHAT_ENABLED_KEY);
}

export function worldChatNick(): string {
  try { return (localStorage.getItem(WORLD_CHAT_NICK_KEY) ?? "").slice(0, 32); }
  catch { return ""; }
}

export function worldChatReachable(): boolean {
  return readFlag(WORLD_CHAT_REACHABLE_KEY);
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

export function worldChatStore(): WorldChatStore {
  if (!store) {
    store = createWorldChatStore({
      crypto: {
        seal: (toEdPub, toXPub, text) => invoke<string>("world_chat_seal", { toEd25519Pub: toEdPub, toX25519Pub: toXPub, text }),
        open: async (envelope) => {
          const opened = await invoke<{ from: string; text: string }>("world_chat_open", { envelope });
          return { from: String(opened.from ?? ""), text: String(opened.text ?? "") };
        },
      },
      ownDeviceIds: () => ownDeviceIds,
      onChange: (state) => {
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
  listeners.add(listener);
  listener(snapshot);
  return () => { listeners.delete(listener); };
}

/** Turn chat on or off. Off drops the identity and clears the local history. */
export function setWorldChatEnabled(enabled: boolean) {
  writeFlag(WORLD_CHAT_ENABLED_KEY, enabled);
  worldChatStore().setEnabled(enabled);
}

export function saveWorldChatProfile(nick: string, reachable: boolean) {
  try { localStorage.setItem(WORLD_CHAT_NICK_KEY, nick.slice(0, 32)); }
  catch { /* storage unavailable */ }
  writeFlag(WORLD_CHAT_REACHABLE_KEY, reachable);
  worldChatStore().setProfile(nick.slice(0, 32), reachable);
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
    profile: () => ({ nick: worldChatNick(), reachable: worldChatReachable() }),
    onFrame: (frame) => chat.onFrame(frame),
    onTransport: (send) => chat.setTransport(send),
    onError: (error) => chat.onFrame({ type: "chat_error", error }),
  };
}
