"""
Process utilities for the desktop app, including Windows console suppression.
Use apply_create_no_window() on QProcess instances before start() to avoid CMD/PowerShell flashing.
"""
import sys
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from PySide6.QtCore import QProcess


def apply_create_no_window(proc: "QProcess") -> None:
    """
    On Windows, set CREATE_NO_WINDOW on the given QProcess so child
    processes do not flash a console window. No-op on other platforms.
    Call this after configuring the process and before start().
    """
    if sys.platform != "win32":
        return
    if not hasattr(proc, "setCreateProcessArgumentsModifier"):
        # Fallback: Qt runtime does not expose modifier API; child may show console.
        try:
            print("[process_utils] QProcess setCreateProcessArgumentsModifier unavailable; child may show console.", file=sys.stderr)
        except Exception:
            pass
        return
    try:
        import subprocess
        CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    except ImportError:
        CREATE_NO_WINDOW = 0x08000000

    def modifier(args):
        # Qt 6 CreateProcessArguments: may expose flags or dwCreationFlags depending on bindings
        if hasattr(args, "flags"):
            args.flags = getattr(args, "flags", 0) | CREATE_NO_WINDOW
        if hasattr(args, "dwCreationFlags"):
            args.dwCreationFlags = getattr(args, "dwCreationFlags", 0) | CREATE_NO_WINDOW

    proc.setCreateProcessArgumentsModifier(modifier)
