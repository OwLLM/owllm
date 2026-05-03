"""Single repair orchestrator for any OWLLM environment.

Why this exists
---------------
Six different code paths in OWLLM each implement their own version of
"figure out what's broken in this venv and fix it":

  * ``installer_v2.InstallerV2.repair()`` — the home-page Fix Issues
    button.
  * ``desktop_app/main.py::_run_installer_task`` — the Environments
    page Repair Environment button.
  * ``desktop_app/main.py::_run_pkg_task`` — per-package Repair
    Component button.
  * ``desktop_app/training_env_manager.py::ensure_ready`` — Train tab
    preflight (and the eager training-env install I added in 8b0e6d9).
  * ``core/model_onboarding.py`` step 10 — installs model-specific
    extra packages into a dedicated env.
  * ``core/llm_server_manager._start_server`` preflight self-heal.

Each path's diff/install/verify logic is similar but subtly different.
A bug fix in one place doesn't reach the others until someone notices
and back-ports it. Result: the L1/L2/L2.5/L3 ladder lives only in
training_env_manager; the torch-trio coherence check lives only in
immutable_installer; the eager auto-install lives only in the home-
page repair flow; each entry point gives the user a different repair
quality.

This class collapses all six into one orchestrator. Every entry point
will (in subsequent commits) call ``EnvRepairer.repair(env_python,
env_id, extras=...)`` and route the result through the same UI
treatment.

Design contract
---------------
``repair()`` is the only public entry point. Steps:

  1. Probe interpreter health (interpreter exists, runs, can run pip).
  2. Probe torch+CUDA health (subprocess: import torch, torchvision,
     torchaudio; check torch.cuda.is_available()).
  3. If torch import fails with an ABI fingerprint
     (intrusive_ptr_target, _C.pyd, libtorch DLL load failure, ...),
     force-reinstall the matched torch trio from the env's torch_index.
  4. Diff installed packages (PipExecutor.freeze) against required
     (PinResolver.required_for) — categorize {missing, wrong_version,
     present_ok}.
  5. Install the diff via PipExecutor with the env's preferred mode.
  6. Re-verify: probe everything again, return structured RepairResult.

Returns ``RepairResult`` — never raises for an install failure (only
for setup-level errors). Callers translate the result into UI.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence, Tuple

from core.install.pin_resolver import PinResolver, _normalize
from core.install.pip_executor import (
    PipExecutor,
    PipMode,
    PipResult,
    PipExecutorError,
)


LogCallback = Callable[[str], None]


# Fingerprints that mean "torch is loaded against a different libtorch
# build" or "the C extensions can't load at all". Centralised so the
# launcher's pre-launch probe and the repairer's post-install verify
# read the SAME list.
TORCH_ABI_FINGERPRINTS: Tuple[str, ...] = (
    "intrusive_ptr_target",
    "c10::",
    "could not be located in the dynamic link library",
    "_c.pyd",
    "dll load failed while importing _c",
    "undefined symbol",
    "could not load this library",
    "libtorchaudio",
    "libtorchvision",
    "libtorch",
)


class PackageStatus(str, Enum):
    OK = "ok"
    MISSING = "missing"
    WRONG_VERSION = "wrong_version"
    UNCHECKED = "unchecked"


class RepairOutcome(str, Enum):
    SUCCESS = "success"               # everything required is present + torch CUDA OK
    SUCCESS_WITH_WARNINGS = "success_with_warnings"  # installed but torch CUDA still off
    FAILED = "failed"                 # at least one required pkg couldn't install
    INTERPRETER_MISSING = "interpreter_missing"
    UNREACHABLE = "unreachable"       # could not even spawn pip


@dataclass
class PackageDiff:
    name: str
    spec: str
    installed_version: Optional[str]
    status: PackageStatus


@dataclass
class TorchProbe:
    ok: bool
    torch_version: Optional[str] = None
    torchvision_version: Optional[str] = None
    torchaudio_version: Optional[str] = None
    cuda_available: bool = False
    raw_output: str = ""
    abi_mismatch: bool = False


@dataclass
class RepairResult:
    outcome: RepairOutcome
    env_python: Path
    env_id: str
    diff: List[PackageDiff] = field(default_factory=list)
    pip_results: List[PipResult] = field(default_factory=list)
    torch_before: Optional[TorchProbe] = None
    torch_after: Optional[TorchProbe] = None
    summary: str = ""
    log_paths: List[Path] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.outcome in (RepairOutcome.SUCCESS, RepairOutcome.SUCCESS_WITH_WARNINGS)

    @property
    def short_error(self) -> str:
        """First useful failure message for showing to humans."""
        for r in self.pip_results:
            if not r.ok:
                return r.short_error
        return self.summary


class EnvRepairer:
    """Single repair orchestrator. Constructed once per project, called many times."""

    def __init__(
        self,
        project_root: Path,
        *,
        pin_resolver: Optional[PinResolver] = None,
        pip_executor: Optional[PipExecutor] = None,
    ) -> None:
        self.project_root = Path(project_root).resolve()
        self.resolver = pin_resolver or PinResolver(project_root=self.project_root)
        self.pip = pip_executor or PipExecutor(project_root=self.project_root)

    # -----------------------------------------------------------------
    # Probe-only — used by UIs that want to RENDER the plan before
    # asking the user to confirm 'Start Repair'.
    # -----------------------------------------------------------------
    def probe(
        self,
        env_python: Path,
        env_id: str,
        *,
        extras: Optional[List[str]] = None,
        log: Optional[LogCallback] = None,
    ) -> RepairResult:
        """Compute the repair plan WITHOUT installing anything.

        Returns a fully-populated RepairResult with:
          * torch_before — what we found on probe
          * diff         — per-package status (OK / MISSING / WRONG_VERSION)
          * outcome      — UNREACHABLE / INTERPRETER_MISSING when those apply,
                           SUCCESS when nothing needs doing,
                           FAILED otherwise (callers display 'work to do')

        ``torch_after`` and ``pip_results`` are left empty since we
        haven't actually run pip.
        """
        env_python = Path(env_python)
        log = log or (lambda _msg: None)

        result = RepairResult(
            outcome=RepairOutcome.UNREACHABLE,
            env_python=env_python,
            env_id=env_id,
        )
        if not env_python.exists():
            result.outcome = RepairOutcome.INTERPRETER_MISSING
            result.summary = f"venv interpreter does not exist: {env_python}"
            return result

        log("[probe] running torch import probe …")
        result.torch_before = self._probe_torch(env_python)

        try:
            required = self.resolver.required_for(env_id, extras=extras)
        except Exception as exc:
            result.outcome = RepairOutcome.FAILED
            result.summary = f"could not load profile {env_id!r}: {exc}"
            return result

        try:
            installed = self.pip.freeze(env_python=env_python)
        except PipExecutorError as exc:
            result.outcome = RepairOutcome.UNREACHABLE
            result.summary = f"pip freeze failed: {exc}"
            return result

        result.diff = self._compute_diff(required, installed)

        # Outcome decision: if nothing's missing AND torch imports cleanly,
        # the env is in fact already healthy — surface as SUCCESS so the
        # UI can short-circuit to "nothing to do".
        bad_pkgs = [d for d in result.diff if d.status in (PackageStatus.MISSING, PackageStatus.WRONG_VERSION)]
        torch_unhealthy = bool(result.torch_before and (result.torch_before.abi_mismatch or not result.torch_before.ok))
        if not bad_pkgs and not torch_unhealthy:
            result.outcome = RepairOutcome.SUCCESS
            result.summary = "environment already healthy; no repair work needed"
        else:
            result.outcome = RepairOutcome.FAILED  # 'work to do' marker
            parts = []
            if bad_pkgs:
                parts.append(f"{len(bad_pkgs)} package(s) need install/update")
            if torch_unhealthy:
                parts.append("torch C-extensions need rebuild")
            result.summary = "; ".join(parts) if parts else "repair plan ready"
        return result

    # -----------------------------------------------------------------
    # Public API
    # -----------------------------------------------------------------
    def repair(
        self,
        env_python: Path,
        env_id: str,
        *,
        extras: Optional[List[str]] = None,
        log: Optional[LogCallback] = None,
        skip_torch_coherence: bool = False,
        install_mode: PipMode = PipMode.WHEELHOUSE_THEN_PYPI,
        timeout_per_step_s: int = 1800,
    ) -> RepairResult:
        """Bring ``env_python``'s environment in line with the declared deps.

        Args:
            env_python: Path to the venv's python.exe to repair.
            env_id: Profile id (e.g. ``"ampere_cu121"``) — drives
                which package set we treat as required.
            extras: Optional list of extras files to merge in
                (e.g. ``["training"]`` for the training stack).
            log: Per-line UI callback. Forwarded to PipExecutor as well.
            skip_torch_coherence: For UTs / unusual flows where the
                torch trio shouldn't be touched even if mismatched.
            install_mode: Which PipMode to use for the diff install.
                Default WHEELHOUSE_THEN_PYPI gives the wheelhouse first
                shot at satisfying the spec but allows network fallback;
                use WHEELHOUSE_ONLY to force the deterministic install
                path used at first install.
            timeout_per_step_s: Per-pip-call timeout. The torch trio
                rebuild gets a 4× multiplier internally because it's a
                3 GB download.
        """
        env_python = Path(env_python)
        env_id = str(env_id).strip()
        log = log or (lambda _msg: None)

        result = RepairResult(
            outcome=RepairOutcome.UNREACHABLE,
            env_python=env_python,
            env_id=env_id,
        )

        # -------- step 1: interpreter sanity ----------------------
        log(f"[repair] env_python = {env_python}")
        if not env_python.exists():
            result.outcome = RepairOutcome.INTERPRETER_MISSING
            result.summary = f"venv interpreter does not exist: {env_python}"
            log(f"[repair] FATAL: {result.summary}")
            return result

        # -------- step 2: torch probe ----------------------------
        log("[repair] probing torch / torchvision / torchaudio …")
        torch_before = self._probe_torch(env_python)
        result.torch_before = torch_before
        log(
            f"[repair] torch probe: ok={torch_before.ok} "
            f"abi_mismatch={torch_before.abi_mismatch} "
            f"cuda={torch_before.cuda_available} "
            f"versions={torch_before.torch_version},{torch_before.torchvision_version},{torch_before.torchaudio_version}"
        )

        # -------- step 3: torch trio coherence ------------------
        if not skip_torch_coherence and torch_before.abi_mismatch:
            log("[repair] torch ABI mismatch detected — rebuilding the matched trio …")
            trio_pip_results = self._rebuild_torch_trio(
                env_python, env_id, log=log, timeout_s=timeout_per_step_s * 4
            )
            result.pip_results.extend(trio_pip_results)
            for pr in trio_pip_results:
                result.log_paths.append(pr.log_path)

        # -------- step 4: diff against required ------------------
        try:
            required = self.resolver.required_for(env_id, extras=extras)
        except Exception as exc:
            result.outcome = RepairOutcome.FAILED
            result.summary = f"could not load profile {env_id!r}: {exc}"
            log(f"[repair] FATAL: {result.summary}")
            return result

        log(f"[repair] required for env_id={env_id} extras={extras}: {len(required)} packages")
        try:
            installed = self.pip.freeze(env_python=env_python)
        except PipExecutorError as exc:
            result.outcome = RepairOutcome.UNREACHABLE
            result.summary = f"pip freeze failed: {exc}"
            log(f"[repair] FATAL: {result.summary}")
            return result

        diff = self._compute_diff(required, installed)
        result.diff = diff
        to_install = [d for d in diff if d.status in (PackageStatus.MISSING, PackageStatus.WRONG_VERSION)]
        log(
            f"[repair] diff: {sum(1 for d in diff if d.status == PackageStatus.MISSING)} missing, "
            f"{sum(1 for d in diff if d.status == PackageStatus.WRONG_VERSION)} wrong-version, "
            f"{sum(1 for d in diff if d.status == PackageStatus.OK)} ok"
        )

        # -------- step 5: install the diff ----------------------
        if to_install:
            specs = self._diff_to_specs(to_install)
            mode_for_install = self._mode_for(env_id, install_mode)
            log(f"[repair] installing {len(specs)} packages with mode={mode_for_install.value} …")
            install_res = self.pip.install(
                env_python=env_python,
                specs=specs,
                mode=mode_for_install,
                log=log,
                label=f"repair-{env_id}",
                timeout_s=timeout_per_step_s,
            )
            result.pip_results.append(install_res)
            result.log_paths.append(install_res.log_path)
            if not install_res.ok:
                result.outcome = RepairOutcome.FAILED
                result.summary = (
                    f"install failed (exit {install_res.returncode}). "
                    f"See {install_res.log_path}"
                )
                log(f"[repair] FAILED: {result.summary}")
                return result
        else:
            log("[repair] every required package is already at the right version.")

        # -------- step 6: post-install verification --------------
        log("[repair] re-probing torch …")
        torch_after = self._probe_torch(env_python)
        result.torch_after = torch_after
        log(
            f"[repair] torch after: ok={torch_after.ok} "
            f"abi_mismatch={torch_after.abi_mismatch} "
            f"cuda={torch_after.cuda_available}"
        )

        if torch_after.abi_mismatch:
            result.outcome = RepairOutcome.FAILED
            result.summary = (
                "torch C extensions still won't load after install. "
                "ABI mismatch persisted; the bundle's wheel set may be incompatible."
            )
            log(f"[repair] FAILED: {result.summary}")
            return result

        # All required packages installed and torch imports work. CUDA
        # state is informational — if torch loads but cuda isn't
        # available, that's a hardware/driver issue not an install
        # issue. We still report SUCCESS but flag the warning.
        if torch_after.ok and torch_after.cuda_available:
            result.outcome = RepairOutcome.SUCCESS
            result.summary = (
                f"environment {env_id} ready: torch={torch_after.torch_version}, "
                f"cuda={torch_after.cuda_available}"
            )
        else:
            result.outcome = RepairOutcome.SUCCESS_WITH_WARNINGS
            result.summary = (
                f"packages installed but torch.cuda.is_available()={torch_after.cuda_available}. "
                f"Likely a driver / non-CUDA build issue."
            )
        log(f"[repair] {result.outcome.value}: {result.summary}")
        return result

    # -----------------------------------------------------------------
    # Internals
    # -----------------------------------------------------------------
    def _probe_torch(self, env_python: Path) -> TorchProbe:
        """Spawn the venv: import torch family, report what happened."""
        import subprocess
        import sys as _sys
        probe = (
            "import sys, json\n"
            "out = {'ok': False, 'imports': {}}\n"
            "try:\n"
            "    import torch\n"
            "    out['imports']['torch'] = torch.__version__\n"
            "    out['cuda'] = bool(getattr(torch, 'cuda', None) and torch.cuda.is_available())\n"
            "except Exception as e:\n"
            "    out['fail'] = f'torch:{type(e).__name__}:{e}'\n"
            "    print(json.dumps(out))\n"
            "    sys.exit(2)\n"
            "for mod in ('torchvision', 'torchaudio'):\n"
            "    try:\n"
            "        m = __import__(mod)\n"
            "        out['imports'][mod] = getattr(m, '__version__', '?')\n"
            "    except Exception as e:\n"
            "        out['fail'] = f'{mod}:{type(e).__name__}:{e}'\n"
            "        print(json.dumps(out))\n"
            "        sys.exit(3)\n"
            "out['ok'] = True\n"
            "print(json.dumps(out))\n"
        )
        try:
            proc = subprocess.run(
                [str(env_python), "-c", probe],
                capture_output=True,
                text=True,
                timeout=30,
                creationflags=(0x08000000 if _sys.platform == "win32" else 0),
            )
        except subprocess.TimeoutExpired:
            return TorchProbe(ok=False, raw_output="probe timed out")
        except Exception as exc:
            return TorchProbe(ok=False, raw_output=f"probe spawn failed: {exc}")
        raw = (proc.stdout or "") + (proc.stderr or "")
        try:
            import json as _json
            data = _json.loads((proc.stdout or "{}").strip().splitlines()[-1])
        except Exception:
            data = {}
        ok = bool(data.get("ok"))
        cuda = bool(data.get("cuda"))
        imports = data.get("imports") or {}
        abi = any(fp in raw.lower() for fp in TORCH_ABI_FINGERPRINTS)
        return TorchProbe(
            ok=ok,
            torch_version=imports.get("torch"),
            torchvision_version=imports.get("torchvision"),
            torchaudio_version=imports.get("torchaudio"),
            cuda_available=cuda,
            raw_output=raw.strip()[-2000:],
            abi_mismatch=abi,
        )

    def _rebuild_torch_trio(
        self,
        env_python: Path,
        env_id: str,
        *,
        log: LogCallback,
        timeout_s: int,
    ) -> List[PipResult]:
        """Force-uninstall torch/torchvision/torchaudio, reinstall matched trio.

        Returns every PipResult produced (uninstall + install) so the
        caller can persist the logs.
        """
        results: List[PipResult] = []
        # Uninstall first so pip doesn't decide a "compatible" version
        # is already present and skip the install. Order: dependents first.
        try:
            r_un = self.pip.uninstall(
                env_python=env_python,
                packages=["torchvision", "torchaudio", "torch"],
                log=log,
            )
            results.append(r_un)
        except PipExecutorError as exc:
            log(f"[trio] uninstall pre-step failed: {exc}")

        torch_spec = self.resolver.get("torch", env_id) or "==2.5.1+cu121"
        tv_spec = self.resolver.get("torchvision", env_id) or "==0.20.1+cu121"
        ta_spec = self.resolver.get("torchaudio", env_id) or "==2.5.1+cu121"
        triple = [
            self._materialise_spec("torch", torch_spec),
            self._materialise_spec("torchvision", tv_spec),
            self._materialise_spec("torchaudio", ta_spec),
        ]

        # Wheelhouse first (offline cu121 wheels already cached). If
        # that doesn't satisfy, retry from the PyTorch CUDA index.
        r_wh = self.pip.install(
            env_python=env_python,
            specs=triple,
            mode=PipMode.WHEELHOUSE_ONLY,
            no_deps=True,
            force_reinstall=True,
            log=log,
            label="trio-wheelhouse",
            timeout_s=timeout_s,
        )
        results.append(r_wh)
        if r_wh.ok:
            return results

        log("[trio] wheelhouse-only didn't satisfy; retrying from PyTorch CUDA index …")
        # The cu121 vs cu124 choice comes from the profile's
        # torch_index URL.
        torch_index = self.resolver.torch_index_for(env_id) or ""
        if "cu124" in torch_index:
            mode = PipMode.PYPI_PLUS_CU124
        elif "cu121" in torch_index:
            mode = PipMode.PYPI_PLUS_CU121
        else:
            mode = PipMode.PYPI_PLUS_CU121  # safe default
        r_idx = self.pip.install(
            env_python=env_python,
            specs=triple,
            mode=mode,
            no_deps=True,
            force_reinstall=True,
            log=log,
            label="trio-pytorch-index",
            timeout_s=timeout_s,
        )
        results.append(r_idx)
        return results

    def _compute_diff(
        self,
        required: Dict[str, str],
        installed: Dict[str, str],
    ) -> List[PackageDiff]:
        diff: List[PackageDiff] = []
        for raw_name, spec in required.items():
            name = _normalize(raw_name)
            current = installed.get(name)
            status = self._evaluate_spec(spec, current)
            diff.append(PackageDiff(
                name=name,
                spec=spec,
                installed_version=current,
                status=status,
            ))
        return diff

    @staticmethod
    def _evaluate_spec(spec: str, current_version: Optional[str]) -> PackageStatus:
        if current_version is None:
            return PackageStatus.MISSING
        spec = spec.strip()
        if not spec:
            return PackageStatus.OK  # "any version" — anything installed is fine.
        # Use packaging when available for proper PEP 440 evaluation.
        try:
            from packaging.specifiers import SpecifierSet
            from packaging.version import Version, InvalidVersion
            if not spec.startswith(("==", ">=", "<=", ">", "<", "!=", "~=")):
                spec = f"=={spec}"
            try:
                ok = Version(current_version) in SpecifierSet(spec)
            except InvalidVersion:
                # Local versions like "2.5.1+cu121" sometimes fail the
                # parser depending on packaging build; compare textually.
                base_current = current_version.split("+", 1)[0]
                base_spec = spec.lstrip("=").split("+", 1)[0]
                ok = base_current.startswith(base_spec)
            return PackageStatus.OK if ok else PackageStatus.WRONG_VERSION
        except Exception:
            # packaging missing — be permissive (treat as OK rather
            # than triggering a needless reinstall).
            return PackageStatus.OK

    @staticmethod
    def _diff_to_specs(diff: Sequence[PackageDiff]) -> List[str]:
        specs: List[str] = []
        for d in diff:
            spec = d.spec.strip() if d.spec else ""
            if not spec:
                specs.append(d.name)
                continue
            if spec.startswith(("==", ">=", "<=", ">", "<", "!=", "~=")) or "," in spec:
                specs.append(f"{d.name}{spec}")
            else:
                specs.append(f"{d.name}=={spec}")
        return specs

    @staticmethod
    def _materialise_spec(name: str, spec: str) -> str:
        spec = (spec or "").strip()
        if not spec:
            return name
        if spec.startswith(("==", ">=", "<=", ">", "<", "!=", "~=")) or "," in spec:
            return f"{name}{spec}"
        return f"{name}=={spec}"

    def _mode_for(self, env_id: str, requested: PipMode) -> PipMode:
        """Pick the right PipMode for an env, with sane fallbacks.

        If the caller explicitly requested WHEELHOUSE_ONLY, honor it.
        For mixed modes we may upgrade to PYPI_PLUS_CU121/124 when the
        env's profile specifies a cu* torch index — otherwise CUDA torch
        wheels can't be located.
        """
        if requested in (PipMode.WHEELHOUSE_ONLY,):
            return requested
        torch_index = (self.resolver.torch_index_for(env_id) or "").lower()
        if requested in (PipMode.WHEELHOUSE_THEN_PYPI, PipMode.PYPI):
            if "cu124" in torch_index:
                return PipMode.PYPI_PLUS_CU124
            if "cu121" in torch_index:
                return PipMode.PYPI_PLUS_CU121
        return requested
