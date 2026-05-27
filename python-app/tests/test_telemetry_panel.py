"""Tests for the telemetry panel's pure data layer.

We don't instantiate the Qt widget here — that requires QApplication
and adds CI surface for no extra confidence. Instead we cover the
``render_rows`` function that turns a ToolTelemetry snapshot into the
table rows the widget displays. If render_rows is correct, the widget
just paints what it's given.
"""
import sys
from pathlib import Path

import pytest

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

from core.agents.tools import ToolTelemetry
from desktop_app.widgets.telemetry_panel import (
    COL_CALLS,
    COL_CRASHES,
    COL_ERRORS,
    COL_ERR_RATE,
    COL_LAST_ERROR,
    COL_P50,
    COL_P95,
    COL_RETRIES,
    COL_TOOL,
    render_rows,
)


class TestRenderRows:
    def test_empty_telemetry_returns_empty_list(self):
        assert render_rows(ToolTelemetry()) == []

    def test_single_tool_row(self):
        t = ToolTelemetry()
        t.record("read_file", 12.5, ok=True)
        t.record("read_file", 8.0, ok=True)
        rows = render_rows(t)
        assert len(rows) == 1
        row = rows[0]
        assert row[COL_TOOL] == "read_file"
        assert row[COL_CALLS] == 2
        assert row[COL_ERRORS] == 0
        assert row[COL_ERR_RATE] == 0.0
        # p50 of [8, 12.5] = the middle element of sorted = 12.5 (len//2 index)
        assert row[COL_P50] >= 8.0
        assert row[COL_LAST_ERROR] == ""

    def test_error_rate_computed(self):
        t = ToolTelemetry()
        t.record("grep", 5.0, ok=True)
        t.record("grep", 5.0, ok=False, error="boom")
        t.record("grep", 5.0, ok=False, error="kapow")
        t.record("grep", 5.0, ok=True)
        row = render_rows(t)[0]
        assert row[COL_CALLS] == 4
        assert row[COL_ERRORS] == 2
        assert row[COL_ERR_RATE] == 50.0

    def test_zero_calls_avoids_div_by_zero(self):
        # Manually create a tool stat with no calls (edge case from a
        # registered-but-never-invoked tool path).
        t = ToolTelemetry()
        t.record_retry("ghost")  # bumps retries without bumping calls
        rows = render_rows(t)
        ghost = next(r for r in rows if r[COL_TOOL] == "ghost")
        assert ghost[COL_CALLS] == 0
        assert ghost[COL_ERR_RATE] == 0.0
        assert ghost[COL_RETRIES] == 1

    def test_last_error_carried_through(self):
        t = ToolTelemetry()
        t.record("shell", 1.0, ok=False, error="permission denied")
        row = render_rows(t)[0]
        assert "permission denied" in row[COL_LAST_ERROR]

    def test_crashes_counted_separately(self):
        t = ToolTelemetry()
        t.record("buggy", 1.0, ok=False, crashed=True, error="kaboom")
        t.record("buggy", 1.0, ok=False, error="boom")
        row = render_rows(t)[0]
        assert row[COL_CRASHES] == 1
        assert row[COL_ERRORS] == 2  # both ok=False count as errors

    def test_multiple_tools_sorted_by_name(self):
        t = ToolTelemetry()
        for name in ("zebra", "alpha", "mango"):
            t.record(name, 1.0, ok=True)
        names = [r[COL_TOOL] for r in render_rows(t)]
        assert names == ["alpha", "mango", "zebra"]

    def test_p95_present(self):
        t = ToolTelemetry()
        for ms in (1.0, 2.0, 3.0, 4.0, 5.0, 100.0):
            t.record("x", ms, ok=True)
        row = render_rows(t)[0]
        # p95 of 6-element series = element at index min(5, 5) = 100.0
        assert row[COL_P95] >= 5.0


class TestTelemetryReset:
    def test_reset_clears_snapshot(self):
        t = ToolTelemetry()
        t.record("x", 1.0, ok=True)
        assert render_rows(t)
        t.reset()
        assert render_rows(t) == []
