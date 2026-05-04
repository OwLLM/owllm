"""Supervisor dashboard -- live shadow log + flag state.

Lazily added to the main tab bar only when `supervisor.enabled` is True
(see desktop_app/main.py). Production users see no change; dev users who
flip the flag in feature_flags.json get a tab the next time the app
starts.

Two responsibilities:

1. Show what the supervisor would have done. Reads
   `core.supervisor.shadow.read_all()` and renders the most recent events
   as a sortable table. Selecting a row expands the full JSON below.

2. Show the current flag state so devs know what mode they're in. The
   panel is read-only -- to change a flag the user edits
   feature_flags.json (the path is shown). This keeps the UI honest:
   the source of truth is the file, not a transient toggle in memory.

Auto-refresh: 3 seconds. Cheap because shadow.read_all() reads a small
JSONL once per refresh.

Pure data helpers (`format_row`, `summarize_flags`) live as module-level
functions so they can be unit-tested without Qt.
"""
from __future__ import annotations

import json
from typing import Any, Mapping

from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QTableWidget, QTableWidgetItem, QGroupBox, QTextEdit,
    QSplitter, QHeaderView, QSizePolicy,
)

from core.supervisor import flags, shadow


REFRESH_INTERVAL_MS = 3000
MAX_ROWS_DISPLAYED = 200


# ---------------------------------------------------------------------------
# Pure data helpers (Qt-free, unit-testable)
# ---------------------------------------------------------------------------


def format_row(event: Mapping[str, Any]) -> tuple[str, str, str, str]:
    """Return (timestamp, channel, trigger_kind, summary) for one row."""
    ts = str(event.get("ts", "?"))
    channel = str(event.get("channel", "?"))
    trigger = event.get("trigger") or {}
    kind = str(trigger.get("kind", "?"))
    # Summary: prefer reason_code, then category, then short error tail
    summary = ""
    for key in ("reason_code", "category", "error_message", "model_path"):
        v = trigger.get(key)
        if v:
            summary = str(v)
            break
    if len(summary) > 100:
        summary = summary[:97] + "..."
    return ts, channel, kind, summary


def summarize_flags() -> list[tuple[str, str]]:
    """Return [(label, value)] pairs describing current flag state."""
    snap = flags.snapshot()
    rows: list[tuple[str, str]] = []
    rows.append(("Master switch (supervisor.enabled)",
                 "ON" if snap["supervisor.enabled"] else "OFF"))
    rows.append(("Shadow mode (supervisor.shadow_mode)",
                 "ON -- observe only" if snap["supervisor.shadow_mode"]
                 else "OFF -- supervisor is ACTIVE"))
    for ch in ("runtime", "training", "dataset", "install"):
        key = f"supervisor.{ch}_failures"
        rows.append((key, "ON" if snap.get(key) else "off"))
    rows.append(("supervisor.auto_apply_safe",
                 "ON" if snap.get("supervisor.auto_apply_safe") else "off"))
    rows.append(("bootstrap.use_ai_installer",
                 "ON" if snap.get("bootstrap.use_ai_installer") else "off"))
    return rows


# ---------------------------------------------------------------------------
# Qt widget
# ---------------------------------------------------------------------------


class SupervisorPage(QWidget):
    """Dashboard for the OWLLM supervisor: shadow log + flag state."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._build_ui()
        self._timer = QTimer(self)
        self._timer.timeout.connect(self.refresh)
        self._timer.start(REFRESH_INTERVAL_MS)
        self.refresh()

    # ------------------------------------------------------------------
    # UI construction
    # ------------------------------------------------------------------

    def _build_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(12)

        # Header: title + flag-file path hint + refresh button
        header = QHBoxLayout()
        title = QLabel("<h2>Supervisor (shadow mode)</h2>")
        title.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        header.addWidget(title)

        self._refresh_btn = QPushButton("Refresh")
        self._refresh_btn.clicked.connect(self.refresh)
        header.addWidget(self._refresh_btn)
        layout.addLayout(header)

        # Hint label: where to flip flags
        from core.supervisor.flags import _flags_path  # internal but stable enough
        try:
            flag_path = _flags_path()
        except Exception:
            flag_path = None
        hint_text = (
            f"Edit <code>{flag_path}</code> to change flags. "
            "Master switch off = entire supervisor is dead code."
        ) if flag_path else "Flags read from feature_flags.json"
        hint = QLabel(hint_text)
        hint.setTextFormat(Qt.RichText)
        hint.setWordWrap(True)
        hint.setStyleSheet("color: #888;")
        layout.addWidget(hint)

        # Flag state group
        flag_group = QGroupBox("Current flags")
        flag_layout = QVBoxLayout(flag_group)
        self._flag_label = QLabel("loading...")
        self._flag_label.setTextFormat(Qt.RichText)
        self._flag_label.setWordWrap(True)
        flag_layout.addWidget(self._flag_label)
        layout.addWidget(flag_group)

        # Splitter: events table on top, raw JSON detail at bottom
        splitter = QSplitter(Qt.Vertical)

        events_group = QGroupBox("Recent shadow events (most recent first)")
        events_layout = QVBoxLayout(events_group)
        self._table = QTableWidget(0, 4)
        self._table.setHorizontalHeaderLabels(["Time", "Channel", "Kind", "Summary"])
        self._table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeToContents)
        self._table.horizontalHeader().setStretchLastSection(True)
        self._table.verticalHeader().setVisible(False)
        self._table.setEditTriggers(QTableWidget.NoEditTriggers)
        self._table.setSelectionBehavior(QTableWidget.SelectRows)
        self._table.itemSelectionChanged.connect(self._on_row_selected)
        events_layout.addWidget(self._table)
        splitter.addWidget(events_group)

        detail_group = QGroupBox("Selected event (raw JSON)")
        detail_layout = QVBoxLayout(detail_group)
        self._detail = QTextEdit()
        self._detail.setReadOnly(True)
        self._detail.setPlaceholderText("Click a row above to inspect the full event.")
        self._detail.setStyleSheet("font-family: Consolas, 'Courier New', monospace;")
        detail_layout.addWidget(self._detail)
        splitter.addWidget(detail_group)

        splitter.setSizes([400, 200])
        layout.addWidget(splitter, stretch=1)

        # Empty-state footer
        self._empty_state = QLabel("")
        self._empty_state.setStyleSheet("color: #c33; padding: 8px;")
        self._empty_state.setWordWrap(True)
        layout.addWidget(self._empty_state)

        # Cached events for detail lookup
        self._events_cache: list[Mapping[str, Any]] = []

    # ------------------------------------------------------------------
    # Refresh
    # ------------------------------------------------------------------

    def refresh(self) -> None:
        try:
            self._render_flags()
            self._render_events()
        except Exception as e:
            # Never let a UI bug bring the tab down -- show the error,
            # log to console, keep going.
            self._empty_state.setText(f"refresh failed: {e}")

    def _render_flags(self) -> None:
        rows = summarize_flags()
        html_rows = []
        for label, value in rows:
            color = "#3a3" if value.startswith("ON") and "shadow" not in label.lower() and "ACTIVE" not in value else "#888"
            if "ACTIVE" in value:
                color = "#c33"
            html_rows.append(
                f"<tr><td style='padding-right:18px;'>{label}</td>"
                f"<td><span style='color:{color};font-weight:600;'>{value}</span></td></tr>"
            )
        self._flag_label.setText("<table>" + "".join(html_rows) + "</table>")

    def _render_events(self) -> None:
        events = shadow.read_all()
        self._events_cache = list(reversed(events))[:MAX_ROWS_DISPLAYED]

        self._table.setRowCount(len(self._events_cache))
        for row_idx, ev in enumerate(self._events_cache):
            ts, channel, kind, summary = format_row(ev)
            self._table.setItem(row_idx, 0, QTableWidgetItem(ts))
            self._table.setItem(row_idx, 1, QTableWidgetItem(channel))
            self._table.setItem(row_idx, 2, QTableWidgetItem(kind))
            self._table.setItem(row_idx, 3, QTableWidgetItem(summary))

        # Empty-state message
        if not self._events_cache:
            if not flags.supervisor_enabled():
                self._empty_state.setText(
                    "Supervisor is OFF in production mode. To start collecting "
                    "shadow data on this machine, edit feature_flags.json and set "
                    "supervisor.enabled = true (shadow_mode stays true so nothing "
                    "is acted upon)."
                )
            else:
                self._empty_state.setText(
                    "Supervisor is ON but no events have been observed yet. "
                    "Trigger a runtime probe failure (e.g. load a model that "
                    "needs a missing package) to generate the first row."
                )
        else:
            self._empty_state.setText("")

    def _on_row_selected(self) -> None:
        rows = self._table.selectionModel().selectedRows()
        if not rows:
            self._detail.clear()
            return
        idx = rows[0].row()
        if idx < 0 or idx >= len(self._events_cache):
            return
        ev = self._events_cache[idx]
        self._detail.setPlainText(json.dumps(ev, indent=2, ensure_ascii=False))
