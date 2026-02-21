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
import re
import json


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

    def _parse_version_tuple(self, version_text: str) -> tuple[int, int, int]:
        nums = [int(x) for x in re.findall(r"\d+", str(version_text or ""))]
        return (
            nums[0] if len(nums) > 0 else 0,
            nums[1] if len(nums) > 1 else 0,
            nums[2] if len(nums) > 2 else 0,
        )

    def _get_installed_version(self, python_exe: Path, package_name: str) -> Optional[str]:
        probe = self._run_python(
            python_exe,
            f"import importlib.metadata as m; print(m.version('{package_name}'), end='')",
            timeout=20,
        )
        if probe.returncode != 0:
            return None
        value = (probe.stdout or "").strip()
        return value or None

    def _llama_version_ok(self, python_exe: Path) -> tuple[bool, Optional[str], str]:
        min_version = os.getenv("LLM_MIN_LLAMA_CPP_VERSION", "0.3.8").strip() or "0.3.8"
        installed = self._get_installed_version(python_exe, "llama-cpp-python")
        if not installed:
            return False, None, min_version
        return self._parse_version_tuple(installed) >= self._parse_version_tuple(min_version), installed, min_version

    def _candidate_bundled_paths(self, name: str) -> list[Path]:
        llm_root = self._infer_llm_root(Path(sys.executable))
        if llm_root is None:
            return []
        return [
            llm_root / "runtime" / "llama.cpp" / name,
            llm_root / "runtime" / "llama_cpp" / name,
            llm_root / "bin" / name,
            llm_root / "tools" / "llama.cpp" / name,
        ]

    def discover_bundled_llama_binaries(self) -> dict[str, Optional[Path]]:
        """
        Discover optional bundled llama.cpp binaries.
        Returns keys: server, cli (Path or None).
        """
        server_env = (os.getenv("LLM_BUNDLED_LLAMA_SERVER_EXE", "") or "").strip()
        cli_env = (os.getenv("LLM_BUNDLED_LLAMA_CLI_EXE", "") or "").strip()
        server = Path(server_env) if server_env else None
        cli = Path(cli_env) if cli_env else None

        if (server is None) or (not server.exists()):
            for cand in self._candidate_bundled_paths("llama-server.exe"):
                if cand.exists():
                    server = cand
                    break
        if (cli is None) or (not cli.exists()):
            for cand in self._candidate_bundled_paths("llama-cli.exe"):
                if cand.exists():
                    cli = cand
                    break

        if server is not None and not server.exists():
            server = None
        if cli is not None and not cli.exists():
            cli = None
        return {"server": server, "cli": cli}

    def _pick_gguf_variant(self, model_path: Path) -> Optional[Path]:
        try:
            if model_path.is_file() and model_path.suffix.lower() == ".gguf":
                return model_path
            if not model_path.is_dir():
                return None
            marker = model_path / ".selected_weights.json"
            if marker.exists():
                try:
                    data = json.loads(marker.read_text(encoding="utf-8"))
                    active = data.get("active_variant")
                    if isinstance(active, str) and active.strip():
                        candidate = (model_path / active).resolve()
                        if candidate.exists() and candidate.suffix.lower() == ".gguf":
                            return candidate
                except Exception:
                    pass
            ggufs = sorted(model_path.rglob("*.gguf"))
            return ggufs[0] if ggufs else None
        except Exception:
            return None

    def probe_bundled_gguf_runtime(self, model_path: Path, log_callback: LogCallback = None) -> Tuple[bool, str]:
        """
        Probe bundled llama.cpp CLI with one token generation on selected GGUF.
        Returns (ok, details). Non-destructive and timeout-bounded.
        """
        bins = self.discover_bundled_llama_binaries()
        cli = bins.get("cli")
        if cli is None:
            return False, "Bundled llama-cli.exe not found."
        gguf = self._pick_gguf_variant(model_path)
        if gguf is None:
            return False, f"No GGUF file found under: {model_path}"

        attempts = [
            [str(cli), "-m", str(gguf), "-n", "1", "-p", "probe", "-c", "128", "-ngl", "0"],
            [str(cli), "--model", str(gguf), "--n-predict", "1", "--prompt", "probe", "--ctx-size", "128", "--n-gpu-layers", "0"],
        ]
        for cmd in attempts:
            try:
                self._log(log_callback, f"Bundled GGUF probe: {' '.join(cmd)}")
                proc = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=120,
                    **self.subprocess_flags,
                )
                if proc.returncode == 0:
                    return True, f"Bundled llama.cpp probe succeeded for {gguf.name}"
                out = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()
                last = out[:600]
            except Exception as e:
                last = str(e)[:600]
        return False, f"Bundled llama.cpp probe failed for {gguf.name}. Last error: {last}"

    def ensure_gguf_runtime(self, python_exe: Path, log_callback: LogCallback = None) -> Tuple[bool, str]:
        """
        Ensure the environment can initialize GGUF runtime backend(s).
        Idempotent: returns immediately if primary check passes; repair only when needed.
        Wheel-first: uses --only-binary/--prefer-binary for llama-cpp-python before source fallbacks.

        Returns:
            (ok, error_message)
        """
        if not python_exe or not python_exe.exists():
            return False, f"Python executable not found for runtime bundle: {python_exe}"

        # 1) Idempotent: if primary backend is already OK, skip repair.
        check_llama = self._run_python(
            python_exe,
            "from llama_cpp import Llama; print('OK')",
            timeout=20,
        )
        if check_llama.returncode == 0 and "OK" in (check_llama.stdout or ""):
            version_ok, installed, min_version = self._llama_version_ok(python_exe)
            if version_ok:
                return True, ""
            self._log(
                log_callback,
                f"GGUF runtime: llama_cpp import works but version is too old "
                f"({installed or 'unknown'} < {min_version}); repairing...",
            )
        else:
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
        min_llama = os.getenv("LLM_MIN_LLAMA_CPP_VERSION", "0.3.8").strip() or "0.3.8"
        install_attempts = [
            [
                "install",
                "--upgrade",
                "--only-binary",
                ":all:",
                "--prefer-binary",
                f"llama-cpp-python>={min_llama}",
            ],
            [
                "install",
                "--upgrade",
                "--only-binary",
                ":all:",
                "--prefer-binary",
                f"llama-cpp-python>={min_llama}",
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
                version_ok, installed, min_version = self._llama_version_ok(python_exe)
                if version_ok:
                    self._log(
                        log_callback,
                        f"GGUF runtime repair: llama_cpp primary API available (version {installed}, min {min_version}).",
                    )
                    return True, ""
                self._log(
                    log_callback,
                    f"GGUF runtime repair: llama_cpp import is available but version is too old "
                    f"({installed or 'unknown'} < {min_version}).",
                )
                errors.append(
                    f"llama-cpp-python: version below minimum (installed={installed or 'unknown'}, required>={min_version})"
                )

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

