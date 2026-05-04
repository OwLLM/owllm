"""🎭 Studio — design and customize agents (cartoon avatar, job, MCP tools).

Two-column page: left is the gallery of all agent definitions (built-in +
custom) as pretty cards; right is an editor panel that opens when a card
is clicked.

Built-in agents are tagged "BUILT-IN", show an immutable look, and can
only be **duplicated** (creating a custom copy you can then freely edit).
Custom agents support full edit + delete.

Cartoon-style: each agent picks an emoji avatar from a curated palette of
characters (animals, fantasy, robots) so the team looks like a team and
not a list of buttons.
"""
from __future__ import annotations

import logging
from typing import Callable, Dict, List, Optional

from PySide6.QtCore import QObject, QSettings, QSize, Qt, Signal, Slot
from PySide6.QtGui import QColor, QFont, QIcon
from PySide6.QtWidgets import (
    QCheckBox,
    QFrame,
    QGraphicsDropShadowEffect,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QSplitter,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from core.agents.agent_definitions import (
    AgentDefinition,
    delete_custom,
    duplicate,
    list_all_definitions,
    save_custom,
)
from core.agents.backends import list_all_entries
from core.agents.tools import builtin_registry
from desktop_app.widgets.agent_icons import (
    apply_to_button,
    apply_to_label,
    is_owl_icon,
    list_owl_icons,
    owl_basename,
    owl_label,
)
from desktop_app.widgets.model_picker import ModelPickerButton
from desktop_app.widgets.skill_library_dialog import SkillLibraryDialog

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Cartoon avatar palette
# ---------------------------------------------------------------------------


# Curated emoji palette for agent avatars. Cartoon-feel — animals, fantasy
# characters, robots, mythological. The Studio shows these in a grid for
# the user to pick from. Add/remove freely; first row is the "team
# default" set used by built-ins.
AVATAR_PALETTE = (
    "🧠", "🔍", "🛠️", "📡", "🔬",
    "🦊", "🐼", "🦁", "🐯", "🐱",
    "🐶", "🐰", "🐻", "🐨", "🐸",
    "🦄", "🐲", "🦉", "🦅", "🐺",
    "🤖", "👾", "🦸", "🧙", "🧚",
    "🧞", "🥷", "🦹", "🧛", "🧜",
    "🌟", "⚡", "🔥", "🍀", "💫",
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _add_shadow(widget: QWidget, blur: int = 20, y: int = 3, alpha: int = 110) -> None:
    eff = QGraphicsDropShadowEffect(widget)
    eff.setBlurRadius(blur)
    eff.setOffset(0, y)
    eff.setColor(QColor(0, 0, 0, alpha))
    widget.setGraphicsEffect(eff)


def _list_mcp_tool_names() -> List[str]:
    """Discover MCP tool names by registering them into a throwaway registry.

    The Studio uses this so the user can grant a custom agent specific MCP
    tools (e.g. only ``mcp.calendar.create_event`` and
    ``mcp.calendar.list_events``, not the WhatsApp ones). The list reflects
    what's currently connected; refreshing the page re-pulls.
    """
    try:
        from core.agents.tools.mcp_adapter import register_mcp_tools
        from desktop_app.mcp.connection_manager import MCPConnectionManager

        reg = builtin_registry()
        before = set(reg.names())
        register_mcp_tools(reg, MCPConnectionManager())
        return sorted(set(reg.names()) - before)
    except Exception:
        logger.exception("could not enumerate MCP tools for Studio")
        return []


def _list_builtin_tool_names() -> List[str]:
    return sorted(builtin_registry().names())


# ---------------------------------------------------------------------------
# Gallery card
# ---------------------------------------------------------------------------


class _GalleryCard(QFrame):
    """One agent in the gallery — click to open the editor."""

    clicked = Signal(str)  # agent name

    def __init__(self, definition: AgentDefinition, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.definition = definition

        self.setObjectName("GalleryCard")
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.setMinimumHeight(110)
        self.setCursor(Qt.PointingHandCursor)

        # Built-ins get a subtle accent border-left; customs are neutral.
        accent = "#4a6cff" if definition.built_in else "#7a8a9c"
        self.setStyleSheet(f"""
            QFrame#GalleryCard {{
                background: qlineargradient(
                    x1:0, y1:0, x2:0, y2:1,
                    stop:0 #232936, stop:1 #181b22
                );
                border: none;
                border-left: 3px solid {accent};
                border-radius: 12px;
            }}
            QFrame#GalleryCard:hover {{
                background: qlineargradient(
                    x1:0, y1:0, x2:0, y2:1,
                    stop:0 #2a3142, stop:1 #1d212a
                );
            }}
        """)
        _add_shadow(self)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(16, 12, 16, 12)
        layout.setSpacing(14)

        avatar = QLabel()
        avatar.setFixedSize(56, 56)
        avatar.setAlignment(Qt.AlignCenter)
        af = QFont()
        af.setPointSize(28)
        avatar.setFont(af)
        avatar.setStyleSheet("background:transparent; color:#fff;")
        apply_to_label(avatar, definition.icon or "🤖", size=52)
        layout.addWidget(avatar)

        text = QVBoxLayout()
        text.setSpacing(2)

        name_row = QHBoxLayout()
        name_row.setSpacing(8)
        name_label = QLabel(definition.name.capitalize())
        nf = QFont()
        nf.setPointSize(14)
        nf.setBold(True)
        name_label.setFont(nf)
        name_label.setStyleSheet("color:#fff; background:transparent;")
        name_row.addWidget(name_label)

        if definition.built_in:
            badge = QLabel("BUILT-IN")
            badge.setStyleSheet(
                "color:#7989ff; background:rgba(121,137,255,0.15); "
                "border-radius:6px; padding:2px 8px; font-size:10px; "
                "font-weight:600; letter-spacing:0.6px;"
            )
            name_row.addWidget(badge)
        if definition.can_dispatch:
            leader = QLabel("LEADER")
            leader.setStyleSheet(
                "color:#ffd080; background:rgba(255,208,128,0.15); "
                "border-radius:6px; padding:2px 8px; font-size:10px; "
                "font-weight:600; letter-spacing:0.6px;"
            )
            name_row.addWidget(leader)
        name_row.addStretch(1)
        text.addLayout(name_row)

        desc = QLabel(definition.description or "(no description)")
        desc.setWordWrap(True)
        desc.setStyleSheet("color:#9aa0a6; font-size:12px; background:transparent;")
        text.addWidget(desc)
        layout.addLayout(text, 1)

    def mousePressEvent(self, ev) -> None:  # noqa: N802
        if ev.button() == Qt.LeftButton:
            self.clicked.emit(self.definition.name)


# ---------------------------------------------------------------------------
# Avatar picker (popover-style flow inside editor)
# ---------------------------------------------------------------------------


class _AvatarPicker(QFrame):
    """Grid of avatar buttons (owl PNGs first, then emoji palette).

    Every tile is rendered up-front at a comfortably clickable size —
    selection just changes the border / glow, it doesn't gate
    visibility. Emoji tiles use ``Segoe UI Emoji`` explicitly because
    the default Qt font renders many glyphs as blank tofu boxes.
    """

    picked = Signal(str)

    # Tile sizes — every visible glyph (owl PNG or emoji) is at least
    # 100px tall so the user can actually see them at a glance.
    OWL_TILE = 124
    OWL_ICON = 108
    EMOJI_TILE = 116
    EMOJI_FONT_PT = 52

    def __init__(self, current: str, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setObjectName("AvatarPicker")
        self.setStyleSheet(
            "QFrame#AvatarPicker { background:#14171d; border:none; border-radius:10px; }"
        )
        outer = QVBoxLayout(self)
        outer.setContentsMargins(12, 12, 12, 12)
        outer.setSpacing(10)

        # Owl PNG row(s).
        owls = list(list_owl_icons())
        if owls:
            owl_lbl = QLabel("Owl crew")
            owl_lbl.setStyleSheet(
                "color:#9aa0a6; background:transparent; "
                "font-size:11px; font-weight:600; letter-spacing:0.6px;"
            )
            outer.addWidget(owl_lbl)

            owl_grid = QGridLayout()
            owl_grid.setContentsMargins(0, 0, 0, 0)
            owl_grid.setSpacing(10)
            cols = 4
            for i, (icon_str, pm) in enumerate(owls):
                btn = QPushButton()
                btn.setFixedSize(self.OWL_TILE, self.OWL_TILE)
                btn.setIcon(QIcon(pm))
                btn.setIconSize(QSize(self.OWL_ICON, self.OWL_ICON))
                btn.setToolTip(owl_label(owl_basename(icon_str)))
                self._apply_tile_style(btn, selected=(icon_str == current))
                btn.clicked.connect(
                    lambda _checked=False, s=icon_str: self.picked.emit(s)
                )
                owl_grid.addWidget(btn, i // cols, i % cols)
            outer.addLayout(owl_grid)

        # Emoji row(s).
        emoji_lbl = QLabel("Emoji")
        emoji_lbl.setStyleSheet(
            "color:#9aa0a6; background:transparent; "
            "font-size:11px; font-weight:600; letter-spacing:0.6px;"
        )
        outer.addWidget(emoji_lbl)

        emoji_grid = QGridLayout()
        emoji_grid.setContentsMargins(0, 0, 0, 0)
        emoji_grid.setSpacing(8)
        cols = 5
        emoji_font = QFont("Segoe UI Emoji")
        emoji_font.setPointSize(self.EMOJI_FONT_PT)
        for i, emoji in enumerate(AVATAR_PALETTE):
            btn = QPushButton(emoji)
            btn.setFixedSize(self.EMOJI_TILE, self.EMOJI_TILE)
            btn.setFont(emoji_font)
            self._apply_tile_style(btn, selected=(emoji == current), emoji=True)
            btn.clicked.connect(
                lambda _checked=False, e=emoji: self.picked.emit(e)
            )
            emoji_grid.addWidget(btn, i // cols, i % cols)
        outer.addLayout(emoji_grid)

    @staticmethod
    def _apply_tile_style(btn: QPushButton, *, selected: bool, emoji: bool = False) -> None:
        # rgba(255,255,255,0.12) on the dark backplate is bright enough to
        # read every tile at a glance; selected tiles add a neon border so
        # the *current* choice still stands out. We deliberately avoid
        # overriding ``color`` on emoji buttons — Qt+Windows render colour
        # emoji natively, and forcing ``color:#fff`` washes them to mono.
        bg = "rgba(74,108,255,0.30)" if selected else "rgba(255,255,255,0.12)"
        border = "1.5px solid #6f8aff" if selected else "1px solid rgba(255,255,255,0.10)"
        if emoji:
            btn.setStyleSheet(f"""
                QPushButton {{
                    background:{bg};
                    border:{border};
                    border-radius:10px;
                }}
                QPushButton:hover {{
                    background:rgba(74,108,255,0.45);
                    border:1.5px solid #8aa3ff;
                }}
            """)
        else:
            btn.setStyleSheet(f"""
                QPushButton {{
                    background:{bg};
                    border:{border};
                    border-radius:10px;
                    color:#ffffff;
                }}
                QPushButton:hover {{
                    background:rgba(74,108,255,0.45);
                    border:1.5px solid #8aa3ff;
                }}
            """)


# ---------------------------------------------------------------------------
# Editor panel
# ---------------------------------------------------------------------------


class _EditorPanel(QFrame):
    """Right-side editor for one agent definition.

    Lives in the gallery's splitter and updates in-place when a different
    card is clicked. Save / Delete / Duplicate buttons at the bottom.
    """

    saved = Signal(str)        # name of the saved/created definition
    deleted = Signal(str)      # name of the deleted custom

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self._current: Optional[AgentDefinition] = None
        self._current_icon: str = "🤖"
        self._builtin_tool_checks: Dict[str, QCheckBox] = {}
        self._mcp_tool_checks: Dict[str, QCheckBox] = {}

        self.setObjectName("EditorPanel")
        self.setStyleSheet(
            "QFrame#EditorPanel { background:#1a1d24; border:none; border-radius:12px; }"
        )
        _add_shadow(self)
        self._build_ui()

    def _build_ui(self) -> None:
        # The editor is content-rich — wrap it in a scroll area so even
        # with many MCP tools the buttons stay reachable. (User: "no
        # scrollshit" applies to the *agent runtime cards*; an editor form
        # is a different beast where vertical content can't always be
        # bounded.)
        outer_layout = QVBoxLayout(self)
        outer_layout.setContentsMargins(0, 0, 0, 0)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.NoFrame)
        scroll.setStyleSheet("QScrollArea { background:transparent; border:none; }")
        host = QWidget()
        outer = QVBoxLayout(host)
        outer.setContentsMargins(20, 20, 20, 20)
        outer.setSpacing(14)

        # Header.
        header_row = QHBoxLayout()
        header_row.setSpacing(14)
        self.avatar_button = QPushButton("🤖")
        self.avatar_button.setFixedSize(64, 64)
        self.avatar_button.setIconSize(QSize(54, 54))
        self.avatar_button.setStyleSheet("""
            QPushButton {
                background: rgba(255,255,255,0.10);
                border: 1px solid rgba(255,255,255,0.12);
                border-radius: 12px;
                color: #ffffff;
                font-size: 32px;
            }
            QPushButton:hover {
                background: rgba(74,108,255,0.30);
                border: 1px solid #6f8aff;
            }
        """)
        self.avatar_button.clicked.connect(self._toggle_avatar_picker)
        header_row.addWidget(self.avatar_button)

        name_box = QVBoxLayout()
        name_box.setSpacing(6)
        nf = QFont()
        nf.setPointSize(11)
        nf.setBold(True)
        nf2 = QFont()
        nf2.setPointSize(11)
        lbl_n = QLabel("Name")
        lbl_n.setFont(nf2)
        lbl_n.setStyleSheet("color:#9aa0a6; background:transparent;")
        name_box.addWidget(lbl_n)
        self.name_input = QLineEdit()
        self.name_input.setMinimumHeight(32)
        self.name_input.setStyleSheet(_INPUT_STYLE)
        name_box.addWidget(self.name_input)
        header_row.addLayout(name_box, 1)
        outer.addLayout(header_row)

        # Avatar picker (initially hidden).
        self.avatar_picker = _AvatarPicker(current="🤖")
        self.avatar_picker.picked.connect(self._on_avatar_picked)
        self.avatar_picker.setVisible(False)
        outer.addWidget(self.avatar_picker)

        # Description.
        outer.addWidget(_section_label("Job description (one line)"))
        self.desc_input = QLineEdit()
        self.desc_input.setMinimumHeight(32)
        self.desc_input.setStyleSheet(_INPUT_STYLE)
        outer.addWidget(self.desc_input)

        # System prompt.
        outer.addWidget(_section_label("System prompt"))
        self.prompt_input = QTextEdit()
        self.prompt_input.setMinimumHeight(160)
        self.prompt_input.setStyleSheet(_INPUT_STYLE_TEXTAREA)
        outer.addWidget(self.prompt_input)

        # Default model.
        outer.addWidget(_section_label("Default model"))
        self.model_picker = ModelPickerButton()
        self.model_picker.refresh_entries()
        outer.addWidget(self.model_picker)

        # Tools.
        outer.addWidget(_section_label("Built-in tools"))
        self._builtin_tools_box = QFrame()
        self._builtin_tools_box.setStyleSheet(_TOOLBOX_STYLE)
        bt_layout = QVBoxLayout(self._builtin_tools_box)
        bt_layout.setContentsMargins(12, 10, 12, 10)
        bt_layout.setSpacing(4)
        for tool_name in _list_builtin_tool_names():
            cb = QCheckBox(tool_name)
            cb.setStyleSheet("color:#dadcdf; font-size:12px;")
            self._builtin_tool_checks[tool_name] = cb
            bt_layout.addWidget(cb)
        outer.addWidget(self._builtin_tools_box)

        # MCP tools.
        outer.addWidget(_section_label("MCP tools (from connected servers)"))
        self._mcp_tools_box = QFrame()
        self._mcp_tools_box.setStyleSheet(_TOOLBOX_STYLE)
        mt_layout = QVBoxLayout(self._mcp_tools_box)
        mt_layout.setContentsMargins(12, 10, 12, 10)
        mt_layout.setSpacing(4)
        mcp_names = _list_mcp_tool_names()
        if mcp_names:
            for tool_name in mcp_names:
                cb = QCheckBox(tool_name)
                cb.setStyleSheet("color:#dadcdf; font-size:12px;")
                self._mcp_tool_checks[tool_name] = cb
                mt_layout.addWidget(cb)
        else:
            empty = QLabel(
                "No MCP servers connected. Configure them in the 🧩 MCP tab."
            )
            empty.setStyleSheet("color:#9aa0a6; font-size:11px; font-style:italic;")
            mt_layout.addWidget(empty)
        outer.addWidget(self._mcp_tools_box)

        # Leader checkbox.
        self.leader_cb = QCheckBox(
            "Team leader — can dispatch work to other agents"
        )
        self.leader_cb.setStyleSheet("color:#dadcdf; font-size:12px;")
        outer.addWidget(self.leader_cb)

        outer.addStretch(1)

        # Action buttons.
        btn_row = QHBoxLayout()
        btn_row.setSpacing(8)
        self.save_btn = QPushButton("Save")
        self.save_btn.setMinimumHeight(36)
        self.save_btn.setStyleSheet(_PRIMARY_BTN_STYLE)
        self.save_btn.clicked.connect(self._on_save)
        self.duplicate_btn = QPushButton("Duplicate")
        self.duplicate_btn.setMinimumHeight(36)
        self.duplicate_btn.setStyleSheet(_GHOST_BTN_STYLE)
        self.duplicate_btn.clicked.connect(self._on_duplicate)
        self.delete_btn = QPushButton("Delete")
        self.delete_btn.setMinimumHeight(36)
        self.delete_btn.setStyleSheet(_DESTRUCTIVE_BTN_STYLE)
        self.delete_btn.clicked.connect(self._on_delete)

        btn_row.addWidget(self.save_btn, 1)
        btn_row.addWidget(self.duplicate_btn)
        btn_row.addWidget(self.delete_btn)
        outer.addLayout(btn_row)

        # Read-only banner shown when editing a built-in.
        self.builtin_banner = QLabel(
            "🔒  This is a built-in agent. To modify it, click <b>Duplicate</b> first."
        )
        self.builtin_banner.setStyleSheet(
            "color:#c5cdff; background:rgba(74,108,255,0.10); "
            "border-radius:8px; padding:8px 12px; font-size:11px;"
        )
        self.builtin_banner.setVisible(False)
        outer.addWidget(self.builtin_banner)

        scroll.setWidget(host)
        outer_layout.addWidget(scroll)

    # ------------------------------------------------------------------
    # Population
    # ------------------------------------------------------------------

    def load(self, definition: AgentDefinition) -> None:
        self._current = definition
        self._current_icon = definition.icon or "🤖"
        apply_to_button(self.avatar_button, self._current_icon, size=54)
        self.avatar_picker.setVisible(False)
        self.name_input.setText(definition.name)
        self.desc_input.setText(definition.description)
        self.prompt_input.setPlainText(definition.system_prompt)
        if definition.default_model_id:
            self.model_picker.set_current_id(definition.default_model_id)
        self.leader_cb.setChecked(definition.can_dispatch)

        # Tool checkboxes — None means "all selected".
        bi_allow = definition.tool_allowlist
        for name, cb in self._builtin_tool_checks.items():
            cb.setChecked(bi_allow is None or name in bi_allow)

        mcp_allow = definition.mcp_allowlist
        for name, cb in self._mcp_tool_checks.items():
            cb.setChecked(mcp_allow is None or name in mcp_allow)

        # Lock everything if built-in.
        editable = not definition.built_in
        self.name_input.setEnabled(editable)
        self.desc_input.setEnabled(editable)
        self.prompt_input.setReadOnly(not editable)
        self.leader_cb.setEnabled(editable)
        self.avatar_button.setEnabled(editable)
        for cb in self._builtin_tool_checks.values():
            cb.setEnabled(editable)
        for cb in self._mcp_tool_checks.values():
            cb.setEnabled(editable)
        self.save_btn.setEnabled(editable)
        self.delete_btn.setEnabled(editable)
        self.builtin_banner.setVisible(definition.built_in)

    # ------------------------------------------------------------------
    # Avatar picker toggle
    # ------------------------------------------------------------------

    def _toggle_avatar_picker(self) -> None:
        self.avatar_picker.setVisible(not self.avatar_picker.isVisible())

    def _on_avatar_picked(self, icon: str) -> None:
        self._current_icon = icon
        apply_to_button(self.avatar_button, icon, size=54)
        self.avatar_picker.setVisible(False)

    # ------------------------------------------------------------------
    # Save / delete / duplicate
    # ------------------------------------------------------------------

    def _gather(self) -> AgentDefinition:
        name = self.name_input.text().strip()
        return AgentDefinition(
            name=name,
            description=self.desc_input.text().strip(),
            icon=self._current_icon,
            system_prompt=self.prompt_input.toPlainText().strip(),
            tool_allowlist=[
                n for n, cb in self._builtin_tool_checks.items() if cb.isChecked()
            ],
            mcp_allowlist=[
                n for n, cb in self._mcp_tool_checks.items() if cb.isChecked()
            ],
            default_model_id=self.model_picker.current_id(),
            can_dispatch=self.leader_cb.isChecked(),
            default_temperature=(self._current.default_temperature if self._current else 0.4),
            built_in=False,
            created_at=(self._current.created_at if self._current else ""),
        )

    def _on_save(self) -> None:
        if self._current is None:
            return
        d = self._gather()
        if not d.name:
            QMessageBox.warning(self, "Save", "Name is required.")
            return
        try:
            save_custom(d)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "Save", str(exc))
            return
        self.saved.emit(d.name)

    def _on_delete(self) -> None:
        if self._current is None or self._current.built_in:
            return
        if QMessageBox.question(
            self,
            "Delete",
            f"Delete custom agent '{self._current.name}'? This cannot be undone.",
        ) != QMessageBox.Yes:
            return
        if delete_custom(self._current.name):
            self.deleted.emit(self._current.name)

    def _on_duplicate(self) -> None:
        if self._current is None:
            return
        # Suggest a unique name: source-copy, source-copy-2, …
        base = f"{self._current.name}-copy"
        existing = set(list_all_definitions().keys())
        candidate = base
        i = 2
        while candidate in existing:
            candidate = f"{base}-{i}"
            i += 1
        try:
            new_def = duplicate(self._current.name, candidate)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "Duplicate", str(exc))
            return
        self.saved.emit(new_def.name)


# ---------------------------------------------------------------------------
# Page
# ---------------------------------------------------------------------------


class AgentStudioPage(QWidget):
    # Emitted whenever the catalogue of agent definitions changes
    # (save / delete / duplicate). The host wires this up so other
    # pages (AgentsPage in particular) can refresh their cached views
    # without us reaching into them directly.
    definitions_changed = Signal()

    # QSettings key for the "I dismissed the first-run banner" flag.
    _ONBOARDING_DISMISSED_KEY = "studio/skill_library_onboarding_dismissed"

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self._build_ui()
        self._reload_gallery()
        self._maybe_show_onboarding()

    def _build_ui(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(20, 16, 20, 20)
        outer.setSpacing(12)

        # Header.
        title = QLabel("Studio")
        tf = QFont()
        tf.setPointSize(22)
        tf.setBold(True)
        title.setFont(tf)
        title.setStyleSheet("color:#fff; background:transparent;")
        outer.addWidget(title)

        sub = QLabel(
            "Design agents — pick an avatar, a job, the tools they get to use. "
            "Built-ins ship with OWLLM and can't be edited; click <b>Duplicate</b> "
            "on any built-in to make your own customizable copy."
        )
        sub.setWordWrap(True)
        sub.setStyleSheet("color:#9aa0a6; font-size:12px;")
        outer.addWidget(sub)

        # First-run onboarding banner — hidden until _maybe_show_onboarding
        # decides to surface it. Sits above the action row so it's the first
        # call-to-action a new user sees, but it never blocks the workflow:
        # one click on the X dismisses it permanently.
        self.onboarding_banner = QFrame()
        self.onboarding_banner.setVisible(False)
        self.onboarding_banner.setStyleSheet(
            "QFrame { background:qlineargradient("
            "x1:0,y1:0,x2:1,y2:0, stop:0 #2a3a6a, stop:1 #1f2a4a);"
            " border:none; border-radius:10px; }"
        )
        ob = QHBoxLayout(self.onboarding_banner)
        ob.setContentsMargins(14, 10, 8, 10)
        ob.setSpacing(10)
        msg = QLabel(
            "👋  <b>New here?</b> Install Anthropic's official skill pack "
            "(PDF, Excel, Word helpers — drop-in compatible) to give your "
            "agents pro-grade capabilities out of the box."
        )
        msg.setWordWrap(True)
        msg.setStyleSheet("color:#dde3ff; background:transparent; font-size:12px;")
        ob.addWidget(msg, 1)
        open_btn = QPushButton("Open Skill Library")
        open_btn.setStyleSheet(
            "QPushButton { background:#4a6cff; color:white; border:none;"
            " border-radius:8px; padding:6px 14px; font-weight:600; }"
            "QPushButton:hover { background:#5a7bff; }"
        )
        open_btn.clicked.connect(self._on_onboarding_open_clicked)
        ob.addWidget(open_btn)
        dismiss_btn = QPushButton("✕")
        dismiss_btn.setFixedSize(28, 28)
        dismiss_btn.setToolTip("Don't show again")
        dismiss_btn.setStyleSheet(
            "QPushButton { background:transparent; color:#dde3ff;"
            " border:none; font-size:14px; }"
            "QPushButton:hover { color:#fff; }"
        )
        dismiss_btn.clicked.connect(self._dismiss_onboarding)
        ob.addWidget(dismiss_btn)
        outer.addWidget(self.onboarding_banner)

        # Action row.
        actions = QHBoxLayout()
        actions.setSpacing(8)
        self.new_btn = QPushButton("+ New custom agent")
        self.new_btn.setMinimumHeight(34)
        self.new_btn.setStyleSheet(_PRIMARY_BTN_STYLE)
        self.new_btn.clicked.connect(self._on_new_clicked)
        actions.addWidget(self.new_btn)

        self.library_btn = QPushButton("📚 Skill Library")
        self.library_btn.setMinimumHeight(34)
        self.library_btn.setStyleSheet(_GHOST_BTN_STYLE)
        self.library_btn.setToolTip(
            "Browse and install community SKILL.md packs (Anthropic skills, etc.)"
        )
        self.library_btn.clicked.connect(self._on_library_clicked)
        actions.addWidget(self.library_btn)
        actions.addStretch(1)
        self.refresh_btn = QPushButton("⟳")
        self.refresh_btn.setFixedSize(34, 34)
        self.refresh_btn.setStyleSheet(_GHOST_BTN_STYLE)
        self.refresh_btn.clicked.connect(self._reload_gallery)
        actions.addWidget(self.refresh_btn)
        outer.addLayout(actions)

        # Splitter: gallery left, editor right.
        splitter = QSplitter(Qt.Horizontal)
        splitter.setHandleWidth(8)

        # Gallery (scroll area is fine here — list of cards can grow).
        gallery_host = QScrollArea()
        gallery_host.setWidgetResizable(True)
        gallery_host.setFrameShape(QFrame.NoFrame)
        gallery_host.setStyleSheet("QScrollArea { background:transparent; border:none; }")
        self.gallery_widget = QWidget()
        self.gallery_layout = QVBoxLayout(self.gallery_widget)
        self.gallery_layout.setContentsMargins(0, 0, 0, 0)
        self.gallery_layout.setSpacing(10)
        self.gallery_layout.addStretch(1)  # keep cards top-aligned
        gallery_host.setWidget(self.gallery_widget)
        splitter.addWidget(gallery_host)

        # Editor.
        self.editor = _EditorPanel()
        self.editor.saved.connect(self._on_saved)
        self.editor.deleted.connect(self._on_deleted)
        splitter.addWidget(self.editor)

        splitter.setStretchFactor(0, 1)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([400, 600])
        outer.addWidget(splitter, 1)

    # ------------------------------------------------------------------
    # Gallery refresh
    # ------------------------------------------------------------------

    def _reload_gallery(self, select: Optional[str] = None) -> None:
        # Clear existing cards (keep the trailing stretch).
        while self.gallery_layout.count() > 1:
            item = self.gallery_layout.takeAt(0)
            w = item.widget()
            if w is not None:
                w.deleteLater()

        defs = list_all_definitions()
        # Order: built-ins first (alphabetical), then customs.
        ordered = sorted(
            defs.values(),
            key=lambda d: (0 if d.built_in else 1, d.name.lower()),
        )
        first_name = None
        for d in ordered:
            card = _GalleryCard(d)
            card.clicked.connect(self._on_card_clicked)
            self.gallery_layout.insertWidget(self.gallery_layout.count() - 1, card)
            if first_name is None:
                first_name = d.name

        target = select or first_name
        if target and target in defs:
            self.editor.load(defs[target])

    # ------------------------------------------------------------------
    # Slots
    # ------------------------------------------------------------------

    @Slot(str)
    def _on_card_clicked(self, name: str) -> None:
        d = list_all_definitions().get(name)
        if d is None:
            return
        self.editor.load(d)

    @Slot(str)
    def _on_saved(self, name: str) -> None:
        self._reload_gallery(select=name)
        self.definitions_changed.emit()

    @Slot(str)
    def _on_deleted(self, name: str) -> None:
        self._reload_gallery()
        self.definitions_changed.emit()

    def _on_library_clicked(self) -> None:
        dlg = SkillLibraryDialog(self)
        dlg.exec()
        if dlg.changed_anything():
            self._reload_gallery()
            # If they actually installed something, hide the banner —
            # they've graduated past the onboarding state.
            self.onboarding_banner.setVisible(False)

    # ------------------------------------------------------------------
    # First-run onboarding
    # ------------------------------------------------------------------

    def _maybe_show_onboarding(self) -> None:
        """Show the 'install Anthropic skills' banner on first run.

        Triggers when (a) no remote skills are installed yet AND (b) the
        user hasn't dismissed it before. Once dismissed, never shown again
        for this user (QSettings persists the flag in the OS-native store).
        """
        try:
            from core.agents.skill_sources import list_installed_remote_folders
        except Exception:  # noqa: BLE001
            return
        settings = QSettings()
        if settings.value(self._ONBOARDING_DISMISSED_KEY, False, type=bool):
            return
        if list_installed_remote_folders():
            # Already has remote skills — don't badger them.
            return
        self.onboarding_banner.setVisible(True)

    def _on_onboarding_open_clicked(self) -> None:
        # The Open button leaves the banner up — if they install nothing,
        # the banner reappears next session, which is the desired nudge.
        self._on_library_clicked()

    def _dismiss_onboarding(self) -> None:
        QSettings().setValue(self._ONBOARDING_DISMISSED_KEY, True)
        self.onboarding_banner.setVisible(False)

    def _on_new_clicked(self) -> None:
        # New customs are always seeded from a sensible default (the
        # researcher template — read-only, simple, easy to customise).
        # Suggest a unique name and bump the editor.
        defs = list_all_definitions()
        base = "new-agent"
        candidate = base
        i = 2
        while candidate in defs:
            candidate = f"{base}-{i}"
            i += 1
        seed = AgentDefinition(
            name=candidate,
            description="A custom agent — click Save to keep.",
            icon="🦊",
            system_prompt="You are a helpful agent. Reply concisely.",
            tool_allowlist=["read_file", "list_dir"],
            mcp_allowlist=[],
            default_model_id="",
            can_dispatch=False,
            default_temperature=0.4,
            built_in=False,
        )
        try:
            save_custom(seed)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "New agent", str(exc))
            return
        self._reload_gallery(select=candidate)


# ---------------------------------------------------------------------------
# Style snippets
# ---------------------------------------------------------------------------


def _section_label(text: str) -> QLabel:
    lbl = QLabel(text)
    lbl.setStyleSheet(
        "color:#9aa0a6; font-size:11px; font-weight:600; "
        "letter-spacing:0.6px; text-transform:uppercase; "
        "background:transparent; margin-top:4px;"
    )
    return lbl


_INPUT_STYLE = """
    QLineEdit {
        background:#14171d; color:#fff; border:none;
        border-radius:8px; padding:0 12px; font-size:13px;
    }
    QLineEdit:focus { background:#1a1d24; }
    QLineEdit:disabled { color:#888; background:#101218; }
"""

_INPUT_STYLE_TEXTAREA = """
    QTextEdit {
        background:#14171d; color:#fff; border:none;
        border-radius:8px; padding:8px 12px; font-size:13px;
    }
    QTextEdit:focus { background:#1a1d24; }
"""

_TOOLBOX_STYLE = """
    QFrame {
        background:#14171d; border:none; border-radius:8px;
    }
    QCheckBox { background:transparent; }
"""

_PRIMARY_BTN_STYLE = """
    QPushButton {
        background:#4a6cff; color:white; border:none;
        border-radius:8px; padding:0 20px; font-weight:600;
    }
    QPushButton:hover { background:#5a7bff; }
    QPushButton:disabled { background:#2c313c; color:#777; }
"""

_GHOST_BTN_STYLE = """
    QPushButton {
        background:rgba(255,255,255,0.05); color:#dadcdf;
        border:none; border-radius:8px; padding:0 14px;
    }
    QPushButton:hover { background:rgba(255,255,255,0.10); }
"""

_DESTRUCTIVE_BTN_STYLE = """
    QPushButton {
        background:rgba(255,140,140,0.12); color:#ff8c8c;
        border:none; border-radius:8px; padding:0 14px;
    }
    QPushButton:hover { background:rgba(255,140,140,0.24); }
    QPushButton:disabled { color:#555; background:transparent; }
"""
