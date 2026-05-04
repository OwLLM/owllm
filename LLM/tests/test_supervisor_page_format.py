"""Unit tests for the supervisor-page data layer.

We don't test Qt rendering here -- only the pure functions that prepare
data for the table and flag panel. They live in supervisor_page.py as
module-level helpers exactly so they CAN be tested without spinning up
QApplication.
"""
import json
import sys
from pathlib import Path

import pytest

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

from core.supervisor import flags  # noqa: E402

# Importing the page module triggers a PySide6 import. Skip the test module
# entirely if PySide6 isn't available in the test environment -- the page
# functions can't be imported without it.
pytest.importorskip("PySide6")

from desktop_app.pages.supervisor_page import format_row, summarize_flags  # noqa: E402


@pytest.fixture(autouse=True)
def _isolate_flags(tmp_path):
    flags.set_path_for_testing(tmp_path / "feature_flags.json")
    yield
    flags.set_path_for_testing(None)


# ---------------------------------------------------------------------------
# format_row
# ---------------------------------------------------------------------------


def test_format_row_extracts_basic_fields():
    ev = {
        "ts": "2026-05-04T10:00:00.000000Z",
        "channel": "runtime",
        "trigger": {
            "kind": "runtime_probe_failed",
            "reason_code": "MODULE_NOT_FOUND",
            "error_message": "ModuleNotFoundError: No module named 'bitsandbytes'",
        },
    }
    ts, channel, kind, summary = format_row(ev)
    assert ts == "2026-05-04T10:00:00.000000Z"
    assert channel == "runtime"
    assert kind == "runtime_probe_failed"
    assert summary == "MODULE_NOT_FOUND"  # reason_code preferred


def test_format_row_falls_back_through_summary_keys():
    ev = {"ts": "t", "channel": "training", "trigger": {
        "kind": "gpu_oom",
        "category": "memory",
        "model_path": "/x/y.gguf",
    }}
    _, _, _, summary = format_row(ev)
    assert summary == "memory"  # category beats model_path


def test_format_row_long_summary_is_truncated():
    long_msg = "X" * 500
    ev = {"trigger": {"kind": "x", "error_message": long_msg}}
    _, _, _, summary = format_row(ev)
    assert len(summary) <= 100
    assert summary.endswith("...")


def test_format_row_handles_missing_fields():
    # Defensive: shadow log might have malformed rows
    _, channel, kind, summary = format_row({})
    assert channel == "?"
    assert kind == "?"
    assert summary == ""


# ---------------------------------------------------------------------------
# summarize_flags
# ---------------------------------------------------------------------------


def test_summarize_flags_default_state(tmp_path):
    """Default flags: master OFF, shadow ON."""
    flags.set_path_for_testing(tmp_path / "f.json")
    rows = summarize_flags()
    labels = [r[0] for r in rows]
    values = [r[1] for r in rows]
    # Master should be OFF
    master_idx = next(i for i, lbl in enumerate(labels) if "Master switch" in lbl)
    assert values[master_idx] == "OFF"
    # Shadow should be ON
    shadow_idx = next(i for i, lbl in enumerate(labels) if "Shadow mode" in lbl)
    assert "ON" in values[shadow_idx]


def test_summarize_flags_when_active(tmp_path):
    p = tmp_path / "f.json"
    p.write_text(json.dumps({
        "supervisor.enabled": True,
        "supervisor.shadow_mode": False,
        "supervisor.runtime_failures": True,
    }))
    flags.set_path_for_testing(p)
    rows = dict(summarize_flags())
    assert rows["Master switch (supervisor.enabled)"] == "ON"
    assert "ACTIVE" in rows["Shadow mode (supervisor.shadow_mode)"]
    assert rows["supervisor.runtime_failures"] == "ON"


def test_summarize_flags_includes_all_known(tmp_path):
    flags.set_path_for_testing(tmp_path / "f.json")
    labels = [r[0] for r in summarize_flags()]
    assert any("supervisor.training_failures" in l for l in labels)
    assert any("supervisor.dataset_failures" in l for l in labels)
    assert any("supervisor.install_failures" in l for l in labels)
    assert any("supervisor.auto_apply_safe" in l for l in labels)
    assert any("bootstrap.use_ai_installer" in l for l in labels)
