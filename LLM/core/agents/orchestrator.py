"""Team — orchestrator + specialists running on the bus.

The ``Team`` class wires N agents together with a shared bus and a shared
approval gate. Specialists subscribe to their own name; the orchestrator
subscribes to itself AND owns a special ``dispatch`` tool that publishes
REQUEST messages to specialists by name and blocks waiting for the REPLY.

This is intentionally synchronous-feeling: the orchestrator emits a
dispatch, the specialist's loop fires (driven by its own subscription),
publishes a REPLY, and the orchestrator's blocking dispatch returns the
reply text. From the model's point of view it's just another tool call.
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional

from core.agents.agent import Agent, ModelFn
from core.agents.attachments import (
    Attachment,
    attachments_to_meta,
    build_augmented_request,
)
from core.agents.bus import Bus
from core.agents.media_transcribe import process_attachments as _transcribe_attachments
from core.agents.message import Goal, GoalStatus, Message, MessageKind
from core.agents.roles.loader import Role
from core.agents.tools import (
    ApprovalGate,
    ArgSpec,
    Tool,
    ToolError,
    ToolRegistry,
    builtin_registry,
)
from core.agents.tools.base import ToolCall as _ToolCall  # noqa: F401  -- re-export hint

logger = logging.getLogger(__name__)


# Hard cap on per-dispatch wait time. The orchestrator's tool call blocks
# on the specialist's reply; if the specialist hangs, the dispatch tool
# raises and the orchestrator can decide what to do. Goal-level wall-time
# remains the outer safety net.
#
# Sized to be longer than the inner CLI timeout (180s in claude_cli /
# codex_cli) PLUS the specialist's tool round-trips. A specialist that
# reads a file then asks the model again is already 2x180s = 6 min in the
# worst case, so we give dispatch 5 min + buffer. The outer goal wall-time
# (default 600s) can still cap the whole run.
DEFAULT_DISPATCH_TIMEOUT_SECONDS = 360.0


# ---------------------------------------------------------------------------
# Dispatch tool factory
# ---------------------------------------------------------------------------


def _make_dispatch_tool(
    bus: Bus,
    orchestrator_name: str,
    specialists: Dict[str, "_SpecialistRunner"],
    timeout_seconds: float,
    *,
    graph_resolver: Optional[Callable[[str], Optional[str]]] = None,
) -> Tool:
    """Build the ``dispatch`` tool bound to this Team's specialists.

    Without a ``graph_resolver`` the tool does point-to-point dispatch:
      1. Validate the target agent exists and isn't the orchestrator itself.
      2. Publish a REQUEST message to the bus addressed to that agent.
      3. Block on a per-message threading.Event keyed on the request id;
         the specialist's runner sets the Event when its REPLY publishes.
      4. Return the reply text.

    With a ``graph_resolver(from_agent) -> Optional[str]`` (typically
    bound to ``AgentGraph.next_target``), the tool ALSO follows the
    project's routing pipeline. After the first specialist replies, if
    the resolver names a successor, the tool re-publishes the reply as a
    REQUEST to that successor and waits again. Only when the chain
    terminates (resolver returns ``None``) does the orchestrator's tool
    call return — with the LAST node's reply body. From the
    orchestrator's perspective this is still a single dispatch call.
    """

    def _dispatch_one(target: str, task: str, goal_id: str, parent_request_id: Optional[str]) -> str:
        runner = specialists[target]
        request = bus.publish(
            Message(
                from_agent=orchestrator_name if parent_request_id is None else "graph_router",
                to_agent=target,
                kind=MessageKind.REQUEST,
                body=task,
                goal_id=goal_id,
                parent_id=parent_request_id,
            )
        )
        event, holder = runner.team.expect_reply(request.id)
        if not event.wait(timeout=timeout_seconds):
            runner.team.discard_reply(request.id)
            raise ToolError(f"specialist '{target}' did not reply within {timeout_seconds:.0f}s")
        return holder["body"] if holder.get("body") is not None else "(empty reply)"

    def func(args: Mapping[str, Any]) -> str:
        target = str(args.get("agent", "")).strip()
        task = str(args.get("task", "")).strip()
        if not target:
            raise ToolError("dispatch requires 'agent' (the specialist name)")
        if not task:
            raise ToolError("dispatch requires 'task' (what the specialist should do)")
        if target == orchestrator_name:
            raise ToolError("dispatch cannot target the orchestrator")
        if target not in specialists:
            # Alias-tolerant resolution: team templates materialise
            # specialists as ``<team>.<short_name>`` (e.g.
            # ``learning_tutor.explainer``). The orchestrator's prompt
            # carries an AUTHORITATIVE roster using the prefixed names,
            # but the user-written extra_prompt and the base role's
            # default team list both use the short names — so models
            # often call dispatch(agent="explainer"). Resolve the short
            # name when it uniquely identifies a specialist; otherwise
            # raise the ambiguous-/unknown-name error so the model can
            # self-correct.
            suffix_matches = [
                n for n in specialists
                if n.endswith("." + target) or n == target
            ]
            if len(suffix_matches) == 1:
                target = suffix_matches[0]
            else:
                available = ", ".join(sorted(specialists)) or "(none)"
                if len(suffix_matches) > 1:
                    raise ToolError(
                        f"agent '{args.get('agent', '')}' is ambiguous — "
                        f"matches {', '.join(suffix_matches)}. "
                        f"Use the full name."
                    )
                raise ToolError(
                    f"unknown agent '{args.get('agent', '')}'. available: {available}"
                )

        # Active goal lookup via any specialist's team back-reference.
        goal_id = specialists[target].team.active_goal_id
        if goal_id is None:
            raise ToolError("no active goal — dispatch called outside a run")

        # First hop — orchestrator → first specialist.
        body = _dispatch_one(target, task, goal_id, parent_request_id=None)

        # Walk the graph if any — bounded so a misconfigured cycle can't
        # spin the orchestrator forever.
        if graph_resolver is None:
            return body
        seen = {target}
        current = target
        for _ in range(16):  # generous chain length cap
            nxt = graph_resolver(current)
            if not nxt or nxt == orchestrator_name:
                return body  # chain terminates; LAST reply goes to orchestrator
            if nxt in seen:
                logger.warning("graph cycle detected at %s; truncating chain", nxt)
                return body
            if nxt not in specialists:
                logger.warning("graph references unknown specialist '%s'; truncating", nxt)
                return body
            seen.add(nxt)
            # Forward the previous specialist's reply as the task for the
            # next stage. This is the canonical "review chain" semantic:
            # the next agent operates on what the prior produced.
            body = _dispatch_one(nxt, body, goal_id, parent_request_id=None)
            current = nxt
        logger.warning("graph chain exceeded 16 hops; truncating")
        return body

    return Tool(
        name="dispatch",
        description=(
            "Send a subtask to a specialist agent and wait for their reply. "
            "Use one specialist per concern. Wait for one to finish before "
            "dispatching the next."
        ),
        args=[
            ArgSpec("agent", "string", "Specialist name (e.g. researcher, coder, operator, critic)."),
            ArgSpec("task", "string", "Concrete instruction. Be specific."),
        ],
        func=func,
        requires_approval=False,
    )


# ---------------------------------------------------------------------------
# Specialist runner
# ---------------------------------------------------------------------------


class _SpecialistRunner:
    """Glue between the bus subscription and an Agent.

    A specialist is reactive: when a REQUEST addressed to its name lands on
    the bus, the runner kicks off the agent's ``handle`` on a worker thread.
    Replies publish back to the bus, where the dispatch tool is waiting.
    """

    def __init__(self, agent: Agent, team: "Team") -> None:
        self.agent = agent
        self.team = team
        self._sub_id: Optional[int] = None
        # Cap concurrent handlers per specialist. Avoids one specialist
        # being asked five things in parallel (which would interleave its
        # chat history). One-at-a-time keeps reasoning coherent.
        self._lock = threading.Lock()

    def start(self, bus: Bus) -> None:
        # Subscribe to REQUEST messages addressed to us.
        def on_msg(msg: Message) -> None:
            if msg.to_agent != self.agent.name:
                return
            if msg.kind != MessageKind.REQUEST:
                return
            # Run the agent on a worker so the bus publishing thread isn't
            # blocked by long-running tool calls.
            t = threading.Thread(
                target=self._run_one,
                args=(msg,),
                name=f"agent-{self.agent.name}",
                daemon=True,
            )
            t.start()

        self._sub_id = bus.subscribe(on_msg)

    def _run_one(self, inbox: Message) -> None:
        with self._lock:
            try:
                self.agent.handle(inbox)
            except Exception:  # noqa: BLE001
                logger.exception("specialist %s crashed handling %s", self.agent.name, inbox.id)


# ---------------------------------------------------------------------------
# Team
# ---------------------------------------------------------------------------


@dataclass
class Team:
    """A bound collection of agents sharing a bus and an approval gate."""

    bus: Bus
    gate: ApprovalGate
    orchestrator: Agent
    specialists: Dict[str, _SpecialistRunner]

    # Track the goal currently being driven by ``run_goal``. Set under lock
    # so the dispatch tool always sees a consistent value.
    active_goal_id: Optional[str] = None

    # Reply-waiter registry. Keyed by REQUEST.id; the dispatch tool inserts
    # an event + holder, and the orchestrator's own bus subscription fires
    # them when a matching REPLY publishes.
    _waiters_lock: threading.Lock = field(default_factory=threading.Lock, init=False)
    _waiters: Dict[str, "tuple[threading.Event, dict]"] = field(default_factory=dict, init=False)

    # ------------------------------------------------------------------
    # Reply waiter registry
    # ------------------------------------------------------------------

    def expect_reply(self, request_id: str):
        """Register interest in the reply to a given REQUEST message."""
        event = threading.Event()
        holder: dict = {"body": None}
        with self._waiters_lock:
            self._waiters[request_id] = (event, holder)
        return event, holder

    def discard_reply(self, request_id: str) -> None:
        with self._waiters_lock:
            self._waiters.pop(request_id, None)

    def _on_reply(self, msg: Message) -> None:
        if msg.kind != MessageKind.REPLY or msg.parent_id is None:
            return
        with self._waiters_lock:
            entry = self._waiters.pop(msg.parent_id, None)
        if entry is None:
            return
        event, holder = entry
        holder["body"] = msg.body
        event.set()

    # ------------------------------------------------------------------
    # Goal driver
    # ------------------------------------------------------------------

    def run_goal(
        self,
        user_request: str,
        attachments: Optional[List[Attachment]] = None,
        **goal_overrides,
    ) -> Message:
        """Submit a user request, wait for the orchestrator's final REPLY.

        Returns the orchestrator's REPLY message. Re-raises if the goal
        terminates without a reply (cancelled, budget exceeded).

        ``attachments`` carry audio + image media that arrived with the
        request (in-app chat, Telegram voice / photo, WhatsApp Cloud
        API audio / image). Audio is transcribed before the orchestrator
        sees the request so the model gets the spoken words inline. The
        raw paths and per-attachment metadata ride on the USER message's
        ``meta["attachments"]`` so vision-capable backends can pick up
        image bytes when that pass lands.
        """
        attachments = list(attachments or [])
        # Transcribe audio in-place so the augmented request below carries
        # the actual words rather than a stub. Image attachments are not
        # touched here — the backend layer decides how to surface them
        # (vision passthrough vs. text stub).
        if attachments:
            try:
                _transcribe_attachments(attachments)
            except Exception:
                logger.exception("transcription failed; continuing with empty transcripts")

        augmented_request = build_augmented_request(user_request, attachments)
        goal_text_for_record = augmented_request or (user_request or "")

        goal = self.bus.create_goal(Goal(user_request=goal_text_for_record, **goal_overrides))
        self.active_goal_id = goal.id

        try:
            inbox = self.bus.publish(
                Message(
                    from_agent="user",
                    to_agent=self.orchestrator.name,
                    kind=MessageKind.USER,
                    body=augmented_request or (user_request or ""),
                    goal_id=goal.id,
                    meta=attachments_to_meta(attachments) if attachments else {},
                )
            )
            reply = self.orchestrator.handle(inbox)
            if reply is None:
                final = self.bus.get_goal(goal.id)
                status = final.status.value if final else "unknown"
                raise RuntimeError(f"orchestrator returned no reply (goal status: {status})")
            self.bus.end_goal(goal.id, GoalStatus.DONE, summary=reply.body[:200])
            return reply
        finally:
            self.active_goal_id = None


# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------


def _augment_with_live_roster(
    base_prompt: str,
    roles: Mapping[str, Role],
    specialists: Dict[str, "_SpecialistRunner"],
    orchestrator_name: str,
) -> str:
    """Append the actual project team to the orchestrator's prompt.

    The base prompt (from ``orchestrator.yaml``) lists default specialists
    as if they always exist. Custom projects may have a different team —
    e.g. orchestrator + only a coder. This function appends an
    authoritative ROSTER block at the end of the prompt that names the
    real specialists, so the model dispatches only to existing ones.

    The block uses bold "AUTHORITATIVE" framing and explicitly tells the
    model to ignore any earlier hints about who's on the team — most LLMs
    weight later instructions slightly higher, and the explicit override
    seals it.
    """
    if not specialists:
        # Pure orchestrator with no team — tell it to do everything itself.
        suffix = (
            "\n\n=== ACTUAL TEAM (AUTHORITATIVE) ===\n"
            "There are NO specialists on this team. Do not call dispatch.\n"
            "Answer the user's request yourself using only the tools you have."
        )
        return base_prompt.rstrip() + suffix

    lines = [
        "",
        "=== ACTUAL TEAM (AUTHORITATIVE — ignore any other team list above) ===",
        "These are the ONLY specialists you can dispatch to. Do not invent",
        "or reference any other agent name.",
        "",
    ]
    for name in sorted(specialists.keys()):
        role = roles.get(name)
        if role is None:
            continue
        desc = role.description.strip() if role.description else "(no description)"
        lines.append(f"  - {name}: {desc}")
    lines.append("")
    lines.append(
        "If a task does not fit any specialist above, either:"
    )
    lines.append("  (a) do it yourself with your own tools, or")
    lines.append("  (b) reply explaining what's missing — do NOT dispatch to a")
    lines.append("      non-existent agent.")
    return base_prompt.rstrip() + "\n".join(lines)


def build_team(
    bus: Bus,
    *,
    roles: Mapping[str, Role],
    model_id_for: Callable[[str], str],
    model_fn: ModelFn,
    base_registry: Optional[ToolRegistry] = None,
    graph_resolver: Optional[Callable[[str], Optional[str]]] = None,
    cost_tracker: Optional[Any] = None,
) -> Team:
    """Wire up a Team from role definitions.

    ``model_id_for(role_name)`` lets the UI assign a different local model to
    each agent — that's the whole point of the "pinned to your dropdown"
    design. ``model_fn`` is shared (production: ``real_model_fn``, tests: a
    scripted fake).
    """
    registry = base_registry if base_registry is not None else builtin_registry()
    gate = registry.gate

    # Wire spawn_agent into the registry so every agent (orchestrator +
    # specialists) can fan out to ad-hoc sub-agents from the gallery.
    # Idempotent: skip if a previous build_team already registered it
    # (the same registry instance can be reused across teams in tests
    # and message bridges).
    from core.agents.spawn import make_spawn_agent_tool
    if "spawn_agent" not in registry.names():
        spawn_tool = make_spawn_agent_tool(
            model_fn=model_fn,
            base_registry=registry,
            bus=bus,
            cost_tracker=cost_tracker,
        )
        registry.register(spawn_tool)

    # Build specialists first (orchestrator needs the dict to wire dispatch).
    specialists: Dict[str, _SpecialistRunner] = {}
    orchestrator_role: Optional[Role] = None
    for role in roles.values():
        if role.can_dispatch:
            orchestrator_role = role
            continue
        # Add spawn_agent to every specialist's allowlist (if they have
        # one — None means "all tools" already). This is the whole point
        # of the slice: any agent can fan out, not just the orchestrator.
        allowlist = role.tool_allowlist
        if allowlist is not None and "spawn_agent" not in allowlist:
            allowlist = list(allowlist) + ["spawn_agent"]
        agent = Agent(
            name=role.name,
            role_prompt=role.system_prompt,
            model_id=model_id_for(role.name),
            bus=bus,
            tools=registry.for_allowlist(allowlist),
            model_fn=model_fn,
            cost_tracker=cost_tracker,
        )
        specialists[role.name] = _SpecialistRunner(agent, team=None)  # team back-ref set below

    if orchestrator_role is None:
        raise ValueError("no orchestrator role found (need can_dispatch: true)")

    # Build the orchestrator's tools: its allowlist + the dispatch tool
    # + spawn_agent (so it too can fan out beyond the standing roster).
    # We build a fresh registry that shares the gate so approvals route
    # to the same UI.
    orch_allowlist = orchestrator_role.tool_allowlist
    if orch_allowlist is not None and "spawn_agent" not in orch_allowlist:
        orch_allowlist = list(orch_allowlist) + ["spawn_agent"]
    orch_registry = registry.for_allowlist(orch_allowlist)

    # Stub Team for the dispatch closure to reference by attribute.
    team = Team(
        bus=bus,
        gate=gate,
        orchestrator=None,  # filled in below
        specialists=specialists,
    )
    for runner in specialists.values():
        runner.team = team

    dispatch_tool = _make_dispatch_tool(
        bus=bus,
        orchestrator_name=orchestrator_role.name,
        specialists=specialists,
        timeout_seconds=DEFAULT_DISPATCH_TIMEOUT_SECONDS,
        graph_resolver=graph_resolver,
    )
    orch_registry.register(dispatch_tool)

    # Inject the LIVE team roster into the orchestrator's prompt so it
    # only ever dispatches to specialists that actually exist on THIS
    # project. The YAML's static "your team is researcher/coder/..."
    # text is misleading whenever the user builds a custom team without
    # one of those names — without this override, the orchestrator
    # cheerfully calls dispatch(researcher, ...) and the call fails
    # because no such specialist is registered.
    orchestrator_prompt = _augment_with_live_roster(
        orchestrator_role.system_prompt,
        roles,
        specialists,
        orchestrator_role.name,
    )

    orchestrator = Agent(
        name=orchestrator_role.name,
        role_prompt=orchestrator_prompt,
        model_id=model_id_for(orchestrator_role.name),
        bus=bus,
        tools=orch_registry,
        model_fn=model_fn,
        cost_tracker=cost_tracker,
    )
    team.orchestrator = orchestrator

    # Wire subscriptions:
    #  - each specialist listens for REQUESTs addressed to it
    #  - the team listens for REPLYs to wake dispatch waiters
    for runner in specialists.values():
        runner.start(bus)
    bus.subscribe(team._on_reply, kinds=[MessageKind.REPLY])

    return team
