"""
Pure-Python helpers for choosing a no-console Windows Python executable.

Used by ``core.win_subprocess_guard`` (QProcess monkey-patches) and
``desktop_app.process_utils`` (``apply_create_no_window``).  Kept in
``core/`` with **no** Qt imports so child interpreters (pip, venv probes) can
import it at startup without pulling in PySide6.
"""
from __future__ import annotations

import os
import re
import sys

# python.exe, python3.exe, python3.10.exe, ... in a venv Scripts\ directory
_PY_NAMES = re.compile(r"^python(3(\.\d+)?)?\.exe$", re.IGNORECASE)


def swap_console_python_to_pythonw(program: str) -> str:
    """If ``program`` is a Windows console Python launcher, return ``pythonw.exe`` in the same directory when present.

    Also maps ``py.exe`` → ``pyw.exe`` (Python Windows launcher) when the
    sibling exists.  Returns ``program`` unchanged if no swap applies.
    """
    if sys.platform != "win32" or not program:
        return program
    try:
        norm = os.path.normcase(os.path.abspath(os.path.normpath(program)))
    except Exception:
        return program
    directory, base = os.path.dirname(norm), os.path.basename(norm)

    if base.lower() == "py.exe":
        candidate = os.path.join(directory, "pyw.exe")
        return candidate if os.path.isfile(candidate) else program

    if _PY_NAMES.match(base):
        candidate = os.path.join(directory, "pythonw.exe")
        return candidate if os.path.isfile(candidate) else program

    return program
