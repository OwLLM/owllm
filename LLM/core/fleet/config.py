"""Shared defaults for fleet state locations and pool budgets.

The CLI and any in-app UI both need to find the same SQLite manifest
and the same workspace root, otherwise they show inconsistent state.
This module is the single source of truth.

Override hierarchy (highest wins):
1. Explicit kwarg / arg passed by the caller
2. Environment variable (``OWLLM_FLEET_DB``, ``OWLLM_FLEET_ROOT``)
3. Default under ``~/.owllm/fleet/``
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from core.fleet.broker import PoolConfig

DEFAULT_PORT_LOW = 8081
DEFAULT_PORT_HIGH = 8181  # exclusive


def fleet_root(override: Optional[str] = None) -> Path:
    if override:
        return Path(override)
    env = os.environ.get("OWLLM_FLEET_ROOT")
    if env:
        return Path(env)
    return Path.home() / ".owllm" / "fleet"


def default_db(override: Optional[str] = None) -> Path:
    if override:
        return Path(override)
    env = os.environ.get("OWLLM_FLEET_DB")
    if env:
        return Path(env)
    return fleet_root() / "manifest.sqlite"


def default_workspaces(override: Optional[str] = None) -> Path:
    if override:
        return Path(override)
    return fleet_root() / "workspaces"


def default_process_index(override: Optional[str] = None) -> Path:
    """Where the persistent ProcessRegistry stores ``<agent_id>.json``
    records. Central rather than per-workspace so any fleet client
    can discover every running agent in one glob."""
    if override:
        return Path(override)
    return fleet_root() / ".process"


def default_audit_log(override: Optional[str] = None) -> Path:
    """JSONL audit log of fleet actions."""
    if override:
        return Path(override)
    return fleet_root() / "audit.log.jsonl"


def default_outputs_db(override: Optional[str] = None) -> Path:
    """SQLite-backed registry of agent-published artifacts."""
    if override:
        return Path(override)
    return fleet_root() / "outputs" / "registry.sqlite"


def default_pool(
    *,
    workspace_root: Optional[str] = None,
    port_low: int = DEFAULT_PORT_LOW,
    port_high: int = DEFAULT_PORT_HIGH,
    gpu_slots: tuple[int, ...] = (),
) -> PoolConfig:
    return PoolConfig(
        workspace_root=default_workspaces(workspace_root),
        port_range=range(port_low, port_high),
        gpu_slots=gpu_slots,
    )
