"""Tests for the conversation-compaction layer in Agent._build_messages.

Compaction triggers when chat history exceeds ``compaction_threshold *
max_history_chars`` AND there are enough messages to make summarization
worthwhile. The older middle is folded into a synthetic SUMMARY message
via the agent's own model_fn; the original user ask + the most recent
``preserve_recent`` messages stay verbatim.

Tests use small budgets (~3KB) so we can synthesize "long" histories
in a few hundred chars instead of 60K.
"""
import sys
from pathlib import Path

import pytest

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

from core.agents.agent import Agent, _COMPACTION_MARKER
from core.agents.bus import Bus
from core.agents.message import Goal, Message, MessageKind
from core.agents.tools import builtin_registry


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def bus(tmp_path):
    return Bus(tmp_path / "agents.db")


def _make_agent(bus, model_fn, *, max_history_chars=3000, threshold=0.75, preserve=3):
    """Construct an Agent with tight budgets so tests don't need 60KB of text."""
    return Agent(
        name="t",
        role_prompt="You are a tester.",
        model_id="model-x",
        bus=bus,
        tools=builtin_registry(),
        model_fn=model_fn,
        max_history_chars=max_history_chars,
        compaction_threshold=threshold,
        preserve_recent=preserve,
        max_message_chars=2000,
    )


def _seed_history(agent, *, n_user=10, n_assistant=10, body_size=200):
    """Pre-populate _chat_history with alternating user/assistant messages."""
    body = "x" * body_size
    msgs = []
    for i in range(max(n_user, n_assistant)):
        if i < n_user:
            msgs.append({"role": "user", "content": f"user msg {i}: {body}"})
        if i < n_assistant:
            msgs.append({"role": "assistant", "content": f"assistant msg {i}: {body}"})
    agent._chat_history = msgs


# ---------------------------------------------------------------------------
# Trigger threshold
# ---------------------------------------------------------------------------


class TestTrigger:
    def test_below_threshold_no_compaction(self, bus):
        called = {"count": 0}
        def fake_model(messages, mid):
            called["count"] += 1
            return "summary"
        agent = _make_agent(bus, fake_model, max_history_chars=10_000)
        # ~5 short messages, nowhere near threshold.
        agent._chat_history = [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello"},
            {"role": "user", "content": "ok"},
        ]
        agent._build_messages()
        assert called["count"] == 0  # model_fn never called for compaction

    def test_above_threshold_triggers_compaction(self, bus):
        compacted = {"called": False}
        def fake_model(messages, mid):
            compacted["called"] = True
            # Verify the summarization prompt structure.
            assert messages[0]["role"] == "system"
            assert "summary" in messages[0]["content"].lower()
            return "compressed summary text"
        agent = _make_agent(bus, fake_model, max_history_chars=2000, threshold=0.5)
        _seed_history(agent, n_user=10, n_assistant=10, body_size=80)
        agent._build_messages()
        assert compacted["called"]

    def test_disabled_when_threshold_is_one(self, bus):
        called = {"count": 0}
        def fake_model(messages, mid):
            called["count"] += 1
            return "x"
        agent = _make_agent(bus, fake_model, max_history_chars=2000, threshold=1.0)
        _seed_history(agent, n_user=20, n_assistant=20, body_size=100)
        agent._build_messages()
        assert called["count"] == 0  # threshold 1.0 disables compaction

    def test_too_few_messages_does_not_compact(self, bus):
        called = {"count": 0}
        def fake_model(messages, mid):
            called["count"] += 1
            return "x"
        agent = _make_agent(bus, fake_model, max_history_chars=200, threshold=0.5, preserve=5)
        # Only 4 messages — fewer than preserve_recent + 2, so compaction skips.
        agent._chat_history = [
            {"role": "user", "content": "x" * 200},
            {"role": "assistant", "content": "y" * 200},
            {"role": "user", "content": "z" * 200},
            {"role": "assistant", "content": "w" * 200},
        ]
        agent._build_messages()
        assert called["count"] == 0


# ---------------------------------------------------------------------------
# Output shape
# ---------------------------------------------------------------------------


class TestCompactedShape:
    def _agent_with_summary(self, bus, summary_text="SUMMARY HERE"):
        def fake_model(messages, mid):
            return summary_text
        a = _make_agent(bus, fake_model, max_history_chars=2000, threshold=0.5, preserve=3)
        _seed_history(a, n_user=10, n_assistant=10, body_size=80)
        return a

    def test_preserves_original_user_ask(self, bus):
        agent = self._agent_with_summary(bus)
        original_first = agent._chat_history[0]
        agent._build_messages()
        # Original user ask is still position 1 in _chat_history (after
        # compaction; position 0 in capped because system prompt is
        # rendered separately).
        assert agent._chat_history[0] == original_first

    def test_summary_marker_present(self, bus):
        agent = self._agent_with_summary(bus, "compressed summary text")
        agent._build_messages()
        # Find the summary message in the (now-rewritten) chat history.
        markers = [
            m for m in agent._chat_history
            if _COMPACTION_MARKER in (m.get("content") or "")
        ]
        assert len(markers) == 1
        assert "compressed summary text" in markers[0]["content"]

    def test_recent_messages_kept_verbatim(self, bus):
        agent = self._agent_with_summary(bus)
        # Mark the last 3 messages with unique markers.
        for i, marker in enumerate(("ZA", "ZB", "ZC")):
            agent._chat_history[-3 + i] = {"role": "user", "content": marker * 50}
        agent._build_messages()
        tail_contents = [m["content"] for m in agent._chat_history[-3:]]
        assert any("ZA" in c for c in tail_contents)
        assert any("ZB" in c for c in tail_contents)
        assert any("ZC" in c for c in tail_contents)

    def test_compaction_persists_so_no_re_summarize(self, bus):
        calls = {"n": 0}
        def fake_model(messages, mid):
            calls["n"] += 1
            return "summary " + str(calls["n"])
        agent = _make_agent(bus, fake_model, max_history_chars=2000, threshold=0.5, preserve=3)
        _seed_history(agent, n_user=10, n_assistant=10, body_size=80)
        # First _build_messages triggers compaction.
        agent._build_messages()
        first_call_count = calls["n"]
        assert first_call_count == 1
        # Second call: history is now small enough that we shouldn't
        # re-compact (or at most once).
        agent._build_messages()
        # No additional summarization call — total still 1.
        assert calls["n"] == first_call_count


# ---------------------------------------------------------------------------
# Robustness: model_fn failure during compaction
# ---------------------------------------------------------------------------


class TestRobustness:
    def test_summary_failure_falls_back_to_drop_oldest(self, bus):
        def boom(messages, mid):
            raise RuntimeError("model down")
        agent = _make_agent(bus, boom, max_history_chars=1000, threshold=0.5, preserve=3)
        _seed_history(agent, n_user=10, n_assistant=10, body_size=100)
        # Should NOT raise — falls through to drop-oldest fallback.
        out = agent._build_messages()
        # System prompt + at least one message survives.
        assert out[0]["role"] == "system"
        assert len(out) >= 2
        # Total stays under budget.
        body_chars = sum(len(m.get("content") or "") for m in out[1:])
        assert body_chars <= 1000

    def test_empty_summary_text_handled(self, bus):
        def empty_summary(messages, mid):
            return ""
        agent = _make_agent(bus, empty_summary, max_history_chars=2000, threshold=0.5, preserve=3)
        _seed_history(agent, n_user=10, n_assistant=10, body_size=80)
        agent._build_messages()
        # Summary message exists with the "(empty summary)" placeholder.
        summary_msg = next(
            (m for m in agent._chat_history if _COMPACTION_MARKER in (m.get("content") or "")),
            None,
        )
        assert summary_msg is not None
        assert "(empty summary)" in summary_msg["content"]

    def test_compaction_keeps_history_under_budget(self, bus):
        def fake_model(messages, mid):
            return "compressed"
        # Budget needs to leave room for the system prompt (~8KB once
        # all builtins are formatted into it). Use 12KB so compaction
        # has a real budget to fit into.
        agent = _make_agent(bus, fake_model, max_history_chars=12_000, threshold=0.5, preserve=3)
        _seed_history(agent, n_user=15, n_assistant=15, body_size=200)
        out = agent._build_messages()
        body_chars = sum(len(m.get("content") or "") for m in out[1:])
        sys_chars = len(out[0]["content"])
        # After compaction + drop-oldest, body should fit in the
        # remaining budget. The summary itself can be up to ~800 words,
        # so add headroom for the marker / preamble.
        slack = 200
        assert body_chars <= max(0, agent.max_history_chars - sys_chars) + slack
