"""Process utilities for the desktop app."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import threading
from typing import TYPE_CHECKING

from PySide6.QtCore import QByteArray, QObject, QProcess, QProcessEnvironment, Signal

if TYPE_CHECKING:
    from PySide6.QtCore import QProcess as QProcessT
else:
    QProcessT = QProcess


def _swap_python_exe_to_pythonw(program: str) -> str:
    """Compatibility shim: no longer swaps console Python to pythonw."""
    return program


def _resolve_program_for_subprocess(program: str) -> str:
    """Resolve PATH/PATHEXT commands before ``subprocess.Popen`` starts them."""
    if not program:
        return program
    try:
        if os.path.isabs(program) or os.path.dirname(program):
            return program
        return shutil.which(program) or program
    except Exception:
        return program


def apply_create_no_window(proc: "QProcessT") -> None:
    """Compatibility shim: no longer applies Windows no-window flags."""
    return


def _subprocess_no_window_kwargs() -> dict:
    """Compatibility shim: no longer returns console-hiding kwargs."""
    return {}


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
    """Run a child with :class:`subprocess.Popen` and surface Qt-style signals."""

    readyReadStandardOutput = Signal()
    finished = Signal(int, object)  # exitCode, QProcess.ExitStatus
    errorOccurred = Signal(int)  # QProcess.ProcessError

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._p: subprocess.Popen[bytes] | None = None
        self._stdout_queue = bytearray()
        self._stdout_lock = threading.Lock()
        self._reader_thread: threading.Thread | None = None
        self._waiter_thread: threading.Thread | None = None

    def _enqueue_stdout(self, chunk: bytes) -> None:
        if not chunk:
            return
        with self._stdout_lock:
            self._stdout_queue.extend(chunk)
        self.readyReadStandardOutput.emit()

    def _reader_loop(self, proc: subprocess.Popen[bytes]) -> None:
        stdout = proc.stdout
        if stdout is None:
            return
        try:
            while True:
                chunk = stdout.read(4096)
                if not chunk:
                    break
                self._enqueue_stdout(chunk)
        except Exception:
            return

    def _waiter_loop(self, proc: subprocess.Popen[bytes]) -> None:
        try:
            code = proc.wait()
        except Exception:
            code = -1
        reader = self._reader_thread
        if reader is not None and reader is not threading.current_thread():
            reader.join(timeout=2.0)
        st = QProcess.NormalExit if code == 0 else QProcess.CrashExit
        self.finished.emit(int(code), st)
        if self._p is proc:
            self._p = None

    def start(
        self,
        program_and_args: list[str],
        *,
        working_directory: str,
        process_environment: dict[str, str],
    ) -> None:
        # Forensic write: dump the exact spawn attempt to disk so we
        # can see the cmd, cwd, and any exception WITHOUT relying on
        # the Qt signal/slot dispatch to deliver them. This eats the
        # 'Failed to start training process!' mystery for good — the
        # next failure tells us exactly which OS error Popen raised.
        from pathlib import Path as _Path
        from datetime import datetime as _dt
        try:
            _llm_root = _Path(__file__).resolve().parent.parent
            _spawn_log = _llm_root / "logs" / "spawn.log"
            _spawn_log.parent.mkdir(parents=True, exist_ok=True)
        except Exception:
            _spawn_log = None

        def _spawn_log_write(line: str) -> None:
            if _spawn_log is None:
                return
            try:
                with _spawn_log.open("a", encoding="utf-8", errors="replace") as _f:
                    _f.write(f"[{_dt.utcnow().isoformat()}Z] {line}\n")
            except Exception:
                pass

        if not program_and_args:
            _spawn_log_write("Popen FAIL: empty program_and_args list")
            self.errorOccurred.emit(QProcess.FailedToStart)
            return
        cmd0 = str(program_and_args[0])

        cmd0 = _resolve_program_for_subprocess(cmd0)
        program_and_args = [cmd0] + list(program_and_args[1:])

        kw: dict = {
            "cwd": working_directory,
            "env": process_environment,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.STDOUT,
            "stdin": subprocess.DEVNULL,
        }
        kw.update(_subprocess_no_window_kwargs())

        argv_str = [str(x) for x in program_and_args]
        # Sanity: the program path MUST exist on disk. Popen on Windows
        # raises a confusing 'WinError 2' for missing exe — surface it
        # explicitly here with the path so 'Failed to start' has context.
        if not os.path.isfile(cmd0):
            _spawn_log_write(
                f"Popen FAIL: program does not exist on disk: {cmd0!r}\n"
                f"  cwd={working_directory!r}\n"
                f"  argv={argv_str}\n"
            )
            self.errorOccurred.emit(QProcess.FailedToStart)
            return

        # Sanity: cwd must exist too.
        if not os.path.isdir(working_directory):
            _spawn_log_write(
                f"Popen FAIL: working_directory does not exist: {working_directory!r}\n"
                f"  argv={argv_str}\n"
            )
            self.errorOccurred.emit(QProcess.FailedToStart)
            return

        # Detect Windows command-line length limit. CreateProcess caps
        # the *combined* command line at 32767 chars; pass that ceiling
        # and Popen raises 'OSError [WinError 87] The parameter is
        # incorrect' which used to surface as a generic FailedToStart.
        try:
            joined = " ".join(argv_str)
            if len(joined) > 32000:
                _spawn_log_write(
                    f"Popen FAIL: cmdline too long: {len(joined)} chars\n"
                    f"  argv head={argv_str[:3]}\n"
                )
                self.errorOccurred.emit(QProcess.FailedToStart)
                return
        except Exception:
            pass

        _spawn_log_write(
            f"Popen ATTEMPT: cmd0={cmd0!r}\n"
            f"  cwd={working_directory!r}\n"
            f"  argv={argv_str}\n"
        )
        try:
            self._p = subprocess.Popen(
                argv_str, **kw
            )  # noqa: S603 - argv built by the app, not a shell
        except OSError as exc:
            _spawn_log_write(
                f"Popen FAIL OSError: {exc!r}\n"
                f"  errno={getattr(exc, 'errno', None)} winerror={getattr(exc, 'winerror', None)}\n"
                f"  strerror={getattr(exc, 'strerror', None)}\n"
                f"  filename={getattr(exc, 'filename', None)}\n"
            )
            self.errorOccurred.emit(QProcess.FailedToStart)
            return
        except Exception as exc:
            # Catch ANYTHING else (TypeError, ValueError, etc.) so non-
            # OSError failures don't bubble up uncaught and disappear.
            import traceback as _tb
            _spawn_log_write(
                f"Popen FAIL non-OSError: {type(exc).__name__}: {exc}\n"
                f"{_tb.format_exc()}"
            )
            self.errorOccurred.emit(QProcess.FailedToStart)
            return

        _spawn_log_write(f"Popen OK: pid={self._p.pid}")
        self._reader_thread = threading.Thread(target=self._reader_loop, args=(self._p,), daemon=True)
        self._waiter_thread = threading.Thread(target=self._waiter_loop, args=(self._p,), daemon=True)
        self._reader_thread.start()
        self._waiter_thread.start()

    def readAllStandardOutput(self) -> QByteArray:
        with self._stdout_lock:
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
