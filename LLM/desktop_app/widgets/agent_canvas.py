"""QGraphicsScene canvas for laying out agents and connecting them with arrows.

Interaction model
-----------------

* Each agent node has a **left input port** and a **right output port** —
  both rendered as glowing cyan circles outside the node body so they
  cannot be confused with the body.
* **Drag from the output port** of one node to ANYWHERE on another node
  to create a directional arrow. The cursor turns into a crosshair as
  soon as you press the port. Release on empty space to cancel.
* **Drag the node body** to move the node. Ports are SEPARATE
  ``QGraphicsItem`` children — Qt's hit-testing routes the press to
  whichever item the cursor is over, so the body never starts moving
  while you're aiming at the port.
* **Click an edge** to select it; press the page's ✕ Edge button or
  the ``Delete`` key to remove. Click ⇄ Reverse to flip its direction.
* **Right-click a node** to open its context menu (Pick model… /
  Remove from team / View log) — the page wires the actual menu.
* **Click a node body** (left mouse, no drag) to select it; the page
  re-points its log pane at that agent.

Status updates
--------------

External code calls :py:meth:`AgentCanvas.set_node_status` to drive the
green/yellow/red glow that signals "this agent is active right now" and
:py:meth:`set_node_model_label` to write the model name under the
agent's title so the canvas isn't a wall of empty boxes.
"""
from __future__ import annotations

import math
from typing import Dict, List, Optional, Tuple

from PySide6.QtCore import QObject, QPointF, QRectF, Qt, Signal
from PySide6.QtGui import (
    QBrush,
    QColor,
    QFont,
    QLinearGradient,
    QPainter,
    QPainterPath,
    QPen,
    QPolygonF,
    QRadialGradient,
)
from PySide6.QtWidgets import (
    QGraphicsItem,
    QGraphicsLineItem,
    QGraphicsPathItem,
    QGraphicsPolygonItem,
    QGraphicsScene,
    QGraphicsSceneContextMenuEvent,
    QGraphicsSceneMouseEvent,
    QGraphicsView,
    QStyleOptionGraphicsItem,
    QWidget,
)

from core.agents.agent_graph import AgentGraph


# ---------------------------------------------------------------------------
# Status palette
# ---------------------------------------------------------------------------

STATUS_IDLE = "idle"
STATUS_ACTIVE = "active"
STATUS_PENDING = "pending"
STATUS_ERROR = "error"

_STATUS_FILL = {
    STATUS_IDLE:    "#2a3142",
    STATUS_ACTIVE:  "#3cf26b",   # vivid lightning lime — pops at a glance
    STATUS_PENDING: "#7a6a32",
    STATUS_ERROR:   "#7a2f2f",
}
_STATUS_BORDER = {
    STATUS_IDLE:    "#3d4660",
    STATUS_ACTIVE:  "#d6ffe0",   # almost-white halo around the lime
    STATUS_PENDING: "#e0c060",
    STATUS_ERROR:   "#ee7474",
}
_STATUS_GLOW = {
    STATUS_IDLE:    QColor(0, 0, 0, 0),
    STATUS_ACTIVE:  QColor(60, 242, 107, 230),   # bright green halo
    STATUS_PENDING: QColor(220, 190, 80, 100),
    STATUS_ERROR:   QColor(230, 100, 100, 120),
}


# ---------------------------------------------------------------------------
# Geometry constants
# ---------------------------------------------------------------------------

_NODE_W = 220
_NODE_H = 340
_NODE_RADIUS = 18
_PORT_RADIUS = 11  # generous so it's easy to grab
_PORT_OFFSET = 4   # gap between node body and port circle

# Inner layout — the node is a vertical stack:
#   row 1: icon (~180×180)
#   row 2: agent name (up to two lines at 16 pt bold)
#   row 3: model used
_NODE_PAD = 14
_NODE_NAME_H = 50
_NODE_MODEL_H = 24
_NODE_STATUS_H = 20

_PORT_COLOR_OUT = QColor("#3aa0ff")   # blue (output)
_PORT_COLOR_IN = QColor("#ff9a3a")    # orange (input)
_PORT_COLOR_HOVER = QColor("#ffffff")


PORT_KIND_OUTPUT = "output"
PORT_KIND_INPUT = "input"


# ---------------------------------------------------------------------------
# Layer palette — row 0 = orchestrator, row 1 = direct downstream, etc.
# Colours cycle if the graph has more than len(LAYER_COLORS) layers.
# ---------------------------------------------------------------------------

LAYER_COLORS = [
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


def _darker(col: QColor, factor: float = 0.35) -> QColor:
    """Return a darker, semi-transparent version of ``col`` for fills."""
    return QColor(
        int(col.red() * factor),
        int(col.green() * factor),
        int(col.blue() * factor),
        220,
    )


# ---------------------------------------------------------------------------
# Port — separate QGraphicsItem so its hit-area doesn't compete with the body
# ---------------------------------------------------------------------------


class _NodePort(QGraphicsItem):
    """A round port child of an :class:`_AgentNode`.

    Clicking on the port begins (output) or completes (input) an
    edge-drag gesture, while clicking on the parent node's body still
    moves the node — Qt routes the press to whichever child item is
    under the cursor, so there's no overlap-induced "the box moves
    when I'm trying to drag an arrow" bug.
    """

    def __init__(self, parent_node: "_AgentNode", kind: str) -> None:
        super().__init__(parent_node)
        self.parent_node = parent_node
        self.kind = kind
        self._hover = False
        self.setAcceptHoverEvents(True)
        self.setZValue(3.0)
        self.setFlag(QGraphicsItem.ItemIsMovable, False)
        self.setFlag(QGraphicsItem.ItemIsSelectable, False)
        self.setCursor(Qt.CrossCursor)

    def boundingRect(self) -> QRectF:  # noqa: N802
        r = _PORT_RADIUS + 4
        return QRectF(-r, -r, r * 2, r * 2)

    def shape(self) -> QPainterPath:
        path = QPainterPath()
        path.addEllipse(QPointF(0, 0), _PORT_RADIUS + 2, _PORT_RADIUS + 2)
        return path

    def paint(self, painter, option, widget=None) -> None:
        base = _PORT_COLOR_OUT if self.kind == PORT_KIND_OUTPUT else _PORT_COLOR_IN
        col = _PORT_COLOR_HOVER if self._hover else base
        # Halo.
        halo = QRadialGradient(QPointF(0, 0), _PORT_RADIUS * 2.4)
        halo.setColorAt(0.0, QColor(col.red(), col.green(), col.blue(), 200 if self._hover else 130))
        halo.setColorAt(1.0, QColor(col.red(), col.green(), col.blue(), 0))
        painter.setRenderHint(painter.RenderHint.Antialiasing, True)
        painter.setBrush(QBrush(halo))
        painter.setPen(Qt.NoPen)
        painter.drawEllipse(QPointF(0, 0), _PORT_RADIUS * 2.0, _PORT_RADIUS * 2.0)
        # Bright core.
        painter.setBrush(QBrush(col))
        painter.setPen(QPen(QColor("#0c1018"), 1.5))
        painter.drawEllipse(QPointF(0, 0), _PORT_RADIUS, _PORT_RADIUS)

    def hoverEnterEvent(self, event):  # noqa: N802
        self._hover = True
        self.update()

    def hoverLeaveEvent(self, event):  # noqa: N802
        self._hover = False
        self.update()

    def mousePressEvent(self, event: QGraphicsSceneMouseEvent) -> None:
        # Only OUTPUT ports start a drag. Clicking the input port is a
        # no-op (the user reaches the input by RELEASING the drag over
        # the target node, not by pressing it).
        if event.button() == Qt.LeftButton and self.kind == PORT_KIND_OUTPUT:
            canvas = self.parent_node._canvas
            canvas._begin_edge_drag(self.parent_node, event.scenePos())
            event.accept()
            return
        # Don't propagate to the parent node — we want to keep the box
        # still even when the click was on the input port.
        event.accept()


# ---------------------------------------------------------------------------
# Node
# ---------------------------------------------------------------------------


class _AgentNode(QGraphicsItem):
    """A draggable agent box with input / output ports as child items."""

    def __init__(self, name: str, *, is_orchestrator: bool, canvas: "AgentCanvas") -> None:
        super().__init__()
        self.name = name
        self.is_orchestrator = is_orchestrator
        self._canvas = canvas
        self._status = STATUS_IDLE
        self._model_label = ""
        self._voice_label = ""
        self._selected_visual = False
        self._layer = 0 if is_orchestrator else 1
        # Default icon: crown for the orchestrator, generic robot for
        # specialists. Overridden by ``set_icon`` once the page knows
        # the agent definition's own icon.
        self._icon = "👑" if is_orchestrator else "🤖"
        # Description + skills are pushed in by AgentsPage so the
        # info-card overlay (drawn by AgentCanvas.paintEvent) can
        # populate the same fields the orbital diagram shows.
        self._description: str = ""
        self._skills: list[str] = []

        self.setFlags(
            QGraphicsItem.ItemIsMovable
            | QGraphicsItem.ItemIsSelectable
            | QGraphicsItem.ItemSendsGeometryChanges
        )
        self.setAcceptHoverEvents(True)
        self.setZValue(2.0)
        self.setCursor(Qt.OpenHandCursor)

        # Children: input port on the TOP, output on the BOTTOM. Flow
        # reads top→down so the orchestrator-up, specialists-down layout
        # is visually intuitive without rotating cards.
        self._port_in = _NodePort(self, PORT_KIND_INPUT)
        self._port_in.setPos(self._input_port_local())
        self._port_out = _NodePort(self, PORT_KIND_OUTPUT)
        self._port_out.setPos(self._output_port_local())

    # --- Geometry --------------------------------------------------------

    def boundingRect(self) -> QRectF:  # noqa: N802
        # Pad enough for the active-glow halo. Ports are CHILDREN, so they
        # don't have to be in our bounding rect.
        return QRectF(-28, -28, _NODE_W + 56, _NODE_H + 56)

    def shape(self) -> QPainterPath:
        path = QPainterPath()
        path.addRoundedRect(QRectF(0, 0, _NODE_W, _NODE_H), _NODE_RADIUS, _NODE_RADIUS)
        return path

    def _input_port_local(self) -> QPointF:
        # Top-center: incoming arrows arrive from above.
        return QPointF(_NODE_W / 2, -_PORT_RADIUS - _PORT_OFFSET)

    def _output_port_local(self) -> QPointF:
        # Bottom-center: outgoing arrows leave downward.
        return QPointF(_NODE_W / 2, _NODE_H + _PORT_RADIUS + _PORT_OFFSET)

    def input_port_scene_pos(self) -> QPointF:
        return self.scenePos() + self._input_port_local()

    def output_port_scene_pos(self) -> QPointF:
        return self.scenePos() + self._output_port_local()

    # --- Painting --------------------------------------------------------

    def paint(self, painter, option: QStyleOptionGraphicsItem, widget: Optional[QWidget] = None) -> None:
        rect = QRectF(0, 0, _NODE_W, _NODE_H)

        glow = _STATUS_GLOW.get(self._status, QColor(0, 0, 0, 0))
        if glow.alpha() > 0:
            grad = QRadialGradient(rect.center(), _NODE_W / 1.2)
            grad.setColorAt(0.0, glow)
            grad.setColorAt(1.0, QColor(glow.red(), glow.green(), glow.blue(), 0))
            painter.fillRect(self.boundingRect(), grad)

        layer_col = _layer_color(self._layer)
        # Idle nodes get a layer-tinted dark fill + layer-coloured border;
        # active / pending / error states keep their status colours so the
        # status signal isn't drowned out.
        if self._status == STATUS_IDLE:
            fill = _darker(layer_col, 0.22)
            border_col = layer_col
        else:
            fill = QColor(_STATUS_FILL.get(self._status, _STATUS_FILL[STATUS_IDLE]))
            border_col = QColor(_STATUS_BORDER.get(self._status, _STATUS_BORDER[STATUS_IDLE]))
        if self._selected_visual:
            border_col = QColor("#ffffff")

        painter.setRenderHint(painter.RenderHint.Antialiasing, True)
        path = QPainterPath()
        path.addRoundedRect(rect, _NODE_RADIUS, _NODE_RADIUS)
        painter.fillPath(path, QBrush(fill))

        # Top-edge layer stripe — running across the top of the node so
        # the layer colour reads at a glance even when active/error
        # states recolour the body.
        stripe = QPainterPath()
        stripe.addRoundedRect(QRectF(0, 0, _NODE_W, 10), 5, 5)
        painter.fillPath(stripe, QBrush(layer_col))

        pen = QPen(border_col)
        pen.setWidth(3 if self._status == STATUS_ACTIVE else 2)
        painter.setPen(pen)
        painter.drawPath(path)

        # Pick text colours that contrast with the current fill — the
        # bright lime active fill needs near-black text to stay legible.
        if self._status == STATUS_ACTIVE:
            name_col = QColor("#0c1a10")
            model_col = QColor("#0c1a10")
            status_col = QColor("#0c1a10")
        else:
            name_col = QColor("#ffffff")
            model_col = QColor("#b8c3d8")
            status_col = QColor("#cbd2e0")

        # Layout: icon (top, big) + name + model + status, stacked.
        from desktop_app.widgets.agent_icons import paint_icon as _paint_icon
        icon_value = self._icon or ("👑" if self.is_orchestrator else "🤖")

        top = 10  # below the layer stripe
        usable_h = _NODE_H - top - _NODE_PAD
        text_block_h = (
            _NODE_NAME_H + _NODE_MODEL_H + _NODE_STATUS_H + 16
        )
        icon_h = max(_NODE_W - 2 * _NODE_PAD, usable_h - text_block_h)
        # Cap so the icon never crowds the text block.
        icon_h = min(icon_h, usable_h - text_block_h)
        icon_rect = QRectF(
            _NODE_PAD,
            top + _NODE_PAD,
            _NODE_W - 2 * _NODE_PAD,
            icon_h,
        )
        painter.setPen(name_col)
        _paint_icon(painter, icon_rect, icon_value)

        # Crown badge for the orchestrator so the role still reads
        # even when its icon isn't a crown.
        if self.is_orchestrator:
            badge = QFont()
            badge.setPointSize(14)
            painter.setFont(badge)
            painter.setPen(QColor("#f1c44a"))
            painter.drawText(
                QRectF(_NODE_W - 32, top + 4, 26, 26),
                Qt.AlignCenter,
                "👑",
            )

        # Name row.
        name_rect = QRectF(
            _NODE_PAD,
            icon_rect.bottom() + 4,
            _NODE_W - 2 * _NODE_PAD,
            _NODE_NAME_H,
        )
        name_font = QFont()
        name_font.setPointSize(16)
        name_font.setBold(True)
        painter.setFont(name_font)
        painter.setPen(name_col)
        painter.drawText(
            name_rect,
            Qt.AlignCenter | Qt.TextWordWrap,
            self.name,
        )

        # Model row.
        model_rect = QRectF(
            _NODE_PAD,
            name_rect.bottom() + 2,
            _NODE_W - 2 * _NODE_PAD,
            _NODE_MODEL_H,
        )
        model_font = QFont()
        model_font.setPointSize(10)
        painter.setFont(model_font)
        painter.setPen(model_col)
        model_label = self._model_label or "no model"
        # Elide so a long id doesn't blow past the box.
        fm = painter.fontMetrics()
        if fm.horizontalAdvance(model_label) > model_rect.width():
            while (
                model_label
                and fm.horizontalAdvance(model_label + "…") > model_rect.width()
            ):
                model_label = model_label[:-1]
            model_label += "…"
        painter.drawText(model_rect, Qt.AlignCenter, model_label)

        # Status row.
        status_rect = QRectF(
            _NODE_PAD,
            model_rect.bottom() + 2,
            _NODE_W - 2 * _NODE_PAD,
            _NODE_STATUS_H,
        )
        sf = QFont()
        sf.setPointSize(9)
        painter.setFont(sf)
        painter.setPen(status_col)
        painter.drawText(status_rect, Qt.AlignCenter, self._status_label())

    def _status_label(self) -> str:
        return {
            STATUS_IDLE:    "Idle",
            STATUS_ACTIVE:  "● Active",
            STATUS_PENDING: "● Pending",
            STATUS_ERROR:   "● Error",
        }.get(self._status, "Idle")

    # --- Public mutators -------------------------------------------------

    def set_status(self, status: str) -> None:
        if status not in _STATUS_FILL:
            status = STATUS_IDLE
        if status != self._status:
            self._status = status
            self.update()

    def set_model_label(self, label: str) -> None:
        if label != self._model_label:
            self._model_label = label
            self.update()

    def set_voice_label(self, label: str) -> None:
        if label != self._voice_label:
            self._voice_label = label
            self.update()

    def set_selected_visual(self, on: bool) -> None:
        if on != self._selected_visual:
            self._selected_visual = on
            self.update()

    def set_layer(self, layer: int) -> None:
        # Orchestrator is ALWAYS gold (layer 0) regardless of what
        # BFS would compute — it's the conceptual root and its
        # colour is part of the team's visual identity.
        if self.is_orchestrator:
            layer = 0
        if layer < 0:
            layer = 0
        if layer != self._layer:
            self._layer = layer
            self.update()

    def set_icon(self, icon: str) -> None:
        icon = (icon or "").strip()
        if not icon:
            return
        if icon != self._icon:
            self._icon = icon
            self.update()

    def set_meta(self, description: str, skills: list[str]) -> None:
        """Push description + skills from the AgentDefinition. Used by
        the canvas's info-card overlay; doesn't affect painting of the
        node body itself."""
        self._description = description or ""
        self._skills = list(skills or [])

    @property
    def layer(self) -> int:
        return self._layer

    # --- Events ----------------------------------------------------------

    def itemChange(self, change, value):  # noqa: N802
        if change == QGraphicsItem.ItemPositionHasChanged:
            try:
                self._canvas._on_node_moved_during_drag(self)
            except Exception:
                pass
        return super().itemChange(change, value)

    def mousePressEvent(self, event: QGraphicsSceneMouseEvent) -> None:
        if event.button() == Qt.LeftButton:
            try:
                self._canvas._on_node_clicked(self)
            except Exception:
                pass
            try:
                self.setCursor(Qt.ClosedHandCursor)
            except Exception:
                pass
        super().mousePressEvent(event)

    def mouseReleaseEvent(self, event: QGraphicsSceneMouseEvent) -> None:  # noqa: N802
        try:
            self.setCursor(Qt.OpenHandCursor)
        except Exception:
            pass
        try:
            self._canvas._on_node_drag_finished(self)
        except Exception:
            pass
        super().mouseReleaseEvent(event)

    def contextMenuEvent(self, event: QGraphicsSceneContextMenuEvent) -> None:
        screen_pos = event.screenPos()
        try:
            self._canvas._emit_context_menu(self, screen_pos)
        except Exception:
            pass
        event.accept()


# ---------------------------------------------------------------------------
# Edge — connects source's output port to target's input port
# ---------------------------------------------------------------------------


_EDGE_COLOR_START = QColor("#3aa0ff")     # blue, matches output port
_EDGE_COLOR_END = QColor("#ff9a3a")       # orange, matches input port
_EDGE_COLOR_HOVER_START = QColor("#7cc2ff")
_EDGE_COLOR_HOVER_END = QColor("#ffc080")
_EDGE_COLOR_SELECTED = QColor("#ffd54a")
_ARROW_HEAD = 13

# Magnet-repulsion tuning. The repulsion is applied to the BEZIER
# CURVE itself (not just control points): we sample the curve at fixed
# t-values, compute a force on each sample from every obstacle's
# nearest rectangle edge, then back-propagate the forces to the
# control points via the cubic Bernstein basis. Iterating a handful
# of times converges on a curve that stays clear of every box that
# isn't its own endpoint.
#
# Tuning aims for *visible* deflection on direct (same-row / adjacent
# downward) edges as well as the cross-layer loops — the previous
# values were so conservative that forward arrows barely moved even
# with a box right in their path.
_REPEL_STRENGTH = 90.0    # peak push at the box edge (px / iter / sample)
_REPEL_RANGE = 200.0      # distance at which the field fades to zero
_REPEL_PAD = 14.0         # virtual buffer added to each obstacle's rect
_REPEL_ITERS = 8          # control-point relaxation steps
_REPEL_SAMPLES = 16       # bezier samples per iteration
_REPEL_STEP = 0.65        # per-iteration step size (post-normalisation)

# Sibling fan-out — when several edges share a source they all start
# at the same output port. Without separation they overlap right at
# the source and look like one fat arrow. Each sibling claims a
# perpendicular offset on its first control point so the curves
# spread out into a fan as they leave the source.
_FANOUT_SPACING = 26.0


class _AgentEdgeHead(QGraphicsPolygonItem):
    """Arrowhead for an edge — separate scene item so it can sit at a
    z-value high enough to render on top of the input/output port dots
    while the line itself passes UNDER the node body.
    """

    def __init__(self, edge: "_AgentEdge") -> None:
        super().__init__()
        self.edge = edge
        # Above ports (children of nodes at z=2.0) so the head is visible
        # on top of the input port circle it lands on.
        self.setZValue(4.0)
        self.setPen(QPen(Qt.NoPen))

    def apply_color(self, col: QColor) -> None:
        self.setBrush(QBrush(col))
        self.setPen(QPen(col, 1.0))


class _AgentEdge(QGraphicsPathItem):
    def __init__(self, source: _AgentNode, target: _AgentNode) -> None:
        super().__init__()
        self.source = source
        self.target = target
        self._hover = False
        self._arrow_poly = QPolygonF()
        self._start_pt = QPointF()
        self._end_pt = QPointF()
        # Curve sits BELOW the node body (z=2.0) so when the path
        # crosses an unrelated node it visibly passes underneath.
        self.setZValue(1.0)
        self.setFlag(QGraphicsItem.ItemIsSelectable, True)
        self.setAcceptHoverEvents(True)
        # Curve is stroked, not filled. Brush stays off — the arrowhead
        # is a SEPARATE scene item (`_head`) painted at a higher z.
        self.setBrush(Qt.NoBrush)
        # Arrowhead lives in its own item at z=4.0 so it draws above the
        # port dots even though the curve passes under the body.
        self._head: Optional[_AgentEdgeHead] = None
        self.update_path()

    def _palette(self) -> QColor:
        """Edge colour for the current visual state.

        Driven by the TARGET node's layer — the arrow inherits the
        colour of the layer it points INTO, so a quick scan tells you
        which downstream layer each arrow is feeding.
        """
        if self.isSelected():
            return _EDGE_COLOR_SELECTED
        try:
            base = _layer_color(self.target.layer)
        except (RuntimeError, AttributeError):
            base = _layer_color(0)
        if self._hover:
            return base.lighter(135)
        return base

    def _current_width(self) -> float:
        if self.isSelected():
            return 3.0
        if self._hover:
            return 2.5
        return 2.0

    def hoverEnterEvent(self, event):  # noqa: N802
        self._hover = True
        self.update()
        super().hoverEnterEvent(event)

    def hoverLeaveEvent(self, event):  # noqa: N802
        self._hover = False
        self.update()
        super().hoverLeaveEvent(event)

    def itemChange(self, change, value):  # noqa: N802
        if change == QGraphicsItem.ItemSelectedHasChanged:
            self.update()
        return super().itemChange(change, value)

    def _direct_sibling_index(self) -> Tuple[int, int]:
        """Return ``(index, total)`` of this edge among same-source
        edges that take the DIRECT routing branch.

        Only direct edges contribute to the fan, so a backward-loop
        edge from the same source doesn't crowd the forward fan
        (it's already on the under-loop side). Order is deterministic
        — sorted by target's vertical position then name — so each
        edge always renders in the same lane.
        """
        try:
            canvas = self.source._canvas
        except (RuntimeError, AttributeError):
            return 0, 1
        if canvas is None:
            return 0, 1

        def _is_direct(e: "_AgentEdge") -> bool:
            try:
                gap = abs(e.source.layer - e.target.layer)
            except (RuntimeError, AttributeError):
                return True
            if gap == 0:
                return True
            if gap == 1 and e.target.layer > e.source.layer:
                return True
            return False

        siblings = [
            e for e in canvas._edges.values()
            if e.source is self.source and _is_direct(e)
        ]
        if len(siblings) <= 1:
            return 0, 1

        def _key(e: "_AgentEdge") -> tuple:
            try:
                pos = e.target.scenePos()
                return (pos.y(), pos.x(), e.target.name)
            except Exception:
                return (0.0, 0.0, "")

        siblings.sort(key=_key)
        try:
            idx = siblings.index(self)
        except ValueError:
            idx = 0
        return idx, len(siblings)

    def _obstacle_rects(self) -> List[Tuple[float, float, float, float]]:
        """Inflated bounding rectangles of every node OTHER than this
        edge's source / target.

        Each box is padded by :data:`_REPEL_PAD` so the "stay clear"
        buffer also keeps arrows from hugging a box edge — we want
        the LINE to feel a push starting a bit BEFORE it would
        actually overlap, not only when it's already grazing the
        corner. Returns ``(left, top, right, bottom)`` in scene
        coordinates so distance-to-rect can be computed cheaply.
        """
        out: List[Tuple[float, float, float, float]] = []
        try:
            canvas = self.source._canvas
        except (RuntimeError, AttributeError):
            return out
        if canvas is None:
            return out
        for node in canvas._nodes.values():
            if node is self.source or node is self.target:
                continue
            try:
                pos = node.scenePos()
            except (RuntimeError, AttributeError):
                continue
            out.append((
                pos.x() - _REPEL_PAD,
                pos.y() - _REPEL_PAD,
                pos.x() + _NODE_W + _REPEL_PAD,
                pos.y() + _NODE_H + _REPEL_PAD,
            ))
        return out

    @staticmethod
    def _force_at_point(
        px: float,
        py: float,
        obstacles: List[Tuple[float, float, float, float]],
    ) -> Tuple[float, float]:
        """Net repulsion vector at ``(px, py)`` from every obstacle rect.

        Force decays linearly from peak strength at the box edge to
        zero at :data:`_REPEL_RANGE` away. Inside a box, force points
        from the box centre toward the sample so the curve gets shoved
        out of any overlap.
        """
        fx = 0.0
        fy = 0.0
        for left, top, right, bottom in obstacles:
            # Closest point on the obstacle rect to the sample.
            cpx = left if px < left else (right if px > right else px)
            cpy = top if py < top else (bottom if py > bottom else py)
            dx = px - cpx
            dy = py - cpy
            dist = math.hypot(dx, dy)
            if dist > _REPEL_RANGE:
                continue
            if dist < 1.0:
                # Sample is inside (or right on the edge of) the rect —
                # push from the rect's CENTRE so we always escape with
                # a non-degenerate direction.
                ccx = (left + right) * 0.5
                ccy = (top + bottom) * 0.5
                dx = px - ccx
                dy = py - ccy
                dist = math.hypot(dx, dy)
                if dist < 1.0:
                    dx, dy = 0.0, -1.0
                    dist = 1.0
                # Strong push — the sample is literally inside the box.
                scale = _REPEL_STRENGTH * 3.0 / dist
            else:
                falloff = 1.0 - dist / _REPEL_RANGE
                scale = _REPEL_STRENGTH * falloff / dist
            fx += dx * scale
            fy += dy * scale
        return fx, fy

    @staticmethod
    def _route_cubic(
        start: QPointF,
        c1: QPointF,
        c2: QPointF,
        end: QPointF,
        obstacles: List[Tuple[float, float, float, float]],
    ) -> Tuple[QPointF, QPointF]:
        """Iteratively shift ``c1`` / ``c2`` so the cubic curve
        ``start → c1 → c2 → end`` is pushed clear of every obstacle.

        At each iteration we sample the curve at uniformly-spaced
        t-values, compute the net repulsion at each sample, and
        back-propagate to the control points via the cubic Bernstein
        basis (the weight each control point has on the curve at that
        t). Damping keeps multiple obstacles from causing oscillation.
        """
        if not obstacles:
            return c1, c2

        cur1 = QPointF(c1)
        cur2 = QPointF(c2)
        # Sum of Bernstein weights B1(t) and B2(t) over our uniform t
        # samples — used to normalise the per-iteration step so the
        # tuning constants stay independent of the sample count.
        weight_sum_b1 = 0.0
        weight_sum_b2 = 0.0
        for i in range(1, _REPEL_SAMPLES):
            t = i / float(_REPEL_SAMPLES)
            u = 1.0 - t
            weight_sum_b1 += 3.0 * u * u * t
            weight_sum_b2 += 3.0 * u * t * t
        if weight_sum_b1 < 1e-6:
            weight_sum_b1 = 1.0
        if weight_sum_b2 < 1e-6:
            weight_sum_b2 = 1.0

        for _ in range(_REPEL_ITERS):
            d1x = d1y = d2x = d2y = 0.0
            any_force = False
            for i in range(1, _REPEL_SAMPLES):
                t = i / float(_REPEL_SAMPLES)
                u = 1.0 - t
                # B(t) = (1-t)^3 P0 + 3(1-t)^2 t P1 + 3(1-t) t^2 P2 + t^3 P3
                b0 = u * u * u
                b1 = 3.0 * u * u * t
                b2 = 3.0 * u * t * t
                b3 = t * t * t
                px = b0 * start.x() + b1 * cur1.x() + b2 * cur2.x() + b3 * end.x()
                py = b0 * start.y() + b1 * cur1.y() + b2 * cur2.y() + b3 * end.y()
                fx, fy = _AgentEdge._force_at_point(px, py, obstacles)
                if fx == 0.0 and fy == 0.0:
                    continue
                any_force = True
                d1x += fx * b1
                d1y += fy * b1
                d2x += fx * b2
                d2y += fy * b2
            if not any_force:
                break
            # Normalise by the Bernstein-weight integral so the step
            # size is meaningful regardless of how many samples we
            # took, then scale by REPEL_STEP for the per-iteration
            # damping factor.
            cur1 = QPointF(
                cur1.x() + d1x * _REPEL_STEP / weight_sum_b1,
                cur1.y() + d1y * _REPEL_STEP / weight_sum_b1,
            )
            cur2 = QPointF(
                cur2.x() + d2x * _REPEL_STEP / weight_sum_b2,
                cur2.y() + d2y * _REPEL_STEP / weight_sum_b2,
            )
        return cur1, cur2

    def update_path(self) -> None:
        try:
            start = self.source.output_port_scene_pos()
            end = self.target.input_port_scene_pos()
        except (RuntimeError, AttributeError):
            return
        except Exception:
            return

        obstacles = self._obstacle_rects()

        # Routing rules (position-based, NOT layer-based):
        #   1. NEVER intersect a box.
        #   2. SHORTEST path that satisfies #1.
        #
        # Top-down flow: source's OUTPUT port is bottom-center, target's
        # INPUT port is top-center. So:
        #   * If the target's input port sits BELOW the source's bottom
        #     edge → direct vertical-tangent bezier. The curve never
        #     re-enters the source body and the repulsion field steers
        #     it around any third-party boxes in between.
        #   * Otherwise the target is BEHIND the source (above or beside
        #     it) — a direct curve would slice through the source body.
        #     Detour around the source on the SHORTER side: left when
        #     the target sits left of the source's mid-x, right when
        #     right. Detour distance is just enough to clear the source
        #     body plus a small breathing margin.
        try:
            src_pos = self.source.scenePos()
        except (RuntimeError, AttributeError):
            # Best-effort fallback: assume start is the bottom port.
            src_pos = QPointF(start.x() - _NODE_W / 2,
                              start.y() - _NODE_H - _PORT_RADIUS - _PORT_OFFSET)
        src_left = src_pos.x()
        src_right = src_pos.x() + _NODE_W
        src_top = src_pos.y()
        src_bottom = src_pos.y() + _NODE_H
        src_mid_x = src_pos.x() + _NODE_W / 2
        # "Behind" means the target's input port is at or above the
        # source's bottom edge — i.e., the source body is in the way
        # of the shortest line from output (bottom) → input (top).
        direct_route = end.y() > src_bottom + _PORT_RADIUS

        # Build a SINGLE cubic from start (source output port) to end
        # (target input port). One segment = no junctions = no kinks.
        # Control-point placement enforces the "shortest path that
        # doesn't cross a box" rule:
        #
        #   * direct: vertical tangents at both ends, c1 below start,
        #     c2 above end. Standard vertical-S curve.
        #   * loop:   c1 swung left/right of the source body so the
        #     curve arcs around the shorter side; c2 still above end
        #     so the arrival tangent into the target's top port stays
        #     downward (clean vertical entry).
        #
        # Repulsion (`_route_cubic`) then fine-tunes both control
        # points to clear any third-party obstacles in the way.
        dx = end.x() - start.x()
        dy = end.y() - start.y()
        # Handle baseline scales with the node geometry — a 360×440 box
        # needs much beefier control-point handles than a 200×84 one
        # to produce a smooth curve. Vertical-flow puts the dominant
        # axis on Y, so weight that direction more.
        handle_base = max(60.0, _NODE_H * 0.35, _NODE_W * 0.25)
        handle = max(handle_base, abs(dy) * 0.5, abs(dx) * 0.6)

        if direct_route:
            c1 = QPointF(start.x(), start.y() + handle)
            c2 = QPointF(end.x(), end.y() - handle)

            # Sibling fan-out: when multiple direct edges leave the
            # same source they share the start point. Without a
            # perpendicular offset on c1 they all lie on top of each
            # other near the source. Centre the fan around 0 — the
            # middle sibling stays straight, others bow left / right.
            # In top-down flow the perpendicular axis is X.
            sib_idx, sib_total = self._direct_sibling_index()
            if sib_total > 1:
                offset = (sib_idx - (sib_total - 1) / 2.0) * _FANOUT_SPACING
                c1 = QPointF(c1.x() + offset, c1.y())
        else:
            # Target is BEHIND source (above it or alongside). Swing
            # the curve left or right of the source body via c1; keep
            # c2 vertical at end's x for a clean downward arrival
            # tangent. Single cubic.
            loop_left = end.x() < src_mid_x

            # Stagger looping siblings so two arrows from the same
            # source don't overlap. Sibling order is deterministic.
            sibling_index = 0
            try:
                canvas = self.source._canvas

                def _is_behind_source(e: "_AgentEdge") -> bool:
                    try:
                        sp = e.source.scenePos()
                        ep = e.target.input_port_scene_pos()
                        return ep.y() <= sp.y() + _NODE_H + _PORT_RADIUS
                    except Exception:
                        return False

                siblings = [
                    e for e in canvas._edges.values()
                    if e.source is self.source and _is_behind_source(e)
                ]

                def _sib_key(e: "_AgentEdge") -> tuple:
                    try:
                        tp = e.target.scenePos()
                        # In top-down flow we sort siblings primarily
                        # by their x-position so left-loop and right-
                        # loop arrows don't trade lanes erratically.
                        return (tp.x(), tp.y(), e.target.name)
                    except Exception:
                        return (0.0, 0.0, "")

                siblings.sort(key=_sib_key)
                sibling_index = siblings.index(self) if self in siblings else 0
            except Exception:
                sibling_index = 0

            # Loop clearance scales with node size. Top-down flow puts
            # the sideways detour against the node's WIDTH, so scale
            # off _NODE_W rather than _NODE_H.
            base_pad = max(28.0, _NODE_W * 0.12)
            lane_spacing = max(18.0, _NODE_W * 0.06)
            loop_pad = base_pad + sibling_index * lane_spacing

            # c1 just past the source's bottom edge, swung to the
            # left / right of the source body — pulls the curve out
            # sideways right after it leaves the bottom port.
            if loop_left:
                c1_x = src_left - loop_pad
            else:
                c1_x = src_right + loop_pad
            c1 = QPointF(c1_x, src_bottom + loop_pad)

            # c2 just above target's top port at target's x — keeps
            # the arrival tangent vertical. Use a modest clearance
            # rather than the full chain-length: the curve only needs
            # enough handle for a smooth approach into the target,
            # not enough to vault entirely past every intermediate
            # node. The earlier `(src_bottom - end.y()) + loop_pad`
            # version produced giant sweeps for long back-edges
            # (critic→orchestrator across a 5-node chain) because
            # it treated the whole vertical distance as the handle.
            handle = min(
                max(handle, _NODE_H * 0.5),
                _NODE_H + loop_pad,  # one node-height + breathing room
            )
            c2 = QPointF(end.x(), end.y() - handle)
            # Clearance: if c2 still falls inside the source body's
            # y-range, the curve would re-enter the source on the way
            # to end. Bump c2 above the source's top edge in that case.
            if c2.y() > src_top - loop_pad:
                c2 = QPointF(end.x(), src_top - loop_pad)

        # Magnet repulsion against every OTHER box keeps the curve
        # clear when the path passes near a third-party node.
        c1, c2 = self._route_cubic(start, c1, c2, end, obstacles)

        # Tangent-direction guard: relaxation may push c1 past start
        # or c2 past end, which would flip the natural downward
        # entry/exit tangent and produce a hook just before the
        # arrowhead. Clamp on the Y axis (the dominant flow axis).
        min_clearance = 12.0
        if c1.y() < start.y() + min_clearance:
            c1 = QPointF(c1.x(), start.y() + min_clearance)
        if c2.y() > end.y() - min_clearance:
            c2 = QPointF(c2.x(), end.y() - min_clearance)

        path = QPainterPath(start)
        path.cubicTo(c1, c2, end)
        tangent_from = c2

        self.setPath(path)
        self._start_pt = QPointF(start)
        self._end_pt = QPointF(end)

        # Arrowhead — tangent approximated from the LAST control point
        # to the path's end (works for both the same-layer and cross-
        # layer routings since both end with a cubicTo into ``end``).
        ang = math.atan2(end.y() - tangent_from.y(), end.x() - tangent_from.x())
        tip = QPointF(end.x() - 2 * math.cos(ang), end.y() - 2 * math.sin(ang))
        self._arrow_poly = QPolygonF([
            tip,
            QPointF(tip.x() - _ARROW_HEAD * math.cos(ang - math.pi / 7),
                    tip.y() - _ARROW_HEAD * math.sin(ang - math.pi / 7)),
            QPointF(tip.x() - _ARROW_HEAD * math.cos(ang + math.pi / 7),
                    tip.y() - _ARROW_HEAD * math.sin(ang + math.pi / 7)),
        ])
        if self._head is not None:
            self._head.setPolygon(self._arrow_poly)
            self._head.apply_color(self._palette())

    def boundingRect(self) -> QRectF:  # noqa: N802
        # Expand the path's bounds to also cover the arrowhead polygon.
        rect = super().boundingRect()
        if not self._arrow_poly.isEmpty():
            rect = rect.united(self._arrow_poly.boundingRect())
        # Pad for pen width / antialiasing.
        return rect.adjusted(-4, -4, 4, 4)

    def paint(self, painter, option, widget=None) -> None:  # noqa: N802
        painter.setRenderHint(painter.RenderHint.Antialiasing, True)
        col = self._palette()
        # Edges from the orchestrator are implicit (it can dispatch to
        # anyone). Render those dashed + faded with the arrowhead
        # hidden, so the user can tell at a glance which edges are the
        # strict specialist chain (solid + arrow) and which are just
        # echoing the orchestrator's free-dispatch capability.
        is_implicit = bool(getattr(self.source, "is_orchestrator", False))
        pen = QPen(col)
        pen.setWidthF(self._current_width())
        pen.setCapStyle(Qt.RoundCap)
        pen.setJoinStyle(Qt.RoundJoin)
        if is_implicit:
            from PySide6.QtGui import QColor as _QC
            faded = _QC(col)
            faded.setAlpha(110)
            pen.setColor(faded)
            pen.setStyle(Qt.DashLine)
            pen.setWidthF(max(1.0, self._current_width() * 0.7))
        painter.setPen(pen)
        painter.setBrush(Qt.NoBrush)
        painter.drawPath(self.path())
        # The arrowhead is a separate scene item (`self._head`) painted at
        # z=4.0 so it renders on top of node body / port dots while the
        # curve we just drew sits below the body. Keep its colour in sync
        # with whatever palette the curve resolved to. For implicit
        # edges we hide the arrowhead — the dashed style alone says
        # "this is a capability, not a strict route".
        if self._head is not None:
            if is_implicit:
                self._head.setVisible(False)
            else:
                self._head.setVisible(True)
                self._head.apply_color(col)


# ---------------------------------------------------------------------------
# Canvas
# ---------------------------------------------------------------------------


class AgentCanvas(QGraphicsView):
    node_selected = Signal(str)
    graph_changed = Signal()
    node_context_menu_requested = Signal(str, object)
    selection_mode_changed = Signal(str)
    """Mirror of :attr:`AgentTeamCanvas.selection_mode_changed`. Emits
    ``"agent:<name>"`` / ``"team"`` / ``""`` whenever the painted
    overlay card flips, so the agents page can re-bind the model
    picker that lives inside the card."""

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self._scene = QGraphicsScene(self)
        self.setScene(self._scene)
        self.setRenderHints(self.renderHints() | self.renderHints().Antialiasing)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        self.setBackgroundBrush(QBrush(QColor("#0f1218")))
        self.setMinimumHeight(380)
        self.setFocusPolicy(Qt.StrongFocus)
        # Items that are not under the cursor on press should NOT receive
        # the mouse — Qt's default RubberBandDrag mode interferes with our
        # custom edge drag, so disable.
        self.setDragMode(QGraphicsView.NoDrag)
        # Anchor zoom on the cursor so Ctrl+wheel feels natural — the
        # point under the mouse stays put while everything else scales
        # around it.
        self.setTransformationAnchor(QGraphicsView.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.AnchorUnderMouse)
        # Track the cumulative zoom level so we can clamp it to a
        # sensible range (don't let users scroll into oblivion or
        # invert the canvas accidentally).
        self._zoom_factor: float = 1.0
        self._nodes: Dict[str, _AgentNode] = {}
        self._edges: Dict[Tuple[str, str], _AgentEdge] = {}

        self._drag_source: Optional[_AgentNode] = None
        self._drag_line: Optional[QGraphicsLineItem] = None

        self._selected_name: Optional[str] = None
        self._orchestrator_name: Optional[str] = None
        self._suspend_signals = False

        # Team-level metadata for the default info card (shown when no
        # agent is selected). Pushed in by AgentsPage._render_team.
        self._team_name: str = ""
        self._team_description: str = ""
        # Cached owl crest pixmap for the team card avatar.
        from desktop_app.widgets.agent_info_card import load_owl_pixmap as _load_owl
        self._owl_pixmap = _load_owl()

        # Overlay model picker — parented to the viewport (where the card
        # is painted) so ``setGeometry`` lands in the right coordinate
        # space. The agents page hands us the widget via
        # :meth:`attach_card_picker`.
        self._card_picker: Optional[QWidget] = None
        self._last_card_mode: str = ""

    # ------------------------------------------------------------------
    # Public API used by AgentsPage
    # ------------------------------------------------------------------

    def selected_agent(self) -> Optional[str]:
        return self._selected_name

    def load_graph(self, graph: AgentGraph, *, orchestrator: Optional[str]) -> None:
        self._suspend_signals = True
        try:
            self._cancel_edge_drag()
            self._scene.clear()
            self._nodes.clear()
            self._edges.clear()
            self._orchestrator_name = orchestrator
            for n in graph.nodes:
                node = _AgentNode(n.name, is_orchestrator=(n.name == orchestrator), canvas=self)
                node.setPos(QPointF(n.pos_x, n.pos_y))
                self._scene.addItem(node)
                self._nodes[n.name] = node
            for e in graph.edges:
                src = self._nodes.get(e.source)
                dst = self._nodes.get(e.target)
                if src is None or dst is None:
                    continue
                edge = self._make_edge(src, dst)
                self._edges[(e.source, e.target)] = edge
            self._recompute_layers()
            self._scene.setSceneRect(self._compute_scene_rect())
        finally:
            self._suspend_signals = False

    def export_graph(self) -> AgentGraph:
        g = AgentGraph()
        for name, node in self._nodes.items():
            g.add_node(name, (node.scenePos().x(), node.scenePos().y()))
        for (src, dst) in self._edges.keys():
            g.add_edge(src, dst)
        return g

    def set_node_status(self, name: str, status: str) -> None:
        node = self._nodes.get(name)
        if node is not None:
            node.set_status(status)

    def set_node_model_label(self, name: str, label: str) -> None:
        node = self._nodes.get(name)
        if node is not None:
            node.set_model_label(label)

    def set_node_voice_label(self, name: str, label: str) -> None:
        node = self._nodes.get(name)
        if node is not None:
            node.set_voice_label(label)

    def set_node_icon(self, name: str, icon: str) -> None:
        node = self._nodes.get(name)
        if node is not None:
            node.set_icon(icon)

    def set_node_meta(self, name: str, description: str, skills: list[str]) -> None:
        """Push description + skills metadata for the info-card overlay.
        Has no effect on the graph node itself, just the top-left card."""
        node = self._nodes.get(name)
        if node is not None:
            node.set_meta(description, skills)
            self.viewport().update()

    def set_team_info(self, name: str, description: str = "") -> None:
        """Store team-level metadata for the default info card shown
        when no agent is selected."""
        self._team_name = name or ""
        self._team_description = description or ""
        self.viewport().update()

    def reset_all_status(self) -> None:
        for n in self._nodes.values():
            n.set_status(STATUS_IDLE)

    def select_agent(self, name: Optional[str]) -> None:
        self._selected_name = name
        for nname, node in self._nodes.items():
            node.set_selected_visual(nname == name)
        # Repaint the viewport so the info-card overlay tracks selection.
        self.viewport().update()

    def paintEvent(self, event) -> None:  # noqa: N802
        """Draw the scene as usual, then overlay the info card on top of
        the viewport in widget coordinates so it stays anchored to the
        top-left and doesn't pan/zoom with the graph.
        """
        super().paintEvent(event)
        try:
            from desktop_app.widgets.agent_info_card import (
                paint_agent_card,
                paint_team_card,
                STATUS_IDLE as _CARD_IDLE,
                STATUS_ACTIVE as _CARD_ACTIVE,
                STATUS_PENDING as _CARD_PENDING,
                STATUS_ERROR as _CARD_ERROR,
            )
        except Exception:
            return
        if not self._nodes:
            return

        painter = QPainter(self.viewport())
        agent_card_visible = False
        team_card_visible = False
        try:
            painter.setRenderHints(QPainter.Antialiasing | QPainter.TextAntialiasing)
            rect = self.viewport().rect()
            sel = self._selected_name
            if sel and sel in self._nodes:
                node = self._nodes[sel]
                # Map our internal status string to the card's enum.
                status_map = {
                    STATUS_IDLE: _CARD_IDLE,
                    STATUS_ACTIVE: _CARD_ACTIVE,
                    STATUS_PENDING: _CARD_PENDING,
                    STATUS_ERROR: _CARD_ERROR,
                }
                paint_agent_card(
                    painter,
                    rect,
                    name=node.name,
                    icon=node._icon or "🤖",
                    description=node._description,
                    skills=node._skills,
                    status=status_map.get(node._status, _CARD_IDLE),
                    model_label=node._model_label,
                    voice_label=node._voice_label,
                )
                agent_card_visible = True
            elif self._team_name:
                paint_team_card(
                    painter,
                    rect,
                    team_name=self._team_name,
                    team_description=self._team_description,
                    agent_count=len(self._nodes),
                    edge_count=len(self._edges),
                    owl_pixmap=self._owl_pixmap,
                )
                team_card_visible = True
        finally:
            painter.end()

        # After the card is painted, anchor the overlay model picker
        # inside it and broadcast the mode so AgentsPage can re-bind
        # the picker's value + signal target.
        if agent_card_visible:
            mode = f"agent:{self._selected_name}"
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

    # ------------------------------------------------------------------
    # Overlay model picker
    # ------------------------------------------------------------------

    def attach_card_picker(self, picker: Optional[QWidget]) -> None:
        """Mount the agents-page overlay model picker on top of the
        info card. Parented to the viewport since paintEvent draws
        there too — coordinates line up without any extra math.
        Pass ``None`` to detach."""
        if self._card_picker is not None and self._card_picker is not picker:
            try:
                self._card_picker.setParent(None)
            except Exception:
                pass
        self._card_picker = picker
        if picker is not None:
            try:
                picker.setParent(self.viewport())
                picker.setVisible(False)
                picker.raise_()
            except Exception:
                pass

    def attach_super_user_card(self, card: Optional[QWidget]) -> None:
        """Mount the SuperUserCard as an overlay on the graph view's
        viewport, mirroring what AgentTeamCanvas does for the orbital
        diagram. Pass ``None`` to detach."""
        existing = getattr(self, "_super_user_card", None)
        if existing is not None and existing is not card:
            try:
                existing.setParent(None)
            except Exception:
                pass
        self._super_user_card = card
        if card is not None:
            try:
                card.setParent(self.viewport())
                card.setVisible(False)
                card.raise_()
            except Exception:
                pass

    def _position_card_picker(self, *, agent_card: bool, team_card: bool) -> None:
        """Pin the overlay picker to the bottom of the painted card.
        Hidden when no card is on screen."""
        picker = self._card_picker
        if picker is None:
            return
        if not (agent_card or team_card):
            picker.setVisible(False)
            return
        try:
            from desktop_app.widgets.agent_info_card import card_picker_geometry
            x, y, w, h = card_picker_geometry(self.viewport().width(),
                                              agent_card=agent_card)
        except Exception:
            picker.setVisible(False)
            return
        picker.setGeometry(int(x), int(y), int(w), int(h))
        picker.setVisible(True)
        picker.raise_()

    def _position_super_user_card(self, *, agent_card: bool,
                                  team_card: bool) -> None:
        """Place the SuperUserCard directly below the painted info /
        team card. Always-on when there are agents — better to clip the
        bottom of the card than to disappear when room is tight."""
        card = getattr(self, "_super_user_card", None)
        if card is None:
            return
        try:
            from desktop_app.widgets.agent_info_card import super_user_card_geometry
            vp = self.viewport()
            x, y, w, h = super_user_card_geometry(
                vp.width(), vp.height(),
                agent_card=agent_card, team_card=team_card,
            )
        except Exception:
            card.setVisible(False)
            return
        # Hide only when there's literally no room or no agents.
        # Anything else: show the card, even if it has to clip.
        if h <= 0:
            card.setVisible(False)
            return
        card.setGeometry(int(x), int(y), int(w), int(h))
        card.setVisible(True)
        card.raise_()

    def _make_edge(self, src: _AgentNode, dst: _AgentNode) -> _AgentEdge:
        """Create an edge AND its sibling arrowhead and add both to the scene."""
        edge = _AgentEdge(src, dst)
        self._scene.addItem(edge)
        head = _AgentEdgeHead(edge)
        edge._head = head
        self._scene.addItem(head)
        edge.update_path()
        return edge

    def _drop_edge(self, edge: _AgentEdge) -> None:
        """Remove an edge AND its sibling arrowhead from the scene."""
        head = edge._head
        edge._head = None
        try:
            self._scene.removeItem(edge)
        except Exception:
            pass
        if head is not None:
            try:
                self._scene.removeItem(head)
            except Exception:
                pass

    def remove_selected_edge(self) -> bool:
        for key, edge in list(self._edges.items()):
            if edge.isSelected():
                self._edges.pop(key)
                self._drop_edge(edge)
                self._recompute_layers()
                if not self._suspend_signals:
                    self.graph_changed.emit()
                return True
        return False

    def reverse_selected_edge(self) -> bool:
        for key, edge in list(self._edges.items()):
            if edge.isSelected():
                src_name, dst_name = key
                self._edges.pop(key)
                self._drop_edge(edge)
                src = self._nodes.get(dst_name)
                dst = self._nodes.get(src_name)
                if src is None or dst is None:
                    if not self._suspend_signals:
                        self.graph_changed.emit()
                    return True
                new_edge = self._make_edge(src, dst)
                self._edges[(dst_name, src_name)] = new_edge
                new_edge.setSelected(True)
                self._recompute_layers()
                if not self._suspend_signals:
                    self.graph_changed.emit()
                return True
        return False

    def remove_agent_node(self, name: str) -> None:
        node = self._nodes.pop(name, None)
        if node is None:
            return
        for key in list(self._edges.keys()):
            if name in key:
                edge = self._edges.pop(key)
                self._drop_edge(edge)
        self._scene.removeItem(node)
        self._recompute_layers()
        if not self._suspend_signals:
            self.graph_changed.emit()

    # ------------------------------------------------------------------
    # Edge-drag interaction
    # ------------------------------------------------------------------

    def _begin_edge_drag(self, source: _AgentNode, scene_pos: QPointF) -> None:
        self._cancel_edge_drag()
        self._drag_source = source
        port = source.output_port_scene_pos()
        line = QGraphicsLineItem(port.x(), port.y(), scene_pos.x(), scene_pos.y())
        pen = QPen(_PORT_COLOR_OUT)
        pen.setWidthF(2.4)
        pen.setStyle(Qt.DashLine)
        line.setPen(pen)
        line.setZValue(6.0)
        self._scene.addItem(line)
        self._drag_line = line
        try:
            self.setCursor(Qt.CrossCursor)
        except Exception:
            pass

    def _cancel_edge_drag(self) -> None:
        if self._drag_line is not None:
            try:
                self._scene.removeItem(self._drag_line)
            except Exception:
                pass
            self._drag_line = None
        self._drag_source = None
        try:
            self.unsetCursor()
        except Exception:
            pass

    def mouseMoveEvent(self, event):  # noqa: N802
        if self._drag_source is not None and self._drag_line is not None:
            scene_pos = self.mapToScene(event.pos())
            try:
                port = self._drag_source.output_port_scene_pos()
            except Exception:
                self._cancel_edge_drag()
                return super().mouseMoveEvent(event)
            self._drag_line.setLine(port.x(), port.y(), scene_pos.x(), scene_pos.y())
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):  # noqa: N802
        if self._drag_source is not None:
            scene_pos = self.mapToScene(event.pos())
            target = self._node_under_scene_pos(scene_pos)
            if target is not None and target is not self._drag_source:
                self._add_edge_between(self._drag_source, target)
            self._cancel_edge_drag()
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def keyPressEvent(self, event):  # noqa: N802
        if event.key() in (Qt.Key_Delete, Qt.Key_Backspace):
            if self.remove_selected_edge():
                event.accept()
                return
        super().keyPressEvent(event)

    # ------------------------------------------------------------------
    # Zoom — Ctrl+wheel on the canvas scales the view in/out around
    # the cursor. Plain wheel keeps the QGraphicsView default (vertical
    # scroll) so users can still pan without holding modifiers.
    # ------------------------------------------------------------------

    _ZOOM_MIN = 0.25
    _ZOOM_MAX = 4.0
    _ZOOM_STEP = 1.15  # 15% per notch — Maya / Blender / Figma feel

    def wheelEvent(self, event):  # noqa: N802
        if event.modifiers() & Qt.ControlModifier:
            delta = event.angleDelta().y()
            if delta == 0:
                event.accept()
                return
            factor = self._ZOOM_STEP if delta > 0 else 1.0 / self._ZOOM_STEP
            new_factor = self._zoom_factor * factor
            # Clamp without letting tiny over-shoots accumulate — if the
            # next step would cross a bound, cap factor so we land
            # exactly on it.
            if new_factor < self._ZOOM_MIN:
                factor = self._ZOOM_MIN / self._zoom_factor
                new_factor = self._ZOOM_MIN
            elif new_factor > self._ZOOM_MAX:
                factor = self._ZOOM_MAX / self._zoom_factor
                new_factor = self._ZOOM_MAX
            if abs(factor - 1.0) < 1e-4:
                event.accept()
                return
            self.scale(factor, factor)
            self._zoom_factor = new_factor
            event.accept()
            return
        super().wheelEvent(event)

    def reset_zoom(self) -> None:
        """Reset the canvas to 1:1 (called from the page if a "fit"
        button is added later)."""
        if abs(self._zoom_factor - 1.0) < 1e-4:
            return
        self.resetTransform()
        self._zoom_factor = 1.0

    def fit_view_right_aligned(self, margin: int = 40) -> None:
        """Zoom out so the whole graph fits in the viewport, then push
        it against the right edge with empty space on the left.

        Different from QGraphicsView.fitInView (which always centers
        the target rect): users wanted the orchestrator + descendants
        clustered on the right with the team info-card overlay at the
        top-left having room to breathe.
        """
        if not self._nodes:
            return
        target = self._scene.itemsBoundingRect()
        if target.isEmpty() or target.isNull():
            return
        target = target.adjusted(-margin, -margin, margin, margin)

        vp = self.viewport().rect()
        if vp.width() <= 0 or vp.height() <= 0 or target.width() <= 0 or target.height() <= 0:
            return

        scale = min(vp.width() / target.width(), vp.height() / target.height())
        # Honour the same clamp as Ctrl+wheel so the user can zoom from
        # this state without hitting an immediate boundary.
        scale = max(self._ZOOM_MIN, min(self._ZOOM_MAX, scale))

        self.resetTransform()
        self.scale(scale, scale)
        self._zoom_factor = scale

        # Right-align: place the target's right edge at the viewport's
        # right edge by centering on (target.right - half_vp_w_in_scene).
        half_vp_w_scene = (vp.width() / 2.0) / scale
        cx = target.right() - half_vp_w_scene
        cy = target.center().y()
        self.centerOn(cx, cy)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _node_under_scene_pos(self, scene_pos: QPointF) -> Optional[_AgentNode]:
        for item in self._scene.items(scene_pos):
            if isinstance(item, _AgentNode):
                return item
            # If we hit a child port, climb up to its parent node so users
            # can drop the wire directly onto the target's input port.
            if isinstance(item, _NodePort):
                return item.parent_node
        return None

    def _add_edge_between(self, src: _AgentNode, dst: _AgentNode) -> None:
        if src is dst:
            return
        key = (src.name, dst.name)
        if key in self._edges:
            return
        edge = self._make_edge(src, dst)
        self._edges[key] = edge
        self._recompute_layers()
        if not self._suspend_signals:
            self.graph_changed.emit()

    def _on_node_moved_during_drag(self, node: _AgentNode) -> None:
        for key, edge in list(self._edges.items()):
            try:
                if node is edge.source or node is edge.target:
                    edge.update_path()
            except RuntimeError:
                self._edges.pop(key, None)
                try:
                    self._scene.removeItem(edge)
                except Exception:
                    pass

    def _on_node_drag_finished(self, node: _AgentNode) -> None:
        try:
            self._scene.setSceneRect(self._compute_scene_rect())
        except Exception:
            pass
        if not self._suspend_signals:
            self.graph_changed.emit()

    def _on_node_clicked(self, node: _AgentNode) -> None:
        self.select_agent(node.name)
        if not self._suspend_signals:
            self.node_selected.emit(node.name)

    def _emit_context_menu(self, node: _AgentNode, screen_pos) -> None:
        if not self._suspend_signals:
            self.node_context_menu_requested.emit(node.name, screen_pos)

    def _recompute_layers(self) -> None:
        """Assign each node a layer index by BFS from the orchestrator.

        Layer 0 = orchestrator (or first node, fallback). Layer k = the
        shortest directed-path distance from layer 0. Nodes unreachable
        from the orchestrator land in the layer after the deepest one
        so they still get a colour. After assignment, every edge is
        re-rendered so its colour matches its new source-layer colour.
        """
        if not self._nodes:
            return
        names = list(self._nodes.keys())
        root = self._orchestrator_name if self._orchestrator_name in self._nodes else names[0]

        adj: Dict[str, list[str]] = {n: [] for n in names}
        for src, dst in self._edges.keys():
            if src in adj and dst in self._nodes:
                adj[src].append(dst)

        layer: Dict[str, int] = {root: 0}
        frontier = [root]
        while frontier:
            nxt = []
            for s in frontier:
                for d in adj.get(s, []):
                    if d == root:
                        continue
                    if d not in layer:
                        layer[d] = layer[s] + 1
                        nxt.append(d)
            frontier = nxt
        if any(n not in layer for n in names):
            tail = (max(layer.values()) + 1) if layer else 0
            for n in names:
                layer.setdefault(n, tail)

        for name, node in self._nodes.items():
            node.set_layer(layer.get(name, 0))
        # Edges colour from source.layer AND route differently when
        # source.layer != target.layer, so we must rebuild geometry, not
        # just repaint.
        for edge in self._edges.values():
            edge.update_path()
            edge.update()

    def _compute_scene_rect(self) -> QRectF:
        if not self._nodes:
            return QRectF(0, 0, 800, 400)
        # Start with the union of node and edge bounding rects so the
        # scene encompasses the cross-layer "loop UNDER source" curves
        # (whose control points sit ~200 px outside the source node).
        # Falling back to node-positions-only made those curves
        # render past the scrollable area, which produced the
        # "arrows fly off-canvas" symptom users were seeing.
        items_rect = self._scene.itemsBoundingRect()
        xs = [n.scenePos().x() for n in self._nodes.values()]
        ys = [n.scenePos().y() for n in self._nodes.values()]
        pad = 240
        nodes_rect = QRectF(
            min(xs) - pad,
            min(ys) - pad,
            (max(xs) - min(xs)) + _NODE_W + 2 * pad,
            (max(ys) - min(ys)) + _NODE_H + 2 * pad,
        )
        if items_rect.isNull():
            return nodes_rect
        # Union, then pad for arrowheads / repulsion overshoot.
        union = nodes_rect.united(items_rect.adjusted(-60, -60, 60, 60))
        return union
