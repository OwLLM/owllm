"""Spawn-an-agent dialog.

Slice 2a is a plain QFormLayout with the raw fields a power user wants
exposed: target repo, branch, owns/reads globs, reason, ttl, optional
port/gpu pins. No profile picker yet — that comes in slice 2b once
profiles exist.

The dialog never touches the broker. On Accept it returns a dict via
:meth:`spawn_kwargs`; the caller (the page) feeds that to
:meth:`FleetService.spawn_async`.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPlainTextEdit,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)


_HELP_OWNS = (
    "One glob per line. The agent may edit only files matched by these "
    "patterns. Examples:\n"
    "    src/billing/**\n"
    "    tests/billing/**"
)


_HELP_READS = (
    "Optional. Globs the agent may read but not edit (advisory; not "
    "enforced in slice 1)."
)


class FleetSpawnDialog(QDialog):
    """Form for ``FleetService.spawn_async`` arguments."""

    def __init__(self, parent: Optional[QWidget] = None):
        super().__init__(parent)
        self.setWindowTitle("Spawn fleet agent")
        self.setMinimumWidth(540)

        self._target_repo = QLineEdit()
        self._target_repo.setPlaceholderText(
            "git URL or local path, e.g. https://github.com/me/alpha.git"
        )

        self._branch = QLineEdit()
        self._branch.setPlaceholderText("agent/billing-refunds")

        self._base_branch = QLineEdit("main")

        self._owns = QPlainTextEdit()
        self._owns.setPlaceholderText("src/billing/**\ntests/billing/**")
        self._owns.setFixedHeight(80)

        self._reads = QPlainTextEdit()
        self._reads.setPlaceholderText("src/platform/**")
        self._reads.setFixedHeight(60)

        self._reason = QLineEdit()
        self._reason.setPlaceholderText("implement refund flow")

        self._agent_id = QLineEdit()
        self._agent_id.setPlaceholderText("(auto-generated if empty)")

        self._ttl = QSpinBox()
        self._ttl.setRange(60, 24 * 3600)
        self._ttl.setSingleStep(60)
        self._ttl.setValue(3600)
        self._ttl.setSuffix(" s")

        self._pin_port = QCheckBox("pin port")
        self._port = QSpinBox()
        self._port.setRange(1, 65535)
        self._port.setValue(8081)
        self._port.setEnabled(False)
        self._pin_port.toggled.connect(self._port.setEnabled)

        self._pin_gpu = QCheckBox("pin gpu slot")
        self._gpu = QSpinBox()
        self._gpu.setRange(0, 16)
        self._gpu.setValue(0)
        self._gpu.setEnabled(False)
        self._pin_gpu.toggled.connect(self._gpu.setEnabled)

        form = QFormLayout()
        form.addRow("target repo *", self._target_repo)
        form.addRow("branch *", self._branch)
        form.addRow("base branch", self._base_branch)
        form.addRow("owns (one glob per line) *", self._owns)
        owns_help = QLabel(_HELP_OWNS)
        owns_help.setStyleSheet("color: #7888a8; font-size: 10px;")
        form.addRow("", owns_help)
        form.addRow("reads (optional)", self._reads)
        reads_help = QLabel(_HELP_READS)
        reads_help.setStyleSheet("color: #7888a8; font-size: 10px;")
        form.addRow("", reads_help)
        form.addRow("reason", self._reason)
        form.addRow("agent id", self._agent_id)
        form.addRow("ttl", self._ttl)
        form.addRow(self._pin_port, self._port)
        form.addRow(self._pin_gpu, self._gpu)

        buttons = QDialogButtonBox(
            QDialogButtonBox.Ok | QDialogButtonBox.Cancel
        )
        buttons.button(QDialogButtonBox.Ok).setText("Spawn")
        buttons.accepted.connect(self._on_accept)
        buttons.rejected.connect(self.reject)

        outer = QVBoxLayout(self)
        outer.addLayout(form)
        outer.addWidget(buttons)

    # ------------------------------------------------------------------
    # Public
    # ------------------------------------------------------------------

    def spawn_kwargs(self) -> Dict[str, Any]:
        """Return a kwargs dict suitable for ``FleetService.spawn_async``.

        Only call after ``exec()`` returned ``Accepted``.
        """
        owns = _split_lines(self._owns.toPlainText())
        reads = _split_lines(self._reads.toPlainText())
        kwargs: Dict[str, Any] = {
            "target_repo": self._target_repo.text().strip(),
            "branch": self._branch.text().strip(),
            "owns_modules": owns,
            "reads_modules": reads,
            "reason": self._reason.text().strip(),
            "ttl_seconds": int(self._ttl.value()),
            "base_branch": (self._base_branch.text().strip() or "main"),
        }
        agent_id = self._agent_id.text().strip()
        if agent_id:
            kwargs["agent_id"] = agent_id
        if self._pin_port.isChecked():
            kwargs["port"] = int(self._port.value())
        if self._pin_gpu.isChecked():
            kwargs["gpu_slot"] = int(self._gpu.value())
        return kwargs

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------

    def _on_accept(self) -> None:
        problems = self._validate()
        if problems:
            QMessageBox.warning(
                self, "Fix the form first", "\n".join(f"• {p}" for p in problems),
            )
            return
        self.accept()

    def _validate(self) -> List[str]:
        problems: List[str] = []
        if not self._target_repo.text().strip():
            problems.append("target repo is required")
        if not self._branch.text().strip():
            problems.append("branch is required")
        owns = _split_lines(self._owns.toPlainText())
        if not owns:
            problems.append("at least one owns glob is required")
        return problems


def _split_lines(text: str) -> List[str]:
    return [line.strip() for line in text.splitlines() if line.strip()]
