"""OWLLM safe-mode entry point.

Spawned by LAUNCHER.py when the workload venv is broken at the
C-extension layer (torch ABI mismatch, missing libtorch DLL, etc).
Lives outside the workload venv so it can run from the bundled
python_runtime.

Two flavours, picked at runtime:

  * ``safe_mode.repair_window`` — Qt window. Used when PySide6 is
    available in the interpreter that's hosting safe-mode. Rich UI
    with live log, progress, structured per-package status.

  * ``safe_mode.console`` — stdlib-only console fallback. Used when
    PySide6 isn't reachable. Equivalent to the old
    ``safe_mode_repair.py`` script. The user sees the repair as text
    in a CMD window.

The launcher tries Qt first and falls back to console automatically;
callers shouldn't import either module directly — call
``safe_mode.run()`` and let it pick.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional


def has_qt() -> bool:
    """True if PySide6 (and a usable Qt platform) can import in this process."""
    try:
        from PySide6 import QtWidgets  # noqa: F401
        return True
    except Exception:
        return False


def run(project_root: Optional[Path] = None) -> int:
    """Pick the best safe-mode UI available and run it.

    Returns the process exit code.
    """
    if project_root is None:
        project_root = Path(__file__).resolve().parent.parent
    if has_qt():
        from safe_mode.repair_window import run_qt_window
        return run_qt_window(project_root=project_root)
    from safe_mode.console import run_console
    return run_console(project_root=project_root)


if __name__ == "__main__":
    sys.exit(run())
