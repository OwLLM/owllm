"""Tool-call telemetry panel.

Surfaces the per-tool stats collected by :class:`ToolTelemetry` so the
operator can see, at a glance, which tools are being called, how often
they error, how long they take, and what the last error message was.

Used by the Workspace page's "📊 Telemetry" button — opens this as a
non-modal dialog. Auto-refreshes every 2 s while visible. Sortable
columns; click a header to reverse order. "Clear" wipes the underlying
:class:`ToolTelemetry` (handy after a noisy debugging session).

Decoupled from any specific page — pass any :class:`ToolTelemetry`
instance in the constructor.
"""
from __future__ import annotations

from typing import Optional

from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QBrush, QColor, QFont
from PySide6.QtWidgets import (
    QDialog,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from core.agents.tools import ToolTelemetry


# Column order is the visible order; we expose a constant so tests can
# index without magic numbers and so re-ordering is a single-line edit.
COL_TOOL = 0
COL_CALLS = 1
COL_ERRORS = 2
COL_ERR_RATE = 3
COL_RETRIES = 4
COL_CRASHES = 5
COL_P50 = 6
COL_P95 = 7
COL_LAST_ERROR = 8

_HEADERS = (
    "Tool", "Calls", "Errors", "Err %", "Retries", "Crashes",
    "p50 (ms)", "p95 (ms)", "Last error",
)


def render_rows(telemetry: ToolTelemetry) -> list:
    """Pure function: turn a telemetry snapshot into row tuples for the table.

    Lives at module scope (not on the widget) so it can be tested without
    instantiating Qt. Each row is a tuple positionally aligned with
    ``_HEADERS``. Stable sort by name; the table re-sorts itself when
    the user clicks a header.
    """
    snap = telemetry.snapshot()
    rows = []
    for name in sorted(snap.keys()):
        s = snap[name]
        calls = int(s.get("calls", 0))
        errors = int(s.get("errors", 0))
        err_rate = (errors / calls * 100.0) if calls else 0.0
        rows.append((
            name,
            calls,
            errors,
            err_rate,
            int(s.get("retries", 0)),
            int(s.get("crashes", 0)),
            float(s.get("p50", 0.0)),
            float(s.get("p95", 0.0)),
            str(s.get("last_error", "")),
        ))
    return rows


class TelemetryPanel(QDialog):
    """Non-modal telemetry dialog. Auto-refreshes every 2 seconds while shown."""

    REFRESH_MS = 2000

    def __init__(self, telemetry: ToolTelemetry, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self._telemetry = telemetry
        self.setWindowTitle("Tool Telemetry")
        # Non-modal so the user can keep working while it's open.
        self.setModal(False)
        self.resize(820, 460)

        self._build_ui()
        self._refresh()

        # Drive refreshes off a QTimer so the widget never blocks the UI.
        self._timer = QTimer(self)
        self._timer.setInterval(self.REFRESH_MS)
        self._timer.timeout.connect(self._refresh)
        self._timer.start()

    # ------------------------------------------------------------------
    # UI
    # ------------------------------------------------------------------

    def _build_ui(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(16, 14, 16, 14)
        outer.setSpacing(10)

        title = QLabel("Tool Telemetry")
        tf = QFont()
        tf.setPointSize(15)
        tf.setBold(True)
        title.setFont(tf)
        outer.addWidget(title)

        self.summary_label = QLabel("")
        self.summary_label.setStyleSheet("color:#9aa0a6; font-size:11px;")
        outer.addWidget(self.summary_label)

        self.table = QTableWidget()
        self.table.setColumnCount(len(_HEADERS))
        self.table.setHorizontalHeaderLabels(_HEADERS)
        self.table.verticalHeader().setVisible(False)
        self.table.setSortingEnabled(True)
        self.table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.table.setSelectionBehavior(QTableWidget.SelectRows)
        self.table.setAlternatingRowColors(True)
        self.table.setStyleSheet(
            "QTableWidget { background:#14171d; color:#dadcdf; gridline-color:#23283a; "
            " border:none; border-radius:8px; }"
            "QTableWidget::item:selected { background:#2a3142; color:#fff; }"
            "QHeaderView::section { background:#1a1d24; color:#9aa0a6; padding:6px;"
            " border:none; border-right:1px solid #23283a; font-weight:600; }"
            "QTableWidget { alternate-background-color:#181b22; }"
        )
        # Last-error column should expand; numeric columns sized to content.
        hdr = self.table.horizontalHeader()
        for col in range(len(_HEADERS) - 1):
            hdr.setSectionResizeMode(col, QHeaderView.ResizeToContents)
        hdr.setSectionResizeMode(COL_LAST_ERROR, QHeaderView.Stretch)
        outer.addWidget(self.table, 1)

        # Action row.
        actions = QHBoxLayout()
        actions.setSpacing(8)
        actions.addStretch(1)

        refresh_btn = QPushButton("Refresh now")
        refresh_btn.setStyleSheet(_GHOST_BTN)
        refresh_btn.clicked.connect(self._refresh)
        actions.addWidget(refresh_btn)

        clear_btn = QPushButton("Clear stats")
        clear_btn.setToolTip("Reset all counters and latency rings to zero.")
        clear_btn.setStyleSheet(_GHOST_BTN)
        clear_btn.clicked.connect(self._on_clear_clicked)
        actions.addWidget(clear_btn)

        close_btn = QPushButton("Close")
        close_btn.setStyleSheet(_PRIMARY_BTN)
        close_btn.clicked.connect(self.accept)
        actions.addWidget(close_btn)
        outer.addLayout(actions)

    # ------------------------------------------------------------------
    # Refresh
    # ------------------------------------------------------------------

    def _refresh(self) -> None:
        rows = render_rows(self._telemetry)
        # Repaint without losing the user's sort/scroll position.
        sort_col = self.table.horizontalHeader().sortIndicatorSection()
        sort_order = self.table.horizontalHeader().sortIndicatorOrder()

        self.table.setSortingEnabled(False)
        self.table.setRowCount(len(rows))
        for r, row in enumerate(rows):
            self._set_row(r, row)
        self.table.setSortingEnabled(True)
        self.table.sortItems(sort_col, sort_order)

        total_calls = sum(row[COL_CALLS] for row in rows)
        total_errors = sum(row[COL_ERRORS] for row in rows)
        total_retries = sum(row[COL_RETRIES] for row in rows)
        total_crashes = sum(row[COL_CRASHES] for row in rows)
        if rows:
            self.summary_label.setText(
                f"{len(rows)} tool(s) tracked · {total_calls} calls · "
                f"{total_errors} errors · {total_retries} retries · "
                f"{total_crashes} crashes · auto-refresh every {self.REFRESH_MS // 1000}s"
            )
        else:
            self.summary_label.setText(
                "No tool calls recorded yet. Send the agents a goal and come back."
            )

    def _set_row(self, r: int, row: tuple) -> None:
        name, calls, errors, err_rate, retries, crashes, p50, p95, last = row

        def _txt(value: str) -> QTableWidgetItem:
            item = QTableWidgetItem(value)
            item.setTextAlignment(Qt.AlignVCenter | Qt.AlignLeft)
            return item

        def _num(value: float, *, fmt: str = "{:.0f}") -> QTableWidgetItem:
            # NumericSortItem so column-sort respects numeric order, not lexical.
            item = _NumericItem(value, fmt.format(value))
            item.setTextAlignment(Qt.AlignVCenter | Qt.AlignRight)
            return item

        self.table.setItem(r, COL_TOOL, _txt(name))
        self.table.setItem(r, COL_CALLS, _num(calls))
        err_item = _num(errors)
        if errors:
            err_item.setForeground(QBrush(QColor("#ff8c8c")))
        self.table.setItem(r, COL_ERRORS, err_item)
        rate_item = _num(err_rate, fmt="{:.1f}")
        if err_rate >= 25.0:
            rate_item.setForeground(QBrush(QColor("#ff8c8c")))
        elif err_rate >= 5.0:
            rate_item.setForeground(QBrush(QColor("#ffb86b")))
        self.table.setItem(r, COL_ERR_RATE, rate_item)
        self.table.setItem(r, COL_RETRIES, _num(retries))
        crash_item = _num(crashes)
        if crashes:
            crash_item.setForeground(QBrush(QColor("#ff5470")))
            f = crash_item.font()
            f.setBold(True)
            crash_item.setFont(f)
        self.table.setItem(r, COL_CRASHES, crash_item)
        self.table.setItem(r, COL_P50, _num(p50, fmt="{:.1f}"))
        p95_item = _num(p95, fmt="{:.1f}")
        if p95 >= 1000:
            p95_item.setForeground(QBrush(QColor("#ffb86b")))
        self.table.setItem(r, COL_P95, p95_item)
        last_item = _txt(last[:200])
        if last:
            last_item.setForeground(QBrush(QColor("#9aa0a6")))
            last_item.setToolTip(last)
        self.table.setItem(r, COL_LAST_ERROR, last_item)

    # ------------------------------------------------------------------
    # Slots
    # ------------------------------------------------------------------

    def _on_clear_clicked(self) -> None:
        self._telemetry.reset()
        self._refresh()

    # Stop the refresh timer when closed so we don't keep firing on a
    # hidden widget. exec()/show() callers don't have to do anything.
    def closeEvent(self, ev) -> None:  # noqa: N802
        self._timer.stop()
        super().closeEvent(ev)


# ---------------------------------------------------------------------------
# Sorting helper
# ---------------------------------------------------------------------------


class _NumericItem(QTableWidgetItem):
    """QTableWidgetItem with numeric sort. The default sort is lexical, so
    "100" would sort before "9". We override ``__lt__`` to compare the
    underlying float we stash on the item."""

    def __init__(self, value: float, display: str) -> None:
        super().__init__(display)
        self._value = float(value)
        # Right-aligned numerics; centred would jitter as widths change.
        self.setTextAlignment(Qt.AlignVCenter | Qt.AlignRight)

    def __lt__(self, other: object) -> bool:  # noqa: D401
        if isinstance(other, _NumericItem):
            return self._value < other._value
        return super().__lt__(other)


# ---------------------------------------------------------------------------
# Styles
# ---------------------------------------------------------------------------


_GHOST_BTN = (
    "QPushButton { background:rgba(255,255,255,0.05); color:#dadcdf;"
    " border:none; border-radius:8px; padding:6px 14px; }"
    "QPushButton:hover { background:rgba(255,255,255,0.10); }"
)

_PRIMARY_BTN = (
    "QPushButton { background:#4a6cff; color:white; border:none;"
    " border-radius:8px; padding:6px 18px; font-weight:600; }"
    "QPushButton:hover { background:#5a7bff; }"
)
