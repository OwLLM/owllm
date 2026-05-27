"""
Self-heal orchestrator for onboarding/runtime preflight failures.
"""
from __future__ import annotations

from pathlib import Path
from typing import Callable, Optional, Tuple
import re

from core.envs.capability_matrix import classify_runtime_failure


LogCallback = Optional[Callable[[str], None]]


class SelfHealOrchestrator:
    """Bounded, idempotent remediation flow for probe failures."""

    def __init__(self, max_attempts: int = 1):
        self.max_attempts = max(0, int(max_attempts))

    def normalize_failure(self, reason_code: Optional[str], error_message: Optional[str]) -> dict:
        return classify_runtime_failure(reason_code, error_message)

    def _extract_missing_packages(self, error_message: str) -> list[str]:
        msg = error_message or ""
        out: list[str] = []
        # pip hint lines
        for m in re.finditer(r"pip install\s+([A-Za-z0-9_.\-]+)", msg):
            pkg = m.group(1).strip()
            if pkg and pkg not in out:
                out.append(pkg)
        # module missing lines
        mod_map = {
            "PIL": "Pillow",
            "auto_gptq": "auto-gptq",
            "open_clip": "open-clip-torch",
            "llama_cpp": "llama-cpp-python",
        }
        for m in re.finditer(r"No module named\s+['\"]([^'\"]+)['\"]", msg):
            mod = m.group(1).strip()
            pkg = mod_map.get(mod, mod)
            if pkg and pkg not in out:
                out.append(pkg)
        return out

    def try_repair_probe_failure(
        self,
        env_registry,
        python_exe: Path,
        model_path: str,
        adapter_dir: Optional[str],
        reason_code: Optional[str],
        error_message: Optional[str],
        log_callback: LogCallback = None,
    ) -> Tuple[bool, Optional[str], Optional[str]]:
        """
        Attempt bounded remediation then rerun model load probe.
        """
        if self.max_attempts <= 0:
            return False, reason_code, error_message

        info = self.normalize_failure(reason_code, error_message)
        category = info.get("category", "ENVIRONMENT_CORRUPT")

        # Phase-1 supervisor wire-in: emit a shadow observation BEFORE
        # any remediation runs, so we can compare the LLM-driven plan
        # (when supervisor.enabled + supervisor.shadow_mode are both on)
        # against this rule-based path's actual decision. Production
        # default flags keep the supervisor inert — this call is a
        # no-op until the user opts in via feature_flags.json.
        #
        # Hardened: import + call both swallow errors so a supervisor
        # bug can NEVER raise into the caller's failure path. Worst
        # case is "no shadow row got written", which is exactly the
        # production default behavior anyway.
        try:
            from core.supervisor import shadow as _supervisor_shadow
            _supervisor_shadow.observe(
                channel="runtime",
                trigger={
                    "kind": "runtime_probe_failed",
                    "reason_code": reason_code,
                    "error_message": (error_message or "")[:2000],
                    "category": category,
                    "model_path": str(model_path),
                },
                rules_decision={
                    "path": "self_heal_orchestrator",
                    "category": category,
                },
            )
        except Exception:
            pass

        def log(msg: str) -> None:
            if log_callback:
                log_callback(msg)

        # GGUF runtime failures should use runtime bundle repair path first
        # instead of generic package installation, which can dead-end on source builds.
        try:
            model_path_obj = Path(model_path)
            is_gguf = False
            if model_path_obj.is_file() and model_path_obj.suffix.lower() == ".gguf":
                is_gguf = True
            elif model_path_obj.is_dir():
                is_gguf = any(model_path_obj.rglob("*.gguf"))
            force_runtime_upgrade = bool(is_gguf and str(reason_code or "").strip().upper() == "GGUF_BACKEND_INCOMPATIBLE")
            if force_runtime_upgrade and hasattr(env_registry, "runtime_bundle_manager"):
                log("Self-heal: GGUF backend reported unsupported architecture; forcing runtime backend refresh.")
                rt_ok, rt_err = env_registry.runtime_bundle_manager.ensure_gguf_runtime(
                    python_exe,
                    model_path=model_path_obj,
                    log_callback=log_callback,
                    force_upgrade=True,
                )
                if not rt_ok:
                    return False, reason_code, (
                        f"{error_message}\nSelf-heal forced GGUF runtime refresh failed: {rt_err}"
                    )
                probe_ok, probe_reason, probe_error = env_registry.run_model_load_probe(
                    python_exe,
                    model_path,
                    adapter_dir=adapter_dir,
                    deep_probe=is_gguf,
                    log_callback=log_callback,
                )
                if probe_ok:
                    return True, None, None
                return False, probe_reason, probe_error
            if category == "RUNTIME_MISSING_COMPONENT" and is_gguf and hasattr(env_registry, "runtime_bundle_manager"):
                log("Self-heal: invoking GGUF runtime bundle repair flow.")
                rt_ok, rt_err = env_registry.runtime_bundle_manager.ensure_gguf_runtime(
                    python_exe,
                    model_path=model_path_obj,
                    log_callback=log_callback,
                )
                if not rt_ok:
                    # Secondary fallback: invoke env package installer path, which includes
                    # Python 3.11 rebuild logic for llama-cpp wheel availability.
                    log("Self-heal: runtime bundle repair failed, attempting package-installer fallback...")
                    pkg_ok, pkg_err = env_registry.auto_install_missing_packages(
                        python_exe,
                        ["llama-cpp-python"],
                        log_callback=log_callback,
                    )
                    if not pkg_ok:
                        return False, reason_code, (
                            f"{error_message}\nSelf-heal runtime bundle failed: {rt_err}\n"
                            f"Self-heal package fallback failed: {pkg_err}"
                        )
                probe_ok, probe_reason, probe_error = env_registry.run_model_load_probe(
                    python_exe,
                    model_path,
                    adapter_dir=adapter_dir,
                    deep_probe=is_gguf,
                    log_callback=log_callback,
                )
                if probe_ok:
                    return True, None, None
                return False, probe_reason, probe_error
        except Exception:
            pass

        # Only auto-repair categories that are safe and deterministic.
        if category not in ("RUNTIME_MISSING_COMPONENT", "ENVIRONMENT_CORRUPT"):
            return False, reason_code, error_message

        packages = self._extract_missing_packages(error_message or "")
        if reason_code == "RUNTIME_MISSING_COMPONENT" and "llama-cpp-python" not in packages:
            # GGUF path common requirement
            packages.append("llama-cpp-python")

        for _ in range(self.max_attempts):
            if packages:
                log(f"Self-heal: attempting package repair: {packages}")
                ok, err = env_registry.auto_install_missing_packages(
                    python_exe,
                    packages,
                    log_callback=log_callback,
                )
                if not ok:
                    return False, reason_code, f"{error_message}\nSelf-heal package install failed: {err}"

            # rerun probe
            probe_ok, probe_reason, probe_error = env_registry.run_model_load_probe(
                python_exe,
                model_path,
                adapter_dir=adapter_dir,
                deep_probe=is_gguf,
                log_callback=log_callback,
            )
            if probe_ok:
                return True, None, None
            reason_code, error_message = probe_reason, probe_error
            info = self.normalize_failure(reason_code, error_message)
            category = info.get("category", "ENVIRONMENT_CORRUPT")
            if category not in ("RUNTIME_MISSING_COMPONENT", "ENVIRONMENT_CORRUPT"):
                break
            packages = self._extract_missing_packages(error_message or "")

        return False, reason_code, error_message

