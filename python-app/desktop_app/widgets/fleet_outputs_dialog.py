"""Outputs — browse the agent-published artifact registry.

Slice 4-b. Read-only view of every record in the
:class:`core.fleet.outputs.OutputRegistry`. Publishing comes from
agent code or CLI today; once we know which artifact kinds users
actually produce, an in-UI Publish form can land in a follow-up.
"""
from __future__ import annotations

import logging
from typing import Callable, List

from PySide6.QtCore import Qt
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

from core.fleet.outputs import Artifact

logger = logging.getLogger(__name__)


_DIALOG_QSS = """
QDialog#FleetOutputsDialog { background-color: #0a0d14; }
QLabel#header { color: #e6f0ff; font-size: 13px; font-weight: 600; }
QLabel#metaLine { color: #7888a8; font-size: 11px; }
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
QPushButton:hover { background-color: #232a40; border-color: #5cf0ff; }
"""


class FleetOutputsDialog(QDialog):
    """Read-only table view of the output registry.

    ``loader`` returns a list of :class:`Artifact` so the dialog
    doesn't have to know about :class:`FleetService`.
    """

    def __init__(
        self,
        loader: Callable[[], List[Artifact]],
        parent: QWidget | None = None,
    ):
        super().__init__(parent)
        self.setObjectName("FleetOutputsDialog")
        self.setStyleSheet(_DIALOG_QSS)
        self.setWindowTitle("Fleet outputs")
        self.setMinimumSize(820, 480)
        self.setModal(False)
        self.setAttribute(Qt.WA_DeleteOnClose)

        self._loader = loader
        self._build_ui()
        self._refresh()

    def _build_ui(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(16, 14, 16, 14)
        outer.setSpacing(8)

        title = QLabel("Outputs")
        title.setObjectName("header")
        outer.addWidget(title)

        self._meta = QLabel("")
        self._meta.setObjectName("metaLine")
        outer.addWidget(self._meta)

        self._table = QTableWidget(0, 6, self)
        self._table.setHorizontalHeaderLabels(
            ["Name", "Version", "Publisher", "Kind", "Path", "Published"]
        )
        self._table.verticalHeader().setVisible(False)
        self._table.setEditTriggers(QTableWidget.NoEditTriggers)
        self._table.setSelectionBehavior(QTableWidget.SelectRows)
        self._table.setSortingEnabled(True)
        header = self._table.horizontalHeader()
        for col in range(self._table.columnCount() - 1):
            header.setSectionResizeMode(col, QHeaderView.Interactive)
        header.setSectionResizeMode(
            self._table.columnCount() - 1, QHeaderView.Stretch,
        )
        self._table.setColumnWidth(0, 160)
        self._table.setColumnWidth(1, 90)
        self._table.setColumnWidth(2, 130)
        self._table.setColumnWidth(3, 90)
        self._table.setColumnWidth(4, 200)
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
            artifacts = self._loader()
        except Exception as e:
            logger.warning("outputs loader failed: %s", e)
            artifacts = []

        self._table.setSortingEnabled(False)
        self._table.setRowCount(len(artifacts))
        for row, a in enumerate(artifacts):
            cells = [
                a.name,
                a.version,
                a.publisher_agent_id,
                a.kind,
                a.path,
                a.published_at,
            ]
            for col, text in enumerate(cells):
                self._table.setItem(row, col, QTableWidgetItem(str(text)))
        self._table.setSortingEnabled(True)

        self._meta.setText(
            f"{len(artifacts)} artifact{'s' if len(artifacts) != 1 else ''}"
        )
