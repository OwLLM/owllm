"""Team grid view + per-team detail panel for the Studio's Teams tab.

Layout (lives inside :class:`AgentStudioPage`):

    ┌─ TeamGridView ───────────────────────────────────┐
    │  PERSONAL                                         │
    │  ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐         │
    │  │  🦉   │ │  🛒   │ │  💰   │ │  ❤️   │         │
    │  │Secret-│ │Concie-│ │Finance│ │Health │         │
    │  │  ary  │ │  rge  │ │       │ │ Coach │         │
    │  │5 agts │ │4 agts │ │5 agts │ │5 agts │         │
    │  └───────┘ └───────┘ └───────┘ └───────┘         │
    │                                                   │
    │  KNOWLEDGE / SOFTWARE / OPS / CUSTOM              │
    │  …                                                │
    │                                                   │
    │  + Create your own team   (always-last tile)      │
    └───────────────────────────────────────────────────┘

Selection emits :attr:`TeamGridView.team_selected` with the template
``name`` (or the empty string for the "Create your own team" tile,
which the page maps to opening :class:`TeamBuilderDialog`).
"""
from __future__ import annotations

from typing import Dict, List, Optional

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QColor, QFont
from PySide6.QtWidgets import (
    QFrame,
    QGraphicsDropShadowEffect,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

from core.agents.teams import Template
from desktop_app.widgets.agent_icons import apply_to_label


_CATEGORY_ORDER = ("Personal", "Knowledge", "Software", "Ops", "Other", "Custom")
_CATEGORY_ACCENT = {
    "Personal": "#74a4ff",
    "Knowledge": "#c08aff",
    "Software": "#5cf0ff",
    "Ops": "#ffb56a",
    "Other": "#9aa0a6",
    "Custom": "#ff7ed1",
}


# ---------------------------------------------------------------------------
# Card
# ---------------------------------------------------------------------------


class TeamCard(QFrame):
    """One team tile in the grid. Click → emits :attr:`clicked` with the
    template id. The 'New team' variant has no template — its callers use
    a separate signal."""

    clicked = Signal(str)  # template name (or "" for create-tile)

    def __init__(self, template: Optional[Template], parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self._template = template
        self._is_create_tile = template is None
        self._selected = False
        self.setObjectName("TeamCard")
        self.setCursor(Qt.PointingHandCursor)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.setMinimumHeight(180)
        self.setMaximumHeight(220)
        self._apply_style()

        # Soft drop shadow gives the card depth without a heavy border.
        shadow = QGraphicsDropShadowEffect(self)
        shadow.setBlurRadius(18)
        shadow.setOffset(0, 4)
        shadow.setColor(QColor(0, 0, 0, 110))
        self.setGraphicsEffect(shadow)

        self._build_inner()

    # ------------------------------------------------------------------

    def _apply_style(self) -> None:
        if self._is_create_tile:
            # Distinct dashed look so the user immediately reads it as
            # "different from the catalogue cards".
            self.setStyleSheet(
                "QFrame#TeamCard {"
                "  background:rgba(124,150,255,0.06);"
                "  border:2px dashed rgba(124,150,255,0.55);"
                "  border-radius:14px;"
                "}"
                "QFrame#TeamCard:hover {"
                "  background:rgba(124,150,255,0.14);"
                "  border-color:rgba(180,200,255,0.85);"
                "}"
            )
            return

        accent = _CATEGORY_ACCENT.get(
            self._template.category if self._template else "", "#74a4ff"
        )
        border = "rgba(124,150,255,0.95)" if self._selected else "rgba(255,255,255,0.06)"
        self.setStyleSheet(
            "QFrame#TeamCard {"
            "  background:qlineargradient("
            "x1:0,y1:0,x2:1,y2:1, stop:0 #1c2236, stop:1 #0d1019);"
            f"  border:1px solid {border};"
            "  border-radius:14px;"
            "}"
            "QFrame#TeamCard:hover {"
            f"  border:1px solid {accent};"
            "}"
        )

    def _build_inner(self) -> None:
        if self._is_create_tile:
            self._build_create_inner()
            return

        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 14, 16, 14)
        layout.setSpacing(8)

        # Header row: icon + display name + agent count badge
        header = QHBoxLayout()
        header.setSpacing(12)

        avatar = QLabel()
        avatar.setFixedSize(48, 48)
        avatar.setAlignment(Qt.AlignCenter)
        apply_to_label(avatar, (self._template.icon if self._template else "🤖") or "🤖", size=44)
        header.addWidget(avatar)

        name_box = QVBoxLayout()
        name_box.setSpacing(2)
        name_label = QLabel(self._template.humanized_name())
        nf = QFont()
        nf.setPointSize(13)
        nf.setBold(True)
        name_label.setFont(nf)
        name_label.setStyleSheet("color:#fff; background:transparent;")
        name_box.addWidget(name_label)

        accent = _CATEGORY_ACCENT.get(self._template.category, "#9aa0a6")
        meta = QLabel(
            f"<span style='color:{accent};'>{self._template.category.upper()}</span>"
            f"  ·  {len(self._template.agents)} agents"
        )
        meta.setStyleSheet(
            "background:transparent; font-size:10px; letter-spacing:0.6px;"
        )
        name_box.addWidget(meta)
        header.addLayout(name_box, 1)

        # Tag chip in the corner: built-in vs custom
        if not self._template.built_in:
            tag = QLabel("CUSTOM")
            tag.setStyleSheet(
                "color:#ff7ed1; background:rgba(255,126,209,0.10); "
                "border-radius:5px; padding:2px 6px; font-size:9px; "
                "letter-spacing:0.8px;"
            )
            tag.setAlignment(Qt.AlignCenter)
            header.addWidget(tag, 0, Qt.AlignTop)

        layout.addLayout(header)

        # Description
        desc = QLabel(self._template.description or "")
        desc.setWordWrap(True)
        desc.setStyleSheet(
            "color:#bbc1cc; background:transparent; font-size:11px;"
        )
        desc.setMaximumHeight(48)
        layout.addWidget(desc)

        # Agent avatars row (small icons that hint at composition)
        avatars = QHBoxLayout()
        avatars.setSpacing(4)
        avatars.setContentsMargins(0, 0, 0, 0)
        for a in self._template.agents[:6]:
            mini = QLabel()
            mini.setFixedSize(24, 24)
            mini.setAlignment(Qt.AlignCenter)
            apply_to_label(mini, a.icon or "🤖", size=22)
            avatars.addWidget(mini)
        if len(self._template.agents) > 6:
            extra = QLabel(f"+{len(self._template.agents) - 6}")
            extra.setStyleSheet(
                "color:#9aa0a6; background:transparent; font-size:10px;"
            )
            avatars.addWidget(extra)
        avatars.addStretch(1)
        layout.addLayout(avatars)

        # MCP needs chips (compact)
        if self._template.required_mcp:
            mcp_row = QHBoxLayout()
            mcp_row.setSpacing(4)
            mcp_row.setContentsMargins(0, 0, 0, 0)
            for mcp in self._template.required_mcp[:4]:
                short = mcp.replace("mcp.", "")
                chip = QLabel(short)
                chip.setStyleSheet(
                    "color:#9aa0a6; background:rgba(255,255,255,0.05); "
                    "border-radius:4px; padding:1px 6px; font-size:9px;"
                )
                mcp_row.addWidget(chip)
            if len(self._template.required_mcp) > 4:
                more = QLabel(f"+{len(self._template.required_mcp) - 4}")
                more.setStyleSheet(
                    "color:#9aa0a6; background:transparent; font-size:9px;"
                )
                mcp_row.addWidget(more)
            mcp_row.addStretch(1)
            layout.addLayout(mcp_row)

    def _build_create_inner(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setAlignment(Qt.AlignCenter)
        layout.setSpacing(8)

        plus = QLabel("＋")
        pf = QFont()
        pf.setPointSize(36)
        pf.setBold(True)
        plus.setFont(pf)
        plus.setAlignment(Qt.AlignCenter)
        plus.setStyleSheet("color:#a8b8ff; background:transparent;")
        layout.addWidget(plus)

        title = QLabel("Create your own team")
        tf = QFont()
        tf.setPointSize(12)
        tf.setBold(True)
        title.setFont(tf)
        title.setAlignment(Qt.AlignCenter)
        title.setStyleSheet("color:#dde3ff; background:transparent;")
        layout.addWidget(title)

        sub = QLabel("Pick agents, name it, save it as a template.")
        sub.setWordWrap(True)
        sub.setAlignment(Qt.AlignCenter)
        sub.setStyleSheet("color:#9aa0a6; background:transparent; font-size:11px;")
        layout.addWidget(sub)

    def set_selected(self, selected: bool) -> None:
        if self._selected == selected:
            return
        self._selected = selected
        self._apply_style()

    def template_name(self) -> str:
        return self._template.name if self._template else ""

    def mousePressEvent(self, ev) -> None:  # noqa: N802
        if ev.button() == Qt.LeftButton:
            self.clicked.emit(self.template_name())
        super().mousePressEvent(ev)


# ---------------------------------------------------------------------------
# Grid view
# ---------------------------------------------------------------------------


class TeamGridView(QScrollArea):
    """Scrollable grid of category sections, each with a row of TeamCards.
    The very last tile is always the 'Create your own team' card."""

    team_selected = Signal(str)
    """Emitted with the chosen template ``name`` when the user clicks a
    catalogue card."""
    create_team_requested = Signal()
    """Emitted when the user clicks the 'Create your own team' tile."""

    _COLS = 3  # columns per category section

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setWidgetResizable(True)
        self.setFrameShape(QFrame.NoFrame)
        self.setStyleSheet("QScrollArea { background:transparent; border:none; }")

        self._host = QWidget()
        self._host.setStyleSheet("background:transparent;")
        self._host_layout = QVBoxLayout(self._host)
        self._host_layout.setContentsMargins(0, 0, 0, 0)
        self._host_layout.setSpacing(18)
        self.setWidget(self._host)

        self._cards: List[TeamCard] = []
        self._selected: Optional[str] = None

    # ------------------------------------------------------------------

    def set_templates(self, templates: Dict[str, Template]) -> None:
        """(Re)build the entire grid from a name -> Template map."""
        # Clear previous content.
        while self._host_layout.count():
            item = self._host_layout.takeAt(0)
            w = item.widget()
            if w is not None:
                w.deleteLater()
        self._cards.clear()

        # Group by category.
        groups: Dict[str, List[Template]] = {}
        for tpl in templates.values():
            cat = tpl.category if tpl.built_in else "Custom"
            # User-built templates always live under the "Custom" section
            # regardless of the category they declared internally — keeps
            # provenance obvious in the UI.
            groups.setdefault(cat, []).append(tpl)

        # Order categories: known sections first, then anything new alpha.
        ordered_cats = [c for c in _CATEGORY_ORDER if c in groups]
        for c in sorted(groups):
            if c not in ordered_cats:
                ordered_cats.append(c)

        for cat in ordered_cats:
            self._host_layout.addWidget(self._build_section(cat, groups[cat]))

        # Trailing "Create your own team" tile gets its own section so it
        # sits below everything else with breathing room.
        create_section = self._build_create_section()
        self._host_layout.addWidget(create_section)
        self._host_layout.addStretch(1)

    def _build_section(self, category: str, templates: List[Template]) -> QWidget:
        wrap = QWidget()
        wrap.setStyleSheet("background:transparent;")
        v = QVBoxLayout(wrap)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(8)

        accent = _CATEGORY_ACCENT.get(category, "#9aa0a6")
        header = QLabel(category.upper())
        hf = QFont()
        hf.setPointSize(10)
        hf.setBold(True)
        header.setFont(hf)
        header.setStyleSheet(
            f"color:{accent}; background:transparent; "
            "letter-spacing:1.2px; padding:0 2px;"
        )
        v.addWidget(header)

        grid = QGridLayout()
        grid.setHorizontalSpacing(12)
        grid.setVerticalSpacing(12)
        for i in range(self._COLS):
            grid.setColumnStretch(i, 1)

        # Sort templates by display name within a section.
        ordered = sorted(templates, key=lambda t: t.humanized_name().lower())
        for idx, tpl in enumerate(ordered):
            card = TeamCard(tpl)
            card.clicked.connect(self._on_card_clicked)
            self._cards.append(card)
            grid.addWidget(card, idx // self._COLS, idx % self._COLS)
        v.addLayout(grid)
        return wrap

    def _build_create_section(self) -> QWidget:
        wrap = QWidget()
        wrap.setStyleSheet("background:transparent;")
        v = QVBoxLayout(wrap)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(8)

        header = QLabel("BUILD YOUR OWN")
        hf = QFont()
        hf.setPointSize(10)
        hf.setBold(True)
        header.setFont(hf)
        header.setStyleSheet(
            "color:#a8b8ff; background:transparent; "
            "letter-spacing:1.2px; padding:0 2px;"
        )
        v.addWidget(header)

        grid = QGridLayout()
        grid.setHorizontalSpacing(12)
        grid.setVerticalSpacing(12)
        for i in range(self._COLS):
            grid.setColumnStretch(i, 1)

        create_card = TeamCard(template=None)
        create_card.clicked.connect(lambda _name: self.create_team_requested.emit())
        # Pin to the first cell of its row; visually the section is shorter
        # than the catalogue rows but still uses the same column rhythm.
        grid.addWidget(create_card, 0, 0)
        v.addLayout(grid)
        return wrap

    # ------------------------------------------------------------------

    def _on_card_clicked(self, name: str) -> None:
        if not name:
            self.create_team_requested.emit()
            return
        self.set_selected(name)
        self.team_selected.emit(name)

    def set_selected(self, name: Optional[str]) -> None:
        """Visually mark a card as selected. Pass ``None`` to clear."""
        self._selected = name
        for c in self._cards:
            c.set_selected(c.template_name() == name and bool(name))


# ---------------------------------------------------------------------------
# Detail panel
# ---------------------------------------------------------------------------


class TeamDetailPanel(QFrame):
    """Right-side panel that shows the full template description, agents,
    routing, and MCP requirements with a primary 'New project from this
    team' CTA. Custom templates also expose Edit / Delete affordances."""

    create_project_requested = Signal(str)  # template name
    edit_template_requested = Signal(str)
    delete_template_requested = Signal(str)

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setObjectName("TeamDetailPanel")
        self.setStyleSheet(
            "QFrame#TeamDetailPanel {"
            "  background:#0f1218;"
            "  border:1px solid rgba(255,255,255,0.04);"
            "  border-radius:12px;"
            "}"
        )
        self._template: Optional[Template] = None

        self._layout = QVBoxLayout(self)
        self._layout.setContentsMargins(20, 20, 20, 20)
        self._layout.setSpacing(12)

        self._show_empty()

    # ------------------------------------------------------------------

    def show_template(self, template: Optional[Template]) -> None:
        self._template = template
        # Wipe and rebuild — simpler than diffing field by field.
        while self._layout.count():
            item = self._layout.takeAt(0)
            w = item.widget()
            if w is not None:
                w.deleteLater()
            else:
                lay = item.layout()
                if lay is not None:
                    self._strip_layout(lay)

        if template is None:
            self._show_empty()
            return

        self._build_header(template)
        self._build_description(template)
        self._build_agents(template)
        self._build_graph(template)
        self._build_mcp(template)
        self._layout.addStretch(1)
        self._build_actions(template)

    # ------------------------------------------------------------------

    def _strip_layout(self, lay) -> None:
        while lay.count():
            item = lay.takeAt(0)
            w = item.widget()
            if w is not None:
                w.deleteLater()
            sub = item.layout()
            if sub is not None:
                self._strip_layout(sub)

    def _show_empty(self) -> None:
        msg = QLabel(
            "Pick a team from the grid to see the agents it ships with,\n"
            "how they're wired together, and which MCP servers it needs."
        )
        msg.setAlignment(Qt.AlignCenter)
        msg.setWordWrap(True)
        msg.setStyleSheet(
            "color:#6c7280; background:transparent; font-size:12px;"
            " padding:40px 20px;"
        )
        self._layout.addStretch(1)
        self._layout.addWidget(msg)
        self._layout.addStretch(1)

    def _build_header(self, t: Template) -> None:
        row = QHBoxLayout()
        row.setSpacing(14)
        avatar = QLabel()
        avatar.setFixedSize(72, 72)
        avatar.setAlignment(Qt.AlignCenter)
        apply_to_label(avatar, t.icon or "🤖", size=64)
        row.addWidget(avatar)

        text = QVBoxLayout()
        text.setSpacing(2)
        title = QLabel(t.humanized_name())
        tf = QFont()
        tf.setPointSize(18)
        tf.setBold(True)
        title.setFont(tf)
        title.setStyleSheet("color:#fff; background:transparent;")
        text.addWidget(title)

        accent = _CATEGORY_ACCENT.get(t.category, "#9aa0a6")
        meta_bits = [
            f"<span style='color:{accent};'>{t.category.upper()}</span>",
            f"{len(t.agents)} agents",
            f"{len(t.graph_edges)} connections",
        ]
        if not t.built_in:
            meta_bits.append("<span style='color:#ff7ed1;'>CUSTOM</span>")
        else:
            meta_bits.append("<span style='color:#9aa0a6;'>BUILT-IN</span>")
        meta = QLabel("  ·  ".join(meta_bits))
        meta.setStyleSheet(
            "background:transparent; font-size:10px; letter-spacing:0.6px;"
        )
        text.addWidget(meta)
        row.addLayout(text, 1)

        self._layout.addLayout(row)

    def _build_description(self, t: Template) -> None:
        if not t.description:
            return
        desc = QLabel(t.description)
        desc.setWordWrap(True)
        desc.setStyleSheet(
            "color:#cbd2e0; background:transparent; font-size:12px;"
        )
        self._layout.addWidget(desc)

    def _build_agents(self, t: Template) -> None:
        h = QLabel("AGENTS")
        h.setStyleSheet(
            "color:#9aa0a6; background:transparent; "
            "font-size:10px; letter-spacing:1px; padding-top:6px;"
        )
        self._layout.addWidget(h)

        for spec in t.agents:
            row = QHBoxLayout()
            row.setSpacing(10)
            icon = QLabel()
            icon.setFixedSize(28, 28)
            icon.setAlignment(Qt.AlignCenter)
            apply_to_label(icon, spec.icon or "🤖", size=24)
            row.addWidget(icon)

            name = QLabel(f"<b>{spec.name}</b>")
            name.setStyleSheet("color:#dde3ff; background:transparent;")
            row.addWidget(name)

            if spec.base:
                base = QLabel(f"base: {spec.base}")
                base.setStyleSheet(
                    "color:#7888a8; background:transparent; font-size:10px;"
                )
                row.addWidget(base)
            row.addStretch(1)

            if spec.can_dispatch or spec.base == "orchestrator":
                tag = QLabel("LEADER")
                tag.setStyleSheet(
                    "color:#ffc060; background:rgba(255,192,96,0.10); "
                    "border-radius:4px; padding:1px 6px; font-size:9px;"
                )
                row.addWidget(tag)

            self._layout.addLayout(row)

    def _build_graph(self, t: Template) -> None:
        if not t.graph_edges:
            return
        h = QLabel("ROUTING")
        h.setStyleSheet(
            "color:#9aa0a6; background:transparent; "
            "font-size:10px; letter-spacing:1px; padding-top:6px;"
        )
        self._layout.addWidget(h)
        # Render as plain "src → dst" lines — readable enough as a
        # thumbnail; the full editable canvas lives on the Agents page.
        for s, d in t.graph_edges:
            line = QLabel(f"{s}  →  {d}")
            line.setStyleSheet(
                "color:#bbc1cc; background:transparent; "
                "font-family:'Consolas','JetBrains Mono',monospace; font-size:11px;"
            )
            self._layout.addWidget(line)

    def _build_mcp(self, t: Template) -> None:
        if not t.required_mcp:
            return
        h = QLabel("MCP NEEDED")
        h.setStyleSheet(
            "color:#9aa0a6; background:transparent; "
            "font-size:10px; letter-spacing:1px; padding-top:6px;"
        )
        self._layout.addWidget(h)
        chips = QHBoxLayout()
        chips.setSpacing(6)
        for mcp in t.required_mcp:
            chip = QLabel(mcp.replace("mcp.", ""))
            chip.setStyleSheet(
                "color:#dde3ff; background:rgba(116,164,255,0.12); "
                "border-radius:6px; padding:3px 8px; font-size:11px;"
            )
            chips.addWidget(chip)
        chips.addStretch(1)
        wrap = QWidget()
        wrap.setLayout(chips)
        self._layout.addWidget(wrap)

    def _build_actions(self, t: Template) -> None:
        actions = QHBoxLayout()
        actions.setSpacing(8)

        # Custom templates can be deleted (built-ins cannot).
        if not t.built_in:
            del_btn = QPushButton("Delete")
            del_btn.setMinimumHeight(34)
            del_btn.setStyleSheet(
                "QPushButton {"
                "  background:transparent; color:#ff8c8c;"
                "  border:none; border-radius:8px; padding:0 14px;"
                "}"
                "QPushButton:hover { background:rgba(255,140,140,0.12); }"
            )
            del_btn.clicked.connect(lambda _, n=t.name: self.delete_template_requested.emit(n))
            actions.addWidget(del_btn)

        actions.addStretch(1)

        primary = QPushButton(f"+ New project from {t.humanized_name()}")
        primary.setMinimumHeight(38)
        primary.setStyleSheet(
            "QPushButton {"
            "  background:#4a6cff; color:#fff; border:none; border-radius:9px;"
            "  padding:0 16px; font-weight:600; font-size:12px;"
            "}"
            "QPushButton:hover { background:#5a7bff; }"
            "QPushButton:pressed { background:#3a5ce6; }"
        )
        primary.clicked.connect(lambda _, n=t.name: self.create_project_requested.emit(n))
        actions.addWidget(primary)

        self._layout.addLayout(actions)
