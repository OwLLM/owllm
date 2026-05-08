"""Supervisor card — per-project permissions controller.

A small persistent card on the agents page that toggles between
"ask the user for every tool approval" (the default, safer) and
"auto-approve every tool request" (faster, less safe).

The toggle is persisted on the active Project record and registered
as a wildcard ``AutoApproveRule`` on the team's ApprovalGate when on.
The visual treatment shifts from neutral gray to a hot red border so
the elevated state is unmistakable — this is a footgun, by design,
and the card makes that plain."""
from __future__ import annotations

from typing import Optional

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QCheckBox,
    QFrame,
    QHBoxLayout,
    QLabel,
    QWidget,
)


_OFF_QSS = """
QFrame#SupervisorCard {
    background-color: #1a2030;
    border: 1px solid #2a3148;
    border-radius: 10px;
}
QLabel#supTitle { color: #c4d0e8; font-weight:600; background:transparent; }
QLabel#supBody  { color: #7888a8; background:transparent; }
QCheckBox#supToggle { color: #c4d0e8; background:transparent; }
QCheckBox#supToggle::indicator {
    width:14px; height:14px;
    border-radius:3px; border:1px solid #5a6478;
    background-color:#0a0d14;
}
QCheckBox#supToggle::indicator:checked {
    background-color:#5cf0ff; border-color:#5cf0ff;
}
"""

_ON_QSS = """
QFrame#SupervisorCard {
    background-color: #2a0d0d;
    border: 2px solid #ff6060;
    border-radius: 10px;
}
QLabel#supTitle { color: #ff8c8c; font-weight:700; background:transparent; }
QLabel#supBody  { color: #ffc0c0; background:transparent; }
QCheckBox#supToggle { color: #ff8c8c; background:transparent; }
QCheckBox#supToggle::indicator {
    width:14px; height:14px;
    border-radius:3px; border:1px solid #ff6060;
    background-color:#ff6060;
}
"""


class SupervisorCard(QFrame):
    """Per-project Supervisor — controls whether tool approvals auto-approve.

    Emits :sig:`toggled` whenever the checkbox state changes. The page
    persists the new value on the active Project record and registers /
    removes the wildcard auto-approve rule on the team's gate."""

    toggled = Signal(bool)

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setObjectName("SupervisorCard")
        self.setStyleSheet(_OFF_QSS)
        self.setMinimumHeight(44)

        row = QHBoxLayout(self)
        row.setContentsMargins(12, 6, 12, 6)
        row.setSpacing(10)

        icon = QLabel("🛡")
        icon.setStyleSheet("font-size:18px; background:transparent;")
        row.addWidget(icon)

        self._title = QLabel("Supervisor")
        self._title.setObjectName("supTitle")
        row.addWidget(self._title)

        self._body = QLabel("ask me before every tool action (default)")
        self._body.setObjectName("supBody")
        self._body.setWordWrap(True)
        row.addWidget(self._body, 1)

        self._toggle = QCheckBox("auto-approve all")
        self._toggle.setObjectName("supToggle")
        self._toggle.setToolTip(
            "When on, every tool request from the team resolves APPROVE "
            "without surfacing to the user. Faster but less safe — the "
            "team can run any allowed tool without confirmation."
        )
        self._toggle.toggled.connect(self._on_toggled)
        row.addWidget(self._toggle)

    def set_state(self, enabled: bool) -> None:
        """Set the checkbox state without firing the toggled signal."""
        self._toggle.blockSignals(True)
        self._toggle.setChecked(bool(enabled))
        self._toggle.blockSignals(False)
        self._refresh_appearance(bool(enabled))

    def _on_toggled(self, checked: bool) -> None:
        self._refresh_appearance(bool(checked))
        self.toggled.emit(bool(checked))

    def _refresh_appearance(self, on: bool) -> None:
        if on:
            self.setStyleSheet(_ON_QSS)
            self._title.setText("Supervisor — AUTO-APPROVING ALL")
            self._body.setText(
                "every tool request resolves APPROVE without asking — "
                "uncheck to restore prompts"
            )
        else:
            self.setStyleSheet(_OFF_QSS)
            self._title.setText("Supervisor")
            self._body.setText("ask me before every tool action (default)")
