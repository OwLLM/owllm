"""History — browse the fleet audit log.

Slice 3c-c. Shows the last N events from
``<fleet_root>/audit.log.jsonl`` as a sortable table. Manual refresh
only — events are append-only and rare enough that polling adds
nothing.

Filtering / search is a future addition; for slice 3c-c the
unfiltered tail is enough to answer "what just happened to that
agent" and "did the spawn go through."
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Dict, List, Optional

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor
from PySide6.QtWidgets import (
    QDialog,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QPushButton,
    QSizePolicy,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

logger = logging.getLogger(__name__)


_EVENT_COLOUR = {
    "spawn": QColor("#3cf26b"),
    "spawn_failed": QColor("#ff7878"),
    "finish": QColor("#74a4ff"),
    "finish_failed": QColor("#ff7878"),
    "process_start": QColor("#5cf0ff"),
    "process_start_failed": QColor("#ffc060"),
    "process_stop": QColor("#7888a8"),
    "heartbeat": QColor("#7888a8"),
    "reap": QColor("#ffc060"),
}


_DIALOG_QSS = """
QDialog#FleetHistoryDialog {
    background-color: #0a0d14;
}
QLabel#header {
    color: #e6f0ff;
    font-size: 13px;
    font-weight: 600;
}
QLabel#metaLine {
    color: #7888a8;
    font-size: 11px;
}
QTableWidget {
    background-color: #12161f;
    color: #c4d0e8;
    gridline-color: #2a3148;
    border: 1px solid #2a3148;
    border-radius: 6px;
    font-family: Consolas, "Courier New", monospace;
    font-size: 11px;
}
QHeaderView::section {
    background-color: #1a2030;
    color: #c4d0e8;
    border: none;
    border-right: 1px solid #2a3148;
    border-bottom: 1px solid #2a3148;
    padding: 4px 8px;
    font-weight: 600;
}
QPushButton {
    color: #e6f0ff;
    background-color: #1a2030;
    border: 1px solid #2a3148;
    border-radius: 6px;
    padding: 5px 12px;
    font-size: 11px;
}
QPushButton:hover {
    background-color: #232a40;
    border-color: #5cf0ff;
}
"""


class FleetHistoryDialog(QDialog):
    """Audit-log browser. ``loader`` returns a list of event dicts —
    the page passes ``service.list_audit_events`` so the dialog
    doesn't have to know about :class:`FleetService`."""

    def __init__(
        self,
        loader: Callable[[int], List[Dict[str, Any]]],
        parent: Optional[QWidget] = None,
        *,
        max_events: int = 500,
    ):
        super().__init__(parent)
        self.setObjectName("FleetHistoryDialog")
        self.setStyleSheet(_DIALOG_QSS)
        self.setWindowTitle("Fleet history")
        self.setMinimumSize(820, 500)
        self.setModal(False)
        self.setAttribute(Qt.WA_DeleteOnClose)

        self._loader = loader
        self._max_events = max_events

        self._build_ui()
        self._refresh()

    def _build_ui(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(16, 14, 16, 14)
        outer.setSpacing(8)

        title = QLabel("Fleet history")
        title.setObjectName("header")
        outer.addWidget(title)

        self._meta = QLabel("")
        self._meta.setObjectName("metaLine")
        outer.addWidget(self._meta)

        self._table = QTableWidget(0, 4, self)
        self._table.setHorizontalHeaderLabels(
            ["When", "Event", "Agent", "Summary"]
        )
        self._table.verticalHeader().setVisible(False)
        self._table.setEditTriggers(QTableWidget.NoEditTriggers)
        self._table.setSelectionBehavior(QTableWidget.SelectRows)
        self._table.setSortingEnabled(True)
        header = self._table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.Interactive)
        header.setSectionResizeMode(1, QHeaderView.Interactive)
        header.setSectionResizeMode(2, QHeaderView.Interactive)
        header.setSectionResizeMode(3, QHeaderView.Stretch)
        self._table.setColumnWidth(0, 170)
        self._table.setColumnWidth(1, 130)
        self._table.setColumnWidth(2, 130)
        self._table.setSizePolicy(
            QSizePolicy.Expanding, QSizePolicy.Expanding,
        )
        outer.addWidget(self._table, 1)

        footer = QHBoxLayout()
        footer.addStretch(1)
        refresh_btn = QPushButton("Refresh")
        refresh_btn.clicked.connect(self._refresh)
        footer.addWidget(refresh_btn)
        close_btn = QPushButton("Close")
        close_btn.clicked.connect(self.close)
        footer.addWidget(close_btn)
        outer.addLayout(footer)

    def _refresh(self) -> None:
        try:
            events = self._loader(self._max_events)
        except Exception as e:
            logger.warning("history loader failed: %s", e)
            events = []

        # Newest at the top — easier to spot the last action.
        events_sorted = list(reversed(events))

        # Sorting is disabled while populating to avoid swapping rows
        # mid-fill; re-enable after.
        self._table.setSortingEnabled(False)
        self._table.setRowCount(len(events_sorted))
        for row, ev in enumerate(events_sorted):
            event_name = str(ev.get("event", ""))
            colour = _EVENT_COLOUR.get(event_name)
            cells = [
                str(ev.get("ts", "")),
                event_name,
                str(ev.get("agent_id", "")),
                _summarise(ev),
            ]
            for col, text in enumerate(cells):
                item = QTableWidgetItem(text)
                if colour is not None and col == 1:
                    item.setForeground(colour)
                self._table.setItem(row, col, item)
        self._table.setSortingEnabled(True)

        self._meta.setText(
            f"{len(events)} event{'s' if len(events) != 1 else ''}"
            f" (newest first; up to {self._max_events})"
        )


def _summarise(event: Dict[str, Any]) -> str:
    """Build a one-line summary from the event's ad-hoc detail keys."""
    pieces: List[str] = []
    # Show the most-load-bearing details for the common events.
    for key in (
        "branch", "target_repo", "reason", "reason_text",
        "pid", "returncode", "pr_url",
    ):
        v = event.get(key)
        if v is None or v == "":
            continue
        pieces.append(f"{key}={v}")
    if not pieces:
        # Fall back to dumping the whole event so nothing is lost.
        keys = [k for k in event.keys() if k not in ("ts", "event", "agent_id")]
        pieces = [f"{k}={event[k]}" for k in keys]
    return "  ·  ".join(pieces)
