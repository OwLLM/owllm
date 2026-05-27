"""Shadow logger -- the supervisor's eyes-only mode.

While `supervisor.shadow_mode` is True (the default when the master switch
is on), every failure event is recorded but no action is taken. The existing
rule-based recovery paths (`self_heal_orchestrator.py`, `profile_selector.py`,
`capability_matrix.py`) run unchanged. This is how we collect real labeled
data on the supervisor's *would-be* decisions without risking a single user
install.

Design principles:

1. **Push, not subscribe.** The shadow logger does NOT subscribe to the
   agent bus -- it exposes a `observe(channel, trigger)` function that
   failure-handling code calls directly. This keeps the shadow path
   completely independent of bus subscription semantics, threading,
   and subscriber-callback contracts. A bug in shadow can never break
   bus delivery to anyone else.

2. **Always-safe degradation.** Every entry point swallows its own
   exceptions and logs them. Shadow mode must NEVER raise into the
   caller's failure-handling code; that would replace one bug with two.

3. **Disk-only sink.** Writes to `~/.owllm/shadow_log.jsonl` (or
   `%LOCALAPPDATA%/OWLLM/shadow_log.jsonl` on Windows). No network,
   no telemetry, no third party. Users own their data. An opt-in
   uploader can be added later -- separate module, separate flag.

4. **Best-effort comparison.** When the existing rule-based path emits
   its own decision into the same trigger context, we capture both so
   later analysis can compute supervisor-vs-rules agreement rate.

Usage from a failure handler (example pattern -- not yet wired):

    from core.supervisor import flags, shadow

    try:
        run_training(...)
    except CudaOOMError as e:
        rules_decision = legacy_rule_response(e)         # existing behavior
        if flags.supervisor_enabled():
            shadow.observe(
                channel="training",
                trigger={"kind": "gpu_oom", "vram_gb": 24, ...},
                rules_decision=rules_decision,
            )
        # rules path continues to drive behavior in shadow mode
        apply(rules_decision)
"""
from __future__ import annotations

import json
import logging
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from core.supervisor import flags

logger = logging.getLogger(__name__)


_VALID_CHANNELS = frozenset({"runtime", "training", "dataset", "install", "mcp"})

_write_lock = threading.Lock()
_log_path_override: Path | None = None


def set_log_path_for_testing(path: Path | None) -> None:
    """Tests inject a temp path here; production never calls this."""
    global _log_path_override
    _log_path_override = path


def log_path() -> Path:
    if _log_path_override is not None:
        return _log_path_override
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "OWLLM" / "shadow_log.jsonl"
    base = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
    return Path(base) / "owllm" / "shadow_log.jsonl"


def observe(
    channel: str,
    trigger: Mapping[str, Any],
    *,
    rules_decision: Mapping[str, Any] | None = None,
    extra: Mapping[str, Any] | None = None,
) -> None:
    """Record one failure event to the shadow log.

    Never raises. Returns silently in any of these cases:
      - master switch off (supervisor.enabled is False)
      - shadow mode itself off (supervisor.shadow_mode is False -- the
        supervisor is in active mode, the shadow logger is a no-op)
      - unknown channel (logged as a warning, then ignored)
      - disk write failure (logged, then ignored)

    Args:
        channel: one of runtime, training, dataset, install, mcp.
        trigger: structured failure payload. See LLM/docs/supervisor/EVENTS.md
                 for the per-channel schema. NOT validated here -- shadow's
                 job is to record what was sent, not gatekeep schema.
        rules_decision: optional. What the existing rule-based path decided
                        for this same trigger. Used for offline agreement
                        analysis. Pass None when no comparable rule exists.
        extra: optional caller-side context (process id, run id, ...).
    """
    try:
        if not flags.supervisor_enabled():
            return
        if not flags.flag("supervisor.shadow_mode"):
            return
        if channel not in _VALID_CHANNELS:
            logger.warning("shadow.observe: unknown channel %r -- skipping", channel)
            return

        record = {
            "ts": _utc_now_iso(),
            "channel": channel,
            "trigger": dict(trigger),
            "rules_decision": dict(rules_decision) if rules_decision else None,
            "supervisor_decision": None,  # filled in by future stage-2 wiring
            "extra": dict(extra) if extra else None,
        }
        _append(record)
    except Exception:
        logger.exception("shadow.observe failed -- swallowed to protect caller")


def _append(record: Mapping[str, Any]) -> None:
    path = log_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, ensure_ascii=False)
    with _write_lock, path.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def read_all() -> list[Mapping[str, Any]]:
    """Read the full shadow log. Intended for the supervisor page UI and
    for the corpus pipeline (so shadow logs can graduate into training data).
    Returns [] if the log doesn't exist yet."""
    path = log_path()
    if not path.exists():
        return []
    out: list[Mapping[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out
