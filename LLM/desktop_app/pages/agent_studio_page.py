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
    QComboBox,
    QDialog,
    QFrame,
    QGraphicsDropShadowEffect,
    QGridLayout,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QSpinBox,
    QSplitter,
    QStackedWidget,
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
from core.agents.projects import get_project_store
from core.agents.teams import (
    Template,
    all_templates,
    delete_custom_template,
    instantiate_template,
)
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
from desktop_app.widgets.team_builder_dialog import TeamBuilderDialog
from desktop_app.widgets.team_grid_view import TeamDetailPanel, TeamGridView

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


def _wrappable(text: str) -> str:
    """Inject zero-width spaces after `_ - . / \\ ` so QLabel wraps even
    unbroken identifiers. Without this a name like
    ``anthropic-deep-research-agent`` is treated as one word and pushes
    the card wider than its grid column → horizontal scrollbar in the
    gallery / editor scroll area.
    """
    out = []
    for ch in text or "":
        out.append(ch)
        if ch in "_-./\\ ":
            out.append("​")
    return "".join(out)


_ACRONYMS = {"ux", "ui", "api", "mcp", "gpu", "be", "fe", "qa", "cli", "sql", "db"}


def _display_label(full_name: str) -> str:
    """Humanize an agent definition name (mirrors agent_canvas._display_label)."""
    short = (full_name or "").rsplit(".", 1)[-1]
    if not short:
        return full_name
    words = []
    for w in short.replace("-", "_").split("_"):
        w = w.strip()
        if not w:
            continue
        words.append(w.upper() if w.lower() in _ACRONYMS else w.capitalize())
    return " ".join(words) or full_name


# ---------------------------------------------------------------------------
# Gallery card
# ---------------------------------------------------------------------------


class _GalleryCard(QFrame):
    """One agent in the gallery — click to open the editor."""

    clicked = Signal(str)  # agent name

    def __init__(
        self,
        definition: AgentDefinition,
        parent: Optional[QWidget] = None,
        *,
        is_skill: bool = False,
    ) -> None:
        super().__init__(parent)
        self.definition = definition
        self.is_skill = is_skill

        self.setObjectName("GalleryCard")
        self.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Fixed)
        # FIXED height so cards in the same row are guaranteed equal —
        # without this, a card whose description wraps to 4 lines drags
        # its left/right neighbour up and produces uneven gaps between
        # rows (the gripe in the screenshot). Long descriptions are
        # elided below. Height bumped from 118 → 140 so wrapped agent
        # names (long skill ids) get a second line without clipping.
        self.setFixedHeight(140)
        self.setCursor(Qt.PointingHandCursor)

        # Built-ins and installed skills share the blue left accent so
        # they read as "shipped / installed" together; pure custom
        # agents get the neutral accent.
        accent = "#4a6cff" if (definition.built_in or is_skill) else "#7a8a9c"
        self.setStyleSheet(f"""
            QFrame#GalleryCard {{
                background: qlineargradient(
                    x1:0, y1:0, x2:0, y2:1,
                    stop:0 palette(alternate-base), stop:1 palette(alternate-base)
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
        name_label = QLabel(_wrappable(_display_label(definition.name)))
        nf = QFont()
        nf.setPointSize(14)
        nf.setBold(True)
        name_label.setFont(nf)
        name_label.setStyleSheet("color:#fff; background:transparent;")
        # Wrap long unbroken names (skill ids etc.) onto a second line
        # instead of pushing the card past its grid column. ``Ignored``
        # width policy lets the label shrink to whatever space the row
        # gives it without forcing the gallery host wider.
        name_label.setWordWrap(True)
        name_label.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Preferred)
        name_label.setMaximumHeight(50)
        name_row.addWidget(name_label, 1)

        if definition.built_in:
            badge = QLabel("BUILT-IN")
            badge.setStyleSheet(
                "color:#7989ff; background:rgba(121,137,255,0.15); "
                "border-radius:6px; padding:2px 8px; font-size:10px; "
                "font-weight:600; letter-spacing:0.6px;"
            )
            name_row.addWidget(badge)
        elif is_skill:
            # Anthropic-library / community SKILL.md installs read as
            # "built-in" in the gallery (left column, blue accent) but
            # carry their own SKILL badge so the user can still tell
            # them apart from the OWLLM-shipped roles.
            badge = QLabel("SKILL")
            badge.setStyleSheet(
                "color:#7ad3ff; background:rgba(122,211,255,0.15); "
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
        # Cap to ~2 lines so the card never grows past its fixed height.
        desc.setMaximumHeight(40)
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
            "QFrame#AvatarPicker { background:palette(base); border:none; border-radius:10px; }"
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
            "QFrame#EditorPanel { background:palette(base); border:none; border-radius:12px; }"
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
        # Never paint a horizontal scrollbar — the editor column is wide
        # enough; any horizontal overflow comes from non-shrinkable
        # children (model picker, voice combo) and we'd rather elide them
        # than make the user scroll left/right.
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        scroll.setStyleSheet("QScrollArea { background:transparent; border:none; }")
        host = QWidget()
        outer = QVBoxLayout(host)
        outer.setContentsMargins(20, 20, 20, 20)
        outer.setSpacing(14)

        # Header — large 240×240 avatar + name field stacked beside it.
        header_row = QHBoxLayout()
        header_row.setSpacing(18)
        self.avatar_button = QPushButton("🤖")
        self.avatar_button.setFixedSize(240, 240)
        self.avatar_button.setIconSize(QSize(220, 220))
        self.avatar_button.setStyleSheet("""
            QPushButton {
                background: rgba(255,255,255,0.10);
                border: 1px solid rgba(255,255,255,0.12);
                border-radius: 18px;
                color: #ffffff;
                font-size: 120px;
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
        nf.setPointSize(13)
        nf.setBold(True)
        nf2 = QFont()
        nf2.setPointSize(13)
        lbl_n = QLabel("Name")
        lbl_n.setFont(nf2)
        lbl_n.setStyleSheet("color:#9aa0a6; background:transparent; font-size:13px;")
        name_box.addWidget(lbl_n)
        self.name_input = QLineEdit()
        self.name_input.setMinimumHeight(40)
        self.name_input.setStyleSheet(_INPUT_STYLE)
        name_box.addWidget(self.name_input)

        # Default model — sits straight under the agent name in the
        # right header column, so the two key identity fields (who the
        # agent is + what model runs it) are visible together at the
        # top of the editor.
        lbl_m = QLabel("Default model")
        lbl_m.setFont(nf2)
        lbl_m.setStyleSheet("color:#9aa0a6; background:transparent; font-size:13px;")
        name_box.addWidget(lbl_m)
        self.model_picker = ModelPickerButton()
        # Long composite labels (e.g. "Local: meta-llama/Meta-Llama-3-8B
        # -Instruct") would otherwise force the QPushButton's sizeHint to
        # exceed the column width and push the QScrollArea host wider →
        # horizontal scrollbar. Ignored width policy lets it shrink to
        # whatever the column allows.
        self.model_picker.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Fixed)
        self.model_picker.refresh_entries()
        # Real-time persist: when the user picks a new model the
        # selection is written to the definition and saved immediately,
        # without needing to hit the Save button.
        self.model_picker.selection_changed.connect(self._on_model_changed)
        name_box.addWidget(self.model_picker)

        # Voice — directly under the model picker, inside the same
        # right header column so the user sees Name / Model / Voice
        # stacked next to the avatar.
        lbl_v = QLabel("Voice")
        lbl_v.setFont(nf2)
        lbl_v.setStyleSheet("color:#9aa0a6; background:transparent; font-size:13px;")
        name_box.addWidget(lbl_v)

        self.voice_enabled_cb = QCheckBox("Speak this agent's replies aloud")
        self.voice_enabled_cb.setStyleSheet("color:#dadcdf; font-size:13px;")
        name_box.addWidget(self.voice_enabled_cb)

        v_row = QHBoxLayout()
        v_row.setSpacing(8)
        self.voice_combo = QComboBox()
        self.voice_combo.setMinimumHeight(32)
        # Same shrink-don't-push policy as the model picker — long voice
        # ids ("Microsoft Zira Desktop - English (United States)") must
        # not widen the editor column.
        self.voice_combo.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Fixed)
        self.voice_combo.setStyleSheet(
            "QComboBox { background:palette(base); color:#fff; border:none; "
            "border-radius:8px; padding:0 10px; font-size:13px; } "
            "QComboBox::drop-down { border:none; }"
        )
        self.voice_combo.addItem("Auto (per-agent assignment)", "")
        v_row.addWidget(self.voice_combo, 1)

        self.voice_rate_spin = QSpinBox()
        self.voice_rate_spin.setRange(0, 400)
        self.voice_rate_spin.setSingleStep(10)
        self.voice_rate_spin.setSuffix(" wpm")
        self.voice_rate_spin.setSpecialValueText("Default")
        self.voice_rate_spin.setMinimumHeight(32)
        self.voice_rate_spin.setFixedWidth(110)
        self.voice_rate_spin.setStyleSheet(
            "QSpinBox { background:palette(base); color:#fff; border:none; "
            "border-radius:8px; padding:0 10px; font-size:13px; }"
        )
        v_row.addWidget(self.voice_rate_spin)

        self.voice_preview_btn = QPushButton("▶")
        self.voice_preview_btn.setFixedSize(32, 32)
        self.voice_preview_btn.setToolTip("Preview this voice")
        self.voice_preview_btn.setStyleSheet(_GHOST_BTN_STYLE)
        self.voice_preview_btn.clicked.connect(self._on_voice_preview)
        v_row.addWidget(self.voice_preview_btn)

        name_box.addLayout(v_row)

        name_box.addStretch(1)
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
        self.desc_input.setMinimumHeight(40)
        self.desc_input.setStyleSheet(_INPUT_STYLE)
        outer.addWidget(self.desc_input)

        # System prompt.
        outer.addWidget(_section_label("System prompt"))
        self.prompt_input = QTextEdit()
        self.prompt_input.setMinimumHeight(180)
        self.prompt_input.setStyleSheet(_INPUT_STYLE_TEXTAREA)
        outer.addWidget(self.prompt_input)

        # Built-in tools — 3-column grid so the list stays compact even
        # as the registry grows.
        outer.addWidget(_section_label("Built-in tools"))
        self._builtin_tools_box = QFrame()
        self._builtin_tools_box.setStyleSheet(_TOOLBOX_STYLE)
        bt_layout = QGridLayout(self._builtin_tools_box)
        bt_layout.setContentsMargins(12, 10, 12, 10)
        bt_layout.setHorizontalSpacing(14)
        bt_layout.setVerticalSpacing(6)
        bt_cols = 3
        for col in range(bt_cols):
            bt_layout.setColumnStretch(col, 1)
        for i, tool_name in enumerate(_list_builtin_tool_names()):
            cb = QCheckBox(tool_name)
            cb.setStyleSheet("color:#dadcdf; font-size:14px;")
            cb.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Fixed)
            self._builtin_tool_checks[tool_name] = cb
            bt_layout.addWidget(cb, i // bt_cols, i % bt_cols)
        outer.addWidget(self._builtin_tools_box)

        # MCP tools.
        outer.addWidget(_section_label("MCP tools (from connected servers)"))
        self._mcp_tools_box = QFrame()
        self._mcp_tools_box.setStyleSheet(_TOOLBOX_STYLE)
        mt_layout = QVBoxLayout(self._mcp_tools_box)
        mt_layout.setContentsMargins(12, 10, 12, 10)
        mt_layout.setSpacing(6)
        mcp_names = _list_mcp_tool_names()
        if mcp_names:
            for tool_name in mcp_names:
                cb = QCheckBox(tool_name)
                cb.setStyleSheet("color:#dadcdf; font-size:14px;")
                cb.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Fixed)
                self._mcp_tool_checks[tool_name] = cb
                mt_layout.addWidget(cb)
        else:
            empty = QLabel(
                "No MCP servers connected. Configure them in the 🧩 MCP tab."
            )
            empty.setStyleSheet("color:#9aa0a6; font-size:13px; font-style:italic;")
            mt_layout.addWidget(empty)
        outer.addWidget(self._mcp_tools_box)

        # Leader checkbox.
        self.leader_cb = QCheckBox(
            "Team leader — can dispatch work to other agents"
        )
        self.leader_cb.setStyleSheet("color:#dadcdf; font-size:14px;")
        outer.addWidget(self.leader_cb)

        outer.addStretch(1)

        # Action buttons.
        btn_row = QHBoxLayout()
        btn_row.setSpacing(8)
        self.save_btn = QPushButton("Save")
        self.save_btn.setMinimumHeight(42)
        self.save_btn.setStyleSheet(_PRIMARY_BTN_STYLE)
        self.save_btn.clicked.connect(self._on_save)
        self.duplicate_btn = QPushButton("Duplicate")
        self.duplicate_btn.setMinimumHeight(42)
        self.duplicate_btn.setStyleSheet(_GHOST_BTN_STYLE)
        self.duplicate_btn.clicked.connect(self._on_duplicate)
        self.delete_btn = QPushButton("Delete")
        self.delete_btn.setMinimumHeight(42)
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
            "border-radius:8px; padding:8px 12px; font-size:13px;"
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
        apply_to_button(self.avatar_button, self._current_icon, size=220)
        self.avatar_picker.setVisible(False)
        self.name_input.setText(definition.name)
        self.desc_input.setText(definition.description)
        self.prompt_input.setPlainText(definition.system_prompt)
        if definition.default_model_id:
            self.model_picker.set_current_id(definition.default_model_id)
        self.leader_cb.setChecked(definition.can_dispatch)

        # Voice — populate the combo from the running service on first
        # load so we don't pay the SAPI enumeration cost at page-build
        # time. Skip if the service is unavailable (Linux without espeak,
        # for instance).
        self._populate_voice_combo_if_needed()
        self.voice_enabled_cb.setChecked(definition.voice_enabled)
        self.voice_rate_spin.setValue(int(definition.voice_rate or 0))
        # Find the entry matching this agent's voice_id; default to "Auto".
        idx = 0
        for i in range(self.voice_combo.count()):
            if self.voice_combo.itemData(i) == definition.voice_id:
                idx = i
                break
        self.voice_combo.setCurrentIndex(idx)

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
        self.voice_enabled_cb.setEnabled(editable)
        self.voice_combo.setEnabled(editable)
        self.voice_rate_spin.setEnabled(editable)
        # Preview is allowed even on built-ins so the user can audition
        # voices before duplicating to customise.
        # Keep the avatar button ENABLED even for built-ins so Qt
        # doesn't render the icon at 50% opacity. _toggle_avatar_picker
        # already no-ops when the current def is a built-in.
        self.avatar_button.setEnabled(True)
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
        # Built-in agents are immutable — clicking the avatar shouldn't
        # open the picker (would let the user pick a new icon and then
        # silently drop it on Save since save_custom is disabled).
        if self._current is not None and self._current.built_in:
            return
        self.avatar_picker.setVisible(not self.avatar_picker.isVisible())

    def _on_avatar_picked(self, icon: str) -> None:
        self._current_icon = icon
        apply_to_button(self.avatar_button, icon, size=220)
        self.avatar_picker.setVisible(False)

    # ------------------------------------------------------------------
    # Real-time model save
    # ------------------------------------------------------------------

    def _on_model_changed(self, composite_id: str) -> None:
        """Persist the new model the moment the user picks one.

        Built-ins are read-only by design — the picker selection just
        sits in the widget until the user duplicates the agent. For
        custom (and skill-backed) defs we re-gather the form, swap in
        the new ``default_model_id``, and call ``save_custom`` so the
        change survives a reload without needing the Save button.
        """
        if self._current is None or self._current.built_in:
            return
        if not composite_id:
            return
        try:
            d = self._gather()
            d.default_model_id = composite_id
            save_custom(d)
            self._current = d
            self.saved.emit(d.name)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "could not auto-save model selection for %s: %s",
                getattr(self._current, "name", "?"), exc,
            )

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
            voice_id=str(self.voice_combo.currentData() or ""),
            voice_rate=int(self.voice_rate_spin.value()),
            voice_enabled=self.voice_enabled_cb.isChecked(),
            built_in=False,
            created_at=(self._current.created_at if self._current else ""),
        )

    # ------------------------------------------------------------------
    # Voice helpers
    # ------------------------------------------------------------------

    def _offer_install_voice(self) -> bool:
        """Offer a one-click pip install of pyttsx3. Returns True on
        success so the caller can retry the action that triggered this."""
        if QMessageBox.question(
            self,
            "Install voice",
            "Voice output needs the pyttsx3 package (one-time install,"
            " ~50 KB, no model download).\n\nInstall it now?",
        ) != QMessageBox.Yes:
            return False
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
            return False
        if proc.returncode != 0:
            QMessageBox.warning(
                self, "Install voice",
                f"pip install failed (exit {proc.returncode}).\n\n"
                f"{(proc.stderr or '').strip()[:600]}",
            )
            return False
        try:
            import core.voice.tts_service as svc_mod
            svc_mod._service = None  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            pass
        return True

    def _populate_voice_combo_if_needed(self) -> None:
        """Lazy-load the voice list. The combo is built with one "Auto"
        item; on first edit we ask the running TTS service what voices
        the OS has installed and append them. Done once per panel
        lifetime — adding a new voice on the OS side requires a restart,
        which matches every other voice-enumerating app."""
        # Detect by item count: 1 = the placeholder we built, anything
        # more means we already populated.
        if self.voice_combo.count() > 1:
            return
        try:
            from core.voice import get_tts_service
            svc = get_tts_service()
        except Exception:  # noqa: BLE001
            return
        if not svc.available:
            self.voice_combo.setEnabled(False)
            self.voice_combo.setToolTip(
                "Voice unavailable — system TTS engine not detected"
            )
            return
        for v in svc.voices():
            label = v.name or v.id.split("\\")[-1]
            self.voice_combo.addItem(label, v.id)

    def _on_voice_preview(self) -> None:
        """Speak a sample line in the currently selected voice. Reaches
        for the running service rather than spinning up a fresh engine
        so the preview goes through the same audio path the live agent
        replies will. If the engine isn't installed yet, offer a one-click
        pip install instead of bailing out with a dead-end alert."""
        try:
            from core.voice import get_tts_service
            svc = get_tts_service()
        except Exception as exc:  # noqa: BLE001
            QMessageBox.information(self, "Voice", f"Voice unavailable: {exc}")
            return
        if not svc.available:
            if self._offer_install_voice():
                # Re-fetch the service after install — module cache reset.
                try:
                    from core.voice import get_tts_service as _rebuild
                    svc = _rebuild()
                except Exception:  # noqa: BLE001
                    return
                if not svc.available:
                    return
                self._populate_voice_combo_if_needed()
            else:
                return
        voice_id = str(self.voice_combo.currentData() or "")
        if not voice_id and self._current is not None:
            # "Auto" — show the user what the auto-assignment lands on.
            voice_id = svc.stable_voice_for(self._current.name)
        rate = int(self.voice_rate_spin.value())
        name = _display_label(self._current.name) if self._current else "Agent"
        sample = f"Hi, I'm {name}. This is what my voice sounds like."
        # Bypass the page-level mute: the user explicitly asked to preview.
        was_enabled = svc.enabled
        try:
            svc.set_enabled(True)
            svc.speak(sample, voice_id=voice_id, rate=rate)
        finally:
            svc.set_enabled(was_enabled)

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
            f"Delete custom agent '{_display_label(self._current.name)}'? This cannot be undone.",
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

    # Emitted when a new project is spawned from a team template here.
    # Payload: project id. Main wires it to switch to the Agents tab
    # and select the freshly-created project so the user lands on the
    # workspace with the team already loaded.
    project_created = Signal(str)

    # QSettings key for the "I dismissed the first-run banner" flag.
    _ONBOARDING_DISMISSED_KEY = "studio/skill_library_onboarding_dismissed"
    # QSettings key for which top tab (Teams / Agents) was last open.
    _ACTIVE_VIEW_KEY = "studio/active_view"  # "teams" | "agents"

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self._settings = QSettings("LocaLLM", "agents")
        self._build_ui()
        self._reload_gallery()
        self._reload_teams()
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

        # Top view toggle: Teams | Agents. Teams is the default landing
        # view — most users design *projects* (a kind of work), not
        # individual agents in isolation, so the team catalogue is the
        # right first impression. Agents stays one click away for power
        # users who want to design custom personas.
        outer.addLayout(self._build_view_toggle())

        # Sub-label is rebuilt per view so the prose matches what's on
        # screen (kept as an attribute so _on_view_toggle_changed can
        # swap the text without rebuilding the layout).
        self.sub_label = QLabel("")
        self.sub_label.setWordWrap(True)
        self.sub_label.setStyleSheet("color:#9aa0a6; font-size:12px;")
        outer.addWidget(self.sub_label)

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

        # Stacked view: Teams (index 0, default) | Agents (index 1).
        # Both views fill the remaining vertical space; the toggle at
        # the top of the page flips between them.
        self._view_stack = QStackedWidget()
        self._view_stack.addWidget(self._build_teams_view())   # 0
        self._view_stack.addWidget(self._build_agents_view())  # 1
        outer.addWidget(self._view_stack, 1)

        # Restore the previously-active view (defaults to Teams) and
        # sync the toggle button + sub-label text.
        prev = str(self._settings.value(self._ACTIVE_VIEW_KEY, "teams") or "teams")
        self._set_view(prev if prev in ("teams", "agents") else "teams")

    # ------------------------------------------------------------------
    # View toggle (Teams / Agents)
    # ------------------------------------------------------------------

    def _build_view_toggle(self) -> "QHBoxLayout":
        row = QHBoxLayout()
        row.setSpacing(0)
        row.setContentsMargins(0, 4, 0, 4)

        self.teams_tab_btn = QPushButton("🧩 Teams")
        self.teams_tab_btn.setCheckable(True)
        self.teams_tab_btn.setMinimumHeight(36)
        self.teams_tab_btn.setStyleSheet(_VIEW_TAB_LEFT_STYLE)
        self.teams_tab_btn.clicked.connect(lambda: self._set_view("teams"))
        row.addWidget(self.teams_tab_btn)

        self.agents_tab_btn = QPushButton("🤖 Agents")
        self.agents_tab_btn.setCheckable(True)
        self.agents_tab_btn.setMinimumHeight(36)
        self.agents_tab_btn.setStyleSheet(_VIEW_TAB_RIGHT_STYLE)
        self.agents_tab_btn.clicked.connect(lambda: self._set_view("agents"))
        row.addWidget(self.agents_tab_btn)

        row.addStretch(1)
        return row

    def _set_view(self, view: str) -> None:
        is_teams = (view == "teams")
        self._view_stack.setCurrentIndex(0 if is_teams else 1)
        self.teams_tab_btn.setChecked(is_teams)
        self.agents_tab_btn.setChecked(not is_teams)
        if is_teams:
            self.sub_label.setText(
                "Pick a team template — pre-built collections of agents wired "
                "to do a kind of work (Secretary, Bug Hunter, Research Lab, …). "
                "One click spawns a project with the team ready to run."
            )
        else:
            self.sub_label.setText(
                "Design individual agents — pick an avatar, a job, the tools "
                "they get to use. Built-ins ship with OWLLM and can't be edited; "
                "click <b>Duplicate</b> on any built-in to make your own copy."
            )
        self._settings.setValue(self._ACTIVE_VIEW_KEY, view)

    # ------------------------------------------------------------------
    # Teams view
    # ------------------------------------------------------------------

    def _build_teams_view(self) -> QWidget:
        wrap = QWidget()
        wrap.setStyleSheet("background:transparent;")
        v = QVBoxLayout(wrap)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(10)

        # Splitter: grid (left, 60%) | detail panel (right, 40%).
        splitter = QSplitter(Qt.Horizontal)
        splitter.setHandleWidth(8)

        self.team_grid = TeamGridView()
        self.team_grid.team_selected.connect(self._on_team_selected)
        self.team_grid.create_team_requested.connect(self._on_create_team_requested)
        splitter.addWidget(self.team_grid)

        self.team_detail = TeamDetailPanel()
        self.team_detail.create_project_requested.connect(self._on_create_project_from_template)
        self.team_detail.delete_template_requested.connect(self._on_delete_custom_template)
        splitter.addWidget(self.team_detail)

        splitter.setStretchFactor(0, 6)
        splitter.setStretchFactor(1, 4)
        splitter.setSizes([720, 480])
        v.addWidget(splitter, 1)
        return wrap

    def _reload_teams(self, select: Optional[str] = None) -> None:
        templates = all_templates()
        self.team_grid.set_templates(templates)
        if select and select in templates:
            self.team_grid.set_selected(select)
            self.team_detail.show_template(templates[select])
        else:
            # Clear the detail panel — a fresh load starts with no
            # selection so the user reads the catalogue first.
            self.team_grid.set_selected(None)
            self.team_detail.show_template(None)

    @Slot(str)
    def _on_team_selected(self, name: str) -> None:
        templates = all_templates()
        self.team_detail.show_template(templates.get(name))

    @Slot()
    def _on_create_team_requested(self) -> None:
        dlg = TeamBuilderDialog(self)
        if dlg.exec() != QDialog.Accepted or dlg.saved_template is None:
            return
        new_name = dlg.saved_template.name
        self._reload_teams(select=new_name)

    @Slot(str)
    def _on_create_project_from_template(self, template_name: str) -> None:
        templates = all_templates()
        tpl = templates.get(template_name)
        if tpl is None:
            return
        suggested = tpl.humanized_name()
        name, ok = QInputDialog.getText(
            self,
            "New project",
            f"Project name (from {tpl.humanized_name()}):",
            text=suggested,
        )
        if not ok or not name.strip():
            return
        try:
            proj = instantiate_template(
                tpl, project_name=name.strip(),
                project_store=get_project_store(),
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("could not instantiate template %s", template_name)
            QMessageBox.critical(
                self, "Template failed",
                f"Could not create a project from '{tpl.humanized_name()}'.\n\n{exc}",
            )
            return
        # Persist the choice so the Agents page lands on it when the
        # main window switches tabs (the page reads this key on init
        # and on every refresh).
        self._settings.setValue("agents/active_project_id", proj.id)
        # Tell the host so it can switch tabs + refresh the agents page.
        self.project_created.emit(proj.id)
        # Show a soft confirmation with the MCP requirements as a hint.
        if tpl.required_mcp:
            QMessageBox.information(
                self,
                f"{tpl.humanized_name()} ready",
                "Project created. Connect these MCP servers in the Bridges "
                "tab for the team to be fully functional:\n\n  • "
                + "\n  • ".join(tpl.required_mcp),
            )

    @Slot(str)
    def _on_delete_custom_template(self, template_name: str) -> None:
        if QMessageBox.question(
            self,
            "Delete team template",
            f"Delete the custom team '{template_name}'?\n\n"
            "Existing projects spawned from it stay intact — only the "
            "template (so you can't re-instantiate it) is removed.",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No,
        ) != QMessageBox.Yes:
            return
        if delete_custom_template(template_name):
            self._reload_teams()

    # ------------------------------------------------------------------
    # Agents view (gallery + editor — the legacy Studio surface)
    # ------------------------------------------------------------------

    def _build_agents_view(self) -> QWidget:
        wrap = QWidget()
        wrap.setStyleSheet("background:transparent;")
        v = QVBoxLayout(wrap)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(8)

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
        v.addLayout(actions)

        # Splitter: gallery left (60%), editor right (40%).
        splitter = QSplitter(Qt.Horizontal)
        splitter.setHandleWidth(8)

        gallery_host = QScrollArea()
        gallery_host.setWidgetResizable(True)
        gallery_host.setFrameShape(QFrame.NoFrame)
        gallery_host.setStyleSheet("QScrollArea { background:transparent; border:none; }")
        self.gallery_widget = QWidget()
        self.gallery_layout = QGridLayout(self.gallery_widget)
        self.gallery_layout.setContentsMargins(0, 0, 0, 0)
        self.gallery_layout.setHorizontalSpacing(12)
        self.gallery_layout.setVerticalSpacing(10)
        self.gallery_layout.setColumnStretch(0, 1)
        self.gallery_layout.setColumnStretch(1, 1)
        gallery_host.setWidget(self.gallery_widget)
        splitter.addWidget(gallery_host)

        self.editor = _EditorPanel()
        self.editor.saved.connect(self._on_saved)
        self.editor.deleted.connect(self._on_deleted)
        splitter.addWidget(self.editor)

        splitter.setStretchFactor(0, 6)
        splitter.setStretchFactor(1, 4)
        splitter.setSizes([600, 400])
        v.addWidget(splitter, 1)
        return wrap

    # ------------------------------------------------------------------
    # Gallery refresh
    # ------------------------------------------------------------------

    def _reload_gallery(self, select: Optional[str] = None) -> None:
        # Clear existing cards.
        while self.gallery_layout.count():
            item = self.gallery_layout.takeAt(0)
            w = item.widget()
            if w is not None:
                w.deleteLater()

        defs = list_all_definitions()
        # Two-column layout: built-ins AND installed skills (Anthropic
        # library / community SKILL.md packs) on the left, pure custom
        # agents on the right. Orchestrators (can_dispatch=True) always
        # sit on the FIRST row of their respective column so the team
        # leaders are immediately visible at the top.
        try:
            from core.agents.skill_md import list_skill_definitions
            skill_names = set(list_skill_definitions().keys())
        except Exception:
            skill_names = set()

        def _sort_key(d: AgentDefinition) -> tuple:
            # Built-ins above skills above the rest, with leaders at
            # the top of every group.
            if d.built_in:
                bucket = 0
            elif d.name in skill_names:
                bucket = 1
            else:
                bucket = 2
            return (bucket, 0 if d.can_dispatch else 1, d.name.lower())

        left_col = sorted(
            (d for d in defs.values()
             if d.built_in or d.name in skill_names),
            key=_sort_key,
        )
        right_col = sorted(
            (d for d in defs.values()
             if not d.built_in and d.name not in skill_names),
            key=_sort_key,
        )

        first_name: Optional[str] = None

        def _add_column(items, col: int) -> Optional[str]:
            first: Optional[str] = None
            for row, d in enumerate(items):
                card = _GalleryCard(d, is_skill=(d.name in skill_names))
                card.clicked.connect(self._on_card_clicked)
                self.gallery_layout.addWidget(card, row, col)
                if first is None:
                    first = d.name
            return first

        first_builtin = _add_column(left_col, 0)
        first_custom = _add_column(right_col, 1)

        first_name = first_builtin or first_custom

        # Push a row stretcher at the bottom so cards stay top-aligned
        # when one column has fewer rows than the other.
        max_rows = max(len(left_col), len(right_col), 1)
        self.gallery_layout.setRowStretch(max_rows, 1)

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
        "color:#9aa0a6; font-size:13px; font-weight:600; "
        "letter-spacing:0.6px; text-transform:uppercase; "
        "background:transparent; margin-top:4px;"
    )
    return lbl


_INPUT_STYLE = """
    QLineEdit {
        background:palette(base); color:#fff; border:none;
        border-radius:8px; padding:0 12px; font-size:15px;
    }
    QLineEdit:focus { background:palette(base); }
    QLineEdit:disabled { color:#888; background:#101218; }
"""

_INPUT_STYLE_TEXTAREA = """
    QTextEdit {
        background:palette(base); color:#fff; border:none;
        border-radius:8px; padding:8px 12px; font-size:15px;
    }
    QTextEdit:focus { background:palette(base); }
"""

_TOOLBOX_STYLE = """
    QFrame {
        background:palette(base); border:none; border-radius:8px;
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

# Top-of-page Teams / Agents toggle. Two buttons rendered as a single
# segmented pill — left + right halves so the divider sits flush. The
# checked half gets the accent fill; the other stays muted.
_VIEW_TAB_LEFT_STYLE = """
    QPushButton {
        background:rgba(255,255,255,0.04); color:#9aa0a6;
        border:1px solid rgba(255,255,255,0.06);
        border-top-left-radius:9px; border-bottom-left-radius:9px;
        border-top-right-radius:0; border-bottom-right-radius:0;
        padding:0 22px; font-size:12px; font-weight:600;
    }
    QPushButton:hover { background:rgba(255,255,255,0.08); color:#fff; }
    QPushButton:checked {
        background:#28406b; color:#fff;
        border-color:#3a5fa0;
    }
"""

_VIEW_TAB_RIGHT_STYLE = """
    QPushButton {
        background:rgba(255,255,255,0.04); color:#9aa0a6;
        border:1px solid rgba(255,255,255,0.06);
        border-left:none;
        border-top-right-radius:9px; border-bottom-right-radius:9px;
        border-top-left-radius:0; border-bottom-left-radius:0;
        padding:0 22px; font-size:12px; font-weight:600;
    }
    QPushButton:hover { background:rgba(255,255,255,0.08); color:#fff; }
    QPushButton:checked {
        background:#28406b; color:#fff;
        border-color:#3a5fa0;
    }
"""
