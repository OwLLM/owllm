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
                        col_w: float = 220.0, row_h: float = 140.0,
                        cols: int = 3) -> None:
        """Place nodes in a grid for first-time projects with no positions."""
        for i, n in enumerate(self.nodes):
            if n.pos_x == 0.0 and n.pos_y == 0.0:
                col = i % cols
                row = i // cols
                n.pos_x = x0 + col * col_w
                n.pos_y = y0 + row * row_h

    def autolayout_layered(self, orchestrator: Optional[str], *,
                           x0: float = 60.0, y0: float = 60.0,
                           col_w: float = 260.0, row_h: float = 130.0) -> None:
        """Arrange nodes in columns by graph distance from the orchestrator.

        Column 0 holds the orchestrator. Column k holds nodes whose
        shortest directed path from the orchestrator (following outbound
        edges) has length k. Nodes that aren't reachable from the
        orchestrator are appended to the right-most column. Within a
        column, nodes are stacked vertically and centred around y0.
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

        # BFS over the directed graph to assign layers.
        layer: Dict[str, int] = {root: 0}
        frontier = [root]
        while frontier:
            nxt: List[str] = []
            for src in frontier:
                for dst in adj.get(src, []):
                    if dst == root:
                        continue  # back-edge to orchestrator doesn't add a layer
                    if dst not in layer:
                        layer[dst] = layer[src] + 1
                        nxt.append(dst)
            frontier = nxt

        unreached = [n for n in names if n not in layer]
        if unreached:
            tail = (max(layer.values()) + 1) if layer else 0
            for n in unreached:
                layer[n] = tail

        # Group by layer, preserve original node order within a layer.
        groups: Dict[int, List[str]] = {}
        for n in names:
            groups.setdefault(layer[n], []).append(n)

        by_name = {n.name: n for n in self.nodes}
        for col, members in sorted(groups.items()):
            count = len(members)
            # Centre vertically: row indices -(count-1)/2 .. +(count-1)/2.
            for i, name in enumerate(members):
                offset = i - (count - 1) / 2.0
                node = by_name[name]
                node.pos_x = x0 + col * col_w
                node.pos_y = y0 + offset * row_h
