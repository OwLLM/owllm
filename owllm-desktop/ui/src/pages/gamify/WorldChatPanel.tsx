// The World Map chat surface.
//
// Kept in its own module so it can be mounted and driven without the globe,
// the WebGL context, or a live relay behind it.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { useStickyScroll } from "../../hooks/useStickyScroll";
import { readAppLanguage, useLocalization } from "../../localization";
import { threadKey, worldChatConversations, worldChatLabel, type WorldChatState } from "./worldChat";
import {
  saveWorldChatProfile,
  setWorldChatEnabled,
  subscribeWorldChat,
  worldChatEnabled,
  worldChatNick,
  worldChatReachable,
  worldChatSnapshot,
  worldChatStore,
  WORLD_CHAT_OPEN_EVENT,
  type WorldChatOpenEventDetail,
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

/**
 * When a line was said. Today's messages show the clock; anything older also
 * shows the date, because "14:02" on its own is a lie about a message from
 * last week.
 */
function messageStamp(ts: string): string {
  if (!ts) return "";
  const at = new Date(ts);
  if (Number.isNaN(at.getTime())) return "";
  const language = readAppLanguage();
  const clock = at.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit", hour12: false });
  const now = new Date();
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return sameDay ? clock : `${at.toLocaleDateString(language, { day: "2-digit", month: "short" })} ${clock}`;
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
  // A conversation opened from the inbox rather than by clicking a dot. The
  // globe cannot be the only way back into a chat: the person who wrote to you
  // may not be on screen, may be off the map entirely, and after a restart you
  // would have no idea which dot they were.
  const [pickedPeer, setPickedPeer] = useState("");
  // Nickname, reachability and group invites are setup, not conversation. They
  // are folded away so the card reads as a chat rather than a settings form
  // with a one-line box wedged underneath it.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The card floats over the globe, so while it is open it is also a hole in
  // the map: a dot underneath it cannot be clicked, which reads as "the chat
  // is stuck on the first person I picked". Collapsing folds it back to its
  // header and hands that area of the globe back.
  const [collapsed, setCollapsed] = useState(false);

  const store = worldChatStore();
  const target = openRoom ? "" : (pickedPeer || selectedNodeId);
  const key = openRoom ? threadKey("", openRoom) : threadKey(target);
  const messages = useMemo(() => chat.threads[key] ?? [], [chat.threads, key]);
  const sticky = useStickyScroll<HTMLDivElement>(messages.length);
  const conversations = useMemo(() => worldChatConversations(chat), [chat]);

  // Clicking a dot on the globe always wins over whatever the inbox had open,
  // otherwise selecting someone would appear to do nothing.
  useEffect(() => { if (selectedNodeId) { setPickedPeer(""); setOpenRoom(""); } }, [selectedNodeId]);

  // The chrome's notice points at one conversation; opening it lands here.
  useEffect(() => {
    const onOpen = (event: Event) => {
      const wanted = (event as CustomEvent<WorldChatOpenEventDetail>).detail?.key ?? "";
      if (!wanted) return;
      setCollapsed(false);
      if (wanted.startsWith("room:")) { setOpenRoom(wanted.slice(5)); setPickedPeer(""); }
      else { setOpenRoom(""); setPickedPeer(wanted); }
    };
    window.addEventListener(WORLD_CHAT_OPEN_EVENT, onOpen as EventListener);
    return () => window.removeEventListener(WORLD_CHAT_OPEN_EVENT, onOpen as EventListener);
  }, []);

  // Looking at a thread is what marks it read — nothing else does, so a notice
  // can never be cleared by a message the user did not actually see.
  useEffect(() => {
    if (!enabled || collapsed || !key) return;
    store.markRead(key);
  }, [enabled, collapsed, key, messages.length, store]);

  const isContact = chat.contacts.includes(target);
  const isBlocked = chat.blocked.includes(target);
  const awaitingThem = chat.requested.includes(target);
  const peer = chat.peers[target];
  const isSelf = Boolean(target && target === chat.selfId);
  const hasKeys = Boolean(peer?.edPub && peer?.xPub);
  const missingFleet = Boolean(!openRoom && !target && selectedLabel);

  const draftRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (target) store.lookup([target]);
  }, [store, target]);

  // Clicking a dot on the globe IS the "message this person" action — there is
  // no second button to hunt for. Selecting one puts the caret in the box, so
  // the click and the first keystroke are one gesture. Only ever fires on a
  // real selection: target starts empty, so mounting the map steals no focus.
  useEffect(() => {
    if (!enabled || openRoom || !target) return;
    // Picking someone new always brings the card back: a collapsed card that
    // silently changed who it was addressed to would be worse than no change.
    // Focus is a separate effect because the box does not exist to receive it
    // until the expanded body has actually rendered.
    setCollapsed(false);
  }, [enabled, openRoom, target]);

  useEffect(() => {
    if (!enabled || collapsed || openRoom || !target) return;
    draftRef.current?.focus();
  }, [enabled, collapsed, openRoom, target]);

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
        {!collapsed && (
          <button type="button" style={buttonStyle()} data-ui="WorldChat:settings" title={t("Chat settings")} onClick={() => setSettingsOpen((open) => !open)}>
            ⚙
          </button>
        )}
        {/* Folds the card away so the globe underneath it is clickable again. */}
        <button
          type="button"
          style={buttonStyle()}
          data-ui="WorldChat:collapse"
          title={collapsed ? t("Show chat") : t("Hide chat — makes the globe underneath clickable")}
          onClick={() => setCollapsed((value) => !value)}
        >{collapsed ? "▴" : "▾"}</button>
      </div>

      {!collapsed && settingsOpen && (
        <div style={{ display: "flex", gap: 6, marginTop: 9, alignItems: "center", flexWrap: "wrap" }} data-ui="WorldChat:settings-panel">
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
          <input
            value={invite}
            onChange={(event) => setInvite(event.target.value)}
            placeholder={t("Invite code")}
            data-ui="WorldChat:invite"
            style={{ flex: 1, minWidth: 110, borderRadius: 9, border: "1px solid var(--border-strong)", background: "var(--bg-input)", color: "var(--fg)", fontSize: 11, padding: "4px 7px" }}
          />
          <button
            type="button"
            style={buttonStyle()}
            data-ui="WorldChat:join"
            onClick={async () => { const room = await store.joinRoom(invite); if (room) { setInvite(""); setOpenRoom(room); } }}
          >{t("Join group")}</button>
          <button type="button" style={buttonStyle()} data-ui="WorldChat:disable" onClick={() => { setWorldChatEnabled(false); setEnabled(false); }}>
            {t("Turn off World Chat")}
          </button>
        </div>
      )}

      {!collapsed && (
      <>
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

      {/* The inbox. Every conversation this device has ever had, newest first,
          with who, the last line, when, and how many are unread. Without it the
          only route back to a message was finding the sender's dot on the globe
          again — which does not survive them going offline, or a restart. */}
      {conversations.length > 0 && (
        <div style={{ marginTop: 10 }} data-ui="WorldChat:inbox">
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ flex: 1, fontSize: 10.5, fontWeight: 800, color: "var(--fg-muted)", textTransform: "uppercase", letterSpacing: .4 }}>
              {t("Conversations")}
            </div>
            {conversations.some((entry) => entry.unread > 0) && (
              <button type="button" style={buttonStyle()} data-ui="WorldChat:mark-all-read" onClick={() => store.markAllRead()}>
                {t("Mark all read")}
              </button>
            )}
          </div>
          <div style={{ marginTop: 5, maxHeight: 132, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
            {conversations.map((entry) => (
              <button
                key={entry.key}
                type="button"
                data-ui="WorldChat:conversation"
                onClick={() => {
                  if (entry.room) { setOpenRoom(entry.room); setPickedPeer(""); }
                  else { setOpenRoom(""); setPickedPeer(entry.peerId); }
                }}
                style={{
                  display: "flex", alignItems: "baseline", gap: 7, width: "100%", textAlign: "left",
                  borderRadius: 9, cursor: "pointer", padding: "4px 7px",
                  border: `1px solid ${entry.key === key ? "var(--accent-strong)" : "transparent"}`,
                  background: entry.key === key ? "rgba(var(--accent-rgb),.12)" : "transparent",
                  color: "var(--fg)",
                }}
              >
                <span style={{ fontWeight: entry.unread ? 800 : 700, fontSize: 11.5, color: "var(--fg-strong)", whiteSpace: "nowrap" }}>
                  {entry.label || t("Unknown")}
                </span>
                <span style={{ flex: 1, fontSize: 11, color: "var(--fg-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {entry.last?.mine ? `${t("You")}: ` : ""}{entry.last?.text ?? ""}
                </span>
                <span style={{ fontSize: 10, color: "var(--fg-muted)", whiteSpace: "nowrap" }}>{messageStamp(entry.last?.ts ?? "")}</span>
                {entry.unread > 0 && (
                  <span
                    data-ui="WorldChat:unread"
                    style={{ minWidth: 16, textAlign: "center", borderRadius: 999, background: "var(--accent-strong)", color: "var(--accent-ink)", fontSize: 10, fontWeight: 800, padding: "1px 5px" }}
                  >{entry.unread}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Only worth the vertical space once the user actually belongs to a
          group — with none joined this row was a lone "Direct" button naming
          the only mode there is. */}
      {chat.rooms.length > 0 && (
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
        </div>
      )}

      {/* Only rendered once there is someone to name. With nothing selected the
          empty thread below already says what to do, and a heading repeating it
          made the card look like it was stuttering. */}
      {(openRoom || target) && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--fg-strong)", fontWeight: 700 }} data-ui="WorldChat:thread-title">
          {openRoom
            ? `${t("Group")} # ${openRoom.slice(0, 10)}`
            : worldChatLabel(chat.peers[target], target) || selectedLabel}
        </div>
      )}
      {(missingFleet || isSelf || (!openRoom && target && !hasKeys)) && (
        <div style={{ marginTop: 5, fontSize: 10.5, color: "var(--fg-muted)", lineHeight: 1.4 }} data-ui="WorldChat:hint">
          {missingFleet
            ? t("This device has no world-presence id, so it cannot be messaged from the map.")
            : isSelf
            ? t("This dot is you — you cannot message yourself.")
            : !openRoom && !hasKeys
            ? t("This node has not enabled World Chat, so it cannot receive messages.")
            : null}
        </div>
      )}

      {!openRoom && target && isBlocked && (
        <div style={{ marginTop: 6, fontSize: 11, color: "var(--error)" }}>{t("You blocked this person.")}
          <button type="button" style={{ ...buttonStyle(), marginLeft: 6 }} data-ui="WorldChat:unblock" onClick={() => store.unblock(target)}>{t("Unblock")}</button>
        </div>
      )}

      <div
        ref={sticky.ref}
        onScroll={sticky.onScroll}
        data-ui="WorldChat:thread"
        style={{ marginTop: 7, minHeight: 132, maxHeight: 280, overflowY: "auto", display: "flex", flexDirection: "column", gap: 5, justifyContent: messages.length ? "flex-start" : "center" }}
      >
        {messages.length === 0 && (
          <div style={{ textAlign: "center", color: "var(--fg-muted)", fontSize: 11, lineHeight: 1.5, padding: "0 10px" }} data-ui="WorldChat:thread-empty">
            {openRoom || target
              ? t("No messages yet. Say something.")
              : t("Every gold dot is someone running OwLLM. Click one to talk to them.")}
          </div>
        )}
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
            {/* Who and when, on every line. A history with neither is a wall
                of text you cannot place. */}
            <div style={{ display: "flex", gap: 7, alignItems: "baseline", fontSize: 10, fontWeight: 800, opacity: .75 }} data-ui="WorldChat:message-meta">
              <span>{message.mine ? t("You") : worldChatLabel(chat.peers[message.from], message.from)}</span>
              <span style={{ fontWeight: 600 }}>{messageStamp(message.ts)}</span>
            </div>
            {message.text}
          </div>
        ))}
      </div>

      {(openRoom || target) && !isBlocked && !isSelf && (openRoom || hasKeys) && (
        <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "stretch" }}>
          {/* A textarea, not a single-line input: Enter sends, Shift+Enter
              keeps writing, so a paragraph is possible without the message
              leaving half-typed. */}
          <textarea
            ref={draftRef}
            value={draft}
            rows={2}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }}
            placeholder={openRoom || isContact ? t("Message") : awaitingThem ? t("Waiting for them to accept") : t("Say hello — this is a first message, they choose whether to reply")}
            data-ui="WorldChat:draft"
            style={{ flex: 1, resize: "none", borderRadius: 9, border: "1px solid var(--border-strong)", background: "var(--bg-input)", color: "var(--fg)", fontSize: 11.5, lineHeight: 1.4, padding: "6px 9px", fontFamily: "inherit" }}
          />
          {/* Always "Send". The relay still gates a first message on the other
              side accepting, but that is the protocol's business — calling the
              button "Ask" only made the user wonder what they were asking. */}
          <button type="button" style={{ ...buttonStyle("accent"), padding: "5px 13px" }} data-ui="WorldChat:send" onClick={() => void submit()}>
            {t("Send")}
          </button>
        </div>
      )}

      {chat.error && (
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--error)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }} data-ui="WorldChat:error">
          <span>{chat.error}</span>
          <button type="button" style={buttonStyle()} onClick={() => store.clearError()}>{t("Dismiss")}</button>
        </div>
      )}
      </>
      )}
    </div>
  );
}
