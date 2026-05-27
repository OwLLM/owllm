"""Loader for OpenClaw-style ``SKILL.md`` agent definitions.

OpenClaw packages agents as directories containing a ``SKILL.md`` file with
YAML-ish frontmatter and a Markdown body that becomes the system prompt.
This module reads that format and emits :class:`AgentDefinition` objects so
they show up in the Studio + Workspace alongside our native YAML / JSON
agents.

Layout:

    LLM/data/skills/
        my_skill/
            SKILL.md
            (any other resources the skill wants to bundle)

SKILL.md frontmatter (required keys ``name``, ``description``):

    ---
    name: my-skill
    description: A short description.
    icon: 🦞
    tools:
      - read_file
      - shell
    mcp_tools:
      - mcp.calendar.list_events
    model: claude_cli|claude-sonnet-4-6
    leader: false
    temperature: 0.3
    ---

    # System prompt body (markdown)

    You are ...
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

from core.agents.agent_definitions import AgentDefinition

logger = logging.getLogger(__name__)


_FRONTMATTER_RE = re.compile(
    r"\A---\s*\n(?P<fm>.*?)\n---\s*\n(?P<body>.*)\Z",
    re.DOTALL,
)


def _user_skills_dir() -> Path:
    """Where user-installed skills live. Same data dir as the agent state DB."""
    llm_root = Path(__file__).resolve().parent.parent.parent
    return llm_root / "data" / "skills"


def list_skill_definitions() -> Dict[str, AgentDefinition]:
    """Load every ``SKILL.md``-defined agent under ``LLM/data/skills/``.

    Returns ``{name: AgentDefinition}``. Errors loading a single skill are
    logged and the skill is skipped — one bad skill folder shouldn't take
    down the rest.
    """
    out: Dict[str, AgentDefinition] = {}
    base = _user_skills_dir()
    if not base.exists():
        return out
    for child in sorted(base.iterdir()):
        if not child.is_dir():
            continue
        skill_md = child / "SKILL.md"
        if not skill_md.exists():
            continue
        try:
            d = parse_skill_md(skill_md.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            logger.exception("could not parse SKILL.md for %s", child.name)
            continue
        out[d.name] = d
    return out


def parse_skill_md(text: str) -> AgentDefinition:
    """Parse a SKILL.md string into an :class:`AgentDefinition`.

    Raises ``ValueError`` if the document doesn't have a YAML frontmatter
    block delimited by ``---`` lines.
    """
    m = _FRONTMATTER_RE.match(text)
    if not m:
        raise ValueError("SKILL.md missing YAML frontmatter (---/.../---)")
    fm = _parse_frontmatter(m.group("fm"))
    body = m.group("body").strip()

    name = str(fm.get("name") or "").strip()
    if not name:
        raise ValueError("SKILL.md frontmatter missing 'name'")

    # Anthropic-style skills name tools in CamelCase (Read, Bash, Edit…).
    # Run every entry through the alias map so they resolve against our
    # snake_case ToolRegistry. Native OWLLM names pass through untouched.
    raw_tools = _coerce_list(fm.get("tools"))
    if raw_tools is not None:
        try:
            from core.agents.skill_sources import alias_tool_name
            raw_tools = [alias_tool_name(t) for t in raw_tools]
        except Exception:  # noqa: BLE001
            logger.exception("tool alias rewrite failed; using raw names")

    return AgentDefinition(
        name=name,
        description=str(fm.get("description") or ""),
        icon=str(fm.get("icon") or "🦞"),
        system_prompt=body,
        tool_allowlist=raw_tools,
        mcp_allowlist=_coerce_list(fm.get("mcp_tools")),
        default_model_id=str(fm.get("model") or ""),
        can_dispatch=_coerce_bool(fm.get("leader")) or _coerce_bool(fm.get("can_dispatch")),
        default_temperature=_coerce_float(fm.get("temperature"), 0.4),
        built_in=False,
    )


# ---------------------------------------------------------------------------
# Tiny YAML-frontmatter parser
# ---------------------------------------------------------------------------
#
# We don't want to require PyYAML for skills (the rest of agents/ already
# has a tiny YAML fallback). The same level of subset is enough here:
# scalar key-value pairs and indented dash lists.

_KEY_VAL_RE = re.compile(r"^(?P<key>[A-Za-z_][\w-]*)\s*:\s*(?P<val>.*)$")
_LIST_ITEM_RE = re.compile(r"^\s*-\s*(?P<val>.+)$")


def _parse_frontmatter(fm: str) -> dict:
    out: dict = {}
    lines = fm.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].rstrip()
        if not line or line.lstrip().startswith("#"):
            i += 1
            continue
        m = _KEY_VAL_RE.match(line)
        if not m:
            i += 1
            continue
        key = m.group("key")
        val = m.group("val").strip()

        if val == "":
            # Followed by a list?
            items: List[str] = []
            j = i + 1
            while j < len(lines):
                bl = lines[j].rstrip()
                if not bl.strip():
                    j += 1
                    continue
                lm = _LIST_ITEM_RE.match(bl)
                if not lm:
                    break
                items.append(lm.group("val").strip().strip('"').strip("'"))
                j += 1
            out[key] = items
            i = j
            continue

        # Strip wrapping quotes.
        if (val.startswith('"') and val.endswith('"')) or (
            val.startswith("'") and val.endswith("'")
        ):
            val = val[1:-1]
        out[key] = val
        i += 1
    return out


def _coerce_list(v) -> Optional[List[str]]:
    if v is None:
        return None
    if isinstance(v, list):
        return [str(x) for x in v]
    if isinstance(v, str):
        if v.strip().lower() == "all":
            return None
        return [v]
    return None


def _coerce_bool(v) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() in ("true", "yes", "1", "on")
    return False


def _coerce_float(v, default: float) -> float:
    try:
        return float(v) if v is not None and v != "" else default
    except (TypeError, ValueError):
        return default
