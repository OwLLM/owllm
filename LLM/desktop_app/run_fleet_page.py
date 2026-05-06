"""Standalone runner for :class:`FleetPage`.

Lets you preview the slice 2a UI without integrating into ``main.py``::

    python -m desktop_app.run_fleet_page

By default this points at a scratch fleet root under your temp dir so
it doesn't disturb the real ``~/.owllm/fleet`` state. Pass ``--real``
to use the production paths instead.
"""
from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

from PySide6.QtWidgets import QApplication

from desktop_app.fleet_service import FleetService
from desktop_app.pages.fleet_page import FleetPage


def main() -> int:
    parser = argparse.ArgumentParser(prog="python -m desktop_app.run_fleet_page")
    parser.add_argument(
        "--real", action="store_true",
        help="use the production ~/.owllm/fleet/ paths instead of a scratch tempdir",
    )
    parser.add_argument("--db", help="explicit manifest path (overrides --real)")
    parser.add_argument("--workspace-root", help="explicit workspace root (overrides --real)")
    args = parser.parse_args()

    if args.db or args.workspace_root:
        db = args.db
        ws = args.workspace_root
    elif args.real:
        db = None
        ws = None
    else:
        scratch = Path(tempfile.gettempdir()) / "owllm_fleet_preview"
        scratch.mkdir(parents=True, exist_ok=True)
        db = str(scratch / "manifest.sqlite")
        ws = str(scratch / "workspaces")
        print(f"preview mode: scratch fleet root at {scratch}", file=sys.stderr)

    app = QApplication(sys.argv)
    service = FleetService(db_path=db, workspace_root=ws)
    page = FleetPage(service)
    page.setWindowTitle("OWLLM Fleet — preview")
    page.resize(720, 720)
    page.show()
    try:
        return app.exec()
    finally:
        service.shutdown()


if __name__ == "__main__":
    sys.exit(main())
