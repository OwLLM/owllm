"""Qt safe-mode repair window — production-quality layout.

Three panels:

  * TOP — banner explaining WHY the launcher routed here. Reads from
    EnvRepairer.probe() so the user sees the actual failure
    (torchaudio ABI mismatch / CPU-only torch / missing libtorch DLL),
    not a generic 'something is broken' message.

  * LEFT — component checklist. Every required package gets a row
    showing (icon, name, required spec, installed version, status).
    Statuses: ✓ OK, ✗ Missing, ⚠ Wrong version. Updates live as the
    repair installs each package.

  * RIGHT — live log. Same content the EnvRepairer streams to console
    safe-mode, but appended to a scrollable QPlainTextEdit so the user
    can read it without losing the structured view.

  * BOTTOM — Step indicator + progress bar + action buttons (Repair
    Now / Cancel / Open log folder).

Two-phase flow:

  1. On open, runs probe() in a worker thread to populate the
     checklist. Status header reads 'Diagnosing …' until the probe
     completes.
  2. User clicks 'Repair Now'. The actual EnvRepairer.repair() runs;
     each pip line streams into the log AND each PackageDiff row
     updates its icon/text as we go.
"""
from __future__ import annotations

import sys
import threading
from pathlib import Path
from typing import Any, Dict, Optional


def run_qt_window(project_root: Path) -> int:
    """Open the Qt repair window. Returns the process exit code.

    Imports are deferred so the module is importable without PySide6
    (the dispatcher in safe_mode.__init__ uses has_qt() before
    calling here).
    """
    from PySide6.QtCore import Qt, QObject, Signal, Slot, QTimer
    from PySide6.QtGui import QFont, QTextCursor, QColor, QBrush
    from PySide6.QtWidgets import (
        QApplication,
        QHBoxLayout,
        QLabel,
        QMainWindow,
        QPlainTextEdit,
        QProgressBar,
        QPushButton,
        QSplitter,
        QStatusBar,
        QTreeWidget,
        QTreeWidgetItem,
        QVBoxLayout,
        QWidget,
        QFileDialog,
    )

    here = Path(__file__).resolve().parent.parent  # .../LLM
    if str(here) not in sys.path:
        sys.path.insert(0, str(here))

    from core.install import (
        EnvRepairer,
        RepairOutcome,
        PackageStatus,
    )
    from core.install import resolve_profile_id
    from core.runtime.owllm_python import get_owllm_env

    # ─────────────────────────────────────────────────────────────────
    # Cross-thread message bus
    # ─────────────────────────────────────────────────────────────────
    class _Bridge(QObject):
        log_line = Signal(str)
        probe_done = Signal(object)        # RepairResult from probe()
        repair_started = Signal()
        repair_progress = Signal(str, int) # (label, percent 0..100)
        repair_done = Signal(object)       # RepairResult from repair()
        package_status = Signal(str, str, str)  # name, status_token, detail
        fatal = Signal(str)

    # Status tokens (string-based to avoid Enum import gymnastics across
    # the worker boundary).
    STATUS_OK = "ok"
    STATUS_MISSING = "missing"
    STATUS_WRONG = "wrong_version"
    STATUS_PENDING = "pending"
    STATUS_INSTALLING = "installing"

    STATUS_ICON = {
        STATUS_OK:         "✓",
        STATUS_MISSING:    "✗",
        STATUS_WRONG:      "⚠",
        STATUS_PENDING:    "…",
        STATUS_INSTALLING: "↻",
    }
    STATUS_COLOUR = {
        STATUS_OK:         QColor("#33cc66"),
        STATUS_MISSING:    QColor("#ff5555"),
        STATUS_WRONG:      QColor("#ffaa33"),
        STATUS_PENDING:    QColor("#888888"),
        STATUS_INSTALLING: QColor("#33aaff"),
    }
    STATUS_TEXT = {
        STATUS_OK:         "OK",
        STATUS_MISSING:    "Missing",
        STATUS_WRONG:      "Wrong version",
        STATUS_PENDING:    "Pending",
        STATUS_INSTALLING: "Installing…",
    }

    class _SafeModeWindow(QMainWindow):
        def __init__(self) -> None:
            super().__init__()
            self.setWindowTitle("OWLLM — Safe Mode Repair")
            self.resize(1180, 720)

            self._bridge = _Bridge()
            self._bridge.log_line.connect(self._on_log_line)
            self._bridge.probe_done.connect(self._on_probe_done)
            self._bridge.repair_started.connect(self._on_repair_started)
            self._bridge.repair_progress.connect(self._on_repair_progress)
            self._bridge.repair_done.connect(self._on_repair_done)
            self._bridge.package_status.connect(self._on_package_status)
            self._bridge.fatal.connect(self._on_fatal)

            self._rc = 1
            self._env_python: Optional[Path] = None
            self._env_id: Optional[str] = None
            self._extras = ["training"]
            self._diff_rows: Dict[str, QTreeWidgetItem] = {}
            self._probe_result = None
            self._repair_thread: Optional[threading.Thread] = None

            # ─── outer layout ───────────────────────────────────────
            central = QWidget(self)
            self.setCentralWidget(central)
            outer = QVBoxLayout(central)
            outer.setContentsMargins(14, 12, 14, 12)
            outer.setSpacing(10)

            # ─── banner ────────────────────────────────────────────
            self.banner_title = QLabel("Safe Mode — diagnosing your installation …")
            f = QFont()
            f.setBold(True)
            f.setPointSize(13)
            self.banner_title.setFont(f)
            outer.addWidget(self.banner_title)

            self.banner_detail = QLabel(
                "Running from the bundled Python; the workload venv is "
                "quarantined until repairs finish."
            )
            self.banner_detail.setWordWrap(True)
            outer.addWidget(self.banner_detail)

            # ─── reason chip ───────────────────────────────────────
            self.reason_label = QLabel("")
            self.reason_label.setWordWrap(True)
            self.reason_label.setStyleSheet(
                "QLabel { background:#2a1d1d; color:#ffcccc; "
                "border:1px solid #883333; border-radius:6px; padding:8px; }"
            )
            self.reason_label.hide()
            outer.addWidget(self.reason_label)

            # ─── splitter (checklist | log) ────────────────────────
            splitter = QSplitter(Qt.Horizontal)

            # left: checklist
            left_box = QWidget()
            lv = QVBoxLayout(left_box)
            lv.setContentsMargins(0, 0, 0, 0)
            lv.setSpacing(6)
            lv_header = QLabel("Required components")
            hf = QFont(); hf.setBold(True)
            lv_header.setFont(hf)
            lv.addWidget(lv_header)
            self.checklist = QTreeWidget()
            self.checklist.setRootIsDecorated(False)
            self.checklist.setUniformRowHeights(True)
            self.checklist.setColumnCount(4)
            self.checklist.setHeaderLabels(["", "Component", "Required", "Installed"])
            self.checklist.setColumnWidth(0, 36)
            self.checklist.setColumnWidth(1, 230)
            self.checklist.setColumnWidth(2, 180)
            self.checklist.setColumnWidth(3, 140)
            self.checklist.setAlternatingRowColors(True)
            self.checklist.setStyleSheet(
                "QTreeWidget { font-family: Consolas, monospace; font-size: 10pt; }"
            )
            lv.addWidget(self.checklist, 1)
            splitter.addWidget(left_box)

            # right: log
            right_box = QWidget()
            rv = QVBoxLayout(right_box)
            rv.setContentsMargins(0, 0, 0, 0)
            rv.setSpacing(6)
            rv_header = QLabel("Live log")
            rv_header.setFont(hf)
            rv.addWidget(rv_header)
            self.log_view = QPlainTextEdit()
            self.log_view.setReadOnly(True)
            self.log_view.setUndoRedoEnabled(False)
            mono = QFont("Consolas")
            mono.setStyleHint(QFont.Monospace)
            mono.setPointSize(9)
            self.log_view.setFont(mono)
            self.log_view.setStyleSheet(
                "QPlainTextEdit { background:#0e1117; color:#cbd2e0; "
                "border:1px solid #2a2f3a; }"
            )
            rv.addWidget(self.log_view, 1)
            splitter.addWidget(right_box)

            splitter.setStretchFactor(0, 1)
            splitter.setStretchFactor(1, 1)
            splitter.setSizes([620, 540])
            outer.addWidget(splitter, 1)

            # ─── progress + step indicator ─────────────────────────
            step_row = QHBoxLayout()
            step_row.setSpacing(10)
            self.step_label = QLabel("Step 1 of 5 — resolving environment …")
            self.step_label.setStyleSheet("QLabel { color:#aabbdd; }")
            step_row.addWidget(self.step_label, 1)
            self.progress = QProgressBar()
            self.progress.setRange(0, 100)
            self.progress.setValue(0)
            self.progress.setMaximumWidth(280)
            step_row.addWidget(self.progress, 0)
            outer.addLayout(step_row)

            # ─── action buttons ────────────────────────────────────
            row = QHBoxLayout()
            self.open_logs_btn = QPushButton("Open log folder")
            self.open_logs_btn.clicked.connect(self._open_logs_folder)
            row.addWidget(self.open_logs_btn)
            row.addStretch(1)
            self.repair_btn = QPushButton("Repair Now")
            self.repair_btn.setMinimumWidth(140)
            self.repair_btn.setEnabled(False)
            self.repair_btn.clicked.connect(self._on_repair_clicked)
            row.addWidget(self.repair_btn)
            self.close_btn = QPushButton("Close")
            self.close_btn.setEnabled(False)
            self.close_btn.clicked.connect(self.close)
            row.addWidget(self.close_btn)
            outer.addLayout(row)

            self.setStatusBar(QStatusBar())
            self.statusBar().showMessage("Probing environment …")

            # Kick off the probe phase as soon as the window is up.
            QTimer.singleShot(50, self._kickoff_probe)

        # ─── slots ────────────────────────────────────────────────
        @Slot(str)
        def _on_log_line(self, text: str) -> None:
            self.log_view.appendPlainText(text)
            cur = self.log_view.textCursor()
            cur.movePosition(QTextCursor.End)
            self.log_view.setTextCursor(cur)

        @Slot(object)
        def _on_probe_done(self, result) -> None:
            self._probe_result = result
            torch = result.torch_before
            # banner / reason chip
            if result.outcome == RepairOutcome.SUCCESS:
                self.banner_title.setText("Environment already healthy")
                self.banner_detail.setText(
                    "Nothing needs repairing. Close this window and re-launch "
                    "OWLLM."
                )
                self.reason_label.hide()
                self.repair_btn.setEnabled(False)
                self.close_btn.setEnabled(True)
                self._rc = 0
                self.statusBar().showMessage(result.summary)
                self.step_label.setText("All checks passed ✓")
                self.progress.setValue(100)
            else:
                self.banner_title.setText("Repair plan ready")
                summary = result.summary or "Components need install/update."
                self.banner_detail.setText(summary)
                if torch and (torch.abi_mismatch or not torch.ok):
                    reason_lines = ["The torch C-extensions could not be loaded:"]
                    raw = (torch.raw_output or "").strip()
                    if raw:
                        reason_lines.append(raw[-600:])
                    if torch.abi_mismatch:
                        reason_lines.append(
                            "Diagnosis: torchvision/torchaudio compiled against a "
                            "different libtorch build (ABI mismatch). EnvRepairer "
                            "will rebuild the matched cu* trio together."
                        )
                    self.reason_label.setText("\n".join(reason_lines))
                    self.reason_label.show()
                self.repair_btn.setEnabled(True)
                self.close_btn.setEnabled(True)
                self.statusBar().showMessage("Click 'Repair Now' to start.")
                self.step_label.setText("Step 2 of 5 — diff complete; awaiting confirmation")
                self.progress.setValue(20)

            # Populate the checklist from the diff.
            self.checklist.clear()
            self._diff_rows.clear()
            # Sort: bad first (so the user sees what's broken at a glance),
            # then alphabetical.
            order = {
                PackageStatus.MISSING: 0,
                PackageStatus.WRONG_VERSION: 1,
                PackageStatus.UNCHECKED: 2,
                PackageStatus.OK: 3,
            }
            for d in sorted(result.diff, key=lambda x: (order.get(x.status, 9), x.name)):
                token = self._diff_status_token(d.status)
                self._add_checklist_row(
                    name=d.name,
                    required=d.spec or "(any)",
                    installed=d.installed_version or "—",
                    token=token,
                    detail=STATUS_TEXT[token],
                )
            # Also show the torch trio in the checklist using the probe
            # info, since it isn't always in the resolver's pkg map.
            if torch:
                self._add_checklist_row(
                    name="torch (runtime CUDA load)",
                    required="cuda available",
                    installed=("yes" if torch.cuda_available else "no"),
                    token=(STATUS_OK if torch.cuda_available else STATUS_WRONG),
                    detail=("ok" if torch.cuda_available else
                            ("ABI mismatch" if torch.abi_mismatch else "CUDA not available")),
                )

        @Slot()
        def _on_repair_started(self) -> None:
            self.repair_btn.setEnabled(False)
            self.close_btn.setEnabled(False)
            self.statusBar().showMessage("Repair running …")
            self.step_label.setText("Step 3 of 5 — installing missing/incorrect components")
            self.progress.setValue(35)

        @Slot(str, int)
        def _on_repair_progress(self, label: str, percent: int) -> None:
            self.step_label.setText(label)
            self.progress.setValue(max(0, min(100, percent)))

        @Slot(str, str, str)
        def _on_package_status(self, name: str, token: str, detail: str) -> None:
            row = self._diff_rows.get(name.lower())
            if not row:
                return
            row.setText(0, STATUS_ICON.get(token, "?"))
            row.setText(3, detail or STATUS_TEXT.get(token, ""))
            colour = STATUS_COLOUR.get(token)
            if colour:
                row.setForeground(0, QBrush(colour))
                row.setForeground(3, QBrush(colour))

        @Slot(object)
        def _on_repair_done(self, result) -> None:
            self.close_btn.setEnabled(True)
            ok = result.outcome in (RepairOutcome.SUCCESS, RepairOutcome.SUCCESS_WITH_WARNINGS)
            self._rc = 0 if ok else 1
            self.progress.setValue(100)
            if ok:
                self.banner_title.setText("Repair complete")
                self.banner_detail.setText(result.summary)
                self.statusBar().showMessage(
                    "Close this window and re-launch OWLLM."
                )
                self.step_label.setText("Step 5 of 5 — verified ✓")
                # Update the checklist final state from the post-install diff.
                if result.diff:
                    for d in result.diff:
                        token = self._diff_status_token(d.status)
                        self._on_package_status(d.name, token, STATUS_TEXT[token])
            else:
                self.banner_title.setText("Repair did NOT complete cleanly")
                self.banner_detail.setText(result.summary or "See the live log for details.")
                self.statusBar().showMessage(
                    "Read the log on the right; logs/pip/ contains the full transcript."
                )
                self.step_label.setText("Step 5 of 5 — verification failed ✗")
                self.repair_btn.setEnabled(True)  # let user retry

        @Slot(str)
        def _on_fatal(self, message: str) -> None:
            self.banner_title.setText("Safe-mode crashed")
            self.banner_detail.setText(message[:400])
            self.statusBar().showMessage("Fatal error — see live log.")
            self.close_btn.setEnabled(True)
            self.repair_btn.setEnabled(False)

        # ─── helpers ──────────────────────────────────────────────
        def _diff_status_token(self, status) -> str:
            if status == PackageStatus.OK:
                return STATUS_OK
            if status == PackageStatus.MISSING:
                return STATUS_MISSING
            if status == PackageStatus.WRONG_VERSION:
                return STATUS_WRONG
            return STATUS_PENDING

        def _add_checklist_row(self, *, name: str, required: str, installed: str, token: str, detail: str) -> None:
            item = QTreeWidgetItem([STATUS_ICON.get(token, "?"), name, required, detail])
            self.checklist.addTopLevelItem(item)
            colour = STATUS_COLOUR.get(token)
            if colour:
                item.setForeground(0, QBrush(colour))
                item.setForeground(3, QBrush(colour))
            self._diff_rows[name.lower()] = item

        def _open_logs_folder(self) -> None:
            from PySide6.QtCore import QUrl
            from PySide6.QtGui import QDesktopServices
            target = here / "logs" / "pip"
            target.mkdir(parents=True, exist_ok=True)
            QDesktopServices.openUrl(QUrl.fromLocalFile(str(target)))

        def _kickoff_probe(self) -> None:
            self.statusBar().showMessage("Resolving env …")
            self.step_label.setText("Step 1 of 5 — resolving environment")
            self.progress.setValue(5)

            def _emit(line: str) -> None:
                self._bridge.log_line.emit(line)

            def _worker() -> None:
                try:
                    env = get_owllm_env(here)
                    pid = resolve_profile_id(env.env_key, project_root=here)
                    self._env_python = env.python_exe
                    self._env_id = pid
                    _emit(f"[safe-mode] workload venv: {env.python_exe}")
                    _emit(f"[safe-mode] env_key:       {env.env_key}")
                    _emit(f"[safe-mode] profile id:    {pid}")
                    repairer = EnvRepairer(project_root=here)
                    self._repairer = repairer
                    self._bridge.repair_progress.emit(
                        "Step 2 of 5 — probing torch + diffing required packages …", 12,
                    )
                    result = repairer.probe(
                        env_python=env.python_exe,
                        env_id=pid,
                        extras=self._extras,
                        log=_emit,
                    )
                    self._bridge.probe_done.emit(result)
                except Exception as exc:
                    import traceback as tb
                    _emit(f"[safe-mode] FATAL during probe: {type(exc).__name__}: {exc}")
                    _emit(tb.format_exc())
                    self._bridge.fatal.emit(f"{type(exc).__name__}: {exc}")

            threading.Thread(target=_worker, name="safe-mode-probe", daemon=True).start()

        def _on_repair_clicked(self) -> None:
            if self._repair_thread and self._repair_thread.is_alive():
                return
            self._bridge.repair_started.emit()

            def _emit(line: str) -> None:
                self._bridge.log_line.emit(line)
                # Mirror live pip output into the per-package row when
                # we can recognise a 'Collecting <pkg>' line — gives the
                # checklist some life during the install pass.
                lower = line.lower()
                # 'collecting transformers' or 'requirement already satisfied: numpy ...'
                if "collecting " in lower:
                    pkg = lower.split("collecting ", 1)[1].split()[0]
                    pkg = pkg.strip().rstrip(",;").split("=")[0].split(">")[0].split("<")[0]
                    self._bridge.package_status.emit(pkg, STATUS_INSTALLING, "Downloading…")
                elif "successfully installed" in lower:
                    rest = lower.split("successfully installed", 1)[1]
                    for tok in rest.split():
                        name_part = tok.split("-")[0]
                        if name_part:
                            self._bridge.package_status.emit(name_part, STATUS_OK, "Installed")

            def _worker() -> None:
                try:
                    self._bridge.repair_progress.emit(
                        "Step 3 of 5 — running pip install / verify …", 45,
                    )
                    result = self._repairer.repair(
                        env_python=self._env_python,
                        env_id=self._env_id,
                        extras=self._extras,
                        log=_emit,
                    )
                    self._bridge.repair_progress.emit(
                        "Step 4 of 5 — re-probing torch …", 80,
                    )
                    self._bridge.repair_done.emit(result)
                except Exception as exc:
                    import traceback as tb
                    _emit(f"[safe-mode] FATAL during repair: {type(exc).__name__}: {exc}")
                    _emit(tb.format_exc())
                    self._bridge.fatal.emit(f"{type(exc).__name__}: {exc}")

            t = threading.Thread(target=_worker, name="safe-mode-repair", daemon=True)
            self._repair_thread = t
            t.start()

    app = QApplication.instance() or QApplication(sys.argv)
    win = _SafeModeWindow()
    win.show()
    app.exec()
    return win._rc


if __name__ == "__main__":
    sys.exit(run_qt_window(Path(__file__).resolve().parents[1]))
