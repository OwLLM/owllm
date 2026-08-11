// World Map chat — the client half of the relay protocol.
//
// This module is deliberately free of React and of Tauri: the transport, the
// crypto and the clock are all injected, so the whole protocol can be driven
// and asserted without a socket, a webview or a signing key.
//
// Three audiences, one mechanism:
//
//   * your own devices     — their presence ids come from the local fleet
//                            registry, so a request from one of them is
//                            auto-accepted and the pairing needs no clicks;
//   * a closed group       — a room is addressed by hash(invite secret); the
//                            secret never leaves this process, and each message
//                            is sealed once per member;
//   * anyone on the map    — a first-contact request, which the recipient must
//                            accept, and may block or report instead.
//
// Message history is kept in memory only. It is exactly the shape of data that
// must not go into localStorage: it is rewritten on every keystroke-sized event
// and would be broadcast to every other renderer that never asked for it. The
// relay's own queue is the durability layer.

import { presenceServerCode } from "./worldPresence";

export type WorldChatKind = "message" | "request" | "room";

export type WorldChatPeer = {
  id: string;
  nick: string;
  /** Picture URL, always on GitHub's avatar CDN — see `sanitizeChatAvatar`. */
  avatar: string;
  xPub: string;
  edPub: string;
  reachable: boolean;
};

export type WorldChatMessage = {
  /** Relay sequence number; used to acknowledge. 0 for locally-sent echoes. */
  id: number;
  kind: WorldChatKind;
  /** Presence id of the other party — the sender, or us for our own lines. */
  from: string;
  room: string;
  text: string;
  ts: string;
  mine: boolean;
};

export type WorldChatStatus = "off" | "connecting" | "ready" | "error";

export type WorldChatState = {
  status: WorldChatStatus;
  selfId: string;
  nick: string;
  /** This device's own published picture, as the relay echoed it back. */
  avatar: string;
  reachable: boolean;
  error: string;
  peers: Record<string, WorldChatPeer>;
  contacts: string[];
  requests: string[];
  requested: string[];
  blocked: string[];
  rooms: string[];
  /** Keyed by peer id, or `room:<id>` for a group. */
  threads: Record<string, WorldChatMessage[]>;
  /**
   * How many lines in each thread the user has not looked at yet, same keys as
   * `threads`. A count and not a boolean: an inbox has to say *how much* is
   * waiting, and it has to survive a restart — a notice that clears itself on a
   * timer loses the message, which is the whole reason this exists.
   */
  unread: Record<string, number>;
};

/** One row of the inbox: who, the last thing said, when, and how much is new. */
export type WorldChatConversation = {
  key: string;
  /** Empty for a group. */
  peerId: string;
  /** Empty for a direct conversation. */
  room: string;
  label: string;
  /** The peer's picture, or empty for a group and for anyone without one. */
  avatar: string;
  last: WorldChatMessage | undefined;
  unread: number;
};

/** Seal/open live in Rust because the private keys do. */
export type WorldChatCrypto = {
  seal: (toEdPub: string, toXPub: string, text: string) => Promise<string>;
  open: (envelope: string) => Promise<{ from: string; text: string }>;
};

export type WorldChatDeps = {
  crypto: WorldChatCrypto;
  /** Presence ids of this user's OWN devices; requests from these auto-accept. */
  ownDeviceIds?: () => string[];
  /**
   * Conversations restored from the previous run. A chat that forgets every
   * line the moment the app closes is a notification pane, not a chat: the
   * relay only replays what it still holds *undelivered*, so keeping the
   * history is the client's job.
   */
  initialThreads?: Record<string, WorldChatMessage[]>;
  /** Unread counts from the previous run, so a missed message stays missed. */
  initialUnread?: Record<string, number>;
  onChange: (state: WorldChatState) => void;
  /**
   * A message that just arrived from someone else. Fires once per line and
   * never for our own echoes or for a relay replay, so a notification raised
   * from it cannot announce the same message twice.
   */
  onIncoming?: (message: WorldChatMessage) => void;
  now?: () => string;
};

export const MAX_THREAD_MESSAGES = 500;
export const MAX_CHAT_TEXT = 4_000;
const ROOM_DOMAIN = "owllm-world-room-v1\0";

export function emptyWorldChatState(): WorldChatState {
  return {
    status: "off",
    selfId: "",
    nick: "",
    avatar: "",
    reachable: false,
    error: "",
    peers: {},
    contacts: [],
    requests: [],
    requested: [],
    blocked: [],
    rooms: [],
    threads: {},
    unread: {},
  };
}

/** Room id = hex(SHA-256(domain || invite secret)). The secret stays local. */
export async function roomIdFromInvite(secret: string): Promise<string> {
  const normalized = secret.trim();
  if (!normalized) return "";
  const bytes = new TextEncoder().encode(`${ROOM_DOMAIN}${normalized}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Short, human-readable label for a dot that has not chosen a nickname.
 *
 * The fallback is `presenceServerCode`, the SAME code the map and the country
 * list print for that node — one machine, one name. An earlier version sliced
 * the raw id instead, so the dot you clicked ("Server OW-0UVYMD5") and the
 * thread it opened ("OW-523DF1") wore two unrelated codes, and a history full
 * of them could not be matched to anything on the globe.
 */
export function worldChatLabel(peer: WorldChatPeer | undefined, id: string): string {
  const nick = peer?.nick?.trim();
  if (nick) return nick;
  return id ? presenceServerCode(id) : "";
}

/**
 * The only host a chat picture may come from.
 *
 * A picture URL is chosen by the *other* side and then loaded by our renderer,
 * so an unrestricted field would let any dot on the map point us at a URL of
 * its choosing — which fetches on sight, reveals our IP, and can be swapped for
 * anything at any time. Pinning it to GitHub's avatar CDN keeps this what it
 * says it is, a GitHub profile picture, and nothing else.
 */
export const CHAT_AVATAR_HOST = "avatars.githubusercontent.com";
export const MAX_CHAT_AVATAR_CHARS = 200;

/** The picture for a GitHub login, sized for the small circles we draw. */
export function githubAvatarUrl(login: string, size = 64): string {
  const handle = login.trim();
  if (!handle) return "";
  return `https://${CHAT_AVATAR_HOST}/${encodeURIComponent(handle)}?size=${size}`;
}

/** Empty unless the value is an https URL on the avatar CDN. Never throws. */
export function sanitizeChatAvatar(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > MAX_CHAT_AVATAR_CHARS) return "";
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== CHAT_AVATAR_HOST) return "";
    return url.toString().slice(0, MAX_CHAT_AVATAR_CHARS);
  } catch {
    return "";
  }
}

/** The letter drawn in place of a picture, so every row has the same shape. */
export function chatAvatarInitial(label: string): string {
  const first = label.trim().replace(/^OW-/, "").charAt(0);
  return first ? first.toUpperCase() : "?";
}

export function threadKey(peerId: string, room = ""): string {
  return room ? `room:${room}` : peerId;
}

/**
 * Restore threads from whatever was persisted, dropping anything that is not
 * a message. Storage is user-writable and survives across versions, so a
 * malformed entry must not be able to break the panel that renders it.
 */
export function sanitizeWorldChatThreads(value: unknown): Record<string, WorldChatMessage[]> {
  const threads: Record<string, WorldChatMessage[]> = {};
  if (!value || typeof value !== "object") return threads;
  for (const [key, entries] of Object.entries(value as Record<string, unknown>)) {
    if (!key || !Array.isArray(entries)) continue;
    const messages = entries.flatMap((entry): WorldChatMessage[] => {
      if (!entry || typeof entry !== "object") return [];
      const row = entry as Record<string, unknown>;
      const text = trimText(row.text);
      if (!text) return [];
      return [{
        id: Number.isFinite(row.id) ? Number(row.id) : 0,
        kind: row.kind === "request" || row.kind === "room" ? row.kind : "message",
        from: typeof row.from === "string" ? row.from : "",
        room: typeof row.room === "string" ? row.room : "",
        text,
        ts: typeof row.ts === "string" ? row.ts : "",
        mine: row.mine === true,
      }];
    }).slice(-MAX_THREAD_MESSAGES);
    if (messages.length) threads[key] = messages;
  }
  return threads;
}

/** Same contract as the threads: storage is user-writable, so nothing is trusted. */
export function sanitizeWorldChatUnread(value: unknown): Record<string, number> {
  const unread: Record<string, number> = {};
  if (!value || typeof value !== "object") return unread;
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    const parsed = Math.floor(Number(count));
    if (key && Number.isFinite(parsed) && parsed > 0) unread[key] = Math.min(parsed, MAX_THREAD_MESSAGES);
  }
  return unread;
}

/**
 * The inbox, newest first. Derived from the threads rather than stored beside
 * them: a second list of conversations could disagree with the messages it
 * claims to summarise, and then the panel and the history would tell the user
 * two different stories.
 */
export function worldChatConversations(state: WorldChatState): WorldChatConversation[] {
  return Object.entries(state.threads)
    .flatMap(([key, messages]): WorldChatConversation[] => {
      if (!messages.length) return [];
      const room = key.startsWith("room:") ? key.slice(5) : "";
      const peerId = room ? "" : key;
      return [{
        key,
        peerId,
        room,
        label: room ? `# ${room.slice(0, 10)}` : worldChatLabel(state.peers[peerId], peerId),
        avatar: room ? "" : state.peers[peerId]?.avatar ?? "",
        last: messages[messages.length - 1],
        unread: state.unread[key] ?? 0,
      }];
    })
    .sort((a, b) => (b.last?.ts ?? "").localeCompare(a.last?.ts ?? ""));
}

export function worldChatUnreadCount(state: WorldChatState): number {
  return Object.values(state.unread).reduce((total, count) => total + count, 0);
}

function trimText(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_CHAT_TEXT) : "";
}

/** Turn terse protocol error codes into something a human can read. */
export function chatErrorText(code: string): string {
  switch (code) {
    case "chat_request_invalid": return "You cannot send a chat request to that node.";
    case "chat_send_invalid": return "That message could not be sent.";
    case "peer_unknown": return "The person you tried to reach is not on the map right now.";
    case "peer_blocked": return "You have blocked this person.";
    case "peer_not_reachable": return "This person is not accepting new conversations right now.";
    case "sender_suspended": return "Your account has been temporarily suspended from first contact.";
    case "request_quota_exhausted": return "You have sent too many chat requests recently. Try again later.";
    case "not_a_contact": return "You cannot message someone until they have accepted your request.";
    case "no_pending_request": return "There is no pending request to accept.";
    case "not_authenticated": return "World Chat is not connected.";
    case "rate_limited": return "You are sending messages too quickly. Slow down.";
    default: return code;
  }
}

function asIdList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * The protocol client. `send` is supplied by the presence socket once the relay
 * has accepted this device's identity, and is null whenever the socket is down —
 * so an action taken while offline reports that rather than vanishing.
 */
export function createWorldChatStore(deps: WorldChatDeps) {
  let state = {
    ...emptyWorldChatState(),
    threads: sanitizeWorldChatThreads(deps.initialThreads),
    unread: sanitizeWorldChatUnread(deps.initialUnread),
  };
  let send: ((value: unknown) => boolean) | null = null;
  const now = deps.now ?? (() => new Date().toISOString());

  const commit = (patch: Partial<WorldChatState>) => {
    state = { ...state, ...patch };
    deps.onChange(state);
  };

  /** True when the line was actually added — false for a replayed duplicate. */
  const appendMessage = (key: string, message: WorldChatMessage): boolean => {
    const existing = state.threads[key] ?? [];
    // The relay may replay an unacknowledged message after a reconnect; a
    // sequence number that is already present must not become a second line.
    if (message.id > 0 && existing.some((entry) => entry.id === message.id)) return false;
    const next = [...existing, message].slice(-MAX_THREAD_MESSAGES);
    commit({ threads: { ...state.threads, [key]: next } });
    return true;
  };

  const write = (value: unknown): boolean => {
    if (!send) {
      commit({ error: "World chat is offline" });
      return false;
    }
    return send(value);
  };

  const peerOf = (id: string): WorldChatPeer | undefined => state.peers[id];

  /** Fetch public keys for ids we do not have yet; sealing needs them. */
  const lookup = (ids: string[]) => {
    const missing = ids.filter((id) => id && !state.peers[id]);
    if (missing.length) write({ type: "chat_lookup", ids: missing });
  };

  const peerWaiters = new Map<string, Array<(peer: WorldChatPeer | null) => void>>();

  const resolvePeerWaiters = (id: string, peer: WorldChatPeer | null) => {
    const waiters = peerWaiters.get(id);
    if (!waiters) return;
    peerWaiters.delete(id);
    for (const waiter of waiters) waiter(peer);
  };

  /**
   * Wait for a peer's public keys before sealing. A lookup is a round trip, so
   * the first message to a new dot would otherwise fail on keys that are merely
   * still in flight.
   */
  const ensurePeer = (id: string, timeoutMs = 8_000) => new Promise<WorldChatPeer>((resolve, reject) => {
    const known = peerOf(id);
    if (known?.edPub && known?.xPub) { resolve(known); return; }
    const waiters = peerWaiters.get(id) ?? [];
    const timer = setTimeout(() => resolvePeerWaiters(id, null), timeoutMs);
    waiters.push((peer) => {
      clearTimeout(timer);
      if (peer?.edPub && peer?.xPub) resolve(peer);
      else reject(new Error("This device has not published a chat key yet"));
    });
    peerWaiters.set(id, waiters);
    write({ type: "chat_lookup", ids: [id] });
  });

  const sealFor = async (id: string, text: string): Promise<string> => {
    const peer = await ensurePeer(id);
    return deps.crypto.seal(peer.edPub, peer.xPub, text);
  };

  const receive = async (frame: Record<string, unknown>) => {
    const type = typeof frame.type === "string" ? frame.type : "";
    switch (type) {
      case "chat_ready": {
        commit({
          status: "ready",
          selfId: typeof frame.id === "string" ? frame.id : "",
          nick: typeof frame.nick === "string" ? frame.nick : "",
          avatar: sanitizeChatAvatar(frame.avatar),
          reachable: frame.reachable === true,
          error: "",
        });
        return;
      }
      case "chat_state": {
        const requests = asIdList(frame.requests);
        commit({
          contacts: asIdList(frame.contacts),
          requests,
          requested: asIdList(frame.requested),
          blocked: asIdList(frame.blocked),
          rooms: asIdList(frame.rooms),
        });
        lookup([...asIdList(frame.contacts), ...requests, ...asIdList(frame.requested)]);
        // A request from one of this user's own machines needs no ceremony.
        const own = new Set(deps.ownDeviceIds?.() ?? []);
        for (const id of requests) if (own.has(id)) write({ type: "chat_accept", id });
        return;
      }
      case "chat_peers": {
        const peers = { ...state.peers };
        for (const raw of Array.isArray(frame.peers) ? frame.peers : []) {
          const row = raw as Record<string, unknown>;
          const id = typeof row.id === "string" ? row.id : "";
          if (!id) continue;
          peers[id] = {
            id,
            nick: typeof row.nick === "string" ? row.nick : "",
            avatar: sanitizeChatAvatar(row.avatar),
            xPub: typeof row.xPub === "string" ? row.xPub : "",
            edPub: typeof row.edPub === "string" ? row.edPub : "",
            reachable: row.reachable === true,
          };
        }
        commit({ peers });
        for (const id of Object.keys(peers)) resolvePeerWaiters(id, peers[id]);
        // An id the relay did not know about must fail its waiters rather than
        // leave a send hanging until the timeout.
        for (const id of Array.isArray(frame.ids) ? (frame.ids as string[]) : []) {
          if (!peers[id]) resolvePeerWaiters(id, null);
        }
        return;
      }
      case "chat_profile_ok": {
        commit({
          nick: typeof frame.nick === "string" ? frame.nick : "",
          avatar: sanitizeChatAvatar(frame.avatar),
          reachable: frame.reachable === true,
        });
        return;
      }
      case "chat_message": {
        const id = Number(frame.id ?? 0);
        const room = typeof frame.room === "string" ? frame.room : "";
        const kind = frame.kind === "request" || frame.kind === "room" ? frame.kind : "message";
        const box = typeof frame.box === "string" ? frame.box : "";
        const claimed = typeof frame.from === "string" ? frame.from : "";
        try {
          const opened = await deps.crypto.open(box);
          // Attribution comes from the signature-verified sender inside the
          // envelope, never from the `from` field the relay attached to it.
          if (opened.from && claimed && opened.from !== claimed) {
            commit({ error: "Dropped a message whose sender did not match its signature" });
            return;
          }
          const from = opened.from || claimed;
          const message: WorldChatMessage = {
            id, kind, from, room, text: trimText(opened.text), ts: typeof frame.ts === "string" ? frame.ts : now(), mine: false,
          };
          const key = threadKey(from, room);
          if (appendMessage(key, message)) {
            // Counted before the host is told, so a notice raised from
            // `onIncoming` reads a state that already includes this line.
            commit({ unread: { ...state.unread, [key]: (state.unread[key] ?? 0) + 1 } });
            deps.onIncoming?.(message);
          }
          lookup([from]);
        } catch (reason) {
          commit({ error: `Could not read a message: ${String(reason)}` });
          return;
        }
        if (id > 0) write({ type: "chat_ack", ids: [id] });
        return;
      }
      case "room_roster": {
        const room = typeof frame.room === "string" ? frame.room : "";
        const peers = { ...state.peers };
        for (const raw of Array.isArray(frame.members) ? frame.members : []) {
          const row = raw as Record<string, unknown>;
          const id = typeof row.id === "string" ? row.id : "";
          if (!id) continue;
          peers[id] = {
            id,
            nick: typeof row.nick === "string" ? row.nick : "",
            avatar: sanitizeChatAvatar(row.avatar),
            xPub: typeof row.xPub === "string" ? row.xPub : "",
            edPub: typeof row.edPub === "string" ? row.edPub : "",
            reachable: row.reachable === true,
          };
        }
        commit({ peers, rooms: state.rooms.includes(room) ? state.rooms : [...state.rooms, room] });
        return;
      }
      case "chat_error": {
        commit({ error: chatErrorText(String(frame.error ?? "chat error")) });
        return;
      }
      default:
        return;
    }
  };

  return {
    state: () => state,

    /** Called by the presence runner: a writer, or null when the socket drops. */
    setTransport(next: ((value: unknown) => boolean) | null) {
      send = next;
      commit({ status: next ? "ready" : state.status === "off" ? "off" : "connecting" });
    },

    setEnabled(enabled: boolean) {
      if (!enabled) {
        send = null;
        state = emptyWorldChatState();
        deps.onChange(state);
      } else {
        commit({ status: "connecting", error: "" });
      }
    },

    onFrame(frame: Record<string, unknown>) {
      void receive(frame);
    },

    clearError() {
      commit({ error: "" });
    },

    /** The user is looking at this conversation, so it is no longer waiting. */
    markRead(key: string) {
      if (!key || !state.unread[key]) return;
      const unread = { ...state.unread };
      delete unread[key];
      commit({ unread });
    },

    markAllRead() {
      if (!Object.keys(state.unread).length) return;
      commit({ unread: {} });
    },

    setProfile(nick: string, reachable: boolean, avatar = "") {
      write({ type: "chat_profile", nick, reachable, avatar: sanitizeChatAvatar(avatar) });
    },

    lookup,

    /** First contact. The intro line is sealed just like any other message. */
    async request(id: string, text: string) {
      try {
        lookup([id]);
        const box = await sealFor(id, trimText(text) || "Hello from OwLLM");
        if (write({ type: "chat_request", to: id, box })) {
          appendMessage(threadKey(id), { id: 0, kind: "request", from: id, room: "", text: trimText(text), ts: now(), mine: true });
        }
      } catch (reason) {
        commit({ error: chatErrorText(String(reason)) });
      }
    },

    async say(id: string, text: string) {
      try {
        const body = trimText(text).trim();
        if (!body) return;
        const box = await sealFor(id, body);
        if (write({ type: "chat_send", to: id, box })) {
          appendMessage(threadKey(id), { id: 0, kind: "message", from: id, room: "", text: body, ts: now(), mine: true });
        }
      } catch (reason) {
        commit({ error: chatErrorText(String(reason)) });
      }
    },

    /** One sealed box per member, so a room stays end to end. */
    async sayToRoom(room: string, text: string) {
      try {
        const body = trimText(text).trim();
        if (!body || !room) return;
        const members = Object.values(state.peers).filter((peer) => peer.id !== state.selfId && peer.edPub && peer.xPub);
        const boxes = await Promise.all(members.map(async (peer) => ({ to: peer.id, box: await sealFor(peer.id, body) })));
        if (write({ type: "room_send", room, boxes })) {
          appendMessage(threadKey("", room), { id: 0, kind: "room", from: state.selfId, room, text: body, ts: now(), mine: true });
        }
      } catch (reason) {
        commit({ error: chatErrorText(String(reason)) });
      }
    },

    accept(id: string) { write({ type: "chat_accept", id }); },
    block(id: string) { write({ type: "chat_block", id }); },
    unblock(id: string) { write({ type: "chat_unblock", id }); },
    report(id: string) { write({ type: "chat_report", id }); },

    async joinRoom(invite: string) {
      const room = await roomIdFromInvite(invite);
      if (!room) return "";
      write({ type: "room_join", room });
      return room;
    },

    leaveRoom(room: string) {
      write({ type: "room_leave", room });
      commit({ rooms: state.rooms.filter((entry) => entry !== room) });
    },

    refreshRoom(room: string) { write({ type: "room_members", room }); },
  };
}

export type WorldChatStore = ReturnType<typeof createWorldChatStore>;
