"""Fleet manifest — atomic registry of active agent claims.

A "claim" is an agent's reservation of a slice of the shared host:
workspace path, target repo + branch, port, GPU slot, and the module
paths it's allowed to edit. The manifest is a SQLite database that
enforces non-overlap on every contention dimension *atomically*, so two
agents racing to claim the same branch can't both succeed.

The manifest knows nothing about how an agent runs (container, worktree,
bare process) or what it does. It only tracks who has claimed what, and
when those claims expire. Pool allocation (pick a free port, pick a
free GPU slot) lives one layer up in :mod:`core.fleet.broker`.

Concurrency model:

* Each write is wrapped in ``BEGIN IMMEDIATE`` so SQLite serializes
  writers across processes. The DB enforces unique partial indexes on
  the simple dimensions (branch, workspace_path, port).
* GPU slot mode (rw vs ro) and module-prefix overlap require Python
  logic; that runs inside the same exclusive transaction so racing
  writers can't slip past.
* A process-local ``RLock`` keeps in-process callers honest; SQLite's
  file lock keeps cross-process callers honest.

Slice 1a deliberately omits agent-id reuse: once an agent ID has been
recorded (active or released), the same ID can't be inserted again.
Spawn a fresh ID instead. Allowing reuse would need a composite primary
key + audit-history migration; not worth it before we have callers.
"""
from __future__ import annotations

import contextlib
import json
import sqlite3
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, List, Optional, Sequence, Tuple

STATUS_ACTIVE = "active"
STATUS_RELEASED = "released"

GPU_MODE_RW = "rw"
GPU_MODE_RO = "ro"


class ClaimConflict(RuntimeError):
    """Raised when a claim overlaps an existing claim on some dimension."""

    def __init__(self, dimension: str, existing_agent_id: str, detail: str = ""):
        self.dimension = dimension
        self.existing_agent_id = existing_agent_id
        super().__init__(
            f"claim conflict on {dimension} with agent '{existing_agent_id}'"
            + (f": {detail}" if detail else "")
        )


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(s: str) -> datetime:
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)


@dataclass
class Claim:
    """One reservation of fleet resources by one agent."""

    agent_id: str
    target_repo: str
    branch: str
    workspace_path: str
    owns_modules: List[str] = field(default_factory=list)
    reads_modules: List[str] = field(default_factory=list)
    port: Optional[int] = None
    gpu_slot: Optional[int] = None
    gpu_mode: str = GPU_MODE_RW
    status: str = STATUS_ACTIVE
    reason: str = ""
    started_at: str = field(default_factory=_utcnow_iso)
    last_heartbeat: str = field(default_factory=_utcnow_iso)
    ttl_seconds: int = 3600

    def is_stale(self, now: Optional[datetime] = None) -> bool:
        now = now or datetime.now(timezone.utc)
        deadline = _parse_iso(self.last_heartbeat).timestamp() + self.ttl_seconds
        return now.timestamp() > deadline


def _normalize_module_pattern(p: str) -> str:
    """Reduce a glob to a directory prefix for prefix-overlap checks.

    Strips trailing ``/**`` or ``/*`` and ensures a trailing slash so
    that ``src/billing/`` does not appear to be a prefix of
    ``src/billings/``.
    """
    s = p.replace("\\", "/").rstrip("/")
    for suffix in ("/**", "/*"):
        if s.endswith(suffix):
            s = s[: -len(suffix)]
    return s.rstrip("/") + "/"


def _modules_overlap(
    a: Sequence[str], b: Sequence[str]
) -> Optional[Tuple[str, str]]:
    """Return the first overlapping pair, or None.

    Conservative prefix-based check. Whole-module ownership (``src/x/**``)
    is the common case and is handled correctly. Cross-pattern globs
    like ``src/*/util.py`` are not analyzed precisely; teams writing
    those should accept conservative refusal rather than silent overlap.
    """
    norm_a = [_normalize_module_pattern(x) for x in a]
    norm_b = [_normalize_module_pattern(x) for x in b]
    for pa, na in zip(a, norm_a):
        for pb, nb in zip(b, norm_b):
            if na.startswith(nb) or nb.startswith(na):
                return (pa, pb)
    return None


_SCHEMA = """
CREATE TABLE IF NOT EXISTS claims (
    agent_id        TEXT PRIMARY KEY,
    target_repo     TEXT NOT NULL,
    branch          TEXT NOT NULL,
    workspace_path  TEXT NOT NULL,
    port            INTEGER,
    gpu_slot        INTEGER,
    gpu_mode        TEXT NOT NULL DEFAULT 'rw',
    owns_modules    TEXT NOT NULL,
    reads_modules   TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active',
    reason          TEXT NOT NULL DEFAULT '',
    started_at      TEXT NOT NULL,
    last_heartbeat  TEXT NOT NULL,
    ttl_seconds     INTEGER NOT NULL DEFAULT 3600
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_claims_branch_active
    ON claims(target_repo, branch) WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS uq_claims_workspace_active
    ON claims(workspace_path) WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS uq_claims_port_active
    ON claims(port) WHERE status = 'active' AND port IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_claims_status ON claims(status);
"""


class Manifest:
    """SQLite-backed registry of agent claims.

    Thread-safe within a process; safe across processes via SQLite's
    file lock and the unique partial indexes on the underlying table.
    """

    def __init__(self, db_path: Path | str):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn: Optional[sqlite3.Connection] = None

    # -- lifecycle ----------------------------------------------------------

    def __enter__(self) -> "Manifest":
        self.open()
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def open(self) -> None:
        if self._conn is None:
            self._conn = sqlite3.connect(
                str(self.db_path),
                isolation_level=None,
                check_same_thread=False,
                timeout=10.0,
            )
            self._conn.row_factory = sqlite3.Row
            self._conn.execute("PRAGMA journal_mode = WAL;")
            self._conn.execute("PRAGMA foreign_keys = ON;")
            self._conn.executescript(_SCHEMA)

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    @property
    def conn(self) -> sqlite3.Connection:
        if self._conn is None:
            self.open()
        assert self._conn is not None
        return self._conn

    # -- transactions -------------------------------------------------------

    @contextlib.contextmanager
    def _exclusive(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE;")
            try:
                yield self.conn
            except BaseException:
                self.conn.execute("ROLLBACK;")
                raise
            else:
                self.conn.execute("COMMIT;")

    # -- public API ---------------------------------------------------------

    def claim(self, claim: Claim) -> Claim:
        """Insert ``claim`` atomically; raise on overlap."""
        with self._exclusive() as conn:
            existing_any = conn.execute(
                "SELECT agent_id, status FROM claims WHERE agent_id = ?",
                (claim.agent_id,),
            ).fetchone()
            if existing_any is not None:
                raise ClaimConflict(
                    "agent_id", claim.agent_id,
                    f"agent '{claim.agent_id}' already exists "
                    f"(status={existing_any['status']}); pick a fresh id",
                )

            actives = [
                self._row_to_claim(r)
                for r in conn.execute(
                    "SELECT * FROM claims WHERE status = ?", (STATUS_ACTIVE,)
                )
            ]
            self._refuse_overlap(claim, actives)

            try:
                conn.execute(
                    """
                    INSERT INTO claims (
                        agent_id, target_repo, branch, workspace_path,
                        port, gpu_slot, gpu_mode,
                        owns_modules, reads_modules,
                        status, reason, started_at, last_heartbeat, ttl_seconds
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        claim.agent_id, claim.target_repo, claim.branch,
                        claim.workspace_path,
                        claim.port, claim.gpu_slot, claim.gpu_mode,
                        json.dumps(claim.owns_modules),
                        json.dumps(claim.reads_modules),
                        claim.status, claim.reason,
                        claim.started_at, claim.last_heartbeat, claim.ttl_seconds,
                    ),
                )
            except sqlite3.IntegrityError as e:
                # Defensive: app-level checks above catch every case in
                # single-writer flows. If the DB still rejects, a
                # concurrent writer slipped in between our read and the
                # INSERT; surface a structured conflict so the caller
                # can retry. We don't try to identify the dimension
                # here — SQLite's message format varies across versions.
                raise ClaimConflict("concurrent", "<unknown>", str(e)) from e
        return claim

    def release(self, agent_id: str) -> bool:
        """Mark a claim released. Returns True if a row was updated."""
        with self._exclusive() as conn:
            cur = conn.execute(
                "UPDATE claims SET status = ? "
                "WHERE agent_id = ? AND status = ?",
                (STATUS_RELEASED, agent_id, STATUS_ACTIVE),
            )
            return cur.rowcount > 0

    def heartbeat(self, agent_id: str) -> bool:
        """Refresh ``last_heartbeat``. Returns True if the agent was active."""
        with self._exclusive() as conn:
            cur = conn.execute(
                "UPDATE claims SET last_heartbeat = ? "
                "WHERE agent_id = ? AND status = ?",
                (_utcnow_iso(), agent_id, STATUS_ACTIVE),
            )
            return cur.rowcount > 0

    def get(self, agent_id: str) -> Optional[Claim]:
        with self._lock:
            row = self.conn.execute(
                "SELECT * FROM claims WHERE agent_id = ?", (agent_id,)
            ).fetchone()
            return self._row_to_claim(row) if row else None

    def list_active(self) -> List[Claim]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT * FROM claims WHERE status = ? ORDER BY started_at",
                (STATUS_ACTIVE,),
            ).fetchall()
            return [self._row_to_claim(r) for r in rows]

    def reap_stale(self, now: Optional[datetime] = None) -> List[Claim]:
        """Mark every active claim past its TTL as released.

        Returns the list of reaped claims (with status updated to
        ``released``) so callers can run cleanup hooks per agent.
        """
        now = now or datetime.now(timezone.utc)
        reaped: List[Claim] = []
        with self._exclusive() as conn:
            actives = [
                self._row_to_claim(r)
                for r in conn.execute(
                    "SELECT * FROM claims WHERE status = ?", (STATUS_ACTIVE,)
                )
            ]
            for c in actives:
                if c.is_stale(now):
                    conn.execute(
                        "UPDATE claims SET status = ? WHERE agent_id = ?",
                        (STATUS_RELEASED, c.agent_id),
                    )
                    c.status = STATUS_RELEASED
                    reaped.append(c)
        return reaped

    # -- internals ----------------------------------------------------------

    def _refuse_overlap(self, claim: Claim, actives: Sequence[Claim]) -> None:
        for existing in actives:
            if (existing.target_repo == claim.target_repo
                    and existing.branch == claim.branch):
                raise ClaimConflict(
                    "branch", existing.agent_id,
                    f"{claim.target_repo}@{claim.branch}",
                )
            if existing.workspace_path == claim.workspace_path:
                raise ClaimConflict(
                    "workspace_path", existing.agent_id, claim.workspace_path,
                )
            if claim.port is not None and existing.port == claim.port:
                raise ClaimConflict(
                    "port", existing.agent_id, str(claim.port),
                )
            if (claim.gpu_slot is not None
                    and existing.gpu_slot == claim.gpu_slot
                    and (existing.gpu_mode == GPU_MODE_RW
                         or claim.gpu_mode == GPU_MODE_RW)):
                raise ClaimConflict(
                    "gpu_slot", existing.agent_id,
                    f"slot {claim.gpu_slot} held {existing.gpu_mode} "
                    f"by {existing.agent_id}",
                )
            overlap = _modules_overlap(claim.owns_modules, existing.owns_modules)
            if overlap is not None:
                raise ClaimConflict(
                    "owns_modules", existing.agent_id,
                    f"'{overlap[0]}' overlaps existing '{overlap[1]}'",
                )

    @staticmethod
    def _row_to_claim(row: sqlite3.Row) -> Claim:
        return Claim(
            agent_id=row["agent_id"],
            target_repo=row["target_repo"],
            branch=row["branch"],
            workspace_path=row["workspace_path"],
            owns_modules=json.loads(row["owns_modules"] or "[]"),
            reads_modules=json.loads(row["reads_modules"] or "[]"),
            port=row["port"],
            gpu_slot=row["gpu_slot"],
            gpu_mode=row["gpu_mode"],
            status=row["status"],
            reason=row["reason"],
            started_at=row["started_at"],
            last_heartbeat=row["last_heartbeat"],
            ttl_seconds=row["ttl_seconds"],
        )
