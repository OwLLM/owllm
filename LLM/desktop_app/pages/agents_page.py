"""Agents tab — multi-agent OWLLM runtime UI.

Layout (all cards, no scroll, no list widgets):

    ┌─ accounts strip — read-only summary ─────────────────────────┐
    │ ● Claude  ● Codex  ● Anthropic  ● OpenAI                     │
    ├──────────────────────────────────────────────────────────────┤
    │ [ goal ]                                  [ Run ] [ Cancel ] │
    ├─────────────── 2-col splitter ───────────────────────────────┤
    │ AGENT CARDS (gradient + shadow)  │  live message stream      │
    │  ┌─ orchestrator (full-width) ─┐ │                           │
    │  └─────────────────────────────┘ │                           │
    │  ┌ res ┐ ┌ code ┐                │                           │
    │  ┌ op  ┐ ┌ crit ┐                │                           │
    ├──────────────────────────────────────────────────────────────┤
    │ pending approvals (vertical card stack, only when filled)    │
    └──────────────────────────────────────────────────────────────┘

Each agent card uses :class:`ModelPickerButton` instead of a QComboBox —
clicking opens a popup with models grouped by provider (Local / Anthropic /
OpenAI). If Local is empty, the popup offers a CTA that switches to the
Models tab.

Account management lives in its own top-level "🔐 Accounts" tab.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Dict, Optional

from PySide6.QtCore import QObject, QSettings, QSize, Qt, QTimer, Signal, Slot
from PySide6.QtGui import QColor, QFont
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFileDialog,
    QFrame,
    QGraphicsDropShadowEffect,
    QGridLayout,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QLineEdit,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QSpinBox,
    QSplitter,
    QStackedWidget,
    QTabWidget,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from core.agents.agent_definitions import AgentDefinition, list_all_definitions
from core.agents.agent_graph import AgentGraph
from core.agents.attachments import (
    Attachment,
    KIND_AUDIO,
    KIND_IMAGE,
    adopt_local_path,
)
from core.agents.bus import get_bus
from core.agents.message import Message, MessageKind
from core.agents.orchestrator import Team, build_team
from core.agents.projects import Project, get_project_store
from core.agents.roles.loader import Role, builtin_roles
from core.agents.tools import (
    ApprovalDecision,
    ApprovalRequest,
    builtin_registry,
    register_mcp_tools,
)
from core.agents.backends import dispatch_model_fn
from desktop_app import agent_runtime_manager
from PySide6.QtWidgets import (
    QListWidget,
    QListWidgetItem,
    QMenu,
    QProgressDialog,
    QToolButton,
)

from desktop_app.widgets.agent_canvas import (
    AgentCanvas,
    STATUS_ACTIVE as CANVAS_STATUS_ACTIVE,
    STATUS_ERROR as CANVAS_STATUS_ERROR,
    STATUS_IDLE as CANVAS_STATUS_IDLE,
    STATUS_PENDING as CANVAS_STATUS_PENDING,
)
from desktop_app.widgets.agent_canvas_loader import AgentCanvasLoader
from desktop_app.widgets.agent_team_canvas import AgentTeamCanvas
from desktop_app.widgets.model_picker import ModelPickerButton

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Bridge
# ---------------------------------------------------------------------------


class _BusBridge(QObject):
    message = Signal(object)
    approval_requested = Signal(object)


# ---------------------------------------------------------------------------
# Status palette
# ---------------------------------------------------------------------------


_STATUS_IDLE = "idle"
_STATUS_THINKING = "thinking"
_STATUS_WORKING = "working"
_STATUS_ERROR = "error"


# ---------------------------------------------------------------------------
# Goal line edit — accepts file drops so the user can drag images / audio
# straight onto the prompt instead of going through the 📎 picker.
# ---------------------------------------------------------------------------


class _GoalLineEdit(QLineEdit):
    """QLineEdit that forwards dropped file URIs to a callback.

    Plain QLineEdit rejects file drops — its default drag handlers only
    accept text. This subclass overrides drag-enter / drop so the page
    can intercept image and audio files dropped from the OS file
    manager.
    """

    def __init__(self, on_files_dropped, parent=None):
        super().__init__(parent)
        self.setAcceptDrops(True)
        self._on_files_dropped = on_files_dropped

    def dragEnterEvent(self, event):  # noqa: N802
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
        else:
            super().dragEnterEvent(event)

    def dragMoveEvent(self, event):  # noqa: N802
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
        else:
            super().dragMoveEvent(event)

    def dropEvent(self, event):  # noqa: N802
        if event.mimeData().hasUrls():
            paths = [u.toLocalFile() for u in event.mimeData().urls() if u.isLocalFile()]
            paths = [p for p in paths if p]
            if paths and self._on_files_dropped:
                try:
                    self._on_files_dropped(paths)
                except Exception:
                    logger.exception("attachment drop handler crashed")
            event.acceptProposedAction()
            return
        super().dropEvent(event)

class _AgentVoiceRow(QWidget):
    """One agent's voice controls — enable, voice picker, rate, preview.

    Edits are persisted to the agent's :class:`AgentDefinition` via
    ``save_custom`` the moment the user changes them, mirroring how the
    model picker auto-saves on selection_changed. Built-ins are shown
    read-only with a "duplicate first" tooltip — the studio is where the
    user clones a built-in to edit it. Preview always works regardless,
    so the user can audition voices without committing.
    """

    def __init__(
        self,
        agent_name: str,
        *,
        on_install_voice,
        on_open_voice_manager=None,
        on_changed=None,
        on_broadcast=None,
        parent: Optional[QWidget] = None,
    ) -> None:
        super().__init__(parent)
        self._agent_name = agent_name
        self._on_install_voice = on_install_voice
        self._on_open_voice_manager = on_open_voice_manager
        self._on_changed_external = on_changed
        self._on_broadcast = on_broadcast
        self._loading = False  # guards setter callbacks during populate

        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(8)

        self.enabled_cb = QCheckBox("🔊")
        self.enabled_cb.setToolTip("Speak this agent's replies aloud")
        self.enabled_cb.setStyleSheet(
            "QCheckBox { color:#dadcdf; font-size:13px; spacing:4px; } "
            "QCheckBox::indicator { width:16px; height:16px; }"
        )
        self.enabled_cb.toggled.connect(self._on_changed)
        layout.addWidget(self.enabled_cb)

        # Voice picker button — replaces the previous flat combobox.
        # Click opens a flag-grid dialog so users can pick by country
        # first (4-column scrollable grid of flag tiles), then by voice
        # name. Far better UX than a 322-row dropdown.
        # ``_voice_id`` is the source of truth between dialog opens; the
        # button label shows the friendly voice name.
        self._voice_id: str = ""
        self.voice_btn = QPushButton("Auto voice")
        self.voice_btn.setMinimumHeight(28)
        self.voice_btn.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.voice_btn.setStyleSheet(
            "QPushButton { background:rgba(0,0,0,0.28); color:#e6e8eb; "
            "border:none; border-radius:6px; padding:0 10px; font-size:12px; "
            "text-align:left; } "
            "QPushButton:hover { background:rgba(0,0,0,0.40); } "
            "QPushButton:disabled { color:#666; }"
        )
        self.voice_btn.setToolTip("Pick a voice (browse by country flag)")
        self.voice_btn.clicked.connect(self._open_voice_picker)
        layout.addWidget(self.voice_btn, 1)

        self.rate_spin = QSpinBox()
        self.rate_spin.setRange(0, 400)
        self.rate_spin.setSingleStep(10)
        self.rate_spin.setSuffix(" wpm")
        self.rate_spin.setSpecialValueText("Default")
        self.rate_spin.setMinimumHeight(28)
        self.rate_spin.setFixedWidth(110)
        self.rate_spin.setToolTip("Speaking rate (words per minute)")
        self.rate_spin.setStyleSheet(
            "QSpinBox { background:rgba(0,0,0,0.28); color:#e6e8eb; "
            "border:none; border-radius:6px; padding:0 8px; font-size:12px; }"
        )
        self.rate_spin.valueChanged.connect(self._on_changed)
        layout.addWidget(self.rate_spin)

        self.preview_btn = QPushButton("▶")
        self.preview_btn.setFixedSize(28, 28)
        self.preview_btn.setToolTip("Preview this voice")
        self.preview_btn.setStyleSheet(
            "QPushButton { background:rgba(255,255,255,0.06); color:#dadcdf; "
            "border:none; border-radius:6px; font-size:12px; } "
            "QPushButton:hover { background:rgba(255,255,255,0.12); }"
        )
        self.preview_btn.clicked.connect(self._on_preview)
        layout.addWidget(self.preview_btn)

        # ➤ broadcast button — copies this row's current voice to every
        # other agent's definition in one click. Solves the "I picked
        # Ryan but the next reply was Amy" confusion: the user thought
        # they configured the team voice when they actually only set
        # the orchestrator's, and other agents were still on Auto.
        self.broadcast_btn = QPushButton("➤")
        self.broadcast_btn.setFixedSize(28, 28)
        self.broadcast_btn.setToolTip(
            "Apply this voice (and rate / mute) to every agent on the team"
        )
        self.broadcast_btn.setStyleSheet(
            "QPushButton { background:rgba(255,255,255,0.06); color:#dadcdf; "
            "border:none; border-radius:6px; font-size:14px; } "
            "QPushButton:hover { background:rgba(255,255,255,0.12); } "
            "QPushButton:disabled { color:#555; }"
        )
        self.broadcast_btn.clicked.connect(self._on_broadcast_clicked)
        self.broadcast_btn.setEnabled(self._on_broadcast is not None)
        layout.addWidget(self.broadcast_btn)

        # Tiny "+" button — opens the Piper voice manager so the user can
        # download more voices straight from the row, instead of hunting
        # for the engine dropdown menu. Hidden when Piper isn't the active
        # backend (system TTS voices come pre-installed).
        self.add_voice_btn = QPushButton("+")
        self.add_voice_btn.setFixedSize(28, 28)
        self.add_voice_btn.setToolTip("Download more voices…")
        self.add_voice_btn.setStyleSheet(
            "QPushButton { background:rgba(255,255,255,0.06); color:#dadcdf; "
            "border:none; border-radius:6px; font-size:14px; font-weight:600; } "
            "QPushButton:hover { background:rgba(255,255,255,0.12); }"
        )
        self.add_voice_btn.clicked.connect(self._on_open_manager)
        self.add_voice_btn.setVisible(False)
        layout.addWidget(self.add_voice_btn)

        self._populate_voices_and_load()

    # ------------------------------------------------------------------
    # Population
    # ------------------------------------------------------------------

    def _populate_voices_and_load(self) -> None:
        """Load this agent's persisted voice config and update the
        button label. Voice enumeration is now lazy — the dialog asks
        the live service for voices when the user opens it, so this
        method only needs to (a) gate the row when no engine is
        available and (b) restore the persisted voice_id + label."""
        self._loading = True
        try:
            tts = self._tts()
            if tts is None or not tts.available:
                self.voice_btn.setEnabled(False)
                self.voice_btn.setText("Voice unavailable")
                self.rate_spin.setEnabled(False)
                self.enabled_cb.setEnabled(False)
                # Preview becomes the install entry-point.
                self.preview_btn.setEnabled(True)
                self.preview_btn.setToolTip("Install the voice engine")
                self.preview_btn.setText("⤓")
                return

            # Surface "+ download more" only when Piper is the active
            # engine — Edge / SAPI voices don't need explicit downloads.
            backend = getattr(tts, "_backend", None)
            piper_active = (
                backend is not None
                and getattr(backend, "name", "") == "piper"
                and self._on_open_voice_manager is not None
            )
            self.add_voice_btn.setVisible(piper_active)

            # Apply persisted state.
            from core.agents.agent_definitions import get_definition
            d = get_definition(self._agent_name)
            if d is not None:
                self.enabled_cb.setChecked(bool(d.voice_enabled))
                self.rate_spin.setValue(int(d.voice_rate or 0))
                self.set_voice_id(d.voice_id or "")
                if d.built_in:
                    self.enabled_cb.setEnabled(False)
                    self.voice_btn.setEnabled(False)
                    self.rate_spin.setEnabled(False)
                    tip = "Built-in agent — duplicate it in Studio to customise"
                    self.enabled_cb.setToolTip(tip)
                    self.voice_btn.setToolTip(tip)
                    self.rate_spin.setToolTip(tip)
        finally:
            self._loading = False

    # ------------------------------------------------------------------
    # Voice button + picker
    # ------------------------------------------------------------------

    def set_voice_id(self, voice_id: str) -> None:
        """Set ``self._voice_id`` and update the button label.

        Looks the friendly name up via the live service so the button
        always shows the same text the picker dialog would. Keeps the
        value-to-label mapping centralised in one method.
        """
        self._voice_id = voice_id or ""
        self.voice_btn.setText(self._voice_label_for(self._voice_id))

    def _voice_label_for(self, voice_id: str) -> str:
        if not voice_id:
            return "Auto voice"
        tts = self._tts()
        if tts is None or not tts.available:
            return voice_id
        # Linear scan — voices() lists are <500 entries, scanning once
        # per repaint is cheap and avoids caching-invalidation bugs.
        try:
            for v in tts.voices():
                if v.id == voice_id:
                    return v.name or voice_id
        except Exception:  # noqa: BLE001
            pass
        # Voice on disk but not in the catalog yet (e.g. SAPI registry
        # path). Show a compact suffix so the row doesn't display the
        # full Windows registry path.
        suffix = voice_id.replace("\\", "/").rstrip("/")
        return suffix.rsplit("/", 1)[-1] or voice_id

    def _open_voice_picker(self) -> None:
        """Open the flag-grid voice picker dialog. Persists the new
        choice immediately so the change is live without an explicit
        Save click."""
        tts = self._tts()
        if tts is None or not tts.available:
            try:
                self._on_install_voice()
            except Exception:
                logger.exception("install-voice handler crashed")
            return
        try:
            voices = tts.voices()
        except Exception:  # noqa: BLE001
            logger.exception("could not load voices for picker")
            voices = []
        dlg = _VoicePickerDialog(
            voices=voices,
            current_voice_id=self._voice_id,
            title=f"Voice — {self._agent_name}",
            parent=self,
        )
        if dlg.exec_() != QDialog.Accepted:
            return
        new_id = dlg.selected_voice_id() or ""
        self.set_voice_id(new_id)
        # Re-route through _on_changed so the persistence + canvas
        # refresh path is shared with the rate / enabled toggles.
        self._on_changed()

    @staticmethod
    def _tts():
        try:
            from core.voice import get_tts_service
            return get_tts_service()
        except Exception:
            return None

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def _on_changed(self, *_args) -> None:
        if self._loading:
            return
        try:
            from core.agents.agent_definitions import get_definition, save_custom
        except Exception:
            return
        d = get_definition(self._agent_name)
        if d is None or d.built_in:
            return
        try:
            d.voice_enabled = self.enabled_cb.isChecked()
            d.voice_rate = int(self.rate_spin.value())
            d.voice_id = self._voice_id or ""
            save_custom(d)
        except Exception:
            logger.exception("could not persist voice change for %s", self._agent_name)
        # Notify the page so it can refresh the canvas voice line.
        if self._on_changed_external is not None:
            try:
                self._on_changed_external(self._agent_name)
            except Exception:
                logger.exception("voice on_changed callback crashed")

    # ------------------------------------------------------------------
    # Preview
    # ------------------------------------------------------------------

    def _on_broadcast_clicked(self) -> None:
        if self._on_broadcast is None:
            return
        voice_id = self._voice_id or ""
        rate = int(self.rate_spin.value())
        enabled = self.enabled_cb.isChecked()
        try:
            self._on_broadcast(voice_id, rate, enabled, self._agent_name)
        except Exception:
            logger.exception("voice broadcast handler crashed")

    def _on_open_manager(self) -> None:
        if self._on_open_voice_manager is None:
            return
        try:
            self._on_open_voice_manager()
        except Exception:
            logger.exception("voice manager handler crashed")

    def _on_preview(self) -> None:
        tts = self._tts()
        if tts is None or not tts.available:
            # The service ran but the engine isn't installed — call back
            # to the page so it can offer to install pyttsx3.
            try:
                self._on_install_voice()
            except Exception:
                logger.exception("install-voice handler crashed")
            return
        voice_id = self._voice_id or ""
        if not voice_id:
            voice_id = tts.stable_voice_for(self._agent_name)
        rate = int(self.rate_spin.value())
        sample = (
            f"Hi, I'm {self._agent_name.capitalize()}. "
            "This is what my voice sounds like."
        )
        was = tts.enabled
        try:
            tts.set_enabled(True)
            tts.speak(sample, voice_id=voice_id, rate=rate, agent=self._agent_name)
        finally:
            tts.set_enabled(was)


def _country_to_flag(country_code: str) -> str:
    """``"US"`` → ``"🇺🇸"``. Two-letter ISO codes map onto Unicode
    regional-indicator pairs (U+1F1E6..U+1F1FF) — the OS renderer turns
    consecutive pairs into the actual flag glyph. Returns a generic
    globe for unknown / non-2-letter inputs."""
    if not country_code or len(country_code) != 2 or not country_code.isalpha():
        return "🌐"
    cc = country_code.upper()
    return "".join(chr(0x1F1E6 + ord(c) - ord("A")) for c in cc)


def _split_locale(language_code: str) -> tuple:
    """Split ``"en-US"`` / ``"en_US"`` / ``"en"`` into ``(lang, country)``.
    Empty strings stay empty so the picker can put them under "Other"."""
    if not language_code:
        return "", ""
    parts = language_code.replace("_", "-").split("-", 1)
    lang = parts[0].lower() if parts else ""
    country = parts[1].upper() if len(parts) > 1 else ""
    return lang, country


# Country-code → display name for the flag-grid tiles. We don't ship the
# pycountry dependency just for this — the locales we actually see come
# from the Edge + Piper catalogs and they're a small known set. Anything
# missing falls through to the bare country code.
_COUNTRY_NAMES = {
    "AE": "UAE", "AF": "Afghanistan", "AR": "Argentina", "AT": "Austria",
    "AU": "Australia", "AZ": "Azerbaijan", "BA": "Bosnia", "BD": "Bangladesh",
    "BE": "Belgium", "BG": "Bulgaria", "BN": "Brunei", "BO": "Bolivia",
    "BR": "Brazil", "CA": "Canada", "CD": "DRC", "CH": "Switzerland",
    "CL": "Chile", "CN": "China", "CO": "Colombia", "CR": "Costa Rica",
    "CU": "Cuba", "CY": "Cyprus", "CZ": "Czechia", "DE": "Germany",
    "DJ": "Djibouti", "DK": "Denmark", "DO": "Dominican Rep.", "DZ": "Algeria",
    "EC": "Ecuador", "EE": "Estonia", "EG": "Egypt", "ER": "Eritrea",
    "ES": "Spain", "ET": "Ethiopia", "FI": "Finland", "FR": "France",
    "GB": "UK", "GE": "Georgia", "GH": "Ghana", "GR": "Greece",
    "GT": "Guatemala", "HK": "Hong Kong", "HN": "Honduras", "HR": "Croatia",
    "HU": "Hungary", "ID": "Indonesia", "IE": "Ireland", "IL": "Israel",
    "IN": "India", "IQ": "Iraq", "IR": "Iran", "IS": "Iceland",
    "IT": "Italy", "JM": "Jamaica", "JO": "Jordan", "JP": "Japan",
    "KE": "Kenya", "KG": "Kyrgyzstan", "KH": "Cambodia", "KR": "Korea",
    "KW": "Kuwait", "KZ": "Kazakhstan", "LA": "Laos", "LB": "Lebanon",
    "LK": "Sri Lanka", "LT": "Lithuania", "LU": "Luxembourg", "LV": "Latvia",
    "LY": "Libya", "MA": "Morocco", "MD": "Moldova", "ME": "Montenegro",
    "MK": "N. Macedonia", "ML": "Mali", "MM": "Myanmar", "MN": "Mongolia",
    "MT": "Malta", "MU": "Mauritius", "MX": "Mexico", "MY": "Malaysia",
    "NG": "Nigeria", "NI": "Nicaragua", "NL": "Netherlands", "NO": "Norway",
    "NP": "Nepal", "NZ": "New Zealand", "OM": "Oman", "PA": "Panama",
    "PE": "Peru", "PH": "Philippines", "PK": "Pakistan", "PL": "Poland",
    "PR": "Puerto Rico", "PS": "Palestine", "PT": "Portugal", "PY": "Paraguay",
    "QA": "Qatar", "RO": "Romania", "RS": "Serbia", "RU": "Russia",
    "RW": "Rwanda", "SA": "Saudi Arabia", "SD": "Sudan", "SE": "Sweden",
    "SG": "Singapore", "SI": "Slovenia", "SK": "Slovakia", "SN": "Senegal",
    "SO": "Somalia", "SS": "South Sudan", "SV": "El Salvador", "SY": "Syria",
    "TH": "Thailand", "TJ": "Tajikistan", "TM": "Turkmenistan", "TN": "Tunisia",
    "TR": "Turkey", "TT": "Trinidad", "TW": "Taiwan", "TZ": "Tanzania",
    "UA": "Ukraine", "UG": "Uganda", "US": "USA", "UY": "Uruguay",
    "UZ": "Uzbekistan", "VE": "Venezuela", "VN": "Vietnam", "YE": "Yemen",
    "ZA": "South Africa", "ZM": "Zambia", "ZW": "Zimbabwe",
}


class _VoicePickerDialog(QDialog):
    """Modal flag-grid voice picker.

    UX flow:

    1. Top half: scrollable 4-column grid of flag tiles, one per country
       represented in the active backend's voice list. Each tile shows
       the flag emoji, country name, and voice count.
    2. Click a flag → bottom half repopulates with just that country's
       voices.
    3. Pick a voice; click OK (or double-click the row) to commit.

    Returns the chosen voice id via :meth:`selected_voice_id` after the
    dialog is accepted.
    """

    def __init__(
        self,
        *,
        voices: list,
        current_voice_id: str = "",
        title: str = "Pick a voice",
        parent: Optional[QWidget] = None,
    ) -> None:
        super().__init__(parent)
        self.setWindowTitle(title)
        self.resize(640, 580)

        self._voices = list(voices or [])
        self._current_voice_id = current_voice_id
        self._selected_voice_id = current_voice_id
        self._active_country = ""  # "" = show all
        self._buckets: dict = {}  # country_code → list[VoiceInfo]
        self._tile_buttons: dict = {}  # country_code → QPushButton

        self._bucket_voices()

        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(10)

        intro = QLabel(
            "Pick a country flag to filter the voice list. Auto-pick "
            "(default voice) is also offered as the first tile."
        )
        intro.setWordWrap(True)
        intro.setStyleSheet("color:#9aa0a6; background:transparent;")
        layout.addWidget(intro)

        # Scrollable flag grid.
        from PySide6.QtWidgets import QGridLayout
        self._flags_scroll = QScrollArea()
        self._flags_scroll.setWidgetResizable(True)
        self._flags_scroll.setFrameShape(QFrame.NoFrame)
        self._flags_scroll.setStyleSheet(
            "QScrollArea { background:transparent; border:none; }"
        )
        self._flags_scroll.setMinimumHeight(220)
        flags_host = QWidget()
        self._flags_grid = QGridLayout(flags_host)
        self._flags_grid.setContentsMargins(0, 0, 0, 0)
        self._flags_grid.setHorizontalSpacing(8)
        self._flags_grid.setVerticalSpacing(8)
        for col in range(4):
            self._flags_grid.setColumnStretch(col, 1)
        self._flags_host = flags_host
        self._flags_scroll.setWidget(flags_host)
        layout.addWidget(self._flags_scroll, 0)

        # Filtered voice list.
        self._voice_list = QListWidget()
        self._voice_list.setStyleSheet(
            "QListWidget { background:#14171d; color:#fff; border:none; "
            "border-radius:8px; padding:6px; font-size:13px; } "
            "QListWidget::item { padding:8px 10px; border-radius:6px; } "
            "QListWidget::item:selected { background:rgba(92,240,255,0.18); "
            "color:#5cf0ff; }"
        )
        self._voice_list.itemSelectionChanged.connect(self._on_voice_selected)
        self._voice_list.itemDoubleClicked.connect(lambda *_: self.accept())
        layout.addWidget(self._voice_list, 1)

        # Bottom action bar.
        btn_row = QHBoxLayout()
        btn_row.setSpacing(8)
        self._preview_btn = QPushButton("▶ Preview")
        self._preview_btn.setMinimumHeight(34)
        self._preview_btn.setMinimumWidth(110)
        self._preview_btn.setStyleSheet(
            "QPushButton { background:rgba(255,255,255,0.06); color:#dadcdf; "
            "border:none; border-radius:8px; padding:0 14px; font-size:13px; } "
            "QPushButton:hover { background:rgba(255,255,255,0.12); } "
            "QPushButton:disabled { color:#555; }"
        )
        self._preview_btn.setEnabled(False)
        self._preview_btn.clicked.connect(self._on_preview)
        btn_row.addWidget(self._preview_btn)
        btn_row.addStretch(1)

        cancel_btn = QPushButton("Cancel")
        cancel_btn.setMinimumHeight(34)
        cancel_btn.setMinimumWidth(96)
        cancel_btn.setStyleSheet(
            "QPushButton { background:rgba(255,255,255,0.06); color:#dadcdf; "
            "border:none; border-radius:8px; padding:0 14px; font-size:13px; } "
            "QPushButton:hover { background:rgba(255,255,255,0.12); }"
        )
        cancel_btn.clicked.connect(self.reject)
        btn_row.addWidget(cancel_btn)

        self._ok_btn = QPushButton("Use this voice")
        self._ok_btn.setMinimumHeight(34)
        self._ok_btn.setMinimumWidth(140)
        self._ok_btn.setStyleSheet(
            "QPushButton { background:#4a6cff; color:white; border:none; "
            "border-radius:8px; padding:0 18px; font-weight:600; font-size:13px; } "
            "QPushButton:hover { background:#5a7bff; } "
            "QPushButton:disabled { background:#2c313c; color:#777; }"
        )
        self._ok_btn.setEnabled(False)
        self._ok_btn.clicked.connect(self.accept)
        btn_row.addWidget(self._ok_btn)
        layout.addLayout(btn_row)

        self._populate_flags()

        # If the user already had a voice picked, jump straight to that
        # country and preselect the row — fewer clicks to "I want to
        # tweak my current voice".
        if current_voice_id:
            for cc, voices_in_cc in self._buckets.items():
                if any(v.id == current_voice_id for v in voices_in_cc):
                    self._select_country(cc)
                    return
        # Otherwise show All by default.
        self._select_country("")

    # ------------------------------------------------------------------
    # Bucketing
    # ------------------------------------------------------------------

    def _bucket_voices(self) -> None:
        """Group voices by country code so each flag tile can show a
        count and the list filter can render in O(1)."""
        from collections import defaultdict
        buckets: dict = defaultdict(list)
        for v in self._voices:
            _lang, country = _split_locale(getattr(v, "language_code", ""))
            buckets[country].append(v)
        # Stable sort each bucket so the list looks the same on every open.
        for cc in buckets:
            buckets[cc].sort(key=lambda x: x.name.lower())
        self._buckets = dict(buckets)

    # ------------------------------------------------------------------
    # Flag grid population
    # ------------------------------------------------------------------

    def _populate_flags(self) -> None:
        # Clear any previous tiles.
        while self._flags_grid.count():
            it = self._flags_grid.takeAt(0)
            w = it.widget()
            if w is not None:
                w.deleteLater()
        self._tile_buttons.clear()

        # Build the country list. "All" tile first, then countries
        # sorted by voice count (descending) so the most populous
        # languages bubble to the top of the grid.
        tiles: list = [("", f"All ({len(self._voices)})")]
        for cc, voices in sorted(
            self._buckets.items(),
            key=lambda kv: (-len(kv[1]), kv[0] or "ZZ"),
        ):
            if not cc:
                # "Other" bucket — voices with no country code.
                tiles.append(("__other__", f"Other ({len(voices)})"))
                continue
            name = _COUNTRY_NAMES.get(cc, cc)
            tiles.append((cc, f"{name} ({len(voices)})"))

        # Lay out 4 columns wide.
        for i, (key, caption) in enumerate(tiles):
            row, col = divmod(i, 4)
            tile = self._make_flag_tile(key, caption)
            self._flags_grid.addWidget(tile, row, col)
            self._tile_buttons[key] = tile

        # Bottom row stretch so the grid doesn't fight the scroll area
        # for vertical space.
        self._flags_grid.setRowStretch(self._flags_grid.rowCount(), 1)

    def _make_flag_tile(self, key: str, caption: str) -> QPushButton:
        if key == "":
            flag = "🌍"
        elif key == "__other__":
            flag = "🌐"
        else:
            flag = _country_to_flag(key)
        btn = QPushButton(f"{flag}\n{caption}")
        btn.setCheckable(True)
        btn.setMinimumHeight(76)
        btn.setStyleSheet(
            "QPushButton { background:rgba(255,255,255,0.05); color:#dadcdf; "
            "border:1px solid rgba(255,255,255,0.08); border-radius:10px; "
            "padding:8px; font-size:24px; } "
            "QPushButton:hover { background:rgba(255,255,255,0.10); "
            "border:1px solid rgba(108,240,255,0.30); } "
            "QPushButton:checked { background:rgba(92,240,255,0.18); "
            "color:#5cf0ff; border:1px solid #5cf0ff; }"
        )
        btn.clicked.connect(lambda _checked=False, k=key: self._select_country(k))
        return btn

    # ------------------------------------------------------------------
    # Selection
    # ------------------------------------------------------------------

    def _select_country(self, country_key: str) -> None:
        self._active_country = country_key
        for k, btn in self._tile_buttons.items():
            btn.setChecked(k == country_key)
        self._populate_voice_list()

    def _populate_voice_list(self) -> None:
        self._voice_list.clear()
        if self._active_country == "":
            voices = list(self._voices)
        elif self._active_country == "__other__":
            voices = self._buckets.get("", [])
        else:
            voices = self._buckets.get(self._active_country, [])

        # Stable order: by name within the bucket.
        voices = sorted(voices, key=lambda v: v.name.lower())

        restore_idx = 0
        for i, v in enumerate(voices):
            item = QListWidgetItem(v.name, self._voice_list)
            item.setData(Qt.UserRole, v.id)
            if v.id == self._current_voice_id:
                restore_idx = i

        if self._voice_list.count() > 0:
            self._voice_list.setCurrentRow(restore_idx)
        else:
            self._on_voice_selected()  # disables OK / Preview

    def _on_voice_selected(self) -> None:
        cur = self._voice_list.currentItem()
        if cur is None:
            self._selected_voice_id = ""
            self._ok_btn.setEnabled(False)
            self._preview_btn.setEnabled(False)
            return
        self._selected_voice_id = str(cur.data(Qt.UserRole) or "")
        self._ok_btn.setEnabled(bool(self._selected_voice_id))
        self._preview_btn.setEnabled(bool(self._selected_voice_id))

    # ------------------------------------------------------------------
    # Preview
    # ------------------------------------------------------------------

    def _on_preview(self) -> None:
        if not self._selected_voice_id:
            return
        try:
            from core.voice import get_tts_service
            svc = get_tts_service()
        except Exception:  # noqa: BLE001
            return
        if svc is None or not svc.available:
            return
        sample = "Hi, this is what this voice sounds like."
        was = svc.enabled
        try:
            svc.set_enabled(True)
            svc.speak(sample, voice_id=self._selected_voice_id, rate=0)
        finally:
            svc.set_enabled(was)

    # ------------------------------------------------------------------
    # Result
    # ------------------------------------------------------------------

    def selected_voice_id(self) -> str:
        return self._selected_voice_id


class _PiperVoiceManagerDialog(QDialog):
    """Selectable list + bottom action bar for Piper neural voices.

    Each row shows the voice label, language tag, size, and an installed
    badge. The row itself is the selection target (no per-row buttons —
    the previous design hid the Download button off-screen on narrow
    dialogs). The bottom bar has a single action button that flips
    between **Download** and **Delete** based on the selected voice's
    install state, plus a Close button.

    Downloads run on a worker thread so the GUI keeps redrawing during
    the HTTP request; the status line updates as bytes land.
    """

    # Embed the install status into each item via Qt.UserRole + 1 so
    # _on_selection_changed can flip the action button label without
    # re-querying the filesystem.
    _ROLE_ENTRY = Qt.UserRole
    _ROLE_INSTALLED = Qt.UserRole + 1

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("Piper voices")
        self.resize(620, 540)

        # Full catalog (170+ entries from voices.json) cached at first
        # construction. The dialog filters this in-memory on every
        # search keystroke without re-fetching.
        self._catalog: tuple = ()
        self._filter_text: str = ""

        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(10)

        intro = QLabel(
            "Piper has 170+ neural voices across 35+ languages. Pick one "
            "below; click <b>Download</b> to add it (or <b>Delete</b> to "
            "remove an installed one). Downloaded voices appear in each "
            "agent's Voice picker."
        )
        intro.setWordWrap(True)
        intro.setStyleSheet("color:#9aa0a6; background:transparent;")
        layout.addWidget(intro)

        # Search box + Refresh — top of the dialog, always visible.
        search_row = QHBoxLayout()
        search_row.setSpacing(8)
        self._search = QLineEdit()
        self._search.setPlaceholderText(
            "Search by language, country, or speaker name…"
        )
        self._search.setMinimumHeight(32)
        self._search.setStyleSheet(
            "QLineEdit { background:#14171d; color:#fff; border:none; "
            "border-radius:8px; padding:0 12px; font-size:13px; }"
        )
        self._search.textChanged.connect(self._on_search_changed)
        search_row.addWidget(self._search, 1)

        self._refresh_btn = QPushButton("⟳")
        self._refresh_btn.setFixedSize(32, 32)
        self._refresh_btn.setToolTip("Refresh catalog from HuggingFace")
        self._refresh_btn.setStyleSheet(
            "QPushButton { background:rgba(255,255,255,0.06); color:#dadcdf; "
            "border:none; border-radius:6px; font-size:14px; } "
            "QPushButton:hover { background:rgba(255,255,255,0.12); }"
        )
        self._refresh_btn.clicked.connect(lambda: self._reload_catalog(force=True))
        search_row.addWidget(self._refresh_btn)
        layout.addLayout(search_row)

        self._list = QListWidget()
        self._list.setStyleSheet(
            "QListWidget { background:#14171d; color:#fff; border:none; "
            "border-radius:8px; padding:6px; font-size:13px; } "
            "QListWidget::item { padding:8px 10px; border-radius:6px; } "
            "QListWidget::item:selected { background:rgba(92,240,255,0.18); "
            "color:#5cf0ff; }"
        )
        # Single-row selection — the bottom action button targets the
        # current selection, so multi-select would be ambiguous.
        self._list.itemSelectionChanged.connect(self._on_selection_changed)
        layout.addWidget(self._list, 1)

        # Status line — last download progress / error / "ready" message.
        self._status = QLabel("")
        self._status.setStyleSheet("color:#aaa; background:transparent; font-size:12px;")
        layout.addWidget(self._status)

        # Bottom action bar: [Download/Delete]  [Close]
        btn_row = QHBoxLayout()
        btn_row.setSpacing(8)
        btn_row.addStretch(1)

        self.action_btn = QPushButton("Download")
        self.action_btn.setMinimumHeight(36)
        self.action_btn.setMinimumWidth(140)
        self.action_btn.setStyleSheet(
            "QPushButton { background:#4a6cff; color:white; border:none; "
            "border-radius:8px; padding:0 18px; font-weight:600; font-size:13px; } "
            "QPushButton:hover { background:#5a7bff; } "
            "QPushButton:disabled { background:#2c313c; color:#777; }"
        )
        self.action_btn.clicked.connect(self._on_action_clicked)
        self.action_btn.setEnabled(False)  # nothing selected yet
        btn_row.addWidget(self.action_btn)

        close_btn = QPushButton("Close")
        close_btn.setMinimumHeight(36)
        close_btn.setMinimumWidth(96)
        close_btn.setStyleSheet(
            "QPushButton { background:rgba(255,255,255,0.06); color:#dadcdf; "
            "border:none; border-radius:8px; padding:0 18px; font-size:13px; } "
            "QPushButton:hover { background:rgba(255,255,255,0.12); }"
        )
        close_btn.clicked.connect(self.accept)
        btn_row.addWidget(close_btn)

        layout.addLayout(btn_row)

        self._active_worker = None
        # Initial load uses the cache (or the curated fallback) for
        # instant open. The user can hit ⟳ to fetch the live manifest.
        self._reload_catalog(force=False)

    # ------------------------------------------------------------------
    # Population
    # ------------------------------------------------------------------

    def _reload_catalog(self, *, force: bool) -> None:
        """Fetch (or re-fetch) the voices manifest, then refilter the list.

        First open uses the cache so the dialog appears instantly even
        offline; the ⟳ button forces a re-download from HuggingFace.
        Network calls run on a worker thread so the GUI stays alive.
        """
        from PySide6.QtCore import QThread, Signal as _Signal

        self._search.setEnabled(False)
        self._refresh_btn.setEnabled(False)
        self._status.setText("Loading catalog…")

        class _Worker(QThread):
            done = _Signal(object)  # tuple of catalog entries

            def run(self_w) -> None:  # noqa: N805
                from core.voice import fetch_piper_catalog
                try:
                    cat = fetch_piper_catalog(force_refresh=force)
                except Exception as exc:  # noqa: BLE001
                    logger.exception("piper catalog fetch crashed: %s", exc)
                    cat = ()
                self_w.done.emit(cat)

        w = _Worker(self)

        def _finish(cat) -> None:
            self._search.setEnabled(True)
            self._refresh_btn.setEnabled(True)
            self._catalog = tuple(cat) if cat else ()
            from core.voice import PIPER_CATALOG
            if self._catalog and self._catalog is not PIPER_CATALOG and len(self._catalog) > 1:
                self._status.setText(
                    f"{len(self._catalog)} voices in catalog."
                )
            elif self._catalog:
                self._status.setText(
                    "Using offline catalog — click ⟳ to fetch the full "
                    "list from HuggingFace."
                )
            else:
                self._status.setText(
                    "Catalog unavailable. Check internet and retry ⟳."
                )
            self._populate()
            if self._list.count() > 0 and self._list.currentRow() < 0:
                self._list.setCurrentRow(0)

        w.done.connect(_finish)
        w.start()
        # Hold a reference so the worker isn't GC'd mid-run.
        self._catalog_worker = w

    def _on_search_changed(self, text: str) -> None:
        self._filter_text = (text or "").strip().lower()
        self._populate()

    def _populate(self) -> None:
        """Render whichever catalog entries match the active search."""
        prev_voice_id = ""
        cur = self._list.currentItem()
        if cur is not None:
            entry = cur.data(self._ROLE_ENTRY)
            if entry is not None:
                prev_voice_id = entry.voice_id

        self._list.clear()
        from core.voice import piper_voices_dir
        installed_dir = piper_voices_dir()

        q = self._filter_text
        restore_idx = 0
        shown = 0
        for entry in self._catalog:
            if q and q not in entry.label.lower() and q not in entry.language.lower() \
                    and q not in entry.voice_id.lower():
                continue
            installed = (installed_dir / f"{entry.voice_id}.onnx").exists()
            badge = "  ✓ Installed" if installed else ""
            text = (
                f"{entry.label}\n"
                f"    {entry.language} · {entry.quality} · ~{entry.size_mb} MB"
                f"{badge}"
            )
            item = QListWidgetItem(text, self._list)
            item.setData(self._ROLE_ENTRY, entry)
            item.setData(self._ROLE_INSTALLED, installed)
            if entry.voice_id == prev_voice_id:
                restore_idx = shown
            shown += 1

        if self._list.count() > 0:
            self._list.setCurrentRow(restore_idx)
        else:
            self._on_selection_changed()  # disable the action button

    # ------------------------------------------------------------------
    # Selection / button state
    # ------------------------------------------------------------------

    def _on_selection_changed(self) -> None:
        cur = self._list.currentItem()
        if cur is None:
            self.action_btn.setEnabled(False)
            self.action_btn.setText("Download")
            return
        installed = bool(cur.data(self._ROLE_INSTALLED))
        self.action_btn.setEnabled(True)
        if installed:
            self.action_btn.setText("Delete")
            self.action_btn.setStyleSheet(
                "QPushButton { background:#5a2d2d; color:#ffb0b0; border:none; "
                "border-radius:8px; padding:0 18px; font-weight:600; font-size:13px; } "
                "QPushButton:hover { background:#7a3838; }"
            )
        else:
            self.action_btn.setText("Download")
            self.action_btn.setStyleSheet(
                "QPushButton { background:#4a6cff; color:white; border:none; "
                "border-radius:8px; padding:0 18px; font-weight:600; font-size:13px; } "
                "QPushButton:hover { background:#5a7bff; } "
                "QPushButton:disabled { background:#2c313c; color:#777; }"
            )

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------

    def _selected_entry(self):
        cur = self._list.currentItem()
        return cur.data(self._ROLE_ENTRY) if cur is not None else None

    def _on_action_clicked(self) -> None:
        entry = self._selected_entry()
        if entry is None:
            return
        cur = self._list.currentItem()
        if cur is not None and bool(cur.data(self._ROLE_INSTALLED)):
            self._delete(entry)
        else:
            self._download(entry)

    def _delete(self, entry) -> None:
        from core.voice import delete_piper_voice
        if QMessageBox.question(
            self, "Delete voice",
            f"Delete {entry.label}?\nFiles will be removed from disk.",
        ) != QMessageBox.Yes:
            return
        if delete_piper_voice(entry.voice_id):
            self._status.setText(f"Deleted {entry.voice_id}.")
        else:
            self._status.setText(f"Could not delete {entry.voice_id}.")
        self._populate()
        self._on_selection_changed()

    def _download(self, entry) -> None:
        from PySide6.QtCore import QThread, Signal as _Signal
        from core.voice import download_piper_voice

        # Disable the action button while a download is in flight so the
        # user can't queue a second one before this finishes.
        self.action_btn.setEnabled(False)
        self.action_btn.setText("Downloading…")
        self._status.setText(f"Downloading {entry.label}…")

        class _Worker(QThread):
            log = _Signal(str)
            done = _Signal(str)  # error or ""

            def run(self_w) -> None:  # noqa: N805
                try:
                    download_piper_voice(
                        entry, progress=lambda m: self_w.log.emit(m)
                    )
                    self_w.done.emit("")
                except Exception as exc:  # noqa: BLE001
                    self_w.done.emit(str(exc))

        w = _Worker(self)
        w.log.connect(self._status.setText)

        def _finish(err: str) -> None:
            if err:
                self._status.setText(f"Download failed: {err}")
            else:
                self._status.setText(f"{entry.label} ready.")
            self._populate()
            self._on_selection_changed()

        w.done.connect(_finish)
        w.start()
        self._active_worker = w  # hold a reference until GC


_STATUS_COLOR = {
    _STATUS_IDLE: "#4caf50",
    _STATUS_THINKING: "#dcb0ff",
    _STATUS_WORKING: "#ffd080",
    _STATUS_ERROR: "#ff8c8c",
}

_STATUS_LABEL = {
    _STATUS_IDLE: "Idle",
    _STATUS_THINKING: "Thinking",
    _STATUS_WORKING: "Working",
    _STATUS_ERROR: "Error",
}


def _add_shadow(widget: QWidget, blur: int = 24, y: int = 4, alpha: int = 132) -> None:
    """Soft drop shadow — used everywhere instead of 1px borders."""
    eff = QGraphicsDropShadowEffect(widget)
    eff.setBlurRadius(blur)
    eff.setOffset(0, y)
    eff.setColor(QColor(0, 0, 0, alpha))
    widget.setGraphicsEffect(eff)


# ---------------------------------------------------------------------------
# Agent card — pretty
# ---------------------------------------------------------------------------


class AgentCard(QFrame):
    """One agent's card — self-contained: header, picker, embedded log.

    The card carries its own message log (inline QTextEdit) so the user can
    read what *this specific agent* is doing without a separate global stream
    panel. When the agent is "talking" (status thinking / working) the entire
    card flips to a green-tinted gradient — visually loud, no question who's
    active. Errors flip to a red gradient.
    """

    # Gradient stops for each status, applied to the card body. The "talking"
    # states share the green gradient; idle has a per-role baseline; error
    # is a deep red. Status dot + badge still render too — gradient is the
    # peripheral-vision signal, dot/badge is the precise one.
    _GRADIENTS_LEADER = {
        _STATUS_IDLE:     ("#2a3252", "#1c2030"),
        _STATUS_THINKING: ("#1d4a36", "#15281e"),
        _STATUS_WORKING:  ("#1d4a36", "#15281e"),
        _STATUS_ERROR:    ("#4a1d22", "#28151a"),
    }
    _GRADIENTS_SPECIALIST = {
        _STATUS_IDLE:     ("#222732", "#191c24"),
        _STATUS_THINKING: ("#1d3a2a", "#13211a"),
        _STATUS_WORKING:  ("#1d3a2a", "#13211a"),
        _STATUS_ERROR:    ("#3a1d22", "#211418"),
    }

    def __init__(
        self,
        role: Role,
        on_install_local,
        parent: Optional[QWidget] = None,
    ) -> None:
        super().__init__(parent)
        self.role = role
        self._status = _STATUS_IDLE

        self.setObjectName("AgentCard")
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.setMinimumSize(QSize(320, 280))

        _add_shadow(self)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(18, 14, 18, 14)
        layout.setSpacing(8)

        # Header — single row with everything that doesn't need to be
        # full-width: avatar, name+tag, model picker, status dot, status
        # badge. Previously the model picker had its own row and ate ~40px
        # of vertical space per card; moving it next to the name reclaims
        # that vertical real estate for the log (the actually useful part).
        header = QHBoxLayout()
        header.setSpacing(12)

        from desktop_app.widgets.agent_icons import apply_to_label as _apply_icon_label
        avatar = QLabel()
        avatar.setFixedSize(52, 52)
        avatar.setAlignment(Qt.AlignCenter)
        af = QFont()
        af.setPointSize(26)
        avatar.setFont(af)
        avatar.setStyleSheet("background:transparent; color:#fff;")
        _apply_icon_label(avatar, role.icon or "🤖", size=48)
        header.addWidget(avatar)

        name_box = QVBoxLayout()
        name_box.setSpacing(0)
        self.name_label = QLabel(role.name.capitalize())
        nf = QFont()
        nf.setPointSize(15)
        nf.setBold(True)
        self.name_label.setFont(nf)
        self.name_label.setStyleSheet("color:#fff; background:transparent;")
        name_box.addWidget(self.name_label)
        tag = QLabel("Leader" if role.can_dispatch else "Specialist")
        tag.setStyleSheet(
            "color:#9aa0a6; background:transparent; font-size:11px; "
            "letter-spacing:0.6px; text-transform:uppercase;"
        )
        name_box.addWidget(tag)
        header.addLayout(name_box, 0)

        # Model picker — inline on the header row, takes the remaining
        # horizontal space.
        self.model_picker = ModelPickerButton(on_install_local=on_install_local)
        self.model_picker.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.model_picker.setMinimumHeight(34)
        header.addWidget(self.model_picker, 1)

        # Status badge + dot at the end of the row.
        self.status_badge = QLabel(_STATUS_LABEL[_STATUS_IDLE])
        self.status_badge.setAlignment(Qt.AlignCenter)
        header.addWidget(self.status_badge, 0, Qt.AlignVCenter)

        self.status_dot = QLabel()
        self.status_dot.setFixedSize(10, 10)
        header.addWidget(self.status_dot, 0, Qt.AlignVCenter)

        layout.addLayout(header)

        # Embedded message log — read-only, bounded height, internally
        # scrollable so the card itself doesn't push the page around.
        # Bounded height + word-wrap keeps the card a predictable size; the
        # internal scroll only kicks in for the rare long output.
        self.log_view = QTextEdit()
        self.log_view.setReadOnly(True)
        self.log_view.setLineWrapMode(QTextEdit.WidgetWidth)
        self.log_view.setMinimumHeight(200)
        self.log_view.setFrameShape(QFrame.NoFrame)
        # The log gets its own subtle inset panel so it reads as a nested
        # surface, not as part of the card's background gradient.
        # Font bumped to 13px — the previous 11px was unreadable on most
        # monitors, especially with long markdown replies.
        self.log_view.setStyleSheet("""
            QTextEdit {
                background: rgba(0,0,0,0.28);
                color: #e6e8eb;
                border: none;
                border-radius: 8px;
                padding: 10px 12px;
                font-size: 13px;
                line-height: 1.5;
            }
        """)
        layout.addWidget(self.log_view, 1)

        self.set_status(_STATUS_IDLE)

    # ------------------------------------------------------------------
    # Status / look
    # ------------------------------------------------------------------

    def set_status(self, status: str) -> None:
        """Update status dot, badge, AND the card body gradient.

        Talking states get the green gradient — the whole card lights up so
        you don't have to find the dot to know who's active.
        """
        self._status = status
        color = _STATUS_COLOR[status]

        # Body gradient.
        gradients = (
            self._GRADIENTS_LEADER if self.role.can_dispatch else self._GRADIENTS_SPECIALIST
        )
        top, bot = gradients[status]
        self.setStyleSheet(f"""
            QFrame#AgentCard {{
                background: qlineargradient(
                    x1:0, y1:0, x2:0, y2:1,
                    stop:0 {top}, stop:1 {bot}
                );
                border: none;
                border-radius: 14px;
            }}
        """)

        # Status dot.
        self.status_dot.setStyleSheet(f"background:{color}; border-radius:5px;")
        # Status badge.
        self.status_badge.setText(_STATUS_LABEL[status])
        self.status_badge.setStyleSheet(f"""
            color:{color};
            background:{color}22;
            border:none;
            border-radius:8px;
            padding:4px 12px;
            font-size:10px;
            font-weight:600;
            letter-spacing:0.6px;
            text-transform:uppercase;
        """)

    # ------------------------------------------------------------------
    # Log
    # ------------------------------------------------------------------

    # Per-kind line color in the embedded log. Same palette the global
    # stream used to use — kept consistent so the eye doesn't have to
    # relearn anything.
    _KIND_COLORS = {
        MessageKind.USER:        "#aaaaaa",
        MessageKind.REQUEST:     "#88c0ff",
        MessageKind.REPLY:       "#a0e0a0",
        MessageKind.THOUGHT:     "#dcb0ff",
        MessageKind.TOOL_CALL:   "#ffd080",
        MessageKind.TOOL_RESULT: "#c0c0c0",
        MessageKind.EVENT:       "#ff9090",
    }

    def append_log(self, msg: Message) -> None:
        """Render one bus message into this card's log.

        Heavy lifting:
        * Markdown -> HTML so `**bold**`, `*italic*`, ``code``, ``` blocks,
          `# headings`, and `- bullets` actually render. Without this the
          orchestrator's structured replies collapse into one run-on
          paragraph (the user-visible bug that drove this method's rewrite).
        * Per-kind framing: USER inputs as a quote-style block, REPLIES in
          a panel, THOUGHTs italicised, TOOL_CALLs as code-style one-liners.
        * Horizontal separator between successive entries so the eye can
          chunk the log into distinct turns.
        """
        color = self._KIND_COLORS.get(msg.kind, "#cccccc")
        tag = msg.kind.value.upper()
        raw = (msg.body or "").strip()

        if msg.kind == MessageKind.TOOL_CALL:
            # Tool calls fit on one line; render as code, no markdown pass.
            inner = _escape_html(raw)
            body_html = (
                f"<code style='color:#e8d29a; background:rgba(255,210,128,0.10); "
                f"border-radius:4px; padding:2px 8px; font-size:13px;'>{inner}</code>"
            )
        elif msg.kind == MessageKind.TOOL_RESULT:
            # Tool output is often multi-line text. Strip blank-line runs so
            # the log stays compact, render as preformatted, no markdown.
            short = "\n".join(line for line in raw.splitlines() if line.strip())
            inner = _escape_html(short)
            body_html = (
                f"<pre style='color:#bdc1c6; background:rgba(0,0,0,0.25); "
                f"border-radius:6px; padding:8px 10px; margin:6px 0; "
                f"font-size:12px; white-space:pre-wrap;'>{inner}</pre>"
            )
        elif msg.kind == MessageKind.USER:
            # User goal — quote-style, prominent.
            html = _markdown_to_html(raw)
            body_html = (
                f"<div style='border-left:3px solid #5a6376; "
                f"padding:4px 10px; margin:4px 0; color:#dadcdf;'>"
                f"<b>{html}</b></div>"
            )
        elif msg.kind == MessageKind.THOUGHT:
            html = _markdown_to_html(raw)
            body_html = (
                f"<div style='color:#cdd0d4; font-style:italic; "
                f"margin:2px 0;'>{html}</div>"
            )
        elif msg.kind == MessageKind.REPLY:
            # The most readable item in the log — give it a proper panel.
            html = _markdown_to_html(raw)
            body_html = (
                f"<div style='color:#e6e8eb; background:rgba(160,224,160,0.05); "
                f"border-left:3px solid #4caf50; padding:6px 10px; margin:4px 0; "
                f"border-radius:0 6px 6px 0;'>{html}</div>"
            )
        else:  # EVENT, REQUEST, etc.
            html = _markdown_to_html(raw)
            body_html = f"<div style='color:#eee; margin:2px 0;'>{html}</div>"

        line = (
            f"<div style='margin:0 0 6px 0;'>"
            f"<div style='color:{color}; font-size:11px; font-weight:600; "
            f"letter-spacing:0.6px; margin-bottom:4px;'>[{tag}]</div>"
            f"{body_html}"
            f"</div>"
            # Subtle separator between successive log entries so the eye
            # can chunk the log into discrete turns.
            f"<div style='border-bottom:1px solid rgba(255,255,255,0.06); "
            f"margin:10px 0;'></div>"
        )
        self.log_view.append(line)
        sb = self.log_view.verticalScrollBar()
        sb.setValue(sb.maximum())

    def clear_log(self) -> None:
        self.log_view.clear()


# ---------------------------------------------------------------------------
# Approval card
# ---------------------------------------------------------------------------


class ApprovalCard(QFrame):
    """Pending approval rendered as its own panel — no shared list."""

    def __init__(self, request: ApprovalRequest, on_resolve, parent=None) -> None:
        super().__init__(parent)
        self.request = request
        self._on_resolve = on_resolve

        self.setObjectName("ApprovalCard")
        self.setStyleSheet("""
            QFrame#ApprovalCard {
                background: qlineargradient(
                    x1:0, y1:0, x2:0, y2:1,
                    stop:0 #2a1d22, stop:1 #1c1418
                );
                border: none;
                border-radius: 12px;
            }
        """)
        _add_shadow(self, blur=18, y=2, alpha=108)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(18, 12, 18, 12)
        layout.setSpacing(12)

        text_box = QVBoxLayout()
        text_box.setSpacing(2)
        title = QLabel(
            f"<b>{request.agent}</b> wants to call <code>{request.tool_name}</code>"
        )
        title.setStyleSheet(
            "color:#ffb0b0; background:transparent; font-size:12px;"
        )
        text_box.addWidget(title)
        args_line = QLabel(_short_args(request.args))
        args_line.setStyleSheet(
            "color:#9aa0a6; background:transparent; font-size:11px;"
        )
        args_line.setWordWrap(True)
        text_box.addWidget(args_line)
        layout.addLayout(text_box, 1)

        approve = QPushButton("✓ Approve")
        approve.setMinimumHeight(32)
        approve.setStyleSheet("""
            QPushButton {
                background:#4caf50; color:white;
                border:none; border-radius:8px;
                padding:0 16px; font-weight:600;
            }
            QPushButton:hover { background:#5cbf60; }
        """)
        approve.clicked.connect(
            lambda: self._on_resolve(self.request, ApprovalDecision.APPROVE)
        )
        reject = QPushButton("✗ Reject")
        reject.setMinimumHeight(32)
        reject.setStyleSheet("""
            QPushButton {
                background:rgba(255,140,140,0.12); color:#ff8c8c;
                border:none; border-radius:8px;
                padding:0 16px; font-weight:600;
            }
            QPushButton:hover { background:rgba(255,140,140,0.24); }
        """)
        reject.clicked.connect(
            lambda: self._on_resolve(self.request, ApprovalDecision.REJECT)
        )
        layout.addWidget(approve)
        layout.addWidget(reject)


# ---------------------------------------------------------------------------
# Page
# ---------------------------------------------------------------------------


class AgentsPage(QWidget):
    # Per-agent model selection persists in QSettings under this prefix —
    # one key per role name (kept for legacy / global default). Per-project
    # overrides live in ``Project.model_overrides`` so each project can
    # pick its own models without touching the user's global default.
    _SETTINGS_VENDOR = "LocaLLM"
    _SETTINGS_APP = "OWLLM"
    _SETTINGS_PREFIX = "agents/model_for/"
    _SETTINGS_ACTIVE_PROJECT = "agents/active_project_id"
    _SETTINGS_VOICE_ENABLED = "agents/voice_enabled"

    def __init__(self, main_window=None, parent=None) -> None:
        super().__init__(parent)
        self.main_window = main_window
        self._bus = get_bus()
        self._registry = builtin_registry()
        self._team: Optional[Team] = None
        self._current_goal_id: Optional[str] = None
        self._cards: Dict[str, AgentCard] = {}
        self._approval_cards: Dict[str, ApprovalCard] = {}

        self._settings = QSettings(self._SETTINGS_VENDOR, self._SETTINGS_APP)
        self._project_store = get_project_store()
        self._active_project: Optional[Project] = None

        self._bridge = _BusBridge()
        self._bridge.message.connect(self._on_bus_message)
        self._bridge.approval_requested.connect(self._on_approval_requested)

        self._ensure_default_project()
        self._build_ui()
        self._wire_bus()
        self._kick_off_bootstrap()
        self._init_voice_service()
        # Restore active project from settings (or pick first), populate the
        # team grid + selectors. Selection persistence is wired AFTER the
        # initial pickers populate.
        self._load_active_project()
        self._wire_selection_persistence()
        # Fast critical-deps probe — fires on page open in <100 ms. If
        # anything's missing in the OWLLM Python, surface a "Repair?" dialog
        # IMMEDIATELY rather than waiting 2-3 minutes for the slow
        # `pip list` Requirements scan to also figure it out. Deferred to
        # the next event-loop turn so the page is fully laid out first.
        QTimer.singleShot(150, self._fast_critical_deps_probe)

    def _ensure_default_project(self) -> None:
        """First-run convenience — if no projects exist, seed one with the
        full built-in team. Without this the workspace would open empty
        and the user would have to create a project before doing anything."""
        if self._project_store.list_projects():
            return
        all_defs = list_all_definitions()
        team = sorted(
            (d.name for d in all_defs.values() if d.built_in),
            key=lambda n: (0 if all_defs[n].can_dispatch else 1, n),
        )
        self._project_store.save_project(
            Project(
                name="My first project",
                description="Default OWLLM team — orchestrator + four specialists.",
                team=team,
            )
        )

    # ------------------------------------------------------------------
    # UI
    # ------------------------------------------------------------------

    def _build_ui(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(18, 16, 18, 16)
        outer.setSpacing(12)

        # Bootstrap progress strip.
        self.bootstrap_frame = QFrame()
        self.bootstrap_frame.setFrameShape(QFrame.NoFrame)
        self.bootstrap_frame.setStyleSheet("""
            QFrame {
                background:#23283a;
                border:none;
                border-radius:10px;
            }
        """)
        bs = QVBoxLayout(self.bootstrap_frame)
        bs.setContentsMargins(14, 10, 14, 10)
        self.bootstrap_label = QLabel("Checking agent runtime dependencies…")
        self.bootstrap_label.setStyleSheet(
            "color:#c9d1ff; background:transparent;"
        )
        self.bootstrap_progress = QProgressBar()
        self.bootstrap_progress.setRange(0, 0)
        self.bootstrap_progress.setTextVisible(False)
        self.bootstrap_progress.setFixedHeight(6)
        bs.addWidget(self.bootstrap_label)
        bs.addWidget(self.bootstrap_progress)
        outer.addWidget(self.bootstrap_frame)
        self.bootstrap_frame.setVisible(False)

        # Project selector + team picker — the only top-of-page strip now.
        # Accounts moved out entirely; their dedicated 🔐 Accounts tab is
        # the place to manage connection state, and the 4-chip summary
        # here was redundant noise.
        outer.addWidget(self._build_project_strip())

        # The user-side controls (presence, reply, auto-approve, notify
        # settings) used to live in two cards above the goal row. They've
        # been consolidated into a single chat-style SuperUserCard that
        # mounts inside the right pane (under the agent log) — see
        # _build_roster.

        # Goal row + (initially-hidden) attachment chip strip beneath it.
        outer.addLayout(self._build_goal_row())
        outer.addWidget(self._build_attachment_strip())

        # Roster fills the page. The stream panel is gone — each card now
        # carries its own embedded log, so the active agent's output reads
        # in place. The status gradient on the card is the at-a-glance
        # "who's talking" cue; no global timeline needed.
        outer.addWidget(self._build_roster(), 1)

        # Approvals.
        outer.addWidget(self._build_approvals_area())

        # Pull entries into pickers now.
        self._refresh_pickers()

    def _build_accounts_strip(self) -> QWidget:
        frame = QFrame()
        frame.setObjectName("AccountsStrip")
        frame.setStyleSheet("""
            QFrame#AccountsStrip {
                background:palette(alternate-base);
                border:none;
                border-radius:10px;
            }
        """)
        row = QHBoxLayout(frame)
        row.setContentsMargins(14, 8, 14, 8)
        row.setSpacing(14)

        title = QLabel("Accounts")
        title.setStyleSheet(
            "color:#aaa; font-size:11px; background:transparent; "
            "letter-spacing:0.6px; text-transform:uppercase;"
        )
        row.addWidget(title)

        self._account_dots: dict[str, QLabel] = {}
        for key, label in (
            ("claude_subscription", "Claude"),
            ("codex_subscription", "Codex"),
            ("anthropic_api", "Anthropic"),
            ("openai_api", "OpenAI"),
        ):
            chip = QHBoxLayout()
            chip.setSpacing(6)
            dot = QLabel()
            dot.setFixedSize(8, 8)
            dot.setStyleSheet("background:#5a6376; border-radius:4px;")
            self._account_dots[key] = dot
            chip.addWidget(dot)
            text = QLabel(label)
            text.setStyleSheet(
                "color:#dadcdf; font-size:11px; background:transparent;"
            )
            chip.addWidget(text)
            host = QWidget()
            host.setLayout(chip)
            row.addWidget(host)

        row.addStretch(1)

        hint = QLabel("Manage in 🔐 Accounts tab")
        hint.setStyleSheet(
            "color:#666; font-size:11px; background:transparent;"
        )
        row.addWidget(hint)

        # Tick to refresh the dots.
        self._account_timer = QTimer(self)
        self._account_timer.setInterval(3000)
        self._account_timer.timeout.connect(self._refresh_account_dots)
        self._account_timer.start()
        self._refresh_account_dots()

        return frame

    def _build_goal_row(self) -> QHBoxLayout:
        top = QHBoxLayout()
        top.setSpacing(10)
        # Pending attachments — picked via the 📎 button or dropped onto
        # the goal input. Cleared after each Run. Stored as raw paths so
        # we only call adopt_local_path() at submit time and don't keep a
        # bunch of half-prepared Attachment objects around.
        self._pending_attachment_paths: List[str] = []

        # 📎 attach button — opens a file picker that filters to audio
        # and image types (no video, the bridges don't accept video either).
        self.attach_btn = QPushButton("📎")
        self.attach_btn.setMinimumHeight(38)
        self.attach_btn.setMinimumWidth(44)
        self.attach_btn.setToolTip("Attach an image or audio file")
        self.attach_btn.setStyleSheet("""
            QPushButton {
                background:palette(base);
                color:#dadcdf;
                border:none;
                border-radius:10px;
                font-size:16px;
            }
            QPushButton:hover { background:palette(base); }
        """)
        self.attach_btn.clicked.connect(self._on_attach_clicked)

        self.goal_input = _GoalLineEdit(on_files_dropped=self._add_attachment_paths)
        self.goal_input.setPlaceholderText(
            "Goal — e.g. 'summarise the last commit and propose a follow-up' "
            "(drop an image / audio here)"
        )
        self.goal_input.setMinimumHeight(38)
        self.goal_input.setStyleSheet("""
            QLineEdit {
                background:palette(base);
                color:#fff;
                border:none;
                border-radius:10px;
                padding:0 14px;
                font-size:13px;
            }
            QLineEdit:focus { background:palette(base); }
        """)
        self.goal_input.returnPressed.connect(self._run_clicked)

        self.run_btn = QPushButton("Run")
        self.run_btn.setMinimumHeight(38)
        self.run_btn.setStyleSheet("""
            QPushButton {
                background:#4a6cff; color:white;
                border:none; border-radius:10px;
                padding:0 24px; font-weight:600;
            }
            QPushButton:hover { background:#5a7bff; }
            QPushButton:disabled { background:#2c313c; color:#777; }
        """)
        self.run_btn.clicked.connect(self._run_clicked)

        self.cancel_btn = QPushButton("Cancel")
        self.cancel_btn.setMinimumHeight(38)
        self.cancel_btn.setStyleSheet("""
            QPushButton {
                background:rgba(255,140,140,0.10); color:#ff8c8c;
                border:none; border-radius:10px;
                padding:0 18px;
            }
            QPushButton:hover { background:rgba(255,140,140,0.22); }
            QPushButton:disabled { color:#555; background:transparent; }
        """)
        self.cancel_btn.clicked.connect(self._cancel_clicked)
        self.cancel_btn.setEnabled(False)

        # Telemetry button — opens a non-modal dialog showing per-tool
        # call counts, error rates, p50/p95 latency, last error. Tied to
        # this page's registry so stats reflect what the team has actually
        # been doing in this session.
        self.telemetry_btn = QPushButton("📊")
        self.telemetry_btn.setMinimumHeight(38)
        self.telemetry_btn.setFixedWidth(44)
        self.telemetry_btn.setToolTip("Open the tool-call telemetry panel")
        self.telemetry_btn.setStyleSheet("""
            QPushButton {
                background:rgba(255,255,255,0.05); color:#dadcdf;
                border:none; border-radius:8px; font-size:16px;
            }
            QPushButton:hover { background:rgba(255,255,255,0.10); }
        """)
        self.telemetry_btn.clicked.connect(self._open_telemetry_panel)
        self._telemetry_panel = None  # lazy-built on first click

        # 🔊 voice toggle — gates the TtsService for the whole team. Each
        # agent's voice can also be muted individually via its definition,
        # but this is the master switch the user reaches for first.
        # QToolButton + MenuButtonPopup gives us the speaker icon on the
        # left and a dropdown arrow on the right. Clicking the icon area
        # toggles the global voice mute (same UX as before); clicking
        # the arrow opens a menu with the engine indicator, the
        # "Install natural voices" upgrade and the Piper voice manager.
        # The visible arrow is the discoverability fix — the previous
        # right-click-only menu was effectively hidden.
        self.voice_btn = QToolButton()
        self.voice_btn.setText("🔊")
        self.voice_btn.setMinimumHeight(38)
        self.voice_btn.setMinimumWidth(64)  # +20 px over the old fixed 44 to fit the arrow
        self.voice_btn.setCheckable(True)
        self.voice_btn.setPopupMode(QToolButton.MenuButtonPopup)
        self.voice_btn.setToolButtonStyle(Qt.ToolButtonTextOnly)
        self.voice_btn.setToolTip(
            "Speak agent replies aloud — voice per agent.\n"
            "Click the arrow to switch engine or install natural voices (Piper)."
        )
        self.voice_btn.setStyleSheet("""
            QToolButton {
                background:rgba(255,255,255,0.05); color:#dadcdf;
                border:none; border-radius:8px; font-size:16px;
                padding:0 6px;
            }
            QToolButton:hover { background:rgba(255,255,255,0.10); }
            QToolButton:checked { background:rgba(92,240,255,0.18); color:#5cf0ff; }
            QToolButton:disabled { color:#555; }
            QToolButton::menu-button {
                border:none;
                width:18px;
                background:rgba(255,255,255,0.04);
                border-top-right-radius:8px;
                border-bottom-right-radius:8px;
            }
            QToolButton::menu-button:hover {
                background:rgba(255,255,255,0.14);
            }
            QToolButton::menu-arrow { image:none; }
        """)
        self.voice_btn.clicked.connect(self._on_voice_toggled)

        # Build the menu once, refresh its items just before each show
        # so "Install" vs "Manage" reflects the live install state.
        self._voice_menu = QMenu(self.voice_btn)
        self._voice_menu.aboutToShow.connect(self._refresh_voice_menu)
        self.voice_btn.setMenu(self._voice_menu)

        top.addWidget(self.attach_btn)
        top.addWidget(self.goal_input, 1)
        top.addWidget(self.run_btn)
        top.addWidget(self.cancel_btn)
        top.addWidget(self.telemetry_btn)
        top.addWidget(self.voice_btn)
        return top

    def _open_telemetry_panel(self) -> None:
        """Show (or re-raise) the non-modal telemetry dialog.

        Reusing one instance per page so opening it twice doesn't
        spawn duplicate refresh timers."""
        from desktop_app.widgets.telemetry_panel import TelemetryPanel
        if self._telemetry_panel is not None and self._telemetry_panel.isVisible():
            self._telemetry_panel.raise_()
            self._telemetry_panel.activateWindow()
            return
        # Either never opened or previously closed — build fresh so the
        # refresh timer is bound to a live window.
        self._telemetry_panel = TelemetryPanel(self._registry.telemetry, parent=self)
        self._telemetry_panel.show()

    # ------------------------------------------------------------------
    # Voice (TTS)
    # ------------------------------------------------------------------

    def _init_voice_service(self) -> None:
        """Start the process-wide TTS service and reflect saved state on
        the toggle. The service is a singleton — calling start twice is a
        no-op, which makes this safe to run on every page open."""
        try:
            from core.voice import get_tts_service
            self._tts = get_tts_service()
        except Exception:  # noqa: BLE001 — voice is non-essential
            logger.exception("voice service failed to start")
            self._tts = None
            self.voice_btn.setEnabled(False)
            self.voice_btn.setToolTip(
                "Voice unavailable — pyttsx3 not installed or system TTS is missing"
            )
            return

        if not self._tts.available:
            self.voice_btn.setEnabled(False)
            self.voice_btn.setToolTip(
                "Voice unavailable — pyttsx3 not installed or system TTS is missing"
            )
            return

        # Default ON — the user opted in to "voice for all agents". They can
        # turn it off any time with the button; their choice persists across
        # sessions.
        saved = self._settings.value(self._SETTINGS_VOICE_ENABLED, True)
        if isinstance(saved, str):
            saved = saved.lower() not in ("0", "false", "no")
        enabled = bool(saved)
        self.voice_btn.setChecked(enabled)
        self._tts.set_enabled(enabled)
        self._update_voice_btn_text(enabled)

    def _on_voice_toggled(self, checked: bool) -> None:
        if getattr(self, "_tts", None) is None:
            return
        self._tts.set_enabled(checked)
        self._settings.setValue(self._SETTINGS_VOICE_ENABLED, checked)
        self._update_voice_btn_text(checked)

    def _update_voice_btn_text(self, enabled: bool) -> None:
        # Icon flip is the visual cue: speaker-with-waves on, muted on off.
        self.voice_btn.setText("🔊" if enabled else "🔈")

    def _broadcast_voice_to_team(
        self, voice_id: str, rate: int, enabled: bool, source_agent: str
    ) -> None:
        """Copy ``source_agent``'s voice config onto every other agent in
        the team. Skips built-ins (Studio enforces "duplicate first" for
        edits — silently skipping them keeps the broadcast UX consistent
        with everywhere else in OWLLM).

        Each row's combo / spinbox is updated in-place under the
        ``_loading`` guard so the persistence callback doesn't fire for
        rows we just touched programmatically.
        """
        if QMessageBox.question(
            self,
            "Apply voice to team",
            "Apply this voice setting to all custom agents on the team?\n"
            "(Built-in agents stay unchanged — duplicate them in Studio "
            "to override.)",
        ) != QMessageBox.Yes:
            return

        from core.agents.agent_definitions import get_definition, save_custom

        applied: list = []
        skipped: list = []
        for name in list(self._voice_rows.keys()):
            if name == source_agent:
                continue
            try:
                d = get_definition(name)
            except Exception:  # noqa: BLE001
                continue
            if d is None or d.built_in:
                skipped.append(name)
                continue
            try:
                d.voice_id = voice_id
                d.voice_rate = int(rate or 0)
                d.voice_enabled = bool(enabled)
                save_custom(d)
                applied.append(name)
            except Exception:  # noqa: BLE001
                logger.exception("could not apply voice to %s", name)
                continue
            # Sync the live row widgets to the new state.
            row = self._voice_rows.get(name)
            if row is not None:
                row._loading = True  # type: ignore[attr-defined]
                try:
                    row.enabled_cb.setChecked(bool(enabled))
                    row.rate_spin.setValue(int(rate or 0))
                    row.set_voice_id(voice_id)
                finally:
                    row._loading = False  # type: ignore[attr-defined]
            # Push the new label onto the canvas node + info card.
            try:
                self._update_canvas_voice_label(name)
            except Exception:
                pass

        msg = f"Applied to {len(applied)} agent(s)."
        if skipped:
            msg += f"\nSkipped built-ins: {', '.join(skipped)}."
        QMessageBox.information(self, "Apply voice to team", msg)

    def _build_voice_rows(self, team_defs: list) -> None:
        """One :class:`_AgentVoiceRow` per agent, parented under
        ``voice_host`` and hidden by default. The selection handler shows
        whichever row matches the current agent."""
        for d in team_defs:
            row = _AgentVoiceRow(
                d.name,
                on_install_voice=self._install_voice_engine,
                on_open_voice_manager=self._open_piper_voice_manager,
                on_changed=self._update_canvas_voice_label,
                on_broadcast=self._broadcast_voice_to_team,
                parent=self.voice_host,
            )
            row.setVisible(False)
            self._voice_slot_layout.addWidget(row)
            self._voice_rows[d.name] = row

    def _install_voice_engine(self) -> None:
        """Prompt the user, then pip-install pyttsx3 into the running
        interpreter. Same install pattern the agent runtime manager uses
        for the Anthropic / OpenAI SDKs."""
        if QMessageBox.question(
            self,
            "Install voice",
            "Voice output needs the pyttsx3 package (one-time install,"
            " ~50 KB, no model download).\n\nInstall it now?",
        ) != QMessageBox.Yes:
            return
        import subprocess, sys
        try:
            creationflags = 0x08000000 if sys.platform == "win32" else 0
            proc = subprocess.run(
                [sys.executable, "-m", "pip", "install", "pyttsx3>=2.90,<3.0"],
                capture_output=True, text=True, check=False,
                creationflags=creationflags,
            )
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "Install voice", f"pip install failed: {exc}")
            return
        if proc.returncode != 0:
            QMessageBox.warning(
                self, "Install voice",
                f"pip install failed (exit {proc.returncode}).\n\n"
                f"{(proc.stderr or '').strip()[:600]}",
            )
            return
        # Reset the cached service so the next get_tts_service() picks
        # up the freshly-importable backend.
        try:
            import core.voice.tts_service as svc_mod
            svc_mod._service = None  # type: ignore[attr-defined]
        except Exception:
            pass
        # Rebuild the voice rows so the combos populate from the live engine.
        try:
            self._render_team()
        except Exception:
            logger.exception("could not re-render team after voice install")
        self._init_voice_service()
        QMessageBox.information(
            self, "Install voice",
            "Voice engine installed. Click ▶ Preview on an agent to test.",
        )

    # ------------------------------------------------------------------
    # Voice engine selection / Piper management
    # ------------------------------------------------------------------

    def _refresh_voice_menu(self) -> None:
        """Rebuild the dropdown menu items just before it shows.

        Rebuilding rather than statically populating in ``_build_goal_row``
        means the install state (piper installed yet? voices downloaded?)
        is always live: as soon as a download completes the menu shows
        "Manage Piper voices" instead of "Install natural voices" without
        any explicit refresh call.
        """
        menu = self._voice_menu
        menu.clear()

        active = self._active_engine_label()
        engine_act = menu.addAction(f"Engine: {active}")
        engine_act.setEnabled(False)
        menu.addSeparator()

        from core.voice import (
            is_edge_tts_importable,
            is_piper_importable,
            list_installed_piper_voice_files,
        )

        # Edge-TTS — top-tier quality (Microsoft Azure neural voices).
        # Only entry point is install; once installed it's auto-preferred
        # by the service factory and the per-agent voice combos light
        # up with the full list (~80 voices) on the next refresh.
        if not is_edge_tts_importable():
            ed = menu.addAction("⭐ Install premium voices (Edge-TTS, online)")
            ed.triggered.connect(self._install_edge_tts)

        # Piper — local neural voices.
        piper_pkg = is_piper_importable()
        piper_voices = list_installed_piper_voice_files()
        if not piper_pkg or not piper_voices:
            up = menu.addAction("✨ Install natural voices (Piper, offline)")
            up.triggered.connect(self._upgrade_to_piper)
        else:
            mgr = menu.addAction("Manage Piper voices…")
            mgr.triggered.connect(self._open_piper_voice_manager)

        menu.addSeparator()
        repair = menu.addAction("Restart voice engine")
        repair.triggered.connect(self._restart_voice_engine)

    def _active_engine_label(self) -> str:
        tts = getattr(self, "_tts", None)
        if tts is None or not tts.available:
            return "none"
        backend = getattr(tts, "_backend", None)
        return getattr(backend, "name", "?") if backend is not None else "?"

    def _restart_voice_engine(self) -> None:
        """Drop the cached service so the next call rebuilds it. Useful
        after manually adding voices or installing a package outside the
        in-app installer."""
        try:
            import core.voice.tts_service as svc_mod
            if svc_mod._service is not None:  # type: ignore[attr-defined]
                try:
                    svc_mod._service.stop()
                except Exception:  # noqa: BLE001
                    pass
            svc_mod._service = None  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            pass
        try:
            self._render_team()
        except Exception:
            logger.exception("could not re-render team after engine restart")
        self._init_voice_service()

    def _upgrade_to_piper(self) -> None:
        """One-click upgrade: pip-install piper-tts (if missing) then
        download the default Piper voice. Runs the heavy work on a
        worker thread so the GUI stays responsive — the dialog updates
        as steps complete."""
        from core.voice import (
            DEFAULT_PIPER_VOICE_ID,
            find_piper_catalog_entry,
            is_piper_importable,
        )
        entry = find_piper_catalog_entry(DEFAULT_PIPER_VOICE_ID)
        if entry is None:
            QMessageBox.warning(
                self, "Install Piper",
                "Default voice missing from catalog — please report this.",
            )
            return
        msg = (
            "About to install the Piper neural-voice engine:\n\n"
            f"  • pip install piper-tts (~80 MB, includes onnxruntime)\n"
            f"  • download {entry.label} (~{entry.size_mb} MB)\n\n"
            "Continue?"
        )
        if QMessageBox.question(self, "Install natural voices", msg) != QMessageBox.Yes:
            return

        progress = QProgressDialog(
            "Preparing…", "Cancel", 0, 0, self,
        )
        progress.setWindowTitle("Installing Piper")
        progress.setMinimumDuration(0)
        progress.setAutoClose(False)
        progress.setCancelButton(None)  # cancellation mid-pip would corrupt env
        progress.show()

        # Worker — runs pip + download off the GUI thread. Any output
        # the worker wants on screen goes through a Qt signal so we
        # never touch QWidget state from the wrong thread.
        from PySide6.QtCore import QThread, Signal as _Signal

        class _Worker(QThread):
            log = _Signal(str)
            done = _Signal(str)  # error string, "" on success

            def run(self_w) -> None:  # noqa: N805
                import subprocess, sys
                try:
                    if not is_piper_importable():
                        self_w.log.emit("pip install piper-tts… (this can take a minute)")
                        creationflags = 0x08000000 if sys.platform == "win32" else 0
                        proc = subprocess.run(
                            [sys.executable, "-m", "pip", "install",
                             "piper-tts>=1.2.0,<2.0.0"],
                            capture_output=True, text=True, check=False,
                            creationflags=creationflags, timeout=600,
                        )
                        if proc.returncode != 0:
                            self_w.done.emit(
                                f"pip install failed (exit {proc.returncode}):\n"
                                f"{(proc.stderr or '').strip()[:600]}"
                            )
                            return
                    self_w.log.emit("downloading default voice…")
                    from core.voice import download_piper_voice
                    download_piper_voice(entry, progress=lambda m: self_w.log.emit(m))
                    self_w.done.emit("")
                except Exception as exc:  # noqa: BLE001
                    self_w.done.emit(str(exc))

        worker = _Worker(self)
        worker.log.connect(progress.setLabelText)

        def _finish(err: str) -> None:
            progress.close()
            if err:
                QMessageBox.warning(self, "Install Piper", err)
                return
            self._restart_voice_engine()
            # Drop the user straight into the voice catalog so the
            # "I just got Piper, where are all the voices?" gap closes
            # itself. The default Amy voice is already downloaded;
            # pick any others from the list and the per-agent voice
            # combos repopulate the moment the dialog closes.
            self._open_piper_voice_manager()

        worker.done.connect(_finish)
        worker.start()
        # Keep a reference so the worker isn't GC'd mid-run.
        self._piper_install_worker = worker

    def _install_edge_tts(self) -> None:
        """One-click install of the ``edge-tts`` package. No model
        download — Edge synthesizes server-side, so installing the
        client is the entire setup. Runs on a worker thread; the engine
        flips to Edge automatically once the package is importable."""
        msg = (
            "Install the Edge-TTS client?\n\n"
            "  • pip install edge-tts (~150 KB)\n"
            "  • ~80 Microsoft Azure neural voices (Aria, Jenny, "
            "Andrew, Guy, Ryan, etc.) across 50+ languages\n"
            "  • Quality is significantly better than Piper / SAPI\n"
            "  • Internet required at speak time (no API key)\n"
        )
        if QMessageBox.question(self, "Install Edge voices", msg) != QMessageBox.Yes:
            return

        progress = QProgressDialog("Installing edge-tts…", "Cancel", 0, 0, self)
        progress.setWindowTitle("Installing Edge-TTS")
        progress.setMinimumDuration(0)
        progress.setAutoClose(False)
        progress.setCancelButton(None)
        progress.show()

        from PySide6.QtCore import QThread, Signal as _Signal

        class _Worker(QThread):
            log = _Signal(str)
            done = _Signal(str)

            def run(self_w) -> None:  # noqa: N805
                import subprocess, sys
                self_w.log.emit("pip install edge-tts…")
                creationflags = 0x08000000 if sys.platform == "win32" else 0
                try:
                    proc = subprocess.run(
                        [sys.executable, "-m", "pip", "install",
                         "edge-tts>=6.1.0,<8.0.0"],
                        capture_output=True, text=True, check=False,
                        creationflags=creationflags, timeout=300,
                    )
                except Exception as exc:  # noqa: BLE001
                    self_w.done.emit(str(exc))
                    return
                if proc.returncode != 0:
                    self_w.done.emit(
                        f"pip install failed (exit {proc.returncode}):\n"
                        f"{(proc.stderr or '').strip()[:600]}"
                    )
                    return
                self_w.done.emit("")

        worker = _Worker(self)
        worker.log.connect(progress.setLabelText)

        def _finish(err: str) -> None:
            progress.close()
            if err:
                QMessageBox.warning(self, "Install Edge-TTS", err)
                return
            self._restart_voice_engine()
            QMessageBox.information(
                self, "Edge-TTS ready",
                "Edge voices installed. The agent voice picker now lists "
                "~80 premium voices. Use the ➤ button on a voice row to "
                "broadcast a single voice to all agents.",
            )

        worker.done.connect(_finish)
        worker.start()
        self._edge_install_worker = worker

    def _open_piper_voice_manager(self) -> None:
        """Modal dialog listing the curated Piper catalog with download /
        delete buttons per voice."""
        dlg = _PiperVoiceManagerDialog(self)
        dlg.exec_()
        # Refresh after the user closes the dialog so any newly-downloaded
        # voices show up in the per-agent voice combos immediately.
        self._restart_voice_engine()

    # ------------------------------------------------------------------
    # Attachment chip strip — appears below the goal row when files
    # are attached, hidden when the queue is empty.
    # ------------------------------------------------------------------

    def _build_attachment_strip(self) -> QWidget:
        self.attachment_strip = QFrame()
        self.attachment_strip.setFrameShape(QFrame.NoFrame)
        self.attachment_strip.setStyleSheet("background:transparent;")
        self.attachment_strip.setVisible(False)
        layout = QHBoxLayout(self.attachment_strip)
        layout.setContentsMargins(46, 0, 0, 0)  # align under the prompt input
        layout.setSpacing(6)
        layout.addStretch(1)
        self._attachment_strip_layout = layout
        return self.attachment_strip

    def _on_attach_clicked(self) -> None:
        """Pop a file picker filtered to the supported audio + image types."""
        filters = (
            "Audio or images (*.png *.jpg *.jpeg *.webp *.gif *.bmp *.heic "
            "*.ogg *.oga *.opus *.mp3 *.wav *.m4a *.aac *.flac *.mp4)"
            ";;All files (*)"
        )
        paths, _ = QFileDialog.getOpenFileNames(self, "Attach files", "", filters)
        if paths:
            self._add_attachment_paths(paths)

    def _add_attachment_paths(self, paths: List[str]) -> None:
        """Append paths to the pending queue, dropping unsupported files."""
        added = 0
        for p in paths or []:
            if not p or p in self._pending_attachment_paths:
                continue
            # We can't fully validate without reading bytes; do the
            # cheap MIME guess up-front so a stray .pdf doesn't sit in
            # the strip pretending it'll be sent.
            from core.agents.attachments import classify_mime
            guess = classify_mime("", p)
            if guess is None:
                logger.info("ignoring unsupported attachment: %s", p)
                continue
            self._pending_attachment_paths.append(p)
            added += 1
        if added:
            self._refresh_attachment_strip()

    def _remove_attachment_path(self, path: str) -> None:
        try:
            self._pending_attachment_paths.remove(path)
        except ValueError:
            return
        self._refresh_attachment_strip()

    def _refresh_attachment_strip(self) -> None:
        # Wipe existing chips, keeping the trailing stretch.
        layout = self._attachment_strip_layout
        while layout.count() > 1:
            item = layout.takeAt(0)
            w = item.widget()
            if w:
                w.deleteLater()
        for path in self._pending_attachment_paths:
            chip = self._make_attachment_chip(path)
            layout.insertWidget(layout.count() - 1, chip)
        self.attachment_strip.setVisible(bool(self._pending_attachment_paths))

    def _make_attachment_chip(self, path: str) -> QWidget:
        from core.agents.attachments import classify_mime
        kind = classify_mime("", path) or KIND_AUDIO
        glyph = "🖼️" if kind == KIND_IMAGE else "🎵"
        name = os.path.basename(path)

        chip = QFrame()
        chip.setStyleSheet("""
            QFrame {
                background:#1a1f2c;
                border:1px solid #2a3142;
                border-radius:14px;
            }
            QLabel { background:transparent; color:#dadcdf; }
            QPushButton {
                background:transparent;
                color:#9aa3b2;
                border:none;
                font-size:14px;
                padding:0 4px;
            }
            QPushButton:hover { color:#ff7777; }
        """)
        chip_layout = QHBoxLayout(chip)
        chip_layout.setContentsMargins(10, 4, 6, 4)
        chip_layout.setSpacing(6)
        chip_layout.addWidget(QLabel(glyph))
        label = QLabel(name)
        label.setMaximumWidth(220)
        chip_layout.addWidget(label)
        remove = QPushButton("×")
        remove.setCursor(Qt.PointingHandCursor)
        remove.setToolTip(f"Remove {name}")
        remove.clicked.connect(lambda _=False, p=path: self._remove_attachment_path(p))
        chip_layout.addWidget(remove)
        return chip

    def _consume_pending_attachments(self) -> List[Attachment]:
        """Move pending paths into ``Attachment`` objects + reset the strip.

        Called at submit time. Files that fail validation (oversized,
        wrong mime after a closer look, unreadable) are silently dropped.
        Returns an empty list when nothing is queued.
        """
        out: List[Attachment] = []
        # The real goal id is created inside ``team.run_goal``; we don't
        # know it yet, so save under the "chat-pending" slot. The runtime
        # cleanup script can sweep that dir on app start later.
        for path in list(self._pending_attachment_paths):
            att = adopt_local_path(
                "chat-pending",
                path,
                source="chat",
            )
            if att is not None:
                out.append(att)
        self._pending_attachment_paths.clear()
        self._refresh_attachment_strip()
        return out

    def _build_roster(self) -> QWidget:
        """Two-pane workspace: canvas (left) + per-agent log (right).

        The canvas hosts draggable agent nodes connected by directional
        arrows. The right pane shows the log of whichever agent is
        currently selected; if none is selected, it shows the orchestrator's
        view (the broadest stream).

        While a goal runs, the active agent's node turns green via
        :py:meth:`AgentCanvas.set_node_status`. Clicking another node
        re-points the log pane at THAT agent's history without affecting
        the run.
        """
        # Per-agent message buffers, keyed by agent name. Each agent's log
        # is the union of (a) messages it sent, (b) messages addressed
        # to it. We store messages and re-render the right pane whenever
        # the selection changes or a new message arrives for the selected
        # agent. Cleared on team rebuild.
        self._agent_logs: Dict[str, list] = {}
        self._selected_agent: Optional[str] = None
        # Per-card model pickers used to live on AgentCard. With the canvas
        # they live in a row inside the right pane (compact strip).
        self._cards = {}  # legacy attribute kept for `_render_team` clear
        self._model_picker_buttons: Dict[str, ModelPickerButton] = {}
        self._voice_rows: Dict[str, "_AgentVoiceRow"] = {}

        # Overlay model pickers — one per canvas — sit inside the
        # painted info card. The right-pane picker still exists; these
        # are an additional surface that lets the user change the model
        # without leaving the team diagram. Mode tracks where the next
        # selection_changed signal should be routed: a specific agent
        # (per-agent override) or "team" (apply to every team member).
        self._overlay_picker_team: Optional[ModelPickerButton] = None
        self._overlay_picker_canvas: Optional[ModelPickerButton] = None
        self._overlay_mode: str = ""  # "agent:<name>" | "team" | ""
        # ModelPickerButton.refresh_entries() auto-picks the first
        # available model and emits selection_changed when its current_id
        # is empty. For the per-agent right-pane pickers that's harmless
        # (their handler is connected last, on purpose); for the overlay
        # picker we MUST squash that emit, otherwise a programmatic
        # refresh during init / bootstrap would silently apply that
        # default model to every team member via the team-mode handler.
        self._suspend_overlay_signal: bool = False

        splitter = QSplitter(Qt.Horizontal)
        splitter.setHandleWidth(8)
        splitter.setStyleSheet("""
            QSplitter::handle {
                background:#1a1f2c;
                border-radius:3px;
            }
        """)

        # ---------------------------- LEFT: canvas ----------------------------
        left = QFrame()
        left.setFrameShape(QFrame.NoFrame)
        lv = QVBoxLayout(left)
        lv.setContentsMargins(0, 0, 0, 0)
        lv.setSpacing(8)

        canvas_header = QHBoxLayout()
        title = QLabel("Flow")
        tf = QFont()
        tf.setPointSize(12)
        tf.setBold(True)
        title.setFont(tf)
        title.setStyleSheet("color:#fff; background:transparent;")
        canvas_header.addWidget(title)
        hint = QLabel(
            "· Solid arrows = strict specialist chain (enforced). "
            "Dashed = orchestrator's free dispatch (always available). "
            "Drag from the cyan dot on a node to connect; right-click for settings."
        )
        hint.setStyleSheet("color:#7888a8; font-size:10pt; background:transparent;")
        hint.setWordWrap(True)
        canvas_header.addWidget(hint, 1)
        canvas_header.addStretch(1)

        delete_edge_btn = QPushButton("✕ Edge")
        delete_edge_btn.setToolTip("Delete the selected edge (or press Delete)")
        delete_edge_btn.setStyleSheet(_GHOST_BTN_STYLE_SMALL)
        delete_edge_btn.clicked.connect(self._on_delete_selected_edge)
        canvas_header.addWidget(delete_edge_btn)

        reverse_edge_btn = QPushButton("⇄ Reverse")
        reverse_edge_btn.setToolTip("Reverse the direction of the selected edge")
        reverse_edge_btn.setStyleSheet(_GHOST_BTN_STYLE_SMALL)
        reverse_edge_btn.clicked.connect(self._on_reverse_selected_edge)
        canvas_header.addWidget(reverse_edge_btn)

        layout_btn = QPushButton("⟲ Layout")
        layout_btn.setToolTip("Auto-arrange agents in a grid")
        layout_btn.setStyleSheet(_GHOST_BTN_STYLE_SMALL)
        layout_btn.clicked.connect(self._on_reset_layout)
        canvas_header.addWidget(layout_btn)

        refresh = QPushButton("⟳")
        refresh.setFixedSize(30, 28)
        refresh.setToolTip("Refresh model lists in every picker")
        refresh.setStyleSheet(_GHOST_BTN_STYLE_SMALL)
        refresh.clicked.connect(self._refresh_pickers)
        canvas_header.addWidget(refresh)

        # Diagram-vs-Graph toggle. Orbital diagram is the default — it
        # carries the live activity animation (agents glow green when
        # working, click an agent to see its skill card). The graph
        # editor stays one click away for users who want to rewire
        # edges manually.
        self._view_toggle_btn = QPushButton("◐ Graph view")
        self._view_toggle_btn.setToolTip("Switch between the live diagram and the editable graph")
        self._view_toggle_btn.setStyleSheet(_GHOST_BTN_STYLE_SMALL)
        self._view_toggle_btn.setCheckable(True)
        self._view_toggle_btn.clicked.connect(self._on_view_toggle_clicked)
        canvas_header.addWidget(self._view_toggle_btn)
        lv.addLayout(canvas_header)

        # Live orbital diagram — the new default visual.
        self.team_canvas = AgentTeamCanvas()
        self.team_canvas.node_selected.connect(self._on_canvas_node_selected)

        # Editable graph canvas — kept for power-user workflows.
        self.canvas = AgentCanvas()
        self.canvas.node_selected.connect(self._on_canvas_node_selected)
        self.canvas.graph_changed.connect(self._on_graph_changed)
        self.canvas.node_context_menu_requested.connect(self._on_canvas_node_context_menu)

        # Stack the two visuals so we can flip between them with the
        # toggle button. Orbital lives at index 0 (default).
        # IMPORTANT: explicitly hide the non-current widget — relying on
        # setCurrentIndex alone has caused the AgentCanvas to bleed
        # through on some Qt versions, leaving the user staring at an
        # almost-empty graph editor instead of the orbital diagram.
        self._canvas_stack = QStackedWidget()
        self._canvas_stack.addWidget(self.team_canvas)  # 0
        self._canvas_stack.addWidget(self.canvas)        # 1
        self._canvas_stack.setCurrentIndex(0)
        self.team_canvas.setVisible(True)
        self.canvas.setVisible(False)
        lv.addWidget(self._canvas_stack, 1)

        # Mount the overlay model pickers — one per canvas — into the
        # bottom of the painted info card. Each canvas re-positions its
        # picker on every paintEvent. selection_mode_changed tells us
        # whether to bind the picker to a specific agent's override or
        # to "team" mode (apply to all members on change).
        self._overlay_picker_team = ModelPickerButton(
            on_install_local=self._open_models_tab, parent=self.team_canvas
        )
        self._suspend_overlay_signal = True
        try:
            self._overlay_picker_team.refresh_entries()
        finally:
            self._suspend_overlay_signal = False
        self.team_canvas.attach_card_picker(self._overlay_picker_team)

        # Super User card — single chat-style overlay that sits directly
        # below the painted info card on the canvas. Combines presence,
        # mini chat log, reply input, auto-approve toggle, and notify
        # settings access into one widget so the user-side controls live
        # alongside the agent's info card on the canvas itself.
        from desktop_app.widgets.super_user_card import SuperUserCard
        self._super_user_card = SuperUserCard(self.team_canvas)
        self._super_user_card.reply_submitted.connect(self._on_user_reply)
        self._super_user_card.supervisor_toggled.connect(self._on_supervisor_toggled)
        self._super_user_card.settings_clicked.connect(self._open_notify_settings)
        self.team_canvas.attach_super_user_card(self._super_user_card)
        self.team_canvas.selection_mode_changed.connect(
            self._on_overlay_selection_mode_changed
        )
        self._overlay_picker_team.selection_changed.connect(
            self._on_overlay_picker_changed
        )

        self._overlay_picker_canvas = ModelPickerButton(
            on_install_local=self._open_models_tab, parent=self.canvas.viewport()
        )
        self._suspend_overlay_signal = True
        try:
            self._overlay_picker_canvas.refresh_entries()
        finally:
            self._suspend_overlay_signal = False
        self.canvas.attach_card_picker(self._overlay_picker_canvas)
        self.canvas.selection_mode_changed.connect(
            self._on_overlay_selection_mode_changed
        )
        self._overlay_picker_canvas.selection_changed.connect(
            self._on_overlay_picker_changed
        )

        self.status_label = QLabel("Idle.")
        self.status_label.setStyleSheet(
            "color:#888; font-size:11px; background:transparent;"
        )
        lv.addWidget(self.status_label)

        splitter.addWidget(left)

        # ---------------------------- RIGHT: log ----------------------------
        right = QFrame()
        right.setFrameShape(QFrame.NoFrame)
        rv = QVBoxLayout(right)
        rv.setContentsMargins(0, 0, 0, 0)
        rv.setSpacing(8)

        # Header that names the currently-selected agent.
        self.log_header = QLabel("Click an agent on the canvas to view its log.")
        lf = QFont()
        lf.setPointSize(12)
        lf.setBold(True)
        self.log_header.setFont(lf)
        self.log_header.setStyleSheet("color:#fff; background:transparent;")
        rv.addWidget(self.log_header)

        # Compact model picker for the SELECTED agent only — clicking a
        # different node swaps which picker is shown. Stored in a stack-y
        # host so we can show/hide them cheaply.
        self.picker_host = QFrame()
        self.picker_host.setStyleSheet("background:transparent;")
        ph = QHBoxLayout(self.picker_host)
        ph.setContentsMargins(0, 0, 0, 4)
        ph.setSpacing(8)
        self._picker_label = QLabel("Model")
        self._picker_label.setStyleSheet(
            "color:#aaa; font-size:11px; background:transparent; "
            "letter-spacing:0.6px; text-transform:uppercase;"
        )
        ph.addWidget(self._picker_label)
        self._picker_slot = QWidget()
        self._picker_slot_layout = QHBoxLayout(self._picker_slot)
        self._picker_slot_layout.setContentsMargins(0, 0, 0, 0)
        self._picker_slot_layout.setSpacing(0)
        ph.addWidget(self._picker_slot, 1)
        rv.addWidget(self.picker_host)
        self.picker_host.setVisible(False)

        # Voice host — sits directly under the model picker so the two
        # "how this agent runs + sounds" controls are stacked together.
        # One row of widgets per agent, only the selected agent's row is
        # shown (same swap pattern as the model picker above).
        self.voice_host = QFrame()
        self.voice_host.setStyleSheet("background:transparent;")
        vh = QHBoxLayout(self.voice_host)
        vh.setContentsMargins(0, 0, 0, 4)
        vh.setSpacing(8)
        self._voice_label = QLabel("Voice")
        self._voice_label.setStyleSheet(
            "color:#aaa; font-size:11px; background:transparent; "
            "letter-spacing:0.6px; text-transform:uppercase;"
        )
        vh.addWidget(self._voice_label)
        self._voice_slot = QWidget()
        self._voice_slot_layout = QHBoxLayout(self._voice_slot)
        self._voice_slot_layout.setContentsMargins(0, 0, 0, 0)
        self._voice_slot_layout.setSpacing(0)
        vh.addWidget(self._voice_slot, 1)
        rv.addWidget(self.voice_host)
        self.voice_host.setVisible(False)

        # Two-tab log surface: Reply (filtered, default) + Thought (raw
        # chain-of-thought stripped from model output). Selecting an agent
        # reopens the Reply tab so users see the answer first.
        log_view_css = """
            QTextEdit {
                background:#0f1218;
                color:#cbd2e0;
                border:none; border-radius:8px;
                padding:10px;
                font-family: Consolas, 'JetBrains Mono', monospace;
                font-size:12px;
            }
        """
        self._chat_view = QTextEdit()
        self._chat_view.setReadOnly(True)
        self._chat_view.setStyleSheet(log_view_css)

        self._thought_view = QTextEdit()
        self._thought_view.setReadOnly(True)
        self._thought_view.setStyleSheet(log_view_css)

        self._log_tabs = QTabWidget()
        self._log_tabs.addTab(self._chat_view, "💬 Reply")
        self._log_tabs.addTab(self._thought_view, "🧠 Thought")
        self._log_tabs.setCurrentIndex(0)
        rv.addWidget(self._log_tabs, 1)
        # Back-compat alias — older code paths (clear, render) still call
        # self.log_view.clear(); the alias keeps them working but writes
        # only to the Reply tab. Thought clearing is handled explicitly.
        self.log_view = self._chat_view

        splitter.addWidget(right)
        splitter.setStretchFactor(0, 2)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([800, 420])

        # Wrap the splitter in a QStackedWidget so we can show an animated
        # loader on top while the requirements scan + agent runtime
        # bootstrap are still resolving (1-2 min on a fresh start). Once
        # both are done we flip to the splitter and the user sees the
        # canvas + log workspace.
        self._workspace_stack = QStackedWidget()
        # IMPORTANT: add the loader FIRST so it becomes the default visible
        # page — Qt's QStackedWidget shows the first inserted widget when
        # ``setCurrentIndex`` hasn't yet had a layout pass. The earlier
        # ordering (splitter then loader) caused the splitter to flash on
        # screen for a frame before the index was forced to 1, which
        # together with the "instant flip" bug below made the loader
        # invisible.
        self._canvas_loader = AgentCanvasLoader()
        self._workspace_stack.addWidget(self._canvas_loader)  # index 0 — loader
        self._workspace_stack.addWidget(splitter)             # index 1 — real workspace
        self._workspace_stack.setCurrentIndex(0)
        self._loading_done = False
        self._loading_finish_timer: Optional[QTimer] = None
        # When the loader was constructed — used to enforce a MINIMUM
        # display time so the animation is always visible even on fast
        # boots where everything reports ready in <1s. Without this,
        # `_poll_loading_state` flips to the workspace in ~500 ms and
        # the user sees a black flash instead of the constellation.
        import time as _time_module
        self._loader_started_at = _time_module.monotonic()
        # Minimum 4 s. Long enough to read the status text, short enough
        # not to feel like a chore on a healthy install.
        self._loader_min_seconds = 4.0

        # Periodically poll the main window's requirements thread state.
        # When that thread reports done AND the agent runtime bootstrap is
        # also done, flip the stack to the workspace.
        self._loading_poll_timer = QTimer(self)
        self._loading_poll_timer.setInterval(500)
        self._loading_poll_timer.timeout.connect(self._poll_loading_state)
        self._loading_poll_timer.start()

        return self._workspace_stack

    # ------------------------------------------------------------------
    # Project strip + team rendering
    # ------------------------------------------------------------------

    def _build_project_strip(self) -> QWidget:
        frame = QFrame()
        frame.setObjectName("ProjectStrip")
        frame.setStyleSheet("""
            QFrame#ProjectStrip {
                background: qlineargradient(
                    x1:0, y1:0, x2:0, y2:1,
                    stop:0 #1f2632, stop:1 palette(alternate-base)
                );
                border:none; border-radius:10px;
            }
        """)
        row = QHBoxLayout(frame)
        row.setContentsMargins(14, 10, 14, 10)
        row.setSpacing(10)

        # Location FIRST, on the same row as the project picker. Free-form
        # text — folder path, server alias, GitHub URL, anything that
        # answers "where does this project live?". Saved on the project
        # whenever the field loses focus.
        loc_label = QLabel("Location")
        loc_label.setStyleSheet(
            "color:#aaa; font-size:11px; background:transparent; "
            "letter-spacing:0.6px; text-transform:uppercase;"
        )
        row.addWidget(loc_label)

        self._location_input = QLineEdit()
        self._location_input.setMinimumHeight(32)
        self._location_input.setPlaceholderText(
            "/path/to/repo · esp-flash · github.com/me/x"
        )
        self._location_input.setStyleSheet("""
            QLineEdit {
                background:palette(base); color:#fff; border:none;
                border-radius:8px; padding:0 12px; font-size:13px;
            }
            QLineEdit:focus { background:palette(base); }
        """)
        # Persist whenever the user finishes typing (focus-out or Enter).
        self._location_input.editingFinished.connect(self._on_location_changed)
        row.addWidget(self._location_input, 2)

        # Browse… button — open a folder picker. Most users want a local
        # directory; the field still accepts free-form aliases/URLs typed
        # in directly. Picking a folder commits via _on_location_changed.
        browse_btn = QPushButton("Browse…")
        browse_btn.setMinimumHeight(32)
        browse_btn.setStyleSheet(_GHOST_BTN_STYLE)
        browse_btn.clicked.connect(self._on_browse_location)
        row.addWidget(browse_btn)

        # "Trust" checkbox — when on AND Location is a real folder, every
        # Run materializes .claude/settings.local.json with a scoped allow
        # rule for Edit/Write/Read so the Claude CLI doesn't prompt for
        # each file. Off by default — explicit consent only.
        self._trust_writes = QCheckBox("Trust writes")
        self._trust_writes.setToolTip(
            "Pre-approve Claude CLI Read/Write/Edit inside the Location "
            "folder. Writes a scoped rule into .claude/settings.local.json "
            "on each Run so the team isn't blocked per file."
        )
        self._trust_writes.setStyleSheet(
            "QCheckBox { color:#dadcdf; background:transparent; "
            "font-size:12px; padding:0 6px; }"
        )
        self._trust_writes.toggled.connect(self._on_trust_writes_toggled)
        row.addWidget(self._trust_writes)

        # Sandbox-status pill. Green = the next Run will execute the CLI
        # subprocess inside Docker with the project mounted at /workspace.
        # Yellow = host fallback (Docker not installed, or kind=worktree
        # in <fleet_root>/runtime.json). Click to open the runtime
        # settings dialog so the user can flip mode without leaving the
        # agents page.
        self._sandbox_badge = QLabel()
        self._sandbox_badge.setObjectName("SandboxBadge")
        self._sandbox_badge.setMinimumHeight(24)
        self._sandbox_badge.setCursor(Qt.PointingHandCursor)
        self._sandbox_badge.setToolTip(
            "Click to open runtime settings (Docker isolation mode)"
        )
        # Plain QLabel doesn't emit clicks; intercept via mouse-press event.
        self._sandbox_badge.mousePressEvent = (
            lambda _ev: self._open_runtime_settings()
        )
        row.addWidget(self._sandbox_badge)
        self._refresh_sandbox_badge()

        label = QLabel("Project")
        label.setStyleSheet(
            "color:#aaa; font-size:11px; background:transparent; "
            "letter-spacing:0.6px; text-transform:uppercase;"
        )
        row.addWidget(label)

        self._project_combo = QComboBox()
        self._project_combo.setMinimumHeight(32)
        self._project_combo.setMinimumWidth(200)
        self._project_combo.setStyleSheet("""
            QComboBox {
                background:palette(base); color:#fff; border:none;
                border-radius:8px; padding:0 12px; font-size:13px;
            }
        """)
        self._project_combo.currentIndexChanged.connect(self._on_project_combo_changed)
        row.addWidget(self._project_combo, 2)

        # Edit team button — opens a dialog with checkboxes for every
        # AgentDefinition (built-in + custom).
        edit_team_btn = QPushButton("Team…")
        edit_team_btn.setMinimumHeight(32)
        edit_team_btn.setStyleSheet(_GHOST_BTN_STYLE)
        edit_team_btn.clicked.connect(self._open_team_picker)
        row.addWidget(edit_team_btn)

        new_btn = QPushButton("+ New")
        new_btn.setMinimumHeight(32)
        new_btn.setStyleSheet(_GHOST_BTN_STYLE)
        new_btn.clicked.connect(self._on_new_project)
        row.addWidget(new_btn)

        # The "From template…" button used to live here. The team
        # catalogue now has a dedicated home — the Studio's Teams view
        # — where templates render as a card matrix with previews,
        # categories, and a 'Create your own team' builder. Removing
        # the button collapses the entry-point sprawl and avoids two
        # places that do the same thing.

        rename_btn = QPushButton("Rename")
        rename_btn.setMinimumHeight(32)
        rename_btn.setStyleSheet(_GHOST_BTN_STYLE)
        rename_btn.clicked.connect(self._on_rename_project)
        row.addWidget(rename_btn)

        delete_btn = QPushButton("Delete")
        delete_btn.setMinimumHeight(32)
        delete_btn.setStyleSheet(_DESTRUCTIVE_GHOST_STYLE)
        delete_btn.clicked.connect(self._on_delete_project)
        row.addWidget(delete_btn)

        return frame

    def _populate_project_combo(self) -> None:
        self._project_combo.blockSignals(True)
        self._project_combo.clear()
        for p in self._project_store.list_projects():
            self._project_combo.addItem(p.name, p.id)
        if self._active_project is not None:
            idx = self._project_combo.findData(self._active_project.id)
            if idx >= 0:
                self._project_combo.setCurrentIndex(idx)
        self._project_combo.blockSignals(False)
        # Keep the location field in lockstep with whichever project is now
        # active.
        self._sync_location_input()

    def _sync_location_input(self) -> None:
        """Mirror the active project's location into the input (sans signal)."""
        if not hasattr(self, "_location_input"):
            return
        self._location_input.blockSignals(True)
        self._location_input.setText(
            self._active_project.location if self._active_project else ""
        )
        self._location_input.blockSignals(False)
        if hasattr(self, "_trust_writes"):
            self._trust_writes.blockSignals(True)
            self._trust_writes.setChecked(
                bool(self._active_project.trust_writes) if self._active_project else False
            )
            self._trust_writes.blockSignals(False)
        # Mirror the per-project auto-approve toggle and apply the gate
        # rule. Project switch implicitly hands a different "trust me"
        # answer for the new project.
        if hasattr(self, "_super_user_card"):
            on = bool(self._active_project.auto_approve_all) if self._active_project else False
            self._super_user_card.set_supervisor_state(on)
            self._apply_supervisor_state(on)
            # Project switch also resets the mini chat log on the card —
            # leftover messages from the previous project would be
            # misleading in the new one.
            self._super_user_card.clear_chat()

    def _on_trust_writes_toggled(self, checked: bool) -> None:
        """Persist the checkbox state on toggle. The actual settings file
        is materialized on Run (idempotent), not here — toggling alone
        shouldn't write to disk in a folder that may not exist yet."""
        if self._active_project is None:
            return
        if bool(self._active_project.trust_writes) == bool(checked):
            return
        self._active_project.trust_writes = bool(checked)
        try:
            self._project_store.save_project(self._active_project)
        except Exception:
            logger.exception("could not save trust_writes flag")

    def _refresh_sandbox_badge(self) -> None:
        """Recompute the green/yellow sandbox pill from the current fleet
        runtime config + Docker availability. Cheap to call — runs on
        project switch and team build. Never raises into the UI."""
        if not hasattr(self, "_sandbox_badge"):
            return
        try:
            from core.fleet.config import default_runtime_config_path
            from core.fleet.container_runtime import ContainerRuntime
            from core.fleet.runtime_config import KIND_CONTAINER, RuntimeConfig
        except Exception:
            self._sandbox_badge.setVisible(False)
            return

        try:
            rc = RuntimeConfig.load(default_runtime_config_path())
            wants_container = rc.kind == KIND_CONTAINER
            docker_up = ContainerRuntime.is_available()
        except Exception:
            self._sandbox_badge.setVisible(False)
            return

        if wants_container and docker_up:
            text = "🟢 Sandboxed"
            color, bg, border = "#5af09c", "#0e2418", "#2c5a3c"
            tip = (
                "CLI subprocess runs inside Docker with this project's "
                "Location mounted at /workspace. Click to change."
            )
        elif wants_container and not docker_up:
            text = "🟡 Unsandboxed (install Docker)"
            color, bg, border = "#f0c060", "#2a1f0a", "#5a4520"
            tip = (
                "Container mode is on but Docker isn't running. The team "
                "will fall back to host execution. Click to change settings."
            )
        else:
            text = "🟡 Unsandboxed"
            color, bg, border = "#f0c060", "#2a1f0a", "#5a4520"
            tip = (
                "Worktree mode — CLI runs directly on the host. Click to "
                "switch to container mode for isolation."
            )
        self._sandbox_badge.setText(text)
        self._sandbox_badge.setStyleSheet(
            f"QLabel#SandboxBadge {{ "
            f"color:{color}; background:{bg}; "
            f"border:1px solid {border}; border-radius:6px; "
            f"padding:2px 8px; font-size:11px; font-weight:600; }}"
        )
        self._sandbox_badge.setToolTip(tip)
        self._sandbox_badge.setVisible(True)

    def _open_runtime_settings(self) -> None:
        """Open the fleet's runtime settings dialog so the user can flip
        between worktree and container without leaving the agents page."""
        try:
            from desktop_app.widgets.fleet_runtime_settings_dialog import (
                FleetRuntimeSettingsDialog,
            )
        except Exception:
            logger.exception("could not import FleetRuntimeSettingsDialog")
            return
        try:
            dlg = FleetRuntimeSettingsDialog(self)
        except Exception:
            logger.exception("could not open runtime settings dialog")
            return
        # Refresh the badge whenever the dialog accepts/rejects so the
        # user sees the new state immediately.
        dlg.finished.connect(lambda *_: self._refresh_sandbox_badge())
        dlg.show()

    def _on_location_changed(self) -> None:
        """Persist edits to the location field on focus-out / Enter."""
        if self._active_project is None:
            return
        new_loc = self._location_input.text().strip()
        if new_loc == (self._active_project.location or ""):
            return
        self._active_project.location = new_loc
        try:
            self._project_store.save_project(self._active_project)
        except Exception:
            logger.exception("could not save project location")

    def _on_browse_location(self) -> None:
        """Open a folder picker and write the result into the location
        input. Starting directory is the current location if it's an
        existing folder, otherwise the user's home."""
        if self._active_project is None:
            QMessageBox.information(
                self, "No project",
                "Create or select a project first.",
            )
            return
        current = (self._location_input.text() or "").strip()
        start = current if current and os.path.isdir(current) else os.path.expanduser("~")
        picked = QFileDialog.getExistingDirectory(
            self, "Locate project folder", start,
        )
        if not picked:
            return
        self._location_input.setText(picked)
        self._on_location_changed()

    def _materialize_claude_trust(self) -> None:
        """If the active project has trust_writes on AND Location is a real
        folder, ensure ``<location>/.claude/settings.local.json`` carries
        a scoped allow rule for Read/Write/Edit. Idempotent: if the rules
        are already there, nothing changes. Best-effort — never raises."""
        proj = self._active_project
        if proj is None or not proj.trust_writes:
            return
        loc = (proj.location or "").strip()
        if not loc or not os.path.isdir(loc):
            return
        try:
            import json as _json
            settings_dir = os.path.join(loc, ".claude")
            settings_path = os.path.join(settings_dir, "settings.local.json")
            os.makedirs(settings_dir, exist_ok=True)

            # Use forward slashes inside the rule — Claude CLI matches
            # them across platforms; backslashes have escape pitfalls.
            scope = loc.replace("\\", "/").rstrip("/") + "/**"
            wanted = {f"Read({scope})", f"Write({scope})", f"Edit({scope})"}

            # Merge into any pre-existing settings the user may have.
            data: dict = {}
            if os.path.isfile(settings_path):
                try:
                    with open(settings_path, "r", encoding="utf-8") as fh:
                        data = _json.load(fh) or {}
                except Exception:
                    data = {}
            perms = data.setdefault("permissions", {}) or {}
            allow = list(perms.get("allow") or [])
            existing = set(allow)
            added = wanted - existing
            if not added:
                return  # already trusted; nothing to do
            allow.extend(sorted(added))
            perms["allow"] = allow
            data["permissions"] = perms
            with open(settings_path, "w", encoding="utf-8") as fh:
                _json.dump(data, fh, indent=2)
        except Exception:
            logger.exception("could not materialize Claude trust settings")

    def _with_workdir_hint(self, goal: str) -> str:
        """Prepend a working-directory directive once per project + Location
        pair. Persisted on the Project record so the hint doesn't re-fire
        on app restart, project switch, or team rebuild — only when the
        user picks a different Location does it send again.

        Skips silently for aliases, URLs, and missing paths so we don't
        pollute the goal with bad guidance."""
        proj = self._active_project
        loc = (proj.location or "").strip() if proj else ""
        if not loc or not os.path.isdir(loc):
            return goal
        # Persistent dedupe: skip if we've already sent the hint for this
        # exact Location on this project. Survives restarts because the
        # marker lives on the Project row.
        if (proj.workdir_hint_sent_for or "") == loc:
            return goal
        proj.workdir_hint_sent_for = loc
        try:
            self._project_store.save_project(proj)
        except Exception:
            logger.exception("could not persist workdir_hint_sent_for")
        hint = (
            f"[Working directory: {loc}]\n"
            "Use this absolute path as the working directory for every "
            "shell/file operation (pass it as cwd to shell tools). Create, "
            "read, and modify files only inside this folder unless I "
            "explicitly say otherwise.\n\n"
        )
        return hint + goal if goal else hint.rstrip()

    def _load_active_project(self) -> None:
        """Resolve the active project from settings (or first available)
        and render its team."""
        saved = self._settings.value(self._SETTINGS_ACTIVE_PROJECT, "")
        target: Optional[Project] = None
        if isinstance(saved, str) and saved:
            target = self._project_store.get_project(saved)
        if target is None:
            projs = self._project_store.list_projects()
            target = projs[0] if projs else None
        self._active_project = target
        self._populate_project_combo()
        self._render_team()

    def _switch_project(self, project_id: str) -> None:
        proj = self._project_store.get_project(project_id)
        if proj is None:
            return
        self._active_project = proj
        self._settings.setValue(self._SETTINGS_ACTIVE_PROJECT, proj.id)
        # Drop the cached Team — its agents are bound to the previous
        # project's selection. Next Run rebuilds.
        self._team = None
        # Reset UI to a neutral idle baseline. _replay_active_project (called
        # at the end of _render_team) will restore live "Running…" state if
        # the new project's latest goal is still in flight.
        self._reset_ui_to_idle()
        # Keep the location input in step with the new project's saved
        # location.
        self._sync_location_input()
        self._render_team()

    def _reset_ui_to_idle(self) -> None:
        """Idle the run controls without writing the "Done in" summary text.

        Used on project-switch so the new project starts neutral rather
        than inheriting the previous project's run state.
        """
        if hasattr(self, "_elapsed_timer"):
            self._elapsed_timer.stop()
        self._run_started_at = None
        self._current_goal_id = None
        self.goal_input.setEnabled(True)
        if hasattr(self, "_super_user_card"):
            self._super_user_card.set_reply_enabled(True)
        self.run_btn.setEnabled(True)
        self.cancel_btn.setEnabled(False)
        self.status_label.setText("Idle.")

    def _on_project_combo_changed(self, idx: int) -> None:
        if idx < 0:
            return
        pid = self._project_combo.itemData(idx)
        if isinstance(pid, str) and (
            self._active_project is None or self._active_project.id != pid
        ):
            self._switch_project(pid)

    def _on_new_project(self) -> None:
        name, ok = QInputDialog.getText(self, "New project", "Project name:")
        if not ok or not name.strip():
            return
        # New project starts with NO team — user picks via [Team…] next.
        proj = self._project_store.save_project(
            Project(name=name.strip(), description="", team=[])
        )
        self._active_project = proj
        self._settings.setValue(self._SETTINGS_ACTIVE_PROJECT, proj.id)
        self._populate_project_combo()
        self._render_team()
        # Open the team picker so the user immediately picks members.
        self._open_team_picker()

    def select_project(self, project_id: str) -> None:
        """Make ``project_id`` the active project and re-render the workspace.

        Public entry point for the host (main.py) so the Studio can spawn a
        project from a team template and tell us to switch to it. No-op if
        the id doesn't exist (the project may have been deleted between
        the spawn and our call). Also re-populates the project combo so a
        freshly-created project that wasn't in the dropdown shows up.
        """
        proj = self._project_store.get_project(project_id)
        if proj is None:
            return
        self._switch_project(project_id)
        self._populate_project_combo()

    def _on_rename_project(self) -> None:
        if self._active_project is None:
            return
        name, ok = QInputDialog.getText(
            self, "Rename project", "New name:",
            text=self._active_project.name,
        )
        if not ok or not name.strip():
            return
        self._active_project.name = name.strip()
        self._project_store.save_project(self._active_project)
        self._populate_project_combo()

    def _on_delete_project(self) -> None:
        if self._active_project is None:
            return
        if len(self._project_store.list_projects()) <= 1:
            QMessageBox.information(
                self, "Delete project",
                "Can't delete the last project. Create a new one first.",
            )
            return
        if QMessageBox.question(
            self, "Delete project",
            f"Delete '{self._active_project.name}'? Goal history stays in the DB."
        ) != QMessageBox.Yes:
            return
        self._project_store.delete_project(self._active_project.id)
        self._active_project = None
        self._settings.remove(self._SETTINGS_ACTIVE_PROJECT)
        self._load_active_project()

    def _open_team_picker(self) -> None:
        if self._active_project is None:
            return
        defs = list_all_definitions()
        dlg = _TeamPickerDialog(
            available=defs,
            selected=set(self._active_project.team),
            parent=self,
        )
        if dlg.exec() == QDialog.Accepted:
            self._active_project.team = dlg.selected_names()
            self._project_store.save_project(self._active_project)
            self._team = None  # rebuild on next Run
            self._render_team()

    # ------------------------------------------------------------------
    # Team rendering
    # ------------------------------------------------------------------

    def refresh_after_definitions_changed(self) -> None:
        """Re-render the team using the latest agent definitions on disk.

        Called by the host after the Studio saves/deletes an agent so
        cards, the graph editor, and the orbital diagram pick up the
        new icon / description / tools without needing a project switch.
        """
        self._team = None  # force a rebuild from the persisted defs
        self._render_team()

    def _render_team(self) -> None:
        """(Re)populate the canvas + per-agent log buffers for the active project.

        Called on init, on project switch, and on team-edit. Loads any
        saved graph (positions + edges) from ``project.graph_json`` and
        adds/removes nodes so the canvas matches the current ``team``
        list. Edges referencing removed agents drop automatically.
        """
        # Clear caches that pertain to the previous team.
        self._agent_logs = {}
        self._selected_agent = None
        # Force the canvases to re-emit their selection_mode on the next
        # paintEvent. Without this, switching from project A (team-mode)
        # to project B (team-mode) leaves the overlay picker showing
        # project A's unanimous model — same mode string, suppressed
        # signal, stale binding.
        for c in (getattr(self, "team_canvas", None), getattr(self, "canvas", None)):
            if c is not None:
                try:
                    c._last_card_mode = ""
                except Exception:
                    pass
        for btn in list(self._model_picker_buttons.values()):
            btn.setParent(None)
            btn.deleteLater()
        self._model_picker_buttons.clear()
        for row in list(self._voice_rows.values()):
            row.setParent(None)
            row.deleteLater()
        self._voice_rows.clear()
        self.log_view.clear()
        self.log_header.setText("Click an agent on the canvas to view its log.")
        self.picker_host.setVisible(False)
        self.voice_host.setVisible(False)

        if self._active_project is None or not self._active_project.team:
            self.canvas.load_graph(AgentGraph(), orchestrator=None)
            self.status_label.setText(
                "No agents on this team yet — click Team… to add some."
            )
            return

        defs = list_all_definitions()
        team_defs: List[AgentDefinition] = [
            defs[name] for name in self._active_project.team if name in defs
        ]
        leader = next((d for d in team_defs if d.can_dispatch), None)
        leader_name = leader.name if leader is not None else None

        # Load saved graph; reconcile with current team membership.
        saved = AgentGraph.from_json_string(self._active_project.graph_json or "")
        present_names = {d.name for d in team_defs}
        # Drop nodes/edges that reference agents no longer on the team.
        saved.nodes = [n for n in saved.nodes if n.name in present_names]
        saved.edges = [e for e in saved.edges
                       if e.source in present_names and e.target in present_names]
        # Add any newly-added team members (not yet in graph). When a
        # member is added to an EXISTING graph (some nodes already
        # have positions), the default (0, 0) would pile the new
        # node on top of the orchestrator and make the graph look
        # like it didn't update. Instead, drop new nodes to the
        # right of the rightmost positioned node, on a fresh row,
        # so they're immediately visible.
        saved_names = {n.name for n in saved.nodes}
        existing_positioned = [
            n for n in saved.nodes if not (n.pos_x == 0.0 and n.pos_y == 0.0)
        ]
        max_x = max((n.pos_x for n in existing_positioned), default=60.0)
        min_y = min((n.pos_y for n in existing_positioned), default=60.0)
        max_y = max((n.pos_y for n in existing_positioned), default=60.0)
        col_w, row_h = 300.0, 380.0
        next_x = max_x + col_w
        next_y = min_y
        for d in team_defs:
            if d.name not in saved_names:
                saved.add_node(d.name)
                if existing_positioned:
                    # Pin the new node to a fresh slot to the right
                    # of everything else, stepping DOWN one row per
                    # extra newcomer so multiple additions don't
                    # overlap each other either.
                    new_node = saved.nodes[-1]
                    new_node.pos_x = next_x
                    new_node.pos_y = next_y
                    next_y += row_h
                    if next_y > max_y + row_h * 3:
                        next_y = min_y
                        next_x += col_w
        # First-load auto-layout: if every node is at (0,0), space them out.
        if saved.nodes and all(n.pos_x == 0.0 and n.pos_y == 0.0 for n in saved.nodes):
            saved.autolayout_grid()

        self.canvas.load_graph(saved, orchestrator=leader_name)

        # Best-effort icon resolution: if the agent definition has no
        # icon (or only the generic robot fallback), look up its role
        # in the built-in registry by name and use the role's emoji.
        # That way every box on the canvas shows the agent's actual
        # role icon (📡 operator, 🛠️ coder, 🔬 critic, 🧠 orchestrator,
        # …) instead of all collapsing to the same Windows 🤖 glyph.
        try:
            _role_icons = {r.name: r.icon for r in builtin_roles().values()}
        except Exception:
            _role_icons = {}

        def _resolve_icon(d: AgentDefinition) -> str:
            raw = (d.icon or "").strip()
            if raw and raw != "🤖":
                return raw
            role_icon = _role_icons.get(d.name, "")
            if role_icon:
                return role_icon
            return raw or "🤖"

        # Push each agent's icon + meta (description, skills) onto its
        # canvas node so the graph view's info-card overlay can show
        # the same fields the orbital diagram does.
        for d in team_defs:
            resolved_icon = _resolve_icon(d)
            try:
                self.canvas.set_node_icon(d.name, resolved_icon)
            except Exception:
                pass
            try:
                if hasattr(self, "team_canvas") and self.team_canvas is not None:
                    self.team_canvas.set_node_icon(d.name, resolved_icon)
            except Exception:
                pass
            try:
                graph_skills = list(d.tool_allowlist or [])
                if d.can_dispatch and "dispatch" not in graph_skills:
                    graph_skills = ["dispatch"] + graph_skills
                self.canvas.set_node_meta(
                    d.name, d.description or "", graph_skills,
                )
            except Exception:
                pass

        # Mirror the team into the live orbital diagram. The diagram
        # gets the rich AgentDefinition fields (description, skills,
        # icon) so its top-left info card is populated when an agent
        # is clicked.
        try:
            team_payload = []
            for d in team_defs:
                # Skills come from the tool allowlist (built-in tools the
                # agent is permitted to use) — falls back to a sensible
                # default summary if the role doesn't list any.
                skills = list(d.tool_allowlist or [])
                if d.can_dispatch and "dispatch" not in skills:
                    skills = ["dispatch"] + skills
                team_payload.append({
                    "name": d.name,
                    "icon": _resolve_icon(d),
                    "description": d.description or "",
                    "skills": skills,
                })
            self.team_canvas.set_agents(team_payload, orchestrator=leader_name)

            # Push edges so the orbital diagram renders directed
            # arrows for the saved AgentGraph connections. Layout is
            # NOT affected by edges — agents stay on the single ring.
            edge_pairs: List[Tuple[str, str]] = []
            try:
                for e in (saved.edges or []):
                    src = getattr(e, "source", None)
                    dst = getattr(e, "target", None)
                    if src and dst:
                        edge_pairs.append((str(src), str(dst)))
            except Exception:
                edge_pairs = []
            self.team_canvas.set_edges(edge_pairs)

            # Team metadata for the default info card shown when no
            # agent is selected. Pushed into BOTH canvases so the
            # graph view also shows the team card when no node is
            # selected.
            proj = self._active_project
            team_name_value = getattr(proj, "name", "") or "Untitled team"
            team_desc_value = (
                getattr(proj, "description", "")
                or f"{len(team_defs)} agents · "
                   f"{len(edge_pairs)} connections · "
                   f"orchestrator: {leader_name or '—'}"
            )
            self.team_canvas.set_team_info(
                name=team_name_value,
                description=team_desc_value,
            )
            try:
                self.canvas.set_team_info(
                    name=team_name_value,
                    description=team_desc_value,
                )
            except Exception:
                pass
        except Exception:
            pass

        # Sync the loading-screen constellation to the real team so the
        # placeholder ("orchestrator/researcher/...") doesn't show during
        # the wait.
        try:
            self._canvas_loader.set_agent_names([d.name for d in team_defs])
        except Exception:
            pass

        # Per-agent message buffers — pre-create empty lists so a node click
        # never crashes on a missing key.
        for d in team_defs:
            self._agent_logs[d.name] = []

        # Build a hidden pool of model pickers, one per agent. Show the
        # one whose agent is currently selected. Persist selection to
        # both QSettings (legacy global) and Project.model_overrides
        # (per-project).
        for d in team_defs:
            picker = ModelPickerButton(
                on_install_local=self._open_models_tab,
                parent=self.picker_host,
            )
            picker.setVisible(False)
            self._picker_slot_layout.addWidget(picker)
            self._model_picker_buttons[d.name] = picker

        # Voice control rows — one row per agent, only the selected
        # agent's row is shown. Same pool-and-swap pattern as the model
        # picker above. Skipped if voice is unavailable on this system.
        self._build_voice_rows(team_defs)

        # Push entries to pickers + restore each agent's saved or default model.
        self._refresh_pickers()
        self._restore_saved_selections()
        # Re-wire selection persistence on the freshly-built pickers.
        # _render_team is called on every project switch / team edit and
        # rebuilds the per-agent pickers; without re-wiring here, the new
        # pickers' selection_changed signal lands nowhere and "I changed
        # the model but the bridge still uses the old one" silently
        # returns. Connecting AFTER _restore_saved_selections preserves
        # the original "no echo on bulk restore" guarantee.
        self._wire_selection_persistence()
        # Mirror each agent's current picker selection onto its canvas node.
        for role_name in self._model_picker_buttons.keys():
            try:
                self._update_canvas_model_label(role_name)
            except Exception:
                pass
            try:
                self._update_canvas_voice_label(role_name)
            except Exception:
                pass

        # If the leader exists, default-select it so the right pane shows
        # something the moment the user lands on the page.
        if leader_name is not None:
            self.canvas.select_agent(leader_name)
            self._on_canvas_node_selected(leader_name)

        # Replay history into the per-agent buffers so switching projects
        # (even mid-run) doesn't wipe what the user was looking at.
        self._replay_active_project()

    # ------------------------------------------------------------------
    # Replay
    # ------------------------------------------------------------------

    def _replay_active_project(self) -> None:
        """Re-feed the active project's most recent goal messages into the
        freshly-built cards.

        Why we do this on every team render:

        * Switching projects rebuilds the cards (different teams, different
          subset of agents). The new cards start empty; the bus has the
          history persisted but the widgets don't see it until we route
          it through ``_on_bus_message``.
        * For a project whose goal is *still running*, the live bus
          subscription will pick up new messages from here on, so replay
          + live = full continuity.

        Limit: replay only the LATEST goal. Going back further is a future
        UI affordance (a "history" dropdown could let the user pick).
        """
        if self._active_project is None:
            return
        try:
            goal_ids = self._project_store.list_goal_ids(self._active_project.id)
        except Exception:
            logger.exception("could not list project goals")
            return
        if not goal_ids:
            return

        latest = goal_ids[0]
        try:
            messages = self._bus.replay(goal_id=latest)
        except Exception:
            logger.exception("could not replay messages for goal %s", latest)
            return

        # If the goal is still running, restore the in-progress UI state
        # too — Cancel button enabled, run timer ticking, status_label
        # showing "Resuming…". Otherwise the page will look idle even
        # though the run is mid-flight in the background.
        try:
            goal = self._bus.get_goal(latest)
            from core.agents.message import GoalStatus
            if goal is not None and goal.status == GoalStatus.RUNNING:
                # Goal is RUNNING in the bus, but a goal can only stay
                # RUNNING while a runner thread inside *this* process is
                # driving it — Team.run_goal blocks until the orchestrator
                # replies and only then calls bus.end_goal. If we're seeing
                # a RUNNING goal during page init, it's a stale row left
                # behind by a previous app instance that crashed / was
                # killed mid-run. Reap it so the user isn't locked out
                # of the input by a phantom "Resuming live run…" state.
                logger.warning(
                    "agents page: reaping stale RUNNING goal %s "
                    "(no runner thread is alive; previous app instance "
                    "likely died mid-run)",
                    latest,
                )
                try:
                    self._bus.end_goal(
                        latest,
                        GoalStatus.FAILED,
                        summary="reaped on page init (stale RUNNING)",
                    )
                except Exception:
                    logger.exception("could not reap stale RUNNING goal %s", latest)
        except Exception:
            logger.exception("could not check goal status during replay")

        # Replay messages oldest-first into the current cards via the
        # same routing _on_bus_message uses live. Cards stay in sync even
        # for mid-stream resume because the latest message dictates each
        # card's terminal status.
        for msg in messages:
            self._on_bus_message(msg)

    def _build_approvals_area(self) -> QWidget:
        self.approvals_frame = QFrame()
        self.approvals_frame.setFrameShape(QFrame.NoFrame)
        self.approvals_frame.setStyleSheet("background:transparent;")
        self._approvals_layout = QVBoxLayout(self.approvals_frame)
        self._approvals_layout.setContentsMargins(0, 0, 0, 0)
        self._approvals_layout.setSpacing(8)

        self._approvals_header = QLabel("Pending approvals")
        ah = QFont()
        ah.setPointSize(11)
        ah.setBold(True)
        self._approvals_header.setFont(ah)
        self._approvals_header.setStyleSheet(
            "color:#ffb0b0; padding:2px 4px; background:transparent;"
        )
        self._approvals_layout.addWidget(self._approvals_header)
        self.approvals_frame.setVisible(False)
        return self.approvals_frame

    # ------------------------------------------------------------------
    # Bus
    # ------------------------------------------------------------------

    def _wire_bus(self) -> None:
        self._bus.subscribe(lambda msg: self._bridge.message.emit(msg))
        self._registry.gate.add_listener(
            lambda req: self._bridge.approval_requested.emit(req)
        )

    # ------------------------------------------------------------------
    # Bootstrap
    # ------------------------------------------------------------------

    def _kick_off_bootstrap(self) -> None:
        cur = agent_runtime_manager.status()
        if cur.fully_ready:
            self.bootstrap_frame.setVisible(False)
            return

        self.bootstrap_frame.setVisible(True)
        self.run_btn.setEnabled(False)
        self.bootstrap_label.setText("Setting up agent runtime…")

        import threading

        def progress_cb(msg: str) -> None:
            from PySide6.QtCore import QMetaObject, Q_ARG
            QMetaObject.invokeMethod(
                self, "_on_bootstrap_progress", Qt.QueuedConnection, Q_ARG(str, msg)
            )

        def worker():
            from PySide6.QtCore import QMetaObject, Q_ARG
            try:
                agent_runtime_manager.ensure_ready(progress=progress_cb)
                QMetaObject.invokeMethod(
                    self, "_on_bootstrap_done", Qt.QueuedConnection, Q_ARG(str, "")
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception("agent runtime bootstrap failed")
                QMetaObject.invokeMethod(
                    self, "_on_bootstrap_done", Qt.QueuedConnection, Q_ARG(str, str(exc))
                )

        threading.Thread(target=worker, name="agent-bootstrap", daemon=True).start()

    @Slot(str)
    def _on_bootstrap_progress(self, msg: str) -> None:
        self.bootstrap_label.setText(msg)
        # Forward to the canvas loader so the user has a single, prominent
        # place to read what's happening — the small label above the canvas
        # is easy to miss.
        try:
            if hasattr(self, "_canvas_loader"):
                self._canvas_loader.set_sub_status(msg)
        except Exception:
            pass

    @Slot(str)
    def _on_bootstrap_done(self, error: str) -> None:
        if error:
            self.bootstrap_label.setText(f"Setup failed: {error}")
            self.bootstrap_progress.setRange(0, 1)
            self.bootstrap_progress.setValue(0)
            QMessageBox.warning(self, "Agent runtime", error)
        else:
            self.bootstrap_frame.setVisible(False)
            self._refresh_pickers()
        self.run_btn.setEnabled(True)
        # Bootstrap finished — try to flip the loader to the workspace
        # (still gated on the requirements scan; that's checked inside).
        try:
            self._poll_loading_state()
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Loader → workspace flip
    # ------------------------------------------------------------------

    def _poll_loading_state(self) -> None:
        """Decide whether the workspace can be revealed.

        Two gates:

        * Agent runtime (``agent_runtime_manager.status().fully_ready``).
          If we're auto-installing the anthropic / openai / claude-code /
          codex runtime stack, we wait that out.
        * Main-window requirements scan. The scan can take 1-2 min and
          while it's running the home-page popup / repair dialogs may
          interrupt the user. We wait for it to finish so the agents page
          appears AFTER any environment dialog has resolved.

        Polled every 500ms until both gates are satisfied; then we flip
        the QStackedWidget to the workspace and stop polling.
        """
        if self._loading_done:
            return

        # Gate 1 — agent runtime.
        try:
            runtime_ready = bool(agent_runtime_manager.status().fully_ready)
        except Exception:
            runtime_ready = True  # don't get stuck if probing fails

        # Gate 2 — main-window requirements scan, if we can see it. Older
        # setups may not have the thread reachable; treat absence as "ok".
        scan_done = True
        try:
            mw = self.main_window
            t = getattr(mw, "_req_check_thread", None)
            if t is not None:
                # QThread.isRunning is False once the run() loop exits.
                scan_done = not t.isRunning()
        except Exception:
            scan_done = True

        # Update sub-status with an indication of which gate is pending.
        try:
            if not runtime_ready:
                self._canvas_loader.set_status("Installing agent runtime")
                self._canvas_loader.set_sub_status(
                    "Anthropic, OpenAI, Claude-Code and Codex toolchains."
                )
            elif not scan_done:
                self._canvas_loader.set_status("Verifying environment")
                self._canvas_loader.set_sub_status(
                    "pip-listing the cu121 profile env, smoke-testing each critical package."
                )
            else:
                self._canvas_loader.set_status("Ready")
                self._canvas_loader.set_sub_status("Bringing up the canvas…")
        except Exception:
            pass

        # Push the live team into the loader's constellation so the user
        # sees the agents they configured rather than the placeholder set.
        try:
            if self._active_project and self._active_project.team:
                self._canvas_loader.set_agent_names(list(self._active_project.team))
        except Exception:
            pass

        # Minimum display time — see _build_roster for why. Even on a
        # fast boot we hold the loader for a few seconds so the user
        # actually sees the animation rather than a 200 ms flash.
        import time as _t
        elapsed = _t.monotonic() - getattr(self, "_loader_started_at", 0.0)
        if elapsed < getattr(self, "_loader_min_seconds", 0.0):
            return

        if runtime_ready and scan_done:
            self._maybe_finish_loading()

    def _maybe_finish_loading(self) -> None:
        """Flip the stack to the workspace once. Guarded against double-firing."""
        if self._loading_done:
            return
        self._loading_done = True
        # Brief 600ms tail so the "Ready" frame is visible — abrupt swap
        # feels like a flash.
        self._loading_finish_timer = QTimer(self)
        self._loading_finish_timer.setSingleShot(True)
        self._loading_finish_timer.setInterval(600)
        self._loading_finish_timer.timeout.connect(self._reveal_workspace)
        self._loading_finish_timer.start()

    def _reveal_workspace(self) -> None:
        try:
            # Loader is at index 0, splitter at index 1 (see _build_roster).
            self._workspace_stack.setCurrentIndex(1)
        except Exception:
            pass
        try:
            self._canvas_loader.stop()
        except Exception:
            pass
        try:
            self._loading_poll_timer.stop()
        except Exception:
            pass
        # Belt-and-suspenders: nothing about workspace reveal should leave
        # the input or run button disabled. If a stale RUNNING goal got
        # reaped during _replay_messages, or a previous lifecycle disabled
        # the input and never re-enabled it, this is the place to put the
        # surface back into a sane idle state for the user.
        try:
            self._set_idle()
        except Exception:
            logger.exception("could not reset to idle on workspace reveal")
        try:
            self.goal_input.setEnabled(True)
            if hasattr(self, "_super_user_card"):
                self._super_user_card.set_reply_enabled(True)
            self.goal_input.setFocus()
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Fast critical-deps probe (Agents page open path)
    # ------------------------------------------------------------------

    def _fast_critical_deps_probe(self) -> None:
        """Subprocess-probe the canonical OWLLM Python in <2 s for critical deps.

        The slow path is the main-window Requirements scan that does a full
        ``pip list`` plus per-package smoke-tests — that's where the 2–3
        minute lag came from. This fast probe runs ``importlib.util.find_spec``
        for the same set of critical packages the home page checks, gives a
        result in well under a second, and pops a SYNCHRONOUS Repair? dialog
        the moment something's missing. The user gets to act immediately
        instead of staring at the loader for two minutes.

        We probe via a SUBPROCESS into the canonical OWLLM Python so the
        result reflects THAT env even if the running process is the wrong
        one (e.g. someone double-clicked an old launcher).
        """
        try:
            from core.runtime.owllm_python import get_owllm_python, OwllmEnvNotInstalled
            from pathlib import Path
            import subprocess
            import sys as _sys

            llm_root = Path(__file__).resolve().parent.parent.parent
            try:
                py = get_owllm_python(llm_root)
            except OwllmEnvNotInstalled as exc:
                self._show_repair_dialog(
                    title="Profile environment not installed",
                    summary=(
                        f"OWLLM's profile environment '{exc.env_key}' isn't on disk.\n\n"
                        "Open the installer and click Install/Repair All to create it."
                    ),
                    missing=[],
                )
                return

            critical = [
                "torch", "transformers", "tokenizers",
                "datasets", "accelerate", "peft", "numpy",
                "requests", "yaml",
            ]
            probe = (
                "import importlib.util, json, sys\n"
                "out=[]\n"
                "for p in " + repr(critical) + ":\n"
                "    spec=importlib.util.find_spec(p)\n"
                "    out.append((p, bool(spec)))\n"
                "sys.stdout.write(json.dumps(out))\n"
            )
            try:
                proc = subprocess.run(
                    [str(py), "-c", probe],
                    capture_output=True, text=True, timeout=10,
                    creationflags=(0x08000000 if _sys.platform == "win32" else 0),
                )
            except Exception as e:
                logger.warning("fast deps probe failed: %s", e)
                return
            if proc.returncode != 0 or not proc.stdout.strip():
                return
            try:
                import json
                results = json.loads(proc.stdout.strip())
            except Exception:
                return
            missing = [name for name, ok in results if not ok]
            if not missing:
                return
            self._show_repair_dialog(
                title="Critical dependencies missing",
                summary=(
                    "OWLLM is missing the following critical packages in its "
                    "profile environment:\n\n"
                    "  · " + "\n  · ".join(missing) + "\n\n"
                    "Without these the agents runtime can't run. Repair will "
                    "install them via pip into the cu121 profile env."
                ),
                missing=missing,
            )
        except Exception:
            logger.exception("fast critical deps probe crashed")

    def _show_repair_dialog(self, *, title: str, summary: str, missing: list) -> None:
        """Modal Repair? dialog. Synchronous so the user can't ignore it."""
        # Idempotent — don't stack multiple dialogs if probe runs twice.
        if getattr(self, "_repair_dialog_shown", False):
            return
        self._repair_dialog_shown = True

        box = QMessageBox(self)
        box.setWindowTitle(title)
        box.setIcon(QMessageBox.Warning)
        box.setText(summary)
        repair_btn = box.addButton("🔧 Repair Now", QMessageBox.AcceptRole)
        skip_btn = box.addButton("Skip for now", QMessageBox.RejectRole)
        box.setDefaultButton(repair_btn)
        box.exec()
        if box.clickedButton() is repair_btn and missing:
            self._run_repair_install(missing)
        # Allow the dialog to fire again later if the env is still broken
        # after a Skip → user clicks somewhere else → comes back.
        self._repair_dialog_shown = False

    def _run_repair_install(self, missing: list) -> None:
        """Install missing critical packages into the canonical OWLLM Python."""
        try:
            from core.runtime.owllm_python import get_owllm_python
            from pathlib import Path
            import subprocess
            import sys as _sys

            llm_root = Path(__file__).resolve().parent.parent.parent
            py = get_owllm_python(llm_root)
            cmd = [str(py), "-m", "pip", "install",
                   "--upgrade-strategy", "only-if-needed",
                   "--prefer-binary",
                   "--no-warn-script-location",
                   *missing]
            self.status_label.setText("Repairing environment — pip install running…")
            try:
                self._canvas_loader.set_status("Repairing environment")
                self._canvas_loader.set_sub_status(
                    "pip install: " + " ".join(missing[:5])
                    + ("…" if len(missing) > 5 else "")
                )
            except Exception:
                pass
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=600,
                creationflags=(0x08000000 if _sys.platform == "win32" else 0),
            )
            if proc.returncode == 0:
                QMessageBox.information(
                    self, "Repair complete",
                    "Missing packages installed. The Agents page is ready to use.",
                )
                self.status_label.setText("Idle.")
            else:
                tail = (proc.stderr or proc.stdout or "")[-1500:]
                QMessageBox.warning(
                    self, "Repair failed",
                    f"pip exited with code {proc.returncode}.\n\n{tail}",
                )
                self.status_label.setText("Repair failed.")
        except Exception as e:
            QMessageBox.critical(self, "Repair error", f"{e}")

    # ------------------------------------------------------------------
    # Account dots / pickers refresh
    # ------------------------------------------------------------------

    def _refresh_account_dots(self) -> None:
        st = agent_runtime_manager.status()
        flags = {
            "claude_subscription": st.claude_subscription_connected,
            "codex_subscription": st.codex_subscription_connected,
            "anthropic_api": st.anthropic_api_key_set,
            "openai_api": st.openai_api_key_set,
        }
        for key, connected in flags.items():
            dot = self._account_dots[key]
            color = "#4caf50" if connected else "#5a6376"
            dot.setStyleSheet(f"background:{color}; border-radius:4px;")

    def _refresh_pickers(self) -> None:
        for picker in self._model_picker_buttons.values():
            picker.refresh_entries()
        # Same backend / account list feeds the overlay pickers too —
        # without this, after bootstrap the in-card picker still shows
        # the bootstrap-time empty list. Squash the auto-pick emit so
        # bootstrap doesn't accidentally rewrite every team member's
        # model_overrides (refresh_entries auto-picks when current_id
        # is empty and emits selection_changed, which our team-mode
        # handler would otherwise apply to all agents).
        self._suspend_overlay_signal = True
        try:
            for overlay in (self._overlay_picker_team, self._overlay_picker_canvas):
                if overlay is not None:
                    try:
                        overlay.refresh_entries()
                    except Exception:
                        pass
        finally:
            self._suspend_overlay_signal = False

    def _model_id_for(self, role_name: str) -> str:
        picker = self._model_picker_buttons.get(role_name)
        if picker is None:
            return ""
        return picker.current_id()

    # ------------------------------------------------------------------
    # Per-agent model persistence (across app restarts)
    # ------------------------------------------------------------------

    def _settings_key(self, role_name: str) -> str:
        return f"{self._SETTINGS_PREFIX}{role_name}"

    def _restore_saved_selections(self) -> None:
        """Apply each role's saved composite model id, if one exists.

        Read order:
          1. ``Project.model_overrides[role_name]`` — per-project pin
             (authoritative; what the bridges read too).
          2. QSettings under ``agents/model_for/<role>`` — legacy global
             default, used as a fallback when the project has no override
             for this role yet.

        Called after the pickers have been populated so ``set_current_id``
        can find the entry. If the saved id is no longer available (model
        uninstalled, account disconnected) the picker quietly drops it on
        the next refresh — no error, just falls back to the default.
        """
        overrides = (
            self._active_project.model_overrides
            if self._active_project is not None
            else {}
        )
        for role_name, picker in self._model_picker_buttons.items():
            saved = overrides.get(role_name) or self._settings.value(
                self._settings_key(role_name), ""
            )
            if isinstance(saved, str) and saved:
                picker.set_current_id(saved)

    def _wire_selection_persistence(self) -> None:
        """Persist every selection change to the active project.

        Two stores in lockstep:
          * ``Project.model_overrides`` — what the bridges (Telegram /
            WhatsApp) read at goal time. Without this, bridges had no way
            to see what the user picked on the desktop and fell back to
            the empty default_model_id, breaking remote runs.
          * QSettings — kept as a global fallback for new projects that
            don't have an override yet.

        Connected only after ``_restore_saved_selections`` so the bulk
        restore doesn't immediately re-write the same values back to disk.
        """
        for role_name, picker in self._model_picker_buttons.items():
            picker.selection_changed.connect(
                lambda composite_id, rn=role_name: self._on_picker_changed(
                    rn, composite_id
                )
            )

    def _on_picker_changed(self, role_name: str, composite_id: str) -> None:
        """Persist a per-agent model selection to project + QSettings.

        Also push the (short) model label to the canvas node so the agent
        boxes aren't empty — the user reported that with the picker moved
        to a side panel, the canvas felt empty. Showing the model name
        directly on the node is the at-a-glance answer to "which agent
        runs which model".
        """
        # Global fallback (legacy).
        try:
            self._settings.setValue(self._settings_key(role_name), composite_id)
        except Exception:
            pass
        # Per-project authoritative store. This is what bridges read at
        # goal-dispatch time, so writing here is what makes Telegram /
        # WhatsApp use the same model the desktop picker shows.
        if self._active_project is not None:
            self._active_project.model_overrides[role_name] = composite_id
            try:
                self._project_store.save_project(self._active_project)
            except Exception:
                logger.exception("could not persist model_overrides for %s", role_name)
        # Invalidate the cached team so the next Run picks up the new
        # selection. Without this, Agent.model_id stays bound to whatever
        # was selected at build time and the picker change is silently
        # ignored — the symptom is "I changed model but nothing happened".
        self._team = None
        # Reflect the new pick on the canvas node.
        try:
            self._update_canvas_model_label(role_name)
        except Exception:
            pass
        # Keep the right-pane and overlay pickers in sync — set_current_id
        # does NOT re-emit selection_changed, so this is recursion-safe.
        try:
            right = self._model_picker_buttons.get(role_name)
            if right is not None and right.current_id() != composite_id:
                right.set_current_id(composite_id)
        except Exception:
            pass
        try:
            if (
                self._overlay_mode == f"agent:{role_name}"
                and composite_id
            ):
                for overlay in (
                    self._overlay_picker_team,
                    self._overlay_picker_canvas,
                ):
                    if overlay is not None and overlay.current_id() != composite_id:
                        overlay.set_current_id(composite_id)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Overlay picker (lives inside the painted info card)
    # ------------------------------------------------------------------

    def _on_overlay_selection_mode_changed(self, mode: str) -> None:
        """The active canvas flipped which card it's painting. Re-bind
        both overlay pickers so they reflect the right model:

          * ``"agent:<name>"`` — show that agent's saved override
          * ``"team"``         — leave value blank; next change applies
                                 to every team member at once
          * ``""``             — no card is on screen
        """
        self._overlay_mode = mode or ""
        if mode.startswith("agent:"):
            agent_name = mode[len("agent:"):]
            saved = ""
            if self._active_project is not None:
                saved = self._active_project.model_overrides.get(agent_name, "") or ""
            for overlay in (
                self._overlay_picker_team,
                self._overlay_picker_canvas,
            ):
                if overlay is None:
                    continue
                # Mirror the right-pane picker rather than re-reading
                # the override directly — the right-pane picker is the
                # single source of truth for the *displayed* selection
                # (it survives changes to model_overrides done via
                # bridges, settings, etc.).
                right = self._model_picker_buttons.get(agent_name)
                if right is not None and right.current_id():
                    overlay.set_current_id(right.current_id())
                elif saved:
                    overlay.set_current_id(saved)
        elif mode == "team":
            # Team mode: no single "current" model — show whichever
            # model the entire team agrees on (if any). When team is
            # mixed, leave the picker on its last value so the user
            # sees a starting point but isn't misled into thinking
            # everyone's already on it.
            unanimous = self._team_unanimous_model_id()
            for overlay in (
                self._overlay_picker_team,
                self._overlay_picker_canvas,
            ):
                if overlay is None:
                    continue
                if unanimous:
                    overlay.set_current_id(unanimous)

    def _on_overlay_picker_changed(self, composite_id: str) -> None:
        """User picked a model in the overlay. Route per the current
        :attr:`_overlay_mode`:

          * agent mode  → :meth:`_on_picker_changed` for that agent only
          * team mode   → :meth:`_on_picker_changed` for every team member
                          (so Telegram / WhatsApp bridges that read
                          ``model_overrides`` see the change too)
        """
        if not composite_id:
            return
        if self._suspend_overlay_signal:
            return
        mode = self._overlay_mode or ""
        if mode.startswith("agent:"):
            agent_name = mode[len("agent:"):]
            self._on_picker_changed(agent_name, composite_id)
            return
        if mode == "team":
            self._apply_model_to_all_agents(composite_id)
            return
        # No card is on screen — nothing to bind. (Shouldn't happen because
        # the picker is hidden in that state, but guard anyway.)

    def _apply_model_to_all_agents(self, composite_id: str) -> None:
        """Set the same model id for every agent on the active team.

        Writes ``Project.model_overrides`` for each member, mirrors the
        change to the legacy QSettings keys, invalidates the cached team
        once at the end (instead of N times), and pushes the new label
        onto every canvas node so the diagram updates immediately.
        """
        if self._active_project is None or not self._active_project.team:
            return
        for role_name in list(self._active_project.team):
            try:
                self._settings.setValue(self._settings_key(role_name), composite_id)
            except Exception:
                pass
            self._active_project.model_overrides[role_name] = composite_id
            # Sync the right-pane per-agent picker so the user sees the
            # same value when they click into an individual agent.
            right = self._model_picker_buttons.get(role_name)
            if right is not None and right.current_id() != composite_id:
                try:
                    right.set_current_id(composite_id)
                except Exception:
                    pass
            try:
                self._update_canvas_model_label(role_name)
            except Exception:
                pass
        try:
            self._project_store.save_project(self._active_project)
        except Exception:
            logger.exception("could not persist team-wide model selection")
        # One cache-bust at the end — see _on_picker_changed.
        self._team = None

    def _team_unanimous_model_id(self) -> str:
        """Return a composite_id if every team member's override is the
        same non-empty value, otherwise ``""``. Used so the team-card
        picker shows that model as the current pick instead of looking
        unselected."""
        if self._active_project is None or not self._active_project.team:
            return ""
        seen: Optional[str] = None
        for name in self._active_project.team:
            val = self._active_project.model_overrides.get(name, "")
            if not val:
                return ""
            if seen is None:
                seen = val
            elif seen != val:
                return ""
        return seen or ""

    def _update_canvas_model_label(self, role_name: str) -> None:
        """Mirror the picker's current selection under the agent's
        canvas node title. Reads ``current_label()`` directly so we don't
        scrape the button text (which carries the ``▾`` glyph) and so a
        not-yet-selected picker doesn't show a placeholder on the node.
        """
        picker = self._model_picker_buttons.get(role_name)
        if picker is None:
            return
        label = ""
        try:
            label = picker.current_label() or ""
        except Exception:
            label = ""
        # Trim provider prefix when present so the node line stays compact.
        if "·" in label:
            label = label.split("·", 1)[1].strip()
        if not label:
            try:
                label = picker.current_id() or ""
            except Exception:
                pass
        # Last resort: read straight from the project override so we never
        # show "no model" when the user has actually picked one but the
        # picker entry-list hasn't caught up yet.
        if not label and self._active_project is not None:
            saved = self._active_project.model_overrides.get(role_name) or ""
            if saved:
                label = saved.split("/", 1)[-1] if "/" in saved else saved
        self.canvas.set_node_model_label(role_name, label)
        try:
            if hasattr(self, "team_canvas") and self.team_canvas is not None:
                self.team_canvas.set_node_model_label(role_name, label)
        except Exception:
            pass

    def _update_canvas_voice_label(self, role_name: str) -> None:
        """Mirror the agent's current voice (or "Auto") under the model
        line on the canvas node and the painted info-card overlay. Called
        after a render and whenever the per-agent voice row commits a
        change."""
        label = ""
        try:
            from core.agents.agent_definitions import get_definition
            d = get_definition(role_name)
        except Exception:  # noqa: BLE001
            d = None
        if d is not None:
            if not d.voice_enabled:
                label = "muted"
            elif d.voice_id:
                # voice_id is either a SAPI registry path (long) or the
                # absolute path of a Piper ONNX file. Reduce both to a
                # human-readable stem.
                stem = d.voice_id.replace("\\", "/").rstrip("/")
                stem = stem.rsplit("/", 1)[-1]
                if stem.endswith(".onnx"):
                    stem = stem[: -len(".onnx")]
                label = stem
            else:
                label = "auto"
        try:
            self.canvas.set_node_voice_label(role_name, label)
        except Exception:  # noqa: BLE001
            pass
        try:
            if hasattr(self, "team_canvas") and self.team_canvas is not None:
                self.team_canvas.set_node_voice_label(role_name, label)
        except Exception:  # noqa: BLE001
            pass

    # ------------------------------------------------------------------
    # Tab navigation hook
    # ------------------------------------------------------------------

    def _open_models_tab(self) -> None:
        """Switch to the Models tab — used by the picker's empty-Local CTA."""
        if self.main_window is None:
            return
        try:
            switcher = getattr(self.main_window, "_switch_tab", None)
            tabs = getattr(self.main_window, "tabs", None)
            if switcher and tabs:
                switcher(tabs, "models")
        except Exception:
            logger.exception("could not switch to Models tab")

    # ------------------------------------------------------------------
    # Run / cancel
    # ------------------------------------------------------------------

    def _run_clicked(self) -> None:
        goal = self.goal_input.text().strip()
        # Snapshot pending attachments now so removing the last
        # in-flight attachment doesn't race with submit.
        attachments = self._consume_pending_attachments()
        # Allow submit when there is media even with no typed goal —
        # a voice-only message is a perfectly valid request.
        if not goal and not attachments:
            return
        if self._team is None:
            try:
                self._team = self._build_team()
            except Exception as exc:  # noqa: BLE001
                QMessageBox.critical(self, "Agents", f"Team build failed: {exc}")
                return
        # If the project trusts writes inside its Location folder, drop a
        # scoped Claude-CLI allow rule there so the team isn't blocked
        # per-file. Best-effort; a failure here doesn't stop the run.
        self._materialize_claude_trust()
        # Prepend working-dir directive ONCE per team instance (and again
        # only if the project's Location changes). Must run after team
        # build so the dedupe marker can be stored on the team.
        goal = self._with_workdir_hint(goal)

        self.goal_input.setEnabled(False)
        if hasattr(self, "_super_user_card"):
            self._super_user_card.set_reply_enabled(False)
            self._super_user_card.append_user_message(goal)
        self.run_btn.setEnabled(False)
        self.cancel_btn.setEnabled(True)

        # Only the orchestrator starts in 'thinking' — it's the only agent
        # actively working at goal start. Specialists stay idle until they
        # actually receive a dispatch. Pre-greening all cards was misleading.
        for card in self._cards.values():
            card.set_status(_STATUS_IDLE)
        orch_name = next(
            (n for n, c in self._cards.items() if c.role.can_dispatch),
            None,
        )
        if orch_name:
            self._cards[orch_name].set_status(_STATUS_THINKING)

        # Elapsed-time indicator — shows on the page so the user can see at
        # a glance that work *is* happening even when the model is taking
        # 30-60s per turn (Claude CLI subscription is slow on first call).
        import time
        self._run_started_at = time.monotonic()
        self.status_label.setText("Running… 0s elapsed")
        if not hasattr(self, "_elapsed_timer"):
            self._elapsed_timer = QTimer(self)
            self._elapsed_timer.setInterval(1000)
            self._elapsed_timer.timeout.connect(self._tick_elapsed)
        self._elapsed_timer.start()

        import threading
        import time

        # Snapshot the project so the watchdog/runner threads use the project
        # that was active *at run start*, not whatever the user switched to
        # mid-run. The goal belongs to the project that owned it.
        run_project_id = self._active_project.id if self._active_project else None

        # Watchdog: as soon as ``team.run_goal`` enters and creates the
        # underlying Goal record (it sets ``team.active_goal_id`` on its
        # second line), tag it with the project. This is what lets the
        # user switch projects mid-run and still find the in-flight goal
        # when they switch back. Without this, project_id is NULL until
        # the goal completes, and ``list_goal_ids`` misses it.
        self._run_active = True

        def watch():
            while getattr(self, "_run_active", False):
                gid = self._team.active_goal_id if self._team else None
                if gid:
                    if run_project_id:
                        try:
                            self._project_store.tag_goal(gid, run_project_id)
                        except Exception:
                            logger.exception("could not tag in-flight goal")
                    return
                time.sleep(0.05)

        threading.Thread(target=watch, name="agent-run-tag", daemon=True).start()

        def runner():
            try:
                team = self._team
                reply = team.run_goal(goal, attachments=attachments or None)
                self._current_goal_id = reply.goal_id
                # Belt-and-suspenders: the watchdog already tagged in flight,
                # but re-tag at completion in case the watchdog missed (e.g.
                # the goal completed before the watchdog tick fired).
                if run_project_id:
                    try:
                        self._project_store.tag_goal(reply.goal_id, run_project_id)
                    except Exception:
                        logger.exception("could not tag goal with project_id")
            except Exception as exc:  # noqa: BLE001
                logger.exception("agent run failed")
                # Surface the failure on the orchestrator's card too — the
                # page-level event used to be the only visible signal, but
                # with the per-card logs that's where the user is looking.
                err_msg = Message(
                    from_agent=orch_name or "orchestrator",
                    to_agent="user",
                    kind=MessageKind.EVENT,
                    body=f"run failed: {exc}",
                    goal_id=self._current_goal_id or "",
                )
                self._bridge.message.emit(err_msg)
            finally:
                self._run_active = False
                from PySide6.QtCore import QMetaObject
                QMetaObject.invokeMethod(self, "_set_idle", Qt.QueuedConnection)

        threading.Thread(target=runner, name="agent-run", daemon=True).start()

    def _tick_elapsed(self) -> None:
        """Update the running-elapsed label once a second."""
        import time
        started = getattr(self, "_run_started_at", None)
        if started is None:
            return
        secs = int(time.monotonic() - started)
        if secs < 60:
            text = f"Running… {secs}s elapsed"
        else:
            text = f"Running… {secs // 60}m {secs % 60}s elapsed"
        self.status_label.setText(text)

    def _build_team(self) -> Team:
        # MCP tools first — same rationale as before: pulls every connected
        # server's tools into the agent registry so the team picks them up.
        try:
            from desktop_app.mcp.connection_manager import MCPConnectionManager
            cm = MCPConnectionManager()
            count = register_mcp_tools(self._registry, cm)
            if count:
                logger.info("workspace loaded %d MCP tools from connected servers", count)
        except Exception:
            logger.exception("could not load MCP tools into agent registry")

        if self._active_project is None or not self._active_project.team:
            raise RuntimeError(
                "no team configured — pick agents via the Team… button"
            )

        # Build a name -> Role map from the active project's team.
        defs = list_all_definitions()
        roles: Dict[str, Role] = {}
        for name in self._active_project.team:
            d = defs.get(name)
            if d is None:
                logger.warning("project references unknown agent '%s' — skipping", name)
                continue
            roles[name] = _role_from_definition(d)

        # Build a graph resolver bound to the project's saved AgentGraph
        # (or to None when the project has no custom routing). Without a
        # graph the orchestrator behaves exactly as before — point-to-point
        # dispatch, reply goes straight back. With a graph, dispatch follows
        # the chain (e.g. orchestrator → coder1 → coder2 → orchestrator).
        graph_resolver = None
        if self._active_project and self._active_project.graph_json:
            graph = AgentGraph.from_json_string(self._active_project.graph_json)
            orchestrator_name = next(
                (name for name in self._active_project.team
                 if name in defs and defs[name].can_dispatch),
                "",
            )
            if graph.edges and orchestrator_name:
                def graph_resolver(from_name: str, _g=graph, _o=orchestrator_name) -> Optional[str]:
                    return _g.next_target(from_name, _o)

        # Wrap dispatch_model_fn so CLI backends see the project's Location
        # as their subprocess cwd. Without this, the trust_writes settings
        # file (materialized into <Location>/.claude/) is not consulted by
        # the agent, and the CLI inherits the desktop app's launch dir as
        # its working tree — i.e. the wrong project.
        proj_loc = ""
        if self._active_project and self._active_project.location:
            cand = str(self._active_project.location).strip()
            if cand and os.path.isdir(cand):
                proj_loc = cand

        # Pin the project Location as the default cwd for tool calls that
        # don't pass one (currently: ``shell``). Without this, container
        # wrapping for those tools would silently no-op — defeating the
        # isolation. Threading.local on the tool side keeps multi-team
        # workers separated. Also refresh the sandbox-status badge here:
        # team build is the natural time to confirm the user can see what
        # mode the next Run will use.
        try:
            from core.agents.tools import set_default_cwd
            set_default_cwd(proj_loc or None)
        except Exception:
            logger.exception("could not pin default cwd for tool layer")
        try:
            self._refresh_sandbox_badge()
        except Exception:
            logger.exception("could not refresh sandbox badge")

        # Auto-approve toggled on the Super User card means the user has
        # explicitly told us to stop asking — push that trust through to
        # the Claude CLI subprocess too via --dangerously-skip-permissions
        # so its own sandbox doesn't keep prompting for paths the user
        # has already cleared at the OWLLM level.
        skip_perms = bool(
            self._active_project and self._active_project.auto_approve_all
        )

        def _model_fn_with_cwd(messages, composite_id,
                               _cwd=proj_loc, _skip=skip_perms):
            return dispatch_model_fn(
                messages, composite_id,
                cwd=_cwd or None, skip_permissions=_skip,
            )

        team = build_team(
            self._bus,
            roles=roles,
            model_id_for=self._model_id_for,
            model_fn=_model_fn_with_cwd,
            base_registry=self._registry,
            graph_resolver=graph_resolver,
        )
        # Seed the orchestrator's chat_history with prior user/orchestrator
        # exchanges on this project so a fresh app session resumes the
        # earlier conversation instead of starting blank. Without this,
        # the bus DB has the messages (the chat panel shows them) but the
        # orchestrator agent's in-memory _chat_history is empty until the
        # next user message — so it appears to have forgotten the goal.
        # Cap at 30 most-recent exchanges to avoid blowing the budget;
        # the agent's own drop-oldest-from-index-1 fix protects the
        # original goal once it's in the history.
        try:
            self._seed_orchestrator_history(team, limit=30)
        except Exception:
            logger.exception("could not seed orchestrator history; continuing")
        return team

    def _seed_orchestrator_history(self, team, *, limit: int = 30) -> None:
        """Replay USER ↔ orchestrator REPLY pairs from prior goals on this
        project into the freshly-built orchestrator's chat_history.

        Only the user-facing dialogue is replayed (USER messages addressed
        to the orchestrator + the orchestrator's REPLY messages back to
        the user). Specialist chatter, tool events, etc. are skipped to
        keep the rebuilt context focused on what the user said and what
        the orchestrator promised — that's enough to resume."""
        if self._active_project is None or team is None or team.orchestrator is None:
            return
        orch_name = team.orchestrator.name
        try:
            goal_ids = self._project_store.list_goal_ids(self._active_project.id)
        except Exception:
            logger.exception("could not list goal ids for history replay")
            return
        if not goal_ids:
            return
        # Walk goals oldest-first so the resulting chat_history reads
        # chronologically; list_goal_ids returns newest-first.
        seeded: list = []
        for gid in reversed(goal_ids):
            try:
                msgs = self._bus.replay(goal_id=gid)
            except Exception:
                continue
            for m in msgs:
                kind = getattr(m.kind, "value", None) or str(m.kind)
                if (kind == "user" or kind == "USER") and m.to_agent == orch_name:
                    seeded.append({"role": "user", "content": m.body or ""})
                elif (kind == "reply" or kind == "REPLY") and m.from_agent == orch_name and m.to_agent == "user":
                    seeded.append({"role": "assistant", "content": m.body or ""})
        if not seeded:
            return
        # Cap to most-recent ``limit`` pairs (keep tail).
        if len(seeded) > limit:
            seeded = seeded[-limit:]
        team.orchestrator._chat_history.extend(seeded)
        logger.info(
            "seeded %d prior messages into orchestrator '%s' chat_history",
            len(seeded), orch_name,
        )

    def _cancel_clicked(self) -> None:
        if self._current_goal_id is None and self._team is not None:
            self._current_goal_id = self._team.active_goal_id
        if self._current_goal_id is None:
            return
        self._bus.cancel_goal(self._current_goal_id, "user clicked Cancel")
        self.status_label.setText("Cancelling…")

    @Slot()
    def _set_idle(self) -> None:
        self.goal_input.setEnabled(True)
        if hasattr(self, "_super_user_card"):
            self._super_user_card.set_reply_enabled(True)
        self.run_btn.setEnabled(True)
        self.cancel_btn.setEnabled(False)
        if hasattr(self, "_elapsed_timer"):
            self._elapsed_timer.stop()
        # Final summary — keep the elapsed total visible after a run so the
        # user sees how long it took.
        import time
        started = getattr(self, "_run_started_at", None)
        if started is not None:
            secs = int(time.monotonic() - started)
            if secs < 60:
                self.status_label.setText(f"Done in {secs}s.")
            else:
                self.status_label.setText(f"Done in {secs // 60}m {secs % 60}s.")
        else:
            self.status_label.setText("Idle.")
        self._run_started_at = None
        # Reset all canvas nodes to idle (the green/yellow/red states clear).
        try:
            self.canvas.reset_all_status()
        except Exception:
            pass
        try:
            if hasattr(self, "team_canvas") and self.team_canvas is not None:
                self.team_canvas.reset_all_status()
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Stream / approvals
    # ------------------------------------------------------------------

    @Slot(object)
    def _on_bus_message(self, msg: Message) -> None:
        """Route every bus message to canvas node statuses + per-agent log buffers.

        Buffer rules (each agent keeps its own log):
          * Append to FROM agent's log (their outgoing activity).
          * Also append to TO agent's log for USER / REQUEST / REPLY so a
            specialist sees the request that triggered it AND the reply
            it issued in the SAME stream.

        Canvas status rules:
          * REQUEST to X → X turns ACTIVE (green) — the dispatch arrived.
          * THOUGHT / TOOL_CALL from X → X stays ACTIVE.
          * REPLY from X → X turns IDLE.
          * EVENT containing "error" → that agent turns red.
        """
        # ---- log buffers ----
        if msg.from_agent in self._agent_logs:
            self._agent_logs[msg.from_agent].append(msg)
            if msg.from_agent == self._selected_agent:
                self._append_log_line(msg)
        if (
            msg.to_agent in self._agent_logs
            and msg.to_agent != msg.from_agent
            and msg.kind in (MessageKind.USER, MessageKind.REQUEST, MessageKind.REPLY)
        ):
            self._agent_logs[msg.to_agent].append(msg)
            if msg.to_agent == self._selected_agent:
                self._append_log_line(msg)

        # ---- canvas status ----
        # Fan out to BOTH the editable graph canvas and the live orbital
        # diagram so they stay in sync regardless of which view the user
        # is currently looking at. AgentTeamCanvas accepts the same
        # CANVAS_STATUS_* string keys as AgentCanvas.
        def _set_status_both(agent: str, status: str) -> None:
            try:
                self.canvas.set_node_status(agent, status)
            except Exception:
                pass
            try:
                if hasattr(self, "team_canvas") and self.team_canvas is not None:
                    self.team_canvas.set_node_status(agent, status)
            except Exception:
                pass

        if msg.kind == MessageKind.REQUEST:
            _set_status_both(msg.to_agent, CANVAS_STATUS_ACTIVE)
        elif msg.kind in (MessageKind.THOUGHT, MessageKind.TOOL_CALL):
            _set_status_both(msg.from_agent, CANVAS_STATUS_ACTIVE)
        elif msg.kind == MessageKind.REPLY:
            _set_status_both(msg.from_agent, CANVAS_STATUS_IDLE)
        elif msg.kind == MessageKind.EVENT and "error" in (msg.body or "").lower():
            target = msg.from_agent if msg.from_agent in self._agent_logs else msg.to_agent
            if target:
                _set_status_both(target, CANVAS_STATUS_ERROR)

        # ---- Super User card: surface orchestrator → user messages ----
        # The orchestrator's REPLY (or question) used to land only in its
        # own per-agent log buffer, hidden until the user clicked the
        # orchestrator node. Mirror it onto the Super User card so the
        # user sees it where they're already looking, the chat log
        # records it, and the card blinks for attention. set_attention
        # appends the body to the mini chat log internally, so don't
        # double-append.
        if (
            msg.to_agent == "user"
            and msg.kind in (MessageKind.REPLY, MessageKind.EVENT)
            and (msg.body or "").strip()
            and hasattr(self, "_super_user_card")
        ):
            try:
                self._super_user_card.set_attention(True, msg.body)
            except Exception:
                logger.exception("could not surface orchestrator message on Super User card")

    # ------------------------------------------------------------------
    # Canvas / log helpers
    # ------------------------------------------------------------------

    def _on_view_toggle_clicked(self) -> None:
        """Flip between the live orbital diagram and the editable graph."""
        if not hasattr(self, "_canvas_stack"):
            return
        idx = 1 if self._view_toggle_btn.isChecked() else 0
        self._canvas_stack.setCurrentIndex(idx)
        # Force visibility on both children — QStackedWidget alone has
        # been flaky here (the editable graph kept rendering when it
        # should be hidden).
        self.team_canvas.setVisible(idx == 0)
        self.canvas.setVisible(idx == 1)
        # Reparent the SuperUserCard onto whichever canvas is now on
        # top. A widget can only have one parent at a time, so we
        # detach from the off-screen canvas first, then attach to the
        # visible one. Without this the card stays parented to the
        # orbital diagram and disappears when the user flips to graph
        # view.
        if hasattr(self, "_super_user_card"):
            if idx == 0:
                self.canvas.attach_super_user_card(None)
                self.team_canvas.attach_super_user_card(self._super_user_card)
            else:
                self.team_canvas.attach_super_user_card(None)
                self.canvas.attach_super_user_card(self._super_user_card)
        # Update the label so the user knows what tapping does next.
        if idx == 0:
            self._view_toggle_btn.setText("◐ Graph view")
            self._view_toggle_btn.setToolTip(
                "Switch to the editable graph (drag nodes, wire edges)"
            )
        else:
            self._view_toggle_btn.setText("◑ Diagram view")
            self._view_toggle_btn.setToolTip(
                "Switch back to the live orbital diagram"
            )

    def _on_canvas_node_selected(self, agent_name: str) -> None:
        """User clicked a node — re-point the right pane at that agent's log."""
        self._selected_agent = agent_name
        self.log_header.setText(f"📜 {agent_name}")
        # Show the picker for the selected agent only.
        for name, picker in self._model_picker_buttons.items():
            picker.setVisible(name == agent_name)
        self.picker_host.setVisible(agent_name in self._model_picker_buttons)
        # Same swap for the voice row right below it.
        for name, row in self._voice_rows.items():
            row.setVisible(name == agent_name)
        self.voice_host.setVisible(agent_name in self._voice_rows)
        self._render_log_for_agent(agent_name)
        # Default to the Reply tab whenever a new agent is selected.
        if hasattr(self, "_log_tabs"):
            self._log_tabs.setCurrentIndex(0)

    def _render_log_for_agent(self, agent_name: str) -> None:
        self._chat_view.clear()
        self._thought_view.clear()
        for msg in self._agent_logs.get(agent_name, []):
            self._append_log_line(msg)

    # Strip reasoning-model chain-of-thought wrappers from a body.
    # Returns ``(thought_text, clean_reply)``. Handles the common families:
    #   * gpt-oss / harmony "channel" markers (both well-formed and the
    #     mangled <|channel>thought…<channel|> seen in the wild)
    #   * <think>…</think>           (DeepSeek-R1, Qwen reasoning)
    #   * <thinking>…</thinking>     (Claude-style)
    #   * <reasoning>…</reasoning>   (generic)
    _THOUGHT_PATTERNS = [
        re.compile(
            r'<\|channel\|?>\s*(?:thought|analysis|reasoning)\b'
            r'(?:\s*<\|message\|>)?(.*?)<\|?(?:end|return|channel)\|?>',
            re.DOTALL | re.IGNORECASE,
        ),
        re.compile(r'<think>(.*?)</think>', re.DOTALL | re.IGNORECASE),
        re.compile(r'<thinking>(.*?)</thinking>', re.DOTALL | re.IGNORECASE),
        re.compile(r'<reasoning>(.*?)</reasoning>', re.DOTALL | re.IGNORECASE),
    ]

    @classmethod
    def _split_thought(cls, body: str) -> tuple[str, str]:
        thought_parts: list[str] = []
        clean = body
        for pat in cls._THOUGHT_PATTERNS:
            def _capture(m):
                grp = m.group(1) if m.lastindex else ""
                if grp.strip():
                    thought_parts.append(grp.strip())
                return ""
            clean = pat.sub(_capture, clean)
        return ("\n\n".join(thought_parts).strip(), clean.strip())

    def _append_log_line(self, msg: Message) -> None:
        kind = msg.kind.value if hasattr(msg.kind, "value") else str(msg.kind)
        body = (msg.body or "").strip()
        if not body:
            return
        prefix_color = {
            "user":        "#9ad9ff",
            "request":     "#ffd080",
            "reply":       "#a8e7a0",
            "thought":     "#dcb0ff",
            "tool_call":   "#ffb380",
            "tool_result": "#a0c8e0",
            "event":       "#e8e8e8",
        }.get(kind.lower(), "#cccccc")
        sub = f"<span style='color:#888;'> · {msg.from_agent} → {msg.to_agent}</span>"

        # Mechanical / internal traffic — THOUGHT, TOOL_CALL, TOOL_RESULT,
        # plus EVENT — always go to the Thought tab. The clean Reply tab
        # is reserved for human-readable chat between agents and the user.
        if kind.lower() in ("thought", "tool_call", "tool_result", "event"):
            text = body[:4000] + "… (truncated)" if len(body) > 4000 else body
            html = _escape_html(text).replace("\n", "<br/>")
            t_header = f"<span style='color:{prefix_color}; font-weight:bold;'>{kind.upper()}</span>"
            self._thought_view.append(f"{t_header}{sub}<br/>{html}<br/>")
            return

        # USER / REQUEST / REPLY: split inline reasoning wrappers off to
        # the Thought tab, render the cleaned text in the Reply tab.
        thought, clean = self._split_thought(body)
        if thought:
            t = thought[:4000] + "… (truncated)" if len(thought) > 4000 else thought
            t_html = _escape_html(t).replace("\n", "<br/>")
            t_header = f"<span style='color:#dcb0ff; font-weight:bold;'>THOUGHT (from {kind.upper()})</span>"
            self._thought_view.append(f"{t_header}{sub}<br/>{t_html}<br/>")
        if clean:
            c = clean[:4000] + "… (truncated)" if len(clean) > 4000 else clean
            c_html = _escape_html(c).replace("\n", "<br/>")
            # Speaker label: for REPLY/REQUEST use the FROM agent's name
            # ("Orchi: …"); for USER use a fixed "You: …". This replaces
            # the old uppercase REPLY / USER / REQUEST tags so the chat
            # actually reads like a conversation.
            kl = kind.lower()
            if kl == "user":
                speaker = "You"
            else:
                speaker = msg.from_agent or kind.upper()
            speaker_html = (
                f"<span style='color:{prefix_color}; font-weight:bold;'>{_escape_html(speaker)}:</span>"
            )
            target_note = ""
            if kl == "request" and msg.to_agent and msg.to_agent != msg.from_agent:
                target_note = f" <span style='color:#888;'>→ {_escape_html(msg.to_agent)}</span>"
            self._chat_view.append(f"{speaker_html}{target_note} {c_html}<br/>")

    def _on_graph_changed(self) -> None:
        """Persist the canvas's current node positions + edges to the project."""
        if self._active_project is None:
            return
        try:
            graph = self.canvas.export_graph()
            self._active_project.graph_json = graph.to_json_string()
            self._project_store.save_project(self._active_project)
        except Exception:
            logger.exception("could not persist agent graph")

    def _on_delete_selected_edge(self) -> None:
        self.canvas.remove_selected_edge()

    def _on_reverse_selected_edge(self) -> None:
        self.canvas.reverse_selected_edge()

    def _on_canvas_node_context_menu(self, agent_name: str, screen_pos) -> None:
        """Right-click on a canvas node — surface per-agent settings.

        The previous canvas had no per-agent affordances (the user
        complained the agents looked empty / settings vanished). This
        menu re-attaches all the previous AgentCard actions to the node:
        pick a model, view this agent's log, and remove from team.
        """
        menu = QMenu(self)
        pick_model_act = menu.addAction("🧠 Pick model…")
        view_log_act = menu.addAction("📜 View log on the right pane")
        menu.addSeparator()
        remove_act = menu.addAction("🗑 Remove from team")
        chosen = menu.exec(screen_pos)
        if chosen is None:
            return
        if chosen is pick_model_act:
            picker = self._model_picker_buttons.get(agent_name)
            if picker is not None:
                # Selecting on the canvas pre-shows the picker in the side
                # panel, but the menu is the FAST path: just open the popup.
                self.canvas.select_agent(agent_name)
                self._on_canvas_node_selected(agent_name)
                try:
                    picker.click()  # opens the popup
                except Exception:
                    pass
        elif chosen is view_log_act:
            self.canvas.select_agent(agent_name)
            self._on_canvas_node_selected(agent_name)
        elif chosen is remove_act:
            self._remove_agent_from_team(agent_name)

    def _remove_agent_from_team(self, agent_name: str) -> None:
        if self._active_project is None:
            return
        if QMessageBox.question(
            self, "Remove agent",
            f"Remove '{agent_name}' from the project team?\n"
            "(This only edits the team list — the agent definition is preserved.)",
        ) != QMessageBox.Yes:
            return
        try:
            self._active_project.team = [
                n for n in (self._active_project.team or []) if n != agent_name
            ]
            self._project_store.save_project(self._active_project)
        except Exception:
            logger.exception("could not persist team after remove")
            return
        # Drop from canvas and rebuild so layout/edges stay consistent.
        try:
            self.canvas.remove_agent_node(agent_name)
        except Exception:
            pass
        self._team = None  # force rebuild on next Run
        self._render_team()

    def _on_reset_layout(self) -> None:
        graph = self.canvas.export_graph()
        defs = list_all_definitions()
        leader_name = None
        for name in (self._active_project.team if self._active_project else []):
            d = defs.get(name)
            if d is not None and d.can_dispatch:
                leader_name = name
                break
        # Layered: orchestrator at column 0, others by BFS distance from it.
        graph.autolayout_layered(leader_name)
        self.canvas.load_graph(graph, orchestrator=leader_name)
        # ``load_graph`` rebuilds every node from scratch and resets
        # them to the default robot icon — push each agent's real
        # icon, model label, and meta back onto the new nodes so
        # Reset-layout doesn't wipe what the Studio configured.
        for n in graph.nodes:
            d = defs.get(n.name)
            if d is None:
                continue
            try:
                self.canvas.set_node_icon(n.name, d.icon or "🤖")
            except Exception:
                pass
            try:
                graph_skills = list(d.tool_allowlist or [])
                if d.can_dispatch and "dispatch" not in graph_skills:
                    graph_skills = ["dispatch"] + graph_skills
                self.canvas.set_node_meta(
                    n.name, d.description or "", graph_skills,
                )
            except Exception:
                pass
            try:
                self._update_canvas_model_label(n.name)
            except Exception:
                pass
        # Persist new positions.
        self._on_graph_changed()

    @Slot(object)
    def _on_approval_requested(self, req: ApprovalRequest) -> None:
        card = ApprovalCard(req, on_resolve=self._resolve_approval)
        self._approval_cards[req.id] = card
        self._approvals_layout.addWidget(card)
        self.approvals_frame.setVisible(True)
        # Light up the Super User card so the user sees something to act
        # on even if the approvals frame is below the fold, and ping the
        # configured external channel (Telegram, …) if one is set.
        body = f"{req.agent} wants to run {req.tool_name}"
        try:
            self._super_user_card.set_attention(True, body)
        except Exception:
            logger.exception("could not set Super-User-card attention")
        try:
            from core.notify import notify_async
            notify_async("OWLLM — input needed", body)
        except Exception:
            logger.exception("notify_async raised unexpectedly")

    def _resolve_approval(self, request: ApprovalRequest, decision: ApprovalDecision) -> None:
        self._registry.gate.resolve(request.id, decision)
        card = self._approval_cards.pop(request.id, None)
        if card is not None:
            card.setParent(None)
            card.deleteLater()
        if not self._approval_cards:
            self.approvals_frame.setVisible(False)
            try:
                self._super_user_card.set_attention(False)
            except Exception:
                logger.exception("could not clear Super-User-card attention")

    def _open_notify_settings(self) -> None:
        """Open the notify-settings dialog (Telegram bot token, chat id)."""
        try:
            from desktop_app.widgets.notify_settings_dialog import (
                NotifySettingsDialog,
            )
            dlg = NotifySettingsDialog(self)
            dlg.show()
        except Exception:
            logger.exception("could not open notify settings")

    # ------------------------------------------------------------------
    # Supervisor (auto-approve) wiring
    # ------------------------------------------------------------------

    _AUTO_APPROVE_RULE = "supervisor_card_auto_approve_all"

    def _on_supervisor_toggled(self, checked: bool) -> None:
        """Persist the per-project auto-approve flag and register/remove
        the wildcard rule on the team's ApprovalGate. Idempotent — safe
        to call repeatedly."""
        if self._active_project is None:
            # No project to persist on — silently revert.
            self._super_user_card.set_supervisor_state(False)
            return
        self._active_project.auto_approve_all = bool(checked)
        try:
            self._project_store.save_project(self._active_project)
        except Exception:
            logger.exception("could not save auto_approve_all")
        self._apply_supervisor_state(bool(checked))

    def _apply_supervisor_state(self, on: bool) -> None:
        """Install or remove the wildcard auto-approve rule on the
        gate. Called from the toggle handler and from project-switch /
        team-build sync paths."""
        try:
            from core.agents.tools.base import (
                ApprovalDecision, AutoApproveRule,
            )
            gate = self._registry.gate
        except Exception:
            logger.exception("could not access approval gate")
            return
        if on:
            rule = AutoApproveRule(
                name=self._AUTO_APPROVE_RULE,
                predicate=lambda req: True,
                decision=ApprovalDecision.APPROVE,
                reason="supervisor_card auto-approve-all",
            )
            try:
                gate.add_rule(rule)
            except Exception:
                logger.exception("could not add auto-approve rule")
        else:
            try:
                gate.remove_rule(self._AUTO_APPROVE_RULE)
            except Exception:
                logger.exception("could not remove auto-approve rule")

    def _on_user_reply(self, text: str) -> None:
        """Quick-reply submitted from the User card. Forwards to the
        existing goal pipeline so all run logic (team build, working-dir
        hint, attachment snapshot, etc.) applies untouched. If a run is
        already in flight we stage the text in the main goal input
        instead of starting a second goal — the user can press Enter
        when the team is ready, or use the approval buttons."""
        text = (text or "").strip()
        if not text:
            return
        # User has acknowledged the team's last message — clear the
        # blinking attention state so the card returns to idle.
        try:
            self._super_user_card.set_attention(False)
        except Exception:
            pass
        if getattr(self, "_run_active", False):
            # Stage but don't run; the disabled goal_input will accept
            # the text and re-enable when the current run finishes.
            self.goal_input.setText(text)
            return
        self.goal_input.setText(text)
        self._run_clicked()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Markdown → HTML (compact, no external dep)
# ---------------------------------------------------------------------------


import re as _re


_RE_INLINE_CODE = _re.compile(r"`([^`\n]+)`")
_RE_BOLD = _re.compile(r"\*\*(.+?)\*\*", _re.DOTALL)
_RE_ITALIC_STAR = _re.compile(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", _re.DOTALL)
_RE_HEADING = _re.compile(r"^(#{1,4})\s+(.+)$")
_RE_BULLET = _re.compile(r"^\s*[-*]\s+(.+)$")
_RE_NUMBERED = _re.compile(r"^\s*(\d+)\.\s+(.+)$")
_RE_CODE_FENCE = _re.compile(r"^```(\w*)$")


def _escape_html(text: str) -> str:
    """HTML-escape (and only HTML-escape) a string."""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _apply_inline(text: str) -> str:
    """Apply inline markdown -> HTML on already-escaped text.

    Order matters: code first (so its content doesn't get bold-mangled),
    then bold, then italic.
    """
    # Inline code — re-escape in case the model put angle brackets inside
    # backticks; keep the backtick body literal.
    def code_sub(m):
        return (
            f"<code style='background:rgba(255,255,255,0.08); "
            f"border-radius:3px; padding:0 4px; "
            f"font-family:Consolas,Menlo,monospace;'>{m.group(1)}</code>"
        )

    text = _RE_INLINE_CODE.sub(code_sub, text)
    text = _RE_BOLD.sub(r"<b>\1</b>", text)
    text = _RE_ITALIC_STAR.sub(r"<i>\1</i>", text)
    return text


def _markdown_to_html(raw: str) -> str:
    r"""Convert a small but useful subset of markdown to HTML.

    Supports: ``**bold**``, ``*italic*``, `` `code` ``, fenced code blocks
    (```` ``` ````), ATX headings (``# h1`` … ``#### h4``), unordered lists
    (``-`` / ``*``), ordered lists (``1.``), paragraph breaks (blank lines),
    and soft line breaks within a paragraph.

    Intentionally not a full markdown engine — just enough that orchestrator
    replies and tool outputs render as structured HTML inside a QTextEdit
    instead of one wall of run-on text.
    """
    if not raw:
        return ""

    lines = raw.splitlines()
    out: list[str] = []
    in_code = False
    list_kind: Optional[str] = None  # "ul" or "ol" while open, else None
    para_buf: list[str] = []

    def flush_para():
        if para_buf:
            joined = "<br>".join(_apply_inline(_escape_html(line)) for line in para_buf)
            out.append(f"<p style='margin:4px 0;'>{joined}</p>")
            para_buf.clear()

    def flush_list():
        nonlocal list_kind
        if list_kind:
            out.append(f"</{list_kind}>")
            list_kind = None

    for line in lines:
        # Code-fence boundary.
        m = _RE_CODE_FENCE.match(line.strip())
        if m:
            flush_para()
            flush_list()
            if not in_code:
                in_code = True
                out.append(
                    "<pre style='background:rgba(0,0,0,0.30); border-radius:6px; "
                    "padding:8px 10px; margin:6px 0; font-size:12px; "
                    "font-family:Consolas,Menlo,monospace; white-space:pre-wrap;'>"
                )
            else:
                in_code = False
                out.append("</pre>")
            continue

        if in_code:
            out.append(_escape_html(line))
            continue

        stripped = line.strip()

        # Blank line — paragraph break.
        if not stripped:
            flush_para()
            flush_list()
            continue

        # Heading.
        m = _RE_HEADING.match(stripped)
        if m:
            flush_para()
            flush_list()
            level = len(m.group(1))
            tag = {1: "h2", 2: "h3", 3: "h4", 4: "h5"}.get(level, "h5")
            content = _apply_inline(_escape_html(m.group(2)))
            size = {1: "17px", 2: "15px", 3: "14px", 4: "13px"}.get(level, "13px")
            out.append(
                f"<{tag} style='margin:8px 0 4px 0; font-size:{size}; "
                f"color:#fff;'>{content}</{tag}>"
            )
            continue

        # Bullet.
        m = _RE_BULLET.match(stripped)
        if m:
            flush_para()
            if list_kind != "ul":
                flush_list()
                list_kind = "ul"
                out.append("<ul style='margin:2px 0; padding-left:18px;'>")
            content = _apply_inline(_escape_html(m.group(1)))
            out.append(f"<li>{content}</li>")
            continue

        # Numbered.
        m = _RE_NUMBERED.match(stripped)
        if m:
            flush_para()
            if list_kind != "ol":
                flush_list()
                list_kind = "ol"
                out.append("<ol style='margin:2px 0; padding-left:22px;'>")
            content = _apply_inline(_escape_html(m.group(2)))
            out.append(f"<li>{content}</li>")
            continue

        # Plain paragraph line.
        flush_list()
        para_buf.append(line)

    # Drain.
    flush_para()
    flush_list()
    if in_code:
        out.append("</pre>")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Role <-> AgentDefinition bridge
# ---------------------------------------------------------------------------


def _role_from_definition(d: AgentDefinition) -> Role:
    """Construct a runtime ``Role`` from an editable ``AgentDefinition``.

    The runtime team-builder still consumes Role objects; AgentDefinition
    is the user-facing superset. This bridge keeps the runtime untouched
    and lets the Studio evolve independently.

    Allowlist merge semantics:

      * ``tool_allowlist=None`` means "all built-in tools allowed". When
        an mcp_allowlist is *also* set we keep the runtime allowlist
        ``None`` rather than collapse to the MCP-only list — there's no
        way to express "all builtins + specific MCP tools" as a single
        runtime allowlist without enumerating every builtin name, and
        silently dropping every builtin (read_file, dispatch, …) was the
        previous bug that surfaced as a crash on team templates whose
        agents inherit "all" from a base role and add an mcp filter.
      * ``tool_allowlist=[...]`` is honoured exactly: builtins are
        restricted to that list, plus every entry from mcp_allowlist.
    """
    if d.tool_allowlist is None:
        merged: Optional[List[str]] = None
    else:
        merged = list(d.tool_allowlist) + list(d.mcp_allowlist or [])
    return Role(
        name=d.name,
        description=d.description,
        system_prompt=d.system_prompt,
        tool_allowlist=merged,
        can_dispatch=d.can_dispatch,
        default_temperature=d.default_temperature,
        icon=d.icon,
    )


# ---------------------------------------------------------------------------
# Team picker dialog
# ---------------------------------------------------------------------------


class _TeamPickerDialog(QDialog):
    """Modal: tick the agent definitions to include in this project's team."""

    def __init__(
        self,
        *,
        available: Dict[str, AgentDefinition],
        selected: set,
        parent=None,
    ) -> None:
        super().__init__(parent)
        self.setWindowTitle("Edit team")
        self.setModal(True)
        self.setMinimumWidth(520)

        self._checks: Dict[str, "QCheckBox"] = {}

        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(12)

        prose = QLabel(
            "Pick the agents that work on this project. Need a custom one? "
            "Design it in the 🎭 Studio tab and it'll appear here."
        )
        prose.setWordWrap(True)
        prose.setStyleSheet("color:#bbb; font-size:11px;")
        layout.addWidget(prose)

        from PySide6.QtWidgets import QCheckBox  # local import — only place we need it
        ordered = sorted(
            available.values(),
            key=lambda d: (0 if d.built_in else 1, 0 if d.can_dispatch else 1, d.name.lower()),
        )
        for d in ordered:
            row = QHBoxLayout()
            cb = QCheckBox()
            cb.setChecked(d.name in selected)
            self._checks[d.name] = cb
            row.addWidget(cb)
            from desktop_app.widgets.agent_icons import apply_to_label
            avatar = QLabel()
            avatar.setFixedSize(36, 36)
            avatar.setAlignment(Qt.AlignCenter)
            af = QFont()
            af.setPointSize(16)
            avatar.setFont(af)
            avatar.setStyleSheet("color:#fff;")
            apply_to_label(avatar, d.icon or "🤖", size=32)
            row.addWidget(avatar)

            text = QVBoxLayout()
            text.setSpacing(0)
            tag_bits = []
            if d.can_dispatch:
                tag_bits.append("LEADER")
            if d.built_in:
                tag_bits.append("BUILT-IN")
            tag_str = ("  ·  ".join(tag_bits) + "  ·  ") if tag_bits else ""
            name_label = QLabel(f"<b>{d.name}</b>")
            name_label.setStyleSheet("color:#fff;")
            text.addWidget(name_label)
            sub_label = QLabel(f"{tag_str}{d.description}")
            sub_label.setStyleSheet("color:#9aa0a6; font-size:11px;")
            text.addWidget(sub_label)
            row.addLayout(text, 1)
            layout.addLayout(row)

        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def selected_names(self) -> List[str]:
        return [name for name, cb in self._checks.items() if cb.isChecked()]


# ---------------------------------------------------------------------------
# Style snippets
# ---------------------------------------------------------------------------


_GHOST_BTN_STYLE = """
    QPushButton {
        background:rgba(255,255,255,0.04);
        color:#dadcdf;
        border:none; border-radius:8px;
        padding:0 14px; font-size:12px;
    }
    QPushButton:hover { background:rgba(255,255,255,0.10); color:#fff; }
"""

_GHOST_BTN_STYLE_SMALL = """
    QPushButton {
        background:rgba(255,255,255,0.04);
        color:#cbd2e0;
        border:none; border-radius:7px;
        padding:0 10px; font-size:11px;
        min-height:28px;
    }
    QPushButton:hover { background:rgba(255,255,255,0.10); color:#fff; }
    QPushButton:checked { background:#3a4a78; color:#fff; }
"""

_DESTRUCTIVE_GHOST_STYLE = """
    QPushButton {
        background:transparent;
        color:#ff8c8c;
        border:none; border-radius:8px;
        padding:0 14px; font-size:12px;
    }
    QPushButton:hover { background:rgba(255,140,140,0.12); }
"""


def _short_args(args, limit: int = 100) -> str:
    parts = []
    for k, v in args.items():
        s = str(v)
        if len(s) > 40:
            s = s[:37] + "..."
        parts.append(f"{k}={s!r}")
    line = ", ".join(parts)
    if len(line) > limit:
        line = line[: limit - 3] + "..."
    return line
