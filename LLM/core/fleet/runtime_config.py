"""Runtime selection + container knobs as serialised config.

Today's situation: choosing :class:`ContainerRuntime` vs
:class:`WorktreeRuntime` and tuning its mounts / network / image
requires writing Python (``set_default_runtime(...)``). This module
surfaces those knobs as JSON at ``<fleet_root>/runtime.json`` so the
UI can drive them and the choice survives app restarts.

JSON shape::

    {
      "kind": "container",
      "image": "python:3.12-slim",
      "network": "none",
      "use_default_auth_mounts": true,
      "extra_auth_mounts": [
        {"host_path": "...", "container_path": "...", "mode": "ro"}
      ],
      "enforce_module_mounts": true
    }

Missing file = the default :class:`WorktreeRuntime`. Malformed file =
log a warning and fall back to default; never raise into the caller,
because runtime config failures must not stop the service from
starting.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

from core.fleet.container_runtime import (
    DEFAULT_IMAGE,
    ContainerRuntime,
    Mount,
    default_auth_mounts,
)
from core.fleet.runtime import Runtime, WorktreeRuntime

logger = logging.getLogger(__name__)


KIND_WORKTREE = "worktree"
KIND_CONTAINER = "container"


@dataclass
class RuntimeConfig:
    """Serialised view of a Runtime's construction kwargs."""

    kind: str = KIND_WORKTREE
    # Container-only (ignored when kind == worktree)
    image: str = DEFAULT_IMAGE
    network: Optional[str] = None
    use_default_auth_mounts: bool = True
    extra_auth_mounts: List[Mount] = field(default_factory=list)
    enforce_module_mounts: bool = False

    def to_dict(self) -> dict:
        return {
            "kind": self.kind,
            "image": self.image,
            "network": self.network,
            "use_default_auth_mounts": self.use_default_auth_mounts,
            "extra_auth_mounts": [
                {
                    "host_path": m.host_path,
                    "container_path": m.container_path,
                    "mode": m.mode,
                }
                for m in self.extra_auth_mounts
            ],
            "enforce_module_mounts": self.enforce_module_mounts,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "RuntimeConfig":
        kind = str(data.get("kind", KIND_WORKTREE))
        if kind not in (KIND_WORKTREE, KIND_CONTAINER):
            logger.warning(
                "runtime config: unknown kind %r — falling back to worktree",
                kind,
            )
            kind = KIND_WORKTREE
        mounts: List[Mount] = []
        for m in data.get("extra_auth_mounts", []) or []:
            try:
                mounts.append(Mount(
                    host_path=str(m["host_path"]),
                    container_path=str(m["container_path"]),
                    mode=str(m.get("mode", "rw")),
                ))
            except (KeyError, TypeError, ValueError) as e:
                logger.warning("runtime config: bad mount %r: %s", m, e)
        return cls(
            kind=kind,
            image=str(data.get("image", DEFAULT_IMAGE)),
            network=(
                None if data.get("network") in (None, "")
                else str(data["network"])
            ),
            use_default_auth_mounts=bool(
                data.get("use_default_auth_mounts", True)
            ),
            extra_auth_mounts=mounts,
            enforce_module_mounts=bool(
                data.get("enforce_module_mounts", False)
            ),
        )

    @classmethod
    def load(cls, path: Path) -> "RuntimeConfig":
        """Load from disk; return defaults on missing or malformed file."""
        if not path.exists():
            return cls()
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            logger.warning(
                "runtime config: could not read %s (%s) — using defaults",
                path, e,
            )
            return cls()
        try:
            return cls.from_dict(data)
        except Exception as e:
            logger.warning(
                "runtime config: malformed (%s) — using defaults", e,
            )
            return cls()

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(self.to_dict(), indent=2), encoding="utf-8",
        )

    def to_runtime(self) -> Runtime:
        """Instantiate the configured runtime.

        ``ContainerRuntime`` is selected only when the kind is
        ``container`` AND Docker is actually available. If kind is
        container but Docker is absent, log a warning and fall back
        to ``WorktreeRuntime`` — running an agent without isolation
        is better than refusing to spawn at all.
        """
        if self.kind == KIND_CONTAINER:
            if not ContainerRuntime.is_available():
                logger.warning(
                    "runtime config: container kind selected but docker "
                    "isn't available — falling back to WorktreeRuntime"
                )
                return WorktreeRuntime()
            mounts: List[Mount] = []
            if self.use_default_auth_mounts:
                mounts.extend(default_auth_mounts())
            mounts.extend(self.extra_auth_mounts)
            return ContainerRuntime(
                image=self.image,
                auth_mounts=mounts,
                network=self.network,
                enforce_module_mounts=self.enforce_module_mounts,
            )
        return WorktreeRuntime()
