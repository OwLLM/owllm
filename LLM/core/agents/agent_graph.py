"""Agent flow graph — who-talks-to-whom for a Team.

A ``Project`` carries an ``AgentGraph`` describing the pipeline that
specialists form when the orchestrator dispatches work. Without a graph
the runtime falls back to point-to-point dispatch (orchestrator → X → reply
back to orchestrator). With a graph you can chain specialists:

    orchestrator → coder1 → coder2 → orchestrator

Semantics: when the orchestrator dispatches to ``coder1``, the runtime
intercepts ``coder1``'s reply and re-publishes it as a REQUEST to
``coder2`` (using the original ``coder1`` reply body as the task).
``coder2``'s reply is what the orchestrator's dispatch tool ultimately
sees. This gives you "review chains" without changing the model prompts.

Rules (kept deliberately simple — chain semantics, not arbitrary DAGs):

  * Each non-orchestrator node has at most ONE outbound edge to another
    specialist. The orchestrator can have many outbound edges (it picks
    which chain to start by which specialist it dispatches to).
  * If an outbound edge points back to the orchestrator (or there is no
    outbound edge from this node), the chain terminates here and this
    node's reply is returned to the orchestrator.

This is enough to express "review chain" and "stage pipeline" patterns,
which is what users actually want. Branching/parallel can come later.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple


@dataclass
class GraphNode:
    """One agent on the canvas."""

    name: str
    pos_x: float = 0.0
    pos_y: float = 0.0

    def to_json(self) -> Dict[str, Any]:
        return {"name": self.name, "x": self.pos_x, "y": self.pos_y}

    @classmethod
    def from_json(cls, d: Dict[str, Any]) -> "GraphNode":
        return cls(
            name=str(d.get("name", "")),
            pos_x=float(d.get("x", 0.0)),
            pos_y=float(d.get("y", 0.0)),
        )


@dataclass
class GraphEdge:
    """A directional arrow from ``source`` to ``target``."""

    source: str
    target: str

    def to_json(self) -> Dict[str, Any]:
        return {"source": self.source, "target": self.target}

    @classmethod
    def from_json(cls, d: Dict[str, Any]) -> "GraphEdge":
        return cls(source=str(d.get("source", "")), target=str(d.get("target", "")))


@dataclass
class AgentGraph:
    """Project-level routing graph."""

    nodes: List[GraphNode] = field(default_factory=list)
    edges: List[GraphEdge] = field(default_factory=list)

    # ------------------------------------------------------------------
    # Mutations
    # ------------------------------------------------------------------

    def add_node(self, name: str, pos: Tuple[float, float] = (0.0, 0.0)) -> GraphNode:
        """Idempotent: returns the existing node if one already has that name."""
        for n in self.nodes:
            if n.name == name:
                # Update position if caller provided new coordinates.
                if pos != (0.0, 0.0):
                    n.pos_x, n.pos_y = pos
                return n
        node = GraphNode(name=name, pos_x=pos[0], pos_y=pos[1])
        self.nodes.append(node)
        return node

    def remove_node(self, name: str) -> None:
        self.nodes = [n for n in self.nodes if n.name != name]
        self.edges = [e for e in self.edges if e.source != name and e.target != name]

    def add_edge(self, source: str, target: str) -> Optional[GraphEdge]:
        """Returns the edge if added, ``None`` if the edge already exists."""
        if source == target:
            return None
        for e in self.edges:
            if e.source == source and e.target == target:
                return None
        edge = GraphEdge(source=source, target=target)
        self.edges.append(edge)
        return edge

    def remove_edge(self, source: str, target: str) -> None:
        self.edges = [
            e for e in self.edges
            if not (e.source == source and e.target == target)
        ]

    def set_node_position(self, name: str, pos: Tuple[float, float]) -> None:
        for n in self.nodes:
            if n.name == name:
                n.pos_x, n.pos_y = pos
                return

    # ------------------------------------------------------------------
    # Routing queries
    # ------------------------------------------------------------------

    def next_target(self, from_name: str, orchestrator_name: str) -> Optional[str]:
        """The agent that follows ``from_name`` in the chain.

        Returns the next specialist to dispatch to, or ``None`` when the
        chain terminates (either no outbound edge, or the only outbound
        edge points to the orchestrator). ``None`` means "this agent's
        reply goes back to the orchestrator".
        """
        for e in self.edges:
            if e.source == from_name and e.target != orchestrator_name:
                return e.target
        return None

    # ------------------------------------------------------------------
    # JSON
    # ------------------------------------------------------------------

    def to_json(self) -> Dict[str, Any]:
        return {
            "nodes": [n.to_json() for n in self.nodes],
            "edges": [e.to_json() for e in self.edges],
        }

    def to_json_string(self) -> str:
        return json.dumps(self.to_json(), ensure_ascii=False)

    @classmethod
    def from_json(cls, d: Optional[Dict[str, Any]]) -> "AgentGraph":
        if not d:
            return cls()
        nodes = [GraphNode.from_json(x) for x in d.get("nodes") or []]
        edges = [GraphEdge.from_json(x) for x in d.get("edges") or []]
        return cls(nodes=nodes, edges=edges)

    @classmethod
    def from_json_string(cls, raw: Optional[str]) -> "AgentGraph":
        if not raw:
            return cls()
        try:
            return cls.from_json(json.loads(raw))
        except Exception:
            return cls()

    # ------------------------------------------------------------------
    # Auto-layout helpers
    # ------------------------------------------------------------------

    def autolayout_grid(self, *, x0: float = 60.0, y0: float = 60.0,
                        col_w: float = 280.0, row_h: float = 380.0,
                        cols: int = 3) -> None:
        """Place nodes in a grid for first-time projects with no positions."""
        for i, n in enumerate(self.nodes):
            if n.pos_x == 0.0 and n.pos_y == 0.0:
                col = i % cols
                row = i // cols
                n.pos_x = x0 + col * col_w
                n.pos_y = y0 + row * row_h

    def autolayout_layered(self, orchestrator: Optional[str], *,
                           x0: float = 360.0, y0: float = 60.0,
                           col_w: float = 300.0, row_h: float = 380.0,
                           card_w: float = 220.0, card_h: float = 340.0) -> None:
        """Arrange nodes in a staircase cascade from the orchestrator.

        Row 0 (top) holds the orchestrator. Row k holds nodes whose
        shortest directed path from the orchestrator (following outbound
        edges) has length k.

        Placement rules (matching how users hand-arrange workflow
        graphs):

        * **Siblings of one parent** sit at the same y, spread
          horizontally around the parent's x with ``col_w`` spacing.
        * **Chain step** (single child of a parent) sits at
          ``(rightmost_x_at_parent_level + col_w,
            parent.y + card_h / 2)`` —
          one column-gap to the right of everything already placed
          at the parent's row, and **down by half a card height**.
          Anchoring against the row's rightmost x (not just the
          parent's x) prevents a chain emerging from a left-side
          sibling from sliding underneath a right-side sibling.
        * **Orchestrator** is placed last, horizontally centred over
          the bounding box of all descendants and **half a card
          height above** row 1. So however wide the layout grows,
          the root sits over the geometric centre of its work.

        The whole layout is then translated so its top-left corner
        sits at ``(x0, y0)`` — every position is positive and the
        canvas anchor is consistent across teams.
        """
        if not self.nodes:
            return

        names = [n.name for n in self.nodes]
        # Pick a fallback orchestrator: caller-supplied if present, else
        # the first node — keeps the page from no-op'ing for headless graphs.
        root = orchestrator if orchestrator in names else names[0]

        adj: Dict[str, List[str]] = {n: [] for n in names}
        for e in self.edges:
            if e.source in adj and e.target in names:
                adj[e.source].append(e.target)

        # BFS — assigns each node a layer AND its primary parent (the
        # source of the BFS edge that first reached it). Parent-relative
        # placement is what produces the correct diagonal flow.
        layer: Dict[str, int] = {root: 0}
        parent: Dict[str, Optional[str]] = {root: None}
        frontier = [root]
        while frontier:
            nxt: List[str] = []
            for src in frontier:
                for dst in adj.get(src, []):
                    if dst == root:
                        continue  # back-edge to orchestrator doesn't add a layer
                    if dst not in layer:
                        layer[dst] = layer[src] + 1
                        parent[dst] = src
                        nxt.append(dst)
            frontier = nxt

        unreached = [n for n in names if n not in layer]
        if unreached:
            tail = (max(layer.values()) + 1) if layer else 0
            for n in unreached:
                layer[n] = tail
                parent[n] = None  # disconnected — will fall back to x0

        # Group by layer for ordered placement (top-down).
        groups: Dict[int, List[str]] = {}
        for n in names:
            groups.setdefault(layer[n], []).append(n)

        by_name = {n.name: n for n in self.nodes}
        chain_dy = card_h / 2.0  # vertical step for a chain link

        # Phase 1 — place root at a working origin (0, 0). We'll re-center
        # it horizontally after all descendants are positioned, so that
        # however wide the cascade grows, the root sits dead-centre over
        # the bounding box.
        root_node = by_name[root]
        root_node.pos_x = 0.0
        root_node.pos_y = 0.0

        # Track the rightmost x already used at each row so chain steps
        # never slide underneath a parallel sibling that's been placed
        # to the right of the chain's parent (e.g. ``docs`` next to the
        # chain start ``architect``).
        level_max_x: Dict[int, float] = {0: 0.0}

        def _bump(level: int, x: float) -> None:
            level_max_x[level] = max(level_max_x.get(level, x), x)

        # Phase 2 — walk rows top-down, placing each parent's children
        # relative to the parent.
        for row in sorted(groups.keys()):
            if row == 0:
                continue
            members = groups[row]
            # Group children by their parent so siblings of the same
            # parent get spread around that parent specifically.
            by_parent: Dict[Optional[str], List[str]] = {}
            for m in members:
                by_parent.setdefault(parent.get(m), []).append(m)

            parent_level = row - 1

            for p_name, children in by_parent.items():
                if p_name and p_name in by_name:
                    parent_node = by_name[p_name]
                    parent_x = parent_node.pos_x
                    parent_y = parent_node.pos_y
                else:
                    # Disconnected — anchor to (0, parent_level rough y).
                    parent_x = 0.0
                    parent_y = parent_level * chain_dy

                if len(children) > 1:
                    # Siblings: same y, spread around parent.x with
                    # ``col_w`` spacing. y is half-card-height below
                    # the parent so siblings sit at a clean row offset.
                    for i, name in enumerate(children):
                        offset = i - (len(children) - 1) / 2.0
                        node = by_name[name]
                        node.pos_x = parent_x + offset * col_w
                        node.pos_y = parent_y + chain_dy
                        _bump(row, node.pos_x)
                else:
                    # Chain step: one column to the right of the
                    # rightmost card already placed at the parent's
                    # row (so we clear any parallel siblings), and
                    # half a card-height down from the parent.
                    name = children[0]
                    anchor_x = max(
                        parent_x,
                        level_max_x.get(parent_level, parent_x),
                    )
                    node = by_name[name]
                    node.pos_x = anchor_x + col_w
                    node.pos_y = parent_y + chain_dy
                    _bump(row, node.pos_x)

        # Phase 3 — recentre the root horizontally over the bounding box
        # of all descendants, half a card-height above the first row.
        descendants = [n for n in self.nodes if n.name != root]
        if descendants:
            min_x = min(n.pos_x for n in descendants)
            max_x = max(n.pos_x for n in descendants)
            center_x = (min_x + max_x) / 2.0
            min_y_descendants = min(n.pos_y for n in descendants)
            root_node.pos_x = center_x
            root_node.pos_y = min_y_descendants - chain_dy

        # Phase 4 — translate the whole layout so the leftmost / topmost
        # card sits at the canvas anchor (x0, y0). Keeps every position
        # positive and the layout consistent regardless of which side
        # the chain happened to lean.
        all_nodes = self.nodes
        if all_nodes:
            min_x_overall = min(n.pos_x for n in all_nodes)
            min_y_overall = min(n.pos_y for n in all_nodes)
            dx = x0 - min_x_overall
            dy = y0 - min_y_overall
            for n in all_nodes:
                n.pos_x += dx
                n.pos_y += dy
