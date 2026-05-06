"""Tool contract + registry + approval gate.

A ``Tool`` is a name + JSON-schema-ish arg spec + a Python callable. Agents
resolve tools through a ``ToolRegistry`` (which can be filtered down to a
per-role allowlist), call them with a ``ToolCall``, and get a ``ToolResult``
back. Side-effecting tools (``write_file``, ``shell``) declare
``requires_approval=True`` and are routed through an ``ApprovalGate``: the
gate publishes a pending request, waits on a threading event, and returns the
user's decision so the agent loop can resume cleanly.

The registry also runs three reliability layers around every call:

1. **Read-before-edit guard** — ``edit_file`` is rejected pre-approval if
   the agent hasn't read the target file in this goal.
2. **Transient retry** — read-only tools (``http_get``, ``grep`` when ripgrep
   exits with a transient signal) get one automatic retry on specific
   error patterns. Side-effecting tools never auto-retry; they go back to
   the agent so it can decide.
3. **Crash isolation** — unexpected exceptions are caught, logged, and
   returned as ``ok=False`` results. A buggy tool can no longer kill the
   whole goal.

All invocations are timed and counted in :class:`ToolTelemetry` so the UI
can show per-agent activity (call count, error rate, p50/p95 latency).
"""
from __future__ import annotations

import logging
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Mapping, Optional

logger = logging.getLogger(__name__)


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


@dataclass
class AutoApproveRule:
    """A predicate-based shortcut around the gate.

    The user can register rules like "always approve shell commands that
    just run pytest" or "auto-reject anything that targets /etc". The
    gate evaluates rules in registration order on every ``request()``
    call BEFORE blocking — a matching rule short-circuits to its decision
    and the UI never sees the pending. Rules are first-class so they can
    be listed, removed, or persisted by the caller.
    """

    name: str                                        # human-readable label
    predicate: Callable[["ApprovalRequest"], bool]   # match function
    decision: "ApprovalDecision"                     # APPROVE or REJECT
    reason: str = "auto-rule"


class ApprovalGate:
    """Blocks the agent loop on risky tools until the user decides.

    Threading: ``request`` is called from the agent worker thread and blocks
    on an ``Event``. ``resolve`` is called from the UI thread when the user
    clicks. ``listeners`` is for the UI to subscribe so it can surface new
    pending items as they arrive.

    Reliability features layered on top of the basic block-and-resolve loop:

    * **Auto-approve rules** — predicates registered via ``add_rule`` run
      synchronously inside ``request``. A matching rule resolves the call
      immediately without ever publishing a pending. Use these for "I
      always trust the verify command" or "auto-reject any shell that
      touches /etc". Rules can be listed and removed by name.
    * **Bulk resolution** — ``resolve_matching(predicate, decision)``
      decides every currently-pending approval that matches at once. The
      UI uses this to surface "Approve all 5 pending shell commands"
      without clicking through each individually.
    * **Pending-count listener** — a separate listener channel fires with
      the new pending count whenever it changes, so the UI can update a
      badge live without polling ``list_pending`` on a timer.

    The original per-request ``add_listener`` channel still works
    unchanged; the new mechanisms are additive.
    """

    def __init__(self, default_timeout_seconds: float = 300.0) -> None:
        self._lock = threading.Lock()
        self._pending: Dict[str, PendingApproval] = {}
        self._listeners: List[Callable[[ApprovalRequest], None]] = []
        self._count_listeners: List[Callable[[int], None]] = []
        self._rules: List[AutoApproveRule] = []
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
        """Block until the user approves/rejects, or the timeout expires.

        Auto-approve rules fire synchronously here — if any rule's
        predicate matches the request snapshot, we return its decision
        immediately without publishing a pending or notifying listeners.
        That's the path most "I always trust pytest" calls take.
        """
        snap = ApprovalRequest(
            id=uuid.uuid4().hex,
            agent=agent,
            tool_name=tool_name,
            args=dict(args),
            goal_id=goal_id,
        )

        # Evaluate auto-approve rules first. A rule's predicate may
        # raise (user-supplied code) — treat that as no-match rather
        # than failing the whole request.
        with self._lock:
            rules = list(self._rules)
        for rule in rules:
            try:
                if rule.predicate(snap):
                    logger.info(
                        "auto-rule '%s' resolved %s/%s -> %s",
                        rule.name, agent, tool_name, rule.decision.value,
                    )
                    return rule.decision
            except Exception:  # noqa: BLE001
                logger.exception("auto-approve rule '%s' raised; skipping", rule.name)

        pending = PendingApproval(
            id=snap.id,
            agent=agent,
            tool_name=tool_name,
            args=dict(args),
            goal_id=goal_id,
        )
        with self._lock:
            self._pending[pending.id] = pending
            listeners = list(self._listeners)
            count_listeners = list(self._count_listeners)
            new_count = len(self._pending)

        for cb in listeners:
            try:
                cb(snap)
            except Exception:  # noqa: BLE001
                pass
        self._fire_count(count_listeners, new_count)

        timeout = self.default_timeout_seconds if timeout_seconds is None else timeout_seconds
        fired = pending._event.wait(timeout=timeout)

        with self._lock:
            self._pending.pop(pending.id, None)
            count_listeners = list(self._count_listeners)
            new_count = len(self._pending)
        self._fire_count(count_listeners, new_count)

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

    def pending_count(self) -> int:
        with self._lock:
            return len(self._pending)

    def resolve(self, approval_id: str, decision: ApprovalDecision, reason: str = "") -> bool:
        with self._lock:
            pending = self._pending.get(approval_id)
            if pending is None:
                return False
            pending.decision = decision
            pending.reason = reason
        pending._event.set()
        return True

    def resolve_matching(
        self,
        predicate: Callable[["ApprovalRequest"], bool],
        decision: ApprovalDecision,
        *,
        reason: str = "bulk decision",
    ) -> int:
        """Resolve every currently-pending approval whose snapshot matches.

        Returns the number of approvals resolved. Used by UI primitives
        like "Approve all pending shell commands". Predicate errors on
        any single pending are treated as no-match (don't poison the
        whole batch) and logged.
        """
        with self._lock:
            snapshots = [
                (p.id, ApprovalRequest(
                    id=p.id,
                    agent=p.agent,
                    tool_name=p.tool_name,
                    args=p.args,
                    goal_id=p.goal_id,
                ), p)
                for p in self._pending.values()
            ]
        resolved = 0
        for approval_id, snap, pending in snapshots:
            try:
                if not predicate(snap):
                    continue
            except Exception:  # noqa: BLE001
                logger.exception("resolve_matching predicate raised; skipping %s", approval_id)
                continue
            with self._lock:
                if approval_id not in self._pending:
                    continue
                pending.decision = decision
                pending.reason = reason
            pending._event.set()
            resolved += 1
        if resolved:
            with self._lock:
                count_listeners = list(self._count_listeners)
                new_count = len(self._pending)
            self._fire_count(count_listeners, new_count)
        return resolved

    def add_listener(self, cb: Callable[[ApprovalRequest], None]) -> None:
        with self._lock:
            self._listeners.append(cb)

    def add_count_listener(self, cb: Callable[[int], None]) -> None:
        """Register a callback fired with the new pending-count whenever
        it changes (a request lands, a request resolves, a bulk-decision
        fires). Use this for a UI badge — cheaper than polling."""
        with self._lock:
            self._count_listeners.append(cb)

    @staticmethod
    def _fire_count(callbacks: List[Callable[[int], None]], count: int) -> None:
        for cb in callbacks:
            try:
                cb(count)
            except Exception:  # noqa: BLE001
                pass

    # --- auto-approve rules --------------------------------------------

    def add_rule(self, rule: AutoApproveRule) -> None:
        """Register an auto-approve / auto-reject rule. Rules evaluate in
        registration order; the first match wins. Names should be unique
        — registering the same name twice silently replaces the old rule
        (so reloading config from disk is idempotent)."""
        with self._lock:
            self._rules = [r for r in self._rules if r.name != rule.name]
            self._rules.append(rule)

    def remove_rule(self, name: str) -> bool:
        """Remove a rule by name. Returns True if anything was removed."""
        with self._lock:
            before = len(self._rules)
            self._rules = [r for r in self._rules if r.name != name]
            return len(self._rules) != before

    def list_rules(self) -> List[AutoApproveRule]:
        """Return a snapshot of currently-registered rules in order."""
        with self._lock:
            return list(self._rules)

    def clear_rules(self) -> None:
        with self._lock:
            self._rules.clear()


# ---------------------------------------------------------------------------
# Telemetry
# ---------------------------------------------------------------------------


@dataclass
class ToolStat:
    """Rolling stats for one tool. Latencies stored as a bounded ring so
    p50/p95 stay constant-memory even under heavy use."""

    calls: int = 0
    errors: int = 0
    crashes: int = 0
    retries: int = 0
    last_error: str = ""
    _latencies_ms: List[float] = field(default_factory=list)
    _latency_ring_max: int = 200

    def record(self, latency_ms: float, *, ok: bool, crashed: bool, error: str = "") -> None:
        self.calls += 1
        if not ok:
            self.errors += 1
            self.last_error = error[:200]
        if crashed:
            self.crashes += 1
        self._latencies_ms.append(latency_ms)
        if len(self._latencies_ms) > self._latency_ring_max:
            del self._latencies_ms[: len(self._latencies_ms) - self._latency_ring_max]

    def percentiles(self) -> Dict[str, float]:
        if not self._latencies_ms:
            return {"p50": 0.0, "p95": 0.0}
        s = sorted(self._latencies_ms)
        return {
            "p50": s[len(s) // 2],
            "p95": s[min(len(s) - 1, int(len(s) * 0.95))],
        }


class ToolTelemetry:
    """Thread-safe per-tool stats. One instance per ``ToolRegistry`` tree.

    The Studio / Workspace can call :meth:`snapshot` to render an activity
    panel. Stats persist for the registry's lifetime; reset between goals
    via :meth:`reset` if you want per-goal numbers.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._stats: Dict[str, ToolStat] = {}

    def record(
        self,
        tool_name: str,
        latency_ms: float,
        *,
        ok: bool,
        crashed: bool = False,
        error: str = "",
    ) -> None:
        with self._lock:
            self._stats.setdefault(tool_name, ToolStat()).record(
                latency_ms, ok=ok, crashed=crashed, error=error
            )

    def record_retry(self, tool_name: str) -> None:
        with self._lock:
            self._stats.setdefault(tool_name, ToolStat()).retries += 1

    def snapshot(self) -> Dict[str, Dict[str, Any]]:
        with self._lock:
            return {
                name: {
                    "calls": s.calls,
                    "errors": s.errors,
                    "crashes": s.crashes,
                    "retries": s.retries,
                    "last_error": s.last_error,
                    **s.percentiles(),
                }
                for name, s in self._stats.items()
            }

    def reset(self) -> None:
        with self._lock:
            self._stats.clear()


# Substrings that signal a transient failure worth one auto-retry. Kept
# narrow on purpose — anything not in this set is bubbled to the agent so
# it can decide. Side-effecting tools never auto-retry regardless.
_TRANSIENT_PATTERNS = (
    "temporarily unavailable",
    "connection reset",
    "connection refused",
    "broken pipe",
    "timed out",
    "remote end closed",
    "ECONNRESET",
    "EPIPE",
    "503 Service Unavailable",
    "502 Bad Gateway",
    "504 Gateway Timeout",
)


def _is_transient(message: str) -> bool:
    if not message:
        return False
    lowered = message.lower()
    return any(p.lower() in lowered for p in _TRANSIENT_PATTERNS)


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

    def __init__(
        self,
        gate: Optional[ApprovalGate] = None,
        telemetry: Optional[ToolTelemetry] = None,
    ) -> None:
        self._tools: Dict[str, Tool] = {}
        self.gate = gate or ApprovalGate()
        self.telemetry = telemetry or ToolTelemetry()
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
        view = ToolRegistry(gate=self.gate, telemetry=self.telemetry)
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

        # ``verify`` is special: gated only when the agent passes an
        # explicit ``command`` override (effectively an arbitrary shell
        # call). The configured command from .owllm/verify.json is pre-
        # blessed by the user — gating it would defeat the auto-verify
        # loop's whole point. The same logic kicks in for the auto-
        # invocation below, where ``call.meta`` carries an "auto" flag.
        gate_required = tool.requires_approval
        if tool.name == "verify":
            override = str(call.args.get("command", "")).strip()
            if not override:
                gate_required = False

        if gate_required:
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

        # Pin (agent, goal_id) on a thread-local so tools that need the
        # caller's identity (notably spawn_agent, which has no other way
        # to discover who's calling) can read it. Cleaned up below in
        # the finally block of the run loop.
        try:
            from core.agents.spawn import set_invocation_context, clear_invocation_context
            set_invocation_context(agent=agent, goal_id=goal_id)
            _ctx_cleanup = clear_invocation_context
        except Exception:  # noqa: BLE001
            _ctx_cleanup = lambda: None

        # Run with: telemetry timing, transient retry (read-only tools only),
        # crash isolation. Side-effecting tools never auto-retry — the agent
        # has to be the one to decide whether a retry is safe.
        max_attempts = 1 if tool.requires_approval else 2
        last_err = ""
        crashed = False
        output: Optional[str] = None
        ok = False

        for attempt in range(1, max_attempts + 1):
            t0 = time.monotonic()
            try:
                output = tool.invoke(call.args)
                ok = True
                last_err = ""
                break
            except ToolError as exc:
                last_err = str(exc)
                if attempt < max_attempts and _is_transient(last_err):
                    self.telemetry.record_retry(tool.name)
                    logger.info(
                        "transient %s on %s, retrying once: %s",
                        tool.name, agent, last_err,
                    )
                    time.sleep(0.25 * attempt)
                    continue
                break
            except Exception as exc:  # noqa: BLE001
                # Crash isolation: any non-ToolError is a bug in the tool
                # (or in upstream code it called). Log the full traceback
                # for debugging, surface a sanitized one-liner to the agent.
                crashed = True
                last_err = f"{type(exc).__name__}: {exc}"
                logger.exception("tool %s crashed for agent %s", tool.name, agent)
                # Save the trace once for diagnostics.
                trace_summary = traceback.format_exc(limit=4)
                self.telemetry.record(
                    tool.name,
                    (time.monotonic() - t0) * 1000.0,
                    ok=False,
                    crashed=True,
                    error=last_err,
                )
                return ToolResult(
                    call_id=call.id,
                    name=tool.name,
                    ok=False,
                    output=(
                        f"tool crashed: {last_err}. This is a bug — the tool "
                        f"raised an unexpected exception. Try a different approach."
                    ),
                    meta={"crashed": True, "trace": trace_summary},
                )
            finally:
                # Telemetry record on every attempt that didn't already
                # short-circuit on crash.
                if not crashed:
                    self.telemetry.record(
                        tool.name,
                        (time.monotonic() - t0) * 1000.0,
                        ok=ok,
                        crashed=False,
                        error=last_err,
                    )

        # Tear down the invocation context now that the tool has finished
        # (or failed). Done here, not in a finally on the run loop, because
        # we still need the auto-verify block below to run with no leak.
        try:
            _ctx_cleanup()
        except Exception:  # noqa: BLE001
            pass

        # On a successful read_file, record the path so edit_file can verify
        # the precondition above. Done here (not inside the tool) so the
        # tool function stays a pure (args -> str) callable.
        if ok and tool.name == "read_file":
            path_arg = str(call.args.get("path", "")).strip()
            if path_arg:
                from pathlib import Path as _P
                try:
                    resolved = str(_P(path_arg).expanduser().resolve())
                    self.mark_read(agent, goal_id, resolved)
                except Exception:  # noqa: BLE001
                    pass

        # Auto-verify hook. After a successful edit_file or
        # write_file_with_diff, walk up from the edited file looking for
        # .owllm/verify.json. If found AND the verify tool is registered
        # in this view, run the configured command and append its output
        # to the edit's tool result. The agent sees breakage in the same
        # turn and can self-correct without an extra round-trip.
        if ok and tool.name in ("edit_file", "write_file_with_diff"):
            verify_text = self._maybe_auto_verify(call.args.get("path"))
            if verify_text:
                output = (output or "") + "\n\n--- AUTO-VERIFY ---\n" + verify_text

        if not ok:
            return ToolResult(
                call_id=call.id,
                name=tool.name,
                ok=False,
                output=last_err,
            )
        return ToolResult(call_id=call.id, name=tool.name, ok=True, output=output or "")

    # ------------------------------------------------------------------
    # Auto-verify
    # ------------------------------------------------------------------

    def _maybe_auto_verify(self, edited_path_arg: Any) -> Optional[str]:
        """Run the project's verify command if configured and not disabled.

        Triggers iff:
          - a ``.owllm/verify.json`` exists at or above the edited file,
          - its ``trigger`` is ``after_edit``,
          - ``verify`` is a registered tool in this registry view (so the
            agent's allowlist can opt out by omitting it).
        Failures (no config, parse error, command crash) return None
        instead of raising — auto-verify must never bury the edit's own
        success.
        """
        if "verify" not in self._tools:
            return None
        try:
            from pathlib import Path as _P
            from core.agents.tools.verify import find_verify_config, run_verify
            start = _P(str(edited_path_arg)).expanduser() if edited_path_arg else _P.cwd()
            config = find_verify_config(start)
            if config is None or not config.auto:
                return None
            return run_verify(config)
        except Exception:  # noqa: BLE001
            logger.exception("auto-verify failed; ignoring")
            return None
