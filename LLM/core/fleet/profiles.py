"""Spawn-time profiles — reusable presets for the spawn dialog.

A :class:`Profile` is a bag of defaults the spawn dialog applies when
the user picks it: owned globs, reads globs, default reason, ttl.
Profiles do NOT contain the target repo or branch — those are
per-spawn decisions that have nothing to do with the role the agent
plays. They prevent the form from feeling like a 9-field intake at
the cost of one click.

Slice 2b ships only built-in profiles. Custom profiles can later be
dropped into ``<fleet_root>/profiles/*.json`` (matching the same
schema) and the store will pick them up — :class:`ProfileStore`
already reads that directory; it's just empty today.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Iterable, List, Optional, Tuple

from core.fleet.config import fleet_root

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Profile:
    """Defaults applied when the spawn dialog picks this preset."""

    name: str
    description: str
    icon: str = "🤖"
    owns_modules: Tuple[str, ...] = ()
    reads_modules: Tuple[str, ...] = ()
    default_reason: str = ""
    ttl_seconds: int = 3600
    base_branch: str = "main"
    built_in: bool = True

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "icon": self.icon,
            "owns_modules": list(self.owns_modules),
            "reads_modules": list(self.reads_modules),
            "default_reason": self.default_reason,
            "ttl_seconds": self.ttl_seconds,
            "base_branch": self.base_branch,
            "built_in": self.built_in,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Profile":
        return cls(
            name=str(data["name"]),
            description=str(data.get("description", "")),
            icon=str(data.get("icon", "🤖")),
            owns_modules=tuple(data.get("owns_modules", []) or []),
            reads_modules=tuple(data.get("reads_modules", []) or []),
            default_reason=str(data.get("default_reason", "")),
            ttl_seconds=int(data.get("ttl_seconds", 3600)),
            base_branch=str(data.get("base_branch", "main")),
            # Anything loaded from disk is by definition not a built-in,
            # regardless of what the JSON says.
            built_in=False,
        )


# ---------------------------------------------------------------------------
# Built-ins
# ---------------------------------------------------------------------------


CUSTOM = Profile(
    name="custom",
    description="Start blank — fill in your own scope",
    icon="✏️",
)


TEST_WRITER = Profile(
    name="test-writer",
    description="Add tests for an existing module",
    icon="🧪",
    owns_modules=("tests/**",),
    reads_modules=("src/**",),
    default_reason="Add tests",
)


DOC_AGENT = Profile(
    name="doc-agent",
    description="Improve documentation",
    icon="📝",
    owns_modules=("docs/**",),
    reads_modules=("src/**",),
    default_reason="Improve documentation",
)


LIBRARY_MAINTAINER = Profile(
    name="library-maintainer",
    description="Long-running maintenance task",
    icon="🔧",
    default_reason="Maintain library",
    ttl_seconds=7200,
)


BUILTIN_PROFILES: Tuple[Profile, ...] = (
    CUSTOM,
    TEST_WRITER,
    DOC_AGENT,
    LIBRARY_MAINTAINER,
)


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------


def default_profiles_dir() -> Path:
    return fleet_root() / "profiles"


class ProfileStore:
    """Read-only-for-now access to the available profiles.

    Built-ins are baked into this module. Custom profiles drop into
    ``<custom_dir>/*.json`` and are merged into ``list_all()``; the
    store de-dupes by ``name`` (first match wins, so a custom profile
    can override a built-in by reusing the name).
    """

    def __init__(self, custom_dir: Optional[Path] = None):
        self._custom_dir = custom_dir or default_profiles_dir()

    @property
    def custom_dir(self) -> Path:
        return self._custom_dir

    def list_all(self) -> List[Profile]:
        result: List[Profile] = []
        seen_names = set()
        for p in self._load_custom():
            if p.name in seen_names:
                continue
            result.append(p)
            seen_names.add(p.name)
        for p in BUILTIN_PROFILES:
            if p.name in seen_names:
                continue
            result.append(p)
            seen_names.add(p.name)
        return result

    def get(self, name: str) -> Profile:
        for p in self.list_all():
            if p.name == name:
                return p
        raise KeyError(name)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _load_custom(self) -> Iterable[Profile]:
        if not self._custom_dir.exists():
            return ()
        out: List[Profile] = []
        for path in sorted(self._custom_dir.glob("*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                out.append(Profile.from_dict(data))
            except Exception as e:
                logger.warning(
                    "skipping malformed profile %s: %s", path.name, e,
                )
        return out
