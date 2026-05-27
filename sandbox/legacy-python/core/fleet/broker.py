"""Fleet broker — pool-aware allocation on top of the manifest.

The manifest enforces "claims don't overlap." The broker actually
*picks* free resources from configured pools (port range, GPU slots,
workspace root) and assembles a :class:`Claim`. It also wraps the
lifecycle operations in idiomatic high-level methods that callers
(CLI, UI, Supervisor) can use without writing SQL.

The broker is intentionally thin: 90% of the safety properties live
in the manifest's transactional claim. The broker only adds discovery
("which port is free?") and convenience.

Race note: pool reads happen *before* the manifest's exclusive
transaction. A concurrent broker could allocate the same port between
our read and our claim. The manifest's unique partial index will
reject the second writer and surface :class:`ClaimConflict`; callers
that want automatic retry should catch that and call ``spawn_claim``
again. We don't retry inside the broker because the right fallback
policy depends on what the caller is doing.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, List, Optional, Sequence

from core.fleet.manifest import GPU_MODE_RW, Claim, Manifest

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PoolConfig:
    """Pool budgets the broker is allowed to hand out."""

    workspace_root: Path
    port_range: range = field(default_factory=lambda: range(8081, 8181))
    gpu_slots: tuple[int, ...] = field(default_factory=tuple)


class PoolExhausted(RuntimeError):
    """Raised when no free resource is available from a pool."""

    def __init__(self, pool: str, detail: str = ""):
        self.pool = pool
        super().__init__(
            f"pool '{pool}' exhausted" + (f": {detail}" if detail else "")
        )


class Broker:
    """Allocator + lifecycle wrapper around :class:`Manifest`."""

    def __init__(self, manifest: Manifest, pool: PoolConfig):
        self.manifest = manifest
        self.pool = pool
        self.pool.workspace_root.mkdir(parents=True, exist_ok=True)

    # -- spawning -----------------------------------------------------------

    def spawn_claim(
        self,
        agent_id: str,
        target_repo: str,
        branch: str,
        owns_modules: Sequence[str],
        *,
        reads_modules: Sequence[str] = (),
        port: Optional[int] = None,
        gpu_slot: Optional[int] = None,
        gpu_mode: str = GPU_MODE_RW,
        ttl_seconds: int = 3600,
        reason: str = "",
        workspace_path: Optional[str] = None,
    ) -> Claim:
        """Allocate resources from the pool and insert an active claim.

        Caller may pin specific port / gpu_slot / workspace_path;
        otherwise the broker picks the first free value. Pinning a
        value that's already claimed raises :class:`PoolExhausted`.
        """
        actives = self.manifest.list_active()
        used_ports = {c.port for c in actives if c.port is not None}
        used_workspaces = {c.workspace_path for c in actives}
        used_gpu_rw = {
            c.gpu_slot for c in actives
            if c.gpu_slot is not None and c.gpu_mode == GPU_MODE_RW
        }

        if port is None:
            port = self._first_free(self.pool.port_range, used_ports, "ports")
        elif port in used_ports:
            raise PoolExhausted("ports", f"port {port} already claimed")

        if workspace_path is None:
            workspace_path = str(self.pool.workspace_root / agent_id)
        if workspace_path in used_workspaces:
            raise PoolExhausted("workspace", f"{workspace_path} already claimed")

        # Auto-allocate a GPU slot only when caller wants exclusive (rw)
        # and the pool has any. If none free, fall back to no slot — the
        # caller's job is CPU-friendly or they pinned a slot explicitly.
        if (gpu_slot is None
                and gpu_mode == GPU_MODE_RW
                and self.pool.gpu_slots):
            try:
                gpu_slot = self._first_free(
                    self.pool.gpu_slots, used_gpu_rw, "gpu_slots"
                )
            except PoolExhausted:
                gpu_slot = None
        elif gpu_slot is not None and gpu_mode == GPU_MODE_RW and gpu_slot in used_gpu_rw:
            raise PoolExhausted("gpu_slots", f"slot {gpu_slot} already rw")

        claim = Claim(
            agent_id=agent_id,
            target_repo=target_repo,
            branch=branch,
            workspace_path=workspace_path,
            owns_modules=list(owns_modules),
            reads_modules=list(reads_modules),
            port=port,
            gpu_slot=gpu_slot,
            gpu_mode=gpu_mode,
            ttl_seconds=ttl_seconds,
            reason=reason,
        )
        return self.manifest.claim(claim)

    # -- lifecycle ----------------------------------------------------------

    def release(self, agent_id: str) -> bool:
        return self.manifest.release(agent_id)

    def heartbeat(self, agent_id: str) -> bool:
        return self.manifest.heartbeat(agent_id)

    def get(self, agent_id: str) -> Optional[Claim]:
        return self.manifest.get(agent_id)

    def list_active(self) -> List[Claim]:
        return self.manifest.list_active()

    def reap_stale(self) -> List[Claim]:
        return self.manifest.reap_stale()

    # -- internals ----------------------------------------------------------

    @staticmethod
    def _first_free(
        candidates: Iterable[int], used: set, pool_name: str
    ) -> int:
        for c in candidates:
            if c not in used:
                return c
        raise PoolExhausted(pool_name)
