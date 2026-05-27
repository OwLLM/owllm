"""Training-env preflight — thin adapter over the unified install foundation.

This module used to be 350+ lines of L1/L2/L2.5/L3 self-healing logic
with its own pip runner, its own torch+CUDA probe, its own
``REQUIRED_TRAINING_PACKAGES`` tuple. Every change touched it
independently of the other repair surfaces and the same fixes had to
be ported over and over.

Now: this file is a thin shim over ``core.install.EnvRepairer``. The
training-package list lives in ``LLM/profiles/extras/training.json``,
the pip runner is ``core.install.PipExecutor``, the version source is
``core.install.PinResolver``. One bug fix in EnvRepairer benefits
this path AND all the other repair entry points.

Public surface (preserved for callers, don't change without grep):

  ``status(llm_root)``                 -> TrainingEnvStatus
  ``ensure_ready(llm_root, progress)`` -> TrainingEnvStatus
  ``non_gguf_variant(model_name)``     -> str
  ``TrainingEnvStatus`` (dataclass with .fully_ready, .missing_packages, ...)
  ``TrainingEnvBootstrapError`` (exception)
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, List, Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Public dataclasses / exceptions (kept for back-compat with callers)
# ---------------------------------------------------------------------------


@dataclass
class TrainingEnvStatus:
    """Summary of the training venv state.

    Same shape callers always saw — kept as a dataclass with
    ``fully_ready`` and ``missing_packages`` so the home-page repair
    flow and the Train tab preflight don't need to learn new types.
    """

    venv_python_exists: bool
    venv_python_path: str
    missing_packages: List[str] = field(default_factory=list)

    @property
    def fully_ready(self) -> bool:
        return self.venv_python_exists and not self.missing_packages


class TrainingEnvBootstrapError(RuntimeError):
    """Raised when EnvRepairer can't get the training venv healthy.

    Same exception type callers always caught. Today it's only raised
    from ``ensure_ready`` after the unified repair has exhausted its
    own remediations and the env is still missing required packages.
    """


# ---------------------------------------------------------------------------
# Internals: env resolution
# ---------------------------------------------------------------------------


def _venv_python_path(llm_root: Path) -> Path:
    """Where the training venv's interpreter lives.

    Single source of truth: ``core.runtime.owllm_python.get_owllm_env``
    (the resolver that the launcher and the model server both use).
    Falls back to the legacy ``LLM/.venv`` layout so the warning
    message points at SOMETHING when no env is configured.
    """
    try:
        from core.runtime.owllm_python import get_owllm_env
        env = get_owllm_env(llm_root)
        return env.python_exe
    except Exception:
        logger.debug("training_env_manager: get_owllm_env failed, using legacy .venv path", exc_info=True)
        return llm_root / ".venv" / "Scripts" / "python.exe"


def _resolve_env_id(llm_root: Path) -> Optional[str]:
    """Return the active profile id (e.g. ``ampere_cu121``) or None.

    Translates ``env_key`` (the layout id e.g. ``tf-cu121-t25-base-stable``)
    into a PinResolver profile id. Uses the shared
    ``core.install.resolve_profile_id`` helper so the rule lives in one
    place.
    """
    try:
        from core.runtime.owllm_python import get_owllm_env
        from core.install import resolve_profile_id
        env = get_owllm_env(llm_root)
        return resolve_profile_id(env.env_key, project_root=llm_root)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


ProgressFn = Callable[[str], None]


def status(llm_root: Path) -> TrainingEnvStatus:
    """Probe the training venv. Cheap (one freeze + one probe).

    Returns a ``TrainingEnvStatus``; the ``missing_packages`` list is
    derived from EnvRepairer's diff so it always matches what
    ``ensure_ready`` would actually install.
    """
    py = _venv_python_path(llm_root)
    if not py.exists():
        # No interpreter at all — every required package is "missing"
        # by definition. Use the training extras file as the truth.
        try:
            from core.install import default_resolver
            resolver = default_resolver(llm_root)
            extras = list(resolver.required_for_extras_only("training")) if hasattr(resolver, "required_for_extras_only") else ["unsloth", "trl", "peft", "bitsandbytes"]
        except Exception:
            extras = ["unsloth", "trl", "peft", "bitsandbytes"]
        return TrainingEnvStatus(
            venv_python_exists=False,
            venv_python_path=str(py),
            missing_packages=extras,
        )

    env_id = _resolve_env_id(llm_root)
    if not env_id:
        # Profile unknown — can't diff against required. Fall back to
        # the import-name probe used by the legacy implementation.
        return _legacy_status_fallback(py)

    try:
        from core.install import EnvRepairer, PackageStatus
        repairer = EnvRepairer(project_root=llm_root)
        # required_for + freeze: cheaper than a full probe, doesn't
        # touch torch DLLs (which is what we want from a "status" call).
        try:
            installed = repairer.pip.freeze(env_python=py)
        except Exception as exc:
            logger.debug("training_env_manager.status: pip freeze failed: %s", exc)
            return _legacy_status_fallback(py)
        required = repairer.resolver.required_for(env_id, extras=["training"])
        # Only flag training-extras as missing — the base profile
        # packages are tracked by the main repair surfaces.
        try:
            extras_required = repairer.resolver.required_for("__extras__", extras=["training"])
        except Exception:
            extras_required = {}
        if not extras_required:
            # PinResolver doesn't expose extras-only directly; derive by
            # diff: anything in 'required with extras' that ISN'T in
            # 'required without extras' is an extras-only package.
            base = repairer.resolver.required_for(env_id)
            extras_required = {k: v for k, v in required.items() if k not in base}
        diff = repairer._compute_diff(extras_required, installed)
        missing = [
            d.name for d in diff
            if d.status in (PackageStatus.MISSING, PackageStatus.WRONG_VERSION)
        ]
        return TrainingEnvStatus(
            venv_python_exists=True,
            venv_python_path=str(py),
            missing_packages=missing,
        )
    except Exception as exc:
        logger.warning("training_env_manager.status: EnvRepairer-based probe failed: %s", exc)
        return _legacy_status_fallback(py)


def ensure_ready(
    llm_root: Path,
    progress: Optional[ProgressFn] = None,
) -> TrainingEnvStatus:
    """Self-install whatever's missing in the training venv.

    Now a single ``EnvRepairer.repair(env_python, env_id, extras=
    ["training"])`` call. The L1/L2/L2.5/L3 ladder, the torch-CUDA
    pre-flight reinstall, the structured per-package error reporting —
    all centralised in EnvRepairer. Anything new (e.g. a future torch
    minor-version compatibility shim) lands in ONE place and benefits
    every repair surface.
    """
    p = progress or (lambda _msg: None)
    py = _venv_python_path(llm_root)

    if not py.exists():
        raise TrainingEnvBootstrapError(
            f"Training venv interpreter not found at:\n  {py}\n\n"
            "Re-run the OWLLM installer (Training profile) to recreate it."
        )

    env_id = _resolve_env_id(llm_root)
    if not env_id:
        raise TrainingEnvBootstrapError(
            "Could not resolve OWLLM profile id from the venv layout. "
            "Re-run the OWLLM installer to refresh profile metadata."
        )

    try:
        from core.install import EnvRepairer, RepairOutcome
    except Exception as exc:
        raise TrainingEnvBootstrapError(
            f"Unified install foundation not importable: {exc}"
        )

    p(f"Repairing training env via EnvRepairer (env_id={env_id}, extras=['training'])…")
    repairer = EnvRepairer(project_root=llm_root)
    result = repairer.repair(
        env_python=py,
        env_id=env_id,
        extras=["training"],
        log=p,
    )

    if result.outcome in (RepairOutcome.SUCCESS, RepairOutcome.SUCCESS_WITH_WARNINGS):
        # Success path: re-derive a status snapshot for callers that
        # check the return value.
        final = status(llm_root)
        if result.outcome == RepairOutcome.SUCCESS_WITH_WARNINGS:
            p(f"⚠ {result.summary}")
        return final

    # Hard failure — match the historical exception so existing
    # callers (and the dialog they pop) keep working.
    detail_lines = [f"{result.outcome.value}: {result.summary}"]
    for r in result.pip_results:
        if not r.ok:
            detail_lines.append(f"  pip {r.cmd[0]} … exited {r.returncode}")
            detail_lines.append(f"  log: {r.log_path}")
    if result.torch_after and result.torch_after.raw_output:
        detail_lines.append(f"  torch state: {result.torch_after.raw_output[-400:]}")
    raise TrainingEnvBootstrapError(
        "Training-env repair did not converge.\n\n"
        + "\n".join(detail_lines)
        + "\n\nDetailed pip logs are in LLM/logs/pip/."
    )


# ---------------------------------------------------------------------------
# Legacy fallback for the rare case that EnvRepairer can't be used
# ---------------------------------------------------------------------------


_LEGACY_PROBES = ("unsloth", "trl", "peft", "bitsandbytes")


def _legacy_status_fallback(python_exe: Path) -> TrainingEnvStatus:
    """Used only when env_id can't be resolved or PinResolver fails.

    Spawns the venv interpreter for each probe — same approach the old
    implementation used. Kept as a safety net so callers still get a
    sensible answer in degraded conditions.
    """
    import subprocess
    import sys as _sys
    missing: List[str] = []
    for module in _LEGACY_PROBES:
        try:
            proc = subprocess.run(
                [str(python_exe), "-c", f"import {module}"],
                capture_output=True,
                text=True,
                timeout=20,
                creationflags=(0x08000000 if _sys.platform == "win32" else 0),
            )
        except Exception:
            missing.append(module)
            continue
        if proc.returncode != 0:
            missing.append(module)
    return TrainingEnvStatus(
        venv_python_exists=True,
        venv_python_path=str(python_exe),
        missing_packages=missing,
    )


# ---------------------------------------------------------------------------
# GGUF -> bf16 helper (unrelated to the install pipeline; kept here
# because the Train tab imports it from this module)
# ---------------------------------------------------------------------------


def non_gguf_variant(model_name: str) -> str:
    """Return the bf16 / safetensors variant of a GGUF model id.

    ``unsloth/gemma-4-E4B-it-GGUF`` → ``unsloth/gemma-4-E4B-it``
    ``meta-llama/Llama-3.2-1B``     → ``meta-llama/Llama-3.2-1B`` (no-op)
    """
    s = model_name.strip()
    for suffix in ("-GGUF", "-gguf", "_gguf", "_GGUF"):
        if s.endswith(suffix):
            return s[: -len(suffix)]
    if "gguf" in s.lower():
        # Mid-name variants (rare) — best-effort strip.
        return s.replace("-GGUF", "").replace("-gguf", "")
    return s
