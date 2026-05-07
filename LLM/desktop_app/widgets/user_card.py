"""User card — persistent agents-page widget that blinks when the team
is waiting for the user (approvals or other input-needed events). Also
hosts a quick-reply field so the user can respond inline without losing
focus from the alert."""
from __future__ import annotations

from typing import Optional

from PySide6.QtCore import QTimer, Signal
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)


_IDLE_QSS = """
QFrame#UserCard {
    background-color: #1a2030;
    border: 1px solid #2a3148;
    border-radius: 10px;
}
QLabel#userTitle { color: #c4d0e8; font-weight:600; background:transparent; }
QLabel#userBody  { color: #7888a8; background:transparent; }
QPushButton#userSettings {
    background:transparent; color:#7888a8; border:none; font-size:14px;
}
QPushButton#userSettings:hover { color:#5cf0ff; }
QLineEdit#userReply {
    background-color: #12161f; color: #e6f0ff;
    border: 1px solid #2a3148; border-radius: 6px;
    padding: 4px 8px; font-size: 12px;
}
QLineEdit#userReply:focus { border-color: #5cf0ff; }
QLineEdit#userReply:disabled { color: #5a6478; }
QPushButton#userSend {
    color: #e6f0ff; background-color: #1a2030;
    border: 1px solid #2a3148; border-radius: 6px;
    padding: 4px 12px; font-size: 11px;
}
QPushButton#userSend:hover { border-color: #5cf0ff; color: #5cf0ff; }
QPushButton#userSend:disabled { color: #5a6478; border-color: #1a1f2c; }
"""

_ATTN_QSS_A = """
QFrame#UserCard {
    background-color: #2a1f0d;
    border: 2px solid #ffc060;
    border-radius: 10px;
}
QLabel#userTitle { color: #ffc060; font-weight:700; background:transparent; }
QLabel#userBody  { color: #ffe1a0; background:transparent; }
QPushButton#userSettings {
    background:transparent; color:#ffc060; border:none; font-size:14px;
}
QLineEdit#userReply {
    background-color: #12161f; color: #ffe1a0;
    border: 1px solid #ffc060; border-radius: 6px;
    padding: 4px 8px; font-size: 12px;
}
QPushButton#userSend {
    color: #2a1f0d; background-color: #ffc060;
    border: 1px solid #ffc060; border-radius: 6px;
    padding: 4px 12px; font-size: 11px; font-weight:600;
}
"""

_ATTN_QSS_B = """
QFrame#UserCard {
    background-color: #1a2030;
    border: 2px solid #5cf0ff;
    border-radius: 10px;
}
QLabel#userTitle { color: #5cf0ff; font-weight:700; background:transparent; }
QLabel#userBody  { color: #c4d0e8; background:transparent; }
QPushButton#userSettings {
    background:transparent; color:#5cf0ff; border:none; font-size:14px;
}
QLineEdit#userReply {
    background-color: #12161f; color: #e6f0ff;
    border: 1px solid #5cf0ff; border-radius: 6px;
    padding: 4px 8px; font-size: 12px;
}
QPushButton#userSend {
    color: #0a0d14; background-color: #5cf0ff;
    border: 1px solid #5cf0ff; border-radius: 6px;
    padding: 4px 12px; font-size: 11px; font-weight:600;
}
"""


class UserCard(QFrame):
    """Slim banner above the goal row. Idle by default, blinks (alternating
    amber / cyan border) when ``set_attention(True, body)`` is called.

    Has its own quick-reply line so the user can respond inline. Submit
    routes through :sig:`reply_submitted`; the page wires that to the
    main goal pipeline so all the existing run logic applies."""

    settings_clicked = Signal()
    reply_submitted = Signal(str)

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UserCard")
        self.setStyleSheet(_IDLE_QSS)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(12, 6, 12, 6)
        outer.setSpacing(6)

        # ---- Top row: icon + title + body + gear --------------------
        top = QHBoxLayout()
        top.setSpacing(10)

        icon = QLabel("👤")
        icon.setStyleSheet("font-size:18px; background:transparent;")
        top.addWidget(icon)

        self._title = QLabel("User")
        self._title.setObjectName("userTitle")
        top.addWidget(self._title)

        self._body = QLabel("idle — the team will ping you here when it needs input")
        self._body.setObjectName("userBody")
        self._body.setWordWrap(True)
        top.addWidget(self._body, 1)

        gear = QPushButton("⚙")
        gear.setObjectName("userSettings")
        gear.setFixedSize(26, 26)
        gear.setToolTip("Notification settings (Telegram, etc.)")
        gear.clicked.connect(self.settings_clicked)
        top.addWidget(gear)

        outer.addLayout(top)

        # ---- Bottom row: reply input + Send button ------------------
        # Indent slightly so it visually aligns with the title text and
        # doesn't fight the icon column.
        bottom = QHBoxLayout()
        bottom.setContentsMargins(28, 0, 0, 0)
        bottom.setSpacing(8)

        self._reply = QLineEdit()
        self._reply.setObjectName("userReply")
        self._reply.setPlaceholderText("Reply to the team — Enter to send")
        self._reply.returnPressed.connect(self._on_submit)
        bottom.addWidget(self._reply, 1)

        self._send = QPushButton("Send")
        self._send.setObjectName("userSend")
        self._send.clicked.connect(self._on_submit)
        bottom.addWidget(self._send)

        outer.addLayout(bottom)

        # ---- Blink animation ----------------------------------------
        self._blink = QTimer(self)
        self._blink.setInterval(700)
        self._blink.timeout.connect(self._toggle_blink)
        self._blink_phase = False

    # ------------------------------------------------------------------
    # State
    # ------------------------------------------------------------------

    def set_attention(self, on: bool, body: str = "") -> None:
        """Switch between idle and blinking-attention. Auto-focuses the
        reply field on attention so the user can type immediately."""
        if on:
            self._title.setText("User — input needed")
            self._body.setText(body or "the team is waiting for you")
            self._blink_phase = False
            self.setStyleSheet(_ATTN_QSS_A)
            if not self._blink.isActive():
                self._blink.start()
            if self._reply.isEnabled():
                self._reply.setFocus()
        else:
            if self._blink.isActive():
                self._blink.stop()
            self._title.setText("User")
            self._body.setText(
                "idle — the team will ping you here when it needs input"
            )
            self.setStyleSheet(_IDLE_QSS)

    def set_reply_enabled(self, enabled: bool) -> None:
        """Mirror the goal input's enabled state — disable the reply
        field while a run is in flight so users don't accidentally
        kick off a second goal."""
        self._reply.setEnabled(enabled)
        self._send.setEnabled(enabled)

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _on_submit(self) -> None:
        text = (self._reply.text() or "").strip()
        if not text:
            return
        self._reply.clear()
        self.reply_submitted.emit(text)

    def _toggle_blink(self) -> None:
        self._blink_phase = not self._blink_phase
        self.setStyleSheet(_ATTN_QSS_B if self._blink_phase else _ATTN_QSS_A)
