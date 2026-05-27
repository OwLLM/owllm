"""Persistent cross-session memory for the agents-tab team.

Today's situation: every team Run starts cold. The orchestrator's chat
history survives within one team-instance, but nothing crosses goals
or app restarts. Hermes Agent's standout feature is a memory layer that
*does* persist — the agent gets smarter the longer you use it. This
module ships the equivalent for OWLLM.

Storage
=======

SQLite at ``LLM/data/agent_memory.sqlite`` with an FTS5 virtual table
for keyword recall. One row per remembered fact, scoped by ``project_id``
so memories from different projects can't bleed into each other.

Schema (forward-only — no destructive migrations)::

    memories(
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'note',   -- note | completed_goal | skill
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
    )
    memories_fts USING fts5(body, content='memories', content_rowid='id')

Public API
==========

* :class:`Memory` — read-only row dataclass.
* :class:`MemoryStore` — thread-safe store with ``remember``,
  ``recall`` (FTS), ``list_recent``, ``get``.
* :func:`get_memory_store` — process-wide singleton.

Recall ranking is FTS5's BM25 by default — good enough for short factual
notes; we can swap in semantic embeddings later without changing the
public API.
"""
from __future__ import annotations

import logging
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

logger = logging.getLogger(__name__)


KIND_NOTE = "note"
KIND_COMPLETED_GOAL = "completed_goal"
KIND_SKILL = "skill"
"""Free-form ``kind`` values an agent or the team runner can pass to
:meth:`MemoryStore.remember`. We don't enforce a closed enum so future
kinds (preference, decision, alert, …) don't need a migration."""


@dataclass(frozen=True)
class Memory:
    id: int
    project_id: int
    kind: str
    body: str
    created_at: str
    last_used_at: Optional[str]


_SCHEMA = """
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'note',
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(project_id, kind);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    body,
    content='memories',
    content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, body) VALUES (new.id, new.body);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, body)
        VALUES('delete', old.id, old.body);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, body)
        VALUES('delete', old.id, old.body);
    INSERT INTO memories_fts(rowid, body) VALUES (new.id, new.body);
END;
"""


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class MemoryStore:
    """SQLite + FTS5 backed memory store. Thread-safe via a single lock —
    OWLLM's agent worker threads can each call ``remember``/``recall``
    without coordination."""

    def __init__(self, db_path: Path) -> None:
        self._db_path = Path(db_path)
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        with self._connect() as conn:
            conn.executescript(_SCHEMA)
            conn.commit()

    def _connect(self) -> sqlite3.Connection:
        # check_same_thread=False is safe because every access is
        # serialised by self._lock.
        conn = sqlite3.connect(self._db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    # -- write ----------------------------------------------------------

    def remember(
        self,
        project_id: int,
        body: str,
        *,
        kind: str = KIND_NOTE,
    ) -> int:
        """Store a memory. Returns the new row id.

        Empty bodies are silently dropped (returning 0) — agents
        sometimes call ``remember("")`` when summarisation produces no
        signal, and we'd rather no-op than pollute the store."""
        body = (body or "").strip()
        if not body:
            return 0
        now = _utcnow_iso()
        with self._lock, self._connect() as conn:
            cur = conn.execute(
                "INSERT INTO memories (project_id, kind, body, created_at) "
                "VALUES (?, ?, ?, ?)",
                (int(project_id), kind, body, now),
            )
            conn.commit()
            return int(cur.lastrowid)

    # -- read -----------------------------------------------------------

    def recall(
        self,
        project_id: int,
        query: str,
        *,
        limit: int = 5,
    ) -> List[Memory]:
        """FTS5 BM25-ranked recall. Returns up to ``limit`` matches.

        Touches ``last_used_at`` on each hit so future "what's been
        useful?" telemetry can rank by recency-of-use rather than
        creation date."""
        query = (query or "").strip()
        if not query:
            return []
        # Quote each whitespace-separated token individually rather than
        # the whole query. FTS5 treats space-joined quoted tokens as an
        # implicit AND, so "uv build tool" matches a body containing all
        # three words in any order. Wrapping the *whole* phrase in one
        # set of quotes would force an exact-phrase match — too strict
        # for typical agent recall usage. Doubling embedded quotes is
        # the FTS5 escape for a literal quote inside a quoted token.
        tokens = [t for t in query.split() if t]
        if not tokens:
            return []
        safe = " ".join(
            '"' + t.replace('"', '""') + '"' for t in tokens
        )
        rows: List[sqlite3.Row]
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT m.* FROM memories m "
                "JOIN memories_fts f ON f.rowid = m.id "
                "WHERE f.body MATCH ? AND m.project_id = ? "
                "ORDER BY bm25(memories_fts) ASC "
                "LIMIT ?",
                (safe, int(project_id), int(limit)),
            ).fetchall()
            now = _utcnow_iso()
            ids = [r["id"] for r in rows]
            if ids:
                placeholders = ",".join("?" * len(ids))
                conn.execute(
                    f"UPDATE memories SET last_used_at = ? "
                    f"WHERE id IN ({placeholders})",
                    [now, *ids],
                )
                conn.commit()
        return [_row_to_memory(r) for r in rows]

    def list_recent(
        self,
        project_id: int,
        *,
        limit: int = 10,
    ) -> List[Memory]:
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM memories WHERE project_id = ? "
                "ORDER BY id DESC LIMIT ?",
                (int(project_id), int(limit)),
            ).fetchall()
        return [_row_to_memory(r) for r in rows]

    def get(self, memory_id: int) -> Optional[Memory]:
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM memories WHERE id = ?",
                (int(memory_id),),
            ).fetchone()
        return _row_to_memory(row) if row else None

    def count(self, project_id: int) -> int:
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM memories WHERE project_id = ?",
                (int(project_id),),
            ).fetchone()
        return int(row["n"]) if row else 0


def _row_to_memory(row: sqlite3.Row) -> Memory:
    return Memory(
        id=int(row["id"]),
        project_id=int(row["project_id"]),
        kind=str(row["kind"]),
        body=str(row["body"]),
        created_at=str(row["created_at"]),
        last_used_at=row["last_used_at"],
    )


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------


_store: Optional[MemoryStore] = None
_store_lock = threading.Lock()


def get_memory_store(db_path: Optional[Path] = None) -> MemoryStore:
    """Return the process-wide MemoryStore."""
    global _store
    with _store_lock:
        if _store is None:
            if db_path is None:
                llm_root = Path(__file__).resolve().parent.parent.parent
                db_path = llm_root / "data" / "agent_memory.sqlite"
            _store = MemoryStore(db_path)
        return _store
