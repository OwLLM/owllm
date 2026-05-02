"""Self-healing for the training environment.

Mirrors :mod:`agent_runtime_manager` but for the fine-tuning side. The
training tab calls :func:`status` for a quick check before launching
``finetune.py`` and :func:`ensure_ready` to auto-install whatever's
missing — **no manual pip dance from the user**.

The training venv (resolved through
``core.runtime.owllm_python.get_owllm_env`` — typically
``LLM/.envs/<profile>/.venv``) needs:

* ``unsloth``     — the fine-tuner core
* ``trl``         — Hugging Face's RLHF / SFT trainer (Unsloth depends on it)
* ``peft``        — LoRA / adapter implementation
* ``bitsandbytes``— 4-bit quantisation backend

These ship via the OWLLM installer's training profile, but if a user
re-clones, restores from backup, or upgrades the venv, anything could
go missing. Auto-installing on demand is the OWLLM rule (auto-provision
on install + auto-repair first).
"""
from __future__ import annotations

import logging
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, List, Optional, Tuple

logger = logging.getLogger(__name__)


# Same pinning convention as ``requirements.txt`` for the agent SDKs —
# version specs are passed verbatim to ``pip install`` so we don't drift
# past a major bump that breaks finetune.py.
REQUIRED_TRAINING_PACKAGES: Tuple[Tuple[str, str], ...] = (
    ("unsloth",      "unsloth"),
    ("trl",          "trl"),
    ("peft",         "peft"),
    ("bitsandbytes", "bitsandbytes"),
)


@dataclass
class TrainingEnvStatus:
    venv_python_exists: bool
    venv_python_path: str
    missing_packages: List[str] = field(default_factory=list)

    @property
    def fully_ready(self) -> bool:
        return self.venv_python_exists and not self.missing_packages


class TrainingEnvBootstrapError(RuntimeError):
    """Raised when an install step fails in a way the caller can't fix."""


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------


def _venv_python_path(llm_root: Path) -> Path:
    """Where the training venv's interpreter lives.

    Delegates to :func:`core.runtime.owllm_python.get_owllm_env` —
    that's the single source of truth for "where is the OWLLM
    Python?", established when the launcher was rewired. The legacy
    layout was ``LLM/.venv/Scripts/python.exe``; the canonical
    layout is ``LLM/.envs/<env_key>/.venv/Scripts/python.exe`` where
    ``env_key`` is whatever profile the user installed (cu121-stable,
    cu124-stable, …). Falling back to the legacy path keeps the
    warning message useful when the canonical resolver can't find an
    env at all.
    """
    try:
        from core.runtime.owllm_python import get_owllm_env
        env = get_owllm_env(llm_root)
        return env.python_exe
    except Exception:
        logger.debug("training_env_manager: get_owllm_env failed, using legacy .venv path", exc_info=True)
        return llm_root / ".venv" / "Scripts" / "python.exe"


def status(llm_root: Path) -> TrainingEnvStatus:
    """Probe the training venv for required packages.

    Each package is checked by spawning the venv's own interpreter with
    ``-c 'import <name>'`` — that's the same probe Python would do at
    finetune.py launch, so it catches subtle install issues (broken
    metadata, half-extracted wheels) the way ``importlib.metadata`` from
    the parent process can't.
    """
    py = _venv_python_path(llm_root)
    if not py.exists():
        return TrainingEnvStatus(
            venv_python_exists=False,
            venv_python_path=str(py),
            missing_packages=[name for name, _ in REQUIRED_TRAINING_PACKAGES],
        )

    missing: List[str] = []
    for import_name, _ in REQUIRED_TRAINING_PACKAGES:
        if not _can_import(py, import_name):
            missing.append(import_name)
    return TrainingEnvStatus(
        venv_python_exists=True,
        venv_python_path=str(py),
        missing_packages=missing,
    )


def _can_import(python_exe: Path, module: str) -> bool:
    try:
        proc = subprocess.run(
            [str(python_exe), "-c", f"import {module}"],
            capture_output=True,
            text=True,
            timeout=20,
            creationflags=(0x08000000 if sys.platform == "win32" else 0),
        )
    except Exception:  # noqa: BLE001
        return False
    return proc.returncode == 0


def _import_error(python_exe: Path, module: str) -> str:
    """Return stderr from ``python -c "import <module>"`` — empty string
    if the import succeeds. Used by self-healing to figure out WHY a
    pip-installed package fails to import (the typical Windows culprit
    for unsloth is a missing transitive ``triton`` module that pip
    silently couldn't supply)."""
    try:
        proc = subprocess.run(
            [str(python_exe), "-c", f"import {module}"],
            capture_output=True,
            text=True,
            timeout=20,
            creationflags=(0x08000000 if sys.platform == "win32" else 0),
        )
    except Exception as exc:  # noqa: BLE001
        return str(exc)
    if proc.returncode == 0:
        return ""
    return (proc.stderr or proc.stdout or "").strip()


# ---------------------------------------------------------------------------
# Self-install
# ---------------------------------------------------------------------------


ProgressFn = Callable[[str], None]


def ensure_ready(
    llm_root: Path,
    progress: Optional[ProgressFn] = None,
) -> TrainingEnvStatus:
    """Install whatever's missing in the training venv.

    Idempotent + self-healing. Reports each step via ``progress`` so the
    UI can show a progress dialog. Raises
    :class:`TrainingEnvBootstrapError` only when every recovery attempt
    has been exhausted — the app's "self-healing, self-contained,
    self-installed" promise means we should resolve everything we can
    automatically before bothering the user.

    Recovery levels for each missing package:

      L1 — plain ``pip install <pkg>`` (the cheap path that works for
           well-behaved packages).
      L2 — if the import still fails, parse the import error and
           install the named missing dep first (e.g. unsloth's
           transitive ``triton`` module needs ``triton-windows`` on
           Windows because mainline ``triton`` only ships Linux/macOS
           wheels).
      L3 — ``pip install --upgrade --force-reinstall <pkg>`` to clear
           any half-installed wheel state from a previous failed run.

    Only after L1 → L2 → L3 all fail to make ``import <pkg>`` work do
    we surface the actual import error to the user.
    """
    p = progress or (lambda _msg: None)

    cur = status(llm_root)
    if not cur.venv_python_exists:
        raise TrainingEnvBootstrapError(
            f"Training venv interpreter not found at:\n  {cur.venv_python_path}\n\n"
            "Re-run the OWLLM installer (Training profile) to recreate it, "
            "or run:\n  python -m venv LLM/.venv"
        )

    if not cur.missing_packages:
        p("Training environment ready.")
        return cur

    py = Path(cur.venv_python_path)
    spec_lookup = dict(REQUIRED_TRAINING_PACKAGES)
    final_errors: List[Tuple[str, str]] = []

    for pkg in cur.missing_packages:
        spec = spec_lookup.get(pkg, pkg)

        # ---- L1: plain pip install -----------------------------------
        p(f"Installing {spec} (this can take a few minutes)…")
        try:
            _pip_install(py, spec)
        except TrainingEnvBootstrapError as exc:
            # Hard install failure — record and move on; the L3 retry
            # below also wraps a different flag set so we may still
            # succeed.
            logger.warning("L1 install of %s failed: %s", pkg, exc)

        if _can_import(py, pkg):
            continue

        # ---- L2: targeted prereq install based on the import error ---
        err = _import_error(py, pkg)
        prereqs = _infer_prereq_specs(pkg, err)
        if prereqs:
            for prereq in prereqs:
                p(f"Installing prerequisite {prereq} for {pkg}…")
                try:
                    _pip_install(py, prereq)
                except TrainingEnvBootstrapError as exc:
                    logger.warning("L2 prereq %s for %s failed: %s", prereq, pkg, exc)
            if _can_import(py, pkg):
                continue

        # ---- L3: aggressive reinstall --------------------------------
        p(f"Re-installing {spec} with --upgrade --force-reinstall…")
        try:
            _pip_install(py, spec, force_reinstall=True)
        except TrainingEnvBootstrapError as exc:
            logger.warning("L3 force-reinstall of %s failed: %s", pkg, exc)

        if _can_import(py, pkg):
            continue

        # All recovery levels failed — capture the real reason.
        err = _import_error(py, pkg) or "(no stderr captured)"
        final_errors.append((pkg, err))

    final = status(llm_root)
    if not final.fully_ready or final_errors:
        details = "\n\n".join(
            f"• {pkg} — actual import error:\n    {err}"
            for pkg, err in final_errors
        )
        raise TrainingEnvBootstrapError(
            "Self-healing exhausted L1/L2/L3 recovery and "
            f"{len(final_errors)} package(s) still won't import.\n\n"
            f"{details}\n\n"
            "Open the Models tab → Repair All to rebuild the env from "
            "scratch, or report this trace so we can ship a tighter "
            "self-heal for your platform."
        )
    p("All training packages installed.")
    return final


def _infer_prereq_specs(pkg: str, import_error: str) -> List[str]:
    """Map an ``ImportError`` stderr blob to the pip specs that can fix it.

    Self-healing only auto-installs a prereq when we have HIGH
    confidence the mapping is right — every entry below is rooted in
    a known-good fix for a recurring user report. Adding a new entry
    means: someone hit it twice, manual fix worked, we know the spec.
    """
    err = (import_error or "").lower()
    out: List[str] = []

    if pkg == "unsloth":
        # The most common Windows symptom: ``ModuleNotFoundError: triton``.
        # Mainline ``triton`` only ships Linux/macOS wheels; the community
        # ``triton-windows`` package fills the same import name for
        # unsloth's purposes.
        if "no module named 'triton'" in err or "no module named \"triton\"" in err:
            if sys.platform == "win32":
                out.append("triton-windows")
            else:
                out.append("triton")
        # Some builds need ``unsloth_zoo`` separately.
        if "no module named 'unsloth_zoo'" in err:
            out.append("unsloth_zoo")
        # ``xformers`` import failures are usually torch-version skew —
        # forcing the wheel that matches the installed torch tends to
        # resolve them. We *don't* pin a version because the right one
        # depends on torch+cuda; pip's resolver picks something
        # compatible most of the time.
        if "no module named 'xformers'" in err:
            out.append("xformers")

    return out


def _pip_install(python_exe: Path, package_spec: str, *, force_reinstall: bool = False) -> None:
    """Install one package into the training venv.

    Two anti-foot-gun flags vs. a naive ``pip install --upgrade <pkg>``:

    * **Drop ``--upgrade``** for the default path. We only install
      packages that ``status()`` reported as missing. ``--upgrade``
      would force pip to re-resolve already-satisfied deps and try
      to write fresh wheels for them, which on Windows trips
      ``WinError 32`` whenever the OWLLM Python process has those
      deps loaded (zipp, importlib_metadata, packaging, etc.).
    * **``--upgrade-strategy only-if-needed``** — belt-and-suspenders
      for the same problem at the transitive layer.

    Pass ``force_reinstall=True`` for the L3 self-heal path
    (``ensure_ready`` falls back to it when L1+L2 leave the package
    importable-broken). Force-reinstall costs more — it re-resolves
    every transitive dep — but it cleans up half-installed wheel
    state from a previous failed run that cheaper installs leave
    alone.

    On a clean WinError 32 we raise a self-recoverable error with a
    clear message; on other failures the stderr tail is included so
    the user sees the actual reason.
    """
    cmd = [
        str(python_exe), "-m", "pip", "install",
        "--upgrade-strategy", "only-if-needed",
        "--prefer-binary",
        "--no-warn-script-location",
    ]
    if force_reinstall:
        cmd += ["--upgrade", "--force-reinstall"]
    cmd.append(package_spec)
    creationflags = 0x08000000 if sys.platform == "win32" else 0
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=False,
            timeout=900,  # unsloth is a fat install (compiled wheels) — be generous
            creationflags=creationflags,
        )
    except subprocess.TimeoutExpired:
        raise TrainingEnvBootstrapError(
            f"pip install {package_spec} timed out after 15 minutes"
        )
    except FileNotFoundError as exc:
        raise TrainingEnvBootstrapError(f"pip not callable in training venv: {exc}")

    if proc.returncode == 0:
        return

    stderr = (proc.stderr or "").strip()

    # Windows file-lock detection — WinError 32 on a venv .py means a
    # running Python process has it imported. Surface specifically because
    # the ONLY user-actionable fix is to close OWLLM and retry.
    if "WinError 32" in stderr or "being used by another process" in stderr.lower():
        # Pull the locked filename out so the message is concrete.
        import re
        m = re.search(r"'([^']+\.py)'", stderr)
        locked = m.group(1) if m else "(unknown file)"
        raise TrainingEnvBootstrapError(
            "Windows is holding a venv file open and pip can't replace it.\n\n"
            f"Locked file: {locked}\n\n"
            "This happens when OWLLM's own Python process has the package "
            "imported. Two ways to recover:\n\n"
            "  1) Close OWLLM completely, then re-open it and click Start "
            "Training — the file will be free and the install will succeed.\n\n"
            "  2) From a terminal (with OWLLM closed), run:\n"
            f"     \"{python_exe}\" -m pip install --upgrade-strategy only-if-needed {package_spec}\n\n"
            "If the error persists after closing OWLLM, an antivirus scanner "
            "may be holding the file — temporarily exclude the LLM/.venv "
            "folder."
        )

    raise TrainingEnvBootstrapError(
        f"pip install {package_spec} failed (exit {proc.returncode}).\n"
        f"stderr: {stderr[:600]}"
    )


# ---------------------------------------------------------------------------
# GGUF -> bf16 helper
# ---------------------------------------------------------------------------


def non_gguf_variant(model_name: str) -> str:
    """Return the bf16 / safetensors variant of a GGUF model id.

    `unsloth/gemma-4-E4B-it-GGUF` → `unsloth/gemma-4-E4B-it`
    `meta-llama/Llama-3.2-1B`     → `meta-llama/Llama-3.2-1B` (no-op)
    """
    s = model_name.strip()
    for suffix in ("-GGUF", "-gguf", "_gguf", "_GGUF"):
        if s.endswith(suffix):
            return s[: -len(suffix)]
    if "gguf" in s.lower():
        # Mid-name variants (rare) — best-effort strip.
        return s.replace("-GGUF", "").replace("-gguf", "")
    return s
