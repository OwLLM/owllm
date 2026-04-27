from __future__ import annotations

from datetime import datetime

from PySide6.QtCore import Qt
from PySide6.QtGui import QFont, QTextCursor
from PySide6.QtWidgets import (
    QApplication,
    QHBoxLayout,
    QLabel,
    QPlainTextEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)


class ProcessConsoleWidget(QWidget):
    """Compact in-app terminal surface for process output and app activity."""

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self._max_blocks = 3000

        layout = QVBoxLayout(self)
        layout.setContentsMargins(8, 6, 8, 8)
        layout.setSpacing(6)

        header = QHBoxLayout()
        header.setContentsMargins(0, 0, 0, 0)
        header.setSpacing(8)

        title = QLabel("Terminal")
        title.setStyleSheet("font-weight: bold;")
        header.addWidget(title)
        header.addStretch(1)

        self.clear_btn = QPushButton("Clear")
        self.clear_btn.setFixedWidth(72)
        self.clear_btn.clicked.connect(self.clear)
        header.addWidget(self.clear_btn)

        self.copy_btn = QPushButton("Copy")
        self.copy_btn.setFixedWidth(72)
        self.copy_btn.clicked.connect(self.copy_all)
        header.addWidget(self.copy_btn)

        layout.addLayout(header)

        self.output = QPlainTextEdit()
        self.output.setReadOnly(True)
        self.output.setMaximumBlockCount(self._max_blocks)
        self.output.setLineWrapMode(QPlainTextEdit.NoWrap)
        font = QFont("Consolas")
        font.setStyleHint(QFont.Monospace)
        font.setPointSize(9)
        self.output.setFont(font)
        self.output.setMinimumHeight(140)
        self.output.setStyleSheet(
            """
            QPlainTextEdit {
                background: #05070a;
                color: #d7e1ff;
                border: 1px solid rgba(255, 255, 255, 0.16);
                border-radius: 6px;
                padding: 6px;
            }
            """
        )
        layout.addWidget(self.output)

    def append(self, text: str, *, source: str = "app") -> None:
        text = str(text or "").rstrip()
        if not text:
            return
        stamp = datetime.now().strftime("%H:%M:%S")
        prefix = f"[{stamp}][{source}] "
        lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        formatted = "\n".join(prefix + line for line in lines if line.strip())
        if not formatted:
            return
        self.output.appendPlainText(formatted)
        cursor = self.output.textCursor()
        cursor.movePosition(QTextCursor.End)
        self.output.setTextCursor(cursor)

    def append_raw(self, text: str, *, source: str = "process") -> None:
        self.append(text, source=source)

    def clear(self) -> None:
        self.output.clear()

    def copy_all(self) -> None:
        QApplication.clipboard().setText(self.output.toPlainText())

