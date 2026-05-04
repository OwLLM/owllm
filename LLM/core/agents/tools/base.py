"""Tool contract + registry + approval gate.

A ``Tool`` is a name + JSON-schema-ish arg spec + a Python callable. Agents
resolve tools through a ``ToolRegistry`` (which can be filtered down to a
per-role allowlist), call them with a ``ToolCall``, and get a ``ToolResult``
back. Side-effecting tools (``write_file``, ``shell``) declare
``requires_approval=True`` and are routed through an ``ApprovalGate``: the
gate publishes a pending request, waits on a threading event, and returns the
user's decision so the agent loop can resume cleanly.
"""
from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Mapping, Optional


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class ToolError(Exception):
    """Raised by a tool when an arg is invalid or execution fails recoverably.

    Distinct from generic ``Exception`` so the agent loop can decide whether
    to surface to the user (ToolError -> retry / report) or abort (anything
    else -> crash the goal, status FAILED).
    """


# ---------------------------------------------------------------------------
# Call / result
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ToolCall:
    """An agent's request to invoke a named tool with arguments."""

    name: str
    args: Mapping[str, Any]
    id: str = field(default_factory=lambda: uuid.uuid4().hex)


@dataclass(frozen=True)
class ToolResult:
    """Outcome of a tool invocation. ``ok=False`` means the tool ran and
    reported an error in-band; the agent should see the message and try
    again. Crashes raise instead and short-circuit the loop."""

    call_id: str
    name: str
    ok: bool
    output: str
    meta: Mapping[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Tool
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ArgSpec:
    """One argument in a tool's signature."""

    name: str
    type: str            # "string" | "integer" | "number" | "boolean"
    description: str
    required: bool = True


@dataclass(frozen=True)
class Tool:
    """A named callable an agent can invoke through the registry."""

    name: str
    description: str
    args: List[ArgSpec]
    func: Callable[[Mapping[str, Any]], str]
    requires_approval: bool = False
    """If True, the registry routes calls through ``ApprovalGate`` first."""

    def invoke(self, args: Mapping[str, Any]) -> str:
        # Validate required args present. Type coercion is per-tool — most
        # built-ins accept strings and parse internally, which keeps the
        # XML-tag protocol simple.
        for spec in self.args:
            if spec.required and spec.name not in args:
                raise ToolError(f"missing required arg '{spec.name}'")
        return self.func(args)


# ---------------------------------------------------------------------------
# Approval gate
# ---------------------------------------------------------------------------


class ApprovalDecision(str, Enum):
    APPROVE = "approve"
    REJECT = "reject"
    TIMEOUT = "timeout"


@dataclass
class PendingApproval:
    """In-flight approval request. The gate hands the *agent thread* an
    Event to wait on, and the *UI thread* fills ``decision`` and sets the
    Event when the user clicks. ``reason`` is shown beside Reject."""

    id: str
    agent: str
    tool_name: str
    args: Mapping[str, Any]
    goal_id: str
    decision: Optional[ApprovalDecision] = None
    reason: str = ""
    _event: threading.Event = field(default_factory=threading.Event, repr=False)


@dataclass(frozen=True)
class ApprovalRequest:
    """Read-only snapshot of a pending approval, safe to push to the UI."""

    id: str
    agent: str
    tool_name: str
    args: Mapping[str, Any]
    goal_id: str


class ApprovalGate:
    """Blocks the agent loop on risky tools until the user decides.

    Threading: ``request`` is called from the agent worker thread and blocks
    on an ``Event``. ``resolve`` is called from the UI thread when the user
    clicks. ``listeners`` is for the UI to subscribe so it can surface new
    pending items as they arrive.
    """

    def __init__(self, default_timeout_seconds: float = 300.0) -> None:
        self._lock = threading.Lock()
        self._pending: Dict[str, PendingApproval] = {}
        self._listeners: List[Callable[[ApprovalRequest], None]] = []
        self.default_timeout_seconds = default_timeout_seconds

    # --- agent side -----------------------------------------------------

    def request(
        self,
        agent: str,
        tool_name: str,
        args: Mapping[str, Any],
        goal_id: str,
        timeout_seconds: Optional[float] = None,
    ) -> ApprovalDecision:
        """Block until the user approves/rejects, or the timeout expires."""
        pending = PendingApproval(
            id=uuid.uuid4().hex,
            agent=agent,
            tool_name=tool_name,
            args=dict(args),
            goal_id=goal_id,
        )
        with self._lock:
            self._pending[pending.id] = pending
            listeners = list(self._listeners)
        snap = ApprovalRequest(
            id=pending.id,
            agent=pending.agent,
            tool_name=pending.tool_name,
            args=pending.args,
            goal_id=pending.goal_id,
        )
        for cb in listeners:
            try:
                cb(snap)
            except Exception:  # noqa: BLE001
                pass

        timeout = self.default_timeout_seconds if timeout_seconds is None else timeout_seconds
        fired = pending._event.wait(timeout=timeout)

        with self._lock:
            self._pending.pop(pending.id, None)

        if not fired:
            return ApprovalDecision.TIMEOUT
        return pending.decision or ApprovalDecision.REJECT

    # --- UI side --------------------------------------------------------

    def list_pending(self) -> List[ApprovalRequest]:
        with self._lock:
            return [
                ApprovalRequest(
                    id=p.id,
                    agent=p.agent,
                    tool_name=p.tool_name,
                    args=p.args,
                    goal_id=p.goal_id,
                )
                for p in self._pending.values()
            ]

    def resolve(self, approval_id: str, decision: ApprovalDecision, reason: str = "") -> bool:
        with self._lock:
            pending = self._pending.get(approval_id)
            if pending is None:
                return False
            pending.decision = decision
            pending.reason = reason
        pending._event.set()
        return True

    def add_listener(self, cb: Callable[[ApprovalRequest], None]) -> None:
        with self._lock:
            self._listeners.append(cb)


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


class ToolRegistry:
    """Name -> Tool lookup. Supports per-role allowlists and approval routing.

    Also tracks per-(agent, goal) scratch state used by tools that need
    cross-call awareness — currently only the read-before-edit guard,
    which records every path a ``read_file`` returned successfully so
    ``edit_file`` can refuse to operate on a file the agent hasn't
    actually looked at yet.
    """

    def __init__(self, gate: Optional[ApprovalGate] = None) -> None:
        self._tools: Dict[str, Tool] = {}
        self.gate = gate or ApprovalGate()
        # (agent, goal_id) -> set[absolute_path_str] of files the agent
        # has read this goal. Populated by the registry's invoke loop after
        # a successful read_file; consulted by edit_file's pre-flight check.
        self._read_paths: Dict[tuple, set] = {}

    # --- registration ---------------------------------------------------

    def register(self, tool: Tool) -> None:
        if tool.name in self._tools:
            raise ValueError(f"tool already registered: {tool.name}")
        self._tools[tool.name] = tool

    def unregister(self, name: str) -> bool:
        return self._tools.pop(name, None) is not None

    # --- lookup ---------------------------------------------------------

    def names(self) -> List[str]:
        return list(self._tools.keys())

    def get(self, name: str) -> Tool:
        if name not in self._tools:
            raise ToolError(f"unknown tool: {name}")
        return self._tools[name]

    def for_allowlist(self, allowlist: Optional[List[str]]) -> "ToolRegistry":
        """Return a view of this registry containing only the named tools.

        Allowlist of ``None`` returns the full registry (orchestrator default);
        empty list returns a registry with no tools (chat-only role).

        The view shares the parent's read-tracking dict so the read-before-edit
        guard works across allowlist boundaries — an agent that gets ``read_file``
        and ``edit_file`` from the same parent registry sees a consistent view.
        """
        view = ToolRegistry(gate=self.gate)
        view._read_paths = self._read_paths
        if allowlist is None:
            for t in self._tools.values():
                view._tools[t.name] = t
            return view
        for name in allowlist:
            if name in self._tools:
                view._tools[name] = self._tools[name]
        return view

    # --- read-before-edit tracking -------------------------------------

    def mark_read(self, agent: str, goal_id: str, path: str) -> None:
        """Record that ``agent`` has successfully read ``path`` during ``goal_id``.

        Called by the registry after a successful read_file invocation.
        The ``edit_file`` tool uses :meth:`has_read` to enforce that an
        agent has actually looked at a file before mutating it — prevents
        the most common class of hallucinated edit (replacing a string
        the agent guessed at without ever loading the file).
        """
        key = (agent, goal_id)
        self._read_paths.setdefault(key, set()).add(path)

    def has_read(self, agent: str, goal_id: str, path: str) -> bool:
        return path in self._read_paths.get((agent, goal_id), set())

    def forget_reads(self, agent: str, goal_id: str) -> None:
        """Drop tracked reads for one (agent, goal). Called when a goal ends."""
        self._read_paths.pop((agent, goal_id), None)

    # --- invocation -----------------------------------------------------

    def invoke(
        self,
        call: ToolCall,
        *,
        agent: str,
        goal_id: str,
    ) -> ToolResult:
        """Resolve, optionally route through the approval gate, and execute."""
        tool = self.get(call.name)

        # edit_file enforces "must have read this file first". Check BEFORE
        # the approval gate so the user isn't asked to confirm an edit that
        # is already known to be unsafe — the agent gets a clear error
        # message it can act on (rather than discovering at write time that
        # its old_string was hallucinated).
        if tool.name == "edit_file":
            path_arg = str(call.args.get("path", "")).strip()
            if path_arg:
                from pathlib import Path as _P
                resolved = str(_P(path_arg).expanduser().resolve())
                if not self.has_read(agent, goal_id, resolved):
                    return ToolResult(
                        call_id=call.id,
                        name=tool.name,
                        ok=False,
                        output=(
                            f"refusing to edit {path_arg}: this agent hasn't read "
                            f"the file yet. Call read_file first so the edit is "
                            f"based on the actual contents."
                        ),
                    )

        if tool.requires_approval:
            decision = self.gate.request(
                agent=agent,
                tool_name=tool.name,
                args=call.args,
                goal_id=goal_id,
            )
            if decision != ApprovalDecision.APPROVE:
                return ToolResult(
                    call_id=call.id,
                    name=tool.name,
                    ok=False,
                    output=f"approval {decision.value}",
                    meta={"decision": decision.value},
                )

        try:
            output = tool.invoke(call.args)
        except ToolError as exc:
            return ToolResult(
                call_id=call.id,
                name=tool.name,
                ok=False,
                output=str(exc),
            )

        # On a successful read_file, record the path so edit_file can verify
        # the precondition above. Done here (not inside the tool) so the
        # tool function stays a pure (args -> str) callable.
        if tool.name == "read_file":
            path_arg = str(call.args.get("path", "")).strip()
            if path_arg:
                from pathlib import Path as _P
                try:
                    resolved = str(_P(path_arg).expanduser().resolve())
                    self.mark_read(agent, goal_id, resolved)
                except Exception:  # noqa: BLE001
                    pass

        return ToolResult(call_id=call.id, name=tool.name, ok=True, output=output)
