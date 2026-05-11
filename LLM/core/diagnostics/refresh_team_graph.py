"""Refresh a project's routing graph from its current team template.

Use case: a project was instantiated from a template that has since had
its ``graph.edges`` corrected. The project's ``graph_json`` is a snapshot
taken at instantiation, so the fix doesn't reach existing projects.
This module rewrites JUST the ``graph_json`` field on matching projects
from the live template — preserving team membership, ``model_overrides``,
``team_default_model_id``, agent definitions, and everything else.

Idempotent: running on an already-correct project is a no-op (compares
before writing).

CLI::

    python -m core.diagnostics.refresh_team_graph --team product_studio
    python -m core.diagnostics.refresh_team_graph --team product_studio --dry-run
    python -m core.diagnostics.refresh_team_graph --project-id <id>

Stop the desktop app first — the DB is WAL-locked while it runs.
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import List, Optional

logger = logging.getLogger(__name__)


def _llm_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _project_uses_team(project, team_name: str) -> bool:
    """True iff every member of ``project.team`` is namespaced by ``team_name``.

    Templates materialise their agents with the prefix ``<team>.<short>``,
    so a project that was instantiated from ``product_studio`` will have
    every entry start with ``product_studio.``. Mixed teams (the user
    manually added members from another template) don't qualify — we
    don't want to forcibly retrofit those.
    """
    if not project.team:
        return False
    prefix = f"{team_name}."
    return all(isinstance(n, str) and n.startswith(prefix) for n in project.team)


def refresh_graphs(
    *,
    team_name: Optional[str] = None,
    project_id: Optional[str] = None,
    dry_run: bool = False,
) -> List[str]:
    """Update each matching project's ``graph_json`` from the live template.

    Returns the list of project names that were updated (or would have
    been, under ``dry_run``).
    """
    sys.path.insert(0, str(_llm_root()))
    from core.agents.projects import get_project_store
    from core.agents.teams.loader import (
        all_templates,
        _build_graph,
    )

    store = get_project_store()
    projects = store.list_projects()
    templates = all_templates()

    updated: List[str] = []

    for proj in projects:
        if project_id and proj.id != project_id:
            continue
        if team_name and not _project_uses_team(proj, team_name):
            continue
        # Infer team_name from the project's first member if not pinned.
        inferred = team_name
        if inferred is None and proj.team:
            head = proj.team[0]
            if "." in head:
                inferred = head.split(".", 1)[0]
        if not inferred:
            continue
        tpl = templates.get(inferred)
        if tpl is None:
            logger.warning(
                "project %s references team '%s' but no template found — skipping",
                proj.name, inferred,
            )
            continue
        # Build the expected graph from the live template, then compare.
        expected_graph = _build_graph(tpl, list(proj.team))
        expected_json = (
            expected_graph.to_json_string()
            if expected_graph.nodes or expected_graph.edges
            else ""
        )
        current_json = proj.graph_json or ""

        # Normalize for comparison — both parsed and stripped.
        def _norm(s: str) -> str:
            if not s:
                return ""
            try:
                return json.dumps(json.loads(s), sort_keys=True)
            except (TypeError, ValueError):
                return s

        if _norm(current_json) == _norm(expected_json):
            logger.info("project %r already up-to-date", proj.name)
            continue

        if dry_run:
            print(f"[DRY RUN] would update: {proj.name} (id={proj.id[:12]})")
        else:
            proj.graph_json = expected_json
            store.save_project(proj)
            print(f"Updated: {proj.name} (id={proj.id[:12]})")
        updated.append(proj.name)

    return updated


def _cli(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(
        prog="python -m core.diagnostics.refresh_team_graph",
        description="Rewrite a project's routing graph from its current team template.",
    )
    p.add_argument("--team", help="Only update projects whose members are namespaced by this team (e.g. product_studio)")
    p.add_argument("--project-id", help="Update only this project id")
    p.add_argument("--dry-run", action="store_true", help="List what would be updated without writing")
    args = p.parse_args(argv)

    if not args.team and not args.project_id:
        print("error: pass --team or --project-id (see --help)", file=sys.stderr)
        return 2

    try:
        updated = refresh_graphs(
            team_name=args.team,
            project_id=args.project_id,
            dry_run=args.dry_run,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"refresh failed: {exc}", file=sys.stderr)
        return 1

    if not updated:
        print("No projects needed updating.")
    else:
        action = "would update" if args.dry_run else "updated"
        print(f"\n{action} {len(updated)} project(s).")
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
