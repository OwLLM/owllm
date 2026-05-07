"""In-app live tail viewer for an agent's launch log.

Replaces the slice 3b "View log" affordance that shelled out to the
OS-default text editor. The new dialog polls the log file every
:data:`POLL_MS` ms, reads only the bytes appended since the last
read (cheap — even a multi-MB log is a small delta per tick), and
auto-scrolls the QPlainTextEdit to the bottom unless the user has
scrolled up to inspect older content.

Non-modal so the user can have multiple log viewers open at once
(e.g. comparing two agents' output side-by-side). The card still
exposes an "Open in editor" affordance via this dialog's footer for
power users who want full editor features.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtGui import QFont, QTextCursor
from PySide6.QtWidgets import (
    QDialog,
    QHBoxLayout,
    QLabel,
    QPlainTextEdit,
    QPushButton,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

logger = logging.getLogger(__name__)


POLL_MS = 500
"""Polling interval. 500ms feels live without burning CPU on idle
agents and is well within human-perception latency. File-watcher
(QFileSystemWatcher) would be more efficient but adds a layer that
doesn't pay off until the log is huge — fine to swap in later."""


_DIALOG_QSS = """
QDialog#FleetLogViewer {
    background-color: #0a0d14;
}
QLabel#header {
    color: #e6f0ff;
    font-size: 13px;
    font-weight: 600;
}
QLabel#metaLine {
    color: #7888a8;
    font-family: Consolas, "Courier New", monospace;
    font-size: 11px;
}
QPlainTextEdit#logView {
    background-color: #12161f;
    color: #c4d0e8;
    border: 1px solid #2a3148;
    border-radius: 6px;
    selection-background-color: #2a3148;
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
QPushButton:checked {
    background-color: #5cf0ff;
    color: #0a0d14;
    border-color: #5cf0ff;
}
"""


class FleetLogViewer(QDialog):
    """Non-modal live-tail dialog for one agent's log file."""

    open_in_editor_requested = Signal(str)

    def __init__(
        self,
        agent_id: str,
        log_path: str,
        parent: Optional[QWidget] = None,
    ):
        super().__init__(parent)
        self.setObjectName("FleetLogViewer")
        self.setStyleSheet(_DIALOG_QSS)
        self.setWindowTitle(f"Agent log — {agent_id}")
        self.setMinimumSize(720, 480)
        self.setModal(False)
        # Auto-cleanup so the page doesn't accumulate hidden viewers
        # after many open/close cycles.
        self.setAttribute(Qt.WA_DeleteOnClose)

        self._agent_id = agent_id
        self._log_path = Path(log_path)
        self._read_offset = 0
        self._user_scrolled_up = False

        self._build_ui()

        self._timer = QTimer(self)
        self._timer.setInterval(POLL_MS)
        self._timer.timeout.connect(self._poll)

        # Initial load + start polling.
        self._reload_full()
        self._timer.start()

    # ------------------------------------------------------------------
    # Build
    # ------------------------------------------------------------------

    def _build_ui(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(16, 14, 16, 14)
        outer.setSpacing(8)

        header = QLabel(f"Live log — {self._agent_id}")
        header.setObjectName("header")
        outer.addWidget(header)

        self._meta = QLabel(self._meta_text())
        self._meta.setObjectName("metaLine")
        outer.addWidget(self._meta)

        self._view = QPlainTextEdit()
        self._view.setObjectName("logView")
        self._view.setReadOnly(True)
        font = QFont("Consolas")
        font.setStyleHint(QFont.TypeWriter)
        font.setPointSize(10)
        self._view.setFont(font)
        self._view.setSizePolicy(
            QSizePolicy.Expanding, QSizePolicy.Expanding,
        )
        # Detect manual scroll-up so we stop auto-scrolling.
        self._view.verticalScrollBar().valueChanged.connect(
            self._on_scrollbar_moved
        )
        outer.addWidget(self._view, 1)

        footer = QHBoxLayout()
        footer.setSpacing(6)
        self._auto_scroll_btn = QPushButton("Auto-scroll")
        self._auto_scroll_btn.setCheckable(True)
        self._auto_scroll_btn.setChecked(True)
        self._auto_scroll_btn.toggled.connect(self._on_auto_scroll_toggled)
        footer.addWidget(self._auto_scroll_btn)

        self._editor_btn = QPushButton("Open in editor")
        self._editor_btn.clicked.connect(
            lambda: self.open_in_editor_requested.emit(str(self._log_path))
        )
        footer.addWidget(self._editor_btn)

        footer.addStretch(1)
        close_btn = QPushButton("Close")
        close_btn.clicked.connect(self.close)
        footer.addWidget(close_btn)
        outer.addLayout(footer)

    # ------------------------------------------------------------------
    # Polling
    # ------------------------------------------------------------------

    def _poll(self) -> None:
        if not self._log_path.exists():
            # Log gone — likely teardown removed the workspace. Stop
            # polling but keep showing whatever we already loaded.
            self._timer.stop()
            self._meta.setText(self._meta_text() + "  ·  log no longer exists")
            return

        try:
            size = self._log_path.stat().st_size
        except OSError:
            return

        if size < self._read_offset:
            # File got truncated or rotated under us — reload from start.
            self._reload_full()
            return
        if size == self._read_offset:
            return  # nothing new

        try:
            with self._log_path.open("rb") as f:
                f.seek(self._read_offset)
                chunk = f.read(size - self._read_offset)
            self._read_offset = size
        except OSError as e:
            logger.debug("log poll read failed: %s", e)
            return

        text = chunk.decode("utf-8", errors="replace")
        self._append(text)
        self._meta.setText(self._meta_text())

    def _reload_full(self) -> None:
        self._view.clear()
        self._read_offset = 0
        if not self._log_path.exists():
            self._meta.setText(self._meta_text() + "  ·  no log yet")
            return
        try:
            data = self._log_path.read_bytes()
            self._read_offset = len(data)
            self._append(data.decode("utf-8", errors="replace"))
        except OSError as e:
            logger.warning("could not read %s: %s", self._log_path, e)
        self._meta.setText(self._meta_text())

    def _append(self, text: str) -> None:
        if not text:
            return
        cursor = self._view.textCursor()
        cursor.movePosition(QTextCursor.End)
        cursor.insertText(text)
        if self._auto_scroll_btn.isChecked() and not self._user_scrolled_up:
            self._view.verticalScrollBar().setValue(
                self._view.verticalScrollBar().maximum()
            )

    # ------------------------------------------------------------------
    # Scroll detection
    # ------------------------------------------------------------------

    def _on_scrollbar_moved(self, value: int) -> None:
        bar = self._view.verticalScrollBar()
        # Within a 4-pixel slack of the bottom counts as "still pinned."
        at_bottom = value >= bar.maximum() - 4
        self._user_scrolled_up = not at_bottom

    def _on_auto_scroll_toggled(self, checked: bool) -> None:
        if checked:
            # User re-enabled auto-scroll → snap to bottom and clear
            # the manual-scroll latch.
            self._user_scrolled_up = False
            self._view.verticalScrollBar().setValue(
                self._view.verticalScrollBar().maximum()
            )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _meta_text(self) -> str:
        size_txt = "—"
        if self._log_path.exists():
            try:
                size_txt = f"{self._log_path.stat().st_size} bytes"
            except OSError:
                pass
        return f"{self._log_path}  ·  {size_txt}"

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def closeEvent(self, event) -> None:  # noqa: N802
        self._timer.stop()
        super().closeEvent(event)
