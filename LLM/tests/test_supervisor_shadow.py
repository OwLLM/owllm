"""Shadow logger contract:

1. With master switch OFF, observe() is a complete no-op (no file created).
2. With shadow_mode OFF (i.e. supervisor in active mode), observe() is also
   a no-op -- shadow's job is purely passive.
3. With master ON + shadow ON, observe() writes one JSONL row per call.
4. observe() never raises -- exceptions inside it must NOT propagate to
   the caller's failure-handling code.
"""
import json
import sys
from pathlib import Path

import pytest

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

from core.supervisor import flags, shadow  # noqa: E402


@pytest.fixture(autouse=True)
def _isolate(tmp_path):
    flags.set_path_for_testing(tmp_path / "feature_flags.json")
    shadow.set_log_path_for_testing(tmp_path / "shadow_log.jsonl")
    yield
    flags.set_path_for_testing(None)
    shadow.set_log_path_for_testing(None)


def _write_flags(tmp_path, **overrides):
    p = tmp_path / "feature_flags.json"
    base = {
        "supervisor.enabled": True,
        "supervisor.shadow_mode": True,
    }
    base.update(overrides)
    p.write_text(json.dumps(base), encoding="utf-8")


# ---------------------------------------------------------------------------
# Off-by-default contract
# ---------------------------------------------------------------------------


def test_observe_noop_when_master_off(tmp_path):
    """Production default: master switch off -- shadow logger writes nothing."""
    shadow.observe("training", {"kind": "gpu_oom"})
    assert not (tmp_path / "shadow_log.jsonl").exists()


def test_observe_noop_when_shadow_off(tmp_path):
    """When supervisor is in active mode, the *shadow* logger steps aside."""
    _write_flags(tmp_path,
                 **{"supervisor.enabled": True, "supervisor.shadow_mode": False})
    shadow.observe("training", {"kind": "gpu_oom"})
    assert not (tmp_path / "shadow_log.jsonl").exists()


# ---------------------------------------------------------------------------
# Active shadow path
# ---------------------------------------------------------------------------


def test_observe_writes_when_master_and_shadow_on(tmp_path):
    _write_flags(tmp_path)
    shadow.observe(
        "training",
        {"kind": "gpu_oom", "vram_gb": 24, "model_size": "7B"},
        rules_decision={"action": "lower_batch_size", "to": 4},
        extra={"run_id": "abc123"},
    )
    log = tmp_path / "shadow_log.jsonl"
    assert log.exists()
    lines = log.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    rec = json.loads(lines[0])
    assert rec["channel"] == "training"
    assert rec["trigger"]["kind"] == "gpu_oom"
    assert rec["rules_decision"]["action"] == "lower_batch_size"
    assert rec["extra"]["run_id"] == "abc123"
    assert rec["supervisor_decision"] is None  # not yet wired
    assert "ts" in rec


def test_multiple_observe_calls_append(tmp_path):
    _write_flags(tmp_path)
    shadow.observe("runtime", {"kind": "runtime_probe_failed", "n": 1})
    shadow.observe("runtime", {"kind": "runtime_probe_failed", "n": 2})
    shadow.observe("runtime", {"kind": "runtime_probe_failed", "n": 3})
    rows = shadow.read_all()
    assert [r["trigger"]["n"] for r in rows] == [1, 2, 3]


def test_unknown_channel_skipped_no_crash(tmp_path):
    _write_flags(tmp_path)
    shadow.observe("not_a_real_channel", {"kind": "x"})
    assert not (tmp_path / "shadow_log.jsonl").exists()


# ---------------------------------------------------------------------------
# Never-raise contract -- the most important property
# ---------------------------------------------------------------------------


def test_observe_swallows_exceptions(tmp_path, monkeypatch):
    """observe() MUST NOT raise. If something blows up internally, we eat it
    so the caller's real failure handler keeps running."""
    _write_flags(tmp_path)

    def boom(*a, **kw):
        raise RuntimeError("disk on fire")
    monkeypatch.setattr(shadow, "_append", boom)

    # Must not raise
    shadow.observe("training", {"kind": "gpu_oom"})


def test_observe_with_unjsonable_payload_does_not_raise(tmp_path):
    """Payload coming from random failure paths might contain weird types.
    observe() should handle it gracefully (either skip or stringify)."""
    _write_flags(tmp_path)
    # set is not JSON-serializable
    shadow.observe("training", {"kind": "x", "weird": {1, 2, 3}})
    # Either nothing was written or something was written -- but no exception.
