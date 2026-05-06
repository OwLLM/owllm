"""Tests for CostTracker — pricing lookup, recording, roll-ups, formatting,
and the agent-loop integration that records every model call."""
import sys
import threading
from pathlib import Path

import pytest

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

from core.agents.bus import Bus
from core.agents.cost import (
    CostTracker,
    PRICING_USD_PER_MTOK,
    _lookup_pricing,
    _normalize_model_id,
    get_global_tracker,
    reset_global_tracker,
    wrap_model_fn,
)
from core.agents.message import Goal
from core.agents.orchestrator import build_team
from core.agents.roles import builtin_roles
from core.agents.tools import builtin_registry


# ---------------------------------------------------------------------------
# Pricing lookup
# ---------------------------------------------------------------------------


class TestPricingLookup:
    def test_known_model_resolves(self):
        price = _lookup_pricing("claude-sonnet-4-6")
        assert price is not None
        assert price[0] > 0 and price[1] > 0

    def test_unknown_model_returns_none(self):
        assert _lookup_pricing("local-llama-7b") is None
        assert _lookup_pricing("gemma-3-1b") is None
        assert _lookup_pricing("") is None

    def test_normalize_strips_backend_prefix(self):
        assert _normalize_model_id("claude_cli|claude-sonnet-4-6") == "claude-sonnet-4-6"
        assert _normalize_model_id("Claude-Sonnet-4-6") == "claude-sonnet-4-6"

    def test_prefix_match_for_versioned_variant(self):
        # claude-opus-4-7-1m should match claude-opus-4-7's pricing.
        price = _lookup_pricing("claude-opus-4-7-1m")
        assert price is not None
        assert price == PRICING_USD_PER_MTOK["claude-opus-4-7"]


# ---------------------------------------------------------------------------
# Recording + summary
# ---------------------------------------------------------------------------


class TestRecording:
    def test_record_chars_estimates_cost(self):
        t = CostTracker()
        # 4_000_000 chars / 4 chars-per-token = 1_000_000 input tokens.
        # claude-sonnet-4-6 is $3/MTok input, $15/MTok output.
        # 1_000_000 input + 0 output = $3.00.
        rec = t.record_chars("g1", "coder", "claude-sonnet-4-6", 4_000_000, 0)
        assert rec.input_tokens == 1_000_000
        assert rec.output_tokens == 0
        assert rec.cost_usd == pytest.approx(3.00, abs=0.01)

    def test_unknown_model_costs_zero(self):
        t = CostTracker()
        rec = t.record_chars("g1", "coder", "local-llama", 10_000, 5_000)
        assert rec.cost_usd == 0.0

    def test_record_usage_skips_estimation(self):
        t = CostTracker()
        rec = t.record_usage("g1", "coder", "claude-sonnet-4-6", 1000, 500)
        # 1000/MTok * $3 + 500/MTok * $15 = $0.003 + $0.0075 = $0.0105
        assert rec.cost_usd == pytest.approx(0.0105, abs=1e-6)

    def test_summary_rolls_up_per_agent_and_model(self):
        t = CostTracker()
        t.record_usage("g1", "coder", "claude-sonnet-4-6", 1000, 1000)
        t.record_usage("g1", "researcher", "claude-haiku-4-5", 1000, 1000)
        t.record_usage("g1", "coder", "claude-sonnet-4-6", 1000, 1000)
        # Different goal — should not show in g1's summary.
        t.record_usage("g2", "coder", "claude-sonnet-4-6", 1000, 1000)

        s = t.summary_for_goal("g1")
        assert s.calls == 3
        assert s.total_input_tokens == 3000
        assert s.total_output_tokens == 3000
        assert "coder" in s.by_agent and "researcher" in s.by_agent
        # Coder ran twice, researcher once.
        assert s.by_agent["coder"] > s.by_agent["researcher"]
        assert "claude-sonnet-4-6" in s.by_model
        assert "claude-haiku-4-5" in s.by_model

    def test_summary_for_unknown_goal_is_zero(self):
        s = CostTracker().summary_for_goal("never-recorded")
        assert s.total_usd == 0.0
        assert s.calls == 0

    def test_thread_safety_under_concurrent_writes(self):
        t = CostTracker()

        def worker(i):
            for _ in range(100):
                t.record_usage(f"g{i % 3}", f"a{i}", "claude-sonnet-4-6", 100, 100)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
        for th in threads:
            th.start()
        for th in threads:
            th.join()

        # All 800 records present, no corruption.
        assert len(t.all_records()) == 800

    def test_reset_clears_records(self):
        t = CostTracker()
        t.record_usage("g1", "coder", "gpt-4o", 100, 100)
        assert t.all_records()
        t.reset()
        assert t.all_records() == []


# ---------------------------------------------------------------------------
# format_usd
# ---------------------------------------------------------------------------


class TestFormatUsd:
    @pytest.mark.parametrize("amount,expected", [
        (0.0, "$0.00"),
        (-1.0, "$0.00"),
        (0.001, "<$0.01"),
        (0.034, "$0.034"),
        (0.999, "$0.999"),
        (3.41, "$3.41"),
        (123.4567, "$123.46"),
    ])
    def test_format(self, amount, expected):
        assert CostTracker.format_usd(amount) == expected


# ---------------------------------------------------------------------------
# wrap_model_fn — transparent wrapper that records on every call
# ---------------------------------------------------------------------------


class TestWrapModelFn:
    def test_records_on_each_call(self):
        t = CostTracker()
        current_goal = "g1"
        wrapped = wrap_model_fn(
            lambda messages, mid: "response text",
            t,
            agent="coder",
            goal_id_provider=lambda: current_goal,
        )
        out = wrapped(
            [{"role": "user", "content": "hello world this is a longer message"}],
            "claude-sonnet-4-6",
        )
        assert out == "response text"
        assert len(t.all_records()) == 1
        rec = t.all_records()[0]
        assert rec.agent == "coder"
        assert rec.goal_id == "g1"
        assert rec.input_tokens > 0
        assert rec.output_tokens > 0

    def test_skips_recording_when_goal_id_empty(self):
        t = CostTracker()
        wrapped = wrap_model_fn(
            lambda m, mid: "x",
            t,
            agent="coder",
            goal_id_provider=lambda: "",
        )
        wrapped([{"role": "user", "content": "hi"}], "claude-sonnet-4-6")
        assert t.all_records() == []

    def test_tracker_failure_does_not_break_call(self):
        t = CostTracker()
        # Force a failure by passing a goal_id_provider that raises.
        def bad_provider():
            raise RuntimeError("boom")
        wrapped = wrap_model_fn(
            lambda m, mid: "ok",
            t,
            agent="coder",
            goal_id_provider=bad_provider,
        )
        # The wrapper swallows tracking exceptions.
        out = wrapped([{"role": "user", "content": "hi"}], "claude-sonnet-4-6")
        assert out == "ok"


# ---------------------------------------------------------------------------
# Agent loop integration
# ---------------------------------------------------------------------------


class _ScriptedFn:
    def __init__(self, scripts):
        self._scripts = {k: list(v) for k, v in scripts.items()}

    def __call__(self, messages, model_id):
        # Dispatch by agent name encoded in model_id ("model-orchestrator").
        agent = model_id.split("-", 1)[1]
        if agent in self._scripts and self._scripts[agent]:
            return self._scripts[agent].pop(0)
        return "(out of script — no tool calls)"


class TestAgentLoopIntegration:
    def test_cost_recorded_through_team(self, tmp_path):
        bus = Bus(tmp_path / "agents.db")
        tracker = CostTracker()

        # Orchestrator answers in one shot — no dispatch.
        fake = _ScriptedFn({
            "orchestrator": ["Hello, world."],
        })

        team = build_team(
            bus,
            roles=builtin_roles(),
            model_id_for=lambda n: f"claude-sonnet-4-6" if n == "orchestrator" else f"model-{n}",
            model_fn=fake,
            base_registry=builtin_registry(),
            cost_tracker=tracker,
        )
        reply = team.run_goal("say hi")
        assert reply is not None

        s = tracker.summary_for_goal(reply.goal_id)
        assert s.calls == 1
        assert s.total_usd > 0  # claude-sonnet-4-6 is a paid model
        assert "orchestrator" in s.by_agent
        assert "claude-sonnet-4-6" in s.by_model

    def test_no_tracker_no_records(self, tmp_path):
        bus = Bus(tmp_path / "agents.db")
        fake = _ScriptedFn({"orchestrator": ["done"]})
        team = build_team(
            bus,
            roles=builtin_roles(),
            model_id_for=lambda n: f"claude-sonnet-4-6",
            model_fn=fake,
            base_registry=builtin_registry(),
            # cost_tracker omitted — should be a no-op
        )
        reply = team.run_goal("test")
        assert reply is not None
        # No tracker = no exceptions, no records anywhere visible.


# ---------------------------------------------------------------------------
# Module singleton
# ---------------------------------------------------------------------------


class TestGlobalSingleton:
    def test_same_instance_returned(self):
        reset_global_tracker()
        a = get_global_tracker()
        b = get_global_tracker()
        assert a is b

    def test_reset_clears_singleton(self):
        reset_global_tracker()
        t = get_global_tracker()
        t.record_usage("g", "a", "gpt-4o", 100, 100)
        assert t.all_records()
        reset_global_tracker()
        # New (or wiped) singleton; either way records should be empty.
        assert get_global_tracker().all_records() == []
