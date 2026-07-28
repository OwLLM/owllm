"""Team template loader + materialiser.

A template describes a *kind of project* (Secretary, Bug-hunter, Solo dev
squad, …) as a list of agents + a routing graph. Loading a template gives
you a :class:`Template` dataclass; materialising one stamps out concrete
:class:`AgentDefinition` rows and a :class:`Project` row that the rest of
OWLLM treats as if the user had built it by hand.

Schema (JSON):

    {
      "name":        "secretary",
      "description": "...",
      "icon":        "owl:owl_orchestrator1",
      "required_mcp": ["mcp.email", "mcp.calendar"],   // hint, not enforced
      "agents": [
        {
          "name":              "orchestrator",
          "base":              "orchestrator",         // built-in role name
          "description":       "...",                  // overrides base
          "icon":              "owl:owl_orchestrator1",
          "system_prompt":     "...",                  // full override
          "extra_prompt":      "...",                  // appended to base prompt
          "tool_allowlist":    ["dispatch", ...],      // null = inherit
          "mcp_allowlist":     ["mcp.email.*"],        // null = all, [] = none
          "default_model_id":  "",
          "can_dispatch":      true,                   // null = inherit
          "default_temperature": 0.3                   // null = inherit
        }, ...
      ],
      "graph": { "edges": [{"source": "...", "target": "..."}, ...] }
    }

Materialisation rules:

  * Agent names get prefixed with the template name when written to disk
    (``secretary.orchestrator``) so two instances of the same template
    don't fight over one definition row. Inside a template's ``graph``
    edges, agents are referenced by their *short* name; the loader
    expands those to the prefixed names.
  * If an agent name already exists as a custom definition (e.g. the user
    instantiated this template before), it is **left alone** — we don't
    clobber edits. New names are written; existing ones are reused.
  * Built-in role names referenced via ``base`` are resolved through
    :func:`core.agents.roles.builtin_roles`. If ``base`` is omitted the
    spec must carry a full ``system_prompt``.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from core.agents.agent_definitions import (
    AgentDefinition,
    get_definition,
    save_custom,
)
from core.agents.agent_graph import AgentGraph, GraphEdge
from core.agents.projects import Project, get_project_store
from core.agents.roles import builtin_roles

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


@dataclass
class AgentSpec:
    """One agent inside a template."""

    name: str
    base: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    system_prompt: Optional[str] = None
    extra_prompt: Optional[str] = None
    tool_allowlist: Optional[List[str]] = None
    mcp_allowlist: Optional[List[str]] = None
    default_model_id: Optional[str] = None
    can_dispatch: Optional[bool] = None
    default_temperature: Optional[float] = None


DEFAULT_CATEGORY = "Other"
"""Section label used when a template ships without ``category``. Kept
as a constant so the Studio's Teams view always has *somewhere* to put
unknown / custom templates instead of silently dropping them."""


@dataclass
class Template:
    """One team template."""

    name: str
    """Stable internal id — kebab/snake case, used as the agent-name
    prefix (``secretary.responder``) and as the on-disk filename."""
    display_name: str = ""
    """Title-cased label shown on team cards. Falls back to the
    title-cased :attr:`name` when blank."""
    category: str = DEFAULT_CATEGORY
    """Section the team belongs to in the Studio's Teams view (e.g.
    'Personal', 'Knowledge', 'Software', 'Ops'). Free-form so a future
    template can introduce a new section without a schema migration."""
    description: str = ""
    icon: str = "🤖"
    required_mcp: List[str] = field(default_factory=list)
    agents: List[AgentSpec] = field(default_factory=list)
    graph_edges: List[Tuple[str, str]] = field(default_factory=list)
    """Edges as ``(source_short_name, target_short_name)``. The materialiser
    expands these to prefixed names."""
    built_in: bool = True
    """``False`` for user-built custom templates loaded from
    :func:`_user_templates_dir`. The Studio uses this to mark cards
    'BUILT-IN' vs 'CUSTOM' and to gate edit / delete affordances."""

    def prefixed_agent_name(self, short: str) -> str:
        return f"{self.name}.{short}"

    def humanized_name(self) -> str:
        """Return the display name, falling back to a title-cased
        version of the internal id (``learning_tutor`` -> 'Learning
        Tutor') when no explicit ``display_name`` was set."""
        if self.display_name:
            return self.display_name
        return " ".join(p.capitalize() for p in self.name.replace("-", "_").split("_") if p)


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def load_template(path: Path) -> Template:
    """Parse a single template JSON file."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return _template_from_dict(data, source=path)


def load_templates_dir(templates_dir: Path, *, built_in: bool = True) -> Dict[str, Template]:
    """Load every ``*.json`` in a directory into a name -> Template map.

    ``built_in`` flags the source: True for the package directory
    (``core/agents/teams``), False for user-built customs under
    :func:`_user_templates_dir`. The Studio uses the flag to gate the
    edit / delete affordances on each card.
    """
    out: Dict[str, Template] = {}
    for f in sorted(Path(templates_dir).glob("*.json")):
        try:
            tpl = load_template(f)
            tpl.built_in = built_in
        except Exception:  # noqa: BLE001
            logger.exception("could not load team template %s", f)
            continue
        out[tpl.name] = tpl
    return out


def builtin_templates() -> Dict[str, Template]:
    """Templates shipped with OWLLM (read-only)."""
    return load_templates_dir(Path(__file__).parent, built_in=True)


def _user_templates_dir() -> Path:
    """Where user-built custom templates live. Same data dir layout as
    custom AgentDefinitions and the agent-state DB so the data folder
    has one canonical home."""
    llm_root = Path(__file__).resolve().parents[3]
    return llm_root / "data" / "team_templates"


def user_templates() -> Dict[str, Template]:
    """User-built custom templates (writable). Returns an empty map if
    the directory hasn't been created yet — saving the first custom
    template creates it."""
    d = _user_templates_dir()
    if not d.exists():
        return {}
    return load_templates_dir(d, built_in=False)


def all_templates() -> Dict[str, Template]:
    """Built-ins + custom, merged. Custom wins on name collision so a
    user can override a shipped template by saving one with the same
    ``name``."""
    out = dict(builtin_templates())
    out.update(user_templates())  # user wins
    return out


_NAME_SAFE_RE = re.compile(r"[^a-zA-Z0-9._-]+")


def _sanitize_name(name: str) -> str:
    """Map a user-supplied template name to a safe filename component.
    Same rules as the AgentDefinition store (Latin alphanumerics +
    dot/underscore/hyphen, everything else collapses to ``_``)."""
    cleaned = _NAME_SAFE_RE.sub("_", (name or "").strip()) or "team"
    return cleaned[:80]


def save_custom_template(template: Template) -> Path:
    """Persist a Template as a custom user template JSON. Refuses to
    overwrite a built-in by the same ``name`` — pick a fresh id (the
    Studio enforces this in the UI; this is the hard guard).
    """
    builtins = builtin_templates()
    if template.name in builtins:
        raise ValueError(
            f"'{template.name}' is a built-in template id; pick a different name"
        )
    target_dir = _user_templates_dir()
    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / f"{_sanitize_name(template.name)}.json"
    payload = {
        "name": template.name,
        "display_name": template.display_name or template.humanized_name(),
        "category": template.category or DEFAULT_CATEGORY,
        "description": template.description,
        "icon": template.icon,
        "required_mcp": list(template.required_mcp),
        "agents": [_agent_spec_to_dict(a) for a in template.agents],
        "graph": {
            "edges": [{"source": s, "target": t} for s, t in template.graph_edges],
        },
    }
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def delete_custom_template(name: str) -> bool:
    """Remove a custom template by id. Returns True if a file was
    deleted. Built-ins are protected — calling this on a built-in is
    a no-op that returns False."""
    if name in builtin_templates():
        return False
    path = _user_templates_dir() / f"{_sanitize_name(name)}.json"
    if path.exists():
        path.unlink()
        return True
    return False


def _agent_spec_to_dict(spec: AgentSpec) -> dict:
    """Inverse of :func:`_template_from_dict`'s agent decoder. Drops
    keys whose value is ``None`` so the on-disk JSON stays compact."""
    out: dict = {"name": spec.name}
    for k in (
        "base", "description", "icon", "system_prompt", "extra_prompt",
        "default_model_id",
    ):
        v = getattr(spec, k)
        if v:
            out[k] = v
    if spec.tool_allowlist is not None:
        out["tool_allowlist"] = list(spec.tool_allowlist)
    if spec.mcp_allowlist is not None:
        out["mcp_allowlist"] = list(spec.mcp_allowlist)
    if spec.can_dispatch is not None:
        out["can_dispatch"] = bool(spec.can_dispatch)
    if spec.default_temperature is not None:
        out["default_temperature"] = float(spec.default_temperature)
    return out


# ---------------------------------------------------------------------------
# Materialisation
# ---------------------------------------------------------------------------


def instantiate_template(
    template: Template,
    project_name: Optional[str] = None,
    *,
    project_store=None,
) -> Project:
    """Stamp out a :class:`Project` (and any missing per-agent definitions)
    from ``template`` and persist both.

    The new Project's team list is the prefixed agent names in the order
    they appear in the template. Any AgentDefinition that doesn't already
    exist gets written; existing ones are reused so re-instantiating after
    a customization doesn't clobber the user's edits.
    """
    if project_store is None:
        project_store = get_project_store()

    roles = builtin_roles()

    for spec in template.agents:
        target_name = template.prefixed_agent_name(spec.name)
        if get_definition(target_name) is not None:
            continue  # already materialised; respect user edits
        defn = _build_definition(target_name, spec, roles)
        try:
            save_custom(defn)
        except Exception:  # noqa: BLE001
            logger.exception("could not save agent definition %s", target_name)

    team = [template.prefixed_agent_name(a.name) for a in template.agents]
    graph = _build_graph(template, team)

    proj = Project(
        name=(project_name or template.name).strip() or template.name,
        description=template.description,
        team=team,
        graph_json=graph.to_json_string() if graph.nodes or graph.edges else "",
    )
    return project_store.save_project(proj)


def _build_definition(
    target_name: str,
    spec: AgentSpec,
    roles: Dict[str, "object"],
) -> AgentDefinition:
    """Build an AgentDefinition from an AgentSpec, inheriting from ``base``
    where the spec leaves a field blank."""
    base = roles.get(spec.base) if spec.base else None
    if base is None and not spec.system_prompt:
        raise ValueError(
            f"agent {target_name!r}: must specify either a known 'base' role "
            f"or a full 'system_prompt' (base={spec.base!r})"
        )

    description = spec.description if spec.description is not None else (
        getattr(base, "description", "") if base else ""
    )
    icon = spec.icon if spec.icon is not None else (
        getattr(base, "icon", "🤖") if base else "🤖"
    )
    base_prompt = getattr(base, "system_prompt", "") if base else ""
    if spec.system_prompt is not None:
        prompt = spec.system_prompt.strip()
    elif spec.extra_prompt:
        prompt = (base_prompt.rstrip() + "\n\n" + spec.extra_prompt.strip()).strip()
    else:
        prompt = base_prompt.strip()

    tool_allowlist = (
        spec.tool_allowlist
        if spec.tool_allowlist is not None
        else (list(getattr(base, "tool_allowlist", []) or []) if base and getattr(base, "tool_allowlist", None) else None)
    )
    can_dispatch = (
        spec.can_dispatch
        if spec.can_dispatch is not None
        else bool(getattr(base, "can_dispatch", False)) if base else False
    )
    default_temperature = (
        spec.default_temperature
        if spec.default_temperature is not None
        else float(getattr(base, "default_temperature", 0.4)) if base else 0.4
    )

    return AgentDefinition(
        name=target_name,
        description=description,
        icon=icon,
        system_prompt=prompt,
        tool_allowlist=tool_allowlist,
        mcp_allowlist=spec.mcp_allowlist,
        default_model_id=spec.default_model_id or "",
        can_dispatch=can_dispatch,
        default_temperature=default_temperature,
        built_in=False,
    )


def _build_graph(template: Template, team: List[str]) -> AgentGraph:
    """Translate template short-name edges into a real AgentGraph keyed by
    the materialised (prefixed) agent names. Nodes are added in team order
    so the canvas auto-layout produces a stable, readable arrangement."""
    short_to_long = {a.name: template.prefixed_agent_name(a.name) for a in template.agents}
    graph = AgentGraph()
    for prefixed in team:
        graph.add_node(prefixed)
    for src_short, dst_short in template.graph_edges:
        src = short_to_long.get(src_short)
        dst = short_to_long.get(dst_short)
        if not src or not dst:
            logger.warning(
                "template %s: edge references unknown agent (%s -> %s); skipping",
                template.name,
                src_short,
                dst_short,
            )
            continue
        graph.edges.append(GraphEdge(source=src, target=dst))

    # Run the layered autolayout if the template includes a dispatcher —
    # gives a nice top-down look without hand-placing every node.
    orchestrator_name = next(
        (template.prefixed_agent_name(a.name) for a in template.agents if a.can_dispatch),
        None,
    )
    if orchestrator_name and graph.nodes:
        try:
            graph.autolayout_layered(orchestrator_name)
        except Exception:  # noqa: BLE001
            logger.exception("autolayout failed for template %s", template.name)
    return graph


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _template_from_dict(data: dict, *, source: Path) -> Template:
    name = data.get("name")
    if not name or not isinstance(name, str):
        raise ValueError(f"template {source} missing string 'name'")
    agents_raw = data.get("agents") or []
    if not isinstance(agents_raw, list) or not agents_raw:
        raise ValueError(f"template {source} must list at least one agent")

    agents: List[AgentSpec] = []
    for i, raw in enumerate(agents_raw):
        if not isinstance(raw, dict):
            raise ValueError(f"template {source}: agent #{i} is not an object")
        a_name = raw.get("name")
        if not a_name or not isinstance(a_name, str):
            raise ValueError(f"template {source}: agent #{i} missing 'name'")
        agents.append(
            AgentSpec(
                name=a_name,
                base=_opt_str(raw.get("base")),
                description=_opt_str(raw.get("description")),
                icon=_opt_str(raw.get("icon")),
                system_prompt=_opt_str(raw.get("system_prompt")),
                extra_prompt=_opt_str(raw.get("extra_prompt")),
                tool_allowlist=_opt_list(raw.get("tool_allowlist")),
                mcp_allowlist=_opt_list(raw.get("mcp_allowlist")),
                default_model_id=_opt_str(raw.get("default_model_id")),
                can_dispatch=_opt_bool(raw.get("can_dispatch")),
                default_temperature=_opt_float(raw.get("default_temperature")),
            )
        )

    edges_raw = ((data.get("graph") or {}).get("edges")) or []
    edges: List[Tuple[str, str]] = []
    for e in edges_raw:
        if not isinstance(e, dict):
            continue
        s, t = e.get("source"), e.get("target")
        if isinstance(s, str) and isinstance(t, str):
            edges.append((s, t))

    return Template(
        name=str(name),
        display_name=str(data.get("display_name") or ""),
        category=str(data.get("category") or DEFAULT_CATEGORY),
        description=str(data.get("description") or ""),
        icon=str(data.get("icon") or "🤖"),
        required_mcp=[str(x) for x in (data.get("required_mcp") or [])],
        agents=agents,
        graph_edges=edges,
    )


def _opt_str(v) -> Optional[str]:
    if v is None:
        return None
    s = str(v)
    return s if s else None


def _opt_list(v) -> Optional[List[str]]:
    if v is None:
        return None
    if isinstance(v, str):
        return [v] if v else []
    if isinstance(v, list):
        return [str(x) for x in v]
    return None


def _opt_bool(v) -> Optional[bool]:
    if v is None:
        return None
    return bool(v)


def _opt_float(v) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None
