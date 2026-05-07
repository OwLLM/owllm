"""Agent-process tracking for the fleet.

Slice 3b added *process supervision* (launching the configured CLI
inside an agent's workspace, capturing its log, tracking lifecycle).
Slice 3c-b adds *cross-process discovery*: a record on disk per
running agent so a different fleet client (CLI, second UI window,
ops script) can see what's running and who launched it.

This module defines:

* :class:`ProcessHandle` — one running (or just-exited) agent
  process. Wraps a :class:`subprocess.Popen` (when the local process
  launched it) plus the file handle its combined stdout+stderr
  streams to. Handles reconstructed from disk have ``_popen=None``;
  ``is_running`` falls back to a signal-0 probe in that case.
* :class:`ProcessRegistry` — disk-backed map of ``agent_id`` → handle.
  Local-launched processes are cached in memory so the runtime can
  ``terminate``/``kill`` precisely; cross-process processes are
  rehydrated from JSON records on demand.

The launch / terminate logic lives on :class:`core.fleet.runtime.Runtime`
implementations. The Registry just holds handles, so swapping the
runtime doesn't change anything here.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import IO, Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class ProcessHandle:
    """One running (or just-exited) agent process.

    Constructed by :meth:`Runtime.start`. Mutated only when the
    process completes (the runtime updates ``exited_at`` after a
    successful ``stop`` or after polling detects exit). The
    :class:`subprocess.Popen` and log file handle are private — only
    the runtime that created them should touch those.

    ``metadata`` is a free-form dict runtimes use to stash backend-
    specific state. ``WorktreeRuntime`` doesn't write here;
    ``ContainerRuntime`` stores ``container_name`` so ``stop`` can
    issue ``docker stop`` against the right container.
    """

    agent_id: str
    pid: int
    argv: Tuple[str, ...]
    log_path: Path
    started_at: str = field(default_factory=_utcnow_iso)
    exited_at: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    _popen: Any = None  # subprocess.Popen — private to the runtime
    _log_handle: Optional[IO] = None  # file handle, closed on stop

    def is_running(self) -> bool:
        """True if the process hasn't exited yet.

        Always polls when a Popen is held; falls back to ``os.kill(pid, 0)``
        for handles reconstructed from disk (cross-process scenarios in
        future slices). Returns False on any error so a misbehaving
        check doesn't keep a card on "running" forever.
        """
        if self._popen is not None:
            return self._popen.poll() is None
        # No Popen — best-effort signal-0 probe so future cross-process
        # supervision can still report status.
        try:
            os.kill(self.pid, 0)
            return True
        except (ProcessLookupError, PermissionError):
            return False
        except OSError:
            return False

    def returncode(self) -> Optional[int]:
        if self._popen is None:
            return None
        return self._popen.returncode  # None while running

    def mark_exited(self) -> None:
        """Record the exit timestamp once :meth:`is_running` returns False.

        Idempotent — calling twice doesn't move the timestamp.
        """
        if self.exited_at is None and not self.is_running():
            self.exited_at = _utcnow_iso()

    def close_log(self) -> None:
        """Close the captured log file handle (if any). Idempotent."""
        if self._log_handle is not None:
            try:
                self._log_handle.close()
            except Exception:
                logger.warning(
                    "could not close log handle for %s", self.agent_id,
                    exc_info=True,
                )
            self._log_handle = None

    def to_dict(self) -> Dict[str, Any]:
        """Serialisable view, suitable for Qt signals + JSON."""
        # Refresh exited_at lazily — the dict view should reflect
        # reality at read time, not whenever the field was last set.
        self.mark_exited()
        return {
            "agent_id": self.agent_id,
            "pid": self.pid,
            "argv": list(self.argv),
            "log_path": str(self.log_path),
            "started_at": self.started_at,
            "exited_at": self.exited_at,
            "is_running": self.is_running(),
            "returncode": self.returncode(),
            "metadata": dict(self.metadata),
        }


class ProcessRegistry:
    """Disk-backed registry of running agent processes.

    Two layers:

    * **In-memory cache** (``self._owned``) — handles for processes
      THIS process launched. Holds the live :class:`subprocess.Popen`
      so :meth:`Runtime.stop` can ``terminate``/``kill`` precisely.
    * **Persistent index** (``<root_dir>/<agent_id>.json``) — one
      JSON record per running agent, written on :meth:`register`,
      removed on :meth:`pop`. Other fleet clients (a second UI
      window, the CLI, ops scripts) discover live agents by reading
      these files; their handles come back with ``_popen=None`` and
      use a signal-0 probe to track liveness.

    :meth:`refresh_status` walks the disk index and culls records
    for pids that no longer exist — a crashed launcher leaks at most
    one stale JSON file until the next refresh.

    Thread-safe via an internal RLock; SQLite-style multi-process
    races are not protected (two processes registering the same
    agent_id in the same millisecond can clobber each other's JSON),
    but the manifest's branch/workspace overlap check upstream
    prevents the same agent_id from being claimed twice.
    """

    def __init__(self, root_dir: Path | str) -> None:
        self._root = Path(root_dir)
        self._root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._owned: Dict[str, ProcessHandle] = {}

    @property
    def root_dir(self) -> Path:
        return self._root

    def register(self, handle: ProcessHandle) -> None:
        with self._lock:
            existing = self._owned.get(handle.agent_id)
            if existing is not None and existing.is_running():
                raise RuntimeError(
                    f"process for {handle.agent_id} is already registered "
                    f"(pid {existing.pid})"
                )
            self._owned[handle.agent_id] = handle
            self._write_record(handle)

    def get(self, agent_id: str) -> Optional[ProcessHandle]:
        with self._lock:
            # Prefer the in-memory handle — only it has the Popen.
            if agent_id in self._owned:
                return self._owned[agent_id]
            return self._read_record(agent_id)

    def pop(self, agent_id: str) -> Optional[ProcessHandle]:
        with self._lock:
            handle = self._owned.pop(agent_id, None)
            if handle is None:
                handle = self._read_record(agent_id)
            self._delete_record(agent_id)
            return handle

    def list(self) -> List[ProcessHandle]:
        with self._lock:
            out: List[ProcessHandle] = []
            seen: set[str] = set()
            for h in self._owned.values():
                out.append(h)
                seen.add(h.agent_id)
            for path in sorted(self._root.glob("*.json")):
                aid = path.stem
                if aid in seen:
                    continue
                h = self._read_record(aid)
                if h is not None:
                    out.append(h)
            return out

    def refresh_status(self) -> None:
        """Mark exited handles + remove disk records for dead pids."""
        with self._lock:
            for handle in self._owned.values():
                handle.mark_exited()
            # Cross-process records: validate liveness by signal-0,
            # cull when the pid is gone. Local-owned handles manage
            # their own JSON via register/pop; we don't touch theirs.
            for path in list(self._root.glob("*.json")):
                aid = path.stem
                if aid in self._owned:
                    continue
                handle = self._read_record(aid)
                if handle is None or not handle.is_running():
                    self._delete_record(aid)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _path_for(self, agent_id: str) -> Path:
        # Defensive: agent_ids are typically uuid-suffixed but may be
        # user-supplied; sanitise for the filesystem.
        safe = "".join(
            c if (c.isalnum() or c in "-_") else "_" for c in agent_id
        )
        return self._root / f"{safe}.json"

    def _write_record(self, handle: ProcessHandle) -> None:
        path = self._path_for(handle.agent_id)
        data = {
            "agent_id": handle.agent_id,
            "pid": handle.pid,
            "argv": list(handle.argv),
            "log_path": str(handle.log_path),
            "started_at": handle.started_at,
            "metadata": dict(handle.metadata),
        }
        try:
            path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        except OSError as e:
            logger.warning(
                "could not write process record for %s: %s",
                handle.agent_id, e,
            )

    def _read_record(self, agent_id: str) -> Optional[ProcessHandle]:
        path = self._path_for(agent_id)
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            logger.warning(
                "could not read process record %s: %s", path.name, e,
            )
            return None
        try:
            return ProcessHandle(
                agent_id=str(data["agent_id"]),
                pid=int(data["pid"]),
                argv=tuple(str(x) for x in data.get("argv", []) or []),
                log_path=Path(str(data.get("log_path", ""))),
                started_at=str(data.get("started_at", "")),
                metadata=dict(data.get("metadata") or {}),
            )
        except (KeyError, ValueError, TypeError) as e:
            logger.warning(
                "process record %s is malformed: %s", path.name, e,
            )
            return None

    def _delete_record(self, agent_id: str) -> None:
        path = self._path_for(agent_id)
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        except OSError as e:
            logger.warning(
                "could not remove process record %s: %s", path.name, e,
            )
