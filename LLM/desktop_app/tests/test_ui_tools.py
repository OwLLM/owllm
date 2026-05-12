"""End-to-end tests for the agent-facing ui_tools.

These tests drive the same code path an LLM agent would hit. Each
calls a tool's `.func(args)` directly, just like
`ToolRegistry.invoke` would after argument validation. If these
pass, an agent that picks up the registry and emits well-formed
calls will get the same answers.

The test target is `desktop_app.tests.fixtures.greeting_card:GreetingCard`
— a real, importable, trivially-sized widget that lives in this
test tree. No production widget dependencies are required.
"""
from __future__ import annotations

import json

import pytest

from core.agents.tools.base import ToolError
from core.agents.tools.ui_tools import (
    ui_diff_baseline,
    ui_inspect_widget,
    ui_list_baselines,
    ui_render_widget,
    ui_update_baseline,
)


_TARGET = "desktop_app.tests.fixtures.greeting_card:GreetingCard"


# ---------------------------------------------------------------------------
# ui_render_widget
# ---------------------------------------------------------------------------


def test_render_writes_png(tmp_path) -> None:
    out = tmp_path / "greeting.png"
    result = ui_render_widget.func({"target": _TARGET, "out_path": str(out)})
    assert out.exists()
    assert out.stat().st_size > 100
    assert "300x120" in result
    # Heads of a PNG file.
    assert out.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")


def test_render_honors_kwargs(tmp_path) -> None:
    out_a = tmp_path / "a.png"
    out_b = tmp_path / "b.png"
    ui_render_widget.func({
        "target": _TARGET,
        "out_path": str(out_a),
        "kwargs": json.dumps({"greeting": "Hello"}),
    })
    ui_render_widget.func({
        "target": _TARGET,
        "out_path": str(out_b),
        "kwargs": json.dumps({"greeting": "Goodbye"}),
    })
    # Two different greetings -> two different PNG payloads.
    assert out_a.read_bytes() != out_b.read_bytes()


def test_render_rejects_missing_out_path() -> None:
    with pytest.raises(ToolError, match="out_path is required"):
        ui_render_widget.func({"target": _TARGET, "out_path": ""})


def test_render_rejects_unimportable_target() -> None:
    with pytest.raises(ToolError, match="could not import"):
        ui_render_widget.func({
            "target": "no.such.module:Foo",
            "out_path": "x.png",
        })


def test_render_rejects_missing_class() -> None:
    with pytest.raises(ToolError, match="has no attribute"):
        ui_render_widget.func({
            "target": "desktop_app.tests.fixtures.greeting_card:DoesNotExist",
            "out_path": "x.png",
        })


def test_render_rejects_bad_target_format() -> None:
    with pytest.raises(ToolError, match="invalid target"):
        ui_render_widget.func({
            "target": "no_separator_at_all",
            "out_path": "x.png",
        })


def test_render_surfaces_ctor_kwarg_errors() -> None:
    with pytest.raises(ToolError, match="could not construct"):
        ui_render_widget.func({
            "target": _TARGET,
            "out_path": "x.png",
            "kwargs": json.dumps({"unknown_kwarg": 1}),
        })


def test_render_kwargs_accepts_dict_too(tmp_path) -> None:
    """LLM tool-call schemas sometimes pass kwargs as an already-parsed
    dict rather than a JSON string. Both paths must work."""
    out = tmp_path / "x.png"
    ui_render_widget.func({
        "target": _TARGET,
        "out_path": str(out),
        "kwargs": {"greeting": "Direct dict"},
    })
    assert out.exists()


# ---------------------------------------------------------------------------
# ui_inspect_widget
# ---------------------------------------------------------------------------


def test_inspect_lists_known_object_names() -> None:
    body = ui_inspect_widget.func({"target": _TARGET})
    # The fixture exposes object_name on the root + label + button.
    assert "greeting_card" in body
    assert "greeting_label" in body
    assert "save_btn" in body


def test_inspect_respects_limit() -> None:
    body = ui_inspect_widget.func({"target": _TARGET, "limit": 1})
    # Header line + exactly one widget line.
    assert body.count("\n") == 1


def test_inspect_rejects_bad_limit() -> None:
    with pytest.raises(ToolError, match="limit must be an integer"):
        ui_inspect_widget.func({"target": _TARGET, "limit": "many"})


# ---------------------------------------------------------------------------
# ui_diff_baseline / ui_update_baseline round-trip
# ---------------------------------------------------------------------------


def test_diff_against_missing_baseline_writes_actual(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        "desktop_app.ui_probe.baseline._BASELINES_DIR",
        tmp_path,
    )
    out = ui_diff_baseline.func({
        "target": _TARGET,
        "baseline_name": "fresh_card",
    })
    assert "no baseline" in out
    # `.actual.png` is written next to where the baseline would live.
    actual = tmp_path / "fresh_card.actual.png"
    assert actual.exists()


def test_update_then_diff_passes(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        "desktop_app.ui_probe.baseline._BASELINES_DIR",
        tmp_path,
    )
    # 1) Establish baseline.
    update_msg = ui_update_baseline.func({
        "target": _TARGET,
        "baseline_name": "card_v1",
    })
    assert "wrote baseline" in update_msg
    assert (tmp_path / "card_v1.png").exists()

    # 2) Same render → diff passes.
    diff_msg = ui_diff_baseline.func({
        "target": _TARGET,
        "baseline_name": "card_v1",
    })
    assert diff_msg.startswith("OK")


def test_diff_reports_drift_when_kwargs_change(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        "desktop_app.ui_probe.baseline._BASELINES_DIR",
        tmp_path,
    )
    ui_update_baseline.func({
        "target": _TARGET,
        "baseline_name": "card_v2",
        "kwargs": json.dumps({"greeting": "Hello"}),
    })
    # Render with a different greeting → diff must flag DIFF.
    diff_msg = ui_diff_baseline.func({
        "target": _TARGET,
        "baseline_name": "card_v2",
        "kwargs": json.dumps({"greeting": "Goodbye"}),
    })
    assert diff_msg.startswith("DIFF")
    # An .actual.png is left behind so a human can inspect.
    assert (tmp_path / "card_v2.actual.png").exists()


# ---------------------------------------------------------------------------
# ui_list_baselines
# ---------------------------------------------------------------------------


def test_list_baselines_returns_empty_message(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        "desktop_app.ui_probe.baseline._BASELINES_DIR",
        tmp_path,
    )
    out = ui_list_baselines.func({})
    assert "no baselines" in out


def test_list_baselines_enumerates_pngs(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        "desktop_app.ui_probe.baseline._BASELINES_DIR",
        tmp_path,
    )
    ui_update_baseline.func({"target": _TARGET, "baseline_name": "alpha"})
    ui_update_baseline.func({"target": _TARGET, "baseline_name": "beta"})
    out = ui_list_baselines.func({})
    assert "alpha" in out
    assert "beta" in out
    assert "2 baseline" in out


# ---------------------------------------------------------------------------
# Registry plumbing
# ---------------------------------------------------------------------------


def test_ui_tools_are_in_builtin_registry() -> None:
    """The registry constructor should preload all five ui_tools so
    any agent that uses the default registry can call them."""
    from core.agents.tools.builtin import builtin_registry

    reg = builtin_registry()
    names = set(reg.names())
    for expected in (
        "ui_render_widget",
        "ui_inspect_widget",
        "ui_diff_baseline",
        "ui_list_baselines",
        "ui_update_baseline",
    ):
        assert expected in names, f"missing {expected} from builtin_registry"


def test_ui_update_baseline_requires_approval() -> None:
    """Overwriting a golden file is a deliberate act — the registry
    must route through ApprovalGate."""
    assert ui_update_baseline.requires_approval is True
    # And the read-only siblings must NOT require approval.
    assert ui_render_widget.requires_approval is False
    assert ui_diff_baseline.requires_approval is False
    assert ui_inspect_widget.requires_approval is False
    assert ui_list_baselines.requires_approval is False
