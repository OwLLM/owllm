"""Master-detail editor for custom fleet profiles.

Slice 4-a. Read-only view of built-ins + create/edit/delete for
custom profiles in ``<fleet_root>/profiles/``. The next time the
user opens the spawn dialog, the profile picker repopulates from
the store, so no signal wiring is needed to propagate changes —
the spawn dialog reads fresh on every open.
"""
from __future__ import annotations

import logging
from typing import Optional

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QSizePolicy,
    QSpinBox,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from core.fleet.profiles import BUILTIN_PROFILES, Profile, ProfileStore

logger = logging.getLogger(__name__)


_DIALOG_QSS = """
QDialog#FleetProfileEditor {
    background-color: #0a0d14;
}
QLabel#title {
    color: #e6f0ff;
    font-size: 13px;
    font-weight: 600;
}
QLabel#subtitle {
    color: #7888a8;
    font-size: 11px;
}
QLabel#builtinBadge {
    color: #ffc060;
    font-size: 10px;
    font-weight: 700;
}
QListWidget {
    background-color: #12161f;
    color: #c4d0e8;
    border: 1px solid #2a3148;
    border-radius: 6px;
    padding: 4px;
    font-size: 12px;
}
QListWidget::item:selected {
    background-color: #2a3148;
    color: #e6f0ff;
}
QLineEdit, QPlainTextEdit, QSpinBox {
    background-color: #12161f;
    color: #c4d0e8;
    border: 1px solid #2a3148;
    border-radius: 4px;
    padding: 3px 6px;
    selection-background-color: #2a3148;
}
QPushButton {
    color: #e6f0ff;
    background-color: #1a2030;
    border: 1px solid #2a3148;
    border-radius: 6px;
    padding: 5px 12px;
    font-size: 11px;
}
QPushButton:hover {
    background-color: #232a40;
    border-color: #5cf0ff;
}
QPushButton#primary {
    color: #0a0d14;
    background-color: #5cf0ff;
    border-color: #5cf0ff;
}
QPushButton#primary:hover {
    background-color: #74f4ff;
}
QPushButton#danger {
    color: #ff7878;
    border-color: #ff7878;
}
QPushButton#danger:hover {
    background-color: #2a1a1a;
}
"""


class FleetProfileEditor(QDialog):
    """Browse / create / edit / delete fleet spawn profiles."""

    profiles_changed = Signal()

    def __init__(
        self,
        store: Optional[ProfileStore] = None,
        parent: Optional[QWidget] = None,
    ):
        super().__init__(parent)
        self.setObjectName("FleetProfileEditor")
        self.setStyleSheet(_DIALOG_QSS)
        self.setWindowTitle("Fleet profiles")
        self.setMinimumSize(820, 540)
        self.setModal(False)
        self.setAttribute(Qt.WA_DeleteOnClose)

        self._store = store or ProfileStore()
        self._loaded: Optional[Profile] = None

        self._build_ui()
        self._reload_list()

    # ------------------------------------------------------------------
    # Build
    # ------------------------------------------------------------------

    def _build_ui(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(16, 14, 16, 14)
        outer.setSpacing(8)

        title = QLabel("Profiles")
        title.setObjectName("title")
        outer.addWidget(title)

        subtitle = QLabel(
            "Built-ins are read-only. Save creates a custom profile under "
            "&lt;fleet_root&gt;/profiles/."
        )
        subtitle.setObjectName("subtitle")
        outer.addWidget(subtitle)

        splitter = QSplitter(Qt.Horizontal, self)

        # ---- Left: list ----
        left = QWidget()
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(0, 0, 0, 0)
        left_layout.setSpacing(6)
        self._list = QListWidget()
        self._list.currentItemChanged.connect(self._on_list_selection_changed)
        left_layout.addWidget(self._list, 1)

        list_buttons = QHBoxLayout()
        list_buttons.setSpacing(6)
        new_btn = QPushButton("New")
        new_btn.clicked.connect(self._on_new)
        list_buttons.addWidget(new_btn)
        dup_btn = QPushButton("Duplicate")
        dup_btn.clicked.connect(self._on_duplicate)
        list_buttons.addWidget(dup_btn)
        list_buttons.addStretch(1)
        left_layout.addLayout(list_buttons)

        splitter.addWidget(left)

        # ---- Right: form ----
        right = QWidget()
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(0, 0, 0, 0)
        right_layout.setSpacing(8)

        self._builtin_badge = QLabel("BUILT-IN  ·  read-only")
        self._builtin_badge.setObjectName("builtinBadge")
        self._builtin_badge.hide()
        right_layout.addWidget(self._builtin_badge)

        self._name = QLineEdit()
        self._name.setPlaceholderText("team-lead")
        self._description = QLineEdit()
        self._description.setPlaceholderText("Owns the platform layer")
        self._icon = QLineEdit()
        self._icon.setPlaceholderText("👑")
        self._owns = QPlainTextEdit()
        self._owns.setPlaceholderText("src/platform/**\ntests/platform/**")
        self._owns.setFixedHeight(70)
        self._reads = QPlainTextEdit()
        self._reads.setPlaceholderText("src/**")
        self._reads.setFixedHeight(60)
        self._launch = QPlainTextEdit()
        self._launch.setPlaceholderText(
            "claude\n-p\nfollow AGENT_CONTEXT.md\n\n"
            "(one argv element per line; empty = workspace-only spawn)"
        )
        self._launch.setFixedHeight(80)
        self._reason = QLineEdit()
        self._ttl = QSpinBox()
        self._ttl.setRange(60, 24 * 3600)
        self._ttl.setSingleStep(60)
        self._ttl.setValue(3600)
        self._ttl.setSuffix(" s")
        self._base_branch = QLineEdit("main")

        form = QFormLayout()
        form.addRow("name *", self._name)
        form.addRow("description", self._description)
        form.addRow("icon (emoji)", self._icon)
        form.addRow("owns (one glob per line)", self._owns)
        form.addRow("reads", self._reads)
        form.addRow("launch_command (argv per line)", self._launch)
        form.addRow("default reason", self._reason)
        form.addRow("ttl", self._ttl)
        form.addRow("base branch", self._base_branch)
        right_layout.addLayout(form)
        right_layout.addStretch(1)

        # ---- Right footer ----
        right_footer = QHBoxLayout()
        right_footer.setSpacing(6)
        self._save_btn = QPushButton("Save")
        self._save_btn.setObjectName("primary")
        self._save_btn.clicked.connect(self._on_save)
        right_footer.addWidget(self._save_btn)
        self._delete_btn = QPushButton("Delete")
        self._delete_btn.setObjectName("danger")
        self._delete_btn.clicked.connect(self._on_delete)
        right_footer.addWidget(self._delete_btn)
        right_footer.addStretch(1)
        close_btn = QPushButton("Close")
        close_btn.clicked.connect(self.close)
        right_footer.addWidget(close_btn)
        right_layout.addLayout(right_footer)

        splitter.addWidget(right)
        splitter.setSizes([260, 540])
        outer.addWidget(splitter, 1)

    # ------------------------------------------------------------------
    # List management
    # ------------------------------------------------------------------

    def _reload_list(self) -> None:
        prev_name = self._loaded.name if self._loaded else None
        self._list.blockSignals(True)
        self._list.clear()
        for p in self._store.list_all():
            label = f"{p.icon}  {p.name}"
            if p.built_in:
                label += "  (built-in)"
            item = QListWidgetItem(label)
            item.setData(Qt.UserRole, p)
            self._list.addItem(item)
        # Try to keep the previously-loaded profile selected.
        target_row = 0
        if prev_name:
            for row in range(self._list.count()):
                p = self._list.item(row).data(Qt.UserRole)
                if isinstance(p, Profile) and p.name == prev_name:
                    target_row = row
                    break
        self._list.setCurrentRow(target_row)
        self._list.blockSignals(False)
        # Apply the (possibly changed) selection now.
        cur = self._list.currentItem()
        if cur is not None:
            self._on_list_selection_changed(cur, None)

    def _on_list_selection_changed(
        self,
        current: Optional[QListWidgetItem],
        _previous: Optional[QListWidgetItem],
    ) -> None:
        if current is None:
            self._loaded = None
            return
        profile = current.data(Qt.UserRole)
        if isinstance(profile, Profile):
            self._load_into_form(profile)

    # ------------------------------------------------------------------
    # Form ↔ profile mapping
    # ------------------------------------------------------------------

    def _load_into_form(self, profile: Profile) -> None:
        self._loaded = profile
        self._name.setText(profile.name)
        self._description.setText(profile.description)
        self._icon.setText(profile.icon)
        self._owns.setPlainText("\n".join(profile.owns_modules))
        self._reads.setPlainText("\n".join(profile.reads_modules))
        self._launch.setPlainText("\n".join(profile.launch_command))
        self._reason.setText(profile.default_reason)
        self._ttl.setValue(profile.ttl_seconds)
        self._base_branch.setText(profile.base_branch)
        self._set_readonly(profile.built_in)

    def _set_readonly(self, ro: bool) -> None:
        self._builtin_badge.setVisible(ro)
        for w in (
            self._name, self._description, self._icon, self._owns,
            self._reads, self._launch, self._reason, self._base_branch,
        ):
            w.setReadOnly(ro)
        self._ttl.setReadOnly(ro)
        self._save_btn.setEnabled(not ro)
        self._delete_btn.setEnabled(not ro)

    def _form_to_profile(self) -> Profile:
        return Profile(
            name=self._name.text().strip(),
            description=self._description.text().strip(),
            icon=self._icon.text().strip() or "🤖",
            owns_modules=tuple(_lines(self._owns.toPlainText())),
            reads_modules=tuple(_lines(self._reads.toPlainText())),
            launch_command=tuple(_lines(self._launch.toPlainText())),
            default_reason=self._reason.text().strip(),
            ttl_seconds=int(self._ttl.value()),
            base_branch=(self._base_branch.text().strip() or "main"),
            built_in=False,
        )

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------

    def _on_new(self) -> None:
        self._loaded = None
        self._set_readonly(False)
        self._name.clear()
        self._description.clear()
        self._icon.clear()
        self._owns.clear()
        self._reads.clear()
        self._launch.clear()
        self._reason.clear()
        self._ttl.setValue(3600)
        self._base_branch.setText("main")
        self._list.clearSelection()
        self._name.setFocus()

    def _on_duplicate(self) -> None:
        cur = self._list.currentItem()
        if cur is None:
            return
        src = cur.data(Qt.UserRole)
        if not isinstance(src, Profile):
            return
        # Same fields, but make the user pick a new name. Built-ins
        # become editable here because the duplicate is born custom.
        self._loaded = None
        self._set_readonly(False)
        self._name.clear()
        self._description.setText(src.description)
        self._icon.setText(src.icon)
        self._owns.setPlainText("\n".join(src.owns_modules))
        self._reads.setPlainText("\n".join(src.reads_modules))
        self._launch.setPlainText("\n".join(src.launch_command))
        self._reason.setText(src.default_reason)
        self._ttl.setValue(src.ttl_seconds)
        self._base_branch.setText(src.base_branch)
        self._list.clearSelection()
        self._name.setFocus()

    def _on_save(self) -> None:
        profile = self._form_to_profile()
        try:
            saved = self._store.save(profile)
        except ValueError as e:
            QMessageBox.warning(self, "Cannot save profile", str(e))
            return
        self._loaded = saved
        self.profiles_changed.emit()
        self._reload_list()

    def _on_delete(self) -> None:
        if self._loaded is None or self._loaded.built_in:
            return
        confirm = QMessageBox.question(
            self,
            "Delete profile?",
            f"Permanently delete the custom profile '{self._loaded.name}'?",
            QMessageBox.Ok | QMessageBox.Cancel,
            QMessageBox.Cancel,
        )
        if confirm != QMessageBox.Ok:
            return
        if self._store.delete(self._loaded.name):
            self._loaded = None
            self.profiles_changed.emit()
            self._reload_list()


def _lines(text: str) -> list[str]:
    return [line.strip() for line in text.splitlines() if line.strip()]
