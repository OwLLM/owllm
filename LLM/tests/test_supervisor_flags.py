"""Feature-flag defaults are part of the safety contract.

The supervisor must be inert in production until a deliberate release flips
a flag. These tests pin every default and the master-switch semantics so a
careless edit can't accidentally turn the supervisor on for everyone.
"""
import json
import sys
from pathlib import Path

import pytest

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

from core.supervisor import flags  # noqa: E402


@pytest.fixture(autouse=True)
def _isolate_flags(tmp_path):
    """Point the flag reader at a fresh tempdir per test."""
    flags.set_path_for_testing(tmp_path / "feature_flags.json")
    yield
    flags.set_path_for_testing(None)


# ---------------------------------------------------------------------------
# Production-defaults contract
# ---------------------------------------------------------------------------


def test_master_switch_defaults_off():
    """If this fails, the supervisor is on for everyone -- BLOCK any release."""
    assert flags.flag("supervisor.enabled") is False
    assert flags.supervisor_enabled() is False


def test_shadow_mode_defaults_on():
    """When the master switch is ever flipped on, shadow mode must be on too --
    the supervisor must not act on its first deployment."""
    assert flags.flag("supervisor.shadow_mode") is True


def test_per_channel_flags_default_off():
    for channel in ("runtime", "training", "dataset", "install"):
        assert flags.flag(f"supervisor.{channel}_failures") is False


def test_auto_apply_defaults_off():
    assert flags.flag("supervisor.auto_apply_safe") is False


def test_ai_installer_defaults_off():
    assert flags.flag("bootstrap.use_ai_installer") is False


# ---------------------------------------------------------------------------
# supervisor_active() gate
# ---------------------------------------------------------------------------


def test_active_false_when_master_off(tmp_path):
    flags.set_path_for_testing(tmp_path / "f.json")
    assert flags.supervisor_active("training") is False


def test_active_false_in_shadow_mode_even_when_channel_on(tmp_path):
    p = tmp_path / "f.json"
    p.write_text(json.dumps({
        "supervisor.enabled": True,
        "supervisor.shadow_mode": True,
        "supervisor.training_failures": True,
    }))
    flags.set_path_for_testing(p)
    assert flags.supervisor_active("training") is False


def test_active_true_when_all_three_aligned(tmp_path):
    p = tmp_path / "f.json"
    p.write_text(json.dumps({
        "supervisor.enabled": True,
        "supervisor.shadow_mode": False,
        "supervisor.training_failures": True,
    }))
    flags.set_path_for_testing(p)
    assert flags.supervisor_active("training") is True


# ---------------------------------------------------------------------------
# File handling
# ---------------------------------------------------------------------------


def test_missing_file_yields_defaults(tmp_path):
    flags.set_path_for_testing(tmp_path / "does_not_exist.json")
    assert flags.flag("supervisor.enabled") is False
    assert flags.supervisor_enabled() is False


def test_corrupt_file_yields_defaults_no_crash(tmp_path):
    p = tmp_path / "f.json"
    p.write_text("{not valid json", encoding="utf-8")
    flags.set_path_for_testing(p)
    # Must not raise
    assert flags.flag("supervisor.enabled") is False


def test_unknown_flag_raises():
    with pytest.raises(KeyError):
        flags.flag("supervisor.does_not_exist")


def test_snapshot_returns_all_known_flags():
    snap = flags.snapshot()
    assert "supervisor.enabled" in snap
    assert "supervisor.shadow_mode" in snap
    assert "bootstrap.use_ai_installer" in snap
    # And matches defaults when no file
    assert snap["supervisor.enabled"] is False
    assert snap["supervisor.shadow_mode"] is True
