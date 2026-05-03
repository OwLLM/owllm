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

__all__ = [
    "PipExecutor",
    "PipMode",
    "PipResult",
    "PipExecutorError",
    "PinResolver",
    "PinResolverError",
    "default_resolver",
]
