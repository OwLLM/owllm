"""Tests for the supervisor Brain.

We never spawn llama-server in tests. All HTTP and subprocess seams are
injected as fakes through the Brain constructor. This is fast, hermetic,
and lets us assert the contract that matters most: the brain NEVER
raises, even when the network/model misbehaves.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

from core.supervisor.brain import (  # noqa: E402
    Brain, Plan, parse_plan_json,
)


# ---------------------------------------------------------------------------
# Plan + parser
# ---------------------------------------------------------------------------


def test_plan_from_dict_minimal():
    p = Plan.from_dict({"action": "install_pkg", "args": {"name": "x"}, "reason": "y"})
    assert p.action == "install_pkg"
    assert p.args == {"name": "x"}
    assert p.reason == "y"
    assert p.fallback is None


def test_plan_from_dict_with_fallback():
    p = Plan.from_dict({
        "action": "install_pkg", "args": {"name": "torch"}, "reason": "deps",
        "fallback": {"action": "abort", "args": {}, "reason": "give up"},
    })
    assert p.fallback is not None
    assert p.fallback.action == "abort"


def test_plan_from_dict_defaults_action_to_abort():
    """Defensive: if the model emitted no action, treat as abort."""
    p = Plan.from_dict({})
    assert p.action == "abort"


def test_plan_from_dict_non_mapping_args_safe():
    p = Plan.from_dict({"action": "x", "args": "not_a_dict"})
    assert p.args == {}


def test_plan_fallback_unavailable_is_ask_user():
    p = Plan.fallback_unavailable("server down")
    assert p.action == "ask_user"
    assert "server down" in p.reason
    assert "options" in p.args


# ---------------------------------------------------------------------------
# parse_plan_json -- tolerant JSON
# ---------------------------------------------------------------------------


def test_parse_plan_json_clean():
    parsed = parse_plan_json('{"action": "install_pkg"}')
    assert parsed is not None
    assert parsed["action"] == "install_pkg"


def test_parse_plan_json_strips_markdown_fence():
    parsed = parse_plan_json('```json\n{"action": "abort"}\n```')
    assert parsed is not None
    assert parsed["action"] == "abort"


def test_parse_plan_json_handles_trailing_prose():
    parsed = parse_plan_json('{"action": "x", "args": {}}\n\nThis is hard to map.')
    assert parsed is not None
    assert parsed["action"] == "x"


def test_parse_plan_json_returns_none_for_garbage():
    assert parse_plan_json("not json") is None


def test_parse_plan_json_handles_empty():
    assert parse_plan_json("") is None
    assert parse_plan_json(None) is None  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Brain HTTP wiring (mocked)
# ---------------------------------------------------------------------------


class _FakeHttp:
    """Records calls; returns whatever the test queues up."""
    def __init__(self):
        self.get_calls: list[tuple[str, int]] = []
        self.post_calls: list[tuple[str, bytes, int]] = []
        self.health_response = (True, b"ok")
        self.completion_response = (True, json.dumps({
            "content": json.dumps({
                "action": "install_pkg",
                "args": {"name": "bitsandbytes", "version": "0.44.1"},
                "reason": "torch ABI bump",
                "fallback": None,
            })
        }).encode())

    def get(self, url: str, timeout_s: int) -> tuple[bool, bytes]:
        self.get_calls.append((url, timeout_s))
        if url.endswith("/health"):
            return self.health_response
        return (False, b"")

    def post(self, url: str, body: bytes, timeout_s: int) -> tuple[bool, bytes]:
        self.post_calls.append((url, body, timeout_s))
        if url.endswith("/completion"):
            return self.completion_response
        if url.endswith("/shutdown"):
            return (True, b"")
        return (False, b"")


class _FakeClock:
    def __init__(self, t: float = 0.0):
        self.t = t

    def __call__(self) -> float:
        return self.t


def _no_spawn_needed_factory(http: _FakeHttp):
    """Spawner that's never expected to be called -- raise if it is."""
    def _spawn(*a, **kw):
        raise AssertionError("spawn should not be called when /health is OK")
    return _spawn


# ---------------------------------------------------------------------------
# health
# ---------------------------------------------------------------------------


def test_health_true_when_endpoint_ok():
    http = _FakeHttp()
    brain = Brain(http_get=http.get, http_post=http.post,
                  spawner=_no_spawn_needed_factory(http), clock=_FakeClock())
    assert brain.health() is True


def test_health_false_when_endpoint_unreachable():
    http = _FakeHttp()
    http.health_response = (False, b"")
    brain = Brain(http_get=http.get, http_post=http.post,
                  spawner=_no_spawn_needed_factory(http), clock=_FakeClock())
    assert brain.health() is False


def test_health_swallows_exceptions():
    """The most important property: no method raises."""
    def boom_get(*a, **kw):
        raise OSError("network fire")
    brain = Brain(http_get=boom_get, http_post=lambda *a, **kw: (True, b""),
                  spawner=lambda *a, **kw: None, clock=_FakeClock())
    assert brain.health() is False


# ---------------------------------------------------------------------------
# diagnose -- happy path
# ---------------------------------------------------------------------------


def test_diagnose_returns_plan_from_completion():
    http = _FakeHttp()
    brain = Brain(http_get=http.get, http_post=http.post,
                  spawner=_no_spawn_needed_factory(http), clock=_FakeClock())
    plan = brain.diagnose({"kind": "runtime_probe_failed",
                           "reason_code": "MODULE_NOT_FOUND"})
    assert plan.action == "install_pkg"
    assert plan.args["name"] == "bitsandbytes"


def test_diagnose_records_request_timestamp():
    http = _FakeHttp()
    clock = _FakeClock(t=42.0)
    brain = Brain(http_get=http.get, http_post=http.post,
                  spawner=_no_spawn_needed_factory(http), clock=clock)
    brain.diagnose({"kind": "x"})
    assert brain._last_request_ts == 42.0


# ---------------------------------------------------------------------------
# diagnose -- failure modes (must always return a Plan, never raise)
# ---------------------------------------------------------------------------


def test_diagnose_returns_fallback_when_server_down():
    http = _FakeHttp()
    http.health_response = (False, b"")
    # Spawner that fails -> ensure_running returns False
    def fail_spawn(*a, **kw):
        raise OSError("can't spawn")
    brain = Brain(http_get=http.get, http_post=http.post,
                  spawner=fail_spawn, clock=_FakeClock())
    plan = brain.diagnose({"kind": "x"})
    assert plan.action == "ask_user"
    assert "unavailable" in plan.reason or "not available" in plan.reason


def test_diagnose_returns_fallback_when_completion_http_fails():
    http = _FakeHttp()
    http.completion_response = (False, b"")
    brain = Brain(http_get=http.get, http_post=http.post,
                  spawner=_no_spawn_needed_factory(http), clock=_FakeClock())
    plan = brain.diagnose({"kind": "x"})
    assert plan.action == "ask_user"


def test_diagnose_returns_fallback_when_response_not_json():
    http = _FakeHttp()
    http.completion_response = (True, b"not json")
    brain = Brain(http_get=http.get, http_post=http.post,
                  spawner=_no_spawn_needed_factory(http), clock=_FakeClock())
    plan = brain.diagnose({"kind": "x"})
    assert plan.action == "ask_user"


def test_diagnose_returns_fallback_when_content_unparseable():
    http = _FakeHttp()
    http.completion_response = (True, json.dumps({"content": "totally not JSON"}).encode())
    brain = Brain(http_get=http.get, http_post=http.post,
                  spawner=_no_spawn_needed_factory(http), clock=_FakeClock())
    plan = brain.diagnose({"kind": "x"})
    assert plan.action == "ask_user"


def test_diagnose_swallows_post_exception():
    http = _FakeHttp()
    def boom_post(*a, **kw):
        raise OSError("conn reset")
    brain = Brain(http_get=http.get, http_post=boom_post,
                  spawner=_no_spawn_needed_factory(http), clock=_FakeClock())
    plan = brain.diagnose({"kind": "x"})
    # Must return a Plan, never raise
    assert isinstance(plan, Plan)
    assert plan.action == "ask_user"


# ---------------------------------------------------------------------------
# shutdown_idle
# ---------------------------------------------------------------------------


def test_shutdown_idle_noop_when_never_used():
    http = _FakeHttp()
    brain = Brain(http_get=http.get, http_post=http.post,
                  spawner=_no_spawn_needed_factory(http), clock=_FakeClock())
    assert brain.shutdown_idle() is False
    assert not any(url.endswith("/shutdown") for url, _, _ in http.post_calls)


def test_shutdown_idle_noop_within_timeout():
    http = _FakeHttp()
    clock = _FakeClock(t=100.0)
    brain = Brain(http_get=http.get, http_post=http.post,
                  spawner=_no_spawn_needed_factory(http), clock=clock,
                  idle_shutdown_s=300)
    brain.diagnose({"kind": "x"})  # last_request_ts -> 100
    clock.t = 200.0  # only 100s elapsed; below 300
    assert brain.shutdown_idle() is False


def test_shutdown_idle_fires_after_timeout():
    http = _FakeHttp()
    clock = _FakeClock(t=100.0)
    brain = Brain(http_get=http.get, http_post=http.post,
                  spawner=_no_spawn_needed_factory(http), clock=clock,
                  idle_shutdown_s=300)
    brain.diagnose({"kind": "x"})  # last_request_ts -> 100
    clock.t = 500.0  # 400s elapsed; over 300
    assert brain.shutdown_idle() is True
    # The shutdown POST happened
    assert any(url.endswith("/shutdown") for url, _, _ in http.post_calls)


def test_shutdown_idle_resets_last_request_ts():
    """After shutting down, we shouldn't fire shutdown again until
    diagnose() is called and elapsed exceeds the threshold."""
    http = _FakeHttp()
    clock = _FakeClock(t=100.0)
    brain = Brain(http_get=http.get, http_post=http.post,
                  spawner=_no_spawn_needed_factory(http), clock=clock,
                  idle_shutdown_s=300)
    brain.diagnose({"kind": "x"})
    clock.t = 500.0
    brain.shutdown_idle()
    # Still in idle window from server's perspective; another call should noop
    assert brain.shutdown_idle() is False
