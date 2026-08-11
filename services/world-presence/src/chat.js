// OWLLM World Chat — authenticated identity and end-to-end relay layered on top
// of the anonymous presence socket.
//
// The map's node id was already a pure function of the device's signing key:
//
//     device_id   = hex(SHA-256(ed25519_pub))            (remote_devices/crypto.rs)
//     presence_id = hex(SHA-256(domain || device_id))    (remote_devices/identity.rs)
//
// It was simply never verified — the id arrived as a query parameter and was
// trusted. That is harmless for a dot on a map and fatal for an inbox, because
// every node id is broadcast to every viewer, so all inbox addresses are public.
// Here the client proves ownership by signing a server nonce with the same key;
// the server re-derives the id from the presented key and rejects any mismatch.
// No new identity, no id migration, and no squatting window: an id that is a
// hash of a public key cannot be claimed by anyone lacking the private half.
//
// The relay never sees plaintext. Clients exchange `remote_devices` sealed
// envelopes (X25519 ECDH + AES-256-GCM, signed, one ephemeral key per message),
// so the body stored in the offline queue is ciphertext the service cannot read.
// That is deliberate: the service holds no readable user message at any point.

/** Signed by the client to prove it holds the key its node id is derived from. */
export const CHAT_AUTH_DOMAIN = "owllm-world-chat-auth-v1\0";
/** Byte-for-byte identical to PRESENCE_DOMAIN in remote_devices/identity.rs. */
export const PRESENCE_DOMAIN = "owllm-world-presence-device-v1\0";

/** A sealed envelope is JSON with base64 fields; well clear of a chat message. */
export const MAX_BOX_CHARS = 24_000;
export const MAX_NICK_CHARS = 32;
/** The only host a profile picture may be served from — see `sanitizeAvatar`. */
export const AVATAR_HOST = "avatars.githubusercontent.com";
export const MAX_AVATAR_CHARS = 200;
/** Undelivered messages per recipient. Oldest is dropped past this. */
export const MAX_INBOX_PER_PEER = 250;
/** Undelivered messages expire even if the recipient never returns. */
export const INBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sends allowed per socket inside one window — anti-flood, not anti-abuse. */
export const SEND_WINDOW_MS = 10_000;
export const SEND_WINDOW_LIMIT = 40;
/** First-contact requests one identity may send per day to people it doesn't know. */
export const STRANGER_REQUESTS_PER_DAY = 20;
/** Reports from distinct identities before an id loses stranger-reach. */
export const REPORT_SUSPEND_THRESHOLD = 5;
export const MAX_ROOM_MEMBERS = 256;
export const MAX_ROOMS_PER_PEER = 64;

const HEX64 = /^[0-9a-f]{64}$/;

export function encodeBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeBase64(value) {
  try {
    const binary = atob(String(value ?? ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function hex(bytes) {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

async function sha256Hex(bytes) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/**
 * Re-derive the public map id from a device's Ed25519 public key, exactly as
 * the desktop app derives it. Any divergence here silently detaches every
 * install from its recorded dot, so this mirrors the Rust two-step precisely.
 */
export async function presenceIdFromEdPub(edPub) {
  if (!(edPub instanceof Uint8Array) || edPub.length !== 32) return "";
  const deviceId = await sha256Hex(edPub);
  return sha256Hex(new TextEncoder().encode(`${PRESENCE_DOMAIN}${deviceId}`));
}

/** A chat/node id is always the 64-char lowercase hex of a SHA-256 digest. */
export function sanitizeChatId(raw) {
  const text = String(raw ?? "").trim().toLowerCase();
  return HEX64.test(text) ? text : "";
}

/** Rooms are addressed by hex(SHA-256(invite secret)); the secret never leaves the client. */
export const sanitizeRoomId = sanitizeChatId;

/**
 * A chosen display name. Control characters are stripped so a nickname cannot
 * forge line breaks or bidi overrides in another user's list.
 */
export function sanitizeNick(raw) {
  let out = "";
  for (const char of String(raw ?? "")) {
    const code = char.codePointAt(0);
    // C0/C1 controls, zero-width marks, and the bidi overrides that would let a
    // chosen name silently reorder the line it is rendered on.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    if (code >= 0x200b && code <= 0x200f) continue;
    if (code === 0x2028 || code === 0x2029) continue;
    if (code >= 0x202a && code <= 0x202e) continue;
    if (code >= 0x2066 && code <= 0x2069) continue;
    out += char;
  }
  return out.trim().slice(0, MAX_NICK_CHARS);
}

/**
 * A profile picture, pinned to GitHub's avatar CDN.
 *
 * The URL is chosen by one client and then loaded by another's renderer, so an
 * open field would make every profile a beacon: it fetches on sight, reveals
 * the viewer's IP to whoever set it, and can be swapped for any image later.
 * Restricting the host keeps this exactly what it is offered as — a GitHub
 * profile picture — and leaves nothing for a hostile profile to point at.
 */
export function sanitizeAvatar(raw) {
  const text = String(raw ?? "").trim();
  if (!text || text.length > MAX_AVATAR_CHARS) return "";
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== AVATAR_HOST) return "";
    return url.toString().slice(0, MAX_AVATAR_CHARS);
  } catch {
    return "";
  }
}

/** Opaque ciphertext. Never parsed, never inspected — only length-checked. */
export function sanitizeBox(raw) {
  const text = typeof raw === "string" ? raw : "";
  return text.length > 0 && text.length <= MAX_BOX_CHARS ? text : "";
}

export function randomNonce() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}

/**
 * Verify a client's claim to a node id.
 *
 * Returns the id derived from the presented key, or an error. The caller must
 * compare that id against the one the socket connected with: a valid signature
 * only proves the client owns *some* key, and it is the derivation that binds
 * that key to a specific dot on the map.
 */
export async function verifyPresenceAuth({ nonce, publicKey, signature }) {
  const nonceText = String(nonce ?? "");
  if (!HEX64.test(nonceText)) return { ok: false, error: "auth_nonce_invalid" };
  const edPub = decodeBase64(publicKey);
  const sig = decodeBase64(signature);
  if (!edPub || edPub.length !== 32) return { ok: false, error: "auth_key_invalid" };
  if (!sig || sig.length !== 64) return { ok: false, error: "auth_signature_invalid" };

  const message = new TextEncoder().encode(`${CHAT_AUTH_DOMAIN}${nonceText}`);
  let verified = false;
  try {
    const key = await crypto.subtle.importKey("raw", edPub, { name: "Ed25519" }, false, ["verify"]);
    verified = await crypto.subtle.verify({ name: "Ed25519" }, key, sig, message);
  } catch {
    return { ok: false, error: "auth_key_invalid" };
  }
  if (!verified) return { ok: false, error: "auth_signature_invalid" };
  return { ok: true, chatId: await presenceIdFromEdPub(edPub) };
}

/**
 * Fixed-size sliding window per identity. Hibernation clears the map, which is
 * safe: hibernating means the object was idle, so no burst is in flight.
 */
export function allowSend(windows, chatId, now) {
  const current = windows.get(chatId);
  if (!current || now - current.start >= SEND_WINDOW_MS) {
    windows.set(chatId, { start: now, count: 1 });
    return true;
  }
  if (current.count >= SEND_WINDOW_LIMIT) return false;
  current.count += 1;
  return true;
}

/** Public profile of a peer that has opted in to being reachable. */
export function publicPeer(row) {
  return {
    id: sanitizeChatId(row?.chat_id ?? row?.id),
    nick: sanitizeNick(row?.nick),
    avatar: sanitizeAvatar(row?.avatar),
    xPub: String(row?.x_pub ?? row?.xPub ?? "").slice(0, 64),
    edPub: String(row?.ed_pub ?? row?.edPub ?? "").slice(0, 64),
    reachable: Boolean(Number(row?.reachable ?? 0)),
  };
}
