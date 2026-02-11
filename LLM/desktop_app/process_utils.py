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
        STARTF_USESHOWWINDOW = getattr(subprocess, "STARTF_USESHOWWINDOW", 0x00000001)
        SW_HIDE = getattr(subprocess, "SW_HIDE", 0)
    except ImportError:
        CREATE_NO_WINDOW = 0x08000000
        STARTF_USESHOWWINDOW = 0x00000001
        SW_HIDE = 0

    def modifier(args):
        # Qt 6 CreateProcessArguments: may expose flags or dwCreationFlags depending on bindings
        if hasattr(args, "flags"):
            args.flags = getattr(args, "flags", 0) | CREATE_NO_WINDOW
        if hasattr(args, "dwCreationFlags"):
            args.dwCreationFlags = getattr(args, "dwCreationFlags", 0) | CREATE_NO_WINDOW
        # Some Qt builds expose startupInfo; hide window explicitly there as well.
        si = getattr(args, "startupInfo", None)
        if si is not None:
            try:
                si.dwFlags = getattr(si, "dwFlags", 0) | STARTF_USESHOWWINDOW
                si.wShowWindow = SW_HIDE
            except Exception:
                pass

    proc.setCreateProcessArgumentsModifier(modifier)
