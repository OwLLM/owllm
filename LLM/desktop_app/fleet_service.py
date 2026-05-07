"""Qt-friendly facade for :mod:`core.fleet`.

The page can't call git operations on the main thread — a clone of a
real repo blocks for many seconds. :class:`FleetService` owns a
:class:`core.fleet.Broker` instance for the page's lifetime and runs
long ops (spawn, finish) on background :class:`QThread` s, emitting
completion signals on the main thread.

Read-only ops (``list_active``, ``heartbeat``, ``reap_stale``) run
synchronously — they hit a local SQLite file in microseconds and
don't justify a thread hop.

Threading note: SQLite connections are opened with
``check_same_thread=False`` and serialized by the manifest's internal
lock, so worker threads can call broker methods directly without
extra synchronization here.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import asdict
from typing import Any, Dict, Iterable, List, Optional, Sequence

from PySide6.QtCore import QObject, QThread, Signal

from core.fleet.broker import Broker, PoolConfig, PoolExhausted
from core.fleet.config import (
    DEFAULT_PORT_HIGH,
    DEFAULT_PORT_LOW,
    default_db,
    default_process_index,
    default_workspaces,
)
from core.fleet.manifest import Claim, ClaimConflict, Manifest
from core.fleet.process import ProcessHandle, ProcessRegistry
from core.fleet.runtime import Runtime, default_runtime
from core.fleet.workspace import WorkspaceError, WorkspaceLayout

logger = logging.getLogger(__name__)


def _claim_dict(
    c: Claim, registry: Optional[ProcessRegistry] = None,
) -> Dict[str, Any]:
    """Lossless dict view of a claim, suitable for signals + JSON.

    When a :class:`ProcessRegistry` is supplied, the dict gets a
    ``process`` key carrying the launched-process status (or ``None``
    if no process is registered for this agent).
    """
    out = asdict(c)
    out["process"] = None
    if registry is not None:
        handle = registry.get(c.agent_id)
        if handle is not None:
            out["process"] = handle.to_dict()
    return out


class FleetService(QObject):
    """Qt-friendly facade around the broker.

    Signals (all main-thread):

    * ``claims_changed(list[dict])`` — fired whenever the active set
      changes (spawn complete, finish complete, reap, manual refresh).
    * ``spawn_succeeded(dict)`` — claim dict for the new agent.
    * ``spawn_failed(str, str)`` — (agent_id, error_message).
    * ``finish_succeeded(str, object)`` — (agent_id, pr_url-or-None).
    * ``finish_failed(str, str)`` — (agent_id, error_message).
    """

    claims_changed = Signal(list)
    spawn_succeeded = Signal(dict)
    spawn_failed = Signal(str, str)
    finish_succeeded = Signal(str, object)
    finish_failed = Signal(str, str)

    def __init__(
        self,
        *,
        db_path: Optional[str] = None,
        workspace_root: Optional[str] = None,
        process_index_dir: Optional[str] = None,
        port_low: int = DEFAULT_PORT_LOW,
        port_high: int = DEFAULT_PORT_HIGH,
        gpu_slots: Sequence[int] = (),
        runtime: Optional[Runtime] = None,
        parent: Optional[QObject] = None,
    ):
        super().__init__(parent)
        self._manifest = Manifest(default_db(db_path))
        self._manifest.open()
        self._broker = Broker(
            self._manifest,
            PoolConfig(
                workspace_root=default_workspaces(workspace_root),
                port_range=range(port_low, port_high),
                gpu_slots=tuple(gpu_slots),
            ),
        )
        self._runtime = runtime or default_runtime()
        self._registry = ProcessRegistry(
            default_process_index(process_index_dir),
        )
        # Keep references to running workers so they're not GC'd
        # mid-flight.
        self._workers: List[QThread] = []

    def shutdown(self) -> None:
        # Stop any agent processes before closing the SQLite handle —
        # leaving them running past app exit would leak file locks on
        # Windows and orphan the workspaces.
        for handle in self._registry.list():
            try:
                self._runtime.stop(handle)
            except Exception:
                logger.warning(
                    "shutdown: could not stop %s", handle.agent_id,
                    exc_info=True,
                )
        for w in list(self._workers):
            w.quit()
            w.wait(2000)
        self._manifest.close()

    # ------------------------------------------------------------------
    # Read-only (sync)
    # ------------------------------------------------------------------

    def list_active(self) -> List[Dict[str, Any]]:
        self._registry.refresh_status()
        return [_claim_dict(c, self._registry) for c in self._broker.list_active()]

    def list_all(self) -> List[Dict[str, Any]]:
        self._registry.refresh_status()
        return [
            _claim_dict(c, self._registry) for c in self._manifest.list_all()
        ]

    def heartbeat(self, agent_id: str) -> bool:
        ok = self._broker.heartbeat(agent_id)
        if ok:
            self._emit_changed()
        return ok

    def reap_stale(self) -> List[Dict[str, Any]]:
        reaped = self._broker.reap_stale()
        if reaped:
            self._emit_changed()
        return [_claim_dict(c, self._registry) for c in reaped]

    def refresh(self) -> None:
        self._emit_changed()

    # ------------------------------------------------------------------
    # Long-running (async)
    # ------------------------------------------------------------------

    def spawn_async(
        self,
        *,
        target_repo: str,
        branch: str,
        owns_modules: Sequence[str],
        reads_modules: Sequence[str] = (),
        launch_command: Sequence[str] = (),
        reason: str = "",
        ttl_seconds: int = 3600,
        port: Optional[int] = None,
        gpu_slot: Optional[int] = None,
        base_branch: str = "main",
        agent_id: Optional[str] = None,
    ) -> "_SpawnWorker":
        worker = _SpawnWorker(
            self._broker,
            self._runtime,
            self._registry,
            agent_id=agent_id or f"agent-{uuid.uuid4().hex[:8]}",
            target_repo=target_repo,
            branch=branch,
            owns_modules=list(owns_modules),
            reads_modules=list(reads_modules),
            launch_command=tuple(launch_command),
            reason=reason,
            ttl_seconds=ttl_seconds,
            port=port,
            gpu_slot=gpu_slot,
            base_branch=base_branch,
        )
        worker.succeeded.connect(self._on_spawn_succeeded)
        worker.failed.connect(self._on_spawn_failed)
        worker.finished.connect(lambda w=worker: self._reap_worker(w))
        self._workers.append(worker)
        worker.start()
        return worker

    def finish_async(
        self,
        agent_id: str,
        *,
        push: bool = True,
        open_pr: bool = False,
        pr_title: str = "",
        pr_body: str = "",
    ) -> "_FinishWorker":
        worker = _FinishWorker(
            self._broker,
            self._runtime,
            self._registry,
            agent_id=agent_id,
            push=push,
            open_pr=open_pr,
            pr_title=pr_title,
            pr_body=pr_body,
        )
        worker.succeeded.connect(self._on_finish_succeeded)
        worker.failed.connect(self._on_finish_failed)
        worker.finished.connect(lambda w=worker: self._reap_worker(w))
        self._workers.append(worker)
        worker.start()
        return worker

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def get_log_path(self, agent_id: str) -> Optional[str]:
        """Return the absolute path of the agent's launch log, if any.

        UI uses this for the "View log" affordance — keeps the
        registry private to the service.
        """
        handle = self._registry.get(agent_id)
        return str(handle.log_path) if handle is not None else None

    def _emit_changed(self) -> None:
        self.claims_changed.emit(self.list_active())

    def _on_spawn_succeeded(self, claim: dict) -> None:
        self.spawn_succeeded.emit(claim)
        self._emit_changed()

    def _on_spawn_failed(self, agent_id: str, msg: str) -> None:
        self.spawn_failed.emit(agent_id, msg)
        self._emit_changed()

    def _on_finish_succeeded(self, agent_id: str, pr_url: object) -> None:
        self.finish_succeeded.emit(agent_id, pr_url)
        self._emit_changed()

    def _on_finish_failed(self, agent_id: str, msg: str) -> None:
        self.finish_failed.emit(agent_id, msg)
        self._emit_changed()

    def _reap_worker(self, worker: QThread) -> None:
        if worker in self._workers:
            self._workers.remove(worker)


# ---------------------------------------------------------------------------
# Workers — keep them at module scope so they're easy to test/import
# ---------------------------------------------------------------------------


class _SpawnWorker(QThread):
    """Worker that claims resources, clones the target, writes context,
    and (optionally) launches the configured agent process."""

    succeeded = Signal(dict)
    failed = Signal(str, str)

    def __init__(
        self,
        broker: Broker,
        runtime: Runtime,
        registry: ProcessRegistry,
        *,
        agent_id: str,
        target_repo: str,
        branch: str,
        owns_modules: List[str],
        reads_modules: List[str],
        launch_command: tuple,
        reason: str,
        ttl_seconds: int,
        port: Optional[int],
        gpu_slot: Optional[int],
        base_branch: str,
    ):
        super().__init__()
        self._broker = broker
        self._runtime = runtime
        self._registry = registry
        self._agent_id = agent_id
        self._spawn_kwargs = dict(
            target_repo=target_repo,
            branch=branch,
            owns_modules=owns_modules,
            reads_modules=reads_modules,
            reason=reason,
            ttl_seconds=ttl_seconds,
            port=port,
            gpu_slot=gpu_slot,
        )
        self._launch_command = launch_command
        self._base_branch = base_branch

    def run(self) -> None:  # noqa: D401  (Qt convention)
        try:
            claim = self._broker.spawn_claim(
                agent_id=self._agent_id, **self._spawn_kwargs,
            )
        except (ClaimConflict, PoolExhausted) as e:
            self.failed.emit(self._agent_id, f"refused: {e}")
            return

        try:
            layout = self._runtime.setup(claim, base_branch=self._base_branch)
        except WorkspaceError as e:
            # Roll back so the user can retry the same branch.
            self._broker.release(self._agent_id)
            self.failed.emit(self._agent_id, f"workspace setup failed: {e}")
            return

        # Process launch is best-effort: if the configured command
        # isn't on PATH or fails to exec, the workspace still ships
        # and the user can launch manually. Don't poison the spawn.
        if self._launch_command:
            try:
                handle = self._runtime.start(
                    claim, layout, list(self._launch_command),
                )
                self._registry.register(handle)
            except Exception as e:
                logger.warning(
                    "spawn %s: launch failed (%s) — workspace is up, "
                    "no process registered",
                    self._agent_id, e,
                )

        self.succeeded.emit(_claim_dict(claim, self._registry))


class _FinishWorker(QThread):
    """Worker that stops the agent process, pushes the branch, removes
    the workspace, and releases the claim."""

    succeeded = Signal(str, object)
    failed = Signal(str, str)

    def __init__(
        self,
        broker: Broker,
        runtime: Runtime,
        registry: ProcessRegistry,
        *,
        agent_id: str,
        push: bool,
        open_pr: bool,
        pr_title: str,
        pr_body: str,
    ):
        super().__init__()
        self._broker = broker
        self._runtime = runtime
        self._registry = registry
        self._agent_id = agent_id
        self._push = push
        self._open_pr = open_pr
        self._pr_title = pr_title
        self._pr_body = pr_body

    def run(self) -> None:
        claim = self._broker.get(self._agent_id)
        if claim is None:
            self.failed.emit(self._agent_id, "unknown agent")
            return

        # Stop the agent process FIRST — otherwise its file handles
        # inside the clone keep the workspace dir locked on Windows
        # and rmtree fails.
        handle = self._registry.pop(self._agent_id)
        if handle is not None:
            try:
                self._runtime.stop(handle)
            except Exception as e:
                logger.warning(
                    "finish %s: stopping process failed (%s)",
                    self._agent_id, e,
                )

        pr_url: Optional[str] = None
        teardown_failed: Optional[str] = None
        try:
            pr_url = self._runtime.teardown(
                claim,
                push=self._push,
                open_pr=self._open_pr,
                pr_title=self._pr_title,
                pr_body=self._pr_body,
            )
        except WorkspaceError as e:
            teardown_failed = str(e)
        finally:
            self._broker.release(self._agent_id)

        if teardown_failed is not None:
            self.failed.emit(
                self._agent_id, f"teardown failed: {teardown_failed}",
            )
            return

        self.succeeded.emit(self._agent_id, pr_url)
