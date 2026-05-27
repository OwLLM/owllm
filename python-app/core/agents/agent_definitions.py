"""Agent definitions — the user-editable agent spec layer.

Two sources merge into a single name → :class:`AgentDefinition` map:

1. **Built-in roles** loaded from ``core/agents/roles/*.yaml`` — immutable,
   shipped with OWLLM, marked ``built_in=True``.
2. **Custom definitions** the user creates in the Studio page, persisted as
   JSON in ``LLM/data/agent_definitions/<sanitized_name>.json``.

The Studio page is the only UI that writes here. The Workspace page reads
to populate the team picker and to construct the runtime team.

Built-ins can't be edited or deleted. The Studio's "Edit" button on a
built-in actually clones it to a custom definition (e.g. "researcher" →
"researcher-copy") so the original stays canonical for new users.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from core.agents.roles.loader import builtin_roles

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# AgentDefinition
# ---------------------------------------------------------------------------


@dataclass
class AgentDefinition:
    """A complete spec for one agent.

    A superset of :class:`Role` — adds a default model id (so the user's
    Studio choice persists), an MCP tool allowlist (separate from the
    builtin tool allowlist so the user can grant a "Calendar Bot" *only*
    the calendar MCP tools without touching builtins), and provenance.
    """

    name: str
    description: str
    icon: str
    system_prompt: str
    tool_allowlist: Optional[List[str]] = None
    """Built-in tools this agent can use. ``None`` = all builtins."""
    mcp_allowlist: Optional[List[str]] = None
    """MCP tool names (post-namespacing, e.g. 'mcp.whatsapp.send_message')
    this agent can use. ``None`` = all available MCP tools, ``[]`` = none."""
    default_model_id: str = ""
    """Composite backend id (``backend|model_key``) preferred for this
    agent. Empty = let the workspace picker pick."""
    can_dispatch: bool = False
    default_temperature: float = 0.4
    voice_id: str = ""
    """TTS voice identifier used when this agent speaks a final reply. The
    string is backend-specific (e.g. a SAPI voice id on Windows). Empty
    means ``TtsService`` auto-assigns one from the installed voices, hashed
    on the agent name so each agent gets a stable distinct voice without
    explicit config."""
    voice_rate: int = 0
    """Words-per-minute override. 0 = backend default (about 200 wpm)."""
    voice_enabled: bool = True
    """Per-agent mute. The page-level toggle gates everything; this lets the
    user silence one specific agent (e.g. a noisy critic) without disabling
    voice everywhere."""
    built_in: bool = False
    created_at: str = ""
    updated_at: str = ""

    def to_role_compatible(self) -> dict:
        """Render as a dict the existing role-loading code can consume.

        The runtime still expects :class:`core.agents.roles.loader.Role`
        objects via ``builtin_roles()`` / ``build_team``. We bridge by
        emitting a Role-shaped dict and letting the orchestrator construct
        a Role from it where needed.
        """
        # Combine the two allowlists into one for the runtime tool registry —
        # the runtime doesn't distinguish builtin vs MCP, both share one
        # ToolRegistry. ``None + None`` stays None (= "all"); otherwise we
        # union the two lists.
        combined: Optional[List[str]] = None
        if self.tool_allowlist is not None or self.mcp_allowlist is not None:
            combined = list(self.tool_allowlist or [])
            combined.extend(self.mcp_allowlist or [])
        return {
            "name": self.name,
            "description": self.description,
            "icon": self.icon,
            "system_prompt": self.system_prompt,
            "tool_allowlist": combined,
            "can_dispatch": self.can_dispatch,
            "default_temperature": self.default_temperature,
        }


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


def _custom_dir() -> Path:
    """Where custom agent JSONs live. Same data dir as the agent state DB."""
    llm_root = Path(__file__).resolve().parent.parent.parent
    return llm_root / "data" / "agent_definitions"


_NAME_SAFE_RE = re.compile(r"[^a-zA-Z0-9._-]+")


def _sanitize_name(name: str) -> str:
    """Map a user-supplied agent name to a safe filename component.

    Same rules every other OWLLM module uses for user-facing identifiers —
    Latin alphanumerics + dot/underscore/hyphen, everything else collapses
    to ``_``. We don't lower-case — a user named "MyAgent" should round-trip
    identically.
    """
    cleaned = _NAME_SAFE_RE.sub("_", name.strip()) or "agent"
    return cleaned[:80]  # cap to keep paths sane on Windows


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def list_all_definitions() -> Dict[str, AgentDefinition]:
    """Built-ins + custom, merged. Custom wins on name collision."""
    out: Dict[str, AgentDefinition] = {}

    # 1) Built-ins. The YAML role files are the source of truth for the
    # team that ships with OWLLM. We mark them built_in=True so the Studio
    # forbids edit/delete on them.
    for role in builtin_roles().values():
        out[role.name] = AgentDefinition(
            name=role.name,
            description=role.description,
            icon=role.icon,
            system_prompt=role.system_prompt,
            tool_allowlist=role.tool_allowlist,
            mcp_allowlist=None,
            default_model_id="",
            can_dispatch=role.can_dispatch,
            default_temperature=role.default_temperature,
            built_in=True,
        )

    # 2) Custom definitions on disk. Held aside in ``customs`` so step 3
    # can use them as a per-skill override layer (see below) instead of
    # losing the user's edits the moment a SKILL.md is reloaded.
    customs: Dict[str, AgentDefinition] = {}
    custom_dir = _custom_dir()
    if custom_dir.exists():
        for path in sorted(custom_dir.glob("*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                d = _from_dict(data)
                d.built_in = False
                customs[d.name] = d
            except Exception:  # noqa: BLE001
                logger.exception("could not load custom agent %s", path)
                continue
    for name, d in customs.items():
        out[name] = d  # custom overrides any same-named built-in

    # 3) OpenClaw-style SKILL.md skills under ``LLM/data/skills/<name>/``.
    # Skill content (system prompt, description, tool list) is
    # authoritative — those fields update when the user re-pulls the
    # skill. But UI-only choices the user made in Studio (icon and
    # default model) MUST survive a reload, otherwise hitting Save in
    # the Studio is a lie. So when a custom JSON exists for the same
    # name, copy those UI fields onto the skill before publishing it.
    try:
        from core.agents.skill_md import list_skill_definitions
        for name, sd in list_skill_definitions().items():
            sd.built_in = False
            override = customs.get(name)
            if override is not None:
                if override.icon:
                    sd.icon = override.icon
                if override.default_model_id:
                    sd.default_model_id = override.default_model_id
            out[name] = sd
    except Exception:  # noqa: BLE001
        logger.exception("could not load SKILL.md skills")

    return out


def get_definition(name: str) -> Optional[AgentDefinition]:
    return list_all_definitions().get(name)


# ---------------------------------------------------------------------------
# Mutating ops (custom only)
# ---------------------------------------------------------------------------


def save_custom(definition: AgentDefinition) -> Path:
    """Persist a custom definition to disk. Returns the file path.

    Refuses to save under a built-in's name — the user must duplicate
    first. The Studio enforces this in the UI; here it's a hard guard.
    """
    if definition.name in {n for n, d in list_all_definitions().items() if d.built_in}:
        raise ValueError(
            f"'{definition.name}' is a built-in name; duplicate first under a different name"
        )
    custom_dir = _custom_dir()
    custom_dir.mkdir(parents=True, exist_ok=True)
    path = custom_dir / f"{_sanitize_name(definition.name)}.json"

    # Stamp timestamps. created_at sticks; updated_at refreshes every save.
    if not definition.created_at:
        definition.created_at = _now_iso()
    definition.updated_at = _now_iso()
    definition.built_in = False

    payload = asdict(definition)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def delete_custom(name: str) -> bool:
    """Remove a custom definition. Returns True if a file was deleted.

    Built-ins are protected — calling delete on a built-in is a no-op
    that returns False.
    """
    defs = list_all_definitions()
    existing = defs.get(name)
    if existing is None or existing.built_in:
        return False
    path = _custom_dir() / f"{_sanitize_name(name)}.json"
    if path.exists():
        path.unlink()
        return True
    return False


def duplicate(source_name: str, new_name: str) -> AgentDefinition:
    """Clone any definition (built-in or custom) into a new custom one.

    The Studio uses this to let users base a custom agent on a built-in
    without overwriting the canonical YAML.
    """
    src = get_definition(source_name)
    if src is None:
        raise ValueError(f"no such agent: {source_name}")
    if not new_name.strip():
        raise ValueError("new_name cannot be empty")
    if new_name == source_name:
        raise ValueError("new name must differ from source name")
    existing = list_all_definitions()
    if new_name in existing:
        raise ValueError(f"'{new_name}' already exists; pick a different name")

    clone = AgentDefinition(
        name=new_name,
        description=src.description,
        icon=src.icon,
        system_prompt=src.system_prompt,
        tool_allowlist=list(src.tool_allowlist) if src.tool_allowlist is not None else None,
        mcp_allowlist=list(src.mcp_allowlist) if src.mcp_allowlist is not None else None,
        default_model_id=src.default_model_id,
        can_dispatch=src.can_dispatch,
        default_temperature=src.default_temperature,
        voice_id=src.voice_id,
        voice_rate=src.voice_rate,
        voice_enabled=src.voice_enabled,
        built_in=False,
    )
    save_custom(clone)
    return clone


def is_custom(name: str) -> bool:
    d = get_definition(name)
    return d is not None and not d.built_in


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _from_dict(data: dict) -> AgentDefinition:
    # Tolerate old / partial schemas — every field has a default.
    return AgentDefinition(
        name=str(data.get("name") or ""),
        description=str(data.get("description") or ""),
        icon=str(data.get("icon") or "🤖"),
        system_prompt=str(data.get("system_prompt") or ""),
        tool_allowlist=_coerce_list(data.get("tool_allowlist")),
        mcp_allowlist=_coerce_list(data.get("mcp_allowlist")),
        default_model_id=str(data.get("default_model_id") or ""),
        can_dispatch=bool(data.get("can_dispatch", False)),
        default_temperature=float(data.get("default_temperature", 0.4)),
        voice_id=str(data.get("voice_id") or ""),
        voice_rate=int(data.get("voice_rate") or 0),
        voice_enabled=bool(data.get("voice_enabled", True)),
        built_in=bool(data.get("built_in", False)),
        created_at=str(data.get("created_at") or ""),
        updated_at=str(data.get("updated_at") or ""),
    )


def _coerce_list(v) -> Optional[List[str]]:
    if v is None:
        return None
    if isinstance(v, list):
        return [str(x) for x in v]
    if isinstance(v, str) and v.strip().lower() == "all":
        return None
    return [str(v)]
