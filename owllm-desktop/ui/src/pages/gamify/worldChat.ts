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

export type WorldChatKind = "message" | "request" | "room";

export type WorldChatPeer = {
  id: string;
  nick: string;
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
  onChange: (state: WorldChatState) => void;
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
    reachable: false,
    error: "",
    peers: {},
    contacts: [],
    requests: [],
    requested: [],
    blocked: [],
    rooms: [],
    threads: {},
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

/** Short, human-readable label for a dot that has not chosen a nickname. */
export function worldChatLabel(peer: WorldChatPeer | undefined, id: string): string {
  const nick = peer?.nick?.trim();
  if (nick) return nick;
  return id ? `OW-${id.slice(0, 6).toUpperCase()}` : "";
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

function trimText(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_CHAT_TEXT) : "";
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
  let state = { ...emptyWorldChatState(), threads: sanitizeWorldChatThreads(deps.initialThreads) };
  let send: ((value: unknown) => boolean) | null = null;
  const now = deps.now ?? (() => new Date().toISOString());

  const commit = (patch: Partial<WorldChatState>) => {
    state = { ...state, ...patch };
    deps.onChange(state);
  };

  const appendMessage = (key: string, message: WorldChatMessage) => {
    const existing = state.threads[key] ?? [];
    // The relay may replay an unacknowledged message after a reconnect; a
    // sequence number that is already present must not become a second line.
    if (message.id > 0 && existing.some((entry) => entry.id === message.id)) return;
    const next = [...existing, message].slice(-MAX_THREAD_MESSAGES);
    commit({ threads: { ...state.threads, [key]: next } });
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
        commit({ nick: typeof frame.nick === "string" ? frame.nick : "", reachable: frame.reachable === true });
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
          appendMessage(threadKey(from, room), {
            id, kind, from, room, text: trimText(opened.text), ts: typeof frame.ts === "string" ? frame.ts : now(), mine: false,
          });
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
            xPub: typeof row.xPub === "string" ? row.xPub : "",
            edPub: typeof row.edPub === "string" ? row.edPub : "",
            reachable: row.reachable === true,
          };
        }
        commit({ peers, rooms: state.rooms.includes(room) ? state.rooms : [...state.rooms, room] });
        return;
      }
      case "chat_error": {
        commit({ error: String(frame.error ?? "chat error") });
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

    setProfile(nick: string, reachable: boolean) {
      write({ type: "chat_profile", nick, reachable });
    },

    lookup,

    /** First contact. The intro line is sealed just like any other message. */
    async request(id: string, text: string) {
      lookup([id]);
      const box = await sealFor(id, trimText(text) || "Hello from OwLLM");
      if (write({ type: "chat_request", to: id, box })) {
        appendMessage(threadKey(id), { id: 0, kind: "request", from: id, room: "", text: trimText(text), ts: now(), mine: true });
      }
    },

    async say(id: string, text: string) {
      const body = trimText(text).trim();
      if (!body) return;
      const box = await sealFor(id, body);
      if (write({ type: "chat_send", to: id, box })) {
        appendMessage(threadKey(id), { id: 0, kind: "message", from: id, room: "", text: body, ts: now(), mine: true });
      }
    },

    /** One sealed box per member, so a room stays end to end. */
    async sayToRoom(room: string, text: string) {
      const body = trimText(text).trim();
      if (!body || !room) return;
      const members = Object.values(state.peers).filter((peer) => peer.id !== state.selfId && peer.edPub && peer.xPub);
      const boxes = await Promise.all(members.map(async (peer) => ({ to: peer.id, box: await sealFor(peer.id, body) })));
      if (write({ type: "room_send", room, boxes })) {
        appendMessage(threadKey("", room), { id: 0, kind: "room", from: state.selfId, room, text: body, ts: now(), mine: true });
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
