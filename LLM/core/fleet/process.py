"""Agent-process tracking for the fleet.

Slice 3b adds *process supervision* on top of the workspace
provisioning slice 1b shipped: when an agent has a ``launch_command``
configured, the fleet starts that argv inside the workspace, captures
its output, and tracks the running process so the UI can show
running/exited state and the user can kill it on finish.

This module defines:

* :class:`ProcessHandle` — one running (or just-exited) agent
  process. Wraps a :class:`subprocess.Popen` and the file handle the
  process's combined stdout+stderr streams to.
* :class:`ProcessRegistry` — thread-safe in-memory map of
  ``agent_id`` → handle. The :class:`FleetService` instantiates one
  for the UI process; cross-process supervision (so a CLI-launched
  agent shows up in the UI) is a future slice.

The actual launch / terminate logic lives on :class:`core.fleet.runtime.Runtime`
implementations — :class:`WorktreeRuntime` uses ``subprocess.Popen``;
a future ``ContainerRuntime`` will use ``docker run``. The Registry
just holds handles, so swapping the runtime doesn't change anything
here.
"""
from __future__ import annotations

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
    """

    agent_id: str
    pid: int
    argv: Tuple[str, ...]
    log_path: Path
    started_at: str = field(default_factory=_utcnow_iso)
    exited_at: Optional[str] = None
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
        }


class ProcessRegistry:
    """Thread-safe in-memory registry of running agent processes.

    The :class:`FleetService` instantiates one and shares it with its
    spawn / finish workers. The lock serialises mutations; reads can
    safely happen from any thread because :class:`ProcessHandle`
    queries are themselves safe (``Popen.poll`` and ``os.kill(pid, 0)``
    are documented thread-safe).
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._handles: Dict[str, ProcessHandle] = {}

    def register(self, handle: ProcessHandle) -> None:
        with self._lock:
            existing = self._handles.get(handle.agent_id)
            if existing is not None and existing.is_running():
                # Defensive: the spawn worker should never register
                # twice for the same agent. If it does, leak-free
                # behaviour is to keep the older handle and refuse.
                raise RuntimeError(
                    f"process for {handle.agent_id} is already registered "
                    f"(pid {existing.pid})"
                )
            self._handles[handle.agent_id] = handle

    def get(self, agent_id: str) -> Optional[ProcessHandle]:
        with self._lock:
            return self._handles.get(agent_id)

    def pop(self, agent_id: str) -> Optional[ProcessHandle]:
        with self._lock:
            return self._handles.pop(agent_id, None)

    def list(self) -> List[ProcessHandle]:
        with self._lock:
            return list(self._handles.values())

    def refresh_status(self) -> None:
        """Mark exited any handles whose process is no longer alive.

        Doesn't remove them — the UI wants to see "exited(N)" cards
        until the user finishes the agent. :meth:`pop` is the only
        path that actually deletes a registration.
        """
        with self._lock:
            for handle in self._handles.values():
                handle.mark_exited()
