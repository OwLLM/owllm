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

_NODE_W = 200
_NODE_H = 84
_NODE_RADIUS = 14
_PORT_RADIUS = 10  # generous so it's easy to grab
_PORT_OFFSET = 4   # gap between node body and port circle

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
        self._selected_visual = False
        self._layer = 0 if is_orchestrator else 1
        # Default icon: crown for the orchestrator, generic robot for
        # specialists. Overridden by ``set_icon`` once the page knows
        # the agent definition's own icon.
        self._icon = "👑" if is_orchestrator else "🤖"

        self.setFlags(
            QGraphicsItem.ItemIsMovable
            | QGraphicsItem.ItemIsSelectable
            | QGraphicsItem.ItemSendsGeometryChanges
        )
        self.setAcceptHoverEvents(True)
        self.setZValue(2.0)
        self.setCursor(Qt.OpenHandCursor)

        # Children: input port on the left, output on the right.
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
        return QPointF(-_PORT_RADIUS - _PORT_OFFSET, _NODE_H / 2)

    def _output_port_local(self) -> QPointF:
        return QPointF(_NODE_W + _PORT_RADIUS + _PORT_OFFSET, _NODE_H / 2)

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

        # Left-edge layer stripe — solid, full saturation, so the layer
        # colour reads even when the node is in an active/error state.
        stripe = QPainterPath()
        stripe.addRoundedRect(QRectF(0, 0, 8, _NODE_H), 4, 4)
        painter.fillPath(stripe, QBrush(layer_col))

        pen = QPen(border_col)
        pen.setWidth(3 if self._status == STATUS_ACTIVE else 2)
        painter.setPen(pen)
        painter.drawPath(path)

        # Title — icon (always) on the same line as the name, with the
        # crown badge overlaid for the orchestrator so the role still
        # reads even when the def's icon isn't a crown.
        icon_glyph = self._icon or ("👑" if self.is_orchestrator else "🤖")
        prefix = f"{icon_glyph} "
        if self.is_orchestrator and "👑" not in icon_glyph:
            prefix = f"👑 {icon_glyph} "
        title_text = prefix + self.name
        # Pick text colours that contrast with the current fill — the
        # bright lime active fill needs near-black text to stay legible.
        if self._status == STATUS_ACTIVE:
            title_col = QColor("#0c1a10")
            body_col = QColor("#0c1a10")
            status_col = QColor("#0c1a10")
        else:
            title_col = QColor("#ffffff")
            body_col = QColor("#b8c3d8")
            status_col = QColor("#cbd2e0")
        painter.setPen(title_col)
        font = QFont()
        font.setPointSize(11)
        font.setBold(True)
        painter.setFont(font)
        painter.drawText(QRectF(14, 8, _NODE_W - 28, 22), Qt.AlignLeft | Qt.AlignVCenter, title_text)

        # Model label.
        font2 = QFont()
        font2.setPointSize(9)
        painter.setFont(font2)
        painter.setPen(body_col)
        painter.drawText(
            QRectF(14, 32, _NODE_W - 28, 20),
            Qt.AlignLeft | Qt.AlignVCenter,
            self._model_label or "no model",
        )

        # Status.
        painter.setPen(status_col)
        painter.drawText(
            QRectF(14, 54, _NODE_W - 28, 22),
            Qt.AlignLeft | Qt.AlignVCenter,
            self._status_label(),
        )

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

    def set_selected_visual(self, on: bool) -> None:
        if on != self._selected_visual:
            self._selected_visual = on
            self.update()

    def set_layer(self, layer: int) -> None:
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

# Magnet-repulsion tuning. The "field" decays linearly from full strength
# at the obstacle's centre to 0 at REPEL_RANGE distance — outside the
# range a control point feels nothing, inside it gets pushed AWAY along
# the obstacle→point direction by an amount proportional to how deep
# inside the field it is. Strength is the per-obstacle peak push;
# multiple obstacles' forces sum.
_REPEL_STRENGTH = 70.0
_REPEL_RANGE = 180.0


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

    def _obstacle_centres(self) -> List[Tuple[float, float]]:
        """Centres of every node OTHER than this edge's source/target.

        Used by the magnet-repulsion pass — each control point is
        nudged AWAY from every obstacle within range. Returns scene
        coordinates so the caller can compute distances directly.
        """
        out: List[Tuple[float, float]] = []
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
            out.append((pos.x() + _NODE_W / 2.0, pos.y() + _NODE_H / 2.0))
        return out

    @staticmethod
    def _apply_repulsion(point: QPointF, obstacles: List[Tuple[float, float]]) -> QPointF:
        """Push ``point`` away from every obstacle whose centre is within
        :data:`_REPEL_RANGE`. Forces from multiple obstacles sum so a
        control point sandwiched between two boxes gets shoved into the
        clearer side."""
        if not obstacles:
            return point
        fx = 0.0
        fy = 0.0
        for cx, cy in obstacles:
            dx = point.x() - cx
            dy = point.y() - cy
            dist = math.hypot(dx, dy)
            if dist >= _REPEL_RANGE:
                continue
            if dist < 1.0:
                # Pathological overlap — push straight up by default
                # so the resulting curve at least clears something.
                fy -= _REPEL_STRENGTH
                continue
            falloff = 1.0 - dist / _REPEL_RANGE
            scale = _REPEL_STRENGTH * falloff / dist
            fx += dx * scale
            fy += dy * scale
        return QPointF(point.x() + fx, point.y() + fy)

    def update_path(self) -> None:
        try:
            start = self.source.output_port_scene_pos()
            end = self.target.input_port_scene_pos()
        except (RuntimeError, AttributeError):
            return
        except Exception:
            return

        obstacles = self._obstacle_centres()

        # Routing rules:
        #   * same layer                              → direct curve
        #   * adjacent layer DOWNWARD  (gap == 1, target deeper)
        #                                             → direct curve
        #   * adjacent layer UPWARD    (gap == 1, target shallower)
        #                                             → loop UNDER source
        #   * any layer gap > 1, either direction     → loop UNDER source
        # The "loop under" path is what keeps backward arrows from
        # cutting through the source's body.
        direct_route = True
        try:
            src_layer = self.source.layer
            tgt_layer = self.target.layer
            gap = abs(src_layer - tgt_layer)
            if gap == 0:
                direct_route = True
            elif gap == 1 and tgt_layer > src_layer:
                # going DOWN one layer — clean direct curve is fine.
                direct_route = True
            else:
                direct_route = False
        except (RuntimeError, AttributeError):
            direct_route = True

        if direct_route:
            # Same row → direct horizontal-tangent bezier (the original
            # routing, fast and clean for orchestrator-and-friends).
            dx = end.x() - start.x()
            dy = end.y() - start.y()
            handle = max(60.0, abs(dx) * 0.5, abs(dy) * 0.6)
            if dx < 0:
                handle = max(handle, abs(dx) * 0.6 + 80.0)
            c1 = QPointF(start.x() + handle, start.y())
            c2 = QPointF(end.x() - handle, end.y())
            # Magnet repulsion: nudge control points AWAY from any node
            # that's not the source or target. Lets the bezier bend
            # around boxes that happen to sit on the straight-line path.
            c1 = self._apply_repulsion(c1, obstacles)
            c2 = self._apply_repulsion(c2, obstacles)
            path = QPainterPath(start)
            path.cubicTo(c1, c2, end)
            tangent_from = c2
        else:
            # Cross-layer (gap > 1) → loop AROUND the source so the arrow
            # doesn't cut across intermediate layers. Direction is chosen
            # based on whether the target sits BELOW (loop down/under) or
            # ABOVE (loop up/over) the source.
            try:
                src_pos = self.source.scenePos()
            except (RuntimeError, AttributeError):
                src_pos = QPointF(start.x() - _NODE_W, start.y() - _NODE_H / 2)
            src_left = src_pos.x()
            src_right = src_pos.x() + _NODE_W
            src_top = src_pos.y()
            src_bottom = src_pos.y() + _NODE_H
            src_mid_y = src_pos.y() + _NODE_H / 2

            # Routing rule: ALWAYS loop UNDER the source (never over),
            # regardless of whether the target sits below or above.
            # The user explicitly wants the detour below the box for
            # both downward and upward arrows.

            # Stagger the detour distance so multiple cross-layer arrows
            # from the same source don't overlap. Sibling order is
            # deterministic so a given edge always renders in the same
            # lane. Sibling pool covers EVERY looping edge (same-source,
            # any direction) so up- and down-loops share the same fan
            # and don't double up on top of each other.
            sibling_index = 0
            try:
                canvas = self.source._canvas

                def _is_looping(e: "_AgentEdge") -> bool:
                    try:
                        g = abs(e.source.layer - e.target.layer)
                        if g == 0:
                            return False
                        if g == 1 and e.target.layer > e.source.layer:
                            return False
                        return True
                    except Exception:
                        return False

                siblings = [
                    e for e in canvas._edges.values()
                    if e.source is self.source and _is_looping(e)
                ]

                def _sib_key(e: "_AgentEdge") -> tuple:
                    try:
                        return (abs(e.target.layer - e.source.layer), e.target.name)
                    except Exception:
                        return (0, "")

                siblings.sort(key=_sib_key)
                sibling_index = siblings.index(self) if self in siblings else 0
            except Exception:
                sibling_index = 0

            # MUCH more breathing room around the source than before.
            # base_pad is the minimum distance from the source body
            # in every direction; lane_spacing is the extra gap each
            # additional sibling claims so 3-4 loops still fit cleanly.
            base_pad = 70.0
            lane_spacing = 28.0
            loop_pad = base_pad + sibling_index * lane_spacing

            # Drop well past the bottom of the source, exit on its
            # LEFT side. The +30 px past loop_pad is the explicit
            # "breathing room" the user asked for so the curve never
            # hugs the source border.
            detour_y = src_bottom + loop_pad + 30.0

            # Exit point on the source's LEFT side at mid-height. Sits
            # outside the input-port circle so it doesn't collide.
            exit_x = src_left - loop_pad - _PORT_RADIUS - _PORT_OFFSET
            exit_pt = QPointF(exit_x, src_mid_y)

            # Loop bezier: (right output port) → detour BELOW source →
            # (exit point on source's left). The loop_c control points
            # already sit far below the source so we DON'T repel them
            # against the source itself (which would fight the loop
            # geometry). They CAN feel other obstacles though.
            loop_c1 = QPointF(src_right + loop_pad, detour_y)
            loop_c2 = QPointF(src_left - loop_pad, detour_y)
            loop_c1 = self._apply_repulsion(loop_c1, obstacles)
            loop_c2 = self._apply_repulsion(loop_c2, obstacles)

            path = QPainterPath(start)
            path.cubicTo(loop_c1, loop_c2, exit_pt)

            # Final bezier from exit point to the target input port.
            # Exit tangent points UP (the loop is climbing back from
            # below to source mid-Y); arrival tangent points RIGHTWARD
            # into the target's left input port.
            f_dx = end.x() - exit_pt.x()
            f_dy = end.y() - exit_pt.y()
            f_handle = max(60.0, abs(f_dx) * 0.5, abs(f_dy) * 0.5)
            f_c1 = QPointF(exit_pt.x(), exit_pt.y() - f_handle)
            f_c2 = QPointF(end.x() - f_handle, end.y())
            f_c1 = self._apply_repulsion(f_c1, obstacles)
            f_c2 = self._apply_repulsion(f_c2, obstacles)
            path.cubicTo(f_c1, f_c2, end)
            tangent_from = f_c2

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
        pen = QPen(col)
        pen.setWidthF(self._current_width())
        pen.setCapStyle(Qt.RoundCap)
        pen.setJoinStyle(Qt.RoundJoin)
        painter.setPen(pen)
        painter.setBrush(Qt.NoBrush)
        painter.drawPath(self.path())
        # The arrowhead is a separate scene item (`self._head`) painted at
        # z=4.0 so it renders on top of node body / port dots while the
        # curve we just drew sits below the body. Keep its colour in sync
        # with whatever palette the curve resolved to.
        if self._head is not None:
            self._head.apply_color(col)


# ---------------------------------------------------------------------------
# Canvas
# ---------------------------------------------------------------------------


class AgentCanvas(QGraphicsView):
    node_selected = Signal(str)
    graph_changed = Signal()
    node_context_menu_requested = Signal(str, object)

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

    def set_node_icon(self, name: str, icon: str) -> None:
        node = self._nodes.get(name)
        if node is not None:
            node.set_icon(icon)

    def reset_all_status(self) -> None:
        for n in self._nodes.values():
            n.set_status(STATUS_IDLE)

    def select_agent(self, name: Optional[str]) -> None:
        self._selected_name = name
        for nname, node in self._nodes.items():
            node.set_selected_visual(nname == name)

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
        xs = [n.scenePos().x() for n in self._nodes.values()]
        ys = [n.scenePos().y() for n in self._nodes.values()]
        pad = 100
        return QRectF(
            min(xs) - pad,
            min(ys) - pad,
            (max(xs) - min(xs)) + _NODE_W + 2 * pad,
            (max(ys) - min(ys)) + _NODE_H + 2 * pad,
        )
