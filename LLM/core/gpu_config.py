import json
import logging
import subprocess
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


def get_chosen_gpu_index(app_root: Path, subprocess_flags: Optional[dict] = None) -> Optional[int]:
    """
    Canonical GPU selection for subprocesses.

    Source of truth: `LLM/desktop_app/config/gpu_config.json` written by the home page GPU selector.
    Returns the first GPU index in `selected_gpu_indices`.

    If the config is missing/invalid and GPUs exist, falls back to selecting the GPU with the highest
    total VRAM (best-effort via nvidia-smi). Returns None if no GPUs are detected or nvidia-smi is
    unavailable.
    """
    config_path = app_root / "desktop_app" / "config" / "gpu_config.json"
    if config_path.exists():
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            indices = cfg.get("selected_gpu_indices")
            if isinstance(indices, list) and indices:
                return int(indices[0])
        except (json.JSONDecodeError, ValueError, TypeError) as e:
            logger.debug("gpu_config.json invalid or missing selected_gpu_indices: %s", e)

    flags = subprocess_flags or {}
    try:
        r = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=5,
            **flags,
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

