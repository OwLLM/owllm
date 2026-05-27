"""LLM-driven profile selector — replaces the rule-based core/profile_selector.py.

See LLM/docs/supervisor/ARCHITECTURE.md "Replacement scope".

Strategy:
1. Probe hardware (hardware_probe.probe()).
2. Try the cold-start recipe table (bootstrap/recipes/hardware_profiles.json):
   if hardware matches a known happy-path profile, return it directly.
   Skips the model call for the 80% case.
3. Fallback: ask the brain for a profile given the full hardware spec.

This module is imported as a drop-in replacement once the supervisor is wired
up; the legacy rule-based selector stays in place until cutover.
"""
from __future__ import annotations

from typing import Any, Mapping, Optional


def select_profile(
    hardware: Optional[Mapping[str, Any]] = None,
    *,
    fallback_to_rules: bool = True,
) -> Mapping[str, Any]:
    """Return a profile dict (id + steps) suitable for the given hardware.

    If `fallback_to_rules` is True and the supervisor isn't available
    (e.g. llama-server not running), falls back to the legacy rule-based
    selector so the app still functions.
    """
    raise NotImplementedError("Skeleton — see LLM/docs/supervisor/ARCHITECTURE.md")
