"""Backend contract + dispatcher.

A backend is a small object with two methods:

* ``list_entries() -> List[ModelEntry]`` — enumerate models this backend can
  serve right now. Includes availability info so the UI can show greyed-out
  rows with a hint ("install claude CLI", "set ANTHROPIC_API_KEY").
* ``generate(messages, model_key) -> str`` — one-shot completion.

Every dropdown row carries a *composite id* of shape ``backend|model_key``.
``dispatch_model_fn`` parses that id, looks up the backend, and forwards the
call. The Agent class doesn't know any of this — it just gets a single
``ModelFn`` callable.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Callable, Dict, List, Mapping, Protocol

logger = logging.getLogger(__name__)


_SEP = "|"  # composite id separator. No backend uses this in its model keys.


# ---------------------------------------------------------------------------
# ModelEntry
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TestResult:
    """Outcome of a connectivity probe — for the Accounts subpage Test buttons."""

    ok: bool
    detail: str           # one-line summary shown next to the brand card
    elapsed_ms: int = 0


@dataclass(frozen=True)
class ModelEntry:
    """One row in the per-role model dropdown."""

    backend: str       # backend.name
    model_key: str     # backend-specific (model path / "claude-sonnet-4-6" / etc)
    display: str       # what shows in the combo
    available: bool    # if False, row is shown but non-selectable
    note: str = ""     # short reason — "(running)", "(set OPENAI_API_KEY)", ...
    cost_tier: str = "mid"
    """Coarse cost band — used by the auto-router. Values:

    * ``free``    — local models (no per-token cost)
    * ``cheap``   — Haiku, GPT-4o-mini class
    * ``mid``     — Sonnet, GPT-4o, GPT-5-mini class
    * ``premium`` — Opus, GPT-5, o3 class
    * ``unknown`` — default when a backend doesn't classify
    """

    @property
    def composite_id(self) -> str:
        return compose_id(self.backend, self.model_key)


# Numeric ranking so "cheapest" / "premium" can sort entries deterministically.
_COST_RANK = {"free": 0, "cheap": 1, "mid": 2, "premium": 3, "unknown": 99}


def _rank_for(entry: ModelEntry) -> int:
    return _COST_RANK.get(entry.cost_tier, 99)


# ---------------------------------------------------------------------------
# Backend protocol
# ---------------------------------------------------------------------------


# Mapping[str, Any] (not str-only) so messages can carry attachment
# metadata (e.g. image bytes for vision-capable backends) without
# changing the Backend.generate signature.
from typing import Any
ChatMessage = Mapping[str, Any]


class Backend(Protocol):
    """Plug-in shape every backend implementation conforms to."""

    name: str

    def list_entries(self) -> List[ModelEntry]: ...

    def generate(self, messages: List[ChatMessage], model_key: str) -> str: ...


def quick_test(backend_name: str) -> TestResult:
    """Run a minimal probe against a backend to verify auth + connectivity.

    Used by the Accounts subpage Test buttons. Each backend implements
    ``quick_test()``; if absent, this falls back to a tiny ``generate``
    call. We catch every exception so the UI gets a clean ``TestResult``
    instead of a stack trace.
    """
    import time
    backend = _registry.get(backend_name)
    if backend is None:
        return TestResult(False, f"unknown backend '{backend_name}'")

    started = time.time()
    try:
        # Prefer a backend-supplied test if present (cheaper / more accurate).
        if hasattr(backend, "quick_test"):
            res = backend.quick_test()
            elapsed = int((time.time() - started) * 1000)
            return TestResult(res.ok, res.detail, elapsed)
        # Fallback: generate a tiny response with the cheapest listed model.
        entries = backend.list_entries()
        cheap = next((e for e in entries if e.available), None)
        if cheap is None:
            return TestResult(False, "no available model for test")
        out = backend.generate(
            [{"role": "user", "content": "Reply with the single word: pong"}],
            cheap.model_key,
        )
        elapsed = int((time.time() - started) * 1000)
        ok = bool((out or "").strip())
        return TestResult(ok, "got reply" if ok else "empty response", elapsed)
    except Exception as exc:  # noqa: BLE001
        elapsed = int((time.time() - started) * 1000)
        return TestResult(False, str(exc).splitlines()[0][:200], elapsed)


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


_registry: Dict[str, Backend] = {}


def register_backend(backend: Backend) -> None:
    """Register a backend by ``backend.name``. Idempotent on re-import."""
    _registry[backend.name] = backend


def registered_backends() -> Dict[str, Backend]:
    return dict(_registry)


# ---------------------------------------------------------------------------
# Composite id helpers
# ---------------------------------------------------------------------------


def compose_id(backend: str, model_key: str) -> str:
    return f"{backend}{_SEP}{model_key}"


def parse_id(composite: str) -> tuple[str, str]:
    """``"backend|key"`` → ``("backend", "key")``. Raises ``ValueError`` on
    malformed input rather than guessing — the caller (the Agents UI) should
    surface that to the user instead of silently picking the wrong route."""
    if _SEP not in composite:
        raise ValueError(f"composite id missing '{_SEP}': {composite!r}")
    backend, _, key = composite.partition(_SEP)
    if not backend or not key:
        raise ValueError(f"composite id has empty side: {composite!r}")
    return backend, key


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def list_all_entries() -> List[ModelEntry]:
    """Enumerate entries from every registered backend.

    Order: backends in the order they registered, entries inside each backend
    in the order ``list_entries`` returned them. The first backend imported is
    ``local`` so onboarded models stay top of the list.
    """
    out: List[ModelEntry] = []
    for backend in _registry.values():
        try:
            out.extend(backend.list_entries())
        except Exception:  # noqa: BLE001
            logger.exception("backend %s failed to list entries", backend.name)
    return out


def dispatch_model_fn(messages: List[ChatMessage], composite_id: str) -> str:
    """``ModelFn`` that routes by composite id.

    This is what the Agents UI passes to ``build_team`` so the same loop can
    drive any mix of local / CLI / API backends per agent.

    Special case: the synthetic ``auto`` backend resolves to a real entry
    at call time based on a routing strategy (cheapest, cheapest-local,
    premium) — see ``_resolve_auto``.
    """
    backend_name, model_key = parse_id(composite_id)
    if backend_name == "auto":
        resolved = _resolve_auto(model_key)
        if resolved is None:
            raise RuntimeError(
                f"auto router could not find an available model for strategy '{model_key}'"
            )
        backend_name, model_key = parse_id(resolved)

    backend = _registry.get(backend_name)
    if backend is None:
        raise RuntimeError(f"unknown backend: {backend_name}. registered: {list(_registry)}")
    return backend.generate(list(messages), model_key)


# ---------------------------------------------------------------------------
# Auto router
# ---------------------------------------------------------------------------


# Routing strategies the auto-router supports. Composite ids that point at
# the auto backend look like ``auto|<strategy>``.
AUTO_STRATEGIES = {
    "cheapest":       "Pick the lowest-cost available model overall.",
    "cheapest_local": "Pick the lowest-cost LOCAL model (no API calls).",
    "premium":        "Pick the highest-tier available model (Opus / GPT-5 / o3).",
    "balanced":       "Pick a mid-tier model (Sonnet / GPT-5-mini / GPT-4o).",
}


def _resolve_auto(strategy: str) -> Optional[str]:
    """Pick a real ``backend|model_key`` for an ``auto|<strategy>`` request.

    Pulls fresh entries each call so the auto router reflects the current
    state — newly connected accounts and newly running local servers are
    picked up without a registry rebuild.
    """
    entries = [e for e in list_all_entries() if e.available]
    if not entries:
        return None

    if strategy == "cheapest":
        # Sort ascending by cost tier; ties broken by display name for
        # determinism.
        entries.sort(key=lambda e: (_rank_for(e), e.display.lower()))
        return entries[0].composite_id

    if strategy == "cheapest_local":
        local = [e for e in entries if e.backend == "local"]
        if not local:
            # Falls back to overall cheapest if no local available — better
            # than failing the run silently.
            return _resolve_auto("cheapest")
        local.sort(key=lambda e: (_rank_for(e), e.display.lower()))
        return local[0].composite_id

    if strategy == "premium":
        entries.sort(key=lambda e: (-_rank_for(e), e.display.lower()))
        return entries[0].composite_id

    if strategy == "balanced":
        # Prefer mid-tier; fall back to cheap, then premium.
        for tier in ("mid", "cheap", "premium", "unknown", "free"):
            tier_entries = [e for e in entries if e.cost_tier == tier]
            if tier_entries:
                tier_entries.sort(key=lambda e: e.display.lower())
                return tier_entries[0].composite_id
        return entries[0].composite_id

    return None


class _AutoBackend:
    """Synthetic backend exposing ``auto|<strategy>`` rows in dropdowns.

    Doesn't generate anything itself — ``dispatch_model_fn`` resolves the
    synthetic id to a real backend at call time. Lives in the registry so
    its rows appear in the model picker like any other backend's.
    """

    name = "auto"

    def list_entries(self) -> List[ModelEntry]:
        # The auto strategies are always "available" — they may resolve to
        # something that fails, but the strategy itself is selectable.
        return [
            ModelEntry(
                backend=self.name,
                model_key=key,
                display=f"⚡ Auto · {key.replace('_', ' ').title()}",
                available=True,
                note=desc,
                cost_tier="unknown",
            )
            for key, desc in AUTO_STRATEGIES.items()
        ]

    def generate(self, messages, model_key):  # noqa: D401
        # Should never be called directly — dispatch_model_fn resolves
        # auto|<strategy> to a real backend before calling generate. If it
        # ever ends up here, surface a clear error.
        raise RuntimeError(
            "AutoBackend.generate called directly — auto routes must go "
            "through dispatch_model_fn, not backend.generate"
        )


# ---------------------------------------------------------------------------
# Shared helpers for backends
# ---------------------------------------------------------------------------


def render_messages_as_prompt(messages: List[ChatMessage]) -> str:
    """Flatten chat history into a single prompt string.

    Used by every CLI/local backend that takes a one-shot prompt instead of a
    structured chat array. API backends bypass this — they use the structured
    form natively.
    """
    parts = []
    for m in messages:
        role = (m.get("role") or "user").upper()
        parts.append(f"<{role}>\n{m.get('content', '')}\n</{role}>")
    parts.append("<ASSISTANT>")
    return "\n".join(parts)
