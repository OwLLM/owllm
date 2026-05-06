"""One card per fleet agent.

Slice 2a is intentionally plain: a :class:`QFrame` with stylesheet-
based "neon" trim, not the painter-based character sheet used by the
in-app agent canvas. This card is composable in a flow / grid layout
because the page wants kanban-style stacking, not a fixed-position
overlay.

Buttons emit signals; the parent :class:`FleetPage` wires them to
:class:`FleetService`. The card itself never touches the broker.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from PySide6.QtCore import QSize, Qt, QTimer, Signal
from PySide6.QtGui import QColor, QFont
from PySide6.QtWidgets import (
    QFrame,
    QGraphicsDropShadowEffect,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)


_STATUS_COLOR = {
    "active": "#3cf26b",
    "released": "#7888a8",
}


_CARD_QSS = """
QFrame#FleetAgentCard {{
    background-color: #12161f;
    border: 1px solid #2a3148;
    border-radius: 10px;
}}
QFrame#FleetAgentCard:hover {{
    border-color: #5cf0ff;
}}
QLabel#agentId {{
    color: #e6f0ff;
    font-weight: 600;
    font-size: 13px;
}}
QLabel#statusPill {{
    color: #0a0d14;
    background: {status_bg};
    border-radius: 8px;
    padding: 2px 8px;
    font-size: 10px;
    font-weight: 700;
}}
QLabel#sectionLabel {{
    color: #7888a8;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
}}
QLabel#bodyText {{
    color: #c4d0e8;
    font-size: 12px;
}}
QLabel#monoText {{
    color: #c4d0e8;
    font-family: Consolas, "Courier New", monospace;
    font-size: 11px;
}}
QLabel#chip {{
    color: #c4d0e8;
    background: #1a2030;
    border: 1px solid #2a3148;
    border-radius: 4px;
    padding: 2px 6px;
    font-family: Consolas, "Courier New", monospace;
    font-size: 10px;
}}
QPushButton {{
    color: #e6f0ff;
    background-color: #1a2030;
    border: 1px solid #2a3148;
    border-radius: 6px;
    padding: 5px 10px;
    font-size: 11px;
}}
QPushButton:hover {{
    background-color: #232a40;
    border-color: #5cf0ff;
}}
QPushButton#finishButton {{
    color: #0a0d14;
    background-color: #5cf0ff;
    border-color: #5cf0ff;
}}
QPushButton#finishButton:hover {{
    background-color: #74f4ff;
}}
"""


def _parse_iso(ts: str) -> Optional[datetime]:
    if not ts:
        return None
    try:
        if ts.endswith("Z"):
            ts = ts[:-1] + "+00:00"
        return datetime.fromisoformat(ts)
    except ValueError:
        return None


def _format_ttl(claim: Dict[str, Any]) -> str:
    """Render the time-until-reap as a human string."""
    hb = _parse_iso(claim.get("last_heartbeat", ""))
    ttl = int(claim.get("ttl_seconds", 0) or 0)
    if hb is None or ttl <= 0:
        return f"{ttl}s ttl"
    deadline = hb.timestamp() + ttl
    remaining = int(deadline - datetime.now(timezone.utc).timestamp())
    if remaining <= 0:
        return "stale (reap pending)"
    if remaining >= 3600:
        return f"{remaining // 3600}h {(remaining % 3600) // 60}m left"
    if remaining >= 60:
        return f"{remaining // 60}m {remaining % 60}s left"
    return f"{remaining}s left"


class FleetAgentCard(QFrame):
    """Glanceable status + action card for one fleet agent."""

    finish_requested = Signal(str)
    heartbeat_requested = Signal(str)

    def __init__(self, claim: Dict[str, Any], parent: Optional[QWidget] = None):
        super().__init__(parent)
        self.setObjectName("FleetAgentCard")
        self._claim = dict(claim)
        self.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Maximum)
        self.setMinimumWidth(320)
        self.setMaximumWidth(420)

        shadow = QGraphicsDropShadowEffect(self)
        shadow.setBlurRadius(18)
        shadow.setOffset(0, 4)
        shadow.setColor(QColor(0, 0, 0, 140))
        self.setGraphicsEffect(shadow)

        self._build_ui()
        self.refresh_from(self._claim)

        # The TTL countdown updates every second so users can see a
        # claim aging without spamming the broker.
        self._ttl_timer = QTimer(self)
        self._ttl_timer.setInterval(1000)
        self._ttl_timer.timeout.connect(self._refresh_ttl_label)
        self._ttl_timer.start()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def agent_id(self) -> str:
        return str(self._claim.get("agent_id", ""))

    def refresh_from(self, claim: Dict[str, Any]) -> None:
        self._claim = dict(claim)
        status = str(claim.get("status", "active"))
        self.setStyleSheet(
            _CARD_QSS.format(status_bg=_STATUS_COLOR.get(status, "#7888a8"))
        )
        self._lbl_id.setText(claim.get("agent_id", "?"))
        self._lbl_status.setText(status.upper())
        self._lbl_reason.setText(
            claim.get("reason") or "(no reason given)"
        )
        self._lbl_repo.setText(
            f"{claim.get('target_repo', '?')} → {claim.get('branch', '?')}"
        )
        self._refill_chips(self._owns_row, claim.get("owns_modules", []) or [])
        self._refill_chips(self._reads_row, claim.get("reads_modules", []) or [])
        port = claim.get("port")
        gpu = claim.get("gpu_slot")
        gpu_mode = claim.get("gpu_mode") or "rw"
        port_txt = f"port {port}" if port is not None else "port —"
        gpu_txt = (
            f"gpu {gpu} ({gpu_mode})" if gpu is not None else "gpu —"
        )
        self._lbl_resources.setText(f"{port_txt}  ·  {gpu_txt}")
        self._refresh_ttl_label()

        is_active = status == "active"
        self._btn_finish.setEnabled(is_active)
        self._btn_heartbeat.setEnabled(is_active)

    # ------------------------------------------------------------------
    # Build
    # ------------------------------------------------------------------

    def _build_ui(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(14, 12, 14, 12)
        outer.setSpacing(8)

        # Header — agent id + status pill
        header = QHBoxLayout()
        header.setSpacing(8)
        self._lbl_id = QLabel(self._claim.get("agent_id", "?"))
        self._lbl_id.setObjectName("agentId")
        header.addWidget(self._lbl_id)
        header.addStretch(1)
        self._lbl_status = QLabel("ACTIVE")
        self._lbl_status.setObjectName("statusPill")
        header.addWidget(self._lbl_status)
        outer.addLayout(header)

        # Task line
        self._lbl_reason = QLabel("")
        self._lbl_reason.setObjectName("bodyText")
        self._lbl_reason.setWordWrap(True)
        outer.addWidget(self._lbl_reason)

        # Repo + branch (mono)
        self._lbl_repo = QLabel("")
        self._lbl_repo.setObjectName("monoText")
        self._lbl_repo.setWordWrap(True)
        outer.addWidget(self._lbl_repo)

        # Owned modules
        outer.addWidget(_section_label("OWNS"))
        self._owns_row = _new_chip_row()
        outer.addLayout(self._owns_row)

        # Reads
        outer.addWidget(_section_label("READS"))
        self._reads_row = _new_chip_row()
        outer.addLayout(self._reads_row)

        # Resources
        outer.addWidget(_section_label("RESOURCES"))
        self._lbl_resources = QLabel("")
        self._lbl_resources.setObjectName("monoText")
        outer.addWidget(self._lbl_resources)
        self._lbl_ttl = QLabel("")
        self._lbl_ttl.setObjectName("monoText")
        outer.addWidget(self._lbl_ttl)

        # Footer buttons
        footer = QHBoxLayout()
        footer.setSpacing(6)
        self._btn_heartbeat = QPushButton("Heartbeat")
        self._btn_heartbeat.clicked.connect(
            lambda: self.heartbeat_requested.emit(self.agent_id)
        )
        footer.addWidget(self._btn_heartbeat)
        footer.addStretch(1)
        self._btn_finish = QPushButton("Finish")
        self._btn_finish.setObjectName("finishButton")
        self._btn_finish.clicked.connect(
            lambda: self.finish_requested.emit(self.agent_id)
        )
        footer.addWidget(self._btn_finish)
        outer.addLayout(footer)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _refill_chips(self, row: QHBoxLayout, items: List[str]) -> None:
        # Strip existing children.
        while row.count():
            item = row.takeAt(0)
            w = item.widget()
            if w is not None:
                w.deleteLater()
        if not items:
            empty = QLabel("(none)")
            empty.setObjectName("monoText")
            row.addWidget(empty)
            return
        for s in items:
            chip = QLabel(s)
            chip.setObjectName("chip")
            row.addWidget(chip)
        row.addStretch(1)

    def _refresh_ttl_label(self) -> None:
        if self._claim.get("status", "active") == "active":
            self._lbl_ttl.setText(_format_ttl(self._claim))
        else:
            self._lbl_ttl.setText("released")


def _section_label(text: str) -> QLabel:
    lbl = QLabel(text)
    lbl.setObjectName("sectionLabel")
    return lbl


def _new_chip_row() -> QHBoxLayout:
    row = QHBoxLayout()
    row.setContentsMargins(0, 0, 0, 0)
    row.setSpacing(4)
    return row
