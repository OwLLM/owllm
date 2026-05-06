"""Fleet — physical-placement layer for OWLLM agents.

While ``core.agents`` is concerned with how agents *think* together
(orchestrator, dispatch, message bus, routing graphs), :mod:`core.fleet`
is concerned with how agents are *placed* in the physical world: which
workspace directory, which target repo + branch, which port, which GPU
slot, which file modules they're allowed to edit.

The two layers are deliberately decoupled. A ``core.agents.Team`` runs
in one process today; tomorrow each of its agents may run in its own
:class:`Broker`-allocated workspace on a different repo, and the team
layer doesn't need to change.

Slice 1a ships:

* :class:`Manifest` — atomic SQLite registry of active claims with
  overlap refusal across branch / workspace / port / GPU / module paths.
* :class:`Broker` — pool-aware allocator on top.

Spawning concrete workspaces (clone, venv, AGENT_CONTEXT.md), the CLI,
and the UI integration land in later slices.
"""
from __future__ import annotations

from core.fleet.broker import Broker, PoolConfig, PoolExhausted
from core.fleet.manifest import (
    GPU_MODE_RO,
    GPU_MODE_RW,
    STATUS_ACTIVE,
    STATUS_RELEASED,
    Claim,
    ClaimConflict,
    Manifest,
)

__all__ = [
    "Broker",
    "Claim",
    "ClaimConflict",
    "GPU_MODE_RO",
    "GPU_MODE_RW",
    "Manifest",
    "PoolConfig",
    "PoolExhausted",
    "STATUS_ACTIVE",
    "STATUS_RELEASED",
]
