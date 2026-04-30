import json
import logging
import os
import subprocess
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


def _query_index_uuid_pairs(subprocess_flags: Optional[dict] = None) -> list[tuple[int, str]]:
    """Return [(nvidia_smi_index, uuid), ...] in PCI_BUS_ID order, or [] on failure."""
    flags = subprocess_flags or {}
    env = dict(os.environ)
    env["CUDA_DEVICE_ORDER"] = "PCI_BUS_ID"
    try:
        r = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,uuid", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=5, env=env, **flags,
        )
        if r.returncode != 0 or not r.stdout.strip():
            return []
        out: list[tuple[int, str]] = []
        for line in r.stdout.strip().splitlines():
            parts = [p.strip().strip('"') for p in line.split(",")]
            if len(parts) >= 2:
                try:
                    out.append((int(parts[0]), parts[1]))
                except ValueError:
                    continue
        return out
    except Exception as e:
        logger.debug("nvidia-smi index/uuid query failed: %s", e)
        return []


def get_chosen_gpu_index(app_root: Path, subprocess_flags: Optional[dict] = None) -> Optional[int]:
    """
    Canonical GPU selection for subprocesses.

    Source of truth: `LLM/desktop_app/config/gpu_config.json` written by the home page GPU selector.

    Resolution order:
      1. `selected_gpu_uuids[0]` (preferred, stable across driver/BIOS reorderings) →
         resolved to its current nvidia-smi index.
      2. `selected_gpu_indices[0]` (legacy positional fallback).
      3. Highest-VRAM GPU via nvidia-smi.

    Returns None if no GPUs are detected or nvidia-smi is unavailable.
    """
    config_path = app_root / "desktop_app" / "config" / "gpu_config.json"
    cfg: dict = {}
    if config_path.exists():
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                cfg = json.load(f) or {}
        except (json.JSONDecodeError, ValueError, TypeError) as e:
            logger.debug("gpu_config.json invalid: %s", e)
            cfg = {}

    uuids = cfg.get("selected_gpu_uuids")
    if isinstance(uuids, list) and uuids:
        wanted = str(uuids[0]).strip()
        pairs = _query_index_uuid_pairs(subprocess_flags)
        for idx, uuid in pairs:
            if uuid == wanted:
                return idx
        logger.warning(
            "selected_gpu_uuid %s not found in current nvidia-smi enumeration "
            "(present UUIDs: %s); falling back to selected_gpu_indices.",
            wanted, [u for _, u in pairs],
        )

    indices = cfg.get("selected_gpu_indices")
    if isinstance(indices, list) and indices:
        try:
            return int(indices[0])
        except (ValueError, TypeError):
            pass

    flags = subprocess_flags or {}
    env = dict(os.environ)
    env["CUDA_DEVICE_ORDER"] = "PCI_BUS_ID"
    try:
        r = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5, env=env, **flags,
        )
        if r.returncode != 0 or not r.stdout.strip():
            return None
        lines = [x.strip() for x in r.stdout.strip().split("\n") if x.strip()]
        if not lines:
            return None
        best_idx = 0
        best_total_mb = 0.0
        for i, line in enumerate(lines):
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 2:
                try:
                    total_mb = float(parts[1])
                    if total_mb > best_total_mb:
                        best_total_mb = total_mb
                        best_idx = i
                except ValueError:
                    pass
        return best_idx
    except Exception as e:
        logger.debug("Could not query GPUs for fallback index: %s", e)
        return None
