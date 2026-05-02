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
from typing import Dict, Optional, Tuple

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


class _AgentEdge(QGraphicsPathItem):
    def __init__(self, source: _AgentNode, target: _AgentNode) -> None:
        super().__init__()
        self.source = source
        self.target = target
        self._hover = False
        self._arrow_poly = QPolygonF()
        self._start_pt = QPointF()
        self._end_pt = QPointF()
        # Arrow draws ABOVE node bodies (2.0) and ports (3.0) so the
        # arrowhead is visible sitting on top of the input port dot.
        self.setZValue(5.0)
        self.setFlag(QGraphicsItem.ItemIsSelectable, True)
        self.setAcceptHoverEvents(True)
        # Curve is stroked, not filled. Brush stays off — the arrowhead
        # is drawn separately in paint() with its own fill colour.
        self.setBrush(Qt.NoBrush)
        self.update_path()

    def _palette(self) -> QColor:
        """Edge colour for the current visual state.

        Driven by the SOURCE node's layer — the arrow inherits the
        colour of whatever layer it leaves from, so flow is readable
        even from a glance.
        """
        if self.isSelected():
            return _EDGE_COLOR_SELECTED
        try:
            base = _layer_color(self.source.layer)
        except (RuntimeError, AttributeError):
            base = _layer_color(0)
        if self._hover:
            # Brighten on hover.
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

    def update_path(self) -> None:
        try:
            start = self.source.output_port_scene_pos()
            end = self.target.input_port_scene_pos()
        except (RuntimeError, AttributeError):
            return
        except Exception:
            return

        # Cubic Bezier with horizontal-tangent control points so the curve
        # leaves the output port pointing right and arrives at the input
        # port pointing right. Handle length scales with the larger of
        # dx / dy so vertically-separated nodes still get a smooth arc.
        dx = end.x() - start.x()
        dy = end.y() - start.y()
        handle = max(60.0, abs(dx) * 0.5, abs(dy) * 0.6)
        if dx < 0:
            # Backward edge: push handles outward to loop cleanly.
            handle = max(handle, abs(dx) * 0.6 + 80.0)

        c1 = QPointF(start.x() + handle, start.y())
        c2 = QPointF(end.x() - handle, end.y())

        path = QPainterPath(start)
        path.cubicTo(c1, c2, end)
        self.setPath(path)
        self._start_pt = QPointF(start)
        self._end_pt = QPointF(end)

        # Arrowhead, tangent approximated from c2 → end.
        ang = math.atan2(end.y() - c2.y(), end.x() - c2.x())
        # Pull the head back from the port so it doesn't overlap the dot.
        tip = QPointF(end.x() - 2 * math.cos(ang), end.y() - 2 * math.sin(ang))
        self._arrow_poly = QPolygonF([
            tip,
            QPointF(tip.x() - _ARROW_HEAD * math.cos(ang - math.pi / 7),
                    tip.y() - _ARROW_HEAD * math.sin(ang - math.pi / 7)),
            QPointF(tip.x() - _ARROW_HEAD * math.cos(ang + math.pi / 7),
                    tip.y() - _ARROW_HEAD * math.sin(ang + math.pi / 7)),
        ])

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
        if not self._arrow_poly.isEmpty():
            painter.setPen(QPen(col, 1.0))
            painter.setBrush(QBrush(col))
            painter.drawPolygon(self._arrow_poly)


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
                edge = _AgentEdge(src, dst)
                self._scene.addItem(edge)
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

    def remove_selected_edge(self) -> bool:
        for key, edge in list(self._edges.items()):
            if edge.isSelected():
                self._edges.pop(key)
                self._scene.removeItem(edge)
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
                self._scene.removeItem(edge)
                src = self._nodes.get(dst_name)
                dst = self._nodes.get(src_name)
                if src is None or dst is None:
                    if not self._suspend_signals:
                        self.graph_changed.emit()
                    return True
                new_edge = _AgentEdge(src, dst)
                self._scene.addItem(new_edge)
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
                self._scene.removeItem(edge)
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
        edge = _AgentEdge(src, dst)
        self._scene.addItem(edge)
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
        # Edges paint their colour from source.layer — force a repaint.
        for edge in self._edges.values():
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
