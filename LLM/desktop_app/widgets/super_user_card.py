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

from PySide6.QtCore import QTimer, Signal
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QCheckBox,
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
QPushButton#suGear {{
    background:transparent; color:#7888a8;
    border:none; font-size:15px;
}}
QPushButton#suGear:hover {{ color:#5cf0ff; }}
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
        row = QHBoxLayout()
        row.setSpacing(10)

        avatar = QLabel("👤")
        avatar.setObjectName("suAvatar")
        avatar.setFixedSize(32, 32)
        row.addWidget(avatar)

        name_block = QVBoxLayout()
        name_block.setSpacing(0)
        self._name = QLabel("Super User (YOU)")
        self._name.setObjectName("suName")
        nf = QFont()
        nf.setPointSize(13)
        nf.setBold(True)
        self._name.setFont(nf)
        name_block.addWidget(self._name)

        self._hint = QLabel("idle — the team pings you here when it needs input")
        self._hint.setObjectName("suHint")
        name_block.addWidget(self._hint)
        row.addLayout(name_block, 1)

        self._trust = QCheckBox("auto-approve")
        self._trust.setObjectName("suTrust")
        self._trust.setToolTip(
            "When on, every tool request from the team resolves APPROVE "
            "without surfacing a prompt. Per-project; off by default."
        )
        self._trust.toggled.connect(self.supervisor_toggled)
        row.addWidget(self._trust)

        self._gear = QPushButton("⚙")
        self._gear.setObjectName("suGear")
        self._gear.setFixedSize(26, 26)
        self._gear.setToolTip("Notification settings (Telegram, etc.)")
        self._gear.clicked.connect(self.settings_clicked)
        row.addWidget(self._gear)
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
