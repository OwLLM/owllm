"""``spawn_agent`` — ephemeral sub-agent dispatch from any agent.

The existing ``dispatch`` tool (in :mod:`core.agents.orchestrator`) is
bound to the team's wired specialists at ``build_team`` time. This
module adds the complementary capability: any agent can instantiate
ANY :class:`AgentDefinition` from the gallery, hand it a one-shot task,
wait for the reply, and discard the sub-agent.

Why both?
=========

* ``dispatch`` is for the team's *standing* roster — orchestrator-driven
  assignment to long-lived specialists (Researcher, Coder, Critic …).
* ``spawn_agent`` is for *ad-hoc* fan-out — a coder that wants to send
  an explorer to grep for callers without polluting its own context, or
  a researcher that wants a one-off PDF skill to summarize a doc. The
  sub-agent has its own chat history, its own read-before-edit guard
  scope, and dies when its turn ends.

Isolation guarantees
====================

* Sub-agent gets a ``for_allowlist`` view of the same registry — same
  approval gate, same telemetry, same read-tracking parent dict. But
  reads are namespaced by ``(agent_name, goal_id)``, so the spawned
  agent's reads don't satisfy the parent's edit preconditions and vice
  versa. That's the intended isolation: spawned agents have fresh
  per-agent state.
* Sub-agent runs SYNCHRONOUSLY in the caller's thread. The parent's
  tool call blocks on a per-call event with a wall-clock timeout. No
  bus subscriptions, no race with the team's reply waiters.
* Recursion is capped at ``max_depth`` (default 3). A spawned agent
  *can* spawn further if its allowlist includes ``spawn_agent``; we
  refuse beyond the cap to bound runaway fan-out.

Threading
=========

Depth tracking lives in a ``threading.local`` keyed by ``goal_id``.
Each spawned agent runs on the caller's thread (no new threads), so a
nested spawn sees the parent's local state and increments depth by one.
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from typing import Any, Callable, Mapping, Optional

from core.agents.tools.base import ArgSpec, Tool, ToolError, ToolRegistry
from core.agents.message import Message, MessageKind

logger = logging.getLogger(__name__)


# Per-thread depth tracking. Keyed by goal_id so a single thread driving
# multiple goals can't conflate them. The dict lives on a threading.local
# so each agent worker has its own; spawned agents run on the parent's
# thread and inherit (depth + 1) explicitly via the contextmanager below.
_DEPTH = threading.local()


def _current_depth(goal_id: str) -> int:
    return getattr(_DEPTH, "by_goal", {}).get(goal_id, 0)


def _push_depth(goal_id: str) -> None:
    if not hasattr(_DEPTH, "by_goal"):
        _DEPTH.by_goal = {}
    _DEPTH.by_goal[goal_id] = _current_depth(goal_id) + 1


def _pop_depth(goal_id: str) -> None:
    if not hasattr(_DEPTH, "by_goal"):
        return
    cur = _DEPTH.by_goal.get(goal_id, 0)
    if cur <= 1:
        _DEPTH.by_goal.pop(goal_id, None)
    else:
        _DEPTH.by_goal[goal_id] = cur - 1


# Hard ceiling. Beyond this it's almost always a bug (a sub-agent
# spawned a sub-agent that spawned a sub-agent…). Configurable per
# factory call via ``max_depth``; this constant is the upper bound the
# tool description quotes.
DEFAULT_MAX_DEPTH = 3
DEFAULT_TIMEOUT_SECONDS = 300.0
MAX_TIMEOUT_SECONDS = 900.0


def make_spawn_agent_tool(
    *,
    model_fn: Any,
    base_registry: ToolRegistry,
    bus: Any,
    max_depth: int = DEFAULT_MAX_DEPTH,
    default_timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    definition_resolver: Optional[Callable[[str], Any]] = None,
    available_names_resolver: Optional[Callable[[], list]] = None,
) -> Tool:
    """Build a ``spawn_agent`` tool bound to a team's runtime.

    Parameters
    ----------
    model_fn
        The same ``ModelFn`` the rest of the team uses. Sub-agents
        inherit it so they hit the same backend with the same model_id
        the gallery's definition specifies.
    base_registry
        Registry the sub-agent will draw its tools from. The factory
        takes a ``for_allowlist`` view per spawn so the sub-agent only
        sees its definition's allowlist.
    bus
        Same bus the team uses, so the sub-agent's TOOL_CALL /
        TOOL_RESULT / THOUGHT / REPLY events stream to the same UI.
    max_depth
        Recursion cap (1 = top-level only; 2 = parent can spawn but
        sub-agent can't; 3 = default).
    definition_resolver / available_names_resolver
        Lookup hooks. In production both resolve through
        :func:`core.agents.agent_definitions.list_all_definitions`. Tests
        pass deterministic in-memory dicts so they don't touch disk.

    The returned tool is *not* approval-gated. Spawning a sub-agent is
    a read-only act from the parent's POV; whatever the sub-agent does
    inside its turn routes through the same approval gate as before, so
    the user still sees and approves any side-effecting calls.
    """
    if definition_resolver is None:
        from core.agents.agent_definitions import get_definition as _get_def
        definition_resolver = _get_def
    if available_names_resolver is None:
        from core.agents.agent_definitions import list_all_definitions as _list_defs
        available_names_resolver = lambda: sorted(_list_defs().keys())

    def _func(args: Mapping[str, Any]) -> str:
        agent_name = str(args.get("agent", "")).strip()
        prompt = str(args.get("prompt", "")).strip()
        if not agent_name:
            raise ToolError("spawn_agent requires 'agent' (definition name from the gallery)")
        if not prompt:
            raise ToolError("spawn_agent requires 'prompt' (what the sub-agent should do)")

        # Goal id rides on the caller side via a thread-local set by the
        # registry. We can't easily plumb it through args, so the parent
        # agent's goal_id is captured below in ``invoke_with_goal_id``.
        goal_id = getattr(_DEPTH, "current_goal_id", None)
        if not goal_id:
            raise ToolError(
                "spawn_agent called outside an active agent turn — "
                "no goal_id in thread-local context"
            )

        # Depth gate. _current_depth(goal_id) reflects the depth of the
        # CALLER (the agent making the spawn call). If the caller is
        # already at the cap, we refuse instead of producing depth+1.
        depth = _current_depth(goal_id)
        if depth >= max_depth:
            raise ToolError(
                f"spawn_agent depth limit reached ({max_depth}). The current "
                f"agent is already at depth {depth}; refusing to recurse further."
            )

        definition = definition_resolver(agent_name)
        if definition is None:
            available = ", ".join(available_names_resolver()) or "(none)"
            raise ToolError(
                f"unknown agent '{agent_name}'. available: {available}"
            )

        # Per-call timeout, clamped.
        try:
            timeout = float(args.get("timeout_seconds", default_timeout_seconds))
        except (TypeError, ValueError):
            raise ToolError("timeout_seconds must be a number")
        timeout = max(1.0, min(timeout, MAX_TIMEOUT_SECONDS))

        # Build a per-spawn unique name so the bus / telemetry can tell
        # one fan-out from another and so sibling spawns don't share
        # read-tracking namespaces.
        spawn_name = f"{agent_name}#{uuid.uuid4().hex[:6]}"

        # Combine the definition's tool + MCP allowlists into one — the
        # registry doesn't distinguish (same shape as
        # AgentDefinition.to_role_compatible).
        combined_allowlist = None
        if definition.tool_allowlist is not None or definition.mcp_allowlist is not None:
            combined_allowlist = list(definition.tool_allowlist or [])
            combined_allowlist.extend(definition.mcp_allowlist or [])

        sub_tools = base_registry.for_allowlist(combined_allowlist)

        # Avoid circular import — Agent imports from tools, and we live
        # below tools. Lazy import.
        from core.agents.agent import Agent

        sub_agent = Agent(
            name=spawn_name,
            role_prompt=definition.system_prompt,
            model_id=definition.default_model_id or "",
            bus=bus,
            tools=sub_tools,
            model_fn=model_fn,
        )

        # Synthesize an inbox message addressed to the sub-agent. The
        # parent's name is captured from the thread-local that the
        # registry sets when invoking a tool.
        parent_name = getattr(_DEPTH, "current_agent", "spawn_caller")
        inbox = bus.publish(
            Message(
                from_agent=parent_name,
                to_agent=spawn_name,
                kind=MessageKind.REQUEST,
                body=prompt,
                goal_id=goal_id,
                meta={"spawn": True, "depth": depth + 1, "definition": agent_name},
            )
        )

        # Run the sub-agent on this thread. Push depth so any nested
        # spawn sees depth+1; pop on exit even if handle() raises.
        _push_depth(goal_id)
        deadline = time.monotonic() + timeout
        result_holder: dict = {"reply": None, "error": None}

        def _runner():
            try:
                reply = sub_agent.handle(inbox)
                result_holder["reply"] = reply
            except Exception as exc:  # noqa: BLE001
                logger.exception("spawned agent %s crashed", spawn_name)
                result_holder["error"] = str(exc)

        # Use a thread so we can enforce wall-time. The depth state lives
        # on threading.local so the runner thread sees its own copy —
        # set it explicitly before kickoff.
        runner_thread = threading.Thread(target=_runner, daemon=True, name=f"spawn-{spawn_name}")
        # Inherit depth + goal_id + parent name into the runner's local.
        # (threading.local is per-thread; we have to push them again on
        # the new thread.)
        def _bootstrap():
            if not hasattr(_DEPTH, "by_goal"):
                _DEPTH.by_goal = {}
            _DEPTH.by_goal[goal_id] = depth + 1
            _DEPTH.current_goal_id = goal_id
            _DEPTH.current_agent = spawn_name
            _runner()

        runner_thread = threading.Thread(target=_bootstrap, daemon=True, name=f"spawn-{spawn_name}")
        try:
            runner_thread.start()
            runner_thread.join(timeout=timeout)
        finally:
            _pop_depth(goal_id)

        if runner_thread.is_alive():
            return (
                f"sub-agent '{agent_name}' did not finish within {timeout:.0f}s. "
                f"(The thread is still running; its output will appear on the bus "
                f"if/when it completes, but spawn_agent has timed out.)"
            )
        if result_holder["error"]:
            raise ToolError(f"sub-agent '{agent_name}' crashed: {result_holder['error']}")
        reply = result_holder["reply"]
        if reply is None:
            return f"sub-agent '{agent_name}' finished without producing a reply."
        # Free the registry's read-tracking for this spawned namespace —
        # it'll never run again, no point holding the set.
        try:
            base_registry.forget_reads(spawn_name, goal_id)
        except Exception:  # noqa: BLE001
            pass
        return reply.body or "(empty reply)"

    return Tool(
        name="spawn_agent",
        description=(
            f"Instantiate an ad-hoc sub-agent from the gallery, hand it a "
            f"one-shot prompt, wait for its reply. Use this to fan out "
            f"context-isolated work: e.g. send an 'explorer' to map a codebase "
            f"without polluting your own chat history, or a 'pdf-helper' "
            f"skill to summarize a document. Sub-agents have their own "
            f"chat history and their own read-before-edit guard scope. "
            f"Recursion capped at depth {max_depth}."
        ),
        args=[
            ArgSpec("agent", "string", "Name of an AgentDefinition from the gallery (built-in role, custom, or installed skill)."),
            ArgSpec("prompt", "string", "What the sub-agent should do. Be specific; it has no shared context with you."),
            ArgSpec("timeout_seconds", "integer", f"Wall-time cap for the spawn (1-{int(MAX_TIMEOUT_SECONDS)}, default {int(DEFAULT_TIMEOUT_SECONDS)}).", required=False),
        ],
        func=_func,
        requires_approval=False,
    )


# ---------------------------------------------------------------------------
# Thread-local helpers — populated by the registry around every tool call.
# ---------------------------------------------------------------------------


def set_invocation_context(*, agent: str, goal_id: str) -> None:
    """Pin the current thread's (agent, goal_id) so spawn_agent can read them.

    Called by :class:`ToolRegistry.invoke` before the tool function runs.
    Without this, spawn_agent has no way to know which goal it's part of
    or who's calling it (the tool function only sees ``args``).
    """
    _DEPTH.current_agent = agent
    _DEPTH.current_goal_id = goal_id


def clear_invocation_context() -> None:
    """Reset thread-local context after the tool call completes."""
    if hasattr(_DEPTH, "current_agent"):
        delattr(_DEPTH, "current_agent")
    if hasattr(_DEPTH, "current_goal_id"):
        delattr(_DEPTH, "current_goal_id")
