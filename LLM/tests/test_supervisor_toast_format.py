"""Pure-helper tests for the supervisor toast widget.

The widget itself is Qt and not unit-tested here; we test the
data-shaping helpers (format_proposal, trust_color, decision_for_timeout)
that prepare strings for the UI. Those are deterministic and small.
"""
import sys
from pathlib import Path

import pytest

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

pytest.importorskip("PySide6")

from desktop_app.widgets.supervisor_toast import (  # noqa: E402
    DECISION_APPLY, DECISION_NEVER, DECISION_SKIP,
    TRUST_CONFIRM, TRUST_DANGER, TRUST_SAFE, VALID_DECISIONS,
    decision_for_timeout, format_proposal, trust_color,
)


# ---------------------------------------------------------------------------
# format_proposal
# ---------------------------------------------------------------------------


def test_format_proposal_install_pkg():
    title, body, reason = format_proposal({
        "action": "install_pkg",
        "args": {"name": "bitsandbytes", "version": "0.44.1"},
        "reason": "torch 2.5 ABI requires bnb >= 0.44",
    })
    assert title == "Apply install_pkg bitsandbytes==0.44.1?"
    assert "name: bitsandbytes" in body
    assert "version: 0.44.1" in body
    assert reason == "torch 2.5 ABI requires bnb >= 0.44"


def test_format_proposal_no_name_arg():
    title, body, reason = format_proposal({
        "action": "clear_pip_cache",
        "args": {},
        "reason": "stale wheels block install",
    })
    assert title == "Apply clear_pip_cache?"
    assert body == ""
    assert reason == "stale wheels block install"


def test_format_proposal_truncates_long_args():
    args = {f"k{i}": f"v{i}" for i in range(12)}
    _, body, _ = format_proposal({"action": "x", "args": args})
    lines = body.splitlines()
    # 6 visible lines + the truncation hint
    assert len(lines) == 7
    assert lines[-1].startswith("... +")


def test_format_proposal_handles_missing_keys():
    title, body, reason = format_proposal({})
    # "?" placeholder for action + literal "?" terminator -> "Apply ??"
    assert title == "Apply ??"
    assert body == ""
    assert reason == ""


def test_format_proposal_non_mapping_args_safe():
    """If args is malformed (not a mapping), don't crash."""
    title, body, reason = format_proposal({
        "action": "install_pkg",
        "args": "this should not be a string",
        "reason": "x",
    })
    assert "install_pkg" in title
    assert body == ""


# ---------------------------------------------------------------------------
# trust_color -- ensures every tier maps to a sensible accent
# ---------------------------------------------------------------------------


def test_trust_colors_distinct():
    safe = trust_color(TRUST_SAFE)
    confirm = trust_color(TRUST_CONFIRM)
    danger = trust_color(TRUST_DANGER)
    assert safe != confirm != danger
    # All valid hex
    for c in (safe, confirm, danger):
        assert c.startswith("#") and len(c) == 7


def test_trust_color_unknown_falls_back():
    # Not crashing matters more than which color we pick
    c = trust_color("not_a_real_tier")
    assert c.startswith("#")


# ---------------------------------------------------------------------------
# decision_for_timeout -- safety contract
# ---------------------------------------------------------------------------


def test_timeout_always_skips_no_silent_apply():
    """The most important property: a timeout must NEVER auto-apply.
    Users walk away. The supervisor should not act on absence."""
    for trust in (TRUST_SAFE, TRUST_CONFIRM, TRUST_DANGER):
        assert decision_for_timeout(trust) == DECISION_SKIP


def test_decision_constants_in_valid_set():
    assert DECISION_APPLY in VALID_DECISIONS
    assert DECISION_SKIP in VALID_DECISIONS
    assert DECISION_NEVER in VALID_DECISIONS
