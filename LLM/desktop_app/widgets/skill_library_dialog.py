"""Skill Library dialog — browse, preview, and install community SKILL.md packs.

Opened from the 🎭 Studio page's header. Lists each curated source from
:data:`core.agents.skill_sources.KNOWN_SOURCES`, lets the user fetch
(shallow-clone), then displays the discovered skills as a checklist with:

  * search box that filters by name/description/path as you type
  * "installed" badge on skills already pulled
  * "filter: installed only / available only / all" radio
  * click a row to preview the SKILL.md body in a side panel before install

Errors surface inline (status label below the button) so they don't
block batch work.
"""
from __future__ import annotations

import logging
from typing import Dict, List, Optional

from PySide6.QtCore import Qt, QThread, Signal
from PySide6.QtGui import QFont, QTextOption
from PySide6.QtWidgets import (
    QButtonGroup,
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
    QRadioButton,
    QScrollArea,
    QSplitter,
    QTextEdit,
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
    is_skill_installed,
    list_installed_remote_folders,
    read_skill_body,
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
# Skill row widget
# ---------------------------------------------------------------------------


class _SkillRow(QFrame):
    """One row in the discovered-skills list. Clickable for preview."""

    clicked = Signal(object)  # DiscoveredSkill

    def __init__(self, skill: DiscoveredSkill, installed: bool, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.skill = skill
        self.installed = installed
        self.setObjectName("SkillRow")
        self.setCursor(Qt.PointingHandCursor)
        self._build()

    def _build(self) -> None:
        # Theme-friendly: rounded card with a hover lift, but the
        # actual background colour comes from the global stylesheet
        # (palette(base)) so light mode + colour themes apply.
        self.setStyleSheet(
            "QFrame#SkillRow { background: palette(base); border:none; border-radius:8px; }"
            "QFrame#SkillRow:hover { background: palette(alternate-base); }"
        )
        rlay = QVBoxLayout(self)
        rlay.setContentsMargins(14, 10, 14, 10)
        rlay.setSpacing(4)

        head = QHBoxLayout()
        head.setSpacing(8)
        self.checkbox = QCheckBox(self.skill.name)
        self.checkbox.setStyleSheet("font-weight:600; font-size:17px;")
        head.addWidget(self.checkbox)
        head.addStretch(1)
        if self.installed:
            badge = QLabel("INSTALLED")
            badge.setStyleSheet(
                "color:#7eebac; background:rgba(126,235,172,0.12);"
                " border-radius:6px; padding:3px 10px;"
                " font-size:14px; font-weight:600; letter-spacing:0.6px;"
            )
            head.addWidget(badge)
        rlay.addLayout(head)

        if self.skill.description:
            desc = QLabel(self.skill.description)
            desc.setWordWrap(True)
            desc.setStyleSheet("color:#9aa0a6; font-size:15px;")
            rlay.addWidget(desc)
        path = QLabel(self.skill.relative_dir)
        path.setStyleSheet("color:#5a6270; font-size:14px; font-style:italic;")
        rlay.addWidget(path)

    def mousePressEvent(self, ev) -> None:  # noqa: N802
        # Only emit clicked when the click was outside the checkbox itself —
        # otherwise the toggle would fight with selection.
        if ev.button() == Qt.LeftButton and not self.checkbox.geometry().contains(ev.pos()):
            self.clicked.emit(self.skill)
        super().mousePressEvent(ev)


# ---------------------------------------------------------------------------
# Dialog
# ---------------------------------------------------------------------------


_FILTER_ALL = "all"
_FILTER_NEW = "available"
_FILTER_INSTALLED = "installed"


class SkillLibraryDialog(QDialog):
    """Modal dialog. Emits no signals — the caller refreshes after ``exec()``."""

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("Skill Library")
        self.resize(960, 640)

        self._current_source: Optional[SkillSource] = None
        self._all_skills: List[DiscoveredSkill] = []
        self._skill_rows: Dict[str, _SkillRow] = {}  # relative_dir -> row
        self._fetch_worker: Optional[_FetchWorker] = None
        self._installed_count = 0

        self._build_ui()
        if KNOWN_SOURCES:
            self.source_combo.setCurrentIndex(0)
            self._on_source_changed(0)

    # ------------------------------------------------------------------
    # UI
    # ------------------------------------------------------------------

    def _build_ui(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(20, 18, 20, 18)
        outer.setSpacing(12)

        title = QLabel("Skill Library")
        tf = QFont()
        tf.setPointSize(22)
        tf.setBold(True)
        title.setFont(tf)
        outer.addWidget(title)

        sub = QLabel(
            "Install community SKILL.md packs from curated git sources. "
            "Anthropic-style tool names are rewritten to OWLLM equivalents "
            "automatically (e.g. <b>Read</b> → <b>read_file</b>)."
        )
        sub.setWordWrap(True)
        sub.setStyleSheet("color:#9aa0a6; font-size:16px;")
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

        # Description / status / progress.
        self.desc_label = QLabel("")
        self.desc_label.setWordWrap(True)
        self.desc_label.setStyleSheet("color:#9aa0a6; font-size:15px;")
        outer.addWidget(self.desc_label)

        self.progress = QProgressBar()
        self.progress.setRange(0, 0)
        self.progress.setVisible(False)
        outer.addWidget(self.progress)

        self.status_label = QLabel("")
        self.status_label.setWordWrap(True)
        self.status_label.setStyleSheet("color:#ffb86b; font-size:15px;")
        outer.addWidget(self.status_label)

        # Filter row: search box + radio filters.
        filter_row = QHBoxLayout()
        filter_row.setSpacing(8)
        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText("Search by name, description, or path…")
        self.search_input.textChanged.connect(self._refresh_visible_rows)
        filter_row.addWidget(self.search_input, 1)

        self._filter = _FILTER_ALL
        self._filter_group = QButtonGroup(self)
        for label, key in (("All", _FILTER_ALL), ("Available", _FILTER_NEW), ("Installed", _FILTER_INSTALLED)):
            rb = QRadioButton(label)
            rb.setStyleSheet("color:#dadcdf; font-size:15px;")
            if key == _FILTER_ALL:
                rb.setChecked(True)
            rb.toggled.connect(lambda checked, k=key: checked and self._set_filter(k))
            self._filter_group.addButton(rb)
            filter_row.addWidget(rb)
        outer.addLayout(filter_row)

        # Splitter: skill list left, preview pane right.
        splitter = QSplitter(Qt.Horizontal)
        splitter.setHandleWidth(6)

        # Skill list pane.
        list_host = QScrollArea()
        list_host.setWidgetResizable(True)
        list_host.setFrameShape(QFrame.NoFrame)
        self.list_widget = QWidget()
        self.list_layout = QVBoxLayout(self.list_widget)
        self.list_layout.setContentsMargins(0, 0, 0, 0)
        self.list_layout.setSpacing(6)
        self.list_layout.addStretch(1)
        list_host.setWidget(self.list_widget)
        splitter.addWidget(list_host)

        # Preview pane.
        preview_host = QFrame()
        preview_host.setStyleSheet(
            "QFrame { background:palette(base); border:none; border-radius:10px; }"
        )
        pv = QVBoxLayout(preview_host)
        pv.setContentsMargins(12, 10, 12, 10)
        pv.setSpacing(6)
        self.preview_title = QLabel("Click a skill to preview its SKILL.md")
        self.preview_title.setStyleSheet("color:#fff; font-weight:600; font-size:17px;")
        pv.addWidget(self.preview_title)
        self.preview_text = QTextEdit()
        self.preview_text.setReadOnly(True)
        self.preview_text.setWordWrapMode(QTextOption.WordWrap)
        self.preview_text.setStyleSheet(
            "QTextEdit { background:#0f1117; color:#cfd2d8; border:none;"
            " border-radius:6px; padding:8px; font-family:Consolas,monospace;"
            " font-size:15px; }"
        )
        pv.addWidget(self.preview_text, 1)
        splitter.addWidget(preview_host)
        # 45 / 55 split — left list compact, right preview wider so the
        # SKILL.md content has room to breathe with the new larger fonts.
        splitter.setStretchFactor(0, 45)
        splitter.setStretchFactor(1, 55)
        splitter.setSizes([450, 550])
        outer.addWidget(splitter, 1)

        # Action row.
        actions = QHBoxLayout()
        actions.setSpacing(8)
        self.select_all_btn = QPushButton("Select all visible")
        self.select_all_btn.clicked.connect(lambda: self._set_visible_checked(True))
        actions.addWidget(self.select_all_btn)
        self.select_none_btn = QPushButton("Select none")
        self.select_none_btn.clicked.connect(lambda: self._set_visible_checked(False))
        actions.addWidget(self.select_none_btn)
        actions.addStretch(1)

        installed_btn = QPushButton("Manage installed…")
        installed_btn.clicked.connect(self._show_installed)
        actions.addWidget(installed_btn)

        self.install_btn = QPushButton("Install selected")
        self.install_btn.setStyleSheet(
            "QPushButton { background:#4a6cff; color:white; border:none;"
            " border-radius:8px; padding:8px 22px; font-weight:600; font-size:15px; }"
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
    # Slots — source / fetch
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
        self._set_preview(None)

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
        installed_count = sum(
            1 for sk in skills if is_skill_installed(sk.source_key, sk.relative_dir)
        )
        self.status_label.setText(
            f"Found {len(skills)} skill(s) in {source.label} "
            f"({installed_count} already installed)."
        )
        self._populate_skills(skills)

    def _on_fetch_failed(self, source: SkillSource, message: str) -> None:
        self.progress.setVisible(False)
        self.fetch_btn.setEnabled(True)
        self.status_label.setText(f"Fetch failed: {message}")

    # ------------------------------------------------------------------
    # Slots — install / uninstall
    # ------------------------------------------------------------------

    def _on_install_clicked(self) -> None:
        chosen: List[DiscoveredSkill] = [
            row.skill for row in self._skill_rows.values()
            if row.checkbox.isChecked() and row.isVisible()
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

        # Repaint badges + filter view to reflect new install state.
        self._refresh_install_badges()
        self._refresh_visible_rows()

    def _show_installed(self) -> None:
        folders = list_installed_remote_folders()
        if not folders:
            QMessageBox.information(
                self,
                "Installed skills",
                "No remote skills are installed yet.",
            )
            return
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
            self._installed_count += removed
            self._refresh_install_badges()
            self._refresh_visible_rows()
            pick.accept()

        remove.clicked.connect(_do_remove)
        row.addWidget(remove)
        v.addLayout(row)
        pick.exec()

    # ------------------------------------------------------------------
    # Filter / search
    # ------------------------------------------------------------------

    def _set_filter(self, key: str) -> None:
        self._filter = key
        self._refresh_visible_rows()

    def _refresh_visible_rows(self) -> None:
        query = self.search_input.text().strip().lower()
        any_visible = False
        for row in self._skill_rows.values():
            sk = row.skill
            haystack = " ".join((sk.name, sk.description, sk.relative_dir)).lower()
            text_match = (not query) or (query in haystack)

            if self._filter == _FILTER_INSTALLED:
                state_match = row.installed
            elif self._filter == _FILTER_NEW:
                state_match = not row.installed
            else:
                state_match = True

            visible = text_match and state_match
            row.setVisible(visible)
            if visible:
                any_visible = True

        self.install_btn.setEnabled(any_visible)

    def _refresh_install_badges(self) -> None:
        """Rebuild rows so INSTALLED badges reflect the latest disk state.

        Cheaper than re-fetching from git — we still have the discovered
        skills cached in ``self._all_skills``."""
        if self._all_skills:
            self._populate_skills(self._all_skills)

    # ------------------------------------------------------------------
    # Preview pane
    # ------------------------------------------------------------------

    def _set_preview(self, skill: Optional[DiscoveredSkill]) -> None:
        if skill is None:
            self.preview_title.setText("Click a skill to preview its SKILL.md")
            self.preview_text.setPlainText("")
            return
        self.preview_title.setText(f"{skill.name} — {skill.relative_dir}")
        self.preview_text.setPlainText(read_skill_body(skill.skill_md_path))
        # Scroll to top.
        self.preview_text.verticalScrollBar().setValue(0)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _clear_skills(self) -> None:
        while self.list_layout.count() > 1:
            item = self.list_layout.takeAt(0)
            w = item.widget()
            if w is not None:
                w.deleteLater()
        self._skill_rows.clear()
        self._all_skills = []

    def _populate_skills(self, skills: List[DiscoveredSkill]) -> None:
        self._clear_skills()
        self._all_skills = list(skills)
        # Sort installed/downloaded skills FIRST — the user treats those
        # as "built-in" and wants them at the top of the left column.
        # Within each group keep the original (alphabetical) order.
        decorated = [
            (
                0 if is_skill_installed(sk.source_key, sk.relative_dir) else 1,
                idx,
                sk,
            )
            for idx, sk in enumerate(skills)
        ]
        decorated.sort(key=lambda t: (t[0], t[1]))
        for _, _, sk in decorated:
            row = _SkillRow(sk, installed=is_skill_installed(sk.source_key, sk.relative_dir))
            row.clicked.connect(self._set_preview)
            self.list_layout.insertWidget(self.list_layout.count() - 1, row)
            self._skill_rows[sk.relative_dir] = row
        self._refresh_visible_rows()

    def _set_visible_checked(self, checked: bool) -> None:
        for row in self._skill_rows.values():
            if row.isVisible():
                row.checkbox.setChecked(checked)

    # ------------------------------------------------------------------
    # API for caller
    # ------------------------------------------------------------------

    def changed_anything(self) -> bool:
        """True if at least one install/uninstall happened — the caller
        uses this to decide whether to reload its agent gallery."""
        return self._installed_count > 0
