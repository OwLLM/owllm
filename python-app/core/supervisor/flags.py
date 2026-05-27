"""Feature flags for the OWLLM Supervisor.

Every flag defaults to False/safe. A user with no settings file in place
gets exactly today's behavior -- no surprise activation in production.

Storage: %LOCALAPPDATA%/OWLLM/feature_flags.json (Windows) or
~/.config/owllm/feature_flags.json (other). Missing file = all defaults.

Reading is cheap: the file is parsed once per call to `flag()` to keep
hot-reload working in dev (flip a flag, no app restart needed). For tight
loops, snapshot via `snapshot()` once and read from the dict.

This module has no dependencies on any other supervisor module so it can
be imported anywhere -- including by code that needs to check whether
even *importing* the supervisor is allowed.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Mapping

logger = logging.getLogger(__name__)


DEFAULTS: Mapping[str, Any] = {
    # Master switch. While False, the entire supervisor module is inert --
    # event subscriptions, model spawn, everything off. THIS IS THE PRODUCTION
    # DEFAULT and must not change without a deliberate release decision.
    "supervisor.enabled": False,

    # Observe + log only. While True, the supervisor never executes any
    # action; it merely records what it would have done so we can compare
    # against the existing rule-based path. Required precondition for
    # turning on any auto-apply flag.
    "supervisor.shadow_mode": True,

    # Per-failure-channel opt-ins. None of these do anything unless
    # supervisor.enabled is True AND supervisor.shadow_mode is False.
    "supervisor.runtime_failures": False,
    "supervisor.training_failures": False,
    "supervisor.dataset_failures": False,
    "supervisor.install_failures": False,

    # Auto-apply tier. While False, every supervisor action goes through
    # a UI confirmation toast.
    "supervisor.auto_apply_safe": False,

    # AI installer flavor. While False, OWLLM-Setup.exe runs the existing
    # Python-based installer unchanged. The new bootstrap.exe path only
    # ships through OWLLM-Setup-AI.exe (opt-in download) until this flips.
    "bootstrap.use_ai_installer": False,

    # Fleet tab. While False, the Fleet tab is hidden — production users
    # see no change. Independent product surface from the supervisor;
    # lives in this same flags file because the file IS OWLLM's feature-
    # flag mechanism (the module name is legacy). See core/fleet/.
    "fleet.enabled": False,
}


def _flags_path() -> Path:
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "OWLLM" / "feature_flags.json"
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "owllm" / "feature_flags.json"


_OVERRIDE_PATH: Path | None = None


def set_path_for_testing(path: Path | None) -> None:
    """Tests inject a temp file via this hook; production never calls it."""
    global _OVERRIDE_PATH
    _OVERRIDE_PATH = path


def _load() -> Mapping[str, Any]:
    path = _OVERRIDE_PATH if _OVERRIDE_PATH is not None else _flags_path()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("feature_flags read failed (%s): %s -- using defaults", path, e)
        return {}


def flag(name: str) -> Any:
    """Return the current value of a flag, or its default."""
    if name not in DEFAULTS:
        raise KeyError(f"unknown feature flag: {name}")
    file_value = _load().get(name)
    return DEFAULTS[name] if file_value is None else file_value


def snapshot() -> dict[str, Any]:
    """Return a dict with every known flag resolved. Safe for hot loops."""
    file_values = _load()
    return {k: file_values.get(k, default) for k, default in DEFAULTS.items()}


def supervisor_enabled() -> bool:
    """Convenience: master switch only."""
    return bool(flag("supervisor.enabled"))


def fleet_enabled() -> bool:
    """Convenience: True when the Fleet tab should be rendered."""
    return bool(flag("fleet.enabled"))


def supervisor_active(channel: str) -> bool:
    """True iff the supervisor is allowed to *act* on `channel` events.

    `channel` is one of: runtime, training, dataset, install.

    Returns False whenever the master switch is off, shadow mode is on,
    or the per-channel flag is off. Callers can use this as a single
    boolean gate before any state-mutating supervisor call.
    """
    if not supervisor_enabled():
        return False
    if flag("supervisor.shadow_mode"):
        return False
    return bool(flag(f"supervisor.{channel}_failures"))
