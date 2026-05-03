"""Qt safe-mode repair window.

The user-facing answer to "do not show me a CMD window for production
repair." A real Qt application — title bar, scrollable log, status
labels, an OK button to close. Runs the unified EnvRepairer behind it.

Reachable when PySide6 is importable in the interpreter that's hosting
safe-mode. Today that means installing PySide6 into the bundled
``LLM/python_runtime/python3.12/`` (one-time bundle update). Until
that happens, ``safe_mode.run()`` falls back to the console flow
automatically.

Why a separate window instead of reusing OWLLM's main UI: the workload
venv that hosts OWLLM's main UI (PySide6 included) is the broken one
we're repairing. The whole point of safe-mode is to run from a
different interpreter that hasn't loaded any of the broken DLLs.
"""
from __future__ import annotations

import sys
import threading
from pathlib import Path
from typing import Optional


def run_qt_window(project_root: Path) -> int:
    """Open the Qt repair window. Returns the process exit code."""
    # Imports deferred so the module can be imported without PySide6
    # present (the dispatcher in safe_mode.__init__ uses has_qt()).
    from PySide6.QtCore import Qt, QObject, Signal, Slot, QTimer
    from PySide6.QtGui import QFont, QTextCursor
    from PySide6.QtWidgets import (
        QApplication,
        QHBoxLayout,
        QLabel,
        QMainWindow,
        QPlainTextEdit,
        QPushButton,
        QStatusBar,
        QVBoxLayout,
        QWidget,
    )

    here = Path(__file__).resolve().parent.parent
    if str(here) not in sys.path:
        sys.path.insert(0, str(here))

    class _Bridge(QObject):
        """Thread -> GUI signal pipe. Worker emits, UI consumes on Qt thread."""
        line = Signal(str)
        finished = Signal(int, str)  # rc, summary

    class _SafeModeWindow(QMainWindow):
        def __init__(self) -> None:
            super().__init__()
            self.setWindowTitle("OWLLM — Safe Mode Repair")
            self.resize(900, 600)
            central = QWidget(self)
            self.setCentralWidget(central)
            outer = QVBoxLayout(central)
            outer.setContentsMargins(16, 16, 16, 16)
            outer.setSpacing(10)

            header = QLabel(
                "Workload venv is broken at the C-extension layer.\n"
                "Repairing from the bundled interpreter — your workload "
                "venv stays quarantined until this finishes."
            )
            f = QFont(); f.setBold(True); f.setPointSize(11)
            header.setFont(f)
            outer.addWidget(header)

            self.status_label = QLabel("Initialising …")
            outer.addWidget(self.status_label)

            self.log_view = QPlainTextEdit()
            self.log_view.setReadOnly(True)
            self.log_view.setUndoRedoEnabled(False)
            mono = QFont("Consolas")
            mono.setStyleHint(QFont.Monospace)
            mono.setPointSize(9)
            self.log_view.setFont(mono)
            outer.addWidget(self.log_view, 1)

            row = QHBoxLayout()
            row.addStretch(1)
            self.close_btn = QPushButton("Close")
            self.close_btn.setEnabled(False)
            self.close_btn.clicked.connect(self.close)
            row.addWidget(self.close_btn)
            outer.addLayout(row)

            self.setStatusBar(QStatusBar())

            self._bridge = _Bridge()
            self._bridge.line.connect(self._append_line)
            self._bridge.finished.connect(self._on_finished)
            self._rc = 1
            QTimer.singleShot(50, self._kickoff)

        @Slot(str)
        def _append_line(self, text: str) -> None:
            self.log_view.appendPlainText(text)
            cur = self.log_view.textCursor()
            cur.movePosition(QTextCursor.End)
            self.log_view.setTextCursor(cur)

        @Slot(int, str)
        def _on_finished(self, rc: int, summary: str) -> None:
            self._rc = rc
            self.status_label.setText(summary)
            self.statusBar().showMessage(
                "Repair complete — close this window and re-launch OWLLM."
                if rc == 0
                else "Repair did NOT complete cleanly. See log above."
            )
            self.close_btn.setEnabled(True)

        def _kickoff(self) -> None:
            self.status_label.setText("Resolving env and starting repair …")

            def _emit(line: str) -> None:
                self._bridge.line.emit(line)

            def _worker() -> None:
                rc = 1
                summary = "unknown"
                try:
                    from core.runtime.owllm_python import get_owllm_env
                    from core.install import EnvRepairer, resolve_profile_id
                    env = get_owllm_env(here)
                    pid = resolve_profile_id(env.env_key, project_root=here)
                    _emit(f"[safe-mode] workload venv: {env.python_exe}")
                    _emit(f"[safe-mode] env_key:       {env.env_key}")
                    _emit(f"[safe-mode] profile id:    {pid}")
                    repairer = EnvRepairer(project_root=here)
                    result = repairer.repair(
                        env_python=env.python_exe,
                        env_id=pid,
                        extras=["training"],
                        log=_emit,
                    )
                    rc = 0 if result.ok else 1
                    summary = result.summary
                except Exception as exc:
                    import traceback as tb
                    _emit(f"[safe-mode] FATAL: {type(exc).__name__}: {exc}")
                    _emit(tb.format_exc())
                    summary = f"safe-mode crashed: {exc}"
                finally:
                    self._bridge.finished.emit(rc, summary)

            threading.Thread(target=_worker, name="safe-mode-repair", daemon=True).start()

    app = QApplication.instance() or QApplication(sys.argv)
    win = _SafeModeWindow()
    win.show()
    app.exec()
    return win._rc


if __name__ == "__main__":
    sys.exit(run_qt_window(Path(__file__).resolve().parents[1]))
