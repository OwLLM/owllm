"""Live orbital diagram for the Agentic Team page.

The "loading-time" :class:`AgentCanvasLoader` showed a beautiful crest with
agents in a hex constellation around it — but it was static decoration.
This widget reuses that visual language and turns it into the live working
canvas:

  * Orchestrator at the centre (the owl_agentic crest).
  * Each team agent orbits the orchestrator on a soft ring.
  * Bus events drive ``set_node_status(name, status)``: nodes glow green
    when working, amber when pending, red on error, dim when idle.
  * Click an agent → ``node_selected(name)`` signal fires.
  * Selecting an agent reveals a top-left info card (picture + name +
    skills/info), styled like a gamey character sheet.

Pure :class:`QPainter`/``paintEvent`` + :class:`QTimer` — same render loop
as the loader so the two feel like one continuous experience when the
page transitions from the loading state to the live state.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from PySide6.QtCore import (
    QEvent,
    QPoint,
    QPointF,
    QRectF,
    Qt,
    QTimer,
    Signal,
)
from PySide6.QtGui import (
    QBrush,
    QColor,
    QCursor,
    QFont,
    QLinearGradient,
    QPainter,
    QPen,
    QPixmap,
    QRadialGradient,
)
from PySide6.QtWidgets import QSizePolicy, QWidget


# Status keys — match ``desktop_app.widgets.agent_canvas`` so the bus-message
# routing in agents_page.py works for either canvas without translation.
STATUS_IDLE = "idle"
STATUS_ACTIVE = "active"
STATUS_PENDING = "pending"
STATUS_ERROR = "error"


# Theme — reuse the loader's neon palette so the two widgets feel like
# one continuous experience.
_BG_DARK = QColor("#0a0d14")
_BG_GRAD_TOP = QColor("#101522")
_BG_GRAD_BOT = QColor("#06080d")

_NEON_CYAN = QColor("#5cf0ff")
_NEON_BLUE = QColor("#74a4ff")
_NEON_VIOLET = QColor("#c08aff")
_NEON_PINK = QColor("#ff7ed1")
_NEON_GREEN = QColor("#3cf26b")  # the active/working glow
_NEON_AMBER = QColor("#ffc060")
_NEON_RED = QColor("#ff7878")

_TEXT_BRIGHT = QColor("#e6f0ff")
_TEXT_DIM = QColor("#7888a8")


def _alpha(c: QColor, a: int) -> QColor:
    return QColor(c.red(), c.green(), c.blue(), max(0, min(255, a)))


def _mix(a: QColor, b: QColor, t: float) -> QColor:
    t = max(0.0, min(1.0, t))
    return QColor(
        int(a.red() + (b.red() - a.red()) * t),
        int(a.green() + (b.green() - a.green()) * t),
        int(a.blue() + (b.blue() - a.blue()) * t),
        int(a.alpha() + (b.alpha() - a.alpha()) * t),
    )


# Per-status colour for node fill / glow.
_STATUS_FILL = {
    STATUS_IDLE: QColor("#2a3142"),
    STATUS_ACTIVE: _NEON_GREEN,
    STATUS_PENDING: _NEON_AMBER,
    STATUS_ERROR: _NEON_RED,
}
_STATUS_HALO = {
    STATUS_IDLE: _alpha(_NEON_BLUE, 90),
    STATUS_ACTIVE: _alpha(_NEON_GREEN, 220),
    STATUS_PENDING: _alpha(_NEON_AMBER, 180),
    STATUS_ERROR: _alpha(_NEON_RED, 200),
}

# Layer palette — IDENTICAL to the graph editor's LAYER_COLORS in
# desktop_app.widgets.agent_canvas, so the orbital diagram and the
# graph view speak the same colour language. Index = BFS layer
# from the orchestrator (0 = orchestrator itself).
LAYER_COLORS: List[QColor] = [
    QColor("#f1c44a"),   # 0 — gold (orchestrator)
    QColor("#48d486"),   # 1 — green
    QColor("#3aa0ff"),   # 2 — blue
    QColor("#ee5b5b"),   # 3 — red
    QColor("#ff9a3a"),   # 4 — orange
    QColor("#9aa3b2"),   # 5 — grey
    QColor("#a578ff"),   # 6 — violet
    QColor("#ff79c4"),   # 7 — pink
]


def _layer_color(layer: int) -> QColor:
    if layer < 0:
        layer = 0
    return LAYER_COLORS[layer % len(LAYER_COLORS)]


# Edge port colours — matches the graph editor's convention so an
# 'output → input' edge reads the same on both views.
_EDGE_COLOR_OUT = QColor("#3aa0ff")  # blue (output port)
_EDGE_COLOR_IN = QColor("#ff9a3a")   # orange (input port)


@dataclass
class _Agent:
    """Per-agent state held by the canvas."""

    name: str
    icon: str = "🤖"
    description: str = ""
    skills: List[str] = field(default_factory=list)
    model_label: str = ""
    voice_label: str = ""
    is_orchestrator: bool = False
    status: str = STATUS_IDLE
    pos: QPointF = field(default_factory=QPointF)
    radius: float = 28.0


class AgentTeamCanvas(QWidget):
    """Live orbital diagram with status-aware nodes and an info card.

    Drop-in companion to :class:`desktop_app.widgets.agent_canvas.AgentCanvas` —
    not a graph editor, just a live status visual. Bus-message routing in
    agents_page.py can call ``set_node_status`` and ``set_node_icon`` on
    either canvas with the same effect.
    """

    node_selected = Signal(str)  # agent name when user clicks a node
    selection_mode_changed = Signal(str)
    """Emitted when the painted card switches kind. Payload is one of:

      * ``"agent:<name>"`` — agent's character-sheet card is showing
      * ``"team"``        — team-level card is showing (no agent selected)
      * ``""``            — no card is showing (no agents yet)

    The agents page subscribes to this so the overlay model picker
    can re-bind its current value + signal routing whenever the card
    flips between agent and team modes."""

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.setMinimumSize(420, 320)
        self.setAttribute(Qt.WA_StyledBackground, False)
        self.setAutoFillBackground(False)
        self.setMouseTracking(True)

        self._phase = 0.0
        self._agents: Dict[str, _Agent] = {}
        self._orbit_order: List[str] = []  # display order around the ring
        self._orchestrator_name: Optional[str] = None
        self._selected: Optional[str] = None
        self._hover: Optional[str] = None

        # Overlay model picker — a real Qt widget the agents page parents
        # to us via :meth:`attach_card_picker`. We position it inside the
        # painted card on every paintEvent and emit
        # :attr:`selection_mode_changed` so the page can re-bind it.
        self._card_picker: Optional[QWidget] = None
        self._last_card_mode: str = ""

        # Per-layer rotation speed + phase offset. Each ring spins at
        # its own random rate (some clockwise, some counter-clockwise)
        # so agents on different layers don't stay aligned along the
        # same radial line — that previously made connections hide
        # behind each other.
        self._ring_speed: Dict[int, float] = {}
        self._ring_phase: Dict[int, float] = {}

        # Explicit (from, to) edges from the saved AgentGraph — drawn
        # as directed arrows on top of the spokes. Empty means no
        # arrows are rendered, layout is unaffected.
        self._edges: List[Tuple[str, str]] = []

        # Per-agent BFS depth from the orchestrator. 1 = directly
        # connected, 2 = two hops away, etc. Used to push deeper
        # agents further from the centre (the "onion-ring" effect).
        # Empty / missing entries default to depth 1 in _layout, so
        # the layout falls back to the original single-ring
        # behaviour when there are no edges.
        self._depth: Dict[str, int] = {}

        # Team-level metadata for the default info card shown when
        # nothing is selected.
        self._team_name: str = ""
        self._team_description: str = ""

        # Cached radii for the visible concentric rings — populated by
        # _layout each frame, consumed by _paint_rings.
        self._ring_radii: List[float] = []

        # Zoom factor controlled by the mouse wheel — multiplies every
        # geometric distance in the diagram (ring radii, agent disc
        # size, orchestrator crest, arrowhead length). Info card and
        # bottom hint stay absolute so they don't scale with the
        # diagram. Clamped to a sensible range.
        self._zoom: float = 1.0
        self._zoom_min: float = 0.5
        self._zoom_max: float = 2.5

        # Pulse particles travelling along beams (orchestrator → agent).
        # Each is (agent_index_in_orbit, t_offset).
        self._pulses: List[Tuple[int, float]] = [
            (i % 6, (i * 0.18) % 1.0) for i in range(12)
        ]

        # Owl crest pixmap for the centre.
        self._owl_pixmap: Optional[QPixmap] = None
        try:
            owl_path = (
                Path(__file__).resolve().parents[3]
                / "icons"
                / "Page_icons"
                / "owl_agentic.png"
            )
            if owl_path.exists():
                pm = QPixmap(str(owl_path))
                if not pm.isNull():
                    self._owl_pixmap = pm
        except Exception:
            self._owl_pixmap = None

        # ~30 fps paint loop. Qt suspends paints when the widget is hidden,
        # so the cost is zero off-screen.
        self._timer = QTimer(self)
        self._timer.setInterval(33)
        self._timer.timeout.connect(self._tick)
        self._timer.start()

    # ------------------------------------------------------------------
    # Public API — compatible with what agents_page.py already calls
    # ------------------------------------------------------------------

    def set_agents(
        self,
        team: List[Dict[str, object]],
        *,
        orchestrator: Optional[str] = None,
    ) -> None:
        """Define the team. Each entry is a dict with at least 'name'.

        Optional keys: 'icon' (emoji), 'description' (str), 'skills' (list),
        'model_label' (str). Use ``orchestrator`` to mark which agent sits
        at the centre.
        """
        old_status = {n: a.status for n, a in self._agents.items()}
        self._agents.clear()
        self._orbit_order = []
        self._orchestrator_name = orchestrator

        for entry in team:
            name = str(entry.get("name", "")).strip()
            if not name:
                continue
            a = _Agent(
                name=name,
                icon=str(entry.get("icon", "") or "🤖"),
                description=str(entry.get("description", "") or ""),
                skills=list(entry.get("skills") or []),
                model_label=str(entry.get("model_label", "") or ""),
                is_orchestrator=(name == orchestrator),
                status=old_status.get(name, STATUS_IDLE),
            )
            self._agents[name] = a
            if not a.is_orchestrator:
                self._orbit_order.append(name)

        # Selection survives re-set if the agent still exists.
        if self._selected not in self._agents:
            self._selected = None
        self._recompute_depths()
        self.update()

    def set_edges(self, edges: List[Tuple[str, str]]) -> None:
        """Provide (source, target) connections. Recomputes BFS depths
        so deeper agents end up further from the centre (onion-ring
        effect). Edges with no connection to the orchestrator default
        to depth 1 — they sit on the inner ring just like before."""
        self._edges = [
            (str(a), str(b)) for a, b in (edges or []) if a and b
        ]
        self._recompute_depths()
        self.update()

    def set_team_info(self, name: str, description: str = "") -> None:
        """Metadata for the default team card shown when no agent
        is selected. Empty name disables the card and falls back to
        the simple bottom hint."""
        self._team_name = name or ""
        self._team_description = description or ""
        self.update()

    def _ensure_ring_motion(self, depths: List[int]) -> None:
        """Lazily assign a stable random rotation speed + phase offset
        to each ring depth. Called from _layout once the BFS depths
        are known, so a ring's spin rate doesn't change between
        frames — only new layers get a new rate."""
        import random as _random
        for d in depths:
            if d not in self._ring_speed:
                # Random magnitude in ~[0.10, 0.40] rad/tick, signed
                # randomly so some rings go clockwise and others
                # counter-clockwise. The orchestrator (depth 0) never
                # moves so it isn't seeded here.
                mag = 0.10 + _random.random() * 0.30
                sign = 1.0 if _random.random() < 0.5 else -1.0
                self._ring_speed[d] = mag * sign
                self._ring_phase[d] = _random.random() * math.tau

    def _recompute_depths(self) -> None:
        """Directed BFS over set_edges() starting at the orchestrator,
        following only OUTGOING edges. The layer of an agent is the
        number of dispatch hops it takes for input to flow from the
        orchestrator down to that agent.

        Why directed: an agent that gives feedback BACK to the
        orchestrator (e.g. `critic → orchestrator`) shouldn't be
        treated as a depth-1 sibling of the orchestrator's direct
        reports — the critic still receives its input through the
        chain (e.g. `orchestrator → researcher → coder → critic`),
        so it belongs on the corresponding deeper ring.

        Agents with no directed path from the orchestrator land on
        the outermost ring (max_real_depth + 1) so isolated /
        feedback-only agents don't collapse onto the inner ring.
        """
        self._depth = {}
        try:
            if not self._orchestrator_name or self._orchestrator_name not in self._agents:
                return
            # Directed adjacency: a -> b means a dispatches into b.
            adj: Dict[str, set] = {n: set() for n in self._agents}
            for a, b in self._edges:
                if a in adj and b in adj:
                    adj[a].add(b)
            from collections import deque
            seen = {self._orchestrator_name: 0}
            q = deque([self._orchestrator_name])
            while q:
                cur = q.popleft()
                d = seen[cur]
                for nb in adj.get(cur, ()):
                    if nb not in seen:
                        seen[nb] = d + 1
                        q.append(nb)
            # Orphan agents (no input path from the orchestrator) go
            # on the outermost ring, just past the deepest reachable
            # layer. The orchestrator itself stays at depth 0.
            max_real = max(seen.values()) if seen else 0
            for name in self._agents:
                if name not in seen:
                    seen[name] = max_real + 1
            self._depth = seen
        except Exception:
            self._depth = {}

    def set_node_status(self, name: str, status: str) -> None:
        if status not in _STATUS_FILL:
            status = STATUS_IDLE
        a = self._agents.get(name)
        if a is None or a.status == status:
            return
        a.status = status
        self.update()

    def set_node_icon(self, name: str, icon: str) -> None:
        a = self._agents.get(name)
        if a is None:
            return
        a.icon = icon or "🤖"
        self.update()

    def set_node_model_label(self, name: str, label: str) -> None:
        a = self._agents.get(name)
        if a is None:
            return
        a.model_label = label or ""
        self.update()

    def set_node_voice_label(self, name: str, label: str) -> None:
        """Mirror of :meth:`set_node_model_label` for the voice line. The
        agents page calls this whenever the per-agent voice changes so
        the painted character sheet reflects the active voice."""
        a = self._agents.get(name)
        if a is None:
            return
        a.voice_label = label or ""
        self.update()

    def reset_all_status(self) -> None:
        changed = False
        for a in self._agents.values():
            if a.status != STATUS_IDLE:
                a.status = STATUS_IDLE
                changed = True
        if changed:
            self.update()

    def select_agent(self, name: Optional[str]) -> None:
        if name is not None and name not in self._agents:
            return
        if self._selected == name:
            return
        self._selected = name
        self.update()
        if name is not None:
            self.node_selected.emit(name)

    # ------------------------------------------------------------------
    # Overlay model picker
    # ------------------------------------------------------------------

    def attach_card_picker(self, picker: Optional[QWidget]) -> None:
        """Mount the agents-page overlay model picker as our child.

        Parented here (and not at the canvas-stack level) because each
        canvas owns its own card geometry — the page hands one picker
        per canvas to keep state local. Pass ``None`` to detach."""
        # Drop any previous picker so we don't leak parented widgets.
        if self._card_picker is not None and self._card_picker is not picker:
            try:
                self._card_picker.setParent(None)
            except Exception:
                pass
        self._card_picker = picker
        if picker is not None:
            try:
                picker.setParent(self)
                picker.setVisible(False)
                picker.raise_()
            except Exception:
                pass

    def attach_super_user_card(self, card: Optional[QWidget]) -> None:
        """Mount the SuperUserCard as a canvas child so it renders as an
        overlay directly below the painted info / team card. Same
        parenting pattern as ``attach_card_picker``. Pass ``None`` to
        detach (e.g. when re-attaching to a different canvas)."""
        existing = getattr(self, "_super_user_card", None)
        if existing is not None and existing is not card:
            try:
                existing.setParent(None)
            except Exception:
                pass
        self._super_user_card = card
        if card is not None:
            try:
                card.setParent(self)
                card.setVisible(False)
                card.raise_()
            except Exception:
                pass

    def _position_card_picker(self, *, agent_card: bool, team_card: bool) -> None:
        """Move + show / hide the overlay picker so it sits inside the
        bottom of the painted card. Called from ``paintEvent`` so the
        overlay tracks resizes without an extra repaint pass."""
        picker = self._card_picker
        if picker is None:
            return
        if not (agent_card or team_card):
            picker.setVisible(False)
            return
        try:
            from desktop_app.widgets.agent_info_card import card_picker_geometry
            x, y, w, h = card_picker_geometry(self.width(), agent_card=agent_card)
        except Exception:
            picker.setVisible(False)
            return
        picker.setGeometry(int(x), int(y), int(w), int(h))
        picker.setVisible(True)
        picker.raise_()

    def _position_super_user_card(self, *, agent_card: bool,
                                  team_card: bool) -> None:
        """Place the Super User card overlay below the painted info /
        team card so the user-side controls stack visually with the
        agent's info on the same column."""
        card = getattr(self, "_super_user_card", None)
        if card is None:
            return
        try:
            from desktop_app.widgets.agent_info_card import super_user_card_geometry
            x, y, w, h = super_user_card_geometry(
                self.width(), self.height(),
                agent_card=agent_card, team_card=team_card,
            )
        except Exception:
            card.setVisible(False)
            return
        # Hide only if the canvas is so short there's literally no
        # room. The previous threshold (h < 80) silently hid the card
        # whenever the user clicked an agent (taller info card pushed
        # available space below the threshold), and the card never
        # came back. Showing a clipped card is strictly better than
        # silently disappearing.
        if h <= 0:
            card.setVisible(False)
            return
        card.setGeometry(int(x), int(y), int(w), int(h))
        card.setVisible(True)
        card.raise_()

    # ------------------------------------------------------------------
    # Animation tick
    # ------------------------------------------------------------------

    def _tick(self) -> None:
        # Free-running phase (no % math.tau). The previous wrap made
        # every sin/cos that multiplied phase by a non-integer (the
        # node pulse uses phase * 2.2) snap visibly because 2.2·tau
        # isn't a multiple of tau. Float64 handles years of uptime.
        self._phase += 0.012
        for i, (beam_i, t) in enumerate(self._pulses):
            t = (t + 0.011 + (beam_i % 3) * 0.001) % 1.0
            self._pulses[i] = (beam_i, t)
        self.update()

    # ------------------------------------------------------------------
    # Geometry — compute every node's position once per paint
    # ------------------------------------------------------------------

    def _layout(self) -> Tuple[QPointF, float, List[Tuple[str, QPointF]]]:
        rect = self.rect()
        # Shift the centre rightward past the info-card band so the
        # diagram doesn't end up half-covered by the top-left card.
        # The card occupies a ~410px-wide top-left strip; reserve up
        # to 35% of the canvas width for it and centre the diagram in
        # the remaining right portion.
        card_reserve = min(410.0, rect.width() * 0.35)
        cx = card_reserve + (rect.width() - card_reserve) / 2.0
        cy = rect.height() / 2.0

        # Apply the user's zoom multiplier to every geometry term so
        # the whole diagram scales as one. Info card / hint stay
        # absolute so the gamey UI doesn't grow grotesque at max zoom.
        zoom = max(self._zoom_min, min(self._zoom_max, self._zoom))
        radius = min(rect.width(), rect.height() * 1.5) * 0.30 * zoom
        radius = max(120.0 * zoom, radius)

        positions: List[Tuple[str, QPointF]] = []
        n = len(self._orbit_order)
        if n == 0:
            return QPointF(cx, cy), radius, positions

        rot = self._phase * 0.25  # slow orbital drift
        # Cap the outermost ring so it doesn't fly off the canvas edge.
        # The cap also scales with zoom but is absolutely bounded by
        # the visible canvas area minus a small margin so deep rings
        # don't disappear off the edges at max zoom.
        canvas_cap = min(rect.width() - card_reserve, rect.height()) * 0.45
        max_radius = min(canvas_cap, min(rect.width(), rect.height()) * 0.45 * zoom)

        # True concentric rings: group agents by BFS depth and give
        # each depth its OWN angle distribution within its ring.
        # When no edges exist (depth dict empty), every agent defaults
        # to depth 1 → single ring → identical to the original
        # single-ring behaviour. Fallback is safe.
        by_depth: Dict[int, List[str]] = {}
        for name in self._orbit_order:
            d = max(1, self._depth.get(name, 1))
            by_depth.setdefault(d, []).append(name)

        # Concentric ring layout. The user wants TWO independent
        # things and they must not interfere:
        #   1. A bigger empty area around the orchestrator crest so
        #      arrows pointing at it stay visible outside the owl.
        #   2. EQUAL spacing between consecutive rings (ring1↔ring2
        #      should equal ring2↔ring3, regardless of how big the
        #      centre area is).
        # Solution: ``inner_offset`` shifts every ring outward by
        # the same amount, so the gap *between* rings is purely
        # ``step``. Increasing the offset enlarges the centre WITHOUT
        # changing layer distances.
        max_depth = max(by_depth.keys()) if by_depth else 1
        # Centre clearance — a touch more than the orchestrator's hit
        # radius (90·zoom in _layout below) so ring 1 sits comfortably
        # outside the owl crest.
        inner_offset = 130.0 * zoom
        # Inter-ring gap. Falls back to a reasonable floor when there
        # are only one or two layers so we don't crowd the centre.
        step_budget = max_radius - inner_offset
        step = step_budget / max(1, max_depth)
        min_step = 90.0 * zoom
        if step < min_step:
            step = min_step
        # Cache for the visible-ring painter.
        self._ring_radii: List[float] = [
            inner_offset + step * d for d in sorted(by_depth.keys())
        ]

        # Make sure every visible layer has its own rotation rate.
        self._ensure_ring_motion(list(by_depth.keys()))

        # Distribute agents on each ring across an arc of 340° (not
        # the full 360°). The user's spec: agent ``i`` (1-indexed) sits
        # at ``i/n * 340°`` along the arc. So for n=2 → 170° / 340°,
        # for n=3 → 113.33° / 226.66° / 340°, etc. The 20° "missing
        # slice" still guarantees two agents on the same ring are
        # never exactly diametrically opposite, which kept connection
        # arrows from collapsing onto each other.
        arc_span = math.tau * 340.0 / 360.0

        for depth in sorted(by_depth.keys()):
            ring_agents = by_depth[depth]
            count = len(ring_agents)
            if count == 0:
                continue
            ring_radius = inner_offset + step * depth
            # Each layer spins at its own random rate so agents on
            # different rings don't stay aligned along the same
            # radial line (which previously made their connection
            # arrows hide behind each other). Speed and direction
            # are seeded once per layer in _ensure_ring_motion.
            speed = self._ring_speed.get(depth, 0.25)
            phase_off = self._ring_phase.get(depth, 0.0)
            ring_rot = self._phase * speed + phase_off
            for i, name in enumerate(ring_agents):
                if count == 1:
                    theta = ring_rot - math.pi / 2
                else:
                    theta = (arc_span * (i + 1)) / count + ring_rot - math.pi / 2
                x = cx + ring_radius * math.cos(theta)
                y = cy + ring_radius * math.sin(theta)
                pos = QPointF(x, y)
                positions.append((name, pos))
                agent = self._agents.get(name)
                if agent is not None:
                    agent.pos = pos

        # Cache orchestrator centre for hit-testing too. The hit /
        # arrow-termination radius is intentionally LARGER than the
        # owl crest icon — arrows that point at the orchestrator
        # stop here, well outside the owl, so the arrowhead stays
        # visible instead of getting masked by the icon. The icon
        # itself is drawn separately in _paint_centre and isn't
        # affected by this radius.
        if self._orchestrator_name and self._orchestrator_name in self._agents:
            self._agents[self._orchestrator_name].pos = QPointF(cx, cy)
            self._agents[self._orchestrator_name].radius = 90.0 * zoom

        return QPointF(cx, cy), radius, positions

    # ------------------------------------------------------------------
    # Painting
    # ------------------------------------------------------------------

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHints(
            QPainter.Antialiasing
            | QPainter.TextAntialiasing
            | QPainter.SmoothPixmapTransform
        )

        rect = self.rect()
        self._paint_background(p, rect)

        centre, radius, positions = self._layout()

        # Concentric rings (visible orbit paths) under everything else.
        self._paint_rings(p, centre)

        # Beams under nodes.
        self._paint_beams(p, centre, positions)

        # Orchestrator crest at the centre.
        self._paint_centre(p, centre, radius * 0.36)

        # Agent nodes on top of beams.
        self._paint_nodes(p, positions)

        # Top-left info card overlay.
        # Selected agent → that agent's card.
        # Otherwise, if team metadata was supplied → team-level card.
        # Otherwise → simple bottom hint.
        agent_card_visible = False
        team_card_visible = False
        # Use the SHARED renderers in agent_info_card so this canvas
        # and the editable graph view paint identical cards. Anything
        # canvas-specific (orbital ring, beams, nodes) stays here; the
        # info / team card visuals live in one place.
        try:
            from desktop_app.widgets.agent_info_card import (
                paint_agent_card, paint_team_card,
            )
        except Exception:
            paint_agent_card = paint_team_card = None  # type: ignore
        if self._selected is not None:
            agent = self._agents.get(self._selected)
            if agent is not None and paint_agent_card is not None:
                paint_agent_card(
                    p, rect,
                    name=agent.name,
                    icon=agent.icon or "🤖",
                    description=agent.description,
                    skills=list(agent.skills),
                    status=agent.status,
                    model_label=agent.model_label,
                    voice_label=agent.voice_label,
                )
                agent_card_visible = True
        elif self._team_name and self._agents and paint_team_card is not None:
            paint_team_card(
                p, rect,
                team_name=self._team_name,
                team_description=self._team_description,
                agent_count=len(self._agents),
                edge_count=len(self._edges),
                owl_pixmap=self._owl_pixmap,
            )
            team_card_visible = True
        elif self._agents:
            self._paint_hint(p, rect)

        # Now that we know which card (if any) is on screen, position
        # the overlay model picker inside it and announce the mode so
        # the page can re-bind the picker's value + signal routing.
        if agent_card_visible:
            mode = f"agent:{self._selected}"
        elif team_card_visible:
            mode = "team"
        else:
            mode = ""
        self._position_card_picker(agent_card=agent_card_visible,
                                   team_card=team_card_visible)
        self._position_super_user_card(agent_card=agent_card_visible,
                                       team_card=team_card_visible)
        if mode != self._last_card_mode:
            self._last_card_mode = mode
            try:
                self.selection_mode_changed.emit(mode)
            except Exception:
                pass

    def _paint_background(self, p: QPainter, rect) -> None:
        grad = QLinearGradient(0, 0, 0, rect.height())
        grad.setColorAt(0.0, _BG_GRAD_TOP)
        grad.setColorAt(1.0, _BG_GRAD_BOT)
        p.fillRect(rect, QBrush(grad))

        glow = QRadialGradient(
            QPointF(rect.width() / 2, rect.height() / 2),
            max(rect.width(), rect.height()) * 0.6,
        )
        glow.setColorAt(0.0, _alpha(_NEON_VIOLET, 22))
        glow.setColorAt(0.5, _alpha(_NEON_BLUE, 12))
        glow.setColorAt(1.0, _alpha(_BG_DARK, 0))
        p.fillRect(rect, QBrush(glow))

    def _paint_rings(self, p: QPainter, centre: QPointF) -> None:
        """Draw the concentric onion-ring orbital paths using the
        graph editor's LAYER_COLORS palette. Ring 1 (depth 1) =
        green, ring 2 = blue, ring 3 = red, ring 4 = orange, etc.
        — IDENTICAL ordering to AgentCanvas, so the orbital
        diagram and the graph view share one colour language.
        """
        if not self._ring_radii:
            return
        p.setBrush(Qt.NoBrush)
        for idx, r in enumerate(self._ring_radii):
            # idx 0 → ring 1 → layer 1, idx 1 → ring 2 → layer 2, …
            layer = idx + 1
            col = _layer_color(layer)
            pen = QPen(_alpha(col, 200), 1.6)
            pen.setCapStyle(Qt.RoundCap)
            p.setPen(pen)
            p.drawEllipse(centre, r, r)

    def _paint_beams(
        self,
        p: QPainter,
        centre: QPointF,
        positions: List[Tuple[str, QPointF]],
    ) -> None:
        # Spokes orchestrator → agent.
        for name, pos in positions:
            agent = self._agents.get(name)
            active = agent is not None and agent.status == STATUS_ACTIVE

            grad = QLinearGradient(centre, pos)
            if active:
                grad.setColorAt(0.0, _alpha(_NEON_GREEN, 230))
                grad.setColorAt(1.0, _alpha(_NEON_GREEN, 80))
                pen = QPen(QBrush(grad), 2.2)
            else:
                grad.setColorAt(0.0, _alpha(_NEON_CYAN, 110))
                grad.setColorAt(1.0, _alpha(_NEON_BLUE, 30))
                pen = QPen(QBrush(grad), 1.3)
            pen.setCapStyle(Qt.RoundCap)
            p.setPen(pen)
            p.drawLine(centre, pos)

        # Adjacent ring connections — softer dashed feel.
        n = len(positions)
        for i in range(n):
            a_name, a_pos = positions[i]
            b_name, b_pos = positions[(i + 1) % n]
            grad = QLinearGradient(a_pos, b_pos)
            grad.setColorAt(0.0, _alpha(_NEON_VIOLET, 70))
            grad.setColorAt(1.0, _alpha(_NEON_PINK, 70))
            pen = QPen(QBrush(grad), 1.0)
            pen.setStyle(Qt.DashLine)
            p.setPen(pen)
            p.drawLine(a_pos, b_pos)

        # Travelling light pulses on the spokes.
        for beam_i, t in self._pulses:
            if beam_i >= n:
                continue
            target_name, target_pos = positions[beam_i]
            agent = self._agents.get(target_name)
            colour = _NEON_GREEN if (agent and agent.status == STATUS_ACTIVE) else _mix(
                _NEON_CYAN, _NEON_VIOLET, t
            )
            x = centre.x() + (target_pos.x() - centre.x()) * t
            y = centre.y() + (target_pos.y() - centre.y()) * t
            # Alpha = 0 at t=0 AND t=1 so the t→1→0 wrap is invisible
            # (the pulse is fully transparent at the moment it
            # teleports back to the orchestrator).
            head_alpha = max(0, int(255 * math.sin(t * math.pi)))
            head_col = _alpha(colour, head_alpha)

            grad = QRadialGradient(QPointF(x, y), 16)
            grad.setColorAt(0.0, _alpha(head_col, 200))
            grad.setColorAt(1.0, _alpha(head_col, 0))
            p.setBrush(QBrush(grad))
            p.setPen(Qt.NoPen)
            p.drawEllipse(QPointF(x, y), 14, 14)
            p.setBrush(QBrush(head_col))
            p.drawEllipse(QPointF(x, y), 3.0, 3.0)

        # Directed arrows for explicit edges supplied by set_edges().
        if self._edges:
            self._paint_edge_arrows(p, positions)

    def _paint_edge_arrows(
        self,
        p: QPainter,
        positions: List[Tuple[str, QPointF]],
    ) -> None:
        """Render every (src, dst) from set_edges as a directed
        line + arrowhead between the two agents' current positions.

        Edges from the orchestrator are styled DIFFERENTLY from
        edges between specialists — the orchestrator can dispatch
        to anyone (free), so its edges read as implicit (dashed,
        no arrowhead, faded). Specialist → specialist edges are
        the strict chain enforced by graph_resolver and render as
        solid arrows."""
        pos_by_name: Dict[str, QPointF] = {n: pos for n, pos in positions}
        if self._orchestrator_name and self._orchestrator_name in self._agents:
            pos_by_name[self._orchestrator_name] = self._agents[self._orchestrator_name].pos

        for src, dst in self._edges:
            a = pos_by_name.get(src)
            b = pos_by_name.get(dst)
            if a is None or b is None:
                continue
            ar = self._agents[src].radius if src in self._agents else 22.0
            br = self._agents[dst].radius if dst in self._agents else 22.0
            dx = b.x() - a.x()
            dy = b.y() - a.y()
            dist = max(1.0, math.hypot(dx, dy))
            ux, uy = dx / dist, dy / dist
            start = QPointF(a.x() + ux * ar, a.y() + uy * ar)
            end = QPointF(b.x() - ux * br, b.y() - uy * br)

            sa = self._agents[src].status if src in self._agents else STATUS_IDLE
            da = self._agents[dst].status if dst in self._agents else STATUS_IDLE
            both_active = sa == STATUS_ACTIVE and da == STATUS_ACTIVE
            # Graph editor convention: an edge inherits the colour of
            # its TARGET node's layer — same code path as
            # AgentEdgeItem._palette() in agent_canvas.py. So the
            # arrow into a green-layer agent reads green, into a
            # blue-layer agent reads blue, etc.
            dst_layer = self._depth.get(dst, 0)
            edge_col = _layer_color(dst_layer)
            implicit = (src == self._orchestrator_name)
            if implicit:
                # Orchestrator can dispatch to anyone — render this as
                # a faded dashed line with no arrowhead so it doesn't
                # imply enforcement.
                pen = QPen(_alpha(edge_col, 110), 1.2)
                pen.setStyle(Qt.DashLine)
            else:
                edge_alpha = 240 if both_active else 210
                pen_w = 2.2 if both_active else 1.6
                pen = QPen(_alpha(edge_col, edge_alpha), pen_w)
            pen.setCapStyle(Qt.RoundCap)
            p.setPen(pen)
            p.drawLine(start, end)

            if implicit:
                continue  # no arrowhead on implicit edges

            zoom = max(self._zoom_min, min(self._zoom_max, self._zoom))
            head_len = 9.0 * zoom
            head_angle = math.radians(28)
            angle = math.atan2(uy, ux)
            for sign in (-1, 1):
                ah_a = angle + math.pi - sign * head_angle
                hx = end.x() + math.cos(ah_a) * head_len
                hy = end.y() + math.sin(ah_a) * head_len
                p.drawLine(end, QPointF(hx, hy))

    def _paint_centre(self, p: QPainter, centre: QPointF, r: float) -> None:
        cx, cy = centre.x(), centre.y()

        # Orchestrator is layer 0 → ALWAYS gold, matching the graph
        # editor's LAYER_COLORS palette and the gold ring + halo used
        # for the orchestrator there. When the orchestrator is mid-run
        # we still flash green so the "active" status reads, but idle /
        # pending / error all stay in the gold family.
        gold_core = QColor("#f1c44a")
        gold_glow = QColor("#ffd76a")
        orch = (
            self._agents.get(self._orchestrator_name)
            if self._orchestrator_name
            else None
        )
        active = orch is not None and orch.status == STATUS_ACTIVE

        # Outer rotating ring — gold instead of cyan.
        outer = QRectF(cx - r, cy - r, r * 2, r * 2)
        pen = QPen(_alpha(gold_core, 230), 2.6)
        p.setPen(pen)
        p.setBrush(Qt.NoBrush)
        start_deg = -int(math.degrees(self._phase * 0.9)) % 360
        for arc_offset in (0, 130, 240):
            p.drawArc(outer, (start_deg + arc_offset) * 16, 60 * 16)

        # Inner counter-rotating ring — also gold (slightly warmer).
        inner = QRectF(cx - r * 0.7, cy - r * 0.7, r * 1.4, r * 1.4)
        pen2 = QPen(_alpha(gold_glow, 210), 2.0)
        p.setPen(pen2)
        start_deg2 = int(math.degrees(self._phase * 1.6)) % 360
        for arc_offset in (0, 110, 230):
            p.drawArc(inner, (start_deg2 + arc_offset) * 16, 70 * 16)

        # Soft glowing core — gold when idle/pending/error, green when
        # actively running so live state still reads.
        core_a = _NEON_GREEN if active else gold_glow
        core_b = _NEON_GREEN if active else gold_core
        pulse = 0.5 + 0.5 * math.sin(self._phase * 2.6)
        core = QRadialGradient(QPointF(cx, cy), r * 0.8)
        core.setColorAt(0.0, _alpha(core_a, int(110 + 70 * pulse)))
        core.setColorAt(0.6, _alpha(core_b, int(50 + 40 * pulse)))
        core.setColorAt(1.0, _alpha(_BG_DARK, 0))
        p.setBrush(QBrush(core))
        p.setPen(Qt.NoPen)
        p.drawEllipse(QPointF(cx, cy), r * 0.78, r * 0.78)

        # Centre icon — render the ORCHESTRATOR agent's own icon
        # (whatever the user picked in the Studio) instead of a static
        # crest. Falls back to the bundled owl_agentic crest, then to
        # the 🦉 emoji, so the diagram always renders something.
        target = r * 1.4 * 0.8
        from desktop_app.widgets.agent_icons import resolve_pixmap as _resolve_pm
        orch_pm = None
        orch_icon = None
        if self._orchestrator_name and self._orchestrator_name in self._agents:
            orch_icon = self._agents[self._orchestrator_name].icon or ""
            orch_pm = _resolve_pm(orch_icon)
        crest_pm = orch_pm if orch_pm is not None else self._owl_pixmap

        if crest_pm is not None and not crest_pm.isNull():
            scaled = crest_pm.scaled(
                int(target),
                int(target),
                Qt.KeepAspectRatio,
                Qt.SmoothTransformation,
            )
            p.drawPixmap(
                QPointF(cx - scaled.width() / 2, cy - scaled.height() / 2),
                scaled,
            )
        else:
            from desktop_app.widgets.agent_icons import paint_icon as _paint_icon
            font = QFont()
            font.setPointSizeF(max(20.0, r * 0.85))
            p.setFont(font)
            p.setPen(_TEXT_BRIGHT)
            glyph_rect = QRectF(cx - r, cy - r, r * 2, r * 2)
            _paint_icon(p, glyph_rect, orch_icon or "🦉")

        # Orchestrator label below the crest.
        if self._orchestrator_name:
            font = QFont()
            font.setPointSize(10)
            font.setBold(True)
            p.setFont(font)
            p.setPen(_TEXT_BRIGHT)
            label_rect = QRectF(cx - 100, cy + r + 6, 200, 20)
            p.drawText(label_rect, Qt.AlignCenter, self._orchestrator_name)

    def _paint_nodes(
        self, p: QPainter, positions: List[Tuple[str, QPointF]]
    ) -> None:
        for i, (name, pos) in enumerate(positions):
            agent = self._agents.get(name)
            if agent is None:
                continue
            phase_offset = i * 0.7
            pulse = 0.5 + 0.5 * math.sin(self._phase * 2.2 + phase_offset)
            # Scale the agent disc radius with the user's zoom so
            # nodes stay proportional to the rings they sit on.
            zoom = max(self._zoom_min, min(self._zoom_max, self._zoom))
            r = (22 + 4 * pulse) * zoom
            agent.radius = r

            is_selected = self._selected == name
            is_hover = self._hover == name
            is_active = agent.status == STATUS_ACTIVE

            # Halo. When the agent is doing work the status colour
            # wins (green/amber/red) so the visual cue is unambiguous.
            # Otherwise the halo borrows this agent's LAYER colour
            # (same palette as the rings + edges) so each layer's
            # agents share a chromatic family.
            agent_depth = self._depth.get(name, 1)
            layer_col = _layer_color(agent_depth)
            if agent.status == STATUS_IDLE:
                halo_col = layer_col
            else:
                halo_col = _STATUS_HALO[agent.status]
            grad = QRadialGradient(pos, r * 2.4)
            halo_alpha = (
                int(120 + 90 * pulse) if is_active else int(70 + 50 * pulse)
            )
            grad.setColorAt(0.0, _alpha(halo_col, halo_alpha))
            grad.setColorAt(1.0, _alpha(halo_col, 0))
            p.setBrush(QBrush(grad))
            p.setPen(Qt.NoPen)
            p.drawEllipse(pos, r * 2.0, r * 2.0)

            # Core disc.
            fill = _STATUS_FILL[agent.status]
            if agent.status == STATUS_IDLE:
                # gradient by index so idle agents aren't all identical
                fill = _mix(
                    _NEON_BLUE,
                    _NEON_VIOLET,
                    i / max(1, len(positions)),
                )
            p.setBrush(QBrush(fill))

            border_col = _TEXT_BRIGHT if is_selected else _alpha(
                _TEXT_BRIGHT, 220
            )
            border_w = 2.6 if is_selected else (2.0 if is_hover else 1.6)
            p.setPen(QPen(border_col, border_w))
            p.drawEllipse(pos, r, r)

            # Icon (emoji or owl PNG) inside the disc.
            from desktop_app.widgets.agent_icons import paint_icon as _paint_icon
            font = QFont()
            font.setPointSizeF(r * 0.85)
            p.setFont(font)
            p.setPen(_TEXT_BRIGHT)
            icon_rect = QRectF(pos.x() - r, pos.y() - r, r * 2, r * 2)
            _paint_icon(p, icon_rect, agent.icon)

            # Label below the node — agent name + a tiny status word when
            # not idle (Working / Pending / Error).
            label_font = QFont()
            label_font.setPointSize(9)
            label_font.setBold(True)
            p.setFont(label_font)
            p.setPen(_TEXT_BRIGHT)
            label_rect = QRectF(pos.x() - 90, pos.y() + r + 4, 180, 16)
            p.drawText(label_rect, Qt.AlignCenter, name)

            if agent.status != STATUS_IDLE:
                status_word = {
                    STATUS_ACTIVE: "● Working",
                    STATUS_PENDING: "● Pending",
                    STATUS_ERROR: "● Error",
                }[agent.status]
                status_col = {
                    STATUS_ACTIVE: _NEON_GREEN,
                    STATUS_PENDING: _NEON_AMBER,
                    STATUS_ERROR: _NEON_RED,
                }[agent.status]
                sf = QFont()
                sf.setPointSize(8)
                p.setFont(sf)
                p.setPen(status_col)
                status_rect = QRectF(pos.x() - 90, pos.y() + r + 20, 180, 14)
                p.drawText(status_rect, Qt.AlignCenter, status_word)

    def _paint_hint(self, p: QPainter, rect) -> None:
        font = QFont()
        font.setPointSize(10)
        font.setItalic(True)
        p.setFont(font)
        p.setPen(_TEXT_DIM)
        hint_rect = QRectF(0, rect.height() - 28, rect.width(), 24)
        p.drawText(hint_rect, Qt.AlignCenter, "Click an agent to see its skills")

    # ------------------------------------------------------------------
    # Mouse interaction
    # ------------------------------------------------------------------

    def _hit_test(self, pos: QPoint) -> Optional[str]:
        """Return the agent name under ``pos``. Orbit agents win on
        overlap so they aren't masked by the orchestrator's hit area
        when rings sit close to the centre on a small canvas.
        """
        for name, agent in self._agents.items():
            if agent.is_orchestrator:
                continue
            r = agent.radius + 6
            dx = pos.x() - agent.pos.x()
            dy = pos.y() - agent.pos.y()
            if dx * dx + dy * dy <= r * r:
                return name
        # Orchestrator last so the user can click the centre crest to
        # see its info card.
        if self._orchestrator_name and self._orchestrator_name in self._agents:
            agent = self._agents[self._orchestrator_name]
            r = agent.radius + 8
            dx = pos.x() - agent.pos.x()
            dy = pos.y() - agent.pos.y()
            if dx * dx + dy * dy <= r * r:
                return self._orchestrator_name
        return None

    def mouseMoveEvent(self, event):  # noqa: N802
        hit = self._hit_test(event.position().toPoint())
        if hit != self._hover:
            self._hover = hit
            self.update()
        if hit is not None:
            self.setCursor(QCursor(Qt.PointingHandCursor))
        else:
            self.setCursor(QCursor(Qt.ArrowCursor))
        super().mouseMoveEvent(event)

    def mousePressEvent(self, event):  # noqa: N802
        if event.button() != Qt.LeftButton:
            super().mousePressEvent(event)
            return
        hit = self._hit_test(event.position().toPoint())
        if hit is not None:
            # Clicking the same agent again toggles the card off.
            if self._selected == hit:
                self._selected = None
                self.update()
            else:
                self._selected = hit
                self.update()
                self.node_selected.emit(hit)
        else:
            # Clicking empty area dismisses the info card.
            if self._selected is not None:
                self._selected = None
                self.update()
        super().mousePressEvent(event)

    def leaveEvent(self, event: QEvent) -> None:  # noqa: N802
        if self._hover is not None:
            self._hover = None
            self.update()
        super().leaveEvent(event)

    def wheelEvent(self, event) -> None:  # noqa: N802
        """Mouse wheel = zoom. ~10% per notch, clamped to
        [self._zoom_min, self._zoom_max]. Same gesture the
        AgentCanvas graph editor uses, so the two views feel
        consistent.
        """
        delta = event.angleDelta().y()
        if delta == 0:
            event.ignore()
            return
        factor = 1.10 if delta > 0 else (1.0 / 1.10)
        new_zoom = self._zoom * factor
        new_zoom = max(self._zoom_min, min(self._zoom_max, new_zoom))
        if abs(new_zoom - self._zoom) < 1e-3:
            event.accept()
            return
        self._zoom = new_zoom
        self.update()
        event.accept()
