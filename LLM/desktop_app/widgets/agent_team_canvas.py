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
import sys
import traceback
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


@dataclass
class _Agent:
    """Per-agent state held by the canvas."""

    name: str
    icon: str = "🤖"
    description: str = ""
    skills: List[str] = field(default_factory=list)
    model_label: str = ""
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

        # Edges: (from_name, to_name) — passed in via set_edges() from
        # the saved AgentGraph. Used both for arrow rendering and for
        # the BFS-depth ring layout (onion-ring style).
        self._edges: List[Tuple[str, str]] = []
        # Per-agent BFS depth from orchestrator (1 = directly connected,
        # 2 = two hops away, etc). Recomputed on set_agents / set_edges.
        # Orphan agents (no path to orchestrator) get a sentinel max
        # depth so they sit on the outermost ring.
        self._depth: Dict[str, int] = {}

        # Team-level metadata (shown in the default info card when no
        # agent is selected). Populated via set_team_info.
        self._team_name: str = ""
        self._team_description: str = ""
        self._team_icon: str = "🧠"

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
        """Set the (from, to) connections used for arrow rendering and
        for the onion-ring depth layout."""
        self._edges = [
            (str(a), str(b)) for a, b in (edges or []) if a and b
        ]
        self._recompute_depths()
        self.update()

    def set_team_info(
        self,
        name: str,
        description: str = "",
        icon: str = "",
    ) -> None:
        """Provide metadata for the team-level card shown when no agent
        is selected. Empty name disables the team card and falls back to
        the simple 'Click an agent…' hint."""
        self._team_name = name or ""
        self._team_description = description or ""
        if icon:
            self._team_icon = icon
        self.update()

    def _recompute_depths(self) -> None:
        """BFS from the orchestrator over self._edges. Depth 0 is the
        orchestrator; 1 = directly connected; etc. Disconnected agents
        get a sentinel large depth so they sit on the outermost ring.
        """
        self._depth.clear()
        if not self._orchestrator_name or self._orchestrator_name not in self._agents:
            return
        # Build undirected adjacency — connections in either direction
        # count for layout (the arrows themselves still respect
        # direction).
        adj: Dict[str, set] = {n: set() for n in self._agents}
        for a, b in self._edges:
            if a in adj and b in adj:
                adj[a].add(b)
                adj[b].add(a)

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
        # Orphans get a depth larger than any real depth.
        max_real = max(seen.values()) if seen else 0
        for name in self._agents:
            self._depth[name] = seen.get(name, max_real + 1)

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
    # Animation tick
    # ------------------------------------------------------------------

    def _tick(self) -> None:
        # Free-running phase — DON'T wrap at math.tau. The previous
        # ``% math.tau`` made every sin/cos that multiplied phase by a
        # non-integer (the agent pulse uses ``phase * 2.2``) snap
        # visibly when the phase wrapped, because 2.2 * tau isn't a
        # multiple of tau. A monotonically increasing float is fine
        # for double-precision over multi-day uptimes.
        self._phase += 0.012
        for i, (beam_i, t) in enumerate(self._pulses):
            t = (t + 0.011 + (beam_i % 3) * 0.001) % 1.0
            self._pulses[i] = (beam_i, t)
        self.update()

    # ------------------------------------------------------------------
    # Geometry — compute every node's position once per paint
    # ------------------------------------------------------------------

    def _layout(self) -> Tuple[QPointF, float, List[Tuple[str, QPointF]]]:
        """Onion-ring layout: agents grouped by BFS-depth from the
        orchestrator, each depth on its own concentric ring. Falls
        back to a single ring when no edges are known.
        """
        rect = self.rect()
        cx = rect.width() / 2.0
        cy = rect.height() / 2.0
        # Base ring radius — smaller than before so we have room for
        # multiple onion rings on bigger teams.
        base_radius = min(rect.width(), rect.height() * 1.5) * 0.22
        base_radius = max(110.0, base_radius)

        positions: List[Tuple[str, QPointF]] = []
        n = len(self._orbit_order)
        if n == 0:
            # Orchestrator may still need its position cached.
            if self._orchestrator_name and self._orchestrator_name in self._agents:
                self._agents[self._orchestrator_name].pos = QPointF(cx, cy)
                self._agents[self._orchestrator_name].radius = 56.0
            return QPointF(cx, cy), base_radius, positions

        # Group orbit agents by their BFS depth.
        by_depth: Dict[int, List[str]] = {}
        for name in self._orbit_order:
            d = max(1, self._depth.get(name, 1))
            by_depth.setdefault(d, []).append(name)

        # Each successive ring lives at a slightly larger radius. We
        # use a sub-linear growth so depth 5 doesn't fall off the edge
        # of the canvas.
        rot = self._phase * 0.25  # slow orbital drift
        max_depth = max(by_depth.keys()) if by_depth else 1
        for depth in sorted(by_depth.keys()):
            ring_radius = base_radius * (1.0 + 0.55 * (depth - 1))
            # Cap radius to fit inside the widget.
            ring_radius = min(
                ring_radius,
                min(rect.width(), rect.height()) * 0.45,
            )

            ring_agents = by_depth[depth]
            count = len(ring_agents)
            # Counter-rotate alternating rings so the layout doesn't
            # feel like every layer spins the same direction.
            ring_rot = rot * (1 if depth % 2 == 1 else -0.6)
            for i, name in enumerate(ring_agents):
                theta = (math.tau * i) / max(1, count) + ring_rot - math.pi / 2
                x = cx + ring_radius * math.cos(theta)
                y = cy + ring_radius * math.sin(theta)
                pos = QPointF(x, y)
                positions.append((name, pos))
                agent = self._agents.get(name)
                if agent is not None:
                    agent.pos = pos

        # Cache orchestrator centre for hit-testing.
        if self._orchestrator_name and self._orchestrator_name in self._agents:
            self._agents[self._orchestrator_name].pos = QPointF(cx, cy)
            self._agents[self._orchestrator_name].radius = 56.0

        return QPointF(cx, cy), base_radius, positions

    # ------------------------------------------------------------------
    # Painting
    # ------------------------------------------------------------------

    def paintEvent(self, event) -> None:  # noqa: N802
        # Each stage is wrapped in try/except so a failure in one stage
        # (e.g. a Qt arg-type quirk in the rotating-rings draw code)
        # doesn't cascade and hide the agent nodes / orchestrator crest
        # that follow it. Stack traces dump to stderr so the next run
        # reports the actual culprit instead of silently rendering
        # only edge arrows.
        p = QPainter(self)
        p.setRenderHints(
            QPainter.Antialiasing
            | QPainter.TextAntialiasing
            | QPainter.SmoothPixmapTransform
        )
        rect = self.rect()

        def _safe(stage_name: str, fn) -> None:
            try:
                fn()
            except Exception:
                sys.stderr.write(
                    f"[AgentTeamCanvas] {stage_name} failed:\n"
                )
                traceback.print_exc(file=sys.stderr)

        _safe("background", lambda: self._paint_background(p, rect))

        # Layout is critical — if it fails we still want a fallback so
        # the user sees something instead of an empty void.
        try:
            centre, radius, positions = self._layout()
        except Exception:
            sys.stderr.write("[AgentTeamCanvas] _layout failed:\n")
            traceback.print_exc(file=sys.stderr)
            centre = QPointF(rect.width() / 2.0, rect.height() / 2.0)
            radius = 110.0
            positions = []

        _safe("beams", lambda: self._paint_beams(p, centre, positions))
        _safe("centre", lambda: self._paint_centre(p, centre, radius * 0.36))
        _safe("nodes", lambda: self._paint_nodes(p, positions))

        # Top-left info card.
        def _draw_info_card() -> None:
            if self._selected is not None:
                agent = self._agents.get(self._selected)
                if agent is not None:
                    self._paint_info_card(p, rect, agent)
            elif self._team_name:
                self._paint_team_card(p, rect)
            elif self._agents:
                self._paint_hint(p, rect)

        _safe("info card", _draw_info_card)

        # Always-visible identity banner. Until the user confirms the
        # orbital widget is actually the one being painted (the
        # previous symptom looked suspiciously like the AgentCanvas
        # graph editor showing through the QStackedWidget), this is
        # the cheapest signal: if the user sees "TEAM DIAGRAM" then
        # team_canvas is alive; if they don't, the wrong widget is on
        # top. The banner sits in the top-right corner with neon
        # styling so it's hard to miss.
        try:
            badge_w = 170.0
            badge_h = 26.0
            badge = QRectF(rect.width() - badge_w - 12, 10, badge_w, badge_h)
            bg = QLinearGradient(badge.topLeft(), badge.topRight())
            bg.setColorAt(0.0, _alpha(_NEON_CYAN, 60))
            bg.setColorAt(1.0, _alpha(_NEON_VIOLET, 60))
            p.setBrush(QBrush(bg))
            p.setPen(QPen(_alpha(_NEON_CYAN, 220), 1.2))
            p.drawRoundedRect(badge, 8, 8)
            font = QFont()
            font.setPointSize(9)
            font.setBold(True)
            p.setFont(font)
            p.setPen(_TEXT_BRIGHT)
            p.drawText(badge, Qt.AlignCenter, "● TEAM DIAGRAM")
        except Exception:
            pass

        # Visible-state diagnostic line beneath the banner — counts so
        # we can tell at a glance whether the canvas has data. If
        # 'agents:0' shows here, the page hasn't pushed the team in
        # yet; if it shows non-zero but no nodes render, the bug is
        # in the per-node draw code.
        try:
            diag = (
                f"agents:{len(self._agents)}  "
                f"orbit:{len(self._orbit_order)}  "
                f"edges:{len(self._edges)}  "
                f"orch:{self._orchestrator_name or '—'}"
            )
            font = QFont()
            font.setPointSize(8)
            p.setFont(font)
            p.setPen(_alpha(_TEXT_DIM, 200))
            p.drawText(
                QRectF(rect.width() - 320, 40, 308, 14),
                Qt.AlignRight | Qt.AlignVCenter,
                diag,
            )
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

        # Explicit edges from set_edges() — render as directed arrows.
        # We draw these AFTER spokes so they sit on top, and the
        # arrowhead at the destination shows direction. Edges that
        # involve the orchestrator are skipped (the spokes already
        # cover that visually).
        if self._edges:
            self._paint_edge_arrows(p, positions)

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
            # Alpha = 0 at t=0 AND t=1 so the pulse fades in at the
            # orchestrator and out at the agent — the wrap from
            # t=1→0 becomes invisible because the pulse is fully
            # transparent at both endpoints.
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

    def _paint_edge_arrows(
        self,
        p: QPainter,
        positions: List[Tuple[str, QPointF]],
    ) -> None:
        """Render every set_edges() entry as a directed arrow."""
        # Build a quick name→pos lookup including the orchestrator
        # at the centre (so edges to/from the orchestrator render too,
        # not only inter-orbit edges).
        pos_by_name: Dict[str, QPointF] = {n: pos for n, pos in positions}
        if self._orchestrator_name and self._orchestrator_name in self._agents:
            pos_by_name[self._orchestrator_name] = self._agents[self._orchestrator_name].pos

        for src, dst in self._edges:
            a = pos_by_name.get(src)
            b = pos_by_name.get(dst)
            if a is None or b is None:
                continue
            # Pull the arrow's start and end IN by each node's radius
            # so the line stops at the disc edge instead of the
            # centre. Hit-test radius lives on the agent.
            ar = self._agents[src].radius if src in self._agents else 22.0
            br = self._agents[dst].radius if dst in self._agents else 22.0
            dx = b.x() - a.x()
            dy = b.y() - a.y()
            dist = max(1.0, math.hypot(dx, dy))
            ux, uy = dx / dist, dy / dist
            start = QPointF(a.x() + ux * ar, a.y() + uy * ar)
            end = QPointF(b.x() - ux * br, b.y() - uy * br)

            # Both ends active → green; otherwise violet/pink.
            sa = self._agents[src].status if src in self._agents else STATUS_IDLE
            da = self._agents[dst].status if dst in self._agents else STATUS_IDLE
            both_active = sa == STATUS_ACTIVE and da == STATUS_ACTIVE
            grad = QLinearGradient(start, end)
            if both_active:
                grad.setColorAt(0.0, _alpha(_NEON_GREEN, 220))
                grad.setColorAt(1.0, _alpha(_NEON_GREEN, 120))
                pen_w = 2.0
            else:
                grad.setColorAt(0.0, _alpha(_NEON_VIOLET, 170))
                grad.setColorAt(1.0, _alpha(_NEON_PINK, 170))
                pen_w = 1.4
            pen = QPen(QBrush(grad), pen_w)
            pen.setCapStyle(Qt.RoundCap)
            p.setPen(pen)
            p.drawLine(start, end)

            # Arrowhead at end. Two short lines flaring back from the tip.
            head_len = 9.0
            head_angle = math.radians(28)
            angle = math.atan2(uy, ux)
            for sign in (-1, 1):
                ah_a = angle + math.pi - sign * head_angle
                hx = end.x() + math.cos(ah_a) * head_len
                hy = end.y() + math.sin(ah_a) * head_len
                p.drawLine(end, QPointF(hx, hy))

    def _paint_centre(self, p: QPainter, centre: QPointF, r: float) -> None:
        cx, cy = centre.x(), centre.y()

        # Outer rotating ring.
        outer = QRectF(cx - r, cy - r, r * 2, r * 2)
        pen = QPen(_alpha(_NEON_CYAN, 220), 2.4)
        p.setPen(pen)
        p.setBrush(Qt.NoBrush)
        start_deg = -int(math.degrees(self._phase * 0.9)) % 360
        for arc_offset in (0, 130, 240):
            p.drawArc(outer, (start_deg + arc_offset) * 16, 60 * 16)

        # Inner counter-rotating ring.
        inner = QRectF(cx - r * 0.7, cy - r * 0.7, r * 1.4, r * 1.4)
        pen2 = QPen(_alpha(_NEON_VIOLET, 200), 1.8)
        p.setPen(pen2)
        start_deg2 = int(math.degrees(self._phase * 1.6)) % 360
        for arc_offset in (0, 110, 230):
            p.drawArc(inner, (start_deg2 + arc_offset) * 16, 70 * 16)

        # Soft glowing core.
        # If the orchestrator agent is "active", the core glows green.
        orch = (
            self._agents.get(self._orchestrator_name)
            if self._orchestrator_name
            else None
        )
        active = orch is not None and orch.status == STATUS_ACTIVE
        core_a = _NEON_GREEN if active else _NEON_CYAN
        core_b = _NEON_GREEN if active else _NEON_BLUE
        pulse = 0.5 + 0.5 * math.sin(self._phase * 2.6)
        core = QRadialGradient(QPointF(cx, cy), r * 0.8)
        core.setColorAt(0.0, _alpha(core_a, int(80 + 60 * pulse)))
        core.setColorAt(0.6, _alpha(core_b, int(30 + 30 * pulse)))
        core.setColorAt(1.0, _alpha(_BG_DARK, 0))
        p.setBrush(QBrush(core))
        p.setPen(Qt.NoPen)
        p.drawEllipse(QPointF(cx, cy), r * 0.78, r * 0.78)

        # Owl crest pixmap (with emoji fallback).
        if self._owl_pixmap is not None and not self._owl_pixmap.isNull():
            target = r * 1.4
            scaled = self._owl_pixmap.scaled(
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
            font = QFont()
            font.setPointSizeF(max(20.0, r * 0.85))
            p.setFont(font)
            p.setPen(_TEXT_BRIGHT)
            glyph_rect = QRectF(cx - r, cy - r, r * 2, r * 2)
            p.drawText(glyph_rect, Qt.AlignCenter, "🦉")

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
            r = 22 + 4 * pulse  # bigger than loader nodes — easier to click
            agent.radius = r

            is_selected = self._selected == name
            is_hover = self._hover == name
            is_active = agent.status == STATUS_ACTIVE

            # Halo. Bright green when working; subtle cyan otherwise.
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

            # Icon (emoji) inside the disc.
            font = QFont()
            font.setPointSizeF(r * 0.85)
            p.setFont(font)
            p.setPen(_TEXT_BRIGHT)
            icon_rect = QRectF(pos.x() - r, pos.y() - r, r * 2, r * 2)
            p.drawText(icon_rect, Qt.AlignCenter, agent.icon or "🤖")

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

    def _paint_team_card(self, p: QPainter, rect) -> None:
        """Top-left card describing the team itself, shown when no agent
        is selected. Same gamey character-sheet treatment as the per-
        agent card so the visual language stays consistent.
        """
        margin = 14
        card_w = min(380, rect.width() - 2 * margin)
        card_h = 200
        card = QRectF(margin, margin, card_w, card_h)

        # Background.
        bg = QLinearGradient(card.topLeft(), card.bottomRight())
        bg.setColorAt(0.0, QColor(18, 22, 34, 230))
        bg.setColorAt(1.0, QColor(8, 11, 18, 230))
        p.setBrush(QBrush(bg))
        border_grad = QLinearGradient(card.topLeft(), card.bottomRight())
        border_grad.setColorAt(0.0, _alpha(_NEON_CYAN, 220))
        border_grad.setColorAt(1.0, _alpha(_NEON_VIOLET, 220))
        p.setPen(QPen(QBrush(border_grad), 1.6))
        p.drawRoundedRect(card, 12, 12)

        # Top ribbon — "TEAM".
        ribbon = QRectF(card.x() + 8, card.y() + 8, card.width() - 16, 22)
        rg = QLinearGradient(ribbon.topLeft(), ribbon.topRight())
        rg.setColorAt(0.0, _alpha(_NEON_CYAN, 60))
        rg.setColorAt(1.0, _alpha(_NEON_VIOLET, 10))
        p.setBrush(QBrush(rg))
        p.setPen(QPen(_alpha(_NEON_CYAN, 120), 1))
        p.drawRoundedRect(ribbon, 6, 6)
        rib_font = QFont()
        rib_font.setPointSize(9)
        rib_font.setBold(True)
        p.setFont(rib_font)
        p.setPen(_TEXT_BRIGHT)
        p.drawText(
            ribbon.adjusted(10, 0, -10, 0),
            Qt.AlignVCenter | Qt.AlignLeft,
            "● TEAM",
        )

        # Picture (left): the team icon at large size.
        pic_x = card.x() + 14
        pic_y = card.y() + 38
        pic_size = 100.0
        pic_rect = QRectF(pic_x, pic_y, pic_size, pic_size)
        ring = QRadialGradient(pic_rect.center(), pic_size * 0.7)
        ring.setColorAt(0.0, _alpha(_NEON_CYAN, 110))
        ring.setColorAt(1.0, _alpha(_NEON_CYAN, 0))
        p.setBrush(QBrush(ring))
        p.setPen(Qt.NoPen)
        p.drawEllipse(pic_rect.adjusted(-6, -6, 6, 6))
        p.setBrush(QBrush(QColor(30, 36, 52)))
        p.setPen(QPen(_alpha(_TEXT_BRIGHT, 200), 1.4))
        p.drawEllipse(pic_rect)

        # Use the orchestrator's owl crest if available, otherwise the
        # team icon emoji.
        if self._owl_pixmap is not None and not self._owl_pixmap.isNull():
            target = pic_size * 0.85
            scaled = self._owl_pixmap.scaled(
                int(target), int(target),
                Qt.KeepAspectRatio, Qt.SmoothTransformation,
            )
            p.drawPixmap(
                QPointF(
                    pic_rect.center().x() - scaled.width() / 2,
                    pic_rect.center().y() - scaled.height() / 2,
                ),
                scaled,
            )
        else:
            icon_font = QFont()
            icon_font.setPointSizeF(pic_size * 0.65)
            p.setFont(icon_font)
            p.setPen(_TEXT_BRIGHT)
            p.drawText(pic_rect, Qt.AlignCenter, self._team_icon or "🧠")

        # Team name under the picture.
        name_font = QFont()
        name_font.setPointSize(11)
        name_font.setBold(True)
        p.setFont(name_font)
        p.setPen(_TEXT_BRIGHT)
        name_rect = QRectF(pic_x - 6, pic_y + pic_size + 6, pic_size + 12, 20)
        p.drawText(name_rect, Qt.AlignCenter, self._team_name)

        # Right side: description + agent count.
        info_x = pic_x + pic_size + 18
        info_y = pic_y - 4
        info_w = card.x() + card.width() - 14 - info_x

        desc_font = QFont()
        desc_font.setPointSize(9)
        p.setFont(desc_font)
        p.setPen(_TEXT_BRIGHT)
        desc_rect = QRectF(info_x, info_y, info_w, 96)
        desc = self._team_description or "No team description provided."
        if len(desc) > 260:
            desc = desc[:257] + "…"
        p.drawText(
            desc_rect,
            Qt.AlignTop | Qt.AlignLeft | Qt.TextWordWrap,
            desc,
        )

        # Stats row at the bottom: number of agents, edges.
        stat_y = card.y() + card.height() - 36
        h_font = QFont()
        h_font.setPointSize(8)
        h_font.setBold(True)
        p.setFont(h_font)
        p.setPen(_TEXT_DIM)
        p.drawText(
            QRectF(info_x, stat_y, info_w, 14),
            Qt.AlignLeft,
            "AGENTS",
        )
        p.drawText(
            QRectF(info_x + 80, stat_y, info_w, 14),
            Qt.AlignLeft,
            "CONNECTIONS",
        )

        v_font = QFont()
        v_font.setPointSize(11)
        v_font.setBold(True)
        p.setFont(v_font)
        p.setPen(_TEXT_BRIGHT)
        p.drawText(
            QRectF(info_x, stat_y + 14, info_w, 18),
            Qt.AlignLeft,
            str(len(self._agents)),
        )
        p.drawText(
            QRectF(info_x + 80, stat_y + 14, info_w, 18),
            Qt.AlignLeft,
            str(len(self._edges)),
        )

        # Bottom hint.
        hint_font = QFont()
        hint_font.setPointSize(8)
        hint_font.setItalic(True)
        p.setFont(hint_font)
        p.setPen(_TEXT_DIM)
        hint_rect = QRectF(0, rect.height() - 24, rect.width(), 20)
        p.drawText(
            hint_rect,
            Qt.AlignCenter,
            "Click any node — the orchestrator too — to see its skills",
        )

    def _paint_hint(self, p: QPainter, rect) -> None:
        font = QFont()
        font.setPointSize(10)
        font.setItalic(True)
        p.setFont(font)
        p.setPen(_TEXT_DIM)
        hint_rect = QRectF(0, rect.height() - 28, rect.width(), 24)
        p.drawText(hint_rect, Qt.AlignCenter, "Click an agent to see its skills")

    def _paint_info_card(self, p: QPainter, rect, agent: _Agent) -> None:
        """Top-left gamey character-sheet panel for the selected agent.

        Layout: 320 × 200 panel, picture (96×96) on the left with the
        agent name beneath it, info on the right (description, model,
        status, skills).
        """
        margin = 14
        card_w = min(380, rect.width() - 2 * margin)
        card_h = 220
        card_x = margin
        card_y = margin

        card = QRectF(card_x, card_y, card_w, card_h)

        # Card background — semi-transparent dark with a violet→cyan border.
        bg = QLinearGradient(card.topLeft(), card.bottomRight())
        bg.setColorAt(0.0, QColor(18, 22, 34, 230))
        bg.setColorAt(1.0, QColor(8, 11, 18, 230))
        p.setBrush(QBrush(bg))

        border_grad = QLinearGradient(card.topLeft(), card.bottomRight())
        border_grad.setColorAt(0.0, _alpha(_NEON_CYAN, 220))
        border_grad.setColorAt(1.0, _alpha(_NEON_VIOLET, 220))
        p.setPen(QPen(QBrush(border_grad), 1.6))
        p.drawRoundedRect(card, 12, 12)

        # Inner accent ribbon along the top.
        ribbon = QRectF(card.x() + 8, card.y() + 8, card.width() - 16, 22)
        rg = QLinearGradient(ribbon.topLeft(), ribbon.topRight())
        status_col = {
            STATUS_IDLE: _NEON_BLUE,
            STATUS_ACTIVE: _NEON_GREEN,
            STATUS_PENDING: _NEON_AMBER,
            STATUS_ERROR: _NEON_RED,
        }[agent.status]
        rg.setColorAt(0.0, _alpha(status_col, 60))
        rg.setColorAt(1.0, _alpha(status_col, 10))
        p.setBrush(QBrush(rg))
        p.setPen(QPen(_alpha(status_col, 120), 1))
        p.drawRoundedRect(ribbon, 6, 6)

        # Status word in the ribbon.
        rib_font = QFont()
        rib_font.setPointSize(9)
        rib_font.setBold(True)
        p.setFont(rib_font)
        p.setPen(_TEXT_BRIGHT)
        status_word = {
            STATUS_IDLE: "STANDBY",
            STATUS_ACTIVE: "● ACTIVE",
            STATUS_PENDING: "● PENDING",
            STATUS_ERROR: "● ERROR",
        }[agent.status]
        p.drawText(
            ribbon.adjusted(10, 0, -10, 0),
            Qt.AlignVCenter | Qt.AlignLeft,
            status_word,
        )

        # ----- Left half: picture + name -----
        pic_x = card.x() + 14
        pic_y = card.y() + 38
        pic_size = 100.0
        pic_rect = QRectF(pic_x, pic_y, pic_size, pic_size)

        # Frame for the picture — neon ring.
        ring = QRadialGradient(pic_rect.center(), pic_size * 0.7)
        ring.setColorAt(0.0, _alpha(status_col, 90))
        ring.setColorAt(1.0, _alpha(status_col, 0))
        p.setBrush(QBrush(ring))
        p.setPen(Qt.NoPen)
        p.drawEllipse(pic_rect.adjusted(-6, -6, 6, 6))

        p.setBrush(QBrush(QColor(30, 36, 52)))
        p.setPen(QPen(_alpha(_TEXT_BRIGHT, 200), 1.4))
        p.drawEllipse(pic_rect)

        # The "picture" is the agent's emoji icon at large size — we
        # don't ship per-agent bitmap avatars yet.
        icon_font = QFont()
        icon_font.setPointSizeF(pic_size * 0.65)
        p.setFont(icon_font)
        p.setPen(_TEXT_BRIGHT)
        p.drawText(pic_rect, Qt.AlignCenter, agent.icon or "🤖")

        # Name under the picture.
        name_font = QFont()
        name_font.setPointSize(11)
        name_font.setBold(True)
        p.setFont(name_font)
        p.setPen(_TEXT_BRIGHT)
        name_rect = QRectF(pic_x - 6, pic_y + pic_size + 6, pic_size + 12, 20)
        p.drawText(name_rect, Qt.AlignCenter, agent.name)

        # Model label below the name (smaller, dim).
        if agent.model_label:
            model_font = QFont()
            model_font.setPointSize(8)
            p.setFont(model_font)
            p.setPen(_TEXT_DIM)
            model_rect = QRectF(pic_x - 6, pic_y + pic_size + 26, pic_size + 12, 16)
            p.drawText(model_rect, Qt.AlignCenter, agent.model_label)

        # ----- Right half: description + skills -----
        info_x = pic_x + pic_size + 18
        info_y = pic_y - 4
        info_w = card.x() + card.width() - 14 - info_x

        # Description.
        desc_font = QFont()
        desc_font.setPointSize(9)
        p.setFont(desc_font)
        p.setPen(_TEXT_BRIGHT)
        desc_rect = QRectF(info_x, info_y, info_w, 70)
        desc = agent.description or "No description provided."
        # Manually trim to keep the card compact.
        if len(desc) > 220:
            desc = desc[:217] + "…"
        p.drawText(
            desc_rect,
            Qt.AlignTop | Qt.AlignLeft | Qt.TextWordWrap,
            desc,
        )

        # SKILLS heading.
        skills_y = info_y + 80
        h_font = QFont()
        h_font.setPointSize(8)
        h_font.setBold(True)
        p.setFont(h_font)
        p.setPen(_TEXT_DIM)
        h_rect = QRectF(info_x, skills_y, info_w, 14)
        p.drawText(h_rect, Qt.AlignLeft, "SKILLS")

        # Skill chips (up to 5, the rest go into "+N more").
        skills = agent.skills[:]
        chip_y = skills_y + 16
        chip_x = info_x
        chip_h = 18.0
        chip_pad_x = 10
        chip_gap = 6
        chip_font = QFont()
        chip_font.setPointSize(8)
        p.setFont(chip_font)

        shown = 0
        max_shown = 5
        for skill in skills:
            label = skill if len(skill) <= 24 else skill[:23] + "…"
            metrics = p.fontMetrics()
            w = metrics.horizontalAdvance(label) + 2 * chip_pad_x
            # Wrap to a new line if we'd overflow the card.
            if chip_x + w > info_x + info_w:
                if shown >= max_shown:
                    break
                chip_x = info_x
                chip_y += chip_h + chip_gap
                if chip_y + chip_h > card.y() + card.height() - 12:
                    break
            chip_rect = QRectF(chip_x, chip_y, w, chip_h)

            chip_bg = QLinearGradient(chip_rect.topLeft(), chip_rect.topRight())
            chip_bg.setColorAt(0.0, _alpha(_NEON_CYAN, 60))
            chip_bg.setColorAt(1.0, _alpha(_NEON_VIOLET, 60))
            p.setBrush(QBrush(chip_bg))
            p.setPen(QPen(_alpha(_NEON_CYAN, 160), 1))
            p.drawRoundedRect(chip_rect, 9, 9)
            p.setPen(_TEXT_BRIGHT)
            p.drawText(chip_rect, Qt.AlignCenter, label)

            chip_x += w + chip_gap
            shown += 1
            if shown >= max_shown:
                break

        remaining = max(0, len(skills) - shown)
        if remaining > 0:
            extra = f"+{remaining} more"
            metrics = p.fontMetrics()
            w = metrics.horizontalAdvance(extra) + 2 * chip_pad_x
            if chip_x + w > info_x + info_w:
                chip_x = info_x
                chip_y += chip_h + chip_gap
            if chip_y + chip_h <= card.y() + card.height() - 12:
                more_rect = QRectF(chip_x, chip_y, w, chip_h)
                p.setBrush(QBrush(QColor(40, 46, 64, 200)))
                p.setPen(QPen(_alpha(_TEXT_DIM, 160), 1))
                p.drawRoundedRect(more_rect, 9, 9)
                p.setPen(_TEXT_DIM)
                p.drawText(more_rect, Qt.AlignCenter, extra)

    # ------------------------------------------------------------------
    # Mouse interaction
    # ------------------------------------------------------------------

    def _hit_test(self, pos: QPoint) -> Optional[str]:
        """Return the agent name under ``pos``. The orchestrator is now
        a first-class clickable target (its info card opens on click,
        same as orbit agents). Orbit agents still take priority on
        overlap so they aren't masked when the rings sit close to the
        centre on a small canvas.
        """
        # Orbit agents first (so they win on overlap).
        for name, agent in self._agents.items():
            if agent.is_orchestrator:
                continue
            r = agent.radius + 6
            dx = pos.x() - agent.pos.x()
            dy = pos.y() - agent.pos.y()
            if dx * dx + dy * dy <= r * r:
                return name
        # Then the orchestrator.
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
