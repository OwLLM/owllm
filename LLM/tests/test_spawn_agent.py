"""Tests for spawn_agent — ad-hoc sub-agent dispatch.

Covers the factory + the runtime behavior we promise in the docstring:
happy path, unknown-name, depth cap, timeout, isolation of the
read-before-edit guard, and integration with build_team.
"""
import sys
import threading
import time
from pathlib import Path

import pytest

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

from core.agents.agent_definitions import AgentDefinition
from core.agents.bus import Bus
from core.agents.message import MessageKind
from core.agents.orchestrator import build_team
from core.agents.roles import builtin_roles
from core.agents.spawn import (
    DEFAULT_MAX_DEPTH,
    make_spawn_agent_tool,
    set_invocation_context,
    clear_invocation_context,
    _DEPTH,
)
from core.agents.tools import ToolCall, ToolError, builtin_registry


# ---------------------------------------------------------------------------
# Fixtures + helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def bus(tmp_path):
    return Bus(tmp_path / "agents.db")


@pytest.fixture(autouse=True)
def _reset_thread_local():
    """Each test starts with a clean threading.local — depth/context state
    leaks across tests otherwise because the runner thread is reused."""
    yield
    for attr in ("by_goal", "current_agent", "current_goal_id"):
        if hasattr(_DEPTH, attr):
            delattr(_DEPTH, attr)


def _def(name, prompt="You are a helper.", tool_allowlist=("read_file",)):
    return AgentDefinition(
        name=name,
        description=f"test {name}",
        icon="🤖",
        system_prompt=prompt,
        tool_allowlist=list(tool_allowlist) if tool_allowlist is not None else None,
        mcp_allowlist=[],
        default_model_id="",
        can_dispatch=False,
        default_temperature=0.4,
        built_in=False,
    )


class _ScriptedModel:
    """One model_fn that dispatches by agent prefix in the model_id.

    spawn_agent constructs sub-agent names like ``researcher#abcd12``
    so tests key off the prefix-before-#."""

    def __init__(self, scripts):
        self._scripts = {k: list(v) for k, v in scripts.items()}
        self.calls = []

    def __call__(self, messages, model_id):
        # Sub-agents inherit definition.default_model_id, which is ""
        # in our test definitions. We tag turns by the system-prompt
        # content instead.
        sys_msg = next((m for m in messages if m.get("role") == "system"), None)
        sys_text = (sys_msg or {}).get("content", "")
        for key, queue in self._scripts.items():
            if key in sys_text and queue:
                self.calls.append((key, list(messages)))
                return queue.pop(0)
        raise AssertionError(
            f"out-of-script: no remaining responses match. "
            f"sys prompt starts: {sys_text[:80]!r}"
        )


# ---------------------------------------------------------------------------
# Factory + tool definition
# ---------------------------------------------------------------------------


class TestFactory:
    def test_returns_tool_named_spawn_agent(self, bus):
        tool = make_spawn_agent_tool(
            model_fn=lambda *_args, **_kw: "ok",
            base_registry=builtin_registry(),
            bus=bus,
            definition_resolver=lambda name: None,
            available_names_resolver=lambda: [],
        )
        assert tool.name == "spawn_agent"
        assert not tool.requires_approval

    def test_required_args_validated(self, bus):
        tool = make_spawn_agent_tool(
            model_fn=lambda *_a, **_kw: "ok",
            base_registry=builtin_registry(),
            bus=bus,
            definition_resolver=lambda name: None,
            available_names_resolver=lambda: [],
        )
        # Tool.invoke raises ToolError on missing required.
        with pytest.raises(ToolError):
            tool.invoke({})


# ---------------------------------------------------------------------------
# Happy path — sub-agent runs and returns a reply
# ---------------------------------------------------------------------------


class TestHappyPath:
    def test_sub_agent_returns_reply_to_caller(self, bus):
        sub_def = _def("researcher", prompt="You are the Researcher.")

        # Sub-agent emits no tool calls, just a final answer.
        scripted = _ScriptedModel({
            "Researcher": ["The answer is 42."],
        })

        registry = builtin_registry()
        tool = make_spawn_agent_tool(
            model_fn=scripted,
            base_registry=registry,
            bus=bus,
            definition_resolver=lambda n: sub_def if n == "researcher" else None,
            available_names_resolver=lambda: ["researcher"],
        )
        registry.register(tool)

        # Set up a bus goal so the sub-agent's handle() can budget-check.
        from core.agents.message import Goal
        goal = bus.create_goal(Goal(user_request="t"))
        set_invocation_context(agent="parent", goal_id=goal.id)
        try:
            r = registry.invoke(
                ToolCall(name="spawn_agent", args={
                    "agent": "researcher", "prompt": "what's the answer?",
                }),
                agent="parent", goal_id=goal.id,
            )
        finally:
            clear_invocation_context()

        assert r.ok, r.output
        assert "42" in r.output

        # Verify the spawned agent's REQUEST + REPLY landed on the bus.
        msgs = bus.replay(goal_id=goal.id)
        kinds = [(m.from_agent, m.kind.value) for m in msgs]
        # parent published a REQUEST to a researcher#XXXX, and that
        # spawned agent published a REPLY back.
        request_to_sub = [m for m in msgs if m.kind == MessageKind.REQUEST and m.from_agent == "parent"]
        assert request_to_sub
        assert request_to_sub[0].to_agent.startswith("researcher#")
        assert request_to_sub[0].meta.get("spawn") is True


# ---------------------------------------------------------------------------
# Unknown agent
# ---------------------------------------------------------------------------


class TestUnknownAgent:
    def test_lists_available_agents_in_error(self, bus):
        registry = builtin_registry()
        tool = make_spawn_agent_tool(
            model_fn=lambda *_a, **_kw: "x",
            base_registry=registry,
            bus=bus,
            definition_resolver=lambda n: None,
            available_names_resolver=lambda: ["alpha", "beta"],
        )
        registry.register(tool)

        from core.agents.message import Goal
        goal = bus.create_goal(Goal(user_request="t"))
        set_invocation_context(agent="parent", goal_id=goal.id)
        try:
            r = registry.invoke(
                ToolCall(name="spawn_agent", args={
                    "agent": "zorblax", "prompt": "do thing",
                }),
                agent="parent", goal_id=goal.id,
            )
        finally:
            clear_invocation_context()
        assert not r.ok
        assert "zorblax" in r.output
        assert "alpha" in r.output and "beta" in r.output

    def test_no_goal_context_refuses(self, bus):
        registry = builtin_registry()
        tool = make_spawn_agent_tool(
            model_fn=lambda *_a, **_kw: "x",
            base_registry=registry,
            bus=bus,
            definition_resolver=lambda n: _def("x"),
            available_names_resolver=lambda: ["x"],
        )
        # Calling the tool function directly with no thread-local context.
        clear_invocation_context()
        with pytest.raises(ToolError) as exc:
            tool.invoke({"agent": "x", "prompt": "do thing"})
        assert "goal_id" in str(exc.value)


# ---------------------------------------------------------------------------
# Depth cap
# ---------------------------------------------------------------------------


class TestDepthCap:
    def test_cap_blocks_at_max_depth(self, bus):
        sub_def = _def("recurse", prompt="You are Recurse.")
        scripted = _ScriptedModel({"Recurse": ["never reached"]})

        registry = builtin_registry()
        tool = make_spawn_agent_tool(
            model_fn=scripted,
            base_registry=registry,
            bus=bus,
            max_depth=2,
            definition_resolver=lambda n: sub_def if n == "recurse" else None,
            available_names_resolver=lambda: ["recurse"],
        )
        registry.register(tool)

        from core.agents.message import Goal
        goal = bus.create_goal(Goal(user_request="t"))

        # Pretend we're already at depth 2 by manually pushing.
        from core.agents.spawn import _push_depth
        _push_depth(goal.id)
        _push_depth(goal.id)

        set_invocation_context(agent="deep_agent", goal_id=goal.id)
        try:
            r = registry.invoke(
                ToolCall(name="spawn_agent", args={
                    "agent": "recurse", "prompt": "spawn me",
                }),
                agent="deep_agent", goal_id=goal.id,
            )
        finally:
            clear_invocation_context()

        assert not r.ok
        assert "depth" in r.output.lower()


# ---------------------------------------------------------------------------
# Timeout
# ---------------------------------------------------------------------------


class TestTimeout:
    def test_long_running_sub_agent_times_out(self, bus):
        sub_def = _def("slow", prompt="You are Slow.")

        # model_fn that sleeps longer than the timeout. Returns a no-tool-
        # calls reply when it eventually finishes.
        def slow_model(messages, model_id):
            time.sleep(2.0)
            return "done"

        registry = builtin_registry()
        tool = make_spawn_agent_tool(
            model_fn=slow_model,
            base_registry=registry,
            bus=bus,
            definition_resolver=lambda n: sub_def if n == "slow" else None,
            available_names_resolver=lambda: ["slow"],
        )
        registry.register(tool)

        from core.agents.message import Goal
        goal = bus.create_goal(Goal(user_request="t"))
        set_invocation_context(agent="parent", goal_id=goal.id)
        try:
            r = registry.invoke(
                ToolCall(name="spawn_agent", args={
                    "agent": "slow", "prompt": "go", "timeout_seconds": 1,
                }),
                agent="parent", goal_id=goal.id,
            )
        finally:
            clear_invocation_context()
        # Tool succeeded (returned a string). The string reports the timeout.
        assert r.ok
        assert "did not finish" in r.output


# ---------------------------------------------------------------------------
# Isolation of the read-before-edit guard
# ---------------------------------------------------------------------------


class TestReadStateIsolation:
    def test_parent_reads_do_not_satisfy_sub_agent_edit(self, bus, tmp_path):
        """Parent reads file F. Spawned sub-agent tries to edit F without
        reading it itself. The registry's read-tracking is namespaced by
        (agent_name, goal_id), so the spawned agent should be refused —
        the parent's read does not count for the sub-agent."""
        f = tmp_path / "x.txt"
        f.write_text("hello", encoding="utf-8")

        registry = builtin_registry()
        # Sub-agent has read_file + edit_file.
        sub_def = _def("editor", prompt="You are Editor.",
                       tool_allowlist=("read_file", "edit_file"))

        # Sub-agent's first response: try to edit_file directly (no read_file).
        # Second response: a final reply after the failure.
        scripted = _ScriptedModel({
            "Editor": [
                f'<tool_call name="edit_file">'
                f'<arg name="path">{f}</arg>'
                f'<arg name="old_string">hello</arg>'
                f'<arg name="new_string">HI</arg>'
                f'</tool_call>',
                "Sorry, I should have read the file first.",
            ],
        })

        tool = make_spawn_agent_tool(
            model_fn=scripted,
            base_registry=registry,
            bus=bus,
            definition_resolver=lambda n: sub_def if n == "editor" else None,
            available_names_resolver=lambda: ["editor"],
        )
        registry.register(tool)

        from core.agents.message import Goal
        goal = bus.create_goal(Goal(user_request="t"))

        # PARENT reads the file — should NOT carry over to sub-agent.
        registry.invoke(
            ToolCall(name="read_file", args={"path": str(f)}),
            agent="parent", goal_id=goal.id,
        )

        set_invocation_context(agent="parent", goal_id=goal.id)
        try:
            r = registry.invoke(
                ToolCall(name="spawn_agent", args={
                    "agent": "editor", "prompt": f"replace 'hello' with 'HI' in {f}",
                }),
                agent="parent", goal_id=goal.id,
            )
        finally:
            clear_invocation_context()

        assert r.ok, r.output
        # File untouched — the spawned editor's edit_file was refused
        # because that agent (its unique name `editor#XXXX`) hasn't
        # read the path itself.
        assert f.read_text(encoding="utf-8") == "hello"
        # And the sub-agent's reply mentions the failure.
        assert "should have read" in r.output


# ---------------------------------------------------------------------------
# build_team integration — every agent gets spawn_agent
# ---------------------------------------------------------------------------


class TestBuildTeamIntegration:
    def test_spawn_agent_registered_after_build_team(self, bus):
        from core.agents.tools import ToolCall as _TC  # noqa: F401
        registry = builtin_registry()
        team = build_team(
            bus,
            roles=builtin_roles(),
            model_id_for=lambda n: f"model-{n}",
            model_fn=lambda messages, mid: "ok",
            base_registry=registry,
        )
        # spawn_agent is in the registry now.
        assert "spawn_agent" in registry.names()
        # Orchestrator's tool view includes spawn_agent.
        assert "spawn_agent" in team.orchestrator.tools.names()
        # Each specialist's tool view also includes spawn_agent.
        for runner in team.specialists.values():
            assert "spawn_agent" in runner.agent.tools.names(), \
                f"{runner.agent.name} missing spawn_agent"

    def test_idempotent_when_called_twice_on_same_registry(self, bus):
        registry = builtin_registry()
        build_team(
            bus,
            roles=builtin_roles(),
            model_id_for=lambda n: f"model-{n}",
            model_fn=lambda m, i: "ok",
            base_registry=registry,
        )
        # Second build_team on same registry shouldn't raise on duplicate
        # spawn_agent registration.
        build_team(
            bus,
            roles=builtin_roles(),
            model_id_for=lambda n: f"model-{n}",
            model_fn=lambda m, i: "ok",
            base_registry=registry,
        )
        # Still present, exactly once.
        assert registry.names().count("spawn_agent") == 1
