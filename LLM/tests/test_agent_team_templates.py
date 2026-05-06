"""Team template loader + materialiser tests."""
import json
import sys
from pathlib import Path

import pytest

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

from core.agents.agent_definitions import (
    _custom_dir,
    delete_custom,
    get_definition,
    list_all_definitions,
)
from core.agents.agent_graph import AgentGraph
from core.agents.projects import ProjectStore
from core.agents.teams import (
    Template,
    builtin_templates,
    instantiate_template,
    load_template,
)
from core.agents.teams.loader import (
    AgentSpec,
    _build_definition,
    _build_graph,
    _template_from_dict,
)


# ---------------------------------------------------------------------------
# Loading + schema
# ---------------------------------------------------------------------------


def test_secretary_template_ships():
    tpls = builtin_templates()
    assert "secretary" in tpls
    sec = tpls["secretary"]
    assert sec.description
    assert {a.name for a in sec.agents} >= {
        "orchestrator", "triager", "responder", "scheduler", "digest",
    }
    # Exactly one dispatcher.
    assert sum(1 for a in sec.agents if a.base == "orchestrator") == 1


def test_template_requires_at_least_one_agent(tmp_path):
    bad = tmp_path / "empty.json"
    bad.write_text(json.dumps({"name": "x", "agents": []}), encoding="utf-8")
    with pytest.raises(ValueError):
        load_template(bad)


def test_template_requires_name(tmp_path):
    bad = tmp_path / "noname.json"
    bad.write_text(json.dumps({"agents": [{"name": "a", "system_prompt": "x" * 60}]}), encoding="utf-8")
    with pytest.raises(ValueError):
        load_template(bad)


def test_template_from_dict_extracts_edges():
    tpl = _template_from_dict(
        {
            "name": "tiny",
            "agents": [
                {"name": "boss", "base": "orchestrator"},
                {"name": "minion", "base": "researcher"},
            ],
            "graph": {"edges": [{"source": "boss", "target": "minion"}]},
        },
        source=Path("synthetic"),
    )
    assert tpl.graph_edges == [("boss", "minion")]


# ---------------------------------------------------------------------------
# Definition building
# ---------------------------------------------------------------------------


def test_build_definition_inherits_from_base():
    from core.agents.roles import builtin_roles
    spec = AgentSpec(name="responder", base="documentation", extra_prompt="Focus: drafts.")
    d = _build_definition("secretary.responder", spec, builtin_roles())
    assert d.name == "secretary.responder"
    # Description carried from base, prompt was extended.
    assert "Documentation" in d.description or d.description  # base description present
    assert "Focus: drafts." in d.system_prompt
    # Documentation base prompt is also still present.
    assert "Documentation" in d.system_prompt
    assert d.built_in is False


def test_build_definition_full_override():
    spec = AgentSpec(name="custom", system_prompt="You are completely custom." * 5)
    d = _build_definition("team.custom", spec, {})
    assert d.system_prompt.startswith("You are completely custom.")
    assert d.tool_allowlist is None  # no base, no override -> all
    assert d.can_dispatch is False


def test_build_definition_requires_base_or_prompt():
    with pytest.raises(ValueError):
        _build_definition("team.broken", AgentSpec(name="broken"), {})


def test_build_definition_propagates_mcp_allowlist():
    from core.agents.roles import builtin_roles
    spec = AgentSpec(
        name="triager",
        base="operator",
        mcp_allowlist=["mcp.email.*", "mcp.whatsapp.*"],
    )
    d = _build_definition("secretary.triager", spec, builtin_roles())
    assert d.mcp_allowlist == ["mcp.email.*", "mcp.whatsapp.*"]


# ---------------------------------------------------------------------------
# Graph building
# ---------------------------------------------------------------------------


def test_build_graph_expands_short_names_to_prefixed():
    tpl = Template(
        name="t",
        agents=[
            AgentSpec(name="boss", base="orchestrator", can_dispatch=True),
            AgentSpec(name="minion", base="researcher"),
        ],
        graph_edges=[("boss", "minion"), ("minion", "boss")],
    )
    team = ["t.boss", "t.minion"]
    g = _build_graph(tpl, team)
    assert {n.name for n in g.nodes} == {"t.boss", "t.minion"}
    assert any(e.source == "t.boss" and e.target == "t.minion" for e in g.edges)


def test_build_graph_skips_unknown_edge_endpoints():
    tpl = Template(
        name="t",
        agents=[AgentSpec(name="boss", base="orchestrator", can_dispatch=True)],
        graph_edges=[("boss", "ghost")],  # ghost isn't in agents
    )
    g = _build_graph(tpl, ["t.boss"])
    assert g.edges == []


# ---------------------------------------------------------------------------
# End-to-end instantiation
# ---------------------------------------------------------------------------


@pytest.fixture
def project_store(tmp_path):
    return ProjectStore(tmp_path / "owllm.db")


@pytest.fixture
def isolated_custom_dir(tmp_path, monkeypatch):
    """Redirect agent-definitions custom dir to a fresh tmp dir per test."""
    target = tmp_path / "agent_definitions"
    target.mkdir()
    monkeypatch.setattr(
        "core.agents.agent_definitions._custom_dir",
        lambda: target,
    )
    # The teams loader imports save_custom from agent_definitions, which
    # uses _custom_dir() at call time — patch is enough.
    yield target


def test_instantiate_secretary_creates_team(project_store, isolated_custom_dir):
    tpls = builtin_templates()
    sec = tpls["secretary"]
    proj = instantiate_template(sec, "Work secretary", project_store=project_store)

    assert proj.name == "Work secretary"
    assert proj.team == [
        "secretary.orchestrator",
        "secretary.triager",
        "secretary.responder",
        "secretary.scheduler",
        "secretary.digest",
    ]
    # Each agent is now a custom AgentDefinition on disk.
    for short in ("orchestrator", "triager", "responder", "scheduler", "digest"):
        assert (isolated_custom_dir / f"secretary.{short}.json").exists()
    # The orchestrator carries the team-specific prompt addition.
    orch = get_definition("secretary.orchestrator")
    assert orch is not None
    assert "triager" in orch.system_prompt
    assert orch.can_dispatch is True
    # Graph survived the round-trip.
    g = AgentGraph.from_json_string(proj.graph_json)
    assert {n.name for n in g.nodes} == set(proj.team)
    assert any(
        e.source == "secretary.orchestrator" and e.target == "secretary.triager"
        for e in g.edges
    )


def test_reinstantiate_does_not_clobber_custom_edits(project_store, isolated_custom_dir):
    tpls = builtin_templates()
    sec = tpls["secretary"]
    instantiate_template(sec, "First", project_store=project_store)

    # Simulate the user editing the responder's prompt in the Studio.
    custom_path = isolated_custom_dir / "secretary.responder.json"
    data = json.loads(custom_path.read_text(encoding="utf-8"))
    data["system_prompt"] = "USER EDITED PROMPT"
    custom_path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    # Re-instantiate the template into a second project.
    instantiate_template(sec, "Second", project_store=project_store)

    # The user's edit must survive.
    after = json.loads(custom_path.read_text(encoding="utf-8"))
    assert after["system_prompt"] == "USER EDITED PROMPT"


def test_instantiate_uses_template_name_when_no_project_name(project_store, isolated_custom_dir):
    tpls = builtin_templates()
    sec = tpls["secretary"]
    proj = instantiate_template(sec, project_store=project_store)
    assert proj.name == "secretary"


# ---------------------------------------------------------------------------
# Sanity coverage for every shipped template
# ---------------------------------------------------------------------------


EXPECTED_TEMPLATES = {
    "secretary",
    "concierge",
    "finance",
    "health_coach",
    "research_lab",
    "writers_room",
    "social_desk",
    "learning_tutor",
    "dev_squad",
    "bug_hunter",
    "code_reviewer",
    "data_analyst",
    "sales_outreach",
    "customer_support",
    "smart_home",
}


def test_all_15_templates_ship():
    tpls = builtin_templates()
    assert set(tpls.keys()) == EXPECTED_TEMPLATES, (
        f"missing: {EXPECTED_TEMPLATES - set(tpls.keys())}, "
        f"extra: {set(tpls.keys()) - EXPECTED_TEMPLATES}"
    )


@pytest.mark.parametrize("template_name", sorted(EXPECTED_TEMPLATES))
def test_each_template_instantiates(template_name, tmp_path, monkeypatch):
    """Every shipped template materialises into a usable Project without error."""
    custom_dir = tmp_path / f"agent_definitions_{template_name}"
    custom_dir.mkdir()
    monkeypatch.setattr(
        "core.agents.agent_definitions._custom_dir", lambda: custom_dir
    )
    store = ProjectStore(tmp_path / f"owllm_{template_name}.db")

    tpl = builtin_templates()[template_name]
    proj = instantiate_template(tpl, project_store=store)

    # Project carries every agent.
    assert len(proj.team) == len(tpl.agents)
    # Each agent definition was written.
    for short in (a.name for a in tpl.agents):
        prefixed = tpl.prefixed_agent_name(short)
        assert get_definition(prefixed) is not None, prefixed
    # Exactly one dispatcher (the orchestrator).
    leaders = [
        get_definition(tpl.prefixed_agent_name(a.name))
        for a in tpl.agents
    ]
    leader_count = sum(1 for d in leaders if d and d.can_dispatch)
    assert leader_count == 1, f"{template_name}: expected 1 leader, got {leader_count}"


@pytest.mark.parametrize("template_name", sorted(EXPECTED_TEMPLATES))
def test_each_template_role_conversion(template_name, tmp_path, monkeypatch):
    """Every template's agents must convert to Role without raising.

    Regression: ``_role_from_definition`` used to do ``list(d.tool_allowlist)
    + list(d.mcp_allowlist or [])`` which crashed with 'NoneType is not
    iterable' whenever ``tool_allowlist=None`` ("all builtins") and the
    user had also set an mcp_allowlist — the exact shape several
    templates produce (e.g. learning_tutor.srs_scheduler inherits "all"
    from the operator base and adds an mcp_allowlist filter)."""
    from desktop_app.pages.agents_page import _role_from_definition

    custom_dir = tmp_path / "agent_definitions"
    custom_dir.mkdir()
    monkeypatch.setattr(
        "core.agents.agent_definitions._custom_dir", lambda: custom_dir
    )
    store = ProjectStore(tmp_path / "owllm.db")
    tpl = builtin_templates()[template_name]
    instantiate_template(tpl, project_store=store)

    for short in (a.name for a in tpl.agents):
        defn = get_definition(tpl.prefixed_agent_name(short))
        assert defn is not None
        # MUST not raise.
        role = _role_from_definition(defn)
        # When tool_allowlist is None on the AgentDefinition, the runtime
        # Role must keep it None (= all tools) so the agent doesn't
        # silently lose every builtin (read_file, dispatch, …) the
        # moment we attach an mcp filter.
        if defn.tool_allowlist is None:
            assert role.tool_allowlist is None, (
                f"{defn.name}: tool_allowlist=None on definition collapsed "
                f"to {role.tool_allowlist!r} on Role — would strip every builtin"
            )
