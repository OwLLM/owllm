"""User card — persistent agents-page widget that blinks when the team
is waiting for the user (approvals or other input-needed events)."""
from __future__ import annotations

from typing import Optional

from PySide6.QtCore import QTimer, Signal
from PySide6.QtWidgets import QFrame, QHBoxLayout, QLabel, QPushButton, QWidget


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
"""


class UserCard(QFrame):
    """Slim banner above the goal row. Idle by default, blinks (alternating
    amber / cyan border) when ``set_attention(True, body)`` is called.
    The gear button emits :sig:`settings_clicked` so the page can open
    a notify-settings dialog."""

    settings_clicked = Signal()

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UserCard")
        self.setStyleSheet(_IDLE_QSS)
        self.setMinimumHeight(44)

        row = QHBoxLayout(self)
        row.setContentsMargins(12, 6, 12, 6)
        row.setSpacing(10)

        icon = QLabel("👤")
        icon.setStyleSheet("font-size:18px; background:transparent;")
        row.addWidget(icon)

        self._title = QLabel("User")
        self._title.setObjectName("userTitle")
        row.addWidget(self._title)

        self._body = QLabel("idle — the team will ping you here when it needs input")
        self._body.setObjectName("userBody")
        self._body.setWordWrap(True)
        row.addWidget(self._body, 1)

        gear = QPushButton("⚙")
        gear.setObjectName("userSettings")
        gear.setFixedSize(26, 26)
        gear.setToolTip("Notification settings (Telegram, etc.)")
        gear.clicked.connect(self.settings_clicked)
        row.addWidget(gear)

        self._blink = QTimer(self)
        self._blink.setInterval(700)
        self._blink.timeout.connect(self._toggle_blink)
        self._blink_phase = False

    def set_attention(self, on: bool, body: str = "") -> None:
        """Switch between the idle and blinking-attention states. Safe
        to call repeatedly; only state-changes do work."""
        if on:
            self._title.setText("User — input needed")
            self._body.setText(body or "the team is waiting for you")
            self._blink_phase = False
            self.setStyleSheet(_ATTN_QSS_A)
            if not self._blink.isActive():
                self._blink.start()
        else:
            if self._blink.isActive():
                self._blink.stop()
            self._title.setText("User")
            self._body.setText(
                "idle — the team will ping you here when it needs input"
            )
            self.setStyleSheet(_IDLE_QSS)

    def _toggle_blink(self) -> None:
        self._blink_phase = not self._blink_phase
        self.setStyleSheet(_ATTN_QSS_B if self._blink_phase else _ATTN_QSS_A)
