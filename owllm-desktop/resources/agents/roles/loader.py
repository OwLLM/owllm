"""Role definitions — what an agent *is*.

A ``Role`` is a small bundle: name, system prompt, tool allowlist, and a
default temperature. Roles ship as YAML in ``LLM/core/agents/roles/*.yaml``
so non-engineers can edit them; ``builtin_roles()`` returns the built-in set
preloaded.

The 3D characters page maps each role name to an existing character; adding
a new role = drop a YAML file + add a row in the character map.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Role:
    """One persona an agent can take on."""

    name: str
    description: str
    system_prompt: str
    tool_allowlist: Optional[List[str]] = None
    """``None`` = all tools (orchestrator default); empty list = chat-only."""
    can_dispatch: bool = False
    """Only the orchestrator role flips this to True."""
    default_temperature: float = 0.4
    icon: str = "🤖"


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def load_role(path: Path) -> Role:
    """Load a single role YAML file.

    YAML is optional — we fall back to a tiny manual parser if PyYAML isn't
    installed. The schema is flat enough that this is fine.
    """
    text = Path(path).read_text(encoding="utf-8")
    data = _load_yaml(text)
    return _role_from_dict(data, source=path)


def load_roles_dir(roles_dir: Path) -> Dict[str, Role]:
    """Load every ``*.yaml`` in a directory into a name -> Role map."""
    out: Dict[str, Role] = {}
    for f in sorted(Path(roles_dir).glob("*.yaml")):
        try:
            role = load_role(f)
        except Exception:  # noqa: BLE001
            logger.exception("failed to load role file %s", f)
            continue
        out[role.name] = role
    return out


def builtin_roles() -> Dict[str, Role]:
    """Load the role YAMLs that ship in this package."""
    return load_roles_dir(Path(__file__).parent)


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _role_from_dict(data: dict, *, source: Path) -> Role:
    required = ("name", "system_prompt")
    for k in required:
        if k not in data:
            raise ValueError(f"role file {source} missing key '{k}'")
    return Role(
        name=str(data["name"]),
        description=str(data.get("description", "")),
        system_prompt=str(data["system_prompt"]).strip(),
        tool_allowlist=_normalize_allowlist(data.get("tool_allowlist")),
        can_dispatch=bool(data.get("can_dispatch", False)),
        default_temperature=float(data.get("default_temperature", 0.4)),
        icon=str(data.get("icon", "🤖")),
    )


def _normalize_allowlist(raw) -> Optional[List[str]]:
    if raw is None:
        return None
    if isinstance(raw, str):
        # Allow a single "all" sentinel for clarity.
        if raw.strip().lower() == "all":
            return None
        return [raw]
    return [str(x) for x in raw]


def _load_yaml(text: str) -> dict:
    try:
        import yaml
        return yaml.safe_load(text) or {}
    except ImportError:
        return _tiny_yaml(text)


def _tiny_yaml(text: str) -> dict:
    """Minimal YAML subset: ``key: value`` and ``key: |`` block scalars,
    plus ``key:`` followed by ``- item`` lists. Enough for our role files.

    Intentionally tiny — if it fails on a role file, install PyYAML.
    """
    out: dict = {}
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.rstrip()
        if not stripped or stripped.lstrip().startswith("#"):
            i += 1
            continue
        if ":" not in stripped:
            i += 1
            continue
        key, _, rest = stripped.partition(":")
        key = key.strip()
        rest = rest.strip()

        if rest == "|":
            # Block scalar: indented lines until dedent.
            i += 1
            block: list = []
            base_indent = None
            while i < len(lines):
                bl = lines[i]
                if bl.strip() == "":
                    block.append("")
                    i += 1
                    continue
                indent = len(bl) - len(bl.lstrip(" "))
                if base_indent is None:
                    base_indent = indent
                if indent < base_indent and bl.strip():
                    break
                block.append(bl[base_indent:] if base_indent <= len(bl) else bl.lstrip())
                i += 1
            out[key] = "\n".join(block).rstrip()
            continue

        if rest == "":
            # List?
            i += 1
            items: list = []
            while i < len(lines):
                bl = lines[i]
                if bl.strip() == "":
                    i += 1
                    continue
                if not bl.lstrip().startswith("- "):
                    break
                items.append(bl.lstrip()[2:].strip())
                i += 1
            out[key] = items
            continue

        # Strip surrounding quotes if present.
        val = rest
        if (val.startswith('"') and val.endswith('"')) or (
            val.startswith("'") and val.endswith("'")
        ):
            val = val[1:-1]
        # Coerce booleans / numbers.
        if val.lower() in ("true", "false"):
            out[key] = val.lower() == "true"
        else:
            try:
                if "." in val:
                    out[key] = float(val)
                else:
                    out[key] = int(val)
            except ValueError:
                out[key] = val
        i += 1
    return out
