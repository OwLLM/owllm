"""Team templates — preset multi-agent project bundles.

A *team template* is a JSON file that describes a complete project preset:

  * a list of agents (each with a base role + per-agent overrides)
  * the routing graph wiring those agents together
  * the MCP servers the team expects to have configured

The Studio's "New project from template…" picker reads these and stamps out
a real :class:`Project` plus the per-agent :class:`AgentDefinition` s the
template needs. The user can then edit anything as if they had built the
project by hand.

Templates ship in ``LLM/core/agents/teams/*.json`` and are read-only. User
customizations live on the materialised agent definitions (with a team-name
prefix so multiple instances of the same template don't collide) and on
the resulting :class:`Project` row.
"""
from core.agents.teams.loader import (
    AgentSpec,
    Template,
    builtin_templates,
    instantiate_template,
    load_template,
)

__all__ = [
    "AgentSpec",
    "Template",
    "builtin_templates",
    "instantiate_template",
    "load_template",
]
