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
from core.fleet.container_runtime import (
    NETWORK_BRIDGE,
    NETWORK_HOST,
    NETWORK_NONE,
    ContainerRuntime,
    Mount,
    container_name_for,
    default_auth_mounts,
    default_user_id,
)
from core.fleet.manifest import (
    GPU_MODE_RO,
    GPU_MODE_RW,
    STATUS_ACTIVE,
    STATUS_RELEASED,
    Claim,
    ClaimConflict,
    Manifest,
)
from core.fleet.outputs import Artifact, ArtifactConflict, OutputRegistry
from core.fleet.process import ProcessHandle, ProcessRegistry
from core.fleet.runtime import (
    Runtime,
    WorktreeRuntime,
    default_runtime,
    set_default_runtime,
)

__all__ = [
    "Artifact",
    "ArtifactConflict",
    "Broker",
    "Claim",
    "ClaimConflict",
    "ContainerRuntime",
    "GPU_MODE_RO",
    "GPU_MODE_RW",
    "Manifest",
    "Mount",
    "NETWORK_BRIDGE",
    "NETWORK_HOST",
    "NETWORK_NONE",
    "OutputRegistry",
    "PoolConfig",
    "PoolExhausted",
    "ProcessHandle",
    "ProcessRegistry",
    "Runtime",
    "STATUS_ACTIVE",
    "STATUS_RELEASED",
    "WorktreeRuntime",
    "container_name_for",
    "default_auth_mounts",
    "default_runtime",
    "default_user_id",
    "set_default_runtime",
]
