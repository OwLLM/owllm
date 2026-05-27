"""Supervisor tool dispatcher — executes the actions the model emits.

Full action catalog: LLM/docs/supervisor/TOOLS.md

Skeleton only. Wire-up plan:
- Each tool is a function (args: dict) -> ToolResult.
- TRUST_TIER maps action name → "safe" | "confirm" | "danger".
- Executor.run(plan) consults trust tier, optionally surfaces a UI confirmation,
  then dispatches.
- On failure it feeds stderr back to brain.diagnose() with the trigger
  augmented by recent_actions, bounded retry max 5.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Mapping


@dataclass(frozen=True)
class ToolResult:
    ok: bool
    exit_code: int = 0
    stdout: str = ""
    stderr: str = ""
    elapsed_ms: int = 0
    side_effects: list[Mapping[str, Any]] = field(default_factory=list)


# Trust tiers: see TOOLS.md. Anything not listed defaults to "danger".
TRUST_TIER: Mapping[str, str] = {
    # safe — execute autonomously
    "install_pkg": "safe",
    "download_file": "safe",
    "install_local_wheel": "safe",
    "create_venv": "safe",
    "pick_profile": "safe",
    "repair_runtime_bundle": "safe",
    "rerun_model_probe": "safe",
    "clear_pip_cache": "safe",
    "validate_dataset": "safe",
    "inspect_sample": "safe",
    "read_log": "safe",
    "probe_hardware": "safe",
    "pip_show": "safe",
    "python_version": "safe",
    "abort": "safe",
    "ask_user": "safe",
    # confirm — UI toast required
    "swap_wheel": "confirm",
    "uninstall_pkg": "confirm",
    "set_env": "confirm",
    "normalize_dataset": "confirm",
    # danger — only with advanced mode toggle
    "run_shell": "danger",
}


ToolFn = Callable[[Mapping[str, Any]], ToolResult]
REGISTRY: dict[str, ToolFn] = {}


def register(name: str) -> Callable[[ToolFn], ToolFn]:
    def deco(fn: ToolFn) -> ToolFn:
        REGISTRY[name] = fn
        return fn
    return deco


# All tool implementations live in tools_impl/ (TBD) — they wrap existing
# OWLLM primitives like core/runtime/runtime_bundle_manager.py and
# core/pip_worker.py rather than reimplementing them.
