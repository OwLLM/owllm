"""Projects — long-lived workspaces that bind a team to a goal stream.

A :class:`Project` holds:

* a name + description (user-facing)
* a team list — names of :class:`AgentDefinition` s that participate
* a per-agent model override map — so the user can pin different models
  per project without affecting the agent's default in the Studio
* timestamps + an id

Goals + messages tie back to a project via the existing ``goal_id`` model;
we add a ``project_id`` column to ``agent_goals`` so the Workspace page
can replay only this project's transcripts when switching projects.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Project
# ---------------------------------------------------------------------------


def _new_id() -> str:
    return uuid.uuid4().hex


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class Project:
    name: str
    description: str = ""
    location: str = ""
    """Free-form location label — folder path, server, project URL, etc.
    Surfaces next to the project name in the agents tab so the user knows
    *where* this project lives. Pure metadata; the runtime doesn't act on
    it. Examples: '/home/me/code/my-app', 'web01.prod', 'github.com/me/x'."""
    trust_writes: bool = False
    """When True and ``location`` is a real folder, on Run we materialize
    a scoped allow rule into ``<location>/.claude/settings.local.json`` so
    the Claude CLI inside the team won't prompt for every Write/Edit. Off
    by default — explicit consent only."""
    workdir_hint_sent_for: str = ""
    """The Location for which the working-directory hint has already been
    prepended to a goal. Persisted so the hint fires only the FIRST time
    a project is run against a given Location, not on every restart /
    team rebuild. Reset implicitly when the user picks a different
    Location (the equality check below fails)."""
    auto_approve_all: bool = False
    """When True, the agents page registers a wildcard auto-approve rule
    on the team's ApprovalGate so every tool request resolves APPROVE
    without surfacing to the user. Per-project, off by default —
    explicit consent only. Surfaced via the SupervisorCard checkbox."""
    team: List[str] = field(default_factory=list)
    """Ordered list of agent definition names on this project's team."""
    model_overrides: Dict[str, str] = field(default_factory=dict)
    """``agent_name -> composite_model_id`` per-project pin. Empty = use the
    agent's Studio default. Keep separate from the definition default so
    one user can have e.g. orchestrator on Claude in Project A and on
    GPT-5 in Project B without switching the Studio default."""
    graph_json: str = ""
    """Serialized :class:`core.agents.agent_graph.AgentGraph` — the routing
    pipeline + canvas positions. Empty means "no custom graph; use the
    default point-to-point dispatch pattern". Loaded/saved as the JSON
    blob produced by ``AgentGraph.to_json_string()`` so older databases
    that lack the column or whose value is empty stay forward-compatible."""
    id: str = field(default_factory=_new_id)
    created_at: str = field(default_factory=_now_iso)
    updated_at: str = field(default_factory=_now_iso)

    def to_row(self) -> tuple:
        return (
            self.id,
            self.name,
            self.description,
            self.location,
            int(bool(self.trust_writes)),
            self.workdir_hint_sent_for or "",
            int(bool(self.auto_approve_all)),
            json.dumps(self.team, ensure_ascii=False),
            json.dumps(self.model_overrides, ensure_ascii=False),
            self.graph_json or "",
            self.created_at,
            self.updated_at,
        )

    @classmethod
    def from_row(cls, row) -> "Project":
        team = json.loads(row["team_json"]) if row["team_json"] else []
        overrides_raw = row["model_overrides_json"] if "model_overrides_json" in row.keys() else None
        overrides = json.loads(overrides_raw) if overrides_raw else {}
        loc = row["location"] if "location" in row.keys() else ""
        trust = bool(row["trust_writes"]) if "trust_writes" in row.keys() and row["trust_writes"] is not None else False
        hint_for = (row["workdir_hint_sent_for"] if "workdir_hint_sent_for" in row.keys() else "") or ""
        auto_approve = bool(row["auto_approve_all"]) if "auto_approve_all" in row.keys() and row["auto_approve_all"] is not None else False
        graph_raw = ""
        try:
            graph_raw = row["graph_json"] if "graph_json" in row.keys() else ""
        except Exception:
            graph_raw = ""
        return cls(
            id=row["id"],
            name=row["name"],
            description=row["description"] or "",
            location=loc or "",
            trust_writes=trust,
            workdir_hint_sent_for=hint_for,
            auto_approve_all=auto_approve,
            team=team,
            model_overrides=overrides,
            graph_json=graph_raw or "",
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


class ProjectStore:
    """SQLite-backed CRUD for :class:`Project`. Same DB as the agent bus."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=10.0)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA journal_mode=WAL")
        except sqlite3.DatabaseError:
            pass
        return conn

    def _init_schema(self) -> None:
        conn = self._connect()
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS agent_projects (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT,
                    location TEXT,
                    trust_writes INTEGER DEFAULT 0,
                    workdir_hint_sent_for TEXT DEFAULT '',
                    auto_approve_all INTEGER DEFAULT 0,
                    team_json TEXT NOT NULL,
                    model_overrides_json TEXT,
                    graph_json TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            # Best-effort migration: add the location column to existing
            # databases that pre-date this field. Same SQLite quirk as
            # project_id below — no IF NOT EXISTS for ADD COLUMN.
            proj_cols = {r[1] for r in conn.execute("PRAGMA table_info(agent_projects)")}
            if proj_cols and "location" not in proj_cols:
                conn.execute("ALTER TABLE agent_projects ADD COLUMN location TEXT")
            # Routing-graph column — added when the canvas-based agents UI
            # landed. NULL/empty means "no custom graph; use point-to-point
            # dispatch". Migration is forward-only and idempotent.
            if proj_cols and "graph_json" not in proj_cols:
                conn.execute("ALTER TABLE agent_projects ADD COLUMN graph_json TEXT")
            # Trust-writes flag — added so the project strip's checkbox can
            # toggle a scoped Claude CLI allow rule per project. Default 0
            # (off) keeps existing projects unchanged.
            if proj_cols and "trust_writes" not in proj_cols:
                conn.execute(
                    "ALTER TABLE agent_projects ADD COLUMN trust_writes INTEGER DEFAULT 0"
                )
            # Workdir-hint dedupe column — records the Location for which
            # the working-directory hint has already been sent. Lets us
            # skip the hint on subsequent runs (and across app restarts)
            # without re-prepending the directive every time.
            if proj_cols and "workdir_hint_sent_for" not in proj_cols:
                conn.execute(
                    "ALTER TABLE agent_projects ADD COLUMN workdir_hint_sent_for TEXT DEFAULT ''"
                )
            # Auto-approve-all flag — toggled by the SupervisorCard
            # checkbox. When on, the agents page registers a wildcard
            # rule on the team's ApprovalGate so every tool request
            # resolves APPROVE without surfacing to the user.
            if proj_cols and "auto_approve_all" not in proj_cols:
                conn.execute(
                    "ALTER TABLE agent_projects ADD COLUMN auto_approve_all INTEGER DEFAULT 0"
                )
            # Best-effort: add project_id column to agent_goals if missing.
            cols = {r[1] for r in conn.execute("PRAGMA table_info(agent_goals)")}
            if cols and "project_id" not in cols:
                conn.execute("ALTER TABLE agent_goals ADD COLUMN project_id TEXT")
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_agent_goals_project "
                    "ON agent_goals(project_id, created_at)"
                )
            conn.commit()
        finally:
            conn.close()

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    def list_projects(self) -> List[Project]:
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT * FROM agent_projects ORDER BY updated_at DESC"
            ).fetchall()
        finally:
            conn.close()
        return [Project.from_row(r) for r in rows]

    def get_project(self, project_id: str) -> Optional[Project]:
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT * FROM agent_projects WHERE id = ?", (project_id,)
            ).fetchone()
        finally:
            conn.close()
        return Project.from_row(row) if row else None

    def save_project(self, project: Project) -> Project:
        """Insert or update by id."""
        project.updated_at = _now_iso()
        conn = self._connect()
        try:
            existing = conn.execute(
                "SELECT id FROM agent_projects WHERE id = ?", (project.id,)
            ).fetchone()
            if existing:
                conn.execute(
                    "UPDATE agent_projects SET name=?, description=?, location=?, "
                    "trust_writes=?, workdir_hint_sent_for=?, auto_approve_all=?, "
                    "team_json=?, model_overrides_json=?, graph_json=?, "
                    "updated_at=? WHERE id=?",
                    (
                        project.name,
                        project.description,
                        project.location,
                        int(bool(project.trust_writes)),
                        project.workdir_hint_sent_for or "",
                        int(bool(project.auto_approve_all)),
                        json.dumps(project.team, ensure_ascii=False),
                        json.dumps(project.model_overrides, ensure_ascii=False),
                        project.graph_json or "",
                        project.updated_at,
                        project.id,
                    ),
                )
            else:
                conn.execute(
                    "INSERT INTO agent_projects "
                    "(id, name, description, location, trust_writes, "
                    "workdir_hint_sent_for, auto_approve_all, team_json, "
                    "model_overrides_json, graph_json, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    project.to_row(),
                )
            conn.commit()
        finally:
            conn.close()
        return project

    def delete_project(self, project_id: str) -> bool:
        conn = self._connect()
        try:
            cur = conn.execute(
                "DELETE FROM agent_projects WHERE id = ?", (project_id,)
            )
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()

    # ------------------------------------------------------------------
    # Goals tied to a project
    # ------------------------------------------------------------------

    def list_goal_ids(self, project_id: str) -> List[str]:
        """Goal ids that ran inside this project, newest first."""
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT id FROM agent_goals WHERE project_id = ? "
                "ORDER BY created_at DESC",
                (project_id,),
            ).fetchall()
        finally:
            conn.close()
        return [r["id"] for r in rows]

    def tag_goal(self, goal_id: str, project_id: str) -> None:
        """Bind an existing goal to a project. Cheap idempotent UPDATE."""
        conn = self._connect()
        try:
            conn.execute(
                "UPDATE agent_goals SET project_id = ? WHERE id = ?",
                (project_id, goal_id),
            )
            conn.commit()
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------


_store: Optional[ProjectStore] = None


def get_project_store(db_path: Optional[Path] = None) -> ProjectStore:
    """Return the process-wide ProjectStore (same DB as the agent bus)."""
    global _store
    if _store is None:
        if db_path is None:
            llm_root = Path(__file__).resolve().parent.parent.parent
            db_path = llm_root / "data" / "owllm_state.db"
        _store = ProjectStore(db_path)
    return _store
