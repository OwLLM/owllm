"""Output registry — versioned addresses for agent deliverables.

The architectural conversation that produced the fleet identified
this as the answer to "agent A produces a library, agent B
consumes it." Instead of agent B guessing a filesystem path
(``../alphaoutput/dist``), agent A *publishes* an artifact under a
stable name + version, and agent B *consumes* it via that address.

Slice 4-b ships the registry layer. Publishing is API-driven (the
:class:`OutputRegistry` class) and surfaced in a read-only dialog
on the Fleet page; an in-UI "Publish" affordance can come later
once we know what kinds of artifacts agents actually produce.

Storage: SQLite at ``<fleet_root>/outputs/registry.sqlite`` with a
single ``artifacts`` table. Same pattern the manifest uses, same
WAL + BEGIN IMMEDIATE concurrency model.
"""
from __future__ import annotations

import contextlib
import json
import logging
import sqlite3
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

logger = logging.getLogger(__name__)


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


KIND_GENERIC = "generic"
KIND_LIBRARY = "library"
KIND_DATASET = "dataset"
KIND_REPORT = "report"
KIND_BUILD = "build"


class ArtifactConflict(RuntimeError):
    """Raised when ``publish`` would collide with an existing
    ``(name, version)`` row."""


@dataclass
class Artifact:
    name: str
    version: str
    publisher_agent_id: str
    path: str
    kind: str = KIND_GENERIC
    metadata: Dict[str, Any] = field(default_factory=dict)
    published_at: str = field(default_factory=_utcnow_iso)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "version": self.version,
            "publisher_agent_id": self.publisher_agent_id,
            "path": self.path,
            "kind": self.kind,
            "metadata": dict(self.metadata),
            "published_at": self.published_at,
        }


_SCHEMA = """
CREATE TABLE IF NOT EXISTS artifacts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    name                TEXT NOT NULL,
    version             TEXT NOT NULL,
    publisher_agent_id  TEXT NOT NULL,
    path                TEXT NOT NULL,
    kind                TEXT NOT NULL DEFAULT 'generic',
    metadata_json       TEXT NOT NULL DEFAULT '{}',
    published_at        TEXT NOT NULL,
    UNIQUE(name, version)
);
CREATE INDEX IF NOT EXISTS ix_artifacts_name ON artifacts(name);
CREATE INDEX IF NOT EXISTS ix_artifacts_publisher
    ON artifacts(publisher_agent_id);
"""


class OutputRegistry:
    """SQLite-backed registry of agent-published artifacts."""

    def __init__(self, db_path: Path | str):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn: Optional[sqlite3.Connection] = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def __enter__(self) -> "OutputRegistry":
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

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def publish(self, artifact: Artifact) -> Artifact:
        """Insert ``artifact``; raise :class:`ArtifactConflict` on
        ``(name, version)`` collision."""
        if not artifact.name.strip():
            raise ValueError("artifact name is required")
        if not artifact.version.strip():
            raise ValueError("artifact version is required")
        with self._exclusive() as conn:
            try:
                conn.execute(
                    """
                    INSERT INTO artifacts (
                        name, version, publisher_agent_id, path, kind,
                        metadata_json, published_at
                    ) VALUES (?,?,?,?,?,?,?)
                    """,
                    (
                        artifact.name, artifact.version,
                        artifact.publisher_agent_id, artifact.path,
                        artifact.kind,
                        json.dumps(artifact.metadata),
                        artifact.published_at,
                    ),
                )
            except sqlite3.IntegrityError as e:
                raise ArtifactConflict(
                    f"{artifact.name}@{artifact.version} already published"
                ) from e
        return artifact

    def get(
        self, name: str, version: Optional[str] = None,
    ) -> Optional[Artifact]:
        """Return the artifact at ``(name, version)``; ``version=None``
        means "latest by published_at"."""
        with self._lock:
            if version is not None:
                row = self.conn.execute(
                    "SELECT * FROM artifacts WHERE name = ? AND version = ?",
                    (name, version),
                ).fetchone()
            else:
                row = self.conn.execute(
                    "SELECT * FROM artifacts WHERE name = ? "
                    "ORDER BY published_at DESC, id DESC LIMIT 1",
                    (name,),
                ).fetchone()
            return _row_to_artifact(row) if row else None

    def list_versions(self, name: str) -> List[Artifact]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT * FROM artifacts WHERE name = ? "
                "ORDER BY published_at DESC, id DESC",
                (name,),
            ).fetchall()
            return [_row_to_artifact(r) for r in rows]

    def list_all(self) -> List[Artifact]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT * FROM artifacts "
                "ORDER BY published_at DESC, id DESC"
            ).fetchall()
            return [_row_to_artifact(r) for r in rows]

    def list_by_publisher(self, agent_id: str) -> List[Artifact]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT * FROM artifacts WHERE publisher_agent_id = ? "
                "ORDER BY published_at DESC, id DESC",
                (agent_id,),
            ).fetchall()
            return [_row_to_artifact(r) for r in rows]

    def delete(self, name: str, version: str) -> bool:
        """Remove an artifact record. Does NOT touch the bytes at
        ``artifact.path`` — the registry only owns the index."""
        with self._exclusive() as conn:
            cur = conn.execute(
                "DELETE FROM artifacts WHERE name = ? AND version = ?",
                (name, version),
            )
            return cur.rowcount > 0


def _row_to_artifact(row: sqlite3.Row) -> Artifact:
    return Artifact(
        name=row["name"],
        version=row["version"],
        publisher_agent_id=row["publisher_agent_id"],
        path=row["path"],
        kind=row["kind"],
        metadata=json.loads(row["metadata_json"] or "{}"),
        published_at=row["published_at"],
    )
