"""
Process utilities for the desktop app, including Windows console suppression.

Call ``apply_create_no_window(proc)`` on any ``QProcess`` instance *after*
configuring it (setProgram / setArguments / setWorkingDirectory) and before
``start()``. It does two things on Windows:

1. Attempts to install a ``setCreateProcessArgumentsModifier`` that forces
   ``CREATE_NO_WINDOW`` + hidden ``STARTUPINFO`` on the spawned process.
   This is the "proper" API but is only available on newer PySide6 builds
   (not in 6.8.1 that ships with LocaLLM at the time of writing).

2. As a portable fallback that works on *every* PySide6 build we support,
   swap the child program from ``python.exe`` (CONSOLE subsystem, always
   allocates a console on Windows → visible flash) to ``pythonw.exe`` (GUI
   subsystem, no console). ``QProcess`` already wires stdin/stdout/stderr
   through anonymous pipes, so ``pythonw.exe`` keeps producing output on
   those pipes exactly like ``python.exe`` did.

Both mechanisms are no-ops on non-Windows platforms.
"""
from __future__ import annotations

import os
import subprocess
import sys
from typing import TYPE_CHECKING

from PySide6.QtCore import QByteArray, QObject, QProcess, QProcessEnvironment, QTimer, Signal

if TYPE_CHECKING:
    from PySide6.QtCore import QProcess as QProcessT
else:
    QProcessT = QProcess


def _swap_python_exe_to_pythonw(program: str) -> str:
    """Return ``pythonw.exe`` / ``pyw.exe`` when ``program`` is a console Python launcher."""
    try:
        from core.python_exe_swap import swap_console_python_to_pythonw

        return swap_console_python_to_pythonw(program)
    except Exception:
        return program


def apply_create_no_window(proc: "QProcessT") -> None:
    """
    On Windows, configure the given ``QProcess`` so the spawned child does
    not flash a console window.

    - If available, installs a ``setCreateProcessArgumentsModifier`` that
      applies ``CREATE_NO_WINDOW`` + hidden ``STARTUPINFO``.
    - Always performs a ``python.exe`` → ``pythonw.exe`` swap on the program
      so CONSOLE-subsystem Python children become GUI-subsystem (no console
      window is ever allocated by Windows for GUI-subsystem binaries).

    Call after configuring the process and before ``start()``. No-op on
    non-Windows platforms.
    """
    if sys.platform != "win32":
        return

    try:
        current_program = proc.program() if hasattr(proc, "program") else ""
    except Exception:
        current_program = ""
    swapped = _swap_python_exe_to_pythonw(current_program)
    if swapped and swapped != current_program:
        try:
            proc.setProgram(swapped)
        except Exception:
            pass

    if not hasattr(proc, "setCreateProcessArgumentsModifier"):
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
        if hasattr(args, "flags"):
            args.flags = getattr(args, "flags", 0) | CREATE_NO_WINDOW
        if hasattr(args, "dwCreationFlags"):
            args.dwCreationFlags = getattr(args, "dwCreationFlags", 0) | CREATE_NO_WINDOW
        si = getattr(args, "startupInfo", None)
        if si is not None:
            try:
                si.dwFlags = getattr(si, "dwFlags", 0) | STARTF_USESHOWWINDOW
                si.wShowWindow = SW_HIDE
            except Exception:
                pass

    try:
        proc.setCreateProcessArgumentsModifier(modifier)
    except Exception:
        pass


def _subprocess_no_window_kwargs() -> dict:
    """Keyword args for :class:`subprocess.Popen` that hide the console on Windows."""
    if sys.platform != "win32":
        return {}
    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startupinfo.wShowWindow = subprocess.SW_HIDE
    return {
        "startupinfo": startupinfo,
        "creationflags": subprocess.CREATE_NO_WINDOW,
    }


def qprocess_environment_to_environ(
    qenv: QProcessEnvironment, base: dict[str, str] | None = None
) -> dict[str, str]:
    """Convert a :class:`QProcessEnvironment` to a plain ``os.environ``-style dict."""
    out: dict[str, str] = dict(base or os.environ)
    try:
        for item in qenv.toStringList():
            if not item or "=" not in item:
                continue
            k, v = item.split("=", 1)
            out[k] = v
    except Exception:
        pass
    return out


class HiddenSubprocessRunner(QObject):
    """Run a child with :class:`subprocess.Popen` and surface Qt-style signals.

    **Why this exists:** ``QProcess`` on Windows calls Win32 ``CreateProcess``
    *inside* Qt6Core, **not** through Python's ``subprocess`` or
    ``_winapi`` modules.  Our ``win_subprocess_guard`` patches therefore do
    **not** apply to ``QProcess`` children.  PySide6 6.8.1 also does not ship
    ``setCreateProcessArgumentsModifier``.  The old workaround (swap
    ``python.exe`` → ``pythonw.exe``) is brittle.  Spawning with
    ``subprocess.Popen`` + ``CREATE_NO_WINDOW`` routes through the patched
    ``Popen`` implementation and actually suppresses the console.
    """

    readyReadStandardOutput = Signal()
    finished = Signal(int, object)  # exitCode, QProcess.ExitStatus
    errorOccurred = Signal(int)  # QProcess.ProcessError

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._p: subprocess.Popen[bytes] | None = None
        self._stdout_queue = bytearray()
        self._timer = QTimer(self)
        self._timer.setInterval(25)
        self._timer.timeout.connect(self._on_timer)

    def _on_timer(self) -> None:
        if self._p is None:
            return
        if self._p.stdout:
            try:
                chunk = self._p.stdout.read(65536)
            except Exception:
                chunk = b""
            if chunk:
                self._stdout_queue.extend(chunk)
                self.readyReadStandardOutput.emit()
        code = self._p.poll()
        if code is not None:
            if self._p.stdout:
                try:
                    rest = self._p.stdout.read() or b""
                except Exception:
                    rest = b""
                if rest:
                    self._stdout_queue.extend(rest)
                    self.readyReadStandardOutput.emit()
            self._timer.stop()
            st = QProcess.NormalExit if code == 0 else QProcess.CrashExit
            self.finished.emit(int(code), st)
            self._p = None

    def start(
        self,
        program_and_args: list[str],
        *,
        working_directory: str,
        process_environment: dict[str, str],
    ) -> None:
        if not program_and_args:
            self.errorOccurred.emit(QProcess.FailedToStart)
            return
        cmd0 = str(program_and_args[0])
        from core.python_exe_swap import swap_console_python_to_pythonw

        cmd0 = swap_console_python_to_pythonw(cmd0)
        program_and_args = [cmd0] + list(program_and_args[1:])

        kw: dict = {
            "cwd": working_directory,
            "env": process_environment,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.STDOUT,
            "stdin": subprocess.DEVNULL,
        }
        kw.update(_subprocess_no_window_kwargs())
        try:
            self._p = subprocess.Popen(
                [str(x) for x in program_and_args], **kw
            )  # noqa: S603 - argv built by the app, not a shell
        except OSError:
            self.errorOccurred.emit(QProcess.FailedToStart)
            return
        self._timer.start()
        self._p.poll()

    def readAllStandardOutput(self) -> QByteArray:
        if not self._stdout_queue:
            return QByteArray()
        out = bytes(self._stdout_queue)
        self._stdout_queue.clear()
        return QByteArray(out)

    def waitForStarted(self, msec: int = 30000) -> bool:
        """Return True if the process is running or has already exited (mirrors QProcess)."""
        if self._p is None:
            return False
        return True

    def waitForFinished(self, msec: int = 30000) -> bool:
        if self._p is None:
            return True
        try:
            self._p.wait(timeout=max(0.0, msec / 1000.0))
        except Exception:
            return False
        return True

    def terminate(self) -> None:
        if self._p is not None:
            try:
                self._p.terminate()
            except Exception:
                pass

    def kill(self) -> None:
        if self._p is not None:
            try:
                self._p.kill()
            except Exception:
                pass

    def processId(self) -> int:
        if self._p is None or self._p.pid is None:
            return 0
        return int(self._p.pid)
