// The World Map chat surface.
//
// Kept in its own module so it can be mounted and driven without the globe,
// the WebGL context, or a live relay behind it.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { useStickyScroll } from "../../hooks/useStickyScroll";
import { useLocalization } from "../../localization";
import { threadKey, worldChatLabel, type WorldChatState } from "./worldChat";
import {
  saveWorldChatProfile,
  setWorldChatEnabled,
  subscribeWorldChat,
  worldChatEnabled,
  worldChatNick,
  worldChatReachable,
  worldChatSnapshot,
  worldChatStore,
} from "./worldChatRuntime";

export function useWorldChat(): WorldChatState {
  const [state, setState] = useState<WorldChatState>(worldChatSnapshot);
  useEffect(() => subscribeWorldChat(setState), []);
  return state;
}

function shellStyle(): CSSProperties {
  return {
    background: "linear-gradient(145deg, rgba(var(--accent-rgb),.10), var(--bg-card) 48%)",
    border: "1px solid var(--border-strong)",
    borderRadius: 16,
    boxShadow: "var(--shadow-lg)",
    padding: 13,
  };
}

function buttonStyle(tone: "accent" | "plain" | "danger" = "plain"): CSSProperties {
  return {
    borderRadius: 9,
    border: `1px solid ${tone === "danger" ? "var(--error)" : "var(--border-strong)"}`,
    background: tone === "accent" ? "var(--accent-strong)" : "transparent",
    color: tone === "accent" ? "var(--accent-ink)" : tone === "danger" ? "var(--error)" : "var(--fg)",
    fontSize: 11,
    fontWeight: 700,
    padding: "5px 9px",
    cursor: "pointer",
  };
}

type Props = {
  /** The dot the map has selected, if it is a World node rather than a fleet orbit. */
  selectedNodeId: string;
  selectedLabel: string;
};

export default function WorldChatPanel({ selectedNodeId, selectedLabel }: Props) {
  const { t } = useLocalization();
  const chat = useWorldChat();
  const [enabled, setEnabled] = useState(worldChatEnabled);
  const [nick, setNick] = useState(worldChatNick);
  const [reachable, setReachable] = useState(worldChatReachable);
  const [draft, setDraft] = useState("");
  const [invite, setInvite] = useState("");
  const [openRoom, setOpenRoom] = useState("");

  const store = worldChatStore();
  const target = openRoom ? "" : selectedNodeId;
  const key = openRoom ? threadKey("", openRoom) : threadKey(target);
  const messages = useMemo(() => chat.threads[key] ?? [], [chat.threads, key]);
  const sticky = useStickyScroll<HTMLDivElement>(messages.length);

  const isContact = chat.contacts.includes(target);
  const isBlocked = chat.blocked.includes(target);
  const awaitingThem = chat.requested.includes(target);

  const draftRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (target) store.lookup([target]);
  }, [store, target]);

  // Clicking a dot on the globe IS the "message this person" action — there is
  // no second button to hunt for. Selecting one puts the caret in the box, so
  // the click and the first keystroke are one gesture. Only ever fires on a
  // real selection: target starts empty, so mounting the map steals no focus.
  useEffect(() => {
    if (!enabled || openRoom || !target) return;
    draftRef.current?.focus();
  }, [enabled, openRoom, target]);

  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (openRoom) await store.sayToRoom(openRoom, text);
    else if (isContact) await store.say(target, text);
    else await store.request(target, text);
  };

  if (!enabled) {
    return (
      <div style={shellStyle()} data-ui="WorldChat:off">
        <div style={{ color: "var(--fg-strong)", fontWeight: 800, fontSize: 12 }}>💬 {t("World Chat")}</div>
        <div style={{ marginTop: 6, color: "var(--fg-muted)", fontSize: 11.5, lineHeight: 1.45 }}>
          {t("You turned this off. On, it publishes your device's public key so others can encrypt to you — nothing else, and no message is ever readable by the service.")}
        </div>
        <button
          type="button"
          style={{ ...buttonStyle("accent"), marginTop: 9 }}
          data-ui="WorldChat:enable"
          onClick={() => { setWorldChatEnabled(true); setEnabled(true); }}
        >{t("Turn on World Chat")}</button>
      </div>
    );
  }

  return (
    <div style={shellStyle()} data-ui="WorldChat">
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ color: "var(--fg-strong)", fontWeight: 800, fontSize: 12, flex: 1 }}>💬 {t("World Chat")}</div>
        <span style={{ fontSize: 10.5, fontWeight: 700, color: chat.status === "ready" ? "var(--ok, #7ddc9a)" : "var(--fg-muted)" }}>
          {chat.status === "ready" ? t("Connected") : t("Connecting…")}
        </span>
        <button type="button" style={buttonStyle()} data-ui="WorldChat:disable" onClick={() => { setWorldChatEnabled(false); setEnabled(false); }}>
          {t("Turn off")}
        </button>
      </div>

      <div style={{ display: "flex", gap: 6, marginTop: 9, alignItems: "center", flexWrap: "wrap" }}>
        <input
          value={nick}
          onChange={(event) => setNick(event.target.value.slice(0, 32))}
          placeholder={t("Nickname")}
          data-ui="WorldChat:nick"
          style={{ flex: 1, minWidth: 110, borderRadius: 9, border: "1px solid var(--border-strong)", background: "var(--bg-input)", color: "var(--fg)", fontSize: 11.5, padding: "5px 8px" }}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--fg-muted)" }}>
          <input type="checkbox" checked={reachable} data-ui="WorldChat:reachable" onChange={(event) => setReachable(event.target.checked)} />
          {t("Let strangers ask")}
        </label>
        <button type="button" style={buttonStyle("accent")} data-ui="WorldChat:save-profile" onClick={() => saveWorldChatProfile(nick, reachable)}>
          {t("Save")}
        </button>
      </div>

      {chat.requests.length > 0 && (
        <div style={{ marginTop: 10 }} data-ui="WorldChat:requests">
          <div style={{ fontSize: 10.5, fontWeight: 800, color: "var(--fg-muted)", textTransform: "uppercase", letterSpacing: .4 }}>{t("Chat requests")}</div>
          {chat.requests.map((id) => (
            <div key={id} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 5 }}>
              <span style={{ flex: 1, fontSize: 11.5, color: "var(--fg)" }}>{worldChatLabel(chat.peers[id], id)}</span>
              <button type="button" style={buttonStyle("accent")} data-ui="WorldChat:accept" onClick={() => store.accept(id)}>{t("Accept")}</button>
              <button type="button" style={buttonStyle()} data-ui="WorldChat:block" onClick={() => store.block(id)}>{t("Block")}</button>
              <button type="button" style={buttonStyle("danger")} data-ui="WorldChat:report" onClick={() => store.report(id)}>{t("Report")}</button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }} data-ui="WorldChat:rooms">
        <button
          type="button"
          style={{ ...buttonStyle(openRoom ? "plain" : "accent") }}
          data-ui="WorldChat:room-direct"
          onClick={() => setOpenRoom("")}
        >{t("Direct")}</button>
        {chat.rooms.map((room) => (
          <button
            key={room}
            type="button"
            style={buttonStyle(openRoom === room ? "accent" : "plain")}
            data-ui="WorldChat:room-tab"
            onClick={() => { setOpenRoom(room); store.refreshRoom(room); }}
          >{`# ${room.slice(0, 6)}`}</button>
        ))}
        <input
          value={invite}
          onChange={(event) => setInvite(event.target.value)}
          placeholder={t("Invite code")}
          data-ui="WorldChat:invite"
          style={{ width: 110, borderRadius: 9, border: "1px solid var(--border-strong)", background: "var(--bg-input)", color: "var(--fg)", fontSize: 11, padding: "4px 7px" }}
        />
        <button
          type="button"
          style={buttonStyle()}
          data-ui="WorldChat:join"
          onClick={async () => { const room = await store.joinRoom(invite); if (room) { setInvite(""); setOpenRoom(room); } }}
        >{t("Join group")}</button>
      </div>

      <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--fg-strong)", fontWeight: 700 }} data-ui="WorldChat:thread-title">
        {openRoom
          ? `${t("Group")} # ${openRoom.slice(0, 10)}`
          : target
            ? worldChatLabel(chat.peers[target], target) || selectedLabel
            : t("Pick a dot on the map to start a conversation")}
      </div>

      {!openRoom && target && isBlocked && (
        <div style={{ marginTop: 6, fontSize: 11, color: "var(--error)" }}>{t("You blocked this person.")}
          <button type="button" style={{ ...buttonStyle(), marginLeft: 6 }} data-ui="WorldChat:unblock" onClick={() => store.unblock(target)}>{t("Unblock")}</button>
        </div>
      )}

      <div
        ref={sticky.ref}
        onScroll={sticky.onScroll}
        data-ui="WorldChat:thread"
        style={{ marginTop: 7, maxHeight: 190, overflowY: "auto", display: "flex", flexDirection: "column", gap: 5 }}
      >
        {messages.map((message, index) => (
          <div
            key={`${message.id}:${index}`}
            style={{
              alignSelf: message.mine ? "flex-end" : "flex-start",
              maxWidth: "86%",
              borderRadius: 11,
              padding: "5px 9px",
              fontSize: 11.5,
              lineHeight: 1.4,
              background: message.mine ? "var(--accent-strong)" : "var(--bg-input)",
              color: message.mine ? "var(--accent-ink)" : "var(--fg)",
            }}
          >
            {!message.mine && message.room && (
              <div style={{ fontSize: 10, fontWeight: 800, opacity: .75 }}>{worldChatLabel(chat.peers[message.from], message.from)}</div>
            )}
            {message.text}
          </div>
        ))}
      </div>

      {(openRoom || target) && !isBlocked && (
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <input
            ref={draftRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }}
            placeholder={openRoom || isContact ? t("Message") : awaitingThem ? t("Waiting for them to accept") : t("Say hello — they must accept first")}
            data-ui="WorldChat:draft"
            style={{ flex: 1, borderRadius: 9, border: "1px solid var(--border-strong)", background: "var(--bg-input)", color: "var(--fg)", fontSize: 11.5, padding: "6px 9px" }}
          />
          <button type="button" style={buttonStyle("accent")} data-ui="WorldChat:send" onClick={() => void submit()}>
            {openRoom || isContact ? t("Send") : t("Ask")}
          </button>
        </div>
      )}

      {chat.error && (
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--error)" }} data-ui="WorldChat:error">
          {chat.error}
          <button type="button" style={{ ...buttonStyle(), marginLeft: 6 }} onClick={() => store.clearError()}>{t("Dismiss")}</button>
        </div>
      )}
    </div>
  );
}
