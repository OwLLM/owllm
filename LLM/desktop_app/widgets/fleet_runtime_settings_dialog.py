"""Runtime settings — pick + tune the active fleet runtime.

Slice 5a. Surfaces the constructor knobs of
:class:`core.fleet.ContainerRuntime` (image / network / auth-mount
defaults / per-module enforcement) as a form so the team can switch
isolation modes without writing Python.

Container-specific fields hide when the user picks Worktree, and a
warning banner appears when Container is selected but Docker isn't
available on the host (instead of silently falling back at apply
time, the user sees the situation up front).

Custom auth mount entries (extra_auth_mounts) are advanced — the
JSON file at ``<fleet_root>/runtime.json`` is the source of truth
for those; this dialog deliberately doesn't surface them in slice
5a to keep the form approachable. Toggling "Use default auth
mounts" preserves any custom mounts already in the config.
"""
from __future__ import annotations

import logging
from typing import Callable, Optional

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QVBoxLayout,
    QWidget,
)

from core.fleet.container_runtime import (
    DEFAULT_IMAGE,
    NETWORK_BRIDGE,
    NETWORK_HOST,
    NETWORK_NONE,
    ContainerRuntime,
)
from core.fleet.runtime_config import (
    KIND_CONTAINER,
    KIND_WORKTREE,
    RuntimeConfig,
)

logger = logging.getLogger(__name__)


_DIALOG_QSS = """
QDialog#FleetRuntimeSettingsDialog { background-color: #0a0d14; }
QLabel#header { color: #e6f0ff; font-size: 13px; font-weight: 600; }
QLabel#hint   { color: #7888a8; font-size: 10px; }
QLabel#warning {
    color: #ffc060;
    background: #2a1f0d;
    border: 1px solid #ffc060;
    border-radius: 4px;
    padding: 6px 10px;
    font-size: 11px;
}
QLineEdit, QComboBox {
    background-color: #12161f;
    color: #c4d0e8;
    border: 1px solid #2a3148;
    border-radius: 4px;
    padding: 4px 6px;
}
QLineEdit:disabled, QComboBox:disabled { color: #7888a8; }
QCheckBox { color: #c4d0e8; }
QCheckBox:disabled { color: #7888a8; }
QPushButton {
    color: #e6f0ff;
    background-color: #1a2030;
    border: 1px solid #2a3148;
    border-radius: 6px;
    padding: 5px 12px;
    font-size: 11px;
}
QPushButton:hover { background-color: #232a40; border-color: #5cf0ff; }
QPushButton#primaryButton {
    color: #0a0d14;
    background-color: #5cf0ff;
    border-color: #5cf0ff;
}
"""


# (label, value) pairs — value of "" means "no flag, let docker pick".
_NETWORK_CHOICES = [
    ("Default (bridge)", ""),
    ("bridge", NETWORK_BRIDGE),
    ("host", NETWORK_HOST),
    ("none — offline", NETWORK_NONE),
]


class FleetRuntimeSettingsDialog(QDialog):
    """Form-driven editor for :class:`RuntimeConfig`.

    ``loader`` returns the current config; ``apply`` is called with
    the dialog's edited config when the user clicks Save. Both are
    callables so the dialog doesn't have to know about FleetService.
    """

    config_applied = Signal()

    def __init__(
        self,
        loader: Callable[[], RuntimeConfig],
        apply: Callable[[RuntimeConfig], None],
        parent: Optional[QWidget] = None,
    ):
        super().__init__(parent)
        self.setObjectName("FleetRuntimeSettingsDialog")
        self.setStyleSheet(_DIALOG_QSS)
        self.setWindowTitle("Fleet runtime settings")
        self.setMinimumWidth(540)
        self.setModal(False)
        self.setAttribute(Qt.WA_DeleteOnClose)

        self._loader = loader
        self._apply = apply
        self._loaded = loader()

        self._build_ui()
        self._populate_from(self._loaded)

    def _build_ui(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(16, 14, 16, 14)
        outer.setSpacing(10)

        title = QLabel("Runtime")
        title.setObjectName("header")
        outer.addWidget(title)

        self._kind = QComboBox()
        self._kind.addItem("Worktree (host filesystem)", KIND_WORKTREE)
        self._kind.addItem("Container (Docker isolation)", KIND_CONTAINER)
        self._kind.currentIndexChanged.connect(self._on_kind_changed)

        self._image = QLineEdit(DEFAULT_IMAGE)

        self._network = QComboBox()
        for label, value in _NETWORK_CHOICES:
            self._network.addItem(label, value)

        self._auth_mounts = QCheckBox(
            "Mount common CLI auth dirs (~/.claude, ~/.config/codex, …) read-only"
        )

        self._enforce_modules = QCheckBox(
            "Enforce per-module mounts (whole clone ro + owns_modules rw)"
        )

        # Warning banner (shown only when Docker isn't available).
        self._warning = QLabel(
            "⚠  Docker isn't available on this host. The container "
            "runtime will silently fall back to Worktree at spawn time. "
            "Install Docker Desktop or pick Worktree to dismiss."
        )
        self._warning.setObjectName("warning")
        self._warning.setWordWrap(True)
        self._warning.hide()

        form = QFormLayout()
        form.addRow("kind", self._kind)
        form.addRow(self._warning)
        form.addRow("image", self._image)
        form.addRow("network", self._network)
        form.addRow(self._auth_mounts)
        form.addRow(self._enforce_modules)
        outer.addLayout(form)

        hint = QLabel(
            "Custom mount entries can be added to "
            "<code>&lt;fleet_root&gt;/runtime.json</code> directly. "
            "Changes take effect on the next spawn — running agents "
            "keep the runtime they started with."
        )
        hint.setObjectName("hint")
        hint.setWordWrap(True)
        outer.addWidget(hint)

        buttons = QDialogButtonBox(
            QDialogButtonBox.Ok | QDialogButtonBox.Cancel
        )
        save_btn = buttons.button(QDialogButtonBox.Ok)
        save_btn.setText("Apply")
        save_btn.setObjectName("primaryButton")
        buttons.accepted.connect(self._on_apply)
        buttons.rejected.connect(self.close)
        outer.addWidget(buttons)

    # ------------------------------------------------------------------
    # State sync
    # ------------------------------------------------------------------

    def _populate_from(self, cfg: RuntimeConfig) -> None:
        kind_idx = 0 if cfg.kind == KIND_WORKTREE else 1
        self._kind.setCurrentIndex(kind_idx)
        self._image.setText(cfg.image)
        for i in range(self._network.count()):
            if self._network.itemData(i) == (cfg.network or ""):
                self._network.setCurrentIndex(i)
                break
        self._auth_mounts.setChecked(cfg.use_default_auth_mounts)
        self._enforce_modules.setChecked(cfg.enforce_module_mounts)
        self._on_kind_changed(kind_idx)

    def _on_kind_changed(self, idx: int) -> None:
        is_container = (self._kind.currentData() == KIND_CONTAINER)
        for w in (
            self._image, self._network,
            self._auth_mounts, self._enforce_modules,
        ):
            w.setEnabled(is_container)
        self._warning.setVisible(
            is_container and not ContainerRuntime.is_available()
        )

    # ------------------------------------------------------------------
    # Apply
    # ------------------------------------------------------------------

    def _on_apply(self) -> None:
        kind = self._kind.currentData()
        net_value = self._network.currentData()
        cfg = RuntimeConfig(
            kind=kind,
            image=self._image.text().strip() or DEFAULT_IMAGE,
            network=(net_value or None),
            use_default_auth_mounts=self._auth_mounts.isChecked(),
            extra_auth_mounts=list(self._loaded.extra_auth_mounts),
            enforce_module_mounts=self._enforce_modules.isChecked(),
        )
        try:
            self._apply(cfg)
        except Exception as e:
            logger.warning("apply runtime config failed: %s", e)
            QMessageBox.warning(
                self, "Could not apply runtime", str(e),
            )
            return
        self.config_applied.emit()
        self.close()
