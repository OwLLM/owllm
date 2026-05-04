"""Skill Library dialog — browse and install community SKILL.md packs.

Opened from the 🎭 Studio page's header. Lists each curated source from
:data:`core.agents.skill_sources.KNOWN_SOURCES`, lets the user fetch
(shallow-clone), then displays the discovered skills as a checklist for
one-click install.

The dialog is intentionally chunky — fetching does network IO and the
user expects clear feedback. Errors surface inline (status label below
the button) instead of as message boxes so they don't block batch work.
"""
from __future__ import annotations

import logging
from typing import Dict, List, Optional

from PySide6.QtCore import Qt, QThread, Signal
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from core.agents.skill_sources import (
    KNOWN_SOURCES,
    DiscoveredSkill,
    SkillSource,
    custom_source_from_url,
    discover_skills,
    fetch_source,
    install_skill,
    list_installed_remote_folders,
    uninstall_skill,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Background workers
# ---------------------------------------------------------------------------


class _FetchWorker(QThread):
    """Shallow-clone (or refresh) one source off the UI thread."""

    finished_ok = Signal(object, list)  # SkillSource, List[DiscoveredSkill]
    failed = Signal(object, str)        # SkillSource, error message

    def __init__(self, source: SkillSource, *, force: bool = False) -> None:
        super().__init__()
        self._source = source
        self._force = force

    def run(self) -> None:  # noqa: D401
        try:
            fetch_source(self._source, force=self._force)
            skills = discover_skills(self._source)
            self.finished_ok.emit(self._source, skills)
        except Exception as exc:  # noqa: BLE001
            self.failed.emit(self._source, str(exc))


# ---------------------------------------------------------------------------
# Dialog
# ---------------------------------------------------------------------------


class SkillLibraryDialog(QDialog):
    """Modal dialog. Emits no signals — the caller refreshes after ``exec()``."""

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("Skill Library")
        self.resize(720, 560)

        self._current_source: Optional[SkillSource] = None
        self._skill_checks: Dict[str, tuple[QCheckBox, DiscoveredSkill]] = {}
        self._fetch_worker: Optional[_FetchWorker] = None
        self._installed_count = 0

        self._build_ui()
        # Auto-select the first source so the dialog isn't empty on open.
        if KNOWN_SOURCES:
            self.source_combo.setCurrentIndex(0)
            self._on_source_changed(0)

    # ------------------------------------------------------------------
    # UI
    # ------------------------------------------------------------------

    def _build_ui(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(20, 18, 20, 18)
        outer.setSpacing(14)

        title = QLabel("Skill Library")
        tf = QFont()
        tf.setPointSize(18)
        tf.setBold(True)
        title.setFont(tf)
        outer.addWidget(title)

        sub = QLabel(
            "Install community SKILL.md packs from curated git sources. "
            "Anthropic-style tool names are rewritten to OWLLM equivalents "
            "automatically (e.g. <b>Read</b> → <b>read_file</b>)."
        )
        sub.setWordWrap(True)
        sub.setStyleSheet("color:#9aa0a6; font-size:12px;")
        outer.addWidget(sub)

        # Source picker row.
        src_row = QHBoxLayout()
        src_row.setSpacing(8)
        src_row.addWidget(QLabel("Source:"))
        self.source_combo = QComboBox()
        for s in KNOWN_SOURCES:
            self.source_combo.addItem(s.label, userData=s)
        self.source_combo.addItem("➕ Custom git URL…", userData=None)
        self.source_combo.currentIndexChanged.connect(self._on_source_changed)
        src_row.addWidget(self.source_combo, 1)

        self.fetch_btn = QPushButton("Fetch / refresh")
        self.fetch_btn.clicked.connect(self._on_fetch_clicked)
        src_row.addWidget(self.fetch_btn)
        outer.addLayout(src_row)

        # Custom URL input (hidden unless "Custom" is picked).
        self.custom_url_input = QLineEdit()
        self.custom_url_input.setPlaceholderText("https://github.com/owner/repo.git")
        self.custom_url_input.setVisible(False)
        outer.addWidget(self.custom_url_input)

        # Description / status.
        self.desc_label = QLabel("")
        self.desc_label.setWordWrap(True)
        self.desc_label.setStyleSheet("color:#9aa0a6; font-size:11px;")
        outer.addWidget(self.desc_label)

        self.progress = QProgressBar()
        self.progress.setRange(0, 0)  # indeterminate
        self.progress.setVisible(False)
        outer.addWidget(self.progress)

        self.status_label = QLabel("")
        self.status_label.setWordWrap(True)
        self.status_label.setStyleSheet("color:#ffb86b; font-size:11px;")
        outer.addWidget(self.status_label)

        # Skill list.
        list_host = QScrollArea()
        list_host.setWidgetResizable(True)
        list_host.setFrameShape(QFrame.NoFrame)
        self.list_widget = QWidget()
        self.list_layout = QVBoxLayout(self.list_widget)
        self.list_layout.setContentsMargins(0, 0, 0, 0)
        self.list_layout.setSpacing(6)
        self.list_layout.addStretch(1)
        list_host.setWidget(self.list_widget)
        outer.addWidget(list_host, 1)

        # Action row.
        actions = QHBoxLayout()
        actions.setSpacing(8)
        self.select_all_btn = QPushButton("Select all")
        self.select_all_btn.clicked.connect(lambda: self._set_all_checked(True))
        actions.addWidget(self.select_all_btn)
        self.select_none_btn = QPushButton("Select none")
        self.select_none_btn.clicked.connect(lambda: self._set_all_checked(False))
        actions.addWidget(self.select_none_btn)
        actions.addStretch(1)

        installed_btn = QPushButton("Manage installed…")
        installed_btn.clicked.connect(self._show_installed)
        actions.addWidget(installed_btn)

        self.install_btn = QPushButton("Install selected")
        self.install_btn.setStyleSheet(
            "QPushButton { background:#4a6cff; color:white; border:none;"
            " border-radius:8px; padding:6px 18px; font-weight:600; }"
            "QPushButton:hover { background:#5a7bff; }"
            "QPushButton:disabled { background:#2c313c; color:#777; }"
        )
        self.install_btn.clicked.connect(self._on_install_clicked)
        self.install_btn.setEnabled(False)
        actions.addWidget(self.install_btn)

        close_btn = QPushButton("Close")
        close_btn.clicked.connect(self.accept)
        actions.addWidget(close_btn)
        outer.addLayout(actions)

    # ------------------------------------------------------------------
    # Slots
    # ------------------------------------------------------------------

    def _on_source_changed(self, idx: int) -> None:
        data = self.source_combo.itemData(idx)
        is_custom = data is None
        self.custom_url_input.setVisible(is_custom)
        if isinstance(data, SkillSource):
            self._current_source = data
            self.desc_label.setText(data.description or data.git_url)
        else:
            self._current_source = None
            self.desc_label.setText("Paste a git URL, then click Fetch.")
        self._clear_skills()
        self.status_label.setText("")
        self.install_btn.setEnabled(False)

    def _on_fetch_clicked(self) -> None:
        source = self._current_source
        if source is None:
            url = self.custom_url_input.text().strip()
            if not url:
                self.status_label.setText("Enter a git URL first.")
                return
            source = custom_source_from_url(url)

        if self._fetch_worker is not None and self._fetch_worker.isRunning():
            return

        self.progress.setVisible(True)
        self.status_label.setText(f"Fetching {source.git_url}…")
        self.fetch_btn.setEnabled(False)
        self.install_btn.setEnabled(False)
        self._clear_skills()

        worker = _FetchWorker(source, force=False)
        worker.finished_ok.connect(self._on_fetch_done)
        worker.failed.connect(self._on_fetch_failed)
        worker.finished.connect(worker.deleteLater)
        self._fetch_worker = worker
        worker.start()

    def _on_fetch_done(self, source: SkillSource, skills: List[DiscoveredSkill]) -> None:
        self.progress.setVisible(False)
        self.fetch_btn.setEnabled(True)
        if not skills:
            self.status_label.setText(
                f"Fetched {source.git_url} but no SKILL.md files were found."
            )
            return
        self.status_label.setText(f"Found {len(skills)} skill(s) in {source.label}.")
        self._populate_skills(skills)

    def _on_fetch_failed(self, source: SkillSource, message: str) -> None:
        self.progress.setVisible(False)
        self.fetch_btn.setEnabled(True)
        self.status_label.setText(f"Fetch failed: {message}")

    def _on_install_clicked(self) -> None:
        chosen: List[DiscoveredSkill] = [
            sk for (cb, sk) in self._skill_checks.values() if cb.isChecked()
        ]
        if not chosen:
            self.status_label.setText("Nothing selected.")
            return

        installed = 0
        errors: List[str] = []
        for sk in chosen:
            try:
                install_skill(sk)
                installed += 1
            except Exception as exc:  # noqa: BLE001
                logger.exception("install failed for %s", sk.name)
                errors.append(f"{sk.name}: {exc}")

        self._installed_count += installed
        msg = f"Installed {installed} skill(s)."
        if errors:
            msg += f" {len(errors)} failed."
        self.status_label.setText(msg)
        if errors:
            QMessageBox.warning(self, "Some installs failed", "\n".join(errors))

    def _show_installed(self) -> None:
        folders = list_installed_remote_folders()
        if not folders:
            QMessageBox.information(
                self,
                "Installed skills",
                "No remote skills are installed yet.",
            )
            return
        # Tiny inline picker — not worth a whole second dialog.
        pick = QDialog(self)
        pick.setWindowTitle("Installed remote skills")
        pick.resize(420, 360)
        v = QVBoxLayout(pick)
        v.addWidget(QLabel("Tick the skills to uninstall, then click Remove."))
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        host = QWidget()
        hv = QVBoxLayout(host)
        checks: Dict[str, QCheckBox] = {}
        for f in folders:
            cb = QCheckBox(f)
            checks[f] = cb
            hv.addWidget(cb)
        hv.addStretch(1)
        scroll.setWidget(host)
        v.addWidget(scroll, 1)

        row = QHBoxLayout()
        row.addStretch(1)
        cancel = QPushButton("Cancel")
        cancel.clicked.connect(pick.reject)
        row.addWidget(cancel)
        remove = QPushButton("Remove")
        remove.setStyleSheet(
            "QPushButton { background:rgba(255,140,140,0.18); color:#ff8c8c;"
            " border:none; border-radius:8px; padding:6px 14px; }"
        )

        def _do_remove():
            removed = 0
            for f, cb in checks.items():
                if cb.isChecked() and uninstall_skill(f):
                    removed += 1
            self.status_label.setText(f"Removed {removed} installed skill(s).")
            self._installed_count += removed  # any change should trigger refresh
            pick.accept()

        remove.clicked.connect(_do_remove)
        row.addWidget(remove)
        v.addLayout(row)
        pick.exec()

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _clear_skills(self) -> None:
        while self.list_layout.count() > 1:
            item = self.list_layout.takeAt(0)
            w = item.widget()
            if w is not None:
                w.deleteLater()
        self._skill_checks.clear()

    def _populate_skills(self, skills: List[DiscoveredSkill]) -> None:
        self._clear_skills()
        for sk in skills:
            row = QFrame()
            row.setStyleSheet(
                "QFrame { background:#1a1d24; border:none; border-radius:8px; }"
            )
            rlay = QVBoxLayout(row)
            rlay.setContentsMargins(12, 8, 12, 8)
            rlay.setSpacing(2)
            cb = QCheckBox(sk.name)
            cb.setStyleSheet("color:#fff; font-weight:600; font-size:13px;")
            rlay.addWidget(cb)
            if sk.description:
                desc = QLabel(sk.description)
                desc.setWordWrap(True)
                desc.setStyleSheet("color:#9aa0a6; font-size:11px;")
                rlay.addWidget(desc)
            path = QLabel(sk.relative_dir)
            path.setStyleSheet("color:#5a6270; font-size:10px; font-style:italic;")
            rlay.addWidget(path)
            self.list_layout.insertWidget(self.list_layout.count() - 1, row)
            self._skill_checks[sk.relative_dir] = (cb, sk)
        self.install_btn.setEnabled(True)

    def _set_all_checked(self, checked: bool) -> None:
        for cb, _ in self._skill_checks.values():
            cb.setChecked(checked)

    # ------------------------------------------------------------------
    # API for caller
    # ------------------------------------------------------------------

    def changed_anything(self) -> bool:
        """True if at least one install/uninstall happened — the caller
        uses this to decide whether to reload its agent gallery."""
        return self._installed_count > 0
