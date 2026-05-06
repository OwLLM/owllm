"""Agent — the unit of execution in the OWLLM multi-agent runtime.

An ``Agent`` owns a name, a role (system prompt + tool allowlist), a model id,
and a reference to the bus. It runs a tool-use loop: receive an inbox message
→ ask the model what to do → parse + execute any tool calls it emitted →
publish results back to the bus → repeat until the model emits no more tool
calls (= it's done).

Key seams (for testability):

* ``ModelFn`` — a function ``(messages, model_id) -> str``. Production wires
  this to ``core.inference.run_inference``; tests inject a scripted fake.
* ``ToolRegistry`` — see ``tools/base.py``. The agent only sees its
  allowlisted view, so a Researcher can't shell out.
* ``Bus`` — every observable event flows through it. The agent never returns
  results directly; the orchestrator listens to the bus.

Budget enforcement happens at every loop iteration: before calling the model,
before calling each tool. If the goal flips out of RUNNING (cancelled, budget
exceeded, terminal status) the agent emits a final EVENT and exits cleanly.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, List, Mapping, Optional

from core.agents.bus import Bus
from core.agents.message import GoalStatus, Message, MessageKind
from core.agents.tools import (
    ToolRegistry,
    format_for_prompt,
    parse_tool_calls,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Model seam
# ---------------------------------------------------------------------------


# A "chat message" the agent sends to the model. We keep this dict-shaped
# (role/content) so production wiring to ``core.inference`` is a one-liner;
# tests don't need to import any model code.
# Mapping[str, Any] (not str-only) so a message dict can also carry an
# ``attachments`` list — image bytes are forwarded to vision-capable
# backends through this channel without changing model_fn's signature.
ChatMessage = Mapping[str, Any]

# A model function. Takes the rolling chat history + a model id, returns a
# raw text response. Streaming is intentionally not part of this contract —
# the agent loop publishes the *finished* response as a single bus event.
ModelFn = Callable[[List[ChatMessage], str], str]


# ---------------------------------------------------------------------------
# Limits
# ---------------------------------------------------------------------------


# Max tool-call iterations within ONE inbox message. Distinct from the goal
# budget (which is across the whole goal tree). Stops a single agent from
# spinning forever on an inbox item even if budgets aren't hit yet.
DEFAULT_MAX_STEPS = 12

# Chat-history budget. We measure characters, not tokens, because tokens
# differ per model and getting an exact count requires a tokenizer per
# backend. ~4 chars/token is a safe rule of thumb, so 60_000 chars caps
# at roughly 15K tokens — fits comfortably in Gemma-4's 32K window after
# accounting for system prompt + tool docs + new completion, AND in the
# 200K windows of Claude / GPT-5 with room to spare.
DEFAULT_MAX_HISTORY_CHARS = 60_000

# Per-message cap. A single tool result (a `cat large_file.json` run, an
# http_get of a 200KB page) can blow the budget by itself. We truncate
# to the tail since recent context typically matters more than the
# preamble on a long stdout dump.
DEFAULT_MAX_MESSAGE_CHARS = 12_000

# When chat history exceeds this fraction of ``max_history_chars``, we
# attempt to compact it via a summarization round-trip rather than just
# dropping the oldest messages. Tuned to fire well before the hard
# budget so the summary call itself has room to land. Set to 1.0 to
# disable compaction entirely (falls back to drop-oldest only).
DEFAULT_COMPACTION_THRESHOLD = 0.75

# How many of the most-recent messages to preserve verbatim during a
# compaction pass. Older messages get folded into a single summary
# message; the original user request (chat_history[0]) is also kept
# verbatim so the agent never loses sight of what it was asked to do.
DEFAULT_PRESERVE_RECENT = 6

# Marker the compaction summary uses so we can detect a previously-
# compacted message and skip re-summarizing it (would be lossy).
_COMPACTION_MARKER = "[CONVERSATION SUMMARY]"


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------


@dataclass
class Agent:
    """One named participant in the agent runtime.

    The same class powers specialists (Researcher, Coder, ...) and the
    Orchestrator — what makes Orchestrator special is its allowlist (it gets
    ``dispatch``) and its system prompt, not the loop itself.
    """

    name: str
    role_prompt: str
    model_id: str
    bus: Bus
    tools: ToolRegistry                  # already filtered to this agent's allowlist
    model_fn: ModelFn
    max_steps: int = DEFAULT_MAX_STEPS
    max_history_chars: int = DEFAULT_MAX_HISTORY_CHARS
    max_message_chars: int = DEFAULT_MAX_MESSAGE_CHARS
    cost_tracker: Optional[Any] = None
    """Optional :class:`core.agents.cost.CostTracker`. If set, every model
    call's input + output character counts are recorded against the
    current goal_id so the UI can surface a $ figure. Backends with real
    token usage should record_usage() directly; this loop estimates from
    chars (~4 chars/token rule of thumb)."""
    compaction_threshold: float = DEFAULT_COMPACTION_THRESHOLD
    """Fraction of ``max_history_chars`` at which to trigger a
    summarization round-trip. 1.0 disables compaction (falls back to
    drop-oldest)."""
    preserve_recent: int = DEFAULT_PRESERVE_RECENT
    """Number of most-recent messages kept verbatim during compaction."""

    # Per-instance scratch — the rolling chat memory across all inbox items.
    # We keep this on the agent (not the bus) because two agents on the same
    # goal need *separate* model contexts, even if they see the same events.
    _chat_history: List[ChatMessage] = field(default_factory=list, init=False)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def reset(self) -> None:
        """Drop chat history. Call between unrelated goals."""
        self._chat_history.clear()

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------

    def handle(self, inbox: Message) -> Optional[Message]:
        """Run the tool loop on one inbox message and return the final reply.

        Steps publish to the bus as they happen (THOUGHT, TOOL_CALL,
        TOOL_RESULT). The terminal REPLY is also published *and* returned so
        callers (orchestrator) can chain synchronously if they want.

        Returns None if the goal was cancelled / over budget mid-flight.
        """
        goal_id = inbox.goal_id
        if not self.bus.is_goal_active(goal_id):
            return None

        # Forward any IMAGE attachments riding on the inbox to vision-
        # capable backends. Audio is already inlined as transcript text
        # by the orchestrator, so we deliberately don't pass it again.
        user_msg: dict = {"role": "user", "content": self._format_inbox(inbox)}
        try:
            raw_attachments = (inbox.meta or {}).get("attachments") if isinstance(inbox.meta, Mapping) else None
        except Exception:
            raw_attachments = None
        image_attachments = [
            a for a in (raw_attachments or [])
            if isinstance(a, dict) and (a.get("kind") or "") == "image"
        ]
        if image_attachments:
            user_msg["attachments"] = image_attachments
        self._chat_history.append(user_msg)

        for step in range(self.max_steps):
            # Pre-step budget gate.
            if not self._budget_ok(goal_id):
                self._emit_event(goal_id, "budget_exceeded", parent=inbox.id)
                return None

            messages = self._build_messages()
            try:
                response = self.model_fn(messages, self.model_id)
            except Exception as exc:  # noqa: BLE001
                logger.exception("agent %s model call failed", self.name)
                self.bus.publish(
                    Message(
                        from_agent=self.name,
                        to_agent=inbox.from_agent,
                        kind=MessageKind.EVENT,
                        body=f"model error: {exc}",
                        goal_id=goal_id,
                        parent_id=inbox.id,
                        meta={"error": str(exc)},
                    )
                )
                return None

            # Cost accounting. Best-effort: a tracking failure must never
            # break the model call. Estimate input chars from the prompt
            # we just sent, output from the response.
            if self.cost_tracker is not None:
                try:
                    in_chars = sum(len(m.get("content") or "") for m in messages)
                    self.cost_tracker.record_chars(
                        goal_id=goal_id,
                        agent=self.name,
                        model_id=self.model_id,
                        input_chars=in_chars,
                        output_chars=len(response or ""),
                    )
                except Exception:  # noqa: BLE001
                    logger.exception("cost tracking failed for agent %s", self.name)

            self._chat_history.append({"role": "assistant", "content": response})

            calls = parse_tool_calls(response)
            if not calls:
                # No tool calls -> this is the final reply.
                reply = self.bus.publish(
                    Message(
                        from_agent=self.name,
                        to_agent=inbox.from_agent,
                        kind=MessageKind.REPLY,
                        body=response,
                        goal_id=goal_id,
                        parent_id=inbox.id,
                    )
                )
                return reply

            # Surface intermediate reasoning text (everything outside the
            # tool_call blocks) as a THOUGHT — this is what the 3D bubbles
            # render.
            thought_text = self._strip_tool_calls(response).strip()
            if thought_text:
                self.bus.publish(
                    Message(
                        from_agent=self.name,
                        to_agent=inbox.from_agent,
                        kind=MessageKind.THOUGHT,
                        body=thought_text,
                        goal_id=goal_id,
                        parent_id=inbox.id,
                    )
                )

            # Execute each tool call sequentially. Result text is fed back
            # to the model as a user-role message so it can decide the next
            # step.
            for call in calls:
                if not self._budget_ok(goal_id):
                    self._emit_event(goal_id, "budget_exceeded", parent=inbox.id)
                    return None

                self.bus.publish(
                    Message(
                        from_agent=self.name,
                        to_agent=inbox.from_agent,
                        kind=MessageKind.TOOL_CALL,
                        body=f"{call.name}({_short_args(call.args)})",
                        goal_id=goal_id,
                        parent_id=inbox.id,
                        meta={"tool": call.name, "args": dict(call.args), "call_id": call.id},
                    )
                )

                result = self.tools.invoke(call, agent=self.name, goal_id=goal_id)

                self.bus.publish(
                    Message(
                        from_agent=self.name,
                        to_agent=inbox.from_agent,
                        kind=MessageKind.TOOL_RESULT,
                        body=result.output,
                        goal_id=goal_id,
                        parent_id=inbox.id,
                        meta={
                            "tool": call.name,
                            "ok": result.ok,
                            "call_id": call.id,
                        },
                    )
                )

                self._chat_history.append(
                    {
                        "role": "user",
                        "content": (
                            f"<tool_result name=\"{call.name}\" "
                            f"ok=\"{str(result.ok).lower()}\">\n"
                            f"{result.output}\n"
                            f"</tool_result>"
                        ),
                    }
                )

        # Hit the per-message step limit without an explicit reply.
        self._emit_event(goal_id, "max_steps_reached", parent=inbox.id)
        return None

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _build_messages(self) -> List[ChatMessage]:
        """Render system prompt + chat history with budget enforcement.

        Three safety nets stack up here:

        1. Per-message cap — any single message whose content exceeds
           ``max_message_chars`` is truncated to the tail. Big tool results
           (a cat of a 200KB file, an http_get of a long page) used to
           blow past the per-call context limit on their own; we trim them
           in place so the rest of the conversation still fits.
        2. Compaction — if the post-cap total exceeds
           ``compaction_threshold`` of the budget, fold the older portion
           of the history into a single SUMMARY message (via the same
           model_fn) and keep the original user ask + the most recent
           ``preserve_recent`` messages verbatim. This preserves the
           original goal across long jobs that drop-oldest would lose.
        3. Drop-oldest fallback — if compaction couldn't bring us under
           budget (or it's disabled), drop oldest messages until we fit.
           The latest message is always preserved.

        Without these, a long-running goal blows the context window on
        Gemma-4 (32K tokens) and even on subscription Claude.
        """
        system = (
            self.role_prompt.rstrip()
            + "\n\n"
            + format_for_prompt(self.tools)
        )

        # 1. Per-message cap.
        capped: List[ChatMessage] = []
        for m in self._chat_history:
            content = m.get("content") or ""
            if len(content) > self.max_message_chars:
                content = (
                    content[-self.max_message_chars :]
                    + f"\n\n[…truncated, kept tail {self.max_message_chars} chars]"
                )
            entry: dict = {"role": m.get("role", "user"), "content": content}
            # Preserve any image-attachment payload — the per-message cap
            # only affects text content, never the bytes the backend layer
            # will inline as a vision content block.
            atts = m.get("attachments") if hasattr(m, "get") else None
            if atts:
                entry["attachments"] = atts
            capped.append(entry)

        budget = max(0, self.max_history_chars - len(system))

        # 2. Compaction — only fires when we're actually over the
        # configured threshold AND we have enough messages that
        # summarizing the older half is meaningful (else drop-oldest is
        # just as good and cheaper). threshold >= 1.0 disables it
        # entirely; threshold <= 0.0 would fire on every call which is
        # almost certainly a misconfiguration, so we treat that as
        # "disabled" too.
        compaction_enabled = 0.0 < self.compaction_threshold < 1.0
        threshold_chars = int(budget * self.compaction_threshold) if compaction_enabled else budget + 1
        total_chars = sum(len(c.get("content") or "") for c in capped)
        if (
            compaction_enabled
            and total_chars > threshold_chars
            and len(capped) > self.preserve_recent + 2
        ):
            try:
                capped = self._compact_history(capped)
                # Persist the compaction back to the agent's rolling
                # history so we don't redo it on every step.
                self._chat_history = list(capped)
                total_chars = sum(len(c.get("content") or "") for c in capped)
            except Exception:  # noqa: BLE001
                logger.exception("compaction failed for agent %s; falling back to drop-oldest", self.name)

        # 3. Drop-oldest fallback. If compaction succeeded we'll
        # usually fit; if it didn't or wasn't triggered, this still
        # keeps us under the per-call ceiling.
        while sum(len(c.get("content") or "") for c in capped) > budget and len(capped) > 1:
            capped.pop(0)

        return [{"role": "system", "content": system}, *capped]

    # ------------------------------------------------------------------
    # Compaction
    # ------------------------------------------------------------------

    def _compact_history(self, capped: List[ChatMessage]) -> List[ChatMessage]:
        """Summarize the older portion of ``capped`` via model_fn.

        Layout after compaction:

            [original user ask]                          (verbatim, msg 0)
            [SUMMARY of msg 1 .. -preserve_recent]       (synthetic)
            [last preserve_recent messages]              (verbatim)

        If the original ask is itself a previously-rendered summary
        (marker present), we don't double-wrap it. If preserve_recent
        is too large for the available history, we just no-op and let
        drop-oldest take over.
        """
        if len(capped) <= self.preserve_recent + 1:
            return capped

        original_ask = capped[0]
        recent = capped[-self.preserve_recent :]
        middle = capped[1 : len(capped) - self.preserve_recent]
        if not middle:
            return capped

        # Skip if the middle is already mostly a summary block (avoid
        # repeatedly re-summarizing the same content).
        already_compacted = any(
            _COMPACTION_MARKER in (m.get("content") or "") for m in middle
        )
        if already_compacted and len(middle) <= self.preserve_recent:
            return capped

        # Build a one-shot summarization prompt. Kept terse on purpose;
        # smaller models are fine at this with explicit framing.
        rendered_middle = "\n\n".join(
            f"[{m.get('role', 'user').upper()}]\n{m.get('content', '')}"
            for m in middle
        )
        summarization_prompt = [
            {
                "role": "system",
                "content": (
                    "You compress agent conversation history. Produce a "
                    "concise summary (max ~800 words) that preserves: "
                    "(1) decisions made, (2) files read or edited and any "
                    "key findings, (3) tools called and their salient "
                    "results, (4) outstanding TODOs or open questions. "
                    "Drop chit-chat. Use bullet points. Output ONLY the "
                    "summary body — no preamble."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Summarize the following conversation segment:\n\n"
                    f"{rendered_middle}"
                ),
            },
        ]

        try:
            summary_text = self.model_fn(summarization_prompt, self.model_id)
        except Exception:
            # Re-raise so the caller's blanket except logs + falls back
            # to drop-oldest. Compaction is best-effort.
            raise

        summary_msg: ChatMessage = {
            "role": "user",
            "content": (
                f"{_COMPACTION_MARKER}\n"
                f"({len(middle)} earlier messages collapsed by the "
                f"compaction layer to fit context budget.)\n\n"
                f"{(summary_text or '').strip() or '(empty summary)'}"
            ),
        }
        return [original_ask, summary_msg, *recent]

    def _format_inbox(self, msg: Message) -> str:
        # Surface enough metadata that the model knows who's talking.
        return (
            f"[from: {msg.from_agent}] [kind: {msg.kind.value}]\n"
            f"{msg.body}"
        )

    def _budget_ok(self, goal_id: str) -> bool:
        goal = self.bus.get_goal(goal_id)
        if goal is None or goal.status != GoalStatus.RUNNING:
            return False
        if self.bus.message_count(goal_id) >= goal.max_messages:
            self.bus.end_goal(goal_id, GoalStatus.BUDGET_EXCEEDED, "max_messages")
            return False
        if self.bus.tool_call_count(goal_id) >= goal.max_tool_calls:
            self.bus.end_goal(goal_id, GoalStatus.BUDGET_EXCEEDED, "max_tool_calls")
            return False
        # Wall-time check: cheaper than tracking start time per agent —
        # compare against the goal's created_at.
        created = _parse_iso(goal.created_at)
        if created is not None and (time.time() - created) > goal.wall_time_seconds:
            self.bus.end_goal(goal_id, GoalStatus.BUDGET_EXCEEDED, "wall_time")
            return False
        return True

    def _emit_event(self, goal_id: str, code: str, parent: Optional[str] = None) -> None:
        self.bus.publish(
            Message(
                from_agent=self.name,
                to_agent="*",
                kind=MessageKind.EVENT,
                body=code,
                goal_id=goal_id,
                parent_id=parent,
                meta={"code": code},
            )
        )

    @staticmethod
    def _strip_tool_calls(text: str) -> str:
        # Cheap: re-use the parser regex via a manual sub. We can't import
        # the compiled regex cleanly without leaking internals, so a simple
        # text find/replace pass is enough.
        from core.agents.tools.parser import _CALL_RE
        return _CALL_RE.sub("", text)


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------


def _short_args(args: Mapping[str, Any], limit: int = 80) -> str:
    """Render args as a single short line for the bus body."""
    parts = []
    for k, v in args.items():
        s = str(v)
        if len(s) > 30:
            s = s[:27] + "..."
        parts.append(f"{k}={s!r}")
    line = ", ".join(parts)
    if len(line) > limit:
        line = line[: limit - 3] + "..."
    return line


def _parse_iso(ts: str) -> Optional[float]:
    """Parse a UTC ISO timestamp produced by ``message._now_iso`` -> epoch.

    The naive trap: ``message._now_iso`` writes UTC, but Python's
    ``fromisoformat`` returns a naive datetime when there's no offset, and
    ``.timestamp()`` on a naive datetime assumes *local* time. We have to
    re-attach UTC explicitly or budgets misfire by hours.
    """
    from datetime import datetime, timezone
    try:
        clean = ts[:-1] if ts.endswith("Z") else ts
        return datetime.fromisoformat(clean).replace(tzinfo=timezone.utc).timestamp()
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Production model-fn wiring (lazy import to keep tests light)
# ---------------------------------------------------------------------------


def real_model_fn(messages: List[ChatMessage], model_id: str) -> str:
    """Production ``ModelFn`` — calls ``core.inference.run_inference``.

    Builds a single prompt by concatenating the chat history with role tags;
    most local model servers in OWLLM accept this shape. Agents that need
    structured chat-completions can swap this for a chat-API-aware variant
    later — the seam is per-Agent, not global.
    """
    from core.inference import InferenceConfig, run_inference

    parts = []
    for m in messages:
        role = m.get("role", "user").upper()
        parts.append(f"<{role}>\n{m.get('content', '')}\n</{role}>")
    parts.append("<ASSISTANT>")
    prompt = "\n".join(parts)

    cfg = InferenceConfig(
        prompt=prompt,
        model_id=model_id,
        max_new_tokens=1024,
        temperature=0.4,
    )
    return run_inference(cfg)
