"""End-to-end Team test — orchestrator dispatches a researcher and integrates."""
import sys
import threading
from pathlib import Path

import pytest

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

from core.agents.bus import Bus
from core.agents.orchestrator import build_team
from core.agents.roles import builtin_roles
from core.agents.tools import builtin_registry


class ScriptedTeamModel:
    """Per-agent scripted model.

    Each agent name maps to a list of responses, popped in order. Lets us
    drive a multi-agent flow deterministically: orchestrator says
    "dispatch", researcher says "the answer is X", orchestrator integrates.
    """

    def __init__(self, scripts):
        self._scripts = {k: list(v) for k, v in scripts.items()}
        self.calls = []

    def __call__(self, messages, model_id):
        # The model_id we built encodes the agent name as "model-<name>".
        agent = model_id.split("-", 1)[1]
        self.calls.append((agent, list(messages)))
        if agent not in self._scripts or not self._scripts[agent]:
            raise AssertionError(f"out-of-script call for {agent}")
        return self._scripts[agent].pop(0)


def _model_id(name: str) -> str:
    return f"model-{name}"


@pytest.fixture
def bus(tmp_path):
    return Bus(tmp_path / "agents.db")


# ---------------------------------------------------------------------------
# Orchestrator dispatch flow
# ---------------------------------------------------------------------------


def test_orchestrator_dispatches_to_researcher(bus, tmp_path):
    fact = tmp_path / "fact.txt"
    fact.write_text("the meaning of life is 42", encoding="utf-8")

    fake = ScriptedTeamModel(
        {
            "orchestrator": [
                # Plan + dispatch one subtask.
                f'Plan: ask researcher to read {fact}.\n'
                f'<tool_call name="dispatch">'
                f'<arg name="agent">researcher</arg>'
                f'<arg name="task">Read {fact} and tell me what it says.</arg>'
                f'</tool_call>',
                # Receive the reply, integrate, final answer.
                'The file says the meaning of life is 42.',
            ],
            "researcher": [
                f'<tool_call name="read_file">'
                f'<arg name="path">{fact}</arg>'
                f'</tool_call>',
                'The file says: the meaning of life is 42.',
            ],
            "coder": [],
            "operator": [],
            "critic": [],
        }
    )

    team = build_team(
        bus,
        roles=builtin_roles(),
        model_id_for=_model_id,
        model_fn=fake,
        base_registry=builtin_registry(),
    )

    reply = team.run_goal("what does the fact file say?")
    assert reply is not None
    assert "42" in reply.body

    # Verify the researcher was actually invoked via the bus, not just
    # the model script.
    msgs = bus.replay(goal_id=reply.goal_id)
    senders = {m.from_agent for m in msgs}
    assert "orchestrator" in senders
    assert "researcher" in senders
    # And the researcher really called read_file.
    tool_calls = [m for m in msgs if m.from_agent == "researcher" and m.kind.value == "tool_call"]
    assert any(m.meta.get("tool") == "read_file" for m in tool_calls)


# ---------------------------------------------------------------------------
# Dispatch error paths
# ---------------------------------------------------------------------------


def test_dispatch_to_unknown_agent_returns_error(bus):
    fake = ScriptedTeamModel(
        {
            "orchestrator": [
                '<tool_call name="dispatch">'
                '<arg name="agent">ghost</arg>'
                '<arg name="task">do a thing</arg>'
                '</tool_call>',
                'I tried to dispatch to ghost but it does not exist.',
            ],
            "researcher": [],
            "coder": [],
            "operator": [],
            "critic": [],
        }
    )
    team = build_team(
        bus,
        roles=builtin_roles(),
        model_id_for=_model_id,
        model_fn=fake,
        base_registry=builtin_registry(),
    )

    reply = team.run_goal("dispatch to a bogus agent")
    assert "ghost" in reply.body or "does not exist" in reply.body
    # The orchestrator's view of the failed tool result should mention
    # 'unknown agent'.
    msgs = bus.replay(goal_id=reply.goal_id)
    results = [m for m in msgs if m.kind.value == "tool_result"]
    assert any("unknown agent" in r.body for r in results)


def test_dispatch_resolves_short_alias_for_prefixed_specialist(bus, tmp_path):
    """Templates materialise specialists as ``<team>.<short>`` names. The
    orchestrator's prompt carries multiple overlapping team lists, so
    models often call ``dispatch(agent="researcher")`` when the actual
    registered name is ``research_lab.researcher``. A unique suffix
    match must resolve so the specialist is actually invoked (and on
    the live UI, lights up green) instead of failing with 'unknown
    agent' and silently leaving the canvas idle.
    """
    fact = tmp_path / "fact.txt"
    fact.write_text("answer: forty-two", encoding="utf-8")

    fake = ScriptedTeamModel(
        {
            "orchestrator": [
                # Dispatch to the SHORT alias even though the registered
                # specialist is the prefixed name.
                f'<tool_call name="dispatch">'
                f'<arg name="agent">researcher</arg>'
                f'<arg name="task">read {fact}</arg>'
                f'</tool_call>',
                'forty-two it is.',
            ],
            "research_lab.researcher": [
                f'<tool_call name="read_file">'
                f'<arg name="path">{fact}</arg>'
                f'</tool_call>',
                'answer: forty-two.',
            ],
        }
    )

    full = builtin_roles()
    # Same Role object, just renamed to the prefixed form.
    from dataclasses import replace
    pref_researcher = replace(full["researcher"], name="research_lab.researcher")
    roles = {
        "orchestrator": full["orchestrator"],
        "research_lab.researcher": pref_researcher,
    }
    # The scripted model keys off ``model_id`` which encodes the role
    # name — make sure the alias resolution doesn't lose the link.

    def model_id(name):
        return f"model-{name}"

    team = build_team(
        bus,
        roles=roles,
        model_id_for=model_id,
        model_fn=fake,
        base_registry=builtin_registry(),
    )
    reply = team.run_goal("what's in the fact file?")
    assert reply is not None
    msgs = bus.replay(goal_id=reply.goal_id)
    senders = {m.from_agent for m in msgs}
    # The PREFIXED specialist must have been invoked — proves the alias
    # resolved rather than the dispatch erroring out.
    assert "research_lab.researcher" in senders, (
        f"expected research_lab.researcher to fire; senders were {senders}"
    )


def test_dispatch_short_alias_ambiguity_errors(bus):
    """Two specialists that both end with the same short name must NOT
    silently route to one of them — the model has to disambiguate."""
    fake = ScriptedTeamModel(
        {
            "orchestrator": [
                '<tool_call name="dispatch">'
                '<arg name="agent">critic</arg>'
                '<arg name="task">review</arg>'
                '</tool_call>',
                'I needed to be more specific.',
            ],
            "team_a.critic": [],
            "team_b.critic": [],
        }
    )
    full = builtin_roles()
    from dataclasses import replace
    roles = {
        "orchestrator": full["orchestrator"],
        "team_a.critic": replace(full["critic"], name="team_a.critic"),
        "team_b.critic": replace(full["critic"], name="team_b.critic"),
    }
    team = build_team(
        bus,
        roles=roles,
        model_id_for=_model_id,
        model_fn=fake,
        base_registry=builtin_registry(),
    )
    reply = team.run_goal("review")
    assert reply is not None
    msgs = bus.replay(goal_id=reply.goal_id)
    results = [m for m in msgs if m.kind.value == "tool_result"]
    assert any("ambiguous" in (r.body or "").lower() for r in results)


def test_orchestrator_prompt_lists_only_active_team(bus):
    """Custom team without all built-ins → orchestrator's prompt only
    references the specialists that actually exist."""
    fake = ScriptedTeamModel(
        {
            "orchestrator": ["I'll handle this."],
            "researcher": [],
            "coder": [],
            "operator": [],
            "critic": [],
        }
    )
    # Build a team with only orchestrator + coder (no researcher/operator/critic).
    full = builtin_roles()
    pruned = {"orchestrator": full["orchestrator"], "coder": full["coder"]}
    team = build_team(
        bus,
        roles=pruned,
        model_id_for=_model_id,
        model_fn=fake,
        base_registry=builtin_registry(),
    )
    prompt = team.orchestrator.role_prompt
    # The injected roster must mention coder.
    assert "ACTUAL TEAM" in prompt
    assert "coder" in prompt
    # And must NOT introduce researcher/operator/critic as if they exist.
    # (The base YAML mentions them; the injected block overrides that by
    # listing only what's actually on the team.)
    roster_block = prompt.split("ACTUAL TEAM", 1)[1]
    assert "researcher" not in roster_block
    assert "operator" not in roster_block
    assert "critic" not in roster_block


def test_orchestrator_prompt_with_no_team(bus):
    """Solo orchestrator → prompt tells it not to dispatch at all."""
    fake = ScriptedTeamModel({"orchestrator": ["alone"]})
    full = builtin_roles()
    team = build_team(
        bus,
        roles={"orchestrator": full["orchestrator"]},
        model_id_for=_model_id,
        model_fn=fake,
        base_registry=builtin_registry(),
    )
    prompt = team.orchestrator.role_prompt
    assert "NO specialists" in prompt or "no specialists" in prompt.lower()


def test_dispatch_cannot_target_orchestrator(bus):
    fake = ScriptedTeamModel(
        {
            "orchestrator": [
                '<tool_call name="dispatch">'
                '<arg name="agent">orchestrator</arg>'
                '<arg name="task">recursive</arg>'
                '</tool_call>',
                'Cannot recurse.',
            ],
            "researcher": [],
            "coder": [],
            "operator": [],
            "critic": [],
        }
    )
    team = build_team(
        bus,
        roles=builtin_roles(),
        model_id_for=_model_id,
        model_fn=fake,
        base_registry=builtin_registry(),
    )
    reply = team.run_goal("try to recurse")
    msgs = bus.replay(goal_id=reply.goal_id)
    results = [m for m in msgs if m.kind.value == "tool_result"]
    assert any("cannot target the orchestrator" in r.body for r in results)
