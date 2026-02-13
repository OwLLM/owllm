"""
Shell execution tools.
"""
from __future__ import annotations

import sys
import subprocess
from typing import Any, Dict

from tool_server.decorators import tool

# Windows: hide console when running shell commands (avoid CMD flash)
_SHELL_FLAGS: Dict[str, Any] = {}
if sys.platform == "win32":
    _si = subprocess.STARTUPINFO()
    _si.dwFlags |= getattr(subprocess, "STARTF_USESHOWWINDOW", 0x00000001)
    _si.wShowWindow = getattr(subprocess, "SW_HIDE", 0)
    _SHELL_FLAGS = {
        "startupinfo": _si,
        "creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000),
    }


@tool(
    name="run_shell",
    description="Run a shell command and return stdout/stderr",
    category="Shell",
    danger_level="dangerous",
    requires_permissions=["shell"],
    icon_key="terminal",
    args_schema={
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "Shell command to execute"
            }
        },
        "required": ["command"]
    }
)
def run_shell_handler(ctx: Any, command: str) -> Dict[str, Any]:
    """Run shell command."""
    proc = subprocess.run(
        command,
        cwd=str(ctx.root),
        shell=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        **_SHELL_FLAGS,
    )
    return {
        "ok": proc.returncode == 0,
        "returncode": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
    }
