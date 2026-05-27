"""OWLLM unified install/repair foundation.

This package is the single source of truth for "how do we install or
repair an OWLLM environment?" Every entry point in the app — Repair
All, Fix Issues, Repair Environment, training-env preflight, model-
onboarding step 10, server-side self-heal, safe-mode console — routes
through these three primitives:

    pin_resolver.PinResolver   - "what version of X for env Y?"
    pip_executor.PipExecutor   - "run pip and tell me what happened"
    env_repairer.EnvRepairer   - "make env Y match its declared deps"

Before this foundation existed, each of those entry points reimplemented
its own pip runner + its own version source + its own error capture +
its own verification. Symptoms: phantom version pins shipping unnoticed
(safetensors==0.7.0 didn't exist), repairs failing with empty error
strings (wheelhouse._download_wheel ate stderr), training packages
discovered missing only at training time, the same fix shipped seven
times without sticking.

Public API: import from this package, never the internals directly.

    from core.install import PipExecutor, PipMode, PipResult
    from core.install import PinResolver
    from core.install import EnvRepairer, RepairOutcome
"""
from __future__ import annotations

from core.install.pip_executor import (
    PipExecutor,
    PipMode,
    PipResult,
    PipExecutorError,
)
from core.install.pin_resolver import (
    PinResolver,
    PinResolverError,
    default_resolver,
)
from core.install.env_repairer import (
    EnvRepairer,
    RepairResult,
    RepairOutcome,
    PackageDiff,
    PackageStatus,
    TorchProbe,
    TORCH_ABI_FINGERPRINTS,
)


def resolve_profile_id(env_key: str, project_root=None) -> str:
    """Map an env_key (e.g. ``tf-cu121-t25-base-stable``) to a PinResolver profile id.

    The launcher / EnvSpec returns ``env_key`` (the layout id), while
    PinResolver and EnvRepairer want a ``profile_id`` (the hardware id,
    e.g. ``ampere_cu121``). They're related but not the same string.

    Strategy:
      1. If env_key is itself a known profile id, use it directly.
      2. Otherwise extract the cuXXX/cpu tag from env_key and pick the
         first profile whose torch_index targets that variant.
      3. Last resort: return env_key unchanged so the caller sees
         exactly what was tried in the resulting error.

    Single helper because at least four files need this same translation
    (safe_mode console + Qt window, home-page Fix Issues post-verify,
    onboarding, server preflight). Putting it here means the rule lives
    in ONE place.
    """
    from pathlib import Path as _Path
    if project_root is None:
        project_root = _Path(__file__).resolve().parents[2]
    try:
        resolver = PinResolver(project_root=_Path(project_root))
    except Exception:
        return env_key
    if env_key in resolver.profile_ids:
        return env_key
    # Pull the cu* tag out of the env_key.
    import re as _re
    m = _re.search(r"\b(cu\d+|cpu)\b", env_key)
    target = m.group(1) if m else None
    if target:
        for pid in resolver.profile_ids:
            try:
                idx = (resolver.torch_index_for(pid) or "").lower()
            except Exception:
                idx = ""
            if target in idx:
                return pid
    return env_key

__all__ = [
    "PipExecutor",
    "PipMode",
    "PipResult",
    "PipExecutorError",
    "PinResolver",
    "PinResolverError",
    "default_resolver",
    "EnvRepairer",
    "RepairResult",
    "RepairOutcome",
    "PackageDiff",
    "PackageStatus",
    "TorchProbe",
    "TORCH_ABI_FINGERPRINTS",
    "resolve_profile_id",
]
