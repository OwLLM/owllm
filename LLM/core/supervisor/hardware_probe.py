"""Cross-platform hardware probe for the supervisor.

Same schema as the Go bootstrap probe — see LLM/docs/supervisor/BOOTSTRAP.md.
This is the Python implementation used at runtime; bootstrap reimplements it
natively in Go to avoid the chicken-and-egg of needing Python to detect Python.

Output schema (see BOOTSTRAP.md "Hardware probe" section):

    { "os": {...}, "cpu": {...}, "ram_gb": int, "disk_free_gb": int,
      "gpu": [ {vendor, model, vram_gb, driver, cuda_runtime, compute_capability} ] }
"""
from __future__ import annotations

from typing import Any, Mapping


def probe() -> Mapping[str, Any]:
    """Build the hardware spec dict.

    Implementation will reuse logic already scattered across
    core/envs/capability_matrix.py and core/profile_selector.py — those files
    will become consumers of this probe rather than duplicating its logic.
    """
    raise NotImplementedError("Skeleton — see LLM/docs/supervisor/BOOTSTRAP.md")
