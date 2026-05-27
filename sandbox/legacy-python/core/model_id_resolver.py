"""
Canonical model identity resolver.

Single source of truth for normalizing model IDs across config keys (YAML),
onboarding (StateStore), and runtime. Use these functions instead of ad-hoc
string derivation to prevent identity drift and regressions.

Conventions:
- Canonical ID: HF-style "org/repo" when derivable from path; otherwise the
  config key (e.g. model_123, adapter_...) as-is.
- Config key: key used in llm_backends.yaml ["models"] (often filesystem-safe).
- Onboarding is keyed by canonical ID when possible for consistency.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional, Dict, Any, Callable


def derive_from_model_path(base_model_path: str) -> Optional[str]:
    """
    Derive a canonical HF-style model ID from a model directory path.

    - Folder name "org__repo" -> "org/repo"
    - Folder name "org_repo" (single underscore) -> "org/repo"
    - Otherwise returns None (caller keeps original id).

    Args:
        base_model_path: Path to model directory (or its string form).

    Returns:
        Canonical "org/repo" string, or None if not derivable.
    """
    if not base_model_path or not isinstance(base_model_path, str):
        return None
    base_model_path = base_model_path.strip()
    if not base_model_path:
        return None
    try:
        name = Path(base_model_path).name
    except Exception:
        name = base_model_path
    if "__" in name:
        derived = name.replace("__", "/")
        if "/" in derived:
            return derived
    if "/" not in name and "_" in name:
        parts = name.split("_", 1)
        if len(parts) == 2 and parts[0] and parts[1]:
            return f"{parts[0]}/{parts[1]}"
    return None


def to_canonical_id(
    model_id_or_key: str,
    model_cfg: Optional[Dict[str, Any]] = None,
    base_model_path: Optional[str] = None,
) -> str:
    """
    Resolve to a single canonical model ID for onboarding/StateStore lookups.

    - If model_id_or_key already contains "/", treat as HF id and return as-is.
    - Else derive from base_model_path or model_cfg["base_model"] when available.
    - Fallback: return model_id_or_key unchanged (e.g. model_123, adapter_...).

    Args:
        model_id_or_key: Config key or any model identifier.
        model_cfg: Optional dict with "base_model" key.
        base_model_path: Optional explicit base model path.

    Returns:
        Canonical ID string (HF-style when derivable, else original).
    """
    if not model_id_or_key or not isinstance(model_id_or_key, str):
        return model_id_or_key or ""
    model_id_or_key = model_id_or_key.strip()
    if "/" in model_id_or_key:
        return model_id_or_key

    path = base_model_path
    if not path and isinstance(model_cfg, dict):
        path = (model_cfg.get("base_model") or "") or ""
    if path:
        path = str(path).strip()
    if path:
        derived = derive_from_model_path(path)
        if derived:
            return derived
    return model_id_or_key


def resolve_config_key(
    model_id_or_path: str,
    config: Optional[Dict[str, Any]] = None,
) -> Optional[str]:
    """
    Resolve to the config key used in llm_backends.yaml ["models"].

    - If config is None, returns model_id_or_path (assume it is already the key).
    - If model_id_or_path is already a key in config["models"], return it.
    - Else treat as path: normalize and find a model whose base_model matches.
      Returns the first matching config key, or None.

    Args:
        model_id_or_path: Model ID or path to model directory.
        config: Optional loaded config dict with "models" key.

    Returns:
        Config key string, or None if not found.
    """
    if not model_id_or_path or not isinstance(model_id_or_path, str):
        return None
    model_id_or_path = model_id_or_path.strip()
    if not config or not isinstance(config.get("models"), dict):
        return model_id_or_path

    models = config["models"]
    if model_id_or_path in models:
        return model_id_or_path

    try:
        path_resolved = Path(model_id_or_path).resolve()
        path_str = str(path_resolved).lower()
    except Exception:
        return None

    for mid, cfg in models.items():
        base = (cfg or {}).get("base_model")
        if not base:
            continue
        try:
            if str(Path(base).resolve()).lower() == path_str:
                return mid
        except Exception:
            continue
    return None


def resolve_onboarding_identity(
    model_id_or_key: str,
    model_cfg: Optional[Dict[str, Any]],
    get_status: Callable[[str], Optional[str]],
    strict: bool = True,
) -> Dict[str, Any]:
    """
    Resolve runtime onboarding identity deterministically.

    Returns both candidate statuses and the selected onboarding key.
    When strict=True and both ids exist with conflicting non-READY statuses,
    raises RuntimeError instead of silently drifting between aliases.
    """
    cfg_id = (model_id_or_key or "").strip()
    canonical_id = to_canonical_id(cfg_id, model_cfg=model_cfg, base_model_path=None)

    cfg_status = get_status(cfg_id) if cfg_id else None
    canonical_status = get_status(canonical_id) if canonical_id else None

    # Prefer canonical when explicitly READY.
    if canonical_id and canonical_status == "READY":
        onboarding_id = canonical_id
        status = canonical_status
    elif cfg_status == "READY":
        onboarding_id = cfg_id
        status = cfg_status
    elif canonical_id and canonical_status is not None:
        onboarding_id = canonical_id
        status = canonical_status
    else:
        onboarding_id = cfg_id
        status = cfg_status

    if strict and canonical_id and canonical_id != cfg_id:
        if cfg_status is not None and canonical_status is not None and cfg_status != canonical_status:
            raise RuntimeError(
                "Model identity drift detected between config key and canonical id: "
                f"config_key='{cfg_id}' (status={cfg_status}) vs canonical_id='{canonical_id}' "
                f"(status={canonical_status}). Please consolidate onboarding state."
            )

    return {
        "config_id": cfg_id,
        "canonical_id": canonical_id,
        "config_status": cfg_status,
        "canonical_status": canonical_status,
        "onboarding_id": onboarding_id,
        "status": status,
    }
