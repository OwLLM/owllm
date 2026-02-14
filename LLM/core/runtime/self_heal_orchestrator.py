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

        def log(msg: str) -> None:
            if log_callback:
                log_callback(msg)

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

