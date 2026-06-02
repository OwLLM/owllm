"""Super User card — single chat-style card that combines:
  * presence indicator (idle / attention with pulsing border)
  * inline mini chat log of recent user ↔ orchestrator exchanges
  * reply input + Send button (pipes through the main goal pipeline)
  * permissions toggle (auto-approve all OR ask each time)
  * external-notify settings access (gear button)

Lives at the bottom of the right pane on the Agents tab — under the
agent's info / log surface, so the user-side controls sit alongside
the team-side context.
"""
from __future__ import annotations

from typing import List, Optional

from PySide6.QtCore import QEvent, QObject, QPoint, Qt, QTimer, Signal
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QCheckBox,
    QDialog,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)


# ---------------------------------------------------------------------------
# Stylesheets — three states: idle, attention (alternating colors), trust ON
# ---------------------------------------------------------------------------


_BASE_QSS = """
QFrame#SuperUserCard {{
    background-color: #11151e;
    border: {border};
    border-radius: 12px;
}}
QLabel#suAvatar {{
    background-color: #1a2030;
    border-radius: 16px;
    font-size: 18px;
    qproperty-alignment: AlignCenter;
}}
QLabel#suName  {{ color: #e6f0ff; font-weight:700; background:transparent; }}
QLabel#suHint  {{ color: #6b7794; font-size:12px; background:transparent;
                  letter-spacing:0.4px; text-transform:uppercase; }}
QTextEdit#suChat {{
    background:#0a0d14;
    color:#cbd2e0;
    border:1px solid #1d2434;
    border-radius:8px;
    padding:8px 10px;
    font-size:15px;
}}
QLineEdit#suReply {{
    background-color: #0a0d14; color: #e6f0ff;
    border: 1px solid #2a3148; border-radius: 8px;
    padding: 6px 10px; font-size: 14px;
}}
QLineEdit#suReply:focus {{ border-color: #5cf0ff; }}
QLineEdit#suReply:disabled {{ color: #5a6478; }}
QPushButton#suSend {{
    color: #0a0d14; background-color: #5cf0ff;
    border: 1px solid #5cf0ff; border-radius: 8px;
    padding: 6px 14px; font-size: 13px; font-weight: 700;
}}
QPushButton#suSend:hover {{ background-color: #7df3ff; }}
QPushButton#suSend:disabled {{
    color:#5a6478; background-color:#1a2030; border-color:#2a3148;
}}
QPushButton#suIconBtn {{
    background:#1a2030; color:#e6f0ff;
    border:1px solid #2a3148; border-radius:6px;
    font-family: "Segoe UI Symbol", "Segoe UI", sans-serif;
    font-size:16px; font-weight:700;
    padding:0;
}}
QPushButton#suIconBtn:hover {{
    background:#22293c; color:#5cf0ff; border-color:#5cf0ff;
}}
QPushButton#suIconBtn:pressed {{ background:#0f1320; }}
QCheckBox#suTrust {{ color: #7888a8; background:transparent; font-size:13px; }}
QCheckBox#suTrust::indicator {{
    width:12px; height:12px;
    border-radius:3px; border:1px solid #5a6478;
    background-color:#0a0d14;
}}
QCheckBox#suTrust:checked {{ color:#ff8c8c; }}
QCheckBox#suTrust::indicator:checked {{
    background-color:#ff6060; border-color:#ff6060;
}}
"""

_IDLE = _BASE_QSS.format(border="1px solid #1d2434")
_ATTN_A = _BASE_QSS.format(border="2px solid #ffc060")
_ATTN_B = _BASE_QSS.format(border="2px solid #5cf0ff")
# "Team working" pulse — calmer than the urgent ATTN alternation; the
# user should see "yes, something is happening" without it screaming
# for input. Slow alternation between two blue tones.
_WORK_A = _BASE_QSS.format(border="2px solid #2a4d7a")
_WORK_B = _BASE_QSS.format(border="2px solid #3b6fa8")


class SuperUserCard(QFrame):
    """Single chat-style card — the user's home base on the Agents tab.

    Signals:
      * ``reply_submitted(str)`` — user pressed Enter / Send. Page wires
        this to the goal pipeline.
      * ``supervisor_toggled(bool)`` — auto-approve checkbox flipped.
      * ``settings_clicked()`` — gear opened. Page opens notify settings.
    """

    reply_submitted = Signal(str)
    supervisor_toggled = Signal(bool)
    settings_clicked = Signal()
    enlarge_clicked = Signal()
    """User clicked the enlarge icon — page opens a side-panel dialog
    that mirrors the chat. Two-way: the dialog's reply input emits
    back through ``reply_submitted`` so the goal pipeline doesn't
    care which surface the user typed into."""
    messages_changed = Signal()
    """Fires after every ``_append_message`` so the open dialog (if any)
    can re-render. Cheap signal — no payload."""

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setObjectName("SuperUserCard")
        self.setStyleSheet(_IDLE)
        self.setMinimumHeight(180)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(12, 10, 12, 10)
        outer.setSpacing(8)

        outer.addLayout(self._build_header())
        outer.addWidget(self._build_chat())
        outer.addLayout(self._build_input())
        outer.addLayout(self._build_trust_row())

        # Pulsing border timer for the attention state.
        self._blink = QTimer(self)
        self._blink.setInterval(700)
        self._blink.timeout.connect(self._toggle_blink)
        self._blink_phase = False
        self._attention = False
        # Working state runs its own slower pulse so the team-busy
        # indication is visually distinct from "team needs you NOW".
        self._working = False
        self._working_blink = QTimer(self)
        self._working_blink.setInterval(1200)
        self._working_blink.timeout.connect(self._toggle_working_blink)
        self._working_phase = False
        self._working_label = ""

        self._messages: List[tuple] = []  # (role, text) chronological
        self._refresh_chat()

    # ------------------------------------------------------------------
    # UI scaffolding
    # ------------------------------------------------------------------

    def _build_header(self) -> QHBoxLayout:
        # Compact header: the canvas overlay caps the card at ~320 px, so
        # avatar + title + 3 controls quickly run out of room. Auto-approve
        # has been moved to its own row below the chat — the header now
        # holds only the identity + the two icon buttons (enlarge, gear).
        row = QHBoxLayout()
        row.setSpacing(6)

        avatar = QLabel("👤")
        avatar.setObjectName("suAvatar")
        avatar.setFixedSize(28, 28)
        row.addWidget(avatar)

        name_block = QVBoxLayout()
        name_block.setSpacing(0)
        self._name = QLabel("Super User")
        self._name.setObjectName("suName")
        nf = QFont()
        nf.setPointSize(12)
        nf.setBold(True)
        self._name.setFont(nf)
        name_block.addWidget(self._name)

        self._hint = QLabel("idle — team pings you here")
        self._hint.setObjectName("suHint")
        name_block.addWidget(self._hint)
        row.addLayout(name_block, 1)

        # Enlarge — use a 3-char ASCII glyph because the BMP-arrow code
        # points (⤢ / ⛶ / 🗗) fall back to dotted-square or empty boxes
        # on many Windows fonts at 14 px, which is what produced the
        # "two blank squares" the user saw.
        self._enlarge = QPushButton("⇱⇲")
        self._enlarge.setObjectName("suIconBtn")
        self._enlarge.setFixedSize(30, 26)
        self._enlarge.setToolTip(
            "Open chat in a side panel (4:5, full window height, docked right)"
        )
        self._enlarge.clicked.connect(self.enlarge_clicked)
        row.addWidget(self._enlarge)

        # Gear — single ⚙ renders reliably in Segoe UI Symbol at 16 px.
        self._gear = QPushButton("⚙")
        self._gear.setObjectName("suIconBtn")
        self._gear.setFixedSize(26, 26)
        self._gear.setToolTip("Notification settings (Telegram, etc.)")
        self._gear.clicked.connect(self.settings_clicked)
        row.addWidget(self._gear)
        return row

    def _build_trust_row(self) -> QHBoxLayout:
        """Auto-approve toggle moved out of the header into its own row
        so the header can fit the title + enlarge + gear in the narrow
        overlay card."""
        row = QHBoxLayout()
        row.setSpacing(6)
        self._trust = QCheckBox("auto-approve tool requests")
        self._trust.setObjectName("suTrust")
        self._trust.setToolTip(
            "When on, every tool request from the team resolves APPROVE "
            "without surfacing a prompt. Per-project; off by default."
        )
        self._trust.toggled.connect(self.supervisor_toggled)
        row.addWidget(self._trust)
        row.addStretch(1)
        return row

    def _build_chat(self) -> QTextEdit:
        self._chat = QTextEdit()
        self._chat.setObjectName("suChat")
        self._chat.setReadOnly(True)
        self._chat.setFixedHeight(80)
        return self._chat

    def _build_input(self) -> QHBoxLayout:
        row = QHBoxLayout()
        row.setSpacing(8)

        self._reply = QLineEdit()
        self._reply.setObjectName("suReply")
        self._reply.setPlaceholderText("Reply to the team — Enter to send")
        self._reply.returnPressed.connect(self._on_submit)
        row.addWidget(self._reply, 1)

        self._send = QPushButton("Send")
        self._send.setObjectName("suSend")
        self._send.clicked.connect(self._on_submit)
        row.addWidget(self._send)
        return row

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def set_attention(self, on: bool, body: str = "") -> None:
        """Switch between idle and pulsing-attention. Auto-focuses the
        reply field on attention so the user can type immediately.

        Attention wins over the working pulse — when the team needs
        input, that signal is urgent. The working pulse resumes when
        attention is cleared (if the run is still in flight).
        """
        self._attention = bool(on)
        if on:
            self._hint.setText(body or "the team is waiting for you")
            self._blink_phase = False
            self.setStyleSheet(_ATTN_A)
            if self._working_blink.isActive():
                self._working_blink.stop()
            if not self._blink.isActive():
                self._blink.start()
            if self._reply.isEnabled():
                self._reply.setFocus()
            if body:
                self._append_message("orchestrator", body)
        else:
            if self._blink.isActive():
                self._blink.stop()
            # If the team is still working, fall back to the working
            # pulse rather than IDLE so the user keeps seeing "busy".
            if self._working:
                self._enter_working_visual()
            else:
                self._hint.setText("idle — the team pings you here when it needs input")
                self.setStyleSheet(_IDLE)

    def set_working(self, on: bool, label: str = "") -> None:
        """Switch the card into "team busy" mode (or out of it).

        While working, the reply field STAYS enabled — the user can talk
        to the team mid-run (the goal pipeline stages or routes the
        reply). A slow blue pulse on the card border + the hint text
        carries the "yes, something is happening" signal without
        screaming for input the way ``set_attention`` does.

        ``label`` (optional): short status, e.g. "orchestrator → coder".
        Falls back to a generic "team working…" when empty.
        """
        self._working = bool(on)
        self._working_label = (label or "").strip()
        if on:
            # If attention is active, don't override its visual — just
            # remember we're working so we resume the pulse when
            # attention clears.
            if not self._attention:
                self._enter_working_visual()
        else:
            if self._working_blink.isActive():
                self._working_blink.stop()
            self._working_label = ""
            if not self._attention:
                self._hint.setText("idle — the team pings you here when it needs input")
                self.setStyleSheet(_IDLE)

    def _enter_working_visual(self) -> None:
        """Paint the working state. Caller has confirmed attention isn't active."""
        hint = self._working_label or "team working… reply anytime to nudge"
        self._hint.setText(hint)
        self._working_phase = False
        self.setStyleSheet(_WORK_A)
        if not self._working_blink.isActive():
            self._working_blink.start()

    def set_reply_enabled(self, enabled: bool) -> None:
        """Enable/disable the reply input. The agents page used to call
        this with ``False`` while a run was in flight, which made the
        team's ``set_attention`` prompts unactionable (the focused
        reply field was disabled). The reply field is now ALWAYS
        enabled when a project is loaded; ``set_working(True)`` is the
        right call for run-in-flight state.
        """
        self._reply.setEnabled(enabled)
        self._send.setEnabled(enabled)

    def set_supervisor_state(self, on: bool) -> None:
        """Set the auto-approve checkbox without firing the signal."""
        self._trust.blockSignals(True)
        self._trust.setChecked(bool(on))
        self._trust.blockSignals(False)

    def append_user_message(self, text: str) -> None:
        """Record a message the user just sent (for the mini chat log)."""
        if not text:
            return
        self._append_message("user", text)

    def append_assistant_message(self, text: str) -> None:
        """Record a message the orchestrator sent back to the user."""
        if not text:
            return
        self._append_message("orchestrator", text)

    def clear_chat(self) -> None:
        self._messages.clear()
        self._refresh_chat()
        self.messages_changed.emit()

    def messages_snapshot(self) -> List[tuple]:
        """Return a copy of the current message log (for SuperUserDialog)."""
        return list(self._messages)

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _on_submit(self) -> None:
        text = (self._reply.text() or "").strip()
        if not text:
            return
        self._reply.clear()
        self._append_message("user", text)
        self.reply_submitted.emit(text)

    def _toggle_blink(self) -> None:
        self._blink_phase = not self._blink_phase
        self.setStyleSheet(_ATTN_B if self._blink_phase else _ATTN_A)

    def _toggle_working_blink(self) -> None:
        self._working_phase = not self._working_phase
        self.setStyleSheet(_WORK_B if self._working_phase else _WORK_A)

    def _append_message(self, role: str, text: str) -> None:
        # Cap history at 20 entries so the mini log stays small.
        cleaned = text.strip()
        if not cleaned:
            return
        # Dedupe consecutive duplicates. Two paths can call us with the
        # same message in quick succession:
        #   - User types a reply in this card: _on_submit appends locally
        #     AND emits reply_submitted, whose handler routes through the
        #     goal pipeline which calls append_user_message → second
        #     append of the same text.
        #   - The team prompts the user via set_attention(True, body=msg);
        #     if the same prompt fires twice (e.g. timer + bus re-publish)
        #     we'd otherwise see "Orchestrator: …" twice.
        # Defensive single check beats coordinating which path is the
        # "authoritative" one.
        if self._messages and self._messages[-1] == (role, cleaned):
            return
        self._messages.append((role, cleaned))
        if len(self._messages) > 20:
            self._messages = self._messages[-20:]
        self._refresh_chat()
        # Notify any open SuperUserDialog so it re-renders with the
        # new message. Cheap no-op if nobody's listening.
        self.messages_changed.emit()

    def _refresh_chat(self) -> None:
        if not self._messages:
            self._chat.setHtml(
                '<div style="color:#5a6478; font-size:14px;">'
                'no messages yet — type below to start, or wait for the team to ping</div>'
            )
            return
        lines = []
        for role, text in self._messages[-6:]:
            color = "#5cf0ff" if role == "user" else "#ffc060"
            label = "You" if role == "user" else "Team"
            safe = (
                text.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\n", "<br>")
            )
            lines.append(
                f'<div style="margin:0 0 6px 0;">'
                f'<span style="color:{color}; font-weight:700;">{label}:</span> '
                f'<span style="color:#cbd2e0;">{safe}</span>'
                f'</div>'
            )
        self._chat.setHtml("".join(lines))
        # Scroll to bottom.
        sb = self._chat.verticalScrollBar()
        sb.setValue(sb.maximum())


# ---------------------------------------------------------------------------
# Side-panel popout — opened by the card's enlarge button
# ---------------------------------------------------------------------------


_DIALOG_QSS = """
QDialog#SuperUserDialog {
    background-color: #0a0d14;
    border: 1px solid #2a3148;
    border-radius: 12px;
}
QWidget#sudTitleBar {
    background: qlineargradient(
        x1:0, y1:0, x2:0, y2:1,
        stop:0 #1a2030, stop:1 #11151e
    );
    border-top-left-radius: 12px;
    border-top-right-radius: 12px;
    border-bottom: 1px solid #1d2434;
}
QLabel#sudTitleText {
    color: #e6f0ff; font-weight: 700; font-size: 13px;
    background: transparent; letter-spacing: 0.5px;
}
QLabel#sudTitleDot { color: #5cf0ff; background: transparent; font-size: 18px; }
QPushButton#sudTitleBtn {
    background: transparent; color: #8694b3;
    border: none; font-size: 16px;
    font-family: "Segoe UI Symbol", "Segoe UI", sans-serif;
}
QPushButton#sudTitleBtn:hover { color: #e6f0ff; background: #22293c; }
QPushButton#sudCloseBtn {
    background: transparent; color: #8694b3;
    border: none; font-size: 16px; font-weight: 700;
}
QPushButton#sudCloseBtn:hover { color: #ffffff; background: #c03030; }
QLabel#sudHint { color: #6b7794; font-size: 13px; background: transparent; }
QTextEdit#sudChat {
    background: #11151e;
    color: #cbd2e0;
    border: 1px solid #1d2434;
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 16px;
}
QLineEdit#sudReply {
    background-color: #11151e; color: #e6f0ff;
    border: 1px solid #2a3148; border-radius: 8px;
    padding: 8px 12px; font-size: 16px;
}
QLineEdit#sudReply:focus { border-color: #5cf0ff; }
QPushButton#sudSend {
    color: #0a0d14; background-color: #5cf0ff;
    border: 1px solid #5cf0ff; border-radius: 8px;
    padding: 8px 18px; font-size: 14px; font-weight: 700;
}
QPushButton#sudSend:hover { background-color: #7df3ff; }
"""


class SuperUserDialog(QDialog):
    """Larger side-panel view of the SuperUserCard's chat.

    Layout: same chat log + reply input as the card, but full-window-
    height on the right, with a 4:5 aspect ratio (width = height * 4/5).
    Stays in sync with the card via the card's ``messages_changed``
    signal; reply submissions route back through the card so the goal
    pipeline doesn't have a second code path to maintain.

    Non-modal — the user can keep it open while looking at the canvas.
    """

    def __init__(self, card: "SuperUserCard", parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self._card = card
        self.setObjectName("SuperUserDialog")
        self.setStyleSheet(_DIALOG_QSS)
        self.setWindowTitle("Super User — chat")
        # Frameless so the popup wears the same dark chrome as the main
        # OWLLM window (which also uses FramelessWindowHint and paints
        # its own title bar). The native Windows title bar would have
        # forced a white / OS-themed strip at the top, breaking the app
        # look. Custom title bar + manual resize edges below cover the
        # missing native chrome behavior.
        self.setWindowFlags(Qt.Window | Qt.FramelessWindowHint)
        self.setAttribute(Qt.WA_TranslucentBackground, False)
        self.setModal(False)
        self.setMinimumSize(360, 320)
        # 8 px hit zone on every edge for resize cursors.
        self._resize_margin = 8
        self._resize_edge: Optional[str] = None
        self._resize_start_pos = None
        self._resize_start_geom = None
        self.setMouseTracking(True)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(1, 1, 1, 1)  # leave room for the 1 px border
        outer.setSpacing(0)
        outer.addWidget(self._build_title_bar())

        body = QWidget()
        body_layout = QVBoxLayout(body)
        body_layout.setContentsMargins(14, 12, 14, 14)
        body_layout.setSpacing(10)

        self._hint = QLabel("Side panel — mirrors the Super User card, full conversation visible.")
        self._hint.setObjectName("sudHint")
        body_layout.addWidget(self._hint)

        self._chat = QTextEdit()
        self._chat.setObjectName("sudChat")
        self._chat.setReadOnly(True)
        body_layout.addWidget(self._chat, 1)

        input_row = QHBoxLayout()
        input_row.setSpacing(8)
        self._reply = QLineEdit()
        self._reply.setObjectName("sudReply")
        self._reply.setPlaceholderText("Reply to the team — Enter to send")
        self._reply.returnPressed.connect(self._on_submit)
        input_row.addWidget(self._reply, 1)

        self._send = QPushButton("Send")
        self._send.setObjectName("sudSend")
        self._send.clicked.connect(self._on_submit)
        input_row.addWidget(self._send)
        body_layout.addLayout(input_row)

        outer.addWidget(body, 1)

        # Wire up card -> dialog refresh + cleanup.
        card.messages_changed.connect(self._refresh)
        self._refresh()

    def _build_title_bar(self) -> QWidget:
        """Custom dark title bar matching the OWLLM main-window chrome.

        Drag the bar to move the dialog; the × button closes it. The
        cyan dot mirrors the accent used throughout the app."""
        bar = QWidget()
        bar.setObjectName("sudTitleBar")
        bar.setFixedHeight(34)
        bar.setMouseTracking(True)
        bar._is_title_bar = True  # type: ignore[attr-defined]

        row = QHBoxLayout(bar)
        row.setContentsMargins(12, 0, 6, 0)
        row.setSpacing(8)

        dot = QLabel("●")
        dot.setObjectName("sudTitleDot")
        row.addWidget(dot)

        title = QLabel("Super User — chat")
        title.setObjectName("sudTitleText")
        row.addWidget(title)
        row.addStretch(1)

        # Re-dock button: snap back to the right edge of the main window
        # in case the user dragged the popup somewhere else.
        self._dock_btn = QPushButton("⇲")
        self._dock_btn.setObjectName("sudTitleBtn")
        self._dock_btn.setFixedSize(28, 24)
        self._dock_btn.setToolTip("Re-dock against the main window")
        self._dock_btn.clicked.connect(self._on_redock_clicked)
        row.addWidget(self._dock_btn)

        close_btn = QPushButton("✕")
        close_btn.setObjectName("sudCloseBtn")
        close_btn.setFixedSize(28, 24)
        close_btn.setToolTip("Close")
        close_btn.clicked.connect(self.close)
        row.addWidget(close_btn)

        # Title-bar drag — wire to the dialog's move logic.
        bar.mousePressEvent = self._title_mouse_press      # type: ignore[assignment]
        bar.mouseMoveEvent = self._title_mouse_move        # type: ignore[assignment]
        bar.mouseReleaseEvent = self._title_mouse_release  # type: ignore[assignment]

        self._title_drag_offset: Optional[QPoint] = None
        return bar

    def _on_redock_clicked(self) -> None:
        if self._anchor is not None:
            self._user_resized = False
            self._reposition_against_anchor()

    # ------- title-bar drag handlers ----------
    def _title_mouse_press(self, ev) -> None:
        if ev.button() == Qt.LeftButton:
            self._title_drag_offset = ev.globalPosition().toPoint() - self.frameGeometry().topLeft()
            ev.accept()

    def _title_mouse_move(self, ev) -> None:
        if self._title_drag_offset is not None and (ev.buttons() & Qt.LeftButton):
            self.move(ev.globalPosition().toPoint() - self._title_drag_offset)
            self._user_resized = True  # they moved it; stop auto-tracking
            ev.accept()

    def _title_mouse_release(self, ev) -> None:
        self._title_drag_offset = None
        ev.accept()

    # ------------------------------------------------------------------
    # Sizing / positioning
    # ------------------------------------------------------------------

    def place_against(self, anchor: QWidget) -> None:
        """Position the dialog flush to the right of ``anchor`` (typically
        the main window), same top Y, same height. Width = height * 4/5
        per the user's 4:5 aspect-ratio spec.

        Also installs an event filter on ``anchor`` so the dialog tracks
        the main window when it's moved or resized — the popout stays
        glued to the right edge instead of being orphaned mid-screen.
        After the user resizes the dialog manually, auto-tracking turns
        off (we don't fight their explicit sizing choice).
        """
        if anchor is None:
            return
        ag = anchor.frameGeometry()
        height = ag.height()
        width = int(height * 4 / 5)
        # Available screen width caps the right edge so the dialog
        # stays on-screen even when the main window is near the
        # right edge.
        screen = self.screen() or anchor.screen()
        if screen is not None:
            avail = screen.availableGeometry()
            max_x = avail.right() - width
            x = min(ag.right(), max_x)
            y = max(avail.top(), ag.top())
        else:
            x = ag.right()
            y = ag.top()
        self.setGeometry(x, y, width, height)

        # Re-arm follow-anchor mode: every fresh place_against() call
        # (i.e. user clicking ⛶ again) restores the docked behavior.
        self._user_resized = False
        if self._anchor is not anchor:
            if self._anchor is not None:
                try:
                    self._anchor.removeEventFilter(self)
                except Exception:
                    pass
            self._anchor = anchor
            anchor.installEventFilter(self)

    # ------------------------------------------------------------------
    # Anchor-follow + manual-resize state
    # ------------------------------------------------------------------

    _anchor: Optional[QWidget] = None
    _user_resized: bool = False

    def eventFilter(self, obj: QObject, ev: QEvent) -> bool:
        if obj is self._anchor and ev.type() in (QEvent.Resize, QEvent.Move):
            if not self._user_resized and self.isVisible():
                self._reposition_against_anchor()
        return super().eventFilter(obj, ev)

    def resizeEvent(self, ev) -> None:  # noqa: D401
        """User dragged a corner — stop auto-following the main window
        so we don't overwrite their size on the next anchor move."""
        super().resizeEvent(ev)
        # Distinguish "we set the geometry" from "user dragged a corner":
        # _reposition_against_anchor sets _suppress_resize_flag for the
        # duration of its setGeometry call.
        if not getattr(self, "_suppress_resize_flag", False):
            self._user_resized = True

    # ------------------------------------------------------------------
    # Manual edge-resize (frameless windows lose the OS-provided resize
    # behavior, so we re-implement it ourselves — same pattern as the
    # OWLLM MainWindow).
    # ------------------------------------------------------------------

    def _hit_test_edge(self, pos: QPoint) -> Optional[str]:
        m = self._resize_margin
        w, h = self.width(), self.height()
        left = pos.x() <= m
        right = pos.x() >= w - m
        top = pos.y() <= m
        bottom = pos.y() >= h - m
        if top and left:
            return "tl"
        if top and right:
            return "tr"
        if bottom and left:
            return "bl"
        if bottom and right:
            return "br"
        if left:
            return "l"
        if right:
            return "r"
        if top:
            return "t"
        if bottom:
            return "b"
        return None

    def _cursor_for_edge(self, edge: Optional[str]) -> Qt.CursorShape:
        return {
            "tl": Qt.SizeFDiagCursor, "br": Qt.SizeFDiagCursor,
            "tr": Qt.SizeBDiagCursor, "bl": Qt.SizeBDiagCursor,
            "l":  Qt.SizeHorCursor,  "r":  Qt.SizeHorCursor,
            "t":  Qt.SizeVerCursor,  "b":  Qt.SizeVerCursor,
        }.get(edge or "", Qt.ArrowCursor)

    def mousePressEvent(self, ev) -> None:
        if ev.button() == Qt.LeftButton:
            edge = self._hit_test_edge(ev.position().toPoint())
            if edge is not None:
                self._resize_edge = edge
                self._resize_start_pos = ev.globalPosition().toPoint()
                self._resize_start_geom = self.geometry()
                self._user_resized = True
                ev.accept()
                return
        super().mousePressEvent(ev)

    def mouseMoveEvent(self, ev) -> None:
        if self._resize_edge is not None and (ev.buttons() & Qt.LeftButton):
            dx = ev.globalPosition().toPoint().x() - self._resize_start_pos.x()
            dy = ev.globalPosition().toPoint().y() - self._resize_start_pos.y()
            g = self._resize_start_geom
            x, y, w, h = g.x(), g.y(), g.width(), g.height()
            min_w, min_h = self.minimumWidth(), self.minimumHeight()
            if "l" in self._resize_edge:
                new_w = max(min_w, w - dx)
                x = x + (w - new_w)
                w = new_w
            if "r" in self._resize_edge:
                w = max(min_w, w + dx)
            if "t" in self._resize_edge:
                new_h = max(min_h, h - dy)
                y = y + (h - new_h)
                h = new_h
            if "b" in self._resize_edge:
                h = max(min_h, h + dy)
            self.setGeometry(x, y, w, h)
            ev.accept()
            return
        # Hover-only: update cursor based on which edge is under the mouse.
        edge = self._hit_test_edge(ev.position().toPoint())
        self.setCursor(self._cursor_for_edge(edge))
        super().mouseMoveEvent(ev)

    def mouseReleaseEvent(self, ev) -> None:
        if self._resize_edge is not None:
            self._resize_edge = None
            self._resize_start_pos = None
            self._resize_start_geom = None
            self.unsetCursor()
            ev.accept()
            return
        super().mouseReleaseEvent(ev)

    def _reposition_against_anchor(self) -> None:
        anchor = self._anchor
        if anchor is None:
            return
        ag = anchor.frameGeometry()
        height = ag.height()
        width = int(height * 4 / 5)
        screen = self.screen() or anchor.screen()
        if screen is not None:
            avail = screen.availableGeometry()
            max_x = avail.right() - width
            x = min(ag.right(), max_x)
            y = max(avail.top(), ag.top())
        else:
            x = ag.right()
            y = ag.top()
        self._suppress_resize_flag = True
        try:
            self.setGeometry(x, y, width, height)
        finally:
            self._suppress_resize_flag = False

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _refresh(self) -> None:
        messages = self._card.messages_snapshot()
        if not messages:
            self._chat.setHtml(
                '<div style="color:#5a6478; font-size:16px;">'
                "no messages yet — type below to start, or wait for the team to ping"
                "</div>"
            )
            return
        lines = []
        for role, text in messages:
            color = "#5cf0ff" if role == "user" else "#ffc060"
            label = "You" if role == "user" else "Team"
            safe = (
                text.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\n", "<br>")
            )
            lines.append(
                f'<div style="margin:0 0 12px 0; font-size:16px; line-height:1.5;">'
                f'<span style="color:{color}; font-weight:700;">{label}:</span> '
                f'<span style="color:#cbd2e0;">{safe}</span>'
                f"</div>"
            )
        self._chat.setHtml("".join(lines))
        sb = self._chat.verticalScrollBar()
        sb.setValue(sb.maximum())

    def _on_submit(self) -> None:
        text = (self._reply.text() or "").strip()
        if not text:
            return
        self._reply.clear()
        # Route through the card so the goal pipeline + dedupe + bus
        # plumbing all behave the same as the inline reply.
        self._card._append_message("user", text)
        self._card.reply_submitted.emit(text)
