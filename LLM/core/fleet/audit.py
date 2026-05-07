"""Append-only audit log of fleet actions.

JSONL at ``<fleet_root>/audit.log.jsonl`` — one event per line. Format::

    {"ts": "2026-05-07T...", "event": "spawn", "agent_id": "agent-a1b2c3d4",
     "branch": "agent/billing", "target_repo": "..."}

Append-only and ordered by write time. Easy to tail, grep, parse, or
ship to a log aggregator. Not designed for high-volume queries — the
History dialog reads the last N lines for browsing; richer analytics
would migrate to a SQLite table (the manifest db is the obvious
home), but that's premature today.

Concurrency: file ``open(..., "a")`` is atomic for ``write()`` calls
on POSIX *and* Windows when the line fits in one OS buffer (which
ours always do — JSON event records are well under 4KB). The
in-process lock prevents Python-level interleaving when two threads
write the same call.
"""
from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

logger = logging.getLogger(__name__)


# Canonical event names — keep this list short and stable; the
# History UI groups / colours by event type.
EVENT_SPAWN = "spawn"
EVENT_SPAWN_FAILED = "spawn_failed"
EVENT_FINISH = "finish"
EVENT_FINISH_FAILED = "finish_failed"
EVENT_HEARTBEAT = "heartbeat"
EVENT_REAP = "reap"
EVENT_PROCESS_START = "process_start"
EVENT_PROCESS_START_FAILED = "process_start_failed"
EVENT_PROCESS_STOP = "process_stop"


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class AuditLog:
    """Append-only JSONL log."""

    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def log(
        self, event: str, *, agent_id: str = "", **details: Any,
    ) -> None:
        """Append one event. Never raises — audit failures must not
        bring down the action they're trying to record."""
        record: Dict[str, Any] = {
            "ts": _utcnow_iso(),
            "event": event,
            "agent_id": agent_id,
        }
        record.update(details)
        try:
            line = json.dumps(record, default=str) + "\n"
        except Exception as e:
            # Broad except: audit must NEVER raise into the caller.
            # ``default=str`` falls back to str(obj) for non-serialisable
            # values, which can raise anything if a custom __repr__/
            # __str__ misbehaves.
            logger.warning("audit serialise failed (%s)", e)
            return
        try:
            with self._lock:
                with self.path.open("a", encoding="utf-8") as f:
                    f.write(line)
        except OSError as e:
            logger.warning("audit write failed (%s): %s", self.path, e)

    def tail(self, n: int = 200) -> List[Dict[str, Any]]:
        """Return the last ``n`` events, oldest-first.

        Reads the whole file — fine up to ~10 MB; if the log grows
        bigger, swap in a reverse-byte-walk. Bad lines are skipped
        silently so a single corruption doesn't blank the dialog.
        """
        if not self.path.exists():
            return []
        try:
            with self.path.open("r", encoding="utf-8") as f:
                lines = f.readlines()
        except OSError as e:
            logger.warning("audit read failed: %s", e)
            return []
        out: List[Dict[str, Any]] = []
        for line in lines[-n:]:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return out

    def iter_all(self) -> Iterator[Dict[str, Any]]:
        """Stream every event in chronological order."""
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        yield json.loads(line)
                    except json.JSONDecodeError:
                        continue
        except OSError as e:
            logger.warning("audit stream failed: %s", e)
            return
