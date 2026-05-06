"""Provider-grouped model picker for the Agents tab.

A single click-to-open button that surfaces the currently selected model and,
on click, drops a popup containing every available model **grouped by
provider** — Local / Anthropic / OpenAI. Each group is a sub-container with
its own header. No scroll list, no QComboBox.

If the Local group is empty (the user has no onboarded models), it shows a
CTA that switches the main app to the Models tab so they can install one.
"""
from __future__ import annotations

from typing import Callable, List, Optional

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
    QWidgetAction,
    QMenu,
)

from core.agents.backends import ModelEntry, list_all_entries


# ---------------------------------------------------------------------------
# Provider grouping
# ---------------------------------------------------------------------------


# How backend ids map to the human-facing provider sections in the picker.
# Adding a Gemini / Mistral provider later = one entry here.
_BACKEND_TO_PROVIDER = {
    "local": "Local",
    "claude_cli": "Anthropic",
    "claude_api": "Anthropic",
    "codex_cli": "OpenAI",
    "openai_api": "OpenAI",
}

_PROVIDER_ORDER = ("Local", "Anthropic", "OpenAI")

_PROVIDER_ACCENT = {
    "Local": "#7989ff",
    "Anthropic": "#cc785c",
    "OpenAI": "#10a37f",
}


def _group_entries(entries: List[ModelEntry]) -> dict[str, List[ModelEntry]]:
    """Bucket flat entries by provider section. Unknown backends drop in
    'Other' so a future un-mapped backend still appears."""
    out: dict[str, List[ModelEntry]] = {p: [] for p in _PROVIDER_ORDER}
    for e in entries:
        provider = _BACKEND_TO_PROVIDER.get(e.backend, "Other")
        out.setdefault(provider, []).append(e)
    return out


def _short_label(entry: ModelEntry) -> str:
    """Shorten the display string for the picker — drops the trailing
    parenthetical hint that ModelEntry stuffs in for greyed rows."""
    s = entry.display
    # If display has the noisy '(install ...)' / '(set ENV)' suffix, strip it.
    for cut in ("  (install", "  (set "):
        if cut in s:
            s = s.split(cut)[0]
            break
    return s.strip()


# ---------------------------------------------------------------------------
# Popup row widget
# ---------------------------------------------------------------------------


class _ModelRow(QFrame):
    """One selectable model row inside a popup section.

    Visual: hover-tinted, rounded, dot-indicator on the left for source
    (subscription / API). Disabled rows render greyed and are click-deaf.
    """

    clicked = Signal(str)  # composite_id

    def __init__(self, entry: ModelEntry, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.entry = entry
        self._enabled = entry.available

        self.setObjectName("ModelRow")
        self.setMinimumHeight(34)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.setCursor(Qt.PointingHandCursor if entry.available else Qt.ArrowCursor)

        accent = _PROVIDER_ACCENT.get(_BACKEND_TO_PROVIDER.get(entry.backend, ""), "#888")
        body_color = "#dadcdf" if entry.available else "#5a6070"

        self.setStyleSheet(f"""
            QFrame#ModelRow {{
                background: transparent;
                border: none;
                border-radius: 6px;
                padding: 0;
            }}
            QFrame#ModelRow:hover {{
                background: rgba(255,255,255,0.06);
            }}
        """)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(10, 4, 10, 4)
        layout.setSpacing(10)

        dot = QLabel()
        dot.setFixedSize(6, 6)
        dot.setStyleSheet(f"background:{accent}; border-radius:3px;")
        layout.addWidget(dot)

        label = QLabel(_short_label(entry))
        label.setStyleSheet(f"color:{body_color}; background:transparent; font-size:12px;")
        layout.addWidget(label, 1)

        # Source badge — sub / API. Useful when both surfaces are listed
        # under the same provider.
        badge_text = ""
        if entry.backend.endswith("_cli"):
            badge_text = "sub"
        elif entry.backend.endswith("_api"):
            badge_text = "API"
        if badge_text:
            badge = QLabel(badge_text)
            badge.setStyleSheet(
                f"color:#9aa0a6; background:rgba(255,255,255,0.05); "
                f"border-radius:5px; padding:1px 6px; font-size:10px;"
            )
            layout.addWidget(badge)

        if not entry.available:
            note = QLabel(entry.note or "unavailable")
            note.setStyleSheet("color:#666; background:transparent; font-size:10px;")
            layout.addWidget(note)

    def mousePressEvent(self, ev) -> None:  # noqa: N802
        if self._enabled and ev.button() == Qt.LeftButton:
            self.clicked.emit(self.entry.composite_id)


# ---------------------------------------------------------------------------
# Popup
# ---------------------------------------------------------------------------


class _ModelPickerPopup(QMenu):
    """Provider-grouped popup. One section per provider, each with a header
    label and the model rows below it. The Local section, if empty, shows
    a CTA to install a local model.
    """

    selected = Signal(str)        # composite_id
    open_models_tab = Signal()    # CTA: switch to Models tab

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setObjectName("ModelPickerPopup")
        # We stuff custom widgets into QWidgetActions, so disable the menu's
        # default tearing/highlight behaviour that fights with our painting.
        self.setStyleSheet("""
            QMenu {
                background:palette(base);
                border:1px solid #2c313c;
                border-radius:10px;
                padding:6px;
            }
            QMenu::separator {
                height:0;
                margin:0;
            }
        """)

    def populate(self, entries: List[ModelEntry]) -> None:
        self.clear()
        groups = _group_entries(entries)

        for provider in _PROVIDER_ORDER:
            self._add_section(provider, groups.get(provider, []))

        # Any 'Other' bucket from unknown backends.
        other = groups.get("Other") or []
        if other:
            self._add_section("Other", other)

    def _add_section(self, provider: str, rows: List[ModelEntry]) -> None:
        # Section header.
        header = QLabel(provider)
        header_font = QFont()
        header_font.setBold(True)
        header_font.setPointSize(10)
        header.setFont(header_font)
        accent = _PROVIDER_ACCENT.get(provider, "#aaa")
        header.setStyleSheet(
            f"color:{accent}; background:transparent; "
            f"padding:6px 10px 4px 10px; letter-spacing:0.5px; text-transform:uppercase;"
        )
        ha = QWidgetAction(self)
        ha.setDefaultWidget(header)
        ha.setEnabled(False)
        self.addAction(ha)

        if not rows:
            self._add_empty_row(provider)
            return

        for entry in rows:
            row = _ModelRow(entry)
            row.clicked.connect(self._on_row_clicked)
            ra = QWidgetAction(self)
            ra.setDefaultWidget(row)
            self.addAction(ra)

    def _add_empty_row(self, provider: str) -> None:
        """What to show when a section has zero models.

        Local: actionable CTA that bounces the user to the Models tab to
        install / start a local model.
        Anthropic / OpenAI: hint that points to the Accounts tab.
        """
        host = QFrame()
        host.setStyleSheet("background:transparent; border:none;")
        layout = QHBoxLayout(host)
        layout.setContentsMargins(10, 4, 10, 8)
        layout.setSpacing(8)

        if provider == "Local":
            note = QLabel("No local models running.")
            note.setStyleSheet("color:#9aa0a6; font-size:11px; background:transparent;")
            layout.addWidget(note, 1)

            cta = QPushButton("Install / start →")
            cta.setStyleSheet("""
                QPushButton {
                    background: rgba(121,137,255,0.18);
                    color: #c5cdff;
                    border: none; border-radius: 6px;
                    padding: 4px 10px; font-size: 11px; font-weight: 600;
                }
                QPushButton:hover { background: rgba(121,137,255,0.32); }
            """)
            cta.clicked.connect(self._on_install_local_clicked)
            layout.addWidget(cta)
        else:
            note = QLabel(f"Connect {provider} in the Accounts tab.")
            note.setStyleSheet("color:#9aa0a6; font-size:11px; background:transparent;")
            layout.addWidget(note, 1)

        wa = QWidgetAction(self)
        wa.setDefaultWidget(host)
        wa.setEnabled(provider == "Local")
        self.addAction(wa)

    def _on_row_clicked(self, composite_id: str) -> None:
        self.selected.emit(composite_id)
        self.close()

    def _on_install_local_clicked(self) -> None:
        self.open_models_tab.emit()
        self.close()


# ---------------------------------------------------------------------------
# Picker button
# ---------------------------------------------------------------------------


class ModelPickerButton(QPushButton):
    """Drop-in replacement for the QComboBox on each agent card.

    Renders the currently selected model as a flat button; clicking opens the
    provider-grouped popup. The current selection is exposed via
    ``current_id()`` and ``set_current_id(...)``.
    """

    selection_changed = Signal(str)  # composite_id

    def __init__(
        self,
        on_install_local: Optional[Callable[[], None]] = None,
        parent: Optional[QWidget] = None,
    ) -> None:
        super().__init__(parent)
        self._current_id: Optional[str] = None
        self._current_label: str = "Pick a model"
        self._on_install_local = on_install_local

        self.setMinimumHeight(36)
        self.setCursor(Qt.PointingHandCursor)
        self.setStyleSheet("""
            QPushButton {
                background: rgba(255,255,255,0.04);
                color: #dadcdf;
                border: none; border-radius: 8px;
                padding: 0 14px; text-align: left; font-size: 12px;
            }
            QPushButton:hover { background: rgba(255,255,255,0.08); }
            QPushButton:pressed { background: rgba(255,255,255,0.12); }
        """)

        self._popup = _ModelPickerPopup(self)
        self._popup.selected.connect(self._on_selected)
        if self._on_install_local is not None:
            self._popup.open_models_tab.connect(self._on_install_local)

        self.clicked.connect(self._show_popup)
        self._refresh_text()

    # ------------------------------------------------------------------
    # API
    # ------------------------------------------------------------------

    def refresh_entries(self) -> None:
        """Re-pull entries from the backend registry."""
        try:
            entries = list_all_entries()
        except Exception:
            entries = []
        self._popup.populate(entries)

        # If nothing is selected yet, default to the first available entry.
        if self._current_id is None:
            for e in entries:
                if e.available:
                    self._current_id = e.composite_id
                    self._current_label = _short_label(e)
                    self._refresh_text()
                    self.selection_changed.emit(self._current_id)
                    break
        else:
            # Refresh the current label in case the entry's display changed.
            for e in entries:
                if e.composite_id == self._current_id:
                    self._current_label = _short_label(e)
                    self._refresh_text()
                    return
            # Stored selection no longer in the list — drop it.
            self._current_id = None
            self._current_label = "Pick a model"
            self._refresh_text()

    def current_id(self) -> str:
        return self._current_id or ""

    def current_label(self) -> str:
        """Display name for the currently-selected entry (no ▾ glyph).

        Returns an empty string when nothing has been picked yet — call
        sites can decide whether to render a placeholder.
        """
        if not self._current_id:
            return ""
        return self._current_label

    def set_current_id(self, composite_id: str) -> None:
        if not composite_id:
            return
        self._current_id = composite_id
        # Look up the label.
        try:
            for e in list_all_entries():
                if e.composite_id == composite_id:
                    self._current_label = _short_label(e)
                    break
        except Exception:
            pass
        self._refresh_text()

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _on_selected(self, composite_id: str) -> None:
        self._current_id = composite_id
        try:
            for e in list_all_entries():
                if e.composite_id == composite_id:
                    self._current_label = _short_label(e)
                    break
        except Exception:
            pass
        self._refresh_text()
        self.selection_changed.emit(composite_id)

    def _refresh_text(self) -> None:
        # ▾ glyph at the right end signals "click for menu" — Qt's menu
        # arrow only renders for QToolButton, which we deliberately don't
        # use because QToolButton's auto-styling fights our stylesheet.
        self.setText(f"{self._current_label}    ▾")

    def _show_popup(self) -> None:
        # Always re-pull entries before showing — accounts may have changed.
        self.refresh_entries()
        below_left = self.mapToGlobal(self.rect().bottomLeft())
        self._popup.setMinimumWidth(self.width())
        self._popup.exec(below_left)
