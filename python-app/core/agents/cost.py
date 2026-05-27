"""Cost tracking — what does a goal actually cost?

The agent loop calls into ``model_fn`` with no idea what each round
costs. For local models that's $0 and uninteresting; for the Anthropic
/ OpenAI / Codex backends every call is real money. This module
records (input_chars, output_chars) per (goal, agent, model) and rolls
them up to a dollar figure using a per-model pricing table.

Why characters, not tokens?
===========================

Token counting requires a model-specific tokenizer (tiktoken, the
Anthropic SDK, etc.) and at least one of those is rarely available
when running fully offline. We use the standard ~4 chars/token rule
of thumb: cheap, no dependency, and within ~15% of true counts on
English code/prose. When a backend reports actual token usage, the
caller can pass it through ``record_usage()`` instead and the rough
estimate is bypassed.

Threading
=========

A single :class:`CostTracker` is safe to share across all agent
worker threads — every mutation goes through ``self._lock``. The
recommended pattern is one tracker per :class:`Bus` instance, attached
in ``Bus.__init__`` (or stored on the team that owns the bus).
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Pricing
# ---------------------------------------------------------------------------


# USD per million tokens (input, output). Sourced from public price
# sheets; update as providers change. Unknown model ids are treated as
# free ($0/MTok) — that's the right default for local backends and
# safer than over-charging on a rename. Keys match the model_id strings
# our backends emit (case-insensitive lookup; see ``_lookup_pricing``).
#
# Pricing is approximate by design. We track *rough* spend so the user
# can spot a $5 goal vs a $5K goal — not for billing reconciliation.
PRICING_USD_PER_MTOK: Dict[str, Tuple[float, float]] = {
    # Anthropic — Claude 4 family
    "claude-opus-4-7": (15.00, 75.00),
    "claude-opus-4-6": (15.00, 75.00),
    "claude-opus-4-5": (15.00, 75.00),
    "claude-sonnet-4-6": (3.00, 15.00),
    "claude-sonnet-4-5": (3.00, 15.00),
    "claude-haiku-4-5": (1.00, 5.00),
    # Anthropic — Claude 3.x (legacy but still used)
    "claude-3-5-sonnet": (3.00, 15.00),
    "claude-3-5-haiku": (0.80, 4.00),
    "claude-3-opus": (15.00, 75.00),
    # OpenAI
    "gpt-4o": (2.50, 10.00),
    "gpt-4o-mini": (0.15, 0.60),
    "o1": (15.00, 60.00),
    "o1-mini": (3.00, 12.00),
    "gpt-5": (10.00, 30.00),
}


# Rough chars-to-tokens divisor. 4 is the common rule of thumb for
# English text; code averages closer to 3.5 and Asian languages closer
# to 2. Configurable per-tracker for callers that want to tune.
DEFAULT_CHARS_PER_TOKEN = 4.0


def _normalize_model_id(model_id: str) -> str:
    """Strip the OWLLM backend prefix and lower-case for pricing lookup.

    Backends emit composite ids like ``claude_cli|claude-sonnet-4-6``.
    The pricing table only knows the model name, so we split on ``|``
    and take the part after. Lower-cased so a stray capital doesn't
    miss the lookup.
    """
    if not model_id:
        return ""
    last = model_id.rsplit("|", 1)[-1].strip().lower()
    return last


def _lookup_pricing(model_id: str) -> Optional[Tuple[float, float]]:
    """Find (input, output) USD/MTok for a model id, or None for free.

    Tries exact match first, then prefix match (e.g. ``claude-opus-4-7-1m``
    matches ``claude-opus-4-7``). Returns None for anything unrecognized
    so local models stay free.
    """
    if not model_id:
        return None
    norm = _normalize_model_id(model_id)
    if norm in PRICING_USD_PER_MTOK:
        return PRICING_USD_PER_MTOK[norm]
    for known_id, price in PRICING_USD_PER_MTOK.items():
        if norm.startswith(known_id):
            return price
    return None


# ---------------------------------------------------------------------------
# Tracker
# ---------------------------------------------------------------------------


@dataclass
class CallRecord:
    """One model call's accounting line."""

    goal_id: str
    agent: str
    model_id: str
    input_tokens: int
    output_tokens: int
    cost_usd: float


@dataclass
class GoalSummary:
    """Roll-up for one goal."""

    goal_id: str
    total_usd: float = 0.0
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    calls: int = 0
    by_agent: Dict[str, float] = field(default_factory=dict)
    by_model: Dict[str, float] = field(default_factory=dict)


class CostTracker:
    """Records model-call cost per (goal, agent, model). Thread-safe."""

    def __init__(self, *, chars_per_token: float = DEFAULT_CHARS_PER_TOKEN) -> None:
        self._lock = threading.Lock()
        self._records: List[CallRecord] = []
        self._chars_per_token = max(1.0, float(chars_per_token))

    # ------------------------------------------------------------------
    # Recording
    # ------------------------------------------------------------------

    def record_chars(
        self,
        goal_id: str,
        agent: str,
        model_id: str,
        input_chars: int,
        output_chars: int,
    ) -> CallRecord:
        """Estimate tokens from char counts and record. Returns the record."""
        in_tok = max(0, int(input_chars / self._chars_per_token))
        out_tok = max(0, int(output_chars / self._chars_per_token))
        return self.record_usage(goal_id, agent, model_id, in_tok, out_tok)

    def record_usage(
        self,
        goal_id: str,
        agent: str,
        model_id: str,
        input_tokens: int,
        output_tokens: int,
    ) -> CallRecord:
        """Record exact token usage (preferred when the backend reports it)."""
        cost = self._cost_for(model_id, input_tokens, output_tokens)
        rec = CallRecord(
            goal_id=goal_id,
            agent=agent,
            model_id=model_id,
            input_tokens=int(input_tokens),
            output_tokens=int(output_tokens),
            cost_usd=cost,
        )
        with self._lock:
            self._records.append(rec)
        return rec

    @staticmethod
    def _cost_for(model_id: str, in_tokens: int, out_tokens: int) -> float:
        price = _lookup_pricing(model_id)
        if price is None:
            return 0.0
        in_price, out_price = price
        return (in_tokens / 1_000_000.0) * in_price + (out_tokens / 1_000_000.0) * out_price

    # ------------------------------------------------------------------
    # Read API
    # ------------------------------------------------------------------

    def summary_for_goal(self, goal_id: str) -> GoalSummary:
        with self._lock:
            recs = [r for r in self._records if r.goal_id == goal_id]
        s = GoalSummary(goal_id=goal_id)
        for r in recs:
            s.total_usd += r.cost_usd
            s.total_input_tokens += r.input_tokens
            s.total_output_tokens += r.output_tokens
            s.calls += 1
            s.by_agent[r.agent] = s.by_agent.get(r.agent, 0.0) + r.cost_usd
            s.by_model[r.model_id] = s.by_model.get(r.model_id, 0.0) + r.cost_usd
        return s

    def all_records(self) -> List[CallRecord]:
        """Defensive snapshot — useful for the UI / debugging."""
        with self._lock:
            return list(self._records)

    def reset(self) -> None:
        with self._lock:
            self._records.clear()

    # ------------------------------------------------------------------
    # Display
    # ------------------------------------------------------------------

    @staticmethod
    def format_usd(amount: float) -> str:
        """Compact dollar formatting for UI labels.

        < $0.01  -> "<$0.01" (visible badge for free/local goals so the
                    user knows tracking is on)
        < $1     -> "$0.034"
        otherwise-> "$3.41"
        """
        if amount <= 0:
            return "$0.00"
        if amount < 0.01:
            return "<$0.01"
        if amount < 1.0:
            return f"${amount:.3f}"
        return f"${amount:.2f}"


# ---------------------------------------------------------------------------
# model_fn wrapper
# ---------------------------------------------------------------------------


def wrap_model_fn(model_fn, tracker: CostTracker, *, agent: str, goal_id_provider):
    """Return a model_fn that records cost on every call.

    ``goal_id_provider`` is a callable returning the current goal_id —
    we don't capture it at wrap time because one wrapped fn can serve
    many sequential goals. The Agent uses ``lambda: self._current_goal_id``
    or similar.

    The wrapper is transparent: same signature, same return value.
    Errors in tracking are logged but never propagated — cost is best-
    effort, the model call is the source of truth.
    """
    def _wrapped(messages, model_id):
        # Sum input chars across the message list. We approximate
        # because the backend may template differently — close enough
        # for spend tracking.
        input_chars = 0
        try:
            for m in messages:
                content = m.get("content") if hasattr(m, "get") else None
                if content:
                    input_chars += len(content)
        except Exception:  # noqa: BLE001
            pass
        response = model_fn(messages, model_id)
        try:
            goal_id = goal_id_provider() or ""
            if goal_id:
                tracker.record_chars(
                    goal_id=goal_id,
                    agent=agent,
                    model_id=model_id,
                    input_chars=input_chars,
                    output_chars=len(response or ""),
                )
        except Exception:  # noqa: BLE001
            logger.exception("cost tracking failed for agent %s", agent)
        return response
    return _wrapped


# ---------------------------------------------------------------------------
# Module-level singleton (optional convenience)
# ---------------------------------------------------------------------------


_GLOBAL: Optional[CostTracker] = None
_GLOBAL_LOCK = threading.Lock()


def get_global_tracker() -> CostTracker:
    """Process-wide singleton. UIs that don't have a Team-scoped tracker
    handy can fall back to this. Tests that need isolation should pass
    their own CostTracker instance instead."""
    global _GLOBAL
    with _GLOBAL_LOCK:
        if _GLOBAL is None:
            _GLOBAL = CostTracker()
        return _GLOBAL


def reset_global_tracker() -> None:
    """For tests — wipes the singleton's records."""
    with _GLOBAL_LOCK:
        if _GLOBAL is not None:
            _GLOBAL.reset()
