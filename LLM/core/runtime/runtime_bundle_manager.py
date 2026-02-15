"""
Runtime bundle manager for self-contained backend runtimes.

Initial scope:
- GGUF runtime readiness in a target environment.
- Deterministic install/repair attempts for backend components.
"""
from __future__ import annotations

from pathlib import Path
from typing import Callable, Optional, Tuple
import subprocess
import sys
import os


LogCallback = Optional[Callable[[str], None]]


class RuntimeBundleManager:
    """Ensures backend runtime components are available in an environment."""

    def __init__(self, subprocess_flags: Optional[dict] = None):
        self.subprocess_flags = subprocess_flags or {}

    def _run_python(self, python_exe: Path, code: str, timeout: int = 30) -> subprocess.CompletedProcess:
        return subprocess.run(
            [str(python_exe), "-c", code],
            capture_output=True,
            text=True,
            timeout=timeout,
            **self.subprocess_flags,
        )

    def _run_pip(self, python_exe: Path, args: list[str], timeout: int = 300) -> subprocess.CompletedProcess:
        return subprocess.run(
            [str(python_exe), "-m", "pip"] + args,
            capture_output=True,
            text=True,
            timeout=timeout,
            **self.subprocess_flags,
        )

    def _infer_llm_root(self, python_exe: Path) -> Optional[Path]:
        try:
            # .../LLM/.envs/<env_key>/.venv/Scripts/python.exe -> LLM root
            p = Path(python_exe).resolve()
            for parent in p.parents:
                if parent.name.lower() == "llm":
                    return parent
        except Exception:
            return None
        return None

    def _log(self, log_callback: LogCallback, message: str) -> None:
        if log_callback:
            log_callback(message)

    def ensure_gguf_runtime(self, python_exe: Path, log_callback: LogCallback = None) -> Tuple[bool, str]:
        """
        Ensure the environment can initialize GGUF runtime backend(s).

        Returns:
            (ok, error_message)
        """
        if not python_exe or not python_exe.exists():
            return False, f"Python executable not found for runtime bundle: {python_exe}"

        # 1) Preferred runtime: llama-cpp-python with Llama symbol.
        check_llama = self._run_python(
            python_exe,
            "from llama_cpp import Llama; print('OK')",
            timeout=20,
        )
        if check_llama.returncode == 0 and "OK" in (check_llama.stdout or ""):
            return True, ""

        self._log(log_callback, "GGUF runtime: llama_cpp not ready, attempting repair install...")

        # Remove known conflicting/incomplete providers first.
        try:
            self._run_pip(
                python_exe,
                ["uninstall", "-y", "llama-cpp-pydist", "llama-cpp-python-binary"],
                timeout=120,
            )
        except Exception:
            pass

        # 2) Try latest binary wheel first, then explicit wheel index fallback.
        llama_index = "https://abetlen.github.io/llama-cpp-python/whl/cpu"
        install_attempts = [
            [
                "install",
                "--upgrade",
                "--only-binary",
                ":all:",
                "--prefer-binary",
                "llama-cpp-python",
            ],
            [
                "install",
                "--upgrade",
                "--only-binary",
                ":all:",
                "--prefer-binary",
                "llama-cpp-python==0.3.2",
                "--extra-index-url",
                llama_index,
            ],
            # Last resort backend package to keep probe capabilities, but not primary runtime success criterion.
            ["install", "--upgrade", "ctransformers"],
        ]

        errors: list[str] = []
        for args in install_attempts:
            pkg_label = args[-1]
            self._log(log_callback, f"GGUF runtime repair: pip {' '.join(args)}")
            proc = self._run_pip(python_exe, args, timeout=900)
            if proc.returncode != 0:
                err = (proc.stderr or proc.stdout or "").strip()
                errors.append(f"{pkg_label}: {err[:300]}")
                continue

            # Re-check llama_cpp primary API after each install.
            verify = self._run_python(
                python_exe,
                "import importlib\n"
                "m=importlib.import_module('llama_cpp')\n"
                "print('HAS_LLAMA', hasattr(m, 'Llama'))\n",
                timeout=20,
            )
            out = (verify.stdout or "") + "\n" + (verify.stderr or "")
            if verify.returncode == 0 and "HAS_LLAMA True" in out:
                self._log(log_callback, "GGUF runtime repair: llama_cpp primary API available.")
                return True, ""

        # If llama_cpp API is unavailable, we still consider ctransformers as a degraded fallback.
        check_ct = self._run_python(
            python_exe,
            "from ctransformers import AutoModelForCausalLM; print('OK')",
            timeout=20,
        )
        if check_ct.returncode == 0 and "OK" in (check_ct.stdout or ""):
            allow_ct_only = os.environ.get("LLM_ALLOW_CTRANSFORMERS_ONLY_RUNTIME", "").strip().lower() in ("1", "true", "yes")
            if allow_ct_only:
                self._log(
                    log_callback,
                    "GGUF runtime repair: ctransformers-only fallback enabled by LLM_ALLOW_CTRANSFORMERS_ONLY_RUNTIME.",
                )
                return True, ""
            return (
                False,
                "GGUF runtime found ctransformers but primary llama-cpp-python API is unavailable. "
                "ctransformers-only mode is disabled by default due compatibility risks.",
            )

        details = "; ".join(errors[:5]) if errors else (check_llama.stderr or check_llama.stdout or "unknown")
        return (
            False,
            "GGUF runtime missing required backend components. "
            "Could not provision llama-cpp-python (Llama API) or ctransformers fallback. "
            f"Details: {details[:1200]}",
        )

