"""
Git tools.
"""
from __future__ import annotations

import subprocess
from typing import Any, Dict

from tool_server.decorators import tool


@tool(
    name="git_status",
    description="Get git status (porcelain format)",
    category="Git",
    danger_level="safe",
    requires_permissions=["git"],
    icon_key="git",
    args_schema={
        "type": "object",
        "properties": {},
        "required": []
    }
)
def git_status_handler(ctx: Any) -> Dict[str, Any]:
    """Run git status."""
    proc = subprocess.run(
        ["git", "status", "--porcelain=v1"],
        cwd=str(ctx.root),
        shell=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return {
        "ok": proc.returncode == 0,
        "returncode": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
    }
