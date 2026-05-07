"""Team builder — modal that turns a checked list of agents into a
custom :class:`Template` and writes it to the user templates dir.

Scope is intentionally MVP:

  * Header fields: id, display name, category, icon, description.
  * Agent picker: checkboxes over the existing :class:`AgentDefinition`
    catalogue (built-in + custom). The user designates one as the
    leader (orchestrator) via a radio column.
  * Topology preset: Star (default — orchestrator dispatches directly to
    each specialist, no chain) or Pipeline (orch → a → b → … → orch).

The full graph editor stays on the Agents page — once a project is
spawned from this template the user can rewire freely. Keeping the
builder small means it ships now; we can iterate to a richer
graph-editor builder later.
"""
from __future__ import annotations

import re
from typing import Dict, List, Optional

from PySide6.QtCore import Qt
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QButtonGroup,
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QRadioButton,
    QScrollArea,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from core.agents.agent_definitions import AgentDefinition, list_all_definitions
from core.agents.teams import (
    AgentSpec,
    Template,
    builtin_templates,
    save_custom_template,
    user_templates,
)
from desktop_app.widgets.agent_icons import apply_to_label


_CATEGORIES = ("Personal", "Knowledge", "Software", "Ops", "Other")
_TOPOLOGIES = ("Star (default)", "Pipeline")
_NAME_RE = re.compile(r"^[a-z][a-z0-9_]*$")


class TeamBuilderDialog(QDialog):
    """Returns a saved custom :class:`Template` via :attr:`saved_template`
    when accepted. The Studio reads that field after :meth:`exec` returns
    :attr:`QDialog.Accepted`."""

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("Create your own team")
        self.setModal(True)
        self.setMinimumSize(720, 600)
        self.saved_template: Optional[Template] = None

        self._defs: Dict[str, AgentDefinition] = list_all_definitions()
        self._agent_checks: Dict[str, QCheckBox] = {}
        self._leader_radios: Dict[str, QRadioButton] = {}
        self._leader_group = QButtonGroup(self)
        self._leader_group.setExclusive(True)

        self._build_ui()

    # ------------------------------------------------------------------

    def _build_ui(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(20, 20, 20, 20)
        outer.setSpacing(14)

        # Header.
        title = QLabel("Create your own team")
        tf = QFont()
        tf.setPointSize(18)
        tf.setBold(True)
        title.setFont(tf)
        title.setStyleSheet("color:#fff; background:transparent;")
        outer.addWidget(title)

        sub = QLabel(
            "Pick the agents that work together on this kind of project. "
            "One must be the leader (the orchestrator that dispatches to "
            "the others). Saved as a custom template — appears next to the "
            "built-in teams in the Studio."
        )
        sub.setWordWrap(True)
        sub.setStyleSheet("color:#9aa0a6; background:transparent; font-size:11px;")
        outer.addWidget(sub)

        # Header fields (id / display name / category / icon / description).
        outer.addWidget(self._build_fields())

        # Agent picker.
        outer.addWidget(self._build_agents_section(), 1)

        # Topology.
        outer.addWidget(self._build_topology())

        # Buttons.
        buttons = QDialogButtonBox(QDialogButtonBox.Save | QDialogButtonBox.Cancel)
        buttons.button(QDialogButtonBox.Save).setText("Save team")
        buttons.accepted.connect(self._on_save)
        buttons.rejected.connect(self.reject)
        outer.addWidget(buttons)

    def _build_fields(self) -> QWidget:
        wrap = QFrame()
        wrap.setStyleSheet(
            "QFrame { background:rgba(255,255,255,0.03); border-radius:10px; }"
        )
        layout = QVBoxLayout(wrap)
        layout.setContentsMargins(14, 12, 14, 12)
        layout.setSpacing(8)

        # Row 1: id + display name
        row1 = QHBoxLayout()
        row1.setSpacing(10)
        id_box = QVBoxLayout()
        id_box.addWidget(self._field_label("Internal id"))
        self.id_input = QLineEdit()
        self.id_input.setPlaceholderText("snake_case (e.g. coding_buddy)")
        self.id_input.setStyleSheet(_INPUT_STYLE)
        id_box.addWidget(self.id_input)
        row1.addLayout(id_box, 1)

        name_box = QVBoxLayout()
        name_box.addWidget(self._field_label("Display name"))
        self.name_input = QLineEdit()
        self.name_input.setPlaceholderText("Coding Buddy")
        self.name_input.setStyleSheet(_INPUT_STYLE)
        name_box.addWidget(self.name_input)
        row1.addLayout(name_box, 1)
        layout.addLayout(row1)

        # Row 2: category + icon
        row2 = QHBoxLayout()
        row2.setSpacing(10)
        cat_box = QVBoxLayout()
        cat_box.addWidget(self._field_label("Category"))
        self.category_combo = QComboBox()
        self.category_combo.addItems(_CATEGORIES)
        self.category_combo.setStyleSheet(
            "QComboBox { background:#0f1218; color:#fff; border:1px solid #2c313c;"
            " border-radius:6px; padding:6px 10px; }"
        )
        cat_box.addWidget(self.category_combo)
        row2.addLayout(cat_box, 1)

        icon_box = QVBoxLayout()
        icon_box.addWidget(self._field_label("Icon (emoji or owl:basename)"))
        self.icon_input = QLineEdit()
        self.icon_input.setPlaceholderText("🤖  or  owl:owl_orchestrator1")
        self.icon_input.setStyleSheet(_INPUT_STYLE)
        icon_box.addWidget(self.icon_input)
        row2.addLayout(icon_box, 1)
        layout.addLayout(row2)

        # Row 3: description (full width)
        layout.addWidget(self._field_label("Description"))
        self.desc_input = QTextEdit()
        self.desc_input.setPlaceholderText(
            "One or two sentences describing what this team is for."
        )
        self.desc_input.setFixedHeight(54)
        self.desc_input.setStyleSheet(
            "QTextEdit { background:#0f1218; color:#dde3ff; border:1px solid #2c313c;"
            " border-radius:6px; padding:6px; font-size:11px; }"
        )
        layout.addWidget(self.desc_input)
        return wrap

    def _build_agents_section(self) -> QWidget:
        wrap = QFrame()
        wrap.setStyleSheet(
            "QFrame { background:rgba(255,255,255,0.03); border-radius:10px; }"
        )
        layout = QVBoxLayout(wrap)
        layout.setContentsMargins(14, 12, 14, 12)
        layout.setSpacing(6)

        header = QHBoxLayout()
        header.addWidget(self._field_label("AGENTS — pick at least 2"))
        header.addStretch(1)
        leader_hint = QLabel("LEADER ↓")
        leader_hint.setStyleSheet(
            "color:#9aa0a6; background:transparent; font-size:9px; letter-spacing:1px;"
        )
        header.addWidget(leader_hint)
        layout.addLayout(header)

        # Scroll area for the agent list.
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.NoFrame)
        scroll.setStyleSheet("QScrollArea { background:transparent; border:none; }")
        host = QWidget()
        host.setStyleSheet("background:transparent;")
        host_layout = QVBoxLayout(host)
        host_layout.setContentsMargins(0, 0, 0, 0)
        host_layout.setSpacing(4)

        # Sort: dispatchable first (orchestrator candidates), then alpha.
        ordered = sorted(
            self._defs.values(),
            key=lambda d: (0 if d.can_dispatch else 1, d.name.lower()),
        )
        for d in ordered:
            host_layout.addWidget(self._build_agent_row(d))
        host_layout.addStretch(1)
        scroll.setWidget(host)
        layout.addWidget(scroll, 1)

        return wrap

    def _build_agent_row(self, d: AgentDefinition) -> QWidget:
        row = QWidget()
        row.setStyleSheet(
            "QWidget { background:rgba(255,255,255,0.02); border-radius:6px; }"
            "QWidget:hover { background:rgba(255,255,255,0.05); }"
        )
        h = QHBoxLayout(row)
        h.setContentsMargins(8, 4, 8, 4)
        h.setSpacing(10)

        cb = QCheckBox()
        cb.toggled.connect(lambda checked, name=d.name: self._on_check_toggled(name, checked))
        self._agent_checks[d.name] = cb
        h.addWidget(cb)

        avatar = QLabel()
        avatar.setFixedSize(28, 28)
        avatar.setAlignment(Qt.AlignCenter)
        apply_to_label(avatar, d.icon or "🤖", size=24)
        h.addWidget(avatar)

        info = QVBoxLayout()
        info.setSpacing(0)
        name_label = QLabel(f"<b>{d.name}</b>")
        name_label.setStyleSheet("color:#dde3ff; background:transparent;")
        info.addWidget(name_label)
        desc_label = QLabel(d.description or "")
        desc_label.setStyleSheet(
            "color:#9aa0a6; background:transparent; font-size:10px;"
        )
        desc_label.setMaximumWidth(420)
        info.addWidget(desc_label)
        h.addLayout(info, 1)

        radio = QRadioButton()
        radio.setEnabled(False)  # enabled when its checkbox is on
        # Default: only orchestrator-capable agents make sensible leaders.
        if d.can_dispatch:
            radio.setToolTip("Leader (dispatches to the rest)")
        else:
            radio.setToolTip(
                "Leader (only agents that can dispatch should be a leader)"
            )
        self._leader_radios[d.name] = radio
        self._leader_group.addButton(radio)
        h.addWidget(radio)
        return row

    def _build_topology(self) -> QWidget:
        wrap = QFrame()
        wrap.setStyleSheet(
            "QFrame { background:rgba(255,255,255,0.03); border-radius:10px; }"
        )
        layout = QHBoxLayout(wrap)
        layout.setContentsMargins(14, 10, 14, 10)
        layout.setSpacing(10)

        layout.addWidget(self._field_label("Topology"))
        self.topology_combo = QComboBox()
        self.topology_combo.addItems(_TOPOLOGIES)
        self.topology_combo.setStyleSheet(
            "QComboBox { background:#0f1218; color:#fff; border:1px solid #2c313c;"
            " border-radius:6px; padding:6px 10px; min-width:180px; }"
        )
        layout.addWidget(self.topology_combo)
        layout.addStretch(1)
        hint = QLabel(
            "Star = orchestrator dispatches each agent directly. Pipeline = "
            "agents form a chain (output of one feeds the next)."
        )
        hint.setWordWrap(True)
        hint.setStyleSheet(
            "color:#7888a8; background:transparent; font-size:10px;"
        )
        layout.addWidget(hint, 2)
        return wrap

    # ------------------------------------------------------------------

    def _field_label(self, text: str) -> QLabel:
        lbl = QLabel(text)
        lbl.setStyleSheet(
            "color:#9aa0a6; background:transparent; "
            "font-size:10px; letter-spacing:0.8px;"
        )
        return lbl

    def _on_check_toggled(self, name: str, checked: bool) -> None:
        """Enable / disable the leader radio for this agent. Auto-selects
        the first dispatch-capable agent as leader if none is currently
        chosen — saves the user a click on the common path."""
        radio = self._leader_radios.get(name)
        if radio is None:
            return
        radio.setEnabled(checked)
        if not checked and radio.isChecked():
            radio.setChecked(False)
        if checked and not any(r.isChecked() for r in self._leader_radios.values()):
            d = self._defs.get(name)
            if d is not None and d.can_dispatch:
                radio.setChecked(True)

    def _selected_agents(self) -> List[str]:
        return [name for name, cb in self._agent_checks.items() if cb.isChecked()]

    def _selected_leader(self) -> Optional[str]:
        for name, r in self._leader_radios.items():
            if r.isChecked():
                return name
        return None

    # ------------------------------------------------------------------

    def _on_save(self) -> None:
        try:
            template = self._build_template()
        except ValueError as exc:
            QMessageBox.warning(self, "Cannot save", str(exc))
            return
        try:
            save_custom_template(template)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(
                self, "Save failed",
                f"Could not write the template file:\n{exc}",
            )
            return
        # Reload from disk so the saved object carries built_in=False.
        from core.agents.teams import all_templates
        self.saved_template = all_templates().get(template.name) or template
        self.saved_template.built_in = False
        self.accept()

    def _build_template(self) -> Template:
        tid = (self.id_input.text() or "").strip().lower()
        if not tid:
            raise ValueError("Pick an internal id (snake_case identifier).")
        if not _NAME_RE.match(tid):
            raise ValueError(
                "Internal id must start with a lowercase letter and contain "
                "only lowercase letters, digits and underscores."
            )
        if tid in builtin_templates():
            raise ValueError(
                f"'{tid}' is a built-in team id. Pick something different."
            )
        if tid in user_templates():
            raise ValueError(
                f"You already have a custom team called '{tid}'. "
                "Delete or rename it first."
            )

        display_name = (self.name_input.text() or "").strip()
        category = self.category_combo.currentText().strip() or "Other"
        icon = (self.icon_input.text() or "").strip() or "🤖"
        description = self.desc_input.toPlainText().strip()

        agent_names = self._selected_agents()
        if len(agent_names) < 2:
            raise ValueError("Pick at least two agents.")
        leader = self._selected_leader()
        if leader is None:
            raise ValueError("Designate one of the agents as the leader.")
        if leader not in agent_names:
            raise ValueError(
                "The leader must be one of the agents you've checked."
            )

        agents: List[AgentSpec] = []
        for name in agent_names:
            d = self._defs.get(name)
            if d is None:
                continue
            agents.append(AgentSpec(
                name=name,
                base=name,                       # reuse the picked def as base
                icon=d.icon or None,
                # Force can_dispatch only on the chosen leader; defaults to
                # whatever the base def says otherwise.
                can_dispatch=True if name == leader else False,
            ))

        graph_edges = self._build_topology_edges(
            topology=self.topology_combo.currentText(),
            leader=leader,
            specialists=[n for n in agent_names if n != leader],
        )

        return Template(
            name=tid,
            display_name=display_name,
            category=category,
            description=description,
            icon=icon,
            required_mcp=[],
            agents=agents,
            graph_edges=graph_edges,
            built_in=False,
        )

    @staticmethod
    def _build_topology_edges(*, topology: str, leader: str, specialists: List[str]):
        """Translate the chosen preset into ``(src, dst)`` short-name pairs.
        Pipeline = chain through specialists in pick order then back to
        leader. Star = no edges (the orchestrator's default
        point-to-point dispatch handles fan-out).
        """
        if not specialists:
            return []
        if "Pipeline" in topology:
            edges = [(leader, specialists[0])]
            for a, b in zip(specialists, specialists[1:]):
                edges.append((a, b))
            edges.append((specialists[-1], leader))
            return edges
        return []  # Star
