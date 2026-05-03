"""Stdlib-only safe-mode repair runner.

Spawned by LAUNCHER.py when the workload venv's torch stack is broken
at the C-extension layer (torchvision/torchaudio _C.pyd ABI mismatch,
CPU-only torch where CUDA is required, missing libtorch DLL, etc.).

WHY THIS EXISTS
---------------
The launcher cannot route to the existing tkinter ``installer_gui.py``
because the *bundled* ``LLM/python_runtime/python3.12/python.exe`` is
the embeddable distribution — it does NOT ship ``tkinter``. And we
can't route to a PySide6 GUI either, because PySide6 lives inside the
broken workload venv. The only interpreter we trust is the bundled
one, and it only has stdlib.

So this script is GUI-less. It opens in the same console the launcher
spawned it from, prints what it's doing, runs ``InstallerV2.repair()``
deterministically, and pauses at the end so the user can read the
outcome before the window closes.

WHAT IT DOES
------------
1. Banner + diagnostic header (Python version, paths, free disk).
2. Import ``installer_v2.InstallerV2`` from the bundled-Python sys.path.
3. Run ``installer_v2.repair()`` with all log lines streaming to stdout.
4. On success: prompt user to relaunch OWLLM. Exit 0.
5. On failure: print a structured error block + log path + 'press Enter
   to close', exit non-zero.

Production answer to the previous "open PowerShell and run …" guidance.
"""
from __future__ import annotations

import os
import sys
import traceback
from pathlib import Path


def _hr(char: str = "=", width: int = 70) -> None:
    print(char * width, flush=True)


def _banner() -> None:
    _hr()
    print("  OWLLM SAFE MODE — RUNTIME REPAIR")
    print("  (running from bundled Python; the workload venv is quarantined)")
    _hr()
    print(f"  Python:        {sys.version.split()[0]} at {sys.executable}")
    try:
        cwd = Path.cwd()
    except Exception:
        cwd = Path("<unknown>")
    print(f"  Working dir:   {cwd}")
    here = Path(__file__).resolve().parent
    print(f"  Script dir:    {here}")
    print(f"  Repo root:     {here.parent}")
    print(flush=True)


def _make_path_importable(here: Path) -> None:
    """Ensure ``installer_v2`` and its deps are reachable from sys.path.

    The bundled Python isn't run from inside any venv, so it doesn't see
    OWLLM's modules by default. Add the LLM/ folder to sys.path so
    ``import installer_v2`` and ``from core import ...`` resolve.
    """
    here_str = str(here)
    if here_str not in sys.path:
        sys.path.insert(0, here_str)


def _press_enter_to_exit(rc: int) -> None:
    print(flush=True)
    _hr("-")
    if rc == 0:
        print("  Repair completed successfully.")
        print("  Close this window and re-launch OWLLM (double-click START.bat).")
    else:
        print(f"  Repair did NOT complete cleanly (exit code {rc}).")
        print("  Read the lines above for the actual pip/installer error.")
        print("  Logs:")
        print("    LLM\\logs\\app.log")
        print("    LLM\\logs\\auto_repair.log")
        print("    LLM\\logs\\installer_thread.log")
    _hr("-")
    try:
        input("  Press Enter to close…")
    except (EOFError, KeyboardInterrupt):
        pass


def main() -> int:
    here = Path(__file__).resolve().parent
    _banner()
    _make_path_importable(here)

    # --- Import phase ----------------------------------------------------
    try:
        from installer_v2 import InstallerV2  # noqa: WPS433 — runtime import is intentional
    except Exception as exc:
        print(f"[FATAL] Could not import installer_v2: {exc}")
        traceback.print_exc()
        _press_enter_to_exit(2)
        return 2

    # --- Repair ----------------------------------------------------------
    print("Starting InstallerV2.repair() …")
    print(flush=True)
    try:
        installer = InstallerV2(root_dir=here)
        # Stream logs to stdout (no GUI redirect needed).
        original_log = installer.log

        def _stream_log(message: str) -> None:
            try:
                # Some messages already end with a newline; print() adds one
                # unconditionally, so strip trailing newlines first.
                print(str(message).rstrip("\r\n"), flush=True)
            except Exception:
                # Last-resort: never let logging itself crash repair.
                pass
            try:
                original_log(message)
            except Exception:
                pass

        installer.log = _stream_log
        success = installer.repair()
    except KeyboardInterrupt:
        print("\n[INTERRUPTED] User cancelled with Ctrl+C.")
        _press_enter_to_exit(130)
        return 130
    except Exception as exc:
        print(f"\n[FATAL] InstallerV2.repair() raised: {type(exc).__name__}: {exc}")
        traceback.print_exc()
        _press_enter_to_exit(3)
        return 3

    rc = 0 if success else 1
    _press_enter_to_exit(rc)
    return rc


if __name__ == "__main__":
    sys.exit(main())
